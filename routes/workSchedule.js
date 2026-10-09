'use strict';

const express = require('express');
const { ensureWorkScheduleSchema } = require('../lib/datagonWorkScheduleSchema');
const calc = require('../lib/datagonWorkScheduleCalc');

let schemaReady = false;

async function ensureSchema(db) {
    if (schemaReady) return;
    await ensureWorkScheduleSchema(db);
    schemaReady = true;
}

function actorOf(req) {
    return req.datagonActor || {};
}

function isAdminActor(actor) {
    return String(actor.username || '').toLowerCase() === 'admin';
}

function isAccounting(actor) {
    if (isAdminActor(actor)) return true;
    const sp = String(actor.specialty_name || '');
    if (sp === 'Бухгалтерия' || sp === 'Полный доступ') return true;
    return false;
}

function clientIp(req) {
    const xf = req.headers['x-forwarded-for'];
    if (xf) return String(xf).split(',')[0].trim().slice(0, 64);
    return String(req.socket?.remoteAddress || '').slice(0, 64);
}

function userAgent(req) {
    return String(req.headers['user-agent'] || '').slice(0, 512);
}

function deviceLabel(req) {
    const ua = userAgent(req);
    if (/Mobile|Android|iPhone/i.test(ua)) return 'mobile';
    if (/Macintosh|Windows|Linux/i.test(ua)) return 'desktop';
    return 'unknown';
}

