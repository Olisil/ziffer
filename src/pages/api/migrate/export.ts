// Hands this deployment's data to another Probe deployment that knows PROBE_MIGRATE_KEY.
// Without that setting this address does not exist.
import type { APIRoute } from 'astro';
import { exportFile, exportFileList, exportRows, keyMatches, migrateKey, tables } from '../../../lib/migrate';

const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
export const GET: APIRoute = async ({ request, url }) => {
  if (!migrateKey() || !keyMatches(request.headers.get('x-migrate-key'))) return new Response('Not found', { status: 404 });
  const q = url.searchParams;
  try {
    switch (q.get('what')) {
      case 'tables': return json({ tables: await tables() });
      case 'rows': return json(await exportRows(String(q.get('table')), Number(q.get('after')) || 0));
      case 'files': return json(await exportFileList(q.get('cursor') || undefined));
      case 'file': return exportFile(String(q.get('key')));
      default: return json({ error: 'bad request' }, 400);
    }
  } catch (e: any) { return json({ error: String(e?.message || e).slice(0, 200) }, 500); }
};
