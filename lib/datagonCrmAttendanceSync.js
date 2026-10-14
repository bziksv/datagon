'use strict';

/**
 * Синхронизация таймера смены: Datagon ws_work_log (MSK wall) ↔ CRM rise_attendance (UTC).
 * Источник истины для табеля/ФОТ — Datagon; CRM — зеркало дашборда.
 */

const calc = require('./datagonWorkScheduleCalc');
const crmPrime = require('./crmPrimeTimesheets');

function normalizeFio(name) {
    return String(name || '')
        .trim()
        .toLowerCase()
        .replace(/ё/g, 'е')
        .replace(/[^\p{L}\p{N}\s\-]/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/** Ключ для сопоставления «Имя Фамилия» / «Фамилия Имя» (первые два слова, порядок не важен). */
function fioMatchKey(name) {
    const parts = normalizeFio(name).split(' ').filter(Boolean);
    if (!parts.length) return '';
    if (parts.length === 1) return parts[0];
    return [parts[0], parts[1]].sort().join('|');
}

/** MSK wall 'YYYY-MM-DD HH:mm:ss' → UTC SQL для rise_attendance. */
function mskWallToUtcSql(mskWall) {
    const ms = calc.toEpochMs(mskWall);
    if (!Number.isFinite(ms)) return null;
    return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
}

/** UTC SQL / Date из CRM → MSK wall. */
function utcSqlToMskWall(utcSql) {
    if (utcSql == null || utcSql === '') return '';
    if (utcSql instanceof Date) return calc.moscowSqlFromDate(utcSql);
    const s = String(utcSql).trim();
    let ms;
    if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/.test(s) && !/[zZ]|[+-]\d{2}:?\d{2}$/.test(s)) {
        ms = new Date(s.replace(' ', 'T') + 'Z').getTime();
    } else {
        ms = new Date(s).getTime();
    }
    if (!Number.isFinite(ms)) return '';
    return calc.moscowSqlFromDate(new Date(ms));
}

function utcEpochMs(utcSql) {
    if (utcSql == null || utcSql === '') return NaN;
    if (utcSql instanceof Date) return utcSql.getTime();
    const s = String(utcSql).trim();
    if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/.test(s) && !/[zZ]|[+-]\d{2}:?\d{2}$/.test(s)) {
        return new Date(s.replace(' ', 'T') + 'Z').getTime();
    }
    return new Date(s).getTime();
}

async function crmPrefix() {
    const cfg = crmPrime.crmDbConfig();
    return (cfg && cfg.prefix) || 'rise_';
}

async function getPool() {
    if (!crmPrime.isCrmConfigured()) return null;
    return crmPrime.getCrmPool();
}

async function listCrmStaffUsers() {
    const p = await getPool();
    if (!p) return { configured: false, rows: [] };
    const prefix = await crmPrefix();
    const users = `\`${prefix}users\``;
    try {
        const [rows] = await p.query(
            `SELECT id, first_name, last_name, email, job_title
             FROM ${users}
             WHERE deleted=0 AND user_type='staff'
             ORDER BY last_name, first_name`
        );
        const out = (rows || []).map((r) => {
            const full_name = `${String(r.first_name || '').trim()} ${String(r.last_name || '').trim()}`.trim();
            return {
                id: Number(r.id),
                first_name: r.first_name,
                last_name: r.last_name,
                full_name,
                email: r.email || '',
                job_title: r.job_title || '',
                fio_key: fioMatchKey(full_name),
            };
        });
        return { configured: true, rows: out };
    } catch (e) {
        return { configured: true, rows: [], error: e.message || String(e) };
    }
}

/** Однозначный кандидат CRM по ФИО; иначе null. */
function matchCrmUserByFio(fullName, crmRows) {
    const key = fioMatchKey(fullName);
    if (!key) return null;
    const hits = (crmRows || []).filter((r) => r.fio_key === key);
    if (hits.length === 1) return hits[0];
    return null;
}

