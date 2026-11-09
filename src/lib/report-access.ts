import type { APIContext, AstroGlobal } from 'astro';
import { db, ownerId, type Project } from './server';
import { isServiceOwner, me } from './users';
import { SECTIONS, type Choice, type Section } from './report';

/** The project if the person may export it: Pro members (and the service owner). Basic accounts can't export. */
export async function reportProject(ctx: APIContext | AstroGlobal) {
  const uid = ownerId(ctx);
  if (!uid) return { error: 401 as const };
  const user = await me(ctx);
  const p = await db().prepare(
    `SELECT p.*, m.access FROM projects p LEFT JOIN project_members m ON m.project_id = p.id AND m.user_id = ? WHERE p.id = ?`,
  ).bind(uid, String(ctx.params.project)).first<Project & { access: string | null }>();
  if (!p || (!p.access && !isServiceOwner(user))) return { error: 404 as const };
  if (p.access === 'basic' && !isServiceOwner(user)) return { error: 403 as const, project: p, user };
  return { project: p, user };
}

export function readChoices(u: URL) {
  const choices: Choice[] = u.searchParams.getAll('e').map((v) => { const [envId, period] = v.split('|'); return { envId, period: period || '30d' }; }).filter((c) => c.envId);
  const s = u.searchParams.getAll('s');
  const sections = new Set<Section>((s.length ? s : SECTIONS.map(([k]) => k)).filter((k): k is Section => SECTIONS.some(([x]) => x === k)));
  return { choices, sections };
}
