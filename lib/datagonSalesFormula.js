'use strict';

/**
 * «Формула продаж» — расчёт предлагаемого неснижаемого остатка (аналог Lagerplus,
 * адаптированный под ежедневные продажи МС: период W календарных дней).
 *
 * Базовая линия: sumQty(W) * replenishment_coef
 * (в legacy при периодах 15 дней coef подбирался к желаемому «запасу в днях» / длина окна).
 *
 * Цена «для маркетов» — первая цена из `prices[]`, у которой в названии есть «маркет» (без учёта регистра).
 */

function num(v, def) {
    const n = Number(v);
    return Number.isFinite(n) ? n : def;
}

function parseFormulaSettings(appSettings) {
    const a = appSettings || {};
    return {
        replenishmentCoef: num(a.sales_formula_replenishment_coef, 1 / 3),
        salesWindowDays: Math.max(7, Math.min(365 * 2, Math.round(num(a.sales_formula_sales_window_days, 90)))),
        absenceAnalysisDays: Math.max(7, Math.min(365 * 3, Math.round(num(a.sales_formula_absence_analysis_days, 210)))),
        rareBaseQty: Math.max(0, Math.round(num(a.sales_formula_rare_base_qty, 2))),
        /** Порог «редкого» по средним продажам, шт/день (в legacy часто использовали «≤ 1»). */
        rareAvgMax: Math.max(0, num(a.sales_formula_rare_avg_max, 1)),
        expensiveThresholdRub: Math.max(0, num(a.sales_formula_expensive_rare_threshold_rub, 50000)),
        expensiveRareMinQty: Math.max(0, Math.round(num(a.sales_formula_expensive_rare_min_qty, 1))),
        maxChangeCoef: Math.max(1, num(a.sales_formula_max_change_coef, 1.6)),
        incompletePackPct: Math.max(0, Math.min(100, num(a.sales_formula_incomplete_pack_pct, 10))),
        economyEnabled: num(a.sales_formula_economy_enabled, 0) ? true : false,
        economyAbsenceWindowDays: Math.max(7, Math.round(num(a.sales_formula_economy_absence_window_days, 90))),
        economyMaxAbsencePct: Math.max(0, Math.min(100, num(a.sales_formula_economy_max_absence_pct, 6))),
        economyTargetCoverDays: Math.max(1, Math.round(num(a.sales_formula_economy_target_cover_days, 18))),
    };
}

function pickMarketPriceRub(prices) {
    if (!Array.isArray(prices)) return null;
    for (const p of prices) {
        const name = String(p?.name || '').toLowerCase();
        if (name.includes('маркет')) {
            const v = num(p.value, NaN);
            if (Number.isFinite(v) && v >= 0) return v;
        }
    }
    return null;
}

/**
 * @param {object} opts
 * @param {object} opts.settings — результат parseFormulaSettings
 * @param {number} opts.sumQty — сумма quantity за период продаж W
 * @param {number} opts.absenceDistinctDays — COUNT(DISTINCT ts_date) за absenceAnalysisDays
 * @param {number} opts.economyAbsenceDistinctDays — DISTINCT за economyAbsenceWindowDays
 * @param {number|null} opts.marketPriceRub
 * @param {number} opts.multiplicity
 * @param {number} opts.stockQty — текущий остаток (для подсказки неполной упаковки)
 * @param {number} opts.prevBaseline — опорный неснижаемый (override / МС)
 * @param {string} [opts.prevBaselineSource] — откуда взят опорный неснижаемый (для справки)
 * @returns {{ proposed_min_stock: number, warnings: string[], inputs: object, detail: { equation_stages: object[] } }}
 */
