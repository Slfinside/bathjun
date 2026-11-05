import { seedTestMembers } from "../test-support/household.js";
import test from "node:test";
import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { createApp } from "../src/app.js";
import { createHttpServer } from "../src/http.js";
import { validateSubscription } from "../src/push.js";
import { randomBytes, createECDH } from "node:crypto";

function subscription(name) {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  return {
    endpoint: `https://web.push.apple.com/Q${name}`,
    keys: {
      p256dh: ecdh.getPublicKey().toString("base64url"),
      auth: randomBytes(16).toString("base64url"),
    },
  };
}
async function fixture(
  t,
  {
    requireFamily = false,
    privateLink = false,
    deliverPush = async () => {},
    publicOrigin = null,
  } = {},
) {
  let date = new Date("2026-10-28T08:00:00+09:00");
  const app = createApp({ requireFamily, now: () => date, deliverPush });
  seedTestMembers(app);
  const { server } = createHttpServer(app, { privateLink, publicOrigin });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    app.close();
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  async function raw(path, body, cookie = "", headers = {}) {
    if (headers.Host)
      return new Promise((resolve, reject) => {
        const request = httpRequest(
          base + path,
          {
            method: body === undefined ? "GET" : "POST",
            headers: { "Content-Type": "application/json", cookie, ...headers },
          },
          (response) => {
            const chunks = [];
            response.on("data", (chunk) => chunks.push(chunk));
            response.on("end", () =>
              resolve({
                status: response.statusCode,
                headers: {
                  get: (name) => {
                    const value = response.headers[name.toLowerCase()];
                    return Array.isArray(value) ? value.join(", ") : value;
                  },
                },
                json: async () => JSON.parse(Buffer.concat(chunks).toString()),
              }),
            );
          },
        );
        request.on("error", reject);
        request.end(body === undefined ? undefined : JSON.stringify(body));
      });
    return fetch(base + path, {
      redirect: "manual",
      ...(body === undefined
        ? {}
        : { method: "POST", body: JSON.stringify(body) }),
      headers: { "Content-Type": "application/json", cookie, ...headers },
    });
  }
  async function api(path, body, cookie = "", headers = {}) {
    const r = await raw("/api/" + path, body, cookie, headers);
    return {
      status: r.status,
      body: await r.json(),
      cookie: r.headers.get("Set-Cookie")?.split(";")[0],
      headers: r.headers,
    };
  }
  async function register(id, cookie = "") {
    const r = await api(
      "register",
      { memberId: id, password: "test-password" },
      cookie,
    );
    assert.equal(r.status, 200);
    const authenticated = [cookie, r.cookie].filter(Boolean).join("; ");
    await api("notification-preferences", {reservationTurn:true,wishConfirmed:true,bookingDisplaced:true}, authenticated);
    return authenticated;
  }
  return {
    app,
    raw,
    api,
    register,
    setTime: (value) => (date = new Date(value)),
  };
}

