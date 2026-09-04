'use strict';

/**
 * Анализ поставщиков — продажи, динамика, сигналы внимания.
 *
 * GET /api/supplier-analysis/projects?days=90
 * GET /api/supplier-analysis/overview?days=90&project_mode=all|selected&project_uuids=
 * GET /api/supplier-analysis/sales-breakdown?days=90&limit=50&offset=0 — строки отгрузок (выручка / себестоимость / маржа)
 * GET /api/supplier-analysis/ranking?days=90&search=&sort=&dir=&limit=&offset=
 * GET /api/supplier-analysis/trend?supplier_key=&months=12
 * GET /api/supplier-analysis/products?supplier_key=&days=90&limit=50
 * GET /api/supplier-analysis/data-freshness
 * GET /api/supplier-analysis/export?days=90 — CSV рейтинга
 */

const express = require('express');
const {
    salesBySupplierSubquery,
    catalogBySupplierSubquery,
    salesJoinSql,
    salesMarginLineSql,
    firstPositiveStockByCodeSubquery,
    salesRankingQueryParams,
    supplierRankingSelectSql,
} = require('../lib/datagonSupplierAnalysisSql');
const {
    sqlSupplierProductWhere,
    sqlSupplierAllSkusWhere,
    supplierPriceNumSql,
} = require('../lib/datagonSuppliersSql');
const MSE_BUY_PRICE_NUM = supplierPriceNumSql('mse', 'buy_price');
const MSE_SALE_PRICE_NUM = supplierPriceNumSql('mse', 'sale_price');
/** Ожидание (в пути) — как на `/purchase.html`: denorm или payload.inTransit. */
const MSE_IN_TRANSIT_JSON = `CAST(NULLIF(JSON_UNQUOTE(JSON_EXTRACT(med.payload_json, '$.inTransit')), '') AS DECIMAL(18,6))`;
const EXPORT_BUY_PRICE_NUM = supplierPriceNumSql('e', 'buy_price');
const { loadSuppliersDataFreshness } = require('../lib/datagonSuppliersDataFreshness');
const {
    msDemandProjectFilterFromQuery,
    loadMsDemandProjectNameMap,
} = require('../lib/datagonSalesFormulaDemandFilter');
const {
    loadSupplierAbsenceRollupMap,
    loadSupplierAbsenceSkus,
} = require('../lib/datagonSupplierAbsenceProfile');

const CACHE_TTL_MS = 90 * 1000;
const responseCache = new Map();

const RANKING_SORT = new Set([
    'supplier_name',
    'sales_revenue',
    'sales_qty',
    'revenue_change_pct',
    'skus_with_sales',
    'products_total',
    'skus_total',
    'skus_warehouse',
    'skus_with_stock',
    'skus_ineffective',
    'skus_new_on_stock',
    'new_avg_days_on_stock',
    'sales_coverage_pct',
    'stock_coverage_pct',
    'value_turnover',
    'turnover_monthly',
    'stock_value_rub',
    'sales_revenue_avg_30d',
    'min_stock_sum',
    'min_stock_dg_sum',
    'formula_proposed_sum',
    'gross_margin_est',
    'margin_pct',
    'recommended_replenishment_days',
    'chronic_sku_count',
    'flicker_sku_count',
    'absence_sku_count',
    'chronic_max_streak_days',
]);

const PORTFOLIO_FOCUS = new Set(['all', 'develop', 'problem']);

async function projectFilterMeta(db, pf) {
    if (pf.mode !== 'selected') {
        return { mode: 'all', uuids: [], project_names: [], label: 'Продажи: все проекты отгрузок МС' };
    }
    if (!pf.uuids.length) {
        return {
            mode: 'selected',
            uuids: [],
            project_names: [],
            label: 'Продажи: только выбранные проекты (список пуст — продажи не учитываются)',
        };
    }
    const nameByUuid = await loadMsDemandProjectNameMap(db, pf.uuids);
    const names = pf.uuids.map((u) => nameByUuid.get(u) || u);
    const preview =
        names.length <= 4 ? names.join('; ') : `${names.slice(0, 3).join('; ')} … (+${names.length - 3})`;
    return {
        mode: 'selected',
        uuids: pf.uuids,
        project_names: names,
        label: `Продажи: только выбранные проекты (${pf.uuids.length}): ${preview}`,
    };
}

function clampInt(v, min, max, def) {
    const n = parseInt(v, 10);
    if (!Number.isFinite(n)) return def;
    return Math.min(max, Math.max(min, n));
}

function normalizeSupplierKey(raw) {
    return String(raw || '').trim().slice(0, 255);
}

function cacheGet(key) {
    const hit = responseCache.get(key);
    if (!hit || Date.now() - hit.ts > CACHE_TTL_MS) return null;
    return hit.payload;
}

function cacheSet(key, payload) {
    responseCache.set(key, { ts: Date.now(), payload });
    if (responseCache.size > 200) {
        const first = responseCache.keys().next().value;
        responseCache.delete(first);
    }
}

function num(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
}

function mapProductInTransit(r) {
    if (r == null) return null;
    if (r.denorm_in_transit != null && r.denorm_in_transit !== '') {
        const t = Number(r.denorm_in_transit);
        if (Number.isFinite(t)) return t;
    }
    if (r.in_transit_json != null && r.in_transit_json !== '') {
        const t = Number(r.in_transit_json);
        if (Number.isFinite(t)) return t;
    }
    return null;
}

function marginPct(revenue, margin) {
    const r = num(revenue);
    const m = num(margin);
    if (r <= 0) return null;
    return Math.round((m / r) * 10000) / 100;
}

function pctChange(cur, prev) {
    const c = num(cur);
    const p = num(prev);
    if (p <= 0) return c > 0 ? 100 : null;
    return Math.round(((c - p) / p) * 10000) / 100;
}

