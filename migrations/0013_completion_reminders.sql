CREATE TABLE IF NOT EXISTS completion_reminders (
  id TEXT PRIMARY KEY,
  endpoint TEXT NOT NULL REFERENCES push_subscriptions(endpoint) ON DELETE CASCADE,
  day TEXT NOT NULL,
  member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  revision TEXT NOT NULL,
  next_attempt INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  sent INTEGER NOT NULL DEFAULT 0 CHECK(sent IN (0,1)),
  UNIQUE(endpoint,day,member_id,revision)
);
CREATE INDEX IF NOT EXISTS completion_reminders_due ON completion_reminders(sent,next_attempt);
