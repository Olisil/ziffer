// Page snapshots for heatmaps. The tracker asks first (GET) and uploads only when a fresh one is wanted (POST).
import type { APIRoute } from 'astro';
import { db } from '../../lib/server';
import { deviceBucket, envForKey, originAllowed, pathOf, str } from '../../lib/site-env';
import { SNAP_MAX_BYTES, bucket, snapKey, snapshotWanted } from '../../lib/snapshots';

const corsFor = (origin: string | null) => ({ 'Access-Control-Allow-Origin': origin || '*', Vary: 'Origin' });
const num = (v: unknown, min: number, max: number) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : min; };

async function resolve(request: Request, key: unknown) {
  const origin = request.headers.get('Origin');
  const k = str(key, 64);
  if (!k) return { origin, error: 400 } as const;
  const site = await envForKey(k);
  if (!site || site.kind !== 'web') return { origin, error: 404 } as const;
  if (!originAllowed(origin, site.domain)) return { origin, error: 403 } as const;
  if (/bot|crawl|spider|headless|lighthouse/i.test(request.headers.get('User-Agent') || '')) return { origin, error: 204 } as const;
  return { origin, site } as const;
}

export const GET: APIRoute = async ({ request, url }) => {
  const r = await resolve(request, url.searchParams.get('k'));
  const headers = { ...corsFor(r.origin), 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
  if ('error' in r) return new Response('{"need":false}', { status: r.error === 204 ? 200 : r.error, headers });
  const path = pathOf(url.searchParams.get('p'));
  const vwq = Number(url.searchParams.get('vw')) || 0;
  const device = deviceBucket(vwq);
  const need = !!path && vwq >= 240 && (await snapshotWanted(r.site.id, path, device));
  return new Response(JSON.stringify({ need }), { headers });
};

export const POST: APIRoute = async ({ request }) => {
  const cors = corsFor(request.headers.get('Origin'));
  const len = Number(request.headers.get('Content-Length') || 0);
  if (len > SNAP_MAX_BYTES * 1.1) return new Response('too big', { status: 413, headers: cors });
  const text = await request.text();
  if (text.length > SNAP_MAX_BYTES * 1.1) return new Response('too big', { status: 413, headers: cors });
  let body: any;
  try { body = JSON.parse(text); } catch { return new Response('bad json', { status: 400, headers: cors }); }
  const r = await resolve(request, body?.k);
  if ('error' in r) return new Response(null, { status: r.error, headers: cors });
  const path = pathOf(body.p), html = typeof body.html === 'string' ? body.html : '';
  if (!path || html.length < 100 || html.length > SNAP_MAX_BYTES) return new Response('bad', { status: 400, headers: cors });
  if (!(Number(body.vw) >= 240 && Number(body.vh) >= 240)) return new Response('no layout', { status: 400, headers: cors });
  const vw = num(body.vw, 200, 4000), vh = num(body.vh, 200, 4000), dw = num(body.dw, 200, 8000), dh = num(body.dh, 200, 60000);
  const device = deviceBucket(vw);
  // Re-check on write so a snapshot can't be overwritten more often than the freshness window allows.
  if (!(await snapshotWanted(r.site.id, path, device))) return new Response(null, { status: 204, headers: cors });
  const key = await snapKey(r.site.id, device, path);
  await bucket()!.put(key, html, { httpMetadata: { contentType: 'text/html; charset=utf-8' } });
  await db().prepare(
    `INSERT INTO snapshots (env_id, path, device, ts, vw, vh, dw, dh, bytes, r2_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (env_id, path, device) DO UPDATE SET ts = excluded.ts, vw = excluded.vw, vh = excluded.vh, dw = excluded.dw, dh = excluded.dh, bytes = excluded.bytes, r2_key = excluded.r2_key`,
  ).bind(r.site.id, path, device, Date.now(), vw, vh, dw, dh, html.length, key).run();
  return new Response(null, { status: 204, headers: cors });
};

export const OPTIONS: APIRoute = ({ request }) =>
  new Response(null, { status: 204, headers: { ...corsFor(request.headers.get('Origin')), 'Access-Control-Allow-Methods': 'GET, POST', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '86400' } });
