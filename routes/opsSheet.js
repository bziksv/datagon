'use strict';

const express = require('express');
const {
    toNum,
    round2,
    pctMpFromMonthTotal,
    DEFAULT_PLAN_AMOUNT,
    parseStoredSteps,
    cloneDefaultSteps,
} = require('../lib/managerSalesCalc');
const {
    MONTH_LABELS,
    COLUMN_LEGEND,
    profitBeforeTaxRow,
    buildRow,
    buildTotals,
    emptyManual,
} = require('../lib/opsSheetCalc');

const SALES_SPECIALTY_NAME = 'Менеджер по продажам';
const MIN_YEAR = 2019;
const MAX_YEAR = 2100;

let schemaReady = false;

function currentYear() {
    return new Date().getFullYear();
}

function normYear(v, fallback) {
    const n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    const y = Math.round(n);
    if (y < MIN_YEAR || y > MAX_YEAR) return fallback;
    return y;
}

function normMonth(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return null;
    const m = Math.round(n);
    return m >= 1 && m <= 12 ? m : null;
}

function pageMode(req) {
    const actor = req.datagonActor || {};
    if (actor.username === 'admin') return 'full';
    const raw = actor.page_modes && actor.page_modes['ops-sheet'];
    return raw === 'view' || raw === 'hidden' || raw === 'full' ? raw : 'full';
}

function canWrite(req) {
    return pageMode(req) === 'full';
}

function actorId(req) {
    const id = req.datagonActor && req.datagonActor.id;
    const n = Number(id);
    return Number.isFinite(n) && n > 0 ? n : null;
}

