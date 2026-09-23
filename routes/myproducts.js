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

/** Единый ключ кэша отбора по Δ — и для списка, и для bulk sync цен. */
function buildMyProductsGapSetKey(parts) {
    const p = parts || {};
    const stockMin = Number.isFinite(Number(p.stock_min)) ? Number(p.stock_min) : null;
    const stockMax = Number.isFinite(Number(p.stock_max)) ? Number(p.stock_max) : null;
    const r2min = p.gap_min_pct_2;
    const r2max = p.gap_max_pct_2;
    const hasR2 =
        r2min !== undefined &&
        r2min !== null &&
        r2min !== '' &&
        Number.isFinite(Number(r2min)) &&
        r2max !== undefined &&
        r2max !== null &&
        r2max !== '' &&
        Number.isFinite(Number(r2max));
    return JSON.stringify({
        site_id: p.site_id || 'all',
        status: p.status ?? 'all',
        source_enabled: p.source_enabled ?? 'all',
        search: String(p.search || ''),
        stock_min: stockMin,
        stock_max: stockMax,
        ms_linked: p.ms_linked != null ? p.ms_linked : 'all',
        match_audit: String(p.match_audit || 'all').toLowerCase(),
        gap_exclude_zero: String(p.gap_exclude_zero || '1') !== '0' ? '1' : '0',
        gap_competitor: String(p.gap_competitor || 'all'),
        gap_min_pct: Number(p.gap_min_pct),
        gap_max_pct: Number(p.gap_max_pct),
        gap_min_pct_2: hasR2 ? Number(r2min) : null,
        gap_max_pct_2: hasR2 ? Number(r2max) : null,
        usd_to_rub: Number(Number(p.usd_to_rub).toFixed(6)),
        eur_to_rub: Number(Number(p.eur_to_rub).toFixed(6))
    });
}

/** Пара Δ% (от/до). Пустая → null (диапазон не участвует). Иначе { min, max } с нормализацией. */
function parseGapPctRange(minRaw, maxRaw, fallbackMin, fallbackMax) {
    const parseOne = (v, fb) => {
        if (v === undefined || v === null || v === '') {
            return fb !== undefined ? fb : null;
        }
        const n = Number(String(v).replace(',', '.'));
        return Number.isFinite(n) ? n : fb !== undefined ? fb : null;
    };
    const a = parseOne(minRaw, fallbackMin);
    const b = parseOne(maxRaw, fallbackMax);
    if (a === null || b === null || !Number.isFinite(a) || !Number.isFinite(b)) return null;
    return { min: Math.min(a, b), max: Math.max(a, b) };
}

function buildGapFilterCfg(opts) {
    const o = opts || {};
    const range1 = parseGapPctRange(o.gap_min_pct, o.gap_max_pct, -100, 100);
    const range2 = parseGapPctRange(o.gap_min_pct_2, o.gap_max_pct_2, null, null);
    const ranges = [];
    if (range1) ranges.push(range1);
    if (range2) ranges.push(range2);
    if (!ranges.length) ranges.push({ min: -100, max: 100 });
    return {
        competitor: String(o.gap_competitor || 'all'),
        excludeZero: o.gapExcludeZero !== false && String(o.gap_exclude_zero || '1') !== '0',
        ranges,
        minPct: ranges[0].min,
        maxPct: ranges[0].max,
        minPct2: range2 ? range2.min : null,
        maxPct2: range2 ? range2.max : null,
        hasRange2: !!range2,
        usdRate: o.usdRate,
        eurRate: o.eurRate
    };
}

function normalizeMsLinkKey(value) {
    return String(value ?? '').trim().toUpperCase();
}

/** SQL: строка ms_export совпадает с товаром по коду МойСклад =
 * cms_product_id (id карточки CMS) → иначе source_id → или sku.
 * Для Webasyst нельзя матчить только по source_id (= id SKU): число совпадает
 * с чужим кодом МС (например 27284 = «Якорь», а карточка отоскопа = 18622).
 */
function sqlMsExportMatchesProduct(msAlias = 'ms', mpAlias = 'mp') {
    return `(
        UPPER(TRIM(COALESCE(${msAlias}.code,''))) = UPPER(TRIM(COALESCE(NULLIF(TRIM(COALESCE(${mpAlias}.cms_product_id,'')), ''), ${mpAlias}.source_id)))
        OR (
            TRIM(COALESCE(${mpAlias}.sku,'')) <> ''
            AND UPPER(TRIM(COALESCE(${msAlias}.code,''))) = UPPER(TRIM(COALESCE(${mpAlias}.sku,'')))
        )
    )`;
}

/** JOIN-ы для связи my_products ↔ ms_export: код в ms_export уже upper+trim при синке — равенство по колонке даёт индекс. */
function sqlMyProductsMsExportJoins(mpAlias = 'mp') {
    return `
        LEFT JOIN ms_export ms_link_src ON ms_link_src.code = UPPER(TRIM(COALESCE(NULLIF(TRIM(COALESCE(${mpAlias}.cms_product_id,'')), ''), ${mpAlias}.source_id)))
        LEFT JOIN ms_export ms_link_sku ON TRIM(COALESCE(${mpAlias}.sku,'')) <> ''
            AND ms_link_sku.code = UPPER(TRIM(COALESCE(${mpAlias}.sku,'')))
    `;
}

function sqlMyProductsLinkedPredicate() {
    return '(ms_link_src.code IS NOT NULL OR ms_link_sku.code IS NOT NULL)';
}

/**
 * Набор id my_products, связанных с product_matches (по sku или по name).
 * Без коррелированного EXISTS по всей таблице my_products — тот путь давал ~100s на COUNT.
 */
function sqlMyProductsIdsMatchedBySkuOrName(extraPmWhereSql = '') {
    const extra = extraPmWhereSql ? ` AND (${extraPmWhereSql})` : '';
    return `
        SELECT mp2.id AS mp_id
        FROM product_matches pm
        INNER JOIN my_products mp2
          ON mp2.site_id = pm.my_site_id
         AND TRIM(COALESCE(pm.my_sku, '')) <> ''
         AND mp2.sku = pm.my_sku
        WHERE 1=1${extra}
        UNION
        SELECT mp2.id AS mp_id
        FROM product_matches pm
        INNER JOIN my_products mp2
          ON mp2.site_id = pm.my_site_id
         AND mp2.name = pm.my_product_name
        WHERE 1=1${extra}
    `;
}

/** JOIN / WHERE для match_audit (confirmed|unlinked|none). Пустая строка — без фильтра. */
function sqlMatchAuditJoinAndWhere(matchAuditFilter) {
    const mode = String(matchAuditFilter || 'all').toLowerCase();
    if (mode === 'confirmed') {
        return {
            joinSql: `INNER JOIN (${sqlMyProductsIdsMatchedBySkuOrName(`pm.status = 'confirmed'`)}) dg_ma ON dg_ma.mp_id = mp.id`,
            whereSql: ''
        };
    }
    if (mode === 'unlinked') {
        return {
            joinSql: `INNER JOIN (${sqlMyProductsIdsMatchedBySkuOrName(
                `pm.unlinked_at IS NOT NULL AND (pm.confirmed_at IS NULL OR pm.unlinked_at >= pm.confirmed_at)`
            )}) dg_ma ON dg_ma.mp_id = mp.id`,
            whereSql: ''
        };
    }
    if (mode === 'none') {
        return {
            joinSql: `LEFT JOIN (${sqlMyProductsIdsMatchedBySkuOrName('')}) dg_ma ON dg_ma.mp_id = mp.id`,
            whereSql: ' AND dg_ma.mp_id IS NULL'
        };
    }
    return { joinSql: '', whereSql: '' };
}

/** Контролы фонового sync цен — заполняются при первом вызове фабрики роутера. */
let _priceCompSyncControls = null;

