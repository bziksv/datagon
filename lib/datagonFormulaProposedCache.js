'use strict';

/**
 * Кэш с карточки товара для списка закупок (`dg_formula_proposed_cache`):
 *   • proposed — «Предлагаемый нес.ост.» после `applyMinStockDgFloor`;
 *   • windows_json — колонки d_15a/d_15b … d_365a/d_365b (снимок окон продаж и «дн. нет»), см. `lib/datagonPurchaseWindowSnapshot.js`.
 * Чтение в GET /api/purchase при совпадении formula_fp + data_rev.
 */

let schemaReady = false;

/** Ревизия данных для инвалидации (паритет с routes/purchase.js). */
async function loadPurchaseDataRevision(db) {
    try {
        const [[r]] = await db.query(`
            SELECT
                (SELECT IFNULL(MAX(po.updated_at), '1970-01-01') FROM dg_purchase_overrides po) AS ov_mx,
                (SELECT IFNULL(MAX(mse.synced_at), '1970-01-01') FROM ms_export mse) AS ms_sync_mx,
                (SELECT COUNT(*) FROM ms_export) AS ms_n,
                (SELECT IFNULL(MAX(d.updated_at), '1970-01-01') FROM ms_demand d) AS demand_mx,
                (SELECT IFNULL(MAX(z.ts_date), '1970-01-01') FROM dg_product_zero_stock_log z) AS zero_ts_mx,
                (SELECT COUNT(*) FROM dg_product_zero_stock_log) AS zero_n,
                (SELECT IFNULL(MAX(bc.updated_at), '1970-01-01') FROM dg_bundle_components bc) AS bundle_mx
        `);
        const row = r || {};
        return [
            String(row.ov_mx || ''),
            String(row.ms_sync_mx || ''),
            String(row.ms_n || ''),
            String(row.demand_mx || ''),
            String(row.zero_ts_mx || ''),
            String(row.zero_n || ''),
            String(row.bundle_mx || ''),
        ].join('|');
    } catch (e) {
        return String(Date.now());
    }
}

const { salesFormulaProjectFilterFingerprint } = require('./datagonSalesFormulaDemandFilter');

function buildFormulaFingerprint(appSettings) {
    const a = appSettings || {};
    return [
        a.sales_formula_replenishment_days,
        a.sales_formula_replenishment_coef,
        a.sales_formula_sales_window_days,
        a.sales_formula_absence_analysis_days,
        a.sales_formula_base_qty,
        a.sales_formula_rare_base_qty,
        a.sales_formula_expensive_rare_threshold_rub,
        a.sales_formula_expensive_rare_min_qty,
        a.sales_formula_max_change_coef,
        a.sales_formula_incomplete_pack_pct,
        salesFormulaProjectFilterFingerprint(a),
    ].join('|');
}

/** Суффикс fp: глобаль `rd:g` или оверрайд поставщика `rd:N`. */
function formulaReplenishmentFpSuffix(replenishmentDaysOverride) {
    if (replenishmentDaysOverride == null || replenishmentDaysOverride === '') return 'rd:g';
    const d = Math.round(Number(replenishmentDaysOverride));
    if (!Number.isFinite(d)) return 'rd:g';
    return 'rd:' + Math.max(0, Math.min(3650, d));
}

/**
 * Fingerprint с учётом дней пополнения поставщика (пусто → глобаль).
 * Список закупок джойнит кэш по CONCAT(base, '|', rd:…).
 */
function buildEffectiveFormulaFingerprint(appSettings, replenishmentDaysOverride) {
    return buildFormulaFingerprint(appSettings) + '|' + formulaReplenishmentFpSuffix(replenishmentDaysOverride);
}

/**
 * SQL-фрагмент JOIN кэша формулы с учётом dg_supplier_settings.replenishment_days.
 * Плейсхолдеры: `?` = data_rev, `?` = base formula_fp (без |rd:…).
 */
function sqlFormulaCacheJoinOnMsExport() {
    return `LEFT JOIN dg_supplier_settings ss_rd ON ss_rd.supplier_key = TRIM(mse.supplier)
                LEFT JOIN dg_formula_proposed_cache fc
                  ON fc.code = mse.code AND fc.data_rev = ?
                  AND fc.formula_fp = CONCAT(?, '|', IF(ss_rd.replenishment_days IS NULL, 'rd:g', CONCAT('rd:', CAST(ROUND(ss_rd.replenishment_days) AS CHAR))))`;
}

async function ensureFormulaProposedCacheSchema(db) {
    if (schemaReady) return;
    await db.query(`
        CREATE TABLE IF NOT EXISTS dg_formula_proposed_cache (
            code VARCHAR(255) NOT NULL PRIMARY KEY,
            proposed DECIMAL(18,6) NULL,
            formula_fp VARCHAR(768) NOT NULL DEFAULT '',
            data_rev VARCHAR(768) NOT NULL DEFAULT '',
            windows_json JSON NULL,
            updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            INDEX idx_dg_formula_cache_fp_rev (formula_fp(191), data_rev(191))
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    try {
        await db.query(`ALTER TABLE dg_formula_proposed_cache ADD COLUMN windows_json JSON NULL`);
    } catch (e) {
        const msg = String((e && e.message) || e);
        if (!/Duplicate column name/i.test(msg)) throw e;
    }
    schemaReady = true;
}

/**
 * Сохранить с карточки: proposed (после applyMinStockDgFloor) и опционально windows_json (колонки d_* закупок).
 * @param {string|null|undefined} windowsJson — JSON-строка из `serializeWindowsSnapshot` или null.
 */
async function upsertFormulaProposedFromProduct(db, appSettings, code, proposedFloored, windowsJson, opts) {
    if (!db || !code) return;
    const c = String(code).trim();
    if (!c) return;
    const n = Number(proposedFloored);
    if (!Number.isFinite(n)) return;
    await ensureFormulaProposedCacheSchema(db);
    const dataRev = await loadPurchaseDataRevision(db);
    const o = opts || {};
    const formulaFp = buildEffectiveFormulaFingerprint(appSettings, o.replenishmentDaysOverride);
    const wj = windowsJson != null && String(windowsJson).trim() !== '' ? String(windowsJson) : null;
    await db.query(
        `INSERT INTO dg_formula_proposed_cache (code, proposed, formula_fp, data_rev, windows_json)
         VALUES (?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           proposed = VALUES(proposed),
           formula_fp = VALUES(formula_fp),
           data_rev = VALUES(data_rev),
           windows_json = VALUES(windows_json),
           updated_at = CURRENT_TIMESTAMP`,
        [c, n, formulaFp, dataRev, wj],
    );
}

module.exports = {
    loadPurchaseDataRevision,
    buildFormulaFingerprint,
    buildEffectiveFormulaFingerprint,
    formulaReplenishmentFpSuffix,
    sqlFormulaCacheJoinOnMsExport,
    ensureFormulaProposedCacheSchema,
    upsertFormulaProposedFromProduct,
};
