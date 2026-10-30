'use strict';

/**
 * Разовый repair: Альмамед (my_sites.id=2) — карточки EUR/USD, куда маржа
 * ушла в рублях без конвертации (баг до fromRub в stickers_cms).
 *
 * Критерий жертвы: текущая price ≈ saleRub = round(buy/(1−%)) (или kop-вариант),
 * buy = stock_cost || buy_price из ms_export (как enrich в синке).
 *
 * Исправление: want = fromRub(saleRub, currency, fx, shop_currency.rate)
 * → CMS (applyPriceToCms) + my_products.price.
 *
 *   node scripts/maintenance/repair-almamed-unconverted-margin-prices.js --dry-run
 *   node scripts/maintenance/repair-almamed-unconverted-margin-prices.js --apply
 */

const path = require('path');
const mysql = require('mysql2/promise');
const config = require(path.join(__dirname, '..', '..', 'config'));
const {
    salePriceFromBuyMargin,
    tierKeyForBuyPrice,
    parseSitePriceMarginConfig,
    parseMoneyRub,
} = require('../../lib/datagonSitePriceMargin');
const { openCmsDbConnection } = require('../../lib/datagonCmsDb');
const { applyPriceToCms, roundPriceForCurrency } = require('../../lib/datagonCmsPriceWrite');
const { getFxRates, fromRub, normalizeCurrency } = require('../../lib/datagonFxRates');

const SITE_ID = 2;
const DRY_RUN = process.argv.includes('--dry-run') || !process.argv.includes('--apply');

/** Старый вариант до Math.round целых ₽ (kop). */
function saleKop(buy, pct) {
    return Math.round((buy / (1 - pct / 100)) * 100) / 100;
}

async function loadWaRates(cmsConn) {
    const map = new Map();
    try {
        const [rows] = await cmsConn.query(`SELECT code, rate FROM shop_currency`);
        for (const r of rows || []) {
            const code = normalizeCurrency(r.code);
            const rate = Number(r.rate);
            if (code && Number.isFinite(rate) && rate > 0) map.set(code, rate);
        }
    } catch (_) {
        /* ignore */
    }
    return map;
}

async function findVictims(db, cfg) {
    const [mps] = await db.query(
        `SELECT id, sku, name, price, currency, source_id, cms_product_id, updated_at
         FROM my_products
         WHERE site_id = ?
           AND COALESCE(is_active, 1) = 1
           AND CAST(price AS DECIMAL(18, 4)) > 0
           AND UPPER(TRIM(COALESCE(currency, ''))) NOT IN ('', 'RUB', 'RUR', '₽', 'РУБ', 'РУБ.')`,
        [SITE_ID]
    );

    const codes = [
        ...new Set(
            (mps || []).flatMap((r) =>
                [r.cms_product_id, r.sku]
                    .map((x) => String(x || '').trim().toUpperCase())
                    .filter(Boolean)
            )
        ),
    ];
    const msByCode = new Map();
    for (let i = 0; i < codes.length; i += 500) {
        const slice = codes.slice(i, i + 500);
        const [ms] = await db.query(
            `SELECT code, stock, stock_cost, buy_price
             FROM ms_export
             WHERE UPPER(TRIM(code)) IN (${slice.map(() => '?').join(',')})`,
            slice
        );
        for (const m of ms || []) {
            msByCode.set(String(m.code).trim().toUpperCase(), m);
        }
    }

    const hits = [];
    for (const r of mps || []) {
        const k1 = String(r.cms_product_id || '').trim().toUpperCase();
        const k2 = String(r.sku || '').trim().toUpperCase();
        const ms = msByCode.get(k1) || msByCode.get(k2);
        if (!ms) continue;
        const buy =
            parseMoneyRub(ms.stock_cost) != null
                ? parseMoneyRub(ms.stock_cost)
                : parseMoneyRub(ms.buy_price);
        if (buy == null || buy <= 0) continue;
        const tier = tierKeyForBuyPrice(buy);
        const pct = cfg.tiers[tier];
        if (pct == null || !Number.isFinite(pct)) continue;
        const rubRound = salePriceFromBuyMargin(buy, pct);
        const rubKop = saleKop(buy, pct);
        const have = Number(r.price);
        if (!Number.isFinite(have)) continue;
        const matchRound = Math.abs(have - rubRound) < 0.51;
        const matchKop = Math.abs(have - rubKop) < 0.02;
        if (!(matchRound || matchKop)) continue;
        if (have <= 50 || have <= buy * 0.5) continue;
        const saleRub = matchRound ? rubRound : rubKop;
        hits.push({
            id: Number(r.id),
            sku: r.sku,
            name: String(r.name || '').slice(0, 100),
            currency: normalizeCurrency(r.currency),
            source_id: r.source_id,
            cms_product_id: r.cms_product_id,
            price_now: have,
            sale_rub: saleRub,
            buy,
            pct,
            stock: Number(ms.stock) || 0,
            updated_at: r.updated_at,
        });
    }
    hits.sort((a, b) => b.price_now - a.price_now);
    return hits;
}

