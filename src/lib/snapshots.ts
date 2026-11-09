import { env } from 'cloudflare:workers';
import { db } from './server';
import { currentVersionId, ham, SAME } from './versions';

export const SNAP_MAX_BYTES = 3 * 1024 * 1024;
export const SNAP_FRESH_MS = 3 * 864e5; // re-capture a page at most every 3 days
export const SNAP_MAX_PER_ENV = 3000;

export type Snapshot = {
  env_id: string; path: string; device: 'desktop' | 'mobile'; version_id: string; s: string | null;
  ts: number; vw: number; vh: number; dw: number; dh: number; bytes: number; r2_key: string;
};

export const bucket = () => (env as any).RECORDINGS as R2Bucket | undefined;

export async function snapKey(envId: string, device: string, path: string, versionId: string) {
  const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(path));
  const hex = Array.from(new Uint8Array(h).slice(0, 16), (b) => b.toString(16).padStart(2, '0')).join('');
  return `snap/${envId}/${device}/${hex}${versionId ? `-${versionId}` : ''}.html`;
}

/**
 * The picture of a page that best matches a moment: taken during the same version when possible,
 * otherwise the closest one in time. Without a moment: the newest.
 */
export async function getSnapshot(envId: string, path: string, device: string, at?: { from?: number; to?: number; version?: string }) {
  const DB = db();
  if (at?.version !== undefined) {
    const exact = await DB.prepare('SELECT * FROM snapshots WHERE env_id = ? AND path = ? AND device = ? AND version_id = ?')
      .bind(envId, path, device, at.version).first<Snapshot>();
    if (exact) return exact;
  }
  const to = at?.to ?? Number.MAX_SAFE_INTEGER, from = at?.from ?? 0;
  return DB.prepare(
    `SELECT * FROM snapshots WHERE env_id = ? AND path = ? AND device = ?
      ORDER BY (ts >= ? AND ts < ?) DESC, CASE WHEN ts < ? THEN ? - ts ELSE (ts - ?) * 4 END ASC LIMIT 1`,
  ).bind(envId, path, device, from, to, to, to, to).first<Snapshot>();
}

/**
 * A capture is wanted when the page was really visited recently and the current version of the site has
 * no picture of it yet, its layout has changed since, or the picture is older than a few days.
 */
export async function snapshotWanted(envId: string, path: string, device: 'desktop' | 'mobile', s?: string | null) {
  if (!bucket()) return false;
  const version = (await currentVersionId(envId)) ?? '';
  const vwCond = device === 'mobile' ? 'vw < 768' : 'vw >= 768';
  const row = await db().prepare(
    `SELECT
       (SELECT ts FROM snapshots WHERE env_id = ?1 AND path = ?2 AND device = ?3 AND version_id = ?5) AS snap_ts,
       (SELECT s FROM snapshots WHERE env_id = ?1 AND path = ?2 AND device = ?3 AND version_id = ?5) AS snap_s,
       (SELECT COUNT(*) FROM snapshots WHERE env_id = ?1) AS snap_count,
       (SELECT s FROM page_state WHERE env_id = ?1 AND path = ?2 AND device = ?3) AS stable_s,
       (SELECT since FROM page_state WHERE env_id = ?1 AND path = ?2 AND device = ?3) AS stable_since,
       EXISTS(SELECT 1 FROM pageviews WHERE env_id = ?1 AND path = ?2 AND ts > ?4 AND ${vwCond}) AS visited`,
  ).bind(envId, path, device, Date.now() - 864e5, version).first<{ snap_ts: number | null; snap_s: string | null; snap_count: number; visited: number; stable_s: string | null; stable_since: number | null }>();
  if (!row || !row.visited) return false;
  if (row.snap_ts) {
    if (s && row.snap_s && ham(s, row.snap_s) > SAME) {
      // The page looks different from this version's picture. Keep the old picture until the new layout has
      // settled: a new site version gets its own picture anyway; a page-level redesign replaces it after 6 h.
      return !!row.stable_s && ham(s, row.stable_s) <= SAME && Date.now() - (row.stable_since ?? 0) > 6 * 3600e3;
    }
    return Date.now() - row.snap_ts > SNAP_FRESH_MS;
  }
  return row.snap_count < SNAP_MAX_PER_ENV;
}
