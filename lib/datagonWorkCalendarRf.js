'use strict';

/**
 * Производственный календарь РФ → ws_work_calendar.
 * Источник: xmlcalendar.ru (JSON), в репозитории — бандлы lib/data/rf-calendar-YYYY.json.
 *
 * Формат days месяца: список нерабочих + предпраздничных.
 *   «N» / «N+» — нерабочий (выходной / праздник / перенос)
 *   «N*» — рабочий сокращённый (предпраздничный)
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

const DATA_DIR = path.join(__dirname, 'data');
const DEFAULT_YEARS = [2025, 2026, 2027, 2028];

function daysInMonth(y, m) {
    return new Date(y, m, 0).getDate();
}

function pad2(n) {
    return n < 10 ? `0${n}` : String(n);
}

function ymd(y, m, d) {
    return `${y}-${pad2(m)}-${pad2(d)}`;
}

function loadBundledYear(year) {
    const file = path.join(DATA_DIR, `rf-calendar-${year}.json`);
    if (!fs.existsSync(file)) return null;
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
        return null;
    }
}

function fetchJson(url, timeoutMs = 12000) {
    return new Promise((resolve, reject) => {
        const lib = String(url).startsWith('https') ? https : http;
        const req = lib.get(url, { timeout: timeoutMs }, (res) => {
            if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                res.resume();
                fetchJson(res.headers.location, timeoutMs).then(resolve, reject);
                return;
            }
            if (res.statusCode !== 200) {
                res.resume();
                reject(new Error(`HTTP ${res.statusCode} for ${url}`));
                return;
            }
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
                try {
                    resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
                } catch (e) {
                    reject(e);
                }
            });
        });
        req.on('error', reject);
        req.on('timeout', () => {
            req.destroy();
            reject(new Error('timeout'));
        });
    });
}

async function loadYearJson(year, { preferRemote = true } = {}) {
    const y = Number(year);
    if (preferRemote) {
        try {
            const remote = await fetchJson(`http://xmlcalendar.ru/data/ru/${y}/calendar.json`);
            if (remote && remote.months) return { json: remote, source: 'xmlcalendar.ru' };
        } catch (e) {
            /* fallback to bundle */
        }
    }
    const bundled = loadBundledYear(y);
    if (bundled && bundled.months) return { json: bundled, source: 'bundle' };
    if (!preferRemote) {
        try {
            const remote = await fetchJson(`http://xmlcalendar.ru/data/ru/${y}/calendar.json`);
            if (remote && remote.months) return { json: remote, source: 'xmlcalendar.ru' };
        } catch (e2) {
            /* empty */
        }
    }
    return null;
}

/**
 * Разобрать год xmlcalendar → массив дней { cal_date, is_working_day, norm_hours, holiday_name, transfer_note }.
 */
function expandYearDays(yearJson) {
    const year = Number(yearJson.year);
    const transitions = Array.isArray(yearJson.transitions) ? yearJson.transitions : [];
    const transferTo = {};
    for (const t of transitions) {
        if (!t || !t.to) continue;
        const [mm, dd] = String(t.to).split('.').map(Number);
        if (mm && dd) transferTo[ymd(year, mm, dd)] = t.from ? `перенос с ${t.from}` : 'перенос';
    }
    const out = [];
    for (const m of yearJson.months || []) {
        const month = Number(m.month);
        const dim = daysInMonth(year, month);
        const off = new Set();
        const short = new Set();
        for (const tok of String(m.days || '')
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)) {
            const n = parseInt(tok, 10);
            if (!n || n < 1 || n > dim) continue;
            if (tok.includes('*')) short.add(n);
            else off.add(n);
        }
        for (let d = 1; d <= dim; d++) {
            const date = ymd(year, month, d);
            const isShort = short.has(d);
            const isOff = off.has(d) && !isShort;
            const isWorking = isShort || !isOff;
            let holidayName = null;
            let transferNote = transferTo[date] || null;
            if (isOff) {
                holidayName = transferNote ? 'выходной (перенос)' : 'выходной / праздник';
            } else if (isShort) {
                holidayName = 'предпраздничный';
                transferNote = transferNote || 'сокращённый день (−1 ч)';
            }
            out.push({
                cal_date: date,
                is_working_day: isWorking ? 1 : 0,
                norm_hours: isShort ? 7 : isWorking ? 8 : 0,
                holiday_name: holidayName,
                transfer_note: transferNote,
            });
        }
    }
    return out;
}

