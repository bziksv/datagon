'use strict';

const { formatMatrixUpdatedCell } = require('./hucksterBuildMatrix');
const { HUCKSTER_MATRIX_KIND } = require('./hucksterSyncRevision');

const SYNC_HDR = 'Актуально на';
const PRICE_TYPE_NAMES_CACHE_TTL_MS = 10 * 60 * 1000;
let priceTypeNamesCache = { at: 0, rows: [] };

function normMsEntityUuidKey(u) {
    const s = String(u == null ? '' : u).trim();
    if (!s) return '';
    const q = s.indexOf('?');
    return q >= 0 ? s.slice(0, q) : s;
}

/**
 * Все строки моста из ms_export с непустым кодом — без фильтров «складская позиция» / «сотрудничание».
 * Сужение списка только на странице Huckster (UI) и при тестовом uid_filter на синке.
 */
async function fetchMsExportBridgeRowsAll(db) {
    if (!db || typeof db.query !== 'function') return [];
    try {
        const [rows] = await db.query(
            `SELECT code, name, manager, uuid, COALESCE(stock, 0) AS stock,
                    TRIM(COALESCE(automation_price, '')) AS automation_price,
                    no_longer_cooperation
             FROM ms_export
             WHERE TRIM(COALESCE(code, '')) <> ''
             ORDER BY code`
        );
        const out = [];
        for (const r of rows || []) {
            const code = String(r.code != null ? r.code : '').trim();
            if (!code) continue;
            out.push({
                code,
                name: String(r.name != null ? r.name : ''),
                manager: String(r.manager != null ? r.manager : ''),
                uuid: String(r.uuid != null ? r.uuid : '').trim(),
                stock: Number(r.stock) || 0,
                automation_price: String(r.automation_price != null ? r.automation_price : '').trim(),
                no_longer_cooperation: String(r.no_longer_cooperation != null ? r.no_longer_cooperation : ''),
            });
        }
        return out;
    } catch (e) {
        console.warn('[huckster] ms_export bridge (all rows):', e && e.message ? e.message : e);
        return [];
    }
}

/**
 * Узкий набор из ms_export (складская позиция «Да»; «перестали сотрудничать» — скрываем, кроме остатка > 0).
 * Оставлен для сценариев, где нужен прежний SQL-фильтр; матрица Huckster в панели использует {@link fetchMsExportBridgeRowsAll}.
 * @param {object} [options]
 * @param {boolean} [options.exclude_archived_bundles] — не брать архивные комплекты, даже при остатке
 *   (тип «Комплект» в ms_export **или** kind=bundle в ms_entity_details по uuid)
 * @param {boolean} [options.exclude_archived_products_zero_stock] — не брать архивные товары только при остатке ≤ 0
 */
