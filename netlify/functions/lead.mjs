// Public endpoints used by the form on contractors' websites.
//   GET  /api/form/<siteKey>   form settings (title, colors, services)
//   POST /api/lead             a new request from a visitor
import {
  json, readJson, clean, cleanText, newId, accountBySiteKey, publicForm, saveAccount, saveLead,
  clientIp, rateCount, rateAdd, sniffImage, saveFile, STORAGE_LIMIT,
} from "../lib/store.mjs";

const MAX_PHOTOS = 3;
const MAX_PHOTO_BYTES = 1.5 * 1024 * 1024; // the form shrinks photos before sending

// Photos arrive as data URLs. Keep only real images, decoded from base64.
function decodePhotos(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const p of list.slice(0, MAX_PHOTOS)) {
    const m = /^data:image\/[a-z+.-]+;base64,([A-Za-z0-9+/=]+)$/.exec(String((p && p.data) || ""));
    if (!m) continue;
    const buf = Buffer.from(m[1], "base64");
    if (!buf.length || buf.length > MAX_PHOTO_BYTES) continue;
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    const type = sniffImage(ab);
    if (!type) continue;
    out.push({ buf: ab, type, name: clean(p.name, 100) || "photo" });
  }
  return out;
}

export const config = { path: ["/api/lead", "/api/form/*"] };

const PER_VISITOR_PER_HOUR = 8;
const PER_ACCOUNT_PER_HOUR = 120; // protects one contractor from a flood
const MIN_FILL_MS = 1500; // a human needs longer than this to fill in the form

function cors(req, acct) {
  const h = {
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
  const list = (acct && acct.allowedOrigins) || [];
  const origin = req.headers.get("origin") || "";
  if (!list.length) h["Access-Control-Allow-Origin"] = "*";
  else if (list.includes(origin)) h["Access-Control-Allow-Origin"] = origin;
  return h;
}

function originAllowed(req, acct) {
  const list = acct.allowedOrigins || [];
  if (!list.length) return true;
  return list.includes(req.headers.get("origin") || "");
}

async function notify(acct, rec) {
  const url = acct.webhook;
  if (!url || !/^https:\/\//i.test(url)) return;
  const line =
    `New lead for ${acct.business}: ${rec.name}, ${rec.phone}` +
    (rec.service ? `, ${rec.service}` : "") +
    (rec.city ? ` (${rec.city})` : "");
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 4000);
  try {
    // "text" is read by Slack, "content" by Discord; Zapier and Make read either.
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
  const path = new URL(req.url).pathname;

  if (path.startsWith("/api/form/")) {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(req, null) });
    const acct = await accountBySiteKey(decodeURIComponent(path.slice("/api/form/".length)));
    if (!acct) return json({ error: "This form key is not active." }, 404, cors(req, null));
    if (!acct.formSeenAt) {
      acct.formSeenAt = new Date().toISOString();
      await saveAccount(acct).catch(() => {});
    }
    return json({ form: publicForm(acct) }, 200, { ...cors(req, acct), "Cache-Control": "public, max-age=60" });
  }

  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(req, null) });
  if (req.method !== "POST") return json({ error: "Not found." }, 404, cors(req, null));

  const body = await readJson(req);
  const acct = await accountBySiteKey(clean(body.key, 60));
  if (!acct) return json({ error: "This form is not connected to an account." }, 404, cors(req, null));
  const h = cors(req, acct);
  if (!originAllowed(req, acct)) return json({ error: "This website is not allowed to send leads." }, 403, h);

  // Bots fill in the hidden "website" field or submit instantly. Pretend it worked.
  if (body.website) return json({ ok: true }, 200, h);
  const t = Number(body.t);
  if (t && Date.now() - t < MIN_FILL_MS) return json({ ok: true }, 200, h);

  const ip = clientIp(req);
  if ((await rateCount("lead-ip-" + acct.id, ip)) >= PER_VISITOR_PER_HOUR || (await rateCount("lead-acct", acct.id)) >= PER_ACCOUNT_PER_HOUR) {
    return json({ error: "Too many requests." + (acct.form && acct.form.phone ? " Please call " + acct.form.phone + "." : "") }, 429, h);
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
  if (!lead.name) return json({ error: "Please enter your name." }, 400, h);
  if (lead.phone.replace(/\D/g, "").length < 10) return json({ error: "Please enter a phone number with area code." }, 400, h);
  if (lead.email && !/^\S+@\S+\.\S+$/.test(lead.email)) return json({ error: "That email address does not look right." }, 400, h);

  const now = new Date().toISOString();
  const rec = {
    id: newId(), createdAt: now, updatedAt: now, status: "new",
    source: lead.gclid ? "Google Ads" : lead.utm_source ? "Ad: " + lead.utm_source : "Website form",
    ...lead, estValue: "", wonAmount: "", notes: [], files: [],
    activity: [{ at: now, text: "Came in from your website form" }],
  };
  const photos = acct.form && acct.form.photos === false ? [] : decodePhotos(body.photos);
  for (const ph of photos) {
    if ((acct.storageBytes || 0) + ph.buf.byteLength > STORAGE_LIMIT) break;
    rec.files.push(await saveFile(acct, rec.id, { buf: ph.buf, name: ph.name, type: ph.type, by: "customer" }));
  }
  if (rec.files.length) rec.activity[0].text += ` with ${rec.files.length} photo${rec.files.length > 1 ? "s" : ""}`;
  await saveLead(acct.id, rec);
  await rateAdd("lead-ip-" + acct.id, ip);
  await rateAdd("lead-acct", acct.id);
  if (!acct.firstLeadAt || rec.files.length) {
    acct.firstLeadAt = acct.firstLeadAt || now;
    await saveAccount(acct).catch(() => {});
  }
  await notify(acct, rec);
  return json({ ok: true }, 200, h);
};