test("家族認証の前は名前・予約・個別登録を公開しない", async (t) => {
  const f = await fixture(t, { requireFamily: true });
  assert.deepEqual((await f.api("family")).body, {
    configured: false,
    authenticated: false,
  });
  for (const path of ["members", "state", "push/key"])
    assert.equal((await f.api(path)).status, 401);
  assert.equal(
    (await f.api("register", { memberId: 1, password: "test-password" }))
      .status,
    401,
  );
  await f.app.setFamilyPassword("family-test-password");
  assert.equal(
    (await f.api("family/login", { password: "wrong" })).status,
    401,
  );
  const family = await f.api("family/login", {
    password: "family-test-password",
  });
  assert.equal(family.status, 200);
  assert.ok(family.headers.get("Set-Cookie").includes("HttpOnly"));
  assert.equal(
    (await f.api("members", undefined, family.cookie)).body.members.length,
    5,
  );
  const cookie = await f.register(1, family.cookie);
  assert.equal((await f.api("state", undefined, cookie)).status, 200);
  // Individual cookies by themselves never bypass the family gate.
  assert.equal(
    (await f.api("state", undefined, cookie.split("; ")[1])).status,
    401,
  );
  await f.app.setFamilyPassword("family-new-password");
  assert.equal((await f.api("members", undefined, cookie)).status, 401);
});
test("家族の合い言葉は10回の誤入力で15分ロックする", async (t) => {
  const f = await fixture(t, { requireFamily: true });
  await f.app.setFamilyPassword("family-test-password");
  for (let i = 0; i < 10; i++)
    assert.equal(
      (await f.api("family/login", { password: "wrong" })).status,
      401,
    );
  assert.equal(
    (await f.api("family/login", { password: "family-test-password" })).status,
    429,
  );
  f.setTime("2026-10-28T08:16:00+09:00");
  assert.equal(
    (await f.api("family/login", { password: "family-test-password" })).status,
    200,
  );
});
test("公開時は長いURLを知らないと画面・API・ファイルを返さない", async (t) => {
  const f = await fixture(t, { privateLink: true });
  assert.match(f.app.accessToken(), /^[0-9a-f]{64}$/);
  for (const path of ["/", "/api/members", "/app.js", "/sw.js"])
    assert.equal((await f.raw(path)).status, 404);
  assert.equal((await f.raw("/family/" + "0".repeat(64) + "/")).status, 404);
  const invite = await f.raw(`/family/${f.app.accessToken()}/`);
  assert.equal(invite.status, 303);
  const gate = invite.headers.get("Set-Cookie").split(";")[0];
  assert.equal((await f.raw("/", undefined, gate)).status, 200);
  assert.equal((await f.raw("/api/members", undefined, gate)).status, 200);
  assert.equal(invite.headers.get("Referrer-Policy"), "no-referrer");
  const manifest = await (
    await f.raw("/manifest.webmanifest", undefined, gate)
  ).json();
  assert.equal(manifest.start_url, `/family/${f.app.accessToken()}/`);
  assert.equal(manifest.scope, "/");
});
test("既知のHTTPS公開先を使ってOriginを検証し、Secure cookieを発行する", async (t) => {
  const f = await fixture(t, {
    requireFamily: true,
    publicOrigin: "https://family.example.com",
  });
  await f.app.setFamilyPassword("family-test-password");
  const r = await f.api(
    "family/login",
    { password: "family-test-password" },
    "",
    { Host: "family.example.com", Origin: "https://family.example.com" },
  );
  assert.equal(r.status, 200);
  assert.ok(r.headers.get("Set-Cookie").includes("; Secure"));
  assert.equal(
    (
      await f.api("family/login", { password: "family-test-password" }, "", {
        Host: "family.example.com",
        Origin: "https://evil.example.com",
      })
    ).status,
    403,
  );
});
test("通知先URLはApple・Google・Mozillaの正しいHTTPSエンドポイントに制限する", () => {
  const sub = subscription("valid");
  assert.equal(validateSubscription(sub), true);
  for (const endpoint of [
    "https://127.0.0.1/",
    "http://web.push.apple.com/a",
    "https://web.push.apple.com.evil.example/a",
    "https://web.push.apple.com:8443/a",
    "https://user:password@web.push.apple.com/a",
  ])
    assert.equal(validateSubscription({ ...sub, endpoint }), false);
  assert.equal(
    validateSubscription({ ...sub, keys: { auth: "x", p256dh: "x" } }),
    false,
  );
});
test("予約完了は次の本人だけに通知し、編集・再登録では重複通知しない", async (t) => {
  const sent = [];
  const f = await fixture(t, {
    deliverPush: async (sub, payload) => sent.push({ sub, payload }),
  });
  const cookies = {};
  for (let id = 1; id <= 5; id++) cookies[id] = await f.register(id);
  const subs = {};
  for (let id = 1; id <= 5; id++) {
    subs[id] = subscription(String(id));
    assert.equal(
      (await f.api("push/subscribe", { subscription: subs[id] }, cookies[id]))
        .status,
      200,
    );
  }
  assert.equal(
    (await f.api("draw", { day: "2026-10-28" }, cookies[1])).status,
    200,
  );
  const state = (await f.api("state", undefined, cookies[1])).body;
  const [first, second] = state.draw.order;
  await f.app.flushNotifications();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].sub.endpoint, subs[first].endpoint);
  assert.equal(
    (
      await f.api(
        "book",
        {
          day: state.day,
          start: 900,
          duration: 30,
          note: "出張のため早く寝たいです",
          noNegotiation: true,
        },
        cookies[first],
      )
    ).status,
    200,
  );
  await f.app.flushNotifications();
  assert.equal(sent.length, 2);
  assert.equal(sent[1].sub.endpoint, subs[second].endpoint);
  assert.match(
    sent[1].payload.body,
    new RegExp(state.members.find((m) => m.id === second).name),
  );
  await f.api(
    "book",
    { day: state.day, start: 930, duration: 30 },
    cookies[first],
  );
  await f.app.flushNotifications();
  assert.equal(sent.length, 2);
  await f.api(
    "push/subscribe",
    { subscription: subs[second] },
    cookies[second],
  );
  await f.app.flushNotifications();
  assert.equal(sent.length, 2);
  const shared = (await f.api("state", undefined, cookies[second])).body
    .bookings[0];
  assert.equal(shared.note, "出張のため早く寝たいです");
  assert.equal(shared.noNegotiation, 1);
  assert.equal(
    (
      await f.api(
        "book",
        { day: state.day, start: 960, duration: 30, note: "a".repeat(301) },
        cookies[second],
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await f.api(
        "book",
        { day: state.day, start: 960, duration: 30, noNegotiation: "yes" },
        cookies[second],
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await f.api(
        "book",
        {
          day: state.day,
          start: 990,
          duration: 30,
          note: "",
          noNegotiation: false,
        },
        cookies[first],
      )
    ).status,
    200,
  );
  const cleared = (await f.api("state", undefined, cookies[second])).body
    .bookings[0];
  assert.equal(cleared.note, "");
  assert.equal(cleared.noNegotiation, 0);
});
test("通知の一時失敗は再試行し、無効になった購読は削除する", async (t) => {
  let attempts = 0;
  const f = await fixture(t, {
    deliverPush: async () => {
      attempts++;
      if (attempts === 1) throw { statusCode: 503 };
    },
  });
  const cookie = await f.register(1);
  await f.api("draw", { day: "2026-10-28" }, cookie);
  const state = (await f.api("state", undefined, cookie)).body;
  const first = state.draw.order[0];
  const c = first === 1 ? cookie : await f.register(first);
  await f.api("push/subscribe", { subscription: subscription("retry") }, c);
  await f.app.flushNotifications();
  assert.equal(attempts, 1);
  await f.app.flushNotifications();
  assert.equal(attempts, 1);
  f.setTime("2026-10-28T08:01:00+09:00");
  await f.app.flushNotifications();
  assert.equal(attempts, 2);
  await f.app.flushNotifications();
  assert.equal(attempts, 2);
});
test("ログアウトした端末には予約順の通知を送らない", async (t) => {
  const sent = [];
  const f = await fixture(t, { deliverPush: async (sub) => sent.push(sub) });
  const cookie = await f.register(1);
  await f.api(
    "push/subscribe",
    { subscription: subscription("logout") },
    cookie,
  );
  await f.api("logout", {}, cookie);
  const nextCookie = (
    await f.api("login", { memberId: 1, password: "test-password" })
  ).cookie;
  await f.api("draw", { day: "2026-10-28" }, nextCookie);
  await f.app.flushNotifications();
  assert.equal(sent.length, 0);
});
test("410で無効になった通知先は削除され、次回以降は送信しない", async (t) => {
  let attempts = 0;
  const f = await fixture(t, {
    deliverPush: async () => {
      attempts++;
      throw { statusCode: 410 };
    },
  });
  const cookie = await f.register(1);
  await f.api("draw", { day: "2026-10-28" }, cookie);
  const state = (await f.api("state", undefined, cookie)).body;
  const first = state.draw.order[0];
  const c = first === 1 ? cookie : await f.register(first);
  await f.api("push/subscribe", { subscription: subscription("gone") }, c);
  await f.app.flushNotifications();
  assert.equal(attempts, 1);
  f.setTime("2026-10-28T08:30:00+09:00");
  await f.app.flushNotifications();
  assert.equal(attempts, 1);
});
test("通知待ちの間に予約が済んだ場合は古い通知を送らない", async (t) => {
  const sent = [];
  const f = await fixture(t, { deliverPush: async (sub) => sent.push(sub) });
  const cookie = await f.register(1);
  await f.api("draw", { day: "2026-10-28" }, cookie);
  const state = (await f.api("state", undefined, cookie)).body;
  const first = state.draw.order[0];
  const c = first === 1 ? cookie : await f.register(first);
  await f.api("push/subscribe", { subscription: subscription("stale") }, c);
  await f.api("book", { day: state.day, start: 900, duration: 30 }, c);
  await f.app.flushNotifications();
  assert.equal(sent.length, 0);
});

