// Visits from the Intus tour viewer. The viewer's page names this address in
// <meta name="intus-stats" content="…/app/api/tour/<site key>"> and posts to …/collect every 15 s and on leaving.
import type { APIRoute } from 'astro';
import { db } from '../../../../lib/server';
import { envForKey, originAllowed } from '../../../../lib/site-env';
import { SID_RE, TOUR_RE } from '../../../../lib/tours';

const MAX_BODY = 120_000;
const corsFor = (origin: string | null) => ({ 'Access-Control-Allow-Origin': origin || '*', Vary: 'Origin' });

export const OPTIONS: APIRoute = ({ request }) => new Response(null, { status: 204, headers: { ...corsFor(request.headers.get('Origin')), 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'Content-Type' } });

export const POST: APIRoute = async ({ request, params }) => {
  const origin = request.headers.get('Origin');
  const cors = corsFor(origin);
  const env = await envForKey(String(params.key || ''));
  if (!env || env.kind !== 'tour') return new Response('unknown key', { status: 404, headers: cors });
  // With a domain set, only the viewer on that site may send visits.
  if (env.domain && !originAllowed(origin, env.domain)) return new Response('forbidden', { status: 403, headers: cors });
  const text = await request.text();
  if (text.length > MAX_BODY) return new Response('too big', { status: 413, headers: cors });
  let d: any;
  try { d = JSON.parse(text); } catch { return new Response('bad json', { status: 400, headers: cors }); }
  if (!d || !TOUR_RE.test(d.tour || '') || !SID_RE.test(d.sid || '')) return new Response('bad', { status: 400, headers: cors });
  const now = Date.now();
  const started = Number.isFinite(d.started) ? Math.min(now, Math.max(now - 864e5, d.started)) : now;
  const dur = Math.max(0, Math.min(86400, Number(d.dur) || 0));
  const device = d.device === 'touch' ? 'touch' : 'desktop';
  const country = ((request as any).cf?.country as string | undefined)?.slice(0, 2) || null;
  const { tour, sid } = d;
  delete d.tour; delete d.sid;
  await db().prepare(`INSERT INTO tour_visits (sid, env_id, tour, started, updated, dur, device, country, data)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
      ON CONFLICT(sid) DO UPDATE SET updated = excluded.updated, dur = MAX(tour_visits.dur, excluded.dur), data = excluded.data
      WHERE tour_visits.env_id = excluded.env_id AND tour_visits.tour = excluded.tour`)
    .bind(sid, env.id, tour, started, now, dur, device, country, JSON.stringify(d)).run();
  return new Response(null, { status: 204, headers: cors });
};
