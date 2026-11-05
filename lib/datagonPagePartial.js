/**
 * Исключения режима `partial` по специальности.
 * Пока правило не задано — раздел виден, запись закрыта (см. datagonPageRegistry).
 * Финансы делопроизводителя: только движение по трём юрлицам.
 */
const FINANCE_CLERK_CUSTOMER_CODES = Object.freeze([
    '303738907',
    'rf:альмамед',
    '303339655',
]);

const FINANCE_PARTIAL_BY_SPECIALTY = Object.freeze({
    делопроизводитель: {
        movement_only: true,
        customer_codes: FINANCE_CLERK_CUSTOMER_CODES,
    },
});

function normalizeSpecialtyName(name) {
    return String(name || '')
        .toLowerCase()
        .replace(/-/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function financePartialRule(actor, mode) {
    if (mode !== 'partial' || !actor) return null;
    const name = normalizeSpecialtyName(actor.specialty_name);
    return FINANCE_PARTIAL_BY_SPECIALTY[name] || { movement_only: true, customer_codes: [] };
}

function clampCustomerCodes(requested, allow) {
    if (!allow) return requested || [];
    const set = new Set(allow.map((c) => String(c).toLowerCase()));
    const picked = (requested || []).filter((c) => set.has(String(c).toLowerCase()));
    if (!picked.length) return allow.slice();
    return allow.filter((c) => picked.some((p) => String(p).toLowerCase() === String(c).toLowerCase()));
}

function filterOrgAliases(aliases, allow) {
    if (!allow || !aliases || typeof aliases !== 'object') return aliases || {};
    const set = new Set(allow.map((c) => String(c).toLowerCase()));
    const out = {};
    Object.keys(aliases).forEach((key) => {
        if (set.has(String(key).toLowerCase())) out[key] = aliases[key];
    });
    return out;
}

function cashRowInAllowlist(row, allow) {
    if (!allow) return true;
    const scope = String((row && row.scope) || '').toLowerCase();
    const code = String((row && row.customer_code) || '').trim().toLowerCase();
    if (!code || scope === 'all') return false;
    return allow.some((c) => String(c).toLowerCase() === code);
}

module.exports = {
    FINANCE_CLERK_CUSTOMER_CODES,
    financePartialRule,
    clampCustomerCodes,
    filterOrgAliases,
    cashRowInAllowlist,
};
