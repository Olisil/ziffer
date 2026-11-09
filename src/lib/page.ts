import type { AstroGlobal } from 'astro';
import { env as cfEnv } from 'cloudflare:workers';
import { db, getScopedEnvironment, listEnvironments, listProjects, ownerId, url, type Environment, type Project } from './server';
import { billable, isServiceOwner, me, type User } from './users';

export type EnvPage = {
  owner: string;
  user: User;
  env: Environment & { project_name: string };
  project: Project;
  projects: Project[];
  environments: Environment[];
  devUser: boolean;
  /** Can change things (Pro access, billing in order) — Basic members and locked projects are read-only. */
  canEdit: boolean;
  readOnlyReason: string | null;
  isProjectOwner: boolean;
  viaAdmin: boolean;
};

export const BILLING_GRACE_DAYS = 14;

/** Why a project is read-only for its Pro members, if it is: billable seats but no working payment after the grace period. */
export async function billingLock(project: Project): Promise<string | null> {
  if (project.billing_status === 'active') return null;
  const seats = (await db().prepare(
    `SELECT m.access, COALESCE(u.plan, 'pro') AS plan FROM project_members m LEFT JOIN users u ON u.id = m.user_id WHERE m.project_id = ?`,
  ).bind(project.id).all<{ access: 'pro' | 'basic'; plan: any }>()).results.filter(billable).length;
  if (!seats) return null;
  if (project.billing_status === 'past_due') return 'The last payment for this project failed. Update the card in Settings → Plan & billing.';
  if (Date.now() - project.created > BILLING_GRACE_DAYS * 864e5) return 'This project needs a payment method for its Pro members. Add one in Settings → Plan & billing.';
  return null;
}

export const isDevUser = () => !!(import.meta.env.DEV && (cfEnv as any).ZIFFER_DEV_USER);

/** Loads the signed-in owner's environment for /e/[env] pages, or returns a redirect/404 Response. */
export async function loadEnvPage(Astro: AstroGlobal): Promise<EnvPage | Response> {
  const owner = ownerId(Astro);
  if (!owner) return Astro.redirect(url('sign-in'));
  const user = await me(Astro);
  if (!user) return Astro.redirect(url('sign-in'));
  const admin = isServiceOwner(user);
  const env = await getScopedEnvironment(owner, String(Astro.params.env), admin);
  if (!env) return new Response('Not found', { status: 404 });
  const projects = await listProjects(owner);
  let project = projects.find((p) => p.id === env.project_id);
  if (!project) {
    // The service owner looking at someone else's project.
    project = { ...(await db().prepare('SELECT * FROM projects WHERE id = ?').bind(env.project_id).first<Project>())!, access: 'pro', role: 'owner' };
    projects.push(project);
  }
  const environments = await listEnvironments(env.project_id);
  const lock = env.viaAdmin || user.plan === 'owner' ? null : await billingLock(project);
  const readOnlyReason = env.access === 'basic' ? 'You have Basic (read-only) access to this project.' : lock;
  if (Astro.request.method === 'POST' && readOnlyReason) return new Response(readOnlyReason, { status: 403 });
  return {
    owner, user, env, project, projects, environments, devUser: isDevUser(),
    canEdit: !readOnlyReason, readOnlyReason, isProjectOwner: env.role === 'owner' || admin, viaAdmin: !!env.viaAdmin,
  };
}

export const fmt = {
  int: (n: number) => Math.round(n || 0).toLocaleString('en-GB'),
  dur(sec: number) {
    sec = Math.round(sec || 0);
    const m = Math.floor(sec / 60), s = sec % 60;
    return m ? `${m}m ${String(s).padStart(2, '0')}s` : `${s}s`;
  },
  pct: (n: number) => `${Math.round(n || 0)}%`,
  delta(now: number, prev: number, kind: 'pct' | 'abs' | 'dur' = 'pct') {
    if (!prev && !now) return { text: 'No data yet', down: true };
    if (!prev) return { text: 'New this period', down: false };
    const d = now - prev;
    if (kind === 'abs') return { text: `${d >= 0 ? '+' : '−'}${Math.abs(Math.round(d))} vs previous`, down: d < 0 };
    if (kind === 'dur') return { text: `${d >= 0 ? '+' : '−'}${fmt.dur(Math.abs(d))} vs previous`, down: d < 0 };
    const p = (d / prev) * 100;
    return { text: `${p >= 0 ? '+' : '−'}${Math.abs(p).toFixed(1)}% vs previous`, down: p < 0 };
  },
  time: (ts: number) => new Date(ts).toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Stockholm' }),
  date: (ts: number) => new Date(ts).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'Europe/Stockholm' }),
  device: (d: string | null) => (d ? d[0].toUpperCase() + d.slice(1) : 'Desktop'),
};

/** For API routes under /e/[env]: the environment if the person may read it (or write, when asked). */
export async function envForApi(ctx: import('astro').APIContext, write: boolean) {
  const owner = ownerId(ctx);
  if (!owner) return { error: new Response('Unauthorized', { status: 401 }) } as const;
  const user = await me(ctx);
  const env = await getScopedEnvironment(owner, String(ctx.params.env), isServiceOwner(user));
  if (!env) return { error: new Response('Not found', { status: 404 }) } as const;
  if (write && env.access !== 'pro') return { error: new Response('Read-only access', { status: 403 }) } as const;
  return { env, user } as const;
}
