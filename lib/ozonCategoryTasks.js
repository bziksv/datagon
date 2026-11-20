'use strict';

/**
 * Задачи на смену категории Ozon для внешнего бота (публичная ссылка: токен + мини-пароль).
 * Список — проблемные группы склейки, где категория не поддерживает 9048 и вариативные
 * характеристики; бот меняет категорию в кабинете Ozon и пишет комментарий.
 */

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { axiosWithMarketplaceRateLimit, createMarketplaceLogger } = require('./marketplaceExports');
const { ozonHeaders } = require('./ozonProductDimsUpdate');
const {
    ensureOzonMergeTables,
    appendOzonMergeLog,
    fetchOzonCategoryAttributes,
    OZON_PROBLEM_CATEGORY_NO_MERGE,
} = require('./ozonProductMerge');

const SETTING_TOKEN = 'ozon_category_tasks_token';
const SETTING_PIN = 'ozon_category_tasks_pin_secret';
const COOKIE_NAME = 'dg_oct';
const COOKIE_PATH = '/public/ozon-category-tasks';
const COOKIE_TTL_MS = 12 * 60 * 60 * 1000;
const PIN_MAX_FAILS = 5;
const PIN_WINDOW_MS = 15 * 60 * 1000;
const COMMENT_MAX = 1000;
const AUTHOR_MAX = 100;
const TREE_TTL_MS = 24 * 60 * 60 * 1000;
const SUGGEST_TTL_MS = 24 * 60 * 60 * 1000;
const LIVE_TTL_MS = 2 * 60 * 1000;

let settingsCache = { ts: 0, values: null };
const pinFails = new Map();
let treeCache = { ts: 0, types: null };
const suggestCache = new Map();
let liveCache = { ts: 0, key: '', byOffer: null };

async function readSettings(db, force) {
    if (!force && settingsCache.values && Date.now() - settingsCache.ts < 10000) {
        return settingsCache.values;
    }
    const [rows] = await db.query(
        `SELECT setting_key, setting_value FROM app_settings
          WHERE setting_key IN (?, ?, 'ozon_client_id', 'ozon_api_key')`,
        [SETTING_TOKEN, SETTING_PIN]
    );
    const m = {};
    for (const r of rows || []) m[r.setting_key] = String(r.setting_value == null ? '' : r.setting_value);
    const values = {
        token: String(m[SETTING_TOKEN] || '').trim(),
        pinHash: String(m[SETTING_PIN] || '').trim(),
        creds: {
            clientId: String(m.ozon_client_id || '').trim(),
            apiKey: String(m.ozon_api_key || '').trim(),
        },
    };
    settingsCache = { ts: Date.now(), values };
    return values;
}

async function writeSetting(db, key, value) {
    await db.query(
        `INSERT INTO app_settings (setting_key, setting_value) VALUES (?, ?)
         ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)`,
        [key, value]
    );
    settingsCache = { ts: 0, values: null };
}

function generateToken() {
    return crypto.randomBytes(24).toString('base64url');
}

function sha(s) {
    return crypto.createHash('sha256').update(String(s)).digest();
}

function tokenMatches(expected, given) {
    if (!expected || !given) return false;
    return crypto.timingSafeEqual(sha(expected), sha(given));
}

/** Конфиг для админки: токен целиком (нужен для ссылки), пароль — только факт наличия. */
async function getConfig(db) {
    const s = await readSettings(db, true);
    return { token: s.token, has_pin: Boolean(s.pinHash) };
}

async function saveConfig(db, { token, pin }) {
    if (token !== undefined) {
        const t = String(token || '').trim();
        if (t && t.length < 24) {
            const err = new Error('Токен короче 24 символов — сгенерируйте новый');
            err.code = 'TOKEN_TOO_SHORT';
            throw err;
        }
        await writeSetting(db, SETTING_TOKEN, t);
    }
    if (pin !== undefined && String(pin).trim() !== '') {
        const p = String(pin).trim();
        if (p.length < 4 || p.length > 64) {
            const err = new Error('Пароль: от 4 до 64 символов');
            err.code = 'PIN_INVALID';
            throw err;
        }
        await writeSetting(db, SETTING_PIN, await bcrypt.hash(p, 10));
    }
    return getConfig(db);
}

