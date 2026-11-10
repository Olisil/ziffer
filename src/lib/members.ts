// Who may do what with a project's people.
//
//   project owner   one per project (transferable): billing, delete project, remove anyone,
//                   change anyone between Pro and Basic, hand over ownership
//   Pro member      edits everything; invites people as Pro or Basic; removes Basic members
//   Basic member    reads only
//   everyone        can leave a project (the project owner hands over ownership first)
//   service owner   can do all of the above in any project
import { db, id } from './server';
import { billable, isServiceOwner, membersOf, type Access, type User } from './users';
import { appOrigin, esc, notify, projectRecipients } from './notify';
import { layout, sendMail } from './mail';
import { bucket } from './snapshots';

export type Actor = { user: User; projectId: string; access: Access | null; role: 'owner' | 'member' | null };

export async function actorFor(user: User, projectId: string): Promise<Actor> {
  const m = await db().prepare('SELECT access, role FROM project_members WHERE project_id = ? AND user_id = ?').bind(projectId, user.id).first<{ access: Access; role: 'owner' | 'member' }>();
  if (!m && isServiceOwner(user)) return { user, projectId, access: 'pro', role: 'owner' };
  return { user, projectId, access: m?.access ?? null, role: m?.role ?? null };
}

const isOwner = (a: Actor) => a.role === 'owner' || isServiceOwner(a.user);
const isPro = (a: Actor) => a.access === 'pro' || isServiceOwner(a.user);

export const can = {
  invite: (a: Actor) => isPro(a),
  changeAccess: (a: Actor) => isOwner(a),
  remove: (a: Actor, target: { access: Access; role: string; user_id: string }) =>
    target.user_id !== a.user.id && target.role !== 'owner' && (isOwner(a) || (isPro(a) && target.access === 'basic')),
  transfer: (a: Actor) => isOwner(a),
  deleteProject: (a: Actor) => isOwner(a),
  billing: (a: Actor) => isOwner(a),
  leave: (a: Actor) => !!a.role && a.role !== 'owner',
  answerRequests: (a: Actor) => isOwner(a),
};

const projectName = async (pid: string) => (await db().prepare('SELECT name FROM projects WHERE id = ?').bind(pid).first<{ name: string }>())?.name ?? 'a project';

/** Seat changes cost the project money: the project owner hears about every change in paid seats. */
async function tellSeats(projectId: string, what: string, origin: string) {
  await notify(await projectRecipients(projectId, 'owner'), {
    kind: 'billing', projectId, title: `Pro seats changed in ${await projectName(projectId)}`,
    lines: [what, 'Pro seats are billed after each full month, by the days they were active.'], link: '/app/settings?tab=plan',
  }, origin);
}

