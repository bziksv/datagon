'use strict';

/**
 * Пошаговая система автоматического объединения карточек товаров на Ozon («склейка» вариантов).
 *
 * Механика Ozon Seller API:
 *  - Атрибут 9048 («Объединить на одной карточке») — одинаковое строковое значение у всех склеиваемых товаров.
 *  - Все склеиваемые товары обязаны иметь одинаковые `description_category_id`, `type_id` и Бренд (`id = 85`).
 *    По умолчанию («copy_from_main») категория, тип, бренд и недостающие обязательные атрибуты
 *    подтягиваются с первой («главной») карточки группы.
 *  - У товаров внутри одной склейки обязан отличаться хотя бы один вариативный (`is_aspect: true`) атрибут
 *    данной категории (размер, цвет, количество в упаковке, объём, название модели и т.п.).
 */

const {
    axiosWithMarketplaceRateLimit,
    createMarketplaceLogger,
    MP_MIN_DELAY_MS,
} = require('./marketplaceExports');
const {
    ozonHeaders,
    buildImportItem,
    waitOzonImportTask,
} = require('./ozonProductDimsUpdate');
const { dimsFromOzonCard } = require('./ozonProductVatUpdate');

const OZON_MERGE_ATTR_ID = 9048;
const OZON_BRAND_ATTR_ID = 85;

/** Кэш метаданных атрибутов категории Ozon: key = `${catId}:${typeId}` -> { ts, attrs } */
const categoryAttrsCache = new Map();
const CATEGORY_ATTRS_TTL_MS = 30 * 60 * 1000;

let mergeTablesReady = false;

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

/**
 * Автомиграция таблиц кэша карточек Ozon и пользовательских решений по объединению.
 */
async function ensureOzonMergeTables(db) {
    if (mergeTablesReady || !db || typeof db.query !== 'function') return;
    await db.query(`
        CREATE TABLE IF NOT EXISTS dg_ozon_merge_cards_cache (
            offer_id VARCHAR(191) NOT NULL,
            product_id BIGINT NOT NULL DEFAULT 0,
            ozon_name VARCHAR(512) NOT NULL DEFAULT '',
            description_category_id BIGINT NOT NULL DEFAULT 0,
            type_id BIGINT NOT NULL DEFAULT 0,
            brand VARCHAR(255) NOT NULL DEFAULT '',
            merge_key_9048 VARCHAR(255) NOT NULL DEFAULT '',
            aspects_json MEDIUMTEXT NULL,
            synced_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            PRIMARY KEY (offer_id),
            KEY idx_ozm_cache_merge_key (merge_key_9048),
            KEY idx_ozm_cache_cat (description_category_id, type_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await db.query(`
        CREATE TABLE IF NOT EXISTS dg_ozon_merge_decisions (
            group_signature VARCHAR(255) NOT NULL,
            status VARCHAR(32) NOT NULL DEFAULT 'suggested',
            group_title VARCHAR(512) NOT NULL DEFAULT '',
            group_key_9048 VARCHAR(255) NOT NULL DEFAULT '',
            main_offer_id VARCHAR(191) NOT NULL DEFAULT '',
            codes_json TEXT NULL,
            excluded_codes_json TEXT NULL,
            aspect_attr_id BIGINT NOT NULL DEFAULT 0,
            aspect_attr_name VARCHAR(255) NOT NULL DEFAULT '',
            aspect_values_json MEDIUMTEXT NULL,
            comment VARCHAR(512) NOT NULL DEFAULT '',
            updated_by_name VARCHAR(191) NOT NULL DEFAULT '',
            updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            PRIMARY KEY (group_signature),
            KEY idx_ozm_dec_status (status)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await db.query(`
        CREATE TABLE IF NOT EXISTS dg_ozon_merge_log (
            id BIGINT AUTO_INCREMENT PRIMARY KEY,
            group_signature VARCHAR(255) NOT NULL DEFAULT '',
            offer_id VARCHAR(191) NOT NULL DEFAULT '',
            action VARCHAR(64) NOT NULL DEFAULT '',
            field VARCHAR(128) NOT NULL DEFAULT '',
            field_label VARCHAR(255) NOT NULL DEFAULT '',
            old_value TEXT NULL,
            new_value TEXT NULL,
            note TEXT NULL,
            changed_by_user_id BIGINT NULL,
            changed_by_name VARCHAR(191) NOT NULL DEFAULT '',
            changed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            KEY idx_ozm_log_sig (group_signature, id),
            KEY idx_ozm_log_offer (offer_id, id),
            KEY idx_ozm_log_at (changed_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    // Автоматический бэкфилл журнала и пустого автора из уже выполненных решений dg_ozon_merge_decisions
    try {
        let fallbackActorName = 'admin';
        let fallbackActorId = null;
        try {
            const [uRows] = await db.query(`
                SELECT u.id, u.username, u.full_name
                FROM auth_sessions s
                JOIN users u ON u.id = s.user_id
                WHERE s.revoked = 0
                ORDER BY s.last_seen_at DESC, s.id DESC
                LIMIT 1
            `);
            if (uRows && uRows[0]) {
                fallbackActorId = Number(uRows[0].id) || null;
                fallbackActorName =
                    String(uRows[0].full_name || uRows[0].username || 'admin').trim() || 'admin';
            }
        } catch (_) {}

        await db.query(
            `UPDATE dg_ozon_merge_decisions
             SET updated_by_name = ?
             WHERE updated_by_name = '' OR updated_by_name IS NULL`,
            [fallbackActorName]
        );

        const [[cntRow]] = await db.query(`SELECT COUNT(*) AS cnt FROM dg_ozon_merge_log`);
        if (Number((cntRow && cntRow.cnt) || 0) === 0) {
            const [decRows] = await db.query(
                `SELECT * FROM dg_ozon_merge_decisions ORDER BY updated_at ASC`
            );
            for (const d of decRows || []) {
                const sig = String(d.group_signature || '').trim();
                const status = String(d.status || '').trim();
                const gKey = String(d.group_key_9048 || d.main_offer_id || '').trim();
                const who = String(d.updated_by_name || fallbackActorName).trim();
                const when = d.updated_at || new Date();
                let codes = [];
                let aspectMap = {};
                try {
                    codes = d.codes_json ? JSON.parse(d.codes_json) : [];
                } catch (_) {}
                try {
                    aspectMap = d.aspect_values_json ? JSON.parse(d.aspect_values_json) : {};
                } catch (_) {}

                if (status === 'merged' || status === 'failed') {
                    const act = status === 'merged' ? 'merge' : 'merge_failed';
                    const itemCodes = Array.isArray(codes) && codes.length ? codes : [gKey].filter(Boolean);
                    for (const code of itemCodes) {
                        const asp = aspectMap && aspectMap[code] ? ` (${aspectMap[code]})` : '';
                        await db.query(
                            `INSERT INTO dg_ozon_merge_log
                                (group_signature, offer_id, action, field, field_label, old_value, new_value, note, changed_by_user_id, changed_by_name, changed_at)
                             VALUES (?, ?, ?, 'merge_key_9048', 'Склейка на Ozon (9048)', 'Не склеен', ?, ?, ?, ?, ?)`,
                            [
                                sig,
                                String(code),
                                act,
                                status === 'merged' ? `${gKey}${asp}` : 'Отказ Ozon',
                                String(d.comment || `Группа ${sig}, главная карточка: ${d.main_offer_id || gKey}`),
                                fallbackActorId,
                                who,
                                when,
                            ]
                        );
                    }
                } else if (status === 'ignored') {
                    await db.query(
                        `INSERT INTO dg_ozon_merge_log
                            (group_signature, offer_id, action, field, field_label, old_value, new_value, note, changed_by_user_id, changed_by_name, changed_at)
                         VALUES (?, ?, 'ignore', 'status', 'Статус группы', 'suggested', 'ignored (Не объединять)', ?, ?, ?, ?)`,
                        [
                            sig,
                            Array.isArray(codes) ? codes.join(', ').slice(0, 190) : String(d.main_offer_id || ''),
                            String(d.comment || 'Отмечено «Не объединять»'),
                            fallbackActorId,
                            who,
                            when,
                        ]
                    );
                } else if (status === 'custom') {
                    await db.query(
                        `INSERT INTO dg_ozon_merge_log
                            (group_signature, offer_id, action, field, field_label, old_value, new_value, note, changed_by_user_id, changed_by_name, changed_at)
                         VALUES (?, ?, 'create_custom', 'custom_group', 'Ручная группа', NULL, ?, ?, ?, ?, ?)`,
                        [
                            sig,
                            Array.isArray(codes) ? codes.join(', ').slice(0, 190) : String(d.main_offer_id || ''),
                            Array.isArray(codes) ? codes.join(', ') : gKey,
                            String(d.group_title || d.comment || 'Создана ручная группа'),
                            fallbackActorId,
                            who,
                            when,
                        ]
                    );
                }
            }
        }
    } catch (eInitLog) {
        console.warn('[ozon-merge] log init/backfill warning:', eInitLog && eInitLog.message ? eInitLog.message : eInitLog);
    }

    mergeTablesReady = true;
}

/**
 * Запись события в журнал склеек/расклеек `dg_ozon_merge_log`.
 */
async function appendOzonMergeLog(db, entry = {}) {
    if (!db || typeof db.query !== 'function') return;
    try {
        await ensureOzonMergeTables(db);
        const sig = String(entry.group_signature || '').trim().slice(0, 255);
        const offerId = String(entry.offer_id || '').trim().slice(0, 191);
        const action = String(entry.action || 'set').trim().slice(0, 64);
        const field = String(entry.field || '').trim().slice(0, 128);
        const fieldLabel = String(entry.field_label || field || '').trim().slice(0, 255);
        const oldVal = entry.old_value == null ? null : String(entry.old_value);
        const newVal = entry.new_value == null ? null : String(entry.new_value);
        const note = entry.note == null ? null : String(entry.note);
        const userId =
            entry.changed_by_user_id != null && Number.isFinite(Number(entry.changed_by_user_id))
                ? Number(entry.changed_by_user_id)
                : null;
        const userName = String(entry.changed_by_name || '').trim().slice(0, 191);

        await db.query(
            `INSERT INTO dg_ozon_merge_log
                (group_signature, offer_id, action, field, field_label, old_value, new_value, note, changed_by_user_id, changed_by_name)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [sig, offerId, action, field, fieldLabel, oldVal, newVal, note, userId, userName]
        );
    } catch (eLog) {
        console.warn('[ozon-merge] appendOzonMergeLog failed:', eLog && eLog.message ? eLog.message : eLog);
    }
}

/**
 * Чтение журнала склеек/расклеек `dg_ozon_merge_log` с фильтрацией по группе или коду товара.
 */
async function getOzonMergeLog(db, opts = {}) {
    if (!db || typeof db.query !== 'function') {
        return { success: true, total: 0, limit: 100, offset: 0, rows: [] };
    }
    await ensureOzonMergeTables(db);
    const sig = String(opts.signature || '').trim();
    const offerId = String(opts.offer_id || opts.offerId || '').trim();
    const limit = Math.min(500, Math.max(1, Number(opts.limit) || 100));
    const offset = Math.max(0, Number(opts.offset) || 0);

    const where = [];
    const params = [];

    if (sig && offerId) {
        where.push(`(group_signature = ? OR offer_id = ? OR FIND_IN_SET(?, REPLACE(offer_id, ' ', '')) > 0)`);
        params.push(sig, offerId, offerId);
    } else if (sig) {
        // Ищем и по точному signature, и по совпадению кода группы (например bundle:24850 vs ozon9048:24850 vs merged:24850)
        const baseKey = sig.includes(':') ? sig.split(':').slice(1).join(':') : sig;
        if (baseKey) {
            where.push(
                `(group_signature = ? OR group_signature = ? OR group_signature = ? OR group_signature = ? OR offer_id = ?)`
            );
            params.push(sig, `bundle:${baseKey}`, `ozon9048:${baseKey}`, `merged:${baseKey}`, baseKey);
        } else {
            where.push(`group_signature = ?`);
            params.push(sig);
        }
    } else if (offerId) {
        where.push(
            `(offer_id = ? OR FIND_IN_SET(?, REPLACE(offer_id, ' ', '')) > 0 OR group_signature = ? OR group_signature = ?)`
        );
        params.push(offerId, offerId, `bundle:${offerId}`, `ozon9048:${offerId}`);
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const [[cntRow]] = await db.query(
        `SELECT COUNT(*) AS cnt FROM dg_ozon_merge_log ${whereSql}`,
        params
    );
    const total = Number((cntRow && cntRow.cnt) || 0);

    const [rows] = await db.query(
        `SELECT id, group_signature, offer_id, action, field, field_label,
                old_value, new_value, note, changed_by_user_id, changed_by_name, changed_at
         FROM dg_ozon_merge_log
         ${whereSql}
         ORDER BY id DESC
         LIMIT ? OFFSET ?`,
        [...params, limit, offset]
    );

    return {
        success: true,
        total,
        limit,
        offset,
        rows: rows || [],
    };
}

/**
 * Разбирает текст групп кодов МС (offer_id):
 * каждая непустая строка — отдельная группа (коды через запятую, точку с запятой, таб или пробел).
 * @param {string|Array} raw
 * @returns {string[][]}
 */
function parseMergeGroupsInput(raw) {
    if (Array.isArray(raw)) {
        const out = [];
        for (const g of raw) {
            const list = Array.isArray(g)
                ? g
                : typeof g === 'string'
                  ? g.split(/[,;\t\s]+/)
                  : g && Array.isArray(g.codes)
                    ? g.codes
                    : [];
            const uniq = Array.from(
                new Set(list.map((x) => String(x || '').trim()).filter(Boolean))
            );
            if (uniq.length >= 2) out.push(uniq);
        }
        return out;
    }
    const text = String(raw || '').trim();
    if (!text) return [];
    const lines = text
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('#') && !l.startsWith('//'));
    const out = [];
    for (const line of lines) {
        const cleaned = line.replace(/^[0-9]+[.)]\s*/, '');
        const tokens = cleaned
            .split(/[,;\t\s]+/)
            .map((x) => x.trim())
            .filter(Boolean);
        const uniq = Array.from(new Set(tokens));
        if (uniq.length >= 2) out.push(uniq);
    }
    return out;
}

/**
 * Чтение первого значения атрибута по его ID из массива `attr.attributes`.
 */
function getAttrFirstValue(attributes, attrId) {
    if (!Array.isArray(attributes)) return { value: '', dictionary_value_id: 0 };
    const hit = attributes.find((a) => Number(a && (a.id ?? a.attribute_id)) === Number(attrId));
    if (!hit || !Array.isArray(hit.values) || !hit.values.length) {
        return { value: '', dictionary_value_id: 0 };
    }
    const v0 = hit.values[0] || {};
    return {
        value: String(v0.value != null ? v0.value : '').trim(),
        dictionary_value_id: Number(v0.dictionary_value_id || 0) || 0,
    };
}

/**
 * Установка/замена атрибута в массиве `attributes` для `/v3/product/import`.
 * Формат `/v3/product/import`: `{ id, complex_id: 0, values: [{ value, dictionary_value_id? }] }`.
 */
