'use strict';

const express = require('express');
const {
    exportOzonRows,
    exportWildberriesRows,
    exportYandexMarketRows,
    rowsToCsvSemicolon,
    rowObjectsToMatrix,
    prettifyMarketplaceVat,
    createMarketplaceLogger,
    MP_MIN_DELAY_MS,
} = require('../lib/marketplaceExports');
const { persistMarketplaceRows, loadMarketplaceSnapshotRows } = require('../lib/marketplaceExportStore');
const {
    resolveMsDimsForOzonPush,
    updateOzonOfferDimensions,
    patchLocalOzonDims,
} = require('../lib/ozonProductDimsUpdate');
const {
    resolveMsDimsForWbPush,
    nmIdFromUrls,
    updateWbOffersDimensionsBatch,
    patchLocalWbDims,
} = require('../lib/wbProductDimsUpdate');
const {
    resolveMsDimsForYmPush,
    updateYmOffersDimensionsBatch,
    patchLocalYmDims,
} = require('../lib/ymProductDimsUpdate');
const { parseMsVat } = require('../lib/mpVatConvert');
const {
    updateOzonOfferVat,
    patchLocalOzonVat,
} = require('../lib/ozonProductVatUpdate');
const {
    updateWbOffersVatBatch,
    patchLocalWbVat,
} = require('../lib/wbProductVatUpdate');
const {
    updateYmOffersVatBatch,
    patchLocalYmVat,
} = require('../lib/ymProductVatUpdate');

const MARKETPLACE_EXTERNAL_KEY = {
    ozon: 'offer_id',
    wb: 'vendor_code',
    ym: 'shop_sku',
};

/**
 * Кэш набора `code` товаров, которые входят как компонент хотя бы в один комплект
 * (kind=bundle в `ms_entity_details`, поле `payload_json.components.rows[].assortment.code`).
 *
 * Используется фильтром «Исключить товары, входящие в комплекты» страницы
 * `/exports-marketplaces-issues.html` (см. router.get('/issues')). Полное чтение
 * payload всех bundle-сущностей дорогое (десятки/сотни KB на запись), поэтому
 * результат запоминается на TTL и невалидируется по нему. На практике состав
 * комплектов меняется только во время «Синхронизации МС» — между ними дешёвый
 * хит из памяти; при появлении нового комплекта пользователь увидит обновлённый
 * фильтр после истечения TTL (или ручного дёрга `/issues` после паузы).
 */
const BUNDLE_COMPONENT_CODES_TTL_MS = 5 * 60 * 1000;
let bundleComponentCodesCache = null; // { at: epochMs, codes: Set<string> }
let bundleComponentCodesPromise = null;

async function loadBundleComponentCodesUncached(db) {
    const out = new Set();
    if (!db || typeof db.query !== 'function') return out;

    // ВАЖНО: читаем bundle-сущности **порционно** и тащим из MySQL ровно
    // массив кодов компонентов через `JSON_EXTRACT(... '$.components.rows[*].assortment.code')`,
    // а не весь `payload_json` и даже не весь `$.components.rows` (полный
    // assortment одного компонента — это nested meta/attributes/images, легко
    // десятки KB на один component). Полный payload одного комплекта в МойСклад
    // может весить сотни KB; при нескольких тысячах комплектов SELECT * приводил
    // к Node OOM (FATAL ERROR: Reached heap limit Allocation failed).
    //
    // Чанки + GC-yield между ними + узкий JSON_EXTRACT дают стабильную память
    // на любом каталоге и быстрый response.
    const CHUNK_SIZE = 500;
    const HARD_CAP_ROWS = 200000; // защитный потолок (на случай аномалии в БД)
    let offset = 0;
    let processed = 0;
    // Если узкий JSON_EXTRACT не сработал на первой итерации (старая MySQL,
    // нет поддержки [*] wildcard) — фолбек на «достать $.components.rows и
    // распарсить в JS», тоже чанками.
    let useNarrowExtract = true;

    try {
        while (processed < HARD_CAP_ROWS) {
            let chunk;
            if (useNarrowExtract) {
                try {
                    const [rows] = await db.query(
                        `SELECT
                             JSON_EXTRACT(
                                 payload_json,
                                 '$.components.rows[*].assortment.code'
                             ) AS codes_json
                         FROM ms_entity_details
                         WHERE kind = 'bundle'
                           AND payload_json IS NOT NULL
                         ORDER BY uuid
                         LIMIT ? OFFSET ?`,
                        [CHUNK_SIZE, offset]
                    );
                    chunk = (rows || []).map((r) => ({ codes_raw: r.codes_json }));
                } catch (eNarrow) {
                    console.warn(
                        '[exports/marketplaces] bundle codes: narrow JSON_EXTRACT failed, fallback to components.rows scan:',
                        eNarrow && eNarrow.message ? eNarrow.message : eNarrow
                    );
                    useNarrowExtract = false;
                    continue; // повторно зайдём с тем же offset, но широким SELECT
                }
            } else {
                const [rows] = await db.query(
                    `SELECT
                         JSON_EXTRACT(payload_json, '$.components.rows') AS components_json
                     FROM ms_entity_details
                     WHERE kind = 'bundle'
                       AND payload_json IS NOT NULL
                     ORDER BY uuid
                     LIMIT ? OFFSET ?`,
                    [CHUNK_SIZE, offset]
                );
                chunk = (rows || []).map((r) => ({ components_raw: r.components_json }));
            }
            if (!chunk.length) break;

            for (const row of chunk) {
                if (useNarrowExtract) {
                    // codes_raw — это JSON-массив строк (или single value),
                    // например ["28543","36490"] или null.
                    const raw = row.codes_raw;
                    if (raw == null) continue;
                    let codes = null;
                    try {
                        if (typeof raw === 'string') codes = JSON.parse(raw);
                        else if (Array.isArray(raw)) codes = raw;
                        else if (typeof raw === 'object') codes = [raw];
                    } catch (_) { codes = null; }
                    if (codes == null) continue;
                    if (!Array.isArray(codes)) codes = [codes];
                    for (const v of codes) {
                        if (v == null) continue;
                        const s = String(v).trim();
                        if (s) out.add(s);
                    }
                } else {
                    // Фолбек: components_raw — это массив объектов component.
                    const raw = row.components_raw;
                    if (raw == null) continue;
                    let compRows = null;
                    try {
                        if (typeof raw === 'string') compRows = JSON.parse(raw);
                        else if (Array.isArray(raw)) compRows = raw;
                        else if (typeof raw === 'object') compRows = raw;
                    } catch (_) { compRows = null; }
                    if (!Array.isArray(compRows)) continue;
                    for (const c of compRows) {
                        const a = c && c.assortment ? c.assortment : null;
                        if (!a) continue;
                        const code = String(
                            a.code != null ? a.code : a.article != null ? a.article : ''
                        ).trim();
                        if (code) out.add(code);
                    }
                }
            }

            processed += chunk.length;
            offset += chunk.length;
            if (chunk.length < CHUNK_SIZE) break;
            // Уступаем event loop — даём GC время освободить временные объекты
            // от JSON.parse предыдущего чанка перед следующим SELECT.
            await new Promise((resolve) => setImmediate(resolve));
        }
    } catch (e) {
        console.warn('[exports/marketplaces] bundle component codes load failed:', e && e.message ? e.message : e);
    }

    return out;
}

async function getBundleComponentCodesCached(db) {
    const now = Date.now();
    if (bundleComponentCodesCache && (now - bundleComponentCodesCache.at) < BUNDLE_COMPONENT_CODES_TTL_MS) {
        return bundleComponentCodesCache.codes;
    }
    if (bundleComponentCodesPromise) return bundleComponentCodesPromise;
    bundleComponentCodesPromise = (async () => {
        try {
            const codes = await loadBundleComponentCodesUncached(db);
            bundleComponentCodesCache = { at: Date.now(), codes };
            return codes;
        } finally {
            bundleComponentCodesPromise = null;
        }
    })();
    return bundleComponentCodesPromise;
}

/**
 * Подтягивает ms_export.manager / content_manager по коду = артикул маркетплейса
 * (offer_id для Ozon / vendor_code для WB / shop_sku для Я.Маркет).
 * Не падает при недоступной БД — просто оставляет поля пустыми.
 */
async function enrichRowsWithMsManagers(db, kind, rows) {
    if (!Array.isArray(rows) || !rows.length) return;
    const externalKey = MARKETPLACE_EXTERNAL_KEY[kind];
    if (!externalKey) return;
    const codes = new Set();
    for (const row of rows) {
        const code = row && row[externalKey] != null ? String(row[externalKey]).trim() : '';
        if (code) codes.add(code);
    }
    if (!codes.size || !db || typeof db.query !== 'function') return;
    const codeList = Array.from(codes);
    const managers = new Map();
    const chunkSize = 1000;
    try {
        for (let i = 0; i < codeList.length; i += chunkSize) {
            const chunk = codeList.slice(i, i + chunkSize);
            const placeholders = chunk.map(() => '?').join(',');
            const [msRows] = await db.query(
                `SELECT code, manager, content_manager FROM ms_export WHERE code IN (${placeholders})`,
                chunk,
            );
            for (const r of msRows || []) {
                const c = r && r.code != null ? String(r.code).trim() : '';
                if (!c) continue;
                managers.set(c, {
                    manager: r.manager == null ? '' : String(r.manager),
                    content_manager: r.content_manager == null ? '' : String(r.content_manager),
                });
            }
        }
    } catch (e) {
        // ms_export может отсутствовать в инсталляции; не блокируем выгрузку.
        return;
    }
    for (const row of rows) {
        const code = row && row[externalKey] != null ? String(row[externalKey]).trim() : '';
        const found = code && managers.get(code);
        if (found) {
            row.manager = found.manager;
            row.content_manager = found.content_manager;
        } else {
            if (row.manager == null) row.manager = '';
            if (row.content_manager == null) row.content_manager = '';
        }
    }
}

function getOzonCreds(appSettings) {
    return {
        clientId: String(process.env.OZON_CLIENT_ID || appSettings.ozon_client_id || '').trim(),
        apiKey: String(process.env.OZON_API_KEY || appSettings.ozon_api_key || '').trim(),
    };
}

function getWbCreds(appSettings) {
    return {
        apiKey: String(process.env.WB_API_KEY || appSettings.wb_api_key || '').trim(),
    };
}

/**
 * Тип WB-токена в кабинете (personal/service/base/test). Передаётся в экспорт только для лога;
 * лимиты WB задаются категорией API (Content / Prices & Discounts / Marketplace), а не этим полем.
 * Источник: process.env.WB_TOKEN_TYPE → app_settings.wb_token_type → 'base'.
 */
function getWbTokenType(appSettings) {
    const raw = String(process.env.WB_TOKEN_TYPE || appSettings.wb_token_type || 'base')
        .trim()
        .toLowerCase();
    if (raw === 'personal' || raw === 'service' || raw === 'test') return raw;
    return 'base';
}

function getYmCreds(appSettings) {
    return {
        apiKey: String(process.env.YM_API_KEY || appSettings.ym_api_key || '').trim(),
        campaignId: String(process.env.YM_CAMPAIGN_ID || appSettings.ym_campaign_id || '').trim(),
        businessId: String(process.env.YM_BUSINESS_ID || appSettings.ym_business_id || '').trim(),
    };
}

function maskSet(v) {
    return Boolean(String(v || '').trim());
}

function parseMsOrDefault(raw, fallback, min) {
    const n = parseInt(raw, 10);
    if (!Number.isFinite(n)) return Math.max(min, fallback);
    return Math.max(min, n);
}

function normalizeShopKind(raw) {
    const s = String(raw || '').trim().toLowerCase();
    if (s === 'ozon') return 'ozon';
    if (s === 'wildberries' || s === 'wb') return 'wb';
    if (s === 'yandex' || s === 'yandex-market' || s === 'yandex_market' || s === 'ym') return 'ym';
    return '';
}

function requireAdminOrSettingsFull(req, res, next) {
    const a = req.datagonActor;
    if (!a) {
        res.status(401).json({ error: 'Не авторизован', code: 'AUTH_REQUIRED' });
        return;
    }
    if (a.username === 'admin') return next();
    const settingsMode = a.page_modes && a.page_modes.settings;
    const marketplacesMode = a.page_modes && a.page_modes['exports-marketplaces'];
    if (settingsMode === 'full' || marketplacesMode === 'full') return next();
    res.status(403).json({
        error: 'Сохранение ключей: только администратор или полный доступ к разделу «Настройки» / «Маркетплейсы».',
        code: 'FORBIDDEN',
    });
}

const syncState = {
    active: false,
    startedAt: null,
    finishedAt: null,
    message: '',
    /** Итог последнего прогона: completed|failed|partial — для auto_sync_runs. */
    resultStatus: null,
    perMarket: {
        ozon: { status: 'idle', count: 0, error: '', updatedAt: '' },
        wb: { status: 'idle', count: 0, error: '', updatedAt: '' },
        ym: { status: 'idle', count: 0, error: '', updatedAt: '' },
    },
};

/** Честный текст для UI / auto_sync_runs: по каждой площадке ✓/×, без голого «Завершено». */
function summarizeMarketplacesSync(perMarket, kinds) {
    const labels = { ozon: 'Ozon', wb: 'WB', ym: 'Я.Маркет' };
    const list = Array.isArray(kinds) && kinds.length ? kinds : ['ozon', 'wb', 'ym'];
    const parts = [];
    let failed = 0;
    let ok = 0;
    for (const k of list) {
        const x = (perMarket && perMarket[k]) || {};
        const label = labels[k] || k;
        if (x.status === 'completed') {
            ok += 1;
            const n = Number(x.count) || 0;
            const ts = x.updatedAt ? ` @${x.updatedAt}` : '';
            parts.push(`${label}: ✓ ${n}${ts}`);
        } else if (x.status === 'failed') {
            failed += 1;
            const err = String(x.error || 'ошибка').replace(/\s+/g, ' ').trim().slice(0, 120);
            parts.push(`${label}: × ${err}`);
        } else {
            parts.push(`${label}: ${x.status || '—'}`);
        }
    }
    const head =
        failed === 0
            ? 'Завершено'
            : ok === 0
              ? 'Ошибка'
              : 'Частично';
    return `${head}: ${parts.join(' · ')}`.slice(0, 480);
}

function marketplacesResultStatus(perMarket, kinds) {
    const list = Array.isArray(kinds) && kinds.length ? kinds : ['ozon', 'wb', 'ym'];
    let failed = 0;
    let ok = 0;
    for (const k of list) {
        const st = (perMarket && perMarket[k] && perMarket[k].status) || '';
        if (st === 'completed') ok += 1;
        else if (st === 'failed') failed += 1;
    }
    if (failed === 0 && ok > 0) return 'completed';
    if (ok === 0 && failed > 0) return 'failed';
    if (failed > 0 && ok > 0) return 'partial';
    return 'failed';
}

