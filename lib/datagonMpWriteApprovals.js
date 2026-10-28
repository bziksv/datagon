'use strict';

/**
 * F-MPK-02: dual-control на mass write в кабинеты МП (ozon-merge apply/unmerge).
 * Заявитель (shop=full) создаёт pending; подтверждает другой пользователь с settings=full (или admin).
 */

const crypto = require('crypto');

const PENDING_TTL_MS = 24 * 60 * 60 * 1000;
const KINDS = new Set(['ozon-merge-apply', 'ozon-merge-unmerge']);

let schemaReady = false;

async function ensureMpWriteApprovalsSchema(db) {
    if (schemaReady) return;
    await db.query(`
        CREATE TABLE IF NOT EXISTS dg_mp_write_approvals (
            id INT NOT NULL AUTO_INCREMENT,
            kind VARCHAR(64) NOT NULL,
            status VARCHAR(32) NOT NULL DEFAULT 'pending',
            requested_by INT NOT NULL,
            requested_by_name VARCHAR(255) NULL,
            approved_by INT NULL,
            approved_by_name VARCHAR(255) NULL,
            payload_json MEDIUMTEXT NOT NULL,
            payload_summary VARCHAR(512) NULL,
            result_json MEDIUMTEXT NULL,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            decided_at DATETIME NULL,
            PRIMARY KEY (id),
            KEY idx_mp_wa_status (status, created_at),
            KEY idx_mp_wa_req (requested_by, status)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    schemaReady = true;
}

function summarizePayload(kind, payload) {
    const p = payload && typeof payload === 'object' ? payload : {};
    if (kind === 'ozon-merge-apply') {
        const groups = Array.isArray(p.groups) ? p.groups : [];
        let offers = 0;
        groups.forEach((g) => {
            offers += Array.isArray(g && g.items) ? g.items.length : 0;
        });
        return `apply · групп ${groups.length} · карточек ~${offers}`;
    }
    if (kind === 'ozon-merge-unmerge') {
        const n = Array.isArray(p.offer_ids) ? p.offer_ids.length : 0;
        return `unmerge · offer_ids ${n}`;
    }
    return String(kind || '').slice(0, 120);
}

async function expireStalePending(db) {
    await ensureMpWriteApprovalsSchema(db);
    const cutoff = new Date(Date.now() - PENDING_TTL_MS);
    await db.query(
        `UPDATE dg_mp_write_approvals
         SET status='expired', decided_at=NOW()
         WHERE status='pending' AND created_at < ?`,
        [cutoff]
    );
}

async function createPendingApproval(db, opts) {
    await ensureMpWriteApprovalsSchema(db);
    const kind = String(opts.kind || '');
    if (!KINDS.has(kind)) {
        const err = new Error('unknown approval kind');
        err.code = 'BAD_KIND';
        err.status = 400;
        throw err;
    }
    const requestedBy = Number(opts.requested_by);
    if (!Number.isFinite(requestedBy) || requestedBy <= 0) {
        const err = new Error('requested_by required');
        err.status = 400;
        throw err;
    }
    const payload = opts.payload && typeof opts.payload === 'object' ? opts.payload : {};
    const summary = String(opts.summary || summarizePayload(kind, payload)).slice(0, 512);
    const [ins] = await db.query(
        `INSERT INTO dg_mp_write_approvals
         (kind, status, requested_by, requested_by_name, payload_json, payload_summary)
         VALUES (?, 'pending', ?, ?, ?, ?)`,
        [
            kind,
            requestedBy,
            opts.requested_by_name != null ? String(opts.requested_by_name).slice(0, 255) : null,
            JSON.stringify(payload),
            summary,
        ]
    );
    return {
        id: ins.insertId,
        kind,
        status: 'pending',
        summary,
        token: crypto.createHash('sha256').update(`mpwa:${ins.insertId}:${requestedBy}`).digest('hex').slice(0, 16),
    };
}

async function getApproval(db, id) {
    await ensureMpWriteApprovalsSchema(db);
    const [rows] = await db.query(
        `SELECT id, kind, status, requested_by, requested_by_name, approved_by, approved_by_name,
                payload_json, payload_summary, result_json, created_at, decided_at
           FROM dg_mp_write_approvals WHERE id=? LIMIT 1`,
        [Number(id)]
    );
    return rows[0] || null;
}

async function listPendingApprovals(db, limit) {
    await expireStalePending(db);
    const lim = Math.min(50, Math.max(1, Number(limit) || 20));
    const [rows] = await db.query(
        `SELECT id, kind, status, requested_by, requested_by_name, payload_summary, created_at
           FROM dg_mp_write_approvals
          WHERE status='pending'
          ORDER BY id DESC
          LIMIT ?`,
        [lim]
    );
    return rows || [];
}

/**
 * Подтвердить pending: approver ≠ requester; status → approved (исполнение снаружи).
 */
async function markApproved(db, id, approver) {
    await expireStalePending(db);
    const row = await getApproval(db, id);
    if (!row) {
        const err = new Error('заявка не найдена');
        err.status = 404;
        err.code = 'NOT_FOUND';
        throw err;
    }
    if (row.status !== 'pending') {
        const err = new Error(`заявка уже в статусе ${row.status}`);
        err.status = 409;
        err.code = 'NOT_PENDING';
        throw err;
    }
    const aid = Number(approver && approver.id);
    if (!Number.isFinite(aid) || aid <= 0) {
        const err = new Error('approver required');
        err.status = 400;
        throw err;
    }
    if (Number(row.requested_by) === aid) {
        const err = new Error('подтвердить должен другой пользователь (dual-control)');
        err.status = 403;
        err.code = 'SAME_ACTOR';
        throw err;
    }
    let payload = {};
    try {
        payload = JSON.parse(row.payload_json || '{}');
    } catch (_) {
        payload = {};
    }
    await db.query(
        `UPDATE dg_mp_write_approvals
         SET status='approved', approved_by=?, approved_by_name=?, decided_at=NOW()
         WHERE id=? AND status='pending'`,
        [aid, approver.name != null ? String(approver.name).slice(0, 255) : null, Number(id)]
    );
    return { row, payload };
}

async function markExecuted(db, id, result) {
    await db.query(
        `UPDATE dg_mp_write_approvals
         SET status='executed', result_json=?, decided_at=COALESCE(decided_at, NOW())
         WHERE id=?`,
        [JSON.stringify(result || {}), Number(id)]
    );
}

async function markRejected(db, id, approver) {
    await expireStalePending(db);
    const row = await getApproval(db, id);
    if (!row) {
        const err = new Error('заявка не найдена');
        err.status = 404;
        throw err;
    }
    if (row.status !== 'pending') {
        const err = new Error(`заявка уже в статусе ${row.status}`);
        err.status = 409;
        throw err;
    }
    const aid = Number(approver && approver.id);
    await db.query(
        `UPDATE dg_mp_write_approvals
         SET status='rejected', approved_by=?, approved_by_name=?, decided_at=NOW()
         WHERE id=? AND status='pending'`,
        [aid || null, approver && approver.name != null ? String(approver.name).slice(0, 255) : null, Number(id)]
    );
    return row;
}

/** In-process mutex: sync ↔ fill ↔ merge live (один heavy job). */
let heavyLock = null;

function tryAcquireMpHeavyLock(owner) {
    const now = Date.now();
    if (heavyLock && now - heavyLock.since < 45 * 60 * 1000) {
        return { ok: false, holder: heavyLock.owner, since: heavyLock.since };
    }
    heavyLock = { owner: String(owner || 'job').slice(0, 80), since: now };
    return { ok: true };
}

function releaseMpHeavyLock(owner) {
    if (heavyLock && (!owner || heavyLock.owner === owner)) heavyLock = null;
}

function getMpHeavyLock() {
    return heavyLock ? { owner: heavyLock.owner, since: heavyLock.since } : null;
}

module.exports = {
    ensureMpWriteApprovalsSchema,
    createPendingApproval,
    getApproval,
    listPendingApprovals,
    markApproved,
    markExecuted,
    markRejected,
    summarizePayload,
    tryAcquireMpHeavyLock,
    releaseMpHeavyLock,
    getMpHeavyLock,
    KINDS,
};
