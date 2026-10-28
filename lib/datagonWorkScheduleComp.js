'use strict';

/**
 * Периоды оплаты сотрудника (оклад / ₽/ч + правило премии) с датами «с–по».
 * Расчёт ФОТ обязан брать условия на дату дня, а не только текущие поля ws_employee.
 */

const calc = require('./datagonWorkScheduleCalc');

function toYmd(v) {
    return calc.toYmd(v);
}

function addDaysYmd(ymd, delta) {
    return calc.addDaysYmd(ymd, delta);
}

function normalizeRow(r) {
    if (!r) return null;
    return {
        id: Number(r.id) || 0,
        employee_id: Number(r.employee_id) || 0,
        date_from: toYmd(r.date_from),
        date_to: r.date_to != null && String(r.date_to) !== '' ? toYmd(r.date_to) : null,
        pay_type: calc.normalizePayType(r.pay_type),
        salary: Number(r.salary) || 0,
        premium_rule_json: r.premium_rule_json != null ? r.premium_rule_json : null,
        note: r.note != null ? String(r.note) : null,
        created_by: r.created_by != null ? Number(r.created_by) : null,
        created_at: r.created_at || null,
    };
}

/** Период покрывает день: date_from <= ymd <= date_to (date_to NULL = ∞). */
function coversYmd(row, ymd) {
    if (!row || !ymd) return false;
    const from = toYmd(row.date_from);
    const to = row.date_to != null ? toYmd(row.date_to) : null;
    if (!from || ymd < from) return false;
    if (to && ymd > to) return false;
    return true;
}

function pickCompOnDate(rows, ymd, fallback) {
    const list = Array.isArray(rows) ? rows : [];
    const hit = list.find((r) => coversYmd(r, ymd));
    if (hit) return hit;
    if (fallback) {
        return {
            id: 0,
            employee_id: Number(fallback.id) || 0,
            date_from: ymd,
            date_to: null,
            pay_type: calc.normalizePayType(fallback.pay_type),
            salary: Number(fallback.salary) || 0,
            premium_rule_json: fallback.personal_premium_rule_json != null
                ? fallback.personal_premium_rule_json
                : null,
            note: null,
            _fallback: true,
        };
    }
    return null;
}

async function listCompensation(db, employeeId) {
    const [rows] = await db.query(
        `SELECT id, employee_id,
                DATE_FORMAT(date_from, '%Y-%m-%d') AS date_from,
                DATE_FORMAT(date_to, '%Y-%m-%d') AS date_to,
                pay_type, salary, premium_rule_json, note, created_by, created_at
         FROM ws_employee_comp
         WHERE employee_id=?
         ORDER BY date_from DESC, id DESC`,
        [employeeId]
    );
    return (rows || []).map(normalizeRow);
}

async function loadCompensationOverlapping(db, employeeId, fromYmd, toYmd) {
    const [rows] = await db.query(
        `SELECT id, employee_id,
                DATE_FORMAT(date_from, '%Y-%m-%d') AS date_from,
                DATE_FORMAT(date_to, '%Y-%m-%d') AS date_to,
                pay_type, salary, premium_rule_json, note, created_by, created_at
         FROM ws_employee_comp
         WHERE employee_id=?
           AND date_from <= ?
           AND (date_to IS NULL OR date_to >= ?)
         ORDER BY date_from ASC, id ASC`,
        [employeeId, toYmd, fromYmd]
    );
    return (rows || []).map(normalizeRow);
}

function rangesOverlap(aFrom, aTo, bFrom, bTo) {
    const aEnd = aTo || '9999-12-31';
    const bEnd = bTo || '9999-12-31';
    return aFrom <= bEnd && bFrom <= aEnd;
}

async function assertNoOverlap(db, employeeId, dateFrom, dateTo, excludeId) {
    const rows = await listCompensation(db, employeeId);
    for (const r of rows) {
        if (excludeId && Number(r.id) === Number(excludeId)) continue;
        if (rangesOverlap(dateFrom, dateTo, r.date_from, r.date_to)) {
            const err = new Error(
                `Пересечение с периодом ${r.date_from}…${r.date_to || '∞'} (id ${r.id})`
            );
            err.status = 409;
            throw err;
        }
    }
}

function premiumRuleToSql(raw) {
    if (raw === undefined) return undefined;
    if (raw == null || raw === '') return null;
    if (typeof raw === 'string') {
        const t = raw.trim();
        if (!t || t === 'null') return null;
        return t;
    }
    try {
        return JSON.stringify(raw);
    } catch (e) {
        return null;
    }
}

