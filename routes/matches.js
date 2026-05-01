const express = require('express');
const router = express.Router();

// Функция расстояния Левенштейна для умного поиска
function levenshtein(str1, str2) {
    const m = str1.length, n = str2.length;
    const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
    for (let i = 0; i <= m; i++) dp[i][0] = i;
    for (let j = 0; j <= n; j++) dp[0][j] = j;
    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            if (str1[i - 1] === str2[j - 1]) dp[i][j] = dp[i - 1][j - 1];
            else dp[i][j] = 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
        }
    }
    return dp[m][n];
}

function similarity(s1, s2) {
    if (!s1 || !s2) return 0;
    const maxLen = Math.max(s1.length, s2.length);
    if (maxLen === 0) return 1;
    return (maxLen - levenshtein(s1.toLowerCase(), s2.toLowerCase())) / maxLen;
}

function normalizeText(text) {
    if (!text) return '';
    return text.toLowerCase()
        .replace(/[^a-zа-яё0-9\s]/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/** Ключ для сопоставления SKU: NFKC, верхний регистр, Unicode-пробелы и тире унифицированы. */
function normalizeSkuForMatch(raw) {
    if (raw == null || raw === '') return '';
    let s = String(raw).normalize('NFKC').trim().toUpperCase();
    s = s.replace(/[\u00A0\s]+/g, '');
    s = s.replace(/[\u2010-\u2015\u2212\uFE58\uFE63\uFF0D]/g, '-');
    s = s.replace(/-+/g, '-');
    return s;
}

const MATCHING_MODES = new Set(['all', 'name', 'sku', 'sku_norm', 'sku_best']);

function sanitizeMatchingMode(mode) {
    const m = String(mode || '').trim();
    return MATCHING_MODES.has(m) ? m : 'all';
}

function strictSkuKey(raw) {
    return (raw || '').trim().toUpperCase();
}

function findSkuMatchStrict(compPrices, normMySku) {
    if (!normMySku) return null;
    return compPrices.find((c) => strictSkuKey(c.sku) === normMySku) || null;
}

function findSkuMatchNormFirst(compPrices, normKey) {
    if (!normKey) return null;
    return compPrices.find((c) => normalizeSkuForMatch(c.sku) === normKey) || null;
}

function findSkuMatchNormBest(compPrices, normKey) {
    if (!normKey) return null;
    const cand = compPrices.filter((c) => normalizeSkuForMatch(c.sku) === normKey);
    if (!cand.length) return null;
    cand.sort((a, b) => {
        const ta = new Date(a.parsed_at || 0).getTime();
        const tb = new Date(b.parsed_at || 0).getTime();
        if (tb !== ta) return tb - ta;
        const na = String(a.product_name || '');
        const nb = String(b.product_name || '');
        if (na !== nb) return na < nb ? -1 : na > nb ? 1 : 0;
        const sa = String(a.sku || '');
        const sb = String(b.sku || '');
        return sa < sb ? -1 : sa > sb ? 1 : 0;
    });
    return cand[0];
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = (db, settings) => {
    const cancelledJobs = new Set();
    let perfIndexesReady = false;
    let matchAuditColumnsReady = false;
    let productMatchesOptionalColsReady = false;

    async function ensureProductMatchesOptionalCols() {
        if (productMatchesOptionalColsReady) return;
        const cols = [
            {
                name: 'matching_mode',
                ddl: 'ALTER TABLE product_matches ADD COLUMN matching_mode VARCHAR(24) NULL'
            }
        ];
        for (const c of cols) {
            try {
                const [rows] = await db.query(
                    `SELECT 1
                     FROM information_schema.columns
                     WHERE table_schema = DATABASE()
                       AND table_name = 'product_matches'
                       AND column_name = ?
                     LIMIT 1`,
                    [c.name]
                );
                if (!rows.length) await db.query(c.ddl);
            } catch (_) {}
        }
        productMatchesOptionalColsReady = true;
    }

    async function ensureMatchAuditColumns() {
        if (matchAuditColumnsReady) return;
        const cols = [
            { name: 'confirmed_by', ddl: 'ALTER TABLE product_matches ADD COLUMN confirmed_by VARCHAR(100) NULL' },
            { name: 'confirmed_at', ddl: 'ALTER TABLE product_matches ADD COLUMN confirmed_at TIMESTAMP NULL' },
            { name: 'unlinked_by', ddl: 'ALTER TABLE product_matches ADD COLUMN unlinked_by VARCHAR(100) NULL' },
            { name: 'unlinked_at', ddl: 'ALTER TABLE product_matches ADD COLUMN unlinked_at TIMESTAMP NULL' }
        ];
        for (const c of cols) {
            try {
                const [rows] = await db.query(
                    `SELECT 1
                     FROM information_schema.columns
                     WHERE table_schema = DATABASE()
                       AND table_name = 'product_matches'
                       AND column_name = ?
                     LIMIT 1`,
                    [c.name]
                );
                if (!rows.length) await db.query(c.ddl);
            } catch (_) {}
        }
        matchAuditColumnsReady = true;
    }

    async function ensureMatchesPerfIndexes() {
        if (perfIndexesReady) return;
        const desired = [
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
                name: 'idx_my_products_site_sku_active_updated',
                ddl: 'CREATE INDEX idx_my_products_site_sku_active_updated ON my_products (site_id, sku, is_active, updated_at)'
            },
            {
                table: 'my_products',
                name: 'idx_my_products_site_name_active_updated',
                ddl: 'CREATE INDEX idx_my_products_site_name_active_updated ON my_products (site_id, name(191), is_active, updated_at)'
            }
        ];
        for (const item of desired) {
            try {
                const [rows] = await db.query(
                    `SELECT 1 FROM information_schema.statistics
                     WHERE table_schema = DATABASE()
                       AND table_name = ?
                       AND index_name = ?
                     LIMIT 1`,
                    [item.table, item.name]
                );
                if (!rows.length) {
                    await db.query(item.ddl);
                }
            } catch (_) {}
        }
        perfIndexesReady = true;
    }
    async function updateJob(jobId, fields) {
        const keys = Object.keys(fields);
        if (!keys.length) return;
        const setClause = keys.map((k) => `${k} = ?`).join(', ');
        const values = keys.map((k) => fields[k]);
        await db.query(`UPDATE matching_jobs SET ${setClause} WHERE id = ?`, [...values, jobId]);
    }

    async function addJobLog(jobId, message) {
        await db.query('INSERT INTO matching_job_logs (job_id, message) VALUES (?, ?)', [jobId, message]);
    }

    async function resolveActorDisplayName(req) {
        const username = String(req.headers['x-auth-username'] || '').trim();
        if (!username) return 'unknown';
        try {
            const [rows] = await db.query(
                'SELECT COALESCE(NULLIF(full_name, \'\'), username) AS display_name FROM users WHERE username = ? LIMIT 1',
                [username]
            );
            if (rows.length && rows[0].display_name) return String(rows[0].display_name);
        } catch (_) {}
        return username;
    }

    async function getFreshRunningJob(mySiteId, staleAfterSec = 180) {
        const [rows] = await db.query(
            `SELECT mj.id, mj.my_site_id, mj.status, mj.message, mj.processed, mj.total, mj.started_at, mj.finished_at,
                    TIMESTAMPDIFF(
                        SECOND,
                        COALESCE(
                            (SELECT MAX(mjl.created_at) FROM matching_job_logs mjl WHERE mjl.job_id = mj.id),
                            mj.started_at,
                            NOW()
                        ),
                        NOW()
                    ) AS idle_sec
             FROM matching_jobs mj
             WHERE mj.my_site_id = ? AND mj.status = "running"
             ORDER BY mj.id DESC
             LIMIT 1`,
            [mySiteId]
        );
        if (!rows.length) return null;
        const job = rows[0];
        const idleSec = Number(job.idle_sec || 0);
        if (idleSec <= staleAfterSec) return job;
        try {
            await updateJob(job.id, {
                status: 'failed',
                message: `Прервано: нет активности ${idleSec}с (процесс перезапущен или завис)`,
                finished_at: new Date()
            });
            await addJobLog(job.id, `Автозавершение stale-задачи: нет активности ${idleSec}с`);
        } catch (_) {}
        return null;
    }

    async function cleanupStaleRunningJobs(staleAfterSec = 180) {
        const [rows] = await db.query(
            `SELECT mj.id, mj.my_site_id, mj.params_json, mj.checkpoint_comp_index, mj.checkpoint_product_index,
                    TIMESTAMPDIFF(
                        SECOND,
                        COALESCE(
                            (SELECT MAX(mjl.created_at) FROM matching_job_logs mjl WHERE mjl.job_id = mj.id),
                            mj.started_at,
                            NOW()
                        ),
                        NOW()
                    ) AS idle_sec
             FROM matching_jobs mj
             WHERE mj.status = "running"
             ORDER BY mj.id DESC
             LIMIT 50`
        );
        for (const row of rows) {
            const idleSec = Number(row.idle_sec || 0);
            if (idleSec <= staleAfterSec) continue;
            try {
                let payload = {};
                try {
                    payload = row.params_json ? JSON.parse(row.params_json) : {};
                } catch (_) {
                    payload = {};
                }
                const autoRetryCount = Number(payload.__autoRetryCount || 0);
                await updateJob(row.id, {
                    status: 'failed',
                    message: `Прервано watchdog: нет активности ${idleSec}с`,
                    finished_at: new Date()
                });
                await addJobLog(row.id, `Watchdog: stale running job, idle ${idleSec}с`);

                // Автовосстановление: пробуем продолжить с чекпоинта.
                // Ограничиваем количество автоповторов, чтобы не уйти в бесконечный цикл.
                if (autoRetryCount >= 2) {
                    await addJobLog(row.id, 'Watchdog: автоповтор пропущен (достигнут лимит)');
                    continue;
                }
                const [stillRunning] = await db.query(
                    'SELECT id FROM matching_jobs WHERE my_site_id = ? AND status = "running" ORDER BY id DESC LIMIT 1',
                    [row.my_site_id]
                );
                if (stillRunning.length) continue;

                const competitorIds = Array.isArray(payload.competitorIds)
                    ? payload.competitorIds.map((x) => parseInt(x, 10)).filter(Number.isFinite)
                    : [];
                if (!competitorIds.length) {
                    await addJobLog(row.id, 'Watchdog: автоповтор невозможен (нет competitorIds)');
                    continue;
                }
                const replayPayload = {
                    ...payload,
                    mySiteId: parseInt(row.my_site_id, 10),
                    competitorIds,
                    resumeMode: true,
                    startCompIndex: parseInt(row.checkpoint_comp_index, 10) || 0,
                    startProductIndex: parseInt(row.checkpoint_product_index, 10) || 0,
                    __autoRetryCount: autoRetryCount + 1
                };
                const [ins] = await db.query(
                    'INSERT INTO matching_jobs (my_site_id, status, message, params_json, checkpoint_comp_index, checkpoint_product_index, processed, total, found, found_sku, found_name) VALUES (?, "running", "Watchdog: автовосстановление задачи...", ?, ?, ?, 0, 0, 0, 0, 0)',
                    [row.my_site_id, JSON.stringify(replayPayload), replayPayload.startCompIndex, replayPayload.startProductIndex]
                );
                const newJobId = ins.insertId;
                await addJobLog(newJobId, `Watchdog: автоповтор задачи #${row.id}`);
                executeMatching({ jobId: newJobId, ...replayPayload }).catch(async (e) => {
                    await updateJob(newJobId, {
                        status: 'failed',
                        message: `Ошибка: ${e.message}`,
                        finished_at: new Date()
                    });
                    await addJobLog(newJobId, `Ошибка: ${e.message}`);
                });
            } catch (_) {}
        }
    }

    async function executeMatching({
        jobId,
        mySiteId,
        competitorIds,
        threshold = 0.85,
        mode = 'all',
        productIds = null,
        productSearch = '',
        resumeMode = false,
        startCompIndex = 0,
        startProductIndex = 0,
        batchSize = 200,
        batchPauseMs = 1000,
        microPauseMs = 20,
        microPauseEvery = 20
    }) {
        mode = sanitizeMatchingMode(mode);
        await ensureProductMatchesOptionalCols();
        await ensureMatchesPerfIndexes();
        await updateJob(jobId, { message: 'Подготовка...' });
        await addJobLog(jobId, 'Подготовка данных');
        if (!resumeMode) {
            await db.query('DELETE FROM product_matches WHERE my_site_id = ? AND status = "pending"', [mySiteId]);
        } else {
            await addJobLog(jobId, 'Режим продолжения: pending-результаты не очищаются');
        }
        await updateJob(jobId, { message: 'Загрузка моих активных товаров...' });

        let myProducts = [];
        if (Array.isArray(productIds) && productIds.length > 0) {
            const ids = productIds.map((x) => parseInt(x, 10)).filter(Number.isFinite);
            if (ids.length === 0) {
                return { matches: [], count: 0 };
            }
            const placeholders = ids.map(() => '?').join(',');
            const [rows] = await db.query(
                `SELECT id, sku, name, price, currency FROM my_products WHERE site_id = ? AND is_active = 1 AND id IN (${placeholders})`,
                [mySiteId, ...ids]
            );
            myProducts = rows;
            await addJobLog(jobId, `Загружено выбранных товаров: ${myProducts.length}`);
        } else {
            const hasSearch = String(productSearch || '').trim().length > 0;
            const t0 = Date.now();
            await updateJob(jobId, { message: 'Подсчет объема моих товаров...' });
            if (hasSearch) {
                const val = `%${String(productSearch).trim()}%`;
                const [[cntRow]] = await db.query(
                    'SELECT COUNT(*) AS cnt FROM my_products WHERE site_id = ? AND is_active = 1 AND (sku LIKE ? OR name LIKE ?)',
                    [mySiteId, val, val]
                );
                const totalProducts = Number(cntRow?.cnt || 0);
                await addJobLog(jobId, `Найдено моих товаров по фильтру: ${totalProducts}`);
                await updateJob(jobId, { message: `Загрузка моих товаров чанками... 0/${totalProducts}` });
                const chunkSize = 2000;
                let offset = 0;
                while (offset < totalProducts) {
                    const [rows] = await db.query(
                        'SELECT id, sku, name, price, currency FROM my_products WHERE site_id = ? AND is_active = 1 AND (sku LIKE ? OR name LIKE ?) ORDER BY id DESC LIMIT ? OFFSET ?',
                        [mySiteId, val, val, chunkSize, offset]
                    );
                    myProducts.push(...rows);
                    offset += rows.length;
                    await updateJob(jobId, { message: `Загрузка моих товаров чанками... ${myProducts.length}/${totalProducts}` });
                    await addJobLog(jobId, `Чанк загружен: +${rows.length}, всего ${myProducts.length}/${totalProducts}`);
                    if (!rows.length) break;
                    await new Promise((resolve) => setImmediate(resolve));
                }
            } else {
                const [[cntRow]] = await db.query(
                    'SELECT COUNT(*) AS cnt FROM my_products WHERE site_id = ? AND is_active = 1',
                    [mySiteId]
                );
                const totalProducts = Number(cntRow?.cnt || 0);
                await addJobLog(jobId, `Найдено моих активных товаров: ${totalProducts}`);
                await updateJob(jobId, { message: `Загрузка моих товаров чанками... 0/${totalProducts}` });
                const chunkSize = 2000;
                let offset = 0;
                while (offset < totalProducts) {
                    const [rows] = await db.query(
                        'SELECT id, sku, name, price, currency FROM my_products WHERE site_id = ? AND is_active = 1 ORDER BY id DESC LIMIT ? OFFSET ?',
                        [mySiteId, chunkSize, offset]
                    );
                    myProducts.push(...rows);
                    offset += rows.length;
                    await updateJob(jobId, { message: `Загрузка моих товаров чанками... ${myProducts.length}/${totalProducts}` });
                    await addJobLog(jobId, `Чанк загружен: +${rows.length}, всего ${myProducts.length}/${totalProducts}`);
                    if (!rows.length) break;
                    await new Promise((resolve) => setImmediate(resolve));
                }
            }
            await addJobLog(jobId, `Загрузка моих товаров завершена за ${Math.round((Date.now() - t0) / 1000)}с`);
        }

        if (resumeMode) {
            const placeholders = competitorIds.map(() => '?').join(',');
            const [existing] = await db.query(
                `SELECT DISTINCT my_sku, my_product_name
                 FROM product_matches
                 WHERE my_site_id = ?
                   AND competitor_site_id IN (${placeholders})`,
                [mySiteId, ...competitorIds]
            );
            const matchedKeys = new Set(
                existing.map((r) => `${String(r.my_sku || '').trim().toUpperCase()}||${String(r.my_product_name || '').trim().toLowerCase()}`)
            );
            const before = myProducts.length;
            myProducts = myProducts.filter((p) => {
                const key = `${String(p.sku || '').trim().toUpperCase()}||${String(p.name || '').trim().toLowerCase()}`;
                return !matchedKeys.has(key);
            });
            await addJobLog(jobId, `Продолжение: пропущено уже обработанных ${before - myProducts.length}, осталось ${myProducts.length}`);
        }

        if (myProducts.length === 0) {
            await updateJob(jobId, {
                status: 'completed',
                processed: 0,
                total: 0,
                found: 0,
                message: 'Нет активных товаров для сопоставления',
                finished_at: new Date()
            });
            await addJobLog(jobId, 'Нет активных товаров для сопоставления');
            return { matches: [], count: 0 };
        }

        const totalSteps = myProducts.length * competitorIds.length;
        let resumeProcessedBase = 0;
        if (resumeMode) {
            const [alreadyRows] = await db.query(
                'SELECT COUNT(*) AS cnt FROM product_matches WHERE my_site_id = ?',
                [mySiteId]
            );
            resumeProcessedBase = Number(alreadyRows?.[0]?.cnt || 0);
        }
        await updateJob(jobId, { total: totalSteps + resumeProcessedBase, processed: resumeProcessedBase, message: 'Старт сопоставления...' });
        await addJobLog(jobId, `Старт: товаров ${myProducts.length}, конкурентов ${competitorIds.length}`);

        const pendingMatches = [];
        let totalMatchesSaved = 0;
        let processed = 0;
        let foundSku = 0;
        let foundName = 0;
        let loopCounter = 0;
        const safeBatchSize = Math.max(1, parseInt(batchSize, 10) || 200);
        const safeBatchPauseMs = Math.max(0, parseInt(batchPauseMs, 10) || 1000);
        const safeMicroPauseMs = Math.max(0, parseInt(microPauseMs, 10) || 20);
        const safeMicroPauseEvery = Math.max(1, parseInt(microPauseEvery, 10) || 20);
        const saveChunkSize = Math.max(50, Math.min(500, safeBatchSize));

        async function flushPendingMatches() {
            if (!pendingMatches.length) return;
            const values = pendingMatches.map(m => [
                mySiteId, m.my_sku, m.my_name, m.comp_project_id,
                m.comp_sku, m.comp_name, m.match_type, m.matching_mode, m.confidence, 'pending'
            ]);
            await db.query(`
                INSERT INTO product_matches
                (my_site_id, my_sku, my_product_name, competitor_site_id, competitor_sku, competitor_name, match_type, matching_mode, confidence_score, status)
                VALUES ?
            `, [values]);
            totalMatchesSaved += pendingMatches.length;
            pendingMatches.length = 0;
        }

        for (let compPos = startCompIndex; compPos < competitorIds.length; compPos += 1) {
            const compId = competitorIds[compPos];
            if (cancelledJobs.has(jobId)) {
                await flushPendingMatches();
                await updateJob(jobId, {
                    status: 'cancelled',
                    message: 'Остановлено пользователем',
                    finished_at: new Date()
                });
                await addJobLog(jobId, 'Задача остановлена пользователем');
                cancelledJobs.delete(jobId);
                return { matches: [], count: totalMatchesSaved };
            }
            await updateJob(jobId, { message: `Загрузка товаров конкурента #${compId}...` });
            const [compPrices] = await db.query(`
                SELECT p.sku, p.product_name, p.price, p.currency, p.url, pr.domain as project_domain,
                       MAX(p.parsed_at) AS parsed_at
                FROM prices p
                JOIN projects pr ON p.project_id = pr.id
                WHERE p.project_id = ?
                GROUP BY p.sku, p.product_name, p.price, p.currency, p.url, pr.domain
                ORDER BY MAX(p.parsed_at) DESC
            `, [compId]);

            if (compPrices.length === 0) {
                await addJobLog(jobId, `Конкурент ${compId}: нет данных цен`);
                processed += myProducts.length;
                await updateJob(jobId, { processed: resumeProcessedBase + processed });
                continue;
            }

            let batchProcessedForCompetitor = 0;
            const productStart = compPos === startCompIndex ? startProductIndex : 0;
            for (let pIdx = productStart; pIdx < myProducts.length; pIdx += 1) {
                const myProd = myProducts[pIdx];
                if (cancelledJobs.has(jobId)) {
                    await flushPendingMatches();
                    await updateJob(jobId, {
                        status: 'cancelled',
                        processed: resumeProcessedBase + processed,
                        checkpoint_comp_index: compPos,
                        checkpoint_product_index: pIdx,
                        message: 'Остановлено пользователем',
                        finished_at: new Date()
                    });
                    await addJobLog(jobId, 'Задача остановлена пользователем');
                    cancelledJobs.delete(jobId);
                    return { matches: [], count: totalMatchesSaved };
                }
                if (processed % Math.max(10, Math.floor(safeBatchSize / 4)) === 0) {
                    await updateJob(jobId, {
                        processed: resumeProcessedBase + processed,
                        found_sku: foundSku,
                        found_name: foundName,
                        message: `Сопоставление: обработано ${resumeProcessedBase + processed} из ${resumeProcessedBase + totalSteps}`,
                        checkpoint_comp_index: compPos,
                        checkpoint_product_index: pIdx
                    });
                }
                let bestMatch = null;
                let bestScore = 0;
                let matchType = 'none';

                const normMySkuStrict = strictSkuKey(myProd.sku);
                const normMySkuNorm = normalizeSkuForMatch(myProd.sku);
                const normMyName = normalizeText(myProd.name);

                if (mode !== 'name') {
                    let skuMatch = null;
                    if (mode === 'all' || mode === 'sku') {
                        if (normMySkuStrict) skuMatch = findSkuMatchStrict(compPrices, normMySkuStrict);
                    } else if (mode === 'sku_norm') {
                        if (normMySkuNorm) skuMatch = findSkuMatchNormFirst(compPrices, normMySkuNorm);
                    } else if (mode === 'sku_best') {
                        if (normMySkuNorm) skuMatch = findSkuMatchNormBest(compPrices, normMySkuNorm);
                    }
                    if (skuMatch) {
                        bestMatch = skuMatch;
                        bestScore = 1.0;
                        matchType = 'sku';
                    }
                }

                if ((mode === 'all' || mode === 'name') && matchType !== 'sku' && normMyName.length > 3) {
                    for (const compProd of compPrices) {
                        const normCompName = normalizeText(compProd.product_name);
                        if (normCompName.length < 3) continue;
                        const score = similarity(normMyName, normCompName);
                        if (score >= threshold && score > bestScore) {
                            bestMatch = compProd;
                            bestScore = score;
                            matchType = 'name';
                        }
                    }
                }

                if (bestMatch) {
                    pendingMatches.push({
                        my_sku: myProd.sku,
                        my_name: myProd.name,
                        comp_sku: bestMatch.sku,
                        comp_name: bestMatch.product_name,
                        comp_project_id: compId,
                        match_type: matchType,
                        matching_mode: mode,
                        confidence: bestScore
                    });
                    if (matchType === 'sku') foundSku += 1;
                    if (matchType === 'name') foundName += 1;
                    await addJobLog(jobId, `${myProd.sku || myProd.name} -> ${bestMatch.sku || bestMatch.product_name} (${matchType})`);
                    if (pendingMatches.length >= saveChunkSize) {
                        await flushPendingMatches();
                    }
                }

                processed += 1;
                batchProcessedForCompetitor += 1;
                if (processed % 25 === 0) {
                    await updateJob(jobId, {
                        processed: resumeProcessedBase + processed,
                        found_sku: foundSku,
                        found_name: foundName,
                        checkpoint_comp_index: compPos,
                        checkpoint_product_index: pIdx
                    });
                }
                loopCounter += 1;

                // Важно: регулярно освобождаем event loop, чтобы API не "зависал"
                // во время долгого сопоставления на больших объемах данных.
                if (loopCounter % safeMicroPauseEvery === 0) {
                    if (safeMicroPauseMs > 0) {
                        await sleep(safeMicroPauseMs);
                    }
                    await new Promise((resolve) => setImmediate(resolve));
                }

                if (batchProcessedForCompetitor % safeBatchSize === 0) {
                    await flushPendingMatches();
                    await updateJob(jobId, {
                        message: `Пауза между батчами (${safeBatchPauseMs}мс), обработано ${resumeProcessedBase + processed}/${resumeProcessedBase + totalSteps}`,
                        processed: resumeProcessedBase + processed,
                        found_sku: foundSku,
                        found_name: foundName,
                        checkpoint_comp_index: compPos,
                        checkpoint_product_index: pIdx
                    });
                    await addJobLog(jobId, `Батч завершен: ${batchProcessedForCompetitor} по конкуренту ${compId}`);
                    if (safeBatchPauseMs > 0) {
                        await sleep(safeBatchPauseMs);
                    }
                }
            }
        }

        await updateJob(jobId, { message: 'Сохранение результатов...', processed: resumeProcessedBase + totalSteps });
        await flushPendingMatches();
        await updateJob(jobId, {
            status: 'completed',
            processed: resumeProcessedBase + totalSteps,
            checkpoint_comp_index: competitorIds.length,
            checkpoint_product_index: myProducts.length,
            found: totalMatchesSaved,
            found_sku: foundSku,
            found_name: foundName,
            message: `Готово. Найдено: ${totalMatchesSaved}`,
            finished_at: new Date()
        });
        await addJobLog(jobId, `Готово. Найдено: ${totalMatchesSaved}`);

        return { matches: [], count: totalMatchesSaved };
    }

    // 1. Получить список моих сайтов
    router.get('/my-sites', async (req, res) => {
        try {
            const [rows] = await db.query('SELECT id, name, domain FROM my_sites ORDER BY name');
            res.json(rows);
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // 1.1 Список моих товаров для выбора перед сопоставлением
    router.get('/my-products', async (req, res) => {
        const { my_site_id, search = '', limit = 50, offset = 0 } = req.query;
        if (!my_site_id) return res.status(400).json({ error: 'my_site_id required' });
        try {
            const l = Math.max(1, Math.min(parseInt(limit, 10) || 50, 200));
            const o = Math.max(0, parseInt(offset, 10) || 0);
            const hasSearch = String(search || '').trim().length > 0;
            const val = `%${String(search || '').trim()}%`;

            let q =
                'SELECT id, source_id, sku, name, price, currency, updated_at FROM my_products WHERE site_id = ? AND is_active = 1';
            let qc = 'SELECT COUNT(*) AS total FROM my_products WHERE site_id = ? AND is_active = 1';
            const p = [my_site_id];
            const pc = [my_site_id];

            if (hasSearch) {
                q += ' AND (sku LIKE ? OR name LIKE ? OR source_id LIKE ?)';
                qc += ' AND (sku LIKE ? OR name LIKE ? OR source_id LIKE ?)';
                p.push(val, val, val);
                pc.push(val, val, val);
            }
            q += ' ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?';
            p.push(l, o);

            const [rows] = await db.query(q, p);
            const [count] = await db.query(qc, pc);
            return res.json({ data: rows, total: count[0].total, limit: l, offset: o });
        } catch (e) {
            return res.status(500).json({ error: e.message });
        }
    });

    // 2. Получить список проектов (конкурентов)
    router.get('/competitors', async (req, res) => {
        try {
            const [rows] = await db.query('SELECT id, name, domain FROM projects ORDER BY name');
            res.json(rows);
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // 3. Запуск умного сопоставления в фоне
    router.post('/start-matching', async (req, res) => {
        let { mySiteId, competitorIds, threshold = 0.85, mode = 'all', productIds = null, productSearch = '', batchSize = 200, batchPauseMs = 1000, microPauseMs = 20, microPauseEvery = 20, resumeMode = false } = req.body;
        mode = sanitizeMatchingMode(mode);
        if (!mySiteId || !competitorIds || competitorIds.length === 0) {
            return res.status(400).json({ error: 'Не выбраны сайты' });
        }
        const running = await getFreshRunningJob(mySiteId);
        if (running) {
            return res.status(409).json({ error: 'Сопоставление уже выполняется' });
        }
        const payloadForReplay = JSON.stringify({
            mySiteId,
            competitorIds,
            threshold,
            mode,
            productIds,
            productSearch,
            batchSize,
            batchPauseMs,
            microPauseMs,
            microPauseEvery,
            resumeMode
        });
        const [ins] = await db.query(
            'INSERT INTO matching_jobs (my_site_id, status, message, params_json, checkpoint_comp_index, checkpoint_product_index, processed, total, found, found_sku, found_name) VALUES (?, "running", "Запуск...", ?, 0, 0, 0, 0, 0, 0, 0)',
            [mySiteId, payloadForReplay]
        );
        const jobId = ins.insertId;
        await addJobLog(jobId, 'Задача создана');

        executeMatching({ jobId, mySiteId, competitorIds, threshold, mode, productIds, productSearch, batchSize, batchPauseMs, microPauseMs, microPauseEvery, resumeMode, startCompIndex: 0, startProductIndex: 0 }).catch(async (e) => {
            await updateJob(jobId, {
                status: 'failed',
                message: `Ошибка: ${e.message}`,
                finished_at: new Date()
            });
            await addJobLog(jobId, `Ошибка: ${e.message}`);
        });

        return res.json({ success: true, started: true, jobId });
    });

    router.post('/retry-last', async (req, res) => {
        const {
            mySiteId,
            competitorIds = [],
            mode = 'all',
            productSearch = '',
            batchSize = 200,
            batchPauseMs = 1000,
            microPauseMs = 20,
            microPauseEvery = 20
        } = req.body;
        if (!mySiteId) return res.status(400).json({ error: 'mySiteId required' });

        const running = await getFreshRunningJob(mySiteId);
        if (running) return res.status(409).json({ error: 'Уже есть активная задача' });

        // Сначала пытаемся продолжить именно прерванную/упавшую задачу.
        // Это важно, чтобы случайный маленький тестовый completed-job не перебивал большой прогон.
        let [prevRows] = await db.query(
            'SELECT * FROM matching_jobs WHERE my_site_id = ? AND status IN ("failed","cancelled") ORDER BY id DESC LIMIT 1',
            [mySiteId]
        );
        // Фолбэк: если прерванных нет, берем последнюю завершенную.
        if (!prevRows.length) {
            [prevRows] = await db.query(
                'SELECT * FROM matching_jobs WHERE my_site_id = ? AND status = "completed" ORDER BY id DESC LIMIT 1',
                [mySiteId]
            );
        }
        if (!prevRows.length) return res.status(404).json({ error: 'Нет предыдущей задачи для повтора' });

        let payload = {};
        try {
            payload = prevRows[0].params_json ? JSON.parse(prevRows[0].params_json) : {};
        } catch (_) {
            payload = {};
        }
        if (!payload.competitorIds || !Array.isArray(payload.competitorIds) || payload.competitorIds.length === 0) {
            if (Array.isArray(competitorIds) && competitorIds.length > 0) {
                payload.competitorIds = competitorIds.map((x) => parseInt(x, 10)).filter(Number.isFinite);
            } else {
                return res.status(400).json({ error: 'В предыдущей задаче нет competitorIds. Выберите конкурентов и попробуйте снова.' });
            }
        }
        // Всегда даем возможность переопределить параметры из UI при нажатии "Продолжить"
        payload.mode = sanitizeMatchingMode(mode || payload.mode || 'all');
        payload.productSearch = typeof productSearch === 'string' ? productSearch : (payload.productSearch || '');
        payload.batchSize = parseInt(batchSize, 10) || payload.batchSize || 200;
        payload.batchPauseMs = parseInt(batchPauseMs, 10) || payload.batchPauseMs || 1000;
        payload.microPauseMs = parseInt(microPauseMs, 10) || payload.microPauseMs || 20;
        payload.microPauseEvery = parseInt(microPauseEvery, 10) || payload.microPauseEvery || 20;
        payload.mySiteId = parseInt(mySiteId, 10);
        payload.resumeMode = true;
        payload.startCompIndex = parseInt(prevRows[0].checkpoint_comp_index, 10) || 0;
        payload.startProductIndex = parseInt(prevRows[0].checkpoint_product_index, 10) || 0;

        const replayParams = JSON.stringify(payload);
        const [ins] = await db.query(
            'INSERT INTO matching_jobs (my_site_id, status, message, params_json, checkpoint_comp_index, checkpoint_product_index, processed, total, found, found_sku, found_name) VALUES (?, "running", "Повтор предыдущей задачи...", ?, ?, ?, 0, 0, 0, 0, 0)',
            [mySiteId, replayParams, payload.startCompIndex, payload.startProductIndex]
        );
        const jobId = ins.insertId;
        await addJobLog(jobId, `Создан повтор задачи #${prevRows[0].id} в режиме продолжения`);

        executeMatching({ jobId, ...payload }).catch(async (e) => {
            await updateJob(jobId, {
                status: 'failed',
                message: `Ошибка: ${e.message}`,
                finished_at: new Date()
            });
            await addJobLog(jobId, `Ошибка: ${e.message}`);
        });

        return res.json({ success: true, started: true, jobId, replayFrom: prevRows[0].id });
    });

    router.post('/stop', async (req, res) => {
        const { mySiteId } = req.body;
        if (!mySiteId) return res.status(400).json({ error: 'mySiteId required' });
        const running = await getFreshRunningJob(mySiteId);
        if (!running) return res.status(404).json({ error: 'Активная задача не найдена' });
        const jobId = running.id;
        cancelledJobs.add(jobId);
        await addJobLog(jobId, 'Запрошена остановка задачи');
        await updateJob(jobId, { message: 'Остановка задачи...' });
        return res.json({ success: true, jobId });
    });

    // Для обратной совместимости старого фронта
    router.post('/find-matches', async (req, res) => {
        try {
            const result = await executeMatching(req.body);
            res.json({ success: true, ...result });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    router.get('/status', async (req, res) => {
        const { my_site_id } = req.query;
        if (!my_site_id) return res.status(400).json({ error: 'my_site_id required' });
        await getFreshRunningJob(my_site_id);
        const [jobs] = await db.query(
            'SELECT * FROM matching_jobs WHERE my_site_id = ? ORDER BY id DESC LIMIT 1',
            [my_site_id]
        );
        if (!jobs.length) {
            return res.json({ active: false, done: false, processed: 0, total: 0, found: 0, logs: [], message: 'Нет задач' });
        }
        const job = jobs[0];
        const [logs] = await db.query(
            'SELECT message, created_at FROM matching_job_logs WHERE job_id = ? ORDER BY id DESC LIMIT 20',
            [job.id]
        );
        return res.json({
            id: job.id,
            active: job.status === 'running',
            done: job.status === 'completed' || job.status === 'failed',
            status: job.status,
            processed: job.processed || 0,
            total: job.total || 0,
            found: job.found || 0,
            foundSku: job.found_sku || 0,
            foundName: job.found_name || 0,
            message: job.message || '',
            logs: logs.map((l) => {
                const t = new Date(l.created_at).toLocaleTimeString('ru-RU');
                return `[${t}] ${l.message}`;
            }),
            canRetry: job.status === 'failed' || job.status === 'completed'
        });
    });

    // 4. Получить список сопоставлений (с фильтрами)
    router.get('/list', async (req, res) => {
        const { my_site_id, status = 'pending', limit = 100, offset = 0 } = req.query;
        
        try {
            await ensureMatchAuditColumns();
            await ensureProductMatchesOptionalCols();
            let q = `
                SELECT 
                    pm.*,
                    pr.domain AS competitor_domain
                FROM product_matches pm
                LEFT JOIN projects pr ON pr.id = pm.competitor_site_id
                WHERE 1=1
            `;
            let qc = 'SELECT COUNT(*) as total FROM product_matches WHERE 1=1';
            let p = [], pc = [];

            if (my_site_id) { q += ' AND pm.my_site_id = ?'; qc += ' AND my_site_id = ?'; p.push(my_site_id); pc.push(my_site_id); }
            if (status) { q += ' AND pm.status = ?'; qc += ' AND status = ?'; p.push(status); pc.push(status); }

            q += ' ORDER BY pm.confidence_score DESC, pm.id DESC LIMIT ? OFFSET ?';
            p.push(parseInt(limit), parseInt(offset));

            const [rows] = await db.query(q, p);
            const [count] = await db.query(qc, pc);
            if (!rows.length) {
                return res.json({ data: [], total: Number(count?.[0]?.total || 0) });
            }

            const compSiteIds = Array.from(new Set(rows.map((r) => Number(r.competitor_site_id)).filter(Number.isFinite)));
            const mySiteIds = Array.from(new Set(rows.map((r) => Number(r.my_site_id)).filter(Number.isFinite)));
            const compSkus = Array.from(new Set(rows.map((r) => String(r.competitor_sku || '').trim()).filter(Boolean)));
            const compNames = Array.from(new Set(rows.map((r) => String(r.competitor_name || '').trim()).filter(Boolean)));
            const mySkus = Array.from(new Set(rows.map((r) => String(r.my_sku || '').trim()).filter(Boolean)));
            const myNames = Array.from(new Set(rows.map((r) => String(r.my_product_name || '').trim()).filter(Boolean)));

            const compBySku = new Map();
            const compByName = new Map();
            if (compSiteIds.length && (compSkus.length || compNames.length)) {
                const whereParts = [];
                const params = [...compSiteIds];
                if (compSkus.length) {
                    whereParts.push(`p.sku IN (${compSkus.map(() => '?').join(',')})`);
                    params.push(...compSkus);
                }
                if (compNames.length) {
                    whereParts.push(`p.product_name IN (${compNames.map(() => '?').join(',')})`);
                    params.push(...compNames);
                }
                const [compRows] = await db.query(
                    `SELECT p.project_id, p.sku, p.product_name, p.price, p.currency, p.url, p.parsed_at, p.id
                     FROM prices p
                     WHERE p.project_id IN (${compSiteIds.map(() => '?').join(',')})
                       AND (${whereParts.join(' OR ')})
                     ORDER BY p.parsed_at DESC, p.id DESC`,
                    params
                );
                for (const r of compRows) {
                    const sku = String(r.sku || '').trim();
                    const name = String(r.product_name || '').trim();
                    if (sku) {
                        const keySku = `${r.project_id}||${sku}`;
                        if (!compBySku.has(keySku)) compBySku.set(keySku, r);
                    }
                    if (name) {
                        const keyName = `${r.project_id}||${name}`;
                        if (!compByName.has(keyName)) compByName.set(keyName, r);
                    }
                }
            }

            const myBySku = new Map();
            const myByName = new Map();
            if (mySiteIds.length && (mySkus.length || myNames.length)) {
                const whereParts = [];
                const params = [...mySiteIds];
                if (mySkus.length) {
                    whereParts.push(`mp.sku IN (${mySkus.map(() => '?').join(',')})`);
                    params.push(...mySkus);
                }
                if (myNames.length) {
                    whereParts.push(`mp.name IN (${myNames.map(() => '?').join(',')})`);
                    params.push(...myNames);
                }
                const [myRows] = await db.query(
                    `SELECT mp.site_id, mp.sku, mp.name, mp.price, mp.currency, mp.source_url, mp.source_id, mp.updated_at, mp.id
                     FROM my_products mp
                     WHERE mp.is_active = 1
                       AND mp.site_id IN (${mySiteIds.map(() => '?').join(',')})
                       AND (${whereParts.join(' OR ')})
                     ORDER BY mp.updated_at DESC, mp.id DESC`,
                    params
                );
                for (const r of myRows) {
                    const sku = String(r.sku || '').trim();
                    const name = String(r.name || '').trim();
                    if (sku) {
                        const keySku = `${r.site_id}||${sku}`;
                        if (!myBySku.has(keySku)) myBySku.set(keySku, r);
                    }
                    if (name) {
                        const keyName = `${r.site_id}||${name}`;
                        if (!myByName.has(keyName)) myByName.set(keyName, r);
                    }
                }
            }

            const mySiteMeta = new Map();
            if (mySiteIds.length) {
                const [siteRows] = await db.query(
                    `SELECT id, domain, cms_type
                     FROM my_sites
                     WHERE id IN (${mySiteIds.map(() => '?').join(',')})`,
                    mySiteIds
                );
                siteRows.forEach((s) => mySiteMeta.set(Number(s.id), s));
            }

            const merged = rows.map((m) => {
                const compSku = String(m.competitor_sku || '').trim();
                const compName = String(m.competitor_name || '').trim();
                const mySku = String(m.my_sku || '').trim();
                const myName = String(m.my_product_name || '').trim();
                const compMatch =
                    (compSku ? compBySku.get(`${m.competitor_site_id}||${compSku}`) : null) ||
                    (compName ? compByName.get(`${m.competitor_site_id}||${compName}`) : null) ||
                    null;
                const myMatch =
                    (mySku ? myBySku.get(`${m.my_site_id}||${mySku}`) : null) ||
                    (myName ? myByName.get(`${m.my_site_id}||${myName}`) : null) ||
                    null;
                const siteMeta = mySiteMeta.get(Number(m.my_site_id)) || {};
                return {
                    ...m,
                    my_price: myMatch?.price ?? m.my_price ?? null,
                    my_currency: myMatch?.currency || m.my_currency || null,
                    competitor_url: compMatch?.url || null,
                    competitor_price: compMatch?.price ?? null,
                    competitor_currency: compMatch?.currency || null,
                    competitor_parsed_at: compMatch?.parsed_at || null,
                    my_product_url: myMatch?.source_url || null,
                    my_source_id: myMatch?.source_id || null,
                    my_site_domain: siteMeta?.domain || null,
                    my_site_cms_type: siteMeta?.cms_type || null
                };
            });

            res.json({ data: merged, total: Number(count?.[0]?.total || 0) });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // 5. Подтвердить сопоставление
    router.post('/confirm', async (req, res) => {
        const { id } = req.body;
        try {
            await ensureMatchAuditColumns();
            const actor = await resolveActorDisplayName(req);
            await db.query(
                'UPDATE product_matches SET status = "confirmed", confirmed_by = ?, confirmed_at = NOW(), unlinked_by = NULL, unlinked_at = NULL WHERE id = ?',
                [actor, id]
            );
            res.json({ success: true });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // 6. Отклонить сопоставление
    router.post('/reject', async (req, res) => {
        const { id } = req.body;
        try {
            await db.query('UPDATE product_matches SET status = "rejected" WHERE id = ?', [id]);
            res.json({ success: true });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    router.post('/unlink', async (req, res) => {
        const { id } = req.body;
        try {
            await ensureMatchAuditColumns();
            const actor = await resolveActorDisplayName(req);
            await db.query(
                'UPDATE product_matches SET status = "pending", confirmed_by = NULL, confirmed_at = NULL, unlinked_by = ?, unlinked_at = NOW() WHERE id = ?',
                [actor, id]
            );
            res.json({ success: true });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    router.watchdogTick = async function watchdogTick() {
        await cleanupStaleRunningJobs(180);
    };

    /** Вынесено из GET /list: создание индексов на больших таблицах не должно блокировать загрузку страницы. */
    router.warmupMatchingIndexes = async function warmupMatchingIndexes() {
        await ensureMatchesPerfIndexes();
    };

    return router;
};
