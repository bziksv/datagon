'use strict';

const axios = require('axios');
const config = require('../config');

/** Кэш имён справочников МС (uom, country…) по meta.href. */
const msMetaNameCache = new Map();

function msAuthHeaders() {
    const token = String(process.env.MS_TOKEN || config.msToken || '').trim();
    if (!token) return null;
    return { Authorization: `Bearer ${token}` };
}

async function resolveMsMetaName(refObj) {
    const href = String(refObj?.meta?.href || '').trim();
    if (!href) return '';
    if (msMetaNameCache.has(href)) return msMetaNameCache.get(href);
    const headers = msAuthHeaders();
    if (!headers) {
        msMetaNameCache.set(href, '');
        return '';
    }
    try {
        const resp = await axios.get(href, { headers, timeout: 15000 });
        const name = String(resp?.data?.name || '').trim();
        msMetaNameCache.set(href, name);
        return name;
    } catch (_) {
        msMetaNameCache.set(href, '');
        return '';
    }
}

/**
 * Собрать уникальные uom href из payload_json строк и разрешить имена (для пакетных выгрузок).
 * @param {Array<{ payload_json?: string|object }>} rows
 * @returns {Promise<Map<string, string>>}
 */
async function buildUomHrefNameMapForRows(rows) {
    const hrefSet = new Set();
    for (const row of rows || []) {
        let payload = row?.payload_json;
        if (payload == null || payload === '') continue;
        if (typeof payload === 'string') {
            try {
                payload = JSON.parse(payload);
            } catch {
                continue;
            }
        }
        if (!payload || !payload.uom) continue;
        const u = payload.uom;
        if (String(u?.name || '').trim()) continue;
        const href = String(u?.meta?.href || '').trim();
        if (href) hrefSet.add(href);
    }
    const map = new Map();
    if (!hrefSet.size) return map;
    await Promise.all(
        [...hrefSet].map(async (href) => {
            const name = await resolveMsMetaName({ meta: { href } });
            map.set(href, name);
        })
    );
    return map;
}

/**
 * Ед. измерения из payload карточки МС.
 * @param {object|null} payload
 * @param {Map<string, string>|null} [hrefToName] — для пакетного экспорта
 * @param {{ fallback?: string }} [opts]
 */
function uomLabelFromPayload(payload, hrefToName, opts) {
    const fallback = opts && opts.fallback != null ? String(opts.fallback) : '';
    if (!payload || !payload.uom) return fallback;
    const u = payload.uom;
    if (typeof u === 'string' && u.trim()) return u.trim();
    const direct = String(u?.name || '').trim();
    if (direct) return direct;
    const href = String(u?.meta?.href || '').trim();
    if (href && hrefToName && hrefToName.has(href)) {
        const resolved = String(hrefToName.get(href) || '').trim();
        if (resolved) return resolved;
    }
    return fallback;
}

/** Одна карточка: при meta без name — GET по href. */
async function resolveUomLabelFromPayload(payload, opts) {
    const fallback = opts && opts.fallback != null ? String(opts.fallback) : '';
    const sync = uomLabelFromPayload(payload, null, { fallback: '' });
    if (sync) return sync;
    if (!payload || !payload.uom) return fallback;
    const resolved = await resolveMsMetaName(payload.uom);
    return resolved || fallback;
}

module.exports = {
    resolveMsMetaName,
    buildUomHrefNameMapForRows,
    uomLabelFromPayload,
    resolveUomLabelFromPayload,
};
