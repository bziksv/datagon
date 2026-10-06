/**
 * Несколько JWT Точки (по организациям / ключам кабинета).
 * Хранение: app_settings.finance_tochka_credentials = JSON[].
 * Миграция: старый finance_tochka_jwt → первая запись.
 */

const JWT_LEGACY_KEY = 'finance_tochka_jwt';
const CREDENTIALS_KEY = 'finance_tochka_credentials';
const RAIFF_CREDENTIALS_KEY = 'finance_raiffeisen_credentials';
const TBANK_CREDENTIALS_KEY = 'finance_tbank_credentials';
const ORG_ALIASES_KEY = 'finance_org_aliases';

function maskSecret(raw) {
    const s = String(raw || '');
    if (!s) return '';
    if (s.length <= 8) return '•'.repeat(Math.min(s.length, 6)) + ' (' + s.length + ' симв.)';
    return s.slice(0, 4) + '…' + s.slice(-4) + ' (' + s.length + ' симв.)';
}

/** ISO: RUR/810 — устаревший рубль, считаем как RUB. */
function normalizeCurrency(code) {
    const s = String(code == null ? '' : code)
        .trim()
        .toUpperCase();
    if (!s || s === 'RUR' || s === '810' || s === '643') return 'RUB';
    return s.slice(0, 8);
}

