/**
 * Остатки ms_export по складам (из report/stock/bystore при синке МойСклад).
 * Используется в «Заказы в МС» для сравнения с store_uuid заказа.
 */

let schemaReady = false;

function normalizeCode(value) {
    return String(value || '').trim().toUpperCase();
}

function parseUuidFromMsHref(href) {
    const m = String(href || '').match(/\/([0-9a-f-]{36})(?:\?|$)/i);
    return m ? m[1].toLowerCase() : '';
}

function resolveRowCode(row, uuidToCode) {
    const direct = normalizeCode(row && row.code);
    if (direct) return direct;
    const href = row && row.meta && row.meta.href ? String(row.meta.href) : '';
    const uuid = parseUuidFromMsHref(href);
    if (uuid && uuidToCode && uuidToCode.has(uuid)) {
        return uuidToCode.get(uuid);
    }
    return '';
}

async function ensureMsExportStockByStoreSchema(db) {
    if (schemaReady) return;
    await db.query(`
        CREATE TABLE IF NOT EXISTS ms_export_stock_by_store (
            code VARCHAR(64) NOT NULL,
            store_uuid VARCHAR(36) NOT NULL,
            stock DECIMAL(15,3) NOT NULL DEFAULT 0,
            updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            PRIMARY KEY (code, store_uuid),
            INDEX idx_store (store_uuid)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    schemaReady = true;
}

/**
 * @param {import('mysql2/promise').Pool} db
 * @param {object[]} reportRows — строки report/stock/bystore
 * @param {Map<string,string>} [uuidToCode] — uuid ассортимента → ms_export.code
 */
async function replaceMsExportStockByStoreFromReport(db, reportRows, uuidToCode) {
    await ensureMsExportStockByStoreSchema(db);
    await db.query('TRUNCATE TABLE ms_export_stock_by_store');

    const insertRows = [];
    for (const row of reportRows || []) {
        const code = resolveRowCode(row, uuidToCode);
        if (!code) continue;
        const stores = Array.isArray(row.stockByStore) ? row.stockByStore : [];
        for (const st of stores) {
            const storeUuid = parseUuidFromMsHref(st && st.meta && st.meta.href);
            if (!storeUuid) continue;
            const stock = Number(st && st.stock != null ? st.stock : 0);
            if (!Number.isFinite(stock)) continue;
            insertRows.push([code, storeUuid, stock]);
        }
    }

    if (!insertRows.length) return { rows: 0 };

    const chunkSize = 2000;
    let saved = 0;
    for (let i = 0; i < insertRows.length; i += chunkSize) {
        const chunk = insertRows.slice(i, i + chunkSize);
        await db.query(
            'INSERT INTO ms_export_stock_by_store (code, store_uuid, stock) VALUES ?',
            [chunk],
        );
        saved += chunk.length;
    }
    return { rows: saved };
}

function buildAssortmentUuidToCodeMap(products, bundles) {
    const map = new Map();
    const add = (item) => {
        if (!item || typeof item !== 'object') return;
        const code = normalizeCode(item.code);
        if (!code) return;
        const id = String(item.id || parseUuidFromMsHref(item.meta && item.meta.href) || '').toLowerCase();
        if (id) map.set(id, code);
    };
    for (const p of products || []) add(p);
    for (const b of bundles || []) add(b);
    return map;
}

/** SQL-выражение: остаток позиции с учётом склада заказа. */
function msOrderPositionStockExpr(orderAlias) {
    const o = String(orderAlias || 'o2');
    return `(CASE
   WHEN ${o}.store_uuid IS NOT NULL AND TRIM(${o}.store_uuid) != '' THEN ss.stock
   ELSE e.stock
 END)`;
}

/**
 * Имена складов по uuid (из документов МС; отдельного справочника складов нет).
 * @param {import('mysql2/promise').Pool} db
 * @param {string[]} storeUuids
 * @returns {Promise<Map<string,string>>}
 */
async function loadMsStoreNamesByUuid(db, storeUuids) {
    const map = new Map();
    const uuids = [...new Set((storeUuids || []).map((u) => String(u || '').toLowerCase()).filter(Boolean))];
    if (!uuids.length) return map;
    const ph = uuids.map(() => '?').join(',');
    try {
        const [rows] = await db.query(
            `SELECT store_uuid, MAX(store_name) AS store_name
             FROM ms_customer_order
             WHERE store_uuid IN (${ph})
               AND store_name IS NOT NULL AND TRIM(store_name) <> ''
             GROUP BY store_uuid`,
            uuids
        );
        for (const r of rows || []) {
            const id = String(r.store_uuid || '').toLowerCase();
            const name = String(r.store_name || '').trim();
            if (id && name) map.set(id, name);
        }
    } catch (_) {}
    const missing = uuids.filter((u) => !map.has(u));
    if (missing.length) {
        try {
            const [rows2] = await db.query(
                `SELECT store_uuid, MAX(store_name) AS store_name
                 FROM ms_purchase_order
                 WHERE store_uuid IN (${missing.map(() => '?').join(',')})
                   AND store_name IS NOT NULL AND TRIM(store_name) <> ''
                 GROUP BY store_uuid`,
                missing
            );
            for (const r of rows2 || []) {
                const id = String(r.store_uuid || '').toLowerCase();
                const name = String(r.store_name || '').trim();
                if (id && name) map.set(id, name);
            }
        } catch (_) {}
    }
    return map;
}

function rowCodeForStockByStore(r) {
    return normalizeCode(
        (r && (r.code || r.ms_link_code || r.sku || r.cms_product_id)) || ''
    );
}

/**
 * Навешивает на строки `stock_by_store` / `sticker_ms_stock_by_store`:
 * `[{store_uuid, store_name, stock}]` из `ms_export_stock_by_store`.
 * Код строки: `code` (ms_export) || `ms_link_code` || `sku` || `cms_product_id`.
 * @param {import('mysql2/promise').Pool} db
 * @param {object[]} rows
 */
async function attachStockByStoreToRows(db, rows) {
    const list = Array.isArray(rows) ? rows : [];
    for (const r of list) {
        r.stock_by_store = [];
        r.sticker_ms_stock_by_store = [];
    }
    if (!list.length) return;

    await ensureMsExportStockByStoreSchema(db);
    const codes = new Set();
    for (const r of list) {
        const c = rowCodeForStockByStore(r);
        if (c) codes.add(c);
    }
    if (!codes.size) return;

    const codeList = [...codes];
    const [stockRows] = await db.query(
        `SELECT code, store_uuid, stock
         FROM ms_export_stock_by_store
         WHERE UPPER(TRIM(code)) IN (${codeList.map(() => '?').join(',')})`,
        codeList
    );
    if (!(stockRows || []).length) return;

    const storeUuids = [
        ...new Set(
            stockRows
                .map((r) => String(r.store_uuid || '').toLowerCase())
                .filter(Boolean)
        ),
    ];
    const nameByUuid = await loadMsStoreNamesByUuid(db, storeUuids);
    const byCode = new Map();
    for (const row of stockRows) {
        const code = normalizeCode(row.code);
        if (!code) continue;
        const storeUuid = String(row.store_uuid || '').toLowerCase();
        if (!storeUuid) continue;
        const stock = Number(row.stock);
        if (!byCode.has(code)) byCode.set(code, []);
        byCode.get(code).push({
            store_uuid: storeUuid,
            store_name: nameByUuid.get(storeUuid) || storeUuid.slice(0, 8) + '…',
            stock: Number.isFinite(stock) ? stock : 0,
        });
    }
    for (const arr of byCode.values()) {
        arr.sort(
            (a, b) =>
                b.stock - a.stock ||
                String(a.store_name).localeCompare(String(b.store_name), 'ru')
        );
    }
    for (const r of list) {
        const c = rowCodeForStockByStore(r);
        const arr = (c && byCode.get(c)) || [];
        r.stock_by_store = arr;
        r.sticker_ms_stock_by_store = arr;
    }
}

const STORE_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Нормализует список UUID складов из my_sites.ms_stock_store_uuids (JSON / CSV / array).
 * @param {unknown} raw
 * @returns {string[]}
 */
function parseSiteMsStockStoreUuids(raw) {
    let list = [];
    if (Array.isArray(raw)) {
        list = raw;
    } else if (raw != null && typeof raw === 'object' && Array.isArray(raw.uuids)) {
        list = raw.uuids;
    } else {
        const s = String(raw == null ? '' : raw).trim();
        if (!s) return [];
        if (s.startsWith('[')) {
            try {
                const parsed = JSON.parse(s);
                if (Array.isArray(parsed)) list = parsed;
            } catch (_) {
                list = [];
            }
        } else {
            list = s.split(/[\s,;]+/);
        }
    }
    const out = [];
    const seen = new Set();
    for (const item of list) {
        const id = String(item == null ? '' : item).trim().toLowerCase();
        if (!STORE_UUID_RE.test(id) || seen.has(id)) continue;
        seen.add(id);
        out.push(id);
    }
    return out;
}

function serializeSiteMsStockStoreUuids(raw) {
    const uuids = parseSiteMsStockStoreUuids(raw);
    return uuids.length ? JSON.stringify(uuids) : null;
}

/**
 * Справочник складов для UI: uuid из bystore + имена из заказов.
 * @param {import('mysql2/promise').Pool} db
 * @returns {Promise<{uuid:string,name:string}[]>}
 */
async function listDistinctMsStores(db) {
    await ensureMsExportStockByStoreSchema(db);
    const [rows] = await db.query(
        `SELECT DISTINCT store_uuid
         FROM ms_export_stock_by_store
         WHERE store_uuid IS NOT NULL AND TRIM(store_uuid) <> ''
         ORDER BY store_uuid`
    );
    const uuids = (rows || [])
        .map((r) => String(r.store_uuid || '').toLowerCase())
        .filter(Boolean);
    const nameByUuid = await loadMsStoreNamesByUuid(db, uuids);
    return uuids
        .map((uuid) => ({
            uuid,
            name: nameByUuid.get(uuid) || uuid.slice(0, 8) + '…',
        }))
        .sort((a, b) => String(a.name).localeCompare(String(b.name), 'ru'));
}

/**
 * Если у сайта выбраны склады — пересчитывает `sticker_ms_stock` / `sticker_in_stock`
 * как сумму остатков только по ним (из уже навешанного `stock_by_store`).
 * Пустой список складов = без изменений (общий `ms_export.stock`).
 * @param {object} site
 * @param {object[]} rows
 */
function applySiteWarehouseStockToRows(site, rows) {
    const uuids = new Set(parseSiteMsStockStoreUuids(site && site.ms_stock_store_uuids));
    if (!uuids.size) return;
    for (const r of rows || []) {
        if (!Number(r.sticker_ms_linked)) continue;
        const byStore = Array.isArray(r.stock_by_store)
            ? r.stock_by_store
            : Array.isArray(r.sticker_ms_stock_by_store)
              ? r.sticker_ms_stock_by_store
              : [];
        let sum = 0;
        for (const s of byStore) {
            const id = String((s && s.store_uuid) || '').toLowerCase();
            if (!uuids.has(id)) continue;
            const n = Number(s.stock);
            if (Number.isFinite(n)) sum += n;
        }
        r.sticker_ms_stock = sum;
        r.sticker_in_stock = sum > 0 ? 1 : 0;
    }
}

module.exports = {
    ensureMsExportStockByStoreSchema,
    replaceMsExportStockByStoreFromReport,
    buildAssortmentUuidToCodeMap,
    msOrderPositionStockExpr,
    normalizeCode,
    loadMsStoreNamesByUuid,
    attachStockByStoreToRows,
    parseSiteMsStockStoreUuids,
    serializeSiteMsStockStoreUuids,
    listDistinctMsStores,
    applySiteWarehouseStockToRows,
};
