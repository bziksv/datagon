'use strict';

const {
    medmarketItemTypeFromMsType,
    normalizeMedmarketItemType,
    buildMedmarketLinkageCode,
    isMedmarketLinkageCodeValid,
} = require('./datagonMedmarketType');
const {
    MEDMARKET_MS_ATTR_NAME,
    extractMedmarketCodeFromPayloadJson,
    pushMedmarketCodeToMs,
} = require('./medmarketMsAttr');

/** Предфильтр JSON в БД — не парсим 50k+ карточек без атрибута в payload. */
const MEDMARKET_ATTR_JSON_NEEDLE = MEDMARKET_MS_ATTR_NAME;

let msExportColumnReady = false;

/** SQL-выражение типа (паритет с medmarketItemTypeFromMsType). */
const MM_ITEM_TYPE_EXPR = `CASE
  WHEN LOWER(COALESCE(mse.type, '')) LIKE '%комплект%' THEN 'комплект'
  WHEN LOWER(COALESCE(mse.type, '')) LIKE '%услуг%' THEN 'услуга'
  ELSE 'товар'
END`;

const MM_MEDMARKET_COL = 'medmarket_product_code';

async function ensureMsExportMedmarketColumn(db) {
    if (msExportColumnReady) return;
    const [rows] = await db.query(`
        SELECT COUNT(*) AS cnt
        FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'ms_export'
          AND COLUMN_NAME = ?
    `, [MM_MEDMARKET_COL]);
    if (!rows[0]?.cnt) {
        await db.query(
            `ALTER TABLE ms_export ADD COLUMN ${MM_MEDMARKET_COL} VARCHAR(255) NULL DEFAULT NULL`,
        );
        await db.query(
            `ALTER TABLE ms_export ADD INDEX idx_ms_export_medmarket_code (${MM_MEDMARKET_COL}(64))`,
        );
    }
    msExportColumnReady = true;
}

/** @deprecated оставлено для совместимости вызовов routes */
async function ensureMedmarketSchema(db) {
    await ensureMsExportMedmarketColumn(db);
}

/** Пакетное обновление атрибута в ms_export (один запрос на чанк вместо N UPDATE). */
async function batchUpdateMedmarketProductCodes(db, pairs) {
    const list = (pairs || []).filter((p) => p && String(p.code || '').trim());
    if (!list.length) return 0;
    const whenParts = [];
    const params = [];
    const codes = [];
    for (const p of list) {
        const code = String(p.code).trim();
        codes.push(code);
        whenParts.push('WHEN ? THEN ?');
        params.push(code, p.val == null || String(p.val).trim() === '' ? null : String(p.val).trim());
    }
    params.push(...codes);
    const placeholders = codes.map(() => '?').join(', ');
    await db.query(
        `UPDATE ms_export SET ${MM_MEDMARKET_COL} = CASE TRIM(code)
            ${whenParts.join(' ')}
            ELSE ${MM_MEDMARKET_COL} END
         WHERE TRIM(code) IN (${placeholders})`,
        params,
    );
    return list.length;
}

function buildMedmarketListWhere(query) {
    const where = ['mse.code IS NOT NULL', "TRIM(mse.code) <> ''"];
    const params = [];
    const search = String(query.search || '').trim();
    if (search) {
        const v = `%${search.toLowerCase()}%`;
        where.push(
            `(LOWER(TRIM(mse.code)) LIKE ? OR LOWER(COALESCE(mse.name, '')) LIKE ? OR LOWER(COALESCE(mse.${MM_MEDMARKET_COL}, '')) LIKE ?)`,
        );
        params.push(v, v, v);
    }
    const code = String(query.code || '').trim();
    if (code) {
        where.push('LOWER(TRIM(mse.code)) LIKE ?');
        params.push(`%${code.toLowerCase()}%`);
    }
    const name = String(query.name || '').trim();
    if (name) {
        where.push('LOWER(COALESCE(mse.name, \'\')) LIKE ?');
        params.push(`%${name.toLowerCase()}%`);
    }
    const itemType = String(query.item_type || '').trim();
    if (itemType && itemType !== 'all') {
        where.push(`(${MM_ITEM_TYPE_EXPR}) = ?`);
        params.push(normalizeMedmarketItemType(itemType));
    }
    const mmCode = String(query.medmarket_code || '').trim();
    if (mmCode) {
        where.push(`LOWER(COALESCE(mse.${MM_MEDMARKET_COL}, '')) LIKE ?`);
        params.push(`%${mmCode.toLowerCase()}%`);
    }
    const mapped = String(query.mapped || '').trim();
    if (mapped === '1' || mapped === 'yes') {
        where.push(`mse.${MM_MEDMARKET_COL} IS NOT NULL AND TRIM(mse.${MM_MEDMARKET_COL}) <> ''`);
    } else if (mapped === '0' || mapped === 'no') {
        where.push(`(mse.${MM_MEDMARKET_COL} IS NULL OR TRIM(mse.${MM_MEDMARKET_COL}) = '')`);
    }
    return { whereSql: where.join(' AND '), params };
}

