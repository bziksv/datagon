'use strict';

/**
 * Товарный остаток МойСклад в финансах (Альмамед):
 * оценка Σ(остаток × себестоимость) только «Товар» — как карточка на /moysklad.html;
 * официальный снимок на конец месяца → dg_finance_ms_inventory_month.
 */

const finCred = require('./datagonFinanceCredentials');

const CUSTOMER_CODES_KEY = 'finance_ms_inventory_customer_codes';
const ALMA_NAME_RE = /альмамед/i;

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

/** Формула как GET /api/ms/stats (дефолт без плакатов). */
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
             AND COALESCE(stock, 0) > 0
             AND COALESCE(stock_quantity, stock, 0) > 0
        THEN stock * (${unitCostExpr})
        ELSE 0
    END`;
    const bundleValExpr = `CASE
        WHEN type = 'Комплект'
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
                      AND COALESCE(stock, 0) > 0
                      AND COALESCE(stock_quantity, stock, 0) > 0
                     THEN 1 ELSE 0 END) AS sku_products,
            SUM(CASE WHEN type = 'Комплект' AND COALESCE(stock, 0) > 0 THEN 1 ELSE 0 END) AS sku_bundles
          FROM ms_export
         WHERE type IN ('Товар', 'Комплект')
           AND LOWER(IFNULL(name, '')) NOT LIKE '%плакат%'
    `
    );
    return {
        value_products: Math.round((Number(row && row.value_products) || 0) * 100) / 100,
        value_bundles: Math.round((Number(row && row.value_bundles) || 0) * 100) / 100,
        sku_products: Number(row && row.sku_products) || 0,
        sku_bundles: Number(row && row.sku_bundles) || 0,
    };
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
 * Для UI: снимок текущего месяца, иначе provisional из live ms_export.
 */
async function loadMsInventoryForFinance(db, appSettings) {
    await ensureMsInventorySchema(db);
    const customer_codes = await resolveAlmaMedCustomerCodes(db, appSettings);
    const ym = currentYmMsk();
    const snap = await getSnapshotByYm(db, ym);
    if (snap) {
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
    const saved = await upsertMonthSnapshot(db, {
        ym,
        value_products: computed.value_products,
        value_bundles: computed.value_bundles,
        as_of_at: now,
        source,
        meta: {
            sku_products: computed.sku_products,
            sku_bundles: computed.sku_bundles,
            formula: 'ms_export stock×COALESCE(stock_cost,buy_price) Товар; без плакатов',
            customer_codes: await resolveAlmaMedCustomerCodes(db, appSettings),
        },
    });
    return {
        skipped: false,
        status: 'completed',
        message: `Снимок ${ym}: товар ${computed.value_products.toFixed(2)} ₽ (${computed.sku_products} SKU)`,
        snapshot: saved,
        computed,
    };
}

module.exports = {
    CUSTOMER_CODES_KEY,
    ensureMsInventorySchema,
    computeInventoryValueFromMsExport,
    resolveAlmaMedCustomerCodes,
    upsertMonthSnapshot,
    getSnapshotByYm,
    loadSnapshotsByYm,
    loadMsInventoryForFinance,
    runMsInventoryMonthSnapshot,
    isLastCalendarDayOfMonthMsk,
    currentYmMsk,
    moscowYmdParts,
};
