import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../src/app.js';
import {DEFAULT_SCHEDULE} from '../src/server-settings.js';
async function fixture(t) {
 const dir=mkdtempSync(join(tmpdir(),'bathjun-standby-')),database=join(dir,'test.sqlite');let clock=new Date('2026-10-27T08:00:00+09:00'),app,server;
 const open=()=>createApp({database,requireFamily:false,now:()=>clock,deliverPush:async()=>{}});
 app=open();app.saveServerSettings({members:[1,2,3].map(i=>({name:'利用者'+i,active:true})),schedule:{...DEFAULT_SCHEDULE,orderMode:'fixed'}});clock=new Date('2026-10-28T08:00:00+09:00');
 async function listen(){server=createServer(app.handle);await new Promise(r=>server.listen(0,'127.0.0.1',r));}await listen();
 t.after(async()=>{await new Promise(r=>server.close(r));app.close();rmSync(dir,{recursive:true,force:true});});
 const cookies={};
 async function request(path,body,id=1){const r=await fetch(`http://127.0.0.1:${server.address().port}/api/${path}`,{method:body===undefined?'GET':'POST',headers:{cookie:cookies[id]||'','Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:r.status,body:await r.json(),cookie:r.headers.get('set-cookie')?.split(';')[0]};}
 async function api(path,body,id=1){const r=await request(path,body,id);assert.equal(r.status,200,JSON.stringify(r.body));return r.body;}
 for(const id of [1,2,3])cookies[id]=(await request('register',{memberId:id,password:'test-password'},id)).cookie;
 await api('state');
 return {get app(){return app;},api,request,setTime:value=>clock=new Date(value+'+09:00'),
  state:(day='2026-10-28',id=1)=>api('state?day='+day,undefined,id),
  wish:(id,start=1080,day='2026-10-28')=>api('wish',{day,start,duration:30},id),
  book:(id,start=900,day='2026-10-28')=>api('book',{day,start,duration:30},id),
  policy:value=>{const settings=app.getServerSettings();return app.saveServerSettings({members:settings.members,schedule:settings.upcoming,ignoreLowerPriorityWishes:value});},
  restart:async()=>{await new Promise(r=>server.close(r));app.close();app=open();await listen();}};
}
test('下位の希望より順番を優先する初期設定で、自動確定を止めない',async t=>{
 const f=await fixture(t);assert.equal(f.app.getServerSettings().ignoreLowerPriorityWishes,true);
 await f.wish(2);await f.wish(3);await f.book(1);
 const state=await f.state();assert.equal(state.bookings.find(b=>b.memberId===2).autoConfirmed,1);assert.equal(state.wishes.length,1);assert.equal(state.wishes[0].memberId,3);
 await f.restart();assert.equal((await f.state()).bookings.length,2);assert.equal(f.app.getServerSettings().ignoreLowerPriorityWishes,true);
});
test('許容をオフにすると保留し、オンへ保存すると当日の希望をすぐ再判定する',async t=>{
 const f=await fixture(t);f.policy(false);await f.wish(2);await f.wish(3);await f.book(1);
 assert.equal((await f.state()).wishes.length,2);
 assert.throws(()=>f.policy('true'));assert.equal(f.app.getServerSettings().ignoreLowerPriorityWishes,false);
 f.policy(true);const state=await f.state();assert.equal(state.wishes.length,1);assert.equal(state.bookings.find(b=>b.memberId===2).autoConfirmed,1);
});
test('終了と次の開始が同じなら、両方向とも重複と判定しない',async t=>{
 const f=await fixture(t);f.policy(false);await f.wish(2,1110);await f.wish(3,1050);await f.book(1,1080);
 const state=await f.state();assert.equal(state.wishes.length,0);assert.deepEqual(state.bookings.map(b=>[b.memberId,b.start]),[[3,1050],[1,1080],[2,1110]]);
});
test('確定済み予約との実際の重複は、下位許容がオンでも自動確定しない',async t=>{
 const f=await fixture(t);await f.wish(2,1095);await f.book(1,1080);const state=await f.state();assert.equal(state.bookings.length,1);assert.equal(state.wishes.length,1);
});
test('順番の上下は元の抽選順でなく、様子見で移動した後の順番を使う',async t=>{
 const f=await fixture(t);await f.api('skip',{day:'2026-10-28',skip:true},1);await f.wish(1);await f.wish(2);
 const state=await f.state();assert.deepEqual(state.draw.order,[2,3,1]);assert.equal(state.bookings.find(b=>b.memberId===2).autoConfirmed,1);assert.ok(state.wishes.some(w=>w.memberId===1));
});
test('自動様子見は初期オフ・本人用。次の夜から末尾へ回し、希望を消さない',async t=>{
 const f=await fixture(t);assert.equal((await f.state()).autoStandby,false);
 await f.api('auto-standby',{enabled:true});await f.wish(1,1080,'2026-10-29');assert.deepEqual((await f.state()).skips,[]);
 assert.equal((await f.state('2026-10-28',2)).autoStandby,false);
 assert.equal((await f.request('auto-standby',{enabled:'true'})).status,400);assert.equal((await f.request('auto-standby',{enabled:true,memberId:2})).status,400);
 f.setTime('2026-10-29T08:00:00');let state=await f.state('2026-10-29');assert.deepEqual(state.draw.order,[2,3,1]);assert.deepEqual(state.skips,[1]);assert.equal(state.wishes.length,1);
 await f.book(2,900,'2026-10-29');await f.book(3,960,'2026-10-29');state=await f.state('2026-10-29');assert.equal(state.bookings.find(b=>b.memberId===1).autoConfirmed,1);
});
test('通常順への復帰を再読込や再起動で戻さず、次の夜に再び自動適用する',async t=>{
 const f=await fixture(t);await f.api('auto-standby',{enabled:true});f.setTime('2026-10-29T08:00:00');await f.state('2026-10-29');
 await f.api('skip',{day:'2026-10-29',skip:false});assert.deepEqual((await f.state('2026-10-29')).draw.order,[1,2,3]);
 await f.restart();assert.deepEqual((await f.state('2026-10-29')).skips,[]);
 f.setTime('2026-10-30T08:00:00');assert.deepEqual((await f.state('2026-10-30')).draw.order,[2,3,1]);
});
test('翌朝まで続く前夜の予約は、自動様子見の適用時にも維持する',async t=>{
 const f=await fixture(t);await f.book(1,1800);await f.api('auto-standby',{enabled:true});f.setTime('2026-10-29T06:00:00');
 const old=await f.api('state');assert.equal(old.day,'2026-10-28');assert.equal(old.bookings[0].start,1800);assert.deepEqual(old.skips,[]);
 assert.deepEqual((await f.state('2026-10-29')).skips,[1]);
});
test('複数の自動様子見は元の順番を保ち、手動で末尾へ回った人はその後へ',async t=>{
 const f=await fixture(t);await f.api('auto-standby',{enabled:true},1);await f.api('auto-standby',{enabled:true},3);
 const settings=f.app.getServerSettings();f.app.saveServerSettings({members:settings.members.toReversed(),schedule:settings.upcoming});
 f.setTime('2026-10-29T08:00:00');assert.deepEqual((await f.state('2026-10-29')).draw.order,[2,3,1]);
 await f.api('skip',{day:'2026-10-29',skip:true},2);assert.deepEqual((await f.state('2026-10-29')).draw.order,[3,1,2]);
});
test('全リセットで個人の自動設定を消し、下位許容の初期設定へ戻す',async t=>{
 const f=await fixture(t);await f.api('auto-standby',{enabled:true});f.policy(false);
 const result=f.app.resetAllData({confirmation:'RESET_ALL_DATA'});assert.equal(result.settings.members.length,0);assert.equal(result.settings.ignoreLowerPriorityWishes,true);
});

test('まだ抽選していない夜なら設定をその夜から使える',async t=>{
 const f=await fixture(t),settings=f.app.getServerSettings();f.app.saveServerSettings({members:settings.members,schedule:{...settings.upcoming,orderMode:'random'}});
 f.setTime('2026-10-29T08:00:00');const result=await f.api('auto-standby',{enabled:true});assert.equal(result.appliesFrom,'2026-10-29');
 await f.api('draw',{day:'2026-10-29'});const state=await f.state('2026-10-29');assert.equal(state.draw.order.at(-1),1);
 const disabled=await f.api('auto-standby',{enabled:false});assert.equal(disabled.appliesFrom,'2026-10-30');assert.deepEqual((await f.state('2026-10-29')).skips,[1]);
});
test('抽選前の手動の復帰も、自動設定で上書きしない',async t=>{
 const f=await fixture(t),settings=f.app.getServerSettings();f.app.saveServerSettings({members:settings.members,schedule:{...settings.upcoming,orderMode:'random'}});
 await f.api('auto-standby',{enabled:true});f.setTime('2026-10-29T08:00:00');await f.api('skip',{day:'2026-10-29',skip:false});await f.api('draw',{day:'2026-10-29'});
 assert.deepEqual((await f.state('2026-10-29')).skips,[]);await f.restart();assert.deepEqual((await f.state('2026-10-29')).skips,[]);
});
test('抽選モードでも自動の人同士は抽選順を保って末尾に並ぶ',async t=>{
 const f=await fixture(t),settings=f.app.getServerSettings();f.app.saveServerSettings({members:settings.members,schedule:{...settings.upcoming,orderMode:'random'}});
 for(const id of [1,3])await f.api('auto-standby',{enabled:true},id);f.setTime('2026-10-29T08:00:00');await f.api('draw',{day:'2026-10-29'});
 const state=await f.state('2026-10-29');assert.deepEqual(state.draw.order,[2,...state.draw.originalOrder.filter(id=>id!==2)]);
});
