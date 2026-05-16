const express = require('express');
const mysql = require('mysql2/promise');
const bodyParser = require('body-parser');
const path = require('path');
const fs = require('fs/promises');
const fsSync = require('fs');
const bcrypt = require('bcryptjs');
const os = require('os');
const config = require('./config');
const { parseAutoSyncWeekdaysMon17 } = require('./lib/datagonAutoSyncRegistry');

const app = express();
const PORT = config.port || 3000;
let db;
const postInitTasks = [];

/** Тяжёлые фоновые задачи после listen — не сразу, чтобы HTML/API успели ответить (пул MySQL 10 conn). */
const STARTUP_DEFER_MS = Math.max(0, Number(process.env.DATAGON_STARTUP_DEFER_MS || 60000));

function promiseWithTimeout(promise, ms, label) {
    const tag = label || 'timeout';
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(tag)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => {
        if (timer) clearTimeout(timer);
    });
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
    ms_dimensions_log_retention_days: 180,
    /** Срок хранения журнала изменений полей закупок (`dg_purchase_overrides_log`). */
    dg_purchase_overrides_log_retention_days: 180,
    /** Срок хранения строк в `auto_sync_runs` (журнал запусков автосинхронизации на /processes.html). */
    auto_sync_runs_retention_days: 180,
    /** Срок хранения дневных снимков `ms_export.stock` в `dg_product_stock_snapshot` (после синка МС). */
    product_stock_snapshot_retention_days: 365,
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
    auth_online_presence_minutes: 15,
    /** HTTP(S)-прокси для загрузки страниц конкурентов (очередь, автообход, worker). */
    fetch_proxy_enabled: 0,
    fetch_proxy_list: '',
    /** Ключи и дефолтные паузы интеграций маркетплейсов. */
    ozon_client_id: '',
    ozon_api_key: '',
    wb_api_key: '',
    wb_token_type: 'base',
    ym_api_key: '',
    ym_campaign_id: '',
    ym_business_id: '',
    mp_ozon_delay_ms: 400,
    mp_wb_delay_cards_ms: 600,
    mp_wb_delay_other_ms: 1600,
    mp_yandex_delay_ms: 280,
    huckster_email: '',
    huckster_password: '',
    huckster_delay_ms: 270,
    huckster_max_offset_per_shop: 0,
    huckster_shops_set_1: '',
    huckster_shops_set_2: '',
    huckster_ms_price_type_set_1: '',
    huckster_ms_price_type_set_2: '',
    /** Фильтр строк МС для моста Huckster: исключать архивные комплекты (всегда при включении). */
    huckster_ms_exclude_archived_bundles: 0,
    /** Исключать архивные товары только при нулевом/отрицательном остатке. */
    huckster_ms_exclude_archived_products_zero_stock: 0,
    /** Если есть коды вида N-..., скрывать базовый товар N в матрицах Huckster. */
    huckster_ms_exclude_products_with_bundles: 0,
    mp_ozon_include_archived: 0,
    auto_sync_marketplaces_enabled: 0,
    auto_sync_marketplaces_time: '05:00',
    auto_sync_huckster_enabled: 0,
    auto_sync_huckster_time: '06:00',
    auto_sync_db_size_enabled: 1,
    auto_sync_db_size_time: '02:00',
    /** Авто-выгрузка пользовательских override габаритов в МойСклад
     *  (страница /exports-dimensions.html → балк «↗ В МС: все правки»).
     *  По умолчанию отключено, время 21:00 МСК. См. routes/dimensions.js
     *  → runScheduledSyncMs (читает все ms_dimensions_measurements с
     *  override+uuid и шлёт PUT в /entity/{product|bundle}/{uuid}).
     */
    auto_sync_dimensions_enabled: 0,
    auto_sync_dimensions_time: '21:00',
    /** Авто-синхронизация продаж МС (entity/demand → ms_demand / ms_demand_position).
     *  По умолчанию выключена. `auto_sync_mssales_days` — окно периода в днях
     *  (от 1 до 5*365); 90 дней — баланс «3 квартала истории / приемлемая
     *  длительность». См. routes/msSales.js → runDemandSync. */
    auto_sync_mssales_enabled: 0,
    auto_sync_mssales_time: '07:30',
    auto_sync_mssales_days: 90,
    /** Пн=1…Вс=7, CSV; пусто — каждый день (как раньше без поля). */
    auto_sync_mssales_weekdays: '',
    /** Отдельное расписание: полный синк demand (`fresh: true`), своё окно и дни недели. */
    auto_sync_mssales_full_enabled: 0,
    auto_sync_mssales_full_time: '03:15',
    auto_sync_mssales_full_days: 730,
    /** По умолчанию только вс; при включении задайте удобные дни. */
    auto_sync_mssales_full_weekdays: '7',
    /** Batch: dg_formula_proposed_cache для дефолтной выборки закупок (`routes/purchase.js → runPurchaseFormulaCacheBatch`). */
    auto_sync_purchase_formula_cache_enabled: 0,
    auto_sync_purchase_formula_cache_time: '08:30',
    /** Формула продаж / предлагаемого неснижаемого, LagerPlus-parity (см. `lib/datagonSalesFormula.js`, карточка товара). */
    sales_formula_replenishment_coef: 1 / 3,
    sales_formula_sales_window_days: 90,
    sales_formula_absence_analysis_days: 210,
    sales_formula_base_qty: 2,
    sales_formula_rare_base_qty: 2,
    sales_formula_rare_avg_max: 1,
    sales_formula_expensive_rare_threshold_rub: 50000,
    sales_formula_expensive_rare_min_qty: 1,
    sales_formula_max_change_coef: 1.6,
    sales_formula_incomplete_pack_pct: 80,
    sales_formula_project_mode: 'all',
    sales_formula_project_uuids: ''
};
let syncState = { active: false, processed: 0, total: 0, message: '' };
const moyskladRouterFactory = require('./routes/moysklad');
const purchaseRouterFactory = require('./routes/purchase');
const productRouterFactory = require('./routes/product');
const pagesRouterFactory = require('./routes/pages');
const matchesRouterFactory = require('./routes/matches');
const exportsMarketplacesRouterFactory = require('./routes/exportsMarketplaces');
const exportsHucksterRouterFactory = require('./routes/exportsHuckster');
/** Прямой импорт модуля габаритов: нужен для processAutoSyncQueue (task='dimensions')
 *  ещё до того, как app.use('/api/exports/dimensions', ...) создаст router. См.
 *  module.exports.runScheduledSyncMs / getScheduledSyncState. */
const dimensionsRouterFactory = require('./routes/dimensions');
/** MS Sales: программный триггер автосинхронизации (entity/demand → ms_demand).
 *  Прямой импорт нужен здесь же, чтобы processAutoSyncQueue / scheduler могли
 *  стартовать синк без зависимости от Express-роутера. См. module.exports.triggerSync /
 *  getSyncState в routes/msSales.js. */
