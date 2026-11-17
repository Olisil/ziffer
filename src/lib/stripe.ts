// Stripe, used directly over its REST API (no SDK needed in Workers).
//
// How Probe bills: each project saves a card through Stripe Checkout (setup mode). Every day Probe
// notes which paid plan the project is on. After each full month it creates one invoice for the
// days on each plan (days ÷ days in the month × plan price) and Stripe charges the saved card.
import { env } from 'cloudflare:workers';
import { APP_HOME, db } from './server';
import { isPlan, planPrices, PLANS, priceOf, type PlanPrices, type ProjectPlan } from './plans';

export const stripeKey = () => (env as any).STRIPE_SECRET_KEY as string | undefined;
export const stripeEnabled = () => !!stripeKey();
export const stripeTestMode = () => (stripeKey() || '').startsWith('sk_test_');

function form(obj: Record<string, unknown>, prefix = '', out = new URLSearchParams()) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) v.forEach((x, i) => (typeof x === 'object' ? form(x as any, `${key}[${i}]`, out) : out.append(`${key}[${i}]`, String(x))));
    else if (typeof v === 'object') form(v as Record<string, unknown>, key, out);
    else out.append(key, String(v));
  }
  return out;
}

export async function stripe<T = any>(method: 'GET' | 'POST' | 'DELETE', path: string, body?: Record<string, unknown>, idem?: string): Promise<T> {
  const key = stripeKey();
  if (!key) throw new Error('Stripe is not set up (STRIPE_SECRET_KEY is missing).');
  const qs = method === 'GET' && body ? `?${form(body).toString()}` : '';
  const r = await fetch(`https://api.stripe.com/v1/${path}${qs}`, {
    method,
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/x-www-form-urlencoded', ...(idem ? { 'Idempotency-Key': idem } : {}) },
    body: method !== 'GET' && body ? form(body).toString() : undefined,
  });
  const j = (await r.json()) as any;
  if (!r.ok) throw new Error(j?.error?.message || `Stripe ${r.status}`);
  return j as T;
}

/* ---------- Service settings (seat price, webhook secret) ---------- */

export async function getSetting(key: string) {
  return (await db().prepare('SELECT value FROM app_settings WHERE key = ?').bind(key).first<{ value: string }>())?.value ?? null;
}
export async function setSetting(key: string, value: string | null) {
  await db().prepare('INSERT INTO app_settings (key, value, updated) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated = excluded.updated')
    .bind(key, value, Date.now()).run();
}
export type SeatPrice = { amount: number; currency: string }; // amount in the currency's minor unit (öre, cents)
export async function seatPrice(): Promise<SeatPrice | null> {
  const v = await getSetting('seat_price');
  try { return v ? JSON.parse(v) : null; } catch { return null; }
}
export const money = (minor: number, currency: string) =>
  new Intl.NumberFormat(currency === 'sek' ? 'sv-SE' : 'en-GB', { style: 'currency', currency: currency.toUpperCase(), maximumFractionDigits: minor % 100 ? 2 : 0 }).format(minor / 100);

/** Creates (or replaces) the webhook endpoint Probe needs and stores its signing secret. */
export async function installWebhook(origin: string) {
  const old = await getSetting('stripe_webhook_id');
  if (old) await stripe('DELETE', `webhook_endpoints/${old}`).catch(() => null);
  const ep = await stripe('POST', 'webhook_endpoints', {
    url: `${origin}/app/api/stripe/webhook`,
    description: 'Probe billing',
    enabled_events: ['checkout.session.completed', 'invoice.paid', 'invoice.payment_failed', 'customer.deleted'],
  });
  await setSetting('stripe_webhook_id', ep.id);
  await setSetting('stripe_webhook_secret', ep.secret);
  await setSetting('stripe_webhook_url', ep.url);
  return ep.id as string;
}

let webhookChecked = false;
/** Moves an installed webhook to the service's current address (e.g. after the move to probe.nassau.se). */
export async function ensureWebhook() {
  if (webhookChecked || !stripeEnabled()) return 'ok';
  webhookChecked = true;
  if (!(await getSetting('stripe_webhook_id'))) return 'not installed';
  const want = `${APP_HOME}/app/api/stripe/webhook`;
  if ((await getSetting('stripe_webhook_url')) === want) return 'ok';
  await installWebhook(APP_HOME);
  return 'moved';
}

