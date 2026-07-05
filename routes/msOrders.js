/**
 * MS Orders — страница «Заказы в МС»: entity/customerorder из МойСклад API.
 * Локальные таблицы ms_customer_order + ms_customer_order_position.
 * Окно синка и списка — из `ms_orders_sync_days` (настройки, 1..365, default 30).
 */

const express = require('express');
const axios = require('axios');
const config = require('../config');
const {
    parseExcludeOwnerNames,
    isOwnerNameExcluded,
    buildOwnerExcludeWhere,
    purgeExcludedOrders,
} = require('../lib/msOrdersOwnerExclude');
const { loadMsOrdersDataFreshness } = require('../lib/datagonMsOrdersDataFreshness');
const { parseUuidList } = require('../lib/datagonSalesFormulaDemandFilter');
const {
    ensureMsExportStockByStoreSchema,
    msOrderPositionStockExpr,
} = require('../lib/msExportStockByStore');

const MS_BASE_URL = 'https://api.moysklad.ru/api/remap/1.2';
const DEFAULT_MS_ORDERS_SYNC_DAYS = 30;
const MAX_ORDER_DAYS_ABS = 365;

let schemaReady = false;

async function ensureSchema(db) {
    if (schemaReady) return;

    await ensureMsExportStockByStoreSchema(db);

    await db.query(`
        CREATE TABLE IF NOT EXISTS ms_customer_order (
            uuid VARCHAR(36) NOT NULL PRIMARY KEY,
            doc_name VARCHAR(64) NOT NULL,
            moment DATETIME NOT NULL,
            applicable TINYINT(1) NOT NULL DEFAULT 1,
            agent_uuid VARCHAR(36) NULL,
            agent_name VARCHAR(255) NULL,
            store_uuid VARCHAR(36) NULL,
            store_name VARCHAR(150) NULL,
            organization_uuid VARCHAR(36) NULL,
            organization_name VARCHAR(150) NULL,
            project_uuid VARCHAR(36) NULL,
            project_name VARCHAR(150) NULL,
            state_uuid VARCHAR(36) NULL,
            state_name VARCHAR(150) NULL,
            owner_uuid VARCHAR(36) NULL,
            owner_name VARCHAR(150) NULL,
            sum_minor BIGINT NOT NULL DEFAULT 0,
            payed_sum_minor BIGINT NOT NULL DEFAULT 0,
            shipped_sum_minor BIGINT NOT NULL DEFAULT 0,
            positions_count INT NOT NULL DEFAULT 0,
            description TEXT NULL,
            ms_created DATETIME NULL,
            ms_updated DATETIME NULL,
            deleted_at TIMESTAMP NULL DEFAULT NULL,
            payload_json JSON NULL,
            fetched_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            INDEX idx_moment (moment),
            INDEX idx_agent (agent_uuid),
            INDEX idx_store (store_uuid),
            INDEX idx_owner (owner_uuid),
            INDEX idx_deleted_at (deleted_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await db.query(`
        CREATE TABLE IF NOT EXISTS ms_customer_order_position (
            id BIGINT AUTO_INCREMENT PRIMARY KEY,
            order_uuid VARCHAR(36) NOT NULL,
            position_uuid VARCHAR(36) NOT NULL,
            pack_idx INT NOT NULL DEFAULT 0,
            assortment_kind VARCHAR(20) NOT NULL DEFAULT 'unknown',
            assortment_uuid VARCHAR(36) NULL,
            product_uuid VARCHAR(36) NULL,
            ms_export_code VARCHAR(64) NULL,
            ms_export_uuid VARCHAR(36) NULL,
            ms_export_resolved TINYINT(1) NOT NULL DEFAULT 0,
            name_at_moment VARCHAR(500) NOT NULL DEFAULT '',
            code_at_moment VARCHAR(64) NULL,
            quantity DECIMAL(15,3) NOT NULL DEFAULT 0,
            shipped DECIMAL(15,3) NOT NULL DEFAULT 0,
            price_minor BIGINT NOT NULL DEFAULT 0,
            discount DECIMAL(7,3) NOT NULL DEFAULT 0,
            vat INT NOT NULL DEFAULT 0,
            sum_minor BIGINT NOT NULL DEFAULT 0,
            UNIQUE KEY uk_order_pos (order_uuid, position_uuid),
            INDEX idx_order (order_uuid),
            INDEX idx_ms_export_code (ms_export_code)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    try {
        await db.query(
            'ALTER TABLE ms_customer_order_position ADD COLUMN shipped DECIMAL(15,3) NOT NULL DEFAULT 0 AFTER quantity',
        );
    } catch (e) {
        if (!String(e && e.message).includes('Duplicate column')) throw e;
    }

    schemaReady = true;
}

function clampInt(value, min, max, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, Math.floor(n)));
}

function getMsOrdersSyncDaysLimit(appSettings) {
    return clampInt(
        appSettings && appSettings.ms_orders_sync_days,
        1,
        MAX_ORDER_DAYS_ABS,
        DEFAULT_MS_ORDERS_SYNC_DAYS,
    );
}

function clampOrderDays(value, appSettings) {
    const limit = getMsOrdersSyncDaysLimit(appSettings);
    return clampInt(value, 1, limit, limit);
}

function getMsToken() {
    return process.env.MS_TOKEN || (config && config.msToken) || '';
}

function getMsHeaders() {
    const token = getMsToken();
    if (!token) return null;
    return {
        Authorization: 'Bearer ' + token,
        'Content-Type': 'application/json',
        Accept: 'application/json;charset=utf-8',
    };
}

function parseAssortmentHref(href) {
    if (!href) return { kind: 'unknown', uuid: null };
    const m = String(href).match(/\/entity\/([a-zA-Z]+)\/([0-9a-f-]+)(?:\?|$)/i);
    if (!m) return { kind: 'unknown', uuid: null };
    return { kind: String(m[1]).toLowerCase(), uuid: String(m[2]).toLowerCase() };
}

function parseMomentToDate(s) {
    if (!s) return null;
    const str = String(s).replace(/\.\d+$/, '');
    const d = new Date(str.replace(' ', 'T') + '+03:00');
    return Number.isNaN(d.getTime()) ? null : d;
}

function moneyToMinor(v) {
    if (v == null) return 0;
    const n = Number(v);
    if (!Number.isFinite(n)) return 0;
    return Math.round(n);
}