test("抽選前・順番前に希望を共有し、他の人には内容だけ見せる", async (t) => {
  const f = await fixture(t);
  const one = await f.register(1),
    two = await f.register(2);
  const wish = {
    day: "2026-10-28",
    start: 1080,
    duration: 45,
    note: "明日は出張なので早めを希望します。",
  };
  assert.equal((await f.api("wish", wish, one)).status, 200);
  let state = (await f.api("state", undefined, two)).body;
  assert.equal(state.draw, null);
  assert.equal(state.bookings.length, 0);
  assert.equal(state.wishes[0].note, wish.note);
  assert.equal(
    (await f.api("wish", { ...wish, start: 1110 }, one)).status,
    200,
  );
  assert.equal(
    (await f.api("wish/cancel", { day: wish.day, memberId: 1 }, two)).status,
    200,
  );
  state = (await f.api("state", undefined, two)).body;
  assert.equal(state.wishes.length, 1);
  assert.equal(state.wishes[0].start, 1110);
  assert.equal(
    (await f.api("wish", { ...wish, note: "a".repeat(301) }, one)).status,
    400,
  );
  assert.equal(
    (await f.api("wish/cancel", { day: wish.day }, one)).status,
    200,
  );
  assert.equal((await f.api("state", undefined, two)).body.wishes.length, 0);
});
test("様子見で末尾へ移動して次の人へ通知し、通常の順番にも戻せる", async (t) => {
  const sent = [];
  const f = await fixture(t, {
    deliverPush: async (sub) => sent.push(sub.endpoint),
  });
  const cookies = {},
    subs = {};
  for (let id = 1; id <= 5; id++) {
    cookies[id] = await f.register(id);
    subs[id] = subscription(`skip${id}`);
    await f.api("push/subscribe", { subscription: subs[id] }, cookies[id]);
  }
  await f.api("draw", { day: "2026-10-28" }, cookies[1]);
  const state = (await f.api("state", undefined, cookies[1])).body;
  const [first, second, third] = state.draw.order;
  await f.app.flushNotifications();
  assert.deepEqual(sent, [subs[first].endpoint]);
  await f.api(
    "wish",
    { day: state.day, start: 900, duration: 30, note: "早め希望" },
    cookies[first],
  );
  assert.equal(
    (await f.api("skip", { day: state.day, skip: true }, cookies[first]))
      .status,
    200,
  );
  await f.app.flushNotifications();
  assert.deepEqual(sent, [subs[first].endpoint, subs[second].endpoint]);
  let after = (await f.api("state", undefined, cookies[second])).body;
  assert.deepEqual(after.skips, [first]);
  assert.equal(after.wishes.length, 0);
  assert.equal(
    (
      await f.api(
        "book",
        { day: state.day, start: 900, duration: 30 },
        cookies[first],
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await f.api(
        "wish",
        { day: state.day, start: 900, duration: 30 },
        cookies[first],
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await f.api(
        "book",
        { day: state.day, start: 900, duration: 30 },
        cookies[second],
      )
    ).status,
    200,
  );
  await f.app.flushNotifications();
  assert.equal(sent.at(-1), subs[third].endpoint);
  assert.equal(
    (await f.api("skip", { day: state.day, skip: false }, cookies[first]))
      .status,
    200,
  );
  await f.app.flushNotifications();
  assert.equal(sent.at(-1), subs[first].endpoint);
  assert.equal(
    (
      await f.api(
        "book",
        { day: state.day, start: 930, duration: 30 },
        cookies[first],
      )
    ).status,
    200,
  );
  assert.equal(
    (await f.api("skip", { day: state.day, skip: true }, cookies[first]))
      .status,
    200,
  );
  after = (await f.api("state", undefined, cookies[second])).body;
  assert.equal(
    after.bookings.some((b) => b.memberId === first),
    false,
  );
});
test("希望は時刻を確保しない。予約と重なっても共有でき、予約確定時に消える", async (t) => {
  const f = await fixture(t);
  const cookies = {};
  for (let id = 1; id <= 5; id++) cookies[id] = await f.register(id);
  await f.api("draw", { day: "2026-10-28" }, cookies[1]);
  const state = (await f.api("state", undefined, cookies[1])).body;
  const [first, second] = state.draw.order;
  await f.api(
    "book",
    { day: state.day, start: 900, duration: 30 },
    cookies[first],
  );
  assert.equal(
    (
      await f.api(
        "wish",
        { day: state.day, start: 900, duration: 30, note: "できればこの時間" },
        cookies[second],
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await f.api(
        "book",
        { day: state.day, start: 900, duration: 30 },
        cookies[second],
      )
    ).status,
    409,
  );
  assert.equal(
    (await f.api("state", undefined, cookies[first])).body.wishes.length,
    1,
  );
  assert.equal(
    (
      await f.api(
        "book",
        { day: state.day, start: 930, duration: 30 },
        cookies[second],
      )
    ).status,
    200,
  );
  assert.equal(
    (await f.api("state", undefined, cookies[first])).body.wishes.length,
    0,
  );
  assert.equal(
    (
      await f.api(
        "wish",
        { day: state.day, start: 990, duration: 30 },
        cookies[second],
      )
    ).status,
    409,
  );
  f.setTime("2026-10-28T15:01:00+09:00");
  assert.equal(
    (await f.api("skip", { day: state.day, skip: true }, cookies[first]))
      .status,
    409,
  );
});
test("全員が抽選前に様子見を選んでも、選んだ順に末尾へ並ぶ", async (t) => {
  const sent = [];
  const f = await fixture(t, { deliverPush: async (sub) => sent.push(sub) });
  const cookies = {};
  for (let id = 1; id <= 5; id++) {
    cookies[id] = await f.register(id);
    await f.api("skip", { day: "2026-10-28", skip: true }, cookies[id]);
  }
  await f.api("draw", { day: "2026-10-28" }, cookies[1]);
  const state = (await f.api("state", undefined, cookies[1])).body;
  assert.equal(state.skips.length, 5);
  assert.deepEqual(state.draw.order, [1, 2, 3, 4, 5]);
  await f.app.flushNotifications();
  assert.equal(sent.length, 0);
  assert.equal(
    (await f.api("skip", { day: state.day, skip: "true" }, cookies[1])).status,
    400,
  );
  f.setTime("2026-10-29T07:00:00+09:00");
  assert.equal(
    (await f.api("skip", { day: state.day, skip: false }, cookies[1])).status,
    400,
  );
});
test("複数人の様子見は選択順に末尾へ並び、最後でも予約できる", async (t) => {
  const sent = [];
  const f = await fixture(t, {
    deliverPush: async (sub) => sent.push(sub.endpoint),
  });
  const cookies = {},
    subs = {};
  for (let id = 1; id <= 5; id++) {
    cookies[id] = await f.register(id);
    subs[id] = subscription("tail" + id);
    await f.api("push/subscribe", { subscription: subs[id] }, cookies[id]);
  }
  await f.api("draw", { day: "2026-10-28" }, cookies[1]);
  let state = (await f.api("state", undefined, cookies[1])).body;
  const [a, b, c, d, e] = state.draw.order;
  const original = state.draw.order.slice();
  await f.api("skip", { day: state.day, skip: true }, cookies[a]);
  await f.api("skip", { day: state.day, skip: true }, cookies[c]);
  state = (await f.api("state", undefined, cookies[1])).body;
  assert.deepEqual(state.draw.order, [b, d, e, a, c]);
  assert.deepEqual(state.draw.originalOrder, original);
  // Duplicate delivery of the same choice does not move that person a second time.
  await f.api("skip", { day: state.day, skip: true }, cookies[a]);
  assert.deepEqual(
    (await f.api("state", undefined, cookies[1])).body.draw.order,
    [b, d, e, a, c],
  );
  for (const [i, id] of [b, d, e].entries())
    assert.equal(
      (
        await f.api(
          "book",
          { day: state.day, start: 900 + i * 30, duration: 30 },
          cookies[id],
        )
      ).status,
      200,
    );
  await f.app.flushNotifications();
  assert.equal(sent.at(-1), subs[a].endpoint);
  assert.equal(
    (
      await f.api(
        "wish",
        {
          day: state.day,
          start: 1020,
          duration: 30,
          note: "様子を見てから入りたい",
        },
        cookies[a],
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await f.api(
        "book",
        { day: state.day, start: 1020, duration: 30 },
        cookies[a],
      )
    ).status,
    200,
  );
  await f.app.flushNotifications();
  assert.equal(sent.at(-1), subs[c].endpoint);
  assert.equal(
    (
      await f.api(
        "book",
        { day: state.day, start: 1050, duration: 30 },
        cookies[c],
      )
    ).status,
    200,
  );
  state = (await f.api("state", undefined, cookies[1])).body;
  assert.equal(state.bookings.length, 5);
  assert.deepEqual(state.draw.order, [b, d, e, a, c]);
});
