const mysql = require('mysql2/promise');
const config = require('./config');

// НАСТРОЙКИ (можно вынести в аргументы или ENV, пока берем дефолтные)
const SYNC_BATCH_SIZE = 500;
const SYNC_DELAY_MS = 2000;

async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
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

async function runSync(siteId) {
    let dbLocal, dbRemote;
    
    try {
        // Подключение к локальной БД (наша)
        dbLocal = await mysql.createConnection({
            host: config.db.host,
            user: config.db.user,
            password: config.db.password,
            database: config.db.database
        });
        console.log(`[Sync] Подключено к локальной БД.`);

        // Получаем настройки сайта
        const [sites] = await dbLocal.query('SELECT * FROM my_sites WHERE id = ?', [siteId]);
        if (sites.length === 0) throw new Error(`Сайт с ID ${siteId} не найден`);
        const site = sites[0];
        
        console.log(`[Sync] Начало синхронизации для: ${site.name} (${site.domain})`);

        await dbLocal.query(`
            ALTER TABLE my_products
            ADD COLUMN IF NOT EXISTS source_enabled TINYINT(1) NOT NULL DEFAULT 1
        `);

        // Подключение к удаленной БД (донор)
        dbRemote = await mysql.createConnection({
            host: site.db_host,
            user: site.db_user,
            password: site.db_pass,
            database: site.db_name,
            connectTimeout: 10000
        });
        console.log(`[Sync] Подключено к удаленной БД.`);

        // 1. Сброс всех товаров этого сайта в is_active = 0
        console.log('[Sync] Шаг 1: Помечаем все товары как "не найдены"...');
        await dbLocal.query('UPDATE my_products SET is_active = 0 WHERE site_id = ?', [site.id]);

        // 2. Узнаем общее количество товаров
        let countQuery = '';
        if (site.cms_type === 'webasyst') {
            countQuery = `SELECT COUNT(*) as total FROM ${site.table_products} p JOIN ${site.wa_table_skus} sk ON p.id = sk.product_id`;
        } else {
            countQuery = `SELECT COUNT(*) as total FROM ${site.table_products}`;
        }
        const [countRes] = await dbRemote.query(countQuery);
        const totalItems = countRes[0].total;
        console.log(`[Sync] Всего товаров найдено: ${totalItems}`);

        let offset = 0;
        let processedCount = 0;

        // 3. Цикл по пачкам
        while (offset < totalItems) {
            console.log(`[Sync] Обработка пачки: ${offset} - ${offset + SYNC_BATCH_SIZE}...`);

            let fetchQuery = '';
            if (site.cms_type === 'webasyst') {
                fetchQuery = `
                    SELECT p.id as source_id, p.name, sk.${site.wa_field_sku_val} as sku, sk.${site.wa_field_price_val} as price, p.currency, sk.${site.wa_field_stock_val} as stock, p.url as url_key, CASE WHEN p.status = 1 THEN 1 ELSE 0 END as source_enabled
                    FROM ${site.table_products} p
                    JOIN ${site.wa_table_skus} sk ON p.id = sk.product_id
                    LIMIT ? OFFSET ?
                `;
            } else {
                fetchQuery = `
                    SELECT ${site.field_code} as source_id, ${site.field_name} as name, ${site.field_sku} as sku, ${site.field_price} as price, ${site.field_currency} as currency, ${site.field_stock} as stock, '' as url_key, 1 as source_enabled
                    FROM ${site.table_products}
                    LIMIT ? OFFSET ?
                `;
            }

            const [rows] = await dbRemote.query(fetchQuery, [SYNC_BATCH_SIZE, offset]);

            if (rows.length === 0) break;

            // Массовая вставка/обновление
            const values = rows.map(r => [
                site.id, 
                String(r.source_id || '').trim(),
                r.sku || '', 
                r.name || '', 
                r.price || 0, 
                r.currency || 'RUB', 
                r.stock || 0,
                buildSourceUrl(site.domain, r.url_key, site.cms_type),
                Number(r.source_enabled) === 0 ? 0 : 1
            ]);

            await dbLocal.query(`
                INSERT INTO my_products (site_id, source_id, sku, name, price, currency, stock, source_url, source_enabled)
                VALUES ?
                ON DUPLICATE KEY UPDATE 
                    source_id = VALUES(source_id),
                    name = VALUES(name),
                    price = VALUES(price),
                    currency = VALUES(currency),
                    stock = VALUES(stock),
                    source_url = VALUES(source_url),
                    source_enabled = VALUES(source_enabled),
                    is_active = 1,
                    updated_at = NOW()
            `, [values]);

            processedCount += rows.length;
            offset += SYNC_BATCH_SIZE;

            console.log(`[Sync] Обработано: ${processedCount}/${totalItems}. Пауза ${SYNC_DELAY_MS}мс...`);
            
            // Пауза чтобы не убить донора
            if (offset < totalItems) {
                await sleep(SYNC_DELAY_MS);
            }
        }

        // 4. Финал: считаем сколько осталось неактивных
        const [inactive] = await dbLocal.query('SELECT COUNT(*) as c FROM my_products WHERE site_id = ? AND is_active = 0', [site.id]);
        
        console.log(`[Sync] ГОТОВО! Обновлено: ${processedCount}, Скрыто (удалено): ${inactive[0].c}`);

    } catch (error) {
        console.error('[Sync] КРИТИЧЕСКАЯ ОШИБКА:', error.message);
        process.exit(1);
    } finally {
        if (dbLocal) await dbLocal.end();
        if (dbRemote) await dbRemote.end();
    }
}

// Запуск: node sync-worker.js <site_id>
const siteIdArg = process.argv[2];

if (!siteIdArg) {
    console.error('Использование: node sync-worker.js <ID_САЙТА>');
    console.error('Пример: node sync-worker.js 2');
    process.exit(1);
}

runSync(parseInt(siteIdArg));