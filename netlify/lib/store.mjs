// Shared helpers for the Lead Desk functions: storage, accounts, sessions,
// rate limits, input cleaning. One hosted Lead Desk serves many contractors;
// every lead is stored under the id of the account it belongs to.
import { getStore } from "@netlify/blobs";
import crypto from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(crypto.scrypt);

export const STATUSES = ["new", "contacted", "quoted", "booked", "won", "lost"];

const accounts = () => getStore({ name: "ld-accounts", consistency: "strong" });
const leads = () => getStore({ name: "ld-leads", consistency: "strong" });
const rates = () => getStore({ name: "ld-rate", consistency: "strong" });
const system = () => getStore({ name: "ld-system", consistency: "strong" });
const tasks = () => getStore({ name: "ld-tasks", consistency: "strong" });
const estimates = () => getStore({ name: "ld-estimates", consistency: "strong" });
const files = () => getStore({ name: "ld-files", consistency: "strong" });

// ---- responses and input ----------------------------------------------------
export function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...extra },
  });
}

export async function readJson(req) {
  try {
    const b = await req.json();
    return b && typeof b === "object" && !Array.isArray(b) ? b : {};
  } catch {
    return {};
  }
}

export function clean(v, max = 300) {
  if (v === undefined || v === null) return "";
  return String(v).replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);
}

// Keeps line breaks, strips other control characters.
export function cleanText(v, max = 1500) {
  if (v === undefined || v === null) return "";
  return String(v).replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, " ").trim().slice(0, max);
}

export function money(v) {
  const s = clean(v, 14).replace(/[^\d.]/g, "");
  return s && !isNaN(Number(s)) ? s : "";
}

export const emailOk = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e);

export function newId() {
  // Sorts by time: newer ids are larger.
  return Date.now().toString(36).padStart(9, "0") + "-" + crypto.randomBytes(5).toString("hex");
}

function randomKey(prefix) {
  return prefix + crypto.randomBytes(12).toString("base64url");
}

const emailKey = (email) => "e/" + crypto.createHash("sha256").update(email.toLowerCase()).digest("hex");

// ---- the form a contractor puts on their site ---------------------------------
export const DEFAULT_FORM = {
  title: "Request a free estimate",
  intro: "Tell us about your project. We reply the same business day.",
  button: "Request my estimate",
  color: "#1C2430",
  services: [],
  phone: "",
  photos: true,
};

export const STORAGE_LIMIT = 250 * 1024 * 1024; // per account

// Business details printed on estimates.
export function cleanProfile(p = {}, base = {}) {
  const out = { phone: "", email: "", address: "", license: "", taxRate: "", terms: "", ...base };
  if (p.phone !== undefined) out.phone = clean(p.phone, 30);
  if (p.email !== undefined) out.email = clean(p.email, 160);
  if (p.address !== undefined) out.address = cleanText(p.address, 300);
  if (p.license !== undefined) out.license = clean(p.license, 80);
  if (p.taxRate !== undefined) { const t = clean(p.taxRate, 8).replace(/[^\d.]/g, ""); out.taxRate = t && Number(t) <= 30 ? t : ""; }
  if (p.terms !== undefined) out.terms = cleanText(p.terms, 2000);
  return out;
}

