'use strict';

/**
 * Возврат в журнале менеджера.
 *
 * Сумма возврата не входит в оборот месяца оплаты → % МП. считается без неё.
 * Премия самого возврата в «к выплате» не попадает.
 * Если по старой (более высокой) ставке отгрузка уже попала в выплату месяца,
 * который раньше даты возврата, эта переплата не вычитается из того месяца повторно:
 * она минусом переносится на месяц даты возврата (`refund_at`).
 */

const { SHIPPED_STATUSES } = require('./opsSheetCalc');
const { pctMpFromMonthTotal } = require('./managerSalesCalc');

const REFUND_STATUS = 'Возврат средств';

function isRefundStatus(status) {
    return String(status || '').trim() === REFUND_STATUS;
}

function round2(n) {
    return Math.round((Number(n) || 0) * 100) / 100;
}

function ymd(v) {
    if (!v) return null;
    if (v instanceof Date && !Number.isNaN(v.getTime())) {
        const y = v.getFullYear();
        const m = String(v.getMonth() + 1).padStart(2, '0');
        const d = String(v.getDate()).padStart(2, '0');
        return `${y}-${m}-${d}`;
    }
    const s = String(v);
    return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null;
}

function monthOf(ymdStr) {
    if (!ymdStr || ymdStr.length < 7) return null;
    const y = Number(ymdStr.slice(0, 4));
    const m = Number(ymdStr.slice(5, 7));
    if (!Number.isFinite(y) || !Number.isFinite(m) || m < 1 || m > 12) return null;
    return { y, m, key: `${y}-${String(m).padStart(2, '0')}`, idx: y * 12 + m };
}

function isShippedStatus(st) {
    return SHIPPED_STATUSES.includes(String(st || '').trim());
}

function payableMonth(row) {
    if (!isShippedStatus(row.status)) return null;
    return monthOf(row.shipped_ymd || row.paid_ymd);
}

let colsReady = false;
async function ensureRefundColumns(db) {
    if (colsReady || !db || typeof db.query !== 'function') return;
    try {
        await db.query('ALTER TABLE dg_manager_sales_rows ADD COLUMN refund_at DATE NULL');
    } catch (_) {}
    try {
        await db.query(
            'ALTER TABLE dg_manager_sales_rows ADD COLUMN refund_was_payable TINYINT NOT NULL DEFAULT 0'
        );
    } catch (_) {}
    try {
        await db.query('ALTER TABLE dg_manager_sales_rows ADD KEY idx_msl_refund_at (refund_at)');
    } catch (_) {}
    colsReady = true;
}

function emptyAdj() {
    return {
        add_back: 0,
        carry_in: 0,
        carry_out: 0,
        local_drop: 0,
        removed_ex: 0,
        removed_diff: 0,
        own_released: 0,
        pct_before: null,
        pct_after: null,
        items_out: [],
        items_in: [],
    };
}

/**
 * Переплата уже выплаченных заказов из‑за возвратов и куда она переносится.
 * `rows` — все оплаты задействованных месяцев (и возвраты, и обычные).
 * @returns {Map<number, ReturnType<emptyAdj>>}
 */
