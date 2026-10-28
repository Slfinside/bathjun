import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createApp} from '../src/app.js';
import {createHttpServer} from '../src/http.js';
import {DEFAULT_SCHEDULE} from '../src/server-settings.js';
import {validateProfile} from '../src/member-profile.js';
import {scheduleSegments} from '../public/schedule-layout.js';
import {profileColors} from '../public/profile-picker.js';
async function fixture(t,{family=false}={}) {
 const directory=mkdtempSync(join(tmpdir(),'bathjun-advanced-')),database=join(directory,'test.sqlite');
 let clock=new Date('2026-10-27T08:00:00+09:00');
 const app=createApp({database,requireFamily:family,now:()=>clock,deliverPush:async()=>{}});
 app.saveServerSettings({members:[1,2,3].map(i=>({name:`利用者${i}`,active:true})),schedule:{...DEFAULT_SCHEDULE,orderMode:'fixed'}});
 clock=new Date('2026-10-28T08:00:00+09:00');
 const server=createServer(app.handle);await new Promise(r=>server.listen(0,'127.0.0.1',r));
 t.after(async()=>{await new Promise(r=>server.close(r));app.close();rmSync(directory,{recursive:true,force:true});});
 const base=`http://127.0.0.1:${server.address().port}/api/`;
 async function api(path,body,cookie='') {
  const r=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{cookie,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
  return {status:r.status,body:await r.json(),cookie:r.headers.get('set-cookie')?.split(';')[0]};
 }
 let familyCookie='';
 if(family){await app.setFamilyPassword('initial-family-secret');familyCookie=(await api('family/login',{password:'initial-family-secret'})).cookie;}
 const cookies={};for(let id=1;id<=3;id++){const reply=await api('register',{memberId:id,password:`initial-password-${id}`},familyCookie);assert.equal(reply.status,200);cookies[id]=[familyCookie,reply.cookie].filter(Boolean).join('; ');}
 const day='2026-10-28';
 const state=async()=>{const r=await api('state?day='+day,undefined,cookies[1]);assert.equal(r.status,200,JSON.stringify(r.body));return r.body;};
 return {app,api,cookies,day,state,database,setTime:value=>clock=new Date(value)};
}
test('順番が回ると重なりのない希望を連続で自動確定し、理由を残す',async t=>{
 const f=await fixture(t);await f.state();
 for(const [id,start] of [[2,1080],[3,1200]])assert.equal((await f.api('wish',{day:f.day,start,duration:30,note:`希望理由${id}`},f.cookies[id])).status,200);
 assert.equal((await f.state()).wishes.length,2);
 await f.api('book',{day:f.day,start:900,duration:30},f.cookies[1]);
 const state=await f.state();assert.equal(state.bookings.length,3);assert.equal(state.wishes.length,0);
 assert.deepEqual(state.bookings.map(b=>[b.memberId,b.autoConfirmed,b.note]),[[1,0,''],[2,1,'希望理由2'],[3,1,'希望理由3']]);
 // Auto-confirmed reservations can still be changed/cancelled before their start.
 assert.equal((await f.api('cancel',{day:f.day},f.cookies[2])).status,200);assert.equal((await f.state()).bookings.length,2);
});
test('ほかの予約との重複は自動確定しない。予約の移動で空けば確定',async t=>{
 const f=await fixture(t);await f.state();await f.api('wish',{day:f.day,start:1080,duration:30},f.cookies[2]);
 await f.api('book',{day:f.day,start:1080,duration:30},f.cookies[1]);
 let state=await f.state();assert.equal(state.bookings.length,1);assert.equal(state.wishes.length,1);
 await f.api('book',{day:f.day,start:900,duration:30},f.cookies[1]);state=await f.state();assert.equal(state.bookings.length,2);assert.equal(state.bookings[1].autoConfirmed,1);
});
test('希望同士が重なれば両方残し、片方の取り消しで現在の順番の希望を確定',async t=>{
 const f=await fixture(t);await f.state();
 for(const id of [2,3])await f.api('wish',{day:f.day,start:1080,duration:30},f.cookies[id]);
 await f.api('book',{day:f.day,start:900,duration:30},f.cookies[1]);assert.equal((await f.state()).wishes.length,2);
 await f.api('wish/cancel',{day:f.day},f.cookies[3]);const state=await f.state();assert.equal(state.wishes.length,0);assert.equal(state.bookings.find(b=>b.memberId===2).autoConfirmed,1);
});
test('開始時刻を過ぎた希望は確定せず、隣接する希望は重複扱いにしない',async t=>{
 const f=await fixture(t);await f.state();await f.api('wish',{day:f.day,start:1080,duration:30},f.cookies[2]);
 f.setTime('2026-10-28T18:01:00+09:00');await f.api('book',{day:f.day,start:1200,duration:30},f.cookies[1]);assert.equal((await f.state()).bookings.length,1);assert.equal((await f.state()).wishes.length,1);
 await f.api('wish',{day:f.day,start:1230,duration:30},f.cookies[2]);assert.equal((await f.state()).bookings.length,2);
});
test('利用停止や様子見で順番が進んだ場合も希望を確定する',async t=>{
 const f=await fixture(t);await f.state();await f.api('wish',{day:f.day,start:1080,duration:30},f.cookies[2]);
 await f.api('skip',{day:f.day,skip:true},f.cookies[1]);assert.equal((await f.state()).bookings[0].memberId,2);
 await f.api('wish',{day:f.day,start:1200,duration:30},f.cookies[1]);
 const settings=f.app.getServerSettings();f.app.saveServerSettings({members:settings.members.map(m=>({...m,active:m.id!==3})),schedule:settings.upcoming});
 assert.deepEqual((await f.state()).bookings.map(b=>b.memberId),[2,1]);
});
test('パスワードは表示せず設定状態と照合だけを返す。管理画面から変更し対象のみ失効',async t=>{
 const f=await fixture(t,{family:true});
 const config=f.app.getSecurity();assert.equal(config.familyConfigured,true);assert.equal(config.members.length,3);assert.ok(config.members.every(m=>m.passwordSet));
 assert.doesNotMatch(JSON.stringify(config),/salt|hash|initial-password|initial-family/);
 assert.deepEqual(await f.app.verifyPassword({target:1,password:'initial-password-1'}),{matches:true,configured:true});
 assert.equal((await f.app.verifyPassword({target:'family',password:'wrong'})).matches,false);
 assert.equal((await f.app.verifyPassword({target:'family',password:'initial-family-secret'})).matches,true);
 await f.app.changePassword({target:1,password:'replacement-secret'});
 assert.equal((await f.api('state',undefined,f.cookies[1])).status,401);
 assert.equal((await f.api('state',undefined,f.cookies[2])).status,200);
 assert.equal((await f.app.verifyPassword({target:1,password:'initial-password-1'})).matches,false);
 assert.equal((await f.app.verifyPassword({target:1,password:'replacement-secret'})).matches,true);
 assert.equal((await f.api('login',{memberId:1,password:'replacement-secret'},f.cookies[2])).status,200);
 await f.app.changePassword({target:'family',password:'replacement-family-secret'});
 assert.equal((await f.api('members',undefined,f.cookies[2])).status,401);
 assert.equal((await f.app.verifyPassword({target:'family',password:'replacement-family-secret'})).matches,true);
});
test('確認なしの全リセットは拒否。確認後は設定・メンバー・認証・予約・通知を消しリンクと鍵を更新',async t=>{
 const f=await fixture(t,{family:true});await f.state();
 await f.api('wish',{day:f.day,start:1080,duration:30},f.cookies[3]);await f.api('book',{day:f.day,start:900,duration:30},f.cookies[1]);await f.api('skip',{day:f.day,skip:true},f.cookies[2]);
 const db=new DatabaseSync(f.database);t.after(()=>db.close());
 db.prepare('INSERT INTO passkey_accounts VALUES(?,?)').run(1,Buffer.from('test-account'));
 db.prepare('INSERT INTO passkey_credentials VALUES(?,?,?,?,?,?,?,?)').run('test-credential',1,Buffer.from('key'),0,'[]','singleDevice',0,'2026-10-28');
 const session=db.prepare('SELECT token_hash FROM sessions WHERE member_id=1').get().token_hash;
 db.prepare('INSERT INTO push_subscriptions VALUES(?,?,?,?)').run('https://example.invalid/test',1,session,'{}');db.prepare('INSERT INTO notification_queue(endpoint,day,member_id) VALUES(?,?,?)').run('https://example.invalid/test',f.day,1);
 const old=db.prepare('SELECT * FROM family_config').get();
 assert.throws(()=>f.app.resetAllData());assert.equal(f.app.getSecurity().members.length,3);
 const result=f.app.resetAllData({confirmation:'RESET_ALL_DATA'});assert.equal(result.settings.members.length,0);assert.deepEqual(result.settings.current,DEFAULT_SCHEDULE);assert.equal(result.security.familyConfigured,false);assert.notEqual(result.accessToken,old.access_token);
 const config=db.prepare('SELECT * FROM family_config').get();assert.notEqual(config.vapid_public,old.vapid_public);assert.equal(config.password_hash,null);
 for(const table of ['members','draws','bookings','wishes','bath_skips','sessions','family_sessions','passkey_accounts','passkey_credentials','passkey_challenges','push_subscriptions','notification_queue'])assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n,0,table);
 assert.equal((await f.api('members',undefined,f.cookies[1])).status,401);
 const reloaded=createApp({database:f.database});assert.deepEqual(reloaded.getServerSettings().members,[]);assert.equal(reloaded.familyConfigured(),false);reloaded.close();
 // Reconfiguration works without restarting the server or reintroducing defaults.
 await f.app.changePassword({target:'family',password:'new-family-secret'});assert.equal(f.app.getSecurity().familyConfigured,true);
 f.app.saveServerSettings({members:[{name:'新利用者',active:true}],schedule:DEFAULT_SCHEDULE});assert.equal(f.app.getServerSettings().members.length,1);
});
test('プロフィールは未設定で始まり、絵文字と任意の色を全端末で共有し不正入力を拒否',async t=>{
 const f=await fixture(t);
 let state=await f.state();assert.ok(state.members.every(m=>m.emoji===null&&m.color===null));
 assert.equal((await f.api('profile',{emoji:'🦋',color:'#123AbC'},f.cookies[2])).status,200);
 state=await f.state();assert.equal(state.members[1].emoji,'🦋');assert.equal(state.members[1].color,'#123abc');
 for(const body of [{emoji:'<script>',color:'#123456'},{emoji:'🐈🐈',color:'#123456'},{emoji:'🐈',color:'url(https://example.test)'}])assert.equal((await f.api('profile',body,f.cookies[2])).status,400);
 assert.equal(profileColors.length,16);assert.equal(validateProfile({emoji:'👨‍👩‍👧',color:'#ABCDEF'}).color,'#abcdef');
 for(const path of ['security/get','security/password','data/reset'])assert.equal((await f.api(path,{target:1,password:'should-not-work',confirmation:'RESET_ALL_DATA'},f.cookies[1])).status,404);
});
test('希望がある区間は空きとして省略せず、予約や希望の重なりも全件保持',()=>{
 const bookings=[{memberId:1,start:1080,duration:60}];
 const wishes=[{memberId:2,start:1095,duration:15},{memberId:3,start:1140,duration:30},{memberId:4,start:1500,duration:15}];
 const segments=scheduleSegments(bookings,900,1860,wishes);
 assert.deepEqual(segments.map(s=>[s.kind,s.start,s.end]),[['break',900,1080],['overlap',1080,1140],['wish',1140,1170],['break',1170,1500],['wish',1500,1515],['break',1515,1860]]);
 const entries=segments.flatMap(s=>s.entries||(['wish','booking'].includes(s.kind)?[s]:[]));assert.equal(entries.length,4);assert.equal(entries.filter(e=>e.kind==='wish').length,3);
});

