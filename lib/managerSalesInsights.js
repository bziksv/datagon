'use strict';

/**
 * Модуль расчёта инфографики, ступеней плана (% МП.), сравнительных рейтингов
 * из Операционного листа (/ops-sheet.html) и персональных рекомендаций для /manager-sales.html.
 *
 * Особенности доступа:
 * - Менеджер по продажам получает своё точное место среди активных коллег ("1 место из 4"),
 *   средние показатели по отделу и значение лидера, но БЕЗ чужих ФИО/окладов.
 * - Руководители и администраторы (includeLeaderNames === true) дополнительно видят ФИО лидера
 *   по каждому показателю.
 */

const {
    toNum,
    round2,
    pctMpFromMonthTotal,
    DEFAULT_PLAN_AMOUNT,
    parseStoredSteps,
    cloneDefaultSteps,
    effectiveSteps,
} = require('./managerSalesCalc');
const {
    MONTH_LABELS,
    SHIPPED_STATUSES,
    isOpsAutoEra,
    profitBeforeTaxRow,
    buildRow,
    deriveMetrics,
    emptyManual,
} = require('./opsSheetCalc');
const pf = require('./opsSheetPlanfix');

const SALES_SPECIALTY_NAME = 'Менеджер по продажам';

function nz(v) {
    const n = toNum(v);
    return n == null ? 0 : n;
}

function round1(n) {
    if (n == null || !Number.isFinite(n)) return null;
    return Math.round(n * 10) / 10;
}

async function listActiveAndAllSalesManagers(db) {
    const [users] = await db.query(
        `SELECT u.id, u.username, u.full_name, COALESCE(u.is_archived, 0) AS is_archived
           FROM users u
           INNER JOIN specialties s ON s.id = u.specialty_id
          WHERE s.name = ?
          ORDER BY COALESCE(u.is_archived, 0), COALESCE(NULLIF(u.full_name,''), u.username)`,
        [SALES_SPECIALTY_NAME]
    );
    const all = (users || []).map((u) => ({
        id: Number(u.id),
        username: u.username || '',
        full_name: u.full_name || u.username || '',
        is_archived: Number(u.is_archived) === 1,
    }));
    const active = all.filter((m) => !m.is_archived);
    return { all, active };
}

function resolvePlanFromList(plans, managerUserId, year, month) {
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
    let source = 'default';
    if (monthOwn) source = 'manager_month';
    else if (managerYear) source = 'manager_year';
    else if (yearBase) source = 'year';
    return {
        plan_amount: Number.isFinite(amount) && amount > 0 ? amount : DEFAULT_PLAN_AMOUNT,
        source,
        note: (row && row.note) || '',
        steps,
    };
}

async function fetchYearMonthSalesAggregates(db, years, managerIds) {
    const out = {};
    const yList = (years || []).map((y) => Number(y)).filter((y) => Number.isFinite(y) && y > 0);
    const ids = (managerIds || []).map((n) => Number(n)).filter((n) => Number.isFinite(n) && n > 0);
    if (!yList.length || !ids.length) return out;
    const yPh = yList.map(() => '?').join(',');
    const mPh = ids.map(() => '?').join(',');
    const [rows] = await db.query(
        `SELECT year,
                COALESCE(handed_to_user_id, manager_user_id) AS mid,
                MONTH(paid_at) AS m,
                id,
                our_invoice_no,
                amount_ex_delivery,
                amount_incl_stock,
                vat,
                delivery_to_us,
                diff,
                status,
                bonus
           FROM dg_manager_sales_rows
          WHERE year IN (${yPh})
            AND archived_at IS NULL
            AND paid_at IS NOT NULL
            AND COALESCE(handed_to_user_id, manager_user_id) IN (${mPh})`,
        yList.concat(ids)
    );
    (rows || []).forEach((r) => {
        const y = Number(r.year);
        const mid = Number(r.mid);
        const m = Number(r.m);
        if (!Number.isFinite(y) || !Number.isFinite(mid) || !m || m < 1 || m > 12) return;
        const key = `${y}:${mid}:${m}`;
        if (!out[key]) {
            out[key] = {
                turnover: 0,
                amount_incl_stock: 0,
                delivery_to_us: 0,
                profit_before_tax: 0,
                profit_after_tax: 0,
                paid_applications: 0,
                rows_count: 0,
                unshipped_count: 0,
                unshipped_diff: 0,
                shipped_count: 0,
                _sales: new Set(),
            };
        }
        const cell = out[key];
        cell.rows_count += 1;
        const inv = String(r.our_invoice_no || '')
            .trim()
            .replace(/\s+/g, '')
            .toLowerCase();
        const saleKey = inv ? `i:${inv}` : `id:${r.id}`;
        if (!cell._sales.has(saleKey)) {
            cell._sales.add(saleKey);
            cell.paid_applications += 1;
        }
        cell.turnover += nz(r.amount_ex_delivery);
        cell.amount_incl_stock += nz(r.amount_incl_stock);
        cell.delivery_to_us += nz(r.delivery_to_us);
        cell.profit_before_tax += profitBeforeTaxRow(
            r.amount_ex_delivery,
            r.amount_incl_stock,
            r.vat,
            r.delivery_to_us
        );
        const d = nz(r.diff);
        cell.profit_after_tax += d;
        const st = String(r.status || '').trim();
        if (SHIPPED_STATUSES.includes(st)) {
            cell.shipped_count += 1;
        } else if (st !== 'Возврат средств') {
            cell.unshipped_count += 1;
            cell.unshipped_diff += d;
        }
    });
    Object.keys(out).forEach((k) => {
        delete out[k]._sales;
        out[k].turnover = round2(out[k].turnover);
        out[k].amount_incl_stock = round2(out[k].amount_incl_stock);
        out[k].delivery_to_us = round2(out[k].delivery_to_us);
        out[k].profit_before_tax = round2(out[k].profit_before_tax);
        out[k].profit_after_tax = round2(out[k].profit_after_tax);
        out[k].unshipped_diff = round2(out[k].unshipped_diff);
    });
    return out;
}

