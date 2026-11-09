// Service-owner (Nassau) views across all projects and people.
import type { AstroGlobal } from 'astro';
import { db, url } from './server';
import { isServiceOwner, me } from './users';

const all = async <T>(sql: string, ...b: unknown[]) => (await db().prepare(sql).bind(...b).all<T>()).results;
const one = async <T>(sql: string, ...b: unknown[]) => (await db().prepare(sql).bind(...b).first<T>())!;

/** Returns the service owner, or a 404 for everyone else (the admin area isn't advertised). */
export async function requireOwner(Astro: AstroGlobal) {
  const u = await me(Astro);
  if (!u) return Astro.redirect(url('sign-in'));
  if (!isServiceOwner(u)) return new Response('Not found', { status: 404 });
  return u;
}

export async function serviceStats() {
  const now = Date.now(), d30 = now - 30 * 864e5, d7 = now - 7 * 864e5;
  const [users, plans, projects, envs, traffic, prev, stored, snaps, audits, seats, daily, signups, top, recent] = await Promise.all([
    one<{ n: number; active7: number; new30: number }>('SELECT COUNT(*) AS n, SUM(CASE WHEN last_seen >= ? THEN 1 ELSE 0 END) AS active7, SUM(CASE WHEN created >= ? THEN 1 ELSE 0 END) AS new30 FROM users', d7, d30),
    all<{ plan: string; n: number }>('SELECT plan, COUNT(*) AS n FROM users GROUP BY plan'),
    one<{ n: number; new30: number }>('SELECT COUNT(*) AS n, SUM(CASE WHEN created >= ? THEN 1 ELSE 0 END) AS new30 FROM projects', d30),
    one<{ n: number; web: number; confirmed: number }>("SELECT COUNT(*) AS n, SUM(CASE WHEN kind = 'web' THEN 1 ELSE 0 END) AS web, SUM(CASE WHEN verified_at IS NOT NULL THEN 1 ELSE 0 END) AS confirmed FROM environments"),
    one<{ sessions: number; visitors: number; pageviews: number }>('SELECT COUNT(*) AS sessions, COUNT(DISTINCT visitor) AS visitors, COALESCE(SUM(pageviews), 0) AS pageviews FROM sessions WHERE started >= ?', d30),
    one<{ sessions: number }>('SELECT COUNT(*) AS sessions FROM sessions WHERE started >= ? AND started < ?', d30 - 30 * 864e5, d30),
    one<{ sessions: number; pageviews: number; clicks: number }>('SELECT (SELECT COUNT(*) FROM sessions) AS sessions, (SELECT COUNT(*) FROM pageviews) AS pageviews, (SELECT COUNT(*) FROM clicks) AS clicks'),
    one<{ n: number; bytes: number }>('SELECT COUNT(*) AS n, COALESCE(SUM(bytes), 0) AS bytes FROM snapshots'),
    one<{ n: number; avg_seo: number; avg_aeo: number }>("SELECT COUNT(*) AS n, ROUND(AVG(seo)) AS avg_seo, ROUND(AVG(aeo)) AS avg_aeo FROM audits WHERE status = 'done' AND ran_at >= ?", d30),
    one<{ n: number }>("SELECT COUNT(*) AS n FROM project_members m LEFT JOIN users u ON u.id = m.user_id WHERE m.access = 'pro' AND COALESCE(u.plan, 'pro') IN ('pro', 'basic')"),
    all<{ day: number; n: number }>('SELECT CAST((started - ?) / 86400000 AS INTEGER) AS day, COUNT(*) AS n FROM sessions WHERE started >= ? GROUP BY day', d30, d30),
    all<{ wk: number; n: number }>('SELECT CAST((created - ?) / 604800000 AS INTEGER) AS wk, COUNT(*) AS n FROM users WHERE created >= ? GROUP BY wk', now - 12 * 7 * 864e5, now - 12 * 7 * 864e5),
    all<{ id: string; name: string; sessions: number; members: number; envs: number }>(
      `SELECT p.id, p.name,
              (SELECT COUNT(*) FROM sessions s JOIN environments e ON e.id = s.env_id WHERE e.project_id = p.id AND s.started >= ?) AS sessions,
              (SELECT COUNT(*) FROM project_members m WHERE m.project_id = p.id) AS members,
              (SELECT COUNT(*) FROM environments e WHERE e.project_id = p.id) AS envs
         FROM projects p ORDER BY sessions DESC LIMIT 8`, d30),
    all<{ kind: string; at: number; text: string; link: string }>(
      `SELECT * FROM (
         SELECT 'user' AS kind, created AS at, COALESCE(name, email) || ' signed up' AS text, 'admin/users/' || id AS link FROM users
         UNION ALL SELECT 'project', created, 'Project “' || name || '” created', 'admin/projects/' || id FROM projects
         UNION ALL SELECT 'version', v.created, e.name || ': new version detected', 'admin/projects/' || e.project_id FROM site_versions v JOIN environments e ON e.id = v.env_id WHERE v.id NOT LIKE '%-v1' AND v.merged_into IS NULL
         UNION ALL SELECT 'confirmed', verified_at, COALESCE(domain, name) || ' confirmed', 'admin/projects/' || project_id FROM environments WHERE verified_at IS NOT NULL
       ) ORDER BY at DESC LIMIT 12`),
  ]);
  return {
    users, plans: Object.fromEntries(plans.map((p) => [p.plan, p.n])) as Record<string, number>, projects, envs, traffic, prev, stored, snaps, audits, seats: seats.n,
    daily: Array.from({ length: 30 }, (_, i) => daily.find((x) => x.day === i)?.n ?? 0),
    signups: Array.from({ length: 12 }, (_, i) => signups.find((x) => x.wk === i)?.n ?? 0),
    top, recent,
  };
}

