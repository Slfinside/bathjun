CREATE TABLE schedule_settings (effective_day TEXT PRIMARY KEY, value_json TEXT NOT NULL);
CREATE TABLE schema_migrations (name TEXT PRIMARY KEY);
CREATE TABLE bookings_configurable (
 day TEXT NOT NULL REFERENCES draws(day), member_id INTEGER NOT NULL REFERENCES members(id),
 start INTEGER NOT NULL CHECK(start BETWEEN 0 AND 2879), duration INTEGER NOT NULL CHECK(duration BETWEEN 1 AND 1440),
 note TEXT NOT NULL DEFAULT '' CHECK(length(note)<=300), no_negotiation INTEGER NOT NULL DEFAULT 0 CHECK(no_negotiation IN (0,1)),
 CHECK(start+duration<=2880), PRIMARY KEY(day,member_id)
);
INSERT INTO bookings_configurable SELECT day,member_id,start,duration,note,no_negotiation FROM bookings;
DROP TABLE bookings;
ALTER TABLE bookings_configurable RENAME TO bookings;
CREATE TRIGGER booking_overlap_insert BEFORE INSERT ON bookings
WHEN EXISTS (SELECT 1 FROM bookings WHERE day=NEW.day AND member_id!=NEW.member_id AND start<NEW.start+NEW.duration AND start+duration>NEW.start)
BEGIN SELECT RAISE(ABORT, 'booking_overlap'); END;
CREATE TRIGGER booking_overlap_update BEFORE UPDATE ON bookings
WHEN EXISTS (SELECT 1 FROM bookings WHERE day=NEW.day AND member_id!=NEW.member_id AND start<NEW.start+NEW.duration AND start+duration>NEW.start)
BEGIN SELECT RAISE(ABORT, 'booking_overlap'); END;
CREATE TABLE wishes_configurable (
 day TEXT NOT NULL, member_id INTEGER NOT NULL REFERENCES members(id),
 start INTEGER NOT NULL CHECK(start BETWEEN 0 AND 2879), duration INTEGER NOT NULL CHECK(duration BETWEEN 1 AND 1440),
 note TEXT NOT NULL DEFAULT '' CHECK(length(note)<=300), CHECK(start+duration<=2880), PRIMARY KEY(day,member_id)
);
INSERT INTO wishes_configurable SELECT day,member_id,start,duration,note FROM wishes;
DROP TABLE wishes;
ALTER TABLE wishes_configurable RENAME TO wishes;
INSERT INTO schema_migrations VALUES ('0005_server_settings');