function upsertImportAttribute(attributes, attrId, valueStr, dictionaryValueId = 0) {
    const idNum = Number(attrId);
    const val = String(valueStr == null ? '' : valueStr).trim();
    const dictId = Number(dictionaryValueId || 0) || 0;
    const list = Array.isArray(attributes) ? attributes.slice() : [];
    const normalized = list.map((a) => ({
        id: Number(a.id ?? a.attribute_id),
        complex_id: Number(a.complex_id || 0),
        values: Array.isArray(a.values) ? a.values : [],
    }));
    const idx = normalized.findIndex((a) => a.id === idNum);
    if (!val && !dictId) return normalized;
    const valObj = dictId > 0 ? { dictionary_value_id: dictId, value: val } : { value: val };
    const entry = {
        id: idNum,
        complex_id: 0,
        values: [valObj],
    };
    if (idx >= 0) {
        normalized[idx] = entry;
    } else {
        normalized.push(entry);
    }
    return normalized;
}

/**
 * Удаляет атрибут из массива `attributes` для `/v3/product/import` (или ставит пустое значение).
 */
function removeImportAttribute(attributes, attrId) {
    const idNum = Number(attrId);
    const list = Array.isArray(attributes) ? attributes.slice() : [];
    return list
        .map((a) => ({
            id: Number(a.id ?? a.attribute_id),
            complex_id: Number(a.complex_id || 0),
            values: Array.isArray(a.values) ? a.values : [],
        }))
        .filter((a) => a.id !== idNum);
}

/**
 * Пакетное получение `/v3/product/info/list` и `/v4/product/info/attributes` по массиву `offer_id`.
 */
async function fetchOzonCardsBatch(creds, offerIds, logger, delayMs) {
    const headers = ozonHeaders(creds);
    const uniqOffers = Array.from(
        new Set((offerIds || []).map((x) => String(x || '').trim()).filter(Boolean))
    );
    const infoByOffer = new Map();
    const attrByOffer = new Map();
    const chunkSize = 100;

    for (let i = 0; i < uniqOffers.length; i += chunkSize) {
        const chunk = uniqOffers.slice(i, i + chunkSize);
        if (i > 0 && delayMs) await sleep(delayMs);
        const infoRes = await axiosWithMarketplaceRateLimit(
            {
                method: 'POST',
                url: 'https://api-seller.ozon.ru/v3/product/info/list',
                data: { offer_id: chunk, language: 'DEFAULT' },
                headers,
                timeout: 120000,
            },
            logger,
            { maxAttempts: 5 }
        );
        const infoItems = (infoRes.data && infoRes.data.items) || [];
        for (const it of infoItems) {
            const oid = String(it && it.offer_id != null ? it.offer_id : '').trim();
            if (oid) infoByOffer.set(oid, it);
        }

        if (delayMs) await sleep(delayMs);
        const attrRes = await axiosWithMarketplaceRateLimit(
            {
                method: 'POST',
                url: 'https://api-seller.ozon.ru/v4/product/info/attributes',
                data: {
                    filter: { offer_id: chunk, visibility: 'ALL' },
                    limit: Math.max(chunk.length, 100),
                },
                headers,
                timeout: 120000,
            },
            logger,
            { maxAttempts: 5 }
        );
        const attrItems = (attrRes.data && attrRes.data.result) || [];
        for (const at of attrItems) {
            const oid = String(at && at.offer_id != null ? at.offer_id : '').trim();
            if (oid) attrByOffer.set(oid, at);
        }
    }

    return { infoByOffer, attrByOffer };
}

/**
 * Загружает список характеристик категории Ozon (`/v1/description-category/attribute`).
 */
async function fetchOzonCategoryAttributes(creds, descriptionCategoryId, typeId, logger) {
    const catId = Number(descriptionCategoryId || 0);
    const tId = Number(typeId || 0);
    if (!catId || !tId) return [];
    const cacheKey = `${catId}:${tId}`;
    const cached = categoryAttrsCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < CATEGORY_ATTRS_TTL_MS) {
        return cached.attrs;
    }
    const headers = ozonHeaders(creds);
    try {
        const res = await axiosWithMarketplaceRateLimit(
            {
                method: 'POST',
                url: 'https://api-seller.ozon.ru/v1/description-category/attribute',
                data: {
                    description_category_id: catId,
                    type_id: tId,
                    language: 'DEFAULT',
                },
                headers,
                timeout: 60000,
            },
            logger,
            { maxAttempts: 4 }
        );
        const list = (res.data && res.data.result) || [];
        categoryAttrsCache.set(cacheKey, { ts: Date.now(), attrs: list });
        return list;
    } catch (e) {
        logger.log('category_attrs_fail', {
            description_category_id: catId,
            type_id: tId,
            message: e && e.message ? e.message : String(e),
        });
        return [];
    }
}

/**
 * Поиск значения в справочнике атрибута Ozon (`/v1/description-category/attribute/values/search`).
 */
async function searchOzonAttributeDictionaryValues(
    creds,
    { descriptionCategoryId, typeId, attributeId, query, limit = 20 },
    logger
) {
    const catId = Number(descriptionCategoryId || 0);
    const tId = Number(typeId || 0);
    const attrId = Number(attributeId || 0);
    const q = String(query || '').trim();
    if (!catId || !tId || !attrId) return [];
    const headers = ozonHeaders(creds);

    try {
        if (q.length >= 1) {
            const res = await axiosWithMarketplaceRateLimit(
                {
                    method: 'POST',
                    url: 'https://api-seller.ozon.ru/v1/description-category/attribute/values/search',
                    data: {
                        attribute_id: attrId,
                        description_category_id: catId,
                        type_id: tId,
                        value: q,
                        limit: Math.min(100, Math.max(5, Number(limit) || 20)),
                    },
                    headers,
                    timeout: 45000,
                },
                logger,
                { maxAttempts: 3 }
            );
            return (res.data && res.data.result) || [];
        }
        const res = await axiosWithMarketplaceRateLimit(
            {
                method: 'POST',
                url: 'https://api-seller.ozon.ru/v1/description-category/attribute/values',
                data: {
                    attribute_id: attrId,
                    description_category_id: catId,
                    type_id: tId,
                    language: 'DEFAULT',
                    last_value_id: 0,
                    limit: Math.min(100, Math.max(10, Number(limit) || 30)),
                },
                headers,
                timeout: 45000,
            },
            logger,
            { maxAttempts: 3 }
        );
        return (res.data && res.data.result) || [];
    } catch (e) {
        logger.log('attr_dict_search_fail', {
            attribute_id: attrId,
            query: q,
            message: e && e.message ? e.message : String(e),
        });
        return [];
    }
}

/**
 * Выделяет вариативные (`is_aspect: true`) и популярные отличительные атрибуты категории.
 */
function pickVariantAttributesForCategory(catAttrs) {
    if (!Array.isArray(catAttrs) || !catAttrs.length) return [];
    const aspect = [];
    const fallback = [];
    const popularRx =
        /^(размер|формат|материал|цвет товара|количество в упаковке|количество заводских упаковок|количество товара в уеи|вес товара|объем|фасовка|длина|ширина|диаметр|модификация|название модели|тип|вид|вариант|вкус|аромат)/i;
    const excludeDimsRx = /размер\s+упаковки|габариты\s+упаковки|\bд\s*[xх×]\s*ш\s*[xх×]\s*в\b|длина\s*[xх×]\s*ширина/i;

    for (const a of catAttrs) {
        const id = Number(a && a.id);
        if (!id || id === OZON_MERGE_ATTR_ID || id === OZON_BRAND_ATTR_ID) continue;
        const item = {
            id,
            name: String(a.name || '').trim(),
            type: String(a.type || '').trim(),
            is_aspect: Boolean(a.is_aspect),
            is_required: Boolean(a.is_required),
            dictionary_id: Number(a.dictionary_id || 0) || 0,
            description: String(a.description || '').trim(),
        };
        if (item.is_aspect) {
            aspect.push(item);
        } else if (popularRx.test(item.name) && !excludeDimsRx.test(item.name)) {
            fallback.push(item);
        }
    }
    return [...aspect, ...fallback];
}

/**
 * Умное извлечение отличительного признака из названия / параметров товара внутри группы.
 * Используется для автоподстановки вариативного атрибута, когда в Ozon он ещё не заполнен.
 */
