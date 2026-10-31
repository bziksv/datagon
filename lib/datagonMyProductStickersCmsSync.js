/**
 * Синк наклеек + остатков + цен (маржа сайта) Datagon → Webasyst.
 * Features `dg_sticker_*` + остаток SKU (`shop_product_skus.count` / wa_field_stock_val)
 * + цена SKU по тирам маржи от закупочной МС (`price_margin_json` на my_sites).
 * Источник остатка — МойСклад: по умолчанию общий `ms_export.stock`; если у сайта
 * заданы `ms_stock_store_uuids` — сумма остатков только по выбранным складам.
 */
'use strict';

const { openCmsDbConnection } = require('./datagonCmsDb');
const {
    ensureMyProductStickerColumns,
    enrichRowsWithStickersAndMs,
    isSaleActive,
    isPriceHoldActive: isHoldActiveSticker,
    resolveSalePriceNum,
    resolveSaleUntilRaw,
    needsSalePriceRestore,
    resolveSaleRestorePriceNum,
} = require('./datagonMyProductStickers');
const { applySiteWarehouseStockToRows } = require('./msExportStockByStore');
const {
    sitePriceMarginConfigured,
    attachSiteMarginPricesToRows,
} = require('./datagonSitePriceMargin');
const { applyPriceToCms, roundPriceForCurrency } = require('./datagonCmsPriceWrite');
const { getFxRates, fromRub, normalizeCurrency } = require('./datagonFxRates');

/** Datagon field → Webasyst Feature boolean (+ подпись для автосоздания в shop_feature) */
const STICKER_CMS_MAP = Object.freeze([
    { field: 'sticker_has_ru', code: 'dg_sticker_has_ru', name: 'Есть РУ' },
    { field: 'sticker_no_ru', code: 'dg_sticker_no_ru', name: 'Нет РУ' },
    { field: 'sticker_in_stock', code: 'dg_sticker_in_stock', name: 'Есть в наличии' },
    {
        field: 'sticker_discontinued',
        code: 'dg_sticker_discontinued',
        name: 'Снят с производства / аналог по запросу',
    },
    { field: 'sticker_not_supplied', code: 'dg_sticker_not_supplied', name: 'Не поставляется' },
    { field: 'sticker_sale_active', code: 'dg_sticker_sale', name: 'Скидка' },
]);

/** Срок акции на витрине Альмамед (varchar, дд-мм-гггг). */
const SALE_UNTIL_FEATURE = Object.freeze({
    code: 'dg_sticker_sale_until',
    name: 'Скидка до',
    type: 'varchar',
});

const FEATURE_CODES = [
    ...STICKER_CMS_MAP.map((m) => m.code),
    SALE_UNTIL_FEATURE.code,
];

function as01(v) {
    return v === true || v === 1 || v === '1' ? 1 : 0;
}

/**
 * Фильтр сайтов для синка.
 * @returns {null|number[]} null = все Webasyst; иначе список id (1+).
 */
