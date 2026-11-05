import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {randomBytes,createECDH} from 'node:crypto';
import {createApp} from '../src/app.js';
import {DEFAULT_SCHEDULE} from '../src/server-settings.js';
const at=time=>new Date('2026-10-28T'+time+'+09:00');
async function fixture(t) {
 const directory=mkdtempSync(join(tmpdir(),'bathjun-reminder-')),database=join(directory,'test.sqlite');
 let clock=new Date('2026-10-27T08:00:00+09:00'),app,server,failure=0,hook=null,wakes=0;
 const sent=[],attempts=[];
 const open=()=>createApp({database,requireFamily:false,now:()=>clock,onNotificationQueued:()=>wakes++,deliverPush:async(sub,payload,keys,options)=>{if(!payload.tag.startsWith('bath-reminder'))return;attempts.push({sub,payload,options});if(hook)await hook(payload);if(failure)throw Object.assign(new Error('test'),{statusCode:failure});sent.push({sub,payload,options});}});
 app=open();app.saveServerSettings({members:[1,2].map(i=>({name:`利用者${i}`,active:true})),schedule:{...DEFAULT_SCHEDULE,orderMode:'fixed'}});clock=at('08:00:00');
 async function listen(){server=createServer(app.handle);await new Promise(r=>server.listen(0,'127.0.0.1',r));}await listen();
 t.after(async()=>{await new Promise(r=>server.close(r));app.close();rmSync(directory,{recursive:true,force:true});});
 async function api(path,body,cookie='') {const r=await fetch(`http://127.0.0.1:${server.address().port}/api/${path}`,{method:body===undefined?'GET':'POST',headers:{cookie,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});const result=await r.json();assert.equal(r.status,200,JSON.stringify(result));return {body:result,cookie:r.headers.get('set-cookie')?.split(';')[0]};}
 const cookies={};for(const id of [1,2])cookies[id]=(await api('register',{memberId:id,password:'test-password'})).cookie;
 // These tests isolate the pre-bath reminder queue; end-of-bath notifications have separate coverage.
 for(const id of [1,2])await api('notification-preferences',{completionReminder:false},cookies[id]);
 async function subscribe(id,name=String(id)) {const key=createECDH('prime256v1');key.generateKeys();const subscription={endpoint:`https://web.push.apple.com/test-${name}`,keys:{p256dh:key.getPublicKey().toString('base64url'),auth:randomBytes(16).toString('base64url')}};await api('push/subscribe',{subscription},cookies[id]);return subscription;}
 return {get app(){return app;},api,cookies,subscribe,sent,attempts,database,get wakes(){return wakes;},setTime:value=>clock=typeof value==='string'?new Date(value):value,setFailure:value=>failure=value,setHook:value=>hook=value,
  book:async(start=1080,id=1)=>api('book',{day:'2026-10-28',start,duration:30},cookies[id]),
  flush:()=>app.flushNotifications(),
  restart:async change=>{await new Promise(r=>server.close(r));app.close();if(change){const db=new DatabaseSync(database);try{change(db);}finally{db.close();}}app=open();await listen();}
 };
}
test('予約10分前に本人の端末だけへ1回通知し、画面更新・再登録でも重複しない',async t=>{
 const f=await fixture(t),first=await f.subscribe(1);await f.subscribe(2);await f.book();await f.flush();assert.equal(f.app.notificationDueAt(),at('17:50:00').getTime());
 f.setTime(at('17:49:59'));await f.flush();assert.equal(f.sent.length,0);
 f.setTime(at('17:50:00'));await f.flush();assert.equal(f.sent.length,1);assert.equal(f.sent[0].sub.endpoint,first.endpoint);assert.match(f.sent[0].payload.body,/18:00.*約10分/);assert.equal(f.sent[0].payload.day,'2026-10-28');assert.equal(f.sent[0].options.ttl,600);
 await f.flush();await f.api('state',undefined,f.cookies[1]);await f.api('push/subscribe',{subscription:first},f.cookies[1]);await f.flush();assert.equal(f.sent.length,1);assert.equal(f.app.notificationDueAt(),null);
});
test('予約の時刻変更で旧通知を取り消し、新しい時刻の10分前に通知',async t=>{
 const f=await fixture(t);await f.subscribe(1);await f.book();await f.book(1140);await f.flush();assert.equal(f.app.notificationDueAt(),at('18:50:00').getTime());
 f.setTime(at('17:50:00'));await f.flush();assert.equal(f.sent.length,0);f.setTime(at('18:50:00'));await f.flush();assert.equal(f.sent.length,1);assert.match(f.sent[0].payload.body,/19:00/);
});
test('備考だけの変更では送信済み通知を復活させず、再起動後も送信済みを保持',async t=>{
 const f=await fixture(t);await f.subscribe(1);await f.book();f.setTime(at('17:50:00'));await f.flush();assert.equal(f.sent.length,1);
 await f.api('book',{day:'2026-10-28',start:1080,duration:30,note:'備考を変更'},f.cookies[1]);await f.flush();await f.restart();await f.flush();assert.equal(f.sent.length,1);assert.equal(f.app.notificationDueAt(),null);
});
test('キャンセル・様子見・ログアウト・通知解除で予約前通知を取り消す',async t=>{
 for(const action of ['cancel','skip','logout','unsubscribe'])await t.test(action,async sub=>{
  const f=await fixture(sub),subscription=await f.subscribe(1);await f.book();await f.flush();
  if(action==='unsubscribe')await f.api('push/unsubscribe',{endpoint:subscription.endpoint},f.cookies[1]);else await f.api(action,{day:'2026-10-28',skip:true},f.cookies[1]);
  await f.flush();assert.equal(f.app.notificationDueAt(),null);f.setTime(at('17:50:00'));await f.flush();assert.equal(f.sent.length,0);
 });
});
test('予約確定時に10分を切っていれば即時通知し、通知登録が遅れた場合も対応',async t=>{
 for(const order of ['subscribe-first','book-first'])await t.test(order,async sub=>{
  const f=await fixture(sub);
  if(order==='subscribe-first'){await f.subscribe(1);f.setTime(at('17:55:00'));await f.book();}else{await f.book();f.setTime(at('17:55:00'));await f.subscribe(1);}
  await f.flush();assert.equal(f.sent.length,1);assert.match(f.sent[0].payload.body,/約5分/);assert.equal(f.sent[0].options.ttl,300);
 });
});
test('開始済みの予約は、遅延起動や後からの通知登録でも送らない',async t=>{
 const f=await fixture(t);await f.subscribe(1);await f.book();f.setTime(at('18:00:00'));await f.restart();await f.flush();assert.equal(f.sent.length,0);assert.equal(f.app.notificationDueAt(),null);await f.subscribe(1,'new-device');await f.flush();assert.equal(f.sent.length,0);
});
test('翌日早朝の予約も日本時間で10分前に送り、元の夜の日付を開く',async t=>{
 const f=await fixture(t);await f.subscribe(1);await f.book(1455);await f.flush();assert.equal(f.app.notificationDueAt(),new Date('2026-10-29T00:05:00+09:00').getTime());
 f.setTime('2026-10-29T00:05:00+09:00');await f.flush();assert.equal(f.sent.length,1);assert.match(f.sent[0].payload.body,/翌00:15/);assert.equal(f.sent[0].payload.day,'2026-10-28');
});
test('自動確定した事前希望も通知対象とし、未確定の希望は送らない',async t=>{
 const f=await fixture(t);await f.subscribe(2);await f.api('wish',{day:'2026-10-28',start:1200,duration:30},f.cookies[2]);await f.flush();assert.equal(f.sent.length,0);assert.equal(f.app.notificationDueAt(),at('20:00:00').getTime());
 await f.book();await f.flush();assert.equal(f.app.notificationDueAt(),at('19:50:00').getTime());f.setTime(at('19:50:00'));await f.flush();assert.equal(f.sent.length,1);assert.match(f.sent[0].payload.body,/利用者2.*20:00/);
});
test('サーバー再起動後に予約と通知予定を復元し、旧データへの導入でも予約を保持',async t=>{
 const f=await fixture(t);await f.subscribe(1);await f.book();await f.flush();await f.restart(db=>db.exec('DROP TABLE booking_reminders'));
 assert.equal(f.app.notificationDueAt(),at('17:50:00').getTime());f.setTime(at('17:50:00'));await f.flush();assert.equal(f.sent.length,1);await f.restart();await f.flush();assert.equal(f.sent.length,1);
});
test('失敗は再送し、予約開始時には期限切れにして送信を止める',async t=>{
 const f=await fixture(t);await f.subscribe(1);await f.book();f.setFailure(503);f.setTime(at('17:50:00'));await f.flush();assert.equal(f.attempts.length,1);assert.equal(f.app.notificationDueAt(),at('17:50:30').getTime());
 f.setFailure(0);f.setTime(at('17:50:30'));await f.flush();assert.equal(f.sent.length,1);assert.equal(f.sent[0].options.ttl,570);assert.equal(f.app.notificationDueAt(),null);
 await f.book(1095);f.setFailure(503);f.setTime(at('18:05:00'));await f.flush();assert.equal(f.attempts.length,3);f.setTime(at('18:15:00'));await f.flush();assert.equal(f.attempts.length,3);assert.equal(f.app.notificationDueAt(),null);
});
test('無効な通知先・利用停止・全リセットで予定を消去する',async t=>{
 for(const action of ['gone','inactive','reset'])await t.test(action,async sub=>{
  const f=await fixture(sub);await f.subscribe(1);await f.book();await f.flush();
  if(action==='gone')f.setFailure(410);
  if(action==='inactive'){const settings=f.app.getServerSettings();f.app.saveServerSettings({members:settings.members.map(m=>({...m,active:m.id!==1})),schedule:settings.upcoming});}
  if(action==='reset')f.app.resetAllData({confirmation:'RESET_ALL_DATA'});
  f.setTime(at('17:50:00'));await f.flush();assert.equal(f.sent.length,0);assert.equal(f.app.notificationDueAt(),null);
 });
});
test('同じ本人の複数端末へ通知し、送信中の時刻変更が新しい予定を消さない',async t=>{
 const f=await fixture(t);await f.subscribe(1,'device-a');await f.subscribe(1,'device-b');await f.book();f.setTime(at('17:50:00'));let changed=false;
 f.setHook(async()=>{if(!changed){changed=true;await f.book(1110);}});await f.flush();assert.equal(f.app.notificationDueAt(),at('18:20:00').getTime());f.setHook(null);f.setTime(at('18:20:00'));await f.flush();assert.equal(f.sent.filter(s=>s.payload.body.includes('18:30')).length,2);assert.equal(f.app.notificationDueAt(),null);
});

test('通知送信中に何分前かを変えても、同じ開始時刻の通知は二重に送らない',async t=>{
 const f=await fixture(t);await f.subscribe(1);await f.book();f.setTime(at('17:50:00'));
 let changed=false;f.setHook(async()=>{if(!changed){changed=true;await f.api('notification-preferences',{reminderMinutes:20},f.cookies[1])}});
 await f.flush();f.setHook(null);await f.flush();assert.equal(f.sent.length,1);
});

test('複数端末への通知送信中に直前通知へ変更したら、未送信端末は新しい時刻まで待つ',async t=>{
 const f=await fixture(t);await f.subscribe(1,'lead-a');await f.subscribe(1,'lead-b');await f.book();f.setTime(at('17:50:00'));
 let changed=false;f.setHook(async()=>{if(!changed){changed=true;await f.api('notification-preferences',{reminderMinutes:1},f.cookies[1])}});
 await f.flush();f.setHook(null);assert.equal(f.sent.length,1);assert.equal(f.app.notificationDueAt(),at('17:59:00').getTime());
 f.setTime(at('17:59:00'));await f.flush();assert.equal(f.sent.length,2);assert.match(f.sent[1].payload.body,/約1分/);
});

test('複数端末への通知送信中に時計が戻っても、残りの端末へ早く通知しない',async t=>{
 const f=await fixture(t);await f.subscribe(1,'clock-a');await f.subscribe(1,'clock-b');await f.book();f.setTime(at('17:50:00'));
 let changed=false;f.setHook(()=>{if(!changed){changed=true;f.setTime(at('17:40:00'))}});
 await f.flush();f.setHook(null);assert.equal(f.sent.length,1);assert.equal(f.app.notificationDueAt(),at('17:50:00').getTime());
 f.setTime(at('17:50:00'));await f.flush();assert.equal(f.sent.length,2);
});

test('通知送信中にログアウトしたら、残りの端末には送信しない',async t=>{
 const f=await fixture(t);await f.subscribe(1,'logout-a');await f.subscribe(1,'logout-b');await f.book();f.setTime(at('17:50:00'));
 let changed=false;f.setHook(async()=>{if(!changed){changed=true;await f.api('logout',{},f.cookies[1])}});
 await f.flush();assert.equal(f.sent.length,1);assert.equal(f.app.notificationDueAt(),null);
});
