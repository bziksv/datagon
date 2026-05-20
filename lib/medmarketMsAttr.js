'use strict';

const axios = require('axios');

/** Имя пользовательского атрибута в МойСклад (как на карточке товара). */
const MEDMARKET_MS_ATTR_NAME = 'Код товара для медмаркета';

const MS_BASE_URL = 'https://api.moysklad.ru/api/remap/1.2';
const MS_ATTR_META_TTL_MS = 60 * 60 * 1000;
let msAttrMetaCache = { ts: 0, rows: [] };

function getMsToken(config) {
    return process.env.MS_TOKEN || (config && config.msToken) || '';
}

function formatMsAttrScalar(val) {
    if (val == null) return '';
    if (typeof val === 'object') {
        if (typeof val.name === 'string' && val.name) return String(val.name).trim();
        if (typeof val.value === 'string' && val.value) return String(val.value).trim();
        return '';
    }
    return String(val).trim();
}

function extractMedmarketCodeFromEntity(entity, attrsMetaByName) {
    if (!entity || !Array.isArray(entity.attributes)) return '';
    const byName = attrsMetaByName || null;
    for (const a of entity.attributes) {
        if (!a) continue;
        const nm = String(a.name || (byName && a.id && byName[a.id] ? byName[a.id] : '') || '').trim();
        if (nm === MEDMARKET_MS_ATTR_NAME) return formatMsAttrScalar(a.value);
    }
    return '';
}

function extractMedmarketCodeFromPayloadJson(payloadJson) {
    if (!payloadJson) return '';
    try {
        const entity = typeof payloadJson === 'string' ? JSON.parse(payloadJson) : payloadJson;
        return extractMedmarketCodeFromEntity(entity);
    } catch (_) {
        return '';
    }
}

async function fetchMsProductAttributesMeta(headers) {
    const now = Date.now();
    if (msAttrMetaCache.rows.length && now - msAttrMetaCache.ts < MS_ATTR_META_TTL_MS) {
        return msAttrMetaCache.rows;
    }
    const resp = await axios.get(`${MS_BASE_URL}/entity/product/metadata/attributes`, {
        headers,
        timeout: 30000,
    });
    msAttrMetaCache = { ts: now, rows: resp.data?.rows || [] };
    return msAttrMetaCache.rows;
}

function detectEntityKind(msTypeRaw) {
    const t = String(msTypeRaw || '').toLowerCase();
    if (t.includes('комплект')) return 'bundle';
    return 'product';
}

/**
 * Записать значение атрибута «Код товара для медмаркета» в МойСклад.
 */
async function pushMedmarketCodeToMs(config, { uuid, type, medmarket_code }) {
    const token = getMsToken(config);
    if (!token) {
        const e = new Error('MS_TOKEN не задан (env MS_TOKEN или config.msToken)');
        e.code = 'NO_TOKEN';
        throw e;
    }
    const u = String(uuid || '').trim();
    if (!u) {
        const e = new Error('У позиции нет uuid в ms_export');
        e.code = 'NO_UUID';
        throw e;
    }
    const headers = {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json;charset=utf-8',
    };
    const entityKind = detectEntityKind(type);
    const attrsMeta = await fetchMsProductAttributesMeta(headers);
    const metaRow = attrsMeta.find((r) => r && String(r.name) === MEDMARKET_MS_ATTR_NAME);
    if (!metaRow) {
        const e = new Error(`Атрибут «${MEDMARKET_MS_ATTR_NAME}» не найден в метаданных МС`);
        e.code = 'ATTR_NOT_FOUND';
        throw e;
    }
    const href = String(metaRow.meta?.href || '').trim();
    const val = medmarket_code == null ? '' : String(medmarket_code).trim();
    const attr = {
        meta: href
            ? { href, type: 'attributemetadata', mediaType: 'application/json' }
            : { type: 'attributemetadata', mediaType: 'application/json' },
        value: val,
    };
    if (metaRow.id) attr.id = String(metaRow.id);
    const url = `${MS_BASE_URL}/entity/${entityKind}/${encodeURIComponent(u)}`;
    try {
        await axios.put(url, { attributes: [attr] }, { headers, timeout: 30000 });
        return { ok: true, entity_kind: entityKind };
    } catch (e) {
        const httpStatus = e?.response?.status ? Number(e.response.status) : 0;
        const errBody = e?.response?.data;
        let msErr = '';
        if (errBody?.errors?.[0]) {
            msErr = String(errBody.errors[0].error || errBody.errors[0].message || '');
        }
        const err = new Error(`MS API ${httpStatus || 'NETWORK'}: ${msErr || e.message || 'unknown'}`);
        err.code = 'MS_PUT_FAILED';
        err.http_status = httpStatus;
        throw err;
    }
}

module.exports = {
    MEDMARKET_MS_ATTR_NAME,
    extractMedmarketCodeFromEntity,
    extractMedmarketCodeFromPayloadJson,
    pushMedmarketCodeToMs,
};
