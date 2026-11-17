import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {createApp} from '../src/app.js';
import {createHttpServer} from '../src/http.js';
import {DEFAULT_SCHEDULE} from '../src/server-settings.js';

async function fixture(t,{privateLink=false}={}) {
  const dir=mkdtempSync('/tmp/bathjun-bootstrap-');
  let clock=new Date('2026-11-16T08:00:00+09:00');
  const app=createApp({database:dir+'/test.sqlite',requireFamily:true,now:()=>clock,deliverPush:async()=>{}});
  app.saveServerSettings({members:[{name:'利用者A',active:true},{name:'利用者B',active:true}],schedule:{...DEFAULT_SCHEDULE,orderMode:'fixed'}});
  clock=new Date('2026-11-17T08:00:00+09:00');
  await app.setFamilyPassword('synthetic-family');
  const {server}=createHttpServer(app,{privateLink});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(async()=>{await new Promise(r=>server.close(r));app.close();rmSync(dir,{recursive:true,force:true});});
  const url='http://127.0.0.1:'+server.address().port;
  const gate=privateLink?'bath_gate='+app.accessToken():'';
  async function api(path,data,cookie='',includeGate=true) {
    const response=await fetch(url+'/api/'+path,{method:data===undefined?'GET':'POST',headers:{cookie:[includeGate&&gate,cookie].filter(Boolean).join('; '),'Content-Type':'application/json'},...(data===undefined?{}:{body:JSON.stringify(data)})});
    const text=await response.text();
    return {status:response.status,headers:response.headers,body:response.headers.get('content-type')?.includes('json')?JSON.parse(text):text,cookie:response.headers.get('set-cookie')?.split(';')[0]};
  }
  const family=(await api('family/login',{password:'synthetic-family'})).cookie;
  const session=(await api('register',{memberId:1,password:'synthetic-only'},family)).cookie;
  return {api,family,session,cookie:family+'; '+session,clock:value=>clock=new Date(value)};
}

test('startup exposes no member or booking data before family authentication',async t=>{
  const f=await fixture(t);
  for(const cookie of ['',f.session,'bath_family=invalid; '+f.session]) {
    const r=await f.api('bootstrap',undefined,cookie);
    assert.equal(r.status,200);
    assert.deepEqual(r.body,{family:{configured:true,authenticated:false},members:[],me:null,state:null});
    assert.equal(r.headers.get('cache-control'),'no-store');
  }
});

test('family-only startup returns the login choices without member-private state',async t=>{
  const f=await fixture(t),r=await f.api('bootstrap',undefined,f.family);
  assert.equal(r.status,200);assert.equal(r.body.family.authenticated,true);
  assert.equal(r.body.me,null);assert.equal(r.body.state,null);
  assert.deepEqual(r.body.members.map(m=>[m.name,!!m.registered]),[['利用者A',true],['利用者B',false]]);
  assert.ok(!JSON.stringify(r.body).includes('password_hash'));
});

test('one authenticated startup carries the same selected-day state as the existing API',async t=>{
  const f=await fixture(t);
  for(const day of ['2026-11-16','2026-11-17','2026-11-18','2026-11-19']) {
    const r=await f.api('bootstrap?day='+day,undefined,f.cookie);
    const state=await f.api('state?day='+day,undefined,f.cookie);
    assert.equal(r.status,200);assert.equal(r.body.state.day,day);
    assert.deepEqual(r.body.state,state.body);
    assert.deepEqual(r.body.me,r.body.state.me);
    assert.deepEqual(r.body.members,r.body.state.members);
    assert.equal(r.headers.get('cache-control'),'no-store');
  }
  assert.equal((await f.api('bootstrap?day=1999-01-01',undefined,f.cookie)).status,400);
});

test('expired member and family sessions return the appropriate login stage',async t=>{
  const f=await fixture(t);
  f.clock('2026-12-19T08:00:00+09:00');
  let r=await f.api('bootstrap',undefined,f.cookie);
  assert.equal(r.body.family.authenticated,true);assert.equal(r.body.me,null);assert.equal(r.body.state,null);assert.equal(r.body.members.length,2);
  f.clock('2027-06-01T08:00:00+09:00');
  r=await f.api('bootstrap',undefined,f.cookie);
  assert.equal(r.body.family.authenticated,false);assert.deepEqual(r.body.members,[]);assert.equal(r.body.state,null);
});

test('the private shared-link gate still guards the startup endpoint',async t=>{
  const f=await fixture(t,{privateLink:true});
  assert.equal((await f.api('bootstrap',undefined,f.cookie,false)).status,404);
  assert.equal((await f.api('bootstrap',undefined,f.cookie)).status,200);
});
