import {
  renderProfilePicker,
  initializeProfilePicker,
} from "./profile-picker.js";
import {
  scheduleSegments,
  quarterTicks,
  overlapDetails,
} from "./schedule-layout.js";
const root = document.querySelector("#app");
const dialog = document.querySelector("#booking-dialog");
const toast = document.querySelector("#toast");
let state,
  members = [],
  me = null,
  selectedDay,
  selectedMember,
  refreshing = null,
  busy = false,
  lastSignature = "";
let pageView = "home",
  pendingItem = null,
  stampWeek = null,
  celebrationWeek = null;
const celebrating = new Set();
let guidePending = false;
let accountGeneration = 0;
let checkRebookingOnOpen = true, rebookingQuestion = null, rebookingFlow = false;
async function openClientGuide(topic, onboarding = false) {
  if (guidePending) return;
  guidePending = true;
  try {
    const { openGuide } = await import("./help.js");
    await openGuide(topic, { onboarding, rules: state?.rewards?.settings });
  } catch (error) {
    notify(error.message);
  } finally {
    guidePending = false;
    maybeCelebrate();
  }
}
const helpButton = (topic, label) =>
  `<button type="button" class="help-button" data-guide="${topic}" aria-label="${label}">?</button>`;
document.addEventListener("click", (event) => {
  const button = event.target.closest("[data-guide]");
  if (button) void openClientGuide(button.dataset.guide);
});

const itemName = (kind) =>
  ({
    skip: "順番抜かしチケット",
    extend: "時間延長チケット",
    boost: "抽選確率UPチケット",
    guard: "順番抜かしガード",
    bathStamp: "おふろスタンプ",
    stampInk: "スタンプのインク",
  })[kind] || "";
const itemIcon = (kind) =>
  ["skip", "extend", "boost", "guard", "bathStamp", "stampInk"].includes(kind)
    ? `<img class="item-art" src="/items/${kind}.svg" alt="" aria-hidden="true" width="80" height="64">`
    : "🎁";
const itemUnit = (kind) =>
  ["bathStamp", "stampInk"].includes(kind) ? "個" : "枚";
const owned = (kind) =>
  state.rewards?.wallet.find((x) => x.kind === kind)?.quantity || 0;
let familyAuthenticated = false;
let notificationStatus = "未設定";
let previousTurn = null;
let passkeyList = null;
const requestedDay = new URLSearchParams(location.search).get("day");
if (requestedDay && /^\d{4}-\d{2}-\d{2}$/.test(requestedDay))
  selectedDay = requestedDay;
const icon = (name) => {
  const paths = {
    arrow: '<path d="M5 12h14m-5-5 5 5-5 5"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    check: '<path d="m5 12 4 4L19 6"/>',
    close: '<path d="m6 6 12 12M6 18 18 6"/>',
    shuffle:
      '<path d="M3 6h3c5 0 7 12 12 12h3m-4-4 4 4-4 4M3 18h3c2 0 4-3 6-6s4-6 6-6h3m-4-4 4 4-4 4"/>',
    edit: '<path d="m15 4 5 5M4 16 16 4a2 2 0 0 1 4 4L8 20l-5 1z"/>',
    bath: '<path d="M3 12h18v3a6 6 0 0 1-6 6H9a6 6 0 0 1-6-6zM5 12V5a3 3 0 0 1 6 0M6 21v1m12-1v1m-7-17h3"/>',
  };
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name]}</svg>`;
};
const escapeHTML = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ],
  );
const memberName = (id) => members.find((m) => m.id === id)?.name || "";
const avatar = (id, small = false) => {
  const member = members.find((m) => m.id === id);
  return `<span class="avatar ${small ? "small" : ""}" data-avatar-member="${id}" aria-hidden="true">${escapeHTML(member?.emoji || "?")}</span>`;
};
function applyMemberColors(container) {
  const colorFor = (id) => {
    const color = members.find((m) => m.id === Number(id))?.color;
    return /^#[0-9a-f]{6}$/i.test(color || "") ? color : "#c5c9c1";
  };
  const tint = (hex, strength) =>
    "#" +
    [1, 3, 5]
      .map((index) =>
        Math.round(
          parseInt(hex.slice(index, index + 2), 16) * strength +
            255 * (1 - strength),
        )
          .toString(16)
          .padStart(2, "0"),
      )
      .join("");
  container
    .querySelectorAll("[data-avatar-member]")
    .forEach(
      (node) =>
        (node.style.backgroundColor = colorFor(node.dataset.avatarMember)),
    );
  container.querySelectorAll("[data-tint-member]").forEach((node) => {
    const color = colorFor(node.dataset.tintMember);
    node.style.backgroundColor = tint(
      color,
      node.classList.contains("tentative") ? 0.1 : 0.3,
    );
    if (node.classList.contains("tentative"))
      node.style.borderColor = tint(color, 0.7);
  });
}
const itemsEnabled = () => state?.rewards?.settings?.itemsEnabled !== false;
function giftBadge() {
  if (!itemsEnabled()) return "";
  const n = state?.rewards?.pendingGifts || 0;
  return n
    ? `<span class="gift-badge" aria-label="未受取のプレゼント ${n}件">${n > 99 ? "99+" : n}</span>`
    : "";
}
function renderHeaderAccount() {
  const account = document.querySelector("#header-account");
  const menuOpen = !!account.querySelector("details")?.open;
  const showGiftNotice =
    itemsEnabled() &&
    !!me &&
    state?.rewards?.pendingGifts > 0 &&
    !["gifts", "history"].includes(pageView);
  document
    .querySelector(".site-header")
    .classList.toggle("has-gift-callout", showGiftNotice);
  account.classList.toggle("menu-open", menuOpen);
  account.hidden = !me;
  account.innerHTML = me
    ? `<details class="account-menu" ${menuOpen ? "open" : ""}><summary class="profile-button" aria-label="${menuOpen ? "メニューを閉じる" : "メニューを開く"}">${avatar(me.id, true)}<span class="profile-identity"><span class="profile-name">${escapeHTML(me.name)}</span><small>メニュー <span class="menu-glyph"><span class="menu-icon" aria-hidden="true"><span class="menu-line"></span><span class="menu-line"></span></span>${itemsEnabled() && state?.rewards?.pendingGifts ? '<span class="menu-notice" aria-label="未受取のプレゼントがあります">*</span>' : ""}</span></small></span></summary><nav aria-label="メニュー">${[
        ["home", "ホーム"],
        ["reserve", "おふろを予約する"],
        ["gifts", "プレゼントボックス"],
        ["inventory", "持ち物"],
        ["stamps", "スタンプカード"],
        ["settings", "設定"],
        ["help", "ヘルプ"],
      ]
        .map(
          ([key, label]) =>
            `<button data-action="nav-${key}">${label}${key === "gifts" ? giftBadge() : ""}</button>`,
        )
        .join(
          "",
        )}</nav></details>${showGiftNotice ? '<button class="gift-callout" data-action="nav-gifts" aria-label="プレゼントが届いています。プレゼントボックスを開く"><span aria-hidden="true">📦</span><span>プレゼントが届いています。</span></button>' : ""}`
    : "";
  if (me) applyMemberColors(account);
}
const time = (minute) =>
  `${minute >= 2880 ? "翌々" : minute >= 1440 ? "翌" : ""}${String(Math.floor(minute / 60) % 24).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
const dateLabel = (day) =>
  new Intl.DateTimeFormat("ja-JP", {
    month: "long",
    day: "numeric",
    weekday: "short",
    timeZone: "Asia/Tokyo",
  }).format(new Date(`${day}T12:00:00+09:00`));
const slotDate = (minute) =>
  new Date(new Date(`${state.day}T00:00:00+09:00`).getTime() + minute * 60000);
const serverNow = () => new Date(state.now);
const activeMembers = () => members.filter((member) => member.active !== 0);
const activeMember = (id) =>
  members.some((member) => member.id === id && member.active !== 0);
const durationValues = () =>
  Array.from(
    {
      length:
        1 +
        (state.settings.maxDuration - state.settings.minDuration) /
          state.settings.step,
    },
    (_, i) => state.settings.minDuration + i * state.settings.step,
  );
const selectedDuration = () =>
  Number(
    dialog.querySelector('[name="duration"]:checked,select[name="duration"]')
      .value,
  );

const ownBooking = () => state?.bookings.find((b) => b.memberId === me.id);
const ownWish = () => state?.wishes.find((w) => w.memberId === me.id);
const isDeferred = () => state?.skips.includes(me.id) && !ownBooking();
const nextTurn = () =>
  state?.draw?.order.find(
    (id) => activeMember(id) && !state.bookings.some((b) => b.memberId === id),
  );
function notify(message) {
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(notify.timer);
  notify.timer = setTimeout(() => toast.classList.remove("show"), 4500);
}
async function api(path, data) {
  const generation = accountGeneration;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  const timeoutError = () => new Error("サーバーの応答に時間がかかっています。接続を確認し、もう一度お試しください。");
  try {
    let response;
    try {
      response = await fetch(`/api/${path}`, {
        signal: controller.signal,
        ...(data === undefined ? { cache: "no-store" } : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(data),
        }),
      });
    } catch {
      if (controller.signal.aborted) throw timeoutError();
      throw new Error("サーバーに接続できません。接続を確認してください。");
    }
    if (response.status === 401 && generation === accountGeneration && !["login", "register", "family/login", "passkey/auth/verify"].includes(path)) {
      me = null; state = null; resetNavigation(); selectedMember = null; void init();
    }
    let result;
    try { result = await response.json(); }
    catch {
      if (controller.signal.aborted) throw timeoutError();
      throw Object.assign(new Error("サーバーの応答を読み込めませんでした。接続を確認して、もう一度お試しください。"), { status: response.status });
    }
    if (!response.ok) throw Object.assign(new Error(typeof result?.error === "string" ? result.error : "読み込みに失敗しました。"), { status: response.status });
    return result;
  } finally { clearTimeout(timer); }
}

function renderFamily(configured = true) {
  renderHeaderAccount();
  root.removeAttribute("aria-busy");
  root.innerHTML = `<section class="welcome"><div class="eyebrow">JUST FOR OUR FAMILY</div><h1>おかえりなさい。<br>家族の合い言葉は？</h1><p>ここは、わが家専用のおふろ予約。</p></section><section class="login-card family-card"><h2>まずは、家族の確認。</h2>${passkeyLoginButton()}${configured ? `<form id="family-form" class="login-form"><label for="family-password">家族みんなで使う合い言葉</label><input id="family-password" name="password" type="password" autocomplete="current-password" maxlength="128" required placeholder="家族の合い言葉"><p class="form-error" id="family-error" role="alert"></p><button class="primary" type="submit">家族のおふろへ${icon("arrow")}</button></form>` : '<p class="muted">家族の合い言葉を準備中です。準備ができてから、もう一度開いてください。</p><button class="primary" data-action="retry">もう一度読み込む</button>'}</section>`;
}
const passkeysSupported = () =>
  window.isSecureContext &&
  "PublicKeyCredential" in window &&
  !!navigator.credentials;
function passkeyLoginButton() {
  return passkeysSupported()
    ? '<button class="primary passkey-login" data-action="passkey-login">パスキーでログイン</button><p class="fine-print">登録済みなら、名前や合い言葉の入力は不要です。初めての方は下から設定してください。</p>'
    : "";
}
function passkeyCard(showConfigured = false) {
  if (state.passkeyCount && !showConfigured) return "";
  return `<aside class="passkey-card"><div><h3>${state.passkeyCount ? "パスキーで、かんたんログイン" : "次回からは、顔認証やPINで。"}</h3><p>${passkeysSupported() ? "初回だけ登録すれば、家族の合い言葉と個別パスワードの入力をまとめて省略できます。" : "パスキーはHTTPSの家族用リンクから登録できます。"}</p><small>${state.passkeyCount || 0}件のパスキーを登録済み</small></div>${passkeysSupported() ? '<button class="notification-button" data-action="passkey-register">パスキーを登録</button>' : ""}${state.passkeyCount ? '<button class="passkey-manage" data-action="passkey-manage">登録済みを確認・削除</button>' : ""}${passkeyList ? `<ul class="passkey-list">${passkeyList.map((p, i) => `<li><span>パスキー ${i + 1} · ${escapeHTML(p.createdAt.slice(0, 10))}</span><button data-action="passkey-remove" data-credential="${escapeHTML(p.id)}">削除</button></li>`).join("")}</ul>` : ""}</aside>`;
}
const fromBase64 = (value) =>
  Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), (c) =>
    c.charCodeAt(0),
  );
