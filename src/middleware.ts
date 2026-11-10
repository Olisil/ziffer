import { clerkMiddleware } from '@clerk/astro/server';
import { env } from 'cloudflare:workers';
import type { MiddlewareHandler } from 'astro';
import { APP_HOME, BASE } from './lib/server';
import { LANG_COOKIE, pickLang, translateResponse } from './lib/i18n';

// Public, cookieless tracker endpoints never touch Clerk.
// (and Stripe's webhook, which is verified by its signature instead)
const isTracker = (p: string) => p === `${BASE}/z.js` || p === `${BASE}/api/collect` || p === `${BASE}/api/snap` || p === `${BASE}/favicon.svg` || p === `${BASE}/api/stripe/webhook` || p.startsWith(`${BASE}/api/tour/`);
const PUBLIC = [`${BASE}/sign-in`, `${BASE}/sign-up`];
const isPublic = (p: string) => PUBLIC.some((x) => p === x || p.startsWith(x + '/'));

const withClerk = clerkMiddleware((auth, context) => {
  const { userId } = auth();
  if (!userId && !isPublic(context.url.pathname)) {
    const back = context.url.pathname + context.url.search;
    return context.redirect(`${BASE}/sign-in?redirect_url=${encodeURIComponent(back)}`);
  }
});

// Local development without Clerk keys: `ZIFFER_DEV_USER=dev_user` in .dev.vars (ignored in production builds).
const devBypass: MiddlewareHandler = (context, next) => {
  (context.locals as any).auth = () => ({ userId: (env as any).ZIFFER_DEV_USER, orgId: null });
  return next();
};

const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
// Behind Webflow Cloud's proxy the public host may only appear in the forwarded headers.
function sameOrigin(req: Request, u: URL) {
  const origin = req.headers.get('Origin');
  if (!origin) return false;
  let host: string;
  try { host = new URL(origin).host; } catch { return false; }
  const hosts = [u.host, req.headers.get('X-Forwarded-Host'), req.headers.get('Host')].filter(Boolean).map((h) => h!.split(',')[0].trim());
  return hosts.includes(host);
}

// The service moved from ziffer.webflow.io to probe.nassau.se. Old tracking snippets keep working (tracker
// endpoints are served on both hosts); people opening the app on the old address are sent to the new one.
const OLD_HOSTS = new Set(['ziffer.webflow.io']);
function publicHost(req: Request, u: URL) { return (req.headers.get('X-Forwarded-Host') || req.headers.get('Host') || u.host).split(',')[0].trim().toLowerCase(); }

// Swedish: pages are written in English and translated on the way out (see lib/i18n-sv.ts).
const localized: MiddlewareHandler = async (context, next) => {
  const res = await next();
  if (!(res.headers.get('content-type') || '').includes('text/html')) return res;
  const lang = pickLang(context.request, context.cookies.get(LANG_COOKIE)?.value, (context.locals as any).__me?.lang);
  if (lang !== 'sv') return res;
  const out = translateResponse(res);
  out.headers.set('Content-Language', 'sv');
  out.headers.append('Vary', 'Accept-Language, Cookie');
  return out;
};

const routed: MiddlewareHandler = (context, next) => {
  if (isTracker(context.url.pathname)) return next();
  if ((context.request.method === 'GET' || context.request.method === 'HEAD') && OLD_HOSTS.has(publicHost(context.request, context.url)))
    return Response.redirect(`${APP_HOME}${context.url.pathname}${context.url.search}`, 301);
  // CSRF: app forms and APIs only accept same-origin writes.
  if (UNSAFE.has(context.request.method) && !sameOrigin(context.request, context.url)) {
    return new Response('Cross-site request blocked', { status: 403 });
  }
  if (import.meta.env.DEV && (env as any).ZIFFER_DEV_USER) return devBypass(context, next);
  return withClerk(context, next);
};

export const onRequest: MiddlewareHandler = (context, next) => routed(context, () => localized(context, next));
