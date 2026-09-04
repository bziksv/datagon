'use strict';

/**
 * Профиль отсутствия «снизу вверх»:
 * dg_product_zero_stock_log (по code) + продажи → эпизоды → recommended_replenishment_days на SKU.
 * Рек. дни входят в формулу закупок на уровне товара (не rollup на всего поставщика).
 */

const { sqlSupplierProductWhere } = require('./datagonSuppliersSql');
const { salesJoinSql } = require('./datagonSupplierAnalysisSql');
const { parseFormulaSettings, loadSupplierReplenishmentDaysMap } = require('./datagonSalesFormula');

const CHRONIC_STREAK_DAYS = 14;
const FLICKER_MIN_EPISODES = 3;
const FLICKER_MAX_AVG_EPISODE = 3;
const RECOMMEND_PERCENTILE = 0.9;
const MIN_SALES_QTY_FOR_ROLLUP = 1;
const CACHE_TTL_MS = 90 * 1000;

const profileCache = new Map();

function clampDays(v, min, max) {
    const n = Math.round(Number(v));
    if (!Number.isFinite(n)) return min;
    return Math.min(max, Math.max(min, n));
}

function parseYmd(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || '').trim());
    if (!m) return null;
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

function dayDiff(a, b) {
    return Math.round((b - a) / 86400000);
}

/**
 * @param {string[]} sortedYmd — уникальные даты YYYY-MM-DD по возрастанию
 * @returns {{ start: string, end: string, days: number }[]}
 */
function buildEpisodesFromSortedDates(sortedYmd) {
    const episodes = [];
    if (!sortedYmd.length) return episodes;
    let start = sortedYmd[0];
    let prev = sortedYmd[0];
    let len = 1;
    for (let i = 1; i < sortedYmd.length; i += 1) {
        const d = sortedYmd[i];
        const a = parseYmd(prev);
        const b = parseYmd(d);
        if (!a || !b) continue;
        if (dayDiff(a, b) === 1) {
            len += 1;
            prev = d;
        } else {
            episodes.push({ start, end: prev, days: len });
            start = d;
            prev = d;
            len = 1;
        }
    }
    episodes.push({ start, end: prev, days: len });
    return episodes;
}

function classifySku(maxStreak, episodeCount, avgEpisode) {
    const chronic = maxStreak >= CHRONIC_STREAK_DAYS;
    const flicker =
        episodeCount >= FLICKER_MIN_EPISODES && avgEpisode > 0 && avgEpisode <= FLICKER_MAX_AVG_EPISODE;
    return { chronic, flicker };
}

/**
 * Пол рекомендации для SKU: не ниже глобали и не ниже уже заданного оверрайда поставщика
 * (чтобы «Применить рек.» не занижало вручную поднятый горизонт).
 */
function effectiveRecommendBaseline(globalDays, supplierDays) {
    const g = clampDays(globalDays != null ? globalDays : 30, 1, 3650);
    if (supplierDays == null || supplierDays === '') return g;
    const s = Math.round(Number(supplierDays));
    if (!Number.isFinite(s)) return g;
    return Math.max(g, clampDays(s, 0, 3650));
}

/**
 * Рекомендация дней пополнения по SKU — только из эпизодов нуля
 * (макс. простой и ceil(ср. эпизод)), без пола на глобаль/поставщика.
 * В формулу продаж эти дни поднимают k только если строго выше базы
 * (`resolveEffectiveReplenishment`). Без эпизодов — null.
 * @param {number} [_baselineDays] — устарело, игнорируется (совместимость вызовов)
 */
function recommendDaysForSku(maxStreak, avgEpisode, episodeCount, _baselineDays) {
    if (!episodeCount || maxStreak <= 0) return null;
    const fromAbsence = Math.max(maxStreak, Math.ceil(avgEpisode || 0));
    return clampDays(fromAbsence, 1, 3650);
}

function weightedPercentile(items, percentile) {
    const list = (items || [])
        .filter((it) => it && it.value != null && Number(it.weight) > 0)
        .map((it) => ({ value: Number(it.value), weight: Number(it.weight) }))
        .filter((it) => Number.isFinite(it.value) && Number.isFinite(it.weight));
    if (!list.length) return null;
    list.sort((a, b) => a.value - b.value);
    const totalW = list.reduce((s, it) => s + it.weight, 0);
    if (totalW <= 0) return null;
    const target = Math.max(0, Math.min(1, percentile)) * totalW;
    let acc = 0;
    for (const it of list) {
        acc += it.weight;
        if (acc >= target) return Math.round(it.value);
    }
    return Math.round(list[list.length - 1].value);
}

