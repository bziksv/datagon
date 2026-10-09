'use strict';

/** Округление часов до 5 минут (0.0833… ч) — только для ставки дня, не для накопления. */
function roundHoursTo5Min(hours) {
    const h = Number(hours);
    if (!Number.isFinite(h) || h <= 0) return 0;
    const minutes = Math.round(h * 60);
    const rounded = Math.round(minutes / 5) * 5;
    return Math.round((rounded / 60) * 10000) / 10000;
}

/**
 * → epoch ms.
 * Date от mysql2 уже абсолютный момент (DATETIME + session TZ) — берём getTime().
 * Наивная строка 'YYYY-MM-DD HH:mm:ss' (как moscowNowSql) — стена Москвы (+03).
 */
function toEpochMs(v) {
    if (v == null || v === '') return NaN;
    if (v instanceof Date) {
        const t = v.getTime();
        return Number.isFinite(t) ? t : NaN;
    }
    const s = String(v).trim();
    if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/.test(s) && !/[zZ]|[+-]\d{2}:?\d{2}$/.test(s)) {
        return new Date(s.replace(' ', 'T') + '+03:00').getTime();
    }
    const t = new Date(s).getTime();
    return Number.isFinite(t) ? t : NaN;
}

function msBetween(checkIn, checkOut) {
    const a = toEpochMs(checkIn);
    const b = toEpochMs(checkOut);
    if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) return 0;
    return b - a;
}

/** Точные часы (4 знака) — для накопления сегментов, без обнуления коротких кусков. */
function hoursPreciseFromMs(ms) {
    const n = Number(ms);
    if (!Number.isFinite(n) || n <= 0) return 0;
    return Math.round((n / 3600000) * 10000) / 10000;
}

function hoursBetween(checkIn, checkOut) {
    return hoursPreciseFromMs(msBetween(checkIn, checkOut));
}

function parseSegments(raw) {
    if (raw == null || raw === '') return [];
    let arr = raw;
    if (typeof raw === 'string') {
        try {
            arr = JSON.parse(raw);
        } catch (e) {
            return [];
        }
    }
    if (!Array.isArray(arr)) return [];
    return arr
        .map((s) => ({
            in: s && s.in != null ? String(s.in) : '',
            out: s && s.out != null ? String(s.out) : '',
            ms: Math.max(0, Number(s && s.ms) || 0),
            hours: Math.max(0, Number(s && s.hours) || 0),
            source: s && s.source ? String(s.source) : 'clock',
            ip_in: s && s.ip_in != null ? String(s.ip_in) : '',
            ip_out: s && s.ip_out != null ? String(s.ip_out) : '',
            device_in: s && s.device_in != null ? String(s.device_in) : '',
            device_out: s && s.device_out != null ? String(s.device_out) : '',
        }))
        .filter((s) => s.in && s.out);
}

function segmentsTotalMs(segments) {
    return parseSegments(segments).reduce((sum, s) => sum + (s.ms || Math.round(s.hours * 3600000)), 0);
}

function hoursFromSegments(segments) {
    return hoursPreciseFromMs(segmentsTotalMs(segments));
}

/** Убрать сегменты с явной ошибкой TZ (+~3 ч при стопе) и пересчитать ms по in/out. */
function sanitizeSegments(rawSegments) {
    const cleaned = [];
    for (const s of parseSegments(rawSegments)) {
        const ms = msBetween(s.in, s.out);
        if (ms <= 0) continue;
        if (ms > 14 * 3600000) continue;
        // Артефакт бага UTC/МСК: длительность ≈ ровно +3 часа (10800±120 с).
        if (ms >= 2.9 * 3600000 && ms <= 3.1 * 3600000) continue;
        cleaned.push({
            in: s.in,
            out: s.out,
            ms,
            hours: hoursPreciseFromMs(ms),
            source: s.source || 'clock',
            ip_in: s.ip_in || '',
            ip_out: s.ip_out || '',
            device_in: s.device_in || '',
            device_out: s.device_out || '',
        });
    }
    const byIn = new Map();
    for (const s of cleaned) {
        const list = byIn.get(s.in) || [];
        list.push(s);
        byIn.set(s.in, list);
    }
    const out = [];
    for (const list of byIn.values()) {
        if (list.length === 1) {
            out.push(list[0]);
            continue;
        }
        list.sort((a, b) => a.ms - b.ms);
        out.push(list[0]);
    }
    out.sort((a, b) => String(a.in).localeCompare(String(b.in)));
    return out;
}

