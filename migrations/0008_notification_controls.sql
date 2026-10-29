CREATE TABLE IF NOT EXISTS notification_preferences (
 member_id INTEGER PRIMARY KEY REFERENCES members(id) ON DELETE CASCADE,
 value_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS wish_outcomes (
 id TEXT PRIMARY KEY, revision TEXT NOT NULL,
 day TEXT NOT NULL, member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
 kind TEXT NOT NULL CHECK(kind IN ('wishConfirmed','wishUnconfirmed')),
 start INTEGER NOT NULL, duration INTEGER NOT NULL,
 UNIQUE(revision,kind)
);
CREATE TABLE IF NOT EXISTS wish_notification_jobs (
 id TEXT PRIMARY KEY,
 event_id TEXT NOT NULL REFERENCES wish_outcomes(id) ON DELETE CASCADE,
 endpoint TEXT NOT NULL REFERENCES push_subscriptions(endpoint) ON DELETE CASCADE,
 next_attempt INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
 sent INTEGER NOT NULL DEFAULT 0 CHECK(sent IN (0,1)),
 UNIQUE(event_id,endpoint)
);
CREATE INDEX IF NOT EXISTS wish_notification_due ON wish_notification_jobs(sent,next_attempt);