function cacheKey(days, supplierKey, pfFingerprint, baselineDays) {
    return `${days}|${supplierKey || '*'}|${pfFingerprint || 'all'}|b${baselineDays || 0}`;
}

function cacheGet(key) {
    const hit = profileCache.get(key);
    if (!hit || Date.now() - hit.ts > CACHE_TTL_MS) return null;
    return hit.payload;
}

function cacheSet(key, payload) {
    profileCache.set(key, { ts: Date.now(), payload });
    if (profileCache.size > 40) {
        const first = profileCache.keys().next().value;
        profileCache.delete(first);
    }
}

function invalidateSupplierAbsenceProfileCache() {
    profileCache.clear();
}

/**
 * @param {import('mysql2/promise').Pool} db
 * @param {object} opts
 * @param {number} opts.days
 * @param {string} [opts.supplierKey] — если задан, только этот поставщик
 * @param {number} [opts.baselineReplenishmentDays] — пол рекомендации (глобальные дни пополнения)
 * @param {object} [opts.appSettings] — если baseline не задан, берём из parseFormulaSettings
 */
async function loadAbsenceProfile(db, opts) {
    const days = clampDays(opts && opts.days, 7, 365);
    const supplierKey = opts && opts.supplierKey ? String(opts.supplierKey).trim().slice(0, 255) : '';
    const pf = (opts && opts.projectFilter) || {};
    const pfSql = pf.sql || '';
    const pfParams = Array.isArray(pf.params) ? pf.params : [];
    let baselineDays = opts && opts.baselineReplenishmentDays;
    if (baselineDays == null || baselineDays === '') {
        try {
            const cfg = parseFormulaSettings((opts && opts.appSettings) || {});
            baselineDays = cfg.replenishmentDays;
        } catch (_e) {
            baselineDays = 30;
        }
    }
    baselineDays = clampDays(baselineDays, 1, 3650);
    const supplierRdMap = await loadSupplierReplenishmentDaysMap(db);
    const key = cacheKey(
        days,
        supplierKey || '*',
        pf.fingerprint || 'all',
        baselineDays + '|s' + supplierRdMap.size,
    );
    const cached = cacheGet(key);
    if (cached) return { ...cached, cache: { hit: true } };

    const productWhere = sqlSupplierProductWhere('mse');
    const dateParams = [days];
    let supplierFilterSql = '';
    if (supplierKey) {
        supplierFilterSql = ' AND TRIM(mse.supplier) = ? ';
        dateParams.push(supplierKey);
    }

    const [dateRows] = await db.query(
        `SELECT TRIM(mse.supplier) AS supplier_key,
                z.code AS code,
                DATE_FORMAT(z.ts_date, '%Y-%m-%d') AS ts_date
           FROM dg_product_zero_stock_log z
           INNER JOIN ms_export mse ON mse.code = z.code
          WHERE z.ts_date >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
            AND ${productWhere}
            ${supplierFilterSql}
          GROUP BY TRIM(mse.supplier), z.code, z.ts_date
          ORDER BY TRIM(mse.supplier), z.code, z.ts_date`,
        dateParams,
    );

    const salesParams = [...pfParams, days];
    let salesSupplierSql = '';
    if (supplierKey) {
        salesSupplierSql = ' AND TRIM(e.supplier) = ? ';
        salesParams.push(supplierKey);
    }
    const [salesRows] = await db.query(
        `SELECT TRIM(e.supplier) AS supplier_key,
                p.ms_export_code AS code,
                SUM(p.quantity) AS sales_qty,
                SUM(p.sum_minor) / 100 AS sales_revenue
         ${salesJoinSql('e', pfSql)}
           AND d.moment >= DATE_SUB(NOW(), INTERVAL ? DAY)
           ${salesSupplierSql}
         GROUP BY TRIM(e.supplier), p.ms_export_code`,
        salesParams,
    );

    /** @type {Map<string, { supplier_key: string, code: string, dates: string[] }>} */
    const byCode = new Map();
    for (const r of dateRows || []) {
        const sk = String(r.supplier_key || '').trim();
        const code = String(r.code || '').trim();
        if (!sk || !code) continue;
        const mapKey = sk + '\0' + code;
        let slot = byCode.get(mapKey);
        if (!slot) {
            slot = { supplier_key: sk, code, dates: [] };
            byCode.set(mapKey, slot);
        }
        const d = String(r.ts_date || '').slice(0, 10);
        if (d) slot.dates.push(d);
    }

    /** @type {Map<string, { sales_qty: number, sales_revenue: number }>} */
    const salesMap = new Map();
    for (const r of salesRows || []) {
        const sk = String(r.supplier_key || '').trim();
        const code = String(r.code || '').trim();
        if (!sk || !code) continue;
        salesMap.set(sk + '\0' + code, {
            sales_qty: Number(r.sales_qty) || 0,
            sales_revenue: Number(r.sales_revenue) || 0,
        });
    }

    /** @type {Map<string, object[]>} */
    const skusBySupplier = new Map();
    for (const slot of byCode.values()) {
        const sales = salesMap.get(slot.supplier_key + '\0' + slot.code) || {
            sales_qty: 0,
            sales_revenue: 0,
        };
        const episodes = buildEpisodesFromSortedDates(slot.dates);
        const episode_count = episodes.length;
        const absent_days = slot.dates.length;
        const max_streak_days = episodes.reduce((m, e) => Math.max(m, e.days), 0);
        const avg_episode_days =
            episode_count > 0
                ? Math.round((episodes.reduce((s, e) => s + e.days, 0) / episode_count) * 100) / 100
                : 0;
        const flags = classifySku(max_streak_days, episode_count, avg_episode_days);
        const supplierOverrideDays = supplierRdMap.has(slot.supplier_key)
            ? supplierRdMap.get(slot.supplier_key)
            : null;
        const skuBaseline = effectiveRecommendBaseline(baselineDays, supplierOverrideDays);
        const recommended_replenishment_days = recommendDaysForSku(
            max_streak_days,
            avg_episode_days,
            episode_count,
            skuBaseline,
        );
        const sku = {
            code: slot.code,
            supplier_key: slot.supplier_key,
            absent_days,
            episode_count,
            max_streak_days,
            avg_episode_days,
            sales_qty: sales.sales_qty,
            sales_revenue: sales.sales_revenue,
            recommended_replenishment_days,
            recommend_baseline_days: skuBaseline,
            supplier_replenishment_days: supplierOverrideDays,
            chronic: flags.chronic,
            flicker: flags.flicker,
        };
        if (!skusBySupplier.has(slot.supplier_key)) skusBySupplier.set(slot.supplier_key, []);
        skusBySupplier.get(slot.supplier_key).push(sku);
    }

    // SKU с продажами, но без нулевых дней в логе — в rollup не входят (recommended null).
    for (const [mapKey, sales] of salesMap.entries()) {
        if (byCode.has(mapKey)) continue;
        const sep = mapKey.indexOf('\0');
        if (sep < 0) continue;
        const sk = mapKey.slice(0, sep);
        const code = mapKey.slice(sep + 1);
        if (!skusBySupplier.has(sk)) skusBySupplier.set(sk, []);
        skusBySupplier.get(sk).push({
            code,
            supplier_key: sk,
            absent_days: 0,
            episode_count: 0,
            max_streak_days: 0,
            avg_episode_days: 0,
            sales_qty: sales.sales_qty,
            sales_revenue: sales.sales_revenue,
            recommended_replenishment_days: null,
            chronic: false,
            flicker: false,
        });
    }

    /** @type {Record<string, object>} */
    const suppliers = {};
    for (const [sk, skus] of skusBySupplier.entries()) {
        const withAbsence = skus.filter((s) => s.episode_count > 0);
        const rollupItems = withAbsence
            .filter((s) => Number(s.sales_qty) >= MIN_SALES_QTY_FOR_ROLLUP)
            .map((s) => ({
                value: s.recommended_replenishment_days,
                weight: Math.max(Number(s.sales_revenue) || 0, Number(s.sales_qty) || 0),
            }));
        const recommended = weightedPercentile(rollupItems, RECOMMEND_PERCENTILE);
        const chronic_sku_count = withAbsence.filter((s) => s.chronic).length;
        const flicker_sku_count = withAbsence.filter((s) => s.flicker).length;
        const absence_days_sum = withAbsence.reduce((s, x) => s + (x.absent_days || 0), 0);
        const absence_episode_count = withAbsence.reduce((s, x) => s + (x.episode_count || 0), 0);
        const chronic_max_streak_days = withAbsence.reduce(
            (m, x) => Math.max(m, x.max_streak_days || 0),
            0,
        );
        const avgEpisodes =
            withAbsence.length > 0
                ? withAbsence.reduce((s, x) => s + (x.avg_episode_days || 0), 0) / withAbsence.length
                : 0;
        const topProblem = withAbsence
            .slice()
            .sort(
                (a, b) =>
                    (b.max_streak_days || 0) - (a.max_streak_days || 0) ||
                    (b.sales_revenue || 0) - (a.sales_revenue || 0),
            )
            .slice(0, 5)
            .map((s) => ({
                code: s.code,
                max_streak_days: s.max_streak_days,
                episode_count: s.episode_count,
                recommended_replenishment_days: s.recommended_replenishment_days,
                sales_revenue: s.sales_revenue,
                chronic: s.chronic,
                flicker: s.flicker,
            }));

        suppliers[sk] = {
            supplier_key: sk,
            recommended_replenishment_days: recommended,
            absence_sku_count: withAbsence.length,
            absence_days_sum,
            absence_episode_count,
            absence_avg_episode_days: withAbsence.length
                ? Math.round(avgEpisodes * 100) / 100
                : 0,
            chronic_sku_count,
            chronic_max_streak_days,
            flicker_sku_count,
            recommend_sku_count: rollupItems.length,
            recommend_percentile: RECOMMEND_PERCENTILE,
            thresholds: {
                chronic_streak_days: CHRONIC_STREAK_DAYS,
                flicker_min_episodes: FLICKER_MIN_EPISODES,
                flicker_max_avg_episode: FLICKER_MAX_AVG_EPISODE,
                baseline_replenishment_days: baselineDays,
            },
            top_problem_skus: topProblem,
        };
    }

    const payload = {
        days,
        baseline_replenishment_days: baselineDays,
        suppliers,
        skus_by_supplier: Object.fromEntries(skusBySupplier),
        meta: {
            chronic_streak_days: CHRONIC_STREAK_DAYS,
            flicker_min_episodes: FLICKER_MIN_EPISODES,
            flicker_max_avg_episode: FLICKER_MAX_AVG_EPISODE,
            recommend_percentile: RECOMMEND_PERCENTILE,
            baseline_replenishment_days: baselineDays,
            recommend_rule:
                'max(max_streak, ceil(avg_episode), max(global_days, supplier_replenishment_days|0)); короткий нуль не даёт рек. ниже эффективной базы; «Применить» пишет только dg_supplier_settings — в формулу попадает после сохранения',
        },
        cache: { hit: false },
    };
    cacheSet(key, payload);
    return payload;
}

