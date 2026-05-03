const express = require('express');
const { recordDatagonActivity } = require('../lib/datagonActivity');
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

/** Нормализация SKU/названия из product_matches ↔ my_products (NBSP, zero-width, trim). */
function normalizeProductMatchLookup(v) {
    return String(v || '')
        .replace(/\u00a0/g, ' ')
        .replace(/[\u200b-\u200d\ufeff]/g, '')
        .trim();
}

/** Одна строка DP Левенштейна; если итоговое расстояние > maxDist, возвращает maxDist+1 (ранний отказ не делаем — maxDist уже узкий). */
function levenshteinBounded(a, b, maxDist) {
    if (a === b) return 0;
    const m = a.length;
    const n = b.length;
    if (m === 0) return n <= maxDist ? n : maxDist + 1;
    if (n === 0) return m <= maxDist ? m : maxDist + 1;
    if (Math.abs(m - n) > maxDist) return maxDist + 1;
    const row = new Array(n + 1);
    for (let j = 0; j <= n; j += 1) row[j] = j;
    for (let i = 1; i <= m; i += 1) {
        let prevDiag = row[0];
        row[0] = i;
        for (let j = 1; j <= n; j += 1) {
            const tmp = row[j];
            const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
            row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prevDiag + cost);
            prevDiag = tmp;
        }
    }
    const d = row[n];
    return d > maxDist ? maxDist + 1 : d;
}

/**
 * Схожесть по нормализованным строкам (уже lower-case).
 * Отсечения без полного LD: верхняя граница score при лучшем расстоянии |L1-L2| = minL/maxL;
 * затем LD только если потенциально score > bestScore и >= threshold.
 */
