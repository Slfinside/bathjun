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
import {planningDemand,nextPlanningTime} from '../src/time-selection-notifications.js';
import {scheduleSegments,overlapDetails} from '../public/schedule-layout.js';
import {dashboardView} from '../src/dashboard.js';
import {migrateDurationOnlyWishes} from '../src/duration-only-wishes.js';

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

const DAY='2026-11-04';
const wish=(f,id=1,extra={})=>f.api('wish',{day:DAY,start:null,duration:30,...extra},id);
async function subscribe(f,id=1){const key=createECDH('prime256v1');key.generateKeys();const subscription={endpoint:'https://web.push.apple.com/time-choice-'+id,keys:{p256dh:key.getPublicKey().toString('base64url'),auth:randomBytes(16).toString('base64url')}};await f.api('push/subscribe',{subscription},id);return subscription}
const notices=f=>f.sent.filter(x=>x.payload.tag.startsWith('bath-time-selection-'));

test('nullable migration preserves rows, fields, indexes and triggers across restart',()=>{
 const db=new DatabaseSync(':memory:');try{
 db.exec(`CREATE TABLE schema_migrations(name TEXT PRIMARY KEY); CREATE TABLE wishes(day TEXT,member_id INTEGER,start INTEGER NOT NULL,duration INTEGER,revision TEXT,automatic INTEGER DEFAULT 0,PRIMARY KEY(day,member_id)); CREATE INDEX wish_revision_test ON wishes(revision); CREATE TABLE changes(n INTEGER); CREATE TRIGGER wish_test AFTER INSERT ON wishes BEGIN INSERT INTO changes VALUES(1); END; INSERT INTO wishes VALUES('2026-11-04',1,1080,45,'original',1)`);
 migrateDurationOnlyWishes(db);migrateDurationOnlyWishes(db);
 assert.equal(db.prepare('SELECT * FROM wishes').get().revision,'original');assert.equal(db.prepare('SELECT * FROM wishes').get().automatic,1);
 db.exec("INSERT INTO wishes VALUES('2026-11-04',2,NULL,30,'untimed',0)");assert.equal(db.prepare('SELECT COUNT(*) n FROM changes').get().n,2);assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE name='wish_revision_test'").get());
 }finally{db.close()}
});

test('duration-only wishes survive restart, never auto-book or cause a midnight overlap',async t=>{
 const f=await fixture(t);await wish(f,1,{note:'短めに入る'});await f.restart();
 let state=await f.state();assert.equal(state.wishes[0].start,null);assert.equal(state.wishes[0].duration,30);assert.equal(state.bookings.length,0);
 assert.ok(scheduleSegments([],0,1860,state.wishes).every(segment=>segment.kind!=='wish'));
 const dashboard=dashboardView(state);assert.equal(dashboard.entries.length,0);assert.equal(dashboard.untimedWishes[0].duration,30);assert.deepEqual(overlapDetails({start:null,duration:30},[{start:0,duration:30}]),[]);
 f.time('2026-11-04T23:59:00');await f.app.flushNotifications();state=await f.state();assert.equal(state.bookings.length,0);assert.equal(state.wishes.length,1);
 assert.equal(f.sql(db=>db.prepare('SELECT COUNT(*) n FROM wish_start_attempts').get().n),0);
 assert.equal(f.sql(db=>db.prepare('SELECT COUNT(*) n FROM wish_notification_jobs').get().n),0);
 await f.api('wish',{day:DAY,start:1440,duration:30},2);f.time('2026-11-05T00:00:00');await f.app.flushNotifications();assert.equal((await f.state()).bookings[0].memberId,2);
});

test('explicit null alone enables duration-only; invalid duration and direct untimed booking are rejected',async t=>{
 const f=await fixture(t);
 for(const extra of [{start:undefined},{start:'none'},{duration:0},{duration:20},{duration:105},{duration:'30'},{note:42}])assert.equal((await f.request('wish',{day:DAY,start:null,duration:30,...extra})).status,400);
 assert.equal((await f.request('book',{day:DAY,start:null,duration:30})).status,400);
 await wish(f);assert.equal((await f.api('wish',{day:DAY,start:1080,duration:30})).autoConfirmed,true);assert.equal((await f.state()).wishes.length,0);
});

