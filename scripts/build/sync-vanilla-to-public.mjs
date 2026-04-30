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
  const cssDir = path.join(publicDir, 'static', 'css');
  if (!fs.existsSync(cssDir)) return;
  const cssFiles = fs.readdirSync(cssDir).filter((f) => /^main\.[a-z0-9]+\.css$/i.test(f));
  if (!cssFiles.length) {
    console.warn('datagon HTML CSS: в public/static/css/ нет main.*.css — пропуск инъекции');
    return;
  }
  cssFiles.sort();
  const href = '/static/css/' + cssFiles[cssFiles.length - 1];
  const linkTag = '<link rel="stylesheet" href="' + href + '" />';
  const publishHtml = [
    'dashboard.html',
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
  ];
  let n = 0;
  for (const name of publishHtml) {
    const p = path.join(publicDir, name);
    if (!fs.existsSync(p)) continue;
    let content = fs.readFileSync(p, 'utf8');
    if (!content.includes('<!-- ARCHITECTUI_MAIN_CSS -->')) continue;
    content = content.split('<!-- ARCHITECTUI_MAIN_CSS -->').join(linkTag);
    fs.writeFileSync(p, content, 'utf8');
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
  'datagon-vanilla.js',
];

for (const name of publishNames) {
  const from = path.join(vanillaSrc, name);
  const to = path.join(publicDir, name);
  if (fs.existsSync(from)) {
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
