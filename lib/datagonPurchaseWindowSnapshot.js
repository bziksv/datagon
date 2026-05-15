'use strict';

/**
 * Колонки закупок d_15a/d_15b … d_365a/d_365b — тот же расчёт, что в `routes/purchase.js` → `enrichPurchaseRowsWithFormula`
 * (суммы по окнам из `ms_demand` + эквивалент через комплекты, «дн. нет» из `dg_product_zero_stock_log`).
 * Вызывается с карточки товара после прогрева составов комплектов; результат кладётся в `dg_formula_proposed_cache.windows_json`.
 *
 * Требует заранее вызванные на пуле `ensureZeroStockSchema` / `ensureBundleComponentsSchema` (как на `GET /api/product/:code`).
 */

const PURCHASE_CODES_SQL_CHUNK = 400;

const PU_SNAPSHOT_SALES_DAYS = [3, 5, 7, 15, 30, 60, 90, 180, 365];

const D_PURCHASE_WINDOW_KEYS = [
    ['d_15a', 'd_15b', 15],
    ['d_30a', 'd_30b', 30],
    ['d_60a', 'd_60b', 60],
    ['d_90a', 'd_90b', 90],
    ['d_180a', 'd_180b', 180],
    ['d_365a', 'd_365b', 365],
];

function buildWindowSumSelectSql(qtyExpr) {
    return PU_SNAPSHOT_SALES_DAYS.map(
        (w) =>
            `COALESCE(SUM(CASE WHEN d.moment >= (NOW() - INTERVAL ${w} DAY) THEN (${qtyExpr}) ELSE 0 END), 0) AS w${w}`,
    ).join(',\n            ');
}

function safeMsCodeForLike(code) {
    const s = String(code || '').trim();
    if (!/^[A-Za-z0-9_.-]+$/u.test(s)) return '';
    return s;
}

function isMsBundleType(typeRaw) {
    return String(typeRaw || '').toLowerCase().includes('комплект');
}

async function loadDirectSalesWindowsMap(db, codes) {
    const map = new Map();
    if (!codes.length) return map;
    const uniq = [...new Set(codes.map((c) => String(c || '').trim()).filter(Boolean))];
    const sums = buildWindowSumSelectSql('CAST(p.quantity AS DECIMAL(18,6))');
    for (let i = 0; i < uniq.length; i += PURCHASE_CODES_SQL_CHUNK) {
        const part = uniq.slice(i, i + PURCHASE_CODES_SQL_CHUNK);
        const ph = part.map(() => '?').join(',');
        const [rows] = await db.query(
            `SELECT p.ms_export_code AS code,
                ${sums}
               FROM ms_demand_position p
               INNER JOIN ms_demand d ON d.uuid = p.demand_uuid
              WHERE d.applicable = 1
                AND p.ms_export_code IN (${ph})
              GROUP BY p.ms_export_code`,
            [...part],
        );
        for (const r of rows || []) {
            const k = String(r.code || '').trim();
            if (k) map.set(k, r);
        }
    }
    return map;
}

async function loadBundleSalesWindowsMap(db, componentCodes) {
    const map = new Map();
    if (!componentCodes.length) return map;
    const uniq = [...new Set(componentCodes.map((c) => String(c || '').trim()).filter(Boolean))];
    const sums = buildWindowSumSelectSql('CAST(p.quantity * bc.qty_per_bundle AS DECIMAL(18,6))');
    for (let i = 0; i < uniq.length; i += PURCHASE_CODES_SQL_CHUNK) {
        const part = uniq.slice(i, i + PURCHASE_CODES_SQL_CHUNK);
        const ph = part.map(() => '?').join(',');
        const [rows] = await db.query(
            `SELECT bc.component_code AS code,
                ${sums}
               FROM ms_demand_position p
               INNER JOIN ms_demand d ON d.uuid = p.demand_uuid
               INNER JOIN dg_bundle_components bc ON bc.bundle_code = p.ms_export_code AND bc.component_code IN (${ph})
              WHERE d.applicable = 1
              GROUP BY bc.component_code`,
            [...part],
        );
        for (const r of rows || []) {
            const k = String(r.code || '').trim();
            if (k) map.set(k, r);
        }
    }
    return map;
}

