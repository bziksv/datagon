'use strict';

const { getOpsPlanfixSyncMeta } = require('./opsSheetPlanfixSyncRevision');

const STATUS_FIELD_NAME = 'Статус Сделки/Письма';

const STATUS_BUCKETS = Object.freeze([
    { key: 'in_work', label: 'в работе', countDefault: true },
    { key: 'paid', label: 'оплаченная', countDefault: true },
    { key: 'paid_shipped', label: 'оплаченная + отгруженная', countDefault: true },
    { key: 'rejected', label: 'отказная', countDefault: true },
    { key: 'info_spam', label: 'инфо/спам', countDefault: false },
    { key: 'supplier', label: 'Поставщик', countDefault: true },
    {
        key: 'no_goods',
        label: 'Отказ - нет запрашиваемого товара/нет документации',
        countDefault: true,
    },
    { key: 'aggregator', label: 'Агрегатор', countDefault: true },
    { key: 'gbuz', label: 'ГБУЗ', countDefault: true },
]);

const BUCKET_KEYS = new Set(STATUS_BUCKETS.map((b) => b.key));
const BUCKET_BY_KEY = {};
STATUS_BUCKETS.forEach((b) => {
    BUCKET_BY_KEY[b.key] = b;
});

function foldName(s) {
    return String(s || '')
        .toLowerCase()
        .replace(/ё/g, 'е')
        .replace(/[^a-zа-я0-9]+/gi, ' ')
        .trim();
}

function nameTokens(s) {
    return foldName(s)
        .split(/\s+/)
        .filter((t) => t.length >= 3);
}

function sortedTokenKey(s) {
    const t = nameTokens(s).slice().sort();
    return t.length ? t.join(' ') : '';
}

function matchManagerByAssigner(assignerName, managers) {
    const aFold = foldName(assignerName);
    if (!aFold || !managers || !managers.length) return null;
    const aKey = sortedTokenKey(assignerName);
    const exact = managers.find((m) => {
        const f = foldName(m.full_name);
        const u = foldName(m.username);
        if (f && f === aFold) return true;
        if (u && u === aFold) return true;
        if (aKey && f && sortedTokenKey(m.full_name) === aKey) return true;
        return false;
    });
    if (exact) return exact;
    const aTok = nameTokens(assignerName);
    const scored = [];
    (managers || []).forEach((m) => {
        const mFold = foldName(m.full_name);
        if (!mFold) return;
        if (aFold.includes(mFold) || mFold.includes(aFold)) {
            scored.push({ m, score: Math.min(aFold.length, mFold.length) + 20 });
            return;
        }
        const mTok = nameTokens(m.full_name);
        let best = 0;
        mTok.forEach((t) => {
            if (aTok.indexOf(t) >= 0 && t.length > best) best = t.length;
        });
        if (best) scored.push({ m, score: best });
    });
    if (!scored.length) return null;
    scored.sort((a, b) => b.score - a.score);
    const top = scored[0];
    if (scored.some((x, i) => i > 0 && x.score === top.score && x.m.id !== top.m.id)) return null;
    return top.m;
}

function stringifyPfValue(v) {
    if (v == null || v === '') return '';
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
        return String(v).trim();
    }
    if (Array.isArray(v)) {
        return v
            .map(stringifyPfValue)
            .filter(Boolean)
            .join(', ');
    }
    if (typeof v === 'object') {
        return stringifyPfValue(v.value || v.name || v.text || v.title || v.stringValue || '');
    }
    return '';
}

function fieldNameOf(item) {
    if (!item || typeof item !== 'object') return '';
    const f = item.field || item.customField || item;
    return String((f && (f.name || f.title)) || item.name || '').trim();
}

function fieldIdOf(item) {
    if (!item || typeof item !== 'object') return 0;
    const f = item.field || item.customField || item;
    const n = Number((f && f.id) || item.id || 0);
    return Number.isFinite(n) ? n : 0;
}

