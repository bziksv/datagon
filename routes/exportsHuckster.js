'use strict';

const express = require('express');
const axios = require('axios');
const { saveHucksterSnapshot, loadHucksterSnapshot, clearHucksterSnapshot } = require('../lib/hucksterSnapshotStore');
const { fetchMsExportBridgeCandidates, buildMsHucksterBridgeExport } = require('../lib/hucksterMsBridgeMatrix');

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

/** Wiki Huckster: repricer/unit list limit до 1000 — страница на 10% меньше (900). Пауза между страницами −10% от прежних 300/150 мс. */
const HUCKSTER_REPRICER_PAGE_LIMIT = 900;
const HUCKSTER_UNIT_PAGE_LIMIT = 900;
const HUCKSTER_DELAY_MS_DEFAULT = 270;
const HUCKSTER_DELAY_MS_MIN = 135;

/**
 * Набор 1 (Huckster Export): в матрице учитываем только модели Unit с названием «онлайн» + «калькулятор»
 * (см. wiki unit/set/list — поле set_name). Если ни одна модель не подошла — предупреждение в лог и учёт всех наборов (fallback).
 */
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

function parseUidList(raw) {
    const src = Array.isArray(raw) ? raw : String(raw || '').split(/[,\s;]+/);
    const out = [];
    const seen = new Set();
    for (const v of src) {
        const u = String(v == null ? '' : v).trim();
        if (!u || seen.has(u)) continue;
        seen.add(u);
        out.push(u);
    }
    return out;
}

function authHeaders(req) {
    const headers = { Accept: 'application/json' };
    const actor = req.datagonActor;
    if (actor && actor.username) headers['x-auth-username'] = actor.username;
    if (actor && actor.auth_token) headers['x-auth-token'] = actor.auth_token;
    return headers;
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
    if (!sessionId) throw new Error('Не получен SessionId Huckster');
    return sessionId;
}

/** Поля ответа e-teleport могут быть в camelCase или PascalCase (ServiceStack). */
function getRepricerField(obj, camel, pascal) {
    if (obj == null || typeof obj !== 'object') return undefined;
    if (Object.prototype.hasOwnProperty.call(obj, camel) && obj[camel] !== undefined) return obj[camel];
    if (Object.prototype.hasOwnProperty.call(obj, pascal) && obj[pascal] !== undefined) return obj[pascal];
    return undefined;
}

function isExplicitlyOff(v) {
    return v === false || v === 0 || v === '0' || String(v).toLowerCase() === 'false';
}

function isExplicitlyOn(v) {
    return v === true || v === 1 || v === '1' || String(v).toLowerCase() === 'true';
}

/** Позиция попадает в матрицу, если API не помечает её как выключенную/удалённую. */
function isIncludedRepricerItem(p) {
    if (!p || typeof p !== 'object') return false;
    const uid = String(getRepricerField(p, 'uid', 'Uid') ?? '').trim();
    if (!uid) return false;

    if (isExplicitlyOff(getRepricerField(p, 'is_enabled', 'IsEnabled'))) return false;
    if (isExplicitlyOff(getRepricerField(p, 'enabled', 'Enabled'))) return false;
    if (isExplicitlyOff(getRepricerField(p, 'active', 'Active'))) return false;
    if (isExplicitlyOff(getRepricerField(p, 'visible', 'Visible'))) return false;
    if (isExplicitlyOff(getRepricerField(p, 'is_visible', 'IsVisible'))) return false;
    if (isExplicitlyOff(getRepricerField(p, 'is_available', 'IsAvailable'))) return false;
    if (isExplicitlyOff(getRepricerField(p, 'available', 'Available'))) return false;

    if (getRepricerField(p, 'deleted', 'Deleted') === true) return false;
    if (getRepricerField(p, 'is_deleted', 'IsDeleted') === true) return false;

    const statusRaw = getRepricerField(p, 'status', 'Status') ?? getRepricerField(p, 'state', 'State');
    const st = String(statusRaw == null ? '' : statusRaw).toLowerCase();
    if (['disabled', 'archived', 'deleted', 'removed', 'inactive', 'hidden', 'blocked', 'off'].includes(st)) return false;

    if (isExplicitlyOn(getRepricerField(p, 'is_enabled', 'IsEnabled'))) return true;
    if (isExplicitlyOn(getRepricerField(p, 'enabled', 'Enabled'))) return true;
    if (isExplicitlyOn(getRepricerField(p, 'active', 'Active'))) return true;
    if (['enabled', 'active', 'visible', 'on', 'ok'].includes(st)) return true;

    /* Часто в списке только активные строки без флагов — не отбрасываем. */
    return true;
}

