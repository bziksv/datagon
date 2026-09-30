/**
 * Запись цены в CMS сайта (Bitrix / Webasyst) по маппингу my_sites.
 * Общий хелпер для «Мои товары» / «Цены сети».
 */
const mysql = require('mysql2/promise');

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
    await conn.query(
        `UPDATE ${siteCfg.table_products}
         SET ${siteCfg.field_price} = ?
         WHERE ${siteCfg.field_code} = ?
         LIMIT 1`,
        [finalPrice, String(product.source_id || '')]
    );
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
    roundPriceForCurrency,
    openSiteConnection,
    recalcWebasystProductPrimaryPrices,
    touchWebasystProductAfterPriceUpdate,
};
