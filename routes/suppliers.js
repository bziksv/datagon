'use strict';

/**
 * Поставщики — агрегат по `ms_export` + настройки в `dg_supplier_settings`.
 *
 * GET  /api/suppliers           — список поставщиков (пагинация, поиск, сортировка)
 * GET  /api/suppliers/analytics — сводка по привязанным сотрудникам (для дашборда на странице)
 * GET  /api/suppliers/data-freshness — свежесть ms_export / журнала нулевых остатков и продаж МС (МСК)
 * GET  /api/suppliers/assignees — id / имя пользователей для привязки сотрудника
 * GET  /api/suppliers/ms-order-log — журнал отправок заказов в МС
 * GET  /api/suppliers/ms-order-log/:logId — детали попытки (detail_json.steps)
 * POST /api/suppliers/:supplierKey/send-ms-order — заказ поставщику в МойСклад
 * PATCH /api/suppliers/:supplierKey — сохранить поля карточки поставщика
 */

const express = require('express');
const { createPurchaseOrderForSupplier } = require('../lib/datagonMoyskladPurchaseOrder');
const {
    listSupplierMsOrderLogs,
    getSupplierMsOrderLogDetail,
    ensureSupplierMsOrderLogSchema,
    sqlLastSuccessMsOrderJoin,
    loadMsOrdersByCreator,
    computeProcurementAttention,
    sqlProcurementAttentionEligible,
    sqlProcurementAttentionPredicate,
    MS_ORDER_STATS_PERIOD_DAYS,
    MS_ORDER_STALE_WARN_DAYS,
    MS_ORDER_STALE_DANGER_DAYS,
} = require('../lib/datagonSupplierMsOrderLog');
const {
    SUPPLIER_BUY_PRICE_NUM,
    SUPPLIER_NEED_QTY_SQL,
    SUPPLIER_TARGET_STOCK_SQL,
    sqlSupplierProductWhere,
} = require('../lib/datagonSuppliersSql');
const { loadPurchaseDataRevision, buildFormulaFingerprint } = require('../lib/datagonFormulaProposedCache');
const { loadSupplierAbsenceRollupMap } = require('../lib/datagonSupplierAbsenceProfile');
const { parseFormulaSettings } = require('../lib/datagonSalesFormula');
const {
    loadSupplierExportRows,
    buildSupplierForSupplierSpreadsheet,
    buildPurchaserExportSpreadsheet,
    exportFilename,
    sendExcelCsv,
} = require('../lib/datagonSupplierExport');
const { loadSuppliersDataFreshness } = require('../lib/datagonSuppliersDataFreshness');
const {
    loadSupplierSalesRankMap,
    SUPPLIER_SALES_RANK_DAYS,
    sqlSalesRevenue90Join,
} = require('../lib/datagonSupplierSalesRank');

const SUPPLIERS_LIST_CACHE_TTL_MS = 90 * 1000;
const SUPPLIERS_ANALYTICS_CACHE_TTL_MS = 90 * 1000;
const suppliersListCache = new Map();
const suppliersAnalyticsCache = new Map();

const SORT_KEYS = new Set([
    'supplier_name',
    'products_total',
    'products_to_purchase',
    'products_zero_stock_to_buy',
    'products_zero_stock_to_buy_pct',
    'purchase_pieces_total',
    'total_purchase_sum',
    'min_purchase_sum',
    'replenishment_days',
    'warehouse_fill_pct',
    'stock_fill_pct',
    'assigned_user_name',
    'last_ms_order_at',
    'sales_rank',
]);

let schemaReady = false;

