'use strict';

/**
 * «Формула продаж» — предлагаемый неснижаемый (Datagon), пошаговая схема v2:
 *
 * 1) Средний спрос за W дн.: avgW = sumQtyW / W (настройка «Продажи за период, дней»).
 * 2) Оценка «упущенных» продаж: дни отсутствия за A × avgW (дни — DISTINCT дат нуля в логе за A дн.).
 * 3) Сумма с учётом отсутствий: adjusted = sumQtyW + missed.
 * 4) Дорогой товар: цена типа с «маркет» в названии > порога (₽).
 * 5) Редкий: если не дорогой и сумма продаж за период W ≤ 1 шт → итог = max(1, значение настройки «Базовый запас для товаров с редкими продажами») и ограничение скачка (0 в настройках не даёт «пустой» рекомендации); при кратности из закупок ≥ 1 шт итог **не ниже** этой кратности (без шага «процент от упаковки»).
 * 6) Иначе черновик до кратности: adjusted × k (настройка «Коэффициент пополнения»). Поля «Базовый запас» и «Базовый запас для дорогих…» в этой цепочке не прибавляются (как в эталонном числовом примере).
 * 7) Кратность из закупок и «Процент от упаковки, %»: при доле хвоста ≤ порога — вниз до кратности; при доле хвоста **> порога** — **вверх** до кратности. Итог **не ниже** кратности из закупок, если есть сигнал спроса: положительный черновик ×k, **или** ненулевая сумма с учётом отсутствий при ненулевом k, **или** (при кратности из закупок ≥ 1 шт) ненулевая сумма с учётом отсутствий — в т.ч. когда k=0 и черновик 0, но adjusted>0. Если после шагов итог всё ещё 0 при adjusted>0 (часто k=0 и кратность < 1 шт) — минимум max(1, sales_formula_rare_base_qty). Далее `max(после округления по доле, multiplicity)`. Если кратность < 1 — округление по доле хвоста не выполняется (`applyPackagingFloor`); дробь < 1 шт перед итоговым floor см. `applySubUnitMinAfterPack`.
 * 8) «Макс. изменение (× к текущему)»: только на повышение относительно опорного неснижаемого (применяется **после** кратности в нередкой ветке; дробный потолок не должен опускать итог ниже кратности закупок — см. `applyFinalMultiplicityIntFloor`).
 * 9) Итог: max(0, floor(…)) в штуках; **редкая ветка:** если после шага 8 в целых штуках получилось меньше эффективного «Базового для редких» (часто при очень маленьком опорном × коэффициенте), итог поднимается до этого минимума — иначе дробный потолок обнулял бы рекомендацию.
 * 10) Поле закупок **«Неснижаемый остаток Датагон»** (`min_stock_dg`): не задаёт опорный baseline для шагов формулы;
 *     если в БД задано значение > 0, **показанный** предлагаемый неснижаемый не может быть ниже него
 *     (`applyMinStockDgFloor`, целые штуки: порог вверх по `ceil` для дробного decimal).
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
        baseQty: Math.max(0, Math.round(num(a.sales_formula_base_qty, 2))),
        rareBaseQty: Math.max(0, Math.round(num(a.sales_formula_rare_base_qty, 2))),
        /** Legacy: не используется в v2 (редкость — по сумме продаж за W ≤ 1 шт). */
        rareAvgMax: Math.max(0, num(a.sales_formula_rare_avg_max, 1)),
        expensiveThresholdRub: Math.max(0, num(a.sales_formula_expensive_rare_threshold_rub, 50000)),
        expensiveRareMinQty: Math.max(0, Math.round(num(a.sales_formula_expensive_rare_min_qty, 1))),
        maxChangeCoef: Math.max(1, num(a.sales_formula_max_change_coef, 1.6)),
        incompletePackPct: Math.max(0, Math.min(100, num(a.sales_formula_incomplete_pack_pct, 80))),
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
 * Человекочитаемое описание источника опорного неснижаемого (этап «макс. пополнения»).
 * @param {string} src
 */
function humanizePrevBaselineSource(src) {
    const x = String(src || '').trim();
    if (!x || x === 'ms_export.min_stock') {
        return 'текущий неснижаемый в МойСклад (поле ms_export.min_stock)';
    }
    if (x === 'override.proposed_min_stock') {
        return 'сохранённый в закупках предлагаемый неснижаемый (dg_purchase_overrides.proposed_min_stock)';
    }
    return `источник опоры: ${x}`;
}

/**
 * Кратность и «Процент от упаковки»: доля хвоста = (p mod mult) / mult.
 * Если доля ≤ порога % — округление **вниз** до целых кратностей; если **строго больше** порога — **вверх** (хвост считаем как полную упаковку).
 */