async function findOpenCrmAttendance(crmUserId) {
    const p = await getPool();
    if (!p || !crmUserId) return null;
    const prefix = await crmPrefix();
    const t = `\`${prefix}attendance\``;
    const [rows] = await p.query(
        `SELECT id, user_id, in_time, out_time, status, note
         FROM ${t}
         WHERE deleted=0 AND user_id=? AND status='incomplete' AND out_time IS NULL
         ORDER BY id DESC LIMIT 1`,
        [Number(crmUserId)]
    );
    return rows && rows[0] ? rows[0] : null;
}

async function openCrmAttendance(crmUserId, inUtcSql, note) {
    const p = await getPool();
    if (!p || !crmUserId || !inUtcSql) return { ok: false, error: 'crm not configured' };
    const existing = await findOpenCrmAttendance(crmUserId);
    if (existing) {
        return { ok: true, id: Number(existing.id), already_open: true, in_time: existing.in_time };
    }
    const prefix = await crmPrefix();
    const t = `\`${prefix}attendance\``;
    const [ins] = await p.query(
        `INSERT INTO ${t} (user_id, in_time, out_time, status, note, deleted)
         VALUES (?, ?, NULL, 'incomplete', ?, 0)`,
        [Number(crmUserId), inUtcSql, note != null ? String(note).slice(0, 500) : '']
    );
    return { ok: true, id: Number(ins.insertId), already_open: false, in_time: inUtcSql };
}

async function closeCrmAttendance(crmUserId, outUtcSql, note) {
    const p = await getPool();
    if (!p || !crmUserId || !outUtcSql) return { ok: false, error: 'crm not configured' };
    const open = await findOpenCrmAttendance(crmUserId);
    if (!open) return { ok: true, closed: false, reason: 'no_open' };
    const prefix = await crmPrefix();
    const t = `\`${prefix}attendance\``;
    await p.query(
        `UPDATE ${t}
         SET out_time=?, status='pending', note=CONCAT(IFNULL(note,''), ?)
         WHERE id=? AND out_time IS NULL`,
        [outUtcSql, note != null ? String(note).slice(0, 200) : '', Number(open.id)]
    );
    return { ok: true, closed: true, id: Number(open.id) };
}

/**
 * Push: Datagon открыл смену → CRM incomplete.
 * Если CRM уже открыт раньше — оставляем ранний in_time (не двигаем).
 */
async function pushDatagonOpenToCrm(emp, checkInMsk) {
    const crmUserId = emp && Number(emp.crm_user_id);
    if (!crmUserId) return { ok: true, skipped: true, reason: 'no_crm_link' };
    if (!crmPrime.isCrmConfigured()) return { ok: false, error: 'crm_not_configured' };
    const inUtc = mskWallToUtcSql(checkInMsk);
    if (!inUtc) return { ok: false, error: 'bad_check_in' };
    const existing = await findOpenCrmAttendance(crmUserId);
    if (existing) {
        const crmMs = utcEpochMs(existing.in_time);
        const dgMs = calc.toEpochMs(checkInMsk);
        if (Number.isFinite(crmMs) && Number.isFinite(dgMs) && crmMs <= dgMs) {
            return { ok: true, already_open: true, kept_earlier: 'crm', in_time: existing.in_time };
        }
        // Datagon earlier — подтянуть CRM in_time назад
        const prefix = await crmPrefix();
        const t = `\`${prefix}attendance\``;
        const p = await getPool();
        await p.query(`UPDATE ${t} SET in_time=? WHERE id=?`, [inUtc, Number(existing.id)]);
        return { ok: true, already_open: true, kept_earlier: 'datagon', in_time: inUtc };
    }
    return openCrmAttendance(crmUserId, inUtc, ' datagon-sync');
}

