'use strict';

/**
 * Формулы операционного листа (колонки A–S Google «Операционный лист»).
 * Auto-поля считаются из журнала менеджеров; manual — из dg_ops_sheet_manual.
 */

const { toNum, round2, TAX_PCT } = require('./managerSalesCalc');

const MONTH_LABELS = [
    '',
    'ЯНВАРЬ',
    'ФЕВРАЛЬ',
    'МАРТ',
    'АПРЕЛЬ',
    'МАЙ',
    'ИЮНЬ',
    'ИЮЛЬ',
    'АВГУСТ',
    'СЕНТЯБРЬ',
    'ОКТЯБРЬ',
    'НОЯБРЬ',
    'ДЕКАБРЬ',
];

const COLUMN_LEGEND = [
    { key: 'manager_name', label: 'Менеджер', kind: 'auto' },
    { key: 'turnover', label: 'Оборот', kind: 'auto', formula: 'SUM(amount_ex_delivery) credit-менеджера за месяц' },
    {
        key: 'profit_before_tax',
        label: 'Прибыль до вычета налога',
        kind: 'auto',
        formula: 'SUM(net − delivery), net = F − K − vatAmount (без 16%)',
    },
    {
        key: 'profit_after_tax',
        label: 'Прибыль с вычетом налога',
        kind: 'auto',
        formula: 'SUM(diff) — уже с налогом 16%',
    },
    {
        key: 'profit_pct',
        label: 'Общий % прибыли за месяц',
        kind: 'derived',
        formula: 'profit_after_tax / turnover × 100',
    },
    {
        key: 'bonus_current',
        label: 'Премия за текущий месяц',
        kind: 'auto',
        formula: 'SUM(diff) × pctMpFromMonthTotal(turnover, plan) / 100',
    },
    {
        key: 'applications_count',
        label: 'Кол-во заявок',
        kind: 'auto',
        formula:
            'COUNT задач Planfix по постановщику и дате создания; статусы из «Статус Сделки/Письма», попадающие в корзины с галкой «в кол-во заявок»',
    },
    { key: 'coefficient', label: 'Коэффициент', kind: 'manual' },
    {
        key: 'paid_applications',
        label: 'Оплаченные заявки',
        kind: 'auto',
        formula: 'COUNT DISTINCT № нашего счёта за месяц (позиции НДС одного счёта — одна продажа); без номера счёта — по строке',
    },
    {
        key: 'apps_per_sale',
        label: 'Отношение продаж к заявкам',
        kind: 'derived',
        formula: 'applications_count / paid_applications',
    },
    {
        key: 'avg_check',
        label: 'Средний чек',
        kind: 'derived',
        formula: 'turnover / paid_applications',
    },
    {
        key: 'bonus_past',
        label: 'Премия с учетом заказов с прошлых месяцев',
        kind: 'manual',
    },
    {
        key: 'salary',
        label: 'Оклад с учетом отработанных дней',
        kind: 'manual',
    },
    {
        key: 'fact_profit',
        label: 'Фактическая прибыль за текущий месяц',
        kind: 'derived',
        formula: 'profit_after_tax − bonus_current − salary',
    },
    {
        key: 'salary_paid',
        label: 'Зарплата с учетом премии за прошлые месяца',
        kind: 'derived',
        formula: 'salary + bonus_past',
    },
    {
        key: 'company_profit',
        label: 'Прибыль фирмы с вычетом оклада и премии',
        kind: 'derived',
        formula: 'profit_after_tax − salary_paid',
    },
    {
        key: 'company_pct',
        label: '% от оборота с вычетом зарплат',
        kind: 'derived',
        formula: 'company_profit / turnover × 100',
    },
    {
        key: 'plan_status',
        label: 'План',
        kind: 'auto',
        formula: 'выполнен если turnover ≥ plan_amount, иначе не выполнен',
    },
];

function round4(n) {
    if (n == null || !Number.isFinite(n)) return null;
    return Math.round(n * 10000) / 10000;
}

function nz(n) {
    const v = toNum(n);
    return v == null ? 0 : v;
}

/** Прибыль до налога по одной сделке: net − L (без 16%). */
function profitBeforeTaxRow(amountEx, amountIncl, vat, delivery) {
    const F = nz(amountEx);
    const K = nz(amountIncl);
    const L = nz(delivery);
    const G = nz(vat);
    const vatAmount = G ? (F * G) / (G + 100) : 0;
    const net = F - K - vatAmount;
    return round2(net - L);
}

function deriveMetrics(base) {
    const turnover = nz(base.turnover);
    const profitAfter = nz(base.profit_after_tax);
    const bonusCurrent = nz(base.bonus_current);
    const salary = nz(base.salary);
    const bonusPast = nz(base.bonus_past);
    const apps = toNum(base.applications_count);
    const paid = toNum(base.paid_applications);

    let profitPct = null;
    if (turnover !== 0) profitPct = round4((profitAfter / turnover) * 100);

    let appsPerSale = null;
    if (paid != null && paid !== 0 && apps != null) appsPerSale = round4(apps / paid);

    let avgCheck = null;
    if (paid != null && paid !== 0) avgCheck = round2(turnover / paid);

    const factProfit = round2(profitAfter - bonusCurrent - salary);
    const salaryPaid = round2(salary + bonusPast);
    const companyProfit = round2(profitAfter - salaryPaid);

    let companyPct = null;
    if (turnover !== 0) companyPct = round4((companyProfit / turnover) * 100);

    const planAmount = toNum(base.plan_amount);
    let planStatus = null;
    if (planAmount != null && planAmount > 0) {
        planStatus = turnover >= planAmount ? 'выполнен' : 'не выполнен';
    }

    return {
        profit_pct: profitPct,
        apps_per_sale: appsPerSale,
        avg_check: avgCheck,
        fact_profit: factProfit,
        salary_paid: salaryPaid,
        company_profit: companyProfit,
        company_pct: companyPct,
        plan_status: planStatus,
    };
}