async function writeAudit(db, req, row) {
    const a = actorOf(req);
    await db.query(
        `INSERT INTO ws_audit_log
         (entity_type, entity_id, action, field_name, old_value, new_value, user_id, user_role, ip, user_agent)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            row.entity_type,
            String(row.entity_id),
            row.action,
            row.field_name || null,
            row.old_value != null ? String(row.old_value).slice(0, 4000) : null,
            row.new_value != null ? String(row.new_value).slice(0, 4000) : null,
            a.id || null,
            isAccounting(a) ? 'accounting' : 'employee',
            clientIp(req),
            userAgent(req),
        ]
    );
}

async function getEmployeeByUserId(db, userId) {
    const [rows] = await db.query(
        `SELECT e.*, d.name AS department_name, d.schedule_type, d.norm_hours, d.rate_full_hours, d.rate_half_hours,
                d.vacation_overlap_limit, d.head_user_id, d.organization_id AS dept_org_id,
                o.name AS organization_name, o.sick_unofficial_rate, o.seniority_base, o.seniority_step,
                o.seniority_period_months, o.timezone, o.clock_auto_close_hours,
                u.full_name AS user_full_name, u.username
         FROM ws_employee e
         JOIN ws_department d ON d.id = e.department_id
         JOIN ws_organization o ON o.id = e.organization_id
         JOIN users u ON u.id = e.user_id
         WHERE e.user_id = ? AND (e.fire_date IS NULL OR e.fire_date >= CURDATE())
         LIMIT 1`,
        [userId]
    );
    return rows[0] || null;
}

async function getEmployeeById(db, id) {
    const [rows] = await db.query(
        `SELECT e.*, d.name AS department_name, d.schedule_type, d.norm_hours, d.rate_full_hours, d.rate_half_hours,
                d.vacation_overlap_limit, d.head_user_id,
                o.sick_unofficial_rate, o.seniority_base, o.seniority_step, o.seniority_period_months, o.timezone,
                u.full_name AS user_full_name, u.username
         FROM ws_employee e
         JOIN ws_department d ON d.id = e.department_id
         JOIN ws_organization o ON o.id = e.organization_id
         JOIN users u ON u.id = e.user_id
         WHERE e.id = ? LIMIT 1`,
        [id]
    );
    return rows[0] || null;
}

function isDeptHead(actor, empOrDept) {
    const headId = empOrDept.head_user_id != null ? empOrDept.head_user_id : empOrDept;
    return Number(actor.id) === Number(headId);
}

async function recalcPayroll(db, employeeId, periodYm) {
    const emp = await getEmployeeById(db, employeeId);
    if (!emp) return null;
    const thr = calc.resolveEmployeeThresholds(emp, emp);
    const normDays = await calc.monthNormDays(db, periodYm, thr.scheduleType);
    const dim = calc.daysInMonthYm(periodYm);
    const from = `${periodYm}-01`;
    const to = `${periodYm}-${String(dim).padStart(2, '0')}`;

    const [logs] = await db.query(
        `SELECT rate, type, hours_worked FROM ws_work_log
         WHERE employee_id = ? AND work_date BETWEEN ? AND ?`,
        [employeeId, from, to]
    );
    let worked = 0;
    for (const L of logs) {
        if (L.type === 'work') worked += Number(L.rate) || 0;
        else if (L.type === 'vacation' || L.type === 'sick' || L.type === 'business_trip') worked += 1;
    }

    const [sicks] = await db.query(
        `SELECT official, amount, date_from, date_to FROM ws_sick_leave
         WHERE employee_id = ? AND date_to >= ? AND date_from <= ?`,
        [employeeId, from, to]
    );
    let sickPay = 0;
    for (const s of sicks) {
        sickPay += Number(s.amount) || 0;
    }

    const [comps] = await db.query(
        `SELECT amount FROM ws_vacation_compensation WHERE employee_id = ? AND DATE_FORMAT(created_at, '%Y-%m') = ?`,
        [employeeId, periodYm]
    );
    let vacationCompensation = 0;
    for (const c of comps) vacationCompensation += Number(c.amount) || 0;

    const [abs] = await db.query(
        `SELECT type, paid, amount FROM ws_absence
         WHERE employee_id = ? AND date_to >= ? AND date_from <= ?`,
        [employeeId, from, to]
    );
    let dayoffPay = 0;
    let businessTripPay = 0;
    for (const a of abs) {
        if (a.type === 'business_trip') businessTripPay += Number(a.amount) || 0;
        else if (a.paid) dayoffPay += Number(a.amount) || 0;
    }

    const salary = Number(emp.salary) || 0;
    const base = normDays > 0 ? Math.round(((salary * worked) / normDays) * 100) / 100 : 0;
    const senParams = calc.resolveSeniorityParams(emp, emp);
    const seniority = calc.seniorityBonus(emp.hire_date, `${periodYm}-28`, senParams);
    const premium = 0;
    const vacationPay = 0;
    const total =
        Math.round(
            (base + premium + seniority + vacationPay + sickPay + dayoffPay + businessTripPay + vacationCompensation) *
                100
        ) / 100;

    await db.query(
        `INSERT INTO ws_payroll_entry
         (employee_id, period_ym, base_salary, premium, seniority_bonus, vacation_pay, sick_pay,
          dayoff_pay, business_trip_pay, vacation_compensation, total, worked_days, norm_days, calculated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           base_salary=VALUES(base_salary), premium=VALUES(premium), seniority_bonus=VALUES(seniority_bonus),
           vacation_pay=VALUES(vacation_pay), sick_pay=VALUES(sick_pay), dayoff_pay=VALUES(dayoff_pay),
           business_trip_pay=VALUES(business_trip_pay), vacation_compensation=VALUES(vacation_compensation),
           total=VALUES(total), worked_days=VALUES(worked_days), norm_days=VALUES(norm_days),
           calculated_at=VALUES(calculated_at)`,
        [
            employeeId,
            periodYm,
            base,
            premium,
            seniority,
            vacationPay,
            sickPay,
            dayoffPay,
            businessTripPay,
            vacationCompensation,
            total,
            worked,
            normDays,
            calc.moscowNowSql(),
        ]
    );

    return {
        employee_id: employeeId,
        period_ym: periodYm,
        base_salary: base,
        premium,
        seniority_bonus: seniority,
        vacation_pay: vacationPay,
        sick_pay: sickPay,
        dayoff_pay: dayoffPay,
        business_trip_pay: businessTripPay,
        vacation_compensation: vacationCompensation,
        total,
        worked_days: worked,
        norm_days: normDays,
    };
}

function createWorkScheduleRouter(db) {
    const router = express.Router();

    router.use(async (req, res, next) => {
        try {
            await ensureSchema(db);
            next();
        } catch (e) {
            next(e);
        }
    });

    // ----- access snapshot -----
    router.get('/access', async (req, res) => {
        const a = actorOf(req);
        const emp = a.id ? await getEmployeeByUserId(db, a.id) : null;
        const accounting = isAccounting(a);
        res.json({
            success: true,
            is_admin: isAdminActor(a),
            is_accounting: accounting,
            is_employee: !!emp,
            is_dept_head: emp ? isDeptHead(a, emp) : false,
            employee: emp
                ? {
                      id: emp.id,
                      full_name: emp.user_full_name,
                      department_id: emp.department_id,
                      department_name: emp.department_name,
                      organization_id: emp.organization_id,
                  }
                : null,
        });
    });

    // ----- organizations -----
    router.get('/organizations', async (req, res) => {
        if (!isAccounting(actorOf(req))) return res.status(403).json({ success: false, error: 'forbidden' });
        const [rows] = await db.query('SELECT * FROM ws_organization ORDER BY id');
        res.json({ success: true, rows });
    });

    router.post('/organizations', async (req, res) => {
        if (!isAccounting(actorOf(req))) return res.status(403).json({ success: false, error: 'forbidden' });
        const b = req.body || {};
        const [r] = await db.query(
            `INSERT INTO ws_organization
             (name, inn, address, timezone, sick_unofficial_rate, seniority_base, seniority_step, seniority_period_months)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                String(b.name || '').trim() || 'Организация',
                b.inn || null,
                b.address || null,
                b.timezone || 'Europe/Moscow',
                Number(b.sick_unofficial_rate) || 0,
                Number(b.seniority_base) || 1000,
                Number(b.seniority_step) || 500,
                Number(b.seniority_period_months) || 6,
            ]
        );
        await writeAudit(db, req, { entity_type: 'organization', entity_id: r.insertId, action: 'create' });
        res.json({ success: true, id: r.insertId });
    });

    router.put('/organizations/:id', async (req, res) => {
        if (!isAccounting(actorOf(req))) return res.status(403).json({ success: false, error: 'forbidden' });
        const id = Number(req.params.id);
        const b = req.body || {};
        await db.query(
            `UPDATE ws_organization SET
             name=?, inn=?, address=?, timezone=?, sick_unofficial_rate=?,
             seniority_base=?, seniority_step=?, seniority_period_months=?,
             clock_auto_close_hours=COALESCE(?, clock_auto_close_hours)
             WHERE id=?`,
            [
                String(b.name || '').trim(),
                b.inn || null,
                b.address || null,
                b.timezone || 'Europe/Moscow',
                Number(b.sick_unofficial_rate) || 0,
                Number(b.seniority_base) || 1000,
                Number(b.seniority_step) || 500,
                Number(b.seniority_period_months) || 6,
                b.clock_auto_close_hours != null ? Number(b.clock_auto_close_hours) : null,
                id,
            ]
        );
        await writeAudit(db, req, { entity_type: 'organization', entity_id: id, action: 'update' });
        const [rows] = await db.query('SELECT * FROM ws_organization WHERE id=?', [id]);
        res.json({ success: true, row: rows[0] });
    });

    router.delete('/organizations/:id', async (req, res) => {
        if (!isAccounting(actorOf(req))) return res.status(403).json({ success: false, error: 'forbidden' });
        const id = Number(req.params.id);
        if (!id) return res.status(400).json({ success: false, error: 'id required' });
        const [[org]] = await db.query('SELECT id, name FROM ws_organization WHERE id=?', [id]);
        if (!org) return res.status(404).json({ success: false, error: 'организация не найдена' });
        const [[empCnt]] = await db.query(
            'SELECT COUNT(*) AS c FROM ws_employee WHERE organization_id=?',
            [id]
        );
        const employees = Number(empCnt && empCnt.c) || 0;
        if (employees > 0) {
            return res.status(409).json({
                success: false,
                error:
                    'Нельзя удалить: в организации ' +
                    employees +
                    ' сотрудник(ов). Сначала перенесите или удалите карточки.',
                employees,
            });
        }
        const [[deptCnt]] = await db.query(
            'SELECT COUNT(*) AS c FROM ws_department WHERE organization_id=?',
            [id]
        );
        const departments = Number(deptCnt && deptCnt.c) || 0;
        await db.query('DELETE FROM ws_department WHERE organization_id=?', [id]);
        await db.query('DELETE FROM ws_organization WHERE id=?', [id]);
        await writeAudit(db, req, {
            entity_type: 'organization',
            entity_id: id,
            action: 'delete',
            payload: { name: org.name, departments_removed: departments },
        });
        res.json({
            success: true,
            id,
            name: org.name,
            departments_removed: departments,
        });
    });

    // ----- departments -----
    router.get('/departments', async (req, res) => {
        const a = actorOf(req);
        const orgId = req.query.organization_id ? Number(req.query.organization_id) : null;
        let sql = `SELECT d.*, u.full_name AS head_name FROM ws_department d
                   LEFT JOIN users u ON u.id = d.head_user_id WHERE 1=1`;
        const params = [];
        if (orgId) {
            sql += ' AND d.organization_id=?';
            params.push(orgId);
        }
        if (!isAccounting(a)) {
            const emp = await getEmployeeByUserId(db, a.id);
            if (!emp) return res.status(403).json({ success: false, error: 'forbidden' });
            sql += ' AND d.id=?';
            params.push(emp.department_id);
        }
        sql += ' ORDER BY d.name';
        const [rows] = await db.query(sql, params);
        res.json({ success: true, rows });
    });

    router.post('/departments', async (req, res) => {
        if (!isAccounting(actorOf(req))) return res.status(403).json({ success: false, error: 'forbidden' });
        const b = req.body || {};
        const [r] = await db.query(
            `INSERT INTO ws_department
             (organization_id, name, head_user_id, schedule_type, norm_hours, rate_full_hours, rate_half_hours,
              vacation_overlap_limit, premium_rule_json)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                Number(b.organization_id),
                String(b.name || '').trim() || 'Отдел',
                b.head_user_id ? Number(b.head_user_id) : null,
                b.schedule_type || '5/2',
                Number(b.norm_hours) || 8,
                Number(b.rate_full_hours) || 7,
                Number(b.rate_half_hours) || 4,
                Number(b.vacation_overlap_limit) || 1,
                JSON.stringify(b.premium_rule_json || { kind: 'stub' }),
            ]
        );
        await writeAudit(db, req, { entity_type: 'department', entity_id: r.insertId, action: 'create' });
        res.json({ success: true, id: r.insertId });
    });

    router.put('/departments/:id', async (req, res) => {
        if (!isAccounting(actorOf(req))) return res.status(403).json({ success: false, error: 'forbidden' });
        const id = Number(req.params.id);
        const b = req.body || {};
        await db.query(
            `UPDATE ws_department SET
             name=?, head_user_id=?, schedule_type=?, norm_hours=?, rate_full_hours=?, rate_half_hours=?,
             vacation_overlap_limit=?, premium_rule_json=?
             WHERE id=?`,
            [
                String(b.name || '').trim(),
                b.head_user_id ? Number(b.head_user_id) : null,
                b.schedule_type || '5/2',
                Number(b.norm_hours) || 8,
                Number(b.rate_full_hours) || 7,
                Number(b.rate_half_hours) || 4,
                Number(b.vacation_overlap_limit) || 1,
                JSON.stringify(b.premium_rule_json || { kind: 'stub' }),
                id,
            ]
        );
        await writeAudit(db, req, { entity_type: 'department', entity_id: id, action: 'update' });
        res.json({ success: true });
    });

    // ----- employees -----
    router.get('/employees', async (req, res) => {
        const a = actorOf(req);
        const accounting = isAccounting(a);
        let sql = `SELECT e.*, u.full_name, u.username, d.name AS department_name,
                          o.name AS organization_name
                   FROM ws_employee e
                   JOIN users u ON u.id = e.user_id
                   JOIN ws_department d ON d.id = e.department_id
                   JOIN ws_organization o ON o.id = e.organization_id WHERE 1=1`;
        const params = [];
        if (req.query.organization_id) {
            sql += ' AND e.organization_id=?';
            params.push(Number(req.query.organization_id));
        }
        if (req.query.department_id) {
            sql += ' AND e.department_id=?';
            params.push(Number(req.query.department_id));
        }
        if (!accounting) {
            const emp = await getEmployeeByUserId(db, a.id);
            if (!emp) return res.status(403).json({ success: false, error: 'forbidden' });
            if (isDeptHead(a, emp)) {
                sql += ' AND e.department_id=?';
                params.push(emp.department_id);
            } else {
                sql += ' AND e.id=?';
                params.push(emp.id);
            }
        }
        sql += ' ORDER BY u.full_name';
        const [rows] = await db.query(sql, params);
        res.json({ success: true, rows });
    });

    router.get('/users-available', async (req, res) => {
        if (!isAccounting(actorOf(req))) return res.status(403).json({ success: false, error: 'forbidden' });
        const [rows] = await db.query(
            `SELECT u.id, u.username, u.full_name
             FROM users u
             LEFT JOIN ws_employee e ON e.user_id = u.id
             WHERE e.id IS NULL AND IFNULL(u.is_archived,0)=0
             ORDER BY u.full_name, u.username`
        );
        res.json({ success: true, rows });
    });

    router.post('/employees', async (req, res) => {
        if (!isAccounting(actorOf(req))) return res.status(403).json({ success: false, error: 'forbidden' });
        const b = req.body || {};
        const userId = Number(b.user_id);
        if (!userId) return res.status(400).json({ success: false, error: 'user_id required' });
        try {
            const [r] = await db.query(
                `INSERT INTO ws_employee
                 (user_id, organization_id, department_id, position, hire_date, fire_date, salary, grade,
                  official_employment, personal_work_hours_per_day, personal_rate_full_hours, personal_rate_half_hours,
                  personal_sick_leave_rate, personal_schedule_type)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    userId,
                    Number(b.organization_id),
                    Number(b.department_id),
                    b.position || null,
                    b.hire_date || null,
                    b.fire_date || null,
                    Number(b.salary) || 0,
                    b.grade || null,
                    b.official_employment ? 1 : 0,
                    b.personal_work_hours_per_day !== '' && b.personal_work_hours_per_day != null
                        ? Number(b.personal_work_hours_per_day)
                        : null,
                    b.personal_rate_full_hours !== '' && b.personal_rate_full_hours != null
                        ? Number(b.personal_rate_full_hours)
                        : null,
                    b.personal_rate_half_hours !== '' && b.personal_rate_half_hours != null
                        ? Number(b.personal_rate_half_hours)
                        : null,
                    b.personal_sick_leave_rate !== '' && b.personal_sick_leave_rate != null
                        ? Number(b.personal_sick_leave_rate)
                        : null,
                    b.personal_schedule_type || null,
                ]
            );
            await writeAudit(db, req, { entity_type: 'employee', entity_id: r.insertId, action: 'create' });
            res.json({ success: true, id: r.insertId });
        } catch (e) {
            if (e && e.code === 'ER_DUP_ENTRY') {
                return res.status(409).json({ success: false, error: 'user already linked' });
            }
            throw e;
        }
    });

    router.put('/employees/:id', async (req, res) => {
        if (!isAccounting(actorOf(req))) return res.status(403).json({ success: false, error: 'forbidden' });
        const id = Number(req.params.id);
        const b = req.body || {};
        const nullIfEmpty = (v) => (v === '' || v == null ? null : Number(v));
        await db.query(
            `UPDATE ws_employee SET
             organization_id=?, department_id=?, position=?, hire_date=?, fire_date=?, salary=?, grade=?,
             official_employment=?, personal_work_hours_per_day=?, personal_rate_full_hours=?,
             personal_rate_half_hours=?, personal_sick_leave_rate=?, personal_schedule_type=?
             WHERE id=?`,
            [
                Number(b.organization_id),
                Number(b.department_id),
                b.position || null,
                b.hire_date || null,
                b.fire_date || null,
                Number(b.salary) || 0,
                b.grade || null,
                b.official_employment ? 1 : 0,
                nullIfEmpty(b.personal_work_hours_per_day),
                nullIfEmpty(b.personal_rate_full_hours),
                nullIfEmpty(b.personal_rate_half_hours),
                nullIfEmpty(b.personal_sick_leave_rate),
                b.personal_schedule_type || null,
                id,
            ]
        );
        await writeAudit(db, req, { entity_type: 'employee', entity_id: id, action: 'update' });
        res.json({ success: true });
    });

    // ----- clock -----
    router.get('/clock/status', async (req, res) => {
        const a = actorOf(req);
        const emp = await getEmployeeByUserId(db, a.id);
        if (!emp) return res.json({ success: true, open: false, employee: null });
        const today = calc.moscowYmd();
        const [rows] = await db.query(
            `SELECT * FROM ws_work_log WHERE employee_id=? AND work_date=? AND check_in IS NOT NULL AND check_out IS NULL
             LIMIT 1`,
            [emp.id, today]
        );
        const open = rows[0] || null;
        res.json({
            success: true,
            open: !!open,
            employee_id: emp.id,
            work_date: today,
            check_in: open ? open.check_in : null,
            status: open ? open.status : null,
            server_now: calc.moscowNowSql(),
        });
    });

    router.post('/clock/start', async (req, res) => {
        const a = actorOf(req);
        const emp = await getEmployeeByUserId(db, a.id);
        if (!emp) return res.status(403).json({ success: false, error: 'no employee card' });
        const today = calc.moscowYmd();
        const [open] = await db.query(
            `SELECT id FROM ws_work_log WHERE employee_id=? AND check_in IS NOT NULL AND check_out IS NULL LIMIT 1`,
            [emp.id]
        );
        if (open.length) return res.status(409).json({ success: false, error: 'shift already open' });
        const [existing] = await db.query(
            `SELECT id, check_out FROM ws_work_log WHERE employee_id=? AND work_date=? LIMIT 1`,
            [emp.id, today]
        );
        if (existing.length && existing[0].check_out) {
            return res.status(409).json({ success: false, error: 'day already closed' });
        }
        const now = calc.moscowNowSql();
        if (existing.length) {
            await db.query(
                `UPDATE ws_work_log SET check_in=?, check_in_ip=?, check_in_device=?, user_agent=?, status='ok', source='clock'
                 WHERE id=?`,
                [now, clientIp(req), deviceLabel(req), userAgent(req), existing[0].id]
            );
        } else {
            await db.query(
                `INSERT INTO ws_work_log
                 (employee_id, work_date, type, rate, check_in, check_in_ip, check_in_device, user_agent, source, status)
                 VALUES (?, ?, 'work', 0, ?, ?, ?, ?, 'clock', 'ok')`,
                [emp.id, today, now, clientIp(req), deviceLabel(req), userAgent(req)]
            );
        }
        await writeAudit(db, req, { entity_type: 'work_log', entity_id: `${emp.id}:${today}`, action: 'clock_start' });
        res.json({ success: true, check_in: now, work_date: today });
    });

    router.post('/clock/stop', async (req, res) => {
        const a = actorOf(req);
        const emp = await getEmployeeByUserId(db, a.id);
        if (!emp) return res.status(403).json({ success: false, error: 'no employee card' });
        const [rows] = await db.query(
            `SELECT * FROM ws_work_log WHERE employee_id=? AND check_in IS NOT NULL AND check_out IS NULL
             ORDER BY id DESC LIMIT 1`,
            [emp.id]
        );
        if (!rows.length) return res.status(409).json({ success: false, error: 'no open shift' });
        const log = rows[0];
        const now = calc.moscowNowSql();
        const hours = calc.hoursBetween(log.check_in, now);
        const thr = calc.resolveEmployeeThresholds(emp, emp);
        const rate = calc.rateFromHours(hours, thr);
        await db.query(
            `UPDATE ws_work_log SET check_out=?, check_out_ip=?, check_out_device=?, hours_worked=?, rate=?, status='ok'
             WHERE id=?`,
            [now, clientIp(req), deviceLabel(req), hours, rate, log.id]
        );
        const period = calc.periodYmFromDate(log.work_date);
        const payroll = await recalcPayroll(db, emp.id, period);
        await writeAudit(db, req, {
            entity_type: 'work_log',
            entity_id: String(log.id),
            action: 'clock_stop',
            new_value: JSON.stringify({ hours, rate }),
        });
        res.json({ success: true, hours_worked: hours, rate, payroll });
    });

    router.get('/stuck-shifts', async (req, res) => {
        const a = actorOf(req);
        const accounting = isAccounting(a);
        const emp = await getEmployeeByUserId(db, a.id);
        if (!accounting && !(emp && isDeptHead(a, emp))) {
            return res.status(403).json({ success: false, error: 'forbidden' });
        }
        let sql = `SELECT w.*, e.department_id, u.full_name
                   FROM ws_work_log w
                   JOIN ws_employee e ON e.id = w.employee_id
                   JOIN users u ON u.id = e.user_id
                   WHERE w.check_in IS NOT NULL AND w.check_out IS NULL`;
        const params = [];
        if (!accounting && emp) {
            sql += ' AND e.department_id=?';
            params.push(emp.department_id);
        }
        sql += ' ORDER BY w.check_in';
        const [rows] = await db.query(sql, params);
        const now = Date.now();
        res.json({
            success: true,
            rows: rows.map((r) => ({
                ...r,
                hours_open: calc.roundHoursTo5Min((now - new Date(r.check_in).getTime()) / 3600000),
            })),
        });
    });

    // ----- sheet / me calendar -----
    router.get('/sheet', async (req, res) => {
        const a = actorOf(req);
        if (!isAccounting(a)) return res.status(403).json({ success: false, error: 'forbidden' });
        const ym = String(req.query.month || calc.moscowYmd().slice(0, 7));
        const deptId = req.query.department_id ? Number(req.query.department_id) : null;
        const orgId = req.query.organization_id ? Number(req.query.organization_id) : null;
        const dim = calc.daysInMonthYm(ym);
        const from = `${ym}-01`;
        const to = `${ym}-${String(dim).padStart(2, '0')}`;

        let esql = `SELECT e.id, e.salary, e.department_id, u.full_name, d.name AS department_name
                    FROM ws_employee e JOIN users u ON u.id=e.user_id
                    JOIN ws_department d ON d.id=e.department_id WHERE 1=1`;
        const params = [];
        if (orgId) {
            esql += ' AND e.organization_id=?';
            params.push(orgId);
        }
        if (deptId) {
            esql += ' AND e.department_id=?';
            params.push(deptId);
        }
        esql += ' ORDER BY u.full_name';
        const [emps] = await db.query(esql, params);
        const ids = emps.map((e) => e.id);
        let logs = [];
        if (ids.length) {
            const [L] = await db.query(
                `SELECT employee_id, work_date, type, rate, hours_worked, status
                 FROM ws_work_log WHERE employee_id IN (?) AND work_date BETWEEN ? AND ?`,
                [ids, from, to]
            );
            logs = L;
        }
        const byEmp = {};
        for (const L of logs) {
            const key = L.employee_id;
            if (!byEmp[key]) byEmp[key] = {};
            const day = Number(String(L.work_date).slice(8, 10));
            byEmp[key][day] = {
                type: L.type,
                rate: Number(L.rate),
                hours: L.hours_worked != null ? Number(L.hours_worked) : null,
                status: L.status,
            };
        }
        let mandays = 0;
        let fot = 0;
        for (const e of emps) {
            let days = 0;
            const map = byEmp[e.id] || {};
            for (let d = 1; d <= dim; d++) {
                const c = map[d];
                if (!c) continue;
                if (c.type === 'work') days += Number(c.rate) || 0;
                else if (c.type === 'vacation' || c.type === 'sick') days += 1;
            }
            mandays += days;
            const norm = 21;
            fot += (Number(e.salary) || 0) * (days / norm);
        }
        res.json({
            success: true,
            month: ym,
            employees: emps,
            cells: byEmp,
            kpi: { mandays: Math.round(mandays * 10) / 10, fot: Math.round(fot), count: emps.length },
        });
    });

    router.patch('/sheet/cell', async (req, res) => {
        const a = actorOf(req);
        if (!isAccounting(a)) return res.status(403).json({ success: false, error: 'forbidden' });
        const b = req.body || {};
        const employeeId = Number(b.employee_id);
        const workDate = String(b.work_date || '');
        if (!employeeId || !/^\d{4}-\d{2}-\d{2}$/.test(workDate)) {
            return res.status(400).json({ success: false, error: 'bad params' });
        }
        const type = b.type || 'work';
        const rate = Number(b.rate) || 0;
        const hours = b.hours != null ? Number(b.hours) : null;
        const [ex] = await db.query(`SELECT * FROM ws_work_log WHERE employee_id=? AND work_date=? LIMIT 1`, [
            employeeId,
            workDate,
        ]);
        if (ex.length) {
            await db.query(
                `UPDATE ws_work_log SET type=?, rate=?, hours_worked=?, source='manual', edited_by=?, edited_at=?
                 WHERE id=?`,
                [type, rate, hours, a.id, calc.moscowNowSql(), ex[0].id]
            );
            await writeAudit(db, req, {
                entity_type: 'work_log',
                entity_id: String(ex[0].id),
                action: 'manual_edit',
                old_value: JSON.stringify({ type: ex[0].type, rate: ex[0].rate }),
                new_value: JSON.stringify({ type, rate, hours }),
            });
        } else {
            const [ins] = await db.query(
                `INSERT INTO ws_work_log
                 (employee_id, work_date, type, rate, hours_worked, source, status, edited_by, edited_at)
                 VALUES (?, ?, ?, ?, ?, 'manual', 'ok', ?, ?)`,
                [employeeId, workDate, type, rate, hours, a.id, calc.moscowNowSql()]
            );
            await writeAudit(db, req, {
                entity_type: 'work_log',
                entity_id: String(ins.insertId),
                action: 'manual_create',
                new_value: JSON.stringify({ type, rate, hours }),
            });
        }
        const payroll = await recalcPayroll(db, employeeId, calc.periodYmFromDate(workDate));
        res.json({ success: true, payroll });
    });

    router.get('/me/month', async (req, res) => {
        const a = actorOf(req);
        const emp = await getEmployeeByUserId(db, a.id);
        if (!emp) return res.status(403).json({ success: false, error: 'no employee card' });
        const ym = String(req.query.month || calc.moscowYmd().slice(0, 7));
        const dim = calc.daysInMonthYm(ym);
        const from = `${ym}-01`;
        const to = `${ym}-${String(dim).padStart(2, '0')}`;
        const [logs] = await db.query(
            `SELECT work_date, type, rate, hours_worked, status FROM ws_work_log
             WHERE employee_id=? AND work_date BETWEEN ? AND ?`,
            [emp.id, from, to]
        );
        const cells = {};
        for (const L of logs) {
            const day = Number(String(L.work_date).slice(8, 10));
            cells[day] = { type: L.type, rate: Number(L.rate), hours: L.hours_worked, status: L.status };
        }
        const payroll = await recalcPayroll(db, emp.id, ym);
        const [vacs] = await db.query(
            `SELECT * FROM ws_vacation_request WHERE employee_id=? ORDER BY date_from DESC LIMIT 50`,
            [emp.id]
        );
        res.json({ success: true, month: ym, cells, payroll, vacations: vacs, employee: { id: emp.id, name: emp.user_full_name } });
    });

    router.get('/dept/month', async (req, res) => {
        const a = actorOf(req);
        const emp = await getEmployeeByUserId(db, a.id);
        const accounting = isAccounting(a);
        if (!emp && !accounting) return res.status(403).json({ success: false, error: 'forbidden' });
        const deptId = req.query.department_id
            ? Number(req.query.department_id)
            : emp
              ? emp.department_id
              : null;
        if (!deptId) return res.status(400).json({ success: false, error: 'department_id required' });
        if (!accounting && emp && Number(emp.department_id) !== deptId && !isDeptHead(a, emp)) {
            return res.status(403).json({ success: false, error: 'forbidden' });
        }
        const ym = String(req.query.month || calc.moscowYmd().slice(0, 7));
        const dim = calc.daysInMonthYm(ym);
        const from = `${ym}-01`;
        const to = `${ym}-${String(dim).padStart(2, '0')}`;
        const [emps] = await db.query(
            `SELECT e.id, u.full_name FROM ws_employee e JOIN users u ON u.id=e.user_id
             WHERE e.department_id=? ORDER BY u.full_name`,
            [deptId]
        );
        const ids = emps.map((e) => e.id);
        let byEmp = {};
        if (ids.length) {
            const [logs] = await db.query(
                `SELECT employee_id, work_date, type, rate, hours_worked FROM ws_work_log
                 WHERE employee_id IN (?) AND work_date BETWEEN ? AND ?`,
                [ids, from, to]
            );
            for (const L of logs) {
                if (!byEmp[L.employee_id]) byEmp[L.employee_id] = {};
                const day = Number(String(L.work_date).slice(8, 10));
                byEmp[L.employee_id][day] = { type: L.type, rate: Number(L.rate), hours: L.hours_worked };
            }
        }
        const [vacs] = await db.query(
            `SELECT v.*, u.full_name FROM ws_vacation_request v
             JOIN ws_employee e ON e.id=v.employee_id
             JOIN users u ON u.id=e.user_id
             WHERE e.department_id=? AND v.status IN ('pending','approved')
               AND v.date_to >= ? AND v.date_from <= ?`,
            [deptId, from, to]
        );
        res.json({ success: true, month: ym, department_id: deptId, employees: emps, cells: byEmp, vacations: vacs });
    });

    // ----- vacations -----
    async function vacationOverlapCount(db, departmentId, dateFrom, dateTo, excludeId) {
        const [rows] = await db.query(
            `SELECT COUNT(*) AS c FROM ws_vacation_request v
             JOIN ws_employee e ON e.id=v.employee_id
             WHERE e.department_id=? AND v.status IN ('pending','approved')
               AND v.date_from <= ? AND v.date_to >= ?
               AND (? IS NULL OR v.id <> ?)`,
            [departmentId, dateTo, dateFrom, excludeId, excludeId]
        );
        return Number(rows[0].c) || 0;
    }

    router.post('/vacations', async (req, res) => {
        const a = actorOf(req);
        const emp = await getEmployeeByUserId(db, a.id);
        if (!emp) return res.status(403).json({ success: false, error: 'no employee card' });
        const b = req.body || {};
        const dateFrom = String(b.date_from || '');
        const dateTo = String(b.date_to || '');
        if (!/^\d{4}-\d{2}-\d{2}$/.test(dateFrom) || !/^\d{4}-\d{2}-\d{2}$/.test(dateTo) || dateTo < dateFrom) {
            return res.status(400).json({ success: false, error: 'bad dates' });
        }
        const days =
            Math.round((new Date(dateTo) - new Date(dateFrom)) / 86400000) + 1;
        if (emp.hire_date) {
            const months = calc.seniorityMonths(emp.hire_date, dateFrom);
            if (months < 6) {
                return res.status(400).json({ success: false, error: 'vacation after 6 months only' });
            }
        }
        const limit = Number(emp.vacation_overlap_limit) || 1;
        const overlap = await vacationOverlapCount(db, emp.department_id, dateFrom, dateTo, null);
        if (overlap >= limit) {
            return res.status(409).json({ success: false, error: 'vacation overlap in department' });
        }
        const [r] = await db.query(
            `INSERT INTO ws_vacation_request (employee_id, date_from, date_to, days_count, type, status)
             VALUES (?, ?, ?, ?, ?, 'pending')`,
            [emp.id, dateFrom, dateTo, days, b.type || 'annual']
        );
        await writeAudit(db, req, { entity_type: 'vacation', entity_id: r.insertId, action: 'create' });
        res.json({ success: true, id: r.insertId, days_count: days });
    });

    router.get('/vacations/pending', async (req, res) => {
        const a = actorOf(req);
        const accounting = isAccounting(a);
        const emp = await getEmployeeByUserId(db, a.id);
        if (!accounting && !(emp && isDeptHead(a, emp))) {
            return res.status(403).json({ success: false, error: 'forbidden' });
        }
        let sql = `SELECT v.*, u.full_name, e.department_id FROM ws_vacation_request v
                   JOIN ws_employee e ON e.id=v.employee_id
                   JOIN users u ON u.id=e.user_id WHERE v.status='pending'`;
        const params = [];
        if (!accounting && emp) {
            sql += ' AND e.department_id=?';
            params.push(emp.department_id);
        }
        sql += ' ORDER BY v.date_from';
        const [rows] = await db.query(sql, params);
        res.json({ success: true, rows });
    });

    router.post('/vacations/:id/approve', async (req, res) => {
        const a = actorOf(req);
        const id = Number(req.params.id);
        const [rows] = await db.query(
            `SELECT v.*, e.department_id, d.head_user_id FROM ws_vacation_request v
             JOIN ws_employee e ON e.id=v.employee_id
             JOIN ws_department d ON d.id=e.department_id WHERE v.id=?`,
            [id]
        );
        if (!rows.length) return res.status(404).json({ success: false, error: 'not found' });
        const v = rows[0];
        if (!isAccounting(a) && !isDeptHead(a, v)) {
            return res.status(403).json({ success: false, error: 'forbidden' });
        }
        const ok = !(req.body && req.body.reject);
        await db.query(
            `UPDATE ws_vacation_request SET status=?, approver_id=?, approved_at=?, reject_reason=? WHERE id=?`,
            [
                ok ? 'approved' : 'rejected',
                a.id,
                calc.moscowNowSql(),
                ok ? null : String((req.body && req.body.reason) || 'отклонено'),
                id,
            ]
        );
        if (ok) {
            // mark days in work_log as vacation
            const cur = new Date(v.date_from);
            const end = new Date(v.date_to);
            while (cur <= end) {
                const ymd = cur.toISOString().slice(0, 10);
                await db.query(
                    `INSERT INTO ws_work_log (employee_id, work_date, type, rate, source, status)
                     VALUES (?, ?, 'vacation', 1, 'vacation', 'ok')
                     ON DUPLICATE KEY UPDATE type='vacation', rate=1, source='vacation'`,
                    [v.employee_id, ymd]
                );
                cur.setDate(cur.getDate() + 1);
            }
            await recalcPayroll(db, v.employee_id, calc.periodYmFromDate(v.date_from));
        }
        await writeAudit(db, req, {
            entity_type: 'vacation',
            entity_id: id,
            action: ok ? 'approve' : 'reject',
        });
        res.json({ success: true, status: ok ? 'approved' : 'rejected' });
    });

    // ----- sick / absence / compensation -----
    router.post('/sick', async (req, res) => {
        if (!isAccounting(actorOf(req))) return res.status(403).json({ success: false, error: 'forbidden' });
        const b = req.body || {};
        const emp = await getEmployeeById(db, Number(b.employee_id));
        if (!emp) return res.status(404).json({ success: false, error: 'employee not found' });
        let amount = Number(b.amount) || 0;
        if (!b.official) {
            const rate = calc.resolveSickRate(emp, emp);
            const days =
                Math.round((new Date(b.date_to) - new Date(b.date_from)) / 86400000) + 1;
            amount = Math.round(rate * days * 100) / 100;
        }
        const [r] = await db.query(
            `INSERT INTO ws_sick_leave
             (employee_id, date_from, date_to, official, document_number, document_file, amount)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [
                emp.id,
                b.date_from,
                b.date_to,
                b.official ? 1 : 0,
                b.document_number || null,
                b.document_file || null,
                amount,
            ]
        );
        const cur = new Date(b.date_from);
        const end = new Date(b.date_to);
        while (cur <= end) {
            const ymd = cur.toISOString().slice(0, 10);
            await db.query(
                `INSERT INTO ws_work_log (employee_id, work_date, type, rate, source, status)
                 VALUES (?, ?, 'sick', 1, 'sick', 'ok')
                 ON DUPLICATE KEY UPDATE type='sick', rate=1, source='sick'`,
                [emp.id, ymd]
            );
            cur.setDate(cur.getDate() + 1);
        }
        await recalcPayroll(db, emp.id, calc.periodYmFromDate(b.date_from));
        await writeAudit(db, req, { entity_type: 'sick', entity_id: r.insertId, action: 'create' });
        res.json({ success: true, id: r.insertId, amount });
    });

    router.post('/absences', async (req, res) => {
        if (!isAccounting(actorOf(req))) return res.status(403).json({ success: false, error: 'forbidden' });
        const b = req.body || {};
        const [r] = await db.query(
            `INSERT INTO ws_absence (employee_id, type, date_from, date_to, paid, amount, comment)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [
                Number(b.employee_id),
                b.type || 'unpaid',
                b.date_from,
                b.date_to,
                b.paid ? 1 : 0,
                Number(b.amount) || 0,
                b.comment || null,
            ]
        );
        await recalcPayroll(db, Number(b.employee_id), calc.periodYmFromDate(b.date_from));
        await writeAudit(db, req, { entity_type: 'absence', entity_id: r.insertId, action: 'create' });
        res.json({ success: true, id: r.insertId });
    });

    router.post('/vacation-compensation', async (req, res) => {
        if (!isAccounting(actorOf(req))) return res.status(403).json({ success: false, error: 'forbidden' });
        const b = req.body || {};
        const a = actorOf(req);
        const [r] = await db.query(
            `INSERT INTO ws_vacation_compensation (employee_id, days, amount, reason, approved_by, paid_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [
                Number(b.employee_id),
                Number(b.days) || 0,
                Number(b.amount) || 0,
                b.reason || 'application',
                a.id,
                b.paid_at || calc.moscowYmd(),
            ]
        );
        await recalcPayroll(db, Number(b.employee_id), calc.periodYmFromDate(b.paid_at || calc.moscowYmd()));
        await writeAudit(db, req, { entity_type: 'vacation_compensation', entity_id: r.insertId, action: 'create' });
        res.json({ success: true, id: r.insertId });
    });

    // ----- payroll -----
    router.get('/payroll', async (req, res) => {
        const a = actorOf(req);
        const ym = String(req.query.month || calc.moscowYmd().slice(0, 7));
        const empId = req.query.employee_id ? Number(req.query.employee_id) : null;
        if (empId) {
            if (!isAccounting(a)) {
                const me = await getEmployeeByUserId(db, a.id);
                if (!me || me.id !== empId) return res.status(403).json({ success: false, error: 'forbidden' });
            }
            const row = await recalcPayroll(db, empId, ym);
            return res.json({ success: true, row });
        }
        if (!isAccounting(a)) {
            const me = await getEmployeeByUserId(db, a.id);
            if (!me) return res.status(403).json({ success: false, error: 'forbidden' });
            const row = await recalcPayroll(db, me.id, ym);
            return res.json({ success: true, row });
        }
        const [emps] = await db.query('SELECT id FROM ws_employee');
        const rows = [];
        for (const e of emps) rows.push(await recalcPayroll(db, e.id, ym));
        res.json({ success: true, rows });
    });

    router.post('/payroll/dry-run', async (req, res) => {
        if (!isAccounting(actorOf(req))) return res.status(403).json({ success: false, error: 'forbidden' });
        const ym = String((req.body && req.body.month) || calc.moscowYmd().slice(0, 7));
        const empId = req.body && req.body.employee_id ? Number(req.body.employee_id) : null;
        const preview = empId
            ? [await recalcPayroll(db, empId, ym)]
            : await (async () => {
                  const [emps] = await db.query('SELECT id FROM ws_employee');
                  const out = [];
                  for (const e of emps) out.push(await recalcPayroll(db, e.id, ym));
                  return out;
              })();
        res.json({ success: true, dry_run: true, rows: preview });
    });

    router.post('/payroll/apply', async (req, res) => {
        if (!isAccounting(actorOf(req))) return res.status(403).json({ success: false, error: 'forbidden' });
        const ym = String((req.body && req.body.month) || calc.moscowYmd().slice(0, 7));
        const [emps] = await db.query('SELECT id FROM ws_employee');
        const rows = [];
        for (const e of emps) rows.push(await recalcPayroll(db, e.id, ym));
        await writeAudit(db, req, {
            entity_type: 'payroll',
            entity_id: ym,
            action: 'apply',
            new_value: String(rows.length),
        });
        res.json({ success: true, rows });
    });

    // ----- calendar RF -----
    router.get('/calendar', async (req, res) => {
        const year = Number(req.query.year) || new Date().getFullYear();
        const [rows] = await db.query(
            `SELECT * FROM ws_work_calendar WHERE YEAR(cal_date)=? ORDER BY cal_date`,
            [year]
        );
        res.json({ success: true, year, rows });
    });

    router.post('/calendar/import', async (req, res) => {
        if (!isAccounting(actorOf(req))) return res.status(403).json({ success: false, error: 'forbidden' });
        const days = Array.isArray(req.body && req.body.days) ? req.body.days : [];
        let n = 0;
        for (const d of days) {
            if (!d || !d.cal_date) continue;
            await db.query(
                `INSERT INTO ws_work_calendar (cal_date, is_working_day, norm_hours, holiday_name, transfer_note)
                 VALUES (?, ?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE is_working_day=VALUES(is_working_day), norm_hours=VALUES(norm_hours),
                   holiday_name=VALUES(holiday_name), transfer_note=VALUES(transfer_note)`,
                [
                    d.cal_date,
                    d.is_working_day ? 1 : 0,
                    Number(d.norm_hours) || 8,
                    d.holiday_name || null,
                    d.transfer_note || null,
                ]
            );
            n += 1;
        }
        await writeAudit(db, req, { entity_type: 'calendar', entity_id: 'import', action: 'import', new_value: String(n) });
        res.json({ success: true, imported: n });
    });

    // ----- audit -----
    router.get('/audit', async (req, res) => {
        if (!isAccounting(actorOf(req))) return res.status(403).json({ success: false, error: 'forbidden' });
        const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
        const params = [];
        let sql = `SELECT a.*, u.full_name, u.username FROM ws_audit_log a
                   LEFT JOIN users u ON u.id=a.user_id WHERE 1=1`;
        if (req.query.entity_type) {
            sql += ' AND a.entity_type=?';
            params.push(req.query.entity_type);
        }
        if (req.query.user_id) {
            sql += ' AND a.user_id=?';
            params.push(Number(req.query.user_id));
        }
        sql += ' ORDER BY a.id DESC LIMIT ?';
        params.push(limit);
        const [rows] = await db.query(sql, params);
        res.json({ success: true, rows });
    });

    // ----- export 1C -----
    router.get('/export/1c', async (req, res) => {
        if (!isAccounting(actorOf(req))) return res.status(403).json({ success: false, error: 'forbidden' });
        const ym = String(req.query.month || calc.moscowYmd().slice(0, 7));
        const format = String(req.query.format || 'csv').toLowerCase();
        const [emps] = await db.query(
            `SELECT e.id, u.full_name, m.external_code, m.department_code
             FROM ws_employee e JOIN users u ON u.id=e.user_id
             LEFT JOIN ws_1c_employee_map m ON m.employee_id=e.id`
        );
        const rows = [];
        for (const e of emps) {
            const p = await recalcPayroll(db, e.id, ym);
            rows.push({
                employee: e.full_name,
                external_code: e.external_code || '',
                department_code: e.department_code || '',
                period: ym,
                ...p,
            });
        }
        await writeAudit(db, req, {
            entity_type: 'export',
            entity_id: ym,
            action: '1c_' + format,
            new_value: String(rows.length),
        });
        if (format === 'xml') {
            let xml = '<?xml version="1.0" encoding="UTF-8"?><payroll period="' + ym + '">';
            for (const r of rows) {
                xml += `<row employee="${escXml(r.employee)}" code="${escXml(r.external_code)}" total="${r.total}" base="${r.base_salary}" seniority="${r.seniority_bonus}" sick="${r.sick_pay}" vacation_comp="${r.vacation_compensation}"/>`;
            }
            xml += '</payroll>';
            res.setHeader('Content-Type', 'application/xml; charset=utf-8');
            res.setHeader('Content-Disposition', `attachment; filename="payroll-${ym}.xml"`);
            return res.send(xml);
        }
        const header =
            'employee;external_code;department_code;period;base_salary;premium;seniority_bonus;sick_pay;vacation_pay;vacation_compensation;total\n';
        const body = rows
            .map(
                (r) =>
                    `${csv(r.employee)};${csv(r.external_code)};${csv(r.department_code)};${r.period};${r.base_salary};${r.premium};${r.seniority_bonus};${r.sick_pay};${r.vacation_pay};${r.vacation_compensation};${r.total}`
            )
            .join('\n');
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="payroll-${ym}.csv"`);
        res.send('\uFEFF' + header + body);
    });

    // ----- import timesheet CSV -----
    router.post('/import/timesheet-csv', async (req, res) => {
        if (!isAccounting(actorOf(req))) return res.status(403).json({ success: false, error: 'forbidden' });
        const dry = !!(req.body && (req.body.dry_run === true || req.body.dry_run === 1 || req.body.dry_run === '1'));
        const text = String((req.body && req.body.csv) || '');
        const lines = text.split(/\r?\n/).filter((l) => l.trim());
        if (lines.length < 2) return res.status(400).json({ success: false, error: 'empty csv' });
        let applied = 0;
        const errors = [];
        for (let i = 1; i < lines.length; i++) {
            const parts = lines[i].split(/[;,]/).map((s) => s.trim());
            // employee_id;work_date;type;rate;hours
            const employeeId = Number(parts[0]);
            const workDate = parts[1];
            const type = parts[2] || 'work';
            const rate = Number(parts[3]) || 0;
            const hours = parts[4] != null && parts[4] !== '' ? Number(parts[4]) : null;
            if (!employeeId || !/^\d{4}-\d{2}-\d{2}$/.test(workDate)) {
                errors.push({ line: i + 1, error: 'bad row' });
                continue;
            }
            if (!dry) {
                await db.query(
                    `INSERT INTO ws_work_log (employee_id, work_date, type, rate, hours_worked, source, status)
                     VALUES (?, ?, ?, ?, ?, 'import', 'ok')
                     ON DUPLICATE KEY UPDATE type=VALUES(type), rate=VALUES(rate), hours_worked=VALUES(hours_worked), source='import'`,
                    [employeeId, workDate, type, rate, hours]
                );
                applied += 1;
            } else applied += 1;
        }
        if (!dry) {
            await writeAudit(db, req, {
                entity_type: 'import',
                entity_id: 'timesheet',
                action: 'csv',
                new_value: String(applied),
            });
        }
        res.json({ success: true, dry_run: dry, applied, errors: errors.slice(0, 20) });
    });

    // 1c map
    router.get('/1c-map', async (req, res) => {
        if (!isAccounting(actorOf(req))) return res.status(403).json({ success: false, error: 'forbidden' });
        const [rows] = await db.query(
            `SELECT m.*, u.full_name FROM ws_1c_employee_map m
             JOIN ws_employee e ON e.id=m.employee_id
             JOIN users u ON u.id=e.user_id`
        );
        res.json({ success: true, rows });
    });

    router.put('/1c-map/:employeeId', async (req, res) => {
        if (!isAccounting(actorOf(req))) return res.status(403).json({ success: false, error: 'forbidden' });
        const employeeId = Number(req.params.employeeId);
        const b = req.body || {};
        await db.query(
            `INSERT INTO ws_1c_employee_map (employee_id, external_code, department_code)
             VALUES (?, ?, ?)
             ON DUPLICATE KEY UPDATE external_code=VALUES(external_code), department_code=VALUES(department_code)`,
            [employeeId, String(b.external_code || ''), b.department_code || null]
        );
        res.json({ success: true });
    });

    return router;
}

