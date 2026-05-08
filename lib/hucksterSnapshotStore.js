'use strict';

let tableReady = false;

async function ensureTable(db) {
    if (tableReady || typeof db?.query !== 'function') return;
    await db.query(`
        CREATE TABLE IF NOT EXISTS huckster_matrix_snapshots (
            id VARCHAR(32) NOT NULL PRIMARY KEY,
            payload_json LONGTEXT NOT NULL,
            updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    tableReady = true;
}

/**
 * Сохраняет последний успешный результат матриц Huckster (JSON).
 * @param {import('mysql2/promise').Pool} db
 * @param {{ success?: boolean, updated_at?: string, sheet_export?: { rows?: unknown[], total_uids?: number, unit_gap_shop_indexes_by_uid?: Record<string, number[]> }, sheet_export_rrc?: { rows?: unknown[], total_uids?: number, unit_gap_shop_indexes_by_uid?: Record<string, number[]> }, sheet_export_lost?: { rows?: unknown[], total_rows?: number, matrix_kind?: string } }} payload
 */
async function saveHucksterSnapshot(db, payload) {
    if (!db || typeof db.query !== 'function' || !payload || !payload.sheet_export || !payload.sheet_export_rrc) return;
    await ensureTable(db);
    const json = JSON.stringify({
        updated_at: payload.updated_at || new Date().toISOString(),
        sheet_export: payload.sheet_export,
        sheet_export_rrc: payload.sheet_export_rrc,
        sheet_export_lost: payload.sheet_export_lost || { rows: [], total_rows: 0, matrix_kind: 'huckster_lost_v1' },
    });
    await db.query(
        `INSERT INTO huckster_matrix_snapshots (id, payload_json) VALUES ('latest', ?)
         ON DUPLICATE KEY UPDATE payload_json = VALUES(payload_json), updated_at = CURRENT_TIMESTAMP`,
        [json]
    );
}

/**
 * @returns {Promise<{ updated_at: string, sheet_export: object, sheet_export_rrc: object, stored_at?: Date } | null>}
 */
async function loadHucksterSnapshot(db) {
    if (!db || typeof db.query !== 'function') return null;
    await ensureTable(db);
    const [rows] = await db.query(
        'SELECT payload_json, updated_at FROM huckster_matrix_snapshots WHERE id = ? LIMIT 1',
        ['latest']
    );
    if (!rows || !rows.length) return null;
    try {
        const o = JSON.parse(String(rows[0].payload_json || '{}'));
        if (!o || typeof o !== 'object') return null;
        return {
            ...o,
            stored_at: rows[0].updated_at,
        };
    } catch (_) {
        return null;
    }
}

/** Удаляет сохранённый снапшот матриц (`id=latest`). Идемпотентно: если строки не было — не ошибка. */
async function clearHucksterSnapshot(db) {
    if (!db || typeof db.query !== 'function') return;
    await ensureTable(db);
    await db.query('DELETE FROM huckster_matrix_snapshots WHERE id = ?', ['latest']);
}

module.exports = {
    saveHucksterSnapshot,
    loadHucksterSnapshot,
    clearHucksterSnapshot,
};
