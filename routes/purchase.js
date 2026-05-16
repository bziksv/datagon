'use strict';

/**
 * Закупки — страница планирования закупок поверх ms_export.
 *
 * Контракт:
 *   • Источник истины для базовых полей — `ms_export` (синк МС).
 *   • Дополнительные сырые поля (артикул, packagings, в пути / inTransit) —
 *     из `ms_entity_details`: узкие колонки `denorm_*` (заполняются при синке карточек в `routes/moysklad.js`),
 *     без передачи `payload_json` в списке закупок; при отсутствии denorm — fallback из `payload_json` на догрузке страницы.
 *   • Редактируемые значения (Неснижаемый остаток Датагон / Кратность товара /
 *     Предлагаемый нес.остаток) хранятся в отдельной
 *     таблице `dg_purchase_overrides` (PK = code), чтобы синк МС не затирал
 *     их и схема ms_export не разрасталась.
 *   • Фильтр по умолчанию (по требованию пользователя):
 *       is_archived = 0 (только активные)
 *       stock_position = 'да' (только складская позиция)
 *       type = 'Товар' (исключаем комплекты)
 *       no_longer_cooperation — если query не задан: **не** «Да» в МС (`not_stopped`, как «Нет» в UI закупок)
 *
 * Эндпоинты:
 *   GET    /api/purchase/warmup-progress — заглушка «idle» (legacy UI); фоновых снимков закупок больше нет.
 *   GET    /api/purchase            — список: **COUNT + SELECT с ORDER BY в MySQL**, затем `LIMIT`/`OFFSET`; тяжёлое
 *                            обогащение (`enrichPurchaseListPage` → `loadMsPayloadRowsForCodes` + `enrichPurchaseRowsWithFormula`)
 *                            **только для текущей страницы** (~100 строк). Сортировка по `formula_proposed_min_stock` и `d_*a`/`d_*b`
 *                            в SQL идёт по полям **`dg_formula_proposed_cache`** (если строка кэша есть после открытия карточки
 *                            `GET /api/product/:code`); без кэша значение в ORDER BY NULL → строки в конце списка, на странице
 *                            после enrich отображается пересчитанное число (редкий рассинхрон порядка/ячейки — см. api.md).
 *                            `all` | `not_stopped` (default) | `stopped` — `no_longer_cooperation`;
 *                            доп. фильтры: `zero_stock`, `zero_stock_no_transit`, `no_multiplicity`, `incomplete_pack` (см. ниже).
 *   POST   /api/purchase/override   — сохранить одно значение (code + field + value).
 *   POST   /api/purchase/overrides-import — пакетный импорт CSV для min_stock_dg / multiplicity.
 *   GET    /api/purchase/log        — журнал изменений полей overrides `min_stock_dg` / `multiplicity` (query: code, limit, offset, field?).
 *   GET    /api/purchase/log/stats  — статистика таблицы `dg_purchase_overrides_log` + retention из app_settings.
 *   POST   /api/purchase/log/cleanup — удалить записи журнала старше N дней (body.days опц.).
 *
 * См. правила:
 *   .cursor/rules/datagon-list-page-baseline-moysklad.mdc
 *   .cursor/rules/datagon-list-query-patterns.mdc
 *   .cursor/rules/datagon-table-filter-apply.mdc
 *   .cursor/rules/datagon-node-restart-lock.mdc
 *   .cursor/rules/datagon-documentation-sync.mdc
 */

const express = require('express');
const { parseFormulaSettings, pickMarketPriceRub, computeSalesFormula, applyMinStockDgFloor } = require('../lib/datagonSalesFormula');
const { msDemandProjectFilterClause } = require('../lib/datagonSalesFormulaDemandFilter');
const {
    ensureZeroStockSchema,
    ensureBundleComponentsSchema,
    ensureBundleComponentsForProduct,
    loadLatestZeroStockWindowImportMap,
} = require('./product');
const { mergeAbsenceDistinctForFormula } = require('../lib/datagonZeroStockAbsence');
const {
    loadPurchaseDataRevision,
    buildFormulaFingerprint,
    ensureFormulaProposedCacheSchema,
} = require('../lib/datagonFormulaProposedCache');
const {
    parsePurchaseWindowsJson,
    applyPurchaseWindowsToDataItem,
    serializeWindowsSnapshot,
} = require('../lib/datagonPurchaseWindowSnapshot');
const { SUPPLIER_NEED_QTY_SQL, SUPPLIER_IN_TRANSIT_SQL } = require('../lib/datagonSuppliersSql');

/** Макс. уникальных кодов на странице, для которых выполняется прогрев составов комплектов. */
const PURCHASE_BUNDLE_WARM_MAX_CODES = 600;
/** Размер чанка для `IN (коды…)` в агрегатах продаж/нулей — иначе один запрос на десятки тысяч кодов «вешает» MySQL. */
const PURCHASE_CODES_SQL_CHUNK = 400;
/** Не дергать `ensureBundleComponentsForProduct` (LIKE по `ms_entity_details`), если кэш `dg_bundle_components` для кода свежий. */
const PURCHASE_BUNDLE_WARM_DB_TTL_MS = 8 * 60 * 60 * 1000;
/** После пустого кэша для компонента не повторять полный LIKE-скан до истечения (новые комплекты в МС — с задержкой). */
const PURCHASE_BUNDLE_EMPTY_NEGATIVE_MS = 4 * 60 * 60 * 1000;
const purchaseBundleEmptyWarmAt = new Map();

/** Кэш `data_rev` в памяти процесса (не дергать 6 подзапросов на каждый list). */
const PURCHASE_DATA_REV_TTL_MS = 45 * 1000;
let purchaseDataRevCache = { rev: '', ts: 0 };

/** Кэш ответа `GET /api/purchase` (фаза 3 — до Redis). */
const PURCHASE_LIST_RESPONSE_CACHE_TTL_MS = 90 * 1000;
const purchaseListResponseCache = new Map();

/** Сортировки, зависящие от `dg_formula_proposed_cache` / тяжёлого enrich. */
const PURCHASE_HEAVY_SORT_KEYS = new Set([
    'formula_proposed_min_stock',
    'd_15a',
    'd_15b',
    'd_30a',
    'd_30b',
    'd_60a',
    'd_60b',
    'd_90a',
    'd_90b',
    'd_180a',
    'd_180b',
    'd_365a',
    'd_365b',
]);

async function loadPurchaseDataRevisionCached(db) {
    const now = Date.now();
    if (purchaseDataRevCache.rev && now - purchaseDataRevCache.ts < PURCHASE_DATA_REV_TTL_MS) {
        return purchaseDataRevCache.rev;
    }
    const rev = await loadPurchaseDataRevision(db);
    purchaseDataRevCache = { rev, ts: now };
    return rev;
}

function invalidatePurchaseDataRevisionCache() {
    purchaseDataRevCache = { rev: '', ts: 0 };
}

function buildPurchaseListCacheKey(req, dataRev, formulaFp) {
    const q = req && req.query ? req.query : {};
    const norm = (k) => String(q[k] != null ? q[k] : '').trim();
    return JSON.stringify({
        data_rev: dataRev,
        formula_fp: formulaFp,
        limit: norm('limit') || '100',
        offset: norm('offset') || '0',
        sort_by: norm('sort_by') || 'code',
        sort_dir: norm('sort_dir') || 'asc',
        search: norm('search'),
        supplier: norm('supplier'),
        archived: norm('archived') || 'active',
        stock_position: norm('stock_position') || 'yes',
        no_longer_cooperation: norm('no_longer_cooperation') || 'not_stopped',
        include_bundles: norm('include_bundles') || '0',
        only_stock: norm('only_stock') || '0',
        zero_stock: norm('zero_stock') || '0',
        zero_stock_no_transit: norm('zero_stock_no_transit') || '0',
        no_multiplicity: norm('no_multiplicity') || '0',
        incomplete_pack: norm('incomplete_pack') || '0',
        to_purchase: norm('to_purchase') || '0',
        to_buy: norm('to_buy') || '0',
        supplier_exact: norm('supplier_exact') || '0',
    });
}

function invalidatePurchaseListResponseCache() {
    purchaseListResponseCache.clear();
}

function trimPurchaseListResponseCache() {
    if (purchaseListResponseCache.size <= 120) return;
    const cut = Date.now() - PURCHASE_LIST_RESPONSE_CACHE_TTL_MS * 2;
    for (const [k, v] of purchaseListResponseCache.entries()) {
        if (!v || v.ts < cut) purchaseListResponseCache.delete(k);
    }
    if (purchaseListResponseCache.size > 120) {
        const first = purchaseListResponseCache.keys().next().value;
        if (first) purchaseListResponseCache.delete(first);
    }
}

/** Legacy: UI/шапка могут опрашивать `/warmup-progress`; фонового прогрева снимков больше нет. */
function getPurchaseWarmupProgressPayload() {
    return {
        running: false,
        preset_index: 0,
        preset_total: 0,
        label: 'Выключено',
        done: 0,
        total: 0,
        pct: 100,
        preset_started_at_ms: null,
        preset_elapsed_sec: 0,
        finished_at_ms: null,
        progressive_run_started_ms: null,
        disabled: true,
    };
}

async function runPurchaseStartupProgressiveWarmup(_db, _appSettings) {
    /* no-op: список закупок переведён на SQL-пагинацию без in-memory снимков */
}

/** min(числовой суффикс) среди `ms_export.code` вида «база-число» — паритет с `syncZeroStockLogAfterMoyskladExport`. */
const MS_EXPORT_BUNDLE_MIN_SUFFIX_SUBSQL = `
    SELECT SUBSTRING_INDEX(code, '-', 1) AS base_code,
           MIN(CAST(SUBSTRING_INDEX(code, '-', -1) AS UNSIGNED)) AS min_suffix
      FROM ms_export
     WHERE (LENGTH(code) - LENGTH(REPLACE(code, '-', ''))) = 1
       AND SUBSTRING_INDEX(code, '-', -1) REGEXP '^[0-9]+$'
     GROUP BY SUBSTRING_INDEX(code, '-', 1)`;

/** Базовый код при наличии комплектов `код-N`: остаток &lt; min(суффикс) — отсутствие комплекта, не «неполная упаковка». */
function sqlIsBaseBundleShortage() {
    return `(
        INSTR(mse.code, '-') = 0
        AND bb.min_suffix IS NOT NULL
        AND bb.min_suffix > 0
        AND COALESCE(mse.stock, 0) < bb.min_suffix
    )`;
}

/**
 * Предикат фильтра `incomplete_pack=1`.
 * «Неполная упаковка» = есть ≥1 целая упаковка по кратности и остался хвост (не кратен).
 * Остаток 1 при кратности 2 — не попадает (ещё нет полной упаковки на складе).
 */
function sqlIncompletePackPredicate() {
    const mult = 'CAST(TRIM(CAST(po.multiplicity AS CHAR)) AS DECIMAL(18,6))';
    const stock = 'COALESCE(mse.stock, 0)';
    return `(
        ${mult} >= 1
        AND ${stock} > 0
        AND ${stock} >= ${mult}
        AND (${stock} - FLOOR(${stock} / ${mult}) * ${mult}) > 0
        AND NOT ${sqlIsBaseBundleShortage()}
    )`;
}

let schemaReady = false;

const OVERRIDE_FIELDS = new Set(['min_stock_dg', 'multiplicity', 'proposed_min_stock', 'pack_qty_manual']);

/** Допустимые `sort_by` из UI (whitelist). */
const PURCHASE_SORT_KEYS = new Set([
    'code',
    'article',
    'name',
    'supplier',
    'buy_price',
    'min_stock',
    'automation_price',
    'min_stock_dg',
    'multiplicity',
    'proposed_min_stock',
    'stock',
    'is_archived',
    'formula_proposed_min_stock',
    'in_transit',
    'd_15a',
    'd_15b',
    'd_30a',
    'd_30b',
    'd_60a',
    'd_60b',
    'd_90a',
    'd_90b',
    'd_180a',
    'd_180b',
    'd_365a',
    'd_365b',
]);

/**
 * Число из ценовой строки для ORDER BY: CAST в utf8mb4 (без CONVERT … utf8mb3 — ломает MariaDB и строки с 4-байтным UTF-8),
 * NBSP как UTF-8 (U+00A0 → UNHEX('C2A0')).
 */
