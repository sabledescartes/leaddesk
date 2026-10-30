// Run with: node tests/run.mjs   (no dependencies, no network)
import assert from "node:assert/strict";
import { loadFunctions } from "./harness.mjs";

const fx = await loadFunctions();
let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log("ok   " + name); }
  catch (e) { console.error("FAIL " + name + "\n     " + (e && e.stack || e)); process.exitCode = 1; }
}

let ipCounter = 0;
const newIp = () => "10.0." + Math.floor(++ipCounter / 250) + "." + (ipCounter % 250);
const BASE = "https://leaddesk.test";

function request(fn, method, path, { body, cookie, origin, ip, headers = {} } = {}) {
  const h = { "Content-Type": "application/json", "x-nf-client-connection-ip": ip || newIp(), ...headers };
  if (cookie) h.Cookie = cookie;
  if (origin) h.Origin = origin;
  return fn(new Request(BASE + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined }));
}
const cookieOf = (r) => (r.headers.get("set-cookie") || "").split(";")[0];

let n = 0;
async function signup(extra = {}) {
  const email = `owner${++n}@example.com`;
  const r = await request(fx.auth, "POST", "/api/auth/signup", {
    body: { email, password: "long enough password", business: "Example Roofing " + n, ...extra },
  });
  const j = await r.json();
  return { r, j, email, cookie: cookieOf(r), account: j.account };
}
const app = (method, path, cookie, body, opts = {}) => request(fx.app, method, "/api/app" + path, { cookie, body, ...opts });
const leads = async (cookie) => (await (await app("GET", "/leads", cookie)).json()).leads;
const visitorLead = (key, extra = {}, opts = {}) =>
  request(fx.lead, "POST", "/api/lead", {
    origin: "https://their-site.com",
    ...opts,
    body: { key, name: "Dana Whitfield", phone: "(214) 555-0101", email: "dana@example.com", city: "Plano", service: "Roof repair", message: "Leak over garage", t: Date.now() - 5000, ...extra },
  });

// ---- accounts ----
await test("sign up creates an account, a site key and a secure session cookie", async () => {
  const { r, j } = await signup();
  assert.equal(r.status, 200);
  assert.match(j.account.siteKey, /^ld_/);
  const sc = r.headers.get("set-cookie");
  assert.match(sc, /ld_session=/);
  assert.match(sc, /HttpOnly/);
  assert.match(sc, /Secure/);
  assert.match(sc, /SameSite=Lax/);
  assert.equal(j.account.passHash, undefined, "password hash must never leave the server");
});

await test("sign up rejects a short password, bad email, missing business, and duplicates", async () => {
  assert.equal((await signup({ password: "short" })).r.status, 400);
  assert.equal((await signup({ email: "not-an-email" })).r.status, 400);
  assert.equal((await signup({ business: "  " })).r.status, 400);
  const first = await signup();
  const again = await request(fx.auth, "POST", "/api/auth/signup", { body: { email: first.email.toUpperCase(), password: "another long password", business: "X" } });
  assert.equal(again.status, 409);
});

await test("sign in works with the right password and fails with the wrong one", async () => {
  const { email } = await signup();
  const ok = await request(fx.auth, "POST", "/api/auth/login", { body: { email, password: "long enough password" } });
  assert.equal(ok.status, 200);
  assert.match(cookieOf(ok), /^ld_session=/);
  const bad = await request(fx.auth, "POST", "/api/auth/login", { body: { email, password: "wrong password!!" } });
  assert.equal(bad.status, 401);
  const nobody = await request(fx.auth, "POST", "/api/auth/login", { body: { email: "nobody@example.com", password: "whatever123" } });
  assert.equal(nobody.status, 401);
  assert.equal((await nobody.json()).error, (await bad.json()).error, "same message for unknown email and wrong password");
});

await test("wrong passwords lock the email after 10 tries, even from new networks", async () => {
  const { email } = await signup();
  for (let i = 0; i < 10; i++) await request(fx.auth, "POST", "/api/auth/login", { body: { email, password: "nope nope " + i } });
  const r = await request(fx.auth, "POST", "/api/auth/login", { body: { email, password: "long enough password" } });
  assert.equal(r.status, 429);
});

