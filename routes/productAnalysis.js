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
 * GET  /api/product-analysis/playbook/meta
 * GET  /api/product-analysis/playbook/:code
 * POST /api/product-analysis/playbook/:code
 * POST /api/product-analysis/:code/comments
 * PATCH /api/product-analysis/:code/comments/:commentId
 * DELETE /api/product-analysis/:code/comments/:commentId
 */

const express = require('express');
const { msDemandProjectFilterFromQuery } = require('../lib/datagonSalesFormulaDemandFilter');
const {
    salesByCodeSubquery,
    catalogByCodeSql,
    productRankingSelectSql,
    productSalesQueryParams,
    hydrateDaysOnStockForCodes,
    hydrateDaysOnStockForCodesChunked,
    keepCodeForNewStockPostFilter,
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
    attachProductComments,
    addProductComment,
    updateProductComment,
    deleteProductComment,
    loadCommentsByCodes,
    DEFAULT_BOOST_DAYS,
} = require('../lib/datagonProductAnalysisDecisions');
const {
    playbookMeta,
    handlePlaybookAction,
    loadPlaybook,
    cellModel,
    suggestScenario,
    todayYmdMoscow,
    withPhase,
    salesWindowsSql,
    lifetimeSalesSql,
    periodSalesSql,
    ensurePlaybookSchema,
} = require('../lib/datagonProductAnalysisPlaybook');

const CACHE_TTL_MS = 60 * 1000;
const CACHE_VER = 'pa9';
/** Потолок кандидатов для post-filter новинок без полного snap-join. */
const NEW_STOCK_POSTFILTER_CAP = 50000;
const responseCache = new Map();

const PLAYBOOK_COLS = `
    pb.scenario AS playbook_scenario,
    pb.status AS playbook_status,
    pb.step_index AS playbook_step_index,
    pb.steps_json AS playbook_steps_json,
    pb.review_due AS playbook_review_due,
    pb.expiry_date AS playbook_expiry_date`;

function playbookFromSql(selectSql, whereExtra) {
    return `FROM (${selectSql}) r
            LEFT JOIN dg_product_analysis_playbook pb ON pb.code = r.code
            WHERE 1=1 ${whereExtra}`;
}

function playbookStateFromRankingRow(r) {
    let steps = [];
    try {
        const parsed = typeof r.playbook_steps_json === 'string'
            ? JSON.parse(r.playbook_steps_json)
            : r.playbook_steps_json;
        steps = Array.isArray(parsed) ? parsed : [];
    } catch (_e) {
        steps = [];
    }
    return {
        scenario: r.playbook_scenario || null,
        status: r.playbook_status || null,
        step_index: r.playbook_step_index,
        steps,
        review_due: r.playbook_review_due,
        expiry_date: r.playbook_expiry_date,
    };
}

function pageMode(req) {
    const actor = req && req.datagonActor;
    if (!actor) return 'hidden';
    if (actor.username === 'admin') return 'full';
    const raw = actor.page_modes && actor.page_modes['product-analysis'];
    // F-OPS-05: нет ключа в матрице → hidden (не full).
    return raw === 'view' || raw === 'partial' || raw === 'hidden' || raw === 'full' ? raw : 'hidden';
}

function canWrite(req) {
    return pageMode(req) === 'full';
}

function actorUserId(req) {
    const id = req && req.datagonActor && req.datagonActor.id;
    const n = Number(id);
    return Number.isFinite(n) && n > 0 ? n : null;
}

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
        playbook_cell: cellModel(playbookStateFromRankingRow(r), todayYmdMoscow()),
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

    /** 'only' | 'exclude' | null — без SQL по first_positive (тяжёлый snap-join). */
    let postFilterNewOnStock = null;
    if (preset === 'new_on_stock') {
        whereExtra += ` AND COALESCE(r.stock_qty, 0) > 0 `;
        postFilterNewOnStock = 'only';
    } else {
        whereExtra += presetWhereSql(preset);
        if (
            excludeNew &&
            (preset === 'dead' || preset === 'stuck' || preset === 'dead_min_stock')
        ) {
            postFilterNewOnStock = 'exclude';
        }
    }

    const playbookRaw = String((src && src.playbook) || '');
    const playbookScenarios = new Set(['had_sales', 'never_sold', 'slow', 'expiry']);
    let playbookKey = 'any';
    if (playbookRaw === 'due') {
        whereExtra += ` AND pb.status = 'active' AND pb.review_due IS NOT NULL AND pb.review_due <= CURDATE() `;
        playbookKey = 'due';
    } else if (playbookRaw === 'none') {
        whereExtra += ` AND pb.scenario IS NULL `;
        playbookKey = 'none';
    } else if (playbookScenarios.has(playbookRaw)) {
        whereExtra += ` AND pb.scenario = ? `;
        filterParams.push(playbookRaw);
        playbookKey = playbookRaw;
    }

    return {
        search,
        supplier,
        manager,
        lifecycle,
        preset,
        new_stock_days: newStockDays,
        exclude_new_on_stock: excludeNew,
        postFilterNewOnStock,
        whereExtra,
        filterParams,
        cacheKeyPart: `${search}:${supplier}:${manager}:${lifecycle}:${preset}:ns${newStockDays}:ex${excludeNew ? 1 : 0}:pb${playbookKey}`,
    };
}

