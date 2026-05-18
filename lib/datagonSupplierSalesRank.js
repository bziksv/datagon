'use strict';

const {
    salesBySupplierSubquery,
    catalogBySupplierSubquery,
} = require('./datagonSupplierAnalysisSql');
const { msDemandProjectFilterFromQuery } = require('./datagonSalesFormulaDemandFilter');

/** Период рейтинга продаж (дней), как на `/supplier-analysis.html` по умолчанию. */
const SUPPLIER_SALES_RANK_DAYS = 90;

const rankMapCache = new Map();
const RANK_MAP_CACHE_TTL_MS = 90 * 1000;

function clampRankDays(days) {
    const n = parseInt(days, 10);
    if (!Number.isFinite(n)) return SUPPLIER_SALES_RANK_DAYS;
    return Math.min(365, Math.max(7, n));
}

/**
 * Место поставщика в рейтинге по выручке за период (сортировка: sales_revenue DESC, затем supplier_key).
 * @returns {Promise<{ map: Map<string, { rank: number, total: number, sales_revenue: number }>, days: number, total: number }>}
 */
async function loadSupplierSalesRankMap(db, options = {}) {
    const days = clampRankDays(options.days);
    const pf = msDemandProjectFilterFromQuery(options.projectQuery || { project_mode: 'all' });
    const cacheKey = `v1:${days}:${pf.fingerprint}`;
    const hit = rankMapCache.get(cacheKey);
    if (hit && Date.now() - hit.ts < RANK_MAP_CACHE_TTL_MS) {
        return hit.payload;
    }

    const newStockDays = 30;
    const curSql = salesBySupplierSubquery(
        'd.moment >= DATE_SUB(NOW(), INTERVAL ? DAY)',
        pf.sql,
    );
    const catalogSql = catalogBySupplierSubquery(newStockDays);
    const innerSql = `
        SELECT c.supplier_key, COALESCE(cur.sales_revenue, 0) AS sales_revenue
          FROM (${catalogSql}) c
          LEFT JOIN (${curSql}) cur ON cur.supplier_key = c.supplier_key`;

    const [rawRows] = await db.query(
        `SELECT supplier_key, sales_revenue FROM (${innerSql}) ranked`,
        [...pf.params, days],
    );

    const sorted = (rawRows || []).slice().sort((a, b) => {
        const diff = Number(b.sales_revenue) - Number(a.sales_revenue);
        if (diff !== 0) return diff;
        return String(a.supplier_key || '').localeCompare(String(b.supplier_key || ''), 'ru');
    });

    const map = new Map();
    const total = sorted.length;
    sorted.forEach((r, i) => {
        const key = String(r.supplier_key || '').trim();
        if (!key) return;
        map.set(key, {
            rank: i + 1,
            total,
            sales_revenue: Number(r.sales_revenue) || 0,
        });
    });

    const payload = { map, days, total };
    rankMapCache.set(cacheKey, { ts: Date.now(), payload });
    if (rankMapCache.size > 20) {
        const cut = Date.now() - RANK_MAP_CACHE_TTL_MS * 2;
        for (const [k, v] of rankMapCache.entries()) {
            if (!v || v.ts < cut) rankMapCache.delete(k);
        }
    }
    return payload;
}

function invalidateSupplierSalesRankCache() {
    rankMapCache.clear();
}

/**
 * LEFT JOIN выручки отгрузок МС за N дней (для сортировки списка поставщиков).
 * @param {string} [aggAlias]
 * @param {number} [days]
 * @param {object} [projectQuery]
 */
function sqlSalesRevenue90Join(aggAlias = 'agg', days = SUPPLIER_SALES_RANK_DAYS, projectQuery) {
    const agg = String(aggAlias || 'agg').replace(/[^a-zA-Z0-9_]/g, '') || 'agg';
    const d = clampRankDays(days);
    const pf = msDemandProjectFilterFromQuery(projectQuery || { project_mode: 'all' });
    const curSql = salesBySupplierSubquery(
        'd.moment >= DATE_SUB(NOW(), INTERVAL ? DAY)',
        pf.sql,
    );
    return {
        joinSql: `LEFT JOIN (${curSql}) sales90 ON sales90.supplier_key = ${agg}.supplier_key`,
        params: [...pf.params, d],
    };
}

module.exports = {
    SUPPLIER_SALES_RANK_DAYS,
    loadSupplierSalesRankMap,
    invalidateSupplierSalesRankCache,
    sqlSalesRevenue90Join,
};