function newCredId() {
    return 'tc_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

function newRaiffCredId() {
    return 'rf_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

function newTbankCredId() {
    return 'tb_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

function normalizeCredential(raw) {
    const c = raw && typeof raw === 'object' ? raw : {};
    const id = String(c.id || '').trim() || newCredId();
    const jwt = String(c.jwt || '').trim();
    const label = String(c.label || '').trim() || 'Точка';
    const enabled = c.enabled !== false && c.enabled !== 0 && c.enabled !== '0';
    const customer_codes = Array.isArray(c.customer_codes)
        ? c.customer_codes.map((x) => String(x || '').trim()).filter(Boolean)
        : [];
    const customer_names = Array.isArray(c.customer_names)
        ? c.customer_names.map((x) => String(x || '').trim()).filter(Boolean)
        : [];
    return {
        id,
        label: label.slice(0, 120),
        jwt: jwt.slice(0, 8000),
        enabled,
        customer_codes,
        customer_names,
        updated_at: String(c.updated_at || '').trim() || new Date().toISOString(),
    };
}

function publicCredential(c) {
    const n = normalizeCredential(c);
    return {
        id: n.id,
        label: n.label,
        enabled: n.enabled,
        jwt_mask: maskSecret(n.jwt),
        jwt_len: n.jwt.length,
        configured: Boolean(n.jwt),
        customer_codes: n.customer_codes,
        customer_names: n.customer_names,
        updated_at: n.updated_at,
    };
}

async function getSetting(db, key) {
    const [rows] = await db.query('SELECT setting_value FROM app_settings WHERE setting_key = ? LIMIT 1', [key]);
    if (!rows || !rows[0]) return '';
    return String(rows[0].setting_value || '');
}

async function setSetting(db, appSettings, key, value) {
    const v = String(value == null ? '' : value);
    await db.query(
        'INSERT INTO app_settings (setting_key, setting_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)',
        [key, v]
    );
    if (appSettings && typeof appSettings === 'object') appSettings[key] = v;
}

function parseCredentialsJson(raw) {
    const s = String(raw || '').trim();
    if (!s) return [];
    try {
        const parsed = JSON.parse(s);
        if (!Array.isArray(parsed)) return [];
        return parsed.map(normalizeCredential).filter((c) => c.id);
    } catch (e) {
        return [];
    }
}

/**
 * Загрузка списка. Если JSON пуст, а legacy JWT есть — мигрируем в первую запись.
 */
async function loadCredentials(db, appSettings) {
    let list = parseCredentialsJson(
        (appSettings && appSettings[CREDENTIALS_KEY]) || (await getSetting(db, CREDENTIALS_KEY))
    );
    if (list.length) return list;

    const legacy = String(
        (appSettings && appSettings[JWT_LEGACY_KEY]) || (await getSetting(db, JWT_LEGACY_KEY)) || ''
    ).trim();
    if (!legacy) return [];

    list = [
        normalizeCredential({
            id: newCredId(),
            label: 'Точка (основной)',
            jwt: legacy,
            enabled: true,
            updated_at: new Date().toISOString(),
        }),
    ];
    await saveCredentials(db, appSettings, list);
    return list;
}

async function saveCredentials(db, appSettings, list) {
    const normalized = (Array.isArray(list) ? list : []).map(normalizeCredential);
    const json = JSON.stringify(normalized);
    await setSetting(db, appSettings, CREDENTIALS_KEY, json);
    // Legacy: первый включённый JWT — для старых интеграций / back-compat.
    const firstEnabled = normalized.find((c) => c.enabled && c.jwt);
    await setSetting(db, appSettings, JWT_LEGACY_KEY, firstEnabled ? firstEnabled.jwt : '');
    return normalized;
}

function enabledWithJwt(list) {
    return (list || []).filter((c) => c && c.enabled !== false && String(c.jwt || '').trim());
}

function parseOrgAliases(raw) {
    const s = String(raw || '').trim();
    if (!s) return {};
    try {
        const parsed = JSON.parse(s);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
        const out = {};
        for (const [k, v] of Object.entries(parsed)) {
            const code = String(k || '').trim();
            if (!code) continue;
            let full = '';
            let short = '';
            if (v && typeof v === 'object' && !Array.isArray(v)) {
                full = String(v.full != null ? v.full : v.full_name || '').trim().slice(0, 160);
                short = String(v.short != null ? v.short : v.short_name || '').trim().slice(0, 80);
            } else {
                // legacy: одна строка → и полное, и короткое (пока пользователь не разведёт)
                const one = String(v || '').trim().slice(0, 160);
                full = one;
                short = one.slice(0, 80);
            }
            if (!full && !short) continue;
            out[code] = { full: full || short, short: short || full };
        }
        return out;
    } catch (e) {
        return {};
    }
}

/** Отображаемое полное имя (фильтр, таблица, аналитика). */
function orgAliasFull(entry, fallback) {
    if (entry && typeof entry === 'object') {
        const f = String(entry.full || '').trim();
        const s = String(entry.short || '').trim();
        if (f) return f;
        if (s) return s;
    } else if (typeof entry === 'string' && entry.trim()) {
        return entry.trim();
    }
    return String(fallback || '').trim();
}

/** Короткое имя (карточки балансов / шапка орг). */
function orgAliasShort(entry, fallback) {
    if (entry && typeof entry === 'object') {
        const s = String(entry.short || '').trim();
        const f = String(entry.full || '').trim();
        if (s) return s;
        if (f) return f;
    } else if (typeof entry === 'string' && entry.trim()) {
        return entry.trim();
    }
    return String(fallback || '').trim();
}

async function loadOrgAliases(db, appSettings) {
    const raw =
        (appSettings && appSettings[ORG_ALIASES_KEY]) || (await getSetting(db, ORG_ALIASES_KEY)) || '';
    return parseOrgAliases(raw);
}

function normalizeRaiffCredential(raw) {
    const c = raw && typeof raw === 'object' ? raw : {};
    const id = String(c.id || '').trim() || newRaiffCredId();
    const enabled = c.enabled !== false && c.enabled !== 0 && c.enabled !== '0';
    const customer_codes = Array.isArray(c.customer_codes)
        ? c.customer_codes.map((x) => String(x || '').trim()).filter(Boolean)
        : [];
    const customer_names = Array.isArray(c.customer_names)
        ? c.customer_names.map((x) => String(x || '').trim()).filter(Boolean)
        : [];
    return {
        id,
        label: String(c.label || '').trim().slice(0, 120) || 'Райффайзен',
        client_id: String(c.client_id || '').trim().slice(0, 200),
        client_secret: String(c.client_secret || '').trim().slice(0, 800),
        refresh_token: String(c.refresh_token || '').trim().slice(0, 8000),
        access_token: String(c.access_token || '').trim().slice(0, 8000),
        id_token: String(c.id_token || '').trim().slice(0, 8000),
        token_expires_at: String(c.token_expires_at || '').trim(),
        enabled,
        customer_codes,
        customer_names,
        updated_at: String(c.updated_at || '').trim() || new Date().toISOString(),
    };
}

function publicRaiffCredential(c) {
    const n = normalizeRaiffCredential(c);
    return {
        id: n.id,
        label: n.label,
        enabled: n.enabled,
        client_id: n.client_id,
        client_secret_mask: maskSecret(n.client_secret),
        refresh_token_mask: maskSecret(n.refresh_token),
        configured: Boolean(n.client_id && n.client_secret && n.refresh_token),
        has_access: Boolean(n.access_token && n.id_token),
        token_expires_at: n.token_expires_at,
        customer_codes: n.customer_codes,
        customer_names: n.customer_names,
        updated_at: n.updated_at,
    };
}

function parseRaiffCredentialsJson(raw) {
    const s = String(raw || '').trim();
    if (!s) return [];
    try {
        const parsed = JSON.parse(s);
        if (!Array.isArray(parsed)) return [];
        return parsed.map(normalizeRaiffCredential).filter((c) => c.id);
    } catch (e) {
        return [];
    }
}

async function loadRaiffeisenCredentials(db, appSettings) {
    return parseRaiffCredentialsJson(
        (appSettings && appSettings[RAIFF_CREDENTIALS_KEY]) || (await getSetting(db, RAIFF_CREDENTIALS_KEY))
    );
}

async function saveRaiffeisenCredentials(db, appSettings, list) {
    const normalized = (Array.isArray(list) ? list : []).map(normalizeRaiffCredential);
    await setSetting(db, appSettings, RAIFF_CREDENTIALS_KEY, JSON.stringify(normalized));
    return normalized;
}

function enabledRaiffeisen(list) {
    return (list || []).filter(
        (c) =>
            c &&
            c.enabled !== false &&
            String(c.client_id || '').trim() &&
            String(c.client_secret || '').trim() &&
            String(c.refresh_token || '').trim()
    );
}

function normalizeTbankCredential(raw) {
    const c = raw && typeof raw === 'object' ? raw : {};
    const id = String(c.id || '').trim() || newTbankCredId();
    const enabled = c.enabled !== false && c.enabled !== 0 && c.enabled !== '0';
    const customer_codes = Array.isArray(c.customer_codes)
        ? c.customer_codes.map((x) => String(x || '').trim()).filter(Boolean)
        : [];
    const customer_names = Array.isArray(c.customer_names)
        ? c.customer_names.map((x) => String(x || '').trim()).filter(Boolean)
        : [];
    return {
        id,
        label: String(c.label || '').trim().slice(0, 120) || 'Т‑Банк',
        token: String(c.token || '').trim().slice(0, 8000),
        enabled,
        customer_codes,
        customer_names,
        updated_at: String(c.updated_at || '').trim() || new Date().toISOString(),
    };
}

function publicTbankCredential(c) {
    const n = normalizeTbankCredential(c);
    return {
        id: n.id,
        label: n.label,
        enabled: n.enabled,
        token_mask: maskSecret(n.token),
        token_len: n.token.length,
        configured: Boolean(n.token),
        customer_codes: n.customer_codes,
        customer_names: n.customer_names,
        updated_at: n.updated_at,
    };
}

function parseTbankCredentialsJson(raw) {
    const s = String(raw || '').trim();
    if (!s) return [];
    try {
        const parsed = JSON.parse(s);
        if (!Array.isArray(parsed)) return [];
        return parsed.map(normalizeTbankCredential).filter((c) => c.id);
    } catch (e) {
        return [];
    }
}

async function loadTbankCredentials(db, appSettings) {
    return parseTbankCredentialsJson(
        (appSettings && appSettings[TBANK_CREDENTIALS_KEY]) || (await getSetting(db, TBANK_CREDENTIALS_KEY))
    );
}

async function saveTbankCredentials(db, appSettings, list) {
    const normalized = (Array.isArray(list) ? list : []).map(normalizeTbankCredential);
    await setSetting(db, appSettings, TBANK_CREDENTIALS_KEY, JSON.stringify(normalized));
    return normalized;
}

function enabledTbank(list) {
    return (list || []).filter((c) => c && c.enabled !== false && String(c.token || '').trim());
}

async function saveOrgAliases(db, appSettings, map) {
    const clean = parseOrgAliases(JSON.stringify(map || {}));
    await setSetting(db, appSettings, ORG_ALIASES_KEY, JSON.stringify(clean));
    return clean;
}

module.exports = {
    JWT_LEGACY_KEY,
    CREDENTIALS_KEY,
    RAIFF_CREDENTIALS_KEY,
    TBANK_CREDENTIALS_KEY,
    ORG_ALIASES_KEY,
    maskSecret,
    normalizeCurrency,
    newCredId,
    newRaiffCredId,
    newTbankCredId,
    normalizeCredential,
    publicCredential,
    loadCredentials,
    saveCredentials,
    enabledWithJwt,
    normalizeRaiffCredential,
    publicRaiffCredential,
    loadRaiffeisenCredentials,
    saveRaiffeisenCredentials,
    enabledRaiffeisen,
    normalizeTbankCredential,
    publicTbankCredential,
    loadTbankCredentials,
    saveTbankCredentials,
    enabledTbank,
    parseOrgAliases,
    orgAliasFull,
    orgAliasShort,
    loadOrgAliases,
    saveOrgAliases,
    getSetting,
    setSetting,
};
