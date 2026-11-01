// A booking belongs to the date on which its start falls. Its end may cross
// the grouping cutoff (and, with a late cutoff, a second midnight).
export function migrateCrossBoundaryBookings(db) {
  if (
    db
      .prepare(
        "SELECT name FROM schema_migrations WHERE name='0015_cross_boundary_bookings'",
      )
      .get()
  )
    return;
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const table of ["bookings", "wishes"]) {
      const source = db
        .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?")
        .get(table).sql;
      const rebuilt = source
        .replace(
          /^CREATE TABLE\s+(?:"[^"]+"|[a-z_]+)\s*/i,
          `CREATE TABLE ${table}_cutoff `,
        )
        .replace(/start\s*\+\s*duration\s*<=\s*2880/gi, "start+duration<=4320");
      if (rebuilt === source || !rebuilt.includes("start+duration<=4320"))
        throw new Error("予約テーブルの移行形式を確認できませんでした。");
      const extras = db
        .prepare(
          "SELECT sql FROM sqlite_master WHERE tbl_name=? AND type IN ('index','trigger') AND sql IS NOT NULL",
        )
        .all(table);
      db.exec(rebuilt);
      db.exec(
        `INSERT INTO ${table}_cutoff SELECT * FROM ${table}; DROP TABLE ${table}; ALTER TABLE ${table}_cutoff RENAME TO ${table}`,
      );
      for (const extra of extras) db.exec(extra.sql);
    }
    db.prepare(
      "INSERT INTO schema_migrations VALUES('0015_cross_boundary_bookings')",
    ).run();
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
