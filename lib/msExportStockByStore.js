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

module.exports = {
    ensureMsExportStockByStoreSchema,
    replaceMsExportStockByStoreFromReport,
    buildAssortmentUuidToCodeMap,
    msOrderPositionStockExpr,
    normalizeCode,
};
