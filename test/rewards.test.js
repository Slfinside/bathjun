import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID, randomBytes, createECDH } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { createApp } from "../src/app.js";
import { DEFAULT_SCHEDULE } from "../src/server-settings.js";
import { weekOf, addDay, weightedFirst } from "../src/rewards.js";
async function fixture(t, { random = false, deliverPush = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "bathjun-reward-")),
    database = join(dir, "test.sqlite");
  let clock = new Date("2026-10-24T08:00:00+09:00"),
    app,
    server;
  const sent = [];
  const open = () =>
    createApp({
      database,
      requireFamily: false,
      now: () => clock,
      deliverPush: async (sub, payload, keys, options) => {
        if (deliverPush) await deliverPush(sub, payload, keys, options);
        sent.push({ sub, payload, options });
      },
    });
  app = open();
  app.saveServerSettings({
    members: [1, 2, 3].map((i) => ({ name: "メンバー" + i, active: true })),
    schedule: { ...DEFAULT_SCHEDULE, orderMode: random ? "random" : "fixed" },
  });
  clock = new Date("2026-10-25T08:00:00+09:00");
  async function listen() {
    server = createServer(app.handle);
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
  }
  await listen();
  t.after(async () => {
    await new Promise((r) => server.close(r));
    app.close();
    rmSync(dir, { force: true, recursive: true });
  });
  const cookies = {};
  async function request(path, body, id = 1) {
    const r = await fetch(
      `http://127.0.0.1:${server.address().port}/api/${path}`,
      {
        method: body === undefined ? "GET" : "POST",
        headers: {
          cookie: cookies[id] || "",
          "Content-Type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
    );
    return {
      status: r.status,
      body: await r.json(),
      cookie: r.headers.get("set-cookie")?.split(";")[0],
    };
  }
  async function api(path, body, id = 1) {
    const r = await request(path, body, id);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body;
  }
  for (const id of [1, 2, 3])
    cookies[id] = (
      await request("register", { memberId: id, password: "test-only" }, id)
    ).cookie;
  await api("state");
  return {
    get app() {
      return app;
    },
    api,
    request,
    sent,
    database,
    time: (value) => (clock = new Date(value + "+09:00")),
    state: (id = 1) => api("state", undefined, id),
    book: (
      id,
      start = 1080,
      duration = 30,
      ticket = null,
      day = "2026-10-25",
    ) => api("book", { day, start, duration, ticket }, id),
    grant: async (id, kinds, quantity = 1) => {
      const result = app.distributeItems({
        recipients: [id],
        kinds,
        quantity,
        requestId: randomUUID(),
      });
      for (const gift of result.history.filter(
        (g) => g.memberId === id && !g.receivedAt,
      ))
        await api("gifts/receive", { id: gift.id }, id);
    },
    restart: async () => {
      await new Promise((r) => server.close(r));
      app.close();
      app = open();
      await listen();
    },
  };
}
test("配布は本人のプレゼントへ入り、受取・配布の再送を重複処理せず、履歴は本人宛てだけ", async (t) => {
  const f = await fixture(t),
    body = {
      recipients: [1, 2],
      kinds: ["guard", "extend"],
      quantity: 2,
      requestId: randomUUID(),
    };
  const first = f.app.distributeItems(body);
  assert.equal(first.history.length, 4);
  assert.equal(f.app.distributeItems(body).history.length, 4);
  let mine = (await f.state()).rewards;
  assert.equal(mine.pendingGifts, 2);
  assert.ok(mine.wallet.every((i) => i.quantity === 0));
  assert.ok(mine.gifts.every((g) => g.memberId === 1));
  const other = (await f.state(2)).rewards.gifts[0];
  assert.equal(
    (await f.request("gifts/receive", { id: other.id })).status,
    404,
  );
  const own = mine.gifts[0];
  await f.api("gifts/receive", { id: own.id });
  await f.api("gifts/receive", { id: own.id });
  mine = (await f.state()).rewards;
  assert.equal(mine.pendingGifts, 1);
  assert.equal(mine.wallet.find((i) => i.kind === own.kind).quantity, 2);
  await f.restart();
  assert.equal((await f.state()).rewards.pendingGifts, 1);
  assert.equal(f.app.getRewardsAdmin().history.length, 4);
  assert.throws(() => f.app.distributeItems({ ...body, quantity: -1 }));
  assert.equal((await f.request("items/distribute", body)).status, 404);
});
test("ガードは希望では未消費、確定で消費し、順番抜かしの全処理を止める", async (t) => {
  const f = await fixture(t);
  await f.grant(2, ["guard"]);
  await f.grant(3, ["skip"]);
  await f.api(
    "wish",
    { day: "2026-10-25", start: 1110, duration: 30, ticket: "guard" },
    2,
  );
  assert.equal(
    (await f.state(2)).rewards.wallet.find((i) => i.kind === "guard").quantity,
    1,
  );
  await f.book(1);
  let state = await f.state(2);
  assert.equal(state.bookings.find((b) => b.memberId === 2).ticket, "guard");
  assert.equal(
    state.rewards.wallet.find((i) => i.kind === "guard").quantity,
    0,
  );
  const denied = await f.request(
    "book",
    { day: state.day, start: 1080, duration: 60, ticket: "skip" },
    3,
  );
  assert.equal(denied.status, 409);
  state = await f.state(3);
  assert.equal(state.bookings.length, 2);
  assert.equal(state.rewards.wallet.find((i) => i.kind === "skip").quantity, 1);
});
test("順番抜かしは開始済みも希望に戻し、延長効果を失わせ、本人へ通知を1回送る", async (t) => {
  const f = await fixture(t);
  f.app.saveRewardSettings({
    ...f.app.getRewardsAdmin().settings,
    extensionBlocked: false,
    skipNoticeMinutes: 0,
  });
  await f.grant(1, ["extend"]);
  await f.grant(2, ["skip"]);
  await f.book(1, 1080, 120, "extend");
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  await f.api("notification-preferences", {
    wishUnconfirmed: false,
    bookingDisplaced: true,
  });
  await f.api("push/subscribe", {
    subscription: {
      endpoint: "https://web.push.apple.com/reward-displaced",
      keys: {
        p256dh: ecdh.getPublicKey().toString("base64url"),
        auth: randomBytes(16).toString("base64url"),
      },
    },
  });
  f.time("2026-10-25T18:10:00");
  await f.book(2, 1095, 30, "skip");
  let state = await f.state();
  assert.equal(
    state.bookings.some((b) => b.memberId === 1),
    false,
  );
  assert.equal(state.wishes[0].duration, 120);
  assert.equal(state.wishes[0].ticket, null);
  assert.equal(
    state.rewards.wallet.find((i) => i.kind === "extend").quantity,
    0,
  );
  await f.app.flushNotifications();
  await f.app.flushNotifications();
  const notices = f.sent.filter((x) =>
    x.payload.tag.startsWith("bath-wish-displaced"),
  );
  assert.equal(notices.length, 1);
  assert.match(notices[0].payload.body, /事前希望へ戻りました/);
  assert.equal(
    (await f.request("book", { day: state.day, start: 1140, duration: 120 }))
      .status,
    400,
  );
});
test("1つの予約のチケットは併用不可で、同じ予約の変更では二重消費しない", async (t) => {
  const f = await fixture(t);
  await f.grant(1, ["guard", "extend"]);
  await f.book(1, 1080, 30, "guard");
  await f.book(1, 1110, 30, "guard");
  assert.equal(
    (await f.state()).rewards.wallet.find((i) => i.kind === "guard").quantity,
    0,
  );
  assert.equal(
    (
      await f.request("book", {
        day: "2026-10-25",
        start: 1110,
        duration: 30,
        ticket: "extend",
      })
    ).status,
    409,
  );
  assert.equal(
    (await f.state()).rewards.wallet.find((i) => i.kind === "extend").quantity,
    1,
  );
});
test("完了報告は早上がり可、本人限定、ダッシュボード1分・クライアント3分の期限", async (t) => {
  const f = await fixture(t);
  await f.book(1);
  let booking = (await f.state()).bookings[0];
  assert.equal(
    (
      await f.request("complete", {
        day: "2026-10-25",
        revision: booking.revision,
      })
    ).status,
    409,
  );
  f.time("2026-10-25T18:05:00");
  assert.equal(
    (
      await f.request(
        "complete",
        { day: "2026-10-25", revision: booking.revision },
        2,
      )
    ).status,
    409,
  );
  await f.api("complete", { day: "2026-10-25", revision: booking.revision });
  await f.api("complete", { day: "2026-10-25", revision: booking.revision });
  assert.equal((await f.state()).rewards.card.days[0].status, "stamp");
  await f.book(2, 1140);
  booking = (await f.state(2)).bookings.find((b) => b.memberId === 2);
  f.time("2026-10-25T19:31:01");
  assert.throws(() =>
    f.app.completeBath({
      day: "2026-10-25",
      memberId: 2,
      revision: booking.revision,
    }),
  );
  f.time("2026-10-25T19:33:00");
  await f.api("complete", { day: "2026-10-25", revision: booking.revision }, 2);
  await f.book(3, 1260);
  booking = (await f.state(3)).bookings.find((b) => b.memberId === 3);
  f.time("2026-10-25T21:33:01");
  assert.equal(
    (
      await f.request(
        "complete",
        { day: "2026-10-25", revision: booking.revision },
        3,
      )
    ).status,
    409,
  );
});
test("土曜分は日曜朝まで受付し、達成特典を自動送付・お祝いし、二重受取を防ぐ", async (t) => {
  const f = await fixture(t);
  assert.equal(weekOf("2026-10-31"), "2026-10-25");
  assert.equal(weekOf("2026-11-01"), "2026-11-01");
  for (let i = 0; i < 7; i++) {
    const day = addDay("2026-10-25", i);
    f.time(day + "T08:00:00");
    await f.book(1, i === 6 ? 1830 : 1080, 30, null, day);
    const state = await f.api("state?day=" + day),
      b = state.bookings.find((b) => b.memberId === 1);
    f.time(i === 6 ? "2026-11-01T07:02:00" : day + "T18:15:00");
    await f.api("complete", { day, revision: b.revision });
  }
  const card = (await f.api("rewards?week=2026-10-25")).card;
  assert.equal(card.claimed.mode, "roulette");
  assert.equal(card.achieved, true);
  assert.equal(card.failed, false);
  const rewardState = (await f.state()).rewards;
  assert.equal(rewardState.pendingGifts, 1);
  assert.deepEqual(
    rewardState.celebrations.map((x) => x.week),
    [card.week],
  );
  assert.ok(rewardState.wallet.every((i) => i.quantity === 0));
  const first = await f.api("rewards/claim", { week: card.week });
  assert.deepEqual(await f.api("rewards/claim", { week: card.week }), first);
  assert.equal((await f.state()).rewards.pendingGifts, 1);
  const gift = rewardState.gifts[0];
  assert.equal(gift.rewardWeek, card.week);
  await f.api("gifts/receive", { id: gift.id });
  await f.api("gifts/receive", { id: gift.id });
  assert.equal(
    (await f.state()).rewards.wallet.find((i) => i.kind === first.kind)
      .quantity,
    first.quantity,
  );
  await f.api("rewards/celebrate", { week: card.week });
  assert.equal((await f.state()).rewards.celebrations.length, 0);
  await f.restart();
  assert.deepEqual(await f.api("rewards/claim", { week: card.week }), first);
  assert.equal((await f.api("rewards?week=2026-11-01")).card.achieved, false);
});
test("確率UPは3回、同じ使用の再送で二重消費せず、抽選の閲覧や重複抽選で減らさない", async (t) => {
  const f = await fixture(t, { random: true });
  await f.grant(1, ["boost"], 2);
  const requestId = randomUUID();
  await f.api("items/boost", { requestId });
  await f.api("items/boost", { requestId });
  assert.equal((await f.state()).rewards.boostRemaining, 3);
  assert.equal(
    (await f.state()).rewards.wallet.find((i) => i.kind === "boost").quantity,
    1,
  );
  await f.api("draw", { day: "2026-10-25" });
  await f.state();
  assert.equal((await f.state()).rewards.boostRemaining, 2);
  assert.deepEqual((await f.state(2)).draw.boostedMemberIds, [1]);
  assert.equal((await f.request("draw", { day: "2026-10-25" })).status, 409);
  assert.equal((await f.state()).rewards.boostRemaining, 2);
  f.time("2026-10-28T08:00:00");
  await f.restart();
  assert.equal((await f.state()).rewards.boostRemaining, 2);
  await f.api("draw", { day: "2026-10-28" });
  assert.equal((await f.state()).rewards.boostRemaining, 1);
  f.time("2026-10-29T08:00:00");
  await f.api("draw", { day: "2026-10-29" });
  assert.equal((await f.state()).rewards.boostRemaining, 0);
  assert.deepEqual((await f.state()).draw.boostedMemberIds, [1]);
  await f.restart();
  assert.deepEqual(
    (await f.api("state?day=2026-10-28", undefined, 3)).draw.boostedMemberIds,
    [1],
  );
});
test("1番になる確率は重み3:1で、ユーザーの例を厳密に満たす", () => {
  for (const [ids, boosted, total, expected] of [
    [[1, 2, 3, 4, 5], [1], 7, [3, 1, 1, 1, 1]],
    [[1, 2, 3, 4], [1, 2, 3], 10, [3, 3, 3, 1]],
  ]) {
    const counts = ids.map(() => 0);
    for (let i = 0; i < total; i++)
      counts[
        weightedFirst(ids, boosted, (n) => {
          assert.equal(n, total);
          return i;
        }) - 1
      ]++;
    assert.deepEqual(counts, expected);
  }
});
test("全リセットはチケット・配布・完了報告・週間報酬も消し、初期設定に戻す", async (t) => {
  const f = await fixture(t);
  await f.grant(1, ["boost"]);
  await f.api("items/boost", { requestId: randomUUID() });
  f.app.resetAllData({ confirmation: "RESET_ALL_DATA" });
  const admin = f.app.getRewardsAdmin();
  assert.equal(admin.members.length, 0);
  assert.equal(admin.history.length, 0);
  assert.equal(admin.settings.boostDraws, 3);
});

test("ダッシュボードは朝の入浴終了後も完了報告の1分間は前夜を表示する", async (t) => {
  const f = await fixture(t);
  await f.book(1, 1830);
  f.time("2026-10-26T07:00:30");
  assert.equal(f.app.getDashboard().day, "2026-10-25");
  f.time("2026-10-26T07:01:01");
  assert.equal(f.app.getDashboard().day, "2026-10-26");
});

test("延長と順番抜かしは直前・禁止時間帯を検証し、拒否時は消費も予約変更もしない", async (t) => {
  const f = await fixture(t);
  await f.grant(1, ["extend", "skip"], 3);
  const body = (start, duration = 30, ticket = "extend") => ({
    day: "2026-10-25",
    start,
    duration,
    ticket,
  });
  assert.equal(f.app.getRewardsAdmin().settings.extensionNoticeMinutes, 120);
  f.time("2026-10-25T13:00:00");
  assert.equal((await f.request("book", body(900))).status, 400); // exactly two hours
  f.time("2026-10-25T12:59:59");
  await f.api("book", body(900));
  assert.equal(
    (await f.state()).rewards.wallet.find((x) => x.kind === "extend").quantity,
    2,
  );
  // Only moving the interval invokes the limit; editing its note keeps the paid effect.
  f.time("2026-10-25T14:00:00");
  await f.api("book", { ...body(900), note: "変更した備考" });
  assert.equal((await f.request("book", body(915))).status, 400);
  f.time("2026-10-25T08:00:00");
  assert.equal((await f.request("book", body(1110, 45))).status, 400); // 18:30–19:15
  assert.equal((await f.request("book", body(1320, 90))).status, 400); // 22:00–23:30
  await f.api("book", body(1110, 30)); // ends at 19:00
  await f.api("book", body(1380)); // starts at 23:00
  assert.equal(
    (await f.state()).rewards.wallet.find((x) => x.kind === "extend").quantity,
    2,
  );
  await f.grant(2, ["skip"]);
  f.time("2026-10-25T21:00:00");
  assert.equal(
    (await f.request("book", body(1380, 30, "skip"), 2)).status,
    400,
  );
  assert.equal(
    (await f.state(2)).rewards.wallet.find((x) => x.kind === "skip").quantity,
    1,
  );
  assert.equal(
    (await f.state()).bookings.find((b) => b.memberId === 1).start,
    1380,
  );
  f.time("2026-10-25T20:59:59");
  await f.api("book", body(1380, 30, "skip"), 2);
  assert.equal(
    (await f.state()).wishes.find((w) => w.memberId === 1).ticket,
    null,
  );
  await f.restart();
  assert.equal(f.app.getRewardsAdmin().settings.extensionBlockedStart, 1140);
});

test("希望の確定時にも直前制限を確認し、禁止時間帯は日跨ぎ・解除設定に対応する", async (t) => {
  const f = await fixture(t);
  await f.grant(2, ["extend"]);
  await f.api(
    "wish",
    { day: "2026-10-25", start: 1080, duration: 30, ticket: "extend" },
    2,
  );
  f.time("2026-10-25T16:00:00");
  await f.book(1, 1200, 30);
  assert.ok(!(await f.state(2)).bookings.some((b) => b.memberId === 2));
  assert.equal(
    (await f.state(2)).rewards.wallet.find((x) => x.kind === "extend").quantity,
    1,
  );
  const config = f.app.getRewardsAdmin().settings;
  f.app.saveRewardSettings({
    ...config,
    extensionNoticeMinutes: 0,
    extensionBlockedStart: 1380,
    extensionBlockedEnd: 60,
  });
  assert.equal(
    (
      await f.request(
        "book",
        { day: "2026-10-25", start: 1440, duration: 30, ticket: "extend" },
        2,
      )
    ).status,
    400,
  );
  await f.book(2, 1380 - 30, 30, "extend");
  f.app.saveRewardSettings({
    ...config,
    extensionNoticeMinutes: 0,
    extensionBlocked: false,
  });
  await f.book(2, 1440, 30, "extend");
  assert.throws(() =>
    f.app.saveRewardSettings({ ...config, skipNoticeMinutes: -1 }),
  );
  assert.throws(() =>
    f.app.saveRewardSettings({
      ...config,
      extensionBlockedStart: 60,
      extensionBlockedEnd: 60,
    }),
  );
});

test("未公開の日数制データを一度だけ回数制へ戻し、残効果と設定を保つ", async (t) => {
  const f = await fixture(t);
  await f.grant(1, ["boost"], 2);
  const legacy = { ...f.app.getRewardsAdmin().settings, boostDays: 7 };
  delete legacy.boostDraws;
  const db = new DatabaseSync(f.database);
  db.exec("ALTER TABLE lottery_boosts ADD COLUMN expires_at TEXT");
  db.prepare(
    "INSERT INTO lottery_boosts(member_id,remaining,expires_at) VALUES(?,0,?)",
  ).run(1, "2026-10-27T08:00:00+09:00");
  db.prepare(
    "INSERT INTO reward_settings VALUES(1,?) ON CONFLICT(id) DO UPDATE SET value_json=excluded.value_json",
  ).run(JSON.stringify(legacy));
  db.close();
  await f.restart();
  assert.equal((await f.state()).rewards.boostRemaining, 2);
  assert.equal((await f.state()).rewards.settings.boostDraws, 7);
  f.time("2026-10-26T08:00:00");
  await f.restart();
  assert.equal((await f.state()).rewards.boostRemaining, 2);
  const requestId = randomUUID();
  await f.api("items/boost", { requestId });
  await f.api("items/boost", { requestId });
  assert.equal((await f.state()).rewards.boostRemaining, 9);
  assert.equal(
    (await f.state()).rewards.wallet.find((x) => x.kind === "boost").quantity,
    1,
  );
});

test("固定報酬は指定の種類・枚数を一度だけ送り、設定変更・再起動後も確定内容を保つ", async (t) => {
  const f = await fixture(t),
    config = f.app.getRewardsAdmin().settings;
  assert.equal(config.rewardMode, "roulette");
  const weights = Object.fromEntries(
    Object.keys(config.weights).map((k) => [k, 0]),
  );
  f.app.saveRewardSettings({
    ...config,
    rewardMode: "fixed",
    fixedKind: "guard",
    fixedQuantity: 4,
    weights,
  });
  for (let i = 0; i < 7; i++) {
    const day = addDay("2026-10-25", i);
    f.time(day + "T08:00:00");
    await f.book(1, 1080, 30, null, day);
    const booking = (await f.api("state?day=" + day)).bookings.find(
      (b) => b.memberId === 1,
    );
    f.time(day + "T18:15:00");
    await f.api("complete", { day, revision: booking.revision });
  }
  const reward = (await f.state()).rewards;
  assert.equal(reward.pendingGifts, 1);
  assert.deepEqual(reward.celebrations, [
    { week: "2026-10-25", kind: "guard", quantity: 4, mode: "fixed" },
  ]);
  assert.equal(reward.wallet.find((x) => x.kind === "guard").quantity, 0);
  f.app.saveRewardSettings({ ...config, rewardMode: "roulette" });
  await f.restart();
  const chosen = await f.api("rewards/claim", { week: "2026-10-25" });
  assert.deepEqual(chosen, { kind: "guard", quantity: 4, mode: "fixed" });
  const gifts = (await f.state()).rewards.gifts;
  assert.equal(gifts.length, 1);
  await f.api("gifts/receive", { id: gifts[0].id });
  await f.api("gifts/receive", { id: gifts[0].id });
  assert.equal(
    (await f.state()).rewards.wallet.find((x) => x.kind === "guard").quantity,
    4,
  );
  assert.throws(() =>
    f.app.saveRewardSettings({ ...config, rewardMode: "other" }),
  );
  assert.throws(() =>
    f.app.saveRewardSettings({ ...config, fixedKind: "other" }),
  );
  assert.throws(() =>
    f.app.saveRewardSettings({ ...config, fixedQuantity: 0 }),
  );
  assert.throws(() =>
    f.app.saveRewardSettings({ ...config, rewardMode: "roulette", weights }),
  );
});

test("確率UPの表示は抽選時に確定し、後からの有効化や固定順には適用しない", async (t) => {
  const f = await fixture(t, { random: true });
  await f.api("draw", { day: "2026-10-25" });
  await f.grant(1, ["boost"]);
  await f.api("items/boost", { requestId: randomUUID() });
  assert.deepEqual((await f.state()).draw.boostedMemberIds, []);
  f.time("2026-10-26T08:00:00");
  await f.grant(2, ["boost"]);
  await f.api("items/boost", { requestId: randomUUID() }, 2);
  await f.api("draw", { day: "2026-10-26" });
  assert.deepEqual((await f.state(3)).draw.boostedMemberIds, [1, 2]);
  const fixed = await fixture(t);
  await fixed.grant(1, ["boost"]);
  await fixed.api("items/boost", { requestId: randomUUID() });
  fixed.time("2026-10-26T08:00:00");
  assert.deepEqual((await fixed.state()).draw.boostedMemberIds, []);
  assert.equal((await fixed.state()).rewards.boostRemaining, 3);
});

test("旧抽選結果の移行では確率UPの使用者を推測せず、既存の順番を保つ", async (t) => {
  const f = await fixture(t, { random: true });
  await f.api("draw", { day: "2026-10-25" });
  const original = (await f.state()).draw.originalOrder;
  const db = new DatabaseSync(f.database);
  db.exec("ALTER TABLE draws DROP COLUMN boosted_json");
  db.close();
  await f.restart();
  const state = await f.state();
  assert.deepEqual(state.draw.originalOrder, original);
  assert.deepEqual(state.draw.boostedMemberIds, []);
});

test("土曜の様子見を日曜の入浴完了で遡って成功にし、前週の報酬を一度だけ届ける", async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 6; i++) {
    const day = addDay("2026-10-25", i);
    f.time(day + "T08:00:00");
    await f.book(1, 1080, 30, null, day);
    const booking = (await f.state()).bookings.find((b) => b.memberId === 1);
    f.time(day + "T18:05:00");
    await f.api("complete", { day, revision: booking.revision });
  }
  f.time("2026-10-31T08:00:00");
  await f.api("skip", { day: "2026-10-31", skip: true });
  f.time("2026-11-01T07:00:00");
  let old = await f.api("rewards?week=2026-10-25");
  assert.equal(old.card.days[6].status, "pending");
  assert.equal(old.card.achieved, false);
  assert.equal(old.pendingGifts, 0);
  await f.book(1, 1080, 30, null, "2026-11-01");
  const booking = (await f.state()).bookings.find((b) => b.memberId === 1);
  f.time("2026-11-01T18:05:00");
  await f.api("complete", { day: "2026-11-01", revision: booking.revision });
  old = await f.api("rewards?week=2026-10-25");
  assert.equal(old.card.achieved, true);
  assert.equal(old.card.days[6].status, "stamp");
  assert.equal(old.card.days[6].reason, "standby");
  assert.equal(old.pendingGifts, 1);
  assert.equal(old.gifts[0].rewardWeek, "2026-10-25");
  await f.restart();
  old = await f.api("rewards?week=2026-10-25");
  assert.equal(old.gifts.length, 1);
  assert.equal(old.celebrations[0].week, "2026-10-25");
});