function resetSyncState() {
    syncState.active = true;
    syncState.startedAt = new Date().toISOString();
    syncState.finishedAt = null;
    syncState.resultStatus = null;
    syncState.message = 'Запуск обновления маркетплейсов...';
    syncState.perMarket = {
        ozon: { status: 'pending', count: 0, error: '', updatedAt: '' },
        wb: { status: 'pending', count: 0, error: '', updatedAt: '' },
        ym: { status: 'pending', count: 0, error: '', updatedAt: '' },
    };
}

module.exports = function exportsMarketplacesRouter(db, appSettings) {
    const router = express.Router();
    // На чистом стенде ensureSchema для `ms_dimensions_measurements` идемпотентен
    // (CREATE TABLE IF NOT EXISTS). Запускаем в фоне при инициализации роутера,
    // чтобы не зависеть от порядка mount'a с `/api/exports/dimensions` в server.js
    // (таблица нужна странице «Габариты», не SELECT `/issues`).
    try {
        const { ensureSchema: ensureDimensionsSchema } = require('./dimensions');
        if (typeof ensureDimensionsSchema === 'function') {
            ensureDimensionsSchema(db).catch((e) => {
                console.error(
                    '[exports/marketplaces] ensure ms_dimensions_measurements schema:',
                    e && e.message
                );
            });
        }
    } catch (eEnsure) {
        console.error('[exports/marketplaces] cannot import dimensions ensureSchema:', eEnsure && eEnsure.message);
    }
    /**
     * Порядок ключей в этих объектах ВАЖЕН: на ответе snapshot и CSV колонки
     * выкладываются в том же порядке (см. handleSnapshot — Object.keys(titles)).
     * Согласовано с headerKeys в lib/marketplaceExports.js: артикул → название → менеджеры.
     */
    const titlesByKind = {
        ozon: {
            offer_id: 'Артикул (offer_id) Ozon',
            name: 'Наименование Ozon',
            manager: 'Менеджер',
            content_manager: 'Контент-менеджер',
            price: 'Цена Ozon',
            vat: 'НДС Ozon',
            status: 'Статус Ozon',
            block_reason: 'Причина блокировки Ozon',
            stock: 'Остаток Ozon',
            length_cm: 'Длина (см) Ozon',
            width_cm: 'Ширина (см) Ozon',
            height_cm: 'Высота (см) Ozon',
            weight_kg: 'Вес (кг) Ozon',
            cabinet_url: 'Кабинет Ozon',
            buyer_url: 'Покупателю Ozon',
            updated: 'Обновлено Ozon',
        },
        wb: {
            vendor_code: 'Артикул продавца WB',
            title: 'Наименование WB',
            manager: 'Менеджер',
            content_manager: 'Контент-менеджер',
            price: 'Цена WB',
            vat: 'НДС WB',
            stock: 'Остаток WB',
            length_cm: 'Длина (см) WB',
            width_cm: 'Ширина (см) WB',
            height_cm: 'Высота (см) WB',
            weight_kg: 'Вес (кг) WB',
            cabinet_url: 'Кабинет WB',
            buyer_url: 'Покупателю WB',
            updated: 'Обновлено WB',
        },
        ym: {
            shop_sku: 'Артикул Я.Маркет',
            name: 'Наименование Я.Маркет',
            manager: 'Менеджер',
            content_manager: 'Контент-менеджер',
            price: 'Цена Я.Маркет',
            vat: 'НДС Я.Маркет',
            stock_fit: 'Остаток Я.Маркет',
            length: 'Длина (см) Я.Маркет',
            width: 'Ширина (см) Я.Маркет',
            height: 'Высота (см) Я.Маркет',
            weight: 'Вес (кг) Я.Маркет',
            cabinet_url: 'Кабинет Я.Маркет',
            buyer_url: 'Покупателю Я.Маркет',
            updated: 'Обновлено Я.Маркет',
        },
    };

    router.get('/status', (req, res) => {
        const ozon = getOzonCreds(appSettings);
        const wb = getWbCreds(appSettings);
        const ym = getYmCreds(appSettings);
        const wbTokenType = getWbTokenType(appSettings);
        res.json({
            configured: {
                ozon: maskSet(ozon.clientId) && maskSet(ozon.apiKey),
                wildberries: maskSet(wb.apiKey),
                yandex_market: maskSet(ym.apiKey) && maskSet(ym.campaignId),
            },
            wb_token_type: wbTokenType,
            /** Всегда false: цены не отрезаются по типу токена (лимиты разные у категорий API «Цены и скидки» и «Маркетплейс»). Поле оставлено для совместимости клиентов. */
            wb_prices_disabled_by_token: false,
            /** Паузы между запросами не опускаются ниже этих значений; при 429/503 — повтор с учётом Retry-After (см. lib/marketplaceExports.js). */
            rate_limits_ms_min: MP_MIN_DELAY_MS,
            delay_defaults_ms: {
                ozon: parseMsOrDefault(appSettings.mp_ozon_delay_ms, 400, MP_MIN_DELAY_MS.ozon),
                wb_cards: parseMsOrDefault(appSettings.mp_wb_delay_cards_ms, 600, MP_MIN_DELAY_MS.wbCards),
                wb_other: parseMsOrDefault(appSettings.mp_wb_delay_other_ms, 1600, MP_MIN_DELAY_MS.wbPricesStocks),
                yandex: parseMsOrDefault(appSettings.mp_yandex_delay_ms, 280, MP_MIN_DELAY_MS.yandex),
            },
            hints: {
                env: 'Можно задать переменные окружения: OZON_CLIENT_ID, OZON_API_KEY, WB_API_KEY, WB_TOKEN_TYPE (personal|service|base|test), YM_API_KEY, YM_CAMPAIGN_ID, YM_BUSINESS_ID (опционально для ссылки покупателю).',
                settings:
                    'Либо ключи/лимиты в БД через POST /api/exports/marketplaces/config (см. api.md): ozon_client_id, ozon_api_key, wb_api_key, wb_token_type, ym_api_key, ym_campaign_id, ym_business_id, mp_ozon_delay_ms, mp_wb_delay_cards_ms, mp_wb_delay_other_ms, mp_yandex_delay_ms.',
                pacing:
                    'Query delay_* можно только увеличить относительно дефолта; жёсткий минимум в rate_limits_ms_min. Лимиты кабинетов уточняйте в официальной документации маркетплейсов.',
                wb_token_types:
                    'Тип токена в кабинете WB (personal|service|base|test) — для справки и подстройки пауз; цены и остатки идут в разные API. Таблица «Маркетплейс» (150/мин, 200 мс для Базового) относится к marketplace-api (остатки). Цены — discounts-prices-api, категория «Цены и скидки» (в OpenAPI для GET list/goods/filter — лимит категории, не тот же, что у Маркетплейса). При 429 увеличьте mp_wb_delay_other_ms.',
            },
        });
    });

    /**
     * Сохранение ключей маркетплейсов в app_settings (как прочие настройки).
     * Тело: частичное JSON — передавайте только поля, которые нужно обновить.
     */
    router.post('/config', requireAdminOrSettingsFull, async (req, res) => {
        const b = req.body || {};
        const allowed = [
            'ozon_client_id',
            'ozon_api_key',
            'wb_api_key',
            'wb_token_type',
            'ym_api_key',
            'ym_campaign_id',
            'ym_business_id',
            'mp_ozon_delay_ms',
            'mp_wb_delay_cards_ms',
            'mp_wb_delay_other_ms',
            'mp_yandex_delay_ms',
        ];
        const updates = [];
        for (const key of allowed) {
            if (b[key] !== undefined) {
                const val = String(b[key] ?? '').slice(0, 8000);
                updates.push([key, val]);
            }
        }
        if (!updates.length) {
            return res.status(400).json({ error: 'Нет полей для сохранения', code: 'EMPTY_BODY' });
        }
        try {
            if (!db || typeof db.query !== 'function') {
                return res.status(500).json({ error: 'БД недоступна', code: 'NO_DB' });
            }
            for (const [key, val] of updates) {
                await db.query(
                    'INSERT INTO app_settings (setting_key, setting_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE setting_value=?',
                    [key, val, val],
                );
                appSettings[key] = val;
            }
            return res.json({ success: true, saved_keys: updates.map((x) => x[0]) });
        } catch (e) {
            return res.status(500).json({ error: e.message || String(e) });
        }
    });

    router.use((req, res, next) => {
        if (!req.datagonActor) {
            res.status(401).json({ error: 'Не авторизован', code: 'AUTH_REQUIRED' });
            return;
        }
        next();
    });

    router.get('/snapshot', async (req, res) => {
        try {
            const kind = normalizeShopKind(req.query.shop);
            if (!kind) {
                return res.status(400).json({ error: 'Неверный параметр shop', code: 'BAD_SHOP' });
            }
            const titles = titlesByKind[kind];
            const headerKeys = Object.keys(titles);
            const headerLabels = headerKeys.map((k) => titles[k] || k);
            // По умолчанию отдаём весь снапшот (до 25k); пагинация — клиентская.
            const maxItems = parseInt(req.query.max_items, 10);
            const limit = Number.isFinite(maxItems) && maxItems > 0 ? maxItems : 25000;
            const sourceRows = await loadMarketplaceSnapshotRows(db, kind, limit);
            const rows = sourceRows.map((row) => {
                let base = null;
                try {
                    base = row && row.row_json ? JSON.parse(row.row_json) : null;
                } catch (eJson) {
                    base = null;
                }
                const obj = base && typeof base === 'object' ? Object.assign({}, base) : {};
                if (kind === 'ozon') {
                    obj.name = obj.name || row.name || '';
                    obj.stock = obj.stock != null ? obj.stock : row.stock;
                    obj.length_cm = obj.length_cm || row.length_cm || '';
                    obj.width_cm = obj.width_cm || row.width_cm || '';
                    obj.height_cm = obj.height_cm || row.height_cm || '';
                    obj.weight_kg = obj.weight_kg || row.weight_kg || '';
                    obj.status = obj.status || row.status || '';
                    obj.block_reason = obj.block_reason || row.block_reason || '';
                } else if (kind === 'wb') {
                    obj.title = obj.title || row.name || '';
                    obj.stock = obj.stock != null ? obj.stock : row.stock;
                    obj.length_cm = obj.length_cm || row.length_cm || '';
                    obj.width_cm = obj.width_cm || row.width_cm || '';
                    obj.height_cm = obj.height_cm || row.height_cm || '';
                    obj.weight_kg = obj.weight_kg || row.weight_kg || '';
                } else {
                    obj.name = obj.name || row.name || '';
                    obj.stock_fit = obj.stock_fit != null ? obj.stock_fit : row.stock;
                    obj.length = obj.length || row.length_cm || '';
                    obj.width = obj.width || row.width_cm || '';
                    obj.height = obj.height || row.height_cm || '';
                    obj.weight = obj.weight || row.weight_kg || '';
                }
                obj.price = obj.price || row.price || '';
                obj.vat = prettifyMarketplaceVat(kind, obj.vat != null && obj.vat !== '' ? obj.vat : row.vat);
                obj.cabinet_url = obj.cabinet_url || row.cabinet_url || '';
                obj.buyer_url = obj.buyer_url || row.buyer_url || '';
                obj.updated = obj.updated || row.updated_label || '';
                if (obj.manager == null) obj.manager = '';
                if (obj.content_manager == null) obj.content_manager = '';
                return obj;
            });
            await enrichRowsWithMsManagers(db, kind, rows);
            const updatedAt = rows.length ? rows[0].updated || '' : '';
            const note =
                rows.length === 0
                    ? (() => {
                          const credsOk =
                              kind === 'ozon'
                                  ? maskSet(getOzonCreds(appSettings).clientId) &&
                                    maskSet(getOzonCreds(appSettings).apiKey)
                                  : kind === 'wb'
                                    ? maskSet(getWbCreds(appSettings).apiKey)
                                    : maskSet(getYmCreds(appSettings).apiKey) &&
                                      maskSet(getYmCreds(appSettings).campaignId);
                          return credsOk
                              ? 'Сохранённого снапшота нет. Запустите «Обновить из маркетплейса».'
                              : 'Сохранённого снапшота нет, и ключи маркетплейса не заданы (см. «Маркетплейсы → Настройки»).';
                      })()
                    : '';
            return res.json({
                marketplace: kind,
                source: 'snapshot',
                updatedAt,
                count: rows.length,
                headers: headerKeys,
                headerLabels,
                rows,
                note,
            });
        } catch (e) {
            console.error('[exports/marketplaces] snapshot failed:', e && e.stack ? e.stack : e);
            return res.status(500).json({ error: e.message || String(e), code: 'SNAPSHOT_FAILED' });
        }
    });

    async function handleExport(req, res, kind, runner, csvTitleRuByKey) {
        const formatRaw = String(req.query.format || 'json').toLowerCase();
        const stream = formatRaw === 'ndjson' || String(req.query.stream || '') === '1';
        const format = formatRaw === 'csv' ? 'csv' : 'json';
        // По умолчанию тянем весь каталог продавца (до 25000) — в кабинетах с >5000
        // карточек прежний дефолт 5000 необоснованно обрезал данные.
        // Чтобы ограничить выдачу — передайте `?max_items=N`.
        const maxItems = Math.max(1, Math.min(parseInt(req.query.max_items || '25000', 10) || 25000, 25000));

        // В режиме потоковой отдачи каждый шаг логгера сразу уходит клиенту
        // отдельной строкой NDJSON (`{"type":"step", ...}`). Финальная строка —
        // `{"type":"result", ...}` или `{"type":"error", ...}`. Это то же самое,
        // что обычный JSON-ответ, только разнесённый во времени.
        let onStep = null;
        if (stream) {
            res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
            res.setHeader('Cache-Control', 'no-cache, no-transform');
            res.setHeader('X-Accel-Buffering', 'no');
            res.setHeader('Connection', 'keep-alive');
            if (typeof res.flushHeaders === 'function') res.flushHeaders();
            onStep = (step) => {
                if (res.writableEnded) return;
                try {
                    res.write(JSON.stringify({ type: 'step', step }) + '\n');
                } catch (_) {}
            };
            req.on('close', () => {
                /* клиент ушёл — серверная работа продолжится, но писать
                   уже некуда; флаг writableEnded нас защитит от EPIPE. */
            });
        }

        const logger = createMarketplaceLogger(kind, onStep);
        const httpUser = (req.headers['x-auth-username'] || '').toString();
        logger.log('http:request', { format: stream ? 'ndjson' : format, maxItems, ip: req.ip, user: httpUser || null });
        try {
            const creds =
                kind === 'ozon'
                    ? getOzonCreds(appSettings)
                    : kind === 'wb'
                      ? getWbCreds(appSettings)
                      : getYmCreds(appSettings);
            const opts =
                kind === 'ozon'
                    ? {
                          maxItems,
                          includeArchived: String(req.query.include_archived || '') === '1',
                          delayMs: parseMsOrDefault(
                              req.query.delay_ms || appSettings.mp_ozon_delay_ms,
                              400,
                              MP_MIN_DELAY_MS.ozon,
                          ),
                          logger,
                      }
                    : kind === 'wb'
                      ? {
                            maxItems,
                            delayCards: parseMsOrDefault(
                                req.query.delay_cards || appSettings.mp_wb_delay_cards_ms,
                                600,
                                MP_MIN_DELAY_MS.wbCards,
                            ),
                            delayOther: parseMsOrDefault(
                                req.query.delay_other || appSettings.mp_wb_delay_other_ms,
                                1600,
                                MP_MIN_DELAY_MS.wbPricesStocks,
                            ),
                            tokenType: getWbTokenType(appSettings),
                            logger,
                        }
                      : {
                            maxItems,
                            delayMs: parseMsOrDefault(
                                req.query.delay_ms || appSettings.mp_yandex_delay_ms,
                                280,
                                MP_MIN_DELAY_MS.yandex,
                            ),
                            logger,
                        };
            const { headerKeys, rows, updatedAt } = await runner(creds, opts);
            for (const row of rows) {
                if (row && Object.prototype.hasOwnProperty.call(row, 'vat')) {
                    row.vat = prettifyMarketplaceVat(kind, row.vat);
                }
            }
            logger.log('step:enrich:start');
            await enrichRowsWithMsManagers(db, kind, rows);
            logger.log('step:enrich:done');
            logger.log('step:persist:start', { total: rows.length });
            const persisted = await persistMarketplaceRows(db, kind, rows, updatedAt, {
                chunkSize: 200,
                onProgress: ({ saved, total }) => {
                    logger.log('step:persist:progress', { saved, total });
                },
            });
            logger.log('step:persist:done', { persisted });

            if (format === 'csv' && !stream) {
                const titles = headerKeys.map((k) => csvTitleRuByKey[k] || k);
                const matrix = rowObjectsToMatrix(headerKeys, rows);
                const csv = rowsToCsvSemicolon(titles, matrix);
                const fname = `datagon-${kind}-export-${updatedAt.replace(/[^\d]/g, '')}.csv`;
                res.setHeader('Content-Type', 'text/csv; charset=utf-8');
                res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
                logger.log('http:response', { format: 'csv', rows: rows.length });
                return res.send(csv);
            }
            const headerLabels = headerKeys.map((k) => csvTitleRuByKey[k] || k);
            logger.log('http:response', { format: stream ? 'ndjson' : 'json', rows: rows.length, persisted });
            const payload = {
                marketplace: kind,
                updatedAt,
                count: rows.length,
                persisted_count: persisted,
                headers: headerKeys,
                headerLabels,
                rows,
                summary: logger.summary(),
            };
            if (stream) {
                if (!res.writableEnded) {
                    res.write(JSON.stringify({ type: 'result', payload }) + '\n');
                    res.end();
                }
                return undefined;
            }
            return res.json(payload);
        } catch (e) {
            const code = e.code || 'EXPORT_FAILED';
            const status = code === 'MISSING_CREDS' ? 400 : 502;
            logger.log('error', {
                code,
                status,
                upstream_status: e && e.response && e.response.status ? e.response.status : null,
                message: e && e.message ? e.message : String(e),
            });
            console.error(
                `[exports/marketplaces] live ${kind} failed:`,
                e && e.response && e.response.status ? `HTTP ${e.response.status}` : '',
                e && e.message ? e.message : e,
            );
            if (e && e.response && e.response.data) {
                try {
                    console.error(
                        `[exports/marketplaces] response body:`,
                        typeof e.response.data === 'string'
                            ? e.response.data.slice(0, 500)
                            : JSON.stringify(e.response.data).slice(0, 500),
                    );
                } catch (_) {}
            }
            const apiStatus = e && e.response && e.response.status;
            const apiBody = e && e.response && e.response.data;
            const apiMsg =
                (apiBody && (apiBody.errorText || apiBody.message || apiBody.error)) ||
                (typeof apiBody === 'string' ? apiBody.slice(0, 200) : '') ||
                '';
            const labelByKind = { ozon: 'Ozon', wb: 'Wildberries', ym: 'Я.Маркет' };
            const mpName = labelByKind[kind] || kind.toUpperCase();
            let friendly;
            if (apiStatus === 429 || apiStatus === 420) {
                friendly = `${mpName} вернул ${apiStatus} (rate limit) — превышен лимит запросов. Подождите 1–2 минуты и попробуйте снова. Если повторяется — увеличьте паузу в «Настройки → Маркетплейсы → задержка между запросами».`;
            } else if (apiStatus && apiStatus >= 500) {
                friendly = `${mpName} вернул ${apiStatus}${apiMsg ? `: ${apiMsg}` : ''} (временный сбой на стороне маркетплейса). Попробуйте ещё раз через минуту.`;
            } else if (apiStatus) {
                friendly = `${mpName} вернул ${apiStatus}${apiMsg ? `: ${apiMsg}` : ''}.`;
            } else {
                friendly = e.message || String(e);
            }
            const errorPayload = {
                error: friendly,
                code,
                upstream_status: apiStatus || null,
                summary: logger.summary(),
            };
            if (stream) {
                if (!res.writableEnded) {
                    // Заголовки уже отправлены статусом 200 (мы сразу начали стримить),
                    // поэтому статус ошибки передаём внутри NDJSON-кадра, а не в HTTP.
                    res.write(JSON.stringify({ type: 'error', http_status: status, payload: errorPayload }) + '\n');
                    res.end();
                }
                return undefined;
            }
            return res.status(status).json(errorPayload);
        }
    }

    async function runSingleRefresh(kind) {
        const creds =
            kind === 'ozon'
                ? getOzonCreds(appSettings)
                : kind === 'wb'
                  ? getWbCreds(appSettings)
                  : getYmCreds(appSettings);
        const logger = createMarketplaceLogger(kind);
        logger.log('scheduler:start');
        const opts =
            kind === 'ozon'
                ? {
                      maxItems: 25000,
                      includeArchived: Number(appSettings.mp_ozon_include_archived || 0) === 1,
                      delayMs: parseMsOrDefault(appSettings.mp_ozon_delay_ms, 400, MP_MIN_DELAY_MS.ozon),
                      logger,
                  }
                : kind === 'wb'
                  ? {
                        maxItems: 25000,
                        delayCards: parseMsOrDefault(appSettings.mp_wb_delay_cards_ms, 600, MP_MIN_DELAY_MS.wbCards),
                        delayOther: parseMsOrDefault(
                            appSettings.mp_wb_delay_other_ms,
                            1600,
                            MP_MIN_DELAY_MS.wbPricesStocks
                        ),
                        tokenType: getWbTokenType(appSettings),
                        logger,
                    }
                  : {
                        maxItems: 25000,
                        delayMs: parseMsOrDefault(appSettings.mp_yandex_delay_ms, 280, MP_MIN_DELAY_MS.yandex),
                        logger,
                    };
        const runner =
            kind === 'ozon' ? exportOzonRows : kind === 'wb' ? exportWildberriesRows : exportYandexMarketRows;
        const { rows, updatedAt } = await runner(creds, opts);
        for (const row of rows) {
            if (row && Object.prototype.hasOwnProperty.call(row, 'vat')) {
                row.vat = prettifyMarketplaceVat(kind, row.vat);
            }
        }
        logger.log('scheduler:enrich:start');
        await enrichRowsWithMsManagers(db, kind, rows);
        logger.log('scheduler:enrich:done');
        logger.log('scheduler:persist:start', { total: rows.length });
        const persisted = await persistMarketplaceRows(db, kind, rows, updatedAt, {
            chunkSize: 200,
            onProgress: ({ saved, total }) => {
                logger.log('scheduler:persist:progress', { saved, total });
            },
        });
        logger.log('scheduler:persist:done', { persisted });
        logger.log('scheduler:done', { rows: rows.length, updatedAt });
        return { persisted, count: rows.length, updatedAt };
    }

    async function triggerRefreshMarkets(kindRaw = 'all', autoMeta = {}) {
        const kind = String(kindRaw || 'all').trim().toLowerCase();
        const kinds = kind === 'all' ? ['ozon', 'wb', 'ym'] : [normalizeShopKind(kind)];
        if (!kinds[0]) return { started: false, reason: 'bad_shop' };
        if (syncState.active) return { started: false, reason: 'already_running' };
        resetSyncState();
        try {
            for (const k of kinds) {
                syncState.message = `Обновление ${k}...`;
                syncState.perMarket[k] = { status: 'running', count: 0, error: '' };
                try {
                    const res = await runSingleRefresh(k);
                    syncState.perMarket[k] = {
                        status: 'completed',
                        count: Number(res.persisted || res.count || 0),
                        updatedAt: res.updatedAt || '',
                        error: '',
                    };
                } catch (eOne) {
                    console.error(
                        `[exports/marketplaces] refresh ${k} failed:`,
                        eOne && eOne.stack ? eOne.stack : eOne
                    );
                    syncState.perMarket[k] = {
                        status: 'failed',
                        count: 0,
                        updatedAt: '',
                        error: eOne.message || String(eOne),
                    };
                }
            }
            syncState.active = false;
            syncState.finishedAt = new Date().toISOString();
            syncState.message = summarizeMarketplacesSync(syncState.perMarket, kinds);
            syncState.resultStatus = marketplacesResultStatus(syncState.perMarket, kinds);
            try {
                const m = autoMeta && typeof autoMeta === 'object' ? autoMeta : {};
                await appendMarketplaceIssuesSnapshot(db, appSettings, {
                    triggerType: String(m.triggerType || 'manual').slice(0, 24),
                    scheduleSlotTime: String(m.scheduleSlotTime || '').slice(0, 8),
                });
            } catch (eSnap) {
                console.error(
                    '[exports/marketplaces] issues snapshot after sync failed:',
                    eSnap && eSnap.stack ? eSnap.stack : eSnap
                );
            }
            return { started: true };
        } catch (e) {
            syncState.active = false;
            syncState.finishedAt = new Date().toISOString();
            syncState.message = e.message || String(e);
            return { started: false, reason: 'failed', error: e.message || String(e) };
        }
    }

    exportsMarketplacesRouter.triggerSync = triggerRefreshMarkets;
    exportsMarketplacesRouter.getSyncState = function getSyncState() {
        return JSON.parse(JSON.stringify(syncState));
    };

    router.get('/sync-status', (_req, res) => {
        return res.json(exportsMarketplacesRouter.getSyncState());
    });

    router.post('/sync', requireAdminOrSettingsFull, async (req, res) => {
        const shop = String((req.body && req.body.shop) || 'all').trim().toLowerCase();
        const r = await triggerRefreshMarkets(shop || 'all');
        if (!r.started) {
            const code = r.reason === 'already_running' ? 409 : 400;
            return res.status(code).json({ error: r.error || r.reason || 'Не удалось запустить', code: r.reason || 'FAILED' });
        }
        return res.json({ success: true, started: true });
    });

    router.get('/ozon', (req, res) => handleExport(req, res, 'ozon', exportOzonRows, titlesByKind.ozon));
    router.get('/wildberries', (req, res) => handleExport(req, res, 'wb', exportWildberriesRows, titlesByKind.wb));
    router.get('/yandex-market', (req, res) => handleExport(req, res, 'ym', exportYandexMarketRows, titlesByKind.ym));

    /**
     * Неопубликованные товары МойСклад.
     *
     * Возвращает строки из ms_export, у которых нет соответствующей записи
     * в marketplace_export_rows.external_id для выбранного scope:
     *   - shop=any (default) — ни на одном из (ozon/wildberries/yandex_market);
     *   - shop=ozon|wb|ym    — на указанном маркетплейсе.
     *
     * Источник: последний снапшот, который кладёт persistMarketplaceRows
     * после «Обновить из маркетплейса» / scheduler. То есть «опубликовано»
     * здесь = «есть в последнем снапшоте кабинета». Если ни один маркетплейс
     * ни разу не обновлялся, all-страница покажет весь ms_export.
     */
    router.get('/unpublished', async (req, res) => {
        try {
            if (!db || typeof db.query !== 'function') {
                return res.status(500).json({ error: 'БД недоступна', code: 'NO_DB' });
            }
            const scopeRaw = String(req.query.shop || 'any').trim().toLowerCase();
            const scopeMap = {
                any: { sqlMarketplace: null, label: 'нет ни на одном маркетплейсе' },
                ozon: { sqlMarketplace: 'ozon', label: 'нет на Ozon' },
                wb: { sqlMarketplace: 'wildberries', label: 'нет на Wildberries' },
                wildberries: { sqlMarketplace: 'wildberries', label: 'нет на Wildberries' },
                ym: { sqlMarketplace: 'yandex_market', label: 'нет на Я.Маркет' },
                yandex: { sqlMarketplace: 'yandex_market', label: 'нет на Я.Маркет' },
                'yandex-market': { sqlMarketplace: 'yandex_market', label: 'нет на Я.Маркет' },
                yandex_market: { sqlMarketplace: 'yandex_market', label: 'нет на Я.Маркет' },
            };
            const scope = scopeMap[scopeRaw];
            if (!scope) {
                return res.status(400).json({ error: 'Неверный scope shop', code: 'BAD_SCOPE' });
            }

            const maxItemsRaw = parseInt(req.query.max_items, 10);
            const maxItems = Number.isFinite(maxItemsRaw) && maxItemsRaw > 0
                ? Math.min(maxItemsRaw, 50000)
                : 25000;

            const baseCols = `
                ms_export.code AS code,
                ms_export.name AS name,
                ms_export.manager AS manager,
                ms_export.content_manager AS content_manager,
                ms_export.vat AS vat,
                ms_export.sale_price AS sale_price,
                ms_export.stock AS stock,
                ms_export.supplier AS supplier,
                ms_export.updated_label AS updated_label,
                DATE_FORMAT(ms_export.synced_at, '%d.%m.%Y %H:%i') AS synced_at
            `;
            const whereNotExists = scope.sqlMarketplace
                ? `WHERE NOT EXISTS (
                       SELECT 1 FROM marketplace_export_rows mer
                       WHERE mer.marketplace = ? AND mer.external_id = ms_export.code
                   )`
                : `WHERE NOT EXISTS (
                       SELECT 1 FROM marketplace_export_rows mer
                       WHERE mer.external_id = ms_export.code
                   )`;
            const params = scope.sqlMarketplace ? [scope.sqlMarketplace, maxItems] : [maxItems];
            const sql = `
                SELECT ${baseCols}
                FROM ms_export
                ${whereNotExists}
                ORDER BY ms_export.code
                LIMIT ?
            `;

            const [rows] = await db.query(sql, params);
            const headers = ['code', 'name', 'manager', 'content_manager', 'vat', 'sale_price', 'stock', 'supplier', 'updated_label', 'synced_at'];
            const headerLabels = [
                'Артикул МС',
                'Наименование',
                'Менеджер',
                'Контент-менеджер',
                'НДС',
                'Цена продажи',
                'Остаток',
                'Поставщик',
                'Обновлено в МС',
                'Синхронизация',
            ];
            return res.json({
                scope: scopeRaw === 'wildberries' ? 'wb' : scopeRaw === 'yandex_market' || scopeRaw === 'yandex' || scopeRaw === 'yandex-market' ? 'ym' : scopeRaw,
                scope_label: scope.label,
                marketplace: scope.sqlMarketplace || null,
                count: rows.length,
                headers,
                headerLabels,
                rows,
            });
        } catch (e) {
            console.error('[exports/marketplaces] unpublished failed:', e && e.stack ? e.stack : e);
            return res.status(500).json({ error: e.message || String(e), code: 'UNPUBLISHED_FAILED' });
        }
    });

    const ISSUES_DIM_EPS = 0.02;

    /** Календарная дата (МСК) для снимка проблем маркетплейсов — YYYY-MM-DD */
    function moscowStatDateYmd() {
        return new Intl.DateTimeFormat('sv-SE', {
            timeZone: 'Europe/Moscow',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
        }).format(new Date());
    }

    /** Колонка DATE (день учёта по МСК) → DD.MM.YYYY без сдвига из-за UTC в Node. */
    function formatSnapshotStatDateDisplay(raw) {
        if (raw == null || raw === '') return '';
        const head = String(raw).split('T')[0].split(' ')[0].trim();
        const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(head);
        if (m) return `${m[3]}.${m[2]}.${m[1]}`;
        if (raw instanceof Date) {
            const s = new Intl.DateTimeFormat('sv-SE', {
                timeZone: 'Europe/Moscow',
                year: 'numeric',
                month: '2-digit',
                day: '2-digit',
            }).format(raw);
            const parts = s.split('-');
            if (parts.length === 3) return `${parts[2]}.${parts[1]}.${parts[0]}`;
        }
        return head;
    }

    /** TIMESTAMP из БД (часто как UTC в Node) → строка даты/времени по Москве. */
    function formatSnapshotRecordedAtMskDisplay(raw) {
        if (raw == null || raw === '') return '';
        const d = raw instanceof Date ? raw : new Date(raw);
        if (Number.isNaN(d.getTime())) return String(raw);
        const s = new Intl.DateTimeFormat('ru-RU', {
            timeZone: 'Europe/Moscow',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: false,
        }).format(d);
        return `${String(s).replace(/\//g, '.')} МСК`;
    }

    let mpIssuesSnapshotTableReady = false;
    async function ensureMpIssuesSnapshotTable(dbConn) {
        if (!dbConn || typeof dbConn.query !== 'function') return;
        if (mpIssuesSnapshotTableReady) return;
        await dbConn.query(`
            CREATE TABLE IF NOT EXISTS mp_issues_daily_snapshot (
                id BIGINT AUTO_INCREMENT PRIMARY KEY,
                stat_date DATE NOT NULL COMMENT 'Календарный день (МСК)',
                recorded_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                trigger_type VARCHAR(24) NOT NULL DEFAULT 'manual',
                schedule_slot_time VARCHAR(8) NOT NULL DEFAULT '' COMMENT 'HH:mm из настроек автосинка маркетплейсов (если trigger=schedule)',
                scope VARCHAR(32) NOT NULL DEFAULT 'any',
                exclude_bundle_components TINYINT(1) NOT NULL DEFAULT 1,
                total_count INT NOT NULL DEFAULT 0,
                by_manager_json LONGTEXT NOT NULL,
                by_content_manager_json LONGTEXT NOT NULL,
                removed_by_bundle_filter INT NOT NULL DEFAULT 0,
                INDEX idx_mpids_stat_date (stat_date),
                INDEX idx_mpids_recorded (recorded_at)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        `);
        try {
            await dbConn.query(
                'ALTER TABLE mp_issues_daily_snapshot MODIFY by_manager_json LONGTEXT NOT NULL'
            );
            await dbConn.query(
                'ALTER TABLE mp_issues_daily_snapshot MODIFY by_content_manager_json LONGTEXT NOT NULL'
            );
        } catch (_) {
            /* таблицы могло не быть в старых инсталляциях; колонки уже LONGTEXT */
        }
        mpIssuesSnapshotTableReady = true;
    }

    /** Счётчики по полю строки /issues (пустое → «(не указано)»). */
    function bucketFieldCounts(rows, fieldKey) {
        const m = new Map();
        for (const r of rows || []) {
            const raw = r && r[fieldKey] != null ? String(r[fieldKey]).trim() : '';
            const k = raw || '(не указано)';
            m.set(k, (m.get(k) || 0) + 1);
        }
        const out = {};
        const keys = Array.from(m.keys()).sort((a, b) => {
            const ca = m.get(b) - m.get(a);
            if (ca !== 0) return ca;
            return String(a).localeCompare(String(b), 'ru');
        });
        for (const k of keys) out[k] = m.get(k);
        return out;
    }

    function parseExportDimNumber(v) {
        const s = String(v == null ? '' : v).trim().replace(',', '.');
        if (!s) return null;
        const n = parseFloat(s);
        return Number.isFinite(n) ? n : null;
    }

    /** Кортеж габаритов из строки /issues (после SELECT). prefix: ozon|wb|ym */
    function issuesDimTuple(row, prefix) {
        return [
            parseExportDimNumber(row[`${prefix}_length`]),
            parseExportDimNumber(row[`${prefix}_width`]),
            parseExportDimNumber(row[`${prefix}_height`]),
            parseExportDimNumber(row[`${prefix}_weight`]),
        ];
    }

    /** Слот считается «расходящимся» только если обе стороны — числа и |a−b| > eps.
     * «Число vs пусто» не расхождение (иначе в UI подсвечивается почти вся сетка габаритов). */
    function issuesDimTuplesDiffer(a, b) {
        for (let i = 0; i < 4; i += 1) {
            if (a[i] == null || b[i] == null) continue;
            if (Math.abs(a[i] - b[i]) > ISSUES_DIM_EPS) return true;
        }
        return false;
    }

    /** Есть ли у МС хотя бы одно числовое значение габарита/веса (источник —
     * денорм `ms_entity_details.denorm_dim_*` или fallback из payload attributes). */
    function issuesRowHasMsDims(row) {
        return (
            parseExportDimNumber(row.ms_length) != null
            || parseExportDimNumber(row.ms_width) != null
            || parseExportDimNumber(row.ms_height_box) != null
            || parseExportDimNumber(row.ms_height_bag) != null
            || parseExportDimNumber(row.ms_weight) != null
        );
    }

    /**
     * Сравнение линейных размеров (см). WB L/W/H в API — целые см (`Math.round`),
     * поэтому 2.5 в МС и 3 на WB — совпадение. Вес сюда не передавать.
     * Паритет: lib/mpIssuesRowFilters.js → issuesDimSizeEqual.
     */
    function issuesDimSizeEqual(msVal, mpVal, marketplace) {
        if (msVal == null || mpVal == null) return false;
        const kind = String(marketplace || '').toLowerCase();
        if (kind === 'wb' || kind === 'wildberries') {
            return Math.round(msVal) === Math.round(mpVal);
        }
        return Math.abs(msVal - mpVal) <= ISSUES_DIM_EPS;
    }

    /** Есть ли расхождение МС ↔ маркетплейс по любой оси (длина/ширина/высота/вес).
     * - length/width/weight: одна МС-величина против каждого маркетплейса.
     * - height: у МС возможны две высоты (коробка / пакет); маркетплейсная высота
     *   считается совпавшей, если совпала хотя бы с одной из непустых МС-высот.
     * Сравнение вообще не делается, если со стороны МС или маркетплейса нет числа. */
    function issuesRowDimsMismatchVsMs(row) {
        const msL = parseExportDimNumber(row.ms_length);
        const msW = parseExportDimNumber(row.ms_width);
        const msHbox = parseExportDimNumber(row.ms_height_box);
        const msHbag = parseExportDimNumber(row.ms_height_bag);
        const msWeight = parseExportDimNumber(row.ms_weight);
        const prefixes = ['ozon', 'wb', 'ym'];
        for (const p of prefixes) {
            if (!row[`${p}_code`]) continue;
            const mpL = parseExportDimNumber(row[`${p}_length`]);
            const mpW = parseExportDimNumber(row[`${p}_width`]);
            const mpH = parseExportDimNumber(row[`${p}_height`]);
            const mpWeight = parseExportDimNumber(row[`${p}_weight`]);
            if (msL != null && mpL != null && !issuesDimSizeEqual(msL, mpL, p)) return true;
            if (msW != null && mpW != null && !issuesDimSizeEqual(msW, mpW, p)) return true;
            if (msWeight != null && mpWeight != null && Math.abs(msWeight - mpWeight) > ISSUES_DIM_EPS) return true;
            if (mpH != null && (msHbox != null || msHbag != null)) {
                const matchBox = msHbox != null && issuesDimSizeEqual(msHbox, mpH, p);
                const matchBag = msHbag != null && issuesDimSizeEqual(msHbag, mpH, p);
                if (!matchBox && !matchBag) return true;
            }
        }
        return false;
    }

    /**
     * Расхождение габаритов между маркетплейсами: товар есть минимум на двух площадках,
     * и по хотя бы одной оси (длина/ширина/высота/вес) обе отдают число и оно расходится
     * с допуском ISSUES_DIM_EPS. Используется как fallback, если у МС нет ни одного
     * числа в атрибутах габаритов карточки.
     */
    function issuesRowDimsMismatchAcrossMps(row) {
        const keys = [];
        if (row.ozon_code) keys.push('ozon');
        if (row.wb_code) keys.push('wb');
        if (row.ym_code) keys.push('ym');
        if (keys.length < 2) return false;
        for (let i = 0; i < keys.length; i += 1) {
            for (let j = i + 1; j < keys.length; j += 1) {
                if (issuesDimTuplesDiffer(issuesDimTuple(row, keys[i]), issuesDimTuple(row, keys[j]))) {
                    return true;
                }
            }
        }
        return false;
    }

    /** Расхождение габаритов с учётом МС: при наличии измерений МС сверяемся с ними,
     * иначе — старая логика «между маркетплейсами». */
    function issuesRowDimsMismatch(row) {
        if (issuesRowHasMsDims(row)) return issuesRowDimsMismatchVsMs(row);
        return issuesRowDimsMismatchAcrossMps(row);
    }

    /** НДС МС → сравнимая метка (сырое значение из ms_export.vat). */
    function canonicalIssueVatMs(raw) {
        const s = String(raw == null ? '' : raw).trim().toLowerCase();
        if (!s) return '';
        if (/без\s*ндс|не\s*облагается|^0\b|^0\s*%/.test(s)) return '__0';
        const m = s.match(/(\d+(?:\.\d+)?)\s*%?/);
        if (m) return String(Math.round(parseFloat(m[1])));
        return s.replace(/\s/g, '').replace('%', '');
    }

    /** НДС маркетплейса после prettifyMarketplaceVat в /issues. */
    function canonicalIssueVatMpAfterPrettify(kind, prettyVal) {
        const raw = String(prettyVal == null ? '' : prettyVal).trim();
        const s = raw.toLowerCase();
        if (!s) return kind === 'ozon' ? '__0' : '';
        if (kind === 'ozon' && (s === 'без ндс' || s === 'безндс')) return '__0';
        if (kind === 'wb' && (s === 'без ндс' || s === 'безндс')) return '__0';
        if (kind === 'ym' && /без\s*ндс/.test(s)) return '__0';
        const m = s.match(/^(\d+)/);
        if (m) return m[1];
        const m2 = /(\d+(?:\.\d+)?)/.exec(s);
        if (m2) return String(Math.round(parseFloat(m2[1])));
        return s.replace(/\s/g, '').replace('%', '');
    }

    /** Хотя бы на одной площадке с товаром НДС после нормализации ≠ НДС МС (WB «не указан» пропускаем). */
    function issuesRowVatMismatch(row) {
        const ms = canonicalIssueVatMs(row.ms_vat);
        const oneDiff = (kind, code, prettyVat) => {
            if (!code) return false;
            if (kind === 'wb' && /не\s*указан/i.test(String(prettyVat || ''))) return false;
            const mp = canonicalIssueVatMpAfterPrettify(kind, prettyVat);
            if (mp === '' && ms === '') return false;
            return mp !== ms;
        };
        return (
            oneDiff('ozon', row.ozon_code, row.ozon_vat)
            || oneDiff('wb', row.wb_code, row.wb_vat)
            || oneDiff('ym', row.ym_code, row.ym_vat)
        );
    }

    /**
     * Габариты МС для `/issues`: те же доп. поля карточки, что уходят в МС с
     * `/exports-dimensions.html` («↗ В МС»). Имена атрибутов — паритет с
     * `DIMENSION_ATTRS` / `FIELD_TO_MS_ATTR` в `routes/dimensions.js`.
     * Источник — денорм `ms_entity_details.denorm_dim_*` (и fallback
     * `payload_json.attributes` только без `denorm_dims_at`), не таблица замеров
     * `ms_dimensions_measurements` (там может быть только тип упаковки + вес).
     */
    const ISSUES_MS_DIM_ATTRS = [
        { key: 'ms_length', attr: '!!Длина (см) КОРОБКА/Пакет станд. уп.', decimals: 1 },
        { key: 'ms_width', attr: '!!Ширина (см) КОРОБКА/Пакет станд. уп.', decimals: 1 },
        { key: 'ms_height_box', attr: '!!Высота (см) КОРОБКА станд. уп.', decimals: 1 },
        { key: 'ms_height_bag', attr: '!!Высота (см) Пакет!', decimals: 1 },
        // Вес: 3 знака — как в денорме/МС. toFixed(1) давал ложные «2.6 vs 2.65»
        // (сравнение и подсветка на issues), хотя в Ozon уходил полный вес 2.650.
        { key: 'ms_weight', attr: '!!Вес (кг)', decimals: 3 },
    ];

    function extractIssuesMsDimAttr(payload, attrName) {
        if (!payload || !Array.isArray(payload.attributes)) return '';
        const a = payload.attributes.find((x) => x && x.name === attrName);
        if (!a) return '';
        const v = a.value;
        if (v == null) return '';
        if (typeof v === 'object') {
            if (typeof v.name === 'string') return v.name;
            return '';
        }
        return String(v);
    }

    function parseIssuesEntityPayload(raw) {
        if (raw == null) return null;
        if (typeof raw === 'object') return raw;
        try {
            const o = JSON.parse(String(raw));
            return o && typeof o === 'object' ? o : null;
        } catch (_) {
            return null;
        }
    }

    function formatIssuesMsDimValue(v, decimals) {
        if (v == null) return null;
        const s = String(v).trim();
        if (!s) return null;
        const n = parseFloat(s.replace(',', '.'));
        if (!Number.isFinite(n)) return null;
        const d = Number.isFinite(decimals) ? Math.max(0, Math.min(6, decimals | 0)) : 1;
        return n.toFixed(d);
    }

    /** Подмешивает ms_length/… из денорма `ms_entity_details` (JOIN) или,
     * только для карточек без `denorm_dims_at`, из `payload_json` чанками.
     * Полный скан payload по каталогу (~7k × сотни КБ) давал минуты на «Разные габариты». */
    async function attachIssuesMsDimsFromEntityDetails(dbConn, rows) {
        const list = rows || [];
        for (const r of list) {
            // Денорм из SELECT (числа) → те же строки, что раньше из attributes.
            for (const def of ISSUES_MS_DIM_ATTRS) {
                if (r[def.key] != null && r[def.key] !== '') {
                    r[def.key] = formatIssuesMsDimValue(r[def.key], def.decimals);
                } else {
                    r[def.key] = null;
                }
            }
        }
        const uuids = [];
        const seen = new Set();
        for (const r of list) {
            const denormAt = r && r._denorm_dims_at;
            if (denormAt != null && String(denormAt).trim() !== '') continue;
            const u = String(r && r.uuid != null ? r.uuid : '').trim();
            if (!u || seen.has(u)) continue;
            seen.add(u);
            uuids.push(u);
        }
        for (const r of list) {
            if (r && Object.prototype.hasOwnProperty.call(r, '_denorm_dims_at')) {
                delete r._denorm_dims_at;
            }
        }
        if (!uuids.length || !dbConn || typeof dbConn.query !== 'function') return;

        const byUuid = new Map();
        const CHUNK = 250;
        for (let i = 0; i < uuids.length; i += CHUNK) {
            const chunk = uuids.slice(i, i + CHUNK);
            const [drows] = await dbConn.query(
                'SELECT uuid, payload_json FROM ms_entity_details WHERE uuid IN (?)',
                [chunk]
            );
            for (const d of drows || []) {
                const uid = String(d && d.uuid != null ? d.uuid : '').trim();
                if (!uid) continue;
                const payload = parseIssuesEntityPayload(d.payload_json);
                const dims = {};
                for (const def of ISSUES_MS_DIM_ATTRS) {
                    dims[def.key] = formatIssuesMsDimValue(
                        extractIssuesMsDimAttr(payload, def.attr),
                        def.decimals
                    );
                }
                byUuid.set(uid, dims);
            }
        }
        for (const r of list) {
            const uid = String(r && r.uuid != null ? r.uuid : '').trim();
            const dims = byUuid.get(uid);
            if (!dims) continue;
            for (const def of ISSUES_MS_DIM_ATTRS) {
                r[def.key] = dims[def.key];
            }
        }
    }

    /**
     * Общая выборка строк для `/issues` и для ежедневного снимка (после синка маркетплейсов).
     * `scope` — уже нормализованный ключ (all|any|all3|ozon|wb|ym|vat_mismatch|dims_mismatch).
     */
    async function loadIssuesRowsCore(dbConn, { scope, maxItems, excludeBundleComponents }) {
        const baseSelect = `
                SELECT
                    m.code           AS code,
                    m.name           AS name,
                    m.uuid           AS uuid,
                    m.type           AS type,
                    m.vat            AS ms_vat,
                    m.manager        AS manager,
                    m.content_manager AS content_manager,
                    DATE_FORMAT(m.synced_at, '%d.%m.%Y %H:%i') AS synced_at,
                    m.stock          AS ms_stock,

                    med.denorm_dim_length_cm AS ms_length,
                    med.denorm_dim_width_cm AS ms_width,
                    med.denorm_dim_height_box_cm AS ms_height_box,
                    med.denorm_dim_height_bag_cm AS ms_height_bag,
                    med.denorm_dim_weight_kg AS ms_weight,
                    med.denorm_dim_packing_type AS ms_packing_type,
                    med.denorm_dims_at AS _denorm_dims_at,

                    ozon.external_id AS ozon_code,
                    ozon.name        AS ozon_name,
                    ozon.vat         AS ozon_vat,
                    ozon.stock       AS ozon_stock,
                    ozon.length_cm   AS ozon_length,
                    ozon.width_cm    AS ozon_width,
                    ozon.height_cm   AS ozon_height,
                    ozon.weight_kg   AS ozon_weight,
                    ozon.cabinet_url AS ozon_cabinet_url,
                    ozon.buyer_url   AS ozon_buyer_url,
                    COALESCE(NULLIF(ozon.updated_label, ''), DATE_FORMAT(ozon.updated_at, '%d.%m.%Y %H:%i')) AS ozon_updated,

                    wb.external_id   AS wb_code,
                    wb.name          AS wb_name,
                    wb.vat           AS wb_vat,
                    wb.stock         AS wb_stock,
                    wb.length_cm     AS wb_length,
                    wb.width_cm      AS wb_width,
                    wb.height_cm     AS wb_height,
                    wb.weight_kg     AS wb_weight,
                    wb.cabinet_url   AS wb_cabinet_url,
                    wb.buyer_url     AS wb_buyer_url,
                    COALESCE(NULLIF(wb.updated_label, ''), DATE_FORMAT(wb.updated_at, '%d.%m.%Y %H:%i')) AS wb_updated,

                    ym.external_id   AS ym_code,
                    ym.name          AS ym_name,
                    ym.vat           AS ym_vat,
                    ym.stock         AS ym_stock,
                    ym.length_cm     AS ym_length,
                    ym.width_cm      AS ym_width,
                    ym.height_cm     AS ym_height,
                    ym.weight_kg     AS ym_weight,
                    ym.cabinet_url   AS ym_cabinet_url,
                    ym.buyer_url     AS ym_buyer_url,
                    COALESCE(NULLIF(ym.updated_label, ''), DATE_FORMAT(ym.updated_at, '%d.%m.%Y %H:%i')) AS ym_updated
                FROM ms_export m
                LEFT JOIN ms_entity_details med
                    ON med.uuid = m.uuid
                LEFT JOIN marketplace_export_rows ozon
                    ON ozon.marketplace = 'ozon' AND ozon.external_id = m.code
                LEFT JOIN marketplace_export_rows wb
                    ON wb.marketplace = 'wildberries' AND wb.external_id = m.code
                LEFT JOIN marketplace_export_rows ym
                    ON ym.marketplace = 'yandex_market' AND ym.external_id = m.code
            `;
        const baseWhere = `WHERE m.stock_position = 'Да' AND m.no_longer_cooperation = 'Нет'`;
        let scopeWhere = '';
        if (scope === 'ozon') scopeWhere = ' AND ozon.external_id IS NULL';
        else if (scope === 'wb') scopeWhere = ' AND wb.external_id IS NULL';
        else if (scope === 'ym') scopeWhere = ' AND ym.external_id IS NULL';
        else if (scope === 'all3') {
            scopeWhere = ' AND ozon.external_id IS NULL AND wb.external_id IS NULL AND ym.external_id IS NULL';
        } else if (scope === 'any') {
            scopeWhere = ' AND (ozon.external_id IS NULL OR wb.external_id IS NULL OR ym.external_id IS NULL)';
        }

        const sql = `${baseSelect}\n${baseWhere}${scopeWhere}\nORDER BY m.code\nLIMIT ?`;
        let [rows] = await dbConn.query(sql, [maxItems]);

        let bundleComponentCodes = null;
        let removedByBundleFilter = 0;
        if (excludeBundleComponents) {
            bundleComponentCodes = await getBundleComponentCodesCached(dbConn);
            if (bundleComponentCodes && bundleComponentCodes.size) {
                const before = rows.length;
                rows = rows.filter((r) => {
                    const code = String(r && r.code != null ? r.code : '').trim();
                    return !code || !bundleComponentCodes.has(code);
                });
                removedByBundleFilter = before - rows.length;
            }
        }

        await attachIssuesMsDimsFromEntityDetails(dbConn, rows || []);

        for (const r of rows || []) {
            if (Object.prototype.hasOwnProperty.call(r, 'ozon_vat')) {
                r.ozon_vat = prettifyMarketplaceVat('ozon', r.ozon_vat);
            }
            if (Object.prototype.hasOwnProperty.call(r, 'wb_vat')) {
                r.wb_vat = prettifyMarketplaceVat('wb', r.wb_vat);
            }
            if (Object.prototype.hasOwnProperty.call(r, 'ym_vat')) {
                r.ym_vat = prettifyMarketplaceVat('ym', r.ym_vat);
            }
        }

        if (scope === 'vat_mismatch') {
            rows = (rows || []).filter((r) => issuesRowVatMismatch(r));
        } else if (scope === 'dims_mismatch') {
            // При наличии чисел в атрибутах габаритов карточки МС сверяемся с ними
            // (двойная высота: коробка ИЛИ пакет). Иначе — «между маркетплейсами».
            rows = (rows || []).filter((r) => issuesRowDimsMismatch(r));
        }

        return {
            rows: rows || [],
            removedByBundleFilter,
            bundleComponentCodesKnown: bundleComponentCodes ? bundleComponentCodes.size : 0,
            excludeBundleComponents: Boolean(excludeBundleComponents),
        };
    }

    async function appendMarketplaceIssuesSnapshot(dbConn, _appSets, meta) {
        if (!dbConn || typeof dbConn.query !== 'function') return;
        await ensureMpIssuesSnapshotTable(dbConn);
        const { rows, removedByBundleFilter } = await loadIssuesRowsCore(dbConn, {
            scope: 'any',
            maxItems: 100000,
            excludeBundleComponents: true,
        });
        const byManager = bucketFieldCounts(rows, 'manager');
        const byCm = bucketFieldCounts(rows, 'content_manager');
        const statDate = moscowStatDateYmd();
        const triggerType = String((meta && meta.triggerType) || 'manual').slice(0, 24);
        const scheduleSlotTime = String((meta && meta.scheduleSlotTime) || '').slice(0, 8);
        const mgrJson = JSON.stringify(byManager);
        const cmJson = JSON.stringify(byCm);
        const [ins] = await dbConn.query(
            `INSERT INTO mp_issues_daily_snapshot (
                stat_date, trigger_type, schedule_slot_time, scope, exclude_bundle_components,
                total_count, by_manager_json, by_content_manager_json, removed_by_bundle_filter
            ) VALUES (?, ?, ?, 'any', 1, ?, ?, ?, ?)`,
            [statDate, triggerType, scheduleSlotTime, rows.length, mgrJson, cmJson, removedByBundleFilter]
        );
        const snapId = Number(ins && ins.insertId ? ins.insertId : 0);
        console.info(
            `[exports/marketplaces] issues snapshot saved id=${snapId} stat_date=${statDate} total=${rows.length} trigger=${triggerType}`
        );
        try {
            await dbConn.query(
                'DELETE FROM mp_issues_daily_snapshot WHERE recorded_at < DATE_SUB(UTC_TIMESTAMP(), INTERVAL 900 DAY)'
            );
        } catch (_) {
            /* ignore prune */
        }
    }

    /**
     * Проблемы с товарами (бывш. «Неопубликованные»).
     *
     * Возвращает строки `ms_export` по основному фильтру:
     *     stock_position = 'Да'  AND  no_longer_cooperation = 'Нет'
     *
     * с одновременным сопоставлением артикулов на 3 маркетплейсах через
     * `marketplace_export_rows.external_id` (= offer_id для Ozon, vendor_code для WB,
     * shop_sku для YM, см. lib/marketplaceExportStore.js#externalIdFor).
     *
     * Параметр query `scope`:
     *   all  (default) — все товары МС по основному фильтру (фронт подсветит пустые ячейки красным).
     *   any            — у кого хотя бы один из 3 маркетплейсов не нашёл товар.
     *   all3           — нет ни на одном из 3 маркетплейсов.
     *   ozon|wb|ym     — нет на конкретном маркетплейсе.
     *   vat_mismatch   — товар есть на маркетплейсе, но нормализованный НДС МС ≠ НДС этой площадки.
     *   dims_mismatch  — расхождение габаритов (длина/ширина/высота/вес).
     *                    Если у строки в атрибутах карточки МС есть хотя бы одно
     *                    числовое значение (`!!Длина…` / `!!Ширина…` /
     *                    `!!Высота…КОРОБКА` / `!!Высота…Пакет!` / `!!Вес (кг)`),
     *                    сверка идёт МС ↔ маркетплейсы (высота МС двойная: совпадение
     *                    высоты площадки хотя бы с коробкой ИЛИ с пакетом = match).
     *                    Если атрибутов МС нет — fallback «между маркетплейсами».
     */
    router.get('/issues', async (req, res) => {
        try {
            if (!db || typeof db.query !== 'function') {
                return res.status(500).json({ error: 'БД недоступна', code: 'NO_DB' });
            }
            const scopeRaw = String(req.query.scope || req.query.shop || 'all').trim().toLowerCase();
            const scopeAliases = {
                all: 'all',
                any: 'any',
                all3: 'all3',
                'all-3': 'all3',
                ozon: 'ozon',
                wb: 'wb',
                wildberries: 'wb',
                ym: 'ym',
                yandex: 'ym',
                'yandex-market': 'ym',
                yandex_market: 'ym',
                vat_mismatch: 'vat_mismatch',
                'vat-mismatch': 'vat_mismatch',
                dims_mismatch: 'dims_mismatch',
                'dims-mismatch': 'dims_mismatch',
            };
            const scope = scopeAliases[scopeRaw];
            if (!scope) {
                return res.status(400).json({ error: 'Неверный scope', code: 'BAD_SCOPE' });
            }
            const SCOPE_LABEL = {
                all: 'все товары',
                any: 'есть проблемы (хотя бы где-то)',
                all3: 'нет ни на одном маркетплейсе',
                ozon: 'нет на Ozon',
                wb: 'нет на Wildberries',
                ym: 'нет на Я.Маркет',
                vat_mismatch: 'не совпадает НДС (МС ↔ маркетплейс)',
                dims_mismatch: 'разные габариты между маркетплейсами',
            };

            const maxItemsRaw = parseInt(req.query.max_items, 10);
            const maxItems = Number.isFinite(maxItemsRaw) && maxItemsRaw > 0
                ? Math.min(maxItemsRaw, 100000)
                : 50000;

            const ebcRaw = String(req.query.exclude_bundle_components == null ? '' : req.query.exclude_bundle_components).trim().toLowerCase();
            const FALSE_TOKENS = new Set(['0', 'false', 'no', 'off']);
            const excludeBundleComponents = !FALSE_TOKENS.has(ebcRaw);

            const {
                rows,
                removedByBundleFilter,
                bundleComponentCodesKnown,
                excludeBundleComponents: ebcApplied,
            } = await loadIssuesRowsCore(db, { scope, maxItems, excludeBundleComponents });

            const headers = [
                'code', 'name',
                'manager', 'content_manager', 'ms_vat', 'ms_stock',
                'ms_length', 'ms_width', 'ms_height_box', 'ms_height_bag', 'ms_weight',
                'synced_at',
                'ozon_code', 'ozon_name', 'ozon_vat', 'ozon_fix_vat', 'ozon_stock',
                'ozon_length', 'ozon_width', 'ozon_height', 'ozon_weight', 'ozon_fix_dims',
                'ozon_cabinet_url', 'ozon_buyer_url', 'ozon_updated',
                'wb_code', 'wb_name', 'wb_vat', 'wb_fix_vat', 'wb_stock',
                'wb_length', 'wb_width', 'wb_height', 'wb_weight', 'wb_fix_dims',
                'wb_cabinet_url', 'wb_buyer_url', 'wb_updated',
                'ym_code', 'ym_name', 'ym_vat', 'ym_fix_vat', 'ym_stock',
                'ym_length', 'ym_width', 'ym_height', 'ym_weight', 'ym_fix_dims',
                'ym_cabinet_url', 'ym_buyer_url', 'ym_updated',
            ];
            const headerLabels = [
                'Код МС', 'Название МС',
                'Менеджер', 'Контент-менеджер', 'НДС МС', 'Остаток по МС',
                'Длина (см) МС', 'Ширина (см) МС', 'Высота — коробка (см) МС', 'Высота — пакет (см) МС', 'Вес (кг) МС',
                'Синхронизация МС',
                'Код Ozon', 'Название Ozon', 'НДС Ozon', 'Исправить НДС Ozon', 'Остаток Ozon',
                'Длина (см) Ozon', 'Ширина (см) Ozon', 'Высота (см) Ozon', 'Вес (кг) Ozon', 'Исправить на Ozon',
                'Кабинет Ozon', 'Покупателю Ozon', 'Обновлено Ozon',
                'Код Wildberries', 'Название Wildberries', 'НДС WB', 'Исправить НДС WB', 'Остаток WB',
                'Длина (см) WB', 'Ширина (см) WB', 'Высота (см) WB', 'Вес (кг) WB', 'Исправить на WB',
                'Кабинет WB', 'Покупателю WB', 'Обновлено WB',
                'Код Я.Маркет', 'Название Я.Маркет', 'НДС Я.Маркет', 'Исправить НДС Я.М', 'Остаток Я.Маркет',
                'Длина (см) Я.Маркет', 'Ширина (см) Я.Маркет', 'Высота (см) Я.Маркет', 'Вес (кг) Я.Маркет', 'Исправить на Я.М',
                'Кабинет Я.Маркет', 'Покупателю Я.Маркет', 'Обновлено Я.Маркет',
            ];
            return res.json({
                scope,
                scope_label: SCOPE_LABEL[scope],
                count: rows.length,
                headers,
                headerLabels,
                rows,
                exclude_bundle_components: ebcApplied,
                bundle_component_codes_known: bundleComponentCodesKnown,
                removed_by_bundle_filter: removedByBundleFilter,
            });
        } catch (e) {
            console.error('[exports/marketplaces] issues failed:', e && e.stack ? e.stack : e);
            return res.status(500).json({ error: e.message || String(e), code: 'ISSUES_FAILED' });
        }
    });

    /**
     * Исправить габариты на Ozon по артикулам (offer_id = код МС).
     * Body: { codes: string[], dry_run?: boolean, confirm?: boolean }
     * Для массовой кнопки — codes из текущей клиентской выборки (фильтры менеджера/поиска на клиенте).
     * Габариты берутся из денорма МС (длина/ширина/вес + высота коробка|пакет).
     */
    router.post('/issues/fix-ozon-dims', async (req, res) => {
        const t0 = Date.now();
        try {
            if (!db || typeof db.query !== 'function') {
                return res.status(500).json({ error: 'БД недоступна', code: 'NO_DB' });
            }
            const body = req.body && typeof req.body === 'object' ? req.body : {};
            const dryRun = body.dry_run === true || body.dry_run === 1 || body.dry_run === '1';
            const confirm = body.confirm === true || body.confirm === 1 || body.confirm === '1';
            if (!dryRun && !confirm) {
                return res.status(400).json({ error: 'confirm required (или dry_run=1)', code: 'CONFIRM_REQUIRED' });
            }
            let codes = [];
            if (Array.isArray(body.codes)) {
                codes = body.codes.map((c) => String(c == null ? '' : c).trim()).filter(Boolean);
            } else if (body.code != null && String(body.code).trim()) {
                codes = [String(body.code).trim()];
            }
            codes = Array.from(new Set(codes));
            if (!codes.length) {
                return res.status(400).json({ error: 'codes[] или code обязателен', code: 'NO_CODES' });
            }
            if (codes.length > 200) {
                return res.status(400).json({
                    error: 'За один раз не больше 200 артикулов',
                    code: 'TOO_MANY',
                    max: 200,
                    total: codes.length,
                });
            }

            const creds = getOzonCreds(appSettings || {});
            if (!creds.clientId || !creds.apiKey) {
                return res.status(400).json({
                    error: 'Не заданы ozon_client_id / ozon_api_key',
                    code: 'MISSING_CREDS',
                });
            }
            const delayMs = Math.max(
                MP_MIN_DELAY_MS.ozon || 200,
                Number((appSettings && appSettings.mp_ozon_delay_ms) || 400) || 400
            );
            const logger = createMarketplaceLogger('ozon-dims');

            const ph = codes.map(() => '?').join(',');
            const [msRows] = await db.query(
                `SELECT m.code,
                        med.denorm_dim_length_cm AS ms_length,
                        med.denorm_dim_width_cm AS ms_width,
                        med.denorm_dim_height_box_cm AS ms_height_box,
                        med.denorm_dim_height_bag_cm AS ms_height_bag,
                        med.denorm_dim_weight_kg AS ms_weight,
                        med.denorm_dim_packing_type AS ms_packing_type,
                        ozon.external_id AS ozon_code
                 FROM ms_export m
                 LEFT JOIN ms_entity_details med ON med.uuid = m.uuid
                 LEFT JOIN marketplace_export_rows ozon
                   ON ozon.marketplace = 'ozon' AND ozon.external_id = m.code
                 WHERE m.code IN (${ph})`,
                codes
            );
            const byCode = new Map();
            for (const r of msRows || []) {
                byCode.set(String(r.code || '').trim(), r);
            }

            const results = [];
            let wouldUpdate = 0;
            let updated = 0;
            let skipped = 0;
            let failed = 0;
            const errors = [];

            for (const code of codes) {
                const row = byCode.get(code);
                if (!row) {
                    skipped += 1;
                    results.push({ code, success: false, skipped: true, error: 'Нет в ms_export', code_err: 'NO_MS' });
                    continue;
                }
                if (!row.ozon_code) {
                    skipped += 1;
                    results.push({
                        code,
                        success: false,
                        skipped: true,
                        error: 'Нет на Ozon (нет offer_id в снапшоте)',
                        code_err: 'NO_OZON',
                    });
                    continue;
                }
                const dims = resolveMsDimsForOzonPush(row);
                if (!dims) {
                    skipped += 1;
                    results.push({
                        code,
                        offer_id: row.ozon_code,
                        success: false,
                        skipped: true,
                        error: 'Неполные габариты МС (нужны длина, ширина, высота, вес)',
                        code_err: 'MS_DIMS_INCOMPLETE',
                    });
                    continue;
                }
                wouldUpdate += 1;
                if (dryRun) {
                    results.push({
                        code,
                        offer_id: row.ozon_code,
                        success: true,
                        dry_run: true,
                        dims,
                    });
                    continue;
                }
                const out = await updateOzonOfferDimensions(creds, {
                    offerId: row.ozon_code,
                    dims,
                    delayMs,
                    logger,
                    waitTask: true,
                });
                if (out.success) {
                    updated += 1;
                    try {
                        await patchLocalOzonDims(db, row.ozon_code, out.dims);
                    } catch (ePatch) {
                        logger.log('local_patch_fail', { offer: row.ozon_code, message: ePatch.message });
                    }
                    results.push({
                        code,
                        offer_id: row.ozon_code,
                        success: true,
                        task_id: out.task_id,
                        import_status: out.import_status,
                        dims: out.dims,
                    });
                } else {
                    failed += 1;
                    const errItem = {
                        code,
                        offer_id: row.ozon_code,
                        success: false,
                        error: out.error || 'Ошибка Ozon',
                        code_err: out.code || 'OZON_FAIL',
                    };
                    results.push(errItem);
                    if (errors.length < 20) {
                        errors.push({ code, error: errItem.error });
                    }
                }
            }

            return res.json({
                success: failed === 0,
                dry_run: dryRun,
                total: codes.length,
                would_update: wouldUpdate,
                updated,
                skipped,
                failed,
                errors,
                results: results.slice(0, 50),
                duration_sec: Number(((Date.now() - t0) / 1000).toFixed(2)),
            });
        } catch (e) {
            console.error('[exports/marketplaces] fix-ozon-dims failed:', e && e.stack ? e.stack : e);
            return res.status(500).json({ error: e.message || String(e), code: 'FIX_OZON_DIMS_FAILED' });
        }
    });

    /**
     * Исправить габариты на Wildberries по артикулам (vendorCode = код МС).
     * Body: { codes: string[], dry_run?: boolean, confirm?: boolean }
     * Макс. 100 за запрос (лимит WB cards/update ~10/мин, list 600 мс).
     * UI режет выборку на пакеты по 100.
     */
    router.post('/issues/fix-wb-dims', async (req, res) => {
        const t0 = Date.now();
        try {
            if (!db || typeof db.query !== 'function') {
                return res.status(500).json({ error: 'БД недоступна', code: 'NO_DB' });
            }
            const body = req.body && typeof req.body === 'object' ? req.body : {};
            const dryRun = body.dry_run === true || body.dry_run === 1 || body.dry_run === '1';
            const confirm = body.confirm === true || body.confirm === 1 || body.confirm === '1';
            if (!dryRun && !confirm) {
                return res.status(400).json({ error: 'confirm required (или dry_run=1)', code: 'CONFIRM_REQUIRED' });
            }
            let codes = [];
            if (Array.isArray(body.codes)) {
                codes = body.codes.map((c) => String(c == null ? '' : c).trim()).filter(Boolean);
            } else if (body.code != null && String(body.code).trim()) {
                codes = [String(body.code).trim()];
            }
            codes = Array.from(new Set(codes));
            if (!codes.length) {
                return res.status(400).json({ error: 'codes[] или code обязателен', code: 'NO_CODES' });
            }
            if (codes.length > 100) {
                return res.status(400).json({
                    error: 'За один раз не больше 100 артикулов (лимит WB Content update)',
                    code: 'TOO_MANY',
                    max: 100,
                    total: codes.length,
                });
            }

            const creds = getWbCreds(appSettings || {});
            if (!creds.apiKey) {
                return res.status(400).json({
                    error: 'Не задан wb_api_key',
                    code: 'MISSING_CREDS',
                });
            }
            const delayListMs = Math.max(
                MP_MIN_DELAY_MS.wbCards || 600,
                Number((appSettings && appSettings.mp_wb_delay_cards_ms) || 600) || 600
            );
            const logger = createMarketplaceLogger('wb-dims');
            logger.log('http:fix-wb-dims:start', {
                codes: codes.length,
                dryRun,
                delayListMs,
            });

            const ph = codes.map(() => '?').join(',');
            const [msRows] = await db.query(
                `SELECT m.code,
                        med.denorm_dim_length_cm AS ms_length,
                        med.denorm_dim_width_cm AS ms_width,
                        med.denorm_dim_height_box_cm AS ms_height_box,
                        med.denorm_dim_height_bag_cm AS ms_height_bag,
                        med.denorm_dim_weight_kg AS ms_weight,
                        med.denorm_dim_packing_type AS ms_packing_type,
                        wb.external_id AS wb_code,
                        wb.cabinet_url AS wb_cabinet_url,
                        wb.buyer_url AS wb_buyer_url
                 FROM ms_export m
                 LEFT JOIN ms_entity_details med ON med.uuid = m.uuid
                 LEFT JOIN marketplace_export_rows wb
                   ON wb.marketplace = 'wildberries' AND wb.external_id = m.code
                 WHERE m.code IN (${ph})`,
                codes
            );
            const byCode = new Map();
            for (const r of msRows || []) {
                byCode.set(String(r.code || '').trim(), r);
            }

            const batchItems = [];
            const preResults = [];
            let wouldUpdate = 0;
            let skipped = 0;

            for (const code of codes) {
                const row = byCode.get(code);
                if (!row) {
                    skipped += 1;
                    preResults.push({ code, success: false, skipped: true, error: 'Нет в ms_export', code_err: 'NO_MS' });
                    continue;
                }
                if (!row.wb_code) {
                    skipped += 1;
                    preResults.push({
                        code,
                        success: false,
                        skipped: true,
                        error: 'Нет на WB (нет vendorCode в снапшоте)',
                        code_err: 'NO_WB',
                    });
                    continue;
                }
                const dims = resolveMsDimsForWbPush(row);
                if (!dims) {
                    skipped += 1;
                    preResults.push({
                        code,
                        vendor_code: row.wb_code,
                        success: false,
                        skipped: true,
                        error: 'Неполные габариты МС (нужны длина, ширина, высота, вес)',
                        code_err: 'MS_DIMS_INCOMPLETE',
                    });
                    continue;
                }
                wouldUpdate += 1;
                if (dryRun) {
                    preResults.push({
                        code,
                        vendor_code: row.wb_code,
                        success: true,
                        dry_run: true,
                        dims,
                    });
                    continue;
                }
                batchItems.push({
                    code,
                    vendorCode: row.wb_code,
                    dims,
                    nmIdHint: nmIdFromUrls(row.wb_cabinet_url, row.wb_buyer_url),
                });
            }

            let updated = 0;
            let failed = 0;
            const errors = [];
            const results = preResults.slice();

            if (!dryRun && batchItems.length) {
                const batchOut = await updateWbOffersDimensionsBatch(
                    creds.apiKey,
                    batchItems.map((it) => ({
                        vendorCode: it.vendorCode,
                        dims: it.dims,
                        nmIdHint: it.nmIdHint,
                    })),
                    {
                        logger,
                        delayListMs,
                        delayUpdateMs: 6500,
                        updateChunk: 50,
                        dryRun: false,
                    }
                );
                const byVendor = new Map();
                for (const it of batchItems) {
                    byVendor.set(it.vendorCode, it.code);
                }
                for (const out of batchOut || []) {
                    const code = byVendor.get(String(out.vendor_code || '').trim()) || out.vendor_code;
                    if (out.success) {
                        updated += 1;
                        try {
                            await patchLocalWbDims(db, out.vendor_code, out.dims);
                        } catch (ePatch) {
                            logger.log('local_patch_fail', {
                                vendor: out.vendor_code,
                                message: ePatch.message,
                            });
                        }
                        results.push({
                            code,
                            vendor_code: out.vendor_code,
                            nm_id: out.nm_id,
                            success: true,
                            dims: out.dims,
                        });
                    } else if (out.skipped) {
                        skipped += 1;
                        results.push({
                            code,
                            vendor_code: out.vendor_code,
                            success: false,
                            skipped: true,
                            error: out.error,
                            code_err: out.code,
                        });
                    } else {
                        failed += 1;
                        const errItem = {
                            code,
                            vendor_code: out.vendor_code,
                            success: false,
                            error: out.error || 'Ошибка WB',
                            code_err: out.code || 'WB_FAIL',
                        };
                        results.push(errItem);
                        if (errors.length < 20) {
                            errors.push({ code, error: errItem.error });
                        }
                    }
                }
            }

            logger.log('http:fix-wb-dims:done', {
                total: codes.length,
                would_update: wouldUpdate,
                updated: dryRun ? 0 : updated,
                skipped,
                failed,
                duration_sec: Number(((Date.now() - t0) / 1000).toFixed(2)),
            });

            return res.json({
                success: failed === 0,
                dry_run: dryRun,
                total: codes.length,
                would_update: wouldUpdate,
                updated: dryRun ? 0 : updated,
                skipped,
                failed,
                errors,
                results: results.slice(0, 80),
                duration_sec: Number(((Date.now() - t0) / 1000).toFixed(2)),
            });
        } catch (e) {
            console.error('[exports/marketplaces] fix-wb-dims failed:', e && e.stack ? e.stack : e);
            return res.status(500).json({ error: e.message || String(e), code: 'FIX_WB_DIMS_FAILED' });
        }
    });

    /**
     * Исправить габариты на Яндекс Маркете по артикулам (shopSku = код МС).
     * Body: { codes: string[], dry_run?: boolean, confirm?: boolean }
     * POST businesses/{businessId}/offer-mappings/update (weightDimensions).
     * Макс. 100 за запрос (рекомендация YM); UI — пакеты по 100.
     */
    router.post('/issues/fix-ym-dims', async (req, res) => {
        const t0 = Date.now();
        try {
            if (!db || typeof db.query !== 'function') {
                return res.status(500).json({ error: 'БД недоступна', code: 'NO_DB' });
            }
            const body = req.body && typeof req.body === 'object' ? req.body : {};
            const dryRun = body.dry_run === true || body.dry_run === 1 || body.dry_run === '1';
            const confirm = body.confirm === true || body.confirm === 1 || body.confirm === '1';
            if (!dryRun && !confirm) {
                return res.status(400).json({ error: 'confirm required (или dry_run=1)', code: 'CONFIRM_REQUIRED' });
            }
            let codes = [];
            if (Array.isArray(body.codes)) {
                codes = body.codes.map((c) => String(c == null ? '' : c).trim()).filter(Boolean);
            } else if (body.code != null && String(body.code).trim()) {
                codes = [String(body.code).trim()];
            }
            codes = Array.from(new Set(codes));
            if (!codes.length) {
                return res.status(400).json({ error: 'codes[] или code обязателен', code: 'NO_CODES' });
            }
            if (codes.length > 100) {
                return res.status(400).json({
                    error: 'За один раз не больше 100 артикулов (лимит YM offer-mappings/update)',
                    code: 'TOO_MANY',
                    max: 100,
                    total: codes.length,
                });
            }

            const creds = getYmCreds(appSettings || {});
            if (!creds.apiKey || !creds.businessId) {
                return res.status(400).json({
                    error: 'Не заданы ym_api_key / ym_business_id',
                    code: 'MISSING_CREDS',
                });
            }
            const delayMs = Math.max(
                MP_MIN_DELAY_MS.yandex || 200,
                Number((appSettings && appSettings.mp_yandex_delay_ms) || 280) || 280
            );
            const logger = createMarketplaceLogger('ym-dims');

            const ph = codes.map(() => '?').join(',');
            const [msRows] = await db.query(
                `SELECT m.code,
                        med.denorm_dim_length_cm AS ms_length,
                        med.denorm_dim_width_cm AS ms_width,
                        med.denorm_dim_height_box_cm AS ms_height_box,
                        med.denorm_dim_height_bag_cm AS ms_height_bag,
                        med.denorm_dim_weight_kg AS ms_weight,
                        med.denorm_dim_packing_type AS ms_packing_type,
                        ym.external_id AS ym_code
                 FROM ms_export m
                 LEFT JOIN ms_entity_details med ON med.uuid = m.uuid
                 LEFT JOIN marketplace_export_rows ym
                   ON ym.marketplace = 'yandex_market' AND ym.external_id = m.code
                 WHERE m.code IN (${ph})`,
                codes
            );
            const byCode = new Map();
            for (const r of msRows || []) {
                byCode.set(String(r.code || '').trim(), r);
            }

            const batchItems = [];
            const preResults = [];
            let wouldUpdate = 0;
            let skipped = 0;

            for (const code of codes) {
                const row = byCode.get(code);
                if (!row) {
                    skipped += 1;
                    preResults.push({ code, success: false, skipped: true, error: 'Нет в ms_export', code_err: 'NO_MS' });
                    continue;
                }
                if (!row.ym_code) {
                    skipped += 1;
                    preResults.push({
                        code,
                        success: false,
                        skipped: true,
                        error: 'Нет на Я.Маркет (нет shopSku в снапшоте)',
                        code_err: 'NO_YM',
                    });
                    continue;
                }
                const dims = resolveMsDimsForYmPush(row);
                if (!dims) {
                    skipped += 1;
                    preResults.push({
                        code,
                        offer_id: row.ym_code,
                        success: false,
                        skipped: true,
                        error: 'Неполные габариты МС (нужны длина, ширина, высота, вес)',
                        code_err: 'MS_DIMS_INCOMPLETE',
                    });
                    continue;
                }
                wouldUpdate += 1;
                if (dryRun) {
                    preResults.push({
                        code,
                        offer_id: row.ym_code,
                        success: true,
                        dry_run: true,
                        dims,
                    });
                    continue;
                }
                batchItems.push({
                    code,
                    offerId: row.ym_code,
                    dims,
                });
            }

            let updated = 0;
            let failed = 0;
            const errors = [];
            const results = preResults.slice();

            if (!dryRun && batchItems.length) {
                const batchOut = await updateYmOffersDimensionsBatch(
                    { apiKey: creds.apiKey, businessId: creds.businessId },
                    batchItems.map((it) => ({ offerId: it.offerId, dims: it.dims })),
                    { logger, delayMs, chunkSize: 100, dryRun: false }
                );
                const byOffer = new Map();
                for (const it of batchItems) {
                    byOffer.set(it.offerId, it.code);
                }
                for (const out of batchOut || []) {
                    const code = byOffer.get(String(out.offer_id || '').trim()) || out.offer_id;
                    if (out.success) {
                        updated += 1;
                        try {
                            await patchLocalYmDims(db, out.offer_id, out.dims);
                        } catch (ePatch) {
                            logger.log('local_patch_fail', {
                                offer: out.offer_id,
                                message: ePatch.message,
                            });
                        }
                        results.push({
                            code,
                            offer_id: out.offer_id,
                            success: true,
                            dims: out.dims,
                        });
                    } else if (out.skipped) {
                        skipped += 1;
                        results.push({
                            code,
                            offer_id: out.offer_id,
                            success: false,
                            skipped: true,
                            error: out.error,
                            code_err: out.code,
                        });
                    } else {
                        failed += 1;
                        const errItem = {
                            code,
                            offer_id: out.offer_id,
                            success: false,
                            error: out.error || 'Ошибка Я.Маркет',
                            code_err: out.code || 'YM_FAIL',
                        };
                        results.push(errItem);
                        if (errors.length < 20) {
                            errors.push({ code, error: errItem.error });
                        }
                    }
                }
            }

            return res.json({
                success: failed === 0,
                dry_run: dryRun,
                total: codes.length,
                would_update: wouldUpdate,
                updated: dryRun ? 0 : updated,
                skipped,
                failed,
                errors,
                results: results.slice(0, 80),
                duration_sec: Number(((Date.now() - t0) / 1000).toFixed(2)),
            });
        } catch (e) {
            console.error('[exports/marketplaces] fix-ym-dims failed:', e && e.stack ? e.stack : e);
            return res.status(500).json({ error: e.message || String(e), code: 'FIX_YM_DIMS_FAILED' });
        }
    });

    /**
     * Исправить НДС на Ozon по артикулам (offer_id = код МС).
     * Body: { codes: string[], dry_run?: boolean, confirm?: boolean }
     * Габариты карточки Ozon сохраняются; меняется только vat из МС.
     */
    router.post('/issues/fix-ozon-vat', async (req, res) => {
        const t0 = Date.now();
        try {
            if (!db || typeof db.query !== 'function') {
                return res.status(500).json({ error: 'БД недоступна', code: 'NO_DB' });
            }
            const body = req.body && typeof req.body === 'object' ? req.body : {};
            const dryRun = body.dry_run === true || body.dry_run === 1 || body.dry_run === '1';
            const confirm = body.confirm === true || body.confirm === 1 || body.confirm === '1';
            if (!dryRun && !confirm) {
                return res.status(400).json({ error: 'confirm required (или dry_run=1)', code: 'CONFIRM_REQUIRED' });
            }
            let codes = [];
            if (Array.isArray(body.codes)) {
                codes = body.codes.map((c) => String(c == null ? '' : c).trim()).filter(Boolean);
            } else if (body.code != null && String(body.code).trim()) {
                codes = [String(body.code).trim()];
            }
            codes = Array.from(new Set(codes));
            if (!codes.length) {
                return res.status(400).json({ error: 'codes[] или code обязателен', code: 'NO_CODES' });
            }
            if (codes.length > 200) {
                return res.status(400).json({
                    error: 'За один раз не больше 200 артикулов',
                    code: 'TOO_MANY',
                    max: 200,
                    total: codes.length,
                });
            }

            const creds = getOzonCreds(appSettings || {});
            if (!creds.clientId || !creds.apiKey) {
                return res.status(400).json({
                    error: 'Не заданы ozon_client_id / ozon_api_key',
                    code: 'MISSING_CREDS',
                });
            }
            const delayMs = Math.max(
                MP_MIN_DELAY_MS.ozon || 200,
                Number((appSettings && appSettings.mp_ozon_delay_ms) || 400) || 400
            );
            const logger = createMarketplaceLogger('ozon-vat');

            const ph = codes.map(() => '?').join(',');
            const [msRows] = await db.query(
                `SELECT m.code, m.vat AS ms_vat,
                        ozon.external_id AS ozon_code
                 FROM ms_export m
                 LEFT JOIN marketplace_export_rows ozon
                   ON ozon.marketplace = 'ozon' AND ozon.external_id = m.code
                 WHERE m.code IN (${ph})`,
                codes
            );
            const byCode = new Map();
            for (const r of msRows || []) {
                byCode.set(String(r.code || '').trim(), r);
            }

            const results = [];
            let wouldUpdate = 0;
            let updated = 0;
            let skipped = 0;
            let failed = 0;
            const errors = [];

            for (const code of codes) {
                const row = byCode.get(code);
                if (!row) {
                    skipped += 1;
                    results.push({ code, success: false, skipped: true, error: 'Нет в ms_export', code_err: 'NO_MS' });
                    continue;
                }
                if (!row.ozon_code) {
                    skipped += 1;
                    results.push({
                        code,
                        success: false,
                        skipped: true,
                        error: 'Нет на Ozon (нет offer_id в снапшоте)',
                        code_err: 'NO_OZON',
                    });
                    continue;
                }
                const vatParsed = parseMsVat(row.ms_vat);
                if (!vatParsed.ok) {
                    skipped += 1;
                    results.push({
                        code,
                        offer_id: row.ozon_code,
                        success: false,
                        skipped: true,
                        error: vatParsed.error || 'НДС МС не разобран',
                        code_err: 'MS_VAT_BAD',
                    });
                    continue;
                }
                wouldUpdate += 1;
                if (dryRun) {
                    results.push({
                        code,
                        offer_id: row.ozon_code,
                        success: true,
                        dry_run: true,
                        vat: vatParsed.pretty,
                    });
                    continue;
                }
                const out = await updateOzonOfferVat(creds, {
                    offerId: row.ozon_code,
                    msVat: row.ms_vat,
                    delayMs,
                    logger,
                    waitTask: true,
                });
                if (out.success) {
                    updated += 1;
                    try {
                        await patchLocalOzonVat(db, row.ozon_code, out.vat || vatParsed.pretty);
                    } catch (ePatch) {
                        logger.log('local_patch_fail', { offer: row.ozon_code, message: ePatch.message });
                    }
                    results.push({
                        code,
                        offer_id: row.ozon_code,
                        success: true,
                        task_id: out.task_id,
                        import_status: out.import_status,
                        vat: out.vat || vatParsed.pretty,
                    });
                } else if (out.skipped) {
                    skipped += 1;
                    wouldUpdate -= 1;
                    results.push({
                        code,
                        offer_id: row.ozon_code,
                        success: false,
                        skipped: true,
                        error: out.error,
                        code_err: out.code,
                    });
                } else {
                    failed += 1;
                    const errItem = {
                        code,
                        offer_id: row.ozon_code,
                        success: false,
                        error: out.error || 'Ошибка Ozon',
                        code_err: out.code || 'OZON_FAIL',
                    };
                    results.push(errItem);
                    if (errors.length < 20) {
                        errors.push({ code, error: errItem.error });
                    }
                }
            }

            return res.json({
                success: failed === 0,
                dry_run: dryRun,
                total: codes.length,
                would_update: wouldUpdate,
                updated,
                skipped,
                failed,
                errors,
                results: results.slice(0, 50),
                duration_sec: Number(((Date.now() - t0) / 1000).toFixed(2)),
            });
        } catch (e) {
            console.error('[exports/marketplaces] fix-ozon-vat failed:', e && e.stack ? e.stack : e);
            return res.status(500).json({ error: e.message || String(e), code: 'FIX_OZON_VAT_FAILED' });
        }
    });

    /**
     * Исправить НДС на Wildberries (характеристика 15001405).
     * Body: { codes: string[], dry_run?: boolean, confirm?: boolean }
     * Макс. 100 за запрос.
     */
    router.post('/issues/fix-wb-vat', async (req, res) => {
        const t0 = Date.now();
        try {
            if (!db || typeof db.query !== 'function') {
                return res.status(500).json({ error: 'БД недоступна', code: 'NO_DB' });
            }
            const body = req.body && typeof req.body === 'object' ? req.body : {};
            const dryRun = body.dry_run === true || body.dry_run === 1 || body.dry_run === '1';
            const confirm = body.confirm === true || body.confirm === 1 || body.confirm === '1';
            if (!dryRun && !confirm) {
                return res.status(400).json({ error: 'confirm required (или dry_run=1)', code: 'CONFIRM_REQUIRED' });
            }
            let codes = [];
            if (Array.isArray(body.codes)) {
                codes = body.codes.map((c) => String(c == null ? '' : c).trim()).filter(Boolean);
            } else if (body.code != null && String(body.code).trim()) {
                codes = [String(body.code).trim()];
            }
            codes = Array.from(new Set(codes));
            if (!codes.length) {
                return res.status(400).json({ error: 'codes[] или code обязателен', code: 'NO_CODES' });
            }
            if (codes.length > 100) {
                return res.status(400).json({
                    error: 'За один раз не больше 100 артикулов (лимит WB Content update)',
                    code: 'TOO_MANY',
                    max: 100,
                    total: codes.length,
                });
            }

            const creds = getWbCreds(appSettings || {});
            if (!creds.apiKey) {
                return res.status(400).json({
                    error: 'Не задан wb_api_key',
                    code: 'MISSING_CREDS',
                });
            }
            const delayListMs = Math.max(
                MP_MIN_DELAY_MS.wbCards || 600,
                Number((appSettings && appSettings.mp_wb_delay_cards_ms) || 600) || 600
            );
            const logger = createMarketplaceLogger('wb-vat');

            const ph = codes.map(() => '?').join(',');
            const [msRows] = await db.query(
                `SELECT m.code, m.vat AS ms_vat,
                        wb.external_id AS wb_code,
                        wb.cabinet_url AS wb_cabinet_url,
                        wb.buyer_url AS wb_buyer_url
                 FROM ms_export m
                 LEFT JOIN marketplace_export_rows wb
                   ON wb.marketplace = 'wildberries' AND wb.external_id = m.code
                 WHERE m.code IN (${ph})`,
                codes
            );
            const byCode = new Map();
            for (const r of msRows || []) {
                byCode.set(String(r.code || '').trim(), r);
            }

            const batchItems = [];
            const preResults = [];
            let wouldUpdate = 0;
            let skipped = 0;

            for (const code of codes) {
                const row = byCode.get(code);
                if (!row) {
                    skipped += 1;
                    preResults.push({ code, success: false, skipped: true, error: 'Нет в ms_export', code_err: 'NO_MS' });
                    continue;
                }
                if (!row.wb_code) {
                    skipped += 1;
                    preResults.push({
                        code,
                        success: false,
                        skipped: true,
                        error: 'Нет на WB (нет vendorCode в снапшоте)',
                        code_err: 'NO_WB',
                    });
                    continue;
                }
                const vatParsed = parseMsVat(row.ms_vat);
                if (!vatParsed.ok) {
                    skipped += 1;
                    preResults.push({
                        code,
                        vendor_code: row.wb_code,
                        success: false,
                        skipped: true,
                        error: vatParsed.error || 'НДС МС не разобран',
                        code_err: 'MS_VAT_BAD',
                    });
                    continue;
                }
                wouldUpdate += 1;
                if (dryRun) {
                    preResults.push({
                        code,
                        vendor_code: row.wb_code,
                        success: true,
                        dry_run: true,
                        vat: vatParsed.pretty,
                    });
                    continue;
                }
                batchItems.push({
                    code,
                    vendorCode: row.wb_code,
                    msVat: row.ms_vat,
                    nmIdHint: nmIdFromUrls(row.wb_cabinet_url, row.wb_buyer_url),
                });
            }

            let updated = 0;
            let failed = 0;
            const errors = [];
            const results = preResults.slice();

            if (!dryRun && batchItems.length) {
                const batchOut = await updateWbOffersVatBatch(
                    creds.apiKey,
                    batchItems.map((it) => ({
                        vendorCode: it.vendorCode,
                        msVat: it.msVat,
                        nmIdHint: it.nmIdHint,
                    })),
                    {
                        logger,
                        delayListMs,
                        delayUpdateMs: 6500,
                        updateChunk: 50,
                        dryRun: false,
                    }
                );
                const byVendor = new Map();
                for (const it of batchItems) {
                    byVendor.set(it.vendorCode, it.code);
                }
                for (const out of batchOut || []) {
                    const code = byVendor.get(String(out.vendor_code || '').trim()) || out.vendor_code;
                    if (out.success) {
                        updated += 1;
                        try {
                            await patchLocalWbVat(db, out.vendor_code, out.vat);
                        } catch (ePatch) {
                            logger.log('local_patch_fail', {
                                vendor: out.vendor_code,
                                message: ePatch.message,
                            });
                        }
                        results.push({
                            code,
                            vendor_code: out.vendor_code,
                            nm_id: out.nm_id,
                            success: true,
                            vat: out.vat,
                        });
                    } else if (out.skipped) {
                        skipped += 1;
                        results.push({
                            code,
                            vendor_code: out.vendor_code,
                            success: false,
                            skipped: true,
                            error: out.error,
                            code_err: out.code,
                        });
                    } else {
                        failed += 1;
                        const errItem = {
                            code,
                            vendor_code: out.vendor_code,
                            success: false,
                            error: out.error || 'Ошибка WB',
                            code_err: out.code || 'WB_FAIL',
                        };
                        results.push(errItem);
                        if (errors.length < 20) {
                            errors.push({ code, error: errItem.error });
                        }
                    }
                }
            }

            return res.json({
                success: failed === 0,
                dry_run: dryRun,
                total: codes.length,
                would_update: wouldUpdate,
                updated: dryRun ? 0 : updated,
                skipped,
                failed,
                errors,
                results: results.slice(0, 80),
                duration_sec: Number(((Date.now() - t0) / 1000).toFixed(2)),
            });
        } catch (e) {
            console.error('[exports/marketplaces] fix-wb-vat failed:', e && e.stack ? e.stack : e);
            return res.status(500).json({ error: e.message || String(e), code: 'FIX_WB_VAT_FAILED' });
        }
    });

    /**
     * Исправить НДС на Яндекс Маркете (campaigns/{id}/offers/update).
     * Body: { codes: string[], dry_run?: boolean, confirm?: boolean }
     * Нужны ym_api_key + ym_campaign_id. Макс. 100 за запрос.
     */
    router.post('/issues/fix-ym-vat', async (req, res) => {
        const t0 = Date.now();
        try {
            if (!db || typeof db.query !== 'function') {
                return res.status(500).json({ error: 'БД недоступна', code: 'NO_DB' });
            }
            const body = req.body && typeof req.body === 'object' ? req.body : {};
            const dryRun = body.dry_run === true || body.dry_run === 1 || body.dry_run === '1';
            const confirm = body.confirm === true || body.confirm === 1 || body.confirm === '1';
            if (!dryRun && !confirm) {
                return res.status(400).json({ error: 'confirm required (или dry_run=1)', code: 'CONFIRM_REQUIRED' });
            }
            let codes = [];
            if (Array.isArray(body.codes)) {
                codes = body.codes.map((c) => String(c == null ? '' : c).trim()).filter(Boolean);
            } else if (body.code != null && String(body.code).trim()) {
                codes = [String(body.code).trim()];
            }
            codes = Array.from(new Set(codes));
            if (!codes.length) {
                return res.status(400).json({ error: 'codes[] или code обязателен', code: 'NO_CODES' });
            }
            if (codes.length > 100) {
                return res.status(400).json({
                    error: 'За один раз не больше 100 артикулов (лимит YM offers/update)',
                    code: 'TOO_MANY',
                    max: 100,
                    total: codes.length,
                });
            }

            const creds = getYmCreds(appSettings || {});
            if (!creds.apiKey || !creds.campaignId) {
                return res.status(400).json({
                    error: 'Не заданы ym_api_key / ym_campaign_id',
                    code: 'MISSING_CREDS',
                });
            }
            const delayMs = Math.max(
                MP_MIN_DELAY_MS.yandex || 200,
                Number((appSettings && appSettings.mp_yandex_delay_ms) || 280) || 280
            );
            const logger = createMarketplaceLogger('ym-vat');

            const ph = codes.map(() => '?').join(',');
            const [msRows] = await db.query(
                `SELECT m.code, m.vat AS ms_vat,
                        ym.external_id AS ym_code
                 FROM ms_export m
                 LEFT JOIN marketplace_export_rows ym
                   ON ym.marketplace = 'yandex_market' AND ym.external_id = m.code
                 WHERE m.code IN (${ph})`,
                codes
            );
            const byCode = new Map();
            for (const r of msRows || []) {
                byCode.set(String(r.code || '').trim(), r);
            }

            const batchItems = [];
            const preResults = [];
            let wouldUpdate = 0;
            let skipped = 0;

            for (const code of codes) {
                const row = byCode.get(code);
                if (!row) {
                    skipped += 1;
                    preResults.push({ code, success: false, skipped: true, error: 'Нет в ms_export', code_err: 'NO_MS' });
                    continue;
                }
                if (!row.ym_code) {
                    skipped += 1;
                    preResults.push({
                        code,
                        success: false,
                        skipped: true,
                        error: 'Нет на Я.Маркет (нет shopSku в снапшоте)',
                        code_err: 'NO_YM',
                    });
                    continue;
                }
                const vatParsed = parseMsVat(row.ms_vat);
                if (!vatParsed.ok) {
                    skipped += 1;
                    preResults.push({
                        code,
                        offer_id: row.ym_code,
                        success: false,
                        skipped: true,
                        error: vatParsed.error || 'НДС МС не разобран',
                        code_err: 'MS_VAT_BAD',
                    });
                    continue;
                }
                wouldUpdate += 1;
                if (dryRun) {
                    preResults.push({
                        code,
                        offer_id: row.ym_code,
                        success: true,
                        dry_run: true,
                        vat: vatParsed.pretty,
                    });
                    continue;
                }
                batchItems.push({
                    code,
                    offerId: row.ym_code,
                    msVat: row.ms_vat,
                });
            }

            let updated = 0;
            let failed = 0;
            const errors = [];
            const results = preResults.slice();

            if (!dryRun && batchItems.length) {
                const batchOut = await updateYmOffersVatBatch(
                    { apiKey: creds.apiKey, campaignId: creds.campaignId },
                    batchItems.map((it) => ({ offerId: it.offerId, msVat: it.msVat })),
                    { logger, delayMs, chunkSize: 100, dryRun: false }
                );
                const byOffer = new Map();
                for (const it of batchItems) {
                    byOffer.set(it.offerId, it.code);
                }
                for (const out of batchOut || []) {
                    const code = byOffer.get(String(out.offer_id || '').trim()) || out.offer_id;
                    if (out.success) {
                        updated += 1;
                        try {
                            await patchLocalYmVat(db, out.offer_id, out.vat);
                        } catch (ePatch) {
                            logger.log('local_patch_fail', {
                                offer: out.offer_id,
                                message: ePatch.message,
                            });
                        }
                        results.push({
                            code,
                            offer_id: out.offer_id,
                            success: true,
                            vat: out.vat,
                        });
                    } else if (out.skipped) {
                        skipped += 1;
                        results.push({
                            code,
                            offer_id: out.offer_id,
                            success: false,
                            skipped: true,
                            error: out.error,
                            code_err: out.code,
                        });
                    } else {
                        failed += 1;
                        const errItem = {
                            code,
                            offer_id: out.offer_id,
                            success: false,
                            error: out.error || 'Ошибка Я.Маркет',
                            code_err: out.code || 'YM_FAIL',
                        };
                        results.push(errItem);
                        if (errors.length < 20) {
                            errors.push({ code, error: errItem.error });
                        }
                    }
                }
            }

            return res.json({
                success: failed === 0,
                dry_run: dryRun,
                total: codes.length,
                would_update: wouldUpdate,
                updated: dryRun ? 0 : updated,
                skipped,
                failed,
                errors,
                results: results.slice(0, 80),
                duration_sec: Number(((Date.now() - t0) / 1000).toFixed(2)),
            });
        } catch (e) {
            console.error('[exports/marketplaces] fix-ym-vat failed:', e && e.stack ? e.stack : e);
            return res.status(500).json({ error: e.message || String(e), code: 'FIX_YM_VAT_FAILED' });
        }
    });

    /**
     * Журнал автоснимков «проблемы (scope=any), исключить комплекты» после синхронизации маркетплейсов.
     * Query: days (1–730, default 90), limit (1–500, default 200).
     */
    router.get('/issues/snapshot-log', async (req, res) => {
        try {
            if (!db || typeof db.query !== 'function') {
                return res.status(500).json({ error: 'БД недоступна', code: 'NO_DB' });
            }
            await ensureMpIssuesSnapshotTable(db);
            const daysRaw = parseInt(req.query.days, 10);
            const days = Math.min(730, Math.max(1, Number.isFinite(daysRaw) ? daysRaw : 90));
            const limRaw = parseInt(req.query.limit, 10);
            const limit = Math.min(500, Math.max(1, Number.isFinite(limRaw) ? limRaw : 200));
            const [dbRows] = await db.query(
                `SELECT id, stat_date, recorded_at, trigger_type, schedule_slot_time, scope,
                        exclude_bundle_components, total_count, by_manager_json, by_content_manager_json,
                        removed_by_bundle_filter
                 FROM mp_issues_daily_snapshot
                 WHERE recorded_at >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? DAY)
                 ORDER BY recorded_at DESC, id DESC
                 LIMIT ?`,
                [days, limit]
            );
            const rows = (dbRows || []).map((r) => {
                let byManager = r.by_manager_json;
                let byCm = r.by_content_manager_json;
                if (Buffer.isBuffer(byManager)) {
                    try {
                        byManager = JSON.parse(byManager.toString('utf8'));
                    } catch (_) {
                        byManager = {};
                    }
                }
                if (Buffer.isBuffer(byCm)) {
                    try {
                        byCm = JSON.parse(byCm.toString('utf8'));
                    } catch (_) {
                        byCm = {};
                    }
                }
                if (typeof byManager === 'string') {
                    try {
                        byManager = JSON.parse(byManager);
                    } catch (_) {
                        byManager = {};
                    }
                }
                if (typeof byCm === 'string') {
                    try {
                        byCm = JSON.parse(byCm);
                    } catch (_) {
                        byCm = {};
                    }
                }
                return {
                    id: r.id,
                    stat_date: formatSnapshotStatDateDisplay(r.stat_date),
                    recorded_at: formatSnapshotRecordedAtMskDisplay(r.recorded_at),
                    trigger_type: r.trigger_type,
                    schedule_slot_time: r.schedule_slot_time,
                    scope: r.scope,
                    exclude_bundle_components: Number(r.exclude_bundle_components) === 1,
                    total_count: Number(r.total_count || 0),
                    by_manager: byManager && typeof byManager === 'object' ? byManager : {},
                    by_content_manager: byCm && typeof byCm === 'object' ? byCm : {},
                    removed_by_bundle_filter: Number(r.removed_by_bundle_filter || 0),
                };
            });
            return res.json({ success: true, days, limit, count: rows.length, rows });
        } catch (e) {
            console.error('[exports/marketplaces] issues snapshot-log failed:', e && e.stack ? e.stack : e);
            return res.status(500).json({ error: e.message || String(e), code: 'ISSUES_SNAPSHOT_LOG_FAILED' });
        }
    });

    /**
     * Записать снимок «есть проблемы + исключить комплекты» из текущих данных БД (без запросов к API маркетплейсов).
     * Удобно, если журнал пустой, а полный синк давно не запускали.
     */
    router.post('/issues/snapshot-run', async (req, res) => {
        try {
            if (!db || typeof db.query !== 'function') {
                return res.status(500).json({ error: 'БД недоступна', code: 'NO_DB' });
            }
            const body = req.body && typeof req.body === 'object' ? req.body : {};
            const triggerType = String(body.trigger_type || 'manual_ui').trim().slice(0, 24) || 'manual_ui';
            const scheduleSlotTime = String(body.schedule_slot_time || '').trim().slice(0, 8);
            await appendMarketplaceIssuesSnapshot(db, appSettings, { triggerType, scheduleSlotTime });
            return res.json({ success: true, trigger_type: triggerType });
        } catch (e) {
            console.error('[exports/marketplaces] issues snapshot-run failed:', e && e.stack ? e.stack : e);
            return res.status(500).json({ error: e.message || String(e), code: 'ISSUES_SNAPSHOT_RUN_FAILED' });
        }
    });

    return router;
};
