'use strict';

/**
 * Анализ товаров — продажи / остатки / жизненный цикл по SKU.
 *
 * GET  /api/product-analysis/projects
 * GET  /api/product-analysis/presets
 * GET  /api/product-analysis/overview
 * GET  /api/product-analysis/ranking
 * GET  /api/product-analysis/export
 * GET  /api/product-analysis/sku-detail?code=&days=
 * GET  /api/product-analysis/log?code=&field=&limit=&offset=
 * POST /api/product-analysis/decision
 * POST /api/product-analysis/decision/bulk
 * POST /api/product-analysis/min-stock/apply
 */

const express = require('express');
const { msDemandProjectFilterFromQuery } = require('../lib/datagonSalesFormulaDemandFilter');
const {
    salesByCodeSubquery,
    catalogByCodeSql,
    productRankingSelectSql,
    productSalesQueryParams,
    hydrateDaysOnStockForCodes,
    rankingNeedsSnapJoin,
    PRESETS,
    PRESET_KEYS,
    presetWhereSql,
    presetDefaultSort,
} = require('../lib/datagonProductAnalysisSql');
const {
    salesJoinSql,
    salesQtyExprSql,
    salesRevenueExprSql,
} = require('../lib/datagonSupplierAnalysisSql');
const {
    loadSkuRecommendedDaysByCodes,
    CHRONIC_STREAK_DAYS,
    FLICKER_MIN_EPISODES,
    FLICKER_MAX_AVG_EPISODE,
} = require('../lib/datagonSupplierAbsenceProfile');
const { supplierEffectiveSql } = require('../lib/datagonSuppliersSql');
const {
    ensureProductAnalysisDecisionsSchema,
    normalizeLifecycle,
    upsertProductDecision,
    listProductDecisionLogs,
    describePatchFields,
    DEFAULT_BOOST_DAYS,
} = require('../lib/datagonProductAnalysisDecisions');

const CACHE_TTL_MS = 60 * 1000;
const CACHE_VER = 'pa6';
const responseCache = new Map();

const RANKING_SORT = new Set([
    'code',
    'name',
    'supplier_name',
    'manager',
    'stock_qty',
    'stock_value_rub',
    'min_stock',
    'formula_proposed',
    'sales_qty',
    'sales_revenue',
    'gross_margin_est',
    'margin_pct',
    'days_without_sales',
    'days_on_stock',
    'first_positive_date',
    'revenue_change_pct',
    'lifecycle',
    'do_not_order',
]);

function clampInt(v, min, max, def) {
    const n = Number(v);
    if (!Number.isFinite(n)) return def;
    return Math.min(max, Math.max(min, Math.floor(n)));
}

function parseBoolFlag(v, def) {
    if (v == null || v === '') return def;
    const s = String(v).trim().toLowerCase();
    if (s === '1' || s === 'true' || s === 'yes' || s === 'on') return true;
    if (s === '0' || s === 'false' || s === 'no' || s === 'off') return false;
    return def;
}

function num(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
}

function pctChange(cur, prev) {
    if (prev > 0) return Math.round((10000 * (cur - prev)) / prev) / 100;
    if (cur > 0) return 100;
    return null;
}

function marginPct(rev, margin) {
    if (rev > 0) return Math.round((10000 * margin) / rev) / 100;
    return null;
}

function cacheGet(key) {
    const hit = responseCache.get(key);
    if (!hit) return null;
    if (Date.now() - hit.ts > CACHE_TTL_MS) {
        responseCache.delete(key);
        return null;
    }
    return hit.payload;
}

function cacheSet(key, payload) {
    if (responseCache.size > 200) {
        const first = responseCache.keys().next().value;
        if (first != null) responseCache.delete(first);
    }
    responseCache.set(key, { ts: Date.now(), payload });
}

function invalidateProductAnalysisCache() {
    responseCache.clear();
}

async function projectFilterMeta(db, pf) {
    return {
        mode: pf.mode || 'all',
        uuids: pf.uuids || [],
        fingerprint: pf.fingerprint || '',
        sql_applied: Boolean(pf.sql && String(pf.sql).trim()),
    };
}

function parsePreset(raw) {
    const s = String(raw || 'all').trim().toLowerCase();
    return PRESET_KEYS.has(s) ? s : 'all';
}

