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
    buildAutoMergeGroupsList,
    loadCategoryTaskThreads,
    OZON_PROBLEM_CATEGORY_NO_MERGE,
} = require('./ozonProductMerge');

const BATCH_SIZE = 10;
const REFILL_MIN_INTERVAL_MS = 30 * 60 * 1000;
const SCAN_ACTOR = 'Проверка категорий';
/** Состояние задачи: '' — в работе, done — категория сменена и проверена, skipped — бот не смог. */
const STATE_OPEN = '';
const STATE_DONE = 'done';
const STATE_SKIPPED = 'skipped';
/** needs_info — бот ждёт ответа человека; answered — человек ответил, задача снова у бота (первой в пачке). */
const STATE_NEEDS_INFO = 'needs_info';
const STATE_ANSWERED = 'answered';
const ACTIVE_STATES = [STATE_OPEN, STATE_ANSWERED, STATE_NEEDS_INFO];

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

async function fetchLiveCards(creds, offerIds, logger, { force = false } = {}) {
    const key = offerIds.slice().sort().join(',');
    if (!force && liveCache.byOffer && liveCache.key === key && Date.now() - liveCache.ts < LIVE_TTL_MS) {
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

async function countTasks(db) {
    await ensureOzonMergeTables(db);
    const [rows] = await db.query(
        `SELECT category_task_state AS state, COUNT(*) AS cnt
           FROM dg_ozon_merge_decisions
          WHERE problem_code = ? OR category_task_state = ?
          GROUP BY category_task_state`,
        [OZON_PROBLEM_CATEGORY_NO_MERGE, STATE_DONE]
    );
    const c = { open: 0, answered: 0, needs_info: 0, done: 0, skipped: 0 };
    for (const r of rows || []) {
        const st = String(r.state || '');
        const n = Number(r.cnt) || 0;
        if (st === STATE_DONE) c.done += n;
        else if (st === STATE_SKIPPED) c.skipped += n;
        else if (st === STATE_NEEDS_INFO) c.needs_info += n;
        else {
            c.open += n;
            if (st === STATE_ANSWERED) c.answered += n;
        }
    }
    return c;
}

function threadForOutput(list) {
    return (list || []).map((m) => ({
        id: m.id,
        role: m.role,
        kind: m.kind,
        author: m.author,
        body: m.body,
        at: fmtDateTime(m.created_at),
    }));
}

const TASK_COLUMNS = `group_signature, main_offer_id, group_title, codes_json, category_task_state,
                category_comment, category_comment_by, category_comment_at,
                category_check_note, category_checked_at, updated_at`;

/**
 * Пачка для бота: до BATCH_SIZE открытых задач — сначала с ответом человека, затем старые.
 * Отдельно — задачи, где бот ждёт ответа (`waiting_answer`), без подбора категорий.
 */
async function listCategoryTasks(db, { withSuggestions = true, autoRefill = false } = {}) {
    await ensureOzonMergeTables(db);
    const s = await readSettings(db);
    const [rows] = await db.query(
        `SELECT ${TASK_COLUMNS}
           FROM dg_ozon_merge_decisions
          WHERE status = 'failed' AND problem_code = ? AND category_task_state IN (?, ?)
          ORDER BY (category_task_state = ?) DESC, updated_at ASC, group_signature ASC
          LIMIT ?`,
        [OZON_PROBLEM_CATEGORY_NO_MERGE, STATE_OPEN, STATE_ANSWERED, STATE_ANSWERED, BATCH_SIZE]
    );
    const [waitRows] = await db.query(
        `SELECT ${TASK_COLUMNS}
           FROM dg_ozon_merge_decisions
          WHERE status = 'failed' AND problem_code = ? AND category_task_state = ?
          ORDER BY updated_at ASC
          LIMIT 50`,
        [OZON_PROBLEM_CATEGORY_NO_MERGE, STATE_NEEDS_INFO]
    );
    const counts = await countTasks(db);
    if (autoRefill && counts.open < BATCH_SIZE) startRefill(db);
    const logger = createMarketplaceLogger('ozon-category-tasks');
    const allRows = [...(rows || []), ...(waitRows || [])];
    const allCodes = Array.from(new Set(allRows.flatMap((r) => parseCodes(r.codes_json))));
    const threads = await loadCategoryTaskThreads(db, allRows.map((r) => r.group_signature));
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

    const buildRow = async (r, suggest) => {
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
        if (suggest && canOzon && t) {
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
        return {
            signature: r.group_signature,
            main_offer_id: r.main_offer_id,
            title: r.group_title || main.name || r.main_offer_id,
            state: r.category_task_state || '',
            items,
            current_category: current,
            items_same_category: sameCategory,
            suggested_categories: suggested,
            thread: threadForOutput(threads.get(String(r.group_signature))),
            category_comment: r.category_comment || '',
            category_comment_by: r.category_comment_by || '',
            category_comment_at: fmtDateTime(r.category_comment_at),
            check_note: r.category_check_note || '',
            checked_at: fmtDateTime(r.category_checked_at),
            failed_at: fmtDateTime(r.updated_at),
        };
    };

    const out = [];
    for (const r of rows || []) out.push(await buildRow(r, withSuggestions));
    const waiting = [];
    for (const r of waitRows || []) waiting.push(await buildRow(r, false));
    return {
        success: true,
        total: out.length,
        batch_size: BATCH_SIZE,
        queue: {
            open: counts.open,
            answered: counts.answered,
            waiting: Math.max(0, counts.open - out.length),
            needs_info: counts.needs_info,
            done: counts.done,
            skipped: counts.skipped,
        },
        refill: refillStatus(),
        rows: out,
        waiting_answer: waiting,
    };
}

async function addThreadEntry(db, { signature, role, kind, author, body }) {
    await db.query(
        `INSERT INTO dg_ozon_category_task_comments (group_signature, role, kind, author, body)
         VALUES (?, ?, ?, ?, ?)`,
        [signature, role, kind, String(author || '').slice(0, 191), body]
    );
}

function validateText(text, emptyMsg) {
    const t = String(text || '').trim();
    if (!t) throw taskError(emptyMsg, 'COMMENT_REQUIRED');
    if (t.length > COMMENT_MAX) throw taskError(`Текст длиннее ${COMMENT_MAX} символов`, 'COMMENT_TOO_LONG');
    return t;
}

/** Бот просит уточнение: вопрос в историю, задача уходит из пачки во вкладку «Бот просит уточнить». */
async function requestClarification(db, { signature, question, author }) {
    await ensureOzonMergeTables(db);
    const row = await loadTaskRow(db, signature);
    const text = validateText(question, 'Напишите, что именно нужно уточнить');
    const who = String(author || '').trim().slice(0, AUTHOR_MAX) || 'бот';
    await addThreadEntry(db, { signature: row.group_signature, role: 'bot', kind: 'question', author: who, body: text });
    await db.query(
        `UPDATE dg_ozon_merge_decisions
            SET category_task_state = ?, category_comment = ?, category_comment_by = ?, category_comment_at = NOW(),
                updated_at = updated_at
          WHERE group_signature = ?`,
        [STATE_NEEDS_INFO, text, who, row.group_signature]
    );
    await appendOzonMergeLog(db, {
        group_signature: row.group_signature,
        offer_id: row.main_offer_id || '',
        action: 'category_question',
        field: 'category_task',
        field_label: 'Бот просит уточнить',
        old_value: null,
        new_value: text,
        note: `Публичная ссылка для бота · ${who}`,
        changed_by_name: who,
    });
    const counts = await countTasks(db);
    if (counts.open < BATCH_SIZE) startRefill(db);
    return { success: true, signature: row.group_signature, state: STATE_NEEDS_INFO, queue: counts };
}

/** Ответ человека из админки: в историю, задача возвращается боту первой в пачке. */
async function answerClarification(db, { signature, answer, author, userId }) {
    await ensureOzonMergeTables(db);
    const sig = String(signature || '').trim().slice(0, 255);
    const [[row]] = await db.query(
        `SELECT group_signature, main_offer_id, category_task_state FROM dg_ozon_merge_decisions
          WHERE group_signature = ? LIMIT 1`,
        [sig]
    );
    if (!row) throw taskError('Группа не найдена', 'TASK_NOT_FOUND');
    const text = validateText(answer, 'Пустой ответ');
    const who = String(author || '').trim().slice(0, AUTHOR_MAX) || 'сотрудник';
    await addThreadEntry(db, { signature: sig, role: 'human', kind: 'answer', author: who, body: text });
    const wasWaiting = String(row.category_task_state || '') === STATE_NEEDS_INFO;
    if (wasWaiting) {
        await db.query(
            `UPDATE dg_ozon_merge_decisions SET category_task_state = ?, updated_at = updated_at WHERE group_signature = ?`,
            [STATE_ANSWERED, sig]
        );
    }
    await appendOzonMergeLog(db, {
        group_signature: sig,
        offer_id: row.main_offer_id || '',
        action: 'category_answer',
        field: 'category_task',
        field_label: 'Ответ боту по категории',
        old_value: null,
        new_value: text,
        note: wasWaiting ? 'Задача возвращена боту' : 'Комментарий для бота',
        changed_by_user_id: userId || null,
        changed_by_name: who,
    });
    const [[st]] = await db.query(
        `SELECT category_task_state FROM dg_ozon_merge_decisions WHERE group_signature = ?`,
        [sig]
    );
    const threads = await loadCategoryTaskThreads(db, [sig]);
    return {
        success: true,
        signature: sig,
        state: (st && st.category_task_state) || '',
        returned_to_bot: wasWaiting,
        thread: threadForOutput(threads.get(sig)),
    };
}

/* ---------- Проверка, пропуск, пополнение очереди ---------- */

function taskError(message, code) {
    const err = new Error(message);
    err.code = code;
    return err;
}

/** Задача, с которой бот ещё может работать (в пачке, с ответом или в ожидании ответа). */
async function loadTaskRow(db, signature) {
    const sig = String(signature || '').trim().slice(0, 255);
    if (!sig) throw taskError('Не передан signature группы', 'SIGNATURE_REQUIRED');
    const [[row]] = await db.query(
        `SELECT group_signature, main_offer_id, codes_json, category_comment, category_task_state, status
           FROM dg_ozon_merge_decisions
          WHERE group_signature = ? AND problem_code = ? LIMIT 1`,
        [sig, OZON_PROBLEM_CATEGORY_NO_MERGE]
    );
    if (!row) throw taskError('Группа не найдена среди задач на смену категории', 'TASK_NOT_FOUND');
    if (!ACTIVE_STATES.includes(String(row.category_task_state || ''))) {
        throw taskError('Задача уже закрыта', 'TASK_CLOSED');
    }
    return row;
}

/** Для «Готово» / «Пропустить»: последний комментарий в истории должен быть от бота (после ответа человека — новый). */
async function loadOpenTask(db, signature) {
    const row = await loadTaskRow(db, signature);
    const [[last]] = await db.query(
        `SELECT role, kind FROM dg_ozon_category_task_comments
          WHERE group_signature = ? ORDER BY id DESC LIMIT 1`,
        [row.group_signature]
    );
    if (!last || last.role !== 'bot' || last.kind !== 'comment') {
        throw taskError(
            last && last.role === 'human'
                ? 'Сначала сохраните комментарий: что сделано после ответа'
                : 'Сначала сохраните комментарий: что сделано с категорией',
            'COMMENT_REQUIRED'
        );
    }
    return row;
}

/**
 * Проверка задачи по живым данным Ozon: все карточки группы в одной категории, и в ней есть
 * 9048 и вариативные характеристики. Успех — задача закрыта, группа возвращается
 * в «Предложения» для склейки.
 */
async function verifyCategoryTask(db, { signature, author }) {
    await ensureOzonMergeTables(db);
    const row = await loadOpenTask(db, signature);
    const s = await readSettings(db);
    if (!s.creds.clientId || !s.creds.apiKey) throw taskError('Нет ключей Ozon API в настройках', 'NO_OZON_CREDS');
    const logger = createMarketplaceLogger('ozon-category-tasks');
    const codes = parseCodes(row.codes_json);
    const live = await fetchLiveCards(s.creds, codes, logger, { force: true });
    const types = await loadCategoryTypes(s.creds, logger).catch(() => []);
    const typeByKey = new Map(types.map((t) => [`${t.description_category_id}:${t.type_id}`, t]));
    const who = String(author || '').trim().slice(0, AUTHOR_MAX) || 'бот';

    const missing = codes.filter((c) => !live.get(c));
    const main = live.get(row.main_offer_id) || live.get(codes[0]) || {};
    const mainKey = `${Number(main.description_category_id) || 0}:${Number(main.type_id) || 0}`;
    const mainType = typeByKey.get(mainKey);
    const mainPath = mainType ? mainType.path.join(' → ') : mainKey;
    const differ = codes.filter((c) => {
        const it = live.get(c);
        return it && `${Number(it.description_category_id) || 0}:${Number(it.type_id) || 0}` !== mainKey;
    });

    let ok = false;
    let note;
    if (missing.length) {
        note = `Ozon не вернул карточки: ${missing.join(', ')}`;
    } else if (differ.length) {
        note = `У карточек разные категории: ${differ.join(', ')} не в «${mainPath}». Смените у всех карточек группы.`;
    } else {
        const attrs = await fetchOzonCategoryAttributes(
            s.creds,
            Number(main.description_category_id),
            Number(main.type_id),
            logger
        );
        const has9048 = attrs.some((a) => Number(a.id) === 9048);
        const aspects = attrs.filter((a) => a && a.is_aspect).map((a) => String(a.name || '').trim());
        if (has9048 && aspects.length) {
            ok = true;
            note = `Категория «${mainPath}» поддерживает склейку (переключение: ${aspects.join('; ')}).`;
        } else {
            note =
                `В Ozon сейчас категория «${mainPath}» — склейки в ней нет. ` +
                `Если категорию меняли только что, Ozon мог ещё не применить: проверьте через 10–30 мин.`;
        }
    }

    if (ok) {
        await db.query(
            `UPDATE dg_ozon_merge_decisions
                SET status = 'suggested', problem_code = '', category_task_state = ?,
                    category_check_note = ?, category_checked_at = NOW(), updated_by_name = ?
              WHERE group_signature = ?`,
            [STATE_DONE, note.slice(0, 512), who, row.group_signature]
        );
    } else {
        await db.query(
            `UPDATE dg_ozon_merge_decisions
                SET category_check_note = ?, category_checked_at = NOW(), updated_at = updated_at
              WHERE group_signature = ?`,
            [note.slice(0, 512), row.group_signature]
        );
    }
    await appendOzonMergeLog(db, {
        group_signature: row.group_signature,
        offer_id: row.main_offer_id || '',
        action: ok ? 'category_verified' : 'category_check_failed',
        field: 'category_task',
        field_label: 'Проверка смены категории Ozon',
        old_value: null,
        new_value: ok ? 'Категория сменена — группа возвращена в «Предложения»' : 'Не подтверждено',
        note: `${note} · ${who}`.slice(0, 1000),
        changed_by_name: who,
    });
    const counts = await countTasks(db);
    if (counts.open < BATCH_SIZE) startRefill(db);
    return { success: true, signature: row.group_signature, verified: ok, note, queue: counts };
}

/** Бот не смог сменить категорию (нет подходящей и т.п.) — задача уходит из пачки, комментарий обязателен. */
async function skipCategoryTask(db, { signature, author }) {
    await ensureOzonMergeTables(db);
    const row = await loadOpenTask(db, signature);
    const who = String(author || '').trim().slice(0, AUTHOR_MAX) || 'бот';
    await db.query(
        `UPDATE dg_ozon_merge_decisions
            SET category_task_state = ?, category_check_note = ?, category_checked_at = NOW(),
                updated_at = updated_at
          WHERE group_signature = ?`,
        [STATE_SKIPPED, 'Пропущено ботом — см. комментарий', row.group_signature]
    );
    await appendOzonMergeLog(db, {
        group_signature: row.group_signature,
        offer_id: row.main_offer_id || '',
        action: 'category_skipped',
        field: 'category_task',
        field_label: 'Задача на смену категории Ozon',
        old_value: 'в работе',
        new_value: 'пропущена',
        note: `${String(row.category_comment || '').slice(0, 800)} · ${who}`,
        changed_by_name: who,
    });
    const counts = await countTasks(db);
    if (counts.open < BATCH_SIZE) startRefill(db);
    return { success: true, signature: row.group_signature, skipped: true, queue: counts };
}

let refill = { running: false, startedAt: 0, finishedAt: 0, result: null, error: '' };

function refillStatus() {
    return {
        running: refill.running,
        last_at: refill.finishedAt ? fmtDateTime(new Date(refill.finishedAt)) : '',
        last_result: refill.result,
        last_error: refill.error,
    };
}

/**
 * Скан «Предложений»: живая категория главной карточки каждой группы; где нет 9048 —
 * группа переносится в задачи (status failed + problem_code), как при отказе склейки.
 * Только чтение Ozon.
 */
async function scanSuggestedForCategoryTasks(db) {
    await ensureOzonMergeTables(db);
    const t0 = Date.now();
    const s = await readSettings(db, true);
    if (!s.creds.clientId || !s.creds.apiKey) throw taskError('Нет ключей Ozon API в настройках', 'NO_OZON_CREDS');
    const logger = createMarketplaceLogger('ozon-category-scan');
    const list = await buildAutoMergeGroupsList(db, { status: 'suggested', limit: 5000, unlimited: true });
    const groups = (list && list.rows) || [];
    const mainCodes = Array.from(new Set(groups.map((g) => String(g.main_offer_id || '')).filter(Boolean)));
    const live = new Map();
    for (let i = 0; i < mainCodes.length; i += 100) {
        const res = await axiosWithMarketplaceRateLimit(
            {
                method: 'POST',
                url: 'https://api-seller.ozon.ru/v3/product/info/list',
                data: { offer_id: mainCodes.slice(i, i + 100) },
                headers: ozonHeaders(s.creds),
                timeout: 60000,
            },
            logger,
            { maxAttempts: 3 }
        );
        for (const it of (res.data && res.data.items) || []) live.set(String(it.offer_id), it);
    }
    const attrsByType = new Map();
    let added = 0;
    let noData = 0;
    for (const g of groups) {
        const it = live.get(String(g.main_offer_id));
        const catId = Number(it && it.description_category_id) || 0;
        const typeId = Number(it && it.type_id) || 0;
        if (!catId || !typeId) {
            noData += 1;
            continue;
        }
        const key = `${catId}:${typeId}`;
        if (!attrsByType.has(key)) {
            attrsByType.set(key, await fetchOzonCategoryAttributes(s.creds, catId, typeId, logger));
        }
        const attrs = attrsByType.get(key);
        if (!attrs.length || attrs.some((a) => Number(a.id) === 9048)) continue;
        const sig = String(g.signature || '').trim();
        if (!sig) continue;
        const [[existing]] = await db.query(
            `SELECT status FROM dg_ozon_merge_decisions WHERE group_signature = ? LIMIT 1`,
            [sig]
        );
        if (existing && String(existing.status) !== 'suggested') continue;
        const codes = (g.items || []).map((x) => String(x.offer_id || '').trim()).filter(Boolean);
        const msg =
            `В категории Ozon главного товара ${g.main_offer_id} (category_id=${catId}, type_id=${typeId}) ` +
            `отсутствует атрибут 9048 («Объединить на одной карточке») — найдено проверкой категорий до склейки. ` +
            `Смените в ЛК Ozon категорию/тип на поддерживающую варианты.`;
        await db.query(
            `INSERT INTO dg_ozon_merge_decisions
                (group_signature, status, group_title, group_key_9048, main_offer_id, codes_json,
                 aspect_attr_id, aspect_values_json, updated_by_name, comment, problem_code, category_task_state)
             VALUES (?, 'failed', ?, ?, ?, ?, 0, '{}', ?, ?, ?, '')
             ON DUPLICATE KEY UPDATE
                status = 'failed', comment = VALUES(comment), problem_code = VALUES(problem_code),
                category_task_state = '', updated_by_name = VALUES(updated_by_name), updated_at = CURRENT_TIMESTAMP`,
            [
                sig,
                String(g.reason_title || '').slice(0, 500),
                String(g.group_key || g.main_offer_id || ''),
                String(g.main_offer_id || ''),
                JSON.stringify(codes),
                SCAN_ACTOR,
                msg.slice(0, 500),
                OZON_PROBLEM_CATEGORY_NO_MERGE,
            ]
        );
        await appendOzonMergeLog(db, {
            group_signature: sig,
            offer_id: String(g.main_offer_id || ''),
            action: 'category_task_added',
            field: 'category_task',
            field_label: 'Задача на смену категории Ozon',
            old_value: 'Предложение',
            new_value: 'Нужна смена категории',
            note: msg.slice(0, 500),
            changed_by_name: SCAN_ACTOR,
        });
        added += 1;
    }
    return {
        scanned: groups.length,
        added,
        no_data: noData,
        duration_sec: Math.round((Date.now() - t0) / 100) / 10,
    };
}

/** Фоновое пополнение очереди; не чаще раза в 30 мин, если не force. */
function startRefill(db, { force = false } = {}) {
    if (refill.running) return false;
    if (!force && refill.finishedAt && Date.now() - refill.finishedAt < REFILL_MIN_INTERVAL_MS) return false;
    refill = { running: true, startedAt: Date.now(), finishedAt: 0, result: refill.result, error: '' };
    scanSuggestedForCategoryTasks(db)
        .then((r) => {
            refill = { running: false, startedAt: refill.startedAt, finishedAt: Date.now(), result: r, error: '' };
        })
        .catch((e) => {
            console.error('[ozon-category-tasks] refill failed:', e && e.stack ? e.stack : e);
            refill = {
                running: false,
                startedAt: refill.startedAt,
                finishedAt: Date.now(),
                result: null,
                error: e && e.message ? e.message : String(e),
            };
        });
    return true;
}

/** Комментарий бота: добавляется в историю (не затирает прежние), последний — в category_comment*. */
async function saveCategoryComment(db, { signature, comment, author }) {
    await ensureOzonMergeTables(db);
    const row = await loadTaskRow(db, signature);
    const text = validateText(comment, 'Пустой комментарий');
    const who = String(author || '').trim().slice(0, AUTHOR_MAX) || 'бот';
    const sig = row.group_signature;
    await addThreadEntry(db, { signature: sig, role: 'bot', kind: 'comment', author: who, body: text });
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
    const threads = await loadCategoryTaskThreads(db, [sig]);
    return {
        success: true,
        signature: sig,
        category_comment: saved.category_comment || '',
        category_comment_by: saved.category_comment_by || '',
        category_comment_at: fmtDateTime(saved.category_comment_at),
        thread: threadForOutput(threads.get(sig)),
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
    verifyCategoryTask,
    skipCategoryTask,
    requestClarification,
    answerClarification,
    startRefill,
    refillStatus,
    countTasks,
    BATCH_SIZE,
    loadCategoryCommentsBySignature,
    suggestCategories,
    nameStems,
    _resetForTests() {
        pinFails.clear();
        settingsCache = { ts: 0, values: null };
    },
};