function myProductsRouterFactory(db, settings) {
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

    let myProductsCmsProductIdReady = false;
    async function ensureMyProductsCmsProductIdColumn() {
        if (myProductsCmsProductIdReady) return;
        const [rows] = await db.query(
            `SELECT 1
             FROM information_schema.columns
             WHERE table_schema = DATABASE()
               AND table_name = 'my_products'
               AND column_name = 'cms_product_id'
             LIMIT 1`
        );
        if (!rows.length) {
            await db.query('ALTER TABLE my_products ADD COLUMN cms_product_id VARCHAR(255) NULL');
            try {
                await db.query('CREATE INDEX idx_my_products_cms_product_id ON my_products (site_id, cms_product_id)');
            } catch (_) {}
        }
        myProductsCmsProductIdReady = true;
    }

    function resolveActorName(req) {
        const actor = req.datagonActor;
        const fromSession = actor && String(actor.username || '').trim();
        if (fromSession) return fromSession;
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
                gap_min_pct_2,
                gap_max_pct_2,
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
                id: 'COALESCE(mp.cms_product_id, mp.source_id)',
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
            const gapRange2 = parseGapPctRange(gap_min_pct_2, gap_max_pct_2, null, null);
            const cacheKeyObj = {
                site_id: site_id || 'all',
                status: status ?? 'all',
                source_enabled: source_enabled ?? 'all',
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
                gap_min_pct_2: gapRange2 ? gapRange2.min : null,
                gap_max_pct_2: gapRange2 ? gapRange2.max : null,
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

            await ensureMyProductsPerfIndexes();
            await ensureMyProductsCmsProductIdColumn();

            const matchAuditSql = sqlMatchAuditJoinAndWhere(matchAuditFilter);
            let q = `
                SELECT 
                    mp.*
                FROM my_products mp
                ${matchAuditSql.joinSql}
                WHERE 1=1
                ${matchAuditSql.whereSql}
            `;
            let qc = `SELECT COUNT(*) as total FROM my_products mp ${matchAuditSql.joinSql} WHERE 1=1${matchAuditSql.whereSql}`;
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
                        q += ' AND (mp.source_id = ? OR mp.cms_product_id = ? OR mp.sku LIKE ? OR mp.name LIKE ?)';
                        qc += ' AND (mp.source_id = ? OR mp.cms_product_id = ? OR mp.sku LIKE ? OR mp.name LIKE ?)';
                        const idTok = String(parseInt(token, 10));
                        p.push(idTok, idTok, like, like);
                        pc.push(idTok, idTok, like, like);
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
                    [[rows], [count]] = await Promise.all([
                        db.query(qPaged, pPaged),
                        db.query(qc, pc)
                    ]);
                }
            } catch (queryErr) {
                const isConnectionLost = queryErr && (queryErr.code === 'PROTOCOL_CONNECTION_LOST' || queryErr.fatal);
                if (!isConnectionLost) throw queryErr;
                // One retry is enough: pool usually restores connection immediately.
                if (needsPostFilter) {
                    [rows] = await db.query(`${qBase} ORDER BY mp.id DESC`, p);
                    count = [{ total: rows.length }];
                } else {
                    [[rows], [count]] = await Promise.all([
                        db.query(qPaged, pPaged),
                        db.query(qc, pc)
                    ]);
                }
            }
            
            let finalRows = [];
            if (isGapFilterEnabled) {
                const gapCfg = buildGapFilterCfg({
                    gap_competitor,
                    gap_exclude_zero: gapExcludeZero ? '1' : '0',
                    gapExcludeZero,
                    gap_min_pct: gapMin,
                    gap_max_pct: gapMax,
                    gap_min_pct_2,
                    gap_max_pct_2,
                    usdRate,
                    eurRate
                });
                const gapSetKey = buildMyProductsGapSetKey({
                    site_id: site_id || 'all',
                    status: status ?? 'all',
                    source_enabled: source_enabled ?? 'all',
                    search: String(search || ''),
                    stock_min: Number.isFinite(Number(stock_min)) ? Number(stock_min) : null,
                    stock_max: Number.isFinite(Number(stock_max)) ? Number(stock_max) : null,
                    ms_linked,
                    match_audit,
                    gap_exclude_zero: gapExcludeZero ? '1' : '0',
                    gap_competitor: String(gap_competitor || 'all'),
                    gap_min_pct: Number(gapMin),
                    gap_max_pct: Number(gapMax),
                    gap_min_pct_2: gapCfg.hasRange2 ? gapCfg.minPct2 : null,
                    gap_max_pct_2: gapCfg.hasRange2 ? gapCfg.maxPct2 : null,
                    usd_to_rub: Number(usdRate.toFixed(6)),
                    eur_to_rub: Number(eurRate.toFixed(6))
                });
                const gapCached = myProductsGapSetCache.get(gapSetKey);
                let gapRows;
                if (gapCached && (Date.now() - gapCached.ts) < MY_PRODUCTS_CACHE_TTL_MS) {
                    gapRows = gapCached.rows.map((r) => ({ ...r }));
                } else {
                    const dataRows = Array.isArray(rows) ? rows : [];
                    await Promise.all([
                        enrichWithMoyskladLinks(dataRows),
                        enrichWithCompetitorPrices(dataRows)
                    ]);
                    gapRows = dataRows.filter((row) => rowMatchesGapFilter(row, gapCfg));
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
                await Promise.all([
                    enrichWithMoyskladLinks(dataRows),
                    enrichWithCompetitorPrices(dataRows)
                ]);
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
                    gap_min_pct_2: gapRange2 ? gapRange2.min : null,
                    gap_max_pct_2: gapRange2 ? gapRange2.max : null,
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

        const ranges =
            Array.isArray(cfg.ranges) && cfg.ranges.length
                ? cfg.ranges
                : [{ min: cfg.minPct, max: cfg.maxPct }];

        for (const c of checks) {
            const compRub = toRub(c.price, c.currency, cfg.usdRate, cfg.eurRate);
            if (!Number.isFinite(compRub) || compRub <= 0) continue;
            const gapPct = ((myRub - compRub) / compRub) * 100;
            const isZeroGap = Math.abs(gapPct) < 0.005; // matches UI rounding to 0.00%
            if (cfg.excludeZero && isZeroGap) continue;
            for (const range of ranges) {
                const lo = Math.min(Number(range.min), Number(range.max));
                const hi = Math.max(Number(range.min), Number(range.max));
                if (gapPct >= lo && gapPct <= hi) return true;
            }
        }
        return false;
    }

    function sortProductRows(rows, sortBy, sortDirection) {
        if (!Array.isArray(rows) || !rows.length) return;
        const dir = sortDirection === 'ASC' ? 1 : -1;
        const field = String(sortBy || '').toLowerCase();
        const valueMap = {
            id: (r) => String(r.cms_product_id || r.source_id || ''),
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
            const a = normalizeMsLinkKey(r.cms_product_id || r.source_id);
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
            const idCode = String(r.cms_product_id || r.source_id || '').trim();
            const idKey = normalizeMsLinkKey(idCode);
            const sku = normalizeMsLinkKey(r.sku);
            const byId = Boolean(idKey && linked.has(idKey));
            const bySku = Boolean(sku && linked.has(sku));
            r.in_moysklad = byId || bySku ? 1 : 0;
            if (byId) r.ms_link_code = idCode;
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
            await ensureMyProductsCmsProductIdColumn();
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
                // source_id в my_products = shop_product_skus.id (модификация), не id карточки.
                query = `
                    SELECT 
                        sk.id as source_id,
                        p.id as cms_product_id,
                        p.name,
                        sk.${s.wa_field_sku_val} as sku,
                        sk.${s.wa_field_price_val} as price,
                        p.currency,
                        sk.${s.wa_field_stock_val} as stock,
                        p.url as url_key,
                        CASE WHEN p.status = 1 THEN 1 ELSE 0 END as source_enabled
                    FROM ${s.table_products} p
                    JOIN ${s.wa_table_skus} sk ON p.id = sk.product_id
                    WHERE ${source_id ? 'sk.id = ?' : `sk.${s.wa_field_sku_val} = ?`}
                    LIMIT 1
                `;
            } else if (String(s.cms_type || '').toLowerCase() === 'bitrix') {
                query = `
                    SELECT 
                        ${s.field_code} as source_id,
                        ${s.field_code} as cms_product_id,
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
                        ${s.field_code} as cms_product_id,
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
                        ${s.field_code} as cms_product_id,
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
            const cmsProductId = String(
                r.cms_product_id != null && String(r.cms_product_id).trim() !== '' ? r.cms_product_id : sourceId
            ).trim();
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
                r.sku || '',
                r.name || '',
                ...updateParams, // цена
                r.currency || 'RUB',
                r.stock || 0,
                sourceId,
                cmsProductId || null,
                sourceUrl,
                Number(r.source_enabled) === 0 ? 0 : 1,
                site_id,
                sourceId
            ];

            await db.query(`
                UPDATE my_products 
                SET 
                    sku = ?,
                    name = ?, 
                    ${priceUpdateClause}
                    currency = ?, 
                    stock = ?, 
                    source_id = ?,
                    cms_product_id = ?,
                    source_url = ?,
                    source_enabled = ?,
                    is_active = 1, 
                    updated_at = NOW()
                WHERE site_id = ? AND source_id = ?
            `, finalParams);
            myProductsResponseCache.clear();
            myProductsGapSetCache.clear();

            const [[afterRow]] = await db.query(
                `SELECT name, price, stock, currency, source_enabled, updated_at
                 FROM my_products
                 WHERE site_id = ? AND source_id = ?
                 LIMIT 1`,
                [site_id, sourceId]
            );

            res.json({
                success: true,
                message: 'Товар успешно обновлен',
                data: afterRow || {
                    price: r.price,
                    stock: r.stock,
                    name: r.name,
                    currency: r.currency || 'RUB',
                    source_enabled: Number(r.source_enabled) === 0 ? 0 : 1
                }
            });

        } catch (e) {
            console.error('Error refreshing single product:', e);
            res.status(500).json({ error: e.message });
        }
    });

    const PRICE_SYNC_CHUNK = 150;
    const PRICE_SYNC_HARD_MAX = 50000;
    const PRICE_SYNC_CMS_CONCURRENCY = 4;

    async function mapPool(items, concurrency, worker) {
        const list = Array.isArray(items) ? items : [];
        const limit = Math.max(1, Math.min(32, Number(concurrency) || 1));
        let next = 0;
        const slotCount = Math.min(limit, list.length || 1);
        const runners = [];
        for (let slot = 0; slot < slotCount; slot += 1) {
            runners.push((async () => {
                while (true) {
                    const cur = next;
                    next += 1;
                    if (cur >= list.length) return;
                    await worker(list[cur], cur, slot);
                }
            })());
        }
        await Promise.all(runners);
    }

    function parseFlexibleNumber(v, fallback) {
        if (v === undefined || v === null || v === '') return fallback;
        const n = Number(String(v).replace(',', '.'));
        return Number.isFinite(n) ? n : fallback;
    }

    function normalizeRandomPctRange(randomMinPct, randomMaxPct) {
        const rndMin = parseFlexibleNumber(randomMinPct, 0.1);
        const rndMax = parseFlexibleNumber(randomMaxPct, 0.99);
        const minPct = Math.max(0, Math.min(rndMin, rndMax));
        const maxPct = Math.max(0, Math.max(rndMin, rndMax));
        if (maxPct > 100) {
            return { error: 'Диапазон рандома должен быть в пределах 0..100%' };
        }
        return { minPct, maxPct };
    }

    function roundPriceForCurrency(value, currency) {
        const n = Number(value);
        if (!Number.isFinite(n) || n <= 0) return NaN;
        const cur = String(currency || 'RUB').trim().toUpperCase();
        // Рубли — целые; EUR/USD и пр. — 2 знака (иначе Math.round(0.14 €) → 0 и «успешная» запись нуля).
        if (cur === 'RUB' || cur === 'RUR' || cur === '₽') {
            return Math.round(n);
        }
        const cents = Math.round(n * 100) / 100;
        if (cents <= 0) return Math.ceil(n * 100) / 100;
        return cents;
    }

    function computeCompetitorTargetPrice(product, minPct, maxPct, usdRate, eurRate) {
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
            return { ok: false, error: 'Нет доступной цены конкурента для синхронизации' };
        }
        candidates.sort((a, b) => a.rub - b.rub);
        const selected = candidates[0];
        const randomPct = minPct + Math.random() * (maxPct - minPct);
        const targetRub = selected.rub * (1 - randomPct / 100);
        const targetInMyCurrency = fromRub(targetRub, product.currency || 'RUB', usdRate, eurRate);
        const finalPrice = roundPriceForCurrency(targetInMyCurrency, product.currency || 'RUB');
        if (!Number.isFinite(finalPrice) || finalPrice <= 0) {
            return {
                ok: false,
                error: `Не удалось рассчитать целевую цену (${product.currency || 'RUB'}: ${targetInMyCurrency})`
            };
        }
        return {
            ok: true,
            selected,
            randomPct,
            finalPrice
        };
    }

    async function applyPriceToCms(conn, siteCfg, product, finalPrice) {
        if (String(siteCfg.cms_type || '').toLowerCase() === 'webasyst') {
            const skuRowId = Number(product.source_id || 0);
            const skuCode = String(product.sku || '').trim();
            let skuMeta = [];
            if (Number.isFinite(skuRowId) && skuRowId > 0) {
                const [byId] = await conn.query(
                    `SELECT id, product_id
                     FROM ${siteCfg.wa_table_skus}
                     WHERE id = ?
                     LIMIT 1`,
                    [skuRowId]
                );
                skuMeta = byId;
            }
            if (!skuMeta.length && skuCode) {
                const [bySku] = await conn.query(
                    `SELECT id, product_id
                     FROM ${siteCfg.wa_table_skus}
                     WHERE ${siteCfg.wa_field_sku_val} = ?
                     LIMIT 1`,
                    [skuCode]
                );
                skuMeta = bySku;
            }
            if (!skuMeta.length) {
                const err = new Error('SKU не найден в Webasyst (source_id / артикул)');
                err.code = 'CMS_SKU_NOT_FOUND';
                throw err;
            }
            const waSkuId = Number(skuMeta[0].id);
            const waProductId = Number(skuMeta[0].product_id);
            await conn.query(
                `UPDATE ${siteCfg.wa_table_skus}
                 SET ${siteCfg.wa_field_price_val} = ?
                 WHERE id = ?
                 LIMIT 1`,
                [finalPrice, waSkuId]
            );
            if (Number.isFinite(waProductId) && waProductId > 0) {
                await recalcWebasystProductPrimaryPrices(conn, siteCfg, waProductId);
            }
            await touchWebasystProductAfterPriceUpdate(conn, siteCfg, product.sku);
            return;
        }
        await conn.query(
            `UPDATE ${siteCfg.table_products}
             SET ${siteCfg.field_price} = ?
             WHERE ${siteCfg.field_code} = ?
             LIMIT 1`,
            [finalPrice, String(product.source_id || '')]
        );
    }

    /**
     * Контекст SQL-фильтров списка Мои товары (без пагинации / без Δ в SQL).
     * Δ и цены конкурента применяются по чанкам в фоне.
     */
    async function buildPriceSyncFilterContext(raw) {
        const q = raw || {};
        const site_id = q.site_id;
        const status = q.status;
        const source_enabled = q.source_enabled;
        const search = q.search;
        const stock_min = q.stock_min;
        const stock_max = q.stock_max;
        const ms_linked = q.ms_linked != null ? q.ms_linked : 'all';
        const gap_filter_enabled = q.gap_filter_enabled != null ? q.gap_filter_enabled : '0';
        const gap_exclude_zero = q.gap_exclude_zero != null ? q.gap_exclude_zero : '1';
        const gap_competitor = q.gap_competitor != null ? q.gap_competitor : 'all';
        const match_audit = q.match_audit != null ? q.match_audit : 'all';
        const gap_min_pct = q.gap_min_pct;
        const gap_max_pct = q.gap_max_pct;
        const gap_min_pct_2 = q.gap_min_pct_2;
        const gap_max_pct_2 = q.gap_max_pct_2;
        const usd_to_rub = q.usd_to_rub;
        const eur_to_rub = q.eur_to_rub;

        const matchAuditFilter = String(match_audit || 'all').toLowerCase();
        const isGapFilterEnabled = String(gap_filter_enabled || '0') === '1';
        const gapExcludeZero = String(gap_exclude_zero || '1') !== '0';
        const usdRate = Math.max(0.0001, parseFlexibleNumber(usd_to_rub, Number(fxRatesCache.usd_to_rub || 90)));
        const eurRate = Math.max(0.0001, parseFlexibleNumber(eur_to_rub, Number(fxRatesCache.eur_to_rub || 100)));
        const gapCfg = buildGapFilterCfg({
            gap_competitor,
            gap_exclude_zero: gapExcludeZero ? '1' : '0',
            gapExcludeZero,
            gap_min_pct,
            gap_max_pct,
            gap_min_pct_2,
            gap_max_pct_2,
            usdRate,
            eurRate
        });
        const gapMin = gapCfg.minPct;
        const gapMax = gapCfg.maxPct;

        await ensureMyProductsPerfIndexes();
        await ensureMyProductsCmsProductIdColumn();

        const matchAuditSql = sqlMatchAuditJoinAndWhere(matchAuditFilter);
        let whereSql = `WHERE 1=1${matchAuditSql.whereSql}`;
        const params = [];

        if (site_id && site_id !== 'all') {
            whereSql += ' AND mp.site_id = ?';
            params.push(site_id);
        }
        if (status !== undefined && status !== null && status !== '' && status !== 'all') {
            whereSql += ' AND mp.is_active = ?';
            params.push(status);
        }
        if (source_enabled !== undefined && source_enabled !== null && source_enabled !== '' && source_enabled !== 'all') {
            whereSql += ' AND COALESCE(mp.source_enabled, 1) = ?';
            params.push(source_enabled);
        }
        if (search) {
            const rawTokens = String(search).trim().split(/\s+/).filter(Boolean).slice(0, 8);
            const tokens = rawTokens.length ? rawTokens : [String(search).trim()];
            for (const token of tokens) {
                const like = `%${token}%`;
                if (!isNaN(token)) {
                    whereSql += ' AND (mp.source_id = ? OR mp.cms_product_id = ? OR mp.sku LIKE ? OR mp.name LIKE ?)';
                    const idTok = String(parseInt(token, 10));
                    params.push(idTok, idTok, like, like);
                } else {
                    whereSql += ' AND (mp.sku LIKE ? OR mp.name LIKE ?)';
                    params.push(like, like);
                }
            }
        }
        const stockMinNum = Number(String(stock_min ?? '').replace(',', '.'));
        const stockMaxNum = Number(String(stock_max ?? '').replace(',', '.'));
        if (Number.isFinite(stockMinNum)) {
            whereSql += ' AND COALESCE(mp.stock, 0) >= ?';
            params.push(stockMinNum);
        }
        if (Number.isFinite(stockMaxNum)) {
            whereSql += ' AND COALESCE(mp.stock, 0) <= ?';
            params.push(stockMaxNum);
        }
        if (ms_linked === '1') {
            whereSql += ` AND EXISTS (SELECT 1 FROM ms_export ms WHERE ${sqlMsExportMatchesProduct('ms', 'mp')} LIMIT 1)`;
        } else if (ms_linked === '0') {
            whereSql += ` AND NOT EXISTS (SELECT 1 FROM ms_export ms WHERE ${sqlMsExportMatchesProduct('ms', 'mp')} LIMIT 1)`;
        }

        const applied_filters = {
            site_id: site_id || 'all',
            status: status ?? 'all',
            source_enabled: source_enabled ?? 'all',
            search: String(search || ''),
            ms_linked,
            match_audit: matchAuditFilter,
            gap_enabled: isGapFilterEnabled ? 1 : 0,
            gap_exclude_zero: gapExcludeZero ? 1 : 0,
            gap_competitor: String(gap_competitor || 'all'),
            gap_min_pct: Number(gapMin),
            gap_max_pct: Number(gapMax),
            gap_min_pct_2: gapCfg.hasRange2 ? gapCfg.minPct2 : null,
            gap_max_pct_2: gapCfg.hasRange2 ? gapCfg.maxPct2 : null
        };

        return {
            joinSql: matchAuditSql.joinSql,
            whereSql,
            params,
            applied_filters,
            isGapFilterEnabled,
            stock_min: Number.isFinite(stockMinNum) ? stockMinNum : null,
            stock_max: Number.isFinite(stockMaxNum) ? stockMaxNum : null,
            gapCfg,
            usdRate,
            eurRate
        };
    }

    async function countPriceSyncCandidates(ctx) {
        const [rows] = await db.query(
            `SELECT COUNT(*) AS total
             FROM my_products mp
             ${ctx.joinSql}
             ${ctx.whereSql}`,
            ctx.params
        );
        return Number(rows?.[0]?.total || 0);
    }

    /**
     * Отбор id по Δ — тот же набор, что в таблице («Найдено: N»).
     * Сначала кэш после «Применить»; иначе один проход как у списка.
     */
    async function collectPriceSyncGapMatchedIds(ctx, opts) {
        const onProgress = opts && typeof opts.onProgress === 'function' ? opts.onProgress : null;
        const shouldCancel = opts && typeof opts.shouldCancel === 'function' ? opts.shouldCancel : null;
        const af = ctx.applied_filters || {};
        const gapSetKey = buildMyProductsGapSetKey({
            site_id: af.site_id,
            status: af.status,
            source_enabled: af.source_enabled,
            search: af.search,
            stock_min: ctx.stock_min,
            stock_max: ctx.stock_max,
            ms_linked: af.ms_linked,
            match_audit: af.match_audit,
            gap_exclude_zero: af.gap_exclude_zero ? '1' : '0',
            gap_competitor: af.gap_competitor,
            gap_min_pct: af.gap_min_pct,
            gap_max_pct: af.gap_max_pct,
            gap_min_pct_2: af.gap_min_pct_2,
            gap_max_pct_2: af.gap_max_pct_2,
            usd_to_rub: ctx.usdRate,
            eur_to_rub: ctx.eurRate
        });

        if (shouldCancel && shouldCancel()) {
            return { matchedIds: [], scannedSql: 0, cancelled: true, from_cache: false };
        }

        const gapCached = myProductsGapSetCache.get(gapSetKey);
        if (gapCached && (Date.now() - gapCached.ts) < MY_PRODUCTS_CACHE_TTL_MS) {
            const matchedIds = (gapCached.rows || [])
                .map((r) => Number(r.id))
                .filter((n) => Number.isFinite(n) && n > 0);
            if (onProgress) {
                onProgress({
                    scannedSql: matchedIds.length,
                    matched: matchedIds.length,
                    from_cache: true
                });
            }
            return {
                matchedIds,
                scannedSql: matchedIds.length,
                cancelled: false,
                from_cache: true
            };
        }

        if (onProgress) {
            onProgress({ scannedSql: 0, matched: 0, from_cache: false, loading: true });
        }

        const [rows] = await db.query(
            `SELECT mp.*
             FROM my_products mp
             ${ctx.joinSql}
             ${ctx.whereSql}
             ORDER BY mp.id DESC`,
            ctx.params
        );
        if (shouldCancel && shouldCancel()) {
            return { matchedIds: [], scannedSql: 0, cancelled: true, from_cache: false };
        }
        const dataRows = Array.isArray(rows) ? rows : [];
        await enrichWithCompetitorPrices(dataRows);
        const gapRows = dataRows.filter((product) => rowMatchesGapFilter(product, ctx.gapCfg));
        myProductsGapSetCache.set(gapSetKey, {
            ts: Date.now(),
            rows: gapRows.map((r) => ({ ...r }))
        });
        const matchedIds = gapRows.map((r) => Number(r.id)).filter((n) => Number.isFinite(n) && n > 0);
        if (matchedIds.length > PRICE_SYNC_HARD_MAX) {
            const err = new Error(
                `Слишком много позиций по Δ (${matchedIds.length.toLocaleString('ru-RU')} > ${PRICE_SYNC_HARD_MAX}). Сузьте фильтры.`
            );
            err.code = 'SELECTION_TOO_LARGE';
            err.matched = matchedIds.length;
            err.scannedSql = dataRows.length;
            throw err;
        }
        if (onProgress) {
            onProgress({
                scannedSql: dataRows.length,
                matched: matchedIds.length,
                from_cache: false
            });
        }
        return {
            matchedIds,
            scannedSql: dataRows.length,
            cancelled: false,
            from_cache: false
        };
    }

    /**
     * Размер рабочей выборки для bulk sync.
     * С фильтром Δ — число строк после enrich+gap (как в таблице), иначе COUNT(*) по SQL.
     */
    async function resolvePriceSyncWorkset(ctx, opts) {
        if (!ctx.isGapFilterEnabled) {
            const totalSql = await countPriceSyncCandidates(ctx);
            return {
                total: totalSql,
                total_sql: totalSql,
                matchedIds: null,
                scannedSql: totalSql,
                skipped_gap: 0,
                gap_prefiltered: false
            };
        }
        const coll = await collectPriceSyncGapMatchedIds(ctx, opts || {});
        if (coll.cancelled) {
            return {
                total: coll.matchedIds.length,
                total_sql: coll.matchedIds.length,
                matchedIds: coll.matchedIds,
                scannedSql: coll.scannedSql,
                skipped_gap: Math.max(0, coll.scannedSql - coll.matchedIds.length),
                gap_prefiltered: true,
                from_cache: !!coll.from_cache,
                cancelled: true
            };
        }
        return {
            total: coll.matchedIds.length,
            total_sql: coll.matchedIds.length,
            matchedIds: coll.matchedIds,
            scannedSql: coll.scannedSql,
            skipped_gap: Math.max(0, (coll.from_cache ? 0 : coll.scannedSql - coll.matchedIds.length)),
            gap_prefiltered: true,
            from_cache: !!coll.from_cache,
            cancelled: false
        };
    }

    async function fetchPriceSyncByIds(ids) {
        const list = (Array.isArray(ids) ? ids : [])
            .map((x) => Number(x))
            .filter((n) => Number.isFinite(n) && n > 0);
        if (!list.length) return [];
        const [rows] = await db.query(
            `SELECT mp.*
             FROM my_products mp
             WHERE mp.id IN (${list.map(() => '?').join(',')})`,
            list
        );
        const byId = new Map((Array.isArray(rows) ? rows : []).map((r) => [Number(r.id), r]));
        return list.map((id) => byId.get(id)).filter(Boolean);
    }

    async function fetchPriceSyncChunk(ctx, cursorId, limit) {
        const lim = Math.max(1, Math.min(200, Number(limit) || PRICE_SYNC_CHUNK));
        const params = [...ctx.params];
        let sql = `
            SELECT mp.*
            FROM my_products mp
            ${ctx.joinSql}
            ${ctx.whereSql}
        `;
        // Важно: Number(null) === 0 → нельзя считать «есть курсор» через isFinite(Number(null)).
        if (cursorId != null && cursorId !== '' && Number.isFinite(Number(cursorId))) {
            sql += ' AND mp.id < ?';
            params.push(Number(cursorId));
        }
        sql += ` ORDER BY mp.id DESC LIMIT ${lim}`;
        const [rows] = await db.query(sql, params);
        return Array.isArray(rows) ? rows : [];
    }

    const priceSyncJob = {
        active: false,
        cancelRequested: false,
        job_serial: 0,
        started_at: null,
        finished_at: null,
        phase: 'idle',
        message: '',
        applied_filters: null,
        random_min_pct: 0.1,
        random_max_pct: 0.99,
        synced_by: '',
        total_sql: 0,
        scanned: 0,
        synced: 0,
        cms_ok: 0,
        cms_failed: 0,
        skipped_gap: 0,
        skipped_no_competitor: 0,
        errors: []
    };

    function priceSyncJobDurationSec() {
        if (!priceSyncJob.started_at) return 0;
        const end = priceSyncJob.finished_at ? priceSyncJob.finished_at.getTime() : Date.now();
        return Number(((end - priceSyncJob.started_at.getTime()) / 1000).toFixed(2));
    }

    function priceSyncJobPayload() {
        const skipped = Number(priceSyncJob.skipped_gap || 0) + Number(priceSyncJob.skipped_no_competitor || 0);
        return {
            active: !!priceSyncJob.active,
            cancel_requested: !!priceSyncJob.cancelRequested,
            phase: priceSyncJob.phase,
            message: priceSyncJob.message || '',
            started_at: priceSyncJob.started_at ? priceSyncJob.started_at.toISOString() : null,
            finished_at: priceSyncJob.finished_at ? priceSyncJob.finished_at.toISOString() : null,
            total_sql: Number(priceSyncJob.total_sql || 0),
            total: Number(priceSyncJob.total_sql || 0),
            scanned: Number(priceSyncJob.scanned || 0),
            synced: Number(priceSyncJob.synced || 0),
            cms_ok: Number(priceSyncJob.cms_ok || 0),
            cms_failed: Number(priceSyncJob.cms_failed || 0),
            skipped_gap: Number(priceSyncJob.skipped_gap || 0),
            skipped_no_competitor: Number(priceSyncJob.skipped_no_competitor || 0),
            no_dm_mk_price: Number(priceSyncJob.skipped_no_competitor || 0),
            skipped,
            no_competitor: Number(priceSyncJob.skipped_no_competitor || 0),
            to_update: Number(priceSyncJob.synced || 0) + Number(priceSyncJob.cms_failed || 0),
            errors: Array.isArray(priceSyncJob.errors) ? priceSyncJob.errors.slice(-20) : [],
            applied_filters: priceSyncJob.applied_filters,
            random_min_pct: priceSyncJob.random_min_pct,
            random_max_pct: priceSyncJob.random_max_pct,
            synced_by: priceSyncJob.synced_by || '',
            job_serial: priceSyncJob.job_serial,
            chunk_size: PRICE_SYNC_CHUNK,
            cms_concurrency: PRICE_SYNC_CMS_CONCURRENCY,
            hard_max: PRICE_SYNC_HARD_MAX,
            duration_sec: priceSyncJobDurationSec()
        };
    }

    function resetPriceSyncJob(serial, meta) {
        priceSyncJob.active = true;
        priceSyncJob.cancelRequested = false;
        priceSyncJob.job_serial = serial;
        priceSyncJob.started_at = new Date();
        priceSyncJob.finished_at = null;
        priceSyncJob.phase = 'writing';
        priceSyncJob.message = 'Стартует массовая синхронизация цен…';
        priceSyncJob.applied_filters = meta.applied_filters || null;
        priceSyncJob.random_min_pct = meta.minPct;
        priceSyncJob.random_max_pct = meta.maxPct;
        priceSyncJob.synced_by = meta.actorDisplayName || '';
        priceSyncJob.total_sql = Number(meta.total_sql || 0);
        priceSyncJob.scanned = 0;
        priceSyncJob.synced = 0;
        priceSyncJob.cms_ok = 0;
        priceSyncJob.cms_failed = 0;
        priceSyncJob.skipped_gap = 0;
        priceSyncJob.skipped_no_competitor = 0;
        priceSyncJob.errors = [];
    }

    function finishPriceSyncJob(serial, phase, message) {
        if (priceSyncJob.job_serial !== serial) return;
        priceSyncJob.active = false;
        priceSyncJob.phase = phase;
        priceSyncJob.finished_at = new Date();
        priceSyncJob.message = message;
        priceSyncJob.cancelRequested = false;
    }

    async function runPriceSyncJob(serial, filterRaw, pctRange, actorDisplayName) {
        const siteCache = new Map();
        /** @type {Map<number, import('mysql2/promise').Connection[]>} */
        const connPools = new Map();

        function formatProgressMessage(totalWork, showGapSkips) {
            return (
                `Обработано ${priceSyncJob.scanned.toLocaleString('ru-RU')}/${totalWork.toLocaleString('ru-RU')}` +
                `; записано ✓ ${priceSyncJob.cms_ok.toLocaleString('ru-RU')}` +
                `, ошибок × ${priceSyncJob.cms_failed.toLocaleString('ru-RU')}` +
                `, без цены ДМ/МК ${priceSyncJob.skipped_no_competitor.toLocaleString('ru-RU')}` +
                (showGapSkips ? `, отсеяно по Δ ${priceSyncJob.skipped_gap.toLocaleString('ru-RU')}` : '')
            );
        }

        try {
            const ctx = await buildPriceSyncFilterContext(filterRaw);
            priceSyncJob.applied_filters = ctx.applied_filters;
            priceSyncJob.phase = 'selecting';

            let workIds = null;
            let totalWork = 0;
            let showGapSkips = false;

            if (ctx.isGapFilterEnabled) {
                priceSyncJob.message = 'Отбираем товары по фильтру Δ (как в таблице)…';
                const workset = await resolvePriceSyncWorkset(ctx, {
                    shouldCancel: () =>
                        priceSyncJob.cancelRequested || priceSyncJob.job_serial !== serial,
                    onProgress: ({ scannedSql, matched, from_cache, loading }) => {
                        if (priceSyncJob.job_serial !== serial) return;
                        if (from_cache) {
                            priceSyncJob.message =
                                `Берём набор из таблицы (кэш Δ): ${Number(matched).toLocaleString('ru-RU')} товаров…`;
                            return;
                        }
                        if (loading) {
                            priceSyncJob.message = 'Считаем набор по Δ как при «Применить»…';
                            return;
                        }
                        priceSyncJob.message =
                            `Отбор Δ готов: подходит ${Number(matched).toLocaleString('ru-RU')}` +
                            ` (из SQL ${Number(scannedSql).toLocaleString('ru-RU')})…`;
                    }
                });
                if (workset.cancelled || priceSyncJob.cancelRequested) {
                    finishPriceSyncJob(
                        serial,
                        'cancelled',
                        `Остановлено на отборе Δ: просмотрено SQL ${workset.scannedSql}, подходит ${workset.total}`
                    );
                    return;
                }
                workIds = workset.matchedIds || [];
                totalWork = workIds.length;
                priceSyncJob.total_sql = totalWork;
                priceSyncJob.skipped_gap = workset.skipped_gap;
                showGapSkips = true;
                if (!totalWork) {
                    finishPriceSyncJob(
                        serial,
                        'done',
                        `Готово: по фильтру Δ нет товаров (SQL просмотрено ${workset.scannedSql}, вне Δ ${workset.skipped_gap})`
                    );
                    return;
                }
            } else {
                totalWork = await countPriceSyncCandidates(ctx);
                if (totalWork > PRICE_SYNC_HARD_MAX) {
                    finishPriceSyncJob(
                        serial,
                        'error',
                        `Слишком большая SQL-выборка (${totalWork.toLocaleString('ru-RU')} > ${PRICE_SYNC_HARD_MAX}). Сузьте фильтры.`
                    );
                    return;
                }
                priceSyncJob.total_sql = totalWork;
                if (!totalWork) {
                    finishPriceSyncJob(serial, 'done', 'Готово: по фильтрам нет товаров');
                    return;
                }
            }

            priceSyncJob.phase = 'writing';
            priceSyncJob.message =
                `К записи: ${totalWork.toLocaleString('ru-RU')}` +
                (showGapSkips
                    ? ` (отсеяно по Δ ${priceSyncJob.skipped_gap.toLocaleString('ru-RU')})`
                    : '') +
                `… (чанк ${PRICE_SYNC_CHUNK}, CMS×${PRICE_SYNC_CMS_CONCURRENCY})`;

            async function ensureSitePool(siteId) {
                const sid = Number(siteId);
                if (connPools.has(sid)) {
                    return { site: siteCache.get(sid), pool: connPools.get(sid) };
                }
                const [sites] = await db.query('SELECT * FROM my_sites WHERE id = ?', [sid]);
                if (!sites.length) {
                    const err = new Error('Сайт не найден');
                    err.code = 'SITE_NOT_FOUND';
                    throw err;
                }
                const site = sites[0];
                const pool = [];
                for (let i = 0; i < PRICE_SYNC_CMS_CONCURRENCY; i += 1) {
                    // eslint-disable-next-line no-await-in-loop
                    const conn = await mysql.createConnection({
                        host: site.db_host,
                        user: site.db_user,
                        password: site.db_pass,
                        database: site.db_name,
                        connectTimeout: 10000
                    });
                    pool.push(conn);
                }
                siteCache.set(sid, site);
                connPools.set(sid, pool);
                return { site, pool };
            }

            function takeSiteConn(siteId, slot) {
                const sid = Number(siteId);
                const pool = connPools.get(sid);
                if (!pool || !pool.length) {
                    const err = new Error('CMS pool not ready');
                    err.code = 'CMS_POOL_MISSING';
                    throw err;
                }
                const conn = pool[Math.abs(Number(slot) || 0) % pool.length];
                return { site: siteCache.get(sid), conn };
            }

            async function processRows(rows) {
                await enrichWithCompetitorPrices(rows);

                const toWrite = [];
                for (const product of rows) {
                    if (priceSyncJob.cancelRequested) break;
                    priceSyncJob.scanned += 1;

                    // Без prefilter: Δ проверяем на лету. С prefilter — только страховка.
                    if (ctx.isGapFilterEnabled && !rowMatchesGapFilter(product, ctx.gapCfg)) {
                        if (!workIds) priceSyncJob.skipped_gap += 1;
                        continue;
                    }

                    const computed = computeCompetitorTargetPrice(
                        product,
                        pctRange.minPct,
                        pctRange.maxPct,
                        ctx.usdRate,
                        ctx.eurRate
                    );
                    if (!computed.ok) {
                        priceSyncJob.skipped_no_competitor += 1;
                        continue;
                    }
                    toWrite.push({ product, computed });
                }

                const siteIds = [...new Set(toWrite.map((x) => Number(x.product.site_id)).filter(Number.isFinite))];
                for (const sid of siteIds) {
                    if (priceSyncJob.cancelRequested) break;
                    // eslint-disable-next-line no-await-in-loop
                    await ensureSitePool(sid);
                }

                await mapPool(toWrite, PRICE_SYNC_CMS_CONCURRENCY, async (item, _idx, slot) => {
                    if (priceSyncJob.cancelRequested) return;
                    if (priceSyncJob.job_serial !== serial) return;
                    const { product, computed } = item;
                    const code = String(product.sku || product.source_id || product.id || '?');
                    try {
                        const { site, conn } = takeSiteConn(product.site_id, slot);
                        await applyPriceToCms(conn, site, product, computed.finalPrice);
                        await db.query(
                            `UPDATE my_products
                             SET price = ?, comp_sync_by = ?, comp_sync_at = NOW(), comp_sync_note = ?, updated_at = NOW()
                             WHERE site_id = ? AND source_id = ?`,
                            [
                                computed.finalPrice,
                                actorDisplayName,
                                `bulk;from=${computed.selected.source};rnd=${computed.randomPct.toFixed(4)}%`,
                                Number(product.site_id),
                                String(product.source_id || '')
                            ]
                        );
                        priceSyncJob.cms_ok += 1;
                        priceSyncJob.synced += 1;
                    } catch (itemErr) {
                        priceSyncJob.cms_failed += 1;
                        if (priceSyncJob.errors.length < 20) {
                            priceSyncJob.errors.push({
                                code,
                                site_id: Number(product.site_id),
                                error: String(itemErr && itemErr.message ? itemErr.message : itemErr)
                            });
                        }
                    }
                });

                priceSyncJob.message = formatProgressMessage(totalWork, showGapSkips);
            }

            if (workIds) {
                for (let offset = 0; offset < workIds.length && !priceSyncJob.cancelRequested; offset += PRICE_SYNC_CHUNK) {
                    if (priceSyncJob.job_serial !== serial) return;
                    const slice = workIds.slice(offset, offset + PRICE_SYNC_CHUNK);
                    // eslint-disable-next-line no-await-in-loop
                    const rows = await fetchPriceSyncByIds(slice);
                    // eslint-disable-next-line no-await-in-loop
                    await processRows(rows);
                    // eslint-disable-next-line no-await-in-loop
                    await new Promise((resolve) => setImmediate(resolve));
                }
            } else {
                let cursorId = null;
                while (!priceSyncJob.cancelRequested) {
                    if (priceSyncJob.job_serial !== serial) return;
                    // eslint-disable-next-line no-await-in-loop
                    const rows = await fetchPriceSyncChunk(ctx, cursorId, PRICE_SYNC_CHUNK);
                    if (!rows.length) break;
                    const ids = rows.map((r) => Number(r.id)).filter(Number.isFinite);
                    cursorId = Math.min(...ids);
                    // eslint-disable-next-line no-await-in-loop
                    await processRows(rows);
                    // eslint-disable-next-line no-await-in-loop
                    await new Promise((resolve) => setImmediate(resolve));
                }
            }

            myProductsResponseCache.clear();
            myProductsGapSetCache.clear();

            if (priceSyncJob.cancelRequested) {
                finishPriceSyncJob(
                    serial,
                    'cancelled',
                    `Остановлено: просмотрено ${priceSyncJob.scanned}/${totalWork}, записано ✓ ${priceSyncJob.cms_ok}, ошибок × ${priceSyncJob.cms_failed}, без цены ДМ/МК ${priceSyncJob.skipped_no_competitor}` +
                        (showGapSkips ? `, отсеяно по Δ ${priceSyncJob.skipped_gap}` : '')
                );
            } else {
                finishPriceSyncJob(
                    serial,
                    'done',
                    `Готово: просмотрено ${priceSyncJob.scanned}/${totalWork}, записано ✓ ${priceSyncJob.cms_ok}, ошибок × ${priceSyncJob.cms_failed}, без цены ДМ/МК ${priceSyncJob.skipped_no_competitor}` +
                        (showGapSkips ? `, отсеяно по Δ ${priceSyncJob.skipped_gap}` : '')
                );
            }
        } catch (e) {
            console.error('Error in background price sync job:', e);
            finishPriceSyncJob(serial, 'error', `Ошибка: ${e.message || e}`);
        } finally {
            for (const pool of connPools.values()) {
                for (const conn of pool) {
                    try {
                        // eslint-disable-next-line no-await-in-loop
                        await conn.end();
                    } catch (_) {}
                }
            }
        }
    }

    // 4. Обновление цены на сайте от цены конкурента с рандомным шагом
    router.post('/sync-price-from-competitor', async (req, res) => {
        const { site_id, sku, source_id, random_min_pct, random_max_pct } = req.body || {};
        if (!site_id || (!sku && !source_id)) {
            return res.status(400).json({ error: 'Не указан site_id и идентификатор товара (source_id/sku)' });
        }
        const pctRange = normalizeRandomPctRange(random_min_pct, random_max_pct);
        if (pctRange.error) {
            return res.status(400).json({ error: pctRange.error });
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
            const computed = computeCompetitorTargetPrice(
                product,
                pctRange.minPct,
                pctRange.maxPct,
                usdRate,
                eurRate
            );
            if (!computed.ok) {
                return res.status(400).json({ error: computed.error });
            }

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
                await applyPriceToCms(conn, s, product, computed.finalPrice);
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
                    computed.finalPrice,
                    actorDisplayName,
                    `from=${computed.selected.source};rnd=${computed.randomPct.toFixed(4)}%`,
                    siteIdNum,
                    String(product.source_id || '')
                ]
            );
            myProductsResponseCache.clear();
            myProductsGapSetCache.clear();

            const [[syncMeta]] = await db.query(
                `SELECT price, currency, comp_sync_at, comp_sync_by, comp_sync_note, updated_at
                 FROM my_products
                 WHERE site_id = ? AND source_id = ?
                 LIMIT 1`,
                [siteIdNum, String(product.source_id || '')]
            );

            return res.json({
                success: true,
                message: 'Цена обновлена от конкурента',
                data: {
                    ...(syncMeta || {}),
                    competitor_source: computed.selected.source,
                    competitor_price_rub: Number(computed.selected.rub.toFixed(2)),
                    random_pct: Number(computed.randomPct.toFixed(4)),
                    target_price: computed.finalPrice,
                    target_currency: product.currency || 'RUB',
                    synced_by: actorDisplayName
                }
            });
        } catch (e) {
            console.error('Error syncing price from competitor:', e);
            return res.status(500).json({ error: e.message });
        }
    });

    // 4b. Массовая синхронизация цены: dry_run (быстрый COUNT) или confirm (фон + чанки)
    router.post('/sync-price-from-competitor-bulk', async (req, res) => {
        const startedAt = Date.now();
        const body = req.body || {};
        const q = { ...req.query, ...body };
        const dryRun =
            String(q.dry_run || '') === '1' ||
            q.dry_run === true ||
            q.dry_run === 1;
        const confirm =
            String(q.confirm || '') === '1' ||
            q.confirm === true ||
            q.confirm === 1;

        if (!dryRun && !confirm) {
            return res.status(400).json({
                error: 'confirm required (или dry_run=1)',
                code: 'CONFIRM_REQUIRED'
            });
        }

        const pctRange = normalizeRandomPctRange(q.random_min_pct ?? body.random_min_pct, q.random_max_pct ?? body.random_max_pct);
        if (pctRange.error) {
            return res.status(400).json({ error: pctRange.error });
        }

        try {
            await ensureMyProductsSyncAuditColumns();
            const ctx = await buildPriceSyncFilterContext(q);

            if (dryRun) {
                // Быстрый COUNT: полный отбор по Δ делаем в фоне (phase selecting), иначе UI «висит» на кнопке.
                const totalSql = await countPriceSyncCandidates(ctx);
                return res.json({
                    success: true,
                    dry_run: true,
                    mode: 'background',
                    total: totalSql,
                    total_sql: totalSql,
                    scanned_sql: totalSql,
                    skipped_gap: null,
                    gap_prefiltered: false,
                    to_update: null,
                    would_update: null,
                    estimate_exact: false,
                    note: ctx.isGapFilterEnabled
                        ? `SQL по фильтрам: ${totalSql.toLocaleString('ru-RU')}. Фильтр Δ применится в фоне перед записью (как в таблице) — к обработке пойдёт только подходящее; «вне Δ» отсеется на отборе.`
                        : 'Confirmed-матч ≠ цена Dealmed/Медкомплекс: к записи идут только товары с ценой ДМ/МК > 0. Точное число «без цены ДМ/МК» станет известно в процессе.',
                    skipped: null,
                    no_competitor: null,
                    no_dm_mk_price: null,
                    hard_max: PRICE_SYNC_HARD_MAX,
                    chunk_size: PRICE_SYNC_CHUNK,
                    cms_concurrency: PRICE_SYNC_CMS_CONCURRENCY,
                    applied_filters: ctx.applied_filters,
                    gap_filter_enabled: ctx.isGapFilterEnabled ? 1 : 0,
                    random_min_pct: pctRange.minPct,
                    random_max_pct: pctRange.maxPct,
                    duration_sec: Number(((Date.now() - startedAt) / 1000).toFixed(2))
                });
            }

            if (priceSyncJob.active) {
                return res.status(409).json({
                    success: false,
                    error: 'Массовая синхронизация цен уже выполняется',
                    code: 'ALREADY_RUNNING',
                    status: priceSyncJobPayload()
                });
            }

            let totalForStart = 0;
            if (!ctx.isGapFilterEnabled) {
                totalForStart = await countPriceSyncCandidates(ctx);
                if (totalForStart <= 0) {
                    return res.json({
                        success: true,
                        started: false,
                        dry_run: false,
                        total: 0,
                        total_sql: 0,
                        message: 'По фильтрам нет товаров',
                        applied_filters: ctx.applied_filters,
                        status: priceSyncJobPayload(),
                        duration_sec: Number(((Date.now() - startedAt) / 1000).toFixed(2))
                    });
                }
                if (totalForStart > PRICE_SYNC_HARD_MAX) {
                    return res.status(400).json({
                        success: false,
                        error: `Слишком большая SQL-выборка (${totalForStart} > ${PRICE_SYNC_HARD_MAX}). Сузьте фильтры.`,
                        code: 'SELECTION_TOO_LARGE',
                        total_sql: totalForStart,
                        hard_max: PRICE_SYNC_HARD_MAX,
                        applied_filters: ctx.applied_filters
                    });
                }
            }

            const actorLogin = resolveActorName(req);
            const actorDisplayName = await resolveActorDisplayName(actorLogin);
            const serial = Number(priceSyncJob.job_serial || 0) + 1;
            resetPriceSyncJob(serial, {
                applied_filters: ctx.applied_filters,
                minPct: pctRange.minPct,
                maxPct: pctRange.maxPct,
                actorDisplayName,
                total_sql: totalForStart
            });
            if (ctx.isGapFilterEnabled) {
                priceSyncJob.phase = 'selecting';
                priceSyncJob.message = 'Отбираем товары по фильтру Δ…';
            }

            setImmediate(() => {
                runPriceSyncJob(serial, q, pctRange, actorDisplayName).catch((e) => {
                    console.error('price sync job crash:', e);
                    finishPriceSyncJob(serial, 'error', `Ошибка: ${e.message || e}`);
                });
            });

            return res.json({
                success: true,
                started: true,
                dry_run: false,
                mode: 'background',
                total: totalForStart,
                total_sql: totalForStart,
                message: ctx.isGapFilterEnabled
                    ? 'Фоновая синхронизация цен запущена (сначала отбор по Δ)'
                    : 'Фоновая синхронизация цен запущена',
                status: priceSyncJobPayload(),
                duration_sec: Number(((Date.now() - startedAt) / 1000).toFixed(2))
            });
        } catch (e) {
            console.error('Error starting bulk price sync:', e);
            if (e && e.code === 'SELECTION_TOO_LARGE') {
                return res.status(400).json({
                    success: false,
                    error: e.message,
                    code: 'SELECTION_TOO_LARGE',
                    total_sql: e.matched,
                    hard_max: PRICE_SYNC_HARD_MAX,
                    duration_sec: Number(((Date.now() - startedAt) / 1000).toFixed(2))
                });
            }
            return res.status(500).json({
                error: e.message,
                duration_sec: Number(((Date.now() - startedAt) / 1000).toFixed(2))
            });
        }
    });

    router.get('/sync-price-from-competitor-bulk-status', (req, res) => {
        res.json({ success: true, status: priceSyncJobPayload() });
    });

    router.post('/sync-price-from-competitor-bulk-stop', (req, res) => {
        if (!priceSyncJob.active) {
            return res.json({ success: true, stopped: false, status: priceSyncJobPayload() });
        }
        priceSyncJob.cancelRequested = true;
        priceSyncJob.message = 'Останавливаем…';
        return res.json({ success: true, stopped: true, status: priceSyncJobPayload() });
    });

    _priceCompSyncControls = {
        isActive: () => !!priceSyncJob.active,
        getState: () => priceSyncJobPayload(),
        /**
         * Старт той же фоновой задачи, что POST …-bulk?confirm=1.
         * @param {object} filters
         * @param {string} actorDisplayName
         */
        startFromFilters: async (filters, actorDisplayName) => {
            if (priceSyncJob.active) {
                return { started: false, reason: 'already_running', status: priceSyncJobPayload() };
            }
            const q = filters || {};
            const pctRange = normalizeRandomPctRange(q.random_min_pct, q.random_max_pct);
            if (pctRange.error) {
                return { started: false, error: pctRange.error };
            }
            await ensureMyProductsSyncAuditColumns();
            const ctx = await buildPriceSyncFilterContext(q);

            let totalForStart = 0;
            if (!ctx.isGapFilterEnabled) {
                totalForStart = await countPriceSyncCandidates(ctx);
                if (totalForStart <= 0) {
                    return {
                        started: false,
                        reason: 'empty',
                        total_sql: 0,
                        status: priceSyncJobPayload(),
                        applied_filters: ctx.applied_filters
                    };
                }
                if (totalForStart > PRICE_SYNC_HARD_MAX) {
                    return {
                        started: false,
                        reason: 'too_large',
                        total_sql: totalForStart,
                        hard_max: PRICE_SYNC_HARD_MAX,
                        error: `Слишком большая SQL-выборка (${totalForStart} > ${PRICE_SYNC_HARD_MAX})`
                    };
                }
            }

            const actor = String(actorDisplayName || 'auto-sync').trim() || 'auto-sync';
            const serial = Number(priceSyncJob.job_serial || 0) + 1;
            resetPriceSyncJob(serial, {
                applied_filters: ctx.applied_filters,
                minPct: pctRange.minPct,
                maxPct: pctRange.maxPct,
                actorDisplayName: actor,
                total_sql: totalForStart
            });
            if (ctx.isGapFilterEnabled) {
                priceSyncJob.phase = 'selecting';
                priceSyncJob.message = 'Отбираем товары по фильтру Δ…';
            }
            setImmediate(() => {
                runPriceSyncJob(serial, q, pctRange, actor).catch((e) => {
                    console.error('price sync job crash:', e);
                    finishPriceSyncJob(serial, 'error', `Ошибка: ${e.message || e}`);
                });
            });
            return {
                started: true,
                total_sql: totalForStart,
                status: priceSyncJobPayload()
            };
        }
    };

    return router;
}

function buildPriceCompFiltersFromSettings(appSettings) {
    const s = appSettings || {};
    return {
        site_id: String(s.auto_sync_price_comp_site_id || 'all'),
        status: 'all',
        source_enabled: 'all',
        ms_linked: 'all',
        search: '',
        match_audit: String(s.auto_sync_price_comp_match_audit || 'confirmed'),
        gap_filter_enabled: '0',
        gap_exclude_zero: '1',
        gap_competitor: 'all',
        gap_min_pct: '-100',
        gap_max_pct: '100',
        stock_min: String(s.auto_sync_price_comp_stock_min != null ? s.auto_sync_price_comp_stock_min : '0'),
        stock_max: String(s.auto_sync_price_comp_stock_max != null ? s.auto_sync_price_comp_stock_max : '1000'),
        random_min_pct: String(s.auto_sync_price_comp_rand_min != null ? s.auto_sync_price_comp_rand_min : '0.1'),
        random_max_pct: String(s.auto_sync_price_comp_rand_max != null ? s.auto_sync_price_comp_rand_max : '0.99')
    };
}

/**
 * Запуск из автосинка / «Запустить сейчас». Роутер должен быть уже смонтирован.
 */
myProductsRouterFactory.triggerPriceCompSyncFromSettings = async function triggerPriceCompSyncFromSettings(
    appSettings,
    opts
) {
    if (!_priceCompSyncControls || typeof _priceCompSyncControls.startFromFilters !== 'function') {
        throw new Error('my-products router not initialized (price_comp_sync)');
    }
    const filters = buildPriceCompFiltersFromSettings(appSettings);
    const actor = (opts && opts.actorDisplayName) || 'auto-sync';
    return _priceCompSyncControls.startFromFilters(filters, actor);
};

myProductsRouterFactory.getPriceCompSyncState = function getPriceCompSyncState() {
    if (!_priceCompSyncControls) {
        return { active: false, phase: 'idle', message: 'роутер не инициализирован' };
    }
    return _priceCompSyncControls.getState();
};

myProductsRouterFactory.isPriceCompSyncActive = function isPriceCompSyncActive() {
    return !!( _priceCompSyncControls && _priceCompSyncControls.isActive());
};

module.exports = myProductsRouterFactory;