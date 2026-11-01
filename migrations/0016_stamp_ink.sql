-- Ink repairs are card decorations, not bath completion reports.
CREATE TABLE IF NOT EXISTS stamp_repairs(
  day TEXT NOT NULL,
  member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  used_at TEXT NOT NULL,
  request_id TEXT NOT NULL UNIQUE,
  PRIMARY KEY(day,member_id)
);
