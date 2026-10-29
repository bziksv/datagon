'use strict';

/**
 * «Замороженная проба» на складе: остаток впервые появился, с тех пор продаж нет
 * и уровень остатка в снимках не менялся (пробная 1 шт лежит без движения).
 * Для формулы закупок: не ставить rare-минимум (2 шт), proposed = 0.
 */

const { msDemandProjectFilterClause } = require('./datagonSalesFormulaDemandFilter');

const CHUNK = 400;

/** MySQL DATE / Date / string → YYYY-MM-DD или null. */
function toYmd(v) {
    if (v == null || v === '') return null;
    if (v instanceof Date && !Number.isNaN(v.getTime())) {
        const y = v.getFullYear();
        const m = String(v.getMonth() + 1).padStart(2, '0');
        const d = String(v.getDate()).padStart(2, '0');
        return `${y}-${m}-${d}`;
    }
    const s = String(v).trim();
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
    const t = Date.parse(s);
    if (!Number.isNaN(t)) return toYmd(new Date(t));
    return null;
}

/**
 * @param {object} p
 * @param {number} p.stockQty — текущий остаток (ms_export.stock)
 * @param {string|null} p.firstPositiveDate — YYYY-MM-DD
 * @param {number|null} p.stockMinPos — min(stock) только по дням stock>0
 * @param {number|null} p.stockMaxPos — max(stock) только по дням stock>0
 * @param {number} p.salesSinceFirst
 */
function isStagnantTrialStock(p) {
    const stockQty = Number(p && p.stockQty);
    if (!Number.isFinite(stockQty) || stockQty <= 1e-9) return false;
    const first = p && p.firstPositiveDate != null ? String(p.firstPositiveDate).trim().slice(0, 10) : '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(first)) return false;
    const sales = Number(p && p.salesSinceFirst);
    if (Number.isFinite(sales) && sales > 1e-9) return false;
    // «Не менялся» — по дням с положительным остатком (нули в снимках = отсутствие, не дозаказ).
    const smin = Number(p && (p.stockMinPos != null ? p.stockMinPos : p.stockMin));
    const smax = Number(p && (p.stockMaxPos != null ? p.stockMaxPos : p.stockMax));
    if (!Number.isFinite(smin) || !Number.isFinite(smax)) return false;
    if (Math.abs(smin - smax) > 1e-6) return false;
    if (smin <= 1e-9) return false;
    if (Math.abs(stockQty - smin) > 1e-6) return false;
    return true;
}

/**
 * Профиль снимков + продажи с даты первого положительного остатка (те же проекты, что у формулы).
 * @returns {Promise<Map<string, { first_positive_date: string|null, stock_min: number|null, stock_max: number|null, sales_since_first: number }>>}
 */
async function loadStockStagnancyProfilesByCodes(db, codes, appSettings) {
    const map = new Map();
    const uniq = [...new Set((codes || []).map((c) => String(c || '').trim()).filter(Boolean))];
    if (!uniq.length || !db) return map;

    const proj = msDemandProjectFilterClause(appSettings || {});

    for (let i = 0; i < uniq.length; i += CHUNK) {
        const part = uniq.slice(i, i + CHUNK);
        const ph = part.map(() => '?').join(',');
        const [snapRows] = await db.query(
            `SELECT code,
                    MIN(CASE WHEN stock > 0 THEN ts_date END) AS first_pos,
                    MIN(CASE WHEN stock > 0 THEN stock END) AS smin_pos,
                    MAX(CASE WHEN stock > 0 THEN stock END) AS smax_pos
               FROM dg_product_stock_snapshot
              WHERE code IN (${ph})
              GROUP BY code`,
            part,
        );
        const firstByCode = new Map();
        for (const row of snapRows || []) {
            const code = String(row.code || '').trim();
            if (!code) continue;
            const firstPos = toYmd(row.first_pos);
            const smin = row.smin_pos != null && row.smin_pos !== '' ? Number(row.smin_pos) : null;
            const smax = row.smax_pos != null && row.smax_pos !== '' ? Number(row.smax_pos) : null;
            firstByCode.set(code, {
                first_positive_date: firstPos,
                stock_min: Number.isFinite(smin) ? smin : null,
                stock_max: Number.isFinite(smax) ? smax : null,
                stock_min_pos: Number.isFinite(smin) ? smin : null,
                stock_max_pos: Number.isFinite(smax) ? smax : null,
                sales_since_first: 0,
            });
        }

        const withFirst = [...firstByCode.entries()].filter(([, v]) => v.first_positive_date);
        if (withFirst.length) {
            // Продажи с first_pos: join снимка-даты и отгрузок (проекты формулы).
            const codesWithFp = withFirst.map(([c]) => c);
            const ph2 = codesWithFp.map(() => '?').join(',');
            // Важно: SUM только по строкам, где JOIN к ms_demand прошёл фильтр
            // (момент ≥ first_pos + проекты). Иначе LEFT JOIN тянет старые отгрузки
            // до появления на складе и ломает «замороженную пробу» (как у 31288).
            const [salesRows] = await db.query(
                `SELECT snap.code AS code,
                        COALESCE(SUM(CASE WHEN d.uuid IS NOT NULL THEN p.quantity ELSE 0 END), 0) AS sales_since
                   FROM (
                        SELECT code, MIN(CASE WHEN stock > 0 THEN ts_date END) AS first_pos
                          FROM dg_product_stock_snapshot
                         WHERE code IN (${ph2})
                         GROUP BY code
                    ) snap
                   LEFT JOIN ms_demand_position p
                     ON p.ms_export_code = snap.code
                   LEFT JOIN ms_demand d
                     ON d.uuid = p.demand_uuid
                    AND d.applicable = 1
                    AND snap.first_pos IS NOT NULL
                    AND d.moment >= snap.first_pos
                    ${proj.sql ? proj.sql.replace(/^\s*AND/, 'AND') : ''}
                  GROUP BY snap.code`,
                [...codesWithFp, ...proj.params],
            );
            for (const row of salesRows || []) {
                const code = String(row.code || '').trim();
                const hit = firstByCode.get(code);
                if (!hit) continue;
                const q = Number(row.sales_since || 0);
                hit.sales_since_first = Number.isFinite(q) ? q : 0;
            }
        }

        for (const [code, prof] of firstByCode) {
            map.set(code, prof);
        }
        for (const code of part) {
            if (!map.has(code)) {
                map.set(code, {
                    first_positive_date: null,
                    stock_min: null,
                    stock_max: null,
                    stock_min_pos: null,
                    stock_max_pos: null,
                    sales_since_first: 0,
                });
            }
        }
    }
    return map;
}

module.exports = {
    isStagnantTrialStock,
    loadStockStagnancyProfilesByCodes,
};
