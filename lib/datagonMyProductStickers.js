/**
 * Наклейки (стикеры) на «Мои товары» + журнал изменений полей (в т.ч. заморозка цены).
 *
 * Manual flags on my_products:
 *   sticker_no_ru, sticker_discontinued, sticker_not_supplied, sticker_sale
 * Auto (computed on enrich):
 *   sticker_has_ru  — есть ссылка РУ в атрибутах МС и НЕ стоит «Нет РУ»
 *   sticker_ru_url  — сырая ссылка
 *   sticker_in_stock — остаток МС > 0 при связи с ms_export
 *   sticker_ms_stock — число остатка МС
 *   sticker_sale_active — sticker_sale и активная заморозка цены
 */

const { extractRuUrlFromPayload } = require('./dgNewProductsMarkets');
const { attachStockByStoreToRows } = require('./msExportStockByStore');

const STICKER_MANUAL_FIELDS = Object.freeze([
    'sticker_no_ru',
    'sticker_discontinued',
    'sticker_not_supplied',
    'sticker_sale',
]);

const FIELD_LABELS = Object.freeze({
    sticker_no_ru: 'Нет РУ',
    sticker_discontinued: 'Снят с производства/аналог по запросу',
    sticker_not_supplied: 'Не поставляется, предлагаем аналог',
    sticker_sale: 'Скидка',
    sticker_has_ru: 'Есть РУ',
    sticker_in_stock: 'Есть в наличии',
    price_hold: 'Заморозка цены',
    price_hold_until: 'Срок заморозки',
    price_hold_by: 'Кто заморозил',
    price_hold_note: 'Заметка заморозки',
});

let columnsReady = false;
let logReady = false;

function as01(v) {
    return v === true || v === 1 || v === '1' ? 1 : 0;
}

function normalizeMsLinkKey(value) {
    return String(value ?? '')
        .trim()
        .toUpperCase();
}

async function ensureMyProductStickerColumns(db) {
    if (columnsReady) return;
    const columns = [
        { name: 'sticker_no_ru', ddl: 'ALTER TABLE my_products ADD COLUMN sticker_no_ru TINYINT(1) NOT NULL DEFAULT 0' },
        {
            name: 'sticker_discontinued',
            ddl: 'ALTER TABLE my_products ADD COLUMN sticker_discontinued TINYINT(1) NOT NULL DEFAULT 0',
        },
        {
            name: 'sticker_not_supplied',
            ddl: 'ALTER TABLE my_products ADD COLUMN sticker_not_supplied TINYINT(1) NOT NULL DEFAULT 0',
        },
        { name: 'sticker_sale', ddl: 'ALTER TABLE my_products ADD COLUMN sticker_sale TINYINT(1) NOT NULL DEFAULT 0' },
    ];
    for (const col of columns) {
        try {
            const [rows] = await db.query(
                `SELECT 1
                 FROM information_schema.columns
                 WHERE table_schema = DATABASE()
                   AND table_name = 'my_products'
                   AND column_name = ?
                 LIMIT 1`,
                [col.name]
            );
            if (!rows.length) await db.query(col.ddl);
        } catch (_) {}
    }
    columnsReady = true;
}

