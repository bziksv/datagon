'use strict';

/**
 * Закупки — страница планирования закупок поверх ms_export.
 *
 * Контракт:
 *   • Источник истины для базовых полей — `ms_export` (синк МС).
 *   • Дополнительные сырые поля (артикул, packagings, в пути / inTransit) —
 *     из `ms_entity_details.payload_json` (JSON ответа entity/product|bundle).
 *   • Редактируемые значения (Неснижаемый остаток Датагон / Кратность товара /
 *     Мин.Остаток сч.как / Предлагаемый нес.остаток) хранятся в отдельной
 *     таблице `dg_purchase_overrides` (PK = code), чтобы синк МС не затирал
 *     их и схема ms_export не разрасталась.
 *   • Фильтр по умолчанию (по требованию пользователя):
 *       is_archived = 0 (только активные)
 *       stock_position = 'да' (только складская позиция)
 *       type = 'Товар' (исключаем комплекты)
 *
 * Эндпоинты:
 *   GET    /api/purchase            — список товаров с overrides и raw-полями; для каждой строки
 *                            дополнительно считается `formula_proposed_min_stock` (как на карточке товара),
 *                            а также «снимок» продаж за 3…365 дн. (`d_*a`) и дней отсутствия (`d_*b`) для 15/30/60/90/180/365.
 *   POST   /api/purchase/override   — сохранить одно значение (code + field + value).
 *
 * См. правила:
 *   .cursor/rules/datagon-list-page-baseline-moysklad.mdc
 *   .cursor/rules/datagon-list-query-patterns.mdc
 *   .cursor/rules/datagon-table-filter-apply.mdc
 *   .cursor/rules/datagon-node-restart-lock.mdc
 *   .cursor/rules/datagon-documentation-sync.mdc
 */

const express = require('express');
const { parseFormulaSettings, pickMarketPriceRub, computeSalesFormula } = require('../lib/datagonSalesFormula');
const { ensureZeroStockSchema, ensureBundleComponentsSchema } = require('./product');

let schemaReady = false;

const OVERRIDE_FIELDS = new Set([
    'min_stock_dg',
    'multiplicity',
    'min_stock_calc_as',
    'proposed_min_stock',
    'pack_qty_manual'
]);

const ALLOWED_SORT = {
    code: 'mse.code',
    article: 'article_sort',
    name: 'mse.name',
    supplier: 'mse.supplier',
    buy_price: 'buy_price_num',
    min_stock: 'mse.min_stock',
    automation_price: 'mse.automation_price',
    min_stock_dg: 'po.min_stock_dg',
    multiplicity: 'po.multiplicity',
    min_stock_calc_as: 'po.min_stock_calc_as',
    proposed_min_stock: 'po.proposed_min_stock',
    stock: 'mse.stock',
    is_archived: 'mse.is_archived',
    /* SQL-заглушка; фактический порядок — после enrich (см. PURCHASE_POST_SORT_KEYS). */
    formula_proposed_min_stock: 'mse.code',
    in_transit: 'mse.code',
    d_3: 'mse.code',
    d_5: 'mse.code',
    d_7: 'mse.code',
    d_15a: 'mse.code',
    d_15b: 'mse.code',
    d_30a: 'mse.code',
    d_30b: 'mse.code',
    d_60a: 'mse.code',
    d_60b: 'mse.code',
    d_90a: 'mse.code',
    d_90b: 'mse.code',
    d_180a: 'mse.code',
    d_180b: 'mse.code',
    d_365a: 'mse.code',
    d_365b: 'mse.code',
};