test('duration-only wishes can be cancelled or replaced by standby without leaving a plan',async t=>{
 const f=await fixture(t);await wish(f);await f.api('wish/cancel',{day:DAY});assert.equal((await f.state()).wishes.length,0);
 await wish(f);await f.api('skip',{day:DAY,skip:true});assert.equal((await f.state()).wishes.length,0);
});

test('all-ready notifies only untimed members once, across restart, edits and resubscribe',async t=>{
 const f=await fixture(t),sub=await subscribe(f);await subscribe(f,2);await wish(f);await f.app.flushNotifications();assert.equal(notices(f).length,0);
 await f.api('wish',{day:DAY,start:1080,duration:30},2);await f.app.flushNotifications();assert.equal(notices(f).length,1);assert.equal(notices(f)[0].sub.endpoint,sub.endpoint);assert.match(notices(f)[0].payload.body,/そろいました/);
 await wish(f,1,{duration:45});await f.restart();await f.api('push/unsubscribe',{endpoint:sub.endpoint});await f.api('push/subscribe',{subscription:sub});await f.app.flushNotifications();assert.equal(notices(f).length,1);
 assert.equal(f.sql(db=>db.prepare('SELECT COUNT(*) n FROM time_selection_jobs').get().n),0);
});

test('capacity uses only future demand, with current remaining time and next-morning exclusion',async t=>{
 const f=await fixture(t);await wish(f,2);await f.book(1080,60,1);f.time('2026-11-04T18:30:00');
 let status=(await f.state()).nightPlanning;assert.equal(status.minutes,60);
 f.time('2026-11-04T19:01:00');assert.equal((await f.state()).nightPlanning.minutes,30);
 f.time('2026-11-04T08:00:00');await f.book(1560,60,1);assert.equal((await f.state()).nightPlanning.minutes,30);
 // A morning plan counts as answered, even though it needs no night capacity.
 assert.equal((await f.state()).nightPlanning.allReady,true);
 const settings=f.app.getServerSettings();assert.equal(settings.nightDeadline,120);f.app.saveServerSettings({...settings,schedule:settings.upcoming,nightDeadline:180});
 status=(await f.state()).nightPlanning;assert.equal(status.minutes,90);assert.equal(status.nightDeadline,180);await f.restart();assert.equal((await f.state()).nightPlanning.nightDeadline,180);
 assert.throws(()=>f.app.saveServerSettings({...settings,schedule:settings.upcoming,nightDeadline:1440}));
});

test('completed baths do not consume demand and untimed tickets are not spent before confirmation',async t=>{
 const f=await fixture(t);f.settings({extensionBlocked:false,extensionNoticeMinutes:0});f.app.distributeItems({recipients:[2],kinds:['extend'],quantity:1,requestId:'duration-extension'});
 await f.api('gifts/receive',{id:(await f.api('state?day='+DAY,undefined,2)).rewards.gifts[0].id},2);await wish(f,2,{duration:120,ticket:'extend'});
 assert.equal((await f.api('state?day='+DAY,undefined,2)).rewards.wallet.find(x=>x.kind==='extend').quantity,1);
 await f.book(1080,60,1);f.time('2026-11-04T18:10:00');const booking=(await f.state()).bookings[0];f.app.completeBath({memberId:1,day:DAY,revision:booking.revision});
 assert.equal((await f.state()).nightPlanning.minutes,120);
 await f.api('wish',{day:DAY,start:1200,duration:120,ticket:'extend'},2);assert.equal((await f.api('state?day='+DAY,undefined,2)).rewards.wallet.find(x=>x.kind==='extend').quantity,0);
});

