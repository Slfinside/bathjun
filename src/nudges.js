import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { getNotificationPreferences } from "./notification-preferences.js";
const HOUR = 3600000;
const reject = (status, message) => {
  throw Object.assign(new Error(message), { status });
};
export function createNudges({
  db,
  now,
  deliverPush,
  familyConfig,
  onQueued,
  isClosed,
  currentTurn,
  isDayOpen,
}) {
  db.exec(
    readFileSync(
      new URL("../migrations/0011_nudges.sql", import.meta.url),
      "utf8",
    ),
  );
  const subscriptions = (member) =>
    db
      .prepare(
        "SELECT p.endpoint FROM push_subscriptions p JOIN sessions s ON s.token_hash=p.session_hash WHERE p.member_id=? AND s.member_id=p.member_id AND s.expires>?",
      )
      .all(member, now().getTime());
  function status(day, sender) {
    const memberId = isDayOpen(day) ? currentTurn(day) : null;
    if (!memberId)
      return {
        memberId: null,
        canNudge: false,
        nextAllowedAt: null,
        reason: "closed",
      };
    const record = db
      .prepare("SELECT requested_at,sent_at FROM nudges WHERE member_id=?")
      .get(memberId);
    const nextAllowedAt = record
      ? Math.max(record.requested_at, record.sent_at || 0) + HOUR
      : null;
    const reason =
      sender === memberId
        ? "self"
        : nextAllowedAt > now().getTime()
          ? "cooldown"
          : !getNotificationPreferences(db, memberId).nudge
            ? "notifications-off"
            : !subscriptions(memberId).length
              ? "unsubscribed"
              : null;
    return { memberId, canNudge: reason === null, nextAllowedAt, reason };
  }
  function request(day, sender, member) {
    db.exec("BEGIN IMMEDIATE");
    try {
      const value = status(day, sender);
      if (!Number.isInteger(member) || value.memberId !== member)
        reject(409, "予約する番の人が変わりました。表示を更新してください。");
      if (value.reason === "self")
        reject(403, "自分をつつくことはできません。");
      if (value.reason === "cooldown")
        reject(429, "この人はつつかれたばかりです。1時間に1回までつつけます。");
      if (!value.canNudge)
        reject(
          409,
          "この人への通知を送れません。通知設定を確認してもらってください。",
        );
      const id = randomBytes(16).toString("hex"),
        stamp = now().getTime();
      db.prepare("DELETE FROM nudges WHERE member_id=?").run(member);
      db.prepare(
        "INSERT INTO nudges(member_id,id,day,sender_id,requested_at) VALUES(?,?,?,?,?)",
      ).run(member, id, day, sender, stamp);
      for (const sub of subscriptions(member))
        db.prepare(
          "INSERT INTO nudge_jobs(id,nudge_id,endpoint,next_attempt) VALUES(?,?,?,?)",
        ).run(randomBytes(16).toString("hex"), id, sub.endpoint, stamp);
      db.exec("COMMIT");
      onQueued();
      return { ok: true, nextAllowedAt: stamp + HOUR };
    } catch (error) {
      if (db.isTransaction) db.exec("ROLLBACK");
      throw error;
    }
  }
  async function flush() {
    if (isClosed()) return;
    const jobs = db
      .prepare(
        "SELECT j.*,n.member_id,n.day,n.requested_at,p.subscription_json,p.member_id AS owner,s.member_id AS session_member,s.expires FROM nudge_jobs j JOIN nudges n ON n.id=j.nudge_id JOIN push_subscriptions p ON p.endpoint=j.endpoint JOIN sessions s ON s.token_hash=p.session_hash WHERE j.next_attempt<=? ORDER BY j.next_attempt LIMIT 20",
      )
      .all(now().getTime());
    for (const job of jobs) {
      if (isClosed()) return;
      if (!db.prepare("SELECT 1 FROM nudge_jobs WHERE id=?").get(job.id))
        continue;
      if (
        job.expires <= now().getTime() ||
        job.owner !== job.member_id ||
        job.session_member !== job.member_id ||
        !isDayOpen(job.day) ||
        currentTurn(job.day) !== job.member_id ||
        !getNotificationPreferences(db, job.member_id).nudge ||
        now().getTime() >= job.requested_at + HOUR
      ) {
        db.prepare("DELETE FROM nudge_jobs WHERE id=?").run(job.id);
        continue;
      }
      try {
        const config = familyConfig();
        await deliverPush(
          JSON.parse(job.subscription_json),
          {
            title: "お風呂を予約しましょう。",
            body: "つつかれました。あなたの予約を待っています。",
            tag: `bath-nudge-${job.nudge_id}`,
            day: job.day,
            url: "/",
          },
          { publicKey: config.vapid_public, privateKey: config.vapid_private },
          {
            ttl: Math.max(
              1,
              Math.min(
                300,
                Math.floor((job.requested_at + HOUR - now().getTime()) / 1000),
              ),
            ),
          },
        );
        if (isClosed()) return;
        db.prepare(
          "UPDATE nudges SET sent_at=COALESCE(sent_at,?) WHERE id=?",
        ).run(now().getTime(), job.nudge_id);
        db.prepare("DELETE FROM nudge_jobs WHERE id=?").run(job.id);
      } catch (error) {
        if (isClosed()) return;
        if (error.statusCode === 404 || error.statusCode === 410)
          db.prepare("DELETE FROM push_subscriptions WHERE endpoint=?").run(
            job.endpoint,
          );
        else
          db.prepare(
            "UPDATE nudge_jobs SET attempts=?,next_attempt=? WHERE id=?",
          ).run(
            job.attempts + 1,
            Math.min(
              job.requested_at + HOUR,
              now().getTime() +
                Math.min(3600000, 15000 * 2 ** Math.min(job.attempts + 1, 8)),
            ),
            job.id,
          );
      }
    }
  }
  return { status, request, flush };
}
