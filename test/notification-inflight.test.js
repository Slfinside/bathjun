import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createECDH,randomBytes} from 'node:crypto';
import {createApp} from '../src/app.js';
import {DEFAULT_SCHEDULE} from '../src/server-settings.js';
const subscription=name=>{const key=createECDH('prime256v1');key.generateKeys();return {endpoint:'https://web.push.apple.com/inflight-'+name,keys:{p256dh:key.getPublicKey().toString('base64url'),auth:randomBytes(16).toString('base64url')}}};
async function fixture(t,kind,revoke){
 let clock=new Date('2026-11-03T08:00:00+09:00'),hook;
 const sent=[];
 const app=createApp({requireFamily:false,now:()=>clock,deliverPush:async(sub,payload)=>{
  sent.push({endpoint:sub.endpoint,tag:payload.tag});if(hook){const action=hook;hook=null;await action();}
 }});
 app.saveServerSettings({members:[{name:'試験A',active:true},{name:'試験B',active:true}],schedule:{...DEFAULT_SCHEDULE,orderMode:'fixed'}});clock=new Date('2026-11-04T08:00:00+09:00');
 const server=createServer(app.handle);await new Promise(r=>server.listen(0,'127.0.0.1',r));
 t.after(async()=>{await new Promise(r=>server.close(r));app.close()});
 const cookies={};
 const post=async(path,body,id=1)=>{const response=await fetch(`http://127.0.0.1:${server.address().port}/api/${path}`,{method:'POST',headers:{cookie:cookies[id]||'','Content-Type':'application/json'},body:JSON.stringify(body)});assert.equal(response.status,200,await response.clone().text());return {body:await response.json(),cookie:response.headers.get('set-cookie')?.split(';')[0]};};
 for(const id of [1,2])cookies[id]=(await post('register',{memberId:id,password:'synthetic-only'},id)).cookie;
 const preferences={nudge:false,reservationTurn:false,wishConfirmed:false,wishUnconfirmed:false,bathReminder:false,completionReminder:false,bookingDisplaced:false};
 preferences[{turn:'reservationTurn',wish:'wishConfirmed',bath:'bathReminder',completion:'completionReminder',nudge:'nudge'}[kind]]=true;
 await post('notification-preferences',preferences);
 const stateResponse=await fetch(`http://127.0.0.1:${server.address().port}/api/state`,{headers:{cookie:cookies[1]}});assert.equal(stateResponse.status,200);await stateResponse.json();
 const first=subscription('a'),second=subscription('b');for(const sub of [first,second])await post('push/subscribe',{subscription:sub});
 if(kind==='wish')await post('wish',{day:'2026-11-04',start:1080,duration:30});
 if(kind==='bath'||kind==='completion'){
  await post('book',{day:'2026-11-04',start:1080,duration:30});clock=new Date(`2026-11-04T${kind==='bath'?'17:50':'18:30'}:00+09:00`);
 }
 if(kind==='nudge')await post('nudge',{day:'2026-11-04',memberId:1},2);
 hook=async()=>{
  if(revoke==='logout')await post('logout',{});
  if(revoke==='unsubscribe')await post('push/unsubscribe',{endpoint:second.endpoint});
  if(revoke==='switch-user')await post('push/subscribe',{subscription:second},2);
  if(revoke==='reset')app.resetAllData({confirmation:'RESET_ALL_DATA'});
 };
 await app.flushNotifications();
 assert.equal(sent.length,1,JSON.stringify({kind,revoke,sent}));
 assert.equal(sent[0].endpoint,first.endpoint);
}
for(const kind of ['turn','wish','bath','completion','nudge'])test(`${kind}通知：送信途中に解除した端末へ後続の通知を送らない`,async t=>{
 for(const revoke of ['logout','unsubscribe','switch-user','reset'])await t.test(revoke,sub=>fixture(sub,kind,revoke));
});
