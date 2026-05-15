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
 *   GET    /api/purchase/warmup-progress — состояние фонового progressive-прогрева кэша (для шапки и баннера).
 *   GET    /api/purchase            — список товаров с overrides и raw-полями; в cache — warmup_progress;
 *                            `all` | `not_stopped` (default, как UI закупок) | `stopped` — фильтр по ms_export.no_longer_cooperation;
 *                            `formula_proposed_min_stock` — при совпадении ревизии и отпечатка настроек формулы
 *                            подставляется из `dg_formula_proposed_cache` (пишется при открытой карточке `GET /api/product/:code`);
 *                            иначе считается здесь (как на карточке товара:
 *                            перед расчётом для кодов страницы прогревается кэш составов комплектов (`ensureBundleComponentsForProduct`,
 *                            см. `routes/purchase.js`: батч-проверка свежести `dg_bundle_components.updated_at` и негативный кэш пустого состава,
 *                            чтобы не повторять тяжёлые LIKE по `ms_entity_details` на каждый запрос списка),
 *                            с нижним порогом по `min_stock_dg`: если «Нес.остаток Датагон» > 0, итог не ниже него;
 *                            сам `min_stock_dg` в опорный baseline формулы не входит (только `proposed_min_stock` из overrides или МС).
 *                            а также «снимок» продаж за 15…365 дн. (`d_*a`) и дней отсутствия (`d_*b`) для 15/30/60/90/180/365;
 *                            при совпадении `formula_fp`+`data_rev` с `dg_formula_proposed_cache.windows_json` (после открытия карточки)
 *                            эти колонки подставляются без трёх тяжёлых SQL-агрегатов по окнам.
 *                            Доп. query-фильтры (все `0`/`1`, по умолчанию `0`): `zero_stock` — остаток ≤ 0;
 *                            `zero_stock_no_transit` — остаток ≤ 0 и «В пути» (`payload_json.inTransit`) ≤ 0 (JOIN `ms_entity_details`);
 *                            `no_multiplicity` — кратность в overrides пустая или &lt; 1; `incomplete_pack` — кратность ≥ 1,
 *                            остаток ≥ одной полной упаковки и хвост не кратен кратности (не «1 шт при кратности 2»);
 *                            **кроме** базового кода с «код-число», где stock &lt; min(суффикс) — отсутствие комплекта.
 *                            Сортировка по вычисляемым полям (`d_*`, `formula_proposed_min_stock`) — по всему отфильтрованному
 *                            набору, затем `limit`/`offset`. «В пути» (`in_transit`) сортируется по `med.denorm_in_transit` из
 *                            того же лёгкого SELECT снимка — без полного enrich всех строк.
 *                            Для `formula_proposed_min_stock` на больших выборках: чанковый enrich только `formula_only`
 *                            (без тяжёлых `loadPurchaseDirectSalesWindowsMap` / `loadPurchaseBundleSalesWindowsMap` по всему набору),
 *                            затем для текущей страницы — обычный `enrichPurchaseListPage` (полные `d_*` + формула с payload).
 *                            Для сортировки по `d_*` — чанковый `windows_only` (окна + «дн. нет» без пересчёта формулы по каждой строке),
 *                            затем страница догоняется через `enrichPurchaseListPage`.
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
const {
    ensureZeroStockSchema,
    ensureBundleComponentsSchema,
    ensureBundleComponentsForProduct,
    loadLatestZeroStockWindowImportMap,
} = require('./product');
const { mergeAbsenceDistinctForFormula } = require('../lib/datagonZeroStockAbsence');
const { purchaseCacheLogFire } = require('../lib/purchaseCacheLogger');
const {
    loadPurchaseDataRevision,
    buildFormulaFingerprint,
    ensureFormulaProposedCacheSchema,
} = require('../lib/datagonFormulaProposedCache');
const {
    parsePurchaseWindowsJson,
    applyPurchaseWindowsToDataItem,
} = require('../lib/datagonPurchaseWindowSnapshot');

/** Макс. уникальных кодов на странице, для которых выполняется прогрев составов комплектов. */
const PURCHASE_BUNDLE_WARM_MAX_CODES = 600;
/** Размер чанка для `IN (коды…)` в агрегатах продаж/нулей — иначе один запрос на десятки тысяч кодов «вешает» MySQL. */
const PURCHASE_CODES_SQL_CHUNK = 400;
/** Не дергать `ensureBundleComponentsForProduct` (LIKE по `ms_entity_details`), если кэш `dg_bundle_components` для кода свежий. */
const PURCHASE_BUNDLE_WARM_DB_TTL_MS = 8 * 60 * 60 * 1000;
/** После пустого кэша для компонента не повторять полный LIKE-скан до истечения (новые комплекты в МС — с задержкой). */
const PURCHASE_BUNDLE_EMPTY_NEGATIVE_MS = 4 * 60 * 60 * 1000;
const purchaseBundleEmptyWarmAt = new Map();

/**
 * Кэш снимка списка закупок: один раз на набор фильтров (без sort/limit/offset).
 * Смена сортировки и страницы — только сортировка/slice в памяти, без повторного enrich.
 */
/** До следующего утреннего прогрева (~08:00 МСК); переживает рабочий день без пересборки. */
const PURCHASE_LIST_CACHE_TTL_MS = 26 * 60 * 60 * 1000;
const purchaseListBaseCache = new Map();

/** Пауза между пресетами progressive-прогрева (снижает пик CPU / даёт breath I/O). */
const PURCHASE_PROGRESSIVE_PAUSE_MS = Math.max(
    0,
    Math.min(120000, Number(process.env.PURCHASE_PROGRESSIVE_PAUSE_MS || 350) || 350),
);

let purchaseStartupProgressiveRunning = false;
let purchaseStartupProgressiveState = {
    running: false,
    preset_index: 0,
    preset_total: 0,
    label: '',
    done: 0,
    total: 0,
    pct: 0,
    preset_started_at_ms: null,
    finished_at_ms: null,
    progressive_run_started_ms: null,
};

function purchaseSleepMs(ms) {
    const n = Math.max(0, Number(ms) || 0);
    if (!n) return Promise.resolve();
    return new Promise((resolve) => setTimeout(resolve, n));
}

function getPurchaseWarmupProgressPayload() {
    const s = purchaseStartupProgressiveState;
    const now = Date.now();
    const presetStarted = Number(s.preset_started_at_ms) || 0;
    const presetElapsedSec = presetStarted ? Math.round((now - presetStarted) / 1000) : 0;
    return {
        running: Boolean(s.running),
        preset_index: Number(s.preset_index || 0),
        preset_total: Number(s.preset_total || 0),
        label: String(s.label || ''),
        done: Number(s.done || 0),
        total: Number(s.total || 0),
        pct: Math.min(100, Math.max(0, Number(s.pct || 0))),
        preset_started_at_ms: presetStarted || null,
        preset_elapsed_sec: presetElapsedSec,
        finished_at_ms: s.finished_at_ms != null ? Number(s.finished_at_ms) : null,
        progressive_run_started_ms:
            s.progressive_run_started_ms != null ? Number(s.progressive_run_started_ms) : null,
    };
}

/**
 * По одному пресету из `PURCHASE_WARMUP_QUERY_PRESETS` — обновляет `purchaseStartupProgressiveState` для UI и `/warmup-progress`.
 */
async function runPurchaseStartupProgressiveWarmup(db, appSettings) {
    if (purchaseStartupProgressiveRunning) return;
    purchaseStartupProgressiveRunning = true;
    const presets = PURCHASE_WARMUP_QUERY_PRESETS;
    const total = presets.length;
    const runLabel = `startup-progressive-${Date.now()}`;
    const runStarted = Date.now();
    purchaseStartupProgressiveState = {
        running: true,
        preset_index: 0,
        preset_total: total,
        label: 'Старт…',
        done: 0,
        total,
        pct: 0,
        preset_started_at_ms: runStarted,
        finished_at_ms: null,
        progressive_run_started_ms: runStarted,
    };
    try {
        purchaseCacheLogFire(runLabel, 'progressive warmup start', { presets: total });
        for (let i = 0; i < presets.length; i += 1) {
            const idx = i + 1;
            purchaseStartupProgressiveState.preset_index = idx;
            purchaseStartupProgressiveState.label = `пресет ${idx}/${total}`;
            purchaseStartupProgressiveState.preset_started_at_ms = Date.now();
            purchaseStartupProgressiveState.done = i;
            purchaseStartupProgressiveState.pct = total ? Math.round((i / total) * 100) : 0;
            await warmupPurchaseListCaches(db, appSettings, {
                presets: [presets[i]],
                force: false,
                warmSorts: true,
                _warmupRunLabel: runLabel,
                _warmupPresetIndex: idx,
                _warmupPresetTotal: total,
            });
            purchaseStartupProgressiveState.done = idx;
            purchaseStartupProgressiveState.pct = total ? Math.round((idx / total) * 100) : 100;
            if (i < presets.length - 1) {
                await purchaseSleepMs(PURCHASE_PROGRESSIVE_PAUSE_MS);
            }
        }
        purchaseStartupProgressiveState.running = false;
        purchaseStartupProgressiveState.label = 'Готово';
        purchaseStartupProgressiveState.pct = 100;
        purchaseStartupProgressiveState.finished_at_ms = Date.now();
        purchaseCacheLogFire(runLabel, 'progressive warmup done', { presets: total });
    } catch (e) {
        purchaseStartupProgressiveState.running = false;
        purchaseStartupProgressiveState.label = `Ошибка: ${e && e.message ? e.message : String(e)}`;
        purchaseStartupProgressiveState.finished_at_ms = Date.now();
        purchaseCacheLogFire(runLabel, 'progressive warmup error', { err: String(e && e.message) });
        console.warn('[purchase] progressive warmup:', e);
    } finally {
        purchaseStartupProgressiveRunning = false;
    }
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

function buildPurchaseListCacheKey(req, appSettings, dataRev) {
    const q = req.query || {};
    const formulaFp = buildFormulaFingerprint(appSettings);
    return JSON.stringify({
        dataRev: String(dataRev || ''),
        formula: formulaFp,
        search: String(q.search || '').trim(),
        supplier: String(q.supplier || '').trim(),
        archived: String(q.archived || 'active').toLowerCase(),
        stock_position: String(q.stock_position || 'yes').toLowerCase(),
        no_longer_cooperation: String(q.no_longer_cooperation || 'not_stopped').toLowerCase(),
        include_bundles: String(q.include_bundles || '0'),
        only_stock: String(q.only_stock || '0'),
        zero_stock_no_transit: String(q.zero_stock_no_transit || '0'),
        zero_stock: String(q.zero_stock || '0'),
        no_multiplicity: String(q.no_multiplicity || '0'),
        incomplete_pack: String(q.incomplete_pack || '0'),
    });
}

function clearPurchaseListResponseCache() {
    purchaseListBaseCache.clear();
}

function rememberPurchaseListBaseCache(key, snapshot) {
    if (purchaseListBaseCache.size > 80) {
        const cut = Date.now() - PURCHASE_LIST_CACHE_TTL_MS;
        for (const [k, v] of purchaseListBaseCache.entries()) {
            if (v.ts < cut) purchaseListBaseCache.delete(k);
        }
        if (purchaseListBaseCache.size > 80) {
            const first = purchaseListBaseCache.keys().next().value;
            if (first) purchaseListBaseCache.delete(first);
        }
    }
    purchaseListBaseCache.set(key, {
        ts: Date.now(),
        total: snapshot.total,
        items: snapshot.items,
        enrichMode: snapshot.enrichMode || 'full',
        dataRev: snapshot.dataRev != null ? String(snapshot.dataRev) : '',
        formulaFp: snapshot.formulaFp != null ? String(snapshot.formulaFp) : '',
    });
}

let schemaReady = false;

const OVERRIDE_FIELDS = new Set(['min_stock_dg', 'multiplicity', 'proposed_min_stock', 'pack_qty_manual']);

const ALLOWED_SORT = {
    code: 'mse.code',
    article: 'article_sort',
    name: 'mse.name',
    supplier: 'mse.supplier',
    buy_price: 'buy_price_num',
    min_stock: 'mse.min_stock',
    automation_price: 'mse.automation_price',
    min_stock_dg: 'po.min_stock_dg',
    multiplicity: 'po.multiplicity',
    proposed_min_stock: 'po.proposed_min_stock',
    stock: 'mse.stock',
    is_archived: 'mse.is_archived',
    /* SQL-заглушка; фактический порядок — после enrich в RAM (см. `purchaseSnapshotSortEnrichMode`). */
    formula_proposed_min_stock: 'mse.code',
    in_transit: 'mse.code',
    d_15a: 'mse.code',
    d_15b: 'mse.code',
    d_30a: 'mse.code',
    d_30b: 'mse.code',
    d_60a: 'mse.code',
    d_60b: 'mse.code',
    d_90a: 'mse.code',
    d_90b: 'mse.code',
    d_180a: 'mse.code',
    d_180b: 'mse.code',
    d_365a: 'mse.code',
    d_365b: 'mse.code',
};

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

/** Сортировка по колонкам «15/30/… прод., шт» и «дн. нет» — после чанкового enrich `windows_only` по всему набору. */
const PURCHASE_WINDOW_SORT_KEYS = new Set([
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

/** Сортировка по «В пути» — значение уже в снимке из `denorm_in_transit` (`mapPurchaseSqlRowToDataItem`), полный enrich не нужен. */
const PURCHASE_IN_TRANSIT_SORT = 'in_transit';
/** Сортировка по предлагаемому неснижаемому: чанковый `formula_only` по снимку, затем страница через `enrichPurchaseListPage`. */
const PURCHASE_FORMULA_SORT = 'formula_proposed_min_stock';

/** До этого числа строк после фильтра — enrich всего снимка сразу; больше — только текущая страница (кроме сортировки по d_* / формуле). */
const PURCHASE_ENRICH_ALL_MAX_ROWS = 600;

/** @returns {'formula_only'|'windows_only'|null} */
function purchaseSnapshotSortEnrichMode(sortKey) {
    if (!ALLOWED_SORT[String(sortKey || '')]) return null;
    if (String(sortKey) === PURCHASE_IN_TRANSIT_SORT) return null;
    if (String(sortKey) === PURCHASE_FORMULA_SORT) return 'formula_only';
    if (PURCHASE_WINDOW_SORT_KEYS.has(String(sortKey))) return 'windows_only';
    return null;
}

function purchasePostSortNumeric(row, key) {
    const v = row[key];
    if (key === 'in_transit') {
        if (v == null || v === '') return null;
    }
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

function sortPurchaseDataByKey(data, sortKey, desc) {
    sortPurchaseSnapshotItems(data, sortKey, desc);
}

const PURCHASE_STRING_SORT_KEYS = new Set(['code', 'article', 'name', 'supplier']);

function parsePurchaseRowSortValue(row, sortKey) {
    if (
        PURCHASE_WINDOW_SORT_KEYS.has(sortKey) ||
        sortKey === PURCHASE_FORMULA_SORT ||
        sortKey === PURCHASE_IN_TRANSIT_SORT
    ) {
        return purchasePostSortNumeric(row, sortKey);
    }
    if (sortKey === 'buy_price') {
        const s = String(row.buy_price || '');
        const cleaned = s.replace(/₽/g, '').replace(/\s/g, '').replace(',', '.');
        const n = Number(cleaned);
        return Number.isFinite(n) ? n : null;
    }
    if (sortKey === 'supplier') return String(row.supplier_label || row.supplier || '');
    if (PURCHASE_STRING_SORT_KEYS.has(sortKey)) return String(row[sortKey] || '');
    const n = Number(row[sortKey]);
    return Number.isFinite(n) ? n : null;
}

/** Сортировка по уже обогащённому снимку (все колонки таблицы закупок). */
function sortPurchaseSnapshotItems(data, sortKey, desc) {
    const strMode = PURCHASE_STRING_SORT_KEYS.has(sortKey);
    data.sort((a, b) => {
        const va = parsePurchaseRowSortValue(a, sortKey);
        const vb = parsePurchaseRowSortValue(b, sortKey);
        if (strMode) {
            const cmp = String(va || '').localeCompare(String(vb || ''), 'ru');
            if (cmp !== 0) return desc ? -cmp : cmp;
            return String(a.code || '').localeCompare(String(b.code || ''), 'ru');
        }
        const na = va != null ? va : desc ? -1e18 : 1e18;
        const nb = vb != null ? vb : desc ? -1e18 : 1e18;
        if (nb === na) return String(a.code || '').localeCompare(String(b.code || ''), 'ru');
        return desc ? nb - na : na - nb;
    });
}

function purchaseListPageFromSnapshot(snapshot, req) {
    const limitRaw = parseInt(req.query.limit, 10);
    const offsetRaw = parseInt(req.query.offset, 10);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(1000, limitRaw) : 100;
    const offset = Number.isFinite(offsetRaw) && offsetRaw >= 0 ? offsetRaw : 0;
    const sortKey = ALLOWED_SORT[String(req.query.sort_by || 'code')] ? String(req.query.sort_by || 'code') : 'code';
    const sortDir = String(req.query.sort_dir || 'asc').toLowerCase() === 'desc' ? 'desc' : 'asc';
    const items = snapshot.items.slice();
    sortPurchaseSnapshotItems(items, sortKey, sortDir === 'desc');
    return {
        success: true,
        total: snapshot.total,
        limit,
        offset,
        sort_by: sortKey,
        sort_dir: sortDir,
        data: items.slice(offset, offset + limit),
    };
}

/**
 * @param {{ dataRev?: string, formulaFp?: string }} [formulaMeta] — для `formula_cached_proposed` (паритет с основным списком).
 */
async function loadMsPayloadRowsForCodes(db, codes, formulaMeta) {
    const list = [...new Set((codes || []).map((c) => String(c || '').trim()).filter(Boolean))];
    if (!list.length) return [];
    const rev = formulaMeta && formulaMeta.dataRev != null ? String(formulaMeta.dataRev) : '';
    const fp = formulaMeta && formulaMeta.formulaFp != null ? String(formulaMeta.formulaFp) : '';
    const useFc = rev !== '' && fp !== '';
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
                    med.payload_json,
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

/** Обогащение только строк текущей страницы (после лёгкого снимка без payload_json на весь каталог). */
async function enrichPurchaseListPage(db, appSettings, pageItems, snapshotMeta = {}) {
    if (!pageItems.length) return;
    const codes = pageItems.map((d) => d.code).filter(Boolean);
    const dataRev =
        snapshotMeta && snapshotMeta.dataRev != null && String(snapshotMeta.dataRev) !== ''
            ? String(snapshotMeta.dataRev)
            : await loadPurchaseDataRevision(db);
    const formulaFp =
        snapshotMeta && snapshotMeta.formulaFp != null && String(snapshotMeta.formulaFp) !== ''
            ? String(snapshotMeta.formulaFp)
            : buildFormulaFingerprint(appSettings);
    const sqlRows = await loadMsPayloadRowsForCodes(db, codes, { dataRev, formulaFp });
    const byCode = new Map((sqlRows || []).map((r) => [String(r.code), mapPurchaseSqlRowToDataItem(r)]));
    for (let i = 0; i < pageItems.length; i += 1) {
        const fresh = byCode.get(String(pageItems[i].code || ''));
        if (fresh) Object.assign(pageItems[i], fresh);
    }
    await enrichPurchaseRowsWithFormula(db, appSettings || {}, sqlRows, pageItems, { mode: 'all' });
}

/**
 * Обогащение всего снимка чанками для сортировки по формуле (`formula_only`) или по окнам `d_*` (`windows_only`).
 * Режим `all` — только при изначально полном снимке (мало строк); сюда не передаётся для «тяжёлой» сортировки.
 * После `formula_only` / `windows_only` оставляем `enrichMode: 'page'`, чтобы `enrichPurchaseListPage` догнал текущую страницу.
 */
async function enrichPurchaseSnapshotFull(db, appSettings, snapshot, enrichModeArg) {
    if (snapshot.enrichMode === 'full' || !snapshot.items.length) return;
    const enrichMode = enrichModeArg === 'windows_only' || enrichModeArg === 'formula_only' ? enrichModeArg : 'all';
    const dataRev =
        snapshot.dataRev != null && String(snapshot.dataRev) !== ''
            ? String(snapshot.dataRev)
            : await loadPurchaseDataRevision(db);
    const formulaFp =
        snapshot.formulaFp != null && String(snapshot.formulaFp) !== ''
            ? String(snapshot.formulaFp)
            : buildFormulaFingerprint(appSettings);
    const codes = snapshot.items.map((d) => String(d.code || '').trim()).filter(Boolean);
    for (let i = 0; i < codes.length; i += PURCHASE_CODES_SQL_CHUNK) {
        const part = codes.slice(i, i + PURCHASE_CODES_SQL_CHUNK);
        const sqlRows = await loadMsPayloadRowsForCodes(db, part, { dataRev, formulaFp });
        const byCode = new Map(sqlRows.map((r) => [String(r.code), r]));
        const chunkItems = snapshot.items.filter((d) => byCode.has(String(d.code)));
        if (chunkItems.length) {
            await enrichPurchaseRowsWithFormula(db, appSettings || {}, sqlRows, chunkItems, { mode: enrichMode });
        }
        await new Promise((resolve) => setImmediate(resolve));
    }
    snapshot.enrichMode = enrichMode === 'all' ? 'full' : 'page';
}

/**
 * Ответ GET /api/purchase: пагинация/сортировка; для больших выборок — enrich только страницы.
 */
async function purchaseListRespondFromSnapshot(db, appSettings, snapshot, req) {
    const limitRaw = parseInt(req.query.limit, 10);
    const offsetRaw = parseInt(req.query.offset, 10);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(1000, limitRaw) : 100;
    const offset = Number.isFinite(offsetRaw) && offsetRaw >= 0 ? offsetRaw : 0;
    const sortKey = ALLOWED_SORT[String(req.query.sort_by || 'code')] ? String(req.query.sort_by || 'code') : 'code';
    const sortDir = String(req.query.sort_dir || 'asc').toLowerCase() === 'desc' ? 'desc' : 'asc';

    const sortEnrichMode = purchaseSnapshotSortEnrichMode(sortKey);
    let ranSortSnapshotEnrich = false;
    if (snapshot.enrichMode !== 'full' && sortEnrichMode) {
        await enrichPurchaseSnapshotFull(db, appSettings, snapshot, sortEnrichMode);
        ranSortSnapshotEnrich = true;
    }

    const items = snapshot.items.slice();
    sortPurchaseSnapshotItems(items, sortKey, sortDir === 'desc');
    const page = items.slice(offset, offset + limit);

    if (snapshot.enrichMode !== 'full' || ranSortSnapshotEnrich) {
        await enrichPurchaseListPage(db, appSettings, page, snapshot);
    }

    return {
        success: true,
        total: snapshot.total,
        limit,
        offset,
        sort_by: sortKey,
        sort_dir: sortDir,
        data: page,
    };
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

function buildWindowSumSelectSql(qtyExpr) {
    return PU_SNAPSHOT_SALES_DAYS.map(
        (w) =>
            `COALESCE(SUM(CASE WHEN d.moment >= (NOW() - INTERVAL ${w} DAY) THEN (${qtyExpr}) ELSE 0 END), 0) AS w${w}`,
    ).join(',\n            ');
}

async function loadPurchaseDirectSalesWindowsMap(db, codes) {
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

async function loadPurchaseBundleSalesWindowsMap(db, componentCodes) {
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
async function loadPurchaseSumQtyLastDaysMap(db, codes, componentCodesForBundle, intervalDays) {
    const D = Math.min(365 * 2, Math.max(1, Math.round(Number(intervalDays) || 1)));
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
                AND p.ms_export_code IN (${ph})
              GROUP BY p.ms_export_code`,
            [D, ...part],
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
                AND bc.component_code IN (${ph2})
              GROUP BY bc.component_code`,
            [D, ...part],
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
async function loadPurchaseDirectSumQtyWindowRows(db, codes, W) {
    const out = [];
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
                AND p.ms_export_code IN (${ph})
              GROUP BY p.ms_export_code`,
            [W, ...part],
        );
        if (rows && rows.length) out.push(...rows);
    }
    return out;
}

/** Эквивалент через комплекты sum_qty за окно W дн. */
async function loadPurchaseBundleSumQtyWindowRows(db, safeComponentCodes, W) {
    const out = [];
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
                AND bc.component_code IN (${ph})
              GROUP BY bc.component_code`,
            [W, ...part],
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

    if (warmPairs.length <= PURCHASE_BUNDLE_WARM_MAX_CODES) {
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
                loadPurchaseDirectSalesWindowsMap(db, codes),
                loadPurchaseBundleSalesWindowsMap(db, safeComponentCodes),
                loadPurchaseAbsenceDistinctDaysAggregateMap(db, codes),
            ]);
            dirWinMap = dr;
            bunWinMap = br;
            absMultiMap = am;
        }
    } else if (mode === 'formula_only') {
        const [dRows, bRows, aRows, asm, zwm] = await Promise.all([
            loadPurchaseDirectSumQtyWindowRows(db, codes, W),
            safeComponentCodes.length
                ? loadPurchaseBundleSumQtyWindowRows(db, safeComponentCodes, W)
                : Promise.resolve([]),
            loadPurchaseAbsenceDistinctIntervalRows(db, codes, absenceWin),
            loadPurchaseSumQtyLastDaysMap(db, codes, safeComponentCodes, absenceWin),
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
                loadPurchaseDirectSumQtyWindowRows(db, codes, W),
                safeComponentCodes.length
                    ? loadPurchaseBundleSumQtyWindowRows(db, safeComponentCodes, W)
                    : Promise.resolve([]),
                loadPurchaseAbsenceDistinctIntervalRows(db, codes, absenceWin),
                loadPurchaseSumQtyLastDaysMap(db, codes, safeComponentCodes, absenceWin),
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
                loadPurchaseDirectSumQtyWindowRows(db, codes, W),
                safeComponentCodes.length
                    ? loadPurchaseBundleSumQtyWindowRows(db, safeComponentCodes, W)
                    : Promise.resolve([]),
                loadPurchaseAbsenceDistinctIntervalRows(db, codes, absenceWin),
                loadPurchaseDirectSalesWindowsMap(db, codes),
                loadPurchaseBundleSalesWindowsMap(db, safeComponentCodes),
                loadPurchaseAbsenceDistinctDaysAggregateMap(db, codes),
                loadPurchaseSumQtyLastDaysMap(db, codes, safeComponentCodes, absenceWin),
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

/** Все колонки сортировки таблицы закупок (прогрев asc/desc в RAM после снимка). */
const PURCHASE_WARMUP_SORT_KEYS = Object.keys(ALLOWED_SORT);

function touchPurchaseSnapshotSorts(snapshot, reqTemplate) {
    let touches = 0;
    const baseQuery = Object.assign({}, reqTemplate.query || {});
    for (let si = 0; si < PURCHASE_WARMUP_SORT_KEYS.length; si += 1) {
        const sortKey = PURCHASE_WARMUP_SORT_KEYS[si];
        for (const sortDir of ['asc', 'desc']) {
            purchaseListPageFromSnapshot(snapshot, {
                query: Object.assign({}, baseQuery, {
                    sort_by: sortKey,
                    sort_dir: sortDir,
                    limit: '100',
                    offset: '0',
                }),
            });
            touches += 1;
        }
    }
    return touches;
}

/** Пресеты фильтров для прогрева снимка (сортировка не в ключе — один снимок на фильтр).
 *  Согласовано с UI закупок: не больше одного из
 *  only_stock | include_bundles | zero_stock | zero_stock_no_transit | no_multiplicity | incomplete_pack
 *  (один «Доп. фильтр» в селекте). Комбинации с двумя такими флагами убраны — их нельзя набрать в форме.
 */
const PURCHASE_WARMUP_QUERY_PRESETS = [
    {},
    { only_stock: '1' },
    { zero_stock: '1' },
    { zero_stock_no_transit: '1' },
    { no_multiplicity: '1' },
    { incomplete_pack: '1' },
    { include_bundles: '1' },
    { archived: 'all' },
    { stock_position: 'all' },
    { no_longer_cooperation: 'all' },
    { include_bundles: '1', archived: 'all' },
    { stock_position: 'all', archived: 'all' },
    { no_longer_cooperation: 'all', stock_position: 'all' },
    { stock_position: 'all', only_stock: '1' },
    { no_longer_cooperation: 'all', zero_stock: '1' },
    { archived: 'all', stock_position: 'all', no_longer_cooperation: 'all' },
    { archived: 'all', zero_stock: '1' },
    { archived: 'archived', include_bundles: '1' },
    { archived: 'archived' },
    { stock_position: 'no' },
];

/**
 * Фоновый прогрев снимков списка закупок.
 * @param {{ force?: boolean, warmSorts?: boolean, presets?: object[] }} [options]
 *   force — пересобрать даже при живом кэше (утренний прогрев 08:00);
 *   warmSorts — прогреть все пары sort×dir в RAM (по умолчанию true);
 *   presets — подмножество `PURCHASE_WARMUP_QUERY_PRESETS` (progressive на старте Node — по одному пресету за вызов, см. `runPurchaseStartupProgressiveWarmup` / `server.js`).
 * @returns {Promise<{ built: number, skipped: number, sortTouches: number, errors: number }>}
 */
async function warmupPurchaseListCaches(db, appSettings, options = {}) {
    const force = options.force === true;
    const warmSorts = options.warmSorts !== false;
    const presets = Array.isArray(options.presets) ? options.presets : PURCHASE_WARMUP_QUERY_PRESETS;
    const stats = { built: 0, skipped: 0, sortTouches: 0, errors: 0 };
    const runLabel = String(options._warmupRunLabel || '').trim();
    if (runLabel) {
        purchaseCacheLogFire(runLabel, 'warmup batch begin', {
            presets: presets.length,
            warmSorts,
            force,
            idx: options._warmupPresetIndex,
            total: options._warmupPresetTotal,
        });
    }

    await ensureSchema(db);
    if (typeof require('./msSales').ensureSchema === 'function') {
        await require('./msSales').ensureSchema(db);
    }
    const base = {
        archived: 'active',
        stock_position: 'yes',
        no_longer_cooperation: 'not_stopped',
        include_bundles: '0',
        only_stock: '0',
        zero_stock: '0',
        zero_stock_no_transit: '0',
        no_multiplicity: '0',
        incomplete_pack: '0',
    };
    const rev = await loadPurchaseDataRevision(db);

    for (let i = 0; i < presets.length; i += 1) {
        const extra = presets[i];
        const q = Object.assign({}, base, extra);
        const req = { query: q };
        const key = buildPurchaseListCacheKey(req, appSettings, rev);
        if (runLabel) {
            purchaseCacheLogFire(runLabel, `preset ${i + 1}/${presets.length} start`, { extra });
        }
        const cached = purchaseListBaseCache.get(key);
        if (!force && cached && Date.now() - cached.ts < PURCHASE_LIST_CACHE_TTL_MS) {
            stats.skipped += 1;
            if (warmSorts) {
                stats.sortTouches += touchPurchaseSnapshotSorts(cached, req);
            }
            if (runLabel) {
                purchaseCacheLogFire(runLabel, `preset ${i + 1}/${presets.length} skipped (cache ok)`, { extra });
            }
            await new Promise((resolve) => setImmediate(resolve));
            continue;
        }
        try {
            const snap = await purchaseListBuildBaseSnapshot(db, appSettings, req, rev);
            rememberPurchaseListBaseCache(key, snap);
            stats.built += 1;
            if (warmSorts) {
                stats.sortTouches += touchPurchaseSnapshotSorts(snap, req);
            }
            if (runLabel) {
                purchaseCacheLogFire(runLabel, `preset ${i + 1}/${presets.length} built`, { extra });
            }
        } catch (e) {
            stats.errors += 1;
            console.warn('[purchase][warmup]', (e && e.message) || e);
            if (runLabel) {
                purchaseCacheLogFire(runLabel, `preset ${i + 1}/${presets.length} error`, {
                    err: String(e && e.message),
                });
            }
        }
        await new Promise((resolve) => setImmediate(resolve));
    }
    if (runLabel) {
        purchaseCacheLogFire(runLabel, 'warmup batch end', stats);
    }
    return stats;
}

/**
 * Полный обогащённый снимок по фильтрам (без сортировки/пагинации).
 * Дорого один раз; дальше — только slice/sort из `purchaseListBaseCache`.
 */
async function purchaseListBuildBaseSnapshot(db, appSettings, req, dataRevPre) {
            const dataRev =
                dataRevPre != null && typeof dataRevPre === 'string' ? dataRevPre : await loadPurchaseDataRevision(db);
            const formulaFpVal = buildFormulaFingerprint(appSettings);
            const search = String(req.query.search || '').trim();
            const supplier = String(req.query.supplier || '').trim();
            const archived = String(req.query.archived || 'active').toLowerCase();
            const stockPositionMode = String(req.query.stock_position || 'yes').toLowerCase();
            const noLongerMode = String(req.query.no_longer_cooperation || 'not_stopped').toLowerCase();
            const includeBundles = String(req.query.include_bundles || '0') === '1';
            const onlyStock = String(req.query.only_stock || '0') === '1';
            const zeroStockNoTransit = String(req.query.zero_stock_no_transit || '0') === '1';
            const zeroStockOnly = String(req.query.zero_stock || '0') === '1';
            const noMultiplicity = String(req.query.no_multiplicity || '0') === '1';
            const incompletePack = String(req.query.incomplete_pack || '0') === '1';

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
                const v = `%${supplier.toLowerCase()}%`;
                where.push('(LOWER(mse.supplier) LIKE ? OR LOWER(mse.supplier2) LIKE ?)');
                params.push(v, v);
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

            const whereSql = where.join(' AND ');

            const baseFromJoin = `
                FROM ms_export mse
                LEFT JOIN dg_purchase_overrides po ON po.code = mse.code
                LEFT JOIN ms_entity_details med ON med.uuid = mse.uuid
                ${incompletePack ? `LEFT JOIN (${MS_EXPORT_BUNDLE_MIN_SUFFIX_SUBSQL}) bb ON bb.base_code = mse.code` : ''}
            `;

            const listSelectBody = `
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
                WHERE ${whereSql}`;

            const countFromJoin =
                incompletePack
                    ? baseFromJoin
                    : `
                FROM ms_export mse
                LEFT JOIN dg_purchase_overrides po ON po.code = mse.code
                LEFT JOIN ms_entity_details med ON med.uuid = mse.uuid
            `;
            const countSql = `SELECT COUNT(*) AS cnt ${countFromJoin} WHERE ${whereSql}`;
            const listSqlFull = `${listSelectBody} ORDER BY mse.id ASC`;

            const listParams = [formulaFpVal, dataRev, ...params];
            const [[rows], [countRow]] = await Promise.all([
                db.query(listSqlFull, listParams),
                db.query(countSql, params),
            ]);

            const total = Number(countRow[0]?.cnt || 0);
            const enrichAll = (rows || []).length <= PURCHASE_ENRICH_ALL_MAX_ROWS;
            const data = (rows || []).map((r) =>
                mapPurchaseSqlRowToDataItem(r, enrichAll ? {} : { noPayloadForFormula: true }),
            );
            if (enrichAll) {
                await enrichPurchaseRowsWithFormula(db, appSettings || {}, rows, data, { mode: 'all' });
            }

            return {
                total,
                items: data,
                enrichMode: enrichAll ? 'full' : 'page',
                dataRev,
                formulaFp: formulaFpVal,
            };
}

async function purchaseListHandlerCore(db, appSettings, req) {
    const dataRev = await loadPurchaseDataRevision(db);
    const snap = await purchaseListBuildBaseSnapshot(db, appSettings, req, dataRev);
    return purchaseListRespondFromSnapshot(db, appSettings, snap, req);
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

            const dataRev = await loadPurchaseDataRevision(db);
            const baseKey = buildPurchaseListCacheKey(req, appSettings, dataRev);
            let baseSnap = purchaseListBaseCache.get(baseKey);
            const cacheAge = baseSnap ? Date.now() - baseSnap.ts : null;
            if (!baseSnap || cacheAge >= PURCHASE_LIST_CACHE_TTL_MS) {
                const built = await purchaseListBuildBaseSnapshot(db, appSettings, req, dataRev);
                rememberPurchaseListBaseCache(baseKey, built);
                baseSnap = purchaseListBaseCache.get(baseKey);
            }
            const responsePayload = await purchaseListRespondFromSnapshot(db, appSettings, baseSnap, req);
            res.json({
                ...responsePayload,
                cache: {
                    source: 'snapshot',
                    enrich: baseSnap.enrichMode || 'full',
                    age_ms: baseSnap ? Date.now() - baseSnap.ts : 0,
                    ttl_ms: PURCHASE_LIST_CACHE_TTL_MS,
                    items: baseSnap ? baseSnap.items.length : 0,
                    warmup_progress: getPurchaseWarmupProgressPayload(),
                },
            });
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
            clearPurchaseListResponseCache();
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
            clearPurchaseListResponseCache();
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