export function cleanForm(f = {}, base = DEFAULT_FORM) {
  const out = { ...base };
  if (f.title !== undefined) out.title = clean(f.title, 80);
  if (f.intro !== undefined) out.intro = clean(f.intro, 200);
  if (f.button !== undefined) out.button = clean(f.button, 40);
  if (f.color !== undefined && /^#[0-9a-fA-F]{6}$/.test(String(f.color))) out.color = String(f.color);
  if (f.phone !== undefined) out.phone = clean(f.phone, 30);
  if (f.photos !== undefined) out.photos = !!f.photos;
  if (f.services !== undefined) {
    const list = Array.isArray(f.services) ? f.services : String(f.services).split(/\n|\|/);
    out.services = list.map((s) => clean(s, 60)).filter(Boolean).slice(0, 20);
  }
  return out;
}

export function publicForm(acct) {
  return { business: acct.business, ...cleanForm(acct.form || {}) };
}

// ---- accounts ------------------------------------------------------------------
export async function getAccount(id) {
  if (!id || !/^[\w-]{6,40}$/.test(id)) return null;
  return accounts().get("a/" + id, { type: "json" });
}

export async function saveAccount(acct) {
  acct.updatedAt = new Date().toISOString();
  await accounts().setJSON("a/" + acct.id, acct);
  return acct;
}

export async function accountByEmail(email) {
  const ref = await accounts().get(emailKey(email), { type: "json" });
  return ref ? getAccount(ref.id) : null;
}

export async function accountBySiteKey(key) {
  if (!key || !/^ld_[\w-]{10,40}$/.test(key)) return null;
  const ref = await accounts().get("k/" + key, { type: "json" });
  return ref ? getAccount(ref.id) : null;
}

export async function createAccount({ email, password, business }) {
  const now = new Date().toISOString();
  const acct = {
    id: "acct_" + crypto.randomBytes(8).toString("hex"),
    email: email.toLowerCase(),
    business,
    passHash: await hashPassword(password),
    siteKey: randomKey("ld_"),
    sessionVer: 1,
    createdAt: now,
    form: { ...DEFAULT_FORM },
    webhook: "",
    allowedOrigins: [],
    firstLeadAt: null,
    formSeenAt: null,
  };
  // Claim the email first so two sign-ups with one address cannot both win.
  const store = accounts();
  const ek = emailKey(acct.email);
  if (await store.get(ek)) return null;
  await store.setJSON(ek, { id: acct.id });
  await store.setJSON("k/" + acct.siteKey, { id: acct.id });
  await saveAccount(acct);
  return acct;
}

export async function rotateSiteKey(acct) {
  const store = accounts();
  const old = acct.siteKey;
  acct.siteKey = randomKey("ld_");
  await store.setJSON("k/" + acct.siteKey, { id: acct.id });
  await saveAccount(acct);
  await store.delete("k/" + old);
  return acct;
}

export async function deleteAccount(acct) {
  for (const st of [leads(), tasks(), files()]) {
    const { blobs } = await st.list({ prefix: acct.id + "/" });
    await Promise.all(blobs.map((b) => st.delete(b.key)));
  }
  const es = estimates();
  const { blobs: ests } = await es.list({ prefix: acct.id + "/" });
  for (const b of ests) {
    const e = await es.get(b.key, { type: "json" });
    if (e && e.token) await es.delete("t/" + e.token);
    await es.delete(b.key);
  }
  const store = accounts();
  await store.delete("k/" + acct.siteKey);
  await store.delete(emailKey(acct.email));
  await store.delete("a/" + acct.id);
}

// Safe to send to the account owner's browser.
export function accountView(acct) {
  return {
    id: acct.id, email: acct.email, business: acct.business, siteKey: acct.siteKey,
    createdAt: acct.createdAt, form: cleanForm(acct.form || {}), webhook: acct.webhook || "",
    allowedOrigins: acct.allowedOrigins || [], firstLeadAt: acct.firstLeadAt || null,
    formSeenAt: acct.formSeenAt || null, notifSeenAt: acct.notifSeenAt || null,
    profile: cleanProfile(acct.profile || {}), storageBytes: acct.storageBytes || 0,
    storageLimit: STORAGE_LIMIT,
  };
}

// ---- passwords -----------------------------------------------------------------
export async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(String(pw).normalize("NFKC"), salt, 32, { N: 16384, r: 8, p: 1 });
  return "s1$" + salt.toString("hex") + "$" + hash.toString("hex");
}

