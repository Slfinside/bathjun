CREATE TABLE IF NOT EXISTS reservation_policy (
 id INTEGER PRIMARY KEY CHECK(id=1),
 ignore_lower_priority_wishes INTEGER NOT NULL DEFAULT 1 CHECK(ignore_lower_priority_wishes IN (0,1))
);
INSERT OR IGNORE INTO reservation_policy VALUES(1,1);
CREATE TABLE IF NOT EXISTS daily_standby_state (
 day TEXT NOT NULL,
 member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
 auto_applied INTEGER NOT NULL CHECK(auto_applied IN (0,1)),
 PRIMARY KEY(day,member_id)
);
