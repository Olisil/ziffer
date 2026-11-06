import { cleanDomain, db, id } from './server';

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

export async function createEnvironment(projectId: string, v: EnvInput) {
  const envId = id(10);
  await db()
    .prepare('INSERT INTO environments (id, project_id, kind, name, domain, site_key, created) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(envId, projectId, v.kind, v.name, v.domain, `zs_${id(16)}`, Date.now())
    .run();
  return envId;
}
