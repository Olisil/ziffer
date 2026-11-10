import { db } from './server';

const one = async <T>(sql: string, ...b: unknown[]) => (await db().prepare(sql).bind(...b).first<T>())!;
const all = async <T>(sql: string, ...b: unknown[]) => (await db().prepare(sql).bind(...b).all<T>()).results;

export type Kpis = { visitors: number; sessions: number; engagement: number; scroll: number; rage: number; pageviews: number };

async function kpisFor(env: string, from: number, to: number): Promise<Kpis> {
  const s = await one<{ visitors: number; sessions: number; engagement: number; pageviews: number; rage: number }>(
    `SELECT COUNT(DISTINCT visitor) AS visitors, COUNT(*) AS sessions, COALESCE(AVG(duration), 0) AS engagement,
            COALESCE(SUM(pageviews), 0) AS pageviews, COALESCE(SUM(rage), 0) AS rage
       FROM sessions WHERE env_id = ? AND started >= ? AND started < ?`, env, from, to);
  const p = await one<{ scroll: number }>(
    'SELECT COALESCE(AVG(scroll), 0) AS scroll FROM pageviews WHERE env_id = ? AND ts >= ? AND ts < ?', env, from, to);
  return { ...s, scroll: p.scroll };
}

export async function dashboard(env: string, from: number, to: number, prevFrom: number, days: number) {
  const [now, prev] = await Promise.all([kpisFor(env, from, to), kpisFor(env, prevFrom, from)]);
  const bucket = days <= 1 ? 3600e3 : 864e5;
  const series = await all<{ b: number; n: number }>(
    `SELECT CAST((started - ?) / ? AS INTEGER) AS b, COUNT(*) AS n FROM sessions
      WHERE env_id = ? AND started >= ? AND started < ? GROUP BY b ORDER BY b`, from, bucket, env, from, to);
  const buckets = Math.round((to - from) / bucket);
  const counts = Array.from({ length: buckets }, (_, i) => series.find((r) => r.b === i)?.n ?? 0);
  // AI agents browsing for someone: counted per visit, shown next to people but never mixed in.
  const agentSeries = await all<{ b: number; n: number }>(
    `SELECT CAST((ts - ?) / ? AS INTEGER) AS b, COUNT(DISTINCT visit) AS n FROM agent_views
      WHERE env_id = ? AND ts >= ? AND ts < ? GROUP BY b ORDER BY b`, from, bucket, env, from, to).catch(() => []);
  const agentCounts = Array.from({ length: buckets }, (_, i) => agentSeries.find((r) => r.b === i)?.n ?? 0);
  const [pages, referrers, devices, recent] = await Promise.all([
    all<{ path: string; n: number; scroll: number }>(
      `SELECT path, COUNT(*) AS n, AVG(scroll) AS scroll FROM pageviews WHERE env_id = ? AND ts >= ? AND ts < ?
        GROUP BY path ORDER BY n DESC LIMIT 8`, env, from, to),
    all<{ referrer: string; n: number }>(
      `SELECT COALESCE(referrer, 'Direct') AS referrer, COUNT(*) AS n FROM sessions WHERE env_id = ? AND started >= ? AND started < ?
        GROUP BY 1 ORDER BY n DESC LIMIT 6`, env, from, to),
    all<{ device: string; n: number }>(
      `SELECT COALESCE(device, 'desktop') AS device, COUNT(*) AS n FROM sessions WHERE env_id = ? AND started >= ? AND started < ?
        GROUP BY 1 ORDER BY n DESC`, env, from, to),
    recentSessions(env, from, to, 6),
  ]);
  return { now, prev, counts, agentCounts, bucket, pages, referrers, devices, recent };
}

export type SessionRow = { id: string; started: number; duration: number; pageviews: number; rage: number; device: string | null; country: string | null; referrer: string | null; entry_path: string | null; exit_path: string | null; journey: string | null };

