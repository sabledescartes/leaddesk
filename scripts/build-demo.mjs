// Builds app/demo/index.html from app/dashboard/index.html: the same dashboard,
// running on sample leads inside the browser. It never calls the server.
// Run after editing the dashboard: node scripts/build-demo.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function renderDemo() {
  const src = fs.readFileSync(path.join(ROOT, "app/dashboard/index.html"), "utf8");
  const marker = "<script>\n(function () {";
  if (!src.includes(marker)) throw new Error("dashboard script marker not found");
  return src
    .replace("<title>Lead Desk</title>", "<title>Lead Desk demo</title>")
    .replace('<meta name="robots" content="noindex, nofollow">', '<meta name="robots" content="noindex">')
    .replace(marker, "<script>window.LEADDESK_DEMO = true;</script>\n" + marker);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  fs.mkdirSync(path.join(ROOT, "app/demo"), { recursive: true });
  fs.writeFileSync(path.join(ROOT, "app/demo/index.html"), renderDemo());
  console.log("wrote app/demo/index.html");
}
