// Agent access: read-only keys per project, and the questions an AI agent can ask over MCP.
// Agents only ever read. Page snapshots are never exposed, and nothing here can change or delete data.
import { db, id, type Environment, type Project } from './server';
import { billingLock } from './page';
import { dashboard, heatmapData, sessionList, sessionSummary, type SessionFilters } from './stats';
import { roomNames, tourInfo, tourList, tourStats, tourTotals, TOUR_RE } from './tours';

export const MAX_KEYS = 5;
export const CALLS_PER_MINUTE = 90;
export type AgentKey = { id: string; project_id: string; name: string; hint: string; created_by: string; created: number; last_used: number | null; calls: number; revoked: number | null };

const sha = async (s: string) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))].map((b) => b.toString(16).padStart(2, '0')).join('');
export const KEY_RE = /^pk_[A-Za-z0-9]{40}$/;

export const listKeys = async (projectId: string) =>
  (await db().prepare('SELECT k.id, k.project_id, k.name, k.hint, k.created_by, k.created, k.last_used, k.calls, k.revoked, u.name AS by_name, u.email AS by_email FROM agent_keys k LEFT JOIN users u ON u.id = k.created_by WHERE k.project_id = ? AND k.revoked IS NULL ORDER BY k.created')
    .bind(projectId).all<AgentKey & { by_name: string | null; by_email: string | null }>()).results;