function mapRankingRow(r) {
    const rev = num(r.sales_revenue);
    const margin = num(r.gross_margin_est);
    return {
        code: String(r.code || ''),
        name: String(r.name || ''),
        supplier_name: String(r.supplier_name || ''),
        manager: String(r.manager || ''),
        stock_qty: num(r.stock_qty),
        stock_value_rub: num(r.stock_value_rub),
        min_stock: num(r.min_stock),
        formula_proposed: r.formula_proposed == null ? null : num(r.formula_proposed),
        sales_qty: num(r.sales_qty),
        sales_revenue: rev,
        sales_revenue_prev: num(r.sales_revenue_prev),
        gross_margin_est: margin,
        margin_pct: r.margin_pct != null ? num(r.margin_pct) : marginPct(rev, margin),
        revenue_change_pct:
            r.revenue_change_pct != null ? num(r.revenue_change_pct) : pctChange(rev, num(r.sales_revenue_prev)),
        last_sale_at: r.last_sale_at ? String(r.last_sale_at) : null,
        days_without_sales: r.days_without_sales == null ? null : num(r.days_without_sales),
        first_positive_date: r.first_positive_date ? String(r.first_positive_date).slice(0, 10) : null,
        days_on_stock: r.days_on_stock == null ? null : num(r.days_on_stock),
        lifecycle: String(r.lifecycle || 'none'),
        do_not_order: Number(r.do_not_order || 0) === 1,
        min_stock_target: r.min_stock_target == null ? null : num(r.min_stock_target),
        lock_proposed_min_stock: Number(r.lock_proposed_min_stock || 0) === 1,
        boost_started_at: r.boost_started_at ? String(r.boost_started_at) : null,
        boost_days: r.boost_days == null ? null : num(r.boost_days),
        decision_note: r.decision_note != null ? String(r.decision_note) : null,
    };
}

function buildRankingFromSql(days, pf, opts = {}) {
    const newStockDays = clampInt(opts.newStockDays, 7, 180, 30);
    const includeSnap = opts.includeSnap === true;
    const includePrev = opts.includePrev !== false;
    const snapLookback = includeSnap ? Math.max(newStockDays + 30, 365) : 0;
    const curSql = salesByCodeSubquery('d.moment >= DATE_SUB(NOW(), INTERVAL ? DAY)', pf.sql);
    const prevSql = includePrev
        ? salesByCodeSubquery(
              'd.moment >= DATE_SUB(NOW(), INTERVAL ? DAY) AND d.moment < DATE_SUB(NOW(), INTERVAL ? DAY)',
              pf.sql,
          )
        : null;
    const catalogSql = catalogByCodeSql({ snapLookbackDays: snapLookback });
    const selectSql = productRankingSelectSql(catalogSql, curSql, prevSql, {
        includePrev,
    });
    const baseParams = productSalesQueryParams(days, pf.params, { includePrev });
    return { selectSql, baseParams, newStockDays, snapLookback, includeSnap, includePrev };
}

function searchWhereSql(search) {
    if (!search) return { sql: '', params: [] };
    return {
        sql: ` AND (
            LOWER(CONVERT(r.code USING utf8mb4)) LIKE ?
            OR LOWER(CONVERT(r.name USING utf8mb4)) LIKE ?
            OR LOWER(CONVERT(r.supplier_name USING utf8mb4)) LIKE ?
            OR LOWER(CONVERT(r.manager USING utf8mb4)) LIKE ?
        ) `,
        params: [`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`],
    };
}

function supplierWhereSql(supplier) {
    if (!supplier) return { sql: '', params: [] };
    return {
        sql: ' AND LOWER(CONVERT(r.supplier_name USING utf8mb4)) LIKE ? ',
        params: [`%${supplier}%`],
    };
}

function managerWhereSql(manager) {
    const m = String(manager || '').trim();
    if (!m) return { sql: '', params: [] };
    return {
        sql: ' AND LOWER(TRIM(COALESCE(r.manager, \'\'))) = LOWER(TRIM(?)) ',
        params: [m],
    };
}

function lifecycleWhereSql(lifecycle) {
    const lc = normalizeLifecycle(lifecycle);
    if (!lc || lc === 'none') {
        if (String(lifecycle || '').trim().toLowerCase() === 'none') {
            return { sql: ` AND COALESCE(r.lifecycle, 'none') = 'none' `, params: [] };
        }
        return { sql: '', params: [] };
    }
    return { sql: ' AND r.lifecycle = ? ', params: [lc] };
}

