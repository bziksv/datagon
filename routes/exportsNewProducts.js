'use strict';

/**
 * Маркетплейсы → Новые товары: очередь на заведение карточек (Альмамед / маркеты).
 * Таблица `dg_new_products`, channel = almamed | marketplaces.
 *
 * Статусы (обе вкладки):
 *  - new — товар добавлен в таблицу;
 *  - in_progress — контент в работе;
 *  - review — «На проверку» (контент закончил; «Проверен» сами выбрать не могут);
 *  - verified — «Проверен» (после проверки контента), только если manager_checked=1
 *    и роль admin / can_manage_users / «Полный доступ»;
 *  - manager_checked — галочка «Проверено менеджером» (менеджеры по своей части);
 *  - new ↔ not_added — авто по обязательным полям (Альмамед); на маркетах — new/not_added/added
 *    по заполненности/наличию на МП, не трогает workflow-статусы;
 *  - revision / added / not_cooperate / in_bundle — по сценарию;
 *  - transferred/removed — закрытые строки.
 */

const express = require('express');
const markets = require('../lib/dgNewProductsMarkets');

const CHANNELS = new Set(['almamed', 'marketplaces']);
const PRIORITIES = new Set(['important', 'normal', 'low']);
const STATUSES = new Set([
    'new',
    'not_added',
    'in_progress',
    'added',
    'revision',
    'review',
    'verified',
    'transferred',
    'not_cooperate',
    'in_bundle',
    'removed',
]);
/** Статусы, которыми управляет авто-логика заполненности (Альмамед). */
const AUTO_STATUSES = new Set(['new', 'not_added']);
const SORT_KEYS = new Set([
    'id',
    'created_at',
    'priority',
    'status',
    'title',
    'article',
    'product_code',
    'brand',
    'price_almamed',
    'price_markets',
    'product_manager_name',
    'responsible_name',
    'almamed_added_at',
    'placement_date',
    'placement_ozon_at',
    'placement_wb_at',
    'placement_ym_at',
    'updated_at',
    'infographic',
    'photo',
    'huckster',
]);

const PRIORITY_ORDER_SQL = `FIELD(priority, 'important', 'normal', 'low')`;
const STATUS_LABELS = {
    new: 'Новый',
    not_added: 'Не добавлен',
    in_progress: 'В работе',
    added: 'Добавлен',
    revision: 'На доработке',
    review: 'На проверку',
    verified: 'Проверен',
    transferred: 'Передан в МС',
    not_cooperate: 'Не сотрудничаем',
    in_bundle: 'В составе комплекта',
    removed: 'Удалённые',
};
const PRIORITY_LABELS = {
    important: 'Важный',
    normal: 'Обычный',
    low: 'Не важный',
};

/** Подписи полей для журнала изменений (как колонки UI). */
const FIELD_LOG_LABELS = {
    product_manager_user_id: 'Менеджер товара',
    product_manager_name: 'Менеджер товара (имя)',
    responsible_user_id: 'Ответственный',
    responsible_name: 'Ответственный (имя)',
    sell_on_markets: 'Маркеты',
    has_kits: 'Комплект',
    article: 'Артикул',
    title: 'Название',
    price_almamed: 'Цена Альмамед',
    supplier_url: 'Ссылка поставщика',
    brand: 'Бренд',
    priority: 'Приоритет',
    status: 'Статус',
    comment: 'Комментарий контент',
    manager_comment: 'Комментарий менеджер',
    almamed_added_at: 'Дата на Альмамед',
    almamed_url: 'Ссылка Альмамед',
    product_code: 'Код',
    barcode: 'Штрихкод',
    price_markets: 'Цена на маркеты',
    dimensions_text: 'Габариты и вес',
    length_cm: 'Длина, см',
    width_cm: 'Ширина, см',
    height_cm: 'Высота, см',
    weight_kg: 'Вес, кг',
    vat: 'НДС',
    ru_url: 'Ссылка на РУ',
    placement_ozon: 'Размещение Ozon',
    placement_wb: 'Размещение WB',
    placement_ym: 'Размещение ЯМ',
    placement_ozon_at: 'Дата на Ozon',
    placement_wb_at: 'Дата на WB',
    placement_ym_at: 'Дата на ЯМ',
    placement_date: 'Дата размещения',
    infographic: 'Инфографика',
    photo: 'Фото',
    huckster: 'Huckster',
    manager_checked: 'Проверено менеджером',
    kit_title: 'Название комплекта',
    _row: 'Строка',
};

/** Не дублируем в логе имя, если уже пишем id пользователя. */
const SKIP_LOG_FIELDS = new Set(['product_manager_name', 'responsible_name']);

/** Обязательные ячейки для статуса «Не добавлен» (Альмамед). */
const REQUIRED_KEYS = [
    { key: 'article', label: 'Артикул' },
    { key: 'title', label: 'Название' },
    { key: 'price_almamed', label: 'Цена Альмамед' },
    { key: 'supplier_url', label: 'Ссылка на сайт поставщика' },
    { key: 'priority', label: 'Приоритет' },
];

const HUCKSTER_EDITOR_SPECIALTY = 'Менеджер маркетплейсов';

function actorCanEditHuckster(actor) {
    if (!actor) return false;
    if (actor.username === 'admin') return true;
    if (actor.can_manage_users === true) return true;
    const spec = String(actor.specialty_name || '').trim();
    if (spec === HUCKSTER_EDITOR_SPECIALTY) return true;
    if (spec === 'Полный доступ') return true;
    return false;
}

/** Статус «Проверен» — финальная проверка контента (не менеджеры товара). */
function actorCanSetVerified(actor) {
    if (!actor) return false;
    if (actor.username === 'admin') return true;
    if (actor.can_manage_users === true) return true;
    const spec = String(actor.specialty_name || '').trim();
    if (spec === 'Полный доступ') return true;
    return false;
}

function truthyFlag(v) {
    if (v === true || v === 1 || v === '1') return true;
    if (v === false || v === 0 || v === '0' || v == null || v === '') return false;
    const s = String(v).trim().toLowerCase();
    if (s === 'true' || s === 'yes' || s === 'on') return true;
    if (s === 'false' || s === 'no' || s === 'off') return false;
    return !!v;
}

let schemaReady = false;

async function ensureColumn(db, table, column, definition) {
    const [rows] = await db.query('SHOW COLUMNS FROM `' + table + '` LIKE ?', [column]);
    if (Array.isArray(rows) && rows.length > 0) return;
    await db.query('ALTER TABLE `' + table + '` ADD COLUMN `' + column + '` ' + definition);
}