async function fetchManualByYears(db, years) {
    const out = {};
    const yList = (years || []).map((y) => Number(y)).filter((y) => Number.isFinite(y) && y > 0);
    if (!yList.length) return out;
    const yPh = yList.map(() => '?').join(',');
    try {
        const [rows] = await db.query(
            `SELECT year, month, manager_user_id, applications_count, coefficient,
                    bonus_past, bonus_past_manual, salary
               FROM dg_ops_sheet_manual
              WHERE year IN (${yPh})`,
            yList
        );
        (rows || []).forEach((r) => {
            const y = Number(r.year);
            const m = Number(r.month);
            const mid = Number(r.manager_user_id);
            out[`${y}:${mid}:${m}`] = {
                applications_count:
                    r.applications_count != null ? Math.round(Number(r.applications_count) || 0) : null,
                applications_local: null,
                coefficient: r.coefficient != null ? Number(r.coefficient) : null,
                bonus_past: r.bonus_past != null ? Number(r.bonus_past) : null,
                bonus_past_manual: Number(r.bonus_past_manual) === 1 ? 1 : 0,
                salary: r.salary != null ? Number(r.salary) : null,
            };
        });
    } catch (_) {
        /* Таблица может ещё не быть создана до первого входа в ops-sheet */
    }
    return out;
}

async function fetchBonusPastByShippedYears(db, years, managerIds) {
    const out = {};
    const yList = (years || []).map((y) => Number(y)).filter((y) => Number.isFinite(y) && y > 0);
    const ids = (managerIds || []).map((n) => Number(n)).filter((n) => Number.isFinite(n) && n > 0);
    if (!yList.length || !ids.length) return out;
    const statusPh = SHIPPED_STATUSES.map(() => '?').join(',');
    const yPh = yList.map(() => '?').join(',');
    const mPh = ids.map(() => '?').join(',');
    const [rows] = await db.query(
        `SELECT COALESCE(handed_to_user_id, manager_user_id) AS mid,
                YEAR(COALESCE(shipped_at, paid_at)) AS sy,
                MONTH(COALESCE(shipped_at, paid_at)) AS sm,
                YEAR(paid_at) AS py,
                MONTH(paid_at) AS pm,
                bonus
           FROM dg_manager_sales_rows
          WHERE archived_at IS NULL
            AND paid_at IS NOT NULL
            AND status IN (${statusPh})
            AND YEAR(COALESCE(shipped_at, paid_at)) IN (${yPh})
            AND COALESCE(handed_to_user_id, manager_user_id) IN (${mPh})`,
        SHIPPED_STATUSES.concat(yList).concat(ids)
    );
    (rows || []).forEach((r) => {
        const mid = Number(r.mid);
        const sy = Number(r.sy);
        const sm = Number(r.sm);
        const py = Number(r.py);
        const pm = Number(r.pm);
        if (!Number.isFinite(mid) || !Number.isFinite(sy) || !sm || sm < 1 || sm > 12) return;
        if (!Number.isFinite(py) || !Number.isFinite(pm) || pm < 1 || pm > 12) return;
        if (py > sy || (py === sy && pm > sm)) return;
        const key = `${sy}:${mid}:${sm}`;
        if (!out[key]) {
            out[key] = { sum: 0, count: 0, sum_past: 0, sum_current: 0 };
        }
        const b = nz(r.bonus);
        out[key].sum += b;
        out[key].count += 1;
        if (py === sy && pm === sm) out[key].sum_current += b;
        else out[key].sum_past += b;
    });
    Object.keys(out).forEach((k) => {
        out[k].sum = round2(out[k].sum);
        out[k].sum_past = round2(out[k].sum_past);
        out[k].sum_current = round2(out[k].sum_current);
    });
    return out;
}

async function fetchPlanfixAppsByYears(db, years, managers) {
    const out = {};
    const yList = (years || []).map((y) => Number(y)).filter((y) => Number.isFinite(y) && y > 0);
    if (!yList.length || !managers || !managers.length) return out;
    const minY = Math.min(...yList);
    const maxY = Math.max(...yList);
    const fromSql = `${minY}-01-01 00:00:00`;
    const toSql = `${maxY + 1}-01-01 00:00:00`;
    try {
        const [agg] = await db.query(
            `SELECT YEAR(created_at) AS y, MONTH(created_at) AS m, assigner_name, status_value, COUNT(*) AS n
               FROM dg_ops_planfix_tasks
              WHERE created_at >= ? AND created_at < ?
              GROUP BY YEAR(created_at), MONTH(created_at), assigner_name, status_value`,
            [fromSql, toSql]
        );
        (agg || []).forEach((row) => {
            const status = String(row.status_value || '');
            if (pf.isExcludedFromAppsCount(status)) return;
            const y = Number(row.y);
            const m = Number(row.m);
            if (!yList.includes(y) || !m || m < 1 || m > 12) return;
            const mgr = pf.matchManagerByAssigner(row.assigner_name, managers);
            if (!mgr) return;
            const key = `${y}:${mgr.id}:${m}`;
            out[key] = (out[key] || 0) + (Number(row.n) || 0);
        });
    } catch (_) {
        /* Таблица dg_ops_planfix_tasks может отсутствовать в тестовом окружении */
    }
    return out;
}

