// People and plans.
//
// Plans (per person):
//   owner     the service owner (Nassau) — recognised by a verified email in ZIFFER_OWNER_EMAILS
//   pro_free  Pro without payment, granted by the service owner
//   pro       can create projects; Pro seats are paid by each project
//   basic     free, read-only in projects they are invited to; can't create projects
// Inside a project each member has access 'pro' (edit) or 'basic' (read), and one member is the project owner.
import { env } from 'cloudflare:workers';
import type { APIContext, AstroGlobal } from 'astro';
import { db, ownerId } from './server';

export type Plan = 'owner' | 'pro_free' | 'pro' | 'basic';
export type User = { id: string; email: string | null; email_verified: number; name: string | null; image_url: string | null; plan: Plan; notify: string | null; created: number; last_seen: number | null; synced: number | null; lang?: string | null };
export type Access = 'pro' | 'basic';
export type Member = { project_id: string; user_id: string; access: Access; role: 'owner' | 'member'; created: number; email: string | null; name: string | null; image_url: string | null; plan: Plan };

export const PLAN_LABEL: Record<Plan, string> = { owner: 'Owner', pro_free: 'Pro – Free', pro: 'Pro', basic: 'Basic – Free' };
export const canCreateProjects = (u: Pick<User, 'plan'>) => u.plan !== 'basic';
/** A Pro member costs the project money unless the person has a free plan. */
export const billable = (m: { access: Access; plan: Plan }) => m.access === 'pro' && (m.plan === 'pro' || m.plan === 'basic');

const ownerEmails = () =>
  String((env as any).ZIFFER_OWNER_EMAILS || 'oliver@nassau.se').toLowerCase().split(/[,\s]+/).filter(Boolean);
export const isOwnerEmail = (email: string | null | undefined, verified: boolean) => !!email && verified && ownerEmails().includes(email.toLowerCase());

export type NotifyPrefs = {
  weekly: boolean; weeklyDay: number;      // weekly report by email (0 = Sunday … 1 = Monday)
  version: boolean; auditDrop: boolean; traffic: boolean; rage: boolean;
  members: boolean; billing: boolean; claims: boolean;
  email: boolean;                          // send by email as well as in the app
};
export const DEFAULT_NOTIFY: NotifyPrefs = { weekly: true, weeklyDay: 1, version: true, auditDrop: true, traffic: false, rage: true, members: true, billing: true, claims: true, email: true };
export const prefsOf = (u: Pick<User, 'notify'> | null): NotifyPrefs => {
  try { return { ...DEFAULT_NOTIFY, ...(u?.notify ? JSON.parse(u.notify) : {}) }; } catch { return DEFAULT_NOTIFY; }
};

/**
 * The signed-in person, created or refreshed from Clerk at most every 30 minutes.
 * Also turns accepted-by-email invitations into memberships the first time someone signs in.
 */