function composeOwnerName(owner) {
    if (!owner) return '';
    const composed = [owner.lastName, owner.firstName, owner.middleName]
        .filter(Boolean)
        .map((s) => String(s).trim())
        .filter(Boolean)
        .join(' ')
        .trim();
    return composed || (owner.name ? String(owner.name) : '');
}

function getExcludePatterns(appSettings) {
    return parseExcludeOwnerNames(appSettings && appSettings.ms_orders_exclude_owner_names);
}

let jobSerial = 0;
const jobState = {
    active: false,
    job_serial: 0,
    cancelRequested: false,
    started_at: null,
    finished_at: null,
    days: DEFAULT_MS_ORDERS_SYNC_DAYS,
    fetched_orders: 0,
    total_orders: 0,
    skipped_excluded: 0,
    saved_orders: 0,
    saved_positions: 0,
    message: 'Ожидание',
    errors: [],
    last_error: null,
};

function resetJobState(days) {
    jobSerial += 1;
    const serial = jobSerial;
    jobState.job_serial = serial;
    jobState.active = true;
    jobState.cancelRequested = false;
    jobState.started_at = new Date();
    jobState.finished_at = null;
    jobState.days = days;
    jobState.fetched_orders = 0;
    jobState.total_orders = 0;
    jobState.skipped_excluded = 0;
    jobState.saved_orders = 0;
    jobState.saved_positions = 0;
    jobState.message = 'Стартует синхронизация…';
    jobState.errors = [];
    jobState.last_error = null;
    return serial;
}

function finalizeJob(serial, outcome, err) {
    if (jobState.job_serial !== serial) return;
    jobState.active = false;
    jobState.finished_at = new Date();
    if (outcome === 'ok') {
        jobState.message =
            'Готово: ' + jobState.fetched_orders + '/' + jobState.total_orders +
            ' заказов, сохранено ' + jobState.saved_orders +
            ', позиций ' + jobState.saved_positions +
            (jobState.skipped_excluded ? '; пропущено (исключённые): ' + jobState.skipped_excluded : '');
    } else {
        jobState.last_error = (err && err.message) || 'unknown';
        jobState.message = 'Ошибка: ' + jobState.last_error;
    }
}

function jobStateToPayload() {
    return {
        active: jobState.active,
        cancel_requested: jobState.cancelRequested,
        started_at: jobState.started_at ? jobState.started_at.toISOString() : null,
        finished_at: jobState.finished_at ? jobState.finished_at.toISOString() : null,
        days: jobState.days,
        fetched_orders: jobState.fetched_orders,
        total_orders: jobState.total_orders,
        skipped_excluded: jobState.skipped_excluded,
        saved_orders: jobState.saved_orders,
        saved_positions: jobState.saved_positions,
        message: jobState.message,
        errors: jobState.errors.slice(-20),
        last_error: jobState.last_error,
        job_serial: jobState.job_serial,
    };
}

function logJobError(msg) {
    jobState.errors.push({ at: new Date().toISOString(), msg: String(msg || '') });
    jobState.last_error = String(msg || '');
}

function isTransientAxiosError(err) {
    if (!err) return false;
    const status = err.response && err.response.status;
    if (!status) return true;
    if (status === 408 || status === 429) return true;
    return status >= 500 && status < 600;
}

function getSyncPageLimit(appSettings) {
    /** С expand positions тяжёлые страницы — не больше 100 (лимит МС API на list). */
    const raw = Number(appSettings && appSettings.ms_sync_page_limit);
    const n = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 100;
    return Math.max(25, Math.min(100, n));
}

/** МС ~5 req/s на токен; пауза между страницами list — не меньше 150 ms. */
function getApiDelayMs(appSettings) {
    const raw = Number(appSettings && appSettings.ms_sync_delay_ms);
    const configured = Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 200;
    return Math.max(150, configured);
}

/** Лёгкий list без positions — можно чаще общего ms_sync_delay_ms (до ~4 req/s). */
function getMsOrdersListDelayMs(appSettings) {
    return Math.min(getApiDelayMs(appSettings), 250);
}

const ORDERS_LIST_EXPAND_LIGHT =
    'agent,store,organization,project,state,owner,rate.currency';
const ORDERS_DETAIL_EXPAND =
    ORDERS_LIST_EXPAND_LIGHT + ',positions.assortment,positions.assortment.product';
const MS_ORDERS_DETAIL_CONCURRENCY = 4;
const MS_ORDERS_DETAIL_GAP_MS = 80;

function formatSyncProgressMessage() {
    return 'Заказы: ' + jobState.fetched_orders + '/' + jobState.total_orders +
        '; сохранено: ' + jobState.saved_orders +
        '; позиций: ' + jobState.saved_positions +
        (jobState.skipped_excluded ? '; пропущено: ' + jobState.skipped_excluded : '');
}

function touchSyncProgressMessage() {
    jobState.message = formatSyncProgressMessage();
}

function collectAssortmentUuidsFromPositions(positions) {
    const uuids = [];
    for (const p of positions || []) {
        const a = (p && p.assortment) || {};
        const href = a.meta && a.meta.href ? String(a.meta.href) : '';
        const parsed = parseAssortmentHref(href);
        if (parsed.uuid) uuids.push(parsed.uuid);
        if (parsed.kind === 'variant' && a.product && a.product.meta) {
            const pp = parseAssortmentHref(String(a.product.meta.href || ''));
            if (pp.uuid) uuids.push(pp.uuid);
        }
    }
    return uuids;
}

async function fetchOrdersPage(headers, momentFrom, momentTo, offset, limit, expand) {
    const filter = ['moment>=' + momentFrom, 'moment<=' + momentTo].join(';');
    const params = new URLSearchParams();
    params.set('expand', expand || ORDERS_LIST_EXPAND_LIGHT);
    params.set('filter', filter);
    params.set('order', 'moment,desc');
    params.set('limit', String(limit));
    params.set('offset', String(offset));
    const url = MS_BASE_URL + '/entity/customerorder?' + params.toString();
    const resp = await axios.get(url, { headers, timeout: 90000 });
    return resp && resp.data ? resp.data : { rows: [], meta: { size: 0 } };
}

async function fetchOrderDetail(headers, orderUuid) {
    const uuid = String(orderUuid || '').toLowerCase();
    if (!uuid) return null;
    const params = new URLSearchParams();
    params.set('expand', ORDERS_DETAIL_EXPAND);
    const url = MS_BASE_URL + '/entity/customerorder/' + uuid + '?' + params.toString();
    const resp = await axios.get(url, { headers, timeout: 90000 });
    return resp && resp.data ? resp.data : null;
}