/** Verifies a Stripe-Signature header (HMAC-SHA256 over "timestamp.payload"), tolerating 5 minutes of clock skew. */
export async function verifyWebhook(payload: string, header: string | null) {
  const secret = await getSetting('stripe_webhook_secret');
  if (!secret || !header) return false;
  const parts = Object.fromEntries(header.split(',').map((p) => p.split('=') as [string, string]));
  const t = Number(parts.t), sigs = header.split(',').filter((p) => p.startsWith('v1=')).map((p) => p.slice(3));
  if (!t || Math.abs(Date.now() / 1000 - t) > 300) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${t}.${payload}`));
  const hex = Array.from(new Uint8Array(mac), (b) => b.toString(16).padStart(2, '0')).join('');
  return sigs.some((s) => s.length === hex.length && [...s].every((c, i) => c === hex[i]));
}

/**
 * Test and live mode are separate worlds in Stripe: customers and webhooks made in one don't exist in the other.
 * When the secret key changes mode, forget the saved customers and card status and install a fresh webhook.
 * Returns a note for the admin when something was reset.
 */
export async function syncStripeMode(origin: string): Promise<string | null> {
  if (!stripeEnabled()) return null;
  const now = stripeTestMode() ? 'test' : 'live', was = await getSetting('stripe_mode');
  if (was === now) return null;
  await setSetting('stripe_mode', now);
  if (!was && now === 'test') return null;                       // first run on a test key: nothing to reset
  await db().prepare('UPDATE projects SET stripe_customer = NULL, billing_status = NULL').run();
  await db().prepare("DELETE FROM app_settings WHERE key IN ('stripe_webhook_id', 'stripe_webhook_secret', 'stripe_webhook_url')").run();
  await installWebhook(origin);
  return `Stripe is now in ${now} mode. Saved cards from ${now === 'live' ? 'test' : 'live'} mode were cleared and the webhook was installed again.`;
}

/* ---------- Project billing ---------- */

export async function checkoutForProject(p: { id: string; name: string; stripe_customer?: string | null }, payer: { email: string | null; name: string | null }, origin: string) {
  let customer = p.stripe_customer;
  if (!customer) {
    const c = await stripe('POST', 'customers', { email: payer.email ?? undefined, name: payer.name ?? undefined, description: `Probe project ${p.name}`, metadata: { ziffer_project: p.id } });
    customer = c.id as string;
    await db().prepare('UPDATE projects SET stripe_customer = ? WHERE id = ?').bind(customer, p.id).run();
  }
  const s = await stripe('POST', 'checkout/sessions', {
    mode: 'setup', customer, currency: (await planPrices()).currency,
    success_url: `${origin}/app/p/${p.id}/settings?ok=${encodeURIComponent('Card saved')}#plan`,
    cancel_url: `${origin}/app/p/${p.id}/settings#plan`,
    metadata: { ziffer_project: p.id }, setup_intent_data: { metadata: { ziffer_project: p.id } },
  });
  return s.url as string;
}

export async function portalForProject(customer: string, origin: string) {
  const s = await stripe('POST', 'billing_portal/sessions', { customer, return_url: `${origin}/app/settings?tab=plan` });
  return s.url as string;
}

