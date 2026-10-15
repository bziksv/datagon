'use strict';

/**
 * Поставить в очередь парсинга URL из `prices` по тем же фильтрам, что GET /api/results.
 * Используется: POST /api/parse/refresh-results и автосинк `results_reparse_products`.
 */

const { buildResultsWhere, invalidateResultsListCache } = require('../routes/results');
const { canonicalizeSiteUrl } = require('./datagonUrlCanon');

function normalizeRefreshUrl(raw) {
    try {
        const u = new URL(String(raw || '').trim());
        if (!/^https?:$/i.test(String(u.protocol || ''))) return '';
        if (String(u.search || '')) return '';
        return canonicalizeSiteUrl(u.toString()) || '';
    } catch (_) {
        return '';
    }
}

/**
 * @param {import('mysql2/promise').Pool} db
 * @param {Record<string, unknown>} filters — как body refresh-results / query results
 * @returns {Promise<{ success: true, added: number, reset: number, orphans: number, total: number, message: string }>}
 */
async function refreshResultsByFilters(db, filters) {
    if (!db) throw new Error('db required');
    const w = buildResultsWhere(filters || {});
    const whereSql = w.sql || '';
    const pUrls = w.params || [];

    const qUrls = `
        SELECT DISTINCT
            pr.page_id AS page_id,
            COALESCE(pg.url, pr.url) AS url,
            pr.project_id AS project_id
        FROM prices pr
        LEFT JOIN pages pg ON pg.id = pr.page_id
        WHERE pr.page_id IS NOT NULL
        ${whereSql}
        ORDER BY pr.id DESC
    `;

    const [recentUrls] = await db.query(qUrls, pUrls);
    if (!recentUrls.length) {
        return {
            success: true,
            added: 0,
            reset: 0,
            orphans: 0,
            total: 0,
            message: 'Нет результатов по текущим фильтрам',
        };
    }

    const pageIds = [
        ...new Set(
            recentUrls
                .map((r) => Number(r.page_id))
                .filter((id) => Number.isFinite(id) && id > 0)
        ),
    ];

    let reset = 0;
    const chunk = 500;
    for (let i = 0; i < pageIds.length; i += chunk) {
        const slice = pageIds.slice(i, i + chunk);
        const ph = slice.map(() => '?').join(',');
        const [u] = await db.query(
            `UPDATE pages
                SET status = 'pending', last_error = NULL, parsed_at = NULL
              WHERE id IN (${ph})
                AND status <> 'processing'`,
            slice
        );
        reset += Number(u && u.affectedRows) || 0;
        await db.query(`UPDATE prices SET page_status_cached = 'pending' WHERE page_id IN (${ph})`, slice);
    }

    let orphans = 0;
    for (const item of recentUrls) {
        if (item.page_id) continue;
        const normalizedUrl = normalizeRefreshUrl(item.url);
        if (!normalizedUrl || !item.project_id) continue;
        const [existing] = await db.query('SELECT id, status FROM pages WHERE url = ? AND project_id = ?', [
            normalizedUrl,
            item.project_id,
        ]);
        if (existing.length) {
            if (existing[0].status !== 'processing') {
                await db.query(
                    'UPDATE pages SET status = "pending", last_error = NULL, parsed_at = NULL WHERE id = ?',
                    [existing[0].id]
                );
                await db.query('UPDATE prices SET page_status_cached = "pending" WHERE page_id = ?', [
                    existing[0].id,
                ]);
                orphans += 1;
            }
        } else {
            const [ins] = await db.query(
                'INSERT INTO pages (project_id, url, status, page_type, added_from) VALUES (?, ?, "pending", "unknown", "Ручной")',
                [item.project_id, normalizedUrl]
            );
            orphans += 1;
            if (ins && ins.insertId) {
                await db.query(
                    'UPDATE prices SET page_id = ?, page_status_cached = "pending" WHERE url = ? AND project_id = ?',
                    [ins.insertId, normalizedUrl, item.project_id]
                );
            }
        }
    }

    try {
        if (typeof invalidateResultsListCache === 'function') invalidateResultsListCache();
    } catch (_) {}

    const total = reset + orphans;
    return {
        success: true,
        added: total,
        reset,
        orphans,
        total,
        message: `В очередь на перепарсинг: ${total}`,
    };
}

module.exports = {
    refreshResultsByFilters,
    normalizeRefreshUrl,
};
