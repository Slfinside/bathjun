import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {createApp} from '../src/app.js';
import {DEFAULT_SCHEDULE} from '../src/server-settings.js';
async function fixture(t){
 const directory=mkdtempSync(join(tmpdir(),'bathjun-visits-')),database=join(directory,'test.sqlite');let clock=new Date('2026-11-03T08:00:00+09:00');
 const app=createApp({database,requireFamily:false,now:()=>clock});app.saveServerSettings({members:[{name:'テストA',active:true},{name:'テストB',active:true}],schedule:{...DEFAULT_SCHEDULE,orderMode:'fixed'}});clock=new Date('2026-11-04T08:00:00+09:00');
 const server=createServer(app.handle);await new Promise(r=>server.listen(0,'127.0.0.1',r));const cookies={};
 const request=async(path,body,id=1)=>{const response=await fetch(`http://127.0.0.1:${server.address().port}/api/${path}`,{method:body===undefined?'GET':'POST',headers:{cookie:cookies[id]||'','content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});const data=await response.json();return {status:response.status,body:data,cookie:response.headers.get('set-cookie')?.split(';')[0]}};
 const api=async(path,body,id=1)=>{const r=await request(path,body,id);assert.equal(r.status,200,JSON.stringify(r.body));return r.body};
 for(const id of [1,2])cookies[id]=(await request('register',{memberId:id,password:'synthetic-test'},id)).cookie;
 t.after(async()=>{await new Promise(r=>server.close(r));app.close();rmSync(directory,{recursive:true,force:true})});
 return {app,request,api,time:value=>clock=new Date(value+'+09:00'),state:(day='2026-11-04',id=1)=>api('state?day='+day,undefined,id),enable:()=>app.saveRewardSettings({...app.getRewardsAdmin().settings,clientReportEnabled:true}),sql:fn=>{const db=new DatabaseSync(database);try{return fn(db)}finally{db.close()}}};
}
const visit={day:'2026-11-04',start:1080,duration:30,note:'実際の入浴',requestId:'unreserved-test-1'};
test('unreserved baths are shared as completed history and do not reserve slots or change the order',async t=>{
 const f=await fixture(t);f.enable();f.time('2026-11-04T18:45:00');const result=await f.api('unreserved-bath',{...visit,memberId:2});const state=await f.state(),other=await f.state('2026-11-04',2);
 assert.equal(state.unreservedBaths.length,1);assert.equal(other.unreservedBaths[0].id,result.id);assert.equal(state.unreservedBaths[0].memberId,1);assert.equal(state.unreservedBaths[0].unreserved,true);assert.equal(state.bookings.length,0);
 assert.equal(state.rewards.card.days.find(x=>x.day===visit.day).status,'stamp');await f.api('book',{day:visit.day,start:1140,duration:30});assert.equal((await f.state()).bookings[0].completedAt,null);
 assert.equal(f.sql(db=>db.prepare('SELECT COUNT(*) n FROM bath_completions').get().n),0);
});
test('unreserved reports check the client toggle, real elapsed times and day boundary',async t=>{
 const f=await fixture(t);f.time('2026-11-04T18:45:00');assert.equal((await f.request('unreserved-bath',visit)).status,403);f.enable();
 for(const body of [{...visit,start:1200},{...visit,duration:0},{...visit,start:-1},{...visit,day:'2026-02-31'},{...visit,note:'x'.repeat(301)}])assert.equal((await f.request('unreserved-bath',body)).status,400);
 f.time('2026-11-05T07:00:00');assert.equal((await f.request('unreserved-bath',visit)).status,409);
});
test('retries and repeated actual intervals do not duplicate unreserved records or ink refunds',async t=>{
 const f=await fixture(t);f.enable();f.app.distributeItems({recipients:[1],kinds:['bathStamp','stampInk'],quantity:1,requestId:'visit-ink-gift'});for(const gift of (await f.state()).rewards.gifts)await f.api('gifts/receive',{id:gift.id});await f.api('items/stamp',{day:visit.day,requestId:'visit-ink-use'});f.time('2026-11-04T18:45:00');
 const first=await f.api('unreserved-bath',visit);assert.equal((await f.api('unreserved-bath',visit)).id,first.id);assert.equal((await f.api('unreserved-bath',{...visit,requestId:'unreserved-test-2'})).id,first.id);
 assert.equal((await f.request('unreserved-bath',{...visit,duration:45})).status,409);assert.equal((await f.request('unreserved-bath',{...visit,note:'変更した備考',requestId:'duplicate-other-note'})).status,409);assert.equal((await f.state()).unreservedBaths.length,1);assert.equal((await f.state()).rewards.gifts.filter(g=>g.kind==='stampInk'&&!g.receivedAt).length,1);
});
test('morning visits belong to the night of their start and dashboard corrections can be late',async t=>{
 const f=await fixture(t);f.enable();f.time('2026-11-04T06:30:00');await f.api('unreserved-bath',{day:'2026-11-03',start:1800,duration:15,requestId:'morning-visit-1'});assert.equal((await f.state('2026-11-03')).unreservedBaths.length,1);
 f.time('2026-11-10T10:00:00');f.app.reportUnreservedBath({...visit,memberId:2,requestId:'late-admin-visit'});assert.equal(f.sql(db=>db.prepare('SELECT COUNT(*) n FROM unreserved_baths').get().n),2);
});

test('unreserved visits complete a weekly card only once and reset removes all actual history',async t=>{
 const f=await fixture(t);f.time('2026-11-07T18:45:00');
 for(let date=1;date<=7;date++)f.app.reportUnreservedBath({...visit,memberId:1,day:`2026-11-0${date}`,requestId:`weekly-actual-${date}`});
 const state=await f.state('2026-11-07');assert.ok(state.rewards.card.days.every(d=>d.status==='stamp'));
 assert.equal(f.sql(db=>db.prepare('SELECT COUNT(*) n FROM weekly_rewards WHERE member_id=1').get().n),1);
 f.app.reportUnreservedBath({...visit,memberId:1,day:'2026-11-07',requestId:'weekly-repeated-actual'});
 assert.equal(f.sql(db=>db.prepare('SELECT COUNT(*) n FROM weekly_rewards WHERE member_id=1').get().n),1);
 f.app.resetAllData({confirmation:'RESET_ALL_DATA'});assert.equal(f.sql(db=>db.prepare('SELECT COUNT(*) n FROM unreserved_baths').get().n),0);assert.equal(f.sql(db=>db.prepare('SELECT COUNT(*) n FROM bath_successes').get().n),0);
});
test('unreserved success resolves a preceding standby day and rejects another account retry',async t=>{
 const f=await fixture(t);f.enable();f.time('2026-11-03T18:00:00');await f.api('skip',{day:'2026-11-03',skip:true});f.time('2026-11-04T18:45:00');await f.api('unreserved-bath',visit);
 const days=(await f.state()).rewards.card.days;assert.equal(days.find(d=>d.day==='2026-11-03').status,'stamp');assert.equal(days.find(d=>d.day==='2026-11-04').status,'stamp');
 assert.equal((await f.request('unreserved-bath',visit,2)).status,403);assert.equal((await f.state()).unreservedBaths.length,1);
});
