CREATE TABLE IF NOT EXISTS bath_noncompletions(
 revision TEXT PRIMARY KEY, day TEXT NOT NULL, member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
 reported_at TEXT NOT NULL, source TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS bath_noncompletions_member ON bath_noncompletions(day,member_id);
CREATE VIEW IF NOT EXISTS active_booking_slots AS SELECT b.* FROM bookings b WHERE NOT EXISTS(SELECT 1 FROM bath_noncompletions n WHERE n.revision=b.revision);
DROP TRIGGER IF EXISTS booking_overlap_insert;
DROP TRIGGER IF EXISTS booking_overlap_update;
CREATE TRIGGER booking_overlap_insert BEFORE INSERT ON bookings
WHEN EXISTS(SELECT 1 FROM active_booking_slots WHERE day=NEW.day AND member_id!=NEW.member_id AND start<NEW.start+NEW.duration AND start+duration>NEW.start)
BEGIN SELECT RAISE(ABORT,'booking_overlap'); END;
CREATE TRIGGER booking_overlap_update BEFORE UPDATE ON bookings
WHEN EXISTS(SELECT 1 FROM active_booking_slots WHERE day=NEW.day AND member_id!=NEW.member_id AND start<NEW.start+NEW.duration AND start+duration>NEW.start)
BEGIN SELECT RAISE(ABORT,'booking_overlap'); END;
