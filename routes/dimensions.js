'use strict';

/**
 * Маркетплейсы → Габариты: реестр замеров габаритов товаров и комплектов МойСклад.
 *
 * Источник истины базовых полей (код, наименование, тип) — таблица `ms_export`.
 * Замеры (кто замерял, дата замера, сами габариты) хранятся в отдельной таблице
 * `ms_dimensions_measurements` и подмешиваются к строкам ms_export по полю `code`.
 *
 * См. правила:
 * - .cursor/rules/datagon-list-page-baseline-moysklad.mdc
 * - .cursor/rules/datagon-table-filter-apply.mdc
 * - .cursor/rules/datagon-node-restart-lock.mdc
 */

const express = require('express');
const axios = require('axios');
const config = require('../config');
const mpIssuesRowFilters = require('../lib/mpIssuesRowFilters');

const MS_BASE_URL = 'https://api.moysklad.ru/api/remap/1.2';
const MS_ATTR_META_TTL_MS = 60 * 60 * 1000; /** 1 час — параритет с moysklad.js */
const msAttrMetaCache = new Map(); /** entityKind('product'|'bundle') → { ts, rows } */

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
/** Сколько строк максимум сканируем из БД для пост-фильтрации (НДС/габариты МП / «проблемные»). */
const DIM_LIST_POST_FILTER_CAP = 50000;
/**
 * Максимум совпадений после пост-фильтра в памяти (сортировка + total). Без лимита десятки тысяч
 * разобранных `payload_json` раздувают heap Node до OOM (~4GB).
 */
const DIM_POST_FILTER_MAX_MATCHED = 4000;

const MP_JOIN_SQL = `
                LEFT JOIN marketplace_export_rows dg_dim_ozon
                    ON dg_dim_ozon.marketplace = 'ozon' AND dg_dim_ozon.external_id = mse.code
                LEFT JOIN marketplace_export_rows dg_dim_wb
                    ON dg_dim_wb.marketplace = 'wildberries' AND dg_dim_wb.external_id = mse.code
                LEFT JOIN marketplace_export_rows dg_dim_ym
                    ON dg_dim_ym.marketplace = 'yandex_market' AND dg_dim_ym.external_id = mse.code`;

const MP_SCOPE_POST = new Set(['vat_mismatch', 'dims_mismatch']);

function normalizeMpScopeFromQuery(query) {
    const raw = String((query && query.mp_scope) || '').trim().toLowerCase();
    const aliases = {
        all: 'all',
        any: 'any',
        all3: 'all3',
        'all-3': 'all3',
        ozon: 'ozon',
        wb: 'wb',
        wildberries: 'wb',
        ym: 'ym',
        yandex: 'ym',
        'yandex-market': 'ym',
        yandex_market: 'ym',
        vat_mismatch: 'vat_mismatch',
        'vat-mismatch': 'vat_mismatch',
        dims_mismatch: 'dims_mismatch',
        'dims-mismatch': 'dims_mismatch',
    };
    return aliases[raw] || 'all';
}

/** Профиль «Проблемные товары»: остаток > 0, не заполнены нужные поля замера. */
function normalizeProblemProfileFromQuery(query) {
    const v = String((query && query.problem_profile) || '').trim().toLowerCase();
    if (v === 'stock_missing' || v === 'problem' || v === 'problem_stock') return 'stock_missing';
    return '';
}

/**
 * Замер: all | with | without. Раньше передавалось как `scope` — поддерживаем обратную совместимость,
 * если в `scope` не зашит маркетплейсный пресет.
 */
function normalizeMeasureScopeFromQuery(query) {
    const ms = String((query && query.measure_scope) || '').trim().toLowerCase();
    if (ms === 'with' || ms === 'without') return ms;
    const legacy = String((query && query.scope) || '').trim().toLowerCase();
    if (legacy === 'with' || legacy === 'without') return legacy;
    if (
        legacy === 'any'
        || legacy === 'all3'
        || legacy === 'ozon'
        || legacy === 'wb'
        || legacy === 'ym'
        || legacy === 'vat_mismatch'
        || legacy === 'dims_mismatch'
        || legacy === 'vat-mismatch'
        || legacy === 'dims-mismatch'
    ) {
        return 'all';
    }
    return 'all';
}

function sqlWhereMpScope(mpScope) {
    if (mpScope === 'ozon') return ' AND dg_dim_ozon.external_id IS NULL';
    if (mpScope === 'wb') return ' AND dg_dim_wb.external_id IS NULL';
    if (mpScope === 'ym') return ' AND dg_dim_ym.external_id IS NULL';
    if (mpScope === 'all3') {
        return ' AND dg_dim_ozon.external_id IS NULL AND dg_dim_wb.external_id IS NULL AND dg_dim_ym.external_id IS NULL';
    }
    if (mpScope === 'any') {
        return ' AND (dg_dim_ozon.external_id IS NULL OR dg_dim_wb.external_id IS NULL OR dg_dim_ym.external_id IS NULL)';
    }
    return '';
}

function isFieldDisabledForPackingKind(kind, key) {
    if (kind === 'bag' && key === 'height_box_cm') return true;
    if ((kind === 'box' || kind === 'custom_box') && key === 'height_bag_cm') return true;
    return false;
}

/** Эвристика «пусто» для обязательности замера (как на клиенте resolveCellSource). */
function resolveCellSourceForProblem(rowOut, key) {
    const measurement = rowOut.measurement || {};
    if (measurement[key] != null && String(measurement[key]).trim() !== '') {
        return { source: 'override' };
    }
    const dims = rowOut.dimensions_ms || {};
    if (dims[key] != null && String(dims[key]).trim() !== '') {
        const raw = String(dims[key]).trim();
        if (key !== 'packing_type') {
            const n = Number(raw.replace(',', '.'));
            if (Number.isFinite(n)) return { source: 'ms' };
        } else {
            return { source: 'ms' };
        }
    }
    const parsed = rowOut.dimensions_parsed || {};
    if (parsed[key] != null) return { source: 'parsed' };
    return { source: 'empty' };
}

function computeProblemCellsForRow(rowOut) {
    if (!rowOut || !(Number(rowOut.stock) > 0)) return null;
    const parsed = rowOut.dimensions_parsed || {};
    const kind = parsed.kind || 'unknown';
    const missing = {};
    for (const k of Object.keys(MEASUREMENT_FIELDS)) {
        if (isFieldDisabledForPackingKind(kind, k)) continue;
        const r = resolveCellSourceForProblem(rowOut, k);
        if (r.source === 'empty') missing[k] = true;
    }
    return Object.keys(missing).length ? missing : null;
}

function mapSqlRowToIssueFilterShape(r) {
    return {
        code: r.code,
        name: r.name,
        uuid: r.uuid,
        type: r.type,
        ms_vat: r.ms_vat,
        manager: r.manager,
        content_manager: r.content_manager,
        synced_at: r.synced_at,
        ms_stock: r.stock,
        ms_length: r.ms_length,
        ms_width: r.ms_width,
        ms_height_box: r.ms_height_box,
        ms_height_bag: r.ms_height_bag,
        ms_weight: r.ms_weight,
        ozon_code: r.ozon_code,
        ozon_name: r.ozon_name,
        ozon_vat: r.ozon_vat,
        ozon_stock: r.ozon_stock,
        ozon_length: r.ozon_length,
        ozon_width: r.ozon_width,
        ozon_height: r.ozon_height,
        ozon_weight: r.ozon_weight,
        wb_code: r.wb_code,
        wb_name: r.wb_name,
        wb_vat: r.wb_vat,
        wb_stock: r.wb_stock,
        wb_length: r.wb_length,
        wb_width: r.wb_width,
        wb_height: r.wb_height,
        wb_weight: r.wb_weight,
        ym_code: r.ym_code,
        ym_name: r.ym_name,
        ym_vat: r.ym_vat,
        ym_stock: r.ym_stock,
        ym_length: r.ym_length,
        ym_width: r.ym_width,
        ym_height: r.ym_height,
        ym_weight: r.ym_weight,
    };
}

function mapDimensionListRow(r) {
    const payload = parsePayloadSafe(r.payload_json);
    const dimsMs = buildDimensionsFromPayload(payload);
    const measurement = rowToMeasurement({
        length_cm: r.m_length_cm,
        width_cm: r.m_width_cm,
        height_box_cm: r.m_height_box_cm,
        height_bag_cm: r.m_height_bag_cm,
        weight_kg: r.m_weight_kg,
        packing_type: r.m_packing_type,
    });
    const packingForParse = (measurement && measurement.packing_type)
        ? measurement.packing_type
        : dimsMs.packing_type;
    const parsed = parsePackingDims(packingForParse);
    return {
        code: String(r.code || ''),
        name: String(r.name || ''),
        type: String(r.type || ''),
        uuid: String(r.uuid || ''),
        stock: r.stock != null ? Number(r.stock) : null,
        is_archived: Number(r.is_archived || 0) === 1,
        measured_by_user_id: r.measured_by_user_id != null ? Number(r.measured_by_user_id) : null,
        measured_by_name: r.measured_by_name != null ? String(r.measured_by_name) : '',
        measured_at: r.measured_at ? new Date(r.measured_at).toISOString() : '',
        dimensions_ms: dimsMs,
        measurement,
        dimensions_parsed: parsed,
    };
}

/** Значение для сортировки в памяти (пост-фильтр): override → MS из payload, как в UI. */
function sortMetricRawString(row, key) {
    const m = row && row.measurement;
    const d = row && row.dimensions_ms;
    if (m && m[key] != null && String(m[key]).trim() !== '') return String(m[key]).trim();
    if (d && d[key] != null && String(d[key]).trim() !== '') return String(d[key]).trim();
    return '';
}

function sortMetricNumberOrNull(row, key) {
    const s = sortMetricRawString(row, key);
    if (!s) return null;
    const n = Number(String(s).replace(',', '.'));
    return Number.isFinite(n) ? n : null;
}

/** Порядок как у `ORDER BY col ASC` в MySQL для DECIMAL NULL: NULL раньше чисел. */
function compareNullableNumberSqlOrder(aVal, bVal) {
    const aNull = aVal == null || !Number.isFinite(aVal);
    const bNull = bVal == null || !Number.isFinite(bVal);
    if (aNull && bNull) return 0;
    if (aNull) return -1;
    if (bNull) return 1;
    return aVal - bVal;
}

function compareDimensionOutRows(a, b, sortBy, sortDir) {
    const dir = String(sortDir || 'asc').toLowerCase() === 'desc' ? -1 : 1;
    const sb = String(sortBy || 'code');
    const num = (x) => (x == null || Number.isNaN(Number(x)) ? 0 : Number(x));
    const str = (x) => String(x == null ? '' : x);
    let cmp = 0;
    if (sb === 'stock') cmp = num(a.stock) - num(b.stock);
    else if (sb === 'measured_at') cmp = str(a.measured_at).localeCompare(str(b.measured_at), 'ru');
    else if (sb === 'measured_by_name') cmp = str(a.measured_by_name).localeCompare(str(b.measured_by_name), 'ru');
    else if (sb === 'name') cmp = str(a.name).localeCompare(str(b.name), 'ru');
    else if (sb === 'type') cmp = str(a.type).localeCompare(str(b.type), 'ru');
    else if (sb === 'packing_type') {
        cmp = sortMetricRawString(a, 'packing_type').localeCompare(sortMetricRawString(b, 'packing_type'), 'ru');
    } else if (
        sb === 'length_cm' ||
        sb === 'width_cm' ||
        sb === 'height_box_cm' ||
        sb === 'height_bag_cm' ||
        sb === 'weight_kg'
    ) {
        cmp = compareNullableNumberSqlOrder(sortMetricNumberOrNull(a, sb), sortMetricNumberOrNull(b, sb));
    } else cmp = str(a.code).localeCompare(str(b.code), 'ru');
    if (cmp !== 0) return cmp * dir;
    return str(a.code).localeCompare(str(b.code), 'ru') * dir;
}