function toBase64(value) {
  if (!value) return null;
  let s = "";
  for (const byte of new Uint8Array(value)) s += String.fromCharCode(byte);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function credentialJSON(credential) {
  const response = credential.response;
  const result = {
    id: credential.id,
    rawId: toBase64(credential.rawId),
    type: credential.type,
    clientExtensionResults: credential.getClientExtensionResults(),
    authenticatorAttachment: credential.authenticatorAttachment || undefined,
    response: { clientDataJSON: toBase64(response.clientDataJSON) },
  };
  if (response.attestationObject) {
    result.response.attestationObject = toBase64(response.attestationObject);
    result.response.transports = response.getTransports?.() || [];
  } else {
    result.response.authenticatorData = toBase64(response.authenticatorData);
    result.response.signature = toBase64(response.signature);
    result.response.userHandle = toBase64(response.userHandle);
  }
  return result;
}
async function registerPasskey() {
  const options = await api("passkey/register/options", {});
  const publicKey = {
    ...options,
    challenge: fromBase64(options.challenge),
    user: { ...options.user, id: fromBase64(options.user.id) },
    excludeCredentials: options.excludeCredentials?.map((c) => ({
      ...c,
      id: fromBase64(c.id),
    })),
  };
  const credential = await navigator.credentials.create({ publicKey });
  if (!credential) throw new Error("パスキーの登録をキャンセルしました。");
  await api("passkey/register/verify", {
    response: credentialJSON(credential),
  });
  passkeyList = null;
  await refresh(true);
  notify(
    "パスキーを登録しました。次回から合い言葉や名前の入力を省略できます。",
  );
}
async function loginWithPasskey() {
  const options = await api("passkey/auth/options", {});
  const publicKey = {
    ...options,
    challenge: fromBase64(options.challenge),
    allowCredentials: options.allowCredentials?.map((c) => ({
      ...c,
      id: fromBase64(c.id),
    })),
  };
  const credential = await navigator.credentials.get({ publicKey });
  if (!credential) throw new Error("パスキーのログインをキャンセルしました。");
  const result = await api("passkey/auth/verify", {
    response: credentialJSON(credential),
  });
  me = result.me;
  familyAuthenticated = true;
  passkeyList = null;
  previousTurn = null;
  await init();
}
function notificationCard(showConfigured = false) {
  if (notificationStatus === "有効" && !showConfigured) return "";
  const ios =
    /iPhone|iPad|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const standalone =
    matchMedia("(display-mode: standalone)").matches || navigator.standalone;
  let help =
    "前の人が予約し終わると、この端末にお知らせします。希望の結果や、設定した分数前の入浴通知も受け取れます。";
  let action =
    '<button class="notification-button" data-action="enable-notifications">通知を受け取る</button>';
  if (ios && !standalone) {
    help =
      "iPhoneはSafariの共有 →「ホーム画面に追加」。追加したアプリで通知を許可してください。";
    action = "";
  } else if (
    !window.isSecureContext ||
    !("PushManager" in window) ||
    !("Notification" in window)
  ) {
    help =
      "アプリを開いている間は画面内でお知らせします。画面を閉じている間の通知にはHTTPSで開いてください。";
    action = "";
  } else if (Notification.permission === "denied") {
    help =
      "通知が許可されていません。端末の設定から、このアプリの通知を許可してください。";
    action = "";
  } else if (notificationStatus === "有効")
    action =
      '<button class="notification-button" data-action="disable-notifications">通知を止める</button>';
  return `<aside class="notification-card"><div><h3>おふろのお知らせ</h3><p>${help}</p><span id="notification-status">この端末：${notificationStatus}</span></div>${action}</aside>`;
}
function notificationPreferencesForm() {
  const settings = state.notificationPreferences || {};
  return `<form id="notification-preference-form" class="notification-preferences"><h3>通知の種類</h3>${[
    ["bookingDisplaced", "順番抜かしで予約が希望に戻った"],
    ["wishConfirmed", "事前希望が確定した"],
    ["wishUnconfirmed", "事前希望を確定できなかった"],
    ["reservationTurn", "予約の順番が回ってきた"],
    ["nudge", "つつかれた"],
    ["bathReminder", "入浴開始前のお知らせ"],
    ["timeSelectionReminder", "開始時刻を決めるお願い"],
    ["completionReminder", "予約終了時の完了報告のお知らせ"],
  ]
    .filter(([key]) => itemsEnabled() || key !== "bookingDisplaced")
    .map(
      ([key, label]) =>
        `<label class="notification-choice"><input type="checkbox" name="${key}" ${settings[key] !== false ? "checked" : ""}><span>${label}</span></label>`,
    )
    .join(
      "",
    )}<label class="reminder-minutes">入浴の何分前に通知するか<input type="number" name="reminderMinutes" min="1" max="180" step="1" required value="${Number(settings.reminderMinutes) || 10}"><span>分前</span></label><p class="muted">種類と分数は、自分の端末間で共通です。通知の許可は端末ごとに必要です。</p><button type="submit" class="primary">通知設定を保存</button><p class="form-error" role="alert"></p></form>`;
}
let autoEditWeekday = null,
  autoEditDirty = false;
const autoMode = (day) =>
  day.mode ||
  (day.enabled ? "reservation" : state.autoStandby ? "standby" : "disabled");
const clockValue = (minute) =>
  `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
function autoReservationEditor() {
  const day = state.autoWishes.days.find((d) => d.weekday === autoEditWeekday);
  const mode = autoMode(day),
    enabled = mode === "reservation";
  const durations = [...new Set([...durationValues(), day.duration])].sort(
    (a, b) => a - b,
  );
  return `<label>曜日<select name="weekday" aria-label="曜日">${state.autoWishes.days.map((d) => `<option value="${d.weekday}" ${d.weekday === autoEditWeekday ? "selected" : ""}>${"日月火水木金土"[d.weekday]}曜日</option>`).join("")}</select></label><label>設定内容<select name="mode" aria-label="設定内容"><option value="reservation" ${mode === "reservation" ? "selected" : ""}>予約する</option><option value="standby" ${mode === "standby" ? "selected" : ""}>入らない/様子見</option><option value="disabled" ${mode === "disabled" ? "selected" : ""}>未設定（無効）</option></select></label><div class="auto-reservation-fields" ${enabled ? "" : "hidden"}><div class="auto-wish-time"><label>開始時刻<input type="time" name="start" value="${clockValue(day.start)}" step="${state.settings.step * 60}" required ${enabled ? "" : "disabled"}></label><label>長さ<select name="duration" aria-label="長さ" ${enabled ? "" : "disabled"}>${durations.map((n) => `<option value="${n}" ${n === day.duration ? "selected" : ""}>${n}分</option>`).join("")}</select></label></div><label>備考<input name="note" type="text" maxlength="300" value="${escapeHTML(day.note)}" ${enabled ? "" : "disabled"}></label></div>`;
}
function autoWishesForm() {
  autoEditWeekday ??= new Date(state.today + "T12:00:00Z").getUTCDay();
  return `<section class="notification-preferences auto-reservation-settings"><div class="guide-heading">${helpButton("automation", "自動予約の使い方")}<h3>自動予約</h3></div><table class="auto-reservation-table" aria-label="現在の自動予約設定"><thead><tr><th scope="col">曜日</th><th scope="col">開始時刻</th><th scope="col">長さ</th></tr></thead><tbody>${state.autoWishes.days
    .map((d) => {
      const mode = autoMode(d);
      return `<tr><th scope="row">${"日月火水木金土"[d.weekday]}</th>${mode === "standby" ? '<td colspan="2" class="auto-standby-cell">入らない/様子見</td>' : mode === "disabled" ? '<td class="muted">−</td><td class="muted">−</td>' : `<td>${clockValue(d.start)}</td><td>${d.duration}分</td>`}</tr>`;
    })
    .join(
      "",
    )}</tbody></table><form id="auto-wishes-form"><div class="auto-reservation-editor">${autoReservationEditor()}</div><button class="primary" type="submit">設定する</button><p class="form-error" role="alert"></p></form></section>`;
}
root.addEventListener("input", (event) => {
  if (
    event.target.closest("#auto-wishes-form") &&
    event.target.name !== "weekday"
  )
    autoEditDirty = true;
});
root.addEventListener("change", (event) => {
  const form = event.target.closest("#auto-wishes-form");
  if (!form) return;
  if (event.target.name === "weekday") {
    autoEditWeekday = Number(event.target.value);
    autoEditDirty = false;
    form.querySelector(".auto-reservation-editor").innerHTML =
      autoReservationEditor();
    form.querySelector(".form-error").textContent = "";
  } else {
    autoEditDirty = true;
    if (event.target.name === "mode") {
      const enabled = event.target.value === "reservation",
        fields = form.querySelector(".auto-reservation-fields");
      fields.hidden = !enabled;
      fields
        .querySelectorAll("input,select")
        .forEach((input) => (input.disabled = !enabled));
      if (event.target.value === "standby") void openClientGuide("autoStandby");
    }
  }
});
root.addEventListener("submit", async (event) => {
  if (event.target.id !== "auto-wishes-form") return;
  event.preventDefault();
  if (busy) return;
  busy = true;
  const form = event.target,
    button = form.querySelector('[type="submit"]'),
    data = new FormData(form);
  button.disabled = true;
  try {
    const weekday = Number(data.get("weekday")),
      mode = data.get("mode");
    const current = state.autoWishes.days.find(day => day.weekday === weekday);
    const start = data.get("start")?.split(":");
    const day = {
      ...current,
      mode,
      enabled: mode === "reservation",
      start: start ? Number(start[0]) * 60 + Number(start[1]) : current.start,
      duration: Number(data.get("duration") ?? current.duration),
      note: data.get("note") ?? current.note,
    };
    await api("auto-wishes", { day });
    autoEditDirty = false;
    await refresh(true);
    notify("自動予約の設定を保存しました。");
  } catch (error) {
    form.querySelector(".form-error").textContent = error.message;
  } finally {
    busy = false;
    button.disabled = false;
  }
});

document
  .querySelector(".app-shell")
  .addEventListener("submit", async (event) => {
    if (event.target.id !== "notification-preference-form") return;
    event.preventDefault();
    if (busy) return;
    busy = true;
    const form = event.target,
      button = form.querySelector("[type=submit]");
    button.disabled = true;
    try {
      const data = new FormData(form),
        settings = { reminderMinutes: Number(data.get("reminderMinutes")) };
      for (const key of [
        "bookingDisplaced",
        "wishConfirmed",
        "wishUnconfirmed",
        "reservationTurn",
        "nudge",
        "bathReminder",
        "completionReminder",
        "timeSelectionReminder",
      ])
        settings[key] =
          key === "bookingDisplaced" && !itemsEnabled()
            ? state.notificationPreferences.bookingDisplaced
            : data.has(key);
      await api("notification-preferences", settings);
      await refresh(true);
      notify("通知設定を保存しました。");
    } catch (error) {
      form.querySelector(".form-error").textContent = error.message;
    } finally {
      busy = false;
      button.disabled = false;
    }
  });
async function syncNotifications() {
  if (
    !me ||
    !("serviceWorker" in navigator) ||
    !window.isSecureContext ||
    !("PushManager" in window)
  )
    return;
  try {
    const registration = await navigator.serviceWorker.register("/sw.js");
    await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();
    if (subscription && Notification.permission === "granted") {
      await api("push/subscribe", { subscription: subscription.toJSON() });
      notificationStatus = "有効";
    } else notificationStatus = "未設定";
    if (state) renderDashboard();
  } catch {
    notificationStatus = "接続を確認してください";
    if (state) renderDashboard();
  }
}
async function enableNotifications() {
  if (!("Notification" in window)) return;
  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    notificationStatus = "許可されていません";
    renderDashboard();
    return;
  }
  const registration = await navigator.serviceWorker.register("/sw.js");
  await navigator.serviceWorker.ready;
  const { publicKey } = await api("push/key");
  const padding = "=".repeat((4 - (publicKey.length % 4)) % 4);
  const raw = atob((publicKey + padding).replace(/-/g, "+").replace(/_/g, "/"));
  const key = Uint8Array.from(raw, (c) => c.charCodeAt(0));
  const subscription =
    (await registration.pushManager.getSubscription()) ||
    (await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: key,
    }));
  await api("push/subscribe", { subscription: subscription.toJSON() });
  notificationStatus = "有効";
  renderDashboard();
  notify("この端末で、予約する番をお知らせします。");
}
async function disableNotifications() {
  const registration = await navigator.serviceWorker.getRegistration();
  const subscription = await registration?.pushManager.getSubscription();
  if (subscription) {
    await api("push/unsubscribe", { endpoint: subscription.endpoint });
    await subscription.unsubscribe();
  }
  notificationStatus = "未設定";
  renderDashboard();
}
function renderLogin() {
  renderHeaderAccount();
  root.removeAttribute("aria-busy");
  if (!activeMembers().length) {
    root.innerHTML = `<section class="login-card"><h2>メンバーはまだ登録されていません</h2><p>サーバー操作画面の「設定」で、利用するメンバーを追加してください。</p><button class="primary" data-action="retry">もう一度読み込む</button></section>`;
    return;
  }

  root.removeAttribute("aria-busy");
  root.innerHTML = `<section class="welcome"><div class="eyebrow">A LITTLE ROUTINE, A BETTER EVENING</div><h1>おふろの順番、<br>気持ちよく決めよう。</h1><p>くじで順番を決めて、好きな時間を予約。<br>家族みんなの「次、だれ？」をひとつに。</p><div class="welcome-bath" aria-hidden="true">${icon("bath")}<span class="bubble one"></span><span class="bubble two"></span></div></section>
    <section class="login-card"><div class="section-label">はじめましょう<span>01 — WHO ARE YOU?</span></div><h2>あなたはだれ？</h2>${passkeyLoginButton()}<p class="muted">自分の名前を選んでください。</p><div class="member-grid">${activeMembers()
      .map(
        (m) =>
          `<button class="member-button ${selectedMember === m.id ? "selected" : ""}" data-member="${m.id}" aria-pressed="${selectedMember === m.id}">${avatar(m.id)}<strong>${escapeHTML(m.name)}</strong><span>${m.registered ? "ログイン" : "はじめて"}</span></button>`,
      )
      .join("")}</div><div id="login-fields"></div></section>`;
  applyMemberColors(root);
  if (selectedMember) renderLoginFields();
}
function renderLoginFields() {
  const m = members.find((m) => m.id === selectedMember);
  document.querySelector("#login-fields").innerHTML =
    `<form id="login-form" class="login-form"><div class="notice">${m.registered ? `${escapeHTML(m.name)}さん、おかえりなさい。` : `${escapeHTML(m.name)}さん専用のパスワードを決めましょう。`}<small>${m.registered ? "" : "自分の名前だけ設定してください。4文字以上で設定できます。"}</small></div><label for="password">${m.registered ? "パスワード" : "新しいパスワード"}</label><input id="password" name="password" type="password" autocomplete="${m.registered ? "current-password" : "new-password"}" minlength="4" maxlength="128" required placeholder="4文字以上">${m.registered ? "" : '<label for="password-confirm">もう一度入力</label><input id="password-confirm" name="confirm" type="password" autocomplete="new-password" minlength="4" maxlength="128" required placeholder="確認用パスワード">'}${m.registered ? "" : renderProfilePicker(m)}<label class="checkbox-label"><input type="checkbox" id="show-password">パスワードを表示</label><p class="form-error" id="login-error" role="alert"></p><button type="submit" class="primary">${m.registered ? "ログインする" : "パスワードを設定して、はじめる"}${icon("arrow")}</button></form>`;
  if (!m.registered)
    initializeProfilePicker(document.querySelector("#login-fields"));
}
const profileDialog = document.createElement("dialog");
profileDialog.className = "profile-dialog";
document.body.append(profileDialog);
function openProfile() {
  const member = members.find((m) => m.id === me.id) || {};
  profileDialog.innerHTML = `<form id="profile-form"><h2>自分のアイコン</h2>${renderProfilePicker(member)}<p class="form-error" role="alert"></p><button class="primary" type="submit">アイコンを保存</button><button type="button" class="cancel-booking" data-profile-close>閉じる</button></form>`;
  initializeProfilePicker(profileDialog);
  profileDialog.querySelector("[data-profile-close]").onclick = () =>
    profileDialog.close();
  profileDialog.showModal();
}
profileDialog.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (busy) return;
  busy = true;
  const button = profileDialog.querySelector("[type=submit]");
  button.disabled = true;
  try {
    const data = new FormData(event.target);
    await api("profile", {
      emoji: data.get("emoji"),
      color: data.get("color"),
    });
    profileDialog.close();
    await refresh(true);
    notify("アイコンを変更しました。");
  } catch (error) {
    profileDialog.querySelector(".form-error").textContent = error.message;
  } finally {
    busy = false;
    button.disabled = false;
  }
});
function refresh(force = false) {
  if (!me) return Promise.resolve();
  // Mutations and date changes must wait for their own fresh response.
  if (refreshing) return force ? refreshing.then(() => refresh(true)) : refreshing;
  refreshing = refreshOnce(force).finally(() => { refreshing = null; });
  return refreshing;
}
async function refreshOnce(force) {
  const account = me;
  let requestedDay = selectedDay;
  const currentRequest = () => account === me && requestedDay === selectedDay;
  try {
    let data;
    try {
      data = await api(`state${requestedDay ? `?day=${requestedDay}` : ""}`);
    } catch (error) {
      if (!currentRequest()) return;
      if (error.status !== 400 || !requestedDay) throw error;
      selectedDay = requestedDay = undefined;
      data = await api("state");
    }
    if (!currentRequest()) return;
    if (
      pageView === "stamps" &&
      stampWeek &&
      data.rewards.card.week !== stampWeek
    ) {
      const requestedWeek = stampWeek;
      const card = (await api("rewards?week=" + encodeURIComponent(requestedWeek))).card;
      if (!currentRequest() || pageView !== "stamps" || stampWeek !== requestedWeek) return;
      data.rewards.card = card;
    }
    const signature = JSON.stringify([
      data.day,
      data.today,
      data.dayAfterTomorrow,
      data.dayRollover,
      data.draw,
      data.bookings,
      data.wishes,
      data.skips,
      data.passkeyCount,
      data.me,
      data.members,
      data.settings,
      data.lotteryOpen,
      data.notificationPreferences,
      data.autoStandby,
      data.autoWishes,
      data.rewards,
      data.unreportedBooking,
      data.standbyWarning,
      data.ignoreLowerPriorityWishes,
      data.nightPlanning?.nightDeadline,
      Math.floor(new Date(data.now).getTime() / 60000),
    ]);
    if (data.me.id !== account.id) resetNavigation();
    const before = previousTurn;
    const previousDay = state?.day;
    const itemsWereEnabled = itemsEnabled();
    state = data;
    if (
      itemsWereEnabled &&
      !itemsEnabled() &&
      dialog.open &&
      ["item", "stamp-ink", "celebration", "booking", "wish", "rebook"].includes(
        dialog.dataset.mode,
      )
    ) {
      dialog.close();
      pendingItem = null;
      notify("設定が変更されました。もう一度開いてください。");
    }
    previousTurn =
      data.draw?.order.find(
        (id) =>
          data.members.some(
            (member) => member.id === id && member.active !== 0,
          ) && !data.bookings.some((b) => b.memberId === id),
      ) || null;
    if (
      previousDay === data.day &&
      data.notificationPreferences?.reservationTurn &&
      data.day <= data.today &&
      before !== null &&
      before !== previousTurn &&
      previousTurn === data.me.id
    )
      notify("予約する番です。好きな時間を選んでください。");
    members = data.members;
    me = data.me;
    selectedDay = data.day;
    if (
      !((guidePending || autoEditDirty) && pageView === "settings") &&
      (force || signature !== lastSignature) &&
      (force ||
        !document.activeElement?.closest(
          "#notification-preference-form, #auto-wishes-form",
        ))
    ) {
      renderDashboard();
      lastSignature = signature;
    }
    const connection = document.querySelector("#connection-status");
    if (connection) connection.textContent = "共有データを更新済み";
  } catch (error) {
    if (!currentRequest()) return;
    if (force) notify(error.message);
    const status = document.querySelector("#connection-status");
    if (status) status.textContent = "接続できません · サーバーと接続を確認";
  }
}
function renderDashboard() {
  if (pageView !== "home") return renderSecondaryPage();

  root.removeAttribute("aria-busy");
  const booking = ownBooking(),
    turn = nextTurn();
  const expired = slotDate(state.settings.bathEnd) <= serverNow();
  const canEdit = booking && slotDate(booking.start) > serverNow();
  const yourTurn = turn === me.id && !expired;
  const allBooked = state.draw && !turn;
  renderHeaderAccount();
  root.innerHTML = `  <div class="date-bar"><div><span class="date-caption">BATH DAY</span><h2>${dateLabel(state.day)}</h2><p>${time(state.settings.bathStart)} <span>—</span> ${time(state.settings.bathEnd)} <span class="jst">日本時間</span></p></div><div class="day-switch" aria-label="日付切り替え"><button data-day="${state.yesterday}" class="${state.day === state.yesterday ? "active" : ""}" aria-pressed="${state.day === state.yesterday}">昨日</button><button data-day="${state.today}" class="${state.day === state.today ? "active" : ""}" aria-pressed="${state.day === state.today}">今日</button><button data-day="${state.tomorrow}" class="${state.day === state.tomorrow ? "active" : ""}" aria-pressed="${state.day === state.tomorrow}">明日</button><button data-day="${state.dayAfterTomorrow}" class="${state.day === state.dayAfterTomorrow ? "active" : ""}" aria-pressed="${state.day === state.dayAfterTomorrow}">明後日</button></div></div>
  <div class="dashboard-grid"><div class="left-column"><section class="draw-card">${
    state.draw
      ? `
    <div class="card-title"><h2>予約の順番</h2><span class="badge">${icon("check")}${state.draw.mode === "fixed" ? "固定順" : "抽選済み"}</span></div><p class="muted">この順番で、お風呂の時間を選べます。</p><ol class="draw-list">${state.draw.order
      .map((id, index) => {
        const booked = state.bookings.some((b) => b.memberId === id);
        const skipped = state.skips.includes(id);
        const inactive = !activeMember(id);
        return `<li class="${turn === id && !expired && state.day <= state.today ? "current" : ""}"><span class="rank">${String(index + 1).padStart(2, "0")}</span>${avatar(id, true)}<span class="draw-member"><strong>${escapeHTML(memberName(id))}${id === me.id ? '<span class="you">あなた</span>' : ""}</strong>${itemsEnabled() && state.draw.boostedMemberIds?.includes(id) ? '<span class="draw-boost-badge"><img src="/items/boost.svg" width="20" height="16" alt="" aria-hidden="true">確率UP使用</span>' : ""}${renderNudge(id)}</span><span class="draw-status ${booked ? "done" : ""}">${inactive ? "利用停止" : booked ? `${icon("check")}予約済み` : skipped ? "入らない/様子見" : expired ? "受付終了" : state.day > state.today ? "当日から" : turn === id ? "選ぶ番" : "待機中"}</span></li>`;
      })
      .join(
        "",
      )}</ol>${state.settings.orderMode === "fixed" ? '<p class="fine-print">固定順は全端末で共通。「入らない/様子見」は末尾へ回ります。</p>' : ""}`
      : state.settings.orderMode === "fixed"
        ? '<h2>予約の順番</h2><p class="muted">固定順は当日に確定します。時刻の予約も当日からです。</p>'
        : `<div class="draw-illustration" aria-hidden="true">${icon("shuffle")}<span>?</span></div><h2>この日の順番、くじで決めよう。</h2><p class="muted">${activeMembers().length}人の予約する順番をランダムに決定。<br>だれか1人が引けば、みんなに共有されます。</p><button class="primary" data-action="draw" ${state.lotteryOpen ? "" : "disabled"}>${icon("shuffle")}${state.lotteryOpen ? "この日の順番を抽選する" : "抽選できる時間を待ってね"}</button><p class="fine-print">${icon("clock")}${state.settings.lotteryTimeRestricted ? `抽選できる時間：当日 ${time(state.settings.lotteryStart)}〜${time(state.settings.lotteryEnd)}（締切）` : "当日分を抽選できます（対象日のおふろ終了まで）"}</p>${state.settings.lotteryTimeRestricted && !state.lotteryOpen && state.day === state.today && state.minute >= state.settings.lotteryEnd ? '<p class="form-error">今日は抽選時間が終了しました。次は明日の抽選時間に操作してください。</p>' : ""}`
  }</section>${renderWishes()}${renderStampCard()}
  <aside class="rules-card"><span class="rules-icon">♨</span><div><h3>わが家のおふろルール</h3><p>1回 <strong>${state.settings.minDuration}〜${state.settings.maxDuration}分</strong>、${state.settings.step}分刻みで予約。<br>脱衣所に入ってから、出るまでの時間です。<br>1人1枠。予約後も、開始前なら変更できます。</p></div></aside></div>
  <div class="right-column">${renderBookingBanner(booking, turn, expired, canEdit)}
  <section class="schedule-card"><div class="card-title"><h2>スケジュール</h2><span class="count">${state.bookings.length} 人予約${state.skips.filter((id) => !state.bookings.some((b) => b.memberId === id)).length ? ` · ${state.skips.filter((id) => !state.bookings.some((b) => b.memberId === id)).length} 人様子見` : ""}</span></div><div id="connection-status" class="connection-status" role="status">共有データを更新済み</div><div class="schedule"><div class="timeline-label"><span class="timeline-dot"></span>${time(state.settings.bathStart)}<span>予約開始の区切り</span></div>${renderSchedule()}<div class="timeline-label end"><span class="timeline-dot"></span>${time(scheduleEnd())}</div></div></section></div></div>`;
  applyMemberColors(root);
  root.querySelectorAll("[data-top]").forEach((node) => {
    node.style.top = `${Number(node.dataset.top)}%`;
  });
  root.querySelectorAll("[data-left]").forEach((node) => {
    node.style.left = `${Number(node.dataset.left)}%`;
    node.style.width = `${Number(node.dataset.width)}%`;
  });
  root.querySelectorAll("[data-min-height]").forEach((node) => {
    node.style.minHeight = `${Number(node.dataset.minHeight)}px`;
  });
  queueMicrotask(maybeCelebrate);
}
function renderNudge(id) {
  const value = state.nudge;
  if (!value || value.memberId !== id || id === me.id) return "";
  const minutes = Math.max(
    1,
    Math.ceil((value.nextAllowedAt - serverNow().getTime()) / 60000),
  );
  const label = value.canNudge
    ? "つつく"
    : value.reason === "cooldown"
      ? "つつき済み"
      : value.reason === "notifications-off"
        ? "通知オフ"
        : "通知未設定";
  const title =
    value.reason === "cooldown"
      ? "つつけるのは1時間に1回までです。"
      : value.canNudge
        ? `${memberName(id)}さんに予約を促す通知を送ります。`
        : "通知を有効にしてもらってください。";
  return `<button class="nudge-button" data-action="nudge" data-nudge-member="${id}" aria-label="${escapeHTML(memberName(id) + "さん：" + label + (value.reason === "cooldown" ? `、あと${minutes}分` : ""))}" title="${escapeHTML(title)}" ${value.canNudge ? "" : "disabled"}>${label}${value.reason === "cooldown" ? `<small>あと${minutes}分</small>` : ""}</button>`;
}
function renderBookingBanner(booking, turn, expired, canEdit) {
  if (state.day > state.today)
    return `<section class="booking-banner"><div><h3>事前希望</h3><button class="primary" data-action="wish">${ownWish() ? "自分の希望を変更" : "希望を出す"}</button></div><div><h3>${state.day === state.tomorrow ? "明日" : "明後日"}の夜の予定</h3><p>希望は抽選前から出せます。抽選・予約は当日からです。日付は${time(state.dayRollover)}に切り替わります。</p>${isDeferred() ? "<p>入らない/様子見を共有済みです。</p>" : ""}<button class="skip-button" data-action="toggle-skip">${isDeferred() ? "通常の順番に戻す" : "入らない/様子見"}</button></div></section>`;
  const yourTurn = turn === me.id && !expired;
  let content;
  if (expired)
    content =
      '<span class="banner-symbol">☾</span><div><h3>この日のおふろは終了しました。</h3><p>今日のタブから次のおふろを確認できます。</p></div>';
  else if (booking)
    content = `${icon("check")}<div><span class="eyebrow">YOUR BATH TIME</span><h3>${time(booking.start)} <span>〜</span> ${time(booking.start + booking.duration)}</h3><p>${booking.automatic ? "自動予約" : booking.autoConfirmed ? "希望から自動確定" : "あなたの予約"} · ${booking.duration}分</p></div>${canEdit ? `<button class="primary" data-action="book" aria-label="自分の予約を変更">${icon("edit")}予約を変更</button>` : ""}`;
  else if (yourTurn)
    content = `${icon("bath")}<div><h3>${escapeHTML(me.name)}さん、選ぶ番です。</h3>${ownWish()?.start===null?`<p>${ownWish().duration}分・時刻未定</p>`:""}${isDeferred() ? "<p>末尾の順番が回ってきました。希望するなら予約できます。</p>" : ""}</div>`;
  else if (isDeferred())
    content = `${icon("clock")}<div><h3>入らない/様子見 · 順番は最後へ</h3><p>入らないと確定した扱いではありません。順番が来たら予約できます。</p>${state.standbyWarning ? `<p class="notice">${escapeHTML(state.standbyWarning.message)}</p>` : ""}</div>`;
  else
    content = `${icon("clock")}<div><h3>${!state.draw ? "まずは、今日の順番を抽選。" : !state.draw.order.includes(me.id) ? "次回の順番決定から参加できます。" : !turn ? "この日の予約がそろいました。" : `${escapeHTML(memberName(turn))}さんが選ぶ番です。`}</h3><p>予約や順番の変更は自動で更新されます。</p></div>`;
  const beforeTurn = !expired && !booking && !yourTurn;
  const completion =
    state.rewards.settings.clientReportEnabled === true &&
    booking &&
    !booking.completedAt &&
    slotDate(booking.start) <= serverNow() &&
    serverNow().getTime() <=
      slotDate(booking.start + booking.duration).getTime() +
        (state.rewards.settings.clientReportMinutes ?? 3) * 60000;
  return `<section class="booking-banner ${yourTurn ? "is-turn" : ""}">${content}${beforeTurn ? `<div class="preference-action"><h3>事前希望</h3>${ownWish() ? `<p>${ownWish().start===null ? `${ownWish().duration}分・時刻未定` : `${time(ownWish().start)}〜${time(ownWish().start + ownWish().duration)}`}</p>` : ""}<button class="primary" data-action="wish">${ownWish() ? "自分の希望を変更" : "希望を出す"}</button></div>` : ""}${completion ? '<button class="primary" data-action="complete-bath">完了を報告</button>' : booking?.completedAt ? "<p>入浴済み・完了報告済み</p>" : ""}${booking && state.unreportedBooking?.revision === booking.revision ? '<button class="primary" data-action="rebook">予約を取り直す</button>' : ""}${yourTurn ? `<button class="primary" data-action="book">時間を選ぶ${icon("arrow")}</button>` : ""}${!expired && (!booking || canEdit) ? `<button class="skip-button" data-action="toggle-skip">${isDeferred() ? "通常の順番に戻す" : "入らない/様子見"}</button>` : ""}</section>`;
}
function renderWishes() {
  return `<section class="wishes-card"><div class="card-title"><h2>みんなの希望</h2></div>${state.wishes.map(renderWish).join("")}${state.skips
    .filter((id) => !state.bookings.some((b) => b.memberId === id))
    .map(
      (id) =>
        `<div class="standby-wish">${avatar(id, true)}<span><strong>${escapeHTML(memberName(id))}</strong><small>入らない/様子見</small></span></div>`,
    )
    .join(
      "",
    )}${!state.wishes.length && !state.skips.length ? '<p class="empty-wish">まだ希望はありません。</p>' : ""}</section>`;
}
function renderWish(w) {
  if(w.start===null)return `<article class="wish-item untimed-wish"><div class="wish-person">${avatar(w.memberId,true)}<strong>${escapeHTML(memberName(w.memberId))}</strong><span>希望・未確定</span></div><div class="wish-time">${w.duration}分<small>時刻未定</small></div>${w.note?`<p class="booking-note">${escapeHTML(w.note)}</p>`:""}</article>`;
  const conflict =
    state.bookings.some(
      (b) => b.start < w.start + w.duration && b.start + b.duration > w.start,
    ) ||
    state.wishes.some(
      (other) =>
        other.memberId !== w.memberId &&
        other.start !== null &&
        other.start < w.start + w.duration &&
        other.start + other.duration > w.start,
    );
  return `<article class="wish-item"><div class="wish-person">${avatar(w.memberId, true)}<strong>${escapeHTML(memberName(w.memberId))}</strong><span>希望・未確定</span></div><div class="wish-time">${time(w.start)}〜${time(w.start + w.duration)}<small>${w.duration}分</small></div>${w.note ? `<p class="booking-note">${escapeHTML(w.note)}</p>` : ""}${conflict ? '<p class="wish-conflict">ほかの予約・希望と重なっています。</p>' : ""}</article>`;
}
const scheduleEnd = () =>
  Math.max(
    state.settings.bathEnd,
    ...state.bookings.map((b) => b.start + b.duration),
    ...state.wishes.filter(w=>w.start!==null).map((w) => w.start + w.duration),
  );
function renderSchedule() {
  const ruler = (segment) =>
    `<div class="quarter-ruler" aria-label="15分刻み">${quarterTicks(
      segment.start,
      segment.end,
    )
      .map(
        (minute) =>
          `<span class="${minute % 60 === 0 ? "whole-hour" : ""}" data-top="${((minute - segment.start) / (segment.end - segment.start)) * 100}">${time(minute)}</span>`,
      )
      .join("")}</div>`;
  const segments = scheduleSegments(
    state.bookings,
    state.settings.bathStart,
    scheduleEnd(),
    state.wishes,
  );
  const untimed=state.wishes.filter(w=>w.start===null);
  const untimedSummary=untimed.length?`<div class="untimed-plans"><strong>時刻未定</strong>${untimed.map(w=>`<span>${escapeHTML(memberName(w.memberId))} · ${w.duration}分</span>`).join("")}</div>`:"";
  return untimedSummary + (
    (!state.bookings.length && !state.wishes.some(w=>w.start!==null)
      ? '<p class="schedule-empty-hint">まだ予約はありません。</p>'
      : "") +
    segments
      .map((segment) => {
        if (segment.kind === "break")
          return `<div class="timeline-break" aria-label="${time(segment.start)}から${time(segment.end)}まで空き時間を省略"><strong>${time(segment.start)}</strong><svg viewBox="0 0 240 26" preserveAspectRatio="none" aria-hidden="true"><path d="M0 7 Q15 -3 30 7 T60 7 T90 7 T120 7 T150 7 T180 7 T210 7 T240 7 M0 20 Q15 10 30 20 T60 20 T90 20 T120 20 T150 20 T180 20 T210 20 T240 20"/></svg><strong>${time(segment.end)}</strong></div>`;
        const height = Math.max(
          segment.kind !== "free" ? 128 : 52,
          (segment.end - segment.start) * 4.8,
        );
        if (segment.kind === "free")
          return `<div class="timeline-segment free-segment" data-min-height="${height}">${ruler(segment)}<div class="free-interval">空いています</div></div>`;
        const card = (entry) => {
          const b = entry.booking,
            wish = entry.kind === "wish";
          const overlaps = overlapDetails(b, [
            ...state.bookings,
            ...state.wishes,
          ]);
          const current =
            !wish &&
            !b.completedAt &&
            slotDate(b.start) <= serverNow() &&
            slotDate(b.start + b.duration) > serverNow();
          const ended =
            !!b.completedAt || slotDate(b.start + b.duration) <= serverNow();
          return `<article class="reservation ${wish ? "tentative" : ""} ${overlaps.length ? "has-overlap" : ""} ${ended ? "ended" : ""}" data-tint-member="${b.memberId}"><div class="reservation-top"><span class="reservation-time">${time(b.start)}<span> — </span>${time(b.start + b.duration)}</span><span class="duration">${b.duration}分</span></div><div class="reservation-person">${avatar(b.memberId, true)}<strong>${escapeHTML(memberName(b.memberId))}</strong>${b.memberId === me.id ? '<span class="you">あなた</span>' : ""}${b.automatic ? '<span class="automatic-label">自動予約</span>' : ""}${wish ? '<span class="tentative-label">希望・未確定</span>' : b.autoConfirmed && !b.automatic ? '<span class="auto-confirmed-label">希望から自動確定</span>' : current ? '<span class="bathing">入浴の時間</span>' : ended ? '<span class="bathing">終了</span>' : ""}</div>${overlaps.length ? `<p class="schedule-conflict"><strong>重なりあり</strong>${overlaps.map((o) => `${escapeHTML(memberName(o.memberId))} · ${time(o.start)}〜${time(o.end)}`).join("<br>")}</p>` : ""}${itemsEnabled() && b.ticket ? `<span class="ticket-label">${escapeHTML(itemName(b.ticket))}</span>` : ""}${b.note ? `<p class="booking-note">${escapeHTML(b.note)}</p>` : ""}${!wish && b.noNegotiation ? '<div class="no-negotiation">時間変更不可</div>' : ""}</article>`;
        };
        const entries = segment.entries || [segment];
        const overview =
          entries.length > 1
            ? `<div class="overlap-overview"><div class="overlap-axis"><span>${time(segment.start)}</span><span>${time(segment.end)}</span></div>${entries.map((e) => `<div class="overlap-row"><span>${escapeHTML(memberName(e.booking.memberId))}</span><div class="overlap-track"><span class="overlap-bar ${e.kind === "wish" ? "wish-bar" : ""}" data-left="${((e.start - segment.start) / (segment.end - segment.start)) * 100}" data-width="${((e.end - e.start) / (segment.end - segment.start)) * 100}"></span></div></div>`).join("")}</div>`
            : "";
        return `<div class="timeline-segment ${segment.kind === "overlap" ? "overlapping-plans" : ""}" data-min-height="${height}">${ruler(segment)}<div class="plan-cards">${entries.length > 1 ? '<p class="overlap-caption">時間帯が重なる予約・希望</p>' : ""}${overview}${entries.map(card).join("")}</div></div>`;
      })
      .join("")
  );
}
function available(start, duration) {
  return (
    start < state.settings.bathEnd &&
    slotDate(start) > serverNow() &&
    !state.bookings.some(
      (b) =>
        b.memberId !== me.id &&
        (pendingItem !== "skip" || b.ticket === "guard") &&
        b.start < start + duration &&
        b.start + b.duration > start,
    )
  );
}
function openBooking(mode = "booking") {
  if (!itemsEnabled())
    pendingItem = mode === "booking" ? ownBooking()?.ticket || null : null;
  const isWish = mode === "wish", isRebooking = mode === "rebook";
  const originalBooking = ownBooking();
  const booking = isRebooking ? null : originalBooking, wish = isRebooking ? null : ownWish();
  const entry = isRebooking ? originalBooking : isWish ? wish : booking || wish;
  const canShareDuration=!booking&&!isRebooking;
  if (isRebooking) dialog.dataset.rebookRevision = originalBooking.revision;
  else delete dialog.dataset.rebookRevision;
  const extra =
    pendingItem === "extend"
      ? booking?.ticketExtension ||
        Math.floor(
          state.rewards.settings.extensionMinutes / state.settings.step,
        ) * state.settings.step
      : 0;
  const durations = Array.from(
    {
      length:
        1 +
        Math.floor(
          (Math.min(1440, state.settings.maxDuration + extra) -
            state.settings.minDuration) /
            state.settings.step,
        ),
    },
    (_, i) => state.settings.minDuration + i * state.settings.step,
  );
  const initialDuration =
    (durations.includes(entry?.duration) ? entry.duration : null) || (durations.includes(30) ? 30 : durations[0]);
  dialog.dataset.mode = mode;
  dialog.innerHTML = `<div class="sheet-handle" aria-hidden="true"></div><div class="sheet-heading"><div><div class="eyebrow">${isWish ? "LET YOUR FAMILY KNOW" : "YOUR LITTLE BREAK"}</div><h2 id="booking-title">${isWish ? "先に、希望を伝えよう。" : isRebooking ? "おふろを予約し直す" : booking ? "おふろの時間を変更" : "何時に、あたたまる？"}</h2></div><button class="icon-button" data-action="close" aria-label="閉じる">${icon("close")}</button></div><p class="muted">${dateLabel(state.day)} · ${isWish ? "希望は家族みんなに共有されます。時刻を指定した希望は、順番が来て重なりがなければ自動で確定します。" : canShareDuration ? "開始時刻と長さ、または長さだけを共有できます。" : "脱衣所に入る時刻を選んでください。"}</p>${
    !isWish && state.wishes.some((w) => w.memberId !== me.id)
      ? `<details class="other-wishes"><summary>ほかの人の希望を確認する</summary>${state.wishes
          .filter((w) => w.memberId !== me.id)
          .map((w) => renderWish(w))
          .join("")}</details>`
      : ""
  }${isRebooking && itemsEnabled() && originalBooking?.ticket ? '<p class="fine-print">元の予約で使ったアイテムは戻りません。新しい予約に使う場合は、別のアイテムが必要です。</p>' : ""}${itemsEnabled() && pendingItem ? `<p class="selected-ticket">${escapeHTML(itemName(pendingItem))}を使用${pendingItem === "skip" ? "：重なる予約は事前希望に戻ります。" : ""}</p>` : ""}<form id="booking-form">${ticketSelect()}${ticketLimits(pendingItem || booking?.ticket)}<fieldset class="duration-fieldset"><legend>おふろに使う時間</legend><div class="duration-options">${durations.length > 12 ? `<select name="duration" aria-label="おふろに使う時間">${durations.map((d) => `<option value="${d}" ${initialDuration === d ? "selected" : ""}>${d}分</option>`).join("")}</select>` : durations.map((d) => `<label><input type="radio" name="duration" value="${d}" ${initialDuration === d ? "checked" : ""}><span>${d}<small>分</small></span></label>`).join("")}</div></fieldset><label for="start">${isWish||canShareDuration ? "希望する開始時刻" : "脱衣所に入る時刻"}</label>${canShareDuration?`<label class="checkbox-label untimed-choice"><input type="checkbox" name="untimed" ${entry?.start===null?"checked":""}><span>時刻は決めない</span></label>`:""}<select id="start" name="start" required></select><div class="end-summary">${icon("clock")}<span>出る時刻</span><strong id="end-time"></strong></div><p class="fine-print">着替えの時間も含めてください。</p><label for="booking-note">${isWish ? "希望の理由" : "備考"} <span class="optional">任意・300文字まで</span></label><textarea id="booking-note" name="note" maxlength="300" rows="3" placeholder="例：明日は出張で早起きなので、この時間に入りたいです。">${escapeHTML(entry?.note || "")}</textarea>${isWish ? "" : `<label class="checkbox-label negotiation-choice"><input type="checkbox" name="noNegotiation" ${(isRebooking ? entry?.noNegotiation : booking?.noNegotiation) ? "checked" : ""}><span>時間変更不可</span></label>`}<p class="fine-print">${isWish ? "時刻付きの希望は、重なっている時間にも出せます。時刻未定の希望は自動確定しません。" : "備考と選択内容は、家族みんなに表示されます。"}</p><p class="form-error" id="booking-error" role="alert"></p><button type="submit" class="primary" id="save-booking">${isWish ? "この希望を家族に共有する" : booking ? "この時間に変更する" : "この時間で予約する"}${icon("check")}</button>${isWish ? `<button type="button" class="skip-button" data-action="wish-standby">${isDeferred() ? "通常の順番に戻す" : "入らない/様子見を伝える"}</button>` : ""}${!booking && wish ? '<button type="button" class="cancel-booking" data-action="cancel-wish">希望を取り消す</button>' : !isWish && booking ? '<button type="button" class="cancel-booking" data-action="cancel">この予約を取り消す</button>' : ""}</form>`;
  dialog.querySelector("#save-booking").dataset.timedLabel=dialog.querySelector("#save-booking").textContent.trim();
  updateSlots(entry?.start);
  applyMemberColors(dialog);
  dialog.showModal();
}
function ticketSlotAllowed(start, duration) {
  const kind =
    pendingItem ||
    (dialog.dataset.mode === "booking" ? ownBooking()?.ticket : null);
  if (!["extend", "skip"].includes(kind)) return true;
  const existing = ownBooking();
  if (
    dialog.dataset.mode === "booking" &&
    existing?.ticket === kind &&
    existing.start === start &&
    existing.duration === duration
  )
    return true;
  const config = state.rewards.settings;
  const lead =
    kind === "extend"
      ? config.extensionNoticeMinutes
      : config.skipNoticeMinutes;
  if (lead > 0 && slotDate(start) - serverNow() <= lead * 60000) return false;
  if (kind === "extend" && config.extensionBlocked) {
    for (
      let offset = Math.floor(start / 1440) - 1;
      offset <= Math.floor((start + duration) / 1440);
      offset++
    ) {
      const from = offset * 1440 + config.extensionBlockedStart;
      const to =
        offset * 1440 +
        config.extensionBlockedEnd +
        (config.extensionBlockedEnd < config.extensionBlockedStart ? 1440 : 0);
      if (start < to && start + duration > from) return false;
    }
  }
  return true;
}
function ticketLimits(kind) {
  if (!itemsEnabled()) return "";
  if (!["extend", "skip"].includes(kind)) return "";
  const config = state.rewards.settings;
  const lead =
    kind === "extend"
      ? config.extensionNoticeMinutes
      : config.skipNoticeMinutes;
  const lines = [];
  if (kind === "extend" && config.extensionBlocked) {
    const clock = (n) =>
      `${String(Math.floor(n / 60)).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}`;
    lines.push(
      `${clock(config.extensionBlockedStart)}〜${clock(config.extensionBlockedEnd)}に重なる予約には使えません。`,
    );
  }
  if (lead > 0) lines.push(`開始まで${lead}分以下の予約には使えません。`);
  return lines.length
    ? `<p class="ticket-limits">${lines.join("<br>")}</p>`
    : "";
}
function updateSlots(preferred) {
  const select = document.querySelector("#start");
  const duration = selectedDuration();
  const untimed=!!dialog.querySelector('[name="untimed"]:checked');
  select.required=!untimed;
  select.hidden=untimed;
  dialog.querySelector('.end-summary').hidden=untimed;
  const negotiation=dialog.querySelector('.negotiation-choice');if(negotiation)negotiation.hidden=untimed;
  const save=dialog.querySelector('#save-booking');
  save.innerHTML=(untimed?'使う時間を共有する':save.dataset.timedLabel)+icon('check');
  if(untimed){select.disabled=true;save.disabled=false;return;}
  const previous = preferred ?? Number(select.value);
  let html = "",
    values = [];
  for (
    let start = state.settings.bathStart;
    start < state.settings.bathEnd;
    start += state.settings.step
  ) {
    if (!ticketSlotAllowed(start, duration)) continue;
    if (
      dialog.dataset.mode === "wish"
        ? start >= state.settings.bathEnd || slotDate(start) <= serverNow()
        : !available(start, duration)
    )
      continue;
    values.push(start);
    html += `<option value="${start}">${time(start)}</option>`;
  }
  select.innerHTML =
    html || '<option value="">予約できる空き時間がありません</option>';
  if (values.includes(previous)) select.value = String(previous);
  select.disabled = !values.length;
  document.querySelector("#save-booking").disabled = !values.length;
  updateEndTime();
}
function updateEndTime() {
  const start = document.querySelector("#start");
  const duration = selectedDuration();
  document.querySelector("#end-time").textContent = start.value
    ? time(Number(start.value) + duration)
    : "—";
}
document
  .querySelector(".app-shell")
  .addEventListener("click", async (event) => {
    const memberButton = event.target.closest("[data-member]");
    if (memberButton) {
      selectedMember = Number(memberButton.dataset.member);
      renderLogin();
      return;
    }
    const dayButton = event.target.closest("[data-day]");
    if (dayButton) {
      selectedDay = dayButton.dataset.day;
      await refresh(true);
      return;
    }
    const action = event.target.closest("[data-action]")?.dataset.action;
    if (busy) return;
    if (action === "nudge") {
      busy = true;
      const button = event.target.closest("[data-nudge-member]");
      button.disabled = true;
      try {
        await api("nudge", {
          day: state.day,
          memberId: Number(button.dataset.nudgeMember),
        });
        notify("つつきました。");
      } catch (error) {
        notify(error.message);
      } finally {
        busy = false;
        await refresh(true);
      }
      return;
    }
    if (await handleRewardsAction(action, event)) return;
    if (action === "retry") return void init();
    if (
      [
        "passkey-login",
        "passkey-register",
        "passkey-manage",
        "passkey-remove",
      ].includes(action)
    ) {
      if (
        action === "passkey-remove" &&
        !confirm(
          "このパスキーを削除しますか？端末のパスキー管理からも必要に応じて削除してください。",
        )
      )
        return;
      const accountId = me?.id, generation = accountGeneration;
      const stillSameAccount = () => accountId === me?.id && generation === accountGeneration;
      busy = true;
      try {
        if (action === "passkey-login") await loginWithPasskey();
        if (action === "passkey-register") await registerPasskey();
        if (action === "passkey-manage") {
          const credentials = (await api("passkey/list")).credentials;
          if (!stillSameAccount()) return;
          passkeyList = credentials;
          renderDashboard();
        }
        if (action === "passkey-remove") {
          await api("passkey/remove", {
            id: event.target.closest("[data-credential]").dataset.credential,
          });
          if (!stillSameAccount()) return;
          const credentials = (await api("passkey/list")).credentials;
          if (!stillSameAccount()) return;
          passkeyList = credentials;
          await refresh(true);
        }
      } catch (error) {
        notify(
          error.name === "NotAllowedError"
            ? "パスキーの操作を中止しました。準備ができたらもう一度お試しください。"
            : error.message,
        );
      } finally {
        busy = false;
      }
      return;
    }
    if (action === "profile-edit") {
      openProfile();
      return;
    }
    if (action === "copy-link") {
      try {
        await navigator.clipboard.writeText(state.shareUrl);
        notify("家族用リンクをコピーしました。");
      } catch {
        prompt("このリンクを家族に共有してください。", state.shareUrl);
      }
      return;
    }
    if (
      action === "enable-notifications" ||
      action === "disable-notifications"
    ) {
      busy = true;
      try {
        await (action === "enable-notifications"
          ? enableNotifications()
          : disableNotifications());
      } catch (error) {
        notify(error.message);
      } finally {
        busy = false;
      }
      return;
    }
    if (action === "book") {
      pendingItem = ownBooking()?.ticket || null;
      return openBooking();
    }
    if (action === "wish") {
      pendingItem = ownWish()?.ticket || null;
      return openBooking("wish");
    }
    if (action === "toggle-skip") return toggleStandby();

    if (action === "logout") {
      busy = true;
      try {
        await api("logout", {});
        me = null;
        state = null;
        resetNavigation();
        selectedMember = null;
        selectedDay = undefined;
        renderLogin();
      } catch (error) {
        notify(error.message);
      } finally {
        busy = false;
      }
    }
    if (action === "draw") {
      busy = true;
      const button = event.target.closest("button");
      button.disabled = true;
      button.textContent = "順番を決めています…";
      try {
        await api("draw", { day: state.day });
        notify("今日の順番が決まりました。みんなに共有されます。");
      } catch (error) {
        notify(error.message);
      } finally {
        busy = false;
        await refresh(true);
      }
    }
  });
root.addEventListener("change", (event) => {
  if (event.target.id === "show-password")
    for (const input of root.querySelectorAll("#password,#password-confirm"))
      input.type = event.target.checked ? "text" : "password";
});
root.addEventListener("submit", async (event) => {
  if (event.target.id === "family-form") {
    event.preventDefault();
    if (busy) return;
    busy = true;
    const button = event.target.querySelector("button");
    button.disabled = true;
    try {
      await api("family/login", {
        password: new FormData(event.target).get("password"),
      });
      familyAuthenticated = true;
      await init();
    } catch (error) {
      const errorBox = document.querySelector("#family-error");
      if (errorBox) errorBox.textContent = error.message;
    } finally {
      busy = false;
      button.disabled = false;
    }
    return;
  }
  if (event.target.id !== "login-form") return;
  event.preventDefault();
  if (busy) return;
  const form = event.target,
    data = new FormData(form),
    m = members.find((m) => m.id === selectedMember);
  const errorBox = document.querySelector("#login-error");
  errorBox.textContent = "";
  if (!m.registered && data.get("password") !== data.get("confirm")) {
    errorBox.textContent = "パスワードが一致しません。";
    return;
  }
  busy = true;
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    const result = await api(m.registered ? "login" : "register", {
      memberId: m.id,
      password: data.get("password"),
      ...(!m.registered
        ? { profile: { emoji: data.get("emoji"), color: data.get("color") } }
        : {}),
    });
    me = result.me;
    previousTurn = null;
    if (!m.registered) guidePending = true;
    await refresh(true);
    if (!m.registered) {
      window.scrollTo(0, 0);
      guidePending = false;
      void openClientGuide("booking", true);
    }
    void syncNotifications();
  } catch (error) {
    errorBox.textContent = error.message;
  } finally {
    busy = false;
    button.disabled = false;
  }
});
dialog.addEventListener("change", (event) => {
  if (event.target.name === "duration") updateSlots();
  if (event.target.name === "start") updateEndTime();
});
dialog.addEventListener("click", async (event) => {
  const action = event.target.closest("[data-action]")?.dataset.action;
  if (action === "close" && !busy) dialog.close();
  if (action === "wish-standby" && !busy) {
    const wasDeferred = isDeferred();
    await toggleStandby();
    if (wasDeferred && dialog.open) dialog.close();
  }
  if (action === "cancel-wish" && !busy) {
    busy = true;
    try {
      await api("wish/cancel", { day: state.day });
      dialog.close();
      notify("希望を取り消しました。");
      await refresh(true);
    } catch (error) {
      dialog.querySelector("#booking-error").textContent = error.message;
    } finally {
      busy = false;
    }
    return;
  }
  if (
    action === "cancel" &&
    !busy &&
    confirm("予約を取り消しますか？予約する順番があなたに戻ります。")
  ) {
    busy = true;
    try {
      await api("cancel", { day: state.day });
      dialog.close();
      notify("予約を取り消しました。");
      await refresh(true);
    } catch (error) {
      dialog.querySelector("#booking-error").textContent = error.message;
    } finally {
      busy = false;
    }
  }
});
dialog.addEventListener("click", (event) => {
  const action = event.target.closest("[data-action]")?.dataset.action;
  if (["use-item", "apply-stamp", "stamp-week"].includes(action))
    void handleRewardsAction(action, event);
});
dialog.addEventListener("change", (event) => {
  if(event.target.name==='untimed'){updateSlots();return;}
  if (event.target.name === "ticket") {
    pendingItem = event.target.value || null;
    const mode = dialog.dataset.mode,
      values = new FormData(dialog.querySelector("form"));
    dialog.close();
    openBooking(mode);
    dialog.querySelector("[name=note]").value = values.get("note") || "";
    const duration = dialog.querySelector(
      `[name=duration][value="${values.get("duration")}"]`,
    );
    if (duration) duration.checked = true;
    const durationSelect = dialog.querySelector('select[name="duration"]');
    if (durationSelect && [...durationSelect.options].some(option => option.value === values.get("duration"))) durationSelect.value = values.get("duration");
    const untimed = dialog.querySelector('[name="untimed"]');
    if(untimed)untimed.checked=values.has('untimed');
    const negotiation = dialog.querySelector('[name="noNegotiation"]');
    if (negotiation) negotiation.checked = values.has("noNegotiation");
    updateSlots(Number(values.get("start")));
  }
});
dialog.addEventListener("cancel", (event) => {
  if (busy) event.preventDefault();
});
dialog.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (busy) return;
  busy = true;
  const form = new FormData(event.target),
    button = dialog.querySelector("#save-booking");
  button.disabled = true;
  try {
    const untimed=form.has('untimed');
    const result = await api(untimed||dialog.dataset.mode === "wish" ? "wish" : "book", {
      day: state.day,
      start: untimed?null:Number(form.get("start")),
      duration: Number(form.get("duration")),
      note: String(form.get("note") || ""),
      noNegotiation: form.get("noNegotiation") === "on",
      ticket: pendingItem,
      ...(dialog.dataset.mode === "rebook" ? { rebookRevision: dialog.dataset.rebookRevision } : {}),
    });
    dialog.close();
    pendingItem = null;
    notify(
      untimed ? "使う時間を共有しました。" : dialog.dataset.mode === "wish"
        ? result.autoConfirmed
          ? "希望が自動で確定しました。"
          : "希望を共有しました。"
        : "予約しました。のんびり、いいお湯を。",
    );
    await refresh(true);
  } catch (error) {
    dialog.querySelector("#booking-error").textContent = error.message;
  } finally {
    busy = false;
    button.disabled = false;
  }
});
async function init() {
  checkRebookingOnOpen = true;
  try {
    const family = await api("family");
    familyAuthenticated = family.authenticated;
    if (!familyAuthenticated) {
      me = null;
      state = null;
      resetNavigation();
      renderFamily(family.configured);
      return;
    }
    const data = await api("members");
    members = data.members;
    me = data.me;
    if (me) {
      await refresh(true);
      void syncNotifications();
    } else renderLogin();
  } catch (error) {
    root.innerHTML = `<section class="login-card"><h1>接続できませんでした。</h1><p>${escapeHTML(error.message)}</p><button class="primary" id="retry">もう一度読み込む</button></section>`;
    document.querySelector("#retry").addEventListener("click", init);
  }
}
await init();
let pollTimer;
function schedulePoll() {
  clearTimeout(pollTimer);
  if (document.visibilityState !== "visible") return;
  const complete = state?.draw && !nextTurn();
  const delay = complete
    ? 60000
    : state && (ownBooking() || isDeferred())
      ? 15000
      : 5000;
  pollTimer = setTimeout(async () => {
    await refresh();
    schedulePoll();
  }, delay);
}
schedulePoll();
document.addEventListener("visibilitychange", () => {
  clearTimeout(pollTimer);
  if (document.visibilityState === "visible") {
    checkRebookingOnOpen = true;
    void refresh(true).finally(schedulePoll);
  }
});
const installButton = document.querySelector("#install-help-button");
const installDialog = document.querySelector("#install-dialog");
function updateInstallGuide() {
  const ios =
    /iPhone|iPad|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const standalone =
    matchMedia("(display-mode: standalone)").matches || navigator.standalone;
  installButton.hidden = !ios || standalone;
}
installButton.addEventListener("click", () => installDialog.showModal());
document
  .querySelector("#install-help-close")
  .addEventListener("click", () => installDialog.close());
updateInstallGuide();
matchMedia("(display-mode: standalone)").addEventListener?.(
  "change",
  updateInstallGuide,
);

async function toggleStandby() {
  const skip = !isDeferred();
  const day = state.day;
  if (skip && !(await confirmStandby())) return;
  busy = true;
  try {
    await api("skip", { day, skip });
    notify(
      skip
        ? day > state.today
          ? "入らない/様子見を事前に共有しました。"
          : "入らない/様子見にして、順番の最後へ回りました。"
        : "通常の順番に戻しました。",
    );
    await refresh(true);
  } catch (error) {
    notify(error.message);
  } finally {
    busy = false;
  }
  return;
}
function confirmStandby() {
  const warning = state.standbyWarning;
  dialog.dataset.mode = "standby";
  dialog.innerHTML = `<div class="sheet-heading"><h2 id="booking-title">入らない/様子見にしますか？</h2><button class="icon-button" data-action="close" aria-label="閉じる">×</button></div><p>予約と希望がある場合は取り消し、順番の最後へ回ります。後で予約することもできます。</p>${warning ? `<p class="notice" role="alert">${escapeHTML(warning.message)}</p>` : ""}<button class="primary" data-standby-confirm>入らない/様子見にする</button><button class="cancel-booking" data-action="close">戻る</button>`;
  return new Promise((resolve) => {
    let accepted = false;
    const click = (event) => {
      if (event.target.closest("[data-standby-confirm]")) {
        accepted = true;
        dialog.close();
      }
    };
    dialog.addEventListener("click", click);
    dialog.addEventListener(
      "close",
      () => {
        dialog.removeEventListener("click", click);
        resolve(accepted);
      },
      { once: true },
    );
    if (!dialog.open) dialog.showModal();
  });
}
function ticketSelect() {
  if (!itemsEnabled()) return "";
  const existing = dialog.dataset.mode === "booking" ? ownBooking()?.ticket : null;
  return `<label>使うアイテム<select name="ticket" ${existing ? "disabled" : ""}><option value="">使わない</option>${[
    "skip",
    "extend",
    "guard",
  ]
    .filter(
      (k) =>
        (owned(k) > 0 || existing === k) &&
        (dialog.dataset.mode !== "wish" || k !== "skip"),
    )
    .map(
      (k) =>
        `<option value="${k}" ${pendingItem === k ? "selected" : ""}>${itemName(k)}（${owned(k)}枚）</option>`,
    )
    .join("")}</select></label>`;
}
function renderStampCard(compact = true) {
  const card = state.rewards?.card;
  if (!card) return "";
  const earned = card.days.filter((d) => d.status === "stamp"),
    last = card.days[6].day;
  const shortDate = (value) => value.slice(5).replace("-", "/");
  const todayDate = new Date(state.today + "T12:00:00Z"),
    thisWeek = new Date(todayDate.getTime() - todayDate.getUTCDay() * 86400000)
      .toISOString()
      .slice(0, 10),
    previousWeek = new Date(Date.parse(thisWeek + "T12:00:00Z") - 7 * 86400000)
      .toISOString()
      .slice(0, 10);
  const canUseStamp =
    itemsEnabled() &&
    [thisWeek, previousWeek].includes(card.week) &&
    card.days.some((d) => d.day <= state.today && d.status !== "stamp");
  const stampButton = canUseStamp
    ? `<button class="stamp-use-button" data-action="stamp-card-use" ${owned("bathStamp") && owned("stampInk") ? "" : 'disabled title="おふろスタンプとインクが必要です"'}><img src="/stamps/bath.svg" alt="" width="26" height="26">おふろスタンプを使う</button>`
    : "";
  const period = `<span class="stamp-period"><small>${card.week.slice(0, 4)}年</small><span>${shortDate(card.week)} 〜 ${shortDate(last)}</span></span>`;
  return `<section class="stamp-card"><div class="card-title guide-heading">${helpButton("stamps", "スタンプカードの使い方")}<h2>スタンプカード</h2></div>${compact ? `<p class="muted">${period}</p>` : `<div class="week-navigation"><button data-action="stamp-previous" aria-label="前の週">‹</button><p class="muted">${period}</p><button data-action="stamp-next" aria-label="次の週">›</button></div>`}<div class="stamp-days">${card.days.map((d, i) => `<div class="stamp-cell ${d.status}"><span>${"日月火水木金土"[i]}</span><strong class="stamp-mark" aria-label="${d.status === "stamp" ? "成功" : d.status === "failed" ? "失敗" : "未確定"}">${d.status === "stamp" ? '<img class="bath-stamp" src="/stamps/bath.svg" alt="" width="48" height="48">' : d.status === "failed" ? "×" : "−"}</strong><small>${d.day.slice(5).replace("-", "/")}</small></div>`).join("")}</div><p>${card.achieved ? "7日達成" : earned.length + " / 7日達成"}</p>${stampButton}${compact ? "" : `${card.achieved && itemsEnabled() && card.claimed ? '<p>特典はプレゼントボックスへ送付済みです。</p><button class="primary" data-action="nav-gifts">プレゼントボックスへ</button>' : ""}<h3>スタンプ獲得履歴</h3>${earned.length ? earned.map((d) => `<p class="stamp-history">${d.day}分${d.reason === "ink" ? "（スタンプのインクを使用）" : d.reason === "standby" ? "（翌日の入浴で成功）" : ""} <small>${new Date(d.earnedAt).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })} 獲得</small></p>`).join("") : '<p class="muted">この週の獲得履歴はありません。</p>'}`}</section>`;
}
function renderSecondaryPage() {
  const expandedGifts = new Set(
    [...root.querySelectorAll(".gift-description[open]")].map(
      (d) => d.dataset.giftDescription,
    ),
  );
  renderHeaderAccount();
  let html = "";
  if (pageView === "stamps") html = renderStampCard(false);
  if (pageView === "help")
    html = `<section class="help-page"><h2>ヘルプ</h2><p class="muted">知りたいことから、ひとつずつ。</p><div class="help-topics"><button data-guide="booking">予約と事前希望</button><button data-guide="items">アイテムの使い方</button><button data-guide="stamps">スタンプカード</button><button data-guide="automation">自動予約の使い方</button></div><a class="help-manual" href="https://slfinside.github.io/bathjun/" target="_blank" rel="noopener noreferrer">オンラインの使い方ガイド ↗</a><a class="help-manual muted" href="/help/" target="_blank" rel="noopener noreferrer">このアプリで説明書を読む ↗</a></section>`;
  if (pageView === "settings")
    html = `<section class="settings-page"><h2>設定</h2><button class="notification-button" data-action="profile-edit">アイコンを変更</button>${passkeyCard(true)}${notificationCard(true)}${notificationPreferencesForm()}${autoWishesForm()}<button class="cancel-booking" data-action="logout">ログアウト</button></section>`;
  if (pageView === "inventory")
    html = `<section class="inventory-page"><div class="guide-heading">${helpButton("items", "アイテムの使い方")}<h2>持ち物</h2></div><p class="muted">タップすると説明と使用方法が開きます。</p><div class="item-grid">${state.rewards.wallet.map((x) => `<button class="item-card" data-action="item-detail" data-kind="${x.kind}"><span class="item-icon">${itemIcon(x.kind)}</span><strong>${itemName(x.kind)}</strong><span>${x.quantity}${itemUnit(x.kind)}</span></button>`).join("")}</div>${itemsEnabled() && state.rewards.boostRemaining ? `<p class="boost-active">抽選確率UP 発動中：あと${state.rewards.boostRemaining}回</p>` : ""}</section>`;
  if (["gifts", "history"].includes(pageView)) {
    const history = pageView === "history",
      gifts = state.rewards.gifts.filter((g) => history || !g.receivedAt);
    html = `<section class="gift-page"><h2>プレゼントボックス</h2>${!itemsEnabled() ? '<p class="notice">アイテム機能が無効に設定されています。</p>' : ""}<div class="gift-tabs"><button data-action="nav-gifts" aria-pressed="${!history}">プレゼントボックス ${giftBadge()}</button><button data-action="nav-history" aria-pressed="${history}">配布履歴</button></div>${gifts.length ? gifts.map((g) => `<article class="gift-entry"><span class="item-icon">${g.rewardWeek && !g.receivedAt ? "🎁" : itemIcon(g.kind)}</span><div><strong>${g.rewardWeek && !g.receivedAt ? "週間達成特典" : itemName(g.kind) + " × " + g.quantity}</strong><p>${new Date(g.createdAt).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })}</p><details class="gift-description" data-gift-description="${g.id}" ${expandedGifts.has(g.id) ? "open" : ""}><summary>説明を見る</summary>${g.rewardWeek && !g.receivedAt ? `<p><strong>${itemName(g.kind)}</strong></p>` : ""}<p>${itemDescription(g.kind)}</p>${ticketLimits(g.kind)}</details>${g.receivedAt ? "<span>受取済み</span>" : !itemsEnabled() ? "<span>未受取</span>" : `<button class="primary" data-action="receive-gift" data-gift="${g.id}">受け取る</button>`}</div></article>`).join("") : '<p class="muted">' + (history ? "配布履歴はありません。" : "受け取れるプレゼントはありません。") + "</p>"}</section>`;
  }
  root.innerHTML = `<button class="back-home" data-action="nav-home">← ホーム</button>${html}`;
  applyMemberColors(root);
}
function itemDescription(kind) {
  const config = state.rewards.settings;
  return (
    {
      skip: "順番を待たずに予約できます。重なる既存の予約は事前希望へ戻します。ガード付きの予約とは重ねられません。",
      extend: `予約できる時間の上限を${Math.floor(config.extensionMinutes / state.settings.step) * state.settings.step}分伸ばします。ほかの人の予約と重なる時間には使えません。`,
      boost: `予約順が1番になる確率が、使っていない人の3倍になります。効果は${config.boostDraws}回分の抽選に有効です。`,
      guard:
        "確定した予約を順番抜かしから守ります。事前希望への指定では消費せず、確定時に消費します。",
      bathStamp:
        "お風呂の絵柄のスタンプ。専用インクを使えば、お風呂に入ったことの証明になる。",
      stampInk:
        "おふろスタンプ専用のインク。お風呂に入ったことの証明に使える。実は磁石にくっつく。",
    }[kind] || ""
  );
}
function showItem(kind) {
  pendingItem = kind;
  const description = itemDescription(kind);
  const stampItem = ["bathStamp", "stampInk"].includes(kind);
  const usable =
    itemsEnabled() &&
    owned(kind) > 0 &&
    (!stampItem || (owned("bathStamp") > 0 && owned("stampInk") > 0));
  dialog.dataset.mode = "item";
  dialog.dataset.boostRequestId = kind === "boost" ? crypto.randomUUID() : "";
  dialog.innerHTML = `<div class="sheet-heading"><h2 id="booking-title">${itemName(kind)}</h2><button class="icon-button" data-action="close" aria-label="閉じる">×</button></div><div class="item-detail-icon">${itemIcon(kind)}</div><p>${description}</p>${ticketLimits(kind)}<p>所持数：${owned(kind)}${itemUnit(kind)}</p>${stampItem ? `<p class="muted">今週・先週の、今日までの「−」または「×」の日を選び、インクを1個使って成功にできます。おふろスタンプ本体はなくなりません。</p>${!owned("bathStamp") ? '<p class="notice">おふろスタンプが必要です。</p>' : !owned("stampInk") ? '<p class="notice">スタンプのインクがありません。</p>' : ""}` : ""}<button class="primary" data-action="use-item" ${usable ? "" : "disabled"}>${kind === "boost" ? "効果を有効にする" : "使う"}</button>`;
  dialog.showModal();
}
async function openStampPicker(preferredWeek = null) {
  const current = await api("rewards?day=" + encodeURIComponent(state.today));
  const previousWeek = new Date(
    Date.parse(current.card.week + "T12:00:00Z") - 7 * 86400000,
  )
    .toISOString()
    .slice(0, 10);
  const previous = await api("rewards?week=" + previousWeek);
  const card = preferredWeek === previousWeek ? previous.card : current.card;
  const stampable = card.days.filter(
    (d) => d.status !== "stamp" && d.day <= state.today,
  );
  dialog.dataset.mode = "stamp-ink";
  dialog.innerHTML = `<div class="sheet-heading"><h2 id="booking-title">おふろスタンプを押す</h2><button class="icon-button" data-action="close" aria-label="閉じる">×</button></div><div class="gift-tabs"><button data-action="stamp-week" data-stamp-week="${previousWeek}" aria-pressed="${card.week === previousWeek}">先週</button><button data-action="stamp-week" data-stamp-week="${current.card.week}" aria-pressed="${card.week === current.card.week}">今週</button></div><p>今日までの「−」または「×」の日を選んでください。インクを1個使って成功にします。</p><p class="muted">${card.week}からの7日間 · インク ${current.wallet.find((x) => x.kind === "stampInk").quantity}個</p><div class="stamp-repair-days">${stampable.map((d) => `<button class="stamp-repair-day" data-action="apply-stamp" data-stamp-day="${d.day}" data-request-id="${crypto.randomUUID()}"><span>${d.day.slice(5).replace("-", "/")}（${"日月火水木金土"[new Date(d.day + "T12:00:00Z").getUTCDay()]}）</span><strong aria-hidden="true">${d.status === "failed" ? "×" : "−"}</strong><span>スタンプを押す</span></button>`).join("")}</div>${stampable.length ? "" : '<p class="notice">この週はスタンプを押せる日がありません。</p>'}`;
  if (!dialog.open) dialog.showModal();
}
async function handleRewardsAction(action, event) {
  if (!action) return false;
  if (action === "stamp-previous" || action === "stamp-next") {
    stampWeek = new Date(
      Date.parse(state.rewards.card.week + "T12:00:00Z") +
        (action === "stamp-previous" ? -7 : 7) * 86400000,
    )
      .toISOString()
      .slice(0, 10);
    await refresh(true);
    return true;
  }
  if (action === "rebook") {
    if (busy) return true;
    busy = true;
    try { await startRebooking(state.unreportedBooking); }
    catch (error) { notify(error.message); }
    finally { busy = false; }
    return true;
  }
  if (action.startsWith("nav-")) {
    autoEditDirty = false;
    const target = action.slice(4);
    document.querySelector(".account-menu")?.removeAttribute("open");
    if (target === "reserve") {
      pageView = "home";
      await refresh(true);
      const book = ownBooking();
      if (book && slotDate(book.start) <= serverNow()) {
        notify("開始済みの予約です。");
        return true;
      }
      pendingItem = book?.ticket || ownWish()?.ticket || null;
      openBooking(
        book || (state.day <= state.today && nextTurn() === me.id)
          ? "booking"
          : "wish",
      );
    } else {
      pageView = target;
      await refresh(true);
    }
    return true;
  }
  if (action === "item-detail") {
    showItem(event.target.closest("[data-kind]").dataset.kind);
    return true;
  }
  if (
    ![
      "receive-gift",
      "use-item",
      "complete-bath",
      "apply-stamp",
      "stamp-card-use",
      "stamp-week",
    ].includes(action)
  )
    return false;
  if (busy) return true;
  busy = true;
  try {
    if (action === "stamp-card-use" || action === "stamp-week") {
      if (!itemsEnabled() || !owned("bathStamp") || !owned("stampInk"))
        throw new Error("おふろスタンプとインクが必要です。");
      if (action === "stamp-card-use")
        dialog.dataset.stampReturn = pageView === "home" ? "home" : "stamps";
      await openStampPicker(
        action === "stamp-week"
          ? event.target.closest("[data-stamp-week]").dataset.stampWeek
          : state.rewards.card.week,
      );
      return true;
    }
    if (action === "receive-gift") {
      const result = await api("gifts/receive", {
        id: event.target.closest("[data-gift]").dataset.gift,
      });
      notify("持ち物に追加しました。");
    }
    if (action === "apply-stamp") {
      const button = event.target.closest("[data-stamp-day]");
      button.disabled = true;
      try {
        await api("items/stamp", {
          day: button.dataset.stampDay,
          requestId: button.dataset.requestId,
        });
      } catch (error) {
        button.disabled = false;
        throw error;
      }
      dialog.close();
      pendingItem = null;
      pageView = dialog.dataset.stampReturn === "home" ? "home" : "stamps";
      stampWeek = button.dataset.stampDay;
      stampWeek = new Date(
        Date.parse(stampWeek + "T12:00:00Z") -
          new Date(stampWeek + "T12:00:00Z").getUTCDay() * 86400000,
      )
        .toISOString()
        .slice(0, 10);
      if (pageView === "home") stampWeek = null;
      notify("おふろスタンプを押しました。");
    }
    if (action === "complete-bath") {
      const book = ownBooking();
      await api("complete", { day: state.day, revision: book.revision });
      notify("完了を報告しました。");
    }
    if (action === "use-item") {
      const kind = pendingItem;
      if (!itemsEnabled())
        throw new Error("アイテム機能が無効に設定されています。");
      if (["bathStamp", "stampInk"].includes(kind)) {
        dialog.dataset.stampReturn = "stamps";
        await openStampPicker();
        return true;
      }
      if (kind === "boost") {
        await api("items/boost", { requestId: dialog.dataset.boostRequestId });
        dialog.close();
        notify("抽選確率UPを有効にしました。");
        pendingItem = null;
      } else {
        dialog.close();
        pageView = "home";
        await refresh(true);
        pendingItem = kind;
        openBooking(
          kind === "skip" ||
            ownBooking() ||
            (state.day <= state.today && nextTurn() === me.id)
            ? "booking"
            : "wish",
        );
        return true;
      }
    }
    await refresh(true);
  } catch (error) {
    notify(error.message);
  } finally {
    busy = false;
  }
  return true;
}

document.querySelector("#header-account").addEventListener(
  "toggle",
  (event) => {
    if (event.target.matches(".account-menu")) {
      document
        .querySelector("#header-account")
        .classList.toggle("menu-open", event.target.open);
      event.target
        .querySelector("summary")
        .setAttribute(
          "aria-label",
          event.target.open ? "メニューを閉じる" : "メニューを開く",
        );
    }
  },
  true,
);

function maybeCelebrate() {
  if (!state || pageView !== "home" || dialog.open || guidePending || rebookingFlow) return;
  if (maybeOfferRebooking()) return;
  if (!itemsEnabled()) return;
  const pending = state.rewards?.celebrations.find(
    (x) => !celebrating.has(x.week),
  );
  if (!pending) return;
  celebrationWeek = pending.week;
  celebrating.add(pending.week);
  dialog.dataset.mode = "celebration";
  dialog.dataset.rewardMode = pending.mode;
  const roulette = pending.mode !== "fixed";
  const fixedPrize =
    pending.mode === "both"
      ? pending.items.find((item) => item.mode === "fixed")
      : null;

  const rouletteKinds = Object.keys(state.rewards.settings.weights).filter(
    (k) => state.rewards.settings.weights[k] > 0 || k === pending.kind,
  );
  const sector = 360 / rouletteKinds.length;
  const colors = [
    "#dce9c8",
    "#eaddb9",
    "#d8e6df",
    "#e7d5be",
    "#e4deeb",
    "#dee7eb",
  ];
  const wheelBackground = `conic-gradient(${rouletteKinds.map((k, i) => `${colors[i % colors.length]} ${i * sector}deg ${(i + 1) * sector}deg`).join(",")})`;
  dialog.innerHTML = `<div class="sheet-heading"><h2 class="celebration-heading" id="booking-title"><span>1週間達成、</span><span>おめでとう！</span></h2><button class="icon-button" data-action="close" aria-label="閉じる">×</button></div><p class="muted">${pending.week}からの7日間、すべてのスタンプがそろいました。</p>${roulette ? `<div class="roulette-pointer">▼</div><div class="roulette-viewport"><div class="roulette-wheel">${rouletteKinds.map((k) => `<span>${itemIcon(k)}</span>`).join("")}</div></div>` : ""}<div class="${roulette ? "roulette-result" : "fixed-result"} celebration-prize"><span class="item-icon">${itemIcon(pending.kind)}</span><h3>${itemName(pending.kind)}</h3><strong>${pending.quantity}${itemUnit(pending.kind)} 獲得！</strong></div>${fixedPrize ? `<div class="fixed-result celebration-prize fixed-bonus"><span class="muted">固定報酬</span><span class="item-icon">${itemIcon(fixedPrize.kind)}</span><h3>${itemName(fixedPrize.kind)}</h3><strong>${fixedPrize.quantity}${itemUnit(fixedPrize.kind)} 獲得！</strong></div>` : ""}<button class="primary" data-action="celebration-gifts">プレゼントボックスへ</button>`;
  const wheel = dialog.querySelector(".roulette-wheel");
  if (wheel) {
    wheel.style.background = wheelBackground;
    wheel.querySelectorAll(":scope > span").forEach((entry, i) => {
      const angle = (i + 0.5) * sector;
      entry.style.transform = `rotate(${angle}deg) translateY(-65px) rotate(${-angle}deg)`;
    });
  }
  dialog.showModal();
  requestAnimationFrame(() => {
    if (wheel)
      wheel.style.transform = `rotate(${1440 - (rouletteKinds.indexOf(pending.kind) + 0.5) * sector}deg)`;
  });
}
dialog.addEventListener("click", (event) => {
  if (event.target.closest('[data-action="celebration-gifts"]')) {
    dialog.close();
    pageView = "gifts";
    renderDashboard();
  }
});
dialog.addEventListener("close", () => {
  if (!celebrationWeek) return;
  const week = celebrationWeek;
  celebrationWeek = null;
  void api("rewards/celebrate", { week })
    .then(() => refresh(true))
    .catch(() => {
      celebrating.delete(week);
    });
});

document.addEventListener("pointerdown", (event) => {
  const menu = document.querySelector(".account-menu[open]");
  if (menu && !menu.contains(event.target)) menu.removeAttribute("open");
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape")
    document.querySelector(".account-menu")?.removeAttribute("open");
});

function resetNavigation() {
  accountGeneration++;
  passkeyList = null;
  previousTurn = null;
  notificationStatus = "未設定";
  lastSignature = "";
  pageView = "home";
  pendingItem = null;
  checkRebookingOnOpen = true;
  rebookingQuestion = null;
  rebookingFlow = false;
  autoEditDirty = false;
  stampWeek = null;
  celebrationWeek = null;
  celebrating.clear();
  document.querySelectorAll("dialog[open]").forEach(open => open.close());
}

function maybeOfferRebooking() {
  if (!checkRebookingOnOpen) return false;
  checkRebookingOnOpen = false;
  const offer = state.unreportedBooking;
  if (!offer || offer.prompted) return false;
  rebookingQuestion = offer;
  dialog.dataset.mode = "rebooking-question";
  dialog.innerHTML = `<div class="sheet-heading"><h2 id="booking-title">予約を取り直しますか？</h2><button class="icon-button" data-action="close" aria-label="閉じる">×</button></div><p>${dateLabel(offer.day)} ${time(offer.start)}〜${time(offer.start + offer.duration)}の予約に、完了報告がありません。</p><p class="muted">まだ入っていない場合は、空いている時間で予約し直せます。新しい予約を確定するまで、元の予約は残ります。</p><p class="form-error" data-rebooking-error role="alert"></p><button class="primary" data-rebooking-decision="rebook">予約を取り直す</button><button class="cancel-booking" data-rebooking-decision="later">今はしない</button>`;
  dialog.showModal(); return true;
}
async function startRebooking(offer) {
  if (!offer) throw Error("取り直せる予約がありません。");
  rebookingFlow = true;
  try {
    await api("rebooking/prompt", {day:offer.day,revision:offer.revision,decision:"rebook"});
    rebookingQuestion = null;
    if (dialog.open) dialog.close();
    selectedDay = offer.day; pageView = "home";
    await refresh(true);
    if (ownBooking()?.revision !== offer.revision || state.unreportedBooking?.revision !== offer.revision)
      throw Error("予約が変更されました。現在の予定を確認してください。");
    pendingItem = null; openBooking("rebook");
  } finally { rebookingFlow = false; }
}
dialog.addEventListener("click", async event => {
  const decision = event.target.closest("[data-rebooking-decision]")?.dataset.rebookingDecision;
  if (!decision || !rebookingQuestion || busy) return;
  busy = true;
  try {
    if (decision === "rebook") await startRebooking(rebookingQuestion);
    else {
      await api("rebooking/prompt", {day:rebookingQuestion.day,revision:rebookingQuestion.revision,decision:"later"});
      rebookingQuestion = null; dialog.close();
    }
  } catch (error) {
    const feedback = dialog.querySelector("[data-rebooking-error]");
    if (feedback) feedback.textContent = error.message; else notify(error.message);
  } finally { busy = false; }
});
dialog.addEventListener("close", () => {
  const offer = rebookingQuestion; rebookingQuestion = null;
  if (offer) void api("rebooking/prompt", {day:offer.day,revision:offer.revision,decision:"later"})
    .catch(error => {if (error.status !== 409 && error.status !== 401) notify(error.message);});
  queueMicrotask(maybeCelebrate);
});
