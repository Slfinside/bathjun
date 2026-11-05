import {
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from "node:crypto";
import { promisify } from "node:util";
import { generateKeys } from "./push.js";
import { DEFAULT_SCHEDULE } from "./server-settings.js";
const scrypt = promisify(scryptCallback);
// These operations are exported only to the authenticated local server panel, never HTTP.
export function createAdminData({
  db,
  setFamilyPassword,
  getSettings,
  onNotificationsChanged = () => {},
}) {
  const config = () =>
    db.prepare("SELECT * FROM family_config WHERE id=1").get();
  function account(target) {
    if (target === "family") return config();
    if (!Number.isInteger(target))
      throw new Error("変更するメンバーを選んでください。");
    const member = db.prepare("SELECT * FROM members WHERE id=?").get(target);
    if (!member) throw new Error("メンバーを読み込み直してください。");
    return member;
  }
  function getSecurity() {
    return {
      familyConfigured: !!config().password_hash,
      members: db
        .prepare(
          "SELECT id,name,password_hash IS NOT NULL AS passwordSet FROM members ORDER BY id",
        )
        .all()
        .map((m) => ({ ...m, passwordSet: !!m.passwordSet })),
    };
  }
  async function verifyPassword({ target, password }) {
    const row = account(target),
      epoch = config().access_token;
    if (typeof password !== "string" || password.length > 128)
      throw new Error("確認するパスワードを入力してください。");
    if (!row.password_hash) return { matches: false, configured: false };
    const value = await scrypt(password, row.salt, 64);
    const current = account(target);
    return {
      matches:
        config().access_token === epoch &&
        current.password_hash === row.password_hash &&
        timingSafeEqual(value, Buffer.from(row.password_hash, "hex")),
      configured: !!current.password_hash,
    };
  }
  async function changePassword({ target, password }) {
    if (target === "family") {
      await setFamilyPassword(password);
      return getSecurity();
    }
    account(target);
    if (
      typeof password !== "string" ||
      password.length < 4 ||
      password.length > 128
    )
      throw new Error("個別パスワードは4〜128文字で設定してください。");
    const epoch = config().access_token,
      salt = randomBytes(16).toString("hex"),
      value = (await scrypt(password, salt, 64)).toString("hex");
    if (config().access_token !== epoch)
      throw new Error("データがリセットされました。読み込み直してください。");
    db.exec("BEGIN IMMEDIATE");
    try {
      const changed = db
        .prepare(
          "UPDATE members SET password_hash=?,salt=?,failures=0,locked_until=0 WHERE id=?",
        )
        .run(value, salt, target);
      if (!changed.changes)
        throw new Error("メンバーを読み込み直してください。");
      db.prepare("DELETE FROM sessions WHERE member_id=?").run(target);
      db.prepare("DELETE FROM passkey_credentials WHERE member_id=?").run(
        target,
      );
      // Authentication challenges are anonymous; invalidate any in-flight old-key login too.
      db.exec("DELETE FROM passkey_challenges WHERE kind='auth'");
      db.prepare("DELETE FROM passkey_challenges WHERE member_id=?").run(
        target,
      );
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    onNotificationsChanged();
    return getSecurity();
  }
  function resetAllData({ confirmation } = {}) {
    if (confirmation !== "RESET_ALL_DATA")
      throw new Error("全データのリセット確認が必要です。");
    const keys = generateKeys(),
      accessToken = randomBytes(32).toString("hex");
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const table of [
        "bath_noncompletions",
        "time_selection_jobs",
        "time_selection_receipts",

        "announcement_receipts",
        "announcement_pages",
        "announcements",
        "rebooking_prompts",
        "rebooking_history",
        "completion_notice_receipts",
        "completion_reminders",
        "nudge_jobs",
        "nudges",
        "wish_start_attempts",
        "auto_wish_runs",
        "auto_wish_preferences",
        "stamp_repairs",
        "item_actions",
        "weekly_rewards",
        "standby_stamps",
        "bath_completions",
        "lottery_boosts",
        "item_ledger",
        "item_gifts",
        "item_batches",
        "item_wallet",
        "reward_settings",
        "daily_standby_state",
        "reservation_policy",
        "wish_notification_jobs",
        "wish_outcomes",
        "notification_preferences",
        "booking_reminders",
        "notification_queue",
        "push_subscriptions",
        "passkey_challenges",
        "passkey_credentials",
        "passkey_accounts",
        "sessions",
        "family_sessions",
        "bookings",
        "wishes",
        "bath_skips",
        "draws",
        "members",
        "schedule_settings",
        "family_config",
      ])
        db.exec(`DELETE FROM ${table}`);
      db.prepare(
        "INSERT INTO family_config(id,access_token,vapid_public,vapid_private) VALUES(1,?,?,?)",
      ).run(accessToken, keys.publicKey, keys.privateKey);
      db.prepare("INSERT INTO reservation_policy(id,ignore_lower_priority_wishes) VALUES(1,1)").run();
      db.prepare("INSERT INTO schedule_settings VALUES(?,?)").run(
        "0000-01-01",
        JSON.stringify(DEFAULT_SCHEDULE),
      );
      db.exec(
        "DELETE FROM sqlite_sequence WHERE name='notification_queue'; COMMIT",
      );
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    onNotificationsChanged();
    return { settings: getSettings(), security: getSecurity(), accessToken };
  }
  return { getSecurity, verifyPassword, changePassword, resetAllData };
}
