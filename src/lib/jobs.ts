// Background work without a scheduler: run at most once an hour, piggybacking on incoming visits and
// app page loads (via waitUntil, so nobody waits for it).
//  - count billable Pro seats per project for today
//  - after each full month, invoice the month that ended
//  - daily traffic / rage-click spike checks
//  - weekly email reports
import { db } from './server';
import { billable, prefsOf, type User } from './users';
import { invoiceMonth, getSetting, seatPrice, setSetting, stripeEnabled } from './stripe';
import { notify, projectRecipients } from './notify';
import { layout, mailEnabled, sendMail, esc } from './mail';

const sthlmDay = (t = Date.now()) => new Date(t).toLocaleDateString('sv-SE', { timeZone: 'Europe/Stockholm' }); // YYYY-MM-DD
const sthlmHour = (t = Date.now()) => Number(new Date(t).toLocaleString('en-GB', { hour: '2-digit', hour12: false, timeZone: 'Europe/Stockholm' }));
const weekday = (t = Date.now()) => ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(new Date(t).toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'Europe/Stockholm' }));

export async function runJobs(origin: string, force = false) {
  const last = Number((await getSetting('jobs_last')) || 0);
  if (!force && Date.now() - last < 3600e3) return { skipped: true };
  // Claim the run first so parallel requests don't double up.
  const claim = await db().prepare("UPDATE app_settings SET value = ?, updated = ? WHERE key = 'jobs_last' AND COALESCE(value, '0') = ?")
    .bind(String(Date.now()), Date.now(), String(last || '0')).run();
  if (!claim.meta.changes) {
    if (last) return { skipped: true };
    await setSetting('jobs_last', String(Date.now()));
  }
  const out: Record<string, unknown> = {};
  out.seats = await countSeats().catch((e) => String(e));
  out.invoices = await monthlyInvoices().catch((e) => String(e));
  out.spikes = await spikes(origin).catch((e) => String(e));
  out.weekly = await weeklyReports(origin).catch((e) => String(e));
  return out;
}

/** Today's billable Pro seats for every project (the highest count seen during the day is kept). */
export async function countSeats() {
  const day = sthlmDay();
  const rows = (await db().prepare(
    `SELECT m.project_id, m.access, COALESCE(u.plan, 'pro') AS plan FROM project_members m LEFT JOIN users u ON u.id = m.user_id`,
  ).all<{ project_id: string; access: 'pro' | 'basic'; plan: any }>()).results;
  const per = new Map<string, number>();
  for (const r of rows) if (billable(r)) per.set(r.project_id, (per.get(r.project_id) ?? 0) + 1);
  const stmts = [...per].map(([pid, n]) =>
    db().prepare('INSERT INTO billing_days (project_id, day, seats) VALUES (?, ?, ?) ON CONFLICT (project_id, day) DO UPDATE SET seats = MAX(seats, excluded.seats)').bind(pid, day, n));
  for (let i = 0; i < stmts.length; i += 50) await db().batch(stmts.slice(i, i + 50));
  return per.size;
}

async function monthlyInvoices() {
  if (!stripeEnabled()) return 'stripe off';
  const price = await seatPrice();
  if (!price) return 'no price';
  const now = new Date();
  const prev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 15));
  const month = `${prev.getUTCFullYear()}-${String(prev.getUTCMonth() + 1).padStart(2, '0')}`;
  const projects = (await db().prepare("SELECT DISTINCT project_id FROM billing_days WHERE substr(day, 1, 7) = ? AND seats > 0").bind(month).all<{ project_id: string }>()).results;
  let n = 0;
  for (const p of projects.slice(0, 20)) { if (await invoiceMonth(p.project_id, month, price).catch((e) => { console.error('ziffer: invoice', e); return null; })) n++; }
  return n;
}

