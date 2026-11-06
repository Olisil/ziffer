-- One page snapshot per environment, path and device bucket. The HTML lives in R2 (RECORDINGS).
CREATE TABLE snapshots (
  env_id TEXT NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  device TEXT NOT NULL CHECK (device IN ('desktop', 'mobile')),
  ts INTEGER NOT NULL,
  vw INTEGER NOT NULL,
  vh INTEGER NOT NULL,
  dw INTEGER NOT NULL,
  dh INTEGER NOT NULL,
  bytes INTEGER NOT NULL,
  r2_key TEXT NOT NULL,
  PRIMARY KEY (env_id, path, device)
);
