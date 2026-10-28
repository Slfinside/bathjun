CREATE TABLE IF NOT EXISTS booking_reminders (
 id TEXT PRIMARY KEY,
 endpoint TEXT NOT NULL REFERENCES push_subscriptions(endpoint) ON DELETE CASCADE,
 day TEXT NOT NULL,
 member_id INTEGER NOT NULL REFERENCES members(id),
 start INTEGER NOT NULL,
 next_attempt INTEGER NOT NULL,
 attempts INTEGER NOT NULL DEFAULT 0,
 sent INTEGER NOT NULL DEFAULT 0 CHECK(sent IN (0,1)),
 UNIQUE(endpoint,day,member_id)
);
CREATE INDEX IF NOT EXISTS booking_reminders_due ON booking_reminders(sent,next_attempt);
