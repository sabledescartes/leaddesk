// Builds demo/index.html from app/admin/index.html: same dashboard, but it runs on
// made-up leads inside the browser and never calls the server.
// Run: node scripts/build-demo.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function renderDemo() {
  const src = fs.readFileSync(path.join(ROOT, "app/admin/index.html"), "utf8");
  const marker = "<script>\n(function () {";
  if (!src.includes(marker)) throw new Error("admin/index.html script marker not found");
  return src.replace(marker, "<script>window.LEADDESK_DEMO = true;</script>\n" + marker);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  fs.mkdirSync(path.join(ROOT, "demo"), { recursive: true });
  fs.writeFileSync(path.join(ROOT, "demo/index.html"), renderDemo());
  console.log("wrote demo/index.html");
}