/** Дата/время изменения позиции из ответа repricer (если API отдаёт). */
function extractItemUpdatedAt(x) {
    if (!x || typeof x !== 'object') return '';
    const raw =
        getRepricerField(x, 'updated_at', 'UpdatedAt') ??
        getRepricerField(x, 'modified_at', 'ModifiedAt') ??
        getRepricerField(x, 'last_update', 'LastUpdate') ??
        getRepricerField(x, 'changed_at', 'ChangedAt') ??
        getRepricerField(x, 'parsed_at', 'ParsedAt');
    if (raw == null || raw === '') return '';
    if (typeof raw === 'number' && Number.isFinite(raw)) {
        const ms = raw > 1e12 ? raw : raw * 1000;
        const d = new Date(ms);
        return Number.isNaN(d.getTime()) ? '' : d.toISOString();
    }
    const d = new Date(String(raw));
    return Number.isNaN(d.getTime()) ? String(raw) : d.toISOString();
}

function makeStoppedError() {
    const err = new Error('Обновление Huckster остановлено пользователем');
    err.code = 'HUCKSTER_STOPPED';
    return err;
}

function throwIfStopped(isStopped) {
    if (typeof isStopped === 'function' && isStopped()) {
        throw makeStoppedError();
    }
}

/** Только repricer/items/list по одному магазину (без Unit-моделей). Все позиции с uid; «включён в репрайсер» — отдельное поле (раньше выключенные отбрасывались). */
async function fetchRepricerProductsForShop(shop, sessionId, opts, isStopped) {
    /** @type {Map<string, { uid: string, name: string, updatedAt: string, repricerEnabled: boolean }>} */
    const byUid = new Map();
    let offset = 0;
    const limit = HUCKSTER_REPRICER_PAGE_LIMIT;
    const maxOffset = Math.max(0, Number(opts.max_offset_per_shop || 0));
    const delayMs = Math.max(HUCKSTER_DELAY_MS_MIN, Number(opts.delay_ms || HUCKSTER_DELAY_MS_DEFAULT));
    const uidFilter = opts.uid_filter instanceof Set ? opts.uid_filter : null;
    const foundFiltered = new Set();

    while (maxOffset === 0 || offset < maxOffset) {
        throwIfStopped(isStopped);
        const r = await axios.post(
            'https://wbs.e-teleport.ru/markets/integrations/repricer/items/list',
            { marketplace: shop.marketplace, shop_id: shop.shop_id, limit, offset },
            {
                timeout: 120000,
                headers: {
                    Accept: 'application/json',
                    'Content-Type': 'application/json',
                    Cookie: `ss-id=${sessionId}`,
                },
            }
        );
        const payload = r && r.data ? r.data : {};
        if (payload.error) throw new Error(payload.error.message || JSON.stringify(payload.error));
        const rows = Array.isArray(payload.result) ? payload.result : [];
        for (const x of rows) {
            const uid = String(getRepricerField(x, 'uid', 'Uid') || '').trim();
            if (!uid) continue;
            if (uidFilter && !uidFilter.has(uid)) continue;
            if (uidFilter) foundFiltered.add(uid);
            byUid.set(uid, {
                uid,
                name: String(getRepricerField(x, 'name', 'Name') || ''),
                updatedAt: extractItemUpdatedAt(x),
                repricerEnabled: isIncludedRepricerItem(x),
            });
        }
        if (uidFilter && foundFiltered.size >= uidFilter.size) break;
        offset += limit;
        if (rows.length < limit) break;
        throwIfStopped(isStopped);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    return Array.from(byUid.values());
}

/** Дописать inUnitModel и названия Unit-наборов к уже загруженному списку repricer. `unitSetFilter` — только наборы list, для которых вернётся true (например только «Онлайн калькулятор» для Export). */
async function enrichProductsWithUnitModels(shop, sessionId, products, opts, isStopped, unitSetFilter) {
    throwIfStopped(isStopped);
    let info = null;
    try {
        info = await fetchAllUnitModelInfo(shop, sessionId, opts, isStopped, unitSetFilter);
    } catch (e) {
        console.warn('[huckster] unit economy models:', e && e.message ? e.message : e);
        info = null;
    }
    const list = Array.isArray(products) ? products : [];
    return list.map((p) => {
        const uid = String(p.uid || '');
        let inUnit = null;
        let unitModelNames = '';
        if (info != null) {
            inUnit = info.uidSet.has(uid);
            const ns = info.uidToNames.get(uid);
            unitModelNames =
                ns && ns.size > 0
                    ? Array.from(ns).sort((a, b) => a.localeCompare(b, 'ru', { numeric: true })).join('; ')
                    : '';
        }
        return {
            ...p,
            inUnitModel: inUnit,
            unitModelNames,
        };
    });
}

/** Один магазин: repricer, затем Unit (для совместимости; фоновый sync идёт в два прохода по всем магазинам). */
async function fetchAllProducts(shop, sessionId, opts, isStopped) {
    const base = await fetchRepricerProductsForShop(shop, sessionId, opts, isStopped);
    return enrichProductsWithUnitModels(shop, sessionId, base, opts, isStopped);
}

/** Строка набора unit API относится к тому же кабинету, что и в конфиге (в т.ч. варианты shop_id с суффиксом _FBO). */
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

/** Человекочитаемое имя набора Unit из строки unit/set/list (wiki: set_name). */
function extractUnitSetDisplayName(st, setId) {
    const raw =
        getRepricerField(st, 'set_name', 'SetName') ??
        getRepricerField(st, 'name', 'Name') ??
        getRepricerField(st, 'title', 'Title') ??
        getRepricerField(st, 'label', 'Label') ??
        '';
    const n = String(raw || '').trim();
    if (n) return n;
    const id = String(setId || '').trim();
    return id ? `#${id}` : '';
}

/**
 * UID → множество названий наборов Unit; плюс множество всех uid в моделях (см. unit/set/list + unit/set/get).
 * @param {(st: object) => boolean} [unitSetFilter] — если задан, обрабатываются только строки set_list, для которых filter(st) === true.
 * @returns {{ uidSet: Set<string>, uidToNames: Map<string, Set<string>> }}
 */
async function fetchAllUnitModelInfo(shop, sessionId, opts, isStopped, unitSetFilter) {
    const uidSet = new Set();
    const uidToNames = new Map();
    const delayMs = Math.max(HUCKSTER_DELAY_MS_MIN, Number(opts.delay_ms || HUCKSTER_DELAY_MS_DEFAULT));
    const limitGet = HUCKSTER_UNIT_PAGE_LIMIT;
    const uidFilter = opts.uid_filter instanceof Set ? opts.uid_filter : null;
    const foundFiltered = new Set();
    const headers = {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Cookie: `ss-id=${sessionId}`,
    };

    function noteUidInSet(uid, setLabel) {
        const u = String(uid || '').trim();
        if (!u) return;
        if (uidFilter && !uidFilter.has(u)) return;
        uidSet.add(u);
        if (uidFilter) foundFiltered.add(u);
        const label = String(setLabel || '').trim() || `#`;
        if (!uidToNames.has(u)) uidToNames.set(u, new Set());
        uidToNames.get(u).add(label);
    }

    throwIfStopped(isStopped);
    const listRes = await axios.post(
        'https://wbs.e-teleport.ru/markets/integrations/unit/set/list',
        { marketplace: shop.marketplace, shop_id: shop.shop_id },
        { timeout: 120000, headers }
    );
    const listPayload = listRes && listRes.data ? listRes.data : {};
    if (listPayload.error) {
        throw new Error(listPayload.error.message || JSON.stringify(listPayload.error));
    }
    const res0 = listPayload.result || {};
    let setList = Array.isArray(res0.set_list) ? res0.set_list : [];
    if (typeof unitSetFilter === 'function') {
        const forShop = setList.filter((st) => unitSetRowMatchesShop(st, shop));
        const filtered = forShop.filter((st) => unitSetFilter(st));
        if (filtered.length === 0 && forShop.length > 0) {
            console.warn(
                '[huckster] unit/set/list: фильтр моделей не совпал ни с одним набором (%s / %s) — учитываем все наборы кабинета.',
                shop.marketplace,
                shop.shop_id
            );
            setList = forShop;
        } else {
            setList = filtered;
        }
    }

    for (const st of setList) {
        throwIfStopped(isStopped);
        if (!unitSetRowMatchesShop(st, shop)) continue;

        const setId = String(st.id != null ? st.id : st.set_id != null ? st.set_id : '').trim();
        if (!setId) continue;
        const setLabel = extractUnitSetDisplayName(st, setId);

        let offset = 0;
        /* eslint-disable no-await-in-loop */
        for (;;) {
            throwIfStopped(isStopped);
            const gr = await axios.post(
                'https://wbs.e-teleport.ru/markets/integrations/unit/set/get',
                {
                    marketplace: shop.marketplace,
                    shop_id: shop.shop_id,
                    set_id: setId,
                    limit: limitGet,
                    offset,
                },
                { timeout: 120000, headers }
            );
            const gp = gr && gr.data ? gr.data : {};
            if (gp.error) {
                console.warn(
                    '[huckster] unit/set/get set_id=%s: %s',
                    setId,
                    gp.error.message || JSON.stringify(gp.error)
                );
                break;
            }
            const res = gp.result || {};
            const itemList = Array.isArray(res.item_list) ? res.item_list : [];
            const cur = res.cursor || {};
            const total = Number(cur.total);

            for (const it of itemList) {
                const u = String(
                    getRepricerField(it, 'uid', 'Uid') ??
                        it.item_id ??
                        getRepricerField(it, 'item_id', 'ItemId') ??
                        ''
                ).trim();
                if (u) noteUidInSet(u, setLabel);
            }

            if (uidFilter && foundFiltered.size >= uidFilter.size) break;
            if (!itemList.length) break;
            offset += limitGet;
            if (itemList.length < limitGet) break;
            if (Number.isFinite(total) && offset >= total) break;
            throwIfStopped(isStopped);
            await new Promise((r) => setTimeout(r, delayMs));
        }
        /* eslint-enable no-await-in-loop */
        if (uidFilter && foundFiltered.size >= uidFilter.size) break;
    }
    return { uidSet, uidToNames };
}

function createExportsHucksterRouter(_db, appSettings) {
    const router = express.Router();
    const syncState = {
        active: false,
        started_at: null,
        finished_at: null,
        stop_requested: false,
        status_text: 'Готов к обновлению.',
        progress: {
            total_shops: 0,
            done_shops: 0,
            current_shop_id: '',
            current_shop_name: '',
            current_set: '',
        },
        result: null,
        error: null,
    };

    function getConfiguredSets() {
        const set1 = parseShopsJson(appSettings.huckster_shops_set_1, SHOPS_SET_1);
        const set2 = parseShopsJson(appSettings.huckster_shops_set_2, SHOPS_SET_2);
        return { set1, set2 };
    }

    /** Запуск фоновой синхронизации (из POST /sync или из планировщика server.js). */
    function tryStartHucksterSync(body) {
        const bodyObj = body || {};
        if (syncState.active) {
            return { ok: false, code: 'ALREADY_RUNNING' };
        }
        const email = String(bodyObj.email || process.env.HUCKSTER_EMAIL || appSettings.huckster_email || '').trim();
        const password = String(
            bodyObj.password || process.env.HUCKSTER_PASSWORD || appSettings.huckster_password || ''
        ).trim();
        if (!email || !password) {
            return { ok: false, code: 'MISSING_CREDS' };
        }
        const testUids = parseUidList(bodyObj.test_uids || bodyObj.uids || bodyObj.uid_list);
        const opts = {
            max_offset_per_shop: Number(bodyObj.max_offset_per_shop || appSettings.huckster_max_offset_per_shop || 0),
            delay_ms: Math.max(
                HUCKSTER_DELAY_MS_MIN,
                Number(bodyObj.delay_ms || appSettings.huckster_delay_ms || HUCKSTER_DELAY_MS_DEFAULT)
            ),
            test_uids: testUids,
            uid_filter: testUids.length ? new Set(testUids) : null,
        };
        const cfg = getConfiguredSets();
        const allShops = []
            .concat(cfg.set1.map((shop) => ({ set: 'set1', shop })))
            .concat(cfg.set2.map((shop) => ({ set: 'set2', shop })));
        syncState.active = true;
        syncState.stop_requested = false;
        syncState.started_at = new Date().toISOString();
        syncState.finished_at = null;
        syncState.error = null;
        syncState.result = null;
        syncState.status_text = opts.test_uids.length
            ? `Аутентификация Huckster (тест UID: ${opts.test_uids.join(', ')})...`
            : 'Аутентификация Huckster...';
        const shopCount = allShops.length;
        syncState.progress = {
            total_shops: shopCount * 2,
            done_shops: 0,
            current_shop_id: '',
            current_shop_name: '',
            current_set: '',
        };

        (async () => {
            try {
                throwIfStopped(() => syncState.stop_requested);
                const sessionId = await hucksterAuth(email, password);
                const set1Items = {};
                const set2Items = {};
                /* Фаза 1: repricer по всем магазинам обоих наборов, затем фаза 2: Unit-модели везде; матрицы — только в конце. */
                for (const item of allShops) {
                    throwIfStopped(() => syncState.stop_requested);
                    const setLabel = item.set === 'set1' ? 'Huckster Export' : 'Huckster Export RRC';
                    syncState.progress.current_shop_id = item.shop.id;
                    syncState.progress.current_shop_name = item.shop.name;
                    syncState.progress.current_set = item.set;
                    syncState.status_text = `Repricer — ${item.shop.name} (${setLabel})...`;
                    const rows = await fetchRepricerProductsForShop(
                        item.shop,
                        sessionId,
                        opts,
                        () => syncState.stop_requested
                    );
                    if (item.set === 'set1') set1Items[item.shop.id] = rows;
                    else set2Items[item.shop.id] = rows;
                    syncState.progress.done_shops += 1;
                }
                for (const item of allShops) {
                    throwIfStopped(() => syncState.stop_requested);
                    const setLabel = item.set === 'set1' ? 'Huckster Export' : 'Huckster Export RRC';
                    syncState.progress.current_shop_id = item.shop.id;
                    syncState.progress.current_shop_name = item.shop.name;
                    syncState.progress.current_set = item.set;
                    syncState.status_text = `Unit-модели — ${item.shop.name} (${setLabel})...`;
                    const bucket = item.set === 'set1' ? set1Items : set2Items;
                    const raw = bucket[item.shop.id];
                    const set1UnitFilter = makeSet1OnlineCalculatorUnitFilter();
                    bucket[item.shop.id] = await enrichProductsWithUnitModels(
                        item.shop,
                        sessionId,
                        raw,
                        opts,
                        () => syncState.stop_requested,
                        item.set === 'set1' ? set1UnitFilter : null
                    );
                    syncState.progress.done_shops += 1;
                }
                const syncedAt = new Date().toISOString();
                let msBridgeRows = [];
                try {
                    if (typeof _db?.query === 'function') {
                        msBridgeRows = await fetchMsExportBridgeCandidates(_db);
                        if (opts.uid_filter) {
                            msBridgeRows = msBridgeRows.filter((r) => opts.uid_filter.has(String(r.code || '').trim()));
                        }
                    }
                } catch (eMs) {
                    console.warn('[huckster] ms bridge rows:', eMs && eMs.message ? eMs.message : eMs);
                }
                const set1 = buildMsHucksterBridgeExport(cfg.set1, set1Items, msBridgeRows, syncedAt);
                const set2 = buildMsHucksterBridgeExport(cfg.set2, set2Items, msBridgeRows, syncedAt);
                syncState.error = null;
                syncState.result = {
                    success: true,
                    updated_at: syncedAt,
                    test_uids: opts.test_uids,
                    sheet_export: set1,
                    sheet_export_rrc: set2,
                };
                syncState.status_text = opts.test_uids.length
                    ? `Тест Huckster завершён: ${opts.test_uids.join(', ')}.`
                    : 'Обновление Huckster завершено.';
                if (!opts.test_uids.length) {
                    try {
                        await saveHucksterSnapshot(_db, syncState.result);
                    } catch (saveErr) {
                        console.error('[huckster] snapshot save:', saveErr && saveErr.message ? saveErr.message : saveErr);
                    }
                }
            } catch (e) {
                if (e && e.code === 'HUCKSTER_STOPPED') {
                    syncState.error = { code: 'HUCKSTER_STOPPED', error: e.message || 'Остановлено пользователем' };
                    syncState.status_text = 'Обновление Huckster остановлено.';
                } else {
                    syncState.error = {
                        code: 'HUCKSTER_SYNC_FAILED',
                        error: e && e.message ? e.message : String(e),
                    };
                    syncState.status_text = 'Ошибка обновления Huckster.';
                }
            } finally {
                syncState.active = false;
                syncState.stop_requested = false;
                syncState.finished_at = new Date().toISOString();
                syncState.progress.current_shop_id = '';
                syncState.progress.current_shop_name = '';
                syncState.progress.current_set = '';
            }
        })();

        return { ok: true, started: true, started_at: syncState.started_at };
    }

    createExportsHucksterRouter.triggerSync = async function triggerHucksterSyncFromSchedule() {
        const r = tryStartHucksterSync({});
        if (!r.ok) {
            if (r.code === 'ALREADY_RUNNING') return { started: false, reason: 'already_running' };
            if (r.code === 'MISSING_CREDS') return { started: false, reason: 'missing_creds' };
            return { started: false, reason: r.code || 'unknown' };
        }
        return { started: true, started_at: r.started_at };
    };
    createExportsHucksterRouter.getSyncState = function getHucksterSyncState() {
        return { active: syncState.active };
    };

    router.use((req, res, next) => {
        if (!req.datagonActor) return res.status(401).json({ error: 'Не авторизован', code: 'AUTH_REQUIRED' });
        return next();
    });

    router.post('/sync', async (req, res) => {
        try {
            const r = tryStartHucksterSync(req.body || {});
            if (!r.ok && r.code === 'ALREADY_RUNNING') {
                return res.status(409).json({
                    success: false,
                    started: false,
                    code: 'ALREADY_RUNNING',
                    error: 'Обновление Huckster уже выполняется',
                });
            }
            if (!r.ok && r.code === 'MISSING_CREDS') {
                return res.status(400).json({ error: 'Не заданы email/password Huckster', code: 'MISSING_CREDS' });
            }
            return res.json({ success: true, started: true, started_at: r.started_at });
        } catch (e) {
            return res.status(502).json({ error: e.message || String(e), code: 'HUCKSTER_SYNC_FAILED' });
        }
    });

    router.get('/sync-status', async (_req, res) => {
        return res.json({
            success: true,
            active: syncState.active,
            started_at: syncState.started_at,
            finished_at: syncState.finished_at,
            stop_requested: syncState.stop_requested,
            status_text: syncState.status_text,
            progress: syncState.progress,
            result: syncState.result,
            error: syncState.error,
        });
    });

    router.get('/snapshot', async (_req, res) => {
        try {
            const snap = await loadHucksterSnapshot(_db);
            if (!snap || !snap.sheet_export || !snap.sheet_export_rrc) {
                return res.json({
                    success: true,
                    source: 'snapshot',
                    empty: true,
                    updated_at: null,
                    sheet_export: { rows: [], total_uids: 0, unit_gap_shop_indexes_by_uid: {} },
                    sheet_export_rrc: { rows: [], total_uids: 0, unit_gap_shop_indexes_by_uid: {} },
                });
            }
            return res.json({
                success: true,
                source: 'snapshot',
                empty: false,
                updated_at: snap.updated_at || null,
                stored_at: snap.stored_at || null,
                sheet_export: snap.sheet_export,
                sheet_export_rrc: snap.sheet_export_rrc,
            });
        } catch (e) {
            return res.status(500).json({ success: false, error: e.message || String(e), code: 'SNAPSHOT_READ_FAILED' });
        }
    });

    /** Удалить последний успешный снапшот матриц из БД (строка `latest`). Память `sync-status.result` сбрасывается, чтобы не подтягивать старые строки. */
    router.delete('/snapshot', async (_req, res) => {
        try {
            if (typeof _db?.query !== 'function') {
                return res.status(500).json({ success: false, error: 'БД недоступна', code: 'NO_DB' });
            }
            await clearHucksterSnapshot(_db);
            syncState.result = null;
            return res.json({ success: true, cleared: true });
        } catch (e) {
            return res.status(500).json({
                success: false,
                error: e.message || String(e),
                code: 'SNAPSHOT_CLEAR_FAILED',
            });
        }
    });

    router.post('/stop', async (_req, res) => {
        if (!syncState.active) {
            return res.status(409).json({ success: false, code: 'NOT_RUNNING', error: 'Обновление Huckster не запущено' });
        }
        syncState.stop_requested = true;
        syncState.status_text = 'Запрошена остановка обновления Huckster...';
        return res.json({ success: true, stop_requested: true });
    });

    router.post('/credentials', async (req, res) => {
        try {
            const body = req.body || {};
            const email = String(body.email || '').trim();
            const password = String(body.password || '').trim();
            const delayMs = Math.max(
                HUCKSTER_DELAY_MS_MIN,
                Number(body.delay_ms || appSettings.huckster_delay_ms || HUCKSTER_DELAY_MS_DEFAULT)
            );
            const maxOffset = Math.max(0, Number(body.max_offset_per_shop || appSettings.huckster_max_offset_per_shop || 0));
            if (!email || !password) {
                return res.status(400).json({ error: 'Заполните email и password', code: 'MISSING_CREDS' });
            }
            if (typeof _db?.query !== 'function') {
                return res.status(500).json({ error: 'БД недоступна', code: 'NO_DB' });
            }
            const kv = [
                ['huckster_email', email],
                ['huckster_password', password],
                ['huckster_delay_ms', String(delayMs)],
                ['huckster_max_offset_per_shop', String(maxOffset)],
            ];
            for (const [k, v] of kv) {
                await _db.query(
                    'INSERT INTO app_settings (setting_key, setting_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE setting_value=?',
                    [k, v, v]
                );
                appSettings[k] = k.includes('delay') || k.includes('offset') ? Number(v) : v;
            }
            return res.json({ success: true });
        } catch (e) {
            return res.status(500).json({ error: e.message || String(e), code: 'SAVE_CREDS_FAILED' });
        }
    });

    router.get('/config', async (_req, res) => {
        const cfg = getConfiguredSets();
        return res.json({
            success: true,
            set1: cfg.set1,
            set2: cfg.set2,
            defaults: { set1: SHOPS_SET_1, set2: SHOPS_SET_2 },
        });
    });

    router.post('/config', async (req, res) => {
        try {
            const body = req.body || {};
            const set1Raw = Array.isArray(body.set1) ? body.set1 : [];
            const set2Raw = Array.isArray(body.set2) ? body.set2 : [];
            const set1 = set1Raw.map(normalizeShop).filter(Boolean);
            const set2 = set2Raw.map(normalizeShop).filter(Boolean);
            if (!set1.length || !set2.length) {
                return res.status(400).json({ error: 'Наборы set1/set2 должны содержать минимум по одной валидной строке', code: 'BAD_SETS' });
            }
            const set1Json = JSON.stringify(set1);
            const set2Json = JSON.stringify(set2);
            if (typeof _db?.query !== 'function') {
                return res.status(500).json({ error: 'БД недоступна', code: 'NO_DB' });
            }
            await _db.query(
                'INSERT INTO app_settings (setting_key, setting_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE setting_value=?',
                ['huckster_shops_set_1', set1Json, set1Json]
            );
            await _db.query(
                'INSERT INTO app_settings (setting_key, setting_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE setting_value=?',
                ['huckster_shops_set_2', set2Json, set2Json]
            );
            appSettings.huckster_shops_set_1 = set1Json;
            appSettings.huckster_shops_set_2 = set2Json;
            return res.json({ success: true, set1, set2 });
        } catch (e) {
            return res.status(500).json({ error: e.message || String(e), code: 'SAVE_CONFIG_FAILED' });
        }
    });

    return router;
}

module.exports = createExportsHucksterRouter;