async function ensureSuppliersSchema(db) {
    if (schemaReady) return;
    await db.query(`
        CREATE TABLE IF NOT EXISTS dg_supplier_settings (
            supplier_key VARCHAR(255) NOT NULL PRIMARY KEY,
            assigned_user_id INT NULL DEFAULT NULL,
            comment TEXT NULL,
            min_purchase_sum DECIMAL(18,2) NULL DEFAULT NULL,
            warehouse_fill_pct DECIMAL(8,2) NULL DEFAULT NULL,
            stock_fill_pct DECIMAL(8,2) NULL DEFAULT NULL,
            stock_fill_pct_recorded_at TIMESTAMP NULL DEFAULT NULL,
            auto_mailing_enabled TINYINT(1) NOT NULL DEFAULT 0,
            mailing_text TEXT NULL,
            replenishment_days INT NULL DEFAULT NULL,
            updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            INDEX idx_dg_supplier_assigned (assigned_user_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    try {
        await db.query(
            `ALTER TABLE dg_supplier_settings ADD COLUMN replenishment_days INT NULL DEFAULT NULL`,
        );
    } catch (e) {
        const msg = String((e && e.message) || e);
        if (!/Duplicate column name/i.test(msg)) throw e;
    }
    await db.query(`
        CREATE TABLE IF NOT EXISTS dg_supplier_fill_history (
            id BIGINT AUTO_INCREMENT PRIMARY KEY,
            supplier_key VARCHAR(255) NOT NULL,
            stock_fill_pct DECIMAL(8,2) NULL,
            products_total INT NULL,
            products_to_purchase INT NULL,
            purchase_pieces_total DECIMAL(18,3) NULL,
            total_purchase_sum DECIMAL(18,2) NULL,
            recorded_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            INDEX idx_supplier_fill_hist_key_date (supplier_key, recorded_at)
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

function normalizeSupplierKey(raw) {
    return String(raw || '').trim().slice(0, 255);
}

function buildListCacheKey(req) {
    const q = req.query || {};
    return JSON.stringify({
        v: 10,
        search: String(q.search || '').trim().toLowerCase(),
        assigned_user: normalizeAssignedUserFilter(q.assigned_user),
        attention_only: String(q.attention_only || q.procurement_attention || '') === '1' ? '1' : '0',
        limit: String(q.limit || '100'),
        offset: String(q.offset || '0'),
        sort_by: String(q.sort_by || 'supplier_name'),
        sort_dir: String(q.sort_dir || 'asc'),
    });
}

/** @returns {string|null} `none` | user id | null (все) */
function normalizeAssignedUserFilter(raw) {
    const s = String(raw ?? '').trim();
    if (!s || s === 'all') return null;
    if (s === 'none' || s === '0' || s === '__unassigned__') return 'none';
    const id = parseInt(s, 10);
    if (Number.isFinite(id) && id > 0) return String(id);
    return null;
}

function invalidateSuppliersListCache() {
    suppliersListCache.clear();
    suppliersAnalyticsCache.clear();
}

function buildSupplierOuterWhere(search, assignedUserRaw) {
    const outerWhere = ['1=1'];
    const params = [];
    const normalized = String(search || '').trim().toLowerCase();
    if (normalized) {
        outerWhere.push('LOWER(agg.supplier_name) LIKE ?');
        params.push(`%${normalized}%`);
    }
    const assignedUser = normalizeAssignedUserFilter(assignedUserRaw);
    if (assignedUser === 'none') {
        outerWhere.push('ss.assigned_user_id IS NULL');
    } else if (assignedUser) {
        outerWhere.push('ss.assigned_user_id = ?');
        params.push(Number(assignedUser));
    }
    return {
        whereSql: outerWhere.join(' AND '),
        params,
        search: normalized || null,
        assigned_user: assignedUser,
    };
}

function buildAnalyticsCacheKey(search, assignedUserRaw) {
    return JSON.stringify({
        v: 10,
        search: String(search || '').trim().toLowerCase(),
        assigned_user: normalizeAssignedUserFilter(assignedUserRaw),
    });
}

function parseAttentionOnlyFilter(raw) {
    return String(raw || '').trim() === '1';
}

function trimSuppliersAnalyticsCache() {
    if (suppliersAnalyticsCache.size <= 40) return;
    const cut = Date.now() - SUPPLIERS_ANALYTICS_CACHE_TTL_MS * 2;
    for (const [k, v] of suppliersAnalyticsCache.entries()) {
        if (!v || v.ts < cut) suppliersAnalyticsCache.delete(k);
    }
}

function mapAnalyticsAssigneeRow(r) {
    const assigneeId = r.assignee_id != null ? Number(r.assignee_id) : 0;
    const label = String(r.assignee_label || '').trim() || '(не назначен)';
    return {
        assignee_id: assigneeId,
        assignee_label: label,
        suppliers_count: Number(r.suppliers_count || 0),
        products_total: Number(r.products_total || 0),
        products_to_purchase: Number(r.products_to_purchase || 0),
        purchase_pieces_total: Number(r.purchase_pieces_total || 0),
        stock_total: Number(r.stock_total || 0),
        total_purchase_sum: Number(r.total_purchase_sum || 0),
        avg_fill_pct: r.avg_fill_pct != null && r.avg_fill_pct !== '' ? Number(r.avg_fill_pct) : null,
    };
}

const SUPPLIERS_ANALYTICS_CHART_TOP = 30;

function mapAnalyticsSupplierRow(r) {
    const key = String(r.supplier_key || '').trim();
    const label = String(r.supplier_label || r.supplier_name || '').trim() || key || '—';
    return {
        supplier_key: key,
        supplier_label: label,
        suppliers_count: 1,
        products_total: Number(r.products_total || 0),
        products_to_purchase: Number(r.products_to_purchase || 0),
        purchase_pieces_total: Number(r.purchase_pieces_total || 0),
        stock_total: Number(r.stock_total || 0),
        total_purchase_sum: Number(r.total_purchase_sum || 0),
        avg_fill_pct: r.avg_fill_pct != null && r.avg_fill_pct !== '' ? Number(r.avg_fill_pct) : null,
    };
}

function trimSuppliersListCache() {
    if (suppliersListCache.size <= 80) return;
    const cut = Date.now() - SUPPLIERS_LIST_CACHE_TTL_MS * 2;
    for (const [k, v] of suppliersListCache.entries()) {
        if (!v || v.ts < cut) suppliersListCache.delete(k);
    }
}

function buildSupplierAggregatesSubquery(formulaFp, dataRev) {
    const productWhere = sqlSupplierProductWhere('mse');
    const fp = String(formulaFp || '');
    const rev = String(dataRev || '');
    const fcJoin =
        fp && rev
            ? `LEFT JOIN dg_formula_proposed_cache fc
          ON fc.code = mse.code AND fc.data_rev = '${rev.replace(/'/g, "''")}'
          AND fc.formula_fp LIKE CONCAT('${fp.replace(/'/g, "''")}', '|rd:%')`
            : `LEFT JOIN dg_formula_proposed_cache fc ON fc.code = mse.code`;
    return `
        SELECT
            TRIM(mse.supplier) AS supplier_key,
            TRIM(mse.supplier) AS supplier_name,
            COUNT(*) AS products_total,
            SUM(CASE WHEN (${SUPPLIER_NEED_QTY_SQL}) > 0 THEN 1 ELSE 0 END) AS products_to_purchase,
            SUM(
                CASE
                    WHEN (${SUPPLIER_NEED_QTY_SQL}) > 0 AND COALESCE(mse.stock, 0) <= 0
                    THEN 1
                    ELSE 0
                END
            ) AS products_zero_stock_to_buy,
            SUM(CASE WHEN (${SUPPLIER_NEED_QTY_SQL}) > 0 THEN (${SUPPLIER_NEED_QTY_SQL}) ELSE 0 END) AS purchase_pieces_total,
            SUM(
                CASE WHEN (${SUPPLIER_NEED_QTY_SQL}) > 0
                    THEN (${SUPPLIER_NEED_QTY_SQL}) * (${SUPPLIER_BUY_PRICE_NUM})
                    ELSE 0
                END
            ) AS total_purchase_sum,
            SUM((${SUPPLIER_TARGET_STOCK_SQL})) AS min_stock_total,
            SUM(COALESCE(mse.stock, 0)) AS stock_total,
            SUM(CASE WHEN (${SUPPLIER_TARGET_STOCK_SQL}) > 0 THEN 1 ELSE 0 END) AS min_stock_positions_count
        FROM ms_export mse
        LEFT JOIN dg_purchase_overrides po ON po.code = mse.code
        LEFT JOIN ms_entity_details med ON med.uuid = mse.uuid
        ${fcJoin}
        WHERE ${productWhere}
        GROUP BY TRIM(mse.supplier)
        HAVING COUNT(*) >= 1
    `;
}

function stockFillPctFromTotals(minStockTotal, stockTotal) {
    const minT = Number(minStockTotal || 0);
    const st = Number(stockTotal || 0);
    if (!Number.isFinite(minT) || minT <= 0) return null;
    return Math.round((100 * st) / minT * 100) / 100;
}

function buildOrderBy(sortBy, sortDesc) {
    const desc = sortDesc ? 'DESC' : 'ASC';
    const tie = ', agg.supplier_key ASC';
    const num = (expr) => `(${expr}) IS NULL ASC, (${expr}) ${desc}${tie}`;
    const str = (expr) => `${expr} ${desc}${tie}`;
    switch (sortBy) {
        case 'products_total':
            return num('agg.products_total');
        case 'products_to_purchase':
            return num('agg.products_to_purchase');
        case 'products_zero_stock_to_buy':
            return num('agg.products_zero_stock_to_buy');
        case 'products_zero_stock_to_buy_pct':
            return num(
                `CASE WHEN agg.products_to_purchase > 0 THEN (100 * agg.products_zero_stock_to_buy / agg.products_to_purchase) ELSE NULL END`,
            );
        case 'purchase_pieces_total':
            return num('agg.purchase_pieces_total');
        case 'total_purchase_sum':
            return num('agg.total_purchase_sum');
        case 'min_purchase_sum':
            return num('ss.min_purchase_sum');
        case 'replenishment_days':
            return num('ss.replenishment_days');
        case 'warehouse_fill_pct':
            return num('ss.warehouse_fill_pct');
        case 'stock_fill_pct':
            return num('COALESCE(ss.stock_fill_pct, agg.stock_fill_pct_computed)');
        case 'assigned_user_name':
            return str('COALESCE(u.full_name, u.username, \'\')');
        case 'last_ms_order_at':
            return num('ms_last.last_ms_order_at');
        case 'sales_rank': {
            // Место 1 = макс. выручка: asc по рангу → desc по выручке.
            const revDesc = !sortDesc;
            return `COALESCE(sales90.sales_revenue, 0) ${revDesc ? 'DESC' : 'ASC'}${tie}`;
        }
        case 'supplier_name':
        default:
            return str('agg.supplier_name');
    }
}

async function recordStockFillHistory(db, row) {
    const key = normalizeSupplierKey(row.supplier_key);
    if (!key) return;
    const pct = row.stock_fill_pct != null ? Number(row.stock_fill_pct) : null;
    if (pct == null || !Number.isFinite(pct)) return;
    await db.query(
        `INSERT INTO dg_supplier_fill_history
            (supplier_key, stock_fill_pct, products_total, products_to_purchase, purchase_pieces_total, total_purchase_sum)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
            key,
            pct,
            row.products_total != null ? Math.round(Number(row.products_total)) : null,
            row.products_to_purchase != null ? Math.round(Number(row.products_to_purchase)) : null,
            row.purchase_pieces_total != null ? Number(row.purchase_pieces_total) : null,
            row.total_purchase_sum != null ? Number(row.total_purchase_sum) : null,
        ],
    );
}

function parseAggNum(v) {
    if (v == null || v === '') return 0;
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
}

function refreshSupplierRowDerivedFields(row) {
    if (!row || typeof row !== 'object') return row;
    row.procurement_attention = computeProcurementAttention({
        products_to_purchase: Number(row.products_to_purchase || 0),
        total_purchase_sum: Number(row.total_purchase_sum || 0),
        min_purchase_sum: row.min_purchase_sum != null ? Number(row.min_purchase_sum) : null,
        last_ms_order_at: row.last_ms_order_at || null,
    });
    return row;
}

function applySalesRankToSupplierRow(row, salesRankCtx) {
    if (!row || typeof row !== 'object') return row;
    const key = String(row.supplier_key || row.supplier_name || '').trim();
    const rk = salesRankCtx && salesRankCtx.map ? salesRankCtx.map.get(key) : null;
    if (rk) {
        row.sales_rank = rk.rank;
        row.sales_rank_total = rk.total;
        row.sales_revenue_90d = rk.sales_revenue;
    } else {
        row.sales_rank = null;
        row.sales_rank_total = salesRankCtx && salesRankCtx.total != null ? salesRankCtx.total : null;
        row.sales_revenue_90d = null;
    }
    return row;
}

async function loadSupplierSalesRankContextSafe(db) {
    try {
        return await loadSupplierSalesRankMap(db, { days: SUPPLIER_SALES_RANK_DAYS });
    } catch (e) {
        console.error('[suppliers] sales rank map', e);
        return {
            map: new Map(),
            days: SUPPLIER_SALES_RANK_DAYS,
            total: 0,
            error: e.message || String(e),
        };
    }
}

function mapSupplierRow(r, salesRankCtx) {
    const minStockTotal = parseAggNum(r.min_stock_total);
    const stockTotal = parseAggNum(r.stock_total);
    let fillPct = stockFillPctFromTotals(minStockTotal, stockTotal);
    if (fillPct == null && r.stock_fill_pct_computed != null && r.stock_fill_pct_computed !== '') {
        const c = Number(r.stock_fill_pct_computed);
        if (Number.isFinite(c)) fillPct = c;
    }
    const gapPct =
        fillPct != null && Number.isFinite(fillPct) ? Math.round((fillPct - 100) * 100) / 100 : null;
    const stored =
        r.settings_stock_fill_pct != null && r.settings_stock_fill_pct !== ''
            ? Number(r.settings_stock_fill_pct)
            : null;
    const row = {
        supplier_key: r.supplier_key,
        supplier_name: r.supplier_name || r.supplier_key,
        assigned_user_id: r.assigned_user_id != null ? Number(r.assigned_user_id) : null,
        assigned_user_name: r.assigned_user_name || '',
        assigned_user_is_archived: Number(r.assigned_user_is_archived || 0) === 1 ? 1 : 0,
        comment: r.comment || '',
        min_purchase_sum: r.min_purchase_sum != null ? Number(r.min_purchase_sum) : null,
        warehouse_fill_pct: r.warehouse_fill_pct != null ? Number(r.warehouse_fill_pct) : null,
        replenishment_days: (() => {
            if (r.replenishment_days == null || r.replenishment_days === '') return null;
            const d = Math.round(Number(r.replenishment_days));
            return Number.isFinite(d) ? Math.max(0, Math.min(3650, d)) : null;
        })(),
        recommended_replenishment_days: (() => {
            if (r.recommended_replenishment_days == null || r.recommended_replenishment_days === '') {
                return null;
            }
            const d = Math.round(Number(r.recommended_replenishment_days));
            return Number.isFinite(d) ? Math.max(0, Math.min(3650, d)) : null;
        })(),
        absence_sku_count: Number(r.absence_sku_count || 0),
        chronic_sku_count: Number(r.chronic_sku_count || 0),
        flicker_sku_count: Number(r.flicker_sku_count || 0),
        chronic_max_streak_days: Number(r.chronic_max_streak_days || 0),
        min_stock_total: minStockTotal,
        stock_total: stockTotal,
        min_stock_positions_count: Number(r.min_stock_positions_count || 0),
        stock_fill_pct: fillPct,
        stock_fill_pct_computed: fillPct,
        stock_fill_gap_pct: gapPct,
        stock_fill_pct_stored: stored != null && Number.isFinite(stored) ? stored : null,
        stock_fill_pct_recorded_at: r.stock_fill_pct_recorded_at || null,
        products_total: Number(r.products_total || 0),
        products_to_purchase: Number(r.products_to_purchase || 0),
        products_zero_stock_to_buy: Number(r.products_zero_stock_to_buy || 0),
        products_zero_stock_to_buy_pct: (() => {
            const toBuy = Number(r.products_to_purchase || 0);
            const zero = Number(r.products_zero_stock_to_buy || 0);
            if (!Number.isFinite(toBuy) || toBuy <= 0) return null;
            return Math.round((100 * zero) / toBuy * 100) / 100;
        })(),
        purchase_pieces_total: Number(r.purchase_pieces_total || 0),
        total_purchase_sum: Number(r.total_purchase_sum || 0),
        auto_mailing_enabled: Number(r.auto_mailing_enabled || 0) === 1,
        mailing_text: r.mailing_text || '',
        settings_updated_at: r.settings_updated_at || null,
        last_ms_order_at: r.last_ms_order_at || null,
        last_ms_order_name: r.last_ms_order_name ? String(r.last_ms_order_name) : '',
        last_ms_order_by: r.last_ms_order_by ? String(r.last_ms_order_by) : '',
        last_ms_order_positions:
            r.last_ms_order_positions != null ? Number(r.last_ms_order_positions) : null,
        procurement_attention: computeProcurementAttention({
            products_to_purchase: Number(r.products_to_purchase || 0),
            total_purchase_sum: Number(r.total_purchase_sum || 0),
            min_purchase_sum: r.min_purchase_sum != null ? Number(r.min_purchase_sum) : null,
            last_ms_order_at: r.last_ms_order_at || null,
        }),
    };
    return applySalesRankToSupplierRow(row, salesRankCtx);
}

module.exports = function suppliersRouterFactory(db, appSettings = {}) {
    const router = express.Router();

    router.get('/data-freshness', async (_req, res) => {
        try {
            const payload = await loadSuppliersDataFreshness(db);
            res.json(payload);
        } catch (e) {
            console.error('[suppliers] data-freshness', e);
            res.status(500).json({ success: false, error: e.message || 'Ошибка свежести данных' });
        }
    });

    router.get('/assignees', async (req, res) => {
        try {
            await ensureSuppliersSchema(db);
            const scope = String(req.query.scope || 'all').trim().toLowerCase();
            let rows;
            if (scope === 'assigned' || scope === 'in_use') {
                const dataRev = await loadPurchaseDataRevision(db);
                const formulaFp = buildFormulaFingerprint(appSettings);
                const aggSql = buildSupplierAggregatesSubquery(formulaFp, dataRev);
                [rows] = await db.query(
                    `SELECT DISTINCT u.id, u.username, u.full_name, COALESCE(u.is_archived, 0) AS is_archived
                       FROM (${aggSql}) agg
                      INNER JOIN dg_supplier_settings ss ON ss.supplier_key = agg.supplier_key
                      INNER JOIN users u ON u.id = ss.assigned_user_id
                      WHERE ss.assigned_user_id IS NOT NULL
                      ORDER BY COALESCE(u.is_archived, 0) ASC,
                               COALESCE(NULLIF(TRIM(u.full_name), ''), u.username) ASC`,
                );
            } else {
                [rows] = await db.query(
                    `SELECT id, username, full_name, COALESCE(is_archived, 0) AS is_archived
                       FROM users
                      WHERE COALESCE(is_archived, 0) = 0
                      ORDER BY COALESCE(NULLIF(TRIM(full_name), ''), username) ASC`,
                );
            }
            res.json({
                data: (rows || []).map((u) => {
                    const base =
                        String(u.full_name || u.username || '').trim() || String(u.username || '');
                    const archived = Number(u.is_archived) === 1;
                    return {
                        id: u.id,
                        username: u.username,
                        full_name: u.full_name || '',
                        is_archived: archived ? 1 : 0,
                        label: archived ? `${base} (архивный)` : base,
                    };
                }),
            });
        } catch (e) {
            console.error('[suppliers] assignees', e);
            res.status(500).json({ error: e.message || 'Ошибка загрузки пользователей' });
        }
    });

    router.get('/', async (req, res) => {
        try {
            await ensureSuppliersSchema(db);
            const cacheKey = buildListCacheKey(req);
            const cached = suppliersListCache.get(cacheKey);
            if (cached && Date.now() - cached.ts < SUPPLIERS_LIST_CACHE_TTL_MS) {
                const salesRankCtx = await loadSupplierSalesRankContextSafe(db);
                const data = (cached.payload.data || []).map((row) =>
                    applySalesRankToSupplierRow(
                        refreshSupplierRowDerivedFields({ ...row }),
                        salesRankCtx,
                    ),
                );
                return res.json({
                    ...cached.payload,
                    data,
                    sales_rank_period_days: salesRankCtx.days,
                    sales_rank_total: salesRankCtx.total,
                    sales_rank_error: salesRankCtx.error || null,
                    cache: { hit: true, age_ms: Date.now() - cached.ts, rank_fresh: true },
                });
            }

            await ensureSupplierMsOrderLogSchema(db);
            const search = String(req.query.search || '').trim();
            const assignedUserRaw = req.query.assigned_user;
            const attentionOnly = parseAttentionOnlyFilter(
                req.query.attention_only || req.query.procurement_attention,
            );
            let limit = parseInt(req.query.limit, 10);
            if (!Number.isFinite(limit) || limit < 1) limit = 100;
            if (limit > 500) limit = 500;
            let offset = parseInt(req.query.offset, 10);
            if (!Number.isFinite(offset) || offset < 0) offset = 0;

            let sortBy = String(req.query.sort_by || 'supplier_name').trim();
            if (!SORT_KEYS.has(sortBy)) sortBy = 'supplier_name';
            const sortDesc = String(req.query.sort_dir || 'asc').toLowerCase() === 'desc';

            const dataRev = await loadPurchaseDataRevision(db);
            const formulaFp = buildFormulaFingerprint(appSettings);
            const aggSql = buildSupplierAggregatesSubquery(formulaFp, dataRev);
            const {
                whereSql,
                params,
                search: searchApplied,
                assigned_user: assignedUserApplied,
            } = buildSupplierOuterWhere(search, assignedUserRaw);
            const orderSql = buildOrderBy(sortBy, sortDesc);
            const msJoin = sqlLastSuccessMsOrderJoin('agg');
            const attentionSql = attentionOnly ? ` AND ${sqlProcurementAttentionPredicate()}` : '';
            const sales90 =
                sortBy === 'sales_rank'
                    ? sqlSalesRevenue90Join('agg', SUPPLIER_SALES_RANK_DAYS)
                    : { joinSql: '', params: [] };

            const countSql = `
                SELECT COUNT(*) AS total
                  FROM (${aggSql}) agg
                  ${msJoin}
                  LEFT JOIN dg_supplier_settings ss ON ss.supplier_key = agg.supplier_key
                 WHERE ${whereSql}${attentionSql}`;
            const listSql = `
                SELECT
                    agg.supplier_key,
                    agg.supplier_name,
                    agg.products_total,
                    agg.products_to_purchase,
                    agg.products_zero_stock_to_buy,
                    agg.purchase_pieces_total,
                    agg.total_purchase_sum,
                    agg.min_stock_total,
                    agg.stock_total,
                    agg.min_stock_positions_count,
                    ROUND(
                        CASE WHEN agg.min_stock_total > 0
                            THEN 100 * agg.stock_total / agg.min_stock_total
                            ELSE NULL
                        END,
                        2
                    ) AS stock_fill_pct_computed,
                    ss.assigned_user_id,
                    ss.comment,
                    ss.min_purchase_sum,
                    ss.warehouse_fill_pct,
                    ss.replenishment_days,
                    ss.stock_fill_pct AS settings_stock_fill_pct,
                    ss.stock_fill_pct_recorded_at,
                    ss.auto_mailing_enabled,
                    ss.mailing_text,
                    ss.updated_at AS settings_updated_at,
                    COALESCE(NULLIF(TRIM(u.full_name), ''), u.username, '') AS assigned_user_name_base,
                    COALESCE(u.is_archived, 0) AS assigned_user_is_archived,
                    CONCAT(
                        COALESCE(NULLIF(TRIM(u.full_name), ''), u.username, ''),
                        CASE WHEN COALESCE(u.is_archived, 0) = 1 THEN ' (архивный)' ELSE '' END
                    ) AS assigned_user_name,
                    ms_last.last_ms_order_at,
                    ms_last.last_ms_order_name,
                    ms_last.last_ms_order_by,
                    ms_last.last_ms_order_positions
                  FROM (${aggSql}) agg
                  ${msJoin}
                  LEFT JOIN dg_supplier_settings ss ON ss.supplier_key = agg.supplier_key
                  LEFT JOIN users u ON u.id = ss.assigned_user_id
                  ${sales90.joinSql}
                 WHERE ${whereSql}${attentionSql}
                 ORDER BY ${orderSql}
                 LIMIT ? OFFSET ?`;

            const salesRankCtx = await loadSupplierSalesRankContextSafe(db);

            const [[countRows], [listRows]] = await Promise.all([
                db.query(countSql, params),
                db.query(listSql, [...params, ...sales90.params, limit, offset]),
            ]);
            const total = Number(countRows[0]?.total || 0);
            let data = (listRows || []).map((r) => mapSupplierRow(r, salesRankCtx));
            try {
                const absPack = await loadSupplierAbsenceRollupMap(db, 90, null, appSettings);
                const absMap = absPack.map || {};
                data = data.map((row) => {
                    const abs = absMap[row.supplier_key];
                    if (!abs) return row;
                    row.recommended_replenishment_days = abs.recommended_replenishment_days;
                    row.absence_sku_count = abs.absence_sku_count || 0;
                    row.chronic_sku_count = abs.chronic_sku_count || 0;
                    row.flicker_sku_count = abs.flicker_sku_count || 0;
                    row.chronic_max_streak_days = abs.chronic_max_streak_days || 0;
                    return row;
                });
            } catch (absErr) {
                console.warn('[suppliers] absence recommend:', (absErr && absErr.message) || absErr);
            }

            let globalReplenishmentDays = 30;
            try {
                globalReplenishmentDays = parseFormulaSettings(appSettings).replenishmentDays;
            } catch (_e) {
                /* keep 30 */
            }

            const payload = {
                success: true,
                data,
                total,
                limit,
                offset,
                sort_by: sortBy,
                sort_dir: sortDesc ? 'desc' : 'asc',
                global_replenishment_days: globalReplenishmentDays,
                applied_filters: {
                    search: searchApplied,
                    assigned_user: assignedUserApplied,
                    attention_only: attentionOnly,
                },
                procurement_attention_thresholds: {
                    warn_days: MS_ORDER_STALE_WARN_DAYS,
                    danger_days: MS_ORDER_STALE_DANGER_DAYS,
                },
                sales_rank_period_days: salesRankCtx.days,
                sales_rank_total: salesRankCtx.total,
                sales_rank_error: salesRankCtx.error || null,
                cache: { hit: false },
            };
            suppliersListCache.set(cacheKey, { ts: Date.now(), payload });
            trimSuppliersListCache();
            res.json(payload);
        } catch (e) {
            console.error('[suppliers] list', e);
            res.status(500).json({ error: e.message || 'Ошибка загрузки поставщиков' });
        }
    });

    router.get('/analytics', async (req, res) => {
        try {
            await ensureSuppliersSchema(db);
            await ensureSupplierMsOrderLogSchema(db);
            const search = String(req.query.search || '').trim();
            const assignedUserRaw = req.query.assigned_user;
            const cacheKey = buildAnalyticsCacheKey(search, assignedUserRaw);
            const cached = suppliersAnalyticsCache.get(cacheKey);
            if (cached && Date.now() - cached.ts < SUPPLIERS_ANALYTICS_CACHE_TTL_MS) {
                return res.json({ ...cached.payload, cache: { hit: true, age_ms: Date.now() - cached.ts } });
            }

            const dataRev = await loadPurchaseDataRevision(db);
            const formulaFp = buildFormulaFingerprint(appSettings);
            const aggSql = buildSupplierAggregatesSubquery(formulaFp, dataRev);
            const {
                whereSql,
                params,
                search: searchApplied,
                assigned_user: assignedUserApplied,
            } = buildSupplierOuterWhere(search, assignedUserRaw);

            const byAssigneeSql = `
                SELECT
                    COALESCE(ss.assigned_user_id, 0) AS assignee_id,
                    CASE
                        WHEN ss.assigned_user_id IS NULL THEN '(не назначен)'
                        ELSE CONCAT(
                            COALESCE(NULLIF(TRIM(u.full_name), ''), u.username, CONCAT('ID ', ss.assigned_user_id)),
                            CASE WHEN COALESCE(u.is_archived, 0) = 1 THEN ' (архивный)' ELSE '' END
                        )
                    END AS assignee_label,
                    COUNT(*) AS suppliers_count,
                    SUM(agg.products_total) AS products_total,
                    SUM(agg.products_to_purchase) AS products_to_purchase,
                    SUM(agg.purchase_pieces_total) AS purchase_pieces_total,
                    SUM(agg.stock_total) AS stock_total,
                    SUM(agg.total_purchase_sum) AS total_purchase_sum,
                    ROUND(
                        CASE WHEN SUM(agg.min_stock_total) > 0
                            THEN 100 * SUM(agg.stock_total) / SUM(agg.min_stock_total)
                            ELSE NULL
                        END,
                        2
                    ) AS avg_fill_pct
                  FROM (${aggSql}) agg
                  LEFT JOIN dg_supplier_settings ss ON ss.supplier_key = agg.supplier_key
                  LEFT JOIN users u ON u.id = ss.assigned_user_id
                 WHERE ${whereSql}
                 GROUP BY COALESCE(ss.assigned_user_id, 0)
                 ORDER BY total_purchase_sum DESC, suppliers_count DESC`;

            const totalsSql = `
                SELECT
                    COUNT(*) AS suppliers_count,
                    SUM(agg.products_total) AS products_total,
                    SUM(agg.products_to_purchase) AS products_to_purchase,
                    SUM(agg.purchase_pieces_total) AS purchase_pieces_total,
                    SUM(agg.stock_total) AS stock_total,
                    SUM(agg.total_purchase_sum) AS total_purchase_sum,
                    SUM(CASE WHEN ss.assigned_user_id IS NULL THEN 1 ELSE 0 END) AS unassigned_suppliers,
                    ROUND(
                        CASE WHEN SUM(agg.min_stock_total) > 0
                            THEN 100 * SUM(agg.stock_total) / SUM(agg.min_stock_total)
                            ELSE NULL
                        END,
                        2
                    ) AS avg_fill_pct
                  FROM (${aggSql}) agg
                  LEFT JOIN dg_supplier_settings ss ON ss.supplier_key = agg.supplier_key
                 WHERE ${whereSql}`;

            const bySupplierSql = `
                SELECT
                    agg.supplier_key,
                    agg.supplier_name AS supplier_label,
                    agg.products_total,
                    agg.products_to_purchase,
                    agg.purchase_pieces_total,
                    agg.stock_total,
                    agg.total_purchase_sum,
                    ROUND(
                        CASE WHEN agg.min_stock_total > 0
                            THEN 100 * agg.stock_total / agg.min_stock_total
                            ELSE NULL
                        END,
                        2
                    ) AS avg_fill_pct
                  FROM (${aggSql}) agg
                  LEFT JOIN dg_supplier_settings ss ON ss.supplier_key = agg.supplier_key
                 WHERE ${whereSql}
                 ORDER BY agg.total_purchase_sum DESC, agg.supplier_name ASC
                 LIMIT ${SUPPLIERS_ANALYTICS_CHART_TOP}`;

            const msJoin = sqlLastSuccessMsOrderJoin('agg');
            const attentionEligible = sqlProcurementAttentionEligible('agg', 'ss');
            const attentionStatsSql = `
                SELECT
                    SUM(CASE WHEN ${attentionEligible} AND ms_last.last_ms_order_at IS NULL THEN 1 ELSE 0 END) AS attention_never,
                    SUM(CASE WHEN ${attentionEligible} AND ms_last.last_ms_order_at IS NOT NULL
                        AND ms_last.last_ms_order_at < DATE_SUB(NOW(), INTERVAL ${MS_ORDER_STALE_DANGER_DAYS} DAY) THEN 1 ELSE 0 END) AS attention_stale_danger,
                    SUM(CASE WHEN ${attentionEligible} AND ms_last.last_ms_order_at IS NOT NULL
                        AND ms_last.last_ms_order_at >= DATE_SUB(NOW(), INTERVAL ${MS_ORDER_STALE_DANGER_DAYS} DAY)
                        AND ms_last.last_ms_order_at < DATE_SUB(NOW(), INTERVAL ${MS_ORDER_STALE_WARN_DAYS} DAY) THEN 1 ELSE 0 END) AS attention_stale_warn
                  FROM (${aggSql}) agg
                  ${msJoin}
                  LEFT JOIN dg_supplier_settings ss ON ss.supplier_key = agg.supplier_key
                 WHERE ${whereSql}`;

            const [[assigneeRows], [supplierRows], [totalRows], [attentionRows], msOrdersByCreator] =
                await Promise.all([
                    db.query(byAssigneeSql, params),
                    db.query(bySupplierSql, params),
                    db.query(totalsSql, params),
                    db.query(attentionStatsSql, params),
                    loadMsOrdersByCreator(db, { period_days: MS_ORDER_STATS_PERIOD_DAYS }),
                ]);
            const t = totalRows && totalRows[0] ? totalRows[0] : {};
            const att = attentionRows && attentionRows[0] ? attentionRows[0] : {};
            const byAssignee = (assigneeRows || []).map(mapAnalyticsAssigneeRow);
            const bySupplier = (supplierRows || []).map(mapAnalyticsSupplierRow);
            const attentionNever = Number(att.attention_never || 0);
            const attentionStaleDanger = Number(att.attention_stale_danger || 0);
            const attentionStaleWarn = Number(att.attention_stale_warn || 0);
            const payload = {
                success: true,
                applied_filters: { search: searchApplied, assigned_user: assignedUserApplied },
                totals: {
                    suppliers_count: Number(t.suppliers_count || 0),
                    products_total: Number(t.products_total || 0),
                    products_to_purchase: Number(t.products_to_purchase || 0),
                    purchase_pieces_total: Number(t.purchase_pieces_total || 0),
                    stock_total: Number(t.stock_total || 0),
                    total_purchase_sum: Number(t.total_purchase_sum || 0),
                    unassigned_suppliers: Number(t.unassigned_suppliers || 0),
                    avg_fill_pct: t.avg_fill_pct != null && t.avg_fill_pct !== '' ? Number(t.avg_fill_pct) : null,
                    assignees_count: byAssignee.length,
                    procurement_attention_never: attentionNever,
                    procurement_attention_stale_warn: attentionStaleWarn,
                    procurement_attention_stale_danger: attentionStaleDanger,
                    procurement_attention_total:
                        attentionNever + attentionStaleWarn + attentionStaleDanger,
                },
                by_assignee: byAssignee,
                by_supplier: bySupplier,
                ms_orders: {
                    period_days: msOrdersByCreator.period_days,
                    by_creator: msOrdersByCreator.rows,
                    success_orders_total: msOrdersByCreator.rows.reduce(
                        (s, r) => s + Number(r.orders_count || 0),
                        0,
                    ),
                },
                procurement_attention_thresholds: {
                    warn_days: MS_ORDER_STALE_WARN_DAYS,
                    danger_days: MS_ORDER_STALE_DANGER_DAYS,
                },
                suppliers_chart_limit: SUPPLIERS_ANALYTICS_CHART_TOP,
                cache: { hit: false },
            };
            suppliersAnalyticsCache.set(cacheKey, { ts: Date.now(), payload });
            trimSuppliersAnalyticsCache();
            res.json(payload);
        } catch (e) {
            console.error('[suppliers] analytics', e);
            res.status(500).json({ error: e.message || 'Ошибка аналитики поставщиков' });
        }
    });

    router.get('/export/supplier', async (req, res) => {
        try {
            const supplierKey = normalizeSupplierKey(req.query.supplier_key || req.query.supplier || '');
            if (!supplierKey) return res.status(400).json({ error: 'Укажите supplier_key' });
            const rows = await loadSupplierExportRows(db, appSettings, {
                supplierKey,
                toPurchaseOnly: String(req.query.to_purchase || '1') !== '0',
            });
            const xlsx = await buildSupplierForSupplierSpreadsheet(rows);
            sendExcelCsv(res, xlsx, exportFilename(supplierKey, 'supplier'));
        } catch (e) {
            console.error('[suppliers] export/supplier', e);
            res.status(500).json({ error: e.message || 'Ошибка выгрузки' });
        }
    });

    router.get('/export/purchaser', async (req, res) => {
        try {
            const supplierKey = normalizeSupplierKey(req.query.supplier_key || req.query.supplier || '');
            if (!supplierKey) return res.status(400).json({ error: 'Укажите supplier_key' });
            const rows = await loadSupplierExportRows(db, appSettings, {
                supplierKey,
                toPurchaseOnly: String(req.query.to_purchase || '1') !== '0',
            });
            const xlsx = await buildPurchaserExportSpreadsheet(rows);
            sendExcelCsv(res, xlsx, exportFilename(supplierKey, 'purchaser'));
        } catch (e) {
            console.error('[suppliers] export/purchaser', e);
            res.status(500).json({ error: e.message || 'Ошибка выгрузки' });
        }
    });

    router.get('/ms-order-log', async (req, res) => {
        try {
            const payload = await listSupplierMsOrderLogs(db, {
                supplier_key: req.query.supplier_key || req.query.supplier || '',
                limit: req.query.limit,
                offset: req.query.offset,
            });
            res.json({ success: true, ...payload });
        } catch (e) {
            console.error('[suppliers] ms-order-log list', e);
            res.status(500).json({ success: false, error: e.message || 'Ошибка журнала заказов МС' });
        }
    });

    router.get('/ms-order-log/:logId', async (req, res) => {
        try {
            const row = await getSupplierMsOrderLogDetail(db, req.params.logId);
            if (!row) return res.status(404).json({ success: false, error: 'Запись журнала не найдена' });
            res.json({ success: true, log: row });
        } catch (e) {
            console.error('[suppliers] ms-order-log detail', e);
            res.status(500).json({ success: false, error: e.message || 'Ошибка журнала заказов МС' });
        }
    });

    router.post('/:supplierKey/send-ms-order', async (req, res) => {
        const logId = () => (e && e.log_id != null ? e.log_id : null);
        try {
            const supplierKey = normalizeSupplierKey(decodeURIComponent(req.params.supplierKey || ''));
            if (!supplierKey) {
                return res.status(400).json({ success: false, error: 'Пустой ключ поставщика', code_error: 'BAD_REQUEST' });
            }
            const result = await createPurchaseOrderForSupplier(db, appSettings, {
                supplierKey,
                actor: req.datagonActor || null,
            });
            if (result && result.success) invalidateSuppliersListCache();
            res.json(result);
        } catch (e) {
            const base = {
                success: false,
                error: e.message || 'Ошибка создания заказа в МойСклад',
                code_error: e.code || 'UNKNOWN',
                log_id: logId(e),
            };
            const code = e.code || '';
            if (code === 'NO_TOKEN') {
                return res.status(503).json({ ...base, code_error: 'NO_TOKEN' });
            }
            if (code === 'BAD_REQUEST' || code === 'NO_LINES') {
                return res.status(400).json(base);
            }
            if (code === 'NO_UUID') {
                return res.status(400).json({
                    ...base,
                    skipped_no_uuid: e.skipped_no_uuid || [],
                });
            }
            if (code === 'COUNTERPARTY_NOT_FOUND' || code === 'STORE_NOT_FOUND' || code === 'NO_ORGANIZATION') {
                return res.status(404).json({
                    ...base,
                    search_candidates: e.search_candidates || null,
                });
            }
            if (code === 'AMBIGUOUS_ORGANIZATION') {
                return res.status(409).json({
                    ...base,
                    organization_names: e.organization_names || null,
                });
            }
            const httpStatus = e.http_status && Number.isFinite(e.http_status) ? e.http_status : 502;
            res.status(httpStatus >= 400 && httpStatus < 600 ? httpStatus : 502).json({
                ...base,
                code_error: code || 'MS_API',
                http_status: e.http_status || null,
                ms_errors: e.ms_errors || null,
            });
        }
    });

    router.patch('/:supplierKey', async (req, res) => {
        try {
            await ensureSuppliersSchema(db);
            const supplierKey = normalizeSupplierKey(decodeURIComponent(req.params.supplierKey || ''));
            if (!supplierKey) return res.status(400).json({ error: 'Пустой ключ поставщика' });

            const body = req.body && typeof req.body === 'object' ? req.body : {};
            const fields = {};

            if ('assigned_user_id' in body) {
                const v = body.assigned_user_id;
                if (v === null || v === '' || v === undefined) fields.assigned_user_id = null;
                else {
                    const id = parseInt(v, 10);
                    if (!Number.isFinite(id) || id < 1) {
                        return res.status(400).json({ error: 'Некорректный сотрудник' });
                    }
                    const [u] = await db.query(
                        'SELECT id, COALESCE(is_archived, 0) AS is_archived FROM users WHERE id = ? LIMIT 1',
                        [id]
                    );
                    if (!u.length) return res.status(400).json({ error: 'Пользователь не найден' });
                    if (Number(u[0].is_archived) === 1) {
                        return res.status(400).json({
                            error: 'Нельзя назначить архивного пользователя. Сначала восстановите его в настройках.',
                        });
                    }
                    fields.assigned_user_id = id;
                }
            }
            if ('comment' in body) fields.comment = String(body.comment || '').slice(0, 65535);
            if ('min_purchase_sum' in body) {
                const n = parseFlexibleNumber(body.min_purchase_sum);
                fields.min_purchase_sum = n;
            }
            if ('warehouse_fill_pct' in body) {
                const n = parseFlexibleNumber(body.warehouse_fill_pct);
                fields.warehouse_fill_pct = n;
            }
            if ('stock_fill_pct' in body) {
                const n = parseFlexibleNumber(body.stock_fill_pct);
                fields.stock_fill_pct = n;
                fields.stock_fill_pct_recorded_at = new Date();
            }
            if ('auto_mailing_enabled' in body) {
                fields.auto_mailing_enabled = body.auto_mailing_enabled ? 1 : 0;
            }
            if ('mailing_text' in body) fields.mailing_text = String(body.mailing_text || '').slice(0, 65535);
            if ('replenishment_days' in body) {
                const actor = req.datagonActor || null;
                if (!actor || actor.username !== 'admin') {
                    return res.status(403).json({
                        error: 'Пополнение, дней у поставщика может менять только суперадмин (admin).',
                    });
                }
                if (body.replenishment_days === null || body.replenishment_days === '') {
                    fields.replenishment_days = null;
                } else {
                    const d = Math.round(Number(body.replenishment_days));
                    if (!Number.isFinite(d) || d < 0 || d > 3650) {
                        return res.status(400).json({ error: 'Пополнение, дней: целое число 0…3650 или пусто' });
                    }
                    fields.replenishment_days = d;
                }
            }

            if (!Object.keys(fields).length) {
                return res.status(400).json({ error: 'Нет полей для сохранения' });
            }

            const cols = Object.keys(fields);
            const placeholders = cols.map((c) => `${c} = ?`).join(', ');
            const vals = cols.map((c) => fields[c]);
            await db.query(
                `INSERT INTO dg_supplier_settings (supplier_key, ${cols.join(', ')})
                 VALUES (?, ${cols.map(() => '?').join(', ')})
                 ON DUPLICATE KEY UPDATE ${placeholders}`,
                [supplierKey, ...vals, ...vals],
            );
            // После записи: иначе параллельный GET успевает заново положить в кэш старую строку.
            invalidateSuppliersListCache();

            if ('stock_fill_pct' in fields) {
                const dataRev = await loadPurchaseDataRevision(db);
                const formulaFp = buildFormulaFingerprint(appSettings);
                const aggSql = buildSupplierAggregatesSubquery(formulaFp, dataRev);
                const [[snap]] = await db.query(
                    `SELECT agg.*
                       FROM (${aggSql}) agg
                      WHERE agg.supplier_key = ?
                      LIMIT 1`,
                    [supplierKey],
                );
                if (snap) {
                    await recordStockFillHistory(db, {
                        supplier_key: supplierKey,
                        stock_fill_pct: fields.stock_fill_pct,
                        products_total: snap.products_total,
                        products_to_purchase: snap.products_to_purchase,
                        purchase_pieces_total: snap.purchase_pieces_total,
                        total_purchase_sum: snap.total_purchase_sum,
                    });
                }
            }

            const [[row]] = await db.query(
                `SELECT ss.*,
                        COALESCE(u.is_archived, 0) AS assigned_user_is_archived,
                        CONCAT(
                            COALESCE(NULLIF(TRIM(u.full_name), ''), u.username, ''),
                            CASE WHEN COALESCE(u.is_archived, 0) = 1 THEN ' (архивный)' ELSE '' END
                        ) AS assigned_user_name
                   FROM dg_supplier_settings ss
                   LEFT JOIN users u ON u.id = ss.assigned_user_id
                  WHERE ss.supplier_key = ?
                  LIMIT 1`,
                [supplierKey],
            );
            res.json({ success: true, supplier_key: supplierKey, settings: row || { supplier_key: supplierKey } });
        } catch (e) {
            console.error('[suppliers] patch', e);
            res.status(500).json({ error: e.message || 'Ошибка сохранения' });
        }
    });

    return router;
};
