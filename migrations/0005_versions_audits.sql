-- Site versions: detected from layout fingerprints the tracker sends.
CREATE TABLE site_versions (
  id TEXT PRIMARY KEY,
  env_id TEXT NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
  detected_at INTEGER NOT NULL,          -- when the new layout first appeared (never editable)
  created INTEGER NOT NULL,              -- when Ziffer concluded it was a new version
  name TEXT,                             -- user's name; NULL shows "<environment> <n>.0"
  merged_into TEXT,                      -- set when the user says this wasn't a real new version
  reason TEXT                            -- JSON: pages, kinds, distances
);
CREATE INDEX site_versions_env ON site_versions (env_id, detected_at);

-- Current (stable) layout per page and device, with a candidate that must repeat before it is accepted.
CREATE TABLE page_state (
  env_id TEXT NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  device TEXT NOT NULL,
  s TEXT NOT NULL, t TEXT, c TEXT NOT NULL,   -- structure SimHash, template (header/nav/footer) SimHash, content hash
  since INTEGER NOT NULL, last_seen INTEGER NOT NULL,
  cand_s TEXT, cand_t TEXT, cand_c TEXT, cand_hits INTEGER NOT NULL DEFAULT 0, cand_first INTEGER,
  PRIMARY KEY (env_id, path, device)
);

CREATE TABLE page_changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  env_id TEXT NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
  path TEXT NOT NULL, device TEXT NOT NULL,
  at INTEGER NOT NULL,                        -- first seen
  kind TEXT NOT NULL,                         -- 'structure' | 'template' | 'content'
  distance INTEGER NOT NULL,                  -- bits of 64 that differ (0 for content-only)
  version_id TEXT
);
CREATE INDEX page_changes_env ON page_changes (env_id, at);

-- SEO / AEO / technical audits of single pages.
CREATE TABLE audits (
  id TEXT PRIMARY KEY,
  env_id TEXT NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  status TEXT NOT NULL,                       -- 'pending' | 'done' | 'error'
  trigger TEXT NOT NULL,                      -- 'first' | 'content' | 'structure' | 'template' | 'version' | 'manual'
  queued INTEGER NOT NULL, ran_at INTEGER,
  version_id TEXT,
  seo INTEGER, aeo INTEGER, tech INTEGER, overall INTEGER,
  url TEXT, http_status INTEGER, fetch_ms INTEGER, bytes INTEGER,
  results TEXT, error TEXT
);
CREATE INDEX audits_env_path ON audits (env_id, path, queued);
CREATE INDEX audits_pending ON audits (status, queued);

-- Snapshots: one per page, device and version, so older versions keep their pictures.
CREATE TABLE snapshots_new (
  env_id TEXT NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  device TEXT NOT NULL CHECK (device IN ('desktop', 'mobile')),
  version_id TEXT NOT NULL DEFAULT '',
  s TEXT,
  ts INTEGER NOT NULL, vw INTEGER NOT NULL, vh INTEGER NOT NULL, dw INTEGER NOT NULL, dh INTEGER NOT NULL,
  bytes INTEGER NOT NULL, r2_key TEXT NOT NULL,
  PRIMARY KEY (env_id, path, device, version_id)
);
INSERT INTO snapshots_new (env_id, path, device, version_id, s, ts, vw, vh, dw, dh, bytes, r2_key)
  SELECT env_id, path, device, '', NULL, ts, vw, vh, dw, dh, bytes, r2_key FROM snapshots;
DROP TABLE snapshots;
ALTER TABLE snapshots_new RENAME TO snapshots;
