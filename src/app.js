import { DatabaseSync } from "node:sqlite";
import {
  randomBytes,
  createHash,
  scrypt as scryptCallback,
  timingSafeEqual,
} from "node:crypto";
import { promisify } from "node:util";
import { readFileSync } from "node:fs";
import { generateKeys, sendPush, validateSubscription } from "./push.js";
import { validateProfile } from "./member-profile.js";
import { createAdminData } from "./admin-data.js";
import { createBookingReminders } from "./booking-reminders.js";
import { createPasskeys } from "./passkeys.js";
import { createServerSettings } from "./server-settings.js";
import {
  japanTime,
  lotteryOpen,
  slotDate,
  validateSlot,
  shuffle,
} from "./domain.js";

const scrypt = promisify(scryptCallback);
const parseProfile=value=>{try{return validateProfile(value);}catch(error){fail(400,error.message);}};
const digest = (value) => createHash("sha256").update(value).digest("hex");
const fail = (status, message) => {
  throw Object.assign(new Error(message), { status });
};

export function createApp({
  database = ":memory:",
  now = () => new Date(),
  requireFamily = true,
  deliverPush = sendPush,
  onNotificationQueued = () => {},
} = {}) {
  const db = new DatabaseSync(database);
  db.exec(
    "PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;",
  );
  if (
    !db.prepare("SELECT name FROM sqlite_master WHERE name='members'").get()
  ) {
    db.exec("BEGIN");
    try {
      db.exec(
        readFileSync(
          new URL("../migrations/0001_initial.sql", import.meta.url),
          "utf8",
        ),
      );
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  // Additive migration: preserve all existing members, bookings and passwords.
  db.exec(
    readFileSync(
      new URL("../migrations/0002_family_push.sql", import.meta.url),
      "utf8",
    ),
  );
  if (!db.prepare("SELECT id FROM family_config WHERE id=1").get()) {
    const keys = generateKeys();
    db.prepare(
      "INSERT OR IGNORE INTO family_config(id,access_token,vapid_public,vapid_private) VALUES(1,?,?,?)",
    ).run(randomBytes(32).toString("hex"), keys.publicKey, keys.privateKey);
  }
  db.exec(
    readFileSync(
      new URL("../migrations/0003_wishes_skips.sql", import.meta.url),
      "utf8",
    ),
  );
  db.exec(
    readFileSync(
      new URL("../migrations/0004_passkeys.sql", import.meta.url),
      "utf8",
    ),
  );
  if (
    !db
      .prepare("PRAGMA table_info(bath_skips)")
      .all()
      .some((column) => column.name === "tail_order")
  )
    db.exec(
      readFileSync(
        new URL("../migrations/0006_deferred_priority.sql", import.meta.url),
        "utf8",
      ),
    );
  const familyConfig = () =>
    db.prepare("SELECT * FROM family_config WHERE id=1").get();
  const cookieValue = (req, name) =>
    (req.headers.cookie || "")
      .split(";")
      .map((v) => v.trim())
      .find((v) => v.startsWith(name + "="))
      ?.slice(name.length + 1);
  const familyAllowed = (req) =>
    !requireFamily ||
    !!db
      .prepare(
        "SELECT token_hash FROM family_sessions WHERE token_hash=? AND expires>?",
      )
      .get(digest(cookieValue(req, "bath_family") || ""), now().getTime());
  const cookieAttributes = (req) =>
    `HttpOnly; SameSite=Strict; Path=/${req.bathSecure || req.socket.encrypted ? "; Secure" : ""}`;
  const reservationOrder = (day) => {
    const draw = db
      .prepare("SELECT order_json FROM draws WHERE day=?")
      .get(day);
    if (!draw) return [];
    const original = JSON.parse(draw.order_json);
    const deferred = db
      .prepare(
        "SELECT member_id FROM bath_skips WHERE day=? ORDER BY tail_order,member_id",
      )
      .all(day)
      .map((row) => row.member_id);
    return [
      ...original.filter((id) => !deferred.includes(id)),
      ...deferred.filter((id) => original.includes(id)),
    ];
  };
  const currentTurn = (day) => {
    if (slotDate(day, scheduleForDay(day).bathEnd) <= now()) return null;
    const booked = db
      .prepare("SELECT member_id FROM bookings WHERE day=?")
      .all(day)
      .map((row) => row.member_id);
    return (
      reservationOrder(day).find(
        (id) =>
          !booked.includes(id) &&
          db.prepare("SELECT id FROM members WHERE id=? AND active=1").get(id),
      ) || null
    );
  };
  function advanceWishes(day) {
    function candidate() {
      const id=currentTurn(day);
      if(!id)return null;
      const wish=db.prepare("SELECT * FROM wishes WHERE day=? AND member_id=?").get(day,id);
      if(!wish || !validateSlot(wish.start,wish.duration,scheduleForDay(day)) || slotDate(day,wish.start)<=now())return null;
      for(const table of ["bookings","wishes"])
        if(db.prepare(`SELECT member_id FROM ${table} WHERE day=? AND member_id!=? AND start<? AND start+duration>? LIMIT 1`).get(day,id,wish.start+wish.duration,wish.start))return null;
      return wish;
    }
    if(!candidate())return;
    db.exec("BEGIN IMMEDIATE");
    try {
      let wish;
      while((wish=candidate())) {
        db.prepare("INSERT INTO bookings(day,member_id,start,duration,note,no_negotiation,auto_confirmed) VALUES(?,?,?,?,?,0,1)").run(day,wish.member_id,wish.start,wish.duration,wish.note);
        db.prepare("DELETE FROM wishes WHERE day=? AND member_id=?").run(day,wish.member_id);
      }
      db.exec("COMMIT");
    }catch(error){db.exec("ROLLBACK");throw error;}
  }
  const enqueueTurn = (day, previous = null, onlyEndpoint = null) => {
    advanceWishes(day);
    reminders.syncDay(day);
    const next = currentTurn(day);
    if (!next || next === previous) return;
    const subscriptions = db
      .prepare(
        "SELECT p.endpoint FROM push_subscriptions p JOIN sessions s ON p.session_hash=s.token_hash WHERE p.member_id=? AND s.expires>?",
      )
      .all(next, now().getTime());
    const insert = db.prepare(
      "INSERT INTO notification_queue(endpoint,day,member_id) VALUES(?,?,?)",
    );
    let queued = false;
    for (const sub of subscriptions)
      if (!onlyEndpoint || sub.endpoint === onlyEndpoint) {
        insert.run(sub.endpoint, day, next);
        queued = true;
      }
    if (queued) onNotificationQueued();
  };
  let flushing = false,
    closed = false;
  async function flushNotifications() {
    if (flushing || closed) return;
    flushing = true;
    try {
      const jobs = db
        .prepare(
          "SELECT q.*,p.subscription_json,s.expires FROM notification_queue q JOIN push_subscriptions p ON p.endpoint=q.endpoint JOIN sessions s ON s.token_hash=p.session_hash WHERE q.next_attempt<=? ORDER BY q.id LIMIT 20",
        )
        .all(now().getTime());
      for (const job of jobs) {
        if (
          job.expires <= now().getTime() ||
          currentTurn(job.day) !== job.member_id
        ) {
          db.prepare("DELETE FROM notification_queue WHERE id=?").run(job.id);
          continue;
        }
        const name = db
          .prepare("SELECT name FROM members WHERE id=?")
          .get(job.member_id).name;
        const config = familyConfig();
        try {
          await deliverPush(
            JSON.parse(job.subscription_json),
            {
              title: "おふろを予約する番です ♨",
              body: `${name}さん、おふろを予約する番です。好きな時間を選んでください。`,
              tag: `bath-turn-${job.day}`,
              day: job.day,
              url: "/",
            },
            {
              publicKey: config.vapid_public,
              privateKey: config.vapid_private,
            },
          );
          if (closed) return;
          db.prepare("DELETE FROM notification_queue WHERE id=?").run(job.id);
        } catch (error) {
          if (closed) return;
          if (error.statusCode === 404 || error.statusCode === 410)
            db.prepare("DELETE FROM push_subscriptions WHERE endpoint=?").run(
              job.endpoint,
            );
          else {
            const attempts = job.attempts + 1;
            db.prepare(
              "UPDATE notification_queue SET attempts=?,next_attempt=? WHERE id=?",
            ).run(
              attempts,
              now().getTime() +
                Math.min(3600000, 15000 * 2 ** Math.min(attempts, 8)),
              job.id,
            );
            console.warn(
              "通知を再試行します。",
              error.statusCode || error.code || "network",
            );
          }
        }
      }
      await reminders.flush();
    } finally {
      flushing = false;
    }
  }
  async function setFamilyPassword(password) {
    if (
      typeof password !== "string" ||
      password.length < 8 ||
      password.length > 128
    )
      throw new Error("家族の合い言葉は8〜128文字で設定してください。");
    const epoch=familyConfig().access_token;
    const salt = randomBytes(16).toString("hex");
    const hash = (await scrypt(password, salt, 64)).toString("hex");
    if(familyConfig().access_token!==epoch)throw new Error("データがリセットされました。読み込み直してください。");
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare(
        "UPDATE family_config SET password_hash=?,salt=?,failures=0,locked_until=0 WHERE id=1",
      ).run(hash, salt);
      db.exec(
        "DELETE FROM family_sessions; DELETE FROM sessions; DELETE FROM passkey_credentials; DELETE FROM passkey_challenges; COMMIT;",
      );
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    onNotificationQueued();
  }
  const bookingColumns = db
    .prepare("PRAGMA table_info(bookings)")
    .all()
    .map((column) => column.name);
  if (!bookingColumns.includes("note"))
    db.exec(
      "ALTER TABLE bookings ADD COLUMN note TEXT NOT NULL DEFAULT '' CHECK(length(note)<=300)",
    );
  if (!bookingColumns.includes("no_negotiation"))
    db.exec(
      "ALTER TABLE bookings ADD COLUMN no_negotiation INTEGER NOT NULL DEFAULT 0 CHECK(no_negotiation IN (0,1))",
    );
  for (const [name,type] of [["emoji","TEXT"],["color","TEXT"]])
    if (!db.prepare("PRAGMA table_info(members)").all().some(column=>column.name===name))
      db.exec(`ALTER TABLE members ADD COLUMN ${name} ${type}`);
  const serverSettings = createServerSettings(db, now);
  if (!db.prepare("PRAGMA table_info(bookings)").all().some(column=>column.name==="auto_confirmed"))
    db.exec("ALTER TABLE bookings ADD COLUMN auto_confirmed INTEGER NOT NULL DEFAULT 0 CHECK(auto_confirmed IN (0,1))");

  const scheduleForDay = serverSettings.scheduleForDay;
  const reminders=createBookingReminders({db,now,deliverPush,familyConfig,onQueued:onNotificationQueued,isClosed:()=>closed});
  const currentTime = () => {
    const time = japanTime(now());
    const yesterday = scheduleForDay(time.yesterday);
    return {
      ...time,
      tomorrow: new Date(new Date(time.today + "T12:00:00Z").getTime() + 86400000).toISOString().slice(0, 10),
      activeDay:
        yesterday.bathEnd > 1440 && time.minute < yesterday.bathEnd - 1440
          ? time.yesterday
          : time.today,
    };
  };
  const allMembers = (onlyActive = true) =>
    db
      .prepare(
        `SELECT id,name,active,emoji,color,password_hash IS NOT NULL AS registered FROM members ${onlyActive ? "WHERE active=1" : ""} ORDER BY id`,
      )
      .all();
  const ensureFixedDraw = (day) => {
    const rule = scheduleForDay(day);
    if (
      rule.orderMode !== "fixed" ||
      db.prepare("SELECT day FROM draws WHERE day=?").get(day)
    )
      return;
    const active = allMembers().map((member) => member.id);
    const order = [
      ...rule.fixedOrder.filter((id) => active.includes(id)),
      ...active.filter((id) => !rule.fixedOrder.includes(id)),
    ];
    if (!order.length) return;
    const created = db
      .prepare("INSERT OR IGNORE INTO draws VALUES(?,?,?)")
      .run(day, JSON.stringify(order), now().toISOString());
    if (created.changes) enqueueTurn(day);
  };
  const memberFor = (req) => {
    const token = (req.headers.cookie || "")
      .split(";")
      .map((v) => v.trim())
      .find((v) => v.startsWith("bath_session="))
      ?.slice(13);
    if (!token) return null;
    return (
      db
        .prepare(
          "SELECT m.id,m.name FROM sessions s JOIN members m ON m.id=s.member_id WHERE token_hash=? AND expires>? AND m.active=1",
        )
        .get(digest(token), now().getTime()) || null
    );
  };
  const validDay = (day, allowTomorrow = false) => {
    const time = currentTime();
    if (day !== time.today && day !== time.yesterday && !(allowTomorrow && day === time.tomorrow))
      fail(400, "表示できる日付、または受付中の日付を選んでください。");
    return day;
  };
  function loginAs(memberId, req, res, includeFamily = false) {
    if (
      !db
        .prepare("SELECT id FROM members WHERE id=? AND active=1")
        .get(memberId)
    )
      fail(403, "このメンバーは利用停止中です。");
    const token = randomBytes(32).toString("hex");
    db.prepare("DELETE FROM sessions WHERE expires<=?").run(now().getTime());
    db.prepare("INSERT INTO sessions VALUES(?,?,?)").run(
      digest(token),
      memberId,
      now().getTime() + 30 * 86400000,
    );
    const cookies = [
      `bath_session=${token}; ${cookieAttributes(req)}; Max-Age=2592000`,
    ];
    if (includeFamily) {
      const familyToken = randomBytes(32).toString("hex");
      db.prepare("DELETE FROM family_sessions WHERE expires<=?").run(
        now().getTime(),
      );
      db.prepare("INSERT INTO family_sessions VALUES(?,?)").run(
        digest(familyToken),
        now().getTime() + 180 * 86400000,
      );
      cookies.push(
        `bath_family=${familyToken}; ${cookieAttributes(req)}; Max-Age=15552000`,
      );
    }
    res.setHeader("Set-Cookie", cookies.length === 1 ? cookies[0] : cookies);
    return db.prepare("SELECT id,name FROM members WHERE id=?").get(memberId);
  }
  const passkeys = createPasskeys({ db, now, cookieAttributes, loginAs, sessionValid:(req,id)=>familyAllowed(req)&&memberFor(req)?.id===id });
  async function handle(req, res) {
    const url = new URL(req.url, "http://localhost");
    const send = (status, body) => {
      res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify(body));
    };
    try {
      if (req.method === "GET" && url.pathname === "/api/family")
        return send(200, {
          configured: !!familyConfig().password_hash,
          authenticated: familyAllowed(req),
        });
      if (
        !familyAllowed(req) &&
        !(
          req.method === "POST" &&
          [
            "/api/family/login",
            "/api/passkey/auth/options",
            "/api/passkey/auth/verify",
          ].includes(url.pathname)
        )
      )
        fail(401, "先に家族の合い言葉を入力してください。");
      if (req.method === "GET" && url.pathname === "/api/members")
        return send(200, { members: allMembers(), me: memberFor(req) });
      if (req.method !== "GET" && req.method !== "POST")
        fail(405, "この操作には対応していません。");
      let body = {};
      if (req.method === "POST") {
        if (req.headers["sec-fetch-site"] === "cross-site")
          fail(403, "アプリを開き直してください。");
        const origin = req.headers.origin;
        if (
          origin &&
          origin !==
            (req.bathOrigin ||
              `${req.socket.encrypted ? "https" : "http"}://${req.headers.host}`)
        )
          fail(403, "アプリを開き直してください。");
        if (!(req.headers["content-type"] || "").startsWith("application/json"))
          fail(415, "JSON形式で送信してください。");
        let chunks = [],
          size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > (url.pathname.startsWith("/api/passkey/") ? 65536 : 8192))
            fail(413, "送信データが大きすぎます。");
          chunks.push(chunk);
        }
        try {
          body = JSON.parse(Buffer.concat(chunks).toString());
        } catch {
          fail(400, "入力を確認してください。");
        }
        if (!body || typeof body !== "object" || Array.isArray(body))
          fail(400, "入力を確認してください。");
      }
      if (
        url.pathname.startsWith("/api/passkey/auth/") &&
        (await passkeys.handle(req, res, url.pathname, body, null, send))
      )
        return;
      if (req.method === "POST" && url.pathname === "/api/family/login") {
        const config = familyConfig();
        if (!config.password_hash)
          fail(
            503,
            "家族の合い言葉を準備中です。準備ができてからもう一度開いてください。",
          );
        if (config.locked_until > now().getTime())
          fail(429, "試行回数が多いため、15分ほど待ってからお試しください。");
        if (typeof body.password !== "string" || body.password.length > 128)
          fail(400, "家族の合い言葉を入力してください。");
        db.prepare(
          "UPDATE family_config SET failures=CASE WHEN locked_until>0 AND locked_until<=? THEN 1 ELSE failures+1 END,locked_until=CASE WHEN (CASE WHEN locked_until>0 AND locked_until<=? THEN 1 ELSE failures+1 END)>=10 THEN ? ELSE 0 END WHERE id=1",
        ).run(now().getTime(), now().getTime(), now().getTime() + 900000);
        const hash = await scrypt(body.password, config.salt, 64);
        if(familyConfig().password_hash!==config.password_hash || familyConfig().access_token!==config.access_token)fail(401,"合い言葉が変更されました。ログインし直してください。");
        if (!timingSafeEqual(hash, Buffer.from(config.password_hash, "hex")))
          fail(401, "家族の合い言葉が違います。");
        db.exec(
          "UPDATE family_config SET failures=0,locked_until=0 WHERE id=1",
        );
        const token = randomBytes(32).toString("hex");
        db.prepare("DELETE FROM family_sessions WHERE expires<=?").run(
          now().getTime(),
        );
        db.prepare("INSERT INTO family_sessions VALUES(?,?)").run(
          digest(token),
          now().getTime() + 180 * 86400000,
        );
        res.setHeader(
          "Set-Cookie",
          `bath_family=${token}; ${cookieAttributes(req)}; Max-Age=15552000`,
        );
        return send(200, { ok: true });
      }
      if (
        req.method === "POST" &&
        ["/api/login", "/api/register"].includes(url.pathname)
      ) {
        const epoch=familyConfig().access_token;
        const member = db
          .prepare("SELECT * FROM members WHERE id=?")
          .get(Number(body.memberId) || 0);
        if (!member || !member.active)
          fail(400, "利用できる名前を選んでください。");
        if (
          typeof body.password !== "string" ||
          body.password.length < 4 ||
          body.password.length > 128
        )
          fail(400, "パスワードは4〜128文字で入力してください。");
        if (member.locked_until > now().getTime())
          fail(429, "試行回数が多いため、15分ほど待ってからお試しください。");
        if (url.pathname === "/api/register") {
          if (member.password_hash)
            fail(409, "設定済みです。ログインしてください。");
          const profile = body.profile === undefined ? {emoji:null,color:null} : parseProfile(body.profile);
          const salt = randomBytes(16).toString("hex");
          const hash = (await scrypt(body.password, salt, 64)).toString("hex");
          if(familyConfig().access_token!==epoch || !familyAllowed(req))fail(401,"設定が変更されました。開き直してください。");
          const result = db
            .prepare(
              "UPDATE members SET password_hash=?,salt=?,emoji=?,color=? WHERE id=? AND password_hash IS NULL AND active=1",
            )
            .run(hash, salt, profile.emoji, profile.color, member.id);
          if (!result.changes)
            fail(409, "設定済みです。ログインしてください。");
        } else {
          if (!member.password_hash)
            fail(400, "初回のパスワード設定をしてください。");
          // Count before the expensive password check so concurrent attempts cannot bypass the limit.
          db.prepare(
            "UPDATE members SET failures=CASE WHEN locked_until>0 AND locked_until<=? THEN 1 ELSE failures+1 END, locked_until=CASE WHEN (CASE WHEN locked_until>0 AND locked_until<=? THEN 1 ELSE failures+1 END)>=5 THEN ? ELSE 0 END WHERE id=?",
          ).run(
            now().getTime(),
            now().getTime(),
            now().getTime() + 900000,
            member.id,
          );
          const hash = await scrypt(body.password, member.salt, 64);
          if(familyConfig().access_token!==epoch || db.prepare("SELECT password_hash FROM members WHERE id=?").get(member.id)?.password_hash!==member.password_hash || !familyAllowed(req))fail(401,"設定が変更されました。ログインし直してください。");
          if (!timingSafeEqual(hash, Buffer.from(member.password_hash, "hex")))
            fail(401, "パスワードが違います。");
          db.prepare(
            "UPDATE members SET failures=0,locked_until=0 WHERE id=?",
          ).run(member.id);
        }
        loginAs(member.id, req, res);
        return send(200, { me: { id: member.id, name: member.name } });
      }
      const me = memberFor(req);
      if (!me) fail(401, "ログインしてください。");
      if(req.method==="POST" && url.pathname==="/api/profile") {
        const profile=parseProfile(body);
        db.prepare("UPDATE members SET emoji=?,color=? WHERE id=?").run(profile.emoji,profile.color,me.id);
        return send(200,{ok:true});
      }
      if (
        url.pathname.startsWith("/api/passkey/") &&
        (await passkeys.handle(req, res, url.pathname, body, me, send))
      )
        return;
      if (req.method === "GET" && url.pathname === "/api/push/key")
        return send(200, { publicKey: familyConfig().vapid_public });
      if (req.method === "POST" && url.pathname === "/api/push/subscribe") {
        if (!validateSubscription(body.subscription))
          fail(400, "この端末の通知を登録できませんでした。");
        const subscription = {
          endpoint: body.subscription.endpoint,
          keys: {
            p256dh: body.subscription.keys.p256dh,
            auth: body.subscription.keys.auth,
          },
        };
        const count = db
          .prepare(
            "SELECT COUNT(*) AS n FROM push_subscriptions WHERE member_id=?",
          )
          .get(me.id).n;
        if (
          count >= 20 &&
          !db
            .prepare("SELECT endpoint FROM push_subscriptions WHERE endpoint=?")
            .get(subscription.endpoint)
        )
          fail(400, "通知を登録できる端末数の上限です。");
        const previousSubscription = db
          .prepare(
            "SELECT member_id,session_hash FROM push_subscriptions WHERE endpoint=?",
          )
          .get(subscription.endpoint);
        const newBinding =
          !previousSubscription ||
          previousSubscription.member_id !== me.id ||
          previousSubscription.session_hash !==
            digest(cookieValue(req, "bath_session"));
        if (newBinding) {
          db.prepare("DELETE FROM notification_queue WHERE endpoint=?").run(subscription.endpoint);
          reminders.clearEndpoint(subscription.endpoint);
        }
        db.prepare(
          "INSERT INTO push_subscriptions VALUES(?,?,?,?) ON CONFLICT(endpoint) DO UPDATE SET member_id=excluded.member_id,session_hash=excluded.session_hash,subscription_json=excluded.subscription_json",
        ).run(
          subscription.endpoint,
          me.id,
          digest(cookieValue(req, "bath_session")),
          JSON.stringify(subscription),
        );
        reminders.restore(me.id);
        const time = currentTime();
        if (newBinding) {
          enqueueTurn(time.today, null, subscription.endpoint);
          if (time.activeDay !== time.today)
            enqueueTurn(time.activeDay, null, subscription.endpoint);
        }
        return send(200, { ok: true });
      }
      if (req.method === "POST" && url.pathname === "/api/push/unsubscribe") {
        if (typeof body.endpoint !== "string")
          fail(400, "端末を確認できませんでした。");
        db.prepare(
          "DELETE FROM push_subscriptions WHERE endpoint=? AND member_id=?",
        ).run(body.endpoint, me.id);
        onNotificationQueued();
        return send(200, { ok: true });
      }
      if (req.method === "GET" && url.pathname === "/api/state") {
        const time = currentTime();
        const day = validDay(url.searchParams.get("day") || time.activeDay, true);
        if (day !== time.tomorrow) {ensureFixedDraw(day);enqueueTurn(day,currentTurn(day));}
        const draw = db.prepare("SELECT * FROM draws WHERE day=?").get(day);
        return send(200, {
          me,
          shareUrl: req.bathSecure
            ? `${req.bathOrigin}/family/${familyConfig().access_token}/`
            : null,
          passkeyCount: db
            .prepare(
              "SELECT COUNT(*) AS n FROM passkey_credentials WHERE member_id=?",
            )
            .get(me.id).n,
          settings: scheduleForDay(day),
          members: allMembers(false),
          day,
          ...time,
          now: now().toISOString(),
          draw: draw
            ? {
                order: reservationOrder(day),
                originalOrder: JSON.parse(draw.order_json),
                createdAt: draw.created_at,
                mode: scheduleForDay(day).orderMode,
              }
            : null,
          lotteryOpen: lotteryOpen(day, now(), scheduleForDay(day)),
          skips: db
            .prepare(
              "SELECT member_id FROM bath_skips WHERE day=? ORDER BY member_id",
            )
            .all(day)
            .map((row) => row.member_id),
          wishes: db
            .prepare(
              "SELECT member_id AS memberId,start,duration,note FROM wishes WHERE day=? ORDER BY start,member_id",
            )
            .all(day),
          bookings: db
            .prepare(
              "SELECT member_id AS memberId,start,duration,note,no_negotiation AS noNegotiation,auto_confirmed AS autoConfirmed FROM bookings WHERE day=? ORDER BY start",
            )
            .all(day),
        });
      }
      if (req.method === "POST" && url.pathname === "/api/logout") {
        const cookie = (req.headers.cookie || "")
          .split(";")
          .map((v) => v.trim())
          .find((v) => v.startsWith("bath_session="))
          ?.slice(13);
        if (cookie)
          db.prepare("DELETE FROM sessions WHERE token_hash=?").run(
            digest(cookie),
          );
        onNotificationQueued();
        res.setHeader(
          "Set-Cookie",
          "bath_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0",
        );
        return send(200, { ok: true });
      }
      if (req.method === "POST" && url.pathname === "/api/draw") {
        const day = validDay(body.day);
        if (scheduleForDay(day).orderMode === "fixed")
          fail(409, "固定順モードなので、抽選は不要です。");
        if (!lotteryOpen(day, now(), scheduleForDay(day)))
          fail(403, "設定された当日の抽選時間内に操作してください。");
        const order = shuffle(allMembers().map((m) => m.id));
        const result = db
          .prepare("INSERT OR IGNORE INTO draws VALUES (?,?,?)")
          .run(day, JSON.stringify(order), now().toISOString());
        if (!result.changes)
          fail(409, "今日はすでに抽選済みです。結果を更新します。");
        enqueueTurn(day);
        return send(200, { ok: true });
      }
      if (req.method === "POST" && url.pathname === "/api/skip") {
        const day = validDay(body.day);
        if (typeof body.skip !== "boolean")
          fail(400, "入らない/様子見の状態を選んでください。");
        if (slotDate(day, scheduleForDay(day).bathEnd) <= now())
          fail(400, "この日のおふろは終了しています。");
        const booking = db
          .prepare("SELECT start FROM bookings WHERE day=? AND member_id=?")
          .get(day, me.id);
        if (booking && slotDate(day, booking.start) <= now())
          fail(409, "開始済みの予約はキャンセルできません。");
        ensureFixedDraw(day);
        const previous = currentTurn(day);
        db.exec("BEGIN IMMEDIATE");
        try {
          if (body.skip) {
            const deferred = db
              .prepare(
                "SELECT tail_order FROM bath_skips WHERE day=? AND member_id=?",
              )
              .get(day, me.id);
            if (!deferred || booking) {
              const tail = db
                .prepare(
                  "SELECT COALESCE(MAX(tail_order),0)+1 AS position FROM bath_skips WHERE day=?",
                )
                .get(day).position;
              db.prepare(
                "INSERT INTO bath_skips(day,member_id,tail_order) VALUES(?,?,?) ON CONFLICT(day,member_id) DO UPDATE SET tail_order=excluded.tail_order",
              ).run(day, me.id, tail);
            }
            db.prepare("DELETE FROM bookings WHERE day=? AND member_id=?").run(
              day,
              me.id,
            );
            db.prepare("DELETE FROM wishes WHERE day=? AND member_id=?").run(
              day,
              me.id,
            );
          } else
            db.prepare(
              "DELETE FROM bath_skips WHERE day=? AND member_id=?",
            ).run(day, me.id);
          db.exec("COMMIT");
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
        enqueueTurn(day, previous);
        return send(200, { ok: true });
      }
      if (req.method === "POST" && url.pathname === "/api/wish") {
        const day = validDay(body.day),
          { start, duration } = body,
          note = body.note ?? "";
        if (
          !validateSlot(start, duration, scheduleForDay(day)) ||
          slotDate(day, start) <= now()
        )
          fail(
            400,
            "この日の設定に合う、これからの時刻と所要時間を選んでください。",
          );
        if (typeof note !== "string" || note.length > 300)
          fail(400, "希望の理由は300文字以内で入力してください。");
        if (
          db
            .prepare(
              "SELECT member_id FROM bookings WHERE day=? AND member_id=?",
            )
            .get(day, me.id)
        )
          fail(409, "予約済みです。時間の変更は自分の予約から行ってください。");
        db.prepare(
          "INSERT INTO wishes(day,member_id,start,duration,note) VALUES(?,?,?,?,?) ON CONFLICT(day,member_id) DO UPDATE SET start=excluded.start,duration=excluded.duration,note=excluded.note",
        ).run(day, me.id, start, duration, note.trim());
        enqueueTurn(day,currentTurn(day));
        const confirmed=db.prepare("SELECT auto_confirmed FROM bookings WHERE day=? AND member_id=?").get(day,me.id);
        return send(200, { ok: true, autoConfirmed:!!confirmed?.auto_confirmed });
      }
      if (req.method === "POST" && url.pathname === "/api/wish/cancel") {
        const day = validDay(body.day), previous=currentTurn(day);
        db.prepare("DELETE FROM wishes WHERE day=? AND member_id=?").run(
          day,
          me.id,
        );
        enqueueTurn(day,previous);
        return send(200, { ok: true });
      }
      if (req.method === "POST" && url.pathname === "/api/book") {
        const day = validDay(body.day);
        const { start, duration } = body;
        if (!validateSlot(start, duration, scheduleForDay(day)))
          fail(
            400,
            "この日の設定に合い、入浴時間帯の終了までに収まる予約を選んでください。",
          );
        if (slotDate(day, start) <= now())
          fail(400, "これからの時刻を選んでください。");
        ensureFixedDraw(day);
        const draw = db
          .prepare("SELECT order_json FROM draws WHERE day=?")
          .get(day);
        if (!draw) fail(409, "先に抽選してください。");
        const existing = db
          .prepare("SELECT * FROM bookings WHERE day=? AND member_id=?")
          .get(day, me.id);
        const note = body.note === undefined ? existing?.note || "" : body.note;
        const noNegotiation =
          body.noNegotiation === undefined
            ? !!existing?.no_negotiation
            : body.noNegotiation;
        if (typeof note !== "string" || note.length > 300)
          fail(400, "備考は300文字以内で入力してください。");
        if (typeof noNegotiation !== "boolean")
          fail(400, "時間変更の相談について選択し直してください。");
        if (existing && slotDate(day, existing.start) <= now())
          fail(409, "開始済みの予約は変更できません。");
        const turn = currentTurn(day);
        if (!existing && turn !== me.id)
          fail(
            403,
            "まだ予約の順番ではありません。前の人の予約を待ってください。",
          );
        try {
          db.prepare(
            "INSERT INTO bookings(day,member_id,start,duration,note,no_negotiation) VALUES (?,?,?,?,?,?) ON CONFLICT(day,member_id) DO UPDATE SET start=excluded.start,duration=excluded.duration,note=excluded.note,no_negotiation=excluded.no_negotiation,auto_confirmed=0",
          ).run(
            day,
            me.id,
            start,
            duration,
            note.trim(),
            noNegotiation ? 1 : 0,
          );
        } catch (error) {
          if (String(error).includes("booking_overlap"))
            fail(
              409,
              "ほかの人の予約と重なっています。別の時刻を選んでください。",
            );
          throw error;
        }
        db.prepare("DELETE FROM wishes WHERE day=? AND member_id=?").run(
          day,
          me.id,
        );
        enqueueTurn(day, turn);
        return send(200, { ok: true });
      }
      if (req.method === "POST" && url.pathname === "/api/cancel") {
        const day = validDay(body.day);
        const booking = db
          .prepare("SELECT * FROM bookings WHERE day=? AND member_id=?")
          .get(day, me.id);
        if (!booking) fail(404, "予約はありません。");
        if (slotDate(day, booking.start) <= now())
          fail(409, "開始済みの予約は取り消せません。");
        const previousTurn = currentTurn(day);
        db.prepare("DELETE FROM bookings WHERE day=? AND member_id=?").run(
          day,
          me.id,
        );
        enqueueTurn(day, previousTurn);
        return send(200, { ok: true });
      }
      fail(404, "ページが見つかりません。");
    } catch (error) {
      if (!error.status) console.error(error);
      send(error.status || 500, {
        error: error.status
          ? error.message
          : "サーバーでエラーが起きました。もう一度お試しください。",
      });
    }
  }
  reminders.restore();
  return {
    ...createAdminData({db,setFamilyPassword,getSettings:serverSettings.get,onNotificationsChanged:onNotificationQueued}),
    handle,
    getDashboard: () => {
      const time=currentTime(),day=time.activeDay;
      return {day,now:now().toISOString(),settings:scheduleForDay(day),members:allMembers(false).map(({id,name,active,emoji,color})=>({id,name,active,emoji,color})),
        bookings:db.prepare("SELECT member_id AS memberId,start,duration FROM bookings WHERE day=? ORDER BY start").all(day),
        wishes:db.prepare("SELECT member_id AS memberId,start,duration FROM wishes WHERE day=? ORDER BY start,member_id").all(day),
        skips:db.prepare("SELECT member_id FROM bath_skips WHERE day=?").all(day).map(r=>r.member_id)};
    },
    getServerSettings: serverSettings.get,
    saveServerSettings: (payload) => {
      const time = currentTime();
      const days = [time.today, time.yesterday];
      const before = days.map(currentTurn);
      const result = serverSettings.save(payload);
      days.forEach((day, i) => enqueueTurn(day, before[i]));
      onNotificationQueued();
      return result;
    },
    flushNotifications,
    notificationDueAt: () =>
      db
        .prepare("SELECT MIN(due) AS due FROM (SELECT MIN(next_attempt) AS due FROM notification_queue UNION ALL SELECT MIN(next_attempt) AS due FROM booking_reminders WHERE sent=0)")
        .get().due,
    setFamilyPassword,
    familyConfigured: () => !!familyConfig().password_hash,
    accessToken: () => familyConfig().access_token,
    close: () => {
      closed = true;
      db.close();
    },
  };
}