function adjustmentsForView(rows, plans, resolvePlan, viewYear, viewMonth) {
    const viewIdx = Number(viewYear) * 12 + Number(viewMonth);
    const byPay = new Map();
    for (const raw of rows || []) {
        const mid = Number(raw.mid);
        if (!Number.isFinite(mid) || mid < 1) continue;
        const paid = monthOf(raw.paid_ymd);
        if (!paid) continue;
        const key = `${mid}:${paid.key}`;
        if (!byPay.has(key)) byPay.set(key, { mid, paid, rows: [] });
        byPay.get(key).rows.push(raw);
    }

    const out = new Map();
    function slot(mid) {
        if (!out.has(mid)) out.set(mid, emptyAdj());
        return out.get(mid);
    }

    for (const group of byPay.values()) {
        const { mid, paid, rows: list } = group;
        const refunds = [];
        const keep = [];
        let exAll = 0;
        let exKeep = 0;
        for (const r of list) {
            const ex = Number(r.amount_ex) || 0;
            exAll += ex;
            if (isRefundStatus(r.status)) refunds.push(r);
            else {
                exKeep += ex;
                keep.push(r);
            }
        }
        if (!refunds.length) continue;
        const plan = resolvePlan(plans, mid, paid.y, paid.m);
        const pctBefore = pctMpFromMonthTotal(exAll, plan.plan_amount, plan.steps);
        const pctAfter = pctMpFromMonthTotal(exKeep, plan.plan_amount, plan.steps);
        const viewIsPay = paid.idx === viewIdx;

        const buckets = new Map();
        for (const r of keep) {
            const pm = payableMonth(r);
            if (!pm) continue;
            if (!buckets.has(pm.key)) buckets.set(pm.key, { month: pm, diff: 0 });
            buckets.get(pm.key).diff += Number(r.diff) || 0;
        }

        /** Куда уезжает переплата: возвраты с датой строго позже месяца выплаты. */
        const transfers = [];
        let localDrop = 0;
        for (const bucket of buckets.values()) {
            const oldB = round2((bucket.diff / 100) * pctBefore);
            const newB = round2((bucket.diff / 100) * pctAfter);
            const delta = round2(oldB - newB);
            if (Math.abs(delta) < 0.004) continue;
            const later = refunds.filter((rf) => {
                const rm = monthOf(rf.refund_ymd);
                return rm && rm.idx > bucket.month.idx;
            });
            if (!later.length) {
                if (bucket.month.idx === viewIdx) localDrop = round2(localDrop + delta);
                continue;
            }
            const weights = later.map((rf) => ({
                rf,
                w: Math.abs(Number(rf.amount_ex) || 0) || 1,
            }));
            const sumW = weights.reduce((s, x) => s + x.w, 0);
            let left = delta;
            weights.forEach((x, i) => {
                const part = i === weights.length - 1 ? round2(left) : round2((delta * x.w) / sumW);
                if (i !== weights.length - 1) left = round2(left - part);
                if (Math.abs(part) < 0.004) return;
                transfers.push({ rf: x.rf, amount: part, from: bucket.month });
                if (bucket.month.idx === viewIdx) {
                    slot(mid).add_back = round2(slot(mid).add_back + part);
                }
            });
        }

        for (const rf of refunds) {
            const own = round2(((Number(rf.diff) || 0) / 100) * pctBefore);
            const wasPayable = Number(rf.refund_was_payable) === 1;
            const shipM = monthOf(rf.shipped_ymd || rf.paid_ymd);
            const refM = monthOf(rf.refund_ymd);
            if (wasPayable && own > 0.004 && shipM && refM && refM.idx > shipM.idx) {
                transfers.push({ rf, amount: own, from: shipM, own: true });
                if (shipM.idx === viewIdx) slot(mid).add_back = round2(slot(mid).add_back + own);
            } else if (viewIsPay && own > 0.004) {
                slot(mid).own_released = round2(slot(mid).own_released + own);
            }
        }

        if (viewIsPay) {
            const s = slot(mid);
            s.pct_before = pctBefore;
            s.pct_after = pctAfter;
            s.removed_ex = round2(refunds.reduce((a, r) => a + (Number(r.amount_ex) || 0), 0));
            s.removed_diff = round2(refunds.reduce((a, r) => a + (Number(r.diff) || 0), 0));
            s.local_drop = round2(s.local_drop + localDrop);
            const byRefund = new Map();
            for (const t of transfers) {
                const id = Number(t.rf.id);
                if (!byRefund.has(id)) {
                    const rm = monthOf(t.rf.refund_ymd);
                    byRefund.set(id, {
                        id,
                        our_invoice_no: t.rf.our_invoice_no || '',
                        paid_at: t.rf.paid_ymd,
                        refund_at: t.rf.refund_ymd,
                        paid_year: paid.y,
                        paid_month: paid.m,
                        refund_year: rm ? rm.y : null,
                        refund_month: rm ? rm.m : null,
                        amount_ex: round2(Number(t.rf.amount_ex) || 0),
                        diff: round2(Number(t.rf.diff) || 0),
                        own_bonus: round2(((Number(t.rf.diff) || 0) / 100) * pctBefore),
                        own_released: Number(t.rf.refund_was_payable) === 1 ? 0 : round2(((Number(t.rf.diff) || 0) / 100) * pctBefore),
                        carry_amount: 0,
                        pct_before: pctBefore,
                        pct_after: pctAfter,
                        transfers: [],
                    });
                }
                const item = byRefund.get(id);
                item.carry_amount = round2(item.carry_amount + t.amount);
                item.transfers.push({
                    year: t.rf.refund_ymd ? Number(t.rf.refund_ymd.slice(0, 4)) : null,
                    month: t.rf.refund_ymd ? Number(t.rf.refund_ymd.slice(5, 7)) : null,
                    amount: t.amount,
                });
            }
            // Возвраты без переноса тоже показываем (резерв снят / минус в этом месяце).
            for (const rf of refunds) {
                if (byRefund.has(Number(rf.id))) continue;
                const rm = monthOf(rf.refund_ymd);
                const own = round2(((Number(rf.diff) || 0) / 100) * pctBefore);
                byRefund.set(Number(rf.id), {
                    id: Number(rf.id),
                    our_invoice_no: rf.our_invoice_no || '',
                    paid_at: rf.paid_ymd,
                    refund_at: rf.refund_ymd,
                    paid_year: paid.y,
                    paid_month: paid.m,
                    refund_year: rm ? rm.y : null,
                    refund_month: rm ? rm.m : null,
                    amount_ex: round2(Number(rf.amount_ex) || 0),
                    diff: round2(Number(rf.diff) || 0),
                    own_bonus: own,
                    own_released: Number(rf.refund_was_payable) === 1 ? 0 : own,
                    carry_amount: 0,
                    pct_before: pctBefore,
                    pct_after: pctAfter,
                    transfers: [],
                });
            }
            s.items_out = Array.from(byRefund.values());
            s.carry_out = round2(s.items_out.reduce((a, it) => a + (Number(it.carry_amount) || 0), 0));
        }

        if (!viewIsPay) {
            for (const t of transfers) {
                const rm = monthOf(t.rf.refund_ymd);
                if (!rm || rm.idx !== viewIdx) continue;
                const s = slot(mid);
                s.carry_in = round2(s.carry_in + t.amount);
                const id = Number(t.rf.id);
                let item = s.items_in.find((x) => x.id === id && x.paid_year === paid.y && x.paid_month === paid.m);
                if (!item) {
                    item = {
                        id,
                        our_invoice_no: t.rf.our_invoice_no || '',
                        paid_at: t.rf.paid_ymd,
                        refund_at: t.rf.refund_ymd,
                        paid_year: paid.y,
                        paid_month: paid.m,
                        refund_year: rm.y,
                        refund_month: rm.m,
                        amount_ex: round2(Number(t.rf.amount_ex) || 0),
                        diff: round2(Number(t.rf.diff) || 0),
                        carry_amount: 0,
                        pct_before: pctBefore,
                        pct_after: pctAfter,
                        from_year: t.from.y,
                        from_month: t.from.m,
                    };
                    s.items_in.push(item);
                }
                item.carry_amount = round2(item.carry_amount + t.amount);
            }
        } else {
            for (const t of transfers) {
                const rm = monthOf(t.rf.refund_ymd);
                if (!rm || rm.idx !== viewIdx) continue;
                const s = slot(mid);
                s.carry_in = round2(s.carry_in + t.amount);
            }
        }
    }
    return out;
}

