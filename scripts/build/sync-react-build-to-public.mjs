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
