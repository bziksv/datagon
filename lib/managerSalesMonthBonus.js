'use strict';

/**
 * Премии менеджеров за месяц для табеля / payroll.
 *
 * Начисление (bonus) — % МП. от SUM(diff) всех оплат месяца (paid_at в периоде).
 * К выплате (bonus_payable) — только заказы с датой отгрузки в периоде:
 *   COALESCE(shipped_at, paid_at) ∈ месяц (статус Отгружен / Частично отгружен),
 *   в т.ч. оплата в прошлых месяцах («плавающие», как bonus_past на manager-sales).
 * Оплата в месяце, а отгрузка позже — резерв (waiting), не в premium_manual этого месяца.
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

function monthBounds(year, month) {
    const y = Number(year);
    const m = Number(month);
    const start = `${y}-${String(m).padStart(2, '0')}-01`;
    const next =
        m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
    return { start, next };
}

function isShippedStatus(st) {
    return SHIPPED_STATUSES.includes(String(st || '').trim());
}

/** Дата отгрузки для расчёта: shipped_at, иначе у отгруженных — paid_at. */
function shippedEffectiveYmd(status, shippedYmd, paidYmd) {
    if (!isShippedStatus(status)) return null;
    return shippedYmd || paidYmd || null;
}

function ymdInMonth(ymd, start, next) {
    return !!(ymd && ymd >= start && ymd < next);
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

    const { start, next } = monthBounds(y, m);
    const statusPh = SHIPPED_STATUSES.map(() => '?').join(',');

    const [plans] = await db.query(
        `SELECT manager_user_id, year, month, plan_amount, steps_json FROM dg_manager_sales_plans`
    );

    /** Оплаты месяца → начисление + резерв (отгрузка не в этом месяце). */
    const [paidAgg] = await db.query(
        `SELECT COALESCE(handed_to_user_id, manager_user_id) AS mid,
                COALESCE(SUM(amount_ex_delivery), 0) AS amount_ex,
                COALESCE(SUM(diff), 0) AS diff_sum,
                COALESCE(SUM(CASE
                  WHEN TRIM(COALESCE(status,'')) = 'Возврат средств' THEN 0
                  WHEN status IN (${statusPh})
                       AND COALESCE(shipped_at, paid_at) >= ?
                       AND COALESCE(shipped_at, paid_at) < ?
                    THEN 0
                  ELSE diff
                END), 0) AS waiting_diff,
                COALESCE(SUM(CASE
                  WHEN TRIM(COALESCE(status,'')) = 'Возврат средств' THEN 0
                  WHEN status IN (${statusPh})
                       AND COALESCE(shipped_at, paid_at) >= ?
                       AND COALESCE(shipped_at, paid_at) < ?
                    THEN 0
                  ELSE 1
                END), 0) AS waiting_count,
                COALESCE(SUM(CASE
                  WHEN status IN (${statusPh})
                       AND COALESCE(shipped_at, paid_at) >= ?
                       AND COALESCE(shipped_at, paid_at) < ?
                    THEN diff
                  ELSE 0
                END), 0) AS shipped_same_month_diff
           FROM dg_manager_sales_rows
          WHERE year = ?
            AND archived_at IS NULL
            AND paid_at IS NOT NULL
            AND paid_at >= ? AND paid_at < ?
          GROUP BY COALESCE(handed_to_user_id, manager_user_id)`,
        [
            ...SHIPPED_STATUSES,
            start,
            next,
            ...SHIPPED_STATUSES,
            start,
            next,
            ...SHIPPED_STATUSES,
            start,
            next,
            y,
            start,
            next,
        ]
    );

    /**
     * Отгрузки месяца по оплатам прошлых периодов → к выплате (как bonus_past).
     * Берём сохранённый row.bonus; если пусто — (diff/100)*pct плана месяца оплаты.
     */
    const [pastShipRows] = await db.query(
        `SELECT COALESCE(handed_to_user_id, manager_user_id) AS mid,
                YEAR(paid_at) AS py,
                MONTH(paid_at) AS pm,
                diff,
                bonus,
                amount_ex_delivery
           FROM dg_manager_sales_rows
          WHERE archived_at IS NULL
            AND paid_at IS NOT NULL
            AND paid_at < ?
            AND status IN (${statusPh})
            AND COALESCE(shipped_at, paid_at) >= ?
            AND COALESCE(shipped_at, paid_at) < ?`,
        [start, ...SHIPPED_STATUSES, start, next]
    );

    /** amount_ex оплат месяца оплаты — для pct плавающих (кэш по mid:py:pm). */
    const pastPctCache = new Map();
    async function pctForPaidMonth(mid, py, pm) {
        const key = `${mid}:${py}:${pm}`;
        if (pastPctCache.has(key)) return pastPctCache.get(key);
        const pb = monthBounds(py, pm);
        const [agg] = await db.query(
            `SELECT COALESCE(SUM(amount_ex_delivery), 0) AS amount_ex
               FROM dg_manager_sales_rows
              WHERE year = ?
                AND archived_at IS NULL
                AND paid_at IS NOT NULL
                AND paid_at >= ? AND paid_at < ?
                AND COALESCE(handed_to_user_id, manager_user_id) = ?`,
            [py, pb.start, pb.next, mid]
        );
        const amountEx = Number(agg && agg[0] && agg[0].amount_ex) || 0;
        const plan = resolvePlan(plans, mid, py, pm);
        const pct = pctMpFromMonthTotal(amountEx, plan.plan_amount, plan.steps);
        pastPctCache.set(key, pct);
        return pct;
    }

    const pastPayableByMid = new Map();
    for (const r of pastShipRows || []) {
        const mid = Number(r.mid);
        if (!Number.isFinite(mid) || mid < 1) continue;
        let share = r.bonus != null && Number.isFinite(Number(r.bonus)) ? Number(r.bonus) : null;
        if (share == null) {
            const py = Number(r.py);
            const pm = Number(r.pm);
            // eslint-disable-next-line no-await-in-loop
            const pct = await pctForPaidMonth(mid, py, pm);
            share = round2(((Number(r.diff) || 0) / 100) * pct);
        } else {
            share = round2(share);
        }
        pastPayableByMid.set(mid, round2((pastPayableByMid.get(mid) || 0) + share));
    }

    const paidByMid = new Map();
    for (const g of paidAgg || []) {
        const mid = Number(g.mid);
        if (Number.isFinite(mid) && mid > 0) paidByMid.set(mid, g);
    }
    const mids = new Set([...paidByMid.keys(), ...pastPayableByMid.keys()]);

    for (const mid of mids) {
        const g = paidByMid.get(mid) || {
            amount_ex: 0,
            diff_sum: 0,
            waiting_diff: 0,
            waiting_count: 0,
            shipped_same_month_diff: 0,
        };
        const amountEx = Number(g.amount_ex) || 0;
        const diffSum = Number(g.diff_sum) || 0;
        const waitingDiff = Number(g.waiting_diff) || 0;
        const waitingCount = Number(g.waiting_count) || 0;
        const shippedSameDiff = Number(g.shipped_same_month_diff) || 0;
        const plan = resolvePlan(plans, mid, y, m);
        const pct = pctMpFromMonthTotal(amountEx, plan.plan_amount, plan.steps);
        const bonus = round2((diffSum / 100) * pct);
        const bonusUnshipped = round2((waitingDiff / 100) * pct);
        const payableSame = round2((shippedSameDiff / 100) * pct);
        const payablePast = pastPayableByMid.get(mid) || 0;
        const bonusPayable = round2(Math.max(0, payableSame + payablePast));
        out.set(mid, {
            user_id: mid,
            bonus,
            bonus_payable: bonusPayable,
            bonus_unshipped: bonusUnshipped,
            unshipped_count: waitingCount,
            diff: round2(diffSum),
            amount_ex: round2(amountEx),
            pct_mp: pct,
        });
    }
    return out;
}