function buildManagerMonthOpsRow(mgr, year, month, salesAggMap, plans, manualMap, pfAppsMap, bonusPastMap) {
    const key = `${year}:${mgr.id}:${month}`;
    const agg = salesAggMap[key] || {
        turnover: 0,
        amount_incl_stock: 0,
        delivery_to_us: 0,
        profit_before_tax: 0,
        profit_after_tax: 0,
        paid_applications: 0,
        rows_count: 0,
        unshipped_count: 0,
        unshipped_diff: 0,
        shipped_count: 0,
    };
    const plan = resolvePlanFromList(plans, mgr.id, year, month);
    const pctMp = pctMpFromMonthTotal(agg.turnover, plan.plan_amount, plan.steps);
    const bonusCurrent = round2((agg.profit_after_tax / 100) * pctMp);
    const bp = bonusPastMap[key] || { sum: 0, count: 0, sum_past: 0, sum_current: 0 };
    const manBase = manualMap[key] || emptyManual();
    const appsLocal = pfAppsMap[key] != null ? Math.round(Number(pfAppsMap[key]) || 0) : 0;
    const manual = Object.assign(emptyManual(), manBase, {
        applications_local: appsLocal > 0 ? appsLocal : manBase.applications_count != null ? manBase.applications_count : 0,
    });
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
        manual,
        {
            year,
            month,
            bonus_past_auto: bp.sum,
            bonus_past_manual: manBase.bonus_past_manual,
            bonus_past_orders_count: bp.count,
            bonus_past_from_past: bp.sum_past,
            bonus_past_from_current: bp.sum_current,
        }
    );
    // Выбираем лучшее доступное отношение заявок к продажам (Planfix*, либо архив Google)
    const effectiveApps =
        row.applications_local != null && row.applications_local > 0
            ? row.applications_local
            : row.applications_count != null && row.applications_count > 0
              ? row.applications_count
              : null;
    const effectiveAppsPerSale =
        effectiveApps != null && row.paid_applications > 0
            ? round1(effectiveApps / row.paid_applications)
            : null;
    const conversionPct =
        effectiveApps != null && effectiveApps > 0 && row.paid_applications > 0
            ? round2((row.paid_applications / effectiveApps) * 100)
            : null;
    const unshippedBonus = round2((agg.unshipped_diff / 100) * pctMp);
    return Object.assign({}, row, {
        amount_incl_stock: agg.amount_incl_stock,
        delivery_to_us: agg.delivery_to_us,
        rows_count: agg.rows_count,
        unshipped_count: agg.unshipped_count,
        unshipped_diff: agg.unshipped_diff,
        unshipped_bonus: unshippedBonus,
        shipped_count: agg.shipped_count,
        effective_applications: effectiveApps,
        effective_apps_per_sale: effectiveAppsPerSale,
        conversion_pct: conversionPct,
    });
}

function aggregateManagerMonths(mgr, year, monthsList, salesAggMap, plans, manualMap, pfAppsMap, bonusPastMap) {
    const mRows = monthsList.map((m) =>
        buildManagerMonthOpsRow(mgr, year, m, salesAggMap, plans, manualMap, pfAppsMap, bonusPastMap)
    );
    const activeRows = mRows.filter((r) => r.turnover > 0 || r.paid_applications > 0 || (r.effective_applications || 0) > 0);
    const turnover = round2(mRows.reduce((s, r) => s + nz(r.turnover), 0));
    const amountInclStock = round2(mRows.reduce((s, r) => s + nz(r.amount_incl_stock), 0));
    const deliveryToUs = round2(mRows.reduce((s, r) => s + nz(r.delivery_to_us), 0));
    const profitBeforeTax = round2(mRows.reduce((s, r) => s + nz(r.profit_before_tax), 0));
    const profitAfterTax = round2(mRows.reduce((s, r) => s + nz(r.profit_after_tax), 0));
    const bonusCurrent = round2(mRows.reduce((s, r) => s + nz(r.bonus_current), 0));
    const paidApplications = mRows.reduce((s, r) => s + (Number(r.paid_applications) || 0), 0);
    const effectiveAppsSum = mRows.reduce((s, r) => s + (Number(r.effective_applications) || 0), 0);
    const salarySum = round2(mRows.reduce((s, r) => s + nz(r.salary), 0));
    const bonusPastSum = round2(mRows.reduce((s, r) => s + nz(r.bonus_past), 0));
    const salaryPaid = round2(salarySum + bonusPastSum);
    const companyProfit = round2(profitAfterTax - salaryPaid);
    const profitPct = turnover > 0 ? round2((profitAfterTax / turnover) * 100) : null;
    const companyPct = turnover > 0 && salaryPaid > 0 ? round2((companyProfit / turnover) * 100) : profitPct;
    const avgCheck = paidApplications > 0 ? round2(turnover / paidApplications) : null;
    const effectiveAppsPerSale =
        effectiveAppsSum > 0 && paidApplications > 0 ? round1(effectiveAppsSum / paidApplications) : null;
    const conversionPct =
        effectiveAppsSum > 0 && paidApplications > 0 ? round2((paidApplications / effectiveAppsSum) * 100) : null;
    const unshippedCount = mRows.reduce((s, r) => s + (Number(r.unshipped_count) || 0), 0);
    const unshippedBonus = round2(mRows.reduce((s, r) => s + nz(r.unshipped_bonus), 0));

    return {
        manager_user_id: mgr.id,
        manager_name: mgr.full_name || mgr.username || '',
        active_months_count: activeRows.length,
        turnover,
        amount_incl_stock: amountInclStock,
        delivery_to_us: deliveryToUs,
        profit_before_tax: profitBeforeTax,
        profit_after_tax: profitAfterTax,
        profit_pct: profitPct,
        bonus_current: bonusCurrent,
        paid_applications: paidApplications,
        effective_applications: effectiveAppsSum > 0 ? effectiveAppsSum : null,
        effective_apps_per_sale: effectiveAppsPerSale,
        conversion_pct: conversionPct,
        avg_check: avgCheck,
        salary: salarySum,
        bonus_past: bonusPastSum,
        salary_paid: salaryPaid,
        company_profit: companyProfit,
        company_pct: companyPct,
        unshipped_count: unshippedCount,
        unshipped_bonus: unshippedBonus,
    };
}

