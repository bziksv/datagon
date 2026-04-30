#!/usr/bin/env node
/**
 * Сборка CRA и копирование артефакта в корень public/ (UI по адресам /moysklad, /dashboard, …).
 *
 * Раньше цель была public/architectui-react-pro/ — см. редирект в server.js для старых URL.
 *
 * ВНИМАНИЕ: npm run build внутри CRA на слабом прод-сервере даёт пик CPU/RAM и может
 * раздувать диск (кэши). На VPS предпочтительно: собрать на машине разработчика и залить public/.
 *
 *   node scripts/build/sync-react-build-to-public.mjs
 *   SKIP_REACT_BUILD=1 node scripts/build/sync-react-build-to-public.mjs
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';

function runAssembleVanillaPages(root) {
    const script = path.join(root, 'scripts', 'build', 'assemble-vanilla-pages.mjs');
    if (!fs.existsSync(script)) return;
    const r = spawnSync(process.execPath, [script], { cwd: root, stdio: 'inherit' });
    if (r.status !== 0) process.exit(r.status ?? 1);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '../..');
const spaDir = path.join(root, 'architectui-react-pro');
const buildDir = path.join(spaDir, 'build');
const publicDir = path.join(root, 'public');
const legacySpaDir = path.join(publicDir, 'architectui-react-pro');

if (process.env.SKIP_REACT_BUILD !== '1') {
    const r = spawnSync('npm', ['run', 'build'], {
        cwd: spaDir,
        stdio: 'inherit',
        shell: process.platform === 'win32'
    });
    if (r.status !== 0) {
        process.exit(r.status ?? 1);
    }
}

if (!fs.existsSync(buildDir)) {
    console.error('Нет architectui-react-pro/build. Выполните: cd architectui-react-pro && npm run build');
    process.exit(1);
}

/** Убрать предыдущий вывод CRA из корня public/, не трогая чужие файлы по маске нельзя — чистим типичные артефакты + legacy-папку */
function cleanPreviousSpaArtifacts() {
    if (fs.existsSync(legacySpaDir)) {
        fs.rmSync(legacySpaDir, { recursive: true, force: true });
        console.log('OK: удалена legacy-папка', legacySpaDir);
    }
    const rootArtifacts = ['index.html', 'asset-manifest.json', 'manifest.json', 'favicon.ico', 'favicon.svg', 'robots.txt', 'logo192.png', 'logo512.png'];
    for (const name of rootArtifacts) {
        const p = path.join(publicDir, name);
        if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
    }
    const staticDir = path.join(publicDir, 'static');
    if (fs.existsSync(staticDir)) {
        fs.rmSync(staticDir, { recursive: true, force: true });
    }
}

fs.mkdirSync(publicDir, { recursive: true });
cleanPreviousSpaArtifacts();
fs.cpSync(buildDir, publicDir, { recursive: true });
console.log('OK: React build скопирован в', publicDir);

/** Подставить в vanilla HTML ссылку на тот же main.*.css, что и у SPA (хеш меняется при сборке). */
function injectArchitectuiMainCssIntoVanillaHtml() {
    const indexPath = path.join(publicDir, 'index.html');
    const vanillaDir = path.join(publicDir, 'vanilla');
    if (!fs.existsSync(indexPath) || !fs.existsSync(vanillaDir)) return;
    const indexHtml = fs.readFileSync(indexPath, 'utf8');
    const m = indexHtml.match(/href="\.\/static\/css\/([^"]+\.css)"/);
    if (!m) {
        console.warn('vanilla CSS: в public/index.html не найден ./static/css/main.*.css — пропуск инъекции');
        return;
    }
    const href = '/static/css/' + m[1];
    const linkTag = '<link rel="stylesheet" href="' + href + '" />';
    const files = fs.readdirSync(vanillaDir).filter((f) => f.endsWith('.html'));
    let n = 0;
    for (const f of files) {
        const p = path.join(vanillaDir, f);
        let content = fs.readFileSync(p, 'utf8');
        if (!content.includes('<!-- ARCHITECTUI_MAIN_CSS -->')) continue;
        content = content.split('<!-- ARCHITECTUI_MAIN_CSS -->').join(linkTag);
        fs.writeFileSync(p, content, 'utf8');
        n += 1;
    }
    if (n) console.log('OK: ARCHITECTUI_MAIN_CSS →', href, '(' + n + ' файлов в public/vanilla)');
}

/** Статические HTML5-страницы (миграция без React): собрать из _template.html + inners/, затем копировать только артефакты в public/vanilla */
const vanillaSrc = path.join(root, 'static-html', 'vanilla');
const vanillaDest = path.join(publicDir, 'vanilla');
if (fs.existsSync(vanillaSrc)) {
    runAssembleVanillaPages(root);
    fs.mkdirSync(vanillaDest, { recursive: true });
    const publishNames = ['dashboard.html', 'my-sites.html', 'moysklad.html', 'my-products.html', 'projects.html', 'queue.html', 'results.html', 'matches.html', 'processes.html', 'settings.html', 'index.html', 'datagon-vanilla.js'];
    for (const name of publishNames) {
        const from = path.join(vanillaSrc, name);
        const to = path.join(vanillaDest, name);
        if (fs.existsSync(from)) {
            fs.copyFileSync(from, to);
        }
    }
    const assetsFrom = path.join(vanillaSrc, 'assets');
    const assetsTo = path.join(vanillaDest, 'assets');
    if (fs.existsSync(assetsFrom)) {
        fs.mkdirSync(assetsTo, { recursive: true });
        fs.cpSync(assetsFrom, assetsTo, { recursive: true });
    }
    console.log('OK: static-html/vanilla (собранные html + assets) →', vanillaDest);
}
injectArchitectuiMainCssIntoVanillaHtml();