async function pushDatagonCloseToCrm(emp, checkOutMsk, noteTag) {
    const crmUserId = emp && Number(emp.crm_user_id);
    if (!crmUserId) return { ok: true, skipped: true, reason: 'no_crm_link' };
    if (!crmPrime.isCrmConfigured()) return { ok: false, error: 'crm_not_configured' };
    const outUtc = mskWallToUtcSql(checkOutMsk);
    if (!outUtc) return { ok: false, error: 'bad_check_out' };
    return closeCrmAttendance(crmUserId, outUtc, noteTag || ' datagon-sync');
}

/**
 * Открыть/выровнять смену Datagon по CRM (вызывается из sync-from-crm).
 * opts: { db, emp, crmInUtc, ip, device, userAgent }
 */
async function alignDatagonOpenFromCrm(opts) {
    const db = opts.db;
    const emp = opts.emp;
    if (!db || !emp) return { ok: false, error: 'bad_args' };
    const checkInMsk = utcSqlToMskWall(opts.crmInUtc) || calc.moscowNowSql();
    const workDate = checkInMsk.slice(0, 10) || calc.moscowYmd();
    const today = calc.moscowYmd();

    const [openRows] = await db.query(
        `SELECT id, work_date,
                DATE_FORMAT(check_in, '%Y-%m-%d %H:%i:%s') AS check_in_sql
         FROM ws_work_log
         WHERE employee_id=? AND check_in IS NOT NULL AND check_out IS NULL
         ORDER BY id DESC LIMIT 1`,
        [emp.id]
    );
    if (openRows.length) {
        const dgIn = openRows[0].check_in_sql;
        const dgMs = calc.toEpochMs(dgIn);
        const crmMs = calc.toEpochMs(checkInMsk);
        if (Number.isFinite(crmMs) && Number.isFinite(dgMs) && crmMs < dgMs) {
            await db.query(`UPDATE ws_work_log SET check_in=? WHERE id=?`, [
                checkInMsk,
                openRows[0].id,
            ]);
            return { ok: true, action: 'aligned_earlier_crm', check_in: checkInMsk, work_date: calc.toYmd(openRows[0].work_date) };
        }
        return { ok: true, action: 'already_open', check_in: dgIn, work_date: calc.toYmd(openRows[0].work_date) };
    }

    // Открыть на work_date CRM (или сегодня, если дата в будущем)
    const ymd = workDate <= today ? workDate : today;
    const [existing] = await db.query(
        `SELECT id, DATE_FORMAT(check_in, '%Y-%m-%d %H:%i:%s') AS check_in_sql,
                DATE_FORMAT(check_out, '%Y-%m-%d %H:%i:%s') AS check_out_sql, segments_json, hours_worked, source
         FROM ws_work_log WHERE employee_id=? AND work_date=? LIMIT 1`,
        [emp.id, ymd]
    );
    if (existing.length) {
        const row = existing[0];
        let sealed = calc.parseSegments(row.segments_json);
        let hoursSoFar = Number(row.hours_worked) || 0;
        if (row.check_in_sql && row.check_out_sql) {
            const packed = calc.appendClosedSegment(
                sealed,
                row.check_in_sql,
                row.check_out_sql,
                row.source || 'clock',
                {}
            );
            sealed = packed.segments;
            hoursSoFar = packed.hours;
        }
        const thr = calc.resolveEmployeeThresholds(emp, emp);
        const rate = calc.rateFromHours(calc.roundHoursTo5Min(hoursSoFar), thr);
        await db.query(
            `UPDATE ws_work_log SET
               check_in=?, check_out=NULL, check_out_ip=NULL, check_out_device=NULL,
               check_in_ip=?, check_in_device=?, user_agent=?,
               hours_worked=?, rate=?, segments_json=?, status='ok', source='clock'
             WHERE id=?`,
            [
                checkInMsk,
                opts.ip || null,
                opts.device || 'crm-sync',
                opts.userAgent || 'crm-sync',
                hoursSoFar,
                rate,
                JSON.stringify(sealed),
                row.id,
            ]
        );
        return { ok: true, action: 'reopened', check_in: checkInMsk, work_date: ymd };
    }

    await db.query(
        `INSERT INTO ws_work_log
         (employee_id, work_date, type, rate, check_in, check_in_ip, check_in_device, user_agent,
          hours_worked, segments_json, source, status)
         VALUES (?, ?, 'work', 0, ?, ?, ?, ?, 0, ?, 'clock', 'ok')`,
        [
            emp.id,
            ymd,
            checkInMsk,
            opts.ip || null,
            opts.device || 'crm-sync',
            opts.userAgent || 'crm-sync',
            JSON.stringify([]),
        ]
    );
    return { ok: true, action: 'opened', check_in: checkInMsk, work_date: ymd };
}

