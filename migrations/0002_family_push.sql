CREATE TABLE IF NOT EXISTS family_config (
 id INTEGER PRIMARY KEY CHECK(id=1), password_hash TEXT, salt TEXT, access_token TEXT NOT NULL,
 failures INTEGER NOT NULL DEFAULT 0, locked_until INTEGER NOT NULL DEFAULT 0,
 vapid_public TEXT NOT NULL, vapid_private TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS family_sessions (token_hash TEXT PRIMARY KEY, expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS push_subscriptions (
 endpoint TEXT PRIMARY KEY, member_id INTEGER NOT NULL REFERENCES members(id),
 session_hash TEXT NOT NULL REFERENCES sessions(token_hash) ON DELETE CASCADE,
 subscription_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS notification_queue (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 endpoint TEXT NOT NULL REFERENCES push_subscriptions(endpoint) ON DELETE CASCADE,
 day TEXT NOT NULL, member_id INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
 next_attempt INTEGER NOT NULL DEFAULT 0
);
