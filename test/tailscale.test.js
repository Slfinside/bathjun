import test from "node:test";
import assert from "node:assert/strict";
import { tailscaleOrigin, accountLinks } from "../src/tailscale-public.js";

test("Tailscaleの登録済みPCのDNS名から固定HTTPSオリジンを作る", () => {
  const status = {
    BackendState: "Running",
    Self: { DNSName: "server-pc.tail-example.ts.net." },
  };
  assert.equal(
    tailscaleOrigin(status),
    "https://server-pc.tail-example.ts.net:8443",
  );
  assert.equal(
    tailscaleOrigin(status, 443),
    "https://server-pc.tail-example.ts.net",
  );
  assert.equal(
    tailscaleOrigin({
      ...status,
      Self: { DNSName: "server-pc.tail-example.ts.net" },
    }),
    tailscaleOrigin(status),
  );
});
test("未認証状態・外部ドメイン・不正なポートを固定URLとして使わない", () => {
  for (const status of [
    { BackendState: "NeedsLogin" },
    { BackendState: "Running", Self: { DNSName: "evil.example" } },
    { BackendState: "Running", Self: { DNSName: "host.ts.net.evil.example" } },
    { BackendState: "Running", Self: { DNSName: "host.tail.ts.net/evil" } },
  ])
    assert.throws(() => tailscaleOrigin(status));
  assert.throws(() =>
    tailscaleOrigin(
      { BackendState: "Running", Self: { DNSName: "server.tail.ts.net" } },
      9999,
    ),
  );
});
test("初回承認時に開くURLはTailscale自身の認証先だけに制限する", () => {
  assert.deepEqual(
    accountLinks(
      "Open https://login.tailscale.com/a/test-123\n https://evil.example/a/evil https://login.tailscale.com.evil.example/",
    ),
    ["https://login.tailscale.com/a/test-123"],
  );
});
