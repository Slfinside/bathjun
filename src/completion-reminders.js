import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { slotDate } from "./domain.js";
import { getNotificationPreferences } from "./notification-preferences.js";

export function createCompletionReminders({
  db,
  now,
  deliverPush,
  familyConfig,
  onQueued,
  isClosed,
  reportMinutes,
}) {
  db.exec(
    readFileSync(
      new URL("../migrations/0013_completion_reminders.sql", import.meta.url),
      "utf8",
    ),
  );
  const bookingFor = (day, member) =>
    db
      .prepare(
        "SELECT b.*,m.active FROM bookings b JOIN members m ON m.id=b.member_id WHERE b.day=? AND b.member_id=? AND NOT EXISTS(SELECT 1 FROM bath_completions c WHERE c.day=b.day AND c.member_id=b.member_id)",
      )
      .get(day, member);
  const endsAt = (booking) =>
    slotDate(booking.day, booking.start + booking.duration).getTime();
  function syncMember(day, member) {
    const booking = bookingFor(day, member);
    const enabled = getNotificationPreferences(db, member).completionReminder;
    if (
      !booking ||
      !booking.active ||
      now().getTime() > endsAt(booking) + reportMinutes() * 60000
    ) {
      if (
        db
          .prepare(
            "DELETE FROM completion_reminders WHERE day=? AND member_id=?",
          )
          .run(day, member).changes
      )
        onQueued();
      return;
    }
    let changed = db
      .prepare(
        "DELETE FROM completion_reminders WHERE day=? AND member_id=? AND (revision!=? OR (sent=0 AND ?=0))",
      )
      .run(day, member, booking.revision, enabled ? 1 : 0).changes;
    if (enabled)
      for (const sub of db
        .prepare(
          "SELECT p.endpoint FROM push_subscriptions p JOIN sessions s ON s.token_hash=p.session_hash WHERE p.member_id=? AND s.member_id=p.member_id AND s.expires>?",
        )
        .all(member, now().getTime()))
        changed += db
          .prepare(
            "INSERT OR IGNORE INTO completion_reminders(id,endpoint,day,member_id,revision,next_attempt) VALUES(?,?,?,?,?,?)",
          )
          .run(
            randomBytes(16).toString("hex"),
            sub.endpoint,
            day,
            member,
            booking.revision,
            Math.max(now().getTime(), endsAt(booking)),
          ).changes;
    if (changed) onQueued();
  }
  function syncDay(day) {
    for (const row of db
      .prepare(
        "SELECT member_id FROM bookings WHERE day=? UNION SELECT member_id FROM completion_reminders WHERE day=?",
      )
      .all(day, day))
      syncMember(day, row.member_id);
  }
  function restore(member = null) {
    const rows =
      member === null
        ? db
            .prepare(
              "SELECT day,member_id FROM bookings UNION SELECT day,member_id FROM completion_reminders",
            )
            .all()
        : db
            .prepare(
              "SELECT day,member_id FROM bookings WHERE member_id=? UNION SELECT day,member_id FROM completion_reminders WHERE member_id=?",
            )
            .all(member, member);
    for (const row of rows) syncMember(row.day, row.member_id);
  }
  async function flush() {
    if (isClosed()) return;
    const jobs = db
      .prepare(
        "SELECT r.*,p.subscription_json,p.member_id AS owner,s.member_id AS session_member,s.expires FROM completion_reminders r JOIN push_subscriptions p ON p.endpoint=r.endpoint JOIN sessions s ON s.token_hash=p.session_hash WHERE r.sent=0 AND r.next_attempt<=? ORDER BY r.next_attempt LIMIT 20",
      )
      .all(now().getTime());
    for (const job of jobs) {
      if (isClosed()) return;
      const booking = bookingFor(job.day, job.member_id);
      const deadline = booking ? endsAt(booking) + reportMinutes() * 60000 : 0;
      if (
        !booking ||
        !booking.active ||
        booking.revision !== job.revision ||
        job.owner !== job.member_id ||
        job.session_member !== job.member_id ||
        job.expires <= now().getTime() ||
        !getNotificationPreferences(db, job.member_id).completionReminder ||
        now().getTime() > deadline
      ) {
        db.prepare("DELETE FROM completion_reminders WHERE id=?").run(job.id);
        continue;
      }
      // Clock changes must never turn a retry into an early notification.
      if (now().getTime() < endsAt(booking)) {
        db.prepare(
          "UPDATE completion_reminders SET next_attempt=? WHERE id=?",
        ).run(endsAt(booking), job.id);
        continue;
      }
      const keys = familyConfig();
      try {
        await deliverPush(
          JSON.parse(job.subscription_json),
          {
            title: "入浴完了を報告しましょう",
            body: "おふろの予約時間が終了しました。上がったら入浴完了を報告してください。",
            tag: `bath-completion-${job.day}-${job.member_id}`,
            day: job.day,
            url: "/",
          },
          { publicKey: keys.vapid_public, privateKey: keys.vapid_private },
          { ttl: Math.max(1, Math.floor((deadline - now().getTime()) / 1000)) },
        );
        if (isClosed()) return;
        db.prepare("UPDATE completion_reminders SET sent=1 WHERE id=?").run(
          job.id,
        );
      } catch (error) {
        if (isClosed()) return;
        if (error.statusCode === 404 || error.statusCode === 410)
          db.prepare("DELETE FROM push_subscriptions WHERE endpoint=?").run(
            job.endpoint,
          );
        else
          db.prepare(
            "UPDATE completion_reminders SET attempts=attempts+1,next_attempt=? WHERE id=?",
          ).run(
            Math.min(
              deadline + 1,
              now().getTime() +
                Math.min(60000, 15000 * 2 ** Math.min(job.attempts, 3)),
            ),
            job.id,
          );
      }
    }
  }
  return {
    syncDay,
    restore,
    flush,
    clearEndpoint(endpoint) {
      db.prepare("DELETE FROM completion_reminders WHERE endpoint=?").run(
        endpoint,
      );
      onQueued();
    },
  };
}
