// Virtual tours (Intus): visits, what they add up to, and the tour's own description (title, rooms, floor plans).
import { db } from './server';

export const TOUR_RE = /^[a-z0-9][a-z0-9-]{0,59}$/;
export const SID_RE = /^[A-Za-z0-9]{12,40}$/;
export const MIN_SECONDS = 5; // shorter than this is someone who never really entered the tour

type Row = { sid: string; tour: string; started: number; dur: number; device: string | null; country: string | null; data: string };
export type TourVisit = { sid: string; started: number; dur: number; device: string | null; country: string | null; rooms: number; order: string[]; path: [number, number, number, number][] };

export async function tourList(env: string) {
  const r = await db().prepare(`SELECT tour, COUNT(*) AS visits, MAX(started) AS last FROM tour_visits WHERE env_id = ? AND dur >= ${MIN_SECONDS} GROUP BY tour ORDER BY last DESC`)
    .bind(env).all<{ tour: string; visits: number; last: number }>();
  return r.results;
}

export async function tourTotals(env: string, tour: string, from: number, to: number) {
  return (await db().prepare(`SELECT COUNT(*) AS visits, COALESCE(AVG(dur), 0) AS avg FROM tour_visits WHERE env_id = ? AND tour = ? AND started >= ? AND started < ? AND dur >= ${MIN_SECONDS}`)
    .bind(env, tour, from, to).first<{ visits: number; avg: number }>())!;
}

const median = (a: number[]) => { if (!a.length) return 0; const b = [...a].sort((x, y) => x - y), m = b.length >> 1; return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2; };

/** Adds up a tour's visits in a period. The newest `limit` visits are read; heat cells and routes only when asked for. */
export async function tourStats(env: string, tour: string, from: number, to: number, opts: { heat?: boolean; bucket?: number; limit?: number } = {}) {
  const limit = opts.limit ?? 1500;
  const rows = (await db().prepare(`SELECT sid, tour, started, dur, device, country, data FROM tour_visits
      WHERE env_id = ? AND tour = ? AND started >= ? AND started < ? AND dur >= ${MIN_SECONDS} ORDER BY started DESC LIMIT ?`)
    .bind(env, tour, from, to, limit).all<Row>()).results;
  const bucket = opts.bucket ?? 864e5, buckets = Math.max(1, Math.round((to - from) / bucket));
  const counts = Array.from({ length: buckets }, () => 0);
  const seconds: number[] = [], rooms: Record<string, { visits: number; secs: number }> = {};
  const walk = new Map<string, number>(), look = new Map<string, number>();
  const list: TourVisit[] = [];
  let touch = 0, gyro = 0, roomsSeen = 0;
  for (const r of rows) {
    let d: any = {};
    try { d = JSON.parse(r.data) || {}; } catch { /* a broken record still counts as a visit */ }
    const dur = Number(d.dur || r.dur || 0);
    seconds.push(dur);
    if (r.device === 'touch') { touch++; if (d.gyro) gyro++; }
    const b = Math.floor((r.started - from) / bucket); if (b >= 0 && b < buckets) counts[b]++;
    const seen = Object.keys(d.rooms || {});
    roomsSeen += seen.length;
    for (const [id, sec] of Object.entries(d.rooms || {})) { const x = rooms[id] || (rooms[id] = { visits: 0, secs: 0 }); x.visits++; x.secs += Number(sec) || 0; }
    if (opts.heat) {
      for (const [k, v] of Object.entries(d.walk || {})) walk.set(k, (walk.get(k) || 0) + (Number(v) || 0));
      for (const [k, v] of Object.entries(d.look || {})) look.set(k, (look.get(k) || 0) + (Number(v) || 0));
    }
    list.push({ sid: r.sid, started: r.started, dur, device: r.device, country: r.country, rooms: seen.length, order: Array.isArray(d.order) ? d.order : [], path: opts.heat && Array.isArray(d.path) ? d.path : [] });
  }
  const n = rows.length;
  return {
    visits: n, capped: n === limit, counts, bucket,
    median: median(seconds), avg: n ? seconds.reduce((a, b) => a + b, 0) / n : 0,
    touchShare: n ? touch / n : 0, gyroShare: touch ? gyro / touch : 0, touch,
    roomsPerVisit: n ? roomsSeen / n : 0, rooms, list,
    walk: [...walk.entries()], look: [...look.entries()],
  };
}

/* ---------- the tour's own files ---------- */
export type TourRoom = { id: string; name: string; level: number; rects: number[][]; kind?: string; hidden?: boolean };
export type TourInfo = { id: string; title: string; eyebrow: string; subtitle: string; map: null | { angle: number; levels: { y: number; height?: number; image?: string; bounds?: number[] }[]; rooms: TourRoom[] }; base: string | null };
const infoCache = new Map<string, { at: number; info: TourInfo }>();

