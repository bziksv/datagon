#!/usr/bin/env node
/**
 * Быстрая проверка доступности основных GET API после логина.
 *
 *   DATAGON_SMOKE_BASE_URL — по умолчанию http://127.0.0.1:3000
 *   DATAGON_SMOKE_USER / DATAGON_SMOKE_PASSWORD — обязательны для этого скрипта
 */
const base = (process.env.DATAGON_SMOKE_BASE_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');
const user = String(process.env.DATAGON_SMOKE_USER || '').trim();
const password = String(process.env.DATAGON_SMOKE_PASSWORD || '').trim();

const checks = [
    ['GET', '/api/auth/me'],
    ['GET', '/api/settings'],
    ['GET', '/api/projects?limit=1'],
    ['GET', '/api/pages?limit=1'],
    ['GET', '/api/results?limit=1'],
    ['GET', '/api/my-sites'],
    ['GET', '/api/my-products?limit=1&site_id=all'],
    ['GET', '/api/my-products/stats'],
    ['GET', '/api/matches/my-sites'],
    ['GET', '/api/matches/status?my_site_id=1'],
    ['GET', '/api/ms/status'],
    ['GET', '/api/ms/stats'],
    ['GET', '/api/sync-status'],
    ['GET', '/api/processes/overview'],
    ['GET', '/api/activity/events?limit=1']
];

async function main() {
    if (!user || !password) {
        console.error(
            'Задайте DATAGON_SMOKE_USER и DATAGON_SMOKE_PASSWORD (как для npm run test:datagon-smoke-e2e).'
        );
        process.exit(2);
    }

    const loginRes = await fetch(`${base}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: user, password })
    });
    const loginJson = await loginRes.json().catch(() => ({}));
    if (!loginRes.ok || !loginJson.auth_token) {
        console.error('Логин не удался:', loginRes.status, loginJson);
        process.exit(1);
    }
    const token = loginJson.auth_token;
    console.log('OK login', loginJson.username || user);

    let failed = 0;
    for (const [method, path] of checks) {
        const url = `${base}${path}`;
        const res = await fetch(url, {
            method,
            headers: { 'x-auth-token': token, Accept: 'application/json' }
        });
        const ok = res.ok;
        if (!ok) {
            const txt = await res.text();
            console.error('FAIL', method, path, res.status, txt.slice(0, 200));
            failed += 1;
        } else {
            console.log('OK', res.status, method, path);
        }
    }

    if (failed) {
        console.error(`\nОшибок: ${failed} из ${checks.length}`);
        process.exit(1);
    }
    console.log(`\nГотово: все ${checks.length} запросов вернули 2xx.`);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
