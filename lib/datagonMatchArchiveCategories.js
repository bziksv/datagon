'use strict';

/**
 * Родительские категории каталога для фильтра архива сопоставления.
 * Сейчас — Webasyst (`shop_category` / `shop_category_products`):
 * товар в дочерней категории сворачивается к корню (`parent_id = 0`).
 */

const { openCmsDbConnection } = require('./datagonCmsDb');

const CACHE_MS = 5 * 60 * 1000;
const cache = new Map();

function rootOf(byId, categoryId) {
    let current = byId.get(Number(categoryId));
    const seen = new Set();
    while (current && current.parent_id && !seen.has(current.id)) {
        seen.add(current.id);
        const next = byId.get(current.parent_id);
        if (!next) break;
        current = next;
    }
    return current ? current.id : 0;
}

async function loadWebasystIndex(conn, productIds) {
    const [cats] = await conn.query('SELECT id, parent_id, name FROM shop_category');
    const byId = new Map();
    for (const row of cats || []) {
        const id = Number(row.id);
        if (!Number.isFinite(id) || id <= 0) continue;
        byId.set(id, {
            id,
            parent_id: Number(row.parent_id) || 0,
            name: String(row.name || '').trim()
        });
    }
    const byProduct = new Map();
    const ids = [...new Set((productIds || []).map((n) => Number(n)).filter((n) => Number.isFinite(n) && n > 0))];
    for (let i = 0; i < ids.length; i += 400) {
        const chunk = ids.slice(i, i + 400);
        const [links] = await conn.query(
            `SELECT product_id, category_id FROM shop_category_products WHERE product_id IN (${chunk.map(() => '?').join(',')})`,
            chunk
        );
        for (const row of links || []) {
            const pid = Number(row.product_id);
            const root = rootOf(byId, row.category_id);
            if (!Number.isFinite(pid) || pid <= 0 || !root) continue;
            let set = byProduct.get(pid);
            if (!set) {
                set = new Set();
                byProduct.set(pid, set);
            }
            set.add(root);
        }
    }
    const rootNames = new Map();
    for (const cat of byId.values()) {
        if (!cat.parent_id && cat.name) rootNames.set(cat.id, cat.name);
    }
    return { byProduct, rootNames };
}

/**
 * @param {import('mysql2/promise').Connection} db
 * @param {object} siteRow строка my_sites
 * @param {number[]} productIds cms_product_id карточек в архиве
 */
function indexCacheKey(siteId, productIds) {
    const ids = [...new Set((productIds || []).map((n) => Number(n)).filter((n) => Number.isFinite(n) && n > 0))].sort(
        (a, b) => a - b
    );
    return `${siteId}|${ids.join(',')}`;
}

async function getArchiveParentCategoryIndex(db, siteRow, productIds) {
    const siteId = Number(siteRow && siteRow.id);
    const cms = String((siteRow && siteRow.cms_type) || '').toLowerCase();
    const now = Date.now();
    const key = indexCacheKey(siteId, productIds);
    const hit = cache.get(key);
    if (hit && now - hit.ts < CACHE_MS) return hit.index;
    const empty = { byProduct: new Map(), rootNames: new Map() };
    if (cms !== 'webasyst' || !productIds || !productIds.length) {
        cache.set(key, { ts: now, index: empty });
        return empty;
    }
    const conn = await openCmsDbConnection(siteRow, { appDb: db, connectTimeout: 8000 });
    try {
        const index = await loadWebasystIndex(conn, productIds);
        cache.set(key, { ts: now, index });
        return index;
    } finally {
        try {
            await conn.end();
        } catch (_) {}
    }
}

function summarizeParentCategories(index, rows) {
    const counts = new Map();
    for (const row of rows || []) {
        const pid = Number(row.cms_id);
        const n = Number(row.n) || 0;
        const roots = index && index.byProduct ? index.byProduct.get(pid) : null;
        if (!roots || !n) continue;
        for (const rid of roots) counts.set(rid, (counts.get(rid) || 0) + n);
    }
    const names = (index && index.rootNames) || new Map();
    return [...counts.entries()]
        .map(([id, count]) => ({ id, name: names.get(id) || '', count }))
        .filter((row) => row.count > 0 && row.name)
        .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'ru'));
}

function productIdsForRoot(index, rootId) {
    const want = Number(rootId);
    const out = [];
    if (!index || !index.byProduct || !Number.isFinite(want) || want <= 0) return out;
    for (const [pid, roots] of index.byProduct) {
        if (roots.has(want)) out.push(pid);
    }
    return out;
}

/** Корневые категории товара для колонки/API архива. */
function parentCategoryLabelsForProduct(index, cmsProductId) {
    const pid = Number(cmsProductId);
    const roots = index && index.byProduct ? index.byProduct.get(pid) : null;
    if (!roots || !roots.size) {
        return { parent_category_ids: [], parent_category_names: [], parent_category_name: null };
    }
    const names = index.rootNames || new Map();
    const ids = [];
    const labelParts = [];
    for (const rid of roots) {
        ids.push(rid);
        const name = names.get(rid);
        if (name) labelParts.push(name);
    }
    labelParts.sort((a, b) => a.localeCompare(b, 'ru'));
    return {
        parent_category_ids: ids,
        parent_category_names: labelParts,
        parent_category_name: labelParts.length ? labelParts.join(', ') : null,
    };
}

module.exports = {
    getArchiveParentCategoryIndex,
    summarizeParentCategories,
    productIdsForRoot,
    parentCategoryLabelsForProduct,
};
