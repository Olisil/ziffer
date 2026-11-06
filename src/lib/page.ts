import type { AstroGlobal } from 'astro';
import { env as cfEnv } from 'cloudflare:workers';
import { getScopedEnvironment, listEnvironments, listProjects, ownerId, url, type Environment, type Project } from './server';

export type EnvPage = {
  owner: string;
  env: Environment & { project_name: string };
  project: Project;
  projects: Project[];
  environments: Environment[];
  devUser: boolean;
};

export const isDevUser = () => !!(import.meta.env.DEV && (cfEnv as any).ZIFFER_DEV_USER);

/** Loads the signed-in owner's environment for /e/[env] pages, or returns a redirect/404 Response. */
export async function loadEnvPage(Astro: AstroGlobal): Promise<EnvPage | Response> {
  const owner = ownerId(Astro);
  if (!owner) return Astro.redirect(url('sign-in'));
  const env = await getScopedEnvironment(owner, String(Astro.params.env));
  if (!env) return new Response('Not found', { status: 404 });
  const projects = await listProjects(owner);
  const project = projects.find((p) => p.id === env.project_id)!;
  const environments = await listEnvironments(env.project_id);
  return { owner, env, project, projects, environments, devUser: isDevUser() };
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
