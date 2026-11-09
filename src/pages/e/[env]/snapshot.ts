// Owner-only: returns a stored page snapshot as inert text for the heatmap viewer.
// Snapshots are uploaded by site visitors, so they are never served as HTML on the app's origin.
import type { APIRoute } from 'astro';
import { getScopedEnvironment, ownerId } from '../../../lib/server';
import { bucket, getSnapshot } from '../../../lib/snapshots';

export const GET: APIRoute = async (ctx) => {
  const owner = ownerId(ctx);
  if (!owner) return new Response('Unauthorized', { status: 401 });
  const env = await getScopedEnvironment(owner, String(ctx.params.env));
  if (!env) return new Response('Not found', { status: 404 });
  const path = ctx.url.searchParams.get('page') || '/';
  const device = ctx.url.searchParams.get('device') === 'mobile' ? 'mobile' : 'desktop';
  const sv = ctx.url.searchParams.get('sv');
  const snap = await getSnapshot(env.id, path, device, sv !== null ? { version: sv } : undefined);
  const obj = snap && (await bucket()?.get(snap.r2_key));
  if (!snap || !obj) return new Response('No snapshot', { status: 404 });
  return new Response(obj.body, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "sandbox; default-src 'none'",
      'Content-Disposition': 'attachment',
      'Cache-Control': 'private, max-age=300',
    },
  });
};
