CREATE TABLE IF NOT EXISTS standby_stamps (
  day TEXT NOT NULL,
  member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK(status IN ('stamp','failed')),
  resolved_at TEXT NOT NULL,
  PRIMARY KEY(day,member_id)
);