async function ensureSchema(db) {
    if (schemaReady) return;
    await db.query(`
        CREATE TABLE IF NOT EXISTS dg_ops_sheet_manual (
            id BIGINT AUTO_INCREMENT PRIMARY KEY,
            year SMALLINT NOT NULL,
            month TINYINT NOT NULL,
            manager_user_id INT NOT NULL,
            applications_count INT NULL,
            coefficient DECIMAL(12,4) NULL,
            paid_applications INT NULL,
            bonus_past DECIMAL(14,2) NULL,
            salary DECIMAL(14,2) NULL,
            updated_by INT NULL,
            updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            UNIQUE KEY uq_ops_ym_mgr (year, month, manager_user_id),
            KEY idx_ops_year (year)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    schemaReady = true;
}

async function listSalesManagers(db) {
    const [users] = await db.query(
        `SELECT u.id, u.username, u.full_name
           FROM users u
           INNER JOIN specialties s ON s.id = u.specialty_id
          WHERE COALESCE(u.is_archived, 0) = 0
            AND s.name = ?
          ORDER BY COALESCE(NULLIF(u.full_name,''), u.username)`,
        [SALES_SPECIALTY_NAME]
    );
    return (users || []).map((u) => ({
        id: Number(u.id),
        username: u.username || '',
        full_name: u.full_name || u.username || '',
    }));
}

async function loadPlans(db) {
    const [rows] = await db.query(
        `SELECT id, manager_user_id, year, month, plan_amount, note, steps_json
           FROM dg_manager_sales_plans`
    );
    return rows || [];
}

function resolvePlan(plans, managerUserId, year, month) {
    const mid = Number(managerUserId) || 0;
    const y = Number(year) || 0;
    const m = Number(month) || 0;
    const hit = (a, b, c) =>
        (plans || []).find(
            (p) => Number(p.manager_user_id) === a && Number(p.year) === b && Number(p.month) === c
        );
    const monthOwn = m && mid ? hit(mid, y, m) : null;
    const managerYear = mid ? hit(mid, y, 0) : null;
    const yearBase = y ? hit(0, y, 0) : null;
    const fallback = hit(0, 0, 0);
    const row = monthOwn || managerYear || yearBase || fallback;
    const amount = row && row.plan_amount != null ? Number(row.plan_amount) : DEFAULT_PLAN_AMOUNT;
    let steps = null;
    [monthOwn, managerYear, yearBase, fallback].forEach((p) => {
        if (steps) return;
        const parsed = parseStoredSteps(p && p.steps_json);
        if (parsed) steps = parsed;
    });
    if (!steps) steps = cloneDefaultSteps();
    return {
        plan_amount: Number.isFinite(amount) && amount > 0 ? amount : DEFAULT_PLAN_AMOUNT,
        steps,
    };
}

/**
 * Агрегаты по credit-менеджеру и месяцу: turnover, прибыль, число оплаченных продаж.
 * Credit = COALESCE(handed_to_user_id, manager_user_id) — как в manager-sales.
 */
async function fetchMonthAggregates(db, year, managerIds) {
    const out = {};
    const ids = (managerIds || []).map((n) => Number(n)).filter((n) => Number.isFinite(n) && n > 0);
    if (!ids.length) return out;
    const ph = ids.map(() => '?').join(',');
    const [rows] = await db.query(
        `SELECT COALESCE(handed_to_user_id, manager_user_id) AS mid,
                MONTH(paid_at) AS m,
                amount_ex_delivery,
                amount_incl_stock,
                vat,
                delivery_to_us,
                diff
           FROM dg_manager_sales_rows
          WHERE year = ?
            AND archived_at IS NULL
            AND paid_at IS NOT NULL
            AND COALESCE(handed_to_user_id, manager_user_id) IN (${ph})`,
        [year].concat(ids)
    );
    (rows || []).forEach((r) => {
        const mid = Number(r.mid);
        const m = Number(r.m);
        if (!Number.isFinite(mid) || !m || m < 1 || m > 12) return;
        const key = `${mid}:${m}`;
        if (!out[key]) {
            out[key] = { turnover: 0, profit_before_tax: 0, profit_after_tax: 0, paid_applications: 0 };
        }
        const cell = out[key];
        cell.paid_applications += 1;
        cell.turnover += toNum(r.amount_ex_delivery) || 0;
        cell.profit_before_tax += profitBeforeTaxRow(
            r.amount_ex_delivery,
            r.amount_incl_stock,
            r.vat,
            r.delivery_to_us
        );
        cell.profit_after_tax += toNum(r.diff) || 0;
    });
    Object.keys(out).forEach((k) => {
        out[k].turnover = round2(out[k].turnover);
        out[k].profit_before_tax = round2(out[k].profit_before_tax);
        out[k].profit_after_tax = round2(out[k].profit_after_tax);
    });
    return out;
}

async function loadManualMap(db, year) {
    const [rows] = await db.query(
        `SELECT year, month, manager_user_id, applications_count, coefficient,
                bonus_past, salary
           FROM dg_ops_sheet_manual
          WHERE year = ?`,
        [year]
    );
    const map = {};
    (rows || []).forEach((r) => {
        const mid = Number(r.manager_user_id);
        const m = Number(r.month);
        map[`${mid}:${m}`] = {
            applications_count: r.applications_count != null ? Number(r.applications_count) : null,
            coefficient: r.coefficient != null ? Number(r.coefficient) : null,
            bonus_past: r.bonus_past != null ? Number(r.bonus_past) : null,
            salary: r.salary != null ? Number(r.salary) : null,
        };
    });
    return map;
}

function buildYearSnapshot(managers, year, aggregates, plans, manualMap) {
    const months = [];
    for (let month = 1; month <= 12; month += 1) {
        const rows = managers.map((mgr) => {
            const key = `${mgr.id}:${month}`;
            const agg = aggregates[key] || {
                turnover: 0,
                profit_before_tax: 0,
                profit_after_tax: 0,
                paid_applications: 0,
            };
            const plan = resolvePlan(plans, mgr.id, year, month);
            const pctMp = pctMpFromMonthTotal(agg.turnover, plan.plan_amount, plan.steps);
            const bonusCurrent = round2((agg.profit_after_tax / 100) * pctMp);
            const manual = manualMap[key] || emptyManual();
            return buildRow(
                mgr,
                {
                    turnover: agg.turnover,
                    profit_before_tax: agg.profit_before_tax,
                    profit_after_tax: agg.profit_after_tax,
                    bonus_current: bonusCurrent,
                    paid_applications: agg.paid_applications || 0,
                    plan_amount: plan.plan_amount,
                    pct_mp: pctMp,
                },
                manual
            );
        });
        months.push({
            month,
            label: MONTH_LABELS[month],
            rows,
            totals: buildTotals(rows),
        });
    }
    return months;
}

function parseManualBody(body) {
    const out = {};
    if (Object.prototype.hasOwnProperty.call(body, 'applications_count')) {
        const v = body.applications_count;
        if (v === '' || v == null) out.applications_count = null;
        else {
            const n = Number(v);
            if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
                const err = new Error('Кол-во заявок: целое ≥ 0');
                err.status = 400;
                throw err;
            }
            out.applications_count = n;
        }
    }
    if (Object.prototype.hasOwnProperty.call(body, 'coefficient')) {
        const v = body.coefficient;
        if (v === '' || v == null) out.coefficient = null;
        else {
            const n = toNum(v);
            if (n == null) {
                const err = new Error('Коэффициент: число');
                err.status = 400;
                throw err;
            }
            out.coefficient = n;
        }
    }
    if (Object.prototype.hasOwnProperty.call(body, 'bonus_past')) {
        const v = body.bonus_past;
        if (v === '' || v == null) out.bonus_past = null;
        else {
            const n = toNum(v);
            if (n == null) {
                const err = new Error('Премия с прошлыми месяцами: число');
                err.status = 400;
                throw err;
            }
            out.bonus_past = round2(n);
        }
    }
    if (Object.prototype.hasOwnProperty.call(body, 'salary')) {
        const v = body.salary;
        if (v === '' || v == null) out.salary = null;
        else {
            const n = toNum(v);
            if (n == null) {
                const err = new Error('Оклад: число');
                err.status = 400;
                throw err;
            }
            out.salary = round2(n);
        }
    }
    return out;
}

module.exports = function opsSheetRouterFactory(db) {
    const router = express.Router();

    router.get('/meta', async (req, res) => {
        try {
            await ensureSchema(db);
            const cy = currentYear();
            const [yearRows] = await db.query(
                'SELECT DISTINCT year FROM dg_manager_sales_rows ORDER BY year DESC'
            );
            const years = (yearRows || []).map((r) => Number(r.year)).filter((y) => Number.isFinite(y));
            if (!years.includes(cy)) years.unshift(cy);
            const managers = await listSalesManagers(db);
            res.json({
                success: true,
                year: cy,
                years,
                managers,
                can_write: canWrite(req),
                columns: COLUMN_LEGEND,
                formulas: {
                    tax_pct: 16,
                    profit_before_tax: 'SUM(net − delivery), net = F − K − vatAmount',
                    profit_after_tax: 'SUM(diff)',
                    profit_pct: 'profit_after_tax / turnover × 100',
                    bonus_current: 'SUM(diff) × pct_mp / 100',
                    paid_applications: 'COUNT продаж credit-менеджера за месяц (paid_at)',
                    apps_per_sale: 'applications_count / paid_applications',
                    avg_check: 'turnover / paid_applications',
                    fact_profit: 'profit_after_tax − bonus_current − salary',
                    salary_paid: 'salary + bonus_past',
                    company_profit: 'profit_after_tax − salary_paid',
                    company_pct: 'company_profit / turnover × 100',
                },
            });
        } catch (e) {
            console.error('[ops-sheet/meta]', e);
            res.status(500).json({ success: false, error: e.message || 'meta failed' });
        }
    });

    router.get('/', async (req, res) => {
        try {
            await ensureSchema(db);
            const year = normYear(req.query.year, currentYear());
            const managers = await listSalesManagers(db);
            const mids = managers.map((m) => m.id);
            const [aggregates, plans, manualMap] = await Promise.all([
                fetchMonthAggregates(db, year, mids),
                loadPlans(db),
                loadManualMap(db, year),
            ]);
            const months = buildYearSnapshot(managers, year, aggregates, plans, manualMap);
            res.json({
                success: true,
                year,
                managers,
                months,
                can_write: canWrite(req),
            });
        } catch (e) {
            console.error('[ops-sheet/]', e);
            res.status(500).json({ success: false, error: e.message || 'load failed' });
        }
    });

    router.put('/manual', async (req, res) => {
        try {
            await ensureSchema(db);
            if (!canWrite(req)) {
                return res.status(403).json({ success: false, error: 'Недостаточно прав (нужен full)' });
            }
            const body = req.body || {};
            const year = normYear(body.year, null);
            const month = normMonth(body.month);
            const mid = Number(body.manager_user_id);
            if (!year || !month || !Number.isFinite(mid) || mid <= 0) {
                return res.status(400).json({ success: false, error: 'Нужны year, month, manager_user_id' });
            }
            const managers = await listSalesManagers(db);
            const mgr = managers.find((m) => m.id === mid);
            if (!mgr) {
                return res.status(400).json({ success: false, error: 'Менеджер не из группы «Менеджер по продажам»' });
            }
            const patch = parseManualBody(body);
            if (!Object.keys(patch).length) {
                return res.status(400).json({ success: false, error: 'Нет полей для сохранения' });
            }

            const [existingRows] = await db.query(
                `SELECT applications_count, coefficient, bonus_past, salary
                   FROM dg_ops_sheet_manual
                  WHERE year = ? AND month = ? AND manager_user_id = ?
                  LIMIT 1`,
                [year, month, mid]
            );
            const prev = existingRows && existingRows[0] ? existingRows[0] : {};
            const next = {
                applications_count:
                    patch.applications_count !== undefined
                        ? patch.applications_count
                        : prev.applications_count != null
                          ? Number(prev.applications_count)
                          : null,
                coefficient:
                    patch.coefficient !== undefined
                        ? patch.coefficient
                        : prev.coefficient != null
                          ? Number(prev.coefficient)
                          : null,
                bonus_past:
                    patch.bonus_past !== undefined
                        ? patch.bonus_past
                        : prev.bonus_past != null
                          ? Number(prev.bonus_past)
                          : null,
                salary:
                    patch.salary !== undefined
                        ? patch.salary
                        : prev.salary != null
                          ? Number(prev.salary)
                          : null,
            };

            const actor = actorId(req);
            await db.query(
                `INSERT INTO dg_ops_sheet_manual
                    (year, month, manager_user_id, applications_count, coefficient,
                     bonus_past, salary, updated_by)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE
                    applications_count = VALUES(applications_count),
                    coefficient = VALUES(coefficient),
                    bonus_past = VALUES(bonus_past),
                    salary = VALUES(salary),
                    updated_by = VALUES(updated_by)`,
                [
                    year,
                    month,
                    mid,
                    next.applications_count,
                    next.coefficient,
                    next.bonus_past,
                    next.salary,
                    actor,
                ]
            );

            const aggregates = await fetchMonthAggregates(db, year, [mid]);
            const plans = await loadPlans(db);
            const key = `${mid}:${month}`;
            const agg = aggregates[key] || {
                turnover: 0,
                profit_before_tax: 0,
                profit_after_tax: 0,
                paid_applications: 0,
            };
            const plan = resolvePlan(plans, mid, year, month);
            const pctMp = pctMpFromMonthTotal(agg.turnover, plan.plan_amount, plan.steps);
            const bonusCurrent = round2((agg.profit_after_tax / 100) * pctMp);
            const row = buildRow(
                mgr,
                {
                    turnover: agg.turnover,
                    profit_before_tax: agg.profit_before_tax,
                    profit_after_tax: agg.profit_after_tax,
                    bonus_current: bonusCurrent,
                    paid_applications: agg.paid_applications || 0,
                    plan_amount: plan.plan_amount,
                    pct_mp: pctMp,
                },
                next
            );

            const allManagers = await listSalesManagers(db);
            const allMids = allManagers.map((m) => m.id);
            const [allAgg, manualMap] = await Promise.all([
                fetchMonthAggregates(db, year, allMids),
                loadManualMap(db, year),
            ]);
            const monthRows = allManagers.map((m) => {
                const k = `${m.id}:${month}`;
                const a = allAgg[k] || {
                    turnover: 0,
                    profit_before_tax: 0,
                    profit_after_tax: 0,
                    paid_applications: 0,
                };
                const p = resolvePlan(plans, m.id, year, month);
                const pct = pctMpFromMonthTotal(a.turnover, p.plan_amount, p.steps);
                const bon = round2((a.profit_after_tax / 100) * pct);
                const man = m.id === mid ? next : manualMap[k] || emptyManual();
                return buildRow(
                    m,
                    {
                        turnover: a.turnover,
                        profit_before_tax: a.profit_before_tax,
                        profit_after_tax: a.profit_after_tax,
                        bonus_current: bon,
                        paid_applications: a.paid_applications || 0,
                        plan_amount: p.plan_amount,
                        pct_mp: pct,
                    },
                    man
                );
            });

            res.json({
                success: true,
                year,
                month,
                row,
                totals: buildTotals(monthRows),
            });
        } catch (e) {
            const status = e.status || 500;
            if (status >= 500) console.error('[ops-sheet/manual]', e);
            res.status(status).json({ success: false, error: e.message || 'save failed' });
        }
    });

    return router;
};
