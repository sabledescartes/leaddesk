// Public estimate page API, used by the customer through their private link.
//   GET  /api/estimate/<token>          the estimate and the business details
//   POST /api/estimate/<token>/accept   { name }   customer accepts by typing their name
//   POST /api/estimate/<token>/decline  { reason }
import crypto from "node:crypto";
import {
  json, readJson, clean, cleanText, estimateByToken, Estimates, getAccount, getLead, saveLead,
  cleanProfile, sessionAccount, sameOrigin, clientIp, rateCount, rateAdd,
} from "../lib/store.mjs";
import { totals } from "../lib/estimate.mjs";

export const config = { path: "/api/estimate/*" };

function publicView(acct, est) {
  const p = cleanProfile(acct.profile || {});
  return {
    business: { name: acct.business, phone: p.phone || (acct.form && acct.form.phone) || "", email: p.email, address: p.address, license: p.license },
    estimate: {
      number: est.number, title: est.title, status: est.status, createdAt: est.createdAt, validUntil: est.validUntil,
      customer: est.customer, items: est.items, taxRate: est.taxRate, notes: est.notes,
      acceptedAt: est.acceptedAt, acceptedName: est.acceptedName, declinedAt: est.declinedAt,
      ...totals(est),
    },
  };
}

const expired = (est) => est.validUntil && new Date(est.validUntil + "T23:59:59") < new Date();

async function alert(acct, text) {
  if (!acct.webhook || !/^https:\/\//i.test(acct.webhook)) return;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 4000);
  try {
    await fetch(acct.webhook, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text, content: text }), signal: ctl.signal });
  } catch {} finally { clearTimeout(timer); }
}

export default async (req) => {
  const [token, action] = new URL(req.url).pathname.replace(/^\/api\/estimate\/?/, "").split("/");
  const ip = clientIp(req);
  if ((await rateCount("est-ip", ip)) >= 200) return json({ error: "Too many requests. Try again later." }, 429);
  await rateAdd("est-ip", ip);

  const found = await estimateByToken(token);
  if (!found) return json({ error: "This estimate link is not valid any more." }, 404);
  const { acctId, est } = found;
  const acct = await getAccount(acctId);
  if (!acct) return json({ error: "This estimate link is not valid any more." }, 404);
  const now = new Date().toISOString();

  if (req.method === "GET" && !action) {
    // The owner checking their own link does not count as the customer seeing it.
    const viewer = await sessionAccount(req);
    if (!est.viewedAt && (!viewer || viewer.id !== acct.id)) {
      est.viewedAt = now;
      if (est.status === "sent" || est.status === "draft") est.status = "viewed";
      await Estimates.put(acctId, est);
      if (est.leadId) {
        const lead = await getLead(acctId, est.leadId);
        if (lead) { lead.activity.push({ at: now, text: "Customer opened estimate " + est.number }); await saveLead(acctId, lead); }
      }
    }
    return json(publicView(acct, est));
  }

  if (req.method !== "POST" || !sameOrigin(req)) return json({ error: "Not found." }, 404);
  if (est.status === "accepted") return json({ error: "This estimate was already accepted." }, 409);
  if (est.status === "declined") return json({ error: "This estimate was declined. Ask " + acct.business + " for a new one." }, 409);
  if (expired(est)) return json({ error: "This estimate has expired. Ask " + acct.business + " for a new one." }, 410);
  const b = await readJson(req);

  if (action === "accept") {
    const name = clean(b.name, 120);
    if (name.length < 2) return json({ error: "Type your full name to accept.", field: "name" }, 400);
    const t = totals(est);
    est.status = "accepted"; est.acceptedAt = now; est.acceptedName = name;
    est.acceptedFrom = crypto.createHash("sha256").update(ip).digest("hex").slice(0, 16);
    est.total = t.total;
    await Estimates.put(acctId, est);
    if (est.leadId) {
      const lead = await getLead(acctId, est.leadId);
      if (lead) {
        lead.activity.push({ at: now, text: `${name} accepted estimate ${est.number}` });
        if (lead.status !== "won") { lead.activity.push({ at: now, text: `Moved from ${lead.status} to won` }); lead.status = "won"; }
        lead.wonAmount = String(t.total);
        lead.updatedAt = now;
        await saveLead(acctId, lead);
      }
    }
    await alert(acct, `Estimate ${est.number} accepted by ${name}: $${t.total.toLocaleString("en-US")}`);
    return json({ ok: true, ...publicView(acct, est) });
  }

  if (action === "decline") {
    est.status = "declined"; est.declinedAt = now; est.declineReason = cleanText(b.reason, 500);
    await Estimates.put(acctId, est);
    if (est.leadId) {
      const lead = await getLead(acctId, est.leadId);
      if (lead) { lead.activity.push({ at: now, text: "Customer declined estimate " + est.number + (est.declineReason ? ": " + est.declineReason : "") }); await saveLead(acctId, lead); }
    }
    await alert(acct, `Estimate ${est.number} was declined` + (est.declineReason ? `: ${est.declineReason}` : ""));
    return json({ ok: true, ...publicView(acct, est) });
  }

  return json({ error: "Not found." }, 404);
};