const SORT_KEYS = {
    code: 'TRIM(mse.code)',
    name: 'TRIM(mse.name)',
    item_type: MM_ITEM_TYPE_EXPR,
    medmarket_code: `COALESCE(mse.${MM_MEDMARKET_COL}, '')`,
};

async function listMedmarketRows(db, query) {
    await ensureMsExportMedmarketColumn(db);
    const limitRaw = parseInt(query.limit, 10);
    const offsetRaw = parseInt(query.offset, 10);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(1000, limitRaw) : 100;
    const offset = Number.isFinite(offsetRaw) && offsetRaw >= 0 ? offsetRaw : 0;
    const sortKeyRaw = String(query.sort_by || 'code').trim();
    const sortCol = SORT_KEYS[sortKeyRaw] || SORT_KEYS.code;
    const sortDir = String(query.sort_dir || 'asc').toLowerCase() === 'desc' ? 'DESC' : 'ASC';
    const frag = buildMedmarketListWhere(query);
    const fromSql = 'FROM ms_export mse';
    const selectSql = `
        SELECT
            TRIM(mse.code) AS code,
            TRIM(mse.name) AS name,
            (${MM_ITEM_TYPE_EXPR}) AS item_type,
            COALESCE(mse.${MM_MEDMARKET_COL}, '') AS medmarket_code,
            mse.uuid,
            mse.type AS ms_type_raw,
            mse.synced_at
        ${fromSql}
        WHERE ${frag.whereSql}
        ORDER BY ${sortCol} ${sortDir}, TRIM(mse.code) ASC
        LIMIT ? OFFSET ?`;
    const [[countRows], [rows], [mappedRows]] = await Promise.all([
        db.query(`SELECT COUNT(*) AS cnt ${fromSql} WHERE ${frag.whereSql}`, frag.params),
        db.query(selectSql, [...frag.params, limit, offset]),
        db.query(
            `SELECT COUNT(*) AS cnt FROM ms_export
             WHERE ${MM_MEDMARKET_COL} IS NOT NULL AND TRIM(${MM_MEDMARKET_COL}) <> ''`,
        ),
    ]);
    return {
        total: Number(countRows?.[0]?.cnt || 0),
        mapped_in_db: Number(mappedRows?.[0]?.cnt || 0),
        attr_name: MEDMARKET_MS_ATTR_NAME,
        limit,
        offset,
        sort_by: sortKeyRaw in SORT_KEYS ? sortKeyRaw : 'code',
        sort_dir: sortDir === 'DESC' ? 'desc' : 'asc',
        data: (rows || []).map((r) => ({
            code: r.code || '',
            name: r.name || '',
            item_type: r.item_type || '',
            medmarket_code: r.medmarket_code != null ? String(r.medmarket_code) : '',
            uuid: r.uuid || '',
            ms_type_raw: r.ms_type_raw || '',
            synced_at: r.synced_at,
        })),
    };
}

async function upsertMedmarketMapping(db, config, { code, item_type, medmarket_code }) {
    await ensureMsExportMedmarketColumn(db);
    const c = String(code || '').trim();
    if (!c) throw new Error('code обязателен');
    const [msRows] = await db.query(
        `SELECT code, name, type, uuid FROM ms_export WHERE TRIM(code) = ? LIMIT 1`,
        [c],
    );
    if (!msRows?.length) {
        const err = new Error('Товар не найден в ms_export');
        err.code = 'NOT_FOUND';
        throw err;
    }
    const ms = msRows[0];
    const it = normalizeMedmarketItemType(item_type || medmarketItemTypeFromMsType(ms.type));
    const mm =
        medmarket_code == null || String(medmarket_code).trim() === ''
            ? ''
            : String(medmarket_code).trim().slice(0, 255);

    await pushMedmarketCodeToMs(config, {
        uuid: ms.uuid,
        type: ms.type,
        medmarket_code: mm,
    });

    await db.query(
        `UPDATE ms_export SET ${MM_MEDMARKET_COL} = ? WHERE TRIM(code) = ?`,
        [mm || null, c],
    );

    return { code: c, item_type: it, medmarket_code: mm };
}

/**
 * Подтянуть «Код товара для медмаркета» из сохранённых карточек МС (ms_entity_details.payload_json)
 * в колонку ms_export — без отдельной таблицы.
 *
 * Ускорение: только карточки, в JSON которых есть имя атрибута (LIKE), keyset по code вместо OFFSET,
 * обновление ms_export только для строк с непустым значением (без массового NULL по всему каталогу).
 */