function emptyAuto() {
    return {
        turnover: 0,
        profit_before_tax: 0,
        profit_after_tax: 0,
        bonus_current: 0,
        paid_applications: 0,
        plan_amount: null,
        pct_mp: 0,
    };
}

function emptyManual() {
    return {
        applications_count: null,
        coefficient: null,
        bonus_past: null,
        salary: null,
    };
}

function buildRow(manager, auto, manual) {
    const a = Object.assign(emptyAuto(), auto || {});
    const m = Object.assign(emptyManual(), manual || {});
    const derived = deriveMetrics({
        turnover: a.turnover,
        profit_after_tax: a.profit_after_tax,
        bonus_current: a.bonus_current,
        plan_amount: a.plan_amount,
        applications_count: m.applications_count,
        paid_applications: a.paid_applications,
        bonus_past: m.bonus_past,
        salary: m.salary,
    });
    return {
        manager_user_id: manager.id,
        manager_name: manager.full_name || manager.username || '',
        username: manager.username || '',
        is_archived: !!manager.is_archived,
        turnover: round2(nz(a.turnover)),
        profit_before_tax: round2(nz(a.profit_before_tax)),
        profit_after_tax: round2(nz(a.profit_after_tax)),
        profit_pct: derived.profit_pct,
        bonus_current: round2(nz(a.bonus_current)),
        applications_count: m.applications_count,
        coefficient: m.coefficient,
        paid_applications: Math.round(nz(a.paid_applications)),
        apps_per_sale: derived.apps_per_sale,
        avg_check: derived.avg_check,
        bonus_past: m.bonus_past,
        salary: m.salary,
        fact_profit: derived.fact_profit,
        salary_paid: derived.salary_paid,
        company_profit: derived.company_profit,
        company_pct: derived.company_pct,
        plan_amount: a.plan_amount,
        plan_status: derived.plan_status,
        pct_mp: a.pct_mp != null ? a.pct_mp : 0,
    };
}

function sumNullableInt(rows, key) {
    let any = false;
    let s = 0;
    (rows || []).forEach((r) => {
        const v = toNum(r[key]);
        if (v == null) return;
        any = true;
        s += v;
    });
    return any ? Math.round(s) : null;
}

function sumNullableMoney(rows, key) {
    let any = false;
    let s = 0;
    (rows || []).forEach((r) => {
        const v = toNum(r[key]);
        if (v == null) return;
        any = true;
        s += v;
    });
    return any ? round2(s) : null;
}

/** ИТОГО: суммы + пересчёт % / отношений от сумм; coefficient и plan_status пустые. */
function buildTotals(rows) {
    const list = rows || [];
    const turnover = round2(list.reduce((a, r) => a + nz(r.turnover), 0));
    const profitBefore = round2(list.reduce((a, r) => a + nz(r.profit_before_tax), 0));
    const profitAfter = round2(list.reduce((a, r) => a + nz(r.profit_after_tax), 0));
    const bonusCurrent = round2(list.reduce((a, r) => a + nz(r.bonus_current), 0));
    const apps = sumNullableInt(list, 'applications_count');
    const paid = sumNullableInt(list, 'paid_applications');
    const bonusPast = sumNullableMoney(list, 'bonus_past');
    const salary = sumNullableMoney(list, 'salary');

    const derived = deriveMetrics({
        turnover,
        profit_after_tax: profitAfter,
        bonus_current: bonusCurrent,
        plan_amount: null,
        applications_count: apps,
        paid_applications: paid,
        bonus_past: bonusPast == null ? 0 : bonusPast,
        salary: salary == null ? 0 : salary,
    });

    return {
        manager_user_id: null,
        manager_name: 'ИТОГО',
        is_total: true,
        turnover,
        profit_before_tax: profitBefore,
        profit_after_tax: profitAfter,
        profit_pct: derived.profit_pct,
        bonus_current: bonusCurrent,
        applications_count: apps,
        coefficient: null,
        paid_applications: paid,
        apps_per_sale: derived.apps_per_sale,
        avg_check: derived.avg_check,
        bonus_past: bonusPast,
        salary,
        fact_profit: derived.fact_profit,
        salary_paid: derived.salary_paid,
        company_profit: derived.company_profit,
        company_pct: derived.company_pct,
        plan_amount: null,
        plan_status: null,
        pct_mp: null,
    };
}

module.exports = {
    TAX_PCT,
    MONTH_LABELS,
    COLUMN_LEGEND,
    profitBeforeTaxRow,
    deriveMetrics,
    buildRow,
    buildTotals,
    emptyAuto,
    emptyManual,
    round2,
    round4,
    toNum,
    nz,
};
