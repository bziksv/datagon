#!/usr/bin/env node
/**
 * Минимальный smoke e2e для ключевых экранов Datagon (Playwright + Chromium).
 *
 * Требования:
 *   npm install
 *   npm run docs:install-browsers
 *
 * Перед запуском поднимите backend (3000) и dev UI (3003), как в README.
 *
 * Переменные окружения:
 *   DATAGON_SMOKE_BASE_URL — по умолчанию http://127.0.0.1:3003
 *   DATAGON_SMOKE_USER / DATAGON_SMOKE_PASSWORD — опционально, для API-входа (как в capture-doc-screenshots)
 */

const baseUrl = (process.env.DATAGON_SMOKE_BASE_URL || 'http://127.0.0.1:3003').replace(/\/$/, '');
const user = process.env.DATAGON_SMOKE_USER || '';
const password = process.env.DATAGON_SMOKE_PASSWORD || '';

const cases = [
    {
        name: 'my-products',
        path: '/my-products',
        mustSee: ['Мои товары', 'Фильтры и действия']
    },
    {
        name: 'moysklad',
        path: '/moysklad',
        mustSee: ['МойСклад', 'Фильтры и действия']
    },
    {
        name: 'matches',
        path: '/matches',
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

async function loginViaApi(page) {
    const ok = await page.evaluate(
        async ({ origin, user, password }) => {
            try {
                const res = await fetch(`${origin}/api/auth/login`, {
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
        { origin: baseUrl, user, password }
    );
    return ok;
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

    const boot = `${baseUrl}/dashboard`;
    await page.goto(boot, { waitUntil: 'domcontentloaded', timeout: 60000 });

    if (user && password) {
        const r = await loginViaApi(page);
        if (!r.ok) {
            console.error('Вход API не удался:', r.error || 'unknown');
            await browser.close();
            process.exit(1);
        }
        console.log('OK login via API');
    } else {
        console.warn(
            'DATAGON_SMOKE_USER / DATAGON_SMOKE_PASSWORD не заданы — проверяем только shell UI (данные API могут не подтянуться).'
        );
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
