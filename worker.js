const mysql = require('mysql2/promise');
const axios = require('axios');
const cheerio = require('cheerio');
const config = require('./config');

// НАСТРОЙКИ
const PAUSE_MS = 1000; // 1 секунда между запросами
const BATCH_SIZE = 50; // Сколько страниц брать за один прогон скрипта
const MAX_ERRORS_IN_ROW = 5; // Стоп-кран: сколько ошибок сервера подряд до остановки

async function runWorker() {
    let db;
    try {
        db = await mysql.createConnection({
            host: config.db.host,
            user: config.db.user,
            password: config.db.password,
            database: config.db.database
        });
        console.log(`[${new Date().toLocaleTimeString()}] Worker: Подключено к БД. Старт...`);

        let consecutiveErrors = 0;
        let processedCount = 0;

        // Получаем все активные проекты
        const [projects] = await db.query('SELECT * FROM projects WHERE is_active = TRUE OR is_active IS NULL');
        if (projects.length === 0) {
            console.log('[Worker] Нет активных проектов.');
            return;
        }

        // Проходим по каждому проекту
        for (const project of projects) {
            if (consecutiveErrors >= MAX_ERRORS_IN_ROW) {
                console.log(`[Worker] СТОП. Лимит ошибок сервера подряд (${MAX_ERRORS_IN_ROW}). Остановка.`);
                break;
            }

            // Берем пачку pending страниц для этого проекта
            const [pages] = await db.query(
                'SELECT * FROM pages WHERE project_id = ? AND status = "pending" LIMIT ?',
                [project.id, BATCH_SIZE]
            );

            if (pages.length === 0) continue;

            console.log(`[Worker] Проект "${project.name}": найдено ${pages.length} страниц.`);

            for (const page of pages) {
                if (consecutiveErrors >= MAX_ERRORS_IN_ROW) break;

                try {
                    await db.query('UPDATE pages SET status = "processing" WHERE id = ?', [page.id]);

                    const response = await axios.get(page.url, {
                        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
                        timeout: 10000, 
                        validateStatus: function (status) {
                            return status < 500; 
                        }
                    });

                    // Проверка на 5xx и 429
                    if (response.status >= 500 || response.status === 429) {
                        throw new Error(`Сервер вернул ошибку ${response.status}`);
                    }

                    const $ = cheerio.load(response.data);
                    let pageType = 'product';
                    
                    const priceSelectors = project.selector_price ? project.selector_price.split(',') : [];
                    let hasPriceElement = false;
                    for (let sel of priceSelectors) { if ($(sel.trim()).length > 0) { hasPriceElement = true; break; } }
                    
                    let hasOosElement = false;
                    if (project.selector_oos) {
                        const oosSelectors = project.selector_oos.split(',');
                        for (let sel of oosSelectors) { if ($(sel.trim()).length > 0) { hasOosElement = true; break; } }
                    }

                    if (!hasPriceElement && !hasOosElement) {
                        if ($('.catalog-grid, .news-list, .item_list').length > 0) pageType = 'category';
                        else pageType = 'info';
                    }

                    await db.query('UPDATE pages SET page_type = ? WHERE id = ?', [pageType, page.id]);

                    if (pageType !== 'product') {
                        await db.query('UPDATE pages SET status = "done", parsed_at = NOW(), last_error = NULL WHERE id = ?', [page.id]);
                        console.log(`  -> Пропущено (${pageType}): ${page.url}`);
                        consecutiveErrors = 0;
                        processedCount++;
                        await sleep(PAUSE_MS);
                        continue;
                    }

                    // Парсинг цены
                    let priceText = '';
                    let price = null;
                    for (let sel of priceSelectors) {
                        let text = $(sel.trim()).first().text().trim();
                        if (!text) text = $(sel.trim()).first().attr('content') || $(sel.trim()).first().attr('data-price') || '';
                        if (text) { priceText = text; break; }
                    }
                    if (priceText) {
                        priceText = priceText.replace(/[^0-9,.]/g, '').replace(',', '.');
                        price = parseFloat(priceText);
                    }

                    // Парсинг остального
                    let isOos = false;
                    if (project.selector_oos) {
                        const oosSelectors = project.selector_oos.split(',');
                        for (let sel of oosSelectors) { if ($(sel.trim()).length > 0) { isOos = true; break; } }
                    }

                    let productName = '';
                    if (project.selector_name) {
                        const nameSelectors = project.selector_name.split(',');
                        for (let sel of nameSelectors) { productName = $(sel.trim()).first().text().trim(); if (productName) break; }
                    }

                    let sku = '';
                    if (project.selector_sku) {
                        const skuSelectors = project.selector_sku.split(',');
                        for (let sel of skuSelectors) { sku = $(sel.trim()).first().text().trim(); if (sku) break; }
                    }
                    if (!sku) sku = $('meta[itemprop="productID"]').attr('content') || '';

                    // Сохранение
                    if (isOos) {
                        await db.query('INSERT INTO prices (project_id, page_id, sku, product_name, price, is_oos, url) VALUES (?, ?, ?, ?, ?, 1, ?)', [project.id, page.id, sku, productName, null, page.url]);
                        await db.query('UPDATE pages SET status = "done", parsed_at = NOW(), last_error = NULL WHERE id = ?', [page.id]);
                        console.log(`  -> Под заказ: ${page.url}`);
                    } else if (!isNaN(price)) {
                        await db.query('INSERT INTO prices (project_id, page_id, sku, product_name, price, is_oos, url) VALUES (?, ?, ?, ?, ?, 0, ?)', [project.id, page.id, sku, productName, price, page.url]);
                        await db.query('UPDATE pages SET status = "done", parsed_at = NOW(), last_error = NULL WHERE id = ?', [page.id]);
                        console.log(`  -> Цена ${price}: ${page.url}`);
                    } else {
                        throw new Error('Цена не найдена');
                    }

                    consecutiveErrors = 0; 
                    processedCount++;

                } catch (error) {
                    console.error(`  -> Ошибка ${page.url}: ${error.message}`);
                    
                    // Критические ошибки сервера или сети
                    const isServerCrash = error.message.includes('500') || error.message.includes('502') || error.message.includes('503') || error.message.includes('504') || error.code === 'ECONNABORTED' || error.code === 'ENOTFOUND' || error.code === 'ECONNRESET';

                    if (isServerCrash) {
                        consecutiveErrors++;
                        console.warn(`   !!! Критическая ошибка сервера. Счетчик: ${consecutiveErrors}/${MAX_ERRORS_IN_ROW}`);
                        // Возвращаем в pending, чтобы следующий крон попробовал снова
                        await db.query('UPDATE pages SET status = "pending", last_error = ? WHERE id = ?', [error.message.substring(0, 200), page.id]);
                    } else {
                        // Ошибка парсинга (нет цены, селектор не тот) - сразу в error, счетчик не увеличиваем
                        consecutiveErrors = 0; 
                        await db.query('UPDATE pages SET status = "error", last_error = ? WHERE id = ?', [error.message.substring(0, 200), page.id]);
                    }
                }

                await sleep(PAUSE_MS);
            }
        }

        console.log(`[${new Date().toLocaleTimeString()}] Worker: Завершен. Обработано: ${processedCount}`);

    } catch (err) {
        console.error('[Worker] Фатальная ошибка:', err);
    } finally {
        if (db) await db.end();
    }
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

runWorker();