test("連続2日の入らないは2日目の入浴終了で両日失敗になる・それまでは保留", async (t) => {
  const f = await fixture(t);
  f.time("2026-10-31T08:00:00");
  await f.api("skip", { day: "2026-10-31", skip: true });
  f.time("2026-11-01T08:00:00");
  assert.equal((await f.state()).standbyWarning.days, 2);
  await f.api("skip", { day: "2026-11-01", skip: true });
  for (const week of ["2026-10-25", "2026-11-01"]) {
    const card = (await f.api("rewards?week=" + week)).card;
    assert.equal(card.days[week === "2026-10-25" ? 6 : 0].status, "pending");
  }
  f.time("2026-11-02T06:59:59");
  assert.equal(
    (await f.api("rewards?week=2026-10-25")).card.days[6].status,
    "pending",
  );
  f.time("2026-11-02T07:00:00");
  assert.equal(
    (await f.api("rewards?week=2026-10-25")).card.days[6].status,
    "failed",
  );
  assert.equal(
    (await f.api("rewards?week=2026-11-01")).card.days[0].status,
    "failed",
  );
  f.app.saveRewardSettings({
    ...f.app.getRewardsAdmin().settings,
    standbyFailureDays: 3,
  });
  await f.restart();
  assert.equal(
    (await f.api("rewards?week=2026-10-25")).card.days[6].status,
    "failed",
  );
});

