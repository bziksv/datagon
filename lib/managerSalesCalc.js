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
 * L — доставка до нас (сумма по поставщикам), R — % МП.
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

/** Подсветка ссылки на счёт поставщика: ключ → подпись для UI и журнала. */
const INVOICE_MARKS = [
    { key: 'black', title: 'Чёрный', label: 'Создан платёж поставщика, который можно оплачивать' },
    { key: 'blue', title: 'Синий', label: 'Платёж оплачен, можно заносить в МойСклад' },
    { key: 'orange', title: 'Оранжевый', label: 'Создан Заказ поставщику — Счёт поставщику — Исходящий платёж/ордер' },
    { key: 'green', title: 'Зелёный', label: 'Товар принят' },
];
const INVOICE_MARK_KEYS = new Set(INVOICE_MARKS.map((x) => x.key));

/** Зелёная отметка «№ нашего счета»: заказ покупателя + счёт + входящий платёж. */
const OUR_INVOICE_MARK_GREEN = 'green';
const OUR_INVOICE_MARK_LABEL = 'Создан заказ покупателя + счёт + входящий платёж';

function ourInvoiceMarkLabel(v) {
    return normOurInvoiceMark(v) === OUR_INVOICE_MARK_GREEN ? `Зелёный: ${OUR_INVOICE_MARK_LABEL}` : '';
}

function normOurInvoiceMark(v) {
    const key = normInvoiceMark(v);
    return key === OUR_INVOICE_MARK_GREEN ? OUR_INVOICE_MARK_GREEN : '';
}

function invoiceMarkLabel(v) {
    const key = normInvoiceMark(v);
    if (!key) return '';
    const hit = INVOICE_MARKS.find((x) => x.key === key);
    return hit ? `${hit.title}: ${hit.label}` : key;
}

function normInvoiceMark(v) {
    if (v == null) return '';
    const s = String(v)
        .trim()
        .toLowerCase()
        .replace(/ё/g, 'е');
    if (!s || s === 'none' || s === '0' || s === 'нет' || s === 'off') return '';
    if (s === 'черный') return 'black';
    if (s === 'синий') return 'blue';
    if (s === 'оранжевый') return 'orange';
    if (s === 'зеленый') return 'green';
    return INVOICE_MARK_KEYS.has(s) ? s : '';
}

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

function splitNonEmptyLines(v) {
    if (v == null || v === '') return [];
    return String(v)
        .split(/\r\n|\n|\r|\u2028|\u2029/)
        .map((s) => s.trim())
        .filter(Boolean);
}

function splitAmountParts(v) {
    if (v == null || v === '') return [];
    if (typeof v === 'number') return Number.isFinite(v) ? [v] : [];
    const s = String(v).trim();
    if (!s) return [];
    const chunks = s
        .split(/\r\n|\n|\r|\u2028|\u2029/)
        .map((x) => x.trim())
        .filter(Boolean);
    if (chunks.length > 1) {
        return chunks.map((c) => toNum(c)).filter((n) => n != null);
    }
    const n = toNum(s);
    return n == null ? [] : [n];
}

function emptySupplier() {
    return {
        amount_incl_stock: null,
        delivery_to_us: null,
        supplier_name: '',
        supplier_invoice_no: '',
        supplier_invoice_url: '',
        invoice_mark: '',
    };
}

function normalizeSupplierItem(item) {
    const x = item && typeof item === 'object' ? item : {};
    return {
        amount_incl_stock: toNum(x.amount_incl_stock),
        delivery_to_us: toNum(x.delivery_to_us),
        supplier_name: String(x.supplier_name == null ? '' : x.supplier_name).trim().slice(0, 255),
        supplier_invoice_no: String(x.supplier_invoice_no == null ? '' : x.supplier_invoice_no).trim().slice(0, 128),
        supplier_invoice_url: String(x.supplier_invoice_url == null ? '' : x.supplier_invoice_url).trim().slice(0, 1024),
        invoice_mark: normInvoiceMark(x.invoice_mark),
    };
}

function parseSuppliersJson(raw) {
    if (!raw) return [];
    if (Array.isArray(raw)) return raw.map(normalizeSupplierItem);
    if (typeof raw === 'string') {
        const t = raw.trim();
        if (!t || t === '[]') return [];
        try {
            const j = JSON.parse(t);
            return Array.isArray(j) ? j.map(normalizeSupplierItem) : [];
        } catch (_) {
            return [];
        }
    }
    return [];
}

