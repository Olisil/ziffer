-- Read-only keys that let an AI agent read one project's statistics over MCP (api/mcp).
-- Only a hash of the key is stored; hint is its last four characters, for telling keys apart.
CREATE TABLE agent_keys (
  id         TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  hash       TEXT NOT NULL UNIQUE,
  hint       TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created    INTEGER NOT NULL,
  last_used  INTEGER,
  calls      INTEGER NOT NULL DEFAULT 0,
  win_start  INTEGER NOT NULL DEFAULT 0,   -- rate limit: calls in the current minute
  win_calls  INTEGER NOT NULL DEFAULT 0,
  revoked    INTEGER
);
CREATE INDEX agent_keys_project ON agent_keys (project_id, created);
