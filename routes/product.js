'use strict';

const { parseFormulaSettings, pickMarketPriceRub, computeSalesFormula, applyMinStockDgFloor, loadSupplierReplenishmentDaysForKey, resolveEffectiveReplenishment } = require('../lib/datagonSalesFormula');
const {
    msDemandProjectFilterClause,
    describeSalesFormulaProjectFilter,
    loadMsDemandProjectNameMap,
    salesFormulaProjectMode,
    salesFormulaProjectUuids,
} = require('../lib/datagonSalesFormulaDemandFilter');

const NO_PROJECT_FILTER = { sql: '', params: [] };

function parseProductSalesScope(req) {
    return String(req.query.sales_scope || 'all').trim().toLowerCase() === 'formula' ? 'formula' : 'all';
}

function projectFilterForSalesScope(appSettings, scope) {
    if (scope === 'formula') return msDemandProjectFilterClause(appSettings);
    return NO_PROJECT_FILTER;
}
const { mergeAbsenceDistinctForFormula } = require('../lib/datagonZeroStockAbsence');
const { upsertFormulaProposedFromProduct } = require('../lib/datagonFormulaProposedCache');
const { loadSkuRecommendedDaysByCodes } = require('../lib/datagonSupplierAbsenceProfile');
const {
    computePurchaseWindowSnapshotForItems,
    serializeWindowsSnapshot,
} = require('../lib/datagonPurchaseWindowSnapshot');

/** Срок хранения строк `dg_product_stock_snapshot` (дней); из `app_settings.product_stock_snapshot_retention_days`. */
function clampProductStockSnapshotRetentionDays(raw) {
    const n = Math.round(Number(raw));
    if (!Number.isFinite(n)) return 365;
    return Math.max(30, Math.min(3650, n));
}

/**
 * Карточка товара — агрегатный read-only endpoint для страницы /product.html.
 *
 * Контракт:
 *   • Источник истины для базовых полей — `ms_export` (синк МС).
 *   • Полная карточка (атрибуты, цены, барcодes, packagings) — `ms_entity_details.payload_json`.
 *   • Продажи — `ms_demand_position` + `ms_demand` (по `p.ms_export_code`) **плюс**
 *     эквивалент через комплекты: кэш `dg_bundle_components` (состав bundle из
 *     `ms_entity_details.payload_json.components.rows`), позиции отгрузок по
 *     `bundle_code` умножаются на `qty_per_bundle` компонента; сумма распределяется
 *     пропорционально доле компонента в составе (`qty_per_bundle / SUM(qty)` по строкам комплекта).
 *     Окно дат: query `sales_from`+`sales_to` (**календарные дни** по DATE(d.moment), без времени суток в query) или скользящее `recent_days`.
 *   • Override-поля (для блока «Закупки»: min_stock_dg, multiplicity, и т.д.) —
 *     из `dg_purchase_overrides`. Совместно с `routes/purchase.js`.
 *   • Итог **`formula.proposed_min_stock`** после расчёта и снимок колонок закупок **`d_*`** (окна 15…365)
 *     дублируются в **`dg_formula_proposed_cache`** (`proposed` + `windows_json`), чтобы `GET /api/purchase` мог подставить
 *     готовые значения без повторных тяжёлых агрегатов.
 *   • Лог «нулевых остатков по складам» — отдельная таблица `dg_product_zero_stock_log`
 *     (см. ensureZeroStockSchema). Пока поддерживается общий лог (`store_uuid='__total__'`),
 *     место под пo-складскую разбивку зарезервировано (после расширения синка
 *     `report/stock/bystore` сможем писать `store_uuid` реальный).
 *   • Нулевые остатки: пакетная фиксация за **сегодня** после успешного синка МС в `ms_export`
 *     (`syncZeroStockLogAfterMoyskladExport` из `routes/moysklad.js`) — только `stock_position='Да'`,
 *     не архив (`is_archived=0`), и либо `stock≤0`, либо (для кода **без** «-» в `ms_export.code`) остаток
 *     **строго меньше** минимального числового суффикса среди номенклатур вида `<тот же код>-<число>` в `ms_export`
 *     (например при `27877-2`, `27877-10` порог = 2 шт. для базы `27877`); ручная запись за тот же день
 *     (`source=manual`) не перезаписывается.
 *
 * Эндпоинты:
 *   GET    /api/product/:code                  — агрегатная карточка.
 *   GET    /api/product/:code/recent-shipments — пагинация «Последних отгрузок» (тот же период, что sales_*).
 *   GET    /api/product/:code/zero-stock-log   — лог нулевых остатков.
 *   POST   /api/product/:code/zero-stock-log   — ручная фиксация (если stock≤0 или force=1).
 *   POST   /api/product/zero-stock-windows-import — импорт сводки по окнам 30/60/90/180/365 (JSON или csv).
 *
 * **Сводка по окнам 30…365 на карточке** — считается из `dg_product_zero_stock_log` (COUNT DISTINCT `ts_date` по
 * скользящим окнам до `CURDATE()`), см. `computeZeroStockWindowsFromLog`. Исторический **импорт Excel**
 * (`dg_product_zero_stock_window_import`) не подменяет построчный лог; для **формулы продаж** число дней отсутствия
 * за период A по-прежнему max(разных дат в логе за A дн., оценка по последнему импорту — `lib/datagonZeroStockAbsence.js`),
 * если срез импорта не старше ~730 дн.; иначе только лог.
 *
 * См. правила:
 *   .cursor/rules/datagon-list-page-baseline-moysklad.mdc (таблица карточки — не списочная)
 *   .cursor/rules/datagon-node-restart-lock.mdc           (после правок — рестарт Node)
 *   .cursor/rules/datagon-documentation-sync.mdc          (api.md + docs/product.md)
 */

const express = require('express');
const { resolveUomLabelFromPayload } = require('../lib/msMetaResolve');

/** Не пересобирать `dg_bundle_components` для одного component_code чаще (GET карточки + серия /recent-shipments). */
const bundleComponentsLastBuiltMs = new Map();
const BUNDLE_COMPONENTS_REBUILD_COOLDOWN_MS = 90_000;

/** Карточка / recent-shipments: не гонять тяжёлый LIKE по `ms_entity_details`, если кэш комплектов свежий. */
const PRODUCT_CARD_BUNDLE_CACHE_FRESH_MS = 8 * 60 * 60 * 1000;
const PRODUCT_CARD_BUNDLE_EMPTY_NEGATIVE_MS = 4 * 60 * 60 * 1000;
const bundleComponentsEmptyNegativeAt = new Map();

let zeroStockSchemaReady = false;
let zeroWinImportSchemaReady = false;
let bundleComponentsSchemaReady = false;
let productStockSnapshotSchemaReady = false;

/** Окна для агрегатов продаж. Совмещены с «суточными» колонками в /purchase.html. */
const SALES_WINDOWS = [3, 5, 7, 15, 30, 60, 90, 180, 365];
const ZERO_LOG_DEFAULT_STORE = '__total__';

/** Тот же критерий, что middleware `/api` + `page_modes.purchase` для POST (см. `lib/datagonPageRegistry.js`). */
function purchaseOverridesEditable(req) {
    const a = req && req.datagonActor;
    if (!a || a.username === 'admin') return true;
    const raw = a.page_modes && a.page_modes.purchase != null ? a.page_modes.purchase : 'full';
    return String(raw).toLowerCase() === 'full';
}