function extractCustomStatus(task, fieldId, fieldName) {
    const bags = [task && task.customFieldData, task && task.customFields, task && task.customFieldValues].filter(
        Array.isArray
    );
    const wantName = foldName(fieldName || STATUS_FIELD_NAME);
    for (let b = 0; b < bags.length; b += 1) {
        const arr = bags[b];
        for (let i = 0; i < arr.length; i += 1) {
            const item = arr[i];
            const id = fieldIdOf(item);
            const name = foldName(fieldNameOf(item));
            const idOk = fieldId && id === Number(fieldId);
            const nameOk = wantName && name === wantName;
            if (!idOk && !nameOk) continue;
            const val =
                stringifyPfValue(item.stringValue) ||
                stringifyPfValue(item.value) ||
                stringifyPfValue(item.text) ||
                stringifyPfValue(item);
            if (val) return val;
        }
    }
    return '';
}

/** Календарь аккаунта Planfix (как фильтр «за январь» в UI). Без DST с 2014. */
const PLANFIX_ACCOUNT_TZ = 'Europe/Moscow';

function formatSqlInTimeZone(date, timeZone) {
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) return null;
    const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23',
    }).formatToParts(date);
    const g = (type) => {
        const hit = parts.find((p) => p.type === type);
        return hit ? hit.value : '';
    };
    const y = g('year');
    const mo = g('month');
    const d = g('day');
    const h = g('hour');
    const mi = g('minute');
    const s = g('second') || '00';
    if (!y || !mo || !d || h === '' || !mi) return null;
    return `${y}-${mo}-${d} ${h}:${mi}:${s}`;
}

function parseInstantToMoscowSql(date) {
    return formatSqlInTimeZone(date, PLANFIX_ACCOUNT_TZ);
}

function utcWallToMoscowSql(year, month, day, hour, minute, second) {
    const d = new Date(Date.UTC(
        Number(year),
        Number(month) - 1,
        Number(day),
        Number(hour) || 0,
        Number(minute) || 0,
        Number(second) || 0
    ));
    return parseInstantToMoscowSql(d);
}

function parseIsoInstant(s) {
    const t = String(s || '').trim();
    if (!t) return null;
    const norm = t.replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
    const d = new Date(norm);
    if (Number.isNaN(d.getTime())) return null;
    return d;
}

function parsePlanfixDateTime(raw) {
    if (raw == null || raw === '') return null;
    if (raw instanceof Date && !Number.isNaN(raw.getTime())) {
        return parseInstantToMoscowSql(raw);
    }
    if (typeof raw === 'object') {
        const utcRaw =
            raw.dateTimeUtcWithSeconds ||
            raw.dateTimeUtcSeconds ||
            raw.datetime ||
            raw.dateTime ||
            '';
        if (utcRaw) {
            const hit = parsePlanfixDateTime(utcRaw);
            if (hit) return hit;
        }
        if (raw.date && raw.time) {
            const hit = parsePlanfixDateTime(`${stringifyPfValue(raw.date)} ${stringifyPfValue(raw.time)}`);
            if (hit) return hit;
        }
        return parsePlanfixDateTime(raw.date || raw.value || '');
    }
    if (typeof raw === 'number' && Number.isFinite(raw)) {
        const ms = raw < 1e12 ? raw * 1000 : raw;
        return parsePlanfixDateTime(new Date(ms));
    }
    const s = String(raw).trim();
    if (/T/.test(s) || /[zZ]$/.test(s) || /[+-]\d{2}:?\d{2}$/.test(s)) {
        const d = parseIsoInstant(s);
        if (d) return parseInstantToMoscowSql(d);
    }
    let m = s.match(/^(\d{2})-(\d{2})-(\d{4})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/);
    if (m) {
        return utcWallToMoscowSql(m[3], m[2], m[1], m[4] || 0, m[5] || 0, m[6] || 0);
    }
    m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/);
    if (m) {
        return utcWallToMoscowSql(m[1], m[2], m[3], m[4] || 0, m[5] || 0, m[6] || 0);
    }
    return null;
}

function yearBounds(year) {
    const y = Number(year);
    return {
        fromSql: `${y}-01-01 00:00:00`,
        toSql: `${y + 1}-01-01 00:00:00`,
        fromPf: `01-01-${y}`,
        toPf: `31-12-${y}`,
        month: 0,
    };
}