export async function adminUsers() {
  return all<{ id: string; email: string | null; name: string | null; image_url: string | null; plan: string; created: number; last_seen: number | null; projects: number; owns: number; pro_in: number }>(
    `SELECT u.*, (SELECT COUNT(*) FROM project_members m WHERE m.user_id = u.id) AS projects,
            (SELECT COUNT(*) FROM project_members m WHERE m.user_id = u.id AND m.role = 'owner') AS owns,
            (SELECT COUNT(*) FROM project_members m WHERE m.user_id = u.id AND m.access = 'pro') AS pro_in
       FROM users u ORDER BY u.plan = 'owner' DESC, u.last_seen DESC`);
}

export async function adminProjects() {
  return all<{ id: string; name: string; created: number; billing_status: string | null; owner_name: string | null; owner_email: string | null; members: number; envs: number; sessions: number; seats: number }>(
    `SELECT p.*, ou.name AS owner_name, ou.email AS owner_email,
            (SELECT COUNT(*) FROM project_members m WHERE m.project_id = p.id) AS members,
            (SELECT COUNT(*) FROM environments e WHERE e.project_id = p.id) AS envs,
            (SELECT COUNT(*) FROM sessions s JOIN environments e ON e.id = s.env_id WHERE e.project_id = p.id AND s.started >= ?) AS sessions,
            (SELECT COUNT(*) FROM project_members m LEFT JOIN users u ON u.id = m.user_id WHERE m.project_id = p.id AND m.access = 'pro' AND COALESCE(u.plan, 'pro') IN ('pro', 'basic')) AS seats
       FROM projects p
       LEFT JOIN project_members om ON om.project_id = p.id AND om.role = 'owner' LEFT JOIN users ou ON ou.id = om.user_id
      ORDER BY sessions DESC, p.created DESC`, Date.now() - 30 * 864e5);
}

// ---- actions ---------------------------------------------------------------------------------

import { id as newId } from './server';
import { esc, layout, sendMail } from './mail';
import { appOrigin, notify } from './notify';
import { PLAN_LABEL, type Plan, type User as AUser } from './users';

const PLAN_TEXT: Record<string, string> = {
  pro_free: 'Pro – Free: create projects and edit everything, at no cost.',
  pro: 'Pro: create projects and edit everything. Billed monthly per project seat, after each full month.',
  basic: 'Basic – Free: view the projects you’re invited to (read-only).',
};

/** Change someone's plan. The service owner's own plan comes from the owner email and can't be changed here. */
export async function setPlan(admin: AUser, userId: string, plan: Plan, req: Request) {
  if (!['pro_free', 'pro', 'basic'].includes(plan)) throw new Error('Unknown plan.');
  const u = await one<{ plan: string; email: string | null } | null>('SELECT plan, email FROM users WHERE id = ?', userId);
  if (!u) throw new Error('No such person.');
  if (u.plan === 'owner') throw new Error('The owner plan follows the owner email address.');
  if (u.plan === plan) return;
  await db().prepare('UPDATE users SET plan = ? WHERE id = ?').bind(plan, userId).run();
  await notify([userId], {
    kind: 'billing', title: `Your Probe plan is now ${PLAN_LABEL[plan]}`,
    lines: [PLAN_TEXT[plan], `Changed by ${esc(admin.name || admin.email || 'Nassau')}.`], link: '/app/settings?tab=plan',
  }, appOrigin(req));
}

