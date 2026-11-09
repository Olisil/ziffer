// One site, one project. A newly added site is reserved for CLAIM_DAYS and confirmed by the first visit
// that arrives through that project's snippet; unconfirmed reservations then lapse so the real owner can add it.
import { db } from './server';

export const CLAIM_DAYS = 7;

export type Conflict = { envId: string; projectId: string; projectName: string; verified: boolean; reservedUntil: number | null; mine: boolean };

/** Returns why `domain` can't be added (or null if it can). Expired, unconfirmed reservations are released here. */
export async function domainConflict(domain: string, userId: string, exceptEnvId: string | null = null): Promise<Conflict | null> {
  const DB = db();
  const rows = (await DB.prepare(
    `SELECT e.id, e.project_id, e.created, e.verified_at, p.name,
            EXISTS (SELECT 1 FROM project_members m WHERE m.project_id = e.project_id AND m.user_id = ?) AS mine
       FROM environments e JOIN projects p ON p.id = e.project_id
      WHERE e.kind = 'web' AND e.domain = ? AND e.id <> COALESCE(?, '')`,
  ).bind(userId, domain, exceptEnvId).all<{ id: string; project_id: string; created: number; verified_at: number | null; name: string; mine: number }>()).results;
  for (const r of rows) {
    const until = r.created + CLAIM_DAYS * 864e5;
    if (!r.verified_at && Date.now() > until && !r.mine) {
      // Lapsed reservation: free the domain (the environment stays, without a domain, so nothing is lost).
      await DB.prepare("UPDATE environments SET domain = NULL, name = name || ' (unconfirmed)' WHERE id = ? AND verified_at IS NULL").bind(r.id).run();
      continue;
    }
    return { envId: r.id, projectId: r.project_id, projectName: r.name, verified: !!r.verified_at, reservedUntil: r.verified_at ? null : until, mine: !!r.mine };
  }
  return null;
}

export function conflictMessage(domain: string, c: Conflict) {
  if (c.mine) return `${domain} is already in your project “${c.projectName}”.`;
  if (c.verified) return `${domain} is already measured in Probe by someone else. You can ask them for access.`;
  const d = new Date(c.reservedUntil!).toLocaleDateString('en-GB', { day: 'numeric', month: 'long' });
  return `${domain} was just added by someone else and is reserved until ${d} while they install the snippet. You can ask them for access — or add it again after that date if they never confirm it.`;
}