const msSalesModule = require('./routes/msSales');
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
// Держим кэш коротким, чтобы виджет "Размер БД" на дашборде обновлялся заметно чаще.
const DB_SIZE_CACHE_TTL_MS = 5 * 60 * 1000;
let dbSizeCache = null;
// Виджет "Дисковое пространство" на дашборде: рекурсивный обход дерева тяжёлый,
// держим отдельный TTL и одно общее ин-флайт обещание, чтобы параллельные клики
// "Обновить" не запускали несколько сканов сразу.
const DISK_USAGE_CACHE_TTL_MS = 5 * 60 * 1000;
let diskUsageCache = null;
let diskUsageInFlight = null;

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
            connectionLimit: Math.max(10, Number(process.env.DB_CONNECTION_LIMIT || 20)),
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
            ['sync_batch_size','500'],['sync_delay_ms','2000'],['sync_mode','always'],['log_retention_days','7'],['results_retention_days','120'],['ms_dimensions_log_retention_days','180'],['dg_purchase_overrides_log_retention_days','180'],['auto_sync_runs_retention_days','180'],['product_stock_snapshot_retention_days','365'],
            ['ms_sync_page_limit','1000'],['ms_sync_delay_ms','0'],
            ['auto_sync_myproducts_enabled','0'],['auto_sync_myproducts_time','03:00'],
            ['auto_sync_moysklad_enabled','0'],['auto_sync_moysklad_time','04:00'],
            ['discover_max_sitemaps','200'],['discover_max_urls','50000'],
            ['discover_crawl_max_pages','500'],['discover_request_delay_ms','100'],
            ['auth_session_ttl_days','14'],['auth_session_user_limit','1'],
            ['auth_online_presence_minutes','15'],
            ['fetch_proxy_enabled','0'],
            ['fetch_proxy_list',''],
            ['ozon_client_id',''],
            ['ozon_api_key',''],
            ['wb_api_key',''],
            ['wb_token_type','base'],
            ['ym_api_key',''],
            ['ym_campaign_id',''],
            ['ym_business_id',''],
            ['mp_ozon_delay_ms','400'],
            ['mp_wb_delay_cards_ms','600'],
            ['mp_wb_delay_other_ms','1600'],
            ['mp_yandex_delay_ms','280'],
            ['huckster_email',''],
            ['huckster_password',''],
            ['huckster_delay_ms','270'],
            ['huckster_max_offset_per_shop','0'],
            ['huckster_shops_set_1',''],
            ['huckster_shops_set_2',''],
            ['huckster_ms_price_type_set_1',''],
            ['huckster_ms_price_type_set_2',''],
            ['huckster_ms_exclude_archived_bundles','0'],
            ['huckster_ms_exclude_archived_products_zero_stock','0'],
            ['huckster_ms_exclude_products_with_bundles','0'],
            ['mp_ozon_include_archived','0'],
            ['auto_sync_marketplaces_enabled','0'],
            ['auto_sync_marketplaces_time','05:00'],
            ['auto_sync_huckster_enabled','0'],
            ['auto_sync_huckster_time','06:00'],
            ['auto_sync_db_size_enabled','1'],
            ['auto_sync_db_size_time','02:00'],
            ['auto_sync_dimensions_enabled','0'],
            ['auto_sync_dimensions_time','21:00'],
            ['auto_sync_mssales_enabled','0'],
            ['auto_sync_mssales_time','07:30'],
            ['auto_sync_mssales_days','90'],
            ['auto_sync_mssales_weekdays',''],
            ['auto_sync_mssales_full_enabled','0'],
            ['auto_sync_mssales_full_time','03:15'],
            ['auto_sync_mssales_full_days','730'],
            ['auto_sync_mssales_full_weekdays','7'],
            ['auto_sync_purchase_formula_cache_enabled','0'],
            ['auto_sync_purchase_formula_cache_time','08:30'],
            ['sales_formula_replenishment_coef','0.3333333333333333'],
            ['sales_formula_sales_window_days','90'],
            ['sales_formula_absence_analysis_days','210'],
            ['sales_formula_base_qty','2'],
            ['sales_formula_rare_base_qty','2'],
            ['sales_formula_rare_avg_max','1'],
            ['sales_formula_expensive_rare_threshold_rub','50000'],
            ['sales_formula_expensive_rare_min_qty','1'],
            ['sales_formula_max_change_coef','1.6'],
            ['sales_formula_incomplete_pack_pct','80'],
            ['sales_formula_project_mode','all'],
            ['sales_formula_project_uuids','']
        ];
        for (const [k, v] of defaults) await db.query('INSERT IGNORE INTO app_settings (setting_key, setting_value) VALUES (?, ?)', [k, v]);

        const [rows] = await db.query('SELECT * FROM app_settings');
        rows.forEach(r => {
            if (appSettings.hasOwnProperty(r.setting_key)) {
                const asInt =
                    !r.setting_key.endsWith('_time') &&
                    !r.setting_key.endsWith('_weekdays') &&
                    (
                        r.setting_key.includes('limit') ||
                        r.setting_key.includes('size') ||
                        r.setting_key.includes('delay') ||
                        r.setting_key.includes('days') ||
                        r.setting_key.includes('minutes') ||
                        r.setting_key === 'fetch_proxy_enabled'
                    );
                appSettings[r.setting_key] = asInt ? parseInt(r.setting_value, 10) : r.setting_value;
            }
        });
        console.log('[Settings] Loaded', appSettings);
        // Не блокировать app.listen: на большой `pages` UPDATE может ждать metadata lock минутами.
        postInitTasks.push(async () => {
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
            try {
                await require('./lib/datagonSpecialties').ensureSchemaAndSeed(db);
            } catch (eSp) {
                console.warn('[DB] specialties:', eSp && eSp.message ? eSp.message : eSp);
            }
        });
        // Fast-start mode: avoid blocking startup on heavy schema checks/migrations.
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

app.use(bodyParser.json({ limit: '32mb' }));

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

/**
 * Автоочистка таблицы `ms_dimensions_log` (журнал изменений габаритов) по retention в днях
 * (`app_settings.ms_dimensions_log_retention_days`, по умолчанию 180).
 * Удаляются ВСЕ типы записей (`set`, `delete`, `sync_ms`) старше N дней.
 * Возвращает число удалённых строк (для UI-кнопки «Очистить сейчас»).
 */
async function cleanupDimensionsLogByRetentionDays(days) {
    const retentionDays = Number(days) || 180;
    if (retentionDays <= 0) return 0;
    try {
        /** Таблица создаётся в routes/dimensions.js ensureSchema() при первом обращении.
         *  Если её ещё нет — DELETE упадёт с ER_NO_SUCH_TABLE; ловим тихо. */
        const [r] = await db.query(
            `DELETE FROM ms_dimensions_log
             WHERE changed_at < (NOW() - INTERVAL ? DAY)`,
            [retentionDays]
        );
        const deleted = Number(r?.affectedRows || 0);
        if (deleted > 0) {
            console.log(`[DIM-LOG CLEANUP] Deleted ${deleted} rows older than ${retentionDays} days`);
        }
        return deleted;
    } catch (e) {
        if (e && e.code === 'ER_NO_SUCH_TABLE') return 0;
        console.warn('[DIM-LOG CLEANUP] failed:', e?.message || e);
        throw e;
    }
}

/**
 * Автоочистка `dg_purchase_overrides_log` (журнал полей «Нес.остаток Датагон», «Кратность»)
 * по `app_settings.dg_purchase_overrides_log_retention_days` (по умолчанию 180).
 */
async function cleanupPurchaseOverridesLogByRetentionDays(days) {
    const retentionDays = Number(days) || 180;
    if (retentionDays <= 0) return 0;
    try {
        const [r] = await db.query(
            `DELETE FROM dg_purchase_overrides_log
             WHERE changed_at < (NOW() - INTERVAL ? DAY)`,
            [retentionDays]
        );
        const deleted = Number(r?.affectedRows || 0);
        if (deleted > 0) {
            console.log(`[PURCHASE-OV-LOG CLEANUP] Deleted ${deleted} rows older than ${retentionDays} days`);
        }
        return deleted;
    } catch (e) {
        if (e && e.code === 'ER_NO_SUCH_TABLE') return 0;
        console.warn('[PURCHASE-OV-LOG CLEANUP] failed:', e?.message || e);
        throw e;
    }
}

/**
 * Автоочистка таблицы `auto_sync_runs` (журнал запусков автосинхронизации: /processes.html, кнопка «Лог»)
 * по `app_settings.auto_sync_runs_retention_days` (по умолчанию 180). Удаляются только строки с
 * непустым `finished_at` старше N дней (активные `running` без финиша не трогаем).
 */
async function cleanupAutoSyncRunsByRetentionDays(days) {
    const retentionDays = Number(days) || 180;
    if (retentionDays <= 0) return 0;
    try {
        await ensureAutoSyncRunsTable();
        const [r] = await db.query(
            `DELETE FROM auto_sync_runs
             WHERE finished_at IS NOT NULL
               AND finished_at < (NOW() - INTERVAL ? DAY)`,
            [retentionDays]
        );
        const deleted = Number(r?.affectedRows || 0);
        if (deleted > 0) {
            console.log(`[AUTO-SYNC-RUNS CLEANUP] Deleted ${deleted} rows older than ${retentionDays} days`);
        }
        return deleted;
    } catch (e) {
        if (e && e.code === 'ER_NO_SUCH_TABLE') return 0;
        console.warn('[AUTO-SYNC-RUNS CLEANUP] failed:', e?.message || e);
        throw e;
    }
}

function getMoscowWeekdayMon1Sun7() {
    const wk = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Moscow', weekday: 'long' }).format(new Date());
    const map = { Monday: 1, Tuesday: 2, Wednesday: 3, Thursday: 4, Friday: 5, Saturday: 6, Sunday: 7 };
    return map[wk] || 1;
}

function getMoscowNowParts() {
    const fmtDate = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    const fmtTime = new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());
    return { date: fmtDate, time: fmtTime, weekdayMon1Sun7: getMoscowWeekdayMon1Sun7() };
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

async function getDatabaseSizeMetrics(forceRefresh = false) {
    const now = Date.now();
    if (!forceRefresh && dbSizeCache && now - Number(dbSizeCache.cachedAtMs || 0) < DB_SIZE_CACHE_TTL_MS) {
        return { ...dbSizeCache.data, cached: true };
    }
    const [rows] = await db.query(
        `
            SELECT
                COALESCE(SUM(data_length + index_length), 0) AS size_bytes,
                COALESCE(SUM(data_length), 0) AS data_bytes,
                COALESCE(SUM(index_length), 0) AS index_bytes,
                COUNT(*) AS table_count
            FROM information_schema.TABLES
            WHERE table_schema = ?
        `,
        [config.db.database]
    );
    const row = rows && rows[0] ? rows[0] : {};
    const data = {
        database: config.db.database,
        sizeBytes: Number(row.size_bytes || 0),
        dataBytes: Number(row.data_bytes || 0),
        indexBytes: Number(row.index_bytes || 0),
        tableCount: Number(row.table_count || 0),
        cachedAt: new Date(now).toISOString(),
        ttlSec: Math.floor(DB_SIZE_CACHE_TTL_MS / 1000)
    };
    dbSizeCache = { cachedAtMs: now, data };
    return { ...data, cached: false };
}