async function loadSupplierAbsenceRollupMap(db, days, projectFilter, appSettings) {
    const profile = await loadAbsenceProfile(db, { days, projectFilter, appSettings });
    return {
        map: profile.suppliers || {},
        meta: profile.meta,
        days: profile.days,
        baseline_replenishment_days: profile.baseline_replenishment_days,
        cache: profile.cache,
    };
}

async function loadSupplierAbsenceSkus(db, supplierKey, days, projectFilter, appSettings) {
    const profile = await loadAbsenceProfile(db, {
        days,
        supplierKey,
        projectFilter,
        appSettings,
    });
    const sk = String(supplierKey || '').trim();
    const rollup = (profile.suppliers && profile.suppliers[sk]) || null;
    const skus = (profile.skus_by_supplier && profile.skus_by_supplier[sk]) || [];
    const sorted = skus
        .filter((s) => s.episode_count > 0 || s.recommended_replenishment_days != null)
        .sort(
            (a, b) =>
                (b.recommended_replenishment_days || 0) - (a.recommended_replenishment_days || 0) ||
                (b.max_streak_days || 0) - (a.max_streak_days || 0) ||
                (b.sales_revenue || 0) - (a.sales_revenue || 0),
        );
    return {
        days: profile.days,
        rollup,
        rows: sorted,
        meta: profile.meta,
        cache: profile.cache,
    };
}