test("様子見を解除して入浴すれば前日の保留も成功・3日設定の警告は3日目", async (t) => {
  const f = await fixture(t);
  f.app.saveRewardSettings({
    ...f.app.getRewardsAdmin().settings,
    standbyFailureDays: 3,
  });
  await f.api("skip", { day: "2026-10-25", skip: true });
  f.time("2026-10-26T08:00:00");
  assert.equal((await f.state()).standbyWarning, null);
  await f.api("skip", { day: "2026-10-26", skip: true });
  f.time("2026-10-27T08:00:00");
  assert.equal((await f.state()).standbyWarning.days, 3);
  await f.api("skip", { day: "2026-10-27", skip: true });
  await f.api("skip", { day: "2026-10-27", skip: false });
  await f.book(1, 1080, 30, null, "2026-10-27");
  const booking = (await f.state()).bookings[0];
  f.time("2026-10-27T18:10:00");
  await f.api("complete", { day: "2026-10-27", revision: booking.revision });
  const card = (await f.state()).rewards.card;
  assert.deepEqual(
    card.days.slice(0, 3).map((d) => d.status),
    ["stamp", "stamp", "stamp"],
  );
});

test("アイテム無効は既存の持ち物・プレゼントを保持し、APIからの使用・受取・配布も止める", async (t) => {
  const f = await fixture(t, { random: true });
  await f.grant(1, ["guard", "boost"], 2);
  await f.api("items/boost", { requestId: randomUUID() });
  f.app.distributeItems({
    recipients: [1],
    kinds: ["extend"],
    quantity: 1,
    requestId: randomUUID(),
  });
  const before = (await f.state()).rewards;
  f.app.saveRewardSettings({ ...before.settings, itemsEnabled: false });
  const after = (await f.state()).rewards;
  assert.deepEqual(after.wallet, before.wallet);
  assert.equal(after.pendingGifts, 1);
  assert.equal(
    (
      await f.request("gifts/receive", {
        id: after.gifts.find((g) => !g.receivedAt).id,
      })
    ).status,
    409,
  );
  assert.equal(
    (await f.request("items/boost", { requestId: randomUUID() })).status,
    409,
  );
  assert.equal(
    (
      await f.request("wish", {
        day: "2026-10-26",
        start: 1080,
        duration: 30,
        ticket: "guard",
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await f.request("book", {
        day: "2026-10-25",
        start: 1080,
        duration: 30,
        ticket: "guard",
      })
    ).status,
    409,
  );
  assert.throws(
    () =>
      f.app.distributeItems({
        recipients: [1],
        kinds: ["guard"],
        quantity: 1,
        requestId: randomUUID(),
      }),
    /無効/,
  );
  await f.api("draw", { day: "2026-10-25" });
  const state = await f.state();
  assert.deepEqual(state.draw.boostedMemberIds, []);
  assert.equal(state.rewards.boostRemaining, before.boostRemaining);
  await f.restart();
  assert.equal((await f.state()).rewards.settings.itemsEnabled, false);
  f.app.saveRewardSettings({ ...after.settings, itemsEnabled: true });
  assert.equal((await f.state()).rewards.boostRemaining, before.boostRemaining);
});

test("アイテム無効中も既存の延長予約の効果は維持し、未確定のガード希望は消費せず普通の予約にする", async (t) => {
  const f = await fixture(t);
  await f.grant(1, ["extend", "guard"]);
  f.app.saveRewardSettings({
    ...f.app.getRewardsAdmin().settings,
    extensionBlocked: false,
  });
  await f.book(1, 1080, 120, "extend");
  await f.api("wish", {
    day: "2026-10-26",
    start: 1080,
    duration: 30,
    ticket: "guard",
  });
  f.app.saveRewardSettings({
    ...f.app.getRewardsAdmin().settings,
    itemsEnabled: false,
  });
  await f.book(1, 1080, 120, "extend");
  assert.equal((await f.state()).bookings[0].ticket, "extend");
  f.time("2026-10-26T08:00:00");
  const state = await f.state();
  assert.equal(state.bookings[0].ticket, null);
  assert.equal(
    state.rewards.wallet.find((x) => x.kind === "guard").quantity,
    1,
  );
});

test("完了報告期限をクライアント・ダッシュボード別に設定し、境界と表示に反映する", async (t) => {
  const f = await fixture(t);
  f.app.saveRewardSettings({
    ...f.app.getRewardsAdmin().settings,
    clientReportMinutes: 10,
    dashboardReportMinutes: 5,
  });
  await f.book(1, 1080, 30);
  const first = (await f.state()).bookings[0];
  f.time("2026-10-25T18:35:00");
  assert.equal(f.app.getDashboard().reportMinutes, 5);
  f.app.completeBath({
    day: "2026-10-25",
    memberId: 1,
    revision: first.revision,
  });
  f.time("2026-10-26T08:00:00");
  await f.book(1, 1080, 30, null, "2026-10-26");
  const second = (await f.state()).bookings[0];
  f.time("2026-10-26T18:35:01");
  assert.throws(
    () =>
      f.app.completeBath({
        day: "2026-10-26",
        memberId: 1,
        revision: second.revision,
      }),
    /受付時間外/,
  );
  f.time("2026-10-26T18:40:00");
  await f.api("complete", { day: "2026-10-26", revision: second.revision });
  for (const value of [
    { itemsEnabled: "false" },
    { standbyFailureDays: 0 },
    { standbyFailureDays: 2.5 },
    { clientReportMinutes: 0 },
    { dashboardReportMinutes: 181 },
  ])
    assert.throws(() =>
      f.app.saveRewardSettings({
        ...f.app.getRewardsAdmin().settings,
        ...value,
      }),
    );
});

const completionNotices = (f) =>
  f.sent.filter((x) => x.payload.tag.startsWith("bath-completion-"));
function reportSubscription(name = "report") {
  const key = createECDH("prime256v1");
  key.generateKeys();
  return {
    endpoint: "https://web.push.apple.com/" + name,
    keys: {
      p256dh: key.getPublicKey().toString("base64url"),
      auth: randomBytes(16).toString("base64url"),
    },
  };
}
async function enableReportPush(f, sub = reportSubscription()) {
  await f.api("notification-preferences", {
    reservationTurn: false,
    bathReminder: false,
  });
  await f.api("push/subscribe", { subscription: sub });
  return sub;
}

test("予約終了時の報告通知は本人の全端末へ一度だけ送り、再起動・設定切替で重複しない", async (t) => {
  const f = await fixture(t);
  const sub = await enableReportPush(f);
  await f.api("push/subscribe", {
    subscription: reportSubscription("second-device"),
  });
  await f.book(1);
  f.time("2026-10-25T18:29:59");
  await f.app.flushNotifications();
  assert.equal(completionNotices(f).length, 0);
  f.time("2026-10-25T18:30:00");
  await f.app.flushNotifications();
  assert.equal(completionNotices(f).length, 2);
  assert.match(
    completionNotices(f)[0].payload.body,
    /上がったら入浴完了を報告/,
  );
  await f.app.flushNotifications();
  await f.restart();
  await f.api("notification-preferences", { completionReminder: false });
  await f.api("notification-preferences", { completionReminder: true });
  await f.api("push/subscribe", { subscription: sub });
  await f.app.flushNotifications();
  assert.equal(completionNotices(f).length, 2);
});

test("早上がり報告・キャンセル・通知無効・ログアウトでは終了通知を送らない", async (t) => {
  for (const mode of ["complete", "cancel", "disabled", "logout"]) {
    const f = await fixture(t);
    await enableReportPush(f);
    await f.book(1);
    const booking = (await f.state()).bookings[0];
    if (mode === "complete") {
      f.time("2026-10-25T18:05:00");
      await f.api("complete", {
        day: "2026-10-25",
        revision: booking.revision,
      });
    }
    if (mode === "cancel") await f.api("cancel", { day: "2026-10-25" });
    if (mode === "disabled")
      await f.api("notification-preferences", { completionReminder: false });
    if (mode === "logout") await f.api("logout", {});
    f.time("2026-10-25T18:30:00");
    await f.app.flushNotifications();
    assert.equal(completionNotices(f).length, 0, mode);
  }
});

test("予約終了通知は時間変更・期限設定に追従し、再起動時は報告可能な間だけ追送する", async (t) => {
  const f = await fixture(t);
  await enableReportPush(f);
  await f.book(1);
  await f.book(1, 1110, 30);
  f.time("2026-10-25T18:30:00");
  await f.app.flushNotifications();
  assert.equal(completionNotices(f).length, 0);
  f.app.saveRewardSettings({
    ...f.app.getRewardsAdmin().settings,
    clientReportMinutes: 10,
  });
  f.time("2026-10-25T19:05:00");
  await f.restart();
  await f.app.flushNotifications();
  assert.equal(completionNotices(f).length, 1);
  assert.ok(completionNotices(f)[0].options.ttl <= 300);
  const expired = await fixture(t);
  await enableReportPush(expired);
  await expired.book(1);
  expired.time("2026-10-25T18:33:01");
  await expired.restart();
  await expired.app.flushNotifications();
  assert.equal(completionNotices(expired).length, 0);
});

test("終了通知の一時失敗を再試行し、報告済み・端末の利用者変更後には送らない", async (t) => {
  let failed = false;
  const f = await fixture(t, {
    deliverPush: async (_sub, payload) => {
      if (payload.tag.startsWith("bath-completion-") && !failed) {
        failed = true;
        throw { statusCode: 503 };
      }
    },
  });
  const sub = await enableReportPush(f);
  await f.book(1);
  f.time("2026-10-25T18:30:00");
  await f.app.flushNotifications();
  assert.equal(completionNotices(f).length, 0);
  f.time("2026-10-25T18:30:15");
  await f.app.flushNotifications();
  assert.equal(completionNotices(f).length, 1);
  const moved = await fixture(t);
  await enableReportPush(moved, sub);
  await moved.book(1);
  await moved.api("push/subscribe", { subscription: sub }, 2);
  moved.time("2026-10-25T18:30:00");
  await moved.app.flushNotifications();
  assert.equal(completionNotices(moved).length, 0);
  const done = await fixture(t, {
    deliverPush: async (_sub, payload) => {
      if (payload.tag.startsWith("bath-completion-")) throw { statusCode: 503 };
    },
  });
  await enableReportPush(done);
  await done.book(1);
  done.time("2026-10-25T18:30:00");
  await done.app.flushNotifications();
  const booking = (await done.state()).bookings[0];
  await done.api("complete", { day: "2026-10-25", revision: booking.revision });
  done.time("2026-10-25T18:30:30");
  await done.app.flushNotifications();
  assert.equal(completionNotices(done).length, 0);
});

test("自動の様子見も連続判定し、1日設定でも入力時ではなく入浴終了時に失敗を確定する", async (t) => {
  const f = await fixture(t);
  await f.api("auto-standby", { enabled: true });
  f.time("2026-10-26T08:00:00");
  await f.state();
  f.time("2026-10-27T08:00:00");
  const state = await f.state();
  assert.equal(state.standbyWarning.days, 2);
  assert.equal(state.rewards.card.days[1].status, "pending");
  f.time("2026-10-28T07:00:00");
  const card = (await f.api("rewards?week=2026-10-25")).card;
  assert.deepEqual(
    card.days.slice(1, 3).map((x) => x.status),
    ["failed", "failed"],
  );
  f.app.resetAllData({ confirmation: "RESET_ALL_DATA" });
  const db = new DatabaseSync(f.database);
  try {
    assert.equal(
      db.prepare("SELECT count(*) AS n FROM standby_stamps").get().n,
      0,
    );
    assert.equal(
      db.prepare("SELECT count(*) AS n FROM completion_reminders").get().n,
      0,
    );
  } finally {
    db.close();
  }
  const one = await fixture(t);
  one.app.saveRewardSettings({
    ...one.app.getRewardsAdmin().settings,
    standbyFailureDays: 1,
  });
  await one.api("skip", { day: "2026-10-25", skip: true });
  assert.equal((await one.state()).rewards.card.days[0].status, "pending");
  one.time("2026-10-26T06:59:59");
  assert.equal((await one.state()).rewards.card.days[0].status, "pending");
  one.time("2026-10-26T07:00:00");
  assert.equal((await one.state()).rewards.card.days[0].status, "failed");
});

test("翌日に入浴報告がなければ以前の様子見を保留し続けず、入浴期限の長い方まで待つ", async (t) => {
  const f = await fixture(t);
  f.app.saveRewardSettings({
    ...f.app.getRewardsAdmin().settings,
    clientReportMinutes: 1,
    dashboardReportMinutes: 10,
  });
  await f.api("skip", { day: "2026-10-25", skip: true });
  f.time("2026-10-26T08:00:00");
  await f.book(1, 1080, 30, null, "2026-10-26");
  f.time("2026-10-26T18:40:00");
  assert.equal((await f.state()).rewards.card.days[0].status, "pending");
  f.time("2026-10-26T18:40:01");
  assert.equal((await f.state()).rewards.card.days[0].status, "failed");
});

test("スタンプとインクの初期報酬・旧設定の補完・固定報酬と配布に対応する", async (t) => {
  const f = await fixture(t);
  let config = f.app.getRewardsAdmin().settings;
  assert.equal(config.weights.bathStamp, 0);
  assert.equal(config.weights.stampInk, config.weights.extend);
  assert.equal(config.quantities.stampInk, 1);
  const db = new DatabaseSync(f.database);
  delete config.quantities.bathStamp;
  delete config.quantities.stampInk;
  delete config.weights.bathStamp;
  delete config.weights.stampInk;
  db.prepare("INSERT INTO reward_settings VALUES(1,?)").run(
    JSON.stringify(config),
  );
  db.close();
  await f.restart();
  config = f.app.getRewardsAdmin().settings;
  assert.equal(config.weights.bathStamp, 0);
  assert.equal(config.weights.stampInk, 1);
  for (const fixedKind of ["bathStamp", "stampInk"])
    f.app.saveRewardSettings({ ...config, rewardMode: "fixed", fixedKind });
  await f.grant(1, ["bathStamp", "stampInk"], 2);
  const wallet = (await f.state()).rewards.wallet;
  for (const kind of ["bathStamp", "stampInk"])
    assert.equal(wallet.find((x) => x.kind === kind).quantity, 2);
});

test("インクは本人の今週の失敗だけを成功にし、スタンプは残り、予約・完了報告を変えない", async (t) => {
  const f = await fixture(t);
  await f.book(1);
  await f.grant(1, ["bathStamp", "stampInk"], 2);
  f.time("2026-10-26T08:00:00");
  assert.equal((await f.state()).rewards.card.days[0].status, "failed");
  const body = { day: "2026-10-25", requestId: randomUUID(), memberId: 2 };
  await Promise.all([f.api("items/stamp", body), f.api("items/stamp", body)]);
  const card = (await f.state()).rewards.card;
  assert.equal(card.days[0].status, "stamp");
  assert.equal(card.days[0].reason, "ink");
  assert.equal((await f.state(2)).rewards.card.days[0].status, "failed");
  const wallet = (await f.state()).rewards.wallet;
  assert.equal(wallet.find((x) => x.kind === "bathStamp").quantity, 2);
  assert.equal(wallet.find((x) => x.kind === "stampInk").quantity, 1);
  const db = new DatabaseSync(f.database);
  assert.equal(
    db.prepare("SELECT COUNT(*) n FROM bath_completions").get().n,
    0,
  );
  assert.equal(
    db
      .prepare(
        "SELECT COUNT(*) n FROM bookings WHERE day='2026-10-25' AND member_id=1",
      )
      .get().n,
    1,
  );
  assert.equal(
    db
      .prepare(
        "SELECT COUNT(*) n FROM item_ledger WHERE kind='stampInk' AND delta=-1",
      )
      .get().n,
    1,
  );
  db.close();
  await f.restart();
  await f.api("items/stamp", body);
  assert.equal(
    (await f.state()).rewards.wallet.find((x) => x.kind === "stampInk")
      .quantity,
    1,
  );
  assert.equal(
    (await f.request("items/stamp", { ...body, requestId: randomUUID() }))
      .status,
    409,
  );
  assert.equal((await f.request("items/stamp", body, 2)).status, 409);
  assert.equal(
    (await f.request("items/stamp", { ...body, day: "2026-10-26" })).status,
    409,
  );
});

test("スタンプ・インク不足、未来日・過去週・不正日付、アイテム無効時は消費せず拒否する", async (t) => {
  const f = await fixture(t);
  await f.grant(1, ["stampInk"]);
  f.time("2026-10-26T08:00:00");
  const use = (day) =>
    f.request("items/stamp", { day, requestId: randomUUID() });
  assert.equal((await use("2026-10-25")).status, 409);
  await f.grant(1, ["bathStamp"]);
  for (const day of ["2026-10-17", "2026-10-27", "2026-10-31"])
    assert.equal((await use(day)).status, 409);
  for (const day of ["2026-02-30", "bad", null])
    assert.equal((await use(day)).status, 400);
  const config = f.app.getRewardsAdmin().settings;
  f.app.saveRewardSettings({ ...config, itemsEnabled: false });
  assert.equal((await use("2026-10-25")).status, 409);
  f.app.saveRewardSettings(config);
  assert.equal(
    (await f.state()).rewards.wallet.find((x) => x.kind === "stampInk")
      .quantity,
    1,
  );
  await f.api("items/stamp", { day: "2026-10-25", requestId: randomUUID() });
  f.time("2026-10-27T08:00:00");
  assert.equal((await use("2026-10-26")).status, 409);
  assert.equal((await f.state()).rewards.card.days[1].status, "failed");
});

test("インクで7日そろうと報酬を一度だけ配布し、インクのルーレット当選と固定スタンプ報酬を受け取れる", async (t) => {
  const f = await fixture(t);
  const config = f.app.getRewardsAdmin().settings;
  f.app.saveRewardSettings({
    ...config,
    weights: Object.fromEntries(
      Object.keys(config.weights).map((k) => [k, k === "stampInk" ? 1 : 0]),
    ),
  });
  await f.grant(1, ["bathStamp", "stampInk"]);
  for (let i = 0; i < 7; i++) {
    const day = addDay("2026-10-25", i);
    f.time(day + "T08:00:00");
    await f.book(1, 1080, 30, null, day);
    if (i === 2) continue;
    const b = (await f.state()).bookings.find((x) => x.memberId === 1);
    f.time(day + "T18:20:00");
    await f.api("complete", { day, revision: b.revision });
  }
  const body = { day: "2026-10-27", requestId: randomUUID() };
  await f.api("items/stamp", body);
  let rewards = (await f.state()).rewards;
  assert.equal(rewards.card.achieved, true);
  assert.equal(rewards.card.claimed.kind, "stampInk");
  assert.equal(rewards.card.claimed.quantity, 1);
  assert.equal(rewards.gifts.filter((x) => x.rewardWeek).length, 1);
  await f.api("items/stamp", body);
  await f.restart();
  rewards = (await f.state()).rewards;
  assert.equal(rewards.gifts.filter((x) => x.rewardWeek).length, 1);
  await f.api("gifts/receive", {
    id: rewards.gifts.find((x) => x.rewardWeek).id,
  });
  assert.equal(
    (await f.state()).rewards.wallet.find((x) => x.kind === "stampInk")
      .quantity,
    1,
  );
  // A subsequent week's fixed reward may explicitly grant the stamp itself.
  f.app.saveRewardSettings({
    ...config,
    rewardMode: "fixed",
    fixedKind: "bathStamp",
  });
  for (let i = 0; i < 7; i++) {
    const day = addDay("2026-11-01", i);
    f.time(day + "T08:00:00");
    await f.book(1, 1080, 30, null, day);
    const b = (await f.state()).bookings.find((x) => x.memberId === 1);
    f.time(day + "T18:20:00");
    await f.api("complete", { day, revision: b.revision });
  }
  assert.equal((await f.state()).rewards.card.claimed.kind, "bathStamp");
});

test("インクは今日の未確定・過去日の保留にも使え、未来日と成功済みには使えない", async (t) => {
  const f = await fixture(t);
  await f.grant(1, ["bathStamp", "stampInk"], 3);
  await f.api("skip", { day: "2026-10-25", skip: true });
  f.time("2026-10-26T06:00:00");
  let card = (await f.state()).rewards.card;
  assert.equal(card.days[0].status, "pending");
  assert.equal(card.days[1].status, "pending");
  assert.equal(
    (
      await f.request("items/stamp", {
        day: "2026-10-27",
        requestId: randomUUID(),
      })
    ).status,
    409,
  );
  for (const day of ["2026-10-25", "2026-10-26"])
    await f.api("items/stamp", { day, requestId: randomUUID() });
  card = (await f.state()).rewards.card;
  assert.deepEqual(
    card.days.slice(0, 2).map((d) => d.status),
    ["stamp", "stamp"],
  );
  assert.equal(
    (
      await f.request("items/stamp", {
        day: "2026-10-26",
        requestId: randomUUID(),
      })
    ).status,
    409,
  );
  const db = new DatabaseSync(f.database);
  assert.equal(
    db.prepare("SELECT COUNT(*) n FROM bath_completions").get().n,
    0,
  );
  db.close();
  assert.equal(
    (await f.state()).rewards.wallet.find((x) => x.kind === "stampInk")
      .quantity,
    1,
  );
});

const weeklyPlan = (weekday, start = 1200, duration = 30) => ({
  days: Array.from({ length: 7 }, (_, i) => ({
    weekday: i,
    enabled: i === weekday,
    start,
    duration,
    note: "毎週の希望",
  })),
});

test("曜日ごとの自動希望は本人だけが設定でき、不正な曜日・刻み幅・長さを拒否する", async (t) => {
  const f = await fixture(t);
  assert.equal(
    (await f.api("auto-wishes")).days.filter((d) => d.enabled).length,
    0,
  );
  assert.equal((await f.request("auto-wishes", {}, 99)).status, 401);
  const config = weeklyPlan(1);
  await f.api("auto-wishes", { ...config, memberId: 2 });
  assert.deepEqual(await f.api("auto-wishes"), config);
  assert.equal(
    (await f.api("auto-wishes", undefined, 2)).days.some((d) => d.enabled),
    false,
  );
  for (const value of [
    { days: [] },
    { days: config.days.map((d) => ({ ...d, weekday: 0 })) },
    weeklyPlan(1, 1201),
    weeklyPlan(1, 1200, 200),
    { days: config.days.map((d) => ({ ...d, enabled: "yes" })) },
  ])
    assert.equal((await f.request("auto-wishes", value)).status, 400);
});

test("日付が変わるとアクセスなしで自動希望を送り、固定順で確定・通常の成功通知を一度だけ送る", async (t) => {
  const f = await fixture(t);
  await enableReportPush(f, reportSubscription("automatic-success"));
  await f.api("auto-wishes", weeklyPlan(1, 1200));
  assert.equal(
    f.app.notificationDueAt(),
    Date.parse("2026-10-26T00:00:00+09:00"),
  );
  f.time("2026-10-26T00:00:00");
  await f.app.flushNotifications();
  let s = await f.state();
  assert.equal(s.bookings.find((b) => b.memberId === 1).start, 1200);
  assert.equal(s.bookings[0].autoConfirmed, 1);
  const revision = s.bookings[0].revision;
  assert.equal(
    f.sent.filter((n) => n.payload.tag.startsWith("bath-wish-wishConfirmed"))
      .length,
    1,
  );
  await f.app.flushNotifications();
  await f.restart();
  await f.app.flushNotifications();
  s = await f.state();
  assert.equal(s.bookings[0].revision, revision);
  assert.equal(
    f.sent.filter((n) => n.payload.tag.startsWith("bath-wish-wishConfirmed"))
      .length,
    1,
  );
  assert.equal(
    f.app.notificationDueAt() > Date.parse("2026-10-26T00:00:00+09:00"),
    true,
  );
});

test("自動希望は順番が来る前には出さず、取り消した希望を出し直さない", async (t) => {
  const f = await fixture(t);
  await f.api("auto-wishes", weeklyPlan(1), 2);
  f.time("2026-10-26T00:00:00");
  await f.app.flushNotifications();
  let s = await f.state();
  assert.equal(s.wishes.length, 0);
  assert.equal(s.bookings.length, 0);
  // The first person's booking makes member 2 eligible; only now is the plan submitted.
  await f.book(1, 1200, 30, null, "2026-10-26");
  s = await f.state();
  assert.equal(s.wishes.find((w) => w.memberId === 2).start, 1200);
  await f.api("wish/cancel", { day: "2026-10-26" }, 2);
  await f.app.flushNotifications();
  await f.restart();
  assert.equal(
    (await f.state()).wishes.some((w) => w.memberId === 2),
    false,
  );
  const other = await fixture(t, { random: true });
  await other.api("skip", { day: "2026-10-25", skip: true });
  await other.api("auto-wishes", weeklyPlan(0));
  assert.equal((await other.state()).skips.includes(1), true);
  assert.equal((await other.state()).wishes.length, 0);
});

test("自動希望は順番に確定し、重複は通常の失敗通知と通知の有効無効を使う", async (t) => {
  const f = await fixture(t);
  const config = f.app.getServerSettings();
  f.app.saveServerSettings({
    members: config.members,
    schedule: config.current,
    ignoreLowerPriorityWishes: false,
  });
  await f.api(
    "notification-preferences",
    { reservationTurn: false, bathReminder: false },
    2,
  );
  await f.api(
    "push/subscribe",
    { subscription: reportSubscription("automatic-conflict") },
    2,
  );
  await f.api("auto-wishes", weeklyPlan(1));
  await f.api("auto-wishes", weeklyPlan(1), 2);
  f.time("2026-10-26T00:00:00");
  await f.app.flushNotifications();
  const s = await f.state();
  assert.equal(s.wishes.length, 1);
  assert.equal(s.bookings.length, 1);
  assert.equal(
    f.sent.filter((n) => n.payload.tag.startsWith("bath-wish-wishUnconfirmed"))
      .length,
    1,
  );
  await f.app.flushNotifications();
  assert.equal(
    f.sent.filter((n) => n.payload.tag.startsWith("bath-wish-wishUnconfirmed"))
      .length,
    1,
  );
  await f.api("notification-preferences", { wishUnconfirmed: false }, 2);
  await f.api("auto-wishes", weeklyPlan(2));
  await f.api("auto-wishes", weeklyPlan(2), 2);
  f.time("2026-10-27T00:00:00");
  await f.app.flushNotifications();
  assert.equal(
    f.sent.filter((n) => n.payload.tag.startsWith("bath-wish-wishUnconfirmed"))
      .length,
    1,
  );
});

test("自動希望は翌朝の時刻を正しく所属させ、停止中に開始を過ぎた場合も通常の失敗通知を送る", async (t) => {
  const f = await fixture(t);
  await f.api("auto-wishes", weeklyPlan(1, 180));
  f.time("2026-10-26T08:00:00");
  await f.app.flushNotifications();
  assert.equal(
    (await f.state()).bookings.find((b) => b.memberId === 1).start,
    1620,
  );
  const missed = await fixture(t);
  await enableReportPush(missed, reportSubscription("automatic-missed"));
  await missed.api("auto-wishes", weeklyPlan(1, 1200));
  f.time("2026-10-27T04:00:00");
  missed.time("2026-10-26T23:00:00");
  await missed.restart();
  await missed.app.flushNotifications();
  assert.equal((await missed.state()).wishes.length, 0);
  assert.equal(
    missed.sent.filter((n) =>
      n.payload.tag.startsWith("bath-wish-wishUnconfirmed"),
    ).length,
    1,
  );
  await missed.app.flushNotifications();
  assert.equal(
    missed.sent.filter((n) =>
      n.payload.tag.startsWith("bath-wish-wishUnconfirmed"),
    ).length,
    1,
  );
});

test("自動希望は予約済みの枠を変えず、設定を無効にすれば次の曜日に送らない・全リセットで消える", async (t) => {
  const f = await fixture(t);
  await f.book(1, 1080, 30);
  await f.api("auto-wishes", weeklyPlan(0, 1200));
  assert.equal((await f.state()).bookings[0].start, 1080);
  await f.api("auto-wishes", weeklyPlan(1, 1200));
  const disabled = weeklyPlan(1);
  disabled.days.forEach((d) => (d.enabled = false));
  await f.api("auto-wishes", disabled);
  f.time("2026-10-26T00:00:00");
  await f.app.flushNotifications();
  assert.equal((await f.state()).bookings.length, 0);
  await f.api("auto-wishes", weeklyPlan(2));
  assert.notEqual(f.app.notificationDueAt(), null);
  f.app.resetAllData({ confirmation: "RESET_ALL_DATA" });
  assert.equal(f.app.notificationDueAt(), null);
  const db = new DatabaseSync(f.database);
  assert.equal(
    db.prepare("SELECT count(*) n FROM auto_wish_preferences").get().n,
    0,
  );
  assert.equal(db.prepare("SELECT count(*) n FROM auto_wish_runs").get().n, 0);
  db.close();
});

test("遅延した自動希望の失敗通知も、本人が別の希望を出していれば破棄する", async (t) => {
  const f = await fixture(t);
  await enableReportPush(f, reportSubscription("automatic-stale"));
  await f.api("auto-wishes", weeklyPlan(1, 1200));
  f.time("2026-10-26T21:00:00");
  await f.restart();
  await f.api("wish", { day: "2026-10-26", start: 1380, duration: 30 });
  await f.app.flushNotifications();
  assert.equal(
    f.sent.filter((n) => n.payload.tag.startsWith("bath-wish-wishUnconfirmed"))
      .length,
    0,
  );
});

test("抽選モードでは抽選前も順番待ちの間も送らず、自分の番で自動確定する", async (t) => {
  const f = await fixture(t, { random: true });
  for (const id of [1, 2, 3])
    await f.api("auto-wishes", weeklyPlan(1, 1080 + id * 60), id);
  f.time("2026-10-26T00:00:00");
  await f.app.flushNotifications();
  let s = await f.state();
  assert.equal(s.wishes.length, 0);
  assert.equal(s.bookings.length, 0);
  // Reserve every member through the ordinary draw->turn chain, without opening any booking form.
  await f.api("draw", { day: "2026-10-26" });
  s = await f.state();
  assert.equal(s.bookings.length, 3);
  assert.equal(s.wishes.length, 0);
  for (const id of [1, 2, 3])
    assert.equal(
      s.bookings.find((b) => b.memberId === id).start,
      1080 + id * 60,
    );
});

test("順番前に手入力した希望を取り消した日は、自動希望を作らない", async (t) => {
  const f = await fixture(t);
  await f.api("auto-wishes", weeklyPlan(1), 2);
  await f.api("wish", { day: "2026-10-26", start: 1260, duration: 30 }, 2);
  f.time("2026-10-26T00:00:00");
  await f.api("wish/cancel", { day: "2026-10-26" }, 2);
  await f.book(1, 1080, 30, null, "2026-10-26");
  const s = await f.state();
  assert.equal(s.wishes.length, 0);
  assert.equal(s.bookings.length, 1);
});

test("自動希望の失敗通知を待つ間に様子見へ変えたら未送信の通知を破棄する", async (t) => {
  const f = await fixture(t);
  await enableReportPush(f, reportSubscription("automatic-standby-stale"));
  await f.api("auto-wishes", weeklyPlan(1, 1200));
  f.time("2026-10-26T21:00:00");
  await f.restart();
  await f.api("skip", { day: "2026-10-26", skip: true });
  await f.app.flushNotifications();
  assert.equal(
    f.sent.filter((n) => n.payload.tag.startsWith("bath-wish-wishUnconfirmed"))
      .length,
    0,
  );
});

test("入らない/様子見を翌日・明後日に共有・撤回でき、先行抽選はしない", async (t) => {
  const f = await fixture(t);
  for (const day of ["2026-10-26", "2026-10-27"]) {
    await f.api("skip", { day, skip: true });
    let s = await f.api("state?day=" + day);
    assert.equal(s.draw, null);
    assert.deepEqual(s.skips, [1]);
    await f.api("skip", { day, skip: false });
    assert.deepEqual((await f.api("state?day=" + day)).skips, []);
  }
  await f.api("skip", { day: "2026-10-26", skip: true });
  f.time("2026-10-26T08:00:00");
  const s = await f.state();
  assert.equal(s.draw.order.at(-1), 1);
  assert.equal(s.skips.includes(1), true);
});

test("順番前の希望は開始ちょうどに空き枠ならアクセスなしで確定・通常の通知を送り、再起動で重複しない", async (t) => {
  const f = await fixture(t);
  await f.api(
    "notification-preferences",
    { reservationTurn: false, bathReminder: false },
    2,
  );
  await f.api(
    "push/subscribe",
    { subscription: reportSubscription("wish-start") },
    2,
  );
  await f.api(
    "wish",
    { day: "2026-10-25", start: 1200, duration: 30, note: "先に希望" },
    2,
  );
  assert.equal(
    f.app.notificationDueAt(),
    Date.parse("2026-10-25T20:00:00+09:00"),
  );
  f.time("2026-10-25T19:59:59");
  await f.app.flushNotifications();
  assert.equal((await f.state()).bookings.length, 0);
  f.time("2026-10-25T20:00:00");
  await f.app.flushNotifications();
  let s = await f.state();
  assert.equal(s.bookings.length, 1);
  const b = s.bookings[0];
  assert.equal(b.memberId, 2);
  assert.equal(b.start, 1200);
  assert.equal(b.autoConfirmed, 1);
  assert.equal(b.note, "先に希望");
  assert.deepEqual(s.draw.order, [1, 2, 3]);
  assert.equal(
    f.sent.filter((n) => n.payload.tag.startsWith("bath-wish-wishConfirmed"))
      .length,
    1,
  );
  await f.restart();
  await f.app.flushNotifications();
  s = await f.state();
  assert.equal(s.bookings[0].revision, b.revision);
  assert.equal(
    f.sent.filter((n) => n.payload.tag.startsWith("bath-wish-wishConfirmed"))
      .length,
    1,
  );
});

test("開始時刻の確定でも予約・希望の重複を許さず、失敗後にタイマーが空回りしない", async (t) => {
  const f = await fixture(t);
  await f.book(1, 1200, 30);
  await f.api("wish", { day: "2026-10-25", start: 1200, duration: 30 }, 3);
  f.time("2026-10-25T20:00:00");
  await f.app.flushNotifications();
  assert.equal(
    (await f.state()).bookings.some((b) => b.memberId === 3),
    false,
  );
  assert.equal(
    (await f.state()).wishes.some((w) => w.memberId === 3),
    true,
  );
  assert.equal(
    f.app.notificationDueAt() > Date.parse("2026-10-25T20:00:00+09:00") ||
      f.app.notificationDueAt() === null,
    true,
  );
  const other = await fixture(t);
  for (const id of [2, 3])
    await other.api(
      "wish",
      { day: "2026-10-25", start: 1200, duration: 30 },
      id,
    );
  other.time("2026-10-25T20:00:00");
  await other.app.flushNotifications();
  assert.equal((await other.state()).bookings.length, 0);
});

test("日付の異なる予約とも重複判定し、終了と開始の一致は許可する", async (t) => {
  for (const duration of [30, 90]) {
    const f = await fixture(t);
    await f.api("wish", { day: "2026-10-25", start: 1830, duration }, 2);
    f.time("2026-10-26T00:00:00");
    await f.book(1, 420, 30, null, "2026-10-26");
    f.time("2026-10-26T06:30:00");
    await f.app.flushNotifications();
    const s = await f.api("state?day=2026-10-25");
    assert.equal(
      s.bookings.some((b) => b.memberId === 2),
      duration === 30,
    );
  }
});

test("開始時刻で確定してもチケットの使用制限を無視せず、消費しない", async (t) => {
  const f = await fixture(t);
  f.app.saveRewardSettings({
    ...f.app.getRewardsAdmin().settings,
    extensionBlocked: false,
  });
  await f.grant(2, ["extend"]);
  await f.api(
    "wish",
    { day: "2026-10-25", start: 1080, duration: 120, ticket: "extend" },
    2,
  );
  f.time("2026-10-25T18:00:00");
  await f.app.flushNotifications();
  const s = await f.state(2);
  assert.equal(s.bookings.length, 0);
  assert.equal(s.rewards.wallet.find((x) => x.kind === "extend").quantity, 1);
});

test("インクは先週にも使え、前週の7日達成報酬を一度だけ発行する", async (t) => {
  const f = await fixture(t);
  await f.grant(1, ["bathStamp", "stampInk"]);
  for (let i = 0; i < 7; i++) {
    const day = addDay("2026-10-25", i);
    f.time(day + "T08:00:00");
    await f.book(1, 1080, 30, null, day);
    if (i === 2) continue;
    const b = (await f.state()).bookings.find((b) => b.memberId === 1);
    f.time(day + "T18:20:00");
    await f.api("complete", { day, revision: b.revision });
  }
  f.time("2026-11-02T08:00:00");
  const body = { day: "2026-10-27", requestId: randomUUID() };
  await f.api("items/stamp", body);
  await f.api("items/stamp", body);
  const card = (await f.api("rewards?week=2026-10-25")).card;
  assert.equal(card.achieved, true);
  assert.equal(
    (await f.state()).rewards.gifts.filter((g) => g.rewardWeek === "2026-10-25")
      .length,
    1,
  );
  assert.equal(
    (
      await f.request("items/stamp", {
        day: "2026-10-24",
        requestId: randomUUID(),
      })
    ).status,
    409,
  );
});