await test("sign up is limited to 5 accounts per network per hour", async () => {
  const ip = "192.0.2.77";
  for (let i = 0; i < 5; i++) {
    const r = await request(fx.auth, "POST", "/api/auth/signup", { ip, body: { email: `burst${i}@example.com`, password: "long enough password", business: "B" } });
    assert.equal(r.status, 200);
  }
  const r = await request(fx.auth, "POST", "/api/auth/signup", { ip, body: { email: "burst9@example.com", password: "long enough password", business: "B" } });
  assert.equal(r.status, 429);
});

await test("me returns the account for a valid cookie and 401 for a forged one", async () => {
  const { cookie, account } = await signup();
  const me = await request(fx.auth, "GET", "/api/auth/me", { cookie });
  assert.equal((await me.json()).account.id, account.id);
  const forged = cookie.replace(/.$/, (c) => (c === "A" ? "B" : "A"));
  assert.equal((await request(fx.auth, "GET", "/api/auth/me", { cookie: forged })).status, 401);
  const other = cookie.replace(account.id, "acct_0000000000000000");
  assert.equal((await request(fx.auth, "GET", "/api/auth/me", { cookie: other })).status, 401);
});

await test("dashboard calls need a session and refuse other websites", async () => {
  const { cookie } = await signup();
  assert.equal((await app("GET", "/leads", "")).status, 401);
  assert.equal((await app("POST", "/leads", cookie, { name: "X" }, { origin: "https://evil.example" })).status, 403);
  assert.equal((await app("POST", "/leads", cookie, { name: "X" }, { origin: BASE })).status, 200);
});

// ---- the public form ----
await test("form settings are public by site key, with CORS", async () => {
  const { cookie, account } = await signup();
  await app("PATCH", "/account", cookie, { form: { title: "Get a roof quote", color: "#0055FF", services: "Repair\nReplacement" } });
  const r = await request(fx.lead, "GET", "/api/form/" + account.siteKey, { origin: "https://their-site.com" });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("access-control-allow-origin"), "*");
  const { form } = await r.json();
  assert.equal(form.title, "Get a roof quote");
  assert.deepEqual(form.services, ["Repair", "Replacement"]);
  assert.equal(form.business, account.business);
  assert.equal(form.siteKey, undefined);
  assert.equal((await request(fx.lead, "GET", "/api/form/ld_doesnotexist000")).status, 404);
});

await test("a visitor's lead lands only in the right account", async () => {
  const a = await signup();
  const b = await signup();
  const r = await visitorLead(a.account.siteKey);
  assert.equal(r.status, 200);
  const la = await leads(a.cookie);
  assert.equal(la.length, 1);
  assert.equal(la[0].name, "Dana Whitfield");
  assert.equal(la[0].status, "new");
  assert.equal((await leads(b.cookie)).length, 0, "account B must not see account A's lead");
});

await test("one account cannot read or change another account's lead", async () => {
  const a = await signup();
  const b = await signup();
  await visitorLead(a.account.siteKey);
  const [lead] = await leads(a.cookie);
  assert.equal((await app("PATCH", "/leads/" + lead.id, b.cookie, { status: "won" })).status, 404);
  assert.equal((await app("DELETE", "/leads/" + lead.id, b.cookie)).status, 404);
  assert.equal((await leads(a.cookie))[0].status, "new");
});

await test("lead validation: name and 10-digit phone required, email optional but checked", async () => {
  const { account } = await signup();
  assert.equal((await visitorLead(account.siteKey, { name: "" })).status, 400);
  assert.equal((await visitorLead(account.siteKey, { phone: "555-0101" })).status, 400);
  assert.equal((await visitorLead(account.siteKey, { email: "dana@" })).status, 400);
  assert.equal((await visitorLead(account.siteKey, { email: "" })).status, 200);
  assert.equal((await visitorLead("ld_unknownkey123456")).status, 404);
});

