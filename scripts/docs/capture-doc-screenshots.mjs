#!/usr/bin/env node
/**
 * Снимки экранов интерфейса для вложения в public/docs/
 *
 * Требования:
 *   npm install
 *   npm run docs:install-browsers
 *   (это качает Chromium под вашу ОС: Apple Silicon — mac-arm64, Intel — mac-x64)
 *   Если видите «Executable doesn't exist» — снова выполните docs:install-browsers.
 *
 * Запуск (сервер приложения должен быть уже запущен, например npm start):
 *   DOCS_USER=admin DOCS_PASSWORD='ваш_пароль' npm run docs:capture-screenshots
 *
 * Переменные окружения:
 *   DOCS_BASE_URL  — по умолчанию http://127.0.0.1:3003
 *   DOCS_USER      — логин (обязателен для страниц приложения под auth)
 *   DOCS_PASSWORD  — пароль
 *   DOCS_VIEWPORT  — ширина окна, по умолчанию 1400
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '../..');
const outDir = path.join(root, 'public', 'docs', 'screenshots');

const baseUrl = (process.env.DOCS_BASE_URL || 'http://127.0.0.1:3003').replace(/\/$/, '');
const user = process.env.DOCS_USER || '';
const password = process.env.DOCS_PASSWORD || '';
const viewportW = Math.max(900, parseInt(process.env.DOCS_VIEWPORT || '1400', 10) || 1400);

const targets = [
    { file: 'dashboard.png', path: '/dashboard', auth: true },
    { file: 'queue.png', path: '/queue', auth: true },
    { file: 'mysites.png', path: '/my-sites', auth: true },
    { file: 'myproducts.png', path: '/my-products', auth: true },
    { file: 'moysklad.png', path: '/moysklad', auth: true },
    { file: 'projects.png', path: '/projects', auth: true },
    { file: 'results.png', path: '/results', auth: true },
    { file: 'matches.png', path: '/matches', auth: true },
    { file: 'processes.png', path: '/processes', auth: true },
    { file: 'settings.png', path: '/settings', auth: true }
];

async function ensurePlaywright() {
    let chromium;
    try {
        const pw = await import('playwright');
        chromium = pw.chromium;
    } catch {
        console.error(
            'Не установлен playwright. Выполните:\n  npm install\n  npm run docs:install-browsers'
        );
        process.exit(1);
    }
    return chromium;
}

async function loginViaApi(page) {
    const ok = await page.evaluate(
        async ({ baseUrl, user, password }) => {
            try {
                const res = await fetch(`${baseUrl}/api/auth/login`, {
                    method: 'POST',
                    credentials: 'include',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ username: user, password })
                });
                const data = await res.json();
                if (!data.success) return { ok: false, error: data.error || 'login failed' };
                localStorage.setItem('isLoggedIn', 'true');
                if (data.username) localStorage.setItem('currentUser', data.username);
                localStorage.setItem('currentUserDisplayName', data.full_name || data.username || '');
                localStorage.setItem('isAdmin', data.isAdmin ? 'true' : 'false');
                if (data.auth_token) localStorage.setItem('authToken', data.auth_token);
                return { ok: true };
            } catch (e) {
                return { ok: false, error: e.message };
            }
        },
        { baseUrl, user, password }
    );
    return ok;
}

async function main() {
    fs.mkdirSync(outDir, { recursive: true });
    const chromium = await ensurePlaywright();
    let browser;
    try {
        browser = await chromium.launch({ headless: true });
    } catch (e) {
        console.error(e.message || e);
        console.error(
            '\nНет бинарника Chromium для Playwright. Выполните в корне проекта:\n' +
                '  npm run docs:install-browsers\n' +
                'или полную установку:\n' +
                '  npx playwright install\n'
        );
        process.exit(1);
    }
    const context = await browser.newContext({
        viewport: { width: viewportW, height: 900 }
    });
    const page = await context.newPage();

    const needCreds = targets.some((t) => t.auth);
    if (needCreds && (!user || !password)) {
        console.warn(
            'Внимание: DOCS_USER / DOCS_PASSWORD не заданы — страницы приложения снимутся с формой входа.\n' +
                'Пример: DOCS_USER=admin DOCS_PASSWORD=\'...\' npm run docs:capture-screenshots\n'
        );
    }

    for (const t of targets) {
        const url = `${baseUrl}${t.path}`;
        try {
            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
            if (t.auth && user && password) {
                const r = await loginViaApi(page);
                if (!r.ok) {
                    console.warn(`  [${t.file}] вход не удался: ${r.error || 'unknown'}`);
                } else {
                    await page.goto(url, { waitUntil: 'load', timeout: 45000 });
                }
            }
            await new Promise((r) => setTimeout(r, 900));
            const outPath = path.join(outDir, t.file);
            await page.screenshot({ path: outPath, fullPage: true });
            console.log('OK', outPath);
        } catch (e) {
            console.error('FAIL', t.file, e.message || e);
        }
    }

    await browser.close();
    console.log('\nГотово. Файлы в public/docs/screenshots/ — подключите их в HTML справки или закоммитьте при необходимости.');
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