function splitSupplierNames(v) {
    const lines = splitNonEmptyLines(v);
    if (lines.length > 1) return lines;
    const s = String(v == null ? '' : v).trim();
    if (!s) return [];
    const bySep = s
        .split(/\s*[|;/]\s*|\s{2,}/)
        .map((t) => t.trim())
        .filter(Boolean);
    if (bySep.length > 1) return bySep;
    return [s];
}

function suppliersFromFlat(row) {
    const names = splitSupplierNames(row && row.supplier_name);
    const nos = splitNonEmptyLines(row && row.supplier_invoice_no);
    const urls = splitNonEmptyLines(row && row.supplier_invoice_url);
    const amts = splitAmountParts(row && row.amount_incl_stock);
    const dels = splitAmountParts(row && row.delivery_to_us);
    const n = Math.max(names.length, nos.length, urls.length, amts.length, dels.length, 1);
    const combinedAmt = amts.length <= 1;
    const combinedDel = dels.length <= 1;
    const list = [];
    for (let i = 0; i < n; i += 1) {
        list.push({
            amount_incl_stock: combinedAmt
                ? i === 0
                    ? amts[0] != null
                        ? amts[0]
                        : toNum(row && row.amount_incl_stock)
                    : null
                : amts[i] != null
                  ? amts[i]
                  : null,
            delivery_to_us: combinedDel
                ? i === 0
                    ? dels[0] != null
                        ? dels[0]
                        : toNum(row && row.delivery_to_us)
                    : null
                : dels[i] != null
                  ? dels[i]
                  : null,
            supplier_name: names[i] || '',
            supplier_invoice_no: nos[i] || '',
            supplier_invoice_url: urls[i] || '',
            invoice_mark: '',
        });
    }
    return list;
}

function hydrateSupplierDeliveries(list, row) {
    const items = (list && list.length ? list : [emptySupplier()]).map(normalizeSupplierItem);
    if (items.some((x) => toNum(x.delivery_to_us) != null)) return items;
    const dels = splitAmountParts(row && row.delivery_to_us);
    const combined = dels.length <= 1;
    return items.map((x, i) =>
        Object.assign({}, x, {
            delivery_to_us: combined
                ? i === 0
                    ? toNum(row && row.delivery_to_us)
                    : null
                : dels[i] != null
                  ? dels[i]
                  : null,
        })
    );
}

/** Старая подсветка была на всю строку — переносим только на первую закупку. */
function hydrateSupplierMarks(list, row) {
    const items = (list && list.length ? list : [emptySupplier()]).map(normalizeSupplierItem);
    if (items.some((x) => x.invoice_mark)) return items;
    const legacy = normInvoiceMark(row && row.invoice_mark);
    if (!legacy) return items;
    return items.map((x, i) => Object.assign({}, x, { invoice_mark: i === 0 ? legacy : '' }));
}

function resolveSuppliersList(row) {
    const fromJson = parseSuppliersJson(row && (row.suppliers || row.suppliers_json));
    const list = fromJson.length ? fromJson : suppliersFromFlat(row);
    return hydrateSupplierMarks(hydrateSupplierDeliveries(list, row), row);
}

function sumSupplierAmounts(list) {
    let s = 0;
    let any = false;
    (list || []).forEach((x) => {
        const n = toNum(x && x.amount_incl_stock);
        if (n != null) {
            s += n;
            any = true;
        }
    });
    return any ? round2(s) : null;
}

function sumSupplierDeliveries(list) {
    let s = 0;
    let any = false;
    (list || []).forEach((x) => {
        const n = toNum(x && x.delivery_to_us);
        if (n != null) {
            s += n;
            any = true;
        }
    });
    return any ? round2(s) : null;
}

function flattenSuppliers(list) {
    const items = (list && list.length ? list : [emptySupplier()]).map(normalizeSupplierItem);
    return {
        suppliers: items,
        suppliers_json: JSON.stringify(items),
        amount_incl_stock: sumSupplierAmounts(items),
        delivery_to_us: sumSupplierDeliveries(items),
        supplier_name: items.map((x) => x.supplier_name).filter(Boolean).join('\n'),
        supplier_invoice_no: items.map((x) => x.supplier_invoice_no).filter(Boolean).join('\n'),
        supplier_invoice_url: items.map((x) => x.supplier_invoice_url).filter(Boolean).join('\n'),
    };
}

