export const DEFAULT_NOTIFICATION_PREFERENCES = Object.freeze({
  nudge: true,
  bookingDisplaced: false,
  wishConfirmed: false,
  wishUnconfirmed: true,
  reservationTurn: false,
  bathReminder: true,
  completionReminder: true,
  timeSelectionReminder: true,
  reminderMinutes: 10,
});
export function getNotificationPreferences(db, memberId) {
  const row = db
    .prepare(
      "SELECT value_json FROM notification_preferences WHERE member_id=?",
    )
    .get(memberId);
  return {
    ...DEFAULT_NOTIFICATION_PREFERENCES,
    ...(row ? JSON.parse(row.value_json) : {}),
  };
}
export function saveNotificationPreferences(db, memberId, payload) {
  if (
    !payload ||
    typeof payload !== "object" ||
    Array.isArray(payload) ||
    Object.keys(payload).some(
      (key) => !Object.hasOwn(DEFAULT_NOTIFICATION_PREFERENCES, key),
    )
  )
    throw new Error("通知の設定を確認してください。");
  const result = { ...getNotificationPreferences(db, memberId), ...payload };
  for (const key of [
    "nudge",
    "bookingDisplaced",
    "wishConfirmed",
    "wishUnconfirmed",
    "reservationTurn",
    "bathReminder",
    "completionReminder",
    "timeSelectionReminder",
  ])
    if (typeof result[key] !== "boolean")
      throw new Error("通知の有効・無効を確認してください。");
  if (
    !Number.isInteger(result.reminderMinutes) ||
    result.reminderMinutes < 1 ||
    result.reminderMinutes > 180
  )
    throw new Error("入浴前の通知は1〜180分前で設定してください。");
  db.prepare(
    "INSERT INTO notification_preferences VALUES(?,?) ON CONFLICT(member_id) DO UPDATE SET value_json=excluded.value_json",
  ).run(memberId, JSON.stringify(result));
  return result;
}
