// Loaded only when the stamp picker is opened.
export function stampPickerMarkup({card,previousWeek,currentWeek,stampable,ink}){
 return `<div class="sheet-heading"><h2 id="booking-title">おふろスタンプを押す</h2><button class="icon-button" data-action="close" aria-label="閉じる">×</button></div><div class="gift-tabs"><button data-action="stamp-week" data-stamp-week="${previousWeek}" aria-pressed="${card.week === previousWeek}">先週</button><button data-action="stamp-week" data-stamp-week="${currentWeek}" aria-pressed="${card.week === currentWeek}">今週</button></div><p>今日までの「−」または「×」の日を選んでください。インクを1個使って成功にします。</p><p class="muted">${card.week}からの7日間 · インク ${ink}個</p><div class="stamp-repair-days">${stampable.map((d) => `<button class="stamp-repair-day" data-action="apply-stamp" data-stamp-day="${d.day}" data-request-id="${crypto.randomUUID()}"><span>${d.day.slice(5).replace("-", "/")}（${"日月火水木金土"[new Date(d.day + "T12:00:00Z").getUTCDay()]}）</span><strong aria-hidden="true">${d.status === "failed" ? "×" : "−"}</strong><span>スタンプを押す</span></button>`).join("")}</div>${stampable.length ? "" : '<p class="notice">この週はスタンプを押せる日がありません。</p>'}`;
}

export async function loadStampPicker({api,today,preferredWeek,currentRequest}){
 const current=await api('rewards?day='+encodeURIComponent(today));
 if(!currentRequest())return null;
 const previousWeek=new Date(Date.parse(current.card.week+'T12:00:00Z')-7*86400000).toISOString().slice(0,10);
 const previous=await api('rewards?week='+previousWeek);
 if(!currentRequest())return null;
 const card=preferredWeek===previousWeek?previous.card:current.card;
 return stampPickerMarkup({card,previousWeek,currentWeek:current.card.week,stampable:card.days.filter(d=>d.status!=='stamp'&&d.day<=today),ink:current.wallet.find(x=>x.kind==='stampInk').quantity});
}
