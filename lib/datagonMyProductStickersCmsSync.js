/**
 * Синк наклеек + остатков Datagon → Webasyst.
 * Features `dg_sticker_*` + остаток SKU (`shop_product_skus.count` / wa_field_stock_val).
 * Источник остатка — МойСклад: по умолчанию общий `ms_export.stock`; если у сайта
 * заданы `ms_stock_store_uuids` — сумма остатков только по выбранным складам.
 */
'use strict';

const { openCmsDbConnection } = require('./datagonCmsDb');
const {
    ensureMyProductStickerColumns,
    enrichRowsWithStickersAndMs,
} = require('./datagonMyProductStickers');
const { applySiteWarehouseStockToRows } = require('./msExportStockByStore');

/** Datagon field → Webasyst feature code */
const STICKER_CMS_MAP = Object.freeze([
    { field: 'sticker_has_ru', code: 'dg_sticker_has_ru' },
    { field: 'sticker_no_ru', code: 'dg_sticker_no_ru' },
    { field: 'sticker_in_stock', code: 'dg_sticker_in_stock' },
    { field: 'sticker_discontinued', code: 'dg_sticker_discontinued' },
    { field: 'sticker_not_supplied', code: 'dg_sticker_not_supplied' },
    { field: 'sticker_sale_active', code: 'dg_sticker_sale' },
]);

const FEATURE_CODES = STICKER_CMS_MAP.map((m) => m.code);

function as01(v) {
    return v === true || v === 1 || v === '1' ? 1 : 0;
}

function normalizeSiteIdFilter(raw) {
    const s = String(raw == null ? 'all' : raw).trim().toLowerCase();
    if (!s || s === 'all' || s === '*') return null;
    const n = Number(s);
    return Number.isFinite(n) && n > 0 ? n : null;
}

function safeSqlIdent(raw, fallback) {
    const s = String(raw || '').trim();
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(s)) return s;
    return fallback;
}

async function loadFeatureIds(cmsConn) {
    const [rows] = await cmsConn.query(
        `SELECT id, code FROM shop_feature WHERE code IN (${FEATURE_CODES.map(() => '?').join(',')})`,
        FEATURE_CODES
    );
    const byCode = new Map();
    for (const r of rows || []) {
        byCode.set(String(r.code), Number(r.id));
    }
    return byCode;
}

/**
 * Агрегат флагов по shop_product.id (несколько SKU → OR).
 */
function aggregateByCmsProduct(rows) {
    const map = new Map();
    for (const r of rows || []) {
        const pid = Number(r.cms_product_id);
        if (!Number.isFinite(pid) || pid <= 0) continue;
        let agg = map.get(pid);
        if (!agg) {
            agg = {
                cms_product_id: pid,
                sticker_has_ru: 0,
                sticker_no_ru: 0,
                sticker_in_stock: 0,
                sticker_discontinued: 0,
                sticker_not_supplied: 0,
                sticker_sale_active: 0,
            };
            map.set(pid, agg);
        }
        for (const m of STICKER_CMS_MAP) {
            if (as01(r[m.field])) agg[m.field] = 1;
        }
    }
    // «Нет РУ» гасит «Есть РУ» на уровне карточки CMS
    for (const agg of map.values()) {
        if (agg.sticker_no_ru) agg.sticker_has_ru = 0;
    }
    return [...map.values()];
}

