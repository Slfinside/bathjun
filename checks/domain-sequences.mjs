// Repeatable mixed-operation checks. Every run creates and removes a synthetic DB.
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {DatabaseSync} from 'node:sqlite';
import {createApp} from '../src/app.js';
import {DEFAULT_SCHEDULE} from '../src/server-settings.js';
import {bathCalendar,shiftDay} from '../src/bath-calendar.js';
import {slotDate} from '../src/domain.js';
const seeds=(process.env.BATHJUN_SEQUENCE_SEEDS||'1,7,42,20261105').split(',').map(Number);
const steps=Number(process.env.BATHJUN_SEQUENCE_STEPS||400);
for(const seed of seeds){
 let randomState=seed>>>0,clock=new Date('2026-11-01T08:00:00+09:00');
 const random=limit=>{randomState=(Math.imul(randomState,1664525)+1013904223)>>>0;return Math.floor(randomState/4294967296*limit)};
 const dir=mkdtempSync(join(tmpdir(),'bathjun-sequence-')),database=join(dir,'synthetic.sqlite');
 const app=createApp({database,requireFamily:false,now:()=>clock,deliverPush:async()=>{}});
 app.saveServerSettings({members:Array.from({length:5},(_,i)=>({name:'試験メンバー'+(i+1),active:true})),schedule:{...DEFAULT_SCHEDULE,orderMode:seed%2?'random':'fixed'}});
 app.saveRewardSettings({...app.getRewardsAdmin().settings,extensionBlocked:false,extensionNoticeMinutes:0,skipNoticeMinutes:0});
 clock=new Date('2026-11-02T08:00:00+09:00');
 const server=createServer(app.handle);await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const db=new DatabaseSync(database),cookies={},history=[],outcomes={};db.exec('PRAGMA query_only=ON');
 const request=async(path,body,id)=>{
  const response=await fetch(`http://127.0.0.1:${server.address().port}/api/${path}`,{method:body===undefined?'GET':'POST',headers:{cookie:cookies[id]||'','Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const result=await response.json();assert.ok(response.status<500,`${path}: ${response.status} ${JSON.stringify(result)}`);
  return {status:response.status,body:result,cookie:response.headers.get('set-cookie')?.split(';')[0]};
 };
 const verify=()=>{
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
  const intervals=db.prepare('SELECT day,member_id,start,duration FROM bookings').all().map(b=>({...b,time:slotDate(b.day,b.start).getTime()})).sort((a,b)=>a.time-b.time);
  for(let i=1;i<intervals.length;i++)assert.ok(intervals[i-1].time+intervals[i-1].duration*60000<=intervals[i].time,`overlap: ${JSON.stringify(intervals.slice(i-1,i+1))}`);
  for(const row of db.prepare('SELECT member_id,kind,quantity FROM item_wallet').all()){
   assert.ok(row.quantity>=0);assert.equal(row.quantity,db.prepare('SELECT COALESCE(SUM(delta),0) n FROM item_ledger WHERE member_id=? AND kind=?').get(row.member_id,row.kind).n);
  }
  assert.equal(db.prepare("SELECT COUNT(*) n FROM item_ledger WHERE NOT EXISTS(SELECT 1 FROM item_wallet w WHERE w.member_id=item_ledger.member_id AND w.kind=item_ledger.kind)").get().n,0);
 };
 try{
  for(let id=1;id<=5;id++){
   const result=await request('register',{memberId:id,password:'synthetic-only'},id);assert.equal(result.status,200);cookies[id]=result.cookie;
  }
  app.distributeItems({recipients:[1,2,3,4,5],kinds:['guard','skip','extend','boost','bathStamp','stampInk'],quantity:10,requestId:`sequence-${seed}`});
  for(let i=0;i<steps;i++){
   const id=random(5)+1,today=bathCalendar(clock).today,day=shiftDay(today,random(4)-1),operation=random(13);
   const state=(await request('state?day='+day,undefined,id)).body;
   let path,body;
   const start=420+random(96)*15,duration=(random(6)+1)*15,ticket=[undefined,'guard','skip','extend'][random(4)];
   if(operation===0){clock=new Date(clock.getTime()+(random(180)+1)*60000);path='clock';}
   else if(operation===1){path='draw';body={day};}
   else if(operation===2||operation===3){path=operation===2?'wish':'book';body={day,start,duration,note:'シード'+seed,ticket};}
   else if(operation===4){path='skip';body={day,skip:!!random(2)};}
   else if(operation===5){path='cancel';body={day};}
   else if(operation===6){
    const b=db.prepare('SELECT * FROM bookings WHERE member_id=? AND day>=? ORDER BY day,start LIMIT 1').get(id,shiftDay(today,-1));
    if(b){const starts=slotDate(b.day,b.start);if(starts>clock)clock=starts;}
    path='complete';body={day:b?.day||day,revision:b?.revision||'stale'};
    if(b&&random(2)){
     try{app.completeBath({...body,memberId:id});outcomes['dashboard-complete:200']=(outcomes['dashboard-complete:200']||0)+1;}
     catch(error){assert.ok([400,403,409].includes(error.status),error.stack);}
     body=undefined;
    }
   }
   else if(operation===7){const gift=state.rewards?.gifts?.[random(state.rewards?.gifts?.length||1)];path='gifts/receive';body={id:gift?.id||'missing'};}
   else if(operation===8){path='notification-preferences';body={bathReminder:!!random(2),completionReminder:!!random(2),reminderMinutes:random(180)+1};}
   else if(operation===9){path='auto-wishes';body={days:Array.from({length:7},(_,weekday)=>({weekday,enabled:false,mode:['disabled','standby','reservation'][random(3)],start:random(96)*15,duration:30,note:'自動入力試験'}))};}
   else if(operation===10){app.saveRewardSettings({...app.getRewardsAdmin().settings,clientReportEnabled:!!random(2),clientReportMinutes:random(10)+1,dashboardReportMinutes:random(10)+1});path='settings';}
   else if(operation===11){const offer=state.unreportedBooking;path='book';body={day:offer?.day||day,start,duration,rebookRevision:offer?.revision||'stale'};}
   else {path='items/boost';body={requestId:`sequence-${seed}-${i}`};}
   history.push({i,clock:clock.toISOString(),id,path,body});if(history.length>12)history.shift();
   if(body){const response=await request(path,body,id);const key=path+':'+response.status;outcomes[key]=(outcomes[key]||0)+1;}
   await app.flushNotifications();verify();
  }
  console.log(`PASS seed=${seed} operations=${steps} bookings=${db.prepare('SELECT COUNT(*) n FROM bookings').get().n} completed=${db.prepare('SELECT COUNT(*) n FROM bath_completions').get().n} rebooked=${db.prepare('SELECT COUNT(*) n FROM rebooking_history').get().n} outcomes=${JSON.stringify(outcomes)}`);
 }catch(error){console.error('Sequence failure',JSON.stringify({seed,history},null,2));throw error;}
 finally{db.close();await new Promise(r=>server.close(r));app.close();rmSync(dir,{recursive:true,force:true});}
}