function round2(n) {
    if (!Number.isFinite(n)) return null;
    return Math.round(n * 100) / 100;
}

function computeAttention(row, ctx) {
    const newStockDays = (ctx && ctx.newStockDays) || 30;
    let score = 0;
    const signals = [];
    const revCh = row.revenue_change_pct;
    const rev = num(row.sales_revenue);
    const stockVal = num(row.stock_value_rub);
    const withStock = num(row.skus_with_stock);
    const ineffective = num(row.skus_ineffective);
    const ineffRatio = withStock > 0 ? ineffective / withStock : 0;
    const zeroRatio = row.products_total > 0 ? row.zero_sales_skus / row.products_total : 0;

    if (num(row.skus_new_on_stock) > 0) {
        signals.push({
            code: 'new_stock',
            level: 'info',
            text:
                'Новинки на остатке: ' +
                row.skus_new_on_stock +
                ' SKU (первый остаток ≤ ' +
                newStockDays +
                ' дн.) — не считаем залежалыми',
        });
    }

    if (revCh != null && revCh <= -20) {
        score += 35;
        signals.push({ code: 'decline', level: 'danger', text: 'Выручка: минус ' + Math.abs(Math.round(revCh)) + '% к прошлому периоду' });
    } else if (revCh != null && revCh <= -10) {
        score += 18;
        signals.push({ code: 'decline_soft', level: 'warning', text: 'Выручка снижается (от ' + Math.abs(Math.round(revCh)) + '%)' });
    }

    if (withStock >= 5 && ineffRatio >= 0.45) {
        score += 32;
        signals.push({
            code: 'stale_inventory',
            level: 'danger',
            text:
                'Залежалые: ' +
                ineffective +
                ' SKU — остаток есть, за период 0 продаж, не новинка (первый остаток > ' +
                newStockDays +
                ' дн. назад)',
        });
    } else if (zeroRatio >= 0.5 && row.products_total >= 8) {
        score += 18;
        signals.push({
            code: 'low_sales_coverage',
            level: 'warning',
            text: 'Мало SKU с продажами: ' + (row.sales_coverage_pct != null ? row.sales_coverage_pct + '%' : '—') + ' каталога',
        });
    }

    if (rev <= 0 && stockVal > 50000) {
        score += 25;
        signals.push({ code: 'no_sales_stock', level: 'danger', text: 'Ноль продаж при остатке от ' + Math.round(stockVal / 1000) + ' тыс. ₽' });
    } else if (row.value_turnover != null && row.value_turnover < 0.06 && stockVal > 30000) {
        score += 14;
        signals.push({
            code: 'slow_turnover',
            level: 'warning',
            text: 'Низкая оборачиваемость: ' + row.value_turnover + '× за период (выручка / остаток ₽)',
        });
    }

    if (revCh != null && revCh >= 30 && rev > 0) {
        score -= 15;
        signals.push({ code: 'growth', level: 'success', text: 'Рост выручки +' + Math.round(revCh) + '%' });
    }

    const mPct = marginPct(rev, row.gross_margin_est);
    if (rev >= 100000 && mPct != null && mPct < 12) {
        score += 20;
        signals.push({
            code: 'low_margin',
            level: 'warning',
            text: 'Оценочная маржа ' + mPct + '% — ниже 12%',
        });
    }

    let portfolioTag = 'neutral';
    if (
        row.products_total >= 15 &&
        row.skus_with_stock >= 5 &&
        row.sales_coverage_pct != null &&
        row.sales_coverage_pct < 45
    ) {
        portfolioTag = 'develop';
        signals.push({
            code: 'portfolio_develop',
            level: 'success',
            text:
                'Проработка ассортимента: в каталоге ' +
                row.products_total +
                ' SKU, с остатком ' +
                row.skus_with_stock +
                ', с продажами ' +
                row.skus_with_sales,
        });
    }
    if (ineffective >= 3 && (ineffRatio >= 0.35 || (row.value_turnover != null && row.value_turnover < 0.05 && stockVal > 20000))) {
        portfolioTag = 'problem';
    }

    return { attention_score: Math.max(0, score), signals, portfolio_tag: portfolioTag };
}

function mapRankingRow(r, ctx) {
    const days = Math.max(1, (ctx && ctx.days) || 90);
    const productsTotal = num(r.products_total);
    const skusSold = num(r.skus_with_sales);
    const skusWithStock = num(r.skus_with_stock);
    const skusNew = num(r.skus_new_on_stock);
    const skusStockNoSales = Math.max(0, skusWithStock - skusSold);
    const skusIneffective = Math.max(0, skusStockNoSales - skusNew);
    const salesRev = num(r.sales_revenue);
    const stockVal = num(r.stock_value_rub);
    const stockQty = num(r.stock_qty);
    const salesQty = num(r.sales_qty);
    const periodTurnover = stockVal > 0 ? salesRev / stockVal : null;
    const monthsInPeriod = days / 30;
    const turnoverMonthly =
        periodTurnover != null && monthsInPeriod > 0 ? round2(periodTurnover / monthsInPeriod) : null;

    const row = {
        supplier_key: String(r.supplier_key || ''),
        supplier_name: String(r.supplier_name || r.supplier_key || ''),
        products_total: productsTotal,
        skus_warehouse: productsTotal,
        skus_total: num(r.skus_total) || productsTotal,
        skus_with_stock: skusWithStock,
        skus_zero_stock: num(r.skus_zero_stock),
        skus_with_sales: skusSold,
        skus_new_on_stock: skusNew,
        new_avg_days_on_stock:
            r.new_avg_days_on_stock != null && Number.isFinite(Number(r.new_avg_days_on_stock))
                ? Math.round(Number(r.new_avg_days_on_stock))
                : null,
        skus_stock_no_sales: skusStockNoSales,
        skus_ineffective: skusIneffective,
        zero_sales_skus: Math.max(0, productsTotal - skusSold),
        sales_qty: salesQty,
        sales_revenue: salesRev,
        sales_revenue_prev: num(r.sales_revenue_prev),
        revenue_change_pct: r.revenue_change_pct != null ? num(r.revenue_change_pct) : null,
        stock_qty: stockQty,
        stock_value_rub: stockVal,
        sales_revenue_avg_30d: salesRev > 0 ? round2((salesRev * 30) / days) : null,
        min_stock_sum: num(r.min_stock_sum),
        min_stock_dg_sum: num(r.min_stock_dg_sum),
        formula_proposed_sum: num(r.formula_proposed_sum),
        gross_margin_est: num(r.gross_margin_est),
        margin_pct: marginPct(salesRev, num(r.gross_margin_est)),
        sales_coverage_pct: productsTotal > 0 ? round2((100 * skusSold) / productsTotal) : null,
        stock_coverage_pct: productsTotal > 0 ? round2((100 * skusWithStock) / productsTotal) : null,
        value_turnover: periodTurnover != null ? round2(periodTurnover) : null,
        turnover_monthly: turnoverMonthly,
    };
    const att = computeAttention(row, ctx);
    row.attention_score = att.attention_score;
    row.signals = att.signals;
    row.portfolio_tag = att.portfolio_tag;
    return row;
}

