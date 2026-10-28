import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createApp} from '../src/app.js';
import {DEFAULT_SCHEDULE,validateSchedule} from '../src/server-settings.js';
import {lotteryOpen} from '../src/domain.js';
import {scheduleSegments,quarterTicks} from '../public/schedule-layout.js';

test('公開版はメンバー未登録・抽選時間の制限なし。初回の空設定も保存できる',()=>{
 const app=createApp();
 try {
  const config=app.getServerSettings();
  assert.deepEqual(config.members,[]);
  assert.equal(config.current.lotteryTimeRestricted,false);
  assert.deepEqual(app.saveServerSettings({members:[],schedule:config.upcoming}).members,[]);
  assert.equal(app.saveServerSettings({members:[{name:'テスト利用者',active:true}],schedule:config.upcoming}).members[0].name,'テスト利用者');
 } finally {app.close();}
});
test('制限なしは夜間・翌朝も抽選可能。翌日夜の先行抽選と終了後は拒否',()=>{
 const day='2026-10-28';
 for(const time of ['00:00:00','05:59:59','15:00:00','23:59:59']) assert.equal(lotteryOpen(day,new Date(`${day}T${time}+09:00`)),true);
 assert.equal(lotteryOpen(day,new Date('2026-10-29T06:59:59+09:00')),true);
 assert.equal(lotteryOpen(day,new Date('2026-10-29T07:00:00+09:00')),false);
 assert.equal(lotteryOpen('2026-10-29',new Date('2026-10-28T23:59:59+09:00')),false);
 const restricted={...DEFAULT_SCHEDULE,lotteryTimeRestricted:true};
 assert.equal(lotteryOpen(day,new Date(`${day}T15:00:00+09:00`),restricted),false);
 assert.equal(lotteryOpen(day,new Date(`${day}T06:00:00+09:00`),restricted),true);
 assert.throws(()=>validateSchedule({...DEFAULT_SCHEDULE,lotteryTimeRestricted:'false'}));
});
test('翌日を表示しても固定順を確定しない。時刻制限は翌日から適用',async t=>{
 let now=new Date('2026-10-28T20:00:00+09:00');
 const app=createApp({requireFamily:false,now:()=>now});
 const server=createServer(app.handle);await new Promise(r=>server.listen(0,'127.0.0.1',r));
 t.after(async()=>{await new Promise(r=>server.close(r));app.close();});
 const api=async(path,body,cookie='')=>{const r=await fetch(`http://127.0.0.1:${server.address().port}/api/${path}`,{method:body?'POST':'GET',headers:{cookie,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});return {status:r.status,body:await r.json(),cookie:r.headers.get('set-cookie')?.split(';')[0]};};
 app.saveServerSettings({members:[{name:'利用者',active:true}],schedule:{...DEFAULT_SCHEDULE,orderMode:'fixed'}});
 const login=await api('register',{memberId:1,password:'test-password'});
 const tomorrow=await api('state?day=2026-10-29',null,login.cookie);
 assert.equal(tomorrow.status,200);assert.equal(tomorrow.body.tomorrow,'2026-10-29');assert.equal(tomorrow.body.settings.orderMode,'fixed');assert.equal(tomorrow.body.draw,null);
 assert.equal((await api('skip',{day:'2026-10-29',skip:true},login.cookie)).status,400);
 assert.equal((await api('state?day=2026-10-30',null,login.cookie)).status,400);
 app.saveServerSettings({members:app.getServerSettings().members,schedule:{...DEFAULT_SCHEDULE,lotteryTimeRestricted:true}});
 assert.equal((await api('draw',{day:'2026-10-28'},login.cookie)).status,200);
 assert.equal((await api('draw',{day:'2026-10-28'},login.cookie)).status,409);
 now=new Date('2026-10-29T20:00:00+09:00');
 assert.equal((await api('draw',{day:'2026-10-29'},login.cookie)).status,403);
 assert.equal((await api('state',null,login.cookie)).body.settings.lotteryTimeRestricted,true);
});
test('2時間以上の空きだけ省略し、予約と15分目盛りを保つ',()=>{
 const bookings=[{start:1080,duration:15},{start:1215,duration:45},{start:1260,duration:90}];
 const segments=scheduleSegments(bookings,900,1860);
 assert.deepEqual(segments.map(s=>[s.kind,s.start,s.end]),[['break',900,1080],['booking',1080,1095],['break',1095,1215],['booking',1215,1260],['booking',1260,1350],['break',1350,1860]]);
 assert.deepEqual(scheduleSegments([{start:1015,duration:20}],900,1100).map(s=>s.kind),['free','booking','free']);
 assert.deepEqual(scheduleSegments([],900,1860),[{kind:'break',start:900,end:1860}]);
 assert.deepEqual(quarterTicks(1215,1260),[1215,1230,1245]);
 assert.deepEqual(quarterTicks(1430,1470),[1430,1440,1455]);
});
