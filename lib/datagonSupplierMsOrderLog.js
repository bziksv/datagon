'use strict';

/**
 * Журнал попыток создания заказа поставщику в МойСклад (страница «Поставщики»).
 */

let schemaReady = false;

/** Период для графика «заказы в МС» на /suppliers.html */
const MS_ORDER_STATS_PERIOD_DAYS = 90;
/** Пороги «долго не заказывали» при наличии SKU к закупке */
const MS_ORDER_STALE_WARN_DAYS = 30;
const MS_ORDER_STALE_DANGER_DAYS = 60;

/**
 * JOIN последнего успешного заказа в МС по поставщику (по max id).
 * @param {string} [aggAlias]
 */
function sqlLastSuccessMsOrderJoin(aggAlias = 'agg') {
    const a = String(aggAlias || 'agg').replace(/[^a-zA-Z0-9_]/g, '') || 'agg';
    return `
        LEFT JOIN (
            SELECT l.supplier_key,
                   l.created_at AS last_ms_order_at,
                   l.order_name AS last_ms_order_name,
                   l.created_by_name AS last_ms_order_by,
                   l.positions_count AS last_ms_order_positions
              FROM dg_supplier_ms_order_log l
             INNER JOIN (
                SELECT supplier_key, MAX(id) AS max_id
                  FROM dg_supplier_ms_order_log
                 WHERE status = 'success'
                 GROUP BY supplier_key
             ) t ON l.id = t.max_id
        ) ms_last ON ms_last.supplier_key = ${a}.supplier_key`;
}

async function ensureSupplierMsOrderLogSchema(db) {
    if (schemaReady) return;
    await db.query(`
        CREATE TABLE IF NOT EXISTS dg_supplier_ms_order_log (
            id BIGINT AUTO_INCREMENT PRIMARY KEY,
            supplier_key VARCHAR(255) NOT NULL,
            status VARCHAR(16) NOT NULL,
            code_error VARCHAR(64) NULL,
            order_name VARCHAR(255) NULL,
            ms_uuid VARCHAR(36) NULL,
            ms_href VARCHAR(512) NULL,
            positions_count INT NULL,
            lines_total INT NULL,
            http_status INT NULL,
            message TEXT NULL,
            detail_json MEDIUMTEXT NULL,
            created_by_user_id INT NULL,
            created_by_name VARCHAR(255) NULL,
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            INDEX idx_sup_ms_order_supplier (supplier_key, created_at),
            INDEX idx_sup_ms_order_status (status, created_at),
            INDEX idx_sup_ms_order_user (created_by_user_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    schemaReady = true;
}

function actorDisplayName(actor) {
    if (!actor) return '';
    return String(actor.full_name || actor.username || '').trim();
}

function safeJson(obj) {
    try {
        return JSON.stringify(obj);
    } catch {
        return '{}';
    }
}

/**
 * Пошаговый контекст одной попытки (пишется в detail_json).
 */
function createMsOrderRunContext(supplierKey) {
    return {
        supplier_key: String(supplierKey || '').trim(),
        started_at: new Date().toISOString(),
        steps: [],
    };
}

function appendMsOrderStep(ctx, stepName, data) {
    if (!ctx || !ctx.steps) return;
    ctx.steps.push({
        at: new Date().toISOString(),
        step: String(stepName || '').slice(0, 64),
        ...(data && typeof data === 'object' ? data : {}),
    });
}

function consoleMsOrder(level, payload) {
    const line = `[suppliers-ms-order] ${safeJson(payload)}`;
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
}

/**
 * @param {import('mysql2/promise').Pool} db
 * @param {object} opts
 * @returns {Promise<number>} log id
 */
async function persistSupplierMsOrderLog(db, opts) {
    await ensureSupplierMsOrderLogSchema(db);
    const actor = opts.actor || null;
    const uid = actor && actor.id != null ? Number(actor.id) : null;
    const uname = actorDisplayName(actor) || null;
    const detail = {
        ...(opts.runContext || {}),
        finished_at: new Date().toISOString(),
    };
    if (opts.extra_detail && typeof opts.extra_detail === 'object') {
        Object.assign(detail, opts.extra_detail);
    }
    const [result] = await db.query(
        `INSERT INTO dg_supplier_ms_order_log
            (supplier_key, status, code_error, order_name, ms_uuid, ms_href,
             positions_count, lines_total, http_status, message, detail_json,
             created_by_user_id, created_by_name)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            String(opts.supplier_key || '').slice(0, 255),
            String(opts.status || 'failed').slice(0, 16),
            opts.code_error ? String(opts.code_error).slice(0, 64) : null,
            opts.order_name ? String(opts.order_name).slice(0, 255) : null,
            opts.ms_uuid ? String(opts.ms_uuid).slice(0, 36) : null,
            opts.ms_href ? String(opts.ms_href).slice(0, 512) : null,
            opts.positions_count != null ? Number(opts.positions_count) : null,
            opts.lines_total != null ? Number(opts.lines_total) : null,
            opts.http_status != null ? Number(opts.http_status) : null,
            opts.message ? String(opts.message).slice(0, 65535) : null,
            safeJson(detail).slice(0, 16 * 1024 * 1024 - 1),
            Number.isFinite(uid) ? uid : null,
            uname,
        ],
    );
    return Number(result.insertId || 0);
}

