import { seedTestMembers } from "../test-support/household.js";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import {
  generateKeyPairSync,
  createHash,
  sign,
  randomBytes,
} from "node:crypto";
import { createApp } from "../src/app.js";
import { createHttpServer } from "../src/http.js";
const sha = (data) => createHash("sha256").update(data).digest();
const b64 = (value) => Buffer.from(value).toString("base64url");
async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "bathjun-passkey-"));
  const database = join(directory, "app.sqlite");
  let clock = new Date("2026-10-28T08:00:00+09:00");
  const app = createApp({ database, now: () => clock });
  seedTestMembers(app);
  await app.setFamilyPassword("test-family-password");
  const { privateKey, publicKey } = generateKeyPairSync("ec", {
      namedCurve: "prime256v1",
    }),
    jwk = publicKey.export({ format: "jwk" });
  // Canonical COSE EC2/ES256 public key: {1:2,3:-7,-1:1,-2:x,-3:y}.
  const cose = Buffer.concat([
    Buffer.from("a5010203262001215820", "hex"),
    Buffer.from(jwk.x, "base64url"),
    Buffer.from("225820", "hex"),
    Buffer.from(jwk.y, "base64url"),
  ]);
  const credentialId = b64(randomBytes(32)),
    handle = randomBytes(32);
  const db = new DatabaseSync(database);
  db.prepare("INSERT INTO passkey_accounts VALUES(?,?)").run(1, handle);
  db.prepare("INSERT INTO passkey_credentials VALUES(?,?,?,?,?,?,?,?)").run(
    credentialId,
    1,
    cose,
    0,
    '["internal"]',
    "singleDevice",
    0,
    clock.toISOString(),
  );
  db.close();
  const { server } = createHttpServer(app);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://localhost:${server.address().port}`;
  t.after(async () => {
    await new Promise((r) => server.close(r));
    app.close();
    rmSync(directory, { recursive: true, force: true });
  });
  async function api(path, body, cookie = "") {
    const r = await fetch(base + "/api/" + path, {
      ...(body === undefined
        ? {}
        : { method: "POST", body: JSON.stringify(body) }),
      headers: { "Content-Type": "application/json", cookie },
    });
    return {
      status: r.status,
      body: await r.json(),
      cookies: r.headers
        .getSetCookie()
        .map((s) => s.split(";")[0])
        .join("; "),
    };
  }
  function assertion(
    challenge,
    { origin = base, rpID = "localhost", flags = 5, counter = 1 } = {},
  ) {
    const clientData = Buffer.from(
      JSON.stringify({
        type: "webauthn.get",
        challenge,
        origin,
        crossOrigin: false,
      }),
    );
    const count = Buffer.alloc(4);
    count.writeUInt32BE(counter);
    const auth = Buffer.concat([sha(rpID), Buffer.from([flags]), count]);
    return {
      id: credentialId,
      rawId: credentialId,
      type: "public-key",
      clientExtensionResults: {},
      response: {
        clientDataJSON: b64(clientData),
        authenticatorData: b64(auth),
        signature: b64(
          sign("sha256", Buffer.concat([auth, sha(clientData)]), privateKey),
        ),
        userHandle: b64(handle),
      },
    };
  }
  return {
    app,
    api,
    assertion,
    credentialId,
    setTime: (value) => {
      clock = new Date(value);
    },
  };
}
test("本物の署名を検証して本人を判別し、共通・個別の両パスワードを省略する", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.api("members")).status, 401);
  const options = await f.api("passkey/auth/options", {});
  assert.equal(options.status, 200);
  assert.equal(options.body.userVerification, "required");
  const response = f.assertion(options.body.challenge);
  const login = await f.api(
    "passkey/auth/verify",
    { response },
    options.cookies,
  );
  assert.equal(login.status, 200, JSON.stringify(login.body));
  assert.equal(login.body.me.name, "メンバー1");
  assert.match(login.cookies, /bath_family=/);
  assert.match(login.cookies, /bath_session=/);
  assert.equal(
    (await f.api("state", undefined, login.cookies)).body.me.name,
    "メンバー1",
  );
  assert.equal(
    (await f.api("passkey/auth/verify", { response }, options.cookies)).status,
    400,
  );
});
test("署名・RP・Origin・利用者確認の不正を拒否する", async (t) => {
  const f = await fixture(t);
  for (const parameters of [
    { origin: "https://evil.example" },
    { rpID: "evil.example" },
    { flags: 1 },
    { tamper: true },
  ]) {
    const options = await f.api("passkey/auth/options", {});
    const response = f.assertion(options.body.challenge, parameters);
    if (parameters.tamper) {
      const value = Buffer.from(response.response.signature, "base64url");
      value[value.length - 1] ^= 1;
      response.response.signature = b64(value);
    }
    const result = await f.api(
      "passkey/auth/verify",
      { response },
      options.cookies,
    );
    assert.equal(result.status, 401, JSON.stringify(parameters));
    assert.equal(result.cookies, "");
  }
  assert.equal((await f.api("members")).status, 401);
});
test("期限切れ・別端末のチャレンジ・削除済みパスキーを受け付けない", async (t) => {
  const f = await fixture(t);
  const options = await f.api("passkey/auth/options", {});
  const response = f.assertion(options.body.challenge);
  assert.equal((await f.api("passkey/auth/verify", { response })).status, 400);
  f.setTime("2026-10-28T08:06:00+09:00");
  assert.equal(
    (await f.api("passkey/auth/verify", { response }, options.cookies)).status,
    400,
  );
  const fresh = await f.api("passkey/auth/options", {});
  await f.app.setFamilyPassword("new-family-password");
  // Password rotation invalidates both challenges and all previously trusted passkeys.
  assert.equal(
    (
      await f.api(
        "passkey/auth/verify",
        { response: f.assertion(fresh.body.challenge) },
        fresh.cookies,
      )
    ).status,
    400,
  );
  const next = await f.api("passkey/auth/options", {});
  assert.equal(
    (
      await f.api(
        "passkey/auth/verify",
        { response: f.assertion(next.body.challenge) },
        next.cookies,
      )
    ).status,
    401,
  );
});
test("他の家族のパスキーを削除できず、登録には個別ログインを要する", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.api("passkey/register/options", {})).status, 401);
  const options = await f.api("passkey/auth/options", {});
  const logged = await f.api(
    "passkey/auth/verify",
    { response: f.assertion(options.body.challenge) },
    options.cookies,
  );
  const other = await f.api(
    "register",
    { memberId: 2, password: "other-test-password" },
    logged.cookies,
  );
  const family = logged.cookies
    .split("; ")
    .find((c) => c.startsWith("bath_family="));
  const cookie = family + "; " + other.cookies;
  assert.equal(
    (await f.api("passkey/remove", { id: f.credentialId }, cookie)).status,
    404,
  );
  assert.equal(
    (await f.api("passkey/list", undefined, cookie)).body.credentials.length,
    0,
  );
  assert.equal(
    (await f.api("passkey/list", undefined, logged.cookies)).body.credentials
      .length,
    1,
  );
});
test('利用停止したメンバーの有効なパスキーも拒否し、再開すれば復旧する',async t=>{
 const f=await fixture(t);const config=f.app.getServerSettings();
 f.app.saveServerSettings({members:config.members.map(member=>({...member,active:member.id!==1})),schedule:config.upcoming});
 const blocked=await f.api('passkey/auth/options',{});
 const denied=await f.api('passkey/auth/verify',{response:f.assertion(blocked.body.challenge)},blocked.cookies);assert.equal(denied.status,401);assert.equal(denied.cookies,'');
 const saved=f.app.getServerSettings();f.app.saveServerSettings({members:saved.members.map(member=>({...member,active:true})),schedule:saved.upcoming});
 const restored=await f.api('passkey/auth/options',{});assert.equal((await f.api('passkey/auth/verify',{response:f.assertion(restored.body.challenge)},restored.cookies)).status,200);
});
