/**
 * Маскирование / детекция секретных ключей для API и логов (P0 security audit).
 */

const { isEncryptedVaultValue, maskVaultPresence } = require('./datagonVaultCrypto');

const SECRET_KEY_RE =
    /(password|passwd|secret|token|jwt|api_key|apikey|credentials|proxy_list|db_pass)/i;

/** Ключи app_settings, которые никогда не отдаём plaintext в GET /api/settings. */
const SETTINGS_SECRET_KEYS = [
    'ozon_api_key',
    'wb_api_key',
    'ym_api_key',
    'planfix_rest_api_key',
    'huckster_password',
    'fetch_proxy_list',
    'finance_tochka_jwt',
    'finance_tochka_credentials',
    'finance_raiffeisen_credentials',
    'finance_tbank_credentials',
    'bitcop_api_key',
    'crm_clock_sync_secret',
];

/** Таблицы, превью которых в db-admin запрещено целиком. */
const DB_ADMIN_PREVIEW_FORBIDDEN = new Set([
    'app_settings',
    'users',
    'auth_sessions',
    'work_seo_passwords',
    'work_dev_passwords',
    'work_context_passwords',
    'work_services',
]);

/** Колонки, значения которых redact'им в любом preview. */
const DB_ADMIN_COLUMN_REDACT_RE =
    /(password|passwd|secret|token|jwt|api_key|hash|credential|proxy)/i;

/** Поля WORK vault — не отдаём в list/detail без reveal. */
const WORK_SENSITIVE_KEYS = new Set([
    'admin_pass',
    'password',
    'ftp',
    'ssa',
    'passYandex',
    'passGoogle',
    'passMyTarget',
    'value_serialize',
]);

function isSecretSettingsKey(key) {
    const k = String(key || '');
    if (SETTINGS_SECRET_KEYS.includes(k)) return true;
    return SECRET_KEY_RE.test(k);
}

function maskSecret(raw) {
    const s = String(raw == null ? '' : raw);
    if (!s) return '';
    if (s.length <= 8) return '•'.repeat(Math.min(s.length, 6)) + ' (' + s.length + ' симв.)';
    return s.slice(0, 4) + '…' + s.slice(-4) + ' (' + s.length + ' симв.)';
}

/**
 * Копия appSettings для лога: секреты → mask, без функций.
 */
function maskSettingsSecretForPublic(s) {
    if (!s) return '';
    if (isEncryptedVaultValue(s)) return maskVaultPresence(s);
    return maskSecret(s);
}

function redactAppSettingsForLog(appSettings) {
    const out = {};
    if (!appSettings || typeof appSettings !== 'object') return out;
    for (const [k, v] of Object.entries(appSettings)) {
        if (k === '_reloadFromDb' || typeof v === 'function') continue;
        if (isSecretSettingsKey(k)) {
            const s = v == null ? '' : String(v);
            out[k] = s ? maskSettingsSecretForPublic(s) : '';
            out[k + '_set'] = Boolean(s);
        } else {
            out[k] = v;
        }
    }
    return out;
}

/**
 * Публичный снимок settings для GET /api/settings.
 * Секреты → пустая строка + *_set + *_mask (UI не подставляет plaintext в инпут).
 */
function publicSettingsSnapshot(appSettings) {
    const out = {};
    if (!appSettings || typeof appSettings !== 'object') return out;
    for (const [k, v] of Object.entries(appSettings)) {
        if (k === '_reloadFromDb' || typeof v === 'function') continue;
        if (isSecretSettingsKey(k)) {
            const s = v == null ? '' : String(v);
            out[k] = '';
            out[k + '_set'] = Boolean(s);
            out[k + '_mask'] = s ? maskSettingsSecretForPublic(s) : '';
        } else {
            out[k] = v;
        }
    }
    return out;
}

/**
 * Пустое / whitespace значение секретного поля при POST = «не менять».
 */
function isBlankSecretInput(v) {
    return v == null || String(v).trim() === '';
}

