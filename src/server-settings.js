import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
export const DEFAULT_SCHEDULE = Object.freeze({
  bathStart: 900,
  bathEnd: 1860,
  lotteryTimeRestricted: false,
  lotteryStart: 360,
  lotteryEnd: 900,
  minDuration: 15,
  maxDuration: 90,
  step: 15,
  orderMode: "random",
  fixedOrder: [],
});
export function rawJapanDate(now) {
  return new Date(now.getTime() + 9 * 3600000).toISOString().slice(0, 10);
}
export function nextDay(day) {
  return new Date(new Date(day + "T12:00:00Z").getTime() + 86400000)
    .toISOString()
    .slice(0, 10);
}
export function validateSchedule(schedule) {
  if (!schedule || typeof schedule !== "object")
    throw new Error("時間設定を確認してください。");
  const numericKeys = [
    "bathStart",
    "bathEnd",
    "lotteryStart",
    "lotteryEnd",
    "minDuration",
    "maxDuration",
    "step",
  ];
  const result = {
    ...Object.fromEntries(numericKeys.map((key) => [key, schedule[key]])),
    lotteryTimeRestricted: schedule.lotteryTimeRestricted ?? false,
    orderMode: schedule.orderMode || "random",
    fixedOrder: [],
  };
  if (typeof result.lotteryTimeRestricted !== "boolean")
    throw new Error("抽選時間の制限を確認してください。");
  if (!["random", "fixed"].includes(result.orderMode))
    throw new Error("予約順は抽選または固定順から選んでください。");
  if (numericKeys.some((key) => !Number.isInteger(result[key])))
    throw new Error("時刻と時間は分単位の整数で設定してください。");
  const {
    bathStart,
    bathEnd,
    lotteryStart,
    lotteryEnd,
    minDuration,
    maxDuration,
    step,
  } = result;
  if (![5, 10, 15, 30].includes(step))
    throw new Error("予約の刻み幅は5・10・15・30分から選んでください。");
  if (
    bathStart < 0 ||
    bathStart >= 1440 ||
    bathEnd <= bathStart ||
    bathEnd > bathStart + 1440 ||
    bathEnd > 2880 ||
    bathStart % step ||
    bathEnd % step
  )
    throw new Error(
      "入浴時間帯は24時間以内で、刻み幅に合う開始・終了時刻を設定してください。",
    );
  if (
    lotteryStart < 0 ||
    lotteryStart >= lotteryEnd ||
    lotteryEnd > 1440 ||
    (result.lotteryTimeRestricted && result.orderMode === "random" && lotteryEnd > bathStart)
  )
    throw new Error(
      "抽選は同日の入浴開始時刻までに終わる時間帯にしてください。",
    );
  if (
    minDuration < step ||
    maxDuration < minDuration ||
    maxDuration > Math.min(1440, bathEnd - bathStart) ||
    minDuration % step ||
    maxDuration % step
  )
    throw new Error(
      "予約時間の最小・最大は、刻み幅の倍数で入浴時間帯に収まる値にしてください。",
    );
  return result;
}
export function createServerSettings(db, now) {
  const migrated = db
    .prepare("SELECT name FROM sqlite_master WHERE name='schema_migrations'")
    .get();
  if (!migrated) {
    db.exec("BEGIN IMMEDIATE");
    try {
      if (
        !db
          .prepare(
            "SELECT name FROM sqlite_master WHERE name='schema_migrations'",
          )
          .get()
      ) {
        if (
          !db
            .prepare("PRAGMA table_info(members)")
            .all()
            .some((column) => column.name === "active")
        )
          db.exec(
            "ALTER TABLE members ADD COLUMN active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1))",
          );
        db.exec(
          readFileSync(
            new URL("../migrations/0005_server_settings.sql", import.meta.url),
            "utf8",
          ),
        );
        db.prepare("INSERT INTO schedule_settings VALUES(?,?)").run(
          "0000-01-01",
          JSON.stringify(DEFAULT_SCHEDULE),
        );
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  const scheduleForDay = (day) => ({
    ...DEFAULT_SCHEDULE,
    ...JSON.parse(
      db
        .prepare(
          "SELECT value_json FROM schedule_settings WHERE effective_day<=? ORDER BY effective_day DESC LIMIT 1",
        )
        .get(day).value_json,
    ),
  });
  function get() {
    const today = rawJapanDate(now()),
      effectiveDay = nextDay(today);
    const upcoming = scheduleForDay(effectiveDay);
    const members = db
      .prepare("SELECT id,name,active FROM members ORDER BY id")
      .all()
      .map((member) => ({ ...member, active: !!member.active }));
    if (upcoming.fixedOrder.length)
      members.sort((a, b) => {
        const rank = (id) => {
          const index = upcoming.fixedOrder.indexOf(id);
          return index < 0 ? 1000 + id : index;
        };
        return rank(a.id) - rank(b.id);
      });
    return { members, current: scheduleForDay(today), upcoming, effectiveDay };
  }
  function save(payload) {
    if (
      !payload ||
      !Array.isArray(payload.members) ||
      payload.members.length > 50
    )
      throw new Error("メンバーは1〜50人で設定してください。");
    const schedule = validateSchedule(payload.schedule),
      existing = db.prepare("SELECT id,active FROM members").all();
    const members = payload.members.map((member) => {
      if (
        !member ||
        typeof member.name !== "string" ||
        typeof member.active !== "boolean"
      )
        throw new Error("メンバー名と利用状態を確認してください。");
      const name = member.name.trim().normalize("NFC");
      if (!name || name.length > 30 || /[\x00-\x1f\x7f]/.test(name))
        throw new Error("メンバー名は1〜30文字で設定してください。");
      const id = member.id || null;
      if (
        id !== null &&
        (!Number.isInteger(id) || !existing.some((row) => row.id === id))
      )
        throw new Error("既存のメンバーを読み込み直してください。");
      return { id, name, active: member.active };
    });
    if (
      new Set(members.map((member) => member.name)).size !== members.length ||
      new Set(members.filter((member) => member.id).map((member) => member.id))
        .size !== members.filter((member) => member.id).length
    )
      throw new Error("同じメンバーや名前が重複しています。");
    if ((members.length || existing.length) && !members.some((member) => member.active))
      throw new Error("利用するメンバーを1人以上設定してください。");
    if (existing.some((row) => !members.some((member) => member.id === row.id)))
      throw new Error(
        "履歴を残すため既存メンバーは削除せず、利用するチェックを外してください。",
      );
    db.exec("BEGIN IMMEDIATE");
    try {
      const temporary = "__bathjun_" + randomBytes(16).toString("hex") + "_";
      for (const member of members)
        if (member.id)
          db.prepare("UPDATE members SET name=? WHERE id=?").run(
            temporary + member.id,
            member.id,
          );
      for (const member of members) {
        if (member.id) {
          db.prepare("UPDATE members SET name=?,active=? WHERE id=?").run(
            member.name,
            member.active ? 1 : 0,
            member.id,
          );
          if (!member.active) {
            db.prepare("DELETE FROM sessions WHERE member_id=?").run(member.id);
            db.prepare("DELETE FROM passkey_challenges WHERE member_id=?").run(
              member.id,
            );
          }
        } else
          member.id = Number(
            db
              .prepare("INSERT INTO members(name,active) VALUES(?,?)")
              .run(member.name, member.active ? 1 : 0).lastInsertRowid,
          );
      }
      schedule.fixedOrder = members
        .filter((member) => member.active)
        .map((member) => member.id);
      db.prepare(
        "INSERT INTO schedule_settings VALUES(?,?) ON CONFLICT(effective_day) DO UPDATE SET value_json=excluded.value_json",
      ).run(nextDay(rawJapanDate(now())), JSON.stringify(schedule));
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    return get();
  }
  return { scheduleForDay, get, save };
}
