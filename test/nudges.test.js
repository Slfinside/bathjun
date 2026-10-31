import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, createECDH } from "node:crypto";
import { createApp } from "../src/app.js";
import { DEFAULT_SCHEDULE } from "../src/server-settings.js";
async function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "bathjun-nudge-")),
    database = join(dir, "test.sqlite");
  let clock = new Date("2026-10-27T08:00:00+09:00"),
    server,
    app,
    failure = 0;
  const sent = [];
  const open = () =>
    createApp({
      database,
      requireFamily: false,
      now: () => clock,
      deliverPush: async (sub, payload, keys, options) => {
        if (payload.tag.startsWith("bath-nudge")) {
          if (failure)
            throw Object.assign(new Error("test"), { statusCode: failure });
          sent.push({ endpoint: sub.endpoint, payload, options });
        }
      },
    });
  app = open();
  app.saveServerSettings({
    members: [1, 2, 3].map((i) => ({ name: `メンバー${i}`, active: true })),
    schedule: { ...DEFAULT_SCHEDULE, orderMode: "fixed" },
  });
  clock = new Date("2026-10-28T08:00:00+09:00");
  const cookies = {};
  async function listen() {
    server = createServer(app.handle);
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
  }
  await listen();
  t.after(async () => {
    await new Promise((r) => server.close(r));
    app.close();
    rmSync(dir, { recursive: true, force: true });
  });
  async function request(path, body, id = 2) {
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
  async function api(path, body, id = 2) {
    const result = await request(path, body, id);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    return result.body;
  }
  for (const id of [1, 2, 3])
    cookies[id] = (
      await request("register", { memberId: id, password: "test-only" }, id)
    ).cookie;
  async function subscribe(id, name = id) {
    const key = createECDH("prime256v1");
    key.generateKeys();
    await api(
      "push/subscribe",
      {
        subscription: {
          endpoint: `https://web.push.apple.com/nudge-${name}`,
          keys: {
            p256dh: key.getPublicKey().toString("base64url"),
            auth: randomBytes(16).toString("base64url"),
          },
        },
      },
      id,
    );
  }
  await subscribe(1);
  await api("state");
  await app.flushNotifications();
  return {
    get app() {
      return app;
    },
    request,
    api,
    sent,
    subscribe,
    poke: (id = 2, memberId = 1, day = "2026-10-28") =>
      request("nudge", { day, memberId }, id),
    state: (id = 2) => api("state", undefined, id),
    time: (value) => (clock = new Date(value + "+09:00")),
    fail: (value) => (failure = value),
    restart: async () => {
      await new Promise((r) => server.close(r));
      app.close();
      app = open();
      await listen();
    },
  };
}
test("つつく通知を本人の全端末へ一度ずつ送り、全メンバー共通で1時間に1回まで", async (t) => {
  const f = await fixture(t);
  await f.subscribe(1, "second-phone");
  assert.equal((await f.state()).nudge.canNudge, true);
  assert.equal((await f.state(1)).nudge.reason, "self");
  const result = await Promise.all([f.poke(2), f.poke(3)]);
  assert.deepEqual(result.map((r) => r.status).sort(), [200, 429]);
  assert.equal((await f.state(3)).nudge.canNudge, false);
  await f.app.flushNotifications();
  await f.app.flushNotifications();
  assert.equal(f.sent.length, 2);
  assert.ok(
    f.sent.every(
      (n) =>
        n.payload.title === "お風呂を予約しましょう。" &&
        n.payload.body === "つつかれました。あなたの予約を待っています。" &&
        n.options.ttl <= 300,
    ),
  );
  assert.equal(new Set(f.sent.map((n) => n.payload.tag)).size, 1);
  f.time("2026-10-28T08:59:59");
  assert.equal((await f.poke(3)).status, 429);
  await f.restart();
  assert.equal((await f.state()).nudge.canNudge, false);
  f.time("2026-10-28T09:00:00");
  assert.equal((await f.state()).nudge.canNudge, true);
  assert.equal((await f.poke(3)).status, 200);
  await f.app.flushNotifications();
  assert.equal(f.sent.length, 4);
});
test("本人・順番前・古い対象・未来日を拒否し、予約後の古いつつく通知は破棄", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.poke(1)).status, 403);
  assert.equal((await f.poke(2, 3)).status, 409);
  assert.equal((await f.poke(2, 1, "2026-10-29")).status, 400);
  assert.equal(
    (await f.request("nudge", { day: "2026-10-28", memberId: 1 }, 99)).status,
    401,
  );
  assert.equal((await f.poke()).status, 200);
  await f.api("book", { day: "2026-10-28", start: 1080, duration: 30 }, 1);
  await f.app.flushNotifications();
  assert.equal(f.sent.length, 0);
  assert.equal((await f.poke(3, 1)).status, 409);
});
test("通知未設定・つつく通知の無効化を尊重し、通常の順番通知とは独立する", async (t) => {
  const f = await fixture(t);
  await f.api("notification-preferences", { nudge: false }, 1);
  assert.equal((await f.state()).nudge.reason, "notifications-off");
  assert.equal((await f.poke()).status, 409);
  await f.api(
    "notification-preferences",
    { nudge: true, reservationTurn: false },
    1,
  );
  assert.equal((await f.poke()).status, 200);
  await f.api("notification-preferences", { nudge: false }, 1);
  await f.app.flushNotifications();
  assert.equal(f.sent.length, 0);
  f.time("2026-10-28T09:00:00");
  await f.api("notification-preferences", { nudge: true }, 1);
  await f.api(
    "push/unsubscribe",
    { endpoint: "https://web.push.apple.com/nudge-1" },
    1,
  );
  assert.equal((await f.state()).nudge.reason, "unsubscribed");
  assert.equal((await f.poke()).status, 409);
});
test("一時失敗は再起動後に再試行し、通知成功から1時間は再送を受け付けない", async (t) => {
  const f = await fixture(t);
  f.fail(503);
  assert.equal((await f.poke()).status, 200);
  await f.app.flushNotifications();
  assert.equal(f.sent.length, 0);
  await f.restart();
  f.fail(0);
  f.time("2026-10-28T08:00:30");
  await f.app.flushNotifications();
  assert.equal(f.sent.length, 1);
  f.time("2026-10-28T09:00:00");
  assert.equal((await f.poke()).status, 429);
  f.time("2026-10-28T09:00:30");
  assert.equal((await f.poke()).status, 200);
});
test("失効した通知先は削除し、1時間後の古い再試行と全リセット後には通知しない", async (t) => {
  const f = await fixture(t);
  f.fail(410);
  await f.poke();
  await f.app.flushNotifications();
  f.time("2026-10-28T09:00:00");
  assert.equal((await f.state()).nudge.reason, "unsubscribed");
  await f.subscribe(1, "replacement");
  f.fail(503);
  await f.poke();
  await f.app.flushNotifications();
  f.time("2026-10-28T10:00:00");
  f.fail(0);
  await f.app.flushNotifications();
  assert.equal(f.sent.length, 0);
  await f.poke();
  f.app.resetAllData({ confirmation: "RESET_ALL_DATA" });
  assert.equal(f.app.notificationDueAt(), null);
  await f.app.flushNotifications();
  assert.equal(f.sent.length, 0);
});

test("入浴日の切替をまたいでも同じ受け手への1時間制限を共有する", async (t) => {
  const f = await fixture(t);
  f.time("2026-10-29T01:30:00");
  assert.equal((await f.poke(2, 1, "2026-10-28")).status, 200);
  await f.app.flushNotifications();
  f.time("2026-10-29T02:00:00");
  await f.api("state?day=2026-10-29");
  assert.equal((await f.poke(3, 1, "2026-10-29")).status, 429);
  f.time("2026-10-29T02:30:00");
  assert.equal((await f.poke(3, 1, "2026-10-29")).status, 200);
});

test("通知先が別の利用者へ引き継がれたら古いつつく通知を送らない", async (t) => {
  const f = await fixture(t);
  await f.poke();
  await f.subscribe(2, 1);
  await f.app.flushNotifications();
  assert.equal(f.sent.length, 0);
});
