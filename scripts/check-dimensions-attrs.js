'use strict';
/** Smoke-test: убеждаемся, что /api/exports/dimensions/list возвращает 6 атрибутов из payload_json. */
const crypto = require('crypto');
const http = require('http');
const mysql = require('mysql2/promise');
const cfg = require('../config.js');

function sha256(s) {
    return crypto.createHash('sha256').update(String(s)).digest('hex');
}

async function get(url, headers) {
    return await new Promise((resolve, reject) => {
        const u = new URL(url);
        const req = http.request(
            {
                method: 'GET',
                host: u.hostname,
                port: u.port,
                path: u.pathname + u.search,
                headers,
            },
            (res) => {
                let buf = '';
                res.on('data', (c) => (buf += c));
                res.on('end', () => resolve({ status: res.statusCode, body: buf }));
            }
        );
        req.on('error', reject);
        req.end();
    });
}

(async () => {
    const pool = await mysql.createPool({
        host: cfg.db.host,
        user: cfg.db.user,
        password: cfg.db.password,
        database: cfg.db.database,
        waitForConnections: true,
        connectionLimit: 2,
    });
    let sessionId = null;
    try {
        const [adminRows] = await pool.query("SELECT id FROM users WHERE username = 'admin' LIMIT 1");
        if (!adminRows.length) throw new Error('admin user not found');
        const adminId = adminRows[0].id;
        const token = 'qa-smoke-' + crypto.randomBytes(12).toString('hex');
        await pool.query(
            'INSERT INTO auth_sessions (user_id, token_hash, revoked, expires_at, last_seen_at) VALUES (?, ?, 0, DATE_ADD(NOW(), INTERVAL 1 HOUR), NOW())',
            [adminId, sha256(token)]
        );
        const [sRow] = await pool.query('SELECT LAST_INSERT_ID() AS id');
        sessionId = sRow[0].id;

        const r = await get('http://127.0.0.1:3000/api/exports/dimensions/list?limit=5', {
            'x-auth-token': token,
        });
        console.log('HTTP', r.status);
        const j = JSON.parse(r.body);
        console.log('success:', j.success, '| total:', j.total, '| rows:', (j.rows || []).length);
        console.log('dimension_attrs[]:');
        (j.dimension_attrs || []).forEach((d) => console.log('  -', d.key, '<-', d.attr));
        console.log('\n=== Первые 3 строки c dimensions_ms ===');
        (j.rows || []).slice(0, 3).forEach((row, i) => {
            console.log(`\n[${i + 1}] ${row.code}  ${(row.name || '').slice(0, 80)}`);
            console.log('    measured_by_name:', row.measured_by_name || '—', '| measured_at:', row.measured_at || '—');
            const d = row.dimensions_ms || {};
            console.log('    packing_type:', JSON.stringify(d.packing_type));
            console.log('    length_cm   :', JSON.stringify(d.length_cm));
            console.log('    width_cm    :', JSON.stringify(d.width_cm));
            console.log('    height_box  :', JSON.stringify(d.height_box_cm));
            console.log('    height_bag  :', JSON.stringify(d.height_bag_cm));
            console.log('    weight_kg   :', JSON.stringify(d.weight_kg));
        });

        const filled = (j.rows || []).filter((row) => {
            const d = row.dimensions_ms || {};
            return Object.keys(d).some((k) => d[k] && String(d[k]).trim());
        });
        console.log('\nЗаполненные атрибутами строки в первой странице:', filled.length, 'из', (j.rows || []).length);

        const rLarge = await get('http://127.0.0.1:3000/api/exports/dimensions/list?limit=200', {
            'x-auth-token': token,
        });
        const j2 = JSON.parse(rLarge.body);
        const filled2 = (j2.rows || []).filter((row) => {
            const d = row.dimensions_ms || {};
            return Object.keys(d).some((k) => d[k] && String(d[k]).trim());
        });
        console.log('Заполненные атрибутами строки в выборке 200:', filled2.length, 'из', (j2.rows || []).length);
        if (filled2[0]) {
            console.log('Пример заполненной строки:', filled2[0].code, '→', filled2[0].dimensions_ms);
        }
    } finally {
        if (sessionId) {
            try { await pool.query('DELETE FROM auth_sessions WHERE id = ?', [sessionId]); } catch (_) {}
        }
        await pool.end();
    }
})().catch((e) => {
    console.error('FAIL', e && (e.stack || e.message || String(e)));
    process.exit(1);
});