await test("bots are dropped silently: hidden field and too-fast submits", async () => {
  const { account, cookie } = await signup();
  assert.equal((await visitorLead(account.siteKey, { website: "spam.biz" })).status, 200);
  assert.equal((await visitorLead(account.siteKey, { t: Date.now() })).status, 200);
  assert.equal((await leads(cookie)).length, 0);
});

await test("a visitor can send 8 leads per hour to one contractor", async () => {
  const { account } = await signup();
  const ip = "198.51.100.9";
  for (let i = 0; i < 8; i++) assert.equal((await visitorLead(account.siteKey, {}, { ip })).status, 200);
  assert.equal((await visitorLead(account.siteKey, {}, { ip })).status, 429);
});

await test("allowed websites: other sites are refused once a list is set", async () => {
  const { account, cookie } = await signup();
  const bad = await app("PATCH", "/account", cookie, { allowedOrigins: "not a url with spaces" });
  assert.equal(bad.status, 400);
  const r = await app("PATCH", "/account", cookie, { allowedOrigins: "www.myroofing.com, https://myroofing.com/" });
  assert.deepEqual((await r.json()).account.allowedOrigins, ["https://www.myroofing.com", "https://myroofing.com"]);
  assert.equal((await visitorLead(account.siteKey, {}, { origin: "https://copycat.example" })).status, 403);
  const ok = await visitorLead(account.siteKey, {}, { origin: "https://myroofing.com" });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("access-control-allow-origin"), "https://myroofing.com");
});

await test("webhook gets the new lead; a broken webhook never loses it", async () => {
  const { account, cookie } = await signup();
  assert.equal((await app("PATCH", "/account", cookie, { webhook: "http://insecure.example" })).status, 400);
  await app("PATCH", "/account", cookie, { webhook: "https://hooks.example/abc" });
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => { calls.push({ url, body: JSON.parse(opts.body) }); throw new Error("down"); };
  try { assert.equal((await visitorLead(account.siteKey)).status, 200); }
  finally { globalThis.fetch = realFetch; }
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://hooks.example/abc");
  assert.match(calls[0].body.text, /Dana Whitfield/);
  assert.equal((await leads(cookie)).length, 1);
});

// ---- the pipeline ----
await test("status, value, notes and archive are saved with history", async () => {
  const { account, cookie } = await signup();
  await visitorLead(account.siteKey);
  const [lead] = await leads(cookie);
  const r = await app("PATCH", "/leads/" + lead.id, cookie, { status: "quoted", estValue: "$12,400", note: "Sent quote by email" });
  const { lead: up } = await r.json();
  assert.equal(up.status, "quoted");
  assert.equal(up.estValue, "12400");
  assert.equal(up.notes[0].text, "Sent quote by email");
  assert.ok(up.activity.some((a) => /new to quoted/.test(a.text)));
  assert.equal((await app("PATCH", "/leads/" + lead.id, cookie, { status: "bogus" })).status, 200);
  assert.equal((await leads(cookie))[0].status, "quoted");
});

await test("delete forever only works on archived leads", async () => {
  const { account, cookie } = await signup();
  await visitorLead(account.siteKey);
  const [lead] = await leads(cookie);
  assert.equal((await app("DELETE", "/leads/" + lead.id, cookie)).status, 400);
  await app("PATCH", "/leads/" + lead.id, cookie, { archived: true });
  assert.equal((await app("DELETE", "/leads/" + lead.id, cookie)).status, 200);
  assert.equal((await leads(cookie)).length, 0);
});

await test("leads added by hand need a name", async () => {
  const { cookie } = await signup();
  assert.equal((await app("POST", "/leads", cookie, { phone: "1" })).status, 400);
  const r = await app("POST", "/leads", cookie, { name: "Walk-in customer", estValue: "900" });
  assert.equal((await r.json()).lead.source, "Added by hand");
});

// ---- account management ----
await test("a new site key stops the old one from working", async () => {
  const { account, cookie } = await signup();
  const r = await app("POST", "/rotate-key", cookie);
  const next = (await r.json()).account.siteKey;
  assert.notEqual(next, account.siteKey);
  assert.equal((await visitorLead(account.siteKey)).status, 404);
  assert.equal((await visitorLead(next)).status, 200);
});

