// Runs the next waiting audit for an environment (called by the Audits page while it is open).
import type { APIRoute } from 'astro';
import { db } from '../../../../lib/server';
import { envForApi } from '../../../../lib/page';
import { runPendingAudits } from '../../../../lib/audit';

export const POST: APIRoute = async (ctx) => {
  const r = await envForApi(ctx, true);
  if ('error' in r) return r.error;
  const { env } = r;
  const ran = await runPendingAudits(env.id, 1);
  const left = await db().prepare("SELECT COUNT(*) AS n FROM audits WHERE env_id = ? AND status IN ('pending', 'running')").bind(env.id).first<{ n: number }>();
  return Response.json({ ran, pending: left?.n ?? 0 });
};
