#!/usr/bin/env node
/**
 * Обход API по wiki.huckster.ru (repricer + Unit): найти UID в repricer/items/list и в unit/set/get.
 * Креды: HUCKSTER_EMAIL + HUCKSTER_PASSWORD в окружении ИЛИ app_settings (как у Datagon-синка).
 *
 * Usage:
 *   node scripts/qa/huckster-wiki-probe-uid.js [uid] [--set 1|2] [--mp ozon|wildberries|yandex]
 *
 * Примеры:
 *   node scripts/qa/huckster-wiki-probe-uid.js 3110
 *   node scripts/qa/huckster-wiki-probe-uid.js 3110 --set 1 --mp yandex
 */
'use strict';

const mysql = require('mysql2/promise');
const axios = require('axios');
const config = require('../../config');

const REPRICER_LIMIT = 900;
const UNIT_LIMIT = 900;
const DELAY_MS = 270;

const SHOPS_SET_1 = [
    { id: 'ozon', name: 'Ozon', marketplace: 'ozon', shop_id: '139080' },
    { id: 'wb', name: 'WB FBS', marketplace: 'wildberries', shop_id: '84250' },
    { id: 'ym', name: 'Альмамед (ЯМ FBS)', marketplace: 'yandex', shop_id: '22155238' },
];
const SHOPS_SET_2 = [
    { id: 'ozon_fbo', name: 'Ozon FBO', marketplace: 'ozon', shop_id: '139080_FBO' },
    { id: 'wb_fbs', name: 'WB FBW/FBS', marketplace: 'wildberries', shop_id: '84250_FBO' },
    { id: 'ym_fbs', name: 'Альмамед (ЯМ FBS) РРЦ', marketplace: 'yandex', shop_id: '22155238_2' },
];

function getRepricerField(obj, camel, pascal) {
    if (obj == null || typeof obj !== 'object') return undefined;
    if (Object.prototype.hasOwnProperty.call(obj, camel) && obj[camel] !== undefined) return obj[camel];
    if (Object.prototype.hasOwnProperty.call(obj, pascal) && obj[pascal] !== undefined) return obj[pascal];
    return undefined;
}

function normalizeShop(item) {
    const src = item || {};
    const out = {
        id: String(src.id || '').trim(),
        name: String(src.name || '').trim(),
        marketplace: String(src.marketplace || '').trim().toLowerCase(),
        shop_id: String(src.shop_id || '').trim(),
    };
    if (!out.id || !out.name || !out.marketplace || !out.shop_id) return null;
    if (!['ozon', 'wildberries', 'yandex'].includes(out.marketplace)) return null;
    return out;
}

function parseShopsJson(raw, fallback) {
    try {
        const arr = JSON.parse(String(raw || '[]'));
        if (!Array.isArray(arr)) return fallback;
        const parsed = arr.map(normalizeShop).filter(Boolean);
        return parsed.length ? parsed : fallback;
    } catch (_) {
        return fallback;
    }
}

function extractRepricerAltMatchIds(x, uid) {
    const u = String(uid || '').trim();
    const seen = new Set();
    const out = [];
    function add(v) {
        if (v == null || v === '') return;
        const s =
            typeof v === 'number' && Number.isFinite(v)
                ? String(Number.isInteger(v) ? v : Math.trunc(v))
                : String(v).trim();
        if (!s || s === u) return;
        if (seen.has(s)) return;
        seen.add(s);
        out.push(s);
    }
    const pairs = [
        ['offer_id', 'OfferId'],
        ['offerId', 'OfferId'],
        ['marketplace_offer_id', 'MarketplaceOfferId'],
        ['shop_sku', 'ShopSku'],
        ['item_id', 'ItemId'],
        ['article', 'Article'],
        ['yandex_offer_id', 'YandexOfferId'],
    ];
    for (const [camel, pascal] of pairs) {
        const v = getRepricerField(x, camel, pascal);
        if (v !== undefined && v !== null) add(v);
    }
    return out;
}

