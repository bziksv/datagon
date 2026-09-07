'use strict';

/**
 * Конвертация НДС МойСклад → форматы Ozon / Wildberries / Яндекс Маркет.
 * Вход: строки из ms_export.vat вроде «без НДС», «0», «5», «7», «10», «20», «20%», «22».
 */

/**
 * @param {*} msVat
 * @returns {{ ok: boolean, percent: number|null, isNone: boolean, pretty: string, error?: string }}
 */
function parseMsVat(msVat) {
    const raw = String(msVat == null ? '' : msVat).trim();
    if (!raw) {
        return { ok: false, percent: null, isNone: false, pretty: '', error: 'НДС МС пустой' };
    }
    const lower = raw.toLowerCase().replace(/\s+/g, ' ');
    if (/без\s*ндс|не\s*облагается|ндс\s*не\s*облагается/.test(lower)) {
        return { ok: true, percent: null, isNone: true, pretty: 'Без НДС' };
    }
    const m = lower.match(/(\d+(?:[.,]\d+)?)\s*%?/);
    if (!m) {
        return {
            ok: false,
            percent: null,
            isNone: false,
            pretty: '',
            error: 'Не удалось разобрать НДС МС: ' + raw,
        };
    }
    const pct = Math.round(parseFloat(String(m[1]).replace(',', '.')));
    if (!Number.isFinite(pct) || pct < 0) {
        return {
            ok: false,
            percent: null,
            isNone: false,
            pretty: '',
            error: 'Некорректный процент НДС МС: ' + raw,
        };
    }
    if (pct === 0) {
        return { ok: true, percent: 0, isNone: true, pretty: 'Без НДС' };
    }
    return { ok: true, percent: pct, isNone: false, pretty: String(pct) };
}

/**
 * Ozon API vat: доля как строка.
 * @returns {string|null}
 */
function msVatToOzonApi(msVat) {
    const p = parseMsVat(msVat);
    if (!p.ok) return null;
    if (p.isNone) return '0';
    switch (p.percent) {
        case 5:
            return '0.05';
        case 7:
            return '0.07';
        case 10:
            return '0.10';
        case 20:
        case 22:
            return '0.20';
        default:
            return null;
    }
}

/**
 * WB характеристика «Ставка НДС» (id 15001405).
 * Справочник `GET /content/v2/directory/vat`: строки вида
 * `"0"|"5"|"7"|"10"|"20"|"22"|"Без НДС"|…` — **не** числовой код `6`.
 * Раньше слали `'6'` для «без НДС»: cards/update отвечал OK, но ставка на карточке
 * не менялась (на живых карточках значение `["Без НДС"]`).
 * @returns {string|null}
 */
function msVatToWbCharValue(msVat) {
    const p = parseMsVat(msVat);
    if (!p.ok) return null;
    if (p.isNone) return 'Без НДС';
    switch (p.percent) {
        case 5:
            return '5';
        case 7:
            return '7';
        case 10:
            return '10';
        case 12:
            return '12';
        case 13:
            return '13';
        case 16:
            return '16';
        case 20:
            return '20';
        case 22:
            return '22';
        case 0:
            return '0';
        default:
            return null;
    }
}

/**
 * YM vat id (обратно к ymVatText в marketplaceExports.js).
 * none → 6, 0% → 5, 5 → 10, 7 → 11, 10 → 2, 20 → 7, 22 → 14.
 * @returns {number|null}
 */
function msVatToYmVatId(msVat) {
    const p = parseMsVat(msVat);
    if (!p.ok) return null;
    if (p.percent === null && p.isNone) return 6;
    if (p.percent === 0) return 5;
    switch (p.percent) {
        case 5:
            return 10;
        case 7:
            return 11;
        case 10:
            return 2;
        case 20:
            return 7;
        case 22:
            return 14;
        default:
            return null;
    }
}

module.exports = {
    parseMsVat,
    msVatToOzonApi,
    msVatToWbCharValue,
    msVatToYmVatId,
};