export async function recentSessions(env: string, from: number, to: number, limit = 50, offset = 0) {
  return all<SessionRow>(
    `SELECT s.*, (SELECT GROUP_CONCAT(path, ' → ') FROM (SELECT path FROM pageviews WHERE session_id = s.id ORDER BY ts LIMIT 6)) AS journey
       FROM sessions s WHERE s.env_id = ? AND s.started >= ? AND s.started < ?
      ORDER BY s.started DESC LIMIT ? OFFSET ?`, env, from, to, limit, offset);
}

export async function sessionDetail(env: string, sid: string) {
  const s = await db().prepare('SELECT * FROM sessions WHERE id = ? AND env_id = ?').bind(sid, env).first<SessionRow>();
  if (!s) return null;
  const [pages, clicks] = await Promise.all([
    all<{ id: string; path: string; title: string | null; ts: number; duration: number; scroll: number }>(
      'SELECT id, path, title, ts, duration, scroll FROM pageviews WHERE session_id = ? ORDER BY ts', sid),
    all<{ path: string; ts: number; sel: string | null; rage: number }>(
      'SELECT path, ts, sel, rage FROM clicks WHERE session_id = ? ORDER BY ts LIMIT 500', sid),
  ]);
  return { s, pages, clicks };
}

export async function heatmapPages(env: string, from: number, to: number) {
  return all<{ path: string; views: number; clicks: number }>(
    `SELECT p.path, COUNT(*) AS views, (SELECT COUNT(*) FROM clicks c WHERE c.env_id = p.env_id AND c.path = p.path AND c.ts >= ? AND c.ts < ?) AS clicks
       FROM pageviews p WHERE p.env_id = ? AND p.ts >= ? AND p.ts < ? GROUP BY p.path ORDER BY views DESC LIMIT 30`, from, to, env, from, to);
}

/** Clicks plus a scroll-reach curve for one page and device class. */
export async function heatmapData(env: string, path: string, device: 'desktop' | 'mobile', from: number, to: number) {
  const vwCond = device === 'mobile' ? 'vw < 768' : 'vw >= 768';
  const clicks = await all<{ xr: number; y: number; rage: number; dh: number }>(
    `SELECT xr, y, rage, dh FROM clicks WHERE env_id = ? AND path = ? AND ts >= ? AND ts < ? AND ${vwCond} ORDER BY ts DESC LIMIT 20000`,
    env, path, from, to);
  const geo = await one<{ dw: number; dh: number; vh: number; n: number }>(
    `SELECT CAST(AVG(dw) AS INTEGER) AS dw, CAST(AVG(dh) AS INTEGER) AS dh, CAST(AVG(vh) AS INTEGER) AS vh, COUNT(*) AS n
       FROM pageviews WHERE env_id = ? AND path = ? AND ts >= ? AND ts < ? AND ${vwCond}`, env, path, from, to);
  const scrolls = await all<{ scroll: number; vh: number | null; dh: number | null }>(
    `SELECT scroll, vh, dh FROM pageviews WHERE env_id = ? AND path = ? AND ts >= ? AND ts < ? AND ${vwCond}`, env, path, from, to);
  const reach = Array.from({ length: 21 }, (_, i) => (scrolls.length ? scrolls.filter((r) => r.scroll >= i * 5).length / scrolls.length : 0));
  // The fold: where the first screen ends. The middle value, so one very tall or tiny window doesn't move it.
  const sized = scrolls.filter((r) => (r.vh || 0) >= 200 && (r.dh || 0) > 0);
  const hs = sized.map((r) => r.vh!).sort((a, b) => a - b);
  const fold = hs.length ? {
    y: hs[Math.floor(hs.length / 2)], n: hs.length,
    // Scroll depth counts the bottom of the window, so "past the fold" means it moved beyond the first screen.
    past: sized.filter((r) => (r.scroll / 100) * r.dh! > r.vh! * 1.05).length / sized.length,
  } : null;
  return { clicks, geo, reach, fold };
}

/* ---------- Overview: one card per environment ---------- */

export type EnvCard = {
  sessions: number; visitors: number; engagement: number; rage: number; pageviews: number;
  prevSessions: number; prevVisitors: number; scroll: number; live: number;
  counts: number[]; topPage: string | null; topPageViews: number;
};

