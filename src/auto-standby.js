export function createAutoStandby(db, enabledForDay = null) {
  if (
    !db
      .prepare("PRAGMA table_info(bath_skips)")
      .all()
      .some((column) => column.name === "automatic")
  )
    db.exec(
      "ALTER TABLE bath_skips ADD COLUMN automatic INTEGER NOT NULL DEFAULT 0 CHECK(automatic IN (0,1))",
    );
  function apply(day) {
    let changed = false;
    db.exec("SAVEPOINT initialize_daily_standby");
    try {
      for (const member of db
        .prepare(
          "SELECT id,auto_standby FROM members WHERE active=1 ORDER BY id",
        )
        .all()) {
        if (
          db
            .prepare(
              "SELECT 1 FROM daily_standby_state WHERE day=? AND member_id=?",
            )
            .get(day, member.id)
        )
          continue;
        const planned = db
          .prepare("SELECT 1 FROM bookings WHERE day=? AND member_id=?")
          .get(day, member.id);
        const deferred = db
          .prepare("SELECT 1 FROM bath_skips WHERE day=? AND member_id=?")
          .get(day, member.id);
        const automatic =
          (enabledForDay
            ? enabledForDay(day, member.id)
            : !!member.auto_standby) &&
          !planned &&
          !deferred;
        if (automatic) {
          const position = db
            .prepare(
              "SELECT COALESCE(MAX(tail_order),0)+1 AS position FROM bath_skips WHERE day=?",
            )
            .get(day).position;
          db.prepare(
            "INSERT INTO bath_skips(day,member_id,tail_order,automatic) VALUES(?,?,?,1)",
          ).run(day, member.id, position);
          changed = true;
        }
        db.prepare("INSERT INTO daily_standby_state VALUES(?,?,?)").run(
          day,
          member.id,
          automatic ? 1 : 0,
        );
      }
      db.exec("RELEASE initialize_daily_standby");
    } catch (error) {
      db.exec(
        "ROLLBACK TO initialize_daily_standby; RELEASE initialize_daily_standby",
      );
      throw error;
    }
    return changed;
  }
  const enabled = (memberId) =>
    !!db.prepare("SELECT auto_standby FROM members WHERE id=?").get(memberId)
      ?.auto_standby;
  function set(memberId, value) {
    if (typeof value !== "boolean")
      throw new Error("自動で様子見にする設定は有効・無効で選んでください。");
    const preferences = db
      .prepare("SELECT days_json FROM auto_wish_preferences WHERE member_id=?")
      .get(memberId);
    if (preferences) {
      const days = JSON.parse(preferences.days_json).map(
        ({ mode, ...day }) => day,
      );
      db.prepare(
        "UPDATE auto_wish_preferences SET days_json=? WHERE member_id=?",
      ).run(JSON.stringify(days), memberId);
    }
    db.prepare("UPDATE members SET auto_standby=? WHERE id=?").run(
      value ? 1 : 0,
      memberId,
    );
    return value;
  }
  return { apply, enabled, set };
}