/** Yesterday vs the same weekday over the previous four weeks, per environment. */
async function spikes(origin: string) {
  const today = sthlmDay();
  if ((await getSetting('spikes_day')) === today || sthlmHour() < 7) return 'done today';
  await setSetting('spikes_day', today);
  const dayMs = 864e5, end = new Date(`${today}T00:00:00+01:00`).getTime(), start = end - dayMs;
  const rows = (await db().prepare(
    `SELECT e.id, e.name, e.domain, e.project_id,
            SUM(CASE WHEN s.started >= ?1 THEN 1 ELSE 0 END) AS y_sessions,
            SUM(CASE WHEN s.started >= ?1 THEN s.rage ELSE 0 END) AS y_rage,
            SUM(CASE WHEN s.started < ?1 AND ((?1 - s.started) / ?3) % 7 = 6 THEN 1 ELSE 0 END) / 4.0 AS avg_sessions,
            SUM(CASE WHEN s.started < ?1 AND ((?1 - s.started) / ?3) % 7 = 6 THEN s.rage ELSE 0 END) / 4.0 AS avg_rage
       FROM environments e JOIN sessions s ON s.env_id = e.id
      WHERE s.started >= ?1 - 28 * ?3 AND s.started < ?2 GROUP BY e.id`,
  ).bind(start, end, dayMs).all<{ id: string; name: string; domain: string; project_id: string; y_sessions: number; y_rage: number; avg_sessions: number; avg_rage: number }>()).results;
  let sent = 0;
  for (const r of rows) {
    if (r.y_sessions >= 20 && r.y_sessions > Math.max(2 * r.avg_sessions, r.avg_sessions + 15)) {
      await notify(await projectRecipients(r.project_id), { kind: 'traffic', projectId: r.project_id, envId: r.id, title: `Traffic spike on ${r.domain || r.name}`,
        lines: [`Yesterday had <b>${r.y_sessions}</b> sessions — usually around ${Math.round(r.avg_sessions)} on that weekday.`], link: `/app/e/${r.id}?range=7d` }, origin);
      sent++;
    } else if (r.avg_sessions >= 20 && r.y_sessions < r.avg_sessions * 0.4) {
      await notify(await projectRecipients(r.project_id), { kind: 'traffic', projectId: r.project_id, envId: r.id, title: `Traffic drop on ${r.domain || r.name}`,
        lines: [`Yesterday had only <b>${r.y_sessions}</b> sessions — usually around ${Math.round(r.avg_sessions)}. Worth checking the snippet is still on the site.`], link: `/app/e/${r.id}?range=7d` }, origin);
      sent++;
    }
    if (r.y_rage >= 8 && r.y_rage > 3 * r.avg_rage) {
      await notify(await projectRecipients(r.project_id), { kind: 'rage', projectId: r.project_id, envId: r.id, title: `More rage clicks on ${r.domain || r.name}`,
        lines: [`<b>${r.y_rage}</b> rage clicks yesterday, against about ${Math.round(r.avg_rage)} normally. Something may be broken or confusing.`], link: `/app/e/${r.id}/sessions?range=7d&signal=frustrated`, button: 'See the frustrated sessions' }, origin);
      sent++;
    }
  }
  return sent;
}

