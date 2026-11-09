// Sends email through Resend (https://resend.com). Without RESEND_API_KEY, mail is skipped and only
// in-app notifications are shown.
import { env } from 'cloudflare:workers';

const cfg = () => ({ key: (env as any).RESEND_API_KEY as string | undefined, from: ((env as any).MAIL_FROM as string | undefined) || 'Probe <probe@nassau.se>' });
export const mailEnabled = () => !!cfg().key;

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** A simple, brand-coloured email: heading, paragraphs, optional button and footer. */
export function layout(o: { title: string; lines: string[]; button?: { text: string; href: string }; footer?: string }) {
  return `<!doctype html><html><body style="margin:0;background:#f4f2ee;font-family:Inter,Segoe UI,Helvetica,Arial,sans-serif;color:#141414">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px">
  <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#fff;border-radius:16px;border:1px solid #e6e3dc">
  <tr><td style="padding:28px 32px 8px"><div style="height:6px;width:56px;border-radius:6px;background:linear-gradient(90deg,#3B78FD,#FFBC40,#FF5238)"></div>
  <p style="margin:18px 0 0;font-size:13px;letter-spacing:.06em;text-transform:uppercase;color:#6b6b6b">Probe</p>
  <h1 style="margin:6px 0 0;font-size:22px;line-height:1.3">${esc(o.title)}</h1></td></tr>
  <tr><td style="padding:8px 32px 8px;font-size:15px;line-height:1.6">${o.lines.map((l) => `<p style="margin:12px 0">${l}</p>`).join('')}</td></tr>
  ${o.button ? `<tr><td style="padding:8px 32px 24px"><a href="${esc(o.button.href)}" style="display:inline-block;background:#141414;color:#fff;text-decoration:none;padding:12px 20px;border-radius:10px;font-weight:600">${esc(o.button.text)}</a></td></tr>` : ''}
  <tr><td style="padding:16px 32px 28px;font-size:12px;color:#8a8a8a;border-top:1px solid #f0eee9">${o.footer ?? 'You get this because of your notification settings in Probe.'} Probe is a service by Nassau, Stockholm.</td></tr>
  </table></td></tr></table></body></html>`;
}
export { esc };

export async function sendMail(to: string | string[], subject: string, html: string) {
  const { key, from } = cfg();
  if (!key) return { skipped: true };
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to: Array.isArray(to) ? to : [to], subject, html }),
  });
  if (!r.ok) console.error('probe: mail failed', r.status, (await r.text()).slice(0, 300));
  return { ok: r.ok };
}
