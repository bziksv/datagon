'use strict';

/**
 * Собирает витринные пути Bitrix для товаров по XML_ID.
 * Шаблон берётся из b_iblock.DETAIL_PAGE_URL (#SECTION_CODE# / #ELEMENT_CODE# / …).
 */

function expandBitrixDetailPath(template, opts) {
    const o = opts || {};
    const sectionCode = String(o.sectionCode || '').trim();
    const elementCode = String(o.elementCode || '').trim();
    const elementId = o.elementId != null ? String(o.elementId).trim() : '';
    let t = String(template || '').trim();
    if (!t) {
        if (sectionCode && elementCode) return `catalog/${sectionCode}/${elementCode}/`;
        if (elementCode) return `catalog/${elementCode}/`;
        return '';
    }
    t = t
        .replace(/#SITE_DIR#\/?/gi, '/')
        .replace(/#SECTION_CODE_PATH#/gi, sectionCode)
        .replace(/#SECTION_CODE#/gi, sectionCode)
        .replace(/#ELEMENT_CODE#/gi, elementCode)
        .replace(/#ELEMENT_ID#/gi, elementId)
        .replace(/#ID#/gi, elementId);
    t = t.replace(/\/{2,}/g, '/').replace(/^\/+/, '');
    if (t && !t.endsWith('/')) t += '/';
    return t;
}

/**
 * @param {import('mysql2/promise').Connection} conn — соединение с БД Bitrix
 * @param {string[]} xmlIds
 * @returns {Promise<Map<string,string>>} xml_id → path без домена (catalog/…/…)
 */
async function mapBitrixUrlPathsByXmlId(conn, xmlIds) {
    const ids = [
        ...new Set(
            (xmlIds || [])
                .map((x) => String(x || '').trim())
                .filter(Boolean)
        ),
    ];
    const out = new Map();
    if (!ids.length) return out;

    const chunkSize = 400;
    for (let i = 0; i < ids.length; i += chunkSize) {
        const chunk = ids.slice(i, i + chunkSize);
        // eslint-disable-next-line no-await-in-loop
        const [rows] = await conn.query(
            `
            SELECT
                e.XML_ID AS xml_id,
                e.ID AS element_id,
                e.CODE AS element_code,
                s.CODE AS section_code,
                ib.CODE AS iblock_code,
                ib.DETAIL_PAGE_URL AS detail_tpl
            FROM b_iblock_element e
            INNER JOIN b_iblock ib ON ib.ID = e.IBLOCK_ID
            LEFT JOIN b_iblock_section s ON s.ID = e.IBLOCK_SECTION_ID
            WHERE e.XML_ID IN (?)
              AND e.CODE IS NOT NULL
              AND e.CODE <> ''
            ORDER BY
              CASE WHEN LOWER(IFNULL(ib.CODE, '')) = 'catalog' THEN 0 ELSE 1 END,
              CASE WHEN IFNULL(s.CODE, '') <> '' THEN 0 ELSE 1 END,
              e.ID DESC
            `,
            [chunk]
        );
        for (const r of rows || []) {
            const xml = String(r.xml_id || '').trim();
            if (!xml || out.has(xml)) continue;
            const path = expandBitrixDetailPath(r.detail_tpl, {
                sectionCode: r.section_code,
                elementCode: r.element_code,
                elementId: r.element_id,
            });
            if (path) out.set(xml, path);
        }
    }
    return out;
}

/**
 * Дописывает url_key в строки синка Bitrix (source_id = XML_ID).
 * @param {import('mysql2/promise').Connection} conn
 * @param {Array<object>} rows
 */
async function attachBitrixUrlKeys(conn, rows) {
    if (!Array.isArray(rows) || !rows.length) return rows;
    try {
        const map = await mapBitrixUrlPathsByXmlId(
            conn,
            rows.map((r) => r && r.source_id)
        );
        if (!map.size) return rows;
        for (const r of rows) {
            if (!r) continue;
            const xml = String(r.source_id || '').trim();
            const path = xml ? map.get(xml) : '';
            if (path) r.url_key = path;
        }
    } catch (e) {
        console.warn('[bitrix-url] attachBitrixUrlKeys:', e && e.message ? e.message : e);
    }
    return rows;
}

module.exports = {
    expandBitrixDetailPath,
    mapBitrixUrlPathsByXmlId,
    attachBitrixUrlKeys,
};