function buildPlanLadder(planInfo, totals, currentManagerRow) {
    if (!planInfo) return null;
    const planAmount = nz(planInfo.plan_amount) || DEFAULT_PLAN_AMOUNT;
    const monthTotal = nz(planInfo.month_total);
    const currentPctMp = nz(planInfo.pct_mp);
    const currentDiff = currentManagerRow ? nz(currentManagerRow.profit_after_tax) : nz(totals && totals.diff);
    const avgCheck = currentManagerRow && nz(currentManagerRow.avg_check) > 0 ? nz(currentManagerRow.avg_check) : 0;
    const marginRatio =
        monthTotal > 0 && currentDiff > 0 ? currentDiff / monthTotal : 0.16;

    const used = effectiveSteps(planInfo.steps, planAmount);
    const ladder = [];
    let prevThreshold = 0;
    for (let i = 0; i < used.steps.length; i += 1) {
        const [maxVal, pct] = used.steps[i];
        ladder.push({
            index: i,
            min_amount: prevThreshold,
            max_amount: maxVal,
            pct_mp: pct,
            reached: monthTotal >= prevThreshold,
            current: monthTotal >= prevThreshold && monthTotal < maxVal,
        });
        prevThreshold = maxVal;
    }
    ladder.push({
        index: used.steps.length,
        min_amount: prevThreshold,
        max_amount: null,
        pct_mp: used.pct_max,
        reached: monthTotal >= prevThreshold,
        current: monthTotal >= prevThreshold,
    });

    const nextStepRaw = ladder.find((s) => s.min_amount > monthTotal);
    let nextStep = null;
    if (nextStepRaw) {
        const remaining = round2(Math.max(0, nextStepRaw.min_amount - monthTotal));
        const bonusOnExistingDiff = round2(
            (currentDiff / 100) * (nextStepRaw.pct_mp - currentPctMp)
        );
        const estimatedExtraDiff = round2(remaining * marginRatio);
        const projectedTotalBonus = round2(
            ((currentDiff + estimatedExtraDiff) / 100) * nextStepRaw.pct_mp
        );
        const currentBonus = round2((currentDiff / 100) * currentPctMp);
        const totalBonusGain = round2(Math.max(bonusOnExistingDiff, projectedTotalBonus - currentBonus));
        const ordersNeeded = avgCheck > 0 ? Math.max(1, Math.ceil(remaining / avgCheck)) : null;

        nextStep = {
            target_amount: nextStepRaw.min_amount,
            target_pct_mp: nextStepRaw.pct_mp,
            remaining_amount: remaining,
            orders_needed_by_avg_check: ordersNeeded,
            bonus_gain_on_current_diff: bonusOnExistingDiff,
            total_estimated_bonus_gain: totalBonusGain,
            projected_total_bonus: projectedTotalBonus,
        };
    }

    const completionPct = planAmount > 0 ? round1((monthTotal / planAmount) * 100) : 0;

    return {
        plan_amount: planAmount,
        month_total: monthTotal,
        completion_pct: completionPct,
        current_pct_mp: currentPctMp,
        max_pct_mp: used.pct_max,
        source: planInfo.source || 'default',
        note: planInfo.note || '',
        steps: ladder,
        next_step: nextStep,
    };
}

function rankPeerMetric(peerRows, targetManagerId, getter, lowerIsBetter, includeLeaderNames) {
    const valid = [];
    (peerRows || []).forEach((r) => {
        const v = getter(r);
        if (v == null || !Number.isFinite(v)) return;
        valid.push({
            manager_user_id: r.manager_user_id,
            manager_name: r.manager_name,
            value: v,
        });
    });
    if (!valid.length) return null;
    valid.sort((a, b) => (lowerIsBetter ? a.value - b.value : b.value - a.value));

    let rank = null;
    let myValue = null;
    valid.forEach((item, idx) => {
        if (Number(item.manager_user_id) === Number(targetManagerId)) {
            rank = idx + 1;
            myValue = item.value;
        }
    });

    const sum = valid.reduce((s, x) => s + x.value, 0);
    const teamAvg = round2(sum / valid.length);
    const leader = valid[0];

    return {
        value: myValue,
        rank,
        peers_count: valid.length,
        lower_is_better: !!lowerIsBetter,
        team_avg: teamAvg,
        leader_value: leader ? leader.value : null,
        leader_is_me: leader ? Number(leader.manager_user_id) === Number(targetManagerId) : false,
        leader_name: includeLeaderNames && leader ? leader.manager_name : null,
    };
}

function computeDelta(curr, ref) {
    if (curr == null || ref == null || !Number.isFinite(curr) || !Number.isFinite(ref)) return null;
    const abs = round2(curr - ref);
    const pct = ref !== 0 ? round1(((curr - ref) / Math.abs(ref)) * 100) : null;
    return { abs, pct };
}

