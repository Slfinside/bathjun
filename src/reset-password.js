import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { dataPaths } from "./data-paths.js";
const database = dataPaths().database;
const name = process.argv[2];
if (!name || !existsSync(database)) {
  console.error(
    "使い方: node src/reset-password.js 名前\n先にアプリを起動し、サーバー設定に登録した名前を指定してください。",
  );
  process.exit(1);
}
const db = new DatabaseSync(database);
db.exec("PRAGMA foreign_keys=ON");
try {
  db.exec("BEGIN IMMEDIATE");
  const member = db.prepare("SELECT id FROM members WHERE name=?").get(name);
  if (!member) throw new Error("その名前は登録されていません。");
  db.prepare(
    "UPDATE members SET password_hash=NULL,salt=NULL,failures=0,locked_until=0 WHERE id=?",
  ).run(member.id);
  db.prepare("DELETE FROM sessions WHERE member_id=?").run(member.id);
  if (
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE name='passkey_credentials'",
      )
      .get()
  )
    db.prepare("DELETE FROM passkey_credentials WHERE member_id=?").run(
      member.id,
    );
  db.exec("COMMIT");
  console.log(
    `${name}さんのパスワード設定を解除しました。アプリを再読み込みして、設定し直してください。予約と抽選結果は残っています。`,
  );
} catch (error) {
  db.exec("ROLLBACK");
  console.error(error.message);
  process.exitCode = 1;
} finally {
  db.close();
}
