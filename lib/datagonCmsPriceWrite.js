/**
 * Запись цены в CMS сайта (Bitrix / Webasyst) по маппингу my_sites.
 * Общий хелпер для «Мои товары» / «Цены сети».
 */
const crypto = require('crypto');
const mysql = require('mysql2/promise');

/** Токен для /local/datagon/cache_clear.php на сателлите Bitrix (файл cache_clear.token). */
function bitrixCacheClearToken(siteCfg) {
    return crypto
        .createHash('sha256')
        .update(String(siteCfg?.db_pass || '') + '|datagon-bitrix-cache-clear-v1')
        .digest('hex');
}

/**
 * Сброс файлового кэша витрины Bitrix (catalog.element и т.п.).
 * Без этого ACTIVE=N в БД не виден на прямом URL — отдаётся старый HTML из bitrix/cache.
 */
async function clearBitrixStorefrontCache(siteCfg) {
    const domain = String(siteCfg?.domain || '')
        .trim()
        .replace(/^https?:\/\//i, '')
        .replace(/\/+$/, '');
    if (!domain) return { ok: false, error: 'no_domain' };
    const token = bitrixCacheClearToken(siteCfg);
    const url = `https://${domain}/local/datagon/cache_clear.php?token=${encodeURIComponent(token)}`;
    try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 25000);
        const res = await fetch(url, { method: 'GET', signal: ctrl.signal });
        clearTimeout(timer);
        const text = await res.text();
        let json = null;
        try {
            json = JSON.parse(text);
        } catch (_) {
            /* ignore */
        }
        if (!res.ok || !json || json.success !== true) {
            return {
                ok: false,
                status: res.status,
                body: String(text || '').slice(0, 240),
            };
        }
        return { ok: true, removed: json.removed || [] };
    } catch (e) {
        return { ok: false, error: e.message || String(e) };
    }
}

async function removeBitrixElementFromSearch(conn, elementId) {
    const eid = String(elementId);
    const [rows] = await conn.query(
        `SELECT ID FROM b_search_content
         WHERE ITEM_ID = ?
            OR URL LIKE ?
            OR URL LIKE ?
         LIMIT 50`,
        [eid, `%ID=${eid}%`, `%ID=${eid}&%`]
    );
    for (const row of rows || []) {
        const id = row.ID;
        for (const t of [
            'b_search_content_site',
            'b_search_content_title',
            'b_search_content_stem',
            'b_search_content_text',
            'b_search_content_param',
            'b_search_content_right',
            'b_search_content_freq',
        ]) {
            try {
                await conn.query(`DELETE FROM ${t} WHERE SEARCH_CONTENT_ID = ?`, [id]);
            } catch (_) {
                /* таблица может отсутствовать */
            }
        }
        await conn.query(`DELETE FROM b_search_content WHERE ID = ?`, [id]);
    }
    return (rows || []).length;
}

async function recalcWebasystProductPrimaryPrices(conn, siteCfg, productId) {
    const pid = Number(productId);
    if (!Number.isFinite(pid) || pid <= 0) return;
    const pTable = siteCfg.table_products;
    const sTable = siteCfg.wa_table_skus;
    try {
        const [curRows] = await conn.query(
            `SELECT 1 AS ok
             FROM information_schema.tables
             WHERE table_schema = DATABASE()
               AND table_name = 'shop_currency'
             LIMIT 1`
        );
        if (!curRows?.length) return;

        await conn.query(
            `UPDATE ${pTable} p
             JOIN (
                 SELECT p2.id, MIN(ps.price) AS min_price, MAX(ps.price) AS max_price
                 FROM ${pTable} p2
                 JOIN ${sTable} ps ON ps.product_id = p2.id
                 WHERE p2.id = ?
                 GROUP BY p2.id
             ) r ON p.id = r.id
             JOIN shop_currency c ON c.code = p.currency
             SET p.min_price = r.min_price * c.rate, p.max_price = r.max_price * c.rate
             WHERE p.id = ?`,
            [pid, pid]
        );

        await conn.query(
            `UPDATE ${pTable} p
             JOIN ${sTable} ps ON ps.product_id = p.id AND ps.id = p.sku_id
             JOIN shop_currency c ON c.code = p.currency
             SET p.price = ps.price * c.rate
             WHERE p.id = ?`,
            [pid]
        );

        await conn.query(
            `UPDATE ${pTable} p
             JOIN ${sTable} ps ON p.id = ps.product_id
             JOIN shop_currency c ON c.code = p.currency
             SET ps.primary_price = ps.price * c.rate
             WHERE p.id = ?`,
            [pid]
        );
    } catch (e) {
        console.error('[cmsPriceWrite] recalcWebasystProductPrimaryPrices:', e.message || e);
    }
}