async function ensureZeroStockSchema(db) {
    if (zeroStockSchemaReady) return;
    await db.query(`
        CREATE TABLE IF NOT EXISTS dg_product_zero_stock_log (
            id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
            code VARCHAR(255) NOT NULL,
            store_uuid VARCHAR(255) NOT NULL DEFAULT '__total__',
            store_name VARCHAR(255) NULL DEFAULT NULL,
            ts_date DATE NOT NULL,
            total_stock DECIMAL(15,3) NULL DEFAULT NULL,
            source VARCHAR(40) NOT NULL DEFAULT 'manual',
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            UNIQUE KEY uniq_zero_code_store_date (code, store_uuid, ts_date),
            INDEX idx_zero_code_date (code, ts_date)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    zeroStockSchemaReady = true;
}

async function ensureProductStockSnapshotSchema(db) {
    if (productStockSnapshotSchemaReady) return;
    await db.query(`
        CREATE TABLE IF NOT EXISTS dg_product_stock_snapshot (
            id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
            code VARCHAR(255) NOT NULL,
            ts_date DATE NOT NULL,
            stock DECIMAL(15,3) NOT NULL,
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            UNIQUE KEY uq_snap_code_date (code, ts_date),
            INDEX idx_snap_date (ts_date),
            INDEX idx_snap_code_date2 (code, ts_date)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    productStockSnapshotSchemaReady = true;
}

async function ensureZeroStockWindowImportSchema(db) {
    if (zeroWinImportSchemaReady) return;
    await db.query(`
        CREATE TABLE IF NOT EXISTS dg_product_zero_stock_window_import (
            id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
            reference_date DATE NOT NULL,
            code VARCHAR(255) NOT NULL,
            absent_last_30 INT NOT NULL DEFAULT 0,
            absent_last_60 INT NOT NULL DEFAULT 0,
            absent_last_90 INT NOT NULL DEFAULT 0,
            absent_last_180 INT NOT NULL DEFAULT 0,
            absent_last_365 INT NOT NULL DEFAULT 0,
            note VARCHAR(512) NULL,
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            UNIQUE KEY uq_zero_win_ref_code (reference_date, code),
            INDEX idx_zero_win_code_ref (code, reference_date)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    zeroWinImportSchemaReady = true;
}

function clampIntWindowCount(v) {
    const n = Math.floor(Number(String(v ?? '').replace(',', '.')));
    if (!Number.isFinite(n) || n < 0) return 0;
    return Math.min(366, n);
}

async function ensureBundleComponentsSchema(db) {
    if (bundleComponentsSchemaReady) return;
    await db.query(`
        CREATE TABLE IF NOT EXISTS dg_bundle_components (
            bundle_uuid VARCHAR(64) NOT NULL,
            bundle_code VARCHAR(255) NOT NULL,
            component_code VARCHAR(255) NOT NULL,
            qty_per_bundle DECIMAL(15, 6) NOT NULL,
            bundle_name VARCHAR(512) NULL DEFAULT NULL,
            is_archived TINYINT(1) NOT NULL DEFAULT 0,
            updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            PRIMARY KEY (bundle_uuid, component_code),
            INDEX idx_dg_bc_component (component_code),
            INDEX idx_dg_bc_bundle_code (bundle_code)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    bundleComponentsSchemaReady = true;
}

/** Только «безопасные» коды МС для LIKE-поиска по JSON (инъекция в шаблон невозможна). */
function safeMsCodeForLike(code) {
    const s = String(code || '').trim();
    if (!/^[A-Za-z0-9_.-]+$/u.test(s)) return '';
    return s;
}

/**
 * Период продаж (W, настройка «Продажи за период, дней») для графиков / последних отгрузок / сводок:
 * при валидной паре `sales_from` + `sales_to` (YYYY-MM-DD) — календарный диапазон (max 1825 дн.),
 * иначе — скользящее `recent_days` от NOW (default 365).
 */
function parseProductSalesWindow(req) {
    const fromQ = String(req.query.sales_from || '').trim();
    const toQ = String(req.query.sales_to || '').trim();
    const dateRe = /^\d{4}-\d{2}-\d{2}$/;
    if (dateRe.test(fromQ) && dateRe.test(toQ)) {
        const tFrom = Date.parse(`${fromQ}T00:00:00.000Z`);
        const tTo = Date.parse(`${toQ}T00:00:00.000Z`);
        if (Number.isFinite(tFrom) && Number.isFinite(tTo) && tFrom <= tTo) {
            const spanDays = Math.floor((tTo - tFrom) / 86400000) + 1;
            if (spanDays >= 1 && spanDays <= 1825) {
                return {
                    useRange: true,
                    fromDateStr: fromQ,
                    toDateStr: toQ,
                    spanDays,
                    daysRolling: null,
                };
            }
        }
    }
    const daysRolling = Math.min(365 * 5, Math.max(1, parseInt(req.query.recent_days, 10) || 365));
    return {
        useRange: false,
        fromDateStr: null,
        toDateStr: null,
        spanDays: daysRolling,
        daysRolling,
    };
}

function buildSalesMomentFilter(window) {
    if (window.useRange) {
        return {
            clause: 'AND DATE(d.moment) >= ? AND DATE(d.moment) <= ?',
            params: [window.fromDateStr, window.toDateStr],
        };
    }
    return {
        clause: 'AND d.moment >= (NOW() - INTERVAL ? DAY)',
        params: [window.daysRolling],
    };
}

/** Список YYYY-MM от fromYmd до toYmd включительно. */
function enumerateCalendarMonths(fromYmd, toYmd) {
    const out = [];
    let y = Number(fromYmd.slice(0, 4));
    let m = Number(fromYmd.slice(5, 7)) - 1;
    const y1 = Number(toYmd.slice(0, 4));
    const m1 = Number(toYmd.slice(5, 7)) - 1;
    for (;;) {
        out.push(`${y}-${String(m + 1).padStart(2, '0')}`);
        if (y === y1 && m === m1) break;
        m += 1;
        if (m > 11) {
            m = 0;
            y += 1;
        }
    }
    return out;
}

function enumerateRollingMonths(daysRolling) {
    const months = Math.min(60, Math.max(1, Math.ceil(daysRolling / 30)));
    const out = [];
    const now = new Date();
    for (let i = months - 1; i >= 0; i -= 1) {
        const dt = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
        out.push(`${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}`);
    }
    return out;
}

function isMsBundleExportRow(row) {
    const t = String(row?.type || '').toLowerCase();
    return t.includes('комплект');
}

/**
 * Пересобирает кэш состава комплектов для одного component_code.
 * Ищет кандидатов через LIKE по `payload_json`, затем точно парсит `components.rows`.
 * Суммирует quantity по **всем** строкам с тем же кодом или артикулом компонента (в МС несколько строк на один товар).
 */
async function refreshBundleComponentsCache(db, componentCode) {
    const safe = safeMsCodeForLike(componentCode);
    if (!safe) return 0;
    await ensureBundleComponentsSchema(db);
    const likeCodeTight = `%"code":"${safe}"%`;
    const likeCodeSpace = `%"code": "${safe}"%`;
    const likeArticleTight = `%"article":"${safe}"%`;
    const likeArticleSpace = `%"article": "${safe}"%`;
    const [cands] = await db.query(
        `SELECT m.uuid AS bundle_uuid, e.code AS bundle_code, e.name AS bundle_name,
                CAST(COALESCE(e.is_archived, 0) AS UNSIGNED) AS is_archived, m.payload_json
           FROM ms_entity_details m
           INNER JOIN ms_export e ON e.uuid = m.uuid
          WHERE m.kind = 'bundle' AND (
                m.payload_json LIKE ? OR m.payload_json LIKE ?
             OR m.payload_json LIKE ? OR m.payload_json LIKE ?
              )`,
        [likeCodeTight, likeCodeSpace, likeArticleTight, likeArticleSpace],
    );
    const upserts = [];
    for (const row of cands) {
        const payload = parsePayloadSafe(row.payload_json);
        const crows = payload?.components?.rows;
        if (!Array.isArray(crows)) continue;
        let sumQ = 0;
        for (const cr of crows) {
            const a = cr?.assortment || {};
            const code = String(a.code || '').trim();
            const article = String(a.article || '').trim();
            if (code !== safe && article !== safe) continue;
            const q = Number(cr.quantity);
            if (Number.isFinite(q) && q > 0) sumQ += q;
        }
        if (sumQ <= 0) continue;
        upserts.push({
            bundle_uuid: String(row.bundle_uuid),
            bundle_code: String(row.bundle_code || ''),
            component_code: safe,
            qty_per_bundle: sumQ,
            bundle_name: row.bundle_name ? String(row.bundle_name).slice(0, 500) : '',
            is_archived: Number(row.is_archived || 0) ? 1 : 0,
        });
    }
    await db.query('DELETE FROM dg_bundle_components WHERE component_code = ?', [safe]);
    if (!upserts.length) return 0;
    const CHUNK = 40;
    for (let i = 0; i < upserts.length; i += CHUNK) {
        const chunk = upserts.slice(i, i + CHUNK);
        const placeholders = chunk.map(() => '(?, ?, ?, ?, ?, ?)').join(', ');
        const flat = [];
        for (const u of chunk) {
            flat.push(u.bundle_uuid, u.bundle_code, u.component_code, u.qty_per_bundle, u.bundle_name, u.is_archived);
        }
        await db.query(
            `INSERT INTO dg_bundle_components
                (bundle_uuid, bundle_code, component_code, qty_per_bundle, bundle_name, is_archived)
             VALUES ${placeholders}`,
            flat,
        );
    }
    return upserts.length;
}

/** @returns {Promise<number|undefined>} число вставленных строк кэша комплектов; `undefined` — пропуск (комплект, невалидный код, кулдаун). */
async function ensureBundleComponentsForProduct(db, componentCode, isBundleProduct) {
    if (isBundleProduct) return undefined;
    const safe = safeMsCodeForLike(componentCode);
    if (!safe) return undefined;
    await ensureBundleComponentsSchema(db);
    const now = Date.now();
    if (bundleComponentsLastBuiltMs.has(safe)) {
        const last = bundleComponentsLastBuiltMs.get(safe);
        if (now - last < BUNDLE_COMPONENTS_REBUILD_COOLDOWN_MS) return undefined;
    }
    const n = await refreshBundleComponentsCache(db, safe);
    bundleComponentsLastBuiltMs.set(safe, now);
    return n;
}

/**
 * Для страницы товара и пагинации отгрузок: при свежих строках в `dg_bundle_components` или недавнем
 * «пустом» ответе — не вызывать `refreshBundleComponentsCache` (4× LIKE по большому JSON).
 */
async function maybeRefreshBundleComponentsForProductView(db, componentCode, isBundleProduct) {
    if (isBundleProduct) return;
    const safe = safeMsCodeForLike(componentCode);
    if (!safe) return;
    await ensureBundleComponentsSchema(db);
    const now = Date.now();
    const [statRows] = await db.query(
        `SELECT COUNT(*) AS c, MAX(updated_at) AS mx FROM dg_bundle_components WHERE component_code = ?`,
        [safe],
    );
    const st = statRows && statRows[0];
    const cnt = Number(st && st.c != null ? st.c : 0);
    const mx = st && st.mx ? new Date(st.mx).getTime() : 0;
    if (cnt > 0 && mx && now - mx < PRODUCT_CARD_BUNDLE_CACHE_FRESH_MS) {
        return;
    }
    if (cnt === 0) {
        const neg = bundleComponentsEmptyNegativeAt.get(safe);
        if (neg && now - neg < PRODUCT_CARD_BUNDLE_EMPTY_NEGATIVE_MS) {
            return;
        }
    }
    const n = await ensureBundleComponentsForProduct(db, componentCode, isBundleProduct);
    if (n === 0) {
        bundleComponentsEmptyNegativeAt.set(safe, now);
    } else if (typeof n === 'number' && n > 0) {
        bundleComponentsEmptyNegativeAt.delete(safe);
    }
}

async function loadViaBundlesDetail(db, componentCode, window, includeViaBundles, projFilter = NO_PROJECT_FILTER) {
    if (!includeViaBundles) return [];
    const safe = safeMsCodeForLike(componentCode);
    if (!safe) return [];
    const mf = buildSalesMomentFilter(window);
    const proj = projFilter || NO_PROJECT_FILTER;
    const [rows] = await db.query(
        `SELECT bc.bundle_code,
                MAX(bc.bundle_name) AS bundle_name,
                MAX(bc.is_archived) AS is_archived,
                COUNT(*) AS positions,
                COALESCE(SUM(p.quantity), 0) AS sold_bundles,
                COALESCE(SUM(p.quantity * bc.qty_per_bundle), 0) AS equivalent_qty,
                COALESCE(SUM(p.sum_minor * (bc.qty_per_bundle / NULLIF(tot.qty_sum, 0))), 0) / 100 AS equivalent_amount
           FROM ms_demand_position p
           INNER JOIN ms_demand d ON d.uuid = p.demand_uuid
           INNER JOIN dg_bundle_components bc ON bc.bundle_code = p.ms_export_code AND bc.component_code = ?
           INNER JOIN (
                SELECT bundle_uuid, SUM(qty_per_bundle) AS qty_sum
                  FROM dg_bundle_components
                 GROUP BY bundle_uuid
               ) tot ON tot.bundle_uuid = bc.bundle_uuid
          WHERE d.applicable = 1
            ${mf.clause}${proj.sql}
          GROUP BY bc.bundle_code
          ORDER BY equivalent_qty DESC, equivalent_amount DESC`,
        [safe, ...mf.params, ...proj.params],
    );
    return rows.map((r) => ({
        bundle_code: String(r.bundle_code || ''),
        bundle_name: r.bundle_name ? String(r.bundle_name) : '',
        is_archived: Number(r.is_archived || 0),
        positions: Number(r.positions || 0),
        sold_bundles: Number(r.sold_bundles || 0),
        equivalent_qty: Number(r.equivalent_qty || 0),
        equivalent_amount: Number(r.equivalent_amount || 0),
    }));
}

/** Прямые продажи по коду товара в позиции отгрузки за окно `window` (только проведённые документы). */
async function loadDirectSalesPeriod(db, code, window, projFilter = NO_PROJECT_FILTER) {
    const mf = buildSalesMomentFilter(window);
    const proj = projFilter || NO_PROJECT_FILTER;
    const [rows] = await db.query(
        `SELECT COALESCE(SUM(p.quantity), 0) AS sum_qty,
                COALESCE(SUM(p.sum_minor), 0) AS sum_amount_minor,
                COUNT(*) AS positions
           FROM ms_demand_position p
           INNER JOIN ms_demand d ON d.uuid = p.demand_uuid
          WHERE p.ms_export_code = ?
            AND d.applicable = 1
            ${mf.clause}${proj.sql}`,
        [code, ...mf.params, ...proj.params],
    );
    const r = rows && rows[0] ? rows[0] : { sum_qty: 0, sum_amount_minor: 0, positions: 0 };
    return {
        sum_qty: Number(r.sum_qty || 0),
        sum_amount: Number(r.sum_amount_minor || 0) / 100,
        positions: Number(r.positions || 0),
    };
}

/** Эквивалент компонента через проданные комплекты за окно `window` (только проведённые). */
async function loadBundlesEquivalentPeriod(db, componentCode, window, includeViaBundles, projFilter = NO_PROJECT_FILTER) {
    if (!includeViaBundles) return null;
    const safe = safeMsCodeForLike(componentCode);
    if (!safe) {
        return { sum_qty: 0, sum_amount: 0, positions: 0 };
    }
    const mf = buildSalesMomentFilter(window);
    const proj = projFilter || NO_PROJECT_FILTER;
    const [rows] = await db.query(
        `SELECT COALESCE(SUM(p.quantity * bc.qty_per_bundle), 0) AS sum_qty,
                COALESCE(SUM(p.sum_minor * (bc.qty_per_bundle / NULLIF(tot.qty_sum, 0))), 0) AS sum_amount_minor,
                COUNT(*) AS positions
           FROM ms_demand_position p
           INNER JOIN ms_demand d ON d.uuid = p.demand_uuid
           INNER JOIN dg_bundle_components bc ON bc.bundle_code = p.ms_export_code AND bc.component_code = ?
           INNER JOIN (
                SELECT bundle_uuid, SUM(qty_per_bundle) AS qty_sum
                  FROM dg_bundle_components
                 GROUP BY bundle_uuid
               ) tot ON tot.bundle_uuid = bc.bundle_uuid
          WHERE d.applicable = 1
            ${mf.clause}${proj.sql}`,
        [safe, ...mf.params, ...proj.params],
    );
    const r = rows && rows[0] ? rows[0] : { sum_qty: 0, sum_amount_minor: 0, positions: 0 };
    return {
        sum_qty: Number(r.sum_qty || 0),
        sum_amount: Number(r.sum_amount_minor || 0) / 100,
        positions: Number(r.positions || 0),
    };
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

function toMoneyRub(centsRaw) {
    const cents = Number(centsRaw);
    if (!Number.isFinite(cents)) return null;
    return Math.round(cents) / 100;
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

/** Нормализуем атрибуты payload в формат [{name, value, type}]. */
function extractAttributes(payload) {
    const arr = [];
    if (!payload || !Array.isArray(payload.attributes)) return arr;
    for (const a of payload.attributes) {
        if (!a) continue;
        const name = String(a.name || a.id || '').trim();
        if (!name) continue;
        let value = a.value;
        if (value && typeof value === 'object') {
            if (typeof value.name === 'string' && value.name) value = value.name;
            else if (typeof value.value === 'string' && value.value) value = value.value;
            else value = JSON.stringify(value);
        }
        arr.push({
            name,
            type: a.type || '',
            value: value == null ? '' : String(value),
        });
    }
    return arr;
}

/** Все цены продажи + buy/min из payload, в нормализованном виде. */
function extractPrices(payload) {
    const prices = [];
    if (!payload) return prices;
    if (payload.buyPrice && payload.buyPrice.value != null) {
        const v = toMoneyRub(payload.buyPrice.value);
        if (v != null) prices.push({ kind: 'buy', name: 'Закупочная цена', value: v, currency: payload.buyPrice?.currency?.code || 'RUB' });
    }
    if (payload.minPrice && payload.minPrice.value != null) {
        const v = toMoneyRub(payload.minPrice.value);
        if (v != null) prices.push({ kind: 'min', name: 'Минимальная цена', value: v, currency: payload.minPrice?.currency?.code || 'RUB' });
    }
    if (Array.isArray(payload.salePrices)) {
        for (const sp of payload.salePrices) {
            if (!sp || sp.value == null) continue;
            const v = toMoneyRub(sp.value);
            if (v == null) continue;
            const name = String(sp?.priceType?.name || 'Цена продажи').trim();
            prices.push({
                kind: 'sale',
                name,
                value: v,
                currency: sp?.currency?.code || 'RUB',
            });
        }
    }
    return prices;
}

function extractPackagings(payload) {
    const out = [];
    if (!payload || !Array.isArray(payload.packagings)) return out;
    for (const pk of payload.packagings) {
        if (!pk) continue;
        out.push({
            name: String(pk?.name || '').trim() || (pk?.parentpackagingref ? 'Упаковка' : ''),
            quantity: pk?.quantity != null ? Number(pk.quantity) : null,
            barcodes: Array.isArray(pk?.barcodes)
                ? pk.barcodes.map((b) => (typeof b === 'string' ? b : (b?.ean13 || b?.ean8 || b?.code128 || ''))).filter(Boolean)
                : [],
        });
    }
    return out;
}

function extractBarcodes(payload) {
    if (!payload || !Array.isArray(payload.barcodes)) return [];
    const out = [];
    for (const b of payload.barcodes) {
        if (!b) continue;
        if (typeof b === 'string') out.push(b);
        else if (b.ean13) out.push(`EAN13: ${b.ean13}`);
        else if (b.ean8) out.push(`EAN8: ${b.ean8}`);
        else if (b.code128) out.push(`Code128: ${b.code128}`);
    }
    return out;
}

/** Остаток + ожидание (если в payload встретился `inTransit`). */
function extractStock(msExportRow, payload) {
    const stock = msExportRow ? Number(msExportRow.stock || 0) : 0;
    const reserve = payload && payload.reserve != null ? Number(payload.reserve) : null;
    const inTransit = payload && payload.inTransit != null ? Number(payload.inTransit) : null;
    return {
        stock: Number.isFinite(stock) ? stock : 0,
        reserve: Number.isFinite(reserve) ? reserve : null,
        in_transit: Number.isFinite(inTransit) ? inTransit : null,
        min_stock: msExportRow && msExportRow.min_stock != null ? Number(msExportRow.min_stock) : null,
    };
}

async function loadSalesAggregates(db, code, componentCode, includeViaBundles, projFilter = NO_PROJECT_FILTER) {
    const proj = projFilter || NO_PROJECT_FILTER;
    const out = {};
    for (const days of SALES_WINDOWS) {
        const [dRows] = await db.query(
            `SELECT
                COALESCE(SUM(p.quantity), 0) AS sum_qty,
                COALESCE(SUM(p.sum_minor), 0) AS sum_amount_minor,
                COUNT(*) AS positions
             FROM ms_demand_position p
             INNER JOIN ms_demand d ON d.uuid = p.demand_uuid
             WHERE p.ms_export_code = ?
               AND d.applicable = 1
               AND d.moment >= (NOW() - INTERVAL ? DAY)${proj.sql}`,
            [code, days, ...proj.params],
        );
        const dr = dRows && dRows[0] ? dRows[0] : { sum_qty: 0, sum_amount_minor: 0, positions: 0 };
        let sumQty = Number(dr.sum_qty || 0);
        let sumAmtMinor = Number(dr.sum_amount_minor || 0);
        let positions = Number(dr.positions || 0);

        if (includeViaBundles) {
            const safe = safeMsCodeForLike(componentCode);
            if (safe) {
                const [bRows] = await db.query(
                    `SELECT
                        COALESCE(SUM(p.quantity * bc.qty_per_bundle), 0) AS sum_qty,
                        COALESCE(SUM(p.sum_minor * (bc.qty_per_bundle / NULLIF(tot.qty_sum, 0))), 0) AS sum_amount_minor,
                        COUNT(*) AS positions
                     FROM ms_demand_position p
                     INNER JOIN ms_demand d ON d.uuid = p.demand_uuid
                     INNER JOIN dg_bundle_components bc ON bc.bundle_code = p.ms_export_code AND bc.component_code = ?
                     INNER JOIN (
                            SELECT bundle_uuid, SUM(qty_per_bundle) AS qty_sum
                              FROM dg_bundle_components
                             GROUP BY bundle_uuid
                           ) tot ON tot.bundle_uuid = bc.bundle_uuid
                     WHERE d.applicable = 1
                       AND d.moment >= (NOW() - INTERVAL ? DAY)${proj.sql}`,
                    [safe, days, ...proj.params],
                );
                const br = bRows && bRows[0] ? bRows[0] : { sum_qty: 0, sum_amount_minor: 0, positions: 0 };
                sumQty += Number(br.sum_qty || 0);
                sumAmtMinor += Number(br.sum_amount_minor || 0);
                positions += Number(br.positions || 0);
            }
        }

        out[`d${days}`] = {
            days,
            sum_qty: sumQty,
            sum_amount: sumAmtMinor / 100,
            positions,
            avg_per_day: days > 0 ? sumQty / days : 0,
        };
    }
    return out;
}

/** Сумма quantity за последние `days` календарных дней (прямые + через комплекты). */
async function loadSalesSumLastDays(db, code, componentCode, includeViaBundles, days, appSettings) {
    const W = Math.min(365 * 2, Math.max(1, Math.round(Number(days) || 90)));
    const proj = msDemandProjectFilterClause(appSettings || {});
    const [dRows] = await db.query(
        `SELECT COALESCE(SUM(p.quantity), 0) AS sum_qty
           FROM ms_demand_position p
           INNER JOIN ms_demand d ON d.uuid = p.demand_uuid
          WHERE p.ms_export_code = ?
            AND d.applicable = 1
            AND d.moment >= (NOW() - INTERVAL ? DAY)${proj.sql}`,
        [code, W, ...proj.params],
    );
    let sumQty = Number((dRows && dRows[0] && dRows[0].sum_qty) || 0);

    if (includeViaBundles) {
        const safe = safeMsCodeForLike(componentCode);
        if (safe) {
            const [bRows] = await db.query(
                `SELECT COALESCE(SUM(p.quantity * bc.qty_per_bundle), 0) AS sum_qty
                   FROM ms_demand_position p
                   INNER JOIN ms_demand d ON d.uuid = p.demand_uuid
                   INNER JOIN dg_bundle_components bc ON bc.bundle_code = p.ms_export_code AND bc.component_code = ?
                   INNER JOIN (
                        SELECT bundle_uuid, SUM(qty_per_bundle) AS qty_sum
                          FROM dg_bundle_components
                         GROUP BY bundle_uuid
                       ) tot ON tot.bundle_uuid = bc.bundle_uuid
                  WHERE d.applicable = 1
                    AND d.moment >= (NOW() - INTERVAL ? DAY)${proj.sql}`,
                [safe, W, ...proj.params],
            );
            sumQty += Number((bRows && bRows[0] && bRows[0].sum_qty) || 0);
        }
    }

    return { days: W, sum_qty: sumQty };
}

/** Сколько календарных дней с записью «нулевого» остатка за последние `days`. */
async function loadZeroStockDistinctDays(db, code, days) {
    await ensureZeroStockSchema(db);
    const period = Math.min(365 * 5, Math.max(1, Math.round(Number(days) || 90)));
    const [cntRows] = await db.query(
        `SELECT COUNT(DISTINCT ts_date) AS c
           FROM dg_product_zero_stock_log
          WHERE code = ?
            AND ts_date >= (CURDATE() - INTERVAL ? DAY)`,
        [code, period],
    );
    return { days: period, distinct_days: Number((cntRows && cntRows[0] && cntRows[0].c) || 0) };
}

/**
 * Помесячный ряд продаж за окно `window`.
 * При календарном диапазоне — месяцы от `sales_from` до `sales_to`; иначе последние ceil(recent_days/30) мес. от текущей даты.
 */
async function loadMonthlySales(db, code, componentCode, includeViaBundles, window, projFilter = NO_PROJECT_FILTER) {
    const mf = buildSalesMomentFilter(window);
    const proj = projFilter || NO_PROJECT_FILTER;
    const [directRows] = await db.query(
        `SELECT DATE_FORMAT(d.moment, '%Y-%m') AS ym,
                COALESCE(SUM(p.quantity), 0) AS sum_qty,
                COALESCE(SUM(p.sum_minor), 0) AS sum_amount_minor,
                COUNT(*) AS positions
           FROM ms_demand_position p
           INNER JOIN ms_demand d ON d.uuid = p.demand_uuid
          WHERE p.ms_export_code = ?
            AND d.applicable = 1
            ${mf.clause}${proj.sql}
          GROUP BY ym
          ORDER BY ym ASC`,
        [code, ...mf.params, ...proj.params],
    );

    const map = new Map();
    for (const r of directRows) {
        map.set(String(r.ym), {
            sum_qty: Number(r.sum_qty || 0),
            sum_amount: Number(r.sum_amount_minor || 0) / 100,
            positions: Number(r.positions || 0),
        });
    }

    if (includeViaBundles) {
        const safe = safeMsCodeForLike(componentCode);
        if (safe) {
            const [bRows] = await db.query(
                `SELECT DATE_FORMAT(d.moment, '%Y-%m') AS ym,
                        COALESCE(SUM(p.quantity * bc.qty_per_bundle), 0) AS sum_qty,
                        COALESCE(SUM(p.sum_minor * (bc.qty_per_bundle / NULLIF(tot.qty_sum, 0))), 0) AS sum_amount_minor,
                        COUNT(*) AS positions
                   FROM ms_demand_position p
                   INNER JOIN ms_demand d ON d.uuid = p.demand_uuid
                   INNER JOIN dg_bundle_components bc ON bc.bundle_code = p.ms_export_code AND bc.component_code = ?
                   INNER JOIN (
                        SELECT bundle_uuid, SUM(qty_per_bundle) AS qty_sum
                          FROM dg_bundle_components
                         GROUP BY bundle_uuid
                       ) tot ON tot.bundle_uuid = bc.bundle_uuid
                  WHERE d.applicable = 1
                    ${mf.clause}${proj.sql}
                  GROUP BY ym
                  ORDER BY ym ASC`,
                [safe, ...mf.params, ...proj.params],
            );
            for (const r of bRows) {
                const k = String(r.ym);
                const cur = map.get(k) || { sum_qty: 0, sum_amount: 0, positions: 0 };
                cur.sum_qty += Number(r.sum_qty || 0);
                cur.sum_amount += Number(r.sum_amount_minor || 0) / 100;
                cur.positions += Number(r.positions || 0);
                map.set(k, cur);
            }
        }
    }

    const monthKeys = window.useRange
        ? enumerateCalendarMonths(window.fromDateStr, window.toDateStr)
        : enumerateRollingMonths(window.daysRolling);
    return monthKeys.map((ym) => {
        const v = map.get(ym) || { sum_qty: 0, sum_amount: 0, positions: 0 };
        return { month: ym, ...v };
    });
}

/**
 * Распределение продаж по `groupCol` (`d.agent_name` | `d.store_name`) за окно.
 * Топ N + «Прочие». Сумма sum_qty и sum_amount.
 */
async function loadSalesBreakdown(db, code, componentCode, includeViaBundles, window, groupCol, topN, projFilter = NO_PROJECT_FILTER) {
    const mf = buildSalesMomentFilter(window);
    const proj = projFilter || NO_PROJECT_FILTER;
    const safeCol = groupCol === 'd.store_name' ? 'd.store_name' : 'd.agent_name';

    const mergeMap = new Map();

    const [dirRows] = await db.query(
        `SELECT COALESCE(NULLIF(${safeCol}, ''), '(не указано)') AS label,
                COALESCE(SUM(p.quantity), 0) AS sum_qty,
                COALESCE(SUM(p.sum_minor), 0) AS sum_amount_minor,
                COUNT(*) AS positions
           FROM ms_demand_position p
           INNER JOIN ms_demand d ON d.uuid = p.demand_uuid
          WHERE p.ms_export_code = ?
            AND d.applicable = 1
            ${mf.clause}${proj.sql}
          GROUP BY label
          ORDER BY sum_qty DESC, sum_amount_minor DESC`,
        [code, ...mf.params, ...proj.params],
    );
    for (const r of dirRows) {
        const label = String(r.label || '(не указано)');
        mergeMap.set(label, {
            label,
            sum_qty: Number(r.sum_qty || 0),
            sum_amount: Number(r.sum_amount_minor || 0) / 100,
            positions: Number(r.positions || 0),
        });
    }

    if (includeViaBundles) {
        const safe = safeMsCodeForLike(componentCode);
        if (safe) {
            const [bRows] = await db.query(
                `SELECT COALESCE(NULLIF(${safeCol}, ''), '(не указано)') AS label,
                        COALESCE(SUM(p.quantity * bc.qty_per_bundle), 0) AS sum_qty,
                        COALESCE(SUM(p.sum_minor * (bc.qty_per_bundle / NULLIF(tot.qty_sum, 0))), 0) AS sum_amount_minor,
                        COUNT(*) AS positions
                   FROM ms_demand_position p
                   INNER JOIN ms_demand d ON d.uuid = p.demand_uuid
                   INNER JOIN dg_bundle_components bc ON bc.bundle_code = p.ms_export_code AND bc.component_code = ?
                   INNER JOIN (
                        SELECT bundle_uuid, SUM(qty_per_bundle) AS qty_sum
                          FROM dg_bundle_components
                         GROUP BY bundle_uuid
                       ) tot ON tot.bundle_uuid = bc.bundle_uuid
                  WHERE d.applicable = 1
                    ${mf.clause}${proj.sql}
                  GROUP BY label
                  ORDER BY sum_qty DESC, sum_amount_minor DESC`,
                [safe, ...mf.params, ...proj.params],
            );
            for (const r of bRows) {
                const label = String(r.label || '(не указано)');
                const cur = mergeMap.get(label) || { label, sum_qty: 0, sum_amount: 0, positions: 0 };
                cur.sum_qty += Number(r.sum_qty || 0);
                cur.sum_amount += Number(r.sum_amount_minor || 0) / 100;
                cur.positions += Number(r.positions || 0);
                mergeMap.set(label, cur);
            }
        }
    }

    const merged = Array.from(mergeMap.values()).sort(
        (a, b) => b.sum_qty - a.sum_qty || b.sum_amount - a.sum_amount || b.positions - a.positions,
    );

    const top = Math.min(20, Math.max(3, Number(topN) || 8));
    const head = merged.slice(0, top);
    const tail = merged.slice(top);
    const out = head.map((x) => ({ ...x }));
    if (tail.length) {
        const tailSum = tail.reduce(
            (acc, r) => {
                acc.sum_qty += r.sum_qty;
                acc.sum_amount += r.sum_amount;
                acc.positions += r.positions;
                return acc;
            },
            { sum_qty: 0, sum_amount: 0, positions: 0 },
        );
        out.push({ label: `Прочие (${tail.length})`, ...tailSum });
    }
    return out;
}

function parseRecentShipmentsRequest(req) {
    const pageSize = Math.min(200, Math.max(10, parseInt(req.query.recent_page_size, 10) || 100));
    const page = Math.max(1, parseInt(req.query.recent_page, 10) || 1);
    const offset = (page - 1) * pageSize;
    const via = String(req.query.recent_via || 'all').trim().toLowerCase();
    const bRaw = String(req.query.recent_bundle_code || '').trim();
    const bSafe = safeMsCodeForLike(bRaw);
    let mode = 'all';
    let bundleCode = '';
    if (via === 'direct') mode = 'direct';
    else if (via === 'bundle') {
        if (bSafe) {
            mode = 'bundle_one';
            bundleCode = bSafe;
        } else mode = 'bundle_all';
    }
    return { page, pageSize, offset, limit: pageSize, mode, bundleCode };
}

function mapRecentShipmentRow(r) {
    const qty = Number(r.quantity || 0);
    const sum = Number(r.sum_amount != null ? r.sum_amount : 0);
    const price = Number(r.price != null ? r.price : 0);
    const via = String(r.via || '') === 'bundle' ? 'bundle' : 'direct';
    return {
        demand_uuid: String(r.demand_uuid),
        doc_name: String(r.doc_name || ''),
        moment: r.sort_moment ? new Date(r.sort_moment).toISOString() : null,
        applicable: !!r.applicable,
        agent_name: r.agent_name ? String(r.agent_name) : '',
        store_name: r.store_name ? String(r.store_name) : '',
        position_uuid: String(r.position_uuid || ''),
        assortment_kind: String(r.assortment_kind || ''),
        via,
        bundle_code: via === 'bundle' ? String(r.bundle_code || '') : '',
        bundle_name: via === 'bundle' ? String(r.bundle_name || '') : '',
        bundle_qty: r.bundle_qty != null ? Number(r.bundle_qty) : null,
        qty_per_bundle: r.qty_per_bundle != null ? Number(r.qty_per_bundle) : null,
        quantity: qty,
        price,
        sum,
    };
}

function buildProductSalesNote(includeViaBundles, projectScopeLabel) {
    const base = includeViaBundles
        ? 'Графики, сводка за период и «Последние отгрузки» — только проведённые отгрузки (applicable); прямые продажи + эквивалент через комплекты (состав из payload МС; сумма по доле компонента). Продажи за период — агрегаты по фиксированным интервалам 3…365 дн., как в таблице выше.'
        : 'Страница комплекта: эквивалент через другие комплекты не считается. Учитываются только проведённые отгрузки.';
    if (projectScopeLabel) {
        return `${base} Учёт проектов: ${projectScopeLabel}`;
    }
    return `${base} Учёт проектов: все отгрузки МС.`;
}

/**
 * Блок «Продажи товара» (агрегаты, графики, последние отгрузки) с опциональным фильтром по project_uuid.
 */
async function loadProductSalesBlock(
    db,
    code,
    componentCode,
    includeViaBundles,
    salesWindow,
    recentRp,
    projFilter,
    projectScopeLabel,
) {
    const [
        aggregates,
        recentPack,
        monthlySales,
        byAgent,
        byStore,
        viaBundlesDetail,
        directPeriod,
        bundlesPeriod,
    ] = await Promise.all([
        loadSalesAggregates(db, code, code, includeViaBundles, projFilter),
        loadRecentShipmentsPaged(db, code, code, includeViaBundles, salesWindow, recentRp, projFilter),
        loadMonthlySales(db, code, code, includeViaBundles, salesWindow, projFilter),
        loadSalesBreakdown(db, code, code, includeViaBundles, salesWindow, 'd.agent_name', 8, projFilter),
        loadSalesBreakdown(db, code, code, includeViaBundles, salesWindow, 'd.store_name', 8, projFilter),
        loadViaBundlesDetail(db, code, salesWindow, includeViaBundles, projFilter),
        loadDirectSalesPeriod(db, code, salesWindow, projFilter),
        loadBundlesEquivalentPeriod(db, code, salesWindow, includeViaBundles, projFilter),
    ]);
    const recentTotal = recentPack.total;
    const recentTotalPages = Math.max(1, Math.ceil(recentTotal / recentRp.pageSize));
    return {
        aggregates,
        recent: recentPack.rows,
        recent_days: salesWindow.spanDays,
        recent_page: recentRp.page,
        recent_page_size: recentRp.pageSize,
        recent_total: recentTotal,
        recent_total_pages: recentTotalPages,
        recent_via: recentRp.mode === 'bundle_one' ? 'bundle' : recentRp.mode === 'all' ? 'all' : recentRp.mode,
        recent_bundle_code: recentRp.mode === 'bundle_one' ? recentRp.bundleCode : '',
        recent_bundle_codes: recentPack.bundle_codes,
        sales_window: {
            mode: salesWindow.useRange ? 'range' : 'rolling',
            sales_from: salesWindow.fromDateStr,
            sales_to: salesWindow.toDateStr,
        },
        direct_period: directPeriod,
        bundles_period: bundlesPeriod,
        monthly: monthlySales,
        by_agent: byAgent,
        by_store: byStore,
        includes_via_bundles: includeViaBundles,
        via_bundles: viaBundlesDetail,
        note: buildProductSalesNote(includeViaBundles, projectScopeLabel),
        sales_scope: projectScopeLabel ? 'formula' : 'all',
    };
}

/**
 * Прямые + через комплекты, один UNION, фильтр и LIMIT/OFFSET на сервере.
 * @returns {{ rows: object[], total: number, bundle_codes: { bundle_code: string, bundle_name: string }[] }}
 */
async function loadRecentShipmentsPaged(db, code, componentCode, includeViaBundles, window, rp, projFilter = NO_PROJECT_FILTER) {
    const mf = buildSalesMomentFilter(window);
    const proj = projFilter || NO_PROJECT_FILTER;
    const safeComp = safeMsCodeForLike(componentCode);

    const directSql = `
        SELECT d.moment AS sort_moment, d.uuid AS demand_uuid, d.doc_name, d.applicable,
               d.agent_name, d.store_name, p.position_uuid, p.assortment_kind,
               'direct' AS via, '' AS bundle_code, '' AS bundle_name,
               NULL AS bundle_qty, NULL AS qty_per_bundle,
               CAST(p.quantity AS DECIMAL(18,6)) AS quantity,
               (CAST(p.price_minor AS DECIMAL(24,4)) / 100) AS price,
               (CAST(p.sum_minor AS DECIMAL(24,4)) / 100) AS sum_amount
          FROM ms_demand_position p
          INNER JOIN ms_demand d ON d.uuid = p.demand_uuid
         WHERE p.ms_export_code = ?
           AND d.applicable = 1
           ${mf.clause}${proj.sql}`;

    const paramsDirect = [code, ...mf.params, ...proj.params];

    let innerSql;
    let innerParams;
    if (includeViaBundles && safeComp) {
        const bundleSql = `
        SELECT d.moment AS sort_moment, d.uuid AS demand_uuid, d.doc_name, d.applicable,
               d.agent_name, d.store_name, p.position_uuid, p.assortment_kind,
               'bundle' AS via, bc.bundle_code AS bundle_code, COALESCE(bc.bundle_name, '') AS bundle_name,
               CAST(p.quantity AS DECIMAL(18,6)) AS bundle_qty,
               CAST(bc.qty_per_bundle AS DECIMAL(18,6)) AS qty_per_bundle,
               CAST(p.quantity * bc.qty_per_bundle AS DECIMAL(18,6)) AS quantity,
               CASE WHEN (p.quantity * bc.qty_per_bundle) > 0
                    THEN ((CAST(p.sum_minor AS DECIMAL(38,6)) * CAST(bc.qty_per_bundle AS DECIMAL(38,6))
                           / NULLIF(CAST(tot.qty_sum AS DECIMAL(38,6)), 0) / 100)
                         / CAST(p.quantity * bc.qty_per_bundle AS DECIMAL(38,6)))
                    ELSE 0 END AS price,
               (CAST(p.sum_minor AS DECIMAL(38,6)) * CAST(bc.qty_per_bundle AS DECIMAL(38,6))
                 / NULLIF(CAST(tot.qty_sum AS DECIMAL(38,6)), 0) / 100) AS sum_amount
          FROM ms_demand_position p
          INNER JOIN ms_demand d ON d.uuid = p.demand_uuid
          INNER JOIN dg_bundle_components bc ON bc.bundle_code = p.ms_export_code AND bc.component_code = ?
          INNER JOIN (
               SELECT bundle_uuid, SUM(qty_per_bundle) AS qty_sum
                 FROM dg_bundle_components
                GROUP BY bundle_uuid
               ) tot ON tot.bundle_uuid = bc.bundle_uuid
         WHERE d.applicable = 1
           ${mf.clause}${proj.sql}`;
        const paramsBundle = [safeComp, ...mf.params, ...proj.params];
        innerSql = `(${directSql.trim()}) UNION ALL (${bundleSql.trim()})`;
        innerParams = [...paramsDirect, ...paramsBundle];
    } else {
        innerSql = `(${directSql.trim()})`;
        innerParams = paramsDirect;
    }

    let filterSql = ' WHERE 1=1 ';
    const filterParams = [];
    if (rp.mode === 'direct') filterSql = " WHERE u.via = 'direct' ";
    else if (rp.mode === 'bundle_all') filterSql = " WHERE u.via = 'bundle' ";
    else if (rp.mode === 'bundle_one') {
        filterSql = " WHERE u.via = 'bundle' AND u.bundle_code = ? ";
        filterParams.push(rp.bundleCode);
    }

    const countSql = `SELECT COUNT(*) AS c FROM (${innerSql}) u ${filterSql}`;
    const [cntRows] = await db.query(countSql, [...innerParams, ...filterParams]);
    const total = Number(cntRows?.[0]?.c || 0);

    const dataSql = `SELECT * FROM (${innerSql}) u ${filterSql} ORDER BY sort_moment DESC, demand_uuid DESC, position_uuid DESC LIMIT ? OFFSET ?`;
    const [rows] = await db.query(dataSql, [...innerParams, ...filterParams, rp.limit, rp.offset]);

    let bundle_codes = [];
    if (includeViaBundles && safeComp) {
        const [bcRows] = await db.query(
            `SELECT bundle_code, MAX(bundle_name) AS bundle_name
               FROM dg_bundle_components
              WHERE component_code = ?
              GROUP BY bundle_code
              ORDER BY bundle_code
              LIMIT 500`,
            [safeComp],
        );
        bundle_codes = (bcRows || []).map((x) => ({
            bundle_code: String(x.bundle_code || ''),
            bundle_name: x.bundle_name ? String(x.bundle_name) : '',
        }));
    }

    return {
        rows: (rows || []).map(mapRecentShipmentRow),
        total,
        bundle_codes,
    };
}

/**
 * После полной выгрузки МС в `ms_export`: одним запросом фиксируем «нулевой день» за CURDATE()
 * для позиций со складской позицией «Да», не в архиве, если остаток ≤ 0 **или** (только для кода без «-»)
 * остаток < минимального суффикса среди номенклатур `<code>-<целое>` в той же выгрузке (комплекты вида 27877-2).
 * Строка за (code, __total__, сегодня) с `source=manual` не меняется.
 * @returns {{ scanned: number }}
 */
async function syncZeroStockLogAfterMoyskladExport(db) {
    await ensureZeroStockSchema(db);
    const zeroOrBundleShortSql = `
        FROM ms_export m
        LEFT JOIN (
             SELECT SUBSTRING_INDEX(code, '-', 1) AS base_code,
                    MIN(CAST(SUBSTRING_INDEX(code, '-', -1) AS UNSIGNED)) AS min_suffix
               FROM ms_export
              WHERE (LENGTH(code) - LENGTH(REPLACE(code, '-', ''))) = 1
                AND SUBSTRING_INDEX(code, '-', -1) REGEXP '^[0-9]+$'
              GROUP BY SUBSTRING_INDEX(code, '-', 1)
        ) bb ON bb.base_code = m.code
       WHERE m.stock_position = 'Да'
         AND COALESCE(m.is_archived, 0) = 0
         AND (
              COALESCE(m.stock, 0) <= 0
              OR (
                   INSTR(m.code, '-') = 0
               AND bb.min_suffix IS NOT NULL
               AND bb.min_suffix > 0
               AND COALESCE(m.stock, 0) < bb.min_suffix
              )
         )`;
    const [[cntRow]] = await db.query(`SELECT COUNT(*) AS c ${zeroOrBundleShortSql}`);
    const scanned = Number(cntRow?.c || 0);
    await db.query(
        `INSERT INTO dg_product_zero_stock_log (code, store_uuid, store_name, ts_date, total_stock, source)
         SELECT m.code, ?, NULL, CURDATE(), m.stock, 'moysklad_sync'
         ${zeroOrBundleShortSql}
         ON DUPLICATE KEY UPDATE
           total_stock = IF(source = 'manual', total_stock, VALUES(total_stock)),
           source = IF(source = 'manual', 'manual', VALUES(source))`,
        [ZERO_LOG_DEFAULT_STORE],
    );
    return { scanned };
}

/**
 * После полного синка: один снимок `stock` из `ms_export` на календарный день (CURDATE()) по каждому коду.
 * Повторный синк в тот же день перезаписывает число. Строки старше порога **retention** (настройка `product_stock_snapshot_retention_days`, по умолчанию 365 дн.) удаляются.
 * @param {number} [retentionDays] — из `app_settings.product_stock_snapshot_retention_days` (30…3650).
 * @returns {{ upserted: number }}
 */
async function syncProductStockSnapshotsAfterMoyskladExport(db, retentionDays) {
    await ensureProductStockSnapshotSchema(db);
    const keepDays = clampProductStockSnapshotRetentionDays(retentionDays);
    const [res] = await db.query(
        `INSERT INTO dg_product_stock_snapshot (code, ts_date, stock)
         SELECT m.code, CURDATE(), COALESCE(m.stock, 0)
           FROM ms_export m
         ON DUPLICATE KEY UPDATE
           stock = VALUES(stock),
           created_at = CURRENT_TIMESTAMP`,
    );
    const upserted = Number(res && res.affectedRows != null ? res.affectedRows : 0);
    await db.query(`DELETE FROM dg_product_stock_snapshot WHERE ts_date < DATE_SUB(CURDATE(), INTERVAL ? DAY)`, [keepDays]);
    return { upserted };
}

async function loadStockSnapshots(db, code, days) {
    await ensureProductStockSnapshotSchema(db);
    const period = Math.min(730, Math.max(1, Math.round(Number(days) || 365)));
    const [rows] = await db.query(
        `SELECT ts_date, stock, created_at
           FROM dg_product_stock_snapshot
          WHERE code = ?
            AND ts_date >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
          ORDER BY ts_date DESC
          LIMIT 400`,
        [code, period - 1],
    );
    return (rows || []).map((r) => ({
        ts_date: r.ts_date ? new Date(r.ts_date).toISOString().slice(0, 10) : null,
        stock: r.stock != null ? Number(r.stock) : 0,
        created_at: r.created_at ? new Date(r.created_at).toISOString() : null,
    }));
}

async function loadZeroStockLog(db, code, days) {
    await ensureZeroStockSchema(db);
    const period = Math.min(365 * 5, Math.max(1, Number(days) || 90));
    const [rows] = await db.query(
        `SELECT id, code, store_uuid, store_name, ts_date, total_stock, source, created_at
           FROM dg_product_zero_stock_log
          WHERE code = ?
            AND ts_date >= (CURDATE() - INTERVAL ? DAY)
          ORDER BY ts_date DESC, created_at DESC
          LIMIT 1000`,
        [code, period],
    );
    return rows.map((r) => ({
        id: Number(r.id),
        store_uuid: String(r.store_uuid || ZERO_LOG_DEFAULT_STORE),
        store_name: r.store_name ? String(r.store_name) : '',
        ts_date: r.ts_date ? new Date(r.ts_date).toISOString().slice(0, 10) : null,
        total_stock: r.total_stock != null ? Number(r.total_stock) : null,
        source: r.source ? String(r.source) : 'manual',
        created_at: r.created_at ? new Date(r.created_at).toISOString() : null,
    }));
}

const ZERO_STOCK_ROLLING_WINDOWS = [30, 60, 90, 180, 365];

/**
 * Скользящие окна до сегодня (дата сервера): число разных календарных дат в логе с нулём/отсутствием
 * в интервале (CURDATE() − N, CURDATE] — ровно N календарных дней, согласовано с импортом «absent_last_N».
 */
async function computeZeroStockWindowsFromLog(db, code) {
    await ensureZeroStockSchema(db);
    const safeCode = String(code || '').trim();
    if (!safeCode) {
        return {
            reference_date: null,
            absent_last_30: 0,
            absent_last_60: 0,
            absent_last_90: 0,
            absent_last_180: 0,
            absent_last_365: 0,
            source: 'zero_log',
            note_explain:
                'Числа — COUNT(DISTINCT ts_date) в dg_product_zero_stock_log по скользящим окнам до сегодняшней даты сервера.',
        };
    }
    const counts = await Promise.all(
        ZERO_STOCK_ROLLING_WINDOWS.map((w) =>
            db.query(
                `SELECT COUNT(DISTINCT ts_date) AS c
                   FROM dg_product_zero_stock_log
                  WHERE code = ?
                    AND ts_date > DATE_SUB(CURDATE(), INTERVAL ? DAY)
                    AND ts_date <= CURDATE()`,
                [safeCode, w],
            ),
        ),
    );
    let a30 = Number(counts[0][0]?.[0]?.c || 0);
    let a60 = Number(counts[1][0]?.[0]?.c || 0);
    let a90 = Number(counts[2][0]?.[0]?.c || 0);
    let a180 = Number(counts[3][0]?.[0]?.c || 0);
    let a365 = Number(counts[4][0]?.[0]?.c || 0);
    a60 = Math.max(a30, a60);
    a90 = Math.max(a60, a90);
    a180 = Math.max(a90, a180);
    a365 = Math.max(a180, a365);
    const [[drow]] = await db.query(`SELECT CURDATE() AS d`);
    const ref = drow && drow.d ? new Date(drow.d).toISOString().slice(0, 10) : null;
    return {
        reference_date: ref,
        absent_last_30: a30,
        absent_last_60: a60,
        absent_last_90: a90,
        absent_last_180: a180,
        absent_last_365: a365,
        source: 'zero_log',
        note_explain:
            'Расчёт по логу Datagon: сколько разных календарных дат с записью отсутствия в каждом скользящем окне (N дней до сегодня включительно). Не заменяет построчный лог ниже.',
    };
}

const WINDOW_IMPORT_MAX_ROWS = 100000;
const WINDOW_IMPORT_CHUNK = 500;

function mapWindowHeaderToIdx(headers) {
    const idx = { code: -1, a30: -1, a60: -1, a90: -1, a180: -1, a365: -1 };
    headers.forEach((raw, i) => {
        const t = String(raw || '')
            .trim()
            .replace(/^\uFEFF/, '')
            .replace(/^"|"$/g, '')
            .trim();
        const n = parseInt(t, 10);
        if (n === 30) idx.a30 = i;
        else if (n === 60) idx.a60 = i;
        else if (n === 90) idx.a90 = i;
        else if (n === 180) idx.a180 = i;
        else if (n === 365) idx.a365 = i;
        else {
            const k = t.toLowerCase().replace(/\s+/g, '');
            if (['code', 'код', 'кодмс', 'sku', 'артикул'].includes(k)) idx.code = i;
            if (['absent_last_30', 'absent30', 'n30', 'd30', 'zero30'].includes(k)) idx.a30 = i;
            if (['absent_last_60', 'absent60', 'n60', 'd60', 'zero60'].includes(k)) idx.a60 = i;
            if (['absent_last_90', 'absent90', 'n90', 'd90', 'zero90'].includes(k)) idx.a90 = i;
            if (['absent_last_180', 'absent180', 'n180', 'd180', 'zero180'].includes(k)) idx.a180 = i;
            if (['absent_last_365', 'absent365', 'n365', 'd365', 'zero365'].includes(k)) idx.a365 = i;
        }
    });
    return idx;
}

function splitCsvLine(line, delim) {
    return String(line || '')
        .split(delim)
        .map((s) => s.trim().replace(/^"|"$/g, '').trim());
}

function parseWindowImportCsv(text) {
    const raw = String(text || '').replace(/^\uFEFF/, '').trim();
    if (!raw) return [];
    const lines = raw
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);
    if (lines.length < 2) {
        throw new Error('CSV: нужна строка заголовка и минимум одна строка данных');
    }
    const first = lines[0];
    const delim = first.split(';').length >= 6 ? ';' : ',';
    const headerCells = splitCsvLine(first, delim);
    const idx = mapWindowHeaderToIdx(headerCells);
    if (idx.code < 0 || idx.a30 < 0 || idx.a60 < 0 || idx.a90 < 0 || idx.a180 < 0 || idx.a365 < 0) {
        throw new Error(
            'CSV: в первой строке должны быть колонки кода (code|код|…) и все окна 30, 60, 90, 180, 365 (числами или absent_last_*)',
        );
    }
    const out = [];
    for (let li = 1; li < lines.length; li += 1) {
        const cells = splitCsvLine(lines[li], delim);
        if (cells.length <= idx.code) continue;
        const code = String(cells[idx.code] || '').trim();
        if (!code) continue;
        out.push({
            code,
            absent_last_30: clampIntWindowCount(cells[idx.a30]),
            absent_last_60: clampIntWindowCount(cells[idx.a60]),
            absent_last_90: clampIntWindowCount(cells[idx.a90]),
            absent_last_180: clampIntWindowCount(cells[idx.a180]),
            absent_last_365: clampIntWindowCount(cells[idx.a365]),
        });
    }
    return out;
}

function normalizeWindowRowFromJson(r) {
    const o = r && typeof r === 'object' ? r : {};
    const code = String(o.code || o.Code || o.CODE || o.код || '').trim();
    if (!code) return null;
    return {
        code,
        absent_last_30: clampIntWindowCount(o.absent_last_30 ?? o.absent_30 ?? o.d30 ?? o.n30),
        absent_last_60: clampIntWindowCount(o.absent_last_60 ?? o.absent_60 ?? o.d60 ?? o.n60),
        absent_last_90: clampIntWindowCount(o.absent_last_90 ?? o.absent_90 ?? o.d90 ?? o.n90),
        absent_last_180: clampIntWindowCount(o.absent_last_180 ?? o.absent_180 ?? o.d180 ?? o.n180),
        absent_last_365: clampIntWindowCount(o.absent_last_365 ?? o.absent_365 ?? o.d365 ?? o.n365),
    };
}

function parseWindowImportPayload(body) {
    const b = body && typeof body === 'object' ? body : {};
    const ref = String(b.reference_date || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(ref)) {
        throw new Error('Укажите reference_date (YYYY-MM-DD) — дата среза, на которую считалась сводка в Excel');
    }
    const note = b.note != null ? String(b.note).slice(0, 512) : null;
    let rows = [];
    if (Array.isArray(b.rows) && b.rows.length) {
        rows = b.rows.map(normalizeWindowRowFromJson).filter(Boolean);
    } else if (typeof b.csv === 'string' && b.csv.trim()) {
        rows = parseWindowImportCsv(b.csv);
    } else {
        throw new Error('Передайте массив rows или строку csv (UTF-8, первая строка — заголовки)');
    }
    if (rows.length > WINDOW_IMPORT_MAX_ROWS) {
        throw new Error(`Слишком много строк (${rows.length}), максимум ${WINDOW_IMPORT_MAX_ROWS}`);
    }
    return { reference_date: ref, note, rows };
}

async function upsertWindowImportBatch(db, referenceDate, note, rows) {
    await ensureZeroStockWindowImportSchema(db);
    let done = 0;
    for (let i = 0; i < rows.length; i += WINDOW_IMPORT_CHUNK) {
        const chunk = rows.slice(i, i + WINDOW_IMPORT_CHUNK);
        const placeholders = chunk.map(() => '(?,?,?,?,?,?,?,?)').join(',');
        const params = [];
        for (const r of chunk) {
            params.push(
                referenceDate,
                r.code,
                r.absent_last_30,
                r.absent_last_60,
                r.absent_last_90,
                r.absent_last_180,
                r.absent_last_365,
                note,
            );
        }
        await db.query(
            `INSERT INTO dg_product_zero_stock_window_import
                (reference_date, code, absent_last_30, absent_last_60, absent_last_90, absent_last_180, absent_last_365, note)
             VALUES ${placeholders}
             ON DUPLICATE KEY UPDATE
                absent_last_30 = VALUES(absent_last_30),
                absent_last_60 = VALUES(absent_last_60),
                absent_last_90 = VALUES(absent_last_90),
                absent_last_180 = VALUES(absent_last_180),
                absent_last_365 = VALUES(absent_last_365),
                note = VALUES(note)`,
            params,
        );
        done += chunk.length;
    }
    return done;
}

async function loadLatestZeroStockWindowImport(db, code) {
    await ensureZeroStockWindowImportSchema(db);
    const [rows] = await db.query(
        `SELECT reference_date, absent_last_30, absent_last_60, absent_last_90,
                absent_last_180, absent_last_365, note, created_at
           FROM dg_product_zero_stock_window_import
          WHERE code = ?
          ORDER BY reference_date DESC, id DESC
          LIMIT 1`,
        [code],
    );
    if (!rows || !rows[0]) return null;
    const r = rows[0];
    return {
        reference_date: r.reference_date ? new Date(r.reference_date).toISOString().slice(0, 10) : null,
        absent_last_30: Number(r.absent_last_30 || 0),
        absent_last_60: Number(r.absent_last_60 || 0),
        absent_last_90: Number(r.absent_last_90 || 0),
        absent_last_180: Number(r.absent_last_180 || 0),
        absent_last_365: Number(r.absent_last_365 || 0),
        note: r.note ? String(r.note) : '',
        created_at: r.created_at ? new Date(r.created_at).toISOString() : null,
        note_explain:
            'Импортированная сводка: числа — сколько дней с нулевым остатком в каждом скользящем окне относительно даты среза. Это не список конкретных календарных дней.',
    };
}

/** Последняя строка импорта сводки по каждому коду (для закупок / формулы). */
async function loadLatestZeroStockWindowImportMap(db, codes) {
    await ensureZeroStockWindowImportSchema(db);
    const list = [...new Set(codes.map((c) => String(c || '').trim()).filter(Boolean))];
    if (!list.length) return new Map();
    const ph = list.map(() => '?').join(',');
    let rows;
    try {
        const [r] = await db.query(
            `SELECT code, reference_date, absent_last_30, absent_last_60, absent_last_90,
                    absent_last_180, absent_last_365
               FROM (
                 SELECT w.*, ROW_NUMBER() OVER (PARTITION BY code ORDER BY reference_date DESC, id DESC) AS rn
                   FROM dg_product_zero_stock_window_import w
                  WHERE w.code IN (${ph})
               ) t
              WHERE t.rn = 1`,
            list,
        );
        rows = r;
    } catch (_) {
        const [r2] = await db.query(
            `SELECT w.code, w.reference_date, w.absent_last_30, w.absent_last_60, w.absent_last_90,
                    w.absent_last_180, w.absent_last_365
               FROM dg_product_zero_stock_window_import w
               INNER JOIN (
                 SELECT code, MAX(id) AS max_id
                   FROM dg_product_zero_stock_window_import
                  WHERE code IN (${ph})
                  GROUP BY code
               ) z ON z.max_id = w.id`,
            list,
        );
        rows = r2;
    }
    const map = new Map();
    for (const row of rows || []) {
        const k = String(row.code || '').trim();
        if (!k) continue;
        map.set(k, {
            reference_date: row.reference_date ? new Date(row.reference_date).toISOString().slice(0, 10) : null,
            absent_last_30: Number(row.absent_last_30 || 0),
            absent_last_60: Number(row.absent_last_60 || 0),
            absent_last_90: Number(row.absent_last_90 || 0),
            absent_last_180: Number(row.absent_last_180 || 0),
            absent_last_365: Number(row.absent_last_365 || 0),
        });
    }
    return map;
}

/** Общий обработчик POST импорта сводки по окнам (используется и в `/api/product`, и в `/api/purchase`). */
function createHandleZeroStockWindowsImport(db) {
    return async function handleZeroStockWindowsImport(req, res) {
        try {
            const parsed = parseWindowImportPayload(req.body || {});
            const n = await upsertWindowImportBatch(db, parsed.reference_date, parsed.note, parsed.rows);
            res.json({
                success: true,
                reference_date: parsed.reference_date,
                rows_upserted: n,
                note: parsed.note || null,
            });
        } catch (err) {
            const msg = err && err.message ? err.message : String(err);
            if (msg && (msg.startsWith('Укажите') || msg.startsWith('Передайте') || msg.startsWith('CSV:') || msg.startsWith('Слишком'))) {
                return res.status(400).json({ success: false, error: msg });
            }
            console.error('[product][zero-win-import] error:', err);
            res.status(500).json({ success: false, error: msg || 'Внутренняя ошибка' });
        }
    };
}

function createProductRouter(db, appSettings) {
    const router = express.Router();

    /**
     * POST /api/product/zero-stock-windows-import
     * Body (JSON): { reference_date, note?, rows?: [...] , csv?: "..." }
     * Сводка по окнам (дней «нуля» за 30/60/90/180/365) — отдельно от построчного dg_product_zero_stock_log.
     */
    router.post('/zero-stock-windows-import', express.json({ limit: '25mb' }), createHandleZeroStockWindowsImport(db));

    /**
     * GET /api/product/:code/recent-shipments — только таблица последних отгрузок (пагинация + фильтр).
     * Query: те же `sales_from`/`sales_to` или `recent_days`, плюс
     * `recent_page` (default 1), `recent_page_size` (10..200, default 100),
     * `recent_via` = all | direct | bundle, при bundle опционально `recent_bundle_code` (код комплекта/строки отгрузки; пусто = все комплекты).
     */
    router.get('/:code/recent-shipments', async (req, res) => {
        try {
            const code = String(req.params.code || '').trim();
            if (!code) return res.status(400).json({ success: false, error: 'Не указан code' });
            const salesWindow = parseProductSalesWindow(req);
            const rp = parseRecentShipmentsRequest(req);

            const [msRows] = await db.query(
                `SELECT mse.code, mse.type FROM ms_export mse WHERE mse.code = ? LIMIT 1`,
                [code],
            );
            if (!msRows.length) {
                return res.status(404).json({ success: false, error: 'Товар с таким кодом не найден в ms_export' });
            }
            const mse = msRows[0];
            const isBundleProduct = isMsBundleExportRow(mse);
            await maybeRefreshBundleComponentsForProductView(db, code, isBundleProduct);
            const includeViaBundles = !isBundleProduct;
            const salesScope = parseProductSalesScope(req);
            const projFilter = projectFilterForSalesScope(appSettings, salesScope);
            const data = await loadRecentShipmentsPaged(
                db,
                code,
                code,
                includeViaBundles,
                salesWindow,
                rp,
                projFilter,
            );
            const totalPages = Math.max(1, Math.ceil(data.total / rp.pageSize));
            return res.json({
                success: true,
                code,
                sales_window: {
                    mode: salesWindow.useRange ? 'range' : 'rolling',
                    sales_from: salesWindow.fromDateStr,
                    sales_to: salesWindow.toDateStr,
                    span_days: salesWindow.spanDays,
                },
                recent_via: rp.mode === 'bundle_one' ? 'bundle' : rp.mode === 'all' ? 'all' : rp.mode,
                recent_bundle_code: rp.mode === 'bundle_one' ? rp.bundleCode : '',
                recent_page: rp.page,
                recent_page_size: rp.pageSize,
                recent_total: data.total,
                recent_total_pages: totalPages,
                rows: data.rows,
                bundle_codes: data.bundle_codes,
                includes_via_bundles: includeViaBundles,
            });
        } catch (err) {
            console.error('[product][recent-shipments] error:', err);
            res.status(500).json({ success: false, error: err && err.message ? err.message : 'Внутренняя ошибка' });
        }
    });

    /** GET /api/product/:code — агрегатная карточка. */
    router.get('/:code', async (req, res) => {
        try {
            const code = String(req.params.code || '').trim();
            if (!code) return res.status(400).json({ success: false, error: 'Не указан code' });
            const salesWindow = parseProductSalesWindow(req);
            const recentRp = parseRecentShipmentsRequest(req);
            const zeroDays = Math.min(365 * 5, Math.max(1, parseInt(req.query.zero_days, 10) || 90));
            const snapRetention = clampProductStockSnapshotRetentionDays(appSettings.product_stock_snapshot_retention_days);
            const qSnap = parseInt(req.query.stock_snapshot_days, 10);
            const stockSnapDays = Math.min(
                snapRetention,
                Math.min(730, Math.max(1, Number.isFinite(qSnap) && qSnap > 0 ? qSnap : Math.min(730, snapRetention))),
            );

            const [msPack, poPack, , ,] = await Promise.all([
                db.query(
                    `SELECT mse.*, med.payload_json
                       FROM ms_export mse
                       LEFT JOIN ms_entity_details med ON med.uuid = mse.uuid
                      WHERE mse.code = ?
                      LIMIT 1`,
                    [code],
                ),
                db.query(
                    `SELECT code, min_stock_dg, multiplicity,
                            proposed_min_stock, pack_qty_manual, note, updated_at
                       FROM dg_purchase_overrides
                      WHERE code = ?
                      LIMIT 1`,
                    [code],
                ),
                ensureZeroStockSchema(db),
                ensureProductStockSnapshotSchema(db),
                ensureBundleComponentsSchema(db),
            ]);
            const msRows = msPack[0];
            const poRows = poPack[0];
            if (!msRows.length) {
                return res.status(404).json({ success: false, error: 'Товар с таким кодом не найден в ms_export' });
            }
            const mse = msRows[0];
            const payload = parsePayloadSafe(mse.payload_json);
            const uomLabel = await resolveUomLabelFromPayload(payload, { fallback: '' });

            const override = poRows && poRows[0] ? poRows[0] : null;

            const isBundleProduct = isMsBundleExportRow(mse);
            await maybeRefreshBundleComponentsForProductView(db, code, isBundleProduct);
            const includeViaBundles = !isBundleProduct;

            const supplierLabel = buildSupplierLabel(mse.supplier, mse.supplier2);
            const article = payload && typeof payload.article === 'string' ? payload.article : '';

            const prices = extractPrices(payload);
            if (!prices.length && mse.buy_price) {
                prices.push({ kind: 'buy', name: 'Закупочная цена', value: mse.buy_price, currency: 'RUB' });
            }

            const supplierReplenishmentDays = await loadSupplierReplenishmentDaysForKey(db, mse.supplier);
            const skuRecMap = await loadSkuRecommendedDaysByCodes(db, [code], appSettings);
            const skuAbs = skuRecMap.get(code);
            const skuRecommendDays =
                skuAbs && skuAbs.recommended_replenishment_days != null
                    ? skuAbs.recommended_replenishment_days
                    : null;
            const resolvedRep = resolveEffectiveReplenishment(appSettings, {
                supplierDays: supplierReplenishmentDays,
                skuRecommendDays,
            });
            const formulaCfg = parseFormulaSettings(appSettings, {
                replenishmentDaysOverride: resolvedRep.replenishmentDays,
                replenishmentSourceHint: resolvedRep.replenishmentSource,
            });
            const projUuids = salesFormulaProjectUuids(appSettings);
            const projNameMap =
                projUuids.length > 0 ? await loadMsDemandProjectNameMap(db, projUuids) : null;
            const projDesc = describeSalesFormulaProjectFilter(appSettings, projNameMap);
            const formulaProjFilter = msDemandProjectFilterClause(appSettings);
            const loadFormulaSales =
                salesFormulaProjectMode(appSettings) === 'selected'
                    ? loadProductSalesBlock(
                          db,
                          code,
                          code,
                          includeViaBundles,
                          salesWindow,
                          recentRp,
                          formulaProjFilter,
                          projDesc.label,
                      )
                    : Promise.resolve(null);

            const [
                salesAll,
                salesFormulaScope,
                zeroLog,
                zeroWinImport,
                zeroWindowsFromLog,
                salesWindowSum,
                salesAbsenceWindowSum,
                absenceDistinctPack,
                stockSnapshots,
            ] = await Promise.all([
                loadProductSalesBlock(
                    db,
                    code,
                    code,
                    includeViaBundles,
                    salesWindow,
                    recentRp,
                    NO_PROJECT_FILTER,
                    null,
                ),
                loadFormulaSales,
                loadZeroStockLog(db, code, zeroDays),
                loadLatestZeroStockWindowImport(db, code),
                computeZeroStockWindowsFromLog(db, code),
                loadSalesSumLastDays(db, code, code, includeViaBundles, formulaCfg.salesWindowDays, appSettings),
                loadSalesSumLastDays(db, code, code, includeViaBundles, formulaCfg.absenceAnalysisDays, appSettings),
                loadZeroStockDistinctDays(db, code, formulaCfg.absenceAnalysisDays),
                loadStockSnapshots(db, code, stockSnapDays),
            ]);

            const stockBlock = extractStock(mse, payload);

            const ms = {
                code: mse.code || '',
                uuid: mse.uuid || '',
                article,
                name: mse.name || (payload?.name || ''),
                description: payload?.description ? String(payload.description) : '',
                type: mse.type || '',
                uom: uomLabel,
                is_archived: Number(mse.is_archived || 0),
                supplier: mse.supplier || '',
                supplier2: mse.supplier2 || '',
                supplier_label: supplierLabel,
                stock_position: mse.stock_position || '',
                manager: mse.manager || '',
                content_manager: mse.content_manager || '',
                vat: mse.vat || '',
                vat_on_product: mse.vat_on_product || '',
                packing_standard: mse.packing_standard || '',
                packing_own_box: mse.packing_own_box || '',
                packing_weight: mse.packing_weight || '',
                no_longer_cooperation: mse.no_longer_cooperation || '',
                automation_price: mse.automation_price || '',
                buy_price: mse.buy_price || '',
                min_stock: mse.min_stock != null ? Number(mse.min_stock) : null,
                stock: Number(mse.stock || 0),
                synced_at: mse.synced_at ? new Date(mse.synced_at).toISOString() : null,
                web_href: payload?.meta?.uuidHref ? String(payload.meta.uuidHref) : null,
                attributes: extractAttributes(payload),
                packagings: extractPackagings(payload),
                barcodes: extractBarcodes(payload),
                images: Array.isArray(payload?.images)
                    ? payload.images
                        .map((im) => im?.miniature?.downloadHref || im?.meta?.downloadHref || im?.filename || '')
                        .filter(Boolean)
                    : [],
            };

            const msMinStock = ms.min_stock != null && Number.isFinite(Number(ms.min_stock)) ? Number(ms.min_stock) : 0;
            let prevBaseline = msMinStock;
            let prevBaselineSource = 'ms_export.min_stock';
            if (override) {
                if (override.proposed_min_stock != null && override.proposed_min_stock !== '') {
                    const pm = Number(override.proposed_min_stock);
                    if (Number.isFinite(pm)) {
                        prevBaseline = pm;
                        prevBaselineSource = 'override.proposed_min_stock';
                    }
                }
            }
            const multRaw =
                override && override.multiplicity != null && override.multiplicity !== '' ? Number(override.multiplicity) : 0;
            const multiplicity = Number.isFinite(multRaw) && multRaw >= 0 ? multRaw : 0;

            const absenceLog = absenceDistinctPack.distinct_days;
            const absenceMerged = mergeAbsenceDistinctForFormula({
                logDistinctDays: absenceLog,
                windowImport: zeroWinImport,
                analysisDaysA: formulaCfg.absenceAnalysisDays,
            });

            const formulaResult = computeSalesFormula({
                settings: formulaCfg,
                sumQty: salesWindowSum.sum_qty,
                sumQtyAbsenceWindow: salesAbsenceWindowSum.sum_qty,
                absenceDistinctDays: absenceMerged.effective,
                marketPriceRub: pickMarketPriceRub(prices),
                multiplicity,
                stockQty: ms.stock,
                prevBaseline,
                prevBaselineSource,
            });

            formulaResult.inputs.absence_distinct_days_log = absenceMerged.log;
            if (absenceMerged.importEstimate != null) {
                formulaResult.inputs.absence_distinct_days_import_estimate = absenceMerged.importEstimate;
            }
            if (absenceMerged.import_reference_age_days != null) {
                formulaResult.inputs.absence_import_reference_age_days = absenceMerged.import_reference_age_days;
            }
            if (absenceMerged.importSkippedReason) {
                formulaResult.inputs.absence_import_merge_note = absenceMerged.importSkippedReason;
            }

            formulaResult.inputs.sales_formula_project_mode = projDesc.mode;
            formulaResult.inputs.sales_formula_project_filter_active = projDesc.active;
            if (projDesc.active && projDesc.uuids.length === 0) {
                formulaResult.warnings = Array.isArray(formulaResult.warnings)
                    ? formulaResult.warnings.slice()
                    : [];
                formulaResult.warnings.push(
                    'В настройках включён учёт только выбранных проектов, но список проектов пуст — продажи для формулы не учитываются.',
                );
            }
            if (formulaResult.detail && Array.isArray(formulaResult.detail.formula_context_lines)) {
                formulaResult.detail.formula_context_lines.unshift({
                    label: 'Проекты отгрузок МС (формула)',
                    value: projDesc.label,
                });
            }

            const proposedFloored = applyMinStockDgFloor(
                formulaResult.proposed_min_stock,
                override && override.min_stock_dg,
            );
            if (proposedFloored !== formulaResult.proposed_min_stock) {
                formulaResult.warnings = Array.isArray(formulaResult.warnings)
                    ? formulaResult.warnings.slice()
                    : [];
                formulaResult.warnings.push(
                    'Итог поднят до минимума «Неснижаемый остаток Датагон» (min_stock_dg): предлагаемый неснижаемый не может быть ниже этого порога.',
                );
            }
            formulaResult.proposed_min_stock = proposedFloored;

            let windowsJson = null;
            try {
                const winMap = await computePurchaseWindowSnapshotForItems(db, [{ code, type: ms.type }], appSettings);
                const winRow = winMap.get(code);
                if (winRow) windowsJson = serializeWindowsSnapshot(winRow);
            } catch (e) {
                console.warn('[product] purchase windows snapshot:', (e && e.message) || e);
            }

            try {
                await upsertFormulaProposedFromProduct(db, appSettings, code, proposedFloored, windowsJson, {
                    replenishmentDaysOverride: resolvedRep.replenishmentDays,
                    replenishmentSource: resolvedRep.replenishmentSource,
                });
            } catch (e) {
                console.warn('[product] dg_formula_proposed_cache upsert:', (e && e.message) || e);
            }

            const formulaPayload = {
                proposed_min_stock: formulaResult.proposed_min_stock,
                settings_effective: formulaCfg,
                replenishment_days_effective: formulaCfg.replenishmentDays,
                replenishment_source: formulaCfg.replenishmentSource || 'global',
                recommended_replenishment_days: skuRecommendDays,
                inputs: formulaResult.inputs,
                warnings: formulaResult.warnings,
                detail: formulaResult.detail,
                note:
                    'Сумма с учётом отсутствий × (дни пополнения ÷ период продаж); дни: рек. по SKU (эпизоды нуля) → оверрайд поставщика → глобаль. Редкий товар — ранний выход в базовый запас для редких; далее кратность и % упаковки; макс. изменение только на повышение.',
            };

            res.json({
                success: true,
                code,
                purchase_overrides_editable: purchaseOverridesEditable(req),
                ms,
                override: override || null,
                prices,
                stock: stockBlock,
                sales: salesAll,
                sales_formula_scope: salesFormulaScope,
                sales_scope_meta: {
                    formula_available: salesFormulaProjectMode(appSettings) === 'selected',
                    formula_label: projDesc.label,
                    formula_project_names: Array.isArray(projDesc.project_names) ? projDesc.project_names : [],
                },
                zero_stock: {
                    days: zeroDays,
                    rows: zeroLog,
                    note:
                        'По аналогии с продажами (там в лог попадают только проведённые отгрузки), здесь в лог попадают только дни, когда по выгрузке МС товар реально числился как отсутствующий на складе: после каждого успешного синка МойСклад за текущие сутки автоматически добавляется строка, если складская позиция «Да», товар не в архиве и (остаток ≤ 0 или для кода без «-» в номенклатуре остаток строго меньше минимального числового суффикса среди кодов вида «тот же код-число», например при 27877-2 и 27877-10 порог для 27877 = 2 шт.). Ручная запись за тот же день автоматикой не перезаписывается. Разбивка по отдельным складам — когда в синке появится report/stock/bystore.',
                },
                zero_stock_windows_import: zeroWinImport,
                zero_stock_windows_from_log: zeroWindowsFromLog,
                formula: formulaPayload,
                stock_snapshots: {
                    days: stockSnapDays,
                    retention_days: snapRetention,
                    rows: stockSnapshots,
                    note: `По одному значению stock из ms_export на календарный день после полного синка МС; повторный синк в тот же день перезаписывает. Глубину списка задаёт query stock_snapshot_days (1…min(730, retention)); без query — min(730, retention). В БД хранятся снимки не старше ${snapRetention} дн. (Настройки → срок хранения снимков остатка).`,
                },
            });
        } catch (err) {
            console.error('[product][get] error:', err);
            res.status(500).json({ success: false, error: err && err.message ? err.message : 'Внутренняя ошибка' });
        }
    });

    /** GET /api/product/:code/zero-stock-log?days=90 — расширенный лог нулевых остатков. */
    router.get('/:code/zero-stock-log', async (req, res) => {
        try {
            const code = String(req.params.code || '').trim();
            if (!code) return res.status(400).json({ success: false, error: 'Не указан code' });
            const days = Math.min(365 * 5, Math.max(1, parseInt(req.query.days, 10) || 90));
            const rows = await loadZeroStockLog(db, code, days);
            res.json({ success: true, code, days, rows });
        } catch (err) {
            console.error('[product][zero-log] error:', err);
            res.status(500).json({ success: false, error: err && err.message ? err.message : 'Внутренняя ошибка' });
        }
    });

    /**
     * POST /api/product/:code/zero-stock-log — зафиксировать «нет на складе» сейчас.
     * Body: { store_uuid?, store_name?, ts_date? (YYYY-MM-DD, по умолчанию сегодня), force? (1) }
     * Без force: пишет только если ms_export.stock <= 0. С force=1 — пишет всегда.
     */
    router.post('/:code/zero-stock-log', express.json({ limit: '32kb' }), async (req, res) => {
        try {
            const code = String(req.params.code || '').trim();
            if (!code) return res.status(400).json({ success: false, error: 'Не указан code' });
            await ensureZeroStockSchema(db);

            const body = req.body || {};
            const storeUuid = String(body.store_uuid || ZERO_LOG_DEFAULT_STORE).trim() || ZERO_LOG_DEFAULT_STORE;
            const storeName = body.store_name ? String(body.store_name).trim() : null;
            const force = String(body.force || '0') === '1';
            const tsDateRaw = body.ts_date ? String(body.ts_date).trim() : '';
            const tsDate = /^\d{4}-\d{2}-\d{2}$/.test(tsDateRaw) ? tsDateRaw : null;

            const [msRows] = await db.query(
                `SELECT code, stock FROM ms_export WHERE code = ? LIMIT 1`,
                [code],
            );
            if (!msRows.length) {
                return res.status(404).json({ success: false, error: 'Товар не найден в ms_export' });
            }
            const stock = Number(msRows[0].stock || 0);
            if (!force && stock > 0) {
                return res.status(400).json({
                    success: false,
                    error: `Текущий остаток = ${stock}, > 0. Чтобы всё равно зафиксировать, передайте force: 1`,
                    stock,
                });
            }

            const insertSql = tsDate
                ? `INSERT INTO dg_product_zero_stock_log (code, store_uuid, store_name, ts_date, total_stock, source)
                   VALUES (?, ?, ?, ?, ?, 'manual')
                   ON DUPLICATE KEY UPDATE total_stock = VALUES(total_stock), source = 'manual', store_name = VALUES(store_name)`
                : `INSERT INTO dg_product_zero_stock_log (code, store_uuid, store_name, ts_date, total_stock, source)
                   VALUES (?, ?, ?, CURDATE(), ?, 'manual')
                   ON DUPLICATE KEY UPDATE total_stock = VALUES(total_stock), source = 'manual', store_name = VALUES(store_name)`;

            const args = tsDate
                ? [code, storeUuid, storeName, tsDate, stock]
                : [code, storeUuid, storeName, stock];
            await db.query(insertSql, args);

            const [verifyRows] = await db.query(
                `SELECT id, code, store_uuid, store_name, ts_date, total_stock, source, created_at
                   FROM dg_product_zero_stock_log
                  WHERE code = ? AND store_uuid = ? AND ts_date = COALESCE(?, CURDATE())
                  LIMIT 1`,
                [code, storeUuid, tsDate],
            );
            const stored = verifyRows && verifyRows[0] ? verifyRows[0] : null;

            res.json({ success: true, code, stored });
        } catch (err) {
            console.error('[product][zero-log][post] error:', err);
            res.status(500).json({ success: false, error: err && err.message ? err.message : 'Внутренняя ошибка' });
        }
    });

    return router;
}

module.exports = createProductRouter;
module.exports.createProductRouter = createProductRouter;
module.exports.ensureZeroStockSchema = ensureZeroStockSchema;
module.exports.ensureZeroStockWindowImportSchema = ensureZeroStockWindowImportSchema;
module.exports.ensureBundleComponentsSchema = ensureBundleComponentsSchema;
module.exports.ensureBundleComponentsForProduct = ensureBundleComponentsForProduct;
module.exports.syncZeroStockLogAfterMoyskladExport = syncZeroStockLogAfterMoyskladExport;
module.exports.syncProductStockSnapshotsAfterMoyskladExport = syncProductStockSnapshotsAfterMoyskladExport;
module.exports.loadLatestZeroStockWindowImportMap = loadLatestZeroStockWindowImportMap;