/**
 * Закрыть открытые/перекрывающие периоды днём до dateFrom, затем вставить новый.
 * Оклад + тип + правило премии — всё в периоде (нельзя оставлять премию «только на карточке»).
 *
 * Важно:
 * - будущие периоды (date_from > dateFrom) НЕ удаляем — иначе «Сохранить» карточку
 *   с сегодняшней датой сносит запланированное повышение с 1-го числа;
 * - ws_employee.salary/pay_type синхронизируем с периодом на «сегодня», а не с новым
 *   будущим периодом (иначе карточка на миг становится 50к, а повторный Save с формой 40к
 *   выглядит как salary_change и снова ломает периоды).
 */
async function applyCompensationChange(db, opts) {
    const employeeId = Number(opts.employeeId);
    const dateFrom = toYmd(opts.date_from);
    if (!employeeId || !dateFrom) {
        const err = new Error('employeeId and date_from required');
        err.status = 400;
        throw err;
    }
    const payType = calc.normalizePayType(opts.pay_type);
    const salary = Number(opts.salary) || 0;
    const premiumRule =
        opts.premium_rule_json === undefined ? null : opts.premium_rule_json;
    const premiumSql = premiumRuleToSql(premiumRule);
    const note = opts.note != null ? String(opts.note).slice(0, 255) : null;
    const actorId = opts.actorId != null ? Number(opts.actorId) : null;

    // В периоды без снимка премии записать ПРЕЖНЕЕ правило, иначе после смены
    // карточки старые дни подтянут уже новое personal_premium_rule_json.
    if (opts.previous_premium_rule_json !== undefined) {
        const prevSql = premiumRuleToSql(opts.previous_premium_rule_json);
        await db.query(
            `UPDATE ws_employee_comp
             SET premium_rule_json = ?
             WHERE employee_id=?
               AND premium_rule_json IS NULL
               AND date_from < ?
               AND (date_to IS NULL OR date_to >= ?)`,
            [prevSql, employeeId, dateFrom, dateFrom]
        );
    }

    const dayBefore = addDaysYmd(dateFrom, -1);
    await db.query(
        `UPDATE ws_employee_comp
         SET date_to = ?
         WHERE employee_id=?
           AND date_from < ?
           AND (date_to IS NULL OR date_to >= ?)`,
        [dayBefore, employeeId, dateFrom, dateFrom]
    );
    // Замена только периода, начавшегося в тот же день. Более поздние планы сохраняем.
    await db.query(`DELETE FROM ws_employee_comp WHERE employee_id=? AND date_from = ?`, [
        employeeId,
        dateFrom,
    ]);

    // Новый период до дня перед следующим будущим (если есть).
    const [nextRows] = await db.query(
        `SELECT DATE_FORMAT(date_from, '%Y-%m-%d') AS date_from
         FROM ws_employee_comp
         WHERE employee_id=? AND date_from > ?
         ORDER BY date_from ASC, id ASC
         LIMIT 1`,
        [employeeId, dateFrom]
    );
    const nextFrom = nextRows[0] && nextRows[0].date_from ? toYmd(nextRows[0].date_from) : null;
    const dateTo = nextFrom ? addDaysYmd(nextFrom, -1) : null;
    if (dateTo && dateTo < dateFrom) {
        const err = new Error(
            `Нельзя вставить период с ${dateFrom}: следующий период начинается ${nextFrom}`
        );
        err.status = 409;
        throw err;
    }

    const [ins] = await db.query(
        `INSERT INTO ws_employee_comp
         (employee_id, date_from, date_to, pay_type, salary, premium_rule_json, note, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [employeeId, dateFrom, dateTo, payType, salary, premiumSql, note, actorId]
    );

    await syncEmployeeCurrentFromComp(db, employeeId);

    return {
        id: ins.insertId,
        date_from: dateFrom,
        date_to: dateTo,
        pay_type: payType,
        salary,
        premium_rule_json: premiumRule,
    };
}

async function insertCompensation(db, opts) {
    const employeeId = Number(opts.employeeId);
    const dateFrom = toYmd(opts.date_from);
    const dateTo = opts.date_to != null && opts.date_to !== '' ? toYmd(opts.date_to) : null;
    if (!employeeId || !dateFrom) {
        const err = new Error('employeeId and date_from required');
        err.status = 400;
        throw err;
    }
    if (dateTo && dateTo < dateFrom) {
        const err = new Error('date_to earlier than date_from');
        err.status = 400;
        throw err;
    }
    await assertNoOverlap(db, employeeId, dateFrom, dateTo, null);
    const payType = calc.normalizePayType(opts.pay_type);
    const salary = Number(opts.salary) || 0;
    const premiumRule = opts.premium_rule_json !== undefined ? opts.premium_rule_json : null;
    const [ins] = await db.query(
        `INSERT INTO ws_employee_comp
         (employee_id, date_from, date_to, pay_type, salary, premium_rule_json, note, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            employeeId,
            dateFrom,
            dateTo,
            payType,
            salary,
            premiumRule != null ? JSON.stringify(premiumRule) : null,
            opts.note != null ? String(opts.note).slice(0, 255) : null,
            opts.actorId != null ? Number(opts.actorId) : null,
        ]
    );
    await syncEmployeeCurrentFromComp(db, employeeId);
    return ins.insertId;
}