function applyPackagingFloor(proposed, multiplicity, packPct) {
    const p = Number(proposed);
    if (!Number.isFinite(p) || p <= 0) return 0;
    const mult = Math.max(0, num(multiplicity, 0));
    const pct = Math.max(0, Math.min(100, num(packPct, 0)));
    if (mult < 1 || pct <= 0) return p;
    const fullUnits = Math.floor(p / mult + 1e-12);
    let rem = p - fullUnits * mult;
    if (rem < 1e-9) rem = 0;
    if (rem <= 1e-9) return p;
    const ratio = rem / mult;
    const threshold = pct / 100 + 1e-9;
    if (ratio <= threshold) {
        return fullUnits * mult;
    }
    return Math.ceil(p / mult - 1e-12) * mult;
}

/**
 * Если черновик после ×k > 0, а `proposal` всё ещё < 1 шт (дробь при кратности < 1 / без порога упаковки, или сильное ограничение «Макс. изменение») — поднимаем минимумами редкого/дорогого; иначе floor обнуляет 0.75 и т.п.
 */
function applySubUnitMinAfterPack({
    draftCore,
    proposal,
    packZeroGuard,
    isExpensive,
    s,
    warnings,
    fmtStoryNum,
}) {
    let p = proposal;
    if (!(draftCore > 1e-9) || !(p < 1 - 1e-9)) return p;
    if (!packZeroGuard) {
        p = isExpensive ? s.expensiveRareMinQty : Math.max(1, s.rareBaseQty);
        const minName = isExpensive
            ? 'Базовый запас для дорогих товаров с редкими продажами'
            : 'Базовый запас для товаров с редкими продажами';
        warnings.push(
            `Черновик после ×k положителен (${fmtStoryNum(draftCore)} шт), но до целых штук получилось бы < 1 шт (кратность < 1 / без порога упаковки — дробный остаток, или ограничение «Макс. изменение»); подставлен минимум «${minName}»: ${fmtStoryNum(p)} шт.`,
        );
    }
    if (p < 1 - 1e-9) {
        warnings.push(
            `При положительном черновике (${fmtStoryNum(draftCore)} шт) итог всё ещё < 1 шт — проверьте значения sales_formula_rare_base_qty и (для дорогого) sales_formula_expensive_rare_min_qty (сейчас ${fmtStoryNum(p)} шт).`,
        );
    }
    return p;
}

/**
 * Целый итог не ниже кратности закупок (если ≥ 1 шт): после «Макс. изменения» и `floor` значение могло
 * оказаться ниже минимальной партии заказа (например потолок 1.6 шт при кратности 10).
 */
function applyFinalMultiplicityIntFloor(proposedInt, multiplicity, warnings, fmtStoryNum) {
    const base = Math.trunc(Number(proposedInt));
    const p = Number.isFinite(base) ? base : 0;
    const m = Number(multiplicity);
    if (!Number.isFinite(m) || m < 1 - 1e-9) return Math.max(0, p);
    const multMin = Math.ceil(m - 1e-9);
    if (!Number.isFinite(multMin) || multMin < 1) return Math.max(0, p);
    if (p >= multMin) return p;
    warnings.push(
        `Итог ${fmtStoryNum(p)} шт ниже кратности из закупок (${fmtStoryNum(multMin)} шт) — поднято до ${fmtStoryNum(multMin)} шт (после «Макс. изменения» и целых штук; не ниже минимальной партии).`,
    );
    return multMin;
}

/**
 * @param {object} opts
 * @param {object} opts.settings — результат parseFormulaSettings
 * @param {number} opts.sumQty — сумма quantity за период W
 * @param {number} [opts.sumQtyAbsenceWindow] — сумма за период A (справочно в inputs)
 * @param {number} opts.absenceDistinctDays — DISTINCT дат «нуля» за A
 * @param {number|null} opts.marketPriceRub
 * @param {number} opts.multiplicity
 * @param {number} opts.stockQty
 * @param {number} opts.prevBaseline
 * @param {string} [opts.prevBaselineSource]
 */
