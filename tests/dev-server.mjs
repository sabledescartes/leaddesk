// Local preview of the hosted Lead Desk. Run: npm run dev
//   http://localhost:8888  -> the site, dashboard and /api/* (like Netlify)
//   http://localhost:8889  -> a fake contractor website: /tests/fixtures/host.html?key=ld_...
// Data lives in memory and resets when you stop it.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { loadFunctions, ROOT } from "./harness.mjs";

const fx = await loadFunctions();
const toml = fs.readFileSync(path.join(ROOT, "netlify.toml"), "utf8");

// Read the [[headers]] blocks so local pages get the same security headers.
const headerRules = [...toml.matchAll(/\[\[headers\]\]\s+for = "([^"]+)"\s+\[headers\.values\]([\s\S]*?)(?=\n\[\[|\n#|$)/g)].map((m) => ({
  pattern: new RegExp("^" + m[1].replace(/[.]/g, "\\.").replace(/\*/g, ".*") + "$"),
  values: Object.fromEntries([...m[2].matchAll(/^\s*([\w-]+) = "(.*)"\s*$/gm)].map((x) => [x[1], x[2]])),
}));
const REWRITES = { "/login": "/auth/index.html", "/signup": "/auth/index.html" };

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css", ".json": "application/json",
  ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".txt": "text/plain", ".jpg": "image/jpeg" };

function serveStatic(root, res, urlPath, extra = {}) {
  let file = path.join(root, path.normalize(decodeURIComponent(urlPath)));
  if (!file.startsWith(root)) { res.writeHead(403); return res.end(); }
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, "index.html");
  if (!fs.existsSync(file)) {
    res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(fs.existsSync(path.join(root, "404.html")) ? fs.readFileSync(path.join(root, "404.html")) : "Not found");
  }
  res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream", ...extra });
  fs.createReadStream(file).pipe(res);
}

async function runFn(fn, req, res) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) headers.set(k, Array.isArray(v) ? v.join(",") : v);
  headers.set("x-nf-client-connection-ip", req.socket.remoteAddress || "127.0.0.1");
  const request = new Request(`http://${req.headers.host}${req.url}`, {
    method: req.method, headers, body: ["GET", "HEAD"].includes(req.method) ? undefined : Buffer.concat(chunks),
  });
  const response = await fn(request);
  const out = {};
  response.headers.forEach((v, k) => (out[k] = v));
  res.writeHead(response.status, out);
  res.end(Buffer.from(await response.arrayBuffer()));
}

http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  try {
    if (u.pathname === "/api/lead" || u.pathname.startsWith("/api/form/")) return await runFn(fx.lead, req, res);
    if (u.pathname.startsWith("/api/auth/")) return await runFn(fx.auth, req, res);
    if (u.pathname.startsWith("/api/app/")) return await runFn(fx.app, req, res);
    if (u.pathname.startsWith("/api/estimate/")) return await runFn(fx.estimate, req, res);
    if (u.pathname.startsWith("/admin")) { res.writeHead(301, { Location: "/dashboard/" }); return res.end(); }
    const p = REWRITES[u.pathname] || u.pathname;
    const extra = {};
    for (const r of headerRules) if (r.pattern.test(u.pathname) || r.pattern.test(p)) Object.assign(extra, r.values);
    serveStatic(path.join(ROOT, "app"), res, p, extra);
  } catch (e) { console.error(e); res.writeHead(500); res.end("error"); }
}).listen(8888, () => console.log("app   http://localhost:8888"));

http.createServer((req, res) => serveStatic(ROOT, res, new URL(req.url, "http://x").pathname))
  .listen(8889, () => console.log("site  http://localhost:8889/tests/fixtures/host.html?key=..."));
