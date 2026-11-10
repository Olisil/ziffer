// Site icons for the app's avatars: the favicon a site declares (light and, if it has one, dark),
// fetched by Probe's server and cached in R2 so pages never hotlink other sites.
import { bucket } from './snapshots';

export type Scheme = 'light' | 'dark';
const RECHECK_MS = 7 * 864e5, MISS_RECHECK_MS = 864e5, MAX_BYTES = 400_000;
const UA = 'ProbeSiteIcon/1.0 (+https://probe.nassau.se)';
// Placeholders Webflow serves when a site has no favicon of its own: show the letter instead.
const DEFAULTS = /website-files\.com\/img\/(favicon|webclip)|webflow\.com\/img\/(favicon|webclip)/i;

type Link = { href: string; rel: string; media: string; sizes: string; type: string };
const attr = (tag: string, name: string) => new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag)?.slice(1).find((x) => x !== undefined) ?? '';

function links(html: string, base: string): Link[] {
  const head = html.slice(0, Math.max(html.search(/<\/head>/i), 0) || 200_000);
  const out: Link[] = [];
  for (const m of head.matchAll(/<link\b[^>]*>/gi)) {
    const rel = attr(m[0], 'rel').toLowerCase();
    if (!/\bicon\b/.test(rel)) continue;
    const raw = attr(m[0], 'href').replace(/&amp;/g, '&');
    if (!raw || raw.startsWith('data:')) continue;
    let href: string; try { href = new URL(raw, base).href; } catch { continue; }
    if (!/^https:/.test(href) || DEFAULTS.test(href)) continue;
    out.push({ href, rel, media: attr(m[0], 'media').toLowerCase(), sizes: attr(m[0], 'sizes').toLowerCase(), type: attr(m[0], 'type').toLowerCase() });
  }
  return out;
}

// Real favicons before touch icons; SVG first, then the largest bitmap.
function score(l: Link) {
  const touch = /apple-touch/.test(l.rel) ? -10_000 : 0;
  if (l.type.includes('svg') || /\.svg(\?|$)/i.test(l.href)) return touch + 5000;
  if (l.sizes === 'any') return touch + 4000;
  const n = Math.max(0, ...l.sizes.split(/\s+/).map((s) => parseInt(s, 10) || 0));
  return touch + (n || (/apple-touch/.test(l.rel) ? 180 : 32));
}
const best = (ls: Link[]) => ls.sort((a, b) => score(b) - score(a))[0];

async function fetchIcon(href: string) {
  const res = await fetch(href, { headers: { 'user-agent': UA, accept: 'image/*' }, signal: AbortSignal.timeout(6000), redirect: 'follow' });
  if (!res.ok) return null;
  let type = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (!type.startsWith('image/')) type = /\.ico(\?|$)/i.test(href) ? 'image/x-icon' : /\.svg(\?|$)/i.test(href) ? 'image/svg+xml' : /\.png(\?|$)/i.test(href) ? 'image/png' : '';
  if (!type) return null;
  const body = await res.arrayBuffer();
  if (!body.byteLength || body.byteLength > MAX_BYTES) return null;
  return { type, body };
}

/** Looks the site up and stores what it finds. Returns false when the site has no usable icon. */
async function refresh(domain: string) {
  const b = bucket(); if (!b) return false;
  const origin = `https://${domain}`;
  let found: { light?: string; dark?: string } = {};
  try {
    const res = await fetch(origin + '/', { headers: { 'user-agent': UA, accept: 'text/html' }, signal: AbortSignal.timeout(8000), redirect: 'follow' });
    const ls = links((await res.text()).slice(0, 400_000), res.url || origin + '/');
    const dark = ls.filter((l) => /prefers-color-scheme:\s*dark/.test(l.media));
    const light = ls.filter((l) => !/prefers-color-scheme:\s*dark/.test(l.media));
    found = { light: best(light)?.href ?? `${origin}/favicon.ico`, dark: best(dark)?.href };
  } catch { found = { light: `${origin}/favicon.ico` }; }
  const now = String(Date.now());
  const light = found.light ? await fetchIcon(found.light).catch(() => null) : null;
  const dark = found.dark ? await fetchIcon(found.dark).catch(() => null) : null;
  for (const [scheme, icon] of [['light', light], ['dark', dark]] as const) {
    const key = `icons/${domain}/${scheme}`;
    if (icon) await b.put(key, icon.body, { httpMetadata: { contentType: icon.type }, customMetadata: { checked: now } });
    else await b.put(key, new Uint8Array(0), { customMetadata: { checked: now, none: '1' } });
  }
  return !!(light || dark);
}

/** The stored icon for a site and colour scheme (dark falls back to light, light to dark). */
export async function siteIcon(domain: string, scheme: Scheme) {
  const b = bucket(); if (!b) return null;
  domain = domain.toLowerCase().replace(/^https?:\/\//, '').replace(/[/?#].*$/, '');
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) return null;
  const get = (s: Scheme) => b.get(`icons/${domain}/${s}`);
  let obj = await get(scheme);
  const checked = Number(obj?.customMetadata?.checked || 0), none = obj?.customMetadata?.none === '1';
  if (!obj || Date.now() - checked > (none ? MISS_RECHECK_MS : RECHECK_MS)) { await refresh(domain); obj = await get(scheme); }
  if (!obj || obj.customMetadata?.none === '1') obj = await get(scheme === 'dark' ? 'light' : 'dark');
  if (!obj || obj.customMetadata?.none === '1') return null;
  return obj;
}
