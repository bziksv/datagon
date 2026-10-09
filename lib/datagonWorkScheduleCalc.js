'use strict';

/** Округление часов до 5 минут (0.0833… ч). */
function roundHoursTo5Min(hours) {
    const h = Number(hours);
    if (!Number.isFinite(h) || h <= 0) return 0;
    const minutes = Math.round(h * 60);
    const rounded = Math.round(minutes / 5) * 5;
    return Math.round((rounded / 60) * 10000) / 10000;
}

function hoursBetween(checkIn, checkOut) {
    const a = new Date(checkIn).getTime();
    const b = new Date(checkOut).getTime();
    if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) return 0;
    return roundHoursTo5Min((b - a) / 3600000);
}

/**
 * @param {number} hoursWorked
 * @param {{ normHours: number, rateFull: number, rateHalf: number }} thr
 */
function rateFromHours(hoursWorked, thr) {
    const h = Number(hoursWorked) || 0;
    const full = Number(thr.rateFull) || Number(thr.normHours) || 8;
    const half = Number(thr.rateHalf) || full / 2;
    if (h >= full) return 1;
    if (h >= half) return 0.5;
    return 0;
}

function resolveEmployeeThresholds(emp, dept) {
    return {
        scheduleType: emp.personal_schedule_type || dept.schedule_type || '5/2',
        normHours: Number(emp.personal_work_hours_per_day != null ? emp.personal_work_hours_per_day : dept.norm_hours) || 8,
        rateFull: Number(emp.personal_rate_full_hours != null ? emp.personal_rate_full_hours : dept.rate_full_hours) || 7,
        rateHalf: Number(emp.personal_rate_half_hours != null ? emp.personal_rate_half_hours : dept.rate_half_hours) || 4,
    };
}

function resolveSeniorityParams(emp, org) {
    return {
        base: Number(emp.personal_seniority_base != null ? emp.personal_seniority_base : org.seniority_base) || 1000,
        step: Number(emp.personal_seniority_step != null ? emp.personal_seniority_step : org.seniority_step) || 500,
        period: Number(
            emp.personal_seniority_period_months != null
                ? emp.personal_seniority_period_months
                : org.seniority_period_months
        ) || 6,
    };
}

function resolveSickRate(emp, org) {
    if (emp.personal_sick_leave_rate != null && emp.personal_sick_leave_rate !== '') {
        return Number(emp.personal_sick_leave_rate) || 0;
    }
    return Number(org.sick_unofficial_rate) || 0;
}

/** Стаж в полных месяцах от hire_date до asOf (Date). */
function seniorityMonths(hireDate, asOf) {
    if (!hireDate) return 0;
    const h = new Date(hireDate);
    const a = asOf instanceof Date ? asOf : new Date(asOf);
    if (!Number.isFinite(h.getTime()) || !Number.isFinite(a.getTime()) || a < h) return 0;
    let months = (a.getFullYear() - h.getFullYear()) * 12 + (a.getMonth() - h.getMonth());
    if (a.getDate() < h.getDate()) months -= 1;
    return Math.max(0, months);
}

function seniorityBonus(hireDate, asOf, params) {
    const m = seniorityMonths(hireDate, asOf);
    if (m < 12) return 0;
    const period = Math.max(1, Number(params.period) || 6);
    const steps = Math.floor((m - 12) / period);
    return Number(params.base) + Number(params.step) * steps;
}

function moscowYmd(d = new Date()) {
    return d.toLocaleDateString('en-CA', { timeZone: 'Europe/Moscow' });
}

function moscowNowSql() {
    const s = new Date().toLocaleString('sv-SE', { timeZone: 'Europe/Moscow' });
    return s.replace('T', ' ').slice(0, 19);
}

function periodYmFromDate(ymd) {
    return String(ymd).slice(0, 7);
}

function daysInMonthYm(ym) {
    const [y, m] = String(ym).split('-').map(Number);
    return new Date(y, m, 0).getDate();
}

/**
 * Норма рабочих дней месяца.
 * Для 5/2 — по календарю РФ (если есть строки), иначе пн–пт.
 */
async function monthNormDays(db, ym, scheduleType) {
    const dim = daysInMonthYm(ym);
    const [y, m] = String(ym).split('-').map(Number);
    const from = `${ym}-01`;
    const to = `${ym}-${String(dim).padStart(2, '0')}`;

    if (scheduleType === '5/2') {
        const [rows] = await db.query(
            `SELECT cal_date, is_working_day FROM ws_work_calendar
             WHERE cal_date BETWEEN ? AND ?`,
            [from, to]
        );
        if (rows.length >= dim * 0.5) {
            return rows.filter((r) => Number(r.is_working_day) === 1).length;
        }
        let n = 0;
        for (let d = 1; d <= dim; d++) {
            const wd = new Date(y, m - 1, d).getDay();
            if (wd !== 0 && wd !== 6) n += 1;
        }
        return n;
    }

    if (scheduleType === '2/2') {
        return Math.round(dim / 2);
    }
    // сменный / гибкий — по умолчанию как 5/2 без календаря
    let n = 0;
    for (let d = 1; d <= dim; d++) {
        const wd = new Date(y, m - 1, d).getDay();
        if (wd !== 0 && wd !== 6) n += 1;
    }
    return n;
}

function vacationDaysAccrued(hireDate, asOf) {
    const m = seniorityMonths(hireDate, asOf);
    return Math.round(m * 2.33 * 100) / 100;
}

module.exports = {
    roundHoursTo5Min,
    hoursBetween,
    rateFromHours,
    resolveEmployeeThresholds,
    resolveSeniorityParams,
    resolveSickRate,
    seniorityMonths,
    seniorityBonus,
    moscowYmd,
    moscowNowSql,
    periodYmFromDate,
    daysInMonthYm,
    monthNormDays,
    vacationDaysAccrued,
};
