CREATE TABLE IF NOT EXISTS rebooking_prompts(
  revision TEXT PRIMARY KEY,
  day TEXT NOT NULL,
  member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  decision TEXT NOT NULL CHECK(decision IN ('later','rebook')),
  decided_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS rebooking_history(
  old_revision TEXT PRIMARY KEY,
  day TEXT NOT NULL,
  member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  old_booking_json TEXT NOT NULL,
  new_revision TEXT NOT NULL,
  created_at TEXT NOT NULL
);
