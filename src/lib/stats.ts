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
  return { now, prev, counts, bucket, pages, referrers, devices, recent };
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
  const scrolls = await all<{ scroll: number }>(
    `SELECT scroll FROM pageviews WHERE env_id = ? AND path = ? AND ts >= ? AND ts < ? AND ${vwCond}`, env, path, from, to);
  const reach = Array.from({ length: 21 }, (_, i) => (scrolls.length ? scrolls.filter((r) => r.scroll >= i * 5).length / scrolls.length : 0));
  return { clicks, geo, reach };
}
