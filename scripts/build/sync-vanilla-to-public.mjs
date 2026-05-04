#!/usr/bin/env node
/**
 * Собрать static-html/vanilla/*.html и опубликовать в корень public/ (без префикса /vanilla/).
 * Статика: public/assets/ (из static-html/vanilla/assets), public/datagon-vanilla.js.
 * Подстановка темы: public/static/css/main.*.css
 *
 *   npm run sync:vanilla-public
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';
import { injectArchitectuiMainCssLink, resolveArchitectuiMainCssHref } from './architectui-main-css-inject.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '../..');
const publicDir = path.join(root, 'public');

function runAssembleVanillaPages() {
  const script = path.join(root, 'scripts', 'build', 'assemble-vanilla-pages.mjs');
  if (!fs.existsSync(script)) return;
  const r = spawnSync(process.execPath, [script], { cwd: root, stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

function injectArchitectuiMainCssIntoDatagonHtml() {
  const href = resolveArchitectuiMainCssHref(publicDir);
  if (!href) {
    console.warn('datagon HTML CSS: в public/static/css/ нет main.*.css — пропуск инъекции');
    return;
  }
  const publishHtml = [
    'dashboard.html',
    'login.html',
    'my-sites.html',
    'moysklad.html',
    'my-products.html',
    'projects.html',
    'queue.html',
    'results.html',
    'matches.html',
    'processes.html',
    'settings.html',
    'sections.html',
    'ref/index.html',
    'ref/main.html',
    'ref/elements.html',
    'ref/components.html',
    'ref/tables.html',
    'ref/widgets.html',
    'ref/forms.html',
    'ref/charts.html',
    'ref/react-demo-index.html',
    'doc-screenshots/mysites-sample.html',
    'doc-screenshots/manual-sample.html',
    'doc-screenshots/myproducts-sample.html',
    'doc-screenshots/dashboard-sample.html',
    'doc-screenshots/queue-sample.html',
    'doc-screenshots/projects-sample.html',
    'doc-screenshots/results-sample.html',
    'doc-screenshots/matches-sample.html',
    'doc-screenshots/processes-sample.html',
    'doc-screenshots/moysklad-sample.html',
    'doc-screenshots/settings-sample.html',
  ];
  let n = 0;
  for (const name of publishHtml) {
    const p = path.join(publicDir, name);
    if (!fs.existsSync(p)) continue;
    let content = fs.readFileSync(p, 'utf8');
    const next = injectArchitectuiMainCssLink(content, href);
    if (next === content) continue;
    fs.writeFileSync(p, next, 'utf8');
    n += 1;
  }
  if (n) console.log('OK: ARCHITECTUI_MAIN_CSS →', href, '(' + n + ' файлов в public/)');
}

runAssembleVanillaPages();

const vanillaSrc = path.join(root, 'static-html', 'vanilla');
if (!fs.existsSync(vanillaSrc)) {
  console.error('Нет', vanillaSrc);
  process.exit(1);
}

const publishNames = [
  'dashboard.html',
  'login.html',
  'my-sites.html',
  'moysklad.html',
  'my-products.html',
  'projects.html',
  'queue.html',
  'results.html',
  'matches.html',
  'processes.html',
  'settings.html',
  'sections.html',
  'ref/index.html',
  'ref/main.html',
  'ref/elements.html',
  'ref/components.html',
  'ref/tables.html',
  'ref/widgets.html',
  'ref/forms.html',
  'ref/charts.html',
    'ref/react-demo-index.html',
    'doc-screenshots/mysites-sample.html',
    'doc-screenshots/manual-sample.html',
    'doc-screenshots/myproducts-sample.html',
    'doc-screenshots/dashboard-sample.html',
    'doc-screenshots/queue-sample.html',
    'doc-screenshots/projects-sample.html',
    'doc-screenshots/results-sample.html',
    'doc-screenshots/matches-sample.html',
    'doc-screenshots/processes-sample.html',
    'doc-screenshots/moysklad-sample.html',
    'doc-screenshots/settings-sample.html',
    'datagon-vanilla.js',
];

for (const name of publishNames) {
  const from = path.join(vanillaSrc, name);
  const to = path.join(publicDir, name);
  if (fs.existsSync(from)) {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
  }
}

const assetsFrom = path.join(vanillaSrc, 'assets');
const assetsTo = path.join(publicDir, 'assets');
if (fs.existsSync(assetsFrom)) {
  if (fs.existsSync(assetsTo)) {
    fs.rmSync(assetsTo, { recursive: true, force: true });
  }
  fs.mkdirSync(path.dirname(assetsTo), { recursive: true });
  fs.cpSync(assetsFrom, assetsTo, { recursive: true });
}

const legacyVanillaDir = path.join(publicDir, 'vanilla');
if (fs.existsSync(legacyVanillaDir)) {
  fs.rmSync(legacyVanillaDir, { recursive: true, force: true });
  console.log('OK: удалена legacy-папка', legacyVanillaDir);
}

console.log('OK: static-html/vanilla →', publicDir);

injectArchitectuiMainCssIntoDatagonHtml();