async function fetchOrderDetailResilient(headers, orderUuid) {
    const STEPS = [{ delay: 0 }, { delay: 2000 }, { delay: 5000 }];
    let lastErr = null;
    for (let i = 0; i < STEPS.length; i++) {
        if (jobState.cancelRequested) {
            const e = new Error('Остановлено пользователем');
            e.code = 'CANCELLED';
            throw e;
        }
        if (STEPS[i].delay > 0) {
            await new Promise((r) => setTimeout(r, STEPS[i].delay));
        }
        try {
            return await fetchOrderDetail(headers, orderUuid);
        } catch (e) {
            lastErr = e;
            if (!isTransientAxiosError(e)) throw e;
        }
    }
    throw lastErr || new Error('fetchOrderDetail: исчерпаны попытки');
}

async function fetchOrderDetailsBatch(headers, orderIds) {
    const ids = (orderIds || []).map((id) => String(id || '').toLowerCase()).filter(Boolean);
    if (!ids.length) return [];
    const results = [];
    let cursor = 0;

    async function worker() {
        while (true) {
            if (jobState.cancelRequested) return;
            const idx = cursor;
            cursor += 1;
            if (idx >= ids.length) return;
            const id = ids[idx];
            try {
                const doc = await fetchOrderDetailResilient(headers, id);
                if (doc) results.push(doc);
            } catch (e) {
                if (e && e.code === 'CANCELLED') throw e;
                logJobError('order ' + id + ': ' + ((e && e.message) || 'err'));
            }
            if (MS_ORDERS_DETAIL_GAP_MS > 0) {
                await new Promise((r) => setTimeout(r, MS_ORDERS_DETAIL_GAP_MS));
            }
        }
    }

    const workers = Math.min(MS_ORDERS_DETAIL_CONCURRENCY, ids.length);
    await Promise.all(Array.from({ length: workers }, () => worker()));
    return results;
}

async function fetchOrdersPageResilient(headers, momentFrom, momentTo, offset, limit, expand) {
    const STEPS = [
        { delay: 0, limit },
        { delay: 2000, limit },
        { delay: 5000, limit: Math.max(25, Math.floor(limit / 2)) },
        { delay: 12000, limit: Math.max(25, Math.floor(limit / 4)) },
    ];
    let lastErr = null;
    for (let i = 0; i < STEPS.length; i++) {
        if (jobState.cancelRequested) {
            const e = new Error('Остановлено пользователем');
            e.code = 'CANCELLED';
            throw e;
        }
        if (STEPS[i].delay > 0) {
            jobState.message =
                'Сетевая ошибка МС API: повтор ' + (i + 1) + '/' + STEPS.length +
                ' offset=' + offset + ' limit=' + STEPS[i].limit + '…';
            await new Promise((r) => setTimeout(r, STEPS[i].delay));
            if (jobState.cancelRequested) {
                const e = new Error('Остановлено пользователем');
                e.code = 'CANCELLED';
                throw e;
            }
        }
        try {
            const data = await fetchOrdersPage(
                headers, momentFrom, momentTo, offset, STEPS[i].limit, expand,
            );
            return { data, usedLimit: STEPS[i].limit };
        } catch (e) {
            lastErr = e;
            if (!isTransientAxiosError(e)) throw e;
            console.warn('[ms-orders] retry ' + (i + 1) + '/' + STEPS.length +
                ' offset=' + offset + ': ' + ((e && e.message) || 'unknown'));
        }
    }
    throw lastErr || new Error('fetchOrdersPage: исчерпаны попытки');
}

async function resolveAssortmentToMsExport(db, uuids) {
    const cleaned = Array.from(new Set((uuids || []).filter(Boolean).map((u) => String(u).toLowerCase())));
    if (cleaned.length === 0) return new Map();
    const placeholders = cleaned.map(() => '?').join(',');
    const [rows] = await db.query(
        'SELECT uuid, code FROM ms_export WHERE uuid IN (' + placeholders + ')',
        cleaned,
    );
    const map = new Map();
    for (const r of rows) {
        if (r && r.uuid) map.set(String(r.uuid).toLowerCase(), { code: String(r.code || ''), uuid: String(r.uuid) });
    }
    return map;
}

async function persistOrder(db, doc) {
    const uuid = String(doc.id || '').toLowerCase();
    if (!uuid) throw new Error('Order без id');

    const moment = parseMomentToDate(doc.moment);
    const agent = doc.agent || {};
    const store = doc.store || {};
    const organization = doc.organization || {};
    const project = doc.project || {};
    const state = doc.state || {};
    const owner = doc.owner || {};
    const ownerName = composeOwnerName(owner);

    let payloadJson = null;
    try {
        const payload = Object.assign({}, doc);
        delete payload.positions;
        payloadJson = JSON.stringify(payload);
    } catch (_e) {
        payloadJson = null;
    }

    const positionsCount = (doc.positions && Array.isArray(doc.positions.rows))
        ? doc.positions.rows.length
        : (doc.positions && doc.positions.meta && Number.isFinite(Number(doc.positions.meta.size))
            ? Number(doc.positions.meta.size)
            : 0);

    await db.query(
        `INSERT INTO ms_customer_order (
            uuid, doc_name, moment, applicable,
            agent_uuid, agent_name, store_uuid, store_name,
            organization_uuid, organization_name, project_uuid, project_name,
            state_uuid, state_name, owner_uuid, owner_name,
            sum_minor, payed_sum_minor, shipped_sum_minor, positions_count,
            description, ms_created, ms_updated, payload_json, deleted_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
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
            project_uuid = VALUES(project_uuid),
            project_name = VALUES(project_name),
            state_uuid = VALUES(state_uuid),
            state_name = VALUES(state_name),
            owner_uuid = VALUES(owner_uuid),
            owner_name = VALUES(owner_name),
            sum_minor = VALUES(sum_minor),
            payed_sum_minor = VALUES(payed_sum_minor),
            shipped_sum_minor = VALUES(shipped_sum_minor),
            positions_count = VALUES(positions_count),
            description = VALUES(description),
            ms_created = VALUES(ms_created),
            ms_updated = VALUES(ms_updated),
            payload_json = VALUES(payload_json),
            deleted_at = NULL`,
        [
            uuid,
            String(doc.name || '').slice(0, 64),
            moment || new Date(),
            doc.applicable === false ? 0 : 1,
            agent.id ? String(agent.id).toLowerCase() : null,
            agent.name ? String(agent.name).slice(0, 255) : null,
            store.id ? String(store.id).toLowerCase() : null,
            store.name ? String(store.name).slice(0, 150) : null,
            organization.id ? String(organization.id).toLowerCase() : null,
            organization.name ? String(organization.name).slice(0, 150) : null,
            project.id ? String(project.id).toLowerCase() : null,
            project.name ? String(project.name).slice(0, 150) : null,
            state.id ? String(state.id).toLowerCase() : null,
            state.name ? String(state.name).slice(0, 150) : null,
            owner.id ? String(owner.id).toLowerCase() : null,
            ownerName ? String(ownerName).slice(0, 150) : null,
            moneyToMinor(doc.sum),
            moneyToMinor(doc.payedSum),
            moneyToMinor(doc.shippedSum),
            positionsCount,
            doc.description ? String(doc.description) : null,
            parseMomentToDate(doc.created),
            parseMomentToDate(doc.updated),
            payloadJson,
        ],
    );
    return uuid;
}