/**
 * Добавить закрытый сегмент (не дублировать тот же in/out).
 * meta: { ip_in, ip_out, device_in, device_out }
 * @returns {{ segments: object[], hours: number, added: boolean }}
 */
function appendClosedSegment(rawSegments, checkIn, checkOut, source, meta) {
    let segments = sanitizeSegments(rawSegments);
    const inn = typeof checkIn === 'string' && !/[zZ]|[+-]\d{2}/.test(checkIn)
        ? String(checkIn).replace('T', ' ').slice(0, 19)
        : moscowSqlFromDate(checkIn);
    const out = typeof checkOut === 'string' && !/[zZ]|[+-]\d{2}/.test(checkOut)
        ? String(checkOut).replace('T', ' ').slice(0, 19)
        : moscowSqlFromDate(checkOut);
    const ms = msBetween(inn, out);
    if (!inn || !out || ms <= 0) {
        return { segments, hours: hoursFromSegments(segments), added: false };
    }
    const m = meta && typeof meta === 'object' ? meta : {};
    const dup = segments.some((s) => s.in === inn && s.out === out);
    if (!dup) {
        segments.push({
            in: inn,
            out,
            ms,
            hours: hoursPreciseFromMs(ms),
            source: source || 'clock',
            ip_in: m.ip_in != null ? String(m.ip_in) : '',
            ip_out: m.ip_out != null ? String(m.ip_out) : '',
            device_in: m.device_in != null ? String(m.device_in) : '',
            device_out: m.device_out != null ? String(m.device_out) : '',
        });
        segments = sanitizeSegments(segments);
    } else {
        // Дописать IP, если сегмент уже был без них.
        segments = segments.map((s) => {
            if (s.in !== inn || s.out !== out) return s;
            return {
                ...s,
                ip_in: s.ip_in || (m.ip_in != null ? String(m.ip_in) : ''),
                ip_out: s.ip_out || (m.ip_out != null ? String(m.ip_out) : ''),
                device_in: s.device_in || (m.device_in != null ? String(m.device_in) : ''),
                device_out: s.device_out || (m.device_out != null ? String(m.device_out) : ''),
            };
        });
    }
    return { segments, hours: hoursFromSegments(segments), added: !dup };
}

/**
 * → 'YYYY-MM-DD HH:mm:ss' (стена Москвы).
 * Date от mysql2 — абсолютный момент → форматируем в Europe/Moscow
 * (не getUTC*: иначе 16:16 МСК читается как 13:16 и к стопу лишние +3 ч).
 */
function moscowSqlFromDate(d) {
    if (d == null || d === '') return '';
    if (typeof d === 'string') {
        const s = d.trim();
        if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/.test(s) && !/[zZ]|[+-]\d{2}:?\d{2}$/.test(s)) {
            return s.replace('T', ' ').slice(0, 19);
        }
        const parsed = new Date(s);
        if (!Number.isFinite(parsed.getTime())) return '';
        return parsed.toLocaleString('sv-SE', { timeZone: 'Europe/Moscow' }).replace('T', ' ').slice(0, 19);
    }
    if (d instanceof Date && Number.isFinite(d.getTime())) {
        return d.toLocaleString('sv-SE', { timeZone: 'Europe/Moscow' }).replace('T', ' ').slice(0, 19);
    }
    return '';
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

/** Разобрать premium_rule_json → { kind, amount }. */
function parsePremiumRule(raw) {
    if (raw == null || raw === '') return { kind: 'stub', amount: 0 };
    let obj = raw;
    if (typeof raw === 'string') {
        try {
            obj = JSON.parse(raw);
        } catch (e) {
            return { kind: 'stub', amount: 0 };
        }
    }
    if (!obj || typeof obj !== 'object') return { kind: 'stub', amount: 0 };
    const kind = String(obj.kind || 'stub').trim() || 'stub';
    const amount = Number(obj.amount);
    return { kind, amount: Number.isFinite(amount) ? amount : 0 };
}

/**
 * Персональное правило сотрудника перекрывает отдел.
 * personal_premium_rule_json = null → из отдела.
 */
