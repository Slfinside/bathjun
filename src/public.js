import { spawn } from "node:child_process";
import { startRuntime } from "./runtime.js";
import { configureFamily } from "./family-password.js";
import { openApplication } from "./runtime.js";
import { dataPaths } from "./data-paths.js";
import { writeFileSync, readFileSync, unlinkSync } from "node:fs";

// SQLite and the tunnel remain on the household server PC.
let runtime,
  tunnel,
  closing = false;
let publishedLink = null;
async function shutdown(code = 0) {
  if (closing) return;
  closing = true;
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
}
try {
  const check = spawn(process.env.CLOUDFLARED || "cloudflared", ["--version"], {
    stdio: "ignore",
  });
  await new Promise((resolve, reject) => {
    check.once("error", () =>
      reject(
        new Error(
          "cloudflared が見つかりません。Windowsでは同梱の起動ショートカットを、Macでは brew install cloudflared を使ってください。",
        ),
      ),
    );
    check.once("exit", (code) =>
      code === 0
        ? resolve()
        : reject(new Error("cloudflared を起動できません。")),
    );
  });
  const app = openApplication();
  try {
    if (!app.familyConfigured()) await configureFamily(app);
  } finally {
    app.close();
  }
  runtime = await startRuntime({ privateLink: true, host: "127.0.0.1" });
  console.log("家族用HTTPSリンクを作っています…");
  const configPath = dataPaths().tunnelConfig;
  // --config is deliberately an empty file: a personal ~/.cloudflared config must not turn this into a named tunnel.
  writeFileSync(configPath, "{}\n", { mode: 0o600 });
  tunnel = spawn(
    process.env.CLOUDFLARED || "cloudflared",
    [
      "tunnel",
      "--config",
      configPath,
      "--url",
      `http://127.0.0.1:${runtime.port}`,
      "--protocol",
      "http2",
      "--no-autoupdate",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let announced = false,
    buffer = "";
  const deadline = setTimeout(() => {
    console.error(
      "公開リンクを作れませんでした。ネットワークを確認して再実行してください。",
    );
    void shutdown(1);
  }, 60000);
  const onOutput = (chunk) => {
    buffer = (buffer + chunk.toString()).slice(-16000);
    const match = [
      ...buffer.matchAll(/https:\/\/([a-z0-9-]+)\.trycloudflare\.com/g),
    ].find((candidate) => candidate[1] !== "api");
    if (match && !announced) {
      announced = true;
      runtime.setPublicOrigin(match[0]);
      const link = `${match[0]}/family/${runtime.app.accessToken()}/`;
      void (async () => {
        let ready = false;
        for (let attempt = 0; attempt < 20 && !closing; attempt++) {
          try {
            const response = await fetch(link, {
              redirect: "manual",
              signal: AbortSignal.timeout(3000),
            });
            if (
              response.status === 303 &&
              response.headers.get("Set-Cookie")?.startsWith("bath_gate=")
            ) {
              ready = true;
              break;
            }
          } catch {}
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
        if (!ready || closing) return;
        clearTimeout(deadline);
        publishedLink = link;
        writeFileSync(dataPaths().publicLink, link + "\n", { mode: 0o600 });
        console.log(`\n家族用リンク（家族だけに共有してください）:\n${link}\n`);
        console.log(
          "最初に家族の合い言葉、その後に自分のパスワードを入力します。",
        );
        console.log(
          "iPhoneはSafariで開く → ホーム画面に追加 → 追加したアプリで「通知を受け取る」。",
        );
        console.log(
          "サーバー用PCを起動したまま使ってください。終了は Ctrl+C。再起動すると公開ドメインが変わります。",
        );
        if (
          process.platform === "darwin" &&
          process.env.BATHJUN_NO_BROWSER !== "1"
        )
          spawn("open", [link], { stdio: "ignore" }).on("error", () => {});
        if (
          process.platform === "win32" &&
          process.env.BATHJUN_NO_BROWSER !== "1"
        )
          spawn("explorer.exe", [link], { stdio: "ignore" }).on(
            "error",
            () => {},
          );
      })().catch(() => void shutdown(1));
    }
  };
  tunnel.stdout.on("data", onOutput);
  tunnel.stderr.on("data", onOutput);
  tunnel.once("error", (error) => {
    clearTimeout(deadline);
    console.error(error.message);
    void shutdown(1);
  });
  tunnel.once("exit", (code) => {
    clearTimeout(deadline);
    if (!closing) {
      console.error(
        /403|forbidden/i.test(buffer)
          ? "Cloudflareへの通信が403で拒否され、外部公開できませんでした。"
          : "外部公開が終了しました。ネットワークとCloudflareの稼働状況を確認してください。",
      );
      void shutdown(code || 0);
    }
  });
  for (const signal of ["SIGINT", "SIGTERM"])
    process.on(signal, () => void shutdown());
} catch (error) {
  console.error(error.message);
  await shutdown(1);
}