async function applyProductStickers(cmsConn, featureIds, productId, flags) {
    let written = 0;
    let unchanged = 0;
    for (const m of STICKER_CMS_MAP) {
        const fid = featureIds.get(m.code);
        if (!fid) continue;
        const want = as01(flags[m.field]);
        const [cur] = await cmsConn.query(
            `SELECT feature_value_id FROM shop_product_features
             WHERE product_id = ? AND feature_id = ? AND sku_id IS NULL
             LIMIT 1`,
            [productId, fid]
        );
        const hasYes = cur && cur[0] && Number(cur[0].feature_value_id) === 1;
        if (want && hasYes) {
            unchanged += 1;
            continue;
        }
        if (!want && !hasYes) {
            unchanged += 1;
            continue;
        }
        if (want) {
            if (cur && cur[0]) {
                await cmsConn.query(
                    `UPDATE shop_product_features SET feature_value_id = 1
                     WHERE product_id = ? AND feature_id = ? AND sku_id IS NULL
                     LIMIT 1`,
                    [productId, fid]
                );
            } else {
                await cmsConn.query(
                    `INSERT INTO shop_product_features (product_id, sku_id, feature_id, feature_value_id)
                     VALUES (?, NULL, ?, 1)`,
                    [productId, fid]
                );
            }
        } else {
            await cmsConn.query(
                `DELETE FROM shop_product_features
                 WHERE product_id = ? AND feature_id = ? AND sku_id IS NULL`,
                [productId, fid]
            );
        }
        written += 1;
    }
    return { written, unchanged };
}

/**
 * Остаток на SKU Webasyst из `sticker_ms_stock` (общий МС или сумма складов сайта).
 * Без связи МС CMS count не трогаем.
 */
async function applySkuStocks(cmsConn, site, rows) {
    const table = safeSqlIdent(site && site.wa_table_skus, 'shop_product_skus');
    const stockField = safeSqlIdent(site && site.wa_field_stock_val, 'count');
    let written = 0;
    let unchanged = 0;
    let skipped = 0;
    for (const r of rows || []) {
        if (!Number(r.sticker_ms_linked)) {
            skipped += 1;
            continue;
        }
        const skuId = Number(r.source_id);
        if (!Number.isFinite(skuId) || skuId <= 0) {
            skipped += 1;
            continue;
        }
        const raw = Number(r.sticker_ms_stock);
        const want = Number.isFinite(raw) ? Math.max(0, Math.round(raw)) : 0;
        const [cur] = await cmsConn.query(
            `SELECT \`${stockField}\` AS stock FROM \`${table}\` WHERE id = ? LIMIT 1`,
            [skuId]
        );
        if (!cur || !cur[0]) {
            skipped += 1;
            continue;
        }
        const have = Number(cur[0].stock);
        if (Number.isFinite(have) && Math.round(have) === want) {
            unchanged += 1;
            continue;
        }
        await cmsConn.query(`UPDATE \`${table}\` SET \`${stockField}\` = ? WHERE id = ? LIMIT 1`, [
            want,
            skuId,
        ]);
        written += 1;
    }
    return { written, unchanged, skipped };
}

async function loadMyProductRows(db, siteId, opts) {
    const o = opts || {};
    const params = [siteId];
    let where =
        `site_id = ? AND COALESCE(is_active, 1) = 1
         AND cms_product_id IS NOT NULL AND TRIM(CAST(cms_product_id AS CHAR)) <> ''
         AND TRIM(CAST(cms_product_id AS CHAR)) <> '0'`;
    if (Array.isArray(o.productIds) && o.productIds.length) {
        const ids = o.productIds.map(Number).filter((n) => Number.isFinite(n) && n > 0);
        if (!ids.length) return [];
        where += ` AND id IN (${ids.map(() => '?').join(',')})`;
        params.push(...ids);
    }
    if (Array.isArray(o.cmsProductIds) && o.cmsProductIds.length) {
        const ids = o.cmsProductIds.map(Number).filter((n) => Number.isFinite(n) && n > 0);
        if (!ids.length) return [];
        where += ` AND cms_product_id IN (${ids.map(() => '?').join(',')})`;
        params.push(...ids);
    }
    const [rows] = await db.query(
        `SELECT id, site_id, source_id, cms_product_id, sku,
                sticker_no_ru, sticker_discontinued, sticker_not_supplied, sticker_sale,
                price_hold_until, price_hold_by, price_hold_note
         FROM my_products
         WHERE ${where}`,
        params
    );
    return rows || [];
}

/**
 * @param {import('mysql2/promise').Pool} db
 * @param {object} [opts]
 * @param {number|string} [opts.siteId] — один my_sites.id; иначе все Webasyst
 * @param {number[]} [opts.productIds] — ограничить строками my_products
 * @param {number[]} [opts.cmsProductIds]
 * @param {(msg: string) => void} [opts.onProgress]
 */