async function touchWebasystProductAfterPriceUpdate(conn, siteCfg, sku) {
    const [skuRows] = await conn.query(
        `SELECT product_id
         FROM ${siteCfg.wa_table_skus}
         WHERE ${siteCfg.wa_field_sku_val} = ?
         LIMIT 1`,
        [sku]
    );
    if (!skuRows.length || !skuRows[0].product_id) return;
    const productId = Number(skuRows[0].product_id);
    if (!Number.isFinite(productId) || productId <= 0) return;

    const [skuColsRows] = await conn.query(`SHOW COLUMNS FROM ${siteCfg.wa_table_skus}`);
    const skuCols = new Set((skuColsRows || []).map((r) => String(r.Field || '').toLowerCase()));
    const skuSets = [];
    if (skuCols.has('update_datetime')) skuSets.push('update_datetime = NOW()');
    if (skuCols.has('edit_datetime')) skuSets.push('edit_datetime = NOW()');
    if (skuSets.length) {
        await conn.query(
            `UPDATE ${siteCfg.wa_table_skus}
             SET ${skuSets.join(', ')}
             WHERE ${siteCfg.wa_field_sku_val} = ?
             LIMIT 1`,
            [sku]
        );
    }

    const [prodColsRows] = await conn.query(`SHOW COLUMNS FROM ${siteCfg.table_products}`);
    const cols = new Set((prodColsRows || []).map((r) => String(r.Field || '').toLowerCase()));
    const sets = [];
    if (cols.has('edit_datetime')) sets.push('edit_datetime = NOW()');
    if (cols.has('update_datetime')) sets.push('update_datetime = NOW()');
    if (cols.has('edit_date')) sets.push('edit_date = NOW()');
    if (!sets.length) return;
    await conn.query(
        `UPDATE ${siteCfg.table_products}
         SET ${sets.join(', ')}
         WHERE id = ?
         LIMIT 1`,
        [productId]
    );
}

async function resolveBitrixCatalogElement(conn, product) {
    const xmlId = String(product.source_id || product.cms_product_id || '').trim();
    const sku = String(product.sku || '').trim();
    if (xmlId) {
        const [byXml] = await conn.query(
            `SELECT e.ID AS id, e.IBLOCK_ID AS iblock_id
             FROM b_iblock_element e
             INNER JOIN b_iblock ib ON ib.ID = e.IBLOCK_ID
             WHERE e.XML_ID = ?
             ORDER BY
               CASE WHEN LOWER(IFNULL(ib.CODE, '')) = 'catalog' THEN 0 ELSE 1 END,
               CASE WHEN IFNULL(e.CODE, '') <> '' THEN 0 ELSE 1 END,
               e.ID DESC
             LIMIT 1`,
            [xmlId]
        );
        if (byXml.length) return byXml[0];
    }
    if (sku) {
        const [bySku] = await conn.query(
            `SELECT e.ID AS id, e.IBLOCK_ID AS iblock_id
             FROM b_iblock_element e
             INNER JOIN b_iblock ib ON ib.ID = e.IBLOCK_ID
             INNER JOIN b_iblock_property p
               ON p.IBLOCK_ID = e.IBLOCK_ID
              AND p.CODE IN ('CML2_ARTICLE', 'ARTICLE', 'ARTICL', 'ARTICLS')
             INNER JOIN b_iblock_element_property ep
               ON ep.IBLOCK_ELEMENT_ID = e.ID
              AND ep.IBLOCK_PROPERTY_ID = p.ID
              AND TRIM(ep.VALUE) = ?
             ORDER BY
               CASE WHEN LOWER(IFNULL(ib.CODE, '')) = 'catalog' THEN 0 ELSE 1 END,
               e.ID DESC
             LIMIT 1`,
            [sku]
        );
        if (bySku.length) return bySku[0];
    }
    return null;
}

