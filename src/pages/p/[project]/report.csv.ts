import type { APIRoute } from 'astro';
import { buildReport, reportCsv } from '../../../lib/report';
import { readChoices, reportProject } from '../../../lib/report-access';

export const GET: APIRoute = async (ctx) => {
  const r = await reportProject(ctx);
  if ('error' in r && r.error) return new Response(r.error === 403 ? 'Basic accounts can’t export reports.' : 'Not found', { status: r.error });
  const { choices } = readChoices(ctx.url);
  const blocks = await buildReport(r.project!.id, choices);
  const name = `${r.project!.name}-probe-report-${new Date().toISOString().slice(0, 10)}`.replace(/[^\w.-]+/g, '-');
  return new Response(reportCsv(r.project!.name, blocks), {
    headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${name}.csv"`, 'Cache-Control': 'no-store' },
  });
};