async function syncMyProductStickersToCms(db, opts) {
    const started = Date.now();
    await ensureMyProductStickerColumns(db);
    const o = opts || {};
    const onProgress = typeof o.onProgress === 'function' ? o.onProgress : () => {};

    const siteFilter = normalizeSiteIdFilter(o.siteId);
    let sitesSql = `SELECT * FROM my_sites WHERE LOWER(COALESCE(cms_type,'')) = 'webasyst'`;
    const siteParams = [];
    if (siteFilter) {
        sitesSql += ' AND id = ?';
        siteParams.push(siteFilter);
    }
    const [sites] = await db.query(sitesSql, siteParams);

    const summary = {
        success: true,
        sites_total: (sites || []).length,
        sites_ok: 0,
        sites_skipped: 0,
        sites_failed: 0,
        products: 0,
        written: 0,
        unchanged: 0,
        stock_written: 0,
        stock_unchanged: 0,
        stock_skipped: 0,
        errors: [],
        duration_sec: 0,
    };

    for (const site of sites || []) {
        const siteLabel = `${site.id}:${site.name || site.domain || ''}`;
        let cmsConn = null;
        try {
            onProgress(`Сайт ${siteLabel}: подключение…`);
            cmsConn = await openCmsDbConnection(site, { connectTimeout: 15000 });
            const featureIds = await loadFeatureIds(cmsConn);
            const missing = FEATURE_CODES.filter((c) => !featureIds.has(c));
            const haveAnyFeature = missing.length < FEATURE_CODES.length;
            if (missing.length && haveAnyFeature) {
                summary.errors.push({
                    site_id: site.id,
                    error: `Часть Features отсутствует: ${missing.join(', ')}`,
                });
            }
            if (!haveAnyFeature) {
                summary.errors.push({
                    site_id: site.id,
                    error: `Нет Features ${FEATURE_CODES.join(', ')} — пишем только остатки SKU`,
                });
            }

            const rows = await loadMyProductRows(db, site.id, o);
            if (!rows.length) {
                summary.sites_ok += 1;
                continue;
            }
            onProgress(`Сайт ${siteLabel}: обогащение ${rows.length} строк…`);
            await enrichRowsWithStickersAndMs(db, rows);
            applySiteWarehouseStockToRows(site, rows);

            if (haveAnyFeature) {
                const aggs = aggregateByCmsProduct(rows);
                summary.products += aggs.length;
                onProgress(`Сайт ${siteLabel}: наклейки ${aggs.length} карточек…`);
                for (const agg of aggs) {
                    const r = await applyProductStickers(cmsConn, featureIds, agg.cms_product_id, agg);
                    summary.written += r.written;
                    summary.unchanged += r.unchanged;
                }
            }

            onProgress(`Сайт ${siteLabel}: остатки SKU (${rows.length})…`);
            const stockRes = await applySkuStocks(cmsConn, site, rows);
            summary.stock_written += stockRes.written;
            summary.stock_unchanged += stockRes.unchanged;
            summary.stock_skipped += stockRes.skipped;

            summary.sites_ok += 1;
        } catch (e) {
            summary.sites_failed += 1;
            summary.errors.push({
                site_id: site.id,
                error: e && e.message ? e.message : String(e),
            });
            console.error('[stickers-cms]', siteLabel, e);
        } finally {
            if (cmsConn) {
                try {
                    await cmsConn.end();
                } catch (_) {}
            }
        }
    }

    summary.duration_sec = Math.round((Date.now() - started) / 1000);
    if (summary.sites_failed && !summary.sites_ok) summary.success = false;
    summary.message =
        `Сайтов ок ${summary.sites_ok}/${summary.sites_total}, наклеек полей ${summary.written}` +
        ` (без изм. ${summary.unchanged}), остатков записано ${summary.stock_written}` +
        ` (без изм. ${summary.stock_unchanged}, пропуск ${summary.stock_skipped})`;
    return summary;
}

module.exports = {
    STICKER_CMS_MAP,
    FEATURE_CODES,
    syncMyProductStickersToCms,
    normalizeSiteIdFilter,
};