function computeSalesFormula(opts) {
    const s = opts.settings;
    const warnings = [];
    const W = s.salesWindowDays;
    const A = s.absenceAnalysisDays;

    const sumQtyW = Math.max(0, num(opts.sumQty, 0));
    const sumAbs = Math.max(0, num(opts.sumQtyAbsenceWindow != null ? opts.sumQtyAbsenceWindow : opts.sumQty, 0));

    const avgW = W > 0 ? sumQtyW / W : 0;
    const avgA = A > 0 ? sumAbs / A : 0;

    const absenceDistinct = Math.max(0, Math.round(num(opts.absenceDistinctDays, 0)));

    const multiplicity = Math.max(0, num(opts.multiplicity, 0));
    const stockQty = num(opts.stockQty, 0);
    const prevBaseline = Math.max(0, num(opts.prevBaseline, 0));
    const marketPriceRub = opts.marketPriceRub != null && Number.isFinite(opts.marketPriceRub) ? opts.marketPriceRub : null;

    const prevBaselineSource = String(opts.prevBaselineSource || 'ms_export.min_stock').trim() || 'ms_export.min_stock';
    const baselineSrcPhrase = humanizePrevBaselineSource(prevBaselineSource);

    const fmtStoryNum = (v) => {
        const n = Number(v);
        if (!Number.isFinite(n)) return '—';
        if (Math.abs(n) < 1e-12) return '0';
        const r = Math.round(n);
        if (Math.abs(n - r) < 1e-9) return String(r);
        return String(Number.parseFloat(n.toFixed(6)));
    };

    const fmtIntSpace = (v) => {
        const n = Math.round(Number(v));
        if (!Number.isFinite(n)) return '—';
        return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
    };

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

    const missedSalesEquiv = absenceDistinct * avgW;
    const adjustedSalesSum = sumQtyW + missedSalesEquiv;
    const isExpensive = marketPriceRub != null && marketPriceRub > s.expensiveThresholdRub + 1e-9;
    const isRare = !isExpensive && sumQtyW <= 1 + 1e-12;
    /** Не ниже 1 шт: иначе при sales_formula_rare_base_qty = 0 карточка/закупки показывают «0 шт» без смысла. */
    const rareBaseEffective = Math.max(1, s.rareBaseQty);

    const LBL_W = `Продажи за период, дней (настройка sales_formula_sales_window_days, сейчас ${W} дн.)`;
    const LBL_A = `Анализ отсутствий, дней (настройка sales_formula_absence_analysis_days, сейчас ${A} дн.)`;
    const LBL_K = 'Коэффициент пополнения (настройка sales_formula_replenishment_coef)';
    const LBL_RARE = 'Базовый запас для товаров с редкими продажами (настройка sales_formula_rare_base_qty)';
    const LBL_EXP_RARE_MIN = 'Базовый запас для дорогих товаров с редкими продажами (настройка sales_formula_expensive_rare_min_qty)';
    const LBL_EXP_TH = 'Порог дорогой товар, ₽ (настройка sales_formula_expensive_rare_threshold_rub)';
    const LBL_PACK = 'Процент от упаковки, % (настройка sales_formula_incomplete_pack_pct)';
    const LBL_MAXJ = 'Макс. изменение (× к текущему) (настройка sales_formula_max_change_coef)';
    const maxJumpNoteCommon =
        `Потолок считается так: (опорный неснижаемый, шт) × (значение «${LBL_MAXJ}», т.е. sales_formula_max_change_coef). ` +
        `Опорный берётся из: ${baselineSrcPhrase}. ` +
        `Это ограничение действует **только на повышение**: если расчётное количество **выше** потолка — подставляем потолок; если **ниже или равно** — оставляем расчётное. На уменьшение относительно опоры не смотрит.`;

    pushEq(
        'avg_demand_W',
        'Определяем средний спрос',
        `Сумма продаж за период ÷ число дней периода`,
        `${fmtIntSpace(sumQtyW)} ÷ ${W} = ${fmtStoryNum(avgW)} шт/день`,
        `Сумма quantity за последние ${W} календарных дней по полю «${LBL_W}».`,
    );

    pushEq(
        'missed_sales',
        'Дополняем средний спрос отсутствующими днями',
        `Число дней отсутствия за период «Анализ отсутствий» × средний спрос с этапа 1`,
        `${absenceDistinct} × ${fmtStoryNum(avgW)} = ${fmtIntSpace(Math.round(missedSalesEquiv + 1e-9))} шт (возможно упущенные продажи)`,
        `Дни отсутствия — различные даты нулевого остатка в логе за окно «${LBL_A}». На средний спрос умножается тот же средний дневной спрос, что на этапе 1 (из «${LBL_W}»).`,
    );

    pushEq(
        'adjusted_sum',
        'Сумма продаж за период с учётом отсутствующих дней',
        'Сумма за период «Продажи за период» + оценка упущенных',
        `${fmtIntSpace(sumQtyW)} + ${fmtIntSpace(Math.round(missedSalesEquiv + 1e-9))} = ${fmtIntSpace(Math.round(adjustedSalesSum + 1e-9))} шт`,
        `Дальше на шаге 6 эта сумма умножается только на «${LBL_K}» (без прибавки «Базовый запас» и без «Базовый запас для дорогих…» — см. подсказку в настройках на странице «Формула продаж / закупки»).`,
    );

    pushEq(
        'expensive_check',
        'Определяем дорогой товар или нет',
        'Цена типа с «маркет» в названии vs порог из настроек',
        marketPriceRub == null
            ? 'Цена с «маркет» в названии в карточке не найдена → по цене товар не относится к дорогим'
            : `${fmtStoryNum(marketPriceRub)} ₽ ${isExpensive ? '>' : '≤'} ${fmtStoryNum(s.expensiveThresholdRub)} ₽ (${LBL_EXP_TH}) → ${isExpensive ? 'дорогой' : 'товар не дорогой'}`,
        `Проверка влияет только на ветку «редкий товар» (шаг 5) и на подстановку минимума при дроби < 1 шт после кратности / макс. скачка (см. applySubUnitMinAfterPack). На шаг 6 (умножение на коэффициент) в текущей версии расчёта значение «${LBL_EXP_RARE_MIN}» к произведению не добавляется.`,
    );

    pushEq(
        'rare_check',
        'Редкий товар или нет',
        'Условие раннего выхода: не дорогой по цене и мало продаж за период «Продажи за период»',
        isRare
            ? `Сумма продаж за «${LBL_W}» = ${fmtIntSpace(sumQtyW)} шт ≤ 1 шт, и товар не дорогой → предлагаемый неснижаемый = ${fmtStoryNum(rareBaseEffective)} шт («${LBL_RARE}»${s.rareBaseQty < 1 ? `; в настройках ${fmtStoryNum(s.rareBaseQty)} шт — минимум для подсказки 1 шт` : ''}). Расчёт по «${LBL_K}» и кратность не выполняются.`
            : `Сумма продаж за «${LBL_W}» (только фактические продажи за ${W} дн., без сложения с «упущенными») = ${fmtIntSpace(sumQtyW)} шт; это больше 1 шт, поэтому ранний выход в значение «${LBL_RARE}» не применяется. Сумма с учётом отсутствий ${fmtIntSpace(Math.round(adjustedSalesSum + 1e-9))} шт пойдёт в умножение на коэффициент.`,
        `Редкость считается только по фактической сумме quantity за окно «Продажи за период», а не по сумме ${fmtIntSpace(Math.round(adjustedSalesSum + 1e-9))} шт с «упущенными».`,
    );

    if (isRare) {
        let proposal = rareBaseEffective;
        let maxJumpApplied = false;
        if (prevBaseline > 0 && proposal > prevBaseline * s.maxChangeCoef + 1e-9) {
            const capped = prevBaseline * s.maxChangeCoef;
            warnings.push(
                `Рост ограничен «${LBL_MAXJ}» (sales_formula_max_change_coef = ${fmtStoryNum(s.maxChangeCoef)}): потолок = ${fmtStoryNum(prevBaseline)} шт (${baselineSrcPhrase}) × ${fmtStoryNum(s.maxChangeCoef)} = ${fmtStoryNum(capped)} шт.`,
            );
            proposal = capped;
            maxJumpApplied = true;
        }
        if (prevBaseline > 0) {
            const capJump = prevBaseline * s.maxChangeCoef;
            if (maxJumpApplied) {
                pushEq(
                    'max_jump_rare',
                    'Проверка максимального пополнения',
                    'min(значение редкой ветки; опорный неснижаемый × «Макс. изменение»)',
                    `Потолок = ${fmtStoryNum(prevBaseline)} шт × ${fmtStoryNum(s.maxChangeCoef)} («${LBL_MAXJ}») = ${fmtStoryNum(capJump)} шт. Значение «${LBL_RARE}» (эффективно ${fmtStoryNum(rareBaseEffective)} шт): ${fmtStoryNum(rareBaseEffective)} шт > ${fmtStoryNum(capJump)} шт → min(...) = ${fmtStoryNum(proposal)} шт`,
                    maxJumpNoteCommon,
                );
            } else {
                pushEq(
                    'max_jump_rare_skip',
                    'Проверка максимального пополнения',
                    'Сравнение с потолком «опорный × Макс. изменение» — обрезка не нужна',
                    `Потолок = ${fmtStoryNum(prevBaseline)} шт × ${fmtStoryNum(s.maxChangeCoef)} («${LBL_MAXJ}», sales_formula_max_change_coef) = ${fmtStoryNum(capJump)} шт. Значение «${LBL_RARE}»: ${fmtStoryNum(proposal)} шт ≤ ${fmtStoryNum(capJump)} шт — оставляем ${fmtStoryNum(proposal)} шт`,
                    maxJumpNoteCommon,
                );
            }
        }

        let multFloorRare = false;
        if (multiplicity >= 1) {
            const prevM = proposal;
            proposal = Math.max(proposal, multiplicity);
            if (proposal > prevM + 1e-9) {
                multFloorRare = true;
                warnings.push(
                    `Редкий товар: после «${LBL_RARE}» и проверки макс. изменения значение (${fmtStoryNum(prevM)} шт) меньше кратности из закупок (${fmtStoryNum(multiplicity)} шт) — поднято до ${fmtStoryNum(proposal)} шт.`,
                );
            }
            pushEq(
                'rare_mult_floor',
                'Кратность из закупок (редкий товар)',
                'max(итог редкой ветки; кратность), если кратность ≥ 1',
                multFloorRare
                    ? `${fmtStoryNum(prevM)} шт → min не ниже кратности: ${fmtStoryNum(proposal)} шт`
                    : `max(${fmtStoryNum(prevM)}, ${fmtStoryNum(multiplicity)}) = ${fmtStoryNum(proposal)} шт`,
                `В ветке редкого товара нет шага «процент от упаковки»; если в закупках задана кратность ≥ 1 шт, итог **не ниже** неё (паритет с нередкой веткой по минимуму заказа).`,
            );
        }

        const preIntRare = proposal;
        const flooredRare = Math.max(0, Math.floor(proposal + 1e-9));
        const rareMinInt = Math.floor(rareBaseEffective + 1e-9);
        const proposed = Math.max(flooredRare, rareMinInt);
        if (proposed > flooredRare + 1e-9) {
            warnings.push(
                `Редкий товар: после «Макс. изменения» ${fmtStoryNum(preIntRare)} шт → в целых штуках ${flooredRare} шт, что ниже минимума редкой ветки (${rareMinInt} шт по «${LBL_RARE}»; часто из-за очень маленького опорного неснижаемого × коэффициент) — итог ${proposed} шт.`,
            );
        }
        const proposedFinal = applyFinalMultiplicityIntFloor(proposed, multiplicity, warnings, fmtStoryNum);
        pushEq(
            'final_int_rare',
            'Итог (редкий товар)',
            'Целые штуки',
            `${fmtStoryNum(preIntRare)} → ${proposedFinal} шт`,
            'Предлагаемый неснижаемый (Датагон) для карточки и закупок.',
        );

        const formula_context_lines = buildFormulaContextLines({
            s,
            W,
            A,
            sumQtyW,
            avgW,
            sumAbs,
            avgA,
            absenceDistinct,
            missedSalesEquiv,
            adjustedSalesSum,
            marketPriceRub,
            isExpensive,
            isRare,
            multiplicity,
            prevBaseline,
            prevBaselineSource,
            fmtStoryNum,
            fmtIntSpace,
        });

        return {
            proposed_min_stock: proposedFinal,
            warnings,
            detail: { equation_stages, formula_context_lines },
            inputs: {
                sales_window_days: W,
                sum_qty_window: sumQtyW,
                avg_daily_window: avgW,
                absence_analysis_days: A,
                sum_qty_absence_window: sumAbs,
                avg_daily_absence_window: avgA,
                absence_window_days: A,
                absence_distinct_days: absenceDistinct,
                absence_rate: A > 0 ? absenceDistinct / A : 0,
                missed_sales_equiv: missedSalesEquiv,
                adjusted_sales_sum: adjustedSalesSum,
                base_qty: s.baseQty,
                base_qty_in_formula: false,
                rare_short_circuit: true,
                rare_branch_b_qty: rareBaseEffective,
                rare_base_qty_component: rareBaseEffective,
                rare_base_qty_settings_raw: s.rareBaseQty,
                expensive_applied: false,
                market_price_rub: marketPriceRub,
                multiplicity,
                incomplete_pack_pct: s.incompletePackPct,
                stock_qty: stockQty,
                prev_baseline: prevBaseline,
                prev_baseline_source: prevBaselineSource,
                mult_floor_applied: multFloorRare || proposedFinal > proposed + 1e-9,
            },
        };
    }

    const draftCore = adjustedSalesSum * s.replenishmentCoef;

    pushEq(
        'replenishment',
        'Считаем предлагаемый неснижаемый (черновик до кратности)',
        'Сумма продаж за период с учётом отсутствующих дней × коэффициент пополнения',
        `${fmtIntSpace(Math.round(adjustedSalesSum + 1e-9))} × ${fmtStoryNum(s.replenishmentCoef)} = ${fmtStoryNum(draftCore)}`,
        `Используются только эта сумма и «${LBL_K}». Поля «Базовый запас» (sales_formula_base_qty) и «${LBL_EXP_RARE_MIN}» к этому произведению не добавляются.`,
    );

    const beforePack = draftCore;
    const rawPack = applyPackagingFloor(draftCore, multiplicity, s.incompletePackPct);
    let proposal = rawPack;
    /** Сигнал для минимума по кратности: нельзя оставить 0 при mult≥1 и ненулевой adjusted, даже если k=0 (черновик тогда 0). */
    const hadPositiveDemandForPack =
        draftCore > 1e-9 ||
        (adjustedSalesSum > 1e-9 && s.replenishmentCoef > 1e-9) ||
        (adjustedSalesSum > 1e-9 && multiplicity >= 1);
    /** Минимум по кратности из закупок: при положительном черновике не остаёмся ниже `multiplicity` шт (в т.ч. после «вниз» при mult=1). */
    let multFloorApplied = false;
    if (multiplicity >= 1 && hadPositiveDemandForPack) {
        const prevP = proposal;
        proposal = Math.max(proposal, multiplicity);
        if (proposal > prevP + 1e-9) {
            multFloorApplied = true;
            warnings.push(
                `После кратности и порога упаковки значение (${fmtStoryNum(prevP)} шт) меньше кратности из закупок (${fmtStoryNum(multiplicity)} шт) при ненулевой сумме с учётом отсутствий (и/или положительном черновике ×k) — поднято до ${fmtStoryNum(proposal)} шт.`,
            );
        }
    }
    const packAdjusted = Math.abs(rawPack - beforePack) > 1e-7 || multFloorApplied;
    if (multiplicity >= 1) {
        const packRoundNote =
            `Кратность задаётся в закупках (карточка товара / «Закупки»). При положительном черновике (×k) **или** при ненулевой сумме с учётом отсутствий (в т.ч. если k=0 и черновик 0) итог **не ниже** этой кратности (штук в одной «упаковке» заказа). ` +
            (s.incompletePackPct > 0
                ? `Доля хвоста от полной «упаковки» сравнивается с «${LBL_PACK}»: если ≤ порога — округление **вниз** до кратности; если **строго больше** порога — **вверх** до кратности (хвост считаем полной упаковкой). `
                : `Порог «${LBL_PACK}» = 0 — округление по доле хвоста не выполняется. `) +
            `Остаток на складе ${fmtStoryNum(stockQty)} шт (справочно).`;
        let packValues;
        if (multFloorApplied) {
            if (s.incompletePackPct > 0 && Math.abs(rawPack - beforePack) > 1e-7) {
                if (rawPack > beforePack + 1e-7) {
                    packValues = `${fmtStoryNum(beforePack)} → хвост > ${fmtStoryNum(s.incompletePackPct)}% → ${fmtStoryNum(rawPack)} → min кратности: ${fmtStoryNum(proposal)} шт`;
                } else {
                    packValues = `${fmtStoryNum(beforePack)} → хвост ≤ ${fmtStoryNum(s.incompletePackPct)}% → ${fmtStoryNum(rawPack)} → min кратности: ${fmtStoryNum(proposal)} шт`;
                }
            } else {
                packValues = `${fmtStoryNum(beforePack)} → ${fmtStoryNum(rawPack)} → min кратности (${fmtStoryNum(multiplicity)}): ${fmtStoryNum(proposal)} шт`;
            }
        } else if (s.incompletePackPct > 0 && Math.abs(rawPack - beforePack) > 1e-7) {
            if (rawPack > beforePack + 1e-7) {
                packValues = `Кратность ${fmtStoryNum(multiplicity)}, порог ${fmtStoryNum(s.incompletePackPct)}% → ${fmtStoryNum(beforePack)} → хвост > ${fmtStoryNum(s.incompletePackPct)}% → вверх до кратности: ${fmtStoryNum(proposal)}`;
            } else {
                packValues = `Кратность ${fmtStoryNum(multiplicity)}, порог ${fmtStoryNum(s.incompletePackPct)}% → ${fmtStoryNum(beforePack)} → хвост ≤ ${fmtStoryNum(s.incompletePackPct)}% → вниз до кратности: ${fmtStoryNum(proposal)}`;
            }
        } else {
            packValues =
                s.incompletePackPct > 0
                    ? `Кратность ${fmtStoryNum(multiplicity)}, порог ${fmtStoryNum(s.incompletePackPct)}% → без изменения по доле: ${fmtStoryNum(proposal)}`
                    : `Кратность ${fmtStoryNum(multiplicity)}, порог упаковки 0% → ${fmtStoryNum(proposal)} шт`;
        }
        pushEq(
            'pack_round',
            'Приведение к кратности товара и проценту от упаковки',
            'Доля хвоста ≤ порога % — вниз до кратности; доля хвоста > порога % — вверх до кратности; при сигнале спроса (черновик ×k и/или ненулевая сумма с учётом отсутствий) — не ниже кратности из закупок',
            packValues,
            packRoundNote,
        );
    }

    const beforeMaxJump = proposal;
    let maxJumpApplied = false;
    if (prevBaseline > 0 && proposal > prevBaseline * s.maxChangeCoef + 1e-9) {
        const capped = prevBaseline * s.maxChangeCoef;
        warnings.push(
            `Рост ограничен «${LBL_MAXJ}» (sales_formula_max_change_coef = ${fmtStoryNum(s.maxChangeCoef)}): потолок = ${fmtStoryNum(prevBaseline)} шт (${baselineSrcPhrase}) × ${fmtStoryNum(s.maxChangeCoef)} = ${fmtStoryNum(capped)} шт.`,
        );
        proposal = capped;
        maxJumpApplied = true;
    }
    if (prevBaseline > 0) {
        const capJump = prevBaseline * s.maxChangeCoef;
        if (maxJumpApplied) {
            pushEq(
                'max_jump',
                'Проверка максимального пополнения',
                'min(значение после кратности и упаковки; опорный неснижаемый × «Макс. изменение»)',
                `Потолок = ${fmtStoryNum(prevBaseline)} шт × ${fmtStoryNum(s.maxChangeCoef)} («${LBL_MAXJ}», sales_formula_max_change_coef) = ${fmtStoryNum(capJump)} шт. После кратности и упаковки (вход шага): ${fmtStoryNum(beforeMaxJump)} шт > ${fmtStoryNum(capJump)} шт → min(...) = ${fmtStoryNum(proposal)} шт`,
                maxJumpNoteCommon,
            );
        } else {
            pushEq(
                'max_jump_skip',
                'Проверка максимального пополнения',
                'Сравнение с потолком «опорный неснижаемый × Макс. изменение» — обрезка не нужна',
                `Потолок = ${fmtStoryNum(prevBaseline)} шт × ${fmtStoryNum(s.maxChangeCoef)} («${LBL_MAXJ}», sales_formula_max_change_coef) = ${fmtStoryNum(capJump)} шт. После кратности и упаковки: ${fmtStoryNum(beforeMaxJump)} шт ≤ ${fmtStoryNum(capJump)} шт — оставляем ${fmtStoryNum(beforeMaxJump)} шт`,
                maxJumpNoteCommon,
            );
        }
    }

    if (proposal <= 1e-9 && adjustedSalesSum > 1e-9) {
        proposal = rareBaseEffective;
        warnings.push(
            `Сумма с учётом отсутствий ${fmtIntSpace(Math.round(adjustedSalesSum + 1e-9))} шт > 0, но после коэффициента пополнения и кратности получилось бы ≤ 0 (часто при sales_formula_replenishment_coef = 0 и кратности закупок < 1 шт) — подставлен минимум ${fmtStoryNum(rareBaseEffective)} шт (sales_formula_rare_base_qty${s.rareBaseQty < 1 ? ' = 0 в настройках; действует минимум 1 шт' : ''}).`,
        );
    }

    proposal = applySubUnitMinAfterPack({
        draftCore,
        proposal,
        packZeroGuard: false,
        isExpensive,
        s,
        warnings,
        fmtStoryNum,
    });

    const proposed = Math.max(0, Math.floor(proposal + 1e-9));
    const proposedFinal = applyFinalMultiplicityIntFloor(proposed, multiplicity, warnings, fmtStoryNum);
    pushEq(
        'final_int',
        'Итог',
        'Целые штуки',
        `max(0, floor(${fmtStoryNum(proposal)})) = ${proposedFinal} шт`,
        'Предлагаемый неснижаемый (Датагон) для карточки и закупок.',
    );

    const formula_context_lines = buildFormulaContextLines({
        s,
        W,
        A,
        sumQtyW,
        avgW,
        sumAbs,
        avgA,
        absenceDistinct,
        missedSalesEquiv,
        adjustedSalesSum,
        marketPriceRub,
        isExpensive,
        isRare: false,
        multiplicity,
        prevBaseline,
        prevBaselineSource,
        fmtStoryNum,
        fmtIntSpace,
    });

    return {
        proposed_min_stock: proposedFinal,
        warnings,
        detail: { equation_stages, formula_context_lines },
        inputs: {
            sales_window_days: W,
            sum_qty_window: sumQtyW,
            avg_daily_window: avgW,
            absence_analysis_days: A,
            sum_qty_absence_window: sumAbs,
            avg_daily_absence_window: avgA,
            absence_window_days: A,
            absence_distinct_days: absenceDistinct,
            absence_rate: A > 0 ? absenceDistinct / A : 0,
            missed_sales_equiv: missedSalesEquiv,
            adjusted_sales_sum: adjustedSalesSum,
            base_qty: s.baseQty,
            base_qty_in_formula: false,
            rare_short_circuit: false,
            rare_branch_b_qty: 0,
            rare_base_qty_component: 0,
            expensive_applied: isExpensive,
            expensive_add_qty: 0,
            draft_pre_pack: draftCore,
            pack_round_raw: rawPack,
            mult_floor_applied: multFloorApplied || proposedFinal > proposed + 1e-9,
            market_price_rub: marketPriceRub,
            multiplicity,
            incomplete_pack_pct: s.incompletePackPct,
            stock_qty: stockQty,
            prev_baseline: prevBaseline,
            prev_baseline_source: prevBaselineSource,
        },
    };
}