const PURCHASE_SQL_BUY_PRICE_STR = 'TRIM(CAST(IFNULL(mse.buy_price, \'\') AS CHAR(100) CHARACTER SET utf8mb4))';
const PURCHASE_SQL_AUTO_PRICE_STR = 'TRIM(CAST(IFNULL(mse.automation_price, \'\') AS CHAR(100) CHARACTER SET utf8mb4))';
const PURCHASE_SQL_NBSP_UTF8 = `CAST(UNHEX('C2A0') AS CHAR(2) CHARACTER SET utf8mb4)`;

const PURCHASE_SQL_PRICE_NUM = `(
    CASE
        WHEN ${PURCHASE_SQL_BUY_PRICE_STR} = '' THEN NULL
        ELSE (
            REPLACE(REPLACE(REPLACE(REPLACE(${PURCHASE_SQL_BUY_PRICE_STR}, ' ', ''), ',', '.'), '₽', ''), ${PURCHASE_SQL_NBSP_UTF8}, '')
            + 0
        )
    END
)`;

const PURCHASE_SQL_AUTO_PRICE_NUM = `(
    CASE
        WHEN ${PURCHASE_SQL_AUTO_PRICE_STR} = '' THEN NULL
        ELSE (
            REPLACE(REPLACE(REPLACE(REPLACE(${PURCHASE_SQL_AUTO_PRICE_STR}, ' ', ''), ',', '.'), '₽', ''), ${PURCHASE_SQL_NBSP_UTF8}, '')
            + 0
        )
    END
)`;

const PURCHASE_IN_TRANSIT_SQL = `COALESCE(
    med.denorm_in_transit,
    CAST(NULLIF(JSON_UNQUOTE(JSON_EXTRACT(med.payload_json, '$.inTransit')), '') AS DECIMAL(18,6)),
    0
)`;

function buildPurchaseJsonWindowExpr(sortKey) {
    const k = String(sortKey || '');
    if (!/^d_(15|30|60|90|180|365)[ab]$/.test(k)) return null;
    return `CAST(NULLIF(JSON_UNQUOTE(JSON_EXTRACT(fc.windows_json, '$.${k}')), '') AS DECIMAL(20,6))`;
}

/** Фрагмент `ORDER BY …` (без ключевого слова ORDER BY). */
function buildPurchaseSqlOrderBy(sortKey, sortDesc) {
    const desc = sortDesc ? 'DESC' : 'ASC';
    const num = (expr) => `(${expr}) IS NULL ASC, (${expr}) ${desc}`;
    const str = (expr) => `${expr} ${desc}`;
    const tie = ', mse.id ASC';

    switch (sortKey) {
        case 'code':
            return `${str('mse.code')}${tie}`;
        case 'article':
            return `${str("LOWER(COALESCE(TRIM(med.denorm_article), ''))")}${tie}`;
        case 'name':
            return `${str('mse.name')}${tie}`;
        case 'supplier':
            return `mse.supplier ${desc}, mse.supplier2 ${desc}${tie}`;
        case 'buy_price':
            return `${num(PURCHASE_SQL_PRICE_NUM)}${tie}`;
        case 'automation_price':
            return `${num(PURCHASE_SQL_AUTO_PRICE_NUM)}${tie}`;
        case 'min_stock':
            return `${num('CAST(mse.min_stock AS DECIMAL(20,6))')}${tie}`;
        case 'min_stock_dg':
            return `${num('CAST(po.min_stock_dg AS DECIMAL(20,6))')}${tie}`;
        case 'multiplicity':
            return `${num('CAST(po.multiplicity AS DECIMAL(20,6))')}${tie}`;
        case 'proposed_min_stock':
            return `${num('CAST(po.proposed_min_stock AS DECIMAL(20,6))')}${tie}`;
        case 'stock':
            return `${num('CAST(COALESCE(mse.stock,0) AS DECIMAL(20,6))')}${tie}`;
        case 'is_archived':
            return `${str('mse.is_archived')}${tie}`;
        case 'formula_proposed_min_stock':
            return `${num('CAST(fc.proposed AS DECIMAL(20,6))')}${tie}`;
        case 'in_transit':
            return `${num(`CAST(${PURCHASE_IN_TRANSIT_SQL} AS DECIMAL(20,6))`)}${tie}`;
        default: {
            const w = buildPurchaseJsonWindowExpr(sortKey);
            if (w) return `${num(w)}${tie}`;
            return `${str('mse.code')}${tie}`;
        }
    }
}

/**
 * WHERE для списка закупок (как раньше в `purchaseListBuildBaseSnapshot`).
 * @returns {{ whereSql: string, whereParams: any[], incompletePack: boolean }}
 */
function buildPurchaseListWhereFragments(req) {
    const search = String(req.query.search || '').trim();
    const supplier = String(req.query.supplier || req.query.supplier_key || '').trim();
    const toBuyMode = String(req.query.to_buy || '0') === '1';
    const supplierExact =
        toBuyMode || String(req.query.supplier_exact || '0') === '1';
    const archived = String(req.query.archived || 'active').toLowerCase();
    const stockPositionMode = String(req.query.stock_position || 'yes').toLowerCase();
    const noLongerMode = String(req.query.no_longer_cooperation || 'not_stopped').toLowerCase();
    const includeBundles = String(req.query.include_bundles || '0') === '1';
    const onlyStock = String(req.query.only_stock || '0') === '1';
    const zeroStockNoTransit = String(req.query.zero_stock_no_transit || '0') === '1';
    const zeroStockOnly = String(req.query.zero_stock || '0') === '1';
    const noMultiplicity = String(req.query.no_multiplicity || '0') === '1';
    const incompletePack = String(req.query.incomplete_pack || '0') === '1';
    const toPurchaseOnly = String(req.query.to_purchase || '0') === '1' || toBuyMode;

    const where = ['1=1'];
    const params = [];

    if (archived === 'active') where.push('mse.is_archived = 0');
    else if (archived === 'archive' || archived === 'archived' || archived === '1') where.push('mse.is_archived = 1');

    if (stockPositionMode === 'yes') where.push("LOWER(mse.stock_position) = 'да'");
    else if (stockPositionMode === 'no') where.push("(mse.stock_position IS NULL OR LOWER(mse.stock_position) <> 'да')");

    if (!includeBundles) where.push("(mse.type IS NULL OR LOWER(mse.type) NOT LIKE '%комплект%')");

    if (search) {
        const v = `%${search.toLowerCase()}%`;
        where.push('(LOWER(mse.code) LIKE ? OR LOWER(mse.name) LIKE ? OR LOWER(mse.supplier) LIKE ? OR LOWER(mse.supplier2) LIKE ?)');
        params.push(v, v, v, v);
    }

    if (supplier) {
        if (supplierExact) {
            where.push('LOWER(TRIM(mse.supplier)) = LOWER(TRIM(?))');
            params.push(supplier);
        } else {
            const v = `%${supplier.toLowerCase()}%`;
            where.push('(LOWER(mse.supplier) LIKE ? OR LOWER(mse.supplier2) LIKE ?)');
            params.push(v, v);
        }
    }

    if (onlyStock) where.push('COALESCE(mse.stock, 0) > 0');

    if (zeroStockNoTransit) {
        where.push('COALESCE(mse.stock, 0) <= 0');
        where.push(
            'COALESCE(med.denorm_in_transit, CAST(NULLIF(JSON_UNQUOTE(JSON_EXTRACT(med.payload_json, \'$.inTransit\')), \'\') AS DECIMAL(18,6)), 0) <= 0',
        );
    } else if (zeroStockOnly) {
        where.push('COALESCE(mse.stock, 0) <= 0');
    }

    if (noMultiplicity) {
        where.push(
            '(po.multiplicity IS NULL OR TRIM(CAST(po.multiplicity AS CHAR)) = \'\' OR CAST(TRIM(CAST(po.multiplicity AS CHAR)) AS DECIMAL(18,6)) < 1)',
        );
    }

    if (incompletePack) {
        where.push(sqlIncompletePackPredicate());
    }

    if (noLongerMode === 'stopped') {
        where.push("LOWER(TRIM(COALESCE(mse.no_longer_cooperation, ''))) = 'да'");
    } else if (noLongerMode === 'not_stopped') {
        where.push("LOWER(TRIM(COALESCE(mse.no_longer_cooperation, ''))) <> 'да'");
    }

    if (toPurchaseOnly) {
        where.push(`(${SUPPLIER_NEED_QTY_SQL}) > 0`);
    }

    return {
        whereSql: where.join(' AND '),
        whereParams: params,
        incompletePack,
        toPurchaseOnly,
        toBuyMode,
        supplierExact,
    };
}

function buildPurchaseBaseFromJoin(incompletePack) {
    return `
                FROM ms_export mse
                LEFT JOIN dg_purchase_overrides po ON po.code = mse.code
                LEFT JOIN ms_entity_details med ON med.uuid = mse.uuid
                ${incompletePack ? `LEFT JOIN (${MS_EXPORT_BUNDLE_MIN_SUFFIX_SUBSQL}) bb ON bb.base_code = mse.code` : ''}
            `;
}

function buildPurchaseCountFromJoin(incompletePack, withFormulaCache) {
    const bundleJoin = incompletePack
        ? `LEFT JOIN (${MS_EXPORT_BUNDLE_MIN_SUFFIX_SUBSQL}) bb ON bb.base_code = mse.code`
        : '';
    const fcJoin = withFormulaCache
        ? `LEFT JOIN dg_formula_proposed_cache fc ON fc.code = mse.code AND fc.formula_fp = ? AND fc.data_rev = ?`
        : '';
    return `
                FROM ms_export mse
                LEFT JOIN dg_purchase_overrides po ON po.code = mse.code
                LEFT JOIN ms_entity_details med ON med.uuid = mse.uuid
                ${bundleJoin}
                ${fcJoin}
            `;
}

/**
 * @param {boolean} [withFormulaCache] — JOIN `dg_formula_proposed_cache` в этом запросе (итоги колонок всегда с fc).
 */
function purchaseCountQueryParams(frag, formulaFpVal, dataRev, withFormulaCache) {
    if (withFormulaCache) {
        return [formulaFpVal, dataRev, ...(frag.whereParams || [])];
    }
    return [...(frag.whereParams || [])];
}

const PURCHASE_MIN_STOCK_SUM_SQL = 'COALESCE(CAST(mse.min_stock AS DECIMAL(20,6)), 0)';

function buildPurchaseColumnTotalsSql(frag) {
    const fromJoin = buildPurchaseCountFromJoin(frag.incompletePack, true);
    return `
        SELECT
            SUM(${PURCHASE_MIN_STOCK_SUM_SQL}) AS min_stock_total,
            SUM(COALESCE(CAST(fc.proposed AS DECIMAL(20,6)), 0)) AS formula_proposed_min_stock_total,
            SUM(COALESCE(mse.stock, 0)) AS stock_total,
            SUM((${SUPPLIER_IN_TRANSIT_SQL})) AS in_transit_total,
            SUM((${SUPPLIER_NEED_QTY_SQL})) AS to_purchase_qty_total
        ${fromJoin}
        WHERE ${frag.whereSql}`;
}

function mapPurchaseColumnTotalsRow(r) {
    const row = r || {};
    return {
        min_stock: Number(row.min_stock_total || 0),
        formula_proposed_min_stock: Number(row.formula_proposed_min_stock_total || 0),
        stock: Number(row.stock_total || 0),
        in_transit: Number(row.in_transit_total || 0),
        to_purchase_qty: Number(row.to_purchase_qty_total || 0),
    };
}

