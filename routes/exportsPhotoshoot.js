'use strict';

/**
 * Маркетплейсы → Отснять товары.
 * Источник строк — dg_new_products (channel=marketplaces), статусы съёмки — photoshoot_*.
 * Остаток — ms_export.stock; «Нет в наличии» авто для not_shot/out_of_stock.
 */

const express = require('express');

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

const STATUS_LABELS = {
    not_shot: 'Не отснят',
    out_of_stock: 'Нет в наличии',
    in_package: 'товар в упаковке',
    shot: 'Отснят',
    boxed: 'Собран в коробку',
};
const STATUS_SET = new Set(Object.keys(STATUS_LABELS));
const AUTO_STOCK_STATUSES = new Set(['not_shot', 'out_of_stock']);
const MANUAL_LOCK_STATUSES = new Set(['in_package', 'shot', 'boxed']);

const FIELD_LOG_LABELS = {
    photoshoot_status: 'Статус съёмки',
    photoshoot_comment: 'Комментарий съёмки',
    photoshoot_at: 'Дата съёмки',
};

const SORT_KEYS = new Set([
    'id',
    'product_code',
    'article',
    'title',
    'photoshoot_at',
    'photoshoot_status',
    'stock',
]);

let schemaReady = false;

async function ensureColumn(db, table, name, def) {
    const [cols] = await db.query(`SHOW COLUMNS FROM \`${table}\` LIKE ?`, [name]);
    if (cols && cols.length) return;
    await db.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${name}\` ${def}`);
}

async function ensureSchema(db) {
    if (schemaReady) return;
    await ensureColumn(db, 'dg_new_products', 'photoshoot_status', "VARCHAR(32) NOT NULL DEFAULT 'not_shot'");
    await ensureColumn(db, 'dg_new_products', 'photoshoot_at', 'DATETIME NULL');
    await ensureColumn(db, 'dg_new_products', 'photoshoot_comment', 'TEXT NULL');
    try {
        await db.query(
            `CREATE INDEX idx_dg_np_photoshoot ON dg_new_products (channel, photoshoot_status)`
        );
    } catch (_) {
        /* index may exist */
    }
    schemaReady = true;
}

function clip(s, max) {
    const t = String(s == null ? '' : s).trim();
    if (!max || t.length <= max) return t;
    return t.slice(0, max);
}

function clipLogVal(v) {
    if (v == null || v === '') return null;
    const s = String(v);
    return s.length > 512 ? s.slice(0, 509) + '…' : s;
}

function actorDisplayName(actor) {
    if (!actor) return '';
    const name = String(actor.full_name || actor.username || '').trim();
    if (name) return name;
    if (actor.id != null && Number.isFinite(Number(actor.id))) return 'user#' + Number(actor.id);
    return '';
}

function normStatus(v) {
    const s = String(v || '').trim().toLowerCase();
    return STATUS_SET.has(s) ? s : null;
}

function stockNum(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
}

function desiredAutoStatus(current, stock) {
    const st = String(current || 'not_shot');
    if (MANUAL_LOCK_STATUSES.has(st)) return st;
    if (!AUTO_STOCK_STATUSES.has(st)) return st;
    if (stock <= 0) return 'out_of_stock';
    return 'not_shot';
}

async function insertLog(db, { productId, field, oldValue, newValue, actor, source }) {
    await db.query(
        `INSERT INTO dg_new_products_log
            (product_id, channel, kit_id, field, old_value, new_value, action, source,
             changed_by_user_id, changed_by_name, note)
         VALUES (?, 'marketplaces', NULL, ?, ?, ?, 'set', ?, ?, ?, NULL)`,
        [
            productId,
            String(field).slice(0, 64),
            clipLogVal(oldValue),
            clipLogVal(newValue),
            String(source || 'ui').slice(0, 32),
            actor && actor.id != null && Number.isFinite(Number(actor.id)) ? Number(actor.id) : null,
            actorDisplayName(actor) || null,
        ]
    );
}