/**
 * Построчная расшифровка премии менеджера за месяц.
 * bucket: shipped | waiting | refund
 * paid_prior: оплата раньше периода, отгрузка в периоде → к выплате сейчас.
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

    const { start, next } = monthBounds(y, m);
    const statusPh = SHIPPED_STATUSES.map(() => '?').join(',');

    const [plans] = await db.query(
        `SELECT manager_user_id, year, month, plan_amount, steps_json FROM dg_manager_sales_plans`
    );

    const [paidRows] = await db.query(
        `SELECT id, our_invoice_no, invoice_org, status, diff, amount_ex_delivery, bonus,
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

    const [pastShipRows] = await db.query(
        `SELECT id, our_invoice_no, invoice_org, status, diff, amount_ex_delivery, bonus,
                DATE_FORMAT(paid_at, '%Y-%m-%d') AS paid_ymd,
                DATE_FORMAT(shipped_at, '%Y-%m-%d') AS shipped_ymd,
                YEAR(paid_at) AS py, MONTH(paid_at) AS pm,
                order_url, manager_user_id, handed_to_user_id
           FROM dg_manager_sales_rows
          WHERE archived_at IS NULL
            AND paid_at IS NOT NULL
            AND paid_at < ?
            AND status IN (${statusPh})
            AND COALESCE(shipped_at, paid_at) >= ?
            AND COALESCE(shipped_at, paid_at) < ?
            AND COALESCE(handed_to_user_id, manager_user_id) = ?
          ORDER BY COALESCE(shipped_at, paid_at) ASC, id ASC`,
        [start, ...SHIPPED_STATUSES, start, next, mid]
    );

    let amountEx = 0;
    let diffSum = 0;
    for (const r of paidRows || []) {
        amountEx += Number(r.amount_ex_delivery) || 0;
        diffSum += Number(r.diff) || 0;
    }
    const plan = resolvePlan(plans, mid, y, m);
    const pct = pctMpFromMonthTotal(amountEx, plan.plan_amount, plan.steps);

    const orders = [];
    let waitingDiff = 0;
    let waitingCount = 0;
    let payableDiffSame = 0;
    let payablePast = 0;

    for (const r of paidRows || []) {
        const st = String(r.status || '').trim();
        const diff = Number(r.diff) || 0;
        const bonusShare = round2((diff / 100) * pct);
        const paidYmd = r.paid_ymd || null;
        const shippedYmd = r.shipped_ymd || null;
        const shipEff = shippedEffectiveYmd(st, shippedYmd, paidYmd);
        let bucket = 'waiting';
        if (st === 'Возврат средств') {
            bucket = 'refund';
        } else if (isShippedStatus(st) && ymdInMonth(shipEff, start, next)) {
            bucket = 'shipped';
            payableDiffSame += diff;
        } else if (st !== 'Возврат средств') {
            waitingDiff += diff;
            waitingCount += 1;
        }
        orders.push({
            id: Number(r.id),
            our_invoice_no: r.our_invoice_no || '',
            invoice_org: r.invoice_org || '',
            status: st,
            bucket,
            paid_at: paidYmd,
            shipped_at: shippedYmd,
            shipped_effective: shipEff,
            shipped_fallback: isShippedStatus(st) && !shippedYmd && !!paidYmd,
            paid_prior: false,
            diff: round2(diff),
            bonus_share: bonusShare,
            order_url: r.order_url || null,
            handed: Number(r.handed_to_user_id) === mid && Number(r.manager_user_id) !== mid,
        });
    }

    const pastPctCache = new Map();
    for (const r of pastShipRows || []) {
        const st = String(r.status || '').trim();
        const diff = Number(r.diff) || 0;
        const paidYmd = r.paid_ymd || null;
        const shippedYmd = r.shipped_ymd || null;
        const shipEff = shippedEffectiveYmd(st, shippedYmd, paidYmd);
        let share =
            r.bonus != null && Number.isFinite(Number(r.bonus)) ? round2(Number(r.bonus)) : null;
        if (share == null) {
            const py = Number(r.py);
            const pm = Number(r.pm);
            const cacheKey = `${py}:${pm}`;
            let pastPct = pastPctCache.get(cacheKey);
            if (pastPct == null) {
                const pb = monthBounds(py, pm);
                // eslint-disable-next-line no-await-in-loop
                const [agg] = await db.query(
                    `SELECT COALESCE(SUM(amount_ex_delivery), 0) AS amount_ex
                       FROM dg_manager_sales_rows
                      WHERE year = ?
                        AND archived_at IS NULL
                        AND paid_at IS NOT NULL
                        AND paid_at >= ? AND paid_at < ?
                        AND COALESCE(handed_to_user_id, manager_user_id) = ?`,
                    [py, pb.start, pb.next, mid]
                );
                const ax = Number(agg && agg[0] && agg[0].amount_ex) || 0;
                const pPlan = resolvePlan(plans, mid, py, pm);
                pastPct = pctMpFromMonthTotal(ax, pPlan.plan_amount, pPlan.steps);
                pastPctCache.set(cacheKey, pastPct);
            }
            share = round2((diff / 100) * pastPct);
        }
        payablePast += share;
        orders.push({
            id: Number(r.id),
            our_invoice_no: r.our_invoice_no || '',
            invoice_org: r.invoice_org || '',
            status: st,
            bucket: 'shipped',
            paid_at: paidYmd,
            shipped_at: shippedYmd,
            shipped_effective: shipEff,
            shipped_fallback: isShippedStatus(st) && !shippedYmd && !!paidYmd,
            paid_prior: true,
            diff: round2(diff),
            bonus_share: share,
            order_url: r.order_url || null,
            handed: Number(r.handed_to_user_id) === mid && Number(r.manager_user_id) !== mid,
        });
    }

    const bonus = round2((diffSum / 100) * pct);
    const bonusUnshipped = round2((waitingDiff / 100) * pct);
    const bonusPayable = round2(Math.max(0, (payableDiffSame / 100) * pct + payablePast));

    return {
        user_id: mid,
        year: y,
        month: m,
        bonus,
        bonus_payable: bonusPayable,
        bonus_unshipped: bonusUnshipped,
        unshipped_count: waitingCount,
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
    shippedEffectiveYmd,
    monthBounds,
};