function assertSqlIdent(name, label) {
    const s = String(name == null ? '' : name).trim();
    if (!s) {
        const err = new Error(`${label || 'Идентификатор'}: пусто`);
        err.code = 'BAD_SQL_IDENT';
        throw err;
    }
    // schema.table — максимум две части
    const parts = s.split('.');
    if (parts.length > 2) {
        const err = new Error(`${label || 'Идентификатор'}: недопустимо «${s}»`);
        err.code = 'BAD_SQL_IDENT';
        throw err;
    }
    for (const p of parts) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(p)) {
            const err = new Error(`${label || 'Идентификатор'}: недопустимо «${s}»`);
            err.code = 'BAD_SQL_IDENT';
            throw err;
        }
    }
    return s;
}

function quoteSqlIdent(name) {
    const s = assertSqlIdent(name);
    return s
        .split('.')
        .map((p) => '`' + p.replace(/`/g, '') + '`')
        .join('.');
}

function isDbAdminPreviewForbidden(tableName) {
    return DB_ADMIN_PREVIEW_FORBIDDEN.has(String(tableName || '').toLowerCase());
}

function shouldRedactDbAdminColumn(columnName) {
    return DB_ADMIN_COLUMN_REDACT_RE.test(String(columnName || ''));
}

function redactDbAdminPreviewRows(rows, columns) {
    const colNames = (columns || []).map((c) => (c && c.name != null ? String(c.name) : String(c)));
    const redactCols = colNames.filter((n) => shouldRedactDbAdminColumn(n));
    if (!redactCols.length) return rows || [];
    return (rows || []).map((row) => {
        const copy = Object.assign({}, row);
        for (const col of redactCols) {
            if (copy[col] != null && String(copy[col]) !== '') {
                copy[col] = maskSecret(copy[col]);
            }
        }
        return copy;
    });
}

/** Поля my_sites, подставляемые в SQL CMS. */
const MY_SITE_SQL_IDENT_KEYS = [
    'table_products',
    'field_name',
    'field_sku',
    'field_code',
    'field_price',
    'field_currency',
    'field_stock',
    'wa_table_skus',
    'wa_field_sku_val',
    'wa_field_price_val',
    'wa_field_stock_val',
];

/**
 * Проверяет идентификаторы CMS-сайта перед подстановкой в SQL.
 * Пустые опциональные (wa_*) пропускаются.
 */
function assertMySiteSqlIdents(site) {
    if (!site || typeof site !== 'object') {
        const err = new Error('Сайт не задан');
        err.code = 'BAD_SQL_IDENT';
        throw err;
    }
    for (const key of MY_SITE_SQL_IDENT_KEYS) {
        const raw = site[key];
        if (raw == null || String(raw).trim() === '') {
            if (key === 'table_products') {
                assertSqlIdent(raw, key);
            }
            continue;
        }
        assertSqlIdent(raw, key);
    }
    return site;
}

function isWorkSensitiveKey(key) {
    return WORK_SENSITIVE_KEYS.has(String(key || ''));
}

/**
 * Маскирует чувствительные поля WORK-строки (мутирует копию).
 * Не светим длину ciphertext / plaintext — только «задано / нет».
 */
function maskWorkRowSecrets(row) {
    if (!row || typeof row !== 'object') return row;
    const { isVaultSecretSet, maskVaultPresence } = require('./datagonVaultCrypto');
    const out = Object.assign({}, row);
    for (const key of WORK_SENSITIVE_KEYS) {
        if (!Object.prototype.hasOwnProperty.call(out, key)) continue;
        const raw = out[key];
        const set = isVaultSecretSet(raw);
        out[key + '_set'] = set;
        out[key + '_mask'] = set ? maskVaultPresence(raw) : '';
        out[key] = '';
    }
    return out;
}

module.exports = {
    SECRET_KEY_RE,
    SETTINGS_SECRET_KEYS,
    DB_ADMIN_PREVIEW_FORBIDDEN,
    WORK_SENSITIVE_KEYS,
    MY_SITE_SQL_IDENT_KEYS,
    isSecretSettingsKey,
    maskSecret,
    redactAppSettingsForLog,
    publicSettingsSnapshot,
    isBlankSecretInput,
    assertSqlIdent,
    quoteSqlIdent,
    assertMySiteSqlIdents,
    isDbAdminPreviewForbidden,
    shouldRedactDbAdminColumn,
    redactDbAdminPreviewRows,
    isWorkSensitiveKey,
    maskWorkRowSecrets,
};