/**
 * Пост-фильтр по строкам с тяжёлым `payload_json`: один `pool.query` на 50k строк
 * тянет все LONGTEXT в память → риск OOM. Читаем чанками `LIMIT/OFFSET` через promise-pool
 * (у mysql2/promise `connection.query()` без колбэка возвращает Promise, а не stream — `.on` недоступен).
 * Возвращает `{ rows, truncated }` — `truncated`, если достигнут лимит совпадений в памяти (есть ещё в БД).
 */
async function collectPostFilteredDimensionRowsChunked(db, selectForCap, fromForCap, whereFull, baseParams, ctx) {
    const { problemStock, postFilter, mpScope } = ctx;
    const matched = [];
    /** `postFilter` тянет широкий JOIN маркетплейсов — маленький чанк. `problem_stock` — узкий SELECT, можно больше строк за round-trip. */
    const CHUNK = postFilter ? 400 : 1200;
    const maxScan = DIM_LIST_POST_FILTER_CAP;
    const baseSql = `${selectForCap}\n                 ${fromForCap}\n                 ${whereFull}\n                 ORDER BY mse.code ASC`;
    let offset = 0;
    while (offset < maxScan) {
        const take = Math.min(CHUNK, maxScan - offset);
        const sql = `${baseSql}\n                 LIMIT ? OFFSET ?`;
        const [rows] = await db.query(sql, baseParams.concat([take, offset]));
        if (!rows || rows.length === 0) break;
        for (let i = 0; i < rows.length; i += 1) {
            const row = rows[i];
            const out = mapDimensionListRow(row);
            try {
                row.payload_json = null;
            } catch (_) {}
            if (problemStock) {
                const cells = computeProblemCellsForRow(out);
                if (cells) {
                    out.problem_cells = cells;
                    matched.push(out);
                }
            } else if (postFilter) {
                const ir = mapSqlRowToIssueFilterShape(row);
                mpIssuesRowFilters.formatIssueRowMsDims(ir);
                mpIssuesRowFilters.preprocessIssueRowVatPretty(ir);
                const keep =
                    mpScope === 'vat_mismatch'
                        ? mpIssuesRowFilters.issuesRowVatMismatch(ir)
                        : mpIssuesRowFilters.issuesRowDimsMismatch(ir);
                if (keep) matched.push(out);
            }
            if (matched.length >= DIM_POST_FILTER_MAX_MATCHED) {
                return { rows: matched, truncated: true };
            }
        }
        offset += rows.length;
        if (rows.length < take) break;
    }
    return { rows: matched, truncated: false };
}

const ALLOWED_SORT = {
    code: 'mse.code',
    name: 'mse.name',
    type: 'mse.type',
    stock: 'mse.stock',
    measured_by_name: 'mdm.measured_by_name',
    measured_at: 'mdm.measured_at',
    packing_type: 'mdm.packing_type',
    length_cm: 'mdm.length_cm',
    width_cm: 'mdm.width_cm',
    height_box_cm: 'mdm.height_box_cm',
    height_bag_cm: 'mdm.height_bag_cm',
    weight_kg: 'mdm.weight_kg',
};

/**
 * Габаритные атрибуты МойСклада. Берём «как есть» по имени из payload_json
 * (ms_entity_details.payload_json), потому что в ms_export фиксированно 23 столбца
 * и расширять схему ради этой страницы избыточно (см. требования пользователя).
 * Ключ слева — стабильное поле в API ответа, справа — точное имя атрибута в МС.
 */
const DIMENSION_ATTRS = [
    { key: 'packing_type', attr: '!!Тип УПАКОВКИ', label: 'Тип упаковки' },
    { key: 'length_cm', attr: '!!Длина (см) КОРОБКА/Пакет станд. уп.', label: 'Длина (см)' },
    { key: 'width_cm', attr: '!!Ширина (см) КОРОБКА/Пакет станд. уп.', label: 'Ширина (см)' },
    { key: 'height_box_cm', attr: '!!Высота (см) КОРОБКА станд. уп.', label: 'Высота — коробка (см)' },
    { key: 'height_bag_cm', attr: '!!Высота (см) Пакет!', label: 'Высота — пакет (см)' },
    { key: 'weight_kg', attr: '!!Вес (кг)', label: 'Вес (кг)' },
];

function extractAttrValueFromPayload(payload, attrName) {
    if (!payload || !Array.isArray(payload.attributes)) return '';
    const a = payload.attributes.find((x) => x && x.name === attrName);
    if (!a) return '';
    const v = a.value;
    if (v == null) return '';
    if (typeof v === 'object') {
        if (typeof v.name === 'string') return v.name;
        return '';
    }
    return String(v);
}

function parsePayloadSafe(json) {
    if (!json) return null;
    try {
        const o = JSON.parse(json);
        if (o && typeof o === 'object') return o;
        return null;
    } catch (_) {
        return null;
    }
}

function buildDimensionsFromPayload(payload) {
    const out = {};
    for (const def of DIMENSION_ATTRS) {
        out[def.key] = extractAttrValueFromPayload(payload, def.attr);
    }
    return out;
}

/**
 * Эвристика «вид упаковки» по тексту атрибута «!!Тип УПАКОВКИ» из МС.
 *   bag         — курьерский/полипропиленовый/standard пакет: 2 числа → L,W;
 *                 «Высота — пакет» пользователь заполняет вручную, «Высота — коробка»
 *                 у него отсутствует по смыслу.
 *   box         — гофрокороб / стандартная коробка: 3 числа → L,W,H_коробки.
 *   custom_box  — «Своя упаковка»: габариты не парсим, пользователь заполняет L,W,H_коробки.
 *   unknown     — пытаемся распарсить 2/3 числа как обычно, но без подсказок UI.
 */
function detectPackingKind(s) {
    const text = String(s || '').toLowerCase();
    if (!text) return 'empty';
    if (/сво[ея]\s*упаковк/.test(text)) return 'custom_box';
    if (/пакет/.test(text)) return 'bag';
    if (/короб|гофр/.test(text)) return 'box';
    return 'unknown';
}

/**
 * Извлекает числовые габариты из текста (через «*», «х»/«x», «×», «/»).
 * Возвращает массив positive numbers (в сантиметрах, как в МС).
 * Примеры:
 *   "Гофкороб 30*20*15"          → [30, 20, 15]
 *   "Гофрокороб 30х20х15"         → [30, 20, 15]
 *   "Курьерский пакет 15*22"      → [15, 22]
 *   "Пакет 15х22 (СПП-3)"         → [15, 22]
 *   "Своя упаковка"               → []
 */
function extractNumbersFromPacking(s) {
    const text = String(s || '');
    if (!text) return [];
    /** Берём только последовательности «число (* x х × /) число …», чтобы не цеплять
     *  служебные коды вроде «СПП-3». */
    const seq = text.match(/\d+(?:[.,]\d+)?(?:\s*[*xх×\/]\s*\d+(?:[.,]\d+)?){1,4}/i);
    if (!seq) return [];
    const nums = seq[0].split(/[*xх×\/]/);
    const out = [];
    for (const n of nums) {
        const v = Number(String(n).replace(',', '.').trim());
        if (Number.isFinite(v) && v > 0) out.push(v);
    }
    return out;
}

function parsePackingDims(packingType) {
    const kind = detectPackingKind(packingType);
    const list = extractNumbersFromPacking(packingType);
    const out = {
        kind,
        length_cm: null,
        width_cm: null,
        height_box_cm: null,
        height_bag_cm: null,
    };
    if (kind === 'bag') {
        if (list.length >= 2) {
            out.length_cm = list[0];
            out.width_cm = list[1];
        }
        /** Высота пакета — без авто-значения, пользователь заполняет руками. */
    } else if (kind === 'box') {
        if (list.length >= 3) {
            out.length_cm = list[0];
            out.width_cm = list[1];
            out.height_box_cm = list[2];
        } else if (list.length === 2) {
            out.length_cm = list[0];
            out.width_cm = list[1];
        }
    } else if (kind === 'custom_box') {
        /** «Своя упаковка»: ничего не парсим, пользователь заполняет всё. */
    } else {
        /** Неклассифицированный текст: трактуем как «коробка», если есть 3 числа. */
        if (list.length >= 3) {
            out.length_cm = list[0];
            out.width_cm = list[1];
            out.height_box_cm = list[2];
        } else if (list.length === 2) {
            out.length_cm = list[0];
            out.width_cm = list[1];
        }
    }
    return out;
}

/** Поля габаритов, которые пользователь может править вручную (override-овая запись). */
const MEASUREMENT_FIELDS = {
    length_cm: { kind: 'number', min: 0, max: 99999, label: 'Длина (см)' },
    width_cm: { kind: 'number', min: 0, max: 99999, label: 'Ширина (см)' },
    height_box_cm: { kind: 'number', min: 0, max: 99999, label: 'Высота — коробка (см)' },
    height_bag_cm: { kind: 'number', min: 0, max: 99999, label: 'Высота — пакет (см)' },
    weight_kg: { kind: 'number', min: 0, max: 99999, label: 'Вес (кг)' },
    packing_type: { kind: 'string', max: 255, label: 'Тип упаковки' },
};

function normalizeFieldValue(field, raw) {
    const def = MEASUREMENT_FIELDS[field];
    if (!def) return undefined;
    if (raw == null || raw === '') return null;
    if (def.kind === 'number') {
        const v = Number(String(raw).replace(',', '.').trim());
        if (!Number.isFinite(v)) return null;
        if (def.min != null && v < def.min) return null;
        if (def.max != null && v > def.max) return null;
        return v;
    }
    const s = String(raw).trim();
    if (!s) return null;
    if (def.max && s.length > def.max) return s.slice(0, def.max);
    return s;
}

/** Сравнение «было vs стало» с поправкой на плавучку. */
function valuesEqual(field, a, b) {
    if (a == null && b == null) return true;
    if (a == null || b == null) return false;
    const def = MEASUREMENT_FIELDS[field];
    if (def && def.kind === 'number') {
        return Math.abs(Number(a) - Number(b)) < 1e-6;
    }
    return String(a) === String(b);
}

function formatValueForLog(field, v) {
    if (v == null) return null;
    return String(v);
}

let schemaReady = false;

async function ensureColumn(db, table, column, definition) {
    const [rows] = await db.query(
        'SHOW COLUMNS FROM `' + table + '` LIKE ?',
        [column],
    );
    if (Array.isArray(rows) && rows.length > 0) return;
    await db.query('ALTER TABLE `' + table + '` ADD COLUMN `' + column + '` ' + definition);
}