async function updateCompensation(db, id, opts) {
    const cid = Number(id);
    const [ex] = await db.query(`SELECT * FROM ws_employee_comp WHERE id=? LIMIT 1`, [cid]);
    if (!ex.length) {
        const err = new Error('not found');
        err.status = 404;
        throw err;
    }
    const row = ex[0];
    const employeeId = Number(row.employee_id);
    const dateFrom = opts.date_from != null ? toYmd(opts.date_from) : toYmd(row.date_from);
    const dateTo =
        opts.date_to !== undefined
            ? opts.date_to == null || opts.date_to === ''
                ? null
                : toYmd(opts.date_to)
            : row.date_to != null
              ? toYmd(row.date_to)
              : null;
    if (dateTo && dateTo < dateFrom) {
        const err = new Error('date_to earlier than date_from');
        err.status = 400;
        throw err;
    }
    await assertNoOverlap(db, employeeId, dateFrom, dateTo, cid);
    const payType =
        opts.pay_type != null ? calc.normalizePayType(opts.pay_type) : calc.normalizePayType(row.pay_type);
    const salary = opts.salary != null ? Number(opts.salary) || 0 : Number(row.salary) || 0;
    let premiumRule = row.premium_rule_json;
    if (opts.premium_rule_json !== undefined) premiumRule = opts.premium_rule_json;
    const note = opts.note !== undefined ? (opts.note != null ? String(opts.note).slice(0, 255) : null) : row.note;
    await db.query(
        `UPDATE ws_employee_comp
         SET date_from=?, date_to=?, pay_type=?, salary=?, premium_rule_json=?, note=?
         WHERE id=?`,
        [
            dateFrom,
            dateTo,
            payType,
            salary,
            premiumRule != null ? JSON.stringify(premiumRule) : null,
            note,
            cid,
        ]
    );
    await syncEmployeeCurrentFromComp(db, employeeId);
    return cid;
}

async function deleteCompensation(db, id) {
    const cid = Number(id);
    const [ex] = await db.query(`SELECT employee_id FROM ws_employee_comp WHERE id=? LIMIT 1`, [cid]);
    if (!ex.length) {
        const err = new Error('not found');
        err.status = 404;
        throw err;
    }
    const employeeId = Number(ex[0].employee_id);
    const [cnt] = await db.query(
        `SELECT COUNT(*) AS c FROM ws_employee_comp WHERE employee_id=?`,
        [employeeId]
    );
    if (Number(cnt[0].c) <= 1) {
        const err = new Error('Нельзя удалить единственный период оплаты');
        err.status = 400;
        throw err;
    }
    await db.query(`DELETE FROM ws_employee_comp WHERE id=?`, [cid]);
    await syncEmployeeCurrentFromComp(db, employeeId);
    return employeeId;
}

/** Синхронизировать ws_employee.salary/pay_type с периодом на «сегодня» (не с будущим). */
async function syncEmployeeCurrentFromComp(db, employeeId) {
    const today = calc.moscowYmd();
    const rows = await listCompensation(db, employeeId);
    const cur = pickCompOnDate(rows, today, null);
    if (!cur) {
        // Нет периода на сегодня — не подставляем будущий оклад в карточку.
        return;
    }
    const premSql =
        cur.premium_rule_json == null
            ? null
            : typeof cur.premium_rule_json === 'string'
              ? cur.premium_rule_json
              : JSON.stringify(cur.premium_rule_json);
    await db.query(
        `UPDATE ws_employee SET salary=?, pay_type=?, personal_premium_rule_json=? WHERE id=?`,
        [Number(cur.salary) || 0, calc.normalizePayType(cur.pay_type), premSql, employeeId]
    );
}

