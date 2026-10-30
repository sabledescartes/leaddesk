// /api/auth/*  - sign up, sign in, sign out, who am I.
import {
  json, readJson, clean, emailOk, createAccount, accountByEmail, checkPassword, burnTime,
  sessionCookie, clearCookie, sessionAccount, sameOrigin, accountView, clientIp,
  rateCount, rateAdd, sleep,
} from "../lib/store.mjs";

export const config = { path: "/api/auth/*" };

const SIGNUPS_PER_HOUR = 5; // per visitor
const FAILED_LOGINS_PER_HOUR = 10; // per visitor, and per email

export default async (req) => {
  const action = new URL(req.url).pathname.replace(/^\/api\/auth\/?/, "").split("/")[0];

  if (action === "me" && req.method === "GET") {
    const acct = await sessionAccount(req);
    return acct ? json({ account: accountView(acct) }) : json({ error: "Not signed in." }, 401);
  }

  if (req.method !== "POST") return json({ error: "Not found." }, 404);
  if (!sameOrigin(req)) return json({ error: "Forbidden." }, 403);
  const ip = clientIp(req);

  if (action === "logout") {
    return json({ ok: true }, 200, { "Set-Cookie": clearCookie(req) });
  }

  if (action === "signup") {
    const b = await readJson(req);
    const email = clean(b.email, 160).toLowerCase();
    const password = String(b.password || "");
    const business = clean(b.business, 80);
    if (!business) return json({ error: "Enter your business name.", field: "business" }, 400);
    if (!emailOk(email)) return json({ error: "Enter a valid email address.", field: "email" }, 400);
    if (password.length < 10) return json({ error: "Use at least 10 characters for your password.", field: "password" }, 400);
    if (password.length > 200) return json({ error: "That password is too long.", field: "password" }, 400);
    if ((await rateCount("signup", ip)) >= SIGNUPS_PER_HOUR) {
      return json({ error: "Too many new accounts from this network. Try again in an hour." }, 429);
    }
    await rateAdd("signup", ip);
    const acct = await createAccount({ email, password, business });
    if (!acct) return json({ error: "An account with this email already exists. Sign in instead.", field: "email" }, 409);
    return json({ ok: true, account: accountView(acct) }, 200, { "Set-Cookie": await sessionCookie(req, acct) });
  }

  if (action === "login") {
    const b = await readJson(req);
    const email = clean(b.email, 160).toLowerCase();
    const password = String(b.password || "").slice(0, 200);
    if ((await rateCount("login", ip)) >= FAILED_LOGINS_PER_HOUR || (email && (await rateCount("login-e", email)) >= FAILED_LOGINS_PER_HOUR)) {
      return json({ error: "Too many wrong attempts. Try again in an hour." }, 429);
    }
    const acct = email ? await accountByEmail(email) : null;
    const ok = acct ? await checkPassword(password, acct.passHash) : (await burnTime(password), false);
    if (!ok) {
      await rateAdd("login", ip);
      if (email) await rateAdd("login-e", email);
      await sleep(400);
      return json({ error: "That email and password do not match." }, 401);
    }
    return json({ ok: true, account: accountView(acct) }, 200, { "Set-Cookie": await sessionCookie(req, acct) });
  }

  return json({ error: "Not found." }, 404);
};
