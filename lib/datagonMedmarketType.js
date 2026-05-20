'use strict';

/** Нормализация типа МС → «товар» | «комплект» | «услуга» (ключ стыковки code+тип). */
function medmarketItemTypeFromMsType(msTypeRaw) {
    const t = String(msTypeRaw || '')
        .trim()
        .toLowerCase();
    if (!t) return 'товар';
    if (t.includes('комплект')) return 'комплект';
    if (t.includes('услуг')) return 'услуга';
    return 'товар';
}

const MEDMARKET_ITEM_TYPES = new Set(['товар', 'комплект', 'услуга']);

/** Подпись типа в коде стыковки Motion: `10088+Товар`. */
const MEDMARKET_LINKAGE_TYPE_LABEL = {
    товар: 'Товар',
    комплект: 'Комплект',
    услуга: 'Услуга',
};

function medmarketLinkageTypeLabel(itemType) {
    const t = normalizeMedmarketItemType(itemType);
    return MEDMARKET_LINKAGE_TYPE_LABEL[t] || 'Товар';
}

/** Канонический «Код товара для медмаркета»: код МС + «+» + тип (как в карточке / Motion). */
function buildMedmarketLinkageCode(code, itemType) {
    const c = String(code || '').trim();
    if (!c) return '';
    return `${c}+${medmarketLinkageTypeLabel(itemType)}`;
}

function isMedmarketLinkageCodeValid(code, itemType, stored) {
    const expected = buildMedmarketLinkageCode(code, itemType);
    const s = String(stored == null ? '' : stored).trim();
    if (!s) return false;
    if (s === expected) return true;
    const c = String(code || '').trim();
    const wantType = normalizeMedmarketItemType(itemType);
    const m = s.match(/^(.+)\+(.+)$/);
    if (!m) return false;
    if (m[1].trim() !== c) return false;
    return normalizeMedmarketItemType(m[2]) === wantType;
}

function normalizeMedmarketItemType(raw) {
    const s = String(raw || '')
        .trim()
        .toLowerCase();
    if (s === 'товар' || s === 'product') return 'товар';
    if (s === 'комплект' || s === 'bundle' || s === 'kit') return 'комплект';
    if (s === 'услуга' || s === 'service') return 'услуга';
    return medmarketItemTypeFromMsType(raw);
}

module.exports = {
    medmarketItemTypeFromMsType,
    normalizeMedmarketItemType,
    medmarketLinkageTypeLabel,
    buildMedmarketLinkageCode,
    isMedmarketLinkageCodeValid,
    MEDMARKET_ITEM_TYPES,
    MEDMARKET_LINKAGE_TYPE_LABEL,
};
