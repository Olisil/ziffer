import { env } from 'cloudflare:workers';
import type { APIContext, AstroGlobal } from 'astro';

export type Env = { DB: D1Database; RECORDINGS?: R2Bucket; ZIFFER_DEV_USER?: string };
export const db = () => (env as unknown as Env).DB;

/** Base path from Webflow Cloud's mount (e.g. "/app"), never with a trailing slash. */
export const BASE = (import.meta.env.BASE_URL || '/').replace(/\/+$/, '');
export const url = (p = '') => `${BASE}/${p.replace(/^\/+/, '')}`;

export const id = (bytes = 12) => {
  const a = crypto.getRandomValues(new Uint8Array(bytes));
  return Array.from(a, (b) => 'abcdefghijkmnpqrstuvwxyz23456789'[b % 32]).join('');
};

export type Project = { id: string; owner_id: string; name: string; created: number };
export type Environment = { id: string; project_id: string; kind: 'web' | 'tour'; name: string; domain: string | null; site_key: string; created: number };

/** The Clerk owner for data scoping: the active organisation if any, otherwise the user. */
export function ownerId(ctx: APIContext | AstroGlobal): string | null {
  const devUser = import.meta.env.DEV ? (env as unknown as Env).ZIFFER_DEV_USER : undefined;
  if (devUser) return devUser;
  const auth = (ctx.locals as any).auth?.();
  if (!auth?.userId) return null;
  return auth.orgId || auth.userId;
}

export async function listProjects(owner: string) {
  const { results } = await db().prepare('SELECT * FROM projects WHERE owner_id = ? ORDER BY created').bind(owner).all<Project>();
  return results;
}

export async function listEnvironments(projectId: string) {
  const { results } = await db().prepare('SELECT * FROM environments WHERE project_id = ? ORDER BY created').bind(projectId).all<Environment>();
  return results;
}

/** Loads an environment only if it belongs to one of the owner's projects. */
export async function getScopedEnvironment(owner: string, envId: string) {
  return db()
    .prepare(`SELECT e.*, p.name AS project_name FROM environments e JOIN projects p ON p.id = e.project_id
              WHERE e.id = ? AND p.owner_id = ?`)
    .bind(envId, owner)
    .first<Environment & { project_name: string }>();
}

export async function firstEnvironment(owner: string) {
  return db()
    .prepare(`SELECT e.id FROM environments e JOIN projects p ON p.id = e.project_id
              WHERE p.owner_id = ? ORDER BY p.created, e.created LIMIT 1`)
    .bind(owner)
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
