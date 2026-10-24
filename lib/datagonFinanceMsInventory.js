'use strict';

/**
 * Товарный остаток МойСклад в финансах (Альмамед):
 * оценка Σ(остаток × себестоимость) только «Товар» + складская позиция «Да»
 * (как карточка «Сумма по товарам» на /moysklad.html);
 * официальный снимок на конец месяца → dg_finance_ms_inventory_month.
 * История: report/stock/all?filter=moment=YYYY-MM-DD 23:59:59 (МСК),
 * пересечение с кодами ms_export, у которых сейчас stock_position = Да.
 */

const axios = require('axios');
const finCred = require('./datagonFinanceCredentials');
const { getFinanceMsInventorySyncMeta } = require('./datagonFinanceMsInventorySyncRevision');

const CUSTOMER_CODES_KEY = 'finance_ms_inventory_customer_codes';
const ALMA_NAME_RE = /альмамед/i;
const MS_BASE = 'https://api.moysklad.ru/api/remap/1.2';

/** SQL: складская позиция «Да» (как в huckster / min_stock / suppliers). */
const STOCK_POSITION_YES_SQL = `LOWER(TRIM(COALESCE(stock_position, ''))) IN ('да', 'yes', '1', 'true')`;

let schemaReady = null;

function moscowYmdParts(d) {
    const dt = d instanceof Date ? d : new Date();
    const fmt = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Europe/Moscow',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    });
    const parts = fmt.formatToParts(dt);
    const get = (t) => {
        const p = parts.find((x) => x.type === t);
        return p ? p.value : '';
    };
    return {
        y: parseInt(get('year'), 10),
        m: parseInt(get('month'), 10),
        d: parseInt(get('day'), 10),
        ymd: `${get('year')}-${get('month')}-${get('day')}`,
    };
}

function isLastCalendarDayOfMonthMsk(d) {
    const p = moscowYmdParts(d);
    if (!p.y || !p.m || !p.d) return false;
    const last = new Date(p.y, p.m, 0).getDate();
    return p.d === last;
}

function currentYmMsk(d) {
    const p = moscowYmdParts(d);
    if (!p.y || !p.m) return '';
    return `${p.y}-${String(p.m).padStart(2, '0')}`;
}

/**
 * Официальный снимок месяца — только если as_of (МСК) = последний календарный день ym.
 * Ручной «Запустить сейчас» mid-month не должен замораживать карточку «Товар (МС)» до EOM.
 */
function snapshotIsOfficialEom(snap, ym) {
    if (!snap || snap.as_of_at == null) return false;
    const key = String(ym || snap.ym || '').trim();
    if (!/^\d{4}-\d{2}$/.test(key)) return false;
    const y = parseInt(key.slice(0, 4), 10);
    const m = parseInt(key.slice(5, 7), 10);
    if (!y || !m) return false;
    const last = new Date(y, m, 0).getDate();
    const p = moscowYmdParts(snap.as_of_at instanceof Date ? snap.as_of_at : new Date(snap.as_of_at));
    return p.y === y && p.m === m && p.d === last;
}