async function fetchMsExportBridgeCandidates(db, options) {
    if (!db || typeof db.query !== 'function') return [];
    const opts = options && typeof options === 'object' ? options : {};
    const excludeArchivedBundles = !!opts.exclude_archived_bundles;
    const excludeArchivedProductsNoStock = !!opts.exclude_archived_products_zero_stock;
    const extra = [];
    if (excludeArchivedBundles) {
        extra.push(`NOT (
                COALESCE(is_archived, 0) = 1
                AND (
                    LOWER(TRIM(COALESCE(type, ''))) = 'комплект'
                    OR EXISTS (
                        SELECT 1 FROM ms_entity_details d
                        WHERE d.uuid = SUBSTRING_INDEX(ms_export.uuid, '?', 1)
                          AND LOWER(TRIM(d.kind)) = 'bundle'
                    )
                )
            )`);
    }
    if (excludeArchivedProductsNoStock) {
        extra.push(
            `NOT (LOWER(TRIM(COALESCE(type, ''))) = 'товар' AND COALESCE(is_archived, 0) = 1 AND COALESCE(stock, 0) <= 0)`
        );
    }
    const extraSql = extra.length ? ` AND ${extra.join(' AND ')}` : '';
    try {
        const [rows] = await db.query(
            `SELECT code, name, manager, uuid, COALESCE(stock, 0) AS stock,
                    TRIM(COALESCE(automation_price, '')) AS automation_price
             FROM ms_export
             WHERE LOWER(TRIM(COALESCE(stock_position, ''))) IN ('да', 'yes', '1', 'true')
               AND (
                    LOWER(TRIM(COALESCE(no_longer_cooperation, ''))) NOT IN ('да', 'yes', '1', 'true')
                 OR COALESCE(stock, 0) > 0
               )${extraSql}
             ORDER BY code`
        );
        const out = [];
        for (const r of rows || []) {
            const code = String(r.code != null ? r.code : '').trim();
            if (!code) continue;
            out.push({
                code,
                name: String(r.name != null ? r.name : ''),
                manager: String(r.manager != null ? r.manager : ''),
                uuid: String(r.uuid != null ? r.uuid : '').trim(),
                stock: Number(r.stock) || 0,
                automation_price: String(r.automation_price != null ? r.automation_price : '').trim(),
            });
        }
        return out;
    } catch (e) {
        console.warn('[huckster] ms_export bridge query:', e && e.message ? e.message : e);
        return [];
    }
}

function normalizePriceTypeName(name) {
    return String(name == null ? '' : name).trim().toLowerCase();
}

function parseDetailPayload(raw) {
    if (!raw) return null;
    if (typeof raw === 'object') return raw;
    try {
        return JSON.parse(String(raw));
    } catch (_) {
        return null;
    }
}

function moyskladPriceTypeValueCents(entity, priceTypeName) {
    const needle = normalizePriceTypeName(priceTypeName);
    if (!needle || !entity || !Array.isArray(entity.salePrices)) return 0;
    for (const sp of entity.salePrices) {
        const nm = normalizePriceTypeName(sp?.priceType?.name);
        if (nm !== needle) continue;
        const value = Number(sp?.value);
        return Number.isFinite(value) ? value : 0;
    }
    return 0;
}

function formatMoyskladPriceCents(valueCents) {
    const value = Number(valueCents || 0) / 100;
    if (!Number.isFinite(value)) return '';
    return `${value.toLocaleString('ru-RU', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
    })} ₽`;
}

async function fetchDetailPayloadMapByUuids(db, uuids, onProgress) {
    const out = new Map();
    const list = Array.from(
        new Set((uuids || []).map((u) => normMsEntityUuidKey(u)).filter(Boolean))
    );
    if (!list.length) return out;
    const chunkSize = 500;
    const totalChunks = Math.ceil(list.length / chunkSize);
    for (let i = 0; i < list.length; i += chunkSize) {
        const chunk = list.slice(i, i + chunkSize);
        const chunkIndex = Math.floor(i / chunkSize) + 1;
        if (typeof onProgress === 'function') {
            onProgress({ phase: 'detail_chunk_start', chunk_index: chunkIndex, chunk_total: totalChunks });
        }
        const [rows] = await db.query(
            `SELECT uuid, payload_json
             FROM ms_entity_details
             WHERE SUBSTRING_INDEX(uuid, '?', 1) IN (${chunk.map(() => '?').join(',')})`,
            chunk
        );
        for (const r of rows || []) {
            const uuid = String(r.uuid || '').trim();
            if (!uuid) continue;
            const payload = parseDetailPayload(r.payload_json);
            const key = normMsEntityUuidKey(uuid);
            out.set(key, payload);
            if (key !== uuid) out.set(uuid, payload);
        }
        if (typeof onProgress === 'function') {
            onProgress({
                phase: 'detail_chunk_done',
                chunk_index: chunkIndex,
                chunk_total: totalChunks,
                rows_loaded: out.size,
            });
        }
    }
    return out;
}

