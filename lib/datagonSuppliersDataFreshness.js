'use strict';

const MSK_TZ = 'Europe/Moscow';

const MOYSKLAD_TITLE = 'МойСклад: каталог, остатки и журнал нулевых остатков';
const MSSALES_TITLE = 'Продажи МойСклад: отгрузки за период';
const MSSALES_FULL_TITLE = 'Продажи МойСклад: полная выгрузка отгрузок';

function toDate(v) {
    if (v == null || v === '') return null;
    const d = v instanceof Date ? v : new Date(v);
    return Number.isFinite(d.getTime()) ? d : null;
}

function mskDateKey(d) {
    const dt = toDate(d);
    if (!dt) return '';
    return new Intl.DateTimeFormat('en-CA', { timeZone: MSK_TZ }).format(dt);
}

function isTodayMsk(d) {
    const key = mskDateKey(d);
    return !!key && key === mskDateKey(new Date());
}

function formatMskDateTime(d) {
    const dt = toDate(d);
    if (!dt) return null;
    return new Intl.DateTimeFormat('ru-RU', {
        timeZone: MSK_TZ,
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
    }).format(dt);
}

function pickLatestDate(candidates) {
    let best = null;
    let bestTs = -Infinity;
    for (const c of candidates) {
        const d = toDate(c);
        if (!d) continue;
        const ts = d.getTime();
        if (ts > bestTs) {
            bestTs = ts;
            best = d;
        }
    }
    return best;
}

function triggerLabel(triggerType) {
    const t = String(triggerType || '').trim();
    if (t === 'manual') return 'вручную';
    if (t === 'schedule') return 'по расписанию';
    return t || null;
}

function shortMessage(msg, maxLen = 120) {
    const s = String(msg || '').replace(/\s+/g, ' ').trim();
    if (!s) return null;
    return s.length > maxLen ? `${s.slice(0, maxLen - 1)}…` : s;
}

async function lastAutoSyncRun(db, taskType, { status } = {}) {
    try {
        const clauses = ['task_type = ?'];
        const params = [taskType];
        if (status) {
            clauses.push('status = ?');
            params.push(status);
        }
        const [rows] = await db.query(
            `SELECT task_type, status, trigger_type, started_at, finished_at, message
               FROM auto_sync_runs
              WHERE ${clauses.join(' AND ')}
              ORDER BY COALESCE(finished_at, started_at) DESC, id DESC
              LIMIT 1`,
            params,
        );
        return rows && rows[0] ? rows[0] : null;
    } catch (_) {
        return null;
    }
}

async function queryScalarMax(db, sql) {
    try {
        const [rows] = await db.query(sql);
        const v = rows && rows[0] ? rows[0].v : null;
        return toDate(v);
    } catch (_) {
        return null;
    }
}

function buildSource({
    key,
    title,
    at,
    running,
    lastRun,
    detail,
}) {
    const finishedAt = at ? at.toISOString() : null;
    const isToday = at ? isTodayMsk(at) : false;
    let status = 'unknown';
    if (running) status = 'running';
    else if (!at) {
        status = lastRun && String(lastRun.status || '') === 'failed' ? 'failed' : 'unknown';
    } else if (isToday) status = 'ok';
    else if (lastRun && String(lastRun.status || '') === 'failed') status = 'stale';
    else status = 'stale';

    return {
        key,
        title,
        timezone_label: 'МСК',
        status,
        is_today_msk: isToday,
        finished_at: finishedAt,
        finished_at_msk: formatMskDateTime(at),
        trigger_type: lastRun ? String(lastRun.trigger_type || '') : null,
        trigger_label: lastRun ? triggerLabel(lastRun.trigger_type) : null,
        run_status: lastRun ? String(lastRun.status || '') : null,
        message_short: lastRun ? shortMessage(lastRun.message) : null,
        detail: detail || {},
    };
}

