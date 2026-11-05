import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomBytes,createECDH} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {createApp} from '../src/app.js';
import {DEFAULT_SCHEDULE} from '../src/server-settings.js';
import {DEFAULT_NOTIFICATION_PREFERENCES} from '../src/notification-preferences.js';

async function fixture(t,{onPush=null}={}){
 const dir=mkdtempSync(join(tmpdir(),'bathjun-rebooking-')),database=join(dir,'test.sqlite');
 const sent=[];
 let clock=new Date('2026-11-03T08:00:00+09:00'),app,server;
 const open=()=>createApp({database,requireFamily:false,now:()=>clock,deliverPush:async(sub,payload,keys,options)=>{sent.push({sub,payload,options});if(onPush)await onPush(payload)}});
 app=open();app.saveServerSettings({members:[{name:'利用者A',active:true},{name:'利用者B',active:true}],schedule:{...DEFAULT_SCHEDULE,orderMode:'fixed'}});clock=new Date('2026-11-04T08:00:00+09:00');
 const listen=async()=>{server=createServer(app.handle);await new Promise(r=>server.listen(0,'127.0.0.1',r))};await listen();
 t.after(async()=>{await new Promise(r=>server.close(r));app.close();rmSync(dir,{recursive:true,force:true})});
 const cookies={};
 const request=async(path,body,id=1)=>{const r=await fetch(`http://127.0.0.1:${server.address().port}/api/${path}`,{method:body===undefined?'GET':'POST',headers:{cookie:cookies[id]||'','Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:r.status,body:await r.json(),cookie:r.headers.get('set-cookie')?.split(';')[0]}};
 const api=async(path,body,id=1)=>{const r=await request(path,body,id);assert.equal(r.status,200,JSON.stringify(r.body));return r.body};
 for(const id of [1,2])cookies[id]=(await request('register',{memberId:id,password:'test-only'},id)).cookie;
 await api('state');
 return {get app(){return app},database,api,request,sent,time:value=>clock=new Date(value+'+09:00'),state:(day='2026-11-04')=>api('state?day='+day),book:(start=1080,duration=30,id=1,extra={})=>api('book',{day:'2026-11-04',start,duration,...extra},id),
  settings:value=>app.saveRewardSettings({...app.getRewardsAdmin().settings,...value}),
  restart:async()=>{await new Promise(r=>server.close(r));app.close();app=open();await listen()},
  sql:fn=>{const db=new DatabaseSync(database);try{return fn(db)}finally{db.close()}}};
}

test('初期はクライアント報告を禁止し、通知は指定の5種類だけ有効にする',async t=>{
 const f=await fixture(t);const state=await f.state();assert.equal(state.rewards.settings.clientReportEnabled,false);
 assert.deepEqual(state.notificationPreferences,DEFAULT_NOTIFICATION_PREFERENCES);
 assert.deepEqual(Object.entries(state.notificationPreferences).filter(([key,value])=>typeof value==='boolean'&&value).map(([key])=>key).sort(),['nudge','wishUnconfirmed','bathReminder','completionReminder','timeSelectionReminder'].sort());
 await f.api('notification-preferences',{wishConfirmed:true});await f.restart();assert.equal((await f.state()).notificationPreferences.wishConfirmed,true);
 await f.book();const booking=(await f.state()).bookings[0];f.time('2026-11-04T18:10:00');
 for(const source of [undefined,'dashboard'])assert.equal((await f.request('complete',{day:'2026-11-04',revision:booking.revision,source})).status,403);
 assert.deepEqual(f.app.completeBath({memberId:1,day:'2026-11-04',revision:booking.revision}),{ok:true});
 assert.equal((await f.state()).rewards.card.days.find(d=>d.day==='2026-11-04').status,'stamp');
});

test('クライアント報告を明示的に許可・禁止でき、完了記録は保持する',async t=>{
 const f=await fixture(t);f.settings({clientReportEnabled:true});await f.book();const booking=(await f.state()).bookings[0];f.time('2026-11-04T18:32:00');
 await f.api('complete',{day:'2026-11-04',revision:booking.revision});f.settings({clientReportEnabled:false});await f.restart();
 assert.equal((await f.state()).bookings[0].completedAt!==null,true);
 assert.throws(()=>f.settings({clientReportEnabled:'true'}));
});

test('有効な報告経路の期限を過ぎてからのみ再予約を提案し、入浴中と報告済みは除く',async t=>{
 const f=await fixture(t);await f.book();const old=(await f.state()).bookings[0];
 for(const value of ['2026-11-04T18:10:00','2026-11-04T18:31:00']){f.time(value);assert.equal((await f.state()).unreportedBooking,null)}
 f.time('2026-11-04T18:31:00.001');assert.equal((await f.state()).unreportedBooking.revision,old.revision);
 f.settings({clientReportEnabled:true,clientReportMinutes:3,dashboardReportMinutes:5});assert.equal((await f.state()).unreportedBooking,null);
 f.time('2026-11-04T18:35:01');assert.equal((await f.state()).unreportedBooking.revision,old.revision);
 assert.equal((await f.request('book',{day:'2026-11-04',start:1200,duration:30})).status,409);
});

test('再予約の確認は端末間・再起動後に重複せず、元の予約を消さない',async t=>{
 const f=await fixture(t);await f.book();const old=(await f.state()).bookings[0];f.time('2026-11-04T18:32:00');
 assert.equal((await f.state()).unreportedBooking.prompted,false);
 const payload={day:'2026-11-04',revision:old.revision,decision:'later'};
 assert.equal((await f.request('rebooking/prompt',{...payload,memberId:1},2)).status,409);
 await f.api('rebooking/prompt',payload);await f.api('rebooking/prompt',payload);await f.restart();
 assert.equal((await f.state()).unreportedBooking.prompted,true);assert.equal((await f.state()).bookings[0].revision,old.revision);
});

test('再予約の失敗は元の枠と履歴を保ち、成功時だけ保存・再送時は二重適用しない',async t=>{
 const f=await fixture(t);await f.book();await f.book(1200,30,2);const old=(await f.state()).bookings.find(b=>b.memberId===1);f.time('2026-11-04T18:32:00');
 const body={day:'2026-11-04',start:1200,duration:30,rebookRevision:old.revision};
 assert.equal((await f.request('book',body)).status,409);
 assert.equal((await f.state()).bookings.find(b=>b.memberId===1).revision,old.revision);
 assert.equal(f.sql(db=>db.prepare('SELECT COUNT(*) n FROM rebooking_history').get().n),0);
 body.start=1260;await f.api('book',body);const replacement=(await f.state()).bookings.find(b=>b.memberId===1);
 assert.notEqual(replacement.revision,old.revision);assert.equal(replacement.start,1260);await f.api('book',body);
 assert.equal((await f.state()).bookings.find(b=>b.memberId===1).revision,replacement.revision);
 assert.equal(f.sql(db=>db.prepare('SELECT COUNT(*) n FROM rebooking_history').get().n),1);
 assert.equal((await f.request('book',{...body,start:1320})).status,409);
});

test('再予約に消費済み延長は引き継がず、新しいチケットを消費し再送では消費しない',async t=>{
 const f=await fixture(t);f.settings({extensionBlocked:false,extensionNoticeMinutes:0});
 f.app.distributeItems({recipients:[1],kinds:['extend'],quantity:2,requestId:'rebooking-test-extend'});
 const gift=(await f.state()).rewards.gifts[0];await f.api('gifts/receive',{id:gift.id});
 await f.book(1080,120,1,{ticket:'extend'});const old=(await f.state()).bookings[0];f.time('2026-11-04T20:02:00');
 assert.equal((await f.request('book',{day:'2026-11-04',start:1320,duration:120,rebookRevision:old.revision})).status,400);
 f.settings({extensionMinutes:60});const body={day:'2026-11-04',start:1320,duration:150,rebookRevision:old.revision,ticket:'extend'};
 await f.api('book',body);await f.api('book',body);
 const state=await f.state();assert.equal(state.bookings[0].ticketExtension,60);assert.equal(state.rewards.wallet.find(x=>x.kind==='extend').quantity,0);
 const saved=f.sql(db=>db.prepare('SELECT old_booking_json FROM rebooking_history').get());assert.equal(JSON.parse(saved.old_booking_json).ticket_extension,30);
});

test('翌朝は前日分を提案し、区切りまでに新たな開始時刻を選べない場合は提案しない',async t=>{
 const f=await fixture(t);await f.book(1800,30);f.time('2026-11-05T06:32:00');
 const offer=(await f.state('2026-11-05')).unreportedBooking;assert.equal(offer.day,'2026-11-04');
 f.time('2026-11-05T06:59:00');assert.equal((await f.state('2026-11-05')).unreportedBooking,null);
 f.time('2026-11-05T07:00:00');assert.equal((await f.state('2026-11-05')).unreportedBooking,null);
 assert.equal((await f.request('book',{day:'2026-11-04',start:1845,duration:30,rebookRevision:offer.revision})).status,409);
});


test('クライアント報告がオフなら通知はダッシュボードを案内し、その期限で判定する',async t=>{
 const f=await fixture(t),key=createECDH('prime256v1');key.generateKeys();
 await f.api('push/subscribe',{subscription:{endpoint:'https://web.push.apple.com/report-dashboard-only',keys:{p256dh:key.getPublicKey().toString('base64url'),auth:randomBytes(16).toString('base64url')}}});
 f.settings({clientReportMinutes:180,dashboardReportMinutes:1});await f.book();f.time('2026-11-04T18:30:00');await f.app.flushNotifications();
 const reminders=f.sent.filter(x=>x.payload.tag.startsWith('bath-completion-'));assert.equal(reminders.length,1);assert.match(reminders[0].payload.body,/ダッシュボード/);assert.equal(reminders[0].options.ttl,60);
 f.time('2026-11-04T18:31:01');assert.equal((await f.state()).rewards.card.days.find(d=>d.day==='2026-11-04').status,'failed');
 // Enlarging the window after it expired must not send the same notification again.
 await f.app.flushNotifications();f.settings({dashboardReportMinutes:10});await f.app.flushNotifications();
 assert.equal(f.sent.filter(x=>x.payload.tag.startsWith('bath-completion-')).length,1);
});

test('旧様子見設定の保存に失敗したときは曜日設定の書き換えも取り消す',async t=>{
 const f=await fixture(t),defaults=(await f.api('auto-wishes')).days;
 const days=defaults.map(d=>({...d,mode:d.weekday===5?'standby':'disabled'}));await f.api('auto-wishes',{days});
 f.sql(db=>db.exec("CREATE TRIGGER fail_standby_update BEFORE UPDATE OF auto_standby ON members BEGIN SELECT RAISE(ABORT,'test_write_failed'); END"));
 const result=await f.request('auto-standby',{enabled:true});assert.notEqual(result.status,200);
 assert.deepEqual((await f.api('auto-wishes')).days,days);
 f.sql(db=>db.exec('DROP TRIGGER fail_standby_update'));
});


test('送信中に報告期限を短縮・延長してキューを作り直しても完了通知は重複しない',async t=>{
 let changed=false,f;
 f=await fixture(t,{onPush:async payload=>{
  if(changed||!payload.tag.startsWith('bath-completion-'))return;
  changed=true;f.time('2026-11-04T18:32:00');f.settings({dashboardReportMinutes:1});f.settings({dashboardReportMinutes:10});
 }});
 const key=createECDH('prime256v1');key.generateKeys();
 await f.api('push/subscribe',{subscription:{endpoint:'https://web.push.apple.com/completion-inflight',keys:{p256dh:key.getPublicKey().toString('base64url'),auth:randomBytes(16).toString('base64url')}}});
 await f.book();f.time('2026-11-04T18:30:00');await f.app.flushNotifications();await f.app.flushNotifications();
 assert.equal(f.sent.filter(x=>x.payload.tag.startsWith('bath-completion-')).length,1);
});


test('購読解除・再登録・再起動でも同じ予約の完了通知を再送しない',async t=>{
 const f=await fixture(t),key=createECDH('prime256v1');key.generateKeys();
 const subscription={endpoint:'https://web.push.apple.com/completion-resubscribe',keys:{p256dh:key.getPublicKey().toString('base64url'),auth:randomBytes(16).toString('base64url')}};
 await f.api('push/subscribe',{subscription});await f.book();f.time('2026-11-04T18:30:00');await f.app.flushNotifications();
 assert.equal(f.sent.filter(x=>x.payload.tag.startsWith('bath-completion-')).length,1);
 await f.api('push/unsubscribe',{endpoint:subscription.endpoint});await f.api('push/subscribe',{subscription});await f.restart();await f.app.flushNotifications();
 assert.equal(f.sent.filter(x=>x.payload.tag.startsWith('bath-completion-')).length,1);
 f.app.resetAllData({confirmation:'RESET_ALL_DATA'});
 assert.equal(f.sql(db=>db.prepare('SELECT COUNT(*) n FROM completion_notice_receipts').get().n),0);
});
