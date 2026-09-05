const express = require('express');
const router = express.Router();

/** In-memory кэш списка результатов (как MY_PRODUCTS_CACHE в routes/myproducts.js). */
const RESULTS_LIST_CACHE_TTL_MS = 120000;
/** Верхняя граница limit в API (раньше 25000 → OOM при большом prices + url TEXT). */
const RESULTS_LIST_MAX_LIMIT = 1500;
/** Кэшируем только «страничные» запросы; большие limit не кладём в Map. */
const RESULTS_LIST_CACHE_MAX_LIMIT = 400;
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
 * Подзапрос id из prices, у которых есть подтверждённое сопоставление.
 * Инвертированный JOIN (от ~тыс. matches), а не EXISTS по каждой строке prices —
 * иначе фильтр «Только сопоставленные» на десятках тысяч строк висит минутами.
 */
function matchedPriceIdsSubquerySql() {
    return `(
        SELECT prx.id
          FROM prices prx
         INNER JOIN product_matches pm
            ON pm.status = 'confirmed'
           AND pm.competitor_site_id = prx.project_id
           AND pm.competitor_sku IS NOT NULL
           AND pm.competitor_sku <> ''
           AND pm.competitor_sku = prx.sku
        UNION
        SELECT prx.id
          FROM prices prx
         INNER JOIN product_matches pm
            ON pm.status = 'confirmed'
           AND pm.competitor_site_id = prx.project_id
           AND pm.competitor_name IS NOT NULL
           AND pm.competitor_name <> ''
           AND pm.competitor_name = prx.product_name
    )`;
}

function sqlMatchedFilter(matched) {
    const m = String(matched == null ? '' : matched);
    if (m === '1') return ` AND pr.id IN ${matchedPriceIdsSubquerySql()}`;
    if (m === '0') return ` AND pr.id NOT IN ${matchedPriceIdsSubquerySql()}`;
    return '';
}

/**
 * Для строк текущей страницы — с чем подтверждено сопоставление (наш SKU/название/сайт).
 * Только по id страницы (≤ limit), без полного скана prices.
 */
async function attachConfirmedMatchPartners(db, rows) {
    if (!db || !Array.isArray(rows) || !rows.length) return;
    const projectIds = Array.from(
        new Set(rows.map((r) => Number(r.project_id)).filter((n) => Number.isFinite(n) && n > 0))
    );
    const skus = Array.from(new Set(rows.map((r) => String(r.sku || '').trim()).filter(Boolean)));
    const names = Array.from(
        new Set(rows.map((r) => String(r.product_name || '').trim()).filter(Boolean))
    );
    if (!projectIds.length || (!skus.length && !names.length)) {
        for (const r of rows) {
            r.match_partners = [];
            r.match_partner_count = 0;
        }
        return;
    }

    const params = [projectIds];
    const parts = [];
    if (skus.length) {
        parts.push('(pm.competitor_sku IS NOT NULL AND pm.competitor_sku <> \'\' AND pm.competitor_sku IN (?))');
        params.push(skus);
    }
    if (names.length) {
        parts.push('(pm.competitor_name IS NOT NULL AND pm.competitor_name <> \'\' AND pm.competitor_name IN (?))');
        params.push(names);
    }

    let matchRows = [];
    try {
        const [found] = await db.query(
            `SELECT pm.id AS match_id,
                    pm.competitor_site_id,
                    pm.competitor_sku,
                    pm.competitor_name,
                    pm.my_sku,
                    pm.my_product_name,
                    pm.my_site_id,
                    COALESCE(NULLIF(TRIM(ms.name), ''), CONCAT('Сайт #', pm.my_site_id)) AS my_site_name
               FROM product_matches pm
               LEFT JOIN my_sites ms ON ms.id = pm.my_site_id
              WHERE pm.status = 'confirmed'
                AND pm.competitor_site_id IN (?)
                AND (${parts.join(' OR ')})
              ORDER BY pm.id DESC
              LIMIT 2000`,
            params
        );
        matchRows = found || [];
    } catch (e) {
        console.warn('[results] attachConfirmedMatchPartners:', e && e.message ? e.message : e);
        matchRows = [];
    }

    const bySku = new Map();
    const byName = new Map();
    const pushMap = (map, key, row) => {
        const k = String(key || '').trim();
        if (!k) return;
        const site = Number(row.competitor_site_id);
        const mk = `${site}\0${k}`;
        let arr = map.get(mk);
        if (!arr) {
            arr = [];
            map.set(mk, arr);
        }
        arr.push(row);
    };
    for (const m of matchRows) {
        pushMap(bySku, m.competitor_sku, m);
        pushMap(byName, m.competitor_name, m);
    }

    const packPartner = (m) => ({
        match_id: Number(m.match_id) || null,
        my_site_id: Number(m.my_site_id) || null,
        my_site_name: String(m.my_site_name || '').trim() || null,
        my_sku: String(m.my_sku || '').trim() || null,
        my_product_name: String(m.my_product_name || '').trim() || null,
    });

    for (const r of rows) {
        const site = Number(r.project_id);
        const sku = String(r.sku || '').trim();
        const name = String(r.product_name || '').trim();
        const seen = new Set();
        const partners = [];
        const addFrom = (arr) => {
            for (const m of arr || []) {
                const id = Number(m.match_id) || 0;
                if (id && seen.has(id)) continue;
                if (id) seen.add(id);
                partners.push(packPartner(m));
            }
        };
        if (sku) addFrom(bySku.get(`${site}\0${sku}`));
        if (name) addFrom(byName.get(`${site}\0${name}`));
        r.match_partners = partners;
        r.match_partner_count = partners.length;
        if (partners.length) {
            r.is_matched = 1;
            r.match_my_sku = partners[0].my_sku;
            r.match_my_name = partners[0].my_product_name;
            r.match_my_site = partners[0].my_site_name;
            r.match_my_site_id = partners[0].my_site_id;
        } else {
            r.match_my_sku = null;
            r.match_my_name = null;
            r.match_my_site = null;
            r.match_my_site_id = null;
        }
    }
}

