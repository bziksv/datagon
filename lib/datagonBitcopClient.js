'use strict';

/**
 * Клиент Bitcop Web API (https://bitcop.ru/guide/api).
 * База: https://{account}.bitcop.ru:4443/api/v1/
 */

const axios = require('axios');

const SETTINGS_KEYS = {
    account: 'ws_bitcop_account',
    apiKey: 'ws_bitcop_api_key',
    /** productiveTime | activeTime | totalTime — что пишем в часы табеля */
    metric: 'ws_bitcop_metric',
};

function maskSecret(s) {
    const t = String(s || '');
    if (!t) return '';
    if (t.length <= 8) return '••••';
    return `${t.slice(0, 4)}…${t.slice(-4)} (${t.length} симв.)`;
}

function normalizeAccount(raw) {
    let s = String(raw || '')
        .trim()
        .toLowerCase()
        .replace(/^https?:\/\//, '')
        .replace(/\.bitcop\.ru.*$/i, '')
        .replace(/\/.*$/, '')
        .replace(/:.*$/, '');
    if (!/^[a-z0-9][a-z0-9_-]{0,62}$/i.test(s)) return '';
    return s;
}

function normalizeMetric(raw) {
    const m = String(raw || 'productiveTime').trim();
    if (m === 'activeTime' || m === 'totalTime' || m === 'productiveTime') return m;
    return 'productiveTime';
}

async function loadBitcopSettings(db) {
    const keys = Object.values(SETTINGS_KEYS);
    const [rows] = await db.query(
        `SELECT setting_key, setting_value FROM app_settings WHERE setting_key IN (?)`,
        [keys]
    );
    const map = {};
    for (const r of rows || []) map[r.setting_key] = r.setting_value;
    return {
        account: normalizeAccount(map[SETTINGS_KEYS.account] || ''),
        api_key: String(map[SETTINGS_KEYS.apiKey] || ''),
        metric: normalizeMetric(map[SETTINGS_KEYS.metric]),
    };
}

async function saveBitcopSettings(db, { account, api_key, metric, clear_api_key }) {
    const acc = normalizeAccount(account);
    if (!acc) {
        const err = new Error('Укажите имя аккаунта Bitcop (поддомен)');
        err.code = 'BITCOP_BAD_ACCOUNT';
        throw err;
    }
    const met = normalizeMetric(metric);
    const upsert = async (key, value) => {
        await db.query(
            `INSERT INTO app_settings (setting_key, setting_value) VALUES (?, ?)
             ON DUPLICATE KEY UPDATE setting_value=VALUES(setting_value)`,
            [key, value == null ? '' : String(value)]
        );
    };
    await upsert(SETTINGS_KEYS.account, acc);
    await upsert(SETTINGS_KEYS.metric, met);
    if (clear_api_key) {
        await upsert(SETTINGS_KEYS.apiKey, '');
    } else if (api_key != null && String(api_key).trim() !== '') {
        await upsert(SETTINGS_KEYS.apiKey, String(api_key).trim());
    }
    return loadBitcopSettings(db);
}

function baseUrl(account) {
    const acc = normalizeAccount(account);
    if (!acc) {
        const err = new Error('Bitcop: не задан аккаунт');
        err.code = 'BITCOP_NO_ACCOUNT';
        throw err;
    }
    return `https://${acc}.bitcop.ru:4443/api/v1`;
}

/**
 * @param {string} ymd YYYY-MM-DD
 * @returns {string} YYYYMMDD
 */
function ymdToBitcopDate(ymd) {
    return String(ymd || '').replace(/-/g, '').slice(0, 8);
}

/**
 * Сутки [day, day+1) в формате Bitcop begin/end.
 * @param {string} ymd YYYY-MM-DD
 */
function dayRangeBitcop(ymd) {
    const d = String(ymd || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) {
        const err = new Error('bad date');
        err.code = 'BITCOP_BAD_DATE';
        throw err;
    }
    const [y, m, day] = d.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, day));
    const next = new Date(dt.getTime() + 86400000);
    const fmt = (x) => {
        const yy = x.getUTCFullYear();
        const mm = String(x.getUTCMonth() + 1).padStart(2, '0');
        const dd = String(x.getUTCDate()).padStart(2, '0');
        return `${yy}${mm}${dd}`;
    };
    return { begin: fmt(dt), end: fmt(next) };
}

