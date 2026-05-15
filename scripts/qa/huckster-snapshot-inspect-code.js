#!/usr/bin/env node
/**
 * Печать строки матрицы Huckster из БД (huckster_matrix_snapshots.id=latest) по коду МС (первый столбец «ID / КОД»).
 * Usage: node scripts/qa/huckster-snapshot-inspect-code.js [код]
 * Example: node scripts/qa/huckster-snapshot-inspect-code.js 3110
 */
'use strict';

const mysql = require('mysql2/promise');
const config = require('../../config');
const { loadHucksterSnapshot } = require('../../lib/hucksterSnapshotStore');

function rowToObject(header, row) {
    const o = {};
    for (let i = 0; i < header.length; i++) {
        o[String(header[i] == null ? '' : header[i]).trim()] = row[i] == null ? '' : row[i];
    }
    return o;
}

function findRow(sheet, code) {
    const rows = sheet && Array.isArray(sheet.rows) ? sheet.rows : [];
    if (rows.length < 2) return null;
    const header = rows[0];
    const codeIdx = header.findIndex((h) => String(h || '').trim() === 'ID / КОД');
    if (codeIdx < 0) return null;
    const c = String(code || '').trim();
    for (let i = 1; i < rows.length; i++) {
        const v = rows[i] && rows[i][codeIdx] != null ? String(rows[i][codeIdx]).trim() : '';
        if (v === c) return { index: i, header, row: rows[i] };
    }
    return null;
}

function pickModelFields(obj) {
    const keys = Object.keys(obj).filter((k) => /^(Ozon|WB|ЯМ|Модель|Автоматизация|ID)/i.test(k));
    const out = {};
    for (const k of keys.sort()) out[k] = obj[k];
    return out;
}

async function main() {
    const code = String(process.argv[2] || '3110').trim();
    const pool = mysql.createPool({
        host: config.db.host,
        user: config.db.user,
        password: config.db.password,
        database: config.db.database,
        waitForConnections: true,
        connectionLimit: 2,
    });
    try {
        const snap = await loadHucksterSnapshot(pool);
        if (!snap) {
            console.error('Нет снапшота в БД (huckster_matrix_snapshots / latest пустой). Сделайте «Обновить Huckster».');
            process.exitCode = 2;
            return;
        }
        console.log('snapshot updated_at:', snap.updated_at || '(нет)');
        console.log('snapshot stored_at (DB):', snap.stored_at || '(нет)');
        for (const name of ['sheet_export', 'sheet_export_rrc']) {
            const sheet = snap[name];
            const hit = findRow(sheet, code);
            console.log('\n---', name, '---');
            if (!hit) {
                console.log('Строка с кодом', JSON.stringify(code), 'не найдена.');
                continue;
            }
            const obj = rowToObject(hit.header, hit.row);
            console.log('row index (1-based body):', hit.index);
            console.log(JSON.stringify(pickModelFields(obj), null, 2));
            const meta =
                sheet.bridge_row_meta && sheet.bridge_row_meta[hit.index] != null
                    ? sheet.bridge_row_meta[hit.index]
                    : null;
            if (meta) {
                console.log('bridge_row_meta:', JSON.stringify(meta, null, 2));
            } else {
                console.log('bridge_row_meta: (нет в снапшоте для этой строки)');
            }
        }
    } finally {
        await pool.end();
    }
}

main().catch((e) => {
    console.error(e && e.message ? e.message : e);
    process.exitCode = 1;
});
