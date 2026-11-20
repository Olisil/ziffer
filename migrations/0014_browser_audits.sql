-- Accessibility and privacy tests run in a real browser after the plain-HTML audit of a page.
-- browser_status: NULL (not planned), 'pending', 'run:a11y', 'a11y' (accessibility done, privacy waiting), 'run:priv', 'done'.
ALTER TABLE audits ADD COLUMN a11y INTEGER;
ALTER TABLE audits ADD COLUMN privacy INTEGER;
ALTER TABLE audits ADD COLUMN browser_status TEXT;
ALTER TABLE audits ADD COLUMN browser_ran INTEGER;
ALTER TABLE audits ADD COLUMN browser_tries INTEGER NOT NULL DEFAULT 0;
ALTER TABLE audits ADD COLUMN browser_results TEXT;
CREATE INDEX IF NOT EXISTS audits_browser ON audits (env_id, browser_status);
-- Pages that already have an audit get the browser tests too, the next time someone opens their Audits page.
UPDATE audits SET browser_status = 'pending' WHERE status = 'done' AND http_status < 400 AND url IS NOT NULL
  AND ran_at = (SELECT MAX(b.ran_at) FROM audits b WHERE b.env_id = audits.env_id AND b.path = audits.path AND b.status = 'done');
