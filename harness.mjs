// Loads the Netlify functions outside Netlify by swapping @netlify/blobs for an
// in-memory stand-in. Used by run.mjs (tests) and dev-server.mjs (manual testing).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const STUB = `
const stores = (globalThis.__leaddeskStores ||= new Map());
export function getStore(opts) {
  const name = typeof opts === "string" ? opts : opts.name;
  if (!stores.has(name)) stores.set(name, new Map());
  const m = stores.get(name);
  return {
    async get(k, o) { const v = m.get(k); if (v === undefined) return null; return o && o.type === "json" ? JSON.parse(v) : v; },
    async setJSON(k, v) { m.set(k, JSON.stringify(v)); },
    async delete(k) { m.delete(k); },
    async list() { return { blobs: [...m.keys()].map((key) => ({ key })) }; },
  };
}
`;

export async function loadFunctions() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "leaddesk-"));
  fs.cpSync(path.join(ROOT, "netlify"), path.join(tmp, "netlify"), { recursive: true });
  const stub = path.join(tmp, "node_modules", "@netlify", "blobs");
  fs.mkdirSync(stub, { recursive: true });
  fs.writeFileSync(path.join(stub, "package.json"), JSON.stringify({ name: "@netlify/blobs", type: "module", exports: "./index.js" }));
  fs.writeFileSync(path.join(stub, "index.js"), STUB);
  fs.writeFileSync(path.join(tmp, "package.json"), '{"type":"module"}');
  const imp = (f) => import(pathToFileURL(path.join(tmp, "netlify", f)).href);
  return {
    lead: (await imp("functions/lead.mjs")).default,
    admin: (await imp("functions/admin.mjs")).default,
    stores: () => globalThis.__leaddeskStores,
    reset: () => globalThis.__leaddeskStores && globalThis.__leaddeskStores.clear(),
  };
}
