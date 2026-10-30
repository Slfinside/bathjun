import { readFileSync } from "node:fs";
import { randomBytes, randomInt } from "node:crypto";
import { slotDate, shuffle } from "./domain.js";
export const ITEM_KINDS = ["skip", "extend", "boost", "guard"];
export const ITEM_NAMES = {
  skip: "順番抜かしチケット",
  extend: "時間延長チケット",
  boost: "抽選確率UPチケット",
  guard: "順番抜かしガード",
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
  const defaults = () => ({
    extensionMinutes: 30,
    boostDraws: 3,
    quantities: { skip: 1, extend: 1, boost: 1, guard: 2 },
    weights: { skip: 1, extend: 1, boost: 1, guard: 1 },
  });
  const settings = () => {
    const row = db
      .prepare("SELECT value_json FROM reward_settings WHERE id=1")
      .get();
    return row ? JSON.parse(row.value_json) : defaults();
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
    if (!ITEM_KINDS.some((k) => value.weights[k] > 0))
      bad("1種類以上の出現率を有効にしてください。");
    const normalized = {
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
  function commitTicket(day, member, selected, existing = null) {
    const kind = ticket(selected) || existing?.ticket || null;
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
        "INSERT INTO lottery_boosts VALUES(?,?) ON CONFLICT(member_id) DO UPDATE SET remaining=remaining+excluded.remaining",
      ).run(member, settings().boostDraws);
      return { ok: true };
    });
  }
  function draw(ids) {
    const boosted = ids.filter(
      (id) =>
        (db
          .prepare("SELECT remaining FROM lottery_boosts WHERE member_id=?")
          .get(id)?.remaining || 0) > 0,
    );
    const first = weightedFirst(ids, boosted);
    return first == null
      ? []
      : [first, ...shuffle(ids.filter((id) => id !== first))];
  }
  function consumeDraw(ids) {
    for (const id of ids)
      db.prepare(
        "UPDATE lottery_boosts SET remaining=MAX(0,remaining-1) WHERE member_id=?",
      ).run(id);
  }
  function complete(member, payload, source = "client") {
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
            (source === "dashboard" ? 60 : 180) * 1000
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
      if (card(member, day).achieved) queueWeekly(member, weekOf(day));
      return { ok: true };
    });
  }
  function card(member, day) {
    const week = weekOf(day),
      days = Array.from({ length: 7 }, (_, i) => addDay(week, i));
    const stamps = db
      .prepare(
        "SELECT day,reported_at FROM bath_completions WHERE member_id=? AND day>=? AND day<=?",
      )
      .all(member, week, days[6]);
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
        ).getTime() + 180000;
      return {
        day: date,
        earnedAt: stamps.find((x) => x.day === date)?.reported_at || null,
        status: stamps.some((x) => x.day === date)
          ? "stamp"
          : now().getTime() > deadline
            ? "failed"
            : "pending",
      };
    });
    const claimed =
      db
        .prepare(
          "SELECT kind,quantity FROM weekly_rewards WHERE week=? AND member_id=?",
        )
        .get(week, member) || null;
    return {
      week,
      days: cells,
      achieved: stamps.length === 7,
      failed: cells.some((x) => x.status === "failed"),
      claimed,
    };
  }
  function queueWeekly(member, week) {
    const existing = db
      .prepare(
        "SELECT kind,quantity FROM weekly_rewards WHERE week=? AND member_id=?",
      )
      .get(week, member);
    if (existing) return existing;
    const config = settings();
    let number = randomInt(
        ITEM_KINDS.reduce((sum, k) => sum + config.weights[k], 0),
      ),
      kind = ITEM_KINDS[0];
    for (const k of ITEM_KINDS) {
      number -= config.weights[k];
      if (number < 0) {
        kind = k;
        break;
      }
    }
    const quantity = config.quantities[kind],
      created = now().toISOString(),
      batch = "weekly:" + week + ":" + member;
    db.prepare(
      "INSERT INTO weekly_rewards(week,member_id,kind,quantity,claimed_at) VALUES(?,?,?,?,?)",
    ).run(week, member, kind, quantity, created);
    db.prepare("INSERT INTO item_batches VALUES(?,?)").run(batch, created);
    db.prepare(
      "INSERT INTO item_gifts(id,batch_id,member_id,kind,quantity,created_at,reward_week) VALUES(?,?,?,?,?,?,?)",
    ).run(
      randomBytes(16).toString("hex"),
      batch,
      member,
      kind,
      quantity,
      created,
      week,
    );
    return { kind, quantity };
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
    return {
      celebrations: db
        .prepare(
          "SELECT week,kind,quantity FROM weekly_rewards WHERE member_id=? AND celebrated_at IS NULL ORDER BY week",
        )
        .all(member),
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
      boostRemaining:
        db
          .prepare("SELECT remaining FROM lottery_boosts WHERE member_id=?")
          .get(member)?.remaining || 0,
      gifts: gifts(member),
      card: card(member, day),
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
          boostRemaining:
            db
              .prepare("SELECT remaining FROM lottery_boosts WHERE member_id=?")
              .get(m.id)?.remaining || 0,
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
    settings,
    saveSettings,
    transaction,
    balance,
    ticket,
    bookingRule,
    commitTicket,
    distribute,
    receive,
    activate,
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