function buildFormulaContextLines(ctx) {
    const {
        s,
        W,
        A,
        sumQtyW,
        avgW,
        absenceDistinct,
        missedSalesEquiv,
        adjustedSalesSum,
        marketPriceRub,
        isExpensive,
        isRare,
        multiplicity,
        prevBaseline,
        prevBaselineSource,
        fmtStoryNum,
        fmtIntSpace,
    } = ctx;

    return [
        { label: 'Коэффициент пополнения (sales_formula_replenishment_coef)', value: String(fmtStoryNum(s.replenishmentCoef)) },
        {
            label: `Продажи за ${W} дн. (sales_formula_sales_window_days)`,
            value: `${fmtIntSpace(sumQtyW)} шт`,
        },
        { label: `Средние за ${W} дн.`, value: `${fmtStoryNum(avgW)} шт/день` },
        {
            label: `Дней отсутствия за ${A} дн. (sales_formula_absence_analysis_days)`,
            value: String(absenceDistinct),
        },
        {
            label: 'Оценка упущенных (дни отсутствия × средние за период «Продажи за период»)',
            value: `${fmtIntSpace(Math.round(missedSalesEquiv + 1e-9))} шт`,
        },
        {
            label: 'Сумма с учётом отсутствий',
            value: `${fmtIntSpace(Math.round(adjustedSalesSum + 1e-9))} шт`,
        },
        {
            label: `Продажи за ${W} дн. (справочно)`,
            value: `${fmtIntSpace(sumQtyW)} шт`,
        },
        { label: `Средние за ${W} дн. (справочно)`, value: `${fmtStoryNum(avgW)} шт/день` },
        {
            label: 'Базовый запас (sales_formula_base_qty)',
            value: `${s.baseQty} шт — к шагу «× коэффициент» не прибавляется`,
        },
        {
            label: 'Базовый запас для товаров с редкими продажами (sales_formula_rare_base_qty)',
            value:
                s.rareBaseQty < 1
                    ? `${s.rareBaseQty} шт в настройках → в формуле не ниже 1 шт`
                    : `${s.rareBaseQty} шт`,
        },
        {
            label: 'Порог дорогой товар, ₽ (цена с «маркет» в названии, sales_formula_expensive_rare_threshold_rub)',
            value: `${fmtStoryNum(s.expensiveThresholdRub)} ₽`,
        },
        {
            label: 'Базовый запас для дорогих товаров с редкими продажами (sales_formula_expensive_rare_min_qty)',
            value: `${s.expensiveRareMinQty} шт — к шагу «× коэффициент» не прибавляется`,
        },
        { label: 'Дорогой по цене', value: isExpensive ? 'да' : 'нет' },
        {
            label: `Редкий (сумма за ${W} дн. ≤ 1 шт, без «упущенных»)`,
            value: isRare ? 'да' : 'нет',
        },
        {
            label: 'Неснижаемый остаток (опорный)',
            value:
                prevBaseline > 0
                    ? `${fmtStoryNum(prevBaseline)} шт — ${humanizePrevBaselineSource(prevBaselineSource)}`
                    : 'не задан',
        },
        {
            label: 'Значение количества в упаковке (кратность из закупок / override)',
            value: multiplicity > 0 ? `${fmtStoryNum(multiplicity)} шт` : 'не задано',
        },
        {
            label: 'Процент от упаковки, % (sales_formula_incomplete_pack_pct)',
            value: `${fmtStoryNum(s.incompletePackPct)} %`,
        },
        {
            label: 'Коэффициент максимального изменения предлагаемого остатка (sales_formula_max_change_coef)',
            value: String(fmtStoryNum(s.maxChangeCoef)),
        },
        {
            label: 'Цена «маркет», ₽',
            value: marketPriceRub != null ? `${fmtStoryNum(marketPriceRub)} ₽` : 'не найдена',
        },
    ];
}

