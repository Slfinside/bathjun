import {renderProfilePicker,initializeProfilePicker} from "./profile-picker.js";
import { scheduleSegments, quarterTicks } from "./schedule-layout.js";
const root = document.querySelector("#app");
const dialog = document.querySelector("#booking-dialog");
const toast = document.querySelector("#toast");
let state,
  members = [],
  me = null,
  selectedDay,
  selectedMember,
  refreshing = false,
  busy = false,
  lastSignature = "";
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
  const member=members.find(m=>m.id===id);
  return `<span class="avatar ${small ? "small" : ""}" data-avatar-member="${id}" aria-hidden="true">${escapeHTML(member?.emoji||"?")}</span>`;
};
function applyMemberColors(container) {
  const colorFor=id=>{const color=members.find(m=>m.id===Number(id))?.color;return /^#[0-9a-f]{6}$/i.test(color||"")?color:'#c5c9c1';};
  const tint=(hex,strength)=>'#'+[1,3,5].map(index=>Math.round(parseInt(hex.slice(index,index+2),16)*strength+255*(1-strength)).toString(16).padStart(2,'0')).join('');
  container.querySelectorAll('[data-avatar-member]').forEach(node=>node.style.backgroundColor=colorFor(node.dataset.avatarMember));
  container.querySelectorAll('[data-tint-member]').forEach(node=>{const color=colorFor(node.dataset.tintMember);node.style.backgroundColor=tint(color,node.classList.contains('tentative') ? 0.10 : 0.30);if(node.classList.contains('tentative'))node.style.borderColor=tint(color,.7);});
}
function renderHeaderAccount() {
  const account=document.querySelector('#header-account');
  account.hidden=!me;
  account.innerHTML=me?`<button class="profile-button" data-action="logout" aria-label="${escapeHTML(me.name)}さん ログアウト">${avatar(me.id,true)}<span class="profile-identity"><span class="profile-name">${escapeHTML(me.name)}</span><small>ログアウト</small></span></button>`:'';
  if(me)applyMemberColors(account);
}
const time = (minute) =>
  `${minute >= 1440 ? "翌" : ""}${String(Math.floor(minute / 60) % 24).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
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
  let response;
  try {
    response = await fetch(
      `/api/${path}`,
      data === undefined
        ? { cache: "no-store" }
        : {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(data),
          },
    );
  } catch {
    throw new Error("サーバーに接続できません。接続を確認してください。");
  }
  const result = await response.json();
  if (!response.ok) {
    if (
      response.status === 401 &&
      !["login", "register", "family/login", "passkey/auth/verify"].includes(
        path,
      )
    ) {
      me = null;
      state = null;
      selectedMember = null;
      dialog.close();
      void init();
    }
    throw Object.assign(new Error(result.error || "読み込みに失敗しました。"), {
      status: response.status,
    });
  }
  return result;
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
  let help = "前の人が予約し終わると、この端末にお知らせします。希望の結果や、設定した分数前の入浴通知も受け取れます。";
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
  const settings=state.notificationPreferences||{};
  return `<form id="notification-preference-form" class="notification-preferences"><h3>通知の種類</h3>${[['wishConfirmed','事前希望が確定した'],['wishUnconfirmed','事前希望を確定できなかった'],['reservationTurn','予約の順番が回ってきた'],['bathReminder','入浴開始前のお知らせ']].map(([key,label])=>`<label class="notification-choice"><input type="checkbox" name="${key}" ${settings[key]!==false?'checked':''}><span>${label}</span></label>`).join('')}<label class="reminder-minutes">入浴の何分前に通知するか<input type="number" name="reminderMinutes" min="1" max="180" step="1" required value="${Number(settings.reminderMinutes)||10}"><span>分前</span></label><p class="muted">種類と分数は、自分の端末間で共通です。通知の許可は端末ごとに必要です。</p><button type="submit" class="primary">通知設定を保存</button><p class="form-error" role="alert"></p></form>`;
}
function autoStandbyForm() {
  return `<form id="auto-standby-form" class="notification-preferences"><h3>毎日の予約設定</h3><label class="notification-choice"><input type="checkbox" name="enabled" ${state.autoStandby?'checked':''}><span>自動で「入らない/様子見」にする</span></label><p class="muted">次に順番を決める夜から、予約順の末尾へ回ります。予約や希望は取り消しません。順番が決まっている今日分は「入らない/様子見」や「通常の順番に戻す」で変更できます。</p><button type="submit" class="primary">予約設定を保存</button><p class="form-error" role="alert"></p></form>`;
}
document.querySelector('.app-shell').addEventListener('submit',async event=>{
  if(event.target.id!=='auto-standby-form')return;
  event.preventDefault();if(busy)return;busy=true;
  const form=event.target,button=form.querySelector('[type=submit]');button.disabled=true;
  try {const result=await api('auto-standby',{enabled:new FormData(form).has('enabled')});await refresh(true);notify('毎日の予約設定を保存しました。'+dateLabel(result.appliesFrom)+'の夜分から反映します。');}
  catch(error){form.querySelector('.form-error').textContent=error.message;}
  finally{busy=false;button.disabled=false;}
});
document.querySelector('.app-shell').addEventListener('submit',async event=>{
  if(event.target.id!=='notification-preference-form')return;
  event.preventDefault();if(busy)return;busy=true;
  const form=event.target,button=form.querySelector('[type=submit]');button.disabled=true;
  try {
    const data=new FormData(form),settings={reminderMinutes:Number(data.get('reminderMinutes'))};
    for(const key of ['wishConfirmed','wishUnconfirmed','reservationTurn','bathReminder'])settings[key]=data.has(key);
    await api('notification-preferences',settings);await refresh(true);notify('通知設定を保存しました。');
  }catch(error){form.querySelector('.form-error').textContent=error.message;}
  finally{busy=false;button.disabled=false;}
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
  if (!activeMembers().length) { root.innerHTML = `<section class="login-card"><h2>メンバーはまだ登録されていません</h2><p>サーバー操作画面の「設定」で、利用するメンバーを追加してください。</p><button class="primary" data-action="retry">もう一度読み込む</button></section>`;  return; }

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
    `<form id="login-form" class="login-form"><div class="notice">${m.registered ? `${escapeHTML(m.name)}さん、おかえりなさい。` : `${escapeHTML(m.name)}さん専用のパスワードを決めましょう。`}<small>${m.registered ? "" : "自分の名前だけ設定してください。4文字以上で設定できます。"}</small></div><label for="password">${m.registered ? "パスワード" : "新しいパスワード"}</label><input id="password" name="password" type="password" autocomplete="${m.registered ? "current-password" : "new-password"}" minlength="4" maxlength="128" required placeholder="4文字以上">${m.registered ? "" : '<label for="password-confirm">もう一度入力</label><input id="password-confirm" name="confirm" type="password" autocomplete="new-password" minlength="4" maxlength="128" required placeholder="確認用パスワード">'}${m.registered ? '' : renderProfilePicker(m)}<label class="checkbox-label"><input type="checkbox" id="show-password">パスワードを表示</label><p class="form-error" id="login-error" role="alert"></p><button type="submit" class="primary">${m.registered ? "ログインする" : "パスワードを設定して、はじめる"}${icon("arrow")}</button></form>`;
  if(!m.registered) initializeProfilePicker(document.querySelector("#login-fields"));
}
const profileDialog=document.createElement('dialog');profileDialog.className='profile-dialog';document.body.append(profileDialog);
function openProfile() {
  const member=members.find(m=>m.id===me.id)||{};
  profileDialog.innerHTML=`<form id="profile-form"><h2>自分のアイコン</h2>${renderProfilePicker(member)}<p class="form-error" role="alert"></p><button class="primary" type="submit">アイコンを保存</button><button type="button" class="cancel-booking" data-profile-close>閉じる</button></form>`;
  initializeProfilePicker(profileDialog);profileDialog.querySelector('[data-profile-close]').onclick=()=>profileDialog.close();profileDialog.showModal();
}
profileDialog.addEventListener('submit',async event=>{event.preventDefault();if(busy)return;busy=true;const button=profileDialog.querySelector('[type=submit]');button.disabled=true;try{const data=new FormData(event.target);await api('profile',{emoji:data.get('emoji'),color:data.get('color')});profileDialog.close();await refresh(true);notify('アイコンを変更しました。');}catch(error){profileDialog.querySelector('.form-error').textContent=error.message;}finally{busy=false;button.disabled=false;}});
async function refresh(force = false) {
  if (!me || refreshing) return;
  refreshing = true;
  try {
    let data;
    try {
      data = await api(`state${selectedDay ? `?day=${selectedDay}` : ""}`);
    } catch (error) {
      if (error.status !== 400 || !selectedDay) throw error;
      selectedDay = undefined;
      data = await api("state");
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
      data.ignoreLowerPriorityWishes,
      Math.floor(new Date(data.now).getTime() / 60000),
    ]);
    const before = previousTurn;
    state = data;
    previousTurn =
      data.draw?.order.find(
        (id) =>
          data.members.some(
            (member) => member.id === id && member.active !== 0,
          ) && !data.bookings.some((b) => b.memberId === id),
      ) || null;
    if (
      state?.day===data.day && data.notificationPreferences?.reservationTurn && data.day<=data.today && before !== null &&
      before !== previousTurn &&
      previousTurn === data.me.id
    )
      notify("予約する番です。好きな時間を選んでください。");
    members = data.members;
    me = data.me;
    selectedDay = data.day;
    if ((force || signature !== lastSignature) && (force || !document.activeElement?.closest("#notification-preference-form, #auto-standby-form"))) {
      renderDashboard();
      lastSignature = signature;
    }
    document.querySelector("#connection-status").textContent =
      "共有データを更新済み";
  } catch (error) {
    if (force) notify(error.message);
    const status = document.querySelector("#connection-status");
    if (status) status.textContent = "接続できません · サーバーと接続を確認";
  } finally {
    refreshing = false;
  }
}
function renderDashboard() {

  root.removeAttribute("aria-busy");
  const booking = ownBooking(),
    turn = nextTurn();
  const expired = slotDate(state.settings.bathEnd) <= serverNow();
  const canEdit = booking && slotDate(booking.start) > serverNow();
  const yourTurn = turn === me.id && !expired;
  const allBooked = state.draw && !turn;
  renderHeaderAccount();
  root.innerHTML = `  <div class="date-bar"><div><span class="date-caption">BATH DAY</span><h2>${dateLabel(state.day)}</h2><p>${time(state.settings.bathStart)} <span>—</span> ${time(state.settings.bathEnd)} <span class="jst">日本時間</span></p></div><div class="day-switch" aria-label="日付切り替え"><button data-day="${state.yesterday}" class="${state.day === state.yesterday ? "active" : ""}" aria-pressed="${state.day === state.yesterday}">昨日の夜～</button><button data-day="${state.today}" class="${state.day === state.today ? "active" : ""}" aria-pressed="${state.day === state.today}">今日の夜～</button><button data-day="${state.tomorrow}" class="${state.day === state.tomorrow ? "active" : ""}" aria-pressed="${state.day === state.tomorrow}">明日の夜～</button><button data-day="${state.dayAfterTomorrow}" class="${state.day === state.dayAfterTomorrow ? "active" : ""}" aria-pressed="${state.day === state.dayAfterTomorrow}">明後日の夜～</button></div></div>
  <div class="dashboard-grid"><div class="left-column"><section class="draw-card">${
    state.draw
      ? `
    <div class="card-title"><h2>予約の順番</h2><span class="badge">${icon("check")}${state.draw.mode === "fixed" ? "固定順" : "抽選済み"}</span></div><p class="muted">この順番で、お風呂の時間を選べます。</p><ol class="draw-list">${state.draw.order
      .map((id, index) => {
        const booked = state.bookings.some((b) => b.memberId === id);
        const skipped = state.skips.includes(id);
        const inactive = !activeMember(id);
        return `<li class="${turn === id && !expired && state.day <= state.today ? "current" : ""}"><span class="rank">${String(index + 1).padStart(2, "0")}</span>${avatar(id, true)}<strong>${escapeHTML(memberName(id))}${id === me.id ? '<span class="you">あなた</span>' : ""}</strong><span class="draw-status ${booked ? "done" : ""}">${inactive ? "利用停止" : booked ? `${icon("check")}予約済み` : skipped ? "入らない/様子見" : expired ? "受付終了" : state.day > state.today ? "当日から" : turn === id ? "選ぶ番" : "待機中"}</span></li>`;
      })
      .join(
        "",
      )}</ol>${state.settings.orderMode === "fixed" ? '<p class="fine-print">固定順は全端末で共通。「入らない/様子見」は末尾へ回ります。</p>' : ""}`
      : state.settings.orderMode === "fixed" ? '<h2>予約の順番</h2><p class="muted">固定順は当日に確定します。時刻の予約も当日からです。</p>'
      : `<div class="draw-illustration" aria-hidden="true">${icon("shuffle")}<span>?</span></div><h2>この夜の順番、くじで決めよう。</h2><p class="muted">${activeMembers().length}人の予約する順番をランダムに決定。<br>だれか1人が引けば、みんなに共有されます。</p><button class="primary" data-action="draw" ${state.lotteryOpen ? "" : "disabled"}>${icon("shuffle")}${state.lotteryOpen ? "この夜の順番を抽選する" : "抽選できる時間を待ってね"}</button><p class="fine-print">${icon("clock")}${state.settings.lotteryTimeRestricted ? `抽選できる時間：当日 ${time(state.settings.lotteryStart)}〜${time(state.settings.lotteryEnd)}（締切）` : "当日分を抽選できます（対象日のおふろ終了まで）"}</p>${state.settings.lotteryTimeRestricted && !state.lotteryOpen && state.day === state.today && state.minute >= state.settings.lotteryEnd ? '<p class="form-error">今日は抽選時間が終了しました。次は明日の抽選時間に操作してください。</p>' : ""}`
  }</section>${renderWishes()}${passkeyCard()}${notificationCard()}${`<details class="configured-settings"><summary>ログイン・通知の設定</summary><button class="notification-button" data-action="profile-edit">アイコンを変更</button>${state.passkeyCount ? passkeyCard(true) : ""}${notificationStatus === "有効" ? notificationCard(true) : ""}${notificationPreferencesForm()}${autoStandbyForm()}</details>`}${state.shareUrl ? '<aside class="share-card"><button data-action="copy-link">家族用リンクをコピー</button><p>リンクと合い言葉は、家族だけに共有してください。</p></aside>' : ""}
  <aside class="rules-card"><span class="rules-icon">♨</span><div><h3>わが家のおふろルール</h3><p>1回 <strong>${state.settings.minDuration}〜${state.settings.maxDuration}分</strong>、${state.settings.step}分刻みで予約。<br>脱衣所に入ってから、出るまでの時間です。<br>1人1枠。予約後も、開始前なら変更できます。</p></div></aside></div>
  <div class="right-column">${renderBookingBanner(booking, turn, expired, canEdit)}
  <section class="schedule-card"><div class="card-title"><h2>スケジュール</h2><span class="count">${state.bookings.length} 人予約${state.skips.filter((id) => !state.bookings.some((b) => b.memberId === id)).length ? ` · ${state.skips.filter((id) => !state.bookings.some((b) => b.memberId === id)).length} 人様子見` : ""}</span></div><div id="connection-status" class="connection-status" role="status">共有データを更新済み</div><div class="schedule"><div class="timeline-label"><span class="timeline-dot"></span>${time(state.settings.bathStart)}<span>おふろ、はじまり</span></div>${renderSchedule()}<div class="timeline-label end"><span class="timeline-dot"></span>${time(state.settings.bathEnd)}</div></div></section></div></div>`;
  applyMemberColors(root);
  root.querySelectorAll('[data-top]').forEach(node => { node.style.top = `${Number(node.dataset.top)}%`; });
  root.querySelectorAll('[data-min-height]').forEach(node => { node.style.minHeight = `${Number(node.dataset.minHeight)}px`; });
}
function renderBookingBanner(booking, turn, expired, canEdit) {
  if (state.day > state.today) return `<section class="booking-banner"><div><h3>${state.day === state.tomorrow ? "明日" : "明後日"}の夜の予定</h3><p>希望は抽選前から出せます。抽選・予約は当日からです。日付は${time(state.dayRollover)}に切り替わります。</p></div></section>`;
  const yourTurn = turn === me.id && !expired;
  let content;
  if (expired)
    content =
      '<span class="banner-symbol">☾</span><div><h3>この日のおふろは終了しました。</h3><p>今日の夜～のタブから次のおふろを確認できます。</p></div>';
  else if (booking)
    content = `${icon("check")}<div><span class="eyebrow">YOUR BATH TIME</span><h3>${time(booking.start)} <span>〜</span> ${time(booking.start + booking.duration)}</h3><p>${booking.autoConfirmed ? "希望から自動確定" : "あなたの予約"} · ${booking.duration}分</p></div>${canEdit ? `<button class="primary" data-action="book" aria-label="自分の予約を変更">${icon("edit")}予約を変更</button>` : ""}`;
  else if (yourTurn)
    content = `${icon("bath")}<div><h3>${escapeHTML(me.name)}さん、選ぶ番です。</h3>${isDeferred() ? "<p>末尾の順番が回ってきました。希望するなら予約できます。</p>" : ""}</div>`;
  else if (isDeferred())
    content = `${icon("clock")}<div><h3>入らない/様子見 · 順番は最後へ</h3><p>入らないと確定した扱いではありません。順番が来たら予約できます。</p></div>`;
  else
    content = `${icon("clock")}<div><h3>${!state.draw ? "まずは、今日の順番を抽選。" : !state.draw.order.includes(me.id) ? "次回の順番決定から参加できます。" : !turn ? "この日の予約がそろいました。" : `${escapeHTML(memberName(turn))}さんが選ぶ番です。`}</h3><p>予約や順番の変更は自動で更新されます。</p></div>`;
  return `<section class="booking-banner ${yourTurn ? "is-turn" : ""}">${content}${yourTurn ? `<button class="primary" data-action="book">時間を選ぶ${icon("arrow")}</button>` : ""}${!expired && (!booking || canEdit) ? `<button class="skip-button" data-action="toggle-skip">${isDeferred() ? "通常の順番に戻す" : "入らない/様子見"}</button>` : ""}</section>`;
}
function renderWishes() {
  const expired = slotDate(state.settings.bathEnd) <= serverNow();
  const own = ownWish();
  return `<section class="wishes-card"><div class="card-title"><h2>事前希望</h2></div><p class="muted">${state.ignoreLowerPriorityWishes?"順番が回ってきたとき、予約と重ならなければ自動で確定します。下位の人の希望より予約順を優先します。":"順番が回ってきたとき、ほかの予約・希望のどちらとも重ならなければ、自動で確定します。"}</p>${!expired && !ownBooking() ? `<button class="primary wish-action" data-action="wish">${icon("clock")}${own ? "自分の希望を変更" : "希望を出す"}</button>` : ""}<hr class="wish-divider"><h3 class="wish-list-heading">みんなの希望</h3>${state.wishes.length ? `<div class="wish-list">${state.wishes.map((w) => renderWish(w)).join("")}</div>` : '<p class="empty-wish">まだ希望はありません。</p>'}</section>`;
}
function renderWish(w) {
  const conflict = state.bookings.some(
    (b) => b.start < w.start + w.duration && b.start + b.duration > w.start,
  ) || state.wishes.some(other=>other.memberId!==w.memberId&&other.start<w.start+w.duration&&other.start+other.duration>w.start);
  return `<article class="wish-item"><div class="wish-person">${avatar(w.memberId, true)}<strong>${escapeHTML(memberName(w.memberId))}</strong><span>希望・未確定</span></div><div class="wish-time">${time(w.start)}〜${time(w.start + w.duration)}<small>${w.duration}分</small></div>${w.note ? `<p class="booking-note">${escapeHTML(w.note)}</p>` : ""}${conflict ? '<p class="wish-conflict">ほかの予約・希望と重なっています。</p>' : ""}</article>`;
}
function renderSchedule() {
  const ruler = (segment) => `<div class="quarter-ruler" aria-label="15分刻み">${quarterTicks(segment.start, segment.end).map(minute => `<span class="${minute % 60 === 0 ? "whole-hour" : ""}" data-top="${(minute-segment.start)/(segment.end-segment.start)*100}">${time(minute)}</span>`).join("")}</div>`;
  const segments=scheduleSegments(state.bookings,state.settings.bathStart,state.settings.bathEnd,state.wishes);
  return (!state.bookings.length && !state.wishes.length ? '<p class="schedule-empty-hint">まだ予約はありません。</p>' : '') + segments.map(segment => {
    if(segment.kind === "break") return `<div class="timeline-break" aria-label="${time(segment.start)}から${time(segment.end)}まで空き時間を省略"><strong>${time(segment.start)}</strong><svg viewBox="0 0 240 26" preserveAspectRatio="none" aria-hidden="true"><path d="M0 7 Q15 -3 30 7 T60 7 T90 7 T120 7 T150 7 T180 7 T210 7 T240 7 M0 20 Q15 10 30 20 T60 20 T90 20 T120 20 T150 20 T180 20 T210 20 T240 20"/></svg><strong>${time(segment.end)}</strong></div>`;
    const height=Math.max(segment.kind !== "free" ? 128 : 52,(segment.end-segment.start)*4.8);
    if(segment.kind === "free") return `<div class="timeline-segment free-segment" data-min-height="${height}">${ruler(segment)}<div class="free-interval">空いています</div></div>`;
    const card=entry=>{
      const b=entry.booking,wish=entry.kind==='wish';
      const current=!wish&&slotDate(b.start)<=serverNow()&&slotDate(b.start+b.duration)>serverNow();
      const ended=slotDate(b.start+b.duration)<=serverNow();
      return `<article class="reservation ${wish?'tentative':''} ${ended?'ended':''}" data-tint-member="${b.memberId}"><div class="reservation-top"><span class="reservation-time">${time(b.start)}<span> — </span>${time(b.start+b.duration)}</span><span class="duration">${b.duration}分</span></div><div class="reservation-person">${avatar(b.memberId,true)}<strong>${escapeHTML(memberName(b.memberId))}</strong>${b.memberId===me.id?'<span class="you">あなた</span>':''}${wish?'<span class="tentative-label">希望・未確定</span>':b.autoConfirmed?'<span class="auto-confirmed-label">希望から自動確定</span>':current?'<span class="bathing">入浴の時間</span>':ended?'<span class="bathing">終了</span>':''}</div>${b.note?`<p class="booking-note">${escapeHTML(b.note)}</p>`:''}${!wish&&b.noNegotiation?'<div class="no-negotiation">時間変更不可</div>':''}</article>`;
    };
    const entries=segment.entries||[segment];
    return `<div class="timeline-segment ${segment.kind==='overlap'?'overlapping-plans':''}" data-min-height="${height}">${ruler(segment)}<div class="plan-cards">${entries.length>1?'<p class="overlap-caption">時間帯が重なる予約・希望</p>':''}${entries.map(card).join('')}</div></div>`;
  }).join("");
}
function available(start, duration) {
  return (
    start + duration <= state.settings.bathEnd &&
    slotDate(start) > serverNow() &&
    !state.bookings.some(
      (b) =>
        b.memberId !== me.id &&
        b.start < start + duration &&
        b.start + b.duration > start,
    )
  );
}
function openBooking(mode = "booking") {
  const isWish = mode === "wish",
    booking = ownBooking(),
    wish = ownWish();
  const entry = isWish ? wish : booking || wish;
  const durations = durationValues();
  const initialDuration =
    entry?.duration || (durations.includes(30) ? 30 : durations[0]);
  dialog.dataset.mode = mode;
  dialog.innerHTML = `<div class="sheet-handle" aria-hidden="true"></div><div class="sheet-heading"><div><div class="eyebrow">${isWish ? "LET YOUR FAMILY KNOW" : "YOUR LITTLE BREAK"}</div><h2 id="booking-title">${isWish ? "先に、希望を伝えよう。" : booking ? "おふろの時間を変更" : "何時に、あたたまる？"}</h2></div><button class="icon-button" data-action="close" aria-label="閉じる">${icon("close")}</button></div><p class="muted">${dateLabel(state.day)} · ${isWish ? "希望は家族みんなに共有されます。順番が来て重なりがなければ自動で確定します。" : "脱衣所に入る時刻を選んでください。"}</p>${
    !isWish && state.wishes.some((w) => w.memberId !== me.id)
      ? `<details class="other-wishes"><summary>ほかの人の希望を確認する</summary>${state.wishes
          .filter((w) => w.memberId !== me.id)
          .map((w) => renderWish(w))
          .join("")}</details>`
      : ""
  }<form id="booking-form"><fieldset class="duration-fieldset"><legend>おふろに使う時間</legend><div class="duration-options">${durations.length > 12 ? `<select name="duration" aria-label="おふろに使う時間">${durations.map((d) => `<option value="${d}" ${initialDuration === d ? "selected" : ""}>${d}分</option>`).join("")}</select>` : durations.map((d) => `<label><input type="radio" name="duration" value="${d}" ${initialDuration === d ? "checked" : ""}><span>${d}<small>分</small></span></label>`).join("")}</div></fieldset><label for="start">${isWish ? "希望する開始時刻" : "脱衣所に入る時刻"}</label><select id="start" name="start" required></select><div class="end-summary">${icon("clock")}<span>出る時刻</span><strong id="end-time"></strong></div><p class="fine-print">着替えの時間も含めてください。</p><label for="booking-note">${isWish ? "希望の理由" : "備考"} <span class="optional">任意・300文字まで</span></label><textarea id="booking-note" name="note" maxlength="300" rows="3" placeholder="例：明日は出張で早起きなので、この時間に入りたいです。">${escapeHTML(entry?.note || "")}</textarea>${isWish ? "" : `<label class="checkbox-label negotiation-choice"><input type="checkbox" name="noNegotiation" ${booking?.noNegotiation ? "checked" : ""}><span>時間変更不可</span></label>`}<p class="fine-print">${isWish ? "重なっている時間にも希望を出せます。重なりがある間は自動確定しません。" : "備考と選択内容は、家族みんなに表示されます。"}</p><p class="form-error" id="booking-error" role="alert"></p><button type="submit" class="primary" id="save-booking">${isWish ? "この希望を家族に共有する" : booking ? "この時間に変更する" : "この時間で予約する"}${icon("check")}</button>${isWish && wish ? '<button type="button" class="cancel-booking" data-action="cancel-wish">希望を取り消す</button>' : !isWish && booking ? '<button type="button" class="cancel-booking" data-action="cancel">この予約を取り消す</button>' : ""}</form>`;
  updateSlots(entry?.start);
  applyMemberColors(dialog);
  dialog.showModal();
}
function updateSlots(preferred) {
  const select = document.querySelector("#start");
  const duration = selectedDuration();
  const previous = preferred ?? Number(select.value);
  let html = "",
    values = [];
  for (
    let start = state.settings.bathStart;
    start < state.settings.bathEnd;
    start += state.settings.step
  ) {
    if (
      dialog.dataset.mode === "wish"
        ? start + duration > state.settings.bathEnd ||
          slotDate(start) <= serverNow()
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
document.querySelector(".app-shell").addEventListener("click", async (event) => {
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
    busy = true;
    try {
      if (action === "passkey-login") await loginWithPasskey();
      if (action === "passkey-register") await registerPasskey();
      if (action === "passkey-manage") {
        passkeyList = (await api("passkey/list")).credentials;
        renderDashboard();
      }
      if (action === "passkey-remove") {
        await api("passkey/remove", {
          id: event.target.closest("[data-credential]").dataset.credential,
        });
        passkeyList = (await api("passkey/list")).credentials;
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
  if(action === "profile-edit") {openProfile();return;}
  if (action === "copy-link") {
    try {
      await navigator.clipboard.writeText(state.shareUrl);
      notify("家族用リンクをコピーしました。");
    } catch {
      prompt("このリンクを家族に共有してください。", state.shareUrl);
    }
    return;
  }
  if (action === "enable-notifications" || action === "disable-notifications") {
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
  if (action === "book") return openBooking();
  if (action === "wish") return openBooking("wish");
  if (action === "toggle-skip") {
    const skip = !isDeferred();
    if (
      skip &&
      !confirm(
        "「入らない/様子見」にしますか？予約と希望がある場合は取り消し、順番の最後へ回ります。後で予約することもできます。",
      )
    )
      return;
    busy = true;
    try {
      await api("skip", { day: state.day, skip });
      notify(
        skip
          ? "入らない/様子見にして、順番の最後へ回りました。"
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
  if (action === "logout") {
    busy = true;
    try {
      await api("logout", {});
      me = null;
      state = null;
      notificationStatus = "未設定";
      previousTurn = null;
      passkeyList = null;
      selectedMember = null;
      selectedDay = undefined;
      lastSignature = "";
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
      ...(!m.registered ? {profile:{emoji:data.get("emoji"),color:data.get("color")}} : {}),
    });
    me = result.me;
    previousTurn = null;
    await refresh(true);
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
    const result=await api(dialog.dataset.mode === "wish" ? "wish" : "book", {
      day: state.day,
      start: Number(form.get("start")),
      duration: Number(form.get("duration")),
      note: String(form.get("note") || ""),
      noNegotiation: form.get("noNegotiation") === "on",
    });
    dialog.close();
    notify(
      dialog.dataset.mode === "wish"
        ? result.autoConfirmed ? "希望が自動で確定しました。" : "希望を共有しました。"
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
  try {
    const family = await api("family");
    familyAuthenticated = family.authenticated;
    if (!familyAuthenticated) {
      me = null;
      state = null;
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
  if (document.visibilityState === "visible")
    void refresh(true).finally(schedulePoll);
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