async function persistPositions(db, orderUuid, positions, resolvedMap) {
    await db.query('DELETE FROM ms_customer_order_position WHERE order_uuid = ?', [orderUuid]);
    if (!Array.isArray(positions) || positions.length === 0) {
        return { saved: 0, resolved: 0, unresolved: 0 };
    }

    const insertRows = [];
    let resolvedCount = 0;
    let unresolvedCount = 0;

    for (let i = 0; i < positions.length; i++) {
        const p = positions[i] || {};
        const positionUuid = String(p.id || '').toLowerCase();
        if (!positionUuid) continue;

        const assortment = p.assortment || {};
        const href = assortment.meta && assortment.meta.href ? String(assortment.meta.href) : '';
        const parsed = parseAssortmentHref(href);

        let productUuid = null;
        if (parsed.kind === 'variant' && assortment.product && assortment.product.meta) {
            const pp = parseAssortmentHref(String(assortment.product.meta.href || ''));
            if (pp.kind === 'product' && pp.uuid) productUuid = pp.uuid;
        }

        let resolvedCode = null;
        let resolvedUuid = null;
        let isResolved = 0;
        const tryUuids = [];
        if (parsed.uuid) tryUuids.push(parsed.uuid);
        if (productUuid && productUuid !== parsed.uuid) tryUuids.push(productUuid);
        for (const u of tryUuids) {
            const hit = resolvedMap.get(u);
            if (hit) {
                resolvedCode = hit.code;
                resolvedUuid = hit.uuid;
                isResolved = 1;
                break;
            }
        }
        if (isResolved) resolvedCount++;
        else unresolvedCount++;

        const quantity = Number(p.quantity || 0);
        const shipped = Number(p.shipped || 0);
        const priceMinor = moneyToMinor(p.price);
        const discount = Number(p.discount || 0);
        const vat = Math.round(Number(p.vat || 0));
        const sumOnePosMinor = Math.round(priceMinor * quantity * (1 - Math.min(100, Math.max(0, discount)) / 100));

        insertRows.push([
            orderUuid, positionUuid, i,
            parsed.kind, parsed.uuid, productUuid,
            resolvedCode, resolvedUuid, isResolved,
            String(assortment.name || p.name || '').slice(0, 500),
            assortment.code ? String(assortment.code).slice(0, 64) : null,
            quantity, shipped, priceMinor, discount, vat, sumOnePosMinor,
        ]);
    }

    if (insertRows.length === 0) return { saved: 0, resolved: 0, unresolved: 0 };

    const COLS = 17;
    const BATCH = 500;
    for (let off = 0; off < insertRows.length; off += BATCH) {
        const slice = insertRows.slice(off, off + BATCH);
        const placeholders = slice.map(() => '(' + Array(COLS).fill('?').join(',') + ')').join(',');
        const flat = [];
        slice.forEach((r) => flat.push.apply(flat, r));
        await db.query(
            `INSERT INTO ms_customer_order_position
                (order_uuid, position_uuid, pack_idx,
                 assortment_kind, assortment_uuid, product_uuid,
                 ms_export_code, ms_export_uuid, ms_export_resolved,
                 name_at_moment, code_at_moment,
                 quantity, shipped, price_minor, discount, vat, sum_minor)
             VALUES ${placeholders}`,
            flat,
        );
    }

    return { saved: insertRows.length, resolved: resolvedCount, unresolved: unresolvedCount };
}

