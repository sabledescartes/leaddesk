// Run with: node tests/run.mjs   (no dependencies, no network)
import assert from "node:assert/strict";
import fs from "node:fs";
import { loadFunctions, ROOT } from "./harness.mjs";
import { renderDemo } from "../scripts/build-demo.mjs";

const fx = await loadFunctions();
let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log("ok   " + name); }
  catch (e) { console.error("FAIL " + name + "\n     " + (e && e.message)); process.exitCode = 1; }
}

let ipCounter = 0;
const newIp = () => "10.0.0." + ++ipCounter;
const post = (fn, path, body, headers = {}) =>
  fn(new Request("http://x.test" + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-nf-client-connection-ip": newIp(), ...headers },
    body: JSON.stringify(body),
  }));
const good = { name: "Dana Whitfield", phone: "(214) 555-0101", email: "dana@example.com", city: "Plano", service: "Roof repair", message: "Leak over garage" };

process.env.ADMIN_PASSWORD = "correct horse battery";
process.env.BUSINESS_NAME = "Example Roofing Co.";

async function login(pw = process.env.ADMIN_PASSWORD, ip = newIp()) {
  return fx.admin(new Request("http://x.test/api/admin/login", {
    method: "POST", headers: { "Content-Type": "application/json", "x-nf-client-connection-ip": ip }, body: JSON.stringify({ password: pw }),
  }));
}
async function token() { return (await (await login()).json()).token; }
const api = async (method, path, body, tok) =>
  fx.admin(new Request("http://x.test/api/admin" + path, {
    method, headers: { "Content-Type": "application/json", Authorization: "Bearer " + tok }, body: body ? JSON.stringify(body) : undefined,
  }));
const list = async (tok) => (await (await api("GET", "/leads", null, tok)).json()).leads;

await test("preflight answers with CORS headers", async () => {
  const r = await fx.lead(new Request("http://x.test/api/lead", { method: "OPTIONS", headers: { Origin: "https://their-site.com" } }));
  assert.equal(r.status, 204);
  assert.equal(r.headers.get("access-control-allow-origin"), "*");
  assert.match(r.headers.get("access-control-allow-headers"), /Content-Type/);
});

await test("a good lead is saved and shows up in the admin list", async () => {
  const r = await post(fx.lead, "/api/lead", good);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true });
  const tok = await token();
  const leads = await list(tok);
  assert.equal(leads.length, 1);
  assert.equal(leads[0].name, "Dana Whitfield");
  assert.equal(leads[0].status, "new");
  assert.equal(leads[0].source, "Website form");
  assert.equal(leads[0].service, "Roof repair");
});

await test("GET on /api/lead is refused", async () => {
  const r = await fx.lead(new Request("http://x.test/api/lead", { method: "GET" }));
  assert.equal(r.status, 405);
});

await test("validation: name, phone and email", async () => {
  assert.equal((await post(fx.lead, "/api/lead", { ...good, name: " " })).status, 400);
  assert.equal((await post(fx.lead, "/api/lead", { ...good, phone: "555-0101" })).status, 400);
  assert.equal((await post(fx.lead, "/api/lead", { ...good, email: "not-an-email" })).status, 400);
  assert.equal((await post(fx.lead, "/api/lead", { ...good, email: "" })).status, 200, "email is optional");
  const bad = await fx.lead(new Request("http://x.test/api/lead", { method: "POST", body: "{nope", headers: { "x-nf-client-connection-ip": newIp() } }));
  assert.equal(bad.status, 400);
});

await test("honeypot and instant submits are swallowed without saving", async () => {
  const before = (await list(await token())).length;
  const a = await post(fx.lead, "/api/lead", { ...good, website: "http://spam.example" });
  const b = await post(fx.lead, "/api/lead", { ...good, t: Date.now() });
  assert.equal(a.status, 200); assert.equal(b.status, 200);
  assert.equal((await list(await token())).length, before);
  const c = await post(fx.lead, "/api/lead", { ...good, name: "Slow Human", t: Date.now() - 20000 });
  assert.equal(c.status, 200);
  assert.equal((await list(await token())).length, before + 1);
});

await test("long and hostile input is trimmed and stored as plain text", async () => {
  const xss = '<img src=x onerror=alert(1)>';
  await post(fx.lead, "/api/lead", { ...good, name: xss + "A".repeat(500), message: "x".repeat(5000) });
  const l = (await list(await token())).find((x) => x.name.startsWith(xss));
  assert.ok(l, "stored");
  assert.ok(l.name.length <= 120);
  assert.ok(l.message.length <= 1500);
});

await test("one visitor can send 8 leads an hour, the 9th is refused", async () => {
  const ip = "192.0.2.77";
  for (let i = 0; i < 8; i++) assert.equal((await post(fx.lead, "/api/lead", good, { "x-nf-client-connection-ip": ip })).status, 200);
  const r = await post(fx.lead, "/api/lead", good, { "x-nf-client-connection-ip": ip });
  assert.equal(r.status, 429);
  assert.match((await r.json()).error, /Too many/);
});

