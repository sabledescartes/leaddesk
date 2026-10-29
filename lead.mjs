// POST /api/lead - the website form saves each request here.
import { leadStore, json, clean, cleanText, newId, corsHeaders, rateCount, rateAdd, businessName } from "../lib/store.mjs";

export const config = { path: "/api/lead" };

const MAX_PER_HOUR = 8; // per visitor
const MIN_FILL_MS = 1500; // a human needs more than this to fill in a form

async function notify(rec) {
  const url = process.env.NOTIFY_WEBHOOK_URL;
  if (!url || !/^https:\/\//i.test(url)) return;
  const line =
    `New lead for ${businessName()}: ${rec.name}, ${rec.phone}` +
    (rec.service ? `, ${rec.service}` : "") +
    (rec.city ? ` (${rec.city})` : "");
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 4000);
  try {
    // "text" is read by Slack, "content" by Discord. Zapier / Make read either.
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: line, content: line, lead: rec }),
      signal: ctl.signal,
    });
  } catch {
    // an alert that fails must never lose the lead
  } finally {
    clearTimeout(timer);
  }
}

export default async (req) => {
  const cors = corsHeaders(req);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST") return json({ error: "method" }, 405, cors);

  let body;
  try { body = await req.json(); } catch { return json({ error: "Bad request." }, 400, cors); }
  if (!body || typeof body !== "object") return json({ error: "Bad request." }, 400, cors);

  // Bots fill the hidden "website" field or submit instantly. Pretend it worked.
  if (body.website) return json({ ok: true }, 200, cors);
  const t = Number(body.t);
  if (t && Date.now() - t < MIN_FILL_MS) return json({ ok: true }, 200, cors);

  if ((await rateCount(req, "lead")) >= MAX_PER_HOUR) {
    return json({ error: "Too many requests. Please call us instead." }, 429, cors);
  }

  const lead = {
    name: clean(body.name, 120),
    phone: clean(body.phone, 40),
    email: clean(body.email, 160),
    city: clean(body.city, 80),
    service: clean(body.service, 80),
    message: cleanText(body.message, 1500),
    page: clean(body.page, 300),
    utm_source: clean(body.utm_source, 80),
    utm_medium: clean(body.utm_medium, 80),
    utm_campaign: clean(body.utm_campaign, 120),
    gclid: clean(body.gclid, 120),
  };

  const digits = lead.phone.replace(/\D/g, "");
  if (!lead.name) return json({ error: "Please enter your name." }, 400, cors);
  if (digits.length < 10) return json({ error: "Please enter a phone number with area code." }, 400, cors);
  if (lead.email && !/^\S+@\S+\.\S+$/.test(lead.email)) {
    return json({ error: "That email address does not look right." }, 400, cors);
  }

  const id = newId();
  const now = new Date().toISOString();
  const record = {
    id, createdAt: now, updatedAt: now, status: "new",
    source: lead.utm_source ? "Ad: " + lead.utm_source : "Website form",
    ...lead, estValue: "", wonAmount: "", notes: [],
    activity: [{ at: now, text: "Lead came in from the website form" }],
  };
  await leadStore().setJSON(id, record);
  await rateAdd(req, "lead");
  await notify(record);
  return json({ ok: true }, 200, cors);
};
