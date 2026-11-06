-- Ziffer schema v1.
-- A project belongs to a Clerk user (or organisation). Each project has one or more environments:
-- 'web' (a website with the z.js tracker) or 'tour' (an Intus virtual tour). Games and VR come later.

CREATE TABLE projects (
  id         TEXT PRIMARY KEY,
  owner_id   TEXT NOT NULL,             -- Clerk org id, or user id for personal projects
  name       TEXT NOT NULL,
  created    INTEGER NOT NULL
);
CREATE INDEX projects_owner ON projects (owner_id, created);

CREATE TABLE environments (
  id         TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  kind       TEXT NOT NULL CHECK (kind IN ('web', 'tour')),
  name       TEXT NOT NULL,             -- e.g. nassau.se, Storgatan 12
  domain     TEXT,                      -- web: allowed hostname (www. and subdomains also accepted)
  site_key   TEXT NOT NULL UNIQUE,      -- public key in the install snippet
  created    INTEGER NOT NULL
);
CREATE INDEX environments_project ON environments (project_id, created);

-- One row per visit (tab). No cookies: sid lives in sessionStorage; visitor is a daily-salted hash.
CREATE TABLE sessions (
  id         TEXT PRIMARY KEY,
  env_id     TEXT NOT NULL REFERENCES environments (id) ON DELETE CASCADE,
  visitor    TEXT NOT NULL,
  started    INTEGER NOT NULL,
  last_seen  INTEGER NOT NULL,
  duration   REAL NOT NULL DEFAULT 0,   -- seconds of engaged (visible) time
  pageviews  INTEGER NOT NULL DEFAULT 0,
  rage       INTEGER NOT NULL DEFAULT 0,
  device     TEXT,                      -- desktop | tablet | mobile
  country    TEXT,
  referrer   TEXT,                      -- hostname only
  entry_path TEXT,
  exit_path  TEXT
);
CREATE INDEX sessions_env_started ON sessions (env_id, started);

CREATE TABLE pageviews (
  id         TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  env_id     TEXT NOT NULL,
  path       TEXT NOT NULL,
  title      TEXT,
  ts         INTEGER NOT NULL,
  duration   REAL NOT NULL DEFAULT 0,
  scroll     REAL NOT NULL DEFAULT 0,   -- max scroll depth 0..100
  vw         INTEGER, vh INTEGER, dw INTEGER, dh INTEGER
);
CREATE INDEX pageviews_env_ts ON pageviews (env_id, ts);
CREATE INDEX pageviews_env_path ON pageviews (env_id, path, ts);

CREATE TABLE clicks (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  env_id     TEXT NOT NULL,
  path       TEXT NOT NULL,
  ts         INTEGER NOT NULL,
  xr         REAL NOT NULL,             -- x as a fraction of document width (0..1)
  y          REAL NOT NULL,             -- y in CSS px from document top
  vw         INTEGER, dw INTEGER, dh INTEGER,
  sel        TEXT,                      -- short CSS-ish selector of the target (no text content)
  rage       INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX clicks_env_path ON clicks (env_id, path, ts);

-- Daily salts for the visitor hash; old salts are deleted so hashes can't be linked across days.
CREATE TABLE salts (
  day        TEXT PRIMARY KEY,
  salt       TEXT NOT NULL
);
