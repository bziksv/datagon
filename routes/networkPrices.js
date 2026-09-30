/**
 * Цены сети: эталон (Альмамед) → целевые сайты с % наценки/скидки.
 * Запись в CMS при заданном price_pct; автосинк — triggerNetworkPricesSyncFromSettings.
 */
const express = require('express');
const {
    applyPriceToCms,
    roundPriceForCurrency,
    openSiteConnection,
} = require('../lib/datagonCmsPriceWrite');

const PRICE_EPS = 0.005;
const APPLY_HARD_MAX = 50000;

function networkPricesRouterFactory(db, appSettings) {
    const router = express.Router();
    let schemaReady = false;
    let applyJob = {
        active: false,
        cancelRequested: false,
        phase: 'idle',
        message: '',
        dry_run: false,
        scanned: 0,
        written: 0,
        skipped_unchanged: 0,
        skipped_no_link: 0,
        skipped_no_pct: 0,
        skipped_no_source_price: 0,
        cms_failed: 0,
        errors: [],
        started_at: null,
        finished_at: null,
        duration_sec: null,
        target_site_id: null,
    };

    async function ensureSchema() {
        if (schemaReady) return;
        await db.query(`
            CREATE TABLE IF NOT EXISTS network_price_site_settings (
                target_site_id INT NOT NULL PRIMARY KEY,
                enabled TINYINT(1) NOT NULL DEFAULT 0,
                price_pct DECIMAL(10,4) NULL,
                updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        `);
        await db.query(`
            CREATE TABLE IF NOT EXISTS network_product_links (
                id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
                source_site_id INT NOT NULL,
                source_product_id BIGINT NOT NULL,
                target_site_id INT NOT NULL,
                target_product_id BIGINT NOT NULL,
                created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                UNIQUE KEY uq_np_link_pair (source_site_id, source_product_id, target_site_id),
                UNIQUE KEY uq_np_link_target (target_site_id, target_product_id),
                KEY idx_np_link_target_site (target_site_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        `);
        await db.query(`
            CREATE TABLE IF NOT EXISTS network_product_link_ignore (
                source_site_id INT NOT NULL,
                source_product_id BIGINT NOT NULL,
                target_site_id INT NOT NULL,
                created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (source_site_id, source_product_id, target_site_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        `);
        for (const colSql of [
            'ADD COLUMN network_sync_at DATETIME NULL',
            'ADD COLUMN network_sync_note VARCHAR(255) NULL',
        ]) {
            try {
                // eslint-disable-next-line no-await-in-loop
                await db.query(`ALTER TABLE my_products ${colSql}`);
            } catch (e) {
                if (!/Duplicate column/i.test(String(e && e.message))) {
                    /* ignore if table missing / partial */
                }
            }
        }
        schemaReady = true;
    }

    async function getSourceSiteId() {
        const raw = appSettings && appSettings.network_prices_source_site_id;
        let id = parseInt(String(raw != null ? raw : '2'), 10);
        if (!Number.isFinite(id) || id < 1) id = 2;
        return id;
    }

    function normalizeSku(v) {
        return String(v || '')
            .replace(/\u00a0/g, ' ')
            .replace(/[\u200b-\u200d\ufeff]/g, '')
            .trim();
    }

    function computeProposed(sourcePrice, sourceCurrency, pricePct) {
        const base = Number(sourcePrice);
        const pct = Number(pricePct);
        if (!Number.isFinite(base) || base <= 0 || !Number.isFinite(pct)) {
            return { ok: false };
        }
        const raw = base * (1 + pct / 100);
        const finalPrice = roundPriceForCurrency(raw, sourceCurrency || 'RUB');
        if (!Number.isFinite(finalPrice) || finalPrice <= 0) return { ok: false };
        return { ok: true, finalPrice };
    }

    function pricesEqual(a, b) {
        const x = Number(a);
        const y = Number(b);
        if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
        return Math.abs(x - y) < PRICE_EPS;
    }

    /** Пары: manual link или auto SKU (не в ignore). */
    async function loadLinkedPairs(sourceSiteId, targetSiteId, opts) {
        const o = opts || {};
        const search = String(o.search || '').trim().slice(0, 120);
        // Placeholders: JOIN t.site_id = ?, WHERE s.site_id = ?
        const params = [targetSiteId, sourceSiteId];
        let searchSql = '';
        if (search) {
            const like = `%${search}%`;
            searchSql = ` AND (
                s.sku LIKE ? OR s.name LIKE ? OR s.source_id LIKE ?
                OR t.sku LIKE ? OR t.name LIKE ? OR t.source_id LIKE ?
            )`;
            params.push(like, like, like, like, like, like);
        }

        const [rows] = await db.query(
            `
            SELECT
                s.id AS source_product_id,
                s.source_id AS source_code,
                s.sku AS source_sku,
                s.name AS source_name,
                s.price AS source_price,
                s.currency AS source_currency,
                s.stock AS source_stock,
                t.id AS target_product_id,
                t.source_id AS target_code,
                t.sku AS target_sku,
                t.name AS target_name,
                t.price AS target_price,
                t.currency AS target_currency,
                t.stock AS target_stock,
                t.site_id AS target_site_id,
                CASE WHEN ml.id IS NOT NULL THEN 'manual' ELSE 'auto' END AS link_kind
            FROM my_products s
            INNER JOIN my_products t
                ON t.site_id = ?
               AND t.is_active = 1
               AND (
                    EXISTS (
                        SELECT 1 FROM network_product_links ml2
                        WHERE ml2.source_site_id = s.site_id
                          AND ml2.source_product_id = s.id
                          AND ml2.target_site_id = t.site_id
                          AND ml2.target_product_id = t.id
                    )
                    OR (
                        TRIM(IFNULL(s.sku, '')) <> ''
                        AND TRIM(s.sku) = TRIM(t.sku)
                        AND NOT EXISTS (
                            SELECT 1 FROM network_product_link_ignore ig
                            WHERE ig.source_site_id = s.site_id
                              AND ig.source_product_id = s.id
                              AND ig.target_site_id = t.site_id
                        )
                        AND NOT EXISTS (
                            SELECT 1 FROM network_product_links ml3
                            WHERE ml3.source_site_id = s.site_id
                              AND ml3.source_product_id = s.id
                              AND ml3.target_site_id = t.site_id
                        )
                    )
               )
            LEFT JOIN network_product_links ml
                ON ml.source_site_id = s.site_id
               AND ml.source_product_id = s.id
               AND ml.target_site_id = t.site_id
               AND ml.target_product_id = t.id
            WHERE s.site_id = ?
              AND s.is_active = 1
              ${searchSql}
            ORDER BY s.id ASC
            `,
            params
        );
        return rows || [];
    }

    async function buildMatrixRows(sourceSiteId, targetSiteId, linkStatus, search, limit, offset) {
        const st = String(linkStatus || 'all').toLowerCase();
        const lim = Math.min(300, Math.max(1, Number(limit) || 100));
        const off = Math.max(0, Number(offset) || 0);
        const q = String(search || '').trim().slice(0, 120);
        const like = q ? `%${q}%` : null;

        if (st === 'linked' || st === 'all') {
            /* handled below with unions for all */
        }

        // Универсальный набор: linked + source_only + target_only через три запроса при необходимости.
        const linked = await loadLinkedPairs(sourceSiteId, targetSiteId, { search: q });
        const linkedSrcIds = new Set(linked.map((r) => Number(r.source_product_id)));
        const linkedTgtIds = new Set(linked.map((r) => Number(r.target_product_id)));

        let rows = [];

        if (st === 'linked' || st === 'all') {
            rows = rows.concat(
                linked.map((r) => ({
                    ...r,
                    link_status: 'linked',
                }))
            );
        }

        if (st === 'source_only' || st === 'unlinked' || st === 'all') {
            const params = [sourceSiteId];
            let sql = `
                SELECT s.id AS source_product_id, s.source_id AS source_code, s.sku AS source_sku,
                       s.name AS source_name, s.price AS source_price, s.currency AS source_currency,
                       s.stock AS source_stock
                FROM my_products s
                WHERE s.site_id = ? AND s.is_active = 1
            `;
            if (like) {
                sql += ` AND (s.sku LIKE ? OR s.name LIKE ? OR s.source_id LIKE ?)`;
                params.push(like, like, like);
            }
            sql += ` ORDER BY s.id ASC LIMIT 5000`;
            const [srcRows] = await db.query(sql, params);
            for (const s of srcRows || []) {
                if (linkedSrcIds.has(Number(s.source_product_id || s.id))) continue;
                // also skip if id field naming
                const sid = Number(s.source_product_id != null ? s.source_product_id : s.id);
                if (linkedSrcIds.has(sid)) continue;
                if (st === 'linked') continue;
                rows.push({
                    source_product_id: sid,
                    source_code: s.source_code,
                    source_sku: s.source_sku,
                    source_name: s.source_name,
                    source_price: s.source_price,
                    source_currency: s.source_currency,
                    source_stock: s.source_stock,
                    target_product_id: null,
                    target_code: null,
                    target_sku: null,
                    target_name: null,
                    target_price: null,
                    target_currency: null,
                    target_stock: null,
                    link_kind: null,
                    link_status: 'source_only',
                });
            }
        }

        if (st === 'target_only' || st === 'unlinked' || st === 'all') {
            const params = [targetSiteId];
            let sql = `
                SELECT t.id AS target_product_id, t.source_id AS target_code, t.sku AS target_sku,
                       t.name AS target_name, t.price AS target_price, t.currency AS target_currency,
                       t.stock AS target_stock
                FROM my_products t
                WHERE t.site_id = ? AND t.is_active = 1
            `;
            if (like) {
                sql += ` AND (t.sku LIKE ? OR t.name LIKE ? OR t.source_id LIKE ?)`;
                params.push(like, like, like);
            }
            sql += ` ORDER BY t.id ASC LIMIT 5000`;
            const [tgtRows] = await db.query(sql, params);
            for (const t of tgtRows || []) {
                const tid = Number(t.target_product_id != null ? t.target_product_id : t.id);
                if (linkedTgtIds.has(tid)) continue;
                if (st === 'linked') continue;
                rows.push({
                    source_product_id: null,
                    source_code: null,
                    source_sku: null,
                    source_name: null,
                    source_price: null,
                    source_currency: null,
                    source_stock: null,
                    target_product_id: tid,
                    target_code: t.target_code,
                    target_sku: t.target_sku,
                    target_name: t.target_name,
                    target_price: t.target_price,
                    target_currency: t.target_currency,
                    target_stock: t.target_stock,
                    link_kind: null,
                    link_status: 'target_only',
                });
            }
        }

        if (st === 'unlinked') {
            rows = rows.filter((r) => r.link_status === 'source_only' || r.link_status === 'target_only');
        } else if (st === 'source_only') {
            rows = rows.filter((r) => r.link_status === 'source_only');
        } else if (st === 'target_only') {
            rows = rows.filter((r) => r.link_status === 'target_only');
        } else if (st === 'linked') {
            rows = rows.filter((r) => r.link_status === 'linked' || r.link_kind);
            rows.forEach((r) => {
                r.link_status = 'linked';
            });
        }

        const total = rows.length;
        const page = rows.slice(off, off + lim);
        return { rows: page, total };
    }

    function enrichProposed(rows, pricePct) {
        return (rows || []).map((r) => {
            const out = { ...r };
            if (pricePct == null || !Number.isFinite(Number(pricePct))) {
                out.proposed_price = null;
                out.delta_pct_vs_proposed = null;
                out.delta_pct_vs_source = null;
                out.can_apply = false;
                return out;
            }
            if (out.source_price == null || out.link_status === 'source_only' || out.link_status === 'target_only') {
                if (out.link_kind || out.link_status === 'linked') {
                    /* fallthrough */
                } else {
                    out.proposed_price = null;
                    out.delta_pct_vs_proposed = null;
                    out.delta_pct_vs_source = null;
                    out.can_apply = false;
                    return out;
                }
            }
            const prop = computeProposed(out.source_price, out.source_currency || out.target_currency, pricePct);
            if (!prop.ok) {
                out.proposed_price = null;
                out.delta_pct_vs_proposed = null;
                out.delta_pct_vs_source = null;
                out.can_apply = false;
                return out;
            }
            out.proposed_price = prop.finalPrice;
            const tgt = Number(out.target_price);
            if (Number.isFinite(tgt) && tgt > 0) {
                out.delta_pct_vs_proposed = ((tgt - prop.finalPrice) / prop.finalPrice) * 100;
            } else {
                out.delta_pct_vs_proposed = null;
            }
            const src = Number(out.source_price);
            if (Number.isFinite(src) && src > 0 && Number.isFinite(tgt)) {
                out.delta_pct_vs_source = ((tgt - src) / src) * 100;
            } else {
                out.delta_pct_vs_source = null;
            }
            out.can_apply =
                (out.link_status === 'linked' || out.link_kind) &&
                out.target_product_id != null &&
                !pricesEqual(tgt, prop.finalPrice);
            return out;
        });
    }

    router.get('/settings', async (req, res) => {
        try {
            await ensureSchema();
            const sourceSiteId = await getSourceSiteId();
            const [sites] = await db.query(
                'SELECT id, name, domain, cms_type FROM my_sites ORDER BY id ASC'
            );
            const [cfgRows] = await db.query('SELECT * FROM network_price_site_settings');
            const byId = new Map((cfgRows || []).map((r) => [Number(r.target_site_id), r]));
            const targets = (sites || [])
                .filter((s) => Number(s.id) !== sourceSiteId)
                .map((s) => {
                    const c = byId.get(Number(s.id));
                    return {
                        site_id: Number(s.id),
                        name: s.name,
                        domain: s.domain,
                        cms_type: s.cms_type,
                        enabled: c ? Number(c.enabled) === 1 : false,
                        price_pct: c && c.price_pct != null ? Number(c.price_pct) : null,
                        updated_at: c ? c.updated_at : null,
                    };
                });
            const source = (sites || []).find((s) => Number(s.id) === sourceSiteId) || null;
            res.json({
                success: true,
                source_site_id: sourceSiteId,
                source,
                targets,
            });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message || 'settings error' });
        }
    });

    router.post('/settings', async (req, res) => {
        try {
            await ensureSchema();
            const body = req.body || {};
            if (body.source_site_id != null) {
                const sid = parseInt(String(body.source_site_id), 10);
                if (Number.isFinite(sid) && sid > 0) {
                    appSettings.network_prices_source_site_id = String(sid);
                    await db.query(
                        `INSERT INTO app_settings (setting_key, setting_value) VALUES (?, ?)
                         ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)`,
                        ['network_prices_source_site_id', String(sid)]
                    );
                }
            }
            const targets = Array.isArray(body.targets) ? body.targets : [];
            for (const t of targets) {
                const tid = parseInt(String(t.site_id || t.target_site_id || ''), 10);
                if (!Number.isFinite(tid) || tid < 1) continue;
                const enabled = t.enabled === true || t.enabled === 1 || t.enabled === '1' ? 1 : 0;
                let pricePct = null;
                if (t.price_pct !== undefined && t.price_pct !== null && String(t.price_pct).trim() !== '') {
                    const n = Number(String(t.price_pct).replace(',', '.'));
                    if (Number.isFinite(n)) pricePct = n;
                }
                // eslint-disable-next-line no-await-in-loop
                await db.query(
                    `INSERT INTO network_price_site_settings (target_site_id, enabled, price_pct)
                     VALUES (?, ?, ?)
                     ON DUPLICATE KEY UPDATE enabled = VALUES(enabled), price_pct = VALUES(price_pct)`,
                    [tid, enabled, pricePct]
                );
            }
            const [[verify]] = await Promise.all([
                (async () => {
                    const sourceSiteId = await getSourceSiteId();
                    const [cfgRows] = await db.query('SELECT * FROM network_price_site_settings');
                    return { source_site_id: sourceSiteId, targets: cfgRows };
                })(),
            ]);
            res.json({ success: true, verified: verify });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message || 'save settings error' });
        }
    });

    router.get('/matrix', async (req, res) => {
        try {
            await ensureSchema();
            const sourceSiteId = await getSourceSiteId();
            const targetSiteId = parseInt(String(req.query.target_site_id || ''), 10);
            if (!Number.isFinite(targetSiteId) || targetSiteId < 1) {
                return res.status(400).json({ success: false, error: 'target_site_id обязателен' });
            }
            const [[cfg]] = await db.query(
                'SELECT * FROM network_price_site_settings WHERE target_site_id = ? LIMIT 1',
                [targetSiteId]
            );
            const pricePct = cfg && cfg.price_pct != null ? Number(cfg.price_pct) : null;
            const enabled = cfg ? Number(cfg.enabled) === 1 : false;
            const linkStatus = String(req.query.link_status || 'all');
            const search = String(req.query.search || '');
            const limit = req.query.limit;
            const offset = req.query.offset;
            const { rows, total } = await buildMatrixRows(
                sourceSiteId,
                targetSiteId,
                linkStatus,
                search,
                limit,
                offset
            );
            const data = enrichProposed(rows, enabled && pricePct != null ? pricePct : null);
            res.json({
                success: true,
                source_site_id: sourceSiteId,
                target_site_id: targetSiteId,
                enabled,
                price_pct: pricePct,
                total,
                limit: Math.min(300, Math.max(1, Number(limit) || 100)),
                offset: Math.max(0, Number(offset) || 0),
                data,
            });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message || 'matrix error' });
        }
    });

    router.post('/link', async (req, res) => {
        try {
            await ensureSchema();
            const sourceSiteId = await getSourceSiteId();
            const targetSiteId = parseInt(String(req.body.target_site_id || ''), 10);
            const sourceProductId = parseInt(String(req.body.source_product_id || ''), 10);
            const targetProductId = parseInt(String(req.body.target_product_id || ''), 10);
            if (!Number.isFinite(targetSiteId) || !Number.isFinite(sourceProductId) || !Number.isFinite(targetProductId)) {
                return res.status(400).json({ success: false, error: 'Нужны target_site_id, source_product_id, target_product_id' });
            }
            await db.query(
                `DELETE FROM network_product_link_ignore
                 WHERE source_site_id = ? AND source_product_id = ? AND target_site_id = ?`,
                [sourceSiteId, sourceProductId, targetSiteId]
            );
            await db.query(
                `INSERT INTO network_product_links
                 (source_site_id, source_product_id, target_site_id, target_product_id)
                 VALUES (?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE target_product_id = VALUES(target_product_id)`,
                [sourceSiteId, sourceProductId, targetSiteId, targetProductId]
            );
            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message || 'link error' });
        }
    });

    router.post('/unlink', async (req, res) => {
        try {
            await ensureSchema();
            const sourceSiteId = await getSourceSiteId();
            const targetSiteId = parseInt(String(req.body.target_site_id || ''), 10);
            const sourceProductId = parseInt(String(req.body.source_product_id || ''), 10);
            const targetProductId = parseInt(String(req.body.target_product_id || ''), 10);
            if (!Number.isFinite(targetSiteId) || !Number.isFinite(sourceProductId)) {
                return res.status(400).json({ success: false, error: 'Нужны target_site_id и source_product_id' });
            }
            await db.query(
                `DELETE FROM network_product_links
                 WHERE source_site_id = ? AND source_product_id = ? AND target_site_id = ?`,
                [sourceSiteId, sourceProductId, targetSiteId]
            );
            // Разорвать автопару по SKU — ignore
            await db.query(
                `INSERT INTO network_product_link_ignore (source_site_id, source_product_id, target_site_id)
                 VALUES (?, ?, ?)
                 ON DUPLICATE KEY UPDATE created_at = CURRENT_TIMESTAMP`,
                [sourceSiteId, sourceProductId, targetSiteId]
            );
            if (Number.isFinite(targetProductId)) {
                /* keep ignore by source */
            }
            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message || 'unlink error' });
        }
    });

    async function applyLinkedPairsToSite(targetSiteId, opts) {
        const o = opts || {};
        const dryRun = !!o.dry_run;
        const actor = String(o.actor || 'network_prices').slice(0, 100);
        const search = o.search || '';
        const started = Date.now();

        await ensureSchema();
        const sourceSiteId = await getSourceSiteId();
        const [[cfg]] = await db.query(
            'SELECT * FROM network_price_site_settings WHERE target_site_id = ? LIMIT 1',
            [targetSiteId]
        );
        if (!cfg || Number(cfg.enabled) !== 1 || cfg.price_pct == null) {
            return {
                success: true,
                dry_run: dryRun,
                skipped_no_pct: 1,
                scanned: 0,
                written: 0,
                skipped_unchanged: 0,
                cms_failed: 0,
                errors: [],
                message: 'Сайт не участвует или % не задан — ничего не меняем',
                duration_sec: 0,
            };
        }
        const pricePct = Number(cfg.price_pct);
        const pairs = await loadLinkedPairs(sourceSiteId, targetSiteId, { search });
        if (pairs.length > APPLY_HARD_MAX) {
            return {
                success: false,
                error: `Слишком много пар (${pairs.length} > ${APPLY_HARD_MAX})`,
            };
        }

        const [sites] = await db.query('SELECT * FROM my_sites WHERE id = ?', [targetSiteId]);
        if (!sites.length) {
            return { success: false, error: 'Целевой сайт не найден' };
        }
        const site = sites[0];
        let conn = null;
        if (!dryRun) {
            conn = await openSiteConnection(site);
        }

        const result = {
            success: true,
            dry_run: dryRun,
            scanned: 0,
            written: 0,
            would_update: 0,
            skipped_unchanged: 0,
            skipped_no_source_price: 0,
            cms_failed: 0,
            errors: [],
            duration_sec: null,
            target_site_id: targetSiteId,
            price_pct: pricePct,
        };

        try {
            for (const pair of pairs) {
                if (applyJob.cancelRequested) break;
                result.scanned += 1;
                const prop = computeProposed(pair.source_price, pair.source_currency || pair.target_currency, pricePct);
                if (!prop.ok) {
                    result.skipped_no_source_price += 1;
                    continue;
                }
                if (pricesEqual(pair.target_price, prop.finalPrice)) {
                    result.skipped_unchanged += 1;
                    continue;
                }
                if (dryRun) {
                    result.would_update += 1;
                    continue;
                }
                try {
                    const product = {
                        source_id: pair.target_code,
                        sku: pair.target_sku,
                        site_id: targetSiteId,
                    };
                    // eslint-disable-next-line no-await-in-loop
                    await applyPriceToCms(conn, site, product, prop.finalPrice);
                    // eslint-disable-next-line no-await-in-loop
                    await db.query(
                        `UPDATE my_products
                         SET price = ?, network_sync_at = NOW(), network_sync_note = ?, updated_at = NOW()
                         WHERE id = ?`,
                        [
                            prop.finalPrice,
                            `network;from_site=${sourceSiteId};pct=${pricePct};by=${actor}`,
                            pair.target_product_id,
                        ]
                    );
                    result.written += 1;
                } catch (itemErr) {
                    result.cms_failed += 1;
                    if (result.errors.length < 20) {
                        result.errors.push({
                            code: pair.target_sku || pair.target_code || pair.target_product_id,
                            error: String(itemErr && itemErr.message ? itemErr.message : itemErr),
                        });
                    }
                }
            }
        } finally {
            if (conn) {
                try {
                    await conn.end();
                } catch (_) {}
            }
        }

        result.duration_sec = Math.round(((Date.now() - started) / 1000) * 100) / 100;
        result.message = dryRun
            ? `Пробный прогон: к записи ${result.would_update}, без изменений ${result.skipped_unchanged}, без цены эталона ${result.skipped_no_source_price}`
            : `Записано ✓ ${result.written}, без изменений ${result.skipped_unchanged}, ошибок CMS × ${result.cms_failed}`;
        return result;
    }

    router.post('/apply', async (req, res) => {
        try {
            await ensureSchema();
            if (applyJob.active) {
                return res.status(409).json({ success: false, error: 'Уже идёт применение цен сети' });
            }
            const targetSiteId = parseInt(String(req.body.target_site_id || ''), 10);
            if (!Number.isFinite(targetSiteId) || targetSiteId < 1) {
                return res.status(400).json({ success: false, error: 'target_site_id обязателен' });
            }
            const dryRun =
                req.body.dry_run === 1 ||
                req.body.dry_run === '1' ||
                req.body.dry_run === true ||
                String(req.query.dry_run || '') === '1';
            const confirm =
                req.body.confirm === true || req.body.confirm === 1 || req.body.confirm === '1';
            if (!dryRun && !confirm) {
                return res.status(400).json({
                    success: false,
                    error: 'Для записи укажите confirm:true или dry_run:1',
                });
            }
            const actor =
                (req.datagonActor && (req.datagonActor.display_name || req.datagonActor.email)) ||
                'user';
            applyJob = {
                active: true,
                cancelRequested: false,
                phase: dryRun ? 'dry_run' : 'writing',
                message: dryRun ? 'Пробный прогон…' : 'Запись цен…',
                dry_run: dryRun,
                scanned: 0,
                written: 0,
                skipped_unchanged: 0,
                skipped_no_link: 0,
                skipped_no_pct: 0,
                skipped_no_source_price: 0,
                cms_failed: 0,
                errors: [],
                started_at: new Date().toISOString(),
                finished_at: null,
                duration_sec: null,
                target_site_id: targetSiteId,
            };

            const result = await applyLinkedPairsToSite(targetSiteId, {
                dry_run: dryRun,
                actor,
                search: String(req.body.search || ''),
            });
            applyJob.active = false;
            applyJob.phase = result.success === false ? 'error' : 'done';
            applyJob.message = result.message || result.error || '';
            applyJob.scanned = result.scanned || 0;
            applyJob.written = result.written || 0;
            applyJob.would_update = result.would_update || 0;
            applyJob.skipped_unchanged = result.skipped_unchanged || 0;
            applyJob.skipped_no_source_price = result.skipped_no_source_price || 0;
            applyJob.skipped_no_pct = result.skipped_no_pct || 0;
            applyJob.cms_failed = result.cms_failed || 0;
            applyJob.errors = result.errors || [];
            applyJob.finished_at = new Date().toISOString();
            applyJob.duration_sec = result.duration_sec;
            if (result.success === false) {
                return res.status(400).json(result);
            }
            res.json(result);
        } catch (e) {
            applyJob.active = false;
            applyJob.phase = 'error';
            applyJob.message = e.message || 'apply error';
            res.status(500).json({ success: false, error: e.message || 'apply error' });
        }
    });

    router.get('/apply-status', (req, res) => {
        res.json({ success: true, status: applyJob });
    });

    router.post('/apply-stop', (req, res) => {
        applyJob.cancelRequested = true;
        res.json({ success: true });
    });

    return router;
}

