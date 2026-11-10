-- Clicks remember where inside the clicked element they landed, so they can be drawn on that element
-- even when the page picture was taken at another window size.
ALTER TABLE clicks ADD COLUMN ei INTEGER;  -- which of the elements matching sel (in page order)
ALTER TABLE clicks ADD COLUMN ex REAL;     -- 0..1 across the element
ALTER TABLE clicks ADD COLUMN ey REAL;     -- 0..1 down the element
