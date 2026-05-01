const express = require('express');
const router = express.Router();

/** In-memory кэш списка результатов (как MY_PRODUCTS_CACHE в routes/myproducts.js). */
const RESULTS_LIST_CACHE_TTL_MS = 120000;
const resultsListResponseCache = new Map();

function resultsListCacheKey(query, effectiveLimit, effectiveOffset) {
    return JSON.stringify({
        project_id: query.project_id != null ? String(query.project_id) : '',
        page_status: query.page_status != null ? String(query.page_status) : '',
        search: String(query.search ?? '').trim(),
        matched: query.matched != null ? String(query.matched) : '',
        availability: query.availability != null ? String(query.availability) : '',
        project_name: String(query.project_name ?? '').trim(),
        price_min: query.price_min != null ? String(query.price_min) : '',
        price_max: query.price_max != null ? String(query.price_max) : '',
        limit: Number(effectiveLimit),
        offset: Number(effectiveOffset),
        sort_by: query.sort_by != null ? String(query.sort_by) : '',
        sort_dir: query.sort_dir != null ? String(query.sort_dir) : '',
    });
}

function pruneResultsListCache() {
    if (resultsListResponseCache.size <= 200) return;
    const now = Date.now();
    for (const [k, v] of resultsListResponseCache.entries()) {
        if (!v || now - Number(v.ts || 0) > RESULTS_LIST_CACHE_TTL_MS) {
            resultsListResponseCache.delete(k);
        }
    }
    if (resultsListResponseCache.size > 200) {
        const firstKey = resultsListResponseCache.keys().next().value;
        if (firstKey) resultsListResponseCache.delete(firstKey);
    }
}

function invalidateResultsListCache() {
    resultsListResponseCache.clear();
}

/**
 * Кэш статуса страницы на prices — иначе ORDER BY pg.status тянет filesort по всему JOIN (десятки секунд).
 * Синхронизация: триггер на UPDATE pages + значение при INSERT в prices.
 */
let resultsListPerfReady = false;
let resultsPricesPscBackfilled = false;

async function ensureResultsListPerf(db) {
    if (resultsListPerfReady) return;
    try {
        const [colRows] = await db.query(
            `SELECT COUNT(*) AS cnt
             FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE()
               AND TABLE_NAME = 'prices'
               AND COLUMN_NAME = 'page_status_cached'`
        );
        if (!colRows[0] || Number(colRows[0].cnt) === 0) {
            await db.query('ALTER TABLE prices ADD COLUMN page_status_cached VARCHAR(40) NULL');
        }
    } catch (e) {
        console.warn('[results] page_status_cached column:', e.message);
    }

    if (!resultsPricesPscBackfilled) {
        try {
            await db.query(
                `UPDATE prices pr
                 INNER JOIN pages pg ON pg.id = pr.page_id
                 SET pr.page_status_cached = pg.status`
            );
            resultsPricesPscBackfilled = true;
        } catch (e) {
            console.warn('[results] page_status_cached backfill:', e.message);
        }
    }

    const checks = [
        {
            table: 'prices',
            name: 'idx_prices_page_id',
            ddl: 'CREATE INDEX idx_prices_page_id ON prices (page_id)',
        },
        {
            table: 'prices',
            name: 'idx_prices_project_page',
            ddl: 'CREATE INDEX idx_prices_project_page ON prices (project_id, page_id)',
        },
        {
            table: 'pages',
            name: 'idx_pages_status_id',
            ddl: 'CREATE INDEX idx_pages_status_id ON pages (status, id)',
        },
        {
            table: 'prices',
            name: 'idx_prices_psc_proj_id',
            ddl: 'CREATE INDEX idx_prices_psc_proj_id ON prices (project_id, page_status_cached, id)',
        },
        {
            table: 'prices',
            name: 'idx_prices_psc_id',
            ddl: 'CREATE INDEX idx_prices_psc_id ON prices (page_status_cached, id)',
        },
    ];
    for (const idx of checks) {
        try {
            const [rows] = await db.query(
                `SELECT 1
                 FROM information_schema.statistics
                 WHERE table_schema = DATABASE()
                   AND table_name = ?
                   AND index_name = ?
                 LIMIT 1`,
                [idx.table, idx.name]
            );
            if (!rows.length) await db.query(idx.ddl);
        } catch (_) {
            /* ignore */
        }
    }

    try {
        const [tr] = await db.query(
            `SELECT 1
             FROM information_schema.TRIGGERS
             WHERE TRIGGER_SCHEMA = DATABASE()
               AND EVENT_OBJECT_TABLE = 'pages'
               AND TRIGGER_NAME = 'dg_pages_sync_prices_page_status_au'
             LIMIT 1`
        );
        if (!tr.length) {
            await db.query('DROP TRIGGER IF EXISTS dg_pages_sync_prices_page_status_au');
            await db.query(
                `CREATE TRIGGER dg_pages_sync_prices_page_status_au
                 AFTER UPDATE ON pages
                 FOR EACH ROW
                 UPDATE prices SET page_status_cached = NEW.status WHERE page_id = NEW.id`
            );
        }
    } catch (e) {
        console.warn('[results] trigger dg_pages_sync_prices_page_status_au:', e.message);
    }

    resultsListPerfReady = true;
}

