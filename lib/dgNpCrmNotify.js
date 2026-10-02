'use strict';

/**
 * Уведомления в задачи CRM о товарах «Новые товары», которые ждут размещения.
 *
 * Альмамед: неразмещённый товар с ответственным → сразу комментарий «появились новые».
 * Маркеты: то же, но только когда заполнены обязательные поля размещения.
 * Сводка: раз в N дней «столько-то товаров ожидает размещения».
 *
 * Первое включение помечает текущую очередь известной (без пачки «новые» на весь бэклог).
 */

const crmPrime = require('./crmPrimeTimesheets');
const { getNpCrmNotifyMeta } = require('./dgNpCrmNotifyRevision');

const PANEL_BASE = String(process.env.DATAGON_PUBLIC_URL || 'https://p.datagon.ru').replace(/\/$/, '');
const LIST_LIMIT = 20;
const ALMAMED_WAITING_STATUSES = ['new', 'not_added', 'in_progress', 'revision', 'review'];
const MARKETS_WAITING_STATUSES = ['new', 'not_added', 'in_progress', 'revision', 'review'];
const TERMINAL_ALMAMED = ['verified', 'added', 'transferred', 'removed'];
const TERMINAL_MARKETS = ['added', 'verified', 'removed', 'not_cooperate', 'in_bundle'];

const SETTING_KEYS = {
    enabled: 'auto_sync_np_crm_notify_enabled',
    interval: 'auto_sync_np_crm_notify_interval_min',
    weekdays: 'auto_sync_np_crm_notify_weekdays',
    instant: 'np_crm_notify_instant_enabled',
    digestDays: 'np_crm_notify_digest_days',
    crmUserId: 'np_crm_notify_crm_user_id',
    baselined: 'np_crm_notify_baselined',
};

let chain = Promise.resolve();
let schemaReady = false;

function clip(s, max) {
    const t = String(s == null ? '' : s).trim();
    if (!max || t.length <= max) return t;
    return t.slice(0, max);
}

function normInterval(v) {
    const n = Number(v);
    return [15, 30, 60].includes(n) ? n : 15;
}

function normDigestDays(v) {
    const n = Math.round(Number(v));
    if (!Number.isFinite(n)) return 3;
    return Math.max(0, Math.min(30, n));
}

function normCrmUserId(v) {
    const n = Math.round(Number(v));
    if (!Number.isFinite(n) || n <= 0) return 1;
    return Math.min(n, 10000000);
}

function taskUrl(taskId) {
    return 'https://crm.prime-ltd.su/index.php/tasks/view/' + encodeURIComponent(String(taskId));
}

function channelLabel(channel) {
    return channel === 'marketplaces' ? 'маркетплейсах' : 'Альмамед';
}

function channelTab(channel) {
    return channel === 'marketplaces' ? 'marketplaces' : 'almamed';
}