(async () => {
    const started = Date.now();
    console.log(DRY_RUN ? '[DRY-RUN] только отчёт, без записи' : '[APPLY] запись в CMS + my_products');

    const db = await mysql.createConnection({
        host: config.db.host,
        user: config.db.user,
        password: config.db.password,
        database: config.db.database,
    });

    const [[site]] = await db.query(`SELECT * FROM my_sites WHERE id = ? LIMIT 1`, [SITE_ID]);
    if (!site) {
        console.error('site_id=2 not found');
        process.exit(1);
    }
    const cfg = parseSitePriceMarginConfig(site.price_margin_json);
    const hits = await findVictims(db, cfg);
    const byC = {};
    for (const h of hits) byC[h.currency] = (byC[h.currency] || 0) + 1;
    console.log(
        JSON.stringify(
            {
                site: `${site.id}:${site.name}`,
                suspect_count: hits.length,
                by_currency: byC,
                top: hits.slice(0, 8).map((h) => ({
                    sku: h.sku,
                    currency: h.currency,
                    price_now: h.price_now,
                    sale_rub: h.sale_rub,
                    stock: h.stock,
                })),
            },
            null,
            2
        )
    );

    if (!hits.length) {
        await db.end();
        console.log('нечего чинить');
        return;
    }

    const cmsConn = await openCmsDbConnection(site, { connectTimeout: 20000 });
    const waRates = await loadWaRates(cmsConn);
    const fx = await getFxRates({ force: true });
    console.log('fx', fx);
    console.log(
        'wa rates',
        Object.fromEntries([...waRates.entries()].filter(([c]) => c === 'EUR' || c === 'USD'))
    );

    const summary = {
        planned: hits.length,
        written_cms: 0,
        written_mp: 0,
        unchanged: 0,
        skipped: 0,
        errors: [],
    };

    for (const h of hits) {
        const wantInCur = fromRub(h.sale_rub, h.currency, fx, waRates.get(h.currency));
        if (wantInCur == null) {
            summary.skipped += 1;
            if (summary.errors.length < 30) {
                summary.errors.push({ sku: h.sku, error: `нет курса для ${h.currency}` });
            }
            continue;
        }
        const want = roundPriceForCurrency(wantInCur, h.currency);
        if (!Number.isFinite(want) || want < 0) {
            summary.skipped += 1;
            continue;
        }
        // Уже правильно (на случай повторного прогона)
        if (Math.abs(h.price_now - want) < 0.005) {
            summary.unchanged += 1;
            continue;
        }
        // Защита: want должен быть заметно меньше текущей «рублёвой» цены
        if (!(want < h.price_now * 0.5)) {
            summary.skipped += 1;
            if (summary.errors.length < 30) {
                summary.errors.push({
                    sku: h.sku,
                    error: `guard: want ${want} не меньше половины now ${h.price_now}`,
                });
            }
            continue;
        }

        if (DRY_RUN) {
            if (summary.written_cms < 5) {
                console.log(
                    `  would ${h.sku} ${h.currency} ${h.price_now} → ${want} (rub ${h.sale_rub})`
                );
            }
            summary.written_cms += 1;
            continue;
        }

        try {
            await applyPriceToCms(
                cmsConn,
                site,
                {
                    source_id: h.source_id,
                    sku: h.sku,
                    cms_product_id: h.cms_product_id,
                },
                want,
                { deferStorefrontCacheClear: true }
            );
            summary.written_cms += 1;
            try {
                const [u] = await db.query(
                    `UPDATE my_products SET price = ?, currency = ? WHERE id = ? AND site_id = ? LIMIT 1`,
                    [want, h.currency, h.id, SITE_ID]
                );
                if (u && u.affectedRows) summary.written_mp += 1;
            } catch (e) {
                if (summary.errors.length < 30) {
                    summary.errors.push({
                        sku: h.sku,
                        error: `my_products: ${e.message || e}`,
                    });
                }
            }
        } catch (e) {
            summary.skipped += 1;
            if (summary.errors.length < 30) {
                summary.errors.push({ sku: h.sku, error: e.message || String(e) });
            }
        }
    }

    await cmsConn.end();
    await db.end();

    summary.duration_sec = Math.round((Date.now() - started) / 1000);
    console.log(JSON.stringify(summary, null, 2));
    if (DRY_RUN) {
        console.log('\nДля записи: node scripts/maintenance/repair-almamed-unconverted-margin-prices.js --apply');
    }
})().catch((e) => {
    console.error(e);
    process.exit(1);
});