/**
 * Кэш статуса страницы на prices — иначе ORDER BY pg.status тянет filesort по всему JOIN (десятки секунд).
 * Синхронизация: триггер на UPDATE pages + значение при INSERT в prices.
 */
let resultsListPerfReady = false;
let resultsPricesPscBackfilled = false;
/** Полный backfill по prices не должен блокировать GET /api/results (иначе «Загрузка…» без ответа). */
let resultsPricesPscBackfillPromise = null;

function scheduleResultsPricesPscBackfill(db) {
    if (resultsPricesPscBackfilled || resultsPricesPscBackfillPromise) return;
    resultsPricesPscBackfillPromise = (async () => {
        try {
            // Чанками: полный UPDATE JOIN по ~100k prices блокирует SELECT списка.
            // Multi-table UPDATE в MySQL не принимает LIMIT — через подвыборку id.
            const chunk = 2000;
            for (;;) {
                const [r] = await db.query(
                    `UPDATE prices pr
                     INNER JOIN (
                        SELECT pr2.id AS pid, pg.status AS st
                          FROM prices pr2
                          INNER JOIN pages pg ON pg.id = pr2.page_id
                         WHERE pr2.page_status_cached IS NULL
                            OR pr2.page_status_cached <> pg.status
                         LIMIT ?
                     ) x ON x.pid = pr.id
                     SET pr.page_status_cached = x.st`,
                    [chunk]
                );
                const n = Number(r && r.affectedRows) || 0;
                if (n < 1) break;
                await new Promise((resolve) => setTimeout(resolve, 50));
            }
            resultsPricesPscBackfilled = true;
        } catch (e) {
            console.warn('[results] page_status_cached backfill:', e.message);
        } finally {
            resultsPricesPscBackfillPromise = null;
        }
    })();
}

/** Один инстанс DDL/проверок на процесс — иначе параллельные GET дублируют CREATE INDEX. */
let ensureResultsListPerfInflight = null;

async function ensureResultsListPerf(db) {
    if (resultsListPerfReady) return;
    if (!ensureResultsListPerfInflight) {
        ensureResultsListPerfInflight = runEnsureResultsListPerfOnce(db).finally(() => {
            ensureResultsListPerfInflight = null;
        });
    }
    await ensureResultsListPerfInflight;
}