function nameSimilarityThresholded(normMy, normComp, threshold, bestScore) {
    const L1 = normMy.length;
    const L2 = normComp.length;
    if (L1 < 3 || L2 < 3) return 0;
    if (normMy === normComp) return 1;
    const maxL = Math.max(L1, L2);
    const minL = Math.min(L1, L2);
    if (minL / maxL < threshold) return 0;
    const minDiff = Math.abs(L1 - L2);
    const maxDistForThreshold = maxL * (1 - threshold);
    if (minDiff > maxDistForThreshold + 1e-12) return 0;
    const bar = Math.max(threshold, bestScore);
    let maxDist = Math.floor(maxL * (1 - bar) + 1e-12);
    if (maxDist < 0) maxDist = 0;
    const d = levenshteinBounded(normMy, normComp, maxDist);
    if (d > maxDist) return 0;
    return (maxL - d) / maxL;
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

/** Один проход по прайсу конкурента: O(1) поиск по строгому SKU для режимов all/sku. */
function buildStrictSkuLookupMap(compPrices) {
    const m = new Map();
    for (const c of compPrices) {
        const k = strictSkuKey(c.sku);
        if (k && !m.has(k)) m.set(k, c);
    }
    return m;
}

/** Первое вхождение по нормализованному SKU (порядок строк как в массиве compPrices). */
function buildNormSkuFirstLookupMap(compPrices) {
    const m = new Map();
    for (const c of compPrices) {
        const nk = normalizeSkuForMatch(c.sku);
        if (nk && !m.has(nk)) m.set(nk, c);
    }
    return m;
}

/** Лучшая строка по ключу нормализованного SKU (parsed_at, затем имя и SKU). */
function buildNormSkuBestLookupMap(compPrices) {
    const byNorm = new Map();
    for (const c of compPrices) {
        const nk = normalizeSkuForMatch(c.sku);
        if (!nk) continue;
        let arr = byNorm.get(nk);
        if (!arr) {
            arr = [];
            byNorm.set(nk, arr);
        }
        arr.push(c);
    }
    const out = new Map();
    for (const [nk, cand] of byNorm) {
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
        out.set(nk, cand[0]);
    }
    return out;
}

/**
 * То же, что buildNormSkuBestLookupMap, но с setImmediate и isCancelled —
 * синхронная сборка + сортировки по каждому ключу на большом прайсе иначе
 * блокируют Node: POST /stop и completeCancellation не выполняются минутами.
 */
async function buildNormSkuBestLookupMapAsync(compPrices, isCancelled) {
    const byNorm = new Map();
    const n = compPrices.length;
    for (let i = 0; i < n; i += 1) {
        if ((i & 1023) === 0) {
            if (isCancelled()) return null;
            await new Promise((r) => setImmediate(r));
        }
        const c = compPrices[i];
        const nk = normalizeSkuForMatch(c.sku);
        if (!nk) continue;
        let arr = byNorm.get(nk);
        if (!arr) {
            arr = [];
            byNorm.set(nk, arr);
        }
        arr.push(c);
    }
    const out = new Map();
    let j = 0;
    for (const [nk, cand] of byNorm) {
        if ((j & 127) === 0) {
            if (isCancelled()) return null;
            await new Promise((r) => setImmediate(r));
        }
        j += 1;
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
        out.set(nk, cand[0]);
    }
    return out;
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Пауза с периодической проверкой отмены — иначе sleep(1000+) задерживает реакцию на «Остановить». */
async function sleepInterruptible(ms, isCancelled) {
    if (typeof isCancelled !== 'function') return false;
    const step = 200;
    let left = Math.max(0, Number(ms) || 0);
    while (left > 0) {
        if (isCancelled()) return true;
        const chunk = Math.min(step, left);
        await sleep(chunk);
        left -= chunk;
    }
    return isCancelled();
}

/** ISO UTC для ответа API; нулевая/битая дата из MySQL даёт null. */
function isoFromDbDate(v) {
    if (v == null || v === '') return null;
    const d = v instanceof Date ? v : new Date(v);
    if (Number.isNaN(d.getTime())) return null;
    return d.toISOString();
}

module.exports = (db, settings) => {
    async function recordMatchingStartActivity(req, meta) {
        const actor = req.datagonActor;
        if (!actor || !actor.id) return;
        const {
            jobId,
            mySiteId,
            mode,
            productSearch = '',
            productIds,
            competitorIds,
            threshold,
            replayFromId = null,
        } = meta;
        const sid = parseInt(String(mySiteId), 10);
        if (!Number.isFinite(sid) || sid < 1) return;
        let siteLabel = `сайт #${sid}`;
        try {
            const [srows] = await db.query('SELECT name FROM my_sites WHERE id = ? LIMIT 1', [sid]);
            if (srows.length && srows[0].name) siteLabel = `${srows[0].name} (#${mySiteId})`;
        } catch (_) {}

        const pidList = Array.isArray(productIds)
            ? productIds.map((x) => parseInt(x, 10)).filter((n) => Number.isFinite(n) && n > 0)
            : [];
        let productsPreview = [];
        if (pidList.length) {
            try {
                const slice = pidList.slice(0, 20);
                const ph = slice.map(() => '?').join(',');
                const [prows] = await db.query(
                    `SELECT id, sku, name FROM my_products WHERE site_id = ? AND id IN (${ph}) LIMIT 20`,
                    [sid, ...slice]
                );
                productsPreview = prows.map((r) => ({
                    id: r.id,
                    sku: String(r.sku || '').slice(0, 64),
                    name: String(r.name || '').slice(0, 80),
                }));
            } catch (_) {}
        }
        const compIds = Array.isArray(competitorIds)
            ? competitorIds.map((x) => parseInt(x, 10)).filter((n) => Number.isFinite(n) && n > 0)
            : [];
        const ps = String(productSearch || '').trim();
        const labelParts = [
            replayFromId ? 'Повтор сопоставления' : 'Запуск сопоставления',
            siteLabel,
            `режим: ${mode}`,
        ];
        if (ps) labelParts.push(`фильтр: «${ps.slice(0, 80)}»`);
        if (pidList.length) labelParts.push(`выбрано товаров: ${pidList.length}`);
        else if (!ps) labelParts.push('все активные товары сайта');

        const detail = JSON.stringify({
            action: replayFromId ? 'matching_retry' : 'matching_start',
            job_id: jobId,
            my_site_id: sid,
            site_label: siteLabel,
            mode,
            product_search: ps.slice(0, 200),
            product_ids: pidList.slice(0, 500),
            product_ids_count: pidList.length,
            products_preview: productsPreview,
            competitor_ids: compIds.slice(0, 40),
            threshold: Number(threshold),
            replay_from_job_id: replayFromId,
        });

        await recordDatagonActivity(db, {
            userId: actor.id,
            kind: 'ui',
            section: 'matches',
            label: labelParts.join(' · ').slice(0, 512),
            detail,
        });
    }

    const cancelledJobs = new Set();
    let perfIndexesReady = false;
    let matchAuditColumnsReady = false;
    let productMatchesOptionalColsReady = false;
    let matchJobPhasesColReady = false;

    async function ensureMatchingJobPhasesColumn() {
        if (matchJobPhasesColReady) return;
        try {
            const [rows] = await db.query(
                `SELECT 1 FROM information_schema.COLUMNS
                 WHERE TABLE_SCHEMA = DATABASE()
                   AND TABLE_NAME = 'matching_jobs'
                   AND COLUMN_NAME = 'phases_json'
                 LIMIT 1`
            );
            if (!rows.length) await db.query('ALTER TABLE matching_jobs ADD COLUMN phases_json LONGTEXT NULL');
        } catch (_) {}
        matchJobPhasesColReady = true;
    }

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
            { name: 'unlinked_at', ddl: 'ALTER TABLE product_matches ADD COLUMN unlinked_at TIMESTAMP NULL' },
            { name: 'rejected_by', ddl: 'ALTER TABLE product_matches ADD COLUMN rejected_by VARCHAR(100) NULL' },
            { name: 'rejected_at', ddl: 'ALTER TABLE product_matches ADD COLUMN rejected_at TIMESTAMP NULL' }
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

    let matchLaneTablesReady = false;
    async function ensureMatchLaneTables() {
        if (matchLaneTablesReady) return;
        const tables = [
            `CREATE TABLE IF NOT EXISTS match_exclusion (
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
            )`,
            `CREATE TABLE IF NOT EXISTS match_manual_archive (
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
            )`,
            `CREATE TABLE IF NOT EXISTS match_product_log (
                id BIGINT AUTO_INCREMENT PRIMARY KEY,
                my_site_id INT NOT NULL,
                my_product_id INT NOT NULL,
                competitor_site_id INT NULL,
                event VARCHAR(64) NOT NULL,
                message VARCHAR(512) NULL,
                detail_json LONGTEXT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                INDEX idx_mplog_prod (my_site_id, my_product_id, id)
            )`
        ];
        for (const ddl of tables) {
            try {
                await db.query(ddl);
            } catch (_) {}
        }
        matchLaneTablesReady = true;
    }

    async function appendMatchProductLog(dbConn, { my_site_id, my_product_id, competitor_site_id, event, message, detail }) {
        try {
            const detailJson =
                detail && typeof detail === 'object' ? JSON.stringify(detail).slice(0, 60000) : detail ? String(detail).slice(0, 60000) : null;
            await dbConn.query(
                `INSERT INTO match_product_log (my_site_id, my_product_id, competitor_site_id, event, message, detail_json)
                 VALUES (?, ?, ?, ?, ?, ?)`,
                [
                    my_site_id,
                    my_product_id,
                    competitor_site_id == null ? null : competitor_site_id,
                    String(event || '').slice(0, 64),
                    message ? String(message).slice(0, 512) : null,
                    detailJson
                ]
            );
        } catch (_) {}
    }

    async function resolveMyProductId(dbConn, mySiteId, sku, name) {
        const s = normalizeProductMatchLookup(sku);
        const n = normalizeProductMatchLookup(name);
        if (!s && !n) return null;
        const [rows] = await dbConn.query(
            `SELECT id FROM my_products
             WHERE site_id = ?
               AND (
                 (? <> '' AND TRIM(UPPER(IFNULL(sku, ''))) = TRIM(UPPER(?)))
                 OR (? <> '' AND LOWER(TRIM(IFNULL(name, ''))) = LOWER(TRIM(?)))
                 OR (? <> '' AND TRIM(IFNULL(sku, '')) = TRIM(?))
                 OR (? <> '' AND TRIM(IFNULL(name, '')) = TRIM(?))
               )
             ORDER BY is_active DESC, id DESC
             LIMIT 1`,
            [mySiteId, s, s, n, n, s, s, n, n]
        );
        if (rows && rows.length) return Number(rows[0].id);
        return null;
    }

    async function hasConfirmedMatchForProduct(dbConn, mySiteId, compId, myProd) {
        const [rows] = await dbConn.query(
            `SELECT 1 AS ok
             FROM product_matches pm
             WHERE pm.my_site_id = ? AND pm.competitor_site_id = ? AND pm.status = 'confirmed'
               AND (
                 (TRIM(IFNULL(pm.my_sku, '')) <> '' AND TRIM(pm.my_sku) = TRIM(?))
                 OR (TRIM(IFNULL(pm.my_product_name, '')) <> '' AND pm.my_product_name = ?)
               )
             LIMIT 1`,
            [mySiteId, compId, myProd.sku || '', myProd.name || '']
        );
        return !!(rows && rows.length);
    }

    async function upsertExclusionNoMatch(dbConn, mySiteId, compId, myProd) {
        if (!myProd || !Number.isFinite(Number(myProd.id))) return;
        if (await hasConfirmedMatchForProduct(dbConn, mySiteId, compId, myProd)) return;
        const [exRows] = await dbConn.query(
            'SELECT id, reason FROM match_exclusion WHERE my_site_id = ? AND competitor_site_id = ? AND my_product_id = ? LIMIT 1',
            [mySiteId, compId, myProd.id]
        );
        if (!exRows.length) {
            await dbConn.query(
                `INSERT INTO match_exclusion (my_site_id, competitor_site_id, my_product_id, reason, source_product_match_id)
                 VALUES (?, ?, ?, 'no_match', NULL)`,
                [mySiteId, compId, myProd.id]
            );
            return;
        }
        if (String(exRows[0].reason || '').toLowerCase() === 'rejected') return;
        await dbConn.query('UPDATE match_exclusion SET reason = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [
            'no_match',
            exRows[0].id
        ]);
    }

    async function upsertExclusionRejected(dbConn, { my_site_id, competitor_site_id, my_product_id, source_product_match_id, rejected_by }) {
        if (!Number.isFinite(Number(my_site_id)) || !Number.isFinite(Number(competitor_site_id)) || !Number.isFinite(Number(my_product_id))) return;
        await dbConn.query(
            `INSERT INTO match_exclusion (my_site_id, competitor_site_id, my_product_id, reason, source_product_match_id)
             VALUES (?, ?, ?, 'rejected', ?)
             ON DUPLICATE KEY UPDATE
               reason = 'rejected',
               source_product_match_id = COALESCE(VALUES(source_product_match_id), source_product_match_id),
               updated_at = CURRENT_TIMESTAMP`,
            [my_site_id, competitor_site_id, my_product_id, source_product_match_id || null]
        );
        const who = String(rejected_by || '').trim() || 'unknown';
        const msg =
            who && who !== 'unknown'
                ? `Авто-совпадение отклонено пользователем «${who}» — товар вынесен в ручную очередь`
                : 'Авто-совпадение отклонено — товар вынесен в ручную очередь';
        await appendMatchProductLog(dbConn, {
            my_site_id,
            my_product_id,
            competitor_site_id,
            event: 'exclusion_rejected',
            message: msg.slice(0, 512),
            detail: { source_product_match_id: source_product_match_id || null, rejected_by: who }
        });
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

    /** Строка совпадения + подписи сайта и проекта конкурента — для журнала активности (полные названия в detail). */
    async function loadProductMatchActivityRow(matchId) {
        const mid = parseInt(String(matchId), 10);
        if (!Number.isFinite(mid) || mid < 1) return null;
        try {
            const [rows] = await db.query(
                `SELECT pm.id,
                        pm.my_site_id,
                        pm.competitor_site_id,
                        pm.my_sku,
                        pm.my_product_name,
                        pm.competitor_sku,
                        pm.competitor_name,
                        pm.match_type,
                        pm.matching_mode,
                        pm.status,
                        pm.confidence_score,
                        ms.name AS my_site_name,
                        COALESCE(
                            NULLIF(TRIM(pr.name), ''),
                            NULLIF(TRIM(pr.domain), ''),
                            CONCAT('Проект ', pm.competitor_site_id)
                        ) AS competitor_project_label
                 FROM product_matches pm
                 LEFT JOIN my_sites ms ON ms.id = pm.my_site_id
                 LEFT JOIN projects pr ON pr.id = pm.competitor_site_id
                 WHERE pm.id = ?
                 LIMIT 1`,
                [mid]
            );
            return rows.length ? rows[0] : null;
        } catch (_) {
            return null;
        }
    }

    async function recordMatchesListUiActivity(req, verb, row, extra = {}) {
        const actorUser = req.datagonActor;
        if (!actorUser || !actorUser.id || !row) return;
        const title =
            verb === 'reject'
                ? 'Отклонено сопоставление'
                : verb === 'confirm'
                  ? 'Подтверждено сопоставление'
                  : 'Разорвана пара сопоставления';
        const myName = String(row.my_product_name || '').trim() || '— (без названия)';
        const mySku = String(row.my_sku || '').trim();
        const compName = String(row.competitor_name || '').trim() || '— (без названия у конкурента)';
        const compSku = String(row.competitor_sku || '').trim();
        const site = String(row.my_site_name || '').trim() || `сайт #${row.my_site_id}`;
        const compProj = String(row.competitor_project_label || '').trim() || `проект #${row.competitor_site_id}`;
        const parts = [title, `наш товар: «${myName}»`];
        if (mySku) parts.push(`наш SKU: ${mySku}`);
        parts.push(`конкурент: «${compName}»`);
        if (compSku) parts.push(`SKU конкурента: ${compSku}`);
        parts.push(site);
        parts.push(compProj);
        parts.push(`запись #${row.id}`);
        let label = parts.join(' · ');
        if (label.length > 512) label = `${label.slice(0, 509)}…`;
        const detail = JSON.stringify({
            ui_action:
                verb === 'reject' ? 'matches_reject' : verb === 'confirm' ? 'matches_confirm' : 'matches_unlink',
            product_match_id: row.id,
            my_site_id: row.my_site_id,
            my_site_name: row.my_site_name || null,
            competitor_site_id: row.competitor_site_id,
            competitor_project_label: row.competitor_project_label || null,
            my_product_name_full: String(row.my_product_name || '').trim() || null,
            my_sku: mySku || null,
            competitor_name_full: String(row.competitor_name || '').trim() || null,
            competitor_sku: compSku || null,
            match_type: row.match_type || null,
            matching_mode: row.matching_mode || null,
            confidence_score: row.confidence_score != null ? row.confidence_score : null,
            status_before: row.status || null,
            ...extra,
        });
        await recordDatagonActivity(db, {
            userId: actorUser.id,
            kind: 'ui',
            section: 'matches',
            label,
            detail,
        });
    }

    async function getFreshRunningJob(mySiteId, staleAfterSec = 600) {
        try {
            const [jobs] = await db.query(
                `SELECT id, my_site_id, status, message, processed, total, started_at, finished_at
                 FROM matching_jobs
                 WHERE my_site_id = ? AND status = "running"
                 ORDER BY id DESC
                 LIMIT 1`,
                [mySiteId]
            );
            if (!jobs.length) return null;
            const job = jobs[0];
            const [[agg]] = await db.query(
                'SELECT MAX(created_at) AS max_at FROM matching_job_logs WHERE job_id = ?',
                [job.id]
            );
            const [[idler]] = await db.query(
                'SELECT TIMESTAMPDIFF(SECOND, COALESCE(?, ?), NOW()) AS idle_sec',
                [agg?.max_at || null, job.started_at]
            );
            const idleSec = Number(idler?.idle_sec || 0);
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
        } catch (e) {
            console.error('[matches] getFreshRunningJob:', e && e.message ? e.message : e);
            return null;
        }
    }

    async function cleanupStaleRunningJobs(staleAfterSec = 600) {
        let rows;
        try {
            const [running] = await db.query(
                `SELECT id, my_site_id, params_json, checkpoint_comp_index, checkpoint_product_index, started_at
                 FROM matching_jobs
                 WHERE status = "running"
                 ORDER BY id DESC
                 LIMIT 50`
            );
            if (!running.length) return;
            const ids = running.map((r) => r.id);
            const [logAgg] = await db.query(
                `SELECT job_id, MAX(created_at) AS max_at
                 FROM matching_job_logs
                 WHERE job_id IN (${ids.map(() => '?').join(',')})
                 GROUP BY job_id`,
                ids
            );
            const logMap = new Map((logAgg || []).map((x) => [x.job_id, x.max_at]));
            const nowMs = Date.now();
            rows = running.map((r) => {
                const mx = logMap.get(r.id);
                const refMs = mx ? new Date(mx).getTime() : new Date(r.started_at).getTime();
                const idleSec = Math.max(0, Math.floor((nowMs - refMs) / 1000));
                return { ...r, idle_sec: idleSec };
            });
        } catch (e) {
            console.error('[matches] cleanupStaleRunningJobs:', e && e.message ? e.message : e);
            return;
        }
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
                const wSku = Math.max(0, Math.floor(Number(row.found_sku) || 0));
                const wNm = Math.max(0, Math.floor(Number(row.found_name) || 0));
                const wFd = Math.max(0, Math.floor(Number(row.found) || 0));
                const [ins] = await db.query(
                    'INSERT INTO matching_jobs (my_site_id, status, message, params_json, checkpoint_comp_index, checkpoint_product_index, processed, total, found, found_sku, found_name, started_at) VALUES (?, "running", "Watchdog: автовосстановление задачи...", ?, ?, ?, 0, 0, ?, ?, ?, NOW())',
                    [
                        row.my_site_id,
                        JSON.stringify(replayPayload),
                        replayPayload.startCompIndex,
                        replayPayload.startProductIndex,
                        wFd || wSku + wNm,
                        wSku,
                        wNm
                    ]
                );
                const newJobId = ins.insertId;
                await addJobLog(newJobId, `Watchdog: автоповтор задачи #${row.id}`);
                executeMatching({
                    jobId: newJobId,
                    ...replayPayload,
                    seedFoundSku: Number(row.found_sku) || 0,
                    seedFoundName: Number(row.found_name) || 0,
                    resumeProcessedBaseHint: row.processed
                }).catch(async (e) => {
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
        batchPauseMs = 200,
        microPauseMs = 20,
        microPauseEvery = 20,
        /** При retry/watchdog — перенос счётчиков «найдено» с прерванной задачи (иначе в UI снова с нуля). */
        seedFoundSku = 0,
        seedFoundName = 0,
        /** При resume — поле processed последней задачи (точнее, чем COUNT(*) по всему сайту). */
        resumeProcessedBaseHint = null
    }) {
        mode = sanitizeMatchingMode(mode);
        /** Счётчики «по SKU / по названию» сразу из seed (продолжение), чтобы UI не показывал 0 на фазе загрузки товаров. */
        let foundSku = Math.max(0, Math.floor(Number(seedFoundSku) || 0));
        let foundName = Math.max(0, Math.floor(Number(seedFoundName) || 0));
        const withRunningCounters = (patch) => ({ ...patch, found_sku: foundSku, found_name: foundName });
        await ensureProductMatchesOptionalCols();
        await ensureMatchesPerfIndexes();
        await ensureMatchingJobPhasesColumn();
        const jobPhases = [];
        /** Пакетная запись строк «SKU -> SKU (sku)» — иначе десятки тысяч отдельных INSERT в лог сильно замедляют прогон. */
        const jobLogBuffer = [];
        /** @param {boolean} [drainAll] если true — дописать весь буфер (при completeCancellation), иначе можно прервать между чанками при отмене */
        async function flushJobLogs(drainAll = false) {
            while (jobLogBuffer.length) {
                const chunk = jobLogBuffer.splice(0, 100);
                const ph = chunk.map(() => '(?, ?)').join(',');
                const flat = [];
                for (const line of chunk) {
                    flat.push(jobId, String(line).slice(0, 65000));
                }
                await db.query(`INSERT INTO matching_job_logs (job_id, message) VALUES ${ph}`, flat);
                if (!drainAll && cancelledJobs.has(jobId)) return;
            }
        }
        async function persistPhases() {
            await updateJob(jobId, { phases_json: JSON.stringify(jobPhases) });
        }
        async function phaseStart(key, title, meta) {
            jobPhases.push({
                key: String(key || ''),
                title: String(title || key || ''),
                startedAt: new Date().toISOString(),
                endedAt: null,
                durationMs: null,
                meta: meta && typeof meta === 'object' ? meta : {}
            });
            await persistPhases();
        }
        async function phaseEnd(result) {
            const p = jobPhases[jobPhases.length - 1];
            if (!p || p.endedAt) return;
            const end = new Date();
            p.endedAt = end.toISOString();
            p.durationMs = Math.max(0, end.getTime() - new Date(p.startedAt).getTime());
            p.result = { ...(p.result || {}), ...(result && typeof result === 'object' ? result : {}) };
            await new Promise((r) => setImmediate(r));
            await flushJobLogs();
            await persistPhases();
        }

        await updateJob(jobId, withRunningCounters({ message: 'Подготовка...' }));
        await addJobLog(jobId, 'Подготовка данных');
        await phaseStart('prepare', 'Подготовка данных', { mode, threshold, resumeMode, mySiteId });
        if (!resumeMode) {
            const modeNorm = String(mode || 'all').trim().toLowerCase() || 'all';
            const compIds = (competitorIds || [])
                .map((x) => parseInt(String(x).trim(), 10))
                .filter((n) => Number.isFinite(n) && n > 0);
            if (compIds.length) {
                const ph = compIds.map(() => '?').join(',');
                if (modeNorm === 'all') {
                    await db.query(
                        `DELETE FROM product_matches
                         WHERE my_site_id = ? AND status = 'pending' AND competitor_site_id IN (${ph})`,
                        [mySiteId, ...compIds]
                    );
                    await addJobLog(
                        jobId,
                        `Очищены ожидающие строки по выбранным конкурентам (режим «все поля»); другие сайты и подтверждённые/отклонённые записи не затронуты.`
                    );
                } else {
                    await db.query(
                        `DELETE FROM product_matches
                         WHERE my_site_id = ? AND status = 'pending'
                           AND competitor_site_id IN (${ph})
                           AND LOWER(TRIM(COALESCE(matching_mode, ''))) = ?`,
                        [mySiteId, ...compIds, modeNorm]
                    );
                    await addJobLog(
                        jobId,
                        `Очищены ожидающие только для режима «${modeNorm}» и выбранных конкурентов; результаты других режимов (SKU / название / …) по тем же конкурентам сохранены.`
                    );
                }
            } else {
                await db.query('DELETE FROM product_matches WHERE my_site_id = ? AND status = "pending"', [mySiteId]);
                await addJobLog(jobId, 'Очищены все ожидающие строки по сайту (нет списка конкурентов в задаче).');
            }
        } else {
            await addJobLog(jobId, 'Режим продолжения: pending-результаты не очищаются');
        }
        await phaseEnd({ clearedPending: !resumeMode });
        await phaseStart('load_my_products', 'Загрузка моих товаров', {
            productSearch: String(productSearch || '').trim().slice(0, 160),
            byIds: Boolean(Array.isArray(productIds) && productIds.length > 0)
        });
        await updateJob(jobId, withRunningCounters({ message: 'Загрузка моих активных товаров...' }));

        let myProducts = [];
        if (Array.isArray(productIds) && productIds.length > 0) {
            const ids = productIds.map((x) => parseInt(x, 10)).filter(Number.isFinite);
            if (ids.length === 0) {
                await phaseEnd({ error: 'no_valid_product_ids' });
                return { matches: [], count: 0 };
            }
            const placeholders = ids.map(() => '?').join(',');
            const [rows] = await db.query(
                `SELECT id, sku, name, price, currency FROM my_products WHERE site_id = ? AND is_active = 1 AND id IN (${placeholders})`,
                [mySiteId, ...ids]
            );
            myProducts = rows;
            await addJobLog(jobId, `Загружено выбранных товаров: ${myProducts.length}`);
            await phaseEnd({ source: 'selected_ids', count: myProducts.length });
        } else {
            const hasSearch = String(productSearch || '').trim().length > 0;
            const t0 = Date.now();
            await updateJob(jobId, withRunningCounters({ message: 'Подсчет объема моих товаров...' }));
            if (hasSearch) {
                const val = `%${String(productSearch).trim()}%`;
                const [[cntRow]] = await db.query(
                    'SELECT COUNT(*) AS cnt FROM my_products WHERE site_id = ? AND is_active = 1 AND (sku LIKE ? OR name LIKE ?)',
                    [mySiteId, val, val]
                );
                const totalProducts = Number(cntRow?.cnt || 0);
                await addJobLog(jobId, `Найдено моих товаров по фильтру: ${totalProducts}`);
                await updateJob(jobId, withRunningCounters({ message: `Загрузка моих товаров чанками... 0/${totalProducts}` }));
                const chunkSize = 2000;
                let offset = 0;
                while (offset < totalProducts) {
                    const [rows] = await db.query(
                        'SELECT id, sku, name, price, currency FROM my_products WHERE site_id = ? AND is_active = 1 AND (sku LIKE ? OR name LIKE ?) ORDER BY id DESC LIMIT ? OFFSET ?',
                        [mySiteId, val, val, chunkSize, offset]
                    );
                    myProducts.push(...rows);
                    offset += rows.length;
                    await updateJob(jobId, withRunningCounters({ message: `Загрузка моих товаров чанками... ${myProducts.length}/${totalProducts}` }));
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
                await updateJob(jobId, withRunningCounters({ message: `Загрузка моих товаров чанками... 0/${totalProducts}` }));
                const chunkSize = 2000;
                let offset = 0;
                while (offset < totalProducts) {
                    const [rows] = await db.query(
                        'SELECT id, sku, name, price, currency FROM my_products WHERE site_id = ? AND is_active = 1 ORDER BY id DESC LIMIT ? OFFSET ?',
                        [mySiteId, chunkSize, offset]
                    );
                    myProducts.push(...rows);
                    offset += rows.length;
                    await updateJob(jobId, withRunningCounters({ message: `Загрузка моих товаров чанками... ${myProducts.length}/${totalProducts}` }));
                    await addJobLog(jobId, `Чанк загружен: +${rows.length}, всего ${myProducts.length}/${totalProducts}`);
                    if (!rows.length) break;
                    await new Promise((resolve) => setImmediate(resolve));
                }
            }
            await addJobLog(jobId, `Загрузка моих товаров завершена за ${Math.round((Date.now() - t0) / 1000)}с`);
            await phaseEnd({
                source: String(productSearch || '').trim().length > 0 ? 'smart_filter' : 'all_active',
                count: myProducts.length,
                durationSec: Math.round((Date.now() - t0) / 1000)
            });
        }

        if (resumeMode) {
            await phaseStart('resume_filter', 'Фильтр продолжения (уже сопоставленные)', { competitorIds });
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
            await ensureMatchLaneTables();
            try {
                const [exResume] = await db.query(
                    `SELECT mp.sku, mp.name
                     FROM match_exclusion e
                     INNER JOIN my_products mp ON mp.id = e.my_product_id AND mp.site_id = e.my_site_id
                     WHERE e.my_site_id = ? AND e.competitor_site_id IN (${placeholders})`,
                    [mySiteId, ...competitorIds]
                );
                for (const r of exResume) {
                    matchedKeys.add(`${String(r.sku || '').trim().toUpperCase()}||${String(r.name || '').trim().toLowerCase()}`);
                }
            } catch (_) {}
            const before = myProducts.length;
            myProducts = myProducts.filter((p) => {
                const key = `${String(p.sku || '').trim().toUpperCase()}||${String(p.name || '').trim().toLowerCase()}`;
                return !matchedKeys.has(key);
            });
            await addJobLog(jobId, `Продолжение: пропущено уже обработанных ${before - myProducts.length}, осталось ${myProducts.length}`);
            await phaseEnd({ before, after: myProducts.length, skipped: before - myProducts.length });
        }

        if (myProducts.length === 0) {
            await updateJob(
                jobId,
                withRunningCounters({
                    status: 'completed',
                    processed: 0,
                    total: 0,
                    found: 0,
                    phases_json: JSON.stringify(jobPhases),
                    message: 'Нет активных товаров для сопоставления',
                    finished_at: new Date()
                })
            );
            await addJobLog(jobId, 'Нет активных товаров для сопоставления');
            return { matches: [], count: 0 };
        }

        const totalSteps = myProducts.length * competitorIds.length;
        let resumeProcessedBase = 0;
        if (resumeMode) {
            const hinted = resumeProcessedBaseHint != null ? Number(resumeProcessedBaseHint) : NaN;
            if (Number.isFinite(hinted) && hinted >= 0) {
                resumeProcessedBase = Math.floor(hinted);
            } else {
                const [alreadyRows] = await db.query(
                    'SELECT COUNT(*) AS cnt FROM product_matches WHERE my_site_id = ?',
                    [mySiteId]
                );
                resumeProcessedBase = Number(alreadyRows?.[0]?.cnt || 0);
            }
        }
        await updateJob(
            jobId,
            withRunningCounters({
                total: totalSteps + resumeProcessedBase,
                processed: resumeProcessedBase,
                message: 'Старт сопоставления...'
            })
        );
        await addJobLog(jobId, `Старт: товаров ${myProducts.length}, конкурентов ${competitorIds.length}`);
        if (resumeMode && (foundSku > 0 || foundName > 0)) {
            await addJobLog(
                jobId,
                `Счётчики «найдено» продолжают с предыдущей задачи: по SKU ${foundSku}, по названию ${foundName}`
            );
        }

        await ensureMatchLaneTables();
        const exclusionSet = new Set();
        if (competitorIds.length) {
            const phEx = competitorIds.map(() => '?').join(',');
            try {
                const [exRows] = await db.query(
                    `SELECT competitor_site_id, my_product_id FROM match_exclusion WHERE my_site_id = ? AND competitor_site_id IN (${phEx})`,
                    [mySiteId, ...competitorIds]
                );
                for (const r of exRows) {
                    exclusionSet.add(`${r.competitor_site_id}:${r.my_product_id}`);
                }
            } catch (_) {}
        }

        const pendingMatches = [];
        let totalMatchesSaved = 0;
        let processed = 0;
        let loopCounter = 0;
        let lastProgressLogMs = Date.now();
        const safeBatchSize = Math.max(1, parseInt(batchSize, 10) || 200);
        const parsedBatchPause = parseInt(batchPauseMs, 10);
        const safeBatchPauseMs =
            Number.isFinite(parsedBatchPause) && parsedBatchPause >= 0 ? parsedBatchPause : 200;
        const parsedMicroPause = parseInt(microPauseMs, 10);
        const safeMicroPauseMs =
            Number.isFinite(parsedMicroPause) && parsedMicroPause >= 0 ? parsedMicroPause : 20;
        const safeMicroPauseEvery = Math.max(1, parseInt(microPauseEvery, 10) || 20);
        const saveChunkSize = Math.max(50, Math.min(500, safeBatchSize));
        /** Внутри цикла по прайсу (режим name / fallback по названию) — иначе нет новых логов минутами → stale watchdog. */
        const NAME_MATCH_INNER_HEARTBEAT_MS = 30000;
        let lastNameInnerHeartbeatMs = Date.now();

        async function flushPendingMatchesCore() {
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

        async function flushPendingMatches() {
            await flushJobLogs();
            if (cancelledJobs.has(jobId)) {
                await completeCancellation(compPos, pIdx);
                return;
            }
            await flushPendingMatchesCore();
        }

        async function completeCancellation(compPos, pIdx) {
            await flushJobLogs(true);
            const pl = jobPhases[jobPhases.length - 1];
            if (pl && !pl.endedAt) {
                pl.endedAt = new Date().toISOString();
                pl.durationMs = Math.max(0, new Date(pl.endedAt).getTime() - new Date(pl.startedAt).getTime());
                pl.result = { ...(pl.result || {}), userCancelled: true };
                await persistPhases();
            }
            await flushPendingMatchesCore();
            await updateJob(
                jobId,
                withRunningCounters({
                    status: 'cancelled',
                    processed: resumeProcessedBase + processed,
                    checkpoint_comp_index: compPos,
                    checkpoint_product_index: pIdx,
                    phases_json: JSON.stringify(jobPhases),
                    message: 'Остановлено пользователем',
                    finished_at: new Date()
                })
            );
            await addJobLog(jobId, 'Задача остановлена пользователем');
            cancelledJobs.delete(jobId);
        }

        async function bailIfCancelled(compPos, pIdx) {
            if (!cancelledJobs.has(jobId)) return false;
            await completeCancellation(compPos, pIdx);
            return true;
        }

        for (let compPos = startCompIndex; compPos < competitorIds.length; compPos += 1) {
            const compId = competitorIds[compPos];
            const productStart = compPos === startCompIndex ? startProductIndex : 0;
            if (cancelledJobs.has(jobId)) {
                await completeCancellation(compPos, productStart);
                return { matches: [], count: totalMatchesSaved };
            }
            await updateJob(jobId, withRunningCounters({ message: `Загрузка товаров конкурента #${compId}...` }));
            await phaseStart(`c${compId}_prices`, `Конкурент ${compId}: загрузка прайса (SQL)`, { compId });
            const [compPrices] = await db.query(`
                SELECT p.sku, p.product_name, p.price, p.currency, p.url, pr.domain as project_domain,
                       MAX(p.parsed_at) AS parsed_at
                FROM prices p
                JOIN projects pr ON p.project_id = pr.id
                WHERE p.project_id = ?
                GROUP BY p.sku, p.product_name, p.price, p.currency, p.url, pr.domain
                ORDER BY MAX(p.parsed_at) DESC
            `, [compId]);
            await phaseEnd({ priceRows: compPrices.length });

            if (cancelledJobs.has(jobId)) {
                await completeCancellation(compPos, productStart);
                return { matches: [], count: totalMatchesSaved };
            }

            if (compPrices.length === 0) {
                await addJobLog(jobId, `Конкурент ${compId}: нет данных цен`);
                for (let ei = 0; ei < myProducts.length; ei += 1) {
                    if ((ei & 31) === 0 && cancelledJobs.has(jobId)) {
                        await completeCancellation(compPos, productStart);
                        return { matches: [], count: totalMatchesSaved };
                    }
                    const mpRow = myProducts[ei];
                    if (exclusionSet.has(`${compId}:${mpRow.id}`)) continue;
                    await upsertExclusionNoMatch(db, mySiteId, compId, mpRow);
                }
                processed += myProducts.length;
                await updateJob(jobId, withRunningCounters({ processed: resumeProcessedBase + processed }));
                continue;
            }

            await phaseStart(`c${compId}_index`, `Конкурент ${compId}: индексация прайса`, { compId, mode });
            let skuLookupStrict = null;
            let skuLookupNormFirst = null;
            let skuLookupNormBest = null;
            if (mode === 'all' || mode === 'sku') {
                skuLookupStrict = buildStrictSkuLookupMap(compPrices);
            } else if (mode === 'sku_norm') {
                skuLookupNormFirst = buildNormSkuFirstLookupMap(compPrices);
            } else if (mode === 'sku_best') {
                skuLookupNormBest = await buildNormSkuBestLookupMapAsync(compPrices, () =>
                    cancelledJobs.has(jobId)
                );
                if (!skuLookupNormBest) {
                    await completeCancellation(compPos, productStart);
                    return { matches: [], count: totalMatchesSaved };
                }
            }

            let compNormNames = null;
            if (mode === 'all' || mode === 'name') {
                const cn = compPrices.length;
                compNormNames = new Array(cn);
                for (let ci = 0; ci < cn; ci += 1) {
                    if ((ci & 4095) === 0 && cancelledJobs.has(jobId)) {
                        await completeCancellation(compPos, productStart);
                        return { matches: [], count: totalMatchesSaved };
                    }
                    compNormNames[ci] = normalizeText(compPrices[ci].product_name);
                    if (ci > 0 && (ci & 4095) === 0) {
                        await new Promise((r) => setImmediate(r));
                    }
                }
            }

            await phaseEnd({
                normNameRows: compNormNames ? compNormNames.length : 0,
                skuMap:
                    mode === 'all' || mode === 'sku'
                        ? 'strict'
                        : mode === 'sku_norm'
                            ? 'norm_first'
                            : mode === 'sku_best'
                                ? 'norm_best'
                                : 'none'
            });

            const foundSkuAtComp = foundSku;
            const foundNameAtComp = foundName;
            await phaseStart(`c${compId}_match`, `Конкурент ${compId}: сопоставление`, {
                compId,
                productsToScan: myProducts.length - productStart
            });

            let batchProcessedForCompetitor = 0;
            for (let pIdx = productStart; pIdx < myProducts.length; pIdx += 1) {
                const myProd = myProducts[pIdx];
                if (cancelledJobs.has(jobId)) {
                    await completeCancellation(compPos, pIdx);
                    return { matches: [], count: totalMatchesSaved };
                }
                if (exclusionSet.has(`${compId}:${myProd.id}`)) {
                    if (cancelledJobs.has(jobId)) {
                        await completeCancellation(compPos, pIdx);
                        return { matches: [], count: totalMatchesSaved };
                    }
                    processed += 1;
                    batchProcessedForCompetitor += 1;
                    loopCounter += 1;
                    if (loopCounter % safeMicroPauseEvery === 0) {
                        if (await bailIfCancelled(compPos, pIdx)) return { matches: [], count: totalMatchesSaved };
                        if (safeMicroPauseMs > 0) await sleep(safeMicroPauseMs);
                        await new Promise((resolve) => setImmediate(resolve));
                    }
                    if (batchProcessedForCompetitor % safeBatchSize === 0) {
                        await flushPendingMatches();
                        await updateJob(jobId, {
                            message: `Пауза между батчами (${safeBatchPauseMs}мс), пар товар×конкурент: ${resumeProcessedBase + processed}/${resumeProcessedBase + totalSteps}`,
                            processed: resumeProcessedBase + processed,
                            found_sku: foundSku,
                            found_name: foundName,
                            checkpoint_comp_index: compPos,
                            checkpoint_product_index: pIdx
                        });
                        await addJobLog(jobId, `Батч завершен: ${batchProcessedForCompetitor} по конкуренту ${compId}`);
                        if (safeBatchPauseMs > 0) {
                            const stopSleep = await sleepInterruptible(safeBatchPauseMs, () =>
                                cancelledJobs.has(jobId)
                            );
                            if (stopSleep && (await bailIfCancelled(compPos, pIdx))) {
                                return { matches: [], count: totalMatchesSaved };
                            }
                        }
                    }
                    continue;
                }
                if (processed % Math.max(10, Math.floor(safeBatchSize / 4)) === 0) {
                    await updateJob(jobId, {
                        processed: resumeProcessedBase + processed,
                        found_sku: foundSku,
                        found_name: foundName,
                        message: `Сопоставление: пар товар×конкурент ${resumeProcessedBase + processed} из ${resumeProcessedBase + totalSteps}`,
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
                        if (normMySkuStrict && skuLookupStrict) skuMatch = skuLookupStrict.get(normMySkuStrict) || null;
                    } else if (mode === 'sku_norm') {
                        if (normMySkuNorm && skuLookupNormFirst) skuMatch = skuLookupNormFirst.get(normMySkuNorm) || null;
                    } else if (mode === 'sku_best') {
                        if (normMySkuNorm && skuLookupNormBest) skuMatch = skuLookupNormBest.get(normMySkuNorm) || null;
                    }
                    if (skuMatch) {
                        bestMatch = skuMatch;
                        bestScore = 1.0;
                        matchType = 'sku';
                    }
                }

                if ((mode === 'all' || mode === 'name') && matchType !== 'sku' && normMyName.length > 3 && compNormNames) {
                    const nComp = compNormNames.length;
                    for (let ni = 0; ni < nComp; ni += 1) {
                        // Отмена на каждой строке: иначе до 128× тяжёлого Levenshtein без проверки — «Остановить» висит.
                        if (cancelledJobs.has(jobId)) {
                            await completeCancellation(compPos, pIdx);
                            return { matches: [], count: totalMatchesSaved };
                        }
                        if ((ni & 31) === 0) {
                            await new Promise((r) => setImmediate(r));
                            const now = Date.now();
                            if (now - lastNameInnerHeartbeatMs >= NAME_MATCH_INNER_HEARTBEAT_MS) {
                                lastNameInnerHeartbeatMs = now;
                                await addJobLog(
                                    jobId,
                                    `По названию: товар ${pIdx + 1}/${myProducts.length}, строк прайса ${ni}/${nComp} (конк. ${compId})`
                                );
                                await updateJob(
                                    jobId,
                                    withRunningCounters({
                                        message: `Сопоставление по названию: товар ${pIdx + 1}/${myProducts.length}, прайс ${ni}/${nComp}`
                                    })
                                );
                            }
                        }
                        const normCompName = compNormNames[ni];
                        if (normCompName.length < 3) continue;
                        const compProd = compPrices[ni];
                        const score = nameSimilarityThresholded(normMyName, normCompName, threshold, bestScore);
                        if (score >= threshold && score > bestScore) {
                            bestMatch = compProd;
                            bestScore = score;
                            matchType = 'name';
                            if (score >= 1) break;
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
                    jobLogBuffer.push(`${myProd.sku || myProd.name} -> ${bestMatch.sku || bestMatch.product_name} (${matchType})`);
                    if (jobLogBuffer.length >= 50) await flushJobLogs();
                    if (await bailIfCancelled(compPos, pIdx)) return { matches: [], count: totalMatchesSaved };
                    if (pendingMatches.length >= saveChunkSize) {
                        await flushPendingMatches();
                        if (await bailIfCancelled(compPos, pIdx)) return { matches: [], count: totalMatchesSaved };
                    }
                } else {
                    await upsertExclusionNoMatch(db, mySiteId, compId, myProd);
                    if (await bailIfCancelled(compPos, pIdx)) return { matches: [], count: totalMatchesSaved };
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
                const hbNow = Date.now();
                if (hbNow - lastProgressLogMs >= 60000) {
                    lastProgressLogMs = hbNow;
                    await addJobLog(
                        jobId,
                        `Прогресс пар: ${resumeProcessedBase + processed}/${resumeProcessedBase + totalSteps} (конк. ${compId})`
                    );
                }
                loopCounter += 1;

                // Важно: регулярно освобождаем event loop, чтобы API не "зависал"
                // во время долгого сопоставления на больших объемах данных.
                if (loopCounter % safeMicroPauseEvery === 0) {
                    if (await bailIfCancelled(compPos, pIdx)) return { matches: [], count: totalMatchesSaved };
                    if (safeMicroPauseMs > 0) {
                        await sleep(safeMicroPauseMs);
                    }
                    await new Promise((resolve) => setImmediate(resolve));
                }

                if (batchProcessedForCompetitor % safeBatchSize === 0) {
                    await flushPendingMatches();
                    if (await bailIfCancelled(compPos, pIdx)) return { matches: [], count: totalMatchesSaved };
                    await updateJob(jobId, {
                        message: `Пауза между батчами (${safeBatchPauseMs}мс), пар товар×конкурент: ${resumeProcessedBase + processed}/${resumeProcessedBase + totalSteps}`,
                        processed: resumeProcessedBase + processed,
                        found_sku: foundSku,
                        found_name: foundName,
                        checkpoint_comp_index: compPos,
                        checkpoint_product_index: pIdx
                    });
                    await addJobLog(jobId, `Батч завершен: ${batchProcessedForCompetitor} по конкуренту ${compId}`);
                    if (safeBatchPauseMs > 0) {
                        const stopSleep = await sleepInterruptible(safeBatchPauseMs, () =>
                            cancelledJobs.has(jobId)
                        );
                        if (stopSleep && (await bailIfCancelled(compPos, pIdx))) {
                            return { matches: [], count: totalMatchesSaved };
                        }
                    }
                }
            }
            await phaseEnd({
                productsScanned: batchProcessedForCompetitor,
                newMatchesSku: foundSku - foundSkuAtComp,
                newMatchesName: foundName - foundNameAtComp
            });
        }

        await phaseStart('finalize', 'Сохранение результатов в БД', {});
        await updateJob(
            jobId,
            withRunningCounters({ message: 'Сохранение результатов...', processed: resumeProcessedBase + totalSteps })
        );
        await flushPendingMatches();
        await phaseEnd({ totalMatchesSaved });
        await flushJobLogs();
        await updateJob(jobId, {
            status: 'completed',
            processed: resumeProcessedBase + totalSteps,
            checkpoint_comp_index: competitorIds.length,
            checkpoint_product_index: myProducts.length,
            found: totalMatchesSaved,
            found_sku: foundSku,
            found_name: foundName,
            phases_json: JSON.stringify(jobPhases),
            message: `Готово. Новых записей в «Совпадениях»: ${totalMatchesSaved}`,
            finished_at: new Date()
        });
        await addJobLog(jobId, `Готово. Новых записей в «Совпадениях»: ${totalMatchesSaved}`);

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
            'INSERT INTO matching_jobs (my_site_id, status, message, params_json, checkpoint_comp_index, checkpoint_product_index, processed, total, found, found_sku, found_name, started_at) VALUES (?, "running", "Запуск...", ?, 0, 0, 0, 0, 0, 0, 0, NOW())',
            [mySiteId, payloadForReplay]
        );
        const jobId = ins.insertId;
        await addJobLog(jobId, 'Задача создана');

        await recordMatchingStartActivity(req, {
            jobId,
            mySiteId,
            mode,
            productSearch,
            productIds,
            competitorIds,
            threshold,
            replayFromId: null,
        });

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
        const prevJob = prevRows[0];
        const seedSkuPrev = Math.max(0, Math.floor(Number(prevJob.found_sku) || 0));
        const seedNamePrev = Math.max(0, Math.floor(Number(prevJob.found_name) || 0));
        const seedFoundPrev = Math.max(0, Math.floor(Number(prevJob.found) || 0));
        const [ins] = await db.query(
            'INSERT INTO matching_jobs (my_site_id, status, message, params_json, checkpoint_comp_index, checkpoint_product_index, processed, total, found, found_sku, found_name, started_at) VALUES (?, "running", "Повтор предыдущей задачи...", ?, ?, ?, 0, 0, ?, ?, ?, NOW())',
            [
                mySiteId,
                replayParams,
                payload.startCompIndex,
                payload.startProductIndex,
                seedFoundPrev || seedSkuPrev + seedNamePrev,
                seedSkuPrev,
                seedNamePrev
            ]
        );
        const jobId = ins.insertId;
        await addJobLog(jobId, `Создан повтор задачи #${prevRows[0].id} в режиме продолжения`);
        if (seedSkuPrev > 0 || seedNamePrev > 0) {
            await addJobLog(
                jobId,
                `В эту задачу перенесены счётчики с #${prevRows[0].id}: по SKU ${seedSkuPrev}, по названию ${seedNamePrev}`
            );
        }

        await recordMatchingStartActivity(req, {
            jobId,
            mySiteId: payload.mySiteId,
            mode: payload.mode,
            productSearch: payload.productSearch,
            productIds: payload.productIds,
            competitorIds: payload.competitorIds,
            threshold: payload.threshold,
            replayFromId: prevRows[0].id,
        });

        executeMatching({
            jobId,
            ...payload,
            seedFoundSku: seedSkuPrev,
            seedFoundName: seedNamePrev,
            resumeProcessedBaseHint: prevJob.processed
        }).catch(async (e) => {
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
        try {
            await getFreshRunningJob(my_site_id);
        } catch (e) {
            console.error('[matches] GET /status stale check:', e && e.message ? e.message : e);
        }
        try {
            const [jobs] = await db.query(
                `SELECT mj.*,
                        (SELECT MIN(l.created_at) FROM matching_job_logs l WHERE l.job_id = mj.id) AS job_first_log_at
                 FROM matching_jobs mj
                 WHERE mj.my_site_id = ?
                 ORDER BY mj.id DESC
                 LIMIT 1`,
                [my_site_id]
            );
            if (!jobs.length) {
                return res.json({
                    active: false,
                    done: false,
                    processed: 0,
                    total: 0,
                    found: 0,
                    foundSku: 0,
                    foundName: 0,
                    dbFoundSku: 0,
                    dbFoundName: 0,
                    dbMatchCountsAvailable: false,
                    phases: [],
                    logs: [],
                    message: 'Нет задач',
                    startedAt: null,
                    finishedAt: null,
                    stopPending: false
                });
            }
            const job = jobs[0];
            const numJobInt = (v) => {
                const n = Number(v);
                return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
            };
            let phases = [];
            try {
                phases = job.phases_json ? JSON.parse(job.phases_json) : [];
                if (!Array.isArray(phases)) phases = [];
            } catch (_) {
                phases = [];
            }
            const [logs] = await db.query(
                'SELECT message, created_at FROM matching_job_logs WHERE job_id = ? ORDER BY id DESC LIMIT 20',
                [job.id]
            );
            const startedFromPhase =
                phases[0] && phases[0].startedAt ? isoFromDbDate(phases[0].startedAt) : null;
            const startedAtResolved =
                isoFromDbDate(job.started_at) ||
                isoFromDbDate(job.job_first_log_at) ||
                startedFromPhase;
            const jobMsg = String(job.message || '');
            const stopPending =
                job.status === 'running' && /Остановка\s+задачи/i.test(jobMsg);
            /** Сколько строк уже лежит в «Совпадениях» по конкурентам из params_json (не путать со счётчиками самой задачи). */
            let dbFoundSku = 0;
            let dbFoundName = 0;
            let dbMatchCountsAvailable = false;
            try {
                let payload = {};
                try {
                    payload = job.params_json ? JSON.parse(job.params_json) : {};
                } catch (_) {
                    payload = {};
                }
                const compIds = (Array.isArray(payload.competitorIds) ? payload.competitorIds : [])
                    .map((x) => parseInt(String(x).trim(), 10))
                    .filter((n) => Number.isFinite(n) && n > 0);
                if (compIds.length && my_site_id) {
                    const ph = compIds.map(() => '?').join(',');
                    const [[aggRow]] = await db.query(
                        `SELECT
                            COALESCE(SUM(CASE
                                WHEN (
                                    LOWER(TRIM(COALESCE(pm.match_type, ''))) = 'sku'
                                    OR (TRIM(COALESCE(pm.match_type, '')) = '' AND COALESCE(pm.confidence_score, 0) >= 0.9995)
                                ) THEN 1 ELSE 0 END), 0) AS db_sku,
                            COALESCE(SUM(CASE
                                WHEN (
                                    LOWER(TRIM(COALESCE(pm.match_type, ''))) = 'name'
                                    OR (TRIM(COALESCE(pm.match_type, '')) = '' AND COALESCE(pm.confidence_score, 0) < 0.9995)
                                ) THEN 1 ELSE 0 END), 0) AS db_name
                         FROM product_matches pm
                         WHERE pm.my_site_id = ?
                           AND pm.competitor_site_id IN (${ph})
                           AND (pm.status IS NULL OR TRIM(COALESCE(pm.status, '')) = '' OR pm.status IN ('pending', 'confirmed'))`,
                        [my_site_id, ...compIds]
                    );
                    dbFoundSku = numJobInt(aggRow?.db_sku);
                    dbFoundName = numJobInt(aggRow?.db_name);
                    dbMatchCountsAvailable = true;
                }
            } catch (eDb) {
                console.error('[matches] GET /status db counts:', eDb && eDb.message ? eDb.message : eDb);
            }
            return res.json({
                id: job.id,
                active: job.status === 'running',
                done: job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled',
                status: job.status,
                processed: job.processed || 0,
                total: job.total || 0,
                found: job.found || 0,
                foundSku: numJobInt(job.found_sku != null ? job.found_sku : job.foundSku),
                foundName: numJobInt(job.found_name != null ? job.found_name : job.foundName),
                dbFoundSku,
                dbFoundName,
                dbMatchCountsAvailable,
                message: job.message || '',
                phases,
                startedAt: startedAtResolved,
                finishedAt: isoFromDbDate(job.finished_at),
                stopPending,
                logs: logs.map((l) => {
                    const t = new Date(l.created_at).toLocaleTimeString('ru-RU');
                    return `[${t}] ${l.message}`;
                }),
                canRetry: job.status === 'failed' || job.status === 'completed' || job.status === 'cancelled'
            });
        } catch (e) {
            console.error('[matches] GET /status:', e && e.message ? e.message : e);
            return res.status(503).json({
                error: 'Временно нет связи с базой данных',
                detail: e && e.message ? e.message : String(e)
            });
        }
    });

    // 4. Получить список сопоставлений (с фильтрами)
    router.get('/list', async (req, res) => {
        const { my_site_id, limit = 100, offset = 0 } = req.query;
        const rawStatus = req.query.status;
        const status =
            rawStatus == null ||
            String(rawStatus).trim() === '' ||
            String(rawStatus).trim().toLowerCase() === 'all'
                ? null
                : String(rawStatus).trim();
        const rawMt = req.query.match_type;
        const matchTypeFilter =
            rawMt == null || String(rawMt).trim() === '' || String(rawMt).trim().toLowerCase() === 'all'
                ? null
                : String(rawMt).trim().toLowerCase();

        /** Совпадает с клиентским effectiveMatchTypeForScore: пустой match_type — по confidence vs 1. */
        function matchTypeWhereSql(usePmAlias) {
            const p = usePmAlias ? 'pm.' : '';
            if (matchTypeFilter === 'name') {
                return ` AND (LOWER(TRIM(COALESCE(${p}match_type, ''))) = 'name' OR (TRIM(COALESCE(${p}match_type, '')) = '' AND COALESCE(${p}confidence_score, 0) < 0.9995))`;
            }
            if (matchTypeFilter === 'sku') {
                return ` AND (LOWER(TRIM(COALESCE(${p}match_type, ''))) = 'sku' OR (TRIM(COALESCE(${p}match_type, '')) = '' AND COALESCE(${p}confidence_score, 0) >= 0.9995))`;
            }
            return '';
        }
        const mtWhereMain = matchTypeWhereSql(true);
        const mtWhereCount = matchTypeWhereSql(false);

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
            const rawCompSite = req.query.competitor_site_id;
            const competitorSiteId = rawCompSite == null || String(rawCompSite).trim() === ''
                ? null
                : parseInt(String(rawCompSite).trim(), 10);
            if (Number.isFinite(competitorSiteId) && competitorSiteId > 0) {
                q += ' AND pm.competitor_site_id = ?';
                qc += ' AND competitor_site_id = ?';
                p.push(competitorSiteId);
                pc.push(competitorSiteId);
            }
            if (status) {
                if (status === 'pending') {
                    q += ` AND (pm.status = 'pending' OR pm.status IS NULL OR TRIM(COALESCE(pm.status, '')) = '')`;
                    qc += ` AND (status = 'pending' OR status IS NULL OR TRIM(COALESCE(status, '')) = '')`;
                } else {
                    q += ' AND pm.status = ?';
                    qc += ' AND status = ?';
                    p.push(status);
                    pc.push(status);
                }
            }
            if (mtWhereMain) q += mtWhereMain;
            if (mtWhereCount) qc += mtWhereCount;

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
            await ensureMatchLaneTables();
            const actRow = await loadProductMatchActivityRow(id);
            if (!actRow) return res.status(404).json({ error: 'Запись не найдена' });
            const row = {
                my_site_id: actRow.my_site_id,
                competitor_site_id: actRow.competitor_site_id,
                my_sku: actRow.my_sku,
                my_product_name: actRow.my_product_name
            };
            const actor = await resolveActorDisplayName(req);
            await db.query(
                'UPDATE product_matches SET status = "confirmed", confirmed_by = ?, confirmed_at = NOW(), unlinked_by = NULL, unlinked_at = NULL, rejected_by = NULL, rejected_at = NULL WHERE id = ?',
                [actor, id]
            );
            const mpId = await resolveMyProductId(db, row.my_site_id, row.my_sku, row.my_product_name);
            if (mpId) {
                await db.query(
                    'DELETE FROM match_exclusion WHERE my_site_id = ? AND competitor_site_id = ? AND my_product_id = ?',
                    [row.my_site_id, row.competitor_site_id, mpId]
                );
                await appendMatchProductLog(db, {
                    my_site_id: row.my_site_id,
                    my_product_id: mpId,
                    competitor_site_id: row.competitor_site_id,
                    event: 'auto_confirmed',
                    message: 'Подтверждено авто-совпадение — запись снята с ручной очереди при наличии',
                    detail: { product_match_id: id }
                });
            }
            await recordMatchesListUiActivity(req, 'confirm', actRow, { my_product_id_resolved: mpId || null });
            res.json({ success: true });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // 6. Отклонить сопоставление
    router.post('/reject', async (req, res) => {
        const { id } = req.body;
        try {
            await ensureMatchAuditColumns();
            await ensureMatchLaneTables();
            const r0 = await loadProductMatchActivityRow(id);
            if (!r0) return res.status(404).json({ error: 'Запись не найдена' });
            const actor = await resolveActorDisplayName(req);
            await db.query(
                'UPDATE product_matches SET status = "rejected", rejected_by = ?, rejected_at = NOW() WHERE id = ?',
                [actor, id]
            );
            const mpId = await resolveMyProductId(db, r0.my_site_id, r0.my_sku, r0.my_product_name);
            if (mpId) {
                await upsertExclusionRejected(db, {
                    my_site_id: r0.my_site_id,
                    competitor_site_id: r0.competitor_site_id,
                    my_product_id: mpId,
                    source_product_match_id: r0.id,
                    rejected_by: actor
                });
            }
            await recordMatchesListUiActivity(req, 'reject', r0, {
                exclusion_created: !!mpId,
                my_product_id_resolved: mpId || null,
            });
            res.json({ success: true, exclusion_created: !!mpId });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    router.post('/unlink', async (req, res) => {
        const { id } = req.body;
        try {
            await ensureMatchAuditColumns();
            const actRow = await loadProductMatchActivityRow(id);
            if (!actRow) return res.status(404).json({ error: 'Запись не найдена' });
            const actor = await resolveActorDisplayName(req);
            await db.query(
                'UPDATE product_matches SET status = "pending", confirmed_by = NULL, confirmed_at = NULL, unlinked_by = ?, unlinked_at = NOW(), rejected_by = NULL, rejected_at = NULL WHERE id = ?',
                [actor, id]
            );
            await recordMatchesListUiActivity(req, 'unlink', actRow);
            res.json({ success: true });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    router.get('/manual-queue', async (req, res) => {
        const mySiteId = parseInt(String(req.query.my_site_id || '').trim(), 10);
        if (!Number.isFinite(mySiteId) || mySiteId < 1) return res.status(400).json({ error: 'my_site_id required' });
        const compRaw = String(req.query.competitor_site_id || '').trim();
        const compId = compRaw === '' ? null : parseInt(compRaw, 10);
        const search = String(req.query.search || '').trim();
        const limit = Math.max(1, Math.min(parseInt(String(req.query.limit || '100'), 10) || 100, 300));
        const offset = Math.max(0, parseInt(String(req.query.offset || '0'), 10) || 0);
        const reasonRaw = String(req.query.exclusion_reason || req.query.reason || '')
            .trim()
            .toLowerCase();
        const reasonFilter = reasonRaw === 'no_match' || reasonRaw === 'rejected' ? reasonRaw : null;
        try {
            await ensureMatchLaneTables();
            let q = `
                SELECT e.id, e.my_site_id, e.competitor_site_id, e.my_product_id, e.reason, e.source_product_match_id,
                       e.created_at, e.updated_at,
                       COALESCE(mp.sku, pm.my_sku) AS mp_sku,
                       COALESCE(mp.name, pm.my_product_name) AS mp_name,
                       mp.price AS mp_price, mp.currency AS mp_currency, mp.source_id AS mp_source_id,
                       pr.name AS comp_project_name, pr.domain AS comp_domain
                FROM match_exclusion e
                LEFT JOIN my_products mp ON mp.id = e.my_product_id AND mp.site_id = e.my_site_id
                LEFT JOIN product_matches pm ON pm.id = e.source_product_match_id
                LEFT JOIN projects pr ON pr.id = e.competitor_site_id
                WHERE e.my_site_id = ?
            `;
            const p = [mySiteId];
            if (Number.isFinite(compId) && compId > 0) {
                q += ' AND e.competitor_site_id = ?';
                p.push(compId);
            }
            if (search) {
                const v = `%${search.slice(0, 120)}%`;
                q += ` AND (
                    mp.sku LIKE ? OR mp.name LIKE ? OR mp.source_id LIKE ?
                    OR pm.my_sku LIKE ? OR pm.my_product_name LIKE ?
                )`;
                p.push(v, v, v, v, v);
            }
            if (reasonFilter) {
                q += " AND LOWER(TRIM(COALESCE(e.reason, ''))) = ?";
                p.push(reasonFilter);
            }
            q += ' ORDER BY e.updated_at DESC LIMIT ? OFFSET ?';
            p.push(limit, offset);
            const [data] = await db.query(q, p);
            let qc = `
                SELECT COUNT(*) AS total FROM match_exclusion e
                LEFT JOIN my_products mp ON mp.id = e.my_product_id AND mp.site_id = e.my_site_id
                LEFT JOIN product_matches pm ON pm.id = e.source_product_match_id
                WHERE e.my_site_id = ?
            `;
            const pc = [mySiteId];
            if (Number.isFinite(compId) && compId > 0) {
                qc += ' AND e.competitor_site_id = ?';
                pc.push(compId);
            }
            if (search) {
                const v = `%${search.slice(0, 120)}%`;
                qc += ` AND (
                    mp.sku LIKE ? OR mp.name LIKE ? OR mp.source_id LIKE ?
                    OR pm.my_sku LIKE ? OR pm.my_product_name LIKE ?
                )`;
                pc.push(v, v, v, v, v);
            }
            if (reasonFilter) {
                qc += " AND LOWER(TRIM(COALESCE(e.reason, ''))) = ?";
                pc.push(reasonFilter);
            }
            const [[cntRow]] = await db.query(qc, pc);
            return res.json({ data, total: Number(cntRow?.total || 0), limit, offset });
        } catch (e) {
            return res.status(500).json({ error: e.message });
        }
    });

    router.delete('/manual-queue/:id', async (req, res) => {
        const id = parseInt(String(req.params.id || '').trim(), 10);
        if (!Number.isFinite(id) || id < 1) return res.status(400).json({ error: 'bad id' });
        try {
            await ensureMatchLaneTables();
            const [r] = await db.query('SELECT my_site_id, my_product_id, competitor_site_id FROM match_exclusion WHERE id = ? LIMIT 1', [id]);
            if (!r.length) return res.status(404).json({ error: 'Не найдено' });
            await db.query('DELETE FROM match_exclusion WHERE id = ?', [id]);
            await appendMatchProductLog(db, {
                my_site_id: r[0].my_site_id,
                my_product_id: r[0].my_product_id,
                competitor_site_id: r[0].competitor_site_id,
                event: 'exclusion_cleared',
                message: 'Строка удалена из ручной очереди — товар снова участвует в авто-сопоставлении',
                detail: { exclusion_id: id }
            });
            return res.json({ success: true });
        } catch (e) {
            return res.status(500).json({ error: e.message });
        }
    });

    router.get('/manual-archive', async (req, res) => {
        const mySiteId = parseInt(String(req.query.my_site_id || '').trim(), 10);
        if (!Number.isFinite(mySiteId) || mySiteId < 1) return res.status(400).json({ error: 'my_site_id required' });
        const compRaw = String(req.query.competitor_site_id || '').trim();
        const compId = compRaw === '' ? null : parseInt(compRaw, 10);
        const limit = Math.max(1, Math.min(parseInt(String(req.query.limit || '100'), 10) || 100, 300));
        const offset = Math.max(0, parseInt(String(req.query.offset || '0'), 10) || 0);
        try {
            await ensureMatchLaneTables();
            let q = `
                SELECT a.id, a.my_site_id, a.competitor_site_id, a.my_product_id, a.competitor_sku, a.competitor_name, a.note, a.created_at,
                       mp.sku AS mp_sku, mp.name AS mp_name,
                       pr.name AS comp_project_name, pr.domain AS comp_domain
                FROM match_manual_archive a
                LEFT JOIN my_products mp ON mp.id = a.my_product_id AND mp.site_id = a.my_site_id
                LEFT JOIN projects pr ON pr.id = a.competitor_site_id
                WHERE a.my_site_id = ?
            `;
            const p = [mySiteId];
            if (Number.isFinite(compId) && compId > 0) {
                q += ' AND a.competitor_site_id = ?';
                p.push(compId);
            }
            q += ' ORDER BY a.id DESC LIMIT ? OFFSET ?';
            p.push(limit, offset);
            const [data] = await db.query(q, p);
            let qc = 'SELECT COUNT(*) AS total FROM match_manual_archive WHERE my_site_id = ?';
            const pc = [mySiteId];
            if (Number.isFinite(compId) && compId > 0) {
                qc += ' AND competitor_site_id = ?';
                pc.push(compId);
            }
            const [[cntRow]] = await db.query(qc, pc);
            return res.json({ data, total: Number(cntRow?.total || 0), limit, offset });
        } catch (e) {
            return res.status(500).json({ error: e.message });
        }
    });

    router.delete('/manual-archive/:id', async (req, res) => {
        const id = parseInt(String(req.params.id || '').trim(), 10);
        if (!Number.isFinite(id) || id < 1) return res.status(400).json({ error: 'bad id' });
        try {
            await ensureMatchLaneTables();
            const [r] = await db.query(
                'SELECT my_site_id, my_product_id, competitor_site_id FROM match_manual_archive WHERE id = ? LIMIT 1',
                [id]
            );
            if (!r.length) return res.status(404).json({ error: 'Не найдено' });
            await db.query('DELETE FROM match_manual_archive WHERE id = ?', [id]);
            await appendMatchProductLog(db, {
                my_site_id: r[0].my_site_id,
                my_product_id: r[0].my_product_id,
                competitor_site_id: r[0].competitor_site_id,
                event: 'archive_cleared',
                message: 'Запись удалена из архива после ручного отказа',
                detail: { archive_id: id }
            });
            return res.json({ success: true });
        } catch (e) {
            return res.status(500).json({ error: e.message });
        }
    });

    /** Сколько проектов (прайсов) содержат строку с точным совпадением SKU (trim, без учёта регистра). Для шага 3: при «Все конкуренты» выбрать единственный прайс автоматически. */
    router.get('/prices-resolve-sku', async (req, res) => {
        const needle = String(req.query.sku || '').trim().slice(0, 120);
        if (!needle) return res.status(400).json({ error: 'sku required' });
        try {
            const [rows] = await db.query(
                `SELECT p.project_id AS project_id, MIN(pr.name) AS project_name
                 FROM prices p
                 INNER JOIN projects pr ON pr.id = p.project_id
                 WHERE p.sku IS NOT NULL AND TRIM(p.sku) <> ''
                   AND LOWER(TRIM(p.sku)) = LOWER(TRIM(?))
                 GROUP BY p.project_id
                 ORDER BY MIN(pr.name)
                 LIMIT 60`,
                [needle]
            );
            const count = rows.length;
            return res.json({
                data: rows,
                count,
                project_id: count === 1 ? rows[0].project_id : null,
                project_name: count === 1 ? rows[0].project_name : null
            });
        } catch (e) {
            return res.status(500).json({ error: e.message });
        }
    });

    router.get('/prices-search', async (req, res) => {
        const projectId = parseInt(String(req.query.project_id || '').trim(), 10);
        const q = String(req.query.q || '').trim();
        if (!Number.isFinite(projectId) || projectId < 1) return res.status(400).json({ error: 'project_id required' });
        if (!q) return res.json({ data: [] });
        try {
            const val = `%${q.slice(0, 120)}%`;
            const lim = Math.max(1, Math.min(parseInt(String(req.query.limit || '25'), 10) || 25, 80));
            const [rows] = await db.query(
                `SELECT id, sku, product_name, price, currency, url, parsed_at
                 FROM prices WHERE project_id = ? AND (sku LIKE ? OR product_name LIKE ?)
                 ORDER BY parsed_at DESC, id DESC LIMIT ?`,
                [projectId, val, val, lim]
            );
            return res.json({ data: rows });
        } catch (e) {
            return res.status(500).json({ error: e.message });
        }
    });

    /** Старые строки лога без rejected_by в detail — подставить из product_matches (после отклонения там есть rejected_by). */
    async function enrichProductMatchLogRowsForResponse(rows, siteId) {
        if (!rows || !rows.length) return;
        const toResolve = [];
        for (const r of rows) {
            if (String(r.event || '').toLowerCase() !== 'exclusion_rejected') continue;
            let o = null;
            try {
                o = r.detail_json ? JSON.parse(r.detail_json) : {};
            } catch (_) {
                o = {};
            }
            if (!o || typeof o !== 'object') o = {};
            const rb = String(o.rejected_by || '').trim();
            if (rb && rb !== 'unknown') continue;
            const mid = parseInt(String(o.source_product_match_id || '').trim(), 10);
            if (!Number.isFinite(mid) || mid < 1) continue;
            toResolve.push({ row: r, matchId: mid, detail: o });
        }
        if (!toResolve.length) return;
        const ids = [...new Set(toResolve.map((x) => x.matchId))];
        const ph = ids.map(() => '?').join(',');
        const [pmRows] = await db.query(
            `SELECT id, rejected_by FROM product_matches WHERE my_site_id = ? AND id IN (${ph})`,
            [siteId, ...ids]
        );
        const byId = new Map((pmRows || []).map((x) => [Number(x.id), x.rejected_by]));
        for (const { row, matchId, detail } of toResolve) {
            const who = byId.get(matchId);
            const whoStr = who != null ? String(who).trim() : '';
            if (!whoStr) continue;
            detail.rejected_by = whoStr;
            row.detail_json = JSON.stringify(detail);
            const msg = String(row.message || '');
            if (!msg.includes('пользователем') && !msg.includes(whoStr)) {
                row.message = `Авто-совпадение отклонено пользователем «${whoStr}» — товар вынесен в ручную очередь`.slice(0, 512);
            }
        }
    }

    router.get('/product-match-log', async (req, res) => {
        const mySiteId = parseInt(String(req.query.my_site_id || '').trim(), 10);
        const myProductId = parseInt(String(req.query.my_product_id || '').trim(), 10);
        if (!Number.isFinite(mySiteId) || mySiteId < 1 || !Number.isFinite(myProductId) || myProductId < 1) {
            return res.status(400).json({ error: 'my_site_id and my_product_id required' });
        }
        const lim = Math.max(1, Math.min(parseInt(String(req.query.limit || '50'), 10) || 50, 200));
        try {
            await ensureMatchLaneTables();
            await ensureMatchAuditColumns();
            const [rows] = await db.query(
                `SELECT id, competitor_site_id, event, message, detail_json, created_at
                 FROM match_product_log WHERE my_site_id = ? AND my_product_id = ?
                 ORDER BY id DESC LIMIT ?`,
                [mySiteId, myProductId, lim]
            );
            await enrichProductMatchLogRowsForResponse(rows, mySiteId);
            return res.json({ data: rows });
        } catch (e) {
            return res.status(500).json({ error: e.message });
        }
    });

    router.post('/manual-match/confirm', async (req, res) => {
        const mySiteId = parseInt(String(req.body.my_site_id || '').trim(), 10);
        const competitorSiteId = parseInt(String(req.body.competitor_site_id || '').trim(), 10);
        const myProductId = parseInt(String(req.body.my_product_id || '').trim(), 10);
        const competitorSku = String(req.body.competitor_sku || '').trim().slice(0, 255);
        const competitorName = String(req.body.competitor_name || '').trim().slice(0, 500);
        if (!Number.isFinite(mySiteId) || mySiteId < 1 || !Number.isFinite(competitorSiteId) || competitorSiteId < 1) {
            return res.status(400).json({ error: 'my_site_id и competitor_site_id обязательны' });
        }
        if (!Number.isFinite(myProductId) || myProductId < 1) return res.status(400).json({ error: 'my_product_id обязателен' });
        if (!competitorSku && !competitorName) {
            return res.status(400).json({ error: 'Укажите хотя бы SKU или название позиции конкурента' });
        }
        try {
            await ensureMatchLaneTables();
            await ensureMatchAuditColumns();
            const [[mp]] = await db.query(
                'SELECT id, sku, name FROM my_products WHERE id = ? AND site_id = ? AND is_active = 1 LIMIT 1',
                [myProductId, mySiteId]
            );
            if (!mp) return res.status(404).json({ error: 'Товар не найден на выбранном сайте' });
            const actor = await resolveActorDisplayName(req);
            await db.query(
                `INSERT INTO product_matches
                 (my_site_id, my_sku, my_product_name, competitor_site_id, competitor_sku, competitor_name, match_type, matching_mode, confidence_score, status, confirmed_by, confirmed_at)
                 VALUES (?, ?, ?, ?, ?, ?, 'manual', 'manual', 1.0000, 'confirmed', ?, NOW())`,
                [mySiteId, mp.sku || '', mp.name || '', competitorSiteId, competitorSku || null, competitorName || null, actor]
            );
            await db.query(
                'DELETE FROM match_exclusion WHERE my_site_id = ? AND competitor_site_id = ? AND my_product_id = ?',
                [mySiteId, competitorSiteId, myProductId]
            );
            await appendMatchProductLog(db, {
                my_site_id: mySiteId,
                my_product_id: myProductId,
                competitor_site_id: competitorSiteId,
                event: 'manual_confirmed',
                message: 'Ручное сопоставление зафиксировано',
                detail: { competitor_sku: competitorSku, competitor_name: competitorName }
            });
            return res.json({ success: true });
        } catch (e) {
            return res.status(500).json({ error: e.message });
        }
    });

    router.post('/manual-match/archive', async (req, res) => {
        const exclusionId = parseInt(String(req.body.exclusion_id || '').trim(), 10);
        const note = String(req.body.note || '').trim().slice(0, 500);
        const competitorSku = String(req.body.competitor_sku || '').trim().slice(0, 255);
        const competitorName = String(req.body.competitor_name || '').trim().slice(0, 500);
        if (!Number.isFinite(exclusionId) || exclusionId < 1) return res.status(400).json({ error: 'exclusion_id обязателен' });
        try {
            await ensureMatchLaneTables();
            const [rows] = await db.query(
                `SELECT id, my_site_id, competitor_site_id, my_product_id FROM match_exclusion WHERE id = ? LIMIT 1`,
                [exclusionId]
            );
            if (!rows.length) return res.status(404).json({ error: 'Строка очереди не найдена' });
            const e0 = rows[0];
            await db.query(
                `INSERT INTO match_manual_archive (my_site_id, competitor_site_id, my_product_id, competitor_sku, competitor_name, note)
                 VALUES (?, ?, ?, ?, ?, ?)`,
                [e0.my_site_id, e0.competitor_site_id, e0.my_product_id, competitorSku || null, competitorName || null, note || null]
            );
            await db.query('DELETE FROM match_exclusion WHERE id = ?', [exclusionId]);
            await appendMatchProductLog(db, {
                my_site_id: e0.my_site_id,
                my_product_id: e0.my_product_id,
                competitor_site_id: e0.competitor_site_id,
                event: 'manual_archived',
                message: 'После ручного сопоставления отказ — в архив',
                detail: { note: note || null, competitor_sku: competitorSku, competitor_name: competitorName }
            });
            return res.json({ success: true });
        } catch (e) {
            return res.status(500).json({ error: e.message });
        }
    });

    router.watchdogTick = async function watchdogTick() {
        await cleanupStaleRunningJobs(600);
    };

    /** Вынесено из GET /list: создание индексов на больших таблицах не должно блокировать загрузку страницы. */
    router.warmupMatchingIndexes = async function warmupMatchingIndexes() {
        await ensureMatchesPerfIndexes();
    };

    return router;
};
