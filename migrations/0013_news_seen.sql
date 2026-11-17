-- The latest "What's new" note a person has dismissed (see src/lib/news.ts). NULL = none yet.
ALTER TABLE users ADD COLUMN news_seen TEXT;
