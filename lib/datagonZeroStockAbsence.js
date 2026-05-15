'use strict';

/**
 * Сведка по окнам из Excel (`dg_product_zero_stock_window_import`) — агрегаты за скользящие
 * 30/60/90/180/365 дн. относительно `reference_date`, без построчных дат в `dg_product_zero_stock_log`.
 * Для формулы (период A дн.) оцениваем ожидаемое число дней «нуля» по кусочно-линейной шкале между
 * известными окнами и объединяем с COUNT(DISTINCT ts_date) из лога: max(лог, оценка), не выше A.
 */

function clampNonNegInt(v) {
    const n = Math.floor(Number(v));
    if (!Number.isFinite(n) || n < 0) return 0;
    return Math.min(3660, n);
}

/** Полных календарных дней между датой среза импорта (YYYY-MM-DD) и «сегодня» (локальная дата сервера). */
function calendarDaysSinceReferenceDate(refStr) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(refStr || '').trim());
    if (!m) return Number.POSITIVE_INFINITY;
    const ref = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const d = Math.floor((today - ref) / 86400000);
    return d < 0 ? 0 : d;
}

function monotoneKnots(row) {
    const n30 = clampNonNegInt(row.absent_last_30);
    const n60 = Math.max(n30, clampNonNegInt(row.absent_last_60));
    const n90 = Math.max(n60, clampNonNegInt(row.absent_last_90));
    const n180 = Math.max(n90, clampNonNegInt(row.absent_last_180));
    const n365 = Math.max(n180, clampNonNegInt(row.absent_last_365));
    return [
        [30, n30],
        [60, n60],
        [90, n90],
        [180, n180],
        [365, n365],
    ];
}

function linearInterp(A, a0, v0, a1, v1) {
    if (a1 <= a0) return v1;
    return v0 + ((A - a0) / (a1 - a0)) * (v1 - v0);
}

/**
 * Оценка «дней отсутствия» для произвольного A по последней импортированной сводке.
 * @param {object|null} importRow — строка с absent_last_* и reference_date
 * @param {number} analysisDaysA
 * @returns {number|null} null если нет данных
 */
function estimateAbsentDaysFromWindowImport(importRow, analysisDaysA) {
    if (!importRow) return null;
    const A = Math.max(1, Math.round(Number(analysisDaysA) || 0));
    const knots = monotoneKnots(importRow);
    if (A <= knots[0][0]) {
        return Math.min(A, Math.round(knots[0][1] * (A / knots[0][0])));
    }
    if (A >= knots[knots.length - 1][0]) {
        return knots[knots.length - 1][1];
    }
    for (let i = 0; i < knots.length - 1; i += 1) {
        const [a0, v0] = knots[i];
        const [a1, v1] = knots[i + 1];
        if (A <= a1) {
            return Math.round(linearInterp(A, a0, v0, a1, v1));
        }
    }
    return knots[knots.length - 1][1];
}

/**
 * @param {object} opts
 * @param {number} opts.logDistinctDays — COUNT(DISTINCT ts_date) из dg_product_zero_stock_log за последние A дн.
 * @param {object|null} [opts.windowImport] — последняя сводка по коду (absent_last_*, reference_date)
 * @param {number} opts.analysisDaysA
 * @param {number} [opts.maxImportAgeDays=730] — если срез импорта старше, оценку из Excel не смешиваем (только лог)
 */
function mergeAbsenceDistinctForFormula(opts) {
    const A = Math.max(1, Math.round(Number(opts.analysisDaysA) || 0));
    const logd = Math.max(0, Math.round(Number(opts.logDistinctDays) || 0));
    const maxAge = Math.max(30, Math.round(Number(opts.maxImportAgeDays) || 730));
    const win = opts.windowImport || null;
    const ref = win && win.reference_date != null ? String(win.reference_date).trim() : '';
    if (!win || !ref) {
        return {
            effective: Math.min(A, logd),
            log: logd,
            importEstimate: null,
            importUsed: false,
            importSkippedReason: 'no_import',
        };
    }
    const age = calendarDaysSinceReferenceDate(ref);
    if (age > maxAge) {
        return {
            effective: Math.min(A, logd),
            log: logd,
            importEstimate: estimateAbsentDaysFromWindowImport(win, A),
            importUsed: false,
            importSkippedReason: 'import_stale',
            import_reference_age_days: age,
        };
    }
    const est = estimateAbsentDaysFromWindowImport(win, A);
    if (est == null || !Number.isFinite(est)) {
        return {
            effective: Math.min(A, logd),
            log: logd,
            importEstimate: null,
            importUsed: false,
            importSkippedReason: 'no_estimate',
        };
    }
    const merged = Math.min(A, Math.max(logd, Math.round(est)));
    return {
        effective: merged,
        log: logd,
        importEstimate: Math.round(est),
        importUsed: merged > logd,
        import_reference_age_days: age,
        importSkippedReason: merged > logd ? null : 'log_not_lower_than_import',
    };
}

module.exports = {
    estimateAbsentDaysFromWindowImport,
    mergeAbsenceDistinctForFormula,
    calendarDaysSinceReferenceDate,
};
