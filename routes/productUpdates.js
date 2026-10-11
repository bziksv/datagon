'use strict';

/**
 * Очередь «Обновление товаров» (вкладка на /exports-new-products.html).
 * Учёт задач по кодам: Альмамед / маркеты, состав комплектов (черновик), комментарии «+».
 * v1: без автозаписи в МС / маркетплейсы.
 */

const express = require('express');

const PAGE_KEY = 'exports-new-products-updates';
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
const MAX_BULK = 200;
const MAX_COMMENT = 2000;

const STATUS_LABELS = {
    new: 'Новый',
    in_progress: 'В работе',
    done: 'Обновлено',
    cancelled: 'Отменено',
    /** Как «Удалённые» на вкладках Альмамед / Маркеты — скрыты из «Все», видны фильтром. */
    removed: 'Удалённые',
};
const STATUS_SET = new Set(Object.keys(STATUS_LABELS));

const SORT_KEYS = new Set([
    'id',
    'code',
    'name_snapshot',
    'status',
    'is_bundle',
    'created_at',
    'updated_at',
    'assignee_name',
    'content_name',
    'product_manager_name',
]);

/** Галочки «Обновлено» на маркетах. Альмамед — отдельно у «Куда», не в этом списке. */
const DONE_MARKET_CHANNELS = ['ozon', 'wb', 'yandex'];
const DONE_CHANNELS = ['almamed', ...DONE_MARKET_CHANNELS];

let schemaReady = false;

async function ensureColumn(db, table, name, def) {
    const [cols] = await db.query(`SHOW COLUMNS FROM \`${table}\` LIKE ?`, [name]);
    if (cols && cols.length) return;
    await db.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${name}\` ${def}`);
}

function pageMode(req) {
    const actor = req.datagonActor || {};
    if (actor.username === 'admin') return 'full';
    const pm = actor.page_modes || {};
    const raw = pm[PAGE_KEY];
    if (raw === 'view' || raw === 'hidden' || raw === 'full') return raw;
    // back-compat: пока в матрице нет ключа — наследуем «Новые товары»
    const parent = pm['exports-new-products'];
    if (parent === 'view' || parent === 'full') return parent;
    return 'hidden';
}

function canWrite(req) {
    return pageMode(req) === 'full';
}

function canRead(req) {
    const m = pageMode(req);
    return m === 'full' || m === 'view';
}

function actorId(req) {
    const id = req.datagonActor && req.datagonActor.id;
    const n = Number(id);
    return Number.isFinite(n) && n > 0 ? n : null;
}

function actorDisplayName(actor) {
    if (!actor) return '';
    return String(actor.full_name || actor.username || '').trim();
}

function shortPersonName(full) {
    const parts = String(full || '')
        .trim()
        .split(/\s+/)
        .filter(Boolean);
    if (!parts.length) return '';
    if (parts.length === 1) return parts[0];
    const initial = parts[1].charAt(0);
    if (!initial) return parts[0];
    return `${parts[0]} ${initial.toUpperCase()}.`;
}

function formatCommentDate(dt) {
    if (!dt) return '';
    const d = dt instanceof Date ? dt : new Date(dt);
    if (Number.isNaN(d.getTime())) return '';
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    return `${dd}-${mm}-${d.getFullYear()}`;
}

function formatDateTime(dt) {
    if (!dt) return '';
    const d = dt instanceof Date ? dt : new Date(dt);
    if (Number.isNaN(d.getTime())) return '';
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const yyyy = d.getFullYear();
    const hh = String(d.getHours()).padStart(2, '0');
    const mi = String(d.getMinutes()).padStart(2, '0');
    return `${dd}-${mm}-${yyyy} ${hh}:${mi}`;
}

function clip(s, max) {
    const t = String(s == null ? '' : s).trim();
    if (!max || t.length <= max) return t;
    return t.slice(0, max);
}

function normCode(v) {
    return clip(v, 255);
}

function normStatus(v) {
    const s = String(v || '')
        .trim()
        .toLowerCase();
    return STATUS_SET.has(s) ? s : null;
}

function bool01(v, fallback) {
    if (v === true || v === 1 || v === '1' || v === 'true' || v === 'on') return 1;
    if (v === false || v === 0 || v === '0' || v === 'false' || v === 'off') return 0;
    return fallback;
}

function parseJsonArray(raw) {
    if (raw == null || raw === '') return [];
    if (Array.isArray(raw)) return raw;
    try {
        const j = typeof raw === 'string' ? JSON.parse(raw) : raw;
        return Array.isArray(j) ? j : [];
    } catch (_) {
        return [];
    }
}

function normalizeComponents(list) {
    const out = [];
    const seen = new Set();
    (Array.isArray(list) ? list : []).forEach((item) => {
        const code = normCode(item && (item.code || item.component_code));
        if (!code) return;
        const key = code.toLowerCase();
        if (seen.has(key)) return;
        seen.add(key);
        let qty = Number(item && (item.qty != null ? item.qty : item.qty_per_bundle));
        if (!Number.isFinite(qty) || qty <= 0) qty = 1;
        out.push({
            code,
            qty: Math.round(qty * 1000000) / 1000000,
            name: clip(item && (item.name || item.component_name), 512) || null,
        });
    });
    out.sort((a, b) => a.code.localeCompare(b.code, 'ru'));
    return out;
}

function isBundleType(typeStr) {
    const t = String(typeStr || '')
        .trim()
        .toLowerCase();
    return t.includes('комплект') || t.includes('bundle') || t.includes('kit');
}