/** Creates a key and returns it. This is the only time the key itself exists outside the agent that uses it. */
export async function createKey(projectId: string, userId: string, name: string) {
  const n = await db().prepare('SELECT COUNT(*) AS n FROM agent_keys WHERE project_id = ? AND revoked IS NULL').bind(projectId).first<{ n: number }>();
  if ((n?.n ?? 0) >= MAX_KEYS) throw new Error(`A project can have ${MAX_KEYS} agent keys. Remove one first.`);
  const key = `pk_${id(40)}`;
  await db().prepare('INSERT INTO agent_keys (id, project_id, name, hash, hint, created_by, created) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(id(8), projectId, name.trim().slice(0, 60) || 'Agent', await sha(key), key.slice(-4), userId, Date.now()).run();
  return key;
}
export const revokeKey = (projectId: string, keyId: string) =>
  db().prepare('UPDATE agent_keys SET revoked = ? WHERE id = ? AND project_id = ?').bind(Date.now(), keyId, projectId).run();

/** The latest time any agent read this project, for the small "agent" marker in the app. */
export async function agentPulse(projectIds: string[]) {
  const out = new Map<string, { keys: number; last: number | null }>();
  if (!projectIds.length) return out;
  const rows = (await db().prepare(`SELECT project_id, COUNT(*) AS keys, MAX(last_used) AS last FROM agent_keys WHERE revoked IS NULL AND project_id IN (${projectIds.map(() => '?').join(',')}) GROUP BY project_id`)
    .bind(...projectIds).all<{ project_id: string; keys: number; last: number | null }>().catch(() => ({ results: [] as any[] }))).results;
  for (const r of rows) out.set(r.project_id, { keys: r.keys, last: r.last });
  return out;
}

export type Caller = { key: AgentKey; project: Project };
export class AgentError extends Error { constructor(public status: number, message: string) { super(message); } }

export async function callerFor(key: string | null): Promise<Caller> {
  if (!key || !KEY_RE.test(key)) throw new AgentError(401, 'A Probe agent key is required. Create one in the project’s settings, under Agents.');
  const k = await db().prepare('SELECT * FROM agent_keys WHERE hash = ? AND revoked IS NULL').bind(await sha(key)).first<AgentKey>();
  if (!k) throw new AgentError(401, 'This agent key isn’t valid, or has been removed.');
  const project = await db().prepare('SELECT * FROM projects WHERE id = ?').bind(k.project_id).first<Project>();
  if (!project) throw new AgentError(401, 'This agent key isn’t valid, or has been removed.');
  const lock = await billingLock(project);
  if (lock) throw new AgentError(403, `Agent access is paused for this project: ${lock}`);
  return { key: k, project };
}
/** Counts one question against the key; false when the key has asked too many in the last minute. */
export async function countCall(k: AgentKey) {
  const now = Date.now();
  const r = await db().prepare(
    `UPDATE agent_keys SET last_used = ?1, calls = calls + 1,
            win_calls = CASE WHEN ?1 - win_start > 60000 THEN 1 ELSE win_calls + 1 END,
            win_start = CASE WHEN ?1 - win_start > 60000 THEN ?1 ELSE win_start END
      WHERE id = ?2 RETURNING win_calls`).bind(now, k.id).first<{ win_calls: number }>();
  return (r?.win_calls ?? 0) <= CALLS_PER_MINUTE;
}

/* ---------- The questions ---------- */

const PERIODS = { '24h': 1, '7d': 7, '30d': 30, '90d': 90 } as const;
const DAY = 864e5;
const iso = (t: number) => new Date(t).toISOString();
const r1 = (n: number) => Math.round(n * 10) / 10;
const pct = (a: number, b: number) => (b ? r1((a / b) * 100) : 0);
const change = (now: number, prev: number) => (prev ? r1(((now - prev) / prev) * 100) : null);

function periodOf(a: any) {
  const now = Date.now();
  const day = (v: unknown, end: boolean) => {
    if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
    const t = Date.parse(`${v}T00:00:00Z`);
    return Number.isFinite(t) ? t + (end ? DAY : 0) : null;
  };
  let from = day(a?.from, false), to = day(a?.to, true);
  if ((a?.from != null && from === null) || (a?.to != null && to === null)) throw new Error('"from" and "to" must be real days written as YYYY-MM-DD.');
  if (from === null && to !== null) throw new Error('Give "from" together with "to", or use "period".');
  if (from !== null) {
    to = Math.min(to ?? now, now);
    if (to <= from) throw new Error('"to" must be the same day as "from" or later.');
    if (to - from > 366 * DAY) throw new Error('A period can be at most 366 days.');
  } else {
    const key = (a?.period in PERIODS ? a.period : '7d') as keyof typeof PERIODS;
    to = now; from = now - PERIODS[key] * DAY;
  }
  const days = Math.max(1, Math.round((to! - from) / DAY));
  return { from, to: to!, prevFrom: from - (to! - from), days };
}
const periodOut = (p: ReturnType<typeof periodOf>) => ({ from: iso(p.from), to: iso(p.to), days: p.days, compared_with: { from: iso(p.prevFrom), to: iso(p.from) } });

async function envOf(c: Caller, a: any, kind?: 'web' | 'tour') {
  const envs = (await db().prepare('SELECT * FROM environments WHERE project_id = ? ORDER BY created').bind(c.project.id).all<Environment>()).results;
  const want = typeof a?.environment === 'string' ? a.environment.trim().toLowerCase() : '';
  const pool = kind ? envs.filter((e) => e.kind === kind) : envs;
  const env = want ? envs.find((e) => e.id === want || e.name.toLowerCase() === want || (e.domain || '').toLowerCase() === want) : pool.length === 1 ? pool[0] : null;
  if (!env) throw new Error(`${want ? `No environment matches "${a.environment}".` : 'Say which environment.'} This project has: ${envs.map((e) => `${e.name} (id ${e.id}, ${e.kind === 'tour' ? 'virtual tour' : 'website'})`).join('; ') || 'none'}.`);
  if (kind && env.kind !== kind) throw new Error(`${env.name} is a ${env.kind === 'tour' ? 'virtual tour' : 'website'} environment. ${kind === 'tour' ? 'Use the website tools for it.' : 'Use get_tour_stats for it.'}`);
  return env;
}
const all = async <T>(sql: string, ...b: unknown[]) => (await db().prepare(sql).bind(...b).all<T>()).results;

const PERIOD_PROPS = {
  period: { type: 'string', enum: Object.keys(PERIODS), description: 'How far back to look, counted from now. Default 7d.' },
  from: { type: 'string', description: 'Start day as YYYY-MM-DD (UTC). Use with "to" instead of "period" for an exact range.' },
  to: { type: 'string', description: 'Last day to include, as YYYY-MM-DD (UTC). Defaults to today.' },
};
const ENV_PROP = { environment: { type: 'string', description: 'Environment id, name or domain, from list_environments. Can be left out when the project has only one that fits.' } };

type Tool = { name: string; title: string; description: string; inputSchema: object; run: (c: Caller, a: any) => Promise<unknown> };

export const TOOLS: Tool[] = [
  {
    name: 'list_environments', title: 'List environments',
    description: 'The project this key belongs to and the places it measures: websites and virtual tours. Start here to get environment ids.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async run(c) {
      const envs = await all<Environment>('SELECT * FROM environments WHERE project_id = ? ORDER BY created', c.project.id);
      return {
        project: c.project.name,
        environments: await Promise.all(envs.map(async (e) => ({
          id: e.id, name: e.name, kind: e.kind === 'tour' ? 'virtual tour' : 'website', domain: e.domain,
          ...(e.kind === 'tour'
            ? { tours: (await tourList(e.id)).slice(0, 30).map((t) => ({ id: t.tour, visits: t.visits })) }
            : { receiving_data: !!(await db().prepare('SELECT 1 FROM sessions WHERE env_id = ? LIMIT 1').bind(e.id).first()) }),
        }))),
        notes: 'All figures are anonymous: no cookies, no IP addresses, and visitors can’t be followed from one day to the next. Times are UTC.',
      };
    },
  },
  {
    name: 'get_overview', title: 'Website overview',
    description: 'Key figures for a website over a period, each with the change from the period before: visitors, sessions, engaged time, scroll depth, rage clicks. Also sessions per day, top pages, traffic sources, devices and countries.',
    inputSchema: { type: 'object', properties: { ...ENV_PROP, ...PERIOD_PROPS }, additionalProperties: false },
    async run(c, a) {
      const env = await envOf(c, a, 'web'), p = periodOf(a);
      const d = await dashboard(env.id, p.from, p.to, p.prevFrom, p.days);
      const [countries, ai] = await Promise.all([
        all<{ country: string; n: number }>('SELECT country, COUNT(*) AS n FROM sessions WHERE env_id = ? AND started >= ? AND started < ? AND country IS NOT NULL GROUP BY 1 ORDER BY n DESC LIMIT 8', env.id, p.from, p.to),
        db().prepare('SELECT COUNT(*) AS n FROM sessions WHERE env_id = ? AND started >= ? AND started < ? AND ai IS NOT NULL').bind(env.id, p.from, p.to).first<{ n: number }>(),
      ]);
      const k = (key: keyof typeof d.now, round = false) => ({ value: round ? r1(d.now[key]) : d.now[key], previous: round ? r1(d.prev[key]) : d.prev[key], change_percent: change(d.now[key], d.prev[key]) });
      return {
        environment: env.name, period: periodOut(p),
        visitors: k('visitors'), sessions: k('sessions'), page_views: k('pageviews'),
        engaged_seconds_per_session: k('engagement', true), average_scroll_depth_percent: k('scroll', true), rage_clicks: k('rage'),
        sessions_from_ai_assistants: ai?.n ?? 0,
        sessions_over_time: { bucket: p.days <= 1 ? 'hour' : 'day', start: iso(p.from), people: d.counts, ai_agents: d.agentCounts },
        top_pages: d.pages.map((x) => ({ path: x.path, views: x.n, average_scroll_depth_percent: r1(x.scroll) })),
        sources: d.referrers.map((x) => ({ source: x.referrer, sessions: x.n, share_percent: pct(x.n, d.now.sessions) })),
        devices: d.devices.map((x) => ({ device: x.device, sessions: x.n, share_percent: pct(x.n, d.now.sessions) })),
        countries: countries.map((x) => ({ country: x.country, sessions: x.n, share_percent: pct(x.n, d.now.sessions) })),
      };
    },
  },
  {
    name: 'get_pages', title: 'Pages',
    description: 'Every page of a website with views, time on page, scroll depth, how often visits start and end there, clicks and rage clicks. Use it to find pages that lose people.',
    inputSchema: { type: 'object', properties: { ...ENV_PROP, ...PERIOD_PROPS, limit: { type: 'integer', minimum: 1, maximum: 100, description: 'How many pages, most viewed first. Default 30.' } }, additionalProperties: false },
    async run(c, a) {
      const env = await envOf(c, a, 'web'), p = periodOf(a), limit = Math.max(1, Math.min(100, Number(a?.limit) || 30));
      const [pages, entries, exits, clicks] = await Promise.all([
        all<{ path: string; title: string | null; views: number; sessions: number; secs: number; scroll: number }>(
          'SELECT path, MAX(title) AS title, COUNT(*) AS views, COUNT(DISTINCT session_id) AS sessions, AVG(duration) AS secs, AVG(scroll) AS scroll FROM pageviews WHERE env_id = ? AND ts >= ? AND ts < ? GROUP BY path ORDER BY views DESC LIMIT ?', env.id, p.from, p.to, limit),
        all<{ path: string; n: number }>('SELECT entry_path AS path, COUNT(*) AS n FROM sessions WHERE env_id = ? AND started >= ? AND started < ? GROUP BY 1', env.id, p.from, p.to),
        all<{ path: string; n: number }>('SELECT exit_path AS path, COUNT(*) AS n FROM sessions WHERE env_id = ? AND started >= ? AND started < ? GROUP BY 1', env.id, p.from, p.to),
        all<{ path: string; n: number; rage: number; dead: number }>('SELECT path, COUNT(*) AS n, SUM(rage) AS rage, SUM(dead) AS dead FROM clicks WHERE env_id = ? AND ts >= ? AND ts < ? GROUP BY path', env.id, p.from, p.to),
      ]);
      const by = <T extends { path: string }>(rows: T[]) => new Map(rows.map((x) => [x.path, x]));
      const en = by(entries), ex = by(exits), cl = by(clicks);
      return {
        environment: env.name, period: periodOut(p),
        pages: pages.map((x) => ({
          path: x.path, title: x.title, views: x.views, sessions: x.sessions, average_seconds: r1(x.secs), average_scroll_depth_percent: r1(x.scroll),
          visits_started_here: en.get(x.path)?.n ?? 0, visits_ended_here: ex.get(x.path)?.n ?? 0, exit_rate_percent: pct(ex.get(x.path)?.n ?? 0, x.sessions),
          clicks: cl.get(x.path)?.n ?? 0, rage_clicks: cl.get(x.path)?.rage ?? 0, clicks_on_nothing: cl.get(x.path)?.dead ?? 0,
        })),
      };
    },
  },
  {
    name: 'get_page_detail', title: 'One page in detail',
    description: 'How one page is used on desktop and on mobile: how far people scroll, where the first screen ends (the fold) and how many go past it, and which elements get clicked, rage-clicked or clicked without effect.',
    inputSchema: { type: 'object', properties: { ...ENV_PROP, path: { type: 'string', description: 'The page path, for example / or /pricing.' }, ...PERIOD_PROPS }, required: ['path'], additionalProperties: false },
    async run(c, a) {
      const env = await envOf(c, a, 'web'), p = periodOf(a), path = String(a?.path || '').slice(0, 400);
      if (!path.startsWith('/')) throw new Error('"path" must start with /, for example /pricing.');
      const side = async (device: 'desktop' | 'mobile') => {
        const h = await heatmapData(env.id, path, device, p.from, p.to);
        return {
          views: h.geo?.n ?? 0, clicks: h.clicks.length, typical_page_height_px: h.geo?.dh ?? null,
          share_reaching_percent: { '25': r1(h.reach[5] * 100), '50': r1(h.reach[10] * 100), '75': r1(h.reach[15] * 100), '100': r1(h.reach[20] * 100) },
          fold: h.fold ? { first_screen_ends_at_px: h.fold.y, share_scrolling_past_percent: r1(h.fold.past * 100) } : null,
        };
      };
      const [desktop, mobile, elements] = await Promise.all([side('desktop'), side('mobile'),
        all<{ sel: string | null; n: number; rage: number; dead: number }>('SELECT sel, COUNT(*) AS n, SUM(rage) AS rage, SUM(dead) AS dead FROM clicks WHERE env_id = ? AND path = ? AND ts >= ? AND ts < ? GROUP BY sel ORDER BY n DESC LIMIT 20', env.id, path, p.from, p.to)]);
      if (!desktop.views && !mobile.views) throw new Error(`No views of ${path} in this period. get_pages lists the paths that have data.`);
      return {
        environment: env.name, path, period: periodOut(p), desktop, mobile,
        most_clicked_elements: elements.map((e) => ({ element: e.sel || '(unknown)', clicks: e.n, rage_clicks: e.rage, clicks_with_no_effect: e.dead })),
        notes: 'Elements are named by a short CSS-like selector; their text is never recorded.',
      };
    },
  },
  {
    name: 'list_sessions', title: 'Sessions',
    description: 'Individual anonymous visits to a website with the pages each one went through, plus totals for frustrated, bounced and engaged visits. Filter by device, source, country, page or signal.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        ...ENV_PROP, ...PERIOD_PROPS,
        signal: { type: 'string', enum: ['frustrated', 'bounced', 'engaged'], description: 'frustrated: rage clicks or repeated clicks with no effect. bounced: one page and under 10 seconds. engaged: a minute or more, or scrolled 75% of a page.' },
        device: { type: 'string', enum: ['desktop', 'tablet', 'mobile'] },
        source: { type: 'string', description: 'Referring site, for example google.com, or "direct".' },
        via_ai: { type: 'boolean', description: 'Only visits that arrived from an AI assistant such as ChatGPT or Perplexity.' },
        country: { type: 'string', description: 'Two-letter country code, for example SE.' },
        page: { type: 'string', description: 'Only visits that viewed this path.' },
        sort: { type: 'string', enum: ['newest', 'longest', 'pages', 'frustrated'] },
        limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Default 20.' },
      },
    },
    async run(c, a) {
      const env = await envOf(c, a, 'web'), p = periodOf(a), limit = Math.max(1, Math.min(50, Number(a?.limit) || 20));
      const pick = <T extends string>(v: unknown, of: readonly T[]) => (of.includes(v as T) ? (v as T) : undefined);
      const f: SessionFilters = {
        signal: pick(a?.signal, ['frustrated', 'bounced', 'engaged'] as const), device: pick(a?.device, ['desktop', 'tablet', 'mobile'] as const),
        sort: pick(a?.sort, ['newest', 'longest', 'pages', 'frustrated'] as const), who: a?.via_ai === true ? 'ai' : undefined,
        source: typeof a?.source === 'string' ? a.source.trim().toLowerCase().slice(0, 200) || undefined : undefined,
        country: typeof a?.country === 'string' && /^[A-Za-z]{2}$/.test(a.country) ? a.country.toUpperCase() : undefined,
        page: typeof a?.page === 'string' ? a.page.slice(0, 400) : undefined,
      };
      const [sum, rows] = await Promise.all([sessionSummary(env.id, p.from, p.to, f), sessionList(env.id, p.from, p.to, f, limit)]);
      return {
        environment: env.name, period: periodOut(p),
        matching: { sessions: sum.total, frustrated: sum.frustrated, bounced: sum.bounced, engaged: sum.engaged, average_engaged_seconds: r1(sum.avg) },
        sessions: rows.map((s) => ({
          started: iso(s.started), engaged_seconds: r1(s.duration), device: s.device || 'desktop', browser: s.browser, os: s.os, country: s.country,
          source: s.referrer || 'direct', via_ai_assistant: s.ai, rage_clicks: s.rage, clicks_with_no_effect: s.dead,
          pages: s.pages.slice(0, 25).map((x) => ({ path: x.path, seconds: r1(x.duration), scroll_depth_percent: Math.round(x.scroll) })),
        })),
      };
    },
  },
  {
    name: 'get_ai_traffic', title: 'AI traffic',
    description: 'How AI shows up on a website: people who arrived from an AI assistant, and AI agents that fetched pages on someone’s behalf (counted apart from people), with the pages they read.',
    inputSchema: { type: 'object', properties: { ...ENV_PROP, ...PERIOD_PROPS }, additionalProperties: false },
    async run(c, a) {
      const env = await envOf(c, a, 'web'), p = periodOf(a);
      const [total, via, agents, paths] = await Promise.all([
        db().prepare('SELECT COUNT(*) AS n FROM sessions WHERE env_id = ? AND started >= ? AND started < ?').bind(env.id, p.from, p.to).first<{ n: number }>(),
        all<{ ai: string; n: number; secs: number }>('SELECT ai, COUNT(*) AS n, AVG(duration) AS secs FROM sessions WHERE env_id = ? AND started >= ? AND started < ? AND ai IS NOT NULL GROUP BY ai ORDER BY n DESC', env.id, p.from, p.to),
        all<{ agent: string; visits: number; pages: number }>('SELECT agent, COUNT(DISTINCT visit) AS visits, COUNT(*) AS pages FROM agent_views WHERE env_id = ? AND ts >= ? AND ts < ? GROUP BY agent ORDER BY visits DESC', env.id, p.from, p.to).catch(() => []),
        all<{ path: string; n: number }>('SELECT path, COUNT(*) AS n FROM agent_views WHERE env_id = ? AND ts >= ? AND ts < ? GROUP BY path ORDER BY n DESC LIMIT 15', env.id, p.from, p.to).catch(() => []),
      ]);
      const people = via.reduce((s, x) => s + x.n, 0);
      return {
        environment: env.name, period: periodOut(p),
        people_from_ai_assistants: { sessions: people, share_of_all_sessions_percent: pct(people, total?.n ?? 0), by_assistant: via.map((x) => ({ assistant: x.ai, sessions: x.n, average_engaged_seconds: r1(x.secs) })) },
        ai_agents: { visits: agents.reduce((s, x) => s + x.visits, 0), by_agent: agents.map((x) => ({ agent: x.agent, visits: x.visits, pages_read: x.pages })), pages_read_most: paths.map((x) => ({ path: x.path, times: x.n })) },
      };
    },
  },
  {
    name: 'get_tour_stats', title: 'Virtual tour statistics',
    description: 'How a virtual tour is visited: visits with the change from the period before, time spent, rooms per visit, the share of visitors reaching each room and time in it, devices, and the routes of the latest visits.',
    inputSchema: { type: 'object', properties: { ...ENV_PROP, tour: { type: 'string', description: 'Tour id from list_environments. Defaults to the most recently visited tour.' }, ...PERIOD_PROPS }, additionalProperties: false },
    async run(c, a) {
      const env = await envOf(c, a, 'tour'), p = periodOf(a);
      const tours = await tourList(env.id);
      if (!tours.length) throw new Error(`${env.name} has no tour visits yet.`);
      const tour = typeof a?.tour === 'string' && a.tour ? a.tour : tours[0].tour;
      if (!TOUR_RE.test(tour) || !tours.some((t) => t.tour === tour)) throw new Error(`No tour "${tour}" here. Tours: ${tours.map((t) => t.tour).join(', ')}.`);
      const bucket = p.days <= 1 ? 3600e3 : DAY;
      const [s, prev, info] = await Promise.all([tourStats(env.id, tour, p.from, p.to, { bucket }), tourTotals(env.id, tour, p.prevFrom, p.from), tourInfo(env.tours_base, tour)]);
      const names = roomNames(info);
      const room = (rid: string) => names.get(rid) || rid;
      return {
        environment: env.name, tour: { id: tour, title: info?.title || tour }, period: periodOut(p),
        visits: { value: s.visits, previous: prev.visits, change_percent: change(s.visits, prev.visits), counted: 'visits of five seconds or more' },
        median_seconds: r1(s.median), average_seconds: r1(s.avg), rooms_per_visit: r1(s.roomsPerVisit), rooms_in_tour: names.size || null,
        on_touch_screens_percent: r1(s.touchShare * 100),
        visits_over_time: { bucket: p.days <= 1 ? 'hour' : 'day', start: iso(p.from), visits: s.counts },
        rooms: Object.entries(s.rooms).map(([rid, v]) => ({ room: room(rid), share_of_visitors_percent: pct(v.visits, s.visits), average_seconds: r1(v.visits ? v.secs / v.visits : 0) })).sort((x, y) => y.share_of_visitors_percent - x.share_of_visitors_percent),
        latest_visits: s.list.slice(0, 15).map((v) => ({ started: iso(v.started), seconds: r1(v.dur), device: v.device === 'touch' ? 'mobile or tablet' : 'desktop', country: v.country, route: v.order.map(room) })),
        other_tours: tours.filter((t) => t.tour !== tour).slice(0, 20).map((t) => ({ id: t.tour, visits: t.visits })),
      };
    },
  },
];
