'use strict';

const express = require('express');
const axios = require('axios');
const fs = require('fs/promises');
const path = require('path');
const { saveHucksterSnapshot, loadHucksterSnapshot, clearHucksterSnapshot } = require('../lib/hucksterSnapshotStore');
const {
    fetchMsExportBridgeRowsAll,
    fetchMsExportBridgeCandidates,
    enrichMsRowsWithPriceType,
    fetchMoyskladPriceTypeNames,
    buildMsHucksterBridgeExport,
} = require('../lib/hucksterMsBridgeMatrix');
const { HUCKSTER_MATRIX_LOST_KIND, getHucksterSyncMeta } = require('../lib/hucksterSyncRevision');

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
const HUCKSTER_REPRICER_REQUEST_TIMEOUT_MS = 45000;
const HUCKSTER_REPRICER_RETRY_MAX = 2;
const HUCKSTER_REPRICER_SHOP_TIMEOUT_MS = 90000;
const HUCKSTER_REPRICER_SHOP_TIMEOUT_YM_SET1_MS = 180000;
const HUCKSTER_POSTPROCESS_TIMEOUT_MS = 90000;
const HUCKSTER_UNIT_REQUEST_TIMEOUT_MS = 45000;
/** ЯМ: одна страница unit/set/get часто 20–40+ с; 45s рвёт набор и обнуляет весь кабинет. */
const HUCKSTER_UNIT_REQUEST_TIMEOUT_YM_MS = 180000;
const HUCKSTER_UNIT_RETRY_MAX = 3;
const HUCKSTER_UNIT_HARD_TIMEOUT_MS = 60000;
const HUCKSTER_UNIT_HARD_TIMEOUT_YM_MS = 200000;
const HUCKSTER_UNIT_SHOP_TIMEOUT_MS = 90000;
/** ЯМ Unit: 4 набора × полная пагинация + ретраи; 300s мало. */
const HUCKSTER_UNIT_SHOP_TIMEOUT_YM_MS = 600000;
const HUCKSTER_SYNC_LOG_FILE = path.join(process.cwd(), 'logs', 'huckster-sync.log');
const HUCKSTER_SYNC_LOG_MAX_BYTES = 10 * 1024 * 1024; // 10 MB
const HUCKSTER_SYNC_LOG_ROTATE_KEEP = 5;
let hucksterLogLastRotateCheckAt = 0;

function hucksterLogLine(level, message, meta) {
    const ts = new Date().toISOString();
    const payload = meta && typeof meta === 'object' ? ` ${JSON.stringify(meta)}` : '';
    return `[${ts}] [${level}] ${message}${payload}\n`;
}

async function appendHucksterLog(level, message, meta) {
    try {
        await fs.mkdir(path.dirname(HUCKSTER_SYNC_LOG_FILE), { recursive: true });
        const now = Date.now();
        if (now - hucksterLogLastRotateCheckAt > 30 * 1000) {
            hucksterLogLastRotateCheckAt = now;
            try {
                const st = await fs.stat(HUCKSTER_SYNC_LOG_FILE);
                if (Number(st.size || 0) >= HUCKSTER_SYNC_LOG_MAX_BYTES) {
                    for (let i = HUCKSTER_SYNC_LOG_ROTATE_KEEP; i >= 1; i -= 1) {
                        const src = `${HUCKSTER_SYNC_LOG_FILE}.${i}`;
                        const dst = `${HUCKSTER_SYNC_LOG_FILE}.${i + 1}`;
                        try {
                            if (i === HUCKSTER_SYNC_LOG_ROTATE_KEEP) {
                                await fs.unlink(src);
                            } else {
                                await fs.rename(src, dst);
                            }
                        } catch (_) {}
                    }
                    try {
                        await fs.rename(HUCKSTER_SYNC_LOG_FILE, `${HUCKSTER_SYNC_LOG_FILE}.1`);
                    } catch (_) {}
                }
            } catch (_) {}
        }
        await fs.appendFile(HUCKSTER_SYNC_LOG_FILE, hucksterLogLine(level, message, meta), 'utf8');
    } catch (_) {
        // no-op: logging must not break sync flow
    }
}

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

function appSettingBool01(v) {
    if (v === true || v === 1) return true;
    if (v === false || v === 0) return false;
    const s = String(v == null ? '' : v).trim().toLowerCase();
    return s === '1' || s === 'true' || s === 'yes';
}

function bodyHasOwn(body, key) {
    return body != null && typeof body === 'object' && Object.prototype.hasOwnProperty.call(body, key);
}

async function persistMsBridgeArchiveFilters(db, bodyObj, appSettingsRef) {
    if (!bodyObj || typeof bodyObj !== 'object' || typeof db?.query !== 'function') return;
    const pairs = [];
    if (bodyHasOwn(bodyObj, 'ms_exclude_archived_bundles')) {
        pairs.push([
            'huckster_ms_exclude_archived_bundles',
            appSettingBool01(bodyObj.ms_exclude_archived_bundles) ? '1' : '0',
        ]);
    }
    if (bodyHasOwn(bodyObj, 'ms_exclude_archived_products_zero_stock')) {
        pairs.push([
            'huckster_ms_exclude_archived_products_zero_stock',
            appSettingBool01(bodyObj.ms_exclude_archived_products_zero_stock) ? '1' : '0',
        ]);
    }
    if (bodyHasOwn(bodyObj, 'ms_exclude_products_with_bundles')) {
        pairs.push([
            'huckster_ms_exclude_products_with_bundles',
            appSettingBool01(bodyObj.ms_exclude_products_with_bundles) ? '1' : '0',
        ]);
    }
    for (const [k, v] of pairs) {
        await db.query(
            'INSERT INTO app_settings (setting_key, setting_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE setting_value=?',
            [k, v, v]
        );
        appSettingsRef[k] = v === '1' ? 1 : 0;
    }
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

/**
 * Доп. идентификаторы из `repricer/items/list` для сшивки с кодом МС: когда `uid` в Huckster
 * совпадает с id оффера на МП (например Я.М. «код товара на МП»), а в МойСклад другой код/артикул.
 * Список полей — эвристика по типичным ключам DTO wbs.e-teleport.ru.
 */
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
        ['seller_sku', 'SellerSku'],
        ['external_id', 'ExternalId'],
        ['product_id', 'ProductId'],
        ['marketplace_product_id', 'MarketplaceProductId'],
        ['item_id', 'ItemId'],
        ['article', 'Article'],
        ['barcode', 'Barcode'],
        ['supplier_article', 'SupplierArticle'],
        ['vendor_code', 'VendorCode'],
        ['ms_code', 'MsCode'],
        ['yandex_offer_id', 'YandexOfferId'],
        ['ym_offer_id', 'YmOfferId'],
        ['shop_product_id', 'ShopProductId'],
    ];
    for (const [camel, pascal] of pairs) {
        const v = getRepricerField(x, camel, pascal);
        if (v !== undefined && v !== null) add(v);
    }
    return out;
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