/**
 * Рекурсивный подсчёт размера каталога без shell-зависимостей (du недоступен в
 * контейнерах / на ограниченных стендах). Возвращает { sizeBytes, fileCount,
 * dirCount, errorCount }. Защищён от:
 *  - циклов через симлинки (используем lstat и не идём в symlinks);
 *  - permission denied (увеличиваем errorCount, не падаем);
 *  - параллельной нагрузки (батч по 16 элементов через Promise.all).
 */
async function measureDirectorySizeRecursive(dirPath) {
    let sizeBytes = 0;
    let fileCount = 0;
    let dirCount = 0;
    let errorCount = 0;
    const stack = [dirPath];
    while (stack.length) {
        const current = stack.pop();
        let entries;
        try {
            entries = await fs.readdir(current, { withFileTypes: true });
        } catch (_) {
            errorCount += 1;
            continue;
        }
        const BATCH = 16;
        for (let i = 0; i < entries.length; i += BATCH) {
            const slice = entries.slice(i, i + BATCH);
            await Promise.all(slice.map(async (entry) => {
                const full = path.join(current, entry.name);
                try {
                    const st = await fs.lstat(full);
                    if (st.isSymbolicLink()) return;
                    if (st.isDirectory()) {
                        dirCount += 1;
                        stack.push(full);
                        return;
                    }
                    if (st.isFile()) {
                        fileCount += 1;
                        sizeBytes += Number(st.size || 0);
                    }
                } catch (_) {
                    errorCount += 1;
                }
            }));
        }
    }
    return { sizeBytes, fileCount, dirCount, errorCount };
}

/**
 * Информация о файловой системе для каталога: общий/использованный/свободный
 * объём. Использует fs.statfs (Node ≥ 18.15). Если функция недоступна или
 * вернула ошибку — возвращает { error }.
 */
async function getFileSystemUsageForPath(targetPath) {
    try {
        if (typeof fs.statfs !== 'function') {
            return { error: 'fs.statfs не поддерживается этой версией Node' };
        }
        const st = await fs.statfs(targetPath);
        const blockSize = Number(st.bsize || 0);
        const total = Number(st.blocks || 0) * blockSize;
        const free = Number(st.bavail || 0) * blockSize;
        const reserved = Number(st.bfree || 0) * blockSize - free;
        const used = total - free - Math.max(0, reserved);
        return {
            sizeBytes: total,
            freeBytes: free,
            usedBytes: Math.max(0, used),
            usedPercent: total > 0 ? Number(((Math.max(0, used) / total) * 100).toFixed(1)) : 0
        };
    } catch (e) {
        return { error: e.message || 'Не удалось получить размер диска' };
    }
}

async function computeDiskUsageMetrics() {
    const projectRoot = path.resolve(__dirname);
    const startedAt = Date.now();
    let entries = [];
    try {
        entries = await fs.readdir(projectRoot, { withFileTypes: true });
    } catch (e) {
        return {
            projectPath: projectRoot,
            error: e.message || 'Не удалось прочитать корень проекта'
        };
    }

    const folderEntries = [];
    let rootFilesBytes = 0;
    let rootFilesCount = 0;
    for (const entry of entries) {
        if (entry.isSymbolicLink()) continue;
        const full = path.join(projectRoot, entry.name);
        if (entry.isDirectory()) {
            folderEntries.push({ name: entry.name, full, isHidden: entry.name.startsWith('.') });
        } else if (entry.isFile()) {
            try {
                const st = await fs.lstat(full);
                rootFilesBytes += Number(st.size || 0);
                rootFilesCount += 1;
            } catch (_) {}
        }
    }

    // Параллельный обход верхнеуровневых каталогов с ограничением concurrency,
    // чтобы не задушить FS на стенде. CONC=4 — компромисс между скоростью и нагрузкой.
    const CONC = 4;
    const folderResults = new Array(folderEntries.length);
    let cursor = 0;
    async function worker() {
        while (true) {
            const idx = cursor;
            cursor += 1;
            if (idx >= folderEntries.length) return;
            const f = folderEntries[idx];
            const measured = await measureDirectorySizeRecursive(f.full);
            folderResults[idx] = {
                name: f.name,
                isHidden: f.isHidden,
                sizeBytes: measured.sizeBytes,
                fileCount: measured.fileCount,
                dirCount: measured.dirCount,
                errorCount: measured.errorCount
            };
        }
    }
    await Promise.all(Array.from({ length: Math.min(CONC, folderEntries.length || 1) }, worker));

    const folders = folderResults.filter(Boolean);
    folders.sort((a, b) => Number(b.sizeBytes || 0) - Number(a.sizeBytes || 0));

    let totalBytes = rootFilesBytes;
    let totalFiles = rootFilesCount;
    for (const f of folders) {
        totalBytes += Number(f.sizeBytes || 0);
        totalFiles += Number(f.fileCount || 0);
    }

    const fileSystem = await getFileSystemUsageForPath(projectRoot);
    const finishedAt = Date.now();

    return {
        projectPath: projectRoot,
        projectSizeBytes: totalBytes,
        projectFileCount: totalFiles,
        rootFilesBytes,
        rootFilesCount,
        folders,
        fileSystem,
        scanDurationMs: finishedAt - startedAt,
        scannedAt: new Date(finishedAt).toISOString(),
        ttlSec: Math.floor(DISK_USAGE_CACHE_TTL_MS / 1000)
    };
}

async function getDiskUsageMetrics(forceRefresh = false) {
    const now = Date.now();
    if (!forceRefresh && diskUsageCache && now - Number(diskUsageCache.cachedAtMs || 0) < DISK_USAGE_CACHE_TTL_MS) {
        return { ...diskUsageCache.data, cached: true };
    }
    if (diskUsageInFlight) return diskUsageInFlight;
    diskUsageInFlight = (async () => {
        try {
            const data = await computeDiskUsageMetrics();
            diskUsageCache = { cachedAtMs: Date.now(), data };
            return { ...data, cached: false };
        } finally {
            diskUsageInFlight = null;
        }
    })();
    return diskUsageInFlight;
}

/**
 * @returns {{ ok: boolean, reason?: string }}
 * `already_running` — для этого task_type уже идёт запись в `auto_sync_runs` (runner внутри шага).
 * `already_queued` — такой тип уже в `autoSyncQueue` (дождитесь старта).
 */
function enqueueAutoSyncTask(taskType, triggerType = 'schedule') {
    if (!taskType) return { ok: false, reason: 'invalid_task' };
    const type = String(taskType || '').trim();
    if (!type) return { ok: false, reason: 'invalid_task' };
    if (autoSyncRunIds.has(type)) return { ok: false, reason: 'already_running' };
    if (autoSyncQueue.some((item) => (typeof item === 'string' ? item : item?.type) === type)) {
        return { ok: false, reason: 'already_queued' };
    }
    autoSyncQueue.push({ type, triggerType: String(triggerType || 'schedule').trim() || 'schedule' });
    return { ok: true };
}

/**
 * Живые снимки автосинка для `/api/processes/overview` (карточки «Автосинхронизация»).
 * Включаем только типы, у которых сейчас есть незавершённая строка `auto_sync_runs`
 * (`autoSyncRunIds`), чтобы не путать с ручными синками с тех же модулей.
 */
