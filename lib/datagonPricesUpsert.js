'use strict';

/**
 * Запись результата парсинга в `prices`: одна актуальная строка на page_id (UPDATE, не дубль INSERT).
 */

/**
 * @param {import('mysql2/promise').Pool|import('mysql2/promise').Connection} db
 * @param {{
 *   projectId: number,
 *   pageId: number,
 *   sku?: string,
 *   productName?: string,
 *   price?: number|null,
 *   isOos?: boolean,
 *   url: string,
 * }} row
 * @returns {Promise<{ id: number, action: 'insert'|'update' }>}
 */
async function upsertPriceForPage(db, row) {
    const pageId = Number(row && row.pageId);
    const projectId = Number(row && row.projectId);
    if (!db || !Number.isFinite(pageId) || pageId <= 0 || !Number.isFinite(projectId) || projectId <= 0) {
        throw new Error('upsertPriceForPage: invalid projectId/pageId');
    }
    const sku = String(row.sku != null ? row.sku : '').trim().slice(0, 100);
    const productName = String(row.productName != null ? row.productName : '').trim().slice(0, 255);
    let price = row.price;
    if (price != null && price !== '') {
        price = Number(price);
        if (!Number.isFinite(price)) price = null;
    } else {
        price = null;
    }
    const isOos = row.isOos ? 1 : 0;
    const url = String(row.url || '').trim();

    const [existing] = await db.query(
        `SELECT id FROM prices WHERE page_id = ? ORDER BY id DESC LIMIT 1`,
        [pageId],
    );
    if (existing && existing.length) {
        const keepId = Number(existing[0].id);
        await db.query(
            `UPDATE prices
                SET project_id = ?,
                    sku = ?,
                    product_name = ?,
                    price = ?,
                    is_oos = ?,
                    is_out_of_stock = ?,
                    url = ?,
                    parsed_at = NOW(),
                    page_status_cached = 'done'
              WHERE id = ?`,
            [projectId, sku || null, productName || null, price, isOos, isOos, url || null, keepId],
        );
        await db.query(`DELETE FROM prices WHERE page_id = ? AND id <> ?`, [pageId, keepId]);
        return { id: keepId, action: 'update' };
    }

    const [ins] = await db.query(
        `INSERT INTO prices (project_id, page_id, sku, product_name, price, is_oos, is_out_of_stock, url, page_status_cached)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'done')`,
        [projectId, pageId, sku || null, productName || null, price, isOos, isOos, url || null],
    );
    return { id: Number(ins.insertId) || 0, action: 'insert' };
}

/**
 * Схлопнуть уже накопленные дубли: на page_id оставить только MAX(id).
 * @returns {Promise<number>} deleted rows
 */
async function collapseDuplicatePricesByPageId(db) {
    if (!db) return 0;
    try {
        const [r] = await db.query(
            `DELETE pr FROM prices pr
             INNER JOIN (
                 SELECT page_id, MAX(id) AS keep_id
                   FROM prices
                  WHERE page_id IS NOT NULL
                  GROUP BY page_id
                 HAVING COUNT(*) > 1
             ) t ON t.page_id = pr.page_id AND pr.id <> t.keep_id`,
        );
        return Number(r && r.affectedRows) || 0;
    } catch (_) {
        return 0;
    }
}

module.exports = {
    upsertPriceForPage,
    collapseDuplicatePricesByPageId,
};
