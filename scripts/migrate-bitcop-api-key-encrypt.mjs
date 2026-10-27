#!/usr/bin/env node
/**
 * Одноразовая миграция app_settings.ws_bitcop_api_key → AES-GCM (enc:v1:…).
 * Тот же DATAGON_VAULT_KEY, что WORK / CMS / finance / huckster vault.
 *
 *   DATAGON_VAULT_KEY=… node scripts/migrate-bitcop-api-key-encrypt.mjs
 */
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const mysql = require('mysql2/promise');
const cfg = require('../config');
const { isVaultKeyConfigured } = require('../lib/datagonVaultCrypto');
const bitcop = require('../lib/datagonBitcopClient');

async function main() {
    if (!isVaultKeyConfigured()) {
        console.error('Задайте DATAGON_VAULT_KEY (openssl rand -hex 32)');
        process.exit(1);
    }
    const db = await mysql.createConnection(cfg.db);
    const result = await bitcop.migrateBitcopApiKeyEncrypt(db);
    console.log(JSON.stringify({ ok: true, ...result }));
    await db.end();
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