function applySuppliersPatch(base, body) {
    let list = resolveSuppliersList(base);
    const src = body && typeof body === 'object' ? body : {};
    if (Array.isArray(src.suppliers)) {
        list = src.suppliers.map(normalizeSupplierItem);
        if (!list.length) list = [emptySupplier()];
    }
    if (src.supplier_remove != null && src.supplier_remove !== '') {
        const rm = Number(src.supplier_remove);
        if (Number.isFinite(rm) && rm >= 0 && list.length > 1) {
            list = list.filter((_, i) => i !== rm);
        }
    }
    if (src.supplier_add === 1 || src.supplier_add === true || src.supplier_add === '1') {
        list = list.concat([emptySupplier()]);
    }
    const hasIdx = Object.prototype.hasOwnProperty.call(src, 'supplier_index');
    const idx = hasIdx ? Number(src.supplier_index) : 0;
    const touchFlat =
        Object.prototype.hasOwnProperty.call(src, 'amount_incl_stock') ||
        Object.prototype.hasOwnProperty.call(src, 'delivery_to_us') ||
        Object.prototype.hasOwnProperty.call(src, 'supplier_name') ||
        Object.prototype.hasOwnProperty.call(src, 'supplier_invoice_no') ||
        Object.prototype.hasOwnProperty.call(src, 'supplier_invoice_url') ||
        Object.prototype.hasOwnProperty.call(src, 'invoice_mark');
    if (touchFlat && !Array.isArray(src.suppliers)) {
        const names = splitNonEmptyLines(src.supplier_name);
        const nos = splitNonEmptyLines(src.supplier_invoice_no);
        const urls = splitNonEmptyLines(src.supplier_invoice_url);
        const amts = splitAmountParts(src.amount_incl_stock);
        const dels = splitAmountParts(src.delivery_to_us);
        const looksMulti = names.length > 1 || nos.length > 1 || urls.length > 1 || amts.length > 1 || dels.length > 1;
        if (!hasIdx && looksMulti && !Object.prototype.hasOwnProperty.call(src, 'invoice_mark')) {
            list = suppliersFromFlat(Object.assign({}, base, src));
        } else if (Number.isFinite(idx) && idx >= 0) {
            while (list.length <= idx) list.push(emptySupplier());
            const cur = Object.assign({}, list[idx]);
            if (Object.prototype.hasOwnProperty.call(src, 'amount_incl_stock')) {
                cur.amount_incl_stock = toNum(src.amount_incl_stock);
            }
            if (Object.prototype.hasOwnProperty.call(src, 'delivery_to_us')) {
                cur.delivery_to_us = toNum(src.delivery_to_us);
            }
            if (Object.prototype.hasOwnProperty.call(src, 'supplier_name')) {
                cur.supplier_name = String(src.supplier_name == null ? '' : src.supplier_name).trim();
            }
            if (Object.prototype.hasOwnProperty.call(src, 'supplier_invoice_no')) {
                cur.supplier_invoice_no = String(src.supplier_invoice_no == null ? '' : src.supplier_invoice_no).trim();
            }
            if (Object.prototype.hasOwnProperty.call(src, 'supplier_invoice_url')) {
                cur.supplier_invoice_url = String(
                    src.supplier_invoice_url == null ? '' : src.supplier_invoice_url
                ).trim();
            }
            if (Object.prototype.hasOwnProperty.call(src, 'invoice_mark')) {
                cur.invoice_mark = normInvoiceMark(src.invoice_mark);
            }
            list[idx] = cur;
        }
    }
    return flattenSuppliers(list);
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
    splitNonEmptyLines,
    emptySupplier,
    parseSuppliersJson,
    suppliersFromFlat,
    resolveSuppliersList,
    sumSupplierAmounts,
    sumSupplierDeliveries,
    flattenSuppliers,
    applySuppliersPatch,
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
    INVOICE_MARKS,
    invoiceMarkLabel,
    normInvoiceMark,
    OUR_INVOICE_MARK_GREEN,
    OUR_INVOICE_MARK_LABEL,
    ourInvoiceMarkLabel,
    normOurInvoiceMark,
};
