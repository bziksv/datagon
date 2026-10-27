'use strict';

let activityTableReady = false;

/** Сколько дней хранить события в MySQL (старые удаляются порциями при запросах к журналу). */
const ACTIVITY_RETENTION_DAYS = 120;

let lastActivityPruneAt = 0;

/** Ключ раздела: как `data-dg-active-nav` или basename страницы без `.html`. */
function normalizeActivitySectionKey(raw) {
    let s = String(raw ?? '')
        .trim()
        .toLowerCase();
    if (!s) return 'app';
    s = s.replace(/^\/+|\/+$/g, '').replace(/\.html$/i, '');
    const slash = s.lastIndexOf('/');
    if (slash >= 0) s = s.slice(slash + 1);
    return s.slice(0, 64) || 'app';
}

async function maybePruneActivityEvents(db) {
    const now = Date.now();
    if (now - lastActivityPruneAt < 6 * 60 * 60 * 1000) return;
    lastActivityPruneAt = now;
    try {
        await ensureActivityTable(db);
        await db.query('DELETE FROM dg_activity_events WHERE created_at < DATE_SUB(NOW(), INTERVAL ? DAY) LIMIT 8000', [
            ACTIVITY_RETENTION_DAYS,
        ]);
    } catch (e) {
        console.warn('[activity] prune:', e && e.message ? e.message : e);
    }
}

async function ensureActivityTable(db) {
    if (activityTableReady) return;
    await db.query(`
        CREATE TABLE IF NOT EXISTS dg_activity_events (
            id BIGINT AUTO_INCREMENT PRIMARY KEY,
            user_id INT NOT NULL,
            kind VARCHAR(32) NOT NULL,
            section VARCHAR(64) NULL,
            label VARCHAR(512) NOT NULL,
            detail TEXT NULL,
            created_at TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP(3),
            INDEX idx_dg_act_user_time (user_id, created_at),
            INDEX idx_dg_act_time (created_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    try {
        await db.query(
            'ALTER TABLE dg_activity_events MODIFY kind VARCHAR(32) NOT NULL, MODIFY label VARCHAR(512) NOT NULL'
        );
    } catch (e) {
        console.warn('[activity] ensureActivityTable alter:', e && e.message ? e.message : e);
    }
    activityTableReady = true;
}

/** F-DBA-05: урезать клиентский detail (XSS/spam/секреты в тексте). */
const ACTIVITY_CLIENT_DETAIL_MAX = 2000;
const ACTIVITY_SECRETISH_RE =
    /(password|passwd|secret|token|api[_-]?key|authorization|bearer\s+[a-z0-9._\-]+)/gi;

function sanitizeActivityClientDetail(raw, maxLen) {
    const lim = Math.max(64, Number(maxLen) || ACTIVITY_CLIENT_DETAIL_MAX);
    let s = String(raw == null ? '' : raw);
    if (!s) return null;
    s = s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ');
    s = s.replace(/<\/?script\b[^>]*>/gi, '');
    s = s.replace(ACTIVITY_SECRETISH_RE, '[redacted]');
    if (s.length > lim) s = s.slice(0, lim);
    return s || null;
}

/**
 * @param {import('mysql2/promise').Pool} db
 * @param {{ userId: number, kind: string, section?: string|null, label: string, detail?: string|null }} row
 */
async function recordDatagonActivity(db, row) {
    if (!db || !row || !row.userId) return;
    const k = String(row.kind || 'event').slice(0, 32);
    const sec =
        row.section == null || String(row.section).trim() === ''
            ? null
            : normalizeActivitySectionKey(row.section);
    const lab = String(row.label || '').slice(0, 512);
    const det = row.detail != null ? String(row.detail).slice(0, 8000) : null;
    try {
        await ensureActivityTable(db);
        await db.query(
            'INSERT INTO dg_activity_events (user_id, kind, section, label, detail) VALUES (?,?,?,?,?)',
            [row.userId, k, sec, lab, det]
        );
    } catch (e) {
        console.warn(
            '[activity] recordDatagonActivity:',
            e && e.message ? e.message : e,
            'kind=',
            k,
            'userId=',
            row.userId
        );
    }
}

module.exports = {
    ensureActivityTable,
    recordDatagonActivity,
    normalizeActivitySectionKey,
    maybePruneActivityEvents,
    sanitizeActivityClientDetail,
    ACTIVITY_RETENTION_DAYS,
    ACTIVITY_CLIENT_DETAIL_MAX,
};
