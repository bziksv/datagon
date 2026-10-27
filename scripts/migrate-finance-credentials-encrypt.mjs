#!/usr/bin/env node
/**
 * Одноразовая миграция банковских credentials в app_settings → AES-GCM (enc:v1:…).
 * Тот же DATAGON_VAULT_KEY, что WORK / CMS.
 *
 *   DATAGON_VAULT_KEY=… node scripts/migrate-finance-credentials-encrypt.mjs
 */
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const mysql = require('mysql2/promise');
const cfg = require('../config');
const {
    migrateFinanceCredentialsEncryptAtRest,
} = require('../lib/datagonFinanceCredentials');
const { isVaultKeyConfigured } = require('../lib/datagonVaultCrypto');

async function main() {
    if (!isVaultKeyConfigured()) {
        console.error('Задайте DATAGON_VAULT_KEY (openssl rand -hex 32)');
        process.exit(1);
    }
    const db = await mysql.createConnection(cfg.db);
    const appSettings = {};
    const [rows] = await db.query(
        `SELECT setting_key, setting_value FROM app_settings
          WHERE setting_key IN (
            'finance_tochka_credentials','finance_tochka_jwt',
            'finance_raiffeisen_credentials','finance_tbank_credentials'
          )`
    );
    (rows || []).forEach((r) => {
        appSettings[r.setting_key] = r.setting_value;
    });
    const result = await migrateFinanceCredentialsEncryptAtRest(db, appSettings);
    console.log(JSON.stringify(result, null, 2));
    await db.end();
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
