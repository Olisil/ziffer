// Runs the next waiting audit for an environment (called by the Audits page while it is open).
import type { APIRoute } from 'astro';
import { db } from '../../../../lib/server';
import { envForApi } from '../../../../lib/page';
import { browserPending, runPendingAudits, runPendingBrowser } from '../../../../lib/audit';

export const POST: APIRoute = async (ctx) => {
  const r = await envForApi(ctx, true);
  if ('error' in r) return r.error;
  const { env } = r;
  const path = new URL(ctx.request.url).searchParams.get('path');
  const ran = await runPendingAudits(env.id, 1);
  const left = await db().prepare("SELECT COUNT(*) AS n FROM audits WHERE env_id = ? AND status IN ('pending', 'running')").bind(env.id).first<{ n: number }>();
  // The plain-HTML audits go first; the browser tests (accessibility, privacy) follow, one step per call.
  const stepped = ran || (left?.n ?? 0) ? 0 : await runPendingBrowser(env.id, path);
  const browser = (await browserPending(env.id)).length;
  const mine = path ? await db().prepare("SELECT browser_status AS s FROM audits WHERE env_id = ? AND path = ? AND status = 'done' ORDER BY ran_at DESC LIMIT 1").bind(env.id, path).first<{ s: string | null }>() : null;
  return Response.json({ ran: ran + stepped, pending: left?.n ?? 0, browser, state: mine?.s ?? null });
};
