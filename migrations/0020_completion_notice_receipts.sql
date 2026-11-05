CREATE TABLE IF NOT EXISTS completion_notice_receipts (
  endpoint_hash TEXT NOT NULL,
  day TEXT NOT NULL,
  member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  revision TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  PRIMARY KEY(endpoint_hash,day,member_id,revision)
);