async function ensureMyProductFieldLogTable(db) {
    if (logReady) return;
    await db.query(`
        CREATE TABLE IF NOT EXISTS dg_my_products_log (
            id BIGINT AUTO_INCREMENT PRIMARY KEY,
            product_id BIGINT NOT NULL,
            site_id INT NOT NULL,
            source_id VARCHAR(255) NULL,
            sku VARCHAR(255) NULL,
            field VARCHAR(64) NOT NULL,
            old_value TEXT NULL,
            new_value TEXT NULL,
            action VARCHAR(32) NOT NULL DEFAULT 'update',
            source VARCHAR(64) NULL,
            changed_by_login VARCHAR(255) NULL,
            changed_by_name VARCHAR(255) NULL,
            changed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            KEY idx_dg_mpl_product (product_id, changed_at),
            KEY idx_dg_mpl_field (product_id, field, changed_at),
            KEY idx_dg_mpl_site (site_id, changed_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    logReady = true;
}

async function insertMyProductLog(db, row) {
    await ensureMyProductFieldLogTable(db);
    const productId = Number(row.product_id || 0);
    if (!Number.isFinite(productId) || productId <= 0) return;
    await db.query(
        `INSERT INTO dg_my_products_log
         (product_id, site_id, source_id, sku, field, old_value, new_value, action, source,
          changed_by_login, changed_by_name, changed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
        [
            productId,
            Number(row.site_id) || 0,
            row.source_id != null ? String(row.source_id) : null,
            row.sku != null ? String(row.sku) : null,
            String(row.field || '').slice(0, 64),
            row.old_value != null ? String(row.old_value) : null,
            row.new_value != null ? String(row.new_value) : null,
            String(row.action || 'update').slice(0, 32),
            row.source != null ? String(row.source).slice(0, 64) : null,
            row.changed_by_login != null ? String(row.changed_by_login).slice(0, 255) : null,
            row.changed_by_name != null ? String(row.changed_by_name).slice(0, 255) : null,
        ]
    );
}

function fmtLogValue(v) {
    if (v === null || v === undefined) return '';
    if (typeof v === 'boolean') return v ? '1' : '0';
    if (v instanceof Date) {
        const y = v.getFullYear();
        const m = String(v.getMonth() + 1).padStart(2, '0');
        const d = String(v.getDate()).padStart(2, '0');
        const hh = String(v.getHours()).padStart(2, '0');
        const mm = String(v.getMinutes()).padStart(2, '0');
        const ss = String(v.getSeconds()).padStart(2, '0');
        return `${y}-${m}-${d} ${hh}:${mm}:${ss}`;
    }
    return String(v);
}

async function logMyProductFieldChange(db, product, field, oldValue, newValue, meta) {
    const oldS = fmtLogValue(oldValue);
    const newS = fmtLogValue(newValue);
    if (oldS === newS) return;
    await insertMyProductLog(db, {
        product_id: product.id,
        site_id: product.site_id,
        source_id: product.source_id,
        sku: product.sku,
        field,
        old_value: oldS,
        new_value: newS,
        action: meta && meta.action ? meta.action : 'update',
        source: meta && meta.source ? meta.source : 'ui',
        changed_by_login: meta && meta.login,
        changed_by_name: meta && meta.name,
    });
}

function isPriceHoldActive(row, nowMs) {
    if (!row || !row.price_hold_until) return false;
    const t = new Date(row.price_hold_until).getTime();
    if (!Number.isFinite(t)) return false;
    return t > (nowMs != null ? nowMs : Date.now());
}

/**
 * SQL-выражение для бакета сортировки наклеек (после JOIN ms_export).
 * 0 = есть остаток МС; 2 = снят/не поставляется; 1 = остальное.
 */
function sqlStickerSortBucket(mpAlias = 'mp') {
    return `CASE
        WHEN COALESCE(${mpAlias}.sticker_discontinued, 0) = 1
          OR COALESCE(${mpAlias}.sticker_not_supplied, 0) = 1 THEN 2
        WHEN COALESCE(ms_link_src.stock, ms_link_sku.stock, 0) > 0 THEN 0
        ELSE 1
    END`;
}

async function enrichRowsWithStickersAndMs(db, rows) {
    if (!Array.isArray(rows) || !rows.length) return;
    await ensureMyProductStickerColumns(db);

    const keys = new Set();
    for (const r of rows) {
        const a = normalizeMsLinkKey(r.cms_product_id || r.source_id);
        if (a) keys.add(a);
        const b = normalizeMsLinkKey(r.sku);
        if (b) keys.add(b);
        r.sticker_no_ru = as01(r.sticker_no_ru);
        r.sticker_discontinued = as01(r.sticker_discontinued);
        r.sticker_not_supplied = as01(r.sticker_not_supplied);
        r.sticker_sale = as01(r.sticker_sale);
        r.sticker_has_ru = 0;
        r.sticker_ru_url = '';
        r.sticker_in_stock = 0;
        r.sticker_ms_stock = null;
        r.sticker_sale_active = 0;
        r.sticker_ms_linked = 0;
        r.ms_uuid = '';
        r.ms_type = '';
    }
    if (!keys.size) {
        applyComputedStickerFlags(rows);
        return;
    }

    const keyList = [...keys];
    const [msRows] = await db.query(
        `SELECT
            UPPER(TRIM(COALESCE(code,''))) AS k,
            code,
            stock,
            stock_quantity,
            uuid,
            type,
            buy_price,
            stock_cost
         FROM ms_export
         WHERE UPPER(TRIM(COALESCE(code,''))) IN (${keyList.map(() => '?').join(',')})`,
        keyList
    );
    const byKey = new Map();
    const uuids = [];
    for (const row of msRows || []) {
        const k = String(row.k || '').trim();
        if (!k) continue;
        byKey.set(k, row);
        if (row.uuid) uuids.push(String(row.uuid));
    }

    const ruByUuid = new Map();
    if (uuids.length) {
        const uniq = [...new Set(uuids)];
        // payload_json тяжёлый — грузим чанками, сразу извлекаем URL и отпускаем JSON.
        const DETAIL_CHUNK = 200;
        for (let i = 0; i < uniq.length; i += DETAIL_CHUNK) {
            const slice = uniq.slice(i, i + DETAIL_CHUNK);
            const [details] = await db.query(
                `SELECT uuid, payload_json
                 FROM ms_entity_details
                 WHERE uuid IN (${slice.map(() => '?').join(',')})`,
                slice
            );
            for (const d of details || []) {
                let payload = d.payload_json;
                d.payload_json = null;
                if (typeof payload === 'string') {
                    try {
                        payload = JSON.parse(payload);
                    } catch (_) {
                        payload = null;
                    }
                }
                const ru = extractRuUrlFromPayload(payload);
                payload = null;
                if (ru) ruByUuid.set(String(d.uuid), ru);
            }
        }
    }

    for (const r of rows) {
        const idKey = normalizeMsLinkKey(r.cms_product_id || r.source_id);
        const skuKey = normalizeMsLinkKey(r.sku);
        const ms = (idKey && byKey.get(idKey)) || (skuKey && byKey.get(skuKey)) || null;
        if (!ms) continue;
        r.sticker_ms_linked = 1;
        r.in_moysklad = 1;
        r.ms_link_code = ms.code || r.ms_link_code || '';
        r.ms_uuid = ms.uuid ? String(ms.uuid).split('?')[0].trim() : '';
        r.ms_type = ms.type != null ? String(ms.type) : '';
        const stockNum = Number(ms.stock);
        r.sticker_ms_stock = Number.isFinite(stockNum) ? stockNum : null;
        r.sticker_in_stock = Number.isFinite(stockNum) && stockNum > 0 ? 1 : 0;
        const ru = ms.uuid ? ruByUuid.get(String(ms.uuid)) || '' : '';
        r.sticker_ru_url = ru;
        // Закупочная для наценки сайта (stock_cost числовой, иначе buy_price строка).
        const costN = Number(ms.stock_cost);
        r.ms_stock_cost = Number.isFinite(costN) ? costN : null;
        r.ms_buy_price =
            r.ms_stock_cost != null
                ? r.ms_stock_cost
                : ms.buy_price != null && String(ms.buy_price).trim() !== ''
                  ? ms.buy_price
                  : null;
    }

    applyComputedStickerFlags(rows);
    await clearExpiredSaleStickers(db, rows);
    await attachStockByStoreToRows(db, rows);
}

function applyComputedStickerFlags(rows) {
    const now = Date.now();
    for (const r of rows) {
        const hasRuLink = Boolean(String(r.sticker_ru_url || '').trim());
        // «Есть РУ» — авто, если есть ссылка и не нажато «Нет РУ»
        r.sticker_has_ru = hasRuLink && !as01(r.sticker_no_ru) ? 1 : 0;
        const holdOk = isPriceHoldActive(r, now);
        r.sticker_sale_active = as01(r.sticker_sale) && holdOk ? 1 : 0;
    }
}

/**
 * Если срок заморозки истёк, а «Скидка» ещё стоит — снимаем и пишем в лог.
 */
async function clearExpiredSaleStickers(db, rows) {
    const now = Date.now();
    const toClear = [];
    for (const r of rows) {
        if (!as01(r.sticker_sale)) continue;
        if (isPriceHoldActive(r, now)) continue;
        toClear.push(r);
    }
    if (!toClear.length) return;
    const ids = toClear.map((r) => Number(r.id)).filter((id) => Number.isFinite(id) && id > 0);
    if (!ids.length) return;
    try {
        await db.query(
            `UPDATE my_products SET sticker_sale = 0, updated_at = NOW()
             WHERE id IN (${ids.map(() => '?').join(',')}) AND sticker_sale = 1`,
            ids
        );
        for (const r of toClear) {
            await logMyProductFieldChange(db, r, 'sticker_sale', 1, 0, {
                action: 'auto_clear',
                source: 'price_hold_expired',
                login: 'system',
                name: 'system',
            });
            r.sticker_sale = 0;
            r.sticker_sale_active = 0;
        }
    } catch (_) {}
}

async function setMyProductStickers(db, product, patch, meta) {
    await ensureMyProductStickerColumns(db);
    const updates = [];
    const params = [];
    const changed = {};

    for (const field of STICKER_MANUAL_FIELDS) {
        if (!Object.prototype.hasOwnProperty.call(patch, field)) continue;
        const next = as01(patch[field]);
        const prev = as01(product[field]);
        if (field === 'sticker_sale' && next === 1 && !isPriceHoldActive(product)) {
            const err = new Error(
                'Стикер «Скидка» можно поставить только при активной заморозке цены'
            );
            err.code = 'STICKER_SALE_REQUIRES_HOLD';
            throw err;
        }
        if (prev === next) continue;
        updates.push(`${field} = ?`);
        params.push(next);
        changed[field] = { old: prev, new: next };
    }

    if (!updates.length) {
        return { changed: {}, product };
    }

    params.push(Number(product.id));
    await db.query(
        `UPDATE my_products SET ${updates.join(', ')}, updated_at = NOW() WHERE id = ?`,
        params
    );

    for (const [field, diff] of Object.entries(changed)) {
        await logMyProductFieldChange(db, product, field, diff.old, diff.new, meta);
        product[field] = diff.new;
    }
    return { changed, product };
}

async function listMyProductFieldLog(db, opts) {
    await ensureMyProductFieldLogTable(db);
    const productId = Number(opts.product_id || 0);
    if (!Number.isFinite(productId) || productId <= 0) {
        return { rows: [], total: 0 };
    }
    const limit = Math.min(200, Math.max(1, Number(opts.limit) || 50));
    const offset = Math.max(0, Number(opts.offset) || 0);
    const field = String(opts.field || '').trim();
    const where = ['product_id = ?'];
    const params = [productId];
    if (field) {
        where.push('field = ?');
        params.push(field);
    }
    const [[countRow]] = await db.query(
        `SELECT COUNT(*) AS total FROM dg_my_products_log WHERE ${where.join(' AND ')}`,
        params
    );
    const [rows] = await db.query(
        `SELECT id, product_id, site_id, source_id, sku, field, old_value, new_value,
                action, source, changed_by_login, changed_by_name, changed_at
         FROM dg_my_products_log
         WHERE ${where.join(' AND ')}
         ORDER BY id DESC
         LIMIT ? OFFSET ?`,
        [...params, limit, offset]
    );
    return {
        rows: rows || [],
        total: Number(countRow && countRow.total) || 0,
        limit,
        offset,
        field_labels: FIELD_LABELS,
    };
}

module.exports = {
    STICKER_MANUAL_FIELDS,
    FIELD_LABELS,
    ensureMyProductStickerColumns,
    ensureMyProductFieldLogTable,
    insertMyProductLog,
    logMyProductFieldChange,
    enrichRowsWithStickersAndMs,
    setMyProductStickers,
    listMyProductFieldLog,
    sqlStickerSortBucket,
    isPriceHoldActive,
    as01,
};
