import { env } from 'cloudflare:workers';
import type { APIContext, AstroGlobal } from 'astro';

export type Env = { DB: D1Database; RECORDINGS?: R2Bucket; ZIFFER_DEV_USER?: string };
export const db = () => (env as unknown as Env).DB;

/** Base path from Webflow Cloud's mount (e.g. "/app"), never with a trailing slash. */
export const BASE = (import.meta.env.BASE_URL || '/').replace(/\/+$/, '');
/** Public home of the service; links in emails and background jobs use it. */
export const APP_HOME = 'https://probe.nassau.se';

export const url = (p = '') => `${BASE}/${p.replace(/^\/+/, '')}`;

export const id = (bytes = 12) => {
  const a = crypto.getRandomValues(new Uint8Array(bytes));
  return Array.from(a, (b) => 'abcdefghijkmnpqrstuvwxyz23456789'[b % 32]).join('');
};

export type Project = {
  id: string; owner_id: string; name: string; created: number;
  payer_id?: string | null; stripe_customer?: string | null; stripe_subscription?: string | null; billing_status?: string | null;
  access?: 'pro' | 'basic'; role?: 'owner' | 'member';
};
export type Environment = { id: string; project_id: string; kind: 'web' | 'tour'; name: string; domain: string | null; site_key: string; created: number; verified_at?: number | null };
export const MAX_ENVIRONMENTS = 4;

/** The signed-in Clerk user id. (In local development: ZIFFER_DEV_USER, or the zdev cookie to act as someone else.) */
export function ownerId(ctx: APIContext | AstroGlobal): string | null {
  const devUser = import.meta.env.DEV ? (env as unknown as Env).ZIFFER_DEV_USER : undefined;
  if (devUser) return (ctx.cookies.get('zdev')?.value || '').replace(/[^a-z0-9_]/gi, '') || devUser;
  const auth = (ctx.locals as any).auth?.();
  return auth?.userId ?? null;
}

/** Projects the person is a member of, with their access and role in each. */
export async function listProjects(userId: string) {
  const { results } = await db().prepare(
    `SELECT p.*, m.access, m.role FROM projects p JOIN project_members m ON m.project_id = p.id
      WHERE m.user_id = ? ORDER BY p.created`,
  ).bind(userId).all<Project>();
  return results;
}

export async function listEnvironments(projectId: string) {
  const { results } = await db().prepare('SELECT * FROM environments WHERE project_id = ? ORDER BY created').bind(projectId).all<Environment>();
  return results;
}

/**
 * Loads an environment only if the person is a member of its project (or is the service owner, who can
 * open everything — pass asOwner). Includes the person's access in that project.
 */
export async function getScopedEnvironment(userId: string, envId: string, asOwner = false) {
  const row = await db()
    .prepare(`SELECT e.*, p.name AS project_name, m.access AS access, m.role AS role FROM environments e
                JOIN projects p ON p.id = e.project_id
                LEFT JOIN project_members m ON m.project_id = p.id AND m.user_id = ?
              WHERE e.id = ?`)
    .bind(userId, envId)
    .first<Environment & { project_name: string; access: 'pro' | 'basic' | null; role: 'owner' | 'member' | null }>();
  if (!row) return null;
  if (!row.access) return asOwner ? { ...row, access: 'pro' as const, role: 'owner' as const, viaAdmin: true } : null;
  return { ...row, viaAdmin: false };
}

export async function firstEnvironment(userId: string) {
  return db()
    .prepare(`SELECT e.id FROM environments e JOIN project_members m ON m.project_id = e.project_id
              WHERE m.user_id = ? ORDER BY e.created LIMIT 1`)
    .bind(userId)
    .first<{ id: string }>();
}

export function cleanDomain(input: string) {
  let d = String(input || '').trim().toLowerCase();
  d = d.replace(/^[a-z]+:\/\//, '').replace(/\/.*$/, '').replace(/:\d+$/, '').replace(/^www\./, '');
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d) ? d : null;
}

export const RANGES = { '24h': 1, '7d': 7, '30d': 30, '90d': 90 } as const;
export type RangeKey = keyof typeof RANGES;
export type Range = { key: RangeKey | 'custom'; days: number; from: number; to: number; prevFrom: number; label?: string };
export const rangeQuery = (r: Range) =>
  r.key === 'custom' ? `from=${r.from}&to=${r.to}${r.label ? `&vl=${encodeURIComponent(r.label)}` : ''}` : `range=${r.key}`;
export function rangeOf(u: URL): Range {
  // A custom period (used for site versions): ?from=<ms>&to=<ms>&vl=<label>
  const f = Number(u.searchParams.get('from')), t = Number(u.searchParams.get('to'));
  if (f > 0 && t > f) {
    const to = Math.min(t, Date.now()), from = Math.min(f, to - 3600e3);
    return { key: 'custom', days: Math.max(1, Math.ceil((to - from) / 864e5)), from, to, prevFrom: from - (to - from), label: (u.searchParams.get('vl') || '').slice(0, 80) || undefined };
  }
  const key = (u.searchParams.get('range') as RangeKey) in RANGES ? (u.searchParams.get('range') as RangeKey) : '7d';
  const days = RANGES[key];
  const to = Date.now();
  const from = to - days * 864e5;
  return { key, days, from, to, prevFrom: from - days * 864e5 };
}