await test("changing the password signs out old sessions", async () => {
  const { cookie, email } = await signup();
  assert.equal((await app("POST", "/password", cookie, { current: "wrong", next: "brand new password" })).status, 400);
  const r = await app("POST", "/password", cookie, { current: "long enough password", next: "brand new password" });
  assert.equal(r.status, 200);
  assert.equal((await app("GET", "/leads", cookie)).status, 401, "old cookie is dead");
  assert.equal((await app("GET", "/leads", cookieOf(r))).status, 200, "new cookie works");
  const login = await request(fx.auth, "POST", "/api/auth/login", { body: { email, password: "brand new password" } });
  assert.equal(login.status, 200);
});

await test("deleting the account removes its leads, key and login", async () => {
  const { account, cookie, email } = await signup();
  await visitorLead(account.siteKey);
  assert.equal((await app("DELETE", "/account", cookie, { password: "wrong" })).status, 400);
  assert.equal((await app("DELETE", "/account", cookie, { password: "long enough password" })).status, 200);
  assert.equal((await visitorLead(account.siteKey)).status, 404);
  const login = await request(fx.auth, "POST", "/api/auth/login", { body: { email, password: "long enough password" } });
  assert.equal(login.status, 401);
  const leftovers = [...fx.stores().get("ld-leads").keys()].filter((k) => k.startsWith(account.id));
  assert.equal(leftovers.length, 0);
});

await test("sign out clears the cookie", async () => {
  const { cookie } = await signup();
  const r = await request(fx.auth, "POST", "/api/auth/logout", { cookie });
  assert.match(r.headers.get("set-cookie"), /Max-Age=0/);
});


// ---- photos and files ----
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9]);
const dataUrl = (buf, type = "image/jpeg") => `data:${type};base64,` + buf.toString("base64");

await test("customer photos are saved with the lead; fake images are dropped", async () => {
  const { account, cookie } = await signup();
  const html = Buffer.from("<html><script>alert(1)</script></html>");
  const r = await visitorLead(account.siteKey, { photos: [
    { name: "roof.jpg", data: dataUrl(JPEG) },
    { name: "evil.jpg", data: dataUrl(html) },
    { name: "two.jpg", data: dataUrl(JPEG) }, { name: "three.jpg", data: dataUrl(JPEG) }, { name: "four.jpg", data: dataUrl(JPEG) },
  ] });
  assert.equal(r.status, 200);
  const [lead] = await leads(cookie);
  assert.equal(lead.files.length, 2, "only real images, and only the first 3 entries are considered");
  assert.equal(lead.files[0].by, "customer");
  assert.equal(lead.files[0].type, "image/jpeg");
  const f = await app("GET", `/files/${lead.id}/${lead.files[0].id}`, cookie);
  assert.equal(f.status, 200);
  assert.equal(f.headers.get("content-type"), "image/jpeg");
  assert.match(f.headers.get("content-security-policy"), /sandbox/);
  assert.equal(Buffer.from(await f.arrayBuffer()).length, JPEG.length);
});

await test("photos are skipped when the contractor turns them off", async () => {
  const { account, cookie } = await signup();
  await app("PATCH", "/account", cookie, { form: { photos: false } });
  await visitorLead(account.siteKey, { photos: [{ name: "a.jpg", data: dataUrl(JPEG) }] });
  assert.equal((await leads(cookie))[0].files.length, 0);
});

function upload(cookie, leadId, buf, name, type = "application/octet-stream") {
  return fx.app(new Request(BASE + "/api/app/files/" + leadId, {
    method: "POST", headers: { Cookie: cookie, "Content-Type": type, "X-File-Name": encodeURIComponent(name), "Content-Length": String(buf.length) }, body: buf,
  }));
}

