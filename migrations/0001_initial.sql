CREATE TABLE members (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  password_hash TEXT,
  salt TEXT,
  failures INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  member_id INTEGER NOT NULL REFERENCES members(id),
  expires INTEGER NOT NULL
);
CREATE TABLE draws (
  day TEXT PRIMARY KEY,
  order_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE bookings (
  day TEXT NOT NULL REFERENCES draws(day),
  member_id INTEGER NOT NULL REFERENCES members(id),
  start INTEGER NOT NULL CHECK(start >= 900 AND start % 15 = 0),
  duration INTEGER NOT NULL CHECK(duration BETWEEN 15 AND 90 AND duration % 15 = 0),
  CHECK(start + duration <= 1860),
  PRIMARY KEY(day, member_id)
);
CREATE TRIGGER booking_overlap_insert BEFORE INSERT ON bookings
WHEN EXISTS (SELECT 1 FROM bookings WHERE day=NEW.day AND member_id!=NEW.member_id AND start<NEW.start+NEW.duration AND start+duration>NEW.start)
BEGIN SELECT RAISE(ABORT, 'booking_overlap'); END;
CREATE TRIGGER booking_overlap_update BEFORE UPDATE ON bookings
WHEN EXISTS (SELECT 1 FROM bookings WHERE day=NEW.day AND member_id!=NEW.member_id AND start<NEW.start+NEW.duration AND start+duration>NEW.start)
BEGIN SELECT RAISE(ABORT, 'booking_overlap'); END;
CREATE INDEX sessions_expiry ON sessions(expires);