async function ensureSchema(db) {
    if (schemaReady) return;
    await db.query(`
        CREATE TABLE IF NOT EXISTS dg_np_crm_notify_sent (
            product_id BIGINT NOT NULL,
            channel VARCHAR(32) NOT NULL,
            user_id INT NOT NULL,
            crm_task_id INT NOT NULL,
            sent_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (product_id, channel, user_id),
            INDEX idx_np_crm_notify_user (user_id, channel)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await db.query(`
        CREATE TABLE IF NOT EXISTS dg_np_crm_notify_digest (
            user_id INT NOT NULL,
            channel VARCHAR(32) NOT NULL,
            crm_task_id INT NOT NULL,
            waiting_count INT NOT NULL,
            sent_at DATETIME NOT NULL,
            PRIMARY KEY (user_id, channel)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    schemaReady = true;
}

async function readSettingMap(db) {
    const keys = Object.values(SETTING_KEYS);
    const [rows] = await db.query(
        `SELECT setting_key, setting_value FROM app_settings WHERE setting_key IN (?)`,
        [keys]
    );
    const map = {};
    for (const r of rows || []) map[r.setting_key] = r.setting_value;
    return map;
}

function settingsFromMap(map) {
    const m = map || {};
    return {
        enabled: Number(m[SETTING_KEYS.enabled] == null ? 0 : m[SETTING_KEYS.enabled]) === 1,
        interval_min: normInterval(m[SETTING_KEYS.interval] == null ? 15 : m[SETTING_KEYS.interval]),
        weekdays: String(m[SETTING_KEYS.weekdays] || ''),
        instant_enabled: Number(m[SETTING_KEYS.instant] == null ? 1 : m[SETTING_KEYS.instant]) === 1,
        digest_days: normDigestDays(m[SETTING_KEYS.digestDays] == null ? 3 : m[SETTING_KEYS.digestDays]),
        crm_user_id: normCrmUserId(m[SETTING_KEYS.crmUserId] == null ? 1 : m[SETTING_KEYS.crmUserId]),
        baselined: Number(m[SETTING_KEYS.baselined] || 0) === 1,
    };
}

async function loadSettings(db) {
    return settingsFromMap(await readSettingMap(db));
}

async function upsertSetting(db, appSettings, key, value) {
    const v = String(value);
    await db.query(
        `INSERT INTO app_settings (setting_key, setting_value) VALUES (?, ?)
         ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)`,
        [key, v]
    );
    if (appSettings && typeof appSettings === 'object') {
        if (
            key.endsWith('_enabled') ||
            key.endsWith('_days') ||
            key.endsWith('_min') ||
            key.endsWith('_id') ||
            key.endsWith('_baselined')
        ) {
            const n = Number(v);
            appSettings[key] = Number.isFinite(n) ? n : v;
        } else {
            appSettings[key] = v;
        }
    }
}

/** Товары, которые сейчас ждут размещения. */
async function fetchWaiting(db) {
    const almamedPh = ALMAMED_WAITING_STATUSES.map(() => '?').join(',');
    const marketsPh = MARKETS_WAITING_STATUSES.map(() => '?').join(',');
    const [rows] = await db.query(
        `SELECT p.id, p.channel, p.responsible_user_id AS user_id, p.responsible_name,
                p.article, p.title, p.channel_num, p.status
           FROM dg_new_products p
          WHERE p.responsible_user_id IS NOT NULL
            AND p.responsible_user_id > 0
            AND (
              (p.channel = 'almamed' AND p.status IN (${almamedPh}))
              OR (
                p.channel = 'marketplaces'
                AND p.status IN (${marketsPh})
                AND LOWER(TRIM(COALESCE(p.priority, ''))) IN ('important', 'normal', 'low')
                AND CHAR_LENGTH(TRIM(COALESCE(p.product_code, ''))) > 0
                AND CHAR_LENGTH(TRIM(COALESCE(p.article, ''))) > 0
                AND CHAR_LENGTH(TRIM(COALESCE(p.title, ''))) > 0
                AND CHAR_LENGTH(TRIM(COALESCE(p.barcode, ''))) > 0
                AND p.price_markets IS NOT NULL
                AND CHAR_LENGTH(TRIM(COALESCE(p.vat, ''))) > 0
                AND CHAR_LENGTH(TRIM(COALESCE(p.ru_url, ''))) > 0
              )
            )
          ORDER BY p.channel, p.responsible_user_id, p.id`,
        [...ALMAMED_WAITING_STATUSES, ...MARKETS_WAITING_STATUSES]
    );
    return rows || [];
}

async function pruneSent(db) {
    const aPh = TERMINAL_ALMAMED.map(() => '?').join(',');
    const mPh = TERMINAL_MARKETS.map(() => '?').join(',');
    await db.query(
        `DELETE s FROM dg_np_crm_notify_sent s
           JOIN dg_new_products p ON p.id = s.product_id AND p.channel = s.channel
          WHERE p.responsible_user_id IS NULL
             OR p.responsible_user_id <> s.user_id
             OR (p.channel = 'almamed' AND p.status IN (${aPh}))
             OR (p.channel = 'marketplaces' AND p.status IN (${mPh}))`,
        [...TERMINAL_ALMAMED, ...TERMINAL_MARKETS]
    );
}

async function fetchSentKeys(db) {
    const [rows] = await db.query(
        `SELECT product_id, channel, user_id FROM dg_np_crm_notify_sent`
    );
    const set = new Set();
    for (const r of rows || []) {
        set.add(Number(r.product_id) + '|' + r.channel + '|' + Number(r.user_id));
    }
    return set;
}

function sentKey(row) {
    return Number(row.id) + '|' + row.channel + '|' + Number(row.user_id);
}

async function fetchLinks(db) {
    const [rows] = await db.query(
        `SELECT user_id, scope, crm_task_id
           FROM dg_np_crm_task_links
          WHERE scope IN ('almamed', 'marketplaces')`
    );
    const byUser = new Map();
    for (const r of rows || []) {
        const uid = Number(r.user_id);
        if (!byUser.has(uid)) byUser.set(uid, {});
        byUser.get(uid)[r.scope] = Number(r.crm_task_id);
    }
    return byUser;
}

async function fetchPeople(db) {
    const [rows] = await db.query(
        `SELECT u.id, u.full_name, u.username
           FROM users u
           JOIN specialties s ON s.id = u.specialty_id
          WHERE s.name = 'Контент-Менеджер'
            AND COALESCE(u.is_archived, 0) = 0
          ORDER BY u.full_name, u.id`
    );
    return rows || [];
}

async function fetchDigestRows(db) {
    const [rows] = await db.query(
        `SELECT user_id, channel, crm_task_id, waiting_count, sent_at FROM dg_np_crm_notify_digest`
    );
    const map = new Map();
    for (const r of rows || []) {
        map.set(Number(r.user_id) + '|' + r.channel, r);
    }
    return map;
}

function itemLine(row) {
    const art = clip(row.article, 80);
    const title = clip(row.title, 140);
    const num = row.channel_num != null ? '#' + row.channel_num + ' ' : '';
    const label = [num + art, title].filter(Boolean).join(' — ') || 'товар ' + row.id;
    return crmPrime.escapeCrmHtml(label);
}

function buildInstantHtml(channel, rows) {
    const n = rows.length;
    const head =
        channel === 'marketplaces'
            ? 'Заполнены данные для размещения. Появились новые товары для размещения на маркетплейсах: <b>' +
              n +
              '</b>.'
            : 'Появились новые товары для размещения на Альмамед: <b>' + n + '</b>.';
    const shown = rows.slice(0, LIST_LIMIT);
    const items = shown.map((r) => '<li>' + itemLine(r) + '</li>').join('');
    const more =
        n > shown.length ? '<li>и ещё ' + (n - shown.length) + '</li>' : '';
    const href =
        PANEL_BASE + '/exports-new-products.html#' + channelTab(channel);
    return (
        '<p>' +
        head +
        '</p><ul>' +
        items +
        more +
        '</ul><p><a href="' +
        crmPrime.escapeCrmHtml(href) +
        '" target="_blank" rel="noopener noreferrer">Открыть очередь в Датагоне</a></p>'
    );
}

function buildDigestHtml(channel, count) {
    const href = PANEL_BASE + '/exports-new-products.html#' + channelTab(channel);
    return (
        '<p>Товаров ожидает размещения на ' +
        channelLabel(channel) +
        ': <b>' +
        count +
        '</b>.</p><p><a href="' +
        crmPrime.escapeCrmHtml(href) +
        '" target="_blank" rel="noopener noreferrer">Открыть очередь в Датагоне</a></p>'
    );
}

function groupByUserChannel(rows) {
    const map = new Map();
    for (const row of rows) {
        const key = Number(row.user_id) + '|' + row.channel;
        if (!map.has(key)) map.set(key, []);
        map.get(key).push(row);
    }
    return map;
}

async function markSent(db, rows, taskId) {
    if (!rows.length) return;
    const values = rows.map(() => '(?, ?, ?, ?)').join(',');
    const params = [];
    for (const row of rows) {
        params.push(Number(row.id), row.channel, Number(row.user_id), Number(taskId));
    }
    await db.query(
        `INSERT IGNORE INTO dg_np_crm_notify_sent (product_id, channel, user_id, crm_task_id)
         VALUES ${values}`,
        params
    );
}

async function baselineWaiting(db, waiting) {
    if (waiting.length) {
        const chunk = 400;
        for (let i = 0; i < waiting.length; i += chunk) {
            const part = waiting.slice(i, i + chunk);
            const values = part.map(() => '(?, ?, ?, 0)').join(',');
            const params = [];
            for (const row of part) {
                params.push(Number(row.id), row.channel, Number(row.user_id));
            }
            await db.query(
                `INSERT IGNORE INTO dg_np_crm_notify_sent (product_id, channel, user_id, crm_task_id)
                 VALUES ${values}`,
                params
            );
        }
    }
    await upsertSetting(db, null, SETTING_KEYS.baselined, 1);
    return waiting.length;
}

function digestDue(prev, digestDays, now) {
    if (!digestDays) return false;
    if (!prev || !prev.sent_at) return true;
    const sent = new Date(prev.sent_at).getTime();
    if (!Number.isFinite(sent)) return true;
    return now - sent >= digestDays * 24 * 60 * 60 * 1000;
}

async function buildPreview(db) {
    await ensureSchema(db);
    const settings = await loadSettings(db);
    const [waiting, links, people, sent, digest] = await Promise.all([
        fetchWaiting(db),
        fetchLinks(db),
        fetchPeople(db),
        fetchSentKeys(db),
        fetchDigestRows(db),
    ]);
    const peopleById = new Map();
    for (const p of people) {
        peopleById.set(Number(p.id), {
            user_id: Number(p.id),
            full_name: p.full_name || p.username || 'user#' + p.id,
            almamed: emptyChannel(),
            marketplaces: emptyChannel(),
        });
    }
    for (const [uid, scopes] of links) {
        if (!peopleById.has(uid)) {
            peopleById.set(uid, {
                user_id: uid,
                full_name: 'user#' + uid,
                almamed: emptyChannel(),
                marketplaces: emptyChannel(),
            });
        }
        const person = peopleById.get(uid);
        if (scopes.almamed) {
            person.almamed.crm_task_id = scopes.almamed;
            person.almamed.crm_task_url = taskUrl(scopes.almamed);
        }
        if (scopes.marketplaces) {
            person.marketplaces.crm_task_id = scopes.marketplaces;
            person.marketplaces.crm_task_url = taskUrl(scopes.marketplaces);
        }
    }
    for (const row of waiting) {
        const uid = Number(row.user_id);
        if (!peopleById.has(uid)) {
            peopleById.set(uid, {
                user_id: uid,
                full_name: row.responsible_name || 'user#' + uid,
                almamed: emptyChannel(),
                marketplaces: emptyChannel(),
            });
        }
        const bucket = peopleById.get(uid)[row.channel === 'marketplaces' ? 'marketplaces' : 'almamed'];
        bucket.waiting += 1;
        if (!sent.has(sentKey(row))) bucket.fresh += 1;
    }
    const now = Date.now();
    for (const person of peopleById.values()) {
        for (const channel of ['almamed', 'marketplaces']) {
            const prev = digest.get(person.user_id + '|' + channel);
            person[channel].digest_due =
                settings.digest_days > 0 &&
                person[channel].waiting > 0 &&
                !!person[channel].crm_task_id &&
                digestDue(prev, settings.digest_days, now);
            if (prev && prev.sent_at) person[channel].digest_sent_at = prev.sent_at;
        }
    }
    const list = [...peopleById.values()].sort((a, b) =>
        String(a.full_name).localeCompare(String(b.full_name), 'ru')
    );
    return {
        settings,
        people: list,
        waiting_total: waiting.length,
        crm_configured: crmPrime.isCrmConfigured(),
        script: getNpCrmNotifyMeta(),
    };
}

function emptyChannel() {
    return {
        crm_task_id: null,
        crm_task_url: null,
        waiting: 0,
        fresh: 0,
        digest_due: false,
        digest_sent_at: null,
    };
}

async function doRun(db, opts) {
    const t0 = Date.now();
    const o = opts || {};
    await ensureSchema(db);
    const settings = await loadSettings(db);
    const wantInstant = !!o.instant;
    const wantDigest = !!o.digest;
    if (!o.force && !settings.enabled) {
        return {
            skipped: 'disabled',
            settings,
            instant_posted: 0,
            digest_posted: 0,
            baselined: 0,
            errors: [],
            dry_run: !!o.dry_run,
            duration_sec: 0,
            script: getNpCrmNotifyMeta(),
        };
    }
    await pruneSent(db);
    const waiting = await fetchWaiting(db);
    const links = await fetchLinks(db);
    const sent = await fetchSentKeys(db);
    const errors = [];
    let baselined = 0;
    let didBaseline = false;

    if (wantInstant && !settings.baselined && o.allowBaseline) {
        if (!o.dry_run) {
            baselined = await baselineWaiting(db, waiting);
            settings.baselined = true;
        } else {
            baselined = waiting.length;
        }
        didBaseline = true;
        for (const row of waiting) sent.add(sentKey(row));
    }

    const instantOn = wantInstant && (o.force || settings.instant_enabled);
    const fresh = [];
    if (instantOn && settings.baselined && !didBaseline) {
        for (const row of waiting) {
            if (!sent.has(sentKey(row))) fresh.push(row);
        }
    }

    const instantGroups = groupByUserChannel(fresh);
    const digestMap = wantDigest ? await fetchDigestRows(db) : new Map();
    const now = Date.now();
    let instantPosted = 0;
    let digestPosted = 0;
    let instantProducts = 0;
    let digestTasks = 0;
    const posted = [];

    async function postGroup(kind, channel, userId, rows, count) {
        const scopes = links.get(Number(userId)) || {};
        const taskId = scopes[channel];
        if (!taskId) {
            errors.push({
                user_id: Number(userId),
                channel,
                error: 'Нет привязки задачи CRM',
            });
            return;
        }
        const html = kind === 'digest' ? buildDigestHtml(channel, count) : buildInstantHtml(channel, rows);
        if (o.dry_run) {
            posted.push({
                kind,
                channel,
                user_id: Number(userId),
                crm_task_id: taskId,
                count: kind === 'digest' ? count : rows.length,
                dry_run: true,
            });
            if (kind === 'digest') digestPosted += 1;
            else {
                instantPosted += 1;
                instantProducts += rows.length;
            }
            return;
        }
        try {
            const res = await crmPrime.postTaskComment({
                taskId,
                html,
                createdBy: settings.crm_user_id,
            });
            if (kind === 'digest') {
                await db.query(
                    `INSERT INTO dg_np_crm_notify_digest (user_id, channel, crm_task_id, waiting_count, sent_at)
                     VALUES (?, ?, ?, ?, NOW())
                     ON DUPLICATE KEY UPDATE crm_task_id = VALUES(crm_task_id),
                                             waiting_count = VALUES(waiting_count),
                                             sent_at = NOW()`,
                    [Number(userId), channel, taskId, count]
                );
                digestPosted += 1;
            } else {
                await markSent(db, rows, taskId);
                instantPosted += 1;
                instantProducts += rows.length;
            }
            posted.push({
                kind,
                channel,
                user_id: Number(userId),
                crm_task_id: taskId,
                comment_id: res.commentId,
                count: kind === 'digest' ? count : rows.length,
            });
        } catch (e) {
            errors.push({
                user_id: Number(userId),
                channel,
                crm_task_id: taskId,
                error: e.message || String(e),
            });
        }
    }

    if (instantOn) {
        for (const [key, rows] of instantGroups) {
            const [userId, channel] = key.split('|');
            await postGroup('instant', channel, userId, rows, rows.length);
        }
    }

    const digestOn = wantDigest && (o.digestNow || settings.digest_days > 0);
    // Первый проход только запоминает очередь. Сводка в том же заходе — только по явной кнопке.
    if (digestOn && !(didBaseline && !o.digestNow)) {
        const waitingGroups = groupByUserChannel(waiting);
        for (const [key, rows] of waitingGroups) {
            if (!rows.length) continue;
            const [userId, channel] = key.split('|');
            const prev = digestMap.get(Number(userId) + '|' + channel);
            if (!o.digestNow && !digestDue(prev, settings.digest_days, now)) continue;
            digestTasks += 1;
            await postGroup('digest', channel, userId, rows, rows.length);
        }
    }

    return {
        skipped: null,
        settings: await loadSettings(db),
        baselined,
        did_baseline: didBaseline,
        instant_posted: instantPosted,
        instant_products: instantProducts,
        digest_posted: digestPosted,
        digest_candidates: digestTasks,
        waiting_total: waiting.length,
        fresh_total: fresh.length,
        posted: posted.slice(0, 40),
        errors: errors.slice(0, 20),
        error_count: errors.length,
        dry_run: !!o.dry_run,
        duration_sec: Math.round((Date.now() - t0) / 10) / 100,
        script: getNpCrmNotifyMeta(),
        crm_configured: crmPrime.isCrmConfigured(),
    };
}

function run(db, opts) {
    const job = chain.then(() => doRun(db, opts));
    chain = job.catch(() => {});
    return job;
}

function scheduleInstant(db) {
    setImmediate(() => {
        run(db, {
            instant: true,
            digest: false,
            respectEnabled: true,
            allowBaseline: false,
            force: false,
        }).catch((e) => {
            console.error('[np-crm-notify] hook', e && e.message ? e.message : e);
        });
    });
}

async function saveSettings(db, appSettings, body) {
    const b = body && typeof body === 'object' ? body : {};
    const prev = await loadSettings(db);
    const enabled = b.enabled === undefined ? prev.enabled : !!b.enabled;
    const instant =
        b.instant_enabled === undefined ? prev.instant_enabled : !!b.instant_enabled;
    const digestDays = b.digest_days === undefined ? prev.digest_days : normDigestDays(b.digest_days);
    const interval = b.interval_min === undefined ? prev.interval_min : normInterval(b.interval_min);
    const crmUserId = b.crm_user_id === undefined ? prev.crm_user_id : normCrmUserId(b.crm_user_id);
    const weekdays = b.weekdays === undefined ? prev.weekdays : clip(b.weekdays, 32);
    await upsertSetting(db, appSettings, SETTING_KEYS.enabled, enabled ? 1 : 0);
    await upsertSetting(db, appSettings, SETTING_KEYS.instant, instant ? 1 : 0);
    await upsertSetting(db, appSettings, SETTING_KEYS.digestDays, digestDays);
    await upsertSetting(db, appSettings, SETTING_KEYS.interval, interval);
    await upsertSetting(db, appSettings, SETTING_KEYS.crmUserId, crmUserId);
    await upsertSetting(db, appSettings, SETTING_KEYS.weekdays, weekdays);
    let baselinedNow = 0;
    if (enabled && instant && !prev.baselined) {
        await ensureSchema(db);
        await pruneSent(db);
        const waiting = await fetchWaiting(db);
        baselinedNow = await baselineWaiting(db, waiting);
        if (appSettings) appSettings[SETTING_KEYS.baselined] = 1;
    }
    const settings = await loadSettings(db);
    return { settings, baselined_now: baselinedNow };
}

module.exports = {
    SETTING_KEYS,
    ensureSchema,
    loadSettings,
    buildPreview,
    saveSettings,
    run,
    scheduleInstant,
    getNpCrmNotifyMeta,
};