async function ensureSchema(db) {
    if (schemaReady) return;
    await db.query(`
        CREATE TABLE IF NOT EXISTS dg_purchase_overrides (
            code VARCHAR(255) NOT NULL PRIMARY KEY,
            min_stock_dg DECIMAL(15,3) NULL DEFAULT NULL,
            multiplicity DECIMAL(15,3) NULL DEFAULT NULL,
            min_stock_calc_as DECIMAL(15,3) NULL DEFAULT NULL,
            proposed_min_stock DECIMAL(15,3) NULL DEFAULT NULL,
            pack_qty_manual DECIMAL(15,3) NULL DEFAULT NULL,
            note VARCHAR(500) NULL,
            updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            INDEX idx_dg_purchase_overrides_updated (updated_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    schemaReady = true;
}

function parseFlexibleNumber(raw) {
    if (raw == null) return null;
    const s = String(raw).trim();
    if (!s) return null;
    const cleaned = s.replace(/\s/g, '').replace(',', '.');
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : null;
}

/** Безопасный парс payload_json одной строки ms_entity_details. */
function parsePayloadSafe(raw) {
    if (!raw) return null;
    try {
        const o = JSON.parse(raw);
        return o && typeof o === 'object' ? o : null;
    } catch (_) {
        return null;
    }
}

/** Кол-во штук в стандартной упаковке: ищем первый packaging с quantity > 1. */
function extractPackQty(payload) {
    if (!payload || !Array.isArray(payload.packagings)) return '';
    for (const pk of payload.packagings) {
        if (!pk) continue;
        const q = Number(pk.quantity);
        if (Number.isFinite(q) && q > 0) return q;
    }
    return '';
}

/** «В пути» из raw-карточки МС (`entity/product|bundle`), как в `routes/product.js`. */
function extractInTransit(payload) {
    if (!payload || payload.inTransit == null) return null;
    const n = Number(payload.inTransit);
    return Number.isFinite(n) ? n : null;
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

function isMsBundleType(typeRaw) {
    return String(typeRaw || '').toLowerCase().includes('комплект');
}

/** Как в `routes/product.js`: безопасный код для IN / bundle map. */
function safeMsCodeForLike(code) {
    const s = String(code || '').trim();
    if (!/^[A-Za-z0-9_.-]+$/u.test(s)) return '';
    return s;
}

/** Окна «снимка» для таблицы закупок: продажи (шт), совмещены с карточкой товара (`SALES_WINDOWS` в product). */
const PU_SNAPSHOT_SALES_DAYS = [3, 5, 7, 15, 30, 60, 90, 180, 365];

/** Сортировка по вычисляемым полям — после enrich, только в пределах текущей страницы (как `formula_proposed_min_stock`). */
const PURCHASE_POST_SORT_KEYS = new Set([
    'formula_proposed_min_stock',
    'in_transit',
    'd_3',
    'd_5',
    'd_7',
    'd_15a',
    'd_15b',
    'd_30a',
    'd_30b',
    'd_60a',
    'd_60b',
    'd_90a',
    'd_90b',
    'd_180a',
    'd_180b',
    'd_365a',
    'd_365b',
]);

function purchasePostSortNumeric(row, key) {
    const v = row[key];
    if (key === 'in_transit') {
        if (v == null || v === '') return null;
    }
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

function sortPurchaseDataByKey(data, sortKey, desc) {
    data.sort((a, b) => {
        const na = purchasePostSortNumeric(a, sortKey);
        const nb = purchasePostSortNumeric(b, sortKey);
        const va = na != null ? na : desc ? -1e18 : 1e18;
        const vb = nb != null ? nb : desc ? -1e18 : 1e18;
        if (vb === va) return String(a.code).localeCompare(String(b.code), 'ru');
        return desc ? vb - va : va - vb;
    });
}

function buildWindowSumSelectSql(qtyExpr) {
    return PU_SNAPSHOT_SALES_DAYS.map(
        (w) =>
            `COALESCE(SUM(CASE WHEN d.moment >= (NOW() - INTERVAL ${w} DAY) THEN (${qtyExpr}) ELSE 0 END), 0) AS w${w}`,
    ).join(',\n            ');
}

async function loadPurchaseDirectSalesWindowsMap(db, codes) {
    const map = new Map();
    if (!codes.length) return map;
    const ph = codes.map(() => '?').join(',');
    const sums = buildWindowSumSelectSql('CAST(p.quantity AS DECIMAL(18,6))');
    const [rows] = await db.query(
        `SELECT p.ms_export_code AS code,
            ${sums}
           FROM ms_demand_position p
           INNER JOIN ms_demand d ON d.uuid = p.demand_uuid
          WHERE d.applicable = 1
            AND p.ms_export_code IN (${ph})
          GROUP BY p.ms_export_code`,
        [...codes],
    );
    for (const r of rows || []) {
        map.set(String(r.code), r);
    }
    return map;
}

async function loadPurchaseBundleSalesWindowsMap(db, componentCodes) {
    const map = new Map();
    if (!componentCodes.length) return map;
    const ph = componentCodes.map(() => '?').join(',');
    const sums = buildWindowSumSelectSql('CAST(p.quantity * bc.qty_per_bundle AS DECIMAL(18,6))');
    const [rows] = await db.query(
        `SELECT bc.component_code AS code,
            ${sums}
           FROM ms_demand_position p
           INNER JOIN ms_demand d ON d.uuid = p.demand_uuid
           INNER JOIN dg_bundle_components bc ON bc.bundle_code = p.ms_export_code AND bc.component_code IN (${ph})
           INNER JOIN (
                SELECT bundle_uuid, SUM(qty_per_bundle) AS qty_sum
                  FROM dg_bundle_components
                 GROUP BY bundle_uuid
               ) tot ON tot.bundle_uuid = bc.bundle_uuid
          WHERE d.applicable = 1
          GROUP BY bc.component_code`,
        [...componentCodes],
    );
    for (const r of rows || []) {
        map.set(String(r.code), r);
    }
    return map;
}

async function loadPurchaseAbsenceDistinctDaysMap(db, codes, periodDays) {
    const map = new Map();
    if (!codes.length) return map;
    const ph = codes.map(() => '?').join(',');
    const p = Math.min(365 * 5, Math.max(1, Math.round(Number(periodDays) || 1)));
    const [rows] = await db.query(
        `SELECT code, COUNT(DISTINCT ts_date) AS distinct_days
           FROM dg_product_zero_stock_log
          WHERE ts_date >= (CURDATE() - INTERVAL ? DAY)
            AND code IN (${ph})
          GROUP BY code`,
        [p, ...codes],
    );
    for (const r of rows || []) {
        map.set(String(r.code), Number(r.distinct_days || 0));
    }
    return map;
}

/** Цена типа с «маркет» в названии из `salePrices` payload МС (как на карточке товара). */
function marketPriceRubFromPayload(payload) {
    if (!payload || !Array.isArray(payload.salePrices)) return null;
    const prices = [];
    for (const sp of payload.salePrices) {
        if (!sp || sp.value == null) continue;
        const cents = Number(sp.value);
        if (!Number.isFinite(cents)) continue;
        const v = Math.round(cents) / 100;
        const name = String(sp?.priceType?.name || 'Цена продажи').trim();
        prices.push({ name, value: v });
    }
    return pickMarketPriceRub(prices);
}

/**
 * Для каждой строки списка закупок считает `formula_proposed_min_stock` — тот же `computeSalesFormula`,
 * что на `GET /api/product/:code` (окна из `app_settings`, сумма продаж за W дн., лог нулей, override для prev_baseline).
 */
async function enrichPurchaseRowsWithFormula(db, appSettings, sqlRows, data) {
    if (!data.length) return;
    await ensureZeroStockSchema(db);
    await ensureBundleComponentsSchema(db);
    const formulaCfg = parseFormulaSettings(appSettings);
    const W = formulaCfg.salesWindowDays;
    const absenceWin = formulaCfg.absenceAnalysisDays;
    const econWin = formulaCfg.economyAbsenceWindowDays;

    const codes = [...new Set(data.map((d) => String(d.code || '').trim()).filter(Boolean))];
    if (!codes.length) return;
    const ph = codes.map(() => '?').join(',');

    const safeComponentCodes = [
        ...new Set(
            data
                .filter((d) => !isMsBundleType(d.type))
                .map((d) => safeMsCodeForLike(String(d.code || '').trim()))
                .filter(Boolean),
        ),
    ];
    const ph2 = safeComponentCodes.length ? safeComponentCodes.map(() => '?').join(',') : '';

    const [
        [directRows],
        bundleRowsResult,
        [absenceRows],
        [econRows],
        dirWinMap,
        bunWinMap,
        abs15Map,
        abs30Map,
        abs60Map,
        abs90Map,
        abs180Map,
        abs365Map,
    ] = await Promise.all([
        db.query(
            `SELECT p.ms_export_code AS code, COALESCE(SUM(p.quantity), 0) AS sum_qty
               FROM ms_demand_position p
               INNER JOIN ms_demand d ON d.uuid = p.demand_uuid
              WHERE d.applicable = 1
                AND d.moment >= (NOW() - INTERVAL ? DAY)
                AND p.ms_export_code IN (${ph})
              GROUP BY p.ms_export_code`,
            [W, ...codes],
        ),
        safeComponentCodes.length
            ? db.query(
                  `SELECT bc.component_code AS code, COALESCE(SUM(p.quantity * bc.qty_per_bundle), 0) AS sum_qty
                     FROM ms_demand_position p
                     INNER JOIN ms_demand d ON d.uuid = p.demand_uuid
                     INNER JOIN dg_bundle_components bc ON bc.bundle_code = p.ms_export_code
                     INNER JOIN (
                          SELECT bundle_uuid, SUM(qty_per_bundle) AS qty_sum
                            FROM dg_bundle_components
                           GROUP BY bundle_uuid
                        ) tot ON tot.bundle_uuid = bc.bundle_uuid
                    WHERE d.applicable = 1
                      AND d.moment >= (NOW() - INTERVAL ? DAY)
                      AND bc.component_code IN (${ph2})
                    GROUP BY bc.component_code`,
                  [W, ...safeComponentCodes],
              )
            : Promise.resolve([[]]),
        db.query(
            `SELECT code, COUNT(DISTINCT ts_date) AS distinct_days
               FROM dg_product_zero_stock_log
              WHERE ts_date >= (CURDATE() - INTERVAL ? DAY)
                AND code IN (${ph})
              GROUP BY code`,
            [absenceWin, ...codes],
        ),
        db.query(
            `SELECT code, COUNT(DISTINCT ts_date) AS distinct_days
               FROM dg_product_zero_stock_log
              WHERE ts_date >= (CURDATE() - INTERVAL ? DAY)
                AND code IN (${ph})
              GROUP BY code`,
            [econWin, ...codes],
        ),
        loadPurchaseDirectSalesWindowsMap(db, codes),
        loadPurchaseBundleSalesWindowsMap(db, safeComponentCodes),
        loadPurchaseAbsenceDistinctDaysMap(db, codes, 15),
        loadPurchaseAbsenceDistinctDaysMap(db, codes, 30),
        loadPurchaseAbsenceDistinctDaysMap(db, codes, 60),
        loadPurchaseAbsenceDistinctDaysMap(db, codes, 90),
        loadPurchaseAbsenceDistinctDaysMap(db, codes, 180),
        loadPurchaseAbsenceDistinctDaysMap(db, codes, 365),
    ]);

    const [bundleRows] = bundleRowsResult;
    const directMap = new Map(directRows.map((row) => [String(row.code), Number(row.sum_qty || 0)]));
    const bundleMap = new Map();
    for (const row of bundleRows || []) {
        bundleMap.set(String(row.code), Number(row.sum_qty || 0));
    }
    const absenceMap = new Map(absenceRows.map((row) => [String(row.code), Number(row.distinct_days || 0)]));
    const econMap = new Map(econRows.map((row) => [String(row.code), Number(row.distinct_days || 0)]));

    function sumWindowQty(codeStr, isBundleRow, w) {
        const k = `w${w}`;
        const dr = dirWinMap.get(codeStr);
        const br = !isBundleRow ? bunWinMap.get(codeStr) : null;
        const a = dr && dr[k] != null ? Number(dr[k]) : 0;
        const b = br && br[k] != null ? Number(br[k]) : 0;
        const s = a + b;
        return Number.isFinite(s) ? s : 0;
    }

    for (let i = 0; i < data.length; i += 1) {
        const d = data[i];
        const r = sqlRows[i];
        const code = String(d.code || '');
        const isBundle = isMsBundleType(d.type);
        let sumQty = directMap.get(code) || 0;
        if (!isBundle) sumQty += bundleMap.get(code) || 0;

        const absenceDistinct = absenceMap.get(code) || 0;
        const econDistinct = econMap.get(code) || 0;

        const payload = parsePayloadSafe(r.payload_json);
        const marketPriceRub = marketPriceRubFromPayload(payload);

        const multRaw = d.multiplicity != null ? Number(d.multiplicity) : 0;
        const multiplicity = Number.isFinite(multRaw) && multRaw >= 0 ? multRaw : 0;

        const msMinStock = d.min_stock != null && Number.isFinite(Number(d.min_stock)) ? Number(d.min_stock) : 0;
        let prevBaseline = msMinStock;
        let prevBaselineSource = 'ms_export.min_stock';
        if (d.proposed_min_stock != null && d.proposed_min_stock !== '' && Number.isFinite(Number(d.proposed_min_stock))) {
            prevBaseline = Number(d.proposed_min_stock);
            prevBaselineSource = 'override.proposed_min_stock';
        } else if (d.min_stock_dg != null && d.min_stock_dg !== '' && Number.isFinite(Number(d.min_stock_dg))) {
            prevBaseline = Number(d.min_stock_dg);
            prevBaselineSource = 'override.min_stock_dg';
        }

        const fr = computeSalesFormula({
            settings: formulaCfg,
            sumQty,
            absenceDistinctDays: absenceDistinct,
            economyAbsenceDistinctDays: econDistinct,
            marketPriceRub,
            multiplicity,
            stockQty: d.stock,
            prevBaseline,
            prevBaselineSource,
        });
        d.formula_proposed_min_stock = fr.proposed_min_stock;

        d.d_3 = sumWindowQty(code, isBundle, 3);
        d.d_5 = sumWindowQty(code, isBundle, 5);
        d.d_7 = sumWindowQty(code, isBundle, 7);
        d.d_15a = sumWindowQty(code, isBundle, 15);
        d.d_15b = abs15Map.get(code) || 0;
        d.d_30a = sumWindowQty(code, isBundle, 30);
        d.d_30b = abs30Map.get(code) || 0;
        d.d_60a = sumWindowQty(code, isBundle, 60);
        d.d_60b = abs60Map.get(code) || 0;
        d.d_90a = sumWindowQty(code, isBundle, 90);
        d.d_90b = abs90Map.get(code) || 0;
        d.d_180a = sumWindowQty(code, isBundle, 180);
        d.d_180b = abs180Map.get(code) || 0;
        d.d_365a = sumWindowQty(code, isBundle, 365);
        d.d_365b = abs365Map.get(code) || 0;
    }
}

function createPurchaseRouter(db, appSettings) {
    const router = express.Router();

    router.get('/', async (req, res) => {
        try {
            await ensureSchema(db);

            const limitRaw = parseInt(req.query.limit, 10);
            const offsetRaw = parseInt(req.query.offset, 10);
            const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(1000, limitRaw) : 100;
            const offset = Number.isFinite(offsetRaw) && offsetRaw >= 0 ? offsetRaw : 0;

            const search = String(req.query.search || '').trim();
            const supplier = String(req.query.supplier || '').trim();
            const archived = String(req.query.archived || 'active').toLowerCase();
            const stockPositionMode = String(req.query.stock_position || 'yes').toLowerCase();
            const includeBundles = String(req.query.include_bundles || '0') === '1';
            const onlyStock = String(req.query.only_stock || '0') === '1';

            const sortKey = ALLOWED_SORT[String(req.query.sort_by || 'code')] ? String(req.query.sort_by || 'code') : 'code';
            const sortDir = String(req.query.sort_dir || 'asc').toLowerCase() === 'desc' ? 'DESC' : 'ASC';

            const where = ['1=1'];
            const params = [];

            if (archived === 'active') where.push('mse.is_archived = 0');
            else if (archived === 'archive' || archived === 'archived' || archived === '1') where.push('mse.is_archived = 1');

            if (stockPositionMode === 'yes') where.push("LOWER(mse.stock_position) = 'да'");
            else if (stockPositionMode === 'no') where.push("(mse.stock_position IS NULL OR LOWER(mse.stock_position) <> 'да')");

            if (!includeBundles) where.push("(mse.type IS NULL OR LOWER(mse.type) NOT LIKE '%комплект%')");

            if (search) {
                const v = `%${search.toLowerCase()}%`;
                where.push('(LOWER(mse.code) LIKE ? OR LOWER(mse.name) LIKE ? OR LOWER(mse.supplier) LIKE ? OR LOWER(mse.supplier2) LIKE ?)');
                params.push(v, v, v, v);
            }

            if (supplier) {
                const v = `%${supplier.toLowerCase()}%`;
                where.push('(LOWER(mse.supplier) LIKE ? OR LOWER(mse.supplier2) LIKE ?)');
                params.push(v, v);
            }

            if (onlyStock) where.push('COALESCE(mse.stock, 0) > 0');

            const whereSql = where.join(' AND ');
            const buyPriceExpr = "COALESCE(CAST(REPLACE(REPLACE(REPLACE(REPLACE(mse.buy_price, '₽', ''), ' ', ''), ' ', ''), ',', '.') AS DECIMAL(15,2)), 0)";
            const articleSortExpr = "COALESCE(med.code, mse.code)";

            const orderExpr = sortKey === 'buy_price'
                ? buyPriceExpr
                : sortKey === 'article'
                    ? articleSortExpr
                    : ALLOWED_SORT[sortKey];

            const baseFromJoin = `
                FROM ms_export mse
                LEFT JOIN dg_purchase_overrides po ON po.code = mse.code
                LEFT JOIN ms_entity_details med ON med.uuid = mse.uuid
            `;

            const listSql = `
                SELECT
                    mse.code, mse.name, mse.supplier, mse.supplier2, mse.uuid, mse.type,
                    mse.is_archived, mse.stock_position, mse.no_longer_cooperation,
                    mse.buy_price, mse.min_stock, mse.stock, mse.automation_price,
                    mse.synced_at,
                    po.min_stock_dg, po.multiplicity, po.min_stock_calc_as,
                    po.proposed_min_stock, po.pack_qty_manual, po.updated_at AS override_updated_at,
                    med.payload_json
                ${baseFromJoin}
                WHERE ${whereSql}
                ORDER BY ${orderExpr} ${sortDir}, mse.id ASC
                LIMIT ? OFFSET ?
            `;
            const countSql = `SELECT COUNT(*) AS cnt ${baseFromJoin} WHERE ${whereSql}`;

            const [[rows], [countRow]] = await Promise.all([
                db.query(listSql, [...params, limit, offset]),
                db.query(countSql, params)
            ]);

            const data = rows.map((r) => {
                const payload = parsePayloadSafe(r.payload_json);
                const article = payload && typeof payload.article === 'string' ? payload.article : '';
                const packQtyAuto = extractPackQty(payload);
                const inTransit = extractInTransit(payload);
                const supplierLabel = buildSupplierLabel(r.supplier, r.supplier2);
                return {
                    code: r.code || '',
                    article,
                    name: r.name || '',
                    is_archived: Number(r.is_archived || 0),
                    type: r.type || '',
                    uuid: r.uuid || '',
                    supplier: r.supplier || '',
                    supplier2: r.supplier2 || '',
                    supplier_label: supplierLabel,
                    buy_price: r.buy_price || '',
                    min_stock: r.min_stock,
                    automation_price: r.automation_price || '',
                    proposed_min_stock: r.proposed_min_stock,
                    min_stock_dg: r.min_stock_dg,
                    multiplicity: r.multiplicity,
                    min_stock_calc_as: r.min_stock_calc_as,
                    pack_qty: r.pack_qty_manual != null ? r.pack_qty_manual : packQtyAuto,
                    pack_qty_auto: packQtyAuto,
                    pack_qty_manual: r.pack_qty_manual,
                    stock: Number(r.stock || 0),
                    in_transit: inTransit,
                    no_longer_cooperation: r.no_longer_cooperation || '',
                    stock_position: r.stock_position || '',
                    override_updated_at: r.override_updated_at || null,
                    formula_proposed_min_stock: null,
                    d_3: 0,
                    d_5: 0,
                    d_7: 0,
                    d_15a: 0,
                    d_15b: 0,
                    d_30a: 0,
                    d_30b: 0,
                    d_60a: 0,
                    d_60b: 0,
                    d_90a: 0,
                    d_90b: 0,
                    d_180a: 0,
                    d_180b: 0,
                    d_365a: 0,
                    d_365b: 0,
                };
            });

            await enrichPurchaseRowsWithFormula(db, appSettings || {}, rows, data);

            if (PURCHASE_POST_SORT_KEYS.has(sortKey)) {
                const desc = String(req.query.sort_dir || 'asc').toLowerCase() === 'desc';
                sortPurchaseDataByKey(data, sortKey, desc);
            }

            res.json({
                success: true,
                total: Number(countRow[0]?.cnt || 0),
                limit,
                offset,
                sort_by: sortKey,
                sort_dir: sortDir.toLowerCase(),
                data
            });
        } catch (err) {
            console.error('[purchase][list] error:', err);
            res.status(500).json({ success: false, error: err && err.message ? err.message : 'Внутренняя ошибка' });
        }
    });

    router.post('/override', express.json({ limit: '64kb' }), async (req, res) => {
        try {
            await ensureSchema(db);
            const code = String((req.body && req.body.code) || '').trim();
            const field = String((req.body && req.body.field) || '').trim();
            if (!code) return res.status(400).json({ success: false, error: 'Не указан code товара' });
            if (!OVERRIDE_FIELDS.has(field)) {
                return res.status(400).json({ success: false, error: `Недопустимое поле: ${field}` });
            }

            const rawValue = req.body ? req.body.value : null;
            const num = rawValue === '' || rawValue == null ? null : parseFlexibleNumber(rawValue);
            if (rawValue !== '' && rawValue != null && num == null) {
                return res.status(400).json({ success: false, error: 'Значение должно быть числом или пустым' });
            }

            const upsertSql = `
                INSERT INTO dg_purchase_overrides (code, ${field})
                VALUES (?, ?)
                ON DUPLICATE KEY UPDATE ${field} = VALUES(${field})
            `;
            await db.query(upsertSql, [code, num]);

            const [verifyRows] = await db.query(
                `SELECT code, min_stock_dg, multiplicity, min_stock_calc_as, proposed_min_stock, pack_qty_manual, updated_at
                 FROM dg_purchase_overrides WHERE code = ? LIMIT 1`,
                [code]
            );
            const stored = verifyRows && verifyRows[0] ? verifyRows[0] : null;
            res.json({ success: true, code, field, value: num, stored });
        } catch (err) {
            console.error('[purchase][override] error:', err);
            res.status(500).json({ success: false, error: err && err.message ? err.message : 'Внутренняя ошибка' });
        }
    });

    return router;
}

module.exports = createPurchaseRouter;
module.exports.createPurchaseRouter = createPurchaseRouter;
module.exports.ensureSchema = ensureSchema;
