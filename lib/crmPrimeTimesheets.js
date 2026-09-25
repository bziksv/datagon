'use strict';

/**
 * Read-only доступ к таймерам CRM Prime Ltd (RISE: rise_project_time).
 * Конфиг через env (не в config.js с секретами репозитория):
 *   CRM_PRIME_DB_HOST, CRM_PRIME_DB_USER, CRM_PRIME_DB_PASSWORD,
 *   CRM_PRIME_DB_NAME (default crm_prime_lt), CRM_PRIME_DB_PREFIX (default rise_)
 */

const mysql = require('mysql2/promise');

let pool = null;
let poolFailed = null;

function crmDbConfig() {
    let fromFile = null;
    try {
        const config = require('../config');
        if (config && config.crmPrime && config.crmPrime.host && config.crmPrime.user) {
            fromFile = config.crmPrime;
        }
    } catch (_) {}

    const host = String(process.env.CRM_PRIME_DB_HOST || (fromFile && fromFile.host) || '').trim();
    const user = String(process.env.CRM_PRIME_DB_USER || (fromFile && fromFile.user) || '').trim();
    const password =
        process.env.CRM_PRIME_DB_PASSWORD != null
            ? String(process.env.CRM_PRIME_DB_PASSWORD)
            : fromFile && fromFile.password != null
              ? String(fromFile.password)
              : '';
    const database =
        String(process.env.CRM_PRIME_DB_NAME || (fromFile && fromFile.database) || 'crm_prime_lt').trim() ||
        'crm_prime_lt';
    if (!host || !user) return null;
    return {
        host,
        user,
        password,
        database,
        prefix: String(
            process.env.CRM_PRIME_DB_PREFIX || (fromFile && fromFile.prefix) || 'rise_'
        ).trim() || 'rise_',
        port: Number(process.env.CRM_PRIME_DB_PORT || (fromFile && fromFile.port) || 3306) || 3306,
    };
}

function isCrmConfigured() {
    return !!crmDbConfig();
}

async function getCrmPool() {
    const cfg = crmDbConfig();
    if (!cfg) return null;
    if (poolFailed && Date.now() - poolFailed.at < 60_000) {
        throw poolFailed.err;
    }
    if (pool) return pool;
    try {
        pool = mysql.createPool({
            host: cfg.host,
            port: cfg.port,
            user: cfg.user,
            password: cfg.password,
            database: cfg.database,
            waitForConnections: true,
            connectionLimit: 3,
            connectTimeout: 8000,
            timezone: 'Z',
        });
        // ping
        const conn = await pool.getConnection();
        conn.release();
        poolFailed = null;
        return pool;
    } catch (e) {
        pool = null;
        poolFailed = { at: Date.now(), err: e };
        throw e;
    }
}

/**
 * Часы по task_id за период [fromYmd, toYmd] inclusive (по start_time UTC/как в CRM).
 * @returns {Promise<{ configured: boolean, hoursByTaskId: Map<number,number>, error?: string }>}
 */
async function sumHoursByTaskIds(taskIds, fromYmd, toYmd) {
    const hoursByTaskId = new Map();
    const ids = [...new Set((taskIds || []).map((x) => Number(x)).filter((n) => Number.isFinite(n) && n > 0))];
    if (!ids.length) {
        return { configured: isCrmConfigured(), hoursByTaskId };
    }
    if (!isCrmConfigured()) {
        return { configured: false, hoursByTaskId };
    }
    const cfg = crmDbConfig();
    const table = `\`${cfg.prefix}project_time\``;
    const fromTs = `${fromYmd} 00:00:00`;
    const [y, m, d] = String(toYmd).split('-').map(Number);
    const next = new Date(Date.UTC(y, m - 1, d + 1));
    const toExclusive = `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, '0')}-${String(next.getUTCDate()).padStart(2, '0')} 00:00:00`;

    try {
        const p = await getCrmPool();
        const placeholders = ids.map(() => '?').join(',');
        const [rows] = await p.query(
            `SELECT task_id,
                    SUM(
                      CASE
                        WHEN end_time IS NOT NULL AND end_time > start_time
                          THEN TIMESTAMPDIFF(SECOND, start_time, end_time)
                        ELSE 0
                      END
                      + ROUND(COALESCE(hours, 0) * 3600)
                    ) AS total_sec
               FROM ${table}
              WHERE deleted = 0
                AND task_id IN (${placeholders})
                AND status IN ('logged', 'approved')
                AND start_time >= ?
                AND start_time < ?
              GROUP BY task_id`,
            [...ids, fromTs, toExclusive]
        );
        for (const r of rows || []) {
            const tid = Number(r.task_id);
            const sec = Number(r.total_sec) || 0;
            hoursByTaskId.set(tid, Math.round((sec / 3600) * 100) / 100);
        }

        // Открытые таймеры: от start_time до NOW (если старт в периоде)
        const [openRows] = await p.query(
            `SELECT task_id,
                    SUM(TIMESTAMPDIFF(SECOND, start_time, UTC_TIMESTAMP())) AS total_sec
               FROM ${table}
              WHERE deleted = 0
                AND task_id IN (${placeholders})
                AND status = 'open'
                AND end_time IS NULL
                AND start_time >= ?
                AND start_time < ?
              GROUP BY task_id`,
            [...ids, fromTs, toExclusive]
        );
        for (const r of openRows || []) {
            const tid = Number(r.task_id);
            const sec = Math.max(0, Number(r.total_sec) || 0);
            const add = Math.round((sec / 3600) * 100) / 100;
            hoursByTaskId.set(tid, Math.round(((hoursByTaskId.get(tid) || 0) + add) * 100) / 100);
        }

        return { configured: true, hoursByTaskId };
    } catch (e) {
        return {
            configured: true,
            hoursByTaskId,
            error: e.message || String(e),
        };
    }
}

async function fetchTaskTitles(taskIds) {
    const ids = [...new Set((taskIds || []).map((x) => Number(x)).filter((n) => Number.isFinite(n) && n > 0))];
    const titles = new Map();
    if (!ids.length || !isCrmConfigured()) return { configured: isCrmConfigured(), titles };
    const cfg = crmDbConfig();
    const table = `\`${cfg.prefix}tasks\``;
    try {
        const p = await getCrmPool();
        const placeholders = ids.map(() => '?').join(',');
        const [rows] = await p.query(
            `SELECT id, title FROM ${table} WHERE deleted = 0 AND id IN (${placeholders})`,
            ids
        );
        for (const r of rows || []) {
            titles.set(Number(r.id), String(r.title || '').trim());
        }
        return { configured: true, titles };
    } catch (e) {
        return { configured: true, titles, error: e.message || String(e) };
    }
}

module.exports = {
    isCrmConfigured,
    sumHoursByTaskIds,
    fetchTaskTitles,
};