async function runOrderSync(db, days, appSettings) {
    const headers = getMsHeaders();
    if (!headers) {
        const e = new Error('MS_TOKEN не задан (env MS_TOKEN или config.msToken)');
        e.code = 'NO_TOKEN';
        throw e;
    }

    const excludePatterns = getExcludePatterns(appSettings);
    const purged = await purgeExcludedOrders(db, excludePatterns);
    if (purged > 0) {
        jobState.message = 'Удалено ранее импортированных заказов (исключённые): ' + purged + '…';
    }

    const now = new Date();
    const from = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
    const fmt = (d) => {
        const pad = (n) => String(n).padStart(2, '0');
        return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' +
            pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
    };
    const momentFrom = fmt(from);
    const momentTo = fmt(now);
    const PAGE = getSyncPageLimit(appSettings);
    const apiDelayMs = getMsOrdersListDelayMs(appSettings);

    let offset = 0;
    let totalSize = null;
    const seenUuids = new Set();

    while (true) {
        if (jobState.cancelRequested) {
            const e = new Error('Остановлено пользователем');
            e.code = 'CANCELLED';
            throw e;
        }

        let data;
        let usedLimit;
        try {
            ({ data, usedLimit } = await fetchOrdersPageResilient(
                headers, momentFrom, momentTo, offset, PAGE, ORDERS_LIST_EXPAND_LIGHT,
            ));
        } catch (e) {
            if (e && e.code === 'CANCELLED') throw e;
            logJobError('страница offset=' + offset + ': ' + ((e && e.message) || 'err'));
            throw e;
        }

        const rows = (data && data.rows) || [];
        if (totalSize == null && data && data.meta && data.meta.size != null) {
            totalSize = Number(data.meta.size);
            jobState.total_orders = Number.isFinite(totalSize) ? totalSize : rows.length;
        }

        /** Лёгкий list (без positions): исключённые не тянут позиции; детали — только для eligible. */
        const eligible = [];
        for (const doc of rows) {
            jobState.fetched_orders++;
            const ownerName = composeOwnerName(doc.owner || {});
            if (isOwnerNameExcluded(ownerName, excludePatterns)) {
                jobState.skipped_excluded++;
                continue;
            }
            eligible.push(doc);
        }

        if (eligible.length) {
            const fullDocs = await fetchOrderDetailsBatch(
                headers,
                eligible.map((doc) => doc.id),
            );
            const assortmentUuids = [];
            for (const doc of fullDocs) {
                assortmentUuids.push.apply(
                    assortmentUuids,
                    collectAssortmentUuidsFromPositions((doc.positions && doc.positions.rows) || []),
                );
            }
            const resolvedMap = await resolveAssortmentToMsExport(db, assortmentUuids);

            for (const doc of fullDocs) {
                if (jobState.cancelRequested) break;
                try {
                    const positions = (doc.positions && doc.positions.rows) || [];
                    const orderUuid = await persistOrder(db, doc);
                    seenUuids.add(orderUuid);
                    const posStats = await persistPositions(db, orderUuid, positions, resolvedMap);
                    jobState.saved_orders++;
                    jobState.saved_positions += posStats.saved;
                } catch (e) {
                    logJobError('order ' + (doc && doc.id) + ': ' + ((e && e.message) || 'err'));
                }
            }
        }

        if (jobState.fetched_orders % 25 === 0 || jobState.fetched_orders === jobState.total_orders) {
            touchSyncProgressMessage();
        }

        offset += rows.length;
        if (totalSize != null && offset >= totalSize) break;
        if (rows.length < usedLimit) break;
        if (apiDelayMs > 0) await new Promise((r) => setTimeout(r, apiDelayMs));
    }

    return jobStateToPayload();
}

/** @param {object} query — `applicable_values=0,1` или legacy `applicable=0|1`; пусто/оба = без фильтра */
function parseApplicableValues(query) {
    const raw = query && (query.applicable_values != null ? query.applicable_values : query.applicable);
    if (raw == null || raw === '') return [];
    const s = String(raw).trim();
    if (!s) return [];
    const parts = s.split(',').map((x) => x.trim()).filter((x) => x === '0' || x === '1');
    return [...new Set(parts)];
}

const PAY_STATUS_ALLOWED = new Set(['paid', 'partial', 'none']);

/** @param {object} query — `pay_statuses=paid,partial,none` или legacy `pay_status=paid` */
function parsePayStatuses(query) {
    const raw = query && (query.pay_statuses != null ? query.pay_statuses : query.pay_status);
    if (raw == null || raw === '') return [];
    const parts = String(raw).split(',').map((x) => x.trim().toLowerCase()).filter((x) => PAY_STATUS_ALLOWED.has(x));
    return [...new Set(parts)];
}

/** SQL для фильтра оплаты; пустой массив или все три — без ограничения. */
function buildPayStatusWhere(statuses) {
    return buildSumMinorStatusWhere(statuses, 'payed_sum_minor', PAY_STATUS_ALLOWED);
}

const SHIP_STATUS_ALLOWED = new Set(['shipped', 'partial', 'none']);

/** @param {object} query — `ship_statuses=shipped,partial,none` или legacy `ship_status=shipped` */
function parseShipStatuses(query) {
    const raw = query && (query.ship_statuses != null ? query.ship_statuses : query.ship_status);
    if (raw == null || raw === '') return [];
    const parts = String(raw).split(',').map((x) => x.trim().toLowerCase()).filter((x) => SHIP_STATUS_ALLOWED.has(x));
    return [...new Set(parts)];
}

/** @param {Set<string>} allowed — ключ «полностью» (`paid` / `shipped`) + `partial` + `none` */
function buildSumMinorStatusWhere(statuses, sumMinorColumn, allowed) {
    if (!statuses.length || statuses.length >= allowed.size) {
        return { sql: '', params: [] };
    }
    const fullKey = allowed.has('paid') ? 'paid' : 'shipped';
    const col = sumMinorColumn;
    const clauses = [];
    const sumCol = `COALESCE(o.${col}, 0)`;
    if (statuses.includes(fullKey)) {
        clauses.push(`(o.sum_minor > 0 AND ${sumCol} >= o.sum_minor - 1)`);
    }
    if (statuses.includes('partial')) {
        clauses.push(`(o.sum_minor > 0 AND ${sumCol} > 0 AND ${sumCol} < o.sum_minor - 1)`);
    }
    if (statuses.includes('none')) {
        clauses.push(`(o.sum_minor > 0 AND ${sumCol} <= 0)`);
    }
    if (!clauses.length) return { sql: '', params: [] };
    return { sql: ' AND (' + clauses.join(' OR ') + ')', params: [] };
}

function buildShipStatusWhere(statuses) {
    return buildSumMinorStatusWhere(statuses, 'shipped_sum_minor', SHIP_STATUS_ALLOWED);
}

const STOCK_STATUS_ALLOWED = new Set(['all', 'partial', 'none', 'none_pending']);

/** @param {object} query — `stock_statuses=all,partial,none,none_pending` */
function parseStockStatuses(query) {
    const raw = query && query.stock_statuses;
    if (raw == null || raw === '') return [];
    const parts = String(raw).split(',').map((x) => x.trim().toLowerCase()).filter((x) => STOCK_STATUS_ALLOWED.has(x));
    return [...new Set(parts)];
}

/** Фильтр по колонке «Статус» (остатки позиций); требует JOIN stk. */
function buildStockStatusWhere(statuses) {
    if (!statuses.length || statuses.length >= STOCK_STATUS_ALLOWED.size) {
        return { sql: '', params: [], needsStockJoin: false };
    }
    const pending = 'COALESCE(stk.stock_pending_count, 0)';
    const ok = 'COALESCE(stk.stock_ok_count, 0)';
    const clauses = [];
    if (statuses.includes('none_pending')) {
        clauses.push(`(${pending} <= 0)`);
    }
    if (statuses.includes('none')) {
        clauses.push(`(${pending} > 0 AND ${ok} <= 0)`);
    }
    if (statuses.includes('all')) {
        clauses.push(`(${pending} > 0 AND ${ok} >= ${pending})`);
    }
    if (statuses.includes('partial')) {
        clauses.push(`(${pending} > 0 AND ${ok} > 0 AND ${ok} < ${pending})`);
    }
    if (!clauses.length) return { sql: '', params: [], needsStockJoin: false };
    return { sql: ' AND (' + clauses.join(' OR ') + ')', params: [], needsStockJoin: true };
}