await test("contractor uploads, downloads and deletes a file; HTML is never served inline", async () => {
  const { account, cookie } = await signup();
  await visitorLead(account.siteKey);
  const [lead] = await leads(cookie);
  const pdf = Buffer.from("%PDF-1.4\n%fake\n");
  const r = await upload(cookie, lead.id, pdf, "Measurements.pdf", "application/pdf");
  assert.equal(r.status, 200);
  const { file } = await r.json();
  assert.equal(file.type, "application/pdf");
  const evil = await (await upload(cookie, lead.id, Buffer.from("<script>alert(1)</script>"), "x.html", "text/html")).json();
  assert.equal(evil.file.type, "application/octet-stream");
  const g = await app("GET", `/files/${lead.id}/${evil.file.id}`, cookie);
  assert.equal(g.headers.get("content-type"), "application/octet-stream");
  assert.match(g.headers.get("content-disposition"), /^attachment/);
  const me = await (await request(fx.auth, "GET", "/api/auth/me", { cookie })).json();
  assert.ok(me.account.storageBytes >= pdf.length);
  assert.equal((await app("DELETE", `/files/${lead.id}/${file.id}`, cookie)).status, 200);
  assert.equal((await app("GET", `/files/${lead.id}/${file.id}`, cookie)).status, 404);
});

await test("files over 4 MB are refused, and other accounts cannot read files", async () => {
  const a = await signup(); const b = await signup();
  await visitorLead(a.account.siteKey);
  const [lead] = await leads(a.cookie);
  assert.equal((await upload(a.cookie, lead.id, Buffer.alloc(4 * 1024 * 1024 + 10), "big.bin")).status, 413);
  const { file } = await (await upload(a.cookie, lead.id, JPEG, "p.jpg")).json();
  assert.equal((await app("GET", `/files/${lead.id}/${file.id}`, b.cookie)).status, 404);
  assert.equal((await upload(b.cookie, lead.id, JPEG, "p.jpg")).status, 404);
});

// ---- tasks ----
await test("tasks: create for a lead, finish, and they stay private to the account", async () => {
  const a = await signup(); const b = await signup();
  await visitorLead(a.account.siteKey);
  const [lead] = await leads(a.cookie);
  assert.equal((await app("POST", "/tasks", a.cookie, { title: "" })).status, 400);
  const r = await app("POST", "/tasks", a.cookie, { title: "Call back about the quote", due: "2026-11-02", time: "09:30", leadId: lead.id });
  const { task } = await r.json();
  assert.equal(task.leadName, lead.name);
  assert.equal(task.due, "2026-11-02");
  await app("POST", "/tasks", a.cookie, { title: "Order shingles", due: "not a date" });
  const list = (await (await app("GET", "/tasks", a.cookie)).json()).tasks;
  assert.equal(list.length, 2);
  assert.equal(list.find((t) => t.title === "Order shingles").due, "");
  assert.equal((await (await app("GET", "/tasks", b.cookie)).json()).tasks.length, 0);
  assert.equal((await app("PATCH", "/tasks/" + task.id, b.cookie, { done: true })).status, 404);
  const done = (await (await app("PATCH", "/tasks/" + task.id, a.cookie, { done: true })).json()).task;
  assert.ok(done.done && done.doneAt);
  assert.ok((await leads(a.cookie))[0].activity.some((x) => /Done: Call back/.test(x.text)));
  assert.equal((await app("DELETE", "/tasks/" + task.id, a.cookie)).status, 200);
});

// ---- estimates ----
const est = (method, token, action, body, opts = {}) => request(fx.estimate, method, "/api/estimate/" + token + (action ? "/" + action : ""), { body, origin: BASE, ...opts });