function isIncludedRepricerItem(p) {
    if (!p || typeof p !== 'object') return false;
    const uid = String(getRepricerField(p, 'uid', 'Uid') ?? '').trim();
    if (!uid) return false;
    const en = getRepricerField(p, 'enabled', 'Enabled');
    if (en === false || en === 0 || String(en).toLowerCase() === 'false') return false;
    return true;
}

function extractUnitSetDisplayName(st, setId) {
    const raw =
        getRepricerField(st, 'set_name', 'SetName') ??
        getRepricerField(st, 'name', 'Name') ??
        getRepricerField(st, 'title', 'Title') ??
        '';
    const n = String(raw || '').trim();
    if (n) return n;
    const id = String(setId || '').trim();
    return id ? `#${id}` : '';
}

function unitSetRowMatchesShop(st, shop) {
    const sm = String(st.marketplace || '').toLowerCase();
    const sid = String(st.shop_id || '').trim();
    const shopMp = String(shop.marketplace || '').toLowerCase();
    const shopId = String(shop.shop_id || '').trim();
    if (sm && shopMp && sm !== shopMp) return false;
    if (!sid || !shopId) return true;
    if (sid === shopId) return true;
    const a = sid.length <= shopId.length ? sid : shopId;
    const b = sid.length <= shopId.length ? shopId : sid;
    if (b.startsWith(`${a}_`)) return true;
    return false;
}

function makeSet1OnlineCalculatorUnitFilter() {
    return (st) => {
        const nm = String(
            getRepricerField(st, 'set_name', 'SetName') ??
                getRepricerField(st, 'name', 'Name') ??
                getRepricerField(st, 'title', 'Title') ??
                ''
        )
            .trim()
            .toLowerCase();
        const hasOnline = nm.includes('онлайн') || nm.includes('он-лайн') || nm.includes('online');
        const hasCalc = nm.includes('калькулятор') || nm.includes('calculator');
        return hasOnline && hasCalc;
    };
}

async function sleep(ms) {
    await new Promise((r) => setTimeout(r, ms));
}

async function hucksterMd5(password) {
    const r = await axios.post(
        'https://wbs.e-teleport.ru/md5',
        { input: password },
        { timeout: 30000, headers: { Accept: 'application/json', 'Content-Type': 'application/json' } }
    );
    return String(r.data || '').trim().replace(/^"|"$/g, '');
}

async function hucksterAuth(email, passwordPlain) {
    const md5 = await hucksterMd5(passwordPlain);
    const r = await axios.post(
        'https://wbs.e-teleport.ru/auth/credentials',
        { userName: email, password: md5 },
        { timeout: 30000, headers: { Accept: 'application/json', 'Content-Type': 'application/json' } }
    );
    const sessionId = r && r.data && r.data.SessionId ? String(r.data.SessionId) : '';
    if (!sessionId) throw new Error('Не получен SessionId Huckster');
    return sessionId;
}

async function loadCredsFromDb(pool) {
    const keys = ['huckster_email', 'huckster_password', 'huckster_shops_set_1', 'huckster_shops_set_2'];
    const [rows] = await pool.query(
        `SELECT setting_key, setting_value FROM app_settings WHERE setting_key IN (${keys.map(() => '?').join(',')})`,
        keys
    );
    const map = {};
    for (const row of rows || []) {
        map[row.setting_key] = row.setting_value != null ? String(row.setting_value) : '';
    }
    return {
        email: (map.huckster_email || '').trim(),
        password: map.huckster_password || '',
        set1Json: map.huckster_shops_set_1 || '[]',
        set2Json: map.huckster_shops_set_2 || '[]',
    };
}

function itemUid(it) {
    return String(
        getRepricerField(it, 'uid', 'Uid') ?? it.item_id ?? getRepricerField(it, 'item_id', 'ItemId') ?? ''
    ).trim();
}