/**
 * Догрузить дни на складе и отфильтровать новинки (exclude/only).
 * @returns {{ rows: object[], snapMap: Map, truncated: boolean }}
 */
async function applyNewStockPostFilter(db, rows, mode, newStockDays) {
    const list = Array.isArray(rows) ? rows : [];
    if (!mode || !list.length) {
        return { rows: list, snapMap: new Map(), truncated: false };
    }
    const lookback = Math.max(Number(newStockDays) + 30, 365);
    const snapMap = await hydrateDaysOnStockForCodesChunked(
        db,
        list.map((r) => (r && (r.code != null ? r.code : r.catalog_code)) || ''),
        lookback,
    );
    const filtered = list.filter((r) => {
        const code = String((r && (r.code != null ? r.code : r.catalog_code)) || '');
        return keepCodeForNewStockPostFilter(mode, snapMap.get(code), newStockDays);
    });
    return { rows: filtered, snapMap, truncated: false };
}

function mergeSnapIntoMappedRow(r, snapMap) {
    const hit = snapMap && snapMap.get(r.code);
    if (!hit) return r;
    return Object.assign({}, r, {
        first_positive_date: hit.first_positive_date,
        days_on_stock: hit.days_on_stock,
    });
}

module.exports = function productAnalysisRouterFactory(db, _appSettings) {
    const router = express.Router();

    router.get('/presets', async (_req, res) => {
        res.json({
            success: true,
            presets: PRESETS,
            lifecycles: [
                'none',
                'top',
                'hold',
                'boost',
                'boost_failed',
                'infographic',
                'clearance',
                'exit',
            ],
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
            await ensurePlaybookSchema(db);
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
                    comments: (await loadCommentsByCodes(db, [code], actorUserId(req)))[code] || [],
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
            await ensurePlaybookSchema(db);
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
            const postMode = flt.postFilterNewOnStock;

            let t;
            if (postMode) {
                const [cand] = await db.query(
                    `SELECT
                        r.code,
                        COALESCE(r.sales_revenue, 0) AS sales_revenue,
                        COALESCE(r.sales_revenue_prev, 0) AS sales_revenue_prev,
                        COALESCE(r.sales_qty, 0) AS sales_qty,
                        COALESCE(r.gross_margin_est, 0) AS gross_margin_est,
                        COALESCE(r.stock_value_rub, 0) AS stock_value_rub,
                        COALESCE(r.min_stock, 0) AS min_stock,
                        COALESCE(r.stock_qty, 0) AS stock_qty,
                        r.lifecycle,
                        COALESCE(r.do_not_order, 0) AS do_not_order
                     ${playbookFromSql(selectSql, whereExtra)}
                     LIMIT ${NEW_STOCK_POSTFILTER_CAP}`,
                    params,
                );
                const { rows: kept } = await applyNewStockPostFilter(
                    db,
                    cand || [],
                    postMode,
                    flt.new_stock_days,
                );
                t = {
                    skus_total: kept.length,
                    sales_revenue: 0,
                    sales_revenue_prev: 0,
                    sales_qty: 0,
                    gross_margin_est: 0,
                    stock_value_rub: 0,
                    min_stock_sum: 0,
                    dead_with_stock: 0,
                    dead_with_min_stock: 0,
                    in_boost: 0,
                    in_exit_path: 0,
                    do_not_order_count: 0,
                };
                kept.forEach((r) => {
                    t.sales_revenue += num(r.sales_revenue);
                    t.sales_revenue_prev += num(r.sales_revenue_prev);
                    t.sales_qty += num(r.sales_qty);
                    t.gross_margin_est += num(r.gross_margin_est);
                    t.stock_value_rub += num(r.stock_value_rub);
                    t.min_stock_sum += num(r.min_stock);
                    if (num(r.sales_qty) <= 0 && num(r.stock_qty) > 0) t.dead_with_stock += 1;
                    if (num(r.sales_qty) <= 0 && num(r.min_stock) > 0) t.dead_with_min_stock += 1;
                    if (String(r.lifecycle || '') === 'boost') t.in_boost += 1;
                    if (r.lifecycle === 'clearance' || r.lifecycle === 'exit') t.in_exit_path += 1;
                    if (num(r.do_not_order) === 1) t.do_not_order_count += 1;
                });
            } else {
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
                ${playbookFromSql(selectSql, whereExtra)}`;

                const [rows] = await db.query(sql, params);
                t = rows && rows[0] ? rows[0] : {};
            }
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
            await ensurePlaybookSchema(db);
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
            const actorId = actorUserId(req);
            if (cached) {
                const rows = await attachProductComments(db, cached.rows || [], actorId);
                return res.json({
                    ...cached,
                    rows,
                    can_write: canWrite(req),
                    actor_user_id: actorId,
                    cache: { hit: true },
                });
            }

            const needSnap = rankingNeedsSnapJoin(flt, sortBy);
            const needPrev = sortBy === 'revenue_change_pct';
            const postMode = flt.postFilterNewOnStock;
            const { selectSql, baseParams, snapLookback } = buildRankingFromSql(days, pf, {
                newStockDays: flt.new_stock_days,
                includeSnap: needSnap,
                includePrev: needPrev,
            });
            const whereExtra = flt.whereExtra;
            const filterParams = [...baseParams, ...flt.filterParams];
            const orderCol = RANKING_SORT.has(sortBy) ? sortBy : 'sales_revenue';

            let total = 0;
            let mapped = [];
            let snapJoined = needSnap;
            let usedPostFilter = Boolean(postMode);

            if (postMode) {
                const [allRows] = await db.query(
                    `SELECT r.*, ${PLAYBOOK_COLS}
                      ${playbookFromSql(selectSql, whereExtra)}
                      ORDER BY r.\`${orderCol}\` ${sortDir}, r.code ASC
                      LIMIT ${NEW_STOCK_POSTFILTER_CAP}`,
                    filterParams,
                );
                let candidates = (allRows || []).map(mapRankingRow);
                const { rows: kept, snapMap } = await applyNewStockPostFilter(
                    db,
                    candidates,
                    postMode,
                    flt.new_stock_days,
                );
                total = kept.length;
                mapped = kept
                    .slice(offset, offset + limit)
                    .map((r) => mergeSnapIntoMappedRow(r, snapMap));
            } else {
                const [countRows] = await db.query(
                    `SELECT COUNT(*) AS cnt ${playbookFromSql(selectSql, whereExtra)}`,
                    filterParams,
                );
                total = num(countRows && countRows[0] ? countRows[0].cnt : 0);

                const [rows] = await db.query(
                    `SELECT r.*, ${PLAYBOOK_COLS}
                      ${playbookFromSql(selectSql, whereExtra)}
                      ORDER BY r.\`${orderCol}\` ${sortDir}, r.code ASC
                      LIMIT ? OFFSET ?`,
                    [...filterParams, limit, offset],
                );

                mapped = (rows || []).map(mapRankingRow);
                if (!needSnap && mapped.length) {
                    const snapMap = await hydrateDaysOnStockForCodes(
                        db,
                        mapped.map((r) => r.code),
                        Math.max(flt.new_stock_days + 30, 365),
                    );
                    mapped = mapped.map((r) => mergeSnapIntoMappedRow(r, snapMap));
                }
            }

            mapped = await attachProductComments(db, mapped, actorId);

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
                can_write: canWrite(req),
                actor_user_id: actorId,
                perf: {
                    snap_joined: snapJoined,
                    snap_lookback: snapJoined ? snapLookback : 0,
                    prev_period: needPrev,
                    new_stock_postfilter: usedPostFilter,
                },
            };
            // В кэш — без comments (can_edit зависит от актора); comments дописываем при отдаче.
            cacheSet(cacheKey, {
                ...payload,
                rows: mapped.map((r) => {
                    const copy = Object.assign({}, r);
                    delete copy.comments;
                    return copy;
                }),
            });
            res.json(payload);
        } catch (e) {
            console.error('[product-analysis] ranking', e);
            res.status(500).json({ success: false, error: e.message || 'Ошибка' });
        }
    });

    router.get('/export', async (req, res) => {
        try {
            await ensureProductAnalysisDecisionsSchema(db);
            await ensurePlaybookSchema(db);
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
            const postMode = flt.postFilterNewOnStock;
            const exportCap = postMode ? Math.min(20000, NEW_STOCK_POSTFILTER_CAP) : 20000;
            const [rawRows] = await db.query(
                `SELECT r.*, ${PLAYBOOK_COLS}
                  ${playbookFromSql(selectSql, whereExtra)}
                  ORDER BY r.sales_revenue DESC, r.code ASC LIMIT ${exportCap}`,
                filterParams,
            );
            let rows = rawRows || [];
            if (postMode && rows.length) {
                const filtered = await applyNewStockPostFilter(
                    db,
                    rows.map(mapRankingRow),
                    postMode,
                    flt.new_stock_days,
                );
                rows = filtered.rows;
            }
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
                const r = raw && raw.code != null && raw.name != null ? raw : mapRankingRow(raw);
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
            else if (action === 'infographic') patch.lifecycle = 'infographic';
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
            await ensurePlaybookSchema(db);
            if (!canWrite(req)) {
                return res.status(403).json({ success: false, error: 'Режим только просмотра', code: 'PAGE_VIEW_ONLY' });
            }
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

    async function commentsForCodeResponse(code, actorId) {
        const byCode = await loadCommentsByCodes(db, [code], actorId);
        const comments = byCode[code] || [];
        return {
            comments,
            decision_note: comments[0] && comments[0].body ? String(comments[0].body).slice(0, 500) : null,
        };
    }

    router.get('/playbook/meta', (_req, res) => {
        res.json({ success: true, ...playbookMeta() });
    });

    router.get('/playbook/:code', async (req, res) => {
        try {
            await ensurePlaybookSchema(db);
            const code = String(req.params.code || '').trim();
            const today = todayYmdMoscow();
            const days = clampInt(req.query.days, 7, 365, 90);
            const state = withPhase(await loadPlaybook(db, code), today);
            const [lifeRows] = await db.query(lifetimeSalesSql(), [code]);
            const [winRows] = await db.query(salesWindowsSql(), [code]);
            const [periodRows] = await db.query(periodSalesSql(), [code, days]);
            const [stockRows] = await db.query(
                `SELECT COALESCE(stock, 0) AS stock_qty FROM ms_export WHERE code = ? LIMIT 1`,
                [code],
            );
            const win = winRows && winRows[0] ? winRows[0] : {};
            const periodQty = num(periodRows && periodRows[0] && periodRows[0].qty);
            const suggestion = suggestScenario({
                lifetimeSales: Boolean(lifeRows && lifeRows[0]),
                periodSalesQty: periodQty,
                stockQty: num(stockRows && stockRows[0] && stockRows[0].stock_qty),
                salesQty90: num(win.d90),
                expiryDate: state.expiry_date,
                today,
            });
            res.json({
                success: true,
                can_write: canWrite(req),
                suggestion,
                sales: { d30: num(win.d30), d60: num(win.d60), d90: num(win.d90) },
                state,
                cell: cellModel(state, today),
            });
        } catch (e) {
            console.error('[product-analysis] playbook get', e);
            res.status(500).json({ success: false, error: e.message || 'Ошибка' });
        }
    });

    router.post('/playbook/:code', express.json({ limit: '64kb' }), async (req, res) => {
        try {
            if (!canWrite(req)) return res.status(403).json({ success: false, error: 'Недостаточно прав' });
            const result = await handlePlaybookAction(db, req.params.code, req.body || {}, req.datagonActor || null, {
                today: todayYmdMoscow,
                upsertProductDecision,
            });
            if (!result.ok) return res.status(result.status).json({ success: false, error: result.error });
            res.json(result.payload);
        } catch (e) {
            console.error('[product-analysis] playbook post', e);
            res.status(500).json({ success: false, error: e.message || 'Ошибка' });
        }
    });

    router.post('/:code/comments', express.json({ limit: '32kb' }), async (req, res) => {
        try {
            if (!canWrite(req)) {
                return res.status(403).json({ success: false, error: 'Режим только просмотра', code: 'PAGE_VIEW_ONLY' });
            }
            const code = decodeURIComponent(String(req.params.code || '')).trim();
            const comment = await addProductComment(
                db,
                code,
                req.body && req.body.body,
                req.datagonActor || null,
            );
            invalidateProductAnalysisCache();
            const pack = await commentsForCodeResponse(code, actorUserId(req));
            res.json({ success: true, comment, ...pack });
        } catch (e) {
            const status = e && e.status ? e.status : 400;
            res.status(status).json({ success: false, error: e.message || 'Ошибка комментария' });
        }
    });

    router.patch('/:code/comments/:commentId', express.json({ limit: '32kb' }), async (req, res) => {
        try {
            if (!canWrite(req)) {
                return res.status(403).json({ success: false, error: 'Режим только просмотра', code: 'PAGE_VIEW_ONLY' });
            }
            const code = decodeURIComponent(String(req.params.code || '')).trim();
            const comment = await updateProductComment(
                db,
                code,
                req.params.commentId,
                req.body && req.body.body,
                req.datagonActor || null,
            );
            invalidateProductAnalysisCache();
            const pack = await commentsForCodeResponse(code, actorUserId(req));
            res.json({ success: true, comment, ...pack });
        } catch (e) {
            const status = e && e.status ? e.status : 400;
            res.status(status).json({ success: false, error: e.message || 'Ошибка комментария' });
        }
    });

    router.delete('/:code/comments/:commentId', async (req, res) => {
        try {
            if (!canWrite(req)) {
                return res.status(403).json({ success: false, error: 'Режим только просмотра', code: 'PAGE_VIEW_ONLY' });
            }
            const code = decodeURIComponent(String(req.params.code || '')).trim();
            await deleteProductComment(db, code, req.params.commentId, req.datagonActor || null);
            invalidateProductAnalysisCache();
            const pack = await commentsForCodeResponse(code, actorUserId(req));
            res.json({ success: true, ...pack });
        } catch (e) {
            const status = e && e.status ? e.status : 400;
            res.status(status).json({ success: false, error: e.message || 'Ошибка удаления' });
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
            // F-PUR-02: явный canWrite + cap codes[] + confirm на запись.
            if (!canWrite(req)) {
                return res.status(403).json({
                    success: false,
                    error: 'Режим только просмотра',
                    code: 'PAGE_VIEW_ONLY',
                });
            }
            await ensureProductAnalysisDecisionsSchema(db);
            await ensurePlaybookSchema(db);
            const body = req.body && typeof req.body === 'object' ? req.body : {};
            const dryRun = body.dry_run === true || body.dry_run === 1 || body.dry_run === '1';
            if (
                !dryRun &&
                body.confirm !== true &&
                body.confirm !== 1 &&
                body.confirm !== '1'
            ) {
                return res.status(400).json({
                    success: false,
                    error: 'Нужно confirm: true (или dry_run: true для preflight)',
                    code: 'CONFIRM_REQUIRED',
                });
            }
            const patch = patchFromBody(body);
            if (!Object.keys(patch).length) {
                return res.status(400).json({ success: false, error: 'Нет полей для обновления' });
            }
            const patchFields = describePatchFields(patch);

            let codes = [];
            if (Array.isArray(body.codes) && body.codes.length) {
                codes = body.codes
                    .map((c) => String(c || '').trim())
                    .filter(Boolean)
                    .slice(0, 5000);
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
                const postMode = flt.postFilterNewOnStock;
                const fetchLimit = postMode
                    ? Math.min(NEW_STOCK_POSTFILTER_CAP, Math.max(maxRows * 20, maxRows))
                    : maxRows;
                const [rows] = await db.query(
                    `SELECT r.code ${playbookFromSql(selectSql, whereExtra)} LIMIT ?`,
                    [...filterParams, fetchLimit],
                );
                let cand = (rows || []).map((r) => ({ code: String(r.code || '').trim() }));
                if (postMode) {
                    const filtered = await applyNewStockPostFilter(
                        db,
                        cand,
                        postMode,
                        flt.new_stock_days,
                    );
                    cand = filtered.rows;
                }
                codes = cand
                    .map((r) => String(r.code || '').trim())
                    .filter(Boolean)
                    .slice(0, maxRows);
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
            await ensurePlaybookSchema(db);
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
                const postMode = flt.postFilterNewOnStock;
                const fetchLimit = postMode
                    ? Math.min(NEW_STOCK_POSTFILTER_CAP, Math.max(maxRows * 20, maxRows))
                    : maxRows;
                const [rows] = await db.query(
                    `SELECT r.code, r.min_stock, r.min_stock_target
                       ${playbookFromSql(selectSql, whereExtra)} LIMIT ?`,
                    [...filterParams, fetchLimit],
                );
                let cand = rows || [];
                if (postMode) {
                    const filtered = await applyNewStockPostFilter(
                        db,
                        cand,
                        postMode,
                        flt.new_stock_days,
                    );
                    cand = filtered.rows;
                }
                codes = cand
                    .map((r) => String(r.code || '').trim())
                    .filter(Boolean)
                    .slice(0, maxRows);
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