/** Фильтры списка из query/body. */
function buildListFilterParts(src) {
    const search = String((src && src.search) || '').trim().toLowerCase();
    const supplier = String((src && src.supplier) || '').trim().toLowerCase();
    const manager = String((src && src.manager) || '').trim();
    const lifecycle = String((src && src.lifecycle) || '').trim().toLowerCase();
    const preset = parsePreset(src && src.preset);
    const newStockDays = clampInt(src && src.new_stock_days, 7, 180, 30);
    const excludeNew = parseBoolFlag(src && src.exclude_new_on_stock, true);
    const sw = searchWhereSql(search);
    const su = supplierWhereSql(supplier);
    const mw = managerWhereSql(manager);
    const lw = lifecycleWhereSql(lifecycle);
    let whereExtra = `${sw.sql}${su.sql}${mw.sql}${lw.sql}`;
    const filterParams = [...sw.params, ...su.params, ...mw.params, ...lw.params];

    if (preset === 'new_on_stock') {
        whereExtra += ` AND COALESCE(r.stock_qty, 0) > 0
            AND r.first_positive_date IS NOT NULL
            AND r.first_positive_date >= DATE_SUB(CURDATE(), INTERVAL ? DAY) `;
        filterParams.push(newStockDays);
    } else {
        whereExtra += presetWhereSql(preset);
        if (
            excludeNew &&
            (preset === 'dead' || preset === 'stuck' || preset === 'dead_min_stock')
        ) {
            whereExtra += ` AND (
                r.first_positive_date IS NULL
                OR r.first_positive_date < DATE_SUB(CURDATE(), INTERVAL ? DAY)
            ) `;
            filterParams.push(newStockDays);
        }
    }

    return {
        search,
        supplier,
        manager,
        lifecycle,
        preset,
        new_stock_days: newStockDays,
        exclude_new_on_stock: excludeNew,
        whereExtra,
        filterParams,
        cacheKeyPart: `${search}:${supplier}:${manager}:${lifecycle}:${preset}:ns${newStockDays}:ex${excludeNew ? 1 : 0}`,
    };
}

