// The site's own favicon (light or dark), served from Probe's cache. 404 means "use the letter".
import type { APIRoute } from 'astro';
import { envForApi } from '../../../lib/page';
import { siteIcon } from '../../../lib/favicon';

export const GET: APIRoute = async (ctx) => {
  const r = await envForApi(ctx, false);
  if ('error' in r) return r.error;
  if (r.env.kind !== 'web' || !r.env.domain) return new Response(null, { status: 404 });
  const obj = await siteIcon(r.env.domain, ctx.url.searchParams.get('s') === 'dark' ? 'dark' : 'light');
  if (!obj) return new Response(null, { status: 404, headers: { 'cache-control': 'private, max-age=3600' } });
  return new Response(obj.body, {
    headers: { 'content-type': obj.httpMetadata?.contentType || 'image/png', 'cache-control': 'private, max-age=86400', 'x-content-type-options': 'nosniff',
      // SVGs from other sites must never run anything here.
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:" },
  });
};