async function findInRepricer(sessionId, shop, targetUid) {
    const headers = {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Cookie: `ss-id=${sessionId}`,
    };
    let offset = 0;
    for (;;) {
        const r = await axios.post(
            'https://wbs.e-teleport.ru/markets/integrations/repricer/items/list',
            {
                marketplace: shop.marketplace,
                shop_id: shop.shop_id,
                limit: REPRICER_LIMIT,
                offset,
            },
            { timeout: 60000, headers }
        );
        const data = r && r.data ? r.data : {};
        if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
        const list = Array.isArray(data.result) ? data.result : [];
        const cur = data.cursor || {};
        for (const p of list) {
            if (!isIncludedRepricerItem(p)) continue;
            const uid = String(getRepricerField(p, 'uid', 'Uid') ?? '').trim();
            const alts = extractRepricerAltMatchIds(p, uid);
            if (uid === targetUid || alts.includes(targetUid)) {
                return {
                    hit: true,
                    uid,
                    alts,
                    enabled: getRepricerField(p, 'enabled', 'Enabled'),
                    name: String(getRepricerField(p, 'name', 'Name') ?? '').trim(),
                    rawKeys: Object.keys(p).slice(0, 40),
                };
            }
        }
        const pageLen = list.length;
        if (!pageLen) break;
        offset += pageLen;
        if (pageLen < REPRICER_LIMIT) {
            const totalN = Number(cur.total);
            if (!(Number.isFinite(totalN) && offset < totalN)) break;
        }
        await sleep(DELAY_MS);
    }
    return { hit: false };
}

async function scanUnitSetsOnce(sessionId, shop, targetUid, sets) {
    const headers = {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Cookie: `ss-id=${sessionId}`,
    };
    const hits = [];
    for (const st of sets) {
        if (!unitSetRowMatchesShop(st, shop)) continue;
        const setId = String(st.id != null ? st.id : st.set_id != null ? st.set_id : '').trim();
        if (!setId) continue;
        const setLabel = extractUnitSetDisplayName(st, setId);
        let offset = 0;
        for (;;) {
            const gr = await axios.post(
                'https://wbs.e-teleport.ru/markets/integrations/unit/set/get',
                {
                    marketplace: shop.marketplace,
                    shop_id: shop.shop_id,
                    set_id: setId,
                    limit: UNIT_LIMIT,
                    offset,
                },
                { timeout: 60000, headers }
            );
            const gp = gr.data || {};
            if (gp.error) {
                console.warn(`  unit/set/get error set_id=${setId}:`, gp.error.message || gp.error);
                break;
            }
            const res = gp.result || {};
            const itemList = Array.isArray(res.item_list) ? res.item_list : [];
            const cur = res.cursor || {};
            const total = Number(cur.total);
            const found = itemList.find((it) => itemUid(it) === targetUid);
            if (found) {
                hits.push({
                    set_id: setId,
                    set_name: setLabel,
                    item_name: String(getRepricerField(found, 'name', 'Name') ?? '').trim(),
                });
                break;
            }
            if (!itemList.length) break;
            offset += itemList.length;
            if (itemList.length < UNIT_LIMIT) {
                if (!(Number.isFinite(total) && offset < total)) break;
            }
            await sleep(DELAY_MS);
        }
        await sleep(DELAY_MS);
    }
    return hits;
}

async function scanUnitSets(sessionId, shop, targetUid, setNum) {
    const headers = {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Cookie: `ss-id=${sessionId}`,
    };
    const listRes = await axios.post(
        'https://wbs.e-teleport.ru/markets/integrations/unit/set/list',
        { marketplace: shop.marketplace, shop_id: shop.shop_id },
        { timeout: 60000, headers }
    );
    const lp = listRes.data || {};
    if (lp.error) throw new Error(lp.error.message || JSON.stringify(lp.error));
    const res0 = lp.result || {};
    const setList = Array.isArray(res0.set_list) ? res0.set_list : [];
    const forShop = setList.filter((st) => unitSetRowMatchesShop(st, shop));
    const set1Filter = makeSet1OnlineCalculatorUnitFilter();
    const strictFiltered = forShop.filter((st) => set1Filter(st));
    const exportSets =
        setNum === 1 ? (strictFiltered.length > 0 ? strictFiltered : forShop) : forShop;

    const hitsAll = await scanUnitSetsOnce(sessionId, shop, targetUid, forShop);
    let hitsMatrix;
    if (setNum === 1 && exportSets !== forShop) {
        hitsMatrix = await scanUnitSetsOnce(sessionId, shop, targetUid, exportSets);
    } else {
        hitsMatrix = hitsAll;
    }

    return {
        set_count_total: forShop.length,
        set_count_strict_online_calc: strictFiltered.length,
        set_count_used_like_datagon_export: exportSets.length,
        hits_any_unit_set: hitsAll,
        hits_matrix_equivalent: hitsMatrix,
    };
}