function buildAutoSyncTasksLiveForOverview() {
    const out = {};
    const hasRun = (t) => autoSyncRunIds.has(t);

    if (hasRun('myproducts')) {
        if (syncState.active) {
            out.myproducts = {
                active: true,
                processed: Number(syncState.processed || 0),
                total: Number(syncState.total || 0),
                message: String(syncState.message || ''),
            };
        } else {
            out.myproducts = { active: true, pending: true, message: 'Ожидание старта импорта «Мои товары»…' };
        }
    }

    if (hasRun('moysklad')) {
        const st = typeof moyskladRouterFactory.getJobState === 'function' ? moyskladRouterFactory.getJobState() : null;
        if (st && st.active) {
            out.moysklad = {
                active: true,
                processed: Number(st.processed || 0),
                total: Number(st.total || 0),
                message: String(st.message || ''),
            };
        } else {
            out.moysklad = { active: true, pending: true, message: 'Ожидание старта выгрузки МС…' };
        }
    }

    if (hasRun('marketplaces')) {
        const st =
            typeof exportsMarketplacesRouterFactory.getSyncState === 'function'
                ? exportsMarketplacesRouterFactory.getSyncState()
                : null;
        if (st && st.active) {
            const pm = st.perMarket || {};
            const per_market_summary = ['ozon', 'wb', 'ym']
                .map((k) => {
                    const x = pm[k] || {};
                    const label = k === 'wb' ? 'WB' : k === 'ym' ? 'Я.Маркет' : 'Ozon';
                    let s = `${label}: ${x.status || '—'}`;
                    if (Number(x.count) > 0) s += ` ${Number(x.count)}`;
                    if (x.error) s += ' (!)';
                    return s;
                })
                .join(' · ');
            out.marketplaces = {
                active: true,
                message: String(st.message || ''),
                per_market_summary,
            };
        } else {
            out.marketplaces = { active: true, pending: true, message: 'Ожидание обновления маркетплейсов…' };
        }
    }

    if (hasRun('huckster')) {
        const st =
            typeof exportsHucksterRouterFactory.getSyncState === 'function'
                ? exportsHucksterRouterFactory.getSyncState()
                : null;
        if (st && st.active) {
            out.huckster = {
                active: true,
                message: String(st.status_text || ''),
                stop_requested: !!st.stop_requested,
                progress: st.progress && typeof st.progress === 'object' ? st.progress : null,
            };
        } else {
            out.huckster = { active: true, pending: true, message: 'Ожидание расчёта Huckster…' };
        }
    }

    if (hasRun('db_size')) {
        out.db_size = { active: true, pending: true, message: 'Пересчёт размера БД и дерева диска…' };
    }

    if (hasRun('dimensions') && typeof dimensionsRouterFactory.getScheduledSyncState === 'function') {
        out.dimensions = dimensionsRouterFactory.getScheduledSyncState();
    }

    function msSalesLiveOrPending() {
        const st = typeof msSalesModule.getSyncState === 'function' ? msSalesModule.getSyncState() : null;
        if (st && st.active) {
            return {
                active: true,
                fetched_demands: Number(st.fetched_demands || 0),
                total_demands: Number(st.total_demands || 0),
                saved_positions: Number(st.saved_positions || 0),
                resolved_positions: Number(st.resolved_positions || 0),
                unresolved_positions: Number(st.unresolved_positions || 0),
                deleted_demands: Number(st.deleted_demands || 0),
                restored_demands: Number(st.restored_demands || 0),
                message: String(st.message || ''),
                days: Number(st.days || 0),
                resume_mode: !!st.resume_mode,
            };
        }
        return { active: true, pending: true, message: 'Ожидание старта импорта продаж МС…' };
    }

    if (hasRun('mssales')) {
        out.mssales = msSalesLiveOrPending();
    }
    if (hasRun('mssales_full')) {
        out.mssales_full = msSalesLiveOrPending();
    }

    return out;
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

/**
 * После рестарта Node в памяти нет autoSyncRunIds и waitUntil не «дожимает» старую задачу,
 * а строки в БД остаются status=running без finished_at — закрываем их при холодном старте.
 */
async function closeStaleAutoSyncRunsOnStartup() {
    try {
        await ensureAutoSyncRunsTable();
        const [r] = await db.query(
            `UPDATE auto_sync_runs
             SET status = 'interrupted',
                 message = CONCAT(
                     TRIM(COALESCE(message, '')),
                     CASE WHEN TRIM(COALESCE(message, '')) = '' THEN '' ELSE ' ' END,
                     '(запись закрыта при старте сервера: предыдущий процесс не вызвал финиш; если синк шёл — проверьте МойСклад и логи)'
                 ),
                 finished_at = NOW()
             WHERE status = 'running' AND finished_at IS NULL`
        );
        const n = Number(r?.affectedRows || 0);
        if (n > 0) {
            console.log(`[AUTO SYNC] Закрыто незавершённых записей auto_sync_runs при старте: ${n}`);
        }
    } catch (e) {
        console.warn('[AUTO SYNC] closeStaleAutoSyncRunsOnStartup:', e.message || e);
    }
}

/** Если запись осталась running дольше суток — вероятно сбой без рестарта; закрываем. */
async function closeAncientRunningAutoSyncRuns() {
    try {
        await ensureAutoSyncRunsTable();
        const [r] = await db.query(
            `UPDATE auto_sync_runs
             SET status = 'failed',
                 message = CONCAT(
                     TRIM(COALESCE(message, '')),
                     CASE WHEN TRIM(COALESCE(message, '')) = '' THEN '' ELSE ' ' END,
                     '(авто: running дольше 24 ч — см. логи Node и экран МойСклад)'
                 ),
                 finished_at = NOW()
             WHERE status = 'running'
               AND finished_at IS NULL
               AND started_at < DATE_SUB(NOW(), INTERVAL 24 HOUR)`
        );
        const n = Number(r?.affectedRows || 0);
        if (n > 0) {
            console.warn(`[AUTO SYNC] Принудительно закрыто «вечных» running-записей (>24ч): ${n}`);
        }
    } catch (e) {
        console.warn('[AUTO SYNC] closeAncientRunningAutoSyncRuns:', e.message || e);
    }
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
            const item = autoSyncQueue.shift();
            const task = typeof item === 'string' ? item : item?.type;
            const triggerType = typeof item === 'string' ? 'schedule' : (item?.triggerType || 'schedule');
            if (task === 'db_size') {
                console.log('[AUTO SYNC] Queue start: db_size');
                await startAutoSyncRun('db_size', triggerType);
                await getDatabaseSizeMetrics(true);
                let diskSummary = '';
                try {
                    const disk = await getDiskUsageMetrics(true);
                    if (disk && !disk.error) {
                        diskSummary = `, диск проекта: ${(Number(disk.projectSizeBytes || 0) / (1024 * 1024)).toFixed(1)} МБ (${Array.isArray(disk.folders) ? disk.folders.length : 0} папок)`;
                    } else if (disk && disk.error) {
                        diskSummary = `, диск: ошибка (${disk.error})`;
                    }
                } catch (e) {
                    diskSummary = `, диск: ошибка (${e && e.message ? e.message : e})`;
                }
                await finishAutoSyncRun('db_size', 'completed', `Размер БД пересчитан${diskSummary}`);
                console.log('[AUTO SYNC] Queue done: db_size');
            } else if (task === 'myproducts') {
                console.log('[AUTO SYNC] Queue start: myproducts');
                await startAutoSyncRun('myproducts', triggerType);
                if (!syncState.active) startGlobalSyncBackground();
                const done = await waitUntil(() => !syncState.active, 12 * 60 * 60 * 1000, 1000);
                await finishAutoSyncRun('myproducts', done ? 'completed' : 'failed', done ? 'Завершено' : 'Таймаут ожидания');
                console.log('[AUTO SYNC] Queue done: myproducts');
            } else if (task === 'moysklad') {
                console.log('[AUTO SYNC] Queue start: moysklad');
                await startAutoSyncRun('moysklad', triggerType);
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
            } else if (task === 'marketplaces') {
                console.log('[AUTO SYNC] Queue start: marketplaces');
                await startAutoSyncRun('marketplaces', triggerType);
                if (typeof exportsMarketplacesRouterFactory.triggerSync === 'function') {
                    const slot =
                        triggerType === 'schedule'
                            ? String(appSettings.auto_sync_marketplaces_time || '05:00').slice(0, 5)
                            : '';
                    const startRes = await exportsMarketplacesRouterFactory.triggerSync('all', {
                        triggerType,
                        scheduleSlotTime: slot,
                    });
                    if (startRes && startRes.started === false && startRes.reason !== 'already_running') {
                        throw new Error(startRes.error || startRes.reason || 'Не удалось запустить обновление маркетплейсов');
                    }
                }
                const done = await waitUntil(() => {
                    const s = typeof exportsMarketplacesRouterFactory.getSyncState === 'function'
                        ? exportsMarketplacesRouterFactory.getSyncState()
                        : { active: false };
                    return !s.active;
                }, 12 * 60 * 60 * 1000, 1000);
                await finishAutoSyncRun('marketplaces', done ? 'completed' : 'failed', done ? 'Завершено' : 'Таймаут ожидания');
                console.log('[AUTO SYNC] Queue done: marketplaces');
            } else if (task === 'huckster') {
                console.log('[AUTO SYNC] Queue start: huckster');
                await startAutoSyncRun('huckster', triggerType);
                if (typeof exportsHucksterRouterFactory.triggerSync === 'function') {
                    const startRes = await exportsHucksterRouterFactory.triggerSync();
                    if (startRes && startRes.started === false && startRes.reason !== 'already_running') {
                        throw new Error(
                            startRes.reason === 'missing_creds'
                                ? 'Huckster: задайте email и password в настройках или HUCKSTER_* в окружении'
                                : startRes.reason || 'Не удалось запустить обновление Huckster'
                        );
                    }
                }
                const done = await waitUntil(() => {
                    const s = typeof exportsHucksterRouterFactory.getSyncState === 'function'
                        ? exportsHucksterRouterFactory.getSyncState()
                        : { active: false };
                    return !s.active;
                }, 12 * 60 * 60 * 1000, 1000);
                // Honest-статус: completed только если result.success И снапшот реально сохранён.
                // Раньше тут безусловно ставился completed по факту "syncState.active вернулся в false",
                // из-за чего processes показывал completed даже когда снапшот не записался
                // (см. диагностику 09.05.2026 — saveHucksterSnapshot тихо падал, лог huckster-sync.log
                // не пополнялся, а auto_sync_runs всё равно говорил «Завершено»).
                const finalState = typeof exportsHucksterRouterFactory.getSyncState === 'function'
                    ? exportsHucksterRouterFactory.getSyncState()
                    : { active: false, result_success: false, snapshot_saved_at: null, error: null };
                let status = 'failed';
                let message;
                if (!done) {
                    message = 'Таймаут ожидания (12 ч)';
                } else if (finalState.error) {
                    const ph = finalState.error.phase ? ` [${finalState.error.phase}]` : '';
                    const code = finalState.error.code ? ` ${finalState.error.code}` : '';
                    const text = finalState.error.error || 'неизвестная ошибка';
                    message = `Ошибка${ph}${code}: ${text}`.slice(0, 480);
                } else if (finalState.result_success && finalState.snapshot_saved_at) {
                    status = 'completed';
                    message = `Снапшот сохранён ${finalState.snapshot_saved_at}`;
                } else if (finalState.result_success) {
                    message = 'Матрицы собраны, но снапшот не сохранён в БД (см. logs/huckster-sync.log)';
                } else {
                    message = 'Завершено без успешного результата (см. logs/huckster-sync.log)';
                }
                await finishAutoSyncRun('huckster', status, message);
                console.log(`[AUTO SYNC] Queue done: huckster — ${status} (${message})`);
            } else if (task === 'dimensions') {
                console.log('[AUTO SYNC] Queue start: dimensions');
                await startAutoSyncRun('dimensions', triggerType);
                if (typeof dimensionsRouterFactory.runScheduledSyncMs === 'function') {
                    /**
                     * runScheduledSyncMs() — в-process балк-«↗ В МС: все правки»:
                     * читает все ms_dimensions_measurements с override+uuid и
                     * шлёт PUT в /entity/{product|bundle}/{uuid}. Прогресс
                     * виден в getScheduledSyncState() — UI processes.html
                     * подхватывает его как обычный auto_sync раздел.
                     */
                    const dimsRunId = autoSyncRunIds.get('dimensions');
                    const dimHooks =
                        dimsRunId > 0
                            ? {
                                  onRunMessage: async (msg) => {
                                      try {
                                          await db.query('UPDATE auto_sync_runs SET message = ? WHERE id = ?', [
                                              String(msg || '').slice(0, 2000),
                                              dimsRunId,
                                          ]);
                                      } catch (_) {}
                                  },
                              }
                            : undefined;
                    let runResult;
                    try {
                        runResult = await dimensionsRouterFactory.runScheduledSyncMs(db, triggerType, dimHooks);
                    } catch (e) {
                        runResult = { started: true, error: e && e.message ? e.message : String(e) };
                    }
                    const finalState =
                        typeof dimensionsRouterFactory.getScheduledSyncState === 'function'
                            ? dimensionsRouterFactory.getScheduledSyncState()
                            : { ok: 0, err: 0, total: 0, summary: '', error: null };
                    let status = 'failed';
                    let message;
                    if (runResult && runResult.started === false && runResult.reason === 'already_running') {
                        status = 'skipped';
                        message = 'Авто-выгрузка габаритов уже выполняется (пропуск)';
                    } else if (finalState.error) {
                        message = (finalState.summary || ('Ошибка: ' + finalState.error)).slice(0, 480);
                    } else if (Number(finalState.total || 0) === 0) {
                        status = 'completed';
                        message = 'Нет позиций с правками — выгружать нечего';
                    } else if (Number(finalState.err || 0) === 0) {
                        status = 'completed';
                        message = (finalState.summary || '').slice(0, 480);
                    } else {
                        /** Часть позиций отвалилась — фиксируем как failed, чтобы
                         *  было видно красным в /processes.html. Детали — в
                         *  ms_dimensions_log (action='sync_ms') и last_message. */
                        message = (finalState.summary || '').slice(0, 480);
                    }
                    await finishAutoSyncRun('dimensions', status, message);
                    console.log(`[AUTO SYNC] Queue done: dimensions — ${status} (${message})`);
                } else {
                    await finishAutoSyncRun(
                        'dimensions',
                        'failed',
                        'routes/dimensions.js не экспортирует runScheduledSyncMs (обновите код)'
                    );
                }
            } else if (task === 'mssales_full') {
                console.log('[AUTO SYNC] Queue start: mssales_full');
                await startAutoSyncRun('mssales_full', triggerType);
                const daysFull = Math.max(1, Math.min(365 * 5, Number(appSettings.auto_sync_mssales_full_days || 730)));
                let startResFull = { started: false };
                if (typeof msSalesModule.triggerSync === 'function') {
                    try {
                        startResFull = await msSalesModule.triggerSync(db, {
                            days: daysFull,
                            fresh: true,
                            awaitCompletion: true,
                        });
                    } catch (e) {
                        startResFull = { started: false, error: e && e.message ? e.message : String(e) };
                    }
                }
                if (startResFull && startResFull.started === false && startResFull.reason !== 'already_running') {
                    await finishAutoSyncRun('mssales_full', 'failed',
                        startResFull.error || startResFull.reason || 'Не удалось запустить полный синк продаж МС');
                    console.log('[AUTO SYNC] Queue done: mssales_full — failed (start)');
                } else {
                    let timedOutFull = false;
                    let finalStateFull;
                    if (startResFull && startResFull.started === false && startResFull.reason === 'already_running') {
                        timedOutFull = !(await waitUntil(() => {
                            const s = typeof msSalesModule.getSyncState === 'function'
                                ? msSalesModule.getSyncState()
                                : { active: false };
                            return !s.active;
                        }, 12 * 60 * 60 * 1000, 1000));
                        finalStateFull = typeof msSalesModule.getSyncState === 'function'
                            ? msSalesModule.getSyncState()
                            : { active: false };
                    } else {
                        finalStateFull = (startResFull && startResFull.status) || (typeof msSalesModule.getSyncState === 'function'
                            ? msSalesModule.getSyncState()
                            : { active: false });
                    }
                    let statusFull = 'failed';
                    let messageFull;
                    if (timedOutFull) {
                        messageFull = 'Таймаут ожидания (12 ч)';
                    } else if (finalStateFull.last_error) {
                        messageFull = ('Ошибка: ' + finalStateFull.last_error).slice(0, 480);
                    } else {
                        statusFull = 'completed';
                        messageFull = (
                            'Полный (fresh), окно ' + daysFull + ' дн.: отгрузок ' + (finalStateFull.fetched_demands || 0) +
                            '/' + (finalStateFull.total_demands || 0) +
                            ', позиций ' + (finalStateFull.saved_positions || 0) +
                            ' (резолв ' + (finalStateFull.resolved_positions || 0) +
                            ', не привязано ' + (finalStateFull.unresolved_positions || 0) +
                            ', помечено удалёнными ' + (finalStateFull.deleted_demands || 0) +
                            ', воскрешено ' + (finalStateFull.restored_demands || 0) + ')'
                        ).slice(0, 480);
                    }
                    await finishAutoSyncRun('mssales_full', statusFull, messageFull);
                    console.log('[AUTO SYNC] Queue done: mssales_full — ' + statusFull + ' (' + messageFull + ')');
                }
            } else if (task === 'purchase_formula_cache') {
                console.log('[AUTO SYNC] Queue start: purchase_formula_cache');
                await startAutoSyncRun('purchase_formula_cache', triggerType);
                let statusPfc = 'completed';
                let messagePfc = '';
                try {
                    const purchaseMod = require('./routes/purchase');
                    if (typeof purchaseMod.runPurchaseFormulaCacheBatch !== 'function') {
                        throw new Error('runPurchaseFormulaCacheBatch недоступен');
                    }
                    const batchRes = await purchaseMod.runPurchaseFormulaCacheBatch(db, appSettings, {});
                    messagePfc = (
                        'Кэш формулы закупок: обработано ' +
                        (batchRes.processed || 0) +
                        ', записано ' +
                        (batchRes.upserted || 0) +
                        ', data_rev=' +
                        String(batchRes.data_rev || '').slice(0, 120) +
                        (batchRes.errors ? ', ошибок чанков ' + batchRes.errors : '')
                    ).slice(0, 480);
                } catch (e) {
                    statusPfc = 'failed';
                    messagePfc = ('Ошибка кэша формулы закупок: ' + (e && e.message ? e.message : e)).slice(0, 480);
                }
                await finishAutoSyncRun('purchase_formula_cache', statusPfc, messagePfc);
                console.log('[AUTO SYNC] Queue done: purchase_formula_cache — ' + statusPfc);
            } else if (task === 'mssales') {
                console.log('[AUTO SYNC] Queue start: mssales');
                await startAutoSyncRun('mssales', triggerType);
                /** Окно периода берём из настроек; defaults — 90 дней.
                 *  triggerSync проверит уже идущий синк (already_running) и наличие MS_TOKEN. */
                const days = Math.max(1, Math.min(365 * 5, Number(appSettings.auto_sync_mssales_days || 90)));
                let startRes = { started: false };
                if (typeof msSalesModule.triggerSync === 'function') {
                    try {
                        startRes = await msSalesModule.triggerSync(db, {
                            days,
                            incremental: true,
                            awaitCompletion: true,
                        });
                    } catch (e) {
                        startRes = { started: false, error: e && e.message ? e.message : String(e) };
                    }
                }
                if (startRes && startRes.started === false && startRes.reason !== 'already_running') {
                    await finishAutoSyncRun('mssales', 'failed',
                        startRes.error || startRes.reason || 'Не удалось запустить синхронизацию продаж МС');
                    console.log('[AUTO SYNC] Queue done: mssales — failed (start)');
                } else {
                    let timedOut = false;
                    let finalState;
                    if (startRes && startRes.started === false && startRes.reason === 'already_running') {
                        timedOut = !(await waitUntil(() => {
                            const s = typeof msSalesModule.getSyncState === 'function'
                                ? msSalesModule.getSyncState()
                                : { active: false };
                            return !s.active;
                        }, 12 * 60 * 60 * 1000, 1000));
                        finalState = typeof msSalesModule.getSyncState === 'function'
                            ? msSalesModule.getSyncState()
                            : { active: false };
                    } else {
                        finalState = (startRes && startRes.status) || (typeof msSalesModule.getSyncState === 'function'
                            ? msSalesModule.getSyncState()
                            : { active: false });
                    }
                    let status = 'failed';
                    let message;
                    if (timedOut) {
                        message = 'Таймаут ожидания (12 ч)';
                    } else if (finalState.last_error) {
                        message = ('Ошибка: ' + finalState.last_error).slice(0, 480);
                    } else {
                        status = 'completed';
                        const incTag = finalState.incremental_mode
                            ? ('инкремент с ' + (finalState.incremental_from_moment || '?') + ', ')
                            : '';
                        message = (
                            'Окно ' + days + ' дн., ' + incTag + 'отгрузок ' +
                            (finalState.fetched_demands || 0) + '/' + (finalState.total_demands || 0) +
                            ', позиций ' + (finalState.saved_positions || 0) +
                            ' (резолв ' + (finalState.resolved_positions || 0) +
                            ', не привязано ' + (finalState.unresolved_positions || 0) +
                            ', помечено удалёнными ' + (finalState.deleted_demands || 0) +
                            ', воскрешено ' + (finalState.restored_demands || 0) + ')'
                        ).slice(0, 480);
                    }
                    await finishAutoSyncRun('mssales', status, message);
                    console.log('[AUTO SYNC] Queue done: mssales — ' + status + ' (' + message + ')');
                }
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
        if (autoSyncRunIds.has('marketplaces')) {
            await finishAutoSyncRun('marketplaces', 'failed', e.message || 'Ошибка очереди');
        }
        if (autoSyncRunIds.has('huckster')) {
            await finishAutoSyncRun('huckster', 'failed', e.message || 'Ошибка очереди');
        }
        if (autoSyncRunIds.has('db_size')) {
            await finishAutoSyncRun('db_size', 'failed', e.message || 'Ошибка очереди');
        }
        if (autoSyncRunIds.has('dimensions')) {
            await finishAutoSyncRun('dimensions', 'failed', e.message || 'Ошибка очереди');
        }
        if (autoSyncRunIds.has('mssales')) {
            await finishAutoSyncRun('mssales', 'failed', e.message || 'Ошибка очереди');
        }
        if (autoSyncRunIds.has('mssales_full')) {
            await finishAutoSyncRun('mssales_full', 'failed', e.message || 'Ошибка очереди');
        }
        if (autoSyncRunIds.has('purchase_formula_cache')) {
            await finishAutoSyncRun('purchase_formula_cache', 'failed', e.message || 'Ошибка очереди');
        }
    } finally {
        autoSyncRunnerActive = false;
        /** Пока runner занят, новые задачи только копятся в очереди; без повторного вызова они бы не стартовали. */
        if (autoSyncQueue.length > 0) {
            setImmediate(() => {
                processAutoSyncQueue().catch((err) => {
                    console.error('[AUTO SYNC] chained drain:', err && err.message ? err.message : err);
                });
            });
        }
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
                },
                {
                    type: 'marketplaces',
                    enabled: Number(appSettings.auto_sync_marketplaces_enabled || 0) === 1,
                    time: String(appSettings.auto_sync_marketplaces_time || '05:00').slice(0, 5)
                },
                {
                    type: 'huckster',
                    enabled: Number(appSettings.auto_sync_huckster_enabled || 0) === 1,
                    time: String(appSettings.auto_sync_huckster_time || '06:00').slice(0, 5)
                },
                {
                    type: 'db_size',
                    enabled: Number(appSettings.auto_sync_db_size_enabled ?? 1) === 1,
                    time: String(appSettings.auto_sync_db_size_time || '02:00').slice(0, 5)
                },
                {
                    type: 'dimensions',
                    enabled: Number(appSettings.auto_sync_dimensions_enabled || 0) === 1,
                    time: String(appSettings.auto_sync_dimensions_time || '21:00').slice(0, 5)
                },
                {
                    type: 'mssales',
                    enabled: Number(appSettings.auto_sync_mssales_enabled || 0) === 1,
                    time: String(appSettings.auto_sync_mssales_time || '07:30').slice(0, 5),
                    weekdays: parseAutoSyncWeekdaysMon17(appSettings.auto_sync_mssales_weekdays)
                },
                {
                    type: 'mssales_full',
                    enabled: Number(appSettings.auto_sync_mssales_full_enabled || 0) === 1,
                    time: String(appSettings.auto_sync_mssales_full_time || '03:15').slice(0, 5),
                    weekdays: parseAutoSyncWeekdaysMon17(appSettings.auto_sync_mssales_full_weekdays)
                },
                {
                    type: 'purchase_formula_cache',
                    enabled: Number(appSettings.auto_sync_purchase_formula_cache_enabled || 0) === 1,
                    time: String(appSettings.auto_sync_purchase_formula_cache_time || '08:30').slice(0, 5)
                }
            ];
            for (const t of tasks) {
                if (!t.enabled) continue;
                if (now.time !== t.time) continue;
                if (t.weekdays && !t.weekdays.has(now.weekdayMon1Sun7)) continue;
                const runKey = `${now.date} ${t.time}`;
                const last = autoSyncLastRunByTask.get(t.type);
                if (last === runKey) continue;
                autoSyncLastRunByTask.set(t.type, runKey);
                enqueueAutoSyncTask(t.type);
            }
            processAutoSyncQueue().catch((e) => console.error('[AUTO SYNC] scheduler tick:', e && e.message ? e.message : e));
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
    // Слушаем порт сразу после БД: регистрация роутов ниже может занимать секунды,
    // а тяжёлый post-init/фон не должен держать пользователя на «белой» странице.
    const publicDirEarly = path.join(__dirname, 'public');
    app.use('/static', express.static(path.join(publicDirEarly, 'static'), { maxAge: '1d', fallthrough: true }));
    app.get(['/login.html', '/favicon.svg', '/favicon.ico', '/datagon-vanilla.js'], (req, res, next) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') return next();
        const base = req.path === '/favicon.ico' ? 'favicon.svg' : req.path.replace(/^\//, '');
        const file = path.join(publicDirEarly, base);
        if (!fsSync.existsSync(file)) return next();
        return res.sendFile(path.resolve(file));
    });

    if (!app.__datagonListening) {
        app.__datagonListening = true;
        app.listen(PORT, () => {
            console.log(`[Server] Running on port ${PORT}`);
            for (const task of postInitTasks) {
                Promise.resolve()
                    .then(() => task())
                    .catch((e) => console.warn('[startup] post-init:', e && e.message ? e.message : e));
            }
        });
    }

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

    const { apiRelativePathToPageKey, isHttpReadMethod } = require('./lib/datagonPageRegistry');
    app.use('/api', (req, res, next) => {
        if (!req.datagonActor) return next();
        if (req.datagonActor.username === 'admin') return next();
        const pathOnly = String(req.path || '').split('?')[0];
        const canManageUsers = req.datagonActor.can_manage_users === true;
        if (canManageUsers) {
            if (pathOnly === '/auth/users' || pathOnly.startsWith('/auth/users/')) return next();
            if (isHttpReadMethod(req.method) && (pathOnly === '/specialties' || pathOnly.startsWith('/specialties/'))) {
                return next();
            }
        }
        const pageKey = apiRelativePathToPageKey(pathOnly);
        if (pageKey == null) return next();
        const mode = req.datagonActor.page_modes[pageKey] || 'full';
        if (mode === 'hidden') {
            res.status(403);
            return res.json({ error: 'Нет доступа к разделу', code: 'PAGE_HIDDEN' });
        }
        if (mode === 'view' && !isHttpReadMethod(req.method)) {
            res.status(403);
            return res.json({ error: 'Режим только просмотра', code: 'PAGE_VIEW_ONLY' });
        }
        return next();
    });

    app.use('/api/auth', authModule.router);
    // Совместимость со старым фронтендом/кэшем, где логин идет на /api/login
    app.use('/api', authModule.router);
    app.use('/api/activity', require('./routes/activity')(db));
    app.use('/api/specialties', require('./routes/specialties')(db));
    app.post('/api/settings/auto-sync-run', async (req, res) => {
        try {
            const task = String(req.body?.task || '').trim();
            const { getAutoSyncTaskKeys } = require('./lib/datagonAutoSyncRegistry');
            const allowed = new Set(getAutoSyncTaskKeys());
            if (!allowed.has(task)) {
                return res.status(400).json({ success: false, error: 'Некорректный тип автосинхронизации' });
            }
            const enq = enqueueAutoSyncTask(task, 'manual');
            processAutoSyncQueue();
            return res.json({
                success: true,
                queued: enq.ok,
                skip_reason: enq.ok ? null : enq.reason || null,
                task,
                queue: autoSyncQueue.map((item) => (typeof item === 'string' ? item : item?.type)).filter(Boolean),
                runner_active: Boolean(autoSyncRunnerActive),
                running_tasks: Array.from(autoSyncRunIds.keys())
            });
        } catch (e) {
            return res.status(500).json({ success: false, error: e.message || 'Ошибка запуска автосинхронизации' });
        }
    });
    app.use('/api/settings', require('./routes/settings')(db, appSettings));
    app.use('/api/exports/marketplaces', exportsMarketplacesRouterFactory(db, appSettings));
    app.use('/api/exports/dimensions', require('./routes/dimensions')(db, appSettings));
    app.use('/api/exports/huckster', exportsHucksterRouterFactory(db, appSettings));
    app.use('/api/projects', require('./routes/projects')(db, appSettings));
    {
        // MS Sales — отдельная страница «Продажи МС»: тянет entity/demand из МС API,
        // хранит документы и позиции локально, резолвит позиции до ms_export.uuid/code.
        // См. routes/msSales.js и docs api.md (раздел «Продажи МС»).
        const { createMsSalesRouter } = require('./routes/msSales');
        app.use('/api/ms-sales', createMsSalesRouter(db, appSettings));
    }
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

    app.get('/api/processes/db-size', async (req, res) => {
        try {
            const forceRefresh = String(req.query.refresh || '') === '1';
            const databaseSize = await getDatabaseSizeMetrics(forceRefresh);
            return res.json({ success: true, databaseSize });
        } catch (e) {
            return res.status(500).json({ success: false, error: e.message || 'Не удалось получить размер базы данных' });
        }
    });

    /**
     * Используется виджетом "Дисковое пространство" на дашборде:
     *  - размер диска (df-эквивалент через fs.statfs);
     *  - суммарный размер проекта;
     *  - разбивка по верхнеуровневым каталогам (включая .git, node_modules, vendor)
     *    с количеством файлов и долей в %.
     * Кэш 5 минут (см. DISK_USAGE_CACHE_TTL_MS); ?refresh=1 пересчитывает.
     */
    app.get('/api/processes/disk-usage', async (req, res) => {
        try {
            const forceRefresh = String(req.query.refresh || '') === '1';
            const diskUsage = await getDiskUsageMetrics(forceRefresh);
            return res.json({ success: true, diskUsage });
        } catch (e) {
            return res.status(500).json({ success: false, error: e.message || 'Не удалось получить разбивку диска' });
        }
    });

    app.get('/api/processes/overview', async (req, res) => {
        try {
            const selectedSiteIdRaw = req.query.my_site_id;
            const selectedSiteId = selectedSiteIdRaw ? parseInt(selectedSiteIdRaw, 10) : null;

            /**
             * «За день» — выбор календарной даты в МСК.
             * По умолчанию — сегодня. Ограничиваем 14 днями назад (история процессов).
             */
            const PROCESSES_DATE_WINDOW_DAYS = 14;
            const moscowToday = getMoscowNowParts().date; // YYYY-MM-DD по МСК
            const moscowDateOf = (ts) => {
                if (!ts) return '';
                try {
                    return new Date(ts).toLocaleDateString('en-CA', { timeZone: 'Europe/Moscow' });
                } catch (_) {
                    return '';
                }
            };
            const isMoscowDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
            const requestedForDateRaw = String(req.query.for_date || '').trim();
            /** Список допустимых дат: сегодня и 14 дней назад. */
            const forDateOptions = [];
            {
                const todayMs = new Date(`${moscowToday}T12:00:00+03:00`).getTime();
                for (let i = 0; i < PROCESSES_DATE_WINDOW_DAYS; i += 1) {
                    const d = new Date(todayMs - i * 86400000)
                        .toLocaleDateString('en-CA', { timeZone: 'Europe/Moscow' });
                    forDateOptions.push(d);
                }
            }
            const forDate = isMoscowDate(requestedForDateRaw) && forDateOptions.includes(requestedForDateRaw)
                ? requestedForDateRaw
                : moscowToday;
            const isToday = forDate === moscowToday;

            const globalSync = {
                active: Boolean(syncState.active),
                processed: Number(syncState.processed || 0),
                total: Number(syncState.total || 0),
                message: syncState.message || ''
            };

            const moyskladState = typeof moyskladRouterFactory.getJobState === 'function'
                ? moyskladRouterFactory.getJobState()
                : { active: false, done: false, processed: 0, total: 0, message: 'Недоступно', logs: [], updatedAt: null };
            /**
             * Текущая сессия в памяти процесса релевантна только когда выбран сегодняшний день
             * (она про текущий процесс, дату не различает). На других днях — отдаём пустой набор,
             * чтобы фронт не показывал не относящиеся к выбранному дню строки.
             */
            const moysklad = isToday
                ? moyskladState
                : { ...moyskladState, logs: [] };
            const mskNow = getMoscowNowParts();
            /**
             * Поле `sections` строится из единого реестра задач
             * `lib/datagonAutoSyncRegistry.js` и используется фронтом
             * `processes.scripts.html` → `renderAutoSyncSections`. Это
             * исключает рассинхрон между набором задач на /settings.html
             * и набором карточек на /processes.html: при добавлении новой
             * задачи в реестр она автоматически появится в обоих местах.
             * Поле `config` оставлено для обратной совместимости (legacy-фронт).
             */
            const { buildAutoSyncSectionsSnapshot } = require('./lib/datagonAutoSyncRegistry');
            const autoSync = {
                now_moscow_time: mskNow.time,
                now_moscow_date: mskNow.date,
                queue: [...autoSyncQueue],
                runner_active: Boolean(autoSyncRunnerActive),
                /** Типы задач с открытой строкой `auto_sync_runs` (то, что воркер реально исполняет сейчас). */
                running_tasks: Array.from(autoSyncRunIds.keys()),
                sections: buildAutoSyncSectionsSnapshot(appSettings),
                /** Живой прогресс текущих задач автосинка (только при открытой строке auto_sync_runs). */
                tasks_live: buildAutoSyncTasksLiveForOverview(),
                config: {
                    myproducts_enabled: Number(appSettings.auto_sync_myproducts_enabled || 0) === 1,
                    myproducts_time: String(appSettings.auto_sync_myproducts_time || '03:00'),
                    moysklad_enabled: Number(appSettings.auto_sync_moysklad_enabled || 0) === 1,
                    moysklad_time: String(appSettings.auto_sync_moysklad_time || '04:00'),
                    marketplaces_enabled: Number(appSettings.auto_sync_marketplaces_enabled || 0) === 1,
                    marketplaces_time: String(appSettings.auto_sync_marketplaces_time || '05:00'),
                    huckster_enabled: Number(appSettings.auto_sync_huckster_enabled || 0) === 1,
                    huckster_time: String(appSettings.auto_sync_huckster_time || '06:00'),
                    db_size_enabled: Number(appSettings.auto_sync_db_size_enabled ?? 1) === 1,
                    db_size_time: String(appSettings.auto_sync_db_size_time || '02:00'),
                    dimensions_enabled: Number(appSettings.auto_sync_dimensions_enabled || 0) === 1,
                    dimensions_time: String(appSettings.auto_sync_dimensions_time || '21:00'),
                    mssales_enabled: Number(appSettings.auto_sync_mssales_enabled || 0) === 1,
                    mssales_time: String(appSettings.auto_sync_mssales_time || '07:30'),
                    mssales_days: Number(appSettings.auto_sync_mssales_days || 90),
                    mssales_weekdays: String(appSettings.auto_sync_mssales_weekdays || ''),
                    mssales_full_enabled: Number(appSettings.auto_sync_mssales_full_enabled || 0) === 1,
                    mssales_full_time: String(appSettings.auto_sync_mssales_full_time || '03:15'),
                    mssales_full_days: Number(appSettings.auto_sync_mssales_full_days || 730),
                    mssales_full_weekdays: String(appSettings.auto_sync_mssales_full_weekdays || '7')
                }
            };
            const discovery = (typeof pagesRouter?.getDiscoveryJobsSnapshot === 'function')
                ? pagesRouter.getDiscoveryJobsSnapshot()
                : [];
            let autoSyncRuns = [];
            try {
                await ensureAutoSyncRunsTable();
                /**
                 * Берём окно с запасом по UTC, чтобы поймать запуски, чей московский календарный день
                 * совпадает с выбранным forDate, независимо от session timezone MySQL.
                 */
                const [runs] = await db.query(
                    `SELECT id, task_type, trigger_type, started_at, finished_at, status, message
                     FROM auto_sync_runs
                     WHERE started_at >= DATE_SUB(?, INTERVAL 1 DAY)
                       AND started_at < DATE_ADD(?, INTERVAL 2 DAY)
                     ORDER BY id DESC
                     LIMIT 500`,
                    [forDate, forDate]
                );
                autoSyncRuns = (Array.isArray(runs) ? runs : []).filter(
                    (r) => moscowDateOf(r.started_at) === forDate
                );
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
                /**
                 * Берём последнюю задачу сопоставления для сайта, чей старт пришёлся на выбранный
                 * день в МСК. Окно по started_at — с запасом ±1 день, чтобы не зависеть от
                 * session timezone MySQL.
                 */
                const [jobs] = await db.query(
                    `SELECT * FROM matching_jobs
                     WHERE my_site_id = ?
                       AND started_at >= DATE_SUB(?, INTERVAL 1 DAY)
                       AND started_at < DATE_ADD(?, INTERVAL 2 DAY)
                     ORDER BY id DESC
                     LIMIT 20`,
                    [effectiveSiteId, forDate, forDate]
                );
                const jobsOfDay = (Array.isArray(jobs) ? jobs : []).filter(
                    (j) => moscowDateOf(j.started_at) === forDate
                );
                if (jobsOfDay.length) {
                    const job = jobsOfDay[0];
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
                } else {
                    matches.message = isToday
                        ? 'Сегодня задач сопоставления ещё не было'
                        : 'За выбранный день задач сопоставления не было';
                }
            }

            let databaseSize = null;
            try {
                databaseSize = await getDatabaseSizeMetrics(false);
            } catch (e) {
                databaseSize = { error: e.message || 'Не удалось получить размер базы данных' };
            }

            let moyskladPersistedLogs = [];
            if (typeof moyskladRouterFactory.fetchMsSyncPersistedLogsForDate === 'function') {
                try {
                    moyskladPersistedLogs = await moyskladRouterFactory.fetchMsSyncPersistedLogsForDate(db, forDate);
                } catch (_) {
                    moyskladPersistedLogs = [];
                }
            } else if (typeof moyskladRouterFactory.fetchMsSyncPersistedLogs === 'function') {
                try {
                    moyskladPersistedLogs = await moyskladRouterFactory.fetchMsSyncPersistedLogs(db, 50);
                } catch (_) {
                    moyskladPersistedLogs = [];
                }
            }

            return res.json({
                refreshedAt: new Date().toISOString(),
                forDate,
                forDateOptions,
                moscowToday,
                isToday,
                globalSync,
                moysklad,
                moyskladPersistedLogs,
                autoSync,
                autoSyncRuns,
                discovery,
                queue,
                matchesSites,
                matches,
                databaseSize,
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
    setTimeout(() => {
        (async () => {
            // Лог нулей — один SQL, без большого RAM. Список закупок — SQL-пагинация в routes/purchase.js (без in-memory снимка).
            try {
                const { syncZeroStockLogAfterMoyskladExport } = require('./routes/product');
                if (typeof syncZeroStockLogAfterMoyskladExport === 'function') {
                    const { scanned } = await syncZeroStockLogAfterMoyskladExport(db);
                    console.log(
                        `[product] zero-stock log (today): ${scanned} candidates upserted from ms_export`,
                    );
                }
            } catch (err) {
                console.warn(
                    '[product] syncZeroStockLogAfterMoyskladExport:',
                    err && err.message ? err.message : err,
                );
            }

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

            console.log(
                '[purchase] список закупок: SQL ORDER BY + LIMIT/OFFSET; env PURCHASE_STARTUP_WARMUP / purchase_warmup больше не грузят каталог в память Node',
            );
        })().catch((err) => {
            console.warn('[startup] deferred tasks:', err && err.message ? err.message : err);
        });
    }, STARTUP_DEFER_MS);
    if (STARTUP_DEFER_MS > 0) {
        console.log(`[startup] тяжёлые фоновые задачи отложены на ${STARTUP_DEFER_MS} мс (DATAGON_STARTUP_DEFER_MS)`);
    }
    app.use('/api/ms', moyskladRouterFactory(db, appSettings, config));
    app.use('/api/purchase', purchaseRouterFactory(db, appSettings));
    app.use('/api/product', productRouterFactory(db, appSettings));
    
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
    app.get('/purchase', redirectToDatagonHtml('purchase.html'));
    app.get('/product', redirectToDatagonHtml('product.html'));
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

    const publicDir = path.join(__dirname, 'public');
    /** CSS/JS/favicon — без проверки сессии и без ожидания пула MySQL (иначе «белая» страница при занятом пуле). */
    app.use('/static', express.static(path.join(publicDir, 'static'), { maxAge: '1d', fallthrough: true }));
    app.get(['/datagon-vanilla.js', '/favicon.svg', '/favicon.ico'], (req, res, next) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') return next();
        const base = req.path === '/favicon.ico' ? 'favicon.svg' : req.path.replace(/^\//, '');
        const file = path.join(publicDir, base);
        if (!fsSync.existsSync(file)) return next();
        return res.sendFile(path.resolve(file));
    });

    /** HTML-страницы Datagon (vanilla) без сессии не отдаём: редирект на /login.html?then=… */
    app.use(async (req, res, next) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') return next();
        const raw = String(req.path || '').split('?')[0];
        if (!raw.toLowerCase().endsWith('.html')) return next();
        if (raw.includes('..')) return res.status(400).end();
        if (raw.startsWith('/doc-screenshots/')) {
            return next();
        }
        if (raw.startsWith('/docs') || raw.startsWith('/architectui-react-pro')) {
            return next();
        }
        const leaf = raw.slice(raw.lastIndexOf('/') + 1).toLowerCase();
        if (leaf === 'login.html') return next();
        try {
            let actor = null;
            try {
                actor = await promiseWithTimeout(authModule.getActor(req), 12000, 'HTML auth DB timeout');
            } catch (authErr) {
                if (String(authErr && authErr.message ? authErr.message : authErr).includes('timeout')) {
                    console.warn('[auth] HTML page auth timeout:', raw);
                } else {
                    throw authErr;
                }
            }
            if (actor) {
                if (actor.username !== 'admin') {
                    const {
                        isHtmlLeafAccessHiddenForActor,
                        pickFirstAllowedHtmlForActor
                    } = require('./lib/datagonPageRegistry');
                    if (leaf === 'no-access.html') return next();
                    if (isHtmlLeafAccessHiddenForActor(actor, leaf)) {
                        const dest = pickFirstAllowedHtmlForActor(actor);
                        if (dest) {
                            const destLeaf = dest.slice(dest.lastIndexOf('/') + 1).toLowerCase();
                            if (destLeaf !== leaf) return res.redirect(302, dest);
                        }
                        return res.redirect(302, '/no-access.html');
                    }
                }
                return next();
            }
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

    // BC-редирект: страница «Неопубликованные товары» переименована в «Проблемы с товарами».
    app.get('/exports-marketplaces-unpublished.html', (req, res) => {
        const qs = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
        return res.redirect(301, '/exports-marketplaces-issues.html' + qs);
    });

    app.get(/^\/my-product\/?$/, (req, res) => {
        const qs = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
        return res.redirect(301, '/my-products.html' + qs);
    });

    /** Не отдавать HTML-страницу ошибки Express на /api — только JSON. */
    app.use('/api', (err, req, res, next) => {
        if (res.headersSent) return next(err);
        console.error('[api] unhandled:', err && err.stack ? err.stack : err);
        res.status(500).json({
            success: false,
            error: err && err.message ? err.message : 'Внутренняя ошибка',
        });
    });

    app.use(express.static(publicDir));

    // Intentionally skip heavy post-init DDL tasks in runtime mode.

    // Автоочистка логов по настройке: раз в 12 часов.
    cleanupLogsByRetentionDays(appSettings.log_retention_days).catch(() => {});
    cleanupResultsByRetentionDays(appSettings.results_retention_days).catch(() => {});
    cleanupDimensionsLogByRetentionDays(appSettings.ms_dimensions_log_retention_days).catch(() => {});
    cleanupPurchaseOverridesLogByRetentionDays(appSettings.dg_purchase_overrides_log_retention_days).catch(() => {});
    cleanupAutoSyncRunsByRetentionDays(appSettings.auto_sync_runs_retention_days).catch(() => {});
    setInterval(() => {
        cleanupLogsByRetentionDays(appSettings.log_retention_days).catch(() => {});
        cleanupResultsByRetentionDays(appSettings.results_retention_days).catch(() => {});
        cleanupDimensionsLogByRetentionDays(appSettings.ms_dimensions_log_retention_days).catch(() => {});
        cleanupPurchaseOverridesLogByRetentionDays(appSettings.dg_purchase_overrides_log_retention_days).catch(() => {});
        cleanupAutoSyncRunsByRetentionDays(appSettings.auto_sync_runs_retention_days).catch(() => {});
    }, 12 * 60 * 60 * 1000);
    const bootAutoSync = () => {
        closeStaleAutoSyncRunsOnStartup()
            .catch((e) => console.warn('[AUTO SYNC]', e.message || e))
            .finally(() => {
                startAutoSyncScheduler();
                startUnifiedTaskWatchdog();
                closeAncientRunningAutoSyncRuns().catch(() => {});
                setInterval(() => {
                    closeAncientRunningAutoSyncRuns().catch(() => {});
                }, 6 * 60 * 60 * 1000);
            });
    };
    if (STARTUP_DEFER_MS > 0) {
        setTimeout(bootAutoSync, STARTUP_DEFER_MS);
    } else {
        bootAutoSync();
    }
}).catch(err => {
    console.error('Failed to start server:', err);
    process.exit(1);
});
