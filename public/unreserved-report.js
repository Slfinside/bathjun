const clock=minute=>`${String(Math.floor(minute/60)%24).padStart(2,'0')}:${String(minute%60).padStart(2,'0')}`;
const timestamp=(day,minute)=>new Date(day+'T00:00:00+09:00').getTime()+minute*60000;
export function openUnreservedReport({dialog,days,now,api,isCurrent,setBusy,onSaved}){
 if(!days?.length)return;
 const active=days.find(d=>timestamp(d.day,d.bathStart)<=now&&now<timestamp(d.day,d.bathEnd))||days.at(-1);
 const currentMinute=Math.floor((now-timestamp(active.day,0))/60000),end=Math.min(currentMinute,active.bathEnd),start=Math.max(active.bathStart,end-30);
 dialog.innerHTML=`<div class="sheet-heading"><h2 id="booking-title">予約外の入浴を報告</h2><button class="icon-button" data-action="close" aria-label="閉じる">×</button></div><p>実際に入った時間を記録します。予約や希望は変更しません。</p><form id="unreserved-form"><label for="visit-day">どの日分に記録しますか</label><select id="visit-day" name="day">${days.map(d=>`<option value="${d.day}" ${d.day===active.day?'selected':''}>${d.day}分（${clock(d.bathStart)}〜翌${clock(d.bathEnd)}）</option>`).join('')}</select><div class="visit-times"><label>入った時刻<input type="time" name="start" value="${clock(start)}" step="60" required></label><label>上がった時刻<input type="time" name="end" value="${clock(end)}" step="60" required></label></div><label>備考 <span class="optional">任意・300文字まで</span><textarea name="note" rows="3" maxlength="300"></textarea></label><p class="muted">日付の区切りより前の朝の入浴は、前日分です。時刻を確認してから報告してください。</p><p class="form-error" role="alert"></p><button class="primary" type="submit">入ったことを報告する</button></form>`;
 const form=dialog.querySelector('form'),requestId=crypto.randomUUID();
 form.addEventListener('submit',async event=>{
  event.preventDefault();if(!isCurrent()||form.dataset.sending)return;form.dataset.sending='1';setBusy(true);
  const data=new FormData(form),rule=days.find(d=>d.day===data.get('day'));
  const parse=value=>{const [h,m]=String(value).split(':').map(Number);return h*60+m;};
  let from=parse(data.get('start')),to=parse(data.get('end'));if(from<rule.bathStart)from+=1440;if(to<=from)to+=1440;
  const button=form.querySelector('button[type=submit]');button.disabled=true;form.querySelector('[role=alert]').textContent='';
  try{if(to-from>=1440)throw Error('入った時刻と上がった時刻を確認してください。');await api('unreserved-bath',{day:rule.day,start:from,duration:to-from,note:String(data.get('note')||''),requestId});if(isCurrent())await onSaved();}
  catch(error){if(isCurrent())form.querySelector('[role=alert]').textContent=error.message;}
  finally{delete form.dataset.sending;button.disabled=false;setBusy(false);}
 });
 if(!dialog.open)dialog.showModal();
}
