// Loaded only when a guide is opened. No external scripts or account data.
let contentPromise, guide;
const button = (label, className = "") => {
  const node = document.createElement("button");
  node.type = "button";
  node.textContent = label;
  node.className = className;
  return node;
};
export async function openGuide(topic, { onboarding = false, rules = {} } = {}) {
  contentPromise ||= fetch("/help/content.json")
    .then((response) => {
      if (!response.ok)
        throw Error("ガイドを読み込めませんでした。もう一度お試しください。");
      return response.json();
    })
    .catch((error) => {
      contentPromise = null;
      throw error;
    });
  const entry = (await contentPromise)[topic];
  if (!entry) throw Error("ガイドが見つかりません。");
  guide ||= Object.assign(document.createElement("dialog"), {
    className: "guide-dialog",
  });
  if (guide.open) return;
  const opener = document.activeElement;
  const heading = document.createElement("div");
  heading.className = "sheet-heading";
  const title = document.createElement("h2");
  title.id = "guide-title";
  title.textContent = onboarding ? "はじめてのふろきゅ～" : entry.title;
  const close = button("×", "icon-button");
  close.setAttribute("aria-label", "ガイドを閉じる");
  close.onclick = () => guide.close();
  heading.append(title, close);
  const intro = document.createElement("p");
  intro.className = "muted";
  intro.textContent = entry.intro;
  const steps = document.createElement("ol");
  steps.className = "guide-steps";
  for (const step of entry.steps) {
    const li = document.createElement("li"),
      h = document.createElement("h3"),
      p = document.createElement("p");
    h.textContent = step.title;
    p.textContent = step.text;
    li.append(h, p);
    steps.append(li);
  }
  const details = document.createElement("details");
  details.className = "guide-details";
  const summary = document.createElement("summary");
  summary.textContent = "詳細を見る";
  details.append(summary);
  const extra = [];
  if (topic === "autoStandby" && Number.isInteger(rules.standbyFailureDays))
    extra.push({ title: "現在の設定", text: `${rules.standbyFailureDays}日連続で入浴しないと、その連続した日が失敗になります。入力した時点では判定しません。` });
  if (topic === "stamps" && Number.isInteger(rules.clientReportMinutes) && Number.isInteger(rules.dashboardReportMinutes))
    extra.push({ title: "現在の報告期限", text: `予約終了後、本人の画面では${rules.clientReportMinutes}分以内、サーバーのダッシュボードでは${rules.dashboardReportMinutes}分以内に報告してください。予約終了前でも、上がった時点で報告できます。` });
  for (const item of [...extra, ...entry.details]) {
    const h = document.createElement("h3"),
      p = document.createElement("p");
    h.textContent = item.title;
    p.textContent = item.text;
    details.append(h, p);
  }
  const done = button(onboarding ? "はじめる" : "閉じる", "primary");
  done.onclick = () => guide.close();
  guide.replaceChildren(heading, intro, steps, details, done);
  guide.setAttribute("aria-labelledby", title.id);
  document.body.append(guide);
  guide.showModal();
  guide.scrollTop = 0;
  return new Promise((resolve) =>
    guide.addEventListener(
      "close",
      () => {
        if (opener?.isConnected) opener.focus();
        else document.querySelector(".profile-button")?.focus();
        resolve();
      },
      { once: true },
    ),
  );
}