async function ensureSchema(db) {
    if (schemaReady) return;
    await db.query(`
        CREATE TABLE IF NOT EXISTS dg_new_products (
            id BIGINT AUTO_INCREMENT PRIMARY KEY,
            channel VARCHAR(32) NOT NULL DEFAULT 'almamed',
            product_manager_user_id INT NULL,
            product_manager_name VARCHAR(255) NULL,
            responsible_user_id INT NULL,
            responsible_name VARCHAR(255) NULL,
            article VARCHAR(128) NULL,
            title VARCHAR(128) NOT NULL DEFAULT '',
            price_almamed DECIMAL(14, 2) NULL,
            supplier_url VARCHAR(2048) NULL,
            brand VARCHAR(255) NULL,
            priority VARCHAR(16) NOT NULL DEFAULT 'normal',
            status VARCHAR(32) NOT NULL DEFAULT 'new',
            comment TEXT NULL,
            almamed_added_at DATETIME NULL,
            almamed_url VARCHAR(2048) NULL,
            ms_product_uuid VARCHAR(64) NULL,
            transferred_at DATETIME NULL,
            created_by_user_id INT NULL,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            INDEX idx_dg_np_channel_status (channel, status),
            INDEX idx_dg_np_responsible (responsible_user_id),
            INDEX idx_dg_np_manager (product_manager_user_id),
            INDEX idx_dg_np_priority (priority),
            INDEX idx_dg_np_brand (brand(64))
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await ensureColumn(db, 'dg_new_products', 'ms_product_uuid', 'VARCHAR(64) NULL');
    await ensureColumn(db, 'dg_new_products', 'transferred_at', 'DATETIME NULL');
    await ensureColumn(db, 'dg_new_products', 'sell_on_markets', 'TINYINT(1) NOT NULL DEFAULT 0');
    await ensureColumn(db, 'dg_new_products', 'has_kits', 'TINYINT(1) NOT NULL DEFAULT 0');
    await markets.ensureMarketsColumns(db);
    await db.query(`
        CREATE TABLE IF NOT EXISTS dg_new_products_log (
            id BIGINT AUTO_INCREMENT PRIMARY KEY,
            product_id BIGINT NOT NULL,
            channel VARCHAR(32) NOT NULL DEFAULT 'almamed',
            kit_id BIGINT NULL,
            field VARCHAR(64) NOT NULL,
            old_value VARCHAR(512) NULL,
            new_value VARCHAR(512) NULL,
            action VARCHAR(32) NOT NULL DEFAULT 'set',
            source VARCHAR(32) NOT NULL DEFAULT 'ui',
            changed_by_user_id INT NULL,
            changed_by_name VARCHAR(255) NULL,
            note VARCHAR(512) NULL,
            changed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            INDEX idx_np_log_product (product_id, changed_at),
            INDEX idx_np_log_user (changed_by_user_id),
            INDEX idx_np_log_action (action)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await ensureColumn(db, 'dg_new_products', 'manager_checked', 'TINYINT(1) NOT NULL DEFAULT 0');
    await ensureColumn(db, 'dg_new_products', 'manager_checked_at', 'DATETIME NULL');
    await ensureColumn(db, 'dg_new_products', 'manager_checked_by_user_id', 'INT NULL');
    await ensureColumn(db, 'dg_new_products', 'manager_comment', 'TEXT NULL');
    schemaReady = true;
}

function actorDisplayName(actor) {
    if (!actor) return '';
    const name = String(actor.full_name || actor.username || '').trim();
    if (name) return name;
    if (actor.id != null && Number.isFinite(Number(actor.id))) return 'user#' + Number(actor.id);
    return '';
}

function clipLogVal(v) {
    if (v == null || v === '') return null;
    const s = String(v);
    return s.length > 512 ? s.slice(0, 509) + '…' : s;
}

function formatFieldForLog(field, value, channel) {
    if (field === 'manager_checked') {
        return truthyFlag(value) ? 'Да' : 'Нет';
    }
    if (value == null || value === '') return null;
    if (field === 'priority') return PRIORITY_LABELS[value] || String(value);
    if (field === 'status') {
        if (channel === 'marketplaces') {
            return markets.MARKETS_STATUS_LABELS[value] || STATUS_LABELS[value] || String(value);
        }
        return STATUS_LABELS[value] || String(value);
    }
    if (field === 'infographic') {
        return markets.INFOGRAPHIC_LABELS[value] || String(value);
    }
    if (field === 'huckster') {
        return markets.HUCKSTER_LABELS[value] || String(value);
    }
    if (field === 'photo') {
        return markets.PHOTO_LABELS[value] || String(value);
    }
    if (field === 'sell_on_markets' || field === 'has_kits' || String(field).startsWith('placement_')) {
        const on = value === true || value === 1 || String(value) === '1';
        return on ? 'да' : 'нет';
    }
    if (
        field === 'price_almamed' ||
        field === 'price_markets' ||
        field === 'length_cm' ||
        field === 'width_cm' ||
        field === 'height_cm' ||
        field === 'weight_kg'
    ) {
        const n = Number(value);
        if (!Number.isFinite(n)) return clipLogVal(value);
        if (Math.abs(n - Math.round(n)) < 1e-9) return String(Math.round(n));
        return String(Number.parseFloat(n.toFixed(4)));
    }
    if (value instanceof Date) {
        try {
            return value.toISOString().slice(0, 19).replace('T', ' ');
        } catch (_) {
            return clipLogVal(value);
        }
    }
    if (typeof value === 'object' && value && Object.prototype.toString.call(value) === '[object Date]') {
        return clipLogVal(value);
    }
    // MySQL datetime strings
    if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value) && value.includes('T') === false) {
        return clipLogVal(value.slice(0, 19));
    }
    return clipLogVal(value);
}

function valuesEqualForLog(field, a, b) {
    if (a == null && b == null) return true;
    if (a == null || b == null) {
        const ae = a == null || a === '';
        const be = b == null || b === '';
        if (ae && be) return true;
        if (ae !== be) return false;
    }
    if (
        field === 'sell_on_markets' ||
        field === 'has_kits' ||
        String(field).startsWith('placement_')
    ) {
        const an = a === true || a === 1 || String(a) === '1' ? 1 : 0;
        const bn = b === true || b === 1 || String(b) === '1' ? 1 : 0;
        return an === bn;
    }
    if (
        field === 'price_almamed' ||
        field === 'price_markets' ||
        field === 'length_cm' ||
        field === 'width_cm' ||
        field === 'height_cm' ||
        field === 'weight_kg' ||
        field === 'product_manager_user_id' ||
        field === 'responsible_user_id'
    ) {
        const an = a == null || a === '' ? null : Number(a);
        const bn = b == null || b === '' ? null : Number(b);
        if (an == null && bn == null) return true;
        if (an == null || bn == null) return false;
        return Math.abs(an - bn) < 1e-9;
    }
    return String(a ?? '').trim() === String(b ?? '').trim();
}

