'use strict';

const { supplierPriceNumSql, sqlSupplierProductWhere, sqlSupplierAllSkusWhere } = require('./datagonSuppliersSql');

const EXPORT_BUY_PRICE_NUM = supplierPriceNumSql('e', 'buy_price');
const EXPORT_SALE_PRICE_NUM = supplierPriceNumSql('e', 'sale_price');

/** Маржа по строке отгрузки: фактическая сумма позиции − закупка из каталога × кол-во (не выше выручки строки). */
function salesMarginLineSql(exportAlias = 'e') {
    const buy = supplierPriceNumSql(exportAlias, 'buy_price');
    return `GREATEST(
        0,
        (COALESCE(p.sum_minor, 0) / 100) - (p.quantity * (${buy}))
    )`;
}

const EXPORT_MARGIN_LINE_SQL = salesMarginLineSql('e');

const DEMAND_ACTIVE_SQL = 'd.applicable = 1 AND d.deleted_at IS NULL';

/** Базовый JOIN продаж: позиция → отгрузка → товар ms_export. */
function salesJoinSql(exportAlias = 'e', demandExtraSql = '') {
    return `
        FROM ms_demand_position p
        INNER JOIN ms_demand d ON d.uuid = p.demand_uuid
        INNER JOIN ms_export ${exportAlias} ON ${exportAlias}.code = p.ms_export_code
            AND p.ms_export_resolved = 1
        WHERE ${DEMAND_ACTIVE_SQL}${demandExtraSql}
          AND ${sqlSupplierProductWhere(exportAlias)}
    `;
}

/**
 * Агрегат продаж по поставщику за окно [now-days, now).
 * @param {string} momentSql — условие на d.moment, напр. `d.moment >= DATE_SUB(NOW(), INTERVAL ? DAY)`
 */
function salesBySupplierSubquery(momentSql, demandExtraSql = '') {
    return `
        SELECT
            TRIM(e.supplier) AS supplier_key,
            TRIM(e.supplier) AS supplier_name,
            SUM(p.quantity) AS sales_qty,
            SUM(p.sum_minor) / 100 AS sales_revenue,
            SUM(${EXPORT_MARGIN_LINE_SQL}) AS gross_margin_est,
            COUNT(DISTINCT p.ms_export_code) AS skus_with_sales
        ${salesJoinSql('e', demandExtraSql)}
          AND ${momentSql}
        GROUP BY TRIM(e.supplier)
    `;
}

/**
 * Первый день с остатком > 0 по снимкам (для «новинок на складе»).
 * Не использовать в горячем ranking/overview: на больших dg_product_stock_snapshot
 * запрос занимает десятки секунд. Фильтр stock > 0 обязателен (иначе full scan нулей).
 */
function firstPositiveStockByCodeSubquery(lookbackDays) {
    const d = Math.max(7, Math.min(3650, Number(lookbackDays) || 90));
    return `
        SELECT code,
               MIN(ts_date) AS first_positive_date
        FROM dg_product_stock_snapshot
        WHERE ts_date >= DATE_SUB(CURDATE(), INTERVAL ${d} DAY)
          AND stock > 0
        GROUP BY code
    `;
}

/**
 * Каталог SKU по поставщику + остатки + «новинки на складе» (по dg_product_stock_snapshot).
 * @param {number} newStockDays — SKU с первым остатком за последние N дней не считаются «залежалыми»
 */
/** Все SKU поставщика в МС (шире, чем «складская позиция»). */
function supplierAllSkusSubquery() {
    return `
        SELECT TRIM(supplier) AS supplier_key, COUNT(*) AS skus_total
          FROM ms_export mse
         WHERE ${sqlSupplierAllSkusWhere('mse')}
         GROUP BY TRIM(supplier)
    `;
}

/**
 * Каталог SKU по поставщику + остатки.
 *
 * Важно: не джойним dg_product_stock_snapshot здесь — таблица ~миллионы строк,
 * агрегация first_positive на каждый ranking/overview вешает страницу на минуты.
 * «Новые на складе» / avg days — 0/NULL в list; детальный профиль отсутствия
 * (zero_stock_log) подтягивается отдельно в ranking через loadSupplierAbsenceRollupMap.
 *
 * @param {number} [_newStockDays] — сохранено в сигнатуре для call-sites; lookback snap не используется
 */