export async function invite(a: Actor, email: string, access: Access, req: Request) {
  if (!can.invite(a)) throw new Error('Only Pro members can invite people.');
  email = email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('That doesn’t look like an email address.');
  const existing = await db().prepare('SELECT m.user_id FROM project_members m JOIN users u ON u.id = m.user_id WHERE m.project_id = ? AND u.email = ?').bind(a.projectId, email).first();
  if (existing) throw new Error(`${email} is already a member.`);
  await db().prepare('UPDATE invitations SET revoked = 1 WHERE project_id = ? AND email = ? AND accepted_at IS NULL').bind(a.projectId, email).run();
  const token = id(20), now = Date.now();
  await db().prepare('INSERT INTO invitations (token, project_id, email, access, invited_by, created, expires) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(token, a.projectId, email, access, a.user.id, now, now + 14 * 864e5).run();
  const origin = appOrigin(req), name = await projectName(a.projectId);
  await sendMail(email, `${a.user.name || a.user.email} invited you to ${name} in Probe`, layout({
    title: `Join ${name} in Probe`,
    lines: [
      `${esc(a.user.name || a.user.email || 'Someone')} invited you to the project <b>${esc(name)}</b> with <b>${access === 'pro' ? 'Pro' : 'Basic'}</b> access${access === 'pro' ? ' (you can edit everything)' : ' (you can view everything)'}.`,
      'Probe shows how people use websites: visits, heatmaps, sessions, versions and SEO/AEO audits.',
      'The invitation is valid for 14 days. Sign in or create an account with this email address to accept it.',
    ],
    button: { text: 'Accept the invitation', href: `${origin}/app/invite/${token}` },
    footer: `You get this because ${esc(a.user.email || 'someone')} invited ${esc(email)}.`,
  }));
  return token;
}

/** Accept an invitation as the signed-in person (their email must match). */
export async function accept(user: User, token: string, req: Request) {
  const inv = await db().prepare('SELECT * FROM invitations WHERE token = ?').bind(token).first<{ token: string; project_id: string | null; email: string; access: Access | null; plan: string | null; invited_by: string; expires: number; accepted_at: number | null; revoked: number }>();
  if (!inv || inv.revoked) throw new Error('This invitation is no longer valid.');
  if (inv.accepted_at) return inv.project_id;
  if (inv.expires < Date.now()) throw new Error('This invitation has expired. Ask for a new one.');
  if (!user.email || user.email.toLowerCase() !== inv.email || !user.email_verified)
    throw new Error(`This invitation is for ${inv.email}. You’re signed in as ${user.email || 'an account without email'}.`);
  const now = Date.now(), DB = db();
  const stmts = [DB.prepare('UPDATE invitations SET accepted_by = ?, accepted_at = ? WHERE token = ?').bind(user.id, now, token)];
  if (inv.plan && user.plan !== 'owner') stmts.push(DB.prepare('UPDATE users SET plan = ? WHERE id = ?').bind(inv.plan, user.id));
  if (inv.project_id) {
    stmts.push(DB.prepare("INSERT INTO project_members (project_id, user_id, access, role, added_by, created) VALUES (?, ?, ?, 'member', ?, ?) ON CONFLICT (project_id, user_id) DO UPDATE SET access = excluded.access")
      .bind(inv.project_id, user.id, inv.access ?? 'basic', inv.invited_by, now));
    stmts.push(DB.prepare("UPDATE access_requests SET status = 'approved' WHERE project_id = ? AND user_id = ? AND status = 'open'").bind(inv.project_id, user.id));
  }
  await DB.batch(stmts);
  if (inv.project_id) {
    const origin = appOrigin(req), name = await projectName(inv.project_id);
    await notify((await projectRecipients(inv.project_id)).filter((x) => x !== user.id), {
      kind: 'members', projectId: inv.project_id, title: `${user.name || user.email} joined ${name}`,
      lines: [`${esc(user.name || user.email || '')} accepted the invitation and has <b>${inv.access === 'pro' ? 'Pro' : 'Basic'}</b> access.`], link: `/app/p/${inv.project_id}/settings`,
    }, origin);
    if (billable({ access: inv.access ?? 'basic', plan: user.plan })) await tellSeats(inv.project_id, `${esc(user.name || user.email || '')} joined as a Pro member.`, origin);
  }
  return inv.project_id;
}

export async function setAccess(a: Actor, userId: string, access: Access, req: Request) {
  if (!can.changeAccess(a)) throw new Error('Only the project owner can change access.');
  const target = (await membersOf(a.projectId)).find((m) => m.user_id === userId);
  if (!target) throw new Error('Not a member.');
  if (target.role === 'owner' && access === 'basic') throw new Error('The project owner always has Pro access.');
  await db().prepare('UPDATE project_members SET access = ? WHERE project_id = ? AND user_id = ?').bind(access, a.projectId, userId).run();
  if (billable({ access, plan: target.plan }) !== billable(target)) await tellSeats(a.projectId, `${esc(target.name || target.email || '')} is now ${access === 'pro' ? 'Pro' : 'Basic'}.`, appOrigin(req));
}

export async function remove(a: Actor, userId: string, req: Request) {
  const target = (await membersOf(a.projectId)).find((m) => m.user_id === userId);
  if (!target) throw new Error('Not a member.');
  if (!can.remove(a, target)) throw new Error(target.role === 'owner' ? 'The project owner can’t be removed — ownership has to be handed over first.' : 'Only the project owner can remove Pro members.');
  await db().prepare('DELETE FROM project_members WHERE project_id = ? AND user_id = ?').bind(a.projectId, userId).run();
  const origin = appOrigin(req);
  await notify([userId], { kind: 'members', projectId: a.projectId, title: `You were removed from ${await projectName(a.projectId)}`, lines: [`${esc(a.user.name || a.user.email || '')} removed you from the project.`] }, origin);
  if (billable(target)) await tellSeats(a.projectId, `${esc(target.name || target.email || '')} was removed (one Pro seat fewer).`, origin);
}

export async function leave(a: Actor, req: Request) {
  if (a.role === 'owner') throw new Error('Hand the project over to another member before leaving, or delete it.');
  if (!a.role) throw new Error('You’re not a member of this project.');
  await db().prepare('DELETE FROM project_members WHERE project_id = ? AND user_id = ?').bind(a.projectId, a.user.id).run();
  const origin = appOrigin(req);
  await notify(await projectRecipients(a.projectId, 'owner'), { kind: 'members', projectId: a.projectId, title: `${a.user.name || a.user.email} left ${await projectName(a.projectId)}`, lines: [`${esc(a.user.name || a.user.email || '')} left the project${a.access === 'pro' ? ' (one Pro seat fewer)' : ''}.`] }, origin);
}

export async function transfer(a: Actor, userId: string, req: Request) {
  if (!can.transfer(a)) throw new Error('Only the project owner can hand the project over.');
  const target = (await membersOf(a.projectId)).find((m) => m.user_id === userId);
  if (!target) throw new Error('Not a member.');
  if (target.plan === 'basic') throw new Error('Basic – Free accounts can’t own projects. They need to switch to Pro first.');
  await db().batch([
    db().prepare("UPDATE project_members SET role = 'member' WHERE project_id = ? AND role = 'owner'").bind(a.projectId),
    db().prepare("UPDATE project_members SET role = 'owner', access = 'pro' WHERE project_id = ? AND user_id = ?").bind(a.projectId, userId),
    db().prepare('UPDATE projects SET owner_id = ?, payer_id = ? WHERE id = ?').bind(userId, userId, a.projectId),
  ]);
  await notify([userId], { kind: 'members', projectId: a.projectId, title: `You now own ${await projectName(a.projectId)}`,
    lines: [`${esc(a.user.name || a.user.email || '')} handed the project over to you. You now handle its members and billing.`], link: '/app/settings?tab=plan', button: 'Check billing' }, appOrigin(req));
}

/** Deletes a project with everything in it (data, pictures, audits). */
export async function deleteProject(a: Actor) {
  if (!can.deleteProject(a)) throw new Error('Only the project owner can delete the project.');
  const DB = db(), pid = a.projectId;
  const envs = (await DB.prepare('SELECT id FROM environments WHERE project_id = ?').bind(pid).all<{ id: string }>()).results.map((e) => e.id);
  if (envs.length) {
    const ph = envs.map(() => '?').join(',');
    const keys = (await DB.prepare(`SELECT r2_key FROM snapshots WHERE env_id IN (${ph})`).bind(...envs).all<{ r2_key: string }>()).results.map((r) => r.r2_key);
    for (let i = 0; i < keys.length; i += 500) await bucket()?.delete(keys.slice(i, i + 500));
    const tables = ['clicks', 'pageviews', 'sessions', 'snapshots', 'page_state', 'page_changes', 'site_versions', 'audits', 'notifications'];
    await DB.batch(tables.map((t) => DB.prepare(`DELETE FROM ${t} WHERE env_id IN (${ph})`).bind(...envs)));
  }
  await DB.batch([
    DB.prepare('DELETE FROM environments WHERE project_id = ?').bind(pid),
    DB.prepare('DELETE FROM project_members WHERE project_id = ?').bind(pid),
    DB.prepare('DELETE FROM invitations WHERE project_id = ?').bind(pid),
    DB.prepare('DELETE FROM access_requests WHERE project_id = ?').bind(pid),
    DB.prepare('DELETE FROM projects WHERE id = ?').bind(pid),
  ]);
}

export async function answerRequest(a: Actor, requestId: string, answer: 'pro' | 'basic' | 'decline', req: Request) {
  if (!can.answerRequests(a)) throw new Error('Only the project owner can answer access requests.');
  const r = await db().prepare("SELECT * FROM access_requests WHERE id = ? AND project_id = ? AND status = 'open'").bind(requestId, a.projectId).first<{ id: string; email: string; user_id: string }>();
  if (!r) throw new Error('That request is already answered.');
  if (answer === 'decline') {
    await db().prepare("UPDATE access_requests SET status = 'declined' WHERE id = ?").bind(r.id).run();
    await notify([r.user_id], { kind: 'members', projectId: null, title: 'Your access request was declined', lines: [`The owner of the site you tried to add declined your request.`] }, appOrigin(req));
    return;
  }
  // The requester is already signed in with a verified email (they asked from inside Probe), so add them directly.
  const u = await db().prepare('SELECT id, plan FROM users WHERE id = ? AND email_verified = 1').bind(r.user_id).first<{ id: string; plan: User['plan'] }>();
  if (!u) { await invite(a, r.email, answer, req); }
  else {
    await db().prepare("INSERT INTO project_members (project_id, user_id, access, role, added_by, created) VALUES (?, ?, ?, 'member', ?, ?) ON CONFLICT (project_id, user_id) DO UPDATE SET access = excluded.access")
      .bind(a.projectId, u.id, answer, a.user.id, Date.now()).run();
    const origin = appOrigin(req), name = await projectName(a.projectId);
    await notify([u.id], { kind: 'members', projectId: a.projectId, title: `You now have access to ${name}`, lines: [`${esc(a.user.name || a.user.email || '')} accepted your request. You have <b>${answer === 'pro' ? 'Pro' : 'Basic'}</b> access.`], link: '/app/' }, origin);
    if (billable({ access: answer, plan: u.plan })) await tellSeats(a.projectId, `${esc(r.email)} joined as a Pro member.`, origin);
  }
  await db().prepare("UPDATE access_requests SET status = 'approved' WHERE id = ?").bind(r.id).run();
}
