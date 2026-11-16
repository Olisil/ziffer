// Plans per project. A plan is chosen by the project owner and decides how much a project may collect and keep.
// People still have a role in each project (Pro edits, Basic reads), but people are no longer what is paid for.
import { db } from './server';

export type ProjectPlan = 'free' | 'starter' | 'studio';
export const PLAN_ORDER: ProjectPlan[] = ['free', 'starter', 'studio'];
export type Limits = { name: string; sessions: number; environments: number; retentionDays: number; tours: boolean; agents: boolean; snapshotPages: number };
export const PLANS: Record<ProjectPlan, Limits> = {
  free: { name: 'Free', sessions: 2_000, environments: 1, retentionDays: 30, tours: false, agents: false, snapshotPages: 25 },
  starter: { name: 'Starter', sessions: 10_000, environments: 3, retentionDays: 90, tours: true, agents: true, snapshotPages: 100 },
  studio: { name: 'Studio', sessions: 50_000, environments: 10, retentionDays: 365, tours: true, agents: true, snapshotPages: 300 },
};
export const isPlan = (v: unknown): v is ProjectPlan => v === 'free' || v === 'starter' || v === 'studio';
export const rank = (p: ProjectPlan) => PLAN_ORDER.indexOf(p);

/** Monthly prices in the currency's minor unit. Set in Admin → Billing; these are the starting values. */
export type PlanPrices = { currency: string; starter: number; studio: number };
export const DEFAULT_PRICES: PlanPrices = { currency: 'sek', starter: 12_900, studio: 44_900 };
export async function planPrices(): Promise<PlanPrices> {
  const v = (await db().prepare("SELECT value FROM app_settings WHERE key = 'plan_prices'").first<{ value: string }>().catch(() => null))?.value;
  try { const p = v ? JSON.parse(v) : null; return p && Number.isFinite(p.starter) && Number.isFinite(p.studio) ? { ...DEFAULT_PRICES, ...p } : DEFAULT_PRICES; } catch { return DEFAULT_PRICES; }
}
export const priceOf = (prices: PlanPrices, plan: ProjectPlan) => (plan === 'free' ? 0 : prices[plan]);

export const monthKey = (t = Date.now()) => new Date(t).toISOString().slice(0, 7);

type PlanRow = { plan: string | null; plan_comp: number | null; owner_plan: string | null };
/** The plan a project really runs on. Projects owned by Nassau or by someone on Pro – Free get Studio without charge. */
export function effective(r: PlanRow): { plan: ProjectPlan; comped: boolean } {
  if (r.owner_plan === 'owner' || r.owner_plan === 'pro_free') return { plan: 'studio', comped: true };
  return { plan: isPlan(r.plan) ? r.plan : 'free', comped: !!r.plan_comp };
}
const ROW = `p.plan, p.plan_comp, p.plan_since, u.plan AS owner_plan`;
const FROM = `FROM projects p LEFT JOIN users u ON u.id = p.owner_id`;

export type PlanState = { plan: ProjectPlan; comped: boolean; limits: Limits; used: number; dropped: number; since: number | null; chosen: ProjectPlan };
export async function planState(projectId: string): Promise<PlanState> {
  const r = await db().prepare(`SELECT ${ROW}, COALESCE(m.sessions, 0) AS used, COALESCE(m.dropped, 0) AS dropped ${FROM} LEFT JOIN usage_months m ON m.project_id = p.id AND m.month = ?2 WHERE p.id = ?1`)
    .bind(projectId, monthKey()).first<PlanRow & { used: number; dropped: number; plan_since: number | null }>();
  const e = effective(r ?? { plan: 'free', plan_comp: 0, owner_plan: null });
  return { ...e, limits: PLANS[e.plan], used: r?.used ?? 0, dropped: r?.dropped ?? 0, since: r?.plan_since ?? null, chosen: isPlan(r?.plan) ? r!.plan as ProjectPlan : 'free' };
}
export async function limitsForEnv(envId: string): Promise<Limits> {
  const r = await db().prepare(`SELECT ${ROW} ${FROM} JOIN environments e ON e.project_id = p.id WHERE e.id = ?`).bind(envId).first<PlanRow>();
  return PLANS[effective(r ?? { plan: 'free', plan_comp: 0, owner_plan: null }).plan];
}

