'use strict';

const {
    supplierPriceNumSql,
    supplierEffectiveSql,
    sqlSupplierProductWhere,
    sqlSupplierAllSkusWhere,
} = require('./datagonSuppliersSql');

const EXPORT_BUY_PRICE_NUM = supplierPriceNumSql('e', 'buy_price');
const EXPORT_SALE_PRICE_NUM = supplierPriceNumSql('e', 'sale_price');

const SALES_MAP_ALIAS = 'sold_map';

/**
 * Код в отгрузке → складской товар каталога.
 * Прямые продажи: code = code. Комплекты (часто пустой supplier, type «Комплект»,
 * зато заполнен supplier2) — через dg_bundle_components на component_code.
 * Если комплекта нет в кэше — fallback по коду «базовый-N» (N шт. в комплекте).
 * Поставщик каталога: supplier, иначе supplier2 (`supplierEffectiveSql`).
 */
function salesSoldToCatalogMapSql() {
    return `
        SELECT e.code AS sold_code,
               e.code AS catalog_code,
               CAST(1 AS DECIMAL(15,6)) AS qty_per_sold,
               CAST(1 AS DECIMAL(15,6)) AS qty_sum
          FROM ms_export e
         WHERE ${sqlSupplierProductWhere('e')}
        UNION ALL
        SELECT bc.bundle_code AS sold_code,
               bc.component_code AS catalog_code,
               bc.qty_per_bundle AS qty_per_sold,
               tot.qty_sum AS qty_sum
          FROM dg_bundle_components bc
          INNER JOIN ms_export e ON e.code = bc.component_code
          INNER JOIN (
                SELECT bundle_code, SUM(qty_per_bundle) AS qty_sum
                  FROM dg_bundle_components
                 GROUP BY bundle_code
          ) tot ON tot.bundle_code = bc.bundle_code
         WHERE ${sqlSupplierProductWhere('e')}
        UNION ALL
        SELECT mse.code AS sold_code,
               e.code AS catalog_code,
               CAST(SUBSTRING_INDEX(mse.code, '-', -1) AS DECIMAL(15,6)) AS qty_per_sold,
               CAST(SUBSTRING_INDEX(mse.code, '-', -1) AS DECIMAL(15,6)) AS qty_sum
          FROM ms_export mse
          INNER JOIN ms_export e ON e.code = SUBSTRING_INDEX(mse.code, '-', 1)
          LEFT JOIN dg_bundle_components bc0 ON bc0.bundle_code = mse.code
         WHERE bc0.bundle_code IS NULL
           AND LOWER(TRIM(COALESCE(mse.type, ''))) LIKE '%комплект%'
           AND mse.code LIKE '%-%'
           AND SUBSTRING_INDEX(mse.code, '-', -1) REGEXP '^[0-9]+(\.[0-9]+)?$'
           AND ${sqlSupplierProductWhere('e')}
    `;
}

function salesQtyExprSql(mapAlias = SALES_MAP_ALIAS) {
    return `(p.quantity * ${mapAlias}.qty_per_sold)`;
}

function salesRevenueExprSql(mapAlias = SALES_MAP_ALIAS) {
    return `((COALESCE(p.sum_minor, 0) / 100) * (${mapAlias}.qty_per_sold / NULLIF(${mapAlias}.qty_sum, 0)))`;
}

/** Маржа: доля выручки строки − закупка каталога × эквивалент шт. (не ниже 0). */
function salesMarginLineSql(exportAlias = 'e', mapAlias = SALES_MAP_ALIAS) {
    const buy = supplierPriceNumSql(exportAlias, 'buy_price');
    return `GREATEST(
        0,
        ${salesRevenueExprSql(mapAlias)} - (${salesQtyExprSql(mapAlias)} * (${buy}))
    )`;
}

const EXPORT_MARGIN_LINE_SQL = salesMarginLineSql('e');

const DEMAND_ACTIVE_SQL = 'd.applicable = 1 AND d.deleted_at IS NULL';