/** month 1–12 — один месяц; иначе весь год. */
function periodBounds(year, month) {
    const y = Number(year);
    const m = Math.round(Number(month) || 0);
    if (!Number.isFinite(y) || m < 1 || m > 12) return yearBounds(y);
    const last = new Date(y, m, 0).getDate();
    const mm = String(m).padStart(2, '0');
    const dd = String(last).padStart(2, '0');
    const nextY = m === 12 ? y + 1 : y;
    const nextM = m === 12 ? 1 : m + 1;
    const nmm = String(nextM).padStart(2, '0');
    return {
        fromSql: `${y}-${mm}-01 00:00:00`,
        toSql: `${nextY}-${nmm}-01 00:00:00`,
        fromPf: `01-${mm}-${y}`,
        toPf: `${dd}-${mm}-${y}`,
        month: m,
    };
}

function pickAssigner(task) {
    const a = task && (task.assigner || task.Assigner);
    const first = Array.isArray(a) ? a[0] : a;
    if (!first || typeof first !== 'object') {
        return { id: null, name: stringifyPfValue(first) };
    }
    const id = Number(first.id);
    return {
        id: Number.isFinite(id) && id > 0 ? id : null,
        name: stringifyPfValue(first.name || first.fullName || first.userName || ''),
    };
}

function pickTaskId(task) {
    const n = Number(task && (task.id || task.number));
    return Number.isFinite(n) && n > 0 ? n : null;
}

function suggestBucket(statusValue) {
    const s = foldName(statusValue);
    if (!s) return '';
    if (/отправл.*кп|обработк.*запрос|принят.*решен|согласован.*документ|выставлен счет|заказан товар|товар получен/.test(s))
        return 'in_work';
    if (/спам|\bинфо\b|информац|хлам/.test(s)) return 'info_spam';
    if (/агрегатор/.test(s)) return 'aggregator';
    if (/поставщик/.test(s)) return 'supplier';
    if (/нет запраш|нет документ|нет товар/.test(s)) return 'no_goods';
    if (/товар отгружен/.test(s)) return 'paid_shipped';
    if (/оплач/.test(s)) return 'paid';
    if (/^гбуз$/.test(s)) return 'gbuz';
    if (/отказ/.test(s)) return 'rejected';
    if (/в работе|обработ|новая|принят/.test(s)) return 'in_work';
    return '';
}

function countDefaultForBucket(bucket) {
    const b = BUCKET_BY_KEY[bucket];
    if (!b) return false;
    return !!b.countDefault;
}

function isPlanfixProcessStatusName(name) {
    const s = foldName(name);
    if (!s) return false;
    return /^(новая|черновик|в работе( все)?|завершенная( все)?|оплачена завершена( все)?)$/.test(s);
}

function scoreDealStatusUniques(values) {
    let good = 0;
    let bad = 0;
    (values || []).forEach((v) => {
        if (!v) return;
        if (isPlanfixProcessStatusName(v)) bad += 1;
        else good += 1;
    });
    return good - bad * 8;
}

/** Порядок справочника «Статус Сделки/Письма» как в Planfix (скрины). `__sep:N` — разделитель. */
const DEAL_STATUS_LIST_ORDER = Object.freeze([
    'Обработка запроса',
    'Отправлено КП',
    'Принятие решения',
    'Согласование документов',
    'Выставлен счет',
    'Счет оплачен',
    'Заказан товар у поставщика',
    'Товар получен',
    'Товар отгружен',
    '__sep:1',
    'ГБУЗ',
    '__sep:2',
    'Не указывают конечного потребителя',
    'Сумма менее 5 000/10 000',
    'Подбор по Т.з.',
    'Не отвеча.т после 2-х писем/звонков',
    'Хлам с виджета',
    '__sep:3',
    'клиент отказался - дорого',
    'клиент отказался - мониторинг цен',
    'клиент отказался - мониторинг цен - ГБУЗ',
    'клиент отказался - планируют закупку через какое-то время',
    'Не устраивают сроки отказ',
    'Проект забронирован',
    'клиент отказался - потому что мудак!))',
    '__sep:4',
    'Поставщик',
    'Информационное письмо',
    '__sep:5',
    'Отказ - нет запрашиваемого товара/нет документации',
    '__sep:6',
    'Агрегатор',
]);