/** Остаток на складе заказа (store_uuid); без склада — суммарный ms_export.stock. */
const STOCK_AGG_JOIN = `
LEFT JOIN (
  SELECT p.order_uuid,
         SUM(CASE WHEN GREATEST(p.quantity - p.shipped, 0) > 0 THEN 1 ELSE 0 END) AS stock_pending_count,
         SUM(CASE
           WHEN GREATEST(p.quantity - p.shipped, 0) <= 0 THEN 0
           WHEN p.ms_export_resolved = 1
                AND ${msOrderPositionStockExpr('o2')} IS NOT NULL
                AND ${msOrderPositionStockExpr('o2')} >= GREATEST(p.quantity - p.shipped, 0) THEN 1
           ELSE 0
         END) AS stock_ok_count
    FROM ms_customer_order_position p
    INNER JOIN ms_customer_order o2 ON o2.uuid = p.order_uuid
    LEFT JOIN ms_export e ON e.code = p.ms_export_code
    LEFT JOIN ms_export_stock_by_store ss
      ON ss.code = p.ms_export_code AND ss.store_uuid = o2.store_uuid
   GROUP BY p.order_uuid
) stk ON stk.order_uuid = o.uuid`;

function computeStockStatus(stockOk, stockPending) {
    const ok = Number(stockOk || 0);
    const pending = Number(stockPending || 0);
    if (pending <= 0) {
        return { stock_ok_count: ok, stock_pending_count: pending, stock_status: '—', stock_status_key: 'none_pending' };
    }
    if (ok <= 0) {
        return { stock_ok_count: ok, stock_pending_count: pending, stock_status: 'нет на складе', stock_status_key: 'none' };
    }
    if (ok >= pending) {
        return { stock_ok_count: ok, stock_pending_count: pending, stock_status: 'все на складе', stock_status_key: 'all' };
    }
    return { stock_ok_count: ok, stock_pending_count: pending, stock_status: 'частично на складе', stock_status_key: 'partial' };
}

function mapOrderListRow(r) {
    const sumMinor = Number(r.sum_minor || 0);
    const payedMinor = Number(r.payed_sum_minor || 0);
    const shippedMinor = Number(r.shipped_sum_minor || 0);
    return {
        uuid: String(r.uuid),
        doc_name: String(r.doc_name || ''),
        moment: r.moment ? new Date(r.moment).toISOString() : null,
        applicable: !!r.applicable,
        agent_uuid: r.agent_uuid ? String(r.agent_uuid) : '',
        agent_name: r.agent_name ? String(r.agent_name) : '',
        store_uuid: r.store_uuid ? String(r.store_uuid) : '',
        store_name: r.store_name ? String(r.store_name) : '',
        organization_name: r.organization_name ? String(r.organization_name) : '',
        project_uuid: r.project_uuid ? String(r.project_uuid) : '',
        project_name: r.project_name ? String(r.project_name) : '',
        state_name: r.state_name ? String(r.state_name) : '',
        owner_uuid: r.owner_uuid ? String(r.owner_uuid) : '',
        owner_name: r.owner_name ? String(r.owner_name) : '',
        positions_count: Number(r.positions_count || 0),
        ...computeStockStatus(r.stock_ok_count, r.stock_pending_count),
        sum: sumMinor / 100,
        payed_sum: payedMinor / 100,
        shipped_sum: shippedMinor / 100,
        payed_pct: sumMinor > 0 ? Math.round((100 * payedMinor) / sumMinor) : 0,
        shipped_pct: sumMinor > 0 ? Math.round((100 * shippedMinor) / sumMinor) : 0,
        deleted_at: r.deleted_at ? new Date(r.deleted_at).toISOString() : null,
    };
}