await test("ALLOWED_ORIGINS limits which sites the browser may post from", async () => {
  process.env.ALLOWED_ORIGINS = "https://mysite.com, https://www.mysite.com/";
  const ok = await fx.lead(new Request("http://x.test/api/lead", { method: "OPTIONS", headers: { Origin: "https://www.mysite.com" } }));
  assert.equal(ok.headers.get("access-control-allow-origin"), "https://www.mysite.com");
  const no = await fx.lead(new Request("http://x.test/api/lead", { method: "OPTIONS", headers: { Origin: "https://evil.example" } }));
  assert.equal(no.headers.get("access-control-allow-origin"), null);
  delete process.env.ALLOWED_ORIGINS;
});

await test("webhook gets the lead, and a broken webhook never loses it", async () => {
  const realFetch = globalThis.fetch;
  const calls = [];
  process.env.NOTIFY_WEBHOOK_URL = "https://hooks.example.test/abc";
  globalThis.fetch = async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); return new Response("ok"); };
  const before = (await list(await token())).length;
  await post(fx.lead, "/api/lead", { ...good, name: "Hook Test" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://hooks.example.test/abc");
  assert.match(calls[0].body.text, /Hook Test/);
  globalThis.fetch = async () => { throw new Error("network down"); };
  const r = await post(fx.lead, "/api/lead", { ...good, name: "Hook Down" });
  assert.equal(r.status, 200);
  assert.equal((await list(await token())).length, before + 2);
  globalThis.fetch = realFetch;
  delete process.env.NOTIFY_WEBHOOK_URL;
});

await test("admin: public config returns only the business name and whether a password is set", async () => {
  const r = await fx.admin(new Request("http://x.test/api/admin/config"));
  assert.deepEqual(await r.json(), { business: "Example Roofing Co.", ready: true });
});

await test("admin: no token, bad token, forged token are all refused", async () => {
  assert.equal((await api("GET", "/leads", null, "")).status, 401);
  assert.equal((await api("GET", "/leads", null, "123.abc")).status, 401);
  const tok = await token();
  const [exp, sig] = tok.split(".");
  assert.equal((await api("GET", "/leads", null, (Number(exp) + 1000) + "." + sig)).status, 401);
  assert.equal((await api("GET", "/leads", null, "1.2")).status, 401, "expired");
});

await test("admin: wrong password is refused, right password signs in", async () => {
  const bad = await login("wrong password!!");
  assert.equal(bad.status, 401);
  const ok = await login();
  assert.equal(ok.status, 200);
  assert.ok((await ok.json()).token);
});

await test("admin: refuses to run without a strong ADMIN_PASSWORD", async () => {
  const saved = process.env.ADMIN_PASSWORD;
  process.env.ADMIN_PASSWORD = "short";
  const r = await login("short");
  assert.equal(r.status, 503);
  delete process.env.ADMIN_PASSWORD;
  assert.equal((await login("anything")).status, 503);
  process.env.ADMIN_PASSWORD = saved;
});

await test("admin: add, update, note, archive, delete", async () => {
  const tok = await token();
  const add = await (await api("POST", "/leads", { name: "Walk In", phone: "214-555-0199", service: "Fence", estValue: "$7,800", note: "Met at home show" }, tok)).json();
  assert.equal(add.lead.estValue, "7800");
  assert.equal(add.lead.notes.length, 1);
  assert.equal((await api("POST", "/leads", { name: "" }, tok)).status, 400);

  const id = add.lead.id;
  let r = await (await api("PATCH", "/leads/" + id, { status: "won", wonAmount: "8,150", estValue: "9000" }, tok)).json();
  assert.equal(r.lead.status, "won"); assert.equal(r.lead.wonAmount, "8150"); assert.equal(r.lead.estValue, "9000");
  r = await (await api("PATCH", "/leads/" + id, { status: "nonsense" }, tok)).json();
  assert.equal(r.lead.status, "won", "unknown status ignored");
  r = await (await api("PATCH", "/leads/" + id, { note: "Signed" }, tok)).json();
  assert.equal(r.lead.notes.length, 2);

  assert.equal((await api("DELETE", "/leads/" + id, null, tok)).status, 400, "must archive first");
  await api("PATCH", "/leads/" + id, { archived: true }, tok);
  assert.equal((await api("DELETE", "/leads/" + id, null, tok)).status, 200);
  assert.ok(!(await list(tok)).some((l) => l.id === id));
  assert.equal((await api("PATCH", "/leads/does-not-exist", { status: "won" }, tok)).status, 404);
});

await test("admin: 10 wrong passwords lock that visitor out for the hour", async () => {
  const ip = "198.51.100.9";
  for (let i = 0; i < 10; i++) assert.equal((await login("nope-nope-nope", ip)).status, 401);
  assert.equal((await login("nope-nope-nope", ip)).status, 429);
  assert.equal((await login(process.env.ADMIN_PASSWORD, ip)).status, 429, "even the right password waits");
  assert.equal((await login()).status, 200, "other visitors unaffected");
});

await test("demo page is up to date with the dashboard (run scripts/build-demo.mjs)", async () => {
  assert.equal(fs.readFileSync(ROOT + "/demo/index.html", "utf8"), renderDemo());
});

console.log(`\n${passed} passed${process.exitCode ? ", some FAILED" : ""}`);
