import { mkdirSync, copyFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
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

// Exercise the default relative load path used by the actual distribution.
const fixture = join(dirname(resolve(process.argv[2])), "package-fixture");
mkdirSync(join(fixture, "app", "src"), { recursive: true });
mkdirSync(join(fixture, "bin"), { recursive: true });
writeFileSync(
  join(fixture, "app", "package.json"),
  JSON.stringify({ type: "module" }),
);
copyFileSync(
  fileURLToPath(new URL("../../../src/server-power.js", import.meta.url)),
  join(fixture, "app", "src", "server-power.js"),
);
copyFileSync(
  resolve(process.argv[2]),
  join(fixture, "bin", "Bathjun-Power.node"),
);
const packaged = await import(
  pathToFileURL(join(fixture, "app", "src", "server-power.js")).href
);
const packagedLease = packaged.acquireServerPower();
assert.equal(packagedLease.protected, true);
packagedLease.close();
console.log("Default packaged power-guard path passed.");
