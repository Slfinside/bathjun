import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { acquireServerPower } from "../../../src/server-power.js";
const require = createRequire(import.meta.url);
const addon = require(resolve(process.argv[2]));
assert.equal(addon.version, 1);
for (let i = 0; i < 3; i++) {
  const state = addon.acquire();
  assert.equal(state.protected, true, JSON.stringify(state));
  assert.deepEqual(addon.acquire(), state);
  addon.release();
  assert.equal(addon.state().protected, false);
  addon.release();
}
const lease = acquireServerPower({ load: () => addon });
assert.equal(lease.protected, true);
assert.equal(lease.renew(), true);
lease.close();
assert.equal(addon.state().protected, false);
console.log(
  "Node owns system/execution/thread power requests; renew and release passed.",
);