async function bitcopGet(dbOrCfg, path, query) {
    const cfg = dbOrCfg && dbOrCfg.query ? await loadBitcopSettings(dbOrCfg) : dbOrCfg;
    if (!cfg.account) {
        const err = new Error('Bitcop: не задан аккаунт (настройки графика)');
        err.code = 'BITCOP_NO_ACCOUNT';
        throw err;
    }
    if (!cfg.api_key) {
        const err = new Error('Bitcop: не задан API-ключ');
        err.code = 'BITCOP_NO_KEY';
        throw err;
    }
    const url = `${baseUrl(cfg.account)}${path}`;
    const params = Object.assign({ apikey: cfg.api_key }, query || {});
    try {
        const res = await axios.get(url, {
            params,
            timeout: 45000,
            validateStatus: () => true,
        });
        if (res.status >= 400) {
            const raw =
                typeof res.data === 'string'
                    ? res.data
                    : (res.data && (res.data.message || res.data.error)) || JSON.stringify(res.data || {});
            let hint = String(raw).slice(0, 240);
            if (res.status === 503 || /unavailable/i.test(hint)) {
                hint =
                    'Web API недоступен на стороне Bitcop (HTTP 503). Включите/проверьте API в кабинете Bitcop или повторите позже.';
            }
            const err = new Error(`Bitcop: ${hint}`);
            err.code = 'BITCOP_HTTP';
            err.status = res.status;
            throw err;
        }
        const body = res.data || {};
        if (body.status && body.status !== 'success') {
            const err = new Error(`Bitcop: ${body.message || body.status || 'error'}`);
            err.code = 'BITCOP_API';
            throw err;
        }
        return body;
    } catch (e) {
        if (e.code && String(e.code).startsWith('BITCOP_')) throw e;
        const err = new Error(`Bitcop: ${(e && e.message) || e}`);
        err.code = 'BITCOP_NET';
        throw err;
    }
}

async function listEmployees(db) {
    const body = await bitcopGet(db, '/employees', { active: true });
    const items = Array.isArray(body.items) ? body.items : [];
    return items.map((it) => ({
        id: Number(it.id),
        firstName: it.firstName || '',
        lastName: it.lastName || '',
        email: it.email || '',
        active: !!it.active,
        full_name: [it.lastName, it.firstName].filter(Boolean).join(' ').trim() || `id ${it.id}`,
    }));
}

/**
 * Продуктивность за сутки (или период begin/end Bitcop).
 * @returns {Promise<Map<number, { productiveTime, unproductiveTime, neutralTime, totalTime }>>}
 */
async function fetchProductivityMap(db, { begin, end, employeeIds }) {
    const q = { begin, end };
    if (employeeIds && employeeIds.length) q.employees = employeeIds.join(',');
    const body = await bitcopGet(db, '/productivity', q);
    const map = new Map();
    for (const it of body.items || []) {
        const id = Number(it.id);
        if (!Number.isFinite(id)) continue;
        map.set(id, {
            productiveTime: Number(it.productiveTime) || 0,
            unproductiveTime: Number(it.unproductiveTime) || 0,
            neutralTime: Number(it.neutralTime) || 0,
            totalTime: Number(it.totalTime) || 0,
        });
    }
    return map;
}

/**
 * Активность (activeTime / totalTime) — для метрик не из /productivity.
 */
async function fetchActivityMap(db, { begin, end, employeeIds }) {
    const q = { begin, end };
    if (employeeIds && employeeIds.length) q.employees = employeeIds.join(',');
    const body = await bitcopGet(db, '/activity', q);
    const map = new Map();
    for (const it of body.items || []) {
        const id = Number(it.id);
        if (!Number.isFinite(id)) continue;
        map.set(id, {
            activeTime: Number(it.activeTime) || 0,
            totalTime: Number(it.totalTime) || 0,
            downTime: Number(it.downTime) || 0,
        });
    }
    return map;
}

/** Секунды метрики → часы (2 знака). */
function secondsToHours(sec) {
    const h = (Number(sec) || 0) / 3600;
    return Math.round(h * 100) / 100;
}

function pickMetricSeconds(row, metric) {
    const m = normalizeMetric(metric);
    if (!row) return 0;
    if (m === 'activeTime') return Number(row.activeTime) || 0;
    if (m === 'totalTime') return Number(row.totalTime) || 0;
    return Number(row.productiveTime) || 0;
}

module.exports = {
    SETTINGS_KEYS,
    maskSecret,
    normalizeAccount,
    normalizeMetric,
    loadBitcopSettings,
    saveBitcopSettings,
    baseUrl,
    ymdToBitcopDate,
    dayRangeBitcop,
    bitcopGet,
    listEmployees,
    fetchProductivityMap,
    fetchActivityMap,
    secondsToHours,
    pickMetricSeconds,
};