function csv(s) {
    const t = String(s == null ? '' : s);
    if (/[;"\n]/.test(t)) return '"' + t.replace(/"/g, '""') + '"';
    return t;
}

function escXml(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/"/g, '&quot;');
}

/** Auto-close stuck shifts (called from server tick). */
async function processStuckShifts(db) {
    await ensureSchema(db);
    const [rows] = await db.query(
        `SELECT w.*, e.id AS emp_id, d.norm_hours, d.rate_full_hours, d.rate_half_hours,
                o.clock_auto_close_hours, e.personal_work_hours_per_day,
                e.personal_rate_full_hours, e.personal_rate_half_hours
         FROM ws_work_log w
         JOIN ws_employee e ON e.id=w.employee_id
         JOIN ws_department d ON d.id=e.department_id
         JOIN ws_organization o ON o.id=e.organization_id
         WHERE w.check_in IS NOT NULL AND w.check_out IS NULL`
    );
    const now = Date.now();
    let closed = 0;
    for (const r of rows) {
        const openH = (now - new Date(r.check_in).getTime()) / 3600000;
        const limit = Number(r.clock_auto_close_hours) || 14;
        if (openH < limit) continue;
        const thr = calc.resolveEmployeeThresholds(r, r);
        const hours = calc.roundHoursTo5Min(openH);
        const rate = calc.rateFromHours(hours, thr);
        await db.query(
            `UPDATE ws_work_log SET check_out=?, hours_worked=?, rate=?, status='needs_confirm',
             check_out_device='auto', comment=CONCAT(IFNULL(comment,''),' auto-close')
             WHERE id=?`,
            [calc.moscowNowSql(), hours, rate, r.id]
        );
        await recalcPayroll(db, r.employee_id, calc.periodYmFromDate(r.work_date));
        closed += 1;
    }
    return { closed };
}

module.exports = createWorkScheduleRouter;
module.exports.processStuckShifts = processStuckShifts;
module.exports.ensureWorkScheduleSchema = ensureWorkScheduleSchema;
