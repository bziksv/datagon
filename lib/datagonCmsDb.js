'use strict';

/**
 * Безопасное подключение к CMS MySQL сайтов (F-SQL-02):
 * allowlist host + decrypt db_pass (vault AES-GCM).
 */

const mysql = require('mysql2/promise');
const {
    encryptVaultValue,
    decryptVaultValue,
    isEncryptedVaultValue,
    isVaultSecretSet,
    maskVaultPresence,
} = require('./datagonVaultCrypto');
const { isBlankSecretInput } = require('./datagonSecretRedact');

/** Хосты, которые уже используются в проде; расширяются через DATAGON_CMS_DB_HOSTS. */
const DEFAULT_CMS_DB_HOSTS = Object.freeze([
    '45.90.35.63',
    '217.28.220.186',
    '127.0.0.1',
    'localhost',
]);

function normalizeHost(host) {
    return String(host || '')
        .trim()
        .toLowerCase()
        .replace(/^\[|\]$/g, '');
}

function getAllowedCmsDbHosts() {
    const fromEnv = String(process.env.DATAGON_CMS_DB_HOSTS || '')
        .split(/[\s,;]+/)
        .map((h) => normalizeHost(h))
        .filter(Boolean);
    return new Set(DEFAULT_CMS_DB_HOSTS.map(normalizeHost).concat(fromEnv));
}

function assertCmsDbHostAllowed(host) {
    const h = normalizeHost(host);
    if (!h) {
        const err = new Error('CMS db_host пуст');
        err.code = 'CMS_HOST_DENIED';
        throw err;
    }
    // Блокируем явный SSRF на link-local / metadata, даже если кто-то добавит в env по ошибке.
    if (
        h === '169.254.169.254' ||
        h === 'metadata.google.internal' ||
        h.endsWith('.metadata.google.internal')
    ) {
        const err = new Error('CMS db_host запрещён (metadata)');
        err.code = 'CMS_HOST_DENIED';
        throw err;
    }
    const allowed = getAllowedCmsDbHosts();
    if (!allowed.has(h)) {
        const err = new Error(
            `CMS db_host «${host}» не в allowlist. Разрешите через DATAGON_CMS_DB_HOSTS.`
        );
        err.code = 'CMS_HOST_DENIED';
        throw err;
    }
    return h;
}

/** VARCHAR(255) мало для enc:v1:; идемпотентно → TEXT. */
async function ensureMySitesDbPassColumn(db) {
    if (!db || typeof db.query !== 'function') return;
    try {
        const [cols] = await db.query(
            `SELECT DATA_TYPE AS dt, CHARACTER_MAXIMUM_LENGTH AS maxlen
               FROM information_schema.COLUMNS
              WHERE TABLE_SCHEMA = DATABASE()
                AND TABLE_NAME = 'my_sites'
                AND COLUMN_NAME = 'db_pass'
              LIMIT 1`
        );
        const col = cols && cols[0];
        if (!col) return;
        const dt = String(col.dt || '').toLowerCase();
        if (dt === 'text' || dt === 'mediumtext' || dt === 'longtext') return;
        await db.query('ALTER TABLE my_sites MODIFY COLUMN db_pass TEXT NULL');
    } catch (e) {
        console.warn('[cms-db] ensure db_pass TEXT:', e && e.message ? e.message : e);
    }
}

function encryptCmsDbPass(plain) {
    if (isBlankSecretInput(plain)) return '';
    return encryptVaultValue(String(plain));
}

function decryptCmsDbPass(stored) {
    if (!isVaultSecretSet(stored)) return '';
    return decryptVaultValue(stored);
}

function prepareCmsDbPassForStore(incoming, existingStored) {
    if (isBlankSecretInput(incoming)) {
        return existingStored == null ? '' : String(existingStored);
    }
    return encryptCmsDbPass(incoming);
}

function maskCmsDbPassFields(row) {
    if (!row || typeof row !== 'object') return row;
    const out = Object.assign({}, row);
    const raw = out.db_pass;
    const set = isVaultSecretSet(raw);
    out.db_pass_set = set;
    out.db_pass_mask = set ? maskVaultPresence(raw) : '';
    out.db_pass = '';
    return out;
}

/**
 * Локальный override CMS MySQL (не трогает my_sites в общей БД).
 * Env:
 *   DATAGON_CMS_DB_OVERRIDE_<siteId>=host:user:pass:database
 *   DATAGON_CMS_DB_OVERRIDE=host:user:pass:database  (для всех сайтов)
 * Пример Almamed → localhost:
 *   DATAGON_CMS_DB_OVERRIDE_2=127.0.0.1:almamed:localdev:almamed_su_db
 *
 * @param {{ id?: number|string, db_host?: string, db_user?: string, db_pass?: string, db_name?: string }} site
 * @returns {{ db_host: string, db_user: string, db_pass: string, db_name: string, _cmsOverride?: boolean }}
 */
function resolveCmsDbEndpoint(site) {
    const base = {
        db_host: site && site.db_host,
        db_user: site && site.db_user,
        db_pass: site && site.db_pass,
        db_name: site && site.db_name,
    };
    const siteId = site && site.id != null ? String(site.id).trim() : '';
    const raw =
        (siteId && process.env[`DATAGON_CMS_DB_OVERRIDE_${siteId}`]) ||
        process.env.DATAGON_CMS_DB_OVERRIDE ||
        '';
    const s = String(raw || '').trim();
    if (!s) return base;
    // host:user:pass:database — pass может содержать ':', поэтому database = последний сегмент,
    // host/user = первые два, pass = середина.
    const parts = s.split(':');
    if (parts.length < 4) {
        console.warn('[cms-db] DATAGON_CMS_DB_OVERRIDE: ожидали host:user:pass:database, ignore');
        return base;
    }
    const host = parts[0];
    const user = parts[1];
    const database = parts[parts.length - 1];
    const pass = parts.slice(2, -1).join(':');
    return {
        db_host: host,
        db_user: user,
        db_pass: pass,
        db_name: database,
        _cmsOverride: true,
    };
}

/**
 * @param {{ id?: number|string, db_host: string, db_user: string, db_pass: string, db_name: string }} site
 * @param {{ connectTimeout?: number }} [opts]
 */
async function openCmsDbConnection(site, opts) {
    const o = opts || {};
    const ep = resolveCmsDbEndpoint(site);
    assertCmsDbHostAllowed(ep.db_host);
    let password = '';
    if (ep._cmsOverride) {
        // Override всегда plaintext из env — не ходим в vault.
        password = String(ep.db_pass || '');
    } else {
        try {
            password = decryptCmsDbPass(ep.db_pass);
        } catch (e) {
            if (e && e.code === 'VAULT_KEY_MISSING') {
                const err = new Error(
                    'CMS db_pass зашифрован, нужен DATAGON_VAULT_KEY'
                );
                err.code = 'VAULT_KEY_MISSING';
                throw err;
            }
            throw e;
        }
    }
    return mysql.createConnection({
        host: String(ep.db_host).trim(),
        user: ep.db_user,
        password,
        database: ep.db_name,
        connectTimeout: o.connectTimeout != null ? o.connectTimeout : 10000,
    });
}

module.exports = {
    DEFAULT_CMS_DB_HOSTS,
    getAllowedCmsDbHosts,
    assertCmsDbHostAllowed,
    ensureMySitesDbPassColumn,
    encryptCmsDbPass,
    decryptCmsDbPass,
    prepareCmsDbPassForStore,
    maskCmsDbPassFields,
    resolveCmsDbEndpoint,
    openCmsDbConnection,
    isEncryptedVaultValue,
};
