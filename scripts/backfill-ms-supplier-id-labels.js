#!/usr/bin/env node
'use strict';

/**
 * Разово: заменить ms_export.supplier вида «[ID:uuid]» на имя контрагента из API МС.
 *
 *   node scripts/backfill-ms-supplier-id-labels.js
 */

const mysql = require('mysql2/promise');
const axios = require('axios');
const config = require('../config');
const { backfillMsExportSupplierIdLabels } = require('../lib/datagonMsSupplierLabel');

async function main() {
    const token = String(process.env.MS_TOKEN || config.msToken || '').trim();
    if (!token) {
        console.error('MS_TOKEN / config.msToken не задан');
        process.exit(1);
    }
    const db = await mysql.createConnection({
        host: config.db.host,
        user: config.db.user,
        password: config.db.password,
        database: config.db.database
    });
    try {
        const result = await backfillMsExportSupplierIdLabels(db, {
            axiosImpl: axios,
            headers: { Authorization: `Bearer ${token}` },
            delayMs: 120,
            onProgress: ({ i, total, label, name }) => {
                console.log(`[${i}/${total}] ${label} → ${name || '(не найдено)'}`);
            },
            onWarn: (msg) => console.warn(msg)
        });
        console.log(JSON.stringify(result, null, 2));
    } finally {
        await db.end();
    }
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