/**
 * Правило премии на день из периода.
 * Реальный период: только его premium_rule_json (null → из отдела, без текущей карточки).
 * Fallback без периода: личное с карточки → отдел.
 */
function effectivePremiumRule(comp, emp, dept) {
    const fallback = emp || {};
    if (!comp || comp._fallback) {
        return calc.resolvePremiumRule(
            {
                personal_premium_rule_json:
                    comp && comp.premium_rule_json != null
                        ? comp.premium_rule_json
                        : fallback.personal_premium_rule_json,
            },
            dept
        );
    }
    if (comp.premium_rule_json != null && comp.premium_rule_json !== '') {
        return calc.parsePremiumRule(comp.premium_rule_json);
    }
    return calc.resolvePremiumRule({ personal_premium_rule_json: null }, dept);
}

/**
 * База + премия по правилам периодов за месяц.
 * logs: { work_ymd|work_date, type, rate, hours_worked, hours_bitcop }
 * emp/dept — fallback и стаж/правила отдела.
 */
function computePayFromLogs(logs, comps, emp, dept, normDays) {
    const fallback = emp || {};
    const norm = Number(normDays) || 0;
    let base = 0;
    let workedUnits = 0;
    let hoursWorked = 0;
    let premiumAccrued = 0;
    let sawFixedFull = null;

    for (const L of logs || []) {
        const ymd = toYmd(L.work_ymd || L.work_date);
        if (!ymd) continue;
        const c = pickCompOnDate(comps, ymd, fallback);
        const payType = calc.normalizePayType(c && c.pay_type);
        const salary = Number(c && c.salary) || 0;
        const effectiveRule = effectivePremiumRule(c, fallback, dept);

        // Оклад/часы — только type=work. Отпуск / больничный / отгул / командировка
        // в пропорцию оклада не входят (отдельные статьи vacation_pay / sick_pay / …).
        if (L.type !== 'work') continue;

        const clockH = Number(L.hours_worked) || 0;
        const bitH = Number(L.hours_bitcop) || 0;
        // «По часам (Bitcop)»: ставка × продуктивные часы Bitcop, таймер и ручные 8:00 не подменяют их.
        const h = payType === 'hourly' ? bitH : clockH > 0 ? clockH : bitH;
        if (payType === 'hourly') {
            hoursWorked += h;
            base += h * salary;
            // Ставок смен нет: день с часами Bitcop = 1 для стажа и премии «фикс по дням».
            if (h > 0) {
                workedUnits += 1;
                if (norm > 0 && effectiveRule.kind === 'fixed') {
                    premiumAccrued += (Number(effectiveRule.amount) || 0) / norm;
                }
            }
        } else {
            const units = Number(L.rate) || 0;
            workedUnits += units;
            if (norm > 0 && units > 0) {
                base += (salary / norm) * units;
                if (effectiveRule.kind === 'fixed') {
                    premiumAccrued += ((Number(effectiveRule.amount) || 0) / norm) * units;
                }
            }
        }

        if (effectiveRule.kind === 'fixed_full' && sawFixedFull == null) {
            sawFixedFull = Number(effectiveRule.amount) || 0;
        }
    }

    if (sawFixedFull != null) {
        premiumAccrued = sawFixedFull;
    }

    hoursWorked = Math.round(hoursWorked * 100) / 100;
    base = Math.round(base * 100) / 100;
    premiumAccrued = Math.round(premiumAccrued * 100) / 100;

    return {
        base,
        worked_days: Math.round(workedUnits * 100) / 100,
        hours_worked: hoursWorked,
        premium_from_rule: premiumAccrued,
    };
}

async function seedCompensationFromEmployees(db) {
    await db.query(
        `INSERT INTO ws_employee_comp
         (employee_id, date_from, date_to, pay_type, salary, premium_rule_json, note)
         SELECT e.id,
                COALESCE(e.hire_date, '2020-01-01'),
                NULL,
                COALESCE(NULLIF(e.pay_type, ''), 'salary'),
                COALESCE(e.salary, 0),
                e.personal_premium_rule_json,
                'seed from card'
         FROM ws_employee e
         WHERE NOT EXISTS (
           SELECT 1 FROM ws_employee_comp c WHERE c.employee_id = e.id
         )`
    );
}

module.exports = {
    coversYmd,
    pickCompOnDate,
    listCompensation,
    loadCompensationOverlapping,
    applyCompensationChange,
    insertCompensation,
    updateCompensation,
    deleteCompensation,
    syncEmployeeCurrentFromComp,
    computePayFromLogs,
    seedCompensationFromEmployees,
    normalizeRow,
};
