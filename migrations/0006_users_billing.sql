-- People, project membership, invitations, notifications and billing.
CREATE TABLE users (
  id TEXT PRIMARY KEY,                    -- Clerk user id
  email TEXT, email_verified INTEGER NOT NULL DEFAULT 0,
  name TEXT, image_url TEXT,
  plan TEXT NOT NULL DEFAULT 'pro' CHECK (plan IN ('owner', 'pro_free', 'pro', 'basic')),
  notify TEXT,                             -- JSON preferences
  created INTEGER NOT NULL, last_seen INTEGER, synced INTEGER
);
CREATE INDEX users_email ON users (email);

CREATE TABLE project_members (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  access TEXT NOT NULL CHECK (access IN ('pro', 'basic')),   -- pro edits, basic reads
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'member')),
  added_by TEXT, created INTEGER NOT NULL,
  PRIMARY KEY (project_id, user_id)
);
CREATE INDEX project_members_user ON project_members (user_id);

-- Everyone who owns a project today becomes its project owner with Pro access.
INSERT OR IGNORE INTO project_members (project_id, user_id, access, role, created)
  SELECT id, owner_id, 'pro', 'owner', created FROM projects;

CREATE TABLE invitations (
  token TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,   -- NULL: invited to Ziffer with a plan, no project
  email TEXT NOT NULL,
  access TEXT CHECK (access IN ('pro', 'basic')),
  plan TEXT CHECK (plan IN ('pro_free', 'pro', 'basic')),       -- set by the service owner
  invited_by TEXT NOT NULL, created INTEGER NOT NULL, expires INTEGER NOT NULL,
  accepted_by TEXT, accepted_at INTEGER, revoked INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX invitations_email ON invitations (email);
CREATE INDEX invitations_project ON invitations (project_id);

CREATE TABLE access_requests (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL, email TEXT, domain TEXT, message TEXT,
  created INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'approved', 'declined'))
);
CREATE INDEX access_requests_project ON access_requests (project_id, status);

-- Site claims: a site is reserved for 7 days and confirmed by the first visit through the snippet.
ALTER TABLE environments ADD COLUMN verified_at INTEGER;
UPDATE environments SET verified_at = (SELECT MIN(started) FROM sessions s WHERE s.env_id = environments.id)
  WHERE EXISTS (SELECT 1 FROM sessions s WHERE s.env_id = environments.id);

-- Billing per project (Stripe). The payer is a project member; seats are its Pro members.
ALTER TABLE projects ADD COLUMN payer_id TEXT;
ALTER TABLE projects ADD COLUMN stripe_customer TEXT;
ALTER TABLE projects ADD COLUMN stripe_subscription TEXT;
ALTER TABLE projects ADD COLUMN billing_status TEXT;          -- NULL | 'active' | 'past_due' | 'canceled'
ALTER TABLE projects ADD COLUMN seats_reported INTEGER;
ALTER TABLE projects ADD COLUMN seats_reported_at INTEGER;

-- Service-wide settings (Stripe ids, last background run, …) and in-app notifications.
CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT, updated INTEGER);
CREATE TABLE notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL, project_id TEXT, env_id TEXT,
  kind TEXT NOT NULL, title TEXT NOT NULL, body TEXT, link TEXT,
  created INTEGER NOT NULL, read_at INTEGER, emailed INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX notifications_user ON notifications (user_id, created);

-- Billing: Pro seats are counted every day; after each full month the project is invoiced for
-- (seat-days ÷ days in month) × seat price, charged to the card saved through Stripe.
CREATE TABLE billing_days (project_id TEXT NOT NULL, day TEXT NOT NULL, seats INTEGER NOT NULL, PRIMARY KEY (project_id, day));
CREATE TABLE billing_invoices (
  project_id TEXT NOT NULL, month TEXT NOT NULL,          -- 'YYYY-MM'
  seat_days INTEGER NOT NULL, amount INTEGER NOT NULL, currency TEXT NOT NULL,
  stripe_invoice TEXT, status TEXT NOT NULL, created INTEGER NOT NULL,
  PRIMARY KEY (project_id, month)
);
ALTER TABLE users ADD COLUMN last_weekly INTEGER;
