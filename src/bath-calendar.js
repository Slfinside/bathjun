// Today and the lottery date always follow the Japanese calendar at midnight.
export function shiftDay(day, amount) {
  return new Date(Date.parse(day + "T12:00:00Z") + amount * 86400000)
    .toISOString()
    .slice(0, 10);
}
export function bathCalendar(now) {
  const jst = new Date(now.getTime() + 9 * 3600000),
    calendarToday = jst.toISOString().slice(0, 10);
  const minute = jst.getUTCHours() * 60 + jst.getUTCMinutes();
  const today = calendarToday;
  return {
    calendarToday,
    today,
    yesterday: shiftDay(today, -1),
    tomorrow: shiftDay(today, 1),
    dayAfterTomorrow: shiftDay(today, 2),
    activeDay: today,
    minute,
    dayRollover: 0,
  };
}
