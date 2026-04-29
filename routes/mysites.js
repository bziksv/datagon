const mysql = require('mysql2/promise');
const express = require('express');
const router = express.Router();

module.exports = (db, settings) => {
    let sourceEnabledColumnReady = false;
    let sourceIdentityIndexesReady = false;

    async function ensureSourceEnabledColumn() {
        if (sourceEnabledColumnReady) return;
        const [rows] = await db.query(`
            SELECT COUNT(*) AS cnt
            FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE()
              AND TABLE_NAME = 'my_products'
              AND COLUMN_NAME = 'source_enabled'
        `);
        if (!rows[0]?.cnt) {
            await db.query('ALTER TABLE my_products ADD COLUMN source_enabled TINYINT(1) NOT NULL DEFAULT 1');
        }
        sourceEnabledColumnReady = true;
    }

    async function ensureSourceIdentityIndexes() {
        if (sourceIdentityIndexesReady) return;
        const [sourceRows] = await db.query(`
            SELECT COUNT(*) AS cnt
            FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE()
              AND TABLE_NAME = 'my_products'
              AND COLUMN_NAME = 'source_id'
        `);
        if (!sourceRows[0]?.cnt) {
            await db.query('ALTER TABLE my_products ADD COLUMN source_id VARCHAR(255)');
        }
        const [idxSku] = await db.query(`
            SELECT COUNT(*) AS cnt
            FROM information_schema.STATISTICS
            WHERE TABLE_SCHEMA = DATABASE()
              AND TABLE_NAME = 'my_products'
              AND INDEX_NAME = 'unique_site_sku'
        `);
        if (idxSku[0]?.cnt) {
            await db.query('ALTER TABLE my_products DROP INDEX unique_site_sku');
        }
        const [idxSiteSource] = await db.query(`
            SELECT COUNT(*) AS cnt
            FROM information_schema.STATISTICS
            WHERE TABLE_SCHEMA = DATABASE()
              AND TABLE_NAME = 'my_products'
              AND INDEX_NAME = 'unique_site_source'
        `);
        if (!idxSiteSource[0]?.cnt) {
            await db.query('ALTER TABLE my_products ADD UNIQUE KEY unique_site_source (site_id, source_id)');
        }
        sourceIdentityIndexesReady = true;
    }

    async function queryBitrixRowsWithSourceEnabledFallback(conn, s, limit, offset) {
        const withSourceEnabled = `SELECT ${s.field_code} as source_id, ${s.field_name} as name, ${s.field_sku} as sku, ${s.field_price} as price, ${s.field_currency} as currency, ${s.field_stock} as stock, '' as url_key, COALESCE(SOURCE_ENABLED, 1) as source_enabled FROM ${s.table_products} LIMIT ? OFFSET ?`;
        try {
            const [rows] = await conn.query(withSourceEnabled, [limit, offset]);
            return rows;
        } catch (e) {
            if (!/Unknown column 'SOURCE_ENABLED'/i.test(String(e?.message || ''))) throw e;
            const fallback = `SELECT ${s.field_code} as source_id, ${s.field_name} as name, ${s.field_sku} as sku, ${s.field_price} as price, ${s.field_currency} as currency, ${s.field_stock} as stock, '' as url_key, 1 as source_enabled FROM ${s.table_products} LIMIT ? OFFSET ?`;
            const [rows] = await conn.query(fallback, [limit, offset]);
            return rows;
        }
    }

    async function prepareBitrixView(conn, requestedTable = 'b_catalog_product') {
        const tableName = String(requestedTable || 'b_catalog_product').trim() || 'b_catalog_product';
        await conn.query(`SELECT * FROM ${tableName} LIMIT 1`);

        const [articleProps] = await conn.query(`
            SELECT ID, IBLOCK_ID, CODE
            FROM b_iblock_property
            WHERE CODE IN ('CML2_ARTICLE','ARTICLE','ARTICL','ARTICLS')
               OR NAME LIKE '%Артикул%'
            ORDER BY
              CASE
                WHEN CODE = 'CML2_ARTICLE' THEN 1
                WHEN CODE = 'ARTICLE' THEN 2
                WHEN CODE = 'ARTICL' THEN 3
                WHEN CODE = 'ARTICLS' THEN 4
                ELSE 5
              END,
              ID ASC
            LIMIT 1
        `);
        if (!articleProps.length) {
            throw new Error('Bitrix auto-setup: не найдено свойство артикула в b_iblock_property');
        }
        const articleProp = articleProps[0];

        const [basePriceRows] = await conn.query(`
            SELECT ID
            FROM b_catalog_group
            WHERE BASE = 'Y'
            ORDER BY ID ASC
            LIMIT 1
        `);
        const basePriceGroupId = basePriceRows.length ? Number(basePriceRows[0].ID) : null;
        const priceJoin = basePriceGroupId
            ? `LEFT JOIN b_catalog_price pr ON pr.PRODUCT_ID = e.ID AND pr.CATALOG_GROUP_ID = ${basePriceGroupId}`
            : `LEFT JOIN b_catalog_price pr ON pr.PRODUCT_ID = e.ID`;
        const viewName = `v_datagon_products_${Number(articleProp.IBLOCK_ID)}`;

        await conn.query(`
            CREATE OR REPLACE VIEW ${viewName} AS
            SELECT
                e.XML_ID AS XML_ID,
                e.NAME AS NAME,
                ep.VALUE AS ARTICLE,
                cp.QUANTITY AS QUANTITY,
                pr.PRICE AS PRICE,
                pr.CURRENCY AS CURRENCY,
                CASE WHEN e.ACTIVE = 'Y' THEN 1 ELSE 0 END AS SOURCE_ENABLED
            FROM b_iblock_element e
            LEFT JOIN b_catalog_product cp ON cp.ID = e.ID
            ${priceJoin}
            LEFT JOIN b_iblock_element_property ep ON ep.IBLOCK_ELEMENT_ID = e.ID AND ep.IBLOCK_PROPERTY_ID = ${Number(articleProp.ID)}
            WHERE e.IBLOCK_ID = ${Number(articleProp.IBLOCK_ID)}
        `);

        const [sampleRows] = await conn.query(`
            SELECT NAME, ARTICLE, XML_ID, PRICE, CURRENCY, QUANTITY
            FROM ${viewName}
            LIMIT 5
        `);

        return {
            table_products: viewName,
            field_name: 'NAME',
            field_sku: 'ARTICLE',
            field_code: 'XML_ID',
            field_price: 'PRICE',
            field_currency: 'CURRENCY',
            field_stock: 'QUANTITY',
            bitrix_iblock_id: Number(articleProp.IBLOCK_ID),
            bitrix_article_property_id: Number(articleProp.ID),
            bitrix_article_property_code: String(articleProp.CODE || ''),
            test_rows_count: Array.isArray(sampleRows) ? sampleRows.length : 0
        };
    }

    function buildSourceUrl(domain, rawPath, cmsType = '') {
        const d = String(domain || '').trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
        const p = String(rawPath || '').trim();
        if (!d || !p) return '';
        if (/^https?:\/\//i.test(p)) return p;
        let cleanPath = p.replace(/^\/+/, '');
        if (String(cmsType || '').toLowerCase() === 'webasyst') {
            if (!cleanPath.startsWith('product/')) cleanPath = `product/${cleanPath}`;
            if (!cleanPath.endsWith('/')) cleanPath = `${cleanPath}/`;
        }
        return `https://${d}/${cleanPath}`;
    }

    // --- ГЛАВНЫЕ МАРШРУТЫ (Сайты) ---
    router.get('/', async (req, res) => {
        try {
            const [rows] = await db.query('SELECT * FROM my_sites ORDER BY id DESC');
            return res.json(rows);
        } catch (e) {
            return res.status(500).json({ error: e.message });
        }
    });

    router.post('/', async (req, res) => {
        const { name, domain, cms_type, db_host, db_name, db_user, db_pass, table_products, field_name, field_sku, field_code, field_price, field_currency, field_stock, wa_table_skus, wa_field_sku_val, wa_field_price_val, wa_field_stock_val } = req.body;
        const safeCms = cms_type || 'bitrix';
        const safeWaTable = wa_table_skus || 'shop_product_skus';
        let effectiveTableProducts = table_products;
        let effectiveFieldName = field_name;
        let effectiveFieldSku = field_sku;
        let effectiveFieldCode = field_code;
        let effectiveFieldPrice = field_price;
        let effectiveFieldCurrency = field_currency;
        let effectiveFieldStock = field_stock;
        let autoPrepared = null;
        try {
            const conn = await mysql.createConnection({ host: db_host, user: db_user, password: db_pass, database: db_name, connectTimeout: 5000 });
            if (safeCms === 'webasyst') {
                await conn.query(`SELECT id FROM ${table_products} LIMIT 1`);
                await conn.query(`SELECT id FROM ${safeWaTable} LIMIT 1`);
            } else {
                autoPrepared = await prepareBitrixView(conn, table_products || 'b_catalog_product');
                effectiveTableProducts = autoPrepared.table_products;
                effectiveFieldName = autoPrepared.field_name;
                effectiveFieldSku = autoPrepared.field_sku;
                effectiveFieldCode = autoPrepared.field_code;
                effectiveFieldPrice = autoPrepared.field_price;
                effectiveFieldCurrency = autoPrepared.field_currency;
                effectiveFieldStock = autoPrepared.field_stock;
            }
            await conn.end();
            const [result] = await db.query(`INSERT INTO my_sites (name, domain, cms_type, db_host, db_name, db_user, db_pass, table_products, field_name, field_sku, field_code, field_price, field_currency, field_stock, wa_table_skus, wa_field_sku_val, wa_field_price_val, wa_field_stock_val) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [name, domain, safeCms, db_host, db_name, db_user, db_pass, effectiveTableProducts, effectiveFieldName, effectiveFieldSku, effectiveFieldCode, effectiveFieldPrice, effectiveFieldCurrency, effectiveFieldStock, safeWaTable, wa_field_sku_val, wa_field_price_val, wa_field_stock_val]);
            res.json({ success: true, id: result.insertId, auto_prepared: autoPrepared });
        } catch (e) { res.status(500).json({ error: 'DB Connect Error: ' + e.message }); }
    });

    router.put('/:id', async (req, res) => {
        const { id } = req.params;
        const { name, domain, cms_type, db_host, db_name, db_user, db_pass, table_products, field_name, field_sku, field_code, field_price, field_currency, field_stock, wa_table_skus, wa_field_sku_val, wa_field_price_val, wa_field_stock_val } = req.body;
        const safeCms = cms_type || 'bitrix';
        const safeWaTable = wa_table_skus || 'shop_product_skus';
        let effectiveTableProducts = table_products;
        let effectiveFieldName = field_name;
        let effectiveFieldSku = field_sku;
        let effectiveFieldCode = field_code;
        let effectiveFieldPrice = field_price;
        let effectiveFieldCurrency = field_currency;
        let effectiveFieldStock = field_stock;
        let autoPrepared = null;
        try {
            const conn = await mysql.createConnection({ host: db_host, user: db_user, password: db_pass, database: db_name, connectTimeout: 5000 });
            if (safeCms === 'webasyst') {
                await conn.query(`SELECT id FROM ${table_products} LIMIT 1`);
                await conn.query(`SELECT id FROM ${safeWaTable} LIMIT 1`);
            } else {
                autoPrepared = await prepareBitrixView(conn, table_products || 'b_catalog_product');
                effectiveTableProducts = autoPrepared.table_products;
                effectiveFieldName = autoPrepared.field_name;
                effectiveFieldSku = autoPrepared.field_sku;
                effectiveFieldCode = autoPrepared.field_code;
                effectiveFieldPrice = autoPrepared.field_price;
                effectiveFieldCurrency = autoPrepared.field_currency;
                effectiveFieldStock = autoPrepared.field_stock;
            }
            await conn.end();
            await db.query(`UPDATE my_sites SET name=?, domain=?, cms_type=?, db_host=?, db_name=?, db_user=?, db_pass=?, table_products=?, field_name=?, field_sku=?, field_code=?, field_price=?, field_currency=?, field_stock=?, wa_table_skus=?, wa_field_sku_val=?, wa_field_price_val=?, wa_field_stock_val=? WHERE id=?`, [name, domain, safeCms, db_host, db_name, db_user, db_pass, effectiveTableProducts, effectiveFieldName, effectiveFieldSku, effectiveFieldCode, effectiveFieldPrice, effectiveFieldCurrency, effectiveFieldStock, safeWaTable, wa_field_sku_val, wa_field_price_val, wa_field_stock_val, id]);
            res.json({ success: true, auto_prepared: autoPrepared });
        } catch (e) { res.status(500).json({ error: 'DB Connect Error: ' + e.message }); }
    });

    router.delete('/:id', async (req, res) => {
        await db.query('DELETE FROM my_sites WHERE id = ?', [req.params.id]);
        res.json({ success: true });
    });

    router.post('/:id/fetch', async (req, res) => {
        const [sites] = await db.query('SELECT * FROM my_sites WHERE id = ?', [req.params.id]);
        if (!sites.length) return res.status(404).json({ error: 'Site not found' });
        const s = sites[0];
        const limit = parseInt(req.body.limit) || 100;
        try {
            const conn = await mysql.createConnection({ host: s.db_host, user: s.db_user, password: s.db_pass, database: s.db_name, connectTimeout: 10000 });
            let query = '';
            if (s.cms_type === 'webasyst') {
                query = `SELECT p.id as source_id, p.name, sk.${s.wa_field_sku_val} as sku, sk.${s.wa_field_price_val} as price, p.currency, sk.${s.wa_field_stock_val} as stock, p.url as url_key FROM ${s.table_products} p JOIN ${s.wa_table_skus} sk ON p.id = sk.product_id ORDER BY p.id DESC LIMIT ?`;
            } else {
                query = `SELECT ${s.field_code} as source_id, ${s.field_name} as name, ${s.field_sku} as sku, ${s.field_price} as price, ${s.field_currency} as currency, ${s.field_stock} as stock, '' as url_key FROM ${s.table_products} LIMIT ?`;
            }
            const [rows] = await conn.query(query, [limit]);
            await conn.end();
            res.json({ success: true, data: rows });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    router.post('/:id/verify-stats', async (req, res) => {
        const [sites] = await db.query('SELECT * FROM my_sites WHERE id = ?', [req.params.id]);
        if (!sites.length) return res.status(404).json({ error: 'Site not found' });
        const s = sites[0];
        let conn;
        try {
            await ensureSourceEnabledColumn();
            await ensureSourceIdentityIndexes();
            conn = await mysql.createConnection({
                host: s.db_host,
                user: s.db_user,
                password: s.db_pass,
                database: s.db_name,
                connectTimeout: 10000
            });

            let sourceTotal = 0;
            let sourceActive = 0;
            let sourceDisabled = 0;
            if (String(s.cms_type || '').toLowerCase() === 'webasyst') {
                const [src] = await conn.query(`
                    SELECT
                        COUNT(DISTINCT p.id) AS total,
                        COUNT(DISTINCT CASE WHEN p.status = 1 THEN p.id END) AS active,
                        COUNT(DISTINCT CASE WHEN p.status <> 1 OR p.status IS NULL THEN p.id END) AS disabled
                    FROM ${s.table_products} p
                    JOIN ${s.wa_table_skus} sk ON p.id = sk.product_id
                `);
                sourceTotal = Number(src[0]?.total || 0);
                sourceActive = Number(src[0]?.active || 0);
                sourceDisabled = Number(src[0]?.disabled || 0);
            } else if (String(s.cms_type || '').toLowerCase() === 'bitrix') {
                const [src] = await conn.query(`
                    SELECT
                        COUNT(*) AS total,
                        SUM(CASE WHEN COALESCE(SOURCE_ENABLED, 1) = 1 THEN 1 ELSE 0 END) AS active,
                        SUM(CASE WHEN COALESCE(SOURCE_ENABLED, 1) = 0 THEN 1 ELSE 0 END) AS disabled
                    FROM ${s.table_products}
                `);
                sourceTotal = Number(src[0]?.total || 0);
                sourceActive = Number(src[0]?.active || 0);
                sourceDisabled = Number(src[0]?.disabled || 0);
            } else {
                const [src] = await conn.query(`SELECT COUNT(*) AS total FROM ${s.table_products}`);
                sourceTotal = Number(src[0]?.total || 0);
                sourceActive = sourceTotal;
                sourceDisabled = 0;
            }

            const [dg] = await db.query(`
                SELECT
                    COUNT(*) AS total,
                    SUM(CASE WHEN is_active = 1 AND COALESCE(source_enabled, 1) = 1 THEN 1 ELSE 0 END) AS active,
                    SUM(CASE WHEN is_active = 1 AND COALESCE(source_enabled, 1) = 0 THEN 1 ELSE 0 END) AS disabled,
                    SUM(CASE WHEN is_active = 0 THEN 1 ELSE 0 END) AS disappeared
                FROM my_products
                WHERE site_id = ?
            `, [s.id]);

            const datagon = {
                total: Number(dg[0]?.total || 0),
                active: Number(dg[0]?.active || 0),
                disabled: Number(dg[0]?.disabled || 0),
                disappeared: Number(dg[0]?.disappeared || 0)
            };
            const source = { total: sourceTotal, active: sourceActive, disabled: sourceDisabled };
            const diff = {
                total: datagon.total - source.total,
                active: datagon.active - source.active,
                disabled: datagon.disabled - source.disabled
            };

            return res.json({
                success: true,
                site: { id: s.id, name: s.name, cms_type: s.cms_type || 'bitrix' },
                source,
                datagon,
                diff,
                matches: diff.total === 0 && diff.active === 0 && diff.disabled === 0
            });
        } catch (e) {
            return res.status(500).json({ error: e.message });
        } finally {
            if (conn) {
                try { await conn.end(); } catch (_) {}
            }
        }
    });

    router.post('/:id/sync', async (req, res) => {
        const [sites] = await db.query('SELECT * FROM my_sites WHERE id = ?', [req.params.id]);
        if (!sites.length) return res.status(404).json({ error: 'Site not found' });
        const s = sites[0];
        const { init, batch, offset } = req.query;
        const batchSize = parseInt(batch) || settings.sync_batch_size;
        const currentOffset = parseInt(offset) || 0;

        try {
            await ensureSourceEnabledColumn();
            await ensureSourceIdentityIndexes();
            if (init === 'true') {
                await db.query('UPDATE my_products SET is_active = 0 WHERE site_id = ?', [s.id]);
                const conn = await mysql.createConnection({ host: s.db_host, user: s.db_user, password: s.db_pass, database: s.db_name, connectTimeout: 10000 });
                let countQ = s.cms_type === 'webasyst' ? `SELECT COUNT(*) as total FROM ${s.table_products} p JOIN ${s.wa_table_skus} sk ON p.id = sk.product_id` : `SELECT COUNT(*) as total FROM ${s.table_products}`;
                const [countRes] = await conn.query(countQ);
                await conn.end();
                return res.json({ success: true, init: true, total: countRes[0].total });
            }

            const conn = await mysql.createConnection({ host: s.db_host, user: s.db_user, password: s.db_pass, database: s.db_name, connectTimeout: 10000 });
            let query = '';
            let rows;
            if (s.cms_type === 'webasyst') {
                query = `SELECT p.id as source_id, p.name, sk.${s.wa_field_sku_val} as sku, sk.${s.wa_field_price_val} as price, p.currency, sk.${s.wa_field_stock_val} as stock, p.url as url_key, CASE WHEN p.status = 1 THEN 1 ELSE 0 END as source_enabled FROM ${s.table_products} p JOIN ${s.wa_table_skus} sk ON p.id = sk.product_id LIMIT ? OFFSET ?`;
                [rows] = await conn.query(query, [batchSize, currentOffset]);
            } else if (String(s.cms_type || '').toLowerCase() === 'bitrix') {
                rows = await queryBitrixRowsWithSourceEnabledFallback(conn, s, batchSize, currentOffset);
            } else {
                query = `SELECT ${s.field_code} as source_id, ${s.field_name} as name, ${s.field_sku} as sku, ${s.field_price} as price, ${s.field_currency} as currency, ${s.field_stock} as stock, '' as url_key, 1 as source_enabled FROM ${s.table_products} LIMIT ? OFFSET ?`;
                [rows] = await conn.query(query, [batchSize, currentOffset]);
            }
            await conn.end();

            if (rows.length === 0) {
                const [inactive] = await db.query('SELECT COUNT(*) as c FROM my_products WHERE site_id = ? AND is_active = 0', [s.id]);
                return res.json({ success: true, done: true, deactivated: inactive[0].c });
            }

            const values = rows.map(r => [s.id, String(r.source_id || '').trim(), r.sku || '', r.name || '', r.price || 0, r.currency || 'RUB', r.stock || 0, buildSourceUrl(s.domain, r.url_key, s.cms_type), Number(r.source_enabled) === 0 ? 0 : 1]);
            let priceUpdate = settings.sync_mode === 'always' ? 'price = VALUES(price),' : 'price = IF(price IS NULL OR price = 0, VALUES(price), price),';

            await db.query(`INSERT INTO my_products (site_id, source_id, sku, name, price, currency, stock, source_url, source_enabled) VALUES ? ON DUPLICATE KEY UPDATE source_id = VALUES(source_id), ${priceUpdate} name = VALUES(name), currency = VALUES(currency), stock = VALUES(stock), source_url = VALUES(source_url), source_enabled = VALUES(source_enabled), is_active = 1, updated_at = NOW()`, [values]);

            res.json({ success: true, processed: rows.length, nextOffset: currentOffset + batchSize, hasMore: rows.length === batchSize });
        } catch (e) {
            console.error('Sync error:', e);
            res.status(500).json({ error: e.message });
        }
    });

    // --- НОВАЯ РЕАЛЬНАЯ ЛОГИКА ДЛЯ КНОПКИ "ОБНОВИТЬ ВСЁ" ---
    // Этот эндпоинт будет вызываться из server.js или напрямую, если прописать маршрут
    router.post('/sync-all-real', async (req, res) => {
        console.log('[GLOBAL SYNC] STARTED');
        try {
            await ensureSourceEnabledColumn();
            await ensureSourceIdentityIndexes();
            const [sites] = await db.query('SELECT * FROM my_sites');
            if (!sites || sites.length === 0) {
                return res.json({ success: true, message: 'Нет подключенных сайтов.' });
            }

            let totalProcessed = 0;
            
            for (const site of sites) {
                console.log(`[GLOBAL SYNC] Processing site: ${site.name} (ID: ${site.id})`);
                
                // 1. Инициализация (сброс is_active=0)
                await db.query('UPDATE my_products SET is_active = 0 WHERE site_id = ?', [site.id]);
                
                // 2. Подключение к БД донора
                let conn;
                try {
                    conn = await mysql.createConnection({ 
                        host: site.db_host, user: site.db_user, password: site.db_pass, database: site.db_name, connectTimeout: 10000 
                    });
                } catch (e) {
                    console.error(`[GLOBAL SYNC] Failed to connect to ${site.name}: ${e.message}`);
                    continue; // Пропускаем этот сайт и идем дальше
                }

                let offset = 0;
                let hasMore = true;
                const batchSize = settings.sync_batch_size || 500;
                const delay = settings.sync_delay_ms || 2000;

                while (hasMore) {
                    let query = '';
                    let rows;
                    if (site.cms_type === 'webasyst') {
                        query = `SELECT p.id as source_id, p.name, sk.${site.wa_field_sku_val} as sku, sk.${site.wa_field_price_val} as price, p.currency, sk.${site.wa_field_stock_val} as stock, p.url as url_key, CASE WHEN p.status = 1 THEN 1 ELSE 0 END as source_enabled FROM ${site.table_products} p JOIN ${site.wa_table_skus} sk ON p.id = sk.product_id LIMIT ${batchSize} OFFSET ${offset}`;
                        [rows] = await conn.query(query);
                    } else if (String(site.cms_type || '').toLowerCase() === 'bitrix') {
                        rows = await queryBitrixRowsWithSourceEnabledFallback(conn, site, batchSize, offset);
                    } else {
                        query = `SELECT ${site.field_code} as source_id, ${site.field_name} as name, ${site.field_sku} as sku, ${site.field_price} as price, ${site.field_currency} as currency, ${site.field_stock} as stock, '' as url_key, 1 as source_enabled FROM ${site.table_products} LIMIT ${batchSize} OFFSET ${offset}`;
                        [rows] = await conn.query(query);
                    }
                    
                    if (rows.length === 0) {
                        hasMore = false;
                        break;
                    }

                    const values = rows.map(r => [site.id, String(r.source_id || '').trim(), r.sku || '', r.name || '', r.price || 0, r.currency || 'RUB', r.stock || 0, buildSourceUrl(site.domain, r.url_key, site.cms_type), Number(r.source_enabled) === 0 ? 0 : 1]);
                    let priceUpdate = settings.sync_mode === 'always' ? 'price = VALUES(price),' : 'price = IF(price IS NULL OR price = 0, VALUES(price), price),';

                    await db.query(`INSERT INTO my_products (site_id, source_id, sku, name, price, currency, stock, source_url, source_enabled) VALUES ? ON DUPLICATE KEY UPDATE source_id = VALUES(source_id), ${priceUpdate} name = VALUES(name), currency = VALUES(currency), stock = VALUES(stock), source_url = VALUES(source_url), source_enabled = VALUES(source_enabled), is_active = 1, updated_at = NOW()`, [values]);

                    totalProcessed += rows.length;
                    offset += batchSize;
                    
                    console.log(`[GLOBAL SYNC] ${site.name}: processed ${totalProcessed} items so far.`);

                    // Пауза между пакетами
                    if (hasMore && delay > 0) {
                        await new Promise(r => setTimeout(r, delay));
                    }
                }
                await conn.end();
                
                // Удаляем старые товары (is_active=0) этого сайта? 
                // Обычно их просто помечают как неактивные, что мы уже сделали в начале.
                // Если нужно физически удалить: await db.query('DELETE FROM my_products WHERE site_id = ? AND is_active = 0', [site.id]);
            }

            console.log('[GLOBAL SYNC] FINISHED. Total processed:', totalProcessed);
            res.json({ success: true, message: `Глобальная синхронизация завершена! Обработано товаров: ${totalProcessed}` });

        } catch (e) {
            console.error('[GLOBAL SYNC] FATAL ERROR:', e);
            res.status(500).json({ error: e.message });
        }
    });

    return router;
};