function pinBlockedFor(ip) {
    const rec = pinFails.get(ip);
    if (!rec) return 0;
    const now = Date.now();
    rec.fails = rec.fails.filter((ts) => now - ts < PIN_WINDOW_MS);
    if (rec.blockedUntil && rec.blockedUntil > now) return Math.ceil((rec.blockedUntil - now) / 1000);
    if (!rec.fails.length) pinFails.delete(ip);
    return 0;
}

function registerPinFail(ip) {
    const now = Date.now();
    const rec = pinFails.get(ip) || { fails: [], blockedUntil: 0 };
    rec.fails = rec.fails.filter((ts) => now - ts < PIN_WINDOW_MS);
    rec.fails.push(now);
    if (rec.fails.length >= PIN_MAX_FAILS) rec.blockedUntil = now + PIN_WINDOW_MS;
    pinFails.set(ip, rec);
}

function cookieKey(s) {
    return `${s.token}|${s.pinHash}`;
}

function signCookie(s, exp) {
    return crypto.createHmac('sha256', cookieKey(s)).update(String(exp)).digest('base64url');
}

function buildSessionCookie(s, secure) {
    const exp = Date.now() + COOKIE_TTL_MS;
    const val = `${exp}.${signCookie(s, exp)}`;
    return (
        `${COOKIE_NAME}=${val}; Path=${COOKIE_PATH}; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(COOKIE_TTL_MS / 1000)}` +
        (secure ? '; Secure' : '')
    );
}

function readCookie(req) {
    const raw = String((req.headers && req.headers.cookie) || '');
    for (const part of raw.split(';')) {
        const i = part.indexOf('=');
        if (i < 0) continue;
        if (part.slice(0, i).trim() === COOKIE_NAME) return decodeURIComponent(part.slice(i + 1).trim());
    }
    return '';
}

function cookieValid(s, value) {
    const [expRaw, sig] = String(value || '').split('.');
    const exp = Number(expRaw);
    if (!Number.isFinite(exp) || exp < Date.now() || !sig) return false;
    const want = signCookie(s, exp);
    return want.length === sig.length && crypto.timingSafeEqual(Buffer.from(want), Buffer.from(sig));
}

/**
 * Проверка доступа. Возвращает { ok, status, code, error, settings }.
 * Без токена / с неверным — 404 (страницу не раскрываем); без пароля — 401.
 */
async function checkAccess(db, req, { pin } = {}) {
    const s = await readSettings(db);
    const given = String((req.query && req.query.token) || '').trim();
    if (!s.token || !tokenMatches(s.token, given)) {
        return { ok: false, status: 404, code: 'NOT_FOUND', error: 'Не найдено' };
    }
    if (!s.pinHash) {
        return { ok: false, status: 503, code: 'PIN_NOT_CONFIGURED', error: 'Пароль доступа не задан в настройках Datagon' };
    }
    if (cookieValid(s, readCookie(req))) return { ok: true, settings: s };
    const ip = String(req.ip || (req.socket && req.socket.remoteAddress) || 'unknown');
    const blocked = pinBlockedFor(ip);
    if (blocked) {
        return {
            ok: false,
            status: 429,
            code: 'PIN_BLOCKED',
            error: `Слишком много неверных паролей. Повторите через ${Math.ceil(blocked / 60)} мин.`,
        };
    }
    const pinGiven = String(pin || req.get('x-datagon-pin') || '').trim();
    if (!pinGiven) return { ok: false, status: 401, code: 'PIN_REQUIRED', error: 'Нужен пароль' };
    if (!(await bcrypt.compare(pinGiven, s.pinHash))) {
        registerPinFail(ip);
        return { ok: false, status: 401, code: 'PIN_INVALID', error: 'Неверный пароль' };
    }
    pinFails.delete(ip);
    return { ok: true, settings: s, pinAccepted: true };
}

/* ---------- Дерево категорий Ozon и подбор подходящих ---------- */

