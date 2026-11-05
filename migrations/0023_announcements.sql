CREATE TABLE IF NOT EXISTS announcements(
 id TEXT PRIMARY KEY, label TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('draft','scheduled','published','archived')),
 scheduled_at INTEGER, published_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, bundle_version TEXT UNIQUE
);
CREATE TABLE IF NOT EXISTS announcement_pages(
 id TEXT PRIMARY KEY, announcement_id TEXT NOT NULL REFERENCES announcements(id) ON DELETE CASCADE,
 position INTEGER NOT NULL, title TEXT NOT NULL, text TEXT NOT NULL, image BLOB, image_type TEXT,
 UNIQUE(announcement_id,position)
);
CREATE TABLE IF NOT EXISTS announcement_receipts(
 announcement_id TEXT NOT NULL REFERENCES announcements(id) ON DELETE CASCADE,
 member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE, seen_at TEXT NOT NULL, skipped INTEGER NOT NULL,
 PRIMARY KEY(announcement_id,member_id)
);
CREATE TABLE IF NOT EXISTS installed_update_history(version TEXT PRIMARY KEY,previous_version TEXT NOT NULL,activated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS announcement_due ON announcements(state,scheduled_at);
