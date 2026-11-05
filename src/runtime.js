import { acquireServerPower } from "./server-power.js";
import { mkdirSync } from "node:fs";
import { dataPaths } from "./data-paths.js";
import { createNotificationPump } from "./notification-pump.js";
import { networkInterfaces } from "node:os";
import { createApp } from "./app.js";
import { createHttpServer } from "./http.js";
let runningApplication,runningPower;
export const getServerPowerProtected=()=>runningPower?.protected===true;
export const renewServerPowerProtection=()=>runningPower?.renew()===true;
export const getRunningApplication=()=>runningApplication;
export function openApplication(options = {}) {
  const paths = dataPaths();
  mkdirSync(paths.directory, { recursive: true, mode: 0o700 });
  return createApp({ database: paths.database, ...options });
}
export async function startRuntime({
  privateLink = false,
  publicOrigin = null,
  host = process.env.HOST || "0.0.0.0",
  port = Number(process.env.PORT || 3000),
} = {}) {
  let notifications;
  const app = openApplication({
    onNotificationQueued: () => notifications?.wake(),
  });
  const { server, setPublicOrigin } = createHttpServer(app, {
    privateLink,
    publicOrigin,
  });
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, resolve);
    });
  } catch (error) {
    app.close();
    throw error;
  }
  const power=acquireServerPower();runningPower=power;
  if(process.platform==='win32'&&!power.protected)console.warn("サーバーのスリープ防止を有効にできませんでした。画面消灯は利用できません。");
  runningApplication=app;
  notifications = createNotificationPump(app, {
    onError: () => console.warn("通知の再試行を待っています。"),
  });
  notifications.start();
  let closePromise;
  const close = () =>
    (closePromise ||= (async () => {
      notifications.close();
      await new Promise((resolve) => server.close(resolve));
      if(runningApplication===app)runningApplication=null;
      app.close();
      power.close();if(runningPower===power)runningPower=null;
    })());
  return { app, server, setPublicOrigin, close, port: server.address().port };
}
export function logLocalAddresses(port) {
  console.log(`ふろじゅん: http://localhost:${port}`);
  if (["127.0.0.1", "::1", "localhost"].includes(process.env.HOST)) {
    console.log("このPC内からだけ接続できます。");
    return;
  }
  for (const addresses of Object.values(networkInterfaces()))
    for (const a of addresses || [])
      if (a.family === "IPv4" && !a.internal)
        console.log(`同じWi-FiのiPhone: http://${a.address}:${port}`);
}
