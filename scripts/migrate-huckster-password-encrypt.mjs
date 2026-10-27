#!/usr/bin/env node
/**
 * Одноразовая миграция app_settings.huckster_password → AES-GCM (enc:v1:…).
 * Тот же DATAGON_VAULT_KEY, что WORK / CMS / finance vault.
 *
 *   DATAGON_VAULT_KEY=… node scripts/migrate-huckster-password-encrypt.mjs
 * На проде (из env pm2):
 *   cd …/p.datagon.ru && $(pm2 env parser-app | …)  — проще:
 *   export $(grep DATAGON_VAULT_KEY …) или взять из pm2 ecosystem / .env
 */
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const mysql = require('mysql2/promise');
const cfg = require('../config');
const {
    encryptVaultValue,
    isEncryptedVaultValue,
    isVaultKeyConfigured,
    isVaultSecretSet,
} = require('../lib/datagonVaultCrypto');

const KEY = 'huckster_password';

async function main() {
    if (!isVaultKeyConfigured()) {
        console.error('Задайте DATAGON_VAULT_KEY (openssl rand -hex 32)');
        process.exit(1);
    }
    const db = await mysql.createConnection(cfg.db);
    const [rows] = await db.query(
        'SELECT setting_key, setting_value FROM app_settings WHERE setting_key = ? LIMIT 1',
        [KEY]
    );
    const row = rows && rows[0];
    if (!row) {
        console.log(JSON.stringify({ ok: true, status: 'missing_key', encrypted: 0 }));
        await db.end();
        return;
    }
    const raw = row.setting_value;
    if (!isVaultSecretSet(raw)) {
        console.log(JSON.stringify({ ok: true, status: 'empty', encrypted: 0 }));
        await db.end();
        return;
    }
    if (isEncryptedVaultValue(raw)) {
        console.log(JSON.stringify({ ok: true, status: 'already_encrypted', encrypted: 0 }));
        await db.end();
        return;
    }
    const next = encryptVaultValue(String(raw));
    if (next === raw || !isEncryptedVaultValue(next)) {
        console.error('encrypt не дал enc:v1 (проверьте DATAGON_VAULT_KEY)');
        await db.end();
        process.exit(1);
    }
    await db.query(
        'UPDATE app_settings SET setting_value = ? WHERE setting_key = ?',
        [next, KEY]
    );
    console.log(
        JSON.stringify({
            ok: true,
            status: 'encrypted',
            encrypted: 1,
            prefix: String(next).slice(0, 12) + '…',
        })
    );
    await db.end();
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
