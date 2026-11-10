import { seedTestMembers } from "../test-support/household.js";
import test from "node:test";
import assert from "node:assert/strict";
import { connect } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createPanelController } from "../src/server-panel.js";
import { createApp } from "../src/app.js";
async function fixture(t,{onShow,now}={}) {
  const dir = mkdtempSync(join(tmpdir(), "bathjun-panel-"));
  const path = join(dir, "control.sock"),
    token = "a".repeat(64);
  const app = createApp(now?{now}:{});
  seedTestMembers(app);
  let stopped = 0;
  const control = createPanelController({
    path,
    token,
    onGetDashboard: app.getDashboard,
    onGetSettings: app.getServerSettings,
    onSaveSettings: app.saveServerSettings,
    onGetSecurity:app.getSecurity,
    onVerifyPassword:app.verifyPassword,
    onChangePassword:app.changePassword,
    onResetData:app.resetAllData,
    onUnreservedBath:app.reportUnreservedBath,
    onStop: () => stopped++,
    onShow,
  });
  await control.listen();
  t.after(async () => {
    await control.close();
    app.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { path, token, control, app, stopped: () => stopped };
}
async function client(path) {
  const socket = connect(path);
  socket.setEncoding("utf8");
  await new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  let buffer = "";
  const waiting = [],
    messages = [];
  socket.on("data", (data) => {
    buffer += data;
    let i;
    while ((i = buffer.indexOf("\n")) >= 0) {
      const item = JSON.parse(buffer.slice(0, i));
      buffer = buffer.slice(i + 1);
      if (waiting.length) waiting.shift()(item);
      else messages.push(item);
    }
  });
  return {
    socket,
    next: () =>
      messages.length
        ? Promise.resolve(messages.shift())
        : new Promise((resolve) => waiting.push(resolve)),
    send: (value) => socket.write(JSON.stringify(value) + "\n"),
  };
}
test("PC操作用IPCは秘密トークンで保護し、未認証の停止を受け付けない", async (t) => {
  const f = await fixture(t);
  const c = await client(f.path);
  let received = false;
  c.socket.on("data", () => (received = true));
  const closed = new Promise((resolve) => c.socket.once("close", resolve));
  c.send({ token: "wrong", command: "stop" });
  await closed;
  assert.equal(received, false);
  assert.equal(f.stopped(), 0);
});
test("操作画面へ状態を通知し、設定変更と停止操作をローカルIPCで受け付ける", async (t) => {
  const f = await fixture(t);
  const c = await client(f.path);
  c.send({ token: f.token, command: "status", id: "1" });
  const initial=(await c.next()).state;assert.equal(initial.phase,"starting");assert.equal(initial.pid,process.pid);
  f.control.update({
    phase: "ready",
    detail: "サーバー稼働中",
    url: "https://example.test/family/test/",
  });
  assert.equal((await c.next()).state.phase, "ready");
  c.send({ token: f.token, command: "settings/get", id: "2" });
  const config = (await c.next()).settings;
  assert.equal(config.members.length, 5);
  config.members[0].name = "おとうさん";
  c.send({
    token: f.token,
    command: "settings/save",
    id: "3",
    payload: {
      members: config.members,
      schedule: { ...config.upcoming, orderMode: "fixed" },
    },
  });
  const saved = await c.next();
  assert.equal(saved.ok, true);
  assert.equal(saved.settings.members[0].name, "おとうさん");
  assert.equal(saved.settings.upcoming.orderMode, "fixed");
  c.send({ token: f.token, command: "stop", id: "4" });
  assert.equal((await c.next()).ok, true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.stopped(), 1);
  c.socket.destroy();
});

test("パスワード管理と全リセットを認証済みIPCだけで行い、家族用リンクも更新する",async t=>{
 const f=await fixture(t),c=await client(f.path);t.after(()=>c.socket.destroy());
 const command=async(command,payload,id)=>{c.send({token:f.token,command,payload,id});return c.next();};
 const security=await command('security/get',undefined,'security');assert.equal(security.security.members.length,5);assert.equal(security.security.familyConfigured,false);assert.equal(security.security.members[0].passwordSet,false);
 const changed=await command('security/password',{target:1,password:'admin-new-secret'},'password');assert.equal(changed.ok,true);assert.equal(changed.security.members[0].passwordSet,true);assert.doesNotMatch(JSON.stringify(changed),/admin-new-secret|password_hash|salt/);
 const verify=await command('security/verify',{target:1,password:'admin-new-secret'},'verify');assert.equal(verify.verification.matches,true);
 assert.equal((await command('data/reset',{},'unconfirmed')).ok,false);assert.equal(f.app.getServerSettings().members.length,5);
 f.control.update({phase:'ready',url:'https://example.test/family/'+f.app.accessToken()+'/'});await c.next();
 const reset=await command('data/reset',{confirmation:'RESET_ALL_DATA'},'reset');assert.equal(reset.ok,true);assert.equal(reset.settings.members.length,0);assert.equal(reset.security.familyConfigured,false);assert.equal(reset.state.url,'https://example.test/family/'+f.app.accessToken()+'/');
});

test("ダッシュボードは認証済みローカルIPCからのみ読み出す",async t=>{
 const f=await fixture(t),c=await client(f.path);
 c.send({token:f.token,command:"dashboard/get",id:"dashboard"});
 const reply=await c.next();assert.equal(reply.ok,true);assert.equal(reply.id,"dashboard");
 assert.equal(reply.dashboard.members.length,5);assert.equal(reply.dashboard.qr.length,0);
 assert.equal(reply.dashboard.phase,"starting");assert.equal(reply.dashboard.shareUrl,"");
 assert.ok(!JSON.stringify(reply.dashboard).includes("password"));
 c.socket.destroy();
});

test("authenticated show can reopen a lost management window without stopping the server",async t=>{
 let shown=0;const f=await fixture(t,{onShow:async()=>{shown++}}),c=await client(f.path);t.after(()=>c.socket.destroy());
 c.send({token:f.token,command:'show',id:'restore'});let reply;do{reply=await c.next()}while(reply.id!=='restore');assert.equal(reply.ok,true);assert.equal(shown,1);assert.equal(f.stopped(),0);
});


test("予約外の入浴報告は認証済みIPCで共有し予約枠にはしない",async t=>{
 const f=await fixture(t,{now:()=>new Date('2026-11-04T18:45:00+09:00')}),c=await client(f.path);t.after(()=>c.socket.destroy());
 c.send({token:f.token,command:'bath/unreserved',id:'actual',payload:{memberId:1,day:'2026-11-04',start:1080,duration:30,note:'実際の入浴',requestId:'dashboard-actual-test'}});
 const result=await c.next();assert.equal(result.ok,true);assert.ok(result.dashboard);assert.equal(result.dashboard.entries.filter(e=>e.unreserved).length,1);
});
