-- Browser and OS (from the User-Agent, coarse names only) and dead clicks (clicks on things that aren't clickable).
ALTER TABLE sessions ADD COLUMN browser TEXT;
ALTER TABLE sessions ADD COLUMN os TEXT;
ALTER TABLE sessions ADD COLUMN dead INTEGER NOT NULL DEFAULT 0;
ALTER TABLE clicks ADD COLUMN dead INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS sessions_env_last_seen ON sessions (env_id, last_seen);
