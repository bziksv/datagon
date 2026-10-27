#!/usr/bin/env node
/**
 * Одноразовая миграция WORK vault → AES-GCM (enc:v1:…).
 * Требует DATAGON_VAULT_KEY. Перед продом: выкатить код + тот же ключ в pm2 env, затем этот скрипт.
 *
 *   DATAGON_VAULT_KEY=$(openssl rand -hex 32) node scripts/migrate-work-vault-encrypt.mjs
 */
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const mysql = require('mysql2/promise');
const cfg = require('../config');
const {
    ensureWorkPrimeSchema,
    migrateWorkVaultEncryptAtRest,
} = require('../lib/datagonWorkPrimeSchema');
const { isVaultKeyConfigured } = require('../lib/datagonVaultCrypto');

async function main() {
    if (!isVaultKeyConfigured()) {
        console.error('Задайте DATAGON_VAULT_KEY (openssl rand -hex 32)');
        process.exit(1);
    }
    const db = await mysql.createConnection(cfg.db);
    await ensureWorkPrimeSchema(db);
    const result = await migrateWorkVaultEncryptAtRest(db);
    console.log(JSON.stringify(result, null, 2));
    await db.end();
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