async function purchaseListQueryPaged(db, appSettings, req, runOpts = {}) {
    const bench = Boolean(runOpts.bench);
    const benchOut = bench ? {} : null;

    let t0 = process.hrtime.bigint();
    const dataRev = await loadPurchaseDataRevisionCached(db);
    if (bench) benchOut.data_rev_ms = Number(process.hrtime.bigint() - t0) / 1e6;

    const formulaFpVal = buildFormulaFingerprint(appSettings);
    const limitRaw = parseInt(req.query.limit, 10);
    const offsetRaw = parseInt(req.query.offset, 10);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(1000, limitRaw) : 100;
    const offset = Number.isFinite(offsetRaw) && offsetRaw >= 0 ? offsetRaw : 0;
    const sortKeyRaw = String(req.query.sort_by || 'code').trim();
    const sortKey = PURCHASE_SORT_KEYS.has(sortKeyRaw) ? sortKeyRaw : 'code';
    const sortDir = String(req.query.sort_dir || 'asc').toLowerCase() === 'desc' ? 'desc' : 'asc';
    const sortDesc = sortDir === 'desc';

    const frag = buildPurchaseListWhereFragments(req);
    const orderBy = buildPurchaseSqlOrderBy(sortKey, sortDesc);

    const countFromJoin = buildPurchaseCountFromJoin(frag.incompletePack, frag.toPurchaseOnly);
    const countSql = `SELECT COUNT(*) AS cnt ${countFromJoin} WHERE ${frag.whereSql}`;
    const countParams = purchaseCountQueryParams(frag, formulaFpVal, dataRev, frag.toPurchaseOnly);
    const baseFromJoin = buildPurchaseBaseFromJoin(frag.incompletePack);
    const listSql = `
                SELECT
                    mse.code, mse.name, mse.supplier, mse.supplier2, mse.uuid, mse.type,
                    mse.is_archived, mse.stock_position, mse.no_longer_cooperation,
                    mse.buy_price, mse.min_stock, mse.stock, mse.automation_price,
                    mse.synced_at,
                    po.min_stock_dg, po.multiplicity,
                    po.proposed_min_stock, po.pack_qty_manual, po.updated_at AS override_updated_at,
                    NULL AS payload_json,
                    med.denorm_article,
                    med.denorm_in_transit,
                    med.denorm_pack_qty_auto,
                    med.denorm_market_price_rub,
                    fc.proposed AS formula_cached_proposed,
                    fc.windows_json AS formula_cached_windows_json
                ${baseFromJoin}
                LEFT JOIN dg_formula_proposed_cache fc
                  ON fc.code = mse.code AND fc.formula_fp = ? AND fc.data_rev = ?
                WHERE ${frag.whereSql}
                ORDER BY ${orderBy}
                LIMIT ? OFFSET ?`;
    const listParams = [formulaFpVal, dataRev, ...frag.whereParams, limit, offset];
    const totalsSql = buildPurchaseColumnTotalsSql(frag);
    const totalsParams = purchaseCountQueryParams(frag, formulaFpVal, dataRev, true);

    t0 = process.hrtime.bigint();
    const countT0 = process.hrtime.bigint();
    const listT0 = process.hrtime.bigint();
    const totalsT0 = process.hrtime.bigint();
    const [[countRows], [rows], [totalsRows]] = await Promise.all([
        db.query(countSql, countParams).then((r) => {
            if (bench) benchOut.count_ms = Number(process.hrtime.bigint() - countT0) / 1e6;
            return r;
        }),
        db.query(listSql, listParams).then((r) => {
            if (bench) benchOut.list_sql_ms = Number(process.hrtime.bigint() - listT0) / 1e6;
            return r;
        }),
        db.query(totalsSql, totalsParams).then((r) => {
            if (bench) benchOut.totals_ms = Number(process.hrtime.bigint() - totalsT0) / 1e6;
            return r;
        }),
    ]);
    if (bench) benchOut.sql_parallel_ms = Number(process.hrtime.bigint() - t0) / 1e6;

    const total = Number(countRows && countRows[0] ? countRows[0].cnt : 0);
    const pageItems = (rows || []).map((r) => mapPurchaseSqlRowToDataItem(r, { noPayloadForFormula: true }));

    t0 = process.hrtime.bigint();
    await enrichPurchaseListPage(db, appSettings, pageItems, {
        dataRev,
        formulaFp: formulaFpVal,
        skipBundleWarmup: true,
        includePayload: false,
    });
    if (bench) benchOut.enrich_ms = Number(process.hrtime.bigint() - t0) / 1e6;

    attachPurchaseNeedFields(pageItems);

    const out = {
        success: true,
        total,
        limit,
        offset,
        sort_by: sortKey,
        sort_dir: sortDir,
        to_purchase_active: Boolean(frag.toPurchaseOnly),
        column_totals: mapPurchaseColumnTotalsRow(totalsRows && totalsRows[0] ? totalsRows[0] : null),
        data: pageItems,
    };
    if (bench) out._bench = benchOut;
    return out;
}

