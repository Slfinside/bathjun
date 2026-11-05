import {existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {activateInstalledUpdateSafely,installedLaunchMode,rememberLaunchMode} from './installed-update.js';
import {dataPaths} from './data-paths.js';
import { openApplication, getRunningApplication } from "./runtime.js";
import { configureFamily } from "./family-password.js";
import { spawn } from "node:child_process";
import { startWindowsPanel, showExistingWindowsPanel } from "./server-panel.js";
const installed=process.argv[2]==="installed"||process.argv.includes("--installed-update")||existsSync(fileURLToPath(new URL("../../installed-update.json",import.meta.url)));
const mode = process.argv[2]==="installed"?installedLaunchMode(dataPaths().directory):process.argv[2]||"public";
if (!["public", "local", "password"].includes(mode))
  throw new Error("起動方法を確認してください。");
// Local testing intentionally stays on loopback, regardless of inherited HOST.
if (mode === "local") process.env.HOST = "127.0.0.1";
let panel;
async function adminCall(operation) {
  const running = getRunningApplication();
  if (running) return operation(running);
  const app = openApplication();
  try {
    return await operation(app);
  } finally {
    app.close();
  }
}
try {
  if (mode !== "password" && (await showExistingWindowsPanel()))
    process.exit(0);
  const app = openApplication();
  try {
    activateInstalledUpdateSafely(app,{installed});
    if (mode === "password" || !app.familyConfigured()) {
      if (process.env.BATHJUN_AUTOSTART === "1")
        throw new Error(
          "最初にデスクトップのふろじゅんを開き、家族の合い言葉を設定してください。",
        );
      await configureFamily(app);
    }
  } finally {
    app.close();
  }
  if(mode!=="password")rememberLaunchMode(dataPaths().directory,mode);
  if (mode !== "password")
    panel = await startWindowsPanel({
      mode,
      onGetAnnouncements:()=>adminCall(app=>app.getAnnouncementsAdmin()),
      onSaveAnnouncement:payload=>adminCall(app=>app.saveAnnouncement(payload)),
      onArchiveAnnouncement:payload=>adminCall(app=>app.archiveAnnouncement(payload)),
      onUpdateStatus:()=>adminCall(app=>app.getUpdateStatus()),
      onGetRewards: () => adminCall((app) => app.getRewardsAdmin()),
      onSaveRewardSettings: (payload) =>
        adminCall((app) => app.saveRewardSettings(payload)),
      onDistributeItems: (payload) =>
        adminCall((app) => app.distributeItems(payload)),
      onCompleteBath: (payload) =>
        adminCall((app) => app.completeBath(payload)),
      onNotBathed:payload=>adminCall(app=>app.notBathed(payload)),
      onGetDashboard: () => adminCall((app) => app.getDashboard()),
      onGetSettings: () => adminCall((app) => app.getServerSettings()),
      onSaveSettings: (payload) =>
        adminCall((app) => app.saveServerSettings(payload)),
      onGetSecurity: () => adminCall((app) => app.getSecurity()),
      onVerifyPassword: (payload) =>
        adminCall((app) => app.verifyPassword(payload)),
      onChangePassword: (payload) =>
        adminCall((app) => app.changePassword(payload)),
      onResetData: (payload) => adminCall((app) => app.resetAllData(payload)),
      onStop: (code = 0) => {
        if (!process.emit("SIGINT")) process.exit(code);
      },
    });
  if (mode === "password") console.log("家族の合い言葉を変更しました。");
  else if (mode === "public") {
    const { runTailscalePublic } = await import("./tailscale-public.js");
    await runTailscalePublic();
  } else {
    await import("./server.js");
    if (process.exitCode) await panel?.close();
    if (!process.exitCode && process.env.BATHJUN_NO_BROWSER !== "1")
      spawn("explorer.exe", [`http://localhost:${process.env.PORT || 3000}`], {
        stdio: "ignore",
      }).on("error", () => {});
  }
} catch (error) {
  console.error("ふろじゅんを起動できませんでした。");
  console.error(error.stack || error.message);
  process.exitCode = 1;
  await panel?.close();
}