async function withTimeout(promise, timeoutMs, timeoutMessage) {
    let timer = null;
    try {
        return await Promise.race([
            promise,
            new Promise((_, reject) => {
                timer = setTimeout(() => {
                    reject(new Error(timeoutMessage || `Timeout ${timeoutMs}ms`));
                }, timeoutMs);
            }),
        ]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

function throwIfStopped(isStopped) {
    if (typeof isStopped === 'function' && isStopped()) {
        throw makeStoppedError();
    }
}

function getRepricerShopTimeoutMs(setKey, shop) {
    const set = String(setKey || '').trim().toLowerCase();
    const shopId = String((shop && shop.id) || '').trim().toLowerCase();
    const mp = String((shop && shop.marketplace) || '').trim().toLowerCase();
    if (set === 'set1' && (shopId === 'ym' || mp === 'yandex')) {
        return HUCKSTER_REPRICER_SHOP_TIMEOUT_YM_SET1_MS;
    }
    return HUCKSTER_REPRICER_SHOP_TIMEOUT_MS;
}

function isYandexHucksterShop(shop) {
    const shopId = String((shop && shop.id) || '').trim().toLowerCase();
    const mp = String((shop && shop.marketplace) || '').trim().toLowerCase();
    return shopId === 'ym' || shopId.startsWith('ym_') || mp === 'yandex';
}

function getUnitShopTimeoutMs(shop) {
    if (isYandexHucksterShop(shop)) return HUCKSTER_UNIT_SHOP_TIMEOUT_YM_MS;
    return HUCKSTER_UNIT_SHOP_TIMEOUT_MS;
}

function getUnitRequestTimeoutMs(shop) {
    if (isYandexHucksterShop(shop)) return HUCKSTER_UNIT_REQUEST_TIMEOUT_YM_MS;
    return HUCKSTER_UNIT_REQUEST_TIMEOUT_MS;
}

function getUnitHardTimeoutMs(shop) {
    if (isYandexHucksterShop(shop)) return HUCKSTER_UNIT_HARD_TIMEOUT_YM_MS;
    return HUCKSTER_UNIT_HARD_TIMEOUT_MS;
}

/** Только repricer/items/list по одному магазину (без Unit-моделей). Все позиции с uid; «включён в репрайсер» — отдельное поле (раньше выключенные отбрасывались). */
async function fetchRepricerProductsForShop(shop, sessionId, opts, isStopped, onProgress, setActiveAbortController) {
    /** @type {Map<string, { uid: string, name: string, updatedAt: string, repricerEnabled: boolean }>} */
    const byUid = new Map();
    let offset = 0;
    const limit = HUCKSTER_REPRICER_PAGE_LIMIT;
    const maxOffset = Math.max(0, Number(opts.max_offset_per_shop || 0));
    const delayMs = Math.max(HUCKSTER_DELAY_MS_MIN, Number(opts.delay_ms || HUCKSTER_DELAY_MS_DEFAULT));
    const uidFilter = opts.uid_filter instanceof Set ? opts.uid_filter : null;
    const uidFilterLc = uidFilter
        ? new Set(Array.from(uidFilter).map((v) => String(v || '').trim().toLowerCase()).filter(Boolean))
        : null;
    const foundFiltered = new Set();
    function uidFilterHit(values) {
        if (!uidFilterLc) return true;
        for (const v of values) {
            const k = String(v || '').trim().toLowerCase();
            if (k && uidFilterLc.has(k)) return true;
        }
        return false;
    }
    async function postRepricer(payload, titleForLog) {
        const maxAttempts = HUCKSTER_REPRICER_RETRY_MAX;
        let lastErr = null;
        for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
            throwIfStopped(isStopped);
            const startedAt = Date.now();
            const controller = new AbortController();
            if (typeof setActiveAbortController === 'function') setActiveAbortController(controller);
            const killer = setTimeout(() => controller.abort(), HUCKSTER_REPRICER_REQUEST_TIMEOUT_MS + 5000);
            try {
                const resp = await axios.post(
                    'https://wbs.e-teleport.ru/markets/integrations/repricer/items/list',
                    payload,
                    {
                        timeout: HUCKSTER_REPRICER_REQUEST_TIMEOUT_MS,
                        signal: controller.signal,
                        headers: {
                            Accept: 'application/json',
                            'Content-Type': 'application/json',
                            Cookie: `ss-id=${sessionId}`,
                        },
                    }
                );
                const elapsed = Date.now() - startedAt;
                console.info('[huckster] %s ok %sms %s/%s', titleForLog, elapsed, shop.marketplace, shop.shop_id);
                return resp;
            } catch (e) {
                lastErr = e;
                const elapsed = Date.now() - startedAt;
                const msg = e?.response?.data?.error?.message || e?.message || String(e);
                console.warn(
                    '[huckster] %s fail %sms attempt %s/%s %s/%s: %s',
                    titleForLog,
                    elapsed,
                    attempt,
                    maxAttempts,
                    shop.marketplace,
                    shop.shop_id,
                    msg
                );
                if (typeof onProgress === 'function') {
                    onProgress({
                        phase: 'request_retry',
                        title: titleForLog,
                        attempt,
                        attempts: maxAttempts,
                        error: String(msg),
                    });
                }
                if (attempt < maxAttempts) {
                    throwIfStopped(isStopped);
                    await new Promise((r) => setTimeout(r, Math.max(500, delayMs)));
                }
            } finally {
                clearTimeout(killer);
                if (typeof setActiveAbortController === 'function') setActiveAbortController(null);
            }
        }
        throw lastErr || new Error(`${titleForLog}: unknown error`);
    }

    while (maxOffset === 0 || offset < maxOffset) {
        throwIfStopped(isStopped);
        if (typeof onProgress === 'function') {
            onProgress({
                phase: 'page',
                page: Math.floor(offset / limit) + 1,
                offset,
                uid_found: byUid.size,
                uid_filter_found: foundFiltered.size,
                uid_filter_total: uidFilter ? uidFilter.size : 0,
            });
        }
        const r = await postRepricer(
            { marketplace: shop.marketplace, shop_id: shop.shop_id, limit, offset },
            `repricer/items/list offset=${offset}`
        );
        const payload = r && r.data ? r.data : {};
        if (payload.error) throw new Error(payload.error.message || JSON.stringify(payload.error));
        const rows = Array.isArray(payload.result) ? payload.result : [];
        for (const x of rows) {
            const uid = String(getRepricerField(x, 'uid', 'Uid') || '').trim();
            if (!uid) continue;
            if (uidFilterLc) {
                const alts = extractRepricerAltMatchIds(x, uid);
                const hit = uidFilterHit([uid, ...alts]);
                if (!hit) continue;
                if (uidFilterLc.has(String(uid).toLowerCase())) foundFiltered.add(String(uid).toLowerCase());
                for (const a of alts) {
                    const t = String(a || '').trim().toLowerCase();
                    if (t && uidFilterLc.has(t)) foundFiltered.add(t);
                }
            }
            byUid.set(uid, {
                uid,
                name: String(getRepricerField(x, 'name', 'Name') || ''),
                updatedAt: extractItemUpdatedAt(x),
                repricerEnabled: isIncludedRepricerItem(x),
                altMatchIds: extractRepricerAltMatchIds(x, uid),
                mpSku: String(getRepricerField(x, 'sku', 'Sku') ?? x.sku ?? '').trim(),
            });
        }
        if (uidFilterLc && foundFiltered.size >= uidFilterLc.size) break;
        const pageLen = rows.length;
        if (!pageLen) break;
        offset += pageLen;
        if (pageLen < limit) {
            const totalN = Number((payload.cursor || {}).total);
            if (!(Number.isFinite(totalN) && offset < totalN)) break;
        }
        throwIfStopped(isStopped);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    return Array.from(byUid.values());
}

/** Дописать inUnitModel и названия Unit-наборов к уже загруженному списку repricer. `unitSetFilter` — только наборы list, для которых вернётся true (например только «Онлайн калькулятор» для Export). */
async function enrichProductsWithUnitModels(shop, sessionId, products, opts, isStopped, unitSetFilter, onUnitProgress, setActiveAbortController) {
    throwIfStopped(isStopped);
    let info = null;
    try {
        info = await fetchAllUnitModelInfo(
            shop,
            sessionId,
            opts,
            isStopped,
            unitSetFilter,
            onUnitProgress,
            setActiveAbortController
        );
    } catch (e) {
        console.warn('[huckster] unit economy models:', e && e.message ? e.message : e);
        info = null;
    }
    const list = Array.isArray(products) ? products : [];
    const namesByUidLc = new Map();
    if (info && info.uidToNames instanceof Map) {
        for (const [u, ns] of info.uidToNames.entries()) {
            const k = String(u || '').trim().toLowerCase();
            if (!k || !(ns instanceof Set) || ns.size === 0) continue;
            if (!namesByUidLc.has(k)) namesByUidLc.set(k, new Set());
            for (const n of ns) namesByUidLc.get(k).add(n);
        }
    }
    return list.map((p) => {
        const uid = String(p.uid || '');
        let inUnit = null;
        let unitModelNames = '';
        if (info != null) {
            const ns = namesByUidLc.get(uid.trim().toLowerCase());
            inUnit = Boolean(ns && ns.size > 0);
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
async function fetchAllUnitModelInfo(shop, sessionId, opts, isStopped, unitSetFilter, onProgress, setActiveAbortController) {
    const uidSet = new Set();
    const uidToNames = new Map();
    const delayMs = Math.max(HUCKSTER_DELAY_MS_MIN, Number(opts.delay_ms || HUCKSTER_DELAY_MS_DEFAULT));
    const limitGet = HUCKSTER_UNIT_PAGE_LIMIT;
    const uidFilter = opts.uid_filter instanceof Set ? opts.uid_filter : null;
    const uidFilterLc = uidFilter
        ? new Set(Array.from(uidFilter).map((v) => String(v || '').trim().toLowerCase()).filter(Boolean))
        : null;
    const foundFiltered = new Set();
    const headers = {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Cookie: `ss-id=${sessionId}`,
    };
    async function postUnit(url, payload, titleForLog) {
        const maxAttempts = HUCKSTER_UNIT_RETRY_MAX;
        const requestTimeoutMs = getUnitRequestTimeoutMs(shop);
        const hardTimeoutMs = getUnitHardTimeoutMs(shop);
        let lastErr = null;
        for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
            const startedAt = Date.now();
            const hardTimer = setTimeout(() => {
                /* no-op marker timer for logs */
            }, hardTimeoutMs);
            try {
                const controller = new AbortController();
                if (typeof setActiveAbortController === 'function') setActiveAbortController(controller);
                const killer = setTimeout(() => controller.abort(), hardTimeoutMs);
                try {
                    const resp = await axios.post(url, payload, {
                        timeout: requestTimeoutMs,
                        headers,
                        signal: controller.signal,
                    });
                    const elapsed = Date.now() - startedAt;
                    console.info('[huckster] %s ok %sms %s/%s', titleForLog, elapsed, shop.marketplace, shop.shop_id);
                    return resp;
                } finally {
                    clearTimeout(killer);
                }
            } catch (e) {
                lastErr = e;
                const msg = e?.response?.data?.error?.message || e?.message || String(e);
                const elapsed = Date.now() - startedAt;
                console.warn(
                    '[huckster] %s fail %sms attempt %s/%s %s/%s: %s',
                    titleForLog,
                    elapsed,
                    attempt,
                    maxAttempts,
                    shop.marketplace,
                    shop.shop_id,
                    msg
                );
                if (typeof onProgress === 'function') {
                    onProgress({
                        phase: 'request_retry',
                        title: titleForLog,
                        attempt,
                        attempts: maxAttempts,
                        error: String(msg),
                    });
                }
                if (attempt < maxAttempts) {
                    throwIfStopped(isStopped);
                    await new Promise((r) => setTimeout(r, Math.max(500, delayMs)));
                }
            } finally {
                clearTimeout(hardTimer);
                if (typeof setActiveAbortController === 'function') setActiveAbortController(null);
            }
        }
        throw lastErr || new Error(`${titleForLog}: unknown error`);
    }

    function noteUidInSet(uid, setLabel) {
        const u = String(uid || '').trim();
        if (!u) return;
        if (uidFilterLc && !uidFilterLc.has(u.toLowerCase())) return;
        uidSet.add(u);
        if (uidFilterLc) foundFiltered.add(u.toLowerCase());
        const label = String(setLabel || '').trim() || `#`;
        if (!uidToNames.has(u)) uidToNames.set(u, new Set());
        uidToNames.get(u).add(label);
    }

    throwIfStopped(isStopped);
    if (typeof onProgress === 'function') {
        onProgress({ phase: 'set_list_start' });
    }
    const listRes = await postUnit(
        'https://wbs.e-teleport.ru/markets/integrations/unit/set/list',
        { marketplace: shop.marketplace, shop_id: shop.shop_id },
        'unit/set/list'
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
    if (typeof onProgress === 'function') {
        onProgress({ phase: 'set_list_done', set_count: setList.length });
    }

    let setIndex = 0;
    for (const st of setList) {
        throwIfStopped(isStopped);
        if (!unitSetRowMatchesShop(st, shop)) continue;

        const setId = String(st.id != null ? st.id : st.set_id != null ? st.set_id : '').trim();
        if (!setId) continue;
        const setLabel = extractUnitSetDisplayName(st, setId);
        setIndex += 1;
        if (typeof onProgress === 'function') {
            onProgress({
                phase: 'set_start',
                set_id: setId,
                set_label: setLabel,
                set_index: setIndex,
                set_total: setList.length,
            });
        }

        let offset = 0;
        let page = 0;
        /* eslint-disable no-await-in-loop */
        for (;;) {
            throwIfStopped(isStopped);
            page += 1;
            if (typeof onProgress === 'function') {
                onProgress({
                    phase: 'set_page',
                    set_id: setId,
                    set_label: setLabel,
                    set_index: setIndex,
                    set_total: setList.length,
                    page,
                    offset,
                    uid_found: uidSet.size,
                    uid_filter_found: foundFiltered.size,
                    uid_filter_total: uidFilter ? uidFilter.size : 0,
                });
            }
            let gr;
            try {
                gr = await postUnit(
                    'https://wbs.e-teleport.ru/markets/integrations/unit/set/get',
                    {
                        marketplace: shop.marketplace,
                        shop_id: shop.shop_id,
                        set_id: setId,
                        limit: limitGet,
                        offset,
                    },
                    `unit/set/get set_id=${setId} offset=${offset}`
                );
            } catch (eGet) {
                const msg = eGet && eGet.message ? eGet.message : String(eGet);
                console.warn(
                    '[huckster] unit/set/get set_id=%s offset=%s skipped after retries %s/%s: %s (уже собрано UID: %s)',
                    setId,
                    offset,
                    shop.marketplace,
                    shop.shop_id,
                    msg,
                    uidSet.size
                );
                if (typeof onProgress === 'function') {
                    onProgress({
                        phase: 'set_skip',
                        set_id: setId,
                        set_label: setLabel,
                        set_index: setIndex,
                        set_total: setList.length,
                        offset,
                        error: msg,
                        uid_found: uidSet.size,
                    });
                }
                break;
            }
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

            if (uidFilterLc && foundFiltered.size >= uidFilterLc.size) break;
            const pageLen = itemList.length;
            if (!pageLen) break;
            offset += pageLen;
            if (pageLen < limitGet) {
                if (!(Number.isFinite(total) && offset < total)) break;
            }
            throwIfStopped(isStopped);
            await new Promise((r) => setTimeout(r, delayMs));
        }
        /* eslint-enable no-await-in-loop */
        if (uidFilterLc && foundFiltered.size >= uidFilterLc.size) break;
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
        // ISO-время фактического сохранения снапшота в huckster_matrix_snapshots.
        // Используется server.js / processAutoSyncQueue, чтобы пометить запуск
        // completed только если снапшот реально записался, а не просто IIFE завершилась.
        snapshot_saved_at: null,
        active_abort_controller: null,
    };

    function getConfiguredSets() {
        const set1 = parseShopsJson(appSettings.huckster_shops_set_1, SHOPS_SET_1);
        const set2 = parseShopsJson(appSettings.huckster_shops_set_2, SHOPS_SET_2);
        const priceTypeSet1 = String(appSettings.huckster_ms_price_type_set_1 || '').trim();
        const priceTypeSet2 = String(appSettings.huckster_ms_price_type_set_2 || '').trim();
        return { set1, set2, priceTypeSet1, priceTypeSet2 };
    }

    function isMsNoLongerCooperationYes(v) {
        const s = String(v == null ? '' : v).trim().toLowerCase();
        return s === 'да' || s === 'yes' || s === '1' || s === 'true';
    }

    function buildHucksterSignalsByCode(cfg, set1Items, set2Items) {
        const byCode = new Map();
        function emptyMarkets() {
            return {
                ozon: { repricer: false, modelNames: new Set(), mpSku: '' },
                wildberries: { repricer: false, modelNames: new Set(), mpSku: '' },
                yandex: { repricer: false, modelNames: new Set(), mpSku: '' },
            };
        }
        function touch(code) {
            const c = String(code || '').trim();
            if (!c) return null;
            if (!byCode.has(c)) {
                byCode.set(c, { repricer: false, modelNames: new Set(), markets: emptyMarkets() });
            }
            return byCode.get(c);
        }
        const bucketDefs = [
            { shops: Array.isArray(cfg && cfg.set1) ? cfg.set1 : [], items: set1Items || {} },
            { shops: Array.isArray(cfg && cfg.set2) ? cfg.set2 : [], items: set2Items || {} },
        ];
        for (const def of bucketDefs) {
            const mpByShopId = new Map(
                (def.shops || []).map((s) => [String((s && s.id) || ''), String((s && s.marketplace) || '').toLowerCase()])
            );
            for (const shopId of Object.keys(def.items || {})) {
                const list = Array.isArray(def.items[shopId]) ? def.items[shopId] : [];
                const mp = mpByShopId.get(String(shopId || '')) || '';
                for (const row of list) {
                    const uid = row && row.uid != null ? String(row.uid).trim() : '';
                    if (!uid) continue;
                    const altKeys = Array.isArray(row.altMatchIds)
                        ? row.altMatchIds.map((a) => String(a || '').trim()).filter(Boolean)
                        : [];
                    const mergeKeys = Array.from(new Set([uid, ...altKeys]));
                    for (const k of mergeKeys) {
                        const rec = touch(k);
                        if (!rec) continue;
                        if (row && row.repricerEnabled === true) rec.repricer = true;
                        const marketRec = rec.markets && rec.markets[mp] ? rec.markets[mp] : null;
                        if (marketRec && row && row.repricerEnabled === true) marketRec.repricer = true;
                        const sku = String((row && row.mpSku) || '').trim();
                        if (marketRec && sku) marketRec.mpSku = sku;
                        const names = String((row && row.unitModelNames) || '').trim();
                        if (names) {
                            for (const part of names.split(';')) {
                                const nm = String(part || '').trim();
                                if (!nm) continue;
                                rec.modelNames.add(nm);
                                if (marketRec) marketRec.modelNames.add(nm);
                            }
                        }
                    }
                }
            }
        }
        return byCode;
    }

    function buildHucksterLostRows(msRows, signalMap, syncedAtIso) {
        const header = [
            'ID / КОД',
            'Наименование товара',
            'Менеджер',
            'Остаток',
            'Автоматизация цены',
            'Ozon',
            'Модель Ozon',
            'Код товара на МП (Ozon)',
            'WB',
            'Модель WB',
            'Код товара на МП (WB)',
            'ЯМ',
            'Модель ЯМ',
            'Код товара на МП (ЯМ)',
            'Актуально на',
        ];
        const rows = [header];
        const syncCell = syncedAtIso ? new Date(syncedAtIso).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' }) : '';
        function repricerCell(marketSig) {
            return marketSig && marketSig.repricer ? 'Репрайсер ВКЛЮЧЕН' : 'Репрайсер ВЫКЛЮЧЕН';
        }
        function modelCell(marketSig) {
            const names = marketSig && marketSig.modelNames && marketSig.modelNames.size
                ? Array.from(marketSig.modelNames).sort((a, b) => a.localeCompare(b, 'ru', { numeric: true })).join('; ')
                : '';
            if (marketSig && marketSig.repricer) return names || 'Модель не назначена';
            if (names) return `Модель назначена, но Репрайсер на модели выключен: ${names}`;
            return 'Модель не назначена';
        }
        function mpSkuLostCell(marketSig) {
            const s = marketSig && marketSig.mpSku != null ? String(marketSig.mpSku).trim() : '';
            return s || '';
        }
        for (const ms of msRows || []) {
            const code = String(ms && ms.code ? ms.code : '').trim();
            if (!code) continue;
            const sig = signalMap.get(code);
            if (!sig) continue;
            if (!sig.repricer && (!sig.modelNames || sig.modelNames.size === 0)) continue;
            if (!isMsNoLongerCooperationYes(ms.no_longer_cooperation)) continue;
            if (Number(ms.stock || 0) !== 0) continue;
            const mo = sig.markets && sig.markets.ozon ? sig.markets.ozon : null;
            const mw = sig.markets && sig.markets.wildberries ? sig.markets.wildberries : null;
            const my = sig.markets && sig.markets.yandex ? sig.markets.yandex : null;
            rows.push([
                code,
                String(ms.name || ''),
                String(ms.manager || ''),
                String(ms.stock != null ? ms.stock : ''),
                String(ms.automation_price != null ? ms.automation_price : '').trim(),
                repricerCell(mo),
                modelCell(mo),
                mpSkuLostCell(mo),
                repricerCell(mw),
                modelCell(mw),
                mpSkuLostCell(mw),
                repricerCell(my),
                modelCell(my),
                mpSkuLostCell(my),
                syncCell,
            ]);
        }
        return {
            rows,
            total_rows: Math.max(0, rows.length - 1),
            matrix_kind: HUCKSTER_MATRIX_LOST_KIND,
        };
    }

    /** Запуск фоновой синхронизации (из POST /sync или из планировщика server.js). */
    function tryStartHucksterSync(body) {
        const bodyObj = body || {};
        /* Строки моста = все коды из ms_export; сужение только UI (фильтры страницы + архив) и test_uids на синке. */
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
        syncState.active_abort_controller = null;
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

        // Сбрасываем «снапшот сохранён» от предыдущего запуска: его выставит блок
        // postprocess_snapshot_save_done, и server.js / processAutoSyncQueue использует
        // это для honest-статуса processes (см. getSyncState/triggerSync).
        syncState.snapshot_saved_at = null;

        (async () => {
            // «Ранний» лог-сигнал: чтобы при моментальном падении в IIFE (до основного try)
            // в huckster-sync.log оставался хотя бы один INFO-маркер с временем старта.
            // appendHucksterLog проглатывает свои ошибки — это просто метка для диагностики.
            try { await appendHucksterLog('INFO', 'sync_iife_entered', { started_at: syncState.started_at }); } catch (_) {}
            let lastPhase = 'init';
            try {
                const setActiveAbortController = (controller) => {
                    syncState.active_abort_controller = controller || null;
                };
                lastPhase = 'sync_started';
                await appendHucksterLog('INFO', 'sync_started', {
                    started_at: syncState.started_at,
                    test_uids: opts.test_uids,
                    sync_script: getHucksterSyncMeta(),
                });
                throwIfStopped(() => syncState.stop_requested);
                lastPhase = 'huckster_auth';
                const sessionId = await hucksterAuth(email, password);
                lastPhase = 'repricer';
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
                    const repricerShopTimeoutMs = getRepricerShopTimeoutMs(item.set, item.shop);
                    await appendHucksterLog('INFO', 'repricer_shop_start', {
                        set: item.set,
                        shop_id: item.shop.id,
                        shop_name: item.shop.name,
                        marketplace: item.shop.marketplace,
                        timeout_ms: repricerShopTimeoutMs,
                    });
                    const repricerProgress = (p) => {
                        if (!p || typeof p !== 'object') return;
                        const prefix = `Repricer — ${item.shop.name} (${setLabel})`;
                        if (p.phase === 'page') {
                            const pg = Number(p.page || 0);
                            const off = Number(p.offset || 0);
                            const uf = Number(p.uid_filter_found || 0);
                            const ut = Number(p.uid_filter_total || 0);
                            syncState.status_text =
                                ut > 0
                                    ? `${prefix}: стр. ${pg}, offset ${off}, UID ${uf}/${ut}`
                                    : `${prefix}: стр. ${pg}, offset ${off}`;
                            appendHucksterLog('INFO', 'repricer_page', {
                                set: item.set,
                                shop_id: item.shop.id,
                                page: pg,
                                offset: off,
                                uid_filter_found: uf,
                                uid_filter_total: ut,
                            });
                            return;
                        }
                        if (p.phase === 'request_retry') {
                            syncState.status_text = `${prefix}: ретрай ${Number(p.attempt || 0)}/${Number(
                                p.attempts || 0
                            )} (${String(p.title || '')})`;
                            appendHucksterLog('WARN', 'repricer_retry', {
                                set: item.set,
                                shop_id: item.shop.id,
                                attempt: Number(p.attempt || 0),
                                attempts: Number(p.attempts || 0),
                                title: String(p.title || ''),
                                error: String(p.error || ''),
                            });
                        }
                    };
                    const rows = await withTimeout(
                        fetchRepricerProductsForShop(
                            item.shop,
                            sessionId,
                            opts,
                            () => syncState.stop_requested,
                            repricerProgress,
                            setActiveAbortController
                        ),
                        repricerShopTimeoutMs,
                        `Timeout Repricer: ${item.shop.name} (${setLabel}) > ${Math.round(
                            repricerShopTimeoutMs / 1000
                        )}s`
                    );
                    if (item.set === 'set1') set1Items[item.shop.id] = rows;
                    else set2Items[item.shop.id] = rows;
                    await appendHucksterLog('INFO', 'repricer_shop_done', {
                        set: item.set,
                        shop_id: item.shop.id,
                        rows: Array.isArray(rows) ? rows.length : 0,
                    });
                    syncState.progress.done_shops += 1;
                }
                lastPhase = 'unit_models';
                for (const item of allShops) {
                    throwIfStopped(() => syncState.stop_requested);
                    const setLabel = item.set === 'set1' ? 'Huckster Export' : 'Huckster Export RRC';
                    syncState.progress.current_shop_id = item.shop.id;
                    syncState.progress.current_shop_name = item.shop.name;
                    syncState.progress.current_set = item.set;
                    syncState.status_text = `Unit-модели — ${item.shop.name} (${setLabel})...`;
                    await appendHucksterLog('INFO', 'unit_shop_start', {
                        set: item.set,
                        shop_id: item.shop.id,
                        shop_name: item.shop.name,
                        marketplace: item.shop.marketplace,
                    });
                    const bucket = item.set === 'set1' ? set1Items : set2Items;
                    const raw = bucket[item.shop.id];
                    const set1UnitFilter = makeSet1OnlineCalculatorUnitFilter();
                    const unitProgress = (p) => {
                        if (!p || typeof p !== 'object') return;
                        const setLabel2 = item.set === 'set1' ? 'Huckster Export' : 'Huckster Export RRC';
                        const prefix = `Unit-модели — ${item.shop.name} (${setLabel2})`;
                        if (p.phase === 'set_list_start') {
                            syncState.status_text = `${prefix}: загружаем список наборов...`;
                            appendHucksterLog('INFO', 'unit_set_list_start', { set: item.set, shop_id: item.shop.id });
                            return;
                        }
                        if (p.phase === 'set_list_done') {
                            syncState.status_text = `${prefix}: наборов ${Number(p.set_count || 0)}.`;
                            appendHucksterLog('INFO', 'unit_set_list_done', {
                                set: item.set,
                                shop_id: item.shop.id,
                                set_count: Number(p.set_count || 0),
                            });
                            return;
                        }
                        if (p.phase === 'set_start') {
                            syncState.status_text = `${prefix}: набор ${Number(p.set_index || 0)}/${Number(
                                p.set_total || 0
                            )} (${String(p.set_label || p.set_id || '').slice(0, 48)})`;
                            appendHucksterLog('INFO', 'unit_set_start', {
                                set: item.set,
                                shop_id: item.shop.id,
                                set_id: String(p.set_id || ''),
                                set_label: String(p.set_label || ''),
                                set_index: Number(p.set_index || 0),
                                set_total: Number(p.set_total || 0),
                            });
                            return;
                        }
                        if (p.phase === 'set_page') {
                            const pg = Number(p.page || 0);
                            const off = Number(p.offset || 0);
                            const uf = Number(p.uid_filter_found || 0);
                            const ut = Number(p.uid_filter_total || 0);
                            const setLabelShort = String(p.set_label || p.set_id || '').slice(0, 28);
                            syncState.status_text =
                                ut > 0
                                    ? `${prefix}: ${setLabelShort} | набор ${Number(p.set_index || 0)}/${Number(p.set_total || 0)}, стр. ${pg}, offset ${off}, UID ${uf}/${ut}`
                                    : `${prefix}: ${setLabelShort} | набор ${Number(p.set_index || 0)}/${Number(p.set_total || 0)}, стр. ${pg}, offset ${off}`;
                            appendHucksterLog('INFO', 'unit_set_page', {
                                set: item.set,
                                shop_id: item.shop.id,
                                set_id: String(p.set_id || ''),
                                set_label: String(p.set_label || ''),
                                set_index: Number(p.set_index || 0),
                                set_total: Number(p.set_total || 0),
                                page: pg,
                                offset: off,
                                uid_filter_found: uf,
                                uid_filter_total: ut,
                            });
                            return;
                        }
                        if (p.phase === 'request_retry') {
                            syncState.status_text = `${prefix}: ретрай ${Number(p.attempt || 0)}/${Number(
                                p.attempts || 0
                            )} (${String(p.title || '')})`;
                            appendHucksterLog('WARN', 'unit_retry', {
                                set: item.set,
                                shop_id: item.shop.id,
                                attempt: Number(p.attempt || 0),
                                attempts: Number(p.attempts || 0),
                                title: String(p.title || ''),
                                error: String(p.error || ''),
                            });
                        }
                    };
                    try {
                        const unitShopTimeoutMs = getUnitShopTimeoutMs(item.shop);
                        bucket[item.shop.id] = await withTimeout(
                            enrichProductsWithUnitModels(
                                item.shop,
                                sessionId,
                                raw,
                                opts,
                                () => syncState.stop_requested,
                                item.set === 'set1' ? set1UnitFilter : null,
                                unitProgress,
                                setActiveAbortController
                            ),
                            unitShopTimeoutMs,
                            `Timeout Unit-моделей: ${item.shop.name} (${setLabel}) > ${Math.round(
                                unitShopTimeoutMs / 1000
                            )}s`
                        );
                    } catch (eUnitShop) {
                        const msg = eUnitShop && eUnitShop.message ? eUnitShop.message : String(eUnitShop);
                        syncState.status_text = `Ошибка Unit-моделей: ${item.shop.name} (${setLabel}) — ${msg}; оставляем Repricer без моделей`;
                        await appendHucksterLog('ERROR', 'unit_shop_failed', {
                            set: item.set,
                            shop_id: item.shop.id,
                            error: msg,
                        });
                        // Не валим весь sync: Repricer уже собран; модели для этого кабинета останутся пустыми.
                        if (!Array.isArray(bucket[item.shop.id])) {
                            bucket[item.shop.id] = Array.isArray(raw) ? raw : [];
                        }
                    }
                    await appendHucksterLog('INFO', 'unit_shop_done', {
                        set: item.set,
                        shop_id: item.shop.id,
                        rows: Array.isArray(bucket[item.shop.id]) ? bucket[item.shop.id].length : 0,
                    });
                    syncState.progress.done_shops += 1;
                }
                const syncedAt = new Date().toISOString();
                lastPhase = 'postprocess_ms_rows';
                let msBridgeRowsAll = [];
                let msBridgeRowsSet1 = [];
                let msBridgeRowsSet2Base = [];
                try {
                    if (typeof _db?.query === 'function') {
                        syncState.status_text = 'Финализация: загрузка строк МойСклад...';
                        await appendHucksterLog('INFO', 'postprocess_ms_rows_start', {});
                        msBridgeRowsAll = await fetchMsExportBridgeRowsAll(_db);
                        await appendHucksterLog('INFO', 'postprocess_ms_rows_done', {
                            rows: Array.isArray(msBridgeRowsAll) ? msBridgeRowsAll.length : 0,
                        });
                        const set1Filters = {
                            exclude_archived_bundles:
                                bodyHasOwn(bodyObj, 'ms_exclude_archived_bundles')
                                    ? appSettingBool01(bodyObj.ms_exclude_archived_bundles)
                                    : appSettingBool01(appSettings.huckster_ms_exclude_archived_bundles),
                            exclude_archived_products_zero_stock:
                                bodyHasOwn(bodyObj, 'ms_exclude_archived_products_zero_stock')
                                    ? appSettingBool01(bodyObj.ms_exclude_archived_products_zero_stock)
                                    : appSettingBool01(appSettings.huckster_ms_exclude_archived_products_zero_stock),
                        };
                        msBridgeRowsSet1 = await fetchMsExportBridgeCandidates(_db, set1Filters);
                        msBridgeRowsSet2Base = msBridgeRowsSet1.slice();
                        await appendHucksterLog('INFO', 'postprocess_ms_rows_set1_filtered_done', {
                            rows: Array.isArray(msBridgeRowsSet1) ? msBridgeRowsSet1.length : 0,
                            ...set1Filters,
                        });
                        if (opts.uid_filter) {
                            msBridgeRowsAll = msBridgeRowsAll.filter((r) => opts.uid_filter.has(String(r.code || '').trim()));
                            msBridgeRowsSet1 = msBridgeRowsSet1.filter((r) => opts.uid_filter.has(String(r.code || '').trim()));
                            msBridgeRowsSet2Base = msBridgeRowsSet2Base.filter((r) =>
                                opts.uid_filter.has(String(r.code || '').trim())
                            );
                            await appendHucksterLog('INFO', 'postprocess_ms_rows_uid_filtered', {
                                rows_all: Array.isArray(msBridgeRowsAll) ? msBridgeRowsAll.length : 0,
                                rows_set1: Array.isArray(msBridgeRowsSet1) ? msBridgeRowsSet1.length : 0,
                                rows_set2_base: Array.isArray(msBridgeRowsSet2Base) ? msBridgeRowsSet2Base.length : 0,
                                uid_filter_total: opts.uid_filter.size,
                            });
                        }
                    }
                } catch (eMs) {
                    console.warn('[huckster] ms bridge rows:', eMs && eMs.message ? eMs.message : eMs);
                }
                syncState.status_text = 'Финализация: обогащение ценами МойСклад (набор 1)...';
                await appendHucksterLog('INFO', 'postprocess_enrich_set1_start', {
                    price_type: String(cfg.priceTypeSet1 || ''),
                });
                const set1MsBridgeRows = await withTimeout(
                    enrichMsRowsWithPriceType(_db, msBridgeRowsSet1, cfg.priceTypeSet1),
                    HUCKSTER_POSTPROCESS_TIMEOUT_MS,
                    `Timeout postprocess set1 > ${Math.round(HUCKSTER_POSTPROCESS_TIMEOUT_MS / 1000)}s`
                );
                await appendHucksterLog('INFO', 'postprocess_enrich_set1_done', {
                    rows: Array.isArray(set1MsBridgeRows) ? set1MsBridgeRows.length : 0,
                });
                syncState.status_text = 'Финализация: обогащение ценами МойСклад (набор 2)...';
                await appendHucksterLog('INFO', 'postprocess_enrich_set2_start', {
                    price_type: String(cfg.priceTypeSet2 || ''),
                });
                const set2EnrichProgress = (p) => {
                    if (!p || typeof p !== 'object') return;
                    if (p.phase !== 'detail_chunk_done') return;
                    const ci = Number(p.chunk_index || 0);
                    const ct = Number(p.chunk_total || 0);
                    const loaded = Number(p.rows_loaded || 0);
                    if (ct > 0) {
                        syncState.status_text = `Финализация: обогащение ценами МойСклад (набор 2), chunk ${ci}/${ct}...`;
                    }
                    appendHucksterLog('INFO', 'postprocess_enrich_set2_chunk', {
                        chunk_index: ci,
                        chunk_total: ct,
                        rows_loaded: loaded,
                    });
                };
                const set2MsBridgeRows = await withTimeout(
                    enrichMsRowsWithPriceType(_db, msBridgeRowsSet2Base, cfg.priceTypeSet2, set2EnrichProgress),
                    HUCKSTER_POSTPROCESS_TIMEOUT_MS,
                    `Timeout postprocess set2 > ${Math.round(HUCKSTER_POSTPROCESS_TIMEOUT_MS / 1000)}s`
                );
                const set2MsBridgeRowsFiltered = set2MsBridgeRows.filter(
                    (r) => Number(r && r.selected_price_type_value_cents) > 0
                );
                await appendHucksterLog('INFO', 'postprocess_enrich_set2_done', {
                    rows: Array.isArray(set2MsBridgeRowsFiltered) ? set2MsBridgeRowsFiltered.length : 0,
                });
                lastPhase = 'postprocess_build_exports';
                syncState.status_text = 'Финализация: сборка матриц Huckster...';
                await appendHucksterLog('INFO', 'postprocess_build_exports_start', {});
                const set1 = buildMsHucksterBridgeExport(cfg.set1, set1Items, set1MsBridgeRows, syncedAt, {
                    priceTypeName: cfg.priceTypeSet1,
                });
                const set2 = buildMsHucksterBridgeExport(cfg.set2, set2Items, set2MsBridgeRowsFiltered, syncedAt, {
                    priceTypeName: cfg.priceTypeSet2,
                });
                const signalsByCode = buildHucksterSignalsByCode(cfg, set1Items, set2Items);
                const sheetLost = buildHucksterLostRows(msBridgeRowsAll, signalsByCode, syncedAt);
                await appendHucksterLog('INFO', 'postprocess_build_exports_done', {
                    set1_rows: Number(set1.total_rows || 0),
                    set2_rows: Number(set2.total_rows || 0),
                    lost_rows: Number(sheetLost.total_rows || 0),
                });
                syncState.error = null;
                syncState.result = {
                    success: true,
                    updated_at: syncedAt,
                    sync_script: getHucksterSyncMeta(),
                    test_uids: opts.test_uids,
                    sheet_export: set1,
                    sheet_export_rrc: set2,
                    sheet_export_lost: sheetLost,
                };
                syncState.status_text = opts.test_uids.length
                    ? `Тест Huckster завершён: ${opts.test_uids.join(', ')}.`
                    : 'Обновление Huckster завершено.';
                await appendHucksterLog('INFO', 'sync_completed', {
                    finished_at: new Date().toISOString(),
                    set1_rows: Number(set1.total_rows || 0),
                    set2_rows: Number(set2.total_rows || 0),
                    lost_rows: Number(sheetLost.total_rows || 0),
                });
                if (!opts.test_uids.length) {
                    lastPhase = 'snapshot_save';
                    try {
                        syncState.status_text = 'Финализация: сохранение снапшота в БД...';
                        await appendHucksterLog('INFO', 'postprocess_snapshot_save_start', {});
                        await saveHucksterSnapshot(_db, syncState.result);
                        syncState.snapshot_saved_at = new Date().toISOString();
                        await appendHucksterLog('INFO', 'postprocess_snapshot_save_done', {
                            snapshot_saved_at: syncState.snapshot_saved_at,
                        });
                    } catch (saveErr) {
                        const msg = saveErr && saveErr.message ? saveErr.message : String(saveErr);
                        console.error('[huckster] snapshot save:', msg);
                        // Снапшот не сохранился — для server.js это «failed», даже если все
                        // предыдущие фазы прошли. Оставляем result.success=true, но не
                        // ставим snapshot_saved_at и пишем error, чтобы processes увидел.
                        syncState.error = { code: 'HUCKSTER_SNAPSHOT_SAVE_FAILED', error: msg };
                        await appendHucksterLog('ERROR', 'sync_failed', {
                            phase: 'snapshot_save',
                            error: msg,
                        });
                    }
                }
            } catch (e) {
                if (e && e.code === 'HUCKSTER_STOPPED') {
                    syncState.error = {
                        code: 'HUCKSTER_STOPPED',
                        error: e.message || 'Остановлено пользователем',
                        phase: lastPhase,
                    };
                    syncState.status_text = 'Обновление Huckster остановлено.';
                    await appendHucksterLog('WARN', 'sync_stopped', { phase: lastPhase, error: e.message || 'stopped' });
                } else {
                    const msg = e && e.message ? e.message : String(e);
                    syncState.error = {
                        code: 'HUCKSTER_SYNC_FAILED',
                        error: msg,
                        phase: lastPhase,
                    };
                    syncState.status_text = `Ошибка обновления Huckster (фаза ${lastPhase}): ${msg}`;
                    await appendHucksterLog('ERROR', 'sync_failed', {
                        phase: lastPhase,
                        error: msg,
                    });
                }
            } finally {
                syncState.active = false;
                syncState.stop_requested = false;
                syncState.active_abort_controller = null;
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
        // Расширенный снимок состояния — нужен server.js / processAutoSyncQueue,
        // чтобы помечать запись auto_sync_runs honestly:
        //   completed — только если result.success === true и snapshot_saved_at не null;
        //   failed    — если есть error (auth/repricer/snapshot_save/HUCKSTER_STOPPED).
        // `progress` / `stop_requested` — для /api/processes/overview → tasks_live.huckster.
        let progressCopy = null;
        try {
            progressCopy = syncState.progress ? JSON.parse(JSON.stringify(syncState.progress)) : null;
        } catch (_) {
            progressCopy = syncState.progress || null;
        }
        return {
            active: syncState.active,
            started_at: syncState.started_at,
            finished_at: syncState.finished_at,
            status_text: syncState.status_text,
            error: syncState.error,
            result_success: !!(syncState.result && syncState.result.success),
            snapshot_saved_at: syncState.snapshot_saved_at,
            stop_requested: !!syncState.stop_requested,
            progress: progressCopy,
        };
    };

    router.use((req, res, next) => {
        if (!req.datagonActor) return res.status(401).json({ error: 'Не авторизован', code: 'AUTH_REQUIRED' });
        return next();
    });

    router.post('/sync', async (req, res) => {
        try {
            try {
                await persistMsBridgeArchiveFilters(_db, req.body || {}, appSettings);
            } catch (pe) {
                console.warn('[huckster] persist ms bridge filters:', pe && pe.message ? pe.message : pe);
            }
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
            return res.json({ success: true, started: true, started_at: r.started_at, sync_script: getHucksterSyncMeta() });
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
            sync_script: getHucksterSyncMeta(),
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
                    sync_script: getHucksterSyncMeta(),
                    sheet_export: { rows: [], total_uids: 0, unit_gap_shop_indexes_by_uid: {} },
                    sheet_export_rrc: { rows: [], total_uids: 0, unit_gap_shop_indexes_by_uid: {} },
                    sheet_export_lost: { rows: [], total_rows: 0, matrix_kind: HUCKSTER_MATRIX_LOST_KIND },
                });
            }
            return res.json({
                success: true,
                source: 'snapshot',
                empty: false,
                updated_at: snap.updated_at || null,
                stored_at: snap.stored_at || null,
                sync_script: snap.sync_script || getHucksterSyncMeta(),
                sheet_export: snap.sheet_export,
                sheet_export_rrc: snap.sheet_export_rrc,
                sheet_export_lost: snap.sheet_export_lost || { rows: [], total_rows: 0, matrix_kind: HUCKSTER_MATRIX_LOST_KIND },
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
        if (syncState.active_abort_controller && typeof syncState.active_abort_controller.abort === 'function') {
            try {
                syncState.active_abort_controller.abort();
            } catch (_) {}
        }
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
            price_type_set_1: cfg.priceTypeSet1,
            price_type_set_2: cfg.priceTypeSet2,
            ms_exclude_archived_bundles: appSettingBool01(appSettings.huckster_ms_exclude_archived_bundles),
            ms_exclude_archived_products_zero_stock: appSettingBool01(
                appSettings.huckster_ms_exclude_archived_products_zero_stock
            ),
            ms_exclude_products_with_bundles: appSettingBool01(appSettings.huckster_ms_exclude_products_with_bundles),
            price_type_options: [],
            defaults: { set1: SHOPS_SET_1, set2: SHOPS_SET_2 },
            sync_script: getHucksterSyncMeta(),
        });
    });

    router.get('/price-types', async (_req, res) => {
        const priceTypeOptions = await fetchMoyskladPriceTypeNames(_db);
        return res.json({
            success: true,
            price_type_options: priceTypeOptions,
        });
    });

    /**
     * Признаки архива/типа по кодам из ms_export (+ kind из ms_entity_details) для перерисовки матрицы
     * без повторного вызова Huckster (только чтение своей БД).
     */
    router.post('/ms-bridge-row-flags', async (req, res) => {
        try {
            if (typeof _db?.query !== 'function') {
                return res.status(500).json({ success: false, error: 'БД недоступна', code: 'NO_DB' });
            }
            const raw = req.body?.codes;
            if (!Array.isArray(raw)) {
                return res.status(400).json({ success: false, error: 'Ожидается codes: string[]', code: 'BAD_BODY' });
            }
            const seen = new Set();
            const codes = [];
            for (const c of raw) {
                const s = String(c == null ? '' : c).trim();
                if (!s || seen.has(s)) continue;
                seen.add(s);
                codes.push(s);
                if (codes.length >= 6000) break;
            }
            const flags = {};
            if (!codes.length) {
                return res.json({ success: true, flags });
            }
            const chunkSize = 400;
            for (let i = 0; i < codes.length; i += chunkSize) {
                const chunk = codes.slice(i, i + chunkSize);
                const placeholders = chunk.map(() => '?').join(',');
                const sql = `
                    SELECT code,
                        COALESCE(is_archived, 0) AS ia,
                        LOWER(TRIM(COALESCE(type, ''))) AS tl,
                        COALESCE(stock, 0) AS st,
                        EXISTS (
                            SELECT 1 FROM ms_entity_details d
                            WHERE d.uuid = SUBSTRING_INDEX(ms_export.uuid, '?', 1)
                              AND LOWER(TRIM(COALESCE(d.kind, ''))) = 'bundle'
                        ) AS bk
                    FROM ms_export
                    WHERE code IN (${placeholders})
                `;
                const [rows] = await _db.query(sql, chunk);
                for (const r of rows || []) {
                    const code = String(r.code != null ? r.code : '').trim();
                    if (!code) continue;
                    const ia = Number(r.ia) === 1;
                    const tl = String(r.tl || '');
                    const bk = Number(r.bk) === 1;
                    const isBundleLike = tl === 'комплект' || bk;
                    flags[code] = {
                        archived_any: ia,
                        archived_bundle: ia && isBundleLike,
                        archived_product_no_stock: ia && tl === 'товар' && Number(r.st) <= 0,
                    };
                }
            }
            return res.json({ success: true, flags });
        } catch (e) {
            return res.status(500).json({ success: false, error: e.message || String(e), code: 'MS_FLAGS_FAILED' });
        }
    });

    /** Сохранить только галочки фильтра архива МС (без полного POST /config и без Huckster). */
    router.post('/archive-filters', async (req, res) => {
        try {
            if (typeof _db?.query !== 'function') {
                return res.status(500).json({ success: false, error: 'БД недоступна', code: 'NO_DB' });
            }
            await persistMsBridgeArchiveFilters(_db, req.body || {}, appSettings);
            return res.json({
                success: true,
                ms_exclude_archived_bundles: appSettingBool01(appSettings.huckster_ms_exclude_archived_bundles),
                ms_exclude_archived_products_zero_stock: appSettingBool01(
                    appSettings.huckster_ms_exclude_archived_products_zero_stock
                ),
                ms_exclude_products_with_bundles: appSettingBool01(appSettings.huckster_ms_exclude_products_with_bundles),
            });
        } catch (e) {
            return res.status(500).json({
                success: false,
                error: e.message || String(e),
                code: 'ARCHIVE_FILTERS_SAVE_FAILED',
            });
        }
    });

    router.post('/config', async (req, res) => {
        try {
            const body = req.body || {};
            const set1Raw = Array.isArray(body.set1) ? body.set1 : [];
            const set2Raw = Array.isArray(body.set2) ? body.set2 : [];
            const set1 = set1Raw.map(normalizeShop).filter(Boolean);
            const set2 = set2Raw.map(normalizeShop).filter(Boolean);
            const priceTypeSet1 = String(body.price_type_set_1 || '').trim();
            const priceTypeSet2 = String(body.price_type_set_2 || '').trim();
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
            await _db.query(
                'INSERT INTO app_settings (setting_key, setting_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE setting_value=?',
                ['huckster_ms_price_type_set_1', priceTypeSet1, priceTypeSet1]
            );
            await _db.query(
                'INSERT INTO app_settings (setting_key, setting_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE setting_value=?',
                ['huckster_ms_price_type_set_2', priceTypeSet2, priceTypeSet2]
            );
            appSettings.huckster_shops_set_1 = set1Json;
            appSettings.huckster_shops_set_2 = set2Json;
            appSettings.huckster_ms_price_type_set_1 = priceTypeSet1;
            appSettings.huckster_ms_price_type_set_2 = priceTypeSet2;
            if (
                bodyHasOwn(body, 'ms_exclude_archived_bundles') ||
                bodyHasOwn(body, 'ms_exclude_archived_products_zero_stock') ||
                bodyHasOwn(body, 'ms_exclude_products_with_bundles')
            ) {
                await persistMsBridgeArchiveFilters(_db, body, appSettings);
            }
            return res.json({
                success: true,
                set1,
                set2,
                price_type_set_1: priceTypeSet1,
                price_type_set_2: priceTypeSet2,
                ms_exclude_archived_bundles: appSettingBool01(appSettings.huckster_ms_exclude_archived_bundles),
                ms_exclude_archived_products_zero_stock: appSettingBool01(
                    appSettings.huckster_ms_exclude_archived_products_zero_stock
                ),
                ms_exclude_products_with_bundles: appSettingBool01(appSettings.huckster_ms_exclude_products_with_bundles),
                price_type_options: [],
            });
        } catch (e) {
            return res.status(500).json({ error: e.message || String(e), code: 'SAVE_CONFIG_FAILED' });
        }
    });

    return router;
}

module.exports = createExportsHucksterRouter;
