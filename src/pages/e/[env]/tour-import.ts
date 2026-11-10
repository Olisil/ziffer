// Brings earlier tour visits into Probe from the Intus statistics service.
// The browser drives it step by step: sign in (the password passes through once and is never stored), then one page of visits at a time.
import type { APIRoute } from 'astro';
import { envForApi } from '../../../lib/page';
import { db } from '../../../lib/server';
import { SID_RE, TOUR_RE } from '../../../lib/tours';

const PAGE = 40;
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

/** Only public https addresses: this server fetches whatever is typed here. */
function sourceOf(raw: unknown): string | null {
  try {
    const u = new URL(String(raw || '').trim());
    const h = u.hostname;
    if (import.meta.env.DEV && h === 'localhost') return u.origin;
    if (u.protocol !== 'https:' || u.username || u.port || !h.includes('.') || /^[\d.]+$/.test(h) || h.includes(':') || /(^|\.)(localhost|local|internal)$/.test(h)) return null;
    return u.origin;
  } catch { return null; }
}
const ask = async (url: string, init: RequestInit = {}) => {
  const res = await fetch(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(20000) });
  const body: any = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, body };
};

export const POST: APIRoute = async (ctx) => {
  const origin = ctx.request.headers.get('Origin');
  if (origin && origin !== ctx.url.origin) return json({ error: 'Wrong origin.' }, 403);
  const r = await envForApi(ctx, true);
  if ('error' in r) return r.error;
  const env = r.env;
  if (env.kind !== 'tour') return json({ error: 'Not a tour environment.' }, 400);
  const b: any = await ctx.request.json().catch(() => null);
  const base = sourceOf(b?.base);
  if (!b || !base) return json({ error: 'Enter the https address of Intus statistics.' }, 400);
  try {
    if (b.step === 'login') {
      const login = await ask(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: String(b.email || ''), password: String(b.password || '') }) });
      if (!login.ok || !login.body.token) return json({ error: login.body.error || 'The sign-in was refused.' }, login.status === 429 ? 429 : 400);
      const tours = await ask(`${base}/api/tours`, { headers: { authorization: `Bearer ${login.body.token}` } });
      if (!tours.ok) return json({ error: tours.body.error || 'Could not list the tours.' }, 400);
      const list = (Array.isArray(tours.body.tours) ? tours.body.tours : []).filter((t: any) => TOUR_RE.test(t?.tour || '') && t.visits > 0).map((t: any) => t.tour);
      return json({ token: login.body.token, tours: list });
    }
    if (b.step === 'page') {
      const tour = String(b.tour || ''), offset = Math.max(0, Number(b.offset) | 0);
      if (!TOUR_RE.test(tour) || typeof b.token !== 'string' || b.token.length > 600) return json({ error: 'Bad request.' }, 400);
      const page = await ask(`${base}/api/sessions?tour=${tour}&limit=${PAGE}&offset=${offset}`, { headers: { authorization: `Bearer ${b.token}` } });
      if (!page.ok) return json({ error: page.body.error || 'Could not read the visits.' }, 400);
      const rows: any[] = Array.isArray(page.body.sessions) ? page.body.sessions : [];
      const now = Date.now();
      const stmts = rows.filter((s) => SID_RE.test(s?.sid || '') && Number.isFinite(s.started)).map((s) => {
        const data = JSON.stringify(s.data && typeof s.data === 'object' ? s.data : {});
        return db().prepare('INSERT OR IGNORE INTO tour_visits (sid, env_id, tour, started, updated, dur, device, country, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .bind(s.sid, env.id, tour, Math.min(now, s.started), now, Math.max(0, Math.min(86400, Number(s.dur) || 0)), s.device === 'touch' ? 'touch' : 'desktop',
            typeof s.country === 'string' ? s.country.slice(0, 2) : null, data.length > 200_000 ? '{}' : data);
      });
      let added = 0;
      if (stmts.length) for (const res of await db().batch(stmts)) added += res.meta.changes || 0;
      return json({ read: rows.length, added, more: !!page.body.more || rows.length === PAGE });
    }
    return json({ error: 'Bad request.' }, 400);
  } catch (e: any) {
    return json({ error: `Intus statistics didn’t answer (${String(e?.message || e).slice(0, 120)}).` }, 502);
  }
};