async function ensureSchema(db) {
    if (schemaReady) return;
    await db.query(`
        CREATE TABLE IF NOT EXISTS dg_product_updates (
            id INT NOT NULL AUTO_INCREMENT,
            code VARCHAR(255) NOT NULL,
            name_snapshot VARCHAR(512) NULL,
            is_bundle TINYINT(1) NOT NULL DEFAULT 0,
            target_almamed TINYINT(1) NOT NULL DEFAULT 0,
            target_markets TINYINT(1) NOT NULL DEFAULT 1,
            status VARCHAR(32) NOT NULL DEFAULT 'new',
            assignee_user_id INT NULL,
            assignee_name VARCHAR(255) NULL,
            target_components_json MEDIUMTEXT NULL,
            current_components_json MEDIUMTEXT NULL,
            created_by_user_id INT NULL,
            created_by_name VARCHAR(255) NULL,
            archived_at DATETIME NULL,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            PRIMARY KEY (id),
            KEY idx_dpu_code (code),
            KEY idx_dpu_status (status, archived_at),
            KEY idx_dpu_created (created_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await db.query(`
        CREATE TABLE IF NOT EXISTS dg_product_update_comments (
            id INT NOT NULL AUTO_INCREMENT,
            row_id INT NOT NULL,
            body TEXT NOT NULL,
            author_user_id INT NOT NULL,
            author_name VARCHAR(255) NULL,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            PRIMARY KEY (id),
            KEY idx_dpuc_row (row_id, id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await ensureColumn(db, 'dg_product_updates', 'content_user_id', 'INT NULL');
    await ensureColumn(db, 'dg_product_updates', 'content_name', 'VARCHAR(255) NULL');
    await ensureColumn(db, 'dg_product_updates', 'product_manager_user_id', 'INT NULL');
    await ensureColumn(db, 'dg_product_updates', 'product_manager_name', 'VARCHAR(255) NULL');
    await ensureColumn(db, 'dg_product_updates', 'ms_bundle_updated', 'TINYINT(1) NOT NULL DEFAULT 0');
    await ensureColumn(db, 'dg_product_updates', 'ms_bundle_updated_at', 'DATETIME NULL');
    await ensureColumn(db, 'dg_product_updates', 'ms_bundle_updated_by_user_id', 'INT NULL');
    await ensureColumn(db, 'dg_product_updates', 'ms_bundle_updated_by_name', 'VARCHAR(255) NULL');
    for (const ch of DONE_CHANNELS) {
        await ensureColumn(db, 'dg_product_updates', `done_${ch}`, 'TINYINT(1) NOT NULL DEFAULT 0');
        await ensureColumn(db, 'dg_product_updates', `done_${ch}_at`, 'DATETIME NULL');
        await ensureColumn(db, 'dg_product_updates', `done_${ch}_by_user_id`, 'INT NULL');
        await ensureColumn(db, 'dg_product_updates', `done_${ch}_by_name`, 'VARCHAR(255) NULL');
    }
    await db.query(`
        CREATE TABLE IF NOT EXISTS dg_product_updates_log (
            id BIGINT AUTO_INCREMENT PRIMARY KEY,
            update_id INT NOT NULL,
            field VARCHAR(64) NOT NULL,
            old_value VARCHAR(512) NULL,
            new_value VARCHAR(512) NULL,
            action VARCHAR(32) NOT NULL DEFAULT 'set',
            source VARCHAR(32) NOT NULL DEFAULT 'ui',
            changed_by_user_id INT NULL,
            changed_by_name VARCHAR(255) NULL,
            note VARCHAR(512) NULL,
            changed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            INDEX idx_dpu_log_update (update_id, changed_at),
            INDEX idx_dpu_log_field (field),
            INDEX idx_dpu_log_user (changed_by_user_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    schemaReady = true;
}

const FIELD_LOG_LABELS = {
    status: 'Статус',
    target_almamed: 'Куда: Альмамед',
    target_markets: 'Куда: Маркеты',
    content_user_id: 'Ответственный',
    content_name: 'Ответственный (имя)',
    product_manager_user_id: 'Менеджер товара',
    product_manager_name: 'Менеджер товара (имя)',
    assignee_user_id: 'Исполнитель',
    assignee_name: 'Исполнитель (имя)',
    done_almamed: 'Обновлено на Альмамед',
    done_ozon: 'Обновлено Ozon',
    done_wb: 'Обновлено WB',
    done_yandex: 'Обновлено Я.М.',
    ms_bundle_updated: 'Обновил комплект в МС (менеджер)',
    target_components_json: 'Состав (целевой)',
    current_components_json: 'Состав (снимок)',
    archived_at: 'Удалённые',
    _row: 'Строка',
    comment: 'Комментарий',
};

const SKIP_LOG_FIELDS = new Set([
    'content_name',
    'product_manager_name',
    'assignee_name',
    'ms_bundle_updated_at',
    'ms_bundle_updated_by_user_id',
    'ms_bundle_updated_by_name',
    'done_almamed_at',
    'done_almamed_by_user_id',
    'done_almamed_by_name',
    'done_ozon_at',
    'done_ozon_by_user_id',
    'done_ozon_by_name',
    'done_wb_at',
    'done_wb_by_user_id',
    'done_wb_by_name',
    'done_yandex_at',
    'done_yandex_by_user_id',
    'done_yandex_by_name',
]);

function clipLogVal(v) {
    if (v == null || v === '') return null;
    const s = String(v);
    return s.length > 512 ? `${s.slice(0, 509)}…` : s;
}

function formatFieldForLog(field, value) {
    if (value == null || value === '') return null;
    if (field === 'status') return STATUS_LABELS[value] || String(value);
    if (
        field === 'target_almamed' ||
        field === 'target_markets' ||
        field.startsWith('done_')
    ) {
        const on = value === true || value === 1 || value === '1';
        return on ? 'да' : 'нет';
    }
    if (field === 'archived_at') return value ? 'в удалённых' : null;
    if (field === 'target_components_json' || field === 'current_components_json') {
        const arr = parseJsonArray(value);
        return arr.length ? `${arr.length} поз.` : 'пусто';
    }
    return clipLogVal(value);
}

function valuesEqualForLog(field, a, b) {
    if (field.startsWith('done_') || field === 'target_almamed' || field === 'target_markets') {
        const an = a === true || a === 1 || a === '1' ? 1 : 0;
        const bn = b === true || b === 1 || b === '1' ? 1 : 0;
        return an === bn;
    }
    if (a == null && b == null) return true;
    if (a == null || b == null) return false;
    return String(a).trim() === String(b).trim();
}

async function insertUpdateLog(db, opts) {
    const updateId = Number(opts.updateId);
    if (!Number.isFinite(updateId) || updateId < 1) return;
    const field = String(opts.field || '').trim();
    if (!field) return;
    const actor = opts.actor || null;
    const uid = actor && actor.id != null ? Number(actor.id) : null;
    const uname = actorDisplayName(actor) || null;
    await db.query(
        `INSERT INTO dg_product_updates_log
            (update_id, field, old_value, new_value, action, source,
             changed_by_user_id, changed_by_name, note)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            updateId,
            field.slice(0, 64),
            clipLogVal(opts.oldValue),
            clipLogVal(opts.newValue),
            String(opts.action || 'set').slice(0, 32),
            String(opts.source || 'ui').slice(0, 32),
            Number.isFinite(uid) ? uid : null,
            uname,
            opts.note != null ? clipLogVal(opts.note) : null,
        ]
    );
}

async function logUpdateFieldChanges(db, { updateId, before, after, fields, actor, source, action }) {
    if (!fields || !fields.length) return;
    for (const key of fields) {
        if (SKIP_LOG_FIELDS.has(key)) continue;
        const oldRaw = before ? before[key] : null;
        const newRaw = after ? after[key] : null;
        if (valuesEqualForLog(key, oldRaw, newRaw)) continue;
        let oldDisp = formatFieldForLog(key, oldRaw);
        let newDisp = formatFieldForLog(key, newRaw);
        if (key === 'product_manager_user_id') {
            oldDisp = clipLogVal((before && before.product_manager_name) || oldDisp);
            newDisp = clipLogVal((after && after.product_manager_name) || newDisp);
        }
        if (key === 'content_user_id') {
            oldDisp = clipLogVal((before && before.content_name) || oldDisp);
            newDisp = clipLogVal((after && after.content_name) || newDisp);
        }
        if (key === 'assignee_user_id') {
            oldDisp = clipLogVal((before && before.assignee_name) || oldDisp);
            newDisp = clipLogVal((after && after.assignee_name) || newDisp);
        }
        await insertUpdateLog(db, {
            updateId,
            field: key,
            oldValue: oldDisp,
            newValue: newDisp,
            action: action || 'set',
            source: source || 'ui',
            actor,
        });
    }
}

async function lookupMsProduct(db, code) {
    const c = normCode(code);
    if (!c) return null;
    const [[row]] = await db.query(
        `SELECT TRIM(code) AS code, name, type, uuid
           FROM ms_export
          WHERE TRIM(code) = ?
          LIMIT 1`,
        [c]
    );
    if (!row) return null;
    const [[bc]] = await db.query(
        `SELECT COUNT(*) AS cnt FROM dg_bundle_components WHERE bundle_code = ? AND COALESCE(is_archived, 0) = 0`,
        [c]
    );
    const bundleByType = isBundleType(row.type);
    const bundleByCache = Number(bc && bc.cnt) > 0;
    return {
        code: String(row.code || c).trim(),
        name: clip(row.name, 512) || '',
        type: clip(row.type, 255) || '',
        uuid: row.uuid ? String(row.uuid) : null,
        is_bundle: bundleByType || bundleByCache ? 1 : 0,
    };
}

async function fetchBundleComponents(db, code) {
    const c = normCode(code);
    if (!c) return [];
    const [rows] = await db.query(
        `SELECT bc.component_code AS code,
                bc.qty_per_bundle AS qty,
                COALESCE(mse.name, '') AS name
           FROM dg_bundle_components bc
           LEFT JOIN ms_export mse ON TRIM(mse.code) = TRIM(bc.component_code)
          WHERE bc.bundle_code = ?
            AND COALESCE(bc.is_archived, 0) = 0
          ORDER BY bc.component_code`,
        [c]
    );
    return normalizeComponents(
        (rows || []).map((r) => ({
            code: r.code,
            qty: r.qty,
            name: r.name,
        }))
    );
}

function mapComment(r, actorUserId) {
    const authorId = r.author_user_id != null ? Number(r.author_user_id) : null;
    const full = String(r.author_name || '').trim();
    return {
        id: Number(r.id),
        row_id: Number(r.row_id),
        body: String(r.body || ''),
        author_user_id: Number.isFinite(authorId) && authorId > 0 ? authorId : null,
        author_name: full,
        author_short: shortPersonName(full) || (authorId ? String(authorId) : ''),
        created_at: r.created_at ? new Date(r.created_at).toISOString() : '',
        updated_at: r.updated_at ? new Date(r.updated_at).toISOString() : '',
        created_at_label: formatCommentDate(r.created_at),
        can_edit: actorUserId != null && authorId === actorUserId,
    };
}

async function loadCommentsByRowIds(db, rowIds, actorUserId) {
    const ids = [...new Set((rowIds || []).map(Number).filter((n) => Number.isFinite(n) && n > 0))];
    const out = {};
    ids.forEach((id) => {
        out[id] = [];
    });
    if (!ids.length) return out;
    const ph = ids.map(() => '?').join(',');
    const [rows] = await db.query(
        `SELECT id, row_id, body, author_user_id, author_name, created_at, updated_at
           FROM dg_product_update_comments
          WHERE row_id IN (${ph})
          ORDER BY id DESC`,
        ids
    );
    (rows || []).forEach((r) => {
        const rid = Number(r.row_id);
        if (!out[rid]) out[rid] = [];
        out[rid].push(mapComment(r, actorUserId));
    });
    return out;
}

function mapDone(r, ch) {
    const done = Number(r[`done_${ch}`]) === 1 ? 1 : 0;
    const at = r[`done_${ch}_at`];
    const byId = r[`done_${ch}_by_user_id`];
    return {
        done,
        at: at ? new Date(at).toISOString() : null,
        at_label: formatDateTime(at),
        by_user_id: byId != null ? Number(byId) : null,
        by_name: String(r[`done_${ch}_by_name`] || ''),
    };
}

function mapRow(r, comments) {
    let status = String(r.status || 'new');
    // back-compat: старый soft-archive через archived_at без status=removed
    if (r.archived_at && status !== 'removed') status = 'removed';
    const target = normalizeComponents(parseJsonArray(r.target_components_json));
    const current = normalizeComponents(parseJsonArray(r.current_components_json));
    const done = {};
    DONE_CHANNELS.forEach((ch) => {
        done[ch] = mapDone(r, ch);
    });
    return {
        id: Number(r.id),
        code: String(r.code || ''),
        name_snapshot: String(r.name_snapshot || ''),
        is_bundle: Number(r.is_bundle) === 1 ? 1 : 0,
        target_almamed: Number(r.target_almamed) === 1 ? 1 : 0,
        target_markets: Number(r.target_markets) === 1 ? 1 : 0,
        status,
        status_label: STATUS_LABELS[status] || status,
        is_removed: status === 'removed' ? 1 : 0,
        assignee_user_id: r.assignee_user_id != null ? Number(r.assignee_user_id) : null,
        assignee_name: String(r.assignee_name || ''),
        content_user_id: r.content_user_id != null ? Number(r.content_user_id) : null,
        content_name: String(r.content_name || ''),
        product_manager_user_id:
            r.product_manager_user_id != null ? Number(r.product_manager_user_id) : null,
        product_manager_name: String(r.product_manager_name || ''),
        ms_bundle_updated: Number(r.ms_bundle_updated) === 1 ? 1 : 0,
        ms_bundle_updated_at: r.ms_bundle_updated_at
            ? new Date(r.ms_bundle_updated_at).toISOString()
            : null,
        ms_bundle_updated_at_label: formatDateTime(r.ms_bundle_updated_at),
        ms_bundle_updated_by_user_id:
            r.ms_bundle_updated_by_user_id != null
                ? Number(r.ms_bundle_updated_by_user_id)
                : null,
        ms_bundle_updated_by_name: String(r.ms_bundle_updated_by_name || ''),
        done,
        done_almamed: done.almamed.done,
        done_ozon: done.ozon.done,
        done_wb: done.wb.done,
        done_yandex: done.yandex.done,
        target_components: target,
        current_components: current,
        components_count: target.length || current.length || 0,
        created_by_user_id: r.created_by_user_id != null ? Number(r.created_by_user_id) : null,
        created_by_name: String(r.created_by_name || ''),
        archived_at: r.archived_at ? new Date(r.archived_at).toISOString() : null,
        created_at: r.created_at ? new Date(r.created_at).toISOString() : '',
        updated_at: r.updated_at ? new Date(r.updated_at).toISOString() : '',
        created_at_label: formatDateTime(r.created_at),
        updated_at_label: formatDateTime(r.updated_at),
        comments: Array.isArray(comments) ? comments : [],
    };
}

async function fetchRowById(db, id) {
    const [[row]] = await db.query(`SELECT * FROM dg_product_updates WHERE id = ? LIMIT 1`, [id]);
    return row || null;
}

async function insertUpdateRow(db, { ms, targetAlmamed, targetMarkets, actor }) {
    const uid = actor && actor.id != null ? Number(actor.id) : null;
    const uname = actorDisplayName(actor) || null;
    let current = [];
    if (ms.is_bundle) {
        current = await fetchBundleComponents(db, ms.code);
    }
    const [ins] = await db.query(
        `INSERT INTO dg_product_updates
            (code, name_snapshot, is_bundle, target_almamed, target_markets, status,
             assignee_user_id, assignee_name, target_components_json, current_components_json,
             created_by_user_id, created_by_name)
         VALUES (?, ?, ?, ?, ?, 'new', ?, ?, ?, ?, ?, ?)`,
        [
            ms.code,
            ms.name || null,
            ms.is_bundle ? 1 : 0,
            targetAlmamed ? 1 : 0,
            targetMarkets ? 1 : 0,
            uid,
            uname,
            ms.is_bundle && current.length ? JSON.stringify(current) : null,
            ms.is_bundle && current.length ? JSON.stringify(current) : null,
            uid,
            uname,
        ]
    );
    return Number(ins.insertId);
}

function parseCodesList(raw) {
    const text = String(raw == null ? '' : raw);
    const parts = text
        .split(/[\n\r,;\t]+/)
        .map((s) => normCode(s))
        .filter(Boolean);
    const out = [];
    const seen = new Set();
    parts.forEach((c) => {
        const k = c.toLowerCase();
        if (seen.has(k)) return;
        seen.add(k);
        out.push(c);
    });
    return out;
}

module.exports = function productUpdatesRouterFactory(db) {
    const router = express.Router();

    router.use(async (req, res, next) => {
        try {
            await ensureSchema(db);
            next();
        } catch (e) {
            res.status(500).json({ success: false, error: e.message || 'Ошибка схемы' });
        }
    });

    router.get('/meta', (req, res) => {
        if (!canRead(req)) {
            return res.status(403).json({ success: false, error: 'Нет доступа', code: 'PAGE_HIDDEN' });
        }
        res.json({
            success: true,
            page_mode: pageMode(req),
            can_write: canWrite(req),
            statuses: Object.keys(STATUS_LABELS).map((k) => ({ key: k, label: STATUS_LABELS[k] })),
            actor_user_id: actorId(req),
        });
    });

    router.get('/lookup', async (req, res) => {
        try {
            if (!canRead(req)) {
                return res.status(403).json({ success: false, error: 'Нет доступа', code: 'PAGE_HIDDEN' });
            }
            const code = normCode(req.query.code);
            if (!code) return res.status(400).json({ success: false, error: 'Укажите код' });
            const ms = await lookupMsProduct(db, code);
            if (!ms) return res.status(404).json({ success: false, error: 'Код не найден в МойСклад' });
            let components = [];
            if (ms.is_bundle) components = await fetchBundleComponents(db, ms.code);
            res.json({ success: true, product: ms, components });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message || 'Ошибка lookup' });
        }
    });

    router.get('/', async (req, res) => {
        try {
            if (!canRead(req)) {
                return res.status(403).json({ success: false, error: 'Нет доступа', code: 'PAGE_HIDDEN' });
            }
            const q = req.query || {};
            const search = clip(q.search || q.q, 200);
            const status = normStatus(q.status);
            const type = String(q.type || q.is_bundle || '')
                .trim()
                .toLowerCase();
            const target = String(q.target || '')
                .trim()
                .toLowerCase();
            const assignee = String(q.assignee || '')
                .trim()
                .toLowerCase();
            const content = String(q.content || q.responsible || q.content_user_id || '')
                .trim()
                .toLowerCase();
            const manager = String(q.manager || q.product_manager || q.product_manager_user_id || '')
                .trim()
                .toLowerCase();
            const pendingDone = String(q.pending_done || q.not_done || '')
                .trim()
                .toLowerCase();
            const includeArchived = bool01(q.include_archived, 0) === 1;
            let limit = Number(q.limit);
            if (!Number.isFinite(limit) || limit <= 0) limit = DEFAULT_LIMIT;
            limit = Math.min(MAX_LIMIT, Math.max(1, Math.floor(limit)));
            let page = Number(q.page);
            if (!Number.isFinite(page) || page < 1) page = 1;
            page = Math.floor(page);
            const offset = (page - 1) * limit;

            let sort = String(q.sort || 'id').trim();
            if (!SORT_KEYS.has(sort)) sort = 'id';
            const dir = String(q.dir || 'desc').toLowerCase() === 'asc' ? 'ASC' : 'DESC';

            const where = [];
            const params = [];
            // Как на Альмамед: по умолчанию без удалённых; фильтр status=removed — только они.
            if (status === 'removed' || includeArchived) {
                where.push("(u.status = 'removed' OR u.archived_at IS NOT NULL)");
            } else if (status) {
                where.push("u.status = ? AND u.archived_at IS NULL");
                params.push(status);
            } else {
                where.push("u.status <> 'removed' AND u.archived_at IS NULL");
            }
            if (type === 'bundle' || type === '1' || type === 'комплект') {
                where.push('u.is_bundle = 1');
            } else if (type === 'product' || type === '0' || type === 'товар') {
                where.push('u.is_bundle = 0');
            }
            if (target === 'almamed') {
                where.push('u.target_almamed = 1');
            } else if (target === 'markets' || target === 'marketplaces') {
                where.push('u.target_markets = 1');
            } else if (target === 'both') {
                where.push('u.target_almamed = 1 AND u.target_markets = 1');
            }
            if (assignee === 'me') {
                const aid = actorId(req);
                if (aid) {
                    where.push('u.assignee_user_id = ?');
                    params.push(aid);
                }
            } else if (assignee && assignee !== 'all') {
                const aid = Number(assignee);
                if (Number.isFinite(aid) && aid > 0) {
                    where.push('u.assignee_user_id = ?');
                    params.push(aid);
                }
            }
            if (content === 'me') {
                const aid = actorId(req);
                if (aid) {
                    where.push('u.content_user_id = ?');
                    params.push(aid);
                }
            } else if (content === 'none' || content === 'unassigned') {
                where.push('u.content_user_id IS NULL');
            } else if (content && content !== 'all') {
                const cid = Number(content);
                if (Number.isFinite(cid) && cid > 0) {
                    where.push('u.content_user_id = ?');
                    params.push(cid);
                }
            }
            if (manager === 'me') {
                const aid = actorId(req);
                if (aid) {
                    where.push('u.product_manager_user_id = ?');
                    params.push(aid);
                }
            } else if (manager === 'none' || manager === 'unassigned') {
                where.push('u.product_manager_user_id IS NULL');
            } else if (manager && manager !== 'all') {
                const mid = Number(manager);
                if (Number.isFinite(mid) && mid > 0) {
                    where.push('u.product_manager_user_id = ?');
                    params.push(mid);
                }
            }
            if (DONE_CHANNELS.includes(pendingDone)) {
                if (pendingDone === 'almamed') {
                    where.push('u.target_almamed = 1 AND COALESCE(u.done_almamed, 0) = 0');
                } else {
                    where.push(`u.target_markets = 1 AND COALESCE(u.done_${pendingDone}, 0) = 0`);
                }
            }
            if (search) {
                where.push(
                    `(u.code LIKE ? OR u.name_snapshot LIKE ? OR EXISTS (
                        SELECT 1 FROM dg_product_update_comments c
                         WHERE c.row_id = u.id AND c.body LIKE ?
                    ))`
                );
                const like = `%${search}%`;
                params.push(like, like, like);
            }

            const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
            const [[cntRow]] = await db.query(
                `SELECT COUNT(*) AS cnt FROM dg_product_updates u ${whereSql}`,
                params
            );
            const total = Number(cntRow && cntRow.cnt) || 0;

            const sortCol =
                sort === 'assignee_name'
                    ? 'u.assignee_name'
                    : sort === 'content_name'
                      ? 'u.content_name'
                      : sort === 'product_manager_name'
                        ? 'u.product_manager_name'
                        : sort === 'name_snapshot'
                        ? 'u.name_snapshot'
                        : sort === 'code'
                          ? 'u.code'
                          : sort === 'status'
                            ? 'u.status'
                            : sort === 'is_bundle'
                              ? 'u.is_bundle'
                              : sort === 'created_at'
                                ? 'u.created_at'
                                : sort === 'updated_at'
                                  ? 'u.updated_at'
                                  : 'u.id';

            const [rows] = await db.query(
                `SELECT u.* FROM dg_product_updates u
                 ${whereSql}
                 ORDER BY ${sortCol} ${dir}, u.id DESC
                 LIMIT ? OFFSET ?`,
                params.concat([limit, offset])
            );
            const actor = actorId(req);
            const byComments = await loadCommentsByRowIds(
                db,
                (rows || []).map((r) => r.id),
                actor
            );
            const items = (rows || []).map((r) => mapRow(r, byComments[Number(r.id)] || []));
            const pages = Math.max(1, Math.ceil(total / limit) || 1);

            res.json({
                success: true,
                page_mode: pageMode(req),
                can_write: canWrite(req),
                actor_user_id: actor,
                total,
                page,
                pages,
                limit,
                shown: items.length,
                items,
                statuses: Object.keys(STATUS_LABELS).map((k) => ({ key: k, label: STATUS_LABELS[k] })),
            });
        } catch (e) {
            console.error('[product-updates] list', e);
            res.status(500).json({ success: false, error: e.message || 'Ошибка списка' });
        }
    });

    router.post('/', async (req, res) => {
        try {
            if (!canWrite(req)) {
                return res.status(403).json({ success: false, error: 'Режим только просмотра', code: 'PAGE_VIEW_ONLY' });
            }
            const body = req.body || {};
            const code = normCode(body.code);
            if (!code) return res.status(400).json({ success: false, error: 'Укажите код' });
            const targetAlmamed = bool01(body.target_almamed, 0) === 1;
            const targetMarkets = bool01(body.target_markets, 1) === 1;
            if (!targetAlmamed && !targetMarkets) {
                return res.status(400).json({ success: false, error: 'Выберите Альмамед и/или Маркеты' });
            }
            const ms = await lookupMsProduct(db, code);
            if (!ms) return res.status(404).json({ success: false, error: 'Код не найден в МойСклад' });

            const [[dup]] = await db.query(
                `SELECT id FROM dg_product_updates
                  WHERE code = ? AND archived_at IS NULL
                    AND status IN ('new', 'in_progress')
                    AND status <> 'removed'
                  LIMIT 1`,
                [ms.code]
            );
            if (dup) {
                return res.status(409).json({
                    success: false,
                    error: 'Уже есть открытая задача по этому коду',
                    existing_id: Number(dup.id),
                });
            }

            const id = await insertUpdateRow(db, {
                ms,
                targetAlmamed,
                targetMarkets,
                actor: req.datagonActor,
            });
            const row = await fetchRowById(db, id);
            try {
                await insertUpdateLog(db, {
                    updateId: id,
                    field: '_row',
                    oldValue: null,
                    newValue: ms.code,
                    action: 'create',
                    source: 'ui',
                    actor: req.datagonActor,
                    note: targetAlmamed && targetMarkets ? 'Альмамед+Маркеты' : targetAlmamed ? 'Альмамед' : 'Маркеты',
                });
            } catch (le) {
                console.warn('[product-updates] create log', le && le.message);
            }
            res.json({ success: true, row: mapRow(row, []) });
        } catch (e) {
            console.error('[product-updates] create', e);
            res.status(500).json({ success: false, error: e.message || 'Ошибка создания' });
        }
    });

    router.post('/bulk', async (req, res) => {
        const t0 = Date.now();
        try {
            if (!canWrite(req)) {
                return res.status(403).json({ success: false, error: 'Режим только просмотра', code: 'PAGE_VIEW_ONLY' });
            }
            const body = req.body || {};
            let codes = Array.isArray(body.codes) ? body.codes.map(normCode).filter(Boolean) : parseCodesList(body.text || body.codes_text);
            codes = parseCodesList(codes.join('\n'));
            if (!codes.length) {
                return res.status(400).json({ success: false, error: 'Укажите хотя бы один код' });
            }
            if (codes.length > MAX_BULK) {
                return res.status(400).json({
                    success: false,
                    error: `Не больше ${MAX_BULK} кодов за раз (сейчас ${codes.length})`,
                });
            }
            const targetAlmamed = bool01(body.target_almamed, 0) === 1;
            const targetMarkets = bool01(body.target_markets, 1) === 1;
            if (!targetAlmamed && !targetMarkets) {
                return res.status(400).json({ success: false, error: 'Выберите Альмамед и/или Маркеты' });
            }

            let created = 0;
            let skipped_dup = 0;
            let not_found = 0;
            const errors = [];
            const created_ids = [];

            for (const code of codes) {
                try {
                    const ms = await lookupMsProduct(db, code);
                    if (!ms) {
                        not_found += 1;
                        if (errors.length < 20) errors.push({ code, error: 'не найден в МС' });
                        continue;
                    }
                    const [[dup]] = await db.query(
                        `SELECT id FROM dg_product_updates
                          WHERE code = ? AND archived_at IS NULL AND status IN ('new', 'in_progress')
                          LIMIT 1`,
                        [ms.code]
                    );
                    if (dup) {
                        skipped_dup += 1;
                        if (errors.length < 20) {
                            errors.push({ code: ms.code, error: `уже в очереди (#${dup.id})` });
                        }
                        continue;
                    }
                    const id = await insertUpdateRow(db, {
                        ms,
                        targetAlmamed,
                        targetMarkets,
                        actor: req.datagonActor,
                    });
                    created += 1;
                    created_ids.push(id);
                } catch (rowErr) {
                    if (errors.length < 20) {
                        errors.push({ code, error: rowErr.message || 'ошибка' });
                    }
                }
            }

            const duration_sec = Math.round((Date.now() - t0) / 100) / 10;
            res.json({
                success: true,
                total: codes.length,
                created,
                skipped_dup,
                not_found,
                errors,
                created_ids,
                duration_sec,
                target_almamed: targetAlmamed ? 1 : 0,
                target_markets: targetMarkets ? 1 : 0,
            });
        } catch (e) {
            console.error('[product-updates] bulk', e);
            res.status(500).json({ success: false, error: e.message || 'Ошибка массового добавления' });
        }
    });

    router.get('/assignees', async (req, res) => {
        try {
            if (!canRead(req)) {
                return res.status(403).json({ success: false, error: 'Нет доступа', code: 'PAGE_HIDDEN' });
            }
            const mapUser = (u) => ({
                id: Number(u.id),
                username: u.username,
                full_name: u.full_name || '',
                label: String(u.full_name || u.username || '').trim() || String(u.username),
                specialty_name: u.specialty_name || '',
            });
            const [managers] = await db.query(
                `SELECT u.id, u.username, u.full_name, u.specialty_id, s.name AS specialty_name
                   FROM users u
                   INNER JOIN specialties s ON s.id = u.specialty_id
                  WHERE COALESCE(u.is_archived, 0) = 0
                    AND LOWER(TRIM(s.name)) = LOWER(?)
                  ORDER BY COALESCE(NULLIF(TRIM(u.full_name), ''), u.username) ASC`,
                ['Менеджер маркетплейсов']
            );
            const [responsibles] = await db.query(
                `SELECT u.id, u.username, u.full_name, u.specialty_id, s.name AS specialty_name
                   FROM users u
                   INNER JOIN specialties s ON s.id = u.specialty_id
                  WHERE COALESCE(u.is_archived, 0) = 0
                    AND LOWER(TRIM(s.name)) = LOWER(?)
                  ORDER BY COALESCE(NULLIF(TRIM(u.full_name), ''), u.username) ASC`,
                ['Контент-Менеджер']
            );
            const managersMapped = (managers || []).map(mapUser);
            const responsiblesMapped = (responsibles || []).map(mapUser);
            res.json({
                success: true,
                managers: managersMapped,
                responsibles: responsiblesMapped,
                // back-compat: items = ответственные (контент)
                items: responsiblesMapped,
            });
        } catch (e) {
            console.error('[product-updates] assignees', e);
            res.status(500).json({ success: false, error: e.message || 'Ошибка списка' });
        }
    });

    /**
     * Раздать открытые задачи контент-менеджерам блоками (как new-products/distribute).
     * Body: { scope?: 'unassigned'|'all', user_ids?: number[] }
     */
    router.post('/distribute', async (req, res) => {
        const t0 = Date.now();
        try {
            if (!canWrite(req)) {
                return res.status(403).json({ success: false, error: 'Режим только просмотра', code: 'PAGE_VIEW_ONLY' });
            }
            const body = req.body && typeof req.body === 'object' ? req.body : {};
            const scope = String(body.scope || 'unassigned').trim().toLowerCase();

            let users;
            if (Array.isArray(body.user_ids) && body.user_ids.length) {
                const ids = body.user_ids.map((x) => parseInt(x, 10)).filter((n) => Number.isFinite(n) && n > 0);
                if (!ids.length) return res.status(400).json({ success: false, error: 'Пустой список user_ids' });
                const [rows] = await db.query(
                    `SELECT id, username, full_name FROM users
                      WHERE id IN (${ids.map(() => '?').join(',')}) AND COALESCE(is_archived, 0) = 0`,
                    ids
                );
                users = rows || [];
            } else {
                const [rows] = await db.query(
                    `SELECT u.id, u.username, u.full_name
                       FROM users u
                       INNER JOIN specialties s ON s.id = u.specialty_id
                      WHERE COALESCE(u.is_archived, 0) = 0
                        AND LOWER(TRIM(s.name)) = LOWER(?)
                      ORDER BY u.id ASC`,
                    ['Контент-Менеджер']
                );
                users = rows || [];
            }
            if (!users.length) {
                return res.status(400).json({ success: false, error: 'Нет активных контент-менеджеров для раздачи' });
            }

            const where =
                scope === 'all'
                    ? "archived_at IS NULL AND status IN ('new', 'in_progress')"
                    : "archived_at IS NULL AND status IN ('new', 'in_progress') AND content_user_id IS NULL";
            const [rows] = await db.query(
                `SELECT id, content_user_id, content_name FROM dg_product_updates
                  WHERE ${where}
                  ORDER BY id ASC`
            );
            if (!rows.length) {
                return res.json({
                    success: true,
                    assigned: 0,
                    users: users.length,
                    message: 'Нечего раздавать',
                    duration_sec: 0,
                });
            }

            const m = users.length;
            const n = rows.length;
            let assigned = 0;
            let rowIdx = 0;
            for (let uIdx = 0; uIdx < m && rowIdx < n; uIdx++) {
                const remainingRows = n - rowIdx;
                const remainingUsers = m - uIdx;
                const chunk = Math.ceil(remainingRows / remainingUsers);
                const u = users[uIdx];
                const name = String(u.full_name || u.username || '').trim() || String(u.username);
                for (let k = 0; k < chunk && rowIdx < n; k++, rowIdx++) {
                    const before = rows[rowIdx];
                    await db.query(
                        `UPDATE dg_product_updates
                            SET content_user_id = ?, content_name = ?,
                                status = IF(status = 'new', 'in_progress', status)
                          WHERE id = ?`,
                        [u.id, name, before.id]
                    );
                    assigned += 1;
                }
            }

            const duration_sec = Math.round((Date.now() - t0) / 100) / 10;
            res.json({
                success: true,
                assigned,
                total: n,
                users: users.length,
                scope,
                duration_sec,
                message: `Раздано ${assigned} из ${n} строк на ${users.length} контент-менеджеров`,
            });
        } catch (e) {
            console.error('[product-updates] distribute', e);
            res.status(500).json({ success: false, error: e.message || 'Ошибка раздачи' });
        }
    });

    router.patch('/:id', async (req, res) => {
        try {
            if (!canWrite(req)) {
                return res.status(403).json({ success: false, error: 'Режим только просмотра', code: 'PAGE_VIEW_ONLY' });
            }
            const id = Number(req.params.id);
            if (!Number.isFinite(id) || id <= 0) {
                return res.status(400).json({ success: false, error: 'Некорректный id' });
            }
            const existing = await fetchRowById(db, id);
            if (!existing) return res.status(404).json({ success: false, error: 'Строка не найдена' });

            const body = req.body || {};
            const sets = [];
            const params = [];

            if (body.status != null) {
                const st = normStatus(body.status);
                if (!st) return res.status(400).json({ success: false, error: 'Некорректный статус' });
                sets.push('status = ?');
                params.push(st);
            }
            if (body.target_almamed != null) {
                sets.push('target_almamed = ?');
                params.push(bool01(body.target_almamed, Number(existing.target_almamed)) === 1 ? 1 : 0);
            }
            if (body.target_markets != null) {
                sets.push('target_markets = ?');
                params.push(bool01(body.target_markets, Number(existing.target_markets)) === 1 ? 1 : 0);
            }
            if (body.assignee_user_id !== undefined) {
                const aid = body.assignee_user_id == null || body.assignee_user_id === '' ? null : Number(body.assignee_user_id);
                if (aid == null) {
                    sets.push('assignee_user_id = NULL', 'assignee_name = NULL');
                } else if (Number.isFinite(aid) && aid > 0) {
                    sets.push('assignee_user_id = ?', 'assignee_name = ?');
                    params.push(aid, clip(body.assignee_name || actorDisplayName(req.datagonActor), 255) || String(aid));
                }
            }
            if (body.take === true || body.take === 1 || body.take === '1') {
                const aid = actorId(req);
                const aname = actorDisplayName(req.datagonActor) || String(aid || '');
                sets.push('assignee_user_id = ?', 'assignee_name = ?');
                params.push(aid, aname);
                sets.push('content_user_id = ?', 'content_name = ?');
                params.push(aid, aname);
                if (!normStatus(body.status) && String(existing.status) === 'new') {
                    sets.push("status = 'in_progress'");
                }
            }
            if (body.content_user_id !== undefined) {
                const cid =
                    body.content_user_id == null || body.content_user_id === ''
                        ? null
                        : Number(body.content_user_id);
                if (cid == null) {
                    sets.push('content_user_id = NULL', 'content_name = NULL');
                } else if (Number.isFinite(cid) && cid > 0) {
                    sets.push('content_user_id = ?', 'content_name = ?');
                    params.push(cid, clip(body.content_name, 255) || String(cid));
                }
            }
            if (body.product_manager_user_id !== undefined) {
                const mid =
                    body.product_manager_user_id == null || body.product_manager_user_id === ''
                        ? null
                        : Number(body.product_manager_user_id);
                if (mid == null) {
                    sets.push('product_manager_user_id = NULL', 'product_manager_name = NULL');
                } else if (Number.isFinite(mid) && mid > 0) {
                    sets.push('product_manager_user_id = ?', 'product_manager_name = ?');
                    params.push(mid, clip(body.product_manager_name, 255) || String(mid));
                }
            }
            if (body.ms_bundle_updated != null) {
                if (Number(existing.is_bundle) !== 1) {
                    return res.status(400).json({
                        success: false,
                        error: 'Галочка «Обновил комплект в МС» только для комплектов',
                    });
                }
                const mgrId =
                    existing.product_manager_user_id != null
                        ? Number(existing.product_manager_user_id)
                        : null;
                const aid = actorId(req);
                if (!mgrId || !aid || mgrId !== aid) {
                    return res.status(403).json({
                        success: false,
                        error: 'Галочку может ставить только менеджер товара этой строки',
                    });
                }
                const on = bool01(body.ms_bundle_updated, 0) === 1;
                if (on) {
                    sets.push(
                        'ms_bundle_updated = 1',
                        'ms_bundle_updated_at = NOW()',
                        'ms_bundle_updated_by_user_id = ?',
                        'ms_bundle_updated_by_name = ?'
                    );
                    params.push(aid, actorDisplayName(req.datagonActor) || String(aid || ''));
                } else {
                    sets.push(
                        'ms_bundle_updated = 0',
                        'ms_bundle_updated_at = NULL',
                        'ms_bundle_updated_by_user_id = NULL',
                        'ms_bundle_updated_by_name = NULL'
                    );
                }
            }
            for (const ch of DONE_CHANNELS) {
                const key = `done_${ch}`;
                if (body[key] == null) continue;
                const on = bool01(body[key], 0) === 1;
                if (on) {
                    const aid = actorId(req);
                    sets.push(
                        `${key} = 1`,
                        `${key}_at = NOW()`,
                        `${key}_by_user_id = ?`,
                        `${key}_by_name = ?`
                    );
                    params.push(aid, actorDisplayName(req.datagonActor) || String(aid || ''));
                } else {
                    sets.push(
                        `${key} = 0`,
                        `${key}_at = NULL`,
                        `${key}_by_user_id = NULL`,
                        `${key}_by_name = NULL`
                    );
                }
            }
            if (body.archive === true || body.archive === 1 || body.archive === '1') {
                // «В удалённые» — как DELETE на Альмамед (status=removed + archived_at)
                sets.push("status = 'removed'", 'archived_at = NOW()');
            }
            if (body.restore === true || body.restore === 1 || body.restore === '1') {
                sets.push("status = 'in_progress'", 'archived_at = NULL');
            }

            if (!sets.length) {
                return res.status(400).json({ success: false, error: 'Нечего менять' });
            }

            // после смены targets не оставлять оба выключенными
            let nextAlm =
                body.target_almamed != null
                    ? bool01(body.target_almamed, 0)
                    : Number(existing.target_almamed);
            let nextMp =
                body.target_markets != null
                    ? bool01(body.target_markets, 0)
                    : Number(existing.target_markets);
            if (body.target_almamed != null || body.target_markets != null) {
                if (!nextAlm && !nextMp) {
                    return res.status(400).json({ success: false, error: 'Нужен хотя бы один канал' });
                }
            }

            params.push(id);
            await db.query(`UPDATE dg_product_updates SET ${sets.join(', ')} WHERE id = ?`, params);
            const row = await fetchRowById(db, id);
            try {
                const logFields = [
                    'status',
                    'target_almamed',
                    'target_markets',
                    'content_user_id',
                    'product_manager_user_id',
                    'assignee_user_id',
                    'ms_bundle_updated',
                    'done_almamed',
                    'done_ozon',
                    'done_wb',
                    'done_yandex',
                    'archived_at',
                ];
                let action = 'set';
                if (body.take === true || body.take === 1 || body.take === '1') action = 'take';
                if (body.archive === true || body.archive === 1 || body.archive === '1') action = 'remove';
                if (body.restore === true || body.restore === 1 || body.restore === '1') action = 'restore';
                await logUpdateFieldChanges(db, {
                    updateId: id,
                    before: existing,
                    after: row,
                    fields: logFields,
                    actor: req.datagonActor,
                    source: 'ui',
                    action,
                });
            } catch (le) {
                console.warn('[product-updates] patch log', le && le.message);
            }
            const actor = actorId(req);
            const comments = (await loadCommentsByRowIds(db, [id], actor))[id] || [];
            res.json({ success: true, row: mapRow(row, comments) });
        } catch (e) {
            console.error('[product-updates] patch', e);
            res.status(500).json({ success: false, error: e.message || 'Ошибка обновления' });
        }
    });

    router.get('/:id/log', async (req, res) => {
        try {
            if (!canRead(req)) {
                return res.status(403).json({ success: false, error: 'Нет доступа', code: 'PAGE_HIDDEN' });
            }
            const id = Number(req.params.id);
            if (!Number.isFinite(id) || id < 1) {
                return res.status(400).json({ success: false, error: 'Некорректный id' });
            }
            const existing = await fetchRowById(db, id);
            if (!existing) return res.status(404).json({ success: false, error: 'Строка не найдена' });

            const rawLimit = Number(req.query.limit);
            const limit = Math.min(
                500,
                Math.max(1, Number.isFinite(rawLimit) && rawLimit > 0 ? Math.floor(rawLimit) : 100)
            );
            const rawOffset = Number(req.query.offset);
            const offset = Math.max(
                0,
                Number.isFinite(rawOffset) && rawOffset >= 0 ? Math.floor(rawOffset) : 0
            );
            const field = String(req.query.field || '').trim();
            const fieldsList = String(req.query.fields || '')
                .split(',')
                .map((s) => String(s || '').trim())
                .filter(Boolean)
                .slice(0, 20);
            const where = ['update_id = ?'];
            const params = [id];
            if (fieldsList.length > 1) {
                where.push(`field IN (${fieldsList.map(() => '?').join(',')})`);
                params.push(...fieldsList);
            } else if (fieldsList.length === 1) {
                where.push('field = ?');
                params.push(fieldsList[0]);
            } else if (field) {
                where.push('field = ?');
                params.push(field);
            }
            const whereSql = `WHERE ${where.join(' AND ')}`;
            const [[cnt]] = await db.query(
                `SELECT COUNT(*) AS total FROM dg_product_updates_log ${whereSql}`,
                params
            );
            const [rows] = await db.query(
                `SELECT id, update_id, field, old_value, new_value, action, source,
                        changed_by_user_id, changed_by_name, note, changed_at
                   FROM dg_product_updates_log ${whereSql}
                  ORDER BY id DESC
                  LIMIT ? OFFSET ?`,
                [...params, limit, offset]
            );
            res.json({
                success: true,
                update_id: id,
                code: existing.code,
                total: Number(cnt && cnt.total) || 0,
                limit,
                offset,
                field: fieldsList.length === 1 ? fieldsList[0] : field || '',
                fields: fieldsList.length > 1 ? fieldsList : undefined,
                rows: (rows || []).map((r) => ({
                    id: Number(r.id),
                    update_id: Number(r.update_id),
                    field: String(r.field || ''),
                    field_label: FIELD_LOG_LABELS[r.field] || String(r.field || ''),
                    old_value: r.old_value != null ? String(r.old_value) : null,
                    new_value: r.new_value != null ? String(r.new_value) : null,
                    action: String(r.action || 'set'),
                    source: String(r.source || 'ui'),
                    changed_by_user_id:
                        r.changed_by_user_id != null ? Number(r.changed_by_user_id) : null,
                    changed_by_name: String(r.changed_by_name || ''),
                    note: r.note != null ? String(r.note) : null,
                    changed_at: r.changed_at ? new Date(r.changed_at).toISOString() : null,
                })),
            });
        } catch (e) {
            console.error('[product-updates] log', e);
            res.status(500).json({ success: false, error: e.message || 'Ошибка журнала' });
        }
    });

    router.get('/:id/composition', async (req, res) => {
        try {
            if (!canRead(req)) {
                return res.status(403).json({ success: false, error: 'Нет доступа', code: 'PAGE_HIDDEN' });
            }
            const id = Number(req.params.id);
            if (!Number.isFinite(id) || id <= 0) {
                return res.status(400).json({ success: false, error: 'Некорректный id' });
            }
            const existing = await fetchRowById(db, id);
            if (!existing) return res.status(404).json({ success: false, error: 'Строка не найдена' });

            const live = await fetchBundleComponents(db, existing.code);
            const target = normalizeComponents(parseJsonArray(existing.target_components_json));
            const storedCurrent = normalizeComponents(parseJsonArray(existing.current_components_json));
            // current = снимок на момент постановки (не live после правок в МС)
            const current = storedCurrent.length ? storedCurrent : [];

            res.json({
                success: true,
                id,
                code: existing.code,
                name: existing.name_snapshot,
                is_bundle: Number(existing.is_bundle) === 1 ? 1 : 0,
                current,
                target: target.length ? target : current.slice(),
                live_from_ms: live,
                snapshot_at_create: true,
            });
        } catch (e) {
            console.error('[product-updates] composition get', e);
            res.status(500).json({ success: false, error: e.message || 'Ошибка состава' });
        }
    });

    router.put('/:id/composition', async (req, res) => {
        try {
            if (!canWrite(req)) {
                return res.status(403).json({ success: false, error: 'Режим только просмотра', code: 'PAGE_VIEW_ONLY' });
            }
            const id = Number(req.params.id);
            if (!Number.isFinite(id) || id <= 0) {
                return res.status(400).json({ success: false, error: 'Некорректный id' });
            }
            const existing = await fetchRowById(db, id);
            if (!existing) return res.status(404).json({ success: false, error: 'Строка не найдена' });
            if (Number(existing.is_bundle) !== 1) {
                return res.status(400).json({ success: false, error: 'Состав только для комплектов' });
            }

            const body = req.body || {};
            const target = normalizeComponents(body.components || body.target || body.target_components);
            const currentSnapshot = normalizeComponents(parseJsonArray(existing.current_components_json));

            const beforeTarget = normalizeComponents(parseJsonArray(existing.target_components_json));
            await db.query(
                `UPDATE dg_product_updates
                    SET target_components_json = ?,
                        is_bundle = 1
                  WHERE id = ?`,
                [JSON.stringify(target), id]
            );

            try {
                await insertUpdateLog(db, {
                    updateId: id,
                    field: 'target_components_json',
                    oldValue: formatFieldForLog('target_components_json', beforeTarget),
                    newValue: formatFieldForLog('target_components_json', target),
                    action: 'composition',
                    source: 'ui',
                    actor: req.datagonActor,
                });
            } catch (le) {
                console.warn('[product-updates] composition log', le && le.message);
            }

            const row = await fetchRowById(db, id);
            const actor = actorId(req);
            const comments = (await loadCommentsByRowIds(db, [id], actor))[id] || [];
            res.json({
                success: true,
                row: mapRow(row, comments),
                current: currentSnapshot,
                target,
            });
        } catch (e) {
            console.error('[product-updates] composition put', e);
            res.status(500).json({ success: false, error: e.message || 'Ошибка сохранения состава' });
        }
    });

    /** Перезаписать снимок «как было» из текущего кэша МС (осознанно ломает эталон постановки). */
    router.post('/:id/composition/resync-current', async (req, res) => {
        try {
            if (!canWrite(req)) {
                return res.status(403).json({ success: false, error: 'Режим только просмотра', code: 'PAGE_VIEW_ONLY' });
            }
            const id = Number(req.params.id);
            if (!Number.isFinite(id) || id <= 0) {
                return res.status(400).json({ success: false, error: 'Некорректный id' });
            }
            const existing = await fetchRowById(db, id);
            if (!existing) return res.status(404).json({ success: false, error: 'Строка не найдена' });
            if (Number(existing.is_bundle) !== 1) {
                return res.status(400).json({ success: false, error: 'Состав только для комплектов' });
            }
            const live = await fetchBundleComponents(db, existing.code);
            const alsoTarget = bool01(req.body && req.body.copy_to_target, 0) === 1;
            if (alsoTarget) {
                await db.query(
                    `UPDATE dg_product_updates
                        SET current_components_json = ?,
                            target_components_json = ?
                      WHERE id = ?`,
                    [JSON.stringify(live), JSON.stringify(live), id]
                );
            } else {
                await db.query(`UPDATE dg_product_updates SET current_components_json = ? WHERE id = ?`, [
                    JSON.stringify(live),
                    id,
                ]);
            }
            const row = await fetchRowById(db, id);
            const actor = actorId(req);
            const comments = (await loadCommentsByRowIds(db, [id], actor))[id] || [];
            const target = normalizeComponents(parseJsonArray(row.target_components_json));
            res.json({
                success: true,
                row: mapRow(row, comments),
                current: live,
                target,
                live_from_ms: live,
            });
        } catch (e) {
            console.error('[product-updates] composition resync', e);
            res.status(500).json({ success: false, error: e.message || 'Ошибка resync' });
        }
    });

    router.post('/:id/comments', async (req, res) => {
        try {
            if (!canWrite(req)) {
                return res.status(403).json({ success: false, error: 'Режим только просмотра', code: 'PAGE_VIEW_ONLY' });
            }
            const id = Number(req.params.id);
            if (!Number.isFinite(id) || id <= 0) {
                return res.status(400).json({ success: false, error: 'Некорректный id' });
            }
            const existing = await fetchRowById(db, id);
            if (!existing) return res.status(404).json({ success: false, error: 'Строка не найдена' });
            if (existing.archived_at) {
                return res.status(400).json({ success: false, error: 'Строка в архиве' });
            }
            const body = clip(req.body && req.body.body, MAX_COMMENT);
            if (!body) return res.status(400).json({ success: false, error: 'Введите текст комментария' });
            const actor = actorId(req);
            if (!actor) return res.status(401).json({ success: false, error: 'Нужна авторизация' });
            const authorName = actorDisplayName(req.datagonActor) || String(actor);
            const [ins] = await db.query(
                `INSERT INTO dg_product_update_comments (row_id, body, author_user_id, author_name)
                 VALUES (?, ?, ?, ?)`,
                [id, body, actor, authorName]
            );
            const [[cmt]] = await db.query(
                `SELECT id, row_id, body, author_user_id, author_name, created_at, updated_at
                   FROM dg_product_update_comments WHERE id = ?`,
                [ins.insertId]
            );
            const comments = (await loadCommentsByRowIds(db, [id], actor))[id] || [];
            res.json({
                success: true,
                comment: mapComment(cmt || { id: ins.insertId, row_id: id, body, author_user_id: actor, author_name: authorName }, actor),
                row: mapRow(existing, comments),
            });
        } catch (e) {
            console.error('[product-updates] comment add', e);
            res.status(500).json({ success: false, error: e.message || 'Ошибка комментария' });
        }
    });

    router.patch('/:id/comments/:commentId', async (req, res) => {
        try {
            if (!canWrite(req)) {
                return res.status(403).json({ success: false, error: 'Режим только просмотра', code: 'PAGE_VIEW_ONLY' });
            }
            const id = Number(req.params.id);
            const commentId = Number(req.params.commentId);
            if (!Number.isFinite(id) || id <= 0 || !Number.isFinite(commentId) || commentId <= 0) {
                return res.status(400).json({ success: false, error: 'Некорректный id' });
            }
            const existing = await fetchRowById(db, id);
            if (!existing) return res.status(404).json({ success: false, error: 'Строка не найдена' });
            const [[cmt]] = await db.query(
                `SELECT id, row_id, body, author_user_id, author_name, created_at, updated_at
                   FROM dg_product_update_comments WHERE id = ? AND row_id = ?`,
                [commentId, id]
            );
            if (!cmt) return res.status(404).json({ success: false, error: 'Комментарий не найден' });
            const actor = actorId(req);
            if (!actor || Number(cmt.author_user_id) !== actor) {
                return res.status(403).json({ success: false, error: 'Редактировать можно только свой комментарий' });
            }
            const body = clip(req.body && req.body.body, MAX_COMMENT);
            if (!body) return res.status(400).json({ success: false, error: 'Введите текст комментария' });
            await db.query('UPDATE dg_product_update_comments SET body = ? WHERE id = ? AND row_id = ?', [
                body,
                commentId,
                id,
            ]);
            const [[updated]] = await db.query(
                `SELECT id, row_id, body, author_user_id, author_name, created_at, updated_at
                   FROM dg_product_update_comments WHERE id = ?`,
                [commentId]
            );
            const comments = (await loadCommentsByRowIds(db, [id], actor))[id] || [];
            res.json({
                success: true,
                comment: mapComment(updated || Object.assign({}, cmt, { body }), actor),
                row: mapRow(existing, comments),
            });
        } catch (e) {
            console.error('[product-updates] comment edit', e);
            res.status(500).json({ success: false, error: e.message || 'Ошибка редактирования' });
        }
    });

    router.delete('/:id/comments/:commentId', async (req, res) => {
        try {
            if (!canWrite(req)) {
                return res.status(403).json({ success: false, error: 'Режим только просмотра', code: 'PAGE_VIEW_ONLY' });
            }
            const id = Number(req.params.id);
            const commentId = Number(req.params.commentId);
            if (!Number.isFinite(id) || id <= 0 || !Number.isFinite(commentId) || commentId <= 0) {
                return res.status(400).json({ success: false, error: 'Некорректный id' });
            }
            const existing = await fetchRowById(db, id);
            if (!existing) return res.status(404).json({ success: false, error: 'Строка не найдена' });
            const [[cmt]] = await db.query(
                `SELECT id, row_id, body, author_user_id, author_name, created_at, updated_at
                   FROM dg_product_update_comments WHERE id = ? AND row_id = ?`,
                [commentId, id]
            );
            if (!cmt) return res.status(404).json({ success: false, error: 'Комментарий не найден' });
            const actor = actorId(req);
            if (!actor || Number(cmt.author_user_id) !== actor) {
                return res.status(403).json({ success: false, error: 'Удалить можно только свой комментарий' });
            }
            await db.query('DELETE FROM dg_product_update_comments WHERE id = ? AND row_id = ?', [commentId, id]);
            const comments = (await loadCommentsByRowIds(db, [id], actor))[id] || [];
            res.json({ success: true, row: mapRow(existing, comments) });
        } catch (e) {
            console.error('[product-updates] comment delete', e);
            res.status(500).json({ success: false, error: e.message || 'Ошибка удаления' });
        }
    });

    return router;
};
