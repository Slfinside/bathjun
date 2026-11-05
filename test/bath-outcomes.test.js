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
import {dashboardView} from '../src/dashboard.js';

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
  relogin:async id=>{cookies[id]=(await request('login',{memberId:id,password:'test-only'},id)).cookie},
  settings:value=>app.saveRewardSettings({...app.getRewardsAdmin().settings,...value}),
  restart:async()=>{await new Promise(r=>server.close(r));app.close();app=open();await listen()},
  sql:fn=>{const db=new DatabaseSync(database);try{return fn(db)}finally{db.close()}}};
}

const DAY='2026-11-04';
async function missed(f,booking,id=1){return f.api('not-bathed',{day:DAY,revision:booking.revision,confirmed:true},id)}
test('completion has no upper deadline, but still checks ownership, toggle, revision and start',async t=>{
 const f=await fixture(t);await f.book();const booking=(await f.state()).bookings[0];
 assert.throws(()=>f.app.completeBath({memberId:1,day:DAY,revision:booking.revision}));f.time('2026-11-05T07:00:00');assert.equal((await f.state()).rewards.card.days.find(d=>d.day===DAY).status,'failed');
 f.time('2026-12-01T12:00:00');assert.equal((await f.request('complete',{day:DAY,revision:booking.revision})).status,403);f.settings({clientReportEnabled:true});await f.api('complete',{day:DAY,revision:booking.revision});await f.api('complete',{day:DAY,revision:booking.revision});
 const card=await f.api('rewards?week=2026-11-01');assert.ok(card);assert.equal(f.sql(db=>db.prepare('SELECT COUNT(*) n FROM bath_completions').get().n),1);
});
test('unreported is pending until the booking-day boundary, explicit non-entry fails immediately',async t=>{
 const f=await fixture(t);await f.book();const booking=(await f.state()).bookings[0];f.time('2026-11-04T18:32:00');assert.equal((await f.state()).rewards.card.days.find(d=>d.day===DAY).status,'pending');
 assert.equal((await f.request('not-bathed',{day:DAY,revision:booking.revision})).status,400);assert.equal((await f.request('not-bathed',{day:DAY,revision:booking.revision,confirmed:true},2)).status,409);
 await missed(f,booking);await missed(f,booking);assert.equal((await f.state()).rewards.card.days.find(d=>d.day===DAY).status,'failed');assert.ok((await f.state()).bookings[0].notBathedAt);assert.throws(()=>f.app.completeBath({memberId:1,day:DAY,revision:booking.revision}));
});
test('confirmed non-entry permits immediate rebooking, preserves old crossed entries and rejects stale replays',async t=>{
 const f=await fixture(t);await f.book(1080,60);const old=(await f.state()).bookings[0];f.time('2026-11-04T18:10:00');
 assert.equal((await f.request('book',{day:DAY,start:1200,duration:30,rebookRevision:old.revision})).status,409);await missed(f,old);assert.equal((await f.state()).unreportedBooking.canRebook,true);
 const body={day:DAY,start:1200,duration:30,rebookRevision:old.revision};await f.api('book',body);await f.api('book',body);await f.restart();const state=await f.state();assert.equal(state.bookingHistory.length,1);assert.ok(state.bookingHistory[0].notBathedAt);assert.equal(state.bookings[0].notBathedAt,null);assert.notEqual(state.bookings[0].revision,old.revision);
 assert.equal((await f.request('not-bathed',{day:DAY,revision:old.revision,confirmed:true})).status,409);const dashboard=dashboardView(f.app.getDashboard());assert.equal(dashboard.entries.length,2);assert.equal(dashboard.next.memberId,1);
});
test('a non-entry slot is reusable by others and does not show a conflict or a bathing person',async t=>{
 const f=await fixture(t);await f.book(1080,60);const old=(await f.state()).bookings[0];f.time('2026-11-04T18:01:00');assert.equal((await f.request('book',{day:DAY,start:1095,duration:30},2)).status,409);await missed(f,old);await f.book(1095,30,2);
 const view=dashboardView(f.app.getDashboard());assert.equal(view.current,null);assert.equal(view.next.memberId,2);assert.ok(view.entries.every(e=>e.overlaps.length===0));assert.equal((await f.state()).nightPlanning.minutes,30);
});
test('outstanding reports from arbitrarily old days remain accessible without exposing other members',async t=>{
 const f=await fixture(t);await f.book();await f.book(1200,30,2);f.time('2027-02-01T10:00:00');await f.relogin(1);await f.relogin(2);const mine=(await f.api('bath-reports')).reports,other=(await f.api('bath-reports',undefined,2)).reports;assert.equal(mine.length,1);assert.equal(mine[0].memberId,1);assert.equal(other[0].memberId,2);assert.equal(f.app.getDashboard().pendingReports.length,2);
});
test('a late success also resolves an earlier standby day and does not duplicate weekly rewards',async t=>{
 const f=await fixture(t);f.sql(db=>db.prepare('INSERT INTO bath_skips(day,member_id,tail_order) VALUES(?,?,?)').run('2026-11-03',1,1));await f.book();const booking=(await f.state()).bookings[0];f.time('2026-11-05T07:00:00');let card=(await f.state()).rewards.card;assert.equal(card.days.find(d=>d.day==='2026-11-03').status,'failed');
 f.time('2026-11-05T10:00:00');f.app.completeBath({memberId:1,day:DAY,revision:booking.revision});card=(await f.state()).rewards.card;assert.equal(card.days.find(d=>d.day==='2026-11-03').status,'stamp');assert.equal(card.days.find(d=>d.day===DAY).status,'stamp');
});