/**
 * Called when a visit sends its first data. Returns false when the project has used up the month's sessions:
 * the visit is then counted as turned away and nothing about it is stored.
 */
export async function admitSession(projectId: string, table: 'sessions' | 'tour_visits', sid: string, countDrop = true): Promise<boolean> {
  const month = monthKey();
  const r = await db().prepare(
    `SELECT ${ROW}, COALESCE(m.sessions, 0) AS used, (SELECT 1 FROM ${table} WHERE ${table === 'sessions' ? 'id' : 'sid'} = ?3) AS known
       ${FROM} LEFT JOIN usage_months m ON m.project_id = p.id AND m.month = ?2 WHERE p.id = ?1`,
  ).bind(projectId, month, sid).first<PlanRow & { used: number; known: number | null }>();
  if (!r || r.known) return true;
  const over = r.used >= PLANS[effective(r).plan].sessions;
  if (!over || countDrop) {
    await db().prepare(`INSERT INTO usage_months (project_id, month, sessions, dropped) VALUES (?1, ?2, ?3, ?4)
                        ON CONFLICT (project_id, month) DO UPDATE SET sessions = sessions + ?3, dropped = dropped + ?4`).bind(projectId, month, over ? 0 : 1, over ? 1 : 0).run();
  }
  return !over;
}

/** Whether a page may get a heatmap snapshot: pages that already have one always may; new pages only while there is room. */
export async function snapshotRoom(envId: string, path: string) {
  const r = await db().prepare('SELECT (SELECT 1 FROM snapshots WHERE env_id = ?1 AND path = ?2 LIMIT 1) AS known, (SELECT COUNT(DISTINCT path) FROM snapshots WHERE env_id = ?1) AS n').bind(envId, path).first<{ known: number | null; n: number }>();
  if (!r || r.known) return true;
  return r.n < (await limitsForEnv(envId)).snapshotPages;
}

/**
 * Removes detailed data older than each project's plan keeps it. Runs once a day.
 * The first run waits two weeks after this feature arrives, so nobody loses data without notice.
 */
export async function prune(now = Date.now()) {
  const DB = db();
  const get = async (k: string) => (await DB.prepare('SELECT value FROM app_settings WHERE key = ?').bind(k).first<{ value: string }>())?.value ?? null;
  const set = (k: string, v: string) => DB.prepare('INSERT INTO app_settings (key, value, updated) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated = excluded.updated').bind(k, v, now).run();
  let from = Number(await get('retention_from'));
  if (!from) { from = now + 14 * 864e5; await set('retention_from', String(from)); }
  if (now < from) return `starts ${new Date(from).toISOString().slice(0, 10)}`;
  const day = new Date(now).toISOString().slice(0, 10);
  if ((await get('prune_day')) === day) return 'done today';
  await set('prune_day', day);
  const envs = (await DB.prepare(`SELECT e.id, ${ROW} ${FROM} JOIN environments e ON e.project_id = p.id`).all<PlanRow & { id: string }>()).results;
  const byDays = new Map<number, string[]>();
  for (const e of envs) { const d = PLANS[effective(e).plan].retentionDays; byDays.set(d, [...(byDays.get(d) ?? []), e.id]); }
  let removed = 0;
  for (const [days, ids] of byDays) {
    const before = now - days * 864e5;
    for (let i = 0; i < ids.length; i += 40) {
      const part = ids.slice(i, i + 40), marks = part.map(() => '?').join(',');
      const res = await DB.batch([
        DB.prepare(`DELETE FROM clicks WHERE env_id IN (${marks}) AND ts < ?`).bind(...part, before),
        DB.prepare(`DELETE FROM pageviews WHERE env_id IN (${marks}) AND ts < ?`).bind(...part, before),
        DB.prepare(`DELETE FROM sessions WHERE env_id IN (${marks}) AND started < ?`).bind(...part, before),
        DB.prepare(`DELETE FROM agent_views WHERE env_id IN (${marks}) AND ts < ?`).bind(...part, before),
        DB.prepare(`DELETE FROM tour_visits WHERE env_id IN (${marks}) AND started < ?`).bind(...part, before),
      ]);
      for (const r of res) removed += r.meta.changes || 0;
    }
  }
  return removed;
}
