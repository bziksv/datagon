'use strict';

/**
 * Блок синка цены с конкурента при своём остатке МС.
 *
 * «Свой» остаток — только если у сайта в my_sites заданы склады
 * (`ms_stock_store_uuids`): сумма по ним после enrich.
 * Без привязки складов общий ms_export.stock НЕ блокирует (сателлиты вроде Вилмед).
 */

const {
    applySiteWarehouseStockToRows,
    parseSiteMsStockStoreUuids,
} = require('./msExportStockByStore');

function isOwnMsStockBlockingCompetitor(row) {
    if (!row || Number(row.site_ms_stock_guard) !== 1) return false;
    const n = Number(row.sticker_ms_stock);
    return Number.isFinite(n) && n > 0;
}

/**
 * Помечает строки и пересчитывает остаток по складам сайта.
 * `site_ms_stock_guard = 1` только при непустых ms_stock_store_uuids.
 * Вызывать после `enrichRowsWithStickersAndMs` (нужен stock_by_store).
 * @param {import('mysql2/promise').Pool|import('mysql2/promise').Connection} db
 * @param {object[]} rows
 */
async function applySiteWarehouseStockBySiteId(db, rows) {
    const list = Array.isArray(rows) ? rows : [];
    if (!list.length) return;
    const siteIds = [
        ...new Set(
            list.map((r) => Number(r.site_id)).filter((n) => Number.isFinite(n) && n > 0)
        ),
    ];
    if (!siteIds.length) return;
    const [sites] = await db.query(
        `SELECT id, ms_stock_store_uuids
         FROM my_sites
         WHERE id IN (${siteIds.map(() => '?').join(',')})`,
        siteIds
    );
    const byId = new Map((sites || []).map((s) => [Number(s.id), s]));
    const groups = new Map();
    for (const r of list) {
        const sid = Number(r.site_id);
        if (!groups.has(sid)) groups.set(sid, []);
        groups.get(sid).push(r);
    }
    for (const [sid, group] of groups) {
        const site = byId.get(sid);
        const hasWarehouses = !!(
            site && parseSiteMsStockStoreUuids(site.ms_stock_store_uuids).length
        );
        if (hasWarehouses) {
            applySiteWarehouseStockToRows(site, group);
        }
        for (const r of group) {
            r.site_ms_stock_guard = hasWarehouses ? 1 : 0;
        }
    }
}

module.exports = {
    isOwnMsStockBlockingCompetitor,
    applySiteWarehouseStockBySiteId,
};
