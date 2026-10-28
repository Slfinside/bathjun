import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createApp } from "../src/app.js";
test("ローカル起動は継承した公開HOST設定を無視し、このPCだけで待ち受ける", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "bathjun-local-"));
  const app = createApp({ database: join(directory, "bathjun.sqlite") });
  await app.setFamilyPassword("local-test-password");
  app.close();
  const child = spawn(process.execPath, ["src/windows-launcher.js", "local"], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      BATHJUN_DATA_DIR: directory,
      BATHJUN_NO_BROWSER: "1",
      HOST: "0.0.0.0",
      PORT: "0",
    },
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((resolve) => child.once("exit", resolve));
      child.kill("SIGINT");
      await exited;
    }
    rmSync(directory, { recursive: true, force: true });
  });
  const port = await new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(
      () => reject(new Error("Startup timeout: " + output)),
      10000,
    );
    child.on("error", reject);
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error("Unexpected exit " + code + ": " + output));
    });
    child.stdout.on("data", (chunk) => {
      output += chunk;
      const match = output.match(/http:\/\/localhost:(\d+)/);
      if (match) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    });
    child.stderr.on("data", (chunk) => (output += chunk));
  });
  assert.equal((await fetch(`http://127.0.0.1:${port}/`)).status, 200);
  assert.equal(
    (await fetch(`http://127.0.0.1:${port}/api/members`)).status,
    401,
  );
  if (process.platform === "linux") {
    const hex = port.toString(16).toUpperCase().padStart(4, "0");
    const addresses = readFileSync("/proc/net/tcp", "utf8")
      .split("\n")
      .map((line) => line.trim().split(/\s+/))
      .filter((parts) => parts[1]?.endsWith(":" + hex) && parts[3] === "0A")
      .map((parts) => parts[1]);
    assert.deepEqual(addresses, ["0100007F:" + hex]);
  }
});