function buildRecommendations({
    periodLabel,
    isSingleMonth,
    currentRow,
    benchmarks,
    planLadder,
    includeLeaderNames,
}) {
    const recs = [];
    if (!currentRow) return recs;

    const bApps = benchmarks.apps_per_sale;
    const bCheck = benchmarks.avg_check;
    const bCompPct = benchmarks.company_pct;
    const bProfPct = benchmarks.profit_pct;
    const bTurn = benchmarks.turnover;

    // 1. Связка «Отношение продаж к заявкам* (конверсия) + Средний чек»
    if (bApps && bApps.rank != null && bCheck && bCheck.rank != null) {
        const convStr =
            currentRow.conversion_pct != null
                ? ` (${currentRow.conversion_pct}% оплат, 1 продажа из ${bApps.value} заявок)`
                : ` (1 продажа из ${bApps.value} заявок)`;
        if (bApps.rank === 1 && bCheck.rank > 1) {
            const checkGap = round2(Math.max(0, (bCheck.leader_value || bCheck.team_avg || 0) - (bCheck.value || 0)));
            const extraTurnover = round2(checkGap * (currentRow.paid_applications || 0));
            const leaderHint =
                includeLeaderNames && bCheck.leader_name ? ` (${bCheck.leader_name})` : '';
            recs.push({
                id: 'conversion_vs_check',
                tone: 'success',
                badge: `1 место по конверсии · ${bCheck.rank} место по чеку`,
                title: 'Лучшее отношение продаж к заявкам, точка роста — средний чек',
                text:
                    `У вас лучшее в компании отношение продаж к заявкам*${convStr}, однако средний чек (${Math.round(bCheck.value).toLocaleString('ru-RU')} ₽) сейчас на ${bCheck.rank} месте из ${bCheck.peers_count}. ` +
                    (checkGap > 0
                        ? `Увеличение среднего чека до уровня 1 места${leaderHint} (${Math.round(bCheck.leader_value).toLocaleString('ru-RU')} ₽) на текущем потоке из ${currentRow.paid_applications} оплат даст +${Math.round(extraTurnover).toLocaleString('ru-RU')} ₽ к обороту.`
                        : 'Фокус на допродажу комплектующих и более крупных позиций позволит конвертировать поток заявок в максимальный оборот.'),
            });
        } else if (bCheck.rank === 1 && bApps.rank > 1) {
            recs.push({
                id: 'check_vs_conversion',
                tone: 'info',
                badge: `1 место по среднему чеку · ${bApps.rank} место по конверсии`,
                title: 'Лидерский средний чек, резерв — дожим заявок в оплату',
                text:
                    `Ваш средний чек (${Math.round(bCheck.value).toLocaleString('ru-RU')} ₽) — 1 место из ${bCheck.peers_count} по отделу (среднее по компании ${Math.round(bCheck.team_avg).toLocaleString('ru-RU')} ₽). ` +
                    `При этом отношение продаж к заявкам* (${bApps.value} заявок на 1 счёт) на ${bApps.rank} месте из ${bApps.peers_count} (у лидера — ${bApps.leader_value}). Улучшение конверсии даже на 2–3 оплаченных счёта при вашем чеке даст самый быстрый прирост оборота.`,
            });
        } else if (bApps.rank === 1 && bCheck.rank === 1) {
            recs.push({
                id: 'double_leader_conv_check',
                tone: 'success',
                badge: '1 место по конверсии и чеку',
                title: 'Двойное лидерство: конверсия заявок и средний чек',
                text:
                    `Вы занимаете 1 место из ${bApps.peers_count} и по отношению продаж к заявкам*${convStr}, и по среднему чеку (${Math.round(bCheck.value).toLocaleString('ru-RU')} ₽ против ${Math.round(bCheck.team_avg).toLocaleString('ru-RU')} ₽ в среднем по компании).`,
            });
        } else {
            const vsTeamCheck =
                bCheck.value >= bCheck.team_avg
                    ? `выше среднего по отделу (${Math.round(bCheck.team_avg).toLocaleString('ru-RU')} ₽)`
                    : `ниже среднего по отделу (${Math.round(bCheck.team_avg).toLocaleString('ru-RU')} ₽)`;
            recs.push({
                id: 'conv_check_balance',
                tone: bApps.rank <= 2 ? 'info' : 'warning',
                badge: `Конверсия: ${bApps.rank}/${bApps.peers_count} · Чек: ${bCheck.rank}/${bCheck.peers_count}`,
                title: 'Баланс воронки: отношение заявок к оплатам и средний чек',
                text:
                    `Отношение продаж к заявкам* — ${bApps.value} (${bApps.rank} место из ${bApps.peers_count}, среднее по отделу ${bApps.team_avg}). ` +
                    `Средний чек — ${Math.round(bCheck.value).toLocaleString('ru-RU')} ₽ (${bCheck.rank} место, ${vsTeamCheck}). ` +
                    (bCheck.own_year_avg && bCheck.value < bCheck.own_year_avg
                        ? `Ваш средний чек за год выше текущего (${Math.round(bCheck.own_year_avg).toLocaleString('ru-RU')} ₽) — возврат к своей норме чека ускорит выполнение плана.`
                        : 'Сфокусируйтесь на повторных касаниях по крупным счетам в работе.'),
            });
        }
    } else if (bCheck && bCheck.rank != null) {
        recs.push({
            id: 'check_only_insight',
            tone: bCheck.rank === 1 ? 'success' : 'info',
            badge: `Средний чек: ${bCheck.rank} место из ${bCheck.peers_count}`,
            title: 'Динамика среднего чека по сделкам',
            text:
                `Средний чек за период составляет ${Math.round(bCheck.value).toLocaleString('ru-RU')} ₽ (${bCheck.rank} место из ${bCheck.peers_count}, среднее по отделу ${Math.round(bCheck.team_avg).toLocaleString('ru-RU')} ₽` +
                (bCheck.own_year_avg ? `, ваше среднее за год ${Math.round(bCheck.own_year_avg).toLocaleString('ru-RU')} ₽` : '') +
                `).`,
        });
    }

    // 2. Прибыльность: % прибыли со сделок + % от оборота с вычетом зарплат + динамика к году и прошлому году (YoY)
    if (bProfPct && bProfPct.value != null && bProfPct.rank === 1) {
        const compNote =
            bCompPct && bCompPct.value != null
                ? ` При этом «% от оборота с вычетом зарплат» сейчас ${bCompPct.value}% (${bCompPct.rank} место из ${bCompPct.peers_count}, среднее за год ${bCompPct.own_year_avg != null ? bCompPct.own_year_avg + '%' : '—'}, прошлый год ${bCompPct.prev_year_same_period != null ? bCompPct.prev_year_same_period + '%' : '—'}) — при увеличении оборота доля постоянной части оклада снизится, и вы выйдете на 1 место и по чистой прибыли для фирмы.`
                : '';
        recs.push({
            id: 'margin_rank1_highlight',
            tone: 'success',
            badge: `1 место по % прибыли (${bProfPct.value}%)`,
            title: 'Лучшая маржинальность сделок в компании (% прибыли за месяц)',
            text:
                `Ваш общий % прибыли за месяц составляет ${bProfPct.value}% — это 1 место из ${bProfPct.peers_count} в компании (среднее по отделу ${bProfPct.team_avg}%, ваше среднее за год ${bProfPct.own_year_avg != null ? bProfPct.own_year_avg + '%' : '—'}).` +
                compNote,
        });
    } else {
        const profMetric = bCompPct && bCompPct.value != null ? bCompPct : bProfPct;
        if (profMetric && profMetric.value != null) {
            const isCompMetric = profMetric === bCompPct;
            const metricTitle = isCompMetric
                ? '% от оборота с вычетом зарплат'
                : 'Общий % прибыли за месяц';
            const yoyDelta = profMetric.yoy_delta ? profMetric.yoy_delta.abs : null;
            const yearAvgDelta = profMetric.vs_year_avg_delta ? profMetric.vs_year_avg_delta.abs : null;
            const profRank = profMetric.rank;
            const peersN = profMetric.peers_count;

            let dynParts = [];
            if (profMetric.own_year_avg != null) {
                const sign = yearAvgDelta > 0 ? `+${yearAvgDelta}` : `${yearAvgDelta}`;
                dynParts.push(`ваше среднее за год ${profMetric.own_year_avg}% (${sign} п.п.)`);
            }
            if (profMetric.prev_year_same_period != null) {
                const sign = yoyDelta > 0 ? `+${yoyDelta}` : `${yoyDelta}`;
                dynParts.push(`прошлый год за этот же период ${profMetric.prev_year_same_period}% (${sign} п.п.)`);
            }

            if (profRank === 1 && yoyDelta != null && yoyDelta < 0) {
                recs.push({
                    id: 'profitability_rank1_yoy_down',
                    tone: 'warning',
                    badge: `1 место по прибыльности · ${yoyDelta} п.п. к прошлому году`,
                    title: 'Лидер по рентабельности в компании, но динамика к прошлому году ниже',
                    text:
                        `Вы на 1 месте из ${peersN} по показателю «${metricTitle}» (${profMetric.value}%, среднее по отделу ${profMetric.team_avg}%), ` +
                        `однако относительно прошлого года показатель снизился на ${Math.abs(yoyDelta)} п.п. (${dynParts.join('; ')}). ` +
                        `Основные факторы — объём оборота относительно постоянной части выплат и маржинальность сделок (% Р. = ${bProfPct && bProfPct.value != null ? bProfPct.value : '—'}%).`,
                });
            } else if (profRank === 1) {
                recs.push({
                    id: 'profitability_rank1_strong',
                    tone: 'success',
                    badge: `1 место из ${peersN} по рентабельности`,
                    title: 'Лучшая рентабельность для компании в текущем периоде',
                    text:
                        `Показатель «${metricTitle}» составляет ${profMetric.value}% — это 1 место из ${peersN} (среднее по отделу ${profMetric.team_avg}%` +
                        (dynParts.length ? `; ${dynParts.join('; ')}` : '') +
                        `). Отличный баланс наценки (% Р. = ${bProfPct && bProfPct.value != null ? bProfPct.value : '—'}%) и объёма продаж.`,
                });
            } else {
                const tone = profMetric.value < 0 || (yoyDelta != null && yoyDelta < -3) ? 'warning' : 'info';
                recs.push({
                    id: 'profitability_overview',
                    tone,
                    badge: `Рентабельность: ${profRank} место из ${peersN}`,
                    title: `${metricTitle} и годовая динамика`,
                    text:
                        `Текущий показатель «${metricTitle}» — ${profMetric.value}% (${profRank} место из ${peersN}, среднее по отделу ${profMetric.team_avg}%` +
                        (dynParts.length ? `; ${dynParts.join('; ')}` : '') +
                        `). ` +
                        (bProfPct && bProfPct.own_year_avg != null && bProfPct.value < bProfPct.own_year_avg
                            ? `Чистая маржинальность сделок (% Р. = ${bProfPct.value}%) сейчас ниже вашей среднегодовой нормы (${bProfPct.own_year_avg}%) — проверьте скидки и стоимость доставки до нас.`
                            : `При росте оборота постоянная часть оклада распределяется на больший объём, автоматически поднимая % чистой рентабельности.`),
                });
            }
        }
    }

    // 3. Ближайшая ступень % МП. и рычаг премии
    if (planLadder && planLadder.next_step) {
        const ns = planLadder.next_step;
        const ordersHint =
            ns.orders_needed_by_avg_check != null
                ? ` (примерно ${ns.orders_needed_by_avg_check} ${ns.orders_needed_by_avg_check === 1 ? 'сделка' : ns.orders_needed_by_avg_check < 5 ? 'сделки' : 'сделок'} с вашим средним чеком)`
                : '';
        recs.push({
            id: 'next_bonus_step',
            tone: 'info',
            badge: `Цель: ступень ${ns.target_pct_mp}% МП.`,
            title: `До следующей ступени премии (${ns.target_pct_mp}% МП.) осталось ${Math.round(ns.remaining_amount).toLocaleString('ru-RU')} ₽`,
            text:
                `При достижении порога ${Math.round(ns.target_amount).toLocaleString('ru-RU')} ₽${ordersHint} ставка пересчитается с ${planLadder.current_pct_mp}% до ${ns.target_pct_mp}% на всю разницу месяца: ` +
                `только за уже закрытые сделки премия сразу вырастет на +${Math.round(ns.bonus_gain_on_current_diff).toLocaleString('ru-RU')} ₽, а общая прогнозная премия составит ~${Math.round(ns.projected_total_bonus).toLocaleString('ru-RU')} ₽.`,
        });
    } else if (planLadder && planLadder.current_pct_mp >= planLadder.max_pct_mp) {
        recs.push({
            id: 'max_bonus_step_reached',
            tone: 'success',
            badge: `Максимальная ставка ${planLadder.current_pct_mp}% МП.`,
            title: 'План месяца выполнен, действует максимальный % МП.',
            text: `Вы вышли на максимальную ставку ${planLadder.current_pct_mp}% МП. Каждые дополнительные 100 000 ₽ разницы приносят +${(1000 * planLadder.current_pct_mp).toLocaleString('ru-RU')} ₽ чистой премии.`,
        });
    }

    // 4. Темп оборота (MoM / YoY) или контроль неотгруженных заказов
    if (currentRow.unshipped_count > 0 && currentRow.unshipped_bonus > 0) {
        recs.push({
            id: 'unshipped_bonus_reserve',
            tone: 'warning',
            badge: `В ожидании отгрузки: ${currentRow.unshipped_count} шт.`,
            title: `Резерв выплаты премии по отгрузкам: ${Math.round(currentRow.unshipped_bonus).toLocaleString('ru-RU')} ₽`,
            text:
                `В периоде есть ${currentRow.unshipped_count} оплаченных заказов не в статусе «Отгружен» на сумму премии ${Math.round(currentRow.unshipped_bonus).toLocaleString('ru-RU')} ₽. ` +
                `В Операционном листе премия к выплате («Премия с учетом заказов с прошлых месяцев») начисляется по факту отгрузки и заполнения «Даты отгрузки».`,
        });
    } else if (bTurn && bTurn.yoy_delta && bTurn.prev_year_same_period > 0) {
        const up = bTurn.yoy_delta.pct >= 0;
        recs.push({
            id: 'turnover_yoy_tempo',
            tone: up ? 'success' : 'info',
            badge: `К прошлому году: ${up ? '+' : ''}${bTurn.yoy_delta.pct}%`,
            title: `Динамика оборота к прошлому году (${periodLabel})`,
            text:
                `Оборот за период (${Math.round(bTurn.value).toLocaleString('ru-RU')} ₽) ${up ? 'опережает' : 'ниже'} аналогичный период прошлого года (${Math.round(bTurn.prev_year_same_period).toLocaleString('ru-RU')} ₽) на ${Math.abs(bTurn.yoy_delta.pct)}%. ` +
                (bTurn.own_year_avg
                    ? `Ваш среднемесячный оборот в текущем году — ${Math.round(bTurn.own_year_avg).toLocaleString('ru-RU')} ₽.`
                    : ''),
        });
    }

    return recs;
}

