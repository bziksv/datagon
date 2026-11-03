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
    '178.250.157.140',
    '37.46.134.70',
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
    const rawMirror = out.db_pass_mirror;
    const mirrorSet = isVaultSecretSet(rawMirror);
    out.db_pass_mirror_set = mirrorSet;
    out.db_pass_mirror_mask = mirrorSet ? maskVaultPresence(rawMirror) : '';
    out.db_pass_mirror = '';
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

/** Таймаут и «хост недоступен» — можно пробовать зеркало. Ошибка логина/базы — нет. */
function isCmsConnectFallbackError(err) {
    const code = String((err && (err.code || err.errorno)) || '').toUpperCase();
    if (
        code === 'ETIMEDOUT' ||
        code === 'ECONNREFUSED' ||
        code === 'ENOTFOUND' ||
        code === 'EHOSTUNREACH' ||
        code === 'EAI_AGAIN' ||
        code === 'ECONNRESET'
    ) {
        return true;
    }
    const msg = String((err && err.message) || '');
    return /ETIMEDOUT|ECONNREFUSED|ENOTFOUND|EHOSTUNREACH/i.test(msg);
}

function cmsConnectionMeta(conn) {
    const meta = conn && conn.dgCmsEndpoint;
    if (!meta) return { role: 'primary', host: '' };
    return { role: meta.role === 'mirror' ? 'mirror' : 'primary', host: String(meta.host || '') };
}

let mirrorColsReady = false;
async function ensureMySitesMirrorColumns(db) {
    if (!db || typeof db.query !== 'function' || mirrorColsReady) return;
    const [rows] = await db.query(
        `SELECT COLUMN_NAME AS name
           FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE()
            AND TABLE_NAME = 'my_sites'
            AND COLUMN_NAME IN ('db_host_mirror','db_name_mirror','db_user_mirror','db_pass_mirror','cms_db_active','cms_db_last_role','cms_db_last_host','cms_db_last_at','cms_db_last_error')`
    );
    const have = new Set((rows || []).map((r) => String(r.name)));
    const alters = [];
    if (!have.has('db_host_mirror')) {
        alters.push('ADD COLUMN db_host_mirror VARCHAR(255) NULL DEFAULT NULL AFTER db_host');
    }
    if (!have.has('db_name_mirror')) {
        alters.push('ADD COLUMN db_name_mirror VARCHAR(255) NULL DEFAULT NULL');
    }
    if (!have.has('db_user_mirror')) {
        alters.push('ADD COLUMN db_user_mirror VARCHAR(255) NULL DEFAULT NULL');
    }
    if (!have.has('db_pass_mirror')) {
        alters.push('ADD COLUMN db_pass_mirror TEXT NULL DEFAULT NULL');
    }
    const addActive = !have.has('cms_db_active');
    if (addActive) {
        alters.push("ADD COLUMN cms_db_active VARCHAR(16) NOT NULL DEFAULT 'primary'");
    }
    if (!have.has('cms_db_last_role')) {
        alters.push("ADD COLUMN cms_db_last_role VARCHAR(16) NULL DEFAULT NULL");
    }
    if (!have.has('cms_db_last_host')) {
        alters.push('ADD COLUMN cms_db_last_host VARCHAR(255) NULL DEFAULT NULL');
    }
    if (!have.has('cms_db_last_at')) {
        alters.push('ADD COLUMN cms_db_last_at TIMESTAMP NULL DEFAULT NULL');
    }
    if (!have.has('cms_db_last_error')) {
        alters.push('ADD COLUMN cms_db_last_error VARCHAR(500) NULL DEFAULT NULL');
    }
    if (alters.length) {
        await db.query(`ALTER TABLE my_sites ${alters.join(', ')}`);
    }
    if (addActive) {
        await db.query(
            `UPDATE my_sites
                SET cms_db_active = 'mirror'
              WHERE cms_db_last_role = 'mirror'
                AND db_host_mirror IS NOT NULL
                AND TRIM(db_host_mirror) <> ''`
        );
    }
    mirrorColsReady = true;
}

