'use strict';

/**
 * SQL для «Анализ товаров» — срез по SKU (code), те же продажи что у анализа поставщиков.
 */

const {
    supplierPriceNumSql,
    supplierEffectiveSql,
    sqlProductAnalysisCatalogWhere,
} = require('./datagonSuppliersSql');
const {
    salesJoinSql,
    salesQtyExprSql,
    salesRevenueExprSql,
    salesMarginLineSql,
} = require('./datagonSupplierAnalysisSql');

const STOCK_UNIT_COST_SQL = `COALESCE(
    CAST(NULLIF(JSON_UNQUOTE(JSON_EXTRACT(med.payload_json, '$.stockCost')), '') AS DECIMAL(18,6)),
    (${supplierPriceNumSql('mse', 'buy_price')})
)`;

const FORMULA_PROPOSED_SQL = `COALESCE(
    CAST(po.proposed_min_stock AS DECIMAL(20,6)),
    CAST(fpc.proposed AS DECIMAL(20,6)),
    NULL
)`;

/** Продажи по catalog code за окно momentSql. */
function salesByCodeSubquery(momentSql, demandExtraSql = '') {
    return `
        SELECT
            e.code AS catalog_code,
            SUM(${salesQtyExprSql()}) AS sales_qty,
            SUM(${salesRevenueExprSql()}) AS sales_revenue,
            SUM(${salesMarginLineSql('e')}) AS gross_margin_est,
            MAX(d.moment) AS last_sale_at
        ${salesJoinSql('e', demandExtraSql, undefined, sqlProductAnalysisCatalogWhere)}
          AND ${momentSql}
        GROUP BY e.code
    `;
}

/**
 * Каталог складских SKU + решения + НС / предлагаемый.
 * Включает «перестали сотрудничать» (остаток может ещё лежать).
 * Без агрегации продаж (джойн снаружи).
 *
 * Важно: snap (`dg_product_stock_snapshot`, ~миллионы строк) **не** джойнить
 * по умолчанию — как в supplier-analysis. Lookback только при явной необходимости
 * (пресет «новые» / exclude_new / сортировка по days_on_stock).
 */
function catalogByCodeSql(opts = {}) {
    const sk = supplierEffectiveSql('mse');
    const snapLookback = Math.max(
        0,
        Math.min(730, Number(opts.snapLookbackDays) || 0),
    );
    const snapJoin =
        snapLookback > 0
            ? `
        LEFT JOIN (
            SELECT code AS code,
                   MIN(ts_date) AS first_positive_date
              FROM dg_product_stock_snapshot
             WHERE ts_date >= DATE_SUB(CURDATE(), INTERVAL ${snapLookback} DAY)
               AND stock > 0
             GROUP BY code
        ) snap ON snap.code = mse.code`
            : '';
    const snapCols =
        snapLookback > 0
            ? `snap.first_positive_date AS first_positive_date`
            : `CAST(NULL AS DATE) AS first_positive_date`;
    return `
        SELECT
            mse.code AS catalog_code,
            mse.name AS product_name,
            ${sk} AS supplier_name,
            TRIM(COALESCE(mse.manager, '')) AS manager,
            COALESCE(mse.stock, 0) AS stock_qty,
            COALESCE(mse.min_stock, 0) AS min_stock,
            (${STOCK_UNIT_COST_SQL}) AS unit_cost,
            (COALESCE(mse.stock, 0) * (${STOCK_UNIT_COST_SQL})) AS stock_value_rub,
            CAST(po.proposed_min_stock AS DECIMAL(20,6)) AS proposed_min_stock_override,
            CAST(fpc.proposed AS DECIMAL(20,6)) AS formula_proposed,
            (${FORMULA_PROPOSED_SQL}) AS formula_proposed_effective,
            COALESCE(pad.lifecycle, 'none') AS lifecycle,
            COALESCE(pad.do_not_order, 0) AS do_not_order,
            pad.min_stock_target AS min_stock_target,
            COALESCE(pad.lock_proposed_min_stock, 0) AS lock_proposed_min_stock,
            pad.boost_started_at AS boost_started_at,
            pad.boost_days AS boost_days,
            pad.decision_note AS decision_note,
            pad.updated_at AS decision_updated_at,
            ${snapCols}
        FROM ms_export mse
        LEFT JOIN ms_entity_details med ON med.uuid = mse.uuid
        LEFT JOIN dg_purchase_overrides po ON po.code = mse.code
        LEFT JOIN dg_formula_proposed_cache fpc ON fpc.code = mse.code
        LEFT JOIN dg_product_analysis_decisions pad ON pad.code = mse.code
        ${snapJoin}
        WHERE ${sqlProductAnalysisCatalogWhere('mse')}
    `;
}