/**
 * Собирает объект insights для GET /api/manager-sales.
 */
async function buildManagerSalesInsights(db, opts) {
    const o = opts || {};
    const year = Number(o.year) || new Date().getFullYear();
    const month = o.month != null && Number(o.month) >= 1 && Number(o.month) <= 12 ? Number(o.month) : null;
    const managerId = o.managerId != null && Number(o.managerId) > 0 ? Number(o.managerId) : null;
    const totals = o.totals || {};
    const planInfo = o.planInfo || null;
    const includeLeaderNames = !!o.includeLeaderNames;

    const prevYear = year - 1;
    const yearsToLoad = [year, prevYear];

    const { all: allManagers, active: activeManagers } = await listActiveAndAllSalesManagers(db);
    // Если выбран архивный менеджер, включаем его в список для расчёта
    const peerManagers = activeManagers.slice();
    if (managerId && !peerManagers.some((m) => m.id === managerId)) {
        const found = allManagers.find((m) => m.id === managerId);
        if (found) peerManagers.push(found);
    }
    const peerIds = peerManagers.map((m) => m.id);

    const [salesAggMap, plans, manualMap, bonusPastMap, pfAppsMap] = await Promise.all([
        fetchYearMonthSalesAggregates(db, yearsToLoad, peerIds),
        db.query(`SELECT id, manager_user_id, year, month, plan_amount, note, steps_json FROM dg_manager_sales_plans`).then(([r]) => r || []),
        fetchManualByYears(db, yearsToLoad),
        fetchBonusPastByShippedYears(db, yearsToLoad, peerIds),
        fetchPlanfixAppsByYears(db, yearsToLoad, allManagers),
    ]);

    const monthsInScope = month ? [month] : [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
    const periodLabel = month ? `${MONTH_LABELS[month]} ${year}` : `Весь ${year} год`;

    // Строим строки оперлиста для всех коллег за выбранный период
    const peerRowsCurrent = peerManagers.map((mgr) =>
        month
            ? buildManagerMonthOpsRow(mgr, year, month, salesAggMap, plans, manualMap, pfAppsMap, bonusPastMap)
            : aggregateManagerMonths(mgr, year, monthsInScope, salesAggMap, plans, manualMap, pfAppsMap, bonusPastMap)
    );

    // Оставляем для честного рейтинга тех, у кого в периоде была активность (или самого выбранного менеджера)
    const activePeerRows = peerRowsCurrent.filter(
        (r) =>
            r.turnover > 0 ||
            r.paid_applications > 0 ||
            (r.effective_applications || 0) > 0 ||
            Number(r.manager_user_id) === Number(managerId)
    );

    const targetManager = managerId ? peerManagers.find((m) => m.id === managerId) : null;
    const currentManagerRow = managerId
        ? peerRowsCurrent.find((r) => Number(r.manager_user_id) === Number(managerId))
        : null;

    // Помесячная история выбранного менеджера за текущий и прошлый год (для среднего за год, MoM и YoY)
    let ownYearAvg = {};
    let prevMonthRow = null;
    let prevYearSamePeriodRow = null;
    let prevYearAvg = {};

    if (targetManager) {
        const ownMonthsCurrYear = [];
        for (let m = 1; m <= 12; m += 1) {
            const r = buildManagerMonthOpsRow(
                targetManager,
                year,
                m,
                salesAggMap,
                plans,
                manualMap,
                pfAppsMap,
                bonusPastMap
            );
            if (r.turnover > 0 || r.paid_applications > 0) {
                ownMonthsCurrYear.push(r);
            }
        }
        const ownMonthsPrevYear = [];
        for (let m = 1; m <= 12; m += 1) {
            const r = buildManagerMonthOpsRow(
                targetManager,
                prevYear,
                m,
                salesAggMap,
                plans,
                manualMap,
                pfAppsMap,
                bonusPastMap
            );
            if (r.turnover > 0 || r.paid_applications > 0) {
                ownMonthsPrevYear.push(r);
            }
        }

        const avgOf = (arr, fn) => {
            const vals = arr.map(fn).filter((v) => v != null && Number.isFinite(v));
            if (!vals.length) return null;
            return round2(vals.reduce((a, b) => a + b, 0) / vals.length);
        };

        ownYearAvg = {
            months_count: ownMonthsCurrYear.length,
            turnover: avgOf(ownMonthsCurrYear, (r) => r.turnover),
            avg_check: avgOf(ownMonthsCurrYear, (r) => r.avg_check),
            apps_per_sale: avgOf(ownMonthsCurrYear, (r) => r.effective_apps_per_sale),
            profit_pct: avgOf(ownMonthsCurrYear, (r) => r.profit_pct),
            company_pct: avgOf(ownMonthsCurrYear, (r) => r.company_pct),
        };

        prevYearAvg = {
            months_count: ownMonthsPrevYear.length,
            turnover: avgOf(ownMonthsPrevYear, (r) => r.turnover),
            avg_check: avgOf(ownMonthsPrevYear, (r) => r.avg_check),
            apps_per_sale: avgOf(ownMonthsPrevYear, (r) => r.effective_apps_per_sale),
            profit_pct: avgOf(ownMonthsPrevYear, (r) => r.profit_pct),
            company_pct: avgOf(ownMonthsPrevYear, (r) => r.company_pct),
        };

        if (month) {
            const pm = month > 1 ? month - 1 : 12;
            const py = month > 1 ? year : prevYear;
            prevMonthRow = buildManagerMonthOpsRow(
                targetManager,
                py,
                pm,
                salesAggMap,
                plans,
                manualMap,
                pfAppsMap,
                bonusPastMap
            );
            prevYearSamePeriodRow = buildManagerMonthOpsRow(
                targetManager,
                prevYear,
                month,
                salesAggMap,
                plans,
                manualMap,
                pfAppsMap,
                bonusPastMap
            );
        } else {
            prevYearSamePeriodRow = aggregateManagerMonths(
                targetManager,
                prevYear,
                monthsInScope,
                salesAggMap,
                plans,
                manualMap,
                pfAppsMap,
                bonusPastMap
            );
        }
    }

    function enrichBenchmark(key, label, unit, lowerIsBetter, getter, ownYearAvgVal, prevMonthVal, prevYearSameVal, prevYearAvgVal) {
        const base = managerId
            ? rankPeerMetric(activePeerRows, managerId, getter, lowerIsBetter, includeLeaderNames)
            : null;
        if (!base) return null;
        return Object.assign({}, base, {
            key,
            label,
            unit,
            own_year_avg: ownYearAvgVal,
            vs_year_avg_delta: computeDelta(base.value, ownYearAvgVal),
            prev_month_value: prevMonthVal,
            mom_delta: computeDelta(base.value, prevMonthVal),
            prev_year_same_period: prevYearSameVal,
            prev_year_avg: prevYearAvgVal,
            yoy_delta: computeDelta(
                base.value,
                prevYearSameVal != null && prevYearSameVal !== 0 ? prevYearSameVal : prevYearAvgVal
            ),
        });
    }

    const benchmarks = managerId
        ? {
              apps_per_sale: enrichBenchmark(
                  'apps_per_sale',
                  'Отношение продаж к заявкам*',
                  'заявок/счёт',
                  true,
                  (r) => (r.effective_apps_per_sale != null && r.effective_apps_per_sale > 0 ? r.effective_apps_per_sale : null),
                  ownYearAvg.apps_per_sale,
                  prevMonthRow ? prevMonthRow.effective_apps_per_sale : null,
                  prevYearSamePeriodRow ? prevYearSamePeriodRow.effective_apps_per_sale : null,
                  prevYearAvg.apps_per_sale
              ),
              avg_check: enrichBenchmark(
                  'avg_check',
                  'Средний чек',
                  '₽',
                  false,
                  (r) => (r.avg_check != null && r.avg_check > 0 ? r.avg_check : null),
                  ownYearAvg.avg_check,
                  prevMonthRow ? prevMonthRow.avg_check : null,
                  prevYearSamePeriodRow ? prevYearSamePeriodRow.avg_check : null,
                  prevYearAvg.avg_check
              ),
              company_pct: enrichBenchmark(
                  'company_pct',
                  '% от оборота с вычетом зарплат',
                  '%',
                  false,
                  (r) => (r.turnover > 0 && r.company_pct != null ? round2(r.company_pct) : null),
                  ownYearAvg.company_pct,
                  prevMonthRow && prevMonthRow.turnover > 0 ? round2(prevMonthRow.company_pct) : null,
                  prevYearSamePeriodRow && prevYearSamePeriodRow.turnover > 0 ? round2(prevYearSamePeriodRow.company_pct) : null,
                  prevYearAvg.company_pct
              ),
              profit_pct: enrichBenchmark(
                  'profit_pct',
                  'Общий % прибыли за месяц',
                  '%',
                  false,
                  (r) => (r.turnover > 0 && r.profit_pct != null ? round2(r.profit_pct) : null),
                  ownYearAvg.profit_pct,
                  prevMonthRow && prevMonthRow.turnover > 0 ? round2(prevMonthRow.profit_pct) : null,
                  prevYearSamePeriodRow && prevYearSamePeriodRow.turnover > 0 ? round2(prevYearSamePeriodRow.profit_pct) : null,
                  prevYearAvg.profit_pct
              ),
              turnover: enrichBenchmark(
                  'turnover',
                  'Оборот за период',
                  '₽',
                  false,
                  (r) => (r.turnover > 0 ? r.turnover : null),
                  ownYearAvg.turnover,
                  prevMonthRow && prevMonthRow.turnover > 0 ? prevMonthRow.turnover : null,
                  prevYearSamePeriodRow && prevYearSamePeriodRow.turnover > 0 ? prevYearSamePeriodRow.turnover : null,
                  prevYearAvg.turnover
              ),
          }
        : null;

    const planLadder = buildPlanLadder(planInfo, totals, currentManagerRow);

    const recommendations = managerId
        ? buildRecommendations({
              periodLabel,
              isSingleMonth: !!month,
              currentRow: currentManagerRow,
              benchmarks: benchmarks || {},
              planLadder,
              includeLeaderNames,
          })
        : [];

    const fEx = nz(totals.amount_ex_delivery);
    const fStock = nz(totals.amount_incl_stock);
    const fDel = nz(totals.delivery_to_us);
    const fDiff = nz(totals.diff);
    const fBonus = nz(totals.bonus);
    const fPctR = fEx > 0 ? round2((fDiff / fEx) * 100) : null;
    const fStockShare = fEx > 0 ? round1((fStock / fEx) * 100) : null;
    const fDelShare = fEx > 0 ? round2((fDel / fEx) * 100) : null;

    return {
        period_label: periodLabel,
        year,
        month,
        manager_user_id: managerId,
        manager_name: targetManager ? targetManager.full_name : null,
        include_leader_names: includeLeaderNames,
        filter_kpis: {
            amount_ex_delivery: fEx,
            amount_incl_stock: fStock,
            stock_share_pct: fStockShare,
            delivery_to_us: fDel,
            delivery_share_pct: fDelShare,
            diff: fDiff,
            pct_r_avg: fPctR,
            bonus: fBonus,
            paid_orders_count: currentManagerRow ? currentManagerRow.paid_applications : null,
            applications_count: currentManagerRow ? currentManagerRow.effective_applications : null,
            conversion_pct: currentManagerRow ? currentManagerRow.conversion_pct : null,
            avg_check: currentManagerRow ? currentManagerRow.avg_check : null,
            shipped_count: currentManagerRow ? currentManagerRow.shipped_count : null,
            unshipped_count: currentManagerRow ? currentManagerRow.unshipped_count : null,
            unshipped_bonus: currentManagerRow ? currentManagerRow.unshipped_bonus : null,
            bonus_past_paid: currentManagerRow ? currentManagerRow.bonus_past : null,
        },
        plan_ladder: planLadder,
        ops_benchmarks: benchmarks,
        recommendations,
    };
}

module.exports = {
    buildManagerSalesInsights,
};
