// Moving Probe's data from one deployment to another (Webflow Cloud → Nassau's own Cloudflare account).
// The old deployment answers export requests; the new one pulls from it, table by table and file by file.
// Both sides need the same PROBE_MIGRATE_KEY; without it neither side does anything. Remove the key when done.
import { env } from 'cloudflare:workers';
import { APP_HOME, BASE, db } from './server';
import { bucket } from './snapshots';

export const migrateKey = () => { const k = String((env as any).PROBE_MIGRATE_KEY || '').trim(); return k.length >= 24 ? k : null; };
export const keyMatches = (given: string | null) => {
  const k = migrateKey();
  if (!k || !given || given.length !== k.length) return false;
  let d = 0; for (let i = 0; i < k.length; i++) d |= k.charCodeAt(i) ^ given.charCodeAt(i);
  return d === 0;
};

/** Where the data comes from: the live Probe, unless PROBE_MIGRATE_SOURCE names another deployment. */
export const migrateSource = () => String((env as any).PROBE_MIGRATE_SOURCE || `${APP_HOME}${BASE}`).replace(/\/+$/, '');

const NAME = /^[a-z_][a-z0-9_]*$/;
export type TableInfo = { name: string; cols: string[]; pk: string[]; rows: number };

/** Tables in the order they were created, so parents come before the tables that point at them. */
export async function tables(): Promise<TableInfo[]> {
  const names = (await db().prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name <> 'd1_migrations' ORDER BY rowid").all<{ name: string }>()).results
    .map((r) => r.name).filter((n) => NAME.test(n));
  const out: TableInfo[] = [];
  for (const name of names) {
    const info = (await db().prepare(`PRAGMA table_info(${name})`).all<{ name: string; pk: number }>()).results;
    const n = await db().prepare(`SELECT COUNT(*) AS n FROM ${name}`).first<{ n: number }>();
    out.push({ name, cols: info.map((c) => c.name), pk: info.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name), rows: n?.n ?? 0 });
  }
  return out;
}

/** One page of a table by rowid, kept under about 700 kB. */
export async function exportRows(table: string, after: number, limit = 250) {
  if (!NAME.test(table)) throw new Error('bad table');
  const rows = (await db().prepare(`SELECT rowid AS _rid, * FROM ${table} WHERE rowid > ? ORDER BY rowid LIMIT ?`).bind(after, Math.min(500, Math.max(1, limit))).all<Record<string, unknown>>()).results;
  const out: Record<string, unknown>[] = []; let bytes = 0;
  for (const r of rows) { bytes += JSON.stringify(r).length; if (out.length && bytes > 700_000) break; out.push(r); }
  return { rows: out, next: out.length ? Number(out[out.length - 1]._rid) : after, more: out.length > 0 && (out.length < rows.length || rows.length === Math.min(500, Math.max(1, limit))) };
}

/**
 * Writes one page into this database. Safe to repeat: rows that have a primary key are updated in place,
 * rows without one are only added once (by their row number). Nothing is ever deleted.
 */
export async function importRows(t: TableInfo, rows: Record<string, unknown>[]) {
  if (!NAME.test(t.name) || !rows.length) return 0;
  const here = new Set((await db().prepare(`PRAGMA table_info(${t.name})`).all<{ name: string }>()).results.map((c) => c.name));
  const cols = t.cols.filter((c) => NAME.test(c) && here.has(c));
  if (!cols.length) return 0;
  const usePk = t.pk.length > 0 && t.pk.every((c) => cols.includes(c));
  const rest = cols.filter((c) => !t.pk.includes(c));
  const sql = usePk
    ? `INSERT INTO ${t.name} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')}) ON CONFLICT (${t.pk.join(', ')}) DO ${rest.length ? `UPDATE SET ${rest.map((c) => `${c} = excluded.${c}`).join(', ')}` : 'NOTHING'}`
    : `INSERT OR IGNORE INTO ${t.name} (rowid, ${cols.join(', ')}) VALUES (?, ${cols.map(() => '?').join(', ')})`;
  let n = 0;
  for (let i = 0; i < rows.length; i += 80) {
    const part = rows.slice(i, i + 80);
    const res = await db().batch([
      db().prepare('PRAGMA defer_foreign_keys = on'),
      ...part.map((r) => db().prepare(sql).bind(...(usePk ? [] : [r._rid]), ...cols.map((c) => (r[c] === undefined ? null : r[c])))),
    ]);
    for (const x of res.slice(1)) n += x.meta.changes ? 1 : 0;
  }
  return n;
}