export const cleanBase = (v: string | null | undefined) => {
  const s = (v || '').trim().replace(/\/+$/, '');
  try { const u = new URL(s); return u.protocol === 'https:' || (import.meta.env.DEV && u.hostname === 'localhost') ? u.href.replace(/\/+$/, '') : null; } catch { return null; }
};

/** Title, rooms and floor plans from the tour's tour.json. Works without it: the link name is used and rooms keep their ids. */
export async function tourInfo(base: string | null | undefined, id: string): Promise<TourInfo> {
  const b = cleanBase(base);
  const blank: TourInfo = { id, title: id, eyebrow: '', subtitle: '', map: null, base: b };
  if (!b || !TOUR_RE.test(id)) return blank;
  const key = `${b}|${id}`, hit = infoCache.get(key);
  if (hit && Date.now() - hit.at < 5 * 60_000) return hit.info;
  let info = blank;
  try {
    const res = await fetch(`${b}/${encodeURIComponent(id)}/tour.json`, { signal: AbortSignal.timeout(6000), headers: { accept: 'application/json' } });
    if (res.ok) {
      const t: any = await res.json();
      const m = t.map && typeof t.map === 'object' ? t.map : null;
      info = {
        id, base: b, title: String(t.title || id).slice(0, 120), eyebrow: String(t.eyebrow || '').slice(0, 120), subtitle: String(t.subtitle || '').slice(0, 200),
        map: m ? {
          angle: Number(m.angle) || 0,
          levels: (Array.isArray(m.levels) ? m.levels : []).slice(0, 12).map((l: any) => ({ y: Number(l.y) || 0, height: Number(l.height) || undefined, image: typeof l.image === 'string' ? l.image : undefined, bounds: Array.isArray(l.bounds) ? l.bounds.map(Number) : undefined })),
          rooms: (Array.isArray(m.rooms) ? m.rooms : []).filter((r: any) => r && !r.hidden).slice(0, 200).map((r: any) => ({ id: String(r.id), name: String(r.name || r.id).slice(0, 80), level: Number(r.level) || 0, kind: r.kind, rects: (Array.isArray(r.rects) ? r.rects : []).map((q: any) => q.map(Number)) })),
        } : null,
      };
    }
  } catch { /* tour files unreachable: fall back to ids */ }
  infoCache.set(key, { at: Date.now(), info });
  return info;
}

export const fmtDur = (s: number) => { s = Math.round(s); const m = Math.floor(s / 60); return m ? `${m} min ${String(s % 60).padStart(2, '0')} s` : `${s} s`; };

/** The tours of an environment (with their titles) and the one the page is about (?t=, else the latest visited). */
export async function pickTour(env: { id: string; tours_base?: string | null }, u: URL) {
  const tours = await tourList(env.id);
  const want = u.searchParams.get('t');
  const id = tours.find((x) => x.tour === want)?.tour ?? tours[0]?.tour ?? null;
  const infos = await Promise.all(tours.slice(0, 24).map((x) => tourInfo(env.tours_base, x.tour)));
  const options = tours.map((x, i) => ({ id: x.tour, title: infos[i]?.title || x.tour, visits: x.visits }));
  const info = id ? infos[tours.findIndex((x) => x.tour === id)] ?? (await tourInfo(env.tours_base, id)) : null;
  return { tours: options, id, info };
}

/** Room ids to names, in the order of the tour's own list. */
export const roomNames = (info: TourInfo | null) => new Map((info?.map?.rooms || []).filter((r) => r.kind !== 'stairs').map((r) => [r.id, r.name]));

/** Visits and average time per tour environment, for the overview cards. */
export async function tourOverview(envIds: string[], from: number, to: number, prevFrom: number, bucket: number) {
  const out = new Map<string, { visits: number; prev: number; avg: number; tours: number; counts: number[]; last: number | null }>();
  if (!envIds.length) return out;
  const marks = envIds.map(() => '?').join(',');
  const rows = (await db().prepare(`SELECT env_id, tour, started, dur FROM tour_visits WHERE env_id IN (${marks}) AND started >= ? AND started < ? AND dur >= ${MIN_SECONDS}`)
    .bind(...envIds, prevFrom, to).all<{ env_id: string; tour: string; started: number; dur: number }>()).results;
  const n = Math.max(1, Math.round((to - from) / bucket));
  const tours = new Map<string, Set<string>>();
  for (const id of envIds) { out.set(id, { visits: 0, prev: 0, avg: 0, tours: 0, counts: Array.from({ length: n }, () => 0), last: null }); tours.set(id, new Set()); }
  for (const r of rows) {
    const o = out.get(r.env_id)!;
    if (r.started < from) { o.prev++; continue; }
    o.visits++; o.avg += r.dur; tours.get(r.env_id)!.add(r.tour);
    const b = Math.floor((r.started - from) / bucket); if (b >= 0 && b < n) o.counts[b]++;
    if (!o.last || r.started > o.last) o.last = r.started;
  }
  for (const [id, o] of out) { o.avg = o.visits ? o.avg / o.visits : 0; o.tours = tours.get(id)!.size; }
  return out;
}
