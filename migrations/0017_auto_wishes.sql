CREATE TABLE IF NOT EXISTS auto_wish_preferences(
  member_id INTEGER PRIMARY KEY REFERENCES members(id) ON DELETE CASCADE,
  days_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS auto_wish_runs(
  day TEXT NOT NULL,
  member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK(status IN ('submitted','skipped','rejected')),
  revision TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  PRIMARY KEY(day,member_id)
);