/** LEFT JOIN ms_export: uuid, иначе code = product_code. */
function stockJoinSql() {
    return `LEFT JOIN ms_export mse ON (
        (np.ms_product_uuid IS NOT NULL AND TRIM(np.ms_product_uuid) <> '' AND mse.uuid = np.ms_product_uuid)
        OR (
            TRIM(COALESCE(np.product_code, '')) <> ''
            AND mse.code = np.product_code
            AND (np.ms_product_uuid IS NULL OR TRIM(np.ms_product_uuid) = '')
        )
    )`;
}

async function attachAlmamedAndMarketsMeta(db, rows) {
    const list = rows || [];
    if (!list.length) return list;

    const sourceIds = [
        ...new Set(
            list
                .map((r) => Number(r.source_almamed_id))
                .filter((id) => Number.isFinite(id) && id > 0)
        ),
    ];
    const almById = Object.create(null);
    if (sourceIds.length) {
        try {
            const [srcs] = await db.query(
                `SELECT id, article, title, almamed_url FROM dg_new_products
                  WHERE channel = 'almamed' AND id IN (?)`,
                [sourceIds]
            );
            (srcs || []).forEach((s) => {
                almById[Number(s.id)] = {
                    article: String(s.article || '').trim(),
                    title: String(s.title || '').trim(),
                    almamed_url: String(s.almamed_url || '').trim(),
                };
            });
        } catch (_) {
            /* ignore */
        }
    }

    const keys = [];
    const keySet = new Set();
    list.forEach((r) => {
        [r.product_code, r.article].forEach((raw) => {
            const k = String(raw || '').trim();
            if (!k || keySet.has(k)) return;
            keySet.add(k);
            keys.push(k);
        });
    });

    const mpByKey = Object.create(null);
    if (keys.length) {
        try {
            const [mpRows] = await db.query(
                `SELECT external_id, marketplace, name, offer_id, vendor_code, shop_sku
                   FROM marketplace_export_rows
                  WHERE external_id IN (?)
                    AND marketplace IN ('ozon', 'wildberries', 'yandex_market')`,
                [keys]
            );
            (mpRows || []).forEach((row) => {
                const id = String(row.external_id || '').trim();
                if (!id) return;
                if (!mpByKey[id]) {
                    mpByKey[id] = { codes: [], names: [] };
                }
                const code =
                    String(row.offer_id || '').trim() ||
                    String(row.vendor_code || '').trim() ||
                    String(row.shop_sku || '').trim() ||
                    id;
                const name = String(row.name || '').trim();
                if (code && !mpByKey[id].codes.includes(code)) mpByKey[id].codes.push(code);
                if (name && !mpByKey[id].names.includes(name)) mpByKey[id].names.push(name);
            });
        } catch (_) {
            /* ignore */
        }
    }

    list.forEach((r) => {
        const alm = r.source_almamed_id ? almById[Number(r.source_almamed_id)] : null;
        r.almamed_article = alm ? alm.article : '';
        r.almamed_title = alm ? alm.title : '';
        if (alm && alm.almamed_url && !r.almamed_url) r.almamed_url = alm.almamed_url;

        const code = String(r.product_code || '').trim();
        const art = String(r.article || '').trim();
        const hit = (code && mpByKey[code]) || (art && mpByKey[art]) || null;
        r.markets_codes = hit ? hit.codes.join(', ') : '';
        r.markets_title = hit && hit.names.length ? hit.names[0] : '';
    });

    return list;
}

function mapRow(r) {
    const st = String(r.photoshoot_status || 'not_shot');
    return {
        id: Number(r.id),
        channel_num: r.channel_num != null ? Number(r.channel_num) : null,
        product_code: r.product_code || '',
        article: r.article || '',
        title: r.title || '',
        photoshoot_status: STATUS_SET.has(st) ? st : 'not_shot',
        photoshoot_status_label: STATUS_LABELS[STATUS_SET.has(st) ? st : 'not_shot'],
        photoshoot_at: r.photoshoot_at || null,
        photoshoot_comment: r.photoshoot_comment || '',
        stock: stockNum(r.stock),
        source_almamed_id: r.source_almamed_id != null ? Number(r.source_almamed_id) : null,
        almamed_article: r.almamed_article || '',
        almamed_title: r.almamed_title || '',
        markets_codes: r.markets_codes || '',
        markets_title: r.markets_title || '',
        ms_product_uuid: r.ms_product_uuid || '',
        updated_at: r.updated_at || null,
    };
}

