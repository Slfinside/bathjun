import { randomBytes } from "node:crypto";
import { getNotificationPreferences } from "./notification-preferences.js";
import { slotDate } from "./domain.js";
export function createWishNotifications({
  db,
  now,
  deliverPush,
  familyConfig,
  onQueued,
  isClosed,
  currentTurn,
}) {
  function record(wish, kind) {
    if(wish.start===null)return;
    const id = wish.revision + "-" + kind;
    let queued = false;
    const displaced = !!db
      .prepare(
        "SELECT displaced FROM wishes WHERE day=? AND member_id=? AND revision=?",
      )
      .get(wish.day, wish.member_id, wish.revision)?.displaced;
    db.exec("SAVEPOINT wish_notification_record");
    try {
      const result = db
        .prepare(
          "INSERT OR IGNORE INTO wish_outcomes(id,revision,day,member_id,kind,start,duration,displaced) VALUES(?,?,?,?,?,?,?,?)",
        )
        .run(
          id,
          wish.revision,
          wish.day,
          wish.member_id,
          kind,
          wish.start,
          wish.duration,
          displaced ? 1 : 0,
        );
      if (
        result.changes &&
        getNotificationPreferences(db, wish.member_id)[
          displaced ? "bookingDisplaced" : kind
        ]
      ) {
        const subs = db
          .prepare(
            "SELECT p.endpoint FROM push_subscriptions p JOIN sessions s ON s.token_hash=p.session_hash WHERE p.member_id=? AND s.expires>?",
          )
          .all(wish.member_id, now().getTime());
        for (const sub of subs)
          db.prepare(
            "INSERT INTO wish_notification_jobs(id,event_id,endpoint,next_attempt) VALUES(?,?,?,?)",
          ).run(
            randomBytes(16).toString("hex"),
            id,
            sub.endpoint,
            now().getTime(),
          );
        queued = !!subs.length;
      }
      db.exec("RELEASE wish_notification_record");
    } catch (error) {
      db.exec(
        "ROLLBACK TO wish_notification_record; RELEASE wish_notification_record",
      );
      throw error;
    }
    if (queued) onQueued();
  }
  async function flush() {
    const jobs = db
      .prepare(
        "SELECT j.id FROM wish_notification_jobs j WHERE j.sent=0 AND j.next_attempt<=? ORDER BY j.next_attempt LIMIT 20",
      )
      .all(now().getTime());
    for (const queuedJob of jobs) {
      if (isClosed()) return;
      const job = db.prepare("SELECT j.*,e.revision,e.day,e.member_id,e.kind,e.start,e.duration,e.displaced,p.subscription_json,p.member_id AS owner,s.expires,m.name,m.active FROM wish_notification_jobs j JOIN wish_outcomes e ON e.id=j.event_id JOIN push_subscriptions p ON p.endpoint=j.endpoint JOIN sessions s ON s.token_hash=p.session_hash JOIN members m ON m.id=e.member_id WHERE j.sent=0 AND j.next_attempt<=? AND j.id=?").get(now().getTime(), queuedJob.id);
      if (!job) continue;
      const valid = job.displaced
        ? true
        : job.kind === "wishConfirmed"
          ? db
              .prepare(
                "SELECT 1 FROM bookings WHERE day=? AND member_id=? AND auto_revision=?",
              )
              .get(job.day, job.member_id, job.revision)
          : db
              .prepare(
                "SELECT 1 FROM wishes WHERE day=? AND member_id=? AND revision=? AND (displaced=1 OR ?=member_id OR EXISTS(SELECT 1 FROM wish_start_attempts a WHERE a.revision=wishes.revision))",
              )
              .get(
                job.day,
                job.member_id,
                job.revision,
                currentTurn(job.day) ?? -1,
              ) ||
            db
              .prepare(
                "SELECT 1 FROM auto_wish_runs r WHERE r.day=? AND r.member_id=? AND r.revision=? AND r.status='rejected' AND NOT EXISTS(SELECT 1 FROM bookings b WHERE b.day=r.day AND b.member_id=r.member_id) AND NOT EXISTS(SELECT 1 FROM wishes w WHERE w.day=r.day AND w.member_id=r.member_id) AND NOT EXISTS(SELECT 1 FROM bath_skips s WHERE s.day=r.day AND s.member_id=r.member_id AND s.automatic=0)",
              )
              .get(job.day, job.member_id, job.revision);
      if (
        !valid ||
        !job.active ||
        job.owner !== job.member_id ||
        job.expires <= now().getTime() ||
        !getNotificationPreferences(db, job.member_id)[
          job.displaced ? "bookingDisplaced" : job.kind
        ] ||
        (job.kind === "wishConfirmed" &&
          slotDate(job.day, job.start + job.duration) <= now())
      ) {
        db.prepare("DELETE FROM wish_notification_jobs WHERE id=?").run(job.id);
        continue;
      }
      const time =
        (job.start >= 1440 ? "翌" : "") +
        String(Math.floor(job.start / 60) % 24).padStart(2, "0") +
        ":" +
        String(job.start % 60).padStart(2, "0");
      const config = familyConfig(),
        confirmed = job.kind === "wishConfirmed",
        displaced = !!job.displaced;
      try {
        await deliverPush(
          JSON.parse(job.subscription_json),
          {
            title: displaced
              ? "順番抜かしにより予約が希望へ戻りました"
              : confirmed
                ? "事前希望が確定しました ♨"
                : "事前希望を確定できませんでした",
            body: displaced
              ? `${job.day}の夜：${job.name}さんの${time}から${job.duration}分の予約は、順番抜かしにより事前希望へ戻りました。時間を選び直してください。`
              : confirmed
                ? `${job.day}の夜：${job.name}さんの${time}からの希望を予約として確定しました。`
                : `${job.day}の夜：${job.name}さんの希望は、ほかの予約・希望との重なりや時刻の条件により確定できませんでした。時間を確認してください。`,
            tag: `bath-wish-${displaced ? "displaced" : job.kind}-${job.day}-${job.member_id}`,
            day: job.day,
            url: "/",
          },
          { publicKey: config.vapid_public, privateKey: config.vapid_private },
        );
        if (isClosed()) return;
        db.prepare("UPDATE wish_notification_jobs SET sent=1 WHERE id=?").run(
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
            "UPDATE wish_notification_jobs SET attempts=?,next_attempt=? WHERE id=?",
          ).run(
            job.attempts + 1,
            now().getTime() +
              Math.min(3600000, 15000 * 2 ** Math.min(job.attempts + 1, 8)),
            job.id,
          );
      }
    }
  }
  return { record, flush };
}
