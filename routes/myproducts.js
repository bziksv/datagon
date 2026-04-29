const mysql = require('mysql2/promise');
const express = require('express');
const axios = require('axios');
const router = express.Router();

let fxRatesCache = {
    usd_to_rub: 90,
    eur_to_rub: 100,
    updated_at: null,
    source: 'fallback'
};
let fxAutoUpdateStarted = false;
let myProductsPerfReady = false;
let myProductsSyncAuditReady = false;
let myProductsSourceEnabledReady = false;
const MY_PRODUCTS_CACHE_TTL_MS = 120000;
const MY_PRODUCTS_STATS_CACHE_TTL_MS = 15000;
const myProductsResponseCache = new Map();
const myProductsGapSetCache = new Map();
const myProductsStatsCache = new Map(); // key -> { rows, exp }

function normalizeMsLinkKey(value) {
    return String(value ?? '').trim().toUpperCase();
}

/** SQL: строка ms_export совпадает с товаром по коду МойСклад = source_id или = sku (как в sync МС: upper+trim). */
function sqlMsExportMatchesProduct(msAlias = 'ms', mpAlias = 'mp') {
    return `(
        UPPER(TRIM(COALESCE(${msAlias}.code,''))) = UPPER(TRIM(COALESCE(${mpAlias}.source_id,'')))
        OR (
            TRIM(COALESCE(${mpAlias}.sku,'')) <> ''
            AND UPPER(TRIM(COALESCE(${msAlias}.code,''))) = UPPER(TRIM(COALESCE(${mpAlias}.sku,'')))
        )
    )`;
}

/** JOIN-ы для связи my_products ↔ ms_export: код в ms_export уже upper+trim при синке — равенство по колонке даёт индекс. */
function sqlMyProductsMsExportJoins(mpAlias = 'mp') {
    return `
        LEFT JOIN ms_export ms_link_src ON ms_link_src.code = UPPER(TRIM(COALESCE(${mpAlias}.source_id,'')))
        LEFT JOIN ms_export ms_link_sku ON TRIM(COALESCE(${mpAlias}.sku,'')) <> ''
            AND ms_link_sku.code = UPPER(TRIM(COALESCE(${mpAlias}.sku,'')))
    `;
}

function sqlMyProductsLinkedPredicate() {
    return '(ms_link_src.code IS NOT NULL OR ms_link_sku.code IS NOT NULL)';
}

