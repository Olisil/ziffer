// In-app notifications, plus email when the person has asked for it.
import { APP_HOME, db } from './server';
import { layout, sendMail, esc } from './mail';
import { prefsOf, type NotifyPrefs, type User } from './users';

export type Kind = 'version' | 'auditDrop' | 'traffic' | 'rage' | 'members' | 'billing' | 'claims' | 'weekly' | 'invite';
const PREF: Record<Kind, keyof NotifyPrefs | null> = { version: 'version', auditDrop: 'auditDrop', traffic: 'traffic', rage: 'rage', members: 'members', billing: 'billing', claims: 'claims', weekly: 'weekly', invite: null };

export function appOrigin(req?: Request) {
  // Links always point at the service's home; only local development uses its own host.
  if (req) { const u = new URL(req.url); if (/^(localhost|127\.0\.0\.1)(:|$)/.test(u.host)) return u.origin; }
  return APP_HOME;
}

export type Note = { kind: Kind; title: string; lines: string[]; link?: string; projectId?: string | null; envId?: string | null; button?: string };

/** Notify people (by user id). In-app always; email when their settings allow it. */
export async function notify(userIds: string[], n: Note, origin: string) {
  if (!userIds.length) return;
  const ids = [...new Set(userIds)];
  const users = (await db().prepare(`SELECT * FROM users WHERE id IN (${ids.map(() => '?').join(',')})`).bind(...ids).all<User>()).results;
  const now = Date.now();
  for (const u of users) {
    const prefs = prefsOf(u), key = PREF[n.kind];
    if (key && prefs[key] === false) continue;
    const wantsMail = prefs.email && !!u.email && !!u.email_verified;
    await db().prepare('INSERT INTO notifications (user_id, project_id, env_id, kind, title, body, link, created, emailed) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(u.id, n.projectId ?? null, n.envId ?? null, n.kind, n.title, n.lines.join('\n').replace(/<[^>]+>/g, ''), n.link ?? null, now, wantsMail ? 1 : 0).run();
    if (wantsMail) {
      await sendMail(u.email!, n.title, layout({ title: n.title, lines: n.lines, button: n.link ? { text: n.button || 'Open in Probe', href: origin + n.link } : undefined }))
        .catch((e) => console.error('probe: notify mail', e));
    }
  }
}

/** Members of a project to tell about something, optionally only Pro (editing) members or only the project owner. */
export async function projectRecipients(projectId: string, who: 'all' | 'pro' | 'owner' = 'all') {
  const cond = who === 'owner' ? "AND role = 'owner'" : who === 'pro' ? "AND access = 'pro'" : '';
  return (await db().prepare(`SELECT user_id FROM project_members WHERE project_id = ? ${cond}`).bind(projectId).all<{ user_id: string }>()).results.map((r) => r.user_id);
}

export { esc };
