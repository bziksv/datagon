'use strict';

/**
 * Деньги МойСклад → рубли.
 * Валюту цены берём из справочника МС (isoCode по href).
 * Курс — тот же, что у «Мои товары» / «Цены сети»: ЦБ РФ (`datagonFxRates.toRub`).
 */

const axios = require('axios');
const { toRub, snapshotFx } = require('./datagonFxRates');

const MS_BASE = 'https://api.moysklad.ru/api/remap/1.2';
const CACHE_TTL_MS = 60 * 60 * 1000;

let currencyCache = { ts: 0, byHref: new Map() };
let inflight = null;

function round2(n) {
    return Math.round(n * 100) / 100;
}

function currencyHref(price) {
    return String(price?.currency?.meta?.href || '').trim();
}

/**
 * Сумма цены в рублях по курсу ЦБ.
 * `byHref` — карта href валюты → { isoCode }. `fx` — снимок `getFxRates()`.
 * Нет карты или рубль — value/100 как есть.
 */
function msPriceToRub(price, byHref, fx) {
    if (!price || price.value == null) return null;
    const cents = Number(price.value);
    if (!Number.isFinite(cents)) return null;
    const amount = cents / 100;
    const href = currencyHref(price);
    const info = href && byHref && typeof byHref.get === 'function' ? byHref.get(href) : null;
    const iso = info && info.isoCode ? info.isoCode : 'RUB';
    const rub = toRub(amount, iso, fx || snapshotFx());
    return rub == null ? null : round2(rub);
}

async function loadMsCurrencies(token) {
    const now = Date.now();
    if (currencyCache.byHref.size && now - currencyCache.ts < CACHE_TTL_MS) {
        return currencyCache.byHref;
    }
    const key = String(token || process.env.MS_TOKEN || '').trim();
    if (!key) return currencyCache.byHref;
    if (inflight) return inflight;
    inflight = (async () => {
        try {
            const resp = await axios.get(`${MS_BASE}/entity/currency`, {
                headers: { Authorization: `Bearer ${key}` },
                timeout: 20000,
                params: { limit: 100 },
            });
            const map = new Map();
            for (const row of resp.data?.rows || []) {
                const href = String(row?.meta?.href || '').trim();
                if (!href) continue;
                map.set(href, {
                    isoCode: String(row.isoCode || '').trim().toUpperCase(),
                    name: String(row.name || '').trim(),
                });
            }
            if (map.size) currencyCache = { ts: Date.now(), byHref: map };
            return currencyCache.byHref;
        } catch (_) {
            return currencyCache.byHref;
        } finally {
            inflight = null;
        }
    })();
    return inflight;
}

module.exports = {
    msPriceToRub,
    loadMsCurrencies,
    currencyHref,
};
