'use strict';

/**
 * Заказы поставщикам МойСклад (`entity/purchaseorder`) → `ms_purchase_order`.
 * KPI «оплачено / едет» для финансов; список на /ms-purchase-orders.html.
 * Приёмки (supply) не синкаем — «Принято» = shippedSum на заказе.
 */

const axios = require('axios');
const { getMsPurchaseOrdersSyncMeta } = require('./datagonMsPurchaseOrdersSyncRevision');

const MS_BASE = 'https://api.moysklad.ru/api/remap/1.2';

/** Склады из фильтров МС пользователя. */
const DEFAULT_STORE_A = Object.freeze([
    'da32dd7e-d440-11e8-9107-5048000cc5c4', // Альмамед
    'a1c75cb0-66b5-11ee-0a80-088f00575d78', // Альмамед Ожидание
    'e31d1bcf-50bd-11ef-0a80-0c7300285089', // Новикова Ожидание
]);
const DEFAULT_STORE_B = Object.freeze([
    'da32dd7e-d440-11e8-9107-5048000cc5c4',
    'a1c75cb0-66b5-11ee-0a80-088f00575d78',
]);
/** Статусы для корзины B (частично). */
const DEFAULT_STATE_B = Object.freeze([
    '415c0774-e172-11ee-0a80-0f1100012414', // Без статуса
    '415c096d-e172-11ee-0a80-0f1100012415', // Ждём доставку
    '415c09c8-e172-11ee-0a80-0f1100012416', // Есть проблема
]);

const DEFAULT_SYNC_FROM = '2022-01-01';
const EXPAND = 'agent,store,organization,state';
/** Одна страница с expand на длинном периоде часто > 2 мин у МС — 120s давал ложный fail. */
const MS_PAGE_TIMEOUT_MS = 300000;
const MS_PAGE_LIMIT = 50;
const MS_PAGE_MAX_ATTEMPTS = 4;

let schemaReady = null;

const jobState = {
    active: false,
    cancelRequested: false,
    started_at: null,
    finished_at: null,
    fetched: 0,
    total: 0,
    saved: 0,
    message: '',
    last_error: null,
    errors: [],
    job_serial: 0,
};

function resolveMsToken(config) {
    try {
        const cfg = config || require('../config');
        return process.env.MS_TOKEN || (cfg && cfg.msToken) || '';
    } catch (e) {
        return process.env.MS_TOKEN || '';
    }
}

function getHeaders(config) {
    const token = resolveMsToken(config);
    if (!token) return null;
    return {
        Authorization: 'Bearer ' + token,
        'Content-Type': 'application/json',
        Accept: 'application/json;charset=utf-8',
        'Accept-Encoding': 'gzip',
    };
}

function uuidFromMeta(meta) {
    const href = meta && meta.href ? String(meta.href) : '';
    const m = href.match(/\/([0-9a-f-]{36})(?:\?|$)/i);
    return m ? m[1].toLowerCase() : null;
}

function parseMomentToMysql(s) {
    if (!s) return null;
    const str = String(s).trim();
    const m = str.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)/);
    if (m) return m[1] + ' ' + (m[2].length === 5 ? m[2] + ':00' : m[2]);
    const d = new Date(str);
    if (Number.isNaN(d.getTime())) return null;
    const pad = (n) => String(n).padStart(2, '0');
    return (
        d.getFullYear() +
        '-' +
        pad(d.getMonth() + 1) +
        '-' +
        pad(d.getDate()) +
        ' ' +
        pad(d.getHours()) +
        ':' +
        pad(d.getMinutes()) +
        ':' +
        pad(d.getSeconds())
    );
}

function minor(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return 0;
    return Math.round(n);
}

