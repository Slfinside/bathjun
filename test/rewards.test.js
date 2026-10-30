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
async function fixture(t, { random = false } = {}) {
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
      deliverPush: async (sub, payload) => sent.push({ sub, payload }),
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
test("確率UPは使用から3日間、再送で重複消費せず、抽選回数で減らさない", async (t) => {
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
  assert.equal((await f.state()).rewards.boostRemaining, 3);
  assert.equal((await f.request("draw", { day: "2026-10-25" })).status, 409);
  assert.equal((await f.state()).rewards.boostRemaining, 3);
  f.time("2026-10-28T07:59:59");
  assert.equal((await f.state()).rewards.boostRemaining, 1);
  await f.restart();
  f.time("2026-10-28T08:00:00");
  assert.equal((await f.state()).rewards.boostRemaining, 0);
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
  assert.equal(admin.settings.boostDays, 3);
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

test("旧RCの残回数を日数へ一度だけ移行し、既存の設定と持ち物を保つ", async (t) => {
  const f = await fixture(t);
  await f.grant(1, ["boost"], 2);
  const legacy = { ...f.app.getRewardsAdmin().settings, boostDraws: 7 };
  delete legacy.boostDays;
  for (const key of [
    "extensionBlocked",
    "extensionBlockedStart",
    "extensionBlockedEnd",
    "extensionNoticeMinutes",
    "skipNoticeMinutes",
  ])
    delete legacy[key];
  const db = new DatabaseSync(f.database);
  db.exec("ALTER TABLE lottery_boosts DROP COLUMN expires_at");
  db.prepare("INSERT INTO lottery_boosts(member_id,remaining) VALUES(?,?)").run(
    1,
    2,
  );
  db.prepare(
    "INSERT INTO reward_settings VALUES(1,?) ON CONFLICT(id) DO UPDATE SET value_json=excluded.value_json",
  ).run(JSON.stringify(legacy));
  db.close();
  await f.restart();
  let reward = (await f.state()).rewards;
  assert.equal(reward.boostRemaining, 2);
  assert.equal(reward.settings.boostDays, 7);
  assert.equal(reward.settings.skipNoticeMinutes, 120);
  const expiry = reward.boostExpiresAt;
  f.time("2026-10-26T08:00:00");
  await f.restart();
  assert.equal((await f.state()).rewards.boostRemaining, 1);
  assert.equal((await f.state()).rewards.boostExpiresAt, expiry);
  const requestId = randomUUID();
  await f.api("items/boost", { requestId });
  assert.equal((await f.state()).rewards.boostRemaining, 8);
  await f.api("items/boost", { requestId });
  assert.equal((await f.state()).rewards.boostRemaining, 8);
  assert.equal(
    (await f.state()).rewards.wallet.find((x) => x.kind === "boost").quantity,
    1,
  );
});
