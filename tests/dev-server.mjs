// Local preview. Run: node tests/dev-server.mjs
//   http://localhost:8888  -> the app you deploy (app/ + /api/*), like your Netlify site
//   http://localhost:8889  -> this repo's root (setup page, demo) plus tests/fixtures/*
// Data lives in memory and resets when you stop it.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { loadFunctions, ROOT } from "./harness.mjs";

process.env.ADMIN_PASSWORD ||= "test-password-123";
process.env.BUSINESS_NAME ||= "Example Roofing Co.";
const fx = await loadFunctions();

const toml = fs.readFileSync(path.join(ROOT, "netlify.toml"), "utf8");
const CSP = (toml.match(/Content-Security-Policy = "([^"]+)"/) || [])[1];

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css", ".json": "application/json",
  ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".txt": "text/plain", ".jpg": "image/jpeg" };

function serveStatic(root, extra) {
  return (req, res, urlPath) => {
    let p = path.normalize(decodeURIComponent(urlPath));
    let file = path.join(root, p);
    if (!file.startsWith(root)) { res.writeHead(403); return res.end(); }
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, "index.html");
    else if (!fs.existsSync(file) && fs.existsSync(path.join(file, "index.html"))) file = path.join(file, "index.html");
    if (!fs.existsSync(file)) { res.writeHead(404, { "Content-Type": "text/plain" }); return res.end("Not found"); }
    const headers = { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream", ...(extra ? extra(urlPath) : {}) };
    res.writeHead(200, headers);
    fs.createReadStream(file).pipe(res);
  };
}

async function runFn(fn, req, res) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks);
  const url = `http://${req.headers.host}${req.url}`;
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) headers.set(k, Array.isArray(v) ? v.join(",") : v);
  const request = new Request(url, { method: req.method, headers, body: ["GET", "HEAD"].includes(req.method) ? undefined : body });
  const response = await fn(request);
  const out = {};
  response.headers.forEach((v, k) => (out[k] = v));
  res.writeHead(response.status, out);
  res.end(Buffer.from(await response.arrayBuffer()));
}

const appStatic = serveStatic(path.join(ROOT, "app"), (u) => {
  const h = { "X-Content-Type-Options": "nosniff" };
  if (u.startsWith("/admin")) { h["Content-Security-Policy"] = CSP; h["X-Frame-Options"] = "DENY"; h["Cache-Control"] = "no-store"; }
  if (u === "/leaddesk.js") { h["Access-Control-Allow-Origin"] = "*"; h["Cross-Origin-Resource-Policy"] = "cross-origin"; }
  return h;
});
http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  try {
    if (u.pathname === "/api/lead") return await runFn(fx.lead, req, res);
    if (u.pathname.startsWith("/api/admin")) return await runFn(fx.admin, req, res);
    appStatic(req, res, u.pathname);
  } catch (e) { console.error(e); res.writeHead(500); res.end("error"); }
}).listen(8888, () => console.log("app   http://localhost:8888   (admin password: " + process.env.ADMIN_PASSWORD + ")"));

const siteStatic = serveStatic(ROOT);
http.createServer((req, res) => siteStatic(req, res, new URL(req.url, "http://x").pathname))
  .listen(8889, () => console.log("site  http://localhost:8889   (setup page, /demo/, /tests/fixtures/host.html)"));
