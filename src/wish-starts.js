import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { slotDate, validateSlot } from "./domain.js";
import { bathCalendar, shiftDay } from "./bath-calendar.js";
export function createWishStarts({
  db,
  now,
  scheduleForDay,
  rewards,
  notifications,
  prepareDay,
  onSettled,
  currentTurn,
}) {
  db.exec(
    readFileSync(
      new URL("../migrations/0018_wish_starts.sql", import.meta.url),
      "utf8",
    ),
  );
  function pending() {
    return db
      .prepare(
        "SELECT w.* FROM wishes w JOIN members m ON m.id=w.member_id WHERE m.active=1 AND w.day>=? AND w.day<=? AND NOT EXISTS(SELECT 1 FROM wish_start_attempts a WHERE a.revision=w.revision) ORDER BY w.day,w.start,w.member_id",
      )
      .all(
        shiftDay(bathCalendar(now()).today, -2),
        shiftDay(bathCalendar(now()).today, 2),
      );
  }
  const eligible = (wish) =>
    wish.day <= bathCalendar(now()).today &&
    slotDate(wish.day, wish.start + wish.duration) > now();
  const hasDraw = (wish) =>
    JSON.parse(
      db.prepare("SELECT order_json FROM draws WHERE day=?").get(wish.day)
        ?.order_json || "[]",
    ).includes(wish.member_id);
  function dueAt() {
    let due = null;
    for (const wish of pending()) {
      if (slotDate(wish.day, wish.start + wish.duration) <= now()) continue;
      if (
        !hasDraw(wish) &&
        (db.prepare("SELECT 1 FROM draws WHERE day=?").get(wish.day) ||
          scheduleForDay(wish.day).orderMode !== "fixed")
      )
        continue;
      const unopenedFixedDay = scheduleForDay(wish.day).orderMode === "fixed" && !db.prepare("SELECT 1 FROM draws WHERE day=?").get(wish.day);
      const value = slotDate(wish.day, unopenedFixedDay ? 0 : wish.start).getTime();
      due = due === null ? value : Math.min(due, value);
    }
    return due;
  }
  function overlaps(wish) {
    const from = slotDate(wish.day, wish.start).getTime(),
      to = slotDate(wish.day, wish.start + wish.duration).getTime();
    for (const row of db
      .prepare(
        "SELECT day,start,duration FROM bookings WHERE day>=? AND day<=? UNION ALL SELECT w.day,w.start,w.duration FROM wishes w JOIN members m ON m.id=w.member_id WHERE m.active=1 AND w.revision!=? AND w.day>=? AND w.day<=?",
      )
      .all(
        shiftDay(wish.day, -2),
        shiftDay(wish.day, 2),
        wish.revision,
        shiftDay(wish.day, -2),
        shiftDay(wish.day, 2),
      ))
      if (
        slotDate(row.day, row.start).getTime() < to &&
        slotDate(row.day, row.start + row.duration).getTime() > from
      )
        return true;
    return false;
  }
  function process() {
    const changed = new Map();
    for (const scheduled of pending()) {
      if (!eligible(scheduled)) continue;
      // Fixed order opens at midnight even when nobody opens the client.
      // prepareDay may confirm a future wish through the ordinary turn path.
      prepareDay(scheduled.day);
      if (slotDate(scheduled.day, scheduled.start) > now() || !hasDraw(scheduled)) continue;
      // prepareDay may already have consumed the wish through the ordinary turn path.
      const wish = db
        .prepare("SELECT * FROM wishes WHERE revision=?")
        .get(scheduled.revision);
      if (!wish) continue;
      let permitted = !db
        .prepare("SELECT 1 FROM bookings WHERE day=? AND member_id=?")
        .get(wish.day, wish.member_id);
      if (!rewards.settings().itemsEnabled) wish.ticket = null;
      try {
        permitted =
          permitted &&
          validateSlot(
            wish.start,
            wish.duration,
            rewards.bookingRule(wish.day, wish.member_id, wish.ticket),
          );
        rewards.checkTicketSlot(
          wish.day,
          wish.ticket,
          wish.start,
          wish.duration,
        );
      } catch {
        permitted = false;
      }
      rewards.transaction(() => {
        db.prepare(
          "INSERT OR IGNORE INTO wish_start_attempts VALUES(?,?,?,?)",
        ).run(wish.revision, wish.day, wish.member_id, now().toISOString());
        if (!permitted || overlaps(wish)) {
          notifications.record(wish, "wishUnconfirmed");
          return;
        }
        if (!changed.has(wish.day))
          changed.set(wish.day, currentTurn(wish.day));
        const ticket = rewards.commitTicket(
          wish.day,
          wish.member_id,
          wish.ticket,
        );
        db.prepare(
          "INSERT INTO bookings(day,member_id,start,duration,note,no_negotiation,auto_confirmed,auto_revision,ticket,ticket_extension,revision,automatic) VALUES(?,?,?,?,?,0,1,?,?,?,?,?)",
        ).run(
          wish.day,
          wish.member_id,
          wish.start,
          wish.duration,
          wish.note,
          wish.revision,
          ticket.kind,
          ticket.extension,
          randomBytes(16).toString("hex"),
          wish.automatic,
        );
        notifications.record(wish, "wishConfirmed");
        db.prepare("DELETE FROM wishes WHERE revision=?").run(wish.revision);
      });
    }
    for (const [day, previous] of changed) onSettled(day, previous);
  }
  return { process, dueAt };
}
