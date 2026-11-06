// Shared by the public tracker endpoints: site-key lookup and origin checks.
import { db } from './server';

export type SiteEnv = { id: string; domain: string | null; kind: string };
const envCache = new Map<string, { env: SiteEnv | null; at: number }>();

export async function envForKey(key: string): Promise<SiteEnv | null> {
  const hit = envCache.get(key);
  if (hit && Date.now() - hit.at < 60_000) return hit.env;
  const env = await db().prepare('SELECT id, domain, kind FROM environments WHERE site_key = ?').bind(key).first<SiteEnv>();
  envCache.set(key, { env, at: Date.now() });
  return env;
}

export function originAllowed(origin: string | null, domain: string | null) {
  if (!origin || !domain) return false;
  try {
    const h = new URL(origin).hostname.toLowerCase();
    return h === domain || h.endsWith(`.${domain}`);
  } catch { return false; }
}

export const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : null);
export const pathOf = (v: unknown) => { const p = str(v, 300); return p && p.startsWith('/') ? p : null; };
export const deviceBucket = (vw: number) => (vw < 768 ? 'mobile' : 'desktop') as 'mobile' | 'desktop';