function computeSalesFormula(opts) {
    const s = opts.settings;
    const warnings = [];
    const W = s.salesWindowDays;
    const sumQty = Math.max(0, num(opts.sumQty, 0));
    const avgDaily = W > 0 ? sumQty / W : 0;

    const absenceWin = s.absenceAnalysisDays;
    const absenceDistinct = Math.max(0, Math.round(num(opts.absenceDistinctDays, 0)));
    const absenceRate = absenceWin > 0 ? absenceDistinct / absenceWin : 0;

    const econWin = s.economyAbsenceWindowDays;
    const econDistinct = Math.max(0, Math.round(num(opts.economyAbsenceDistinctDays, 0)));
    const econPct = econWin > 0 ? (econDistinct / econWin) * 100 : 0;

    const multiplicity = Math.max(0, num(opts.multiplicity, 0));
    const stockQty = num(opts.stockQty, 0);
    const prevBaseline = Math.max(0, num(opts.prevBaseline, 0));
    const marketPriceRub = opts.marketPriceRub != null && Number.isFinite(opts.marketPriceRub) ? opts.marketPriceRub : null;

    const prevBaselineSource = String(opts.prevBaselineSource || 'ms_export.min_stock').trim() || 'ms_export.min_stock';

    let proposal = sumQty * s.replenishmentCoef;
    const draftReplenish = proposal;

    const rareByAvg = avgDaily <= s.rareAvgMax + 1e-12;
    let economyCapped = false;
    let economySkippedTooManyAbsences = false;
    let expensiveLifted = false;
    let maxJumpApplied = false;

    if (rareByAvg) {
        proposal = s.rareBaseQty;
    }

    const afterRareProposal = proposal;

    if (s.economyEnabled && econWin > 0) {
        if (econPct <= s.economyMaxAbsencePct + 1e-9) {
            const capEco = avgDaily * s.economyTargetCoverDays;
            proposal = Math.min(proposal, capEco);
            economyCapped = true;
        } else {
            economySkippedTooManyAbsences = true;
        }
    }

    const afterEconomyProposal = proposal;

    if (marketPriceRub != null && marketPriceRub >= s.expensiveThresholdRub) {
        const before = proposal;
        proposal = Math.max(proposal, s.expensiveRareMinQty);
        if (proposal > before + 1e-9) {
            expensiveLifted = true;
        }
    }

    const afterExpensiveProposal = proposal;

    if (prevBaseline > 0 && proposal > prevBaseline * s.maxChangeCoef + 1e-9) {
        const capped = prevBaseline * s.maxChangeCoef;
        warnings.push(
            `Рост ограничен коэффициентом максимального изменения (${s.maxChangeCoef}× от текущего неснижаемого ${prevBaseline}).`,
        );
        proposal = capped;
        maxJumpApplied = true;
    }

    const beforeCeilProposal = proposal;

    const proposed = Math.max(0, Math.ceil(proposal - 1e-12));

    const fmtStoryNum = (v) => {
        const n = Number(v);
        if (!Number.isFinite(n)) return '—';
        if (Math.abs(n) < 1e-12) return '0';
        const r = Math.round(n);
        if (Math.abs(n - r) < 1e-9) return String(r);
        return String(Number.parseFloat(n.toFixed(6)));
    };
    const capEcoStory = avgDaily * s.economyTargetCoverDays;

    let eqN = 0;
    const equation_stages = [];
    const pushEq = (id, titleSuffix, template, values, note) => {
        eqN += 1;
        equation_stages.push({
            id,
            order: eqN,
            title: `Этап ${eqN}. ${titleSuffix}`,
            template,
            values,
            note: note || '',
        });
    };

    pushEq(
        'avg_daily',
        'Средние продажи',
        'Продажи за период ÷ дней в периоде (W)',
        `${fmtStoryNum(sumQty)} ÷ ${W} = ${fmtStoryNum(avgDaily)} шт/день`,
        `W = ${W} календарных дней (настройка «Окно продаж»). Сумма quantity — проведённые отгрузки, прямые + через комплекты (если товар не комплект).`,
    );

    if (rareByAvg) {
        pushEq(
            'rare',
            'Редкий товар',
            `Средние ≤ порога (${fmtStoryNum(s.rareAvgMax)} шт/день) → базовый запас`,
            `${fmtStoryNum(avgDaily)} ≤ ${fmtStoryNum(s.rareAvgMax)} → ${s.rareBaseQty} шт`,
            'Вместо «продажи за период × k».',
        );
    } else {
        pushEq(
            'draft',
            'Черновик по спросу',
            'Продажи за период × коэффициент пополнения (k)',
            `${fmtStoryNum(sumQty)} × ${fmtStoryNum(s.replenishmentCoef)} = ${fmtStoryNum(draftReplenish)}`,
            `k = ${fmtStoryNum(s.replenishmentCoef)} (настройка «Коэффициент пополнения»).`,
        );
    }

    if (s.economyEnabled && econWin > 0) {
        if (economyCapped) {
            pushEq(
                'economy_cap',
                'Режим экономии',
                'min(черновик, средние × дни запаса при экономии)',
                `min(${fmtStoryNum(afterRareProposal)}, ${fmtStoryNum(avgDaily)} × ${s.economyTargetCoverDays}) = min(${fmtStoryNum(afterRareProposal)}, ${fmtStoryNum(capEcoStory)}) = ${fmtStoryNum(afterEconomyProposal)}`,
                `За ${econWin} дн.: ${econDistinct} разн. дат «нуля», доля ${econPct.toFixed(2)}% ≤ ${s.economyMaxAbsencePct}% — крышка действует.`,
            );
        } else if (economySkippedTooManyAbsences) {
            pushEq(
                'economy_skip',
                'Режим экономии',
                'Крышка не применяется — слишком высокая доля дней отсутствия',
                `${econPct.toFixed(2)}% > ${s.economyMaxAbsencePct}% → черновик без изменений: ${fmtStoryNum(afterEconomyProposal)}`,
                `Период экономии ${econWin} дн., разн. дат «нуля»: ${econDistinct}.`,
            );
        }
    }

    if (multiplicity > 1 && s.incompletePackPct > 0) {
        pushEq(
            'incomplete_pack',
            'Неполная упаковка (справочно)',
            'На черновик формулы не влияет',
            `Кратность ${multiplicity}, остаток ${stockQty}, настройка «неполная упаковка» ${s.incompletePackPct}%`,
            'Учёт в днях «нуля» по дневным срезам — в развитии.',
        );
    }

    if (marketPriceRub != null && marketPriceRub >= s.expensiveThresholdRub) {
        pushEq(
            'expensive',
            'Дорогой товар (цена «маркет»)',
            'max(черновик, минимум для дорогих)',
            expensiveLifted
                ? `max(${fmtStoryNum(afterEconomyProposal)}, ${s.expensiveRareMinQty}) = ${fmtStoryNum(afterExpensiveProposal)}`
                : `max(${fmtStoryNum(afterEconomyProposal)}, ${s.expensiveRareMinQty}) = ${fmtStoryNum(afterExpensiveProposal)} (черновик уже ≥ минимума)`,
            `Цена «маркет» ${fmtStoryNum(marketPriceRub)} ₽ ≥ порога ${fmtStoryNum(s.expensiveThresholdRub)} ₽.`,
        );
    }

    if (prevBaseline > 0) {
        const capJump = prevBaseline * s.maxChangeCoef;
        if (maxJumpApplied) {
            pushEq(
                'max_jump',
                'Ограничение скачка вверх',
                'min(черновик, опорный неснижаемый × M)',
                `min(${fmtStoryNum(afterExpensiveProposal)}, ${fmtStoryNum(prevBaseline)} × ${fmtStoryNum(s.maxChangeCoef)}) = min(${fmtStoryNum(afterExpensiveProposal)}, ${fmtStoryNum(capJump)}) = ${fmtStoryNum(beforeCeilProposal)}`,
                `Опорный ${fmtStoryNum(prevBaseline)} (${prevBaselineSource}), M = ${fmtStoryNum(s.maxChangeCoef)}.`,
            );
        } else {
            pushEq(
                'max_jump_skip',
                'Ограничение скачка',
                'min(черновик, опорный × M) — без обрезки',
                `Потолок ${fmtStoryNum(capJump)}, черновик ${fmtStoryNum(afterExpensiveProposal)}`,
                `Опорный ${fmtStoryNum(prevBaseline)} (${prevBaselineSource}).`,
            );
        }
    }

    pushEq(
        'ceil',
        'Итог',
        'Округление вверх до целых (не ниже нуля)',
        `ceil(max(0, ${fmtStoryNum(beforeCeilProposal)})) = ${proposed} шт`,
        'Предлагаемый неснижаемый (Датагон) для карточки.',
    );

    const detail = { equation_stages };

    return {
        proposed_min_stock: proposed,
        warnings,
        detail,
        inputs: {
            sales_window_days: W,
            sum_qty_window: sumQty,
            avg_daily: avgDaily,
            absence_window_days: absenceWin,
            absence_distinct_days: absenceDistinct,
            absence_rate: absenceRate,
            economy_absence_window_days: econWin,
            economy_absence_distinct_days: econDistinct,
            economy_absence_pct: econPct,
            market_price_rub: marketPriceRub,
            multiplicity,
            stock_qty: stockQty,
            prev_baseline: prevBaseline,
            prev_baseline_source: prevBaselineSource,
        },
    };
}

module.exports = {
    parseFormulaSettings,
    pickMarketPriceRub,
    computeSalesFormula,
};