module.exports = (db, settings) => {
    // 1. Получить результаты
    router.get('/', async (req, res) => {
        try {
            await ensureResultsListPerf(db);
            const {
                project_id,
                page_status,
                search,
                matched,
                availability,
                project_name,
                price_min,
                price_max,
                limit,
                offset,
                sort_by,
                sort_dir,
            } = req.query;
            let l;
            if (limit === undefined || limit === null || String(limit).trim() === '') {
                l = parseInt(String(settings.default_limit || '100'), 10) || 100;
            } else {
                const parsed = parseInt(String(limit), 10);
                l = Number.isFinite(parsed) && parsed >= 0 ? parsed : (parseInt(String(settings.default_limit || '100'), 10) || 100);
            }
            l = Math.min(l, 25000);
            const o = parseInt(offset, 10) || 0;

            const listCacheKey = resultsListCacheKey(req.query, l, o);
            const cachedList = resultsListResponseCache.get(listCacheKey);
            if (cachedList && Date.now() - cachedList.ts < RESULTS_LIST_CACHE_TTL_MS) {
                return res.json({
                    ...cachedList.payload,
                    cache: {
                        source: 'cache',
                        age_ms: Date.now() - cachedList.ts,
                        ttl_ms: RESULTS_LIST_CACHE_TTL_MS,
                    },
                });
            }

            if (l === 0) {
                let qcOnly = `SELECT COUNT(*) as total FROM prices pr WHERE 1=1`;
                const pcOnly = [];
                if (project_id && project_id !== 'all') {
                    qcOnly += ' AND pr.project_id = ?';
                    pcOnly.push(project_id);
                }
                if (page_status && ['pending', 'processing', 'done', 'error'].includes(String(page_status).toLowerCase())) {
                    const pageStatus = String(page_status).toLowerCase();
                    qcOnly += ' AND pr.page_status_cached = ?';
                    pcOnly.push(pageStatus);
                }
                if (search && String(search).trim()) {
                    const val = `%${String(search).trim()}%`;
                    qcOnly += ' AND (pr.sku LIKE ? OR pr.product_name LIKE ?)';
                    pcOnly.push(val, val);
                }
                if (project_name && String(project_name).trim()) {
                    const pn = `%${String(project_name).trim()}%`;
                    qcOnly += ' AND EXISTS (SELECT 1 FROM projects pjn WHERE pjn.id = pr.project_id AND pjn.name LIKE ?)';
                    pcOnly.push(pn);
                }
                const pMin0 = parseFloat(String(price_min != null ? price_min : '').trim());
                if (Number.isFinite(pMin0)) {
                    qcOnly += ' AND pr.price >= ?';
                    pcOnly.push(pMin0);
                }
                const pMax0 = parseFloat(String(price_max != null ? price_max : '').trim());
                if (Number.isFinite(pMax0)) {
                    qcOnly += ' AND pr.price <= ?';
                    pcOnly.push(pMax0);
                }
                if (availability === 'in_stock') {
                    qcOnly += ' AND COALESCE(pr.is_oos, 0) = 0';
                } else if (availability === 'oos') {
                    qcOnly += ' AND COALESCE(pr.is_oos, 0) = 1';
                }
                if (matched === '1') {
                    qcOnly += ` AND EXISTS(
                    SELECT 1
                    FROM product_matches pm
                    WHERE pm.status = 'confirmed'
                      AND pm.competitor_site_id = pr.project_id
                      AND (
                        (pm.competitor_sku IS NOT NULL AND pm.competitor_sku <> '' AND pm.competitor_sku = pr.sku)
                        OR pm.competitor_name = pr.product_name
                      )
                    LIMIT 1
                )`;
                } else if (matched === '0') {
                    qcOnly += ` AND NOT EXISTS(
                    SELECT 1
                    FROM product_matches pm
                    WHERE pm.status = 'confirmed'
                      AND pm.competitor_site_id = pr.project_id
                      AND (
                        (pm.competitor_sku IS NOT NULL AND pm.competitor_sku <> '' AND pm.competitor_sku = pr.sku)
                        OR pm.competitor_name = pr.product_name
                      )
                    LIMIT 1
                )`;
                }
                const [[cntOnly]] = await db.query(qcOnly, pcOnly);
                const payloadCount = { rows: [], total: cntOnly[0].total };
                resultsListResponseCache.set(listCacheKey, { ts: Date.now(), payload: payloadCount });
                pruneResultsListCache();
                res.json({
                    ...payloadCount,
                    cache: { source: 'fresh', age_ms: 0, ttl_ms: RESULTS_LIST_CACHE_TTL_MS },
                });
                return;
            }
            const sortDir = String(sort_dir || 'desc').toLowerCase() === 'asc' ? 'ASC' : 'DESC';
            const sortFieldMap = {
                parsed_at: 'pr.parsed_at',
                page_parsed_at: 'pg.parsed_at',
                project_name: 'p.name',
                product_name: 'pr.product_name',
                sku: 'pr.sku',
                page_status: 'pr.page_status_cached',
                is_oos: 'pr.is_oos',
                price: 'pr.price',
                url: 'pr.url'
            };
            const sortField = sortFieldMap[String(sort_by || 'parsed_at')] || 'pr.parsed_at';
            
            let q = `SELECT pr.*, p.name as project_name, pg.url as page_url,
                           COALESCE(pg.status, pr.page_status_cached) as page_status, pg.last_error as page_error, pg.parsed_at as page_parsed_at,
                           EXISTS(
                               SELECT 1
                               FROM product_matches pm
                               WHERE pm.status = 'confirmed'
                                 AND pm.competitor_site_id = pr.project_id
                                 AND (
                                     (pm.competitor_sku IS NOT NULL AND pm.competitor_sku <> '' AND pm.competitor_sku = pr.sku)
                                     OR pm.competitor_name = pr.product_name
                                 )
                               LIMIT 1
                           ) AS is_matched
                     FROM prices pr 
                     JOIN projects p ON pr.project_id = p.id 
                     LEFT JOIN pages pg ON pr.page_id = pg.id 
                     WHERE 1=1`;
            let qc = `SELECT COUNT(*) as total FROM prices pr WHERE 1=1`;
            let p = [], pc = [];
            
            if (project_id && project_id !== 'all') { 
                q += ' AND pr.project_id = ?'; 
                qc += ' AND pr.project_id = ?'; 
                p.push(project_id); 
                pc.push(project_id); 
            }
            if (page_status && ['pending', 'processing', 'done', 'error'].includes(String(page_status).toLowerCase())) {
                const pageStatus = String(page_status).toLowerCase();
                q += ' AND pr.page_status_cached = ?';
                qc += ' AND pr.page_status_cached = ?';
                p.push(pageStatus);
                pc.push(pageStatus);
            }

            if (search && String(search).trim()) {
                const val = `%${String(search).trim()}%`;
                q += ' AND (pr.sku LIKE ? OR pr.product_name LIKE ?)';
                qc += ' AND (pr.sku LIKE ? OR pr.product_name LIKE ?)';
                p.push(val, val);
                pc.push(val, val);
            }
            if (project_name && String(project_name).trim()) {
                const pn = `%${String(project_name).trim()}%`;
                q += ' AND p.name LIKE ?';
                qc += ' AND EXISTS (SELECT 1 FROM projects pjn WHERE pjn.id = pr.project_id AND pjn.name LIKE ?)';
                p.push(pn);
                pc.push(pn);
            }
            const pMin = parseFloat(String(price_min != null ? price_min : '').trim());
            if (Number.isFinite(pMin)) {
                q += ' AND pr.price >= ?';
                qc += ' AND pr.price >= ?';
                p.push(pMin);
                pc.push(pMin);
            }
            const pMax = parseFloat(String(price_max != null ? price_max : '').trim());
            if (Number.isFinite(pMax)) {
                q += ' AND pr.price <= ?';
                qc += ' AND pr.price <= ?';
                p.push(pMax);
                pc.push(pMax);
            }
            if (availability === 'in_stock') {
                q += ' AND COALESCE(pr.is_oos, 0) = 0';
                qc += ' AND COALESCE(pr.is_oos, 0) = 0';
            } else if (availability === 'oos') {
                q += ' AND COALESCE(pr.is_oos, 0) = 1';
                qc += ' AND COALESCE(pr.is_oos, 0) = 1';
            }
            if (matched === '1') {
                q += ` AND EXISTS(
                    SELECT 1
                    FROM product_matches pm
                    WHERE pm.status = 'confirmed'
                      AND pm.competitor_site_id = pr.project_id
                      AND (
                        (pm.competitor_sku IS NOT NULL AND pm.competitor_sku <> '' AND pm.competitor_sku = pr.sku)
                        OR pm.competitor_name = pr.product_name
                      )
                    LIMIT 1
                )`;
                qc += ` AND EXISTS(
                    SELECT 1
                    FROM product_matches pm
                    WHERE pm.status = 'confirmed'
                      AND pm.competitor_site_id = pr.project_id
                      AND (
                        (pm.competitor_sku IS NOT NULL AND pm.competitor_sku <> '' AND pm.competitor_sku = pr.sku)
                        OR pm.competitor_name = pr.product_name
                      )
                    LIMIT 1
                )`;
            } else if (matched === '0') {
                q += ` AND NOT EXISTS(
                    SELECT 1
                    FROM product_matches pm
                    WHERE pm.status = 'confirmed'
                      AND pm.competitor_site_id = pr.project_id
                      AND (
                        (pm.competitor_sku IS NOT NULL AND pm.competitor_sku <> '' AND pm.competitor_sku = pr.sku)
                        OR pm.competitor_name = pr.product_name
                      )
                    LIMIT 1
                )`;
                qc += ` AND NOT EXISTS(
                    SELECT 1
                    FROM product_matches pm
                    WHERE pm.status = 'confirmed'
                      AND pm.competitor_site_id = pr.project_id
                      AND (
                        (pm.competitor_sku IS NOT NULL AND pm.competitor_sku <> '' AND pm.competitor_sku = pr.sku)
                        OR pm.competitor_name = pr.product_name
                      )
                    LIMIT 1
                )`;
            }
            
            q += ` ORDER BY ${sortField} ${sortDir}, pr.id DESC LIMIT ? OFFSET ?`;
            p.push(l, o);

            // Параллельно: без COUNT(*) OVER() — оконная агрегация по всему join часто на порядок медленнее двух запросов.
            const [rowsPacket, countPacket] = await Promise.all([db.query(q, p), db.query(qc, pc)]);
            const rows = rowsPacket[0];
            const total = Number(countPacket[0][0]?.total) || 0;

            const payloadRows = { rows, total };
            resultsListResponseCache.set(listCacheKey, { ts: Date.now(), payload: payloadRows });
            pruneResultsListCache();
            res.json({
                ...payloadRows,
                cache: { source: 'fresh', age_ms: 0, ttl_ms: RESULTS_LIST_CACHE_TTL_MS },
            });
        } catch (e) {
            console.error('Error fetching results:', e);
            res.status(500).json({ error: e.message });
        }
    });

    // 2. Очистить результаты
    router.post('/clear', async (req, res) => {
        try {
            const { project_id } = req.body;
            let q = 'DELETE FROM prices WHERE 1=1'; 
            let p = [];
            
            if (project_id && project_id !== 'all') { 
                q += ' AND project_id = ?'; 
                p.push(project_id); 
            }
            
            const [r] = await db.query(q, p);
            invalidateResultsListCache();
            res.json({ success: true, deleted: r.affectedRows });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // 3. Удалить одну запись
    router.delete('/:id', async (req, res) => {
        try {
            await db.query('DELETE FROM prices WHERE id = ?', [req.params.id]);
            invalidateResultsListCache();
            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    return router;
};