/**
 * Стоп Datagon по сигналу CRM (если смена открыта).
 */
async function alignDatagonCloseFromCrm(opts) {
    const db = opts.db;
    const emp = opts.emp;
    if (!db || !emp) return { ok: false, error: 'bad_args' };
    const [rows] = await db.query(
        `SELECT *, DATE_FORMAT(check_in, '%Y-%m-%d %H:%i:%s') AS check_in_sql
         FROM ws_work_log
         WHERE employee_id=? AND check_in IS NOT NULL AND check_out IS NULL
         ORDER BY id DESC LIMIT 1`,
        [emp.id]
    );
    if (!rows.length) return { ok: true, action: 'already_closed' };
    const log = rows[0];
    const now = utcSqlToMskWall(opts.crmOutUtc) || calc.moscowNowSql();
    const packed = calc.appendClosedSegment(
        log.segments_json,
        log.check_in_sql || log.check_in,
        now,
        'clock',
        { device_out: 'crm-sync' }
    );
    const hours = packed.hours;
    const thr = calc.resolveEmployeeThresholds(emp, emp);
    const rate = calc.rateFromHours(calc.roundHoursTo5Min(hours), thr);
    await db.query(
        `UPDATE ws_work_log SET
           check_out=?, check_out_device='crm-sync',
           hours_worked=?, rate=?, segments_json=?, status='ok'
         WHERE id=? AND check_out IS NULL`,
        [now, hours, rate, JSON.stringify(packed.segments), log.id]
    );
    try {
        const { recalcPayroll } = opts;
        if (typeof recalcPayroll === 'function') {
            await recalcPayroll(db, emp.id, calc.periodYmFromDate(calc.toYmd(log.work_date)));
        }
    } catch (_) {
        /* ignore */
    }
    return { ok: true, action: 'closed', check_out: now, hours_worked: hours };
}

async function getEmployeeByCrmUserId(db, crmUserId) {
    const id = Number(crmUserId);
    if (!id) return null;
    const [rows] = await db.query(
        `SELECT e.*, d.name AS department_name, d.schedule_type, d.norm_hours, d.rate_full_hours, d.rate_half_hours,
                d.premium_rule_json AS dept_premium_rule_json,
                u.full_name AS user_full_name, u.username
         FROM ws_employee e
         JOIN ws_department d ON d.id = e.department_id
         JOIN users u ON u.id = e.user_id
         WHERE e.crm_user_id=? AND (e.fire_date IS NULL OR e.fire_date >= CURDATE())
         LIMIT 1`,
        [id]
    );
    return rows[0] || null;
}

/** Автопривязка: однозначные ФИО. Возвращает { linked, skipped, ambiguous }. */
async function backfillCrmLinks(db) {
    const list = await listCrmStaffUsers();
    if (!list.configured || list.error) {
        return { linked: 0, skipped: 0, ambiguous: 0, error: list.error || 'crm_not_configured' };
    }
    const [emps] = await db.query(
        `SELECT e.id, u.full_name
         FROM ws_employee e
         JOIN users u ON u.id=e.user_id
         WHERE (e.crm_user_id IS NULL OR e.crm_user_id=0)
           AND (e.fire_date IS NULL OR e.fire_date >= CURDATE())`
    );
    let linked = 0;
    let skipped = 0;
    let ambiguous = 0;
    const used = new Set(
        (
            await db.query(
                `SELECT crm_user_id FROM ws_employee WHERE crm_user_id IS NOT NULL AND crm_user_id>0`
            )
        )[0].map((r) => Number(r.crm_user_id))
    );
    for (const e of emps || []) {
        const key = fioMatchKey(e.full_name);
        const hits = list.rows.filter((r) => r.fio_key === key && !used.has(r.id));
        if (hits.length === 1) {
            await db.query(`UPDATE ws_employee SET crm_user_id=? WHERE id=?`, [hits[0].id, e.id]);
            used.add(hits[0].id);
            linked += 1;
        } else if (hits.length > 1) {
            ambiguous += 1;
        } else {
            skipped += 1;
        }
    }
    return { linked, skipped, ambiguous };
}

