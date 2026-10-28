import test from "node:test";
import assert from "node:assert/strict";
import { dataPaths } from "../src/data-paths.js";
import { createNotificationPump } from "../src/notification-pump.js";

test("通知がないときは定期タイマーを常駐させない", async () => {
  let flushes = 0;
  const timers = [];
  const pump = createNotificationPump(
    {
      notificationDueAt: () => null,
      flushNotifications: async () => {
        flushes++;
      },
    },
    {
      setTimer: (fn, delay) => {
        timers.push({ fn, delay });
        return 1;
      },
    },
  );
  pump.start();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(flushes, 1);
  assert.equal(timers.length, 0);
  pump.wake();
  assert.equal(timers.length, 0);
  pump.close();
});
test("新着通知をすぐ処理し、失敗の再送時刻までだけ待機する", async () => {
  let due = null,
    flushes = 0;
  const timers = new Map();
  let id = 0;
  const app = {
    notificationDueAt: () => due,
    flushNotifications: async () => {
      flushes++;
      due = flushes === 1 ? 25000 : null;
    },
  };
  const pump = createNotificationPump(app, {
    now: () => 10000,
    setTimer: (fn, delay) => {
      const key = ++id;
      timers.set(key, { fn, delay });
      return key;
    },
    clearTimer: (key) => timers.delete(key),
  });
  due = 0;
  pump.wake();
  assert.equal(timers.size, 1);
  let [key, timer] = [...timers][0];
  assert.equal(timer.delay, 0);
  timers.delete(key);
  await timer.fn();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(flushes, 1);
  assert.equal(timers.size, 1);
  [key, timer] = [...timers][0];
  assert.equal(timer.delay, 15000);
  timers.delete(key);
  await timer.fn();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(flushes, 2);
  assert.equal(timers.size, 0);
  pump.close();
  due = 0;
  pump.wake();
  assert.equal(timers.size, 0);
});
test("指定したデータフォルダを使い、アプリの更新先と分離する", () => {
  const paths = dataPaths({ BATHJUN_DATA_DIR: "/tmp/bathjun-test-data" });
  assert.equal(paths.database, "/tmp/bathjun-test-data/bathjun.sqlite");
  assert.equal(paths.tunnelConfig, "/tmp/bathjun-test-data/tunnel.yml");
  assert.equal(paths.publicLink, "/tmp/bathjun-test-data/public-link.txt");
  assert.equal(
    dataPaths({
      BATHJUN_DATA_DIR: "/tmp/bathjun-test-data",
      BATHJUN_DB: "/tmp/other.sqlite",
    }).database,
    "/tmp/other.sqlite",
  );
});
test("キュー処理の障害時は待機し、CPUを使う即時再試行ループを作らない", async () => {
  const timers = [];
  let reported = 0;
  const pump = createNotificationPump(
    {
      notificationDueAt: () => 0,
      flushNotifications: async () => {
        throw new Error("temporary");
      },
    },
    {
      setTimer: (fn, delay) => {
        timers.push({ fn, delay });
        return timers.length;
      },
      clearTimer: () => {},
      onError: () => reported++,
    },
  );
  pump.start();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reported, 1);
  assert.equal(timers[0].delay, 30000);
  pump.close();
});