export async function me(ctx: APIContext | AstroGlobal): Promise<User | null> {
  const uid = ownerId(ctx);
  if (!uid) return null;
  const cached = (ctx.locals as any).__me as User | undefined;
  if (cached) return cached;
  const DB = db();
  let u = await DB.prepare('SELECT * FROM users WHERE id = ?').bind(uid).first<User>();
  const now = Date.now();
  if (!u || !u.synced || now - u.synced > 30 * 60e3) {
    let email: string | null = u?.email ?? null, verified = !!u?.email_verified, name = u?.name ?? null, image = u?.image_url ?? null;
    if (import.meta.env.DEV && (env as any).ZIFFER_DEV_USER) {
      email = uid === (env as any).ZIFFER_DEV_USER && (env as any).ZIFFER_DEV_EMAIL ? (env as any).ZIFFER_DEV_EMAIL : `${uid}@example.dev`; verified = true; name = name || uid;
    } else {
      const cu = await (ctx.locals as any).currentUser?.().catch(() => null);
      if (cu) {
        const primary = cu.emailAddresses?.find((e: any) => e.id === cu.primaryEmailAddressId) ?? cu.emailAddresses?.[0];
        email = primary?.emailAddress?.toLowerCase() ?? null;
        verified = primary?.verification?.status === 'verified';
        name = [cu.firstName, cu.lastName].filter(Boolean).join(' ') || cu.username || email;
        image = cu.imageUrl ?? null;
      }
    }
    const ownerNow = isOwnerEmail(email, verified);
    if (!u && email && verified) {
      // Same verified email under a new sign-in id: the sign-in service changed (e.g. Clerk development → production)
      // or the account was recreated. A verified address is unique per sign-in instance, so carry everything over.
      const old = await DB.prepare('SELECT id FROM users WHERE email = ? AND email_verified = 1 AND id <> ? ORDER BY last_seen DESC LIMIT 1').bind(email, uid).first<{ id: string }>();
      if (old) {
        await DB.batch([
          DB.prepare('UPDATE users SET id = ? WHERE id = ?').bind(uid, old.id),
          DB.prepare('UPDATE project_members SET user_id = ? WHERE user_id = ?').bind(uid, old.id),
          DB.prepare('UPDATE project_members SET added_by = ? WHERE added_by = ?').bind(uid, old.id),
          DB.prepare('UPDATE projects SET owner_id = ? WHERE owner_id = ?').bind(uid, old.id),
          DB.prepare('UPDATE projects SET payer_id = ? WHERE payer_id = ?').bind(uid, old.id),
          DB.prepare('UPDATE invitations SET invited_by = ? WHERE invited_by = ?').bind(uid, old.id),
          DB.prepare('UPDATE invitations SET accepted_by = ? WHERE accepted_by = ?').bind(uid, old.id),
          DB.prepare('UPDATE access_requests SET user_id = ? WHERE user_id = ?').bind(uid, old.id),
          DB.prepare('UPDATE notifications SET user_id = ? WHERE user_id = ?').bind(uid, old.id),
        ]);
        u = await DB.prepare('SELECT * FROM users WHERE id = ?').bind(uid).first<User>();
      }
    }
    if (!u) {
      // New people: an invitation from the service owner sets their plan; otherwise they start as Pro.
      const inv = email ? await DB.prepare('SELECT plan FROM invitations WHERE email = ? AND plan IS NOT NULL AND revoked = 0 AND accepted_at IS NULL AND expires > ? ORDER BY created DESC LIMIT 1').bind(email, now).first<{ plan: Plan }>() : null;
      const plan: Plan = ownerNow ? 'owner' : inv?.plan ?? 'pro';
      await DB.prepare('INSERT OR IGNORE INTO users (id, email, email_verified, name, image_url, plan, created, last_seen, synced) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(uid, email, verified ? 1 : 0, name, image, plan, now, now, now).run();
      if (inv && email) await DB.prepare('UPDATE invitations SET accepted_by = ?, accepted_at = ? WHERE email = ? AND plan IS NOT NULL AND project_id IS NULL AND accepted_at IS NULL').bind(uid, now, email).run();
    } else {
      const plan: Plan = ownerNow ? 'owner' : u.plan === 'owner' ? 'pro_free' : u.plan; // losing the owner email demotes safely
      await DB.prepare('UPDATE users SET email = ?, email_verified = ?, name = ?, image_url = ?, plan = ?, last_seen = ?, synced = ? WHERE id = ?')
        .bind(email, verified ? 1 : 0, name, image, plan, now, now, uid).run();
    }
    u = (await DB.prepare('SELECT * FROM users WHERE id = ?').bind(uid).first<User>())!;
  } else if (!u.last_seen || now - u.last_seen > 5 * 60e3) {
    await DB.prepare('UPDATE users SET last_seen = ? WHERE id = ?').bind(now, uid).run();
  }
  (ctx.locals as any).__me = u;
  return u;
}

export const isServiceOwner = (u: User | null) => !!u && u.plan === 'owner' && !!u.email_verified;

export async function membersOf(projectId: string) {
  return (await db().prepare(
    `SELECT m.*, u.email, u.name, u.image_url, COALESCE(u.plan, 'pro') AS plan FROM project_members m LEFT JOIN users u ON u.id = m.user_id
      WHERE m.project_id = ? ORDER BY m.role = 'owner' DESC, m.created`,
  ).bind(projectId).all<Member>()).results;
}

export async function membership(projectId: string, userId: string) {
  return db().prepare('SELECT * FROM project_members WHERE project_id = ? AND user_id = ?').bind(projectId, userId).first<{ access: Access; role: 'owner' | 'member' }>();
}
