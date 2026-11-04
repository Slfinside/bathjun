import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { request } from "node:http";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { createHttpServer } from "../src/http.js";

async function serverFor(t, privateLink = false) {
  const { server } = createHttpServer(
    {
      accessToken: () => "a".repeat(64),
      handle: (_req, res) => res.end('{"private":true}'),
    },
    { privateLink },
  );
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => server.close(r)));
  return (path, headers = {}, method = "GET") =>
    new Promise((resolve, reject) => {
      const req = request(
        {
          host: "127.0.0.1",
          port: server.address().port,
          path,
          headers,
          method,
        },
        (res) => {
          const body = [];
          res.on("data", (b) => body.push(b));
          res.on("end", () =>
            resolve({
              status: res.statusCode,
              headers: res.headers,
              body: Buffer.concat(body),
            }),
          );
        },
      );
      req.on("error", reject);
      req.end();
    });
}

test("画面ファイルは圧縮しETagで再検証、API・個別manifestは保存しない", async (t) => {
  const get = await serverFor(t, true),
    cookie = "bath_gate=" + "a".repeat(64);
  for (const [encoding, decode] of [
    ["br", brotliDecompressSync],
    ["gzip", gunzipSync],
  ]) {
    const response = await get("/app.js", {
      cookie,
      "accept-encoding": encoding,
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers["content-encoding"], encoding);
    assert.equal(response.headers["cache-control"], "private, no-cache");
    assert.equal(response.headers.vary, "Accept-Encoding");
    assert.deepEqual(
      decode(response.body),
      readFileSync(new URL("../public/app.js", import.meta.url)),
    );
    assert.ok(response.body.length < 30000);
    const headers = {
      cookie,
      "accept-encoding": encoding,
      "if-none-match": response.headers.etag,
    };
    const cached = await get("/app.js", headers);
    assert.equal(cached.status, 304);
    assert.equal(cached.body.length, 0);
    assert.equal(
      (await get("/app.js", { ...headers, cookie: "" })).status,
      404,
    );
    const head = await get(
      "/app.js",
      { cookie, "accept-encoding": encoding },
      "HEAD",
    );
    assert.equal(head.body.length, 0);
    assert.equal(Number(head.headers["content-length"]), response.body.length);
  }
  const identity = await get("/app.js", {
    cookie,
    "accept-encoding": "br;q=0,gzip;q=0",
  });
  assert.equal(identity.headers["content-encoding"], undefined);
  assert.deepEqual(
    identity.body,
    readFileSync(new URL("../public/app.js", import.meta.url)),
  );
  const api = await get("/api/state", { cookie });
  assert.equal(api.headers["cache-control"], "no-store");
  assert.equal(api.headers.etag, undefined);
  const manifest = await get("/manifest.webmanifest", { cookie });
  assert.equal(manifest.headers["cache-control"], "no-store");
  assert.equal(manifest.headers.etag, undefined);
  assert.equal(
    JSON.parse(manifest.body).start_url,
    "/family/" + "a".repeat(64) + "/",
  );
});

test("分割フォントは元の文字集合を重複・欠落なく保持し、共通文字は250KB未満で取得できる", () => {
  const root = new URL("../public/fonts/", import.meta.url),
    manifest = JSON.parse(readFileSync(new URL("web.json", root)));
  let commonBytes = 0;
  for (const face of manifest.faces) {
    assert.equal(
      createHash("sha256")
        .update(readFileSync(new URL(face.source, root)))
        .digest("hex"),
      face.sourceSha256,
    );
    const seen = new Set();
    commonBytes += face.files[0].bytes;
    for (const file of face.files) {
      const bytes = readFileSync(new URL("web/" + file.file, root));
      assert.equal(bytes.length, file.bytes);
      assert.equal(
        createHash("sha256").update(bytes).digest("hex"),
        file.sha256,
      );
      for (const point of file.codepoints) {
        assert.ok(!seen.has(point));
        seen.add(point);
      }
    }
    assert.equal(seen.size, face.sourceGlyphCount);
    assert.equal(
      createHash("sha256")
        .update([...seen].sort((a, b) => a - b).join(","))
        .digest("hex"),
      face.sourceCodepointsSha256,
    );
  }
  assert.ok(commonBytes < 250000);
});

test("ガイドと説明書は同一サーバーから読め、長い家族用リンクの認証を通す", async (t) => {
  const get = await serverFor(t, true),
    cookie = "bath_gate=" + "a".repeat(64);
  for (const path of [
    "/help.js",
    "/help/content.json",
    "/help/",
    "/help/manual.css",
    "/fonts/web.css",
  ]) {
    assert.equal((await get(path)).status, 404);
    assert.equal((await get(path, { cookie })).status, 200);
  }
  const guide = JSON.parse((await get("/help/content.json", { cookie })).body);
  for (const topic of ["booking", "items", "stamps", "autoStandby"])
    assert.ok(guide[topic].steps.length);
  const manual = (await get("/help/", { cookie })).body.toString();
  assert.ok(manual.includes("詳細を見る"));
  assert.ok(!manual.includes("<script"));
  assert.ok(!manual.includes("/family/"));
});
