'use strict';

const express = require('express');
const { openCmsDbConnection } = require('../lib/datagonCmsDb');
const { deactivateProductInCms } = require('../lib/datagonCmsPriceWrite');
const { setMyProductStickers, enrichRowsWithStickersAndMs } = require('../lib/datagonMyProductStickers');
const { applySiteWarehouseStockBySiteId } = require('../lib/datagonMyProductOwnStockPriceGuard');
const {
    getArchiveParentCategoryIndex,
    summarizeParentCategories,
    productIdsForRoot,
} = require('../lib/datagonMatchArchiveCategories');

const DECISIONS = new Set(['keep', 'discontinued', 'not_supplied', 'deactivate']);
const SALES_SPECIALTY = 'Менеджер по продажам';
const CONTENT_SPECIALTY = 'Контент-Менеджер';

module.exports = function catalogReviewRouter(db) {
    const router = express.Router();

    async function ensureSchema() {
        await db.query(`
            CREATE TABLE IF NOT EXISTS dg_catalog_review (
                id INT AUTO_INCREMENT PRIMARY KEY,
                lane VARCHAR(8) NOT NULL DEFAULT 'out',
                my_site_id INT NOT NULL,
                my_product_id INT NOT NULL,
                parent_category_id INT NULL,
                parent_category_name VARCHAR(255) NULL,
                status VARCHAR(32) NOT NULL DEFAULT 'unassigned',
                decision VARCHAR(32) NULL,
                sales_user_id INT NULL,
                content_user_id INT NULL,
                decision_by INT NULL,
                decision_at DATETIME NULL,
                decision_note VARCHAR(500) NULL,
                content_note VARCHAR(500) NULL,
                stock_qty DECIMAL(18,3) NULL,
                applied_at DATETIME NULL,
                applied_by INT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                UNIQUE KEY uq_dg_catalog_review (lane, my_site_id, my_product_id),
                KEY idx_dg_catalog_review_status (lane, status),
                KEY idx_dg_catalog_review_sales (sales_user_id),
                KEY idx_dg_catalog_review_content (content_user_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        `);
        await db.query(`
            CREATE TABLE IF NOT EXISTS dg_catalog_review_owner (
                my_site_id INT NOT NULL,
                parent_category_id INT NOT NULL,
                parent_category_name VARCHAR(255) NULL,
                sales_user_id INT NULL,
                content_user_id INT NULL,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                PRIMARY KEY (my_site_id, parent_category_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        `);
    }

    function actor(req) {
        const a = req.datagonActor || {};
        return {
            id: Number(a.id) || 0,
            username: String(a.username || '').trim(),
            isAdmin: String(a.username || '') === 'admin',
        };
    }

    function parseIds(raw) {
        const list = Array.isArray(raw) ? raw : String(raw || '').split(/[,\s]+/);
        const out = [];
        const seen = new Set();
        for (const part of list) {
            const n = parseInt(String(part), 10);
            if (!Number.isFinite(n) || n <= 0 || seen.has(n)) continue;
            seen.add(n);
            out.push(n);
            if (out.length >= 500) break;
        }
        return out;
    }

    async function usersBySpecialty(name) {
        const [rows] = await db.query(
            `SELECT u.id, u.username, u.full_name, s.name AS specialty_name
               FROM users u
               INNER JOIN specialties s ON s.id = u.specialty_id
              WHERE COALESCE(u.is_archived, 0) = 0
                AND LOWER(TRIM(s.name)) = LOWER(?)
              ORDER BY COALESCE(NULLIF(TRIM(u.full_name), ''), u.username)`,
            [name]
        );
        return (rows || []).map((u) => ({
            id: Number(u.id),
            username: u.username,
            full_name: u.full_name || '',
            label: String(u.full_name || u.username || '').trim(),
            specialty_name: u.specialty_name || '',
        }));
    }

    async function loadReviewRows(ids) {
        if (!ids.length) return [];
        const [rows] = await db.query(
            `SELECT r.*, mp.sku, mp.name AS product_name, mp.price, mp.currency, mp.source_id,
                    mp.cms_product_id, mp.source_enabled, mp.site_id
               FROM dg_catalog_review r
               JOIN my_products mp ON mp.id = r.my_product_id AND mp.site_id = r.my_site_id
              WHERE r.id IN (${ids.map(() => '?').join(',')})`,
            ids
        );
        return rows || [];
    }

    async function attachStock(rows) {
        const products = (rows || []).map((r) => ({
            id: r.my_product_id,
            site_id: r.my_site_id,
            sku: r.sku,
            cms_product_id: r.cms_product_id,
            source_id: r.source_id,
        }));
        await enrichRowsWithStickersAndMs(db, products);
        await applySiteWarehouseStockBySiteId(db, products);
        const byId = new Map(products.map((p) => [Number(p.id), p]));
        for (const row of rows || []) {
            const p = byId.get(Number(row.my_product_id));
            const n = p ? Number(p.sticker_ms_stock) : NaN;
            row.stock_qty_live = Number.isFinite(n) ? n : null;
            row.sticker_discontinued = p ? p.sticker_discontinued : null;
            row.sticker_not_supplied = p ? p.sticker_not_supplied : null;
        }
        return rows;
    }

    function canSales(row, who) {
        return who.isAdmin || Number(row.sales_user_id) === who.id;
    }
    function canContent(row, who) {
        return who.isAdmin || Number(row.content_user_id) === who.id;
    }

    async function archiveSkuRows(mySiteId) {
        const [rows] = await db.query(
            `SELECT CAST(mp.cms_product_id AS UNSIGNED) AS cms_id,
                    mp.id AS my_product_id,
                    COALESCE(mp.source_enabled, 1) AS source_enabled
               FROM match_manual_archive a
               JOIN my_products mp ON mp.id = a.my_product_id AND mp.site_id = a.my_site_id
              WHERE a.my_site_id = ?
                AND mp.cms_product_id REGEXP '^[0-9]+$'`,
            [mySiteId]
        );
        const seen = new Set();
        const list = [];
        for (const row of rows || []) {
            const cms = Number(row.cms_id);
            const productId = Number(row.my_product_id);
            if (!cms || !productId || seen.has(productId)) continue;
            seen.add(productId);
            list.push({
                cms_id: cms,
                my_product_id: productId,
                source_enabled: Number(row.source_enabled) === 0 ? 0 : 1,
            });
        }
        return list;
    }

    async function loadOwnerMap(mySiteId) {
        const [rows] = await db.query(
            `SELECT parent_category_id, sales_user_id, content_user_id
               FROM dg_catalog_review_owner
              WHERE my_site_id = ?`,
            [mySiteId]
        );
        const map = new Map();
        for (const row of rows || []) {
            map.set(Number(row.parent_category_id), {
                sales_user_id: row.sales_user_id != null ? Number(row.sales_user_id) : null,
                content_user_id: row.content_user_id != null ? Number(row.content_user_id) : null,
            });
        }
        return map;
    }

    function reviewStatusForOwners(salesId, contentId) {
        return salesId && contentId ? 'with_sales' : 'unassigned';
    }

    async function applyOwnersToOpenRows(mySiteId, categoryId, salesId, contentId) {
        const status = reviewStatusForOwners(salesId, contentId);
        const [result] = await db.query(
            `UPDATE dg_catalog_review
                SET sales_user_id = ?, content_user_id = ?, status = ?, updated_at = NOW()
              WHERE lane = 'out'
                AND my_site_id = ?
                AND parent_category_id = ?
                AND decision IS NULL
                AND status IN ('unassigned', 'with_sales')`,
            [salesId, contentId, status, mySiteId, categoryId]
        );
        return Number(result?.affectedRows || 0);
    }

    async function parentCategoriesForSite(mySiteId) {
        const [sites] = await db.query('SELECT * FROM my_sites WHERE id = ? LIMIT 1', [mySiteId]);
        if (!sites.length) {
            const err = new Error('Сайт не найден');
            err.status = 404;
            throw err;
        }
        const allRows = await archiveSkuRows(mySiteId);
        const index = await getArchiveParentCategoryIndex(
            db,
            sites[0],
            [...new Set(allRows.map((row) => row.cms_id))]
        );
        const categories = summarizeParentCategories(
            index,
            allRows.map((row) => ({ cms_id: row.cms_id, n: 1 }))
        );
        return { site: sites[0], allRows, index, categories };
    }

    async function queuedProductIds(mySiteId) {
        const [rows] = await db.query(
            `SELECT my_product_id FROM dg_catalog_review WHERE lane = 'out' AND my_site_id = ?`,
            [mySiteId]
        );
        return new Set((rows || []).map((row) => Number(row.my_product_id)));
    }

    router.get('/people', async (_req, res) => {
        try {
            await ensureSchema();
            const [sales, content] = await Promise.all([
                usersBySpecialty(SALES_SPECIALTY),
                usersBySpecialty(CONTENT_SPECIALTY),
            ]);
            return res.json({ sales, content });
        } catch (e) {
            return res.status(500).json({ error: e.message });
        }
    });

    router.get('/owners', async (req, res) => {
        const mySiteId = parseInt(String(req.query.my_site_id || '2'), 10);
        if (!Number.isFinite(mySiteId) || mySiteId < 1) return res.status(400).json({ error: 'my_site_id required' });
        try {
            await ensureSchema();
            const { categories } = await parentCategoriesForSite(mySiteId);
            const owners = await loadOwnerMap(mySiteId);
            const data = categories.map((cat) => {
                const owner = owners.get(Number(cat.id)) || {};
                return {
                    id: cat.id,
                    name: cat.name,
                    count: cat.count,
                    sales_user_id: owner.sales_user_id || null,
                    content_user_id: owner.content_user_id || null,
                };
            });
            return res.json({ data, my_site_id: mySiteId });
        } catch (e) {
            const status = e && e.status ? e.status : 500;
            return res.status(status).json({ error: e.message });
        }
    });

    router.post('/owners', async (req, res) => {
        const body = req.body || {};
        const mySiteId = parseInt(String(body.my_site_id || '2'), 10);
        const items = Array.isArray(body.items) ? body.items : [];
        if (!Number.isFinite(mySiteId) || mySiteId < 1) return res.status(400).json({ error: 'my_site_id required' });
        try {
            await ensureSchema();
            let saved = 0;
            let applied = 0;
            for (const item of items) {
                const categoryId = parseInt(String(item.parent_category_id || item.id || ''), 10);
                if (!Number.isFinite(categoryId) || categoryId <= 0) continue;
                const salesId = item.sales_user_id != null && String(item.sales_user_id) !== ''
                    ? parseInt(String(item.sales_user_id), 10)
                    : null;
                const contentId = item.content_user_id != null && String(item.content_user_id) !== ''
                    ? parseInt(String(item.content_user_id), 10)
                    : null;
                const sales = Number.isFinite(salesId) && salesId > 0 ? salesId : null;
                const content = Number.isFinite(contentId) && contentId > 0 ? contentId : null;
                const name = String(item.name || '').trim().slice(0, 255) || null;
                await db.query(
                    `INSERT INTO dg_catalog_review_owner
                        (my_site_id, parent_category_id, parent_category_name, sales_user_id, content_user_id)
                     VALUES (?, ?, ?, ?, ?)
                     ON DUPLICATE KEY UPDATE
                        parent_category_name = VALUES(parent_category_name),
                        sales_user_id = VALUES(sales_user_id),
                        content_user_id = VALUES(content_user_id),
                        updated_at = NOW()`,
                    [mySiteId, categoryId, name, sales, content]
                );
                saved += 1;
                applied += await applyOwnersToOpenRows(mySiteId, categoryId, sales, content);
            }
            return res.json({ success: true, saved, applied });
        } catch (e) {
            return res.status(500).json({ error: e.message });
        }
    });

    router.get('/categories', async (req, res) => {
        const mySiteId = parseInt(String(req.query.my_site_id || '2'), 10);
        if (!Number.isFinite(mySiteId) || mySiteId < 1) return res.status(400).json({ error: 'my_site_id required' });
        try {
            await ensureSchema();
            const [sites] = await db.query('SELECT * FROM my_sites WHERE id = ? LIMIT 1', [mySiteId]);
            if (!sites.length) return res.status(404).json({ error: 'Сайт не найден' });
            const allRows = await archiveSkuRows(mySiteId);
            const queued = await queuedProductIds(mySiteId);
            const eligible = allRows.filter((row) => row.source_enabled === 1 && !queued.has(row.my_product_id));
            const counts = eligible.map((row) => ({ cms_id: row.cms_id, n: 1 }));
            const index = await getArchiveParentCategoryIndex(
                db,
                sites[0],
                [...new Set(allRows.map((row) => row.cms_id))]
            );
            return res.json({ data: summarizeParentCategories(index, counts), my_site_id: mySiteId });
        } catch (e) {
            return res.status(500).json({ error: e.message });
        }
    });

    router.get('/', async (req, res) => {
        try {
            await ensureSchema();
            const lane = String(req.query.lane || 'out') === 'in' ? 'in' : 'out';
            const who = actor(req);
            const status = String(req.query.status || '').trim();
            const mine = String(req.query.mine || (who.isAdmin ? 'all' : 'mine')).trim();
            const search = String(req.query.search || '').trim().slice(0, 120);
            const limit = Math.max(1, Math.min(parseInt(String(req.query.limit || '100'), 10) || 100, 200));
            const page = Math.max(1, parseInt(String(req.query.page || '1'), 10) || 1);
            const offset = (page - 1) * limit;
            const where = ['r.lane = ?'];
            const params = [lane];
            if (['unassigned', 'with_sales', 'with_content', 'done'].includes(status)) {
                where.push('r.status = ?');
                params.push(status);
            }
            if (mine === 'mine' && who.id) {
                where.push('(r.sales_user_id = ? OR r.content_user_id = ?)');
                params.push(who.id, who.id);
            } else if (mine === 'unassigned') {
                where.push("r.status = 'unassigned'");
            }
            if (search) {
                where.push('(mp.sku LIKE ? OR mp.name LIKE ? OR r.parent_category_name LIKE ?)');
                const v = `%${search}%`;
                params.push(v, v, v);
            }
            const from = `
                FROM dg_catalog_review r
                JOIN my_products mp ON mp.id = r.my_product_id AND mp.site_id = r.my_site_id
                LEFT JOIN users su ON su.id = r.sales_user_id
                LEFT JOIN users cu ON cu.id = r.content_user_id
                WHERE ${where.join(' AND ')}
            `;
            const [data] = await db.query(
                `SELECT r.id, r.lane, r.my_site_id, r.my_product_id, r.parent_category_id, r.parent_category_name,
                        r.status, r.decision, r.sales_user_id, r.content_user_id, r.decision_note, r.content_note,
                        r.stock_qty, r.decision_at, r.applied_at, r.created_at,
                        mp.sku, mp.name AS product_name, mp.price, mp.currency, mp.cms_product_id, mp.source_enabled,
                        COALESCE(NULLIF(TRIM(su.full_name), ''), su.username) AS sales_name,
                        COALESCE(NULLIF(TRIM(cu.full_name), ''), cu.username) AS content_name
                 ${from}
                 ORDER BY r.id DESC
                 LIMIT ? OFFSET ?`,
                [...params, limit, offset]
            );
            const [[cnt]] = await db.query(`SELECT COUNT(*) AS total ${from}`, params);
            await attachStock(data);
            return res.json({
                data,
                total: Number(cnt?.total || 0),
                page,
                limit,
                lane,
                me: who,
            });
        } catch (e) {
            return res.status(500).json({ error: e.message });
        }
    });

    router.post('/intake', async (req, res) => {
        const body = req.body || {};
        if (body.confirm !== true && String(body.confirm) !== '1') {
            return res.status(400).json({ error: 'confirm required', code: 'CONFIRM_REQUIRED' });
        }
        const mySiteId = parseInt(String(body.my_site_id || '2'), 10);
        const categoryIds = parseIds(body.parent_category_ids);
        if (!categoryIds.length) return res.status(400).json({ error: 'Выберите хотя бы одну родительскую категорию' });
        try {
            await ensureSchema();
            const [sites] = await db.query('SELECT * FROM my_sites WHERE id = ? LIMIT 1', [mySiteId]);
            if (!sites.length) return res.status(404).json({ error: 'Сайт не найден' });
            const allRows = await archiveSkuRows(mySiteId);
            const index = await getArchiveParentCategoryIndex(
                db,
                sites[0],
                [...new Set(allRows.map((row) => row.cms_id))]
            );
            const names = new Map(
                (summarizeParentCategories(index, allRows.filter((row) => row.source_enabled === 1).map((row) => ({ cms_id: row.cms_id, n: 1 }))) || [])
                    .map((c) => [c.id, c.name])
            );
            const owners = await loadOwnerMap(mySiteId);
            let added = 0;
            let skipped_existing = 0;
            let skipped_disabled = 0;
            let skipped_outside = 0;
            const values = [];
            for (const item of allRows) {
                const roots = [];
                for (const rootId of categoryIds) {
                    const members = new Set(productIdsForRoot(index, rootId));
                    if (members.has(item.cms_id)) roots.push(rootId);
                }
                if (!roots.length) {
                    skipped_outside += 1;
                    continue;
                }
                if (item.source_enabled === 0) {
                    skipped_disabled += 1;
                    continue;
                }
                const owned = roots.find((id) => owners.has(id));
                const catId = owned || roots[0];
                const owner = owners.get(catId) || {};
                const salesId = owner.sales_user_id || null;
                const contentId = owner.content_user_id || null;
                const catName = (names.get(catId) || String(catId)).slice(0, 255);
                values.push([
                    'out',
                    mySiteId,
                    item.my_product_id,
                    catId,
                    catName,
                    salesId,
                    contentId,
                    reviewStatusForOwners(salesId, contentId),
                ]);
            }
            for (let i = 0; i < values.length; i += 200) {
                const chunk = values.slice(i, i + 200);
                const [result] = await db.query(
                    `INSERT IGNORE INTO dg_catalog_review
                        (lane, my_site_id, my_product_id, parent_category_id, parent_category_name,
                         sales_user_id, content_user_id, status)
                     VALUES ?`,
                    [chunk]
                );
                const ins = Number(result?.affectedRows || 0);
                added += ins;
                skipped_existing += chunk.length - ins;
            }
            return res.json({
                success: true,
                added,
                skipped_existing,
                skipped_disabled,
                considered: values.length,
                skipped_outside,
            });
        } catch (e) {
            return res.status(500).json({ error: e.message });
        }
    });

    router.post('/assign', async (req, res) => {
        const body = req.body || {};
        const ids = parseIds(body.ids);
        if (!ids.length) return res.status(400).json({ error: 'Не выбраны строки' });
        const hasSales = Object.prototype.hasOwnProperty.call(body, 'sales_user_id');
        const hasContent = Object.prototype.hasOwnProperty.call(body, 'content_user_id');
        const salesId = hasSales && body.sales_user_id != null && String(body.sales_user_id) !== ''
            ? parseInt(String(body.sales_user_id), 10)
            : null;
        const contentId = hasContent && body.content_user_id != null && String(body.content_user_id) !== ''
            ? parseInt(String(body.content_user_id), 10)
            : null;
        if (hasSales && salesId != null && (!Number.isFinite(salesId) || salesId <= 0)) {
            return res.status(400).json({ error: 'Некорректный менеджер' });
        }
        if (hasContent && contentId != null && (!Number.isFinite(contentId) || contentId <= 0)) {
            return res.status(400).json({ error: 'Некорректный контент-менеджер' });
        }
        try {
            await ensureSchema();
            const rows = await loadReviewRows(ids);
            let updated = 0;
            for (const row of rows) {
                if (row.lane !== 'out' || row.status === 'done') continue;
                const nextSales = hasSales ? salesId : row.sales_user_id;
                const nextContent = hasContent ? contentId : row.content_user_id;
                let status = row.status;
                if (!row.decision && row.status !== 'with_content') {
                    status = nextSales && nextContent ? 'with_sales' : 'unassigned';
                }
                await db.query(
                    `UPDATE dg_catalog_review
                        SET sales_user_id = ?, content_user_id = ?, status = ?, updated_at = NOW()
                      WHERE id = ?`,
                    [nextSales || null, nextContent || null, status, row.id]
                );
                updated += 1;
            }
            return res.json({ success: true, updated });
        } catch (e) {
            return res.status(500).json({ error: e.message });
        }
    });

    router.post('/decide', async (req, res) => {
        const body = req.body || {};
        const ids = parseIds(body.ids);
        const decision = String(body.decision || '').trim();
        const note = String(body.note || '').trim().slice(0, 500);
        const confirmStock = body.confirm_stock === true || String(body.confirm_stock) === '1';
        if (!ids.length) return res.status(400).json({ error: 'Не выбраны строки' });
        if (!DECISIONS.has(decision)) return res.status(400).json({ error: 'Неизвестное решение' });
        if (decision === 'discontinued' && !note) {
            return res.status(400).json({ error: 'Для «Снят / аналог» напишите, куда разместить аналог или что взять в работу' });
        }
        try {
            await ensureSchema();
            const who = actor(req);
            const rows = await attachStock(await loadReviewRows(ids));
            const stockHits = rows.filter(
                (row) => decision === 'deactivate' && Number(row.stock_qty_live) > 0
            );
            if (stockHits.length && !confirmStock) {
                return res.status(409).json({
                    error: `На складе есть остаток у ${stockHits.length} товаров. Подтвердите вывод отдельно.`,
                    code: 'STOCK_CONFIRM',
                    count: stockHits.length,
                });
            }
            let updated = 0;
            const skipped = [];
            for (const row of rows) {
                if (row.lane !== 'out' || row.status === 'done') {
                    skipped.push(row.id);
                    continue;
                }
                if (row.status === 'with_content') {
                    if (
                        decision === 'discontinued'
                        && row.decision === 'discontinued'
                        && note
                        && (canSales(row, who) || canContent(row, who))
                    ) {
                        await db.query(
                            `UPDATE dg_catalog_review
                                SET decision_note = ?, updated_at = NOW()
                              WHERE id = ?`,
                            [note, row.id]
                        );
                        updated += 1;
                        continue;
                    }
                    skipped.push(row.id);
                    continue;
                }
                if (row.status !== 'with_sales' || !canSales(row, who)) {
                    skipped.push(row.id);
                    continue;
                }
                const status = decision === 'keep' ? 'done' : 'with_content';
                const stock = row.stock_qty_live == null ? null : row.stock_qty_live;
                await db.query(
                    `UPDATE dg_catalog_review
                        SET decision = ?, status = ?, decision_by = ?, decision_at = NOW(),
                            decision_note = ?, stock_qty = ?,
                            applied_at = IF(? = 'done', NOW(), NULL),
                            applied_by = IF(? = 'done', ?, NULL),
                            updated_at = NOW()
                      WHERE id = ?`,
                    [decision, status, who.id || null, note || null, stock, status, status, who.id || null, row.id]
                );
                updated += 1;
            }
            return res.json({ success: true, updated, skipped: skipped.length });
        } catch (e) {
            return res.status(500).json({ error: e.message });
        }
    });

    router.post('/return', async (req, res) => {
        const body = req.body || {};
        const ids = parseIds(body.ids);
        const note = String(body.note || '').trim().slice(0, 500);
        if (!ids.length) return res.status(400).json({ error: 'Не выбраны строки' });
        if (!note) return res.status(400).json({ error: 'Напишите, что вернуть менеджеру' });
        try {
            await ensureSchema();
            const who = actor(req);
            const rows = await loadReviewRows(ids);
            let updated = 0;
            for (const row of rows) {
                if (row.status !== 'with_content' || !canContent(row, who)) continue;
                await db.query(
                    `UPDATE dg_catalog_review
                        SET status = 'with_sales', content_note = ?, updated_at = NOW()
                      WHERE id = ?`,
                    [note, row.id]
                );
                updated += 1;
            }
            return res.json({ success: true, updated });
        } catch (e) {
            return res.status(500).json({ error: e.message });
        }
    });

    router.post('/apply', async (req, res) => {
        const body = req.body || {};
        const ids = parseIds(body.ids);
        const confirmStock = body.confirm_stock === true || String(body.confirm_stock) === '1';
        if (!ids.length) return res.status(400).json({ error: 'Не выбраны строки' });
        if (body.confirm !== true && String(body.confirm) !== '1') {
            return res.status(400).json({ error: 'confirm required', code: 'CONFIRM_REQUIRED' });
        }
        try {
            await ensureSchema();
            const who = actor(req);
            const rows = await attachStock(await loadReviewRows(ids));
            const stockHits = rows.filter(
                (row) => row.decision === 'deactivate' && Number(row.stock_qty_live) > 0
            );
            if (stockHits.length && !confirmStock) {
                return res.status(409).json({
                    error: `На складе есть остаток у ${stockHits.length} товаров. Подтвердите выключение.`,
                    code: 'STOCK_CONFIRM',
                    count: stockHits.length,
                });
            }
            let applied = 0;
            const errors = [];
            for (const row of rows) {
                if (row.status !== 'with_content' || !canContent(row, who)) continue;
                if (!['discontinued', 'not_supplied', 'deactivate'].includes(String(row.decision || ''))) continue;
                try {
                    const product = {
                        id: row.my_product_id,
                        site_id: row.my_site_id,
                        source_id: row.source_id,
                        cms_product_id: row.cms_product_id,
                        sku: row.sku,
                    };
                    if (row.decision === 'discontinued' || row.decision === 'not_supplied') {
                        const patch = row.decision === 'discontinued'
                            ? { sticker_discontinued: 1 }
                            : { sticker_not_supplied: 1 };
                        await setMyProductStickers(db, product, patch, {
                            action: 'update',
                            source: 'catalog-review',
                            login: who.username,
                            name: who.username,
                        });
                        const [sites] = await db.query('SELECT * FROM my_sites WHERE id = ? LIMIT 1', [row.my_site_id]);
                        const site = sites[0];
                        if (site && String(site.cms_type || '').toLowerCase() === 'webasyst') {
                            const cmsPid = Number(row.cms_product_id);
                            if (cmsPid > 0) {
                                const { syncMyProductStickersToCms } = require('../lib/datagonMyProductStickersCmsSync');
                                await syncMyProductStickersToCms(db, {
                                    siteId: row.my_site_id,
                                    cmsProductIds: [cmsPid],
                                    featuresOnly: true,
                                });
                            }
                        }
                    } else {
                        const [sites] = await db.query('SELECT * FROM my_sites WHERE id = ? LIMIT 1', [row.my_site_id]);
                        if (!sites.length) throw new Error('Сайт не найден');
                        const conn = await openCmsDbConnection(sites[0], { appDb: db, connectTimeout: 10000 });
                        try {
                            await deactivateProductInCms(conn, sites[0], product);
                        } finally {
                            try { await conn.end(); } catch (_) {}
                        }
                        await db.query(
                            `UPDATE my_products SET source_enabled = 0, updated_at = NOW() WHERE id = ? AND site_id = ?`,
                            [row.my_product_id, row.my_site_id]
                        );
                    }
                    await db.query(
                        `UPDATE dg_catalog_review
                            SET status = 'done', applied_at = NOW(), applied_by = ?, stock_qty = ?, updated_at = NOW()
                          WHERE id = ?`,
                        [who.id || null, row.stock_qty_live, row.id]
                    );
                    applied += 1;
                } catch (err) {
                    if (errors.length < 20) {
                        errors.push({ id: row.id, sku: row.sku, error: err.message || String(err) });
                    }
                }
            }
            return res.json({ success: true, applied, errors });
        } catch (e) {
            return res.status(500).json({ error: e.message });
        }
    });

    return router;
};
