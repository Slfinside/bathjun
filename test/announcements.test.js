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
import {writeFileSync,mkdirSync} from 'node:fs';
import {activateInstalledUpdate} from '../src/installed-update.js';

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
 return {image:(path,id=1)=>fetch(`http://127.0.0.1:${server.address().port}${path}`,{headers:{cookie:cookies[id]||''}}),get app(){return app},database,api,request,sent,time:value=>clock=new Date(value+'+09:00'),state:(day='2026-11-04')=>api('state?day='+day),book:(start=1080,duration=30,id=1,extra={})=>api('book',{day:'2026-11-04',start,duration,...extra},id),
  settings:value=>app.saveRewardSettings({...app.getRewardsAdmin().settings,...value}),
  restart:async()=>{await new Promise(r=>server.close(r));app.close();app=open();await listen()},
  sql:fn=>{const db=new DatabaseSync(database);try{return fn(db)}finally{db.close()}}};
}

const pages=[{title:'1ページ目',text:'説明\n本文 <script>alert(1)</script>'},{title:'2ページ目',text:'二枚目'},{title:'3ページ目',text:'三枚目'}];
const publish=(f,extra={})=>f.app.saveAnnouncement({label:'テストのお知らせ',state:'published',pages,...extra});
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+yHXcAAAAASUVORK5CYII=','base64');
test('manual publishing is private, has three pages, and acknowledgement is per member across restart',async t=>{
 const f=await fixture(t);const result=publish(f),id=result.entries[0].id;
 let state=await f.state();assert.equal(state.announcements.length,1);assert.equal(state.announcements[0].pageCount,3);const data=await f.api('announcements?id='+id);assert.equal(data.pages.length,3);assert.equal(data.seen,false);assert.match(data.pages[0].text,/<script>/);
 await f.api('announcements/seen',{id,skipped:true});await f.api('announcements/seen',{id,skipped:false});await f.restart();assert.equal((await f.state()).announcements.length,0);assert.equal((await f.api('state',undefined,2)).announcements.length,1);assert.equal((await f.api('announcements?id='+id)).seen,true);
 assert.equal(f.app.getAnnouncementsAdmin().entries[0].readCount,1);await f.api('logout',{});assert.equal((await f.request('announcements?id='+id)).status,401);
});
test('scheduled announcements publish at the exact time without generating push jobs',async t=>{
 const f=await fixture(t),at=new Date('2026-11-04T09:00:00+09:00').getTime();publish(f,{state:'scheduled',scheduledAt:at});assert.equal((await f.state()).announcements.length,0);assert.equal(f.app.notificationDueAt(),at);
 await f.restart();assert.equal(f.app.notificationDueAt(),at);f.time('2026-11-04T09:00:00');await f.app.flushNotifications();assert.equal((await f.state()).announcements.length,1);assert.equal(f.sent.length,0);assert.equal(f.app.notificationDueAt(),null);
});
test('draft editing, immutable published history, archive and validation',async t=>{
 const f=await fixture(t);let result=publish(f,{state:'draft'}),id=result.entries[0].id;assert.equal((await f.state()).announcements.length,0);
 publish(f,{id,state:'draft',pages:[{title:'更新した下書き',text:'text'}]});assert.equal(f.app.getAnnouncementsAdmin().entries[0].pages.length,1);
 publish(f,{id});assert.throws(()=>publish(f,{id}));f.app.archiveAnnouncement({id});assert.equal((await f.state()).announcements.length,0);assert.ok(f.app.getAnnouncementsAdmin().entries[0].published_at);
 for(const extra of [{pages:[]},{pages:new Array(11).fill(pages[0])},{pages:[{title:'',text:''}]},{pages:[{title:'ok',text:1}]},{state:'scheduled',scheduledAt:0},{label:''}])assert.throws(()=>publish(f,extra));
});
test('image bytes are session gated and SVG/oversize uploads are refused',async t=>{
 const f=await fixture(t),dir=mkdtempSync(join(tmpdir(),'bathjun-test-image-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const path=join(dir,'image.png');writeFileSync(path,png);
 const result=publish(f,{state:'draft',pages:[{title:'画像',text:'説明',imagePath:path}]}),entry=result.entries[0];assert.equal(entry.pages[0].hasImage,1);
 publish(f,{id:entry.id,pages:[{...entry.pages[0],text:'編集後'}]});const detail=await f.api('announcements?id='+entry.id);assert.ok(detail.pages[0].imageUrl);
 const response=await f.image(detail.pages[0].imageUrl);assert.equal(response.status,200);assert.equal(response.headers.get('content-type'),'image/png');assert.deepEqual(Buffer.from(await response.arrayBuffer()),png);assert.equal((await f.image(detail.pages[0].imageUrl,99)).status,401);
 writeFileSync(path,'<svg onload="alert(1)"></svg>');assert.throws(()=>publish(f,{pages:[{title:'x',text:'',imagePath:path}]}));writeFileSync(path,Buffer.alloc(2*1024*1024+1));assert.throws(()=>publish(f,{pages:[{title:'x',text:'',imagePath:path}]}));
});
test('installer-origin activation is one-shot and regular launch never activates a bundle',async t=>{
 const f=await fixture(t),root=mkdtempSync(join(tmpdir(),'bathjun-install-fixture-'));t.after(()=>rmSync(root,{recursive:true,force:true}));mkdirSync(join(root,'app/release-announcements'),{recursive:true});writeFileSync(join(root,'app/package.json'),JSON.stringify({version:'2.0.1'}));writeFileSync(join(root,'app/release-announcements/2.0.1.json'),JSON.stringify({version:'2.0.1',label:'更新',pages}));const marker=()=>writeFileSync(join(root,'installed-update.json'),JSON.stringify({version:'2.0.1',previousVersion:'2.0.0'}));
 marker();assert.equal(activateInstalledUpdate(f.app,{installRoot:root}),false);assert.equal((await f.state()).announcements.length,0);assert.equal(activateInstalledUpdate(f.app,{installRoot:root,installed:true}),true);assert.equal((await f.state()).announcements.length,1);
 marker();await f.restart();activateInstalledUpdate(f.app,{installRoot:root,installed:true});assert.equal(f.app.getAnnouncementsAdmin().entries.length,1);
 f.app.resetAllData({confirmation:'RESET_ALL_DATA'});marker();activateInstalledUpdate(f.app,{installRoot:root,installed:true});assert.equal(f.app.getAnnouncementsAdmin().entries.length,0);
});

async function ink(f,day='2026-11-04'){
 f.app.distributeItems({recipients:[1],kinds:['bathStamp','stampInk'],quantity:1,requestId:'ink-fixture-'+day});for(const gift of (await f.state()).rewards.gifts)await f.api('gifts/receive',{id:gift.id});await f.api('items/stamp',{day,requestId:'stamp-test-'+day});
}
test('valid completion after inking today’s pending cell returns exactly one ink gift',async t=>{
 const f=await fixture(t);await ink(f);await f.book();const booking=(await f.state()).bookings[0];f.time('2026-11-04T18:10:00');f.app.completeBath({memberId:1,day:'2026-11-04',revision:booking.revision});f.app.completeBath({memberId:1,day:'2026-11-04',revision:booking.revision});await f.restart();f.app.completeBath({memberId:1,day:'2026-11-04',revision:booking.revision});
 const gifts=(await f.state()).rewards.gifts.filter(g=>!g.receivedAt&&g.kind==='stampInk');assert.equal(gifts.length,1);assert.equal(gifts[0].quantity,1);await f.api('gifts/receive',{id:gifts[0].id});assert.equal((await f.state()).rewards.wallet.find(x=>x.kind==='stampInk').quantity,1);
});
test('past cells and rejected completion reports do not refund ink',async t=>{
 const f=await fixture(t);await ink(f,'2026-11-03');await f.book();const booking=(await f.state()).bookings[0];f.time('2026-11-04T18:10:00');assert.throws(()=>f.app.completeBath({memberId:1,day:'2026-11-04',revision:'wrong'}));f.app.completeBath({memberId:1,day:'2026-11-04',revision:booking.revision});assert.equal((await f.state()).rewards.gifts.filter(g=>!g.receivedAt&&g.kind==='stampInk').length,0);
});

test('inking today after an explicit non-entry does not earn a refund on rebooking',async t=>{
 const f=await fixture(t);await f.book();const old=(await f.state()).bookings[0];f.time('2026-11-04T18:32:00');await f.api('not-bathed',{day:'2026-11-04',revision:old.revision,confirmed:true});assert.equal((await f.state()).rewards.card.days.find(x=>x.day==='2026-11-04').status,'failed');await ink(f);
 await f.api('book',{day:'2026-11-04',start:1200,duration:30,rebookRevision:old.revision});const booking=(await f.state()).bookings[0];f.time('2026-11-04T20:10:00');f.app.completeBath({memberId:1,day:'2026-11-04',revision:booking.revision});assert.equal((await f.state()).rewards.gifts.filter(x=>!x.receivedAt&&x.kind==='stampInk').length,0);
});
test('auto-update readiness is blocked during bathing and ten minutes before it',async t=>{
 const f=await fixture(t);await f.book();assert.equal(f.app.getUpdateStatus().busy,false);f.time('2026-11-04T17:50:00');assert.equal(f.app.getUpdateStatus().busy,true);f.time('2026-11-04T18:15:00');assert.equal(f.app.getUpdateStatus().busy,true);
 const booking=(await f.state()).bookings[0];f.app.completeBath({memberId:1,day:'2026-11-04',revision:booking.revision});assert.equal(f.app.getUpdateStatus().busy,false);
});

test('invalid receipt IDs fail cleanly and a changed shared-device account cannot mark another member read',async t=>{
 const f=await fixture(t),id=publish(f).entries[0].id;for(const body of [{},{id:7,skipped:false},{id:'wrong',skipped:true}])assert.equal((await f.request('announcements/seen',body)).status,400);
 assert.equal((await f.request('announcements/seen',{id,skipped:true,memberId:1},2)).status,409);assert.equal((await f.api('state',undefined,2)).announcements.length,1);
});