export async function checkPassword(pw, stored) {
  const [v, saltHex, hashHex] = String(stored || "").split("$");
  if (v !== "s1" || !saltHex || !hashHex) return false;
  const hash = await scrypt(String(pw || "").normalize("NFKC"), Buffer.from(saltHex, "hex"), 32, { N: 16384, r: 8, p: 1 });
  const want = Buffer.from(hashHex, "hex");
  return want.length === hash.length && crypto.timingSafeEqual(hash, want);
}

// Used when the email is unknown, so a wrong email takes as long as a wrong password.
const DUMMY_HASH = "s1$" + "00".repeat(16) + "$" + "00".repeat(32);
export const burnTime = (pw) => checkPassword(pw, DUMMY_HASH);

// ---- sessions (signed, httpOnly cookie) ----------------------------------------
// SESSION_SECRET can be set in Netlify. If it is not, a random one is made on
// first use and kept in storage, so a fresh deploy works without setup.
let cachedSecret = null;
async function sessionSecret() {
  if (process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32) return process.env.SESSION_SECRET;
  if (cachedSecret) return cachedSecret;
  const store = system();
  let rec = await store.get("session-secret", { type: "json" });
  if (!rec || !rec.s) {
    await store.setJSON("session-secret", { s: crypto.randomBytes(32).toString("hex") });
    // Read back, so two first requests at the same moment agree on one value.
    rec = await store.get("session-secret", { type: "json" });
  }
  cachedSecret = rec.s;
  return cachedSecret;
}

const COOKIE = "ld_session";
const SESSION_DAYS = 30;

function sign(secret, payload) {
  return crypto.createHmac("sha256", secret).update(payload).digest("base64url");
}

export async function sessionCookie(req, acct) {
  const exp = Date.now() + SESSION_DAYS * 86400000;
  const payload = `${acct.id}.${exp}.${acct.sessionVer || 1}`;
  const value = payload + "." + sign(await sessionSecret(), payload);
  const secure = new URL(req.url).protocol === "https:" ? "; Secure" : "";
  return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure}`;
}

export function clearCookie(req) {
  const secure = new URL(req.url).protocol === "https:" ? "; Secure" : "";
  return `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
}

export async function sessionAccount(req) {
  const raw = (req.headers.get("cookie") || "").split(/;\s*/).find((c) => c.startsWith(COOKIE + "="));
  if (!raw) return null;
  const parts = raw.slice(COOKIE.length + 1).split(".");
  if (parts.length !== 4) return null;
  const [id, exp, ver, sig] = parts;
  if (!/^\d+$/.test(exp) || Number(exp) < Date.now()) return null;
  const want = sign(await sessionSecret(), `${id}.${exp}.${ver}`);
  if (sig.length !== want.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want))) return null;
  const acct = await getAccount(id);
  if (!acct || String(acct.sessionVer || 1) !== ver) return null;
  return acct;
}

// State-changing calls from the dashboard must come from our own pages.
// The browser always sends Origin on cross-site POST/PATCH/DELETE.
export function sameOrigin(req) {
  const origin = req.headers.get("origin");
  if (!origin) return true;
  try {
    return new URL(origin).host === new URL(req.url).host;
  } catch {
    return false;
  }
}

// ---- leads ------------------------------------------------------------------------
export async function listLeads(acctId) {
  const store = leads();
  const { blobs } = await store.list({ prefix: acctId + "/" });
  const all = (await Promise.all(blobs.map((b) => store.get(b.key, { type: "json" })))).filter(Boolean);
  all.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return all;
}

export const getLead = (acctId, id) =>
  /^[\w-]{6,40}$/.test(id || "") ? leads().get(acctId + "/" + id, { type: "json" }) : null;
export const saveLead = (acctId, rec) => leads().setJSON(acctId + "/" + rec.id, rec);
export const deleteLead = (acctId, id) => leads().delete(acctId + "/" + id);

