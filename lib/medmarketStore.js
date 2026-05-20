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

/** Подпись типа в канонической стыковке `код+Тип` (паритет с buildMedmarketLinkageCode). */
const MM_LINKAGE_TYPE_LABEL_EXPR = `CASE (${MM_ITEM_TYPE_EXPR})
  WHEN 'товар' THEN 'Товар'
  WHEN 'комплект' THEN 'Комплект'
  WHEN 'услуга' THEN 'Услуга'
  ELSE 'Товар'
END`;

const MM_MEDMARKET_TRIM = `TRIM(COALESCE(mse.${MM_MEDMARKET_COL}, ''))`;

const MM_EXPECTED_LINKAGE_EXPR = `CONCAT(TRIM(mse.code), '+', ${MM_LINKAGE_TYPE_LABEL_EXPR})`;

/** Нормализация суффикса после «+» (паритет с normalizeMedmarketItemType / isMedmarketLinkageCodeValid). */
const MM_SUFFIX_NORMALIZED_EXPR = `CASE
  WHEN LOWER(TRIM(SUBSTRING_INDEX(${MM_MEDMARKET_TRIM}, '+', -1))) IN ('товар', 'product') THEN 'товар'
  WHEN LOWER(TRIM(SUBSTRING_INDEX(${MM_MEDMARKET_TRIM}, '+', -1))) IN ('комплект', 'bundle', 'kit') THEN 'комплект'
  WHEN LOWER(TRIM(SUBSTRING_INDEX(${MM_MEDMARKET_TRIM}, '+', -1))) IN ('услуга', 'service') THEN 'услуга'
  WHEN LOWER(TRIM(SUBSTRING_INDEX(${MM_MEDMARKET_TRIM}, '+', -1))) LIKE '%комплект%' THEN 'комплект'
  WHEN LOWER(TRIM(SUBSTRING_INDEX(${MM_MEDMARKET_TRIM}, '+', -1))) LIKE '%услуг%' THEN 'услуга'
  ELSE 'товар'
END`;

/** Валидная стыковка «код+тип» в колонке medmarket_product_code (как isMedmarketLinkageCodeValid). */
const MM_LINKAGE_VALID_SQL = `(
  ${MM_MEDMARKET_TRIM} <> ''
  AND (
    ${MM_MEDMARKET_TRIM} = ${MM_EXPECTED_LINKAGE_EXPR}
    OR (
      ${MM_MEDMARKET_TRIM} LIKE CONCAT(TRIM(mse.code), '+%')
      AND TRIM(SUBSTRING_INDEX(${MM_MEDMARKET_TRIM}, '+', 1)) = TRIM(mse.code)
      AND (${MM_SUFFIX_NORMALIZED_EXPR}) = (${MM_ITEM_TYPE_EXPR})
    )
  )
)`;

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

/** Извлечение значения атрибута из payload_json на стороне MySQL (без передачи всего JSON в Node). */
const MM_ATTR_VALUE_JSON_SQL = `JSON_UNQUOTE(JSON_EXTRACT(
    d.payload_json,
    REPLACE(
        JSON_UNQUOTE(JSON_SEARCH(d.payload_json, 'one', ?, NULL, '$.attributes[*].name')),
        '.name',
        '.value'
    )
))`;

