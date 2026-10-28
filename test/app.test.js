import { seedTestMembers } from "../test-support/household.js";
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SCHEDULE } from "../src/server-settings.js";
import { createApp } from "../src/app.js";
import {
  japanTime,
  lotteryOpen,
  validateSlot,
  shuffle,
} from "../src/domain.js";

async function fixture(t, { at = "2026-10-28T08:00:00+09:00", database } = {}) {
  let clock = new Date(at);
  const app = createApp({ database, now: () => clock, requireFamily: false });
  const initialClock = clock;
  clock = new Date(clock.getTime() - 86400000);
  seedTestMembers(app);
  app.saveServerSettings({members:app.getServerSettings().members,schedule:{...app.getServerSettings().upcoming,lotteryTimeRestricted:true}});
  clock = initialClock;
  const server = createServer(app.handle);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    await new Promise((resolve) => server.close(resolve));
    app.close();
  };
  t.after(stop);
  async function request(path, data, cookie = "", headers = {}) {
    const response = await fetch(`${base}/api/${path}`, {
      ...(data === undefined
        ? {}
        : { method: "POST", body: JSON.stringify(data) }),
      headers: {
        ...(data === undefined ? {} : { "Content-Type": "application/json" }),
        ...(cookie ? { cookie } : {}),
        ...headers,
      },
    });
    return {
      status: response.status,
      body: await response.json(),
      cookie: response.headers.get("set-cookie")?.split(";")[0],
    };
  }
  async function register(id) {
    const r = await request("register", {
      memberId: id,
      password: "test-password-123",
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.cookie;
  }
  return {
    request,
    register,
    stop,
    setTime: (date) => {
      clock = new Date(date);
    },
  };
}

test("日本時間の日付区切りと抽選時間（6:00・15:00・翌7:00）", () => {
  const at = (time) => new Date(`2026-10-28T${time}+09:00`);
  assert.equal(japanTime(at("06:59:59")).activeDay, "2026-10-27");
  assert.equal(japanTime(at("07:00:00")).activeDay, "2026-10-28");
  assert.equal(lotteryOpen("2026-10-28", at("05:59:59"), {...DEFAULT_SCHEDULE,lotteryTimeRestricted:true}), false);
  assert.equal(lotteryOpen("2026-10-28", at("06:00:00"), {...DEFAULT_SCHEDULE,lotteryTimeRestricted:true}), true);
  assert.equal(lotteryOpen("2026-10-28", at("14:59:59"), {...DEFAULT_SCHEDULE,lotteryTimeRestricted:true}), true);
  assert.equal(lotteryOpen("2026-10-28", at("15:00:00"), {...DEFAULT_SCHEDULE,lotteryTimeRestricted:true}), false);
  assert.equal(lotteryOpen("2026-10-27", at("08:00:00"), {...DEFAULT_SCHEDULE,lotteryTimeRestricted:true}), false);
});
test("15〜90分、15分刻み、翌7時までを検証する", () => {
  assert.equal(validateSlot(900, 15), true);
  assert.equal(validateSlot(1770, 90), true);
  for (const args of [
    [885, 30],
    [900, 14],
    [900, 105],
    [901, 30],
    [1845, 30],
    [1800, NaN],
    ["900", 30],
    [900, 22],
  ])
    assert.equal(validateSlot(...args), false);
});
test("抽選は5人の重複のない並び替え", () => {
  for (let i = 0; i < 100; i++)
    assert.deepEqual(shuffle([1, 2, 3, 4, 5]).sort(), [1, 2, 3, 4, 5]);
});
test("初回登録・ログイン・ログアウト・登録済みユーザーの保護", async (t) => {
  const f = await fixture(t);
  const before = await f.request("members");
  assert.equal(before.body.members.length, 5);
  assert.equal(before.body.members[0].registered, 0);
  assert.equal((await f.request("state")).status, 401);
  const cookie = await f.register(1);
  const state = await f.request("state", undefined, cookie);
  assert.equal(state.body.me.name, "メンバー1");
  assert.equal(JSON.stringify(state.body).includes("password_hash"), false);
  assert.equal(
    (
      await f.request("register", {
        memberId: 1,
        password: "different-password",
      })
    ).status,
    409,
  );
  const wrong = await f.request("login", {
    memberId: 1,
    password: "wrong-password",
  });
  assert.equal(wrong.status, 401);
  const login = await f.request("login", {
    memberId: 1,
    password: "test-password-123",
  });
  assert.equal(login.status, 200);
  assert.equal((await f.request("logout", {}, cookie)).status, 200);
  assert.equal((await f.request("state", undefined, cookie)).status, 401);
  assert.equal((await f.request("state", undefined, login.cookie)).status, 200);
});
test("連続したパスワード誤入力は15分ロックする", async (t) => {
  const f = await fixture(t);
  await f.register(1);
  for (let i = 0; i < 5; i++)
    assert.equal(
      (await f.request("login", { memberId: 1, password: "wrong" })).status,
      401,
    );
  assert.equal(
    (await f.request("login", { memberId: 1, password: "test-password-123" }))
      .status,
    429,
  );
  f.setTime("2026-10-28T08:16:00+09:00");
  assert.equal(
    (await f.request("login", { memberId: 1, password: "test-password-123" }))
      .status,
    200,
  );
});
test("複数端末の同時抽選・優先順位・重複防止・変更・取り消し", async (t) => {
  const f = await fixture(t);
  const cookies = {};
  for (let i = 1; i <= 5; i++) cookies[i] = await f.register(i);
  const draws = await Promise.all([
    f.request("draw", { day: "2026-10-28" }, cookies[1]),
    f.request("draw", { day: "2026-10-28" }, cookies[2]),
  ]);
  assert.deepEqual(draws.map((d) => d.status).sort(), [200, 409]);
  const a = (await f.request("state", undefined, cookies[1])).body;
  const b = (await f.request("state", undefined, cookies[2])).body;
  assert.deepEqual(a.draw, b.draw);
  const [first, second, third, fourth, fifth] = a.draw.order;
  const book = (id, start = 900, duration = 30) =>
    f.request("book", { day: a.day, start, duration }, cookies[id]);
  assert.equal((await book(second)).status, 403);
  assert.equal((await book(first)).status, 200);
  assert.equal((await book(second, 915)).status, 409);
  assert.equal((await book(second, 930)).status, 200);
  assert.equal((await book(third, 960, 90)).status, 200);
  assert.equal((await book(first, 945)).status, 409);
  assert.equal((await book(first, 1080, 15)).status, 200);
  const simultaneous = await Promise.all([
    book(fourth, 1110),
    book(fourth, 1140),
  ]);
  assert.deepEqual(
    simultaneous.map((r) => r.status),
    [200, 200],
  );
  assert.equal((await book(fifth, 1200, 15)).status, 200);
  const final = (await f.request("state", undefined, cookies[3])).body;
  assert.equal(final.bookings.length, 5);
  assert.equal(final.bookings.filter((b) => b.memberId === fourth).length, 1);
  assert.equal(
    (await f.request("cancel", { day: a.day }, cookies[first])).status,
    200,
  );
  assert.equal((await book(first, 900, 30)).status, 200);
  f.setTime("2026-10-28T15:01:00+09:00");
  assert.equal((await book(first, 1260, 30)).status, 409);
  assert.equal(
    (await f.request("cancel", { day: a.day }, cookies[first])).status,
    409,
  );
});
test("抽選前の予約・時間外の抽選・翌7時を超える予約を拒否する", async (t) => {
  const f = await fixture(t, { at: "2026-10-28T05:59:00+09:00" });
  const cookie = await f.register(1);
  assert.equal(
    (await f.request("draw", { day: "2026-10-28" }, cookie)).status,
    403,
  );
  assert.equal(
    (
      await f.request(
        "book",
        { day: "2026-10-28", start: 900, duration: 30 },
        cookie,
      )
    ).status,
    409,
  );
  f.setTime("2026-10-28T15:00:00+09:00");
  assert.equal(
    (await f.request("draw", { day: "2026-10-28" }, cookie)).status,
    403,
  );
  assert.equal(
    (
      await f.request(
        "book",
        { day: "2026-10-28", start: 1845, duration: 30 },
        cookie,
      )
    ).status,
    400,
  );
  assert.equal(
    (await f.request("state?day=2026-10-26", undefined, cookie)).status,
    400,
  );
});
test("翌日の深夜も同じ予約を共有し、開始済みの予約は変えられない", async (t) => {
  const f = await fixture(t);
  const cookie = await f.register(1);
  await f.request("draw", { day: "2026-10-28" }, cookie);
  const order = (await f.request("state", undefined, cookie)).body.draw.order;
  const first = order[0];
  const firstCookie = first === 1 ? cookie : await f.register(first);
  assert.equal(
    (
      await f.request(
        "book",
        { day: "2026-10-28", start: 1800, duration: 60 },
        firstCookie,
      )
    ).status,
    200,
  );
  f.setTime("2026-10-29T06:00:00+09:00");
  const state = (await f.request("state", undefined, cookie)).body;
  assert.equal(state.day, "2026-10-28");
  assert.equal(state.bookings.length, 1);
  assert.equal(
    (await f.request("cancel", { day: state.day }, firstCookie)).status,
    409,
  );
  f.setTime("2026-10-29T07:00:00+09:00");
  assert.equal(
    (await f.request("state", undefined, cookie)).body.day,
    "2026-10-29",
  );
});
test("別サイトからの書き込みを拒否する", async (t) => {
  const f = await fixture(t);
  assert.equal(
    (
      await f.request(
        "register",
        { memberId: 1, password: "test-password" },
        "",
        { origin: "https://evil.example" },
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await f.request(
        "register",
        { memberId: 1, password: "test-password" },
        "",
        { "Content-Type": "text/plain" },
      )
    ).status,
    415,
  );
});
test("サーバー再起動後もパスワード・セッション・抽選・予約を保持する", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "bathjun-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "bathjun.sqlite");
  const app1 = createApp({ database: path });
  app1.close();
  // Close and reopen the actual file to exercise a real server restart.
  const f = await fixture(t, { database: path });
  const cookie = await f.register(1);
  await f.request("draw", { day: "2026-10-28" }, cookie);
  const original = (await f.request("state", undefined, cookie)).body;
  const first = original.draw.order[0];
  const c = first === 1 ? cookie : await f.register(first);
  await f.request("book", { day: original.day, start: 900, duration: 30 }, c);
  await f.stop();
  const other = await fixture(t, { database: path });
  const restored = await other.request("state", undefined, cookie);
  assert.equal(restored.status, 200);
  assert.deepEqual(restored.body.draw, original.draw);
  assert.equal(restored.body.bookings.length, 1);
});