function attachAbsenceProfile(row, absenceMap) {
    const sk = row && row.supplier_key ? String(row.supplier_key) : '';
    const abs = (absenceMap && sk && absenceMap[sk]) || null;
    row.recommended_replenishment_days = abs ? abs.recommended_replenishment_days : null;
    row.absence_sku_count = abs ? abs.absence_sku_count : 0;
    row.absence_days_sum = abs ? abs.absence_days_sum : 0;
    row.absence_episode_count = abs ? abs.absence_episode_count : 0;
    row.absence_avg_episode_days = abs ? abs.absence_avg_episode_days : 0;
    row.chronic_sku_count = abs ? abs.chronic_sku_count : 0;
    row.chronic_max_streak_days = abs ? abs.chronic_max_streak_days : 0;
    row.flicker_sku_count = abs ? abs.flicker_sku_count : 0;
    row.absence_top_problem_skus = abs ? abs.top_problem_skus || [] : [];
    if (abs && abs.recommended_replenishment_days != null) {
        const signals = Array.isArray(row.signals) ? row.signals.slice() : [];
        if (abs.chronic_sku_count > 0) {
            signals.push({
                code: 'chronic_absence',
                level: 'danger',
                text:
                    'Долгие провалы: ' +
                    abs.chronic_sku_count +
                    ' SKU (макс. ' +
                    abs.chronic_max_streak_days +
                    ' дн.)',
            });
        }
        if (abs.flicker_sku_count > 0) {
            signals.push({
                code: 'flicker_absence',
                level: 'warning',
                text: 'Частые короткие: ' + abs.flicker_sku_count + ' SKU',
            });
        }
        signals.push({
            code: 'replenishment_recommend',
            level: 'info',
            text: 'Рек. пополнение: ' + abs.recommended_replenishment_days + ' дн.',
        });
        row.signals = signals;
    }
    return row;
}

function matchesPortfolioFocus(row, focus) {
    if (focus === 'develop') {
        return (
            row.products_total >= 15 &&
            row.skus_with_stock >= 5 &&
            (row.sales_coverage_pct == null || row.sales_coverage_pct < 45)
        );
    }
    if (focus === 'problem') {
        return (
            row.skus_ineffective >= 3 ||
            (row.value_turnover != null && row.value_turnover < 0.06 && row.stock_value_rub > 30000)
        );
    }
    return true;
}

