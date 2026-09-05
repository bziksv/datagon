'use strict';

/**
 * Канон URL для очереди/результатов: https + без www (один товар = один ключ).
 */

function canonicalizeSiteUrl(raw, opts) {
    const o = opts || {};
    try {
        const u = new URL(String(raw || '').trim());
        if (!/^https?:$/i.test(String(u.protocol || ''))) return '';
        u.protocol = 'https:';
        u.hostname = String(u.hostname || '')
            .toLowerCase()
            .replace(/^www\./, '');
        u.hash = '';
        if (!o.keepSearch) u.search = '';
        u.pathname = u.pathname.replace(/\/{2,}/g, '/');
        if (u.pathname.length > 1) u.pathname = u.pathname.replace(/\/$/, '');
        return u.toString();
    } catch (_) {
        return '';
    }
}

/** Ключ для группировки дублей http/https/www. */
function siteUrlCanonKey(raw) {
    const c = canonicalizeSiteUrl(raw);
    return c ? c.toLowerCase() : '';
}

/** http-близнец для проверки «уже есть в очереди». */
function httpTwinOfHttps(httpsUrl) {
    const s = String(httpsUrl || '');
    if (!/^https:\/\//i.test(s)) return '';
    return `http://${s.slice('https://'.length)}`;
}

module.exports = {
    canonicalizeSiteUrl,
    siteUrlCanonKey,
    httpTwinOfHttps,
};
