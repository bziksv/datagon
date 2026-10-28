'use strict';

/**
 * Премии менеджеров за месяц для табеля / payroll.
 * Начисление (totals.bonus) — % МП. от SUM(diff) всех оплат месяца.
 * К выплате в графике — только доля отгруженных (как «Отгружено» на manager-sales:
 * accrued − unshipped_bonus). Неотгруженные оплаченные — резерв, не в premium_manual.
 */

const {
    pctMpFromMonthTotal,
    DEFAULT_PLAN_AMOUNT,
    parseStoredSteps,
    cloneDefaultSteps,
} = require('./managerSalesCalc');
const { SHIPPED_STATUSES } = require('./opsSheetCalc');

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

function round2(n) {
    return Math.round((Number(n) || 0) * 100) / 100;
}

/**
 * @returns {Promise<Map<number, {
 *   user_id: number,
 *   bonus: number,
 *   bonus_payable: number,
 *   bonus_unshipped: number,
 *   unshipped_count: number,
 *   diff: number,
 *   amount_ex: number,
 *   pct_mp: number
 * }>>}
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
                COALESCE(SUM(diff), 0) AS diff_sum,
                COALESCE(SUM(CASE
                  WHEN status IN (${SHIPPED_STATUSES.map(() => '?').join(',')}) THEN 0
                  WHEN TRIM(COALESCE(status,'')) = 'Возврат средств' THEN 0
                  ELSE diff
                END), 0) AS unshipped_diff,
                COALESCE(SUM(CASE
                  WHEN status IN (${SHIPPED_STATUSES.map(() => '?').join(',')}) THEN 0
                  WHEN TRIM(COALESCE(status,'')) = 'Возврат средств' THEN 0
                  ELSE 1
                END), 0) AS unshipped_count
           FROM dg_manager_sales_rows
          WHERE year = ?
            AND archived_at IS NULL
            AND paid_at IS NOT NULL
            AND paid_at >= ? AND paid_at < ?
          GROUP BY COALESCE(handed_to_user_id, manager_user_id)`,
        [...SHIPPED_STATUSES, ...SHIPPED_STATUSES, y, start, next]
    );

    const [plans] = await db.query(
        `SELECT manager_user_id, year, month, plan_amount, steps_json FROM dg_manager_sales_plans`
    );

    for (const g of agg || []) {
        const mid = Number(g.mid);
        if (!Number.isFinite(mid) || mid < 1) continue;
        const amountEx = Number(g.amount_ex) || 0;
        const diffSum = Number(g.diff_sum) || 0;
        const unshippedDiff = Number(g.unshipped_diff) || 0;
        const unshippedCount = Number(g.unshipped_count) || 0;
        const plan = resolvePlan(plans, mid, y, m);
        const pct = pctMpFromMonthTotal(amountEx, plan.plan_amount, plan.steps);
        const bonus = round2((diffSum / 100) * pct);
        const bonusUnshipped = round2((unshippedDiff / 100) * pct);
        const bonusPayable = round2(Math.max(0, bonus - bonusUnshipped));
        out.set(mid, {
            user_id: mid,
            /** Полное начисление % МП. со всех оплат месяца (как totals.bonus). */
            bonus,
            /** К выплате в табеле: без резерва по неотгруженным. */
            bonus_payable: bonusPayable,
            bonus_unshipped: bonusUnshipped,
            unshipped_count: unshippedCount,
            diff: round2(diffSum),
            amount_ex: round2(amountEx),
            pct_mp: pct,
        });
    }
    return out;
}

/**
 * Построчная расшифровка премии менеджера за месяц (оплаты period).
 * bucket: shipped | waiting | refund
 */
async function fetchManagerBonusOrderDetails(db, managerUserId, year, month) {
    const mid = Number(managerUserId);
    const y = Number(year);
    const m = Number(month);
    const empty = {
        user_id: mid,
        year: y,
        month: m,
        bonus: 0,
        bonus_payable: 0,
        bonus_unshipped: 0,
        unshipped_count: 0,
        pct_mp: 0,
        amount_ex: 0,
        diff: 0,
        orders: [],
    };
    if (!Number.isFinite(mid) || mid < 1 || !Number.isFinite(y) || !Number.isFinite(m) || m < 1 || m > 12) {
        return empty;
    }

    const start = `${y}-${String(m).padStart(2, '0')}-01`;
    const next =
        m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;

    const [plans] = await db.query(
        `SELECT manager_user_id, year, month, plan_amount, steps_json FROM dg_manager_sales_plans`
    );
    const [rows] = await db.query(
        `SELECT id, our_invoice_no, invoice_org, status, diff, amount_ex_delivery,
                DATE_FORMAT(paid_at, '%Y-%m-%d') AS paid_ymd,
                DATE_FORMAT(shipped_at, '%Y-%m-%d') AS shipped_ymd,
                order_url, manager_user_id, handed_to_user_id
           FROM dg_manager_sales_rows
          WHERE year = ?
            AND archived_at IS NULL
            AND paid_at IS NOT NULL
            AND paid_at >= ? AND paid_at < ?
            AND COALESCE(handed_to_user_id, manager_user_id) = ?
          ORDER BY paid_at ASC, id ASC`,
        [y, start, next, mid]
    );

    let amountEx = 0;
    let diffSum = 0;
    for (const r of rows || []) {
        amountEx += Number(r.amount_ex_delivery) || 0;
        diffSum += Number(r.diff) || 0;
    }
    const plan = resolvePlan(plans, mid, y, m);
    const pct = pctMpFromMonthTotal(amountEx, plan.plan_amount, plan.steps);

    const orders = [];
    let unshippedDiff = 0;
    let unshippedCount = 0;
    for (const r of rows || []) {
        const st = String(r.status || '').trim();
        const diff = Number(r.diff) || 0;
        const bonusShare = round2((diff / 100) * pct);
        let bucket = 'waiting';
        if (SHIPPED_STATUSES.includes(st)) bucket = 'shipped';
        else if (st === 'Возврат средств') bucket = 'refund';
        else {
            unshippedDiff += diff;
            unshippedCount += 1;
        }
        const paidYmd = r.paid_ymd || null;
        const shippedYmd = r.shipped_ymd || null;
        /** Для отгруженных без даты — как на manager-sales: fallback на оплату. */
        const shippedEffective =
            bucket === 'shipped' ? shippedYmd || paidYmd : shippedYmd;
        orders.push({
            id: Number(r.id),
            our_invoice_no: r.our_invoice_no || '',
            invoice_org: r.invoice_org || '',
            status: st,
            bucket,
            paid_at: paidYmd,
            shipped_at: shippedYmd,
            shipped_effective: shippedEffective,
            shipped_fallback: bucket === 'shipped' && !shippedYmd && !!paidYmd,
            diff: round2(diff),
            bonus_share: bonusShare,
            order_url: r.order_url || null,
            handed: Number(r.handed_to_user_id) === mid && Number(r.manager_user_id) !== mid,
        });
    }

    const bonus = round2((diffSum / 100) * pct);
    const bonusUnshipped = round2((unshippedDiff / 100) * pct);
    const bonusPayable = round2(Math.max(0, bonus - bonusUnshipped));

    return {
        user_id: mid,
        year: y,
        month: m,
        bonus,
        bonus_payable: bonusPayable,
        bonus_unshipped: bonusUnshipped,
        unshipped_count: unshippedCount,
        pct_mp: pct,
        amount_ex: round2(amountEx),
        diff: round2(diffSum),
        orders,
    };
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
    fetchManagerBonusOrderDetails,
    isSalesDepartmentName,
    resolvePlan,
};
