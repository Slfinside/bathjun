import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes,createECDH} from 'node:crypto';
import {createApp} from '../src/app.js';
import {DEFAULT_SCHEDULE,validateSchedule} from '../src/server-settings.js';
import {bathCalendar} from '../src/bath-calendar.js';
const at=value=>new Date(value+'+09:00');
async function fixture(t,{subscribe=true}={}) {
 const dir=mkdtempSync(join(tmpdir(),'bathjun-planning-')),database=join(dir,'test.sqlite');let clock=at('2026-10-27T08:00:00'),server,app,failWish=false;
 const sent=[];
 const open=()=>createApp({database,requireFamily:false,now:()=>clock,deliverPush:async(sub,payload,keys,options)=>{if(failWish&&payload.tag.startsWith('bath-wish-'))throw Object.assign(new Error('test'),{statusCode:503});sent.push({endpoint:sub.endpoint,payload,options});}});
 app=open();app.saveServerSettings({ignoreLowerPriorityWishes:false,members:[1,2,3].map(i=>({name:`利用者${i}`,active:true})),schedule:{...DEFAULT_SCHEDULE,orderMode:'fixed'}});clock=at('2026-10-28T08:00:00');
 async function listen(){server=createServer(app.handle);await new Promise(r=>server.listen(0,'127.0.0.1',r));}await listen();
 t.after(async()=>{await new Promise(r=>server.close(r));app.close();rmSync(dir,{recursive:true,force:true});});
 const cookies={};
 async function request(path,body,id=1){const r=await fetch(`http://127.0.0.1:${server.address().port}/api/${path}`,{method:body===undefined?'GET':'POST',headers:{cookie:cookies[id]||'','Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:r.status,body:await r.json(),cookie:r.headers.get('set-cookie')?.split(';')[0]};}
 async function api(path,body,id=1){const r=await request(path,body,id);assert.equal(r.status,200,JSON.stringify(r.body));return r.body;}
 for(const id of [1,2,3]){cookies[id]=(await request('register',{memberId:id,password:'test-password'},id)).cookie;if(subscribe){const key=createECDH('prime256v1');key.generateKeys();await api('push/subscribe',{subscription:{endpoint:`https://web.push.apple.com/planning-${id}`,keys:{p256dh:key.getPublicKey().toString('base64url'),auth:randomBytes(16).toString('base64url')}}},id);}}
 await api('state');await app.flushNotifications();sent.length=0;
 return {get app(){return app;},api,request,sent,setTime:value=>clock=at(value),setFailure:value=>failWish=value,
  book:(start=900,id=1,day='2026-10-28')=>api('book',{day,start,duration:30},id),
  wish:(id,start=1080,day='2026-10-28')=>api('wish',{day,start,duration:30},id),
  flush:()=>app.flushNotifications(),restart:async()=>{await new Promise(r=>server.close(r));app.close();app=open();await listen();}};
}
test('日付の切り替えは初期2時、入浴時間と独立して変更できる',()=>{
 assert.equal(DEFAULT_SCHEDULE.dayRollover,120);
 assert.equal(bathCalendar(at('2026-10-29T01:59:59')).today,'2026-10-28');
 assert.equal(bathCalendar(at('2026-10-29T02:00:00')).today,'2026-10-29');
 assert.equal(bathCalendar(at('2026-10-29T02:00:00'),420).today,'2026-10-28');
 assert.equal(bathCalendar(at('2026-10-29T07:00:00'),420).today,'2026-10-29');
 for(const value of [-1,1440,1.5,'120'])assert.throws(()=>validateSchedule({...DEFAULT_SCHEDULE,dayRollover:value}));
});
test('朝は前夜の予約確認と当日の午後の予約を並行できる',async t=>{
 const f=await fixture(t,{subscribe:false});await f.book(1800);f.setTime('2026-10-29T06:00:00');
 const previous=await f.api('state');assert.equal(previous.day,'2026-10-28');assert.equal(previous.today,'2026-10-29');assert.equal(previous.bookings[0].start,1800);
 assert.equal(f.app.getDashboard().day,'2026-10-28');
 const today=await f.api('state?day=2026-10-29');assert.ok(today.draw);await f.book(1080,1,'2026-10-29');
 assert.equal((await f.api('state?day=2026-10-28')).bookings[0].start,1800);
 assert.equal((await f.api('state?day=2026-10-29')).bookings[0].start,1080);
 f.setTime('2026-10-29T07:00:00');assert.equal((await f.api('state')).day,'2026-10-29');
});
test('日付設定は保存した翌日から適用し、入浴時間帯を変えない',async t=>{
 const f=await fixture(t,{subscribe:false}),settings=f.app.getServerSettings();
 f.app.saveServerSettings({members:settings.members,schedule:{...settings.upcoming,dayRollover:420}});
 assert.equal((await f.api('state')).dayRollover,120);
 f.setTime('2026-10-29T06:59:59');const before=await f.api('state');assert.equal(before.today,'2026-10-28');assert.equal(before.dayRollover,420);assert.equal(before.settings.bathEnd,1860);
 assert.equal((await f.api('state?day=2026-10-29')).draw,null);
 f.setTime('2026-10-29T07:00:00');const after=await f.api('state');assert.equal(after.today,'2026-10-29');assert.equal(after.day,'2026-10-29');assert.ok(after.draw);assert.equal(after.settings.bathStart,900);
});
test('2日先の希望は抽選前から共有できるが、先行抽選・予約は拒否する',async t=>{
 const f=await fixture(t);await f.wish(1,1080,'2026-10-30');const future=await f.api('state?day=2026-10-30');
 assert.equal(future.dayAfterTomorrow,'2026-10-30');assert.equal(future.draw,null);assert.equal(future.wishes.length,1);assert.equal(future.lotteryOpen,false);await f.flush();assert.equal(f.sent.length,0);
 for(const path of ['draw','book'])assert.notEqual((await f.request(path,{day:'2026-10-30',start:1080,duration:30})).status,200);
 f.setTime('2026-10-30T08:00:00');const state=await f.api('state?day=2026-10-30');assert.equal(state.bookings[0].autoConfirmed,1);await f.flush();
 assert.equal(f.sent.filter(s=>s.payload.tag.startsWith('bath-wish-wishConfirmed')).length,1);
 await f.api('state?day=2026-10-30');await f.flush();await f.restart();await f.api('state?day=2026-10-30');await f.flush();
 assert.equal(f.sent.filter(s=>s.payload.tag.startsWith('bath-wish-wishConfirmed')).length,1);
});
test('希望を確定できない通知は一度だけ、重複が解消すれば確定通知を送る',async t=>{
 const f=await fixture(t);await f.wish(2);await f.wish(3);await f.book();await f.flush();
 const failed=()=>f.sent.filter(s=>s.payload.tag.startsWith('bath-wish-wishUnconfirmed'));
 assert.equal(failed().length,1);assert.ok(failed()[0].endpoint.endsWith('-2'));
 await f.api('state');await f.api('state');await f.flush();assert.equal(failed().length,1);
 await f.api('wish/cancel',{day:'2026-10-28'},3);await f.flush();assert.equal(f.sent.filter(s=>s.payload.tag.startsWith('bath-wish-wishConfirmed')).length,1);
});
test('4種類の通知を本人が個別に無効化でき、ほかの人には影響しない',async t=>{
 const f=await fixture(t);const off={wishConfirmed:false,wishUnconfirmed:false,reservationTurn:false,bathReminder:false,reminderMinutes:25};
 await f.api('notification-preferences',off,2);assert.deepEqual((await f.api('state',undefined,2)).notificationPreferences,off);
 await f.wish(2);await f.wish(3);await f.book();await f.flush();assert.equal(f.sent.filter(s=>s.endpoint.endsWith('-2')).length,0);
 await f.api('wish/cancel',{day:'2026-10-28'},3);await f.flush();assert.equal(f.sent.filter(s=>s.endpoint.endsWith('-2')).length,0);assert.ok(f.sent.some(s=>s.endpoint.endsWith('-3')));
 f.setTime('2026-10-28T17:50:00');await f.flush();assert.equal(f.sent.filter(s=>s.payload.tag.startsWith('bath-reminder')&&s.endpoint.endsWith('-2')).length,0);
 assert.equal((await f.api('state',undefined,1)).notificationPreferences.reminderMinutes,10);
 assert.equal((await f.request('notification-preferences',{memberId:1,reminderMinutes:30},2)).status,400);
 for(const n of [0,181,1.5,'10'])assert.equal((await f.request('notification-preferences',{reminderMinutes:n},2)).status,400);
});
test('本人の通知分数を変えると未送信の予定を移動し、送信済みは再通知しない',async t=>{
 const f=await fixture(t);await f.api('notification-preferences',{reminderMinutes:25});await f.book(1080);await f.flush();
 assert.equal(f.app.notificationDueAt(),at('2026-10-28T17:35:00').getTime());
 await f.api('notification-preferences',{reminderMinutes:40});assert.equal(f.app.notificationDueAt(),at('2026-10-28T17:20:00').getTime());
 f.setTime('2026-10-28T17:20:00');await f.flush();assert.equal(f.sent.filter(s=>s.payload.tag.startsWith('bath-reminder')).length,1);
 await f.api('notification-preferences',{bathReminder:false});await f.api('notification-preferences',{bathReminder:true,reminderMinutes:50});await f.flush();assert.equal(f.sent.filter(s=>s.payload.tag.startsWith('bath-reminder')).length,1);
});
test('希望の結果通知の失敗は再起動後も再試行し、全リセットで設定も消す',async t=>{
 const f=await fixture(t);await f.wish(2);f.setFailure(true);await f.book();await f.flush();await f.restart();
 f.setFailure(false);f.setTime('2026-10-28T08:00:31');await f.flush();assert.equal(f.sent.filter(s=>s.payload.tag.startsWith('bath-wish-wishConfirmed')).length,1);
 await f.api('notification-preferences',{wishConfirmed:false});const reset=f.app.resetAllData({confirmation:'RESET_ALL_DATA'});assert.equal(reset.settings.members.length,0);assert.equal(reset.settings.current.dayRollover,120);assert.equal(f.app.notificationDueAt(),null);
});
