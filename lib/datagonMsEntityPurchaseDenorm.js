'use strict';

const { pickMarketPriceRub } = require('./datagonSalesFormula');

function toMoneyRub(centsRaw) {
    const cents = Number(centsRaw);
    if (!Number.isFinite(cents)) return null;
    return Math.round(cents) / 100;
}

function extractPricesFromEntity(payload) {
    const prices = [];
    if (!payload) return prices;
    if (payload.buyPrice && payload.buyPrice.value != null) {
        const v = toMoneyRub(payload.buyPrice.value);
        if (v != null) prices.push({ kind: 'buy', name: 'Закупочная цена', value: v, currency: payload.buyPrice?.currency?.code || 'RUB' });
    }
    if (payload.minPrice && payload.minPrice.value != null) {
        const v = toMoneyRub(payload.minPrice.value);
        if (v != null) prices.push({ kind: 'min', name: 'Минимальная цена', value: v, currency: payload.minPrice?.currency?.code || 'RUB' });
    }
    if (Array.isArray(payload.salePrices)) {
        for (const sp of payload.salePrices) {
            if (!sp || sp.value == null) continue;
            const v = toMoneyRub(sp.value);
            if (v == null) continue;
            const name = String(sp?.priceType?.name || 'Цена продажи').trim();
            prices.push({
                kind: 'sale',
                name,
                value: v,
                currency: sp?.currency?.code || 'RUB',
            });
        }
    }
    return prices;
}

function extractPackQtyAuto(payload) {
    if (!payload || !Array.isArray(payload.packagings)) return null;
    for (const pk of payload.packagings) {
        if (!pk) continue;
        const q = Number(pk.quantity);
        if (Number.isFinite(q) && q > 0) return q;
    }
    return null;
}

function extractInTransitQty(payload) {
    if (!payload || payload.inTransit == null) return null;
    const n = Number(payload.inTransit);
    return Number.isFinite(n) ? n : null;
}

/**
 * Поля для списка закупок / формулы без чтения `payload_json` в SELECT.
 * @param {object} entity — объект сущности МС (как перед `JSON.stringify` в `saveMoyskladEntityDetails`).
 */
function computeMsEntityPurchaseDenorm(entity) {
    if (!entity || typeof entity !== 'object') {
        return {
            denorm_article: null,
            denorm_in_transit: null,
            denorm_pack_qty_auto: null,
            denorm_market_price_rub: null,
        };
    }
    const p = entity;
    let article = typeof p.article === 'string' ? p.article.trim() : '';
    if (article.length > 500) article = article.slice(0, 500);
    const denorm_article = article || null;
    const denorm_in_transit = extractInTransitQty(p);
    const denorm_pack_qty_auto = extractPackQtyAuto(p);
    const prices = extractPricesFromEntity(p);
    const mkt = pickMarketPriceRub(prices);
    const denorm_market_price_rub = mkt != null && Number.isFinite(mkt) ? mkt : null;
    return {
        denorm_article: denorm_article,
        denorm_in_transit: denorm_in_transit,
        denorm_pack_qty_auto: denorm_pack_qty_auto,
        denorm_market_price_rub: denorm_market_price_rub,
    };
}

module.exports = {
    computeMsEntityPurchaseDenorm,
};
