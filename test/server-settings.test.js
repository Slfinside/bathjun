import { seedTestMembers } from "../test-support/household.js";
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createApp } from "../src/app.js";
import { DEFAULT_SCHEDULE, validateSchedule } from "../src/server-settings.js";
async function fixture(t) {
  let now = new Date("2026-10-28T08:00:00+09:00");
  const app = createApp({ now: () => now, requireFamily: false });
  seedTestMembers(app);
  const server = createServer(app.handle);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(async () => {
    await new Promise((r) => server.close(r));
    app.close();
  });
  const base = `http://127.0.0.1:${server.address().port}/api/`;
  async function api(path, body, cookie = "") {
    const r = await fetch(base + path, {
      ...(body === undefined
        ? {}
        : { method: "POST", body: JSON.stringify(body) }),
      headers: { cookie, "Content-Type": "application/json" },
    });
    return {
      status: r.status,
      body: await r.json(),
      cookie: r.headers.get("Set-Cookie")?.split(";")[0],
    };
  }
  return { app, api, setTime: (value) => (now = new Date(value)) };
}
test("メンバーの追加・名前変更・利用停止で、IDと履歴を保つ", async (t) => {
  const f = await fixture(t);
  const login = await f.api("register", {
    memberId: 1,
    password: "test-password",
  });
  const initial = f.app.getServerSettings();
  const members = initial.members.map((m) => ({
    ...m,
    name: m.id === 1 ? "お父さん" : m.name,
    active: m.id === 2 ? false : m.active,
  }));
  members.push({ name: "新メンバー", active: true });
  f.app.saveServerSettings({ members, schedule: initial.upcoming });
  const state = await f.api("state", undefined, login.cookie);
  assert.equal(state.body.me.name, "お父さん");
  assert.equal(state.body.members.length, 6);
  const visible = await f.api("members");
  assert.equal(visible.body.members.length, 5);
  assert.equal(
    visible.body.members.some((m) => m.id === 2),
    false,
  );
  assert.equal(
    (await f.api("register", { memberId: 2, password: "test-password" }))
      .status,
    400,
  );
  const added = visible.body.members.find((m) => m.name === "新メンバー");
  assert.ok(added.id > 5);
  const before = f.app.getServerSettings();
  const swapped = before.members.map((m) => ({
    ...m,
    name: m.id === 1 ? "メンバー3" : m.id === 3 ? "お父さん" : m.name,
  }));
  f.app.saveServerSettings({ members: swapped, schedule: before.upcoming });
  assert.equal(
    (await f.api("state", undefined, login.cookie)).body.me.name,
    "メンバー3",
  );
});
test("利用停止で既存のログインを失効し、今日の抽選順は残す", async (t) => {
  const f = await fixture(t);
  const cookie = (
    await f.api("register", { memberId: 1, password: "test-password" })
  ).cookie;
  await f.api("draw", { day: "2026-10-28" }, cookie);
  const before = (await f.api("state", undefined, cookie)).body.draw.order;
  const config = f.app.getServerSettings();
  f.app.saveServerSettings({
    members: config.members.map((m) => ({ ...m, active: m.id !== 1 })),
    schedule: config.upcoming,
  });
  assert.equal((await f.api("state", undefined, cookie)).status, 401);
  assert.equal(
    (await f.api("login", { memberId: 1, password: "test-password" })).status,
    400,
  );
  const other = (
    await f.api("register", { memberId: 2, password: "test-password" })
  ).cookie;
  assert.deepEqual(
    (await f.api("state", undefined, other)).body.draw.order,
    before,
  );
});
test("時間設定は翌日から反映し、旧範囲の外の予約も新ルールで扱う", async (t) => {
  const f = await fixture(t);
  const config = f.app.getServerSettings();
  const schedule = {
    bathStart: 720,
    bathEnd: 1980,
    lotteryStart: 300,
    lotteryEnd: 720,
    minDuration: 20,
    maxDuration: 120,
    step: 10,
  };
  f.app.saveServerSettings({ members: config.members, schedule });
  const first = (
    await f.api("register", { memberId: 1, password: "test-password" })
  ).cookie;
  assert.deepEqual(
    (await f.api("state", undefined, first)).body.settings,
    DEFAULT_SCHEDULE,
  );
  f.setTime("2026-10-29T06:00:00+09:00");
  // The previous day's bath still ends at 07:00, even though today's new rule ends at 09:00.
  assert.equal((await f.api("state", undefined, first)).body.day, "2026-10-28");
  const today = (await f.api("state?day=2026-10-29", undefined, first)).body;
  assert.deepEqual(today.settings, {
    ...schedule,
    lotteryTimeRestricted: false,
    orderMode: "random",
    fixedOrder: [1, 2, 3, 4, 5],
  });
  assert.equal((await f.api("draw", { day: today.day }, first)).status, 200);
  const order = (await f.api("state?day=2026-10-29", undefined, first)).body
    .draw.order;
  const id = order[0];
  const cookie =
    id === 1
      ? first
      : (await f.api("register", { memberId: id, password: "test-password" }))
          .cookie;
  assert.equal(
    (await f.api("book", { day: today.day, start: 720, duration: 120 }, cookie))
      .status,
    200,
  );
  const second = order[1];
  const secondCookie =
    second === 1
      ? first
      : (
          await f.api("register", {
            memberId: second,
            password: "test-password",
          })
        ).cookie;
  assert.equal(
    (
      await f.api(
        "wish",
        { day: today.day, start: 1870, duration: 20 },
        secondCookie,
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await f.api(
        "book",
        { day: today.day, start: 730, duration: 20 },
        secondCookie,
      )
    ).status,
    409,
  );
  assert.equal(
    (
      await f.api(
        "book",
        { day: today.day, start: 1880, duration: 20 },
        secondCookie,
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await f.api(
        "book",
        { day: today.day, start: 1895, duration: 20 },
        secondCookie,
      )
    ).status,
    400,
  );
  f.setTime("2026-10-30T08:30:00+09:00");
  assert.equal((await f.api("state", undefined, first)).body.day, "2026-10-29");
});
test("不正な設定を原子的に拒否し、既存メンバーを消さない", async (t) => {
  const f = await fixture(t);
  const original = f.app.getServerSettings();
  assert.throws(() =>
    f.app.saveServerSettings({
      members: original.members.slice(1),
      schedule: original.upcoming,
    }),
  );
  assert.throws(() =>
    f.app.saveServerSettings({
      members: original.members.map((m) => ({ ...m, active: false })),
      schedule: original.upcoming,
    }),
  );
  assert.throws(() =>
    f.app.saveServerSettings({
      members: original.members.map((m) => ({ ...m, name: "重複" })),
      schedule: original.upcoming,
    }),
  );
  assert.throws(() => validateSchedule({ ...DEFAULT_SCHEDULE, step: 7 }));
  assert.throws(() => validateSchedule({ ...DEFAULT_SCHEDULE, bathEnd: 899 }));
  assert.throws(() =>
    validateSchedule({ ...DEFAULT_SCHEDULE, lotteryTimeRestricted: true, lotteryEnd: 1000 }),
  );
  assert.throws(() =>
    validateSchedule({ ...DEFAULT_SCHEDULE, minDuration: 25 }),
  );
  assert.deepEqual(f.app.getServerSettings(), original);
});
test("固定順モードを翌日から使い、抽選せず予約・スキップできる", async (t) => {
  const f = await fixture(t);
  const cookie = (
    await f.api("register", { memberId: 1, password: "test-password" })
  ).cookie;
  const settings = f.app.getServerSettings();
  const ordered = [3, 1, 5, 2, 4].map((id) =>
    settings.members.find((m) => m.id === id),
  );
  f.app.saveServerSettings({
    members: ordered,
    schedule: { ...settings.upcoming, orderMode: "fixed" },
  });
  assert.equal((await f.api("state", undefined, cookie)).body.draw, null);
  f.setTime("2026-10-29T08:00:00+09:00");
  const state = (await f.api("state", undefined, cookie)).body;
  assert.deepEqual(state.draw.order, [3, 1, 5, 2, 4]);
  assert.equal(state.draw.mode, "fixed");
  assert.equal((await f.api("draw", { day: state.day }, cookie)).status, 409);
  const first = (
    await f.api("register", { memberId: 3, password: "test-password" })
  ).cookie;
  assert.equal(
    (await f.api("book", { day: state.day, start: 900, duration: 30 }, cookie))
      .status,
    403,
  );
  assert.equal(
    (await f.api("skip", { day: state.day, skip: true }, first)).status,
    200,
  );
  assert.equal(
    (await f.api("book", { day: state.day, start: 900, duration: 30 }, cookie))
      .status,
    200,
  );
  // Changing tomorrow's fixed order must not rewrite today's immutable snapshot.
  const saved = f.app.getServerSettings();
  f.app.saveServerSettings({
    members: saved.members.slice().reverse(),
    schedule: saved.upcoming,
  });
  assert.deepEqual(
    (await f.api("state", undefined, cookie)).body.draw.originalOrder,
    [3, 1, 5, 2, 4],
  );
  assert.deepEqual(
    (await f.api("state", undefined, cookie)).body.draw.order,
    [1, 5, 2, 4, 3],
  );
  f.setTime("2026-10-30T08:00:00+09:00");
  assert.deepEqual(
    (await f.api("state", undefined, cookie)).body.draw.order,
    [4, 2, 5, 1, 3],
  );
});