async function loadCategoryTypes(creds, logger) {
    if (treeCache.types && Date.now() - treeCache.ts < TREE_TTL_MS) return treeCache.types;
    const res = await axiosWithMarketplaceRateLimit(
        {
            method: 'POST',
            url: 'https://api-seller.ozon.ru/v1/description-category/tree',
            data: { language: 'DEFAULT' },
            headers: ozonHeaders(creds),
            timeout: 60000,
        },
        logger,
        { maxAttempts: 3 }
    );
    const types = [];
    const walk = (nodes, trail, cid) => {
        for (const n of nodes || []) {
            const name = String(n.category_name || n.type_name || '').trim();
            const catId = Number(n.description_category_id || cid || 0);
            if (n.type_id && !n.disabled) {
                types.push({
                    description_category_id: catId,
                    type_id: Number(n.type_id),
                    type_name: name,
                    path: [...trail, name],
                });
            }
            if (Array.isArray(n.children) && n.children.length) walk(n.children, [...trail, name], catId);
        }
    };
    walk((res.data && res.data.result) || [], [], 0);
    treeCache = { ts: Date.now(), types };
    return types;
}

const STOP_WORDS = new Set(['набор', 'для', 'шт', 'уп', 'упак', 'штук', 'размер', 'см', 'мм', 'мл', 'тип', 'вид']);

function nameStems(text) {
    const out = new Set();
    for (const w of String(text || '').toLowerCase().replace(/ё/g, 'е').split(/[^a-zа-я]+/)) {
        if (w.length < 4 || STOP_WORDS.has(w)) continue;
        out.add(w.slice(0, Math.min(w.length, 6)));
    }
    return out;
}

/**
 * Подбор категорий, где есть 9048 и вариативные характеристики: совпадение основ слов
 * из названия товара и текущего типа с названием типа (×3) и путём (×1), +1 за ту же
 * верхнюю ветку дерева. Проверяются атрибуты у 15 лучших, в ответе — до 5.
 */
async function suggestCategories(creds, { names, current }, logger) {
    const cacheKey = `${current && current.type_id}|${names.join('|').slice(0, 300)}`;
    const cached = suggestCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < SUGGEST_TTL_MS) return cached.list;
    const types = await loadCategoryTypes(creds, logger);
    const nameSt = nameStems(names.join(' '));
    const typeSt = nameStems(current && current.type_name);
    const topBranch = current && current.path ? current.path[0] : '';
    const scored = [];
    for (const t of types) {
        if (current && t.type_id === current.type_id && t.description_category_id === current.description_category_id) continue;
        const typeWords = t.type_name.toLowerCase().replace(/ё/g, 'е');
        const pathWords = t.path.join(' ').toLowerCase().replace(/ё/g, 'е');
        let score = 0;
        for (const s of nameSt) {
            if (typeWords.includes(s)) score += 3;
            else if (pathWords.includes(s)) score += 1;
        }
        for (const s of typeSt) {
            if (!nameSt.has(s) && typeWords.includes(s)) score += 1;
        }
        if (!score) continue;
        const sameBranch = Boolean(topBranch && t.path[0] === topBranch);
        if (sameBranch) score += 2;
        scored.push({ t, score, sameBranch });
    }
    scored.sort((a, b) => b.sameBranch - a.sameBranch || b.score - a.score);
    const pool = scored.some((x) => x.sameBranch) ? scored.filter((x) => x.sameBranch) : scored;
    const list = [];
    for (const { t, score } of pool.slice(0, 15)) {
        const attrs = await fetchOzonCategoryAttributes(creds, t.description_category_id, t.type_id, logger);
        const has9048 = attrs.some((a) => Number(a.id) === 9048);
        const aspects = attrs.filter((a) => a && a.is_aspect).map((a) => String(a.name || '').trim());
        if (!has9048 || !aspects.length) continue;
        list.push({
            description_category_id: t.description_category_id,
            type_id: t.type_id,
            type_name: t.type_name,
            path: t.path.join(' → '),
            aspects,
            score,
        });
        if (list.length >= 5) break;
    }
    suggestCache.set(cacheKey, { ts: Date.now(), list });
    return list;
}

/* ---------- Список задач ---------- */

