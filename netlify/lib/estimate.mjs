// Estimate math, shared by the dashboard API and the public estimate page.
// Amounts are kept in cents while adding up, so totals never drift.
import { clean } from "./store.mjs";

const num = (v) => {
  const n = Number(String(v == null ? "" : v).replace(/[^\d.-]/g, ""));
  return isFinite(n) ? n : 0;
};

export function cleanItems(list) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, 60).map((it) => ({
    desc: clean(it && it.desc, 300),
    qty: clean(it && it.qty, 10).replace(/[^\d.]/g, "") || "1",
    price: clean(it && it.price, 14).replace(/[^\d.]/g, ""),
  })).filter((it) => it.desc || it.price);
}

export function totals(est) {
  let sub = 0;
  for (const it of est.items || []) sub += Math.round(num(it.qty) * num(it.price) * 100);
  const rate = Math.min(Math.max(num(est.taxRate), 0), 30);
  const tax = Math.round((sub * rate) / 100);
  return { subtotal: sub / 100, tax: tax / 100, total: (sub + tax) / 100, rate };
}