async function filterMsRowsByPositivePriceType(db, rows, priceTypeName) {
    const priceType = String(priceTypeName || '').trim();
    if (!priceType || !Array.isArray(rows) || !rows.length || !db || typeof db.query !== 'function') {
        return Array.isArray(rows) ? rows.slice() : [];
    }
    const byUuid = await fetchDetailPayloadMapByUuids(db, rows.map((r) => r && r.uuid));
    const out = [];
    for (const r of rows) {
        const uuid = String(r?.uuid || '').trim();
        const payload = uuid ? byUuid.get(normMsEntityUuidKey(uuid)) || byUuid.get(uuid) : null;
        const valueCents = moyskladPriceTypeValueCents(payload, priceType);
        if (valueCents > 0) {
            out.push({
                ...r,
                selected_price_type_name: priceType,
                selected_price_type_value_cents: valueCents,
                selected_price_type_value: formatMoyskladPriceCents(valueCents),
            });
        }
    }
    return out;
}

/**
 * Добавляет колонку выбранного типа цены МС ко всем строкам; строки не отбрасывает (в отличие от filterMsRowsByPositivePriceType).
 */
async function enrichMsRowsWithPriceType(db, rows, priceTypeName, onProgress) {
    const priceType = String(priceTypeName || '').trim();
    if (!Array.isArray(rows) || !rows.length) return [];
    if (!priceType || !db || typeof db.query !== 'function') {
        return rows.map((r) => ({ ...r }));
    }
    const uuidList = Array.from(
        new Set(
            rows
                .map((r) => normMsEntityUuidKey(r && r.uuid))
                .filter(Boolean)
        )
    );
    const priceByUuid = new Map();
    const chunkSize = 2000;
    const totalChunks = Math.ceil(uuidList.length / chunkSize);
    for (let i = 0; i < uuidList.length; i += chunkSize) {
        const chunk = uuidList.slice(i, i + chunkSize);
        const chunkIndex = Math.floor(i / chunkSize) + 1;
        if (typeof onProgress === 'function') {
            onProgress({ phase: 'detail_chunk_start', chunk_index: chunkIndex, chunk_total: totalChunks });
        }
        const [priceRows] = await db.query(
            `SELECT
                SUBSTRING_INDEX(d.uuid, '?', 1) AS uuid_key,
                MAX(CAST(jt.price_value AS SIGNED)) AS value_cents
             FROM ms_entity_details d
             JOIN JSON_TABLE(
                d.payload_json,
                '$.salePrices[*]' COLUMNS (
                    price_type_name VARCHAR(255) PATH '$.priceType.name',
                    price_value DECIMAL(18, 2) PATH '$.value'
                )
             ) jt
             WHERE SUBSTRING_INDEX(d.uuid, '?', 1) IN (${chunk.map(() => '?').join(',')})
               AND LOWER(TRIM(jt.price_type_name)) = LOWER(TRIM(?))
             GROUP BY SUBSTRING_INDEX(d.uuid, '?', 1)`,
            [...chunk, priceType]
        );
        for (const r of priceRows || []) {
            const key = normMsEntityUuidKey(r && r.uuid_key);
            const value = Number(r && r.value_cents);
            if (!key) continue;
            priceByUuid.set(key, Number.isFinite(value) ? value : 0);
        }
        if (typeof onProgress === 'function') {
            onProgress({
                phase: 'detail_chunk_done',
                chunk_index: chunkIndex,
                chunk_total: totalChunks,
                rows_loaded: priceByUuid.size,
            });
        }
    }
    return rows.map((r) => {
        const uuid = normMsEntityUuidKey(r && r.uuid);
        const valueCents = uuid ? Number(priceByUuid.get(uuid) || 0) : 0;
        return {
            ...r,
            selected_price_type_name: priceType,
            selected_price_type_value_cents: valueCents,
            selected_price_type_value: valueCents > 0 ? formatMoyskladPriceCents(valueCents) : '',
        };
    });
}

