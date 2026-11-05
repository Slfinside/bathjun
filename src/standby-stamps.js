import { readFileSync } from "node:fs";
import { slotDate } from "./domain.js";
const nextDay = (day, n = 1) =>
  new Date(Date.parse(day + "T12:00:00Z") + n * 86400000)
    .toISOString()
    .slice(0, 10);

export function createStandbyStamps({
  db,
  now,
  scheduleForDay,
  threshold,
  reportMinutes,
}) {
  db.exec(
    readFileSync(
      new URL("../migrations/0012_standby_stamps.sql", import.meta.url),
      "utf8",
    ),
  );
  function records(member) {
    const completions = new Map(
      db
        .prepare(
          "SELECT day,reported_at FROM bath_completions WHERE member_id=?",
        )
        .all(member)
        .map((x) => [x.day, x.reported_at]),
    );
    const bookings = new Map(
      db
        .prepare("SELECT day,start,duration FROM bookings WHERE member_id=?")
        .all(member)
        .map((x) => [x.day, x]),
    );
    const skips = db
      .prepare("SELECT day FROM bath_skips WHERE member_id=? ORDER BY day")
      .all(member)
      .map((x) => x.day)
      .filter((day) => !completions.has(day) && !bookings.has(day));
    return { completions, bookings, skips };
  }
  function resolve(member) {
    const { completions, bookings, skips } = records(member);
    const limit = threshold(),
      time = now().getTime();
    const save = db.prepare(
      "INSERT INTO standby_stamps(day,member_id,status,resolved_at) VALUES(?,?,?,?) ON CONFLICT(day,member_id) DO UPDATE SET status=excluded.status,resolved_at=excluded.resolved_at WHERE standby_stamps.status!=excluded.status",
    );
    const end = (day) => slotDate(day, scheduleForDay(day).bathEnd).getTime();
    for (let i = 0; i < skips.length; ) {
      const run = [skips[i++]];
      while (i < skips.length && skips[i] === nextDay(run.at(-1)))
        run.push(skips[i++]);
      const ended = run.filter((day) => end(day) <= time);
      if (!ended.length) continue;
      if (ended.length >= limit) {
        for (const day of ended)
          save.run(day, member, "failed", now().toISOString());
        continue;
      }
      // Unfinished bath windows cannot resolve the preceding pending stamps.
      if (ended.length !== run.length) continue;
      const following = nextDay(run.at(-1));
      if (completions.has(following)) {
        for (const day of ended)
          save.run(day, member, "stamp", completions.get(following));
      } else {
        // Unreported ordinary days settle at the day boundary. A later valid
        // completion is handled above and can update this derived result.
        const deadline=end(following);
        if (time >= deadline)
          for (const day of ended)
            save.run(day, member, "failed", now().toISOString());
      }
    }
  }
  function warning(member, day) {
    const skips = db
      .prepare(
        "SELECT s.day FROM bath_skips s WHERE s.member_id=? AND s.day>=? AND s.day<? AND NOT EXISTS(SELECT 1 FROM bookings b WHERE b.member_id=s.member_id AND b.day=s.day) AND NOT EXISTS(SELECT 1 FROM bath_completions c WHERE c.member_id=s.member_id AND c.day=s.day)",
      )
      .all(member, nextDay(day, -30), day);
    const set = new Set(skips.map((row) => row.day));
    let count = 1;
    for (
      let previous = nextDay(day, -1);
      set.has(previous);
      previous = nextDay(previous, -1)
    )
      count++;
    const days = threshold();
    return count >= days
      ? {
          days,
          count,
          message: `${days}日連続で入浴しないと、連続した「入らない/様子見」の日が失敗になります。その日の入浴時間が終わるまでは変更できます。`,
        }
      : null;
  }
  return { resolve, warning };
}
