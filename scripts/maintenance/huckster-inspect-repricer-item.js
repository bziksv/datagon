#!/usr/bin/env node
/**
 * Снять сырые объекты из Huckster API repricer/items/list по маркетплейсу Я.М.
 * Креды: HUCKSTER_EMAIL / HUCKSTER_PASSWORD из окружения или app_settings (как server).
 * Магазин: первая запись marketplace=yandex из huckster_shops_set_1 или дефолт shop_id.
 *
 * Usage:
 *   node scripts/maintenance/huckster-inspect-repricer-item.js
 *   node scripts/maintenance/huckster-inspect-repricer-item.js 3110 101404837856
 */
'use strict';

const axios = require('axios');
const mysql = require('mysql2/promise');
const config = require('../../config');

const LIMIT = 900;
const NEEDLES_DEFAULT = ['3110', '101404837856'];

function getField(obj, camel, pascal) {
    if (obj == null || typeof obj !== 'object') return undefined;
    if (Object.prototype.hasOwnProperty.call(obj, camel) && obj[camel] !== undefined) return obj[camel];
    if (Object.prototype.hasOwnProperty.call(obj, pascal) && obj[pascal] !== undefined) return obj[pascal];
    return undefined;
}

function rowMatchesNeedles(row, needles) {
    const uid = String(getField(row, 'uid', 'Uid') ?? row.uid ?? '').trim();
    const sku = String(getField(row, 'sku', 'Sku') ?? row.sku ?? '').trim();
    const marketId = String(row.market_id ?? row.marketId ?? '').trim();
    for (const n of needles) {
        const s = String(n).trim();
        if (!s) continue;
        if (uid === s || marketId === s || sku === s) return true;
    }
    return false;
}

async function hucksterMd5(password) {
    const r = await axios.post(
        'https://wbs.e-teleport.ru/md5',
        { input: password },
        { timeout: 30000, headers: { Accept: 'application/json', 'Content-Type': 'application/json' } }
    );
    return String(r.data || '').trim().replace(/^"|"$/g, '');
}

async function hucksterAuth(email, password) {
    const md5 = await hucksterMd5(password);
    const r = await axios.post(
        'https://wbs.e-teleport.ru/auth/credentials',
        { userName: email, password: md5 },
        { timeout: 30000, headers: { Accept: 'application/json', 'Content-Type': 'application/json' } }
    );
    const sessionId = r && r.data && r.data.SessionId ? String(r.data.SessionId) : '';
    if (!sessionId) throw new Error('Нет SessionId от Huckster');
    return sessionId;
}

function parseYandexShopFromSet1(rawJson, fallbackShopId) {
    try {
        const arr = JSON.parse(String(rawJson || '[]'));
        if (!Array.isArray(arr)) return { shop_id: fallbackShopId, label: 'fallback' };
        const y = arr.find((x) => String(x.marketplace || '').toLowerCase() === 'yandex');
        if (y && String(y.shop_id || '').trim()) {
            return { shop_id: String(y.shop_id).trim(), label: String(y.name || y.id || 'yandex') };
        }
    } catch (_) {}
    return { shop_id: fallbackShopId, label: 'default' };
}

async function loadHucksterCredsFromDb() {
    const pool = await mysql.createPool({
        host: config.db.host,
        user: config.db.user,
        password: config.db.password,
        database: config.db.database,
    });
    try {
        const [rows] = await pool.query(
            `SELECT setting_key, setting_value FROM app_settings
             WHERE setting_key IN ('huckster_email','huckster_password','huckster_shops_set_1')`
        );
        const map = {};
        for (const r of rows || []) {
            map[r.setting_key] = r.setting_value;
        }
        return {
            email: String(map.huckster_email || '').trim(),
            password: String(map.huckster_password || '').trim(),
            shops_set_1: map.huckster_shops_set_1 || '',
        };
    } finally {
        await pool.end();
    }
}

async function main() {
    const needles = process.argv.slice(2).filter(Boolean);
    const search = needles.length ? needles : NEEDLES_DEFAULT;

    const envEmail = String(process.env.HUCKSTER_EMAIL || '').trim();
    const envPass = String(process.env.HUCKSTER_PASSWORD || '').trim();

    let email = envEmail;
    let password = envPass;
    let shopsRaw = '';

    if (!email || !password) {
        console.log('[huckster-inspect] Креды из БД (app_settings)…');
        const fromDb = await loadHucksterCredsFromDb();
        shopsRaw = fromDb.shops_set_1;
        if (!email) email = fromDb.email;
        if (!password) password = fromDb.password;
    } else {
        try {
            const fromDb = await loadHucksterCredsFromDb();
            shopsRaw = fromDb.shops_set_1;
        } catch (_) {}
    }

    if (!email || !password) {
        console.error(
            '[huckster-inspect] Нет логина/пароля: задайте HUCKSTER_EMAIL и HUCKSTER_PASSWORD или app_settings huckster_*'
        );
        process.exit(1);
    }

    const { shop_id, label } = parseYandexShopFromSet1(shopsRaw, '22155238');
    console.log('[huckster-inspect] Яндекс кабинет:', { shop_id, source: label });
    console.log('[huckster-inspect] Ищем подстроки в JSON строки:', search);

    const sessionId = await hucksterAuth(email, password);
    const headers = {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Cookie: `ss-id=${sessionId}`,
    };

    const matches = [];
    let offset = 0;
    let pages = 0;
    let totalRows = 0;

    for (;;) {
        pages += 1;
        const r = await axios.post(
            'https://wbs.e-teleport.ru/markets/integrations/repricer/items/list',
            { marketplace: 'yandex', shop_id, limit: LIMIT, offset },
            { timeout: 60000, headers }
        );
        const payload = r && r.data ? r.data : {};
        if (payload.error) {
            console.error('[huckster-inspect] Ошибка API:', payload.error.message || payload.error);
            process.exit(2);
        }
        const rows = Array.isArray(payload.result) ? payload.result : [];
        totalRows += rows.length;

        for (const row of rows) {
            if (rowMatchesNeedles(row, search)) {
                matches.push(row);
            }
        }

        console.log(`[huckster-inspect] Страница ${pages}, offset=${offset}, строк на странице=${rows.length}, совпадений всего=${matches.length}`);

        offset += LIMIT;
        if (rows.length < LIMIT) break;
        await new Promise((res) => setTimeout(res, 200));
    }

    if (matches.length === 0) {
        console.log(
            `[huckster-inspect] Не найдено за ${pages} стр., всего просмотрено позиций≈${totalRows}. Уточните shop_id или строки поиска.`
        );
        process.exit(0);
    }

    console.log('\n[huckster-inspect] Совпадения (полный JSON объекта из result[]):\n');
    for (let i = 0; i < matches.length; i += 1) {
        console.log('--- match', i + 1, '---');
        console.log(JSON.stringify(matches[i], null, 2));
        const uid = getField(matches[i], 'uid', 'Uid');
        const sku = getField(matches[i], 'sku', 'Sku') ?? matches[i].sku;
        console.log('--- кратко: uid =', uid, '| sku =', sku, '| market_id =', matches[i].market_id, '---\n');
    }
}

main().catch((e) => {
    console.error('[huckster-inspect]', e.message || e);
    process.exit(3);
});
