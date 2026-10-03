'use strict';

/**
 * Формулы как в Google-таблице менеджера (лист «Системный»!A1 = налог).
 *
 * vatAmount = F * G / (G + 100) при G>0, иначе 0
 * net = (F − K) − vatAmount
 * Разница O = net − net * tax/100 − L
 * % Р. P = O / (F/100)
 * Премия S = O/100 * R
 *
 * F — сумма без доставки, K — сумма с запасом, G — НДС %, L — доставка до нас, R — % МП.
 *
 * % МП. не вводится в строке. Как в Google (F52 = сумма F за месяц):
 * IF(F<500000;0; IF(F<1000000;2; IF(F<1500000;4; IF(F<2000000;6;
 *   IF(F<2500000;8; IF(F<3300000;10; 12))))))
 * Пороги масштабируются, если индивидуальный / отпускной план меньше последнего порога.
 * Шкала периода хранится в steps_json плана года (0, year, 0).
 */

const TAX_PCT = 16;

/** Сумма месяца, при которой % МП. = 12 (последняя ступень Google). */
const DEFAULT_PLAN_AMOUNT = 3300000;

/** Ступени: [порог исключительно меньше, % МП.]. После последнего порога — 12. */
const DEFAULT_PLAN_STEPS = [
    [500000, 0],
    [1000000, 2],
    [1500000, 4],
    [2000000, 6],
    [2500000, 8],
    [3300000, 10],
];
const DEFAULT_PLAN_PCT_MAX = 12;

/** Значения колонки «Наличие договора» (как в Google). */
const HAS_CONTRACT_VALUES = ['Обычный договор', 'Нет', 'Договор-Счет'];

/** Значения колонки «Статус». */
const STATUS_VALUES = ['Заказан у поставщика', 'Отгружен', 'Частично отгружен', 'Возврат средств'];

function normStatus(v) {
    if (v == null) return '';
    const s = String(v).trim();
    if (!s) return '';
    const low = s.toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ');
    const aliases = {
        отгружен: 'Отгружен',
        отгрузка: 'Отгружен',
        'частично отгружен': 'Частично отгружен',
        частичная: 'Частично отгружен',
        'заказан у поставщика': 'Заказан у поставщика',
        заказан: 'Заказан у поставщика',
        заказ: 'Заказан у поставщика',
        'возврат средств': 'Возврат средств',
        возврат: 'Возврат средств',
    };
    if (aliases[low]) return aliases[low];
    const hit = STATUS_VALUES.find((x) => x.toLowerCase().replace(/ё/g, 'е') === low);
    return hit || s.slice(0, 64);
}

function normHasContract(v) {
    if (v === true || v === 1) return 'Обычный договор';
    if (v === false || v === 0) return 'Нет';
    if (v == null) return '';
    const s = String(v).trim();
    if (!s) return '';
    const low = s
        .toLowerCase()
        .replace(/ё/g, 'е')
        .replace(/\s+/g, ' ')
        .replace(/\s*-\s*/g, '-');
    if (low === '0' || low === 'нет' || low === 'no' || low === 'false') return 'Нет';
    if (low === 'договор-счет' || low === 'договор счет') return 'Договор-Счет';
    if (
        low === '1' ||
        low === 'да' ||
        low === 'yes' ||
        low === 'true' ||
        low === 'обычный договор' ||
        low === 'обычный'
    ) {
        return 'Обычный договор';
    }
    const hit = HAS_CONTRACT_VALUES.find((x) => x.toLowerCase().replace(/ё/g, 'е') === low);
    return hit || s.slice(0, 128);
}

function toNum(v) {
    if (v == null || v === '') return null;
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    const s = String(v)
        .trim()
        .replace(/\s/g, '')
        .replace(/\u00a0/g, '')
        .replace(/\u202f/g, '')
        .replace('₽', '')
        .replace('%', '')
        .replace(',', '.');
    if (!s) return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
}

function round2(n) {
    if (n == null || !Number.isFinite(n)) return null;
    return Math.round(n * 100) / 100;
}

function round4(n) {
    if (n == null || !Number.isFinite(n)) return null;
    return Math.round(n * 10000) / 10000;
}

