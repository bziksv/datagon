#!/usr/bin/env node
/**
 * Минимальный smoke e2e для ключевых экранов Datagon (Playwright + Chromium).
 *
 * Требования:
 *   npm install
 *   npm run docs:install-browsers
 *
 * Перед запуском поднимите backend: npm start (порт из config.js, обычно 3000).
 *
 * Переменные окружения:
 *   DATAGON_SMOKE_BASE_URL — по умолчанию http://127.0.0.1:3000
 *   DATAGON_SMOKE_USER / DATAGON_SMOKE_PASSWORD — опционально, для API-входа (как в capture-doc-screenshots)
 */

const baseUrl = (process.env.DATAGON_SMOKE_BASE_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');
const user = process.env.DATAGON_SMOKE_USER || '';
const password = process.env.DATAGON_SMOKE_PASSWORD || '';

const cases = [
    {
        name: 'my-products',
        path: '/my-products.html',
        mustSee: ['Мои товары', 'Фильтры и действия']
    },
    {
        name: 'moysklad',
        path: '/moysklad.html',
        mustSee: ['МойСклад', 'Фильтры и действия']
    },
    {
        name: 'matches',
        path: '/matches.html',
        mustSee: ['Сопоставление', 'Умный поиск']
    }
];

async function ensurePlaywright() {
    try {
        const pw = await import('playwright');
        return pw.chromium;
    } catch {
        console.error('Не установлен playwright. Выполните в корне проекта:\n  npm install');
        process.exit(1);
    }
}

async function main() {
    const chromium = await ensurePlaywright();
    let browser;
    try {
        browser = await chromium.launch({ headless: true });
    } catch (e) {
        console.error(e.message || e);
        console.error(
            '\nНет бинарника Chromium. Выполните:\n' +
                '  npm run docs:install-browsers\n'
        );
        process.exit(1);
    }

    const context = await browser.newContext({
        viewport: { width: 1400, height: 900 },
        ignoreHTTPSErrors: true
    });
    const page = await context.newPage();

    if (user && password) {
        await page.goto(`${baseUrl}/login.html?then=/dashboard.html`, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.locator('#dg-login-username').fill(user);
        await page.locator('#dg-login-password').fill(password);
        await page.locator('#dg-login-form').evaluate((f) => f.requestSubmit());
        await page.waitForURL(/dashboard\.html/i, { timeout: 60000 });
        console.log('OK login через страницу /login.html');
    } else {
        await page.goto(`${baseUrl}/login.html`, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.getByRole('heading', { name: /Датагон/i }).first().waitFor({ state: 'visible', timeout: 30000 });
        console.warn(
            'DATAGON_SMOKE_USER / DATAGON_SMOKE_PASSWORD не заданы — проверена только страница входа (остальные сценарии пропущены).'
        );
        await browser.close();
        console.log('\nГотово: страница входа доступна.');
        return;
    }

    let failed = 0;
    for (const t of cases) {
        const url = `${baseUrl}${t.path}`;
        try {
            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
            for (const fragment of t.mustSee) {
                await page.getByText(fragment, { exact: false }).first().waitFor({
                    state: 'visible',
                    timeout: 90000
                });
            }
            console.log('OK', t.name, url);
        } catch (e) {
            failed += 1;
            console.error('FAIL', t.name, e.message || e);
        }
    }

    await browser.close();

    if (failed) {
        console.error(`\nГотово с ошибками: ${failed} из ${cases.length}`);
        process.exit(1);
    }
    console.log(`\nГотово: все ${cases.length} сценария прошли.`);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
