import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
const equal = (a, b) =>
  typeof a === "string" &&
  Buffer.byteLength(a) === Buffer.byteLength(b) &&
  timingSafeEqual(Buffer.from(a), Buffer.from(b));
const assets = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/profile-picker.js": ["profile-picker.js", "text/javascript; charset=utf-8"],
  "/schedule-layout.js": ["schedule-layout.js", "text/javascript; charset=utf-8"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/style.css": ["style.css", "text/css; charset=utf-8"],
  "/icon.svg": ["icon.svg", "image/svg+xml"],
  "/icon-192.png": ["icon-192.png", "image/png"],
  "/icon-512.png": ["icon-512.png", "image/png"],
  "/sw.js": ["sw.js", "text/javascript; charset=utf-8"],
  "/manifest.webmanifest": [
    "manifest.webmanifest",
    "application/manifest+json",
  ],
};
export function createHttpServer(
  app,
  { privateLink = false, publicOrigin = null } = {},
) {
  const config = { publicOrigin };
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
    const path = new URL(req.url, "http://localhost").pathname;
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
    if (path.startsWith("/api/")) return void app.handle(req, res);
    const asset = assets[path];
    if (!asset || !["GET", "HEAD"].includes(req.method)) {
      res.writeHead(404);
      return res.end("Not found");
    }
    try {
      let content = readFileSync(
        new URL(`../public/${asset[0]}`, import.meta.url),
      );
      if (privateLink && path === "/manifest.webmanifest") {
        const manifest = JSON.parse(content.toString());
        manifest.start_url = `/family/${app.accessToken()}/`;
        manifest.scope = "/";
        content = Buffer.from(JSON.stringify(manifest));
      }
      res.writeHead(200, { "Content-Type": asset[1] });
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
