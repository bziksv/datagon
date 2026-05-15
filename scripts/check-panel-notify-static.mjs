#!/usr/bin/env node
/**
 * Статическая проверка собранных public/*.html: datagon-vanilla.js + shell, счётчик data-dg-notify-start.
 * Запуск из корня: node scripts/check-panel-notify-static.mjs
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..", "public");

const PAGES = [
  "dashboard.html",
  "my-sites.html",
  "my-products.html",
  "moysklad.html",
  "purchase.html",
  "product.html",
  "projects.html",
  "queue.html",
  "results.html",
  "matches.html",
  "processes.html",
  "settings.html",
  "sections.html",
  "exports-marketplaces.html",
  "exports-marketplaces-ozon.html",
  "exports-marketplaces-wildberries.html",
  "exports-marketplaces-yandex.html",
  "exports-dimensions.html",
  "exports-marketplaces-issues.html",
  "exports-huckster.html",
  "ms-sales.html",
  "login.html",
  "no-access.html",
];

function scan(file) {
  const p = path.join(root, file);
  if (!fs.existsSync(p)) return { miss: true };
  const h = fs.readFileSync(p, "utf8");
  const hasJs = /datagon-vanilla\.js/i.test(h);
  const hasShell = /datagon-vanilla-shell/i.test(h);
  const nStart = (h.match(/data-dg-notify-start=/g) || []).length;
  return { hasJs, hasShell, nStart };
}

function gradeA(file, c) {
  if (file === "login.html") return c.hasJs ? "unexpected-js" : "ok(exp)";
  if (file === "no-access.html") return !c.hasJs && !c.hasShell ? "ok(exp)" : c.hasShell && c.hasJs ? "ok" : "partial";
  if (c.hasJs && c.hasShell) return "ok";
  if (c.hasJs) return "js-only";
  return "fail";
}

const rows = [];
for (const f of PAGES) {
  const c = scan(f);
  if (c.miss) {
    rows.push({ file: f, A: "MISSING", B: "—", note: "файл не найден в public/" });
    continue;
  }
  const A = gradeA(f, c);
  let note = "";
  if (f === "login.html") note = "без DatagonNotify";
  if (f === "no-access.html") note = "минимальная страница";
  if (f === "sections.html") note = "каталог ссылок — B=0 норма";
  if (f === "exports-marketplaces.html" && c.nStart === 0) note = "добавить notify на кнопки по мере появления";
  rows.push({ file: f, A, B: String(c.nStart), note });
}

console.log("| Файл | A (shell+js) | B (data-dg-notify-start) | Примечание |");
console.log("|------|----------------|---------------------------|------------|");
for (const r of rows) {
  console.log(`| ${r.file} | ${r.A} | ${r.B} | ${r.note} |`);
}

const bad = rows.filter((r) => r.A === "fail" || r.A === "js-only" || r.A === "MISSING" || r.A === "unexpected-js");
if (bad.length) {
  console.error("\nFAIL:", bad.map((x) => x.file).join(", "));
  process.exit(1);
}
process.exit(0);
