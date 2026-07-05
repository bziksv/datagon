'use strict';

const {
    loadSuppliersDataFreshness,
    formatMskDateTime,
    buildSource,
    pickLatestDate,
    queryScalarMax,
} = require('./datagonSuppliersDataFreshness');

const MS_ORDERS_TITLE_PREFIX = 'Заказы в МС: импорт customerorder';

function msOrdersFreshnessTitle(syncDays) {
    const d = Math.max(1, Math.min(365, Math.round(Number(syncDays) || 30)));
    return MS_ORDERS_TITLE_PREFIX + ' (' + d + ' дн.)';
}

async function queryScalarCount(db, sql) {
    try {
        const [rows] = await db.query(sql);
        const v = rows && rows[0] ? rows[0].v : null;
        const n = Number(v);
        return Number.isFinite(n) ? n : 0;
    } catch (_) {
        return 0;
    }
}

function buildOrdersLastRun(jobState) {
    if (!jobState) return null;
    if (jobState.active) return null;
    if (jobState.finished_at) {
        return {
            trigger_type: 'manual',
            status: jobState.last_error ? 'failed' : 'completed',
            finished_at: jobState.finished_at,
            message: jobState.message,
        };
    }
    return null;
}

/**
 * Сводка свежести для /ms-orders.html: импорт заказов + остатки МС (для колонки «Позиций на складе»).
 * @param {import('mysql2/promise').Pool} db
 * @param {object|null} jobState — payload из jobStateToPayload()
 */
async function loadMsOrdersDataFreshness(db, jobState, syncDays) {
    const [ordersMaxFetched, ordersMaxUpdated, ordersCount, suppliersFreshness] = await Promise.all([
        queryScalarMax(db, 'SELECT MAX(fetched_at) AS v FROM ms_customer_order'),
        queryScalarMax(db, 'SELECT MAX(updated_at) AS v FROM ms_customer_order'),
        queryScalarCount(db, 'SELECT COUNT(*) AS v FROM ms_customer_order WHERE deleted_at IS NULL'),
        loadSuppliersDataFreshness(db),
    ]);

    const jobFinishedAt = jobState && !jobState.active && jobState.finished_at
        ? new Date(jobState.finished_at)
        : null;
    const at = pickLatestDate([ordersMaxFetched, ordersMaxUpdated, jobFinishedAt]);

    const ordersSource = buildSource({
        key: 'ms_orders',
        title: msOrdersFreshnessTitle(syncDays),
        at,
        running: !!(jobState && jobState.active),
        lastRun: buildOrdersLastRun(jobState) || (at ? {
            trigger_type: 'manual',
            status: 'completed',
            finished_at: at.toISOString(),
            message: null,
        } : null),
        detail: {
            orders_in_db: ordersCount,
            max_fetched_at_msk: formatMskDateTime(ordersMaxFetched),
            max_updated_at_msk: formatMskDateTime(ordersMaxUpdated),
            last_sync_orders: jobState && jobState.fetched_orders != null ? Number(jobState.fetched_orders) : null,
            last_sync_positions: jobState && jobState.saved_positions != null ? Number(jobState.saved_positions) : null,
        },
    });

    const moyskladSource = (suppliersFreshness.sources || []).find((s) => s.key === 'moysklad') || null;
    const sources = moyskladSource ? [ordersSource, moyskladSource] : [ordersSource];

    return {
        success: true,
        as_of_msk: formatMskDateTime(new Date()),
        sources,
    };
}

module.exports = {
    loadMsOrdersDataFreshness,
};