await test("estimate: totals in cents, customer opens and accepts, the lead becomes won", async () => {
  const { account, cookie } = await signup();
  await app("PATCH", "/account", cookie, { profile: { taxRate: "8.25", address: "100 Main St, Plano TX", phone: "(972) 555-0100" } });
  await visitorLead(account.siteKey);
  const [lead] = await leads(cookie);
  const created = (await (await app("POST", "/estimates", cookie, { leadId: lead.id })).json()).estimate;
  assert.equal(created.number, "EST-1001");
  assert.equal(created.customer.name, lead.name);
  assert.equal(created.taxRate, "8.25");
  const items = [{ desc: "Tear-off and haul away", qty: "28", price: "95.10" }, { desc: "Architectural shingles", qty: "28", price: "310" }, { desc: "", price: "" }];
  const up = (await (await app("PATCH", "/estimates/" + created.id, cookie, { items, markSent: true })).json()).estimate;
  assert.equal(up.items.length, 2, "empty rows are dropped");
  assert.equal(up.status, "sent");
  // 28*95.10 + 28*310 = 11342.80; tax 8.25% = 935.78; total 12278.58
  assert.equal(up.total, 12278.58);
  assert.equal((await leads(cookie))[0].status, "quoted");

  const ownerView = await est("GET", up.token, "", null, { cookie });
  assert.equal(ownerView.status, 200);
  assert.equal((await (await app("GET", "/estimates/" + up.id, cookie)).json()).estimate.viewedAt, null, "owner opening the link is not a view");

  const view = await (await est("GET", up.token)).json();
  assert.equal(view.business.address, "100 Main St, Plano TX");
  assert.equal(view.estimate.total, 12278.58);
  assert.equal(view.estimate.token, undefined);
  assert.equal(view.estimate.leadId, undefined);
  assert.equal((await (await app("GET", "/estimates/" + up.id, cookie)).json()).estimate.status, "viewed");

  assert.equal((await est("POST", up.token, "accept", { name: "D" })).status, 400);
  assert.equal((await est("POST", up.token, "accept", { name: "Dana Whitfield" }, { origin: "https://evil.example" })).status, 404);
  const ok = await est("POST", up.token, "accept", { name: "Dana Whitfield" });
  assert.equal(ok.status, 200);
  const l = (await leads(cookie))[0];
  assert.equal(l.status, "won");
  assert.equal(l.wonAmount, "12278.58");
  assert.equal((await est("POST", up.token, "accept", { name: "Dana Whitfield" })).status, 409);
  assert.equal((await app("PATCH", "/estimates/" + up.id, cookie, { items: [] })).status, 400, "accepted estimates are locked");
});

await test("estimate: decline, expiry, delete kills the link, and numbers count up", async () => {
  const { cookie } = await signup();
  const e1 = (await (await app("POST", "/estimates", cookie, {})).json()).estimate;
  const e2 = (await (await app("POST", "/estimates", cookie, {})).json()).estimate;
  assert.equal(e2.number, "EST-1002");
  assert.equal((await est("POST", e1.token, "decline", { reason: "Too expensive" })).status, 200);
  assert.equal((await est("POST", e1.token, "accept", { name: "Someone" })).status, 409);
  await app("PATCH", "/estimates/" + e2.id, cookie, { validUntil: "2020-01-01" });
  assert.equal((await est("POST", e2.token, "accept", { name: "Someone" })).status, 410);
  assert.equal((await app("DELETE", "/estimates/" + e2.id, cookie)).status, 200);
  assert.equal((await est("GET", e2.token)).status, 404);
  assert.equal((await est("GET", "not-a-real-token-at-all-123")).status, 404);
});

await test("deleting an account also removes its files, tasks and estimate links", async () => {
  const { account, cookie } = await signup();
  await visitorLead(account.siteKey, { photos: [{ name: "a.jpg", data: dataUrl(JPEG) }] });
  await app("POST", "/tasks", cookie, { title: "Call" });
  const e = (await (await app("POST", "/estimates", cookie, {})).json()).estimate;
  await app("DELETE", "/account", cookie, { password: "long enough password" });
  for (const name of ["ld-leads", "ld-tasks", "ld-files", "ld-estimates"]) {
    const left = [...(fx.stores().get(name) || new Map()).keys()].filter((k) => k.startsWith(account.id));
    assert.equal(left.length, 0, name + " still has data");
  }
  assert.equal((await est("GET", e.token)).status, 404);
});

await test("notifications: marking them seen is saved", async () => {
  const { cookie } = await signup();
  const r = await (await app("PATCH", "/account", cookie, { notifSeen: true })).json();
  assert.ok(r.account.notifSeenAt);
});

console.log(`\n${passed} passed${process.exitCode ? ", some FAILED" : ""}`);
