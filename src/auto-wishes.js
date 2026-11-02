import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { bathCalendar, shiftDay } from "./bath-calendar.js";
import { slotDate, validateSlot } from "./domain.js";
const weekday = (day) => new Date(day + "T12:00:00Z").getUTCDay();
const bad = (message) => {
  throw Object.assign(new Error(message), { status: 400 });
};
export function createAutoWishes({ db, now, scheduleForDay, onRejected }) {
  db.exec(
    readFileSync(
      new URL("../migrations/0017_auto_wishes.sql", import.meta.url),
      "utf8",
    ),
  );
  const defaults = () =>
    Array.from({ length: 7 }, (_, weekday) => ({
      weekday,
      enabled: false,
      start: 1080,
      duration: 30,
      note: "",
    }));
  function get(member) {
    const row = db
      .prepare("SELECT days_json FROM auto_wish_preferences WHERE member_id=?")
      .get(member);
    return { days: row ? JSON.parse(row.days_json) : defaults() };
  }
  const relativeStart = (clockStart, rule) =>
    clockStart < rule.bathStart ? clockStart + 1440 : clockStart;
  function save(member, value) {
    const days = value?.days,
      today = bathCalendar(now()).today;
    if (
      !Array.isArray(days) ||
      days.length !== 7 ||
      new Set(days.map((d) => d?.weekday)).size !== 7
    )
      bad("曜日ごとの自動予約設定を確認してください。");
    const normalized = days
      .map((d) => {
        if (
          !d ||
          !Number.isInteger(d.weekday) ||
          d.weekday < 0 ||
          d.weekday > 6 ||
          typeof d.enabled !== "boolean" ||
          !Number.isInteger(d.start) ||
          d.start < 0 ||
          d.start >= 1440 ||
          !Number.isInteger(d.duration) ||
          d.duration < 1 ||
          d.duration > 1440 ||
          typeof d.note !== "string" ||
          d.note.length > 300
        )
          bad("曜日・開始時刻・長さ・備考を確認してください。");
        const day = shiftDay(today, (d.weekday - weekday(today) + 7) % 7),
          rule = scheduleForDay(day);
        if (
          d.enabled &&
          !validateSlot(relativeStart(d.start, rule), d.duration, rule)
        )
          bad(
            "開始時刻と長さは、管理者が設定した刻み幅・上限に合わせてください。",
          );
        return {
          weekday: d.weekday,
          enabled: d.enabled,
          start: d.start,
          duration: d.duration,
          note: d.note.trim(),
        };
      })
      .sort((a, b) => a.weekday - b.weekday);
    db.prepare(
      "INSERT INTO auto_wish_preferences VALUES(?,?) ON CONFLICT(member_id) DO UPDATE SET days_json=excluded.days_json",
    ).run(member, JSON.stringify(normalized));
    return get(member);
  }
  function enabledMembers() {
    return db
      .prepare(
        "SELECT p.member_id,p.days_json FROM auto_wish_preferences p JOIN members m ON m.id=p.member_id WHERE m.active=1",
      )
      .all();
  }
  function apply() {
    const today = bathCalendar(now()).today,
      rule = scheduleForDay(today);
    let changed = false;
    db.exec("SAVEPOINT automatic_wishes");
    try {
      for (const row of enabledMembers()) {
        const plan = JSON.parse(row.days_json).find(
          (d) => d.weekday === weekday(today),
        );
        if (
          !plan?.enabled ||
          db
            .prepare("SELECT 1 FROM auto_wish_runs WHERE day=? AND member_id=?")
            .get(today, row.member_id)
        )
          continue;
        const revision = randomBytes(16).toString("hex"),
          start = relativeStart(plan.start, rule);
        const existing = db
          .prepare(
            "SELECT 1 FROM bookings WHERE day=? AND member_id=? UNION ALL SELECT 1 FROM wishes WHERE day=? AND member_id=? UNION ALL SELECT 1 FROM bath_skips WHERE day=? AND member_id=? AND automatic=0",
          )
          .get(
            today,
            row.member_id,
            today,
            row.member_id,
            today,
            row.member_id,
          );
        const rejected =
          !validateSlot(start, plan.duration, rule) ||
          slotDate(today, start) <= now();
        const status = existing
          ? "skipped"
          : rejected
            ? "rejected"
            : "submitted";
        db.prepare("INSERT INTO auto_wish_runs VALUES(?,?,?,?,?)").run(
          today,
          row.member_id,
          status,
          revision,
          now().toISOString(),
        );
        if (existing) continue;
        const wish = {
          day: today,
          member_id: row.member_id,
          start,
          duration: plan.duration,
          note: plan.note,
          revision,
        };
        if (rejected) {
          onRejected(wish);
          continue;
        }
        db.prepare(
          "INSERT INTO wishes(day,member_id,start,duration,note,revision,ticket,displaced) VALUES(?,?,?,?,?,?,NULL,0)",
        ).run(today, row.member_id, start, plan.duration, plan.note, revision);
        changed = true;
      }
      db.exec("RELEASE automatic_wishes");
    } catch (error) {
      db.exec("ROLLBACK TO automatic_wishes; RELEASE automatic_wishes");
      throw error;
    }
    return changed;
  }
  function dueAt() {
    const today = bathCalendar(now()).today;
    let due = null;
    for (const row of enabledMembers()) {
      const plans = JSON.parse(row.days_json);
      for (let offset = 0; offset <= 7; offset++) {
        const day = shiftDay(today, offset);
        if (!plans.find((d) => d.weekday === weekday(day))?.enabled) continue;
        if (
          offset === 0 &&
          db
            .prepare("SELECT 1 FROM auto_wish_runs WHERE day=? AND member_id=?")
            .get(day, row.member_id)
        )
          continue;
        const value = slotDate(day, 0).getTime();
        due = due === null ? value : Math.min(due, value);
        break;
      }
    }
    return due;
  }
  return { get, save, apply, dueAt };
}
