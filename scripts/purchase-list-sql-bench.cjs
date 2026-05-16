#!/usr/bin/env node
'use strict';

/**
 * Замер `purchaseListQueryPaged` (тот же путь, что `GET /api/purchase`) без HTTP.
 * Использует `config.js` → MySQL (как `server.js`).
 *
 * Запуск из корня репозитория:
 *   node scripts/purchase-list-sql-bench.cjs
 *   node scripts/purchase-list-sql-bench.cjs --sort=formula_proposed_min_stock
 *   node scripts/purchase-list-sql-bench.cjs --iter=5
 */

const mysql = require('mysql2/promise');
const config = require('../config');
const purchaseMod = require('../routes/purchase');

const DEFAULT_APP_SETTINGS = {
    sales_formula_replenishment_coef: 1 / 3,
    sales_formula_sales_window_days: 90,
    sales_formula_absence_analysis_days: 210,
    sales_formula_base_qty: 2,
    sales_formula_rare_base_qty: 2,
    sales_formula_rare_avg_max: 1,
    sales_formula_expensive_rare_threshold_rub: 50000,
    sales_formula_expensive_rare_min_qty: 1,
    sales_formula_max_change_coef: 1.6,
    sales_formula_incomplete_pack_pct: 80,
};

const DEFAULT_SORT_KEYS = [
    'code',
    'formula_proposed_min_stock',
    'd_365a',
    'supplier',
    'buy_price',
    'in_transit',
    'stock',
];

function parseArgs(argv) {
    const out = { sort: null, iter: 1, keys: null };
    for (const a of argv.slice(2)) {
        if (a.startsWith('--sort=')) out.sort = a.slice('--sort='.length).trim();
        else if (a.startsWith('--iter=')) out.iter = Math.max(1, Math.min(50, parseInt(a.slice('--iter='.length), 10) || 1));
        else if (a.startsWith('--keys=')) {
            out.keys = a
                .slice('--keys='.length)
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean);
        }
    }
    return out;
}

function makeReq(sort_by, iterIndex) {
    return {
        query: {
            limit: '100',
            offset: '0',
            sort_by,
            sort_dir: 'asc',
            _bench_iter: String(iterIndex),
        },
    };
}

async function loadFormulaSettingsFromDb(pool) {
    const appSettings = { ...DEFAULT_APP_SETTINGS };
    const [rows] = await pool.query(
        `SELECT setting_key, setting_value FROM app_settings WHERE setting_key LIKE 'sales_formula_%'`,
    );
    for (const r of rows || []) {
        const k = String(r.setting_key || '');
        if (!Object.prototype.hasOwnProperty.call(DEFAULT_APP_SETTINGS, k)) continue;
        const s = String(r.setting_value != null ? r.setting_value : '')
            .trim()
            .replace(',', '.');
        const n = Number(s);
        if (Number.isFinite(n)) appSettings[k] = n;
    }
    return appSettings;
}

async function main() {
    const args = parseArgs(process.argv);
    const sortKeys = args.keys || (args.sort ? [args.sort] : DEFAULT_SORT_KEYS);
    const iterations = args.sort ? Math.max(args.iter, 1) : args.iter;

    const pool = mysql.createPool({
        host: config.db.host,
        user: config.db.user,
        password: config.db.password,
        database: config.db.database,
        waitForConnections: true,
        connectionLimit: 2,
    });

    await purchaseMod.ensureSchema(pool);
    try {
        const msSales = require('../routes/msSales');
        if (typeof msSales.ensureSchema === 'function') await msSales.ensureSchema(pool);
    } catch (_) {
        /* optional */
    }

    const appSettings = await loadFormulaSettingsFromDb(pool);
    const pq = purchaseMod.purchaseListQueryPaged;
    if (typeof pq !== 'function') {
        console.error('routes/purchase.js: export purchaseListQueryPaged missing');
        process.exitCode = 1;
        await pool.end();
        return;
    }

    console.log('purchase-list-sql-bench — default filters, limit=100 offset=0, sort_dir=asc');
    console.log('DB:', config.db.host, '/', config.db.database);
    console.log('---');

    for (const sort_by of sortKeys) {
        let last;
        const times = [];
        for (let i = 0; i < iterations; i += 1) {
            const t0 = process.hrtime.bigint();
            try {
                last = await pq(pool, appSettings, makeReq(sort_by, i), { bench: true });
            } catch (e) {
                console.error(sort_by, 'ERROR', e && e.message ? e.message : e);
                last = null;
                break;
            }
            times.push(Number(process.hrtime.bigint() - t0) / 1e6);
        }
        if (!last) continue;
        const avg = times.reduce((a, b) => a + b, 0) / times.length;
        const mx = Math.max(...times);
        const mn = Math.min(...times);
        let benchPart = '';
        const b = last._bench;
        if (b && typeof b === 'object') {
            const parts = [];
            if (b.data_rev_ms != null) parts.push(`rev=${b.data_rev_ms.toFixed(0)}`);
            if (b.count_ms != null) parts.push(`cnt=${b.count_ms.toFixed(0)}`);
            if (b.list_sql_ms != null) parts.push(`sql=${b.list_sql_ms.toFixed(0)}`);
            if (b.enrich_ms != null) parts.push(`enr=${b.enrich_ms.toFixed(0)}`);
            if (parts.length) benchPart = '  [' + parts.join(' ') + ']';
        }
        console.log(
            `${sort_by.padEnd(28)} total=${String(last.total).padStart(6)} rows=${(last.data && last.data.length) || 0}  ` +
                `ms: avg=${avg.toFixed(0)} min=${mn.toFixed(0)} max=${mx.toFixed(0)} (n=${times.length})` +
                benchPart,
        );
    }

    await pool.end();
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
