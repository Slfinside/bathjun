CREATE TABLE IF NOT EXISTS bath_skips (
 day TEXT NOT NULL, member_id INTEGER NOT NULL REFERENCES members(id),
 PRIMARY KEY(day,member_id)
);
CREATE TABLE IF NOT EXISTS wishes (
 day TEXT NOT NULL, member_id INTEGER NOT NULL REFERENCES members(id),
 start INTEGER NOT NULL CHECK(start>=900 AND start%15=0),
 duration INTEGER NOT NULL CHECK(duration BETWEEN 15 AND 90 AND duration%15=0),
 note TEXT NOT NULL DEFAULT '' CHECK(length(note)<=300),
 CHECK(start+duration<=1860), PRIMARY KEY(day,member_id)
);
