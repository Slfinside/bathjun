CREATE TABLE IF NOT EXISTS time_selection_receipts (
 endpoint_hash TEXT NOT NULL,
 day TEXT NOT NULL,
 member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
 sent_at TEXT NOT NULL,
 PRIMARY KEY(endpoint_hash,day,member_id)
);
CREATE TABLE IF NOT EXISTS time_selection_jobs (
 id TEXT PRIMARY KEY,
 endpoint TEXT NOT NULL REFERENCES push_subscriptions(endpoint) ON DELETE CASCADE,
 day TEXT NOT NULL,
 member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
 next_attempt INTEGER NOT NULL,
 attempts INTEGER NOT NULL DEFAULT 0,
 UNIQUE(endpoint,day,member_id)
);
CREATE INDEX IF NOT EXISTS time_selection_due ON time_selection_jobs(next_attempt);
