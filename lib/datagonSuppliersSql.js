'use strict';

/**
 * SQL-фрагменты для агрегации поставщиков по `ms_export` (паритет с закупками).
 */

const SUPPLIER_NBSP_UTF8 = "CAST(UNHEX('C2A0') AS CHAR(2) CHARACTER SET utf8mb4)";

function supplierPriceNumSql(alias, field) {
    const priceStr = `TRIM(CAST(IFNULL(${alias}.${field}, '') AS CHAR(100) CHARACTER SET utf8mb4))`;
    return `(
    CASE
        WHEN ${priceStr} = '' THEN 0
        ELSE (
            REPLACE(REPLACE(REPLACE(REPLACE(${priceStr}, ' ', ''), ',', '.'), '₽', ''), ${SUPPLIER_NBSP_UTF8}, '')
            + 0
        )
    END
)`;
}

const SUPPLIER_BUY_PRICE_STR = "TRIM(CAST(IFNULL(mse.buy_price, '') AS CHAR(100) CHARACTER SET utf8mb4))";
const SUPPLIER_BUY_PRICE_NUM = supplierPriceNumSql('mse', 'buy_price');
const SUPPLIER_SALE_PRICE_NUM = supplierPriceNumSql('mse', 'sale_price');

const SUPPLIER_IN_TRANSIT_SQL = `COALESCE(
    med.denorm_in_transit,
    CAST(NULLIF(JSON_UNQUOTE(JSON_EXTRACT(med.payload_json, '$.inTransit')), '') AS DECIMAL(18,6)),
    0
)`;

/** Целевой неснижаемый: override → кэш формулы → МС. */
const SUPPLIER_TARGET_STOCK_SQL = `COALESCE(
    CAST(po.proposed_min_stock AS DECIMAL(20,6)),
    CAST(fc.proposed AS DECIMAL(20,6)),
    CAST(mse.min_stock AS DECIMAL(20,6)),
    0
)`;

/** Для «к закупке»: только `ms_export.min_stock` (колонка «Неснижаемый остаток» в МС), без override/формулы. */
const SUPPLIER_PURCHASE_NEED_MIN_STOCK_SQL = `COALESCE(CAST(mse.min_stock AS DECIMAL(20,6)), 0)`;

const SUPPLIER_NEED_QTY_SQL = `GREATEST(
    0,
    (${SUPPLIER_PURCHASE_NEED_MIN_STOCK_SQL})
    - COALESCE(mse.stock, 0)
    - (${SUPPLIER_IN_TRANSIT_SQL})
)`;

/** WHERE для строк товара, участвующих в реестре поставщиков. */
function sqlSupplierProductWhere(alias = 'mse') {
    const a = alias;
    return `(
        TRIM(COALESCE(${a}.supplier, '')) <> ''
        AND ${a}.is_archived = 0
        AND LOWER(TRIM(COALESCE(${a}.stock_position, ''))) = 'да'
        AND LOWER(TRIM(COALESCE(${a}.no_longer_cooperation, ''))) <> 'да'
        AND (${a}.type IS NULL OR LOWER(${a}.type) NOT LIKE '%комплект%')
    )`;
}

/** WHERE для «SKU всего» поставщика: без архива и «перестали сотрудничать», комплекты исключены. */
function sqlSupplierAllSkusWhere(alias = 'mse') {
    const a = alias;
    return `(
        TRIM(COALESCE(${a}.supplier, '')) <> ''
        AND ${a}.is_archived = 0
        AND LOWER(TRIM(COALESCE(${a}.no_longer_cooperation, ''))) <> 'да'
        AND (${a}.type IS NULL OR LOWER(${a}.type) NOT LIKE '%комплект%')
    )`;
}

module.exports = {
    supplierPriceNumSql,
    SUPPLIER_BUY_PRICE_NUM,
    SUPPLIER_SALE_PRICE_NUM,
    SUPPLIER_IN_TRANSIT_SQL,
    SUPPLIER_TARGET_STOCK_SQL,
    SUPPLIER_PURCHASE_NEED_MIN_STOCK_SQL,
    SUPPLIER_NEED_QTY_SQL,
    sqlSupplierProductWhere,
    sqlSupplierAllSkusWhere,
};