const MM_SYNC_CHUNK_SIZE = 6000;

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
        `UPDATE ms_export SET ${MM_MEDMARKET_COL} = CASE code
            ${whenParts.join(' ')}
            ELSE ${MM_MEDMARKET_COL} END
         WHERE code IN (${placeholders})`,
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
    const mapped =
        query.mapped == null || query.mapped === '' ? '' : String(query.mapped).trim();
    if (mapped === '1' || mapped === 'yes') {
        where.push(MM_LINKAGE_VALID_SQL);
    } else if (mapped === '0' || mapped === 'no') {
        where.push(`NOT (${MM_LINKAGE_VALID_SQL})`);
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
            `SELECT COUNT(*) AS cnt FROM ms_export mse
             WHERE mse.code IS NOT NULL AND TRIM(mse.code) <> '' AND ${MM_LINKAGE_VALID_SQL}`,
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
        data: (rows || []).map((r) => {
            const code = r.code || '';
            const itemType = r.item_type || '';
            const medmarketCode = r.medmarket_code != null ? String(r.medmarket_code) : '';
            return {
                code,
                name: r.name || '',
                item_type: itemType,
                medmarket_code: medmarketCode,
                linkage_valid: isMedmarketLinkageCodeValid(code, itemType, medmarketCode),
                uuid: r.uuid || '',
                ms_type_raw: r.ms_type_raw || '',
                synced_at: r.synced_at,
            };
        }),
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
 * Ускорение: JSON_EXTRACT в MySQL (не тащим payload_json в Node), keyset по code,
 * пропуск строк, где ms_export уже заполнен (догонка / повторный запуск).
 */
async function syncMedmarketCatalogFromMsExport(db, hooks = {}) {
    await ensureMsExportMedmarketColumn(db);
    const onProgress = typeof hooks.onProgress === 'function' ? hooks.onProgress : () => {};
    const likeNeedle = `%${MEDMARKET_ATTR_JSON_NEEDLE}%`;
    const detailsBase = `d.code IS NOT NULL AND TRIM(d.code) <> '' AND d.payload_json LIKE ?`;
    const joinExport = 'INNER JOIN ms_export e ON e.code = TRIM(d.code)';
    const pendingFilter =
        '(e.medmarket_product_code IS NULL OR TRIM(COALESCE(e.medmarket_product_code, \'\')) = \'\')';

    const [[allRow]] = await db.query(
        `SELECT COUNT(*) AS cnt FROM ms_entity_details d WHERE d.code IS NOT NULL AND TRIM(d.code) <> ''`,
    );
    const [[candRow]] = await db.query(
        `SELECT COUNT(*) AS cnt FROM ms_entity_details d ${joinExport} WHERE ${detailsBase}`,
        [likeNeedle],
    );
    const [[pendingRow]] = await db.query(
        `SELECT COUNT(*) AS cnt FROM ms_entity_details d ${joinExport}
         WHERE ${detailsBase} AND ${pendingFilter}`,
        [likeNeedle],
    );
    const totalAll = Number(allRow?.cnt || 0);
    const candidates = Number(candRow?.cnt || 0);
    const total = Number(pendingRow?.cnt || 0);
    const skippedAlready = Math.max(0, candidates - total);
    const chunk = MM_SYNC_CHUNK_SIZE;
    let lastCode = '';
    let processed = 0;
    let upserted = 0;
    let written = 0;

    if (total === 0) {
        await onProgress({
            processed: 0,
            total: 0,
            total_all: totalAll,
            candidates,
            skipped_already: skippedAlready,
            upserted: 0,
            written: 0,
        });
        return {
            total_ms: totalAll,
            candidates,
            pending: 0,
            skipped_already: skippedAlready,
            scanned: 0,
            upserted: 0,
            written: 0,
        };
    }

    while (processed < total) {
        const [rows] = await db.query(
            `SELECT TRIM(d.code) AS code, ${MM_ATTR_VALUE_JSON_SQL} AS mm_val, d.payload_json
             FROM ms_entity_details d
             ${joinExport}
             WHERE ${detailsBase} AND ${pendingFilter} AND TRIM(d.code) > ?
             ORDER BY TRIM(d.code) ASC
             LIMIT ?`,
            [MEDMARKET_ATTR_JSON_NEEDLE, likeNeedle, lastCode, chunk],
        );
        if (!rows?.length) break;
        const pairs = [];
        for (const r of rows) {
            const code = String(r.code || '').trim();
            if (!code) continue;
            let val = r.mm_val != null ? String(r.mm_val).trim() : '';
            if (!val && r.payload_json) {
                val = extractMedmarketCodeFromPayloadJson(r.payload_json);
            }
            if (!val) continue;
            pairs.push({ code, val });
            upserted += 1;
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
            candidates,
            skipped_already: skippedAlready,
            upserted,
            written,
        });
        if (rows.length < chunk) break;
    }
    return {
        total_ms: totalAll,
        candidates,
        pending: total,
        skipped_already: skippedAlready,
        scanned: processed,
        upserted,
        written,
    };
}

const MM_FILL_MS_CONCURRENCY = 6;

