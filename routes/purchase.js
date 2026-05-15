'use strict';

/**
 * Закупки — страница планирования закупок поверх ms_export.
 *
 * Контракт:
 *   • Источник истины для базовых полей — `ms_export` (синк МС).
 *   • Дополнительные сырые поля (артикул, packagings, в пути / inTransit) —
 *     из `ms_entity_details.payload_json` (JSON ответа entity/product|bundle).
 *   • Редактируемые значения (Неснижаемый остаток Датагон / Кратность товара /
 *     Мин.Остаток сч.как 0 / Предлагаемый нес.остаток) хранятся в отдельной
 *     таблице `dg_purchase_overrides` (PK = code), чтобы синк МС не затирал
 *     их и схема ms_export не разрасталась.
 *   • Фильтр по умолчанию (по требованию пользователя):
 *       is_archived = 0 (только активные)
 *       stock_position = 'да' (только складская позиция)
 *       type = 'Товар' (исключаем комплекты)
 *       no_longer_cooperation — если query не задан: **не** «Да» в МС (`not_stopped`, как «Нет» в UI закупок)
 *
 * Эндпоинты:
 *   GET    /api/purchase            — список товаров с overrides и raw-полями; query `no_longer_cooperation`:
 *                            `all` | `not_stopped` (default, как UI закупок) | `stopped` — фильтр по ms_export.no_longer_cooperation;
 *                            дополнительно считается `formula_proposed_min_stock` (как на карточке товара:
 *                            перед расчётом для кодов страницы прогревается кэш составов комплектов (`ensureBundleComponentsForProduct`,
 *                            см. `routes/purchase.js`: батч-проверка свежести `dg_bundle_components.updated_at` и негативный кэш пустого состава,
 *                            чтобы не повторять тяжёлые LIKE по `ms_entity_details` на каждый запрос списка),
 *                            с нижним порогом по `min_stock_dg`: если «Нес.остаток Датагон» > 0, итог не ниже него;
 *                            сам `min_stock_dg` в опорный baseline формулы не входит (только `proposed_min_stock` из overrides или МС).
 *                            а также «снимок» продаж за 3…365 дн. (`d_*a`) и дней отсутствия (`d_*b`) для 15/30/60/90/180/365.
 *                            Доп. query-фильтры (все `0`/`1`, по умолчанию `0`): `zero_stock` — остаток ≤ 0;
 *                            `zero_stock_no_transit` — остаток ≤ 0 и «В пути» (`payload_json.inTransit`) ≤ 0 (JOIN `ms_entity_details`);
 *                            `no_multiplicity` — кратность в overrides пустая или &lt; 1; `incomplete_pack` — кратность ≥ 1 и 0 &lt; stock &lt; кратность.
 *                            Сортировка по вычисляемым полям (`d_*`, `formula_proposed_min_stock`, `in_transit`) выполняется
 *                            по всему отфильтрованному набору, затем применяется `limit`/`offset` (полный проход без
 *                            выборки `med.payload_json` для `d_*` — только при необходимости `JSON_EXTRACT` для «В пути»).
 *                            Для `formula_proposed_min_stock` — двухфазно: лёгкий список без `payload_json` + только формула
 *                            (без агрегатов окон 3…365 на всех строках), затем полная страница с payload и `d_*`.
 *                            Для `in_transit` и сортировки по `d_*` формула в ответе считается только для текущей страницы после slice.
 *   POST   /api/purchase/override   — сохранить одно значение (code + field + value).
 *   POST   /api/purchase/overrides-import — пакетный импорт CSV для min_stock_dg / multiplicity / min_stock_calc_as.
 *   GET    /api/purchase/log        — журнал изменений трёх полей overrides (query: code, limit, offset, field?).
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

/** Макс. уникальных кодов на странице, для которых выполняется прогрев составов комплектов. */
const PURCHASE_BUNDLE_WARM_MAX_CODES = 600;
/** Размер чанка для `IN (коды…)` в агрегатах продаж/нулей — иначе один запрос на десятки тысяч кодов «вешает» MySQL. */
const PURCHASE_CODES_SQL_CHUNK = 400;
/** Не дергать `ensureBundleComponentsForProduct` (LIKE по `ms_entity_details`), если кэш `dg_bundle_components` для кода свежий. */
const PURCHASE_BUNDLE_WARM_DB_TTL_MS = 8 * 60 * 60 * 1000;
/** После пустого кэша для компонента не повторять полный LIKE-скан до истечения (новые комплекты в МС — с задержкой). */
const PURCHASE_BUNDLE_EMPTY_NEGATIVE_MS = 4 * 60 * 60 * 1000;
const purchaseBundleEmptyWarmAt = new Map();

