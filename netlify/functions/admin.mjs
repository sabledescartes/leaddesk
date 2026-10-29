// /api/admin/*  - password-protected lead panel API.
import {
  leadStore, json, clean, cleanText, money, newId, passwordOk, makeToken, tokenOk,
  rateCount, rateAdd, businessName, STATUSES,
} from "../lib/store.mjs";

export const config = { path: "/api/admin/*" };

const MAX_FAILED_LOGINS_PER_HOUR = 10;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export default async (req) => {
  const url = new URL(req.url);
  const parts = url.pathname.replace(/^\/api\/admin\/?/, "").split("/").filter(Boolean);
  const [resource, id] = parts;

  // Public: the business name for the sign-in screen, and whether a password is set yet.
  if (resource === "config" && req.method === "GET") {
    return json({ business: businessName(), ready: (process.env.ADMIN_PASSWORD || "").length >= 8 });
  }

  if (resource === "login" && req.method === "POST") {
    let body = {};
    try { body = await req.json(); } catch {}
    if (!process.env.ADMIN_PASSWORD || process.env.ADMIN_PASSWORD.length < 8) {
      return json({ error: "ADMIN_PASSWORD is not set in Netlify (it needs 8 or more characters)." }, 503);
    }
    if ((await rateCount(req, "login")) >= MAX_FAILED_LOGINS_PER_HOUR) {
      return json({ error: "Too many wrong passwords. Try again in an hour." }, 429);
    }
    if (!passwordOk(body.password)) {
      await rateAdd(req, "login");
      await sleep(900);
      return json({ error: "Wrong password." }, 401);
    }
    return json({ ok: true, token: makeToken() });
  }

  if (!tokenOk(req)) return json({ error: "unauthorized" }, 401);
  const store = leadStore();

  if (resource === "leads" && !id && req.method === "GET") {
    const { blobs } = await store.list();
    const leads = (await Promise.all(blobs.map((b) => store.get(b.key, { type: "json" })))).filter(Boolean);
    leads.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    return json({ leads });
  }

  if (resource === "leads" && !id && req.method === "POST") {
    let b = {};
    try { b = await req.json(); } catch {}
    if (!clean(b.name)) return json({ error: "Name is required." }, 400);
    const now = new Date().toISOString();
    const rec = {
      id: newId(), createdAt: now, updatedAt: now, status: "new",
      source: clean(b.source, 60) || "Added by hand",
      name: clean(b.name, 120), phone: clean(b.phone, 40), email: clean(b.email, 160),
      city: clean(b.city, 80), service: clean(b.service, 80), message: "", page: "",
      estValue: money(b.estValue), wonAmount: "",
      notes: [], activity: [{ at: now, text: "Lead added by hand" }],
    };
    const note = cleanText(b.note, 2000);
    if (note) rec.notes.push({ at: now, text: note });
    await store.setJSON(rec.id, rec);
    return json({ ok: true, lead: rec });
  }

  if (resource === "leads" && id && req.method === "PATCH") {
    const rec = await store.get(id, { type: "json" });
    if (!rec) return json({ error: "not found" }, 404);
    let b = {};
    try { b = await req.json(); } catch {}
    const now = new Date().toISOString();
    if (b.status && STATUSES.includes(b.status) && b.status !== rec.status) {
      rec.activity.push({ at: now, text: "Status: " + rec.status + " -> " + b.status });
      rec.status = b.status;
    }
    if (b.estValue !== undefined) rec.estValue = money(b.estValue);
    if (b.wonAmount !== undefined) rec.wonAmount = money(b.wonAmount);
    if (b.archived !== undefined) {
      rec.archived = !!b.archived;
      rec.activity.push({ at: now, text: rec.archived ? "Archived" : "Restored" });
    }
    const note = cleanText(b.note, 2000);
    if (note) rec.notes.push({ at: now, text: note });
    rec.updatedAt = now;
    await store.setJSON(id, rec);
    return json({ ok: true, lead: rec });
  }

  // Permanent delete (for "please remove my data" requests). Only archived leads.
  if (resource === "leads" && id && req.method === "DELETE") {
    const rec = await store.get(id, { type: "json" });
    if (!rec) return json({ error: "not found" }, 404);
    if (!rec.archived) return json({ error: "Archive the lead first." }, 400);
    await store.delete(id);
    return json({ ok: true });
  }

  return json({ error: "not found" }, 404);
};
