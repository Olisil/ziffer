-- AI traffic: which assistant sent a person's visit (sessions.ai), and visits by AI agents browsing for someone.
-- Agent visits live in their own table so they never count as people in the statistics.
ALTER TABLE sessions ADD COLUMN ai TEXT;
UPDATE sessions SET ai = CASE
  WHEN referrer LIKE '%chatgpt.com' OR referrer LIKE '%chat.openai.com' THEN 'ChatGPT'
  WHEN referrer LIKE '%perplexity.ai' THEN 'Perplexity'
  WHEN referrer LIKE '%claude.ai' THEN 'Claude'
  WHEN referrer = 'gemini.google.com' THEN 'Gemini'
  WHEN referrer LIKE '%copilot.microsoft.com' THEN 'Copilot'
  WHEN referrer LIKE '%mistral.ai' THEN 'Le Chat'
  WHEN referrer LIKE '%deepseek.com' THEN 'DeepSeek'
  WHEN referrer LIKE '%grok.com' THEN 'Grok'
  WHEN referrer LIKE '%meta.ai' THEN 'Meta AI'
  WHEN referrer LIKE '%you.com' THEN 'You.com'
  WHEN referrer LIKE '%phind.com' THEN 'Phind'
  WHEN referrer LIKE '%duck.ai' THEN 'Duck.ai'
END WHERE referrer IS NOT NULL;
CREATE INDEX sessions_env_ai ON sessions (env_id, started) WHERE ai IS NOT NULL;
CREATE TABLE agent_views (
  id      TEXT PRIMARY KEY,
  visit   TEXT NOT NULL,              -- one agent visit (the tab's session number)
  env_id  TEXT NOT NULL REFERENCES environments (id) ON DELETE CASCADE,
  agent   TEXT NOT NULL,              -- ChatGPT, Claude, Perplexity ...
  path    TEXT NOT NULL,
  ts      INTEGER NOT NULL,
  country TEXT
);
CREATE INDEX agent_views_env_ts ON agent_views (env_id, ts);
