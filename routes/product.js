'use strict';

/**
 * Карточка товара — агрегатный read-only endpoint для страницы /product.html.
 *
 * Контракт:
 *   • Источник истины для базовых полей — `ms_export` (синк МС).
 *   • Полная карточка (атрибуты, цены, барcодes, packagings) — `ms_entity_details.payload_json`.
 *   • Продажи — `ms_demand_position` + `ms_demand` (берём по `p.ms_export_code`).
 *   • Override-поля (для блока «Закупки»: min_stock_dg, multiplicity, и т.д.) —
 *     из `dg_purchase_overrides`. Совместно с `routes/purchase.js`.
 *   • Лог «нулевых остатков по складам» — отдельная таблица `dg_product_zero_stock_log`
 *     (см. ensureZeroStockSchema). Пока поддерживается общий лог (`store_uuid='__total__'`),
 *     место под пo-складскую разбивку зарезервировано (после расширения синка
 *     `report/stock/bystore` сможем писать `store_uuid` реальный).
 *
 * Эндпоинты:
 *   GET    /api/product/:code                  — агрегатная карточка.
 *   GET    /api/product/:code/zero-stock-log   — лог нулевых остатков.
 *   POST   /api/product/:code/zero-stock-log   — ручная фиксация (если stock<=0).
 *
 * См. правила:
 *   .cursor/rules/datagon-list-page-baseline-moysklad.mdc (таблица карточки — не списочная)
 *   .cursor/rules/datagon-node-restart-lock.mdc           (после правок — рестарт Node)
 *   .cursor/rules/datagon-documentation-sync.mdc          (api.md + docs/product.md)
 */

const express = require('express');

let zeroStockSchemaReady = false;

/** Окна для агрегатов продаж. Совмещены с «суточными» колонками в /purchase.html. */
const SALES_WINDOWS = [3, 5, 7, 15, 30, 60, 90, 180, 365];
const ZERO_LOG_DEFAULT_STORE = '__total__';