async function ensureSchema(db) {
    if (schemaReady) return;
    await db.query(`
        CREATE TABLE IF NOT EXISTS dg_purchase_overrides (
            code VARCHAR(255) NOT NULL PRIMARY KEY,
            min_stock_dg DECIMAL(15,3) NULL DEFAULT NULL,
            multiplicity DECIMAL(15,3) NULL DEFAULT NULL,
            proposed_min_stock DECIMAL(15,3) NULL DEFAULT NULL,
            pack_qty_manual DECIMAL(15,3) NULL DEFAULT NULL,
            note VARCHAR(500) NULL,
            updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            INDEX idx_dg_purchase_overrides_updated (updated_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    try {
        const [dropCandidates] = await db.query(
            `SELECT COLUMN_NAME AS c FROM INFORMATION_SCHEMA.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE()
               AND TABLE_NAME = 'dg_purchase_overrides'
               AND COLUMN_NAME = 'min_stock_calc_as'`,
        );
        if (dropCandidates && dropCandidates.length) {
            await db.query('ALTER TABLE dg_purchase_overrides DROP COLUMN min_stock_calc_as');
        }
    } catch (e) {
        console.warn('[purchase] schema migrate drop min_stock_calc_as:', e && e.message ? e.message : e);
    }
    await ensureFormulaProposedCacheSchema(db);
    await db.query(`
        CREATE TABLE IF NOT EXISTS dg_purchase_overrides_log (
            id BIGINT AUTO_INCREMENT PRIMARY KEY,
            code VARCHAR(255) NOT NULL,
            field VARCHAR(64) NOT NULL,
            old_value VARCHAR(255) NULL,
            new_value VARCHAR(255) NULL,
            source VARCHAR(32) NOT NULL DEFAULT 'override',
            changed_by_user_id INT NULL,
            changed_by_name VARCHAR(255) NULL,
            changed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            INDEX idx_pu_ov_log_code (code, changed_at),
            INDEX idx_pu_ov_log_user (changed_by_user_id),
            INDEX idx_pu_ov_log_src (source)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    schemaReady = true;
}

function parseFlexibleNumber(raw) {
    if (raw == null) return null;
    const s = String(raw).trim();
    if (!s) return null;
    const cleaned = s.replace(/\s/g, '').replace(',', '.');
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : null;
}

/** Только эти поля допускает импорт CSV (см. POST /overrides-import). */
const PURCHASE_IMPORT_OVERRIDE_FIELDS = ['min_stock_dg', 'multiplicity'];

/** Поля закупок, которые пишутся в `dg_purchase_overrides_log` при изменении. */
const PURCHASE_LOG_FIELDS = new Set(['min_stock_dg', 'multiplicity']);

const PURCHASE_IMPORT_MAX_ROWS = 25000;

function actorDisplayName(actor) {
    if (!actor) return '';
    return String(actor.full_name || actor.username || '').trim();
}

function normalizeOverrideNum(v) {
    if (v == null || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

function sameOverrideNum(a, b) {
    if (a == null && b == null) return true;
    if (a == null || b == null) return false;
    return Math.abs(Number(a) - Number(b)) < 1e-9;
}

function formatValueForPurchaseLog(n) {
    if (n == null) return null;
    const x = Number(n);
    if (!Number.isFinite(x)) return String(n).slice(0, 255);
    if (Math.abs(x - Math.round(x)) < 1e-9) return String(Math.round(x));
    return String(Number.parseFloat(x.toFixed(6)));
}

const PURCHASE_LOG_LABELS = {
    min_stock_dg: 'Нес.остаток Датагон',
    multiplicity: 'Кратность товара',
};

async function insertPurchaseOverrideLog(db, opts) {
    const code = String(opts.code || '').trim();
    const field = String(opts.field || '').trim();
    if (!code || !field || !PURCHASE_LOG_FIELDS.has(field)) return;
    const actor = opts.actor || null;
    const uid = actor && actor.id != null ? Number(actor.id) : null;
    const uname = actorDisplayName(actor) || null;
    const source = String(opts.source || 'override').slice(0, 32) || 'override';
    const ov = opts.oldVal != null ? formatValueForPurchaseLog(opts.oldVal) : null;
    const nv = opts.newVal != null ? formatValueForPurchaseLog(opts.newVal) : null;
    await db.query(
        `INSERT INTO dg_purchase_overrides_log
            (code, field, old_value, new_value, source, changed_by_user_id, changed_by_name)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [code, field, ov, nv, source, Number.isFinite(uid) ? uid : null, uname],
    );
}

function splitPurchaseCsvLine(line, delim) {
    return String(line || '')
        .split(delim)
        .map((s) => s.trim().replace(/^"|"$/g, '').trim());
}

/**
 * Сопоставление заголовка колонки CSV с полем overrides.
 * Поддерживаются русские подписи как в UI.
 */
function purchaseImportHeaderToField(raw) {
    const t = String(raw || '')
        .replace(/^\uFEFF/, '')
        .trim()
        .replace(/^"|"$/g, '')
        .trim();
    if (!t) return null;
    const lower = t.toLowerCase().replace(/ё/g, 'е');
    const compact = lower.replace(/[\s._-]/g, '');
    if (['code', 'код', 'кодмс', 'sku', 'артикул'].includes(compact)) return 'code';
    if (compact === 'minstockdg' || compact === 'min_stock_dg') return 'min_stock_dg';
    if (lower.includes('неснижаемый') && lower.includes('датагон')) return 'min_stock_dg';
    if (lower.includes('нес') && lower.includes('остаток') && lower.includes('датагон')) return 'min_stock_dg';
    if (compact === 'multiplicity') return 'multiplicity';
    if (lower.includes('кратность')) return 'multiplicity';
    return null;
}

function parsePurchaseOverridesImportCsv(text) {
    const raw = String(text || '').replace(/^\uFEFF/, '').trim();
    if (!raw) throw new Error('CSV: передайте непустую строку');
    const lines = raw
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);
    if (lines.length < 2) throw new Error('CSV: нужна строка заголовка и минимум одна строка данных');
    const first = lines[0];
    const semi = first.split(';').length;
    const comma = first.split(',').length;
    const delim = semi > comma ? ';' : ',';
    const headerCells = splitPurchaseCsvLine(first, delim);
    const idx = { code: -1, min_stock_dg: -1, multiplicity: -1 };
    headerCells.forEach((cell, i) => {
        const f = purchaseImportHeaderToField(cell);
        if (!f || f === 'code') {
            if (f === 'code' && idx.code < 0) idx.code = i;
            return;
        }
        if (idx[f] < 0) idx[f] = i;
    });
    if (idx.code < 0) throw new Error('CSV: в первой строке нужна колонка кода (code, Код, …)');
    const hasAnyField = PURCHASE_IMPORT_OVERRIDE_FIELDS.some((k) => idx[k] >= 0);
    if (!hasAnyField) {
        throw new Error(
            'CSV: нужна хотя бы одна колонка из: Нес.остаток Датагон / Кратность товара',
        );
    }
    const rows = [];
    for (let li = 1; li < lines.length; li += 1) {
        const cells = splitPurchaseCsvLine(lines[li], delim);
        if (cells.length <= idx.code) continue;
        const code = String(cells[idx.code] || '').trim();
        if (!code) continue;
        const patch = { code };
        for (const field of PURCHASE_IMPORT_OVERRIDE_FIELDS) {
            const ci = idx[field];
            if (ci < 0) continue;
            const cellRaw = cells[ci] != null ? String(cells[ci]).trim() : '';
            if (!cellRaw || cellRaw === '-' || cellRaw === '—') {
                patch[field] = null;
                continue;
            }
            const num = parseFlexibleNumber(cellRaw);
            if (num == null) {
                throw new Error(`CSV: строка ${li + 1}, код «${code}», поле ${field}: не число «${cellRaw.slice(0, 40)}»`);
            }
            patch[field] = num;
        }
        rows.push(patch);
    }
    if (!rows.length) throw new Error('CSV: нет ни одной строки с непустым кодом');
    if (rows.length > PURCHASE_IMPORT_MAX_ROWS) {
        throw new Error(`Слишком много строк (${rows.length}), максимум ${PURCHASE_IMPORT_MAX_ROWS}`);
    }
    return { idx, rows };
}

async function loadMsExportCodesSet(db, codes) {
    const out = new Set();
    const chunk = 800;
    for (let i = 0; i < codes.length; i += chunk) {
        const part = codes.slice(i, i + chunk);
        const ph = part.map(() => '?').join(',');
        const [r] = await db.query(`SELECT code FROM ms_export WHERE code IN (${ph})`, part);
        for (const row of r || []) out.add(String(row.code || '').trim());
    }
    return out;
}

async function loadExistingOverridesMap(db, codes) {
    const map = new Map();
    if (!codes.length) return map;
    const chunk = 800;
    for (let i = 0; i < codes.length; i += chunk) {
        const part = codes.slice(i, i + chunk);
        const ph = part.map(() => '?').join(',');
        const [r] = await db.query(
            `SELECT code, min_stock_dg, multiplicity FROM dg_purchase_overrides WHERE code IN (${ph})`,
            part,
        );
        for (const row of r || []) {
            map.set(String(row.code || '').trim(), {
                min_stock_dg: row.min_stock_dg != null ? Number(row.min_stock_dg) : null,
                multiplicity: row.multiplicity != null ? Number(row.multiplicity) : null,
            });
        }
    }
    return map;
}

async function applyPurchaseOverridesImportRows(db, patches, colIdx, logActor) {
    const codes = [...new Set(patches.map((p) => p.code))];
    const validCodes = await loadMsExportCodesSet(db, codes);
    const existing = await loadExistingOverridesMap(db, codes);
    let upserted = 0;
    let skipped_unknown = 0;
    const unknownSample = [];
    const mergeKeys = PURCHASE_IMPORT_OVERRIDE_FIELDS.filter((k) => colIdx[k] >= 0);

    for (const p of patches) {
        if (!validCodes.has(p.code)) {
            skipped_unknown += 1;
            if (unknownSample.length < 15) unknownSample.push(p.code);
            continue;
        }
        const prev = existing.get(p.code) || {
            min_stock_dg: null,
            multiplicity: null,
        };
        const next = { ...prev };
        for (const k of mergeKeys) {
            if (Object.prototype.hasOwnProperty.call(p, k)) next[k] = p[k];
        }
        const logDiffs = [];
        for (const k of mergeKeys) {
            if (!Object.prototype.hasOwnProperty.call(p, k)) continue;
            if (!PURCHASE_LOG_FIELDS.has(k)) continue;
            if (sameOverrideNum(prev[k], next[k])) continue;
            logDiffs.push({ field: k, oldVal: prev[k], newVal: next[k] });
        }
        await db.query(
            `INSERT INTO dg_purchase_overrides (code, min_stock_dg, multiplicity)
             VALUES (?, ?, ?)
             ON DUPLICATE KEY UPDATE
                min_stock_dg = VALUES(min_stock_dg),
                multiplicity = VALUES(multiplicity)`,
            [p.code, next.min_stock_dg, next.multiplicity],
        );
        if (logDiffs.length) {
            for (const L of logDiffs) {
                await insertPurchaseOverrideLog(db, {
                    code: p.code,
                    field: L.field,
                    oldVal: L.oldVal,
                    newVal: L.newVal,
                    source: 'import',
                    actor: logActor,
                });
            }
        }
        existing.set(p.code, next);
        upserted += 1;
    }
    return { upserted, skipped_unknown, unknownSample };
}

function parsePayloadSafe(raw) {
    if (!raw) return null;
    try {
        const o = JSON.parse(raw);
        return o && typeof o === 'object' ? o : null;
    } catch (_) {
        return null;
    }
}

/** Кол-во штук в стандартной упаковке: ищем первый packaging с quantity > 1. */
function extractPackQty(payload) {
    if (!payload || !Array.isArray(payload.packagings)) return '';
    for (const pk of payload.packagings) {
        if (!pk) continue;
        const q = Number(pk.quantity);
        if (Number.isFinite(q) && q > 0) return q;
    }
    return '';
}

/** «В пути» из raw-карточки МС (`entity/product|bundle`), как в `routes/product.js`. */
function extractInTransit(payload) {
    if (!payload || payload.inTransit == null) return null;
    const n = Number(payload.inTransit);
    return Number.isFinite(n) ? n : null;
}

function buildSupplierLabel(s1Raw, s2Raw) {
    const s1 = String(s1Raw || '').trim();
    const s2 = String(s2Raw || '').trim();
    if (!s1 && !s2) return '';
    if (s1 && !s2) return s1;
    if (!s1 && s2) return s2;
    if (s1.toLowerCase() === s2.toLowerCase()) return s1;
    return `${s1}/${s2}`;
}

function isMsBundleType(typeRaw) {
    return String(typeRaw || '').toLowerCase().includes('комплект');
}

/** Как в `routes/product.js`: безопасный код для IN / bundle map. */
function safeMsCodeForLike(code) {
    const s = String(code || '').trim();
    if (!/^[A-Za-z0-9_.-]+$/u.test(s)) return '';
    return s;
}

/** Окна «снимка» для таблицы закупок: продажи (шт), совмещены с карточкой товара (`SALES_WINDOWS` в product). */
const PU_SNAPSHOT_SALES_DAYS = [3, 5, 7, 15, 30, 60, 90, 180, 365];

/**
 * @param {{ dataRev?: string, formulaFp?: string }} [formulaMeta] — для `formula_cached_proposed` (паритет с основным списком).
 */
async function loadMsPayloadRowsForCodes(db, codes, formulaMeta, loadOpts = {}) {
    const includePayload = Boolean(loadOpts.includePayload);
    const list = [...new Set((codes || []).map((c) => String(c || '').trim()).filter(Boolean))];
    if (!list.length) return [];
    const rev = formulaMeta && formulaMeta.dataRev != null ? String(formulaMeta.dataRev) : '';
    const fp = formulaMeta && formulaMeta.formulaFp != null ? String(formulaMeta.formulaFp) : '';
    const useFc = rev !== '' && fp !== '';
    const payloadSel = includePayload ? 'med.payload_json' : 'NULL AS payload_json';
    const out = [];
    for (let i = 0; i < list.length; i += PURCHASE_CODES_SQL_CHUNK) {
        const part = list.slice(i, i + PURCHASE_CODES_SQL_CHUNK);
        const ph = part.map(() => '?').join(',');
        const fcJoin = useFc
            ? `LEFT JOIN dg_formula_proposed_cache fc ON fc.code = mse.code AND fc.formula_fp = ? AND fc.data_rev = ?`
            : '';
        const fcSel = useFc
            ? ', fc.proposed AS formula_cached_proposed, fc.windows_json AS formula_cached_windows_json'
            : ', NULL AS formula_cached_proposed, NULL AS formula_cached_windows_json';
        const params = useFc ? [fp, rev, ...part] : [...part];
        const [rows] = await db.query(
            `SELECT
                    mse.code, mse.name, mse.supplier, mse.supplier2, mse.uuid, mse.type,
                    mse.is_archived, mse.stock_position, mse.no_longer_cooperation,
                    mse.buy_price, mse.min_stock, mse.stock, mse.automation_price,
                    mse.synced_at,
                    po.min_stock_dg, po.multiplicity,
                    po.proposed_min_stock, po.pack_qty_manual, po.updated_at AS override_updated_at,
                    ${payloadSel},
                    med.denorm_article,
                    med.denorm_in_transit,
                    med.denorm_pack_qty_auto,
                    med.denorm_market_price_rub
                    ${fcSel}
               FROM ms_export mse
               LEFT JOIN dg_purchase_overrides po ON po.code = mse.code
               LEFT JOIN ms_entity_details med ON med.uuid = mse.uuid
               ${fcJoin}
              WHERE mse.code IN (${ph})`,
            params,
        );
        if (rows && rows.length) out.push(...rows);
    }
    return out;
}

/** Обогащение только строк текущей страницы (после SQL-списка без payload в первом SELECT). */
async function enrichPurchaseListPage(db, appSettings, pageItems, snapshotMeta = {}) {
    if (!pageItems.length) return;
    const codes = pageItems.map((d) => d.code).filter(Boolean);
    const dataRev =
        snapshotMeta && snapshotMeta.dataRev != null && String(snapshotMeta.dataRev) !== ''
            ? String(snapshotMeta.dataRev)
            : await loadPurchaseDataRevisionCached(db);
    const formulaFp =
        snapshotMeta && snapshotMeta.formulaFp != null && String(snapshotMeta.formulaFp) !== ''
            ? String(snapshotMeta.formulaFp)
            : buildFormulaFingerprint(appSettings);
    const includePayload = snapshotMeta.includePayload === true;
    const sqlRows = await loadMsPayloadRowsForCodes(
        db,
        codes,
        { dataRev, formulaFp },
        { includePayload },
    );
    const byCode = new Map((sqlRows || []).map((r) => [String(r.code), mapPurchaseSqlRowToDataItem(r, { noPayloadForFormula: !includePayload })]));
    for (let i = 0; i < pageItems.length; i += 1) {
        const fresh = byCode.get(String(pageItems[i].code || ''));
        if (fresh) Object.assign(pageItems[i], fresh);
    }
    await enrichPurchaseRowsWithFormula(db, appSettings || {}, sqlRows, pageItems, {
        mode: 'all',
        noPayloadForFormula: !includePayload,
        skipBundleWarmup: snapshotMeta.skipBundleWarmup !== false,
    });
}

/** Одна строка списка закупок (общая для полного SELECT с payload и лёгкого без med). */
function mapPurchaseSqlRowToDataItem(r, opts = {}) {
    const noPayload = Boolean(opts.noPayloadForFormula);
    const payload = noPayload ? null : parsePayloadSafe(r.payload_json);
    const articleFromDenorm = r.denorm_article != null && String(r.denorm_article).trim() !== '' ? String(r.denorm_article).trim() : '';
    const article = articleFromDenorm || (payload && typeof payload.article === 'string' ? payload.article : '');
    let packQtyAuto = '';
    if (r.denorm_pack_qty_auto != null && r.denorm_pack_qty_auto !== '') {
        const pq = Number(r.denorm_pack_qty_auto);
        if (Number.isFinite(pq) && pq > 0) packQtyAuto = pq;
    }
    if (packQtyAuto === '') packQtyAuto = extractPackQty(payload);
    let inTransit = null;
    if (r.denorm_in_transit != null && r.denorm_in_transit !== '') {
        const t0 = Number(r.denorm_in_transit);
        if (Number.isFinite(t0)) inTransit = t0;
    }
    if (inTransit == null || !Number.isFinite(inTransit)) inTransit = extractInTransit(payload);
    if ((inTransit == null || !Number.isFinite(inTransit)) && r && r.in_transit_sort != null && r.in_transit_sort !== '') {
        const t = Number(r.in_transit_sort);
        if (Number.isFinite(t)) inTransit = t;
    }
    const supplierLabel = buildSupplierLabel(r.supplier, r.supplier2);
    const out = {
        code: r.code || '',
        article,
        name: r.name || '',
        is_archived: Number(r.is_archived || 0),
        type: r.type || '',
        uuid: r.uuid || '',
        supplier: r.supplier || '',
        supplier2: r.supplier2 || '',
        supplier_label: supplierLabel,
        buy_price: r.buy_price || '',
        min_stock: r.min_stock,
        automation_price: r.automation_price || '',
        proposed_min_stock: r.proposed_min_stock,
        min_stock_dg: r.min_stock_dg,
        multiplicity: r.multiplicity,
        pack_qty: r.pack_qty_manual != null ? r.pack_qty_manual : packQtyAuto,
        pack_qty_auto: packQtyAuto,
        pack_qty_manual: r.pack_qty_manual,
        stock: Number(r.stock || 0),
        in_transit: inTransit,
        no_longer_cooperation: r.no_longer_cooperation || '',
        stock_position: r.stock_position || '',
        override_updated_at: r.override_updated_at || null,
        formula_proposed_min_stock: (() => {
            const raw = r.formula_cached_proposed;
            if (raw == null || raw === '') return null;
            const n = Number(raw);
            return Number.isFinite(n) ? n : null;
        })(),
        d_15a: 0,
        d_15b: 0,
        d_30a: 0,
        d_30b: 0,
        d_60a: 0,
        d_60b: 0,
        d_90a: 0,
        d_90b: 0,
        d_180a: 0,
        d_180b: 0,
        d_365a: 0,
        d_365b: 0,
    };
    const pw = parsePurchaseWindowsJson(r.formula_cached_windows_json);
    if (pw) applyPurchaseWindowsToDataItem(out, pw);
    return out;
}

function parsePurchaseNumOrNull(v) {
    if (v == null || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

/** Целевой неснижаемый (паритет с `SUPPLIER_TARGET_STOCK_SQL` / закупки). */
function purchaseTargetStock(d) {
    const po = parsePurchaseNumOrNull(d.proposed_min_stock);
    const formula = parsePurchaseNumOrNull(d.formula_proposed_min_stock);
    const ms = parsePurchaseNumOrNull(d.min_stock);
    if (po != null) return po;
    if (formula != null) return formula;
    if (ms != null) return ms;
    return 0;
}

/** Кол-во «к закупке»: max(0, целевой − остаток − в пути). */
function computePurchaseNeedQty(d) {
    const target = purchaseTargetStock(d);
    const stock = Number(d.stock || 0);
    const transit = parsePurchaseNumOrNull(d.in_transit) != null ? Number(d.in_transit) : 0;
    const need = Math.max(0, target - stock - transit);
    return Math.round(need * 1000) / 1000;
}

function attachPurchaseNeedFields(items) {
    if (!items || !items.length) return;
    for (const d of items) {
        d.purchase_target_stock = purchaseTargetStock(d);
        d.to_purchase_qty = computePurchaseNeedQty(d);
    }
}

function buildWindowSumSelectSql(qtyExpr) {
    return PU_SNAPSHOT_SALES_DAYS.map(
        (w) =>
            `COALESCE(SUM(CASE WHEN d.moment >= (NOW() - INTERVAL ${w} DAY) THEN (${qtyExpr}) ELSE 0 END), 0) AS w${w}`,
    ).join(',\n            ');
}

async function loadPurchaseDirectSalesWindowsMap(db, codes, appSettings) {
    const map = new Map();
    if (!codes.length) return map;
    const proj = msDemandProjectFilterClause(appSettings || {});
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
                AND p.ms_export_code IN (${ph})${proj.sql}
              GROUP BY p.ms_export_code`,
            [...part, ...proj.params],
        );
        for (const r of rows || []) {
            const k = String(r.code || '').trim();
            if (k) map.set(k, r);
        }
    }
    return map;
}

async function loadPurchaseBundleSalesWindowsMap(db, componentCodes, appSettings) {
    const map = new Map();
    if (!componentCodes.length) return map;
    const proj = msDemandProjectFilterClause(appSettings || {});
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
              WHERE d.applicable = 1${proj.sql}
              GROUP BY bc.component_code`,
            [...part, ...proj.params],
        );
        for (const r of rows || []) {
            const k = String(r.code || '').trim();
            if (k) map.set(k, r);
        }
    }
    return map;
}

/**
 * Один проход по `dg_product_zero_stock_log`: число разных дат без остатка за 15…365 дн. (для колонок d_*b).
 * Раньше было 6 отдельных запросов с тем же IN (codes).
 */
async function loadPurchaseAbsenceDistinctDaysAggregateMap(db, codes) {
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

/** Цена типа с «маркет» в названии из `salePrices` payload МС (как на карточке товара). */
function marketPriceRubFromPayload(payload) {
    if (!payload || !Array.isArray(payload.salePrices)) return null;
    const prices = [];
    for (const sp of payload.salePrices) {
        if (!sp || sp.value == null) continue;
        const cents = Number(sp.value);
        if (!Number.isFinite(cents)) continue;
        const v = Math.round(cents) / 100;
        const name = String(sp?.priceType?.name || 'Цена продажи').trim();
        prices.push({ name, value: v });
    }
    return pickMarketPriceRub(prices);
}

/**
 * Сумма quantity за последние `intervalDays` (прямые по code + эквивалент через комплекты для component codes).
 */
async function loadPurchaseSumQtyLastDaysMap(db, codes, componentCodesForBundle, intervalDays, appSettings) {
    const D = Math.min(365 * 2, Math.max(1, Math.round(Number(intervalDays) || 1)));
    const proj = msDemandProjectFilterClause(appSettings || {});
    const map = new Map();
    if (!codes.length) return map;
    const uniqCodes = [...new Set(codes.map((c) => String(c || '').trim()).filter(Boolean))];
    for (let i = 0; i < uniqCodes.length; i += PURCHASE_CODES_SQL_CHUNK) {
        const part = uniqCodes.slice(i, i + PURCHASE_CODES_SQL_CHUNK);
        const ph = part.map(() => '?').join(',');
        const [directRows] = await db.query(
            `SELECT p.ms_export_code AS code, COALESCE(SUM(p.quantity), 0) AS sum_qty
               FROM ms_demand_position p
               INNER JOIN ms_demand d ON d.uuid = p.demand_uuid
              WHERE d.applicable = 1
                AND d.moment >= (NOW() - INTERVAL ? DAY)
                AND p.ms_export_code IN (${ph})${proj.sql}
              GROUP BY p.ms_export_code`,
            [D, ...part, ...proj.params],
        );
        for (const r of directRows || []) {
            const k = String(r.code || '').trim();
            if (k) map.set(k, Number(r.sum_qty || 0));
        }
    }
    const uniqComp = [...new Set(componentCodesForBundle.map((c) => String(c || '').trim()).filter(Boolean))];
    for (let i = 0; i < uniqComp.length; i += PURCHASE_CODES_SQL_CHUNK) {
        const part = uniqComp.slice(i, i + PURCHASE_CODES_SQL_CHUNK);
        const ph2 = part.map(() => '?').join(',');
        const [bundleRows] = await db.query(
            `SELECT bc.component_code AS code, COALESCE(SUM(p.quantity * bc.qty_per_bundle), 0) AS sum_qty
               FROM ms_demand_position p
               INNER JOIN ms_demand d ON d.uuid = p.demand_uuid
               INNER JOIN dg_bundle_components bc ON bc.bundle_code = p.ms_export_code
              WHERE d.applicable = 1
                AND d.moment >= (NOW() - INTERVAL ? DAY)
                AND bc.component_code IN (${ph2})${proj.sql}
              GROUP BY bc.component_code`,
            [D, ...part, ...proj.params],
        );
        for (const r of bundleRows || []) {
            const k = String(r.code || '').trim();
            if (!k) continue;
            map.set(k, (map.get(k) || 0) + Number(r.sum_qty || 0));
        }
    }
    return map;
}

const BUNDLE_CACHE_UPDATED_CHUNK = 500;

/** `component_code` → время последнего `updated_at` в `dg_bundle_components` (для пропуска прогрева). */
async function loadPurchaseBundleCacheLastUpdatedMap(db, safeCodes) {
    const out = new Map();
    const uniq = [...new Set(safeCodes.filter(Boolean))];
    if (!uniq.length) return out;
    for (let i = 0; i < uniq.length; i += BUNDLE_CACHE_UPDATED_CHUNK) {
        const chunk = uniq.slice(i, i + BUNDLE_CACHE_UPDATED_CHUNK);
        const ph = chunk.map(() => '?').join(',');
        const [rows] = await db.query(
            `SELECT component_code, MAX(updated_at) AS mx
               FROM dg_bundle_components
              WHERE component_code IN (${ph})
              GROUP BY component_code`,
            chunk,
        );
        for (const r of rows || []) {
            const c = String(r.component_code || '').trim();
            if (!c) continue;
            const t = r.mx ? new Date(r.mx).getTime() : 0;
            if (Number.isFinite(t) && t > 0) out.set(c, t);
        }
    }
    return out;
}

/** Сводка импорта «окон нулей» по чанкам (внутренний `IN` в `product.js` без разбиения). */
async function loadLatestZeroStockWindowImportMapBatched(db, codes) {
    const list = [...new Set(codes.map((c) => String(c || '').trim()).filter(Boolean))];
    const merged = new Map();
    for (let i = 0; i < list.length; i += PURCHASE_CODES_SQL_CHUNK) {
        const part = list.slice(i, i + PURCHASE_CODES_SQL_CHUNK);
        const m = await loadLatestZeroStockWindowImportMap(db, part);
        for (const [k, v] of m) merged.set(k, v);
    }
    return merged;
}

/** Прямые sum_qty за скользящее окно W дн. — чанки `IN (коды)`. */
async function loadPurchaseDirectSumQtyWindowRows(db, codes, W, appSettings) {
    const out = [];
    const proj = msDemandProjectFilterClause(appSettings || {});
    const uniq = [...new Set(codes.map((c) => String(c || '').trim()).filter(Boolean))];
    for (let i = 0; i < uniq.length; i += PURCHASE_CODES_SQL_CHUNK) {
        const part = uniq.slice(i, i + PURCHASE_CODES_SQL_CHUNK);
        const ph = part.map(() => '?').join(',');
        const [rows] = await db.query(
            `SELECT p.ms_export_code AS code, COALESCE(SUM(p.quantity), 0) AS sum_qty
               FROM ms_demand_position p
               INNER JOIN ms_demand d ON d.uuid = p.demand_uuid
              WHERE d.applicable = 1
                AND d.moment >= (NOW() - INTERVAL ? DAY)
                AND p.ms_export_code IN (${ph})${proj.sql}
              GROUP BY p.ms_export_code`,
            [W, ...part, ...proj.params],
        );
        if (rows && rows.length) out.push(...rows);
    }
    return out;
}

/** Эквивалент через комплекты sum_qty за окно W дн. */
async function loadPurchaseBundleSumQtyWindowRows(db, safeComponentCodes, W, appSettings) {
    const out = [];
    const proj = msDemandProjectFilterClause(appSettings || {});
    const uniq = [...new Set(safeComponentCodes.map((c) => String(c || '').trim()).filter(Boolean))];
    for (let i = 0; i < uniq.length; i += PURCHASE_CODES_SQL_CHUNK) {
        const part = uniq.slice(i, i + PURCHASE_CODES_SQL_CHUNK);
        const ph = part.map(() => '?').join(',');
        const [rows] = await db.query(
            `SELECT bc.component_code AS code, COALESCE(SUM(p.quantity * bc.qty_per_bundle), 0) AS sum_qty
               FROM ms_demand_position p
               INNER JOIN ms_demand d ON d.uuid = p.demand_uuid
               INNER JOIN dg_bundle_components bc ON bc.bundle_code = p.ms_export_code
              WHERE d.applicable = 1
                AND d.moment >= (NOW() - INTERVAL ? DAY)
                AND bc.component_code IN (${ph})${proj.sql}
              GROUP BY bc.component_code`,
            [W, ...part, ...proj.params],
        );
        if (rows && rows.length) out.push(...rows);
    }
    return out;
}

/** COUNT DISTINCT дат в логе нулей за окно absenceWin дн. */
async function loadPurchaseAbsenceDistinctIntervalRows(db, codes, absenceWin) {
    const out = [];
    const uniq = [...new Set(codes.map((c) => String(c || '').trim()).filter(Boolean))];
    for (let i = 0; i < uniq.length; i += PURCHASE_CODES_SQL_CHUNK) {
        const part = uniq.slice(i, i + PURCHASE_CODES_SQL_CHUNK);
        const ph = part.map(() => '?').join(',');
        const [rows] = await db.query(
            `SELECT code, COUNT(DISTINCT ts_date) AS distinct_days
               FROM dg_product_zero_stock_log
              WHERE ts_date >= (CURDATE() - INTERVAL ? DAY)
                AND code IN (${ph})
              GROUP BY code`,
            [absenceWin, ...part],
        );
        if (rows && rows.length) out.push(...rows);
    }
    return out;
}

/**
 * @param {'all'|'windows_only'|'formula_only'} [opts.mode='all']
 *   all — d_* + формула (обычная пагинация).
 *   windows_only — только d_* по всему набору (сортировка по d_*).
 *   formula_only — только формула (без тяжёлых окон d_*).
 * @param {boolean} [opts.noPayloadForFormula] — не читать `payload_json` для цены «маркет» (null); для сортировки
 *   по формуле на полном наборе; на текущей странице после slice формула пересчитывается с payload.
 */
async function enrichPurchaseRowsWithFormula(db, appSettings, sqlRows, data, opts = {}) {
    const mode = opts.mode || 'all';
    if (!data.length) return;

    const formulaCfg = parseFormulaSettings(appSettings);
    const W = formulaCfg.salesWindowDays;
    const absenceWin = formulaCfg.absenceAnalysisDays;

    const codes = [...new Set(data.map((d) => String(d.code || '').trim()).filter(Boolean))];
    if (!codes.length) return;

    if (purchaseBundleEmptyWarmAt.size > 40000) {
        const cut = Date.now() - PURCHASE_BUNDLE_EMPTY_NEGATIVE_MS;
        for (const [k, t] of purchaseBundleEmptyWarmAt) {
            if (t < cut) purchaseBundleEmptyWarmAt.delete(k);
        }
    }

    /** Паритет с `GET /api/product/:code`: без строк в `dg_bundle_components` продажи «через комплект» не попадают в сумму и формула уходит в ветку «редкий товар». */
    const codeIsBundle = new Map();
    for (const d of data) {
        const c = String(d.code || '').trim();
        if (!c) continue;
        codeIsBundle.set(c, isMsBundleType(d.type));
    }
    const warmPairs = [...codeIsBundle.entries()];
    const nonBundSafeList =
        warmPairs.length <= PURCHASE_BUNDLE_WARM_MAX_CODES
            ? [
                  ...new Set(
                      warmPairs
                          .filter(([, isBund]) => !isBund)
                          .map(([c]) => safeMsCodeForLike(String(c || '').trim()))
                          .filter(Boolean),
                  ),
              ]
            : [];

    const [, , cacheUpdatedAt] = await Promise.all([
        ensureZeroStockSchema(db),
        ensureBundleComponentsSchema(db),
        nonBundSafeList.length ? loadPurchaseBundleCacheLastUpdatedMap(db, nonBundSafeList) : Promise.resolve(new Map()),
    ]);

    if (!opts.skipBundleWarmup && warmPairs.length <= PURCHASE_BUNDLE_WARM_MAX_CODES) {
        const warmOnlyPairs = warmPairs.filter(([, isBund]) => !isBund);
        const nowMs = Date.now();
        /** Мало параллельных LIKE по `ms_entity_details`: при 8–10 одновременно MySQL «встаёт» и ответ закупок уходит в десятки секунд. */
        const BUNDLE_WARM_CONCURRENCY = 3;
        for (let wi = 0; wi < warmOnlyPairs.length; wi += BUNDLE_WARM_CONCURRENCY) {
            const chunk = warmOnlyPairs.slice(wi, wi + BUNDLE_WARM_CONCURRENCY);
            await Promise.all(
                chunk.map(async ([c]) => {
                    const safe = safeMsCodeForLike(String(c || '').trim());
                    if (!safe) return;
                    const mx = cacheUpdatedAt.get(safe);
                    if (mx && nowMs - mx < PURCHASE_BUNDLE_WARM_DB_TTL_MS) return;
                    const negAt = purchaseBundleEmptyWarmAt.get(safe);
                    if (negAt && nowMs - negAt < PURCHASE_BUNDLE_EMPTY_NEGATIVE_MS) return;
                    const n = await ensureBundleComponentsForProduct(db, c, false);
                    if (typeof n === 'number') {
                        if (n > 0) purchaseBundleEmptyWarmAt.delete(safe);
                        else purchaseBundleEmptyWarmAt.set(safe, Date.now());
                    }
                }),
            );
        }
    }

    const safeComponentCodes = [
        ...new Set(
            data
                .filter((d) => !isMsBundleType(d.type))
                .map((d) => safeMsCodeForLike(String(d.code || '').trim()))
                .filter(Boolean),
        ),
    ];

    const rowByCode = new Map(
        (sqlRows || []).map((row) => [String(row.code || '').trim(), row]).filter(([k]) => k),
    );

    const skipHeavyPurchaseWindows =
        mode !== 'formula_only' &&
        data.every((d) => {
            const rk = rowByCode.get(String(d.code || '').trim());
            return rk && parsePurchaseWindowsJson(rk.formula_cached_windows_json);
        });

    let directRows = [];
    let bundleRows = [];
    let absenceRows = [];
    let dirWinMap = new Map();
    let bunWinMap = new Map();
    let absMultiMap = new Map();
    let absSumMap = new Map();
    let zeroWinMap = new Map();

    if (mode === 'windows_only') {
        if (skipHeavyPurchaseWindows) {
            dirWinMap = new Map();
            bunWinMap = new Map();
            absMultiMap = new Map();
        } else {
            const [dr, br, am] = await Promise.all([
                loadPurchaseDirectSalesWindowsMap(db, codes, appSettings),
                loadPurchaseBundleSalesWindowsMap(db, safeComponentCodes, appSettings),
                loadPurchaseAbsenceDistinctDaysAggregateMap(db, codes),
            ]);
            dirWinMap = dr;
            bunWinMap = br;
            absMultiMap = am;
        }
    } else if (mode === 'formula_only') {
        const [dRows, bRows, aRows, asm, zwm] = await Promise.all([
            loadPurchaseDirectSumQtyWindowRows(db, codes, W, appSettings),
            safeComponentCodes.length
                ? loadPurchaseBundleSumQtyWindowRows(db, safeComponentCodes, W, appSettings)
                : Promise.resolve([]),
            loadPurchaseAbsenceDistinctIntervalRows(db, codes, absenceWin),
            loadPurchaseSumQtyLastDaysMap(db, codes, safeComponentCodes, absenceWin, appSettings),
            loadLatestZeroStockWindowImportMapBatched(db, codes),
        ]);
        directRows = dRows || [];
        bundleRows = bRows || [];
        absenceRows = aRows || [];
        absSumMap = asm;
        zeroWinMap = zwm;
    } else {
        if (skipHeavyPurchaseWindows) {
            const [dRows, bRows, aRows, asm, zwm] = await Promise.all([
                loadPurchaseDirectSumQtyWindowRows(db, codes, W, appSettings),
                safeComponentCodes.length
                    ? loadPurchaseBundleSumQtyWindowRows(db, safeComponentCodes, W, appSettings)
                    : Promise.resolve([]),
                loadPurchaseAbsenceDistinctIntervalRows(db, codes, absenceWin),
                loadPurchaseSumQtyLastDaysMap(db, codes, safeComponentCodes, absenceWin, appSettings),
                loadLatestZeroStockWindowImportMapBatched(db, codes),
            ]);
            directRows = dRows || [];
            bundleRows = bRows || [];
            absenceRows = aRows || [];
            absSumMap = asm;
            zeroWinMap = zwm;
            dirWinMap = new Map();
            bunWinMap = new Map();
            absMultiMap = new Map();
        } else {
            const [dRows, bRows, aRows, drm, brm, amm, asm, zwm] = await Promise.all([
                loadPurchaseDirectSumQtyWindowRows(db, codes, W, appSettings),
                safeComponentCodes.length
                    ? loadPurchaseBundleSumQtyWindowRows(db, safeComponentCodes, W, appSettings)
                    : Promise.resolve([]),
                loadPurchaseAbsenceDistinctIntervalRows(db, codes, absenceWin),
                loadPurchaseDirectSalesWindowsMap(db, codes, appSettings),
                loadPurchaseBundleSalesWindowsMap(db, safeComponentCodes, appSettings),
                loadPurchaseAbsenceDistinctDaysAggregateMap(db, codes),
                loadPurchaseSumQtyLastDaysMap(db, codes, safeComponentCodes, absenceWin, appSettings),
                loadLatestZeroStockWindowImportMapBatched(db, codes),
            ]);
            directRows = dRows || [];
            bundleRows = bRows || [];
            absenceRows = aRows || [];
            dirWinMap = drm;
            bunWinMap = brm;
            absMultiMap = amm;
            absSumMap = asm;
            zeroWinMap = zwm;
        }
    }

    const directMap = new Map(
        directRows.map((row) => [String(row.code || '').trim(), Number(row.sum_qty || 0)]).filter(([k]) => k),
    );
    const bundleMap = new Map();
    for (const row of bundleRows || []) {
        const k = String(row.code || '').trim();
        if (k) bundleMap.set(k, Number(row.sum_qty || 0));
    }
    const absenceMap = new Map(
        absenceRows.map((row) => [String(row.code || '').trim(), Number(row.distinct_days || 0)]).filter(([k]) => k),
    );

    function sumWindowQty(codeStr, isBundleRow, w) {
        const k = `w${w}`;
        const dr = dirWinMap.get(codeStr);
        const br = !isBundleRow ? bunWinMap.get(codeStr) : null;
        const a = dr && dr[k] != null ? Number(dr[k]) : 0;
        const b = br && br[k] != null ? Number(br[k]) : 0;
        const s = a + b;
        return Number.isFinite(s) ? s : 0;
    }

    for (let i = 0; i < data.length; i += 1) {
        const d = data[i];
        const codeKey = String(d.code || '').trim();
        const r = rowByCode.get(codeKey) || null;
        const isBundle = isMsBundleType(d.type);
        /** Везде `codeKey`: иначе расхождение с ключами из агрегатов по `ms_demand_position` / логам даёт sumQty=0 и ветку «редкий товар» (2 шт) при нормальной карточке товара. */
        let sumQty = directMap.get(codeKey) || 0;
        if (!isBundle) sumQty += bundleMap.get(codeKey) || 0;

        const sumQtyAbs = absSumMap.get(codeKey) || 0;

        const winImp = zeroWinMap.get(codeKey) || null;
        const absencePack = mergeAbsenceDistinctForFormula({
            logDistinctDays: absenceMap.get(codeKey) || 0,
            windowImport: winImp,
            analysisDaysA: absenceWin,
        });

        const payload = opts.noPayloadForFormula ? null : parsePayloadSafe(r ? r.payload_json : null);
        const denormMkt =
            r && r.denorm_market_price_rub != null && r.denorm_market_price_rub !== ''
                ? Number(r.denorm_market_price_rub)
                : null;
        const marketPriceRub =
            denormMkt != null && Number.isFinite(denormMkt)
                ? denormMkt
                : opts.noPayloadForFormula
                  ? null
                  : marketPriceRubFromPayload(payload);

        const multRaw = d.multiplicity != null ? Number(d.multiplicity) : 0;
        const multiplicity = Number.isFinite(multRaw) && multRaw >= 0 ? multRaw : 0;

        const msMinStock = d.min_stock != null && Number.isFinite(Number(d.min_stock)) ? Number(d.min_stock) : 0;
        let prevBaseline = msMinStock;
        let prevBaselineSource = 'ms_export.min_stock';
        if (d.proposed_min_stock != null && d.proposed_min_stock !== '' && Number.isFinite(Number(d.proposed_min_stock))) {
            prevBaseline = Number(d.proposed_min_stock);
            prevBaselineSource = 'override.proposed_min_stock';
        }

        if (mode !== 'windows_only') {
            const cachedFormula =
                d.formula_proposed_min_stock != null && Number.isFinite(Number(d.formula_proposed_min_stock))
                    ? Number(d.formula_proposed_min_stock)
                    : null;
            if (cachedFormula != null) {
                d.formula_proposed_min_stock = applyMinStockDgFloor(cachedFormula, d.min_stock_dg);
            } else {
                const fr = computeSalesFormula({
                    settings: formulaCfg,
                    sumQty,
                    sumQtyAbsenceWindow: sumQtyAbs,
                    absenceDistinctDays: absencePack.effective,
                    marketPriceRub,
                    multiplicity,
                    stockQty: d.stock,
                    prevBaseline,
                    prevBaselineSource,
                });
                d.formula_proposed_min_stock = applyMinStockDgFloor(fr.proposed_min_stock, d.min_stock_dg);
            }
        }

        if (mode !== 'formula_only') {
            const parsedW = parsePurchaseWindowsJson(r && r.formula_cached_windows_json);
            if (parsedW) {
                applyPurchaseWindowsToDataItem(d, parsedW);
            } else {
                d.d_15a = sumWindowQty(codeKey, isBundle, 15);
                d.d_15b = absenceAggDays(absMultiMap, codeKey, 15);
                d.d_30a = sumWindowQty(codeKey, isBundle, 30);
                d.d_30b = absenceAggDays(absMultiMap, codeKey, 30);
                d.d_60a = sumWindowQty(codeKey, isBundle, 60);
                d.d_60b = absenceAggDays(absMultiMap, codeKey, 60);
                d.d_90a = sumWindowQty(codeKey, isBundle, 90);
                d.d_90b = absenceAggDays(absMultiMap, codeKey, 90);
                d.d_180a = sumWindowQty(codeKey, isBundle, 180);
                d.d_180b = absenceAggDays(absMultiMap, codeKey, 180);
                d.d_365a = sumWindowQty(codeKey, isBundle, 365);
                d.d_365b = absenceAggDays(absMultiMap, codeKey, 365);
            }
        }
    }
}

let purchaseListIndexesReady = false;

/** Идемпотентные индексы под дефолтный список закупок (не блокировать GET). */
async function ensurePurchaseListPerfIndexes(db) {
    if (purchaseListIndexesReady) return;
    const specs = [
        {
            table: 'ms_export',
            index: 'idx_ms_export_purchase_default',
            ddl: 'CREATE INDEX idx_ms_export_purchase_default ON ms_export (is_archived, stock_position, code)',
        },
        {
            table: 'dg_formula_proposed_cache',
            index: 'idx_dg_formula_cache_rev_fp_code',
            ddl: 'CREATE INDEX idx_dg_formula_cache_rev_fp_code ON dg_formula_proposed_cache (data_rev(191), formula_fp(191), code)',
        },
    ];
    for (const s of specs) {
        try {
            const [ex] = await db.query(
                `SELECT 1 FROM information_schema.statistics
                 WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ? LIMIT 1`,
                [s.table, s.index],
            );
            if (ex && ex.length) continue;
            await db.query(s.ddl);
        } catch (e) {
            console.warn('[purchase] ensurePurchaseListPerfIndexes:', s.index, e && e.message ? e.message : e);
        }
    }
    purchaseListIndexesReady = true;
}

/**
 * Покрытие `dg_formula_proposed_cache` для текущих фильтров списка + последний успешный batch.
 * @returns {Promise<object>}
 */
function parsePurchaseFormulaBatchRunMessage(message) {
    const msg = String(message || '');
    const out = { processed: null, upserted: null, batch_data_rev: null };
    const mProc = msg.match(/обработано\s+(\d+)/i);
    const mUps = msg.match(/записано\s+(\d+)/i);
    const mRev = msg.match(/data_rev=([^\s,;]+)/i);
    if (mProc) out.processed = Number(mProc[1]);
    if (mUps) out.upserted = Number(mUps[1]);
    if (mRev) out.batch_data_rev = mRev[1];
    return out;
}

async function loadPurchaseFormulaCacheStatus(db, appSettings, req) {
    /** Для покрытия — всегда свежая ревизия (не TTL-кэш: после batch/синка МС иначе «ложное» частичное покрытие). */
    const dataRev = await loadPurchaseDataRevision(db);
    purchaseDataRevCache = { rev: dataRev, ts: Date.now() };
    const formulaFp = buildFormulaFingerprint(appSettings);
    const frag = buildPurchaseListWhereFragments(req);
    const countFromJoin = buildPurchaseCountFromJoin(frag.incompletePack, frag.toPurchaseOnly);
    const countSql = `SELECT COUNT(*) AS cnt ${countFromJoin} WHERE ${frag.whereSql}`;
    const countParams = purchaseCountQueryParams(frag, formulaFp, dataRev, frag.toPurchaseOnly);
    const baseFromJoin = buildPurchaseBaseFromJoin(frag.incompletePack);
    const cacheSql = `SELECT COUNT(*) AS cnt ${baseFromJoin}
                INNER JOIN dg_formula_proposed_cache fc
                  ON fc.code = mse.code AND fc.formula_fp = ? AND fc.data_rev = ?
                WHERE ${frag.whereSql}`;
    const cacheAnyRevSql = `SELECT COUNT(*) AS cnt ${baseFromJoin}
                INNER JOIN dg_formula_proposed_cache fc
                  ON fc.code = mse.code AND fc.formula_fp = ?
                WHERE ${frag.whereSql}`;
    const cacheStaleRevSql = `SELECT COUNT(*) AS cnt ${baseFromJoin}
                INNER JOIN dg_formula_proposed_cache fc
                  ON fc.code = mse.code AND fc.formula_fp = ? AND fc.data_rev <> ?
                WHERE ${frag.whereSql}`;
    let selectionTotal = 0;
    let cachedRows = 0;
    let cachedRowsAnyRev = 0;
    let cachedRowsStaleRev = 0;
    try {
        const [[countRows], [cacheHitRows], [cacheAnyRows], [cacheStaleRows]] = await Promise.all([
            db.query(countSql, countParams),
            db.query(cacheSql, [formulaFp, dataRev, ...frag.whereParams]),
            db.query(cacheAnyRevSql, [formulaFp, ...frag.whereParams]),
            db.query(cacheStaleRevSql, [formulaFp, dataRev, ...frag.whereParams]),
        ]);
        selectionTotal = Number(countRows && countRows[0] ? countRows[0].cnt : 0);
        cachedRows = Number(cacheHitRows && cacheHitRows[0] ? cacheHitRows[0].cnt : 0);
        cachedRowsAnyRev = Number(cacheAnyRows && cacheAnyRows[0] ? cacheAnyRows[0].cnt : 0);
        cachedRowsStaleRev = Number(cacheStaleRows && cacheStaleRows[0] ? cacheStaleRows[0].cnt : 0);
    } catch (e) {
        console.warn('[purchase][formula-cache-status]', e && e.message ? e.message : e);
    }
    let lastBatch = null;
    let lastBatchSuccess = null;
    let lastRunInterrupted = false;
    try {
        const [runs] = await db.query(
            `SELECT finished_at, message, trigger_type, status
             FROM auto_sync_runs
             WHERE task_type = 'purchase_formula_cache'
               AND finished_at IS NOT NULL
             ORDER BY finished_at DESC
             LIMIT 8`,
        );
        for (const r of runs || []) {
            if (!lastBatch) {
                lastBatch = {
                    finished_at: r.finished_at,
                    message: String(r.message || '').slice(0, 480),
                    trigger_type: String(r.trigger_type || ''),
                    status: String(r.status || ''),
                };
                if (
                    r.status === 'interrupted' ||
                    /закрыта при старте сервера/i.test(String(r.message || ''))
                ) {
                    lastRunInterrupted = true;
                }
            }
            const parsed = parsePurchaseFormulaBatchRunMessage(r.message);
            if (
                r.status === 'completed' &&
                parsed.upserted != null &&
                parsed.processed != null &&
                /обработано\s+\d+/i.test(String(r.message || ''))
            ) {
                lastBatchSuccess = {
                    finished_at: r.finished_at,
                    message: String(r.message || '').slice(0, 480),
                    trigger_type: String(r.trigger_type || ''),
                    status: 'completed',
                    ...parsed,
                };
                break;
            }
        }
    } catch (_) {
        /* auto_sync_runs может отсутствовать в тестовой схеме */
    }
    const coveragePct =
        selectionTotal > 0 ? Math.round((cachedRows / selectionTotal) * 1000) / 10 : 0;
    const revMismatch =
        selectionTotal > 0 &&
        cachedRows < selectionTotal &&
        cachedRowsStaleRev > 0 &&
        cachedRowsAnyRev >= cachedRows;
    return {
        data_rev: dataRev,
        formula_fp: formulaFp,
        selection_total: selectionTotal,
        cached_rows: cachedRows,
        cached_rows_any_rev: cachedRowsAnyRev,
        cached_rows_stale_rev: cachedRowsStaleRev,
        coverage_pct: coveragePct,
        ready: selectionTotal > 0 && cachedRows >= selectionTotal,
        rev_mismatch: revMismatch,
        last_batch: lastBatch,
        last_batch_success: lastBatchSuccess,
        last_run_interrupted: lastRunInterrupted,
    };
}

async function buildPurchaseListResponseCacheMeta(db, appSettings, req, sortKey, listSource) {
    const formulaCache = await loadPurchaseFormulaCacheStatus(db, appSettings, req);
    return {
        source: listSource,
        warmup_progress: getPurchaseWarmupProgressPayload(),
        sort_profile: PURCHASE_HEAVY_SORT_KEYS.has(sortKey) ? 'heavy' : 'fast',
        formula_cache: formulaCache,
    };
}

async function upsertFormulaCacheFromPageItems(db, appSettings, pageItems, dataRev, formulaFp) {
    if (!pageItems || !pageItems.length) return 0;
    await ensureFormulaProposedCacheSchema(db);
    const rev = dataRev != null ? String(dataRev) : await loadPurchaseDataRevisionCached(db);
    const fp = formulaFp != null ? String(formulaFp) : buildFormulaFingerprint(appSettings);
    let n = 0;
    for (const d of pageItems) {
        const code = String(d.code || '').trim();
        if (!code) continue;
        const proposed = d.formula_proposed_min_stock;
        if (proposed == null || !Number.isFinite(Number(proposed))) continue;
        const wj = serializeWindowsSnapshot(d);
        await db.query(
            `INSERT INTO dg_formula_proposed_cache (code, proposed, formula_fp, data_rev, windows_json)
             VALUES (?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE
               proposed = VALUES(proposed),
               formula_fp = VALUES(formula_fp),
               data_rev = VALUES(data_rev),
               windows_json = VALUES(windows_json),
               updated_at = CURRENT_TIMESTAMP`,
            [code, Number(proposed), fp, rev, wj],
        );
        n += 1;
    }
    return n;
}

/**
 * Фоновое заполнение `dg_formula_proposed_cache` для дефолтной выборки закупок (без in-memory снимка).
 * @param {{ chunkSize?: number, maxCodes?: number, req?: object }} [opts]
 */
async function runPurchaseFormulaCacheBatch(db, appSettings, opts = {}) {
    const chunkSize = Math.min(150, Math.max(20, Number(opts.chunkSize) || 50));
    const maxCodes = Math.max(0, Number(opts.maxCodes) || 0);
    const listReq = opts.req && typeof opts.req === 'object' ? opts.req : { query: {} };
    invalidatePurchaseDataRevisionCache();
    const dataRev = await loadPurchaseDataRevision(db);
    purchaseDataRevCache = { rev: dataRev, ts: Date.now() };
    const formulaFp = buildFormulaFingerprint(appSettings);
    const frag = buildPurchaseListWhereFragments(listReq);
    const baseFromJoin = buildPurchaseBaseFromJoin(frag.incompletePack);

    let offset = 0;
    let processed = 0;
    let upserted = 0;
    let errors = 0;

    while (true) {
        if (maxCodes > 0 && processed >= maxCodes) break;
        const take = maxCodes > 0 ? Math.min(chunkSize, maxCodes - processed) : chunkSize;
        const listSql = `
            SELECT
                mse.code, mse.name, mse.supplier, mse.supplier2, mse.uuid, mse.type,
                mse.is_archived, mse.stock_position, mse.no_longer_cooperation,
                mse.buy_price, mse.min_stock, mse.stock, mse.automation_price,
                mse.synced_at,
                po.min_stock_dg, po.multiplicity,
                po.proposed_min_stock, po.pack_qty_manual, po.updated_at AS override_updated_at,
                NULL AS payload_json,
                med.denorm_article,
                med.denorm_in_transit,
                med.denorm_pack_qty_auto,
                med.denorm_market_price_rub,
                NULL AS formula_cached_proposed,
                NULL AS formula_cached_windows_json
            ${baseFromJoin}
            WHERE ${frag.whereSql}
            ORDER BY mse.code ASC
            LIMIT ? OFFSET ?`;
        const [rows] = await db.query(listSql, [...frag.whereParams, take, offset]);
        if (!rows || !rows.length) break;

        const pageItems = rows.map((r) => mapPurchaseSqlRowToDataItem(r, { noPayloadForFormula: true }));
        try {
            await enrichPurchaseListPage(db, appSettings, pageItems, {
                dataRev,
                formulaFp,
                skipBundleWarmup: true,
                includePayload: false,
            });
            upserted += await upsertFormulaCacheFromPageItems(db, appSettings, pageItems, dataRev, formulaFp);
        } catch (e) {
            errors += 1;
            console.warn('[purchase][formula-cache-batch] chunk error:', e && e.message ? e.message : e);
        }
        processed += rows.length;
        offset += rows.length;
        if (rows.length < take) break;
    }

    purchaseDataRevCache = { rev: dataRev, ts: Date.now() };
    invalidatePurchaseListResponseCache();
    return { processed, upserted, errors, data_rev: dataRev, formula_fp: formulaFp };
}

/**
 * Legacy hook для автосинка `purchase_warmup` / env на старте Node.
 * In-memory снимки списка закупок отключены — список строится в SQL (`purchaseListQueryPaged`).
 */
async function warmupPurchaseListCaches() {
    return { built: 0, skipped: 1, sortTouches: 0, errors: 0, disabled: true };
}

function createPurchaseRouter(db, appSettings) {
    const router = express.Router();

    router.get('/log/stats', async (req, res) => {
        try {
            await ensureSchema(db);
            const retention = Number(appSettings.dg_purchase_overrides_log_retention_days || 180);
            const [totRows] = await db.query(
                `SELECT COUNT(*) AS total,
                        MIN(changed_at) AS oldest_at,
                        MAX(changed_at) AS newest_at
                 FROM dg_purchase_overrides_log`,
            );
            const tot = (totRows && totRows[0]) || {};
            const [srcRows] = await db.query(
                `SELECT source, COUNT(*) AS n FROM dg_purchase_overrides_log GROUP BY source`,
            );
            const bySource = {};
            (srcRows || []).forEach((r) => {
                bySource[String(r.source || 'override')] = Number(r.n || 0);
            });
            let olderThanRetention = 0;
            if (retention > 0) {
                const [oldRows] = await db.query(
                    `SELECT COUNT(*) AS n FROM dg_purchase_overrides_log
                     WHERE changed_at < (NOW() - INTERVAL ? DAY)`,
                    [retention],
                );
                olderThanRetention = Number((oldRows && oldRows[0] && oldRows[0].n) || 0);
            }
            return res.json({
                success: true,
                total: Number(tot.total || 0),
                oldest_at: tot.oldest_at ? new Date(tot.oldest_at).toISOString() : null,
                newest_at: tot.newest_at ? new Date(tot.newest_at).toISOString() : null,
                by_source: bySource,
                retention_days: retention,
                older_than_retention: olderThanRetention,
            });
        } catch (e) {
            return res.status(500).json({
                success: false,
                error: e && e.message ? e.message : 'Не удалось получить статистику журнала закупок',
            });
        }
    });

    router.get('/log', async (req, res) => {
        try {
            await ensureSchema(db);
            const code = String(req.query.code || '').trim();
            if (!code) return res.status(400).json({ success: false, error: 'Не указан code' });
            const field = String(req.query.field || '').trim();
            const rawLimit = Number(req.query.limit);
            const limit = Math.min(
                500,
                Math.max(1, Number.isFinite(rawLimit) && rawLimit > 0 ? Math.floor(rawLimit) : 100),
            );
            const rawOffset = Number(req.query.offset);
            const offset = Math.max(0, Number.isFinite(rawOffset) && rawOffset >= 0 ? Math.floor(rawOffset) : 0);
            const where = ['code = ?'];
            const params = [code];
            if (field) {
                where.push('field = ?');
                params.push(field);
            }
            const whereSql = `WHERE ${where.join(' AND ')}`;
            const [totRows] = await db.query(
                `SELECT COUNT(*) AS total FROM dg_purchase_overrides_log ${whereSql}`,
                params,
            );
            const total = Number((totRows && totRows[0] && totRows[0].total) || 0);
            const [rows] = await db.query(
                `SELECT id, code, field, old_value, new_value, source,
                        changed_by_user_id, changed_by_name, changed_at
                 FROM dg_purchase_overrides_log ${whereSql}
                 ORDER BY id DESC
                 LIMIT ? OFFSET ?`,
                [...params, limit, offset],
            );
            const out = (rows || []).map((r) => ({
                id: Number(r.id),
                code: String(r.code || ''),
                field: String(r.field || ''),
                field_label: PURCHASE_LOG_LABELS[r.field] || String(r.field || ''),
                old_value: r.old_value != null ? String(r.old_value) : null,
                new_value: r.new_value != null ? String(r.new_value) : null,
                source: String(r.source || 'override'),
                changed_by_user_id: r.changed_by_user_id != null ? Number(r.changed_by_user_id) : null,
                changed_by_name: r.changed_by_name != null ? String(r.changed_by_name) : '',
                changed_at: r.changed_at ? new Date(r.changed_at).toISOString() : '',
            }));
            return res.json({ success: true, code, rows: out, total, limit, offset });
        } catch (e) {
            return res.status(500).json({ success: false, error: e.message || 'Ошибка чтения журнала закупок' });
        }
    });

    router.post('/log/cleanup', express.json({ limit: '16kb' }), async (req, res) => {
        try {
            await ensureSchema(db);
            const body = req.body || {};
            const reqDays = body.days != null ? Number(body.days) : null;
            const defaultDays = Number(appSettings.dg_purchase_overrides_log_retention_days || 180);
            const days = Number.isFinite(reqDays) && reqDays > 0 ? Math.floor(reqDays) : defaultDays;
            if (days <= 0) {
                return res.status(400).json({ success: false, error: 'Некорректный retention (days <= 0)' });
            }
            const [r] = await db.query(
                `DELETE FROM dg_purchase_overrides_log WHERE changed_at < (NOW() - INTERVAL ? DAY)`,
                [days],
            );
            return res.json({
                success: true,
                deleted: Number((r && r.affectedRows) || 0),
                days,
            });
        } catch (e) {
            return res.status(500).json({
                success: false,
                error: e && e.message ? e.message : 'Не удалось очистить журнал закупок',
            });
        }
    });

    router.get('/warmup-progress', async (req, res) => {
        try {
            res.json({ success: true, ...getPurchaseWarmupProgressPayload() });
        } catch (e) {
            res.status(500).json({
                success: false,
                error: e && e.message ? e.message : 'Внутренняя ошибка',
            });
        }
    });

    router.get('/', async (req, res) => {
        try {
            await ensureSchema(db);
            if (typeof require('./msSales').ensureSchema === 'function') {
                await require('./msSales').ensureSchema(db);
            }
            ensurePurchaseListPerfIndexes(db).catch(() => {});

            const dataRev = await loadPurchaseDataRevisionCached(db);
            const formulaFpVal = buildFormulaFingerprint(appSettings);
            const cacheKey = buildPurchaseListCacheKey(req, dataRev, formulaFpVal);
            const cached = purchaseListResponseCache.get(cacheKey);
            if (cached && Date.now() - cached.ts < PURCHASE_LIST_RESPONSE_CACHE_TTL_MS) {
                const sortKeyMem = (cached.payload && cached.payload.sort_by) || 'code';
                const cacheMetaMem = await buildPurchaseListResponseCacheMeta(
                    db,
                    appSettings,
                    req,
                    sortKeyMem,
                    'memory',
                );
                return res.json({
                    ...cached.payload,
                    cache: {
                        ...cacheMetaMem,
                        age_ms: Date.now() - cached.ts,
                        ttl_ms: PURCHASE_LIST_RESPONSE_CACHE_TTL_MS,
                    },
                });
            }

            const responsePayload = await purchaseListQueryPaged(db, appSettings, req);
            const sortKey = responsePayload.sort_by;
            const cacheMeta = await buildPurchaseListResponseCacheMeta(db, appSettings, req, sortKey, 'sql');
            const body = { ...responsePayload, cache: cacheMeta };
            purchaseListResponseCache.set(cacheKey, { ts: Date.now(), payload: body });
            trimPurchaseListResponseCache();
            res.json(body);
        } catch (err) {
            console.error('[purchase][list] error:', err);
            res.status(500).json({ success: false, error: err && err.message ? err.message : 'Внутренняя ошибка' });
        }
    });

    router.post('/override', express.json({ limit: '64kb' }), async (req, res) => {
        try {
            await ensureSchema(db);
            const code = String((req.body && req.body.code) || '').trim();
            const field = String((req.body && req.body.field) || '').trim();
            if (!code) return res.status(400).json({ success: false, error: 'Не указан code товара' });
            if (!OVERRIDE_FIELDS.has(field)) {
                return res.status(400).json({ success: false, error: `Недопустимое поле: ${field}` });
            }

            const rawValue = req.body ? req.body.value : null;
            const num = rawValue === '' || rawValue == null ? null : parseFlexibleNumber(rawValue);
            if (rawValue !== '' && rawValue != null && num == null) {
                return res.status(400).json({ success: false, error: 'Значение должно быть числом или пустым' });
            }

            let prevNum = null;
            if (PURCHASE_LOG_FIELDS.has(field)) {
                const [prevRows] = await db.query(
                    `SELECT min_stock_dg, multiplicity
                     FROM dg_purchase_overrides WHERE code = ? LIMIT 1`,
                    [code],
                );
                const pr = prevRows && prevRows[0];
                if (pr && pr[field] != null && pr[field] !== '') {
                    const x = Number(pr[field]);
                    prevNum = Number.isFinite(x) ? x : null;
                }
            }

            const upsertSql = `
                INSERT INTO dg_purchase_overrides (code, ${field})
                VALUES (?, ?)
                ON DUPLICATE KEY UPDATE ${field} = VALUES(${field})
            `;
            await db.query(upsertSql, [code, num]);

            if (PURCHASE_LOG_FIELDS.has(field) && !sameOverrideNum(prevNum, num)) {
                await insertPurchaseOverrideLog(db, {
                    code,
                    field,
                    oldVal: prevNum,
                    newVal: num,
                    source: 'override',
                    actor: req.datagonActor || null,
                });
            }

            const [verifyRows] = await db.query(
                `SELECT code, min_stock_dg, multiplicity, proposed_min_stock, pack_qty_manual, updated_at
                 FROM dg_purchase_overrides WHERE code = ? LIMIT 1`,
                [code]
            );
            const stored = verifyRows && verifyRows[0] ? verifyRows[0] : null;
            invalidatePurchaseListResponseCache();
            invalidatePurchaseDataRevisionCache();
            res.json({ success: true, code, field, value: num, stored });
        } catch (err) {
            console.error('[purchase][override] error:', err);
            res.status(500).json({ success: false, error: err && err.message ? err.message : 'Внутренняя ошибка' });
        }
    });

    /**
     * POST /api/purchase/overrides-import
     * Body: { "csv": "…" } — UTF-8, первая строка заголовки, разделитель `;` или `,`.
     * Колонки: код товара (code|Код|…) и любое сочетание из
     * Нес.остаток Датагон / Кратность товара.
     * Пустая ячейка или «—» — записать NULL в override для этой колонки.
     * Строки с кодом, которого нет в ms_export, пропускаются (счётчик в ответе).
     */
    router.post('/overrides-import', express.json({ limit: '12mb' }), async (req, res) => {
        try {
            await ensureSchema(db);
            const csv = req.body && typeof req.body.csv === 'string' ? req.body.csv : '';
            if (!String(csv).trim()) {
                return res.status(400).json({ success: false, error: 'Передайте в JSON поле csv (строка UTF-8)' });
            }
            const parsed = parsePurchaseOverridesImportCsv(csv);
            const result = await applyPurchaseOverridesImportRows(
                db,
                parsed.rows,
                parsed.idx,
                req.datagonActor || null,
            );
            res.json({
                success: true,
                rows_read: parsed.rows.length,
                rows_upserted: result.upserted,
                skipped_unknown_code: result.skipped_unknown,
                unknown_codes_sample: result.unknownSample,
            });
        } catch (err) {
            const msg = err && err.message ? err.message : String(err);
            if (msg && (msg.startsWith('CSV:') || msg.startsWith('Слишком'))) {
                return res.status(400).json({ success: false, error: msg });
            }
            console.error('[purchase][overrides-import] error:', err);
            res.status(500).json({ success: false, error: msg || 'Внутренняя ошибка' });
        }
    });

    return router;
}

module.exports = createPurchaseRouter;
module.exports.createPurchaseRouter = createPurchaseRouter;
module.exports.ensureSchema = ensureSchema;
module.exports.warmupPurchaseListCaches = warmupPurchaseListCaches;
module.exports.runPurchaseStartupProgressiveWarmup = runPurchaseStartupProgressiveWarmup;
module.exports.getPurchaseWarmupProgressPayload = getPurchaseWarmupProgressPayload;
/** Для `scripts/purchase-list-sql-bench.cjs` — замер `GET /api/purchase` без HTTP. */
module.exports.purchaseListQueryPaged = purchaseListQueryPaged;
module.exports.runPurchaseFormulaCacheBatch = runPurchaseFormulaCacheBatch;
module.exports.PURCHASE_HEAVY_SORT_KEYS = PURCHASE_HEAVY_SORT_KEYS;
module.exports.invalidatePurchaseListResponseCache = invalidatePurchaseListResponseCache;
