// Layout change detection and site versions.
//
// The tracker sends three fingerprints per page view (once per visit and page):
//   s  64-bit SimHash of the page's element skeleton (tags + classes, not text)
//   t  the same for the shared template: header, navigation and footer
//   c  a hash of title, description, headings and rough word count (content)
// A new fingerprint only replaces the stable one after it has repeated (PROMOTE_HITS visits), so
// A/B tests, cookie banners and half-loaded pages don't count as changes.
import { db, id } from './server';

export const SAME = 8; // SimHash bits that may differ for "same layout"
export const MAJOR = 14; // a page's own layout changed a lot
export const PROMOTE_HITS = 2;
const WINDOW = 72 * 3600e3; // changes this close together belong to the same release

export function ham(a?: string | null, b?: string | null) {
  if (!a || !b || a.length !== 16 || b.length !== 16) return 64;
  let n = 0;
  for (let i = 0; i < 16; i += 8) {
    let x = (parseInt(a.slice(i, i + 8), 16) ^ parseInt(b.slice(i, i + 8), 16)) >>> 0;
    while (x) { x &= x - 1; n++; }
  }
  return n;
}
export const isHash = (v: unknown, len: number) => typeof v === 'string' && v.length === len && /^[0-9a-f]+$/.test(v);

export type Version = { id: string; env_id: string; detected_at: number; created: number; name: string | null; merged_into: string | null; reason: string | null };
export type VersionView = Version & { n: number; label: string; from: number; to: number; merged: Version[] };

/** Versions as shown: merged ones folded into their target, numbered 1.0, 2.0, … in time order. */
export async function listVersions(envId: string, envName: string): Promise<VersionView[]> {
  const rows = (await db().prepare('SELECT * FROM site_versions WHERE env_id = ? ORDER BY detected_at').bind(envId).all<Version>()).results;
  const main = rows.filter((v) => !v.merged_into);
  return main.map((v, i) => ({
    ...v,
    n: i + 1,
    label: v.name || `${envName} ${i + 1}.0`,
    from: v.detected_at,
    to: main[i + 1]?.detected_at ?? Infinity,
    merged: rows.filter((m) => m.merged_into === v.id),
  }));
}

export async function currentVersionId(envId: string) {
  const v = await db().prepare('SELECT id FROM site_versions WHERE env_id = ? AND merged_into IS NULL ORDER BY detected_at DESC LIMIT 1').bind(envId).first<{ id: string }>();
  return v?.id ?? null;
}

/** The first version starts with the first data we have for the environment. */
export async function ensureBaseVersion(envId: string, ts: number) {
  const has = await db().prepare('SELECT 1 FROM site_versions WHERE env_id = ? LIMIT 1').bind(envId).first();
  if (has) return;
  const first = await db().prepare('SELECT MIN(started) AS t FROM sessions WHERE env_id = ?').bind(envId).first<{ t: number | null }>();
  const vid = `${envId}-v1`; // fixed id: parallel first visits can't create two
  await db().batch([
    db().prepare('INSERT OR IGNORE INTO site_versions (id, env_id, detected_at, created, reason) VALUES (?, ?, ?, ?, ?)')
      .bind(vid, envId, Math.min(first?.t ?? ts, ts), Date.now(), JSON.stringify({ initial: true })),
    db().prepare("UPDATE snapshots SET version_id = ? WHERE env_id = ? AND version_id = ''").bind(vid, envId),
  ]);
}

type State = { s: string; t: string | null; c: string; since: number; cand_s: string | null; cand_t: string | null; cand_c: string | null; cand_hits: number; cand_first: number | null };
export type FpResult = { changed: null | { kind: 'structure' | 'template' | 'content'; distance: number; at: number }; first: boolean; newVersion: string | null };

