import test from 'node:test';
import jsQR from 'jsqr';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {dashboardView,dashboardQr} from '../src/dashboard.js';
import {createApp} from '../src/app.js';
import {DEFAULT_SCHEDULE} from '../src/server-settings.js';
const snapshot=(now='2026-10-28T19:00:00+09:00')=>({day:'2026-10-28',now,settings:DEFAULT_SCHEDULE,
 members:[1,2,3,4,5,6].map(id=>({id,name:`利用者${id}`,active:id!==6})),
 bookings:[{memberId:1,start:1080,duration:30},{memberId:2,start:1140,duration:30},{memberId:3,start:1200,duration:30}],
 wishes:[{memberId:4,start:1260,duration:30}],skips:[5]});
test('ダッシュボードは予約時刻で状態と次・現在を判定し、希望と様子見を区別する',()=>{
 const s=snapshot();s.members[1].emoji="🌷";s.members[1].color="#d67f79";const v=dashboardView(s);
 assert.equal(v.current.emoji,"🌷");assert.equal(v.members[1].color,"#d67f79");
 assert.equal(v.current.name,'利用者2');assert.equal(v.next.name,'利用者3');
 assert.deepEqual(v.members.map(m=>m.status),['入浴済','入浴中','予約済','未確定','未入力']);
 assert.equal(v.members[4].deferred,true);assert.equal(v.entries[3].kind,'希望・未確定');
 assert.equal(v.entries[3].startsAt,'2026-10-28T12:00:00.000Z');
 assert.equal(dashboardView(snapshot('2026-10-28T19:30:00+09:00')).current,null);
 assert.equal(dashboardView(snapshot('2026-10-28T21:00:00+09:00')).next,null);
});
test('翌日早朝の時刻判定も予約日の日本時間を使う',()=>{
 const s=snapshot('2026-10-29T00:20:00+09:00');s.bookings=[{memberId:1,start:1455,duration:30},{memberId:2,start:1500,duration:30}];
 const v=dashboardView(s);assert.equal(v.current.memberId,1);assert.equal(v.next.memberId,2);
 assert.equal(v.current.startsAt,'2026-10-28T15:15:00.000Z');
});
test('共有QRは稼働確認済みの長いHTTPSリンクだけで作り、変更・停止時に古いQRを消す',()=>{
 const url='https://example.test:8443/family/'+'a'.repeat(64)+'/';
 const a=dashboardQr({phase:'ready',url});assert.equal(a.shareUrl,url);assert.ok(a.qr.length>20);assert.ok(a.qr.every(row=>row.length===a.qr.length&&/^[01]+$/.test(row)));
 assert.deepEqual(dashboardQr({phase:'ready',url}),a);
 const unit=4,size=(a.qr.length+8)*unit,pixels=new Uint8ClampedArray(size*size*4).fill(255);
 for(let row=0;row<a.qr.length;row++)for(let col=0;col<a.qr.length;col++)if(a.qr[row][col]==='1')
  for(let y=0;y<unit;y++)for(let x=0;x<unit;x++){
   const i=(((row+4)*unit+y)*size+(col+4)*unit+x)*4;pixels[i]=pixels[i+1]=pixels[i+2]=0;
  }
 assert.equal(jsQR(pixels,size,size).data,url);
 const b=dashboardQr({phase:'ready',url:url.replace('a'.repeat(64),'b'.repeat(64))});assert.notDeepEqual(b.qr,a.qr);
 for(const state of [{phase:'starting',url},{phase:'ready',url:'http://localhost:3000'},{phase:'stopping',url},{phase:'ready',url:'https://example.test/'}])assert.deepEqual(dashboardQr(state),{shareUrl:'',qr:[]});
});
test('ローカルのスナップショットは夜を切り替え、表示だけでは抽選や認証を変更しない',async t=>{
 let clock=new Date('2026-10-27T08:00:00+09:00');
 const app=createApp({now:()=>clock});t.after(()=>app.close());
 app.saveServerSettings({members:[{name:'テスト利用者',active:true}],schedule:{...DEFAULT_SCHEDULE,orderMode:'fixed'}});
 clock=new Date('2026-10-28T18:00:00+09:00');
 const s=app.getDashboard();assert.equal(s.day,'2026-10-28');assert.equal(s.bookings.length,0);assert.deepEqual(Object.keys(s.members[0]).sort(),['active','color','emoji','id','name']);
 clock=new Date('2026-10-29T06:59:00+09:00');assert.equal(app.getDashboard().day,'2026-10-28');
 clock=new Date('2026-10-29T07:00:00+09:00');assert.equal(app.getDashboard().day,'2026-10-29');
 const server=createServer(app.handle);await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
 // There is deliberately no public dashboard endpoint or auth bypass.
 const response=await fetch(`http://127.0.0.1:${server.address().port}/api/dashboard`);
 assert.notEqual(response.status,200);
});

test('簡易表示の次の2人は入力順に依存せず、希望の重なりは端点の接触を除く',()=>{
 const s=snapshot('2026-10-28T17:00:00+09:00');
 s.bookings.reverse();
 s.wishes=[{memberId:4,start:1095,duration:45},{memberId:5,start:1110,duration:45}];
 const v=dashboardView(s);
 assert.equal(v.next.memberId,1);assert.equal(v.afterNext.memberId,2);
 assert.deepEqual(v.entries.find(e=>e.memberId===4).overlaps,[{memberId:1,start:1095,end:1110},{memberId:5,start:1110,end:1140}]);
 assert.deepEqual(v.entries.find(e=>e.memberId===2).overlaps,[{memberId:5,start:1140,end:1155}]);
 assert.equal(dashboardView(snapshot('2026-10-28T21:00:00+09:00')).afterNext,null);
});