test('capacity trigger is strict and uses a timer even without further client access',async t=>{
 const f=await fixture(t);await subscribe(f);await wish(f);f.time('2026-11-05T00:24:00');
 assert.equal((await f.state()).nightPlanning.reason,null);await f.app.flushNotifications();assert.equal(notices(f).length,0);
 assert.equal(f.app.notificationDueAt(),new Date('2026-11-05T00:24:00.001+09:00').getTime());
 f.time('2026-11-05T00:24:00.001');await f.app.flushNotifications();assert.equal(notices(f).length,1);assert.match(notices(f)[0].payload.body,/残り時間/);
 f.time('2026-11-05T02:00:00');await f.app.flushNotifications();assert.equal(notices(f).length,1);assert.equal((await f.state()).nightPlanning.reason,null);
});

test('personal opt-out and replacing a queued untimed wish cancel notification delivery',async t=>{
 const f=await fixture(t);await subscribe(f);await wish(f);await f.api('notification-preferences',{timeSelectionReminder:false});await wish(f,2);await f.app.flushNotifications();assert.equal(notices(f).length,0);
 await f.api('notification-preferences',{timeSelectionReminder:true});await f.api('wish/cancel',{day:DAY});await f.app.flushNotifications();assert.equal(notices(f).length,0);
});

test('delivery retries back off, stop after the deadline, and never schedule a busy loop',async t=>{
 let fail=true;const f=await fixture(t,{onPush:async payload=>{if(payload.tag.startsWith('bath-time-selection-')&&fail)throw Error('temporary')}});await subscribe(f);await wish(f);await wish(f,2);await f.app.flushNotifications();assert.equal(notices(f).length,1);
 const due=f.app.notificationDueAt();assert.ok(due>new Date('2026-11-04T08:00:00+09:00').getTime());await f.app.flushNotifications();assert.equal(notices(f).length,1);
 fail=false;f.time('2026-11-04T08:00:16');await f.app.flushNotifications();assert.equal(notices(f).length,2);await f.app.flushNotifications();assert.equal(notices(f).length,2);
 f.app.resetAllData({confirmation:'RESET_ALL_DATA'});assert.equal(f.sql(db=>db.prepare('SELECT COUNT(*) n FROM time_selection_receipts').get().n),0);assert.equal(f.app.getServerSettings().nightDeadline,120);
});

test('piecewise demand timer accounts for bathing slope, end events and strict equality',()=>{
 const minute=60000,plan={hasUntimed:true,allReady:false,wishMinutes:30,deadline:180*minute,expiresAt:180*minute,bookings:[{start:0,end:60*minute,duration:60}]};
 assert.deepEqual(planningDemand(plan,30*minute),{minutes:60,requiredMinutes:132,remainingMinutes:150});
 // During bathing the demand falls faster than remaining clock time. Trigger only after it ends.
 assert.equal(nextPlanningTime(plan,0),84*minute+1);
 assert.equal(nextPlanningTime({...plan,allReady:true},0),0);
 assert.equal(nextPlanningTime({...plan,hasUntimed:false},0),null);
 assert.equal(nextPlanningTime(plan,plan.expiresAt),null);
});

test('live session checks prevent sending a queued notification after another member logs out',async t=>{
 let changed=false,f;f=await fixture(t,{onPush:async payload=>{
  if(!changed&&payload.tag.startsWith('bath-time-selection-')){changed=true;const member=Number(payload.tag.split('-').at(-1));await f.api('logout',{},member===1?2:1);}
 }});await subscribe(f,1);await subscribe(f,2);await wish(f,1);await wish(f,2);await f.app.flushNotifications();assert.equal(notices(f).length,1);
});

test('no push subscriptions means no idle notification timer, and no late notices after expiry',async t=>{
 const f=await fixture(t);await wish(f,1);await wish(f,2);assert.equal(f.app.notificationDueAt(),null);
 f.time('2026-11-05T02:00:00');await subscribe(f);await f.app.flushNotifications();assert.equal(notices(f).length,0);assert.equal(f.app.notificationDueAt(),null);
});