async function updateBitrixCatalogBasePrice(conn, productId, finalPrice) {
    const pid = Number(productId);
    if (!Number.isFinite(pid) || pid <= 0) return 0;
    const [base] = await conn.query(
        `SELECT ID FROM b_catalog_group WHERE BASE = 'Y' ORDER BY ID ASC LIMIT 1`
    );
    const groupId = base.length ? Number(base[0].ID) : 1;
    let hasScale = false;
    try {
        const [cols] = await conn.query(`SHOW COLUMNS FROM b_catalog_price LIKE 'PRICE_SCALE'`);
        hasScale = !!(cols && cols.length);
    } catch (_) {}
    const setSql = hasScale ? 'PRICE = ?, PRICE_SCALE = ?' : 'PRICE = ?';
    const params = hasScale ? [finalPrice, finalPrice, pid, groupId] : [finalPrice, pid, groupId];
    const [r] = await conn.query(
        `UPDATE b_catalog_price
         SET ${setSql}
         WHERE PRODUCT_ID = ? AND CATALOG_GROUP_ID = ?
         LIMIT 5`,
        params
    );
    if (r && r.affectedRows > 0) return r.affectedRows;
    if (hasScale) {
        await conn.query(
            `INSERT INTO b_catalog_price (PRODUCT_ID, CATALOG_GROUP_ID, PRICE, PRICE_SCALE, CURRENCY)
             VALUES (?, ?, ?, ?, 'RUB')`,
            [pid, groupId, finalPrice, finalPrice]
        );
    } else {
        await conn.query(
            `INSERT INTO b_catalog_price (PRODUCT_ID, CATALOG_GROUP_ID, PRICE, CURRENCY)
             VALUES (?, ?, ?, 'RUB')`,
            [pid, groupId, finalPrice]
        );
    }
    return 1;
}

/**
 * Витрина KaWe (и похожие Bitrix) показывает свойство PRICES, а не только b_catalog_price.
 */
async function updateBitrixPricesProperty(conn, elementId, iblockId, sku, finalPrice) {
    const eid = Number(elementId);
    const iid = Number(iblockId);
    if (!Number.isFinite(eid) || eid <= 0 || !Number.isFinite(iid) || iid <= 0) return 0;
    const [props] = await conn.query(
        `SELECT ID FROM b_iblock_property
         WHERE IBLOCK_ID = ? AND CODE = 'PRICES'
         LIMIT 1`,
        [iid]
    );
    if (!props.length) return 0;
    const propId = Number(props[0].ID);
    const priceStr = String(finalPrice);
    const skuTrim = String(sku || '').trim();

    if (skuTrim) {
        const [byDesc] = await conn.query(
            `UPDATE b_iblock_element_property
             SET VALUE = ?, VALUE_NUM = ?
             WHERE IBLOCK_ELEMENT_ID = ?
               AND IBLOCK_PROPERTY_ID = ?
               AND TRIM(IFNULL(DESCRIPTION, '')) = ?`,
            [priceStr, finalPrice, eid, propId, skuTrim]
        );
        if (byDesc && byDesc.affectedRows > 0) return byDesc.affectedRows;
    }

    const [all] = await conn.query(
        `UPDATE b_iblock_element_property
         SET VALUE = ?, VALUE_NUM = ?
         WHERE IBLOCK_ELEMENT_ID = ?
           AND IBLOCK_PROPERTY_ID = ?`,
        [priceStr, finalPrice, eid, propId]
    );
    if (all && all.affectedRows > 0) return all.affectedRows;

    await conn.query(
        `INSERT INTO b_iblock_element_property
           (IBLOCK_PROPERTY_ID, IBLOCK_ELEMENT_ID, VALUE, VALUE_TYPE, VALUE_NUM, DESCRIPTION)
         VALUES (?, ?, ?, 'text', ?, ?)`,
        [propId, eid, priceStr, finalPrice, skuTrim || null]
    );
    return 1;
}

