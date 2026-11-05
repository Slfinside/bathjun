import { randomBytes, createHash } from "node:crypto";
const hash = (value) => createHash("sha256").update(value).digest("hex");
const fail = (status, message) => {
  throw Object.assign(new Error(message), { status });
};
const cookie = (req, name) =>
  (req.headers.cookie || "")
    .split(";")
    .map((s) => s.trim())
    .find((s) => s.startsWith(name + "="))
    ?.slice(name.length + 1);
// Load the WebAuthn verifier only when needed; the idle reservation server stays small.
let library;
const webauthn = () => (library ||= import("@simplewebauthn/server"));
export function createPasskeys({ db, now, cookieAttributes, loginAs, sessionValid }) {
  function context(req) {
    const origin =
      req.bathOrigin ||
      `${req.socket.encrypted ? "https" : "http"}://${req.headers.host}`;
    const url = new URL(origin);
    if (
      url.protocol !== "https:" &&
      !(url.protocol === "http:" && url.hostname === "localhost")
    )
      fail(400, "パスキーはHTTPSの家族用リンクで設定してください。");
    return { origin, rpID: url.hostname };
  }
  function remember(req, res, kind, memberId, challenge) {
    const { origin, rpID } = context(req);
    const token = randomBytes(32).toString("hex");
    db.prepare("DELETE FROM passkey_challenges WHERE expires<=?").run(
      now().getTime(),
    );
    if (
      db.prepare("SELECT COUNT(*) AS n FROM passkey_challenges").get().n >= 100
    )
      fail(429, "少し待ってからもう一度お試しください。");
    db.prepare("INSERT INTO passkey_challenges VALUES(?,?,?,?,?,?,?)").run(
      hash(token),
      kind,
      memberId,
      challenge,
      origin,
      rpID,
      now().getTime() + 300000,
    );
    res.setHeader(
      "Set-Cookie",
      `bath_passkey_${kind}=${token}; ${cookieAttributes(req)}; Max-Age=300`,
    );
  }
  function consume(req, kind, memberId) {
    const key = hash(cookie(req, `bath_passkey_${kind}`) || "");
    const saved = db
      .prepare("SELECT * FROM passkey_challenges WHERE token_hash=?")
      .get(key);
    db.prepare("DELETE FROM passkey_challenges WHERE token_hash=?").run(key);
    const { origin, rpID } = context(req);
    if (
      !saved ||
      saved.kind !== kind ||
      saved.expires <= now().getTime() ||
      saved.origin !== origin ||
      saved.rp_id !== rpID ||
      (kind === "register" && saved.member_id !== memberId)
    )
      fail(400, "パスキーの操作が期限切れです。もう一度お試しください。");
    return saved;
  }
  async function handle(req, res, path, body, me, send) {
    if (req.method === "POST" && path === "/api/passkey/auth/options") {
      const { rpID } = context(req);
      const { generateAuthenticationOptions } = await webauthn();
      const options = await generateAuthenticationOptions({
        rpID,
        userVerification: "required",
        timeout: 60000,
      });
      remember(req, res, "auth", null, options.challenge);
      send(200, options);
      return true;
    }
    if (req.method === "POST" && path === "/api/passkey/auth/verify") {
      const saved = consume(req, "auth");
      const response = body.response;
      if (!response || typeof response.id !== "string")
        fail(400, "パスキーを確認できませんでした。");
      const stored = db
        .prepare(
          "SELECT c.*,a.user_id FROM passkey_credentials c JOIN passkey_accounts a ON a.member_id=c.member_id JOIN members m ON m.id=c.member_id WHERE c.id=? AND m.active=1",
        )
        .get(response.id);
      if (!stored)
        fail(
          401,
          "このパスキーは登録されていません。初回の手順でログインしてください。",
        );
      if (
        response.response?.userHandle &&
        response.response.userHandle !==
          Buffer.from(stored.user_id).toString("base64url")
      )
        fail(401, "パスキーを確認できませんでした。");
      const { verifyAuthenticationResponse } = await webauthn();
      let result;
      try {
        result = await verifyAuthenticationResponse({
          response,
          expectedChallenge: saved.challenge,
          expectedOrigin: saved.origin,
          expectedRPID: saved.rp_id,
          requireUserVerification: true,
          credential: {
            id: stored.id,
            publicKey: new Uint8Array(stored.public_key),
            counter: stored.counter,
            transports: JSON.parse(stored.transports),
          },
        });
      } catch {
        fail(401, "パスキーを確認できませんでした。もう一度お試しください。");
      }
      if (!result.verified) fail(401, "パスキーを確認できませんでした。");
      const updated = db
        .prepare(
          "UPDATE passkey_credentials SET counter=?,backed_up=? WHERE id=? AND counter=?",
        )
        .run(
          result.authenticationInfo.newCounter,
          result.authenticationInfo.credentialBackedUp ? 1 : 0,
          stored.id,
          stored.counter,
        );
      if (!updated.changes)
        fail(409, "ほかのログイン操作と重なりました。もう一度お試しください。");
      const member = loginAs(stored.member_id, req, res, true);
      send(200, { me: member });
      return true;
    }
    if (!me) return false;
    if (req.method === "GET" && path === "/api/passkey/list") {
      send(200, {
        credentials: db
          .prepare(
            "SELECT id,created_at AS createdAt FROM passkey_credentials WHERE member_id=? ORDER BY created_at",
          )
          .all(me.id),
      });
      return true;
    }
    if (req.method === "POST" && path === "/api/passkey/register/options") {
      const { rpID } = context(req);
      const credentials = db
        .prepare(
          "SELECT id,transports FROM passkey_credentials WHERE member_id=?",
        )
        .all(me.id);
      if (credentials.length >= 10)
        fail(400, "登録済みのパスキーを整理してください。");
      db.prepare("INSERT OR IGNORE INTO passkey_accounts VALUES(?,?)").run(
        me.id,
        randomBytes(32),
      );
      const account = db
        .prepare("SELECT user_id FROM passkey_accounts WHERE member_id=?")
        .get(me.id);
      const { generateRegistrationOptions } = await webauthn();
      const options = await generateRegistrationOptions({
        rpName: "ふろじゅん",
        rpID,
        userID: new Uint8Array(account.user_id),
        userName: me.name,
        userDisplayName: me.name,
        attestationType: "none",
        timeout: 60000,
        authenticatorSelection: {
          residentKey: "required",
          userVerification: "required",
        },
        excludeCredentials: credentials.map((c) => ({
          id: c.id,
          transports: JSON.parse(c.transports),
        })),
      });
      if(!sessionValid(req,me.id))fail(401,"設定が変更されました。ログインし直してください。");
      remember(req, res, "register", me.id, options.challenge);
      send(200, options);
      return true;
    }
    if (req.method === "POST" && path === "/api/passkey/register/verify") {
      const saved = consume(req, "register", me.id),
        { verifyRegistrationResponse } = await webauthn();
      let result;
      try {
        result = await verifyRegistrationResponse({
          response: body.response,
          expectedChallenge: saved.challenge,
          expectedOrigin: saved.origin,
          expectedRPID: saved.rp_id,
          requireUserVerification: true,
        });
      } catch {
        fail(400, "パスキーを登録できませんでした。もう一度お試しください。");
      }
      if(!sessionValid(req,me.id))fail(401,"設定が変更されました。ログインし直してください。");
      if (!result.verified) fail(400, "パスキーを登録できませんでした。");
      const { credential, credentialDeviceType, credentialBackedUp } =
        result.registrationInfo;
      if (
        db
          .prepare("SELECT id FROM passkey_credentials WHERE id=?")
          .get(credential.id)
      )
        fail(409, "このパスキーは登録済みです。");
      if (
        db
          .prepare(
            "SELECT COUNT(*) AS n FROM passkey_credentials WHERE member_id=?",
          )
          .get(me.id).n >= 10
      )
        fail(400, "登録済みのパスキーを整理してください。");
      db.prepare("INSERT INTO passkey_credentials VALUES(?,?,?,?,?,?,?,?)").run(
        credential.id,
        me.id,
        Buffer.from(credential.publicKey),
        credential.counter,
        JSON.stringify(credential.transports || []),
        credentialDeviceType,
        credentialBackedUp ? 1 : 0,
        now().toISOString(),
      );
      send(200, { ok: true });
      return true;
    }
    if (req.method === "POST" && path === "/api/passkey/remove") {
      if (typeof body.id !== "string") fail(400, "パスキーを選んでください。");
      const removed = db
        .prepare("DELETE FROM passkey_credentials WHERE id=? AND member_id=?")
        .run(body.id, me.id);
      if (!removed.changes) fail(404, "パスキーが見つかりません。");
      send(200, { ok: true });
      return true;
    }
    return false;
  }
  return { handle };
}
