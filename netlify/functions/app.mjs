// /api/app/*  - everything the signed-in contractor's dashboard does.
// Every call is scoped to the account in the session cookie.
import {
  json, readJson, clean, cleanText, money, newId, STATUSES, sessionAccount, sameOrigin,
  accountView, saveAccount, cleanForm, cleanProfile, rotateSiteKey, deleteAccount, checkPassword, hashPassword,
  sessionCookie, clearCookie, listLeads, getLead, saveLead, deleteLead,
  Tasks, Estimates, estimateToken, dropEstimateToken,
  saveFile, readFile, removeFile, sniffType, inlineOk, STORAGE_LIMIT,
  rateCount, rateAdd, sleep,
} from "../lib/store.mjs";
import { totals, cleanItems } from "../lib/estimate.mjs";

export const config = { path: "/api/app/*" };

const MAX_UPLOAD = 4 * 1024 * 1024; // Netlify functions take up to 6 MB per request
const MAX_FILES_PER_LEAD = 30;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function cleanOrigins(list) {
  const arr = Array.isArray(list) ? list : String(list || "").split(/[\s,]+/);
  const out = [];
  for (const raw of arr) {
    const s = clean(raw, 200);
    if (!s) continue;
    try {
      const u = new URL(/^https?:\/\//i.test(s) ? s : "https://" + s);
      if (!/\.[a-z]{2,}$/i.test(u.hostname) && u.hostname !== "localhost") throw new Error("host");
      if (!out.includes(u.origin)) out.push(u.origin);
    } catch {
      return { error: `"${s}" is not a website address.` };
    }
  }
  return { list: out.slice(0, 10) };
}

function cleanDue(v) {
  const s = clean(v, 10);
  return DATE.test(s) && !isNaN(new Date(s + "T12:00:00Z")) ? s : "";
}

export default async (req) => {
  const acct = await sessionAccount(req);
  if (!acct) return json({ error: "Not signed in." }, 401);
  if (req.method !== "GET" && !sameOrigin(req)) return json({ error: "Forbidden." }, 403);

  const [resource, id, sub] = new URL(req.url).pathname.replace(/^\/api\/app\/?/, "").split("/").filter(Boolean);
  const m = req.method;
  const now = new Date().toISOString();

  // ---------------------------------------------------------------- leads
  if (resource === "leads" && !id && m === "GET") {
    return json({ leads: await listLeads(acct.id) });
  }

  if (resource === "leads" && !id && m === "POST") {
    const b = await readJson(req);
    if (!clean(b.name)) return json({ error: "Name is required.", field: "name" }, 400);
    const rec = {
      id: newId(), createdAt: now, updatedAt: now, status: "new",
      source: clean(b.source, 60) || "Added by hand",
      name: clean(b.name, 120), phone: clean(b.phone, 40), email: clean(b.email, 160),
      city: clean(b.city, 80), service: clean(b.service, 80), message: cleanText(b.message, 1500), page: "",
      estValue: money(b.estValue), wonAmount: "", notes: [], files: [],
      activity: [{ at: now, text: "Added by hand" }],
    };
    await saveLead(acct.id, rec);
    return json({ ok: true, lead: rec });
  }

  if (resource === "leads" && id && m === "PATCH") {
    const rec = await getLead(acct.id, id);
    if (!rec) return json({ error: "Lead not found." }, 404);
    const b = await readJson(req);
    if (b.status && STATUSES.includes(b.status) && b.status !== rec.status) {
      rec.activity.push({ at: now, text: `Moved from ${rec.status} to ${b.status}` });
      rec.status = b.status;
    }
    if (b.estValue !== undefined) rec.estValue = money(b.estValue);
    if (b.wonAmount !== undefined) rec.wonAmount = money(b.wonAmount);
    if (b.archived !== undefined && !!b.archived !== !!rec.archived) {
      rec.archived = !!b.archived;
      rec.activity.push({ at: now, text: rec.archived ? "Archived" : "Restored" });
    }
    const note = cleanText(b.note, 2000);
    if (note) rec.notes.push({ at: now, text: note });
    rec.updatedAt = now;
    await saveLead(acct.id, rec);
    return json({ ok: true, lead: rec });
  }

  // Permanent delete, for "please remove my data" requests. Archived leads only.
  if (resource === "leads" && id && m === "DELETE") {
    const rec = await getLead(acct.id, id);
    if (!rec) return json({ error: "Lead not found." }, 404);
    if (!rec.archived) return json({ error: "Archive the lead before deleting it." }, 400);
    for (const f of rec.files || []) {
      await removeFile(acct.id, id, f.id);
      acct.storageBytes = Math.max(0, (acct.storageBytes || 0) - (f.size || 0));
    }
    for (const t of await Tasks.list(acct.id)) if (t.leadId === id) await Tasks.del(acct.id, t.id);
    await deleteLead(acct.id, id);
    await saveAccount(acct);
    return json({ ok: true });
  }

  // ---------------------------------------------------------------- files
  if (resource === "files" && id && !sub && m === "POST") {
    const lead = await getLead(acct.id, id);
    if (!lead) return json({ error: "Lead not found." }, 404);
    lead.files = lead.files || [];
    if (lead.files.length >= MAX_FILES_PER_LEAD) return json({ error: `A lead can have up to ${MAX_FILES_PER_LEAD} files.` }, 400);
    const len = Number(req.headers.get("content-length") || 0);
    if (len > MAX_UPLOAD) return json({ error: "Files can be up to 4 MB." }, 413);
    const buf = await req.arrayBuffer();
    if (!buf.byteLength) return json({ error: "The file is empty." }, 400);
    if (buf.byteLength > MAX_UPLOAD) return json({ error: "Files can be up to 4 MB." }, 413);
    if ((acct.storageBytes || 0) + buf.byteLength > STORAGE_LIMIT) return json({ error: "Your storage is full. Delete some files first." }, 413);
    let name = "file";
    try { name = decodeURIComponent(req.headers.get("x-file-name") || "file"); } catch {}
    const type = sniffType(buf, req.headers.get("content-type"));
    const meta = await saveFile(acct, id, { buf, name, type, by: "you" });
    lead.files.push(meta);
    lead.activity.push({ at: now, text: "Added file " + meta.name });
    lead.updatedAt = now;
    await saveLead(acct.id, lead);
    await saveAccount(acct);
    return json({ ok: true, file: meta, lead });
  }

  if (resource === "files" && id && sub && (m === "GET" || m === "DELETE")) {
    const lead = await getLead(acct.id, id);
    const meta = lead && (lead.files || []).find((f) => f.id === sub);
    if (!meta) return json({ error: "File not found." }, 404);
    if (m === "DELETE") {
      await removeFile(acct.id, id, sub);
      lead.files = lead.files.filter((f) => f.id !== sub);
      lead.activity.push({ at: now, text: "Deleted file " + meta.name });
      await saveLead(acct.id, lead);
      acct.storageBytes = Math.max(0, (acct.storageBytes || 0) - (meta.size || 0));
      await saveAccount(acct);
      return json({ ok: true, lead });
    }
    const buf = await readFile(acct.id, id, sub);
    if (!buf) return json({ error: "File not found." }, 404);
    const inline = inlineOk(meta.type);
    const download = new URL(req.url).searchParams.has("download");
    return new Response(buf, {
      headers: {
        "Content-Type": inline ? meta.type : "application/octet-stream",
        "Content-Disposition": `${inline && !download ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(meta.name)}`,
        "Content-Security-Policy": "sandbox; default-src 'none'; img-src 'self'; style-src 'unsafe-inline'",
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, max-age=3600",
      },
    });
  }

  // ---------------------------------------------------------------- tasks
  if (resource === "tasks" && !id && m === "GET") {
    const list = await Tasks.list(acct.id);
    list.sort((a, b) => (a.due || "9") < (b.due || "9") ? -1 : (a.due || "9") > (b.due || "9") ? 1 : a.createdAt < b.createdAt ? -1 : 1);
    return json({ tasks: list });
  }

  if (resource === "tasks" && !id && m === "POST") {
    const b = await readJson(req);
    const title = clean(b.title, 160);
    if (!title) return json({ error: "Write what needs to be done.", field: "title" }, 400);
    let lead = null;
    if (b.leadId) {
      lead = await getLead(acct.id, clean(b.leadId, 40));
      if (!lead) return json({ error: "Lead not found." }, 404);
    }
    if ((await Tasks.list(acct.id)).filter((t) => !t.done).length >= 500) return json({ error: "You have 500 open tasks. Finish some first." }, 400);
    const task = { id: newId(), title, due: cleanDue(b.due), time: /^\d{2}:\d{2}$/.test(b.time || "") ? b.time : "", leadId: lead ? lead.id : "", leadName: lead ? lead.name : "", done: false, createdAt: now, doneAt: null };
    await Tasks.put(acct.id, task);
    if (lead) {
      lead.activity.push({ at: now, text: "Follow-up added: " + title + (task.due ? " (" + task.due + ")" : "") });
      await saveLead(acct.id, lead);
    }
    return json({ ok: true, task });
  }

  if (resource === "tasks" && id && m === "PATCH") {
    const task = await Tasks.get(acct.id, id);
    if (!task) return json({ error: "Task not found." }, 404);
    const b = await readJson(req);
    if (b.title !== undefined) { const t = clean(b.title, 160); if (!t) return json({ error: "Write what needs to be done.", field: "title" }, 400); task.title = t; }
    if (b.due !== undefined) task.due = cleanDue(b.due);
    if (b.time !== undefined) task.time = /^\d{2}:\d{2}$/.test(b.time || "") ? b.time : "";
    if (b.done !== undefined && !!b.done !== task.done) {
      task.done = !!b.done; task.doneAt = task.done ? now : null;
      if (task.done && task.leadId) {
        const lead = await getLead(acct.id, task.leadId);
        if (lead) { lead.activity.push({ at: now, text: "Done: " + task.title }); await saveLead(acct.id, lead); }
      }
    }
    await Tasks.put(acct.id, task);
    return json({ ok: true, task });
  }

  if (resource === "tasks" && id && m === "DELETE") {
    if (!(await Tasks.get(acct.id, id))) return json({ error: "Task not found." }, 404);
    await Tasks.del(acct.id, id);
    return json({ ok: true });
  }

  // ---------------------------------------------------------------- estimates
  if (resource === "estimates" && !id && m === "GET") {
    const list = await Estimates.list(acct.id);
    list.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    return json({ estimates: list });
  }

  if (resource === "estimates" && !id && m === "POST") {
    const b = await readJson(req);
    let lead = null;
    if (b.leadId) {
      lead = await getLead(acct.id, clean(b.leadId, 40));
      if (!lead) return json({ error: "Lead not found." }, 404);
    }
    if ((await Estimates.list(acct.id)).length >= 2000) return json({ error: "You have reached 2,000 estimates." }, 400);
    const profile = cleanProfile(acct.profile || {});
    acct.estSeq = (acct.estSeq || 1000) + 1;
    const valid = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
    const est = {
      id: newId(), number: "EST-" + acct.estSeq, status: "draft", createdAt: now, updatedAt: now,
      leadId: lead ? lead.id : "",
      customer: { name: lead ? lead.name : "", email: lead ? lead.email : "", phone: lead ? lead.phone : "", address: lead ? lead.city : "" },
      title: lead && lead.service ? lead.service : "",
      items: lead && lead.service ? [{ desc: lead.service, qty: "1", price: lead.estValue || "" }] : [{ desc: "", qty: "1", price: "" }],
      taxRate: profile.taxRate || "", notes: profile.terms || "", validUntil: valid,
      sentAt: null, viewedAt: null, acceptedAt: null, acceptedName: "", declinedAt: null, declineReason: "",
    };
    est.total = totals(est).total;
    await estimateToken(acct.id, est);
    await Estimates.put(acct.id, est);
    await saveAccount(acct);
    if (lead) { lead.activity.push({ at: now, text: "Estimate " + est.number + " started" }); await saveLead(acct.id, lead); }
    return json({ ok: true, estimate: est });
  }

  if (resource === "estimates" && id && m === "GET") {
    const est = await Estimates.get(acct.id, id);
    return est ? json({ estimate: est }) : json({ error: "Estimate not found." }, 404);
  }

  if (resource === "estimates" && id && m === "PATCH") {
    const est = await Estimates.get(acct.id, id);
    if (!est) return json({ error: "Estimate not found." }, 404);
    const b = await readJson(req);
    const locked = est.status === "accepted";
    if (!locked) {
      if (b.title !== undefined) est.title = clean(b.title, 120);
      if (b.customer && typeof b.customer === "object") {
        est.customer = { name: clean(b.customer.name, 120), email: clean(b.customer.email, 160), phone: clean(b.customer.phone, 40), address: cleanText(b.customer.address, 300) };
      }
      if (b.items !== undefined) est.items = cleanItems(b.items);
      if (b.taxRate !== undefined) { const t = clean(b.taxRate, 8).replace(/[^\d.]/g, ""); est.taxRate = t && Number(t) <= 30 ? t : ""; }
      if (b.notes !== undefined) est.notes = cleanText(b.notes, 2000);
      if (b.validUntil !== undefined) est.validUntil = cleanDue(b.validUntil);
    } else if (b.items || b.customer || b.taxRate !== undefined) {
      return json({ error: "This estimate was accepted and can no longer be changed. Make a new one." }, 400);
    }
    if (b.markSent && !est.sentAt) {
      est.sentAt = now;
      if (est.status === "draft") est.status = "sent";
      if (est.leadId) {
        const lead = await getLead(acct.id, est.leadId);
        if (lead) {
          lead.activity.push({ at: now, text: "Estimate " + est.number + " sent" });
          if (lead.status === "new" || lead.status === "contacted") { lead.activity.push({ at: now, text: `Moved from ${lead.status} to quoted` }); lead.status = "quoted"; }
          lead.estValue = String(totals(est).total || lead.estValue || "");
          await saveLead(acct.id, lead);
        }
      }
    }
    if (b.reopen && est.status === "declined") { est.status = est.sentAt ? "sent" : "draft"; est.declinedAt = null; est.declineReason = ""; }
    est.total = totals(est).total;
    est.updatedAt = now;
    await Estimates.put(acct.id, est);
    return json({ ok: true, estimate: est });
  }

  if (resource === "estimates" && id && m === "DELETE") {
    const est = await Estimates.get(acct.id, id);
    if (!est) return json({ error: "Estimate not found." }, 404);
    if (est.token) await dropEstimateToken(est.token);
    await Estimates.del(acct.id, id);
    return json({ ok: true });
  }

  // ---------------------------------------------------------------- account settings
  if (resource === "account" && m === "PATCH") {
    const b = await readJson(req);
    if (b.business !== undefined) {
      const name = clean(b.business, 80);
      if (!name) return json({ error: "Enter your business name.", field: "business" }, 400);
      acct.business = name;
    }
    if (b.form !== undefined) acct.form = cleanForm(b.form, cleanForm(acct.form || {}));
    if (b.profile !== undefined) acct.profile = cleanProfile(b.profile, cleanProfile(acct.profile || {}));
    if (b.webhook !== undefined) {
      const w = clean(b.webhook, 500);
      if (w && !/^https:\/\/[^\s]+$/i.test(w)) return json({ error: "The alert address must start with https://", field: "webhook" }, 400);
      acct.webhook = w;
    }
    if (b.allowedOrigins !== undefined) {
      const r = cleanOrigins(b.allowedOrigins);
      if (r.error) return json({ error: r.error, field: "allowedOrigins" }, 400);
      acct.allowedOrigins = r.list;
    }
    if (b.formSeen && !acct.formSeenAt) acct.formSeenAt = now;
    if (b.notifSeen) acct.notifSeenAt = now;
    await saveAccount(acct);
    return json({ ok: true, account: accountView(acct) });
  }

  if (resource === "rotate-key" && m === "POST") {
    await rotateSiteKey(acct);
    return json({ ok: true, account: accountView(acct) });
  }

  if (resource === "password" && m === "POST") {
    const b = await readJson(req);
    if ((await rateCount("pw", acct.id)) >= 10) return json({ error: "Too many attempts. Try again in an hour." }, 429);
    if (!(await checkPassword(b.current, acct.passHash))) {
      await rateAdd("pw", acct.id);
      await sleep(400);
      return json({ error: "Your current password is not right.", field: "current" }, 400);
    }
    const next = String(b.next || "");
    if (next.length < 10 || next.length > 200) return json({ error: "Use at least 10 characters.", field: "next" }, 400);
    acct.passHash = await hashPassword(next);
    acct.sessionVer = (acct.sessionVer || 1) + 1; // signs out every other device
    await saveAccount(acct);
    return json({ ok: true }, 200, { "Set-Cookie": await sessionCookie(req, acct) });
  }

  if (resource === "account" && m === "DELETE") {
    const b = await readJson(req);
    if (!(await checkPassword(b.password, acct.passHash))) {
      await sleep(400);
      return json({ error: "Your password is not right.", field: "password" }, 400);
    }
    await deleteAccount(acct);
    return json({ ok: true }, 200, { "Set-Cookie": clearCookie(req) });
  }

  return json({ error: "Not found." }, 404);
};
