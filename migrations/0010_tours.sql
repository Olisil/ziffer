-- Virtual tour environments (Intus): one row per tour visit, as the viewer reports it.
-- data is the visit's JSON: rooms (seconds per room), order, walk and look heat cells, path, quality, gyro.
CREATE TABLE tour_visits (
  sid      TEXT PRIMARY KEY,
  env_id   TEXT NOT NULL REFERENCES environments (id) ON DELETE CASCADE,
  tour     TEXT NOT NULL,              -- the tour's link name, e.g. "storgatan-12"
  started  INTEGER NOT NULL,
  updated  INTEGER NOT NULL,
  dur      REAL NOT NULL DEFAULT 0,    -- seconds in the tour
  device   TEXT,                       -- touch | desktop
  country  TEXT,
  data     TEXT NOT NULL
);
CREATE INDEX tour_visits_env ON tour_visits (env_id, tour, started);
-- Where the tour files (tour.json, floor plans) are published, for titles, rooms and plan pictures.
ALTER TABLE environments ADD COLUMN tours_base TEXT;