/** Цена с пробелом тысяч для SEO/витрины Bitrix: 5905 → «5 905». */
function formatRubSpaced(value) {
    const n = Math.round(Number(value));
    if (!Number.isFinite(n) || n < 0) return String(value);
    return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

/**
 * Обновить закэшированные SEO-тексты элемента (b_iblock_element_iprop),
 * где шаблон когда-то подставил старую цену («от 6 169 ₽»).
 */
async function updateBitrixElementSeoPrice(conn, elementId, finalPrice) {
    const eid = Number(elementId);
    if (!Number.isFinite(eid) || eid <= 0) return 0;
    const spaced = formatRubSpaced(finalPrice);
    const plain = String(Math.round(Number(finalPrice)));
    if (!spaced || !plain) return 0;
    let [rows] = await conn.query(
        `SELECT IPROP_ID, VALUE FROM b_iblock_element_iprop
         WHERE ELEMENT_ID = ? AND VALUE REGEXP '[0-9][0-9 ]*[0-9][[:space:]]*₽'`,
        [eid]
    );
    if (!rows || !rows.length) {
        try {
            [rows] = await conn.query(
                `SELECT IPROP_ID, VALUE FROM b_iblock_element_iprop
                 WHERE ELEMENT_ID = ? AND (VALUE LIKE '%₽%' OR VALUE LIKE '%руб%')`,
                [eid]
            );
        } catch (_) {
            return 0;
        }
    }
    let updated = 0;
    for (const row of rows || []) {
        const next = String(row.VALUE || '').replace(
            /(\d[\d\s]*)(\s*₽)/g,
            `${spaced}$2`
        );
        if (next === row.VALUE) continue;
        await conn.query(
            `UPDATE b_iblock_element_iprop SET VALUE = ? WHERE ELEMENT_ID = ? AND IPROP_ID = ? LIMIT 1`,
            [next, eid, row.IPROP_ID]
        );
        updated += 1;
    }
    return updated;
}

async function applyPriceToCms(conn, siteCfg, product, finalPrice) {
    if (String(siteCfg.cms_type || '').toLowerCase() === 'webasyst') {
        const skuRowId = Number(product.source_id || 0);
        const skuCode = String(product.sku || '').trim();
        let skuMeta = [];
        if (Number.isFinite(skuRowId) && skuRowId > 0) {
            const [byId] = await conn.query(
                `SELECT id, product_id
                 FROM ${siteCfg.wa_table_skus}
                 WHERE id = ?
                 LIMIT 1`,
                [skuRowId]
            );
            skuMeta = byId;
        }
        if (!skuMeta.length && skuCode) {
            const [bySku] = await conn.query(
                `SELECT id, product_id
                 FROM ${siteCfg.wa_table_skus}
                 WHERE ${siteCfg.wa_field_sku_val} = ?
                 LIMIT 1`,
                [skuCode]
            );
            skuMeta = bySku;
        }
        if (!skuMeta.length) {
            const err = new Error('SKU не найден в Webasyst (source_id / артикул)');
            err.code = 'CMS_SKU_NOT_FOUND';
            throw err;
        }
        const waSkuId = Number(skuMeta[0].id);
        const waProductId = Number(skuMeta[0].product_id);
        await conn.query(
            `UPDATE ${siteCfg.wa_table_skus}
             SET ${siteCfg.wa_field_price_val} = ?
             WHERE id = ?
             LIMIT 1`,
            [finalPrice, waSkuId]
        );
        if (Number.isFinite(waProductId) && waProductId > 0) {
            await recalcWebasystProductPrimaryPrices(conn, siteCfg, waProductId);
        }
        await touchWebasystProductAfterPriceUpdate(conn, siteCfg, product.sku);
        return;
    }

    // Bitrix: пишем в b_catalog_price + витринное свойство PRICES (если есть).
    // UPDATE через view v_datagon_products недостаточно — сайт читает PRICES.
    const el = await resolveBitrixCatalogElement(conn, product);
    if (!el) {
        // fallback: старый путь через view / таблицу my_sites
        const [r] = await conn.query(
            `UPDATE ${siteCfg.table_products}
             SET ${siteCfg.field_price} = ?
             WHERE ${siteCfg.field_code} = ?
             LIMIT 1`,
            [finalPrice, String(product.source_id || '')]
        );
        if (!r || !r.affectedRows) {
            const err = new Error(
                `Bitrix: товар не найден (XML_ID/артикул ${product.source_id || product.sku || '—'})`
            );
            err.code = 'CMS_SKU_NOT_FOUND';
            throw err;
        }
        return;
    }
    await updateBitrixCatalogBasePrice(conn, el.id, finalPrice);
    await updateBitrixPricesProperty(conn, el.id, el.iblock_id, product.sku, finalPrice);
    try {
        await updateBitrixElementSeoPrice(conn, el.id, finalPrice);
    } catch (_) {
        /* SEO iprop опционален */
    }
}

/**
 * Деактивировать товар на сателлите (витрина): Bitrix ACTIVE=N / Webasyst status=0.
 * @returns {{ cms: string, element_id?: number, product_id?: number }}
 */
async function deactivateProductInCms(conn, siteCfg, product) {
    const cms = String(siteCfg.cms_type || '').toLowerCase();
    if (cms === 'webasyst') {
        const skuRowId = Number(product.source_id || 0);
        const skuCode = String(product.sku || '').trim();
        let skuMeta = [];
        if (Number.isFinite(skuRowId) && skuRowId > 0) {
            const [byId] = await conn.query(
                `SELECT id, product_id FROM ${siteCfg.wa_table_skus} WHERE id = ? LIMIT 1`,
                [skuRowId]
            );
            skuMeta = byId;
        }
        if (!skuMeta.length && skuCode) {
            const [bySku] = await conn.query(
                `SELECT id, product_id FROM ${siteCfg.wa_table_skus}
                 WHERE ${siteCfg.wa_field_sku_val} = ? LIMIT 1`,
                [skuCode]
            );
            skuMeta = bySku;
        }
        if (!skuMeta.length) {
            const err = new Error('SKU не найден в Webasyst для деактивации');
            err.code = 'CMS_SKU_NOT_FOUND';
            throw err;
        }
        const waProductId = Number(skuMeta[0].product_id);
        if (!Number.isFinite(waProductId) || waProductId <= 0) {
            const err = new Error('У SKU нет product_id в Webasyst');
            err.code = 'CMS_SKU_NOT_FOUND';
            throw err;
        }
        const [r] = await conn.query(
            `UPDATE ${siteCfg.table_products} SET status = 0 WHERE id = ? LIMIT 1`,
            [waProductId]
        );
        if (!r || !r.affectedRows) {
            const err = new Error(`Webasyst: товар #${waProductId} не обновлён`);
            err.code = 'CMS_DEACTIVATE_FAILED';
            throw err;
        }
        return { cms: 'webasyst', product_id: waProductId };
    }

    const el = await resolveBitrixCatalogElement(conn, product);
    if (!el) {
        const err = new Error(
            `Bitrix: товар не найден для деактивации (${product.source_id || product.sku || '—'})`
        );
        err.code = 'CMS_SKU_NOT_FOUND';
        throw err;
    }
    // ACTIVE=N + TIMESTAMP_X + суффикс CODE: SEF-URL перестаёт резолвиться после сброса кэша.
    const [r] = await conn.query(
        `UPDATE b_iblock_element
         SET ACTIVE = 'N',
             TIMESTAMP_X = NOW(),
             CODE = CASE
               WHEN CODE IS NULL OR TRIM(CODE) = '' THEN CONCAT('deactivated-', ID)
               WHEN CODE LIKE '%-deactivated-%' THEN CODE
               ELSE CONCAT(CODE, '-deactivated-', ID)
             END
         WHERE ID = ?
         LIMIT 1`,
        [el.id]
    );
    if (!r || !r.affectedRows) {
        const err = new Error(`Bitrix: элемент #${el.id} не обновлён`);
        err.code = 'CMS_DEACTIVATE_FAILED';
        throw err;
    }
    try {
        await conn.query(
            `UPDATE b_catalog_product SET AVAILABLE = 'N', TIMESTAMP_X = NOW() WHERE ID = ? LIMIT 1`,
            [el.id]
        );
    } catch (_) {
        /* колонка/строка может отсутствовать */
    }
    let search_removed = 0;
    try {
        search_removed = await removeBitrixElementFromSearch(conn, el.id);
    } catch (_) {
        /* поиск опционален */
    }
    try {
        await conn.query(
            `DELETE FROM b_cache_tag
             WHERE TAG IN (?, ?) OR TAG LIKE ?`,
            [`iblock_id_${el.iblock_id}`, `IBLOCK_ID_${el.iblock_id}`, `%${el.id}%`]
        );
    } catch (_) {
        /* tagged cache опционален */
    }
    const cache_clear = await clearBitrixStorefrontCache(siteCfg);
    const [[codeRow]] = await conn.query(
        `SELECT CODE AS code FROM b_iblock_element WHERE ID = ? LIMIT 1`,
        [el.id]
    );
    return {
        cms: 'bitrix',
        element_id: el.id,
        iblock_id: el.iblock_id,
        code: codeRow?.code || null,
        search_removed,
        cache_clear,
    };
}

/**
 * Включить цепочку разделов элемента (иначе SEF-URL с выключенным разделом даёт 404).
 * @returns {Promise<Array<{id:number, code:string|null}>>}
 */
async function activateBitrixSectionChain(conn, elementId) {
    const [[elRow]] = await conn.query(
        `SELECT IBLOCK_SECTION_ID AS section_id FROM b_iblock_element WHERE ID = ? LIMIT 1`,
        [elementId]
    );
    let sectionId = elRow?.section_id != null ? Number(elRow.section_id) : 0;
    if (!Number.isFinite(sectionId) || sectionId <= 0) {
        const [[link]] = await conn.query(
            `SELECT IBLOCK_SECTION_ID AS section_id
             FROM b_iblock_section_element
             WHERE IBLOCK_ELEMENT_ID = ?
             ORDER BY ADDITIONAL_PROPERTY_ID IS NOT NULL, IBLOCK_SECTION_ID ASC
             LIMIT 1`,
            [elementId]
        );
        sectionId = link?.section_id != null ? Number(link.section_id) : 0;
    }
    const activated = [];
    const seen = new Set();
    while (Number.isFinite(sectionId) && sectionId > 0 && !seen.has(sectionId)) {
        seen.add(sectionId);
        const [[sec]] = await conn.query(
            `SELECT ID AS id, CODE AS code, ACTIVE AS active, IBLOCK_SECTION_ID AS parent_id
             FROM b_iblock_section WHERE ID = ? LIMIT 1`,
            [sectionId]
        );
        if (!sec) break;
        if (String(sec.active || '') !== 'Y') {
            await conn.query(
                `UPDATE b_iblock_section
                 SET ACTIVE = 'Y', TIMESTAMP_X = NOW()
                 WHERE ID = ? LIMIT 1`,
                [sectionId]
            );
            activated.push({ id: sectionId, code: sec.code || null });
        }
        sectionId = sec.parent_id != null ? Number(sec.parent_id) : 0;
    }
    return activated;
}

/**
 * Включить товар на сателлите обратно: Bitrix ACTIVE=Y / Webasyst status=1.
 * Снимает суффикс CODE `…-deactivated-{ID}`, AVAILABLE=Y, поднимает цепочку разделов, сброс кэша витрины.
 * @returns {{ cms: string, element_id?: number, product_id?: number }}
 */
async function activateProductInCms(conn, siteCfg, product) {
    const cms = String(siteCfg.cms_type || '').toLowerCase();
    if (cms === 'webasyst') {
        const skuRowId = Number(product.source_id || 0);
        const skuCode = String(product.sku || '').trim();
        let skuMeta = [];
        if (Number.isFinite(skuRowId) && skuRowId > 0) {
            const [byId] = await conn.query(
                `SELECT id, product_id FROM ${siteCfg.wa_table_skus} WHERE id = ? LIMIT 1`,
                [skuRowId]
            );
            skuMeta = byId;
        }
        if (!skuMeta.length && skuCode) {
            const [bySku] = await conn.query(
                `SELECT id, product_id FROM ${siteCfg.wa_table_skus}
                 WHERE ${siteCfg.wa_field_sku_val} = ? LIMIT 1`,
                [skuCode]
            );
            skuMeta = bySku;
        }
        if (!skuMeta.length) {
            const err = new Error('SKU не найден в Webasyst для активации');
            err.code = 'CMS_SKU_NOT_FOUND';
            throw err;
        }
        const waProductId = Number(skuMeta[0].product_id);
        if (!Number.isFinite(waProductId) || waProductId <= 0) {
            const err = new Error('У SKU нет product_id в Webasyst');
            err.code = 'CMS_SKU_NOT_FOUND';
            throw err;
        }
        const [r] = await conn.query(
            `UPDATE ${siteCfg.table_products} SET status = 1 WHERE id = ? LIMIT 1`,
            [waProductId]
        );
        if (!r || !r.affectedRows) {
            const err = new Error(`Webasyst: товар #${waProductId} не обновлён`);
            err.code = 'CMS_ACTIVATE_FAILED';
            throw err;
        }
        return { cms: 'webasyst', product_id: waProductId };
    }

    const el = await resolveBitrixCatalogElement(conn, product);
    if (!el) {
        const err = new Error(
            `Bitrix: товар не найден для активации (${product.source_id || product.sku || '—'})`
        );
        err.code = 'CMS_SKU_NOT_FOUND';
        throw err;
    }
    const [r] = await conn.query(
        `UPDATE b_iblock_element
         SET ACTIVE = 'Y',
             TIMESTAMP_X = NOW(),
             CODE = CASE
               WHEN CODE = CONCAT('deactivated-', ID) THEN ''
               WHEN CODE LIKE CONCAT('%-deactivated-', ID) THEN
                 SUBSTRING(CODE, 1, CHAR_LENGTH(CODE) - CHAR_LENGTH(CONCAT('-deactivated-', ID)))
               ELSE CODE
             END
         WHERE ID = ?
         LIMIT 1`,
        [el.id]
    );
    if (!r || !r.affectedRows) {
        const err = new Error(`Bitrix: элемент #${el.id} не обновлён`);
        err.code = 'CMS_ACTIVATE_FAILED';
        throw err;
    }
    try {
        await conn.query(
            `UPDATE b_catalog_product SET AVAILABLE = 'Y', TIMESTAMP_X = NOW() WHERE ID = ? LIMIT 1`,
            [el.id]
        );
    } catch (_) {
        /* колонка/строка может отсутствовать */
    }
    let sections_activated = [];
    try {
        sections_activated = await activateBitrixSectionChain(conn, el.id);
    } catch (_) {
        sections_activated = [];
    }
    try {
        await conn.query(
            `DELETE FROM b_cache_tag
             WHERE TAG IN (?, ?) OR TAG LIKE ?`,
            [`iblock_id_${el.iblock_id}`, `IBLOCK_ID_${el.iblock_id}`, `%${el.id}%`]
        );
    } catch (_) {
        /* tagged cache опционален */
    }
    const cache_clear = await clearBitrixStorefrontCache(siteCfg);
    const [[codeRow]] = await conn.query(
        `SELECT CODE AS code, ACTIVE AS active FROM b_iblock_element WHERE ID = ? LIMIT 1`,
        [el.id]
    );
    return {
        cms: 'bitrix',
        element_id: el.id,
        iblock_id: el.iblock_id,
        code: codeRow?.code || null,
        active: codeRow?.active || 'Y',
        sections_activated,
        cache_clear,
    };
}

function roundPriceForCurrency(value, currency) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return NaN;
    const cur = String(currency || 'RUB').trim().toUpperCase();
    if (cur === 'RUB' || cur === 'RUR' || cur === '₽') {
        return Math.round(n);
    }
    const cents = Math.round(n * 100) / 100;
    if (cents <= 0) return Math.ceil(n * 100) / 100;
    return cents;
}

async function openSiteConnection(site) {
    return mysql.createConnection({
        host: site.db_host,
        user: site.db_user,
        password: site.db_pass,
        database: site.db_name,
        connectTimeout: 10000,
    });
}

module.exports = {
    applyPriceToCms,
    deactivateProductInCms,
    activateProductInCms,
    clearBitrixStorefrontCache,
    bitrixCacheClearToken,
    roundPriceForCurrency,
    openSiteConnection,
    recalcWebasystProductPrimaryPrices,
    touchWebasystProductAfterPriceUpdate,
};