async function loadRowsTouchingMonth(db, year, month) {
    const y = Number(year);
    const m = Number(month);
    const start = `${y}-${String(m).padStart(2, '0')}-01`;
    const next = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
    const [refunds] = await db.query(
        `SELECT COALESCE(handed_to_user_id, manager_user_id) AS mid,
                YEAR(paid_at) AS py, MONTH(paid_at) AS pm
           FROM dg_manager_sales_rows
          WHERE archived_at IS NULL
            AND paid_at IS NOT NULL
            AND TRIM(COALESCE(status,'')) = ?
            AND (
              (paid_at >= ? AND paid_at < ?)
              OR (refund_at >= ? AND refund_at < ?)
            )`,
        [REFUND_STATUS, start, next, start, next]
    );
    const keys = new Set();
    for (const r of refunds || []) {
        const py = Number(r.py);
        const pm = Number(r.pm);
        const mid = Number(r.mid);
        if (!py || !pm || !mid) continue;
        keys.add(`${mid}:${py}:${pm}`);
    }
    if (!keys.size) return [];
    const ors = [];
    const params = [];
    for (const key of keys) {
        const [mid, py, pm] = key.split(':').map(Number);
        const b0 = `${py}-${String(pm).padStart(2, '0')}-01`;
        const b1 = pm === 12 ? `${py + 1}-01-01` : `${py}-${String(pm + 1).padStart(2, '0')}-01`;
        ors.push(
            `(COALESCE(handed_to_user_id, manager_user_id) = ? AND paid_at >= ? AND paid_at < ?)`
        );
        params.push(mid, b0, b1);
    }
    const [rows] = await db.query(
        `SELECT id,
                COALESCE(handed_to_user_id, manager_user_id) AS mid,
                our_invoice_no, status, diff, amount_ex_delivery AS amount_ex,
                refund_was_payable,
                DATE_FORMAT(paid_at, '%Y-%m-%d') AS paid_ymd,
                DATE_FORMAT(shipped_at, '%Y-%m-%d') AS shipped_ymd,
                DATE_FORMAT(refund_at, '%Y-%m-%d') AS refund_ymd
           FROM dg_manager_sales_rows
          WHERE archived_at IS NULL
            AND paid_at IS NOT NULL
            AND (${ors.join(' OR ')})`,
        params
    );
    return rows || [];
}

async function refundAdjustmentsForMonth(db, plans, resolvePlan, year, month) {
    await ensureRefundColumns(db);
    const rows = await loadRowsTouchingMonth(db, year, month);
    return adjustmentsForView(rows, plans, resolvePlan, year, month);
}

function applyPayableCarry(basePayable, adj) {
    const a = adj || emptyAdj();
    return round2((Number(basePayable) || 0) + (Number(a.add_back) || 0) - (Number(a.carry_in) || 0));
}

module.exports = {
    REFUND_STATUS,
    isRefundStatus,
    ensureRefundColumns,
    adjustmentsForView,
    refundAdjustmentsForMonth,
    applyPayableCarry,
    emptyAdj,
};
