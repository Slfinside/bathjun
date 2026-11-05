import { getServerPowerProtected, renewServerPowerProtection } from "./runtime.js";
import { dashboardView, dashboardQr } from "./dashboard.js";
import { createServer, connect } from "node:net";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { dataPaths } from "./data-paths.js";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
let activePanel;
const pipePath = (name) => "\\\\.\\pipe\\" + name;
export function reportServerState(phase, detail, url) {
  activePanel?.update({ phase, detail, serverPowerHeld:getServerPowerProtected(), ...(url === undefined ? {} : { url }) });
}
export function registerServerStop(stop) {
  activePanel?.setStop(stop);
}
export function createPanelController({
  path,
  token,
  onGetDashboard,
  onGetAnnouncements,onSaveAnnouncement,onArchiveAnnouncement,onUpdateStatus,
  onGetRewards,
  onSaveRewardSettings,
  onDistributeItems,
  onCompleteBath,
  onGetSettings,
  onSaveSettings,
  onGetSecurity,
  onVerifyPassword,
  onChangePassword,
  onResetData,
  onStop,
  onShow,
}) {
  const clients = new Set();
  let state = {
    pid: process.pid,
    phase: "starting",
    detail: "サーバーを起動しています。",
    url: "",
  };
  let stop = onStop;
  const send = (client, value) => {
    if (!client.destroyed) client.write(JSON.stringify(value) + "\n");
  };
  const server = createServer((socket) => {
    if (clients.size >= 4) {
      socket.destroy();
      return;
    }
    socket.setEncoding("utf8");
    clients.add(socket);
    let buffer = "",
      authenticated = false;
    socket.on("close", () => clients.delete(socket));
    socket.on("error", () => {});
    socket.on("data", (data) => {
      buffer += data.toString("utf8");
      if (Buffer.byteLength(buffer) > 262144) {
        socket.destroy();
        return;
      }
      let index;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        void handle(line);
      }
    });
    async function handle(line) {
      let message;
      try {
        message = JSON.parse(line);
        if (
          typeof message.token !== "string" ||
          Buffer.byteLength(message.token) !== Buffer.byteLength(token) ||
          !timingSafeEqual(Buffer.from(message.token), Buffer.from(token))
        ) {
          socket.destroy();
          return;
        }
        authenticated = true;
        socket.panelAuthenticated = true;
        if (message.command === "status")
          send(socket, { id: message.id, ok: true, state });
        else if (message.command === "dashboard/get")
          send(socket, {
            id: message.id,
            ok: true,
            dashboard: {
              ...dashboardView(await onGetDashboard()),
              ...dashboardQr(state),
              phase: state.phase,
            },
          });
        else if(message.command==='announcements/get')send(socket,{id:message.id,ok:true,announcements:await onGetAnnouncements()});
        else if(message.command==='announcements/save')send(socket,{id:message.id,ok:true,announcements:await onSaveAnnouncement(message.payload)});
        else if(message.command==='announcements/archive')send(socket,{id:message.id,ok:true,announcements:await onArchiveAnnouncement(message.payload)});
        else if(message.command==='update/status')send(socket,{id:message.id,ok:true,readiness:await onUpdateStatus()});
        else if (message.command === "items/get")
          send(socket, {
            id: message.id,
            ok: true,
            rewards: await onGetRewards(),
          });
        else if (message.command === "items/distribute")
          send(socket, {
            id: message.id,
            ok: true,
            rewards: await onDistributeItems(message.payload),
          });
        else if (message.command === "items/settings")
          send(socket, {
            id: message.id,
            ok: true,
            rewards: await onSaveRewardSettings(message.payload),
          });
        else if (message.command === "bath/complete") {
          await onCompleteBath(message.payload);
          send(socket, {
            id: message.id,
            ok: true,
            dashboard: {
              ...dashboardView(await onGetDashboard()),
              ...dashboardQr(state),
              phase: state.phase,
            },
          });
        } else if (message.command === "settings/get")
          send(socket, {
            id: message.id,
            ok: true,
            settings: await onGetSettings(),
          });
        else if (message.command === "settings/save")
          send(socket, {
            id: message.id,
            ok: true,
            settings: await onSaveSettings(message.payload),
          });
        else if (message.command === "security/get")
          send(socket, {
            id: message.id,
            ok: true,
            security: await onGetSecurity(),
          });
        else if (message.command === "security/verify")
          send(socket, {
            id: message.id,
            ok: true,
            verification: await onVerifyPassword(message.payload),
          });
        else if (message.command === "security/password")
          send(socket, {
            id: message.id,
            ok: true,
            security: await onChangePassword(message.payload),
            notice:
              "パスワードを変更しました。対象のログインとパスキーを解除しました。",
          });
        else if (message.command === "data/reset") {
          const result = await onResetData(message.payload);
          if (state.url) {
            const url = new URL(state.url);
            if (url.pathname.startsWith("/family/")) {
              url.pathname = `/family/${result.accessToken}/`;
              state = { ...state, url: url.href };
            }
          }
          send(socket, {
            id: message.id,
            ok: true,
            settings: result.settings,
            security: result.security,
            state,
            notice:
              "全データをリセットしました。家族の合い言葉とメンバーを設定してください。",
          });
        } else if (message.command === "show") {
          await onShow?.();
          for (const client of clients)
            if (client.panelAuthenticated)
              send(client, { ok: true, show: true });
          send(socket, { id: message.id, ok: true });
        } else if (message.command === "power/renew") {
          state={...state,serverPowerHeld:renewServerPowerProtection()};
          for(const client of clients)if(client.panelAuthenticated)send(client,{ok:true,state});
          send(socket,{id:message.id,ok:true});
        } else if (message.command === "stop") {
          send(socket, { id: message.id, ok: true });
          await stop?.();
        } else
          send(socket, {
            id: message.id,
            ok: false,
            error: "この操作には対応していません。",
          });
      } catch (error) {
        if (authenticated)
          send(socket, {
            id: message?.id,
            ok: false,
            error: error.message || "設定を確認してください。",
          });
        else socket.destroy();
      }
    }
  });
  return {
    listen: () =>
      new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(path, resolve);
      }),
    update: (patch) => {
      state = { ...state, ...patch };
      for (const socket of clients)
        if (socket.panelAuthenticated) send(socket, { ok: true, state });
    },
    setStop: (callback) => {
      stop = callback;
    },
    stop: (code) => stop?.(code),
    close: async () => {
      for (const socket of clients) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
export async function showExistingWindowsPanel() {
  if (process.platform !== "win32") return false;
  let locator;
  try {
    locator = JSON.parse(
      readFileSync(join(dataPaths().directory, "panel.json"), "utf8"),
    );
  } catch {
    return false;
  }
  if (
    !/^Bathjun-[a-f0-9]{32}$/.test(locator.name) ||
    !/^[a-f0-9]{64}$/.test(locator.token)
  )
    return false;
  return new Promise((resolve,reject) => {
    const socket = connect(pipePath(locator.name));
    let done = false,buffer="";
    const finish = (value,error) => {
      if (done) return;
      done = true;
      clearTimeout(timeout);
      socket.destroy();
      if(error)reject(error);else resolve(value);
    };
    const timeout = setTimeout(() => finish(false), 2000);
    socket.on("error", () => finish(false));
    socket.on("close", () => finish(false));
    socket.on("connect", () =>
      socket.write(
        JSON.stringify({ token: locator.token, command: "show", id: "open" }) +
          "\n",
      ),
    );
    socket.on("data", data => {
      buffer+=data.toString("utf8");
      if(Buffer.byteLength(buffer)>262144)return finish(false,new Error("管理画面からの応答を確認できませんでした。"));
      let index;while((index=buffer.indexOf("\n"))>=0){
        const line=buffer.slice(0,index);buffer=buffer.slice(index+1);
        try{const reply=JSON.parse(line);if(reply.id==="open")finish(reply.ok===true,reply.ok?null:new Error(reply.error||"管理画面を開けませんでした。"))}catch(error){finish(false,error)}
      }
    });
  });
}
export async function startWindowsPanel(handlers) {
  if (process.platform !== "win32") return;
  const token = randomBytes(32).toString("hex"),
    name = "Bathjun-" + randomBytes(16).toString("hex");
  let child, launching, restartTimer, closing=false, automaticRetries=0;
  const reportFailure=error=>console.error("サーバー操作画面を開けませんでした。予約サーバーは継続しています。\n"+(error.stack||error.message));
  const controller = createPanelController({
    ...handlers,
    path: pipePath(name),
    token,
    // A second shortcut invocation can restore the UI of the existing server.
    onShow: () => launch(true),
  });
  const closeController=controller.close;
  controller.close=async()=>{
    closing=true;clearTimeout(restartTimer);
    activePanel=null;
    await closeController();
    child?.kill();
  };
  function launch(show=false){
    if(closing||child?.exitCode===null&&!child.killed)return Promise.resolve();
    if(launching)return launching;
    clearTimeout(restartTimer);
    launching=(async()=>{
      const current=spawn(
        fileURLToPath(new URL("../../bin/Bathjun-Server.exe", import.meta.url)),
        [name,token,...(handlers.mode === "public" ? ["--public"] : []),
          ...(process.env.BATHJUN_AUTOSTART === "1" && !show ? ["--minimized"] : [])],
        // This is a GUI executable. SW_HIDE can hide its first WinForms window.
        {stdio:["ignore","pipe","pipe"],windowsHide:false},
      );
      child=current;
      current.stdout.on("data",data=>process.stdout.write(data));
      current.stderr.on("data",data=>process.stderr.write(data));
      current.once("exit",(code,signal)=>{
        if(child===current)child=null;
        if(closing)return;
        console.error(`サーバー操作画面が終了しました（終了コード: ${code??signal}）。予約サーバーは継続しています。`);
        if(automaticRetries++<1){
          console.error("サーバー操作画面を開き直します。");
          restartTimer=setTimeout(()=>{void launch().catch(reportFailure)},300);
          restartTimer.unref();
        }else console.error("操作画面を開き直すには、ふろじゅんの起動用ショートカットをもう一度開いてください。上のエラーも確認してください。");
      });
      try{
        await new Promise((resolve,reject)=>{current.once("spawn",resolve);current.once("error",reject)});
      }catch(error){if(child===current)child=null;throw error}
    })().finally(()=>{launching=null});
    return launching;
  }
  await controller.listen();activePanel=controller;
  try{await launch()}catch(error){await controller.close();throw error}
  const locatorPath=join(dataPaths().directory,"panel.json");
  writeFileSync(locatorPath,JSON.stringify({name,token}),{mode:0o600});
  process.once("exit",()=>{
    closing=true;clearTimeout(restartTimer);
    try{if(JSON.parse(readFileSync(locatorPath,"utf8")).token===token)unlinkSync(locatorPath)}catch{}
    child?.kill();
  });
  return controller;
}