async function ensureSchema(db) {
    if (schemaReady) return;
    await db.query(`
        CREATE TABLE IF NOT EXISTS ms_dimensions_measurements (
            code VARCHAR(255) NOT NULL PRIMARY KEY,
            measured_by_user_id INT NULL,
            measured_by_name VARCHAR(255) NULL,
            measured_at TIMESTAMP NULL,
            dimensions_json LONGTEXT NULL,
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            INDEX idx_dim_meas_by_user (measured_by_user_id),
            INDEX idx_dim_meas_at (measured_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    /** Явные колонки под габариты — для удобного фильтра/сортировки + чтения без JSON-парсинга. */
    await ensureColumn(db, 'ms_dimensions_measurements', 'length_cm', 'DECIMAL(10,2) NULL AFTER measured_at');
    await ensureColumn(db, 'ms_dimensions_measurements', 'width_cm', 'DECIMAL(10,2) NULL AFTER length_cm');
    await ensureColumn(db, 'ms_dimensions_measurements', 'height_box_cm', 'DECIMAL(10,2) NULL AFTER width_cm');
    await ensureColumn(db, 'ms_dimensions_measurements', 'height_bag_cm', 'DECIMAL(10,2) NULL AFTER height_box_cm');
    await ensureColumn(db, 'ms_dimensions_measurements', 'weight_kg', 'DECIMAL(10,3) NULL AFTER height_bag_cm');
    await ensureColumn(db, 'ms_dimensions_measurements', 'packing_type', 'VARCHAR(255) NULL AFTER weight_kg');

    /** Журнал изменений: кто, что, когда менял; одна строка на одно поле. */
    await db.query(`
        CREATE TABLE IF NOT EXISTS ms_dimensions_log (
            id BIGINT AUTO_INCREMENT PRIMARY KEY,
            code VARCHAR(255) NOT NULL,
            field VARCHAR(64) NOT NULL,
            old_value VARCHAR(255) NULL,
            new_value VARCHAR(255) NULL,
            action VARCHAR(32) NOT NULL DEFAULT 'set',
            changed_by_user_id INT NULL,
            changed_by_name VARCHAR(255) NULL,
            note VARCHAR(500) NULL,
            changed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            INDEX idx_dim_log_code (code, changed_at),
            INDEX idx_dim_log_user (changed_by_user_id),
            INDEX idx_dim_log_field (field)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    schemaReady = true;
}

function numericOrNull(v) {
    if (v == null) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

function rowToMeasurement(r) {
    if (!r) return null;
    return {
        length_cm: numericOrNull(r.length_cm),
        width_cm: numericOrNull(r.width_cm),
        height_box_cm: numericOrNull(r.height_box_cm),
        height_bag_cm: numericOrNull(r.height_bag_cm),
        weight_kg: numericOrNull(r.weight_kg),
        packing_type: r.packing_type != null ? String(r.packing_type) : null,
    };
}

/**
 * Persist подмножества полей замера: пишет журнал по реально изменившимся полям и
 * UPSERT-ит строку в `ms_dimensions_measurements`. Возвращает свежий snapshot + список
 * фактически изменившихся полей. Используется и из `POST /measure`, и из `POST /sync-ms`
 * (когда фронтенд передаёт `measurement` с актуальными значениями инпутов, чтобы
 * любая правка ушла в МС, даже если до этого не успела сохраниться через blur/Enter).
 */
async function persistMeasurementFields(db, options) {
    const code = String(options.code || '').trim();
    if (!code) throw new Error('Не указан code');
    const incoming = options.incoming && typeof options.incoming === 'object' ? options.incoming : {};
    const allowedKeys = Object.keys(MEASUREMENT_FIELDS);
    const incomingKeys = allowedKeys.filter((k) =>
        Object.prototype.hasOwnProperty.call(incoming, k),
    );
    if (incomingKeys.length === 0) {
        return { changedFields: [], measurement: null, skipped_persist: true };
    }
    const normalized = {};
    for (const k of incomingKeys) normalized[k] = normalizeFieldValue(k, incoming[k]);

    const measuredByName = options.measuredByName || null;
    const measuredByUserId = options.measuredByUserId != null ? Number(options.measuredByUserId) : null;
    const measuredAt = options.measuredAt instanceof Date ? options.measuredAt : new Date();
    const note = options.note != null ? String(options.note).slice(0, 500) : null;

    const [oldRows] = await db.query(
        `SELECT length_cm, width_cm, height_box_cm, height_bag_cm, weight_kg, packing_type
         FROM ms_dimensions_measurements
         WHERE code = ?`,
        [code],
    );
    const oldRow = (Array.isArray(oldRows) && oldRows[0]) || {};

    const changedFields = [];
    for (const k of incomingKeys) {
        const oldEff =
            MEASUREMENT_FIELDS[k].kind === 'number'
                ? numericOrNull(oldRow[k])
                : oldRow[k] != null
                  ? String(oldRow[k])
                  : null;
        const newEff = normalized[k];
        if (valuesEqual(k, oldEff, newEff)) continue;
        await db.query(
            `INSERT INTO ms_dimensions_log
                (code, field, old_value, new_value, action, changed_by_user_id, changed_by_name, note, changed_at)
             VALUES (?, ?, ?, ?, 'set', ?, ?, ?, ?)`,
            [
                code,
                k,
                formatValueForLog(k, oldEff),
                formatValueForLog(k, newEff),
                measuredByUserId,
                measuredByName,
                note,
                measuredAt,
            ],
        );
        changedFields.push({ field: k, old: oldEff, new: newEff });
    }

    const setExprs = [];
    const setParams = [];
    for (const k of incomingKeys) {
        setExprs.push('`' + k + '` = ?');
        setParams.push(normalized[k]);
    }
    const insertCols = ['code', 'measured_by_user_id', 'measured_by_name', 'measured_at', ...incomingKeys];
    const insertVals = [code, measuredByUserId, measuredByName, measuredAt, ...incomingKeys.map((k) => normalized[k])];
    const placeholders = insertCols.map(() => '?').join(', ');
    await db.query(
        'INSERT INTO ms_dimensions_measurements (`' + insertCols.join('`, `') + '`) VALUES (' + placeholders + ')' +
            ' ON DUPLICATE KEY UPDATE measured_by_user_id = VALUES(measured_by_user_id),' +
            ' measured_by_name = VALUES(measured_by_name), measured_at = VALUES(measured_at), ' +
            setExprs.join(', '),
        [...insertVals, ...setParams],
    );

    const [freshRows] = await db.query(
        `SELECT length_cm, width_cm, height_box_cm, height_bag_cm, weight_kg, packing_type,
                measured_by_user_id, measured_by_name, measured_at
         FROM ms_dimensions_measurements WHERE code = ?`,
        [code],
    );
    const fresh = (Array.isArray(freshRows) && freshRows[0]) || null;
    return {
        changedFields,
        measurement: fresh ? rowToMeasurement(fresh) : null,
        measured_by_user_id:
            fresh && fresh.measured_by_user_id != null ? Number(fresh.measured_by_user_id) : measuredByUserId,
        measured_by_name: fresh && fresh.measured_by_name ? String(fresh.measured_by_name) : measuredByName,
        measured_at: fresh && fresh.measured_at ? new Date(fresh.measured_at) : measuredAt,
    };
}

function clampInt(value, min, max, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, Math.floor(n)));
}

function buildWhereClauseFromQuery(query) {
    /**
     * База: только складские позиции (`stock_position = 'Да'`), и при этом «не перестали
     * сотрудничать» (`no_longer_cooperation <> 'Да'`). Исключение: даже если по поставщику
     * прекращено сотрудничество, но **есть остаток** (`stock > 0`) — позицию **показываем**.
     * Запрос пользователя: «фильтруем на предмет складская позиция да и не перестали
     * сотрудничать - нет, но если есть остаток то все равно выводим».
     */
    const where = [
        "mse.stock_position = 'Да'",
        "(COALESCE(mse.no_longer_cooperation, '') <> 'Да' OR COALESCE(mse.stock, 0) > 0)",
    ];
    const params = [];

    const search = String((query && query.search) || '').trim();
    if (search) {
        const tokens = search.split(/\s+/).filter(Boolean).slice(0, 6);
        for (const tok of tokens) {
            const like = `%${tok}%`;
            where.push('(mse.code LIKE ? OR mse.name LIKE ?)');
            params.push(like, like);
        }
    }

    const typeRaw = String((query && query.type) || 'all').trim().toLowerCase();
    if (typeRaw === 'товар') {
        where.push('LOWER(mse.type) = ?');
        params.push('товар');
    } else if (typeRaw === 'комплект') {
        where.push('LOWER(mse.type) = ?');
        params.push('комплект');
    }

    const measureScope = normalizeMeasureScopeFromQuery(query);
    if (measureScope === 'with') {
        where.push('mdm.code IS NOT NULL');
    } else if (measureScope === 'without') {
        where.push('mdm.code IS NULL');
    }

    const whereSql = ' WHERE ' + where.join(' AND ');
    return { whereSql, params };
}

function resolveSort(query) {
    const sortBy = String((query && query.sort_by) || 'code').trim();
    const col = ALLOWED_SORT[sortBy] || ALLOWED_SORT.code;
    const dir = String((query && query.sort_dir) || 'asc').trim().toLowerCase() === 'desc' ? 'DESC' : 'ASC';
    /** Стабильность сортировки по `code` как вторичный ключ. */
    if (col === ALLOWED_SORT.code) return `${col} ${dir}`;
    return `${col} ${dir}, mse.code ASC`;
}

function actorDisplayName(actor) {
    if (!actor) return '';
    return String(actor.full_name || actor.username || '').trim();
}

/* ============================ Sync → MoySklad ================================ */

function getMsToken() {
    return process.env.MS_TOKEN || (config && config.msToken) || '';
}

function detectEntityKind(type) {
    const t = String(type || '').toLowerCase();
    if (t === 'комплект' || t === 'bundle') return 'bundle';
    return 'product';
}

/**
 * Кэш метаданных атрибутов для сущности product/bundle (1 час). На один и тот же
 * MS_TOKEN метаданные стабильны — повторно дёргать MS на каждый sync смысла нет.
 *
 * Важно: у `bundle` (комплекта) в MS API НЕТ собственного эндпоинта
 * `/entity/bundle/metadata/attributes` — он возвращает 404 «Неопознанный путь».
 * Комплекты делят набор пользовательских атрибутов с товарами (см. ответ
 * `/entity/bundle/{uuid}` → `meta.metadataHref = .../entity/product/metadata`).
 * Поэтому запрашиваем и кэшируем метаданные один раз под ключом `product`, а
 * для входного `entityKind === 'bundle'` нормализуемся к нему.
 */
async function fetchMsAttributesMeta(entityKind, headers) {
    const cacheKey = entityKind === 'bundle' ? 'product' : entityKind;
    const cached = msAttrMetaCache.get(cacheKey);
    const now = Date.now();
    if (cached && now - cached.ts < MS_ATTR_META_TTL_MS) return cached.rows;
    const url = MS_BASE_URL + '/entity/' + cacheKey + '/metadata/attributes';
    const resp = await axios.get(url, { headers, timeout: 30000 });
    const rows = (resp && resp.data && Array.isArray(resp.data.rows)) ? resp.data.rows : [];
    msAttrMetaCache.set(cacheKey, { ts: now, rows });
    return rows;
}

/** Сопоставление наших ключей замера → имена атрибутов в МС. */
const FIELD_TO_MS_ATTR = {
    length_cm: '!!Длина (см) КОРОБКА/Пакет станд. уп.',
    width_cm: '!!Ширина (см) КОРОБКА/Пакет станд. уп.',
    height_box_cm: '!!Высота (см) КОРОБКА станд. уп.',
    height_bag_cm: '!!Высота (см) Пакет!',
    weight_kg: '!!Вес (кг)',
    /** packing_type — `customentity` в МС (справочник): отправляем как ссылку на
     *  элемент справочника `{ meta: { href, type: 'customentity' } }`. Поиск элемента
     *  по имени делается через packingTypesCache (см. fetchPackingTypesFromMs). */
    packing_type: '!!Тип УПАКОВКИ',
};

/** Кэш справочника «Тип упаковки» (customentity) из МС, 1 час. */
const PACKING_TYPES_TTL_MS = 60 * 60 * 1000;
let packingTypesCache = { ts: 0, rows: [], source_url: '' };

async function fetchPackingTypesFromMs(forceRefresh) {
    const token = getMsToken();
    if (!token) {
        const e = new Error('MS_TOKEN не задан (env MS_TOKEN или config.msToken)');
        e.code = 'NO_TOKEN';
        throw e;
    }
    const now = Date.now();
    if (!forceRefresh && packingTypesCache.rows.length && now - packingTypesCache.ts < PACKING_TYPES_TTL_MS) {
        return packingTypesCache;
    }
    const headers = {
        Authorization: 'Bearer ' + token,
        Accept: 'application/json;charset=utf-8',
    };
    /** Метаданные атрибута «!!Тип УПАКОВКИ» лежат в атрибутах продукта; для bundle
     *  customentity-справочник тот же (привязан к именованному атрибуту, не к сущности). */
    const productAttrsMeta = await fetchMsAttributesMeta('product', headers);
    const packingAttr = productAttrsMeta.find((a) => a && String(a.name) === '!!Тип УПАКОВКИ');
    if (!packingAttr) {
        const e = new Error('Атрибут «!!Тип УПАКОВКИ» не найден в метаданных МС (entity/product)');
        e.code = 'ATTR_NOT_FOUND';
        throw e;
    }
    // У `customentity`-атрибута в метаданных продукта `customEntityMeta.href` ведёт
    // на МЕТАДАННЫЕ справочника:
    //   /context/companysettings/metadata/customEntities/<uuid>
    // — это объект `{meta, entityMeta, attributes, id, name, ...}` БЕЗ массива `rows`.
    // Список значений справочника живёт в `entityMeta.href`:
    //   /entity/customentity/<uuid>
    // и оттуда уже приходит `{rows: [{id, name, meta, ...}]}`. Старый код читал
    // metadata-URL напрямую и стабильно получал `rows.length = 0`, поэтому UI
    // на /exports-dimensions.html (кнопка «🔄 Тип упаковки» и `<select>` в
    // ячейке `packing_type`) показывал пустой справочник — «не импортируется».
    const customEntityMetaHref = String(
        packingAttr.customEntityMeta && packingAttr.customEntityMeta.href
            ? packingAttr.customEntityMeta.href
            : ''
    );
    if (!customEntityMetaHref) {
        const e = new Error('У атрибута «!!Тип УПАКОВКИ» нет customEntityMeta.href — это не customentity?');
        e.code = 'NOT_CUSTOM_ENTITY';
        throw e;
    }
    let entityListHref = '';
    // Иногда в метаданных уже есть готовый `entityMeta.href` — используем его без
    // лишнего запроса. Если нет, идём на customEntityMeta.href и забираем оттуда.
    if (packingAttr.customEntityMeta && packingAttr.customEntityMeta.entityMeta
        && packingAttr.customEntityMeta.entityMeta.href) {
        entityListHref = String(packingAttr.customEntityMeta.entityMeta.href);
    } else {
        const metaResp = await axios.get(customEntityMetaHref, { headers, timeout: 30000 });
        const em = metaResp && metaResp.data && metaResp.data.entityMeta;
        entityListHref = em && em.href ? String(em.href) : '';
        // Совместимость с возможным будущим поведением МС: если справочник вдруг
        // вернул `rows` прямо здесь, тоже принимаем (но в текущем API этого не
        // бывает — там только описание справочника).
        if (!entityListHref && metaResp && metaResp.data && Array.isArray(metaResp.data.rows)) {
            const directRows = metaResp.data.rows
                .map((r) => ({
                    id: r && r.id ? String(r.id) : '',
                    name: r && r.name ? String(r.name).trim() : '',
                    href: r && r.meta && r.meta.href ? String(r.meta.href) : '',
                }))
                .filter((r) => r.name);
            packingTypesCache = { ts: now, rows: directRows, source_url: customEntityMetaHref };
            return packingTypesCache;
        }
    }
    if (!entityListHref) {
        const e = new Error('У customentity «!!Тип УПАКОВКИ» нет entityMeta.href — нечего импортировать');
        e.code = 'NO_ENTITY_HREF';
        throw e;
    }
    const url = entityListHref + (entityListHref.indexOf('?') >= 0 ? '&' : '?') + 'limit=1000';
    const resp = await axios.get(url, { headers, timeout: 30000 });
    const rows = resp && resp.data && Array.isArray(resp.data.rows) ? resp.data.rows : [];
    const out = rows
        .map((r) => ({
            id: r && r.id ? String(r.id) : '',
            name: r && r.name ? String(r.name).trim() : '',
            href: r && r.meta && r.meta.href ? String(r.meta.href) : '',
        }))
        .filter((r) => r.name);
    packingTypesCache = { ts: now, rows: out, source_url: entityListHref };
    return packingTypesCache;
}

function findPackingTypeItem(name) {
    if (!name) return null;
    const needle = String(name).trim().toLowerCase();
    for (const r of packingTypesCache.rows) {
        if (String(r.name).trim().toLowerCase() === needle) return r;
    }
    return null;
}

/**
 * Сформировать тело PUT для MoySklad из `measurement` (только реально заданные поля).
 *   • Если атрибут не найден в metadata → `skipped[].reason='attribute_not_found'`.
 *   • customentity-атрибуты (например, packing_type) → `reason='customentity_skipped'`.
 *   • value приводится к числу для `double`/`long`, к строке — для `string`/`text`.
 *   • null/undefined значения пропускаются (на текущий момент не очищаем атрибут в МС
 *     через sync — это потенциально деструктивно; пользователь может сделать это в МС
 *     или мы добавим отдельную кнопку «Очистить в МС» позже).
 */
function buildMsAttributesPayload(measurement, attrsMeta) {
    const attrsByName = Object.create(null);
    for (const row of attrsMeta) {
        if (row && row.name) attrsByName[String(row.name)] = row;
    }
    const attrs = [];
    const skipped = [];
    const sentFields = [];
    for (const [field, attrName] of Object.entries(FIELD_TO_MS_ATTR)) {
        if (!Object.prototype.hasOwnProperty.call(measurement || {}, field)) continue;
        const rawVal = measurement[field];
        if (rawVal == null) continue;
        const metaRow = attrsByName[attrName];
        if (!metaRow) {
            skipped.push({ field, attr: attrName, reason: 'attribute_not_found_in_ms' });
            continue;
        }
        const msType = String(metaRow.type || '').toLowerCase();
        let value;
        if (msType === 'customentity') {
            /** Поиск элемента справочника по имени. Кэш загружается заранее в
             *  pushMeasurementToMs(), но если он пуст — пропускаем поле. */
            const name = String(rawVal).trim();
            if (!name) continue;
            const dictItem = findPackingTypeItem(name);
            if (!dictItem || !dictItem.href) {
                skipped.push({ field, attr: attrName, reason: 'customentity_value_not_in_dict', value: name });
                continue;
            }
            value = {
                meta: { href: dictItem.href, type: 'customentity', mediaType: 'application/json' },
                name: dictItem.name,
            };
        } else if (msType === 'double' || msType === 'long' || msType === 'int' || msType === 'integer') {
            const n = Number(String(rawVal).replace(',', '.'));
            if (!Number.isFinite(n)) {
                skipped.push({ field, attr: attrName, reason: 'invalid_number' });
                continue;
            }
            value = n;
        } else if (msType === 'boolean') {
            value = Boolean(rawVal);
        } else {
            value = String(rawVal);
        }
        /** Формат, который MS API ожидает в PUT: meta (href) + value. */
        const href = String(metaRow.meta && metaRow.meta.href ? metaRow.meta.href : '').trim();
        const meta = href
            ? { href, type: 'attributemetadata', mediaType: 'application/json' }
            : { type: 'attributemetadata', mediaType: 'application/json' };
        const attr = { meta, value };
        if (metaRow.id) attr.id = String(metaRow.id);
        attrs.push(attr);
        sentFields.push(field);
    }
    return { attrs, skipped, sentFields };
}

async function pushMeasurementToMs(uuid, type, measurement) {
    const token = getMsToken();
    if (!token) {
        const e = new Error('MS_TOKEN не задан (env MS_TOKEN или config.msToken)');
        e.code = 'NO_TOKEN';
        throw e;
    }
    if (!uuid) {
        const e = new Error('У позиции нет uuid (не было синхронизации с МС)');
        e.code = 'NO_UUID';
        throw e;
    }
    const headers = {
        Authorization: 'Bearer ' + token,
        'Content-Type': 'application/json',
        Accept: 'application/json;charset=utf-8',
    };
    const entityKind = detectEntityKind(type);
    let attrsMeta;
    try {
        attrsMeta = await fetchMsAttributesMeta(entityKind, headers);
    } catch (e) {
        /** Любая ошибка получения метаданных атрибутов МС (404, 401, network…)
         *  превращается в нормальный отказ синка с понятным текстом, а не
         *  голым axios-сообщением "Request failed with status code …". */
        const httpStatus = e && e.response && e.response.status ? Number(e.response.status) : 0;
        return {
            ok: false,
            entity_kind: entityKind,
            sent_fields: [],
            skipped: [],
            error: 'MS API ' + (httpStatus || 'NETWORK') + ' (метаданные атрибутов): ' +
                (e && e.message ? e.message : 'unknown'),
            http_status: httpStatus,
        };
    }
    /** Если в measurement есть packing_type — подгружаем справочник МС для поиска href. */
    if (measurement && measurement.packing_type != null && String(measurement.packing_type).trim() !== '') {
        try {
            await fetchPackingTypesFromMs(false);
        } catch (e) {
            /** Не валим весь sync, packing_type попадёт в skipped. */
        }
    }
    const { attrs, skipped, sentFields } = buildMsAttributesPayload(measurement || {}, attrsMeta);
    if (attrs.length === 0) {
        return {
            ok: false,
            error: 'Нет полей для отправки в МС (пустой override или все атрибуты пропущены)',
            entity_kind: entityKind,
            skipped,
            sent_fields: [],
        };
    }
    const url = MS_BASE_URL + '/entity/' + entityKind + '/' + encodeURIComponent(uuid);
    try {
        const resp = await axios.put(url, { attributes: attrs }, { headers, timeout: 30000 });
        return {
            ok: true,
            entity_kind: entityKind,
            sent_fields: sentFields,
            skipped,
            ms_updated_at: (resp && resp.data && resp.data.updated) ? String(resp.data.updated) : null,
            ms_status: resp && resp.status ? Number(resp.status) : 200,
        };
    } catch (e) {
        const httpStatus = e && e.response && e.response.status ? Number(e.response.status) : 0;
        const errBody = e && e.response && e.response.data;
        let msErr = '';
        if (errBody && Array.isArray(errBody.errors) && errBody.errors[0]) {
            msErr = String(errBody.errors[0].error || errBody.errors[0].message || '');
        } else if (typeof errBody === 'string') {
            msErr = errBody;
        }
        return {
            ok: false,
            entity_kind: entityKind,
            sent_fields: sentFields,
            skipped,
            error: 'MS API ' + (httpStatus || 'NETWORK') + ': ' + (msErr || e.message || 'unknown'),
            http_status: httpStatus,
        };
    }
}

/**
 * Внутренний синк одной позиции (`code`) в МС.
 *
 * Извлечён из обработчика `POST /sync-ms` — единая точка для:
 *   • route-обработчика (с inline-`measurement` от UI и аутентифицированным актором);
 *   • планируемого балк-синка `runScheduledSyncMs()` (без inline, актор=`Авто-синхронизация (расписание)`).
 *
 * Алгоритм совпадает с прежним route-handler'ом:
 *   1) опционально persist'им inline `measurement` (если передан в opts);
 *   2) читаем актуальный snapshot из БД (`ms_export` + `ms_dimensions_measurements`);
 *   3) auto-fill parsed-defaults из `packing_type` (см. parsePackingDims) и persist'им их;
 *   4) формируем payload через buildMsAttributesPayload + pushMeasurementToMs;
 *   5) на успех пишем по строке в `ms_dimensions_log` за каждое отправленное поле.
 *
 * Возвращает плоский объект (как старый route), чтобы вызывающие могли его сериализовать
 * в HTTP-ответ или агрегировать счётчики прогресса.
 */
async function syncCodeToMs(db, code, options) {
    const opts = options || {};
    const cleanCode = String(code || '').trim();
    if (!cleanCode) {
        return { success: false, code: cleanCode, error: 'Не указан code', http_code: 400 };
    }
    const actorId = opts.actorId != null ? Number(opts.actorId) : null;
    const actorName = opts.actorName != null ? String(opts.actorName) : null;
    const inlineMeasurement = opts.measurement && typeof opts.measurement === 'object' ? opts.measurement : null;
    const persistNoteSuffix = opts.persistNoteSuffix
        ? String(opts.persistNoteSuffix).slice(0, 200)
        : '';

    let persistedFields = [];
    if (inlineMeasurement) {
        const incoming = {};
        for (const k of Object.keys(MEASUREMENT_FIELDS)) {
            if (Object.prototype.hasOwnProperty.call(inlineMeasurement, k)) {
                incoming[k] = inlineMeasurement[k];
            }
        }
        if (Object.keys(incoming).length > 0) {
            const persisted = await persistMeasurementFields(db, {
                code: cleanCode,
                incoming,
                measuredByName: actorName,
                measuredByUserId: actorId,
                measuredAt: new Date(),
                note: 'sync_ms (auto-persist before push)' + (persistNoteSuffix ? ' ' + persistNoteSuffix : ''),
            });
            persistedFields = (persisted.changedFields || []).map((c) => c.field);
        }
    }

    const [rows] = await db.query(
        `SELECT mse.uuid AS uuid, mse.type AS type, mse.name AS name,
                mdm.length_cm, mdm.width_cm, mdm.height_box_cm, mdm.height_bag_cm,
                mdm.weight_kg, mdm.packing_type
         FROM ms_export mse
         LEFT JOIN ms_dimensions_measurements mdm ON mdm.code = mse.code
         WHERE mse.code = ?
         LIMIT 1`,
        [cleanCode],
    );
    const r = (Array.isArray(rows) && rows[0]) || null;
    if (!r) {
        return {
            success: false,
            code: cleanCode,
            error: 'Позиция не найдена в ms_export',
            http_code: 404,
            persisted_fields: persistedFields,
        };
    }

    const uuid = String(r.uuid || '').trim();
    const type = String(r.type || '').trim();
    const fullMeasurement = rowToMeasurement({
        length_cm: r.length_cm,
        width_cm: r.width_cm,
        height_box_cm: r.height_box_cm,
        height_bag_cm: r.height_bag_cm,
        weight_kg: r.weight_kg,
        packing_type: r.packing_type,
    }) || {};

    const parsedDefaults = parsePackingDims(fullMeasurement.packing_type);
    const parsedAutofillKeys = ['length_cm', 'width_cm', 'height_box_cm'];
    const parsedToPersist = {};
    for (const k of parsedAutofillKeys) {
        if (fullMeasurement[k] == null && parsedDefaults && parsedDefaults[k] != null) {
            fullMeasurement[k] = parsedDefaults[k];
            parsedToPersist[k] = parsedDefaults[k];
        }
    }
    if (Object.keys(parsedToPersist).length > 0) {
        try {
            const parsedPersisted = await persistMeasurementFields(db, {
                code: cleanCode,
                incoming: parsedToPersist,
                measuredByName: actorName,
                measuredByUserId: actorId,
                measuredAt: new Date(),
                note: 'sync_ms (auto-persist parsed)' + (persistNoteSuffix ? ' ' + persistNoteSuffix : ''),
            });
            for (const c of (parsedPersisted.changedFields || [])) {
                if (persistedFields.indexOf(c.field) < 0) persistedFields.push(c.field);
            }
        } catch (_) {
            /** не валим синк, в МС всё равно отправим parsed-default */
        }
    }

    let measurement = fullMeasurement;
    if (Array.isArray(opts.fields) && opts.fields.length > 0) {
        measurement = {};
        for (const k of opts.fields) {
            if (Object.prototype.hasOwnProperty.call(fullMeasurement, k)) {
                measurement[k] = fullMeasurement[k];
            }
        }
    }

    let result;
    try {
        result = await pushMeasurementToMs(uuid, type, measurement);
    } catch (e) {
        return {
            success: false,
            code: cleanCode,
            uuid,
            type,
            error: e && e.message ? e.message : 'Ошибка отправки в МС',
            code_error: e && e.code ? String(e.code) : 'PUSH_FAILED',
            http_code: 503,
            persisted_fields: persistedFields,
        };
    }

    if (result.ok && Array.isArray(result.sent_fields) && result.sent_fields.length > 0) {
        const note = 'sync_ms entity=' + result.entity_kind + ' http=' + (result.ms_status || 200)
            + (persistNoteSuffix ? ' ' + persistNoteSuffix : '');
        for (const f of result.sent_fields) {
            const v = measurement[f];
            await db.query(
                `INSERT INTO ms_dimensions_log
                    (code, field, old_value, new_value, action, changed_by_user_id, changed_by_name, note)
                 VALUES (?, ?, NULL, ?, 'sync_ms', ?, ?, ?)`,
                [cleanCode, f, v != null ? String(v) : null, actorId, actorName, note],
            );
        }
    } else if (!result.ok) {
        /** Одна строка на неуспешный push в МС — для «Процессы» и `ms_dimensions_log`. */
        const errLine = String(result.error || 'Не удалось обновить позицию в МС').replace(/\s+/g, ' ').trim();
        let note =
            'entity=' + (result.entity_kind || '?') +
            ' http=' + (result.http_status != null ? String(result.http_status) : '—') +
            ': ' + errLine +
            (persistNoteSuffix ? ' ' + persistNoteSuffix : '');
        if (note.length > 500) note = note.slice(0, 497) + '…';
        try {
            await db.query(
                `INSERT INTO ms_dimensions_log
                    (code, field, old_value, new_value, action, changed_by_user_id, changed_by_name, note)
                 VALUES (?, 'ms_push', NULL, NULL, 'sync_ms_error', ?, ?, ?)`,
                [cleanCode, actorId, actorName, note],
            );
        } catch (_) {
            /** не блокируем ответ при сбое журнала */
        }
    }

    return {
        success: !!result.ok,
        code: cleanCode,
        uuid,
        type,
        entity_kind: result.entity_kind,
        sent_fields: result.sent_fields || [],
        skipped: result.skipped || [],
        persisted_fields: persistedFields,
        error: result.ok ? undefined : (result.error || 'Не удалось обновить позицию в МС'),
        http_status: result.http_status || null,
        ms_updated_at: result.ms_updated_at || null,
    };
}

/* ============================ Scheduled bulk sync ============================ */

/**
 * In-memory state балк-синка по расписанию (или ручного запуска через
 * `/api/settings/auto-sync-run` task=`dimensions`). Один экземпляр на процесс —
 * идёт строго последовательно, повторный запуск возвращает `started=false`
 * с `reason='already_running'` (паритет с huckster/marketplaces).
 *
 * Содержимое потребляется server.js (`processAutoSyncQueue`) для выставления
 * honest-статуса в `auto_sync_runs` и фронтом /processes.html для показа
 * прогресса. Поля прозрачные: `processed/total/ok/err/skipped_no_uuid` +
 * краткий `last_message` с именем последней позиции.
 */
const dimensionsScheduledState = {
    active: false,
    started_at: null,
    finished_at: null,
    total: 0,
    processed: 0,
    ok: 0,
    err: 0,
    skipped_no_uuid: 0,
    last_code: '',
    last_name: '',
    last_status: '',
    last_message: '',
    error: null,
    summary: null,
};

function snapshotScheduledState() {
    return {
        active: dimensionsScheduledState.active,
        started_at: dimensionsScheduledState.started_at,
        finished_at: dimensionsScheduledState.finished_at,
        total: dimensionsScheduledState.total,
        processed: dimensionsScheduledState.processed,
        ok: dimensionsScheduledState.ok,
        err: dimensionsScheduledState.err,
        skipped_no_uuid: dimensionsScheduledState.skipped_no_uuid,
        last_code: dimensionsScheduledState.last_code,
        last_name: dimensionsScheduledState.last_name,
        last_status: dimensionsScheduledState.last_status,
        last_message: dimensionsScheduledState.last_message,
        error: dimensionsScheduledState.error,
        summary: dimensionsScheduledState.summary,
    };
}

/**
 * Запустить балк-синк всех `ms_dimensions_measurements` с override → МС.
 * Возвращает Promise, который резолвится после завершения (включая `error`-кейсы).
 * Параметры:
 *   • `db` — пул mysql2/promise;
 *   • `triggerType` — для `note` в логе и `summary` (`'schedule' | 'manual'`).
 *
 * Поведение:
 *   1) Сбрасываем state (active=true), читаем все коды с override и uuid.
 *   2) Для каждого вызываем `syncCodeToMs(db, code, { actorName, persistNoteSuffix })`.
 *   3) После каждой позиции обновляем state.* (ok/err/skipped_no_uuid/last_*).
 *   4) Между запросами 60ms задержка — паритет с UI bulk runner (не «душим» MS API).
 *   5) В конце ставим `active=false`, формируем `summary`.
 *
 * Опционально `hooks.onRunMessage(msg)` — обновить текст в `auto_sync_runs.message`
 * (см. `server.js` / «Процессы»), чтобы не зависать на «Запуск задачи» на всём длинном балке.
 */
async function runScheduledDimensionsSyncMs(db, triggerType, hooks) {
    const hookMsg =
        hooks && typeof hooks.onRunMessage === 'function'
            ? async (msg) => {
                  try {
                      await hooks.onRunMessage(String(msg || '').slice(0, 2000));
                  } catch (_) {}
              }
            : null;

    if (dimensionsScheduledState.active) {
        return { started: false, reason: 'already_running' };
    }
    dimensionsScheduledState.active = true;
    dimensionsScheduledState.started_at = new Date();
    dimensionsScheduledState.finished_at = null;
    dimensionsScheduledState.total = 0;
    dimensionsScheduledState.processed = 0;
    dimensionsScheduledState.ok = 0;
    dimensionsScheduledState.err = 0;
    dimensionsScheduledState.skipped_no_uuid = 0;
    dimensionsScheduledState.last_code = '';
    dimensionsScheduledState.last_name = '';
    dimensionsScheduledState.last_status = '';
    dimensionsScheduledState.last_message = '';
    dimensionsScheduledState.error = null;
    dimensionsScheduledState.summary = null;

    const trigger = String(triggerType || 'schedule').trim() || 'schedule';
    const actorName = trigger === 'schedule'
        ? 'Авто-синхронизация (расписание)'
        : 'Авто-синхронизация (вручную)';
    const persistNoteSuffix = '(' + trigger + ')';

    try {
        await ensureSchema(db);
        const [rows] = await db.query(
            `SELECT mdm.code, mse.uuid, mse.name, mse.type
             FROM ms_dimensions_measurements mdm
             LEFT JOIN ms_export mse ON mse.code = mdm.code
             WHERE (
                 mdm.length_cm IS NOT NULL OR
                 mdm.width_cm IS NOT NULL OR
                 mdm.height_box_cm IS NOT NULL OR
                 mdm.height_bag_cm IS NOT NULL OR
                 mdm.weight_kg IS NOT NULL OR
                 (mdm.packing_type IS NOT NULL AND mdm.packing_type <> '')
             )
             ORDER BY mdm.measured_at DESC, mdm.code ASC`,
        );
        const tasks = (Array.isArray(rows) ? rows : []).map((r) => ({
            code: String(r.code || ''),
            uuid: r.uuid ? String(r.uuid).trim() : '',
            name: r.name != null ? String(r.name) : '',
            type: r.type != null ? String(r.type) : '',
        })).filter((t) => t.code);
        dimensionsScheduledState.total = tasks.length;

        if (hookMsg) {
            await hookMsg(
                'Габариты МС: старт; позиций ' +
                    tasks.length +
                    (tasks.length ? ' (обновление этой строки каждые 5 позиций + 60 мс пауза к МС)' : '')
            );
        }

        for (let i = 0; i < tasks.length; i++) {
            const t = tasks[i];
            dimensionsScheduledState.last_code = t.code;
            dimensionsScheduledState.last_name = t.name;
            if (!t.uuid) {
                dimensionsScheduledState.skipped_no_uuid++;
                dimensionsScheduledState.processed++;
                dimensionsScheduledState.last_status = 'skip_no_uuid';
                dimensionsScheduledState.last_message =
                    'Пропуск: нет uuid в ms_export (позиция удалена/не синкается из МС)';
            } else {
                try {
                    const r = await syncCodeToMs(db, t.code, {
                        actorId: null,
                        actorName,
                        persistNoteSuffix,
                    });
                    if (r && r.success) {
                        dimensionsScheduledState.ok++;
                        dimensionsScheduledState.last_status = 'ok';
                        const sent = (r.sent_fields || []).join(', ') || '—';
                        dimensionsScheduledState.last_message = '✓ В МС: ' + sent;
                    } else {
                        dimensionsScheduledState.err++;
                        dimensionsScheduledState.last_status = 'err';
                        dimensionsScheduledState.last_message = (r && r.error) || 'Не удалось обновить позицию в МС';
                    }
                } catch (e) {
                    dimensionsScheduledState.err++;
                    dimensionsScheduledState.last_status = 'err';
                    dimensionsScheduledState.last_message = (e && e.message) || String(e);
                }
                dimensionsScheduledState.processed++;
                await new Promise((resolve) => setTimeout(resolve, 60));
            }

            if (i % 10 === 9) {
                await new Promise((resolve) => setImmediate(resolve));
            }
            if (
                hookMsg &&
                (i % 5 === 4 || i === tasks.length - 1 || dimensionsScheduledState.total === 0)
            ) {
                await hookMsg(
                    'Габариты МС: ' +
                        dimensionsScheduledState.processed +
                        '/' +
                        dimensionsScheduledState.total +
                        '; ✓ ' +
                        dimensionsScheduledState.ok +
                        '; × ' +
                        dimensionsScheduledState.err +
                        '; без uuid: ' +
                        dimensionsScheduledState.skipped_no_uuid +
                        (dimensionsScheduledState.last_code
                            ? ' · последний код: ' + dimensionsScheduledState.last_code
                            : '')
                );
            }
        }

        dimensionsScheduledState.summary =
            'Всего: ' + dimensionsScheduledState.total +
            '; ✓ ' + dimensionsScheduledState.ok +
            '; × ' + dimensionsScheduledState.err +
            '; пропущено (без uuid): ' + dimensionsScheduledState.skipped_no_uuid;
        return {
            started: true,
            ...snapshotScheduledState(),
        };
    } catch (e) {
        dimensionsScheduledState.error = e && e.message ? e.message : String(e);
        dimensionsScheduledState.summary =
            'Ошибка: ' + dimensionsScheduledState.error +
            ' (обработано ' + dimensionsScheduledState.processed +
            ' из ' + dimensionsScheduledState.total + ')';
        return { started: true, error: dimensionsScheduledState.error, ...snapshotScheduledState() };
    } finally {
        dimensionsScheduledState.active = false;
        dimensionsScheduledState.finished_at = new Date();
    }
}

function createDimensionsRouter(db, appSettings = {}) {
    const router = express.Router();
    ensureSchema(db).catch((e) => {
        console.error('[dimensions] ensureSchema:', e && e.message);
    });

    router.get('/list', async (req, res) => {
        try {
            await ensureSchema(db);
            const limit = clampInt(req.query.limit, 1, MAX_LIMIT, DEFAULT_LIMIT);
            const offset = clampInt(req.query.offset, 0, 1_000_000, 0);
            const orderBy = resolveSort(req.query);
            const sortBy = String(req.query.sort_by || 'code');
            const sortDir = String(req.query.sort_dir || 'asc');

            const problemProfile = normalizeProblemProfileFromQuery(req.query);
            const mpScope = problemProfile ? 'all' : normalizeMpScopeFromQuery(req.query);
            const useMpJoins = Boolean(!problemProfile && mpScope !== 'all');
            const postFilter = Boolean(!problemProfile && MP_SCOPE_POST.has(mpScope));
            const problemStock = problemProfile === 'stock_missing';

            const { whereSql, params } = buildWhereClauseFromQuery(req.query);
            let extraStockWhere = '';
            const extraParams = [];
            if (problemStock) {
                extraStockWhere = ' AND COALESCE(mse.stock, 0) > 0';
            }

            const fromCore = `
                FROM ms_export mse
                LEFT JOIN ms_dimensions_measurements mdm ON mdm.code = mse.code
                LEFT JOIN ms_entity_details med ON med.uuid = mse.uuid`;

            const selectNarrow = `SELECT
                    mse.code AS code,
                    mse.name AS name,
                    mse.type AS type,
                    mse.uuid AS uuid,
                    mse.stock AS stock,
                    mse.vat AS ms_vat,
                    mse.manager AS manager,
                    mse.content_manager AS content_manager,
                    DATE_FORMAT(mse.synced_at, '%d.%m.%Y %H:%i') AS synced_at,
                    COALESCE(mse.is_archived, 0) AS is_archived,
                    mdm.measured_by_user_id AS measured_by_user_id,
                    mdm.measured_by_name AS measured_by_name,
                    mdm.measured_at AS measured_at,
                    mdm.length_cm AS m_length_cm,
                    mdm.width_cm AS m_width_cm,
                    mdm.height_box_cm AS m_height_box_cm,
                    mdm.height_bag_cm AS m_height_bag_cm,
                    mdm.weight_kg AS m_weight_kg,
                    mdm.packing_type AS m_packing_type,
                    med.payload_json AS payload_json`;

            const selectWideDims = `,
                    mdm.length_cm AS ms_length,
                    mdm.width_cm AS ms_width,
                    mdm.height_box_cm AS ms_height_box,
                    mdm.height_bag_cm AS ms_height_bag,
                    mdm.weight_kg AS ms_weight`;

            const selectMp = `,
                    dg_dim_ozon.external_id AS ozon_code,
                    dg_dim_ozon.name AS ozon_name,
                    dg_dim_ozon.vat AS ozon_vat,
                    dg_dim_ozon.stock AS ozon_stock,
                    dg_dim_ozon.length_cm AS ozon_length,
                    dg_dim_ozon.width_cm AS ozon_width,
                    dg_dim_ozon.height_cm AS ozon_height,
                    dg_dim_ozon.weight_kg AS ozon_weight,
                    dg_dim_wb.external_id AS wb_code,
                    dg_dim_wb.name AS wb_name,
                    dg_dim_wb.vat AS wb_vat,
                    dg_dim_wb.stock AS wb_stock,
                    dg_dim_wb.length_cm AS wb_length,
                    dg_dim_wb.width_cm AS wb_width,
                    dg_dim_wb.height_cm AS wb_height,
                    dg_dim_wb.weight_kg AS wb_weight,
                    dg_dim_ym.external_id AS ym_code,
                    dg_dim_ym.name AS ym_name,
                    dg_dim_ym.vat AS ym_vat,
                    dg_dim_ym.stock AS ym_stock,
                    dg_dim_ym.length_cm AS ym_length,
                    dg_dim_ym.width_cm AS ym_width,
                    dg_dim_ym.height_cm AS ym_height,
                    dg_dim_ym.weight_kg AS ym_weight`;

            const joinMpList = useMpJoins || postFilter;
            const fromSql = joinMpList ? `${fromCore}${MP_JOIN_SQL}` : fromCore;
            const mpWhere = useMpJoins && !postFilter ? sqlWhereMpScope(mpScope) : '';
            const whereFull = `${whereSql}${extraStockWhere}${mpWhere}`;
            const baseParams = params.concat(extraParams);

            /** Пагинация в SQL (без пост-фильтрации в Node). */
            if (!postFilter && !problemStock) {
                const [countRows] = await db.query(`SELECT COUNT(*) AS total ${fromSql} ${whereFull}`, baseParams);
                const total = Number((countRows && countRows[0] && countRows[0].total) || 0);
                const selectSql =
                    (useMpJoins ? `${selectNarrow}${selectWideDims}${selectMp}` : selectNarrow) +
                    `\n                 ${fromSql}\n                 ${whereFull}\n                 ORDER BY ${orderBy}\n                 LIMIT ? OFFSET ?`;
                const [rows] = await db.query(selectSql, baseParams.concat([limit, offset]));
                const out = (rows || []).map((r) => mapDimensionListRow(r));
                return res.json({
                    success: true,
                    rows: out,
                    total,
                    limit,
                    offset,
                    sort_by: sortBy,
                    sort_dir: sortDir,
                    mp_scope: mpScope,
                    problem_profile: problemProfile || null,
                    post_filtered: false,
                    dimension_attrs: DIMENSION_ATTRS.map((d) => ({ key: d.key, label: d.label, attr: d.attr })),
                });
            }

            /** Пост-фильтр: vat_mismatch / dims_mismatch / «проблемные товары». */
            const fromForCap = postFilter ? `${fromCore}${MP_JOIN_SQL}` : fromCore;
            const selectForCap = postFilter ? `${selectNarrow}${selectWideDims}${selectMp}` : selectNarrow;
            const { rows: outOnly, truncated: postFilterMemoryTruncated } = await collectPostFilteredDimensionRowsChunked(
                db,
                selectForCap,
                fromForCap,
                whereFull,
                baseParams,
                { problemStock, postFilter, mpScope },
            );

            outOnly.sort((a, b) => compareDimensionOutRows(a, b, sortBy, sortDir));
            const total = outOnly.length;
            const pageRows = outOnly.slice(offset, offset + limit);

            return res.json({
                success: true,
                rows: pageRows,
                total,
                limit,
                offset,
                sort_by: sortBy,
                sort_dir: sortDir,
                mp_scope: mpScope,
                problem_profile: problemProfile || null,
                post_filtered: true,
                post_filter_cap: DIM_LIST_POST_FILTER_CAP,
                post_filter_match_cap: DIM_POST_FILTER_MAX_MATCHED,
                post_filter_truncated: postFilterMemoryTruncated,
                dimension_attrs: DIMENSION_ATTRS.map((d) => ({ key: d.key, label: d.label, attr: d.attr })),
            });
        } catch (e) {
            return res.status(500).json({ success: false, error: e.message || 'Ошибка загрузки списка' });
        }
    });

    /**
     * Записать/обновить замер по коду. Принимает любой подмножество полей в
     * `fields` (length_cm, width_cm, height_box_cm, height_bag_cm, weight_kg,
     * packing_type) либо одно поле через `field`+`value`.
     *
     * Логика:
     *   1. Считываем старое состояние строки `ms_dimensions_measurements`.
     *   2. Для каждого поля сравниваем нормализованное новое значение со старым.
     *   3. Если значение реально изменилось — пишем строку в `ms_dimensions_log`
     *      (`action='set'`, плюс `user_id`/`user_name`/`changed_at`).
     *   4. UPSERT-им строку в `ms_dimensions_measurements`, синхронно обновляя
     *      `measured_by_*` и `measured_at` под текущего пользователя.
     */
    router.post('/measure', async (req, res) => {
        try {
            await ensureSchema(db);
            const body = req.body || {};
            const code = String(body.code || '').trim();
            if (!code) return res.status(400).json({ success: false, error: 'Не указан code' });

            /** Собираем «raw → normalized» по каждому валидному ключу. */
            const provided = {};
            if (body.fields && typeof body.fields === 'object') {
                for (const k of Object.keys(MEASUREMENT_FIELDS)) {
                    if (Object.prototype.hasOwnProperty.call(body.fields, k)) {
                        provided[k] = body.fields[k];
                    }
                }
            }
            if (body.field && Object.prototype.hasOwnProperty.call(MEASUREMENT_FIELDS, String(body.field))) {
                provided[String(body.field)] = body.value;
            }
            if (Object.keys(provided).length === 0) {
                return res.status(400).json({ success: false, error: 'Нечего сохранять (нет полей)' });
            }

            const actor = req.datagonActor || null;
            const measuredByName = String(body.measured_by_name || actorDisplayName(actor) || '').trim() || null;
            const measuredByUserId = actor && actor.id != null ? Number(actor.id) : null;
            const measuredAt =
                body.measured_at && !Number.isNaN(new Date(body.measured_at).getTime())
                    ? new Date(body.measured_at)
                    : new Date();

            const result = await persistMeasurementFields(db, {
                code,
                incoming: provided,
                measuredByName,
                measuredByUserId,
                measuredAt,
                note: body.note,
            });

            return res.json({
                success: true,
                code,
                changed_fields: result.changedFields,
                measurement: result.measurement,
                measured_by_user_id: result.measured_by_user_id,
                measured_by_name: result.measured_by_name,
                measured_at: result.measured_at instanceof Date ? result.measured_at.toISOString() : null,
            });
        } catch (e) {
            return res.status(500).json({ success: false, error: e.message || 'Ошибка сохранения замера' });
        }
    });

    /**
     * Журнал изменений по конкретному товару/комплекту.
     * Параметры:
     *   - `code`   (обяз.) — код позиции.
     *   - `field`  (опц.)  — фильтр по конкретному полю (например, `length_cm`).
     *                       Используется для tooltip «3 последних правки» на ячейке.
     *   - `limit`  (опц.)  — размер страницы, дефолт 100, максимум 500.
     *   - `offset` (опц.)  — смещение для пагинации, дефолт 0.
     * Возвращает `{ success, code, rows[], total, limit, offset }` — total нужен
     * UI-модалке для рендера «страница X/Y».
     */
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
            const whereSql = 'WHERE ' + where.join(' AND ');
            const [totRows] = await db.query(
                'SELECT COUNT(*) AS total FROM ms_dimensions_log ' + whereSql,
                params,
            );
            const total = Number((totRows && totRows[0] && totRows[0].total) || 0);
            const [rows] = await db.query(
                `SELECT id, code, field, old_value, new_value, action,
                        changed_by_user_id, changed_by_name, note, changed_at
                 FROM ms_dimensions_log ` + whereSql + `
                 ORDER BY id DESC
                 LIMIT ? OFFSET ?`,
                [...params, limit, offset],
            );
            const out = (rows || []).map((r) => ({
                id: Number(r.id),
                code: String(r.code || ''),
                field: String(r.field || ''),
                field_label: MEASUREMENT_FIELDS[r.field] ? MEASUREMENT_FIELDS[r.field].label : String(r.field || ''),
                old_value: r.old_value != null ? String(r.old_value) : null,
                new_value: r.new_value != null ? String(r.new_value) : null,
                action: String(r.action || 'set'),
                changed_by_user_id: r.changed_by_user_id != null ? Number(r.changed_by_user_id) : null,
                changed_by_name: r.changed_by_name != null ? String(r.changed_by_name) : '',
                note: r.note != null ? String(r.note) : '',
                changed_at: r.changed_at ? new Date(r.changed_at).toISOString() : '',
            }));
            return res.json({ success: true, code, rows: out, total, limit, offset });
        } catch (e) {
            return res.status(500).json({ success: false, error: e.message || 'Ошибка чтения журнала' });
        }
    });

    /**
     * Утилитарный endpoint: вернуть результат парсинга «Тип упаковки» без сохранения.
     * UI может вызвать его для немедленного auto-fill при ручном переключении packing_type.
     */
    router.get('/parse-packing', (req, res) => {
        const text = String(req.query.text || '');
        return res.json({ success: true, parsed: parsePackingDims(text) });
    });

    /**
     * Отправить пользовательский замер (override-значения из `ms_dimensions_measurements`)
     * обратно в МойСклад через PUT на сущность (product/bundle) по uuid из `ms_export`.
     *
     * Принимает `{ code }` или `{ code, fields: [length_cm, ...] }` чтобы синкнуть подмножество.
     * Если `fields` не задан — синкаем все непустые поля override.
     * Каждое успешно отправленное поле логируется отдельной строкой в `ms_dimensions_log`
     * с `action='sync_ms'` (note содержит entity_kind/http_status для отладки).
     */
    router.post('/sync-ms', async (req, res) => {
        try {
            await ensureSchema(db);
            const body = req.body || {};
            const code = String(body.code || '').trim();
            if (!code) return res.status(400).json({ success: false, error: 'Не указан code' });

            /**
             * Все ветки логики (inline-persist, parsed-defaults, push, log) вынесены
             * в общую функцию syncCodeToMs() — она же используется планировщиком
             * `runScheduledDimensionsSyncMs` для авто-выгрузки в 21:00 МСК.
             */
            const actor = req.datagonActor || null;
            const actorId = actor && actor.id != null ? Number(actor.id) : null;
            const actorName = actorDisplayName(actor) || null;
            const r = await syncCodeToMs(db, code, {
                actorId,
                actorName,
                measurement: (body && typeof body.measurement === 'object') ? body.measurement : null,
                fields: Array.isArray(body.fields) ? body.fields : null,
            });
            if (r.http_code && r.http_code >= 400) {
                return res.status(r.http_code).json(r);
            }
            return res.json(r);
        } catch (e) {
            return res.status(500).json({ success: false, error: e.message || 'Ошибка синхронизации с МС' });
        }
    });

    /**
     * Статистика таблицы `ms_dimensions_log` (UI: «Журнал изменений габаритов» на /settings.html):
     *  total — всего строк, oldest_at — дата самой старой записи (для отображения
     *  «накопилось за …»), newest_at — самая свежая, by_action — разбивка по
     *  действиям (set/sync_ms/delete), older_than_retention — сколько строк будет
     *  удалено при следующей автоочистке (или при ручной).
     */
    router.get('/log/stats', async (req, res) => {
        try {
            await ensureSchema(db);
            const retention = Number(appSettings.ms_dimensions_log_retention_days || 180);
            const [totRows] = await db.query(
                `SELECT COUNT(*) AS total,
                        MIN(changed_at) AS oldest_at,
                        MAX(changed_at) AS newest_at
                 FROM ms_dimensions_log`,
            );
            const tot = (totRows && totRows[0]) || {};
            const [actRows] = await db.query(
                `SELECT action, COUNT(*) AS n FROM ms_dimensions_log GROUP BY action`,
            );
            const byAction = {};
            (actRows || []).forEach((r) => {
                byAction[String(r.action || 'set')] = Number(r.n || 0);
            });
            let olderThanRetention = 0;
            if (retention > 0) {
                const [oldRows] = await db.query(
                    `SELECT COUNT(*) AS n FROM ms_dimensions_log
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
                by_action: byAction,
                retention_days: retention,
                older_than_retention: olderThanRetention,
            });
        } catch (e) {
            return res.status(500).json({
                success: false,
                error: e && e.message ? e.message : 'Не удалось получить статистику журнала',
            });
        }
    });

    /**
     * Ручная очистка журнала `ms_dimensions_log` старше N дней. Без параметров
     * использует `app_settings.ms_dimensions_log_retention_days`. Если в body
     * передано `days` — берёт его. Возвращает число удалённых строк.
     */
    router.post('/log/cleanup', async (req, res) => {
        try {
            await ensureSchema(db);
            const body = req.body || {};
            const reqDays = body.days != null ? Number(body.days) : null;
            const defaultDays = Number(appSettings.ms_dimensions_log_retention_days || 180);
            const days = Number.isFinite(reqDays) && reqDays > 0 ? Math.floor(reqDays) : defaultDays;
            if (days <= 0) {
                return res.status(400).json({ success: false, error: 'Некорректный retention (days <= 0)' });
            }
            const [r] = await db.query(
                `DELETE FROM ms_dimensions_log WHERE changed_at < (NOW() - INTERVAL ? DAY)`,
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
                error: e && e.message ? e.message : 'Не удалось очистить журнал',
            });
        }
    });

    /**
     * Список всех позиций с user-override в `ms_dimensions_measurements` —
     * для балк-синка «↗ В МС: все правки (все страницы)». Возвращает голый
     * список `code` + минимум полей для прогресс-UI; реальные значения берёт
     * `/sync-ms` уже из БД, без inline `measurement`. По умолчанию
     * сортировка по `measured_at DESC` (свежие правки первыми).
     *
     * Параметры:
     *  - `exclude` (опц., CSV string) — коды, которые исключить из списка
     *    (UI передаёт сюда коды текущей страницы, чтобы балк ушёл только по
     *    «остальным», а текущую страницу обработать с DOM-правками).
     */
    router.get('/pending-sync', async (req, res) => {
        try {
            await ensureSchema(db);
            const excludeRaw = String(req.query.exclude || '').trim();
            const excludeSet = excludeRaw
                ? excludeRaw
                      .split(',')
                      .map((s) => String(s || '').trim())
                      .filter(Boolean)
                : [];
            const params = [];
            let excludeSql = '';
            if (excludeSet.length > 0) {
                const placeholders = excludeSet.map(() => '?').join(', ');
                excludeSql = ' AND mdm.code NOT IN (' + placeholders + ')';
                excludeSet.forEach((c) => params.push(c));
            }
            const [rows] = await db.query(
                `SELECT mdm.code,
                        mse.uuid, mse.type, mse.name,
                        mdm.length_cm, mdm.width_cm, mdm.height_box_cm, mdm.height_bag_cm,
                        mdm.weight_kg, mdm.packing_type,
                        mdm.measured_by_name, mdm.measured_at
                 FROM ms_dimensions_measurements mdm
                 LEFT JOIN ms_export mse ON mse.code = mdm.code
                 WHERE (
                     mdm.length_cm IS NOT NULL OR
                     mdm.width_cm IS NOT NULL OR
                     mdm.height_box_cm IS NOT NULL OR
                     mdm.height_bag_cm IS NOT NULL OR
                     mdm.weight_kg IS NOT NULL OR
                     (mdm.packing_type IS NOT NULL AND mdm.packing_type <> '')
                 )` + excludeSql + `
                 ORDER BY mdm.measured_at DESC, mdm.code ASC`,
                params,
            );
            const out = (rows || []).map((r) => ({
                code: String(r.code || ''),
                name: r.name ? String(r.name) : '',
                type: r.type ? String(r.type) : '',
                has_uuid: !!(r.uuid && String(r.uuid).trim()),
                measured_by_name: r.measured_by_name ? String(r.measured_by_name) : '',
                measured_at: r.measured_at ? new Date(r.measured_at).toISOString() : null,
                /** Краткий «отпечаток» какие поля имеют override — UI может фильтровать. */
                fields: {
                    length_cm: r.length_cm != null,
                    width_cm: r.width_cm != null,
                    height_box_cm: r.height_box_cm != null,
                    height_bag_cm: r.height_bag_cm != null,
                    weight_kg: r.weight_kg != null,
                    packing_type: r.packing_type != null && String(r.packing_type).trim() !== '',
                },
            }));
            return res.json({
                success: true,
                rows: out,
                total: out.length,
                excluded: excludeSet.length,
            });
        } catch (e) {
            return res.status(500).json({
                success: false,
                error: e && e.message ? e.message : 'Ошибка получения списка позиций с правками',
            });
        }
    });

    /**
     * Импорт справочника «Тип упаковки» (customentity «!!Тип УПАКОВКИ») из МС.
     * UI рендерит `<select>` со значениями этого справочника. `?refresh=1` форсирует
     * обход кэша (по умолчанию 1ч). Возвращает массив `{ id, name, href }`.
     */
    router.get('/packing-types', async (req, res) => {
        try {
            const force = String(req.query.refresh || '').toLowerCase() === '1' ||
                String(req.query.refresh || '').toLowerCase() === 'true';
            const cache = await fetchPackingTypesFromMs(force);
            return res.json({
                success: true,
                rows: cache.rows,
                source_url: cache.source_url,
                refreshed_at: cache.ts ? new Date(cache.ts).toISOString() : null,
                cache_age_ms: cache.ts ? Date.now() - cache.ts : null,
            });
        } catch (e) {
            return res.status(503).json({
                success: false,
                error: e && e.message ? e.message : 'Не удалось получить справочник «Тип упаковки»',
                code: e && e.code ? String(e.code) : 'FETCH_FAILED',
            });
        }
    });

    /**
     * Глобальный журнал изменений габаритов: карточка «Журнал изменений габаритов» на /exports-dimensions.html.
     * Фильтры:
     *   - `search` — подстрока по `code` или `name` (ms_export.name).
     *   - `action` — `set`, `delete`, `sync_ms`, `sync_ms_skip`, `sync_ms_error` (см. ms_dimensions_log).
     *   - `field`  — конкретное поле (`length_cm` и т.д.).
     *   - `who`    — подстрока по `changed_by_name`.
     *   - `from`, `to` — диапазон по `changed_at` (`YYYY-MM-DD` или ISO).
     *   - `limit`, `offset` — пагинация (limit 1..500, дефолт 100).
     */
    router.get('/log/global', async (req, res) => {
        try {
            await ensureSchema(db);
            const where = [];
            const params = [];

            const search = String(req.query.search || '').trim();
            if (search) {
                const like = '%' + search + '%';
                where.push('(mdl.code LIKE ? OR mse.name LIKE ?)');
                params.push(like, like);
            }
            const action = String(req.query.action || '').trim();
            if (action) {
                where.push('mdl.action = ?');
                params.push(action);
            }
            const field = String(req.query.field || '').trim();
            if (field) {
                where.push('mdl.field = ?');
                params.push(field);
            }
            const who = String(req.query.who || '').trim();
            if (who) {
                where.push('mdl.changed_by_name LIKE ?');
                params.push('%' + who + '%');
            }
            const from = String(req.query.from || '').trim();
            if (from) {
                const d = new Date(from.length === 10 ? from + 'T00:00:00' : from);
                if (Number.isFinite(d.getTime())) {
                    where.push('mdl.changed_at >= ?');
                    params.push(d);
                }
            }
            const to = String(req.query.to || '').trim();
            if (to) {
                const d = new Date(to.length === 10 ? to + 'T23:59:59' : to);
                if (Number.isFinite(d.getTime())) {
                    where.push('mdl.changed_at <= ?');
                    params.push(d);
                }
            }
            const rawLimit = Number(req.query.limit);
            const limit = Math.min(
                500,
                Math.max(1, Number.isFinite(rawLimit) && rawLimit > 0 ? Math.floor(rawLimit) : 100),
            );
            const rawOffset = Number(req.query.offset);
            const offset = Math.max(
                0,
                Number.isFinite(rawOffset) && rawOffset >= 0 ? Math.floor(rawOffset) : 0,
            );

            const whereSql = where.length > 0 ? 'WHERE ' + where.join(' AND ') : '';
            const [totRows] = await db.query(
                'SELECT COUNT(*) AS total FROM ms_dimensions_log mdl ' +
                    'LEFT JOIN ms_export mse ON mse.code = mdl.code ' +
                    whereSql,
                params,
            );
            const total = Number((totRows && totRows[0] && totRows[0].total) || 0);

            const [rows] = await db.query(
                `SELECT mdl.id, mdl.code, mse.name AS name, mse.type AS type,
                        mdl.field, mdl.old_value, mdl.new_value, mdl.action,
                        mdl.changed_by_user_id, mdl.changed_by_name, mdl.note, mdl.changed_at
                 FROM ms_dimensions_log mdl
                 LEFT JOIN ms_export mse ON mse.code = mdl.code ` +
                    whereSql +
                    `
                 ORDER BY mdl.id DESC
                 LIMIT ? OFFSET ?`,
                [...params, limit, offset],
            );
            const out = (rows || []).map((r) => ({
                id: Number(r.id),
                code: String(r.code || ''),
                name: r.name != null ? String(r.name) : '',
                type: r.type != null ? String(r.type) : '',
                field: String(r.field || ''),
                field_label: MEASUREMENT_FIELDS[r.field]
                    ? MEASUREMENT_FIELDS[r.field].label
                    : String(r.field || ''),
                old_value: r.old_value != null ? String(r.old_value) : null,
                new_value: r.new_value != null ? String(r.new_value) : null,
                action: String(r.action || 'set'),
                changed_by_user_id: r.changed_by_user_id != null ? Number(r.changed_by_user_id) : null,
                changed_by_name: r.changed_by_name != null ? String(r.changed_by_name) : '',
                note: r.note != null ? String(r.note) : '',
                changed_at: r.changed_at ? new Date(r.changed_at).toISOString() : '',
            }));
            return res.json({ success: true, rows: out, total, limit, offset });
        } catch (e) {
            return res
                .status(500)
                .json({ success: false, error: e.message || 'Ошибка чтения глобального журнала' });
        }
    });

    /**
     * Откат правки по `id` строки `ms_dimensions_log`. Применим только к `action='set'`
     * с известным `field` (одно из `MEASUREMENT_FIELDS`). Восстанавливает поле в `old_value`
     * через `persistMeasurementFields`, что создаёт **новую** `set`-запись в логе с note
     * `revert from log_id=N` — таким образом откат и сам становится аудируемым событием.
     * Возвращает `{ success, code, field, reverted_to, persisted_fields }`.
     */
    router.post('/log/revert', async (req, res) => {
        try {
            await ensureSchema(db);
            const body = req.body && typeof req.body === 'object' ? req.body : {};
            const logId = Number(body.log_id);
            if (!Number.isFinite(logId) || logId <= 0) {
                return res.status(400).json({ success: false, error: 'Не указан log_id' });
            }
            const [rows] = await db.query(
                `SELECT id, code, field, old_value, new_value, action
                 FROM ms_dimensions_log WHERE id = ? LIMIT 1`,
                [logId],
            );
            const row = (Array.isArray(rows) && rows[0]) || null;
            if (!row) {
                return res.status(404).json({ success: false, error: 'Запись лога не найдена' });
            }
            const action = String(row.action || '');
            if (action !== 'set') {
                return res
                    .status(400)
                    .json({ success: false, error: 'Откат поддержан только для записей с action="set"' });
            }
            const field = String(row.field || '');
            if (!MEASUREMENT_FIELDS[field]) {
                return res
                    .status(400)
                    .json({ success: false, error: 'Откат поддержан только для полей габаритов' });
            }
            const code = String(row.code || '').trim();
            if (!code) return res.status(400).json({ success: false, error: 'В записи лога нет code' });

            const oldRaw = row.old_value != null ? String(row.old_value) : null;
            const restored = oldRaw == null ? null : normalizeFieldValue(field, oldRaw);

            const actor = req.datagonActor || null;
            const actorName = actorDisplayName(actor) || null;
            const actorId = actor && actor.id != null ? Number(actor.id) : null;
            const note =
                'revert from log_id=' + logId +
                (oldRaw != null ? '' : ' (clear)');

            const persisted = await persistMeasurementFields(db, {
                code,
                incoming: { [field]: restored },
                measuredByName: actorName,
                measuredByUserId: actorId,
                measuredAt: new Date(),
                note,
            });

            return res.json({
                success: true,
                code,
                field,
                reverted_to: restored,
                persisted_fields: (persisted.changedFields || []).map((c) => c.field),
                measurement: persisted.measurement || null,
                measured_by_name: persisted.measured_by_name || null,
                measured_at: persisted.measured_at instanceof Date
                    ? persisted.measured_at.toISOString()
                    : (persisted.measured_at || null),
                changed: (persisted.changedFields || []).length > 0,
            });
        } catch (e) {
            return res
                .status(500)
                .json({ success: false, error: e.message || 'Ошибка отката записи лога' });
        }
    });

    /** Удалить замер (откат «кто замерял / дата замера» в пусто). */
    router.delete('/measure/:code', async (req, res) => {
        try {
            await ensureSchema(db);
            const code = String(req.params.code || '').trim();
            if (!code) return res.status(400).json({ success: false, error: 'Не указан code' });
            const actor = req.datagonActor || null;
            await db.query(
                `INSERT INTO ms_dimensions_log
                    (code, field, old_value, new_value, action, changed_by_user_id, changed_by_name)
                 VALUES (?, '*', NULL, NULL, 'delete', ?, ?)`,
                [code, actor && actor.id != null ? Number(actor.id) : null, actorDisplayName(actor) || null],
            );
            await db.query('DELETE FROM ms_dimensions_measurements WHERE code = ?', [code]);
            return res.json({ success: true, code });
        } catch (e) {
            return res.status(500).json({ success: false, error: e.message || 'Ошибка удаления замера' });
        }
    });

    return router;
}

module.exports = createDimensionsRouter;
/** Экспорт `ensureSchema` нужен, чтобы другие роуты, которые делают
 * `LEFT JOIN ms_dimensions_measurements` (например, `routes/exportsMarketplaces.js`
 * для `/api/exports/marketplaces/issues`), могли гарантировать наличие таблицы
 * на чистом стенде до первого HTTP-запроса. */
module.exports.ensureSchema = ensureSchema;

/**
 * Хук авто-синхронизации в server.js (`processAutoSyncQueue` task='dimensions'):
 * запустить балк-выгрузку всех override габаритов в МС. Не зависит от создания
 * router'а — можно дернуть из любого места процесса.
 */
module.exports.runScheduledSyncMs = function triggerScheduledDimensionsSync(db, triggerType, hooks) {
    return runScheduledDimensionsSyncMs(db, triggerType, hooks);
};

/** Снимок состояния балк-синка: для honest-статуса auto_sync_runs + UI processes. */
module.exports.getScheduledSyncState = function getScheduledDimensionsSyncState() {
    return snapshotScheduledState();
};
