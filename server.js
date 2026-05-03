const express = require('express');
const mysql = require('mysql2/promise');
const bodyParser = require('body-parser');
const path = require('path');
const fs = require('fs/promises');
const fsSync = require('fs');
const bcrypt = require('bcryptjs');
const os = require('os');
const config = require('./config');

const app = express();
const PORT = config.port || 3000;
let db;
const postInitTasks = [];

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

// Глобальные настройки и состояние синхронизации
let appSettings = { 
    default_limit: 100, 
    parse_batch_size: 50,
    page_delay_ms: 0,
    sync_batch_size: 500,
    sync_delay_ms: 2000,
    ms_sync_page_limit: 1000,
    ms_sync_delay_ms: 0,
    sync_mode: 'always',
    log_retention_days: 7,
    results_retention_days: 120,
    auto_sync_myproducts_enabled: 0,
    auto_sync_myproducts_time: '03:00',
    auto_sync_moysklad_enabled: 0,
    auto_sync_moysklad_time: '04:00',
    discover_max_sitemaps: 200,
    discover_max_urls: 50000,
    discover_crawl_max_pages: 500,
    discover_request_delay_ms: 100,
    auth_session_ttl_days: 14,
    auth_session_user_limit: 1,
    /** Сколько минут без запросов к API — сессия не считается «онлайн» в виджете шапки. */
    auth_online_presence_minutes: 15
};
let syncState = { active: false, processed: 0, total: 0, message: '' };
const moyskladRouterFactory = require('./routes/moysklad');
const pagesRouterFactory = require('./routes/pages');
const matchesRouterFactory = require('./routes/matches');
let pagesRouter = null;
let matchesRouter = null;
const autoSyncLastRunByTask = new Map();
const autoSyncQueue = [];
let autoSyncRunnerActive = false;
const autoSyncRunIds = new Map();
let lastCpuUsage = process.cpuUsage();
let lastCpuCheckAt = process.hrtime.bigint();
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

async function queryBitrixRowsWithSourceEnabledFallback(conn, site, limit, offset) {
    const withSourceEnabled = `SELECT ${site.field_code} as source_id, ${site.field_name} as name, ${site.field_sku} as sku, ${site.field_price} as price, ${site.field_currency} as currency, ${site.field_stock} as stock, '' as url_key, COALESCE(SOURCE_ENABLED, 1) as source_enabled FROM ${site.table_products} LIMIT ? OFFSET ?`;
    try {
        const [rows] = await conn.query(withSourceEnabled, [limit, offset]);
        return rows;
    } catch (e) {
        if (!/Unknown column 'SOURCE_ENABLED'/i.test(String(e?.message || ''))) throw e;
        const fallback = `SELECT ${site.field_code} as source_id, ${site.field_name} as name, ${site.field_sku} as sku, ${site.field_price} as price, ${site.field_currency} as currency, ${site.field_stock} as stock, '' as url_key, 1 as source_enabled FROM ${site.table_products} LIMIT ? OFFSET ?`;
        const [rows] = await conn.query(fallback, [limit, offset]);
        return rows;
    }
}