async function fetchLiveCards(creds, offerIds, logger) {
    const key = offerIds.slice().sort().join(',');
    if (liveCache.byOffer && liveCache.key === key && Date.now() - liveCache.ts < LIVE_TTL_MS) {
        return liveCache.byOffer;
    }
    const byOffer = new Map();
    for (let i = 0; i < offerIds.length; i += 100) {
        const res = await axiosWithMarketplaceRateLimit(
            {
                method: 'POST',
                url: 'https://api-seller.ozon.ru/v3/product/info/list',
                data: { offer_id: offerIds.slice(i, i + 100) },
                headers: ozonHeaders(creds),
                timeout: 60000,
            },
            logger,
            { maxAttempts: 3 }
        );
        for (const it of (res.data && res.data.items) || []) {
            byOffer.set(String(it.offer_id), it);
        }
    }
    liveCache = { ts: Date.now(), key, byOffer };
    return byOffer;
}

function parseCodes(raw) {
    try {
        const v = JSON.parse(raw || '[]');
        return Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : [];
    } catch (_) {
        return [];
    }
}

function fmtDateTime(d) {
    if (!d) return '';
    const dt = d instanceof Date ? d : new Date(d);
    if (Number.isNaN(dt.getTime())) return '';
    const p = (n) => String(n).padStart(2, '0');
    return `${p(dt.getDate())}-${p(dt.getMonth() + 1)}-${dt.getFullYear()} ${p(dt.getHours())}:${p(dt.getMinutes())}`;
}

/** Комментарии по категории для админки (без обращений к Ozon). */
async function loadCategoryCommentsBySignature(db) {
    await ensureOzonMergeTables(db);
    const [rows] = await db.query(
        `SELECT group_signature, problem_code, category_comment, category_comment_by, category_comment_at
           FROM dg_ozon_merge_decisions
          WHERE problem_code = ? OR category_comment IS NOT NULL`,
        [OZON_PROBLEM_CATEGORY_NO_MERGE]
    );
    const map = new Map();
    for (const r of rows || []) {
        map.set(String(r.group_signature), {
            problem_code: r.problem_code || '',
            comment: r.category_comment || '',
            by: r.category_comment_by || '',
            at: fmtDateTime(r.category_comment_at),
        });
    }
    return map;
}

async function listCategoryTasks(db, { withSuggestions = true } = {}) {
    await ensureOzonMergeTables(db);
    const s = await readSettings(db);
    const [rows] = await db.query(
        `SELECT group_signature, main_offer_id, group_title, codes_json,
                category_comment, category_comment_by, category_comment_at, updated_at
           FROM dg_ozon_merge_decisions
          WHERE status = 'failed' AND problem_code = ? AND comment LIKE '%атрибут 9048%'
          ORDER BY updated_at DESC
          LIMIT 300`,
        [OZON_PROBLEM_CATEGORY_NO_MERGE]
    );
    const logger = createMarketplaceLogger('ozon-category-tasks');
    const allCodes = Array.from(new Set((rows || []).flatMap((r) => parseCodes(r.codes_json))));
    let live = new Map();
    let types = [];
    const canOzon = s.creds.clientId && s.creds.apiKey;
    if (canOzon && allCodes.length) {
        try {
            live = await fetchLiveCards(s.creds, allCodes, logger);
        } catch (e) {
            logger.log('live_fail', { message: e && e.message });
        }
        try {
            types = await loadCategoryTypes(s.creds, logger);
        } catch (e) {
            logger.log('tree_fail', { message: e && e.message });
        }
    }
    const typeByKey = new Map(types.map((t) => [`${t.description_category_id}:${t.type_id}`, t]));

    const out = [];
    for (const r of rows || []) {
        const codes = parseCodes(r.codes_json);
        const items = codes.map((code) => {
            const it = live.get(code) || {};
            const sku = Number(
                (Array.isArray(it.sources) && it.sources[0] && it.sources[0].sku) || it.sku || 0
            ) || null;
            return {
                offer_id: code,
                name: String(it.name || ''),
                product_id: it.id || null,
                sku,
                ozon_url: sku ? `https://www.ozon.ru/product/${sku}/` : '',
                description_category_id: Number(it.description_category_id || 0) || null,
                type_id: Number(it.type_id || 0) || null,
            };
        });
        const main = items.find((x) => x.offer_id === r.main_offer_id) || items[0] || {};
        const t = typeByKey.get(`${main.description_category_id}:${main.type_id}`);
        const current = {
            description_category_id: main.description_category_id || null,
            type_id: main.type_id || null,
            type_name: t ? t.type_name : '',
            path: t ? t.path.join(' → ') : '',
        };
        const sameCategory = items.every(
            (x) => x.type_id === main.type_id && x.description_category_id === main.description_category_id
        );
        let suggested = [];
        if (withSuggestions && canOzon && t) {
            try {
                suggested = await suggestCategories(
                    s.creds,
                    { names: items.map((x) => x.name).filter(Boolean), current: t },
                    logger
                );
            } catch (e) {
                logger.log('suggest_fail', { message: e && e.message });
            }
        }
        out.push({
            signature: r.group_signature,
            main_offer_id: r.main_offer_id,
            title: r.group_title || main.name || r.main_offer_id,
            items,
            current_category: current,
            items_same_category: sameCategory,
            suggested_categories: suggested,
            category_comment: r.category_comment || '',
            category_comment_by: r.category_comment_by || '',
            category_comment_at: fmtDateTime(r.category_comment_at),
            failed_at: fmtDateTime(r.updated_at),
        });
    }
    return { success: true, total: out.length, rows: out };
}

