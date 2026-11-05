import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateCrossBoundaryBookings } from "../src/booking-day-migration.js";
import { createApp } from "../src/app.js";
import { DEFAULT_SCHEDULE } from "../src/server-settings.js";

async function fixture(t) {
  let clock = new Date("2026-10-31T12:00:00+09:00");
  const app = createApp({ requireFamily: false, now: () => clock });
  app.saveRewardSettings({...app.getRewardsAdmin().settings,clientReportEnabled:true});
  app.saveServerSettings({
    members: [
      { name: "利用者A", active: true },
      { name: "利用者B", active: true },
    ],
    schedule: { ...DEFAULT_SCHEDULE, orderMode: "fixed" },
  });
  const server = createServer(app.handle);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(async () => {
    await new Promise((r) => server.close(r));
    app.close();
  });
  const cookies = {};
  async function api(path, body, id = 1) {
    const res = await fetch(
      `http://127.0.0.1:${server.address().port}/api/${path}`,
      {
        method: body === undefined ? "GET" : "POST",
        headers: {
          "Content-Type": "application/json",
          cookie: cookies[id] || "",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
    );
    if (path === "register")
      cookies[id] = res.headers.get("set-cookie")?.split(";")[0];
    return { status: res.status, body: await res.json() };
  }
  for (const id of [1, 2])
    assert.equal(
      (await api("register", { memberId: id, password: "test-password" }, id))
        .status,
      200,
    );
  return { app, api, time: (time) => (clock = new Date(time + "+09:00")) };
}

test("午前3時の今日は当日7時〜翌7時。朝でも当日分を抽選・予約し前日の予約は残す", async (t) => {
  const f = await fixture(t);
  f.time("2026-11-01T03:00:00");
  let state = (await f.api("state")).body;
  assert.equal(state.day, "2026-11-01");
  assert.equal(state.today, "2026-11-01");
  assert.equal(state.settings.bookingCutoff, 420);
  assert.equal(state.settings.bathStart, 420);
  assert.equal(state.settings.bathEnd, 1860);
  assert.ok(state.draw);
  assert.equal(
    (await f.api("book", { day: state.day, start: 420, duration: 30 })).status,
    200,
  );
  assert.equal(
    (await f.api("book", { day: state.day, start: 1800, duration: 30 }, 2))
      .status,
    200,
  );
  f.time("2026-11-02T03:00:00");
  state = (await f.api("state")).body;
  assert.equal(state.day, "2026-11-02");
  assert.ok(state.draw);
  const previous = (await f.api("state?day=2026-11-01")).body;
  assert.equal(previous.bookings[1].start, 1800);
  assert.equal(previous.rewards.card.week, "2026-11-01");
  assert.equal(f.app.getDashboard().day, "2026-11-01");
});

test("抽選は0時で切り替え、7時前に昨日分を引き直したり明日分を抽選できない", async (t) => {
  const f = await fixture(t);
  const settings = f.app.getServerSettings();
  f.app.saveServerSettings({
    members: settings.members,
    schedule: { ...settings.upcoming, orderMode: "random" },
  });
  f.time("2026-10-31T23:59:59");
  assert.equal((await f.api("draw", { day: "2026-11-01" })).status, 400);
  f.time("2026-11-01T00:00:00");
  assert.equal((await f.api("draw", { day: "2026-11-01" })).status, 200);
  assert.equal((await f.api("draw", { day: "2026-11-02" })).status, 400);
  assert.equal((await f.api("draw", { day: "2026-10-31" })).status, 403);
  f.time("2026-11-01T03:00:00");
  assert.equal((await f.api("state")).body.draw.mode, "random");
});

test("区切り変更の移行中でも別の日分と重なる予約・自動確定を防ぎ、境界の接続は許す", async (t) => {
  const f = await fixture(t);
  f.time("2026-11-01T03:00:00");
  await f.api("state");
  assert.equal(
    (await f.api("book", { day: "2026-11-01", start: 1800, duration: 60 }))
      .status,
    200,
  );
  const settings = f.app.getServerSettings();
  f.app.saveServerSettings({
    members: settings.members,
    schedule: { ...settings.upcoming, bookingCutoff: 360 },
  });
  assert.equal(
    (await f.api("wish", { day: "2026-11-02", start: 360, duration: 30 }))
      .status,
    200,
  );
  f.time("2026-11-02T03:00:00");
  const state = (await f.api("state")).body;
  assert.equal(state.bookings.length, 0);
  assert.equal(state.wishes.length, 1);
  assert.equal(
    (await f.api("book", { day: "2026-11-02", start: 360, duration: 30 }))
      .status,
    409,
  );
  assert.equal(
    (await f.api("book", { day: "2026-11-02", start: 420, duration: 30 }))
      .status,
    200,
  );
});

test("旧入浴時間帯の移行は既存の所属日を維持し、新しい24時間枠は翌日から適用する", () => {
  const dir = mkdtempSync(join(tmpdir(), "bathjun-calendar-migration-"));
  const database = join(dir, "test.sqlite");
  const now = () => new Date("2026-10-28T03:00:00+09:00");
  let app = createApp({ database, now });
  app.saveServerSettings({
    members: [{ name: "履歴の利用者", active: true }],
    schedule: DEFAULT_SCHEDULE,
  });
  app.close();
  const db = new DatabaseSync(database);
  const legacy = { ...DEFAULT_SCHEDULE, dayRollover: 120, bathStart: 900 };
  delete legacy.bookingCutoff;
  db.prepare(
    "UPDATE schedule_settings SET value_json=? WHERE effective_day=?",
  ).run(JSON.stringify(legacy), "0000-01-01");
  db.prepare(
    "UPDATE schedule_settings SET value_json=? WHERE effective_day=?",
  ).run(
    JSON.stringify({ ...legacy, bathStart: 720, bathEnd: 1980 }),
    "2026-10-29",
  );
  db.prepare(
    "DELETE FROM schema_migrations WHERE name='0014_calendar_booking_days'",
  ).run();
  db.prepare("INSERT INTO draws(day,order_json,created_at) VALUES(?,?,?)").run(
    "2026-10-28",
    "[1]",
    now().toISOString(),
  );
  db.prepare(
    "INSERT INTO bookings(day,member_id,start,duration,revision) VALUES(?,?,?,?,?)",
  ).run("2026-10-28", 1, 1800, 30, "test-revision");
  db.close();
  try {
    app = createApp({ database, now });
    let settings = app.getServerSettings();
    assert.equal(settings.current.bathStart, 900);
    assert.equal(settings.current.bathEnd, 1860);
    assert.equal(settings.current.dayRollover, 0);
    assert.equal(settings.upcoming.bookingCutoff, 540);
    assert.equal(settings.upcoming.bathStart, 540);
    assert.equal(settings.upcoming.bathEnd, 1980);
    app.close();
    app = createApp({ database, now });
    settings = app.getServerSettings();
    assert.equal(settings.upcoming.bookingCutoff, 540);
    const check = new DatabaseSync(database);
    try {
      assert.deepEqual(
        { ...check.prepare("SELECT day,start,duration FROM bookings").get() },
        { day: "2026-10-28", start: 1800, duration: 30 },
      );
    } finally {
      check.close();
    }
  } finally {
    app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("7時をまたぐ6:30〜7:30は前日分。別の日分との重複を防ぎ報告も同じスタンプへ付ける", async (t) => {
  const f = await fixture(t);
  f.time("2026-11-01T03:00:00");
  await f.api("state");
  assert.equal(
    (await f.api("book", { day: "2026-11-01", start: 1830, duration: 60 }))
      .status,
    200,
  );
  f.time("2026-11-02T03:00:00");
  await f.api("state");
  assert.equal(
    (await f.api("book", { day: "2026-11-02", start: 420, duration: 30 }))
      .status,
    409,
  );
  assert.equal(
    (await f.api("book", { day: "2026-11-02", start: 450, duration: 30 }))
      .status,
    200,
  );
  f.time("2026-11-02T07:10:00");
  assert.equal(f.app.getDashboard().day, "2026-11-01");
  const previous = (await f.api("state?day=2026-11-01")).body;
  assert.equal(
    (
      await f.api("complete", {
        day: "2026-11-01",
        revision: previous.bookings[0].revision,
      })
    ).status,
    200,
  );
  const card = (await f.api("rewards?week=2026-11-01")).body.card;
  assert.equal(card.days[0].status, "stamp");
  assert.equal(card.days[1].status, "pending");
});

test("遅い区切りで翌々日に終了しても開始日の所属を維持し、画面・報告にアクセスできる", async (t) => {
  const f = await fixture(t);
  const settings = f.app.getServerSettings();
  f.app.saveServerSettings({
    members: settings.members,
    schedule: { ...settings.upcoming, bookingCutoff: 1410 },
  });
  f.time("2026-11-01T08:00:00");
  await f.api("state");
  assert.equal(
    (await f.api("book", { day: "2026-11-01", start: 2835, duration: 90 }))
      .status,
    200,
  );
  f.time("2026-11-02T08:00:00");
  await f.api("state");
  assert.equal(
    (await f.api("book", { day: "2026-11-02", start: 1410, duration: 30 }))
      .status,
    409,
  );
  f.time("2026-11-03T00:20:00");
  assert.equal(f.app.getDashboard().day, "2026-11-01");
  const previous = await f.api("state?day=2026-11-01");
  assert.equal(previous.status, 200);
  assert.equal(previous.body.bookings[0].start, 2835);
  assert.equal(
    (
      await f.api("complete", {
        day: "2026-11-01",
        revision: previous.body.bookings[0].revision,
      })
    ).status,
    200,
  );
  assert.equal(
    (await f.api("rewards?week=2026-11-01")).body.card.days[0].status,
    "stamp",
  );
});

test("予約テーブルの拡張は既存の全列・インデックス・重複防止トリガーを保持する", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(`CREATE TABLE schema_migrations(name TEXT PRIMARY KEY);
      CREATE TABLE bookings(day TEXT,member_id INTEGER,start INTEGER,duration INTEGER CHECK(duration BETWEEN 1 AND 1440),revision TEXT,ticket TEXT,ticket_extension INTEGER,auto_confirmed INTEGER,auto_revision TEXT,UNIQUE(day,member_id),CHECK(start+duration<=2880));
      CREATE TABLE wishes(day TEXT,member_id INTEGER,start INTEGER,duration INTEGER,revision TEXT,ticket TEXT,displaced INTEGER,CHECK(start+duration<=2880));
      CREATE INDEX wishes_by_member ON wishes(member_id);
      CREATE TRIGGER booking_overlap_insert BEFORE INSERT ON bookings WHEN EXISTS(SELECT 1 FROM bookings WHERE day=NEW.day AND member_id!=NEW.member_id AND start<NEW.start+NEW.duration AND start+duration>NEW.start) BEGIN SELECT RAISE(ABORT,'booking_overlap');END;
      INSERT INTO bookings VALUES('2026-11-01',1,900,30,'revision-booking','extend',30,1,'auto-revision');
      INSERT INTO wishes VALUES('2026-11-01',2,930,30,'revision-wish','guard',1);`);
    const beforeBooking = db.prepare("SELECT * FROM bookings").get(),
      beforeWish = db.prepare("SELECT * FROM wishes").get();
    migrateCrossBoundaryBookings(db);
    migrateCrossBoundaryBookings(db);
    assert.deepEqual(
      db.prepare("SELECT * FROM bookings WHERE member_id=1").get(),
      beforeBooking,
    );
    assert.deepEqual(db.prepare("SELECT * FROM wishes").get(), beforeWish);
    assert.ok(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='index' AND name='wishes_by_member'",
        )
        .get(),
    );
    db.prepare(
      "INSERT INTO bookings(day,member_id,start,duration) VALUES(?,?,?,?)",
    ).run("2026-11-01", 2, 2835, 90);
    assert.throws(
      () =>
        db
          .prepare(
            "INSERT INTO bookings(day,member_id,start,duration) VALUES(?,?,?,?)",
          )
          .run("2026-11-01", 3, 2850, 30),
      /booking_overlap/,
    );
  } finally {
    db.close();
  }
});
