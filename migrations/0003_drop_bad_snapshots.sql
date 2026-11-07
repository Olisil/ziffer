-- Snapshots taken in background tabs had no layout (0×0, stored as 200×200). Drop them so they are captured again.
DELETE FROM snapshots WHERE vw <= 200 OR vh <= 200;

-- Page views recorded from background tabs before they were ever shown (0×0 window). They were not real views.
DELETE FROM clicks WHERE session_id IN (SELECT session_id FROM pageviews WHERE vw = 0 AND vh = 0)
  AND NOT EXISTS (SELECT 1 FROM pageviews p WHERE p.session_id = clicks.session_id AND (p.vw > 0 OR p.vh > 0));
DELETE FROM pageviews WHERE vw = 0 AND vh = 0;
DELETE FROM sessions WHERE NOT EXISTS (SELECT 1 FROM pageviews p WHERE p.session_id = sessions.id);
