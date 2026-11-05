import { clientReportsAllowed, lastReportMinutes } from "./completion-policy.js";
import { readFileSync } from "node:fs";
import { randomBytes, randomInt } from "node:crypto";
import { createStandbyStamps } from "./standby-stamps.js";
import { slotDate, shuffle } from "./domain.js";
export const ITEM_KINDS = [
  "skip",
  "extend",
  "boost",
  "guard",
  "bathStamp",
  "stampInk",
];
export const ITEM_NAMES = {
  skip: "順番抜かしチケット",
  extend: "時間延長チケット",
  boost: "抽選確率UPチケット",
  guard: "順番抜かしガード",
  bathStamp: "おふろスタンプ",
  stampInk: "スタンプのインク",
};
const bad = (message, status = 400) => {
  throw Object.assign(new Error(message), { status });
};
export const addDay = (day, n) =>
  new Date(Date.parse(day + "T12:00:00Z") + n * 86400000)
    .toISOString()
    .slice(0, 10);
export function weekOf(day) {
  const value = new Date(day + "T12:00:00Z");
  if (
    typeof day !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(day) ||
    !Number.isFinite(value.getTime()) ||
    value.toISOString().slice(0, 10) !== day
  )
    bad("週の日付を確認してください。");
  return addDay(day, -value.getUTCDay());
}
export function weightedFirst(ids, boosted, pick = randomInt) {
  if (!ids.length) return null;
  const weights = ids.map((id) => (boosted.includes(id) ? 3 : 1));
  let n = pick(weights.reduce((a, b) => a + b, 0));
  for (let i = 0; i < ids.length; i++) {
    n -= weights[i];
    if (n < 0) return ids[i];
  }
  throw new Error("Invalid lottery draw");
}
export function createRewards({ db, now, scheduleForDay }) {
  db.exec(
    readFileSync(
      new URL("../migrations/0010_rewards.sql", import.meta.url),
      "utf8",
    ),
  );
  db.exec(
    readFileSync(
      new URL("../migrations/0016_stamp_ink.sql", import.meta.url),
      "utf8",
    ),
  );
  if (
    !db
      .prepare("PRAGMA table_info(weekly_rewards)")
      .all()
      .some((c) => c.name === "celebrated_at")
  )
    db.exec("ALTER TABLE weekly_rewards ADD COLUMN celebrated_at TEXT");
  if (
    !db
      .prepare("PRAGMA table_info(item_gifts)")
      .all()
      .some((c) => c.name === "reward_week")
  )
    db.exec("ALTER TABLE item_gifts ADD COLUMN reward_week TEXT");
  if (
    !db
      .prepare("PRAGMA table_info(wish_outcomes)")
      .all()
      .some((c) => c.name === "displaced")
  )
    db.exec(
      "ALTER TABLE wish_outcomes ADD COLUMN displaced INTEGER NOT NULL DEFAULT 0",
    );
  for (const table of ["bookings", "wishes"]) {
    const columns = db
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .map((x) => x.name);
    if (table === "wishes" && !columns.includes("displaced"))
      db.exec(
        "ALTER TABLE wishes ADD COLUMN displaced INTEGER NOT NULL DEFAULT 0",
      );
    if (!columns.includes("ticket"))
      db.exec(`ALTER TABLE ${table} ADD COLUMN ticket TEXT`);
    if (table === "bookings") {
      if (!columns.includes("ticket_extension"))
        db.exec(
          "ALTER TABLE bookings ADD COLUMN ticket_extension INTEGER NOT NULL DEFAULT 0",
        );
      if (!columns.includes("revision"))
        db.exec(
          "ALTER TABLE bookings ADD COLUMN revision TEXT NOT NULL DEFAULT '';UPDATE bookings SET revision=lower(hex(randomblob(16)))",
        );
    }
  }
  // Handle databases from the unreleased time-based preview without losing effects.
  if (
    db
      .prepare("PRAGMA table_info(lottery_boosts)")
      .all()
      .some((c) => c.name === "expires_at")
  ) {
    transaction(() => {
      for (const row of db
        .prepare("SELECT * FROM lottery_boosts WHERE expires_at IS NOT NULL")
        .all())
        db.prepare(
          "UPDATE lottery_boosts SET remaining=?,expires_at=NULL WHERE member_id=?",
        ).run(
          Math.max(
            row.remaining,
            0,
            Math.ceil(
              (Date.parse(row.expires_at) - now().getTime()) / 86400000,
            ),
          ),
          row.member_id,
        );
    });
  }
  if (
    !db
      .prepare("PRAGMA table_info(weekly_rewards)")
      .all()
      .some((c) => c.name === "reward_mode")
  )
    db.exec(
      "ALTER TABLE weekly_rewards ADD COLUMN reward_mode TEXT NOT NULL DEFAULT 'roulette'",
    );
  if (
    !db
      .prepare("PRAGMA table_info(weekly_rewards)")
      .all()
      .some((c) => c.name === "reward_items_json")
  )
    db.exec("ALTER TABLE weekly_rewards ADD COLUMN reward_items_json TEXT");
  function weeklyReward(row) {
    if (!row) return null;
    const { reward_items_json, ...reward } = row;
    return reward_items_json
      ? { ...reward, items: JSON.parse(reward_items_json) }
      : reward;
  }
  const defaults = () => ({
    itemsEnabled: true,
    standbyFailureDays: 2,
    clientReportEnabled: false,
    clientReportMinutes: 3,
    dashboardReportMinutes: 1,
    extensionMinutes: 30,
    boostDraws: 3,
    extensionBlocked: true,
    extensionBlockedStart: 19 * 60,
    extensionBlockedEnd: 23 * 60,
    extensionNoticeMinutes: 120,
    skipNoticeMinutes: 120,
    rewardMode: "roulette",
    fixedKind: "extend",
    fixedQuantity: 1,
    quantities: {
      skip: 1,
      extend: 1,
      boost: 1,
      guard: 2,
      bathStamp: 1,
      stampInk: 1,
    },
    weights: {
      skip: 1,
      extend: 1,
      boost: 1,
      guard: 1,
      bathStamp: 0,
      stampInk: 1,
    },
  });
  const settings = () => {
    const row = db
      .prepare("SELECT value_json FROM reward_settings WHERE id=1")
      .get();
    const saved = row ? JSON.parse(row.value_json) : {};
    return {
      ...defaults(),
      ...saved,
      quantities: { ...defaults().quantities, ...saved.quantities },
      weights: { ...defaults().weights, ...saved.weights },
      boostDraws: saved.boostDraws ?? saved.boostDays ?? 3,
    };
  };
  const standby = createStandbyStamps({
    db,
    now,
    scheduleForDay,
    threshold: () => settings().standbyFailureDays,
    reportMinutes: () => lastReportMinutes(settings()),
  });
  const requireItems = () => {
    if (!settings().itemsEnabled)
      bad("アイテム機能が無効に設定されています。", 409);
  };
  function transaction(fn) {
    db.exec("SAVEPOINT rewards_transaction");
    try {
      const value = fn();
      db.exec("RELEASE rewards_transaction");
      return value;
    } catch (error) {
      db.exec("ROLLBACK TO rewards_transaction; RELEASE rewards_transaction");
      throw error;
    }
  }
  function saveSettings(value) {
    if (
      !value ||
      !Number.isInteger(value.extensionMinutes) ||
      value.extensionMinutes < 5 ||
      value.extensionMinutes > 180 ||
      !Number.isInteger(value.boostDraws) ||
      value.boostDraws < 1 ||
      value.boostDraws > 100
    )
      bad("延長分数・抽選回数を確認してください。");
    if (
      value.extensionMinutes %
      scheduleForDay(
        new Date(now().getTime() + 9 * 3600000).toISOString().slice(0, 10),
      ).step
    )
      bad("延長分数は予約の刻み幅に合わせてください。");
    value = {
      ...value,
      quantities: {
        bathStamp: settings().quantities.bathStamp,
        stampInk: settings().quantities.stampInk,
        ...value.quantities,
      },
      weights: {
        bathStamp: settings().weights.bathStamp,
        stampInk: settings().weights.stampInk,
        ...value.weights,
      },
    };
    for (const kind of ITEM_KINDS)
      if (
        !Number.isInteger(value.quantities?.[kind]) ||
        value.quantities[kind] < 1 ||
        value.quantities[kind] > 99 ||
        !Number.isInteger(value.weights?.[kind]) ||
        value.weights[kind] < 0 ||
        value.weights[kind] > 100
      )
        bad("受取枚数・出現率を確認してください。");
    const rewardMode = value.rewardMode ?? settings().rewardMode;
    const fixedKind = value.fixedKind ?? settings().fixedKind;
    const fixedQuantity = value.fixedQuantity ?? settings().fixedQuantity;
    if (
      !["roulette", "fixed", "both"].includes(rewardMode) ||
      !ITEM_KINDS.includes(fixedKind) ||
      !Number.isInteger(fixedQuantity) ||
      fixedQuantity < 1 ||
      fixedQuantity > 99
    )
      bad("達成報酬の方式・種類・枚数を確認してください。");
    if (rewardMode !== "fixed" && !ITEM_KINDS.some((k) => value.weights[k] > 0))
      bad("1種類以上の出現率を有効にしてください。");
    const limits = Object.fromEntries(
      [
        "extensionBlocked",
        "extensionBlockedStart",
        "extensionBlockedEnd",
        "extensionNoticeMinutes",
        "skipNoticeMinutes",
      ].map((key) => [key, value[key] ?? settings()[key]]),
    );
    if (
      typeof limits.extensionBlocked !== "boolean" ||
      !["extensionBlockedStart", "extensionBlockedEnd"].every(
        (key) =>
          Number.isInteger(limits[key]) &&
          limits[key] >= 0 &&
          limits[key] < 1440,
      ) ||
      (limits.extensionBlocked &&
        limits.extensionBlockedStart === limits.extensionBlockedEnd) ||
      !["extensionNoticeMinutes", "skipNoticeMinutes"].every(
        (key) =>
          Number.isInteger(limits[key]) &&
          limits[key] >= 0 &&
          limits[key] <= 1440,
      )
    )
      bad("チケットの使用制限を確認してください。");
    const itemsEnabled = value.itemsEnabled ?? settings().itemsEnabled;
    const standbyFailureDays =
      value.standbyFailureDays ?? settings().standbyFailureDays;
    if (
      typeof itemsEnabled !== "boolean" ||
      !Number.isInteger(standbyFailureDays) ||
      standbyFailureDays < 1 ||
      standbyFailureDays > 30
    )
      bad("アイテム機能・連続して入らない日数を確認してください。");
    const clientReportMinutes =
      value.clientReportMinutes ?? settings().clientReportMinutes;
    const dashboardReportMinutes =
      value.dashboardReportMinutes ?? settings().dashboardReportMinutes;
    if (
      ![clientReportMinutes, dashboardReportMinutes].every(
        (n) => Number.isInteger(n) && n >= 1 && n <= 180,
      )
    )
      bad("完了報告の期限は1〜180分で設定してください。");
    const clientReportEnabled = value.clientReportEnabled ?? settings().clientReportEnabled;
    if (typeof clientReportEnabled !== "boolean") bad("クライアントからの完了報告の設定を確認してください。");
    const normalized = {
      itemsEnabled,
      clientReportEnabled,
      standbyFailureDays,
      clientReportMinutes,
      dashboardReportMinutes,
      ...limits,
      rewardMode,
      fixedKind,
      fixedQuantity,
      extensionMinutes: value.extensionMinutes,
      boostDraws: value.boostDraws,
      quantities: Object.fromEntries(
        ITEM_KINDS.map((k) => [k, value.quantities[k]]),
      ),
      weights: Object.fromEntries(ITEM_KINDS.map((k) => [k, value.weights[k]])),
    };
    db.prepare(
      "INSERT INTO reward_settings VALUES(1,?) ON CONFLICT(id) DO UPDATE SET value_json=excluded.value_json",
    ).run(JSON.stringify(normalized));
    return admin();
  }
  const balance = (member, kind) =>
    db
      .prepare("SELECT quantity FROM item_wallet WHERE member_id=? AND kind=?")
      .get(member, kind)?.quantity || 0;
  function change(member, kind, delta, reason) {
    if (balance(member, kind) + delta < 0)
      bad("このアイテムは足りません。持ち物を確認してください。", 409);
    db.prepare(
      "INSERT INTO item_wallet VALUES(?,?,?) ON CONFLICT(member_id,kind) DO UPDATE SET quantity=quantity+excluded.quantity",
    ).run(member, kind, delta);
    db.prepare(
      "INSERT INTO item_ledger(member_id,kind,delta,reason,created_at) VALUES(?,?,?,?,?)",
    ).run(member, kind, delta, reason, now().toISOString());
  }
  // SQLite checks an UPSERT's inserted row before updating, so spend separately.
  function spend(member, kind, reason) {
    if (balance(member, kind) < 1)
      bad("このアイテムは足りません。持ち物を確認してください。", 409);
    db.prepare(
      "UPDATE item_wallet SET quantity=quantity-1 WHERE member_id=? AND kind=?",
    ).run(member, kind);
    db.prepare(
      "INSERT INTO item_ledger(member_id,kind,delta,reason,created_at) VALUES(?,?,-1,?,?)",
    ).run(member, kind, reason, now().toISOString());
  }
  function ticket(value) {
    if (value == null || value === "") return null;
    if (!["skip", "extend", "guard"].includes(value))
      bad("予約に使うアイテムは1種類を選んでください。");
    return value;
  }
  function extension(rule) {
    const value = settings().extensionMinutes;
    return Math.floor(value / rule.step) * rule.step;
  }
  function bookingRule(day, member, selected, existing = null) {
    const rule = scheduleForDay(day),
      kind = ticket(selected);
    if (kind && kind !== existing?.ticket) requireItems();
    let extra = 0;
    if (existing?.ticket && kind && kind !== existing.ticket)
      bad("この予約では別の種類のアイテムを追加できません。", 409);
    if (kind && existing?.ticket !== kind && balance(member, kind) < 1)
      bad("このアイテムは足りません。", 409);
    if (kind === "extend") {
      extra =
        existing?.ticket === "extend"
          ? existing.ticket_extension
          : extension(rule);
      if (extra < rule.step)
        bad("管理画面で延長分数を予約の刻み幅に合わせてください。", 409);
    }
    return { ...rule, maxDuration: rule.maxDuration + extra };
  }
  function checkTicketSlot(day, selected, start, duration, existing = null) {
    const kind = ticket(selected) || existing?.ticket;
    if (kind !== "extend" && kind !== "skip") return;
    // Keeping the time unchanged may update notes without invalidating an existing booking.
    if (
      existing?.ticket === kind &&
      existing.start === start &&
      existing.duration === duration
    )
      return;
    const config = settings();
    const lead =
      kind === "extend"
        ? config.extensionNoticeMinutes
        : config.skipNoticeMinutes;
    if (
      lead > 0 &&
      slotDate(day, start).getTime() - now().getTime() <= lead * 60000
    )
      bad(`このチケットは、開始まで${lead}分以下の予約には使えません。`);
    if (kind === "extend" && config.extensionBlocked) {
      for (
        let offset = Math.floor(start / 1440) - 1;
        offset <= Math.floor((start + duration) / 1440);
        offset++
      ) {
        const from = offset * 1440 + config.extensionBlockedStart;
        const to =
          offset * 1440 +
          config.extensionBlockedEnd +
          (config.extensionBlockedEnd < config.extensionBlockedStart
            ? 1440
            : 0);
        if (start < to && start + duration > from)
          bad("延長チケットを使えない時間帯と重なっています。");
      }
    }
  }
  function commitTicket(day, member, selected, existing = null) {
    const kind = ticket(selected) || existing?.ticket || null;
    if (kind && existing?.ticket !== kind) requireItems();
    if (kind && existing?.ticket !== kind)
      spend(member, kind, `booking:${day}`);
    return {
      kind,
      extension:
        kind === "extend"
          ? existing?.ticket === "extend"
            ? existing.ticket_extension
            : extension(scheduleForDay(day))
          : 0,
    };
  }
  const gifts = (member) =>
    db
      .prepare(
        "SELECT id,member_id AS memberId,kind,quantity,created_at AS createdAt,received_at AS receivedAt,reward_week AS rewardWeek FROM item_gifts WHERE member_id=? ORDER BY (received_at IS NULL) DESC,created_at DESC,id DESC LIMIT 500",
      )
      .all(member);
  function distribute(body) {
    requireItems();
    const { recipients, kinds, quantity, requestId } = body || {};
    if (
      !Array.isArray(recipients) ||
      !recipients.length ||
      recipients.length > 50 ||
      new Set(recipients).size !== recipients.length ||
      recipients.some(
        (id) =>
          !Number.isInteger(id) ||
          !db.prepare("SELECT 1 FROM members WHERE id=?").get(id),
      )
    )
      bad("対象メンバーを選んでください。");
    if (
      !Array.isArray(kinds) ||
      !kinds.length ||
      new Set(kinds).size !== kinds.length ||
      kinds.some((k) => !ITEM_KINDS.includes(k)) ||
      !Number.isInteger(quantity) ||
      quantity < 1 ||
      quantity > 999 ||
      typeof requestId !== "string" ||
      !/^[a-zA-Z0-9-]{8,100}$/.test(requestId)
    )
      bad("配布する種類・個数を確認してください。");
    transaction(() => {
      if (db.prepare("SELECT 1 FROM item_batches WHERE id=?").get(requestId))
        return;
      const created = now().toISOString();
      db.prepare("INSERT INTO item_batches VALUES(?,?)").run(
        requestId,
        created,
      );
      for (const member of recipients)
        for (const kind of kinds)
          db.prepare(
            "INSERT INTO item_gifts(id,batch_id,member_id,kind,quantity,created_at,received_at) VALUES(?,?,?,?,?,?,NULL)",
          ).run(
            randomBytes(16).toString("hex"),
            requestId,
            member,
            kind,
            quantity,
            created,
          );
    });
    return admin();
  }
  function receive(member, id) {
    requireItems();
    if (typeof id !== "string" || !/^[a-f0-9]{32}$/.test(id))
      bad("プレゼントを確認してください。");
    return transaction(() => {
      const gift = db
        .prepare("SELECT * FROM item_gifts WHERE id=? AND member_id=?")
        .get(id, member);
      if (!gift) bad("プレゼントが見つかりません。", 404);
      if (!gift.received_at) {
        change(member, gift.kind, gift.quantity, "gift:" + gift.id);
        db.prepare("UPDATE item_gifts SET received_at=? WHERE id=?").run(
          now().toISOString(),
          gift.id,
        );
      }
      return {
        ok: true,
        kind: gift.kind,
        quantity: gift.quantity,
        weekly: !!gift.reward_week,
      };
    });
  }
  function activate(member, id) {
    requireItems();
    if (typeof id !== "string" || !/^[a-zA-Z0-9-]{8,100}$/.test(id))
      bad("操作をやり直してください。");
    return transaction(() => {
      const previous = db
        .prepare("SELECT * FROM item_actions WHERE id=?")
        .get(id);
      if (previous) {
        if (previous.member_id !== member || previous.kind !== "boost")
          bad("操作をやり直してください。", 409);
        return { ok: true };
      }
      db.prepare("INSERT INTO item_actions VALUES(?,?,?)").run(
        id,
        member,
        "boost",
      );
      spend(member, "boost", "activate");
      db.prepare(
        "INSERT INTO lottery_boosts(member_id,remaining) VALUES(?,?) ON CONFLICT(member_id) DO UPDATE SET remaining=remaining+excluded.remaining",
      ).run(member, settings().boostDraws);
      return { ok: true };
    });
  }
  for(const column of ['refundable','refunded_at'])if(!db.prepare('PRAGMA table_info(stamp_repairs)').all().some(c=>c.name===column))db.exec('ALTER TABLE stamp_repairs ADD COLUMN '+column+(column==='refundable'?' INTEGER NOT NULL DEFAULT 0':' TEXT'));
  function refundInk(member,day){
    const repair=db.prepare('SELECT * FROM stamp_repairs WHERE day=? AND member_id=? AND refundable=1 AND refunded_at IS NULL').get(day,member);
    if(!repair)return;
    const batch='ink-return:'+day+':'+member,stamp=now().toISOString();
    db.prepare('INSERT OR IGNORE INTO item_batches VALUES(?,?)').run(batch,stamp);
    db.prepare("INSERT INTO item_gifts(id,batch_id,member_id,kind,quantity,created_at) VALUES(?,?,?,'stampInk',1,?)").run(randomBytes(16).toString('hex'),batch,member,stamp);
    db.prepare('UPDATE stamp_repairs SET refunded_at=? WHERE day=? AND member_id=?').run(stamp,day,member);
  }
  function useStamp(member, payload) {
    requireItems();
    const { day, requestId } = payload || {};
    if (
      typeof requestId !== "string" ||
      !/^[a-zA-Z0-9-]{8,100}$/.test(requestId)
    )
      bad("操作をやり直してください。");
    // weekOf validates that the date exists; ownership comes from the session.
    const week = weekOf(day);
    return transaction(() => {
      const previous = db
        .prepare("SELECT * FROM stamp_repairs WHERE request_id=?")
        .get(requestId);
      if (previous) {
        if (previous.member_id !== member || previous.day !== day)
          bad("操作をやり直してください。", 409);
        return { ok: true };
      }
      const today = new Date(now().getTime() + 9 * 3600000)
        .toISOString()
        .slice(0, 10);
      if (![weekOf(today), addDay(weekOf(today), -7)].includes(week))
        bad("インクを使えるのは今週と先週のスタンプカードだけです。", 409);
      if (balance(member, "bathStamp") < 1)
        bad("おふろスタンプを持っていません。", 409);
      const target = card(member, day).days.find((cell) => cell.day === day);
      if (!target || target.status === "stamp" || day > today)
        bad("今日までの未確定または失敗の日を選んでください。", 409);
      spend(member, "stampInk", "stamp:" + day);
      db.prepare("INSERT INTO stamp_repairs(day,member_id,used_at,request_id,refundable) VALUES(?,?,?,?,?)").run(
        day,
        member,
        now().toISOString(),
        requestId,
        day===today&&target.status==='pending'?1:0,
      );
      settle(member);
      return { ok: true };
    });
  }
  const boostRemaining = (member) =>
    db
      .prepare("SELECT remaining FROM lottery_boosts WHERE member_id=?")
      .get(member)?.remaining || 0;
  function draw(ids) {
    const boosted = settings().itemsEnabled
      ? ids.filter((id) => boostRemaining(id) > 0)
      : [];
    const first = weightedFirst(ids, boosted);
    return {
      order:
        first == null
          ? []
          : [first, ...shuffle(ids.filter((id) => id !== first))],
      boosted,
    };
  }
  function consumeDraw(ids) {
    if (!settings().itemsEnabled) return;
    for (const id of ids)
      db.prepare(
        "UPDATE lottery_boosts SET remaining=MAX(0,remaining-1) WHERE member_id=?",
      ).run(id);
  }
  function complete(member, payload, source = "client") {
    const config = settings();
    if (source !== "dashboard" && !clientReportsAllowed(config)) bad("クライアントからの完了報告は無効です。サーバーのダッシュボードで報告してください。", 403);
    const { day, revision } = payload || {};
    if (
      typeof day !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(day) ||
      typeof revision !== "string"
    )
      bad("完了報告する予約を確認してください。");
    return transaction(() => {
      const booking = db
        .prepare("SELECT * FROM bookings WHERE day=? AND member_id=?")
        .get(day, member);
      const previous = db
        .prepare(
          "SELECT revision FROM bath_completions WHERE day=? AND member_id=?",
        )
        .get(day, member);
      if (previous?.revision === revision) return { ok: true };
      if (!booking || booking.revision !== revision)
        bad("予約が変更されました。読み込み直してください。", 409);
      if (
        now() < slotDate(day, booking.start) ||
        now().getTime() >
          slotDate(day, booking.start + booking.duration).getTime() +
            (source === "dashboard"
              ? settings().dashboardReportMinutes
              : settings().clientReportMinutes) *
              60000
      )
        bad("完了報告の受付時間外です。", 409);
      db.prepare(
        "INSERT OR IGNORE INTO bath_completions VALUES(?,?,?,?,?,?,?)",
      ).run(
        day,
        member,
        revision,
        booking.start,
        booking.duration,
        now().toISOString(),
        source,
      );
      refundInk(member,day);
      settle(member);
      return { ok: true };
    });
  }
  function card(member, day) {
    settle(member);
    return rawCard(member, day);
  }
  function settle(member) {
    transaction(() => {
      standby.resolve(member);
      if (!settings().itemsEnabled) return;
      const weeks = new Map();
      for (const row of db
        .prepare(
          "SELECT day FROM bath_completions WHERE member_id=? UNION SELECT day FROM standby_stamps WHERE member_id=? AND status='stamp' UNION SELECT day FROM stamp_repairs WHERE member_id=?",
        )
        .all(member, member, member)) {
        const week = weekOf(row.day);
        weeks.set(week, (weeks.get(week) || 0) + 1);
      }
      const issued = new Set(
        db
          .prepare("SELECT week FROM weekly_rewards WHERE member_id=?")
          .all(member)
          .map((row) => row.week),
      );
      for (const [week, count] of weeks)
        if (count === 7 && !issued.has(week) && rawCard(member, week).achieved)
          queueWeekly(member, week);
    });
  }
  function rawCard(member, day) {
    const week = weekOf(day),
      days = Array.from({ length: 7 }, (_, i) => addDay(week, i));
    const stamps = db
      .prepare(
        "SELECT day,reported_at FROM bath_completions WHERE member_id=? AND day>=? AND day<=?",
      )
      .all(member, week, days[6]);
    const standbyRows = db
      .prepare(
        "SELECT day,status,resolved_at FROM standby_stamps WHERE member_id=? AND day>=? AND day<=?",
      )
      .all(member, week, days[6]);
    const repairs = db
      .prepare(
        "SELECT day,used_at FROM stamp_repairs WHERE member_id=? AND day>=? AND day<=?",
      )
      .all(member, week, days[6]);
    const pendingSkips = new Set(
      db
        .prepare(
          "SELECT day FROM bath_skips WHERE member_id=? AND day>=? AND day<=?",
        )
        .all(member, week, days[6])
        .map((row) => row.day),
    );
    const cells = days.map((date) => {
      const booking = db
        .prepare(
          "SELECT start,duration FROM bookings WHERE day=? AND member_id=?",
        )
        .get(date, member);
      const deadline =
        slotDate(
          date,
          booking
            ? booking.start + booking.duration
            : scheduleForDay(date).bathEnd,
        ).getTime() +
        lastReportMinutes(settings()) *
          60000;
      const resolved = standbyRows.find((row) => row.day === date);
      const repair = repairs.find((row) => row.day === date);
      return {
        day: date,
        earnedAt:
          repair?.used_at ||
          stamps.find((x) => x.day === date)?.reported_at ||
          (resolved?.status === "stamp" ? resolved.resolved_at : null),
        reason: repair
          ? "ink"
          : resolved?.status === "stamp"
            ? "standby"
            : null,
        status:
          repair || stamps.some((x) => x.day === date)
            ? "stamp"
            : resolved?.status ||
              (pendingSkips.has(date) && !booking
                ? "pending"
                : now().getTime() > deadline
                  ? "failed"
                  : "pending"),
      };
    });
    const claimed = weeklyReward(
      db
        .prepare(
          "SELECT kind,quantity,reward_mode AS mode,reward_items_json FROM weekly_rewards WHERE week=? AND member_id=?",
        )
        .get(week, member),
    );
    return {
      week,
      days: cells,
      achieved: cells.every((cell) => cell.status === "stamp"),
      failed: cells.some((x) => x.status === "failed"),
      claimed,
    };
  }
  function queueWeekly(member, week) {
    const existing = weeklyReward(
      db
        .prepare(
          "SELECT kind,quantity,reward_mode AS mode,reward_items_json FROM weekly_rewards WHERE week=? AND member_id=?",
        )
        .get(week, member),
    );
    if (existing) return existing;
    const config = settings();
    if (!config.itemsEnabled) return null;
    let kind = config.fixedKind;
    if (config.rewardMode !== "fixed") {
      let number = randomInt(
        ITEM_KINDS.reduce((sum, k) => sum + config.weights[k], 0),
      );
      for (const k of ITEM_KINDS) {
        number -= config.weights[k];
        if (number < 0) {
          kind = k;
          break;
        }
      }
    }
    const quantity =
        config.rewardMode === "fixed"
          ? config.fixedQuantity
          : config.quantities[kind],
      created = now().toISOString(),
      batch = "weekly:" + week + ":" + member;
    const items =
      config.rewardMode === "both"
        ? [
            {
              kind: config.fixedKind,
              quantity: config.fixedQuantity,
              mode: "fixed",
            },
            { kind, quantity, mode: "roulette" },
          ]
        : [{ kind, quantity, mode: config.rewardMode }];
    db.prepare(
      "INSERT INTO weekly_rewards(week,member_id,kind,quantity,claimed_at,reward_mode,reward_items_json) VALUES(?,?,?,?,?,?,?)",
    ).run(
      week,
      member,
      kind,
      quantity,
      created,
      config.rewardMode,
      config.rewardMode === "both" ? JSON.stringify(items) : null,
    );
    db.prepare("INSERT INTO item_batches VALUES(?,?)").run(batch, created);
    for (const item of items)
      db.prepare(
        "INSERT INTO item_gifts(id,batch_id,member_id,kind,quantity,created_at,reward_week) VALUES(?,?,?,?,?,?,?)",
      ).run(
        randomBytes(16).toString("hex"),
        batch,
        member,
        item.kind,
        item.quantity,
        created,
        week,
      );
    return {
      kind,
      quantity,
      mode: config.rewardMode,
      ...(config.rewardMode === "both" ? { items } : {}),
    };
  }
  function claim(member, week) {
    if (
      typeof week !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(week) ||
      weekOf(week) !== week
    )
      bad("受け取る週を確認してください。");
    return transaction(() => {
      if (!card(member, week).achieved)
        bad("この週はまだ7日分そろっていません。", 409);
      return queueWeekly(member, week);
    });
  }
  function view(member, day) {
    settle(member);
    return {
      celebrations: db
        .prepare(
          "SELECT week,kind,quantity,reward_mode AS mode,reward_items_json FROM weekly_rewards WHERE member_id=? AND celebrated_at IS NULL ORDER BY week",
        )
        .all(member)
        .map(weeklyReward),
      pendingGifts: db
        .prepare(
          "SELECT COUNT(*) AS n FROM item_gifts WHERE member_id=? AND received_at IS NULL",
        )
        .get(member).n,
      settings: settings(),
      wallet: ITEM_KINDS.map((kind) => ({
        kind,
        quantity: balance(member, kind),
      })),
      boostRemaining: boostRemaining(member),
      gifts: gifts(member),
      card: rawCard(member, day),
    };
  }
  function admin() {
    return {
      settings: settings(),
      members: db
        .prepare("SELECT id,name FROM members ORDER BY id")
        .all()
        .map((m) => ({
          ...m,
          wallet: ITEM_KINDS.map((kind) => ({
            kind,
            quantity: balance(m.id, kind),
          })),
          boostRemaining: boostRemaining(m.id),
        })),
      history: db
        .prepare(
          "SELECT g.id,g.member_id AS memberId,m.name,g.kind,g.quantity,g.created_at AS createdAt,g.received_at AS receivedAt FROM item_gifts g JOIN members m ON m.id=g.member_id ORDER BY g.created_at DESC,g.id DESC LIMIT 500",
        )
        .all(),
    };
  }
  function celebrate(member, week) {
    if (typeof week !== "string") bad("週を確認してください。");
    db.prepare(
      "UPDATE weekly_rewards SET celebrated_at=COALESCE(celebrated_at,?) WHERE week=? AND member_id=?",
    ).run(now().toISOString(), week, member);
    return { ok: true };
  }
  return {
    celebrate,
    standbyWarning: standby.warning,
    settings,
    saveSettings,
    transaction,
    balance,
    ticket,
    bookingRule,
    commitTicket,
    checkTicketSlot,
    distribute,
    receive,
    activate,
    useStamp,
    draw,
    consumeDraw,
    complete,
    card,
    claim,
    view,
    admin,
    completion: (day, member) =>
      db
        .prepare("SELECT * FROM bath_completions WHERE day=? AND member_id=?")
        .get(day, member) || null,
  };
}