networkPricesRouterFactory.triggerNetworkPricesSyncFromSettings = async function triggerNetworkPricesSyncFromSettings(
    db,
    appSettings,
    opts
) {
    const o = opts || {};
    const onProgress = typeof o.onProgress === 'function' ? o.onProgress : null;
    const factory = networkPricesRouterFactory;
    // Reuse route helpers via a temporary router instance is awkward; call SQL directly.
    const {
        applyPriceToCms: applyCms,
        roundPriceForCurrency: roundPx,
        openSiteConnection: openConn,
    } = require('../lib/datagonCmsPriceWrite');

    await db.query(`
        CREATE TABLE IF NOT EXISTS network_price_site_settings (
            target_site_id INT NOT NULL PRIMARY KEY,
            enabled TINYINT(1) NOT NULL DEFAULT 0,
            price_pct DECIMAL(10,4) NULL,
            updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await db.query(`
        CREATE TABLE IF NOT EXISTS network_product_links (
            id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
            source_site_id INT NOT NULL,
            source_product_id BIGINT NOT NULL,
            target_site_id INT NOT NULL,
            target_product_id BIGINT NOT NULL,
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            UNIQUE KEY uq_np_link_pair (source_site_id, source_product_id, target_site_id),
            UNIQUE KEY uq_np_link_target (target_site_id, target_product_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await db.query(`
        CREATE TABLE IF NOT EXISTS network_product_link_ignore (
            source_site_id INT NOT NULL,
            source_product_id BIGINT NOT NULL,
            target_site_id INT NOT NULL,
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (source_site_id, source_product_id, target_site_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    const sourceSiteId = parseInt(String(appSettings.network_prices_source_site_id || '2'), 10) || 2;
    const [cfgRows] = await db.query(
        `SELECT * FROM network_price_site_settings
         WHERE enabled = 1 AND price_pct IS NOT NULL`
    );
    if (!cfgRows.length) {
        return {
            success: true,
            message: 'Нет сайтов с заданным % — пропуск',
            written: 0,
            scanned: 0,
        };
    }

    let scanned = 0;
    let written = 0;
    let skipped = 0;
    let failed = 0;
    const errors = [];

    for (const cfg of cfgRows) {
        const targetSiteId = Number(cfg.target_site_id);
        const pricePct = Number(cfg.price_pct);
        const [sites] = await db.query('SELECT * FROM my_sites WHERE id = ?', [targetSiteId]);
        if (!sites.length) continue;
        const site = sites[0];
        const [pairs] = await db.query(
            `
            SELECT
                s.price AS source_price, s.currency AS source_currency,
                t.id AS target_product_id, t.source_id AS target_code, t.sku AS target_sku,
                t.price AS target_price, t.currency AS target_currency
            FROM my_products s
            INNER JOIN my_products t
                ON t.site_id = ?
               AND t.is_active = 1
               AND (
                    EXISTS (
                        SELECT 1 FROM network_product_links ml
                        WHERE ml.source_site_id = s.site_id AND ml.source_product_id = s.id
                          AND ml.target_site_id = t.site_id AND ml.target_product_id = t.id
                    )
                    OR (
                        TRIM(IFNULL(s.sku, '')) <> '' AND TRIM(s.sku) = TRIM(t.sku)
                        AND NOT EXISTS (
                            SELECT 1 FROM network_product_link_ignore ig
                            WHERE ig.source_site_id = s.site_id AND ig.source_product_id = s.id
                              AND ig.target_site_id = t.site_id
                        )
                        AND NOT EXISTS (
                            SELECT 1 FROM network_product_links ml3
                            WHERE ml3.source_site_id = s.site_id AND ml3.source_product_id = s.id
                              AND ml3.target_site_id = t.site_id
                        )
                    )
               )
            WHERE s.site_id = ? AND s.is_active = 1
            `,
            [targetSiteId, sourceSiteId]
        );

        let conn = null;
        try {
            conn = await openConn(site);
            for (const pair of pairs || []) {
                scanned += 1;
                const base = Number(pair.source_price);
                if (!Number.isFinite(base) || base <= 0) {
                    skipped += 1;
                    continue;
                }
                const finalPrice = roundPx(base * (1 + pricePct / 100), pair.source_currency || pair.target_currency);
                if (!Number.isFinite(finalPrice) || finalPrice <= 0) {
                    skipped += 1;
                    continue;
                }
                if (Math.abs(Number(pair.target_price) - finalPrice) < PRICE_EPS) {
                    skipped += 1;
                    continue;
                }
                try {
                    // eslint-disable-next-line no-await-in-loop
                    await applyCms(
                        conn,
                        site,
                        { source_id: pair.target_code, sku: pair.target_sku },
                        finalPrice
                    );
                    // eslint-disable-next-line no-await-in-loop
                    await db.query(
                        `UPDATE my_products
                         SET price = ?, network_sync_at = NOW(), network_sync_note = ?, updated_at = NOW()
                         WHERE id = ?`,
                        [finalPrice, `network;auto;pct=${pricePct}`, pair.target_product_id]
                    );
                    written += 1;
                } catch (e) {
                    failed += 1;
                    if (errors.length < 20) {
                        errors.push({
                            code: pair.target_sku || pair.target_code,
                            error: String(e.message || e),
                        });
                    }
                }
                if (onProgress && scanned % 50 === 0) {
                    onProgress({
                        scanned,
                        written,
                        skipped,
                        failed,
                        message: `Цены сети: ${written} записано / ${scanned} просмотрено (сайт ${targetSiteId})`,
                    });
                }
            }
        } finally {
            if (conn) {
                try {
                    await conn.end();
                } catch (_) {}
            }
        }
    }

    return {
        success: failed === 0 || written > 0,
        scanned,
        written,
        skipped,
        failed,
        errors,
        message: `Цены сети: записано ✓ ${written}, без изменений ${skipped}, ошибок × ${failed}`,
    };
};

module.exports = networkPricesRouterFactory;
