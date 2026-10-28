import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { startRuntime, openApplication } from "./runtime.js";
import { configureFamily } from "./family-password.js";
import { dataPaths } from "./data-paths.js";
import { reportServerState, registerServerStop } from "./server-panel.js";
const execute = promisify(execFile);
export function tailscaleOrigin(status, port = 8443) {
  const name = status?.Self?.DNSName?.replace(/\.$/, "");
  if (
    status?.BackendState !== "Running" ||
    typeof name !== "string" ||
    !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+ts\.net$/.test(name)
  )
    throw new Error(
      "Tailscaleにサインインし、HTTPSの公開設定を有効にしてください。",
    );
  if (![443, 8443, 10000].includes(port))
    throw new Error("Funnelの公開ポートを確認してください。");
  return `https://${name}${port === 443 ? "" : ":" + port}`;
}
export function accountLinks(text) {
  return [
    ...text.matchAll(/https:\/\/login\.tailscale\.com\/[A-Za-z0-9_/?=&%.:-]+/g),
  ].map((m) => m[0]);
}
function openBrowser(url) {
  if (process.env.BATHJUN_NO_BROWSER === "1") return;
  if (process.platform === "win32")
    spawn("explorer.exe", [url], { stdio: "ignore" }).on("error", () => {});
  if (process.platform === "darwin")
    spawn("open", [url], { stdio: "ignore" }).on("error", () => {});
}
export async function runTailscalePublic() {
  const binary =
    process.env.TAILSCALE ||
    (process.platform === "win32"
      ? join(
          process.env.ProgramFiles || "C:\\Program Files",
          "Tailscale",
          "tailscale.exe",
        )
      : "tailscale");
  let runtime,
    tunnel,
    loginProcess,
    publishedLink,
    closing = false,
    deadline;
  const shutdown = async (code = 0) => {
    if (closing) return;
    closing = true;
    reportServerState("stopping", "サーバーを停止しています。", "");
    loginProcess?.kill("SIGTERM");
    clearTimeout(deadline);
    tunnel?.kill("SIGTERM");
    try {
      if (
        publishedLink &&
        readFileSync(dataPaths().publicLink, "utf8").trim() === publishedLink
      )
        unlinkSync(dataPaths().publicLink);
    } catch {}
    if (runtime) await runtime.close();
    process.exit(code);
  };
  registerServerStop((code) => shutdown(code));
  try {
    reportServerState("starting", "Tailscaleの接続を確認しています。", "");
    let status;
    const getStatus = async () => {
      try {
        return JSON.parse(
          (
            await execute(binary, ["status", "--json"], {
              timeout: 15000,
              maxBuffer: 1024 * 1024,
              windowsHide: true,
            })
          ).stdout,
        );
      } catch (error) {
        if (error.stdout) {
          try {
            return JSON.parse(error.stdout);
          } catch {}
        }
        throw new Error(
          "Tailscaleを起動できません。Windows版セットアップでTailscaleを導入し、再度開いてください。",
        );
      }
    };
    status = await getStatus();
    const seen = new Set();
    function authOutput(chunk) {
      for (const url of accountLinks(chunk.toString()))
        if (!seen.has(url)) {
          seen.add(url);
          console.log(
            "初回設定: このPCで次のページを開いてサインイン・公開を許可してください。\n" +
              url,
          );
          openBrowser(url);
        }
    }
    if (status.BackendState !== "Running") {
      if (process.env.BATHJUN_AUTOSTART === "1")
        throw new Error(
          "最初にデスクトップから起動して、Tailscaleへサインインしてください。",
        );
      console.log(
        "無料の固定URLを準備します。初回だけTailscaleにサインインしてください。",
      );
      reportServerState(
        "waiting",
        "開いたページでTailscaleへサインインしてください。",
      );
      const login = (loginProcess = spawn(binary, ["up", "--json"], {
        stdio: ["ignore", "pipe", "pipe"],
      }));
      let output = "";
      const loginTimer = setTimeout(() => login.kill("SIGTERM"), 300000);
      login.stdout.on("data", (chunk) => {
        output = (output + chunk).slice(-65536);
        authOutput(output);
      });
      login.stderr.on("data", authOutput);
      const code = await new Promise((resolve, reject) => {
        login.once("error", reject);
        login.once("exit", resolve);
      });
      clearTimeout(loginTimer);
      if (code !== 0)
        throw new Error(
          "Tailscaleへのサインインが完了していません。もう一度起動してください。",
        );
      status = await getStatus();
    }
    const origin = tailscaleOrigin(status);
    const app = openApplication();
    try {
      if (!app.familyConfigured()) await configureFamily(app);
    } finally {
      app.close();
    }
    runtime = await startRuntime({
      privateLink: true,
      publicOrigin: origin,
      host: "127.0.0.1",
    });
    const link = `${origin}/family/${runtime.app.accessToken()}/`;
    console.log("固定の家族用HTTPSリンクの接続を確認しています…");
    reportServerState(
      "waiting",
      "固定リンクを確認中です。必要に応じて開いたページで公開を許可してください。",
    );
    tunnel = spawn(
      binary,
      ["funnel", "--https=8443", `http://127.0.0.1:${runtime.port}`],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    // Foreground Funnel uses a daemon session; disconnecting this CLI removes this session's routing.
    // Do not use "funnel reset/off", which might remove unrelated services.
    tunnel.stdout.on("data", authOutput);
    tunnel.stderr.on("data", authOutput);
    let tunnelExited = false;
    tunnel.once("error", (error) => {
      console.error(error.message);
      void shutdown(1);
    });
    tunnel.once("exit", (code) => {
      tunnelExited = true;
      if (!closing) {
        console.error(
          "固定URLの公開が終了しました。Tailscaleのサインイン・HTTPS/Funnelの許可を確認してください。",
        );
        void shutdown(code || 1);
      }
    });
    for (const signal of ["SIGINT", "SIGTERM"])
      process.on(signal, () => void shutdown());
    deadline = setTimeout(() => {
      console.error(
        "公開の接続確認が完了しませんでした。画面に表示されたTailscaleの初回公開設定を確認してから、再度起動してください。",
      );
      void shutdown(1);
    }, 300000);
    for (
      let attempt = 0;
      attempt < 150 && !closing && !tunnelExited;
      attempt++
    ) {
      try {
        const response = await fetch(link, {
          redirect: "manual",
          signal: AbortSignal.timeout(3000),
        });
        if (
          response.status === 303 &&
          response.headers.get("Set-Cookie")?.startsWith("bath_gate=")
        ) {
          clearTimeout(deadline);
          publishedLink = link;
          reportServerState(
            "ready",
            "家族からアクセスできます。画面を消してもサーバーは動きます。",
            link,
          );
          writeFileSync(dataPaths().publicLink, link + "\n", { mode: 0o600 });
          console.log(`\n家族用の固定リンク（家族だけに共有）:\n${link}\n`);
          console.log(
            "このPCのTailscale登録を維持すれば、再起動しても同じリンクです。",
          );
          console.log(
            "初回ログイン後にパスキーを登録すると、次回から両方のパスワード入力を省略できます。",
          );
          console.log(
            "停止: この画面で Ctrl+C。起動中はPCをスリープさせないでください。",
          );
          openBrowser(link);
          return;
        }
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
  } catch (error) {
    console.error(error.message);
    reportServerState("error", error.message, "");
    await shutdown(1);
  }
}
