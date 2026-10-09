'use strict';

const express = require('express');
const {
    ensureWorkScheduleSchema,
    importDepartmentsFromSpecialties,
} = require('../lib/datagonWorkScheduleSchema');
const calc = require('../lib/datagonWorkScheduleCalc');
const {
    fetchManagerBonusesForMonth,
    isSalesDepartmentName,
} = require('../lib/managerSalesMonthBonus');
const bitcop = require('../lib/datagonBitcopClient');
const rfCalendar = require('../lib/datagonWorkCalendarRf');

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

/** DATE → 'YYYY-MM-DD' без сдвига TZ при JSON (mysql DATE → JS Date → ISO −1 день). */
function dateOnlyYmd(v) {
    if (v == null || v === '') return null;
    if (typeof v === 'string') {
        const m = v.trim().match(/^(\d{4}-\d{2}-\d{2})/);
        if (m) return m[1];
    }
    if (v instanceof Date && Number.isFinite(v.getTime())) {
        // mysql2 DATE обычно как UTC 00:00; локальные геттеры в +TZ дают −1 день в ISO.
        const y = v.getUTCFullYear();
        const m = v.getUTCMonth() + 1;
        const d = v.getUTCDate();
        return `${y}-${m < 10 ? `0${m}` : m}-${d < 10 ? `0${d}` : d}`;
    }
    const s = String(v).trim();
    const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
    if (m) return m[1];
    return null;
}

function mapEmployeeRow(row) {
    if (!row) return row;
    return {
        ...row,
        hire_date: dateOnlyYmd(row.hire_date),
        fire_date: dateOnlyYmd(row.fire_date),
    };
}