async function saveCategoryComment(db, { signature, comment, author }) {
    await ensureOzonMergeTables(db);
    const sig = String(signature || '').trim().slice(0, 255);
    const text = String(comment || '').trim();
    const who = String(author || '').trim().slice(0, AUTHOR_MAX) || 'бот';
    if (!sig) {
        const err = new Error('Не передан signature группы');
        err.code = 'SIGNATURE_REQUIRED';
        throw err;
    }
    if (!text) {
        const err = new Error('Пустой комментарий');
        err.code = 'COMMENT_REQUIRED';
        throw err;
    }
    if (text.length > COMMENT_MAX) {
        const err = new Error(`Комментарий длиннее ${COMMENT_MAX} символов`);
        err.code = 'COMMENT_TOO_LONG';
        throw err;
    }
    const [[row]] = await db.query(
        `SELECT group_signature, main_offer_id, category_comment FROM dg_ozon_merge_decisions
          WHERE group_signature = ? AND problem_code = ? LIMIT 1`,
        [sig, OZON_PROBLEM_CATEGORY_NO_MERGE]
    );
    if (!row) {
        const err = new Error('Группа не найдена среди задач на смену категории');
        err.code = 'TASK_NOT_FOUND';
        throw err;
    }
    await db.query(
        `UPDATE dg_ozon_merge_decisions
            SET category_comment = ?, category_comment_by = ?, category_comment_at = NOW(),
                updated_at = updated_at
          WHERE group_signature = ?`,
        [text, who, sig]
    );
    await appendOzonMergeLog(db, {
        group_signature: sig,
        offer_id: row.main_offer_id || '',
        action: 'category_comment',
        field: 'category_comment',
        field_label: 'Комментарий по категории Ozon',
        old_value: row.category_comment || null,
        new_value: text,
        note: `Публичная ссылка для бота · ${who}`,
        changed_by_name: who,
    });
    const [[saved]] = await db.query(
        `SELECT category_comment, category_comment_by, category_comment_at
           FROM dg_ozon_merge_decisions WHERE group_signature = ?`,
        [sig]
    );
    return {
        success: true,
        signature: sig,
        category_comment: saved.category_comment || '',
        category_comment_by: saved.category_comment_by || '',
        category_comment_at: fmtDateTime(saved.category_comment_at),
    };
}

module.exports = {
    COOKIE_NAME,
    COOKIE_PATH,
    generateToken,
    getConfig,
    saveConfig,
    checkAccess,
    buildSessionCookie,
    listCategoryTasks,
    saveCategoryComment,
    loadCategoryCommentsBySignature,
    suggestCategories,
    nameStems,
    _resetForTests() {
        pinFails.clear();
        settingsCache = { ts: 0, values: null };
    },
};
