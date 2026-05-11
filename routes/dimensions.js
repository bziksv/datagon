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

const MS_BASE_URL = 'https://api.moysklad.ru/api/remap/1.2';
const MS_ATTR_META_TTL_MS = 60 * 60 * 1000; /** 1 час — параритет с moysklad.js */
const msAttrMetaCache = new Map(); /** entityKind('product'|'bundle') → { ts, rows } */

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
const ALLOWED_SORT = {
    code: 'mse.code',
    name: 'mse.name',
    type: 'mse.type',
    stock: 'mse.stock',
    measured_by_name: 'mdm.measured_by_name',
    measured_at: 'mdm.measured_at',
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

    const scope = String((query && query.scope) || 'all').trim().toLowerCase();
    if (scope === 'with') {
        where.push('mdm.code IS NOT NULL');
    } else if (scope === 'without') {
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
 */
async function fetchMsAttributesMeta(entityKind, headers) {
    const cached = msAttrMetaCache.get(entityKind);
    const now = Date.now();
    if (cached && now - cached.ts < MS_ATTR_META_TTL_MS) return cached.rows;
    const url = MS_BASE_URL + '/entity/' + entityKind + '/metadata/attributes';
    const resp = await axios.get(url, { headers, timeout: 30000 });
    const rows = (resp && resp.data && Array.isArray(resp.data.rows)) ? resp.data.rows : [];
    msAttrMetaCache.set(entityKind, { ts: now, rows });
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
    const attrsMeta = await fetchMsAttributesMeta(entityKind, headers);
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
            const { whereSql, params } = buildWhereClauseFromQuery(req.query);

            const fromSql = `
                FROM ms_export mse
                LEFT JOIN ms_dimensions_measurements mdm ON mdm.code = mse.code
            `;

            const [countRows] = await db.query(
                `SELECT COUNT(*) AS total ${fromSql} ${whereSql}`,
                params,
            );
            const total = Number((countRows && countRows[0] && countRows[0].total) || 0);

            /**
             * Подгружаем `payload_json` из ms_entity_details только для строк текущей страницы
             * (LEFT JOIN ниже), а не для всего ms_export. JSON может быть тяжёлым (LONGTEXT,
             * ~2–5 КБ × 57k строк), без ограничения по странице запрос растащит память
             * сервера на удалённой БД.
             */
            const [rows] = await db.query(
                `SELECT
                    mse.code AS code,
                    mse.name AS name,
                    mse.type AS type,
                    mse.uuid AS uuid,
                    mse.stock AS stock,
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
                    med.payload_json AS payload_json
                 ${fromSql}
                 LEFT JOIN ms_entity_details med ON med.uuid = mse.uuid
                 ${whereSql}
                 ORDER BY ${orderBy}
                 LIMIT ? OFFSET ?`,
                params.concat([limit, offset]),
            );

            const out = (rows || []).map((r) => {
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
                /** Парсим «Тип упаковки» из МС: даёт authoritative kind + автозначения
                 *  для L/W/H, которые UI показывает как ghost-default, пока не появится
                 *  user-override (см. /measure ниже). */
                const parsed = parsePackingDims(dimsMs.packing_type);
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
            });

            return res.json({
                success: true,
                rows: out,
                total,
                limit,
                offset,
                sort_by: String(req.query.sort_by || 'code'),
                sort_dir: String(req.query.sort_dir || 'asc'),
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
             * Если фронт передал inline `measurement` (объект с текущими значениями
             * инпутов в строке) — persist'им его в БД ДО отправки в МС. Это даёт
             * сценарий «отправить всё, что я ввёл прямо сейчас» из любой ячейки даже
             * без предварительного blur/Enter, и при этом фиксирует автора в журнале.
             */
            const actor = req.datagonActor || null;
            const actorId = actor && actor.id != null ? Number(actor.id) : null;
            const actorName = actorDisplayName(actor) || null;
            let persistedFields = [];
            if (body.measurement && typeof body.measurement === 'object') {
                const incoming = {};
                for (const k of Object.keys(MEASUREMENT_FIELDS)) {
                    if (Object.prototype.hasOwnProperty.call(body.measurement, k)) {
                        incoming[k] = body.measurement[k];
                    }
                }
                if (Object.keys(incoming).length > 0) {
                    const persisted = await persistMeasurementFields(db, {
                        code,
                        incoming,
                        measuredByName: actorName,
                        measuredByUserId: actorId,
                        measuredAt: new Date(),
                        note: 'sync_ms (auto-persist before push)',
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
                [code],
            );
            const r = (Array.isArray(rows) && rows[0]) || null;
            if (!r) return res.status(404).json({ success: false, error: 'Позиция не найдена в ms_export' });

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

            /** Опциональный whitelist `fields[]` — синкаем только указанное подмножество. */
            let measurement = fullMeasurement;
            if (Array.isArray(body.fields) && body.fields.length > 0) {
                measurement = {};
                for (const k of body.fields) {
                    if (Object.prototype.hasOwnProperty.call(fullMeasurement, k)) {
                        measurement[k] = fullMeasurement[k];
                    }
                }
            }

            let result;
            try {
                result = await pushMeasurementToMs(uuid, type, measurement);
            } catch (e) {
                return res.status(503).json({
                    success: false,
                    code,
                    error: e && e.message ? e.message : 'Ошибка отправки в МС',
                    code_error: e && e.code ? String(e.code) : 'PUSH_FAILED',
                    persisted_fields: persistedFields,
                });
            }

            if (result.ok && Array.isArray(result.sent_fields) && result.sent_fields.length > 0) {
                /** Лог: одна строка на каждое отправленное поле — удобно фильтровать по полю. */
                const note = 'sync_ms entity=' + result.entity_kind + ' http=' + (result.ms_status || 200);
                for (const f of result.sent_fields) {
                    const v = measurement[f];
                    await db.query(
                        `INSERT INTO ms_dimensions_log
                            (code, field, old_value, new_value, action, changed_by_user_id, changed_by_name, note)
                         VALUES (?, ?, NULL, ?, 'sync_ms', ?, ?, ?)`,
                        [code, f, v != null ? String(v) : null, actorId, actorName, note],
                    );
                }
            }

            return res.json({
                success: !!result.ok,
                code,
                uuid,
                type,
                entity_kind: result.entity_kind,
                sent_fields: result.sent_fields || [],
                skipped: result.skipped || [],
                persisted_fields: persistedFields,
                error: result.ok ? undefined : (result.error || 'Не удалось обновить позицию в МС'),
                http_status: result.http_status || null,
                ms_updated_at: result.ms_updated_at || null,
            });
        } catch (e) {
            return res.status(500).json({ success: false, error: e.message || 'Ошибка синхронизации с МС' });
        }
    });

    /**
     * Статистика журнала `ms_dimensions_log` для UI «Логи сервера» в /settings.html:
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
     * Глобальный журнал изменений габаритов: страница «История» на /exports-dimensions.html.
     * Фильтры:
     *   - `search` — подстрока по `code` или `name` (ms_export.name).
     *   - `action` — `set`, `delete`, `sync_ms`, `sync_ms_skip` (см. ms_dimensions_log).
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
