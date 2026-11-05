// The report sheets are loaded only when the user opens a report.
export function bathReportMarkup({day,start,end,canComplete,confirm}){
 const heading=confirm?'入っていないと報告しますか？':'入浴の報告';
 return `<div class="sheet-heading"><h2 id="booking-title">${heading}</h2><button class="icon-button" data-action="close" aria-label="閉じる">×</button></div><p>${day}分 · ${start}〜${end}</p>${confirm?'<p>この予約を「入っていない」と記録します。確定後は完了へ変更できません。その日分の受付が続いていれば、予約を取り直せます。</p>':'<p>この予約のおふろに入りましたか？</p>'}<p class="form-error" data-bath-error role="alert"></p>${confirm?'<button class="primary" data-bath-confirm>入っていないと確定</button><button class="cancel-booking" data-action="close">キャンセル</button>':`${canComplete?'<button class="primary" data-bath-complete>完了を報告</button>':''}<button class="secondary" data-bath-missed>入っていない</button><button class="cancel-booking" data-bath-later>後で報告する</button>`}`;
}