export async function handleEvent(evt: any) {
  const o = evt.data?.object ?? {};
  const DB = db();
  if (evt.type === 'checkout.session.completed' && o.mode === 'setup') {
    const pid = o.metadata?.ziffer_project;
    if (!pid) return;
    const si = await stripe('GET', `setup_intents/${o.setup_intent}`);
    if (si.payment_method) await stripe('POST', `customers/${o.customer}`, { invoice_settings: { default_payment_method: si.payment_method } });
    await DB.prepare("UPDATE projects SET stripe_customer = ?, billing_status = 'active' WHERE id = ?").bind(o.customer, pid).run();
  } else if (evt.type === 'invoice.paid' || evt.type === 'invoice.payment_failed') {
    const pid = o.metadata?.ziffer_project;
    if (!pid) return;
    const ok = evt.type === 'invoice.paid';
    await DB.batch([
      DB.prepare('UPDATE billing_invoices SET status = ? WHERE stripe_invoice = ?').bind(ok ? 'paid' : 'failed', o.id),
      DB.prepare('UPDATE projects SET billing_status = ? WHERE id = ?').bind(ok ? 'active' : 'past_due', pid),
    ]);
    if (!ok) {
      const { notify, projectRecipients } = await import('./notify');
      await notify(await projectRecipients(pid, 'owner'), {
        kind: 'billing', projectId: pid, title: 'A Probe payment failed',
        lines: [`Stripe couldn’t charge the card for last month’s plan (${o.amount_due ? (o.amount_due / 100).toFixed(2) + ' ' + String(o.currency).toUpperCase() : ''}).`, 'Update the card to keep editing the project. Viewing still works.'],
        link: '/app/settings?tab=plan', button: 'Update the card',
      }, APP_HOME);
    }
  } else if (evt.type === 'customer.deleted') {
    await DB.prepare("UPDATE projects SET stripe_customer = NULL, billing_status = NULL WHERE stripe_customer = ?").bind(o.id).run();
  }
}

/** Invoice one project for one finished month (idempotent per project and month): each day on a paid plan costs that plan's price ÷ days in the month. */
export async function invoiceMonth(projectId: string, month: string, prices: PlanPrices) {
  const DB = db();
  const done = await DB.prepare('SELECT 1 FROM billing_invoices WHERE project_id = ? AND month = ?').bind(projectId, month).first();
  if (done) return null;
  const p = await DB.prepare('SELECT id, name, stripe_customer, billing_status FROM projects WHERE id = ?').bind(projectId).first<{ id: string; name: string; stripe_customer: string | null; billing_status: string | null }>();
  const days = (await DB.prepare("SELECT plan, COUNT(*) AS n FROM billing_days WHERE project_id = ? AND substr(day, 1, 7) = ? AND plan IS NOT NULL GROUP BY plan").bind(projectId, month).all<{ plan: string; n: number }>()).results.filter((d) => isPlan(d.plan) && d.plan !== 'free');
  const [y, m] = month.split('-').map(Number);
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const planDays = days.reduce((a, d) => a + d.n, 0);
  const amount = Math.round(days.reduce((a, d) => a + (Math.min(d.n, daysInMonth) / daysInMonth) * priceOf(prices, d.plan as ProjectPlan), 0));
  const record = (amt: number, status: string, invoice: string | null = null) =>
    DB.prepare('INSERT OR IGNORE INTO billing_invoices (project_id, month, seat_days, amount, currency, stripe_invoice, status, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(projectId, month, planDays, amt, prices.currency, invoice, status, Date.now()).run();
  if (!p || amount <= 0) { await record(0, 'nothing'); return null; }
  // A customer is created when checkout opens; only a finished checkout (active) or a failed charge (past_due) means a card was saved.
  if (!p.stripe_customer || !p.billing_status) { await record(amount, 'no_card'); return null; }
  const monthName = new Date(Date.UTC(y, m - 1, 15)).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
  const what = days.map((d) => `${PLANS[d.plan as ProjectPlan].name} for ${d.n} of ${daysInMonth} days`).join(', ');
  const inv = await stripe('POST', 'invoices', {
    customer: p.stripe_customer, collection_method: 'charge_automatically', auto_advance: true, pending_invoice_items_behavior: 'exclude',
    description: `Probe for ${p.name}, ${monthName}`, metadata: { ziffer_project: projectId, ziffer_month: month },
  }, `zinv-${projectId}-${month}`);
  await stripe('POST', 'invoiceitems', { customer: p.stripe_customer, invoice: inv.id, amount, currency: prices.currency, description: `${monthName}: ${what}` }, `zitem-${projectId}-${month}`);
  await stripe('POST', `invoices/${inv.id}/finalize`, { auto_advance: true }, `zfin-${projectId}-${month}`);
  await record(amount, 'open', inv.id);
  return inv.id as string;
}