function mapVacationRow(row) {
    if (!row) return row;
    return {
        ...row,
        date_from: dateOnlyYmd(row.date_from),
        date_to: dateOnlyYmd(row.date_to),
    };
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
                d.premium_rule_json AS dept_premium_rule_json,
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
                d.vacation_overlap_limit, d.head_user_id, d.premium_rule_json AS dept_premium_rule_json,
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

/**
 * body.premium_rule_json / personal_premium_rule_json → JSON-строка или null.
 * allowInherit: пусто / { inherit: true } → null (брать из отдела).
 */
function normalizePremiumRuleBody(raw, { allowInherit }) {
    if (raw == null || raw === '') {
        return allowInherit ? null : JSON.stringify({ kind: 'stub' });
    }
    if (typeof raw === 'object' && (raw.inherit === true || raw.kind === '' || raw.kind == null)) {
        return allowInherit ? null : JSON.stringify({ kind: 'stub' });
    }
    const parsed = calc.parsePremiumRule(raw);
    if (parsed.kind === 'fixed' || parsed.kind === 'fixed_full') {
        return JSON.stringify({ kind: parsed.kind, amount: parsed.amount });
    }
    return JSON.stringify({ kind: 'stub' });
}

function isDeptHead(actor, empOrDept) {
    const headId = empOrDept.head_user_id != null ? empOrDept.head_user_id : empOrDept;
    return Number(actor.id) === Number(headId);
}

async function getHeadedDepartmentIds(db, userId) {
    if (!userId) return [];
    const [rows] = await db.query(`SELECT id FROM ws_department WHERE head_user_id=? ORDER BY name`, [userId]);
    return (rows || []).map((r) => Number(r.id));
}

/** Скоупы «отдел-руководитель → управляемые отделы» (просмотр/правки вкладки «Отдел»). */
async function loadManageScopesByManager(db, managerDeptIds) {
    const ids = (managerDeptIds || []).map(Number).filter(Boolean);
    if (!ids.length) return new Map();
    const [rows] = await db.query(
        `SELECT s.manager_department_id, s.target_department_id, s.can_edit,
                d.name AS target_name, d.schedule_type, d.head_user_id
         FROM ws_department_manage_scope s
         JOIN ws_department d ON d.id = s.target_department_id
         WHERE s.manager_department_id IN (?)
         ORDER BY d.name`,
        [ids]
    );
    const map = new Map();
    for (const r of rows || []) {
        const mid = Number(r.manager_department_id);
        if (!map.has(mid)) map.set(mid, []);
        map.get(mid).push({
            department_id: Number(r.target_department_id),
            name: r.target_name,
            schedule_type: r.schedule_type,
            head_user_id: r.head_user_id,
            can_edit: !!Number(r.can_edit),
        });
    }
    return map;
}

async function replaceManageScopes(db, managerDeptId, scopes) {
    const mid = Number(managerDeptId);
    if (!mid) return;
    await db.query(`DELETE FROM ws_department_manage_scope WHERE manager_department_id=?`, [mid]);
    const list = Array.isArray(scopes) ? scopes : [];
    for (const s of list) {
        const tid = Number(s && (s.department_id != null ? s.department_id : s.target_department_id != null ? s.target_department_id : s.id));
        if (!tid || tid === mid) continue;
        const canEdit = !(s.can_edit === false || s.can_edit === 0 || s.can_edit === '0');
        await db.query(
            `INSERT INTO ws_department_manage_scope
             (manager_department_id, target_department_id, can_edit)
             VALUES (?, ?, ?)`,
            [mid, tid, canEdit ? 1 : 0]
        );
    }
}

async function getManageAccess(db, managerDeptId, targetDeptId) {
    const mid = Number(managerDeptId);
    const tid = Number(targetDeptId);
    if (!mid || !tid) return null;
    const [rows] = await db.query(
        `SELECT can_edit FROM ws_department_manage_scope
         WHERE manager_department_id=? AND target_department_id=? LIMIT 1`,
        [mid, tid]
    );
    if (!rows[0]) return null;
    return { can_view: true, can_edit: !!Number(rows[0].can_edit) };
}

async function listVisibleDepartments(db, actor) {
    if (isAccounting(actor)) {
        const [rows] = await db.query(
            `SELECT d.*, u.full_name AS head_name
             FROM ws_department d
             LEFT JOIN users u ON u.id = d.head_user_id
             ORDER BY d.name`
        );
        const scopeMap = await loadManageScopesByManager(
            db,
            (rows || []).map((r) => Number(r.id))
        );
        return (rows || []).map((d) => ({
            ...d,
            manage_scopes: scopeMap.get(Number(d.id)) || [],
            can_edit: true,
            is_own: false,
            is_headed: Number(d.head_user_id) === Number(actor.id),
            via_manage: false,
        }));
    }
    const emp = actor.id ? await getEmployeeByUserId(db, actor.id) : null;
    if (!emp) return [];
    const ownId = Number(emp.department_id);
    const headedIds = await getHeadedDepartmentIds(db, actor.id);
    const scopeMap = await loadManageScopesByManager(db, [ownId]);
    const managed = scopeMap.get(ownId) || [];
    const managedEdit = new Map(managed.map((m) => [Number(m.department_id), !!m.can_edit]));
    const idSet = new Set([ownId, ...headedIds, ...managed.map((m) => Number(m.department_id))]);
    const ids = [...idSet].filter(Boolean);
    if (!ids.length) return [];
    const [rows] = await db.query(
        `SELECT d.id, d.name, d.schedule_type, d.head_user_id, u.full_name AS head_name
         FROM ws_department d
         LEFT JOIN users u ON u.id = d.head_user_id
         WHERE d.id IN (?)
         ORDER BY d.name`,
        [ids]
    );
    return (rows || []).map((d) => {
        const id = Number(d.id);
        const isHeaded = Number(d.head_user_id) === Number(actor.id);
        const viaManage = managedEdit.has(id);
        return {
            ...d,
            can_edit: isHeaded || (viaManage && managedEdit.get(id)),
            is_own: id === ownId,
            is_headed: isHeaded,
            via_manage: viaManage && !isHeaded,
        };
    });
}

async function canAccessDepartment(db, actor, departmentId) {
    if (isAccounting(actor)) return true;
    const deptId = Number(departmentId);
    if (!deptId) return false;
    const emp = await getEmployeeByUserId(db, actor.id);
    if (!emp) return false;
    if (Number(emp.department_id) === deptId) return true;
    const [rows] = await db.query(`SELECT head_user_id FROM ws_department WHERE id=? LIMIT 1`, [deptId]);
    if (rows[0] && Number(rows[0].head_user_id) === Number(actor.id)) return true;
    const scope = await getManageAccess(db, emp.department_id, deptId);
    return !!(scope && scope.can_view);
}

async function canEditEmployeeTimesheet(db, actor, employeeId) {
    if (isAccounting(actor)) return true;
    const emp = await getEmployeeById(db, employeeId);
    if (!emp) return false;
    if (Number(emp.head_user_id) === Number(actor.id)) return true;
    const actorEmp = await getEmployeeByUserId(db, actor.id);
    if (!actorEmp) return false;
    const scope = await getManageAccess(db, actorEmp.department_id, emp.department_id);
    return !!(scope && scope.can_edit);
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
    const base = calc.prorateByWorkedDays(salary, worked, normDays);
    const senDisabled = Number(emp.seniority_pay_disabled) === 1;
    const senParams = calc.resolveSeniorityParams(emp, emp);
    const seniorityFull = senDisabled
        ? 0
        : calc.seniorityBonus(emp.hire_date, `${periodYm}-28`, senParams);
    const seniority = calc.prorateByWorkedDays(seniorityFull, worked, normDays);
    const premiumRule = calc.resolvePremiumRule(emp, emp);
    const premiumFromRule = calc.computePremium(premiumRule, { workedDays: worked, normDays });
    const [prevPay] = await db.query(
        `SELECT premium_manual, premium_source FROM ws_payroll_entry WHERE employee_id=? AND period_ym=? LIMIT 1`,
        [employeeId, periodYm]
    );
    const premiumManual =
        prevPay[0] && prevPay[0].premium_manual != null && prevPay[0].premium_manual !== ''
            ? Number(prevPay[0].premium_manual)
            : null;
    const premiumSource =
        prevPay[0] && prevPay[0].premium_source != null && String(prevPay[0].premium_source).trim()
            ? String(prevPay[0].premium_source).trim()
            : null;
    const premium =
        premiumManual != null && Number.isFinite(premiumManual)
            ? Math.round(premiumManual * 100) / 100
            : premiumFromRule;
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
        /** Полный месячный оклад (ставка в карточке), не пропорциональный. */
        salary_rate: salary,
        /** Накапало по отработанным ставкам: salary × worked/norm. */
        base_salary: base,
        premium,
        premium_from_rule: premiumFromRule,
        premium_manual: premiumManual,
        premium_source: premiumSource,
        /** Полная доплата за стаж за месяц (до пропорции). */
        seniority_full: seniorityFull,
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

/**
 * Подтянуть премии из журнала менеджеров в premium_manual для отделов «…продаж…».
 * mode:
 *   - 'auto' — только если premium_source != 'manual' и (нет manual или source=sales);
 *   - 'force' — перезаписать всех (кнопка «Обновить»), в т.ч. ручные.
 * dryRun — без записи.
 */
async function syncSalesPremiums(db, req, opts) {
    const periodYm = String(opts.periodYm || '');
    const dryRun = !!opts.dryRun;
    const mode = opts.mode === 'force' ? 'force' : 'auto';
    const orgId = opts.orgId ? Number(opts.orgId) : null;
    const deptId = opts.deptId ? Number(opts.deptId) : null;
    const t0 = Date.now();
    const year = Number(periodYm.slice(0, 4));
    const month = Number(periodYm.slice(5, 7));

    let esql = `SELECT e.id, e.user_id, u.full_name, d.id AS department_id, d.name AS department_name
                FROM ws_employee e
                JOIN users u ON u.id=e.user_id
                JOIN ws_department d ON d.id=e.department_id
                WHERE 1=1`;
    const params = [];
    if (orgId) {
        esql += ' AND e.organization_id=?';
        params.push(orgId);
    }
    if (deptId) {
        esql += ' AND e.department_id=?';
        params.push(deptId);
    }
    const [empsAll] = await db.query(esql, params);
    const salesEmps = (empsAll || []).filter((e) => isSalesDepartmentName(e.department_name));
    if (!salesEmps.length) {
        return {
            success: true,
            dry_run: dryRun,
            mode,
            period_ym: periodYm,
            total: 0,
            updated: 0,
            skipped: 0,
            no_sales: 0,
            rows: [],
            duration_sec: Math.round((Date.now() - t0) / 1000),
            message: 'Нет сотрудников в отделах с «продаж» в названии',
        };
    }

    const bonuses = await fetchManagerBonusesForMonth(db, year, month);
    const ids = salesEmps.map((e) => e.id);
    const [prevRows] = await db.query(
        `SELECT employee_id, premium_manual, premium_source FROM ws_payroll_entry
         WHERE period_ym=? AND employee_id IN (?)`,
        [periodYm, ids]
    );
    const prevMap = {};
    for (const p of prevRows || []) {
        prevMap[p.employee_id] = {
            premium_manual: p.premium_manual,
            premium_source: p.premium_source != null ? String(p.premium_source).trim() : null,
        };
    }

    const rows = [];
    let updated = 0;
    let skipped = 0;
    let noSales = 0;
    for (const e of salesEmps) {
        const bInfo = bonuses.get(Number(e.user_id));
        const next = bInfo ? Number(bInfo.bonus) || 0 : 0;
        if (!bInfo) noSales += 1;
        const prevRow = prevMap[e.id] || {};
        const prev =
            prevRow.premium_manual != null && prevRow.premium_manual !== ''
                ? Number(prevRow.premium_manual)
                : null;
        const src = prevRow.premium_source || null;
        const same = prev != null && Math.abs(prev - next) < 0.005 && src === 'sales';
        const isManual = src === 'manual';
        // auto: не трогаем ручные и legacy (есть сумма без source=sales)
        const blockedAuto = mode === 'auto' && (isManual || (prev != null && src !== 'sales'));
        // auto: не писать «0» всем без продаж — иначе журнал забит пустыми автопремиями
        const noopZeroAuto = mode === 'auto' && next === 0 && (prev == null || prev === 0);
        const changed = !same && !blockedAuto && !noopZeroAuto;
        rows.push({
            employee_id: e.id,
            user_id: e.user_id,
            full_name: e.full_name,
            department_name: e.department_name,
            bonus: next,
            pct_mp: bInfo ? bInfo.pct_mp : null,
            amount_ex: bInfo ? bInfo.amount_ex : 0,
            previous_manual: prev,
            previous_source: src,
            changed,
            skipped_manual: !!blockedAuto,
        });
        if (!changed) {
            skipped += 1;
            continue;
        }
        if (dryRun) {
            updated += 1;
            continue;
        }
        // eslint-disable-next-line no-await-in-loop
        await db.query(
            `INSERT INTO ws_payroll_entry
             (employee_id, period_ym, base_salary, premium, premium_manual, premium_source, seniority_bonus,
              vacation_pay, sick_pay, dayoff_pay, business_trip_pay, vacation_compensation, total,
              worked_days, norm_days, calculated_at)
             VALUES (?, ?, 0, ?, ?, 'sales', 0, 0, 0, 0, 0, 0, ?, 0, 0, ?)
             ON DUPLICATE KEY UPDATE
               premium_manual=VALUES(premium_manual),
               premium_source='sales'`,
            [e.id, periodYm, next, next, next, calc.moscowNowSql()]
        );
        if (req && mode === 'force') {
            // построчный аудит только при ручном «Обновить из продаж»; auto — одна сводка ниже
            // eslint-disable-next-line no-await-in-loop
            await writeAudit(db, req, {
                entity_type: 'payroll',
                entity_id: `${e.id}:${periodYm}`,
                action: 'premium_from_sales',
                field_name: 'premium_manual',
                old_value: prev != null ? String(prev) : null,
                new_value: JSON.stringify({
                    amount: next,
                    employee: e.full_name,
                    department: e.department_name,
                    period_ym: periodYm,
                }),
            });
        }
        // eslint-disable-next-line no-await-in-loop
        await recalcPayroll(db, e.id, periodYm);
        updated += 1;
    }

    if (!dryRun && req && updated > 0) {
        const changedRows = rows.filter((r) => r.changed).slice(0, 30);
        await writeAudit(db, req, {
            entity_type: 'payroll',
            entity_id: periodYm,
            action: mode === 'auto' ? 'premium_from_sales_auto' : 'premium_from_sales_batch',
            field_name: 'premium_manual',
            new_value: JSON.stringify({
                updated,
                skipped,
                no_sales: noSales,
                total: salesEmps.length,
                period_ym: periodYm,
                people: changedRows.map((r) => ({
                    name: r.full_name,
                    amount: r.bonus,
                    was: r.previous_manual,
                })),
            }),
        });
    }

    return {
        success: true,
        dry_run: dryRun,
        mode,
        period_ym: periodYm,
        total: salesEmps.length,
        updated,
        skipped,
        no_sales: noSales,
        rows: rows.sort((a, b) => String(a.full_name).localeCompare(String(b.full_name), 'ru')),
        duration_sec: Math.round((Date.now() - t0) / 1000),
        message: dryRun
            ? `Пробный прогон: к записи ${updated}, без изменений ${skipped}`
            : mode === 'auto'
              ? `Автозагрузка премий из продаж: обновлено ${updated}`
              : `Записано премий: ${updated}, без изменений ${skipped}`,
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
        const headedIds = a.id ? await getHeadedDepartmentIds(db, a.id) : [];
        const visibleDepartments = await listVisibleDepartments(db, a);
        const isHeadAnywhere = headedIds.length > 0 || (emp ? isDeptHead(a, emp) : false);
        res.json({
            success: true,
            is_admin: isAdminActor(a),
            is_accounting: accounting,
            is_employee: !!emp,
            is_dept_head: isHeadAnywhere,
            headed_department_ids: headedIds,
            visible_departments: visibleDepartments.map((d) => ({
                id: d.id,
                name: d.name,
                schedule_type: d.schedule_type,
                can_edit: !!d.can_edit,
                is_own: !!d.is_own,
                is_headed: !!d.is_headed,
                via_manage: !!d.via_manage,
            })),
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
        // Отделы — общий справочник, при удалении юрлица не трогаем.
        await db.query('DELETE FROM ws_organization WHERE id=?', [id]);
        await writeAudit(db, req, {
            entity_type: 'organization',
            entity_id: id,
            action: 'delete',
            payload: { name: org.name },
        });
        res.json({
            success: true,
            id,
            name: org.name,
        });
    });

    // ----- departments -----
    router.get('/departments', async (req, res) => {
        const a = actorOf(req);
        // Отделы общие для всех орг.; query organization_id игнорируется (back-compat).
        // Сотрудник/рук: свой + headed + manage_scope; бухгалтерия — все (+ manage_scopes в карточке).
        const rows = await listVisibleDepartments(db, a);
        if (!rows.length && !isAccounting(a)) {
            return res.status(403).json({ success: false, error: 'forbidden' });
        }
        res.json({ success: true, rows });
    });

    router.post('/departments', async (req, res) => {
        if (!isAccounting(actorOf(req))) return res.status(403).json({ success: false, error: 'forbidden' });
        const b = req.body || {};
        const name = String(b.name || '').trim() || 'Отдел';
        const [dup] = await db.query(
            `SELECT id FROM ws_department WHERE LOWER(TRIM(name)) = LOWER(TRIM(?)) LIMIT 1`,
            [name]
        );
        if (dup.length) {
            return res.status(409).json({ success: false, error: 'отдел с таким именем уже есть' });
        }
        const [r] = await db.query(
            `INSERT INTO ws_department
             (organization_id, name, head_user_id, schedule_type, norm_hours, rate_full_hours, rate_half_hours,
              vacation_overlap_limit, premium_rule_json)
             VALUES (NULL, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                name,
                b.head_user_id ? Number(b.head_user_id) : null,
                b.schedule_type || '5/2',
                Number(b.norm_hours) || 8,
                Number(b.rate_full_hours) || 7,
                Number(b.rate_half_hours) || 4,
                Number(b.vacation_overlap_limit) || 1,
                normalizePremiumRuleBody(b.premium_rule_json, { allowInherit: false }),
            ]
        );
        if (Array.isArray(b.manage_scopes)) {
            await replaceManageScopes(db, r.insertId, b.manage_scopes);
        }
        await writeAudit(db, req, { entity_type: 'department', entity_id: r.insertId, action: 'create' });
        res.json({ success: true, id: r.insertId });
    });

    /**
     * Импорт отделов из специальностей Настроек (`specialties`) в общий справочник.
     * organization_id в body необязателен (игнорируется).
     */
    router.post('/departments/import-specialties', async (req, res) => {
        if (!isAccounting(actorOf(req))) return res.status(403).json({ success: false, error: 'forbidden' });
        const result = await importDepartmentsFromSpecialties(db);
        await writeAudit(db, req, {
            entity_type: 'department',
            entity_id: 0,
            action: 'import_specialties',
            payload: result,
        });
        res.json({ success: true, ...result });
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
                normalizePremiumRuleBody(b.premium_rule_json, { allowInherit: false }),
                id,
            ]
        );
        if (Array.isArray(b.manage_scopes)) {
            await replaceManageScopes(db, id, b.manage_scopes);
        }
        await writeAudit(db, req, { entity_type: 'department', entity_id: id, action: 'update' });
        res.json({ success: true });
    });

    // ----- employees -----
    router.get('/employees', async (req, res) => {
        const a = actorOf(req);
        const accounting = isAccounting(a);
        let sql = `SELECT e.*,
                          DATE_FORMAT(e.hire_date, '%Y-%m-%d') AS hire_date,
                          DATE_FORMAT(e.fire_date, '%Y-%m-%d') AS fire_date,
                          u.full_name, u.username, d.name AS department_name,
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
        res.json({ success: true, rows: (rows || []).map(mapEmployeeRow) });
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
                  personal_sick_leave_rate, personal_schedule_type, personal_premium_rule_json)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    userId,
                    Number(b.organization_id),
                    Number(b.department_id),
                    b.position || null,
                    dateOnlyYmd(b.hire_date),
                    dateOnlyYmd(b.fire_date),
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
                    normalizePremiumRuleBody(b.personal_premium_rule_json, { allowInherit: true }),
                ]
            );
            const newSalary = Number(b.salary) || 0;
            await writeAudit(db, req, {
                entity_type: 'employee',
                entity_id: r.insertId,
                action: 'create',
                field_name: 'salary',
                old_value: null,
                new_value: String(newSalary),
            });
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
        const [prevRows] = await db.query(`SELECT salary FROM ws_employee WHERE id=? LIMIT 1`, [id]);
        if (!prevRows.length) return res.status(404).json({ success: false, error: 'not found' });
        const oldSalary = Number(prevRows[0].salary) || 0;
        const newSalary = Number(b.salary) || 0;
        const bitcopId =
            b.bitcop_employee_id === '' || b.bitcop_employee_id == null
                ? null
                : Number(b.bitcop_employee_id);
        const seniorityOff = b.seniority_pay_disabled === true || b.seniority_pay_disabled === 1 || b.seniority_pay_disabled === '1';
        await db.query(
            `UPDATE ws_employee SET
             organization_id=?, department_id=?, position=?, hire_date=?, fire_date=?, salary=?, grade=?,
             official_employment=?, personal_work_hours_per_day=?, personal_rate_full_hours=?,
             personal_rate_half_hours=?, personal_sick_leave_rate=?, personal_schedule_type=?,
             personal_premium_rule_json=?, bitcop_employee_id=?, seniority_pay_disabled=?
             WHERE id=?`,
            [
                Number(b.organization_id),
                Number(b.department_id),
                b.position || null,
                dateOnlyYmd(b.hire_date),
                dateOnlyYmd(b.fire_date),
                newSalary,
                b.grade || null,
                b.official_employment ? 1 : 0,
                nullIfEmpty(b.personal_work_hours_per_day),
                nullIfEmpty(b.personal_rate_full_hours),
                nullIfEmpty(b.personal_rate_half_hours),
                nullIfEmpty(b.personal_sick_leave_rate),
                b.personal_schedule_type || null,
                normalizePremiumRuleBody(b.personal_premium_rule_json, { allowInherit: true }),
                Number.isFinite(bitcopId) && bitcopId > 0 ? bitcopId : null,
                seniorityOff ? 1 : 0,
                id,
            ]
        );
        await writeAudit(db, req, { entity_type: 'employee', entity_id: id, action: 'update' });
        if (oldSalary !== newSalary) {
            await writeAudit(db, req, {
                entity_type: 'employee',
                entity_id: id,
                action: 'salary_change',
                field_name: 'salary',
                old_value: String(oldSalary),
                new_value: String(newSalary),
            });
        }
        res.json({ success: true });
    });

    /** История изменений оклада: бухгалтерия — любой сотрудник; сотрудник — только свой. */
    router.get('/employees/:id/salary-history', async (req, res) => {
        const a = actorOf(req);
        const id = Number(req.params.id);
        if (!id) return res.status(400).json({ success: false, error: 'id required' });
        const accounting = isAccounting(a);
        if (!accounting) {
            const self = a.id ? await getEmployeeByUserId(db, a.id) : null;
            if (!self || Number(self.id) !== id) {
                return res.status(403).json({ success: false, error: 'forbidden' });
            }
        }
        const [empRows] = await db.query(
            `SELECT e.id, e.salary, u.full_name, u.username
             FROM ws_employee e JOIN users u ON u.id=e.user_id WHERE e.id=? LIMIT 1`,
            [id]
        );
        if (!empRows.length) return res.status(404).json({ success: false, error: 'not found' });
        const [rows] = await db.query(
            `SELECT a.id, a.action, a.field_name, a.old_value, a.new_value, a.user_id, a.user_role,
                    a.ip, a.created_at, u.full_name, u.username
             FROM ws_audit_log a
             LEFT JOIN users u ON u.id=a.user_id
             WHERE a.entity_type='employee' AND a.entity_id=? AND a.field_name='salary'
             ORDER BY a.id DESC
             LIMIT 200`,
            [String(id)]
        );
        res.json({
            success: true,
            employee: {
                id: empRows[0].id,
                full_name: empRows[0].full_name || empRows[0].username,
                salary: Number(empRows[0].salary) || 0,
            },
            rows: rows || [],
        });
    });

    // ----- clock -----
    router.get('/clock/status', async (req, res) => {
        const a = actorOf(req);
        const emp = await getEmployeeByUserId(db, a.id);
        if (!emp) return res.json({ success: true, open: false, employee: null });
        const today = calc.moscowYmd();
        const [rows] = await db.query(
            `SELECT * FROM ws_work_log WHERE employee_id=? AND work_date=? LIMIT 1`,
            [emp.id, today]
        );
        const row = rows[0] || null;
        const open = !!(row && row.check_in && !row.check_out);
        const segments = calc.parseSegments(row && row.segments_json);
        const sealedH = calc.hoursFromSegments(segments);
        res.json({
            success: true,
            open,
            employee_id: emp.id,
            work_date: today,
            check_in: open ? row.check_in : null,
            check_out: row ? row.check_out : null,
            status: row ? row.status : null,
            hours_worked: row ? Number(row.hours_worked) || sealedH : 0,
            hours_sealed: sealedH,
            segments_count: segments.length,
            segments,
            server_now: calc.moscowNowSql(),
        });
    });

    router.post('/clock/start', async (req, res) => {
        const a = actorOf(req);
        const emp = await getEmployeeByUserId(db, a.id);
        if (!emp) return res.status(403).json({ success: false, error: 'нет карточки сотрудника' });
        const today = calc.moscowYmd();
        const [open] = await db.query(
            `SELECT id, work_date FROM ws_work_log WHERE employee_id=? AND check_in IS NOT NULL AND check_out IS NULL LIMIT 1`,
            [emp.id]
        );
        if (open.length) {
            return res.status(409).json({
                success: false,
                error: 'смена уже открыта',
                work_date: calc.toYmd(open[0].work_date),
            });
        }
        const [existing] = await db.query(
            `SELECT *,
                    DATE_FORMAT(check_in, '%Y-%m-%d %H:%i:%s') AS check_in_sql,
                    DATE_FORMAT(check_out, '%Y-%m-%d %H:%i:%s') AS check_out_sql
             FROM ws_work_log WHERE employee_id=? AND work_date=? LIMIT 1`,
            [emp.id, today]
        );
        const now = calc.moscowNowSql();
        let hoursSoFar = 0;
        let segments = [];
        let resumed = false;

        if (existing.length) {
            const row = existing[0];
            // Перед новым сегментом — зафиксировать прошлый закрытый кусок (строки DATE_FORMAT = стена МСК).
            let sealed = calc.parseSegments(row.segments_json);
            if (row.check_in_sql && row.check_out_sql) {
                const packed = calc.appendClosedSegment(
                    sealed,
                    row.check_in_sql,
                    row.check_out_sql,
                    row.source || 'clock',
                    {
                        ip_in: row.check_in_ip,
                        ip_out: row.check_out_ip,
                        device_in: row.check_in_device,
                        device_out: row.check_out_device,
                    }
                );
                sealed = packed.segments;
                hoursSoFar = packed.hours;
                resumed = true;
            } else {
                hoursSoFar = Math.max(
                    Number(row.hours_worked) || 0,
                    calc.hoursFromSegments(sealed)
                );
            }
            segments = sealed;
            const thr = calc.resolveEmployeeThresholds(emp, emp);
            const rate = calc.rateFromHours(calc.roundHoursTo5Min(hoursSoFar), thr);
            await db.query(
                `UPDATE ws_work_log SET
                   check_in=?, check_out=NULL, check_out_ip=NULL, check_out_device=NULL,
                   check_in_ip=?, check_in_device=?, user_agent=?,
                   hours_worked=?, rate=?, segments_json=?, status='ok', source='clock'
                 WHERE id=?`,
                [
                    now,
                    clientIp(req),
                    deviceLabel(req),
                    userAgent(req),
                    hoursSoFar,
                    rate,
                    JSON.stringify(segments),
                    row.id,
                ]
            );
        } else {
            await db.query(
                `INSERT INTO ws_work_log
                 (employee_id, work_date, type, rate, check_in, check_in_ip, check_in_device, user_agent,
                  hours_worked, segments_json, source, status)
                 VALUES (?, ?, 'work', 0, ?, ?, ?, ?, 0, ?, 'clock', 'ok')`,
                [emp.id, today, now, clientIp(req), deviceLabel(req), userAgent(req), JSON.stringify([])]
            );
        }
        await writeAudit(db, req, {
            entity_type: 'work_log',
            entity_id: `${emp.id}:${today}`,
            action: resumed ? 'clock_restart' : 'clock_start',
            new_value: JSON.stringify({ check_in: now, hours_worked_so_far: hoursSoFar, segments }),
        });
        res.json({
            success: true,
            check_in: now,
            work_date: today,
            resumed,
            hours_worked_so_far: hoursSoFar,
            segments_count: segments.length,
        });
    });

    router.post('/clock/stop', async (req, res) => {
        const a = actorOf(req);
        const emp = await getEmployeeByUserId(db, a.id);
        if (!emp) return res.status(403).json({ success: false, error: 'нет карточки сотрудника' });
        const [rows] = await db.query(
            `SELECT *, DATE_FORMAT(check_in, '%Y-%m-%d %H:%i:%s') AS check_in_sql
             FROM ws_work_log
             WHERE employee_id=? AND check_in IS NOT NULL AND check_out IS NULL
             ORDER BY id DESC LIMIT 1`,
            [emp.id]
        );
        if (!rows.length) return res.status(409).json({ success: false, error: 'нет открытой смены' });
        const log = rows[0];
        const now = calc.moscowNowSql();
        // Оба конца — наивные строки МСК (не Date mysql2), иначе +3 ч к длительности.
        const outIp = clientIp(req);
        const outDev = deviceLabel(req);
        const packed = calc.appendClosedSegment(
            log.segments_json,
            log.check_in_sql || log.check_in,
            now,
            'clock',
            {
                ip_in: log.check_in_ip,
                ip_out: outIp,
                device_in: log.check_in_device,
                device_out: outDev,
            }
        );
        const hours = packed.hours;
        const thr = calc.resolveEmployeeThresholds(emp, emp);
        const rate = calc.rateFromHours(calc.roundHoursTo5Min(hours), thr);
        // Сначала жёстко пишем часы/сегменты — payroll не должен откатывать фиксацию.
        await db.query(
            `UPDATE ws_work_log SET
               check_out=?, check_out_ip=?, check_out_device=?,
               hours_worked=?, rate=?, segments_json=?, status='ok'
             WHERE id=? AND check_out IS NULL`,
            [now, outIp, outDev, hours, rate, JSON.stringify(packed.segments), log.id]
        );
        await writeAudit(db, req, {
            entity_type: 'work_log',
            entity_id: String(log.id),
            action: 'clock_stop',
            new_value: JSON.stringify({
                hours,
                rate,
                check_in: calc.moscowSqlFromDate(log.check_in),
                check_out: now,
                segments: packed.segments,
            }),
        });
        let payroll = null;
        let payroll_error = null;
        try {
            const period = calc.periodYmFromDate(log.work_date);
            payroll = await recalcPayroll(db, emp.id, period);
        } catch (e) {
            payroll_error = e.message || String(e);
        }
        res.json({
            success: true,
            hours_worked: hours,
            rate,
            segments_count: packed.segments.length,
            segments: packed.segments,
            payroll,
            payroll_error,
        });
    });

    router.get('/stuck-shifts', async (req, res) => {
        const a = actorOf(req);
        const accounting = isAccounting(a);
        const emp = await getEmployeeByUserId(db, a.id);
        const headedIds = accounting ? [] : await getHeadedDepartmentIds(db, a.id);
        if (!accounting && !(emp && (isDeptHead(a, emp) || headedIds.length))) {
            return res.status(403).json({ success: false, error: 'forbidden' });
        }
        let sql = `SELECT w.*, e.department_id, u.full_name
                   FROM ws_work_log w
                   JOIN ws_employee e ON e.id = w.employee_id
                   JOIN users u ON u.id = e.user_id
                   WHERE w.check_in IS NOT NULL AND w.check_out IS NULL`;
        const params = [];
        const qDept = req.query.department_id ? Number(req.query.department_id) : null;
        let deptId = null;
        if (qDept) {
            if (!(await canAccessDepartment(db, a, qDept))) {
                return res.status(403).json({ success: false, error: 'forbidden' });
            }
            deptId = qDept;
        } else if (!accounting && emp) {
            deptId = emp.department_id;
        }
        if (deptId) {
            sql += ' AND e.department_id=?';
            params.push(deptId);
        }
        sql += ' ORDER BY w.check_in';
        const [rows] = await db.query(sql, params);
        const nowSql = calc.moscowNowSql();
        res.json({
            success: true,
            department_id: deptId,
            rows: rows.map((r) => ({
                ...r,
                hours_open: calc.roundHoursTo5Min(calc.hoursBetween(r.check_in, nowSql)),
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

        let esql = `SELECT e.id, e.salary, e.department_id, e.hire_date, e.personal_premium_rule_json,
                           e.personal_seniority_base, e.personal_seniority_step, e.personal_seniority_period_months,
                           e.personal_schedule_type, e.personal_work_hours_per_day,
                           e.personal_rate_full_hours, e.personal_rate_half_hours,
                           e.bitcop_employee_id, e.seniority_pay_disabled,
                           u.full_name, d.name AS department_name, d.schedule_type,
                           d.premium_rule_json AS dept_premium_rule_json,
                           o.seniority_base, o.seniority_step, o.seniority_period_months
                    FROM ws_employee e JOIN users u ON u.id=e.user_id
                    JOIN ws_department d ON d.id=e.department_id
                    JOIN ws_organization o ON o.id=e.organization_id
                    WHERE 1=1`;
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
        const hasSalesDept = (emps || []).some((e) => isSalesDepartmentName(e.department_name));
        let salesPremiumSync = null;
        if (hasSalesDept) {
            try {
                salesPremiumSync = await syncSalesPremiums(db, req, {
                    periodYm: ym,
                    orgId,
                    deptId,
                    dryRun: false,
                    mode: 'auto',
                });
            } catch (syncErr) {
                console.warn('[work-schedule] auto sales premiums:', syncErr && syncErr.message);
            }
        }
        const ids = emps.map((e) => e.id);
        let logs = [];
        if (ids.length) {
            const [L] = await db.query(
                `SELECT employee_id, DATE_FORMAT(work_date, '%Y-%m-%d') AS work_ymd, type, rate, hours_worked, status,
                        check_in, check_out
                 FROM ws_work_log WHERE employee_id IN (?) AND work_date BETWEEN ? AND ?`,
                [ids, from, to]
            );
            logs = L;
        }
        const byEmp = {};
        for (const L of logs) {
            const key = L.employee_id;
            if (!byEmp[key]) byEmp[key] = {};
            const day = Number(String(L.work_ymd || calc.toYmd(L.work_date) || '').slice(8, 10));
            if (!day) continue;
            byEmp[key][day] = {
                type: L.type,
                rate: Number(L.rate),
                hours: L.hours_worked != null ? Number(L.hours_worked) : null,
                status: L.status,
                open: !!(L.check_in && !L.check_out),
            };
        }
        const payrollByEmp = {};
        if (ids.length) {
            const [pr] = await db.query(
                `SELECT employee_id, base_salary, premium, premium_manual, premium_source, seniority_bonus, total, worked_days, norm_days
                 FROM ws_payroll_entry WHERE period_ym=? AND employee_id IN (?)`,
                [ym, ids]
            );
            for (const p of pr) payrollByEmp[p.employee_id] = p;
        }
        const normCache = {};
        let mandays = 0;
        let fot = 0;
        const employeesOut = [];
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
            const thr = calc.resolveEmployeeThresholds(e, e);
            const st = thr.scheduleType || e.schedule_type || '5/2';
            if (normCache[st] == null) {
                // eslint-disable-next-line no-await-in-loop
                normCache[st] = await calc.monthNormDays(db, ym, st);
            }
            const normDays = Number(normCache[st]) || 21;
            const salaryRate = Number(e.salary) || 0;
            const premiumRule = calc.resolvePremiumRule(e, e);
            const premiumFull =
                premiumRule.kind === 'fixed' || premiumRule.kind === 'fixed_full'
                    ? Number(premiumRule.amount) || 0
                    : 0;
            const stored = payrollByEmp[e.id];
            const premiumFromRule = calc.computePremium(premiumRule, { workedDays: days, normDays });
            const premiumManual =
                stored && stored.premium_manual != null && stored.premium_manual !== ''
                    ? Number(stored.premium_manual)
                    : null;
            const premiumSource =
                stored && stored.premium_source != null && String(stored.premium_source).trim()
                    ? String(stored.premium_source).trim()
                    : null;
            const baseAccrued = stored
                ? Number(stored.base_salary) || 0
                : calc.prorateByWorkedDays(salaryRate, days, normDays);
            const premiumAccrued =
                premiumManual != null && Number.isFinite(premiumManual)
                    ? premiumManual
                    : stored
                      ? Number(stored.premium) || 0
                      : premiumFromRule;
            const senDisabled = Number(e.seniority_pay_disabled) === 1;
            const senParams = calc.resolveSeniorityParams(e, e);
            const seniorityFull = senDisabled
                ? 0
                : calc.seniorityBonus(e.hire_date, `${ym}-28`, senParams);
            const seniorityAccrued = senDisabled
                ? 0
                : stored
                  ? Number(stored.seniority_bonus) || 0
                  : calc.prorateByWorkedDays(seniorityFull, days, normDays);
            /** Премия «к которой можно выйти» за полный месяц (не доля дней). */
            const premiumPlanned =
                premiumManual != null && Number.isFinite(premiumManual)
                    ? premiumManual
                    : premiumRule.kind === 'fixed' || premiumRule.kind === 'fixed_full'
                      ? Number(premiumRule.amount) || 0
                      : 0;
            const totalAccrued =
                Math.round((baseAccrued + premiumAccrued + seniorityAccrued) * 100) / 100;
            const totalPlanned =
                Math.round((salaryRate + premiumPlanned + seniorityFull) * 100) / 100;
            fot += totalAccrued;
            employeesOut.push({
                id: e.id,
                full_name: e.full_name,
                department_id: e.department_id,
                department_name: e.department_name,
                salary: salaryRate,
                salary_accrued: baseAccrued,
                premium_kind: premiumRule.kind || 'stub',
                premium_full: premiumFull,
                premium_from_rule: premiumFromRule,
                premium_manual: premiumManual,
                premium_source: premiumSource,
                premium_accrued: premiumAccrued,
                premium_planned: premiumPlanned,
                seniority_full: seniorityFull,
                seniority_accrued: seniorityAccrued,
                seniority_pay_disabled: senDisabled,
                bitcop_employee_id: e.bitcop_employee_id != null ? Number(e.bitcop_employee_id) : null,
                total_accrued: totalAccrued,
                total_planned: totalPlanned,
                worked_days: stored ? Number(stored.worked_days) : days,
                norm_days: stored ? Number(stored.norm_days) : normDays,
            });
        }
        const calendar = await rfCalendar.getMonthCalendarMap(db, ym);
        res.json({
            success: true,
            month: ym,
            employees: employeesOut,
            cells: byEmp,
            calendar,
            kpi: {
                mandays: Math.round(mandays * 10) / 10,
                fot: Math.round(fot),
                count: employeesOut.length,
            },
            sales_premium_sync: salesPremiumSync
                ? {
                      updated: salesPremiumSync.updated,
                      skipped: salesPremiumSync.skipped,
                      no_sales: salesPremiumSync.no_sales,
                      total: salesPremiumSync.total,
                  }
                : null,
        });
    });

    /**
     * Принудительно обновить премии из /manager-sales.html (totals.bonus) → premium_manual.
     * Автозагрузка уже идёт в GET /sheet; эта кнопка — пересчёт после новых продаж / поверх ручных.
     * body/query: period_ym, dry_run?, organization_id?, department_id?, force? (default true)
     */
    router.post('/sheet/premium-from-sales', async (req, res) => {
        const a = actorOf(req);
        if (!isAccounting(a)) return res.status(403).json({ success: false, error: 'forbidden' });
        const b = req.body || {};
        const periodYm = String(b.period_ym || req.query.period_ym || calc.moscowYmd().slice(0, 7));
        if (!/^\d{4}-\d{2}$/.test(periodYm)) {
            return res.status(400).json({ success: false, error: 'period_ym=YYYY-MM' });
        }
        const dryRun = !!(b.dry_run === true || b.dry_run === 1 || b.dry_run === '1' || req.query.dry_run);
        const orgRaw = b.organization_id != null ? b.organization_id : req.query.organization_id;
        const deptRaw = b.department_id != null ? b.department_id : req.query.department_id;
        const orgId = orgRaw ? Number(orgRaw) : null;
        const deptId = deptRaw ? Number(deptRaw) : null;
        const forceOff = b.force === false || b.force === 0 || b.force === '0';
        const result = await syncSalesPremiums(db, req, {
            periodYm,
            orgId,
            deptId,
            dryRun,
            mode: forceOff ? 'auto' : 'force',
        });
        res.json(result);
    });

    /**
     * Ручная премия за месяц (перекрывает правило из настроек).
     * body: { employee_id, period_ym?, premium_manual: number|null }
     * null / пусто — снять ручной ввод и вернуть расчёт по правилу.
     */
    router.patch('/sheet/premium', async (req, res) => {
        const a = actorOf(req);
        if (!isAccounting(a)) return res.status(403).json({ success: false, error: 'forbidden' });
        const b = req.body || {};
        const employeeId = Number(b.employee_id);
        const periodYm = String(b.period_ym || calc.moscowYmd().slice(0, 7));
        if (!employeeId || !/^\d{4}-\d{2}$/.test(periodYm)) {
            return res.status(400).json({ success: false, error: 'bad params' });
        }
        const emp = await getEmployeeById(db, employeeId);
        if (!emp) return res.status(404).json({ success: false, error: 'employee not found' });
        const raw = b.premium_manual;
        const clear =
            raw === null ||
            raw === undefined ||
            raw === '' ||
            (typeof raw === 'string' && !String(raw).trim());
        let premiumManual = null;
        if (!clear) {
            const n = Number(String(raw).replace(/\s/g, '').replace(',', '.'));
            if (!Number.isFinite(n) || n < 0) {
                return res.status(400).json({ success: false, error: 'premium_manual must be ≥ 0' });
            }
            premiumManual = Math.round(n * 100) / 100;
        }
        const [prev] = await db.query(
            `SELECT premium_manual, premium_source FROM ws_payroll_entry WHERE employee_id=? AND period_ym=? LIMIT 1`,
            [employeeId, periodYm]
        );
        const oldVal = prev[0] && prev[0].premium_manual != null ? String(prev[0].premium_manual) : null;
        const premiumSource = clear ? null : 'manual';
        await db.query(
            `INSERT INTO ws_payroll_entry
             (employee_id, period_ym, base_salary, premium, premium_manual, premium_source, seniority_bonus,
              vacation_pay, sick_pay, dayoff_pay, business_trip_pay, vacation_compensation, total,
              worked_days, norm_days, calculated_at)
             VALUES (?, ?, 0, ?, ?, ?, 0, 0, 0, 0, 0, 0, ?, 0, 0, ?)
             ON DUPLICATE KEY UPDATE
               premium_manual=VALUES(premium_manual),
               premium_source=VALUES(premium_source)`,
            [
                employeeId,
                periodYm,
                premiumManual != null ? premiumManual : 0,
                premiumManual,
                premiumSource,
                premiumManual != null ? premiumManual : 0,
                calc.moscowNowSql(),
            ]
        );
        await writeAudit(db, req, {
            entity_type: 'payroll',
            entity_id: `${employeeId}:${periodYm}`,
            action: clear ? 'premium_manual_clear' : 'premium_manual_set',
            field_name: 'premium_manual',
            old_value: oldVal,
            new_value: premiumManual != null ? String(premiumManual) : null,
        });
        const payroll = await recalcPayroll(db, employeeId, periodYm);
        res.json({
            success: true,
            payroll,
            premium_manual: premiumManual,
            premium_source: premiumSource,
        });
    });

    async function applySheetCellEdit(dbConn, req, a, { employeeId, workDate, type, rate, hours }) {
        const [ex] = await dbConn.query(`SELECT * FROM ws_work_log WHERE employee_id=? AND work_date=? LIMIT 1`, [
            employeeId,
            workDate,
        ]);
        let created = false;
        if (ex.length) {
            await dbConn.query(
                `UPDATE ws_work_log SET type=?, rate=?, hours_worked=?, source='manual', edited_by=?, edited_at=?
                 WHERE id=?`,
                [type, rate, hours, a.id, calc.moscowNowSql(), ex[0].id]
            );
            await writeAudit(dbConn, req, {
                entity_type: 'work_log',
                entity_id: String(ex[0].id),
                action: 'manual_edit',
                old_value: JSON.stringify({ type: ex[0].type, rate: ex[0].rate }),
                new_value: JSON.stringify({ type, rate, hours }),
            });
        } else {
            const [ins] = await dbConn.query(
                `INSERT INTO ws_work_log
                 (employee_id, work_date, type, rate, hours_worked, source, status, edited_by, edited_at)
                 VALUES (?, ?, ?, ?, ?, 'manual', 'ok', ?, ?)`,
                [employeeId, workDate, type, rate, hours, a.id, calc.moscowNowSql()]
            );
            await writeAudit(dbConn, req, {
                entity_type: 'work_log',
                entity_id: String(ins.insertId),
                action: 'manual_create',
                new_value: JSON.stringify({ type, rate, hours }),
            });
            created = true;
        }
        return { created, updated: !created };
    }

    router.patch('/sheet/cell', async (req, res) => {
        const a = actorOf(req);
        const b = req.body || {};
        const employeeId = Number(b.employee_id);
        const workDate = String(b.work_date || '');
        if (!employeeId || !/^\d{4}-\d{2}-\d{2}$/.test(workDate)) {
            return res.status(400).json({ success: false, error: 'bad params' });
        }
        if (!(await canEditEmployeeTimesheet(db, a, employeeId))) {
            return res.status(403).json({ success: false, error: 'forbidden' });
        }
        const type = b.type || 'work';
        const rate = Number(b.rate) || 0;
        const hours = b.hours != null ? Number(b.hours) : null;
        await applySheetCellEdit(db, req, a, { employeeId, workDate, type, rate, hours });
        const payroll = await recalcPayroll(db, employeeId, calc.periodYmFromDate(workDate));
        res.json({ success: true, payroll });
    });

    /**
     * Массовая правка ячеек табеля.
     * body: { cells: [{ employee_id, work_date }], type, rate, hours }
     * accounting — любой сотрудник; руководитель — только сотрудники своих отделов (head_user_id).
     */
    router.patch('/sheet/cells-bulk', async (req, res) => {
        const a = actorOf(req);
        const accounting = isAccounting(a);
        const headedIds = accounting ? null : await getHeadedDepartmentIds(db, a.id);
        if (!accounting && !(headedIds && headedIds.length)) {
            return res.status(403).json({ success: false, error: 'forbidden' });
        }
        const t0 = Date.now();
        const b = req.body || {};
        const type = b.type || 'work';
        const rate = Number(b.rate) || 0;
        const hours = b.hours != null ? Number(b.hours) : null;
        const rawCells = Array.isArray(b.cells) ? b.cells : [];
        if (!rawCells.length) {
            return res.status(400).json({ success: false, error: 'cells required' });
        }
        if (rawCells.length > 366) {
            return res.status(400).json({ success: false, error: 'too many cells (max 366)' });
        }
        const seen = new Set();
        const cells = [];
        for (const c of rawCells) {
            const employeeId = Number(c && c.employee_id);
            const workDate = String((c && c.work_date) || '');
            if (!employeeId || !/^\d{4}-\d{2}-\d{2}$/.test(workDate)) continue;
            const key = `${employeeId}:${workDate}`;
            if (seen.has(key)) continue;
            seen.add(key);
            cells.push({ employeeId, workDate });
        }
        if (!cells.length) {
            return res.status(400).json({ success: false, error: 'bad cells' });
        }
        let created = 0;
        let updated = 0;
        const errors = [];
        const payrollEmpYm = new Set();
        for (const cell of cells) {
            try {
                // eslint-disable-next-line no-await-in-loop
                if (!(await canEditEmployeeTimesheet(db, a, cell.employeeId))) {
                    throw new Error('forbidden');
                }
                // eslint-disable-next-line no-await-in-loop
                const r = await applySheetCellEdit(db, req, a, {
                    employeeId: cell.employeeId,
                    workDate: cell.workDate,
                    type,
                    rate,
                    hours,
                });
                if (r.created) created += 1;
                else updated += 1;
                payrollEmpYm.add(`${cell.employeeId}:${calc.periodYmFromDate(cell.workDate)}`);
            } catch (err) {
                errors.push({
                    employee_id: cell.employeeId,
                    work_date: cell.workDate,
                    error: (err && err.message) || String(err),
                });
                if (errors.length >= 20) break;
            }
        }
        for (const key of payrollEmpYm) {
            const [empIdStr, ym] = key.split(':');
            try {
                // eslint-disable-next-line no-await-in-loop
                await recalcPayroll(db, Number(empIdStr), ym);
            } catch (err) {
                /* payroll ошибки не откатывают дни */
            }
        }
        await writeAudit(db, req, {
            entity_type: 'work_log',
            entity_id: String(cells[0].workDate).slice(0, 7),
            action: 'manual_bulk',
            new_value: JSON.stringify({
                total: cells.length,
                created,
                updated,
                type,
                rate,
                hours,
                failed: errors.length,
            }),
        });
        res.json({
            success: errors.length === 0,
            total: cells.length,
            created,
            updated,
            failed: errors.length,
            errors,
            type,
            rate,
            hours,
            duration_sec: Math.round((Date.now() - t0) / 1000),
        });
    });

    // ----- Bitcop (часы контента) -----
    router.get('/bitcop/config', async (req, res) => {
        if (!isAccounting(actorOf(req))) return res.status(403).json({ success: false, error: 'forbidden' });
        const cfg = await bitcop.loadBitcopSettings(db);
        res.json({
            success: true,
            account: cfg.account,
            api_key_set: !!cfg.api_key,
            api_key_masked: bitcop.maskSecret(cfg.api_key),
            metric: cfg.metric,
            base_url: cfg.account ? bitcop.baseUrl(cfg.account) : null,
        });
    });

    router.post('/bitcop/config', async (req, res) => {
        if (!isAccounting(actorOf(req))) return res.status(403).json({ success: false, error: 'forbidden' });
        const b = req.body || {};
        try {
            const saved = await bitcop.saveBitcopSettings(db, {
                account: b.account,
                api_key: b.api_key,
                metric: b.metric,
                clear_api_key: !!b.clear_api_key,
            });
            await writeAudit(db, req, {
                entity_type: 'settings',
                entity_id: 'bitcop',
                action: 'update',
                new_value: JSON.stringify({
                    account: saved.account,
                    metric: saved.metric,
                    api_key_set: !!saved.api_key,
                }),
            });
            res.json({
                success: true,
                account: saved.account,
                api_key_set: !!saved.api_key,
                api_key_masked: bitcop.maskSecret(saved.api_key),
                metric: saved.metric,
                base_url: bitcop.baseUrl(saved.account),
            });
        } catch (e) {
            return res.status(400).json({ success: false, error: (e && e.message) || String(e) });
        }
    });

    router.get('/bitcop/employees', async (req, res) => {
        if (!isAccounting(actorOf(req))) return res.status(403).json({ success: false, error: 'forbidden' });
        try {
            const rows = await bitcop.listEmployees(db);
            res.json({ success: true, rows });
        } catch (e) {
            return res.status(502).json({ success: false, error: (e && e.message) || String(e) });
        }
    });

    router.post('/bitcop/test', async (req, res) => {
        if (!isAccounting(actorOf(req))) return res.status(403).json({ success: false, error: 'forbidden' });
        try {
            const rows = await bitcop.listEmployees(db);
            res.json({
                success: true,
                message: `Bitcop OK · сотрудников: ${rows.length}`,
                employees_count: rows.length,
            });
        } catch (e) {
            return res.status(502).json({ success: false, error: (e && e.message) || String(e) });
        }
    });

    /**
     * Подтянуть продуктивные (или выбранные) часы из Bitcop в ws_work_log за месяц.
     * body: { period_ym, dry_run?, force?, organization_id?, department_id?, employee_id? }
     * Не затирает vacation/sick/dayoff (без force).
     */
    router.post('/bitcop/sync-hours', async (req, res) => {
        const a = actorOf(req);
        if (!isAccounting(a)) return res.status(403).json({ success: false, error: 'forbidden' });
        const t0 = Date.now();
        const b = req.body || {};
        const periodYm = String(b.period_ym || calc.moscowYmd().slice(0, 7));
        if (!/^\d{4}-\d{2}$/.test(periodYm)) {
            return res.status(400).json({ success: false, error: 'period_ym required (YYYY-MM)' });
        }
        const dryRun = !!b.dry_run;
        const force = !!b.force;
        const orgId = b.organization_id ? Number(b.organization_id) : null;
        const deptId = b.department_id ? Number(b.department_id) : null;
        const onlyEmp = b.employee_id ? Number(b.employee_id) : null;

        let esql = `SELECT e.id, e.bitcop_employee_id, e.salary, e.hire_date,
                           e.personal_schedule_type, e.personal_work_hours_per_day,
                           e.personal_rate_full_hours, e.personal_rate_half_hours,
                           u.full_name, d.schedule_type, d.norm_hours, d.rate_full_hours, d.rate_half_hours
                    FROM ws_employee e
                    JOIN users u ON u.id=e.user_id
                    JOIN ws_department d ON d.id=e.department_id
                    WHERE e.bitcop_employee_id IS NOT NULL AND e.bitcop_employee_id > 0
                      AND (e.fire_date IS NULL OR e.fire_date >= ?)`;
        const params = [`${periodYm}-01`];
        if (orgId) {
            esql += ' AND e.organization_id=?';
            params.push(orgId);
        }
        if (deptId) {
            esql += ' AND e.department_id=?';
            params.push(deptId);
        }
        if (onlyEmp) {
            esql += ' AND e.id=?';
            params.push(onlyEmp);
        }
        const [emps] = await db.query(esql, params);
        if (!(emps || []).length) {
            return res.json({
                success: true,
                dry_run: dryRun,
                period_ym: periodYm,
                total: 0,
                updated: 0,
                created: 0,
                skipped: 0,
                days: 0,
                message: 'Нет сотрудников с привязкой Bitcop',
                duration_sec: Math.round((Date.now() - t0) / 1000),
            });
        }

        const cfg = await bitcop.loadBitcopSettings(db);
        const metric = cfg.metric;
        const dim = calc.daysInMonthYm(periodYm);
        const bitcopIds = [...new Set(emps.map((e) => Number(e.bitcop_employee_id)).filter((n) => n > 0))];
        let updated = 0;
        let created = 0;
        let skipped = 0;
        let daysTouched = 0;
        const errors = [];
        const payrollIds = new Set();
        const PROTECTED = new Set(['vacation', 'sick', 'dayoff', 'business_trip']);

        for (let day = 1; day <= dim; day++) {
            const ymd = `${periodYm}-${String(day).padStart(2, '0')}`;
            const range = bitcop.dayRangeBitcop(ymd);
            let prodMap = new Map();
            let actMap = new Map();
            try {
                if (metric === 'productiveTime') {
                    // eslint-disable-next-line no-await-in-loop
                    prodMap = await bitcop.fetchProductivityMap(db, {
                        begin: range.begin,
                        end: range.end,
                        employeeIds: bitcopIds,
                    });
                } else {
                    // eslint-disable-next-line no-await-in-loop
                    actMap = await bitcop.fetchActivityMap(db, {
                        begin: range.begin,
                        end: range.end,
                        employeeIds: bitcopIds,
                    });
                }
            } catch (err) {
                errors.push({ work_date: ymd, error: (err && err.message) || String(err) });
                if (errors.length >= 20) break;
                continue;
            }

            for (const e of emps) {
                const bid = Number(e.bitcop_employee_id);
                const row = metric === 'productiveTime' ? prodMap.get(bid) : actMap.get(bid);
                const sec = bitcop.pickMetricSeconds(row, metric);
                const hours = bitcop.secondsToHours(sec);
                if (hours <= 0) {
                    skipped += 1;
                    continue;
                }
                const thr = calc.resolveEmployeeThresholds(e, e);
                const rate = calc.rateFromHours(hours, thr);
                // eslint-disable-next-line no-await-in-loop
                const [ex] = await db.query(
                    `SELECT id, type, rate, hours_worked, source FROM ws_work_log
                     WHERE employee_id=? AND work_date=? LIMIT 1`,
                    [e.id, ymd]
                );
                if (ex.length && PROTECTED.has(String(ex[0].type)) && !force) {
                    skipped += 1;
                    continue;
                }
                if (
                    ex.length &&
                    String(ex[0].type) === 'work' &&
                    Math.abs(Number(ex[0].hours_worked) - hours) < 0.005 &&
                    Math.abs(Number(ex[0].rate) - rate) < 0.005 &&
                    String(ex[0].source) === 'bitcop'
                ) {
                    skipped += 1;
                    continue;
                }
                daysTouched += 1;
                if (dryRun) {
                    if (ex.length) updated += 1;
                    else created += 1;
                    continue;
                }
                try {
                    if (ex.length) {
                        // eslint-disable-next-line no-await-in-loop
                        await db.query(
                            `UPDATE ws_work_log SET type='work', rate=?, hours_worked=?, source='bitcop',
                             edited_by=?, edited_at=?, status='ok'
                             WHERE id=?`,
                            [rate, hours, a.id, calc.moscowNowSql(), ex[0].id]
                        );
                        updated += 1;
                    } else {
                        // eslint-disable-next-line no-await-in-loop
                        await db.query(
                            `INSERT INTO ws_work_log
                             (employee_id, work_date, type, rate, hours_worked, source, status, edited_by, edited_at)
                             VALUES (?, ?, 'work', ?, ?, 'bitcop', 'ok', ?, ?)`,
                            [e.id, ymd, rate, hours, a.id, calc.moscowNowSql()]
                        );
                        created += 1;
                    }
                    payrollIds.add(e.id);
                } catch (err) {
                    errors.push({
                        employee_id: e.id,
                        work_date: ymd,
                        error: (err && err.message) || String(err),
                    });
                    if (errors.length >= 20) break;
                }
            }
            if (errors.length >= 20) break;
        }

        if (!dryRun) {
            for (const empId of payrollIds) {
                try {
                    // eslint-disable-next-line no-await-in-loop
                    await recalcPayroll(db, empId, periodYm);
                } catch (err) {
                    /* ignore */
                }
            }
            await writeAudit(db, req, {
                entity_type: 'work_log',
                entity_id: periodYm,
                action: 'bitcop_sync_hours',
                new_value: JSON.stringify({
                    updated,
                    created,
                    skipped,
                    metric,
                    employees: emps.length,
                    failed: errors.length,
                }),
            });
        }

        res.json({
            success: errors.length === 0,
            dry_run: dryRun,
            period_ym: periodYm,
            metric,
            employees: emps.length,
            days_touched: daysTouched,
            created,
            updated,
            skipped,
            failed: errors.length,
            errors,
            duration_sec: Math.round((Date.now() - t0) / 1000),
            message: dryRun
                ? `Пробный прогон Bitcop: к записи ${created + updated}, пропуск ${skipped}`
                : `Bitcop: создано ${created}, обновлено ${updated}, пропуск ${skipped}`,
        });
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
            `SELECT DATE_FORMAT(work_date, '%Y-%m-%d') AS work_ymd, type, rate, hours_worked, status,
                    check_in, check_out, segments_json
             FROM ws_work_log
             WHERE employee_id=? AND work_date BETWEEN ? AND ?`,
            [emp.id, from, to]
        );
        const cells = {};
        for (const L of logs) {
            const ymd = L.work_ymd || calc.toYmd(L.work_date);
            const day = Number(String(ymd || '').slice(8, 10));
            if (!day) continue;
            const segs = calc.parseSegments(L.segments_json);
            let hours = Number(L.hours_worked) || 0;
            if (segs.length) hours = Math.max(hours, calc.hoursFromSegments(segs));
            // Открытый сегмент ещё не в JSON — прибавим текущий кусок до now.
            if (L.check_in && !L.check_out) {
                hours += calc.hoursBetween(L.check_in, calc.moscowNowSql());
            }
            cells[day] = {
                type: L.type,
                rate: Number(L.rate) || 0,
                hours: Math.round(hours * 10000) / 10000,
                status: L.status,
                logged: true,
                closed: !!L.check_out,
                open: !!(L.check_in && !L.check_out),
                segments_count: segs.length + (L.check_in && !L.check_out ? 1 : 0),
            };
        }
        const payroll = await recalcPayroll(db, emp.id, ym);
        // comment на отпуске может отсутствовать на старых БД — берём reject_reason.
        const [vacs] = await db.query(
            `SELECT id, employee_id, days_count, type, status, reject_reason AS comment,
                    DATE_FORMAT(date_from, '%Y-%m-%d') AS date_from,
                    DATE_FORMAT(date_to, '%Y-%m-%d') AS date_to
             FROM ws_vacation_request WHERE employee_id=? ORDER BY date_from DESC LIMIT 50`,
            [emp.id]
        );
        let hoursMonth = 0;
        Object.keys(cells).forEach((k) => {
            hoursMonth += Number(cells[k].hours) || 0;
        });
        hoursMonth = Math.round(hoursMonth * 10000) / 10000;
        const calendar = await rfCalendar.getMonthCalendarMap(db, ym);
        res.json({
            success: true,
            month: ym,
            cells,
            payroll,
            hours_month: hoursMonth,
            vacations: (vacs || []).map(mapVacationRow),
            employee: { id: emp.id, name: emp.user_full_name },
            calendar,
        });
    });

    /** Детали дня для модалки календаря: сегменты старт/стоп + IP. */
    router.get('/me/day', async (req, res) => {
        const a = actorOf(req);
        const emp = await getEmployeeByUserId(db, a.id);
        if (!emp) return res.status(403).json({ success: false, error: 'нет карточки сотрудника' });
        const day = String(req.query.date || calc.moscowYmd()).slice(0, 10);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
            return res.status(400).json({ success: false, error: 'date=YYYY-MM-DD' });
        }
        const [rows] = await db.query(
            `SELECT *,
                    DATE_FORMAT(check_in, '%Y-%m-%d %H:%i:%s') AS check_in_sql,
                    DATE_FORMAT(check_out, '%Y-%m-%d %H:%i:%s') AS check_out_sql,
                    DATE_FORMAT(work_date, '%Y-%m-%d') AS work_ymd
             FROM ws_work_log WHERE employee_id=? AND work_date=? LIMIT 1`,
            [emp.id, day]
        );
        const row = rows[0] || null;
        let segments = row ? calc.sanitizeSegments(row.segments_json) : [];
        if (row && row.check_in_sql && row.check_out_sql) {
            const packed = calc.appendClosedSegment(segments, row.check_in_sql, row.check_out_sql, row.source || 'clock', {
                ip_in: row.check_in_ip,
                ip_out: row.check_out_ip,
                device_in: row.check_in_device,
                device_out: row.check_out_device,
            });
            segments = packed.segments;
        }
        let open = null;
        if (row && row.check_in_sql && !row.check_out_sql) {
            const now = calc.moscowNowSql();
            open = {
                in: row.check_in_sql,
                out: null,
                ms: calc.msBetween(row.check_in_sql, now),
                hours: calc.hoursBetween(row.check_in_sql, now),
                source: 'clock',
                ip_in: row.check_in_ip || '',
                ip_out: '',
                device_in: row.check_in_device || '',
                device_out: '',
                open: true,
            };
        }
        const sealedH = calc.hoursFromSegments(segments);
        const hours = Math.round((sealedH + (open ? open.hours : 0)) * 10000) / 10000;
        res.json({
            success: true,
            date: day,
            employee: { id: emp.id, name: emp.user_full_name },
            found: !!row,
            type: row ? row.type : null,
            rate: row ? Number(row.rate) || 0 : 0,
            status: row ? row.status : null,
            hours_worked: hours,
            segments_count: segments.length + (open ? 1 : 0),
            segments,
            open,
            check_in: row ? row.check_in_sql : null,
            check_out: row ? row.check_out_sql : null,
            check_in_ip: row ? row.check_in_ip : null,
            check_out_ip: row ? row.check_out_ip : null,
        });
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
        if (!(await canAccessDepartment(db, a, deptId))) {
            return res.status(403).json({ success: false, error: 'forbidden' });
        }
        const [deptRows] = await db.query(
            `SELECT id, name, head_user_id, schedule_type FROM ws_department WHERE id=? LIMIT 1`,
            [deptId]
        );
        const deptMeta = deptRows[0] || { id: deptId, name: '', head_user_id: null, schedule_type: '' };
        let canEdit =
            accounting || (deptMeta.head_user_id != null && Number(deptMeta.head_user_id) === Number(a.id));
        if (!canEdit && emp) {
            const scope = await getManageAccess(db, emp.department_id, deptId);
            if (scope && scope.can_edit) canEdit = true;
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
        const todayYmd = calc.moscowYmd();
        const todayDay = Number(todayYmd.slice(8, 10));
        const todayInMonth = todayYmd.slice(0, 7) === ym;
        const nowSql = calc.moscowNowSql();
        if (ids.length) {
            const [logs] = await db.query(
                `SELECT employee_id, DATE_FORMAT(work_date, '%Y-%m-%d') AS work_ymd, type, rate, hours_worked,
                        check_in, check_out, segments_json,
                        DATE_FORMAT(check_in, '%Y-%m-%d %H:%i:%s') AS check_in_sql,
                        DATE_FORMAT(check_out, '%Y-%m-%d %H:%i:%s') AS check_out_sql
                 FROM ws_work_log
                 WHERE employee_id IN (?) AND work_date BETWEEN ? AND ?`,
                [ids, from, to]
            );
            for (const L of logs) {
                if (!byEmp[L.employee_id]) byEmp[L.employee_id] = {};
                const day = Number(String(L.work_ymd || calc.toYmd(L.work_date) || '').slice(8, 10));
                if (!day) continue;
                const segs = calc.parseSegments(L.segments_json);
                let hours = Number(L.hours_worked) || 0;
                if (segs.length) hours = Math.max(hours, calc.hoursFromSegments(segs));
                const open = !!(L.check_in && !L.check_out);
                if (open) hours += calc.hoursBetween(L.check_in, nowSql);
                byEmp[L.employee_id][day] = {
                    type: L.type,
                    rate: Number(L.rate),
                    hours: Math.round(hours * 10000) / 10000,
                    open,
                    closed: !!L.check_out,
                    check_in: L.check_in_sql || null,
                    check_out: L.check_out_sql || null,
                };
            }
        }
        const [vacs] = await db.query(
            `SELECT v.id, v.employee_id, v.days_count, v.type, v.status,
                    COALESCE(v.reject_reason, '') AS comment, u.full_name,
                    DATE_FORMAT(v.date_from, '%Y-%m-%d') AS date_from,
                    DATE_FORMAT(v.date_to, '%Y-%m-%d') AS date_to
             FROM ws_vacation_request v
             JOIN ws_employee e ON e.id=v.employee_id
             JOIN users u ON u.id=e.user_id
             WHERE e.department_id=? AND v.status IN ('pending','approved')
               AND v.date_to >= ? AND v.date_from <= ?`,
            [deptId, from, to]
        );
        const vacMapped = (vacs || []).map(mapVacationRow);
        const onVacationToday = new Set();
        const onSickToday = new Set();
        if (todayInMonth) {
            for (const v of vacMapped) {
                if (v.status !== 'approved') continue;
                if (v.date_from <= todayYmd && v.date_to >= todayYmd) {
                    if (v.type === 'sick') onSickToday.add(Number(v.employee_id));
                    else onVacationToday.add(Number(v.employee_id));
                }
            }
        }
        const STATUS_ORDER = { working: 0, finished: 1, vacation: 2, sick: 3, not_started: 4 };
        const today = todayInMonth
            ? emps
                  .map((e) => {
                      const c = (byEmp[e.id] && byEmp[e.id][todayDay]) || null;
                      let work_status = 'not_started';
                      if (onSickToday.has(Number(e.id)) || (c && c.type === 'sick')) work_status = 'sick';
                      else if (onVacationToday.has(Number(e.id)) || (c && c.type === 'vacation')) {
                          work_status = 'vacation';
                      } else if (c && c.open) work_status = 'working';
                      else if (c && (c.closed || Number(c.hours) > 0 || Number(c.rate) > 0)) {
                          work_status = 'finished';
                      }
                      return {
                          employee_id: e.id,
                          full_name: e.full_name,
                          work_status,
                          open: !!(c && c.open),
                          check_in: c && c.check_in ? String(c.check_in).slice(11, 16) : null,
                          check_out: c && c.check_out ? String(c.check_out).slice(11, 16) : null,
                          hours: c ? c.hours : 0,
                          rate: c ? c.rate : 0,
                          type: c ? c.type : null,
                      };
                  })
                  .sort((a, b) => {
                      const oa = STATUS_ORDER[a.work_status] ?? 9;
                      const ob = STATUS_ORDER[b.work_status] ?? 9;
                      if (oa !== ob) return oa - ob;
                      return String(a.full_name || '').localeCompare(String(b.full_name || ''), 'ru');
                  })
            : [];
        const calendar = await rfCalendar.getMonthCalendarMap(db, ym);
        res.json({
            success: true,
            month: ym,
            department_id: deptId,
            department_name: deptMeta.name || '',
            schedule_type: deptMeta.schedule_type || '',
            can_edit: !!canEdit,
            today_date: todayYmd,
            employees: emps,
            cells: byEmp,
            today,
            vacations: vacMapped,
            calendar,
        });
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
        const headedIds = accounting ? [] : await getHeadedDepartmentIds(db, a.id);
        if (!accounting && !(emp && (isDeptHead(a, emp) || headedIds.length))) {
            return res.status(403).json({ success: false, error: 'forbidden' });
        }
        let sql = `SELECT v.id, v.employee_id, v.days_count, v.type, v.status,
                          COALESCE(v.reject_reason, '') AS comment,
                          u.full_name, e.department_id,
                          DATE_FORMAT(v.date_from, '%Y-%m-%d') AS date_from,
                          DATE_FORMAT(v.date_to, '%Y-%m-%d') AS date_to
                   FROM ws_vacation_request v
                   JOIN ws_employee e ON e.id=v.employee_id
                   JOIN users u ON u.id=e.user_id WHERE v.status='pending'`;
        const params = [];
        if (!accounting) {
            const ids = headedIds.slice();
            if (emp && emp.department_id && !ids.includes(Number(emp.department_id))) {
                // руководитель согласует по headed; свой отдел без head — только если isDeptHead
                if (isDeptHead(a, emp)) ids.push(Number(emp.department_id));
            }
            if (!ids.length) {
                return res.json({ success: true, rows: [] });
            }
            sql += ` AND e.department_id IN (?)`;
            params.push(ids);
        }
        sql += ' ORDER BY v.date_from';
        const [rows] = await db.query(sql, params);
        res.json({ success: true, rows: (rows || []).map(mapVacationRow) });
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
        await rfCalendar.ensureYearLoaded(db, year);
        const [rows] = await db.query(
            `SELECT DATE_FORMAT(cal_date, '%Y-%m-%d') AS cal_date, is_working_day, norm_hours, holiday_name, transfer_note
             FROM ws_work_calendar WHERE YEAR(cal_date)=? ORDER BY cal_date`,
            [year]
        );
        const coverage = await rfCalendar.yearCoverage(db, year);
        res.json({ success: true, year, coverage, rows });
    });

    router.get('/calendar/month', async (req, res) => {
        const ym = String(req.query.month || calc.moscowYmd().slice(0, 7));
        const map = await rfCalendar.getMonthCalendarMap(db, ym);
        res.json({ success: true, ...map });
    });

    /** Подтянуть производственный календарь РФ (xmlcalendar.ru / бандл) в ws_work_calendar. */
    router.post('/calendar/sync-rf', async (req, res) => {
        if (!isAccounting(actorOf(req))) return res.status(403).json({ success: false, error: 'forbidden' });
        const b = req.body || {};
        const years = Array.isArray(b.years) && b.years.length ? b.years : rfCalendar.DEFAULT_YEARS;
        const results = await rfCalendar.syncYears(db, years, { preferRemote: b.prefer_remote !== false });
        const imported = results.reduce((s, r) => s + (r.imported || 0), 0);
        await writeAudit(db, req, {
            entity_type: 'calendar',
            entity_id: 'sync-rf',
            action: 'sync_rf',
            new_value: JSON.stringify({ years, imported, results }),
        });
        res.json({
            success: results.every((r) => !r.error),
            imported,
            years,
            results,
        });
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
        let sql = `SELECT a.*, u.full_name, u.username,
                          w.work_date AS subject_work_date,
                          COALESCE(w.employee_id, pe.id) AS subject_employee_id,
                          COALESCE(eu.full_name, peu.full_name) AS subject_name,
                          COALESCE(ed.name, ped.name) AS subject_department_name
                   FROM ws_audit_log a
                   LEFT JOIN users u ON u.id=a.user_id
                   LEFT JOIN ws_work_log w
                     ON a.entity_type='work_log' AND a.entity_id REGEXP '^[0-9]+$'
                    AND w.id = CAST(a.entity_id AS UNSIGNED)
                   LEFT JOIN ws_employee e ON e.id = w.employee_id
                   LEFT JOIN users eu ON eu.id = e.user_id
                   LEFT JOIN ws_department ed ON ed.id = e.department_id
                   LEFT JOIN ws_employee pe
                     ON a.entity_type='payroll' AND a.entity_id REGEXP '^[0-9]+:'
                    AND pe.id = CAST(SUBSTRING_INDEX(a.entity_id, ':', 1) AS UNSIGNED)
                   LEFT JOIN users peu ON peu.id = pe.user_id
                   LEFT JOIN ws_department ped ON ped.id = pe.department_id
                   WHERE 1=1`;
        if (req.query.entity_type) {
            sql += ' AND a.entity_type=?';
            params.push(String(req.query.entity_type));
        }
        if (req.query.user_id) {
            sql += ' AND a.user_id=?';
            params.push(Number(req.query.user_id));
        }
        const employeeId = req.query.employee_id ? Number(req.query.employee_id) : 0;
        const employeeQ = String(req.query.employee_q || req.query.employee || '')
            .trim()
            .slice(0, 120);
        if (employeeId > 0) {
            // subject = сотрудник табеля/оклада/премии (не автор правки)
            sql += ` AND (
                w.employee_id = ?
                OR (a.entity_type='payroll' AND (a.entity_id = ? OR a.entity_id LIKE ?))
                OR (a.entity_type='employee' AND a.entity_id = ?)
                OR (a.entity_type='vacation' AND EXISTS (
                    SELECT 1 FROM ws_vacation_request vx WHERE vx.id = CAST(a.entity_id AS UNSIGNED) AND vx.employee_id = ?
                ))
            )`;
            params.push(employeeId, String(employeeId), `${employeeId}:%`, String(employeeId), employeeId);
        } else if (employeeQ) {
            const like = `%${employeeQ.replace(/[%_]/g, '')}%`;
            sql += ` AND (
                eu.full_name LIKE ?
                OR EXISTS (
                    SELECT 1 FROM ws_employee e2
                    JOIN users u2 ON u2.id = e2.user_id
                    WHERE u2.full_name LIKE ?
                      AND (
                        (a.entity_type='payroll' AND (a.entity_id = CAST(e2.id AS CHAR) OR a.entity_id LIKE CONCAT(e2.id, ':%')))
                        OR (a.entity_type='employee' AND a.entity_id = CAST(e2.id AS CHAR))
                        OR (a.entity_type='vacation' AND EXISTS (
                            SELECT 1 FROM ws_vacation_request vx2
                            WHERE vx2.id = CAST(a.entity_id AS UNSIGNED) AND vx2.employee_id = e2.id
                        ))
                      )
                )
            )`;
            params.push(like, like);
        }
        const month = req.query.month ? String(req.query.month) : '';
        if (/^\d{4}-\d{2}$/.test(month)) {
            sql += ` AND (
                DATE_FORMAT(a.created_at, '%Y-%m') = ?
                OR (a.entity_type='work_log' AND a.entity_id = ?)
                OR (a.entity_type='payroll' AND a.entity_id LIKE ?)
                OR (w.work_date IS NOT NULL AND DATE_FORMAT(w.work_date, '%Y-%m') = ?)
            )`;
            params.push(month, month, `%:${month}`, month);
        }
        const scope = String(req.query.scope || '').toLowerCase();
        if (scope === 'edits') {
            sql += ` AND (
                a.action IN (
                    'manual_edit','manual_create','manual_bulk','manual_restore_full_day',
                    'premium_manual_set','premium_manual_clear','premium_from_sales',
                    'premium_from_sales_auto','premium_from_sales_batch',
                    'salary_change','department_move',
                    'approve','reject','create'
                )
                OR a.field_name IN ('salary','premium_manual','department_id')
            )
            AND a.action NOT IN ('import_specialties')
            AND NOT (
                a.action = 'premium_from_sales_auto'
                AND (a.new_value IS NULL OR a.new_value IN ('0','0.0','0.00') OR a.new_value LIKE '{"amount":0%')
            )`;
        }
        sql += ' ORDER BY a.id DESC LIMIT ?';
        params.push(limit);
        const [rows] = await db.query(sql, params);
        res.json({
            success: true,
            month: month || null,
            scope: scope || null,
            employee_id: employeeId || null,
            employee_q: employeeQ || null,
            rows,
        });
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

/**
 * Авто-закрытие открытых смен (тик server.js раз в 15 мин):
 * 1) сменился календарный день Москвы относительно work_date → close в 23:59:59 того дня;
 * 2) иначе открыта ≥ clock_auto_close_hours → close «сейчас».
 * Оба случая: status=needs_confirm, сегмент source day-rollover|auto-close.
 */
async function processStuckShifts(db) {
    await ensureSchema(db);
    const [rows] = await db.query(
        `SELECT w.*, e.id AS emp_id, d.norm_hours, d.rate_full_hours, d.rate_half_hours,
                o.clock_auto_close_hours, e.personal_work_hours_per_day,
                e.personal_rate_full_hours, e.personal_rate_half_hours,
                DATE_FORMAT(w.work_date, '%Y-%m-%d') AS work_ymd,
                DATE_FORMAT(w.check_in, '%Y-%m-%d %H:%i:%s') AS check_in_sql
         FROM ws_work_log w
         JOIN ws_employee e ON e.id=w.employee_id
         JOIN ws_department d ON d.id=e.department_id
         JOIN ws_organization o ON o.id=e.organization_id
         WHERE w.check_in IS NOT NULL AND w.check_out IS NULL`
    );
    const today = calc.moscowYmd();
    const nowMs = Date.now();
    let closed = 0;
    let dayRollover = 0;
    let hoursLimit = 0;
    for (const r of rows) {
        const workYmd = r.work_ymd || calc.toYmd(r.work_date);
        const checkInSql = r.check_in_sql || r.check_in;
        const openMs = nowMs - calc.toEpochMs(checkInSql);
        const openH = openMs / 3600000;
        const limit = Number(r.clock_auto_close_hours) || 14;
        const pastDay = !!(workYmd && /^\d{4}-\d{2}-\d{2}$/.test(workYmd) && workYmd < today);
        const pastHours = Number.isFinite(openH) && openH >= limit;
        if (!pastDay && !pastHours) continue;

        // При смене суток закрываем концом рабочего дня (МСК), не «сейчас» — часы не уезжают на новый день.
        const reason = pastDay ? 'day-rollover' : 'auto-close';
        const outSql = pastDay ? `${workYmd} 23:59:59` : calc.moscowNowSql();
        const packed = calc.appendClosedSegment(r.segments_json, checkInSql, outSql, reason, {
            device_out: 'auto',
        });
        // Если сегмент не добавился (check_in после 23:59:59 и т.п.) — всё равно зафиксируем стоп «сейчас».
        let hours = packed.hours;
        let segmentsJson = JSON.stringify(packed.segments);
        let finalOut = outSql;
        if (!packed.added && pastDay) {
            const fallback = calc.appendClosedSegment(
                r.segments_json,
                checkInSql,
                calc.moscowNowSql(),
                reason,
                { device_out: 'auto' }
            );
            hours = fallback.hours;
            segmentsJson = JSON.stringify(fallback.segments);
            finalOut = calc.moscowNowSql();
        }
        const thr = calc.resolveEmployeeThresholds(r, r);
        const rate = calc.rateFromHours(calc.roundHoursTo5Min(hours), thr);
        const tag = pastDay ? ' day-rollover' : ' auto-close';
        await db.query(
            `UPDATE ws_work_log SET check_out=?, hours_worked=?, rate=?, segments_json=?, status='needs_confirm',
             check_out_device='auto', comment=CONCAT(IFNULL(comment,''), ?)
             WHERE id=? AND check_out IS NULL`,
            [finalOut, hours, rate, segmentsJson, tag, r.id]
        );
        try {
            await recalcPayroll(db, r.employee_id, calc.periodYmFromDate(workYmd || r.work_date));
        } catch (e) {
            /* часы уже зафиксированы */
        }
        closed += 1;
        if (pastDay) dayRollover += 1;
        else hoursLimit += 1;
    }
    return { closed, day_rollover: dayRollover, hours_limit: hoursLimit };
}

module.exports = createWorkScheduleRouter;
module.exports.processStuckShifts = processStuckShifts;
module.exports.ensureWorkScheduleSchema = ensureWorkScheduleSchema;