module.exports = (db, settings) => {
    if (!db) {
        console.error('[myproducts] CRITICAL: DB connection is undefined!');
        return router;
    }

    async function updateFxRates() {
        try {
            const { data } = await axios.get('https://www.cbr-xml-daily.ru/daily_json.js', { timeout: 8000 });
            const usd = Number(data?.Valute?.USD?.Value);
            const eur = Number(data?.Valute?.EUR?.Value);
            if (Number.isFinite(usd) && Number.isFinite(eur) && usd > 0 && eur > 0) {
                fxRatesCache = {
                    usd_to_rub: usd,
                    eur_to_rub: eur,
                    updated_at: new Date().toISOString(),
                    source: 'cbr'
                };
                return true;
            }
        } catch (_) {}
        return false;
    }

    function ensureFxAutoUpdater() {
        if (fxAutoUpdateStarted) return;
        fxAutoUpdateStarted = true;
        updateFxRates().catch(() => {});
        setInterval(() => {
            updateFxRates().catch(() => {});
        }, 60 * 60 * 1000);
    }

    ensureFxAutoUpdater();

    async function ensureMyProductsPerfIndexes() {
        if (myProductsPerfReady) return;
        const checks = [
            {
                table: 'product_matches',
                name: 'idx_pm_my_site_status_sku',
                ddl: 'CREATE INDEX idx_pm_my_site_status_sku ON product_matches (my_site_id, status, my_sku)'
            },
            {
                table: 'product_matches',
                name: 'idx_pm_my_site_name',
                ddl: 'CREATE INDEX idx_pm_my_site_name ON product_matches (my_site_id, my_product_name(191))'
            },
            {
                table: 'prices',
                name: 'idx_prices_project_sku_parsed',
                ddl: 'CREATE INDEX idx_prices_project_sku_parsed ON prices (project_id, sku, parsed_at)'
            },
            {
                table: 'prices',
                name: 'idx_prices_project_name_parsed',
                ddl: 'CREATE INDEX idx_prices_project_name_parsed ON prices (project_id, product_name(191), parsed_at)'
            },
            {
                table: 'my_products',
                name: 'idx_my_products_site_active_updated',
                ddl: 'CREATE INDEX idx_my_products_site_active_updated ON my_products (site_id, is_active, updated_at)'
            }
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
            } catch (_) {}
        }
        myProductsPerfReady = true;
    }

    async function ensureMyProductsSyncAuditColumns() {
        if (myProductsSyncAuditReady) return;
        const columns = [
            { name: 'comp_sync_by', ddl: 'ALTER TABLE my_products ADD COLUMN comp_sync_by VARCHAR(255) NULL' },
            { name: 'comp_sync_at', ddl: 'ALTER TABLE my_products ADD COLUMN comp_sync_at DATETIME NULL' },
            { name: 'comp_sync_note', ddl: 'ALTER TABLE my_products ADD COLUMN comp_sync_note VARCHAR(255) NULL' }
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
        myProductsSyncAuditReady = true;
    }

    async function ensureMyProductsSourceEnabledColumn() {
        if (myProductsSourceEnabledReady) return;
        const [rows] = await db.query(
            `SELECT 1
             FROM information_schema.columns
             WHERE table_schema = DATABASE()
               AND table_name = 'my_products'
               AND column_name = 'source_enabled'
             LIMIT 1`
        );
        if (!rows.length) {
            await db.query('ALTER TABLE my_products ADD COLUMN source_enabled TINYINT(1) NOT NULL DEFAULT 1');
        }
        myProductsSourceEnabledReady = true;
    }

    function resolveActorName(req) {
        const direct = String(req.headers['x-auth-username'] || '').trim();
        if (direct) return direct;
        return 'unknown';
    }

    async function resolveActorDisplayName(username) {
        const login = String(username || '').trim();
        if (!login) return 'unknown';
        try {
            const [rows] = await db.query(
                `SELECT COALESCE(NULLIF(full_name, ''), username) AS display_name
                 FROM users
                 WHERE username = ?
                 LIMIT 1`,
                [login]
            );
            return String(rows?.[0]?.display_name || login);
        } catch (_) {
            return login;
        }
    }

    function fromRub(rubValue, targetCurrency, usdRate, eurRate) {
        const n = Number(rubValue);
        if (!Number.isFinite(n)) return null;
        const cur = String(targetCurrency || 'RUB').trim().toUpperCase();
        if (cur === 'RUB' || cur === 'RUR' || cur === '₽') return n;
        if (cur === 'USD' || cur === '$') return n / Math.max(0.0001, Number(usdRate || 90));
        if (cur === 'EUR' || cur === '€') return n / Math.max(0.0001, Number(eurRate || 100));
        return n;
    }

    /**
     * Дублирует логику shopCurrencyModel::recalcProductPrimaryPrices, но для одного товара.
     * Без этого витрина продолжает показывать старые цены: списки и фильтры читают
     * shop_product.price / min_price / max_price и shop_product_skus.primary_price (в основной валюте),
     * а не только sku.price (в валюте товара).
     * @see https://developers.webasyst.ru/apps/shop-script/product-model
     */
    async function recalcWebasystProductPrimaryPrices(conn, siteCfg, productId) {
        const pid = Number(productId);
        if (!Number.isFinite(pid) || pid <= 0) return;
        const pTable = siteCfg.table_products;
        const sTable = siteCfg.wa_table_skus;
        try {
            const [curRows] = await conn.query(
                `SELECT 1 AS ok
                 FROM information_schema.tables
                 WHERE table_schema = DATABASE()
                   AND table_name = 'shop_currency'
                 LIMIT 1`
            );
            if (!curRows?.length) return;

            await conn.query(
                `UPDATE ${pTable} p
                 JOIN (
                     SELECT p2.id, MIN(ps.price) AS min_price, MAX(ps.price) AS max_price
                     FROM ${pTable} p2
                     JOIN ${sTable} ps ON ps.product_id = p2.id
                     WHERE p2.id = ?
                     GROUP BY p2.id
                 ) r ON p.id = r.id
                 JOIN shop_currency c ON c.code = p.currency
                 SET p.min_price = r.min_price * c.rate, p.max_price = r.max_price * c.rate
                 WHERE p.id = ?`,
                [pid, pid]
            );

            await conn.query(
                `UPDATE ${pTable} p
                 JOIN ${sTable} ps ON ps.product_id = p.id AND ps.id = p.sku_id
                 JOIN shop_currency c ON c.code = p.currency
                 SET p.price = ps.price * c.rate
                 WHERE p.id = ?`,
                [pid]
            );

            await conn.query(
                `UPDATE ${pTable} p
                 JOIN ${sTable} ps ON p.id = ps.product_id
                 JOIN shop_currency c ON c.code = p.currency
                 SET ps.primary_price = ps.price * c.rate
                 WHERE p.id = ?`,
                [pid]
            );
        } catch (e) {
            console.error('[myproducts] recalcWebasystProductPrimaryPrices failed:', e.message || e);
        }
    }

    async function touchWebasystProductAfterPriceUpdate(conn, siteCfg, sku) {
        const [skuRows] = await conn.query(
            `SELECT product_id
             FROM ${siteCfg.wa_table_skus}
             WHERE ${siteCfg.wa_field_sku_val} = ?
             LIMIT 1`,
            [sku]
        );
        if (!skuRows.length || !skuRows[0].product_id) return;
        const productId = Number(skuRows[0].product_id);
        if (!Number.isFinite(productId) || productId <= 0) return;

        const [skuColsRows] = await conn.query(`SHOW COLUMNS FROM ${siteCfg.wa_table_skus}`);
        const skuCols = new Set((skuColsRows || []).map((r) => String(r.Field || '').toLowerCase()));
        const skuSets = [];
        if (skuCols.has('update_datetime')) skuSets.push('update_datetime = NOW()');
        if (skuCols.has('edit_datetime')) skuSets.push('edit_datetime = NOW()');
        if (skuSets.length) {
            await conn.query(
                `UPDATE ${siteCfg.wa_table_skus}
                 SET ${skuSets.join(', ')}
                 WHERE ${siteCfg.wa_field_sku_val} = ?
                 LIMIT 1`,
                [sku]
            );
        }

        const [prodColsRows] = await conn.query(`SHOW COLUMNS FROM ${siteCfg.table_products}`);
        const cols = new Set((prodColsRows || []).map((r) => String(r.Field || '').toLowerCase()));

        const sets = [];
        const params = [];
        // Важно: не трогаем ценовые поля в shop_product (price/min_price/max_price),
        // т.к. для мультивалюты Webasyst они могут интерпретироваться в базовой валюте витрины.
        // Обновляем только служебные timestamp-поля, чтобы "пнуть" пересборку/кэш.
        if (cols.has('edit_datetime')) sets.push('edit_datetime = NOW()');
        if (cols.has('update_datetime')) sets.push('update_datetime = NOW()');
        if (cols.has('edit_date')) sets.push('edit_date = NOW()');

        if (!sets.length) return;
        await conn.query(
            `UPDATE ${siteCfg.table_products}
             SET ${sets.join(', ')}
             WHERE id = ?
             LIMIT 1`,
            [...params, productId]
        );
    }

    router.get('/fx-rates', async (req, res) => {
        const force = String(req.query.force || '0') === '1';
        if (force) {
            await updateFxRates();
        }
        return res.json({
            success: true,
            usd_to_rub: Number(fxRatesCache.usd_to_rub || 90),
            eur_to_rub: Number(fxRatesCache.eur_to_rub || 100),
            updated_at: fxRatesCache.updated_at,
            source: fxRatesCache.source || 'fallback'
        });
    });

    // 1. Список товаров (с поиском и фильтрами)
    router.get('/', async (req, res) => {
        try {
            await ensureMyProductsPerfIndexes();
            const {
                site_id,
                status,
                source_enabled,
                search,
                limit,
                offset,
                stock_min,
                stock_max,
                ms_linked = 'all',
                sort_by = 'id',
                sort_dir = 'desc',
                gap_filter_enabled = '0',
                gap_exclude_zero = '1',
                gap_competitor = 'all',
                match_audit = 'all',
                gap_min_pct,
                gap_max_pct,
                usd_to_rub,
                eur_to_rub
            } = req.query;
            const parseFlexible = (v, fallback) => {
                if (v === undefined || v === null || v === '') return fallback;
                const n = Number(String(v).replace(',', '.'));
                return Number.isFinite(n) ? n : fallback;
            };
            const l = parseInt(limit) || (settings.default_limit || 100);
            const o = parseInt(offset) || 0;
            const sortFieldMap = {
                id: 'mp.source_id',
                site: 'mp.site_id',
                sku: 'mp.sku',
                name: 'mp.name',
                price: 'mp.price',
                currency: 'mp.currency',
                stock: 'mp.stock',
                status: 'mp.is_active',
                updated: 'mp.updated_at'
            };
            const sortField = sortFieldMap[String(sort_by || '').toLowerCase()] || 'mp.id';
            const sortDirection = String(sort_dir || '').toLowerCase() === 'asc' ? 'ASC' : 'DESC';
            const customCompetitorSort = String(sort_by || '').toLowerCase();
            const matchAuditFilter = String(match_audit || 'all').toLowerCase();
            const isGapFilterEnabled = String(gap_filter_enabled || '0') === '1';
            const gapExcludeZero = String(gap_exclude_zero || '1') !== '0';
            const isCustomCompetitorSort = customCompetitorSort === 'dealmed_price' || customCompetitorSort === 'medkompleks_price';
            const needsPostFilter = isGapFilterEnabled || isCustomCompetitorSort;
            const usdRate = Math.max(0.0001, parseFlexible(usd_to_rub, Number(fxRatesCache.usd_to_rub || 90)));
            const eurRate = Math.max(0.0001, parseFlexible(eur_to_rub, Number(fxRatesCache.eur_to_rub || 100)));
            const gapMin = parseFlexible(gap_min_pct, -100);
            const gapMax = parseFlexible(gap_max_pct, 100);
            const cacheKeyObj = {
                site_id: site_id || 'all',
                status: status ?? 'all',
                search: String(search || ''),
                stock_min: Number.isFinite(Number(stock_min)) ? Number(stock_min) : null,
                stock_max: Number.isFinite(Number(stock_max)) ? Number(stock_max) : null,
                limit: l,
                offset: o,
                ms_linked,
                sort_by,
                sort_dir,
                gap_filter_enabled,
                gap_exclude_zero: gapExcludeZero ? '1' : '0',
                gap_competitor,
                match_audit,
                gap_min_pct: Number.isFinite(Number(gap_min_pct)) ? Number(gap_min_pct) : null,
                gap_max_pct: Number.isFinite(Number(gap_max_pct)) ? Number(gap_max_pct) : null,
                usd_to_rub: Number(usdRate.toFixed(6)),
                eur_to_rub: Number(eurRate.toFixed(6))
            };
            const cacheKey = JSON.stringify(cacheKeyObj);
            const cached = myProductsResponseCache.get(cacheKey);
            if (cached && (Date.now() - cached.ts) < MY_PRODUCTS_CACHE_TTL_MS) {
                return res.json({
                    ...cached.payload,
                    cache: {
                        source: 'cache',
                        age_ms: Date.now() - cached.ts,
                        ttl_ms: MY_PRODUCTS_CACHE_TTL_MS
                    }
                });
            }
            
            let q = `
                SELECT 
                    mp.*
                FROM my_products mp
                WHERE 1=1
            `;
            let qc = 'SELECT COUNT(*) as total FROM my_products mp WHERE 1=1';
            let p = [], pc = [];

            if (site_id && site_id !== 'all') { 
                q += ' AND mp.site_id = ?'; qc += ' AND mp.site_id = ?'; 
                p.push(site_id); pc.push(site_id); 
            }
            if (status !== undefined && status !== 'all') { 
                q += ' AND mp.is_active = ?'; qc += ' AND mp.is_active = ?'; 
                p.push(status); pc.push(status); 
            }
            if (source_enabled !== undefined && source_enabled !== 'all') {
                q += ' AND COALESCE(mp.source_enabled, 1) = ?';
                qc += ' AND COALESCE(mp.source_enabled, 1) = ?';
                p.push(source_enabled);
                pc.push(source_enabled);
            }
            
            if (search) {
                const rawTokens = String(search).trim().split(/\s+/).filter(Boolean).slice(0, 8);
                const tokens = rawTokens.length ? rawTokens : [String(search).trim()];
                for (const token of tokens) {
                    const like = `%${token}%`;
                    if (!isNaN(token)) {
                        q += ' AND (mp.source_id = ? OR mp.sku LIKE ? OR mp.name LIKE ?)';
                        qc += ' AND (mp.source_id = ? OR mp.sku LIKE ? OR mp.name LIKE ?)';
                        p.push(String(parseInt(token, 10)), like, like);
                        pc.push(String(parseInt(token, 10)), like, like);
                    } else {
                        q += ' AND (mp.sku LIKE ? OR mp.name LIKE ?)';
                        qc += ' AND (mp.sku LIKE ? OR mp.name LIKE ?)';
                        p.push(like, like);
                        pc.push(like, like);
                    }
                }
            }

            const stockMinNum = Number(String(stock_min ?? '').replace(',', '.'));
            if (Number.isFinite(stockMinNum)) {
                q += ' AND COALESCE(mp.stock, 0) >= ?';
                qc += ' AND COALESCE(mp.stock, 0) >= ?';
                p.push(stockMinNum);
                pc.push(stockMinNum);
            }
            const stockMaxNum = Number(String(stock_max ?? '').replace(',', '.'));
            if (Number.isFinite(stockMaxNum)) {
                q += ' AND COALESCE(mp.stock, 0) <= ?';
                qc += ' AND COALESCE(mp.stock, 0) <= ?';
                p.push(stockMaxNum);
                pc.push(stockMaxNum);
            }

            if (ms_linked === '1') {
                const cond = `EXISTS (SELECT 1 FROM ms_export ms WHERE ${sqlMsExportMatchesProduct('ms', 'mp')} LIMIT 1)`;
                q += ` AND ${cond}`;
                qc += ` AND ${cond}`;
            } else if (ms_linked === '0') {
                const cond = `NOT EXISTS (SELECT 1 FROM ms_export ms WHERE ${sqlMsExportMatchesProduct('ms', 'mp')} LIMIT 1)`;
                q += ` AND ${cond}`;
                qc += ` AND ${cond}`;
            }

            if (matchAuditFilter === 'confirmed') {
                const cond = `EXISTS(
                    SELECT 1
                    FROM product_matches pm
                    WHERE pm.status = 'confirmed'
                      AND pm.my_site_id = mp.site_id
                      AND (
                        (pm.my_sku IS NOT NULL AND pm.my_sku <> '' AND pm.my_sku = mp.sku)
                        OR pm.my_product_name = mp.name
                      )
                    LIMIT 1
                )`;
                q += ` AND ${cond}`;
                qc += ` AND ${cond}`;
            } else if (matchAuditFilter === 'unlinked') {
                const cond = `EXISTS(
                    SELECT 1
                    FROM product_matches pm
                    WHERE pm.my_site_id = mp.site_id
                      AND (
                        (pm.my_sku IS NOT NULL AND pm.my_sku <> '' AND pm.my_sku = mp.sku)
                        OR pm.my_product_name = mp.name
                      )
                      AND pm.unlinked_at IS NOT NULL
                      AND (pm.confirmed_at IS NULL OR pm.unlinked_at >= pm.confirmed_at)
                    LIMIT 1
                )`;
                q += ` AND ${cond}`;
                qc += ` AND ${cond}`;
            } else if (matchAuditFilter === 'none') {
                const cond = `NOT EXISTS(
                    SELECT 1
                    FROM product_matches pm
                    WHERE pm.my_site_id = mp.site_id
                      AND (
                        (pm.my_sku IS NOT NULL AND pm.my_sku <> '' AND pm.my_sku = mp.sku)
                        OR pm.my_product_name = mp.name
                      )
                    LIMIT 1
                )`;
                q += ` AND ${cond}`;
                qc += ` AND ${cond}`;
            }
            const qBase = q;
            q += ` ORDER BY ${sortField} ${sortDirection}`;
            const qPaged = `${q} LIMIT ? OFFSET ?`;
            const pPaged = [...p, l, o];
            
            let rows;
            let count;
            try {
                if (needsPostFilter) {
                    [rows] = await db.query(`${qBase} ORDER BY mp.id DESC`, p);
                    count = [{ total: rows.length }];
                } else {
                    [rows] = await db.query(qPaged, pPaged);
                    [count] = await db.query(qc, pc);
                }
            } catch (queryErr) {
                const isConnectionLost = queryErr && (queryErr.code === 'PROTOCOL_CONNECTION_LOST' || queryErr.fatal);
                if (!isConnectionLost) throw queryErr;
                // One retry is enough: pool usually restores connection immediately.
                if (needsPostFilter) {
                    [rows] = await db.query(`${qBase} ORDER BY mp.id DESC`, p);
                    count = [{ total: rows.length }];
                } else {
                    [rows] = await db.query(qPaged, pPaged);
                    [count] = await db.query(qc, pc);
                }
            }
            
            let finalRows = [];
            if (isGapFilterEnabled) {
                const gapSetKey = JSON.stringify({
                    site_id: site_id || 'all',
                    status: status ?? 'all',
                    search: String(search || ''),
                    ms_linked,
                    match_audit,
                    gap_exclude_zero: gapExcludeZero ? '1' : '0',
                    gap_competitor: String(gap_competitor || 'all'),
                    gap_min_pct: Number(gapMin),
                    gap_max_pct: Number(gapMax),
                    usd_to_rub: Number(usdRate.toFixed(6)),
                    eur_to_rub: Number(eurRate.toFixed(6))
                });
                const gapCached = myProductsGapSetCache.get(gapSetKey);
                let gapRows;
                if (gapCached && (Date.now() - gapCached.ts) < MY_PRODUCTS_CACHE_TTL_MS) {
                    gapRows = gapCached.rows.map((r) => ({ ...r }));
                } else {
                    const dataRows = Array.isArray(rows) ? rows : [];
                    await enrichWithMoyskladLinks(dataRows);
                    await enrichWithCompetitorPrices(dataRows);
                    const normalizedMin = Math.min(gapMin, gapMax);
                    const normalizedMax = Math.max(gapMin, gapMax);
                    gapRows = dataRows.filter((row) => rowMatchesGapFilter(row, {
                        competitor: String(gap_competitor || 'all'),
                        excludeZero: gapExcludeZero,
                        minPct: normalizedMin,
                        maxPct: normalizedMax,
                        usdRate,
                        eurRate
                    }));
                    myProductsGapSetCache.set(gapSetKey, {
                        ts: Date.now(),
                        rows: gapRows.map((r) => ({ ...r }))
                    });
                }
                sortProductRows(gapRows, customCompetitorSort, sortDirection);
                count = [{ total: gapRows.length }];
                finalRows = gapRows.slice(o, o + l);
            } else {
                const dataRows = Array.isArray(rows) ? rows : [];
                await enrichWithMoyskladLinks(dataRows);
                await enrichWithCompetitorPrices(dataRows);
                if (isCustomCompetitorSort) {
                    sortProductRows(dataRows, customCompetitorSort, sortDirection);
                    finalRows = dataRows.slice(o, o + l);
                } else {
                    finalRows = dataRows;
                }
            }
            const payload = {
                data: finalRows,
                total: Number(count?.[0]?.total || 0),
                applied_filters: {
                    gap_enabled: isGapFilterEnabled ? 1 : 0,
                    gap_exclude_zero: gapExcludeZero ? 1 : 0,
                    gap_min_pct: Number(gapMin),
                    gap_max_pct: Number(gapMax),
                    gap_competitor: String(gap_competitor || 'all'),
                    match_audit: matchAuditFilter
                },
                cache: {
                    source: 'fresh',
                    age_ms: 0,
                    ttl_ms: MY_PRODUCTS_CACHE_TTL_MS
                }
            };
            myProductsResponseCache.set(cacheKey, { ts: Date.now(), payload });
            if (myProductsResponseCache.size > 200) {
                const now = Date.now();
                for (const [k, v] of myProductsResponseCache.entries()) {
                    if (!v || (now - Number(v.ts || 0)) > MY_PRODUCTS_CACHE_TTL_MS) {
                        myProductsResponseCache.delete(k);
                    }
                }
                if (myProductsResponseCache.size > 200) {
                    const firstKey = myProductsResponseCache.keys().next().value;
                    if (firstKey) myProductsResponseCache.delete(firstKey);
                }
            }
            res.json(payload);
        } catch (e) {
            console.error('Error fetching products:', e);
            res.status(500).json({ error: e.message });
        }
    });

    function toRub(price, currency, usdRate, eurRate) {
        const value = Number(price);
        if (!Number.isFinite(value)) return null;
        const cur = String(currency || 'RUB').trim().toUpperCase();
        if (cur === 'RUB' || cur === 'RUR' || cur === '₽') return value;
        if (cur === 'USD' || cur === '$') return value * usdRate;
        if (cur === 'EUR' || cur === '€') return value * eurRate;
        return value;
    }

    function rowMatchesGapFilter(row, cfg) {
        const myRub = toRub(row.price, row.currency, cfg.usdRate, cfg.eurRate);
        const checks = [];
        if (cfg.competitor === 'dealmed' || cfg.competitor === 'all') {
            checks.push({ price: row.dealmed_price, currency: row.dealmed_currency });
        }
        if (cfg.competitor === 'medkompleks' || cfg.competitor === 'all') {
            checks.push({ price: row.medkompleks_price, currency: row.medkompleks_currency });
        }

        // Если у нас нет своей цены (или 0), но есть цена конкурента,
        // показываем такие строки в фильтре расхождения как требующие внимания.
        if (!Number.isFinite(myRub) || myRub <= 0) {
            for (const c of checks) {
                const compRub = toRub(c.price, c.currency, cfg.usdRate, cfg.eurRate);
                if (Number.isFinite(compRub) && compRub > 0) return true;
            }
            return false;
        }

        for (const c of checks) {
            const compRub = toRub(c.price, c.currency, cfg.usdRate, cfg.eurRate);
            if (!Number.isFinite(compRub) || compRub <= 0) continue;
            const gapPct = ((myRub - compRub) / compRub) * 100;
            const isZeroGap = Math.abs(gapPct) < 0.005; // matches UI rounding to 0.00%
            if (cfg.excludeZero && isZeroGap) continue;
            if (gapPct >= cfg.minPct && gapPct <= cfg.maxPct) return true;
        }
        return false;
    }

    function sortProductRows(rows, sortBy, sortDirection) {
        if (!Array.isArray(rows) || !rows.length) return;
        const dir = sortDirection === 'ASC' ? 1 : -1;
        const field = String(sortBy || '').toLowerCase();
        const valueMap = {
            id: (r) => String(r.source_id || ''),
            site: (r) => Number(r.site_id || 0),
            sku: (r) => String(r.sku || ''),
            name: (r) => String(r.name || ''),
            price: (r) => Number(r.price || 0),
            dealmed_price: (r) => r.dealmed_price === null || r.dealmed_price === undefined ? Number.NEGATIVE_INFINITY : Number(r.dealmed_price),
            medkompleks_price: (r) => r.medkompleks_price === null || r.medkompleks_price === undefined ? Number.NEGATIVE_INFINITY : Number(r.medkompleks_price),
            currency: (r) => String(r.currency || ''),
            stock: (r) => Number(r.stock || 0),
            status: (r) => Number(r.is_active || 0),
            updated: (r) => (r.updated_at ? new Date(r.updated_at).getTime() : 0)
        };
        const getter = valueMap[field];
        if (!getter) return;
        rows.sort((a, b) => {
            const av = getter(a);
            const bv = getter(b);
            if (typeof av === 'number' && typeof bv === 'number') {
                if (av < bv) return -1 * dir;
                if (av > bv) return 1 * dir;
            } else {
                const cmp = String(av).localeCompare(String(bv), 'ru', { sensitivity: 'base' });
                if (cmp !== 0) return cmp * dir;
            }
            const asite = Number(a.site_id || 0);
            const bsite = Number(b.site_id || 0);
            if (asite !== bsite) return (asite - bsite) * dir;
            const asku = String(a.sku || '');
            const bsku = String(b.sku || '');
            if (asku !== bsku) return asku.localeCompare(bsku, 'ru', { sensitivity: 'base' }) * dir;
            const aid = Number(a.id || 0);
            const bid = Number(b.id || 0);
            if (aid !== bid) return (aid - bid) * dir;
            return 0;
        });
    }

    async function enrichWithCompetitorPrices(rows) {
        if (!Array.isArray(rows) || !rows.length) return;

        const mySiteIds = [...new Set(rows.map(r => Number(r.site_id)).filter(Number.isFinite))];
        const mySkus = [...new Set(rows.map(r => String(r.sku || '').trim()).filter(Boolean))];
        const myNamesNoSku = [...new Set(
            rows
                .filter((r) => !String(r.sku || '').trim())
                .map((r) => String(r.name || '').trim())
                .filter(Boolean)
        )];
        if (!mySiteIds.length || (!mySkus.length && !myNamesNoSku.length)) return;

        const whereParts = ['pm.status = "confirmed"'];
        const params = [...mySiteIds];
        whereParts.push(`pm.my_site_id IN (${mySiteIds.map(() => '?').join(',')})`);
        if (mySkus.length && myNamesNoSku.length) {
            whereParts.push(`(pm.my_sku IN (${mySkus.map(() => '?').join(',')}) OR pm.my_product_name IN (${myNamesNoSku.map(() => '?').join(',')}))`);
            params.push(...mySkus, ...myNamesNoSku);
        } else if (mySkus.length) {
            whereParts.push(`pm.my_sku IN (${mySkus.map(() => '?').join(',')})`);
            params.push(...mySkus);
        } else {
            whereParts.push(`pm.my_product_name IN (${myNamesNoSku.map(() => '?').join(',')})`);
            params.push(...myNamesNoSku);
        }

        const [matches] = await db.query(`
            SELECT
                pm.my_site_id,
                pm.my_sku,
                pm.my_product_name,
                pm.status,
                pm.confirmed_by,
                pm.confirmed_at,
                pm.unlinked_by,
                pm.unlinked_at,
                pm.competitor_site_id,
                pm.competitor_sku,
                pm.competitor_name,
                p.name AS competitor_project_name
            FROM product_matches pm
            JOIN projects p ON p.id = pm.competitor_site_id
            WHERE ${whereParts.join(' AND ')}
              AND (
                LOWER(p.name) LIKE '%деалмед%'
                OR LOWER(p.name) LIKE '%dealmed%'
                OR LOWER(p.name) LIKE '%медкомплекс%'
                OR LOWER(p.name) LIKE '%medkompleks%'
              )
        `, params);
        if (!matches.length) return;

        const compSiteIds = [...new Set(matches.map(m => Number(m.competitor_site_id)).filter(Number.isFinite))];
        const compSkus = [...new Set(matches.map(m => String(m.competitor_sku || '').trim()).filter(Boolean))];
        const compNames = [...new Set(matches.map(m => String(m.competitor_name || '').trim()).filter(Boolean))];

        const latestBySku = new Map();
        const latestByName = new Map();
        if (compSiteIds.length && compSkus.length) {
            const [priceBySkuRows] = await db.query(`
                SELECT project_id, sku, price, currency, url, parsed_at
                FROM prices
                WHERE project_id IN (${compSiteIds.map(() => '?').join(',')})
                  AND sku IN (${compSkus.map(() => '?').join(',')})
                ORDER BY parsed_at DESC
            `, [...compSiteIds, ...compSkus]);
            for (const pr of priceBySkuRows) {
                const key = `${pr.project_id}::${String(pr.sku || '').trim()}`;
                if (!latestBySku.has(key)) latestBySku.set(key, { price: pr.price, currency: pr.currency || 'RUB', url: pr.url || '' });
            }
        }
        if (compSiteIds.length && compNames.length) {
            const [priceByNameRows] = await db.query(`
                SELECT project_id, product_name, price, currency, url, parsed_at
                FROM prices
                WHERE project_id IN (${compSiteIds.map(() => '?').join(',')})
                  AND product_name IN (${compNames.map(() => '?').join(',')})
                ORDER BY parsed_at DESC
            `, [...compSiteIds, ...compNames]);
            for (const pr of priceByNameRows) {
                const key = `${pr.project_id}::${String(pr.product_name || '').trim()}`;
                if (!latestByName.has(key)) latestByName.set(key, { price: pr.price, currency: pr.currency || 'RUB', url: pr.url || '' });
            }
        }

        function competitorKind(name) {
            const n = String(name || '').toLowerCase();
            if (n.includes('деалмед') || n.includes('dealmed')) return 'dealmed';
            if (n.includes('медкомплекс') || n.includes('medkompleks')) return 'medkompleks';
            return '';
        }

        const matchMap = new Map();
        const auditMap = new Map();
        for (const m of matches) {
            const kind = competitorKind(m.competitor_project_name);
            const mySku = String(m.my_sku || '').trim();
            const myName = String(m.my_product_name || '').trim();
            const rowKey = `${m.my_site_id}::${mySku || myName}`;
            if (!matchMap.has(rowKey)) matchMap.set(rowKey, {});

            if (kind) {
                const skuKey = `${m.competitor_site_id}::${String(m.competitor_sku || '').trim()}`;
                const nameKey = `${m.competitor_site_id}::${String(m.competitor_name || '').trim()}`;
                const compValue = latestBySku.get(skuKey) ?? latestByName.get(nameKey) ?? null;
                matchMap.get(rowKey)[`${kind}_price`] = compValue?.price ?? null;
                matchMap.get(rowKey)[`${kind}_currency`] = compValue?.currency || null;
                matchMap.get(rowKey)[`${kind}_url`] = compValue?.url || null;
            }

            const confirmedAt = m.confirmed_at ? new Date(m.confirmed_at) : null;
            const unlinkedAt = m.unlinked_at ? new Date(m.unlinked_at) : null;
            let action = null;
            let actionAt = null;
            let actionBy = null;
            if (confirmedAt && (!unlinkedAt || confirmedAt >= unlinkedAt)) {
                action = 'confirmed';
                actionAt = confirmedAt;
                actionBy = m.confirmed_by || null;
            } else if (unlinkedAt) {
                action = 'unlinked';
                actionAt = unlinkedAt;
                actionBy = m.unlinked_by || null;
            }
            if (action && actionAt) {
                const prev = auditMap.get(rowKey);
                if (!prev || actionAt > prev.when) {
                    auditMap.set(rowKey, { action, by: actionBy, when: actionAt });
                }
            }
        }

        for (const r of rows) {
            const key = `${r.site_id}::${String(r.sku || '').trim() || String(r.name || '').trim()}`;
            const prices = matchMap.get(key) || {};
            const audit = auditMap.get(key) || null;
            r.dealmed_price = prices.dealmed_price ?? null;
            r.medkompleks_price = prices.medkompleks_price ?? null;
            r.dealmed_currency = prices.dealmed_currency ?? null;
            r.medkompleks_currency = prices.medkompleks_currency ?? null;
            r.dealmed_url = prices.dealmed_url ?? null;
            r.medkompleks_url = prices.medkompleks_url ?? null;
            r.match_last_action = audit?.action || null;
            r.match_last_by = audit?.by || null;
            r.match_last_at = audit?.when || null;
        }
    }

    async function enrichWithMoyskladLinks(rows) {
        if (!Array.isArray(rows) || !rows.length) return;
        const keys = new Set();
        for (const r of rows) {
            const a = normalizeMsLinkKey(r.source_id);
            if (a) keys.add(a);
            const b = normalizeMsLinkKey(r.sku);
            if (b) keys.add(b);
        }
        if (!keys.size) {
            rows.forEach((row) => { row.in_moysklad = 0; });
            return;
        }
        const keyList = [...keys];
        const [linkedRows] = await db.query(
            `SELECT UPPER(TRIM(COALESCE(code,''))) AS k FROM ms_export WHERE UPPER(TRIM(COALESCE(code,''))) IN (${keyList.map(() => '?').join(',')})`,
            keyList
        );
        const linked = new Set((linkedRows || []).map((row) => String(row.k || '').trim()));
        rows.forEach((r) => {
            const sid = normalizeMsLinkKey(r.source_id);
            const sku = normalizeMsLinkKey(r.sku);
            const bySource = Boolean(sid && linked.has(sid));
            const bySku = Boolean(sku && linked.has(sku));
            r.in_moysklad = bySource || bySku ? 1 : 0;
            if (bySource) r.ms_link_code = String(r.source_id || '').trim();
            else if (bySku) r.ms_link_code = String(r.sku || '').trim();
            else r.ms_link_code = '';
        });
    }

    // 2. Статистика
    router.get('/stats', async (req, res) => {
        try {
            const { site_id, status, source_enabled, ms_linked = 'all' } = req.query || {};
            const cacheKey = JSON.stringify({ site_id, status, source_enabled, ms_linked });
            const now = Date.now();
            const cached = myProductsStatsCache.get(cacheKey);
            if (cached && cached.exp > now) {
                return res.json(cached.rows);
            }

            let q = `
                SELECT
                    mp.site_id,
                    SUM(CASE WHEN mp.is_active = 1 THEN 1 ELSE 0 END) as total,
                    SUM(CASE WHEN mp.is_active = 1 AND COALESCE(mp.source_enabled, 1) = 1 THEN 1 ELSE 0 END) as active,
                    SUM(CASE WHEN mp.is_active = 1 AND COALESCE(mp.source_enabled, 1) = 0 THEN 1 ELSE 0 END) as disabled,
                    SUM(CASE WHEN mp.is_active = 0 THEN 1 ELSE 0 END) as disappeared,
                    SUM(CASE WHEN mp.is_active = 1 AND ${sqlMyProductsLinkedPredicate()} THEN 1 ELSE 0 END) as linked
                FROM my_products mp
                ${sqlMyProductsMsExportJoins('mp')}
                WHERE 1=1
            `;
            const p = [];
            if (site_id && site_id !== 'all') {
                q += ' AND mp.site_id = ?';
                p.push(site_id);
            }
            if (status !== undefined && status !== 'all') {
                q += ' AND mp.is_active = ?';
                p.push(status);
            }
            if (source_enabled !== undefined && source_enabled !== 'all') {
                q += ' AND COALESCE(mp.source_enabled, 1) = ?';
                p.push(source_enabled);
            }
            if (ms_linked === '1') {
                q += ` AND ${sqlMyProductsLinkedPredicate()}`;
            } else if (ms_linked === '0') {
                q += ` AND NOT (${sqlMyProductsLinkedPredicate()})`;
            }
            q += ' GROUP BY mp.site_id';
            const [rows] = await db.query(`
                ${q}
            `, p);
            if (myProductsStatsCache.size > 64) {
                for (const [k, v] of myProductsStatsCache) {
                    if (v.exp <= now) myProductsStatsCache.delete(k);
                }
            }
            myProductsStatsCache.set(cacheKey, { rows, exp: now + MY_PRODUCTS_STATS_CACHE_TTL_MS });
            res.json(rows);
        } catch (e) {
            res.json([]);
        }
    });

    // 3. Обновление ОДНОГО товара (Новый эндпоинт!)
    router.post('/refresh-one', async (req, res) => {
        const { site_id, sku, source_id } = req.body;
        
        if (!site_id || (!sku && !source_id)) {
            return res.status(400).json({ error: 'Не указан site_id и идентификатор товара (source_id/sku)' });
        }

        try {
            await ensureMyProductsSourceEnabledColumn();
            // Получаем настройки сайта из БД
            const [sites] = await db.query('SELECT * FROM my_sites WHERE id = ?', [site_id]);
            if (!sites.length) {
                return res.status(404).json({ error: 'Сайт не найден' });
            }
            const s = sites[0];

            // Подключаемся к удаленной базе донора
            const conn = await mysql.createConnection({
                host: s.db_host,
                user: s.db_user,
                password: s.db_pass,
                database: s.db_name,
                connectTimeout: 10000
            });

            let query = '';
            let params = [source_id || sku];

            // Формируем запрос в зависимости от CMS
            if (s.cms_type === 'webasyst') {
                query = `
                    SELECT 
                        p.id as source_id,
                        p.name,
                        sk.${s.wa_field_sku_val} as sku,
                        sk.${s.wa_field_price_val} as price,
                        p.currency,
                        sk.${s.wa_field_stock_val} as stock,
                        p.url as url_key,
                        CASE WHEN p.status = 1 THEN 1 ELSE 0 END as source_enabled
                    FROM ${s.table_products} p
                    JOIN ${s.wa_table_skus} sk ON p.id = sk.product_id
                    WHERE ${source_id ? 'p.id = ?' : `sk.${s.wa_field_sku_val} = ?`}
                    LIMIT 1
                `;
            } else if (String(s.cms_type || '').toLowerCase() === 'bitrix') {
                query = `
                    SELECT 
                        ${s.field_code} as source_id,
                        ${s.field_name} as name,
                        ${s.field_sku} as sku,
                        ${s.field_price} as price,
                        ${s.field_currency} as currency,
                        ${s.field_stock} as stock,
                        '' as url_key,
                        COALESCE(SOURCE_ENABLED, 1) as source_enabled
                    FROM ${s.table_products}
                    WHERE ${source_id ? `${s.field_code} = ?` : `${s.field_sku} = ?`}
                    LIMIT 1
                `;
            } else {
                // Bitrix или другая CMS
                query = `
                    SELECT 
                        ${s.field_code} as source_id,
                        ${s.field_name} as name,
                        ${s.field_sku} as sku,
                        ${s.field_price} as price,
                        ${s.field_currency} as currency,
                        ${s.field_stock} as stock,
                        '' as url_key,
                        1 as source_enabled
                    FROM ${s.table_products}
                    WHERE ${source_id ? `${s.field_code} = ?` : `${s.field_sku} = ?`}
                    LIMIT 1
                `;
            }
            let rows;
            try {
                [rows] = await conn.query(query, params);
            } catch (e) {
                if (!(String(s.cms_type || '').toLowerCase() === 'bitrix' && /Unknown column 'SOURCE_ENABLED'/i.test(String(e?.message || '')))) {
                    throw e;
                }
                const fallbackQuery = `
                    SELECT 
                        ${s.field_code} as source_id,
                        ${s.field_name} as name,
                        ${s.field_sku} as sku,
                        ${s.field_price} as price,
                        ${s.field_currency} as currency,
                        ${s.field_stock} as stock,
                        '' as url_key,
                        1 as source_enabled
                    FROM ${s.table_products}
                    WHERE ${source_id ? `${s.field_code} = ?` : `${s.field_sku} = ?`}
                    LIMIT 1
                `;
                [rows] = await conn.query(fallbackQuery, params);
            }
            await conn.end();

            if (rows.length === 0) {
                return res.json({ success: false, message: 'Товар не найден в базе источника' });
            }

            const r = rows[0];
            const sourceId = String(r.source_id || '').trim();
            const cleanDomain = String(s.domain || '').trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
            const rawPath = String(r.url_key || '').trim();
            let sourceUrl = '';
            if (cleanDomain && rawPath) {
                if (/^https?:\/\//i.test(rawPath)) {
                    sourceUrl = rawPath;
                } else {
                    let cleanPath = rawPath.replace(/^\/+/, '');
                    if (String(s.cms_type || '').toLowerCase() === 'webasyst') {
                        if (!cleanPath.startsWith('product/')) cleanPath = `product/${cleanPath}`;
                        if (!cleanPath.endsWith('/')) cleanPath = `${cleanPath}/`;
                    }
                    sourceUrl = `https://${cleanDomain}/${cleanPath}`;
                }
            }
            
            // Логика обновления цены в зависимости от настроек (once/always)
            let priceUpdateClause = '';
            let updateParams = [];

            if (settings.sync_mode === 'always') {
                priceUpdateClause = 'price = ?,';
                updateParams.push(r.price || 0);
            } else {
                // Режим 'once': обновляем цену только если она NULL или 0
                priceUpdateClause = 'price = IF(price IS NULL OR price = 0, ?, price),';
                updateParams.push(r.price || 0);
            }

            // Обновляем локальную запись
            const finalParams = [
                r.name || '',
                ...updateParams, // цена
                r.currency || 'RUB',
                r.stock || 0,
                sourceId,
                sourceUrl,
                Number(r.source_enabled) === 0 ? 0 : 1,
                site_id,
                sourceId
            ];

            await db.query(`
                UPDATE my_products 
                SET 
                    name = ?, 
                    ${priceUpdateClause}
                    currency = ?, 
                    stock = ?, 
                    source_id = ?,
                    source_url = ?,
                    source_enabled = ?,
                    is_active = 1, 
                    updated_at = NOW()
                WHERE site_id = ? AND source_id = ?
            `, finalParams);
            myProductsResponseCache.clear();
            myProductsGapSetCache.clear();

            res.json({ 
                success: true, 
                message: 'Товар успешно обновлен', 
                data: { 
                    price: r.price, 
                    stock: r.stock, 
                    name: r.name 
                } 
            });

        } catch (e) {
            console.error('Error refreshing single product:', e);
            res.status(500).json({ error: e.message });
        }
    });

    // 4. Обновление цены на сайте от цены конкурента с рандомным шагом
    router.post('/sync-price-from-competitor', async (req, res) => {
        const { site_id, sku, source_id, random_min_pct, random_max_pct } = req.body || {};
        if (!site_id || (!sku && !source_id)) {
            return res.status(400).json({ error: 'Не указан site_id и идентификатор товара (source_id/sku)' });
        }
        const parseFlexible = (v, fallback) => {
            if (v === undefined || v === null || v === '') return fallback;
            const n = Number(String(v).replace(',', '.'));
            return Number.isFinite(n) ? n : fallback;
        };
        const rndMin = parseFlexible(random_min_pct, 0.1);
        const rndMax = parseFlexible(random_max_pct, 1);
        const minPct = Math.max(0, Math.min(rndMin, rndMax));
        const maxPct = Math.max(0, Math.max(rndMin, rndMax));
        if (maxPct > 100) {
            return res.status(400).json({ error: 'Диапазон рандома должен быть в пределах 0..100%' });
        }

        try {
            await ensureMyProductsSyncAuditColumns();
            const siteIdNum = Number(site_id);
            let rows;
            if (source_id) {
                [rows] = await db.query(
                    'SELECT * FROM my_products WHERE site_id = ? AND source_id = ? LIMIT 1',
                    [siteIdNum, String(source_id)]
                );
            } else {
                [rows] = await db.query(
                    'SELECT * FROM my_products WHERE site_id = ? AND sku = ? LIMIT 1',
                    [siteIdNum, sku]
                );
            }
            if (!rows.length) {
                return res.status(404).json({ error: 'Товар не найден' });
            }
            const product = rows[0];
            await enrichWithCompetitorPrices([product]);

            const usdRate = Number(fxRatesCache.usd_to_rub || 90);
            const eurRate = Number(fxRatesCache.eur_to_rub || 100);

            const candidates = [];
            if (Number.isFinite(Number(product.dealmed_price)) && Number(product.dealmed_price) > 0) {
                const rub = toRub(product.dealmed_price, product.dealmed_currency || 'RUB', usdRate, eurRate);
                if (Number.isFinite(rub) && rub > 0) candidates.push({ source: 'dealmed', rub });
            }
            if (Number.isFinite(Number(product.medkompleks_price)) && Number(product.medkompleks_price) > 0) {
                const rub = toRub(product.medkompleks_price, product.medkompleks_currency || 'RUB', usdRate, eurRate);
                if (Number.isFinite(rub) && rub > 0) candidates.push({ source: 'medkompleks', rub });
            }
            if (!candidates.length) {
                return res.status(400).json({ error: 'Нет доступной цены конкурента для синхронизации' });
            }

            // Берем минимальную конкурентную цену, чтобы оставаться ниже самого дешевого конкурента.
            candidates.sort((a, b) => a.rub - b.rub);
            const selected = candidates[0];
            const randomPct = minPct + Math.random() * (maxPct - minPct);
            const targetRub = selected.rub * (1 - randomPct / 100);
            const targetInMyCurrency = fromRub(targetRub, product.currency || 'RUB', usdRate, eurRate);
            if (!Number.isFinite(targetInMyCurrency) || targetInMyCurrency <= 0) {
                return res.status(400).json({ error: 'Не удалось рассчитать целевую цену' });
            }
            // Отправляем цену без копеек: стандартное математическое округление.
            const finalPrice = Math.round(Number(targetInMyCurrency));

            const [sites] = await db.query('SELECT * FROM my_sites WHERE id = ?', [siteIdNum]);
            if (!sites.length) {
                return res.status(404).json({ error: 'Сайт не найден' });
            }
            const s = sites[0];
            const conn = await mysql.createConnection({
                host: s.db_host,
                user: s.db_user,
                password: s.db_pass,
                database: s.db_name,
                connectTimeout: 10000
            });
            try {
                if (String(s.cms_type || '').toLowerCase() === 'webasyst') {
                    const productSourceId = Number(product.source_id || 0);
                    if (!Number.isFinite(productSourceId) || productSourceId <= 0) {
                        return res.status(400).json({ error: 'Некорректный source_id для товара Webasyst' });
                    }
                    const [skuMeta] = await conn.query(
                        `SELECT product_id
                         FROM ${s.wa_table_skus}
                         WHERE product_id = ? AND ${s.wa_field_sku_val} = ?
                         LIMIT 1`,
                        [productSourceId, product.sku]
                    );
                    const waProductId = Number(skuMeta?.[0]?.product_id);
                    await conn.query(
                        `UPDATE ${s.wa_table_skus}
                         SET ${s.wa_field_price_val} = ?
                         WHERE product_id = ? AND ${s.wa_field_sku_val} = ?
                         LIMIT 1`,
                        [finalPrice, productSourceId, product.sku]
                    );
                    if (Number.isFinite(waProductId) && waProductId > 0) {
                        await recalcWebasystProductPrimaryPrices(conn, s, waProductId);
                    }
                    await touchWebasystProductAfterPriceUpdate(conn, s, product.sku);
                } else {
                    await conn.query(
                        `UPDATE ${s.table_products}
                         SET ${s.field_price} = ?
                         WHERE ${s.field_code} = ?
                         LIMIT 1`,
                        [finalPrice, String(product.source_id || '')]
                    );
                }
            } finally {
                await conn.end();
            }

            const actorLogin = resolveActorName(req);
            const actorDisplayName = await resolveActorDisplayName(actorLogin);
            await db.query(
                `UPDATE my_products
                 SET price = ?, comp_sync_by = ?, comp_sync_at = NOW(), comp_sync_note = ?, updated_at = NOW()
                 WHERE site_id = ? AND source_id = ?`,
                [
                    finalPrice,
                    actorDisplayName,
                    `from=${selected.source};rnd=${randomPct.toFixed(4)}%`,
                    siteIdNum,
                    String(product.source_id || '')
                ]
            );
            myProductsResponseCache.clear();
            myProductsGapSetCache.clear();

            return res.json({
                success: true,
                message: 'Цена обновлена от конкурента',
                data: {
                    competitor_source: selected.source,
                    competitor_price_rub: Number(selected.rub.toFixed(2)),
                    random_pct: Number(randomPct.toFixed(4)),
                    target_price: finalPrice,
                    target_currency: product.currency || 'RUB',
                    synced_by: actorDisplayName
                }
            });
        } catch (e) {
            console.error('Error syncing price from competitor:', e);
            return res.status(500).json({ error: e.message });
        }
    });

    return router;
};