/**
 * Цены сети: эталон (Альмамед) → целевые сайты с % наценки/скидки.
 * Запись в CMS при заданном price_pct; автосинк — triggerNetworkPricesSyncFromSettings.
 */
const express = require('express');
const {
    applyPriceToCms,
    deactivateProductInCms,
    activateProductInCms,
    clearBitrixStorefrontCache,
    fetchLiveCmsPrices,
    applyLiveCmsPricesToRows,
    roundPriceForCurrency,
    openSiteConnection,
} = require('../lib/datagonCmsPriceWrite');
const { getFxRates, toRub, normalizeCurrency } = require('../lib/datagonFxRates');

const PRICE_EPS = 0.005;
const APPLY_HARD_MAX = 50000;

function networkPriceWriteGuard({ sourceOk, finalPrice }) {
    const neu = Number(finalPrice);
    if (!sourceOk || !Number.isFinite(neu) || neu < 0) {
        return {
            allow: false,
            code: 'bad_price',
            note: 'skip;guard=bad_price',
            error: 'у эталона нет цены (пусто / не число) — не пишем',
        };
    }
    return { allow: true };
}

async function stampNetworkGuardSkip(db, targetProductId, note) {
    const id = Number(targetProductId);
    if (!Number.isFinite(id) || id <= 0) return;
    await db.query(
        `UPDATE my_products
         SET network_sync_at = NOW(), network_sync_note = ?, updated_at = NOW()
         WHERE id = ?`,
        [String(note || 'skip;guard').slice(0, 255), id]
    );
}