function isDealStatusSeparator(name) {
    const s = String(name || '').trim();
    if (!s) return false;
    if (/^__sep[:_-]/i.test(s)) return true;
    return /^[-–—_]{3,}$/.test(s);
}

function defaultDealStatusSortIndex(name) {
    const s = String(name || '').trim();
    const idx = DEAL_STATUS_LIST_ORDER.indexOf(s);
    if (idx >= 0) return idx;
    return -1;
}

function isStatusFieldName(name) {
    const n = foldName(name);
    const want = foldName(STATUS_FIELD_NAME);
    if (!n) return false;
    if (n === want) return true;
    return n.indexOf('статус сделки') >= 0 && n.indexOf('письм') >= 0;
}

function enumValuesFromField(field) {
    if (!field || typeof field !== 'object') return [];
    const out = [];
    const push = (v) => {
        const s = stringifyPfValue(v);
        if (s && out.indexOf(s) < 0) out.push(s);
    };
    ['enumValues', 'options', 'listValues', 'values', 'items'].forEach((k) => {
        const arr = field[k];
        if (Array.isArray(arr)) arr.forEach(push);
    });
    return out;
}

function directoryIdFromField(field) {
    if (!field || typeof field !== 'object') return 0;
    const n = Number(
        field.directoryId ||
            field.handbookId ||
            (field.directory && field.directory.id) ||
            (field.handbook && field.handbook.id) ||
            0
    );
    return Number.isFinite(n) && n > 0 ? n : 0;
}

function collectCustomFields(payload) {
    if (!payload || typeof payload !== 'object') return [];
    if (Array.isArray(payload.customfields)) return payload.customfields;
    if (Array.isArray(payload.customFields)) return payload.customFields;
    if (Array.isArray(payload.fields)) return payload.fields;
    if (Array.isArray(payload)) return payload;
    return [];
}

function collectTasks(payload) {
    if (!payload) return [];
    if (Array.isArray(payload.tasks)) return payload.tasks;
    if (payload.task && Array.isArray(payload.task)) return payload.task;
    if (Array.isArray(payload)) return payload;
    return [];
}

/** Только 450694. 450690 одночанковый (сотни строк) и затирает гистограмму года. */
const DEAL_STATUS_REPORT_IDS = Object.freeze([450694]);
/** Шаблоны заявок/КП больше не фильтруем: в лист все задачи постановщика-менеджера за период. */
const DEAL_STATUS_TEMPLATE_IDS = Object.freeze([]);

function collectReportFields(payload) {
    if (!payload || typeof payload !== 'object') return [];
    const r = payload.repost || payload.report || payload;
    const fields = r && r.fields;
    if (Array.isArray(fields)) return fields.filter(Boolean);
    if (fields && typeof fields === 'object') return [fields];
    return [];
}

function collectReportSaves(payload) {
    if (!payload || typeof payload !== 'object') return [];
    const arr = payload.saves || payload.reportSaves || [];
    return Array.isArray(arr) ? arr : [];
}

function reportSaveRows(payload) {
    if (!payload || typeof payload !== 'object') return [];
    const block = payload.data && typeof payload.data === 'object' ? payload.data : payload;
    const rows = block.rows;
    return Array.isArray(rows) ? rows : [];
}

function taskIdFromReportCell(item) {
    if (!item) return 0;
    const link = String(item.link || '');
    let m = link.match(/\/task\/(\d+)/);
    if (m) return Number(m[1]);
    const text = String(item.text || '');
    m = text.match(/\/task\/(\d+)/) || text.match(/\bID:(\d+)/i) || text.match(/\b(\d{5,})\s*$/);
    return m ? Number(m[1]) : 0;
}

/**
 * Разбор чанка сохранённого отчёта: пары task_id → «Статус Сделки/Письма».
 * @param {object} payload
 * @param {{ taskIdx?: number, statusIdx?: number }} [hint]
 */