module.exports = function supplierAnalysisRouterFactory(db, appSettings = {}) {
    const router = express.Router();

    /** GET /api/supplier-analysis/projects — проекты из отгрузок за период (для фильтра продаж). */
    router.get('/projects', async (req, res) => {
        try {
            const days = clampInt(req.query.days, 7, 365, 90);
            const [rows] = await db.query(
                `SELECT project_uuid AS uuid, project_name AS name, COUNT(*) AS cnt
                   FROM ms_demand
                  WHERE moment >= DATE_SUB(NOW(), INTERVAL ? DAY)
                    AND project_uuid IS NOT NULL
                    AND TRIM(project_uuid) <> ''
                  GROUP BY project_uuid, project_name
                  ORDER BY cnt DESC, name
                  LIMIT 500`,
                [days],
            );
            res.json({
                success: true,
                days,
                projects: (rows || []).map((r) => ({
                    uuid: String(r.uuid || '').toLowerCase(),
                    name: String(r.name || '').trim() || String(r.uuid || ''),
                    count: Number(r.cnt || 0),
                })),
            });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message || 'Ошибка' });
        }
    });

    router.get('/data-freshness', async (req, res) => {
        try {
            const payload = await loadSuppliersDataFreshness(db);
            res.json({ success: true, ...payload });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message || 'Ошибка' });
        }
    });

    router.get('/overview', async (req, res) => {
        try {
            const days = clampInt(req.query.days, 7, 365, 90);
            const newStockDays = clampInt(req.query.new_stock_days, 7, 180, 30);
            const pf = msDemandProjectFilterFromQuery(req.query);
            const cacheKey = `overview:${days}:${newStockDays}:${pf.fingerprint}`;
            const cached = cacheGet(cacheKey);
            if (cached) return res.json({ ...cached, cache: { hit: true } });

            const curSql = salesBySupplierSubquery(
                'd.moment >= DATE_SUB(NOW(), INTERVAL ? DAY)',
                pf.sql,
            );
            const prevSql = salesBySupplierSubquery(
                'd.moment >= DATE_SUB(NOW(), INTERVAL ? DAY) AND d.moment < DATE_SUB(NOW(), INTERVAL ? DAY)',
                pf.sql,
            );
            const catalogSql = catalogBySupplierSubquery(newStockDays);

            const sql = `
                SELECT
                    COUNT(DISTINCT c.supplier_key) AS suppliers_total,
                    SUM(COALESCE(c.products_total, 0)) AS products_total,
                    SUM(COALESCE(cur.sales_revenue, 0)) AS sales_revenue,
                    SUM(COALESCE(prev.sales_revenue, 0)) AS sales_revenue_prev,
                    SUM(COALESCE(cur.sales_qty, 0)) AS sales_qty,
                    SUM(COALESCE(cur.gross_margin_est, 0)) AS gross_margin_est,
                    SUM(COALESCE(c.stock_value_rub, 0)) AS stock_value_rub,
                    SUM(CASE WHEN COALESCE(cur.sales_revenue, 0) <= 0 THEN 1 ELSE 0 END) AS suppliers_no_sales,
                    SUM(CASE WHEN COALESCE(cur.sales_revenue, 0) > 0 AND COALESCE(prev.sales_revenue, 0) <= 0 THEN 1 ELSE 0 END) AS suppliers_new_sales,
                    SUM(CASE WHEN COALESCE(prev.sales_revenue, 0) > 0 AND COALESCE(cur.sales_revenue, 0) < COALESCE(prev.sales_revenue, 0) * 0.8 THEN 1 ELSE 0 END) AS suppliers_declining
                FROM (${catalogSql}) c
                LEFT JOIN (${curSql}) cur ON cur.supplier_key = c.supplier_key
                LEFT JOIN (${prevSql}) prev ON prev.supplier_key = c.supplier_key`;

            const [overviewRows] = await db.query(sql, salesRankingQueryParams(days, pf.params));
            const t = overviewRows && overviewRows[0] ? overviewRows[0] : {};
            const rev = num(t.sales_revenue);
            const revPrev = num(t.sales_revenue_prev);
            const project_filter = await projectFilterMeta(db, pf);

            const payload = {
                success: true,
                days,
                new_stock_days: newStockDays,
                project_filter,
                totals: {
                    suppliers_total: num(t.suppliers_total),
                    products_total: num(t.products_total),
                    sales_revenue: rev,
                    sales_revenue_prev: revPrev,
                    revenue_change_pct: pctChange(rev, revPrev),
                    sales_qty: num(t.sales_qty),
                    gross_margin_est: num(t.gross_margin_est),
                    margin_pct: marginPct(rev, num(t.gross_margin_est)),
                    stock_value_rub: num(t.stock_value_rub),
                    suppliers_no_sales: num(t.suppliers_no_sales),
                    suppliers_new_sales: num(t.suppliers_new_sales),
                    suppliers_declining: num(t.suppliers_declining),
                },
            };
            cacheSet(cacheKey, payload);
            res.json(payload);
        } catch (e) {
            console.error('[supplier-analysis] overview', e);
            res.status(500).json({ success: false, error: e.message || 'Ошибка' });
        }
    });

    /** Строки отгрузок за период — расшифровка выручки и маржи из KPI. */
    router.get('/sales-breakdown', async (req, res) => {
        try {
            const days = clampInt(req.query.days, 7, 365, 90);
            const limit = clampInt(req.query.limit, 1, 200, 50);
            const offset = clampInt(req.query.offset, 0, 500000, 0);
            const search = String(req.query.search || '').trim().toLowerCase();
            const pf = msDemandProjectFilterFromQuery(req.query);
            const marginSql = salesMarginLineSql('e');
            const cacheKey = `sales-breakdown:${days}:${limit}:${offset}:${search}:${pf.fingerprint}`;
            const cached = cacheGet(cacheKey);
            if (cached) return res.json({ ...cached, cache: { hit: true } });

            const momentSql = 'd.moment >= DATE_SUB(NOW(), INTERVAL ? DAY)';
            const searchSql = search
                ? ` AND (LOWER(TRIM(e.supplier)) LIKE ? OR LOWER(e.code) LIKE ? OR LOWER(e.name) LIKE ?) `
                : '';
            const searchParam = search ? `%${search}%` : null;
            const baseJoin = `${salesJoinSql('e', pf.sql)} AND ${momentSql}${searchSql}`;
            const baseParams = [...pf.params, days];
            if (searchParam) baseParams.push(searchParam, searchParam, searchParam);

            const [countRows] = await db.query(
                `SELECT COUNT(*) AS cnt ${baseJoin}`,
                baseParams,
            );
            const total = num(countRows && countRows[0] ? countRows[0].cnt : 0);

            const [totRows] = await db.query(
                `SELECT
                    SUM(p.sum_minor) / 100 AS sales_revenue,
                    SUM(${marginSql}) AS gross_margin_est,
                    SUM(p.quantity) AS sales_qty,
                    COUNT(DISTINCT d.uuid) AS demands_count
                 ${baseJoin}`,
                baseParams,
            );
            const tt = totRows && totRows[0] ? totRows[0] : {};
            const totRev = num(tt.sales_revenue);

            const [rows] = await db.query(
                `SELECT
                    d.uuid AS demand_uuid,
                    d.doc_name,
                    d.moment,
                    d.project_name,
                    p.ms_export_code AS code,
                    e.name,
                    TRIM(e.supplier) AS supplier,
                    p.quantity,
                    p.sum_minor / 100 AS line_revenue,
                    p.price_minor / 100 AS line_price,
                    (${EXPORT_BUY_PRICE_NUM}) AS buy_price_unit,
                    (p.quantity * (${EXPORT_BUY_PRICE_NUM})) AS line_cost,
                    (${marginSql}) AS line_margin
                 ${baseJoin}
                 ORDER BY d.moment DESC, d.doc_name ASC, p.ms_export_code ASC
                 LIMIT ? OFFSET ?`,
                [...baseParams, limit, offset],
            );

            const project_filter = await projectFilterMeta(db, pf);
            const payload = {
                success: true,
                days,
                limit,
                offset,
                total,
                project_filter,
                totals: {
                    sales_revenue: totRev,
                    gross_margin_est: num(tt.gross_margin_est),
                    margin_pct: marginPct(totRev, num(tt.gross_margin_est)),
                    sales_qty: num(tt.sales_qty),
                    demands_count: num(tt.demands_count),
                    lines_count: total,
                },
                rows: (rows || []).map((r) => {
                    const rev = num(r.line_revenue);
                    const cost = num(r.line_cost);
                    const marg = num(r.line_margin);
                    return {
                        demand_uuid: String(r.demand_uuid || ''),
                        doc_name: String(r.doc_name || ''),
                        moment: r.moment ? String(r.moment) : '',
                        project_name: String(r.project_name || ''),
                        code: String(r.code || ''),
                        name: String(r.name || ''),
                        supplier: String(r.supplier || ''),
                        quantity: num(r.quantity),
                        line_revenue: rev,
                        line_price: num(r.line_price),
                        buy_price_unit: num(r.buy_price_unit),
                        line_cost: cost,
                        line_margin: marg,
                        margin_pct: marginPct(rev, marg),
                    };
                }),
            };
            cacheSet(cacheKey, payload);
            res.json(payload);
        } catch (e) {
            console.error('[supplier-analysis] sales-breakdown', e);
            res.status(500).json({ success: false, error: e.message || 'Ошибка' });
        }
    });

    router.get('/ranking', async (req, res) => {
        try {
            const days = clampInt(req.query.days, 7, 365, 90);
            const newStockDays = clampInt(req.query.new_stock_days, 7, 180, 30);
            const limit = clampInt(req.query.limit, 1, 500, 100);
            const offset = clampInt(req.query.offset, 0, 100000, 0);
            const search = String(req.query.search || '').trim().toLowerCase();
            const focusRaw = String(req.query.focus || 'all').toLowerCase();
            const focus = PORTFOLIO_FOCUS.has(focusRaw) ? focusRaw : 'all';
            const sortBy = RANKING_SORT.has(req.query.sort_by) ? req.query.sort_by : 'sales_revenue';
            const sortDir = String(req.query.sort_dir || 'desc').toLowerCase() === 'asc' ? 'ASC' : 'DESC';
            const pf = msDemandProjectFilterFromQuery(req.query);

            const cacheKey = JSON.stringify({
                days, newStockDays, limit, offset, search, focus, sortBy, sortDir, pf: pf.fingerprint,
            });
            const cached = cacheGet(cacheKey);
            if (cached) return res.json({ ...cached, cache: { hit: true } });

            const curSql = salesBySupplierSubquery(
                'd.moment >= DATE_SUB(NOW(), INTERVAL ? DAY)',
                pf.sql,
            );
            const prevSql = salesBySupplierSubquery(
                'd.moment >= DATE_SUB(NOW(), INTERVAL ? DAY) AND d.moment < DATE_SUB(NOW(), INTERVAL ? DAY)',
                pf.sql,
            );
            const catalogSql = catalogBySupplierSubquery(newStockDays);
            const mapCtx = { days, newStockDays };

            const searchSql = search
                ? ' AND c.supplier_name COLLATE utf8mb4_unicode_ci LIKE ? '
                : '';
            const searchParam = search ? `%${search}%` : null;

            const innerSql =
                supplierRankingSelectSql(catalogSql, curSql, prevSql) + ` WHERE 1=1 ${searchSql}`;

            const [rawRows] = await db.query(
                `SELECT * FROM (${innerSql}) ranked`,
                salesRankingQueryParams(days, pf.params, searchParam),
            );
            let rows = (rawRows || []).map((r) => mapRankingRow(r, mapCtx));
            try {
                const absPack = await loadSupplierAbsenceRollupMap(db, days, pf, appSettings);
                const absMap = absPack.map || {};
                rows = rows.map((r) => attachAbsenceProfile(r, absMap));
            } catch (absErr) {
                console.warn('[supplier-analysis] absence profile:', (absErr && absErr.message) || absErr);
            }
            rows = rows.filter((r) => matchesPortfolioFocus(r, focus));

            const total = rows.length;

            const sortKey = sortBy === 'supplier_name' ? 'supplier_name' : sortBy;
            rows.sort((a, b) => {
                const av = a[sortKey];
                const bv = b[sortKey];
                if (sortKey === 'supplier_name') {
                    const cmp = String(av).localeCompare(String(bv), 'ru');
                    return sortDir === 'ASC' ? cmp : -cmp;
                }
                const an = av == null ? -Infinity : Number(av);
                const bn = bv == null ? -Infinity : Number(bv);
                return sortDir === 'ASC' ? an - bn : bn - an;
            });

            if (focus === 'develop' && sortBy === 'attention_score') {
                rows.sort((a, b) => {
                    const ac = a.sales_coverage_pct == null ? 999 : a.sales_coverage_pct;
                    const bc = b.sales_coverage_pct == null ? 999 : b.sales_coverage_pct;
                    if (ac !== bc) return ac - bc;
                    return b.products_total - a.products_total;
                });
            }
            if (focus === 'problem' && sortBy === 'attention_score') {
                rows.sort((a, b) => b.skus_ineffective - a.skus_ineffective || b.attention_score - a.attention_score);
            }

            rows = rows.slice(offset, offset + limit);

            const project_filter = await projectFilterMeta(db, pf);
            const payload = {
                success: true,
                days,
                new_stock_days: newStockDays,
                focus,
                project_filter,
                total,
                offset,
                limit,
                rows,
            };
            cacheSet(cacheKey, payload);
            res.json(payload);
        } catch (e) {
            console.error('[supplier-analysis] ranking', e);
            res.status(500).json({ success: false, error: e.message || 'Ошибка' });
        }
    });

    router.get('/trend', async (req, res) => {
        try {
            const supplierKey = normalizeSupplierKey(req.query.supplier_key || req.query.supplier);
            if (!supplierKey) return res.status(400).json({ success: false, error: 'Укажите supplier_key' });
            const months = clampInt(req.query.months, 3, 24, 12);
            const pf = msDemandProjectFilterFromQuery(req.query);

            const cacheKey = `trend:${supplierKey}:${months}:${pf.fingerprint}`;
            const cached = cacheGet(cacheKey);
            if (cached) return res.json({ ...cached, cache: { hit: true } });

            const [rows] = await db.query(
                `SELECT DATE_FORMAT(d.moment, '%Y-%m') AS ym,
                        SUM(p.quantity) AS sales_qty,
                        SUM(p.sum_minor) / 100 AS sales_revenue
                 ${salesJoinSql('e', pf.sql)}
                   AND TRIM(e.supplier) = ?
                   AND d.moment >= DATE_SUB(DATE_FORMAT(NOW(), '%Y-%m-01'), INTERVAL ? MONTH)
                 GROUP BY DATE_FORMAT(d.moment, '%Y-%m')
                 ORDER BY ym ASC`,
                [...pf.params, supplierKey, months],
            );

            const payload = {
                success: true,
                supplier_key: supplierKey,
                months,
                points: (rows || []).map((r) => ({
                    ym: String(r.ym || ''),
                    sales_qty: num(r.sales_qty),
                    sales_revenue: num(r.sales_revenue),
                })),
            };
            cacheSet(cacheKey, payload);
            res.json(payload);
        } catch (e) {
            console.error('[supplier-analysis] trend', e);
            res.status(500).json({ success: false, error: e.message || 'Ошибка' });
        }
    });

    router.get('/products', async (req, res) => {
        try {
            const supplierKey = normalizeSupplierKey(req.query.supplier_key || req.query.supplier);
            if (!supplierKey) return res.status(400).json({ success: false, error: 'Укажите supplier_key' });
            const days = clampInt(req.query.days, 7, 365, 90);
            const newStockDays = clampInt(req.query.new_stock_days, 7, 180, 30);
            const mode = String(req.query.mode || 'all').toLowerCase();
            const pf = msDemandProjectFilterFromQuery(req.query);

            if (mode === 'absence') {
                const limit = clampInt(req.query.limit, 1, 500, 200);
                const pack = await loadSupplierAbsenceSkus(db, supplierKey, days, pf, appSettings);
                let rows = pack.rows || [];
                const codes = rows.map((r) => r.code).filter(Boolean);
                if (codes.length) {
                    const ph = codes.map(() => '?').join(',');
                    const [nameRows] = await db.query(
                        `SELECT code, name FROM ms_export WHERE code IN (${ph})`,
                        codes,
                    );
                    const nameMap = new Map(
                        (nameRows || []).map((r) => [String(r.code || ''), String(r.name || '')]),
                    );
                    rows = rows.map((r) => ({
                        ...r,
                        name: nameMap.get(r.code) || '',
                    }));
                }
                const out = rows.slice(0, limit);
                return res.json({
                    success: true,
                    supplier_key: supplierKey,
                    days,
                    mode: 'absence',
                    rollup: pack.rollup,
                    meta: pack.meta,
                    total: rows.length,
                    truncated: rows.length > out.length,
                    rows: out,
                    cache: pack.cache,
                });
            }

            const catalogListMode = mode === 'warehouse' || mode === 'catalog' || mode === 'all_skus' || mode === 'total';
            const limitMax = catalogListMode ? 500 : 200;
            const limitDefault = catalogListMode ? 300 : 50;
            const limit = clampInt(req.query.limit, 1, limitMax, limitDefault);
            const snapSql = firstPositiveStockByCodeSubquery(Math.max(newStockDays + 30, 120));
            const productWhereSql =
                mode === 'all_skus' || mode === 'total'
                    ? sqlSupplierAllSkusWhere('mse')
                    : sqlSupplierProductWhere('mse');

            const marginLine = salesMarginLineSql('e');
            const salesSub = `
                SELECT p.ms_export_code AS code,
                       SUM(p.quantity) AS sales_qty,
                       SUM(p.sum_minor) / 100 AS sales_revenue,
                       SUM(${marginLine}) AS gross_margin_est
                ${salesJoinSql('e', pf.sql)}
                  AND TRIM(e.supplier) = ?
                  AND d.moment >= DATE_SUB(NOW(), INTERVAL ? DAY)
                GROUP BY p.ms_export_code`;

            const grace = Math.max(7, Math.min(180, newStockDays));
            let having = '';
            if (mode === 'leaders') having = ' HAVING sales_revenue > 0 ';
            if (mode === 'laggards' || mode === 'stale') having = ' HAVING COALESCE(sales_revenue, 0) <= 0 ';

            let extraStockSql = '';
            const queryParams = [...pf.params, supplierKey, days, supplierKey];
            if (mode === 'laggards' || mode === 'stale') {
                extraStockSql = `
                  AND COALESCE(mse.stock, 0) > 0
                  AND (
                    snap.first_positive_date IS NULL
                    OR snap.first_positive_date < DATE_SUB(CURDATE(), INTERVAL ? DAY)
                  )`;
                queryParams.push(grace);
            } else if (mode === 'new') {
                extraStockSql = `
                  AND COALESCE(mse.stock, 0) > 0
                  AND snap.first_positive_date IS NOT NULL
                  AND snap.first_positive_date >= DATE_SUB(CURDATE(), INTERVAL ? DAY)`;
                queryParams.push(grace);
            } else if (mode === 'weak') {
                extraStockSql = ' AND COALESCE(mse.stock, 0) > 0 ';
            }

            const fetchLimit = mode === 'weak' ? Math.min(500, limit * 10) : limit;

            let totalCount = null;
            if (catalogListMode) {
                const [[countRow]] = await db.query(
                    `SELECT COUNT(*) AS total
                       FROM ms_export mse
                      WHERE TRIM(mse.supplier) = ?
                        AND ${productWhereSql}`,
                    [supplierKey],
                );
                totalCount = num(countRow && countRow.total);
            }

            queryParams.push(fetchLimit);

            const [rows] = await db.query(
                `SELECT mse.code,
                        mse.name,
                        mse.stock_position,
                        COALESCE(mse.stock, 0) AS stock,
                        med.denorm_in_transit,
                        ${MSE_IN_TRANSIT_JSON} AS in_transit_json,
                        snap.first_positive_date,
                        DATEDIFF(CURDATE(), snap.first_positive_date) AS days_on_stock,
                        (${MSE_BUY_PRICE_NUM}) AS buy_price_num,
                        (${MSE_SALE_PRICE_NUM}) AS sale_price_num,
                        COALESCE(s.sales_qty, 0) AS sales_qty,
                        COALESCE(s.sales_revenue, 0) AS sales_revenue,
                        COALESCE(s.gross_margin_est, 0) AS gross_margin_est
                   FROM ms_export mse
                   LEFT JOIN ms_entity_details med ON med.uuid = mse.uuid
                   LEFT JOIN (${snapSql}) snap ON snap.code = mse.code
                   LEFT JOIN (${salesSub}) s ON s.code = mse.code
                  WHERE TRIM(mse.supplier) = ?
                    AND ${productWhereSql}
                    ${extraStockSql}
                  ${having}
                  ORDER BY mse.name ASC, mse.code ASC
                  LIMIT ?`,
                queryParams,
            );

            let outRows = (rows || []).map((r) => {
                const stockPos = String(r.stock_position || '').trim().toLowerCase();
                return {
                    code: String(r.code || ''),
                    name: String(r.name || ''),
                    stock: num(r.stock),
                    in_transit: mapProductInTransit(r),
                    stock_position: String(r.stock_position || '').trim(),
                    is_warehouse: stockPos === 'да',
                    first_positive_date: r.first_positive_date ? String(r.first_positive_date).slice(0, 10) : '',
                    days_on_stock: num(r.days_on_stock),
                    buy_price: num(r.buy_price_num),
                    sale_price: num(r.sale_price_num),
                    sales_qty: num(r.sales_qty),
                    sales_revenue: num(r.sales_revenue),
                    gross_margin_est: num(r.gross_margin_est),
                    margin_pct: marginPct(num(r.sales_revenue), num(r.gross_margin_est)),
                };
            });

            if (mode === 'weak') {
                const withSales = outRows.filter((r) => r.sales_qty > 0);
                const qtys = withSales.map((r) => r.sales_qty).sort((a, b) => a - b);
                const medianQty =
                    qtys.length > 0
                        ? qtys.length % 2 === 1
                            ? qtys[(qtys.length - 1) / 2]
                            : (qtys[qtys.length / 2 - 1] + qtys[qtys.length / 2]) / 2
                        : 0;
                const threshold = Math.max(1, medianQty * 0.25);
                outRows = outRows
                    .filter((r) => r.sales_qty > 0 && r.sales_qty < threshold)
                    .sort((a, b) => a.sales_qty - b.sales_qty || b.stock - a.stock)
                    .slice(0, limit);
            }

            res.json({
                success: true,
                supplier_key: supplierKey,
                days,
                new_stock_days: grace,
                mode,
                total: totalCount,
                truncated: totalCount != null && outRows.length < totalCount,
                rows: outRows,
            });
        } catch (e) {
            console.error('[supplier-analysis] products', e);
            res.status(500).json({ success: false, error: e.message || 'Ошибка' });
        }
    });

    /** Топ «внимание» и «рост» для виджетов на странице. */
    router.get('/highlights', async (req, res) => {
        try {
            const days = clampInt(req.query.days, 7, 365, 90);
            const newStockDays = clampInt(req.query.new_stock_days, 7, 180, 30);
            const pf = msDemandProjectFilterFromQuery(req.query);
            const cacheKey = `highlights:${days}:${newStockDays}:${pf.fingerprint}`;
            const cached = cacheGet(cacheKey);
            if (cached) return res.json({ ...cached, cache: { hit: true } });

            const curSql = salesBySupplierSubquery(
                'd.moment >= DATE_SUB(NOW(), INTERVAL ? DAY)',
                pf.sql,
            );
            const prevSql = salesBySupplierSubquery(
                'd.moment >= DATE_SUB(NOW(), INTERVAL ? DAY) AND d.moment < DATE_SUB(NOW(), INTERVAL ? DAY)',
                pf.sql,
            );
            const catalogSql = catalogBySupplierSubquery(newStockDays);
            const mapCtx = { days, newStockDays };

            const [rawRows] = await db.query(
                supplierRankingSelectSql(catalogSql, curSql, prevSql),
                salesRankingQueryParams(days, pf.params),
            );

            let rows = (rawRows || []).map((r) => mapRankingRow(r, mapCtx));
            try {
                const absPack = await loadSupplierAbsenceRollupMap(db, days, pf, appSettings);
                const absMap = absPack.map || {};
                rows = rows.map((r) => attachAbsenceProfile(r, absMap));
            } catch (absErr) {
                console.warn('[supplier-analysis] highlights absence:', (absErr && absErr.message) || absErr);
            }
            const needs_attention = rows
                .filter((r) => r.attention_score >= 25)
                .sort((a, b) => b.attention_score - a.attention_score)
                .slice(0, 8);
            const attentionKeys = new Set(needs_attention.map((r) => r.supplier_key));
            const top_revenue = rows
                .filter((r) => r.sales_revenue > 0)
                .sort((a, b) => b.sales_revenue - a.sales_revenue)
                .slice(0, 8);
            const top_growth = rows
                .filter((r) => r.revenue_change_pct != null && r.revenue_change_pct > 0)
                .sort((a, b) => b.revenue_change_pct - a.revenue_change_pct)
                .slice(0, 8);
            // Только поставщики, которых ещё нет в «Нужна проверка» — иначе одна фирма дважды в одной колонке
            const weak = rows
                .filter(
                    (r) =>
                        !attentionKeys.has(r.supplier_key) &&
                        r.skus_ineffective >= 2,
                )
                .sort((a, b) => b.skus_ineffective - a.skus_ineffective || b.stock_value_rub - a.stock_value_rub)
                .slice(0, 8);

            const portfolio_develop = rows
                .filter((r) => r.portfolio_tag === 'develop')
                .sort((a, b) => {
                    const ac = a.sales_coverage_pct == null ? 999 : a.sales_coverage_pct;
                    const bc = b.sales_coverage_pct == null ? 999 : b.sales_coverage_pct;
                    return ac - bc || b.products_total - a.products_total;
                })
                .slice(0, 8);

            const chronic_absence = rows
                .filter((r) => num(r.chronic_sku_count) > 0)
                .sort(
                    (a, b) =>
                        num(b.chronic_max_streak_days) - num(a.chronic_max_streak_days) ||
                        num(b.chronic_sku_count) - num(a.chronic_sku_count),
                )
                .slice(0, 8);
            const flicker_absence = rows
                .filter((r) => num(r.flicker_sku_count) > 0)
                .sort((a, b) => num(b.flicker_sku_count) - num(a.flicker_sku_count))
                .slice(0, 8);

            const project_filter = await projectFilterMeta(db, pf);
            const payload = {
                success: true,
                days,
                new_stock_days: newStockDays,
                project_filter,
                portfolio_develop,
                needs_attention,
                top_revenue,
                top_growth,
                weak,
                chronic_absence,
                flicker_absence,
            };
            cacheSet(cacheKey, payload);
            res.json(payload);
        } catch (e) {
            console.error('[supplier-analysis] highlights', e);
            res.status(500).json({ success: false, error: e.message || 'Ошибка' });
        }
    });

    async function loadRankingRowsForExport(days, search, newStockDays, query) {
        const pf = msDemandProjectFilterFromQuery(query || {});
        const curSql = salesBySupplierSubquery(
            'd.moment >= DATE_SUB(NOW(), INTERVAL ? DAY)',
            pf.sql,
        );
        const prevSql = salesBySupplierSubquery(
            'd.moment >= DATE_SUB(NOW(), INTERVAL ? DAY) AND d.moment < DATE_SUB(NOW(), INTERVAL ? DAY)',
            pf.sql,
        );
        const catalogSql = catalogBySupplierSubquery(newStockDays);
        const searchSql = search
            ? ' AND c.supplier_name COLLATE utf8mb4_unicode_ci LIKE ? '
            : '';
        const searchParam = search ? `%${search}%` : null;
        const innerSql = supplierRankingSelectSql(catalogSql, curSql, prevSql) + ` WHERE 1=1 ${searchSql}`;
        const params = salesRankingQueryParams(days, pf.params, searchParam);
        const [rawRows] = await db.query(innerSql, params);
        const mapCtx = { days, newStockDays };
        return (rawRows || []).map((r) => mapRankingRow(r, mapCtx)).sort((a, b) => b.attention_score - a.attention_score);
    }

    function csvEscape(v) {
        const s = String(v == null ? '' : v);
        if (/[",;\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
        return s;
    }

    router.get('/export', async (req, res) => {
        try {
            const days = clampInt(req.query.days, 7, 365, 90);
            const newStockDays = clampInt(req.query.new_stock_days, 7, 180, 30);
            const search = String(req.query.search || '').trim();
            const rows = await loadRankingRowsForExport(days, search, newStockDays, req.query);
            const header = [
                'Поставщик',
                'SKU каталог',
                'SKU с остатком',
                'SKU с продажами',
                '% продаж каталога',
                'Новые на остатке',
                'Залежалые SKU',
                'Оборачиваемость',
                'Запас дней',
                'Выручка',
                'Остаток оценка',
                'Внимание',
                'Сигналы',
            ];
            const lines = [header.join(';')];
            for (const r of rows) {
                lines.push(
                    [
                        r.supplier_name,
                        r.products_total,
                        r.skus_with_stock,
                        r.skus_with_sales,
                        r.sales_coverage_pct != null ? r.sales_coverage_pct : '',
                        r.skus_new_on_stock,
                        r.skus_ineffective,
                        r.value_turnover != null ? r.value_turnover : '',
                        r.days_of_supply != null ? r.days_of_supply : '',
                        r.sales_revenue,
                        r.stock_value_rub,
                        r.attention_score,
                        (r.signals || []).map((s) => s.text).join(' | '),
                    ]
                        .map(csvEscape)
                        .join(';'),
                );
            }
            const body = '\ufeff' + lines.join('\n');
            const fname = `supplier-analysis-${days}d.csv`;
            res.setHeader('Content-Type', 'text/csv; charset=utf-8');
            res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
            res.send(body);
        } catch (e) {
            console.error('[supplier-analysis] export', e);
            res.status(500).json({ success: false, error: e.message || 'Ошибка' });
        }
    });

    return router;
};
