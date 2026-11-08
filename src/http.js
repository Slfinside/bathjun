import { createServer } from "node:http";
import { readFileSync, statSync } from "node:fs";
import { brotliCompressSync, gzipSync, constants } from "node:zlib";
import { createHash, timingSafeEqual } from "node:crypto";
import { requestUrl } from "./request-url.js";
const equal = (a, b) =>
  typeof a === "string" &&
  Buffer.byteLength(a) === Buffer.byteLength(b) &&
  timingSafeEqual(Buffer.from(a), Buffer.from(b));
const webFonts = JSON.parse(
  readFileSync(new URL("../public/fonts/web.json", import.meta.url)),
);
const assets = {
  ...Object.fromEntries(
    webFonts.faces.flatMap((face) =>
      face.files.map((file) => [
        `/fonts/web/${file.file}`,
        [`fonts/web/${file.file}`, "font/woff2"],
      ]),
    ),
  ),
  "/fonts/web.css": ["fonts/web.css", "text/css; charset=utf-8"],
  "/stamp-picker.js": ["stamp-picker.js", "text/javascript; charset=utf-8"],
  "/bath-reports.js": ["bath-reports.js", "text/javascript; charset=utf-8"],
  "/announcements.js": ["announcements.js", "text/javascript; charset=utf-8"],
  "/help.js": ["help.js", "text/javascript; charset=utf-8"],
  "/help/": ["help/index.html", "text/html; charset=utf-8"],
  "/help/content.json": [
    "help/content.json",
    "application/json; charset=utf-8",
  ],
  "/help/manual.css": ["help/manual.css", "text/css; charset=utf-8"],
  ...Object.fromEntries(
    ["boost", "skip", "extend", "guard", "bathStamp", "stampInk"].map(
      (kind) => [`/items/${kind}.svg`, [`items/${kind}.svg`, "image/svg+xml"]],
    ),
  ),
  "/fonts/NotoSansJP-Regular.520ea0779f08.woff2": [
    "fonts/NotoSansJP-Regular.520ea0779f08.woff2",
    "font/woff2",
  ],
  "/fonts/NotoSansJP-Bold.ac652431d4be.woff2": [
    "fonts/NotoSansJP-Bold.ac652431d4be.woff2",
    "font/woff2",
  ],
  "/": ["index.html", "text/html; charset=utf-8"],
  "/profile-picker.js": ["profile-picker.js", "text/javascript; charset=utf-8"],
  "/schedule-layout.js": [
    "schedule-layout.js",
    "text/javascript; charset=utf-8",
  ],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/style.css": ["style.css", "text/css; charset=utf-8"],
  "/stamps/bath.svg": ["stamps/bath.svg", "image/svg+xml"],
  "/icon.svg": ["icon.svg", "image/svg+xml"],
  "/icon-192.png": ["icon-192.png", "image/png"],
  "/icon-512.png": ["icon-512.png", "image/png"],
  "/sw.js": ["sw.js", "text/javascript; charset=utf-8"],
  "/manifest.webmanifest": [
    "manifest.webmanifest",
    "application/manifest+json",
  ],
};
// Content negotiation respects q=0; API responses and gated manifests stay no-store.
function encodingFor(header = "") {
  const values = new Map(
    header.split(",").map((part) => {
      const [name, ...parameters] = part.trim().toLowerCase().split(";");
      const q = parameters.find((p) => p.trim().startsWith("q="));
      return [name, q ? Number(q.trim().slice(2)) : 1];
    }),
  );
  const quality = (name) => values.get(name) ?? values.get("*") ?? 0;
  const choices = ["br", "gzip"].filter((name) => quality(name) > 0);
  return choices.sort((a, b) => quality(b) - quality(a))[0] || "identity";
}
export function createHttpServer(
  app,
  { privateLink = false, publicOrigin = null } = {},
) {
  const config = { publicOrigin };
  const fileCache = new Map();
  const server = createServer((req, res) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Robots-Tag", "noindex, nofollow, noarchive");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    req.bathSecure =
      !!config.publicOrigin &&
      req.headers.host === new URL(config.publicOrigin).host;
    req.bathOrigin = req.bathSecure
      ? config.publicOrigin
      : `${req.socket.encrypted ? "https" : "http"}://${req.headers.host}`;
    let path;
    try {
      path = requestUrl(req.url).pathname;
    } catch {
      res.writeHead(400);
      return res.end("Bad request");
    }
    if (privateLink) {
      const cookie = (req.headers.cookie || "")
        .split(";")
        .map((v) => v.trim())
        .find((v) => v.startsWith("bath_gate="))
        ?.slice(10);
      if (
        equal(path, `/family/${app.accessToken()}/`) &&
        req.method === "GET"
      ) {
        res.setHeader(
          "Set-Cookie",
          `bath_gate=${app.accessToken()}; HttpOnly; SameSite=Lax; Path=/; Max-Age=34560000${req.bathSecure ? "; Secure" : ""}`,
        );
        res.writeHead(303, { Location: "/" });
        return res.end();
      }
      if (!equal(cookie, app.accessToken())) {
        res.writeHead(404);
        return res.end("Not found");
      }
    }
    if (path.startsWith("/api/")) {
      // Keep an unexpected rejected handler from terminating the server process.
      void Promise.resolve()
        .then(() => app.handle(req, res))
        .catch(() => {
          if (res.headersSent) return res.destroy();
          res.writeHead(500, {
            "Content-Type": "application/json; charset=utf-8",
          });
          res.end(JSON.stringify({ error: "サーバーでエラーが起きました。" }));
        });
      return;
    }
    const asset = assets[path];
    if (!asset || !["GET", "HEAD"].includes(req.method)) {
      res.writeHead(404);
      return res.end("Not found");
    }
    try {
      const file = new URL(`../public/${asset[0]}`, import.meta.url);
      const stat = statSync(file),
        stamp = `${stat.mtimeMs}:${stat.size}`;
      let cached = fileCache.get(path);
      if (!cached || cached.stamp !== stamp) {
        cached = { stamp, content: readFileSync(file), variants: new Map() };
        fileCache.set(path, cached);
      }
      if (privateLink && path === "/manifest.webmanifest") {
        const manifest = JSON.parse(cached.content.toString());
        manifest.start_url = `/family/${app.accessToken()}/`;
        manifest.scope = "/";
        res.writeHead(200, { "Content-Type": asset[1] });
        return res.end(
          req.method === "HEAD" ? undefined : JSON.stringify(manifest),
        );
      }
      const compressible =
        /^(text\/|application\/(json|manifest\+json)|image\/svg\+xml)/.test(
          asset[1],
        );
      const encoding =
        compressible && cached.content.length > 256
          ? encodingFor(req.headers["accept-encoding"])
          : "identity";
      if (!cached.variants.has(encoding)) {
        const content =
          encoding === "br"
            ? brotliCompressSync(cached.content, {
                params: { [constants.BROTLI_PARAM_QUALITY]: 4 },
              })
            : encoding === "gzip"
              ? gzipSync(cached.content)
              : cached.content;
        const etag =
          '"' + createHash("sha256").update(content).digest("hex") + '"';
        cached.variants.set(encoding, { content, etag });
      }
      const { content, etag } = cached.variants.get(encoding);
      res.setHeader(
        "Cache-Control",
        asset[1] === "font/woff2"
          ? "private, max-age=31536000, immutable"
          : "private, no-cache",
      );
      res.setHeader("ETag", etag);
      res.setHeader("Vary", "Accept-Encoding");
      res.setHeader("Content-Type", asset[1]);
      if (encoding !== "identity") res.setHeader("Content-Encoding", encoding);
      if (
        (req.headers["if-none-match"] || "")
          .split(",")
          .some(
            (tag) =>
              tag.trim() === "*" || tag.trim().replace(/^W\//, "") === etag,
          )
      ) {
        res.writeHead(304);
        return res.end();
      }
      res.setHeader("Content-Length", content.length);
      res.writeHead(200);
      res.end(req.method === "HEAD" ? undefined : content);
    } catch {
      res.writeHead(500);
      res.end("Could not read app assets");
    }
  });
  return {
    server,
    setPublicOrigin: (origin) => {
      const url = new URL(origin);
      if (url.protocol !== "https:" || url.origin !== origin)
        throw new Error("公開先はHTTPSのオリジンを指定してください。");
      config.publicOrigin = origin;
    },
  };
}