/** Feed one fingerprint observation; returns what (if anything) changed. */
export async function observe(envId: string, path: string, device: string, fp: { s: string; t: string; c: string }, ts: number): Promise<FpResult> {
  const DB = db();
  const st = await DB.prepare('SELECT * FROM page_state WHERE env_id = ? AND path = ? AND device = ?').bind(envId, path, device).first<State>();
  if (!st) {
    await DB.prepare('INSERT OR IGNORE INTO page_state (env_id, path, device, s, t, c, since, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(envId, path, device, fp.s, fp.t, fp.c, ts, ts).run();
    await ensureBaseVersion(envId, ts);
    return { changed: null, first: true, newVersion: null };
  }
  const same = ham(fp.s, st.s) <= SAME && ham(fp.t, st.t) <= SAME && fp.c === st.c;
  if (same) {
    await DB.prepare('UPDATE page_state SET last_seen = ?, cand_s = NULL, cand_t = NULL, cand_c = NULL, cand_hits = 0, cand_first = NULL WHERE env_id = ? AND path = ? AND device = ?')
      .bind(ts, envId, path, device).run();
    return { changed: null, first: false, newVersion: null };
  }
  const matchesCandidate = st.cand_s && ham(fp.s, st.cand_s) <= SAME && ham(fp.t, st.cand_t) <= SAME && fp.c === st.cand_c;
  if (!matchesCandidate) {
    await DB.prepare('UPDATE page_state SET last_seen = ?, cand_s = ?, cand_t = ?, cand_c = ?, cand_hits = 1, cand_first = ? WHERE env_id = ? AND path = ? AND device = ?')
      .bind(ts, fp.s, fp.t, fp.c, ts, envId, path, device).run();
    return { changed: null, first: false, newVersion: null };
  }
  const hits = st.cand_hits + 1;
  if (hits < PROMOTE_HITS) {
    await DB.prepare('UPDATE page_state SET last_seen = ?, cand_hits = ? WHERE env_id = ? AND path = ? AND device = ?').bind(ts, hits, envId, path, device).run();
    return { changed: null, first: false, newVersion: null };
  }
  // The new layout/content has repeated: accept it.
  const at = st.cand_first ?? ts;
  const ds = ham(st.cand_s, st.s), dt = ham(st.cand_t, st.t);
  const kind = dt > SAME + 2 ? 'template' : ds > SAME ? 'structure' : 'content';
  const distance = kind === 'template' ? dt : kind === 'structure' ? ds : 0;
  await DB.batch([
    DB.prepare('UPDATE page_state SET s = cand_s, t = cand_t, c = cand_c, since = ?, last_seen = ?, cand_s = NULL, cand_t = NULL, cand_c = NULL, cand_hits = 0, cand_first = NULL WHERE env_id = ? AND path = ? AND device = ?')
      .bind(at, ts, envId, path, device),
    DB.prepare('INSERT INTO page_changes (env_id, path, device, at, kind, distance) VALUES (?, ?, ?, ?, ?, ?)').bind(envId, path, device, at, kind, distance),
  ]);
  const newVersion = kind === 'content' ? null : await maybeNewVersion(envId);
  return { changed: { kind, distance, at }, first: false, newVersion };
}

/** Decide whether recent layout changes add up to a new version of the site. */
async function maybeNewVersion(envId: string): Promise<string | null> {
  const DB = db();
  const now = Date.now();
  const recent = (await DB.prepare(
    `SELECT path, kind, MAX(distance) AS d, MIN(at) AS at FROM page_changes
      WHERE env_id = ? AND kind IN ('structure', 'template') AND at >= ? AND version_id IS NULL GROUP BY path, kind`,
  ).bind(envId, now - WINDOW).all<{ path: string; kind: string; d: number; at: number }>()).results;
  if (!recent.length) return null;
  const active = (await DB.prepare('SELECT COUNT(DISTINCT path) AS n FROM page_state WHERE env_id = ? AND last_seen >= ?')
    .bind(envId, now - 30 * 864e5).first<{ n: number }>())?.n ?? 1;
  const pathsTemplate = new Set(recent.filter((r) => r.kind === 'template').map((r) => r.path));
  const pathsMajor = new Set(recent.filter((r) => r.kind === 'structure' && r.d >= MAJOR).map((r) => r.path));
  const home = recent.find((r) => r.path === '/' && r.d >= 20);
  const enough = (n: number) => n >= Math.min(active, Math.max(2, Math.ceil(active * 0.4)));
  const qualifies = enough(pathsTemplate.size) || enough(pathsMajor.size) || !!home;
  if (!qualifies) return null;
  const at = Math.min(...recent.map((r) => r.at));
  const reason = {
    pages: [...new Set(recent.map((r) => r.path))].slice(0, 50),
    template: pathsTemplate.size, structure: pathsMajor.size, home: !!home, active,
    maxDistance: Math.max(...recent.map((r) => r.d)),
  };
  // One statement, so parallel requests can't both create a version: skipped when a (non-initial)
  // version already exists within the window — then these changes belong to that release.
  const vid = id(8);
  const ins = await DB.prepare(
    `INSERT INTO site_versions (id, env_id, detected_at, created, reason)
     SELECT ?1, ?2, ?3, ?4, ?5 WHERE NOT EXISTS (
       SELECT 1 FROM site_versions WHERE env_id = ?2 AND merged_into IS NULL AND id <> ?2 || '-v1'
         AND COALESCE(reason, '') NOT LIKE '%"initial":true%' AND ABS(detected_at - ?3) < ?6)`,
  ).bind(vid, envId, at, now, JSON.stringify(reason), WINDOW).run();
  const target = ins.meta.changes ? vid : (await DB.prepare(
    `SELECT id FROM site_versions WHERE env_id = ? AND merged_into IS NULL AND ABS(detected_at - ?) < ? ORDER BY detected_at DESC LIMIT 1`,
  ).bind(envId, at, WINDOW).first<{ id: string }>())?.id;
  if (target) {
    await DB.prepare('UPDATE page_changes SET version_id = ? WHERE env_id = ? AND version_id IS NULL AND at >= ?').bind(target, envId, now - WINDOW).run();
    if (!ins.meta.changes) {
      // Later pages of the same release: widen the version's summary to include them.
      const all = (await DB.prepare('SELECT path, kind, MAX(distance) AS d FROM page_changes WHERE version_id = ? GROUP BY path, kind').bind(target).all<{ path: string; kind: string; d: number }>()).results;
      const r = {
        pages: [...new Set(all.map((x) => x.path))].slice(0, 50),
        template: new Set(all.filter((x) => x.kind === 'template').map((x) => x.path)).size,
        structure: new Set(all.filter((x) => x.kind === 'structure' && x.d >= MAJOR).map((x) => x.path)).size,
        home: all.some((x) => x.path === '/' && x.d >= 20), active, maxDistance: Math.max(0, ...all.map((x) => x.d)),
      };
      await DB.prepare("UPDATE site_versions SET detected_at = MIN(detected_at, ?), reason = ? WHERE id = ? AND COALESCE(reason, '') NOT LIKE '%\"initial\":true%'").bind(at, JSON.stringify(r), target).run();
    }
  }
  return ins.meta.changes ? vid : null;
}