function productRankingSelectSql(catalogSql, curSql, prevSql, opts = {}) {
    const includePrev = opts.includePrev !== false;
    const prevJoin = includePrev
        ? `LEFT JOIN (${prevSql}) prev ON prev.catalog_code = c.catalog_code`
        : '';
    const prevRevenue = includePrev
        ? 'COALESCE(prev.sales_revenue, 0)'
        : '0';
    const revenueChange = includePrev
        ? `CASE
                WHEN COALESCE(prev.sales_revenue, 0) > 0
                THEN ROUND(100 * (COALESCE(cur.sales_revenue, 0) - prev.sales_revenue) / prev.sales_revenue, 2)
                WHEN COALESCE(cur.sales_revenue, 0) > 0 THEN 100
                ELSE NULL
            END`
        : 'CAST(NULL AS DECIMAL(10,2))';
    return `
        SELECT
            c.catalog_code AS code,
            c.product_name AS name,
            c.supplier_name,
            c.manager,
            c.stock_qty,
            c.stock_value_rub,
            c.min_stock,
            c.formula_proposed_effective AS formula_proposed,
            c.lifecycle,
            c.do_not_order,
            c.min_stock_target,
            c.lock_proposed_min_stock,
            c.boost_started_at,
            c.boost_days,
            c.decision_note,
            c.first_positive_date,
            CASE
                WHEN c.first_positive_date IS NULL THEN NULL
                ELSE DATEDIFF(CURDATE(), c.first_positive_date)
            END AS days_on_stock,
            COALESCE(cur.sales_qty, 0) AS sales_qty,
            COALESCE(cur.sales_revenue, 0) AS sales_revenue,
            COALESCE(cur.gross_margin_est, 0) AS gross_margin_est,
            ${prevRevenue} AS sales_revenue_prev,
            cur.last_sale_at AS last_sale_at,
            CASE
                WHEN cur.last_sale_at IS NULL THEN NULL
                ELSE DATEDIFF(NOW(), cur.last_sale_at)
            END AS days_without_sales,
            ${revenueChange} AS revenue_change_pct,
            CASE
                WHEN COALESCE(cur.sales_revenue, 0) > 0
                THEN ROUND(100 * COALESCE(cur.gross_margin_est, 0) / cur.sales_revenue, 2)
                ELSE NULL
            END AS margin_pct
        FROM (${catalogSql}) c
        LEFT JOIN (${curSql}) cur ON cur.catalog_code = c.catalog_code
        ${prevJoin}
    `;
}

/** Параметры: project×windows. С prev — cur+prev; без prev — только cur. */
function productSalesQueryParams(days, projectParams, opts = {}) {
    const includePrev = opts.includePrev !== false;
    if (!includePrev) return [...projectParams, days];
    return [...projectParams, days, ...projectParams, days, days];
}

/**
 * Догрузить first_positive / days_on_stock только для кодов текущей страницы
 * (дешёвый точечный запрос по индексу code, без GROUP BY на всю snapshot).
 */
async function hydrateDaysOnStockForCodes(db, codes, lookbackDays = 365) {
    const list = Array.from(
        new Set((codes || []).map((c) => String(c || '').trim()).filter(Boolean)),
    );
    if (!list.length) return new Map();
    const lookback = Math.max(30, Math.min(730, Number(lookbackDays) || 365));
    const ph = list.map(() => '?').join(',');
    const [rows] = await db.query(
        `SELECT code,
                MIN(ts_date) AS first_positive_date,
                DATEDIFF(CURDATE(), MIN(ts_date)) AS days_on_stock
           FROM dg_product_stock_snapshot
          WHERE code IN (${ph})
            AND ts_date >= DATE_SUB(CURDATE(), INTERVAL ${lookback} DAY)
            AND stock > 0
          GROUP BY code`,
        list,
    );
    const map = new Map();
    (rows || []).forEach((r) => {
        const code = String(r.code || '');
        if (!code) return;
        map.set(code, {
            first_positive_date: r.first_positive_date
                ? String(r.first_positive_date).slice(0, 10)
                : null,
            days_on_stock:
                r.days_on_stock == null || !Number.isFinite(Number(r.days_on_stock))
                    ? null
                    : Number(r.days_on_stock),
        });
    });
    return map;
}

/** Нужен ли тяжёлый snap-join в ranking/overview. */
function rankingNeedsSnapJoin(flt, sortBy) {
    const preset = String((flt && flt.preset) || 'all');
    if (preset === 'new_on_stock') return true;
    if (
        flt &&
        flt.exclude_new_on_stock &&
        (preset === 'dead' || preset === 'stuck' || preset === 'dead_min_stock')
    ) {
        return true;
    }
    const sb = String(sortBy || '');
    if (sb === 'days_on_stock' || sb === 'first_positive_date') return true;
    return false;
}

