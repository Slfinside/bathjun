import test from "node:test";
import assert from "node:assert/strict";
import { acquireServerPower } from "../src/server-power.js";

test("サーバー自身の電源要求は3種類とも成功したときだけ有効とし、終了・復帰で解放と再取得する", () => {
  let acquired = 0,
    released = 0;
  const binding = {
    version: 1,
    acquire() {
      acquired++;
      return {
        protected: true,
        system: true,
        execution: true,
        thread: true,
        errorCode: 0,
      };
    },
    release() {
      released++;
    },
  };
  const lease = acquireServerPower({ platform: "win32", load: () => binding });
  assert.equal(lease.protected, true);
  assert.equal(acquired, 1);
  assert.equal(lease.renew(), true);
  assert.equal(acquired, 2);
  assert.ok(released >= 1);
  lease.close();
  assert.equal(lease.protected, false);
});
test("電源保護の不足・異常・モジュール欠損では有効扱いせず、途中の要求も解除する", () => {
  for (const state of [
    { protected: true, system: true, execution: false, thread: true },
    { protected: true, system: true, execution: true, thread: false },
    { protected: false, errorCode: 5 },
  ]) {
    let releases = 0;
    const lease = acquireServerPower({
      platform: "win32",
      load: () => ({
        version: 1,
        acquire: () => state,
        release() {
          releases++;
        },
      }),
    });
    assert.equal(lease.protected, false);
    assert.ok(releases > 0);
  }
  assert.equal(
    acquireServerPower({
      platform: "win32",
      load() {
        throw Error("missing");
      },
    }).protected,
    false,
  );
  assert.equal(
    acquireServerPower({
      platform: "win32",
      load: () => ({ version: 99, release() {} }),
    }).protected,
    false,
  );
});
test("Windows以外では電源モジュールを読み込まず動作を維持する", () => {
  const lease = acquireServerPower({
    platform: "linux",
    load() {
      throw Error("must not load");
    },
  });
  assert.equal(lease.protected, false);
  assert.equal(lease.renew(), false);
  lease.close();
});
