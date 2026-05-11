'use strict';
/** Smoke-test для /api/processes/overview: создаёт временную сессию admin и парсит ответ. */
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
        const tokenHash = sha256(token);
        const [ins] = await pool.query(
            "INSERT INTO auth_sessions (user_id, token_hash, revoked, expires_at, last_seen_at) VALUES (?, ?, 0, DATE_ADD(NOW(), INTERVAL 1 HOUR), NOW())",
            [adminId, tokenHash]
        );
        sessionId = ins.insertId;
        const r1 = await get('http://127.0.0.1:3000/api/processes/overview', { 'x-auth-token': token });
        console.log('== default (today) ==');
        console.log('HTTP', r1.status);
        try {
            const j = JSON.parse(r1.body);
            console.log('forDate:', j.forDate);
            console.log('moscowToday:', j.moscowToday);
            console.log('isToday:', j.isToday);
            console.log('forDateOptions:', (j.forDateOptions || []).length, 'items, first 4:', (j.forDateOptions || []).slice(0, 4));
            console.log('autoSyncRuns:', (j.autoSyncRuns || []).length, 'task_types:', Array.from(new Set((j.autoSyncRuns || []).map(r => r.task_type))));
            console.log('moyskladPersistedLogs:', (j.moyskladPersistedLogs || []).length);
            console.log('matches.message:', j.matches && j.matches.message);
        } catch (e) {
            console.log('BODY[0..400]:', r1.body.slice(0, 400));
        }
        const yesterday = new Date(Date.now() - 86400000).toLocaleDateString('en-CA', { timeZone: 'Europe/Moscow' });
        const r2 = await get('http://127.0.0.1:3000/api/processes/overview?for_date=' + yesterday, { 'x-auth-token': token });
        console.log('\n== for_date=' + yesterday + ' ==');
        console.log('HTTP', r2.status);
        try {
            const j2 = JSON.parse(r2.body);
            console.log('forDate:', j2.forDate);
            console.log('isToday:', j2.isToday);
            console.log('autoSyncRuns:', (j2.autoSyncRuns || []).length);
            console.log('moyskladPersistedLogs:', (j2.moyskladPersistedLogs || []).length);
            console.log('matches.message:', j2.matches && j2.matches.message);
            console.log('moysklad.logs.length (should be 0 for non-today):', (j2.moysklad && j2.moysklad.logs || []).length);
        } catch (e) {
            console.log('BODY[0..400]:', r2.body.slice(0, 400));
        }
        const r3 = await get('http://127.0.0.1:3000/api/processes/overview?for_date=2020-01-01', { 'x-auth-token': token });
        console.log('\n== for_date=2020-01-01 (out of window — должен скорректироваться на сегодня) ==');
        console.log('HTTP', r3.status);
        try {
            const j3 = JSON.parse(r3.body);
            console.log('forDate:', j3.forDate, '(=', j3.moscowToday, '?)');
        } catch (e) {
            console.log('BODY[0..400]:', r3.body.slice(0, 400));
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