const PRESETS = [
    {
        key: 'all',
        label: 'Все',
        description: 'Без фильтра пресета — все SKU каталога с учётом поиска и остальных фильтров.',
    },
    {
        key: 'top_revenue',
        label: 'Топ выручка',
        description: 'Все SKU, сортировка по выручке за период ↓. Удобно смотреть лидеров по деньгам.',
    },
    {
        key: 'top_qty',
        label: 'Топ qty',
        description: 'Все SKU, сортировка по продажам в штуках за период ↓.',
    },
    {
        key: 'dead',
        label: 'Мёртвые',
        description:
            'Строго: за выбранный период продаж = 0 шт., на складе остаток > 0. «Полный ноль» по продажам, но товар лежит. При включённом «Исключать новые» — без недавно появившихся на складе.',
    },
    {
        key: 'stuck',
        label: 'Зависшие',
        description:
            'Шире мёртвых: остаток > 0 и (продаж за период нет ИЛИ с последней продажи ≥ 30 дней). При «Исключать новые» — без новинок на складе.',
    },
    {
        key: 'new_on_stock',
        label: 'Новые на складе',
        description:
            'Остаток > 0 и первый снимок с остатком > 0 был не раньше, чем N дней назад (N = «Считать новым на складе»). Как «Новые» в анализе поставщиков.',
    },
    {
        key: 'dead_min_stock',
        label: 'НС>0 без продаж',
        description:
            'Продаж за период = 0, а неснижаемый остаток в МС > 0. Кандидаты на «Обнулить НС» — мёртвый товар с напрасной страховкой склада.',
    },
    {
        key: 'min_vs_proposed',
        label: 'НС ≠ предлагаемый',
        description:
            'Неснижаемый в МС не совпадает с предлагаемым (формула / зафиксированный target). Есть что согласовать.',
    },
    {
        key: 'lifecycle_none',
        label: 'Без решения',
        description: 'Ещё не выставляли этап жизненного цикла (lifecycle = none).',
    },
    {
        key: 'lifecycle_boost',
        label: 'В бусте',
        description: 'Решение «Буст» — товар в рекламе / продвижении, ждём эффект.',
    },
    {
        key: 'lifecycle_boost_failed',
        label: 'Буст не сработал',
        description: 'Буст уже ставили, эффекта нет — кандидаты на распродажу или вывод.',
    },
    {
        key: 'lifecycle_infographic',
        label: 'Обновление инфографики',
        description: 'Решение «Обновление инфографики» — нужна новая карточка/креативы на витрине.',
    },
    {
        key: 'lifecycle_clearance',
        label: 'Распродажа',
        description: 'Этап распродажи: не заказывать, цель — слить остаток.',
    },
    {
        key: 'lifecycle_exit',
        label: 'На выводе',
        description: 'Вывод из ассортимента: не заказывать, целевой НС = 0.',
    },
];

const PRESET_KEYS = new Set(PRESETS.map((p) => p.key));

function presetWhereSql(preset) {
    switch (preset) {
        case 'dead':
            return ' AND COALESCE(r.sales_qty, 0) <= 0 AND COALESCE(r.stock_qty, 0) > 0 ';
        case 'stuck':
            return ` AND COALESCE(r.stock_qty, 0) > 0
                     AND (COALESCE(r.sales_qty, 0) <= 0 OR COALESCE(r.days_without_sales, 9999) >= 30) `;
        case 'dead_min_stock':
            return ' AND COALESCE(r.sales_qty, 0) <= 0 AND COALESCE(r.min_stock, 0) > 0 ';
        case 'min_vs_proposed':
            return ` AND ROUND(COALESCE(r.min_stock, 0))
                     <> ROUND(COALESCE(r.formula_proposed, r.min_stock, 0))
                     AND r.formula_proposed IS NOT NULL `;
        case 'lifecycle_none':
            return ` AND COALESCE(r.lifecycle, 'none') = 'none' `;
        case 'lifecycle_boost':
            return ` AND r.lifecycle = 'boost' `;
        case 'lifecycle_boost_failed':
            return ` AND r.lifecycle = 'boost_failed' `;
        case 'lifecycle_infographic':
            return ` AND r.lifecycle = 'infographic' `;
        case 'lifecycle_clearance':
            return ` AND r.lifecycle = 'clearance' `;
        case 'lifecycle_exit':
            return ` AND r.lifecycle = 'exit' `;
        default:
            return '';
    }
}

function presetDefaultSort(preset) {
    switch (preset) {
        case 'top_qty':
            return { sortBy: 'sales_qty', sortDir: 'DESC' };
        case 'dead':
        case 'stuck':
        case 'dead_min_stock':
            return { sortBy: 'stock_value_rub', sortDir: 'DESC' };
        case 'new_on_stock':
            return { sortBy: 'days_on_stock', sortDir: 'ASC' };
        case 'top_revenue':
        case 'all':
        default:
            return { sortBy: 'sales_revenue', sortDir: 'DESC' };
    }
}

module.exports = {
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
    STOCK_UNIT_COST_SQL,
    FORMULA_PROPOSED_SQL,
};