function normalizeSiteIdFilter(raw) {
    if (Array.isArray(raw)) {
        const ids = raw
            .map((x) => Number(x))
            .filter((n) => Number.isFinite(n) && n > 0);
        return ids.length ? [...new Set(ids)] : null;
    }
    const s = String(raw == null ? 'all' : raw).trim().toLowerCase();
    if (!s || s === 'all' || s === '*') return null;
    const ids = s
        .split(/[,;\s]+/)
        .map((p) => Number(String(p).trim()))
        .filter((n) => Number.isFinite(n) && n > 0);
    return ids.length ? [...new Set(ids)] : null;
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
 * Если Features dg_sticker_* удалили/не создали в Webasyst — создать public.
 * Boolean-наклейки + varchar «Скидка до».
 */
async function ensureStickerFeatures(cmsConn) {
    let byCode = await loadFeatureIds(cmsConn);
    const toCreate = [];
    for (const m of STICKER_CMS_MAP) {
        if (!byCode.has(m.code)) {
            toCreate.push({ code: m.code, name: m.name, type: 'boolean' });
        }
    }
    if (!byCode.has(SALE_UNTIL_FEATURE.code)) {
        toCreate.push({
            code: SALE_UNTIL_FEATURE.code,
            name: SALE_UNTIL_FEATURE.name,
            type: SALE_UNTIL_FEATURE.type,
        });
    }
    for (const m of toCreate) {
        // eslint-disable-next-line no-await-in-loop
        await cmsConn.query(
            `INSERT INTO shop_feature
               (parent_id, code, cml1c_id, status, name, type, selectable, multiple, count)
             VALUES (NULL, ?, NULL, 'public', ?, ?, 0, 0, 0)`,
            [m.code, m.name, m.type]
        );
    }
    byCode = await loadFeatureIds(cmsConn);
    return byCode;
}

/** Календарная дата акции → дд-мм-гггг для витрины. */
function formatSaleUntilDdMmYyyy(raw) {
    if (raw == null || raw === '') return '';
    if (typeof raw === 'string') {
        const sm = raw.trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
        if (sm) return `${sm[3]}-${sm[2]}-${sm[1]}`;
        const rm = raw.trim().match(/^(\d{2})[.\-/](\d{2})[.\-/](\d{4})$/);
        if (rm) return `${rm[1]}-${rm[2]}-${rm[3]}`;
    }
    try {
        const d = raw instanceof Date ? raw : new Date(raw);
        if (!Number.isFinite(d.getTime())) return '';
        const day = d.getDate();
        const mo = d.getMonth() + 1;
        const y = d.getFullYear();
        return (
            (day < 10 ? '0' + day : String(day)) +
            '-' +
            (mo < 10 ? '0' + mo : String(mo)) +
            '-' +
            y
        );
    } catch (_) {
        return '';
    }
}

/**
 * Агрегат флагов по shop_product.id (несколько SKU → OR).
 * sale_until_label — макс. активный срок акции (дд-мм-гггг) или ''.
 */
function aggregateByCmsProduct(rows) {
    const map = new Map();
    const now = Date.now();
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
                sale_until_ms: 0,
                sale_until_label: '',
            };
            map.set(pid, agg);
        }
        for (const m of STICKER_CMS_MAP) {
            if (as01(r[m.field])) agg[m.field] = 1;
        }
        if (isSaleActive(r, now)) {
            const untilRaw = resolveSaleUntilRaw(r);
            const t = untilRaw != null ? new Date(untilRaw).getTime() : NaN;
            if (Number.isFinite(t) && t > agg.sale_until_ms) {
                agg.sale_until_ms = t;
                agg.sale_until_label = formatSaleUntilDdMmYyyy(untilRaw);
            }
        }
    }
    // «Нет РУ» гасит «Есть РУ» на уровне карточки CMS
    for (const agg of map.values()) {
        if (agg.sticker_no_ru) agg.sticker_has_ru = 0;
        if (!agg.sticker_sale_active) {
            agg.sale_until_label = '';
            agg.sale_until_ms = 0;
        }
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
    const saleUntilRes = await applySaleUntilFeature(
        cmsConn,
        featureIds,
        productId,
        flags && flags.sticker_sale_active ? flags.sale_until_label || '' : ''
    );
    written += saleUntilRes.written;
    unchanged += saleUntilRes.unchanged;
    return { written, unchanged };
}

/**
 * Feature varchar dg_sticker_sale_until = «дд-мм-гггг» или снятие.
 */
