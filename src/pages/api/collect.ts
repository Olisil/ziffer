import type { APIRoute } from 'astro';
import { db } from '../../lib/server';
import { envForKey, originAllowed, pathOf, str } from '../../lib/site-env';
import { browserOf, osOf } from '../../lib/ua';
import { isHash, observe } from '../../lib/versions';
import { queueAudit, runPendingAudits } from '../../lib/audit';

const MAX_BODY = 64 * 1024;
const MAX_EVENTS = 200;
const ID_RE = /^[a-f0-9]{24}$/;

async function dailySalt() {
  const day = new Date().toISOString().slice(0, 10);
  let row = await db().prepare('SELECT salt FROM salts WHERE day = ?').bind(day).first<{ salt: string }>();
  if (!row) {
    const salt = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
    await db().batch([
      db().prepare('INSERT OR IGNORE INTO salts (day, salt) VALUES (?, ?)').bind(day, salt),
      db().prepare('DELETE FROM salts WHERE day < ?').bind(new Date(Date.now() - 2 * 864e5).toISOString().slice(0, 10)),
    ]);
    row = await db().prepare('SELECT salt FROM salts WHERE day = ?').bind(day).first<{ salt: string }>();
  }
  return row!.salt;
}

async function visitorHash(salt: string, ip: string, ua: string, env: string) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${salt}|${ip}|${ua}|${env}`));
  return Array.from(new Uint8Array(buf).slice(0, 10), (b) => b.toString(16).padStart(2, '0')).join('');
}

const deviceOf = (vw: number) => (vw < 768 ? 'mobile' : vw < 1024 ? 'tablet' : 'desktop');
const num = (v: unknown, min: number, max: number, dflt = 0) => { const n = Number(v); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt; };

export const POST: APIRoute = async ({ request, locals }) => {
  const origin = request.headers.get('Origin');
  const cors = { 'Access-Control-Allow-Origin': origin || '*', Vary: 'Origin' };
  const text = await request.text();
  if (text.length > MAX_BODY) return new Response('too big', { status: 413, headers: cors });
  let body: any;
  try { body = JSON.parse(text); } catch { return new Response('bad json', { status: 400, headers: cors }); }
  const key = str(body?.k, 64), sid = str(body?.sid, 64);
  if (!key || !sid || !ID_RE.test(sid) || !Array.isArray(body.ev)) return new Response('bad', { status: 400, headers: cors });
  const env = await envForKey(key);
  if (!env || env.kind !== 'web') return new Response('unknown site', { status: 404, headers: cors });
  if (!originAllowed(origin, env.domain)) return new Response('origin not allowed', { status: 403, headers: cors });

  const now = Date.now();
  const ip = request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() || '';
  const ua = request.headers.get('User-Agent') || '';
  if (/bot|crawl|spider|slurp|headless|lighthouse/i.test(ua)) return new Response(null, { status: 204, headers: cors });
  const country = ((request as any).cf?.country as string | undefined)?.slice(0, 2) || null;
  const DB = db();
  const stmts: D1PreparedStatement[] = [];
  let visitor: string | null = null;
  const clampTs = (t: unknown) => num(t, now - 864e5, now, now);
  const fps: { pvId: string; path: string; device: string; s: string; t: string; c: string; ts: number }[] = [];

  for (const e of body.ev.slice(0, MAX_EVENTS)) {
    if (!e || typeof e !== 'object') continue;
    const pvId = str(e.id, 64);
    if (!pvId || !ID_RE.test(pvId)) continue;
    if (e.t === 'pv') {
      const path = pathOf(e.p); if (!path) continue;
      const vw = num(e.vw, 0, 10000), ts = clampTs(e.ts);
      visitor ??= await visitorHash(await dailySalt(), ip, ua, env.id);
      const ref = str(e.r, 120) || null;
      stmts.push(
        DB.prepare(`INSERT INTO sessions (id, env_id, visitor, started, last_seen, pageviews, device, country, referrer, entry_path, exit_path, browser, os)
                    VALUES (?1, ?2, ?3, ?4, ?4, 0, ?5, ?6, ?7, ?8, ?8, ?9, ?10) ON CONFLICT(id) DO NOTHING`)
          .bind(sid, env.id, visitor, ts, deviceOf(vw), country, ref, path, browserOf(ua), osOf(ua)),
        DB.prepare(`INSERT OR IGNORE INTO pageviews (id, session_id, env_id, path, title, ts, vw, vh, dw, dh)
                    SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10 WHERE EXISTS (SELECT 1 FROM sessions WHERE id = ?2 AND env_id = ?3)`)
          .bind(pvId, sid, env.id, path, str(e.ti, 140), ts, vw, num(e.vh, 0, 10000), num(e.dw, 0, 20000), num(e.dh, 0, 200000)),
        DB.prepare(`UPDATE sessions SET pageviews = (SELECT COUNT(*) FROM pageviews WHERE session_id = ?1), exit_path = ?3, last_seen = MAX(last_seen, ?4)
                    WHERE id = ?1 AND env_id = ?2`).bind(sid, env.id, path, ts),
      );
    } else if (e.t === 'end') {
      stmts.push(
        DB.prepare(`UPDATE pageviews SET duration = MAX(duration, ?1), scroll = MAX(scroll, ?2), dh = COALESCE(?3, dh)
                    WHERE id = ?4 AND session_id = ?5 AND env_id = ?6`)
          .bind(num(e.dur, 0, 86400), num(e.sc, 0, 100), e.dh ? num(e.dh, 0, 200000) : null, pvId, sid, env.id),
        DB.prepare(`UPDATE sessions SET duration = (SELECT COALESCE(SUM(duration), 0) FROM pageviews WHERE session_id = ?1), last_seen = ?3
                    WHERE id = ?1 AND env_id = ?2`).bind(sid, env.id, now),
      );
    } else if (e.t === 'c') {
      const path = pathOf(e.p); if (!path) continue;
      const rage = e.rg ? 1 : 0, dead = e.dc && !rage ? 1 : 0;
      stmts.push(
        DB.prepare(`INSERT INTO clicks (session_id, env_id, path, ts, xr, y, vw, dw, dh, sel, rage, dead)
                    SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12 WHERE EXISTS (SELECT 1 FROM sessions WHERE id = ?1 AND env_id = ?2)`)
          .bind(sid, env.id, path, clampTs(e.ts), num(e.xr, 0, 1), num(e.y, 0, 200000), num(e.vw, 0, 10000), num(e.dw, 0, 20000), num(e.dh, 0, 200000), str(e.s, 200), rage, dead),
      );
      if (rage) stmts.push(DB.prepare('UPDATE sessions SET rage = rage + 1 WHERE id = ? AND env_id = ?').bind(sid, env.id));
      if (dead) stmts.push(DB.prepare('UPDATE sessions SET dead = dead + 1 WHERE id = ? AND env_id = ?').bind(sid, env.id));
    } else if (e.t === 'fp') {
      const path = pathOf(e.p);
      if (!path || !isHash(e.s, 16) || !isHash(e.tp, 16) || !isHash(e.c, 8) || fps.length >= 3) continue;
      fps.push({ pvId, path, device: num(e.vw, 0, 10000) < 768 ? 'mobile' : 'desktop', s: e.s, t: e.tp, c: e.c, ts: clampTs(e.ts) });
    }
  }
  if (stmts.length) await DB.batch(stmts);
  if (fps.length) {
    // Layout bookkeeping runs after the response; it never slows down the visitor.
    const work = (async () => {
      for (const f of fps) {
        const real = await DB.prepare('SELECT 1 FROM pageviews WHERE id = ? AND session_id = ? AND env_id = ? AND path = ?').bind(f.pvId, sid, env.id, f.path).first();
        if (!real) continue;
        const r = await observe(env.id, f.path, f.device, f, f.ts);
        if (r.first) await queueAudit(env.id, f.path, 'first');
        else if (r.changed) await queueAudit(env.id, f.path, r.newVersion ? 'version' : r.changed.kind, r.newVersion);
      }
      await runPendingAudits(env.id, 1);
    })().catch((err) => console.error('ziffer: fingerprint', err));
    const ctx = (locals as any).cfContext as ExecutionContext | undefined;
    if (ctx?.waitUntil) ctx.waitUntil(work); else await work;
  }
  return new Response(null, { status: 204, headers: cors });
};

export const OPTIONS: APIRoute = ({ request }) =>
  new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': request.headers.get('Origin') || '*', 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '86400' } });