function computeRow(input) {
    const amountEx = toNum(input && input.amount_ex_delivery);
    const amountIncl = toNum(input && input.amount_incl_stock);
    const delivery = toNum(input && input.delivery_to_us);
    const vat = toNum(input && input.vat);
    const pctMp = toNum(input && input.pct_mp);
    const tax = toNum(input && input.tax_pct);
    const taxPct = tax == null ? TAX_PCT : tax;

    const F = amountEx == null ? 0 : amountEx;
    const K = amountIncl == null ? 0 : amountIncl;
    const L = delivery == null ? 0 : delivery;
    const G = vat == null ? 0 : vat;
    const vatAmount = G ? (F * G) / (G + 100) : 0;
    const net = F - K - vatAmount;
    const diff = round2(net - (net / 100) * taxPct - L);

    let pctR = null;
    if (amountEx != null && amountEx !== 0) {
        pctR = round4(diff / (amountEx / 100));
    }

    const bonus = pctMp == null ? 0 : round2((diff / 100) * pctMp);

    return {
        amount_ex_delivery: amountEx,
        amount_incl_stock: amountIncl,
        delivery_to_us: delivery,
        vat,
        pct_mp: pctMp,
        tax_pct: taxPct,
        diff,
        pct_r: pctR,
        bonus,
    };
}

function planAmountOrDefault(planAmount) {
    const n = toNum(planAmount);
    if (n == null || n <= 0) return DEFAULT_PLAN_AMOUNT;
    return n;
}

function cloneDefaultSteps() {
    return {
        steps: DEFAULT_PLAN_STEPS.map(([max, pct]) => [max, pct]),
        pct_max: DEFAULT_PLAN_PCT_MAX,
    };
}

function normalizePlanSteps(input) {
    if (input == null || input === '') return cloneDefaultSteps();
    let raw = input;
    if (typeof raw === 'string') {
        try {
            raw = JSON.parse(raw);
        } catch (_) {
            return cloneDefaultSteps();
        }
    }
    let list = [];
    let pctMax = DEFAULT_PLAN_PCT_MAX;
    if (Array.isArray(raw)) {
        list = raw;
    } else if (raw && typeof raw === 'object') {
        list = Array.isArray(raw.steps) ? raw.steps : [];
        const p = toNum(raw.pct_max);
        if (p != null && p >= 0) pctMax = p;
    } else {
        return cloneDefaultSteps();
    }
    const out = [];
    list.forEach((item) => {
        const max = Array.isArray(item) ? toNum(item[0]) : toNum(item && item.max);
        const pct = Array.isArray(item) ? toNum(item[1]) : toNum(item && item.pct);
        if (max == null || max <= 0 || pct == null || pct < 0) return;
        out.push([round2(max), pct]);
    });
    out.sort((a, b) => a[0] - b[0]);
    if (!out.length) return cloneDefaultSteps();
    return { steps: out, pct_max: pctMax };
}

function parseStoredSteps(raw) {
    if (raw == null || raw === '') return null;
    if (typeof raw === 'string' && !String(raw).trim()) return null;
    try {
        const n = normalizePlanSteps(raw);
        return n && n.steps && n.steps.length ? n : null;
    } catch (_) {
        return null;
    }
}

function stepsToJson(norm) {
    const n = normalizePlanSteps(norm);
    return JSON.stringify({ steps: n.steps, pct_max: n.pct_max });
}

function effectiveSteps(stepsSpec, planAmount) {
    const n = stepsSpec && (stepsSpec.steps || Array.isArray(stepsSpec))
        ? normalizePlanSteps(stepsSpec)
        : cloneDefaultSteps();
    const last = n.steps[n.steps.length - 1][0];
    const plan = planAmountOrDefault(planAmount);
    if (!last || Math.abs(last - plan) < 0.5) return n;
    const scale = plan / last;
    return {
        steps: n.steps.map(([max, pct]) => [round2(max * scale), pct]),
        pct_max: n.pct_max,
    };
}

function scaledPlanSteps(planAmount, stepsSpec) {
    return effectiveSteps(stepsSpec, planAmount).steps;
}

/**
 * % МП. по итогу продаж за месяц (сумма «без доставки»).
 * Сравнение строгое «меньше порога», как IF в таблице.
 * stepsSpec — пороги периода; если план меньше последнего порога, ступени масштабируются.
 */
function pctMpFromMonthTotal(monthTotal, planAmount, stepsSpec) {
    const t = toNum(monthTotal);
    const sum = t == null ? 0 : t;
    const used = effectiveSteps(stepsSpec, planAmount);
    for (let i = 0; i < used.steps.length; i += 1) {
        if (sum < used.steps[i][0]) return used.steps[i][1];
    }
    return used.pct_max;
}

module.exports = {
    TAX_PCT,
    DEFAULT_PLAN_AMOUNT,
    DEFAULT_PLAN_STEPS,
    DEFAULT_PLAN_PCT_MAX,
    toNum,
    round2,
    computeRow,
    planAmountOrDefault,
    cloneDefaultSteps,
    normalizePlanSteps,
    parseStoredSteps,
    stepsToJson,
    effectiveSteps,
    scaledPlanSteps,
    pctMpFromMonthTotal,
    HAS_CONTRACT_VALUES,
    normHasContract,
    STATUS_VALUES,
    normStatus,
};
