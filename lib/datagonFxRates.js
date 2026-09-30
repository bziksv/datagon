/**
 * Курсы ЦБ РФ (cbr-xml-daily.ru) — общий кэш для «Мои товары» / «Цены сети».
 */
const axios = require('axios');

let fxRatesCache = {
    usd_to_rub: 90,
    eur_to_rub: 100,
    updated_at: null,
    source: 'fallback',
};

let fxAutoUpdateStarted = false;
let inflight = null;

function snapshotFx() {
    return {
        usd_to_rub: Number(fxRatesCache.usd_to_rub || 90),
        eur_to_rub: Number(fxRatesCache.eur_to_rub || 100),
        updated_at: fxRatesCache.updated_at,
        source: fxRatesCache.source || 'fallback',
    };
}

async function updateFxRates() {
    try {
        const { data } = await axios.get('https://www.cbr-xml-daily.ru/daily_json.js', { timeout: 8000 });
        const usd = Number(data?.Valute?.USD?.Value);
        const eur = Number(data?.Valute?.EUR?.Value);
        if (Number.isFinite(usd) && Number.isFinite(eur) && usd > 0 && eur > 0) {
            fxRatesCache = {
                usd_to_rub: usd,
                eur_to_rub: eur,
                updated_at: new Date().toISOString(),
                source: 'cbr',
            };
            return true;
        }
    } catch (_) {
        /* keep last */
    }
    return false;
}

function ensureFxAutoUpdater() {
    if (fxAutoUpdateStarted) return;
    fxAutoUpdateStarted = true;
    updateFxRates().catch(() => {});
    setInterval(() => {
        updateFxRates().catch(() => {});
    }, 60 * 60 * 1000);
}

/** Актуальный снимок: если кэш старше ~6 ч или fallback — пробуем обновить. */
async function getFxRates(opts) {
    const o = opts || {};
    ensureFxAutoUpdater();
    const ageMs = fxRatesCache.updated_at
        ? Date.now() - new Date(fxRatesCache.updated_at).getTime()
        : Infinity;
    const stale = !Number.isFinite(ageMs) || ageMs > 6 * 60 * 60 * 1000;
    const need =
        o.force === true || fxRatesCache.source === 'fallback' || stale;
    if (need) {
        if (!inflight) {
            inflight = updateFxRates().finally(() => {
                inflight = null;
            });
        }
        await inflight;
    }
    return snapshotFx();
}

function normalizeCurrency(currency) {
    const cur = String(currency || 'RUB')
        .trim()
        .toUpperCase();
    if (cur === 'RUR' || cur === '₽' || cur === 'РУБ' || cur === 'РУБ.') return 'RUB';
    if (cur === '$' || cur === 'USD.') return 'USD';
    if (cur === '€' || cur === 'EUR.') return 'EUR';
    return cur || 'RUB';
}

/** Цена → рубли по курсу (как в my-products gap). */
function toRub(price, currency, fx) {
    const value = Number(price);
    if (!Number.isFinite(value)) return null;
    const rates = fx || snapshotFx();
    const usdRate = Math.max(0.0001, Number(rates.usd_to_rub || 90));
    const eurRate = Math.max(0.0001, Number(rates.eur_to_rub || 100));
    const cur = normalizeCurrency(currency);
    if (cur === 'RUB') return value;
    if (cur === 'USD') return value * usdRate;
    if (cur === 'EUR') return value * eurRate;
    return value;
}

module.exports = {
    getFxRates,
    updateFxRates,
    ensureFxAutoUpdater,
    snapshotFx,
    toRub,
    normalizeCurrency,
};