/**
 * @param {import('mysql2/promise').Pool} db
 * @param {{ supplier_key?: string, limit?: number, offset?: number }} q
 */
async function listSupplierMsOrderLogs(db, q) {
    await ensureSupplierMsOrderLogSchema(db);
    const supplierKey = String(q.supplier_key || '').trim();
    const limit = Math.min(100, Math.max(1, parseInt(q.limit, 10) || 20));
    const offset = Math.max(0, parseInt(q.offset, 10) || 0);
    const where = ['1=1'];
    const params = [];
    if (supplierKey) {
        where.push('supplier_key = ?');
        params.push(supplierKey);
    }
    const whereSql = where.join(' AND ');
    const [[countRow]] = await db.query(
        `SELECT COUNT(*) AS total FROM dg_supplier_ms_order_log WHERE ${whereSql}`,
        params,
    );
    const [rows] = await db.query(
        `SELECT id, supplier_key, status, code_error, order_name, ms_uuid, ms_href,
                positions_count, lines_total, http_status, message,
                created_by_user_id, created_by_name, created_at
           FROM dg_supplier_ms_order_log
          WHERE ${whereSql}
          ORDER BY id DESC
          LIMIT ? OFFSET ?`,
        [...params, limit, offset],
    );
    return {
        total: Number(countRow?.total || 0),
        limit,
        offset,
        rows: (rows || []).map((r) => ({
            id: Number(r.id),
            supplier_key: String(r.supplier_key || ''),
            status: String(r.status || ''),
            code_error: r.code_error ? String(r.code_error) : '',
            order_name: r.order_name ? String(r.order_name) : '',
            ms_uuid: r.ms_uuid ? String(r.ms_uuid) : '',
            ms_href: r.ms_href ? String(r.ms_href) : '',
            ms_web_href: r.ms_uuid
                ? `https://online.moysklad.ru/app/#purchaseorder/edit?id=${r.ms_uuid}`
                : '',
            positions_count: r.positions_count != null ? Number(r.positions_count) : null,
            lines_total: r.lines_total != null ? Number(r.lines_total) : null,
            http_status: r.http_status != null ? Number(r.http_status) : null,
            message: r.message ? String(r.message) : '',
            created_by_user_id: r.created_by_user_id != null ? Number(r.created_by_user_id) : null,
            created_by_name: r.created_by_name ? String(r.created_by_name) : '',
            created_at: r.created_at,
        })),
    };
}

/**
 * @param {import('mysql2/promise').Pool} db
 * @param {number} logId
 */
async function getSupplierMsOrderLogDetail(db, logId) {
    await ensureSupplierMsOrderLogSchema(db);
    const id = Number(logId);
    if (!Number.isFinite(id) || id < 1) return null;
    const [[row]] = await db.query(
        `SELECT * FROM dg_supplier_ms_order_log WHERE id = ? LIMIT 1`,
        [id],
    );
    if (!row) return null;
    let detail = null;
    if (row.detail_json) {
        try {
            detail = JSON.parse(row.detail_json);
        } catch {
            detail = { parse_error: true, raw: String(row.detail_json).slice(0, 2000) };
        }
    }
    return {
        id: Number(row.id),
        supplier_key: String(row.supplier_key || ''),
        status: String(row.status || ''),
        code_error: row.code_error ? String(row.code_error) : '',
        order_name: row.order_name ? String(row.order_name) : '',
        ms_uuid: row.ms_uuid ? String(row.ms_uuid) : '',
        ms_href: row.ms_href ? String(row.ms_href) : '',
        ms_web_href: row.ms_uuid
            ? `https://online.moysklad.ru/app/#purchaseorder/edit?id=${row.ms_uuid}`
            : '',
        positions_count: row.positions_count != null ? Number(row.positions_count) : null,
        lines_total: row.lines_total != null ? Number(row.lines_total) : null,
        http_status: row.http_status != null ? Number(row.http_status) : null,
        message: row.message ? String(row.message) : '',
        created_by_user_id: row.created_by_user_id != null ? Number(row.created_by_user_id) : null,
        created_by_name: row.created_by_name ? String(row.created_by_name) : '',
        created_at: row.created_at,
        detail,
    };
}

/**
 * @param {import('mysql2/promise').Pool} db
 * @param {{ period_days?: number }} [opts]
 */
