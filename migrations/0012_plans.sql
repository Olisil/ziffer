-- Plans per project: Free, Starter and Studio, measured in sessions a month.
-- A plan sets the monthly session cap, how long detailed data is kept, how many environments
-- a project can have, and whether virtual tours and agent access are included.
ALTER TABLE projects ADD COLUMN plan TEXT NOT NULL DEFAULT 'free';     -- 'free' | 'starter' | 'studio'
ALTER TABLE projects ADD COLUMN plan_since INTEGER;                     -- when the current plan was chosen
ALTER TABLE projects ADD COLUMN plan_comp INTEGER NOT NULL DEFAULT 0;   -- 1: the plan is given by the service owner, never billed

-- Sessions stored (and turned away) per project and calendar month (UTC).
CREATE TABLE usage_months (
  project_id TEXT NOT NULL, month TEXT NOT NULL,   -- 'YYYY-MM'
  sessions INTEGER NOT NULL DEFAULT 0, dropped INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (project_id, month)
);
-- This month's count starts from what is already stored.
INSERT INTO usage_months (project_id, month, sessions)
  SELECT e.project_id, strftime('%Y-%m', 'now'), COUNT(*) FROM sessions s JOIN environments e ON e.id = s.env_id
   WHERE s.started >= CAST(strftime('%s', 'now', 'start of month') AS INTEGER) * 1000 GROUP BY e.project_id;

-- Billing now follows the plan: each day records the plan a paying project was on.
ALTER TABLE billing_days ADD COLUMN plan TEXT;