async function insertProductLog(db, opts) {
    const productId = Number(opts.productId);
    if (!Number.isFinite(productId) || productId < 1) return;
    const field = String(opts.field || '').trim();
    if (!field) return;
    const actor = opts.actor || null;
    const uid = actor && actor.id != null ? Number(actor.id) : null;
    const uname = actorDisplayName(actor) || null;
    await db.query(
        `INSERT INTO dg_new_products_log
            (product_id, channel, kit_id, field, old_value, new_value, action, source,
             changed_by_user_id, changed_by_name, note)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            productId,
            String(opts.channel || 'almamed').slice(0, 32),
            opts.kitId != null && Number.isFinite(Number(opts.kitId)) ? Number(opts.kitId) : null,
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

async function logProductFieldChanges(db, { productId, channel, before, fields, actor, source }) {
    if (!fields || !Object.keys(fields).length) return;
    const ch = channel || (before && before.channel) || 'almamed';
    for (const key of Object.keys(fields)) {
        if (SKIP_LOG_FIELDS.has(key)) continue;
        const oldRaw = before ? before[key] : null;
        const newRaw = fields[key];
        if (valuesEqualForLog(key, oldRaw, newRaw)) continue;
        let oldDisp = formatFieldForLog(key, oldRaw, ch);
        let newDisp = formatFieldForLog(key, newRaw, ch);
        // Для менеджера/ответственного показываем имя, а не только id
        if (key === 'product_manager_user_id') {
            oldDisp = clipLogVal((before && before.product_manager_name) || oldDisp);
            newDisp = clipLogVal(fields.product_manager_name || newDisp);
        }
        if (key === 'responsible_user_id') {
            oldDisp = clipLogVal((before && before.responsible_name) || oldDisp);
            newDisp = clipLogVal(fields.responsible_name || newDisp);
        }
        await insertProductLog(db, {
            productId,
            channel: ch,
            field: key,
            oldValue: oldDisp,
            newValue: newDisp,
            action: 'set',
            source: source || 'ui',
            actor,
        });
    }
}

function normChannel(v) {
    const s = String(v || 'almamed').trim().toLowerCase();
    return CHANNELS.has(s) ? s : 'almamed';
}

function normPriority(v) {
    const s = String(v || 'normal').trim().toLowerCase();
    return PRIORITIES.has(s) ? s : 'normal';
}

function normStatus(v) {
    const s = String(v || 'new').trim().toLowerCase();
    return STATUSES.has(s) ? s : null;
}

function clip(s, max) {
    const t = String(s == null ? '' : s).trim();
    if (!max || t.length <= max) return t;
    return t.slice(0, max);
}

function parsePrice(v) {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(String(v).replace(/\s/g, '').replace(',', '.'));
    return Number.isFinite(n) ? n : null;
}

function getMissingRequired(row, channel) {
    if (channel === 'marketplaces') return markets.getMissingRequiredMarkets(row);
    const missing = [];
    if (!String(row.article || '').trim()) missing.push({ key: 'article', label: 'Артикул' });
    if (!String(row.title || '').trim()) missing.push({ key: 'title', label: 'Название' });
    if (row.price_almamed == null || !Number.isFinite(Number(row.price_almamed))) {
        missing.push({ key: 'price_almamed', label: 'Цена Альмамед' });
    }
    if (!String(row.supplier_url || '').trim()) {
        missing.push({ key: 'supplier_url', label: 'Ссылка на сайт поставщика' });
    }
    if (!PRIORITIES.has(String(row.priority || '').trim().toLowerCase())) {
        missing.push({ key: 'priority', label: 'Приоритет' });
    }
    return missing;
}

/**
 * Авто-переход только между new ↔ not_added (Альмамед).
 */
function resolveAutoStatus(currentStatus, mergedRow, channel) {
    if (channel === 'marketplaces') {
        return markets.resolveMarketsStatus(currentStatus, mergedRow);
    }
    const st = String(currentStatus || 'new');
    if (!AUTO_STATUSES.has(st)) {
        return { status: st, changed: false, missing: getMissingRequired(mergedRow, channel) };
    }
    const missing = getMissingRequired(mergedRow, channel);
    const next = missing.length ? 'new' : 'not_added';
    return { status: next, changed: next !== st, missing };
}

async function resolveUserLabel(db, userId) {
    if (userId == null) return { id: null, name: null };
    const id = parseInt(userId, 10);
    if (!Number.isFinite(id) || id < 1) return { id: null, name: null };
    const [rows] = await db.query(
        `SELECT id, username, full_name, COALESCE(is_archived, 0) AS is_archived
           FROM users WHERE id = ? LIMIT 1`,
        [id]
    );
    if (!rows.length) return { id: null, name: null };
    const u = rows[0];
    const base = String(u.full_name || u.username || '').trim() || String(u.username);
    const name = Number(u.is_archived) === 1 ? `${base} (архивный)` : base;
    return { id: Number(u.id), name };
}

function mapRow(r) {
    const channel = r.channel || 'almamed';
    const missing = getMissingRequired(r, channel);
    return {
        id: Number(r.id),
        channel_num: r.channel_num != null ? Number(r.channel_num) : Number(r.id),
        channel,
        product_manager_user_id: r.product_manager_user_id != null ? Number(r.product_manager_user_id) : null,
        product_manager_name: r.product_manager_name || '',
        responsible_user_id: r.responsible_user_id != null ? Number(r.responsible_user_id) : null,
        responsible_name: r.responsible_name || '',
        sell_on_markets: Number(r.sell_on_markets) === 1,
        has_kits: Number(r.has_kits) === 1,
        kits: Array.isArray(r.kits) ? r.kits : [],
        article: r.article || '',
        title: r.title || '',
        price_almamed: r.price_almamed != null ? Number(r.price_almamed) : null,
        supplier_url: r.supplier_url || '',
        brand: r.brand || '',
        product_code: r.product_code || '',
        barcode: r.barcode || '',
        price_markets: r.price_markets != null ? Number(r.price_markets) : null,
        dimensions_text: r.dimensions_text || markets.formatDimensions(r),
        length_cm: r.length_cm != null ? Number(r.length_cm) : null,
        width_cm: r.width_cm != null ? Number(r.width_cm) : null,
        height_cm: r.height_cm != null ? Number(r.height_cm) : null,
        weight_kg: r.weight_kg != null ? Number(r.weight_kg) : null,
        vat: r.vat || '',
        ru_url: r.ru_url || '',
        placement_ozon: Number(r.placement_ozon) === 1,
        placement_wb: Number(r.placement_wb) === 1,
        placement_ym: Number(r.placement_ym) === 1,
        placement_ozon_url: r.placement_ozon_url || '',
        placement_wb_url: r.placement_wb_url || '',
        placement_ym_url: r.placement_ym_url || '',
        placement_ozon_at: r.placement_ozon_at || null,
        placement_wb_at: r.placement_wb_at || null,
        placement_ym_at: r.placement_ym_at || null,
        placement_date: r.placement_date || null,
        infographic: r.infographic || '',
        infographic_label: markets.INFOGRAPHIC_LABELS[r.infographic] || '',
        photo: r.photo || '',
        photo_label: markets.PHOTO_LABELS[r.photo] || '',
        huckster: r.huckster || '',
        huckster_label: markets.HUCKSTER_LABELS[r.huckster] || '',
        huckster_added: String(r.huckster || '') === 'yes',
        manager_checked: Number(r.manager_checked) === 1,
        manager_checked_at: r.manager_checked_at || null,
        manager_checked_by_user_id:
            r.manager_checked_by_user_id != null ? Number(r.manager_checked_by_user_id) : null,
        manager_comment: r.manager_comment || '',
        source_almamed_id: r.source_almamed_id != null ? Number(r.source_almamed_id) : null,
        markets_product_id: r.markets_product_id != null ? Number(r.markets_product_id) : null,
        markets_channel_num: r.markets_channel_num != null ? Number(r.markets_channel_num) : null,
        source_almamed_channel_num:
            r.source_almamed_channel_num != null ? Number(r.source_almamed_channel_num) : null,
        priority: r.priority,
        priority_label: PRIORITY_LABELS[r.priority] || r.priority,
        status: r.status,
        status_label:
            channel === 'marketplaces'
                ? markets.MARKETS_STATUS_LABELS[r.status] || STATUS_LABELS[r.status] || r.status
                : STATUS_LABELS[r.status] || r.status,
        comment: r.comment || '',
        almamed_added_at: r.almamed_added_at || null,
        almamed_url: r.almamed_url || '',
        ms_product_uuid: r.ms_product_uuid || '',
        transferred_at: r.transferred_at || null,
        created_at: r.created_at || null,
        updated_at: r.updated_at || null,
        created_by_user_id: r.created_by_user_id != null ? Number(r.created_by_user_id) : null,
        missing_required: missing,
        placement_ready: missing.length === 0,
    };
}

module.exports = function exportsNewProductsRouterFactory(db, config) {
    const router = express.Router();

    router.get('/meta', async (_req, res) => {
        try {
            await ensureSchema(db);
            res.json({
                success: true,
                channels: [
                    { key: 'almamed', label: 'Альмамед' },
                    { key: 'marketplaces', label: 'Размещение на маркеты' },
                ],
                priorities: Object.keys(PRIORITY_LABELS).map((k) => ({ key: k, label: PRIORITY_LABELS[k] })),
                statuses: Object.keys(STATUS_LABELS)
                    .filter((k) => k !== 'transferred' && k !== 'removed')
                    .map((k) => ({ key: k, label: STATUS_LABELS[k] })),
                statuses_almamed: [
                    'new',
                    'not_added',
                    'in_progress',
                    'added',
                    'revision',
                    'review',
                    'verified',
                ].map((k) => ({ key: k, label: STATUS_LABELS[k] })),
                statuses_marketplaces: [
                    'new',
                    'not_added',
                    'in_progress',
                    'added',
                    'revision',
                    'review',
                    'verified',
                    'not_cooperate',
                    'in_bundle',
                ].map((k) => ({ key: k, label: markets.MARKETS_STATUS_LABELS[k] || STATUS_LABELS[k] })),
                required_fields: REQUIRED_KEYS,
                required_fields_marketplaces: markets.MARKETS_REQUIRED,
                infographic_options: Object.keys(markets.INFOGRAPHIC_LABELS).map((k) => ({
                    key: k,
                    label: markets.INFOGRAPHIC_LABELS[k],
                })),
                huckster_options: Object.keys(markets.HUCKSTER_LABELS).map((k) => ({
                    key: k,
                    label: markets.HUCKSTER_LABELS[k],
                })),
                photo_options: Object.keys(markets.PHOTO_LABELS).map((k) => ({
                    key: k,
                    label: markets.PHOTO_LABELS[k],
                })),
            });
        } catch (e) {
            res.status(500).json({ error: e.message || 'Ошибка meta' });
        }
    });

    router.get('/assignees', async (_req, res) => {
        try {
            await ensureSchema(db);
            const mapUser = (u) => {
                const label = String(u.full_name || u.username || '').trim() || String(u.username);
                return {
                    id: Number(u.id),
                    username: u.username,
                    full_name: u.full_name || '',
                    label,
                    specialty_id: u.specialty_id != null ? Number(u.specialty_id) : null,
                    specialty_name: u.specialty_name || '',
                    is_admin: u.username === 'admin',
                };
            };

            const [managers] = await db.query(
                `SELECT u.id, u.username, u.full_name, u.specialty_id, s.name AS specialty_name,
                        COALESCE(u.is_archived, 0) AS is_archived
                   FROM users u
                   INNER JOIN specialties s ON s.id = u.specialty_id
                  WHERE COALESCE(u.is_archived, 0) = 0
                    AND LOWER(TRIM(s.name)) = LOWER(?)
                  ORDER BY COALESCE(NULLIF(TRIM(u.full_name), ''), u.username) ASC`,
                ['Менеджер маркетплейсов']
            );

            // Ответственный: только специальность «Контент-Менеджер»
            const [responsibles] = await db.query(
                `SELECT u.id, u.username, u.full_name, u.specialty_id, s.name AS specialty_name,
                        COALESCE(u.is_archived, 0) AS is_archived
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
                managers: managersMapped,
                responsibles: responsiblesMapped,
                // back-compat: раньше UI брал всех из data
                data: managersMapped,
            });
        } catch (e) {
            res.status(500).json({ error: e.message || 'Ошибка assignees' });
        }
    });

    router.get('/', async (req, res) => {
        try {
            await ensureSchema(db);
            const channel = normChannel(req.query.channel);
            const search = String(req.query.search || '').trim();
            const status = String(req.query.status || '').trim();
            const priority = String(req.query.priority || '').trim();
            const brand = String(req.query.brand || '').trim();
            const responsible = String(req.query.responsible || '').trim();
            const manager = String(req.query.manager || '').trim();

            let limit = parseInt(req.query.limit, 10);
            if (!Number.isFinite(limit) || limit < 1) limit = 100;
            if (limit > 500) limit = 500;
            let offset = parseInt(req.query.offset, 10);
            if (!Number.isFinite(offset) || offset < 0) offset = 0;

            let sortBy = String(req.query.sort_by || 'priority').trim();
            if (!SORT_KEYS.has(sortBy)) sortBy = 'priority';
            const sortDesc = String(req.query.sort_dir || 'asc').toLowerCase() === 'desc';

            const where = ['channel = ?'];
            const params = [channel];

            if (status && STATUSES.has(status)) {
                where.push('status = ?');
                params.push(status);
            } else if (channel === 'marketplaces') {
                where.push("status <> 'removed'");
            } else {
                // переданные в МС и удалённые не показываем в очереди Альмамед
                where.push("status <> 'transferred'");
                where.push("status <> 'removed'");
            }
            if (priority && PRIORITIES.has(priority)) {
                where.push('priority = ?');
                params.push(priority);
            }
            if (brand) {
                where.push('brand LIKE ?');
                params.push(`%${brand}%`);
            }
            if (responsible === 'none') {
                where.push('responsible_user_id IS NULL');
            } else if (responsible) {
                const rid = parseInt(responsible, 10);
                if (Number.isFinite(rid) && rid > 0) {
                    where.push('responsible_user_id = ?');
                    params.push(rid);
                }
            }
            if (manager === 'none') {
                where.push('product_manager_user_id IS NULL');
            } else if (manager) {
                const mid = parseInt(manager, 10);
                if (Number.isFinite(mid) && mid > 0) {
                    where.push('product_manager_user_id = ?');
                    params.push(mid);
                }
            }
            if (search) {
                const idNum = parseInt(String(search).replace(/^id:\s*/i, '').trim(), 10);
                if (Number.isFinite(idNum) && idNum > 0 && String(search).trim().match(/^(id:\s*)?\d+$/i)) {
                    where.push('(channel_num = ? OR id = ?)');
                    params.push(idNum, idNum);
                } else {
                    where.push(
                        `(title LIKE ? OR article LIKE ? OR brand LIKE ? OR supplier_url LIKE ? OR comment LIKE ? OR COALESCE(manager_comment,'') LIKE ? OR product_manager_name LIKE ? OR responsible_name LIKE ? OR COALESCE(product_code,'') LIKE ? OR COALESCE(barcode,'') LIKE ? OR COALESCE(ru_url,'') LIKE ? OR CAST(COALESCE(channel_num, id) AS CHAR) LIKE ?)`
                    );
                    const like = `%${search}%`;
                    params.push(like, like, like, like, like, like, like, like, like, like, like, like);
                }
            }

            const whereSql = where.join(' AND ');
            let orderSql;
            if (sortBy === 'priority') {
                orderSql = `${PRIORITY_ORDER_SQL} ${sortDesc ? 'DESC' : 'ASC'}, COALESCE(channel_num, id) DESC`;
            } else if (sortBy === 'id') {
                orderSql = `COALESCE(channel_num, id) ${sortDesc ? 'DESC' : 'ASC'}, id DESC`;
            } else {
                orderSql = `\`${sortBy}\` ${sortDesc ? 'DESC' : 'ASC'}, COALESCE(channel_num, id) DESC`;
            }

            const [[cnt]] = await db.query(
                `SELECT COUNT(*) AS total FROM dg_new_products WHERE ${whereSql}`,
                params
            );
            const [rows] = await db.query(
                `SELECT * FROM dg_new_products WHERE ${whereSql} ORDER BY ${orderSql} LIMIT ? OFFSET ?`,
                [...params, limit, offset]
            );

            const mapped = (rows || []).map(mapRow);
            await markets.attachKitsToMapped(db, mapped);
            await markets.attachCrossChannelLinks(db, mapped);
            await markets.attachPresenceBadges(db, mapped);
            await markets.stampAlmamedAddedAtFromPresence(db, mapped);
            // Не зовём enrichMarketsRowsFromMs на GET списка: N×SQL + UPDATE/лог на каждую
            // недозаполненную строку маркетов держали ответ 30–60+ с («вечная Загрузка…»).
            // Обогащение из МС — на sync-markets-queue / точечных PATCH / upsert из Альмамед.
            const incomplete = mapped.filter((r) => r.missing_required && r.missing_required.length).length;

            res.json({
                success: true,
                data: mapped,
                total: Number(cnt?.total || 0),
                limit,
                offset,
                channel,
                incomplete_count: incomplete,
                required_fields: channel === 'marketplaces' ? markets.MARKETS_REQUIRED : REQUIRED_KEYS,
                can_edit_huckster: actorCanEditHuckster(req.datagonActor),
                can_set_verified: actorCanSetVerified(req.datagonActor),
                applied_filters: {
                    search,
                    status: status || '',
                    priority: priority || '',
                    brand,
                    responsible,
                    manager,
                },
                sort_by: sortBy,
                sort_dir: sortDesc ? 'desc' : 'asc',
            });
        } catch (e) {
            console.error('[new-products] GET /', e);
            res.status(500).json({ error: e.message || 'Ошибка списка' });
        }
    });

    router.post('/', async (req, res) => {
        try {
            await ensureSchema(db);
            const body = req.body && typeof req.body === 'object' ? req.body : {};
            const channel = normChannel(body.channel);
            const title = clip(body.title, 128);
            const comment = clip(body.comment, 65535);

            let status = normStatus(body.status) || 'new';
            if (channel === 'marketplaces') {
                if (!markets.MARKETS_STATUSES.has(status) || status === 'removed') status = 'new';
            } else if (!AUTO_STATUSES.has(status) && status !== 'in_progress') {
                status = 'new';
            }

            const manager = await resolveUserLabel(db, body.product_manager_user_id);
            const responsible = await resolveUserLabel(db, body.responsible_user_id);
            const actor = req.datagonActor;

            const draft = {
                article: clip(body.article, 128) || null,
                title,
                price_almamed: parsePrice(body.price_almamed),
                supplier_url: clip(body.supplier_url, 2048) || null,
                priority: normPriority(body.priority),
                product_code: clip(body.product_code, 128) || null,
                barcode: clip(body.barcode, 512) || null,
                price_markets: parsePrice(body.price_markets),
                dimensions_text: clip(body.dimensions_text, 512) || null,
                length_cm: markets.parseNum(body.length_cm),
                width_cm: markets.parseNum(body.width_cm),
                height_cm: markets.parseNum(body.height_cm),
                weight_kg: markets.parseNum(body.weight_kg),
                vat: clip(body.vat, 64) || null,
                ru_url: clip(body.ru_url, 2048) || null,
                comment: comment || null,
                placement_ozon: 0,
                placement_wb: 0,
                placement_ym: 0,
            };
            const auto = resolveAutoStatus(status, draft, channel);
            status = auto.status;
            if (channel === 'marketplaces' && status === 'revision' && !comment) {
                return res.status(400).json({ error: 'Для статуса «На доработке» нужен комментарий' });
            }
            if (channel !== 'marketplaces' && status === 'revision' && !comment) {
                return res.status(400).json({ error: 'Для статуса «На доработке» нужен комментарий' });
            }

            let almamedAddedAt = null;
            if (status === 'added') almamedAddedAt = new Date();

            const channelNum = await markets.allocChannelNum(db, channel);
            const [ins] = await db.query(
                `INSERT INTO dg_new_products (
                    channel, channel_num, product_manager_user_id, product_manager_name,
                    responsible_user_id, responsible_name, article, title, price_almamed,
                    supplier_url, brand, priority, status, comment, almamed_added_at, almamed_url,
                    product_code, barcode, price_markets, dimensions_text, length_cm, width_cm, height_cm, weight_kg,
                    vat, ru_url, created_by_user_id
                 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    channel,
                    channelNum,
                    manager.id,
                    manager.name,
                    responsible.id,
                    responsible.name,
                    draft.article,
                    title,
                    draft.price_almamed,
                    draft.supplier_url,
                    clip(body.brand, 255) || null,
                    draft.priority,
                    status,
                    comment || null,
                    almamedAddedAt,
                    clip(body.almamed_url, 2048) || null,
                    draft.product_code,
                    draft.barcode,
                    draft.price_markets,
                    draft.dimensions_text,
                    draft.length_cm,
                    draft.width_cm,
                    draft.height_cm,
                    draft.weight_kg,
                    draft.vat,
                    draft.ru_url,
                    actor && actor.id != null ? Number(actor.id) : null,
                ]
            );

            const [[row]] = await db.query('SELECT * FROM dg_new_products WHERE id = ? LIMIT 1', [ins.insertId]);
            try {
                await insertProductLog(db, {
                    productId: ins.insertId,
                    channel,
                    field: '_row',
                    oldValue: null,
                    newValue: clipLogVal(row.title || row.article || '#' + ins.insertId),
                    action: 'create',
                    source: 'ui',
                    actor,
                });
            } catch (le) {
                console.warn('[new-products] create log', le);
            }
            const mapped = mapRow(row);
            res.json({
                success: true,
                data: mapped,
                missing_required: mapped.missing_required,
                auto_status_changed: auto.changed,
            });
        } catch (e) {
            console.error('[new-products] POST /', e);
            res.status(500).json({ error: e.message || 'Ошибка создания' });
        }
    });

    /**
     * Массовое добавление: строки «артикул;название» (разделитель — первая `;`).
     * Body: { channel, text } или { channel, lines: [{article,title},…] }.
     */
    router.post('/bulk', async (req, res) => {
        const t0 = Date.now();
        try {
            await ensureSchema(db);
            const body = req.body && typeof req.body === 'object' ? req.body : {};
            const channel = normChannel(body.channel);
            const actor = req.datagonActor;
            const MAX_LINES = 500;

            const parsed = [];
            const errors = [];
            let rawLines = [];
            if (Array.isArray(body.lines)) {
                rawLines = body.lines.map((x, i) => {
                    if (x && typeof x === 'object') {
                        return {
                            lineNo: i + 1,
                            article: String(x.article || '').trim(),
                            title: String(x.title || '').trim(),
                        };
                    }
                    return { lineNo: i + 1, raw: String(x == null ? '' : x) };
                });
            } else {
                const text = String(body.text != null ? body.text : body.urls_text || '');
                text.split(/\r?\n/).forEach((line, i) => {
                    rawLines.push({ lineNo: i + 1, raw: line });
                });
            }

            for (const item of rawLines) {
                if (parsed.length >= MAX_LINES) {
                    errors.push({
                        line: item.lineNo,
                        error: `Лимит ${MAX_LINES} строк за один запрос`,
                    });
                    break;
                }
                let article = '';
                let title = '';
                if (item.article != null || item.title != null) {
                    article = clip(item.article, 128);
                    title = clip(item.title, 128);
                } else {
                    const raw = String(item.raw || '').trim();
                    if (!raw || raw.startsWith('#')) continue;
                    const sep = raw.indexOf(';');
                    if (sep < 0) {
                        errors.push({
                            line: item.lineNo,
                            code: raw.slice(0, 64),
                            error: 'Нет разделителя «;» (формат: артикул;название)',
                        });
                        continue;
                    }
                    article = clip(raw.slice(0, sep).trim(), 128);
                    title = clip(raw.slice(sep + 1).trim(), 128);
                }
                if (!article) {
                    errors.push({ line: item.lineNo, error: 'Пустой артикул' });
                    continue;
                }
                if (!title) {
                    errors.push({
                        line: item.lineNo,
                        code: article,
                        error: 'Пустое название после «;»',
                    });
                    continue;
                }
                parsed.push({ lineNo: item.lineNo, article, title });
            }

            if (!parsed.length) {
                return res.status(400).json({
                    success: false,
                    error: 'Нет корректных строк для добавления',
                    total: rawLines.length,
                    created: 0,
                    skipped: errors.length,
                    errors: errors.slice(0, 20),
                    duration_sec: Math.round((Date.now() - t0) / 1000),
                });
            }

            let created = 0;
            const createdIds = [];
            for (const row of parsed) {
                try {
                    const status = 'new';
                    const channelNum = await markets.allocChannelNum(db, channel);
                    const [ins] = await db.query(
                        `INSERT INTO dg_new_products (
                            channel, channel_num, product_manager_user_id, product_manager_name,
                            responsible_user_id, responsible_name, article, title, price_almamed,
                            supplier_url, brand, priority, status, comment, almamed_added_at, almamed_url,
                            product_code, barcode, price_markets, dimensions_text, length_cm, width_cm, height_cm, weight_kg,
                            vat, ru_url, created_by_user_id
                         ) VALUES (?, ?, NULL, NULL, NULL, NULL, ?, ?, NULL, NULL, NULL, 'normal', ?, NULL, NULL, NULL,
                            NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?)`,
                        [
                            channel,
                            channelNum,
                            row.article,
                            row.title,
                            status,
                            actor && actor.id != null ? Number(actor.id) : null,
                        ]
                    );
                    created += 1;
                    createdIds.push(ins.insertId);
                    try {
                        await insertProductLog(db, {
                            productId: ins.insertId,
                            channel,
                            field: '_row',
                            oldValue: null,
                            newValue: clipLogVal(row.title || row.article || '#' + ins.insertId),
                            action: 'create',
                            source: 'bulk',
                            actor,
                            note: 'Массовое добавление',
                        });
                    } catch (le) {
                        console.warn('[new-products] bulk create log', le);
                    }
                } catch (ie) {
                    errors.push({
                        line: row.lineNo,
                        code: row.article,
                        error: (ie && ie.message) || 'Ошибка вставки',
                    });
                }
            }

            const durationSec = Math.round((Date.now() - t0) / 1000);
            res.json({
                success: true,
                channel,
                total: parsed.length,
                to_create: parsed.length,
                created,
                skipped: errors.length,
                created_ids: createdIds.slice(0, 50),
                errors: errors.slice(0, 20),
                duration_sec: durationSec,
                dry_run: false,
            });
        } catch (e) {
            console.error('[new-products] POST /bulk', e);
            res.status(500).json({ error: e.message || 'Ошибка массового добавления' });
        }
    });

    router.patch('/:id', async (req, res) => {
        try {
            await ensureSchema(db);
            const id = parseInt(req.params.id, 10);
            if (!Number.isFinite(id) || id < 1) return res.status(400).json({ error: 'Некорректный id' });

            const [[cur]] = await db.query('SELECT * FROM dg_new_products WHERE id = ? LIMIT 1', [id]);
            if (!cur) return res.status(404).json({ error: 'Запись не найдена' });
            if (cur.status === 'transferred' || cur.status === 'removed') {
                return res.status(400).json({ error: 'Запись уже закрыта и не редактируется' });
            }

            const body = req.body && typeof req.body === 'object' ? req.body : {};
            const channel = cur.channel === 'marketplaces' ? 'marketplaces' : 'almamed';
            const fields = {};

            if ('title' in body) fields.title = clip(body.title, 128);
            if ('article' in body) fields.article = clip(body.article, 128) || null;
            if ('price_almamed' in body) fields.price_almamed = parsePrice(body.price_almamed);
            if ('supplier_url' in body) fields.supplier_url = clip(body.supplier_url, 2048) || null;
            if ('brand' in body) fields.brand = clip(body.brand, 255) || null;
            if ('priority' in body) fields.priority = normPriority(body.priority);
            if ('almamed_url' in body) fields.almamed_url = clip(body.almamed_url, 2048) || null;
            if ('comment' in body) fields.comment = clip(body.comment, 65535) || null;
            if ('manager_comment' in body) {
                fields.manager_comment = clip(body.manager_comment, 65535) || null;
            }
            if ('sell_on_markets' in body && channel === 'almamed') {
                fields.sell_on_markets =
                    body.sell_on_markets === true ||
                    body.sell_on_markets === 1 ||
                    String(body.sell_on_markets) === '1'
                        ? 1
                        : 0;
            }
            if ('has_kits' in body && channel === 'almamed') {
                fields.has_kits =
                    body.has_kits === true || body.has_kits === 1 || String(body.has_kits) === '1' ? 1 : 0;
            }
            if ('product_code' in body) fields.product_code = clip(body.product_code, 128) || null;
            if ('barcode' in body) fields.barcode = clip(body.barcode, 512) || null;
            if ('price_markets' in body) fields.price_markets = parsePrice(body.price_markets);
            if ('dimensions_text' in body) fields.dimensions_text = clip(body.dimensions_text, 512) || null;
            if ('length_cm' in body) fields.length_cm = markets.parseNum(body.length_cm);
            if ('width_cm' in body) fields.width_cm = markets.parseNum(body.width_cm);
            if ('height_cm' in body) fields.height_cm = markets.parseNum(body.height_cm);
            if ('weight_kg' in body) fields.weight_kg = markets.parseNum(body.weight_kg);
            if ('vat' in body) fields.vat = clip(body.vat, 64) || null;
            if ('ru_url' in body) fields.ru_url = clip(body.ru_url, 2048) || null;
            if ('infographic' in body && channel === 'marketplaces') {
                if (body.infographic == null || body.infographic === '') {
                    fields.infographic = null;
                } else {
                    const ig = markets.normInfographic(body.infographic);
                    if (!ig) return res.status(400).json({ error: 'Некорректное значение «Инфографика»' });
                    fields.infographic = ig;
                }
            }
            if ('photo' in body && channel === 'marketplaces') {
                if (body.photo == null || body.photo === '') {
                    fields.photo = null;
                } else {
                    const ph = markets.normPhoto(body.photo);
                    if (!ph) return res.status(400).json({ error: 'Некорректное значение «Фото»' });
                    fields.photo = ph;
                }
            }
            if ('huckster' in body && channel === 'marketplaces') {
                if (!actorCanEditHuckster(req.datagonActor)) {
                    return res.status(403).json({
                        error: 'Менять «Huckster» может только менеджер маркетплейсов',
                        code: 'HUCKSTER_FORBIDDEN',
                    });
                }
                if (body.huckster == null || body.huckster === '') {
                    fields.huckster = null;
                } else {
                    const hk = markets.normHuckster(body.huckster);
                    if (!hk) return res.status(400).json({ error: 'Некорректное значение «Huckster»' });
                    fields.huckster = hk;
                }
            }

            if (
                !('dimensions_text' in body) &&
                ('length_cm' in fields || 'width_cm' in fields || 'height_cm' in fields || 'weight_kg' in fields)
            ) {
                const dimMerged = {
                    length_cm: 'length_cm' in fields ? fields.length_cm : cur.length_cm,
                    width_cm: 'width_cm' in fields ? fields.width_cm : cur.width_cm,
                    height_cm: 'height_cm' in fields ? fields.height_cm : cur.height_cm,
                    weight_kg: 'weight_kg' in fields ? fields.weight_kg : cur.weight_kg,
                };
                fields.dimensions_text = markets.formatDimensions(dimMerged) || null;
            }

            if ('product_manager_user_id' in body) {
                const m = await resolveUserLabel(db, body.product_manager_user_id);
                fields.product_manager_user_id = m.id;
                fields.product_manager_name = m.name;
            }
            if ('responsible_user_id' in body) {
                const r = await resolveUserLabel(db, body.responsible_user_id);
                fields.responsible_user_id = r.id;
                fields.responsible_name = r.name;
            }

            let nextStatus = cur.status;
            let statusExplicit = false;
            if ('status' in body) {
                const st = normStatus(body.status);
                if (!st || st === 'transferred' || st === 'removed') {
                    return res.status(400).json({ error: 'Некорректный статус' });
                }
                if (channel === 'marketplaces' && !markets.MARKETS_STATUSES.has(st)) {
                    return res.status(400).json({ error: 'Некорректный статус для маркетов' });
                }
                if (st === 'verified') {
                    if (!actorCanSetVerified(req.datagonActor)) {
                        return res.status(403).json({
                            error: 'Статус «Проверен» может поставить только проверка контента (admin / Полный доступ)',
                            code: 'VERIFIED_FORBIDDEN',
                        });
                    }
                    const mgrOk =
                        'manager_checked' in fields
                            ? Number(fields.manager_checked) === 1
                            : Number(cur.manager_checked) === 1;
                    if (!mgrOk) {
                        return res.status(400).json({
                            error: 'Сначала нужна галочка «Проверено менеджером»',
                            code: 'MANAGER_CHECK_REQUIRED',
                        });
                    }
                }
                nextStatus = st;
                statusExplicit = true;
                fields.status = st;
            }

            const merged = {
                ...cur,
                ...fields,
                article: 'article' in fields ? fields.article : cur.article,
                title: 'title' in fields ? fields.title : cur.title,
                price_almamed: 'price_almamed' in fields ? fields.price_almamed : cur.price_almamed,
                supplier_url: 'supplier_url' in fields ? fields.supplier_url : cur.supplier_url,
                priority: 'priority' in fields ? fields.priority : cur.priority,
                comment: 'comment' in fields ? fields.comment : cur.comment,
                product_code: 'product_code' in fields ? fields.product_code : cur.product_code,
                barcode: 'barcode' in fields ? fields.barcode : cur.barcode,
                price_markets: 'price_markets' in fields ? fields.price_markets : cur.price_markets,
                dimensions_text: 'dimensions_text' in fields ? fields.dimensions_text : cur.dimensions_text,
                length_cm: 'length_cm' in fields ? fields.length_cm : cur.length_cm,
                width_cm: 'width_cm' in fields ? fields.width_cm : cur.width_cm,
                height_cm: 'height_cm' in fields ? fields.height_cm : cur.height_cm,
                weight_kg: 'weight_kg' in fields ? fields.weight_kg : cur.weight_kg,
                vat: 'vat' in fields ? fields.vat : cur.vat,
                ru_url: 'ru_url' in fields ? fields.ru_url : cur.ru_url,
                placement_ozon: cur.placement_ozon,
                placement_wb: cur.placement_wb,
                placement_ym: cur.placement_ym,
                manager_checked:
                    'manager_checked' in fields ? fields.manager_checked : cur.manager_checked,
            };

            if (channel === 'marketplaces') {
                // Ручные lock-статусы сохраняем при явном выборе; иначе полный авто-пересчёт
                const locked = markets.MANUAL_LOCK_STATUSES.has(String(statusExplicit ? nextStatus : cur.status));
                if (!locked || !statusExplicit) {
                    if (!(statusExplicit && markets.MANUAL_LOCK_STATUSES.has(nextStatus))) {
                        const auto = resolveAutoStatus(statusExplicit ? nextStatus : cur.status, merged, channel);
                        nextStatus = auto.status;
                        fields.status = nextStatus;
                        if (nextStatus === 'added' && !cur.placement_date) {
                            fields.placement_date = new Date();
                        }
                    }
                }
            } else if (!statusExplicit || AUTO_STATUSES.has(nextStatus)) {
                const base = statusExplicit ? nextStatus : cur.status;
                const auto = resolveAutoStatus(AUTO_STATUSES.has(base) ? base : 'new', merged, channel);
                if (AUTO_STATUSES.has(String(cur.status)) || (statusExplicit && AUTO_STATUSES.has(nextStatus))) {
                    nextStatus = auto.status;
                    fields.status = nextStatus;
                }
            }

            if ('manager_checked' in body) {
                const on = truthyFlag(body.manager_checked);
                fields.manager_checked = on ? 1 : 0;
                if (on) {
                    fields.manager_checked_at = new Date();
                    const actor = req.datagonActor;
                    fields.manager_checked_by_user_id =
                        actor && actor.id != null && Number.isFinite(Number(actor.id))
                            ? Number(actor.id)
                            : null;
                } else {
                    fields.manager_checked_at = null;
                    fields.manager_checked_by_user_id = null;
                    // Снятие галочки с уже «Проверен» — возвращаем на проверку.
                    if (String(nextStatus) === 'verified' && !statusExplicit) {
                        nextStatus = 'review';
                        fields.status = 'review';
                    }
                }
            }

            const nextComment = 'comment' in fields ? fields.comment : cur.comment;
            if (nextStatus === 'revision' && !String(nextComment || '').trim() && statusExplicit) {
                return res.status(400).json({ error: 'Для статуса «На доработке» нужен комментарий' });
            }

            if (nextStatus === 'verified') {
                const mgrOk =
                    'manager_checked' in fields
                        ? Number(fields.manager_checked) === 1
                        : Number(cur.manager_checked) === 1;
                if (!mgrOk) {
                    return res.status(400).json({
                        error: 'Сначала нужна галочка «Проверено менеджером»',
                        code: 'MANAGER_CHECK_REQUIRED',
                    });
                }
            }

            if (nextStatus === 'added' && cur.status !== 'added' && !cur.almamed_added_at) {
                fields.almamed_added_at = new Date();
            }

            if (!Object.keys(fields).length) {
                return res.status(400).json({ error: 'Нет полей для сохранения' });
            }

            const cols = Object.keys(fields);
            const vals = cols.map((k) => fields[k]);
            await db.query(
                `UPDATE dg_new_products SET ${cols.map((c) => `\`${c}\` = ?`).join(', ')} WHERE id = ?`,
                [...vals, id]
            );

            try {
                await logProductFieldChanges(db, {
                    productId: id,
                    channel,
                    before: cur,
                    fields,
                    actor: req.datagonActor,
                    source: 'ui',
                });
            } catch (le) {
                console.warn('[new-products] patch log', le);
            }

            const [[row]] = await db.query('SELECT * FROM dg_new_products WHERE id = ? LIMIT 1', [id]);
            let marketsSync = null;
            if (
                channel === 'almamed' &&
                (Number(row.sell_on_markets) === 1 || Number(row.has_kits) === 1)
            ) {
                try {
                    marketsSync = await markets.upsertMarketsFromAlmamed(db, row, { syncFields: true });
                } catch (se) {
                    marketsSync = { error: se.message || 'Ошибка постановки в маркеты' };
                    console.warn('[new-products] sell_on_markets/has_kits sync', se);
                }
            }
            const mapped = mapRow(row);
            if (channel === 'marketplaces') {
                await markets.attachKitsToMapped(db, [mapped]);
            }
            res.json({
                success: true,
                data: mapped,
                missing_required: mapped.missing_required,
                auto_status_changed: mapped.status !== cur.status,
                markets_sync: marketsSync,
            });
        } catch (e) {
            console.error('[new-products] PATCH', e);
            res.status(500).json({ error: e.message || 'Ошибка сохранения' });
        }
    });

    router.post('/:id/kits', async (req, res) => {
        try {
            await ensureSchema(db);
            const parentId = parseInt(req.params.id, 10);
            if (!Number.isFinite(parentId) || parentId < 1) {
                return res.status(400).json({ error: 'Некорректный id' });
            }
            const [[parent]] = await db.query('SELECT * FROM dg_new_products WHERE id = ? LIMIT 1', [
                parentId,
            ]);
            if (!parent) return res.status(404).json({ error: 'Товар не найден' });
            if (parent.channel !== 'marketplaces') {
                return res.status(400).json({ error: 'Комплекты только для вкладки «Размещение на маркеты»' });
            }
            if (Number(parent.has_kits) !== 1) {
                return res.status(400).json({
                    error: 'Сначала отметьте «Товар с комплектами» на вкладке Альмамед',
                });
            }
            const body = req.body && typeof req.body === 'object' ? req.body : {};
            const title = clip(body.title, 255) || '';
            const [[ord]] = await db.query(
                `SELECT COALESCE(MAX(sort_order), 0) + 1 AS next_ord
                   FROM dg_new_product_kits WHERE parent_product_id = ?`,
                [parentId]
            );
            const seedCode = clip(body.product_code != null ? body.product_code : parent.product_code, 128) || null;
            const seedArticle = clip(body.article != null ? body.article : parent.article, 128) || null;
            const seedRu = clip(parent.ru_url, 2048) || null;
            const [ins] = await db.query(
                `INSERT INTO dg_new_product_kits (
                    parent_product_id, title, sort_order,
                    product_code, article, barcode, price_markets, status, comment,
                    dimensions_text, vat, ru_url
                 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    parentId,
                    title,
                    Number(ord?.next_ord) || 1,
                    seedCode,
                    seedArticle,
                    null,
                    null,
                    'new',
                    null,
                    null,
                    null,
                    seedRu,
                ]
            );
            const [[kit]] = await db.query('SELECT * FROM dg_new_product_kits WHERE id = ? LIMIT 1', [
                ins.insertId,
            ]);
            const mapped = markets.mapKitRow(kit);
            mapped.ru_url = String(parent.ru_url || '').trim();
            try {
                await insertProductLog(db, {
                    productId: parentId,
                    channel: 'marketplaces',
                    kitId: kit.id,
                    field: 'kit_title',
                    oldValue: null,
                    newValue: kit.title || '(новый комплект)',
                    action: 'kit_add',
                    source: 'ui',
                    actor: req.datagonActor,
                });
            } catch (le) {
                console.warn('[new-products] kit add log', le);
            }
            res.json({ success: true, data: mapped });
        } catch (e) {
            console.error('[new-products] POST kits', e);
            res.status(500).json({ error: e.message || 'Ошибка добавления комплекта' });
        }
    });

    router.patch('/:id/kits/:kitId', async (req, res) => {
        try {
            await ensureSchema(db);
            const parentId = parseInt(req.params.id, 10);
            const kitId = parseInt(req.params.kitId, 10);
            if (!Number.isFinite(parentId) || parentId < 1 || !Number.isFinite(kitId) || kitId < 1) {
                return res.status(400).json({ error: 'Некорректный id' });
            }
            const [[kit]] = await db.query(
                `SELECT * FROM dg_new_product_kits WHERE id = ? AND parent_product_id = ? LIMIT 1`,
                [kitId, parentId]
            );
            if (!kit) return res.status(404).json({ error: 'Комплект не найден' });
            const body = req.body && typeof req.body === 'object' ? req.body : {};
            const fields = {};
            if ('title' in body) fields.title = clip(body.title, 255);
            if ('product_code' in body) fields.product_code = clip(body.product_code, 128) || null;
            // article / barcode / vat / ru_url у комплекта не редактируются:
            // артикул/штрихкод/НДС — только просмотр; РУ всегда с родительского товара в Датагоне.
            if ('price_markets' in body) fields.price_markets = parsePrice(body.price_markets);
            if ('comment' in body) fields.comment = clip(body.comment, 65535) || null;
            if ('dimensions_text' in body) fields.dimensions_text = clip(body.dimensions_text, 512) || null;
            if ('length_cm' in body) fields.length_cm = markets.parseNum(body.length_cm);
            if ('width_cm' in body) fields.width_cm = markets.parseNum(body.width_cm);
            if ('height_cm' in body) fields.height_cm = markets.parseNum(body.height_cm);
            if ('weight_kg' in body) fields.weight_kg = markets.parseNum(body.weight_kg);
            if ('status' in body) {
                const st = normStatus(body.status);
                if (!st || !markets.MARKETS_STATUSES.has(st) || st === 'removed') {
                    return res.status(400).json({ error: 'Некорректный статус комплекта' });
                }
                if (st === 'revision' && !String(('comment' in fields ? fields.comment : kit.comment) || '').trim()) {
                    return res.status(400).json({ error: 'Для статуса «На доработке» нужен комментарий' });
                }
                fields.status = st;
            }
            if (
                !('dimensions_text' in body) &&
                ('length_cm' in fields || 'width_cm' in fields || 'height_cm' in fields || 'weight_kg' in fields)
            ) {
                const dimMerged = {
                    length_cm: 'length_cm' in fields ? fields.length_cm : kit.length_cm,
                    width_cm: 'width_cm' in fields ? fields.width_cm : kit.width_cm,
                    height_cm: 'height_cm' in fields ? fields.height_cm : kit.height_cm,
                    weight_kg: 'weight_kg' in fields ? fields.weight_kg : kit.weight_kg,
                };
                fields.dimensions_text = markets.formatDimensions(dimMerged) || null;
            }
            if (!Object.keys(fields).length) {
                return res.status(400).json({ error: 'Нет полей для сохранения' });
            }
            const cols = Object.keys(fields);
            await db.query(
                `UPDATE dg_new_product_kits SET ${cols.map((c) => `\`${c}\` = ?`).join(', ')} WHERE id = ?`,
                [...cols.map((c) => fields[c]), kitId]
            );
            try {
                for (const key of cols) {
                    const logField = key === 'title' ? 'kit_title' : key;
                    if (valuesEqualForLog(key, kit[key], fields[key])) continue;
                    await insertProductLog(db, {
                        productId: parentId,
                        channel: 'marketplaces',
                        kitId,
                        field: logField,
                        oldValue: formatFieldForLog(key, kit[key], 'marketplaces'),
                        newValue: formatFieldForLog(key, fields[key], 'marketplaces'),
                        action: 'kit_set',
                        source: 'ui',
                        actor: req.datagonActor,
                    });
                }
            } catch (le) {
                console.warn('[new-products] kit patch log', le);
            }
            const [[updated]] = await db.query('SELECT * FROM dg_new_product_kits WHERE id = ? LIMIT 1', [
                kitId,
            ]);
            const [[parent]] = await db.query(
                'SELECT ru_url FROM dg_new_products WHERE id = ? LIMIT 1',
                [parentId]
            );
            const mapped = markets.mapKitRow(updated);
            mapped.ru_url = String((parent && parent.ru_url) || '').trim();
            res.json({ success: true, data: mapped });
        } catch (e) {
            console.error('[new-products] PATCH kit', e);
            res.status(500).json({ error: e.message || 'Ошибка сохранения комплекта' });
        }
    });

    router.delete('/:id/kits/:kitId', async (req, res) => {
        try {
            await ensureSchema(db);
            const parentId = parseInt(req.params.id, 10);
            const kitId = parseInt(req.params.kitId, 10);
            if (!Number.isFinite(parentId) || parentId < 1 || !Number.isFinite(kitId) || kitId < 1) {
                return res.status(400).json({ error: 'Некорректный id' });
            }
            const [[kit]] = await db.query(
                `SELECT * FROM dg_new_product_kits WHERE id = ? AND parent_product_id = ? LIMIT 1`,
                [kitId, parentId]
            );
            if (!kit) return res.status(404).json({ error: 'Комплект не найден' });
            const [r] = await db.query(
                `DELETE FROM dg_new_product_kits WHERE id = ? AND parent_product_id = ?`,
                [kitId, parentId]
            );
            if (!r.affectedRows) return res.status(404).json({ error: 'Комплект не найден' });
            try {
                await insertProductLog(db, {
                    productId: parentId,
                    channel: 'marketplaces',
                    kitId,
                    field: 'kit_title',
                    oldValue: kit.title || '',
                    newValue: null,
                    action: 'kit_delete',
                    source: 'ui',
                    actor: req.datagonActor,
                });
            } catch (le) {
                console.warn('[new-products] kit delete log', le);
            }
            res.json({ success: true, deleted: kitId });
        } catch (e) {
            console.error('[new-products] DELETE kit', e);
            res.status(500).json({ error: e.message || 'Ошибка удаления комплекта' });
        }
    });

    router.get('/:id/log', async (req, res) => {
        try {
            await ensureSchema(db);
            const id = parseInt(req.params.id, 10);
            if (!Number.isFinite(id) || id < 1) {
                return res.status(400).json({ success: false, error: 'Некорректный id' });
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
            const [[prod]] = await db.query(
                `SELECT id, title, article, product_code, channel FROM dg_new_products WHERE id = ? LIMIT 1`,
                [id]
            );
            res.json({
                success: true,
                product_id: id,
                product: prod
                    ? {
                          id: Number(prod.id),
                          title: prod.title || '',
                          article: prod.article || '',
                          product_code: prod.product_code || '',
                          channel: prod.channel || '',
                      }
                    : null,
                rows: out,
                total: Number(cnt?.total || 0),
                limit,
                offset,
            });
        } catch (e) {
            console.error('[new-products] GET log', e);
            res.status(500).json({ success: false, error: e.message || 'Ошибка чтения журнала' });
        }
    });

    router.delete('/:id', async (req, res) => {
        try {
            await ensureSchema(db);
            const id = parseInt(req.params.id, 10);
            if (!Number.isFinite(id) || id < 1) return res.status(400).json({ error: 'Некорректный id' });
            const [[cur]] = await db.query('SELECT * FROM dg_new_products WHERE id = ? LIMIT 1', [id]);
            if (!cur) return res.status(404).json({ error: 'Запись не найдена' });
            if (String(cur.status) === 'removed') {
                return res.status(400).json({ error: 'Запись уже в удалённых' });
            }
            try {
                await insertProductLog(db, {
                    productId: id,
                    channel: cur.channel || 'almamed',
                    field: '_row',
                    oldValue: clipLogVal(cur.title || cur.article || '#' + id),
                    newValue: 'удалено',
                    action: 'delete',
                    source: 'ui',
                    actor: req.datagonActor,
                });
            } catch (le) {
                console.warn('[new-products] delete log', le);
            }
            const result = await markets.softRemoveProduct(db, cur, { cascadeFromAlmamed: true });
            res.json({
                success: true,
                soft_deleted: true,
                cascaded_markets: result.cascaded || 0,
            });
        } catch (e) {
            res.status(500).json({ error: e.message || 'Ошибка удаления' });
        }
    });

    /** Восстановить из «Удалённые» (status removed → new). */
    router.post('/:id/restore', async (req, res) => {
        try {
            await ensureSchema(db);
            const id = parseInt(req.params.id, 10);
            if (!Number.isFinite(id) || id < 1) return res.status(400).json({ error: 'Некорректный id' });
            const [[cur]] = await db.query('SELECT * FROM dg_new_products WHERE id = ? LIMIT 1', [id]);
            if (!cur) return res.status(404).json({ error: 'Запись не найдена' });
            if (String(cur.status) !== 'removed') {
                return res.status(400).json({ error: 'Восстановить можно только удалённую запись' });
            }
            await markets.softRestoreProduct(db, cur);
            try {
                await insertProductLog(db, {
                    productId: id,
                    channel: cur.channel || 'almamed',
                    field: '_row',
                    oldValue: 'удалено',
                    newValue: 'восстановлено',
                    action: 'restore',
                    source: 'ui',
                    actor: req.datagonActor,
                });
            } catch (le) {
                console.warn('[new-products] restore log', le);
            }
            let marketsSync = null;
            const [[row]] = await db.query('SELECT * FROM dg_new_products WHERE id = ? LIMIT 1', [id]);
            if (
                row &&
                row.channel === 'almamed' &&
                (Number(row.sell_on_markets) === 1 || Number(row.has_kits) === 1)
            ) {
                try {
                    marketsSync = await markets.upsertMarketsFromAlmamed(db, row, { syncFields: true });
                } catch (se) {
                    marketsSync = { error: se.message || 'Ошибка синхронизации маркетов' };
                }
            }
            const mapped = mapRow(row);
            if (mapped.channel === 'marketplaces') {
                await markets.attachKitsToMapped(db, [mapped]);
            }
            res.json({ success: true, data: mapped, markets_sync: marketsSync });
        } catch (e) {
            res.status(500).json({ error: e.message || 'Ошибка восстановления' });
        }
    });

    /**
     * Раздать поровну строки без ответственного (или scope=all / unassigned) между активными
     * контент-менеджерами. Не round-robin по одной строке, а **подряд идущие блоки** в порядке
     * списка (приоритет, id): похожие SKU, внесённые пачкой, остаются у одного человека —
     * удобнее копировать поля при отличии в одной характеристике.
     * Body: { channel, scope?: 'unassigned'|'all', user_ids?: number[] }
     */
    router.post('/distribute', async (req, res) => {
        try {
            await ensureSchema(db);
            const body = req.body && typeof req.body === 'object' ? req.body : {};
            const channel = normChannel(body.channel);
            const scope = String(body.scope || 'unassigned').trim().toLowerCase();

            let users;
            if (Array.isArray(body.user_ids) && body.user_ids.length) {
                const ids = body.user_ids.map((x) => parseInt(x, 10)).filter((n) => Number.isFinite(n) && n > 0);
                if (!ids.length) return res.status(400).json({ error: 'Пустой список user_ids' });
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
                return res.status(400).json({ error: 'Нет активных контент-менеджеров для раздачи' });
            }

            const where =
                scope === 'all'
                    ? "channel = ? AND status <> 'transferred'"
                    : "channel = ? AND responsible_user_id IS NULL AND status <> 'transferred'";
            const [rows] = await db.query(
                `SELECT id, responsible_user_id, responsible_name FROM dg_new_products WHERE ${where} ORDER BY ${PRIORITY_ORDER_SQL} ASC, id ASC`,
                [channel]
            );
            if (!rows.length) {
                return res.json({ success: true, assigned: 0, users: users.length, message: 'Нечего раздавать' });
            }

            const actor = req.datagonActor;
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
                        `UPDATE dg_new_products
                            SET responsible_user_id = ?, responsible_name = ?
                          WHERE id = ?`,
                        [u.id, name, before.id]
                    );
                    try {
                        await logProductFieldChanges(db, {
                            productId: before.id,
                            channel,
                            before,
                            fields: {
                                responsible_user_id: u.id,
                                responsible_name: name,
                            },
                            actor,
                            source: 'distribute',
                        });
                    } catch (le) {
                        console.warn('[new-products] distribute log', le);
                    }
                    assigned += 1;
                }
            }

            res.json({
                success: true,
                assigned,
                users: users.length,
                channel,
                scope: scope === 'all' ? 'all' : 'unassigned',
                mode: 'contiguous_blocks',
            });
        } catch (e) {
            console.error('[new-products] distribute', e);
            res.status(500).json({ error: e.message || 'Ошибка раздачи' });
        }
    });

    /** Обновить очередь «Размещение на маркеты» из transferred Альмамед + МС + снапшоты МП. */
    router.post('/sync-markets-queue', async (req, res) => {
        const t0 = Date.now();
        try {
            await ensureSchema(db);
            const result = await markets.refreshMarketsQueue(db);
            res.json({
                success: true,
                ...result,
                duration_sec: Math.round((Date.now() - t0) / 1000),
            });
        } catch (e) {
            console.error('[new-products] sync-markets-queue', e);
            res.status(500).json({ error: e.message || 'Ошибка обновления очереди маркетов' });
        }
    });

    /** Убрать размещенные (status=added) с вкладки маркетов после проверки. */
    router.post('/remove-placed', async (req, res) => {
        const t0 = Date.now();
        try {
            await ensureSchema(db);
            const body = req.body && typeof req.body === 'object' ? req.body : {};
            const dryRun =
                String(body.dry_run != null ? body.dry_run : req.query.dry_run || '') === '1' ||
                body.dry_run === true;
            const result = await markets.removePlacedMarkets(db, { dryRun });
            res.json({
                success: true,
                channel: 'marketplaces',
                ...result,
                duration_sec: Math.round((Date.now() - t0) / 1000),
            });
        } catch (e) {
            console.error('[new-products] remove-placed', e);
            res.status(500).json({ error: e.message || 'Ошибка удаления размещённых' });
        }
    });

    return router;
};
