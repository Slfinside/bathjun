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
  return new Promise((resolve) => {
    const socket = connect(pipePath(locator.name));
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timeout);
      socket.destroy();
      resolve(value);
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
    socket.on("data", () => finish(true));
  });
}
export async function startWindowsPanel(handlers) {
  if (process.platform !== "win32") return;
  const token = randomBytes(32).toString("hex"),
    name = "Bathjun-" + randomBytes(16).toString("hex");
  const controller = createPanelController({
    ...handlers,
    path: pipePath(name),
    token,
  });
  await controller.listen();
  activePanel = controller;
  const child = spawn(
    fileURLToPath(new URL("../../bin/Bathjun-Server.exe", import.meta.url)),
    [
      name,
      token,
      ...(handlers.mode === "public" ? ["--public"] : []),
      ...(process.env.BATHJUN_AUTOSTART === "1" ? ["--minimized"] : []),
    ],
    { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
  );
  child.stdout.on("data", data => process.stdout.write(data));
  child.stderr.on("data", data => process.stderr.write(data));
  await new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  }).catch(async (error) => {
    activePanel = null;
    await controller.close();
    throw error;
  });
  child.once("exit", (code, signal) => {
    console.error(`サーバー操作画面が終了しました（終了コード: ${code ?? signal}）。上のエラーを確認してください。`);
    void controller.stop(1);
  });
  const locatorPath = join(dataPaths().directory, "panel.json");
  writeFileSync(locatorPath, JSON.stringify({ name, token }), { mode: 0o600 });
  process.once("exit", () => {
    try {
      if (JSON.parse(readFileSync(locatorPath, "utf8")).token === token)
        unlinkSync(locatorPath);
    } catch {}
    child.kill();
  });
  return controller;
}
