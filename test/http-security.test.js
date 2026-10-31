import test from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { createHttpServer } from "../src/http.js";
import { createApp } from "../src/app.js";

async function fixture(
  t,
  options = {},
  handle = async (_req, res) => res.end("ok"),
) {
  const { server } = createHttpServer(
    { accessToken: () => "0".repeat(64), handle },
    options,
  );
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return (path) =>
    new Promise((resolve, reject) => {
      const req = request(
        { hostname: "127.0.0.1", port: server.address().port, path },
        (res) => {
          const chunks = [];
          res.on("data", (chunk) => chunks.push(chunk));
          res.on("end", () =>
            resolve({
              status: res.statusCode,
              body: Buffer.concat(chunks).toString(),
            }),
          );
          res.on("error", reject);
        },
      );
      req.on("error", reject);
      req.end();
    });
}

for (const privateLink of [false, true]) {
  test(`不正URLは認証前でも400になりサーバーは継続する（privateLink=${privateLink}）`, async (t) => {
    const get = await fixture(t, { privateLink });
    for (const target of [
      "//[",
      "http://[",
      "//elsewhere.example/",
      "http://elsewhere.example/",
      "/\\elsewhere.example/",
    ]) {
      const response = await get(target);
      assert.equal(response.status, 400, target);
      assert.equal(response.body, "Bad request");
      assert.equal((await get("/")).status, privateLink ? 404 : 200);
    }
  });
}

test("予期しないAPIの非同期エラーや同期例外でも秘密を返さずサーバーを継続する", async (t) => {
  const get = await fixture(t, {}, (req, res) => {
    if (req.url === "/api/sync") throw new Error("private-test-detail");
    if (req.url === "/api/async")
      return Promise.reject(new Error("private-test-detail"));
    return Promise.resolve(res.end("ok"));
  });
  for (const path of ["/api/sync", "/api/async"]) {
    const response = await get(path);
    assert.equal(response.status, 500);
    assert.ok(!response.body.includes("private-test-detail"));
    assert.equal((await get("/api/healthy")).body, "ok");
  }
});

test("APIハンドラを直接使う場合も不正URLを400で処理する", async (t) => {
  const app = createApp();
  t.after(() => app.close());
  let status, body;
  await app.handle(
    { url: "//[", headers: {}, method: "GET" },
    {
      writeHead(value) {
        status = value;
      },
      end(value) {
        body = JSON.parse(value);
      },
    },
  );
  assert.equal(status, 400);
  assert.equal(typeof body.error, "string");
});
