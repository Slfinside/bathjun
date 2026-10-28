import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { emitKeypressEvents } from "node:readline";
import { openApplication } from "./runtime.js";
export async function readPassword(prompt) {
  if (!process.stdin.isTTY)
    throw new Error("合い言葉はPCのターミナルから設定してください。");
  process.stdout.write(prompt);
  emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise((resolve, reject) => {
    let value = "";
    const finish = (error) => {
      process.stdin.off("keypress", onKey);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write("\n");
      if (error) reject(error);
      else resolve(value);
    };
    function onKey(text, key = {}) {
      if (key.ctrl && key.name === "c")
        return finish(new Error("中止しました。"));
      if (key.name === "return") return finish();
      if (key.name === "backspace") {
        value = [...value].slice(0, -1).join("");
        return;
      }
      if (text && !key.ctrl && !key.meta && !/[\x00-\x1f\x7f]/.test(text))
        value += text;
    }
    process.stdin.on("keypress", onKey);
  });
}
export async function configureFamily(app) {
  const password = await readPassword(
    "家族の合い言葉（8文字以上・入力は表示されません）: ",
  );
  const confirmation = await readPassword("確認のためもう一度: ");
  if (password !== confirmation)
    throw new Error("入力が一致しません。もう一度実行してください。");
  await app.setFamilyPassword(password);
  console.log("家族の合い言葉を設定しました。家族だけに共有してください。");
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const app = openApplication();
  try {
    await configureFamily(app);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    app.close();
  }
}