async function fetchMoyskladPriceTypeNames(db) {
    if (!db || typeof db.query !== 'function') return [];
    const now = Date.now();
    if (now - priceTypeNamesCache.at < PRICE_TYPE_NAMES_CACHE_TTL_MS) {
        return priceTypeNamesCache.rows.slice();
    }
    try {
        const [rows] = await db.query(
            `SELECT DISTINCT jt.price_type_name AS name
             FROM ms_entity_details d
             JOIN JSON_TABLE(
                d.payload_json,
                '$.salePrices[*]' COLUMNS (
                    price_type_name VARCHAR(255) PATH '$.priceType.name'
                )
             ) jt
             WHERE jt.price_type_name IS NOT NULL
               AND TRIM(jt.price_type_name) <> ''
             ORDER BY name`
        );
        const names = (rows || [])
            .map((r) => String(r.name || '').trim())
            .filter(Boolean)
            .sort((a, b) => a.localeCompare(b, 'ru', { numeric: true }));
        priceTypeNamesCache = { at: now, rows: names };
        return names.slice();
    } catch (e) {
        console.warn('[huckster] price type names:', e && e.message ? e.message : e);
        return [];
    }
}

function groupShopsByMarketplace(shops) {
    const by = { ozon: [], wildberries: [], yandex: [] };
    for (const s of shops || []) {
        const m = String(s.marketplace || '').toLowerCase();
        if (by[m]) by[m].push(s);
    }
    return by;
}

function findProductInShop(shopId, code, shopItemsByShopId) {
    const list = shopItemsByShopId[shopId] || [];
    const c = String(code || '').trim();
    for (const p of list) {
        if (String(p.uid || '').trim() === c) return p;
    }
    for (const p of list) {
        const alts = p.altMatchIds;
        if (!Array.isArray(alts) || alts.length === 0) continue;
        for (const a of alts) {
            if (String(a || '').trim() === c) return p;
        }
    }
    return null;
}

/**
 * Один маркетплейс (несколько кабинетов в конфиге): ровно один включённый repricer по коду — зелёный статус;
 * ноль или больше одного — красный статус «выключен/не определён».
 */
function resolveCabinetForMarketplace(shopsInMp, code, shopItemsByShopId) {
    const enabled = [];
    const found = [];
    for (const sh of shopsInMp || []) {
        const rec = findProductInShop(sh.id, code, shopItemsByShopId);
        if (rec) found.push({ shop: sh, rec });
        if (rec && rec.repricerEnabled === true) {
            enabled.push({ shop: sh, rec });
        }
    }
    if (enabled.length === 1) {
        return { state: 'ok', displayName: String(enabled[0].shop.name || '').trim(), rec: enabled[0].rec };
    }
    if (found.length === 1) {
        return { state: 'off', displayName: String(found[0].shop.name || '').trim(), rec: found[0].rec };
    }
    return { state: 'bad', displayName: '', rec: null };
}

function repricerStatusCell(resolved) {
    return resolved && resolved.state === 'ok' ? 'Репрайсер ВКЛЮЧЕН' : 'Репрайсер ВЫКЛЮЧЕН';
}

function modelCellFromRec(rec) {
    if (!rec) return '';
    const t = String(rec.unitModelNames || '').trim();
    return t || '—';
}

function modelCellFromResolved(resolved) {
    const rec = resolved && resolved.rec ? resolved.rec : null;
    if (!rec) return 'Модель не назначена';
    const names = String(rec.unitModelNames || '').trim();
    if (resolved.state !== 'ok') {
        if (names) return 'Модель назначена, но Репрайсер на модели выключен';
        return 'Модель не назначена';
    }
    return names || 'Модель не назначена';
}

function mpSkuCellFromRec(rec) {
    if (!rec) return '';
    return String(rec.mpSku || '').trim();
}