async function ensureMsInventorySchema(db) {
    if (schemaReady) return schemaReady;
    schemaReady = (async () => {
        await db.query(`
            CREATE TABLE IF NOT EXISTS dg_finance_ms_inventory_month (
                ym CHAR(7) NOT NULL,
                value_products DECIMAL(18,2) NOT NULL DEFAULT 0,
                value_bundles DECIMAL(18,2) NULL,
                as_of_at DATETIME NOT NULL,
                source VARCHAR(16) NOT NULL DEFAULT 'auto',
                meta_json JSON NULL,
                synced_at DATETIME NOT NULL,
                PRIMARY KEY (ym),
                KEY idx_fin_ms_inv_synced (synced_at)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);
    })();
    return schemaReady;
}

/** Формула как GET /api/ms/stats: Товар/Комплект, без плакатов, только складская «Да». */
async function computeInventoryValueFromMsExport(db) {
    const buyToDec = `CAST(
        REPLACE(
            REPLACE(
                REPLACE(
                    REPLACE(buy_price, '₽', ''),
                    ' ',
                    ''
                ),
                ' ',
                ''
            ),
            ',',
            '.'
        ) AS DECIMAL(15,2)
    )`;
    const unitCostExpr = `COALESCE(
        stock_cost,
        CASE WHEN buy_price IS NULL OR buy_price = '' THEN 0 ELSE COALESCE(${buyToDec}, 0) END,
        0
    )`;
    const prodValExpr = `CASE
        WHEN type = 'Товар'
             AND ${STOCK_POSITION_YES_SQL}
             AND COALESCE(stock, 0) > 0
             AND COALESCE(stock_quantity, stock, 0) > 0
        THEN stock * (${unitCostExpr})
        ELSE 0
    END`;
    const bundleValExpr = `CASE
        WHEN type = 'Комплект'
             AND ${STOCK_POSITION_YES_SQL}
             AND COALESCE(stock, 0) > 0
        THEN stock * (${unitCostExpr})
        ELSE 0
    END`;
    const [[row]] = await db.query(
        `
        SELECT
            ROUND(COALESCE(SUM(${prodValExpr}), 0), 2) AS value_products,
            ROUND(COALESCE(SUM(${bundleValExpr}), 0), 2) AS value_bundles,
            SUM(CASE WHEN type = 'Товар'
                      AND ${STOCK_POSITION_YES_SQL}
                      AND COALESCE(stock, 0) > 0
                      AND COALESCE(stock_quantity, stock, 0) > 0
                     THEN 1 ELSE 0 END) AS sku_products,
            SUM(CASE WHEN type = 'Комплект'
                      AND ${STOCK_POSITION_YES_SQL}
                      AND COALESCE(stock, 0) > 0
                     THEN 1 ELSE 0 END) AS sku_bundles
          FROM ms_export
         WHERE type IN ('Товар', 'Комплект')
           AND LOWER(IFNULL(name, '')) NOT LIKE '%плакат%'
           AND ${STOCK_POSITION_YES_SQL}
    `
    );
    return {
        value_products: Math.round((Number(row && row.value_products) || 0) * 100) / 100,
        value_bundles: Math.round((Number(row && row.value_bundles) || 0) * 100) / 100,
        sku_products: Number(row && row.sku_products) || 0,
        sku_bundles: Number(row && row.sku_bundles) || 0,
    };
}

/**
 * Коды складских позиций из текущего ms_export (для пересечения с report/stock/all на момент).
 * Атрибут «складская» в истории МС недоступен — берём актуальные карточки.
 */
async function loadWarehouseStockCodes(db) {
    const [rows] = await db.query(
        `
        SELECT TRIM(code) AS code
          FROM ms_export
         WHERE type IN ('Товар', 'Комплект')
           AND TRIM(COALESCE(code, '')) <> ''
           AND ${STOCK_POSITION_YES_SQL}
    `
    );
    const codes = new Set();
    (rows || []).forEach((r) => {
        const c = String((r && r.code) || '').trim().toLowerCase();
        if (c) codes.add(c);
    });
    return codes;
}

function parseCustomerCodesSetting(raw) {
    const s = String(raw || '').trim();
    if (!s) return [];
    try {
        const parsed = JSON.parse(s);
        if (Array.isArray(parsed)) {
            return parsed.map((x) => String(x || '').trim()).filter(Boolean);
        }
    } catch (e) {
        /* fall through: CSV */
    }
    return s
        .split(/[,;\s]+/)
        .map((x) => String(x || '').trim())
        .filter(Boolean);
}

/**
 * Явный список в app_settings перекрывает авто-резолв по алиасам «Альмамед».
 */
async function resolveAlmaMedCustomerCodes(db, appSettings) {
    const raw =
        (appSettings && appSettings[CUSTOMER_CODES_KEY]) ||
        (await finCred.getSetting(db, CUSTOMER_CODES_KEY).catch(() => '')) ||
        '';
    const explicit = parseCustomerCodesSetting(raw);
    if (explicit.length) return explicit;

    const aliases = await finCred.loadOrgAliases(db, appSettings);
    const codes = [];
    Object.keys(aliases || {}).forEach((code) => {
        const entry = aliases[code];
        const full =
            entry && typeof entry === 'object'
                ? String(entry.full || '') + ' ' + String(entry.short || '')
                : String(entry || '');
        if (ALMA_NAME_RE.test(full) || ALMA_NAME_RE.test(String(code))) {
            codes.push(String(code).trim());
        }
    });
    return codes.filter(Boolean);
}

async function upsertMonthSnapshot(db, opts) {
    await ensureMsInventorySchema(db);
    const ym = String((opts && opts.ym) || '').trim();
    if (!/^\d{4}-\d{2}$/.test(ym)) {
        throw new Error('ym must be YYYY-MM');
    }
    const value_products = Math.round((Number(opts.value_products) || 0) * 100) / 100;
    const value_bundles =
        opts.value_bundles == null ? null : Math.round((Number(opts.value_bundles) || 0) * 100) / 100;
    const source = String((opts && opts.source) || 'auto').slice(0, 16) || 'auto';
    const asOf = opts.as_of_at instanceof Date ? opts.as_of_at : new Date();
    const meta = opts.meta && typeof opts.meta === 'object' ? opts.meta : {};
    await db.query(
        `INSERT INTO dg_finance_ms_inventory_month
            (ym, value_products, value_bundles, as_of_at, source, meta_json, synced_at)
         VALUES (?, ?, ?, ?, ?, CAST(? AS JSON), UTC_TIMESTAMP())
         ON DUPLICATE KEY UPDATE
            value_products = VALUES(value_products),
            value_bundles = VALUES(value_bundles),
            as_of_at = VALUES(as_of_at),
            source = VALUES(source),
            meta_json = VALUES(meta_json),
            synced_at = UTC_TIMESTAMP()`,
        [ym, value_products, value_bundles, asOf, source, JSON.stringify(meta)]
    );
    return { ym, value_products, value_bundles, source, as_of_at: asOf };
}

async function getSnapshotByYm(db, ym) {
    await ensureMsInventorySchema(db);
    const key = String(ym || '').trim();
    if (!/^\d{4}-\d{2}$/.test(key)) return null;
    const [rows] = await db.query(
        `SELECT ym, value_products, value_bundles, as_of_at, source, meta_json, synced_at
           FROM dg_finance_ms_inventory_month WHERE ym = ? LIMIT 1`,
        [key]
    );
    return rows && rows[0] ? rows[0] : null;
}

async function loadSnapshotsByYm(db, monthKeys) {
    await ensureMsInventorySchema(db);
    const keys = (Array.isArray(monthKeys) ? monthKeys : [])
        .map((x) => String(x || '').trim())
        .filter((ym) => /^\d{4}-\d{2}$/.test(ym));
    const map = Object.create(null);
    if (!keys.length) return map;
    const ph = keys.map(() => '?').join(',');
    const [rows] = await db.query(
        `SELECT ym, value_products, value_bundles, as_of_at, source, synced_at
           FROM dg_finance_ms_inventory_month WHERE ym IN (${ph})`,
        keys
    );
    (rows || []).forEach((r) => {
        const ym = String(r.ym || '');
        if (!ym) return;
        // Mid-month manual/auto не считаем итогом месяца (график / KPI).
        if (!snapshotIsOfficialEom(r, ym)) return;
        map[ym] = {
            ym,
            value_products: Math.round((Number(r.value_products) || 0) * 100) / 100,
            value_bundles:
                r.value_bundles == null
                    ? null
                    : Math.round((Number(r.value_bundles) || 0) * 100) / 100,
            as_of_at: r.as_of_at,
            source: r.source,
            synced_at: r.synced_at,
        };
    });
    return map;
}

/**
 * Для UI: официальный EOM-снимок текущего месяца, иначе provisional из live ms_export.
 * Строка ym с as_of mid-month (ручной запуск) не блокирует live.
 */
async function loadMsInventoryForFinance(db, appSettings) {
    await ensureMsInventorySchema(db);
    const customer_codes = await resolveAlmaMedCustomerCodes(db, appSettings);
    const ym = currentYmMsk();
    const snap = await getSnapshotByYm(db, ym);
    const sync_script = getFinanceMsInventorySyncMeta();
    if (snap && snapshotIsOfficialEom(snap, ym)) {
        return {
            ym,
            value_products: Math.round((Number(snap.value_products) || 0) * 100) / 100,
            value_bundles:
                snap.value_bundles == null
                    ? null
                    : Math.round((Number(snap.value_bundles) || 0) * 100) / 100,
            as_of_at: snap.as_of_at,
            provisional: false,
            source: snap.source || 'auto',
            customer_codes,
            sync_script,
        };
    }
    let live;
    try {
        live = await computeInventoryValueFromMsExport(db);
    } catch (e) {
        live = { value_products: 0, value_bundles: 0, sku_products: 0, sku_bundles: 0 };
    }
    return {
        ym,
        value_products: live.value_products,
        value_bundles: live.value_bundles,
        as_of_at: null,
        provisional: true,
        source: 'live',
        customer_codes,
        sku_products: live.sku_products,
        sku_bundles: live.sku_bundles,
        sync_script,
    };
}

/**
 * @param {{ force?: boolean, source?: string }} opts
 * force=true — снять даже не в последний день месяца (ручной запуск).
 */
async function runMsInventoryMonthSnapshot(db, appSettings, opts) {
    const o = opts && typeof opts === 'object' ? opts : {};
    const force = !!o.force;
    const source = String(o.source || (force ? 'manual' : 'auto')).slice(0, 16);
    const now = new Date();
    if (!force && !isLastCalendarDayOfMonthMsk(now)) {
        const p = moscowYmdParts(now);
        return {
            skipped: true,
            status: 'skipped',
            message: `Не последний день месяца МСК (${p.ymd}) — снимок только в EOM ~23:55`,
        };
    }
    const computed = await computeInventoryValueFromMsExport(db);
    const ym = currentYmMsk(now);
    const sync_script = getFinanceMsInventorySyncMeta();
    const saved = await upsertMonthSnapshot(db, {
        ym,
        value_products: computed.value_products,
        value_bundles: computed.value_bundles,
        as_of_at: now,
        source,
        meta: {
            sku_products: computed.sku_products,
            sku_bundles: computed.sku_bundles,
            formula:
                'ms_export stock×COALESCE(stock_cost,buy_price) Товар; складская Да; без плакатов',
            customer_codes: await resolveAlmaMedCustomerCodes(db, appSettings),
            sync_script,
        },
    });
    return {
        skipped: false,
        status: 'completed',
        message: `Снимок ${ym}: товар ${computed.value_products.toFixed(2)} ₽ (${computed.sku_products} SKU)`,
        snapshot: saved,
        computed,
        sync_script,
    };
}

function resolveMsToken(config) {
    try {
        const cfg = config || require('../config');
        return String(process.env.MS_TOKEN || (cfg && cfg.msToken) || '').trim();
    } catch (e) {
        return String(process.env.MS_TOKEN || '').trim();
    }
}

function monthEndYmd(ym) {
    const s = String(ym || '');
    const y = parseInt(s.slice(0, 4), 10);
    const m = parseInt(s.slice(5, 7), 10);
    if (!y || !m) return '';
    const last = new Date(y, m, 0).getDate();
    return `${y}-${String(m).padStart(2, '0')}-${String(last).padStart(2, '0')}`;
}

function listYmInclusive(fromYm, toYm) {
    const out = [];
    let y = parseInt(String(fromYm).slice(0, 4), 10);
    let m = parseInt(String(fromYm).slice(5, 7), 10);
    const ey = parseInt(String(toYm).slice(0, 4), 10);
    const em = parseInt(String(toYm).slice(5, 7), 10);
    if (!y || !m || !ey || !em) return out;
    while (y < ey || (y === ey && m <= em)) {
        out.push(`${y}-${String(m).padStart(2, '0')}`);
        m += 1;
        if (m > 12) {
            m = 1;
            y += 1;
        }
    }
    return out;
}

function assortmentKindFromStockRow(row) {
    const href = String(
        (row && row.meta && row.meta.href) ||
            (row && row.assortment && row.assortment.meta && row.assortment.meta.href) ||
            ''
    ).toLowerCase();
    if (href.includes('/bundle')) return 'bundle';
    if (href.includes('/product') || href.includes('/variant') || href.includes('/consignment')) {
        return 'product';
    }
    const t = String((row && row.meta && row.meta.type) || '').toLowerCase();
    if (t.includes('bundle')) return 'bundle';
    if (t.includes('product') || t.includes('variant') || t.includes('consignment')) return 'product';
    return '';
}

async function fetchMsStockRowsAtMoment(momentMsk, opts) {
    const o = opts && typeof opts === 'object' ? opts : {};
    const token = resolveMsToken(o.config);
    if (!token) throw new Error('MS_TOKEN не задан (env MS_TOKEN или config.msToken)');
    const headers = {
        Authorization: `Bearer ${token}`,
        'Accept-Encoding': 'gzip',
    };
    const delayMs = Math.max(50, Number(o.delayMs) || 200);
    const pageLimit = Math.max(100, Math.min(Number(o.pageLimit) || 1000, 1000));
    const filter = `moment=${String(momentMsk).trim()}`;
    const out = [];
    let offset = 0;
    while (true) {
        const resp = await axios.get(`${MS_BASE}/report/stock/all`, {
            headers,
            params: {
                filter,
                groupBy: 'variant',
                stockMode: 'positiveOnly',
                quantityMode: 'positiveOnly',
                limit: pageLimit,
                offset,
            },
            timeout: 120000,
        });
        const rows = (resp.data && resp.data.rows) || [];
        if (!rows.length) break;
        out.push(...rows);
        offset += pageLimit;
        if (rows.length < pageLimit) break;
        if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
    }
    return out;
}

/**
 * Σ для «Товар» / «Комплект» по строкам report/stock/all на момент.
 * @param {Iterable|Set|null} warehouseCodes — нижний регистр кодов со складской «Да»;
 *   если Set пустой/null — без отсечения по складу (только для тестов).
 */
function sumInventoryFromStockRows(rows, warehouseCodes) {
    const allow =
        warehouseCodes instanceof Set
            ? warehouseCodes
            : warehouseCodes
              ? new Set(
                    [...warehouseCodes]
                        .map((c) => String(c || '').trim().toLowerCase())
                        .filter(Boolean)
                )
              : null;
    let value_products = 0;
    let value_bundles = 0;
    let sku_products = 0;
    let sku_bundles = 0;
    let skipped_not_warehouse = 0;
    (rows || []).forEach((row) => {
        const name = String((row && row.name) || '');
        if (name.toLowerCase().includes('плакат')) return;
        const kind = assortmentKindFromStockRow(row);
        if (!kind) return;
        const code = String((row && row.code) || '').trim().toLowerCase();
        if (allow && allow.size > 0) {
            if (!code || !allow.has(code)) {
                skipped_not_warehouse += 1;
                return;
            }
        }
        const stock = Number(row.stock);
        const qty = row.quantity != null ? Number(row.quantity) : stock;
        if (!Number.isFinite(stock) || stock <= 0) return;
        let unit = 0;
        if (row.price != null && row.price !== '') {
            const p = Number(row.price) / 100;
            if (Number.isFinite(p)) unit = p;
        }
        const line = stock * unit;
        if (kind === 'bundle') {
            value_bundles += line;
            sku_bundles += 1;
            return;
        }
        if (!Number.isFinite(qty) || qty <= 0) return;
        value_products += line;
        sku_products += 1;
    });
    return {
        value_products: Math.round(value_products * 100) / 100,
        value_bundles: Math.round(value_bundles * 100) / 100,
        sku_products,
        sku_bundles,
        skipped_not_warehouse,
    };
}

/**
 * @param {string} momentMsk
 * @param {{ config?: object, delayMs?: number, pageLimit?: number, warehouseCodes?: Set|string[], db?: object }} opts
 */
async function computeInventoryValueAtMoment(momentMsk, opts) {
    const o = opts && typeof opts === 'object' ? opts : {};
    let warehouseCodes = o.warehouseCodes;
    if (!warehouseCodes && o.db) {
        warehouseCodes = await loadWarehouseStockCodes(o.db);
    }
    const rows = await fetchMsStockRowsAtMoment(momentMsk, o);
    const summed = sumInventoryFromStockRows(rows, warehouseCodes);
    return {
        ...summed,
        rows_total: rows.length,
        moment: String(momentMsk),
        warehouse_codes: warehouseCodes instanceof Set ? warehouseCodes.size : null,
    };
}

/**
 * Бэкфилл снимков за диапазон месяцев: остатки МС на 23:59:59 последнего дня месяца (МСК).
 * @param {{ fromYm?: string, toYm?: string, force?: boolean, onProgress?: Function, config?: object }} opts
 */
async function backfillMsInventoryMonths(db, appSettings, opts) {
    const o = opts && typeof opts === 'object' ? opts : {};
    const fromYm = String(o.fromYm || '2025-01').trim();
    const toYm = String(o.toYm || '2026-09').trim();
    if (!/^\d{4}-\d{2}$/.test(fromYm) || !/^\d{4}-\d{2}$/.test(toYm)) {
        throw new Error('fromYm/toYm must be YYYY-MM');
    }
    const force = !!o.force;
    const months = listYmInclusive(fromYm, toYm);
    const results = [];
    await ensureMsInventorySchema(db);
    const codes = await resolveAlmaMedCustomerCodes(db, appSettings);
    const warehouseCodes = await loadWarehouseStockCodes(db);
    const sync_script = getFinanceMsInventorySyncMeta();
    for (let i = 0; i < months.length; i++) {
        const ym = months[i];
        const existing = await getSnapshotByYm(db, ym);
        if (existing && !force) {
            const skip = {
                ym,
                skipped: true,
                reason: 'exists',
                value_products: Number(existing.value_products) || 0,
            };
            results.push(skip);
            if (typeof o.onProgress === 'function') o.onProgress(skip, i + 1, months.length);
            continue;
        }
        const endYmd = monthEndYmd(ym);
        const moment = `${endYmd} 23:59:59`;
        const computed = await computeInventoryValueAtMoment(moment, {
            config: o.config,
            delayMs: o.delayMs,
            pageLimit: o.pageLimit,
            warehouseCodes,
        });
        // as_of = 23:59:59 МСК последнего дня месяца.
        const asOfLocal = new Date(
            Date.parse(endYmd + 'T23:59:59+03:00') || Date.parse(endYmd + 'T20:59:59Z')
        );
        const saved = await upsertMonthSnapshot(db, {
            ym,
            value_products: computed.value_products,
            value_bundles: computed.value_bundles,
            as_of_at: asOfLocal,
            source: 'backfill',
            meta: {
                moment,
                sku_products: computed.sku_products,
                sku_bundles: computed.sku_bundles,
                rows_total: computed.rows_total,
                skipped_not_warehouse: computed.skipped_not_warehouse,
                warehouse_codes: warehouseCodes.size,
                formula:
                    'report/stock/all moment; stock×price/100; Товар; складская Да (ms_export); без плакатов',
                customer_codes: codes,
                sync_script,
            },
        });
        const done = {
            ym,
            skipped: false,
            value_products: saved.value_products,
            value_bundles: saved.value_bundles,
            moment,
            sku_products: computed.sku_products,
            skipped_not_warehouse: computed.skipped_not_warehouse,
        };
        results.push(done);
        if (typeof o.onProgress === 'function') o.onProgress(done, i + 1, months.length);
    }
    const written = results.filter((r) => !r.skipped).length;
    const skipped = results.filter((r) => r.skipped).length;
    return {
        success: true,
        from_ym: fromYm,
        to_ym: toYm,
        written,
        skipped,
        warehouse_codes: warehouseCodes.size,
        sync_script,
        results,
        message: `Бэкфилл ${fromYm}…${toYm}: записано ${written}, пропущено ${skipped}`,
    };
}

module.exports = {
    CUSTOMER_CODES_KEY,
    STOCK_POSITION_YES_SQL,
    ensureMsInventorySchema,
    computeInventoryValueFromMsExport,
    computeInventoryValueAtMoment,
    backfillMsInventoryMonths,
    resolveAlmaMedCustomerCodes,
    loadWarehouseStockCodes,
    upsertMonthSnapshot,
    getSnapshotByYm,
    loadSnapshotsByYm,
    loadMsInventoryForFinance,
    snapshotIsOfficialEom,
    runMsInventoryMonthSnapshot,
    isLastCalendarDayOfMonthMsk,
    currentYmMsk,
    moscowYmdParts,
    monthEndYmd,
    listYmInclusive,
    sumInventoryFromStockRows,
    getFinanceMsInventorySyncMeta,
};
