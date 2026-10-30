// Preserve every reservation; compress only uninterrupted free intervals of 2h or more.
export function scheduleSegments(bookings, start, end, wishes = []) {
  if (wishes.length) return tentativeSegments(bookings, wishes, start, end);
  const segments = [];
  let cursor = start;
  const gap = (from, to) => {
    if (to > from)
      segments.push({
        kind: to - from >= 120 ? "break" : "free",
        start: from,
        end: to,
      });
  };
  for (const booking of [...bookings].sort((a, b) => a.start - b.start)) {
    gap(cursor, booking.start);
    segments.push({
      kind: "booking",
      start: booking.start,
      end: booking.start + booking.duration,
      booking,
    });
    cursor = booking.start + booking.duration;
  }
  gap(cursor, end);
  return segments;
}
export function quarterTicks(start, end) {
  const result = [start];
  for (
    let minute = Math.ceil((start + 1) / 15) * 15;
    minute < end;
    minute += 15
  )
    result.push(minute);
  return result;
}

function tentativeSegments(bookings, wishes, start, end) {
  const entries = [
    ...bookings.map((booking) => ({
      kind: "booking",
      start: booking.start,
      end: booking.start + booking.duration,
      booking,
    })),
    ...wishes.map((wish) => ({
      kind: "wish",
      start: wish.start,
      end: wish.start + wish.duration,
      booking: wish,
    })),
  ].sort((a, b) => a.start - b.start || a.end - b.end);
  const groups = [];
  for (const entry of entries) {
    const group = groups.at(-1);
    if (group && entry.start < group.end) {
      group.entries.push(entry);
      group.end = Math.max(group.end, entry.end);
    } else
      groups.push({ start: entry.start, end: entry.end, entries: [entry] });
  }
  const segments = [];
  let cursor = start;
  function gap(to) {
    if (to > cursor)
      segments.push({
        kind: to - cursor >= 120 ? "break" : "free",
        start: cursor,
        end: to,
      });
  }
  for (const group of groups) {
    gap(group.start);
    segments.push(
      group.entries.length === 1
        ? group.entries[0]
        : { kind: "overlap", ...group },
    );
    cursor = group.end;
  }
  gap(end);
  return segments;
}

// Half-open intervals: finishing exactly when another person starts is allowed.
export function overlapDetails(entry, entries) {
  return entries
    .filter(
      (other) =>
        other !== entry &&
        other.memberId !== entry.memberId &&
        entry.start < other.start + other.duration &&
        other.start < entry.start + entry.duration,
    )
    .map((other) => ({
      memberId: other.memberId,
      start: Math.max(entry.start, other.start),
      end: Math.min(entry.start + entry.duration, other.start + other.duration),
    }));
}