async function loadAbsenceDistinctDaysAggregateMap(db, codes) {
    const map = new Map();
    if (!codes.length) return map;
    const uniq = [...new Set(codes.map((c) => String(c || '').trim()).filter(Boolean))];
    for (let i = 0; i < uniq.length; i += PURCHASE_CODES_SQL_CHUNK) {
        const part = uniq.slice(i, i + PURCHASE_CODES_SQL_CHUNK);
        const ph = part.map(() => '?').join(',');
        const [rows] = await db.query(
            `SELECT code,
                    COUNT(DISTINCT CASE WHEN ts_date >= (CURDATE() - INTERVAL 15 DAY) THEN ts_date END) AS d15,
                    COUNT(DISTINCT CASE WHEN ts_date >= (CURDATE() - INTERVAL 30 DAY) THEN ts_date END) AS d30,
                    COUNT(DISTINCT CASE WHEN ts_date >= (CURDATE() - INTERVAL 60 DAY) THEN ts_date END) AS d60,
                    COUNT(DISTINCT CASE WHEN ts_date >= (CURDATE() - INTERVAL 90 DAY) THEN ts_date END) AS d90,
                    COUNT(DISTINCT CASE WHEN ts_date >= (CURDATE() - INTERVAL 180 DAY) THEN ts_date END) AS d180,
                    COUNT(DISTINCT CASE WHEN ts_date >= (CURDATE() - INTERVAL 365 DAY) THEN ts_date END) AS d365
               FROM dg_product_zero_stock_log
              WHERE ts_date >= (CURDATE() - INTERVAL 365 DAY)
                AND code IN (${ph})
              GROUP BY code`,
            [...part],
        );
        for (const r of rows || []) {
            const k = String(r.code || '').trim();
            if (!k) continue;
            map.set(k, {
                15: Number(r.d15 || 0),
                30: Number(r.d30 || 0),
                60: Number(r.d60 || 0),
                90: Number(r.d90 || 0),
                180: Number(r.d180 || 0),
                365: Number(r.d365 || 0),
            });
        }
    }
    return map;
}

function absenceAggDays(absMultiMap, codeKey, days) {
    const o = absMultiMap.get(codeKey);
    if (!o) return 0;
    const n = o[days];
    return Number.isFinite(n) ? n : 0;
}

function sumWindowQty(dirWinMap, bunWinMap, codeStr, isBundleRow, w) {
    const k = `w${w}`;
    const dr = dirWinMap.get(codeStr);
    const br = !isBundleRow ? bunWinMap.get(codeStr) : null;
    const a = dr && dr[k] != null ? Number(dr[k]) : 0;
    const b = br && br[k] != null ? Number(br[k]) : 0;
    const s = a + b;
    return Number.isFinite(s) ? s : 0;
}

/**
 * @param {import('mysql2/promise').Pool} db
 * @param {Array<{ code: string, type?: string }>} items
 * @returns {Promise<Map<string, Record<string, number>>>}
 */
async function computePurchaseWindowSnapshotForItems(db, items) {
    const out = new Map();
    if (!items || !items.length) return out;
    const codes = [...new Set(items.map((x) => String(x.code || '').trim()).filter(Boolean))];
    if (!codes.length) return out;

    const typeByCode = new Map();
    for (const it of items) {
        const c = String(it.code || '').trim();
        if (c) typeByCode.set(c, it.type);
    }

    const safeComponentCodes = [
        ...new Set(
            codes
                .filter((c) => !isMsBundleType(typeByCode.get(c)))
                .map((c) => safeMsCodeForLike(c))
                .filter(Boolean),
        ),
    ];

    const [dirWinMap, bunWinMap, absMultiMap] = await Promise.all([
        loadDirectSalesWindowsMap(db, codes),
        loadBundleSalesWindowsMap(db, safeComponentCodes),
        loadAbsenceDistinctDaysAggregateMap(db, codes),
    ]);

    for (const codeKey of codes) {
        const isBundle = isMsBundleType(typeByCode.get(codeKey));
        const row = {};
        for (const [ka, kb, w] of D_PURCHASE_WINDOW_KEYS) {
            row[ka] = sumWindowQty(dirWinMap, bunWinMap, codeKey, isBundle, w);
            row[kb] = absenceAggDays(absMultiMap, codeKey, w);
        }
        row.v = 1;
        out.set(codeKey, row);
    }
    return out;
}

function serializeWindowsSnapshot(row) {
    if (!row || typeof row !== 'object') return null;
    const o = { v: 1 };
    for (const [ka, kb] of D_PURCHASE_WINDOW_KEYS) {
        o[ka] = Number(row[ka]) || 0;
        o[kb] = Number(row[kb]) || 0;
    }
    return JSON.stringify(o);
}

/** @returns {Record<string, number>|null} */
function parsePurchaseWindowsJson(raw) {
    if (raw == null || raw === '') return null;
    let o = raw;
    if (typeof raw === 'string') {
        try {
            o = JSON.parse(raw);
        } catch {
            return null;
        }
    } else if (Buffer.isBuffer(raw)) {
        try {
            o = JSON.parse(raw.toString('utf8'));
        } catch {
            return null;
        }
    } else if (typeof raw !== 'object') return null;
    if (!o || typeof o !== 'object' || Number(o.v) !== 1) return null;
    const out = {};
    for (const [ka, kb] of D_PURCHASE_WINDOW_KEYS) {
        const a = Number(o[ka]);
        const b = Number(o[kb]);
        out[ka] = Number.isFinite(a) ? a : 0;
        out[kb] = Number.isFinite(b) ? b : 0;
    }
    return out;
}

function applyPurchaseWindowsToDataItem(d, parsed) {
    if (!d || !parsed) return;
    for (const [ka, kb] of D_PURCHASE_WINDOW_KEYS) {
        d[ka] = parsed[ka];
        d[kb] = parsed[kb];
    }
}

module.exports = {
    PU_SNAPSHOT_SALES_DAYS,
    D_PURCHASE_WINDOW_KEYS,
    computePurchaseWindowSnapshotForItems,
    serializeWindowsSnapshot,
    parsePurchaseWindowsJson,
    applyPurchaseWindowsToDataItem,
};
