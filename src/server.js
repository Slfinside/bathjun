import { startRuntime, logLocalAddresses } from "./runtime.js";
import { reportServerState, registerServerStop } from "./server-panel.js";
try {
  const runtime = await startRuntime();
  logLocalAddresses(runtime.port);
  reportServerState(
    "ready",
    process.env.HOST === "127.0.0.1"
      ? "このPC内だけのテスト用サーバーが起動しています。"
      : "自宅ネットワーク用のサーバーが起動しています。",
    `http://localhost:${runtime.port}`,
  );
  const shutdown = (code = 0) => runtime.close().then(() => process.exit(code));
  registerServerStop(shutdown);
  if (!runtime.app.familyConfigured())
    console.log(
      "最初に別のターミナルで npm run family:password を実行し、家族の合い言葉を設定してください。",
    );
  console.log("終了するには Ctrl+C。時刻は日本時間です。");
  for (const signal of ["SIGINT", "SIGTERM"])
    process.on(signal, () => shutdown());
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
