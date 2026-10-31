/**
 * Наценка сайта от закупочной МС: маржа, не «простой +%».
 * sale = buy / (1 - pct/100), чтобы sale − pct% = buy.
 */
'use strict';

const PRICE_MARGIN_SOURCE_BUY = 'buy_price';

const TIER_KEYS = Object.freeze([
    'lt_1000',
    'from_1000_lt_5000',
    'from_5000_lt_50000',
    'gte_50000',
]);

const TIER_LABELS = Object.freeze({
    lt_1000: 'до 1 000 ₽',
    from_1000_lt_5000: 'от 1 000 до 5 000 ₽',
    from_5000_lt_50000: 'от 5 000 до 50 000 ₽',
    gte_50000: 'свыше 50 000 ₽',
});

function parseMoneyRub(raw) {
    if (raw == null || raw === '') return null;
    if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
    const s = String(raw)
        .replace(/₽/gi, '')
        .replace(/\u00a0|\u202f/g, ' ')
        .replace(/\s+/g, '')
        .replace(',', '.')
        .trim();
    if (!s) return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
}

function parseMarginPct(raw) {
    if (raw == null || raw === '') return null;
    if (typeof raw === 'number') {
        return Number.isFinite(raw) ? raw : null;
    }
    const s = String(raw).trim().replace(',', '.').replace(/%/g, '');
    if (!s) return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
}

function emptyTiers() {
    return {
        lt_1000: null,
        from_1000_lt_5000: null,
        from_5000_lt_50000: null,
        gte_50000: null,
    };
}

/**
 * @param {unknown} raw
 * @returns {{ source: string, tiers: Record<string, number|null> }}
 */
function parseSitePriceMarginConfig(raw) {
    let obj = raw;
    if (typeof raw === 'string') {
        const s = raw.trim();
        if (!s) return { source: PRICE_MARGIN_SOURCE_BUY, tiers: emptyTiers() };
        try {
            obj = JSON.parse(s);
        } catch (_) {
            return { source: PRICE_MARGIN_SOURCE_BUY, tiers: emptyTiers() };
        }
    }
    if (!obj || typeof obj !== 'object') {
        return { source: PRICE_MARGIN_SOURCE_BUY, tiers: emptyTiers() };
    }
    const source =
        String(obj.source || PRICE_MARGIN_SOURCE_BUY).trim() === PRICE_MARGIN_SOURCE_BUY
            ? PRICE_MARGIN_SOURCE_BUY
            : PRICE_MARGIN_SOURCE_BUY;
    const srcTiers = obj.tiers && typeof obj.tiers === 'object' ? obj.tiers : obj;
    const tiers = emptyTiers();
    for (const k of TIER_KEYS) {
        const pct = parseMarginPct(srcTiers[k]);
        tiers[k] = pct;
    }
    return { source, tiers };
}

function serializeSitePriceMarginConfig(raw) {
    if (raw == null || raw === '') return null;
    const cfg = parseSitePriceMarginConfig(raw);
    const hasAny = TIER_KEYS.some((k) => cfg.tiers[k] != null);
    if (!hasAny) return null;
    return JSON.stringify({
        source: cfg.source,
        tiers: cfg.tiers,
    });
}

function sitePriceMarginConfigured(site) {
    const cfg = parseSitePriceMarginConfig(site && site.price_margin_json);
    return TIER_KEYS.some((k) => cfg.tiers[k] != null && Number.isFinite(cfg.tiers[k]));
}

/**
 * Тир по закупочной.
 * «до 1 000» — включительно (как в примере 1000 + 20% → 1250):
 * ≤1000 | (1000, 5000] | (5000, 50000] | >50000.
 * @param {number} buy
 * @returns {string|null}
 */
function tierKeyForBuyPrice(buy) {
    const n = Number(buy);
    if (!Number.isFinite(n) || n < 0) return null;
    if (n <= 1000) return 'lt_1000';
    if (n <= 5000) return 'from_1000_lt_5000';
    if (n <= 50000) return 'from_5000_lt_50000';
    return 'gte_50000';
}

/**
 * Маржа: sale = buy / (1 - pct/100), затем математическое округление до целых рублей
 * (`Math.round`, 0.5 вверх): 2549.55 → 2550.
 * @param {number} buy
 * @param {number} pct 0…99.999
 * @returns {number|null}
 */
function salePriceFromBuyMargin(buy, pct) {
    const b = Number(buy);
    const p = Number(pct);
    // Закупка 0 → sale 0; такую цену в CMS никогда не пишем (см. applySkuMarginPrices).
    if (!Number.isFinite(b) || b <= 0) return null;
    if (!Number.isFinite(p) || p < 0 || p >= 100) return null;
    const sale = p === 0 ? b : b / (1 - p / 100);
    if (!Number.isFinite(sale) || !(sale > 0)) return null;
    return Math.round(sale);
}

function marginPctForBuy(cfg, buy) {
    const key = tierKeyForBuyPrice(buy);
    if (!key) return null;
    const pct = cfg && cfg.tiers ? cfg.tiers[key] : null;
    return pct != null && Number.isFinite(pct) ? pct : null;
}

/**
 * Навешивает на строки `margin_sale_price` / `margin_pct` / `margin_buy` при настроенных тирах.
 * База наценки — «Закупочная цена» карточки МС (`ms_card_buy_price` / `ms_buy_price` после enrich),
 * не себестоимость из отчёта остатков (`ms_stock_cost`).
 * Без закупки или без % тира — поля null (CMS не трогаем).
 */
function attachSiteMarginPricesToRows(site, rows) {
    const cfg = parseSitePriceMarginConfig(site && site.price_margin_json);
    const list = Array.isArray(rows) ? rows : [];
    for (const r of list) {
        r.margin_buy = null;
        r.margin_pct = null;
        r.margin_sale_price = null;
        r.margin_tier = null;
    }
    if (!sitePriceMarginConfigured(site)) return;

    for (const r of list) {
        if (!Number(r.sticker_ms_linked)) continue;
        const buy =
            parseMoneyRub(r.ms_card_buy_price) != null
                ? parseMoneyRub(r.ms_card_buy_price)
                : parseMoneyRub(r.ms_buy_price) != null
                  ? parseMoneyRub(r.ms_buy_price)
                  : parseMoneyRub(r.ms_stock_cost) != null
                    ? parseMoneyRub(r.ms_stock_cost)
                    : parseMoneyRub(r.buy_price);
        if (buy == null) continue;
        const tier = tierKeyForBuyPrice(buy);
        const pct = marginPctForBuy(cfg, buy);
        if (pct == null) continue;
        const sale = salePriceFromBuyMargin(buy, pct);
        if (sale == null) continue;
        r.margin_buy = buy;
        r.margin_pct = pct;
        r.margin_tier = tier;
        r.margin_sale_price = sale;
    }
}

module.exports = {
    PRICE_MARGIN_SOURCE_BUY,
    TIER_KEYS,
    TIER_LABELS,
    parseMoneyRub,
    parseMarginPct,
    parseSitePriceMarginConfig,
    serializeSitePriceMarginConfig,
    sitePriceMarginConfigured,
    tierKeyForBuyPrice,
    salePriceFromBuyMargin,
    marginPctForBuy,
    attachSiteMarginPricesToRows,
    emptyTiers,
};