async function weeklyReports(origin: string) {
  if (!mailEnabled() || sthlmHour() < 7) return 'off';
  const users = (await db().prepare('SELECT * FROM users WHERE email IS NOT NULL AND email_verified = 1 AND (last_weekly IS NULL OR last_weekly < ?)').bind(Date.now() - 6 * 864e5).all<User>()).results;
  let sent = 0;
  for (const u of users.slice(0, 25)) {
    const prefs = prefsOf(u);
    if (!prefs.weekly || !prefs.email || weekday() !== prefs.weeklyDay) continue;
    await db().prepare('UPDATE users SET last_weekly = ? WHERE id = ?').bind(Date.now(), u.id).run();
    const envs = (await db().prepare(
      `SELECT e.id, e.name, e.domain, p.name AS project,
              (SELECT COUNT(*) FROM sessions s WHERE s.env_id = e.id AND s.started >= ?2) AS sessions,
              (SELECT COUNT(*) FROM sessions s WHERE s.env_id = e.id AND s.started >= ?3 AND s.started < ?2) AS prev,
              (SELECT COALESCE(AVG(duration), 0) FROM sessions s WHERE s.env_id = e.id AND s.started >= ?2) AS engagement,
              (SELECT COALESCE(SUM(rage), 0) FROM sessions s WHERE s.env_id = e.id AND s.started >= ?2) AS rage,
              (SELECT COUNT(*) FROM page_changes c WHERE c.env_id = e.id AND c.at >= ?2) AS changes
         FROM environments e JOIN projects p ON p.id = e.project_id JOIN project_members m ON m.project_id = p.id
        WHERE m.user_id = ?1 AND e.kind = 'web' ORDER BY p.name, e.created`,
    ).bind(u.id, Date.now() - 7 * 864e5, Date.now() - 14 * 864e5).all<{ id: string; name: string; domain: string; project: string; sessions: number; prev: number; engagement: number; rage: number; changes: number }>()).results;
    if (!envs.length) continue;
    const rows = envs.map((e) => {
      const d = e.prev ? Math.round(((e.sessions - e.prev) / e.prev) * 100) : null;
      return `<tr><td style="padding:8px 0;border-bottom:1px solid #eee"><b>${esc(e.domain || e.name)}</b><br><span style="color:#888;font-size:12px">${esc(e.project)}</span></td>
        <td align="right" style="padding:8px 0;border-bottom:1px solid #eee"><b>${e.sessions}</b> sessions${d === null ? '' : ` <span style="color:${d >= 0 ? '#22a06b' : '#ff5238'}">${d >= 0 ? '+' : ''}${d}%</span>`}<br>
        <span style="color:#888;font-size:12px">${Math.round(e.engagement)} s engaged · ${e.rage} rage${e.changes ? ` · ${e.changes} page changes` : ''}</span></td></tr>`;
    }).join('');
    await sendMail(u.email!, 'Your week in Ziffer', layout({
      title: 'Your week in Ziffer',
      lines: ['Here is how your sites did over the last 7 days.', `<table width="100%" cellpadding="0" cellspacing="0" style="font-size:14px">${rows}</table>`],
      button: { text: 'Open Ziffer', href: `${origin}/app` },
      footer: 'You get this weekly report because it’s on in Settings → Notifications.',
    }));
    sent++;
  }
  return sent;
}

/** Tell a project's people about a new site version (called after detection). */
export async function tellVersion(envId: string, versionId: string, origin: string) {
  const e = await db().prepare('SELECT e.id, e.name, e.domain, e.project_id FROM environments e WHERE e.id = ?').bind(envId).first<{ id: string; name: string; domain: string; project_id: string }>();
  if (!e) return;
  const n = (await db().prepare('SELECT COUNT(*) AS n FROM site_versions WHERE env_id = ? AND merged_into IS NULL').bind(envId).first<{ n: number }>())?.n ?? 0;
  await notify(await projectRecipients(e.project_id), { kind: 'version', projectId: e.project_id, envId, title: `New version of ${e.domain || e.name}: ${e.name} ${n}.0`,
    lines: [`Ziffer noticed a new layout across <b>${esc(e.domain || e.name)}</b> and started version ${n}.0. Stats, heatmaps and audits are now kept apart from the previous version.`, 'If it wasn’t a real release, merge it back with one click.'],
    link: `/app/e/${envId}/versions#v-${versionId}`, button: 'See the new version' }, origin);
}

/** Tell a project when a page's audit score dropped noticeably. */
export async function tellAuditDrop(envId: string, path: string, before: number, after: number, origin: string) {
  const e = await db().prepare('SELECT id, name, domain, project_id FROM environments WHERE id = ?').bind(envId).first<{ id: string; name: string; domain: string; project_id: string }>();
  if (!e) return;
  await notify(await projectRecipients(e.project_id, 'pro'), { kind: 'auditDrop', projectId: e.project_id, envId, title: `Audit score dropped on ${e.domain}${path}`,
    lines: [`The overall score went from <b>${before}</b> to <b>${after}</b> after the latest change to ${esc(path)}.`, 'The audit shows exactly which checks got worse.'],
    link: `/app/e/${envId}/audits/page?path=${encodeURIComponent(path)}`, button: 'Open the audit' }, origin);
}