function resolvePremiumRule(emp, dept) {
    if (emp && emp.personal_premium_rule_json != null && emp.personal_premium_rule_json !== '') {
        return parsePremiumRule(emp.personal_premium_rule_json);
    }
    const deptRaw = dept && (dept.premium_rule_json != null ? dept.premium_rule_json : dept.dept_premium_rule_json);
    return parsePremiumRule(deptRaw);
}

/** Доля отработанных ставок к норме месяца (0…1, без потолка выше 1). */
function workShare(workedDays, normDays) {
    const n = Number(normDays);
    if (!Number.isFinite(n) || n <= 0) return 0;
    const w = Number(workedDays);
    if (!Number.isFinite(w) || w <= 0) return 0;
    return w / n;
}

function prorateByWorkedDays(amount, workedDays, normDays) {
    return Math.round((Number(amount) || 0) * workShare(workedDays, normDays) * 100) / 100;
}

/**
 * Премия за период.
 * fixed — фикс × (ставки / норма дней);
 * fixed_full — вся сумма, без учёта дней (отдел продаж).
 */
function computePremium(rule, ctx) {
    const r = rule && rule.kind ? rule : parsePremiumRule(rule);
    const amount = Number(r.amount) || 0;
    if (r.kind === 'fixed_full') {
        return Math.round(amount * 100) / 100;
    }
    if (r.kind === 'fixed') {
        const worked = ctx && ctx.workedDays != null ? ctx.workedDays : 0;
        const norm = ctx && ctx.normDays != null ? ctx.normDays : 0;
        return prorateByWorkedDays(amount, worked, norm);
    }
    return 0;
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

/**
 * DATE / ISO / Date → 'YYYY-MM-DD' (не String(Date)='Fri Oct…').
 * mysql2 отдаёт DATE как Date в UTC (для Москвы часто вчера 21:00Z) —
 * берём календарный день Europe/Moscow, иначе ячейка уезжает на −1 день.
 */
function toYmd(v) {
    if (v == null || v === '') return '';
    if (v instanceof Date && Number.isFinite(v.getTime())) {
        return v.toLocaleDateString('en-CA', { timeZone: 'Europe/Moscow' });
    }
    const s = String(v).trim();
    const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
    if (m) return m[1];
    if (/T|\s/.test(s)) {
        const parsed = new Date(s);
        if (Number.isFinite(parsed.getTime())) return toYmd(parsed);
    }
    return '';
}

/** Период payroll 'YYYY-MM'. mysql2 DATE как Date → раньше давало 'Fri Oct' → SQL 'Fri Oct-01'. */
function periodYmFromDate(ymd) {
    const day = toYmd(ymd);
    if (day) return day.slice(0, 7);
    const s = String(ymd || '');
    const m = s.match(/^(\d{4}-\d{2})/);
    return m ? m[1] : s.slice(0, 7);
}

function daysInMonthYm(ym) {
    const [y, m] = String(ym).split('-').map(Number);
    return new Date(y, m, 0).getDate();
}

/**
 * Норма рабочих дней месяца.
 * Для 5/2 — по производственному календарю РФ (`ws_work_calendar`);
 * при пустой таблице год подтягивается из бандла / xmlcalendar.ru.
 */
async function monthNormDays(db, ym, scheduleType) {
    const dim = daysInMonthYm(ym);
    const [y, m] = String(ym).split('-').map(Number);
    const from = `${ym}-01`;
    const to = `${ym}-${String(dim).padStart(2, '0')}`;

    if (scheduleType === '5/2') {
        try {
            const rf = require('./datagonWorkCalendarRf');
            await rf.ensureYearLoaded(db, y);
        } catch (e) {
            /* ignore sync errors — fallback ниже */
        }
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
    toEpochMs,
    msBetween,
    hoursPreciseFromMs,
    hoursBetween,
    parseSegments,
    segmentsTotalMs,
    hoursFromSegments,
    sanitizeSegments,
    appendClosedSegment,
    moscowSqlFromDate,
    rateFromHours,
    resolveEmployeeThresholds,
    resolveSeniorityParams,
    resolveSickRate,
    parsePremiumRule,
    resolvePremiumRule,
    workShare,
    prorateByWorkedDays,
    computePremium,
    seniorityMonths,
    seniorityBonus,
    moscowYmd,
    moscowNowSql,
    toYmd,
    periodYmFromDate,
    daysInMonthYm,
    monthNormDays,
    vacationDaysAccrued,
};
