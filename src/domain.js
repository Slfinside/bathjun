import { randomInt } from "node:crypto";
import { DEFAULT_SCHEDULE } from "./server-settings.js";

export function japanTime(now = new Date(), schedule = DEFAULT_SCHEDULE) {
  const jst = new Date(now.getTime() + 9 * 3600000);
  const today = jst.toISOString().slice(0, 10);
  const yesterday = new Date(jst.getTime() - 86400000)
    .toISOString()
    .slice(0, 10);
  const minute = jst.getUTCHours() * 60 + jst.getUTCMinutes();
  return {
    today,
    yesterday,
    minute,
    activeDay:
      schedule.bathEnd > 1440 && minute < schedule.bathEnd - 1440
        ? yesterday
        : today,
  };
}
export function lotteryOpen(day, now, schedule = DEFAULT_SCHEDULE) {
  const t = japanTime(now);
  if (!schedule.lotteryTimeRestricted)
    return (day === t.today || day === t.yesterday) && slotDate(day, schedule.bathEnd) > now;
  return (
    day === t.today &&
    t.minute >= schedule.lotteryStart &&
    t.minute < schedule.lotteryEnd
  );
}
export function slotDate(day, minutes) {
  return new Date(
    new Date(`${day}T00:00:00+09:00`).getTime() + minutes * 60000,
  );
}
export function validateSlot(start, duration, schedule = DEFAULT_SCHEDULE) {
  return (
    Number.isInteger(start) &&
    Number.isInteger(duration) &&
    start >= schedule.bathStart &&
    start % schedule.step === 0 &&
    duration >= schedule.minDuration &&
    duration <= schedule.maxDuration &&
    duration % schedule.step === 0 &&
    start + duration <= schedule.bathEnd
  );
}
export function shuffle(ids) {
  const result = [...ids];
  for (let i = result.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}
