// Runs the next waiting audit for an environment (called by the Audits page while it is open).
import type { APIRoute } from 'astro';
import { db, getScopedEnvironment, ownerId } from '../../../../lib/server';
import { runPendingAudits } from '../../../../lib/audit';

export const POST: APIRoute = async (ctx) => {
  const owner = ownerId(ctx);
  if (!owner) return new Response('Unauthorized', { status: 401 });
  const env = await getScopedEnvironment(owner, String(ctx.params.env));
  if (!env) return new Response('Not found', { status: 404 });
  const ran = await runPendingAudits(env.id, 1);
  const left = await db().prepare("SELECT COUNT(*) AS n FROM audits WHERE env_id = ? AND status IN ('pending', 'running')").bind(env.id).first<{ n: number }>();
  return Response.json({ ran, pending: left?.n ?? 0 });
};