let schemaReady = false;

const OVERRIDE_FIELDS = new Set([
    'min_stock_dg',
    'multiplicity',
    'min_stock_calc_as',
    'proposed_min_stock',
    'pack_qty_manual'
]);

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
    min_stock_calc_as: 'po.min_stock_calc_as',
    proposed_min_stock: 'po.proposed_min_stock',
    stock: 'mse.stock',
    is_archived: 'mse.is_archived',
    /* SQL-заглушка; фактический порядок — после enrich (см. PURCHASE_POST_SORT_KEYS). */
    formula_proposed_min_stock: 'mse.code',
    in_transit: 'mse.code',
    d_3: 'mse.code',
    d_5: 'mse.code',
    d_7: 'mse.code',
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
            min_stock_calc_as DECIMAL(15,3) NULL DEFAULT NULL,
            proposed_min_stock DECIMAL(15,3) NULL DEFAULT NULL,
            pack_qty_manual DECIMAL(15,3) NULL DEFAULT NULL,
            note VARCHAR(500) NULL,
            updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            INDEX idx_dg_purchase_overrides_updated (updated_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
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
const PURCHASE_IMPORT_OVERRIDE_FIELDS = ['min_stock_dg', 'multiplicity', 'min_stock_calc_as'];

/** Поля закупок, которые пишутся в `dg_purchase_overrides_log` при изменении. */
const PURCHASE_LOG_FIELDS = new Set(['min_stock_dg', 'multiplicity', 'min_stock_calc_as']);

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
    min_stock_calc_as: 'Мин.Остаток сч.как 0',
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
 * Поддерживаются русские подписи как в UI и вариант «Мин.Остаток сч.как 0» (Excel).
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
    if (compact === 'minstockcalcas' || compact === 'min_stock_calc_as') return 'min_stock_calc_as';
    if (lower.includes('мин') && lower.includes('остаток') && lower.includes('сч') && lower.includes('как')) {
        return 'min_stock_calc_as';
    }
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
    const idx = { code: -1, min_stock_dg: -1, multiplicity: -1, min_stock_calc_as: -1 };
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
            'CSV: нужна хотя бы одна колонка из: Нес.остаток Датагон / Кратность товара / Мин.Остаток сч.как (или «…сч.как 0»)',
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
            `SELECT code, min_stock_dg, multiplicity, min_stock_calc_as FROM dg_purchase_overrides WHERE code IN (${ph})`,
            part,
        );
        for (const row of r || []) {
            map.set(String(row.code || '').trim(), {
                min_stock_dg: row.min_stock_dg != null ? Number(row.min_stock_dg) : null,
                multiplicity: row.multiplicity != null ? Number(row.multiplicity) : null,
                min_stock_calc_as: row.min_stock_calc_as != null ? Number(row.min_stock_calc_as) : null,
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
            min_stock_calc_as: null,
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
            `INSERT INTO dg_purchase_overrides (code, min_stock_dg, multiplicity, min_stock_calc_as)
             VALUES (?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE
                min_stock_dg = VALUES(min_stock_dg),
                multiplicity = VALUES(multiplicity),
                min_stock_calc_as = VALUES(min_stock_calc_as)`,
            [p.code, next.min_stock_dg, next.multiplicity, next.min_stock_calc_as],
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

/** Сортировка по вычисляемым полям — после enrich по всему отфильтрованному набору, затем пагинация slice. */
const PURCHASE_POST_SORT_KEYS = new Set([
    'formula_proposed_min_stock',
    'in_transit',
    'd_3',
    'd_5',
    'd_7',
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

/** Сортировка по «В пути» — не требует агрегатов продаж; формула и d_* считаются только для страницы после slice. */
const PURCHASE_IN_TRANSIT_SORT = 'in_transit';
/** Сортировка по предлагаемому неснижаемому: см. двухфазный путь в GET / (лёгкий список + formula_only, затем полная страница). */
const PURCHASE_FORMULA_SORT = 'formula_proposed_min_stock';

function purchasePostSortNumeric(row, key) {
    const v = row[key];
    if (key === 'in_transit') {
        if (v == null || v === '') return null;
    }
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

function sortPurchaseDataByKey(data, sortKey, desc) {
    data.sort((a, b) => {
        const na = purchasePostSortNumeric(a, sortKey);
        const nb = purchasePostSortNumeric(b, sortKey);
        const va = na != null ? na : desc ? -1e18 : 1e18;
        const vb = nb != null ? nb : desc ? -1e18 : 1e18;
        if (vb === va) return String(a.code).localeCompare(String(b.code), 'ru');
        return desc ? vb - va : va - vb;
    });
}

/** Одна строка списка закупок (общая для полного SELECT с payload и лёгкого без med). */
function mapPurchaseSqlRowToDataItem(r, opts = {}) {
    const noPayload = Boolean(opts.noPayloadForFormula);
    const payload = noPayload ? null : parsePayloadSafe(r.payload_json);
    const article = payload && typeof payload.article === 'string' ? payload.article : '';
    const packQtyAuto = extractPackQty(payload);
    let inTransit = extractInTransit(payload);
    if ((inTransit == null || !Number.isFinite(inTransit)) && r && r.in_transit_sort != null && r.in_transit_sort !== '') {
        const t = Number(r.in_transit_sort);
        if (Number.isFinite(t)) inTransit = t;
    }
    const supplierLabel = buildSupplierLabel(r.supplier, r.supplier2);
    return {
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
        min_stock_calc_as: r.min_stock_calc_as,
        pack_qty: r.pack_qty_manual != null ? r.pack_qty_manual : packQtyAuto,
        pack_qty_auto: packQtyAuto,
        pack_qty_manual: r.pack_qty_manual,
        stock: Number(r.stock || 0),
        in_transit: inTransit,
        no_longer_cooperation: r.no_longer_cooperation || '',
        stock_position: r.stock_position || '',
        override_updated_at: r.override_updated_at || null,
        formula_proposed_min_stock: null,
        d_3: 0,
        d_5: 0,
        d_7: 0,
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
               INNER JOIN (
                    SELECT bundle_uuid, SUM(qty_per_bundle) AS qty_sum
                      FROM dg_bundle_components
                     GROUP BY bundle_uuid
                   ) tot ON tot.bundle_uuid = bc.bundle_uuid
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
               INNER JOIN (
                    SELECT bundle_uuid, SUM(qty_per_bundle) AS qty_sum
                      FROM dg_bundle_components
                     GROUP BY bundle_uuid
                   ) tot ON tot.bundle_uuid = bc.bundle_uuid
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
               INNER JOIN (
                    SELECT bundle_uuid, SUM(qty_per_bundle) AS qty_sum
                      FROM dg_bundle_components
                     GROUP BY bundle_uuid
                   ) tot ON tot.bundle_uuid = bc.bundle_uuid
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

    let directRows = [];
    let bundleRows = [];
    let absenceRows = [];
    let dirWinMap = new Map();
    let bunWinMap = new Map();
    let absMultiMap = new Map();
    let absSumMap = new Map();
    let zeroWinMap = new Map();

    if (mode === 'windows_only') {
        const [dr, br, am] = await Promise.all([
            loadPurchaseDirectSalesWindowsMap(db, codes),
            loadPurchaseBundleSalesWindowsMap(db, safeComponentCodes),
            loadPurchaseAbsenceDistinctDaysAggregateMap(db, codes),
        ]);
        dirWinMap = dr;
        bunWinMap = br;
        absMultiMap = am;
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

    const rowByCode = new Map(
        (sqlRows || []).map((row) => [String(row.code || '').trim(), row]).filter(([k]) => k),
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
        const marketPriceRub = opts.noPayloadForFormula ? null : marketPriceRubFromPayload(payload);

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

        if (mode !== 'formula_only') {
            d.d_3 = sumWindowQty(codeKey, isBundle, 3);
            d.d_5 = sumWindowQty(codeKey, isBundle, 5);
            d.d_7 = sumWindowQty(codeKey, isBundle, 7);
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

    router.get('/', async (req, res) => {
        try {
            await ensureSchema(db);

            const limitRaw = parseInt(req.query.limit, 10);
            const offsetRaw = parseInt(req.query.offset, 10);
            const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(1000, limitRaw) : 100;
            const offset = Number.isFinite(offsetRaw) && offsetRaw >= 0 ? offsetRaw : 0;

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

            const sortKey = ALLOWED_SORT[String(req.query.sort_by || 'code')] ? String(req.query.sort_by || 'code') : 'code';
            const sortDir = String(req.query.sort_dir || 'asc').toLowerCase() === 'desc' ? 'DESC' : 'ASC';

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
                    'COALESCE(CAST(NULLIF(JSON_UNQUOTE(JSON_EXTRACT(med.payload_json, \'$.inTransit\')), \'\') AS DECIMAL(18,6)), 0) <= 0',
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
                where.push(
                    '(CAST(TRIM(CAST(po.multiplicity AS CHAR)) AS DECIMAL(18,6)) >= 1 AND COALESCE(mse.stock, 0) > 0 AND COALESCE(mse.stock, 0) < CAST(TRIM(CAST(po.multiplicity AS CHAR)) AS DECIMAL(18,6)))',
                );
            }

            if (noLongerMode === 'stopped') {
                where.push("LOWER(TRIM(COALESCE(mse.no_longer_cooperation, ''))) = 'да'");
            } else if (noLongerMode === 'not_stopped') {
                where.push("LOWER(TRIM(COALESCE(mse.no_longer_cooperation, ''))) <> 'да'");
            }

            const whereSql = where.join(' AND ');
            const buyPriceExpr = "COALESCE(CAST(REPLACE(REPLACE(REPLACE(REPLACE(mse.buy_price, '₽', ''), ' ', ''), ' ', ''), ',', '.') AS DECIMAL(15,2)), 0)";
            const articleSortExpr = "COALESCE(med.code, mse.code)";

            const orderExpr = sortKey === 'buy_price'
                ? buyPriceExpr
                : sortKey === 'article'
                    ? articleSortExpr
                    : ALLOWED_SORT[sortKey];

            const baseFromJoin = `
                FROM ms_export mse
                LEFT JOIN dg_purchase_overrides po ON po.code = mse.code
                LEFT JOIN ms_entity_details med ON med.uuid = mse.uuid
            `;

            const listSelectBody = `
                SELECT
                    mse.code, mse.name, mse.supplier, mse.supplier2, mse.uuid, mse.type,
                    mse.is_archived, mse.stock_position, mse.no_longer_cooperation,
                    mse.buy_price, mse.min_stock, mse.stock, mse.automation_price,
                    mse.synced_at,
                    po.min_stock_dg, po.multiplicity, po.min_stock_calc_as,
                    po.proposed_min_stock, po.pack_qty_manual, po.updated_at AS override_updated_at,
                    med.payload_json
                ${baseFromJoin}
                WHERE ${whereSql}`;

            /** Без `ms_entity_details`: только сортировка по формуле на полном наборе (меньше I/O по TEXT). При фильтре `zero_stock_no_transit` JOIN нужен для условия по `inTransit` в WHERE. */
            const baseFromJoinLight = zeroStockNoTransit
                ? `
                FROM ms_export mse
                LEFT JOIN dg_purchase_overrides po ON po.code = mse.code
                LEFT JOIN ms_entity_details med ON med.uuid = mse.uuid
            `
                : `
                FROM ms_export mse
                LEFT JOIN dg_purchase_overrides po ON po.code = mse.code
            `;
            const listSelectLight = `
                SELECT
                    mse.code, mse.name, mse.supplier, mse.supplier2, mse.uuid, mse.type,
                    mse.is_archived, mse.stock_position, mse.no_longer_cooperation,
                    mse.buy_price, mse.min_stock, mse.stock, mse.automation_price,
                    mse.synced_at,
                    po.min_stock_dg, po.multiplicity, po.min_stock_calc_as,
                    po.proposed_min_stock, po.pack_qty_manual, po.updated_at AS override_updated_at
                ${baseFromJoinLight}
                WHERE ${whereSql}`;

            const needPostSort = PURCHASE_POST_SORT_KEYS.has(sortKey);
            const listSqlPaged = `${listSelectBody}
                ORDER BY ${orderExpr} ${sortDir}, mse.id ASC
                LIMIT ? OFFSET ?`;
            /** COUNT без join к `ms_entity_details`, иначе MySQL тянет `payload_json` по всей выборке. */
            const countFromJoin = zeroStockNoTransit
                ? baseFromJoin
                : `
                FROM ms_export mse
                LEFT JOIN dg_purchase_overrides po ON po.code = mse.code
            `;
            const countSql = `SELECT COUNT(*) AS cnt ${countFromJoin} WHERE ${whereSql}`;
            /** Полный список для пост-сортировки без `payload_json`: иначе при смене сортировки по d_* читается гигабайт JSON на больших выборках. */
            const inTransitSortExpr =
                "COALESCE(CAST(NULLIF(JSON_UNQUOTE(JSON_EXTRACT(med.payload_json, '$.inTransit')), '') AS DECIMAL(18,6)), 0)";
            const usePostSortNonFormula = needPostSort && sortKey !== PURCHASE_FORMULA_SORT;
            const postSortMedJoin = usePostSortNonFormula && (zeroStockNoTransit || sortKey === PURCHASE_IN_TRANSIT_SORT);
            const transitSortCol = postSortMedJoin ? `, ${inTransitSortExpr} AS in_transit_sort` : '';
            const baseFromPostSort = postSortMedJoin
                ? `
                FROM ms_export mse
                LEFT JOIN dg_purchase_overrides po ON po.code = mse.code
                LEFT JOIN ms_entity_details med ON med.uuid = mse.uuid
            `
                : `
                FROM ms_export mse
                LEFT JOIN dg_purchase_overrides po ON po.code = mse.code
            `;
            const listSelectPostSortFull = `
                SELECT
                    mse.code, mse.name, mse.supplier, mse.supplier2, mse.uuid, mse.type,
                    mse.is_archived, mse.stock_position, mse.no_longer_cooperation,
                    mse.buy_price, mse.min_stock, mse.stock, mse.automation_price,
                    mse.synced_at,
                    po.min_stock_dg, po.multiplicity, po.min_stock_calc_as,
                    po.proposed_min_stock, po.pack_qty_manual, po.updated_at AS override_updated_at
                    ${transitSortCol}
                ${baseFromPostSort}
                WHERE ${whereSql}`;
            const listSqlFullPostSort = `${listSelectPostSortFull}
                ORDER BY mse.id ASC`;
            const listSqlFullLight = `${listSelectLight}
                ORDER BY mse.id ASC`;

            const useFormulaSortLight = needPostSort && sortKey === PURCHASE_FORMULA_SORT;
            /** Сортировка по колонкам mse/po: сначала страница без `med`, затем `payload_json` только для LIMIT строк (см. `datagon-list-query-patterns.mdc`). */
            const useTwoPhasePagedList =
                !needPostSort && !zeroStockNoTransit && sortKey !== 'article';

            async function runTwoPhasePagedList() {
                const sql = `${listSelectLight} ORDER BY ${orderExpr} ${sortDir}, mse.id ASC LIMIT ? OFFSET ?`;
                const [r1] = await db.query(sql, [...params, limit, offset]);
                const orderedCodes = (r1 || []).map((r) => String(r.code || '').trim()).filter(Boolean);
                if (!orderedCodes.length) return [[], undefined];
                const ph = orderedCodes.map(() => '?').join(',');
                const [r2] = await db.query(`${listSelectBody} AND mse.code IN (${ph})`, [...params, ...orderedCodes]);
                const byC = new Map((r2 || []).map((row) => [String(row.code || '').trim(), row]));
                const ordered = orderedCodes.map((c) => byC.get(c)).filter(Boolean);
                return [ordered, undefined];
            }

            let rowsPromise;
            if (useFormulaSortLight) {
                rowsPromise = db.query(listSqlFullLight, params);
            } else if (needPostSort) {
                rowsPromise = db.query(listSqlFullPostSort, params);
            } else if (useTwoPhasePagedList) {
                rowsPromise = runTwoPhasePagedList();
            } else {
                rowsPromise = db.query(listSqlPaged, [...params, limit, offset]);
            }

            const [[rows], [countRow]] = await Promise.all([rowsPromise, db.query(countSql, params)]);

            const data = (rows || []).map((r) =>
                mapPurchaseSqlRowToDataItem(r, useFormulaSortLight ? { noPayloadForFormula: true } : {}),
            );

            let responseData = data;
            if (!needPostSort) {
                await enrichPurchaseRowsWithFormula(db, appSettings || {}, rows, data, { mode: 'all' });
            } else {
                const desc = String(req.query.sort_dir || 'asc').toLowerCase() === 'desc';
                if (sortKey === PURCHASE_FORMULA_SORT) {
                    await enrichPurchaseRowsWithFormula(db, appSettings || {}, rows, data, {
                        mode: 'formula_only',
                        noPayloadForFormula: true,
                    });
                    sortPurchaseDataByKey(data, sortKey, desc);
                    responseData = data.slice(offset, offset + limit);
                    const pageCodesOrdered = responseData.map((d) => String(d.code || '').trim()).filter(Boolean);
                    if (pageCodesOrdered.length) {
                        const phPage = pageCodesOrdered.map(() => '?').join(',');
                        const [pf] = await db.query(
                            `${listSelectBody} AND mse.code IN (${phPage})`,
                            [...params, ...pageCodesOrdered],
                        );
                        const byC = new Map((pf || []).map((r) => [String(r.code || '').trim(), r]));
                        const orderedRows = pageCodesOrdered.map((c) => byC.get(c)).filter(Boolean);
                        responseData = orderedRows.map((r) => mapPurchaseSqlRowToDataItem(r));
                        await enrichPurchaseRowsWithFormula(db, appSettings || {}, orderedRows, responseData, {
                            mode: 'all',
                        });
                    }
                } else if (sortKey === PURCHASE_IN_TRANSIT_SORT) {
                    sortPurchaseDataByKey(data, sortKey, desc);
                    responseData = data.slice(offset, offset + limit);
                    const pageCodesOrdered = responseData.map((d) => String(d.code || '').trim()).filter(Boolean);
                    if (pageCodesOrdered.length) {
                        const phPage = pageCodesOrdered.map(() => '?').join(',');
                        const [pf] = await db.query(
                            `${listSelectBody} AND mse.code IN (${phPage})`,
                            [...params, ...pageCodesOrdered],
                        );
                        const byC = new Map((pf || []).map((r) => [String(r.code || '').trim(), r]));
                        const orderedRows = pageCodesOrdered.map((c) => byC.get(c)).filter(Boolean);
                        await enrichPurchaseRowsWithFormula(db, appSettings || {}, orderedRows, responseData, {
                            mode: 'all',
                        });
                    }
                } else {
                    await enrichPurchaseRowsWithFormula(db, appSettings || {}, rows, data, { mode: 'windows_only' });
                    sortPurchaseDataByKey(data, sortKey, desc);
                    responseData = data.slice(offset, offset + limit);
                    const pageCodesOrdered = responseData.map((d) => String(d.code || '').trim()).filter(Boolean);
                    if (pageCodesOrdered.length) {
                        const phPage = pageCodesOrdered.map(() => '?').join(',');
                        const [pf] = await db.query(
                            `${listSelectBody} AND mse.code IN (${phPage})`,
                            [...params, ...pageCodesOrdered],
                        );
                        const byC = new Map((pf || []).map((r) => [String(r.code || '').trim(), r]));
                        const orderedRows = pageCodesOrdered.map((c) => byC.get(c)).filter(Boolean);
                        await enrichPurchaseRowsWithFormula(db, appSettings || {}, orderedRows, responseData, {
                            mode: 'formula_only',
                        });
                    }
                }
            }

            res.json({
                success: true,
                total: Number(countRow[0]?.cnt || 0),
                limit,
                offset,
                sort_by: sortKey,
                sort_dir: sortDir.toLowerCase(),
                data: responseData,
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
                    `SELECT min_stock_dg, multiplicity, min_stock_calc_as
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
                `SELECT code, min_stock_dg, multiplicity, min_stock_calc_as, proposed_min_stock, pack_qty_manual, updated_at
                 FROM dg_purchase_overrides WHERE code = ? LIMIT 1`,
                [code]
            );
            const stored = verifyRows && verifyRows[0] ? verifyRows[0] : null;
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
     * Нес.остаток Датагон / Кратность товара / Мин.Остаток сч.как (в т.ч. заголовок «…сч.как 0»).
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
