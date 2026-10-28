import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { createApp } from "../src/app.js";

test("CloudflareのAPIエラーURLを家族用リンクと誤認しない", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "bathjun-public-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const database = join(directory, "app.sqlite"),
    binary = join(directory, "cloudflared");
  const app = createApp({ database });
  await app.setFamilyPassword("fake-family-password");
  app.close();
  writeFileSync(
    binary,
    `#!/usr/bin/env node\nif(process.argv.includes('--version'))process.exit(0);console.error('failed to request quick Tunnel: https://api.trycloudflare.com/tunnel connection refused');process.exit(1);\n`,
    { mode: 0o700 },
  );
  const child = spawn(process.execPath, ["src/public.js"], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      CLOUDFLARED: binary,
      BATHJUN_DB: database,
      PORT: "0",
    },
  });
  let output = "";
  child.stdout.on("data", (b) => (output += b));
  child.stderr.on("data", (b) => (output += b));
  const timeout = setTimeout(() => child.kill("SIGKILL"), 10000);
  const code = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", resolve);
  });
  clearTimeout(timeout);
  assert.equal(code, 1, output);
  assert.equal(
    output.includes("家族用リンク（家族だけに共有してください）"),
    false,
  );
  assert.match(output, /外部公開が終了/);
});

test("旧版のデータに追加マイグレーションを適用しても既存の予約を残す", () => {
  const directory = mkdtempSync(join(tmpdir(), "bathjun-migration-"));
  const database = join(directory, "app.sqlite");
  try {
    let db = new DatabaseSync(database);
    db.exec(
      readFileSync(
        new URL("../migrations/0001_initial.sql", import.meta.url),
        "utf8",
      ),
    );
    for (let id=1; id<=5; id++) db.prepare("INSERT INTO members(id,name) VALUES(?,?)").run(id, `メンバー${id}`);
    db.prepare("INSERT INTO draws VALUES(?,?,?)").run(
      "2026-10-28",
      "[1,2,3,4,5]",
      "2026-10-28T00:00:00Z",
    );
    db.prepare("INSERT INTO bookings VALUES(?,?,?,?)").run(
      "2026-10-28",
      1,
      900,
      30,
    );
    db.close();
    const app = createApp({ database });
    app.close();
    db = new DatabaseSync(database);
    const row = db.prepare("SELECT * FROM bookings").get();
    assert.equal(row.member_id, 1);
    assert.equal(row.start, 900);
    assert.equal(row.duration, 30);
    assert.equal(row.note, "");
    assert.equal(row.no_negotiation, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM members").get().n, 5);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM wishes").get().n, 0);
    db.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