/**
 * Матрица набора 1: строки из Мой склад (код = UID в Huckster), колонки Ozon/WB/ЯМ + модели Unit.
 * @param {Array<{ id: string, name: string, marketplace: string, shop_id: string }>} shopsSet1
 * @param {Record<string, Array<{ uid: string, repricerEnabled?: boolean, unitModelNames?: string, altMatchIds?: string[], mpSku?: string }>>} shopItemsByShopId
 * @param {Array<{ code: string, name: string, stock: number, automation_price?: string }>} msRows
 */
function buildMsHucksterBridgeExport(shopsSet1, shopItemsByShopId, msRows, syncedAtIso, opts = {}) {
    const byMp = groupShopsByMarketplace(shopsSet1);
    const priceTypeName = String(opts.priceTypeName || '').trim();
    const hasPriceTypeColumn = Boolean(priceTypeName);
    const header = [
        'ID / КОД',
        'Наименование товара',
        'Менеджер',
        'Остаток',
        'Автоматизация цены',
    ];
    if (hasPriceTypeColumn) {
        header.push(priceTypeName);
    }
    header.push(
        'Ozon',
        'Модель Ozon',
        'Код товара на МП (Ozon)',
        'WB',
        'Модель WB',
        'Код товара на МП (WB)',
        'ЯМ',
        'Модель ЯМ',
        'Код товара на МП (ЯМ)',
        SYNC_HDR
    );
    const syncIso = syncedAtIso && String(syncedAtIso).trim() ? String(syncedAtIso).trim() : '';
    const syncCell = syncIso ? formatMatrixUpdatedCell(syncIso) : '';
    const rows = [header];
    /** Параллельно rows: i=0 null, i>=1 мета для строки данных */
    const bridge_row_meta = [null];

    for (const ms of msRows || []) {
        const code = String(ms.code || '').trim();
        const ro = resolveCabinetForMarketplace(byMp.ozon, code, shopItemsByShopId);
        const rw = resolveCabinetForMarketplace(byMp.wildberries, code, shopItemsByShopId);
        const ry = resolveCabinetForMarketplace(byMp.yandex, code, shopItemsByShopId);

        const row = [
            code,
            String(ms.name || ''),
            String(ms.manager || ''),
            String(ms.stock != null ? ms.stock : ''),
            String(ms.automation_price != null ? ms.automation_price : '').trim(),
        ];
        if (hasPriceTypeColumn) {
            row.push(String(ms.selected_price_type_value || ''));
        }
        row.push(
            repricerStatusCell(ro),
            modelCellFromResolved(ro),
            mpSkuCellFromRec(ro.rec),
            repricerStatusCell(rw),
            modelCellFromResolved(rw),
            mpSkuCellFromRec(rw.rec),
            repricerStatusCell(ry),
            modelCellFromResolved(ry),
            mpSkuCellFromRec(ry.rec),
            syncCell
        );
        rows.push(row);
        bridge_row_meta.push({
            cabinets: {
                ozon: ro.state,
                wildberries: rw.state,
                yandex: ry.state,
            },
            models: {
                ozon: modelCellFromRec(ro.rec),
                wildberries: modelCellFromRec(rw.rec),
                yandex: modelCellFromRec(ry.rec),
            },
        });
    }

    const n = msRows ? msRows.length : 0;
    return {
        rows,
        total_rows: n,
        total_uids: n,
        bridge_row_meta,
        unit_gap_shop_indexes_by_uid: {},
        matrix_kind: HUCKSTER_MATRIX_KIND,
    };
}

module.exports = {
    fetchMsExportBridgeRowsAll,
    fetchMsExportBridgeCandidates,
    filterMsRowsByPositivePriceType,
    enrichMsRowsWithPriceType,
    fetchMoyskladPriceTypeNames,
    buildMsHucksterBridgeExport,
    SYNC_HDR,
};
