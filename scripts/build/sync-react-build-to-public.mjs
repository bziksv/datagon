#!/usr/bin/env node
/**
 * Сборка CRA и копирование артефакта в public/architectui-react-pro/
 *
 * ВНИМАНИЕ: npm run build внутри CRA на слабом прод-сервере даёт пик CPU/RAM и может
 * раздувать диск (кэши). На VPS предпочтительно: собрать на машине разработчика,
 * залить только public/architectui-react-pro/ или положить готовый build и:
 *   SKIP_REACT_BUILD=1 node scripts/build/sync-react-build-to-public.mjs
 *
 *   node scripts/build/sync-react-build-to-public.mjs
 *
 * Только копирование (если build уже есть):
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
const targetDir = path.join(root, 'public', 'architectui-react-pro');

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

fs.rmSync(targetDir, { recursive: true, force: true });
fs.mkdirSync(path.dirname(targetDir), { recursive: true });
fs.cpSync(buildDir, targetDir, { recursive: true });
console.log('OK: React build скопирован в', targetDir);
