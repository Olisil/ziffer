// Installation test for the snippet: looks for it in the site's HTML and reports the first visit recorded after `since`.
import type { APIRoute } from 'astro';
import { envForApi } from '../../../lib/page';
import { db } from '../../../lib/server';

const json = (o: unknown) => new Response(JSON.stringify(o), { headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

async function scanHtml(domain: string, key: string) {
  const target = `https://${domain.replace(/^https?:\/\//, '').replace(/\/.*$/, '')}/`;
  try {
    const res = await fetch(target, { redirect: 'follow', headers: { 'user-agent': 'ProbeInstallCheck/1.0 (+https://probe.nassau.se)', accept: 'text/html' }, signal: AbortSignal.timeout(8000) });
    const html = (await res.text()).slice(0, 3_000_000);
    const tags = [...html.matchAll(/<script\b[^>]*\bsrc=["']([^"']*\/z\.js)["'][^>]*>/gi)];
    const keys = tags.map((m) => /data-site=["']([^"']+)["']/i.exec(m[0])?.[1] ?? null);
    return {
      url: res.url || target, status: res.status,
      found: tags.length > 0, keyMatches: keys.includes(key), otherKeys: keys.filter((k) => k && k !== key),
      count: tags.length, inHead: tags.length > 0 && html.search(/<\/head>/i) > html.search(/\/z\.js/i),
    };
  } catch (e: any) {
    return { url: target, status: 0, found: false, keyMatches: false, otherKeys: [], count: 0, inHead: false, error: String(e?.message || e).slice(0, 160) };
  }
}

export const GET: APIRoute = async (ctx) => {
  const r = await envForApi(ctx, false);
  if ('error' in r) return r.error;
  const env = r.env;
  const since = Number(ctx.url.searchParams.get('since')) || Date.now() - 120e3;
  const [hit, refused, html] = await Promise.all([
    db().prepare('SELECT v.ts, v.path, s.device, s.browser FROM pageviews v JOIN sessions s ON s.id = v.session_id WHERE v.env_id = ? AND v.ts >= ? ORDER BY v.ts DESC LIMIT 1').bind(env.id, since).first<{ ts: number; path: string; device: string; browser: string }>(),
    db().prepare('SELECT value, updated FROM app_settings WHERE key = ? AND updated >= ?').bind(`refused:${env.id}`, since).first<{ value: string; updated: number }>(),
    ctx.url.searchParams.get('html') === '1' && env.domain ? scanHtml(env.domain, env.site_key) : Promise.resolve(null),
  ]);
  return json({ domain: env.domain, hit, refused: refused?.value ?? null, html });
};
