import QRCode from "qrcode/lib/core/qrcode.js";
import { overlapDetails } from "../public/schedule-layout.js";
import { slotDate } from "./domain.js";

// Read-only view of the server's active night. Status follows reservations,
// never claims to detect physical entry into the bathroom.
export function dashboardView(snapshot) {
  const { day, now, settings, members, bookings, wishes, skips } = snapshot;
  const instant = new Date(now).getTime();
  const timed = (item, kind) => ({
    ...item,
    kind,
    day,
    name:
      members.find((m) => m.id === item.memberId)?.name || "利用停止メンバー",
    emoji: members.find((m) => m.id === item.memberId)?.emoji || null,
    color: members.find((m) => m.id === item.memberId)?.color || null,
    startsAt: slotDate(day, item.start).toISOString(),
    endsAt: slotDate(day, item.start + item.duration).toISOString(),
  });
  const confirmed = bookings.map((b) => timed(b, "予約"));
  const entries = [
    ...confirmed,
    ...(snapshot.bookingHistory||[]).map(b=>timed(b,"予約")),
    ...wishes.filter(w=>w.start!==null).map((w) => timed(w, "希望・未確定")),
  ].sort((a, b) => a.start - b.start || a.memberId - b.memberId);
  for (const entry of entries) entry.overlaps = overlapDetails(entry, entries);
  const upcoming = confirmed
    .filter((b) => !b.notBathedAt&&Date.parse(b.startsAt) > instant)
    .sort((a, b) => a.start - b.start);
  return {
    day,
    now,
    pendingReports:(snapshot.pendingReports||[]).map(b=>({...b,kind:"予約",startsAt:slotDate(b.day,b.start).toISOString(),endsAt:slotDate(b.day,b.start+b.duration).toISOString()})),
    reportMinutes: snapshot.reportMinutes ?? 1,
    untimedWishes: wishes.filter(w=>w.start===null).map(w=>({memberId:w.memberId,duration:w.duration,name:members.find(m=>m.id===w.memberId)?.name||"利用停止メンバー"})),
    bathStart: settings.bathStart,
    bathEnd: settings.bathEnd,
    current:
      confirmed.find(
        (b) =>
          !b.completedAt && !b.notBathedAt &&
          Date.parse(b.startsAt) <= instant &&
          instant < Date.parse(b.endsAt),
      ) || null,
    next: upcoming[0] || null,
    afterNext: upcoming[1] || null,
    entries,
    members: members
      .filter((m) => m.active)
      .map((m) => {
        const b = confirmed.find((b) => b.memberId === m.id);
        return {
          id: m.id,
          name: m.name,
          emoji: m.emoji || null,
          color: m.color || null,
          status: b
            ? b.notBathedAt ? "未入浴" : b.completedAt
              ? "完了"
              : instant >= Date.parse(b.endsAt)
                ? b.revision &&
                  instant <=
                    Date.parse(b.endsAt) + (snapshot.reportMinutes ?? 1) * 60000
                  ? "入浴完了"
                  : "未報告"
                : instant >= Date.parse(b.startsAt)
                  ? "入浴中"
                  : "予約済"
            : wishes.some((w) => w.memberId === m.id)
              ? "未確定"
              : "未入力",
          deferred: skips.includes(m.id),
        };
      }),
  };
}
let cachedUrl = "",
  cachedQr = null;
export function dashboardQr(state) {
  let shareUrl = "";
  try {
    const url = new URL(state.url);
    if (
      state.phase === "ready" &&
      url.protocol === "https:" &&
      /^\/family\/[a-f0-9]{64}\/$/.test(url.pathname)
    )
      shareUrl = url.href;
  } catch {}
  if (shareUrl !== cachedUrl) {
    cachedUrl = shareUrl;
    cachedQr = shareUrl
      ? QRCode.create(shareUrl, { errorCorrectionLevel: "M" })
      : null;
  }
  return {
    shareUrl,
    qr: cachedQr
      ? Array.from({ length: cachedQr.modules.size }, (_, y) =>
          Array.from({ length: cachedQr.modules.size }, (_, x) =>
            cachedQr.modules.get(y, x) ? "1" : "0",
          ).join(""),
        )
      : [],
  };
}
