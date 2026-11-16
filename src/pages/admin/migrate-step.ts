// One step of pulling data into this deployment. Owner only; driven from Admin → Move data.
import type { APIRoute } from 'astro';
import { me, isServiceOwner } from '../../lib/users';
import { migrateKey, migrateSource, pull } from '../../lib/migrate';

const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
export const POST: APIRoute = async (ctx) => {
  const u = await me(ctx);
  if (!u || !isServiceOwner(u)) return new Response('Not found', { status: 404 });
  if (!migrateKey()) return json({ error: 'PROBE_MIGRATE_KEY isn’t set on this deployment.' }, 400);
  const source = migrateSource();
  if (new URL(source).host === ctx.url.host) return json({ error: 'This is the deployment the data comes from.' }, 400);
  try { return json(await pull(source, await ctx.request.json())); }
  catch (e: any) { return json({ error: String(e?.message || e).slice(0, 300) }, 502); }
};
