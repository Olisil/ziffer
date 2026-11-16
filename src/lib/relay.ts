// The switch to Nassau's own Cloudflare account keeps the public address (probe.nassau.se/app).
// The Webflow Cloud deployment stops doing the work itself and hands every request on to the EU deployment,
// which answers as if it had been asked directly. Both sides share the secret PROBE_RELAY_KEY.
//
// On the Webflow Cloud side, the variable PROBE_RELAY decides:
//   (unset)  nothing is handed on
//   try      only browsers carrying the cookie probe-relay=1 are handed on (for testing)
//   on       everything is handed on
// The EU deployment never sets PROBE_RELAY; it only checks the key to trust the visitor details sent along.
import { env } from 'cloudflare:workers';
import { BASE } from './server';

const UPSTREAM = 'https://probe-app.oliver-44b.workers.dev';
const KEY_HEADER = 'x-probe-relay-key';
const OURS = [KEY_HEADER, 'x-probe-ip', 'x-probe-country'];

const relayKey = () => { const k = String((env as any).PROBE_RELAY_KEY || '').trim(); return k.length >= 24 ? k : null; };
const upstream = () => String((env as any).PROBE_UPSTREAM || UPSTREAM).replace(/\/+$/, '');
const mode = () => String((env as any).PROBE_RELAY || '').trim().toLowerCase();

/** True when this request was handed on by the public deployment (the key matches). */
export function relayed(req: Request) {
  const k = relayKey(); const given = req.headers.get(KEY_HEADER);
  if (!k || !given || given.length !== k.length) return false;
  let d = 0; for (let i = 0; i < k.length; i++) d |= k.charCodeAt(i) ^ given.charCodeAt(i);
  return d === 0;
}

/** The visitor's address and country: sent along by the public deployment, or read from this one's own edge. */
export function visitorOf(req: Request) {
  if (relayed(req)) return { ip: req.headers.get('x-probe-ip') || '', country: (req.headers.get('x-probe-country') || '').slice(0, 2) || null };
  return {
    ip: req.headers.get('CF-Connecting-IP') || req.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() || '',
    country: (((req as any).cf?.country as string | undefined) || req.headers.get('CF-IPCountry') || '').slice(0, 2) || null,
  };
}

/** Should this request be handed on? The data export stays here, so the EU side can still fetch what arrived before the switch. */
export function shouldRelay(req: Request, u: URL) {
  const m = mode();
  if ((m !== 'on' && m !== 'try') || !relayKey() || req.headers.has(KEY_HEADER)) return false;
  if (u.pathname === `${BASE}/api/migrate/export`) return false;
  if (m === 'try') return /(?:^|;\s*)probe-relay=1(?:;|$)/.test(req.headers.get('Cookie') || '');
  return true;
}

export async function relay(req: Request, u: URL): Promise<Response> {
  const headers = new Headers(req.headers);
  for (const h of OURS) headers.delete(h);
  const host = (req.headers.get('X-Forwarded-Host') || req.headers.get('Host') || u.host).split(',')[0].trim();
  const v = visitorOf(req);
  headers.set(KEY_HEADER, relayKey()!);
  headers.set('X-Forwarded-Host', host);
  headers.set('X-Forwarded-Proto', 'https');
  if (v.ip) headers.set('x-probe-ip', v.ip);
  if (v.country) headers.set('x-probe-country', v.country);
  headers.delete('Host');
  const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await req.arrayBuffer();
  try {
    const res = await fetch(`${upstream()}${u.pathname}${u.search}`, { method: req.method, headers, body, redirect: 'manual' });
    const out = new Response(res.body, res);
    out.headers.set('x-probe-relayed', '1');
    return out;
  } catch {
    return new Response('Probe is briefly unavailable. Please try again in a moment.', { status: 502, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'retry-after': '10' } });
  }
}