function createMsOrdersRouter(db, appSettingsRef = {}) {
    const router = express.Router();
    const settings = () => appSettingsRef || {};
    ensureSchema(db).catch((e) => console.error('[ms-orders] ensureSchema:', e && e.message));

    router.get('/config', (req, res) => {
        const limit = getMsOrdersSyncDaysLimit(settings());
        res.json({ success: true, sync_days: limit, max_days: limit });
    });

    router.get('/list', async (req, res) => {
        try {
            await ensureSchema(db);
            const appSettings = settings();
            const limit = clampInt(req.query.limit, 1, 500, 100);
            const offset = clampInt(req.query.offset, 0, 5_000_000, 0);
            const days = clampOrderDays(req.query.days, appSettings);
            const search = String(req.query.search || '').trim();
            const docName = String(req.query.doc_name || '').trim();
            let storeUuids = parseUuidList(req.query.store_uuids);
            if (!storeUuids.length) {
                const legacy = String(req.query.store_uuid || '').trim().toLowerCase();
                if (legacy) storeUuids = [legacy];
            }
            let agentUuids = parseUuidList(req.query.agent_uuids);
            if (!agentUuids.length) {
                const legacy = String(req.query.agent_uuid || '').trim().toLowerCase();
                if (legacy) agentUuids = [legacy];
            }
            let projectUuids = parseUuidList(req.query.project_uuids);
            if (!projectUuids.length) {
                const legacy = String(req.query.project_uuid || '').trim().toLowerCase();
                if (legacy) projectUuids = [legacy];
            }
            const applicableValues = parseApplicableValues(req.query);
            const payStatuses = parsePayStatuses(req.query);
            const shipStatuses = parseShipStatuses(req.query);
            const stockStatuses = parseStockStatuses(req.query);
            const deleted = String(req.query.deleted || '0').trim();
            const sortBy = String(req.query.sort_by || 'moment');
            const sortDir = String(req.query.sort_dir || 'desc').toLowerCase() === 'asc' ? 'ASC' : 'DESC';

            const sortMap = {
                moment: 'o.moment',
                doc_name: 'o.doc_name',
                agent: 'o.agent_name',
                store: 'o.store_name',
                owner: 'o.owner_name',
                positions_count: 'o.positions_count',
                stock_ok: 'COALESCE(stk.stock_ok_count, 0)',
                stock_status: `(CASE
                    WHEN COALESCE(stk.stock_pending_count, 0) <= 0 THEN 0
                    WHEN COALESCE(stk.stock_ok_count, 0) <= 0 THEN 1
                    WHEN stk.stock_ok_count >= stk.stock_pending_count THEN 3
                    ELSE 2
                END)`,
                sum: 'o.sum_minor',
                payed: 'o.payed_sum_minor',
                shipped: 'o.shipped_sum_minor',
            };
            const sortField = sortMap[sortBy] || sortMap.moment;

            const wheres = ['o.moment >= (NOW() - INTERVAL ? DAY)'];
            const params = [days];

            for (const p of getExcludePatterns(appSettings)) {
                const like = '%' + String(p).trim().toLowerCase().replace(/\./g, ' ').replace(/\s+/g, ' ') + '%';
                wheres.push("LOWER(REPLACE(REPLACE(TRIM(COALESCE(o.owner_name, '')), '.', ' '), '  ', ' ')) NOT LIKE ?");
                params.push(like);
            }

            if (search) {
                wheres.push(
                    '(o.doc_name LIKE ? OR o.agent_name LIKE ? OR EXISTS (SELECT 1 FROM ms_customer_order_position p ' +
                    'LEFT JOIN ms_export e ON e.code = p.ms_export_code ' +
                    'WHERE p.order_uuid = o.uuid AND (' +
                    'p.ms_export_code LIKE ? OR p.code_at_moment LIKE ? ' +
                    'OR p.name_at_moment LIKE ? OR e.name LIKE ?)))',
                );
                const needle = '%' + search + '%';
                params.push(needle, needle, needle, needle, needle, needle);
            }
            if (docName) {
                wheres.push('o.doc_name LIKE ?');
                params.push('%' + docName + '%');
            }
            if (storeUuids.length) {
                wheres.push(`o.store_uuid IN (${storeUuids.map(() => '?').join(',')})`);
                params.push(...storeUuids);
            }
            if (agentUuids.length) {
                wheres.push(`o.agent_uuid IN (${agentUuids.map(() => '?').join(',')})`);
                params.push(...agentUuids);
            }
            if (projectUuids.length) {
                wheres.push(`o.project_uuid IN (${projectUuids.map(() => '?').join(',')})`);
                params.push(...projectUuids);
            }
            if (applicableValues.length === 1) {
                wheres.push('o.applicable = ?');
                params.push(Number(applicableValues[0]));
            }
            const payStatusWhere = buildPayStatusWhere(payStatuses);
            if (payStatusWhere.sql) wheres.push(payStatusWhere.sql.replace(/^ AND /, ''));
            const shipStatusWhere = buildShipStatusWhere(shipStatuses);
            if (shipStatusWhere.sql) wheres.push(shipStatusWhere.sql.replace(/^ AND /, ''));
            const stockStatusWhere = buildStockStatusWhere(stockStatuses);
            if (stockStatusWhere.sql) wheres.push(stockStatusWhere.sql.replace(/^ AND /, ''));
            if (deleted === '1') wheres.push('o.deleted_at IS NOT NULL');
            else if (deleted !== 'all') wheres.push('o.deleted_at IS NULL');

            const whereSql = ' WHERE ' + wheres.join(' AND ');
            const countFrom = stockStatusWhere.needsStockJoin
                ? `FROM ms_customer_order o ${STOCK_AGG_JOIN}${whereSql}`
                : 'FROM ms_customer_order o' + whereSql;

            const [rows] = await db.query(
                `SELECT o.uuid, o.doc_name, o.moment, o.applicable,
                        o.agent_uuid, o.agent_name, o.store_uuid, o.store_name,
                        o.organization_name, o.project_uuid, o.project_name,
                        o.state_name, o.owner_uuid, o.owner_name,
                        o.positions_count, o.sum_minor, o.payed_sum_minor, o.shipped_sum_minor,
                        o.deleted_at,
                        COALESCE(stk.stock_ok_count, 0) AS stock_ok_count,
                        COALESCE(stk.stock_pending_count, 0) AS stock_pending_count
                   FROM ms_customer_order o
                   ${STOCK_AGG_JOIN}
                   ${whereSql}
                   ORDER BY ${sortField} ${sortDir}, o.uuid ASC
                   LIMIT ? OFFSET ?`,
                params.concat([limit, offset]),
            );
            const [cnt] = await db.query(
                'SELECT COUNT(*) AS total ' + countFrom,
                params,
            );

            res.json({
                success: true,
                total: Number((cnt && cnt[0] && cnt[0].total) || 0),
                limit,
                offset,
                days,
                max_days: getMsOrdersSyncDaysLimit(appSettings),
                sync_days: getMsOrdersSyncDaysLimit(appSettings),
                filter_search: search || '',
                rows: (rows || []).map(mapOrderListRow),
            });
        } catch (e) {
            console.error('[ms-orders] /list:', e);
            res.status(500).json({ success: false, error: e && e.message ? e.message : 'Ошибка списка' });
        }
    });

    router.get('/filters', async (req, res) => {
        try {
            await ensureSchema(db);
            const appSettings = settings();
            const days = clampOrderDays(req.query.days, appSettings);
            const exclude = buildOwnerExcludeWhere(getExcludePatterns(appSettings), 'owner_name');
            const baseWhere = 'moment >= (NOW() - INTERVAL ? DAY) AND deleted_at IS NULL' + exclude.sql;
            const baseParams = [days].concat(exclude.params);

            const [stores] = await db.query(
                `SELECT store_uuid AS uuid, store_name AS name, COUNT(*) AS cnt
                   FROM ms_customer_order
                  WHERE ${baseWhere} AND store_uuid IS NOT NULL
                  GROUP BY store_uuid, store_name ORDER BY name`,
                baseParams,
            );
            const [agents] = await db.query(
                `SELECT agent_uuid AS uuid, agent_name AS name, COUNT(*) AS cnt
                   FROM ms_customer_order
                  WHERE ${baseWhere} AND agent_uuid IS NOT NULL
                  GROUP BY agent_uuid, agent_name ORDER BY cnt DESC, name LIMIT 500`,
                baseParams,
            );
            const [projects] = await db.query(
                `SELECT project_uuid AS uuid, project_name AS name, COUNT(*) AS cnt
                   FROM ms_customer_order
                  WHERE ${baseWhere} AND project_uuid IS NOT NULL
                  GROUP BY project_uuid, project_name ORDER BY cnt DESC, name`,
                baseParams,
            );
            res.json({
                success: true,
                stores: (stores || []).map((r) => ({ uuid: String(r.uuid), name: String(r.name || ''), count: Number(r.cnt || 0) })),
                agents: (agents || []).map((r) => ({ uuid: String(r.uuid), name: String(r.name || ''), count: Number(r.cnt || 0) })),
                projects: (projects || []).map((r) => ({ uuid: String(r.uuid), name: String(r.name || ''), count: Number(r.cnt || 0) })),
            });
        } catch (e) {
            res.status(500).json({ success: false, error: e && e.message ? e.message : 'Ошибка' });
        }
    });

    router.get('/data-freshness', async (req, res) => {
        try {
            await ensureSchema(db);
            const payload = await loadMsOrdersDataFreshness(
                db,
                jobStateToPayload(),
                getMsOrdersSyncDaysLimit(settings()),
            );
            res.json(payload);
        } catch (e) {
            console.error('[ms-orders] /data-freshness:', e);
            res.status(500).json({ success: false, error: e && e.message ? e.message : 'Ошибка' });
        }
    });

    router.get('/:uuid/positions', async (req, res) => {
        try {
            await ensureSchema(db);
            const uuid = String(req.params.uuid || '').toLowerCase();
            if (!uuid) return res.status(400).json({ success: false, error: 'Не указан uuid' });

            const [docRows] = await db.query(
                `SELECT uuid, doc_name, moment, applicable,
                        agent_name, store_uuid, store_name, organization_name, project_name,
                        state_name, owner_name, positions_count,
                        sum_minor, payed_sum_minor, shipped_sum_minor, description, deleted_at
                   FROM ms_customer_order WHERE uuid = ?`,
                [uuid],
            );
            const doc = (docRows && docRows[0]) || null;
            if (!doc) return res.status(404).json({ success: false, error: 'Заказ не найден' });

            const [posRows] = await db.query(
                `SELECT p.position_uuid, p.ms_export_code, p.code_at_moment, p.name_at_moment,
                        p.quantity, p.shipped, p.price_minor, p.discount, p.sum_minor, p.ms_export_resolved,
                        e.name AS ms_export_name,
                        ${msOrderPositionStockExpr('ord')} AS ms_export_stock
                   FROM ms_customer_order_position p
                   INNER JOIN ms_customer_order ord ON ord.uuid = p.order_uuid
                   LEFT JOIN ms_export e ON e.code = p.ms_export_code
                   LEFT JOIN ms_export_stock_by_store ss
                     ON ss.code = p.ms_export_code AND ss.store_uuid = ord.store_uuid
                  WHERE p.order_uuid = ?
                  ORDER BY p.pack_idx ASC`,
                [uuid],
            );

            const d = mapOrderListRow(doc);
            res.json({
                success: true,
                order: d,
                positions: (posRows || []).map((p) => ({
                    position_uuid: String(p.position_uuid),
                    code: String(p.ms_export_code || p.code_at_moment || ''),
                    name: String(p.name_at_moment || p.ms_export_name || ''),
                    quantity: Number(p.quantity || 0),
                    shipped: Number(p.shipped || 0),
                    price: Number(p.price_minor || 0) / 100,
                    discount: Number(p.discount || 0),
                    sum: Number(p.sum_minor || 0) / 100,
                    resolved: !!p.ms_export_resolved,
                    stock: p.ms_export_stock != null ? Number(p.ms_export_stock) : null,
                })),
            });
        } catch (e) {
            console.error('[ms-orders] /:uuid/positions:', e);
            res.status(500).json({ success: false, error: e && e.message ? e.message : 'Ошибка' });
        }
    });

    router.post('/sync', async (req, res) => {
        if (jobState.active) {
            return res.status(409).json({ success: false, error: 'Синхронизация уже запущена', status: jobStateToPayload() });
        }
        const headers = getMsHeaders();
        if (!headers) {
            return res.status(503).json({ success: false, error: 'MS_TOKEN не задан (env MS_TOKEN или config.msToken)' });
        }
        const days = clampOrderDays(req.body && req.body.days, settings());
        const serial = resetJobState(days);
        ensureSchema(db)
            .then(() => runOrderSync(db, days, appSettingsRef))
            .then(() => finalizeJob(serial, 'ok'))
            .catch((e) => finalizeJob(serial, 'err', e));
        return res.json({ success: true, started: true, days, status: jobStateToPayload() });
    });

    router.post('/sync-cancel', (req, res) => {
        jobState.cancelRequested = true;
        return res.json({ success: true, status: jobStateToPayload() });
    });

    router.get('/sync-status', (req, res) => {
        res.json({ success: true, status: jobStateToPayload() });
    });

    return router;
}