test('future and already-completed reservations cannot be declared not bathed',async t=>{
 const f=await fixture(t);await f.book();const booking=(await f.state()).bookings[0];assert.equal((await f.request('not-bathed',{day:DAY,revision:booking.revision,confirmed:true})).status,409);f.time('2026-11-04T18:10:00');f.app.completeBath({memberId:1,day:DAY,revision:booking.revision});assert.equal((await f.request('not-bathed',{day:DAY,revision:booking.revision,confirmed:true})).status,409);
 assert.equal(f.sql(db=>db.prepare('SELECT COUNT(*) n FROM bath_noncompletions').get().n),0);
});
test('non-entry cancels the corresponding queued completion reminder',async t=>{
 const f=await fixture(t),key=createECDH('prime256v1');key.generateKeys();await f.api('push/subscribe',{subscription:{endpoint:'https://web.push.apple.com/non-entry-test',keys:{p256dh:key.getPublicKey().toString('base64url'),auth:randomBytes(16).toString('base64url')}}});await f.book();const booking=(await f.state()).bookings[0];f.time('2026-11-04T18:10:00');await missed(f,booking);f.time('2026-11-04T18:30:00');await f.app.flushNotifications();assert.equal(f.sent.filter(s=>s.payload.tag.startsWith('bath-completion-')).length,0);
});
test('ink used on today’s pending cell is returned even when completion is reported days later',async t=>{
 const f=await fixture(t);f.app.distributeItems({recipients:[1],kinds:['bathStamp','stampInk'],quantity:1,requestId:'late-report-ink'});for(const gift of (await f.state()).rewards.gifts)await f.api('gifts/receive',{id:gift.id});await f.api('items/stamp',{day:DAY,requestId:'late-ink-stamp'});await f.book();const booking=(await f.state()).bookings[0];f.time('2026-11-10T12:00:00');f.app.completeBath({memberId:1,day:DAY,revision:booking.revision});await f.restart();f.app.completeBath({memberId:1,day:DAY,revision:booking.revision});
 assert.equal(f.sql(db=>db.prepare("SELECT COUNT(*) n FROM item_gifts WHERE member_id=1 AND kind='stampInk' AND received_at IS NULL").get().n),1);
});
test('a late Saturday completion can finish the preceding weekly card exactly once',async t=>{
 const f=await fixture(t);f.time('2026-11-07T08:00:00');await f.api('book',{day:'2026-11-07',start:1080,duration:30});const booking=(await f.state('2026-11-07')).bookings[0];f.sql(db=>{for(let day=1;day<=6;day++){const date='2026-11-0'+day;db.prepare("INSERT INTO bath_completions VALUES(?,1,?,1080,30,?,'dashboard')").run(date,'earlier-report-'+day,date+'T09:20:00.000Z')}});f.time('2026-11-10T12:00:00');f.app.completeBath({memberId:1,day:'2026-11-07',revision:booking.revision});f.app.completeBath({memberId:1,day:'2026-11-07',revision:booking.revision});
 assert.equal(f.sql(db=>db.prepare("SELECT COUNT(*) n FROM weekly_rewards WHERE member_id=1 AND week='2026-11-01'").get().n),1);
});
