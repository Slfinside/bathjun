CREATE TABLE IF NOT EXISTS passkey_accounts (
 member_id INTEGER PRIMARY KEY REFERENCES members(id), user_id BLOB NOT NULL UNIQUE
);
CREATE TABLE IF NOT EXISTS passkey_credentials (
 id TEXT PRIMARY KEY, member_id INTEGER NOT NULL REFERENCES members(id),
 public_key BLOB NOT NULL, counter INTEGER NOT NULL DEFAULT 0,
 transports TEXT NOT NULL, device_type TEXT NOT NULL, backed_up INTEGER NOT NULL,
 created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS passkey_challenges (
 token_hash TEXT PRIMARY KEY, kind TEXT NOT NULL, member_id INTEGER,
 challenge TEXT NOT NULL, origin TEXT NOT NULL, rp_id TEXT NOT NULL, expires INTEGER NOT NULL
);