function suggestDistinguishingValue(itemName, allNamesInGroup, aspectAttrName, indexInGroup) {
    const name = String(itemName || '').trim();
    const attrNameLow = String(aspectAttrName || '').toLowerCase();

    if (!name) return String(indexInGroup + 1);

    // 1. Если атрибут про количество / фасовку («Количество в упаковке», «шт»)
    if (/количество|упаковк|фасовк|штук/i.test(attrNameLow)) {
        const mQty =
            name.match(/(?:№\s*|по\s+|уп\.?\s*)(\d{1,5})\b/i) ||
            name.match(/\b(\d{1,5})\s*(?:шт|штук|пары|пар|таб|капс|пак|салф|лист)/i);
        if (mQty) return mQty[1];
    }

    // 2. Если атрибут про объём / мл / л
    if (/объем|объём|мл\b|литр/i.test(attrNameLow)) {
        const mVol = name.match(/\b(\d+(?:[.,]\d+)?)\s*(мл|л|ml|l)\b/i);
        if (mVol) {
            const num = parseFloat(mVol[1].replace(',', '.'));
            const unit = mVol[2].toLowerCase();
            if (unit === 'л' || unit === 'l') {
                return /мл/i.test(attrNameLow) ? String(Math.round(num * 1000)) : `${num} л`;
            }
            return /мл/i.test(attrNameLow) ? String(Math.round(num)) : `${mVol[1]} мл`;
        }
    }

    // 3. Если атрибут про вес
    if (/вес|грамм/i.test(attrNameLow)) {
        const mW = name.match(/\b(\d+(?:[.,]\d+)?)\s*(г|гр|кг|мг)\b/i);
        if (mW) return `${mW[1]} ${mW[2]}`;
    }

    // 4. Если атрибут про размер / габариты / калибр
    if (/размер|габарит|длина|ширина|диаметр/i.test(attrNameLow)) {
        const mDim =
            name.match(/\b(\d+(?:[.,]\d+)?\s*[xх×*]\s*\d+(?:[.,]\d+)?(?:\s*[xх×*]\s*\d+(?:[.,]\d+)?)?\s*(?:см|мм|м)?)\b/i) ||
            name.match(/\b(XXS|XS|S|M|L|XL|XXL|2XL|3XL|4XL|\d{1,2}G)\b/i) ||
            name.match(/(?:размер|р-р|р\.)\s*([A-Za-zА-Яа-я0-9.,/-]+)/i);
        if (mDim) return mDim[1].trim();
    }

    // 5. Универсальный дифф токенов между названиями внутри группы
    const tokenize = (s) =>
        String(s || '')
            .replace(/[()[\]«»"']/g, ' ')
            .split(/\s+/)
            .map((t) => t.replace(/^[,.;:]+|[,.;:]+$/g, '').trim())
            .filter(Boolean);

    const allTokensList = (allNamesInGroup || []).map(tokenize);
    if (allTokensList.length >= 2) {
        const commonLower = new Set(allTokensList[0].map((t) => t.toLowerCase()));
        for (let i = 1; i < allTokensList.length; i += 1) {
            const curSet = new Set(allTokensList[i].map((t) => t.toLowerCase()));
            for (const c of Array.from(commonLower)) {
                if (!curSet.has(c)) commonLower.delete(c);
            }
        }
        const myTokens = tokenize(name);
        const diffTokens = myTokens.filter((t) => !commonLower.has(t.toLowerCase()));
        if (diffTokens.length) {
            return diffTokens.join(' ').slice(0, 80);
        }
    }

    // 6. Fallback — хвост названия или размер/фасовка из общих паттернов
    const mAny =
        name.match(/\b(\d+(?:[.,]\d+)?\s*[xх×*]\s*\d+(?:[.,]\d+)?\s*(?:см|мм|м)?)\b/i) ||
        name.match(/\b(\d+\s*(?:шт|мл|л|г|кг|мм|см))\b/i) ||
        name.match(/(?:№\s*\d+)/i);
    if (mAny) return mAny[0].trim();

    return name.slice(-40).trim() || `Вариант ${indexInGroup + 1}`;
}

/**
 * Сканирует все товары Ozon из локального снапшота `marketplace_export_rows`
 * через `/v4/product/info/attributes` и сохраняет атрибут 9048, бренд 85,
 * категорию и тип в `dg_ozon_merge_cards_cache`.
 */
async function scanOzonMergeAttributesToCache(creds, db, opts = {}) {
    const t0 = Date.now();
    await ensureOzonMergeTables(db);
    const logger = (opts && opts.logger) || createMarketplaceLogger('ozon-merge-scan');
    const clientId = String(creds.clientId || '').trim();
    const apiKey = String(creds.apiKey || '').trim();
    if (!clientId || !apiKey) {
        return {
            success: false,
            error: 'Не заданы ключи Ozon (ozon_client_id / ozon_api_key)',
            code: 'MISSING_CREDS',
        };
    }

    const [rows] = await db.query(
        `SELECT external_id, offer_id, name, row_json
         FROM marketplace_export_rows
         WHERE marketplace = 'ozon'`
    );
    const offerIds = [];
    for (const r of rows || []) {
        const oid = String(r.external_id || r.offer_id || '').trim();
        if (oid) offerIds.push(oid);
    }
    const uniqOffers = Array.from(new Set(offerIds));
    if (!uniqOffers.length) {
        return {
            success: true,
            total: 0,
            scanned: 0,
            with_9048: 0,
            duration_sec: 0,
        };
    }

    const headers = ozonHeaders(creds);
    const delayMs = Math.max(
        MP_MIN_DELAY_MS.ozon || 200,
        Number((opts && opts.delayMs) ?? 250) || 250
    );
    const chunkSize = 100;
    let scanned = 0;
    let with9048 = 0;

    for (let i = 0; i < uniqOffers.length; i += chunkSize) {
        const chunk = uniqOffers.slice(i, i + chunkSize);
        if (i > 0 && delayMs) await sleep(delayMs);
        const attrRes = await axiosWithMarketplaceRateLimit(
            {
                method: 'POST',
                url: 'https://api-seller.ozon.ru/v4/product/info/attributes',
                data: {
                    filter: { offer_id: chunk, visibility: 'ALL' },
                    limit: Math.max(chunk.length, 100),
                },
                headers,
                timeout: 120000,
            },
            logger,
            { maxAttempts: 4 }
        );
        const attrItems = (attrRes.data && attrRes.data.result) || [];
        if (!attrItems.length) continue;

        const valuesSql = [];
        const params = [];
        for (const at of attrItems) {
            const oid = String(at && at.offer_id != null ? at.offer_id : '').trim();
            if (!oid) continue;
            const pid = Number(at.id || 0) || 0;
            const ozName = String(at.name || '').trim().slice(0, 500);
            const catId = Number(at.description_category_id || 0) || 0;
            const typeId = Number(at.type_id || 0) || 0;
            const mergeVal = getAttrFirstValue(at.attributes, OZON_MERGE_ATTR_ID).value.slice(0, 250);
            const brandVal = getAttrFirstValue(at.attributes, OZON_BRAND_ATTR_ID).value.slice(0, 250);
            if (mergeVal) with9048 += 1;
            scanned += 1;

            valuesSql.push('(?, ?, ?, ?, ?, ?, ?, NULL, CURRENT_TIMESTAMP)');
            params.push(oid, pid, ozName, catId, typeId, brandVal, mergeVal);
        }

        if (valuesSql.length) {
            await db.query(
                `INSERT INTO dg_ozon_merge_cards_cache
                    (offer_id, product_id, ozon_name, description_category_id, type_id, brand, merge_key_9048, aspects_json, synced_at)
                 VALUES ${valuesSql.join(', ')}
                 ON DUPLICATE KEY UPDATE
                    product_id = VALUES(product_id),
                    ozon_name = VALUES(ozon_name),
                    description_category_id = VALUES(description_category_id),
                    type_id = VALUES(type_id),
                    brand = VALUES(brand),
                    merge_key_9048 = VALUES(merge_key_9048),
                    synced_at = CURRENT_TIMESTAMP`,
                params
            );
        }
    }

    return {
        success: true,
        total: uniqOffers.length,
        scanned,
        with_9048: with9048,
        duration_sec: Number(((Date.now() - t0) / 1000).toFixed(2)),
    };
}

/**
 * Разбирает название товара на «чистую основу модели» и «отличительный признак варианта»
 * (размер, габариты, материал/исполнение, калибр, объём, вес, фасовку, цвет).
 */
function extractModelBaseAndVariant(rawName, msName = '') {
    const orig = String(rawName || '').trim();
    if (!orig) return { baseKey: '', baseTitle: '', variantLabel: '', variantKind: '', wordCount: 0 };

    // Если в МойСклад есть явное название модификации в скобках в конце:
    // например: `Легкие, внутренняя сторона плакат глянцевый А1+/А2+ (матовый холст от 200 г/кв.м, размер A1+)`
    const msStr = String(msName || '').trim();
    let msParenVariant = '';
    if (msStr) {
        const mParen = msStr.match(/\(([^()]{3,120})\)\s*$/);
        if (mParen) {
            const inner = mParen[1].trim();
            if (
                /размер|формат|холст|фотобумаг|бумаг|ламин|глянц|матов|[AА][0-5]\+?|\d+\s*(?:шт|мл|л|г|кг|мм|см)/i.test(
                    inner
                )
            ) {
                msParenVariant = inner
                    .replace(/(?:^|\s)от\s+\d+\s*(?:г\/кв\.?\s*м|г\/м2|гр\/м2)(?=$|[\s,.)])/gi, ' ')
                    .replace(/\s+[,.;:-]+(\s|$)/g, ', ')
                    .replace(/[,.;:-]+\s*$/g, '')
                    .replace(/\s{2,}/g, ' ')
                    .trim();
            }
        }
    }

    const extracted = [];
    const kindsSet = new Set();
    let working = orig;

    const rules = [
        {
            k: 'габариты / размер',
            rx: /(?:^|[\s,(])(\d+(?:[.,]\d+)?\s*[xх×*]\s*\d+(?:[.,]\d+)?(?:\s*[xх×*]\s*\d+(?:[.,]\d+)?)?\s*(?:см|мм|м)?)(?=$|[\s,.)])/gi,
        },
        {
            k: 'размер',
            rx: /(?:^|[\s,(])(?:размер(?:а|ы)?|формат(?:а|ы)?|р-р|р\.)\s*([A-Za-zА-Яа-я0-9+\-.,/]+)|(?:^|[\s,(])([AА][0-5]\+?)(?=$|[\s,.)])/gi,
        },
        {
            k: 'размер',
            rx: /\b(XXS|XS|S|M|L|XL|XXL|XXXL|2XL|3XL|4XL)\b/gi,
        },
        {
            k: 'материал / исполнение',
            rx: /(?:^|[\s,(])(?:из\s+)?((?:глянцев(?:ый|ая|ое|ого|ой)|матов(?:ый|ая|ое|ого|ой)|плотн(?:ый|ая|ое|ой)(?:\s+глянцев(?:ый|ая|ое|ой))?|самоклеящ(?:ийся|аяся|ееся)|ламинированн(?:ый|ая|ое|ого|ой))\s+(?:фотобумаг[аиуе]|бумаг[аиуе]|холст(?:а|у|е)?|пленк[аиуе]|плёнк[аиуе]|винил(?:а|у)?|пластик(?:а|у)?|баннер(?:а|ной\s+ткани)?)(?:\s+от\s+\d+\s*(?:г\/кв\.?\s*м|г\/м2|гр\/м2))?)(?=$|[\s,.)])/gi,
        },
        {
            k: 'материал / исполнение',
            rx: /(?:^|[\s,(])((?:фотобумаг[аиуе]|холст|банерная\s+ткань|баннерная\s+ткань|пленк[аиуе]|плёнк[аиуе]|ламинаци[яией]|ламинированн(?:ый|ая|ое)|глянцевая|глянцевый|матовая|матовый)(?:\s+от\s+\d+\s*(?:г\/кв\.?\s*м|г\/м2|гр\/м2))?)(?=$|[\s,.)])/gi,
        },
        {
            k: 'калибр / размер',
            rx: /(?:^|[\s,(])(\d{1,2}\s*G|\d+(?:[.,]\d+)?\s*(?:CH|Fr|мм|см))(?=$|[\s,.)])/gi,
        },
        {
            k: 'объём / вес',
            rx: /(?:^|[\s,(])(\d+(?:[.,]\d+)?\s*(?:мл|л|г|гр|кг|мг))(?=$|[\s,.)])/gi,
        },
        {
            k: 'количество в упаковке',
            rx: /(?:^|[\s,(])(?:№\s*\d{1,5}|по\s+\d{1,5}\s*шт\.?|\d{1,5}\s*(?:шт\.?|штук|уп\.?|пары|пар|таб\.?|капс\.?|пак\.?|салф\.?|лист(?:ов|а)?))(?=$|[\s,.)])/gi,
        },
        {
            k: 'цвет',
            rx: /(?:^|[\s,(])(бел(?:ый|ая|ое|ые)|черн(?:ый|ая|ое|ые)|чёрн(?:ый|ая|ое|ые)|син(?:ий|яя|ее|ие)|голуб(?:ой|ая|ое|ые)|зелен(?:ый|ая|ое|ые)|зелён(?:ый|ая|ое|ые)|красн(?:ый|ая|ое|ые)|розов(?:ый|ая|ое|ые)|желт(?:ый|ая|ое|ые)|жёлт(?:ый|ая|ое|ые)|оранжев(?:ый|ая|ое|ые)|фиолетов(?:ый|ая|ое|ые)|сер(?:ый|ая|ое|ые)|коричнев(?:ый|ая|ое|ые)|бежев(?:ый|ая|ое|ые)|прозрачн(?:ый|ая|ое|ые))(?=$|[\s,.)])/gi,
        },
    ];

    for (const rule of rules) {
        working = working.replace(rule.rx, (match) => {
            const cleanMatch = String(match || '')
                .replace(/^[\s,(]+|[\s,.)]+$/g, '')
                .replace(/(?:^|\s)от\s+\d+\s*(?:г\/кв\.?\s*м|г\/м2|гр\/м2)(?=$|[\s,.)])/gi, ' ')
                .replace(/\s{2,}/g, ' ')
                .trim();
            if (cleanMatch) {
                extracted.push(cleanMatch);
                kindsSet.add(rule.k);
            }
            return ' ';
        });
    }

    // Убираем оставшиеся хвосты плотности типа «от 200г/м2», пустые скобки, лишнюю пунктуацию
    const baseTitle = working
        .replace(/(?:^|\s)от\s+\d+\s*(?:г\/кв\.?\s*м|г\/м2|гр\/м2)(?=$|[\s,.)])/gi, ' ')
        .replace(/\(\s*[,.;:+-]*\s*\)/g, ' ')
        .replace(/\[\s*[,.;:+-]*\s*]/g, ' ')
        .replace(/\s+[,.;:+-]+(\s|$)/g, ' ')
        .replace(/[,.;:+-]+\s*$/g, '')
        .replace(/\s{2,}/g, ' ')
        .trim();

    const words = baseTitle
        .toLowerCase()
        .replace(/ё/g, 'е')
        .replace(/[^a-zа-я0-9\s]/gi, ' ')
        .split(/\s+/)
        .filter((w) => w.length >= 2);

    // Если в названии есть точное наименование в кавычках (например: Обучающий плакат "Легкие, внутренняя сторона")
    let quotedKey = '';
    const mQuote = orig.match(/["«]([^"»]{4,120})["»]/);
    if (mQuote) {
        quotedKey = mQuote[1]
            .toLowerCase()
            .replace(/ё/g, 'е')
            .replace(/\(\s*анатомия\s+человека\s*\)/gi, ' ')
            .replace(/[^a-zа-я0-9\s]/gi, ' ')
            .split(/\s+/)
            .filter((w) => w.length >= 2)
            .join(' ');
    }

    const uniqExtracted = Array.from(new Set(extracted.filter(Boolean)));
    const variantLabel = msParenVariant || uniqExtracted.join(', ').trim();
    const kindsArr = Array.from(kindsSet);
    const variantKind =
        kindsArr.includes('размер') && kindsArr.includes('материал / исполнение')
            ? 'размер / материал'
            : kindsArr[0] || (msParenVariant ? 'модификация МС' : 'вариант');

    return {
        baseKey: words.join(' '),
        quotedKey,
        wordCount: words.length,
        baseTitle: baseTitle || orig,
        variantLabel,
        variantKind,
    };
}

/**
 * Автоматически строит полный список групп для страницы `/exports-ozon-merge.html`:
 *  1) Моно-комплекты МС (`dg_bundle_components` + коды вида `БАЗА-N`);
 *  2) Линейки товаров по названию + поставщику / бренду (размер, объём, фасовка, габариты, цвет);
 *  3) Уже объединённые на Ozon карточки (по атрибуту `9048`);
 *  4) Ручные пользовательские группы (`status = 'custom'` в `dg_ozon_merge_decisions`).
 *
 * Возвращает группы, классифицированные по 3 очередям:
 *  - `suggested` («Предложения к объединению»)
 *  - `merged` («Уже объединены на Ozon»)
 *  - `ignored` («Не объединять / Скрытые»)
 */
async function buildAutoMergeGroupsList(db, opts = {}) {
    await ensureOzonMergeTables(db);

    // 1. Загружаем все товары Ozon вместе с данными МойСклад и кэшем атрибутов 9048
    let ozonRows = [];
    try {
        const [r] = await db.query(`
            SELECT
                oz.external_id AS offer_id,
                oz.name AS ozon_name,
                oz.price AS ozon_price,
                oz.stock AS ozon_stock,
                oz.status AS ozon_status,
                oz.cabinet_url,
                oz.buyer_url,
                oz.row_json,
                m.code AS ms_code,
                m.name AS ms_name,
                m.supplier AS ms_supplier,
                m.supplier2 AS ms_supplier2,
                m.manager AS ms_manager,
                m.content_manager AS ms_content_manager,
                m.type AS ms_entity_type,
                c.product_id AS cache_product_id,
                c.description_category_id AS cache_cat_id,
                c.type_id AS cache_type_id,
                c.brand AS cache_brand,
                c.merge_key_9048 AS cache_merge_key,
                c.synced_at AS cache_synced_at
            FROM marketplace_export_rows oz
            LEFT JOIN ms_export m ON m.code = oz.external_id
            LEFT JOIN dg_ozon_merge_cards_cache c ON c.offer_id = oz.external_id
            WHERE oz.marketplace = 'ozon'
        `);
        ozonRows = r || [];
    } catch (e) {
        console.error('[ozon-merge] buildAutoMergeGroupsList query error:', e && e.message ? e.message : e);
        ozonRows = [];
    }

    // 2. Считываем решения сотрудников из dg_ozon_merge_decisions
    const decisionsBySig = new Map();
    const decisionsByKey = new Map();
    try {
        const [dRows] = await db.query(`SELECT * FROM dg_ozon_merge_decisions`);
        for (const d of dRows || []) {
            const sig = String(d.group_signature || '').trim();
            if (!sig) continue;
            let codes = [];
            let excluded = [];
            let aspectValues = {};
            try {
                codes = d.codes_json ? JSON.parse(d.codes_json) : [];
            } catch (_) {}
            try {
                excluded = d.excluded_codes_json ? JSON.parse(d.excluded_codes_json) : [];
            } catch (_) {}
            try {
                aspectValues = d.aspect_values_json ? JSON.parse(d.aspect_values_json) : {};
            } catch (_) {}
            const decObj = {
                ...d,
                codes: Array.isArray(codes) ? codes : [],
                excluded: new Set(Array.isArray(excluded) ? excluded.map((x) => String(x).trim()) : []),
                aspectValues: aspectValues && typeof aspectValues === 'object' ? aspectValues : {},
            };
            decisionsBySig.set(sig, decObj);
            const gk = String(d.group_key_9048 || '').trim();
            const mId = String(d.main_offer_id || '').trim();
            if (gk && !decisionsByKey.has(gk)) decisionsByKey.set(gk, decObj);
            if (mId && !decisionsByKey.has(mId)) decisionsByKey.set(mId, decObj);
        }
    } catch (_) {}

    // 3. Индексируем товары Ozon по offer_id
    const itemByCode = new Map();
    let cacheCount = 0;
    let with9048Count = 0;

    for (const r of ozonRows) {
        const code = String(r.offer_id || '').trim();
        if (!code) continue;
        let rowObj = {};
        if (r.row_json) {
            try {
                rowObj = JSON.parse(r.row_json);
            } catch (_) {}
        }
        const mergeKey = String(r.cache_merge_key || rowObj.merge_key_9048 || '').trim();
        const catId = Number(r.cache_cat_id || rowObj.description_category_id || 0) || 0;
        const typeId = Number(r.cache_type_id || rowObj.type_id || 0) || 0;
        const brand = String(r.cache_brand || rowObj.brand || '').trim();
        if (r.cache_synced_at || rowObj.merge_key_9048 !== undefined) cacheCount += 1;
        if (mergeKey) with9048Count += 1;

        const displayName = String(r.ozon_name || r.ms_name || '').trim();
        const supplier = String(r.ms_supplier || r.ms_supplier2 || brand || '').trim();

        itemByCode.set(code, {
            offer_id: code,
            name: displayName,
            ms_name: String(r.ms_name || '').trim(),
            ms_article: String(r.ms_article || '').trim(),
            supplier,
            manager: String(r.ms_manager || '').trim(),
            content_manager: String(r.ms_content_manager || '').trim(),
            entity_type: String(r.ms_entity_type || '').trim(),
            price: String(r.ozon_price || '').trim(),
            stock: String(r.ozon_stock ?? '').trim(),
            status: String(r.ozon_status || '').trim(),
            cabinet_url: String(r.cabinet_url || '').trim(),
            buyer_url: String(r.buyer_url || '').trim(),
            description_category_id: catId,
            type_id: typeId,
            brand,
            current_merge_key: mergeKey,
        });
    }

    const candidateGroupsMap = new Map(); // signature -> group descriptor
    const usedInBundlePair = new Set(); // `${baseCode}|${bundleCode}`

    // =========================================================================
    // ИСТОЧНИК 1: Базовый товар + его моно-комплекты из МойСклад
    // (dg_bundle_components + паттерн кодов БАЗА-2, БАЗА-5, БАЗА-10)
    // =========================================================================
    const bundleChildrenByBase = new Map(); // baseCode -> Map(childCode -> qty)

    try {
        const [bcRows] = await db.query(`
            SELECT
                bc.bundle_code,
                bc.component_code,
                bc.qty_per_bundle
            FROM dg_bundle_components bc
            INNER JOIN (
                SELECT bundle_code
                FROM dg_bundle_components
                WHERE COALESCE(is_archived, 0) = 0
                GROUP BY bundle_code
                HAVING COUNT(*) = 1
            ) mono ON mono.bundle_code = bc.bundle_code
            WHERE COALESCE(bc.is_archived, 0) = 0
        `);
        for (const r of bcRows || []) {
            const bCode = String(r.bundle_code || '').trim();
            const cCode = String(r.component_code || '').trim();
            const qty = Math.max(1, Math.round(Number(r.qty_per_bundle || 1)));
            if (!bCode || !cCode || bCode === cCode) continue;
            if (!itemByCode.has(bCode) && !itemByCode.has(cCode)) continue;
            if (!bundleChildrenByBase.has(cCode)) bundleChildrenByBase.set(cCode, new Map());
            bundleChildrenByBase.get(cCode).set(bCode, qty);
        }
    } catch (_) {}

    // Дополнительно ловим коды вида `00123-2`, `00123-5`, `00123-10` среди товаров Ozon
    for (const code of itemByCode.keys()) {
        const m = code.match(/^([A-Za-z0-9_]+)-(\d{1,4})$/);
        if (!m) continue;
        const baseCode = m[1];
        const qty = Number(m[2]);
        if (!qty || qty < 2 || qty > 5000) continue;
        if (itemByCode.has(baseCode)) {
            if (!bundleChildrenByBase.has(baseCode)) bundleChildrenByBase.set(baseCode, new Map());
            if (!bundleChildrenByBase.get(baseCode).has(code)) {
                bundleChildrenByBase.get(baseCode).set(code, qty);
            }
        }
    }

    for (const [baseCode, childrenMap] of bundleChildrenByBase.entries()) {
        const presentCodes = [];
        const autoValues = {};
        if (itemByCode.has(baseCode)) {
            presentCodes.push({ code: baseCode, qty: 1 });
            autoValues[baseCode] = '1 шт.';
        }
        for (const [childCode, qty] of childrenMap.entries()) {
            if (itemByCode.has(childCode)) {
                presentCodes.push({ code: childCode, qty });
                autoValues[childCode] = `${qty} шт.`;
            }
        }
        if (presentCodes.length < 2) continue;
        presentCodes.sort((a, b) => a.qty - b.qty || a.code.localeCompare(b.code));
        const orderedCodes = presentCodes.map((x) => x.code);
        for (const c of orderedCodes) usedInBundlePair.add(c);

        const mainItem = itemByCode.get(orderedCodes[0]);
        const sig = `bundle:${baseCode}`;
        candidateGroupsMap.set(sig, {
            signature: sig,
            kind: 'bundles',
            kind_label: 'Товар + комплекты МС (по фасовке / шт.)',
            reason_title: `Базовый товар ${baseCode} и его комплекты (${orderedCodes.length} вар.): ${mainItem ? mainItem.name.slice(0, 90) : baseCode}`,
            what_differs_label: 'Количество в упаковке (шт.)',
            recommended_aspect_hint: 'Количество в упаковке',
            main_offer_id: orderedCodes[0],
            group_key: (mainItem && mainItem.current_merge_key) || orderedCodes[0],
            codes: orderedCodes,
            auto_values: autoValues,
        });
    }

    // =========================================================================
    // ИСТОЧНИК 2А: Модификации по базовому коду МС (например, `12032` + `12032s15346`, `12032s52197`, `12032s52198`)
    // =========================================================================
    const usedInLineupCode = new Set();
    const codeFamilyBuckets = new Map(); // baseCode -> Array<item>
    for (const it of itemByCode.values()) {
        if (usedInBundlePair.has(it.offer_id)) continue;
        const mMod = String(it.offer_id || '').match(/^(\d+)(?:[sS](\d+))?$/);
        if (!mMod) continue;
        const baseCode = mMod[1];
        if (!codeFamilyBuckets.has(baseCode)) codeFamilyBuckets.set(baseCode, []);
        codeFamilyBuckets.get(baseCode).push(it);
    }

    for (const [baseCode, familyItems] of codeFamilyBuckets.entries()) {
        // Группа по коду считается валидной, если есть минимум 2 товара и хотя бы у одного суффикс `s<число>`
        if (familyItems.length < 2 || familyItems.length > 30) continue;
        const hasModSuffix = familyItems.some((x) => /^\d+[sS]\d+$/.test(x.offer_id));
        if (!hasModSuffix) continue;

        familyItems.sort((a, b) => {
            if (a.offer_id === baseCode) return -1;
            if (b.offer_id === baseCode) return 1;
            return a.offer_id.localeCompare(b.offer_id, undefined, { numeric: true });
        });

        const orderedCodes = familyItems.map((x) => x.offer_id);
        for (const c of orderedCodes) usedInLineupCode.add(c);

        const parsedList = familyItems.map((it) => ({
            item: it,
            parsed: extractModelBaseAndVariant(it.name, it.ms_name),
        }));
        const firstEntry = parsedList[0];
        const allNames = familyItems.map((x) => x.name);
        const autoValues = {};
        for (let i = 0; i < parsedList.length; i += 1) {
            const e = parsedList[i];
            autoValues[e.item.offer_id] =
                e.parsed.variantLabel ||
                suggestDistinguishingValue(e.item.name, allNames, e.parsed.variantKind, i);
        }

        const existingKey =
            familyItems
                .map((x) => x.current_merge_key)
                .find((k) => Boolean(k) && k.length <= 60 && !/[,"«»]/.test(k)) ||
            orderedCodes[0];

        const cleanTitle = (firstEntry.parsed.baseTitle || firstEntry.item.name || baseCode).slice(0, 95);
        const supLabel =
            familyItems.map((x) => x.supplier).find((s) => Boolean(s)) || '';
        const vKind = firstEntry.parsed.variantKind || 'размер / материал';

        // Сохраняем совместимость со старыми ключами решений, если по этой паре уже кликали
        const legacySig = `lineup:${orderedCodes[0]}:${firstEntry.parsed.baseKey.slice(0, 60)}`;
        const sig = decisionsBySig.has(legacySig) ? legacySig : `lineup_code:${baseCode}`;

        candidateGroupsMap.set(sig, {
            signature: sig,
            kind: 'name_variants',
            kind_label: `Линейка по коду ${baseCode} и названию (${vKind})`,
            reason_title: `Линейка одной модели (база кода ${baseCode}, ${orderedCodes.length} вар.): «${cleanTitle}»${supLabel ? ` · Поставщик: ${supLabel}` : ''}`,
            what_differs_label: `Отличие: ${vKind}`,
            recommended_aspect_hint: vKind,
            main_offer_id: orderedCodes[0],
            group_key: existingKey,
            codes: orderedCodes,
            auto_values: autoValues,
        });
    }

    // =========================================================================
    // ИСТОЧНИК 2Б: Линейки товаров одной модели по основе названия + поставщику/бренду
    // =========================================================================
    const lineupBuckets = new Map(); // bucketKey -> Array<{ item, parsed }>
    for (const it of itemByCode.values()) {
        // Не дублируем комплекты и уже собранные семейства модификаций `БАЗАsМОД`
        if (usedInBundlePair.has(it.offer_id) || usedInLineupCode.has(it.offer_id)) continue;

        const parsed = extractModelBaseAndVariant(it.name, it.ms_name);
        if (!parsed.baseKey || parsed.wordCount < 3 || !parsed.variantLabel) continue;

        const supKey = (it.supplier || it.brand || 'nosup').toLowerCase().trim();
        const catKey = it.description_category_id ? `${it.description_category_id}:${it.type_id}` : 'nocat';
        const stemKey = parsed.quotedKey && parsed.quotedKey.length >= 5 ? `q:${parsed.quotedKey}` : parsed.baseKey;
        const bucketKey = `${supKey}||${catKey}||${stemKey}`;
        if (!lineupBuckets.has(bucketKey)) lineupBuckets.set(bucketKey, []);
        lineupBuckets.get(bucketKey).push({ item: it, parsed });
    }

    for (const [, entries] of lineupBuckets.entries()) {
        if (entries.length < 2 || entries.length > 25) continue;
        // Проверяем, что хотя бы у 2 товаров различаются извлечённые варианты
        const distinctVariants = new Set(entries.map((e) => e.parsed.variantLabel.toLowerCase()));
        if (distinctVariants.size < 2) continue;

        entries.sort((a, b) => a.item.offer_id.localeCompare(b.item.offer_id, undefined, { numeric: true }));
        const orderedCodes = entries.map((e) => e.item.offer_id);
        const firstEntry = entries[0];
        const sig = `lineup:${orderedCodes[0]}:${firstEntry.parsed.baseKey.slice(0, 60)}`;
        const autoValues = {};
        for (const e of entries) {
            autoValues[e.item.offer_id] = e.parsed.variantLabel;
        }
        const existingKey =
            entries
                .map((e) => e.item.current_merge_key)
                .find((k) => Boolean(k) && k.length <= 60 && !/[,"«»]/.test(k)) ||
            orderedCodes[0];

        candidateGroupsMap.set(sig, {
            signature: sig,
            kind: 'name_variants',
            kind_label: `Линейка по названию (${firstEntry.parsed.variantKind})`,
            reason_title: `Линейка одной модели: «${firstEntry.parsed.baseTitle.slice(0, 95)}»${firstEntry.item.supplier ? ` · Поставщик: ${firstEntry.item.supplier}` : ''}`,
            what_differs_label: `Отличие: ${firstEntry.parsed.variantKind}`,
            recommended_aspect_hint: firstEntry.parsed.variantKind,
            main_offer_id: orderedCodes[0],
            group_key: existingKey,
            codes: orderedCodes,
            auto_values: autoValues,
        });
    }

    // =========================================================================
    // ИСТОЧНИК 3: Ручные группы, созданные сотрудником (`status = 'custom'` или с `codes_json`)
    // =========================================================================
    for (const [sig, dec] of decisionsBySig.entries()) {
        if (!candidateGroupsMap.has(sig) && dec.codes && dec.codes.length >= 2) {
            const validCodes = dec.codes.filter((c) => itemByCode.has(c));
            if (validCodes.length < 2) continue;
            const mainCode =
                dec.main_offer_id && validCodes.includes(dec.main_offer_id)
                    ? dec.main_offer_id
                    : validCodes[0];
            const mainItem = itemByCode.get(mainCode);
            candidateGroupsMap.set(sig, {
                signature: sig,
                kind: 'custom',
                kind_label: 'Своя группа (добавлена вручную)',
                reason_title:
                    dec.group_title ||
                    `Ручная группа (${validCodes.length} тов.): ${mainItem ? mainItem.name.slice(0, 85) : mainCode}`,
                what_differs_label: dec.aspect_attr_name || 'Вариант товара',
                recommended_aspect_hint: dec.aspect_attr_name || 'Вариант',
                main_offer_id: mainCode,
                group_key: dec.group_key_9048 || (mainItem && mainItem.current_merge_key) || mainCode,
                codes: validCodes,
                auto_values: dec.aspectValues || {},
            });
        }
    }

    // =========================================================================
    // ИСТОЧНИК 4: Уже объединённые на Ozon карточки (по одинаковому merge_key_9048),
    // если этот набор карточек ещё не представлен в candidateGroupsMap
    // =========================================================================
    const existingCodeSets = new Set();
    for (const g of candidateGroupsMap.values()) {
        existingCodeSets.add(g.codes.slice().sort().join('|'));
    }

    const byMergeKey9048 = new Map();
    for (const it of itemByCode.values()) {
        if (!it.current_merge_key) continue;
        const k = it.current_merge_key;
        if (!byMergeKey9048.has(k)) byMergeKey9048.set(k, []);
        byMergeKey9048.get(k).push(it);
    }
    for (const [mKey, list] of byMergeKey9048.entries()) {
        if (list.length < 2) continue;
        const sortedCodes = list.map((x) => x.offer_id).sort();
        const setKey = sortedCodes.join('|');
        if (existingCodeSets.has(setKey)) continue;
        existingCodeSets.add(setKey);

        const mainCode = sortedCodes.includes(mKey) ? mKey : sortedCodes[0];
        const sig = `ozon9048:${mKey}`;
        const orderedCodes = [mainCode, ...sortedCodes.filter((c) => c !== mainCode)];
        candidateGroupsMap.set(sig, {
            signature: sig,
            kind: 'existing_9048',
            kind_label: 'Склеено на Ozon (код 9048)',
            reason_title: `Уже объединены на Ozon под общим кодом «${mKey}»`,
            what_differs_label: 'Варианты на одной карточке Ozon',
            recommended_aspect_hint: 'Количество в упаковке / Размер',
            main_offer_id: mainCode,
            group_key: mKey,
            codes: orderedCodes,
            auto_values: {},
        });
    }

    // =========================================================================
    // Сборка итоговых карточек групп + фильтрация исключённых кодов и дедупликация
    // =========================================================================
    const allGroups = [];
    for (const rawGroup of candidateGroupsMap.values()) {
        const dec =
            decisionsBySig.get(rawGroup.signature) ||
            decisionsByKey.get(rawGroup.group_key) ||
            decisionsByKey.get(rawGroup.main_offer_id) ||
            null;
        const excludedSet = dec ? dec.excluded : new Set();

        const activeCodes = rawGroup.codes.filter(
            (c) => itemByCode.has(c) && !excludedSet.has(c)
        );
        if (activeCodes.length < 2) continue;

        const mainOfferId =
            dec && dec.main_offer_id && activeCodes.includes(dec.main_offer_id)
                ? dec.main_offer_id
                : activeCodes.includes(rawGroup.main_offer_id)
                  ? rawGroup.main_offer_id
                  : activeCodes[0];

        const allNames = activeCodes.map((c) => (itemByCode.get(c) && itemByCode.get(c).name) || '');

        const groupManagers = Array.from(
            new Set(
                activeCodes
                    .map((code) => {
                        const c = itemByCode.get(code);
                        return c && c.manager ? String(c.manager).trim() : '';
                    })
                    .filter(Boolean)
            )
        );
        const primaryGroupManager = groupManagers[0] || '';

        const items = activeCodes.map((code, idx) => {
            const card = itemByCode.get(code);
            const savedVal = dec && dec.aspectValues && dec.aspectValues[code];
            const autoVal = rawGroup.auto_values && rawGroup.auto_values[code];
            const fallbackVal = suggestDistinguishingValue(
                card.name,
                allNames,
                rawGroup.recommended_aspect_hint,
                idx
            );
            return {
                offer_id: code,
                is_main: code === mainOfferId,
                name: card.name,
                ms_name: card.ms_name,
                ms_article: card.ms_article,
                supplier: card.supplier,
                manager: card.manager || primaryGroupManager,
                content_manager: card.content_manager || '',
                entity_type: card.entity_type,
                price: card.price,
                stock: card.stock,
                status: card.status,
                cabinet_url: card.cabinet_url,
                buyer_url: card.buyer_url,
                description_category_id: card.description_category_id,
                type_id: card.type_id,
                brand: card.brand,
                current_merge_key: card.current_merge_key,
                aspect_value: savedVal || autoVal || fallbackVal,
            };
        });

        // Проверяем, объединены ли уже все товары группы под одним и тем же 9048 в Ozon
        const mergeKeysInGroup = items.map((i) => i.current_merge_key).filter(Boolean);
        const uniqMergeKeys = new Set(mergeKeysInGroup);
        const allHaveSame9048 =
            mergeKeysInGroup.length === items.length && uniqMergeKeys.size === 1;
        const someHave9048 = mergeKeysInGroup.length > 0 && !allHaveSame9048;

        let queueStatus = 'suggested';
        let problemReason = '';
        if (dec && dec.status === 'ignored') {
            queueStatus = 'ignored';
        } else if (dec && dec.status === 'failed') {
            queueStatus = 'failed';
            problemReason =
                (dec.comment && dec.comment !== 'Объединено через панель Datagon'
                    ? dec.comment
                    : '') ||
                (someHave9048
                    ? `Часть карточек группы (${mergeKeysInGroup.length} из ${items.length}) не получила общий код 9048 в Ozon. Нажмите «Проверить и повторить склейку на Ozon», чтобы увидеть точную причину.`
                    : `Ozon отклонил склейку карточек (карточки заблокированы модерацией Ozon или имеют ошибки в характеристиках). Нажмите «Проверить и повторить склейку на Ozon» для подробной диагностики.`);
        } else if (allHaveSame9048) {
            queueStatus = 'merged';
        } else if (dec && dec.status === 'merged') {
            queueStatus = 'failed';
            problemReason =
                (dec.comment && dec.comment !== 'Объединено через панель Datagon'
                    ? dec.comment
                    : '') ||
                (someHave9048
                    ? `Часть карточек группы (${mergeKeysInGroup.length} из ${items.length}) не получила общий код 9048 в Ozon. Нажмите «Проверить и повторить склейку на Ozon», чтобы увидеть точную причину.`
                    : `В Ozon у карточек группы пустой атрибут склейки 9048 (вероятно, категория товара в Ozon не поддерживает склейку вариантов 9048 или Ozon отклонил обновление). Нажмите «Проверить и повторить склейку на Ozon» для подробной диагностики.`);
        } else {
            queueStatus = 'suggested';
        }

        const effectiveKind =
            someHave9048 && rawGroup.kind !== 'existing_9048'
                ? 'partial_merged'
                : rawGroup.kind;

        const groupKey =
            (dec && dec.group_key_9048) ||
            (mergeKeysInGroup[0] || '') ||
            rawGroup.group_key ||
            mainOfferId;

        allGroups.push({
            signature: rawGroup.signature,
            queue_status: queueStatus,
            problem_reason: problemReason,
            kind: effectiveKind,
            base_kind: rawGroup.kind,
            kind_label:
                someHave9048 && queueStatus === 'suggested'
                    ? `${rawGroup.kind_label} · Доклейка к связке «${mergeKeysInGroup[0]}»`
                    : rawGroup.kind_label,
            reason_title: rawGroup.reason_title,
            what_differs_label: rawGroup.what_differs_label,
            recommended_aspect_hint: rawGroup.recommended_aspect_hint,
            main_offer_id: mainOfferId,
            group_key: groupKey,
            manager: groupManagers.join(', '),
            managers: groupManagers,
            items_count: items.length,
            merged_in_ozon_count: mergeKeysInGroup.length,
            all_merged_in_ozon: allHaveSame9048,
            partial_merged_in_ozon: someHave9048,
            excluded_count: excludedSet.size,
            updated_by_name: (dec && dec.updated_by_name) || '',
            updated_at: (dec && dec.updated_at) || null,
            comment: (dec && dec.comment) || '',
            items,
        });
    }

    // Список менеджеров товара (обязательные + найденные в каталоге МС)
    const priorityManagers = ['Назерке Койман', 'Катерина Лычковская', 'Яна Ярцева'];
    const managersSet = new Set(priorityManagers);
    for (const card of itemByCode.values()) {
        if (card.manager) managersSet.add(card.manager);
    }
    for (const g of allGroups) {
        for (const m of g.managers || []) {
            if (m) managersSet.add(m);
        }
    }
    const availableManagers = [
        ...priorityManagers,
        ...Array.from(managersSet)
            .filter((m) => !priorityManagers.includes(m))
            .sort((a, b) => a.localeCompare(b, 'ru')),
    ];

    // Фильтрация по очереди, типу, менеджеру товара и умному поиску
    const reqStatus = String(opts.status || 'suggested').trim();
    const reqKind = String(opts.kind || 'all').trim();
    const reqManager = String(opts.manager || 'all').trim();
    const searchRaw = String(opts.search || '').trim().toLowerCase();
    const searchTokens = searchRaw ? searchRaw.split(/\s+/).filter(Boolean) : [];

    function matchesNonStatusFilters(g) {
        if (reqManager && reqManager !== 'all') {
            if (reqManager === '__empty__' || reqManager === 'none') {
                if (g.managers && g.managers.length > 0) return false;
            } else {
                const needle = reqManager.toLowerCase();
                const hasMgr =
                    (g.managers || []).some((m) => String(m).toLowerCase().includes(needle)) ||
                    g.items.some((it) => String(it.manager || '').toLowerCase().includes(needle));
                if (!hasMgr) return false;
            }
        }
        if (reqKind && reqKind !== 'all') {
            if (reqKind === 'partial_merged') {
                if (!g.partial_merged_in_ozon) return false;
            } else if (g.base_kind !== reqKind && g.kind !== reqKind) {
                return false;
            }
        }
        if (searchTokens.length) {
            const hay = [
                g.signature,
                g.reason_title,
                g.kind_label,
                g.group_key,
                g.manager,
                ...g.items.map(
                    (it) =>
                        `${it.offer_id} ${it.name} ${it.ms_name} ${it.ms_article} ${it.supplier} ${it.manager} ${it.aspect_value} ${it.current_merge_key}`
                ),
            ]
                .join(' ')
                .toLowerCase();
            for (const tok of searchTokens) {
                if (!hay.includes(tok)) return false;
            }
        }
        return true;
    }

    // Счётчики по очередям (с учётом выбранного менеджера / типа / поиска)
    const counts = {
        suggested: 0,
        merged: 0,
        failed: 0,
        ignored: 0,
        by_kind: {
            all: 0,
            bundles: 0,
            name_variants: 0,
            partial_merged: 0,
            custom: 0,
        },
    };

    for (const g of allGroups) {
        if (!matchesNonStatusFilters(g)) continue;
        if (g.queue_status === 'suggested') {
            counts.suggested += 1;
            counts.by_kind.all += 1;
            if (g.base_kind === 'bundles') counts.by_kind.bundles += 1;
            if (g.base_kind === 'name_variants') counts.by_kind.name_variants += 1;
            if (g.partial_merged_in_ozon) counts.by_kind.partial_merged += 1;
            if (g.base_kind === 'custom') counts.by_kind.custom += 1;
        } else if (g.queue_status === 'merged') {
            counts.merged += 1;
        } else if (g.queue_status === 'failed') {
            counts.failed += 1;
        } else if (g.queue_status === 'ignored') {
            counts.ignored += 1;
        }
    }

    const filtered = allGroups.filter((g) => {
        if (reqStatus && reqStatus !== 'all' && g.queue_status !== reqStatus) return false;
        return matchesNonStatusFilters(g);
    });

    // Сортировка: сначала комплекты МС (самые точные), затем доклейки, затем линейки по названию
    const kindPriority = { custom: 1, bundles: 2, partial_merged: 3, name_variants: 4, existing_9048: 5 };
    filtered.sort((a, b) => {
        const pa = kindPriority[a.kind] || 9;
        const pb = kindPriority[b.kind] || 9;
        if (pa !== pb) return pa - pb;
        return a.main_offer_id.localeCompare(b.main_offer_id);
    });

    const limit = Math.min(500, Math.max(1, Number(opts.limit) || 100));
    const offset = Math.max(0, Number(opts.offset) || 0);
    const pageRows = filtered.slice(offset, offset + limit);

    return {
        success: true,
        counts,
        managers: availableManagers,
        cache_stats: {
            total_ozon_rows: itemByCode.size,
            cached_cards: cacheCount,
            cards_with_9048: with9048Count,
        },
        total: filtered.length,
        limit,
        offset,
        rows: pageRows,
    };
}

/**
 * Сохраняет решение пользователя по группе:
 *  - `action = 'ignore'` — скрыть группу («Не объединять», уходит во вкладку «Не объединять / Скрытые»);
 *  - `action = 'restore'` — вернуть группу обратно в «Предложения к объединению»;
 *  - `action = 'exclude_code'` — навсегда убрать один лишний товар из предложенной группы;
 *  - `action = 'create_custom'` — создать собственную группу по списку кодов МС.
 */
async function saveOzonMergeDecision(db, opts = {}) {
    await ensureOzonMergeTables(db);
    const action = String(opts.action || '').trim();
    const signature = String(opts.signature || '').trim();
    const actorName = String(opts.actorName || '').trim().slice(0, 190);
    const actorUserId =
        opts.actorUserId != null && Number.isFinite(Number(opts.actorUserId))
            ? Number(opts.actorUserId)
            : null;
    const comment = String(opts.comment || '').trim().slice(0, 500);

    if (action === 'create_custom') {
        const groups = parseMergeGroupsInput(opts.codes || opts.codes_text || '');
        if (!groups.length || groups[0].length < 2) {
            const err = new Error('Укажите минимум 2 кода товаров МС (через пробел или запятую)');
            err.code = 'INVALID_CODES';
            throw err;
        }
        const created = [];
        for (const codes of groups) {
            const sig = `custom:${codes[0]}:${Date.now().toString(36)}`;
            const title = String(opts.title || `Ручная группа (${codes.join(', ')})`).slice(0, 500);
            await db.query(
                `INSERT INTO dg_ozon_merge_decisions
                    (group_signature, status, group_title, group_key_9048, main_offer_id, codes_json, excluded_codes_json, updated_by_name, comment)
                 VALUES (?, 'custom', ?, ?, ?, ?, '[]', ?, ?)
                 ON DUPLICATE KEY UPDATE
                    status = 'custom',
                    codes_json = VALUES(codes_json),
                    updated_by_name = VALUES(updated_by_name),
                    updated_at = CURRENT_TIMESTAMP`,
                [sig, title, codes[0], codes[0], JSON.stringify(codes), actorName, comment]
            );
            await appendOzonMergeLog(db, {
                group_signature: sig,
                offer_id: codes.join(', '),
                action: 'create_custom',
                field: 'custom_group',
                field_label: 'Ручная группа',
                old_value: null,
                new_value: codes.join(', '),
                note: title,
                changed_by_user_id: actorUserId,
                changed_by_name: actorName,
            });
            created.push(sig);
        }
        return { success: true, action, created_signatures: created };
    }

    if (!signature) {
        const err = new Error('Не указан идентификатор группы (signature)');
        err.code = 'MISSING_SIGNATURE';
        throw err;
    }

    const [existingRows] = await db.query(
        `SELECT * FROM dg_ozon_merge_decisions WHERE group_signature = ?`,
        [signature]
    );
    const existing = (existingRows && existingRows[0]) || null;

    if (action === 'ignore') {
        const codesJson = Array.isArray(opts.codes)
            ? JSON.stringify(opts.codes)
            : (existing && existing.codes_json) || '[]';
        const title = String(opts.title || (existing && existing.group_title) || '').slice(0, 500);
        await db.query(
            `INSERT INTO dg_ozon_merge_decisions
                (group_signature, status, group_title, main_offer_id, codes_json, excluded_codes_json, updated_by_name, comment)
             VALUES (?, 'ignored', ?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE
                status = 'ignored',
                group_title = IF(VALUES(group_title) <> '', VALUES(group_title), group_title),
                updated_by_name = VALUES(updated_by_name),
                comment = VALUES(comment),
                updated_at = CURRENT_TIMESTAMP`,
            [
                signature,
                title,
                String(opts.main_offer_id || (existing && existing.main_offer_id) || ''),
                codesJson,
                (existing && existing.excluded_codes_json) || '[]',
                actorName,
                comment || 'Отмечено «Не объединять»',
            ]
        );
        await appendOzonMergeLog(db, {
            group_signature: signature,
            offer_id: Array.isArray(opts.codes)
                ? opts.codes.join(', ')
                : String(opts.main_offer_id || (existing && existing.main_offer_id) || ''),
            action: 'ignore',
            field: 'status',
            field_label: 'Статус группы',
            old_value: (existing && existing.status) || 'suggested',
            new_value: 'ignored (Не объединять)',
            note: title || comment || 'Группа скрыта в «Не объединять»',
            changed_by_user_id: actorUserId,
            changed_by_name: actorName,
        });
        return { success: true, signature, status: 'ignored' };
    }

    if (action === 'restore') {
        await db.query(
            `UPDATE dg_ozon_merge_decisions
             SET status = 'suggested', excluded_codes_json = '[]', updated_by_name = ?, updated_at = CURRENT_TIMESTAMP
             WHERE group_signature = ?`,
            [actorName, signature]
        );
        await appendOzonMergeLog(db, {
            group_signature: signature,
            offer_id: String((existing && existing.main_offer_id) || ''),
            action: 'restore',
            field: 'status',
            field_label: 'Статус группы',
            old_value: (existing && existing.status) || 'ignored',
            new_value: 'suggested (Предложения)',
            note: 'Группа возвращена в очередь предложений',
            changed_by_user_id: actorUserId,
            changed_by_name: actorName,
        });
        return { success: true, signature, status: 'suggested' };
    }

    if (action === 'exclude_code') {
        const codeToExclude = String(opts.offer_id || opts.code || '').trim();
        if (!codeToExclude) {
            const err = new Error('Не указан код товара для исключения из группы');
            err.code = 'MISSING_CODE';
            throw err;
        }
        let excluded = [];
        if (existing && existing.excluded_codes_json) {
            try {
                excluded = JSON.parse(existing.excluded_codes_json) || [];
            } catch (_) {}
        }
        if (!excluded.includes(codeToExclude)) excluded.push(codeToExclude);
        await db.query(
            `INSERT INTO dg_ozon_merge_decisions
                (group_signature, status, excluded_codes_json, updated_by_name)
             VALUES (?, 'suggested', ?, ?)
             ON DUPLICATE KEY UPDATE
                excluded_codes_json = VALUES(excluded_codes_json),
                updated_by_name = VALUES(updated_by_name),
                updated_at = CURRENT_TIMESTAMP`,
            [signature, JSON.stringify(excluded), actorName]
        );
        await appendOzonMergeLog(db, {
            group_signature: signature,
            offer_id: codeToExclude,
            action: 'exclude_code',
            field: 'excluded_codes',
            field_label: 'Состав группы',
            old_value: 'В составе группы',
            new_value: 'Исключён из группы',
            note: `Товар ${codeToExclude} убран из группы ${signature}`,
            changed_by_user_id: actorUserId,
            changed_by_name: actorName,
        });
        return { success: true, signature, excluded_codes: excluded };
    }

    const err = new Error(`Неизвестное действие: ${action}`);
    err.code = 'UNKNOWN_ACTION';
    throw err;
}

/**
 * Строит предпросмотр групп перед объединением:
 * подгружает карточки из Ozon, данные из МС, вычисляет общий код 9048,
 * проверяет совпадение категорий/брендов и предлагает вариативные атрибуты.
 */
async function previewOzonMergeGroups(creds, db, opts) {
    const logger = (opts && opts.logger) || createMarketplaceLogger('ozon-merge');
    const clientId = String(creds.clientId || '').trim();
    const apiKey = String(creds.apiKey || '').trim();
    if (!clientId || !apiKey) {
        const err = new Error('Не заданы ключи Ozon (ozon_client_id / ozon_api_key)');
        err.code = 'MISSING_CREDS';
        throw err;
    }

    const groupsRaw = parseMergeGroupsInput(opts.groups || opts.groups_text || '');
    if (!groupsRaw.length) {
        const err = new Error(
            'Укажите хотя бы одну группу (минимум 2 кода МС / offer_id в строке через запятую или пробел)'
        );
        err.code = 'EMPTY_GROUPS';
        throw err;
    }

    const allCodes = Array.from(new Set(groupsRaw.flat()));
    if (allCodes.length > 300) {
        const err = new Error('За один раз можно проверить не более 300 кодов товаров');
        err.code = 'TOO_MANY_CODES';
        throw err;
    }

    const delayMs = Math.max(
        MP_MIN_DELAY_MS.ozon || 200,
        Number((opts && opts.delayMs) ?? 350) || 350
    );

    // 1. Локальные данные из ms_export + marketplace_export_rows
    const msByCode = new Map();
    if (db && typeof db.query === 'function' && allCodes.length) {
        const placeholders = allCodes.map(() => '?').join(',');
        const [rows] = await db.query(
            `SELECT
                m.code AS code,
                m.name AS ms_name,
                oz.name AS ozon_snap_name,
                oz.cabinet_url AS ozon_cabinet_url,
                oz.buyer_url AS ozon_buyer_url
             FROM ms_export m
             LEFT JOIN marketplace_export_rows oz
               ON oz.marketplace = 'ozon' AND oz.external_id = m.code
             WHERE m.code IN (${placeholders})`,
            allCodes
        );
        for (const r of rows || []) {
            msByCode.set(String(r.code || '').trim(), r);
        }
    }

    // 2. Карточки из Ozon Seller API
    const { infoByOffer, attrByOffer } = await fetchOzonCardsBatch(
        creds,
        allCodes,
        logger,
        delayMs
    );

    // 3. Собираем предпросмотр по каждой группе
    const previewGroups = [];
    for (let gIdx = 0; gIdx < groupsRaw.length; gIdx += 1) {
        const codes = groupsRaw[gIdx];
        const mainOfferId = codes[0];
        const mainInfo = infoByOffer.get(mainOfferId) || null;
        const mainAttr = attrByOffer.get(mainOfferId) || null;

        const mainCatId = Number(
            (mainAttr && mainAttr.description_category_id) ||
                (mainInfo && mainInfo.description_category_id) ||
                0
        );
        const mainTypeId = Number(
            (mainAttr && mainAttr.type_id) || (mainInfo && mainInfo.type_id) || 0
        );

        const catAttrs =
            mainCatId && mainTypeId
                ? await fetchOzonCategoryAttributes(creds, mainCatId, mainTypeId, logger)
                : [];
        const variantAttrs = pickVariantAttributesForCategory(catAttrs);

        // Текущее значение 9048 у главной карточки
        const mainMergeAttr = mainAttr
            ? getAttrFirstValue(mainAttr.attributes, OZON_MERGE_ATTR_ID)
            : { value: '' };
        const mainBrandAttr = mainAttr
            ? getAttrFirstValue(mainAttr.attributes, OZON_BRAND_ATTR_ID)
            : { value: '' };

        // По умолчанию: если у главной карточки уже заполнен 9048 — берём его, иначе код главной карточки
        const defaultGroupKey = mainMergeAttr.value || mainOfferId;

        // Выбираем рекомендуемый вариативный атрибут категории
        let recommendedAspectAttr = variantAttrs[0] || null;
        for (const va of variantAttrs) {
            const hasFilled = codes.some((c) => {
                const at = attrByOffer.get(c);
                return at && getAttrFirstValue(at.attributes, va.id).value !== '';
            });
            if (hasFilled) {
                recommendedAspectAttr = va;
                break;
            }
        }

        const allNamesInGroup = codes.map((c) => {
            const at = attrByOffer.get(c);
            const inf = infoByOffer.get(c);
            const ms = msByCode.get(c);
            return String(
                (at && at.name) || (inf && inf.name) || (ms && ms.ms_name) || ''
            ).trim();
        });

        const items = codes.map((code, idx) => {
            const info = infoByOffer.get(code) || null;
            const attr = attrByOffer.get(code) || null;
            const ms = msByCode.get(code) || null;
            const foundInOzon = Boolean(info && attr);
            const catId = Number(
                (attr && attr.description_category_id) ||
                    (info && info.description_category_id) ||
                    0
            );
            const typeId = Number((attr && attr.type_id) || (info && info.type_id) || 0);
            const curMerge = attr
                ? getAttrFirstValue(attr.attributes, OZON_MERGE_ATTR_ID).value
                : '';
            const curBrand = attr
                ? getAttrFirstValue(attr.attributes, OZON_BRAND_ATTR_ID).value
                : '';

            const currentAspects = {};
            for (const va of variantAttrs) {
                const fv = attr ? getAttrFirstValue(attr.attributes, va.id) : { value: '', dictionary_value_id: 0 };
                currentAspects[va.id] = fv;
            }

            const recAttrId = recommendedAspectAttr ? recommendedAspectAttr.id : 0;
            const curRecVal =
                recAttrId && currentAspects[recAttrId] ? currentAspects[recAttrId].value : '';
            const curRecDictId =
                recAttrId && currentAspects[recAttrId]
                    ? currentAspects[recAttrId].dictionary_value_id
                    : 0;
            const itemName = String(
                (attr && attr.name) || (info && info.name) || (ms && ms.ms_name) || ''
            ).trim();
            const suggestedVal = suggestDistinguishingValue(
                itemName,
                allNamesInGroup,
                recommendedAspectAttr ? recommendedAspectAttr.name : '',
                idx
            );

            const categoryMismatch =
                foundInOzon && mainCatId > 0 && (catId !== mainCatId || typeId !== mainTypeId);
            const brandMismatch =
                foundInOzon &&
                Boolean(mainBrandAttr.value) &&
                curBrand !== mainBrandAttr.value;

            return {
                offer_id: code,
                is_main: idx === 0,
                found_in_ozon: foundInOzon,
                product_id: info && info.id ? Number(info.id) : attr && attr.id ? Number(attr.id) : null,
                name: itemName,
                ms_name: (ms && ms.ms_name) || '',
                ms_article: (ms && ms.ms_article) || '',
                cabinet_url:
                    (ms && ms.ozon_cabinet_url) ||
                    (info && info.id
                        ? `https://seller.ozon.ru/app/products/${info.id}/edit/general-info`
                        : ''),
                buyer_url: (ms && ms.ozon_buyer_url) || '',
                description_category_id: catId,
                type_id: typeId,
                current_merge_key: curMerge,
                current_brand: curBrand,
                category_mismatch: categoryMismatch,
                brand_mismatch: brandMismatch,
                current_aspects: currentAspects,
                aspect_value: curRecVal || suggestedVal,
                aspect_value_is_suggested: !curRecVal && Boolean(suggestedVal),
                aspect_dictionary_value_id: curRecDictId,
                suggested_value: suggestedVal,
            };
        });

        previewGroups.push({
            group_index: gIdx + 1,
            group_key: defaultGroupKey,
            main_offer_id: mainOfferId,
            main_found: Boolean(mainInfo && mainAttr),
            main_category_id: mainCatId,
            main_type_id: mainTypeId,
            main_brand: mainBrandAttr.value,
            existing_main_merge_key: mainMergeAttr.value,
            recommended_aspect_attr_id: recommendedAspectAttr ? recommendedAspectAttr.id : 0,
            recommended_aspect_attr_name: recommendedAspectAttr ? recommendedAspectAttr.name : '',
            variant_attributes: variantAttrs,
            items,
        });
    }

    return {
        success: true,
        total_groups: previewGroups.length,
        total_items: allCodes.length,
        groups: previewGroups,
    };
}

/**
 * Применяет объединение карточек в Ozon через `/v3/product/import`.
 * Если `aspect_attribute_id` не передан с фронта (режим «Объединить в 1 клик»),
 * автоматически определяет подходящий вариативный (`is_aspect`) атрибут категории главной карточки!
 */
async function applyOzonMergeGroups(creds, db, opts) {
    const t0 = Date.now();
    await ensureOzonMergeTables(db);
    const logger = (opts && opts.logger) || createMarketplaceLogger('ozon-merge');
    const clientId = String(creds.clientId || '').trim();
    const apiKey = String(creds.apiKey || '').trim();
    if (!clientId || !apiKey) {
        return {
            success: false,
            error: 'Не заданы ключи Ozon (ozon_client_id / ozon_api_key)',
            code: 'MISSING_CREDS',
        };
    }

    const inputGroups = Array.isArray(opts && opts.groups) ? opts.groups : [];
    if (!inputGroups.length) {
        return {
            success: false,
            error: 'Список групп для объединения пуст',
            code: 'EMPTY_GROUPS',
        };
    }

    const dryRun = Boolean(opts && opts.dryRun);
    const copyFromMainDefault = opts && opts.copyFromMain !== false;
    const actorName = String((opts && opts.actorName) || '').trim().slice(0, 190);
    const actorUserId =
        opts && opts.actorUserId != null && Number.isFinite(Number(opts.actorUserId))
            ? Number(opts.actorUserId)
            : null;
    const delayMs = Math.max(
        MP_MIN_DELAY_MS.ozon || 200,
        Number((opts && opts.delayMs) ?? 400) || 400
    );

    const allOfferIds = [];
    for (const g of inputGroups) {
        const items = Array.isArray(g && g.items) ? g.items : [];
        for (const it of items) {
            const oid = String((it && it.offer_id) || '').trim();
            if (oid) allOfferIds.push(oid);
        }
    }
    const uniqOfferIds = Array.from(new Set(allOfferIds));
    const { infoByOffer, attrByOffer } = await fetchOzonCardsBatch(
        creds,
        uniqOfferIds,
        logger,
        delayMs
    );

    let totalItems = 0;
    let wouldUpdate = 0;
    let msOk = 0;
    let msFailed = 0;
    let skipped = 0;
    let filled = 0;
    let corrected = 0;
    const errors = [];
    const groupsResult = [];

    for (let gIdx = 0; gIdx < inputGroups.length; gIdx += 1) {
        const g = inputGroups[gIdx] || {};
        const itemsSpec = Array.isArray(g.items) ? g.items : [];
        if (itemsSpec.length < 2) {
            skipped += itemsSpec.length;
            continue;
        }

        const mainOfferId = String(
            g.main_offer_id || (itemsSpec[0] && itemsSpec[0].offer_id) || ''
        ).trim();
        const mainInfo = infoByOffer.get(mainOfferId);
        const mainAttr = attrByOffer.get(mainOfferId);

        if (!mainInfo || !mainAttr) {
            for (const it of itemsSpec) {
                totalItems += 1;
                msFailed += 1;
                const code = String((it && it.offer_id) || '').trim();
                const msg = `Главная карточка группы (${mainOfferId}) не найдена в Ozon`;
                if (errors.length < 20) errors.push({ code, error: msg });
            }
            groupsResult.push({
                signature: g.signature || '',
                group_key: g.group_key || mainOfferId,
                main_offer_id: mainOfferId,
                success: false,
                error: `Главная карточка ${mainOfferId} не найдена в Ozon`,
            });
            continue;
        }

        const mainMergeExisting = getAttrFirstValue(mainAttr.attributes, OZON_MERGE_ATTR_ID).value;
        const groupKey = String(g.group_key || mainMergeExisting || mainOfferId).trim();
        const mainCatId = Number(
            mainAttr.description_category_id || mainInfo.description_category_id || 0
        );
        const mainTypeId = Number(mainAttr.type_id || mainInfo.type_id || 0);
        const mainDims = dimsFromOzonCard(mainAttr, mainInfo);
        const copyFromMain =
            g.copy_from_main !== undefined ? Boolean(g.copy_from_main) : copyFromMainDefault;

        // Метаданные атрибутов категории главной карточки
        const catAttrs =
            mainCatId && mainTypeId
                ? await fetchOzonCategoryAttributes(creds, mainCatId, mainTypeId, logger)
                : [];
        const catAttrById = new Map(catAttrs.map((a) => [Number(a.id), a]));
        const requiredAttrIds = new Set(
            catAttrs.filter((a) => a && a.is_required).map((a) => Number(a.id))
        );

        // Проверяем, поддерживает ли категория главной карточки в Ozon атрибут 9048 («Объединить на одной карточке»)
        if (catAttrs.length > 0 && !catAttrById.has(OZON_MERGE_ATTR_ID)) {
            const has22390 = catAttrById.has(22390);
            const noMergeMsg =
                `В категории Ozon главного товара ${mainOfferId} (category_id=${mainCatId}, type_id=${mainTypeId}) ` +
                `отсутствует атрибут 9048 («Объединить на одной карточке») и нет вариативных характеристик (is_aspect). ` +
                (has22390
                    ? `В этой категории Ozon разрешает только «Похожие товары» (22390). Чтобы объединить карточки в одну с переключателем фасовки (как 24850), смените в ЛК Ozon категорию/тип на поддерживающую варианты (например, category_id=17028986, type_id=971892284).`
                    : `Смените в ЛК Ozon категорию/тип товара на поддерживающую варианты (9048).`);
            const codesList = [];
            const aspectValuesMap = {};
            for (const it of itemsSpec) {
                totalItems += 1;
                msFailed += 1;
                const code = String((it && it.offer_id) || '').trim();
                if (code) {
                    codesList.push(code);
                    aspectValuesMap[code] = String(it.aspect_value || '').trim();
                }
                if (errors.length < 20) errors.push({ code, error: noMergeMsg });
                if (db && typeof db.query === 'function' && code) {
                    const actualAttr = attrByOffer.get(code);
                    const actualMerge = actualAttr
                        ? getAttrFirstValue(actualAttr.attributes, OZON_MERGE_ATTR_ID).value
                        : '';
                    try {
                        await db.query(
                            `INSERT INTO dg_ozon_merge_cards_cache
                                (offer_id, description_category_id, type_id, merge_key_9048, synced_at)
                             VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
                             ON DUPLICATE KEY UPDATE
                                description_category_id = VALUES(description_category_id),
                                type_id = VALUES(type_id),
                                merge_key_9048 = VALUES(merge_key_9048),
                                synced_at = CURRENT_TIMESTAMP`,
                            [code, mainCatId, mainTypeId, actualMerge]
                        );
                    } catch (_) {}
                }
            }
            if (!dryRun && db && typeof db.query === 'function') {
                const sig = String(g.signature || `merged:${groupKey}`).trim();
                try {
                    await db.query(
                        `INSERT INTO dg_ozon_merge_decisions
                            (group_signature, status, group_key_9048, main_offer_id, codes_json, aspect_attr_id, aspect_values_json, updated_by_name, comment)
                         VALUES (?, 'failed', ?, ?, ?, 0, ?, ?, ?)
                         ON DUPLICATE KEY UPDATE
                            status = 'failed',
                            group_key_9048 = VALUES(group_key_9048),
                            main_offer_id = VALUES(main_offer_id),
                            codes_json = VALUES(codes_json),
                            aspect_values_json = VALUES(aspect_values_json),
                            updated_by_name = VALUES(updated_by_name),
                            comment = VALUES(comment),
                            updated_at = CURRENT_TIMESTAMP`,
                        [
                            sig,
                            groupKey,
                            mainOfferId,
                            JSON.stringify(codesList),
                            JSON.stringify(aspectValuesMap),
                            actorName,
                            noMergeMsg.slice(0, 500),
                        ]
                    );
                    for (const code of codesList) {
                        await appendOzonMergeLog(db, {
                            group_signature: sig,
                            offer_id: code,
                            action: 'merge_failed',
                            field: 'merge_key_9048',
                            field_label: 'Склейка на Ozon (9048)',
                            old_value: 'Не склеен',
                            new_value: 'Отказ Ozon',
                            note: noMergeMsg.slice(0, 500),
                            changed_by_user_id: actorUserId,
                            changed_by_name: actorName,
                        });
                    }
                } catch (_) {}
            }
            groupsResult.push({
                signature: g.signature || '',
                group_key: groupKey,
                main_offer_id: mainOfferId,
                success: false,
                error: noMergeMsg,
            });
            continue;
        }

        // Автовыбор вариативного атрибута категории, если пользователь нажал «Объединить в 1 клик»
        let aspectAttrId = Number(g.aspect_attribute_id || 0) || 0;
        if (!aspectAttrId && catAttrs.length) {
            const variantAttrs = pickVariantAttributesForCategory(catAttrs);
            const hint = String(g.recommended_aspect_hint || '').toLowerCase();
            if (hint.includes('количество') || hint.includes('упаков')) {
                const hit = variantAttrs.find((va) => /количество|упаков|фасов|штук/i.test(va.name));
                if (hit) aspectAttrId = hit.id;
            } else if (hint.includes('размер') || hint.includes('габарит') || hint.includes('калибр') || hint.includes('формат')) {
                const hit = variantAttrs.find((va) => /размер|формат|габарит|длина|ширина|диаметр/i.test(va.name));
                if (hit) aspectAttrId = hit.id;
            } else if (hint.includes('материал')) {
                const hit = variantAttrs.find((va) => /материал|формат|размер/i.test(va.name));
                if (hit) aspectAttrId = hit.id;
            } else if (hint.includes('объём') || hint.includes('объем') || hint.includes('вес')) {
                const hit = variantAttrs.find((va) => /объем|объём|вес|мл|грамм/i.test(va.name));
                if (hit) aspectAttrId = hit.id;
            } else if (hint.includes('цвет')) {
                const hit = variantAttrs.find((va) => /цвет/i.test(va.name));
                if (hit) aspectAttrId = hit.id;
            }
            if (!aspectAttrId && variantAttrs.length) {
                // Если первый атрибут в списке — «Цвет товара» (10096), а в подсказке нет слова «цвет» и в категории есть Формат/Размер/Материал —
                // проверяем, не одинаковый ли цвет у всех карточек группы
                const firstVa = variantAttrs[0];
                if (
                    firstVa &&
                    firstVa.id === 10096 &&
                    !hint.includes('цвет') &&
                    variantAttrs.length > 1
                ) {
                    const distinctColors = new Set(
                        itemsSpec
                            .map((it) => {
                                const at = attrByOffer.get(String(it.offer_id || '').trim());
                                return at ? getAttrFirstValue(at.attributes, 10096).value.toLowerCase() : '';
                            })
                            .filter(Boolean)
                    );
                    const altVa = variantAttrs.find((va) => /формат|размер|материал|количество|объем|вес/i.test(va.name));
                    if (distinctColors.size <= 1 && altVa) {
                        aspectAttrId = altVa.id;
                    } else {
                        aspectAttrId = firstVa.id;
                    }
                } else {
                    aspectAttrId = firstVa.id;
                }
            }
        }
        const aspectAttrMeta = aspectAttrId ? catAttrById.get(aspectAttrId) || null : null;

        const importItems = [];
        const groupItemMeta = [];

        for (const it of itemsSpec) {
            totalItems += 1;
            const offerId = String((it && it.offer_id) || '').trim();
            const info = infoByOffer.get(offerId);
            const attr = attrByOffer.get(offerId);

            if (!info || !attr) {
                msFailed += 1;
                const msg = `Товар ${offerId} не найден в Ozon`;
                if (errors.length < 20) errors.push({ code: offerId, error: msg });
                continue;
            }

            try {
                const dims = dimsFromOzonCard(attr, info) || mainDims;
                if (!dims) {
                    throw new Error('У карточки Ozon нет габаритов/веса');
                }
                const prevMergeVal = getAttrFirstValue(attr.attributes, OZON_MERGE_ATTR_ID).value;
                const itemPayload = buildImportItem(attr, info, dims);

                // Авто-нормализация габаритов под лимиты типа товара Ozon (например, 670x270x250 мм для катетеров)
                // и авто-очистка пустых строк первого столбца raTable в Rich-контенте (11254),
                // из-за которых модерация Ozon отклоняет склейку с DESCRIPTION_DECLINE / INCORRECT_DIMENSION
                if (itemPayload.dimension_unit === 'mm') {
                    const d = Number(itemPayload.depth) || 0;
                    const w = Number(itemPayload.width) || 0;
                    const h = Number(itemPayload.height) || 0;
                    if (w > 270 && d <= 670 && h <= 250) {
                        itemPayload.width = 240;
                    }
                    if (d > 670) itemPayload.depth = 300;
                    if (h > 250) itemPayload.height = 60;
                }
                if (Array.isArray(itemPayload.attributes)) {
                    for (const a of itemPayload.attributes) {
                        if (Number(a.id ?? a.attribute_id) === 11254 && Array.isArray(a.values) && a.values[0]?.value) {
                            try {
                                const rObj = JSON.parse(String(a.values[0].value));
                                let changedRich = false;
                                for (const w of rObj.content || []) {
                                    if (w && w.widgetName === 'raTable' && w.table && Array.isArray(w.table.body)) {
                                        const beforeLen = w.table.body.length;
                                        w.table.body = w.table.body.filter((row) => {
                                            if (!Array.isArray(row) || !row[0]) return true;
                                            if (Array.isArray(row[0])) {
                                                return row[0].some((cell) => String(cell || '').trim().length > 0);
                                            }
                                            return true;
                                        });
                                        if (w.table.body.length !== beforeLen) changedRich = true;
                                    }
                                }
                                if (changedRich) {
                                    a.values[0].value = JSON.stringify(rObj);
                                }
                            } catch (_) {}
                        }
                    }
                }

                const catChanged =
                    itemPayload.description_category_id !== mainCatId ||
                    itemPayload.type_id !== mainTypeId;
                if (copyFromMain && mainCatId && mainTypeId) {
                    itemPayload.description_category_id = mainCatId;
                    itemPayload.type_id = mainTypeId;

                    const mainBrand = getAttrFirstValue(mainAttr.attributes, OZON_BRAND_ATTR_ID);
                    if (mainBrand.value || mainBrand.dictionary_value_id) {
                        itemPayload.attributes = upsertImportAttribute(
                            itemPayload.attributes,
                            OZON_BRAND_ATTR_ID,
                            mainBrand.value,
                            mainBrand.dictionary_value_id
                        );
                    }

                    if (catChanged && Array.isArray(mainAttr.attributes)) {
                        const existingIds = new Set(
                            (itemPayload.attributes || []).map((a) => Number(a.id ?? a.attribute_id))
                        );
                        for (const ma of mainAttr.attributes) {
                            const mid = Number(ma && (ma.id ?? ma.attribute_id));
                            if (
                                mid &&
                                requiredAttrIds.has(mid) &&
                                !existingIds.has(mid) &&
                                mid !== OZON_MERGE_ATTR_ID &&
                                mid !== aspectAttrId
                            ) {
                                itemPayload.attributes.push({
                                    id: mid,
                                    complex_id: Number(ma.complex_id || 0),
                                    values: Array.isArray(ma.values) ? ma.values : [],
                                });
                            }
                        }
                    }
                }

                // 1) Проставляем 9048 («Объединить на одной карточке»)
                itemPayload.attributes = upsertImportAttribute(
                    itemPayload.attributes,
                    OZON_MERGE_ATTR_ID,
                    groupKey,
                    0
                );

                // 2) Проставляем вариативный атрибут
                let aspectVal = String(it.aspect_value != null ? it.aspect_value : '').trim();
                if (
                    aspectAttrMeta &&
                    /количество|штук/i.test(aspectAttrMeta.name) &&
                    /^\d+\s*шт\.?$/i.test(aspectVal)
                ) {
                    aspectVal = aspectVal.replace(/\s*шт\.?$/i, '').trim();
                }
                let aspectDictId = Number(it.aspect_dictionary_value_id || 0) || 0;

                if (aspectAttrId > 0 && aspectVal) {
                    const curFv = getAttrFirstValue(attr.attributes, aspectAttrId);
                    if (
                        !aspectDictId &&
                        curFv.dictionary_value_id > 0 &&
                        curFv.value.toLowerCase() === aspectVal.toLowerCase()
                    ) {
                        aspectDictId = curFv.dictionary_value_id;
                    }
                    if (
                        !aspectDictId &&
                        aspectAttrMeta &&
                        aspectAttrMeta.dictionary_id > 0 &&
                        !dryRun
                    ) {
                        const dictHits = await searchOzonAttributeDictionaryValues(
                            creds,
                            {
                                descriptionCategoryId: mainCatId,
                                typeId: mainTypeId,
                                attributeId: aspectAttrId,
                                query: aspectVal,
                                limit: 15,
                            },
                            logger
                        );
                        const exact =
                            dictHits.find(
                                (d) =>
                                    String((d && d.value) || '')
                                        .trim()
                                        .toLowerCase() === aspectVal.toLowerCase()
                            ) || null;
                        if (exact && Number(exact.id) > 0) {
                            aspectDictId = Number(exact.id);
                        }
                    }

                    // Если атрибут справочный (dictionary_id > 0), а введённое значение не совпало со справочником
                    // (например, «глянцевая фотобумага, размер A2+» для справочника «Цвет товара»),
                    // не перезаписываем существующее словарное значение карточки, чтобы не сломать импорт Ozon
                    if (aspectAttrMeta && aspectAttrMeta.dictionary_id > 0 && !aspectDictId) {
                        if (curFv.dictionary_value_id > 0) {
                            aspectVal = curFv.value;
                            aspectDictId = curFv.dictionary_value_id;
                        } else {
                            aspectVal = '';
                        }
                    }

                    if (aspectVal || aspectDictId > 0) {
                        itemPayload.attributes = upsertImportAttribute(
                            itemPayload.attributes,
                            aspectAttrId,
                            aspectVal,
                            aspectDictId
                        );
                    }
                }

                wouldUpdate += 1;
                importItems.push(itemPayload);
                groupItemMeta.push({
                    offer_id: offerId,
                    prev_merge_key: prevMergeVal,
                    new_merge_key: groupKey,
                    aspect_value: aspectVal,
                });
            } catch (eBuild) {
                msFailed += 1;
                const msg = eBuild && eBuild.message ? eBuild.message : String(eBuild);
                if (errors.length < 20) errors.push({ code: offerId, error: msg });
            }
        }

        if (!importItems.length) continue;

        if (dryRun) {
            for (const m of groupItemMeta) {
                if (!m.prev_merge_key) filled += 1;
                else if (m.prev_merge_key !== m.new_merge_key) corrected += 1;
                else filled += 1;
            }
            groupsResult.push({
                signature: g.signature || '',
                group_key: groupKey,
                main_offer_id: mainOfferId,
                dry_run: true,
                items_count: importItems.length,
                success: true,
            });
            continue;
        }

        // Отправляем группу батчем в POST /v3/product/import
        try {
            if (delayMs) await sleep(delayMs);
            const headers = ozonHeaders(creds);
            const importRes = await axiosWithMarketplaceRateLimit(
                {
                    method: 'POST',
                    url: 'https://api-seller.ozon.ru/v3/product/import',
                    data: { items: importItems },
                    headers,
                    timeout: 120000,
                },
                logger,
                { maxAttempts: 4 }
            );
            const taskId = Number(
                importRes.data && importRes.data.result && importRes.data.result.task_id
            );
            let taskItemsByOffer = new Map();
            if (Number.isFinite(taskId) && taskId > 0) {
                const taskInfo = await waitOzonImportTask(creds, taskId, logger, delayMs);
                const tItems = (taskInfo && taskInfo.result && taskInfo.result.items) || [];
                for (const ti of tItems) {
                    const oid = String(ti && ti.offer_id != null ? ti.offer_id : '').trim();
                    if (oid) taskItemsByOffer.set(oid, ti);
                }
            }

            // Пост-проверка фактического сохранения 9048 в Ozon через /v4/product/info/attributes
            // Ozon реплицирует атрибуты из очереди импорта в /v4/product/info/attributes за 1–5 секунд,
            // поэтому делаем до 4 попыток опроса с паузой, чтобы не получить ложное срабатывание со старым значением.
            const verifiedMergeByOffer = new Map();
            const targetOffers = groupItemMeta.map((m) => m.offer_id);
            for (let vAttempt = 1; vAttempt <= 4; vAttempt += 1) {
                await sleep(vAttempt === 1 ? Math.max(delayMs, 1200) : 1500);
                try {
                    const verifyRes = await axiosWithMarketplaceRateLimit(
                        {
                            method: 'POST',
                            url: 'https://api-seller.ozon.ru/v4/product/info/attributes',
                            data: {
                                filter: {
                                    offer_id: targetOffers,
                                    visibility: 'ALL',
                                },
                                limit: Math.max(targetOffers.length, 50),
                            },
                            headers,
                            timeout: 60000,
                        },
                        logger,
                        { maxAttempts: 3 }
                    );
                    for (const vr of (verifyRes.data && verifyRes.data.result) || []) {
                        const oid = String(vr && vr.offer_id != null ? vr.offer_id : '').trim();
                        if (oid) {
                            verifiedMergeByOffer.set(
                                oid,
                                getAttrFirstValue(vr.attributes, OZON_MERGE_ATTR_ID).value
                            );
                        }
                    }
                    const allMatched = targetOffers.every((oid) => {
                        const ti = taskItemsByOffer.get(oid);
                        const st = ti ? String(ti.status || '') : 'submitted';
                        if (/fail|error|rejected|skipped/i.test(st)) return true;
                        return verifiedMergeByOffer.get(oid) === groupKey;
                    });
                    if (allMatched) break;
                } catch (_) {}
            }

            let groupFailedCount = 0;
            const aspectValuesMap = {};
            for (const m of groupItemMeta) {
                aspectValuesMap[m.offer_id] = m.aspect_value;
                const ti = taskItemsByOffer.get(m.offer_id);
                const st = ti ? String(ti.status || '') : 'submitted';
                const itemErrs =
                    ti && Array.isArray(ti.errors) && ti.errors.length
                        ? ti.errors
                              .map((e) => (e && (e.message || e.description || e.code)) || String(e))
                              .filter(Boolean)
                              .join('; ')
                        : '';
                const actualSavedMerge = verifiedMergeByOffer.has(m.offer_id)
                    ? verifiedMergeByOffer.get(m.offer_id)
                    : null;
                const cardInfo = infoByOffer.get(m.offer_id) || null;
                const cardModDeclined =
                    cardInfo &&
                    cardInfo.statuses &&
                    (cardInfo.statuses.moderate_status === 'declined' ||
                        cardInfo.statuses.status === 'unmatched' ||
                        cardInfo.statuses.status_failed === 'declined');
                const cardBlockingErrors =
                    cardInfo && Array.isArray(cardInfo.errors)
                        ? cardInfo.errors
                              .filter(
                                  (e) =>
                                      e &&
                                      (e.level === 'ERROR_LEVEL_ERROR' ||
                                          e.state === 'declined' ||
                                          /DECLINE|INCORRECT|DUPLICATE|WITHOUT_MERGER/i.test(
                                              String(e.code || '')
                                          ))
                              )
                              .map((e) => {
                                  const attrTitle =
                                      (e.texts && e.texts.attribute_name) ||
                                      (e.attribute_id ? `атрибут ${e.attribute_id}` : '') ||
                                      e.field ||
                                      '';
                                  const desc =
                                      (e.texts && (e.texts.message || e.texts.description)) ||
                                      e.code ||
                                      '';
                                  return `${attrTitle ? `Поле «${attrTitle}»` : e.code || 'Ошибка Ozon'}: ${desc}`;
                              })
                              .filter(Boolean)
                              .join(' | ')
                        : '';

                const skippedOrRejected =
                    /fail|error|rejected|skipped/i.test(st) ||
                    Boolean(itemErrs) ||
                    (cardModDeclined && Boolean(cardBlockingErrors)) ||
                    (actualSavedMerge !== null &&
                        actualSavedMerge !== groupKey &&
                        // Если Ozon подтвердил задачу (status: imported / updated) и ошибок нет,
                        // а /v4/product/info/attributes ещё отдаёт точно такое же старое значение prev_merge_key —
                        // это просто задержка репликации чтения Ozon (eventual consistency), а не отказ!
                        !(
                            /imported|updated|processed|submitted/i.test(st) &&
                            actualSavedMerge === (m.prev_merge_key || '')
                        ));

                if (skippedOrRejected) {
                    msFailed += 1;
                    groupFailedCount += 1;
                    let reasonMsg = itemErrs;
                    if (!reasonMsg) {
                        if (cardBlockingErrors) {
                            reasonMsg = `Отказ модерации Ozon (склейка заблокирована до исправления карточки в ЛК Ozon) — ${cardBlockingErrors}`;
                        } else if (/skipped/i.test(st)) {
                            reasonMsg = `Ozon отклонил обновление карточки (status: skipped — карточка заблокирована модерацией или в ней не заполнены обязательные поля в ЛК Ozon). Откройте карточку по ссылке «ЛК Ozon ↗» и исправьте ошибки модерации.`;
                        } else if (
                            actualSavedMerge !== null &&
                            actualSavedMerge !== groupKey &&
                            actualSavedMerge.startsWith(`${m.offer_id}_`)
                        ) {
                            reasonMsg =
                                `Ozon автоматически разъединил карточку (присвоил "${actualSavedMerge}" вместо "${groupKey}"), ` +
                                `потому что в этой категории Ozon у карточек совпадают вариативные характеристики (например, одинаковый «Цвет товара»), ` +
                                `а размер/формат/материал в этой категории Ozon не являются вариативными (is_aspect).`;
                        } else if (actualSavedMerge !== null && actualSavedMerge !== groupKey) {
                            reasonMsg = `Ozon не сохранил код склейки 9048="${groupKey}" (текущее значение в Ozon: "${actualSavedMerge || 'пусто'}")`;
                        } else {
                            reasonMsg = `Ozon отклонил обновление (статус задачи Ozon: ${st})`;
                        }
                    }
                    if (errors.length < 20) {
                        errors.push({
                            code: m.offer_id,
                            error: reasonMsg,
                        });
                    }
                    if (db && typeof db.query === 'function' && actualSavedMerge !== null) {
                        try {
                            await db.query(
                                `INSERT INTO dg_ozon_merge_cards_cache
                                    (offer_id, description_category_id, type_id, merge_key_9048, synced_at)
                                 VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
                                 ON DUPLICATE KEY UPDATE
                                    merge_key_9048 = VALUES(merge_key_9048),
                                    synced_at = CURRENT_TIMESTAMP`,
                                [m.offer_id, mainCatId, mainTypeId, actualSavedMerge]
                            );
                        } catch (_) {}
                    }
                } else {
                    msOk += 1;
                    if (!m.prev_merge_key) filled += 1;
                    else if (m.prev_merge_key !== m.new_merge_key) corrected += 1;
                    else filled += 1;

                    if (db && typeof db.query === 'function') {
                        try {
                            await db.query(
                                `UPDATE marketplace_export_rows
                                 SET updated_label = ?, updated_at = CURRENT_TIMESTAMP
                                 WHERE marketplace = 'ozon' AND external_id = ?`,
                                [`Ozon склейка: ${groupKey}`.slice(0, 64), m.offer_id]
                            );
                            await db.query(
                                `INSERT INTO dg_ozon_merge_cards_cache
                                    (offer_id, description_category_id, type_id, merge_key_9048, synced_at)
                                 VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
                                 ON DUPLICATE KEY UPDATE
                                    description_category_id = VALUES(description_category_id),
                                    type_id = VALUES(type_id),
                                    merge_key_9048 = VALUES(merge_key_9048),
                                    synced_at = CURRENT_TIMESTAMP`,
                                [m.offer_id, mainCatId, mainTypeId, groupKey]
                            );
                        } catch (_) {}
                    }
                }
            }

            if (db && typeof db.query === 'function') {
                const sig = String(g.signature || `merged:${groupKey}`).trim();
                const codesList = groupItemMeta.map((m) => m.offer_id);
                const decStatus = groupFailedCount === 0 ? 'merged' : 'failed';
                const firstErrObj = errors.find((e) =>
                    codesList.includes(String(e && e.code).trim())
                );
                const decComment =
                    groupFailedCount === 0
                        ? 'Объединено через панель Datagon'
                        : String(
                              (firstErrObj && `${firstErrObj.code}: ${firstErrObj.error}`) ||
                                  `Ошибка склейки на Ozon (${groupFailedCount} из ${codesList.length} тов.)`
                          ).slice(0, 500);
                try {
                    await db.query(
                        `INSERT INTO dg_ozon_merge_decisions
                            (group_signature, status, group_key_9048, main_offer_id, codes_json, aspect_attr_id, aspect_values_json, updated_by_name, comment)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                         ON DUPLICATE KEY UPDATE
                            status = VALUES(status),
                            group_key_9048 = VALUES(group_key_9048),
                            main_offer_id = VALUES(main_offer_id),
                            codes_json = VALUES(codes_json),
                            aspect_attr_id = VALUES(aspect_attr_id),
                            aspect_values_json = VALUES(aspect_values_json),
                            updated_by_name = VALUES(updated_by_name),
                            comment = VALUES(comment),
                            updated_at = CURRENT_TIMESTAMP`,
                        [
                            sig,
                            decStatus,
                            groupKey,
                            mainOfferId,
                            JSON.stringify(codesList),
                            aspectAttrId,
                            JSON.stringify(aspectValuesMap),
                            actorName,
                            decComment,
                        ]
                    );
                    for (const m of groupItemMeta) {
                        const itemErr = errors.find((e) => String(e && e.code).trim() === m.offer_id);
                        const itemFailed = Boolean(itemErr);
                        const asp = m.aspect_value ? ` (${m.aspect_value})` : '';
                        await appendOzonMergeLog(db, {
                            group_signature: sig,
                            offer_id: m.offer_id,
                            action: itemFailed ? 'merge_failed' : 'merge',
                            field: 'merge_key_9048',
                            field_label: 'Склейка на Ozon (9048)',
                            old_value: m.prev_merge_key || 'Не склеен',
                            new_value: itemFailed ? 'Отказ Ozon' : `${groupKey}${asp}`,
                            note: itemFailed
                                ? itemErr.error
                                : `Группа ${sig}, главная карточка: ${mainOfferId}`,
                            changed_by_user_id: actorUserId,
                            changed_by_name: actorName,
                        });
                    }
                } catch (_) {}
            }

            groupsResult.push({
                signature: g.signature || '',
                group_key: groupKey,
                main_offer_id: mainOfferId,
                task_id: Number.isFinite(taskId) ? taskId : undefined,
                items_count: importItems.length,
                failed_count: groupFailedCount,
                success: groupFailedCount === 0,
            });
        } catch (eImp) {
            const ozonMsg =
                eImp && eImp.response && eImp.response.data
                    ? JSON.stringify(eImp.response.data).slice(0, 400)
                    : '';
            const fullErr =
                (eImp && eImp.message ? eImp.message : String(eImp)) +
                (ozonMsg ? ' | ' + ozonMsg : '');
            for (const m of groupItemMeta) {
                msFailed += 1;
                if (errors.length < 20) errors.push({ code: m.offer_id, error: fullErr });
            }
            groupsResult.push({
                signature: g.signature || '',
                group_key: groupKey,
                main_offer_id: mainOfferId,
                items_count: importItems.length,
                success: false,
                error: fullErr,
            });
        }
    }

    return {
        success: msFailed === 0,
        dry_run: dryRun,
        total_groups: inputGroups.length,
        total: totalItems,
        to_update: wouldUpdate,
        would_update: wouldUpdate,
        filled,
        corrected,
        skipped,
        no_uuid: 0,
        ms_ok: dryRun ? 0 : msOk,
        ms_failed: msFailed,
        errors,
        groups_result: groupsResult,
        duration_sec: Number(((Date.now() - t0) / 1000).toFixed(2)),
    };
}

/**
 * Разъединяет карточки на Ozon (очищает атрибут 9048 через `/v3/product/import`
 * и переводит группу обратно в очередь предложений).
 */
async function unmergeOzonGroup(creds, db, opts = {}) {
    const t0 = Date.now();
    await ensureOzonMergeTables(db);
    const logger = (opts && opts.logger) || createMarketplaceLogger('ozon-unmerge');
    const actorName = String((opts && opts.actorName) || '').trim().slice(0, 190);
    const actorUserId =
        opts && opts.actorUserId != null && Number.isFinite(Number(opts.actorUserId))
            ? Number(opts.actorUserId)
            : null;
    const clientId = String(creds.clientId || '').trim();
    const apiKey = String(creds.apiKey || '').trim();
    if (!clientId || !apiKey) {
        return {
            success: false,
            error: 'Не заданы ключи Ozon (ozon_client_id / ozon_api_key)',
            code: 'MISSING_CREDS',
        };
    }

    const offerIds = Array.from(
        new Set(
            (Array.isArray(opts.offer_ids) ? opts.offer_ids : [])
                .map((x) => String(x || '').trim())
                .filter(Boolean)
        )
    );
    if (!offerIds.length) {
        return {
            success: false,
            error: 'Не переданы коды товаров для разъединения',
            code: 'EMPTY_CODES',
        };
    }

    const delayMs = Math.max(
        MP_MIN_DELAY_MS.ozon || 200,
        Number((opts && opts.delayMs) ?? 350) || 350
    );
    const { infoByOffer, attrByOffer } = await fetchOzonCardsBatch(
        creds,
        offerIds,
        logger,
        delayMs
    );

    const importItems = [];
    const prevMergeByOffer = new Map();
    const errors = [];
    let msOk = 0;
    let msFailed = 0;

    for (const offerId of offerIds) {
        const info = infoByOffer.get(offerId);
        const attr = attrByOffer.get(offerId);
        if (!info || !attr) {
            msFailed += 1;
            errors.push({ code: offerId, error: `Товар ${offerId} не найден в Ozon` });
            continue;
        }
        const dims = dimsFromOzonCard(attr, info);
        if (!dims) {
            msFailed += 1;
            errors.push({ code: offerId, error: 'У карточки нет габаритов/веса' });
            continue;
        }
        const prevMergeVal = getAttrFirstValue(attr.attributes, OZON_MERGE_ATTR_ID).value;
        prevMergeByOffer.set(offerId, prevMergeVal);
        const itemPayload = buildImportItem(attr, info, dims);
        itemPayload.attributes = removeImportAttribute(itemPayload.attributes, OZON_MERGE_ATTR_ID);
        importItems.push(itemPayload);
    }

    const sig = String(opts.signature || '').trim();

    if (importItems.length) {
        const headers = ozonHeaders(creds);
        const importRes = await axiosWithMarketplaceRateLimit(
            {
                method: 'POST',
                url: 'https://api-seller.ozon.ru/v3/product/import',
                data: { items: importItems },
                headers,
                timeout: 120000,
            },
            logger,
            { maxAttempts: 4 }
        );
        const taskId = Number(
            importRes.data && importRes.data.result && importRes.data.result.task_id
        );
        if (Number.isFinite(taskId) && taskId > 0) {
            await waitOzonImportTask(creds, taskId, logger, delayMs);
        }
        msOk = importItems.length;

        for (const it of importItems) {
            try {
                await db.query(
                    `UPDATE dg_ozon_merge_cards_cache
                     SET merge_key_9048 = '', synced_at = CURRENT_TIMESTAMP
                     WHERE offer_id = ?`,
                    [it.offer_id]
                );
                await appendOzonMergeLog(db, {
                    group_signature: sig || `unmerged:${it.offer_id}`,
                    offer_id: it.offer_id,
                    action: 'unmerge',
                    field: 'merge_key_9048',
                    field_label: 'Расклейка на Ozon (9048)',
                    old_value: prevMergeByOffer.get(it.offer_id) || 'Склеен',
                    new_value: 'Не склеен (9048 очищен)',
                    note: `Разъединено в Ozon (${offerIds.join(', ')})`,
                    changed_by_user_id: actorUserId,
                    changed_by_name: actorName,
                });
            } catch (_) {}
        }
    }

    if (sig && db && typeof db.query === 'function') {
        try {
            await db.query(
                `UPDATE dg_ozon_merge_decisions
                 SET status = 'suggested', updated_by_name = ?, comment = 'Разъединено в Ozon', updated_at = CURRENT_TIMESTAMP
                 WHERE group_signature = ?`,
                [actorName, sig]
            );
        } catch (_) {}
    }

    return {
        success: msFailed === 0,
        total: offerIds.length,
        to_update: importItems.length,
        ms_ok: msOk,
        ms_failed: msFailed,
        errors,
        duration_sec: Number(((Date.now() - t0) / 1000).toFixed(2)),
    };
}

module.exports = {
    OZON_MERGE_ATTR_ID,
    OZON_BRAND_ATTR_ID,
    ensureOzonMergeTables,
    appendOzonMergeLog,
    getOzonMergeLog,
    parseMergeGroupsInput,
    scanOzonMergeAttributesToCache,
    buildAutoMergeGroupsList,
    saveOzonMergeDecision,
    previewOzonMergeGroups,
    applyOzonMergeGroups,
    unmergeOzonGroup,
    searchOzonAttributeDictionaryValues,
};
