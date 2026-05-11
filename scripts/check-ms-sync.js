'use strict';
const mysql = require('mysql2/promise');
const cfg = require('../config.js');

(async () => {
    const pool = await mysql.createPool({
        host: cfg.db.host,
        user: cfg.db.user,
        password: cfg.db.password,
        database: cfg.db.database,
        waitForConnections: true,
        connectionLimit: 2,
    });
    try {
        const [recent] = await pool.query(
            "SELECT id, created_at, line FROM dg_ms_sync_log ORDER BY id DESC LIMIT 50"
        );
        console.log('=== Последние 50 строк журнала синка МС (старые → новые) ===');
        for (const r of recent.reverse()) {
            const t = new Date(r.created_at).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' });
            console.log(`#${r.id}\t${t}\t${String(r.line).slice(0, 220)}`);
        }
        const [cnt] = await pool.query("SELECT COUNT(*) AS n FROM ms_entity_details");
        console.log(`\n=== ms_entity_details: ${cnt[0].n} строк ===`);
        const [ms] = await pool.query("SELECT COUNT(*) AS n FROM ms_export");
        console.log(`=== ms_export:           ${ms[0].n} строк ===`);
        const [last] = await pool.query(
            "SELECT MIN(fetched_at) AS oldest, MAX(fetched_at) AS newest FROM ms_entity_details"
        );
        if (last[0]) {
            const o = last[0].oldest ? new Date(last[0].oldest).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' }) : '—';
            const n = last[0].newest ? new Date(last[0].newest).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' }) : '—';
            console.log(`=== ms_entity_details.fetched_at: ${o} … ${n} ===`);
        }
        const [today] = await pool.query(
            "SELECT id, created_at, line FROM dg_ms_sync_log WHERE created_at >= NOW() - INTERVAL 12 HOUR ORDER BY id ASC LIMIT 500"
        );
        console.log(`\n=== Все строки журнала за последние 12ч (${today.length}) ===`);
        for (const r of today) {
            const t = new Date(r.created_at).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' });
            console.log(`${t}\t${String(r.line).slice(0, 220)}`);
        }
    } finally {
        await pool.end();
    }
})().catch((e) => {
    console.error(e && (e.stack || e.message || String(e)));
    process.exit(1);
});