function getSyncState() {
    return jobStateToPayload();
}

/**
 * Программный запуск синка (автосинхронизация / settings «Запустить сейчас»).
 * @param {import('mysql2/promise').Pool} db
 * @param {object} appSettingsRef — `appSettings` (для `ms_orders_sync_days`, исключений)
 * @param {{ days?: number, awaitCompletion?: boolean }} [options]
 */
function triggerSync(db, appSettingsRef, options = {}) {
    const settings = appSettingsRef || {};
    const days = clampOrderDays(options.days, settings);
    const awaitCompletion = !!(options && options.awaitCompletion === true);
    if (jobState.active) {
        return Promise.resolve({ started: false, reason: 'already_running', status: jobStateToPayload() });
    }
    const headers = getMsHeaders();
    if (!headers) {
        return Promise.resolve({
            started: false,
            reason: 'missing_creds',
            error: 'MS_TOKEN не задан (env MS_TOKEN или config.msToken)',
        });
    }
    const serial = resetJobState(days);
    const pipeline = ensureSchema(db)
        .then(() => runOrderSync(db, days, settings))
        .then(() => finalizeJob(serial, 'ok'))
        .catch((e) => finalizeJob(serial, 'err', e));
    if (awaitCompletion) {
        return pipeline.then(() => ({ started: true, days, status: jobStateToPayload() }));
    }
    void pipeline;
    return Promise.resolve({ started: true, days, status: jobStateToPayload() });
}

module.exports = {
    createMsOrdersRouter,
    ensureSchema,
    getSyncState,
    triggerSync,
    getMsOrdersSyncDaysLimit,
    DEFAULT_MS_ORDERS_SYNC_DAYS,
    MAX_ORDER_DAYS_ABS,
};