async function syncMedmarketCatalogFromMsExport(db, hooks = {}) {
    await ensureMsExportMedmarketColumn(db);
    const onProgress = typeof hooks.onProgress === 'function' ? hooks.onProgress : () => {};
    const likeNeedle = `%${MEDMARKET_ATTR_JSON_NEEDLE}%`;
    const baseWhere = `code IS NOT NULL AND TRIM(code) <> ''`;
    const attrWhere = `${baseWhere} AND payload_json LIKE ?`;

    const [[allRow]] = await db.query(
        `SELECT COUNT(*) AS cnt FROM ms_entity_details WHERE ${baseWhere}`,
    );
    const [[candRow]] = await db.query(
        `SELECT COUNT(*) AS cnt FROM ms_entity_details WHERE ${attrWhere}`,
        [likeNeedle],
    );
    const totalAll = Number(allRow?.cnt || 0);
    const total = Number(candRow?.cnt || 0);
    const chunk = 3000;
    let lastCode = '';
    let processed = 0;
    let upserted = 0;
    let written = 0;

    while (processed < total) {
        const [rows] = await db.query(
            `SELECT code, payload_json FROM ms_entity_details
             WHERE ${attrWhere} AND code > ?
             ORDER BY code ASC
             LIMIT ?`,
            [likeNeedle, lastCode, chunk],
        );
        if (!rows?.length) break;
        const pairs = [];
        for (const r of rows) {
            const code = String(r.code || '').trim();
            if (!code) continue;
            const val = extractMedmarketCodeFromPayloadJson(r.payload_json);
            if (val) {
                pairs.push({ code, val });
                upserted += 1;
            }
        }
        if (pairs.length) {
            written += await batchUpdateMedmarketProductCodes(db, pairs);
        }
        processed += rows.length;
        lastCode = String(rows[rows.length - 1].code || '');
        await onProgress({
            processed,
            total,
            total_all: totalAll,
            upserted,
            written,
        });
        if (rows.length < chunk) break;
    }
    return {
        total_ms: totalAll,
        candidates: total,
        scanned: processed,
        upserted,
        written,
    };
}

async function fillMedmarketLinkageCodes(db, config, query = {}, options = {}) {
    await ensureMsExportMedmarketColumn(db);
    const dryRun = Boolean(options.dry_run);
    const frag = buildMedmarketListWhere(query);
    const [rows] = await db.query(
        `SELECT TRIM(mse.code) AS code, mse.uuid, mse.type AS ms_type_raw,
            (${MM_ITEM_TYPE_EXPR}) AS item_type,
            COALESCE(mse.${MM_MEDMARKET_COL}, '') AS medmarket_code
         FROM ms_export mse
         WHERE ${frag.whereSql}
         ORDER BY TRIM(mse.code) ASC`,
        frag.params,
    );
    let filled = 0;
    let corrected = 0;
    let skipped = 0;
    let emptyCode = 0;
    for (const r of rows || []) {
        const code = String(r.code || '').trim();
        const itemType = normalizeMedmarketItemType(r.item_type);
        if (!code) {
            emptyCode += 1;
            continue;
        }
        const expected = buildMedmarketLinkageCode(code, itemType);
        const current = String(r.medmarket_code || '').trim();
        if (isMedmarketLinkageCodeValid(code, itemType, current)) {
            skipped += 1;
            continue;
        }
        if (!dryRun) {
            await pushMedmarketCodeToMs(config, {
                uuid: r.uuid,
                type: r.ms_type_raw,
                medmarket_code: expected,
            });
            await db.query(
                `UPDATE ms_export SET ${MM_MEDMARKET_COL} = ? WHERE TRIM(code) = ?`,
                [expected, code],
            );
        }
        if (current) corrected += 1;
        else filled += 1;
    }
    return {
        total: (rows || []).length,
        filled,
        corrected,
        skipped,
        empty_code: emptyCode,
        dry_run: dryRun,
    };
}

async function importMedmarketMappings(db, config, rows) {
    let updated = 0;
    let skipped = 0;
    for (const raw of rows || []) {
        const code = String(raw.code || '').trim();
        const itemType = normalizeMedmarketItemType(raw.item_type || raw.type);
        const mm = String(raw.medmarket_code || raw.medmarket || '').trim();
        if (!code || !mm) {
            skipped += 1;
            continue;
        }
        try {
            await upsertMedmarketMapping(db, config, {
                code,
                item_type: itemType,
                medmarket_code: mm,
            });
            updated += 1;
        } catch (_) {
            skipped += 1;
        }
    }
    return { updated, skipped };
}

module.exports = {
    ensureMedmarketSchema,
    ensureMsExportMedmarketColumn,
    listMedmarketRows,
    upsertMedmarketMapping,
    syncMedmarketCatalogFromMsExport,
    importMedmarketMappings,
    fillMedmarketLinkageCodes,
    buildMedmarketListWhere,
    MEDMARKET_MS_ATTR_NAME,
};