export async function exportFileList(cursor?: string) {
  const b = bucket(); if (!b) return { keys: [] as { key: string; size: number }[], cursor: null as string | null };
  const l = await b.list({ limit: 200, cursor: cursor || undefined });
  return { keys: l.objects.map((o) => ({ key: o.key, size: o.size })), cursor: l.truncated ? l.cursor : null };
}
export async function exportFile(key: string) {
  const o = await bucket()?.get(key);
  if (!o) return new Response('not found', { status: 404 });
  return new Response(o.body, { headers: { 'content-type': 'application/octet-stream', 'x-probe-meta': encodeURIComponent(JSON.stringify({ http: o.httpMetadata ?? {}, custom: o.customMetadata ?? {} })), 'cache-control': 'no-store' } });
}

/* ----- The pulling side ----- */
const ask = (source: string, q: string) => fetch(`${source}/api/migrate/export?${q}`, { headers: { 'x-migrate-key': migrateKey() || '' }, redirect: 'manual', signal: AbortSignal.timeout(25000) });

export async function pull(source: string, step: any): Promise<object> {
  if (step.what === 'tables') {
    const r = await ask(source, 'what=tables');
    if (!r.ok) throw new Error(r.status === 404 ? 'The source isn’t offering data: PROBE_MIGRATE_KEY is missing there, or differs from the one here.' : `The source answered ${r.status}.`);
    const src = ((await r.json()) as any).tables as TableInfo[];
    const mine = new Map((await tables()).map((t) => [t.name, t]));
    return { tables: src.map((t) => ({ ...t, here: mine.get(t.name)?.rows ?? null })) };
  }
  if (step.what === 'rows') {
    const t = step.table as TableInfo;
    const r = await ask(source, `what=rows&table=${encodeURIComponent(t.name)}&after=${Number(step.after) || 0}`);
    if (!r.ok) throw new Error(`Reading ${t.name} failed (${r.status}).`);
    const page = (await r.json()) as { rows: Record<string, unknown>[]; next: number; more: boolean };
    const written = await importRows(t, page.rows);
    return { read: page.rows.length, written, next: page.next, more: page.more };
  }
  if (step.what === 'files') {
    const r = await ask(source, `what=files&cursor=${encodeURIComponent(step.cursor || '')}`);
    if (!r.ok) throw new Error(`Listing files failed (${r.status}).`);
    const list = (await r.json()) as { keys: { key: string; size: number }[]; cursor: string | null };
    const b = bucket(); if (!b) throw new Error('This deployment has no file store.');
    let copied = 0, skipped = 0;
    for (const k of list.keys) {
      const have = await b.head(k.key);
      if (have && have.size === k.size) { skipped++; continue; }
      const f = await ask(source, `what=file&key=${encodeURIComponent(k.key)}`);
      if (!f.ok) throw new Error(`Reading the file ${k.key} failed (${f.status}).`);
      let meta: any = {}; try { meta = JSON.parse(decodeURIComponent(f.headers.get('x-probe-meta') || '%7B%7D')); } catch { /* no metadata */ }
      await b.put(k.key, await f.arrayBuffer(), { httpMetadata: meta.http, customMetadata: meta.custom });
      copied++;
    }
    return { copied, skipped, cursor: list.cursor };
  }
  throw new Error('Unknown step.');
}
