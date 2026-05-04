const express = require('express');
const router = express.Router();
const axios = require('axios');
const cheerio = require('cheerio');
const { SITE_HTML_USER_AGENT, fetchHtmlForSiteParse, fetchDiscoverText } = require('../lib/datagonSiteFetch');
const { resolveFetchProxy, ensureProjectFetchProxyColumns } = require('../lib/datagonFetchProxy');
const { assertHtmlNotWafChallenge, hasGenericProductSignals } = require('../lib/datagonPageClassify');

module.exports = (db, settings) => {
    ensureProjectFetchProxyColumns(db).catch(() => {});
    let queueWorkerRunning = false;
    let queueTickBusy = false;
    let pagesAddedFromReady = false;
    let pagesAddedAtReady = false;
    let pagesStatusReady = false;
    let pagesQueryCleanupDone = false;
    let discoverySchemaReady = false;
    const activeDiscoveryRunIds = new Map();
    const discoveryJobs = new Map();
    let pagesQueueIndexReady = false;

    /** Индекс для массовых reset/clear и выборки pending по проекту (снижает нагрузку на MySQL). */
    async function ensurePagesQueueIndex() {
        if (pagesQueueIndexReady) return;
        try {
            const [rows] = await db.query(`
                SELECT COUNT(*) AS cnt
                FROM information_schema.STATISTICS
                WHERE TABLE_SCHEMA = DATABASE()
                  AND TABLE_NAME = 'pages'
                  AND INDEX_NAME = 'idx_pages_project_status'
            `);
            if (!rows[0]?.cnt) {
                await db.query('CREATE INDEX idx_pages_project_status ON pages (project_id, status)');
            }
        } catch (_) {
            // нет прав / уже есть под другим именем — не блокируем работу
        }
        pagesQueueIndexReady = true;
    }

    async function ensurePagesAddedFromColumn() {
        if (pagesAddedFromReady) return;
        try {
            const [cols] = await db.query("SHOW COLUMNS FROM pages LIKE 'added_from'");
            if (!cols.length) {
                await db.query("ALTER TABLE pages ADD COLUMN added_from VARCHAR(50) NOT NULL DEFAULT 'Ручной'");
            }
            pagesAddedFromReady = true;
        } catch (_) {}
    }

    async function ensurePagesAddedAtColumn() {
        if (pagesAddedAtReady) return;
        try {
            const [cols] = await db.query("SHOW COLUMNS FROM pages LIKE 'added_at'");
            if (!cols.length) {
                await db.query("ALTER TABLE pages ADD COLUMN added_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP AFTER added_from");
            }
            try {
                await db.query("UPDATE pages SET added_at = COALESCE(parsed_at, NOW()) WHERE added_at IS NULL");
            } catch (_) {}
            pagesAddedAtReady = true;
        } catch (_) {}
    }

    async function ensurePagesStatusColumnSupportsSitemap() {
        if (pagesStatusReady) return;
        try {
            const [cols] = await db.query("SHOW COLUMNS FROM pages LIKE 'status'");
            if (cols.length) {
                const col = cols[0];
                const type = String(col.Type || '').toLowerCase();
                if (type.startsWith('enum(') && !type.includes("'sitemap'")) {
                    await db.query("ALTER TABLE pages MODIFY COLUMN status VARCHAR(20) NOT NULL DEFAULT 'pending'");
                }
            }
            await db.query("UPDATE pages SET status = 'sitemap' WHERE (status = '' OR status IS NULL) AND added_from IN ('Sitemap','Ссылка со стр.')");
            pagesStatusReady = true;
        } catch (_) {}
    }

    async function cleanupDiscoveredUrlsWithQuery() {
        if (pagesQueryCleanupDone) return;
        try {
            await db.query(`
                DELETE FROM pages
                WHERE url LIKE '%?%'
                  AND added_from IN ('Sitemap', 'Ссылка со стр.')
            `);
            pagesQueryCleanupDone = true;
        } catch (_) {}
    }

    /** Один батч-запрос вместо коррелированного EXISTS в SELECT по каждой строке (очередь на больших таблицах). */
    async function attachPageMatchedFlags(rows) {
        if (!Array.isArray(rows) || rows.length === 0) return;
        const pairs = [];
        const seen = new Set();
        for (const row of rows) {
            const pid = Number(row.project_id);
            const url = String(row.url ?? '');
            if (!Number.isFinite(pid) || !url) {
                row.is_matched = 0;
                continue;
            }
            const key = JSON.stringify([pid, url]);
            if (seen.has(key)) continue;
            seen.add(key);
            pairs.push([pid, url]);
        }
        if (!pairs.length) return;
        const matched = new Set();
        const chunkSize = 50;
        for (let i = 0; i < pairs.length; i += chunkSize) {
            const slice = pairs.slice(i, i + chunkSize);
            const placeholders = slice.map(() => '(?, ?)').join(', ');
            const flat = slice.flat();
            const [mrows] = await db.query(
                `
                SELECT DISTINCT pr.project_id, pr.url
                FROM prices pr
                INNER JOIN product_matches pm ON pm.status = 'confirmed'
                    AND pm.competitor_site_id = pr.project_id
                    AND (
                        (pm.competitor_sku IS NOT NULL AND pm.competitor_sku <> '' AND pm.competitor_sku = pr.sku)
                        OR pm.competitor_name = pr.product_name
                    )
                WHERE (pr.project_id, pr.url) IN (${placeholders})
                `,
                flat
            );
            for (const m of mrows || []) {
                matched.add(JSON.stringify([Number(m.project_id), String(m.url ?? '')]));
            }
        }
        for (const row of rows) {
            const pid = Number(row.project_id);
            const url = String(row.url ?? '');
            row.is_matched =
                Number.isFinite(pid) && url && matched.has(JSON.stringify([pid, url])) ? 1 : 0;
        }
    }

    async function ensureDiscoverySchema() {
        if (discoverySchemaReady) return;
        try {
            await db.query(`
                CREATE TABLE IF NOT EXISTS discovery_jobs (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    project_id INT NOT NULL,
                    status VARCHAR(20) NOT NULL DEFAULT 'running',
                    started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    finished_at TIMESTAMP NULL,
                    discovered INT NOT NULL DEFAULT 0,
                    added INT NOT NULL DEFAULT 0,
                    added_sitemap INT NOT NULL DEFAULT 0,
                    added_from_page INT NOT NULL DEFAULT 0,
                    message TEXT,
                    source VARCHAR(50),
                    errors_json LONGTEXT,
                    cancel_requested TINYINT(1) NOT NULL DEFAULT 0,
                    resumed_after_restart TINYINT(1) NOT NULL DEFAULT 0,
                    INDEX idx_discovery_project (project_id, id),
                    INDEX idx_discovery_status (status)
                )
            `);
            try {
                const [c1] = await db.query("SHOW COLUMNS FROM discovery_jobs LIKE 'added_sitemap'");
                if (!c1.length) await db.query('ALTER TABLE discovery_jobs ADD COLUMN added_sitemap INT NOT NULL DEFAULT 0');
            } catch (_) {}
            try {
                const [c2] = await db.query("SHOW COLUMNS FROM discovery_jobs LIKE 'added_from_page'");
                if (!c2.length) await db.query('ALTER TABLE discovery_jobs ADD COLUMN added_from_page INT NOT NULL DEFAULT 0');
            } catch (_) {}
            discoverySchemaReady = true;
        } catch (_) {}
    }

    async function persistDiscoveryProgress(projectId, job, forceFinish = false) {
        try {
            await ensureDiscoverySchema();
            let runId = activeDiscoveryRunIds.get(Number(projectId));
            if (!runId) {
                const [ridRows] = await db.query(
                    'SELECT id FROM discovery_jobs WHERE project_id = ? ORDER BY id DESC LIMIT 1',
                    [projectId]
                );
                if (ridRows.length) runId = Number(ridRows[0].id);
            }
            if (!runId) return;
            const errorsJson = JSON.stringify(Array.isArray(job?.errors) ? job.errors.slice(0, 20) : []);
            if (forceFinish || !job?.active) {
                await db.query(
                    `UPDATE discovery_jobs
                     SET status = ?, finished_at = NOW(), discovered = ?, added = ?, added_sitemap = ?, added_from_page = ?, message = ?, source = ?, errors_json = ?, cancel_requested = ?
                     WHERE id = ?`,
                    [
                        job?.cancel_requested ? 'cancelled' : ((job?.message || '').startsWith('Ошибка:') ? 'failed' : 'completed'),
                        Number(job?.discovered || 0),
                        Number(job?.added || 0),
                        Number(job?.added_sitemap || 0),
                        Number(job?.added_from_page || 0),
                        String(job?.message || ''),
                        String(job?.source || ''),
                        errorsJson,
                        job?.cancel_requested ? 1 : 0,
                        runId
                    ]
                );
            } else {
                await db.query(
                    `UPDATE discovery_jobs
                     SET discovered = ?, added = ?, added_sitemap = ?, added_from_page = ?, message = ?, source = ?, errors_json = ?, cancel_requested = ?
                     WHERE id = ?`,
                    [
                        Number(job?.discovered || 0),
                        Number(job?.added || 0),
                        Number(job?.added_sitemap || 0),
                        Number(job?.added_from_page || 0),
                        String(job?.message || ''),
                        String(job?.source || ''),
                        errorsJson,
                        job?.cancel_requested ? 1 : 0,
                        runId
                    ]
                );
            }
        } catch (_) {}
    }
    function normalizeText(v) {
        return String(v || '')
            .toLowerCase()
            .replace(/\s+/g, ' ')
            .trim();
    }

    function getPrimaryProductText($) {
        const sectionSelectors = [
            '.product-card', '.product-detail', '.product-page', '.catalog-detail',
            '.detail', '.item-detail', '.bx_catalog_item', 'main'
        ];
        for (const s of sectionSelectors) {
            const txt = normalizeText($(s).first().text());
            if (txt && txt.length >= 80) {
                // Отсекаем зоны рекомендаций, где часто есть чужие статусы наличия.
                return txt
                    .split('похожие товары')[0]
                    .split('с этим товаром покупают')[0]
                    .split('рекомендуем')[0]
                    .trim();
            }
        }
        const bodyTxt = normalizeText($('body').text());
        return bodyTxt
            .split('похожие товары')[0]
            .split('с этим товаром покупают')[0]
            .split('рекомендуем')[0]
            .trim();
    }

    function detectOosByText($, selectorOos) {
        const heuristics = [
            /ожида[её]тся поставк/i,
            /нет в наличии/i,
            /под заказ/i
        ];
        const tokens = String(selectorOos || '')
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean);
        const textRules = tokens
            .filter((t) => t.toLowerCase().startsWith('text:'))
            .map((t) => t.slice(5).trim())
            .filter(Boolean);

        const targetText = getPrimaryProductText($);

        for (const rule of textRules) {
            const escaped = rule.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            if (new RegExp(escaped, 'i').test(targetText)) return true;
        }
        return heuristics.some((re) => re.test(targetText));
    }

    function detectHardOosByText($) {
        const targetText = getPrimaryProductText($);
        const hardOosSignals = [
            /ожида[её]тся поставк/i,
            /нет в наличии/i,
            /под заказ/i
        ];
        return hardOosSignals.some((re) => re.test(targetText));
    }

    function detectInStockByText($) {
        const targetText = getPrimaryProductText($);
        const inStockSignals = [
            /в наличии(?:\s+\d+)?(?:\s+шт\.?)?/i,
            /в наличии много/i,
            /в корзин/i,
            /добавить в корзин/i,
            /купить/i
        ];
        return inStockSignals.some((re) => re.test(targetText));
    }

    function extractPriceFromTextFallback($) {
        const targetText = getPrimaryProductText($);
        const matches = [];
        const re = /(\d[\d\s]{1,14})\s*₽/g;
        let m;
        while ((m = re.exec(targetText)) !== null) {
            const raw = String(m[1] || '').replace(/\s+/g, '');
            const n = Number(raw);
            if (Number.isFinite(n) && n > 0) matches.push(n);
        }
        if (!matches.length) return NaN;
        // Обычно в карточке сначала старая цена, потом текущая; берем минимальную валидную.
        return Math.min(...matches);
    }

    function detectPageType($, pageUrl, pr, hasPriceSignal, hasOosSignal, hasInStockSignal, html) {
        const url = String(pageUrl || '').toLowerCase();
        const nameSelectors = String(pr?.selector_name || 'h1')
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean);
        let hasProductHeading = false;
        for (const s of nameSelectors) {
            const txt = String($(s).first().text() || '').trim();
            if (txt.length >= 3) {
                hasProductHeading = true;
                break;
            }
        }
        const ogTypes = [];
        $('meta[property="og:type"]').each((_, el) => {
            const v = String($(el).attr('content') || '')
                .trim()
                .toLowerCase();
            if (v) ogTypes.push(v);
        });
        // Не брать только .first(): на части шаблонов первым идёт website, вторым — product.
        const ogType = ogTypes.includes('product') ? 'product' : ogTypes[0] || '';
        const hasProductSchema =
            ogType === 'product' ||
            $('[itemtype*="Product"]').length > 0 ||
            $('[itemprop="price"]').length > 0;

        const hasListSignals =
            $('.catalog-grid, .news-list, .item_list, .products-list, .product-list, .catalog-list').length > 0 ||
            $('[class*="catalog"][class*="list"]').length > 0 ||
            $('[class*="product"][class*="list"]').length > 0;

        const looksLikeCatalogUrl = /\/catalog|\/category|\/search|\/collection|\/brands?\//i.test(url);

        if (!hasListSignals && !looksLikeCatalogUrl && hasGenericProductSignals($, String(html || ''))) {
            return 'product';
        }

        // Жесткий приоритет: явная карточка товара.
        if (hasProductSchema && (hasProductHeading || hasPriceSignal || hasInStockSignal || hasOosSignal)) {
            return 'product';
        }

        // Листинги/категории с множеством цен не должны считаться карточкой.
        if (hasListSignals || looksLikeCatalogUrl) {
            return 'category';
        }

        // Мягкий приоритет карточки: есть признаки товара + заголовок.
        if ((hasPriceSignal || hasOosSignal || hasInStockSignal) && hasProductHeading) {
            return 'product';
        }

        return 'info';
    }

    
    // Вспомогательная функция парсинга (внутри замыкания, чтобы видеть db и settings)
    async function runParser(pageRow) {
        await ensurePagesAddedFromColumn();
        await ensurePagesAddedAtColumn();
        await ensurePagesStatusColumnSupportsSitemap();
        await db.query('UPDATE pages SET status = "processing" WHERE id = ?', [pageRow.id]);
        
        if (settings.page_delay_ms > 0) {
            const jitter = Math.floor(Math.random() * 250);
            await new Promise((r) => setTimeout(r, Number(settings.page_delay_ms) + jitter));
        }

        try {
            const [proj] = await db.query('SELECT * FROM projects WHERE id = ?', [pageRow.project_id]);
            if (!proj.length) throw new Error('Project not found');
            const pr = proj[0];

            const html = await fetchHtmlForSiteParse(axios, pageRow.url, {
                timeout: 22000,
                proxy: resolveFetchProxy(pr, settings)
            });
            assertHtmlNotWafChallenge(html);
            const $ = cheerio.load(html);
            try {
                const pageHost = new URL(pageRow.url).hostname;
                const links = extractInternalHtmlPhpLinks($, pageRow.url, pageHost);
                if (links.length) {
                    const ins = await addUrlsWithoutDuplicates(pageRow.project_id, links, 'sitemap', 'Ссылка со стр.');
                    if (Number(ins?.added || 0) > 0) {
                        const activeJob = discoveryJobs.get(Number(pageRow.project_id));
                        if (activeJob && activeJob.active) {
                            activeJob.added_from_page = Number(activeJob.added_from_page || 0) + Number(ins.added || 0);
                            activeJob.added = Number(activeJob.added_sitemap || 0) + Number(activeJob.added_from_page || 0);
                            discoveryJobs.set(Number(pageRow.project_id), activeJob);
                        }
                    }
                }
            } catch (_) {}
            
            let type = 'product';
            let priceTxt = '';
            for (let s of pr.selector_price.split(',')) { 
                priceTxt = $(s.trim()).first().text().trim(); 
                if(priceTxt) break; 
            }
            let price = priceTxt
                ? parseFloat(
                      String(priceTxt)
                          .replace(/[\s\u00A0\u202F]/g, '')
                          .replace(/[^0-9,.]/g, '')
                          .replace(',', '.')
                  )
                : NaN;
            if (isNaN(price) || Number(price) <= 0) {
                const fallbackPrice = extractPriceFromTextFallback($);
                if (!isNaN(fallbackPrice) && fallbackPrice > 0) price = fallbackPrice;
            }
            const hasPrice = !isNaN(price) && Number(price) > 0;
            const oosSelectors = String(pr.selector_oos || '')
                .split(',')
                .map((s) => s.trim())
                .filter((s) => s && !s.toLowerCase().startsWith('text:'));
            const hasOosBySelector = oosSelectors.some((s) => $(s).length > 0);
            const hasOosByText = detectOosByText($, pr.selector_oos);
            const hasHardOosByText = detectHardOosByText($);
            const hasInStockByText = detectInStockByText($);
            // Приоритет для текущего режима:
            // 1) Если есть валидная цена — считаем "в наличии" (цена важнее).
            // 2) Иначе если есть in-stock сигнал — "в наличии".
            // 3) Иначе учитываем OOS сигналы.
            const hasOos = hasPrice
                ? false
                : (hasInStockByText ? false : (hasHardOosByText || hasOosBySelector || hasOosByText));
            
            type = detectPageType($, pageRow.url, pr, hasPrice, hasOos, hasInStockByText, html);
            
            await db.query('UPDATE pages SET page_type = ? WHERE id = ?', [type, pageRow.id]);
            
            if (type !== 'product') { 
                await db.query('UPDATE pages SET status = "done", parsed_at = NOW() WHERE id = ?', [pageRow.id]); 
                return; 
            }

            let name = '';
            for (let s of pr.selector_name.split(',')) { 
                name = $(s.trim()).first().text().trim(); 
                if(name) break; 
            }
            
            let sku = '';
            for (let s of pr.selector_sku.split(',')) { 
                sku = $(s.trim()).first().text().trim(); 
                if(sku) break; 
            }
            if(!sku) sku = $('meta[itemprop="productID"]').attr('content')||'';

            if (hasOos) {
                await db.query('INSERT INTO prices (project_id, page_id, sku, product_name, price, is_oos, url) VALUES (?,?,?,?,?,1,?)', [pageRow.project_id, pageRow.id, sku, name, null, pageRow.url]);
            } else if (!isNaN(price)) {
                await db.query('INSERT INTO prices (project_id, page_id, sku, product_name, price, is_oos, url) VALUES (?,?,?,?,?,0,?)', [pageRow.project_id, pageRow.id, sku, name, price, pageRow.url]);
            } else {
                throw new Error('No price and no OOS status');
            }
            
            await db.query('UPDATE pages SET status = "done", parsed_at = NOW() WHERE id = ?', [pageRow.id]);
        } catch (e) {
            const msg = String((e && e.message) || e || '');
            const retryLater =
                /\b403\b|\b429\b|\b401\b|ECONNRESET|ETIMEDOUT|ECONNABORTED|ENOTFOUND|socket hang up/i.test(msg);
            if (retryLater) {
                await db.query('UPDATE pages SET status = "pending", last_error = ?, parsed_at = NOW() WHERE id = ?', [
                    msg.substring(0, 255),
                    pageRow.id
                ]);
            } else {
                await db.query('UPDATE pages SET status = "error", last_error = ?, parsed_at = NOW() WHERE id = ?', [
                    msg.substring(0, 255),
                    pageRow.id
                ]);
            }
        }
    }

    async function processPendingQueueTick() {
        if (queueTickBusy) return;
        queueTickBusy = true;
        try {
            await ensurePagesQueueIndex();
            await ensurePagesAddedFromColumn();
            await ensurePagesAddedAtColumn();
            await ensurePagesStatusColumnSupportsSitemap();
            await cleanupDiscoveredUrlsWithQuery();
            const batchSize = Math.max(1, Number(settings.parse_batch_size || 10));
            await db.query(
                'UPDATE pages SET status = "pending" WHERE id IN (SELECT id FROM (SELECT id FROM pages WHERE status = "sitemap" ORDER BY id ASC LIMIT ?) t)',
                [batchSize]
            );
            const [rows] = await db.query(
                'SELECT * FROM pages WHERE status = "pending" ORDER BY id ASC LIMIT ?',
                [batchSize]
            );
            if (!rows.length) return;
            for (const pg of rows) {
                const [claim] = await db.query(
                    'UPDATE pages SET status = "processing" WHERE id = ? AND status = "pending"',
                    [pg.id]
                );
                if (!claim?.affectedRows) continue;
                await runParser(pg);
            }
        } catch (e) {
            console.error('[PAGES QUEUE] tick error:', e.message);
        } finally {
            queueTickBusy = false;
        }
    }

    function startQueueWorker() {
        if (queueWorkerRunning) return;
        queueWorkerRunning = true;
        // Небольшой интервал: очередь двигается сама без ручного "Парсить видимые".
        setInterval(() => {
            processPendingQueueTick().catch(() => {});
        }, 3000);
    }

    function readXmlLocs(xml) {
        const out = [];
        const re = /<loc>([\s\S]*?)<\/loc>/gi;
        let m;
        while ((m = re.exec(String(xml || ''))) !== null) {
            const val = String(m[1] || '').trim();
            if (val) out.push(val);
        }
        return out;
    }

    /** OpenCart / аналоги: вложенные sitemap-фиды без query не открываются (остаётся только /index.php). */
    function isFeedOrSitemapQuery(search) {
        const s = String(search || '').toLowerCase();
        return s.includes('route=feed') || s.includes('route=extension/feed');
    }

    function normalizeDiscoverUrl(raw, host) {
        try {
            const u = new URL(raw);
            const normalizeHost = (v) => String(v || '').toLowerCase().replace(/^www\./, '');
            if (normalizeHost(u.hostname) !== normalizeHost(host)) return '';
            u.hostname = normalizeHost(u.hostname);
            u.hash = '';
            // Убираем query, кроме фидов sitemap (иначе теряется route=feed/...).
            if (!isFeedOrSitemapQuery(u.search)) u.search = '';
            u.pathname = u.pathname.replace(/\/{2,}/g, '/');
            if (u.pathname.length > 1) u.pathname = u.pathname.replace(/\/$/, '');
            return u.toString();
        } catch (_) {
            return '';
        }
    }

    /** ЧПУ карточки без .html (например stomshop.pro/c1023-nsk-...) — добор при обходе с главной. */
    function isLikelySeoProductSlugPath(urlStr) {
        try {
            const u = new URL(urlStr);
            if (String(u.search || '')) return false;
            const path = String(u.pathname || '')
                .replace(/\/{2,}/g, '/')
                .replace(/^\/+|\/+$/g, '');
            const seg = path.split('/');
            if (seg.length !== 1) return false;
            const slug = seg[0];
            if (slug.length < 5 || slug.length > 220) return false;
            if (!/[0-9]/.test(slug)) return false;
            return /^[a-z0-9_-]+$/i.test(slug);
        } catch (_) {
            return false;
        }
    }

    function isDiscoverableHtmlPath(urlStr) {
        const low = String(urlStr || '').toLowerCase();
        if (/\.(html?|php)([?#].*)?$/i.test(low) || low.endsWith('/')) return true;
        return isLikelySeoProductSlugPath(urlStr);
    }

    function shouldSkipDiscoverPath(urlStr) {
        const bad = [
            '/cart', '/basket', '/checkout', '/login', '/auth', '/account',
            '/cabinet', '/compare', '/favorites', '/search', '/api/', '/ajax/'
        ];
        return bad.some((p) => urlStr.toLowerCase().includes(p));
    }

    function normalizeQueueUrl(raw) {
        try {
            const u = new URL(String(raw || '').trim());
            if (!/^https?:$/i.test(String(u.protocol || ''))) return '';
            // Не добавляем динамические страницы с query-параметрами.
            if (String(u.search || '')) return '';
            u.hostname = String(u.hostname || '').toLowerCase().replace(/^www\./, '');
            u.hash = '';
            u.pathname = u.pathname.replace(/\/{2,}/g, '/');
            if (u.pathname.length > 1) u.pathname = u.pathname.replace(/\/$/, '');
            return u.toString();
        } catch (_) {
            return '';
        }
    }

    async function addUrlsWithoutDuplicates(projectId, urls, status = 'sitemap', addedFrom = 'Sitemap') {
        await ensurePagesAddedFromColumn();
        await ensurePagesAddedAtColumn();
        const uniq = Array.from(new Set((urls || []).map((u) => String(u || '').trim()).filter(Boolean)));
        if (!uniq.length) return { added: 0, total: 0 };
        const existing = new Set();
        const chunkSize = 500;
        for (let i = 0; i < uniq.length; i += chunkSize) {
            const chunk = uniq.slice(i, i + chunkSize);
            const placeholders = chunk.map(() => '?').join(',');
            const [rows] = await db.query(
                `SELECT url FROM pages WHERE project_id = ? AND url IN (${placeholders})`,
                [projectId, ...chunk]
            );
            rows.forEach((r) => existing.add(String(r.url || '')));
        }
        const toInsert = uniq.filter((u) => !existing.has(u));
        if (!toInsert.length) return { added: 0, total: uniq.length };
        const vals = toInsert.map((u) => [projectId, u, status, 'unknown', addedFrom]);
        await db.query('INSERT INTO pages (project_id, url, status, page_type, added_from) VALUES ?', [vals]);
        return { added: toInsert.length, total: uniq.length };
    }

    function extractInternalHtmlPhpLinks($, baseUrl, host) {
        const out = new Set();
        $('a[href]').each((_, el) => {
            const href = String($(el).attr('href') || '').trim();
            if (!href) return;
            let abs = '';
            try {
                abs = new URL(href, baseUrl).toString();
            } catch (_) {
                return;
            }
            const n = normalizeDiscoverUrl(abs, host);
            if (!n || shouldSkipDiscoverPath(n)) return;
            if (!isDiscoverableHtmlPath(n)) return;
            out.add(n);
        });
        return Array.from(out);
    }

    /** См. lib/datagonSiteFetch.js — тот же UA, что и у парсера очереди / worker. */
    const DISCOVERY_USER_AGENTS = [SITE_HTML_USER_AGENT];

    function formatDiscoverFetchError(status, err) {
        const hint = status ? `HTTP ${status}` : (err && err.code) || '';
        let msg = [hint, err && err.message].filter(Boolean).join(' ').trim();
        if (status === 403 || status === 401) {
            msg +=
                ' — часто это антибот/WAF или блокировка IP сервера; с сервера Datagon сайт может быть недоступен, даже если в браузере открывается. Варианты: разрешить IP сервера у хостинга, отключить жёсткий антибот для robots/sitemap или добавить URL вручную.';
        }
        return new Error(msg);
    }

    const DISCOVERY_CANCELLED = 'DISCOVERY_CANCELLED';

    function isAbortLikeError(e) {
        if (!e) return false;
        if (e.code === 'ERR_CANCELED') return true;
        if (e.name === 'CanceledError' || e.name === 'AbortError') return true;
        return false;
    }

    /** HTTP GET автообхода: lib/datagonSiteFetch (UA + при необходимости ротация HTTP-прокси из настроек). */
    async function fetchTextSafe(url, timeout = 15000, opts = {}) {
        const proxy = opts.proxy || {
            enabled: Number(settings.fetch_proxy_enabled) === 1,
            list: settings.fetch_proxy_list || ''
        };
        const ac = new AbortController();
        let poll = null;
        if (typeof opts.isCancelled === 'function') {
            poll = setInterval(() => {
                try {
                    if (opts.isCancelled()) ac.abort();
                } catch (_) {}
            }, 200);
        }
        try {
            return await fetchDiscoverText(axios, url, timeout, {
                kind: opts.kind || 'html',
                referer: opts.referer,
                stickySession: opts.stickySession || null,
                userAgents: DISCOVERY_USER_AGENTS,
                proxy,
                signal: typeof opts.isCancelled === 'function' ? ac.signal : undefined
            });
        } catch (e) {
            if (isAbortLikeError(e)) {
                const x = new Error('Остановка автообхода');
                x.code = DISCOVERY_CANCELLED;
                throw x;
            }
            const st = e && e.response && e.response.status;
            throw formatDiscoverFetchError(st, e);
        } finally {
            if (poll) clearInterval(poll);
        }
    }

    /** Для автообхода: в UI показывается «имя» проекта, в БД иногда пустой domain — берём name как хост. */
    function pickDiscoveryHostFromProjectRow(row) {
        if (!row) return '';
        let raw = String(row.domain || '').trim();
        if (!raw) raw = String(row.name || '').trim();
        raw = raw.replace(/^https?:\/\//i, '').trim();
        const slash = raw.indexOf('/');
        if (slash > 0) raw = raw.slice(0, slash);
        return raw.replace(/\/+$/, '').trim();
    }

    async function runDiscovery(projectId, domain) {
        await ensurePagesAddedFromColumn();
        await ensurePagesAddedAtColumn();
        await ensurePagesStatusColumnSupportsSitemap();
        await cleanupDiscoveredUrlsWithQuery();
        await ensureDiscoverySchema();
        const host = String(domain || '')
            .trim()
            .replace(/^https?:\/\//i, '')
            .replace(/\/+$/, '')
            .split('/')[0]
            .trim();
        const baseUrl = host ? `https://${host}` : '';
        const job = {
            active: true,
            cancel_requested: false,
            started_at: new Date().toISOString(),
            finished_at: null,
            message: 'Запуск...',
            discovered: 0,
            added: 0,
            added_sitemap: 0,
            added_from_page: 0,
            source: 'robots+sitemaps',
            errors: []
        };
        discoveryJobs.set(projectId, job);
        try {
            const [ins] = await db.query(
                'INSERT INTO discovery_jobs (project_id, status, message, source) VALUES (?, "running", ?, ?)',
                [projectId, job.message, job.source]
            );
            activeDiscoveryRunIds.set(Number(projectId), Number(ins.insertId));
        } catch (_) {}
        const discovered = new Set();
        const pendingFlush = new Set();
        let addedTotal = 0;

        async function flushPendingDiscovered() {
            if (!pendingFlush.size) return;
            const batch = Array.from(pendingFlush);
            pendingFlush.clear();
            const saveResult = await addUrlsWithoutDuplicates(projectId, batch, 'sitemap', 'Sitemap');
            addedTotal += Number(saveResult?.added || 0);
            job.added_sitemap = addedTotal;
            job.added = Number(job.added_sitemap || 0) + Number(job.added_from_page || 0);
        }

        try {
            if (!host) {
                job.message = 'Ошибка: не удалось определить хост сайта. Заполните в проекте поле «Домен» (например stomshop.pro).';
                job.errors.push('Пустой домен: в карточке проекта укажите домен без https://');
                await persistDiscoveryProgress(projectId, job, true);
                return;
            }
            const [projForProxy] = await db.query(
                'SELECT id, fetch_proxy_mode, fetch_proxy_enabled, fetch_proxy_list FROM projects WHERE id = ?',
                [projectId]
            );
            const discoveryProxyOpt = resolveFetchProxy(projForProxy[0] || {}, settings);
            const maxSitemaps = Math.max(10, Number(settings.discover_max_sitemaps || 200));
            const maxUrls = Math.max(100, Number(settings.discover_max_urls || 50000));
            const crawlMaxPages = Math.max(10, Number(settings.discover_crawl_max_pages || 500));
            const requestDelayMs = Math.max(0, Number(settings.discover_request_delay_ms || 100));
            async function discoverPace() {
                if (job.cancel_requested) return;
                if (requestDelayMs > 0) {
                    const jitter = Math.floor(Math.random() * Math.min(500, requestDelayMs + 120));
                    await new Promise((r) => setTimeout(r, requestDelayMs + jitter));
                } else {
                    await new Promise((r) => setTimeout(r, 50 + Math.floor(Math.random() * 180)));
                }
            }
            /** Один раз удачный UA — дальше весь запуск только им (robots → sitemap → crawl). */
            const discoveryUaSession = { ua: null };
            const sitemapQueue = [];
            const seenSitemaps = new Set();

            job.message = 'Читаю robots.txt...';
            await persistDiscoveryProgress(projectId, job);
            try {
                const robots = await fetchTextSafe(`${baseUrl}/robots.txt`, 10000, {
                    kind: 'robots',
                    stickySession: discoveryUaSession,
                    isCancelled: () => job.cancel_requested,
                    proxy: discoveryProxyOpt
                });
                const lines = robots.split(/\r?\n/).map((l) => l.trim());
                lines.forEach((line) => {
                    if (/^sitemap:/i.test(line)) {
                        const sm = line.split(':').slice(1).join(':').trim();
                        if (sm) sitemapQueue.push(sm);
                    }
                });
            } catch (e) {
                if (e && e.code === DISCOVERY_CANCELLED) throw e;
                job.errors.push(`robots: ${e.message}`);
            }
            if (!sitemapQueue.length) {
                sitemapQueue.push(`${baseUrl}/sitemap.xml`);
                job.source = 'fallback-sitemap+xml-crawl';
            }

            job.message = 'Обрабатываю sitemap...';
            await persistDiscoveryProgress(projectId, job);
            let sitemapGuard = 0;
            while (sitemapQueue.length && sitemapGuard < maxSitemaps && discovered.size < maxUrls) {
                if (job.cancel_requested) {
                    job.message = 'Остановлено пользователем';
                    break;
                }
                sitemapGuard += 1;
                const smUrl = sitemapQueue.shift();
                if (!smUrl || seenSitemaps.has(smUrl)) continue;
                seenSitemaps.add(smUrl);
                try {
                    const xml = await fetchTextSafe(smUrl, 15000, {
                        kind: 'sitemap',
                        stickySession: discoveryUaSession,
                        isCancelled: () => job.cancel_requested,
                        proxy: discoveryProxyOpt
                    });
                    const locs = readXmlLocs(xml);
                    for (const loc of locs) {
                        if (discovered.size >= maxUrls) break;
                        const n = normalizeDiscoverUrl(loc, host);
                        if (!n) continue;
                        if (/\.(xml)(\?.*)?$/i.test(n)) sitemapQueue.push(n);
                        else if (!shouldSkipDiscoverPath(n)) {
                            if (!discovered.has(n)) {
                                discovered.add(n);
                                pendingFlush.add(n);
                                job.discovered = discovered.size;
                                if (pendingFlush.size >= 500) {
                                    await flushPendingDiscovered();
                                    await persistDiscoveryProgress(projectId, job);
                                }
                            }
                        }
                    }
                    await discoverPace();
                } catch (e) {
                    if (e && e.code === DISCOVERY_CANCELLED) throw e;
                    job.errors.push(`sitemap ${smUrl}: ${e.message}`);
                }
            }

            // Всегда добираем внутренние ссылки (не только fallback), чтобы не ограничиваться sitemap.
            if (discovered.size < maxUrls) {
                job.message = 'Обхожу внутренние ссылки...';
                await persistDiscoveryProgress(projectId, job);
                const q = [`${baseUrl}/`];
                const seen = new Set();
                let depthGuard = 0;
                let crawlReferer = `${baseUrl}/`;
                let crawlErrorLines = 0;
                const maxCrawlErrorLines = 35;
                let crawlErrorsTruncated = false;
                while (q.length && depthGuard < crawlMaxPages && discovered.size < maxUrls) {
                    if (job.cancel_requested) {
                        job.message = 'Остановлено пользователем';
                        break;
                    }
                    depthGuard += 1;
                    const url = q.shift();
                    if (!url || seen.has(url)) continue;
                    seen.add(url);
                    try {
                        const html = await fetchTextSafe(url, 12000, {
                            kind: 'html',
                            referer: crawlReferer,
                            stickySession: discoveryUaSession,
                            isCancelled: () => job.cancel_requested,
                            proxy: discoveryProxyOpt
                        });
                        crawlReferer = url;
                        const $ = cheerio.load(html);
                        $('a[href]').each((_, el) => {
                            const href = String($(el).attr('href') || '').trim();
                            if (!href) return;
                            let abs = '';
                            try {
                                abs = new URL(href, url).toString();
                            } catch (_) {
                                return;
                            }
                            const n = normalizeDiscoverUrl(abs, host);
                            if (!n || shouldSkipDiscoverPath(n)) return;
                            if (!isDiscoverableHtmlPath(n)) return;
                            if (!discovered.has(n)) {
                                discovered.add(n);
                                pendingFlush.add(n);
                                job.discovered = discovered.size;
                            }
                            if (discovered.size >= maxUrls) return;
                            if (!seen.has(n) && q.length < 2000) q.push(n);
                        });
                        if (pendingFlush.size >= 500) {
                            await flushPendingDiscovered();
                            await persistDiscoveryProgress(projectId, job);
                        }
                        await discoverPace();
                    } catch (eCrawl) {
                        if (eCrawl && eCrawl.code === DISCOVERY_CANCELLED) throw eCrawl;
                        const msg = eCrawl && eCrawl.message ? String(eCrawl.message) : String(eCrawl);
                        if (crawlErrorLines < maxCrawlErrorLines) {
                            job.errors.push(`crawl ${url}: ${msg}`);
                            crawlErrorLines += 1;
                        } else if (!crawlErrorsTruncated) {
                            crawlErrorsTruncated = true;
                            job.errors.push(
                                'crawl: дальнейшие ошибки обхода не записаны (лимит строк); типично массовый 403 на карточках при уже собранном sitemap.'
                            );
                        }
                    }
                }
            }

            job.discovered = discovered.size;
            if (job.cancel_requested) {
                await flushPendingDiscovered();
                job.message = `Остановлено. Найдено: ${job.discovered}, добавлено новых: ${job.added}`;
                await persistDiscoveryProgress(projectId, job, true);
                return;
            }
            job.message = `Сохраняю URL (${discovered.size})...`;
            await flushPendingDiscovered();
            await persistDiscoveryProgress(projectId, job);
            await db.query('UPDATE pages SET status = "pending" WHERE project_id = ? AND status = "sitemap"', [projectId]);
            job.message = `Готово. Найдено: ${job.discovered}, добавлено новых: ${job.added}`;
            await persistDiscoveryProgress(projectId, job, true);
        } catch (e) {
            if (e && e.code === DISCOVERY_CANCELLED) {
                job.cancel_requested = true;
                job.discovered = discovered.size;
                await flushPendingDiscovered();
                job.message = `Остановлено. Найдено: ${job.discovered}, добавлено новых: ${job.added}`;
                await persistDiscoveryProgress(projectId, job, true);
            } else {
                job.message = `Ошибка: ${e.message}`;
                job.errors.push(e.message);
                await persistDiscoveryProgress(projectId, job, true);
            }
        } finally {
            job.active = false;
            job.finished_at = new Date().toISOString();
            discoveryJobs.set(projectId, job);
            await persistDiscoveryProgress(projectId, job, true);
            activeDiscoveryRunIds.delete(Number(projectId));
        }
    }

    // 1. Список страниц (Очередь) - ДОБАВЛЕН ПОИСК ПО URL
    router.get('/', async (req, res) => {
        try {
            await Promise.all([
                ensurePagesAddedFromColumn(),
                ensurePagesAddedAtColumn(),
                ensurePagesStatusColumnSupportsSitemap(),
                cleanupDiscoveredUrlsWithQuery()
            ]);
            const { project_id, status, type, search, matched, limit, offset, sort_by, sort_dir } = req.query;
            const l = parseInt(limit) || (settings.default_limit || 100);
            const o = parseInt(offset) || 0;
            const sortDir = String(sort_dir || 'desc').toLowerCase() === 'asc' ? 'ASC' : 'DESC';
            const sortFieldMap = {
                id: 'id',
                project_id: 'project_id',
                page_type: 'page_type',
                url: 'url',
                added_from: 'added_from',
                added_at: 'added_at',
                status: 'status',
                parsed_at: 'parsed_at'
            };
            const sortField = sortFieldMap[String(sort_by || 'id')] || 'id';
            
            let q = `
                SELECT pg.*
                FROM pages pg
                WHERE 1=1
            `;
            let qc = 'SELECT COUNT(*) as total FROM pages WHERE 1=1';
            let p = [], pc = [];

            if (project_id && project_id !== 'all') { 
                q += ' AND project_id = ?'; qc += ' AND project_id = ?'; 
                p.push(project_id); pc.push(project_id); 
            }
            if (status) { 
                q += ' AND status = ?'; qc += ' AND status = ?'; 
                p.push(status); pc.push(status); 
            }
            if (type && type !== 'all') { 
                q += ' AND page_type = ?'; qc += ' AND page_type = ?'; 
                p.push(type); pc.push(type); 
            }
            if (matched === '1') {
                q += ' AND EXISTS(SELECT 1 FROM prices pr JOIN product_matches pm ON pm.status = "confirmed" AND pm.competitor_site_id = pr.project_id AND ((pm.competitor_sku IS NOT NULL AND pm.competitor_sku <> "" AND pm.competitor_sku = pr.sku) OR pm.competitor_name = pr.product_name) WHERE pr.project_id = pg.project_id AND pr.url = pg.url LIMIT 1)';
                qc += ' AND EXISTS(SELECT 1 FROM prices pr JOIN product_matches pm ON pm.status = "confirmed" AND pm.competitor_site_id = pr.project_id AND ((pm.competitor_sku IS NOT NULL AND pm.competitor_sku <> "" AND pm.competitor_sku = pr.sku) OR pm.competitor_name = pr.product_name) WHERE pr.project_id = pages.project_id AND pr.url = pages.url LIMIT 1)';
            } else if (matched === '0') {
                q += ' AND NOT EXISTS(SELECT 1 FROM prices pr JOIN product_matches pm ON pm.status = "confirmed" AND pm.competitor_site_id = pr.project_id AND ((pm.competitor_sku IS NOT NULL AND pm.competitor_sku <> "" AND pm.competitor_sku = pr.sku) OR pm.competitor_name = pr.product_name) WHERE pr.project_id = pg.project_id AND pr.url = pg.url LIMIT 1)';
                qc += ' AND NOT EXISTS(SELECT 1 FROM prices pr JOIN product_matches pm ON pm.status = "confirmed" AND pm.competitor_site_id = pr.project_id AND ((pm.competitor_sku IS NOT NULL AND pm.competitor_sku <> "" AND pm.competitor_sku = pr.sku) OR pm.competitor_name = pr.product_name) WHERE pr.project_id = pages.project_id AND pr.url = pages.url LIMIT 1)';
            }
            
            // Логика поиска по URL
            if (search) {
                const searchVal = `%${search}%`;
                q += ' AND url LIKE ?'; 
                qc += ' AND url LIKE ?'; 
                p.push(searchVal); 
                pc.push(searchVal); 
            }

            q += ` ORDER BY ${sortField} ${sortDir}, id DESC LIMIT ? OFFSET ?`;
            p.push(l, o);

            const [[rows], [count]] = await Promise.all([db.query(q, p), db.query(qc, pc)]);

            if (matched === '1') {
                for (const row of rows) row.is_matched = 1;
            } else if (matched === '0') {
                for (const row of rows) row.is_matched = 0;
            } else {
                await attachPageMatchedFlags(rows);
            }

            res.json({ data: rows, total: count[0].total });
        } catch (e) {
            console.error('Error fetching pages:', e);
            res.status(500).json({ error: e.message });
        }
    });

    // 2. Массовое добавление URL
    router.post('/bulk', async (req, res) => {
        try {
            await ensurePagesAddedFromColumn();
            await ensurePagesAddedAtColumn();
            const { project_id, urls_text } = req.body;
            if (!project_id || !urls_text) return res.status(400).json({ error: 'Нет данных' });
            
            const urls = Array.from(new Set(
                urls_text
                    .split(/[\n\r,]+/)
                    .map((u) => normalizeQueueUrl(u))
                    .filter(Boolean)
            ));
            if (!urls.length) return res.json({ success: true, count: 0 });
            
            const vals = urls.map(u => [project_id, u, 'pending', 'unknown', 'Ручной']);
            await db.query('INSERT INTO pages (project_id, url, status, page_type, added_from) VALUES ?', [vals]);
            
            res.json({ success: true, count: urls.length });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // 3. Удалить страницу
    router.delete('/:id', async (req, res) => {
        try {
            await db.query('DELETE FROM pages WHERE id = ?', [req.params.id]);
            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    /**
     * Условия для массовых reset/clear: верхние фильтры + фильтры строки таблицы (как в UI очереди).
     * @returns {{ parts: string[], p: unknown[], narrow: boolean }}
     */
    function buildBulkQueueWhereParts(body, modeFiltered) {
        const {
            project_id,
            status,
            type,
            tf_status,
            tf_page_type,
            tf_id,
            tf_url,
            tf_added_from,
            tf_matched,
            search,
            matched
        } = body || {};
        const parts = ['1=1'];
        const p = [];
        if (project_id && project_id !== 'all') {
            parts.push('project_id = ?');
            p.push(project_id);
        }

        let effStatusFinal = null;
        let effTypeFinal = null;
        if (modeFiltered) {
            if (tf_status && tf_status !== 'all') effStatusFinal = tf_status;
            else if (status) effStatusFinal = status;
            if (tf_page_type && tf_page_type !== 'all') effTypeFinal = tf_page_type;
            else if (type && type !== 'all') effTypeFinal = type;
        } else {
            if (status) effStatusFinal = status;
            if (type && type !== 'all') effTypeFinal = type;
        }

        if (effStatusFinal) {
            parts.push('status = ?');
            p.push(effStatusFinal);
        }
        if (effTypeFinal) {
            parts.push('page_type = ?');
            p.push(effTypeFinal);
        }

        let tid = '';
        let turl = '';
        let ta = '';
        let sq = '';
        if (modeFiltered) {
            tid = String(tf_id || '').trim();
            if (tid) {
                parts.push('CAST(id AS CHAR) LIKE ?');
                p.push(`%${tid}%`);
            }
            turl = String(tf_url || '').trim();
            if (turl) {
                parts.push('LOWER(url) LIKE LOWER(?)');
                p.push(`%${turl}%`);
            }
            ta = String(tf_added_from || '').trim();
            if (ta) {
                parts.push('LOWER(COALESCE(added_from,"")) LIKE LOWER(?)');
                p.push(`%${ta}%`);
            }
            sq = String(search || '').trim();
            if (sq) {
                parts.push('url LIKE ?');
                p.push(`%${sq}%`);
            }
        }

        const tfM = modeFiltered && tf_matched != null ? String(tf_matched) : 'all';
        const topM = modeFiltered && matched != null ? String(matched) : 'all';
        const effM = tfM === '1' || tfM === '0' ? tfM : topM === '1' || topM === '0' ? topM : 'all';
        if (effM === '1') {
            parts.push(
                'EXISTS(SELECT 1 FROM prices pr JOIN product_matches pm ON pm.status = "confirmed" AND pm.competitor_site_id = pr.project_id AND ((pm.competitor_sku IS NOT NULL AND pm.competitor_sku <> "" AND pm.competitor_sku = pr.sku) OR pm.competitor_name = pr.product_name) WHERE pr.project_id = pages.project_id AND pr.url = pages.url LIMIT 1)'
            );
        } else if (effM === '0') {
            parts.push(
                'NOT EXISTS(SELECT 1 FROM prices pr JOIN product_matches pm ON pm.status = "confirmed" AND pm.competitor_site_id = pr.project_id AND ((pm.competitor_sku IS NOT NULL AND pm.competitor_sku <> "" AND pm.competitor_sku = pr.sku) OR pm.competitor_name = pr.product_name) WHERE pr.project_id = pages.project_id AND pr.url = pages.url LIMIT 1)'
            );
        }

        const narrow =
            (project_id && project_id !== 'all') ||
            !!effStatusFinal ||
            !!effTypeFinal ||
            (!!modeFiltered && !!tid) ||
            (!!modeFiltered && !!turl) ||
            (!!modeFiltered && !!ta) ||
            (!!modeFiltered && !!sq) ||
            effM === '1' ||
            effM === '0';

        return { parts, p, narrow };
    }

    // 4. Очистить очередь
    router.post('/clear', async (req, res) => {
        try {
            await ensurePagesQueueIndex();
            const modeFiltered = String(req.body?.mode || '') === 'filtered';
            const { parts, p, narrow } = buildBulkQueueWhereParts(req.body, modeFiltered);
            if (modeFiltered && !narrow) {
                return res.status(400).json({
                    error:
                        'Слишком широкий фильтр: выберите проект и/или ограничьте тип, статус или поля фильтра таблицы (строка под основными фильтрами).'
                });
            }
            const searchTrim = String(req.body.search || '').trim();
            if (modeFiltered && searchTrim && (!req.body.project_id || req.body.project_id === 'all')) {
                return res.status(400).json({
                    error:
                        'В «Умном поиске» есть текст (фильтр по URL), но не выбран проект. Выберите проект — иначе массовый сброс не совпадёт со списком и может затронуть лишнее.'
                });
            }
            const whereClause = parts.join(' AND ');
            const chunkSize = 500;
            const pauseMs = 50;
            let deleted = 0;
            while (true) {
                const [r] = await db.query(`DELETE FROM pages WHERE ${whereClause} LIMIT ?`, [...p, chunkSize]);
                const n = Number(r.affectedRows || 0);
                deleted += n;
                if (n < chunkSize) break;
                if (pauseMs > 0) await new Promise((resolve) => setTimeout(resolve, pauseMs));
            }
            res.json({ success: true, deleted });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // 5. Сбросить статус (в очередь)
    router.post('/reset', async (req, res) => {
        try {
            await ensurePagesQueueIndex();
            const modeFiltered = String(req.body?.mode || '') === 'filtered';
            const { parts, p, narrow } = buildBulkQueueWhereParts(req.body, modeFiltered);
            if (modeFiltered && !narrow) {
                return res.status(400).json({
                    error:
                        'Слишком широкий фильтр: выберите проект и/или ограничьте тип, статус или поля фильтра таблицы (строка под основными фильтрами).'
                });
            }
            const searchTrimReset = String(req.body.search || '').trim();
            if (modeFiltered && searchTrimReset && (!req.body.project_id || req.body.project_id === 'all')) {
                return res.status(400).json({
                    error:
                        'В «Умном поиске» есть текст (фильтр по URL), но не выбран проект. Выберите проект — иначе массовый сброс не совпадёт со списком и может затронуть лишнее.'
                });
            }
            const whereClause = parts.join(' AND ');
            const chunkSize = 400;
            const pauseMs = 80;
            let reset = 0;
            while (true) {
                const [r] = await db.query(
                    `UPDATE pages SET status="pending", last_error=NULL, parsed_at=NULL WHERE ${whereClause} LIMIT ?`,
                    [...p, chunkSize]
                );
                const n = Number(r.affectedRows || 0);
                reset += n;
                if (n < chunkSize) break;
                if (pauseMs > 0) await new Promise((resolve) => setTimeout(resolve, pauseMs));
            }
            res.json({ success: true, reset, batched: true, chunk_size: chunkSize });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // 6. Парсинг одной страницы по ID
    router.post('/page/:id', async (req, res) => {
        try {
            const [pages] = await db.query('SELECT * FROM pages WHERE id = ?', [req.params.id]);
            if (!pages.length) return res.status(404).json({ error: 'Not found' });
            
            await runParser(pages[0]);
            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // 7. Парсинг видимых (фильтрованных)
    router.post('/visible', async (req, res) => {
        try {
            const { project_id, status, type } = req.body;
            let q = 'SELECT * FROM pages WHERE 1=1'; 
            let p = [];
            
            if (project_id && project_id !== 'all') { q += ' AND project_id = ?'; p.push(project_id); }
            if (status) { q += ' AND status = ?'; p.push(status); }
            if (type && type !== 'all') { q += ' AND page_type = ?'; p.push(type); }
            
            q += ' LIMIT ?'; 
            p.push(settings.parse_batch_size || 50);
            
            const [pages] = await db.query(q, p);
            if (!pages.length) return res.json({ message: 'Нет страниц' });
            
            for (const pg of pages) {
                await runParser(pg);
            }
            res.json({ success: true, processed: pages.length });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // 8. Обновить одну страницу по URL (для кнопки в результатах)
    router.post('/refresh-single', async (req, res) => {
        const { url, project_id, page_id } = req.body;
        const normalizedUrl = normalizeQueueUrl(url);
        
        if ((!normalizedUrl || !project_id) && !page_id) {
            return res.status(400).json({ error: 'Нет данных для постановки в очередь' });
        }

        try {
            await ensurePagesAddedFromColumn();
            await ensurePagesAddedAtColumn();
            if (page_id) {
                const [rows] = await db.query('SELECT id, status, project_id, url FROM pages WHERE id = ?', [page_id]);
                if (rows.length) {
                    const pg = rows[0];
                    if (pg.status !== 'processing') {
                        await db.query('UPDATE pages SET status = "pending", last_error = NULL, parsed_at = NULL WHERE id = ?', [pg.id]);
                        return res.json({ success: true, message: 'Страница возвращена в очередь', id: pg.id });
                    }
                    const [queuedById] = await db.query(
                        'INSERT INTO pages (project_id, url, status, page_type, added_from) VALUES (?, ?, "pending", "unknown", "Ручной")',
                        [pg.project_id, pg.url]
                    );
                    return res.json({
                        success: true,
                        message: 'Страница уже обрабатывается. Следующий прогон добавлен в очередь.',
                        id: queuedById.insertId
                    });
                }
            }

            const [existing] = await db.query('SELECT id, status FROM pages WHERE url = ? AND project_id = ?', [normalizedUrl, project_id]);
            
            if (existing.length > 0) {
                if (existing[0].status !== 'processing') {
                    await db.query('UPDATE pages SET status = "pending", last_error = NULL, parsed_at = NULL WHERE id = ?', [existing[0].id]);
                    res.json({ success: true, message: 'Страница возвращена в очередь', id: existing[0].id });
                } else {
                    const [queued] = await db.query(
                        'INSERT INTO pages (project_id, url, status, page_type, added_from) VALUES (?, ?, "pending", "unknown", "Ручной")',
                        [project_id, normalizedUrl]
                    );
                    res.json({
                        success: true,
                        message: 'Страница уже обрабатывается. Следующий прогон добавлен в очередь.',
                        id: queued.insertId
                    });
                }
            } else {
                const [result] = await db.query('INSERT INTO pages (project_id, url, status, page_type, added_from) VALUES (?, ?, "pending", "unknown", "Ручной")', [project_id, normalizedUrl]);
                res.json({ success: true, message: 'Страница добавлена в очередь', id: result.insertId });
            }
        } catch (e) {
            console.error('Error refresh-single:', e);
            res.status(500).json({ error: e.message });
        }
    });

    // 9. Массовое добавление результатов в очередь
    router.post('/refresh-results', async (req, res) => {
        try {
            await ensurePagesAddedFromColumn();
            await ensurePagesAddedAtColumn();
            const { project_id, page_status, search } = req.body;
            
            let qUrls = `
                SELECT DISTINCT pr.url, pr.project_id
                FROM prices pr
                LEFT JOIN pages pg ON pg.id = pr.page_id
                WHERE 1=1
            `;
            let pUrls = [];
            
            if (project_id && project_id !== 'all') {
                qUrls += ' AND pr.project_id = ?';
                pUrls.push(project_id);
            }
            if (page_status && ['pending', 'processing', 'done', 'error'].includes(String(page_status).toLowerCase())) {
                qUrls += ' AND pg.status = ?';
                pUrls.push(String(page_status).toLowerCase());
            }
            if (search && String(search).trim()) {
                const val = `%${String(search).trim()}%`;
                qUrls += ' AND (pr.sku LIKE ? OR pr.product_name LIKE ?)';
                pUrls.push(val, val);
            }
            qUrls += ' ORDER BY pr.id DESC';
            
            const [recentUrls] = await db.query(qUrls, pUrls);
            if (recentUrls.length === 0) return res.json({ message: 'Нет результатов' });

            let addedCount = 0;
            for (const item of recentUrls) {
                const normalizedUrl = normalizeQueueUrl(item.url);
                if (!normalizedUrl) continue;
                const [existing] = await db.query('SELECT id, status FROM pages WHERE url = ? AND project_id = ?', [normalizedUrl, item.project_id]);
                if (existing.length > 0) {
                    if (existing[0].status !== 'processing') {
                        await db.query('UPDATE pages SET status = "pending", last_error = NULL, parsed_at = NULL WHERE id = ?', [existing[0].id]);
                        addedCount++;
                    } else {
                        await db.query(
                            'INSERT INTO pages (project_id, url, status, page_type, added_from) VALUES (?, ?, "pending", "unknown", "Ручной")',
                            [item.project_id, normalizedUrl]
                        );
                        addedCount++;
                    }
                } else {
                    await db.query('INSERT INTO pages (project_id, url, status, page_type, added_from) VALUES (?, ?, "pending", "unknown", "Ручной")', [item.project_id, normalizedUrl]);
                    addedCount++;
                }
            }
            res.json({ success: true, message: `В очередь добавлено: ${addedCount}` });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // 10. Автопоиск URL для проекта: robots -> sitemap -> fallback crawl
    router.post('/discover-start', async (req, res) => {
        try {
            const projectId = parseInt(req.body.project_id, 10);
            if (!projectId) return res.status(400).json({ error: 'project_id required' });
            const [rows] = await db.query('SELECT id, name, domain FROM projects WHERE id = ?', [projectId]);
            if (!rows.length) return res.status(404).json({ error: 'Project not found' });
            if (discoveryJobs.get(projectId)?.active) {
                return res.status(409).json({ error: 'Discovery already running' });
            }
            const domain = pickDiscoveryHostFromProjectRow(rows[0]);
            runDiscovery(projectId, domain).catch((e) => {
                console.error('[discovery]', projectId, e && e.message ? e.message : e);
            });
            return res.json({ success: true, message: 'Автообход запущен' });
        } catch (e) {
            return res.status(500).json({ error: e.message });
        }
    });

    function parseDiscoveryErrorsJson(raw) {
        try {
            const arr = JSON.parse(String(raw || '[]'));
            return Array.isArray(arr) ? arr.map((e) => String(e || '').trim()).filter(Boolean) : [];
        } catch (_) {
            return [];
        }
    }

    async function loadDiscoveryRecentRuns(projectId, limit = 8) {
        await ensureDiscoverySchema();
        const lim = Math.min(20, Math.max(1, Number(limit) || 8));
        const [rows] = await db.query(
            `SELECT id, status, message, discovered, added, added_sitemap, added_from_page, source,
                    started_at, finished_at, errors_json, cancel_requested
             FROM discovery_jobs WHERE project_id = ? ORDER BY id DESC LIMIT ?`,
            [projectId, lim]
        );
        return (rows || []).map((row) => ({
            id: row.id,
            status: String(row.status || ''),
            message: String(row.message || ''),
            discovered: Number(row.discovered || 0),
            added: Number(row.added || 0),
            added_sitemap: Number(row.added_sitemap || 0),
            added_from_page: Number(row.added_from_page || 0),
            source: String(row.source || ''),
            started_at: row.started_at ? new Date(row.started_at).toISOString() : null,
            finished_at: row.finished_at ? new Date(row.finished_at).toISOString() : null,
            cancel_requested: Number(row.cancel_requested || 0) === 1,
            errors: parseDiscoveryErrorsJson(row.errors_json)
        }));
    }

    function serializeDiscoveryJob(job) {
        if (!job) return null;
        return {
            active: Boolean(job.active),
            cancel_requested: Boolean(job.cancel_requested),
            started_at: job.started_at || null,
            finished_at: job.finished_at || null,
            message: String(job.message || ''),
            discovered: Number(job.discovered || 0),
            added: Number(job.added || 0),
            added_sitemap: Number(job.added_sitemap || 0),
            added_from_page: Number(job.added_from_page || 0),
            source: String(job.source || ''),
            errors: Array.isArray(job.errors) ? job.errors.slice(0, 50) : []
        };
    }

    router.get('/discover-status', async (req, res) => {
        const projectId = parseInt(req.query.project_id, 10);
        if (!projectId) return res.status(400).json({ error: 'project_id required' });
        const histLimit = Math.min(20, Math.max(1, parseInt(req.query.history, 10) || 8));
        try {
            const recent_runs = await loadDiscoveryRecentRuns(projectId, histLimit);
            const job = discoveryJobs.get(projectId);
            if (job) {
                const payload = serializeDiscoveryJob(job);
                return res.json({ ...payload, recent_runs });
            }
            if (recent_runs.length) {
                const row0 = recent_runs[0];
                return res.json({
                    active: String(row0.status || '') === 'running',
                    cancel_requested: Boolean(row0.cancel_requested),
                    started_at: row0.started_at,
                    finished_at: row0.finished_at,
                    message: row0.message,
                    discovered: row0.discovered,
                    added: row0.added,
                    added_sitemap: row0.added_sitemap,
                    added_from_page: row0.added_from_page,
                    source: row0.source,
                    errors: row0.errors,
                    recent_runs
                });
            }
            return res.json({
                active: false,
                message: 'Нет запусков автообхода',
                discovered: 0,
                added: 0,
                added_sitemap: 0,
                added_from_page: 0,
                errors: [],
                recent_runs: []
            });
        } catch (e) {
            return res.status(500).json({ error: e.message });
        }
    });

    router.getDiscoveryJobsSnapshot = function getDiscoveryJobsSnapshot() {
        const out = [];
        for (const [projectId, job] of discoveryJobs.entries()) {
            out.push({
                project_id: Number(projectId),
                active: Boolean(job?.active),
                cancel_requested: Boolean(job?.cancel_requested),
                started_at: job?.started_at || null,
                finished_at: job?.finished_at || null,
                message: job?.message || '',
                discovered: Number(job?.discovered || 0),
                added: Number(job?.added || 0),
                added_sitemap: Number(job?.added_sitemap || 0),
                added_from_page: Number(job?.added_from_page || 0),
                source: job?.source || '',
                errors: Array.isArray(job?.errors) ? job.errors.slice(0, 5) : []
            });
        }
        out.sort((a, b) => (b.started_at || '').localeCompare(a.started_at || ''));
        return out.slice(0, 20);
    };

    router.post('/discover-stop', async (req, res) => {
        const projectId = parseInt(req.body.project_id, 10);
        if (!projectId) return res.status(400).json({ error: 'project_id required' });
        const job = discoveryJobs.get(projectId);
        if (!job || !job.active) {
            return res.status(404).json({ error: 'Активный автообход не найден' });
        }
        job.cancel_requested = true;
        job.message = 'Остановка запрошена...';
        discoveryJobs.set(projectId, job);
        await persistDiscoveryProgress(projectId, job);
        return res.json({ success: true, message: 'Остановка автообхода запрошена' });
    });

    async function recoverInterruptedDiscoveries() {
        try {
            await ensureDiscoverySchema();
            const [rows] = await db.query('SELECT id, project_id FROM discovery_jobs WHERE status = "running" ORDER BY id DESC LIMIT 5');
            if (!rows.length) return;
            for (const row of rows) {
                const projectId = Number(row.project_id || 0);
                if (!projectId || discoveryJobs.get(projectId)?.active) continue;
                try {
                    await db.query(
                        'UPDATE discovery_jobs SET status = "interrupted", finished_at = NOW(), message = ? WHERE id = ?',
                        ['Прервано: процесс был перезапущен', row.id]
                    );
                } catch (_) {}
                const [proj] = await db.query('SELECT id, domain FROM projects WHERE id = ?', [projectId]);
                if (!proj.length) continue;
                runDiscovery(projectId, proj[0].domain).catch(() => {});
                try {
                    const runId = activeDiscoveryRunIds.get(projectId);
                    if (runId) {
                        await db.query('UPDATE discovery_jobs SET resumed_after_restart = 1 WHERE id = ?', [runId]);
                    }
                } catch (_) {}
            }
        } catch (_) {}
    }

    router.watchdogTick = async function watchdogTick() {
        await recoverInterruptedDiscoveries();
    };

    startQueueWorker();
    recoverInterruptedDiscoveries().catch(() => {});
    return router;
};