CREATE TABLE IF NOT EXISTS unreserved_baths(
 id TEXT PRIMARY KEY,
 request_id TEXT NOT NULL UNIQUE,
 day TEXT NOT NULL,
 member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
 start INTEGER NOT NULL,
 duration INTEGER NOT NULL CHECK(duration>0),
 note TEXT NOT NULL DEFAULT '',
 reported_at TEXT NOT NULL,
 source TEXT NOT NULL,
 UNIQUE(day,member_id,start,duration)
);
CREATE INDEX IF NOT EXISTS unreserved_baths_day ON unreserved_baths(day,start);
CREATE VIEW IF NOT EXISTS bath_successes AS
 SELECT day,member_id,MIN(reported_at) AS reported_at FROM (
  SELECT day,member_id,reported_at FROM bath_completions
  UNION ALL SELECT day,member_id,reported_at FROM unreserved_baths
 ) GROUP BY day,member_id;
