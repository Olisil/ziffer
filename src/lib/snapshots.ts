import { env } from 'cloudflare:workers';
import { db } from './server';

export const SNAP_MAX_BYTES = 3 * 1024 * 1024;
export const SNAP_FRESH_MS = 3 * 864e5; // re-capture a page at most every 3 days
export const SNAP_MAX_PER_ENV = 1000;

export type Snapshot = { env_id: string; path: string; device: 'desktop' | 'mobile'; ts: number; vw: number; vh: number; dw: number; dh: number; bytes: number; r2_key: string };

export const bucket = () => (env as any).RECORDINGS as R2Bucket | undefined;

export async function snapKey(envId: string, device: string, path: string) {
  const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(path));
  const hex = Array.from(new Uint8Array(h).slice(0, 16), (b) => b.toString(16).padStart(2, '0')).join('');
  return `snap/${envId}/${device}/${hex}.html`;
}

export function getSnapshot(envId: string, path: string, device: string) {
  return db().prepare('SELECT * FROM snapshots WHERE env_id = ? AND path = ? AND device = ?').bind(envId, path, device).first<Snapshot>();
}

/** A capture is wanted when the page was really visited recently and we have no fresh snapshot. */
export async function snapshotWanted(envId: string, path: string, device: 'desktop' | 'mobile') {
  if (!bucket()) return false;
  const vwCond = device === 'mobile' ? 'vw < 768' : 'vw >= 768';
  const row = await db().prepare(
    `SELECT
       (SELECT ts FROM snapshots WHERE env_id = ?1 AND path = ?2 AND device = ?3) AS snap_ts,
       (SELECT COUNT(*) FROM snapshots WHERE env_id = ?1) AS snap_count,
       EXISTS(SELECT 1 FROM pageviews WHERE env_id = ?1 AND path = ?2 AND ts > ?4 AND ${vwCond}) AS visited`,
  ).bind(envId, path, device, Date.now() - 864e5).first<{ snap_ts: number | null; snap_count: number; visited: number }>();
  if (!row || !row.visited) return false;
  if (row.snap_ts) return Date.now() - row.snap_ts > SNAP_FRESH_MS;
  return row.snap_count < SNAP_MAX_PER_ENV;
}