async function rememberCmsDbConnect(appDb, siteId, meta, errorText) {
    if (!appDb || typeof appDb.query !== 'function') return;
    const id = Number(siteId);
    if (!Number.isFinite(id) || id < 1) return;
    try {
        await ensureMySitesMirrorColumns(appDb);
        if (errorText) {
            await appDb.query(
                'UPDATE my_sites SET cms_db_last_error = ?, cms_db_last_at = NOW() WHERE id = ?',
                [String(errorText).slice(0, 500), id]
            );
            return;
        }
        await appDb.query(
            `UPDATE my_sites
                SET cms_db_last_role = ?, cms_db_last_host = ?, cms_db_last_error = NULL, cms_db_last_at = NOW()
              WHERE id = ?`,
            [meta && meta.role === 'mirror' ? 'mirror' : 'primary', String((meta && meta.host) || '').slice(0, 255), id]
        );
    } catch (e) {
        console.warn('[cms-db] remember:', e && e.message ? e.message : e);
    }
}

/** Vault-шифр или открытый пароль с формы (проверка до сохранения). */
function secretForConnect(stored) {
    if (stored == null || String(stored).trim() === '') return '';
    if (isVaultSecretSet(stored)) return decryptCmsDbPass(stored);
    return String(stored);
}

function cmsActiveRole(site) {
    return String((site && site.cms_db_active) || '').toLowerCase() === 'mirror' ? 'mirror' : 'primary';
}

/**
 * Одно подключение: то, что выбрано как рабочее (`cms_db_active`).
 * Пустые имя, пользователь и пароль зеркала берутся с основного.
 * Локальный DATAGON_CMS_DB_OVERRIDE выбор не подменяет.
 */
function buildCmsAttempt(site, ep, password) {
    const mirrorHost = String((site && site.db_host_mirror) || '').trim();
    if (!ep._cmsOverride && cmsActiveRole(site) === 'mirror' && mirrorHost) {
        const ownPass = secretForConnect(site && site.db_pass_mirror);
        return {
            role: 'mirror',
            host: mirrorHost,
            user: String((site && site.db_user_mirror) || '').trim() || ep.db_user,
            password: ownPass || password,
            database: String((site && site.db_name_mirror) || '').trim() || ep.db_name,
        };
    }
    return {
        role: 'primary',
        host: String(ep.db_host || '').trim(),
        user: ep.db_user,
        password,
        database: ep.db_name,
    };
}

/**
 * @param {{ id?: number|string, cms_db_active?: string, db_host: string, db_host_mirror?: string, db_name_mirror?: string, db_user_mirror?: string, db_pass_mirror?: string, db_user: string, db_pass: string, db_name: string }} site
 * @param {{ connectTimeout?: number, appDb?: object }} [opts]
 */
async function openCmsDbConnection(site, opts) {
    const o = opts || {};
    const ep = resolveCmsDbEndpoint(site);
    const timeout = o.connectTimeout != null ? o.connectTimeout : 10000;
    let password = '';
    if (ep._cmsOverride) {
        password = String(ep.db_pass || '');
    } else {
        try {
            password = decryptCmsDbPass(ep.db_pass);
        } catch (e) {
            if (e && e.code === 'VAULT_KEY_MISSING') {
                const err = new Error('CMS db_pass зашифрован, нужен DATAGON_VAULT_KEY');
                err.code = 'VAULT_KEY_MISSING';
                throw err;
            }
            throw e;
        }
    }

    const attempt = buildCmsAttempt(site, ep, password);
    assertCmsDbHostAllowed(attempt.host);
    try {
        const conn = await mysql.createConnection({
            host: attempt.host,
            user: attempt.user,
            password: attempt.password,
            database: attempt.database,
            connectTimeout: timeout,
        });
        conn.dgCmsEndpoint = { role: attempt.role, host: attempt.host, override: !!ep._cmsOverride };
        if (!ep._cmsOverride) {
            await rememberCmsDbConnect(o.appDb, site && site.id, conn.dgCmsEndpoint, '');
        }
        return conn;
    } catch (e) {
        const label = attempt.role === 'mirror' ? 'зеркало' : 'основной';
        const err = new Error(`${label} ${attempt.host}: ${e && e.message ? e.message : e}`);
        err.code = e && e.code ? e.code : 'CMS_CONNECT';
        err.cmsAttempts = [err.message];
        if (!ep._cmsOverride) {
            await rememberCmsDbConnect(o.appDb, site && site.id, null, err.message);
        }
        throw err;
    }
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
    isCmsConnectFallbackError,
    cmsConnectionMeta,
    ensureMySitesMirrorColumns,
    rememberCmsDbConnect,
    isEncryptedVaultValue,
};