/**
 * Лёгкий batch: рек. дни пополнения по списку кодов (для формулы закупок / карточки).
 * @returns {Promise<Map<string, { recommended_replenishment_days: number|null, max_streak_days: number, episode_count: number, avg_episode_days: number }>>}
 */
async function loadSkuRecommendedDaysByCodes(db, codes, appSettings) {
    /** @type {Map<string, { recommended_replenishment_days: number|null, max_streak_days: number, episode_count: number, avg_episode_days: number }>} */
    const out = new Map();
    const list = [...new Set((codes || []).map((c) => String(c || '').trim()).filter(Boolean))];
    if (!db || !list.length) return out;

    let baselineDays = 30;
    try {
        baselineDays = clampDays(parseFormulaSettings(appSettings || {}).replenishmentDays, 1, 3650);
    } catch (_e) {
        baselineDays = 30;
    }
    const supplierRdMap = await loadSupplierReplenishmentDaysMap(db);
    const absenceDays = Math.max(
        7,
        Math.min(365 * 3, Math.round(Number((appSettings && appSettings.sales_formula_absence_analysis_days) || 210))),
    );

    const placeholders = list.map(() => '?').join(',');
    const [dateRows] = await db.query(
        `SELECT z.code AS code,
                TRIM(mse.supplier) AS supplier_key,
                DATE_FORMAT(z.ts_date, '%Y-%m-%d') AS ts_date
           FROM dg_product_zero_stock_log z
           INNER JOIN ms_export mse ON mse.code = z.code
          WHERE z.ts_date >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
            AND z.code IN (${placeholders})
          GROUP BY z.code, TRIM(mse.supplier), z.ts_date
          ORDER BY z.code, z.ts_date`,
        [absenceDays, ...list],
    );

    /** @type {Map<string, { supplier_key: string, dates: string[] }>} */
    const byCode = new Map();
    for (const r of dateRows || []) {
        const code = String(r.code || '').trim();
        if (!code) continue;
        let slot = byCode.get(code);
        if (!slot) {
            slot = { supplier_key: String(r.supplier_key || '').trim(), dates: [] };
            byCode.set(code, slot);
        }
        const ymd = String(r.ts_date || '').trim();
        if (ymd) slot.dates.push(ymd);
    }

    for (const code of list) {
        const slot = byCode.get(code);
        if (!slot || !slot.dates.length) {
            out.set(code, {
                recommended_replenishment_days: null,
                max_streak_days: 0,
                episode_count: 0,
                avg_episode_days: 0,
            });
            continue;
        }
        const dates = [...new Set(slot.dates)].sort();
        const episodes = buildEpisodesFromSortedDates(dates);
        const episode_count = episodes.length;
        const max_streak_days = episodes.reduce((m, e) => Math.max(m, e.days), 0);
        const avg_episode_days =
            episode_count > 0
                ? Math.round((episodes.reduce((s, e) => s + e.days, 0) / episode_count) * 100) / 100
                : 0;
        const supplierOverrideDays = supplierRdMap.has(slot.supplier_key)
            ? supplierRdMap.get(slot.supplier_key)
            : null;
        const skuBaseline = effectiveRecommendBaseline(baselineDays, supplierOverrideDays);
        const recommended_replenishment_days = recommendDaysForSku(
            max_streak_days,
            avg_episode_days,
            episode_count,
            skuBaseline,
        );
        out.set(code, {
            recommended_replenishment_days,
            max_streak_days,
            episode_count,
            avg_episode_days,
        });
    }
    return out;
}

module.exports = {
    CHRONIC_STREAK_DAYS,
    FLICKER_MIN_EPISODES,
    FLICKER_MAX_AVG_EPISODE,
    RECOMMEND_PERCENTILE,
    buildEpisodesFromSortedDates,
    recommendDaysForSku,
    effectiveRecommendBaseline,
    weightedPercentile,
    loadAbsenceProfile,
    loadSupplierAbsenceRollupMap,
    loadSupplierAbsenceSkus,
    loadSkuRecommendedDaysByCodes,
    invalidateSupplierAbsenceProfileCache,
};