async function ensureMsPurchaseOrderSchema(db) {
    if (schemaReady) return schemaReady;
    schemaReady = (async () => {
        await db.query(`
            CREATE TABLE IF NOT EXISTS ms_purchase_order (
                uuid VARCHAR(36) NOT NULL PRIMARY KEY,
                doc_name VARCHAR(64) NOT NULL DEFAULT '',
                moment DATETIME NULL,
                applicable TINYINT(1) NOT NULL DEFAULT 1,
                agent_uuid VARCHAR(36) NULL,
                agent_name VARCHAR(255) NULL,
                store_uuid VARCHAR(36) NULL,
                store_name VARCHAR(150) NULL,
                organization_uuid VARCHAR(36) NULL,
                organization_name VARCHAR(150) NULL,
                state_uuid VARCHAR(36) NULL,
                state_name VARCHAR(150) NULL,
                sum_minor BIGINT NOT NULL DEFAULT 0,
                payed_sum_minor BIGINT NOT NULL DEFAULT 0,
                shipped_sum_minor BIGINT NOT NULL DEFAULT 0,
                description TEXT NULL,
                ms_updated DATETIME NULL,
                deleted_at TIMESTAMP NULL DEFAULT NULL,
                payload_json JSON NULL,
                fetched_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                INDEX idx_mpo_moment (moment),
                INDEX idx_mpo_store (store_uuid),
                INDEX idx_mpo_state (state_uuid),
                INDEX idx_mpo_agent (agent_uuid),
                INDEX idx_mpo_deleted (deleted_at),
                INDEX idx_mpo_sums (sum_minor, payed_sum_minor, shipped_sum_minor)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);
    })();
    return schemaReady;
}

function getSyncFromYmd(appSettings) {
    const raw = String((appSettings && appSettings.ms_purchase_orders_sync_from) || DEFAULT_SYNC_FROM).trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
    return DEFAULT_SYNC_FROM;
}

function getApiDelayMs(appSettings) {
    const raw = Number(appSettings && appSettings.ms_sync_delay_ms);
    const configured = Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 200;
    return Math.max(150, configured);
}

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

function isRetriableMsHttpError(err) {
    if (!err) return false;
    const code = String(err.code || '');
    if (code === 'ECONNABORTED' || code === 'ETIMEDOUT' || code === 'ECONNRESET' || code === 'EAI_AGAIN') {
        return true;
    }
    const msg = String(err.message || '');
    if (/timeout of \d+ms exceeded/i.test(msg)) return true;
    const status = err.response && err.response.status;
    return status === 429 || status === 502 || status === 503 || status === 504;
}

/**
 * GET одной страницы purchaseorder с retry на timeout/5xx.
 */
async function fetchPurchaseOrderPage(url, headers, opts) {
    const o = opts && typeof opts === 'object' ? opts : {};
    const timeoutMs = Number(o.timeoutMs) > 0 ? Number(o.timeoutMs) : MS_PAGE_TIMEOUT_MS;
    const maxAttempts = Number(o.maxAttempts) > 0 ? Number(o.maxAttempts) : MS_PAGE_MAX_ATTEMPTS;
    const onAttempt = typeof o.onAttempt === 'function' ? o.onAttempt : null;
    let lastErr = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        if (onAttempt) onAttempt(attempt, maxAttempts);
        try {
            return await axios.get(url, { headers, timeout: timeoutMs });
        } catch (e) {
            lastErr = e;
            if (attempt >= maxAttempts || !isRetriableMsHttpError(e)) throw e;
            const backoff = Math.min(15000, 1500 * attempt * attempt);
            await sleep(backoff);
        }
    }
    throw lastErr || new Error('MS purchaseorder: пустой ответ');
}

function rowFromMsDoc(doc) {
    const uuid = String((doc && doc.id) || '').toLowerCase();
    if (!uuid) return null;
    const agent = (doc && doc.agent) || {};
    const store = (doc && doc.store) || {};
    const org = (doc && doc.organization) || {};
    const state = (doc && doc.state) || {};
    return {
        uuid,
        doc_name: String((doc && doc.name) || '').slice(0, 64),
        moment: parseMomentToMysql(doc && doc.moment),
        applicable: doc && doc.applicable === false ? 0 : 1,
        agent_uuid: uuidFromMeta(agent.meta) || null,
        agent_name: String(agent.name || '').slice(0, 255) || null,
        store_uuid: uuidFromMeta(store.meta) || null,
        store_name: String(store.name || '').slice(0, 150) || null,
        organization_uuid: uuidFromMeta(org.meta) || null,
        organization_name: String(org.name || '').slice(0, 150) || null,
        state_uuid: uuidFromMeta(state.meta) || null,
        state_name: String(state.name || '').slice(0, 150) || null,
        sum_minor: minor(doc && doc.sum),
        payed_sum_minor: minor(doc && doc.payedSum),
        shipped_sum_minor: minor(doc && doc.shippedSum),
        description: doc && doc.description != null ? String(doc.description).slice(0, 65000) : null,
        ms_updated: parseMomentToMysql(doc && doc.updated),
    };
}

async function upsertPurchaseOrder(db, row) {
    await db.query(
        `
        INSERT INTO ms_purchase_order (
            uuid, doc_name, moment, applicable,
            agent_uuid, agent_name, store_uuid, store_name,
            organization_uuid, organization_name, state_uuid, state_name,
            sum_minor, payed_sum_minor, shipped_sum_minor,
            description, ms_updated, deleted_at, fetched_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,NOW())
        ON DUPLICATE KEY UPDATE
            doc_name = VALUES(doc_name),
            moment = VALUES(moment),
            applicable = VALUES(applicable),
            agent_uuid = VALUES(agent_uuid),
            agent_name = VALUES(agent_name),
            store_uuid = VALUES(store_uuid),
            store_name = VALUES(store_name),
            organization_uuid = VALUES(organization_uuid),
            organization_name = VALUES(organization_name),
            state_uuid = VALUES(state_uuid),
            state_name = VALUES(state_name),
            sum_minor = VALUES(sum_minor),
            payed_sum_minor = VALUES(payed_sum_minor),
            shipped_sum_minor = VALUES(shipped_sum_minor),
            description = VALUES(description),
            ms_updated = VALUES(ms_updated),
            deleted_at = NULL,
            fetched_at = NOW()
    `,
        [
            row.uuid,
            row.doc_name,
            row.moment,
            row.applicable,
            row.agent_uuid,
            row.agent_name,
            row.store_uuid,
            row.store_name,
            row.organization_uuid,
            row.organization_name,
            row.state_uuid,
            row.state_name,
            row.sum_minor,
            row.payed_sum_minor,
            row.shipped_sum_minor,
            row.description,
            row.ms_updated,
        ]
    );
}

function getSyncState() {
    return {
        active: jobState.active,
        cancel_requested: jobState.cancelRequested,
        started_at: jobState.started_at ? jobState.started_at.toISOString() : null,
        finished_at: jobState.finished_at ? jobState.finished_at.toISOString() : null,
        fetched: jobState.fetched,
        total: jobState.total,
        saved: jobState.saved,
        message: jobState.message,
        last_error: jobState.last_error,
        errors: jobState.errors.slice(-20),
        job_serial: jobState.job_serial,
        sync_script: getMsPurchaseOrdersSyncMeta(),
    };
}

function requestCancel() {
    if (jobState.active) jobState.cancelRequested = true;
}

/**
 * Фоновый синк шапок purchaseorder с moment >= sync_from.
 */
async function runPurchaseOrdersSync(db, appSettings, opts) {
    const o = opts && typeof opts === 'object' ? opts : {};
    const headers = getHeaders(o.config);
    if (!headers) {
        jobState.active = false;
        jobState.last_error = 'MS_TOKEN не задан';
        jobState.message = 'Ошибка: MS_TOKEN не задан';
        return { started: false, reason: 'no_token', error: 'MS_TOKEN не задан' };
    }

    jobState.active = true;
    jobState.cancelRequested = false;
    jobState.started_at = new Date();
    jobState.finished_at = null;
    jobState.fetched = 0;
    jobState.total = 0;
    jobState.saved = 0;
    jobState.message = 'Синхронизация заказов поставщикам…';
    jobState.last_error = null;
    jobState.errors = [];
    jobState.job_serial += 1;
    const serial = jobState.job_serial;

    const syncFrom = getSyncFromYmd(appSettings);
    const delayMs = getApiDelayMs(appSettings);
    const pageLimit = MS_PAGE_LIMIT;
    const momentFrom = syncFrom + ' 00:00:00';
    const today = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const momentTo =
        today.getFullYear() +
        '-' +
        pad(today.getMonth() + 1) +
        '-' +
        pad(today.getDate()) +
        ' 23:59:59';

    try {
        await ensureMsPurchaseOrderSchema(db);
        let offset = 0;
        while (true) {
            if (jobState.cancelRequested) break;
            const filter = `moment>=${momentFrom};moment<=${momentTo}`;
            const params = new URLSearchParams();
            params.set('expand', EXPAND);
            params.set('filter', filter);
            params.set('order', 'moment,desc');
            params.set('limit', String(pageLimit));
            params.set('offset', String(offset));
            const url = `${MS_BASE}/entity/purchaseorder?${params.toString()}`;
            const resp = await fetchPurchaseOrderPage(url, headers, {
                timeoutMs: MS_PAGE_TIMEOUT_MS,
                maxAttempts: MS_PAGE_MAX_ATTEMPTS,
                onAttempt: function (attempt, maxAttempts) {
                    if (attempt > 1) {
                        jobState.message =
                            `Заказы поставщикам: повтор ${attempt}/${maxAttempts} (offset ${offset})…`;
                    } else if (offset === 0) {
                        jobState.message = 'Заказы поставщикам: запрос к МойСклад…';
                    }
                },
            });
            const data = (resp && resp.data) || {};
            const rows = data.rows || [];
            if (offset === 0) {
                jobState.total = Number((data.meta && data.meta.size) || rows.length) || 0;
            }
            for (const doc of rows) {
                if (jobState.cancelRequested) break;
                jobState.fetched += 1;
                const row = rowFromMsDoc(doc);
                if (!row) continue;
                await upsertPurchaseOrder(db, row);
                jobState.saved += 1;
            }
            jobState.message = `Заказы поставщикам: ${jobState.fetched}/${jobState.total}, сохранено ${jobState.saved}`;
            offset += rows.length;
            if (!rows.length || rows.length < pageLimit) break;
            if (data.meta && data.meta.size != null && offset >= Number(data.meta.size)) break;
            if (delayMs > 0) await sleep(delayMs);
        }

        if (jobState.job_serial === serial) {
            jobState.active = false;
            jobState.finished_at = new Date();
            jobState.message = jobState.cancelRequested
                ? `Остановлено: сохранено ${jobState.saved}`
                : `Готово: ${jobState.saved} заказов (с ${syncFrom})`;
        }
        return { started: true, ok: !jobState.cancelRequested, state: getSyncState() };
    } catch (e) {
        if (jobState.job_serial === serial) {
            jobState.active = false;
            jobState.finished_at = new Date();
            jobState.last_error = (e && e.message) || String(e);
            jobState.message = 'Ошибка: ' + jobState.last_error;
            jobState.errors.push({ at: new Date().toISOString(), msg: jobState.last_error });
        }
        return { started: true, ok: false, error: jobState.last_error, state: getSyncState() };
    }
}

async function triggerSync(db, appSettings, opts) {
    const o = opts && typeof opts === 'object' ? opts : {};
    if (jobState.active) {
        return { started: false, reason: 'already_running', status: getSyncState() };
    }
    const headers = getHeaders(o.config);
    if (!headers) {
        return { started: false, reason: 'no_token', error: 'MS_TOKEN не задан', status: getSyncState() };
    }
    if (o.awaitCompletion) {
        const result = await runPurchaseOrdersSync(db, appSettings, o);
        return {
            started: !!result.started || result.ok === true || result.ok === false,
            ok: !!result.ok,
            error: result.error,
            status: result.state || getSyncState(),
        };
    }
    jobState.active = true;
    jobState.cancelRequested = false;
    jobState.started_at = new Date();
    jobState.finished_at = null;
    jobState.message = 'Стартует синхронизация…';
    jobState.last_error = null;
    setImmediate(() => {
        runPurchaseOrdersSync(db, appSettings, o).catch((e) => {
            console.error('[ms_purchase_orders] sync failed', e && e.message ? e.message : e);
            jobState.active = false;
            jobState.finished_at = new Date();
            jobState.last_error = (e && e.message) || String(e);
            jobState.message = 'Ошибка: ' + jobState.last_error;
        });
    });
    return { started: true, status: getSyncState() };
}

/** SQL: полностью оплачен. */
function sqlPaid() {
    return `(o.sum_minor > 0 AND COALESCE(o.payed_sum_minor, 0) >= o.sum_minor - 1)`;
}
/** SQL: ничего не принято (unshipped). */
function sqlUnshipped() {
    return `(o.sum_minor > 0 AND COALESCE(o.shipped_sum_minor, 0) <= 0)`;
}
/** SQL: частично принято. */
function sqlPartialShip() {
    return `(o.sum_minor > 0 AND COALESCE(o.shipped_sum_minor, 0) > 0 AND COALESCE(o.shipped_sum_minor, 0) < o.sum_minor - 1)`;
}

function sqlInUuids(column, uuids) {
    const list = (uuids || []).map((u) => String(u || '').toLowerCase()).filter(Boolean);
    if (!list.length) return { sql: ' AND 1=0', params: [] };
    return {
        sql: ` AND ${column} IN (${list.map(() => '?').join(',')})`,
        params: list,
    };
}

/**
 * Корзины A/B для финансов и stats.
 */
async function computePrepaidBuckets(db) {
    await ensureMsPurchaseOrderSchema(db);
    const storeA = sqlInUuids('o.store_uuid', DEFAULT_STORE_A);
    const storeB = sqlInUuids('o.store_uuid', DEFAULT_STORE_B);
    const stateB = sqlInUuids('o.state_uuid', DEFAULT_STATE_B);

    const [[a]] = await db.query(
        `
        SELECT
            COUNT(*) AS cnt,
            ROUND(COALESCE(SUM(o.sum_minor), 0) / 100, 2) AS amount
          FROM ms_purchase_order o
         WHERE o.deleted_at IS NULL
           AND ${sqlPaid()}
           AND ${sqlUnshipped()}
           ${storeA.sql}
    `,
        storeA.params
    );

    const [[b]] = await db.query(
        `
        SELECT
            COUNT(*) AS cnt,
            ROUND(COALESCE(SUM(GREATEST(0, o.sum_minor - COALESCE(o.shipped_sum_minor, 0))), 0) / 100, 2) AS amount,
            ROUND(COALESCE(SUM(o.sum_minor), 0) / 100, 2) AS sum_total,
            ROUND(COALESCE(SUM(o.shipped_sum_minor), 0) / 100, 2) AS shipped_total
          FROM ms_purchase_order o
         WHERE o.deleted_at IS NULL
           AND ${sqlPaid()}
           AND ${sqlPartialShip()}
           ${storeB.sql}
           ${stateB.sql}
    `,
        [...storeB.params, ...stateB.params]
    );

    const prepaid_full = Math.round((Number(a && a.amount) || 0) * 100) / 100;
    const prepaid_partial_gap = Math.round((Number(b && b.amount) || 0) * 100) / 100;
    const prepaid_total = Math.round((prepaid_full + prepaid_partial_gap) * 100) / 100;

    const [[fresh]] = await db.query(
        `SELECT MAX(fetched_at) AS as_of FROM ms_purchase_order WHERE deleted_at IS NULL`
    );

    return {
        prepaid_full,
        prepaid_partial_gap,
        prepaid_total,
        count_full: Number(a && a.cnt) || 0,
        count_partial: Number(b && b.cnt) || 0,
        partial_sum_total: Math.round((Number(b && b.sum_total) || 0) * 100) / 100,
        partial_shipped_total: Math.round((Number(b && b.shipped_total) || 0) * 100) / 100,
        as_of_at: fresh && fresh.as_of ? fresh.as_of : null,
        sync_script: getMsPurchaseOrdersSyncMeta(),
        buckets: {
            A: {
                label: 'Едет целиком',
                pay: 'paid',
                ship: 'unshipped',
                stores: DEFAULT_STORE_A.slice(),
            },
            B: {
                label: 'Недопринято',
                pay: 'paid',
                ship: 'partial',
                stores: DEFAULT_STORE_B.slice(),
                states: DEFAULT_STATE_B.slice(),
                formula: 'sum − shippedSum',
            },
        },
    };
}

async function loadPrepaidForFinance(db) {
    try {
        return await computePrepaidBuckets(db);
    } catch (e) {
        return {
            prepaid_full: 0,
            prepaid_partial_gap: 0,
            prepaid_total: 0,
            count_full: 0,
            count_partial: 0,
            as_of_at: null,
            sync_script: getMsPurchaseOrdersSyncMeta(),
            error: e && e.message ? String(e.message) : String(e),
        };
    }
}

function buildListWhere(query) {
    const where = ['o.deleted_at IS NULL'];
    const params = [];
    const q = query || {};

    const search = String(q.search || '').trim();
    if (search) {
        const like = '%' + search + '%';
        where.push(
            `(o.doc_name LIKE ? OR o.agent_name LIKE ? OR o.store_name LIKE ? OR o.state_name LIKE ? OR o.description LIKE ?)`
        );
        params.push(like, like, like, like, like);
    }

    const pay = String(q.pay_status || q.pay || '').trim().toLowerCase();
    if (pay === 'paid') where.push(sqlPaid());
    else if (pay === 'partial') {
        where.push(
            `(o.sum_minor > 0 AND COALESCE(o.payed_sum_minor, 0) > 0 AND COALESCE(o.payed_sum_minor, 0) < o.sum_minor - 1)`
        );
    } else if (pay === 'none') {
        where.push(`(o.sum_minor > 0 AND COALESCE(o.payed_sum_minor, 0) <= 0)`);
    }

    const ship = String(q.ship_status || q.ship || '').trim().toLowerCase();
    if (ship === 'none' || ship === 'unshipped') where.push(sqlUnshipped());
    else if (ship === 'partial') where.push(sqlPartialShip());
    else if (ship === 'shipped') {
        where.push(`(o.sum_minor > 0 AND COALESCE(o.shipped_sum_minor, 0) >= o.sum_minor - 1)`);
    }

    const store = String(q.store_uuid || q.store || '').trim().toLowerCase();
    if (store) {
        where.push('o.store_uuid = ?');
        params.push(store);
    }

    const state = String(q.state_uuid || q.state || '').trim().toLowerCase();
    if (state) {
        where.push('o.state_uuid = ?');
        params.push(state);
    }

    const preset = String(q.preset || '').trim().toUpperCase();
    if (preset === 'A') {
        where.push(sqlPaid());
        where.push(sqlUnshipped());
        const sa = sqlInUuids('o.store_uuid', DEFAULT_STORE_A);
        where.push(sa.sql.replace(/^\s*AND\s+/i, '').trim());
        params.push(...sa.params);
    } else if (preset === 'B') {
        where.push(sqlPaid());
        where.push(sqlPartialShip());
        const sb = sqlInUuids('o.store_uuid', DEFAULT_STORE_B);
        const st = sqlInUuids('o.state_uuid', DEFAULT_STATE_B);
        where.push(sb.sql.replace(/^\s*AND\s+/i, '').trim());
        params.push(...sb.params);
        where.push(st.sql.replace(/^\s*AND\s+/i, '').trim());
        params.push(...st.params);
    }

    return { sql: ' WHERE ' + where.join(' AND '), params };
}

async function listPurchaseOrders(db, query) {
    await ensureMsPurchaseOrderSchema(db);
    const limit = Math.max(1, Math.min(500, parseInt(String((query && query.limit) || '100'), 10) || 100));
    const offset = Math.max(0, parseInt(String((query && query.offset) || '0'), 10) || 0);
    const { sql, params } = buildListWhere(query);
    const sortMap = {
        moment: 'o.moment',
        name: 'o.doc_name',
        sum: 'o.sum_minor',
        payed: 'o.payed_sum_minor',
        shipped: 'o.shipped_sum_minor',
        gap: '(o.sum_minor - COALESCE(o.shipped_sum_minor, 0))',
        agent: 'o.agent_name',
        store: 'o.store_name',
    };
    const sortBy = sortMap[String((query && query.sort_by) || 'moment')] || 'o.moment';
    const sortDir = String((query && query.sort_dir) || 'desc').toLowerCase() === 'asc' ? 'ASC' : 'DESC';

    const [[tot]] = await db.query(
        `SELECT COUNT(*) AS n FROM ms_purchase_order o ${sql}`,
        params
    );
    const [rows] = await db.query(
        `
        SELECT o.uuid, o.doc_name, o.moment, o.applicable,
               o.agent_uuid, o.agent_name, o.store_uuid, o.store_name,
               o.state_uuid, o.state_name,
               o.sum_minor, o.payed_sum_minor, o.shipped_sum_minor,
               GREATEST(0, o.sum_minor - COALESCE(o.shipped_sum_minor, 0)) AS gap_minor,
               o.description, o.fetched_at
          FROM ms_purchase_order o
          ${sql}
         ORDER BY ${sortBy} ${sortDir}, o.uuid ASC
         LIMIT ? OFFSET ?
    `,
        [...params, limit, offset]
    );

    const data = (rows || []).map((r) => {
        const sum = Number(r.sum_minor) || 0;
        const payed = Number(r.payed_sum_minor) || 0;
        const shipped = Number(r.shipped_sum_minor) || 0;
        const gap = Number(r.gap_minor) || 0;
        return {
            uuid: r.uuid,
            name: r.doc_name,
            moment: r.moment,
            applicable: !!r.applicable,
            agent_name: r.agent_name,
            store_uuid: r.store_uuid,
            store_name: r.store_name,
            state_uuid: r.state_uuid,
            state_name: r.state_name,
            sum: Math.round(sum) / 100,
            payed: Math.round(payed) / 100,
            shipped: Math.round(shipped) / 100,
            gap: Math.round(gap) / 100,
            description: r.description,
            ms_url: `https://online.moysklad.ru/app/#purchaseorder/edit?id=${r.uuid}`,
            fetched_at: r.fetched_at,
        };
    });

    return {
        success: true,
        total: Number(tot && tot.n) || 0,
        limit,
        offset,
        data,
        sync_script: getMsPurchaseOrdersSyncMeta(),
    };
}