/**
 * Reconcile: для linked с открытой одной стороной — выровнять.
 */
async function reconcileLinkedClocks(db, opts) {
    if (!crmPrime.isCrmConfigured()) return { checked: 0, fixed: 0 };
    const [emps] = await db.query(
        `SELECT e.id, e.crm_user_id, e.personal_work_hours_per_day, e.personal_rate_full_hours, e.personal_rate_half_hours,
                d.norm_hours, d.rate_full_hours, d.rate_half_hours
         FROM ws_employee e
         JOIN ws_department d ON d.id=e.department_id
         WHERE e.crm_user_id IS NOT NULL AND e.crm_user_id>0
           AND (e.fire_date IS NULL OR e.fire_date >= CURDATE())`
    );
    let checked = 0;
    let fixed = 0;
    for (const e of emps || []) {
        checked += 1;
        const [dgOpen] = await db.query(
            `SELECT id, DATE_FORMAT(check_in, '%Y-%m-%d %H:%i:%s') AS check_in_sql
             FROM ws_work_log
             WHERE employee_id=? AND check_in IS NOT NULL AND check_out IS NULL
             LIMIT 1`,
            [e.id]
        );
        const crmOpen = await findOpenCrmAttendance(e.crm_user_id);
        if (dgOpen.length && !crmOpen) {
            const r = await pushDatagonOpenToCrm(e, dgOpen[0].check_in_sql);
            if (r && r.ok && !r.skipped) fixed += 1;
        } else if (!dgOpen.length && crmOpen) {
            const r = await alignDatagonOpenFromCrm({
                db,
                emp: e,
                crmInUtc: crmOpen.in_time,
                device: 'crm-reconcile',
                userAgent: 'crm-reconcile',
            });
            if (r && r.ok && r.action !== 'already_open') fixed += 1;
        } else if (dgOpen.length && crmOpen) {
            const dgMs = calc.toEpochMs(dgOpen[0].check_in_sql);
            const crmMs = utcEpochMs(crmOpen.in_time);
            if (Number.isFinite(dgMs) && Number.isFinite(crmMs) && Math.abs(dgMs - crmMs) > 2000) {
                const earlier = dgMs <= crmMs ? 'datagon' : 'crm';
                if (earlier === 'crm') {
                    await alignDatagonOpenFromCrm({
                        db,
                        emp: e,
                        crmInUtc: crmOpen.in_time,
                        device: 'crm-reconcile',
                    });
                } else {
                    await pushDatagonOpenToCrm(e, dgOpen[0].check_in_sql);
                }
                fixed += 1;
            }
        }
    }
    return { checked, fixed };
}

module.exports = {
    normalizeFio,
    fioMatchKey,
    mskWallToUtcSql,
    utcSqlToMskWall,
    utcEpochMs,
    listCrmStaffUsers,
    matchCrmUserByFio,
    findOpenCrmAttendance,
    openCrmAttendance,
    closeCrmAttendance,
    pushDatagonOpenToCrm,
    pushDatagonCloseToCrm,
    alignDatagonOpenFromCrm,
    alignDatagonCloseFromCrm,
    getEmployeeByCrmUserId,
    backfillCrmLinks,
    reconcileLinkedClocks,
    isCrmConfigured: () => crmPrime.isCrmConfigured(),
};
