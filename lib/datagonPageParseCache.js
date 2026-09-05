'use strict';

/**
 * Кэш последнего удачного разбора карточки на самой странице очереди (`pages`):
 * название / SKU / цена / OOS — чтобы очередь и поиск не зависели только от `prices`
 * (результаты чистятся по retention).
 */

let columnsReady = false;
let backfillDone = false;

async function ensurePagesParseCacheColumns(db) {
    if (!db || columnsReady) return;
    const specs = [
        ['product_name', "VARCHAR(255) NULL DEFAULT NULL"],
        ['last_sku', "VARCHAR(100) NULL DEFAULT NULL"],
        ['last_price', "DECIMAL(10,2) NULL DEFAULT NULL"],
        ['last_is_oos', "TINYINT(1) NOT NULL DEFAULT 0"],
    ];
    for (const [name, ddl] of specs) {
        try {
            const [cols] = await db.query(`SHOW COLUMNS FROM pages LIKE ?`, [name]);
            if (!cols.length) {
                await db.query(`ALTER TABLE pages ADD COLUMN ${name} ${ddl}`);
            }
        } catch (_) {
            /* ignore — повторим на следующем вызове */
            return;
        }
    }
    columnsReady = true;
}

/**
 * Записать снимок разбора на pages (после INSERT в prices).
 * @param {import('mysql2/promise').Pool|import('mysql2/promise').Connection} db
 * @param {number} pageId
 * @param {{ productName?: string, sku?: string, price?: number|null, isOos?: boolean }} snap
 */
async function updatePageParseCache(db, pageId, snap) {
    const id = Number(pageId);
    if (!db || !Number.isFinite(id) || id <= 0) return;
    await ensurePagesParseCacheColumns(db);
    const s = snap || {};
    const name = String(s.productName != null ? s.productName : '').trim().slice(0, 255);
    const sku = String(s.sku != null ? s.sku : '').trim().slice(0, 100);
    let price = s.price;
    if (price != null && price !== '') {
        price = Number(price);
        if (!Number.isFinite(price)) price = null;
    } else {
        price = null;
    }
    const isOos = s.isOos ? 1 : 0;
    await db.query(
        `UPDATE pages
            SET product_name = ?,
                last_sku = ?,
                last_price = ?,
                last_is_oos = ?,
                status = 'done',
                parsed_at = NOW(),
                last_error = NULL
          WHERE id = ?`,
        [name || null, sku || null, price, isOos, id],
    );
}

/**
 * Один раз: подтянуть имя/SKU/цену на pages из последней строки prices (где ещё пусто).
 */
async function backfillPagesParseCacheFromPrices(db) {
    if (!db || backfillDone) return { updated: 0 };
    await ensurePagesParseCacheColumns(db);
    try {
        const [r] = await db.query(
            `UPDATE pages pg
             INNER JOIN (
                 SELECT page_id, MAX(id) AS max_id
                   FROM prices
                  WHERE page_id IS NOT NULL
                  GROUP BY page_id
             ) t ON t.page_id = pg.id
             INNER JOIN prices pr ON pr.id = t.max_id
                SET pg.product_name = NULLIF(TRIM(pr.product_name), ''),
                    pg.last_sku = NULLIF(TRIM(pr.sku), ''),
                    pg.last_price = pr.price,
                    pg.last_is_oos = COALESCE(pr.is_oos, 0)
              WHERE (pg.product_name IS NULL OR TRIM(pg.product_name) = '')
                AND pr.product_name IS NOT NULL
                AND TRIM(pr.product_name) <> ''`,
        );
        backfillDone = true;
        return { updated: Number(r && r.affectedRows) || 0 };
    } catch (e) {
        return { updated: 0, error: e && e.message ? e.message : String(e) };
    }
}

/**
 * Product done без ни одной строки в prices → снова pending (после retention).
 * @returns {Promise<number>} affected rows
 */
async function requeueDoneProductPagesWithoutPrices(db, limit) {
    if (!db) return 0;
    const lim = Math.max(1, Math.min(50000, Math.round(Number(limit) || 10000)));
    try {
        const [r] = await db.query(
            `UPDATE pages pg
                LEFT JOIN prices pr ON pr.page_id = pg.id
                SET pg.status = 'pending',
                    pg.last_error = NULL
              WHERE pg.status = 'done'
                AND pg.page_type = 'product'
                AND pr.id IS NULL
              LIMIT ?`,
            [lim],
        );
        return Number(r && r.affectedRows) || 0;
    } catch (_) {
        // MySQL до 8.0.13 плохо дружит с LIMIT в multi-table UPDATE — fallback батчем.
        try {
            const [ids] = await db.query(
                `SELECT pg.id
                   FROM pages pg
                   LEFT JOIN prices pr ON pr.page_id = pg.id
                  WHERE pg.status = 'done'
                    AND pg.page_type = 'product'
                    AND pr.id IS NULL
                  ORDER BY pg.id ASC
                  LIMIT ?`,
                [lim],
            );
            const list = (ids || []).map((r) => Number(r.id)).filter((n) => Number.isFinite(n) && n > 0);
            if (!list.length) return 0;
            const ph = list.map(() => '?').join(',');
            const [u] = await db.query(
                `UPDATE pages SET status = 'pending', last_error = NULL WHERE id IN (${ph})`,
                list,
            );
            return Number(u && u.affectedRows) || 0;
        } catch (_e2) {
            return 0;
        }
    }
}

module.exports = {
    ensurePagesParseCacheColumns,
    updatePageParseCache,
    backfillPagesParseCacheFromPrices,
    requeueDoneProductPagesWithoutPrices,
};