async function loadMsOrdersByCreator(db, opts = {}) {
    await ensureSupplierMsOrderLogSchema(db);
    let days = parseInt(opts.period_days, 10);
    if (!Number.isFinite(days) || days < 7) days = MS_ORDER_STATS_PERIOD_DAYS;
    if (days > 365) days = 365;
    const [rows] = await db.query(
        `SELECT
            COALESCE(created_by_user_id, 0) AS creator_id,
            COALESCE(NULLIF(TRIM(created_by_name), ''), '(не указан)') AS creator_label,
            COUNT(*) AS orders_count,
            COUNT(DISTINCT supplier_key) AS suppliers_count,
            SUM(COALESCE(positions_count, 0)) AS positions_total
           FROM dg_supplier_ms_order_log
          WHERE status = 'success'
            AND created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
          GROUP BY COALESCE(created_by_user_id, 0), creator_label
          ORDER BY orders_count DESC, creator_label ASC`,
        [days],
    );
    return {
        period_days: days,
        rows: (rows || []).map((r) => ({
            creator_id: Number(r.creator_id || 0),
            creator_label: String(r.creator_label || '(не указан)'),
            orders_count: Number(r.orders_count || 0),
            suppliers_count: Number(r.suppliers_count || 0),
            positions_total: Number(r.positions_count || 0),
        })),
    };
}

/**
 * @param {Date|string|null} at
 * @returns {number|null}
 */
function daysSinceMsOrderAt(at) {
    if (!at) return null;
    const d = at instanceof Date ? at : new Date(at);
    if (Number.isNaN(d.getTime())) return null;
    return Math.max(0, Math.floor((Date.now() - d.getTime()) / 86400000));
}

/** Есть смысл напоминать о заказе в МС: SKU к закупке и сумма ≥ мин. порога поставщика. */
function isProcurementAttentionEligible(row) {
    const skuToBuy = Number(row.products_to_purchase || 0) > 0;
    const sumToBuy = Number(row.total_purchase_sum || 0) > 0.005;
    if (!skuToBuy || !sumToBuy) return false;
    const minSum = row.min_purchase_sum != null ? Number(row.min_purchase_sum) : null;
    if (minSum != null && Number.isFinite(minSum) && minSum > 0 && sumToBuy < minSum) return false;
    return true;
}

/**
 * SQL: поставщик с осмысленной потребностью в заказе (SKU и сумма к закупке, порог min_purchase_sum).
 * @param {string} [aggAlias]
 * @param {string} [settingsAlias]
 */
function sqlProcurementAttentionEligible(aggAlias = 'agg', settingsAlias = 'ss') {
    const agg = String(aggAlias || 'agg').replace(/[^a-zA-Z0-9_]/g, '') || 'agg';
    const ss = String(settingsAlias || 'ss').replace(/[^a-zA-Z0-9_]/g, '') || 'ss';
    return `(
        ${agg}.products_to_purchase > 0
        AND ${agg}.total_purchase_sum > 0.005
        AND (
            ${ss}.min_purchase_sum IS NULL
            OR ${ss}.min_purchase_sum <= 0
            OR ${agg}.total_purchase_sum >= ${ss}.min_purchase_sum
        )
    )`;
}

/** SQL: фильтр «требуют внимания» (eligible + давно/никогда не было успешного заказа в МС из Datagon). */
function sqlProcurementAttentionPredicate(aggAlias = 'agg', settingsAlias = 'ss') {
    return `(
        ${sqlProcurementAttentionEligible(aggAlias, settingsAlias)}
        AND (
            ms_last.last_ms_order_at IS NULL
            OR ms_last.last_ms_order_at < DATE_SUB(NOW(), INTERVAL ${MS_ORDER_STALE_WARN_DAYS} DAY)
        )
    )`;
}

/**
 * @param {{ products_to_purchase?: number, total_purchase_sum?: number, min_purchase_sum?: number|null, last_ms_order_at?: Date|string|null }} row
 */
function computeProcurementAttention(row) {
    if (!isProcurementAttentionEligible(row)) {
        return { level: 'none', code: '', label: '', days_since: null };
    }
    const last = row.last_ms_order_at;
    if (!last) {
        return {
            level: 'danger',
            code: 'never',
            label: 'Нет заказов в МС',
            days_since: null,
        };
    }
    const days = daysSinceMsOrderAt(last);
    if (days == null) {
        return { level: 'warning', code: 'unknown', label: 'Дата заказа неизвестна', days_since: null };
    }
    if (days >= MS_ORDER_STALE_DANGER_DAYS) {
        return {
            level: 'danger',
            code: 'stale',
            label: `Давно без заказа (${days} дн.)`,
            days_since: days,
        };
    }
    if (days >= MS_ORDER_STALE_WARN_DAYS) {
        return {
            level: 'warning',
            code: 'stale',
            label: `Долго без заказа (${days} дн.)`,
            days_since: days,
        };
    }
    return { level: 'ok', code: 'recent', label: '', days_since: days };
}

module.exports = {
    ensureSupplierMsOrderLogSchema,
    createMsOrderRunContext,
    appendMsOrderStep,
    consoleMsOrder,
    persistSupplierMsOrderLog,
    listSupplierMsOrderLogs,
    getSupplierMsOrderLogDetail,
    sqlLastSuccessMsOrderJoin,
    loadMsOrdersByCreator,
    isProcurementAttentionEligible,
    sqlProcurementAttentionEligible,
    sqlProcurementAttentionPredicate,
    computeProcurementAttention,
    daysSinceMsOrderAt,
    MS_ORDER_STATS_PERIOD_DAYS,
    MS_ORDER_STALE_WARN_DAYS,
    MS_ORDER_STALE_DANGER_DAYS,
};