/**
 * Нормализация сырого `min_stock_dg` из БД/импорта (пробелы, NBSP, запятая как десятичный разделитель).
 * @returns {number|null}
 */
function parseMinStockDgThreshold(minStockDgRaw) {
    if (minStockDgRaw == null || minStockDgRaw === '') return null;
    if (typeof minStockDgRaw === 'number') {
        return Number.isFinite(minStockDgRaw) && minStockDgRaw > 0 ? minStockDgRaw : null;
    }
    const s = String(minStockDgRaw)
        .replace(/\u00a0/g, ' ')
        .trim()
        .replace(/\s+/g, '')
        .replace(',', '.');
    if (!s) return null;
    const dg = Number(s);
    return Number.isFinite(dg) && dg > 0 ? dg : null;
}

/**
 * Порог «Неснижаемый остаток Датагон» в закупках: если задан числом > 0, итоговый
 * предлагаемый неснижаемый (целые шт.) не может быть ниже этого минимума, независимо от формулы.
 * Дробное значение в БД поднимает целый минимум через ceil (5.1 → не ниже 6 шт).
 */
function applyMinStockDgFloor(proposedInt, minStockDgRaw) {
    const p = Number(proposedInt);
    const base = Number.isFinite(p) ? Math.trunc(p) : 0;
    const dg = parseMinStockDgThreshold(minStockDgRaw);
    if (dg == null) return Math.max(0, base);
    const floorInt = Math.ceil(dg - 1e-9);
    return Math.max(base, floorInt);
}

module.exports = {
    parseFormulaSettings,
    pickMarketPriceRub,
    computeSalesFormula,
    applyMinStockDgFloor,
};