function parseDealStatusReportRows(payload, hint) {
    const rows = reportSaveRows(payload);
    let taskIdx = hint && Number.isFinite(hint.taskIdx) ? hint.taskIdx : 0;
    let statusIdx = hint && Number.isFinite(hint.statusIdx) ? hint.statusIdx : -1;
    const pairs = [];
    rows.forEach((row) => {
        const items = (row && row.items) || [];
        const type = String((row && row.type) || '');
        if (type === 'Header') {
            items.forEach((it, i) => {
                const t = String((it && it.text) || '');
                if (isStatusFieldName(t)) statusIdx = i;
                if (/^задача$/i.test(t.trim()) || /^task$/i.test(t.trim())) taskIdx = i;
            });
            return;
        }
        if (type && type !== 'Normal') return;
        if (statusIdx < 0) {
            items.forEach((it, i) => {
                if (isStatusFieldName(it && it.text)) statusIdx = i;
            });
        }
        if (statusIdx < 0) return;
        const tid = taskIdFromReportCell(items[taskIdx]) || taskIdFromReportCell(items[0]);
        const status = stringifyPfValue(items[statusIdx] && items[statusIdx].text).slice(0, 191);
        if (!tid || !status) return;
        pairs.push({ task_id: tid, status_value: status });
    });
    return { pairs, taskIdx, statusIdx };
}

function collectUsers(payload) {
    if (!payload || typeof payload !== 'object') return [];
    const arr = payload.users || payload.employees || payload.user;
    if (Array.isArray(arr)) return arr;
    return [];
}

function pickUserDisplayName(user) {
    if (!user || typeof user !== 'object') return '';
    const combo = [user.lastName, user.firstName, user.patronymic || user.midName]
        .map((x) => stringifyPfValue(x))
        .filter(Boolean)
        .join(' ');
    return stringifyPfValue(user.name || user.fullName || combo);
}

/** Варианты ФИО сотрудника Planfix для сопоставления с Datagon. */
function pfUserNameCandidates(user) {
    const out = [];
    const push = (s) => {
        const t = String(s || '').trim();
        if (t && out.indexOf(t) < 0) out.push(t);
    };
    push(pickUserDisplayName(user));
    if (!user || typeof user !== 'object') return out;
    const ln = stringifyPfValue(user.lastName);
    const fn = stringifyPfValue(user.firstName);
    const mid = stringifyPfValue(user.patronymic || user.midName);
    if (ln && fn) {
        push([ln, fn, mid].filter(Boolean).join(' '));
        push([fn, ln, mid].filter(Boolean).join(' '));
        push([ln, fn].join(' '));
        push([fn, ln].join(' '));
    }
    return out;
}

function taskHasCustomFieldBag(task) {
    if (!task || typeof task !== 'object') return false;
    const bags = [task.customFieldData, task.customFields, task.customFieldValues, task.customData];
    return bags.some((b) => Array.isArray(b) && b.length > 0);
}

module.exports = {
    STATUS_FIELD_NAME,
    STATUS_BUCKETS,
    BUCKET_KEYS,
    foldName,
    matchManagerByAssigner,
    stringifyPfValue,
    extractCustomStatus,
    PLANFIX_ACCOUNT_TZ,
    parsePlanfixDateTime,
    yearBounds,
    periodBounds,
    pickAssigner,
    pickTaskId,
    suggestBucket,
    countDefaultForBucket,
    isStatusFieldName,
    enumValuesFromField,
    directoryIdFromField,
    collectCustomFields,
    collectTasks,
    collectUsers,
    pickUserDisplayName,
    pfUserNameCandidates,
    taskHasCustomFieldBag,
    DEAL_STATUS_REPORT_IDS,
    DEAL_STATUS_TEMPLATE_IDS,
    collectReportFields,
    collectReportSaves,
    parseDealStatusReportRows,
    isPlanfixProcessStatusName,
    scoreDealStatusUniques,
    DEAL_STATUS_LIST_ORDER,
    isDealStatusSeparator,
    defaultDealStatusSortIndex,
    getOpsPlanfixSyncMeta,
};