// ---- tasks and estimates (one JSON record each, under the account id) -----------
function scoped(store) {
  return {
    async list(acctId) {
      const st = store();
      const { blobs } = await st.list({ prefix: acctId + "/" });
      return (await Promise.all(blobs.map((b) => st.get(b.key, { type: "json" })))).filter(Boolean);
    },
    get: (acctId, id) => (/^[\w-]{6,40}$/.test(id || "") ? store().get(acctId + "/" + id, { type: "json" }) : null),
    put: (acctId, rec) => store().setJSON(acctId + "/" + rec.id, rec),
    del: (acctId, id) => store().delete(acctId + "/" + id),
  };
}
export const Tasks = scoped(tasks);
export const Estimates = scoped(estimates);

export async function estimateToken(acctId, est) {
  est.token = crypto.randomBytes(18).toString("base64url");
  await estimates().setJSON("t/" + est.token, { acct: acctId, id: est.id });
}
export async function estimateByToken(token) {
  if (!/^[\w-]{20,40}$/.test(token || "")) return null;
  const ref = await estimates().get("t/" + token, { type: "json" });
  if (!ref) return null;
  const est = await Estimates.get(ref.acct, ref.id);
  return est ? { acctId: ref.acct, est } : null;
}
export const dropEstimateToken = (token) => estimates().delete("t/" + token);

// ---- files (binary, attached to a lead) -------------------------------------------
const INLINE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif", "application/pdf"];

// Trust the bytes, not the name: only these kinds are kept as images.
export function sniffImage(buf) {
  const b = new Uint8Array(buf.slice(0, 12));
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "image/webp";
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return "image/gif";
  return null;
}
export function sniffType(buf, claimed) {
  const img = sniffImage(buf);
  if (img) return img;
  const b = new Uint8Array(buf.slice(0, 5));
  if (b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) return "application/pdf";
  return /^[\w.+-]+\/[\w.+-]+$/.test(claimed || "") && !/html|xml|javascript|svg/i.test(claimed) ? claimed : "application/octet-stream";
}

export async function saveFile(acct, leadId, { buf, name, type, by }) {
  const id = newId();
  await files().set(`${acct.id}/${leadId}/${id}`, buf);
  const meta = { id, name: clean(name, 120) || "file", type, size: buf.byteLength, at: new Date().toISOString(), by };
  acct.storageBytes = (acct.storageBytes || 0) + buf.byteLength;
  return meta;
}
export async function readFile(acctId, leadId, fileId) {
  if (!/^[\w-]{6,40}$/.test(leadId || "") || !/^[\w-]{6,40}$/.test(fileId || "")) return null;
  return files().get(`${acctId}/${leadId}/${fileId}`, { type: "arrayBuffer" });
}
export const removeFile = (acctId, leadId, fileId) => files().delete(`${acctId}/${leadId}/${fileId}`);
export const inlineOk = (type) => INLINE_TYPES.includes(type);

// ---- tiny rate limiter (per visitor, per hour) ----------------------------------
export function clientIp(req) {
  return (
    req.headers.get("x-nf-client-connection-ip") ||
    (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() ||
    "unknown"
  );
}

function rateKeys(scope, who) {
  const hash = crypto.createHash("sha256").update(String(who)).digest("hex").slice(0, 16);
  const bucket = Math.floor(Date.now() / 3600000);
  return { key: `${scope}-${bucket}-${hash}`, old: `${scope}-${bucket - 1}-${hash}` };
}

export async function rateCount(scope, who) {
  try {
    const cur = await rates().get(rateKeys(scope, who).key, { type: "json" });
    return (cur && cur.n) || 0;
  } catch {
    return 0; // never block real people because the counter failed
  }
}

export async function rateAdd(scope, who) {
  try {
    const { key, old } = rateKeys(scope, who);
    const store = rates();
    const cur = await store.get(key, { type: "json" });
    await store.setJSON(key, { n: ((cur && cur.n) || 0) + 1 });
    store.delete(old).catch(() => {});
  } catch {}
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
