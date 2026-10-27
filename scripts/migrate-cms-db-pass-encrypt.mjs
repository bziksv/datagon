#!/usr/bin/env node
/**
 * Одноразовая миграция my_sites.db_pass → AES-GCM (enc:v1:…).
 * Тот же DATAGON_VAULT_KEY, что и для WORK vault.
 *
 *   DATAGON_VAULT_KEY=… node scripts/migrate-cms-db-pass-encrypt.mjs
 */
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const mysql = require('mysql2/promise');
const cfg = require('../config');
const {
    encryptCmsDbPass,
    isEncryptedVaultValue,
    ensureMySitesDbPassColumn,
} = require('../lib/datagonCmsDb');
const { isVaultKeyConfigured, isVaultSecretSet } = require('../lib/datagonVaultCrypto');

async function main() {
    if (!isVaultKeyConfigured()) {
        console.error('Задайте DATAGON_VAULT_KEY (openssl rand -hex 32)');
        process.exit(1);
    }
    const db = await mysql.createConnection(cfg.db);
    await ensureMySitesDbPassColumn(db);
    const [rows] = await db.query('SELECT id, db_pass FROM my_sites');
    let encrypted = 0;
    let skipped = 0;
    let empty = 0;
    for (const row of rows || []) {
        const raw = row.db_pass;
        if (!isVaultSecretSet(raw)) {
            empty += 1;
            continue;
        }
        if (isEncryptedVaultValue(raw)) {
            skipped += 1;
            continue;
        }
        const next = encryptCmsDbPass(raw);
        if (next === raw) {
            skipped += 1;
            continue;
        }
        await db.query('UPDATE my_sites SET db_pass = ? WHERE id = ?', [next, row.id]);
        encrypted += 1;
    }
    console.log(
        JSON.stringify(
            { total: (rows || []).length, encrypted, skipped_already: skipped, empty },
            null,
            2
        )
    );
    await db.end();
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
