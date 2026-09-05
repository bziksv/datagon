'use strict';

/**
 * Запись результата парсинга в `prices`: одна актуальная строка на page_id
 * и на канонический URL (http/https не плодят дубли в Результатах).
 */

const { canonicalizeSiteUrl, siteUrlCanonKey } = require('./datagonUrlCanon');
const { withDeadlockRetry } = require('./mysqlDeadlockRetry');

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
async function resolveCanonicalPageId(db, projectId, pageId, canonUrl) {
    const pid = Number(pageId);
    const proj = Number(projectId);
    const canon = canonicalizeSiteUrl(canonUrl) || '';
    if (!db || !Number.isFinite(pid) || pid <= 0) return pid;
    if (!canon || !Number.isFinite(proj) || proj <= 0) return pid;
    try {
        const [rows] = await db.query(
            `SELECT id, url FROM pages
              WHERE project_id = ?
                AND (
                  id = ?
                  OR url = ?
                  OR url = ?
                )
              ORDER BY
                CASE
                  WHEN url LIKE 'https://%' THEN 0
                  ELSE 1
                END,
                id ASC
              LIMIT 1`,
            [proj, pid, canon, canon.replace(/^https:\/\//i, 'http://')],
        );
        if (rows && rows[0] && Number(rows[0].id) > 0) return Number(rows[0].id);
    } catch (_) {}
    return pid;
}

async function upsertPriceForPage(db, row) {
    return withDeadlockRetry(() => upsertPriceForPageOnce(db, row), { attempts: 5 });
}

async function upsertPriceForPageOnce(db, row) {
    const rawPageId = Number(row && row.pageId);
    const projectId = Number(row && row.projectId);
    if (!db || !Number.isFinite(rawPageId) || rawPageId <= 0 || !Number.isFinite(projectId) || projectId <= 0) {
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
    const url = canonicalizeSiteUrl(row.url) || String(row.url || '').trim();
    const canonKey = siteUrlCanonKey(url);
    const pageId = await resolveCanonicalPageId(db, projectId, rawPageId, url);

    let keepId = null;
    const [byPage] = await db.query(
        `SELECT id FROM prices WHERE page_id IN (?, ?) ORDER BY id DESC LIMIT 1`,
        [pageId, rawPageId],
    );
    if (byPage && byPage.length) keepId = Number(byPage[0].id);

    if (!keepId && canonKey) {
        const [byUrl] = await db.query(
            `SELECT id FROM prices
              WHERE project_id = ?
                AND (
                  LOWER(url) = ?
                  OR LOWER(url) = ?
                  OR LOWER(REPLACE(url, 'http://', 'https://')) = ?
                )
              ORDER BY id DESC
              LIMIT 1`,
            [projectId, canonKey, canonKey.replace(/^https:\/\//, 'http://'), canonKey],
        );
        if (byUrl && byUrl.length) keepId = Number(byUrl[0].id);
    }

    if (keepId) {
        await db.query(
            `UPDATE prices
                SET project_id = ?,
                    page_id = ?,
                    sku = ?,
                    product_name = ?,
                    price = ?,
                    is_oos = ?,
                    is_out_of_stock = ?,
                    url = ?,
                    parsed_at = NOW(),
                    page_status_cached = 'done'
              WHERE id = ?`,
            [projectId, pageId, sku || null, productName || null, price, isOos, isOos, url || null, keepId],
        );
        await db.query(`DELETE FROM prices WHERE page_id IN (?, ?) AND id <> ?`, [pageId, rawPageId, keepId]);
        if (canonKey) {
            await db.query(
                `DELETE FROM prices
                  WHERE project_id = ?
                    AND id <> ?
                    AND (
                      LOWER(url) = ?
                      OR LOWER(url) = ?
                      OR LOWER(REPLACE(url, 'http://', 'https://')) = ?
                    )`,
                [projectId, keepId, canonKey, canonKey.replace(/^https:\/\//, 'http://'), canonKey],
            );
        }
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
 * Схлопнуть дубли: на page_id оставить MAX(id).
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

/**
 * Схлопнуть дубли http/https(/www) одного пути в рамках project_id.
 */
async function collapseDuplicatePricesByCanonUrl(db) {
    if (!db) return 0;
    try {
        const [r] = await db.query(
            `DELETE pr FROM prices pr
             INNER JOIN (
                 SELECT project_id,
                        LOWER(REPLACE(REPLACE(url, 'http://', 'https://'), 'https://www.', 'https://')) AS canon,
                        MAX(id) AS keep_id
                   FROM prices
                  WHERE url IS NOT NULL AND url <> ''
                  GROUP BY project_id, canon
                 HAVING COUNT(*) > 1
             ) t ON t.project_id = pr.project_id
                AND LOWER(REPLACE(REPLACE(pr.url, 'http://', 'https://'), 'https://www.', 'https://')) = t.canon
                AND pr.id <> t.keep_id`,
        );
        return Number(r && r.affectedRows) || 0;
    } catch (_) {
        return 0;
    }
}

/**
 * Удалить http-страницы очереди, если есть https-близнец; prices переносим на https page_id.
 */
async function collapseHttpHttpsDuplicatePages(db, limit) {
    if (!db) return { pagesDeleted: 0, pricesMoved: 0 };
    const lim = Math.max(1, Math.min(20000, Math.round(Number(limit) || 5000)));
    try {
        const [pairs] = await db.query(
            `SELECT p_http.id AS http_id, p_https.id AS https_id
               FROM pages p_http
               INNER JOIN pages p_https
                 ON p_https.project_id = p_http.project_id
                AND p_https.url = CONCAT('https://', SUBSTRING(p_http.url, 8))
              WHERE p_http.url LIKE 'http://%'
              ORDER BY p_http.id ASC
              LIMIT ?`,
            [lim],
        );
        let pagesDeleted = 0;
        let pricesMoved = 0;
        for (const row of pairs || []) {
            const httpId = Number(row.http_id);
            const httpsId = Number(row.https_id);
            if (!httpId || !httpsId) continue;
            const [mv] = await db.query(`UPDATE prices SET page_id = ? WHERE page_id = ?`, [httpsId, httpId]);
            pricesMoved += Number(mv && mv.affectedRows) || 0;
            await db.query(`DELETE FROM pages WHERE id = ?`, [httpId]);
            pagesDeleted += 1;
        }
        if (pagesDeleted) {
            await collapseDuplicatePricesByPageId(db);
            await collapseDuplicatePricesByCanonUrl(db);
        }
        return { pagesDeleted, pricesMoved };
        } catch (e) {
        console.warn('[prices] collapseHttpHttpsDuplicatePages:', e && e.message ? e.message : e);
        return { pagesDeleted: 0, pricesMoved: 0 };
    }
}

module.exports = {
    upsertPriceForPage,
    collapseDuplicatePricesByPageId,
    collapseDuplicatePricesByCanonUrl,
    collapseHttpHttpsDuplicatePages,
};
