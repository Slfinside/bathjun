import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { bathCalendar, shiftDay } from "./bath-calendar.js";
import { slotDate, validateSlot } from "./domain.js";
const weekday = (day) => new Date(day + "T12:00:00Z").getUTCDay();
const bad = (message) => {
  throw Object.assign(new Error(message), { status: 400 });
};
export function createAutoWishes({
  db,
  now,
  scheduleForDay,
  onRejected,
  currentTurn,
}) {
  db.exec(
    readFileSync(
      new URL("../migrations/0017_auto_wishes.sql", import.meta.url),
      "utf8",
    ),
  );
  for (const table of ["wishes", "bookings"]) {
    if (
      !db
        .prepare(`PRAGMA table_info(${table})`)
        .all()
        .some((c) => c.name === "automatic")
    ) {
      db.exec(
        `ALTER TABLE ${table} ADD COLUMN automatic INTEGER NOT NULL DEFAULT 0 CHECK(automatic IN (0,1))`,
      );
      const revision = table === "wishes" ? "revision" : "auto_revision";
      db.exec(
        `UPDATE ${table} SET automatic=1 WHERE ${revision} IN (SELECT revision FROM auto_wish_runs WHERE status='submitted')`,
      );
    }
  }
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
          (d.mode !== undefined &&
            !["reservation", "standby", "disabled"].includes(d.mode)) ||
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
          (d.mode ? d.mode === "reservation" : d.enabled) &&
          !validateSlot(relativeStart(d.start, rule), d.duration, rule)
        )
          bad(
            "開始時刻と長さは、管理者が設定した刻み幅・上限に合わせてください。",
          );
        return {
          weekday: d.weekday,
          enabled: d.mode ? d.mode === "reservation" : d.enabled,
          ...(d.mode !== undefined ? { mode: d.mode } : {}),
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
  function planFor(day, member) {
    if (
      !member ||
      !db.prepare("SELECT 1 FROM members WHERE id=? AND active=1").get(member)
    )
      return null;
    return (
      get(member).days.find((d) => d.weekday === weekday(day) && d.enabled) ||
      null
    );
  }
  function ready(day, member) {
    return (
      !!planFor(day, member) &&
      !db
        .prepare("SELECT 1 FROM auto_wish_runs WHERE day=? AND member_id=?")
        .get(day, member)
    );
  }
  function suppress(day, member) {
    if (!planFor(day, member)) return;
    db.prepare(
      "INSERT OR IGNORE INTO auto_wish_runs VALUES(?,?,'skipped',?,?)",
    ).run(day, member, randomBytes(16).toString("hex"), now().toISOString());
  }
  function apply(day, member) {
    if (!ready(day, member)) return false;
    const plan = planFor(day, member),
      rule = scheduleForDay(day);
    db.exec("SAVEPOINT automatic_wishes");
    try {
      const revision = randomBytes(16).toString("hex"),
        start = relativeStart(plan.start, rule);
      const existing = db
        .prepare(
          "SELECT 1 FROM bookings WHERE day=? AND member_id=? UNION ALL SELECT 1 FROM wishes WHERE day=? AND member_id=? UNION ALL SELECT 1 FROM bath_skips WHERE day=? AND member_id=? AND automatic=0",
        )
        .get(day, member, day, member, day, member);
      const rejected =
        !validateSlot(start, plan.duration, rule) ||
        slotDate(day, start) <= now();
      const status = existing ? "skipped" : rejected ? "rejected" : "submitted";
      db.prepare("INSERT INTO auto_wish_runs VALUES(?,?,?,?,?)").run(
        day,
        member,
        status,
        revision,
        now().toISOString(),
      );
      if (!existing) {
        const wish = {
          day,
          member_id: member,
          start,
          duration: plan.duration,
          note: plan.note,
          revision,
        };
        if (rejected) onRejected(wish);
        else
          db.prepare(
            "INSERT INTO wishes(day,member_id,start,duration,note,revision,ticket,displaced,automatic) VALUES(?,?,?,?,?,?,NULL,0,1)",
          ).run(day, member, start, plan.duration, plan.note, revision);
      }
      db.exec("RELEASE automatic_wishes");
      return !existing && !rejected;
    } catch (error) {
      db.exec("ROLLBACK TO automatic_wishes; RELEASE automatic_wishes");
      throw error;
    }
  }
  function hasPlans(day) {
    return enabledMembers().some((row) =>
      JSON.parse(row.days_json).some(
        (d) =>
          d.weekday === weekday(day) && (d.enabled || d.mode === "standby"),
      ),
    );
  }
  function dueAt() {
    const today = bathCalendar(now()).today;
    for (const day of [shiftDay(today, -1), today])
      if (ready(day, currentTurn(day))) return now().getTime();
    if (
      scheduleForDay(today).orderMode === "fixed" &&
      hasPlans(today) &&
      !db.prepare("SELECT 1 FROM draws WHERE day=?").get(today)
    )
      return now().getTime();
    let due = null;
    for (const row of enabledMembers()) {
      const plans = JSON.parse(row.days_json);
      for (let offset = 1; offset <= 7; offset++) {
        const day = shiftDay(today, offset);
        if (
          !plans.some(
            (d) =>
              d.weekday === weekday(day) && (d.enabled || d.mode === "standby"),
          )
        )
          continue;
        const value = slotDate(day, 0).getTime();
        due = due === null ? value : Math.min(due, value);
        break;
      }
    }
    return due;
  }
  function standbyForDay(day, member) {
    const plan = get(member).days.find((d) => d.weekday === weekday(day));
    return plan?.mode !== undefined
      ? plan.mode === "standby"
      : !!db.prepare("SELECT auto_standby FROM members WHERE id=?").get(member)
          ?.auto_standby;
  }
  return { get, save, apply, ready, suppress, hasPlans, dueAt, standbyForDay };
}