/** Базовый JOIN продаж: позиция → (прямой SKU или комплект) → складской ms_export. */
function salesJoinSql(exportAlias = 'e', demandExtraSql = '', mapAlias = SALES_MAP_ALIAS) {
    return `
        FROM ms_demand_position p
        INNER JOIN ms_demand d ON d.uuid = p.demand_uuid
        INNER JOIN (${salesSoldToCatalogMapSql()}) ${mapAlias}
            ON ${mapAlias}.sold_code = p.ms_export_code
        INNER JOIN ms_export ${exportAlias} ON ${exportAlias}.code = ${mapAlias}.catalog_code
        WHERE ${DEMAND_ACTIVE_SQL}${demandExtraSql}
          AND p.ms_export_resolved = 1
          AND ${sqlSupplierProductWhere(exportAlias)}
    `;
}

/**
 * Агрегат продаж по поставщику за окно [now-days, now).
 * @param {string} momentSql — условие на d.moment, напр. `d.moment >= DATE_SUB(NOW(), INTERVAL ? DAY)`
 */
function salesBySupplierSubquery(momentSql, demandExtraSql = '') {
    const sk = supplierEffectiveSql('e');
    return `
        SELECT
            ${sk} AS supplier_key,
            ${sk} AS supplier_name,
            SUM(${salesQtyExprSql()}) AS sales_qty,
            SUM(${salesRevenueExprSql()}) AS sales_revenue,
            SUM(${EXPORT_MARGIN_LINE_SQL}) AS gross_margin_est,
            COUNT(DISTINCT e.code) AS skus_with_sales
        ${salesJoinSql('e', demandExtraSql)}
          AND ${momentSql}
        GROUP BY ${sk}
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
    const sk = supplierEffectiveSql('mse');
    return `
        SELECT ${sk} AS supplier_key, COUNT(*) AS skus_total
          FROM ms_export mse
         WHERE ${sqlSupplierAllSkusWhere('mse')}
         GROUP BY ${sk}
    `;
}

/**
 * Каталог SKU по поставщику + остатки.
 * `stock_value_rub` — складской товар × себестоимость из отчёта остатков МС
 * (`payload.stockCost`), иначе закупочная; комплекты и ожидание не входят.
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
    const sk = supplierEffectiveSql('mse');
    return `
        SELECT
            ${sk} AS supplier_key,
            ${sk} AS supplier_name,
            COUNT(*) AS products_total,
            COALESCE(allsk.skus_total, COUNT(*)) AS skus_total,
            SUM(CASE WHEN COALESCE(mse.stock, 0) > 0 THEN 1 ELSE 0 END) AS skus_with_stock,
            SUM(CASE WHEN COALESCE(mse.stock, 0) <= 0 THEN 1 ELSE 0 END) AS skus_zero_stock,
            SUM(COALESCE(mse.stock, 0)) AS stock_qty,
            SUM(COALESCE(mse.stock, 0) * COALESCE(
                CAST(NULLIF(JSON_UNQUOTE(JSON_EXTRACT(med.payload_json, '$.stockCost')), '') AS DECIMAL(18,6)),
                (${supplierPriceNumSql('mse', 'buy_price')})
            )) AS stock_value_rub,
            SUM(COALESCE(mse.min_stock, 0)) AS min_stock_sum,
            SUM(COALESCE(po.min_stock_dg, 0)) AS min_stock_dg_sum,
            SUM(COALESCE(fpc.proposed, 0)) AS formula_proposed_sum,
            0 AS skus_new_on_stock,
            CAST(NULL AS DECIMAL(18,4)) AS new_avg_days_on_stock
        FROM ms_export mse
        LEFT JOIN ms_entity_details med ON med.uuid = mse.uuid
        LEFT JOIN dg_purchase_overrides po ON po.code = mse.code
        LEFT JOIN dg_formula_proposed_cache fpc ON fpc.code = mse.code
        LEFT JOIN (${allSkus}) allsk ON allsk.supplier_key = ${sk}
        WHERE ${sqlSupplierProductWhere('mse')}
        GROUP BY ${sk}, allsk.skus_total
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
    SALES_MAP_ALIAS,
    salesSoldToCatalogMapSql,
    salesQtyExprSql,
    salesRevenueExprSql,
    salesJoinSql,
    salesMarginLineSql,
    salesBySupplierSubquery,
    catalogBySupplierSubquery,
    supplierAllSkusSubquery,
    firstPositiveStockByCodeSubquery,
    salesRankingQueryParams,
    supplierRankingSelectSql,
};
