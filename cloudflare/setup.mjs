// Prepares Probe's own Cloudflare account for a deploy (run by .github/workflows/cloudflare.yml).
// Makes sure the EU-locked database and file store and the session store exist, then writes the
// wrangler.jsonc that the build and deploy use. Safe to run again: it only creates what is missing.
//
// A jurisdiction can only be set when a database or bucket is created, so this script refuses to
// continue if one with the right name exists without the EU lock.
import { writeFileSync } from 'node:fs';

const token = process.env.CLOUDFLARE_API_TOKEN, account = process.env.CLOUDFLARE_ACCOUNT_ID;
if (!token || !account) { console.error('CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID must be set as repository secrets.'); process.exit(1); }

const NAME = { worker: 'probe-app', db: 'probe-eu', bucket: 'probe-files-eu', kv: 'probe-app-session' };
const api = async (method, path, body, headers = {}) => {
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}${path}`, {
    method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return { ok: res.ok && json.success !== false, status: res.status, result: json.result, errors: json.errors };
};
const fail = (what, r) => { console.error(`${what} failed (${r.status}): ${JSON.stringify(r.errors ?? r.result)}`); process.exit(1); };

// Database, locked to the EU
let r = await api('GET', `/d1/database?name=${NAME.db}&per_page=100`);
if (!r.ok) fail('Listing databases', r);
let db = (r.result || []).find((d) => d.name === NAME.db);
if (!db) {
  r = await api('POST', '/d1/database', { name: NAME.db, jurisdiction: 'eu' });
  if (!r.ok) fail('Creating the database', r);
  db = r.result; console.log(`Created database ${NAME.db} (EU).`);
}
const dbInfo = await api('GET', `/d1/database/${db.uuid}`);
const jurisdiction = dbInfo.result?.jurisdiction ?? db.jurisdiction;
if (jurisdiction !== 'eu') { console.error(`Database ${NAME.db} exists but is not locked to the EU (jurisdiction: ${jurisdiction ?? 'none'}). Remove it or change NAME.db.`); process.exit(1); }

// File store, locked to the EU
const EU = { 'cf-r2-jurisdiction': 'eu' };
r = await api('GET', `/r2/buckets/${NAME.bucket}`, null, EU);
if (r.status === 404) {
  r = await api('POST', '/r2/buckets', { name: NAME.bucket }, EU);
  if (!r.ok) fail('Creating the file store', r);
  console.log(`Created file store ${NAME.bucket} (EU).`);
} else if (!r.ok) fail('Reading the file store', r);

// Session store
r = await api('GET', '/storage/kv/namespaces?per_page=100');
if (!r.ok) fail('Listing key-value stores', r);
let kv = (r.result || []).find((n) => n.title === NAME.kv);
if (!kv) {
  r = await api('POST', '/storage/kv/namespaces', { title: NAME.kv });
  if (!r.ok) fail('Creating the session store', r);
  kv = r.result; console.log(`Created session store ${NAME.kv}.`);
}

writeFileSync('wrangler.jsonc', JSON.stringify({
  $schema: 'node_modules/wrangler/config-schema.json',
  name: NAME.worker,
  compatibility_date: '2026-11-01',
  compatibility_flags: ['nodejs_compat'],
  workers_dev: true,
  keep_vars: true, // secrets and variables are set in the Cloudflare dashboard and must survive deploys
  d1_databases: [{ binding: 'DB', database_name: NAME.db, database_id: db.uuid, migrations_dir: 'migrations' }],
  kv_namespaces: [{ binding: 'SESSION', id: kv.id }],
  r2_buckets: [{ binding: 'RECORDINGS', bucket_name: NAME.bucket, jurisdiction: 'eu' }],
  observability: { enabled: true },
}, null, 2));
console.log(`Ready: database ${db.uuid} (eu), file store ${NAME.bucket} (eu), session store ${kv.id}.`);
