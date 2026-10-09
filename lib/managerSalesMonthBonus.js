'use strict';

/**
 * Премии менеджеров за месяц — та же логика, что totals.bonus в GET /api/manager-sales.
 * credit = COALESCE(handed_to_user_id, manager_user_id); % МП. от суммы F и плана.
 */

const {
    pctMpFromMonthTotal,
    DEFAULT_PLAN_AMOUNT,
    parseStoredSteps,
    cloneDefaultSteps,
} = require('./managerSalesCalc');

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
 * @returns {Promise<Map<number, { user_id: number, bonus: number, diff: number, amount_ex: number, pct_mp: number }>>}
 */
async function fetchManagerBonusesForMonth(db, year, month) {
    const y = Number(year);
    const m = Number(month);
    const out = new Map();
    if (!Number.isFinite(y) || !Number.isFinite(m) || m < 1 || m > 12) return out;

    const start = `${y}-${String(m).padStart(2, '0')}-01`;
    const next =
        m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;

    const [agg] = await db.query(
        `SELECT COALESCE(handed_to_user_id, manager_user_id) AS mid,
                COALESCE(SUM(amount_ex_delivery), 0) AS amount_ex,
                COALESCE(SUM(diff), 0) AS diff_sum
           FROM dg_manager_sales_rows
          WHERE year = ?
            AND archived_at IS NULL
            AND paid_at IS NOT NULL
            AND paid_at >= ? AND paid_at < ?
          GROUP BY COALESCE(handed_to_user_id, manager_user_id)`,
        [y, start, next]
    );

    const [plans] = await db.query(
        `SELECT manager_user_id, year, month, plan_amount, steps_json FROM dg_manager_sales_plans`
    );

    for (const g of agg || []) {
        const mid = Number(g.mid);
        if (!Number.isFinite(mid) || mid < 1) continue;
        const amountEx = Number(g.amount_ex) || 0;
        const diffSum = Number(g.diff_sum) || 0;
        const plan = resolvePlan(plans, mid, y, m);
        const pct = pctMpFromMonthTotal(amountEx, plan.plan_amount, plan.steps);
        const bonus = Math.round(((diffSum / 100) * pct) * 100) / 100;
        out.set(mid, {
            user_id: mid,
            bonus,
            diff: Math.round(diffSum * 100) / 100,
            amount_ex: Math.round(amountEx * 100) / 100,
            pct_mp: pct,
        });
    }
    return out;
}

/** Отделы продаж в ws_department (имя). */
function isSalesDepartmentName(name) {
    const s = String(name || '')
        .toLowerCase()
        .replace(/ё/g, 'е');
    return s.includes('продаж');
}

module.exports = {
    fetchManagerBonusesForMonth,
    isSalesDepartmentName,
    resolvePlan,
};