async function listFilterOptions(db) {
    await ensureMsPurchaseOrderSchema(db);
    const [stores] = await db.query(`
        SELECT store_uuid AS uuid, MAX(store_name) AS name, COUNT(*) AS n
          FROM ms_purchase_order
         WHERE deleted_at IS NULL AND store_uuid IS NOT NULL
         GROUP BY store_uuid
         ORDER BY name
    `);
    const [states] = await db.query(`
        SELECT state_uuid AS uuid, MAX(state_name) AS name, COUNT(*) AS n
          FROM ms_purchase_order
         WHERE deleted_at IS NULL AND state_uuid IS NOT NULL
         GROUP BY state_uuid
         ORDER BY name
    `);
    return { stores: stores || [], states: states || [] };
}

module.exports = {
    DEFAULT_STORE_A,
    DEFAULT_STORE_B,
    DEFAULT_STATE_B,
    DEFAULT_SYNC_FROM,
    ensureMsPurchaseOrderSchema,
    runPurchaseOrdersSync,
    triggerSync,
    requestCancel,
    getSyncState,
    computePrepaidBuckets,
    loadPrepaidForFinance,
    listPurchaseOrders,
    listFilterOptions,
    getMsPurchaseOrdersSyncMeta,
    getSyncFromYmd,
};