async function initDB() {
    try {
        db = mysql.createPool({
            host: config.db.host,
            user: config.db.user,
            password: config.db.password,
            database: config.db.database,
            waitForConnections: true,
            connectionLimit: 10,
            queueLimit: 0
        });
        await db.query('SELECT 1');
        console.log('[DB] Connected');

        // Таблицы
        await db.query(`CREATE TABLE IF NOT EXISTS users (id INT AUTO_INCREMENT PRIMARY KEY, username VARCHAR(50) UNIQUE NOT NULL, full_name VARCHAR(150), password_hash VARCHAR(255) NOT NULL)`);
        const [fullNameCol] = await db.query(`
            SELECT COUNT(*) AS cnt
            FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA = ?
              AND TABLE_NAME = 'users'
              AND COLUMN_NAME = 'full_name'
        `, [config.db.database]);
        if (!fullNameCol[0]?.cnt) {
            await db.query('ALTER TABLE users ADD COLUMN full_name VARCHAR(150) AFTER username');
        }
        const [users] = await db.query('SELECT * FROM users WHERE username = ?', ['admin']);
        if (users.length === 0) {
            const hash = await bcrypt.hash('admin123', 10);
            await db.query('INSERT INTO users (username, full_name, password_hash) VALUES (?, ?, ?)', ['admin', 'Администратор', hash]);
        } else {
            await db.query('UPDATE users SET full_name = COALESCE(NULLIF(full_name, \'\'), ?) WHERE username = ?', ['Администратор', 'admin']);
        }

        await db.query(`CREATE TABLE IF NOT EXISTS app_settings (setting_key VARCHAR(50) PRIMARY KEY, setting_value TEXT)`);
        const defaults = [
            ['default_limit','100'],['parse_batch_size','50'],['page_delay_ms','0'],
            ['sync_batch_size','500'],['sync_delay_ms','2000'],['sync_mode','always'],['log_retention_days','7'],['results_retention_days','120'],
            ['ms_sync_page_limit','1000'],['ms_sync_delay_ms','0'],
            ['auto_sync_myproducts_enabled','0'],['auto_sync_myproducts_time','03:00'],
            ['auto_sync_moysklad_enabled','0'],['auto_sync_moysklad_time','04:00'],
            ['discover_max_sitemaps','200'],['discover_max_urls','50000'],
            ['discover_crawl_max_pages','500'],['discover_request_delay_ms','100'],
            ['auth_session_ttl_days','14'],['auth_session_user_limit','1'],
            ['auth_online_presence_minutes','15']
        ];
        for (const [k, v] of defaults) await db.query('INSERT IGNORE INTO app_settings (setting_key, setting_value) VALUES (?, ?)', [k, v]);

        const [rows] = await db.query('SELECT * FROM app_settings');
        rows.forEach(r => {
            if (appSettings.hasOwnProperty(r.setting_key)) {
                appSettings[r.setting_key] = r.setting_key.includes('limit') || r.setting_key.includes('size') || r.setting_key.includes('delay') || r.setting_key.includes('days') || r.setting_key.includes('minutes')
                    ? parseInt(r.setting_value)
                    : r.setting_value;
            }
        });
        console.log('[Settings] Loaded', appSettings);
        // Снимаем "зависшие" processing после перезапуска сервера,
        // чтобы в очереди не висели ложные статусы выполнения.
        try {
            await db.query(`
                UPDATE pages
                SET status = 'error',
                    last_error = CASE
                        WHEN COALESCE(last_error, '') = '' THEN 'Прервано: сервер перезапущен'
                        ELSE CONCAT('Прервано: сервер перезапущен; ', last_error)
                    END,
                    parsed_at = NOW()
                WHERE status = 'processing'
            `);
        } catch (_) {}
        // Fast-start mode: avoid blocking startup on heavy schema checks/migrations.
        // The current project DB is already initialized; this keeps the app available
        // even if long-running DDL statements are blocked by metadata locks.
        console.log('[DB] Fast start: skipping startup migrations');
        return db;

        await db.query(`CREATE TABLE IF NOT EXISTS projects (id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(255), domain VARCHAR(255), selector_price VARCHAR(255), selector_name VARCHAR(255), selector_sku VARCHAR(255), selector_oos VARCHAR(255))`);
        await db.query(`CREATE TABLE IF NOT EXISTS pages (id INT AUTO_INCREMENT PRIMARY KEY, project_id INT, url TEXT, page_type VARCHAR(50), status VARCHAR(20), last_error TEXT, parsed_at TIMESTAMP NULL)`);
        await db.query(`CREATE TABLE IF NOT EXISTS prices (id INT AUTO_INCREMENT PRIMARY KEY, project_id INT, page_id INT, sku VARCHAR(100), product_name VARCHAR(255), price DECIMAL(10,2), currency VARCHAR(10), is_oos TINYINT(1), url TEXT, parsed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
        await db.query(`CREATE TABLE IF NOT EXISTS my_sites (id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(255), domain VARCHAR(255), cms_type VARCHAR(50), db_host VARCHAR(255), db_name VARCHAR(255), db_user VARCHAR(255), db_pass VARCHAR(255), table_products VARCHAR(255), field_name VARCHAR(255), field_sku VARCHAR(255), field_code VARCHAR(255), field_price VARCHAR(255), field_currency VARCHAR(255), field_stock VARCHAR(255), wa_table_skus VARCHAR(255), wa_field_sku_val VARCHAR(255), wa_field_price_val VARCHAR(255), wa_field_stock_val VARCHAR(255))`);
        await db.query(`CREATE TABLE IF NOT EXISTS my_products (id INT AUTO_INCREMENT PRIMARY KEY, site_id INT, source_id VARCHAR(255), sku VARCHAR(100), name VARCHAR(255), price DECIMAL(15,2), currency VARCHAR(10), stock INT, source_url VARCHAR(2048), is_active TINYINT(1) DEFAULT 1, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, UNIQUE KEY unique_site_source (site_id, source_id), KEY idx_source_id (source_id))`);
        await db.query(`CREATE TABLE IF NOT EXISTS ms_export (
            id INT AUTO_INCREMENT PRIMARY KEY,
            code VARCHAR(255) NOT NULL,
            name VARCHAR(500),
            manager VARCHAR(255),
            content_manager VARCHAR(255),
            uuid VARCHAR(255),
            type VARCHAR(50),
            stock_position VARCHAR(10),
            no_longer_cooperation VARCHAR(10),
            price_comment TEXT,
            vat VARCHAR(50),
            vat_on_product VARCHAR(50),
            supplier VARCHAR(255),
            supplier2 VARCHAR(255),
            automation_price VARCHAR(255),
            packing_standard VARCHAR(255),
            packing_own_box VARCHAR(255),
            packing_weight VARCHAR(255),
            sale_price VARCHAR(100),
            buy_price VARCHAR(100),
            stock INT DEFAULT 0,
            stock_days VARCHAR(50),
            updated_label VARCHAR(50),
            synced_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            UNIQUE KEY uniq_ms_export_code (code),
            INDEX idx_ms_export_type (type),
            INDEX idx_ms_export_supplier (supplier)
        )`);
        await db.query(`CREATE TABLE IF NOT EXISTS product_matches (
            id INT AUTO_INCREMENT PRIMARY KEY,
            my_site_id INT NOT NULL,
            my_sku VARCHAR(255),
            my_product_name VARCHAR(500),
            competitor_site_id INT NOT NULL,
            competitor_sku VARCHAR(255),
            competitor_name VARCHAR(500),
            match_type VARCHAR(20) DEFAULT 'name',
            matching_mode VARCHAR(24) NULL,
            confidence_score DECIMAL(5,4) DEFAULT 0,
            status VARCHAR(20) DEFAULT 'pending',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            INDEX idx_pm_my_site (my_site_id),
            INDEX idx_pm_status (status),
            INDEX idx_pm_comp_site (competitor_site_id)
        )`);
        await db.query(`CREATE TABLE IF NOT EXISTS matching_jobs (
            id INT AUTO_INCREMENT PRIMARY KEY,
            my_site_id INT NOT NULL,
            status VARCHAR(20) NOT NULL DEFAULT 'running',
            params_json LONGTEXT,
            phases_json LONGTEXT NULL,
            checkpoint_comp_index INT NOT NULL DEFAULT 0,
            checkpoint_product_index INT NOT NULL DEFAULT 0,
            processed INT NOT NULL DEFAULT 0,
            total INT NOT NULL DEFAULT 0,
            found INT NOT NULL DEFAULT 0,
            found_sku INT NOT NULL DEFAULT 0,
            found_name INT NOT NULL DEFAULT 0,
            message TEXT,
            started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            finished_at TIMESTAMP NULL,
            INDEX idx_mj_site_status (my_site_id, status),
            INDEX idx_mj_started (started_at)
        )`);
        await db.query(`CREATE TABLE IF NOT EXISTS matching_job_logs (
            id INT AUTO_INCREMENT PRIMARY KEY,
            job_id INT NOT NULL,
            message TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            INDEX idx_mjl_job (job_id, id)
        )`);
        await db.query(`CREATE TABLE IF NOT EXISTS match_exclusion (
            id INT AUTO_INCREMENT PRIMARY KEY,
            my_site_id INT NOT NULL,
            competitor_site_id INT NOT NULL,
            my_product_id INT NOT NULL,
            reason VARCHAR(24) NOT NULL,
            source_product_match_id INT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            UNIQUE KEY uq_match_exclusion (my_site_id, competitor_site_id, my_product_id),
            INDEX idx_mex_site (my_site_id),
            INDEX idx_mex_comp (competitor_site_id)
        )`);
        await db.query(`CREATE TABLE IF NOT EXISTS match_manual_archive (
            id INT AUTO_INCREMENT PRIMARY KEY,
            my_site_id INT NOT NULL,
            competitor_site_id INT NOT NULL,
            my_product_id INT NOT NULL,
            competitor_sku VARCHAR(255) NULL,
            competitor_name VARCHAR(500) NULL,
            note VARCHAR(500) NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            INDEX idx_march_site (my_site_id),
            INDEX idx_march_comp (competitor_site_id)
        )`);
        await db.query(`CREATE TABLE IF NOT EXISTS match_product_log (
            id BIGINT AUTO_INCREMENT PRIMARY KEY,
            my_site_id INT NOT NULL,
            my_product_id INT NOT NULL,
            competitor_site_id INT NULL,
            event VARCHAR(64) NOT NULL,
            message VARCHAR(512) NULL,
            detail_json LONGTEXT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            INDEX idx_mplog_prod (my_site_id, my_product_id, id)
        )`);
        const [paramsCol] = await db.query(`
            SELECT COUNT(*) AS cnt
            FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA = ?
              AND TABLE_NAME = 'matching_jobs'
              AND COLUMN_NAME = 'params_json'
        `, [config.db.database]);
        if (!paramsCol[0]?.cnt) {
            await db.query('ALTER TABLE matching_jobs ADD COLUMN params_json LONGTEXT');
        }
        const [chkCompCol] = await db.query(`
            SELECT COUNT(*) AS cnt
            FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA = ?
              AND TABLE_NAME = 'matching_jobs'
              AND COLUMN_NAME = 'checkpoint_comp_index'
        `, [config.db.database]);
        if (!chkCompCol[0]?.cnt) {
            await db.query('ALTER TABLE matching_jobs ADD COLUMN checkpoint_comp_index INT NOT NULL DEFAULT 0');
        }
        const [chkProdCol] = await db.query(`
            SELECT COUNT(*) AS cnt
            FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA = ?
              AND TABLE_NAME = 'matching_jobs'
              AND COLUMN_NAME = 'checkpoint_product_index'
        `, [config.db.database]);
        if (!chkProdCol[0]?.cnt) {
            await db.query('ALTER TABLE matching_jobs ADD COLUMN checkpoint_product_index INT NOT NULL DEFAULT 0');
        }
        const [foundSkuCol] = await db.query(`
            SELECT COUNT(*) AS cnt
            FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA = ?
              AND TABLE_NAME = 'matching_jobs'
              AND COLUMN_NAME = 'found_sku'
        `, [config.db.database]);
        if (!foundSkuCol[0]?.cnt) {
            await db.query('ALTER TABLE matching_jobs ADD COLUMN found_sku INT NOT NULL DEFAULT 0');
        }
        const [foundNameCol] = await db.query(`
            SELECT COUNT(*) AS cnt
            FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA = ?
              AND TABLE_NAME = 'matching_jobs'
              AND COLUMN_NAME = 'found_name'
        `, [config.db.database]);
        if (!foundNameCol[0]?.cnt) {
            await db.query('ALTER TABLE matching_jobs ADD COLUMN found_name INT NOT NULL DEFAULT 0');
        }
        const [phasesJsonCol] = await db.query(`
            SELECT COUNT(*) AS cnt
            FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA = ?
              AND TABLE_NAME = 'matching_jobs'
              AND COLUMN_NAME = 'phases_json'
        `, [config.db.database]);
        if (!phasesJsonCol[0]?.cnt) {
            await db.query('ALTER TABLE matching_jobs ADD COLUMN phases_json LONGTEXT NULL');
        }
        const [buyPriceCol] = await db.query(`
            SELECT COUNT(*) AS cnt
            FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA = ?
              AND TABLE_NAME = 'ms_export'
              AND COLUMN_NAME = 'buy_price'
        `, [config.db.database]);
        if (!buyPriceCol[0]?.cnt) {
            await db.query('ALTER TABLE ms_export ADD COLUMN buy_price VARCHAR(100)');
        }
        const [sourceIdCol] = await db.query(`
            SELECT COUNT(*) AS cnt
            FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA = ?
              AND TABLE_NAME = 'my_products'
              AND COLUMN_NAME = 'source_id'
        `, [config.db.database]);
        if (!sourceIdCol[0]?.cnt) {
            await db.query('ALTER TABLE my_products ADD COLUMN source_id VARCHAR(255)');
            await db.query('CREATE INDEX idx_source_id ON my_products (source_id)');
        }
        const [sourceActiveIdx] = await db.query(`
            SELECT COUNT(*) AS cnt
            FROM information_schema.STATISTICS
            WHERE TABLE_SCHEMA = ?
              AND TABLE_NAME = 'my_products'
              AND INDEX_NAME = 'idx_source_active'
        `, [config.db.database]);
        if (!sourceActiveIdx[0]?.cnt) {
            console.log('[DB] Fast start: skip creating idx_source_active at startup');
        }
        const [sourceUrlCol] = await db.query(`
            SELECT COUNT(*) AS cnt
            FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA = ?
              AND TABLE_NAME = 'my_products'
              AND COLUMN_NAME = 'source_url'
        `, [config.db.database]);
        if (!sourceUrlCol[0]?.cnt) {
            await db.query('ALTER TABLE my_products ADD COLUMN source_url VARCHAR(2048)');
        }
        await db.query(`
            UPDATE matching_jobs
            SET status = 'failed',
                message = 'Задача прервана из-за перезапуска сервера',
                finished_at = NOW()
            WHERE status = 'running'
        `);
        const [statusCol] = await db.query(`
            SELECT COUNT(*) AS cnt
            FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA = ?
              AND TABLE_NAME = 'product_matches'
              AND COLUMN_NAME = 'status'
        `, [config.db.database]);
        if (!statusCol[0]?.cnt) {
            await db.query(`ALTER TABLE product_matches ADD COLUMN status VARCHAR(20) DEFAULT 'pending'`);
        }

        const [scoreCol] = await db.query(`
            SELECT COUNT(*) AS cnt
            FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA = ?
              AND TABLE_NAME = 'product_matches'
              AND COLUMN_NAME = 'confidence_score'
        `, [config.db.database]);
        if (!scoreCol[0]?.cnt) {
            await db.query(`ALTER TABLE product_matches ADD COLUMN confidence_score DECIMAL(5,4) DEFAULT 0`);
        }
        const ensureProductMatchesCols = [
            { name: 'my_product_name', sql: 'ALTER TABLE product_matches ADD COLUMN my_product_name VARCHAR(500)' },
            { name: 'competitor_site_id', sql: 'ALTER TABLE product_matches ADD COLUMN competitor_site_id INT NOT NULL DEFAULT 0' },
            { name: 'competitor_sku', sql: 'ALTER TABLE product_matches ADD COLUMN competitor_sku VARCHAR(255)' },
            { name: 'competitor_name', sql: 'ALTER TABLE product_matches ADD COLUMN competitor_name VARCHAR(500)' },
            { name: 'match_type', sql: "ALTER TABLE product_matches ADD COLUMN match_type VARCHAR(20) DEFAULT 'name'" },
            { name: 'matching_mode', sql: 'ALTER TABLE product_matches ADD COLUMN matching_mode VARCHAR(24) NULL' },
            { name: 'created_at', sql: 'ALTER TABLE product_matches ADD COLUMN created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP' },
            { name: 'updated_at', sql: 'ALTER TABLE product_matches ADD COLUMN updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP' },
        ];
        for (const col of ensureProductMatchesCols) {
            const [c] = await db.query(`
                SELECT COUNT(*) AS cnt
                FROM information_schema.COLUMNS
                WHERE TABLE_SCHEMA = ?
                  AND TABLE_NAME = 'product_matches'
                  AND COLUMN_NAME = ?
            `, [config.db.database, col.name]);
            if (!c[0]?.cnt) {
                await db.query(col.sql);
            }
        }

        console.log('[DB] Tables checked');
        return db;
    } catch (err) {
        console.error('[DB] Fatal Error:', err);
        process.exit(1);
    }
}

app.use(bodyParser.json({ limit: '10mb' }));

// Подключение роутов (ТОЛЬКО ПОСЛЕ инициализации БД внутри initDB, но мы вызовем их позже)
// Чтобы избежать ошибки require, мы подключим их внутри .then()

// Эндпоинты глобальной синхронизации (прямо здесь, чтобы не зависеть от роутов)
function startGlobalSyncBackground(targetSiteId = null) {
    if (syncState.active) return { success: false, message: 'Синхронизация уже идет' };
    
    // Запускаем в фоне
    (async () => {
        syncState.active = true;
        syncState.processed = 0;
        syncState.total = 0;
        syncState.message = 'Запуск...';
        console.log('[GLOBAL SYNC] STARTED');
        
        try {
            if (!db) throw new Error('DB not connected');
            await ensureSourceEnabledColumn();
            await ensureSourceIdentityIndexes();
            const hasTargetSite = Number.isFinite(Number(targetSiteId)) && Number(targetSiteId) > 0;
            const [sites] = hasTargetSite
                ? await db.query('SELECT * FROM my_sites WHERE id = ?', [Number(targetSiteId)])
                : await db.query('SELECT * FROM my_sites');
            if (!sites || sites.length === 0) {
                syncState.message = hasTargetSite ? 'Сайт не найден' : 'Нет сайтов';
                syncState.active = false;
                return;
            }

            let totalProcessed = 0;
            for (const site of sites) {
                syncState.message = `Синхронизация: ${site.name}...`;
                console.log(`[SYNC] Site: ${site.name}`);
                
                // Сброс
                await db.query('UPDATE my_products SET is_active = 0 WHERE site_id = ?', [site.id]);
                
                let conn;
                try {
                    conn = await mysql.createConnection({ 
                        host: site.db_host, user: site.db_user, password: site.db_pass, database: site.db_name, connectTimeout: 10000 
                    });
                } catch (e) {
                    console.error(`[SYNC] Connect error ${site.name}:`, e.message);
                    continue;
                }

                let offset = 0;
                const batchSize = appSettings.sync_batch_size || 500;
                const delay = appSettings.sync_delay_ms || 2000;

                while (true) {
                    let query = '';
                    let rows;
                    if (site.cms_type === 'webasyst') {
                        query = `SELECT p.id as source_id, p.name, sk.${site.wa_field_sku_val} as sku, sk.${site.wa_field_price_val} as price, p.currency, sk.${site.wa_field_stock_val} as stock, p.url as url_key, CASE WHEN p.status = 1 THEN 1 ELSE 0 END as source_enabled FROM ${site.table_products} p JOIN ${site.wa_table_skus} sk ON p.id = sk.product_id LIMIT ? OFFSET ?`;
                        [rows] = await conn.query(query, [batchSize, offset]);
                    } else if (String(site.cms_type || '').toLowerCase() === 'bitrix') {
                        rows = await queryBitrixRowsWithSourceEnabledFallback(conn, site, batchSize, offset);
                    } else {
                        query = `SELECT ${site.field_code} as source_id, ${site.field_name} as name, ${site.field_sku} as sku, ${site.field_price} as price, ${site.field_currency} as currency, ${site.field_stock} as stock, '' as url_key, 1 as source_enabled FROM ${site.table_products} LIMIT ? OFFSET ?`;
                        [rows] = await conn.query(query, [batchSize, offset]);
                    }
                    if (rows.length === 0) break;

                    const values = rows.map(r => {
                        const sourceUrl = buildSourceUrl(site.domain, r.url_key, site.cms_type);
                        return [site.id, String(r.source_id || '').trim(), r.sku || '', r.name || '', r.price || 0, r.currency || 'RUB', r.stock || 0, sourceUrl, Number(r.source_enabled) === 0 ? 0 : 1];
                    });
                    const priceUpdate = appSettings.sync_mode === 'always' ? 'price = VALUES(price),' : 'price = IF(price IS NULL OR price = 0, VALUES(price), price),';

                    await db.query(`INSERT INTO my_products (site_id, source_id, sku, name, price, currency, stock, source_url, source_enabled) VALUES ? ON DUPLICATE KEY UPDATE source_id = VALUES(source_id), ${priceUpdate} name = VALUES(name), currency = VALUES(currency), stock = VALUES(stock), source_url = VALUES(source_url), source_enabled = VALUES(source_enabled), is_active = 1, updated_at = NOW()`, [values]);

                    totalProcessed += rows.length;
                    syncState.processed = totalProcessed;
                    offset += batchSize;

                    if (delay > 0) await new Promise(r => setTimeout(r, delay));
                }
                await conn.end();
                
                // Удаление неактивных (опционально, сейчас просто помечены)
                // await db.query('DELETE FROM my_products WHERE site_id = ? AND is_active = 0', [site.id]);
            }
            
            syncState.message = 'Готово!';
            syncState.active = false;
            console.log('[GLOBAL SYNC] FINISHED. Total:', totalProcessed);
        } catch (e) {
            syncState.message = 'Ошибка: ' + e.message;
            syncState.active = false;
            console.error('[GLOBAL SYNC] ERROR:', e);
        }
    })();

    return { success: true, message: 'Синхронизация запущена в фоне' };
}

async function cleanupLogsByRetentionDays(days) {
    const retentionDays = Number(days) || 7;
    const maxAgeMs = retentionDays * 24 * 60 * 60 * 1000;
    const now = Date.now();
    const logs = [path.join(__dirname, 'server.log'), path.join(__dirname, 'worker.log')];

    for (const file of logs) {
        try {
            const stat = await fs.stat(file);
            const ageMs = now - stat.mtimeMs;
            if (ageMs > maxAgeMs) {
                await fs.writeFile(file, '', 'utf8');
                console.log(`[LOG CLEANUP] Cleared ${path.basename(file)} (older than ${retentionDays} days)`);
            }
        } catch (_) {
            // Ignore missing log files.
        }
    }
}

async function cleanupResultsByRetentionDays(days) {
    const retentionDays = Number(days) || 120;
    if (retentionDays <= 0) return;
    try {
        const [r] = await db.query(
            `DELETE FROM prices
             WHERE parsed_at IS NOT NULL
               AND parsed_at < (NOW() - INTERVAL ? DAY)`,
            [retentionDays]
        );
        const deleted = Number(r?.affectedRows || 0);
        if (deleted > 0) {
            console.log(`[RESULTS CLEANUP] Deleted ${deleted} rows older than ${retentionDays} days`);
        }
    } catch (e) {
        console.warn('[RESULTS CLEANUP] failed:', e?.message || e);
    }
}

function getMoscowNowParts() {
    const fmtDate = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    const fmtTime = new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());
    return { date: fmtDate, time: fmtTime };
}

function getRuntimeMetrics() {
    const now = process.hrtime.bigint();
    const cpuNow = process.cpuUsage();
    const elapsedMicros = Number(now - lastCpuCheckAt) / 1000;
    const cpuDelta = process.cpuUsage(lastCpuUsage);
    const cpuUsedMicros = Number(cpuDelta.user || 0) + Number(cpuDelta.system || 0);
    const cpuPercent = elapsedMicros > 0
        ? Math.max(0, Math.min(100, (cpuUsedMicros / elapsedMicros) * 100))
        : 0;
    lastCpuUsage = cpuNow;
    lastCpuCheckAt = now;

    const mem = process.memoryUsage();
    const totalMem = Number(os.totalmem() || 0);
    const usedRss = Number(mem.rss || 0);
    const rssPercent = totalMem > 0
        ? Math.max(0, Math.min(100, (usedRss / totalMem) * 100))
        : 0;

    return {
        pid: process.pid,
        uptimeSec: Math.floor(process.uptime()),
        cpuPercent: Number(cpuPercent.toFixed(1)),
        memory: {
            rssBytes: usedRss,
            heapUsedBytes: Number(mem.heapUsed || 0),
            heapTotalBytes: Number(mem.heapTotal || 0),
            systemTotalBytes: totalMem,
            systemFreeBytes: Number(os.freemem() || 0),
            rssPercentOfSystem: Number(rssPercent.toFixed(1))
        },
        loadAvg: os.loadavg().map((n) => Number(n.toFixed(2)))
    };
}

function enqueueAutoSyncTask(taskType) {
    if (!taskType) return;
    if (autoSyncQueue.includes(taskType)) return;
    autoSyncQueue.push(taskType);
}

async function ensureAutoSyncRunsTable() {
    await db.query(`
        CREATE TABLE IF NOT EXISTS auto_sync_runs (
            id INT AUTO_INCREMENT PRIMARY KEY,
            task_type VARCHAR(30) NOT NULL,
            trigger_type VARCHAR(20) NOT NULL DEFAULT 'schedule',
            started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            finished_at TIMESTAMP NULL,
            status VARCHAR(20) NOT NULL DEFAULT 'running',
            message TEXT,
            INDEX idx_asr_started (started_at),
            INDEX idx_asr_task (task_type, started_at)
        )
    `);
}

async function startAutoSyncRun(taskType, triggerType = 'schedule') {
    await ensureAutoSyncRunsTable();
    const [r] = await db.query(
        'INSERT INTO auto_sync_runs (task_type, trigger_type, status, message) VALUES (?, ?, ?, ?)',
        [taskType, triggerType, 'running', 'Запуск задачи']
    );
    const runId = Number(r?.insertId || 0);
    if (runId) autoSyncRunIds.set(taskType, runId);
    return runId;
}

async function finishAutoSyncRun(taskType, status = 'completed', message = '') {
    const runId = autoSyncRunIds.get(taskType);
    if (!runId) return;
    await db.query(
        'UPDATE auto_sync_runs SET status = ?, message = ?, finished_at = NOW() WHERE id = ?',
        [status, message || '', runId]
    );
    autoSyncRunIds.delete(taskType);
}

async function waitUntil(predicate, timeoutMs = 24 * 60 * 60 * 1000, tickMs = 1000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
        if (predicate()) return true;
        await new Promise((r) => setTimeout(r, tickMs));
    }
    return false;
}

async function processAutoSyncQueue() {
    if (autoSyncRunnerActive) return;
    autoSyncRunnerActive = true;
    try {
        while (autoSyncQueue.length > 0) {
            const task = autoSyncQueue.shift();
            if (task === 'myproducts') {
                console.log('[AUTO SYNC] Queue start: myproducts');
                await startAutoSyncRun('myproducts', 'schedule');
                if (!syncState.active) startGlobalSyncBackground();
                const done = await waitUntil(() => !syncState.active, 12 * 60 * 60 * 1000, 1000);
                await finishAutoSyncRun('myproducts', done ? 'completed' : 'failed', done ? 'Завершено' : 'Таймаут ожидания');
                console.log('[AUTO SYNC] Queue done: myproducts');
            } else if (task === 'moysklad') {
                console.log('[AUTO SYNC] Queue start: moysklad');
                await startAutoSyncRun('moysklad', 'schedule');
                if (typeof moyskladRouterFactory.triggerSync === 'function') {
                    await moyskladRouterFactory.triggerSync();
                }
                const done = await waitUntil(() => {
                    const s = typeof moyskladRouterFactory.getJobState === 'function'
                        ? moyskladRouterFactory.getJobState()
                        : { active: false };
                    return !s.active;
                }, 12 * 60 * 60 * 1000, 1000);
                await finishAutoSyncRun('moysklad', done ? 'completed' : 'failed', done ? 'Завершено' : 'Таймаут ожидания');
                console.log('[AUTO SYNC] Queue done: moysklad');
            }
        }
    } catch (e) {
        console.error('[AUTO SYNC] Queue error:', e.message);
        if (autoSyncRunIds.has('myproducts')) {
            await finishAutoSyncRun('myproducts', 'failed', e.message || 'Ошибка очереди');
        }
        if (autoSyncRunIds.has('moysklad')) {
            await finishAutoSyncRun('moysklad', 'failed', e.message || 'Ошибка очереди');
        }
    } finally {
        autoSyncRunnerActive = false;
    }
}

function startAutoSyncScheduler() {
    setInterval(async () => {
        try {
            const now = getMoscowNowParts();
            const tasks = [
                {
                    type: 'myproducts',
                    enabled: Number(appSettings.auto_sync_myproducts_enabled || 0) === 1,
                    time: String(appSettings.auto_sync_myproducts_time || '03:00').slice(0, 5)
                },
                {
                    type: 'moysklad',
                    enabled: Number(appSettings.auto_sync_moysklad_enabled || 0) === 1,
                    time: String(appSettings.auto_sync_moysklad_time || '04:00').slice(0, 5)
                }
            ];
            for (const t of tasks) {
                if (!t.enabled) continue;
                if (now.time !== t.time) continue;
                const runKey = `${now.date} ${t.time}`;
                const last = autoSyncLastRunByTask.get(t.type);
                if (last === runKey) continue;
                autoSyncLastRunByTask.set(t.type, runKey);
                enqueueAutoSyncTask(t.type);
            }
            processAutoSyncQueue();
        } catch (e) {
            console.error('[AUTO SYNC] ERROR:', e.message);
        }
    }, 30 * 1000);
}

function startUnifiedTaskWatchdog() {
    setInterval(async () => {
        try {
            if (typeof matchesRouter?.watchdogTick === 'function') {
                await matchesRouter.watchdogTick();
            }
            if (typeof pagesRouter?.watchdogTick === 'function') {
                await pagesRouter.watchdogTick();
            }
        } catch (e) {
            console.error('[WATCHDOG] ERROR:', e.message || e);
        }
    }, 60 * 1000);
}

// Инициализация БД и запуск сервера
initDB().then(() => {
    // Подключаем роуты ТОЛЬКО после успешного подключения к БД
    const authModule = require('./routes/auth')(db, appSettings);

    /** Все /api, кроме входа/выхода, только с валидной сессией (httpOnly dg_session и/или x-auth-token). */
    app.use('/api', async (req, res, next) => {
        if (req.method === 'OPTIONS') return next();
        const pathOnly = String(req.path || '').split('?')[0];
        const isPublicAuth =
            (req.method === 'POST' && (pathOnly === '/login' || pathOnly === '/auth/login')) ||
            (req.method === 'POST' && (pathOnly === '/logout' || pathOnly === '/auth/logout'));
        if (isPublicAuth) return next();
        try {
            const actor = await authModule.getActor(req);
            if (!actor) {
                res.status(401);
                return res.json({ error: 'Не авторизован', code: 'AUTH_REQUIRED' });
            }
            req.datagonActor = actor;
            return next();
        } catch (e) {
            return next(e);
        }
    });

    app.use('/api/auth', authModule.router);
    // Совместимость со старым фронтендом/кэшем, где логин идет на /api/login
    app.use('/api', authModule.router);
    app.use('/api/activity', require('./routes/activity')(db));
    app.use('/api/settings', require('./routes/settings')(db, appSettings));
    app.use('/api/projects', require('./routes/projects')(db, appSettings));
    pagesRouter = pagesRouterFactory(db, appSettings);
    app.use('/api/pages', pagesRouter);

    app.post('/api/sync-all-start', async (req, res) => {
        if (syncState.active) return res.json({ success: false, message: 'Синхронизация уже идет' });
        startGlobalSyncBackground();
        res.json({ success: true, message: 'Синхронизация запущена в фоне' });
    });

    app.post('/api/sync-site-start', async (req, res) => {
        if (syncState.active) return res.json({ success: false, message: 'Синхронизация уже идет' });
        const siteId = Number(req.body?.site_id || 0);
        if (!Number.isFinite(siteId) || siteId <= 0) {
            return res.status(400).json({ success: false, error: 'site_id обязателен' });
        }
        startGlobalSyncBackground(siteId);
        res.json({ success: true, message: 'Синхронизация выбранного сайта запущена в фоне' });
    });

    app.get('/api/sync-status', (req, res) => {
        res.json(syncState);
    });

    app.get('/api/processes/overview', async (req, res) => {
        try {
            const selectedSiteIdRaw = req.query.my_site_id;
            const selectedSiteId = selectedSiteIdRaw ? parseInt(selectedSiteIdRaw, 10) : null;

            const globalSync = {
                active: Boolean(syncState.active),
                processed: Number(syncState.processed || 0),
                total: Number(syncState.total || 0),
                message: syncState.message || ''
            };

            const moysklad = typeof moyskladRouterFactory.getJobState === 'function'
                ? moyskladRouterFactory.getJobState()
                : { active: false, done: false, processed: 0, total: 0, message: 'Недоступно', logs: [], updatedAt: null };
            const mskNow = getMoscowNowParts();
            const autoSync = {
                now_moscow_time: mskNow.time,
                now_moscow_date: mskNow.date,
                queue: [...autoSyncQueue],
                runner_active: Boolean(autoSyncRunnerActive),
                config: {
                    myproducts_enabled: Number(appSettings.auto_sync_myproducts_enabled || 0) === 1,
                    myproducts_time: String(appSettings.auto_sync_myproducts_time || '03:00'),
                    moysklad_enabled: Number(appSettings.auto_sync_moysklad_enabled || 0) === 1,
                    moysklad_time: String(appSettings.auto_sync_moysklad_time || '04:00')
                }
            };
            const discovery = (typeof pagesRouter?.getDiscoveryJobsSnapshot === 'function')
                ? pagesRouter.getDiscoveryJobsSnapshot()
                : [];
            let autoSyncRuns = [];
            try {
                await ensureAutoSyncRunsTable();
                const [runs] = await db.query(`
                    SELECT id, task_type, trigger_type, started_at, finished_at, status, message
                    FROM auto_sync_runs
                    ORDER BY id DESC
                    LIMIT 20
                `);
                autoSyncRuns = runs;
            } catch (_) {}

            const [queueRows] = await db.query('SELECT status, COUNT(*) AS cnt FROM pages GROUP BY status');
            const queue = { pending: 0, processing: 0, done: 0, error: 0, total: 0 };
            for (const row of queueRows) {
                const key = row.status;
                const cnt = Number(row.cnt || 0);
                if (Object.prototype.hasOwnProperty.call(queue, key)) {
                    queue[key] = cnt;
                } else {
                    queue.total += cnt;
                }
            }
            queue.total += queue.pending + queue.processing + queue.done + queue.error;

            const [sites] = await db.query('SELECT id, name FROM my_sites ORDER BY name');
            const matchesSites = sites.map((s) => ({ id: s.id, name: s.name || `Сайт #${s.id}` }));
            const fallbackSiteId = matchesSites.length ? matchesSites[0].id : null;
            const effectiveSiteId = Number.isFinite(selectedSiteId) ? selectedSiteId : fallbackSiteId;

            let matches = {
                mySiteId: effectiveSiteId,
                active: false,
                done: false,
                status: 'idle',
                processed: 0,
                total: 0,
                found: 0,
                foundSku: 0,
                foundName: 0,
                message: effectiveSiteId ? 'Нет задач' : 'Нет доступных сайтов',
                phases: [],
                logs: [],
                canRetry: false
            };

            if (effectiveSiteId) {
                const [jobs] = await db.query(
                    'SELECT * FROM matching_jobs WHERE my_site_id = ? ORDER BY id DESC LIMIT 1',
                    [effectiveSiteId]
                );
                if (jobs.length) {
                    const job = jobs[0];
                    const [logs] = await db.query(
                        'SELECT message, created_at FROM matching_job_logs WHERE job_id = ? ORDER BY id DESC LIMIT 20',
                        [job.id]
                    );
                    let matchPhases = [];
                    try {
                        matchPhases = job.phases_json ? JSON.parse(job.phases_json) : [];
                        if (!Array.isArray(matchPhases)) matchPhases = [];
                    } catch (_) {
                        matchPhases = [];
                    }
                    matches = {
                        mySiteId: effectiveSiteId,
                        active: job.status === 'running',
                        done: job.status === 'completed' || job.status === 'failed',
                        status: job.status,
                        processed: Number(job.processed || 0),
                        total: Number(job.total || 0),
                        found: Number(job.found || 0),
                        foundSku: Number(job.found_sku || 0),
                        foundName: Number(job.found_name || 0),
                        message: job.message || '',
                        phases: matchPhases,
                        logs: logs.map((l) => {
                            const t = new Date(l.created_at).toLocaleTimeString('ru-RU');
                            return `[${t}] ${l.message}`;
                        }),
                        canRetry: job.status === 'failed' || job.status === 'completed'
                    };
                }
            }

            return res.json({
                refreshedAt: new Date().toISOString(),
                globalSync,
                moysklad,
                autoSync,
                autoSyncRuns,
                discovery,
                queue,
                matchesSites,
                matches,
                runtime: getRuntimeMetrics()
            });
        } catch (e) {
            return res.status(500).json({ error: e.message });
        }
    });
    const resultsRouter = require('./routes/results')(db, appSettings);
    app.use('/api/results', resultsRouter);
    app.use('/api/my-sites', require('./routes/mysites')(db, appSettings));
    app.use('/api/my-products', require('./routes/myproducts')(db, appSettings));
    matchesRouter = matchesRouterFactory(db, appSettings);
    app.use('/api/matches', matchesRouter);
    setImmediate(() => {
        if (matchesRouter && typeof matchesRouter.warmupMatchingIndexes === 'function') {
            matchesRouter.warmupMatchingIndexes().catch((err) => {
                console.warn('[matches] warmupMatchingIndexes:', err && err.message ? err.message : err);
            });
        }
        if (resultsRouter && typeof resultsRouter.warmupResultsListPerf === 'function') {
            resultsRouter.warmupResultsListPerf().catch((err) => {
                console.warn('[results] warmupResultsListPerf:', err && err.message ? err.message : err);
            });
        }
    });
    app.use('/api/ms', moyskladRouterFactory(db, appSettings, config));
    
    // Алиас для совместимости, если фронт стучится сюда
    app.use('/api/parse', pagesRouter);

    app.use(authModule.protectDocumentationRoutes);

    const qsFromReq = (req) =>
        req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
    const redirectToDatagonHtml = (htmlName) => (req, res) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') return res.status(405).end();
        return res.redirect(301, `/${htmlName}${qsFromReq(req)}`);
    };

    app.get('/', (req, res, next) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') return next();
        return res.redirect(302, '/dashboard.html');
    });

    app.get('/dashboard', redirectToDatagonHtml('dashboard.html'));
    app.get('/my-sites', redirectToDatagonHtml('my-sites.html'));
    app.get('/my-products', redirectToDatagonHtml('my-products.html'));
    app.get('/moysklad', redirectToDatagonHtml('moysklad.html'));
    app.get('/matches', redirectToDatagonHtml('matches.html'));
    app.get('/matching', redirectToDatagonHtml('matches.html'));
    app.get('/queue', redirectToDatagonHtml('queue.html'));
    app.get('/results', redirectToDatagonHtml('results.html'));
    app.get('/projects', redirectToDatagonHtml('projects.html'));
    app.get('/processes', redirectToDatagonHtml('processes.html'));
    app.get('/settings', redirectToDatagonHtml('settings.html'));
    app.get('/login', (req, res, next) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') return next();
        const qs = qsFromReq(req);
        return res.redirect(302, '/login.html' + qs);
    });

    /** HTML-страницы Datagon (vanilla) без сессии не отдаём: редирект на /login.html?then=… */
    app.use(async (req, res, next) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') return next();
        const raw = String(req.path || '').split('?')[0];
        if (!raw.toLowerCase().endsWith('.html')) return next();
        if (raw.includes('..')) return res.status(400).end();
        if (raw.startsWith('/docs') || raw.startsWith('/architectui-react-pro')) return next();
        const leaf = raw.slice(raw.lastIndexOf('/') + 1).toLowerCase();
        if (leaf === 'login.html') return next();
        try {
            const actor = await authModule.getActor(req);
            if (actor) return next();
        } catch (e) {
            return next(e);
        }
        const then = encodeURIComponent(String(req.originalUrl || raw || '/dashboard.html').split('#')[0]);
        return res.redirect(302, `/login.html?then=${then}`);
    });

    // Полное React-демо ArchitectUI (CRA build → public/architectui-react-pro/). SPA fallback для client routes.
    const architectuiDemoDir = path.join(__dirname, 'public', 'architectui-react-pro');
    const architectuiDemoIndex = path.join(architectuiDemoDir, 'index.html');
    if (fsSync.existsSync(architectuiDemoIndex)) {
        // Ссылки из каталога показывают путь внутри SPA (/dashboards/...); редирект на реальный URL с basename CRA.
        const architectuiCraPathPrefixes = [
            '/dashboards',
            '/elements',
            '/components',
            '/forms',
            '/charts',
            '/tables',
            '/widgets',
            '/apps',
            '/pages',
        ];
        const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        for (const prefix of architectuiCraPathPrefixes) {
            app.get(new RegExp(`^${escapeRegex(prefix)}(/.*)?$`), (req, res, next) => {
                if (req.method !== 'GET' && req.method !== 'HEAD') return next();
                const qs = qsFromReq(req);
                return res.redirect(302, '/architectui-react-pro' + req.path + qs);
            });
        }
        // Router: сначала статика, затем index.html для любых оставшихся GET (надёжнее, чем отдельный app.get после static).
        const architectuiRouter = express.Router();
        architectuiRouter.use(express.static(architectuiDemoDir));
        architectuiRouter.get(/.*/, (req, res, next) => {
            if (req.method !== 'GET' && req.method !== 'HEAD') return next();
            return res.sendFile(path.resolve(architectuiDemoIndex));
        });
        app.use('/architectui-react-pro', architectuiRouter);
    } else {
        // Только корень префикса — на страницу с инструкциями. Вложенные пути не редиректить на неё же
        // (иначе со страницы каталога ссылки «в SPA» дают 302 на тот же URL и кажется, что клик мёртвый).
        app.get(/^\/architectui-react-pro\/?$/, (req, res, next) => {
            if (req.method !== 'GET' && req.method !== 'HEAD') return next();
            const qs = qsFromReq(req);
            return res.redirect(302, '/ref/react-demo-index.html' + qs);
        });
        app.get(/^\/architectui-react-pro\/(.+)/, (req, res, next) => {
            if (req.method !== 'GET' && req.method !== 'HEAD') return next();
            res.status(503);
            res.type('html');
            return res.send(
                '<!DOCTYPE html><html lang="ru"><head><meta charset="utf-8"><title>Демо не собрано</title></head><body style="font-family:system-ui,sans-serif;padding:24px;max-width:560px">' +
                    '<h1 style="font-size:1.25rem">React-демо ArchitectUI не установлено</h1>' +
                    '<p>В корне репозитория выполните:</p>' +
                    '<pre style="background:#f4f4f5;padding:12px;border-radius:8px;overflow:auto">npm run build:architectui-demo</pre>' +
                    '<p>Нужен каталог <code>vendor/architectui-react-pro</code> с исходниками шаблона.</p>' +
                    '<p><a href="/ref/react-demo-index.html">Страница каталога ссылок</a> · <a href="/dashboard.html">Дашборд</a></p>' +
                    '</body></html>',
            );
        });
    }

    // Старые закладки /vanilla/*.html
    app.get(/^\/vanilla\/([^/]+\.html)$/i, (req, res, next) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') return next();
        let name = String(req.path || '').replace(/^\/vanilla\//i, '');
        if (name.toLowerCase() === 'index.html') name = 'sections.html';
        const qs = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
        return res.redirect(301, '/' + name + qs);
    });

    app.get('/mysites.html', (req, res) => {
        const qs = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
        return res.redirect(301, '/my-sites.html' + qs);
    });

    app.get(/^\/my-product\/?$/, (req, res) => {
        const qs = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
        return res.redirect(301, '/my-products.html' + qs);
    });

    app.use(express.static(path.join(__dirname, 'public')));

    app.listen(PORT, () => {
        console.log(`[Server] Running on port ${PORT}`);
    });
    // Intentionally skip heavy post-init DDL tasks in runtime mode.

    // Автоочистка логов по настройке: раз в 12 часов.
    cleanupLogsByRetentionDays(appSettings.log_retention_days).catch(() => {});
    cleanupResultsByRetentionDays(appSettings.results_retention_days).catch(() => {});
    setInterval(() => {
        cleanupLogsByRetentionDays(appSettings.log_retention_days).catch(() => {});
        cleanupResultsByRetentionDays(appSettings.results_retention_days).catch(() => {});
    }, 12 * 60 * 60 * 1000);
    startAutoSyncScheduler();
    startUnifiedTaskWatchdog();
}).catch(err => {
    console.error('Failed to start server:', err);
    process.exit(1);
});
