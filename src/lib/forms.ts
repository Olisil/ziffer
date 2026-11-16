import { cleanDomain, db, id } from './server';
import { planState } from './plans';
import { conflictMessage, domainConflict, type Conflict } from './claims';

export type EnvInput = { kind: 'web' | 'tour'; name: string; domain: string | null };

export function readEnvForm(form: FormData): { value?: EnvInput; error?: string; raw: Record<string, string> } {
  const raw = { kind: String(form.get('kind') || 'web'), name: String(form.get('name') || '').trim(), domain: String(form.get('domain') || '').trim() };
  const kind = raw.kind === 'tour' ? 'tour' : 'web';
  if (!raw.name) return { error: 'Give the environment a name.', raw };
  let domain: string | null = null;
  if (kind === 'web' || raw.domain) {
    domain = cleanDomain(raw.domain || raw.name);
    if (!domain) return { error: 'Enter the site’s domain, for example nassau.se.', raw };
  }
  return { value: { kind, name: raw.name.slice(0, 80), domain }, raw };
}

/** Checks the rules for adding an environment: at most MAX_ENVIRONMENTS per project and one project per site. */
export async function checkNewEnvironment(projectId: string | null, v: EnvInput, userId: string): Promise<{ error: string; conflict?: Conflict } | null> {
  if (projectId) {
    const n = (await db().prepare('SELECT COUNT(*) AS n FROM environments WHERE project_id = ?').bind(projectId).first<{ n: number }>())?.n ?? 0;
    const st = await planState(projectId);
    if (n >= st.limits.environments) return { error: st.plan === 'studio' ? `A project can have up to ${st.limits.environments} environments. Remove one in its Settings, or create a new project.` : `The ${st.limits.name} plan has room for ${st.limits.environments} ${st.limits.environments === 1 ? 'environment' : 'environments'}. Choose a larger plan in the project’s settings to add more.` };
    if (v.kind === 'tour' && !st.limits.tours) return { error: 'Virtual tours are part of the Starter and Studio plans. Choose a plan in the project’s settings first.' };
  }
  if (v.kind === 'web' && v.domain) {
    const c = await domainConflict(v.domain, userId);
    if (c) return { error: conflictMessage(v.domain, c), conflict: c };
  }
  return null;
}

export async function createEnvironment(projectId: string, v: EnvInput) {
  const envId = id(10);
  await db()
    .prepare('INSERT INTO environments (id, project_id, kind, name, domain, site_key, created) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(envId, projectId, v.kind, v.name, v.domain, `zs_${id(16)}`, Date.now())
    .run();
  return envId;
}