function pickSalesDisplay(mssalesRun, mssalesFullRun, demandMaxAt) {
    const completed = [
        mssalesRun && String(mssalesRun.status) === 'completed' ? mssalesRun : null,
        mssalesFullRun && String(mssalesFullRun.status) === 'completed' ? mssalesFullRun : null,
    ].filter(Boolean);
    let chosen = null;
    for (const r of completed) {
        const d = toDate(r.finished_at);
        if (!d) continue;
        if (!chosen || d.getTime() > toDate(chosen.finished_at).getTime()) chosen = r;
    }
    const running =
        (mssalesRun && String(mssalesRun.status) === 'running' && mssalesRun) ||
        (mssalesFullRun && String(mssalesFullRun.status) === 'running' && mssalesFullRun) ||
        null;

    let title = MSSALES_TITLE;
    let lastRun = chosen || mssalesFullRun || mssalesRun || null;
    let at = pickLatestDate([
        chosen && chosen.finished_at,
        demandMaxAt,
    ]);

    if (chosen && chosen.task_type === 'mssales_full') {
        title = MSSALES_FULL_TITLE;
    } else if (!chosen && mssalesFullRun && toDate(mssalesFullRun.finished_at)) {
        title = MSSALES_FULL_TITLE;
        at = pickLatestDate([mssalesFullRun.finished_at, demandMaxAt]);
        lastRun = mssalesFullRun;
    } else if (!chosen && mssalesRun && toDate(mssalesRun.finished_at)) {
        title = MSSALES_TITLE;
        at = pickLatestDate([mssalesRun.finished_at, demandMaxAt]);
        lastRun = mssalesRun;
    }

    return {
        key: chosen && chosen.task_type === 'mssales_full' ? 'mssales_full' : 'mssales',
        title,
        at,
        running,
        lastRun,
        detail: {
            last_mssales_at: mssalesRun && mssalesRun.finished_at ? toDate(mssalesRun.finished_at)?.toISOString() : null,
            last_mssales_full_at:
                mssalesFullRun && mssalesFullRun.finished_at
                    ? toDate(mssalesFullRun.finished_at)?.toISOString()
                    : null,
            ms_demand_max_updated_at: demandMaxAt ? demandMaxAt.toISOString() : null,
        },
    };
}

/**
 * Сводка свежести данных для /suppliers.html (МСК, «сегодня» = ок).
 * @param {import('mysql2/promise').Pool} db
 */
async function loadSuppliersDataFreshness(db) {
    const [
        moyskladRunning,
        moyskladCompleted,
        moyskladLast,
        mssalesRunning,
        mssalesCompleted,
        mssalesLast,
        mssalesFullRunning,
        mssalesFullCompleted,
        mssalesFullLast,
        msExportSyncedAt,
        zeroLogBatchAt,
        demandMaxAt,
    ] = await Promise.all([
        lastAutoSyncRun(db, 'moysklad', { status: 'running' }),
        lastAutoSyncRun(db, 'moysklad', { status: 'completed' }),
        lastAutoSyncRun(db, 'moysklad'),
        lastAutoSyncRun(db, 'mssales', { status: 'running' }),
        lastAutoSyncRun(db, 'mssales', { status: 'completed' }),
        lastAutoSyncRun(db, 'mssales'),
        lastAutoSyncRun(db, 'mssales_full', { status: 'running' }),
        lastAutoSyncRun(db, 'mssales_full', { status: 'completed' }),
        lastAutoSyncRun(db, 'mssales_full'),
        queryScalarMax(db, 'SELECT MAX(synced_at) AS v FROM ms_export'),
        queryScalarMax(
            db,
            `SELECT MAX(created_at) AS v FROM dg_product_zero_stock_log WHERE source = 'moysklad_sync'`,
        ),
        queryScalarMax(db, 'SELECT MAX(updated_at) AS v FROM ms_demand'),
    ]);

    const moyskladSyncFinishedAt = toDate(moyskladCompleted && moyskladCompleted.finished_at);
    /** Не смешивать с MAX(synced_at): у ms_export ON UPDATE CURRENT_TIMESTAMP — любая правка строки (MedMarket, min_stock…) сдвигает время. */
    const moyskladAt = moyskladSyncFinishedAt || msExportSyncedAt;
    const moyskladSource = buildSource({
        key: 'moysklad',
        title: MOYSKLAD_TITLE,
        at: moyskladAt,
        running: !!moyskladRunning,
        lastRun: moyskladCompleted || moyskladLast,
        detail: {
            moysklad_sync_finished_at_msk: formatMskDateTime(moyskladSyncFinishedAt),
            ms_export_synced_at: msExportSyncedAt ? msExportSyncedAt.toISOString() : null,
            ms_export_max_synced_at_msk: formatMskDateTime(msExportSyncedAt),
            zero_stock_log_batch_at: zeroLogBatchAt ? zeroLogBatchAt.toISOString() : null,
            zero_stock_log_batch_at_msk: formatMskDateTime(zeroLogBatchAt),
        },
    });

    const sales = pickSalesDisplay(mssalesCompleted, mssalesFullCompleted, demandMaxAt);
    const salesRunning = mssalesRunning || mssalesFullRunning;
    const salesLast = sales.lastRun;
    const salesSource = buildSource({
        key: sales.key,
        title: sales.title,
        at: sales.at,
        running: !!salesRunning,
        lastRun: salesLast,
        detail: sales.detail,
    });

    return {
        success: true,
        as_of_msk: formatMskDateTime(new Date()),
        sources: [moyskladSource, salesSource],
    };
}

module.exports = {
    loadSuppliersDataFreshness,
    formatMskDateTime,
    isTodayMsk,
    buildSource,
    pickLatestDate,
    queryScalarMax,
    triggerLabel,
};