async function runEnsureResultsListPerfOnce(db) {
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

    scheduleResultsPricesPscBackfill(db);

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
            table: 'prices',
            name: 'idx_prices_project_sku_parsed',
            ddl: 'CREATE INDEX idx_prices_project_sku_parsed ON prices (project_id, sku, parsed_at)',
        },
        {
            table: 'prices',
            name: 'idx_prices_project_name_parsed',
            ddl: 'CREATE INDEX idx_prices_project_name_parsed ON prices (project_id, product_name(191), parsed_at)',
        },
        {
            table: 'prices',
            name: 'idx_prices_product_name_id',
            ddl: 'CREATE INDEX idx_prices_product_name_id ON prices (product_name(191), id)',
        },
        {
            table: 'prices',
            name: 'idx_prices_parsed_at_id',
            ddl: 'CREATE INDEX idx_prices_parsed_at_id ON prices (parsed_at, id)',
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
        {
            table: 'product_matches',
            name: 'idx_pm_confirmed_comp_sku',
            ddl: 'CREATE INDEX idx_pm_confirmed_comp_sku ON product_matches (status, competitor_site_id, competitor_sku(191))',
        },
        {
            table: 'product_matches',
            name: 'idx_pm_confirmed_comp_name',
            ddl: 'CREATE INDEX idx_pm_confirmed_comp_name ON product_matches (status, competitor_site_id, competitor_name(191))',
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
            if (l > 0) l = Math.min(l, RESULTS_LIST_MAX_LIMIT);
            const o = parseInt(offset, 10) || 0;
            const allowResultsListCache = l === 0 || l <= RESULTS_LIST_CACHE_MAX_LIMIT;

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

            await ensureResultsListPerf(db);

            if (l === 0) {
                let qcOnly = `SELECT COUNT(*) as total FROM prices pr LEFT JOIN pages pg ON pr.page_id = pg.id WHERE 1=1`;
                const pcOnly = [];
                if (project_id && project_id !== 'all') {
                    qcOnly += ' AND pr.project_id = ?';
                    pcOnly.push(project_id);
                }
                if (page_status && ['pending', 'processing', 'done', 'error'].includes(String(page_status).toLowerCase())) {
                    const pageStatus = String(page_status).toLowerCase();
                    qcOnly += ' AND COALESCE(pr.page_status_cached, pg.status) = ?';
                    pcOnly.push(pageStatus);
                }
                if (search && String(search).trim()) {
                    const val = `%${String(search).trim()}%`;
                    qcOnly += ' AND (pr.sku LIKE ? OR pr.product_name LIKE ? OR pr.url LIKE ? OR COALESCE(pg.url, \'\') LIKE ?)';
                    pcOnly.push(val, val, val, val);
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
                qcOnly += sqlMatchedFilter(matched);
                const [cntRows] = await db.query(qcOnly, pcOnly);
                const payloadCount = { rows: [], total: Number(cntRows[0]?.total) || 0 };
                if (allowResultsListCache) {
                    resultsListResponseCache.set(listCacheKey, { ts: Date.now(), payload: payloadCount });
                    pruneResultsListCache();
                }
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
                page_status: 'COALESCE(pr.page_status_cached, pg.status)',
                is_oos: 'pr.is_oos',
                price: 'pr.price',
                url: 'pr.url'
            };
            const sortField = sortFieldMap[String(sort_by || 'parsed_at')] || 'pr.parsed_at';

            const joinFrom =
                'FROM prices pr JOIN projects p ON pr.project_id = p.id LEFT JOIN pages pg ON pr.page_id = pg.id WHERE 1=1';
            let qCond = '';
            // JOIN pages в COUNT нужен для статуса страницы и для поиска по URL страницы.
            const needPagesForCount =
                !!(page_status && ['pending', 'processing', 'done', 'error'].includes(String(page_status).toLowerCase())) ||
                !!(search && String(search).trim());
            let qc = needPagesForCount
                ? `SELECT COUNT(*) as total FROM prices pr LEFT JOIN pages pg ON pr.page_id = pg.id WHERE 1=1`
                : `SELECT COUNT(*) as total FROM prices pr WHERE 1=1`;
            let p = [], pc = [];
            
            if (project_id && project_id !== 'all') { 
                qCond += ' AND pr.project_id = ?'; 
                qc += ' AND pr.project_id = ?'; 
                p.push(project_id); 
                pc.push(project_id); 
            }
            if (page_status && ['pending', 'processing', 'done', 'error'].includes(String(page_status).toLowerCase())) {
                const pageStatus = String(page_status).toLowerCase();
                qCond += ' AND COALESCE(pr.page_status_cached, pg.status) = ?';
                qc += ' AND COALESCE(pr.page_status_cached, pg.status) = ?';
                p.push(pageStatus);
                pc.push(pageStatus);
            }

            if (search && String(search).trim()) {
                const val = `%${String(search).trim()}%`;
                qCond += ' AND (pr.sku LIKE ? OR pr.product_name LIKE ? OR pr.url LIKE ? OR COALESCE(pg.url, \'\') LIKE ?)';
                qc += ' AND (pr.sku LIKE ? OR pr.product_name LIKE ? OR pr.url LIKE ? OR COALESCE(pg.url, \'\') LIKE ?)';
                p.push(val, val, val, val);
                pc.push(val, val, val, val);
            }
            if (project_name && String(project_name).trim()) {
                const pn = `%${String(project_name).trim()}%`;
                qCond += ' AND p.name LIKE ?';
                qc += ' AND EXISTS (SELECT 1 FROM projects pjn WHERE pjn.id = pr.project_id AND pjn.name LIKE ?)';
                p.push(pn);
                pc.push(pn);
            }
            const pMin = parseFloat(String(price_min != null ? price_min : '').trim());
            if (Number.isFinite(pMin)) {
                qCond += ' AND pr.price >= ?';
                qc += ' AND pr.price >= ?';
                p.push(pMin);
                pc.push(pMin);
            }
            const pMax = parseFloat(String(price_max != null ? price_max : '').trim());
            if (Number.isFinite(pMax)) {
                qCond += ' AND pr.price <= ?';
                qc += ' AND pr.price <= ?';
                p.push(pMax);
                pc.push(pMax);
            }
            if (availability === 'in_stock') {
                qCond += ' AND COALESCE(pr.is_oos, 0) = 0';
                qc += ' AND COALESCE(pr.is_oos, 0) = 0';
            } else if (availability === 'oos') {
                qCond += ' AND COALESCE(pr.is_oos, 0) = 1';
                qc += ' AND COALESCE(pr.is_oos, 0) = 1';
            }
            {
                const mf = sqlMatchedFilter(matched);
                qCond += mf;
                qc += mf;
            }
            
            const orderBySql = ` ORDER BY dg_res_sort ${sortDir}, pr.id DESC LIMIT ? OFFSET ?`;
            const idSub = `SELECT pr.id, ${sortField} AS dg_res_sort ${joinFrom}${qCond}${orderBySql}`;
            const subParams = p.slice();
            const isMatchedExpr =
                matched === '0' ? '0' : matched === '1' ? '1' : 'COALESCE(dg_res_pm.dg_m, 0)';
            /** Вместо EXISTS на каждую строку страницы — один join к матчам только по id текущей страницы (тот же idSub). */
            const matchJoinSql =
                matched === '0' || matched === '1'
                    ? ''
                    : ` LEFT JOIN (
                        SELECT prm.id AS price_id, 1 AS dg_m
                        FROM prices prm
                        INNER JOIN product_matches pm ON pm.status = 'confirmed'
                          AND pm.competitor_site_id = prm.project_id
                          AND (
                            (pm.competitor_sku IS NOT NULL AND pm.competitor_sku <> '' AND pm.competitor_sku = prm.sku)
                            OR pm.competitor_name = prm.product_name
                          )
                        INNER JOIN (${idSub}) dg_res_pick ON dg_res_pick.id = prm.id
                        GROUP BY prm.id
                      ) dg_res_pm ON dg_res_pm.price_id = pr.id`;
            const q = `SELECT pr.*, p.name as project_name, pg.url as page_url,
                           COALESCE(pg.status, pr.page_status_cached) as page_status, pg.last_error as page_error, pg.parsed_at as page_parsed_at,
                           ${isMatchedExpr} AS is_matched
                     FROM prices pr 
                     JOIN projects p ON pr.project_id = p.id 
                     LEFT JOIN pages pg ON pr.page_id = pg.id 
                     INNER JOIN (${idSub}) dg_res_ids ON dg_res_ids.id = pr.id
                     ${matchJoinSql}`;
            const pRows =
                matched === '0' || matched === '1'
                    ? subParams.concat([l, o])
                    : subParams.concat([l, o, ...subParams, l, o]);

            // Параллельно: без COUNT(*) OVER() — оконная агрегация по всему join часто на порядок медленнее двух запросов.
            const [rowsPacket, countPacket] = await Promise.all([db.query(q, pRows), db.query(qc, pc)]);
            const rows = rowsPacket[0];
            const total = Number(countPacket[0][0]?.total) || 0;
            await attachConfirmedMatchPartners(db, rows);

            const payloadRows = { rows, total };
            if (allowResultsListCache) {
                resultsListResponseCache.set(listCacheKey, { ts: Date.now(), payload: payloadRows });
                pruneResultsListCache();
            }
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

    /** Стартовый прогрев индексов/DDL и фонового backfill (см. server.js setImmediate). */
    router.warmupResultsListPerf = async function warmupResultsListPerf() {
        await ensureResultsListPerf(db);
    };

    return router;
};