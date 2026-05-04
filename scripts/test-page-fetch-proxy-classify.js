'use strict';

/**
 * Загрузка страницы как у воркера (fetchHtmlForSiteParse + прокси из app_settings)
 * и проверка assertHtmlNotWafChallenge / hasGenericProductSignals.
 *
 * Использование:
 *   node scripts/test-page-fetch-proxy-classify.js [URL]
 *
 * Без БД (передать один прокси вручную):
 *   DATAGON_TEST_PROXY="socks5://user:pass@host:port" node scripts/test-page-fetch-proxy-classify.js URL
 *
 * DATAGON_TEST_PROXY — одна строка (http(s) или socks5), как в fetch_proxy_list.
 */

const mysql = require('mysql2/promise');
const axios = require('axios');
const cheerio = require('cheerio');
const config = require('../config');
const { fetchHtmlForSiteParse } = require('../lib/datagonSiteFetch');
const { assertHtmlNotWafChallenge, hasGenericProductSignals } = require('../lib/datagonPageClassify');

function countProxyLines(list) {
    return String(list || '')
        .split(/[\r\n,;]+/)
        .map((s) => s.trim())
        .filter(Boolean).length;
}

async function loadProxyFromDb() {
    const db = await mysql.createConnection({
        host: config.db.host,
        user: config.db.user,
        password: config.db.password,
        database: config.db.database
    });
    try {
        const [rows] = await db.query(
            "SELECT setting_key, setting_value FROM app_settings WHERE setting_key IN ('fetch_proxy_enabled','fetch_proxy_list')"
        );
        const app = { fetch_proxy_enabled: 0, fetch_proxy_list: '' };
        rows.forEach((r) => {
            app[r.setting_key] = r.setting_value;
        });
        return {
            enabled: Number(app.fetch_proxy_enabled) === 1,
            list: String(app.fetch_proxy_list || '')
        };
    } finally {
        await db.end();
    }
}

async function main() {
    const url =
        process.argv[2] ||
        'https://stomshop.pro/mercury-550';

    let proxyOpt;
    const testProxy = String(process.env.DATAGON_TEST_PROXY || '').trim();
    if (testProxy) {
        proxyOpt = { enabled: true, list: testProxy };
        console.log('[proxy] источник: env DATAGON_TEST_PROXY (маскировано)');
    } else {
        proxyOpt = await loadProxyFromDb();
        console.log('[proxy] источник: app_settings (как у worker)');
    }

    const lines = countProxyLines(proxyOpt.list);
    console.log('[proxy] enabled=%s строк_в_списке=%s', proxyOpt.enabled, lines);
    if (proxyOpt.enabled && lines === 0) {
        console.warn('[proxy] ВНИМАНИЕ: fetch_proxy_enabled=1, но список пуст — запрос пойдёт без прокси (direct).');
    }

    console.log('[fetch] %s', url);
    const html = await fetchHtmlForSiteParse(axios, url, {
        timeout: 28000,
        proxy: proxyOpt
    });

    console.log('[html] bytes=%s', Buffer.byteLength(html, 'utf8'));

    try {
        assertHtmlNotWafChallenge(html);
        console.log('[waf] assertHtmlNotWafChallenge: ok');
    } catch (e) {
        console.log('[waf] assertHtmlNotWafChallenge: FAIL — %s', e.message);
        process.exitCode = 2;
        return;
    }

    const $ = cheerio.load(html);
    const generic = hasGenericProductSignals($, html);
    console.log('[classify] hasGenericProductSignals=%s', generic);
}

main().catch((e) => {
    console.error('[error]', e.message || e);
    process.exit(1);
});