async function ensureZeroStockSchema(db) {
    if (zeroStockSchemaReady) return;
    await db.query(`
        CREATE TABLE IF NOT EXISTS dg_product_zero_stock_log (
            id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
            code VARCHAR(255) NOT NULL,
            store_uuid VARCHAR(255) NOT NULL DEFAULT '__total__',
            store_name VARCHAR(255) NULL DEFAULT NULL,
            ts_date DATE NOT NULL,
            total_stock DECIMAL(15,3) NULL DEFAULT NULL,
            source VARCHAR(40) NOT NULL DEFAULT 'manual',
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            UNIQUE KEY uniq_zero_code_store_date (code, store_uuid, ts_date),
            INDEX idx_zero_code_date (code, ts_date)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    zeroStockSchemaReady = true;
}

function parsePayloadSafe(raw) {
    if (!raw) return null;
    try {
        const o = JSON.parse(raw);
        return o && typeof o === 'object' ? o : null;
    } catch (_) {
        return null;
    }
}

function toMoneyRub(centsRaw) {
    const cents = Number(centsRaw);
    if (!Number.isFinite(cents)) return null;
    return Math.round(cents) / 100;
}

function buildSupplierLabel(s1Raw, s2Raw) {
    const s1 = String(s1Raw || '').trim();
    const s2 = String(s2Raw || '').trim();
    if (!s1 && !s2) return '';
    if (s1 && !s2) return s1;
    if (!s1 && s2) return s2;
    if (s1.toLowerCase() === s2.toLowerCase()) return s1;
    return `${s1}/${s2}`;
}

/** Нормализуем атрибуты payload в формат [{name, value, type}]. */
function extractAttributes(payload) {
    const arr = [];
    if (!payload || !Array.isArray(payload.attributes)) return arr;
    for (const a of payload.attributes) {
        if (!a) continue;
        const name = String(a.name || a.id || '').trim();
        if (!name) continue;
        let value = a.value;
        if (value && typeof value === 'object') {
            if (typeof value.name === 'string' && value.name) value = value.name;
            else if (typeof value.value === 'string' && value.value) value = value.value;
            else value = JSON.stringify(value);
        }
        arr.push({
            name,
            type: a.type || '',
            value: value == null ? '' : String(value),
        });
    }
    return arr;
}

/** Все цены продажи + buy/min из payload, в нормализованном виде. */
function extractPrices(payload) {
    const prices = [];
    if (!payload) return prices;
    if (payload.buyPrice && payload.buyPrice.value != null) {
        const v = toMoneyRub(payload.buyPrice.value);
        if (v != null) prices.push({ kind: 'buy', name: 'Закупочная цена', value: v, currency: payload.buyPrice?.currency?.code || 'RUB' });
    }
    if (payload.minPrice && payload.minPrice.value != null) {
        const v = toMoneyRub(payload.minPrice.value);
        if (v != null) prices.push({ kind: 'min', name: 'Минимальная цена', value: v, currency: payload.minPrice?.currency?.code || 'RUB' });
    }
    if (Array.isArray(payload.salePrices)) {
        for (const sp of payload.salePrices) {
            if (!sp || sp.value == null) continue;
            const v = toMoneyRub(sp.value);
            if (v == null) continue;
            const name = String(sp?.priceType?.name || 'Цена продажи').trim();
            prices.push({
                kind: 'sale',
                name,
                value: v,
                currency: sp?.currency?.code || 'RUB',
            });
        }
    }
    return prices;
}

function extractPackagings(payload) {
    const out = [];
    if (!payload || !Array.isArray(payload.packagings)) return out;
    for (const pk of payload.packagings) {
        if (!pk) continue;
        out.push({
            name: String(pk?.name || '').trim() || (pk?.parentpackagingref ? 'Упаковка' : ''),
            quantity: pk?.quantity != null ? Number(pk.quantity) : null,
            barcodes: Array.isArray(pk?.barcodes)
                ? pk.barcodes.map((b) => (typeof b === 'string' ? b : (b?.ean13 || b?.ean8 || b?.code128 || ''))).filter(Boolean)
                : [],
        });
    }
    return out;
}

function extractBarcodes(payload) {
    if (!payload || !Array.isArray(payload.barcodes)) return [];
    const out = [];
    for (const b of payload.barcodes) {
        if (!b) continue;
        if (typeof b === 'string') out.push(b);
        else if (b.ean13) out.push(`EAN13: ${b.ean13}`);
        else if (b.ean8) out.push(`EAN8: ${b.ean8}`);
        else if (b.code128) out.push(`Code128: ${b.code128}`);
    }
    return out;
}

/** Остаток + ожидание (если в payload встретился `inTransit`). */
function extractStock(msExportRow, payload) {
    const stock = msExportRow ? Number(msExportRow.stock || 0) : 0;
    const reserve = payload && payload.reserve != null ? Number(payload.reserve) : null;
    const inTransit = payload && payload.inTransit != null ? Number(payload.inTransit) : null;
    return {
        stock: Number.isFinite(stock) ? stock : 0,
        reserve: Number.isFinite(reserve) ? reserve : null,
        in_transit: Number.isFinite(inTransit) ? inTransit : null,
        min_stock: msExportRow && msExportRow.min_stock != null ? Number(msExportRow.min_stock) : null,
    };
}

async function loadSalesAggregates(db, code) {
    const out = {};
    for (const days of SALES_WINDOWS) {
        const [rows] = await db.query(
            `SELECT
                COALESCE(SUM(p.quantity), 0) AS sum_qty,
                COALESCE(SUM(p.sum_minor), 0) AS sum_amount_minor,
                COUNT(*) AS positions
             FROM ms_demand_position p
             INNER JOIN ms_demand d ON d.uuid = p.demand_uuid
             WHERE p.ms_export_code = ?
               AND d.applicable = 1
               AND d.moment >= (NOW() - INTERVAL ? DAY)`,
            [code, days],
        );
        const r = rows && rows[0] ? rows[0] : { sum_qty: 0, sum_amount_minor: 0, positions: 0 };
        out[`d${days}`] = {
            days,
            sum_qty: Number(r.sum_qty || 0),
            sum_amount: Number(r.sum_amount_minor || 0) / 100,
            positions: Number(r.positions || 0),
            avg_per_day: days > 0 ? Number(r.sum_qty || 0) / days : 0,
        };
    }
    return out;
}

async function loadRecentSales(db, code, limit, days) {
    const lim = Math.min(500, Math.max(1, Number(limit) || 30));
    const period = Math.min(365 * 5, Math.max(1, Number(days) || 365));
    const [rows] = await db.query(
        `SELECT d.uuid AS demand_uuid, d.doc_name, d.moment, d.applicable,
                d.agent_name, d.store_name,
                p.position_uuid, p.quantity, p.price_minor, p.sum_minor,
                p.assortment_kind
           FROM ms_demand_position p
           INNER JOIN ms_demand d ON d.uuid = p.demand_uuid
          WHERE p.ms_export_code = ?
            AND d.moment >= (NOW() - INTERVAL ? DAY)
          ORDER BY d.moment DESC
          LIMIT ?`,
        [code, period, lim],
    );
    return rows.map((r) => ({
        demand_uuid: String(r.demand_uuid),
        doc_name: String(r.doc_name || ''),
        moment: r.moment ? new Date(r.moment).toISOString() : null,
        applicable: !!r.applicable,
        agent_name: r.agent_name ? String(r.agent_name) : '',
        store_name: r.store_name ? String(r.store_name) : '',
        position_uuid: String(r.position_uuid || ''),
        assortment_kind: String(r.assortment_kind || ''),
        quantity: Number(r.quantity || 0),
        price: Number(r.price_minor || 0) / 100,
        sum: Number(r.sum_minor || 0) / 100,
    }));
}

async function loadZeroStockLog(db, code, days) {
    await ensureZeroStockSchema(db);
    const period = Math.min(365 * 5, Math.max(1, Number(days) || 90));
    const [rows] = await db.query(
        `SELECT id, code, store_uuid, store_name, ts_date, total_stock, source, created_at
           FROM dg_product_zero_stock_log
          WHERE code = ?
            AND ts_date >= (CURDATE() - INTERVAL ? DAY)
          ORDER BY ts_date DESC, created_at DESC
          LIMIT 1000`,
        [code, period],
    );
    return rows.map((r) => ({
        id: Number(r.id),
        store_uuid: String(r.store_uuid || ZERO_LOG_DEFAULT_STORE),
        store_name: r.store_name ? String(r.store_name) : '',
        ts_date: r.ts_date ? new Date(r.ts_date).toISOString().slice(0, 10) : null,
        total_stock: r.total_stock != null ? Number(r.total_stock) : null,
        source: r.source ? String(r.source) : 'manual',
        created_at: r.created_at ? new Date(r.created_at).toISOString() : null,
    }));
}

function createProductRouter(db /* , appSettings */) {
    const router = express.Router();

    /** GET /api/product/:code — агрегатная карточка. */
    router.get('/:code', async (req, res) => {
        try {
            const code = String(req.params.code || '').trim();
            if (!code) return res.status(400).json({ success: false, error: 'Не указан code' });
            const recentLimit = Math.min(500, Math.max(1, parseInt(req.query.recent_limit, 10) || 30));
            const recentDays = Math.min(365 * 5, Math.max(1, parseInt(req.query.recent_days, 10) || 365));
            const zeroDays = Math.min(365 * 5, Math.max(1, parseInt(req.query.zero_days, 10) || 90));

            await ensureZeroStockSchema(db);

            const [msRows] = await db.query(
                `SELECT mse.*, med.payload_json
                   FROM ms_export mse
                   LEFT JOIN ms_entity_details med ON med.uuid = mse.uuid
                  WHERE mse.code = ?
                  LIMIT 1`,
                [code],
            );
            if (!msRows.length) {
                return res.status(404).json({ success: false, error: 'Товар с таким кодом не найден в ms_export' });
            }
            const mse = msRows[0];
            const payload = parsePayloadSafe(mse.payload_json);

            const [poRows] = await db.query(
                `SELECT code, min_stock_dg, multiplicity, min_stock_calc_as,
                        proposed_min_stock, pack_qty_manual, note, updated_at
                   FROM dg_purchase_overrides
                  WHERE code = ?
                  LIMIT 1`,
                [code],
            );
            const override = poRows && poRows[0] ? poRows[0] : null;

            const [salesAggregates, recentSales, zeroLog] = await Promise.all([
                loadSalesAggregates(db, code),
                loadRecentSales(db, code, recentLimit, recentDays),
                loadZeroStockLog(db, code, zeroDays),
            ]);

            const supplierLabel = buildSupplierLabel(mse.supplier, mse.supplier2);
            const article = payload && typeof payload.article === 'string' ? payload.article : '';

            const prices = extractPrices(payload);
            if (!prices.length && mse.buy_price) {
                prices.push({ kind: 'buy', name: 'Закупочная цена', value: mse.buy_price, currency: 'RUB' });
            }

            const stockBlock = extractStock(mse, payload);

            const ms = {
                code: mse.code || '',
                uuid: mse.uuid || '',
                article,
                name: mse.name || (payload?.name || ''),
                description: payload?.description ? String(payload.description) : '',
                type: mse.type || '',
                is_archived: Number(mse.is_archived || 0),
                supplier: mse.supplier || '',
                supplier2: mse.supplier2 || '',
                supplier_label: supplierLabel,
                stock_position: mse.stock_position || '',
                manager: mse.manager || '',
                content_manager: mse.content_manager || '',
                vat: mse.vat || '',
                vat_on_product: mse.vat_on_product || '',
                packing_standard: mse.packing_standard || '',
                packing_own_box: mse.packing_own_box || '',
                packing_weight: mse.packing_weight || '',
                no_longer_cooperation: mse.no_longer_cooperation || '',
                automation_price: mse.automation_price || '',
                buy_price: mse.buy_price || '',
                min_stock: mse.min_stock != null ? Number(mse.min_stock) : null,
                stock: Number(mse.stock || 0),
                synced_at: mse.synced_at ? new Date(mse.synced_at).toISOString() : null,
                web_href: payload?.meta?.uuidHref ? String(payload.meta.uuidHref) : null,
                attributes: extractAttributes(payload),
                packagings: extractPackagings(payload),
                barcodes: extractBarcodes(payload),
                images: Array.isArray(payload?.images)
                    ? payload.images
                        .map((im) => im?.miniature?.downloadHref || im?.meta?.downloadHref || im?.filename || '')
                        .filter(Boolean)
                    : [],
            };

            res.json({
                success: true,
                code,
                ms,
                override: override || null,
                prices,
                stock: stockBlock,
                sales: {
                    aggregates: salesAggregates,
                    recent: recentSales,
                    recent_days: recentDays,
                    recent_limit: recentLimit,
                },
                zero_stock: {
                    days: zeroDays,
                    rows: zeroLog,
                    note: 'Сейчас фиксация общая по товару. Разбивка по складам появится после расширения синка report/stock/bystore.',
                },
                formula: {
                    placeholder: true,
                    description: 'Формула продаж будет добавлена позже (TBD).',
                },
            });
        } catch (err) {
            console.error('[product][get] error:', err);
            res.status(500).json({ success: false, error: err && err.message ? err.message : 'Внутренняя ошибка' });
        }
    });

    /** GET /api/product/:code/zero-stock-log?days=90 — расширенный лог нулевых остатков. */
    router.get('/:code/zero-stock-log', async (req, res) => {
        try {
            const code = String(req.params.code || '').trim();
            if (!code) return res.status(400).json({ success: false, error: 'Не указан code' });
            const days = Math.min(365 * 5, Math.max(1, parseInt(req.query.days, 10) || 90));
            const rows = await loadZeroStockLog(db, code, days);
            res.json({ success: true, code, days, rows });
        } catch (err) {
            console.error('[product][zero-log] error:', err);
            res.status(500).json({ success: false, error: err && err.message ? err.message : 'Внутренняя ошибка' });
        }
    });

    /**
     * POST /api/product/:code/zero-stock-log — зафиксировать «нет на складе» сейчас.
     * Body: { store_uuid?, store_name?, ts_date? (YYYY-MM-DD, по умолчанию сегодня), force? (1) }
     * Без force: пишет только если ms_export.stock <= 0. С force=1 — пишет всегда.
     */
    router.post('/:code/zero-stock-log', express.json({ limit: '32kb' }), async (req, res) => {
        try {
            const code = String(req.params.code || '').trim();
            if (!code) return res.status(400).json({ success: false, error: 'Не указан code' });
            await ensureZeroStockSchema(db);

            const body = req.body || {};
            const storeUuid = String(body.store_uuid || ZERO_LOG_DEFAULT_STORE).trim() || ZERO_LOG_DEFAULT_STORE;
            const storeName = body.store_name ? String(body.store_name).trim() : null;
            const force = String(body.force || '0') === '1';
            const tsDateRaw = body.ts_date ? String(body.ts_date).trim() : '';
            const tsDate = /^\d{4}-\d{2}-\d{2}$/.test(tsDateRaw) ? tsDateRaw : null;

            const [msRows] = await db.query(
                `SELECT code, stock FROM ms_export WHERE code = ? LIMIT 1`,
                [code],
            );
            if (!msRows.length) {
                return res.status(404).json({ success: false, error: 'Товар не найден в ms_export' });
            }
            const stock = Number(msRows[0].stock || 0);
            if (!force && stock > 0) {
                return res.status(400).json({
                    success: false,
                    error: `Текущий остаток = ${stock}, > 0. Чтобы всё равно зафиксировать, передайте force: 1`,
                    stock,
                });
            }

            const insertSql = tsDate
                ? `INSERT INTO dg_product_zero_stock_log (code, store_uuid, store_name, ts_date, total_stock, source)
                   VALUES (?, ?, ?, ?, ?, 'manual')
                   ON DUPLICATE KEY UPDATE total_stock = VALUES(total_stock), source = 'manual', store_name = VALUES(store_name)`
                : `INSERT INTO dg_product_zero_stock_log (code, store_uuid, store_name, ts_date, total_stock, source)
                   VALUES (?, ?, ?, CURDATE(), ?, 'manual')
                   ON DUPLICATE KEY UPDATE total_stock = VALUES(total_stock), source = 'manual', store_name = VALUES(store_name)`;

            const args = tsDate
                ? [code, storeUuid, storeName, tsDate, stock]
                : [code, storeUuid, storeName, stock];
            await db.query(insertSql, args);

            const [verifyRows] = await db.query(
                `SELECT id, code, store_uuid, store_name, ts_date, total_stock, source, created_at
                   FROM dg_product_zero_stock_log
                  WHERE code = ? AND store_uuid = ? AND ts_date = COALESCE(?, CURDATE())
                  LIMIT 1`,
                [code, storeUuid, tsDate],
            );
            const stored = verifyRows && verifyRows[0] ? verifyRows[0] : null;

            res.json({ success: true, code, stored });
        } catch (err) {
            console.error('[product][zero-log][post] error:', err);
            res.status(500).json({ success: false, error: err && err.message ? err.message : 'Внутренняя ошибка' });
        }
    });

    return router;
}

module.exports = createProductRouter;
module.exports.createProductRouter = createProductRouter;
module.exports.ensureZeroStockSchema = ensureZeroStockSchema;