async function fillMedmarketLinkageCodes(db, config, query = {}, options = {}) {
    await ensureMsExportMedmarketColumn(db);
    const dryRun = Boolean(options.dry_run);
    const started = Date.now();
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
    let skipped = 0;
    let emptyCode = 0;
    let noUuid = 0;
    const toProcess = [];
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
        const uuid = String(r.uuid || '').trim();
        if (!uuid) {
            noUuid += 1;
            continue;
        }
        toProcess.push({
            code,
            itemType,
            expected,
            current,
            uuid,
            ms_type_raw: r.ms_type_raw,
        });
    }
    const toUpdate = toProcess.length;
    if (dryRun) {
        let wouldFill = 0;
        let wouldCorrect = 0;
        for (const p of toProcess) {
            if (p.current) wouldCorrect += 1;
            else wouldFill += 1;
        }
        return {
            total: (rows || []).length,
            to_update: toUpdate,
            filled: wouldFill,
            corrected: wouldCorrect,
            skipped,
            empty_code: emptyCode,
            no_uuid: noUuid,
            ms_ok: 0,
            ms_failed: 0,
            errors: [],
            duration_sec: Math.round((Date.now() - started) / 1000),
            dry_run: true,
        };
    }

    let filled = 0;
    let corrected = 0;
    let msOk = 0;
    let msFailed = 0;
    const errors = [];
    const onProgress = typeof options.onProgress === 'function' ? options.onProgress : () => {};
    let lastProgressAt = 0;
    for (let i = 0; i < toProcess.length; i += MM_FILL_MS_CONCURRENCY) {
        const slice = toProcess.slice(i, i + MM_FILL_MS_CONCURRENCY);
        await Promise.all(
            slice.map(async (p) => {
                try {
                    await pushMedmarketCodeToMs(config, {
                        uuid: p.uuid,
                        type: p.ms_type_raw,
                        medmarket_code: p.expected,
                    });
                    await db.query(
                        `UPDATE ms_export SET ${MM_MEDMARKET_COL} = ? WHERE code = ?`,
                        [p.expected, p.code],
                    );
                    if (p.current) corrected += 1;
                    else filled += 1;
                    msOk += 1;
                } catch (e) {
                    msFailed += 1;
                    if (errors.length < 20) {
                        errors.push({
                            code: p.code,
                            error: e && e.message ? String(e.message).slice(0, 240) : String(e),
                        });
                    }
                }
            }),
        );
        const done = Math.min(i + slice.length, toProcess.length);
        const now = Date.now();
        if (done >= toProcess.length || now - lastProgressAt >= 2000) {
            lastProgressAt = now;
            await onProgress({
                processed: done,
                total: toProcess.length,
                ms_ok: msOk,
                ms_failed: msFailed,
                filled,
                corrected,
            });
        }
    }
    return {
        total: (rows || []).length,
        to_update: toUpdate,
        filled,
        corrected,
        skipped,
        empty_code: emptyCode,
        no_uuid: noUuid,
        ms_ok: msOk,
        ms_failed: msFailed,
        errors,
        duration_sec: Math.round((Date.now() - started) / 1000),
        dry_run: false,
    };
}

function formatMedmarketFillLinkageSummary(result) {
    const r = result || {};
    return (
        `Медмаркет код+тип: выборка ${Number(r.total || 0)}; к записи ${Number(r.to_update || 0)}; ` +
        `✓ ${Number(r.ms_ok || 0)}; × ${Number(r.ms_failed || 0)}; ` +
        `новых ${Number(r.filled || 0)}; исправлено ${Number(r.corrected || 0)}; ` +
        `пропуск ${Number(r.skipped || 0)}; без uuid ${Number(r.no_uuid || 0)}; ${Number(r.duration_sec || 0)} с`
    ).slice(0, 480);
}

/** Расписание: «Заполнить коды в МойСклад» по всему каталогу (без фильтров страницы). */
async function runScheduledMedmarketFillLinkage(db, config, hooks = {}) {
    const onRunMessage = typeof hooks.onRunMessage === 'function' ? hooks.onRunMessage : () => {};
    await onRunMessage('Медмаркет: старт заполнения код+тип в МойСклад…');
    const result = await fillMedmarketLinkageCodes(db, config, {}, {
        dry_run: false,
        onProgress: async (p) => {
            const pct =
                p.total > 0 ? Math.min(100, Math.round((p.processed / p.total) * 100)) : 0;
            await onRunMessage(
                `Медмаркет код+тип: ${p.processed}/${p.total} (${pct}%); ✓ ${p.ms_ok}; × ${p.ms_failed}`,
            );
        },
    });
    const summary = formatMedmarketFillLinkageSummary(result);
    return { ...result, summary };
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
    runScheduledMedmarketFillLinkage,
    formatMedmarketFillLinkageSummary,
    buildMedmarketListWhere,
    MEDMARKET_MS_ATTR_NAME,
};