export async function overview(envIds: string[], from: number, to: number, prevFrom: number, days: number) {
  const out = new Map<string, EnvCard>();
  if (!envIds.length) return out;
  const ids = envIds.slice(0, 90);
  const ph = ids.map(() => '?').join(',');
  const bucket = days <= 1 ? 3600e3 : 864e5;
  const buckets = Math.round((to - from) / bucket);
  const [now, prev, scroll, series, pages, live] = await Promise.all([
    all<{ env_id: string; sessions: number; visitors: number; engagement: number; rage: number; pageviews: number }>(
      `SELECT env_id, COUNT(*) AS sessions, COUNT(DISTINCT visitor) AS visitors, COALESCE(AVG(duration), 0) AS engagement,
              COALESCE(SUM(rage), 0) AS rage, COALESCE(SUM(pageviews), 0) AS pageviews
         FROM sessions WHERE env_id IN (${ph}) AND started >= ? AND started < ? GROUP BY env_id`, ...ids, from, to),
    all<{ env_id: string; sessions: number; visitors: number }>(
      `SELECT env_id, COUNT(*) AS sessions, COUNT(DISTINCT visitor) AS visitors
         FROM sessions WHERE env_id IN (${ph}) AND started >= ? AND started < ? GROUP BY env_id`, ...ids, prevFrom, from),
    all<{ env_id: string; scroll: number }>(
      `SELECT env_id, AVG(scroll) AS scroll FROM pageviews WHERE env_id IN (${ph}) AND ts >= ? AND ts < ? GROUP BY env_id`, ...ids, from, to),
    all<{ env_id: string; b: number; n: number }>(
      `SELECT env_id, CAST((started - ?) / ? AS INTEGER) AS b, COUNT(*) AS n FROM sessions
        WHERE env_id IN (${ph}) AND started >= ? AND started < ? GROUP BY env_id, b`, from, bucket, ...ids, from, to),
    all<{ env_id: string; path: string; n: number }>(
      `SELECT env_id, path, COUNT(*) AS n FROM pageviews WHERE env_id IN (${ph}) AND ts >= ? AND ts < ? GROUP BY env_id, path`, ...ids, from, to),
    all<{ env_id: string; n: number }>(
      `SELECT env_id, COUNT(*) AS n FROM sessions WHERE env_id IN (${ph}) AND last_seen >= ? GROUP BY env_id`, ...ids, Date.now() - 5 * 60e3),
  ]);
  for (const id of ids) {
    const n = now.find((r) => r.env_id === id), p = prev.find((r) => r.env_id === id);
    const top = pages.filter((r) => r.env_id === id).sort((a, b) => b.n - a.n)[0];
    out.set(id, {
      sessions: n?.sessions ?? 0, visitors: n?.visitors ?? 0, engagement: n?.engagement ?? 0, rage: n?.rage ?? 0, pageviews: n?.pageviews ?? 0,
      prevSessions: p?.sessions ?? 0, prevVisitors: p?.visitors ?? 0,
      scroll: scroll.find((r) => r.env_id === id)?.scroll ?? 0,
      live: live.find((r) => r.env_id === id)?.n ?? 0,
      counts: Array.from({ length: buckets }, (_, i) => series.find((r) => r.env_id === id && r.b === i)?.n ?? 0),
      topPage: top?.path ?? null, topPageViews: top?.n ?? 0,
    });
  }
  return out;
}

/* ---------- Sessions: filters, signals and journeys ---------- */

export type SessionFilters = {
  device?: 'desktop' | 'tablet' | 'mobile';
  signal?: 'frustrated' | 'bounced' | 'engaged';
  source?: string; // referrer host, or 'direct'
  who?: 'ai'; // sent by an AI assistant
  page?: string; // visited path
  country?: string;
  sort?: 'newest' | 'longest' | 'pages' | 'frustrated';
};

const SIGNAL_SQL = {
  frustrated: '(s.rage > 0 OR s.dead >= 2)',
  bounced: '(s.pageviews <= 1 AND s.duration < 10)',
  engaged: '(s.duration >= 60 OR (SELECT MAX(scroll) FROM pageviews p WHERE p.session_id = s.id) >= 75)',
} as const;