async function applyNetworkPriceGuard(db, opts) {
    const o = opts || {};
    const pair = o.pair || {};
    const g = networkPriceWriteGuard({
        sourceOk: !!o.sourceOk,
        finalPrice: o.finalPrice,
    });
    if (g.allow) return g;
    o.counters.skipped_no_source_price += 1;
    if (o.errors && o.errors.length < 20) {
        o.errors.push({
            code: pair.target_sku || pair.target_code || String(pair.target_product_id || ''),
            error: g.error,
        });
    }
    if (!o.dryRun) {
        await stampNetworkGuardSkip(db, pair.target_product_id, g.note);
    }
    return g;
}

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
        skipped_price_crash: 0,
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
        await db.query(`
            CREATE TABLE IF NOT EXISTS network_content_tasks (
                target_site_id INT NOT NULL,
                target_product_id BIGINT NOT NULL,
                add_photo VARCHAR(16) NOT NULL DEFAULT '',
                add_parent VARCHAR(16) NOT NULL DEFAULT '',
                add_satellite VARCHAR(16) NOT NULL DEFAULT '',
                delete_product VARCHAR(16) NOT NULL DEFAULT '',
                updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                PRIMARY KEY (target_site_id, target_product_id),
                KEY idx_np_content_site (target_site_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        `);
        await db.query(`
            CREATE TABLE IF NOT EXISTS network_prices_action_log (
                id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
                created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                actor VARCHAR(120) NOT NULL DEFAULT '',
                action VARCHAR(32) NOT NULL,
                target_site_id INT NULL,
                source_product_id BIGINT NULL,
                target_product_id BIGINT NULL,
                target_sku VARCHAR(120) NULL,
                message VARCHAR(512) NOT NULL DEFAULT '',
                detail_json JSON NULL,
                KEY idx_np_alog_created (created_at),
                KEY idx_np_alog_site_action (target_site_id, action)
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

    function resolveActorName(req) {
        const a = req && req.datagonActor;
        if (!a) return 'user';
        const full = String(a.full_name || a.display_name || '').trim();
        if (full) return full.slice(0, 120);
        const u = String(a.username || a.email || '').trim();
        if (u) return u.slice(0, 120);
        if (a.id) return `user#${a.id}`;
        return 'user';
    }

    async function writeActionLog(entry) {
        const e = entry || {};
        try {
            await db.query(
                `INSERT INTO network_prices_action_log
                 (actor, action, target_site_id, source_product_id, target_product_id, target_sku, message, detail_json)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    String(e.actor || '').slice(0, 120),
                    String(e.action || '').slice(0, 32),
                    e.target_site_id != null ? Number(e.target_site_id) : null,
                    e.source_product_id != null ? Number(e.source_product_id) : null,
                    e.target_product_id != null ? Number(e.target_product_id) : null,
                    e.target_sku != null ? String(e.target_sku).slice(0, 120) : null,
                    String(e.message || '').slice(0, 512),
                    e.detail != null ? JSON.stringify(e.detail) : null,
                ]
            );
        } catch (err) {
            console.warn('[network-prices] action log:', err && err.message ? err.message : err);
        }
    }

    function normalizeSku(v) {
        return String(v || '')
            .replace(/\u00a0/g, ' ')
            .replace(/[\u200b-\u200d\ufeff]/g, '')
            .trim();
    }

    /**
     * Предложение для CMS цели (обычно RUB): эталон → RUB по курсу ЦБ → × (1+%) → округление RUB.
     */
    function computeProposed(sourcePrice, sourceCurrency, pricePct, fx) {
        const pct = Number(pricePct);
        if (!Number.isFinite(pct)) return { ok: false };
        const srcCur = normalizeCurrency(sourceCurrency || 'RUB');
        const baseRub = toRub(sourcePrice, srcCur, fx);
        if (!Number.isFinite(baseRub) || baseRub < 0) return { ok: false };
        const raw = baseRub * (1 + pct / 100);
        const finalPrice = roundPriceForCurrency(raw, 'RUB');
        if (!Number.isFinite(finalPrice) || finalPrice < 0) return { ok: false };
        return {
            ok: true,
            finalPrice,
            source_price_rub: Math.round(Number(baseRub) * 100) / 100,
            source_currency: srcCur,
            proposed_currency: 'RUB',
            fx_applied: srcCur !== 'RUB',
        };
    }

    function pricesEqual(a, b) {
        const x = Number(a);
        const y = Number(b);
        if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
        return Math.abs(x - y) < PRICE_EPS;
    }

    function enrichProposed(rows, pricePct, fx) {
        return (rows || []).map((r) => {
            const out = { ...r };
            out.source_currency = normalizeCurrency(out.source_currency || 'RUB');
            out.target_currency = normalizeCurrency(out.target_currency || 'RUB');
            if (pricePct == null || !Number.isFinite(Number(pricePct))) {
                out.proposed_price = null;
                out.proposed_currency = null;
                out.source_price_rub = null;
                out.fx_applied = false;
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
                    out.proposed_currency = null;
                    out.source_price_rub = null;
                    out.fx_applied = false;
                    out.delta_pct_vs_proposed = null;
                    out.delta_pct_vs_source = null;
                    out.can_apply = false;
                    return out;
                }
            }
            const prop = computeProposed(out.source_price, out.source_currency, pricePct, fx);
            if (!prop.ok) {
                out.proposed_price = null;
                out.proposed_currency = null;
                out.source_price_rub = null;
                out.fx_applied = false;
                out.delta_pct_vs_proposed = null;
                out.delta_pct_vs_source = null;
                out.can_apply = false;
                out.write_guard = 'no_source';
                return out;
            }
            out.proposed_price = prop.finalPrice;
            out.proposed_currency = 'RUB';
            out.source_price_rub = Number(prop.source_price_rub);
            out.fx_applied = !!prop.fx_applied;
            const tgtRub = toRub(out.target_price, out.target_currency, fx);
            const guard = networkPriceWriteGuard({
                sourceOk: true,
                finalPrice: prop.finalPrice,
                targetRub: tgtRub,
            });
            out.write_guard = guard.allow ? null : guard.code;
            if (Number.isFinite(tgtRub) && tgtRub > 0) {
                out.delta_pct_vs_proposed = ((tgtRub - prop.finalPrice) / prop.finalPrice) * 100;
            } else {
                out.delta_pct_vs_proposed = null;
            }
            if (Number.isFinite(out.source_price_rub) && out.source_price_rub > 0 && Number.isFinite(tgtRub)) {
                out.delta_pct_vs_source = ((tgtRub - out.source_price_rub) / out.source_price_rub) * 100;
            } else {
                out.delta_pct_vs_source = null;
            }
            out.can_apply =
                (out.link_status === 'linked' || out.link_kind) &&
                out.target_product_id != null &&
                !pricesEqual(tgtRub, prop.finalPrice) &&
                !!guard.allow;
            return out;
        });
    }

    const CONTENT_TASK_FIELDS = ['add_photo', 'add_parent', 'add_satellite', 'delete_product'];
    const CONTENT_TASK_STATUSES = new Set(['', 'need', 'doing', 'done']);

    function emptyContentTasks() {
        return {
            add_photo: '',
            add_parent: '',
            add_satellite: '',
            delete_product: '',
        };
    }

    async function attachContentTasks(targetSiteId, rows) {
        const list = rows || [];
        const ids = [
            ...new Set(
                list
                    .map((r) => Number(r.target_product_id))
                    .filter((id) => Number.isFinite(id) && id > 0)
            ),
        ];
        const byId = new Map();
        if (ids.length) {
            const [taskRows] = await db.query(
                `SELECT target_product_id, add_photo, add_parent, add_satellite, delete_product
                 FROM network_content_tasks
                 WHERE target_site_id = ? AND target_product_id IN (?)`,
                [targetSiteId, ids]
            );
            (taskRows || []).forEach((t) => {
                byId.set(Number(t.target_product_id), {
                    add_photo: t.add_photo || '',
                    add_parent: t.add_parent || '',
                    add_satellite: t.add_satellite || '',
                    delete_product: t.delete_product || '',
                });
            });
        }
        return list.map((r) => {
            const tid = Number(r.target_product_id);
            return {
                ...r,
                content: byId.get(tid) || emptyContentTasks(),
            };
        });
    }

    /**
     * Связанные пары: manual links ∪ auto по sku (без TRIM — индекс site_id+sku).
     * Стартуем с целевого сайта (обычно меньше строк), join на эталон.
     */
    async function loadLinkedPairs(sourceSiteId, targetSiteId, opts) {
        const o = opts || {};
        const search = String(o.search || '').trim().slice(0, 120);
        const lim = o.limit != null ? Math.min(50000, Math.max(1, Number(o.limit) || 100)) : null;
        const off = o.offset != null ? Math.max(0, Number(o.offset) || 0) : null;
        const withCount = !!o.withCount;

        const flatUnion = `
            (
                SELECT
                    s.id AS source_product_id,
                    s.source_id AS source_code,
                    s.sku AS source_sku,
                    s.name AS source_name,
                    s.price AS source_price,
                    s.currency AS source_currency,
                    s.stock AS source_stock,
                    s.source_url AS source_url,
                    t.id AS target_product_id,
                    t.source_id AS target_code,
                    t.sku AS target_sku,
                    t.name AS target_name,
                    t.price AS target_price,
                    t.currency AS target_currency,
                    t.stock AS target_stock,
                    t.source_url AS target_url,
                    t.site_id AS target_site_id,
                    'manual' AS link_kind,
                    ml.created_at AS link_at
                FROM network_product_links ml
                INNER JOIN my_products s ON s.id = ml.source_product_id AND s.is_active = 1
                INNER JOIN my_products t ON t.id = ml.target_product_id AND t.is_active = 1
                WHERE ml.source_site_id = ?
                  AND ml.target_site_id = ?
            )
            UNION
            (
                SELECT
                    s.id AS source_product_id,
                    s.source_id AS source_code,
                    s.sku AS source_sku,
                    s.name AS source_name,
                    s.price AS source_price,
                    s.currency AS source_currency,
                    s.stock AS source_stock,
                    s.source_url AS source_url,
                    t.id AS target_product_id,
                    t.source_id AS target_code,
                    t.sku AS target_sku,
                    t.name AS target_name,
                    t.price AS target_price,
                    t.currency AS target_currency,
                    t.stock AS target_stock,
                    t.source_url AS target_url,
                    t.site_id AS target_site_id,
                    'auto' AS link_kind,
                    CAST(NULL AS DATETIME) AS link_at
                FROM my_products t
                INNER JOIN my_products s
                    ON s.site_id = ?
                   AND s.is_active = 1
                   AND s.sku <> ''
                   AND s.sku = t.sku
                WHERE t.site_id = ?
                  AND t.is_active = 1
                  AND t.sku <> ''
                  AND COALESCE(t.source_enabled, 1) = 1
                  AND NOT EXISTS (
                      SELECT 1 FROM network_product_link_ignore ig
                      WHERE ig.source_site_id = ?
                        AND ig.source_product_id = s.id
                        AND ig.target_site_id = ?
                  )
                  AND NOT EXISTS (
                      SELECT 1 FROM network_product_links ml3
                      WHERE ml3.source_site_id = ?
                        AND ml3.source_product_id = s.id
                        AND ml3.target_site_id = ?
                  )
            )
        `;

        const baseParams = [
            sourceSiteId,
            targetSiteId,
            sourceSiteId,
            targetSiteId,
            sourceSiteId,
            targetSiteId,
            sourceSiteId,
            targetSiteId,
        ];

        // Свежие ручные связи и свежие задачи контенту — сверху.
        let wrap = `
            SELECT x.*, ct.updated_at AS content_updated_at
            FROM (${flatUnion}) x
            LEFT JOIN network_content_tasks ct
              ON ct.target_site_id = ?
             AND ct.target_product_id = x.target_product_id
            WHERE 1=1
        `;
        const params = baseParams.slice();
        params.push(targetSiteId);
        if (search) {
            const like = `%${search}%`;
            wrap += ` AND (
                x.source_sku LIKE ? OR x.source_name LIKE ? OR x.source_code LIKE ?
                OR x.target_sku LIKE ? OR x.target_name LIKE ? OR x.target_code LIKE ?
            )`;
            params.push(like, like, like, like, like, like);
        }

        let total = null;
        if (withCount) {
            const [cntRows] = await db.query(`SELECT COUNT(*) AS c FROM (${wrap}) c`, params);
            total = Number((cntRows && cntRows[0] && cntRows[0].c) || 0);
        }

        let dataSql = `${wrap}
            ORDER BY
              GREATEST(
                COALESCE(UNIX_TIMESTAMP(ct.updated_at), 0),
                COALESCE(UNIX_TIMESTAMP(x.link_at), 0)
              ) DESC,
              x.target_product_id DESC`;
        const dataParams = params.slice();
        if (lim != null) {
            dataSql += ` LIMIT ?`;
            dataParams.push(lim);
            if (off != null && off > 0) {
                dataSql += ` OFFSET ?`;
                dataParams.push(off);
            }
        }

        const [rows] = await db.query(dataSql, dataParams);
        if (withCount) return { rows: rows || [], total: total || 0 };
        return rows || [];
    }

    async function countOrFetchUnlinked(kind, sourceSiteId, targetSiteId, search, limit, offset, onlyCount) {
        const like = search ? `%${String(search).trim().slice(0, 120)}%` : null;
        if (kind === 'source_only') {
            const p = [targetSiteId, sourceSiteId, targetSiteId, sourceSiteId, targetSiteId, sourceSiteId];
            let whereExtra = '';
            if (like) {
                whereExtra = ` AND (s.sku LIKE ? OR s.name LIKE ? OR s.source_id LIKE ?)`;
                p.push(like, like, like);
            }
            const fromWhere = `
                FROM my_products s
                LEFT JOIN my_products t
                    ON t.site_id = ?
                   AND t.is_active = 1
                   AND s.sku <> ''
                   AND t.sku = s.sku
                LEFT JOIN network_product_links ml
                    ON ml.source_site_id = ?
                   AND ml.source_product_id = s.id
                   AND ml.target_site_id = ?
                LEFT JOIN network_product_link_ignore ig
                    ON ig.source_site_id = ?
                   AND ig.source_product_id = s.id
                   AND ig.target_site_id = ?
                WHERE s.site_id = ?
                  AND s.is_active = 1
                  AND ml.id IS NULL
                  AND (t.id IS NULL OR ig.source_product_id IS NOT NULL)
                  ${whereExtra}
            `;
            if (onlyCount) {
                const [c] = await db.query(`SELECT COUNT(*) AS c ${fromWhere}`, p);
                return { total: Number((c && c[0] && c[0].c) || 0), rows: [] };
            }
            p.push(Number(limit) || 100, Number(offset) || 0);
            const [rows] = await db.query(
                `SELECT s.id AS source_product_id, s.source_id AS source_code, s.sku AS source_sku,
                        s.name AS source_name, s.price AS source_price, s.currency AS source_currency,
                        s.stock AS source_stock, s.source_url AS source_url
                 ${fromWhere}
                 ORDER BY s.id DESC
                 LIMIT ? OFFSET ?`,
                p
            );
            return {
                total: null,
                rows: (rows || []).map((s) => ({
                    ...s,
                    target_product_id: null,
                    target_code: null,
                    target_sku: null,
                    target_name: null,
                    target_price: null,
                    target_currency: null,
                    target_stock: null,
                    target_url: null,
                    link_kind: null,
                    link_status: 'source_only',
                })),
            };
        }

        // target_only — маленький сайт: LEFT JOIN на эталон
        const tp = [sourceSiteId, sourceSiteId, targetSiteId, targetSiteId, targetSiteId];
        let whereExtra = '';
        if (like) {
            whereExtra = ` AND (t.sku LIKE ? OR t.name LIKE ? OR t.source_id LIKE ?)`;
            tp.push(like, like, like);
        }
        const fromWhere = `
            FROM my_products t
            LEFT JOIN my_products s
                ON s.site_id = ?
               AND s.is_active = 1
               AND t.sku <> ''
               AND s.sku = t.sku
            LEFT JOIN network_product_links ml
                ON ml.source_site_id = ?
               AND ml.target_site_id = ?
               AND ml.target_product_id = t.id
            LEFT JOIN network_product_link_ignore ig
                ON ig.source_site_id = s.site_id
               AND ig.source_product_id = s.id
               AND ig.target_site_id = ?
            LEFT JOIN network_content_tasks ct
                ON ct.target_site_id = t.site_id
               AND ct.target_product_id = t.id
            WHERE t.site_id = ?
              AND t.is_active = 1
              AND ml.id IS NULL
              AND (s.id IS NULL OR ig.source_product_id IS NOT NULL)
              ${whereExtra}
        `;
        if (onlyCount) {
            const [c] = await db.query(`SELECT COUNT(*) AS c ${fromWhere}`, tp);
            return { total: Number((c && c[0] && c[0].c) || 0), rows: [] };
        }
        tp.push(Number(limit) || 100, Number(offset) || 0);
        const [rows] = await db.query(
            `SELECT t.id AS target_product_id, t.source_id AS target_code, t.sku AS target_sku,
                    t.name AS target_name, t.price AS target_price, t.currency AS target_currency,
                    t.stock AS target_stock, t.source_url AS target_url,
                    COALESCE(t.source_enabled, 1) AS target_source_enabled,
                    ct.updated_at AS content_updated_at
             ${fromWhere}
             ORDER BY
               (ct.updated_at IS NULL) ASC,
               ct.updated_at DESC,
               t.id DESC
             LIMIT ? OFFSET ?`,
            tp
        );
        return {
            total: null,
            rows: (rows || []).map((t) => ({
                source_product_id: null,
                source_code: null,
                source_sku: null,
                source_name: null,
                source_price: null,
                source_currency: null,
                source_stock: null,
                source_url: null,
                ...t,
                target_source_enabled: Number(t.target_source_enabled) === 0 ? 0 : 1,
                link_kind: null,
                link_status: 'target_only',
            })),
        };
    }

    async function buildMatrixRows(sourceSiteId, targetSiteId, linkStatus, search, limit, offset) {
        const st = String(linkStatus || 'linked').toLowerCase();
        const lim = Math.min(300, Math.max(1, Number(limit) || 100));
        const off = Math.max(0, Number(offset) || 0);
        const q = String(search || '').trim().slice(0, 120);

        if (st === 'linked') {
            const { rows, total } = await loadLinkedPairs(sourceSiteId, targetSiteId, {
                search: q,
                limit: lim,
                offset: off,
                withCount: true,
            });
            return {
                rows: (rows || []).map((r) => ({ ...r, link_status: 'linked' })),
                total,
            };
        }

        if (st === 'source_only' || st === 'target_only') {
            const counted = await countOrFetchUnlinked(st, sourceSiteId, targetSiteId, q, lim, off, true);
            const page = await countOrFetchUnlinked(st, sourceSiteId, targetSiteId, q, lim, off, false);
            return { rows: page.rows, total: counted.total };
        }

        if (st === 'unlinked') {
            const srcCnt = await countOrFetchUnlinked('source_only', sourceSiteId, targetSiteId, q, 1, 0, true);
            const tgtCnt = await countOrFetchUnlinked('target_only', sourceSiteId, targetSiteId, q, 1, 0, true);
            const total = srcCnt.total + tgtCnt.total;
            let rows = [];
            if (off < srcCnt.total) {
                const take = Math.min(lim, srcCnt.total - off);
                const part = await countOrFetchUnlinked('source_only', sourceSiteId, targetSiteId, q, take, off, false);
                rows = rows.concat(part.rows);
                if (rows.length < lim) {
                    const need = lim - rows.length;
                    const part2 = await countOrFetchUnlinked('target_only', sourceSiteId, targetSiteId, q, need, 0, false);
                    rows = rows.concat(part2.rows);
                }
            } else {
                const tgtOff = off - srcCnt.total;
                const part = await countOrFetchUnlinked('target_only', sourceSiteId, targetSiteId, q, lim, tgtOff, false);
                rows = part.rows;
            }
            return { rows, total };
        }

        // all = linked + source_only + target_only with segment pagination
        const linked = await loadLinkedPairs(sourceSiteId, targetSiteId, {
            search: q,
            limit: 1,
            offset: 0,
            withCount: true,
        });
        const srcCnt = await countOrFetchUnlinked('source_only', sourceSiteId, targetSiteId, q, 1, 0, true);
        const tgtCnt = await countOrFetchUnlinked('target_only', sourceSiteId, targetSiteId, q, 1, 0, true);
        const linkedTotal = linked.total || 0;
        const total = linkedTotal + srcCnt.total + tgtCnt.total;
        let rows = [];
        let remain = lim;
        let cursor = off;

        if (cursor < linkedTotal && remain > 0) {
            const take = Math.min(remain, linkedTotal - cursor);
            const part = await loadLinkedPairs(sourceSiteId, targetSiteId, {
                search: q,
                limit: take,
                offset: cursor,
                withCount: false,
            });
            rows = rows.concat((part || []).map((r) => ({ ...r, link_status: 'linked' })));
            remain -= take;
            cursor = 0;
        } else {
            cursor -= linkedTotal;
        }

        if (remain > 0) {
            if (cursor < srcCnt.total) {
                const take = Math.min(remain, srcCnt.total - cursor);
                const part = await countOrFetchUnlinked('source_only', sourceSiteId, targetSiteId, q, take, cursor, false);
                rows = rows.concat(part.rows);
                remain -= take;
                cursor = 0;
            } else {
                cursor -= srcCnt.total;
            }
        }

        if (remain > 0) {
            const part = await countOrFetchUnlinked('target_only', sourceSiteId, targetSiteId, q, remain, cursor, false);
            rows = rows.concat(part.rows);
        }

        return { rows, total };
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
            const sourceSiteId = await getSourceSiteId();
            const [cfgRows] = await db.query('SELECT * FROM network_price_site_settings');
            res.json({
                success: true,
                verified: { source_site_id: sourceSiteId, targets: cfgRows || [] },
            });
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
            const withContent = await attachContentTasks(targetSiteId, rows);
            let liveRows = withContent;
            try {
                const [[site]] = await db.query('SELECT * FROM my_sites WHERE id = ? LIMIT 1', [
                    targetSiteId,
                ]);
                if (site) {
                    let cmsConn = null;
                    try {
                        cmsConn = await openSiteConnection(site);
                        const liveMap = await fetchLiveCmsPrices(cmsConn, site, withContent);
                        liveRows = applyLiveCmsPricesToRows(withContent, liveMap);
                    } finally {
                        if (cmsConn) {
                            try {
                                await cmsConn.end();
                            } catch (_) {}
                        }
                    }
                }
            } catch (liveErr) {
                console.error('[network-prices] live CMS prices:', liveErr.message || liveErr);
            }
            const fx = await getFxRates();
            const data = enrichProposed(
                liveRows,
                enabled && pricePct != null ? pricePct : null,
                fx
            );
            res.json({
                success: true,
                source_site_id: sourceSiteId,
                target_site_id: targetSiteId,
                enabled,
                price_pct: pricePct,
                fx: {
                    usd_to_rub: fx.usd_to_rub,
                    eur_to_rub: fx.eur_to_rub,
                    updated_at: fx.updated_at,
                    source: fx.source,
                },
                total,
                limit: Math.min(300, Math.max(1, Number(limit) || 100)),
                offset: Math.max(0, Number(offset) || 0),
                data,
                content_fields: [
                    { key: 'add_photo', label: 'Добавить фото' },
                    { key: 'add_parent', label: 'Добавить товар на родительский' },
                    { key: 'add_satellite', label: 'Добавить товар на сателит' },
                    { key: 'delete_product', label: 'Удалить товар' },
                ],
                content_statuses: [
                    { value: '', label: '—' },
                    { value: 'need', label: 'Нужно' },
                    { value: 'doing', label: 'В работе' },
                    { value: 'done', label: 'Готово' },
                ],
            });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message || 'matrix error' });
        }
    });

    async function resolveSiteProduct(siteId, opts) {
        const o = opts || {};
        const explicitId = parseInt(String(o.product_id || ''), 10);
        if (Number.isFinite(explicitId) && explicitId > 0) {
            const [[row]] = await db.query(
                `SELECT id, source_id, sku, name, price
                 FROM my_products
                 WHERE id = ? AND site_id = ? AND is_active = 1
                 LIMIT 1`,
                [explicitId, siteId]
            );
            if (!row) {
                const err = new Error(`Товар #${explicitId} не найден на сайте ${siteId}`);
                err.status = 404;
                throw err;
            }
            return row;
        }
        const q = String(o.query || '').trim().slice(0, 160);
        if (!q) return null;
        const asId = parseInt(q, 10);
        if (String(asId) === q && Number.isFinite(asId) && asId > 0) {
            const [[byId]] = await db.query(
                `SELECT id, source_id, sku, name, price
                 FROM my_products WHERE id = ? AND site_id = ? AND is_active = 1 LIMIT 1`,
                [asId, siteId]
            );
            if (byId) return byId;
        }
        const [exact] = await db.query(
            `SELECT id, source_id, sku, name, price
             FROM my_products
             WHERE site_id = ? AND is_active = 1
               AND (sku = ? OR source_id = ?)
             ORDER BY id ASC
             LIMIT 6`,
            [siteId, q, q]
        );
        if (exact && exact.length === 1) return exact[0];
        if (exact && exact.length > 1) {
            const err = new Error('Несколько точных совпадений — уточните артикул/код');
            err.status = 409;
            err.candidates = exact;
            throw err;
        }
        const like = `%${q}%`;
        const [fuzzy] = await db.query(
            `SELECT id, source_id, sku, name, price
             FROM my_products
             WHERE site_id = ? AND is_active = 1
               AND (sku LIKE ? OR source_id LIKE ? OR name LIKE ?)
             ORDER BY id ASC
             LIMIT 8`,
            [siteId, like, like, like]
        );
        if (fuzzy && fuzzy.length === 1) return fuzzy[0];
        if (fuzzy && fuzzy.length > 1) {
            const err = new Error(
                'Найдено несколько товаров — укажите точный артикул, код или ID:\n' +
                    fuzzy
                        .slice(0, 8)
                        .map((r) => `#${r.id} · ${r.sku || '—'} · ${r.source_id || '—'} · ${String(r.name || '').slice(0, 60)}`)
                        .join('\n')
            );
            err.status = 409;
            err.candidates = fuzzy;
            throw err;
        }
        const err = new Error(`Товар «${q}» не найден на сайте`);
        err.status = 404;
        throw err;
    }

    router.get('/resolve-product', async (req, res) => {
        try {
            await ensureSchema();
            const sourceSiteId = await getSourceSiteId();
            const side = String(req.query.side || 'source').toLowerCase();
            const q = String(req.query.q || '').trim();
            if (!q) {
                return res.status(400).json({ success: false, error: 'q обязателен' });
            }
            let siteId = sourceSiteId;
            if (side === 'target') {
                siteId = parseInt(String(req.query.target_site_id || ''), 10);
                if (!Number.isFinite(siteId) || siteId < 1) {
                    return res.status(400).json({ success: false, error: 'target_site_id обязателен для side=target' });
                }
            }
            const product = await resolveSiteProduct(siteId, { query: q });
            res.json({
                success: true,
                site_id: siteId,
                side: side === 'target' ? 'target' : 'source',
                product: product
                    ? {
                          id: product.id,
                          source_id: product.source_id,
                          sku: product.sku,
                          name: product.name,
                          price: product.price,
                      }
                    : null,
            });
        } catch (e) {
            const status = e && e.status ? e.status : 500;
            res.status(status).json({
                success: false,
                error: e.message || 'resolve error',
                candidates: Array.isArray(e.candidates)
                    ? e.candidates.map((r) => ({
                          id: r.id,
                          source_id: r.source_id,
                          sku: r.sku,
                          name: r.name,
                          price: r.price,
                      }))
                    : undefined,
            });
        }
    });

    router.post('/link', async (req, res) => {
        try {
            await ensureSchema();
            const sourceSiteId = await getSourceSiteId();
            const targetSiteId = parseInt(String(req.body.target_site_id || ''), 10);
            if (!Number.isFinite(targetSiteId) || targetSiteId < 1) {
                return res.status(400).json({ success: false, error: 'target_site_id обязателен' });
            }

            let sourceProductId = parseInt(String(req.body.source_product_id || ''), 10);
            let targetProductId = parseInt(String(req.body.target_product_id || ''), 10);
            const sourceQuery = String(req.body.source_query || req.body.source_sku || '').trim();
            const targetQuery = String(req.body.target_query || req.body.target_sku || '').trim();

            if (!Number.isFinite(sourceProductId) || sourceProductId < 1) {
                const src = await resolveSiteProduct(sourceSiteId, {
                    product_id: req.body.source_product_id,
                    query: sourceQuery,
                });
                if (!src) {
                    return res.status(400).json({
                        success: false,
                        error: 'Укажите source_product_id или source_query (артикул/код/ID эталона)',
                    });
                }
                sourceProductId = Number(src.id);
            } else {
                await resolveSiteProduct(sourceSiteId, { product_id: sourceProductId });
            }

            if (!Number.isFinite(targetProductId) || targetProductId < 1) {
                const tgt = await resolveSiteProduct(targetSiteId, {
                    product_id: req.body.target_product_id,
                    query: targetQuery,
                });
                if (!tgt) {
                    return res.status(400).json({
                        success: false,
                        error: 'Укажите target_product_id или target_query (артикул/код/ID цели)',
                    });
                }
                targetProductId = Number(tgt.id);
            } else {
                await resolveSiteProduct(targetSiteId, { product_id: targetProductId });
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
            const actor = resolveActorName(req);
            await writeActionLog({
                actor,
                action: 'link',
                target_site_id: targetSiteId,
                source_product_id: sourceProductId,
                target_product_id: targetProductId,
                target_sku: targetQuery || sourceQuery || null,
                message: `Связь: эталон #${sourceProductId} ↔ цель #${targetProductId}`,
                detail: {
                    source_query: sourceQuery || null,
                    target_query: targetQuery || null,
                },
            });
            res.json({
                success: true,
                source_product_id: sourceProductId,
                target_product_id: targetProductId,
            });
        } catch (e) {
            const status = e && e.status ? e.status : 500;
            res.status(status).json({
                success: false,
                error: e.message || 'link error',
                candidates: e.candidates || undefined,
            });
        }
    });

    router.post('/content-task', async (req, res) => {
        try {
            await ensureSchema();
            const targetSiteId = parseInt(String(req.body.target_site_id || ''), 10);
            const targetProductId = parseInt(String(req.body.target_product_id || ''), 10);
            if (!Number.isFinite(targetSiteId) || targetSiteId < 1) {
                return res.status(400).json({ success: false, error: 'target_site_id обязателен' });
            }
            if (!Number.isFinite(targetProductId) || targetProductId < 1) {
                return res.status(400).json({ success: false, error: 'target_product_id обязателен' });
            }
            const [[prod]] = await db.query(
                `SELECT id FROM my_products WHERE id = ? AND site_id = ? LIMIT 1`,
                [targetProductId, targetSiteId]
            );
            if (!prod) {
                return res.status(404).json({ success: false, error: 'Товар цели не найден' });
            }

            let next = emptyContentTasks();
            if (Array.isArray(req.body.selected)) {
                const selected = new Set(
                    req.body.selected.map((x) => String(x || '').trim()).filter(Boolean)
                );
                CONTENT_TASK_FIELDS.forEach((f) => {
                    next[f] = selected.has(f) ? 'need' : '';
                });
            } else {
                const field = String(req.body.field || '').trim();
                const value = String(req.body.value == null ? '' : req.body.value).trim();
                if (!CONTENT_TASK_FIELDS.includes(field)) {
                    return res.status(400).json({ success: false, error: 'Неизвестное поле задачи' });
                }
                if (!CONTENT_TASK_STATUSES.has(value)) {
                    return res.status(400).json({ success: false, error: 'Недопустимый статус' });
                }
                const [[cur]] = await db.query(
                    `SELECT add_photo, add_parent, add_satellite, delete_product
                     FROM network_content_tasks
                     WHERE target_site_id = ? AND target_product_id = ?
                     LIMIT 1`,
                    [targetSiteId, targetProductId]
                );
                next = {
                    add_photo: (cur && cur.add_photo) || '',
                    add_parent: (cur && cur.add_parent) || '',
                    add_satellite: (cur && cur.add_satellite) || '',
                    delete_product: (cur && cur.delete_product) || '',
                };
                next[field] = value;
            }

            await db.query(
                `INSERT INTO network_content_tasks
                 (target_site_id, target_product_id, add_photo, add_parent, add_satellite, delete_product)
                 VALUES (?, ?, ?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE
                   add_photo = VALUES(add_photo),
                   add_parent = VALUES(add_parent),
                   add_satellite = VALUES(add_satellite),
                   delete_product = VALUES(delete_product),
                   updated_at = CURRENT_TIMESTAMP`,
                [
                    targetSiteId,
                    targetProductId,
                    next.add_photo,
                    next.add_parent,
                    next.add_satellite,
                    next.delete_product,
                ]
            );
            const selected = CONTENT_TASK_FIELDS.filter((f) => next[f]);
            const [[skuRow]] = await db.query(
                `SELECT sku, name FROM my_products WHERE id = ? AND site_id = ? LIMIT 1`,
                [targetProductId, targetSiteId]
            );
            await writeActionLog({
                actor: resolveActorName(req),
                action: 'content_task',
                target_site_id: targetSiteId,
                target_product_id: targetProductId,
                target_sku: skuRow && skuRow.sku ? skuRow.sku : null,
                message:
                    selected.length === 0
                        ? `Задачи контенту сняты: #${targetProductId}`
                        : `Задачи контенту: #${targetProductId} · ${(skuRow && skuRow.sku) || '—'} · ${selected.join(', ')}`,
                detail: { content: next, selected },
            });
            res.json({
                success: true,
                target_site_id: targetSiteId,
                target_product_id: targetProductId,
                content: next,
                selected,
            });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message || 'content-task error' });
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
            const actor = resolveActorName(req);
            await writeActionLog({
                actor,
                action: 'unlink',
                target_site_id: targetSiteId,
                source_product_id: sourceProductId,
                target_product_id: Number.isFinite(targetProductId) ? targetProductId : null,
                message: `Разрыв связи: эталон #${sourceProductId} ↔ цель #${
                    Number.isFinite(targetProductId) ? targetProductId : '—'
                }`,
            });
            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message || 'unlink error' });
        }
    });

    router.post('/deactivate', async (req, res) => {
        let conn = null;
        try {
            await ensureSchema();
            const targetSiteId = parseInt(String(req.body.target_site_id || ''), 10);
            const targetProductId = parseInt(String(req.body.target_product_id || ''), 10);
            const confirm =
                req.body.confirm === true || req.body.confirm === 1 || req.body.confirm === '1';
            if (!Number.isFinite(targetSiteId) || targetSiteId < 1) {
                return res.status(400).json({ success: false, error: 'target_site_id обязателен' });
            }
            if (!Number.isFinite(targetProductId) || targetProductId < 1) {
                return res.status(400).json({ success: false, error: 'target_product_id обязателен' });
            }
            if (!confirm) {
                return res.status(400).json({ success: false, error: 'Нужно confirm:true' });
            }

            const [[prod]] = await db.query(
                `SELECT id, site_id, source_id, cms_product_id, sku, name, source_enabled, is_active
                 FROM my_products WHERE id = ? AND site_id = ? LIMIT 1`,
                [targetProductId, targetSiteId]
            );
            if (!prod) {
                return res.status(404).json({ success: false, error: 'Товар цели не найден в Datagon' });
            }

            const [sites] = await db.query('SELECT * FROM my_sites WHERE id = ?', [targetSiteId]);
            if (!sites.length) {
                return res.status(404).json({ success: false, error: 'Целевой сайт не найден' });
            }
            const site = sites[0];
            conn = await openSiteConnection(site);
            const cmsResult = await deactivateProductInCms(conn, site, {
                source_id: prod.source_id,
                cms_product_id: prod.cms_product_id,
                sku: prod.sku,
            });
            await conn.end();
            conn = null;

            await db.query(
                `UPDATE my_products
                 SET source_enabled = 0,
                     network_sync_at = NOW(),
                     network_sync_note = ?,
                     updated_at = NOW()
                 WHERE id = ? AND site_id = ?`,
                [
                    `deactivate;by=${resolveActorName(req)};cms=${cmsResult.cms}`,
                    targetProductId,
                    targetSiteId,
                ]
            );

            // Снять ручные связи этой цели, чтобы не висела «живая» пара на выключенном товаре
            await db.query(
                `DELETE FROM network_product_links
                 WHERE target_site_id = ? AND target_product_id = ?`,
                [targetSiteId, targetProductId]
            );

            const actor = resolveActorName(req);
            const msg = `Деактивирован на сателлите: #${targetProductId} · ${prod.sku || '—'} · ${String(
                prod.name || ''
            ).slice(0, 80)}`;
            await writeActionLog({
                actor,
                action: 'deactivate',
                target_site_id: targetSiteId,
                target_product_id: targetProductId,
                target_sku: prod.sku || null,
                message: msg,
                detail: cmsResult,
            });

            res.json({
                success: true,
                target_site_id: targetSiteId,
                target_product_id: targetProductId,
                sku: prod.sku,
                cms: cmsResult,
                message: msg,
            });
        } catch (e) {
            if (conn) {
                try {
                    await conn.end();
                } catch (_) {}
            }
            const status = e && e.status ? e.status : e && e.code === 'CMS_SKU_NOT_FOUND' ? 404 : 500;
            res.status(status).json({ success: false, error: e.message || 'deactivate error' });
        }
    });

    router.post('/activate', async (req, res) => {
        let conn = null;
        try {
            await ensureSchema();
            const targetSiteId = parseInt(String(req.body.target_site_id || ''), 10);
            const targetProductId = parseInt(String(req.body.target_product_id || ''), 10);
            const confirm =
                req.body.confirm === true || req.body.confirm === 1 || req.body.confirm === '1';
            if (!Number.isFinite(targetSiteId) || targetSiteId < 1) {
                return res.status(400).json({ success: false, error: 'target_site_id обязателен' });
            }
            if (!Number.isFinite(targetProductId) || targetProductId < 1) {
                return res.status(400).json({ success: false, error: 'target_product_id обязателен' });
            }
            if (!confirm) {
                return res.status(400).json({ success: false, error: 'Нужно confirm:true' });
            }

            const [[prod]] = await db.query(
                `SELECT id, site_id, source_id, cms_product_id, sku, name, source_enabled, is_active
                 FROM my_products WHERE id = ? AND site_id = ? LIMIT 1`,
                [targetProductId, targetSiteId]
            );
            if (!prod) {
                return res.status(404).json({ success: false, error: 'Товар цели не найден в Datagon' });
            }

            const [sites] = await db.query('SELECT * FROM my_sites WHERE id = ?', [targetSiteId]);
            if (!sites.length) {
                return res.status(404).json({ success: false, error: 'Целевой сайт не найден' });
            }
            const site = sites[0];
            conn = await openSiteConnection(site);
            const cmsResult = await activateProductInCms(conn, site, {
                source_id: prod.source_id,
                cms_product_id: prod.cms_product_id,
                sku: prod.sku,
            });
            await conn.end();
            conn = null;

            await db.query(
                `UPDATE my_products
                 SET source_enabled = 1,
                     network_sync_at = NOW(),
                     network_sync_note = ?,
                     updated_at = NOW()
                 WHERE id = ? AND site_id = ?`,
                [
                    `activate;by=${resolveActorName(req)};cms=${cmsResult.cms}`,
                    targetProductId,
                    targetSiteId,
                ]
            );

            const actor = resolveActorName(req);
            const msg = `Включён на сателлите: #${targetProductId} · ${prod.sku || '—'} · ${String(
                prod.name || ''
            ).slice(0, 80)}`;
            await writeActionLog({
                actor,
                action: 'activate',
                target_site_id: targetSiteId,
                target_product_id: targetProductId,
                target_sku: prod.sku || null,
                message: msg,
                detail: cmsResult,
            });

            res.json({
                success: true,
                target_site_id: targetSiteId,
                target_product_id: targetProductId,
                sku: prod.sku,
                cms: cmsResult,
                message: msg,
            });
        } catch (e) {
            if (conn) {
                try {
                    await conn.end();
                } catch (_) {}
            }
            const status = e && e.status ? e.status : e && e.code === 'CMS_SKU_NOT_FOUND' ? 404 : 500;
            res.status(status).json({ success: false, error: e.message || 'activate error' });
        }
    });

    router.get('/action-log', async (req, res) => {
        try {
            await ensureSchema();
            const limit = Math.min(200, Math.max(1, parseInt(String(req.query.limit || '50'), 10) || 50));
            const targetSiteId = parseInt(String(req.query.target_site_id || ''), 10);
            const targetProductId = parseInt(String(req.query.target_product_id || ''), 10);
            const sourceProductId = parseInt(String(req.query.source_product_id || ''), 10);
            const actionFilter = String(req.query.action || '').trim().slice(0, 40);
            const params = [];
            let where = 'WHERE 1=1';
            if (Number.isFinite(targetSiteId) && targetSiteId > 0) {
                where += ' AND target_site_id = ?';
                params.push(targetSiteId);
            }
            if (Number.isFinite(targetProductId) && targetProductId > 0) {
                where += ' AND target_product_id = ?';
                params.push(targetProductId);
            }
            if (Number.isFinite(sourceProductId) && sourceProductId > 0) {
                where += ' AND source_product_id = ?';
                params.push(sourceProductId);
            }
            if (actionFilter) {
                where += ' AND action = ?';
                params.push(actionFilter);
            }
            params.push(limit);
            const [rows] = await db.query(
                `SELECT id, created_at, actor, action, target_site_id, source_product_id,
                        target_product_id, target_sku, message, detail_json
                 FROM network_prices_action_log
                 ${where}
                 ORDER BY id DESC
                 LIMIT ?`,
                params
            );
            res.json({ success: true, data: rows || [] });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message || 'action-log error' });
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
        conn = await openSiteConnection(site);
        let liveMap = new Map();
        try {
            liveMap = await fetchLiveCmsPrices(conn, site, pairs);
        } catch (e) {
            console.error('[network-prices] apply live prices:', e.message || e);
        }
        if (dryRun) {
            try {
                await conn.end();
            } catch (_) {}
            conn = null;
        }

        const result = {
            success: true,
            dry_run: dryRun,
            scanned: 0,
            written: 0,
            would_update: 0,
            skipped_unchanged: 0,
            skipped_no_source_price: 0,
            skipped_price_crash: 0,
            cms_failed: 0,
            errors: [],
            duration_sec: null,
            target_site_id: targetSiteId,
            price_pct: pricePct,
        };

        try {
            const fx = await getFxRates();
            for (const pair of pairs) {
                if (applyJob.cancelRequested) break;
                result.scanned += 1;
                const prop = computeProposed(
                    pair.source_price,
                    pair.source_currency || 'RUB',
                    pricePct,
                    fx
                );
                const live =
                    liveMap.get(`sku:${normalizeSku(pair.target_sku)}`) ||
                    liveMap.get(`xml:${String(pair.target_code || '').trim()}`);
                const tgtRub = live
                    ? toRub(live.price, live.currency || 'RUB', fx)
                    : toRub(pair.target_price, pair.target_currency || 'RUB', fx);
                const guard = await applyNetworkPriceGuard(db, {
                    pair,
                    sourceOk: !!prop.ok,
                    finalPrice: prop.ok ? prop.finalPrice : 0,
                    targetRub: tgtRub,
                    errors: result.errors,
                    counters: result,
                    dryRun,
                });
                if (!guard.allow) {
                    continue;
                }
                if (pricesEqual(tgtRub, prop.finalPrice)) {
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
                    await applyPriceToCms(conn, site, product, prop.finalPrice, {
                        deferStorefrontCacheClear: true,
                    });
                    // eslint-disable-next-line no-await-in-loop
                    await db.query(
                        `UPDATE my_products
                         SET price = ?, currency = 'RUB', network_sync_at = NOW(), network_sync_note = ?, updated_at = NOW()
                         WHERE id = ?`,
                        [
                            prop.finalPrice,
                            `network;from_site=${sourceSiteId};pct=${pricePct};fx=${prop.fx_applied ? '1' : '0'};by=${actor}`,
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

        if (!dryRun && result.written > 0 && String(site.cms_type || '').toLowerCase() === 'bitrix') {
            try {
                const cacheClear = await clearBitrixStorefrontCache(site);
                result.cache_clear = cacheClear;
                if (!cacheClear || cacheClear.ok !== true) {
                    result.cms_failed += 1;
                    if (result.errors.length < 20) {
                        result.errors.push({
                            code: `site:${targetSiteId}`,
                            error: `cache_clear: ${cacheClear && (cacheClear.error || cacheClear.body || cacheClear.status) || 'fail'}`,
                        });
                    }
                    result.message =
                        `Записано ✓ ${result.written}, но кэш витрины Bitrix НЕ сброшен — на сайте может висеть старая цена`;
                }
            } catch (e) {
                result.cache_clear = { ok: false, error: e.message || String(e) };
                result.cms_failed += 1;
                result.message =
                    `Записано ✓ ${result.written}, но кэш витрины Bitrix НЕ сброшен: ${e.message || e}`;
            }
        }

        result.duration_sec = Math.round(((Date.now() - started) / 1000) * 100) / 100;
        if (!result.message) {
            result.message = dryRun
                ? `Пробный прогон: к записи ${result.would_update}, без изменений ${result.skipped_unchanged}, без цены эталона ${result.skipped_no_source_price}`
                : `Записано ✓ ${result.written}, без изменений ${result.skipped_unchanged}, без цены эталона ${result.skipped_no_source_price}, ошибок CMS × ${result.cms_failed}`;
        }
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
                skipped_price_crash: 0,
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
            applyJob.skipped_price_crash = result.skipped_price_crash || 0;
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
    const { getFxRates: getFx, toRub: priceToRub } = require('../lib/datagonFxRates');
    const fx = await getFx();
    const PRICE_EPS_SYNC = 0.005;

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
    let skipped_no_source_price = 0;
    let failed = 0;
    const errors = [];
    const counters = {
        skipped_no_source_price: 0,
    };

    for (const cfg of cfgRows) {
        const targetSiteId = Number(cfg.target_site_id);
        const pricePct = Number(cfg.price_pct);
        const [sites] = await db.query('SELECT * FROM my_sites WHERE id = ?', [targetSiteId]);
        if (!sites.length) continue;
        const site = sites[0];
        const [pairs] = await db.query(
            `
            SELECT * FROM (
                SELECT
                    s.price AS source_price, s.currency AS source_currency,
                    t.id AS target_product_id, t.source_id AS target_code, t.sku AS target_sku,
                    t.price AS target_price, t.currency AS target_currency
                FROM network_product_links ml
                INNER JOIN my_products s ON s.id = ml.source_product_id AND s.is_active = 1
                INNER JOIN my_products t ON t.id = ml.target_product_id AND t.is_active = 1
                WHERE ml.source_site_id = ? AND ml.target_site_id = ?

                UNION

                SELECT
                    s.price AS source_price, s.currency AS source_currency,
                    t.id AS target_product_id, t.source_id AS target_code, t.sku AS target_sku,
                    t.price AS target_price, t.currency AS target_currency
                FROM my_products t
                INNER JOIN my_products s
                    ON s.site_id = ?
                   AND s.is_active = 1
                   AND s.sku <> ''
                   AND s.sku = t.sku
                WHERE t.site_id = ?
                  AND t.is_active = 1
                  AND t.sku <> ''
                  AND COALESCE(t.source_enabled, 1) = 1
                  AND NOT EXISTS (
                      SELECT 1 FROM network_product_link_ignore ig
                      WHERE ig.source_site_id = ? AND ig.source_product_id = s.id AND ig.target_site_id = ?
                  )
                  AND NOT EXISTS (
                      SELECT 1 FROM network_product_links ml3
                      WHERE ml3.source_site_id = ? AND ml3.source_product_id = s.id AND ml3.target_site_id = ?
                  )
            ) pairs
            `,
            [
                sourceSiteId,
                targetSiteId,
                sourceSiteId,
                targetSiteId,
                sourceSiteId,
                targetSiteId,
                sourceSiteId,
                targetSiteId,
            ]
        );

        let conn = null;
        let siteWritten = 0;
        try {
            conn = await openConn(site);
            let liveMap = new Map();
            try {
                liveMap = await fetchLiveCmsPrices(conn, site, pairs || []);
            } catch (e) {
                console.error('[network-prices] autosync live prices:', e.message || e);
            }
            for (const pair of pairs || []) {
                scanned += 1;
                const srcCur = String(pair.source_currency || 'RUB').trim().toUpperCase();
                const baseRub = priceToRub(pair.source_price, srcCur, fx);
                const sourceOk = Number.isFinite(baseRub) && baseRub >= 0;
                const finalPrice = sourceOk ? roundPx(baseRub * (1 + pricePct / 100), 'RUB') : NaN;
                const live =
                    liveMap.get(`sku:${String(pair.target_sku || '').trim()}`) ||
                    liveMap.get(`xml:${String(pair.target_code || '').trim()}`);
                const tgtRub = live
                    ? priceToRub(live.price, live.currency || 'RUB', fx)
                    : priceToRub(pair.target_price, pair.target_currency || 'RUB', fx);
                const guard = await applyNetworkPriceGuard(db, {
                    pair,
                    sourceOk,
                    finalPrice,
                    targetRub: tgtRub,
                    errors,
                    counters,
                    dryRun: false,
                });
                if (!guard.allow) {
                    continue;
                }
                if (
                    Number.isFinite(tgtRub) &&
                    Math.abs(Number(tgtRub) - finalPrice) < PRICE_EPS_SYNC
                ) {
                    skipped += 1;
                    continue;
                }
                try {
                    // eslint-disable-next-line no-await-in-loop
                    await applyCms(
                        conn,
                        site,
                        { source_id: pair.target_code, sku: pair.target_sku },
                        finalPrice,
                        { deferStorefrontCacheClear: true }
                    );
                    // eslint-disable-next-line no-await-in-loop
                    await db.query(
                        `UPDATE my_products
                         SET price = ?, currency = 'RUB', network_sync_at = NOW(), network_sync_note = ?, updated_at = NOW()
                         WHERE id = ?`,
                        [
                            finalPrice,
                            `network;auto;pct=${pricePct};fx=${srcCur !== 'RUB' && srcCur !== 'RUR' ? '1' : '0'}`,
                            pair.target_product_id,
                        ]
                    );
                    written += 1;
                    siteWritten += 1;
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
        /* Иначе витрина Bitrix продолжает отдавать старый HTML из bitrix/cache (как 273 608 при PRICE=421417). */
        if (siteWritten > 0 && String(site.cms_type || '').toLowerCase() === 'bitrix') {
            try {
                if (onProgress) {
                    onProgress({
                        scanned,
                        written,
                        skipped,
                        failed,
                        message: `Цены сети: сброс кэша витрины (сайт ${targetSiteId})…`,
                    });
                }
                // eslint-disable-next-line no-await-in-loop
                const cacheClear = await clearBitrixStorefrontCache(site);
                if (cacheClear && cacheClear.ok === false) {
                    failed += 1;
                    if (errors.length < 20) {
                        errors.push({
                            code: `site:${targetSiteId}`,
                            error: `cache_clear: ${cacheClear.error || cacheClear.body || cacheClear.status || 'fail'}`,
                        });
                    }
                }
            } catch (e) {
                failed += 1;
                if (errors.length < 20) {
                    errors.push({
                        code: `site:${targetSiteId}`,
                        error: `cache_clear: ${e.message || e}`,
                    });
                }
            }
        }
    }

    skipped_no_source_price = counters.skipped_no_source_price;
    const cacheFail = (errors || []).some((e) => String(e.error || '').startsWith('cache_clear'));
    const noSrc = skipped_no_source_price ? `, без цены эталона ${skipped_no_source_price}` : '';
    return {
        success: (failed === 0 || written > 0) && !cacheFail,
        scanned,
        written,
        skipped,
        skipped_no_source_price,
        failed,
        errors,
        message: cacheFail
            ? `Цены сети: записано ✓ ${written}, но кэш витрины Bitrix НЕ сброшен (ошибок × ${failed})`
            : `Цены сети: записано ✓ ${written}, без изменений ${skipped}${noSrc}, ошибок × ${failed}`,
    };
};

module.exports = networkPricesRouterFactory;