async function main() {
    const argv = process.argv.slice(2);
    let targetUid = '3110';
    let setNum = 1;
    let mpFilter = '';
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--set' && argv[i + 1]) {
            setNum = Number(argv[i + 1]);
            i += 1;
        } else if (argv[i] === '--mp' && argv[i + 1]) {
            mpFilter = String(argv[i + 1]).trim().toLowerCase();
            i += 1;
        } else if (!argv[i].startsWith('-')) {
            targetUid = String(argv[i]).trim();
        }
    }

    const email = String(process.env.HUCKSTER_EMAIL || '').trim();
    const passwordEnv = process.env.HUCKSTER_PASSWORD || '';

    const pool = mysql.createPool({
        host: config.db.host,
        user: config.db.user,
        password: config.db.password,
        database: config.db.database,
        waitForConnections: true,
        connectionLimit: 2,
    });

    let password = passwordEnv;
    let shops;
    try {
        const fromDb = await loadCredsFromDb(pool);
        const em = email || fromDb.email;
        password = password || fromDb.password;
        const rawJson = setNum === 2 ? fromDb.set2Json : fromDb.set1Json;
        shops = parseShopsJson(rawJson, setNum === 2 ? SHOPS_SET_2 : SHOPS_SET_1);
        if (!em || !password) {
            console.error('Нужны HUCKSTER_EMAIL и HUCKSTER_PASSWORD в env или в app_settings.');
            process.exitCode = 2;
            return;
        }
        console.log('Wiki: POST /md5, POST /auth/credentials → SessionId');
        console.log('Wiki §4: POST /markets/integrations/repricer/items/list');
        console.log('Wiki §13–14: POST /markets/integrations/unit/set/list + unit/set/get');
        console.log('');
        console.log('UID:', targetUid, '| набор:', setNum === 2 ? 'set2 (RRC)' : 'set1 (Export)', '| кабинеты:', shops.length);

        const sessionId = await hucksterAuth(em, password);
        console.log('Аутентификация: OK (Cookie ss-id для последующих POST)\n');

        const toProbe = mpFilter ? shops.filter((s) => s.marketplace === mpFilter) : shops;

        if (!toProbe.length) {
            console.error('Нет кабинетов для marketplace=', mpFilter);
            process.exitCode = 2;
            return;
        }

        for (const shop of toProbe) {
            console.log('--- Кабинет', shop.name, '|', shop.marketplace, '| shop_id', shop.shop_id, '---');
            const rep = await findInRepricer(sessionId, shop, targetUid);
            console.log('repricer/items/list:', rep.hit ? 'НАЙДЕН' : 'НЕ найден', rep.hit ? JSON.stringify(rep, null, 2) : '');
            await sleep(DELAY_MS);
            const unit = await scanUnitSets(sessionId, shop, targetUid, setNum);
            console.log('unit/set/list: наборов по кабинету:', unit.set_count_total);
            if (setNum === 1) {
                console.log('  строго «онлайн»+«калькулятор» в названии:', unit.set_count_strict_online_calc);
                console.log('  наборов как у Datagon Export (строгий или fallback все):', unit.set_count_used_like_datagon_export);
            }
            console.log('  UID в ЛЮБОМ unit-наборе:', unit.hits_any_unit_set.length ? JSON.stringify(unit.hits_any_unit_set, null, 2) : 'НЕТ');
            console.log(
                '  UID в наборах как у матрицы Export:',
                unit.hits_matrix_equivalent.length ? JSON.stringify(unit.hits_matrix_equivalent, null, 2) : 'НЕТ'
            );
            console.log('');
        }
    } finally {
        await pool.end();
    }
}

main().catch((e) => {
    console.error(e && e.response && e.response.data ? JSON.stringify(e.response.data) : e.message || e);
    process.exitCode = 1;
});
