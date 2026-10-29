// Shared helpers for the Lead Desk functions.
import { getStore } from "@netlify/blobs";
import crypto from "node:crypto";

export const STATUSES = ["new", "contacted", "quoted", "booked", "won", "lost"];

export function leadStore() {
  return getStore({ name: "leaddesk-leads", consistency: "strong" });
}

function rateStore() {
  return getStore({ name: "leaddesk-rate", consistency: "strong" });
}

export function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...extra },
  });
}

export function clean(v, max = 300) {
  if (v === undefined || v === null) return "";
  return String(v).replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);
}

// Keeps line breaks (for the project message), strips other control characters.
export function cleanText(v, max = 1500) {
  if (v === undefined || v === null) return "";
  return String(v).replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, " ").trim().slice(0, max);
}

export function money(v) {
  return clean(v, 14).replace(/[^\d.]/g, "");
}

export function newId() {
  // Sorts by time: newest keys are largest.
  return Date.now().toString(36).padStart(9, "0") + "-" + crypto.randomBytes(5).toString("hex");
}

// ---- CORS for the public lead endpoint -------------------------------------
// ALLOWED_ORIGINS (optional, comma separated, e.g. "https://mysite.com,https://www.mysite.com").
// Not set = any website can post leads, which is what most people want while setting up.
export function corsHeaders(req) {
  const h = {
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  };
  const list = (process.env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim().replace(/\/$/, "")).filter(Boolean);
  const origin = req.headers.get("origin") || "";
  if (!list.length) {
    h["Access-Control-Allow-Origin"] = "*";
  } else {
    h["Vary"] = "Origin";
    if (origin && list.includes(origin)) h["Access-Control-Allow-Origin"] = origin;
  }
  return h;
}

// ---- tiny rate limiter (per visitor, per hour) -----------------------------
function visitorKey(req, scope) {
  const ip =
    req.headers.get("x-nf-client-connection-ip") ||
    (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() ||
    "unknown";
  const hash = crypto.createHash("sha256").update(ip).digest("hex").slice(0, 16);
  const bucket = Math.floor(Date.now() / 3600000);
  return { key: `${scope}-${bucket}-${hash}`, old: `${scope}-${bucket - 1}-${hash}` };
}

export async function rateCount(req, scope) {
  try {
    const { key } = visitorKey(req, scope);
    const cur = await rateStore().get(key, { type: "json" });
    return (cur && cur.n) || 0;
  } catch {
    return 0; // never block real visitors because the counter failed
  }
}

export async function rateAdd(req, scope) {
  try {
    const { key, old } = visitorKey(req, scope);
    const store = rateStore();
    const cur = await store.get(key, { type: "json" });
    await store.setJSON(key, { n: ((cur && cur.n) || 0) + 1 });
    store.delete(old).catch(() => {});
  } catch {}
}

// ---- admin session: password lives only in the ADMIN_PASSWORD env var ------
function secret() {
  const pw = process.env.ADMIN_PASSWORD || "";
  if (pw.length < 8) return null; // refuse to run with no / weak password
  return crypto.createHash("sha256").update("leaddesk-admin-session:" + pw).digest();
}

export function passwordOk(given) {
  const pw = process.env.ADMIN_PASSWORD || "";
  if (pw.length < 8) return false;
  const a = crypto.createHash("sha256").update(String(given || "")).digest();
  const b = crypto.createHash("sha256").update(pw).digest();
  return crypto.timingSafeEqual(a, b);
}

export function makeToken(hours = 12) {
  const key = secret();
  if (!key) return null;
  const exp = String(Date.now() + hours * 3600 * 1000);
  const sig = crypto.createHmac("sha256", key).update(exp).digest("hex");
  return exp + "." + sig;
}

export function tokenOk(req) {
  const key = secret();
  if (!key) return false;
  const h = req.headers.get("authorization") || "";
  const tok = h.startsWith("Bearer ") ? h.slice(7) : "";
  const [exp, sig] = tok.split(".");
  if (!exp || !sig || !/^\d+$/.test(exp) || Number(exp) < Date.now()) return false;
  const want = crypto.createHmac("sha256", key).update(exp).digest("hex");
  if (sig.length !== want.length) return false;
  return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want));
}

export function businessName() {
  return clean(process.env.BUSINESS_NAME, 60) || "Lead Desk";
}