function sessionWhere(env: string, from: number, to: number, f: SessionFilters, withSignal = true) {
  const w = ['s.env_id = ?', 's.started >= ?', 's.started < ?'];
  const b: unknown[] = [env, from, to];
  if (f.device) { w.push('COALESCE(s.device, \'desktop\') = ?'); b.push(f.device); }
  if (f.source === 'direct') w.push('s.referrer IS NULL');
  else if (f.source) { w.push('s.referrer = ?'); b.push(f.source); }
  if (f.who === 'ai') w.push('s.ai IS NOT NULL');
  if (f.country) { w.push('s.country = ?'); b.push(f.country); }
  if (f.page) { w.push('EXISTS (SELECT 1 FROM pageviews p WHERE p.session_id = s.id AND p.path = ?)'); b.push(f.page); }
  if (withSignal && f.signal) w.push(SIGNAL_SQL[f.signal]);
  return { where: w.join(' AND '), binds: b };
}

export type SessionListRow = SessionRow & { browser: string | null; os: string | null; dead: number; ai: string | null };
export type JourneyPage = { path: string; ts: number; duration: number; scroll: number };
export type JourneyClick = { ts: number; rage: number; dead: number };

export async function sessionList(env: string, from: number, to: number, f: SessionFilters, limit = 30, offset = 0) {
  const { where, binds } = sessionWhere(env, from, to, f);
  const order = f.sort === 'longest' ? 's.duration DESC' : f.sort === 'pages' ? 's.pageviews DESC, s.duration DESC'
    : f.sort === 'frustrated' ? '(s.rage * 3 + s.dead) DESC, s.started DESC' : 's.started DESC';
  const rows = await all<SessionListRow>(`SELECT s.* FROM sessions s WHERE ${where} ORDER BY ${order} LIMIT ? OFFSET ?`, ...binds, limit, offset);
  const ids = rows.map((r) => r.id);
  const pages = new Map<string, JourneyPage[]>(), clicks = new Map<string, JourneyClick[]>();
  if (ids.length) {
    const ph = ids.map(() => '?').join(',');
    const [pv, cl] = await Promise.all([
      all<JourneyPage & { session_id: string }>(`SELECT session_id, path, ts, duration, scroll FROM pageviews WHERE session_id IN (${ph}) ORDER BY ts`, ...ids),
      all<JourneyClick & { session_id: string }>(`SELECT session_id, ts, rage, dead FROM clicks WHERE session_id IN (${ph}) ORDER BY ts LIMIT 3000`, ...ids),
    ]);
    for (const p of pv) { const a = pages.get(p.session_id) ?? []; a.push(p); pages.set(p.session_id, a); }
    for (const c of cl) { const a = clicks.get(c.session_id) ?? []; a.push(c); clicks.set(c.session_id, a); }
  }
  return rows.map((r) => ({ ...r, pages: pages.get(r.id) ?? [], clicks: clicks.get(r.id) ?? [] }));
}

export async function sessionSummary(env: string, from: number, to: number, f: SessionFilters) {
  const { where, binds } = sessionWhere(env, from, to, f, false);
  return one<{ total: number; frustrated: number; bounced: number; engaged: number; avg: number }>(
    `SELECT COUNT(*) AS total,
            COALESCE(SUM(CASE WHEN ${SIGNAL_SQL.frustrated} THEN 1 ELSE 0 END), 0) AS frustrated,
            COALESCE(SUM(CASE WHEN ${SIGNAL_SQL.bounced} THEN 1 ELSE 0 END), 0) AS bounced,
            COALESCE(SUM(CASE WHEN ${SIGNAL_SQL.engaged} THEN 1 ELSE 0 END), 0) AS engaged,
            COALESCE(AVG(s.duration), 0) AS avg
       FROM sessions s WHERE ${where}`, ...binds);
}

