import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createApp} from '../src/app.js';
import {DEFAULT_SCHEDULE} from '../src/server-settings.js';

test('ログイン・初回登録は不正なメンバーIDを500にせず拒否し、パスワード試行にも数えない',async t=>{
 const app=createApp({requireFamily:false,now:()=>new Date('2026-11-04T08:00:00+09:00'),deliverPush:async()=>{}});
 app.saveServerSettings({members:[{name:'試験利用者',active:true}],schedule:{...DEFAULT_SCHEDULE,orderMode:'fixed'}});
 const server=createServer(app.handle);await new Promise(r=>server.listen(0,'127.0.0.1',r));
 t.after(async()=>{await new Promise(r=>server.close(r));app.close()});
 const post=async(path,body)=>{
  const response=await fetch(`http://127.0.0.1:${server.address().port}/api/${path}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  return {status:response.status,body:await response.json()};
 };
 for(const path of ['register','login'])for(const memberId of [null,true,[],[1],{}, {toString:null,valueOf:null},{toString:'broken'},0,-1,1.5,'','1.5','1e0','1'.repeat(100),Number.MAX_SAFE_INTEGER+1]){
  const response=await post(path,{memberId,password:'synthetic-only'});
  assert.equal(response.status,400,JSON.stringify({path,memberId,response}));
  assert.equal(response.body.error,'利用できる名前を選んでください。');
 }
 // Keep compatibility with a numeric ID encoded as a string.
 assert.equal((await post('register',{memberId:'1',password:'synthetic-only'})).status,200);
 assert.equal((await post('login',{memberId:1,password:'synthetic-only'})).status,200);
});