/**
 * Invite someone with a plan, optionally straight into a project. People who already have an account
 * get the plan (and project) at once; others get an email with a link that is valid for 30 days.
 */
export async function adminInvite(admin: AUser, o: { email: string; plan: Plan; projectId?: string | null; access?: 'pro' | 'basic' }, req: Request) {
  const email = o.email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('That doesn’t look like an email address.');
  if (!['pro_free', 'pro', 'basic'].includes(o.plan)) throw new Error('Pick a plan.');
  const projectId = o.projectId || null, access = o.access === 'pro' ? 'pro' : 'basic';
  const project = projectId ? await one<{ name: string } | null>('SELECT name FROM projects WHERE id = ?', projectId) : null;
  if (projectId && !project) throw new Error('That project doesn’t exist.');
  const origin = appOrigin(req), now = Date.now();
  const existing = await one<{ id: string; plan: string } | null>('SELECT id, plan FROM users WHERE email = ? AND email_verified = 1', email);
  if (existing) {
    if (existing.plan !== 'owner' && existing.plan !== o.plan) await setPlan(admin, existing.id, o.plan, req);
    if (projectId) {
      await db().prepare("INSERT INTO project_members (project_id, user_id, access, role, added_by, created) VALUES (?, ?, ?, 'member', ?, ?) ON CONFLICT (project_id, user_id) DO UPDATE SET access = excluded.access")
        .bind(projectId, existing.id, access, admin.id, now).run();
      await notify([existing.id], { kind: 'members', projectId, title: `You were added to ${project!.name}`, lines: [`You have <b>${access === 'pro' ? 'Pro' : 'Basic'}</b> access.`], link: '/app/' }, origin);
    }
    return { existing: true as const, link: null };
  }
  await db().prepare('UPDATE invitations SET revoked = 1 WHERE email = ? AND plan IS NOT NULL AND accepted_at IS NULL').bind(email).run();
  const token = newId(20);
  await db().prepare('INSERT INTO invitations (token, project_id, email, access, plan, invited_by, created, expires) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(token, projectId, email, projectId ? access : null, o.plan, admin.id, now, now + 30 * 864e5).run();
  const link = `${origin}/app/invite/${token}`;
  await sendMail(email, `You’re invited to Probe`, layout({
    title: 'You’re invited to Probe',
    lines: [
      `${esc(admin.name || 'Nassau')} invited you to Probe with the plan <b>${PLAN_LABEL[o.plan]}</b>.`,
      PLAN_TEXT[o.plan],
      project ? `You’ll also join the project <b>${esc(project.name)}</b> with ${access === 'pro' ? 'Pro' : 'Basic'} access.` : 'Probe shows how people use websites: visits, heatmaps, sessions, versions and SEO/AEO audits.',
      'Create an account with this email address to accept. The link is valid for 30 days.',
    ],
    button: { text: 'Accept the invitation', href: link },
    footer: `Probe is a service by Nassau. You get this because ${esc(admin.email || 'Nassau')} invited ${esc(email)}.`,
  })).catch(() => null);
  return { existing: false as const, link };
}

export async function adminInvitations() {
  return all<{ token: string; email: string; plan: string | null; access: string | null; project_id: string | null; project_name: string | null; created: number; expires: number; invited_by_name: string | null }>(
    `SELECT i.token, i.email, i.plan, i.access, i.project_id, p.name AS project_name, i.created, i.expires, u.name AS invited_by_name
       FROM invitations i LEFT JOIN projects p ON p.id = i.project_id LEFT JOIN users u ON u.id = i.invited_by
      WHERE i.accepted_at IS NULL AND i.revoked = 0 AND i.expires > ? ORDER BY i.created DESC LIMIT 100`, Date.now());
}

export async function revokeInvitation(token: string) {
  await db().prepare('UPDATE invitations SET revoked = 1 WHERE token = ?').bind(token).run();
}

/** Usage per day (sessions) for one project or one environment over the last 30 days. */
export async function dailySessions(where: { projectId?: string; envId?: string }) {
  const from = Date.now() - 30 * 864e5;
  const rows = where.envId
    ? await all<{ day: number; n: number }>('SELECT CAST((started - ?) / 86400000 AS INTEGER) AS day, COUNT(*) AS n FROM sessions WHERE env_id = ? AND started >= ? GROUP BY day', from, where.envId, from)
    : await all<{ day: number; n: number }>('SELECT CAST((s.started - ?) / 86400000 AS INTEGER) AS day, COUNT(*) AS n FROM sessions s JOIN environments e ON e.id = s.env_id WHERE e.project_id = ? AND s.started >= ? GROUP BY day', from, where.projectId, from);
  return { from, counts: Array.from({ length: 30 }, (_, i) => rows.find((x) => x.day === i)?.n ?? 0) };
}

export async function adminUser(userId: string) {
  const u = await one<(AUser & { projects: number }) | null>('SELECT * FROM users WHERE id = ?', userId);
  if (!u) return null;
  const memberships = await all<{ project_id: string; name: string; access: string; role: string; created: number; sessions: number; envs: number }>(
    `SELECT m.project_id, p.name, m.access, m.role, m.created,
            (SELECT COUNT(*) FROM environments e WHERE e.project_id = p.id) AS envs,
            (SELECT COUNT(*) FROM sessions s JOIN environments e ON e.id = s.env_id WHERE e.project_id = p.id AND s.started >= ?) AS sessions
       FROM project_members m JOIN projects p ON p.id = m.project_id WHERE m.user_id = ? ORDER BY m.role = 'owner' DESC, p.name`, Date.now() - 30 * 864e5, userId);
  const requests = await all<{ project_name: string; status: string; created: number }>(
    'SELECT p.name AS project_name, r.status, r.created FROM access_requests r JOIN projects p ON p.id = r.project_id WHERE r.user_id = ? ORDER BY r.created DESC LIMIT 10', userId);
  return { user: u, memberships, requests };
}

export async function adminProject(projectId: string) {
  const p = await one<any>('SELECT * FROM projects WHERE id = ?', projectId);
  if (!p) return null;
  const d30 = Date.now() - 30 * 864e5;
  const [members, envs, invoices, days, invites] = await Promise.all([
    all<{ user_id: string; access: string; role: string; created: number; email: string | null; name: string | null; image_url: string | null; plan: string; last_seen: number | null }>(
      `SELECT m.user_id, m.access, m.role, m.created, u.email, u.name, u.image_url, COALESCE(u.plan, 'pro') AS plan, u.last_seen
         FROM project_members m LEFT JOIN users u ON u.id = m.user_id WHERE m.project_id = ? ORDER BY m.role = 'owner' DESC, m.created`, projectId),
    all<{ id: string; name: string; kind: string; domain: string | null; created: number; verified_at: number | null; sessions: number; pages: number; last: number | null; versions: number; audit: number | null }>(
      `SELECT e.id, e.name, e.kind, e.domain, e.created, e.verified_at,
              (SELECT COUNT(*) FROM sessions s WHERE s.env_id = e.id AND s.started >= ?) AS sessions,
              (SELECT COUNT(*) FROM pageviews v WHERE v.env_id = e.id AND v.ts >= ?) AS pages,
              (SELECT MAX(started) FROM sessions s WHERE s.env_id = e.id) AS last,
              (SELECT COUNT(*) FROM site_versions v WHERE v.env_id = e.id AND v.merged_into IS NULL) AS versions,
              (SELECT ROUND(AVG(seo)) FROM audits a WHERE a.env_id = e.id AND a.status = 'done' AND a.ran_at >= ?) AS audit
         FROM environments e WHERE e.project_id = ? ORDER BY e.created`, d30, d30, d30, projectId),
    all<{ month: string; seat_days: number; amount: number; currency: string; status: string; stripe_invoice: string | null; created: number }>('SELECT * FROM billing_invoices WHERE project_id = ? ORDER BY month DESC', projectId),
    all<{ day: string; seats: number }>('SELECT day, seats FROM billing_days WHERE project_id = ? ORDER BY day DESC LIMIT 62', projectId),
    all<{ token: string; email: string; access: string | null; created: number; expires: number }>('SELECT token, email, access, created, expires FROM invitations WHERE project_id = ? AND accepted_at IS NULL AND revoked = 0 AND expires > ?', projectId, Date.now()),
  ]);
  return { project: p, members, envs, invoices, days, invites };
}