async function upsertDays(db, days) {
    if (!days.length) return 0;
    const chunkSize = 100;
    let n = 0;
    for (let i = 0; i < days.length; i += chunkSize) {
        const chunk = days.slice(i, i + chunkSize);
        const placeholders = chunk.map(() => '(?, ?, ?, ?, ?)').join(',');
        const params = [];
        for (const d of chunk) {
            params.push(
                d.cal_date,
                d.is_working_day ? 1 : 0,
                Number(d.norm_hours) || 0,
                d.holiday_name || null,
                d.transfer_note || null
            );
        }
        // eslint-disable-next-line no-await-in-loop
        await db.query(
            `INSERT INTO ws_work_calendar (cal_date, is_working_day, norm_hours, holiday_name, transfer_note)
             VALUES ${placeholders}
             ON DUPLICATE KEY UPDATE
               is_working_day=VALUES(is_working_day),
               norm_hours=VALUES(norm_hours),
               holiday_name=VALUES(holiday_name),
               transfer_note=VALUES(transfer_note)`,
            params
        );
        n += chunk.length;
    }
    return n;
}

async function syncYear(db, year, opts = {}) {
    const loaded = await loadYearJson(year, { preferRemote: opts.preferRemote !== false });
    if (!loaded) {
        return { year: Number(year), imported: 0, source: null, error: 'calendar not found' };
    }
    const days = expandYearDays(loaded.json);
    const imported = await upsertDays(db, days);
    const work = days.filter((d) => d.is_working_day).length;
    return {
        year: Number(year),
        imported,
        workdays: work,
        source: loaded.source,
        error: null,
    };
}

async function syncYears(db, years, opts = {}) {
    const list = (years && years.length ? years : DEFAULT_YEARS).map(Number).filter((y) => y >= 2020 && y <= 2040);
    const results = [];
    for (const y of list) {
        // eslint-disable-next-line no-await-in-loop
        results.push(await syncYear(db, y, opts));
    }
    return results;
}

async function yearCoverage(db, year) {
    const [rows] = await db.query(
        `SELECT COUNT(*) AS n, SUM(is_working_day=1) AS work
         FROM ws_work_calendar WHERE YEAR(cal_date)=?`,
        [year]
    );
    return {
        year: Number(year),
        days: Number(rows[0] && rows[0].n) || 0,
        workdays: Number(rows[0] && rows[0].work) || 0,
    };
}

/**
 * Если за месяц мало строк календаря — подтянуть год (бандл / xmlcalendar).
 */
async function ensureYearLoaded(db, year) {
    const y = Number(year);
    if (!y) return { ok: false, synced: false };
    const cov = await yearCoverage(db, y);
    if (cov.days >= 360) return { ok: true, synced: false, coverage: cov };
    const r = await syncYear(db, y, { preferRemote: true });
    return { ok: !r.error && r.imported > 0, synced: true, result: r, coverage: await yearCoverage(db, y) };
}

async function getMonthCalendarMap(db, ym) {
    const m = String(ym || '').slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(m)) return { month: m, source: 'none', days: {}, non_working_days: [], short_days: [] };
    const year = Number(m.slice(0, 4));
    await ensureYearLoaded(db, year);
    const dim = daysInMonth(year, Number(m.slice(5, 7)));
    const from = `${m}-01`;
    const to = `${m}-${pad2(dim)}`;
    const [rows] = await db.query(
        `SELECT DATE_FORMAT(cal_date, '%Y-%m-%d') AS cal_ymd, is_working_day, norm_hours, holiday_name, transfer_note
         FROM ws_work_calendar WHERE cal_date BETWEEN ? AND ? ORDER BY cal_date`,
        [from, to]
    );
    const days = {};
    const non_working_days = [];
    const short_days = [];
    if (!rows.length) {
        for (let d = 1; d <= dim; d++) {
            const wd = new Date(year, Number(m.slice(5, 7)) - 1, d).getDay();
            const working = wd !== 0 && wd !== 6;
            days[d] = { is_working_day: working ? 1 : 0, norm_hours: working ? 8 : 0, holiday_name: working ? null : 'выходной' };
            if (!working) non_working_days.push(d);
        }
        return { month: m, source: 'fallback_mon_fri', days, non_working_days, short_days };
    }
    for (const r of rows) {
        const d = Number(String(r.cal_ymd).slice(8, 10));
        if (!d) continue;
        const working = Number(r.is_working_day) === 1;
        const hours = Number(r.norm_hours) || 0;
        days[d] = {
            is_working_day: working ? 1 : 0,
            norm_hours: hours,
            holiday_name: r.holiday_name || null,
            transfer_note: r.transfer_note || null,
        };
        if (!working) non_working_days.push(d);
        else if (hours > 0 && hours < 8) short_days.push(d);
    }
    return { month: m, source: 'rf', days, non_working_days, short_days };
}

module.exports = {
    DEFAULT_YEARS,
    expandYearDays,
    loadYearJson,
    syncYear,
    syncYears,
    ensureYearLoaded,
    yearCoverage,
    getMonthCalendarMap,
};
