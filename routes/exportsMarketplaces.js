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
    perMarket: {
        ozon: { status: 'idle', count: 0, error: '' },
        wb: { status: 'idle', count: 0, error: '' },
        ym: { status: 'idle', count: 0, error: '' },
    },
};

function resetSyncState() {
    syncState.active = true;
    syncState.startedAt = new Date().toISOString();
    syncState.finishedAt = null;
    syncState.message = 'Запуск обновления маркетплейсов...';
    syncState.perMarket = {
        ozon: { status: 'pending', count: 0, error: '' },
        wb: { status: 'pending', count: 0, error: '' },
        ym: { status: 'pending', count: 0, error: '' },
    };
}

module.exports = function exportsMarketplacesRouter(db, appSettings) {
    const router = express.Router();
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
            if (apiStatus === 429) {
                friendly = `${mpName} вернул 429 (rate limit) — превышен лимит запросов в минуту. Подождите 1–2 минуты и попробуйте снова. Если повторяется — увеличьте паузу в «Настройки → Маркетплейсы → задержка между запросами».`;
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
                        count: Number(res.persisted || 0),
                        error: '',
                    };
                } catch (eOne) {
                    syncState.perMarket[k] = {
                        status: 'failed',
                        count: 0,
                        error: eOne.message || String(eOne),
                    };
                }
            }
            syncState.active = false;
            syncState.finishedAt = new Date().toISOString();
            syncState.message = 'Обновление маркетплейсов завершено';
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

    /**
     * Расхождение габаритов между маркетплейсами: товар есть минимум на двух площадках,
     * и по хотя бы одной оси (длина/ширина/высота/вес) обе отдают число и оно расходится
     * с допуском ISSUES_DIM_EPS. В `ms_export` нет отдельных полей см/кг для сравнения с МС.
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
            rows = (rows || []).filter((r) => issuesRowDimsMismatchAcrossMps(r));
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
     *   dims_mismatch  — товар есть минимум на двух площадках; по оси L/W/H/вес обе отдают число и оно расходится (число vs пусто — нет).
     *                    (в ms_export нет полей длины/ширины для сравнения с МС.)
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
                'manager', 'content_manager', 'ms_vat', 'ms_stock', 'synced_at',
                'ozon_code', 'ozon_name', 'ozon_vat', 'ozon_stock',
                'ozon_length', 'ozon_width', 'ozon_height', 'ozon_weight',
                'ozon_cabinet_url', 'ozon_buyer_url', 'ozon_updated',
                'wb_code', 'wb_name', 'wb_vat', 'wb_stock',
                'wb_length', 'wb_width', 'wb_height', 'wb_weight',
                'wb_cabinet_url', 'wb_buyer_url', 'wb_updated',
                'ym_code', 'ym_name', 'ym_vat', 'ym_stock',
                'ym_length', 'ym_width', 'ym_height', 'ym_weight',
                'ym_cabinet_url', 'ym_buyer_url', 'ym_updated',
            ];
            const headerLabels = [
                'Код МС', 'Название МС',
                'Менеджер', 'Контент-менеджер', 'НДС МС', 'Остаток по МС', 'Синхронизация МС',
                'Код Ozon', 'Название Ozon', 'НДС Ozon', 'Остаток Ozon',
                'Длина (см) Ozon', 'Ширина (см) Ozon', 'Высота (см) Ozon', 'Вес (кг) Ozon',
                'Кабинет Ozon', 'Покупателю Ozon', 'Обновлено Ozon',
                'Код Wildberries', 'Название Wildberries', 'НДС WB', 'Остаток WB',
                'Длина (см) WB', 'Ширина (см) WB', 'Высота (см) WB', 'Вес (кг) WB',
                'Кабинет WB', 'Покупателю WB', 'Обновлено WB',
                'Код Я.Маркет', 'Название Я.Маркет', 'НДС Я.Маркет', 'Остаток Я.Маркет',
                'Длина (см) Я.Маркет', 'Ширина (см) Я.Маркет', 'Высота (см) Я.Маркет', 'Вес (кг) Я.Маркет',
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