async function applyAutoStockStatuses(db, rows) {
    const list = rows || [];
    const updates = [];
    for (const r of list) {
        const cur = String(r.photoshoot_status || 'not_shot');
        const stock = stockNum(r.stock);
        const next = desiredAutoStatus(cur, stock);
        if (next !== cur) {
            updates.push({ id: Number(r.id), from: cur, to: next });
            r.photoshoot_status = next;
        }
    }
    if (!updates.length) return;
    for (const u of updates) {
        await db.query(
            `UPDATE dg_new_products SET photoshoot_status = ? WHERE id = ? AND channel = 'marketplaces'`,
            [u.to, u.id]
        );
        try {
            await insertLog(db, {
                productId: u.id,
                field: 'photoshoot_status',
                oldValue: STATUS_LABELS[u.from] || u.from,
                newValue: STATUS_LABELS[u.to] || u.to,
                actor: null,
                source: 'auto_stock',
            });
        } catch (_) {
            /* log table may lag */
        }
    }
}

module.exports = function exportsPhotoshootRouterFactory(db) {
    const router = express.Router();

    router.get('/meta', async (_req, res) => {
        try {
            await ensureSchema(db);
            res.json({
                success: true,
                statuses: Object.keys(STATUS_LABELS).map((k) => ({ key: k, label: STATUS_LABELS[k] })),
            });
        } catch (e) {
            res.status(500).json({ error: e.message || 'Ошибка meta' });
        }
    });

    router.get('/', async (req, res) => {
        try {
            await ensureSchema(db);
            const q = req.query || {};
            const search = String(q.search || '').trim();
            const statusFilter = normStatus(q.photoshoot_status);
            const hasStockRaw = q.has_stock != null ? String(q.has_stock).trim().toLowerCase() : '1';
            const hasStock =
                hasStockRaw === 'all' || hasStockRaw === ''
                    ? null
                    : hasStockRaw === '1' || hasStockRaw === 'true' || hasStockRaw === 'yes'
                      ? 1
                      : hasStockRaw === '0' || hasStockRaw === 'false' || hasStockRaw === 'no'
                        ? 0
                        : 1;
            let limit = parseInt(q.limit, 10);
            if (!Number.isFinite(limit) || limit < 1) limit = DEFAULT_LIMIT;
            limit = Math.min(MAX_LIMIT, limit);
            let offset = parseInt(q.offset, 10);
            if (!Number.isFinite(offset) || offset < 0) offset = 0;
            let sortBy = String(q.sort_by || 'stock').trim();
            if (!SORT_KEYS.has(sortBy)) sortBy = 'stock';
            const sortDesc = String(q.sort_dir || 'desc').toLowerCase() === 'desc';

            const where = [`np.channel = 'marketplaces'`, `np.status <> 'removed'`];
            const params = [];

            if (statusFilter) {
                where.push('np.photoshoot_status = ?');
                params.push(statusFilter);
            }
            if (hasStock === 1) {
                where.push('COALESCE(mse.stock, 0) > 0');
            } else if (hasStock === 0) {
                where.push('COALESCE(mse.stock, 0) <= 0');
            }
            if (search) {
                const like = `%${search}%`;
                where.push(
                    `(np.title LIKE ? OR np.article LIKE ? OR COALESCE(np.product_code,'') LIKE ?
                      OR COALESCE(np.photoshoot_comment,'') LIKE ?
                      OR CAST(COALESCE(np.channel_num, np.id) AS CHAR) LIKE ?)`
                );
                params.push(like, like, like, like, like);
            }

            const whereSql = where.join(' AND ');
            let orderSql;
            if (sortBy === 'stock') {
                orderSql = `COALESCE(mse.stock, 0) ${sortDesc ? 'DESC' : 'ASC'}, COALESCE(np.channel_num, np.id) ASC`;
            } else if (sortBy === 'id') {
                orderSql = `COALESCE(np.channel_num, np.id) ${sortDesc ? 'DESC' : 'ASC'}, np.id ASC`;
            } else if (sortBy === 'photoshoot_status') {
                orderSql = `np.photoshoot_status ${sortDesc ? 'DESC' : 'ASC'}, COALESCE(np.channel_num, np.id) ASC`;
            } else if (sortBy === 'photoshoot_at') {
                orderSql = `np.photoshoot_at ${sortDesc ? 'DESC' : 'ASC'}, COALESCE(np.channel_num, np.id) ASC`;
            } else {
                orderSql = `np.\`${sortBy}\` ${sortDesc ? 'DESC' : 'ASC'}, COALESCE(np.channel_num, np.id) ASC`;
            }

            const fromSql = `FROM dg_new_products np ${stockJoinSql()}`;

            const [[cnt]] = await db.query(
                `SELECT COUNT(*) AS total ${fromSql} WHERE ${whereSql}`,
                params
            );
            const [rows] = await db.query(
                `SELECT np.id, np.channel_num, np.product_code, np.article, np.title,
                        np.photoshoot_status, np.photoshoot_at, np.photoshoot_comment,
                        np.source_almamed_id, np.ms_product_uuid, np.almamed_url, np.updated_at,
                        COALESCE(mse.stock, 0) AS stock
                   ${fromSql}
                  WHERE ${whereSql}
                  ORDER BY ${orderSql}
                  LIMIT ? OFFSET ?`,
                [...params, limit, offset]
            );

            await applyAutoStockStatuses(db, rows || []);
            await attachAlmamedAndMarketsMeta(db, rows || []);
            const mapped = (rows || []).map(mapRow);

            res.json({
                success: true,
                data: mapped,
                total: Number(cnt?.total || 0),
                limit,
                offset,
                has_stock: hasStock,
                statuses: Object.keys(STATUS_LABELS).map((k) => ({ key: k, label: STATUS_LABELS[k] })),
            });
        } catch (e) {
            console.error('[photoshoot] list', e);
            res.status(500).json({ error: e.message || 'Ошибка списка' });
        }
    });

    router.patch('/:id', async (req, res) => {
        try {
            await ensureSchema(db);
            const id = parseInt(req.params.id, 10);
            if (!Number.isFinite(id) || id < 1) {
                return res.status(400).json({ error: 'Некорректный id' });
            }
            const [[cur]] = await db.query(
                `SELECT id, channel, status, photoshoot_status, photoshoot_at, photoshoot_comment
                   FROM dg_new_products WHERE id = ? LIMIT 1`,
                [id]
            );
            if (!cur || cur.channel !== 'marketplaces') {
                return res.status(404).json({ error: 'Товар не найден' });
            }
            if (String(cur.status) === 'removed') {
                return res.status(400).json({ error: 'Товар удалён из очереди маркетов' });
            }

            const body = req.body || {};
            const fields = {};
            const actor = req.datagonActor;

            if ('photoshoot_status' in body) {
                const st = normStatus(body.photoshoot_status);
                if (!st) return res.status(400).json({ error: 'Некорректный статус съёмки' });
                fields.photoshoot_status = st;
                if (st !== 'out_of_stock') {
                    fields.photoshoot_at = new Date();
                }
            }
            if ('photoshoot_comment' in body) {
                fields.photoshoot_comment =
                    body.photoshoot_comment == null || body.photoshoot_comment === ''
                        ? null
                        : clip(body.photoshoot_comment, 4000) || null;
            }

            if (!Object.keys(fields).length) {
                return res.status(400).json({ error: 'Нет полей для обновления' });
            }

            const cols = Object.keys(fields);
            await db.query(
                `UPDATE dg_new_products SET ${cols.map((c) => `\`${c}\` = ?`).join(', ')} WHERE id = ?`,
                [...cols.map((c) => fields[c]), id]
            );

            for (const key of cols) {
                if (key === 'photoshoot_at') continue;
                const oldRaw = cur[key];
                const newRaw = fields[key];
                if (String(oldRaw ?? '') === String(newRaw ?? '')) continue;
                let oldDisp = oldRaw;
                let newDisp = newRaw;
                if (key === 'photoshoot_status') {
                    oldDisp = STATUS_LABELS[oldRaw] || oldRaw;
                    newDisp = STATUS_LABELS[newRaw] || newRaw;
                }
                await insertLog(db, {
                    productId: id,
                    field: key,
                    oldValue: oldDisp,
                    newValue: newDisp,
                    actor,
                    source: 'ui',
                });
            }

            const [[row]] = await db.query(
                `SELECT np.id, np.channel_num, np.product_code, np.article, np.title,
                        np.photoshoot_status, np.photoshoot_at, np.photoshoot_comment,
                        np.source_almamed_id, np.ms_product_uuid, np.almamed_url, np.updated_at,
                        COALESCE(mse.stock, 0) AS stock
                   FROM dg_new_products np
                   ${stockJoinSql()}
                  WHERE np.id = ?
                  LIMIT 1`,
                [id]
            );
            const list = row ? [row] : [];
            await attachAlmamedAndMarketsMeta(db, list);

            res.json({ success: true, data: list[0] ? mapRow(list[0]) : null });
        } catch (e) {
            console.error('[photoshoot] patch', e);
            res.status(500).json({ error: e.message || 'Ошибка сохранения' });
        }
    });

    router.get('/:id/log', async (req, res) => {
        try {
            await ensureSchema(db);
            const id = parseInt(req.params.id, 10);
            if (!Number.isFinite(id) || id < 1) {
                return res.status(400).json({ success: false, error: 'Некорректный id' });
            }
            const [[cur]] = await db.query(
                `SELECT id, channel, title, article, product_code FROM dg_new_products WHERE id = ? LIMIT 1`,
                [id]
            );
            if (!cur || cur.channel !== 'marketplaces') {
                return res.status(404).json({ success: false, error: 'Товар не найден' });
            }
            const rawLimit = Number(req.query.limit);
            const limit = Math.min(
                500,
                Math.max(1, Number.isFinite(rawLimit) && rawLimit > 0 ? Math.floor(rawLimit) : 100)
            );
            const rawOffset = Number(req.query.offset);
            const offset = Math.max(0, Number.isFinite(rawOffset) && rawOffset >= 0 ? Math.floor(rawOffset) : 0);
            const field = String(req.query.field || '').trim();
            const where = ['product_id = ?'];
            const params = [id];
            if (field) {
                where.push('field = ?');
                params.push(field);
            } else {
                where.push(
                    `field IN ('photoshoot_status', 'photoshoot_comment', 'photoshoot_at')`
                );
            }
            const whereSql = `WHERE ${where.join(' AND ')}`;
            const [[cnt]] = await db.query(
                `SELECT COUNT(*) AS total FROM dg_new_products_log ${whereSql}`,
                params
            );
            const [rows] = await db.query(
                `SELECT id, product_id, channel, kit_id, field, old_value, new_value, action, source,
                        changed_by_user_id, changed_by_name, note, changed_at
                   FROM dg_new_products_log ${whereSql}
                  ORDER BY id DESC
                  LIMIT ? OFFSET ?`,
                [...params, limit, offset]
            );
            const out = (rows || []).map((r) => ({
                id: Number(r.id),
                product_id: Number(r.product_id),
                channel: r.channel || '',
                kit_id: r.kit_id != null ? Number(r.kit_id) : null,
                field: String(r.field || ''),
                field_label: FIELD_LOG_LABELS[r.field] || String(r.field || ''),
                old_value: r.old_value != null ? String(r.old_value) : null,
                new_value: r.new_value != null ? String(r.new_value) : null,
                action: String(r.action || 'set'),
                source: String(r.source || 'ui'),
                changed_by_user_id: r.changed_by_user_id != null ? Number(r.changed_by_user_id) : null,
                changed_by_name: r.changed_by_name != null ? String(r.changed_by_name) : '',
                note: r.note != null ? String(r.note) : '',
                changed_at: r.changed_at ? new Date(r.changed_at).toISOString() : '',
            }));
            res.json({
                success: true,
                product_id: id,
                product: {
                    id: Number(cur.id),
                    title: cur.title || '',
                    article: cur.article || '',
                    product_code: cur.product_code || '',
                    channel: cur.channel || '',
                },
                rows: out,
                total: Number(cnt?.total || 0),
                limit,
                offset,
            });
        } catch (e) {
            console.error('[photoshoot] GET log', e);
            res.status(500).json({ success: false, error: e.message || 'Ошибка чтения журнала' });
        }
    });

    return router;
};