test('初回登録で選んだアイコンを保存し、無効な入力ではパスワードも登録しない',async t=>{
 const f=await fixture(t),settings=f.app.getServerSettings();f.app.saveServerSettings({members:[...settings.members,{name:'新しい利用者',active:true}],schedule:settings.upcoming});
 const body={memberId:4,password:'new-member-password',profile:{emoji:'🐳',color:'invalid'}};
 assert.equal((await f.api('register',body)).status,400);assert.equal((await f.api('members')).body.members.find(m=>m.id===4).registered,0);
 body.profile.color='#C48BD2';assert.equal((await f.api('register',body)).status,200);
 const member=(await f.api('members')).body.members.find(m=>m.id===4);assert.equal(member.emoji,'🐳');assert.equal(member.color,'#c48bd2');assert.equal(member.registered,1);
 body.profile.emoji='🐈';assert.equal((await f.api('register',body)).status,409);assert.equal((await f.api('members')).body.members.find(m=>m.id===4).emoji,'🐳');
});

test('自動確定した人への順番通知を飛ばし、次に操作が必要な本人だけに通知する',async t=>{
 const f=await fixture(t);await f.state();await f.api('wish',{day:f.day,start:1080,duration:30},f.cookies[2]);
 const db=new DatabaseSync(f.database);
 for(const id of [2,3]){const token=db.prepare('SELECT token_hash FROM sessions WHERE member_id=?').get(id).token_hash;db.prepare('INSERT INTO push_subscriptions VALUES(?,?,?,?)').run(`https://example.invalid/${id}`,id,token,'{}');}
 await f.api('book',{day:f.day,start:900,duration:30},f.cookies[1]);
 assert.deepEqual(db.prepare('SELECT member_id FROM notification_queue ORDER BY id').all().map(row=>row.member_id),[3]);db.close();
});

test('全リセット後は古い家族用リンクと通過クッキーを拒否する',async t=>{
 const app=createApp();await app.setFamilyPassword('old-family-password');
 const old=app.accessToken(),{server}=createHttpServer(app,{privateLink:true});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 t.after(async()=>{await new Promise(r=>server.close(r));app.close();});const base=`http://127.0.0.1:${server.address().port}`;
 assert.equal((await fetch(base+'/family/'+old+'/',{redirect:'manual'})).status,303);
 app.resetAllData({confirmation:'RESET_ALL_DATA'});assert.notEqual(app.accessToken(),old);
 assert.equal((await fetch(base+'/family/'+old+'/',{redirect:'manual'})).status,404);assert.equal((await fetch(base+'/api/members',{headers:{cookie:'bath_gate='+old}})).status,404);
 const next=await fetch(base+'/family/'+app.accessToken()+'/',{redirect:'manual'});assert.equal(next.status,303);assert.ok(next.headers.get('set-cookie').includes(app.accessToken()));
});