export async function sessionFacets(env: string, from: number, to: number) {
  const [sources, countries, pages] = await Promise.all([
    all<{ v: string | null; n: number }>(`SELECT referrer AS v, COUNT(*) AS n FROM sessions WHERE env_id = ? AND started >= ? AND started < ? GROUP BY 1 ORDER BY n DESC LIMIT 12`, env, from, to),
    all<{ v: string; n: number }>(`SELECT country AS v, COUNT(*) AS n FROM sessions WHERE env_id = ? AND started >= ? AND started < ? AND country IS NOT NULL GROUP BY 1 ORDER BY n DESC LIMIT 20`, env, from, to),
    all<{ v: string; n: number }>(`SELECT path AS v, COUNT(*) AS n FROM pageviews WHERE env_id = ? AND ts >= ? AND ts < ? GROUP BY 1 ORDER BY n DESC LIMIT 30`, env, from, to),
  ]);
  const who = await one<{ ai: number; agents: number }>(`SELECT (SELECT COUNT(*) FROM sessions WHERE env_id = ?1 AND started >= ?2 AND started < ?3 AND ai IS NOT NULL) AS ai,
    (SELECT COUNT(DISTINCT visit) FROM agent_views WHERE env_id = ?1 AND ts >= ?2 AND ts < ?3) AS agents`, env, from, to);
  return { sources, countries, pages, who: who ?? { ai: 0, agents: 0 } };
}

/** Everything for one session page: views with their clicks and geometry, plus neighbours for prev/next. */
export async function sessionStory(env: string, sid: string) {
  const s = await db().prepare('SELECT * FROM sessions WHERE id = ? AND env_id = ?').bind(sid, env).first<SessionListRow>();
  if (!s) return null;
  const [pages, clicks, prev, next] = await Promise.all([
    all<{ id: string; path: string; title: string | null; ts: number; duration: number; scroll: number; vw: number; vh: number; dw: number; dh: number }>(
      'SELECT id, path, title, ts, duration, scroll, vw, vh, dw, dh FROM pageviews WHERE session_id = ? ORDER BY ts', sid),
    all<{ path: string; ts: number; xr: number; y: number; dh: number; sel: string | null; rage: number; dead: number }>(
      'SELECT path, ts, xr, y, dh, sel, rage, dead FROM clicks WHERE session_id = ? ORDER BY ts LIMIT 500', sid),
    db().prepare('SELECT id FROM sessions WHERE env_id = ? AND (started > ? OR (started = ? AND id > ?)) ORDER BY started ASC, id ASC LIMIT 1').bind(env, s.started, s.started, s.id).first<{ id: string }>(),
    db().prepare('SELECT id FROM sessions WHERE env_id = ? AND (started < ? OR (started = ? AND id < ?)) ORDER BY started DESC, id DESC LIMIT 1').bind(env, s.started, s.started, s.id).first<{ id: string }>(),
  ]);
  // Attach each click to the page view it happened in (same path, between this view and the next).
  const views = pages.map((p, i) => {
    const end = pages[i + 1]?.ts ?? Infinity;
    return { ...p, clicks: clicks.filter((c) => c.path === p.path && c.ts >= p.ts - 1000 && c.ts < end) };
  });
  return { s, views, newer: prev?.id ?? null, older: next?.id ?? null };
}

/* ---------- AI agents: visits by assistants browsing on someone's behalf ---------- */
export type AgentVisit = { visit: string; agent: string; started: number; country: string | null; paths: string[] };
export async function agentVisits(env: string, from: number, to: number, limit = 100): Promise<AgentVisit[]> {
  const rows = await all<{ visit: string; agent: string; path: string; ts: number; country: string | null }>(
    `SELECT visit, agent, path, ts, country FROM agent_views WHERE env_id = ? AND ts >= ? AND ts < ? ORDER BY ts DESC LIMIT 2000`, env, from, to);
  const m = new Map<string, AgentVisit>();
  for (const r of rows) {
    const v = m.get(r.visit) ?? { visit: r.visit, agent: r.agent, started: r.ts, country: r.country, paths: [] };
    v.started = Math.min(v.started, r.ts); v.paths.unshift(r.path); m.set(r.visit, v);
  }
  return [...m.values()].sort((a, b) => b.started - a.started).slice(0, limit);
}