module.exports = function productAnalysisRouterFactory(db, _appSettings) {
    const router = express.Router();

    router.get('/presets', async (_req, res) => {
        res.json({
            success: true,
            presets: PRESETS,
            lifecycles: ['none', 'top', 'hold', 'boost', 'boost_failed', 'clearance', 'exit'],
            default_boost_days: DEFAULT_BOOST_DAYS,
        });
    });

    router.get('/projects', async (req, res) => {
        try {
            const days = clampInt(req.query.days, 7, 365, 90);
            const [rows] = await db.query(
                `SELECT project_uuid AS uuid, project_name AS name, COUNT(*) AS cnt
                   FROM ms_demand
                  WHERE moment >= DATE_SUB(NOW(), INTERVAL ? DAY)
                    AND applicable = 1
                    AND deleted_at IS NULL
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

    /** Уникальные менеджеры — свойство МС «Менеджер поддерживающий товар» (`ms_export.manager`). */
    router.get('/managers', async (_req, res) => {
        try {
            const [rows] = await db.query(
                `SELECT DISTINCT TRIM(manager) AS manager
                   FROM ms_export
                  WHERE manager IS NOT NULL AND TRIM(manager) <> ''
                  ORDER BY manager ASC`,
            );
            res.json({
                success: true,
                managers: (rows || [])
                    .map((r) => String(r.manager || '').trim())
                    .filter(Boolean),
            });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message || 'Ошибка' });
        }
    });

    /**
     * Детализация одной SKU: продажи по проектам/каналам + профиль отсутствия на складе.
     * Query: code (обяз.), days, project_mode, project_uuids.
     */
    router.get('/sku-detail', async (req, res) => {
        try {
            await ensureProductAnalysisDecisionsSchema(db);
            const code = String(req.query.code || '').trim();
            if (!code) {
                return res.status(400).json({ success: false, error: 'Не указан code' });
            }
            const days = clampInt(req.query.days, 7, 365, 90);
            const pf = msDemandProjectFilterFromQuery(req.query);
            const sk = supplierEffectiveSql('mse');

            const [[mseRows], salesRowsPack, absenceMap] = await Promise.all([
                db.query(
                    `SELECT mse.code, mse.name, ${sk} AS supplier_name,
                            TRIM(COALESCE(mse.manager, '')) AS manager,
                            COALESCE(mse.stock, 0) AS stock_qty,
                            COALESCE(mse.min_stock, 0) AS min_stock,
                            pad.lifecycle, pad.do_not_order, pad.boost_started_at, pad.boost_days,
                            pad.decision_note
                       FROM ms_export mse
                       LEFT JOIN dg_product_analysis_decisions pad ON pad.code = mse.code
                      WHERE mse.code = ?
                      LIMIT 1`,
                    [code],
                ),
                (async () => {
                    const demandExtra = `${pf.sql} AND e.code = ?`;
                    const sql = `
                        SELECT
                            COALESCE(NULLIF(TRIM(d.project_name), ''), '(без проекта)') AS project_name,
                            COALESCE(NULLIF(TRIM(LOWER(d.project_uuid)), ''), '') AS project_uuid,
                            SUM(${salesQtyExprSql()}) AS sales_qty,
                            SUM(${salesRevenueExprSql()}) AS sales_revenue
                        ${salesJoinSql('e', demandExtra)}
                          AND d.moment >= DATE_SUB(NOW(), INTERVAL ? DAY)
                        GROUP BY project_name, project_uuid
                        ORDER BY sales_revenue DESC, sales_qty DESC
                        LIMIT 50`;
                    const [rows] = await db.query(sql, [...pf.params, code, days]);
                    return rows || [];
                })(),
                loadSkuRecommendedDaysByCodes(db, [code], {}),
            ]);

            const product = mseRows && mseRows[0] ? mseRows[0] : null;
            if (!product) {
                return res.status(404).json({ success: false, error: 'Товар не найден в каталоге' });
            }

            const byProject = (salesRowsPack || []).map((r) => ({
                project_name: String(r.project_name || '(без проекта)'),
                project_uuid: String(r.project_uuid || ''),
                sales_qty: num(r.sales_qty),
                sales_revenue: num(r.sales_revenue),
            }));
            const sales_qty_total = byProject.reduce((s, r) => s + r.sales_qty, 0);
            const sales_revenue_total = byProject.reduce((s, r) => s + r.sales_revenue, 0);
            byProject.forEach((r) => {
                r.share_pct =
                    sales_revenue_total > 0
                        ? Math.round((10000 * r.sales_revenue) / sales_revenue_total) / 100
                        : sales_qty_total > 0
                          ? Math.round((10000 * r.sales_qty) / sales_qty_total) / 100
                          : 0;
            });

            const absRaw = absenceMap && absenceMap.get ? absenceMap.get(code) : null;
            const abs = absRaw || {
                max_streak_days: 0,
                episode_count: 0,
                avg_episode_days: 0,
                recommended_replenishment_days: null,
            };
            const chronic =
                abs.max_streak_days >= (CHRONIC_STREAK_DAYS || 14);
            const flicker =
                abs.episode_count >= (FLICKER_MIN_EPISODES || 3) &&
                abs.avg_episode_days <= (FLICKER_MAX_AVG_EPISODE || 3);

            res.json({
                success: true,
                days,
                project_filter: await projectFilterMeta(db, pf),
                product: {
                    code: String(product.code || ''),
                    name: String(product.name || ''),
                    supplier_name: String(product.supplier_name || ''),
                    manager: String(product.manager || ''),
                    stock_qty: num(product.stock_qty),
                    min_stock: num(product.min_stock),
                    lifecycle: String(product.lifecycle || 'none'),
                    do_not_order: Number(product.do_not_order || 0) === 1,
                    boost_started_at: product.boost_started_at
                        ? String(product.boost_started_at)
                        : null,
                    boost_days: product.boost_days == null ? null : num(product.boost_days),
                    decision_note: product.decision_note != null ? String(product.decision_note) : null,
                },
                sales: {
                    qty_total: sales_qty_total,
                    revenue_total: sales_revenue_total,
                    by_project: byProject,
                },
                absence: {
                    window_days: 210,
                    max_streak_days: abs.max_streak_days,
                    episode_count: abs.episode_count,
                    avg_episode_days: abs.avg_episode_days,
                    recommended_replenishment_days: abs.recommended_replenishment_days,
                    chronic,
                    flicker,
                },
            });
        } catch (e) {
            console.error('[product-analysis] sku-detail', e);
            res.status(500).json({ success: false, error: e.message || 'Ошибка' });
        }
    });

    router.get('/overview', async (req, res) => {
        try {
            await ensureProductAnalysisDecisionsSchema(db);
            const days = clampInt(req.query.days, 7, 365, 90);
            const flt = buildListFilterParts(req.query);
            const preset = flt.preset;
            const pf = msDemandProjectFilterFromQuery(req.query);
            const cacheKey = `${CACHE_VER}:overview:${days}:${flt.cacheKeyPart}:${pf.fingerprint}`;
            const cached = cacheGet(cacheKey);
            if (cached) return res.json({ ...cached, cache: { hit: true } });

            const { selectSql, baseParams } = buildRankingFromSql(days, pf, {
                newStockDays: flt.new_stock_days,
                includeSnap: rankingNeedsSnapJoin(flt, null),
                includePrev: true,
            });
            const whereExtra = flt.whereExtra;
            const params = [...baseParams, ...flt.filterParams];

            const sql = `
                SELECT
                    COUNT(*) AS skus_total,
                    SUM(COALESCE(r.sales_revenue, 0)) AS sales_revenue,
                    SUM(COALESCE(r.sales_revenue_prev, 0)) AS sales_revenue_prev,
                    SUM(COALESCE(r.sales_qty, 0)) AS sales_qty,
                    SUM(COALESCE(r.gross_margin_est, 0)) AS gross_margin_est,
                    SUM(COALESCE(r.stock_value_rub, 0)) AS stock_value_rub,
                    SUM(COALESCE(r.min_stock, 0)) AS min_stock_sum,
                    SUM(CASE WHEN COALESCE(r.sales_qty, 0) <= 0 AND COALESCE(r.stock_qty, 0) > 0 THEN 1 ELSE 0 END) AS dead_with_stock,
                    SUM(CASE WHEN COALESCE(r.sales_qty, 0) <= 0 AND COALESCE(r.min_stock, 0) > 0 THEN 1 ELSE 0 END) AS dead_with_min_stock,
                    SUM(CASE WHEN r.lifecycle = 'boost' THEN 1 ELSE 0 END) AS in_boost,
                    SUM(CASE WHEN r.lifecycle IN ('clearance', 'exit') THEN 1 ELSE 0 END) AS in_exit_path,
                    SUM(CASE WHEN COALESCE(r.do_not_order, 0) = 1 THEN 1 ELSE 0 END) AS do_not_order_count
                FROM (${selectSql}) r
                WHERE 1=1 ${whereExtra}`;

            const [rows] = await db.query(sql, params);
            const t = rows && rows[0] ? rows[0] : {};
            const rev = num(t.sales_revenue);
            const payload = {
                success: true,
                days,
                preset,
                new_stock_days: flt.new_stock_days,
                exclude_new_on_stock: flt.exclude_new_on_stock,
                project_filter: await projectFilterMeta(db, pf),
                totals: {
                    skus_total: num(t.skus_total),
                    sales_revenue: rev,
                    sales_revenue_prev: num(t.sales_revenue_prev),
                    revenue_change_pct: pctChange(rev, num(t.sales_revenue_prev)),
                    sales_qty: num(t.sales_qty),
                    gross_margin_est: num(t.gross_margin_est),
                    margin_pct: marginPct(rev, num(t.gross_margin_est)),
                    stock_value_rub: num(t.stock_value_rub),
                    min_stock_sum: num(t.min_stock_sum),
                    dead_with_stock: num(t.dead_with_stock),
                    dead_with_min_stock: num(t.dead_with_min_stock),
                    in_boost: num(t.in_boost),
                    in_exit_path: num(t.in_exit_path),
                    do_not_order_count: num(t.do_not_order_count),
                },
            };
            cacheSet(cacheKey, payload);
            res.json(payload);
        } catch (e) {
            console.error('[product-analysis] overview', e);
            res.status(500).json({ success: false, error: e.message || 'Ошибка' });
        }
    });

    router.get('/ranking', async (req, res) => {
        try {
            await ensureProductAnalysisDecisionsSchema(db);
            const days = clampInt(req.query.days, 7, 365, 90);
            const limit = clampInt(req.query.limit, 1, 500, 100);
            const offset = clampInt(req.query.offset, 0, 500000, 0);
            const flt = buildListFilterParts(req.query);
            const preset = flt.preset;
            const pf = msDemandProjectFilterFromQuery(req.query);
            const presetSort = presetDefaultSort(preset);
            /** Пресет задаёт сортировку, если клиент явно просит (`preset_sort=1`) или sort_by не передан. */
            const forcePresetSort =
                String(req.query.preset_sort || '') === '1' ||
                req.query.sort_by == null ||
                String(req.query.sort_by).trim() === '';
            let sortBy = forcePresetSort
                ? presetSort.sortBy
                : RANKING_SORT.has(req.query.sort_by)
                  ? req.query.sort_by
                  : presetSort.sortBy;
            if (!RANKING_SORT.has(sortBy)) sortBy = 'sales_revenue';
            const sortDirRaw = String(req.query.sort_dir || '').toLowerCase();
            const sortDir = forcePresetSort
                ? presetSort.sortDir
                : sortDirRaw === 'asc' || sortDirRaw === 'desc'
                  ? sortDirRaw.toUpperCase()
                  : presetSort.sortDir;

            const cacheKey = JSON.stringify({
                ver: CACHE_VER,
                days,
                limit,
                offset,
                flt: flt.cacheKeyPart,
                sortBy,
                sortDir,
                pf: pf.fingerprint,
            });
            const cached = cacheGet(cacheKey);
            if (cached) return res.json({ ...cached, cache: { hit: true } });

            const needSnap = rankingNeedsSnapJoin(flt, sortBy);
            const needPrev = sortBy === 'revenue_change_pct';
            const { selectSql, baseParams, snapLookback } = buildRankingFromSql(days, pf, {
                newStockDays: flt.new_stock_days,
                includeSnap: needSnap,
                includePrev: needPrev,
            });
            const whereExtra = flt.whereExtra;
            const filterParams = [...baseParams, ...flt.filterParams];

            const [countRows] = await db.query(
                `SELECT COUNT(*) AS cnt FROM (${selectSql}) r WHERE 1=1 ${whereExtra}`,
                filterParams,
            );
            const total = num(countRows && countRows[0] ? countRows[0].cnt : 0);

            const orderCol = RANKING_SORT.has(sortBy) ? sortBy : 'sales_revenue';
            const [rows] = await db.query(
                `SELECT * FROM (${selectSql}) r
                  WHERE 1=1 ${whereExtra}
                  ORDER BY r.\`${orderCol}\` ${sortDir}, r.code ASC
                  LIMIT ? OFFSET ?`,
                [...filterParams, limit, offset],
            );

            let mapped = (rows || []).map(mapRankingRow);
            if (!needSnap && mapped.length) {
                const snapMap = await hydrateDaysOnStockForCodes(
                    db,
                    mapped.map((r) => r.code),
                    Math.max(flt.new_stock_days + 30, 365),
                );
                mapped = mapped.map((r) => {
                    const hit = snapMap.get(r.code);
                    if (!hit) return r;
                    return Object.assign({}, r, {
                        first_positive_date: hit.first_positive_date,
                        days_on_stock: hit.days_on_stock,
                    });
                });
            }

            const payload = {
                success: true,
                days,
                preset,
                new_stock_days: flt.new_stock_days,
                exclude_new_on_stock: flt.exclude_new_on_stock,
                limit,
                offset,
                total,
                sort_by: orderCol,
                sort_dir: sortDir.toLowerCase(),
                project_filter: await projectFilterMeta(db, pf),
                rows: mapped,
                perf: {
                    snap_joined: needSnap,
                    snap_lookback: needSnap ? snapLookback : 0,
                    prev_period: needPrev,
                },
            };
            cacheSet(cacheKey, payload);
            res.json(payload);
        } catch (e) {
            console.error('[product-analysis] ranking', e);
            res.status(500).json({ success: false, error: e.message || 'Ошибка' });
        }
    });

    router.get('/export', async (req, res) => {
        try {
            await ensureProductAnalysisDecisionsSchema(db);
            const days = clampInt(req.query.days, 7, 365, 90);
            const flt = buildListFilterParts(req.query);
            const pf = msDemandProjectFilterFromQuery(req.query);
            const { selectSql, baseParams } = buildRankingFromSql(days, pf, {
                newStockDays: flt.new_stock_days,
                includeSnap: rankingNeedsSnapJoin(flt, null),
                includePrev: false,
            });
            const whereExtra = flt.whereExtra;
            const filterParams = [...baseParams, ...flt.filterParams];
            const [rows] = await db.query(
                `SELECT * FROM (${selectSql}) r WHERE 1=1 ${whereExtra}
                  ORDER BY r.sales_revenue DESC, r.code ASC LIMIT 20000`,
                filterParams,
            );
            const header = [
                'code',
                'name',
                'supplier_name',
                'manager',
                'stock_qty',
                'stock_value_rub',
                'min_stock',
                'formula_proposed',
                'sales_qty',
                'sales_revenue',
                'gross_margin_est',
                'margin_pct',
                'days_without_sales',
                'decision_note',
                'lifecycle',
                'do_not_order',
            ];
            const esc = (v) => {
                const s = v == null ? '' : String(v);
                if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
                return s;
            };
            const lines = [header.join(',')];
            (rows || []).forEach((raw) => {
                const r = mapRankingRow(raw);
                lines.push(
                    header
                        .map((k) => {
                            const v = r[k];
                            if (typeof v === 'boolean') return v ? '1' : '0';
                            return esc(v);
                        })
                        .join(','),
                );
            });
            res.setHeader('Content-Type', 'text/csv; charset=utf-8');
            res.setHeader(
                'Content-Disposition',
                `attachment; filename="product-analysis-${days}d.csv"`,
            );
            res.send('\uFEFF' + lines.join('\n'));
        } catch (e) {
            console.error('[product-analysis] export', e);
            res.status(500).json({ success: false, error: e.message || 'Ошибка' });
        }
    });

    function patchFromBody(body) {
        const patch = {};
        if (body.lifecycle != null) patch.lifecycle = body.lifecycle;
        if (body.do_not_order != null) patch.do_not_order = Boolean(body.do_not_order);
        if (Object.prototype.hasOwnProperty.call(body, 'min_stock_target')) {
            patch.min_stock_target = body.min_stock_target;
        }
        if (body.lock_proposed_min_stock != null) {
            patch.lock_proposed_min_stock = Boolean(body.lock_proposed_min_stock);
        }
        if (Object.prototype.hasOwnProperty.call(body, 'decision_note')) {
            patch.decision_note = body.decision_note;
        }
        if (body.boost_days != null) patch.boost_days = body.boost_days;
        if (body.action) {
            const action = String(body.action).trim().toLowerCase();
            if (action === 'boost') {
                patch.lifecycle = 'boost';
                if (patch.boost_days == null) patch.boost_days = DEFAULT_BOOST_DAYS;
            } else if (action === 'boost_failed') patch.lifecycle = 'boost_failed';
            else if (action === 'clearance') {
                patch.lifecycle = 'clearance';
                patch.do_not_order = true;
                if (!Object.prototype.hasOwnProperty.call(patch, 'min_stock_target')) {
                    patch.min_stock_target = 0;
                }
            } else if (action === 'exit') {
                patch.lifecycle = 'exit';
                patch.do_not_order = true;
                patch.min_stock_target = 0;
            } else if (action === 'top') patch.lifecycle = 'top';
            else if (action === 'hold') patch.lifecycle = 'hold';
            else if (action === 'clear_decision') {
                patch.lifecycle = 'none';
                patch.do_not_order = false;
                patch.min_stock_target = null;
                patch.lock_proposed_min_stock = false;
            } else if (action === 'do_not_order_on') patch.do_not_order = true;
            else if (action === 'do_not_order_off') patch.do_not_order = false;
            else if (action === 'lock_proposed_zero') {
                patch.lock_proposed_min_stock = true;
                patch.min_stock_target =
                    Object.prototype.hasOwnProperty.call(patch, 'min_stock_target')
                        ? patch.min_stock_target
                        : 0;
            } else if (action === 'unlock_proposed') {
                patch.lock_proposed_min_stock = false;
            }
        }
        return patch;
    }

    router.post('/decision', express.json({ limit: '32kb' }), async (req, res) => {
        const t0 = Date.now();
        try {
            await ensureProductAnalysisDecisionsSchema(db);
            const body = req.body && typeof req.body === 'object' ? req.body : {};
            const code = String(body.code || '').trim();
            if (!code) return res.status(400).json({ success: false, error: 'Не указан code' });
            const patch = patchFromBody(body);
            if (!Object.keys(patch).length) {
                return res.status(400).json({ success: false, error: 'Нет полей для обновления' });
            }
            const result = await upsertProductDecision(db, code, patch, req.datagonActor || null, {
                source: 'row',
            });
            invalidateProductAnalysisCache();
            res.json({
                success: true,
                decision: result.decision,
                changes: (result.changes || []).map((c) => ({
                    field: c.field,
                    old_value: c.oldVal,
                    new_value: c.newVal,
                })),
                duration_sec: Math.round((Date.now() - t0) / 10) / 100,
            });
        } catch (e) {
            res.status(400).json({ success: false, error: e.message || 'Ошибка' });
        }
    });

    router.get('/log', async (req, res) => {
        try {
            const payload = await listProductDecisionLogs(db, {
                code: req.query.code,
                field: req.query.field,
                limit: req.query.limit,
                offset: req.query.offset,
            });
            res.json({ success: true, ...payload });
        } catch (e) {
            res.status(400).json({ success: false, error: e.message || 'Ошибка' });
        }
    });

    router.post('/decision/bulk', express.json({ limit: '256kb' }), async (req, res) => {
        const t0 = Date.now();
        try {
            await ensureProductAnalysisDecisionsSchema(db);
            const body = req.body && typeof req.body === 'object' ? req.body : {};
            const dryRun = body.dry_run === true || body.dry_run === 1 || body.dry_run === '1';
            const patch = patchFromBody(body);
            if (!Object.keys(patch).length) {
                return res.status(400).json({ success: false, error: 'Нет полей для обновления' });
            }
            const patchFields = describePatchFields(patch);

            let codes = [];
            if (Array.isArray(body.codes) && body.codes.length) {
                codes = body.codes.map((c) => String(c || '').trim()).filter(Boolean);
            } else {
                const days = clampInt(body.days, 7, 365, 90);
                const flt = buildListFilterParts(body);
                const pf = msDemandProjectFilterFromQuery(body);
                const { selectSql, baseParams } = buildRankingFromSql(days, pf, {
                    newStockDays: flt.new_stock_days,
                    includeSnap: rankingNeedsSnapJoin(flt, null),
                    includePrev: false,
                });
                const whereExtra = flt.whereExtra;
                const filterParams = [...baseParams, ...flt.filterParams];
                const maxRows = clampInt(body.limit, 1, 5000, 500);
                const [rows] = await db.query(
                    `SELECT r.code FROM (${selectSql}) r WHERE 1=1 ${whereExtra} LIMIT ?`,
                    [...filterParams, maxRows],
                );
                codes = (rows || []).map((r) => String(r.code || '').trim()).filter(Boolean);
            }

            const total = codes.length;
            if (dryRun) {
                return res.json({
                    success: true,
                    dry_run: true,
                    total,
                    would_update: total,
                    patch,
                    patch_fields: patchFields,
                    duration_sec: Math.round((Date.now() - t0) / 10) / 100,
                });
            }

            let updated = 0;
            let changedFields = 0;
            const errors = [];
            for (const code of codes) {
                try {
                    const result = await upsertProductDecision(
                        db,
                        code,
                        patch,
                        req.datagonActor || null,
                        { source: 'bulk' },
                    );
                    updated += 1;
                    changedFields += (result.changes || []).length;
                } catch (err) {
                    if (errors.length < 20) {
                        errors.push({ code, error: err.message || String(err) });
                    }
                }
            }
            invalidateProductAnalysisCache();
            res.json({
                success: true,
                dry_run: false,
                total,
                updated,
                changed_fields: changedFields,
                failed: errors.length,
                errors,
                patch,
                patch_fields: patchFields,
                duration_sec: Math.round((Date.now() - t0) / 10) / 100,
            });
        } catch (e) {
            console.error('[product-analysis] decision/bulk', e);
            res.status(500).json({ success: false, error: e.message || 'Ошибка' });
        }
    });

    /**
     * Применить min_stock_target (или явное value) → ms_export.min_stock.
     * Только Datagon; выгрузка в МС — отдельный автосинк min_stock_export.
     */
    router.post('/min-stock/apply', express.json({ limit: '256kb' }), async (req, res) => {
        const t0 = Date.now();
        try {
            await ensureProductAnalysisDecisionsSchema(db);
            const body = req.body && typeof req.body === 'object' ? req.body : {};
            const dryRun = body.dry_run === true || body.dry_run === 1 || body.dry_run === '1';
            const forceZero = body.force_zero === true || body.force_zero === 1 || body.force_zero === '1';
            const explicitValue =
                body.value != null && body.value !== '' ? Number(body.value) : null;

            let codes = [];
            if (Array.isArray(body.codes) && body.codes.length) {
                codes = body.codes.map((c) => String(c || '').trim()).filter(Boolean);
            } else {
                const days = clampInt(body.days, 7, 365, 90);
                const bodyFlt = Object.assign({}, body);
                if (!bodyFlt.preset) bodyFlt.preset = 'dead_min_stock';
                const flt = buildListFilterParts(bodyFlt);
                const pf = msDemandProjectFilterFromQuery(body);
                const { selectSql, baseParams } = buildRankingFromSql(days, pf, {
                    newStockDays: flt.new_stock_days,
                    includeSnap: rankingNeedsSnapJoin(flt, null),
                    includePrev: false,
                });
                const whereExtra = flt.whereExtra;
                const filterParams = [...baseParams, ...flt.filterParams];
                const maxRows = clampInt(body.limit, 1, 5000, 500);
                const [rows] = await db.query(
                    `SELECT r.code, r.min_stock, r.min_stock_target
                       FROM (${selectSql}) r WHERE 1=1 ${whereExtra} LIMIT ?`,
                    [...filterParams, maxRows],
                );
                codes = (rows || []).map((r) => String(r.code || '').trim()).filter(Boolean);
            }

            if (!codes.length) {
                return res.json({
                    success: true,
                    dry_run: dryRun,
                    total: 0,
                    to_update: 0,
                    updated: 0,
                    skipped: 0,
                    duration_sec: Math.round((Date.now() - t0) / 10) / 100,
                });
            }

            const placeholders = codes.map(() => '?').join(',');
            const [curRows] = await db.query(
                `SELECT mse.code, mse.min_stock, pad.min_stock_target
                   FROM ms_export mse
                   LEFT JOIN dg_product_analysis_decisions pad ON pad.code = mse.code
                  WHERE mse.code IN (${placeholders})`,
                codes,
            );

            const plan = [];
            for (const row of curRows || []) {
                const code = String(row.code || '');
                const cur = num(row.min_stock);
                let target;
                if (forceZero || (explicitValue != null && Number.isFinite(explicitValue))) {
                    target = forceZero ? 0 : explicitValue;
                } else if (row.min_stock_target != null) {
                    target = num(row.min_stock_target);
                } else {
                    target = 0;
                }
                if (Math.round(cur) === Math.round(target)) {
                    plan.push({ code, cur, target, skip: true });
                } else {
                    plan.push({ code, cur, target, skip: false });
                }
            }

            const toUpdate = plan.filter((p) => !p.skip);
            if (dryRun) {
                return res.json({
                    success: true,
                    dry_run: true,
                    total: plan.length,
                    to_update: toUpdate.length,
                    would_update: toUpdate.length,
                    skipped: plan.length - toUpdate.length,
                    sample: toUpdate.slice(0, 20).map((p) => ({
                        code: p.code,
                        from: p.cur,
                        to: p.target,
                    })),
                    duration_sec: Math.round((Date.now() - t0) / 10) / 100,
                });
            }

            let updated = 0;
            const errors = [];
            for (const p of toUpdate) {
                try {
                    await db.query(`UPDATE ms_export SET min_stock = ? WHERE code = ?`, [
                        p.target,
                        p.code,
                    ]);
                    await upsertProductDecision(
                        db,
                        p.code,
                        { min_stock_target: p.target },
                        req.datagonActor || null,
                        { source: 'min_stock' },
                    );
                    updated += 1;
                } catch (err) {
                    if (errors.length < 20) {
                        errors.push({ code: p.code, error: err.message || String(err) });
                    }
                }
            }
            invalidateProductAnalysisCache();
            res.json({
                success: true,
                dry_run: false,
                total: plan.length,
                to_update: toUpdate.length,
                updated,
                skipped: plan.length - toUpdate.length,
                failed: errors.length,
                errors,
                duration_sec: Math.round((Date.now() - t0) / 10) / 100,
            });
        } catch (e) {
            console.error('[product-analysis] min-stock/apply', e);
            res.status(500).json({ success: false, error: e.message || 'Ошибка' });
        }
    });

    return router;
};

module.exports.invalidateProductAnalysisCache = invalidateProductAnalysisCache;
