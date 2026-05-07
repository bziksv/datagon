'use strict';

const express = require('express');
const {
    exportOzonRows,
    exportWildberriesRows,
    exportYandexMarketRows,
    rowsToCsvSemicolon,
    rowObjectsToMatrix,
    MP_MIN_DELAY_MS,
} = require('../lib/marketplaceExports');
const { persistMarketplaceRows, loadMarketplaceSnapshotRows } = require('../lib/marketplaceExportStore');

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
    const titlesByKind = {
        ozon: {
            offer_id: 'Артикул (offer_id) Ozon',
            name: 'Наименование Ozon',
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
        res.json({
            configured: {
                ozon: maskSet(ozon.clientId) && maskSet(ozon.apiKey),
                wildberries: maskSet(wb.apiKey),
                yandex_market: maskSet(ym.apiKey) && maskSet(ym.campaignId),
            },
            /** Паузы между запросами не опускаются ниже этих значений; при 429/503 — повтор с учётом Retry-After (см. lib/marketplaceExports.js). */
            rate_limits_ms_min: MP_MIN_DELAY_MS,
            delay_defaults_ms: {
                ozon: parseMsOrDefault(appSettings.mp_ozon_delay_ms, 400, MP_MIN_DELAY_MS.ozon),
                wb_cards: parseMsOrDefault(appSettings.mp_wb_delay_cards_ms, 600, MP_MIN_DELAY_MS.wbCards),
                wb_other: parseMsOrDefault(appSettings.mp_wb_delay_other_ms, 1600, MP_MIN_DELAY_MS.wbPricesStocks),
                yandex: parseMsOrDefault(appSettings.mp_yandex_delay_ms, 280, MP_MIN_DELAY_MS.yandex),
            },
            hints: {
                env: 'Можно задать переменные окружения: OZON_CLIENT_ID, OZON_API_KEY, WB_API_KEY, YM_API_KEY, YM_CAMPAIGN_ID, YM_BUSINESS_ID (опционально для ссылки покупателю).',
                settings:
                    'Либо ключи/лимиты в БД через POST /api/exports/marketplaces/config (см. api.md): ozon_client_id, ozon_api_key, wb_api_key, ym_api_key, ym_campaign_id, ym_business_id, mp_ozon_delay_ms, mp_wb_delay_cards_ms, mp_wb_delay_other_ms, mp_yandex_delay_ms.',
                pacing:
                    'Query delay_* можно только увеличить относительно дефолта; жёсткий минимум в rate_limits_ms_min. Лимиты кабинетов уточняйте в официальной документации маркетплейсов.',
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
            const sourceRows = await loadMarketplaceSnapshotRows(db, kind, req.query.max_items);
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
                obj.vat = obj.vat || row.vat || '';
                obj.cabinet_url = obj.cabinet_url || row.cabinet_url || '';
                obj.buyer_url = obj.buyer_url || row.buyer_url || '';
                obj.updated = obj.updated || row.updated_label || '';
                return obj;
            });
            const updatedAt = rows.length ? rows[0].updated || '' : '';
            return res.json({
                marketplace: kind,
                source: 'snapshot',
                updatedAt,
                count: rows.length,
                headers: headerKeys,
                headerLabels,
                rows,
            });
        } catch (e) {
            return res.status(500).json({ error: e.message || String(e), code: 'SNAPSHOT_FAILED' });
        }
    });

    async function handleExport(req, res, kind, runner, csvTitleRuByKey) {
        const format = String(req.query.format || 'json').toLowerCase() === 'csv' ? 'csv' : 'json';
        const maxItems = Math.max(1, Math.min(parseInt(req.query.max_items || '5000', 10) || 5000, 25000));
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
                        }
                      : {
                            maxItems,
                            delayMs: parseMsOrDefault(
                                req.query.delay_ms || appSettings.mp_yandex_delay_ms,
                                280,
                                MP_MIN_DELAY_MS.yandex,
                            ),
                        };
            const { headerKeys, rows, updatedAt } = await runner(creds, opts);
            const persisted = await persistMarketplaceRows(db, kind, rows, updatedAt);

            if (format === 'csv') {
                const titles = headerKeys.map((k) => csvTitleRuByKey[k] || k);
                const matrix = rowObjectsToMatrix(headerKeys, rows);
                const csv = rowsToCsvSemicolon(titles, matrix);
                const fname = `datagon-${kind}-export-${updatedAt.replace(/[^\d]/g, '')}.csv`;
                res.setHeader('Content-Type', 'text/csv; charset=utf-8');
                res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
                return res.send(csv);
            }
            const headerLabels = headerKeys.map((k) => csvTitleRuByKey[k] || k);
            return res.json({
                marketplace: kind,
                updatedAt,
                count: rows.length,
                persisted_count: persisted,
                headers: headerKeys,
                headerLabels,
                rows,
            });
        } catch (e) {
            const code = e.code || 'EXPORT_FAILED';
            const status = code === 'MISSING_CREDS' ? 400 : 502;
            return res.status(status).json({
                error: e.message || String(e),
                code,
            });
        }
    }

    async function runSingleRefresh(kind) {
        const creds =
            kind === 'ozon'
                ? getOzonCreds(appSettings)
                : kind === 'wb'
                  ? getWbCreds(appSettings)
                  : getYmCreds(appSettings);
        const opts =
            kind === 'ozon'
                ? {
                      maxItems: 25000,
                      includeArchived: Number(appSettings.mp_ozon_include_archived || 0) === 1,
                      delayMs: parseMsOrDefault(appSettings.mp_ozon_delay_ms, 400, MP_MIN_DELAY_MS.ozon),
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
                    }
                  : {
                        maxItems: 25000,
                        delayMs: parseMsOrDefault(appSettings.mp_yandex_delay_ms, 280, MP_MIN_DELAY_MS.yandex),
                    };
        const runner =
            kind === 'ozon' ? exportOzonRows : kind === 'wb' ? exportWildberriesRows : exportYandexMarketRows;
        const { rows, updatedAt } = await runner(creds, opts);
        const persisted = await persistMarketplaceRows(db, kind, rows, updatedAt);
        return { persisted, count: rows.length, updatedAt };
    }

    async function triggerRefreshMarkets(kindRaw = 'all') {
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

    return router;
};