function catalogBySupplierSubquery(_newStockDays = 30) {
    const allSkus = supplierAllSkusSubquery();
    return `
        SELECT
            TRIM(mse.supplier) AS supplier_key,
            TRIM(mse.supplier) AS supplier_name,
            COUNT(*) AS products_total,
            COALESCE(allsk.skus_total, COUNT(*)) AS skus_total,
            SUM(CASE WHEN COALESCE(mse.stock, 0) > 0 THEN 1 ELSE 0 END) AS skus_with_stock,
            SUM(CASE WHEN COALESCE(mse.stock, 0) <= 0 THEN 1 ELSE 0 END) AS skus_zero_stock,
            SUM(COALESCE(mse.stock, 0)) AS stock_qty,
            SUM(COALESCE(mse.stock, 0) * (${supplierPriceNumSql('mse', 'buy_price')})) AS stock_value_rub,
            SUM(COALESCE(mse.min_stock, 0)) AS min_stock_sum,
            SUM(COALESCE(po.min_stock_dg, 0)) AS min_stock_dg_sum,
            SUM(COALESCE(fpc.proposed, 0)) AS formula_proposed_sum,
            0 AS skus_new_on_stock,
            CAST(NULL AS DECIMAL(18,4)) AS new_avg_days_on_stock
        FROM ms_export mse
        LEFT JOIN dg_purchase_overrides po ON po.code = mse.code
        LEFT JOIN dg_formula_proposed_cache fpc ON fpc.code = mse.code
        LEFT JOIN (${allSkus}) allsk ON allsk.supplier_key = TRIM(mse.supplier)
        WHERE ${sqlSupplierProductWhere('mse')}
        GROUP BY TRIM(mse.supplier), allsk.skus_total
    `;
}

/** Параметры для пары подзапросов cur/prev (в каждом: project IN, затем ? для moment). */
function salesRankingQueryParams(days, projectParams, searchParam) {
    const base = [...projectParams, days, ...projectParams, days, days];
    if (searchParam) base.push(searchParam);
    return base;
}

function supplierRankingSelectSql(catalogSql, curSql, prevSql) {
    return `
                SELECT
                    c.supplier_key,
                    c.supplier_name,
                    c.products_total,
                    c.products_total AS skus_warehouse,
                    c.skus_total,
                    c.skus_with_stock,
                    c.skus_zero_stock,
                    c.skus_new_on_stock,
                    c.new_avg_days_on_stock,
                    c.stock_qty,
                    c.stock_value_rub,
                    c.min_stock_sum,
                    c.min_stock_dg_sum,
                    c.formula_proposed_sum,
                    COALESCE(cur.sales_qty, 0) AS sales_qty,
                    COALESCE(cur.sales_revenue, 0) AS sales_revenue,
                    COALESCE(cur.skus_with_sales, 0) AS skus_with_sales,
                    COALESCE(cur.gross_margin_est, 0) AS gross_margin_est,
                    COALESCE(prev.sales_revenue, 0) AS sales_revenue_prev,
                    CASE
                        WHEN COALESCE(prev.sales_revenue, 0) > 0
                        THEN ROUND(100 * (COALESCE(cur.sales_revenue, 0) - prev.sales_revenue) / prev.sales_revenue, 2)
                        WHEN COALESCE(cur.sales_revenue, 0) > 0 THEN 100
                        ELSE NULL
                    END AS revenue_change_pct
                FROM (${catalogSql}) c
                LEFT JOIN (${curSql}) cur ON cur.supplier_key = c.supplier_key
                LEFT JOIN (${prevSql}) prev ON prev.supplier_key = c.supplier_key`;
}

module.exports = {
    DEMAND_ACTIVE_SQL,
    salesJoinSql,
    salesMarginLineSql,
    salesBySupplierSubquery,
    catalogBySupplierSubquery,
    supplierAllSkusSubquery,
    firstPositiveStockByCodeSubquery,
    salesRankingQueryParams,
    supplierRankingSelectSql,
};