async function applySaleUntilFeature(cmsConn, featureIds, productId, labelRaw) {
    const fid = featureIds.get(SALE_UNTIL_FEATURE.code);
    if (!fid) return { written: 0, unchanged: 0 };
    const want = String(labelRaw || '').trim();
    const [cur] = await cmsConn.query(
        `SELECT pf.feature_value_id AS vid, v.value AS val
         FROM shop_product_features pf
         LEFT JOIN shop_feature_values_varchar v ON v.id = pf.feature_value_id
         WHERE pf.product_id = ? AND pf.feature_id = ? AND pf.sku_id IS NULL
         LIMIT 1`,
        [productId, fid]
    );
    const curVid = cur && cur[0] ? Number(cur[0].vid) : 0;
    const curVal = cur && cur[0] && cur[0].val != null ? String(cur[0].val) : '';

    if (!want) {
        if (!curVid) return { written: 0, unchanged: 1 };
        await cmsConn.query(
            `DELETE FROM shop_product_features
             WHERE product_id = ? AND feature_id = ? AND sku_id IS NULL`,
            [productId, fid]
        );
        return { written: 1, unchanged: 0 };
    }

    if (curVid && curVal === want) {
        return { written: 0, unchanged: 1 };
    }

    let valueId = 0;
    const [exist] = await cmsConn.query(
        `SELECT id FROM shop_feature_values_varchar
         WHERE feature_id = ? AND value = ?
         LIMIT 1`,
        [fid, want]
    );
    if (exist && exist[0]) {
        valueId = Number(exist[0].id);
    } else {
        const [ins] = await cmsConn.query(
            `INSERT INTO shop_feature_values_varchar (feature_id, sort, value, cml1c_id)
             VALUES (?, 0, ?, NULL)`,
            [fid, want]
        );
        valueId = Number(ins && ins.insertId) || 0;
    }
    if (!valueId) return { written: 0, unchanged: 0 };

    if (curVid) {
        await cmsConn.query(
            `UPDATE shop_product_features SET feature_value_id = ?
             WHERE product_id = ? AND feature_id = ? AND sku_id IS NULL
             LIMIT 1`,
            [valueId, productId, fid]
        );
    } else {
        await cmsConn.query(
            `INSERT INTO shop_product_features (product_id, sku_id, feature_id, feature_value_id)
             VALUES (?, NULL, ?, ?)`,
            [productId, fid, valueId]
        );
    }
    return { written: 1, unchanged: 0 };
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

function isPriceHoldActive(row) {
    return isHoldActiveSticker(row);
}

async function loadWebasystCurrencyRates(cmsConn) {
    try {
        const [rows] = await cmsConn.query(`SELECT code, rate FROM shop_currency`);
        const map = new Map();
        for (const r of rows || []) {
            const code = normalizeCurrency(r.code);
            const rate = Number(r.rate);
            if (code && Number.isFinite(rate) && rate > 0) map.set(code, rate);
        }
        return map;
    } catch (_) {
        return new Map();
    }
}

/**
 * Цены SKU:
 * 1) активная «Скидка» (sale_price) — всегда пишем на сайт (приоритет);
 * 2) иначе откат на sale_price_before, если выбран «вернуть после срока»;
 * 3) иначе активная заморозка — не трогаем;
 * 4) иначе при остатке > 0 и настроенной марже — закупка + наценка.
 */
async function applySkuMarginPrices(cmsConn, db, site, rows) {
    const out = {
        written: 0,
        unchanged: 0,
        skipped: 0,
        held: 0,
        sale_written: 0,
        sale_unchanged: 0,
        no_buy: 0,
        no_tier: 0,
        zero_stock: 0,
        currency_skip: 0,
        errors: [],
    };
    const marginOn = sitePriceMarginConfigured(site);
    if (marginOn) {
        attachSiteMarginPricesToRows(site, rows);
    }
    const fx = await getFxRates().catch(() => null);
    const waRates = await loadWebasystCurrencyRates(cmsConn);
    const pTable = safeSqlIdent(site && site.table_products, 'shop_product');
    const table = safeSqlIdent(site && site.wa_table_skus, 'shop_product_skus');
    const priceField = safeSqlIdent(site && site.wa_field_price_val, 'price');

    /**
     * @param {object} r
     * @param {number} wantInCur
     * @param {{ allowZero?: boolean }} [writeOpts] — allowZero только для явной акции «Скидка»;
     *   авто-маржа / откат нулевую цену в CMS не пишут (защита соседних SKU карточки).
     */
    async function writeSkuPrice(r, wantInCur, writeOpts) {
        const allowZero = !!(writeOpts && writeOpts.allowZero);
        const skuId = Number(r.source_id);
        let currency = normalizeCurrency(r.currency || 'RUB');
        const want = roundPriceForCurrency(wantInCur, currency);
        if (!Number.isFinite(want) || want < 0 || (!allowZero && !(want > 0))) {
            out.skipped += 1;
            return 'skip';
        }
        if (Number.isFinite(skuId) && skuId > 0) {
            try {
                const [curMeta] = await cmsConn.query(
                    `SELECT p.currency AS currency, sk.\`${priceField}\` AS price
                     FROM \`${table}\` sk
                     JOIN \`${pTable}\` p ON p.id = sk.product_id
                     WHERE sk.id = ?
                     LIMIT 1`,
                    [skuId]
                );
                if (curMeta && curMeta[0] && curMeta[0].currency) {
                    currency = normalizeCurrency(curMeta[0].currency);
                }
                const have = curMeta && curMeta[0] ? Number(curMeta[0].price) : NaN;
                const wantFinal = roundPriceForCurrency(wantInCur, currency);
                if (!Number.isFinite(wantFinal) || wantFinal < 0 || (!allowZero && !(wantFinal > 0))) {
                    out.skipped += 1;
                    return 'skip';
                }
                if (Number.isFinite(have) && Math.abs(have - wantFinal) < 0.005) {
                    return 'unchanged';
                }
                await applyPriceToCms(cmsConn, site, r, wantFinal, {
                    deferStorefrontCacheClear: true,
                });
                try {
                    await db.query(
                        'UPDATE my_products SET price = ?, currency = ? WHERE id = ? LIMIT 1',
                        [wantFinal, currency, r.id]
                    );
                } catch (_) {
                    /* локальный кэш цены необязателен */
                }
                return 'written';
            } catch (_) {
                /* fallback ниже */
            }
        }
        await applyPriceToCms(cmsConn, site, r, want, { deferStorefrontCacheClear: true });
        try {
            await db.query('UPDATE my_products SET price = ?, currency = ? WHERE id = ? LIMIT 1', [
                want,
                currency,
                r.id,
            ]);
        } catch (_) {}
        return 'written';
    }

    for (const r of rows || []) {
        if (!Number(r.sticker_ms_linked)) {
            out.skipped += 1;
            continue;
        }

        // 1) Акция «Скидка» — приоритет (даже при нулевом остатке / без маржи сайта).
        if (isSaleActive(r)) {
            const saleP = resolveSalePriceNum(r);
            if (saleP == null) {
                out.skipped += 1;
                continue;
            }
            try {
                const st = await writeSkuPrice(r, saleP, { allowZero: true });
                if (st === 'written') {
                    out.sale_written += 1;
                    out.written += 1;
                } else if (st === 'unchanged') {
                    out.sale_unchanged += 1;
                    out.unchanged += 1;
                }
            } catch (e) {
                out.skipped += 1;
                if (out.errors.length < 20) {
                    out.errors.push({
                        code: r.sku || r.cms_product_id || r.id,
                        error: e && e.message ? e.message : String(e),
                    });
                }
            }
            continue;
        }

        // 2) Откат на цену до скидки (если при постановке выбрали «вернуть»).
        if (needsSalePriceRestore(r)) {
            const restoreP = resolveSaleRestorePriceNum(r);
            if (restoreP != null) {
                try {
                    const st = await writeSkuPrice(r, restoreP);
                    await db.query(
                        `UPDATE my_products
                         SET price = ?, sale_restore_done = 1, updated_at = NOW()
                         WHERE id = ? LIMIT 1`,
                        [restoreP, Number(r.id)]
                    );
                    r.price = restoreP;
                    r.sale_restore_done = 1;
                    if (st === 'written') out.written += 1;
                    else if (st === 'unchanged') out.unchanged += 1;
                } catch (e) {
                    out.skipped += 1;
                    if (out.errors.length < 20) {
                        out.errors.push({
                            code: r.sku || r.cms_product_id || r.id,
                            error: e && e.message ? e.message : String(e),
                        });
                    }
                }
                continue;
            }
        }

        // 3) Обычная заморозка — цену не переписываем (ни маржой, ни иначе).
        if (isPriceHoldActive(r)) {
            out.held += 1;
            out.skipped += 1;
            continue;
        }

        // 4) Остаток > 0 → закупка + наценка (если маржа настроена).
        if (!marginOn) {
            out.skipped += 1;
            continue;
        }
        const stockNum = Number(r.sticker_ms_stock);
        if (!Number.isFinite(stockNum) || stockNum <= 0) {
            out.zero_stock += 1;
            out.skipped += 1;
            continue;
        }
        if (r.margin_sale_price == null) {
            if (r.ms_buy_price == null && r.ms_stock_cost == null) out.no_buy += 1;
            else out.no_tier += 1;
            out.skipped += 1;
            continue;
        }
        const wantRub = Number(r.margin_sale_price);
        if (!Number.isFinite(wantRub) || !(wantRub > 0)) {
            out.skipped += 1;
            continue;
        }
        try {
            const skuId = Number(r.source_id);
            let currency = normalizeCurrency(r.currency || 'RUB');
            // Живая валюта карточки в CMS — источник истины для Webasyst.
            if (Number.isFinite(skuId) && skuId > 0) {
                try {
                    const [curMeta] = await cmsConn.query(
                        `SELECT p.currency AS currency, sk.\`${priceField}\` AS price
                         FROM \`${table}\` sk
                         JOIN \`${pTable}\` p ON p.id = sk.product_id
                         WHERE sk.id = ?
                         LIMIT 1`,
                        [skuId]
                    );
                    if (curMeta && curMeta[0]) {
                        if (curMeta[0].currency) {
                            currency = normalizeCurrency(curMeta[0].currency);
                        }
                        const have = Number(curMeta[0].price);
                        const wantInCur = fromRub(wantRub, currency, fx, waRates.get(currency));
                        if (wantInCur == null) {
                            out.currency_skip += 1;
                            out.skipped += 1;
                            if (out.errors.length < 20) {
                                out.errors.push({
                                    code: r.sku || r.cms_product_id || r.id,
                                    error: `валюта ${currency}: нет курса для конвертации из RUB`,
                                });
                            }
                            continue;
                        }
                        const want = roundPriceForCurrency(wantInCur, currency);
                        if (!Number.isFinite(want) || !(want > 0)) {
                            out.skipped += 1;
                            continue;
                        }
                        if (Number.isFinite(have) && Math.abs(have - want) < 0.005) {
                            out.unchanged += 1;
                            continue;
                        }
                        await applyPriceToCms(cmsConn, site, r, want, {
                            deferStorefrontCacheClear: true,
                        });
                        try {
                            await db.query(
                                'UPDATE my_products SET price = ?, currency = ? WHERE id = ? LIMIT 1',
                                [want, currency, r.id]
                            );
                        } catch (_) {
                            /* локальный кэш цены необязателен */
                        }
                        out.written += 1;
                        continue;
                    }
                } catch (_) {
                    /* fallback ниже */
                }
            }

            const wantInCur = fromRub(wantRub, currency, fx, waRates.get(currency));
            if (wantInCur == null) {
                out.currency_skip += 1;
                out.skipped += 1;
                if (out.errors.length < 20) {
                    out.errors.push({
                        code: r.sku || r.cms_product_id || r.id,
                        error: `валюта ${currency}: нет курса для конвертации из RUB`,
                    });
                }
                continue;
            }
            const want = roundPriceForCurrency(wantInCur, currency);
            if (!Number.isFinite(want) || !(want > 0)) {
                out.skipped += 1;
                continue;
            }
            await applyPriceToCms(cmsConn, site, r, want, { deferStorefrontCacheClear: true });
            try {
                await db.query('UPDATE my_products SET price = ?, currency = ? WHERE id = ? LIMIT 1', [
                    want,
                    currency,
                    r.id,
                ]);
            } catch (_) {
                /* ignore */
            }
            out.written += 1;
        } catch (e) {
            out.skipped += 1;
            if (out.errors.length < 20) {
                out.errors.push({
                    code: r.sku || r.cms_product_id || r.id,
                    error: e && e.message ? e.message : String(e),
                });
            }
        }
    }
    return out;
}

/** Сколько CMS-карточек за один проход (SKU грузятся целиком по этим product_id). */
const CMS_PRODUCT_BATCH = Math.max(
    50,
    Math.min(1000, Number(process.env.DATAGON_STICKERS_CMS_PRODUCT_BATCH || 300) || 300)
);

function baseMyProductsWhere(siteId, opts, params) {
    const o = opts || {};
    let where =
        `site_id = ? AND COALESCE(is_active, 1) = 1
         AND cms_product_id IS NOT NULL AND TRIM(CAST(cms_product_id AS CHAR)) <> ''
         AND TRIM(CAST(cms_product_id AS CHAR)) <> '0'`;
    params.push(siteId);
    if (Array.isArray(o.productIds) && o.productIds.length) {
        const ids = o.productIds.map(Number).filter((n) => Number.isFinite(n) && n > 0);
        if (!ids.length) return null;
        where += ` AND id IN (${ids.map(() => '?').join(',')})`;
        params.push(...ids);
    }
    if (Array.isArray(o.cmsProductIds) && o.cmsProductIds.length) {
        const ids = o.cmsProductIds.map(Number).filter((n) => Number.isFinite(n) && n > 0);
        if (!ids.length) return null;
        where += ` AND cms_product_id IN (${ids.map(() => '?').join(',')})`;
        params.push(...ids);
    }
    return where;
}

async function loadMyProductRows(db, siteId, opts) {
    const params = [];
    const where = baseMyProductsWhere(siteId, opts, params);
    if (!where) return [];
    const [rows] = await db.query(
        `SELECT id, site_id, source_id, cms_product_id, sku, currency, price,
                sticker_no_ru, sticker_discontinued, sticker_not_supplied, sticker_sale,
                sale_price, sale_until, sale_price_before, sale_restore_on_end, sale_restore_done,
                price_hold_until, price_hold_by, price_hold_note
         FROM my_products
         WHERE ${where}`,
        params
    );
    return rows || [];
}

/**
 * Страница уникальных cms_product_id (cursor по CAST→UNSIGNED).
 * @returns {Promise<number[]>}
 */
async function loadCmsProductIdPage(db, siteId, opts, afterCmsProductId, limit) {
    const params = [];
    const where = baseMyProductsWhere(siteId, opts, params);
    if (!where) return [];
    const after = Number(afterCmsProductId) || 0;
    params.push(after, Math.max(1, Math.min(Number(limit) || CMS_PRODUCT_BATCH, 2000)));
    const [rows] = await db.query(
        `SELECT DISTINCT CAST(cms_product_id AS UNSIGNED) AS pid
         FROM my_products
         WHERE ${where}
           AND CAST(cms_product_id AS UNSIGNED) > ?
         ORDER BY pid ASC
         LIMIT ?`,
        params
    );
    return (rows || [])
        .map((r) => Number(r.pid))
        .filter((n) => Number.isFinite(n) && n > 0);
}

async function loadMyProductRowsForCmsProducts(db, siteId, cmsProductIds, opts) {
    const ids = (cmsProductIds || []).map(Number).filter((n) => Number.isFinite(n) && n > 0);
    if (!ids.length) return [];
    return loadMyProductRows(db, siteId, {
        ...(opts || {}),
        cmsProductIds: ids,
        productIds: undefined,
    });
}

/**
 * @param {import('mysql2/promise').Pool} db
 * @param {object} [opts]
 * @param {number|string} [opts.siteId] — один my_sites.id; иначе все Webasyst
 * @param {number[]} [opts.productIds] — ограничить строками my_products
 * @param {number[]} [opts.cmsProductIds]
 * @param {boolean} [opts.featuresOnly] — только Features `dg_sticker_*` (без остатков/цен).
 *   Нужен для точечного догона после set-sale / set-sticker: карточка Webasyst содержит
 *   несколько SKU, а цена акции уже записана в `applyPriceToCms` для одной строки —
 *   полный прогон иначе перетирает цены соседних артикулов маржой/нулями.
 * @param {(msg: string) => void} [opts.onProgress]
 */
async function syncMyProductStickersToCms(db, opts) {
    const started = Date.now();
    await ensureMyProductStickerColumns(db);
    const o = opts || {};
    const featuresOnly = o.featuresOnly === true;
    const onProgress = typeof o.onProgress === 'function' ? o.onProgress : () => {};

    const siteFilter = normalizeSiteIdFilter(o.siteId);
    let sitesSql = `SELECT * FROM my_sites WHERE LOWER(COALESCE(cms_type,'')) = 'webasyst'`;
    const siteParams = [];
    if (siteFilter && siteFilter.length === 1) {
        sitesSql += ' AND id = ?';
        siteParams.push(siteFilter[0]);
    } else if (siteFilter && siteFilter.length > 1) {
        sitesSql += ` AND id IN (${siteFilter.map(() => '?').join(',')})`;
        siteParams.push(...siteFilter);
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
        price_written: 0,
        price_unchanged: 0,
        price_skipped: 0,
        price_held: 0,
        price_sale_written: 0,
        price_no_buy: 0,
        price_no_tier: 0,
        price_zero_stock: 0,
        price_currency_skip: 0,
        errors: [],
        duration_sec: 0,
        batch_size: CMS_PRODUCT_BATCH,
    };

    for (const site of sites || []) {
        const siteLabel = `${site.id}:${site.name || site.domain || ''}`;
        let cmsConn = null;
        try {
            onProgress(`Сайт ${siteLabel}: подключение…`);
            cmsConn = await openCmsDbConnection(site, { connectTimeout: 15000 });
            const featureIds = await ensureStickerFeatures(cmsConn);
            const missing = FEATURE_CODES.filter((c) => !featureIds.has(c));
            const haveAnyFeature = missing.length < FEATURE_CODES.length;
            if (missing.length && haveAnyFeature) {
                summary.errors.push({
                    site_id: site.id,
                    error: `Часть Features отсутствует после ensure: ${missing.join(', ')}`,
                });
            }
            if (!haveAnyFeature) {
                summary.errors.push({
                    site_id: site.id,
                    error: `Нет Features ${FEATURE_CODES.join(', ')} — пишем только остатки SKU`,
                });
            }

            let afterPid = 0;
            let batchNo = 0;
            let siteHadRows = false;
            for (;;) {
                const productIds = await loadCmsProductIdPage(
                    db,
                    site.id,
                    o,
                    afterPid,
                    CMS_PRODUCT_BATCH
                );
                if (!productIds.length) break;
                siteHadRows = true;
                batchNo += 1;
                afterPid = productIds[productIds.length - 1];

                const rows = await loadMyProductRowsForCmsProducts(db, site.id, productIds, o);
                if (!rows.length) continue;

                onProgress(
                    `Сайт ${siteLabel}: пакет ${batchNo} — обогащение ${rows.length} SKU` +
                        ` (${productIds.length} карточек)…`
                );
                await enrichRowsWithStickersAndMs(db, rows);
                applySiteWarehouseStockToRows(site, rows);

                if (haveAnyFeature) {
                    const aggs = aggregateByCmsProduct(rows);
                    summary.products += aggs.length;
                    onProgress(
                        `Сайт ${siteLabel}: пакет ${batchNo} — наклейки ${aggs.length} карточек…`
                    );
                    for (const agg of aggs) {
                        const r = await applyProductStickers(
                            cmsConn,
                            featureIds,
                            agg.cms_product_id,
                            agg
                        );
                        summary.written += r.written;
                        summary.unchanged += r.unchanged;
                    }
                }

                if (!featuresOnly) {
                    onProgress(
                        `Сайт ${siteLabel}: пакет ${batchNo} — остатки SKU (${rows.length})…`
                    );
                    const stockRes = await applySkuStocks(cmsConn, site, rows);
                    summary.stock_written += stockRes.written;
                    summary.stock_unchanged += stockRes.unchanged;
                    summary.stock_skipped += stockRes.skipped;

                    if (sitePriceMarginConfigured(site)) {
                        onProgress(
                            `Сайт ${siteLabel}: пакет ${batchNo} — цены по марже (${rows.length})…`
                        );
                        const priceRes = await applySkuMarginPrices(cmsConn, db, site, rows);
                        summary.price_written += priceRes.written;
                        summary.price_unchanged += priceRes.unchanged;
                        summary.price_skipped += priceRes.skipped;
                        summary.price_held += priceRes.held;
                        summary.price_sale_written += priceRes.sale_written || 0;
                        summary.price_no_buy += priceRes.no_buy;
                        summary.price_no_tier += priceRes.no_tier;
                        summary.price_zero_stock += priceRes.zero_stock || 0;
                        summary.price_currency_skip += priceRes.currency_skip || 0;
                        for (const err of priceRes.errors || []) {
                            if (summary.errors.length >= 20) break;
                            summary.errors.push({
                                site_id: site.id,
                                code: err.code,
                                error: err.error,
                            });
                        }
                    }
                } else {
                    onProgress(
                        `Сайт ${siteLabel}: пакет ${batchNo} — featuresOnly, остатки/цены пропущены`
                    );
                }

                // Явно отпускаем ссылки пакета до следующего SELECT.
                rows.length = 0;
            }

            if (!siteHadRows) {
                summary.sites_ok += 1;
                continue;
            }

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
        ` (без изм. ${summary.stock_unchanged}, пропуск ${summary.stock_skipped})` +
        `, цен записано ${summary.price_written}` +
        ` (акций ${summary.price_sale_written}, без изм. ${summary.price_unchanged}, hold ${summary.price_held}` +
        `, stock0 ${summary.price_zero_stock}, валюта× ${summary.price_currency_skip}` +
        `, пропуск ${summary.price_skipped})`;

    // После выгрузки — пересчёт «закупка > конкурента» в снапшот (UI без долгого скана).
    try {
        const {
            rebuildBuyVsCompetitorAlerts,
        } = require('./datagonMyProductBuyVsCompetitor');
        onProgress('Пересчёт алертов «закупка > конкурента»…');
        const alertRes = await rebuildBuyVsCompetitorAlerts(db, {
            siteId: siteFilter,
            source: 'stickers_cms',
            onProgress,
        });
        summary.buy_vs_comp = {
            total: alertRes.total,
            duration_sec: alertRes.duration_sec,
            rebuilt_at: alertRes.rebuilt_at,
        };
        summary.message += `, алертов закупка>конкурент ${alertRes.total}`;
    } catch (e) {
        console.warn(
            '[stickers-cms] buy-vs-comp rebuild:',
            e && e.message ? e.message : e
        );
        summary.errors.push({
            code: 'buy_vs_comp_rebuild',
            error: e && e.message ? e.message : String(e),
        });
    }

    return summary;
}

module.exports = {
    STICKER_CMS_MAP,
    FEATURE_CODES,
    syncMyProductStickersToCms,
    normalizeSiteIdFilter,
};
