CREATE TABLE IF NOT EXISTS wish_start_attempts(
  revision TEXT PRIMARY KEY,
  day TEXT NOT NULL,
  member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  processed_at TEXT NOT NULL
);
