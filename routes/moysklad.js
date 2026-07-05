const express = require('express');
const axios = require('axios');
const { computeMsEntityPurchaseDenorm } = require('../lib/datagonMsEntityPurchaseDenorm');
const { syncZeroStockLogAfterMoyskladExport, syncProductStockSnapshotsAfterMoyskladExport } = require('./product');
const {
    replaceMsExportStockByStoreFromReport,
    buildAssortmentUuidToCodeMap,
} = require('../lib/msExportStockByStore');

const router = express.Router();

const BASE_URL = 'https://api.moysklad.ru/api/remap/1.2';
const MS_DETAIL_EXPAND_PRODUCT =
    'attributes,supplier,images,country,uom,salePrices,buyPrice,minPrice,barcodes,countryOfOrigin';
const MS_DETAIL_EXPAND_BUNDLE =
    'attributes,supplier,images,country,uom,salePrices,buyPrice,minPrice,components,components.assortment,countryOfOrigin';
/** МойСклад: expand вложенных полей в списке `entity/bundle` при limit > 100 часто не раскрывается (остаётся meta без rows). */
const MS_BUNDLE_LIST_PAGE_LIMIT = 100;
const MS_ATTRS = [
    'Автоматизация цены',
    'Складская позиция',
    'Перестали сотрудничать / Не производится (дет.в комментах)',
    'Проработка цены / коммент',
    '!-Упаковка товара для склада (стандартные коробки)',
    '!-Упаковка товара, который отправляется в своей коробке (Д*Ш*В) в см',
    '!-Вес товара с учетом коробки/пакета',
    'НДС на товаре или комплекте',
    'Поставщик 2',
    'Менеджер поддерживающий товар',
    'Ответственный контент-менджер',
    /** Габариты (для /exports-dimensions.html). Парсятся из ms_entity_details.payload_json. */
    '!!Тип УПАКОВКИ',
    '!!Длина (см) КОРОБКА/Пакет станд. уп.',
    '!!Ширина (см) КОРОБКА/Пакет станд. уп.',
    '!!Высота (см) КОРОБКА станд. уп.',
    '!!Высота (см) Пакет!',
    '!!Вес (кг)',
    /** Медмаркет — пользовательский атрибут на карточке товара/комплекта. */
    'Код товара для медмаркета',
];

const jobState = {
    active: false,
    done: false,
    cancelRequested: false,
    processed: 0,
    total: 0,
    message: 'Ожидание',
    logs: [],
    updatedAt: null,
};
const bundleRecalcState = {
    active: false,
    started_at: null,
    finished_at: null,
    total_bundles: 0,
    processed: 0,
    updated: 0,
    skipped_no_components: 0,
    skipped_unresolved: 0,
    /** UPDATE ms_export затронул 0 строк (код/тип не совпал с выгрузкой) */
    export_no_row: 0,
    errors: 0,
    message: 'Ожидание'
};
let sourceLinksCacheReady = false;
let sourceLinksCacheLastBuiltAt = 0;
let sourceLinksCacheBuildPromise = null;
const SOURCE_LINKS_CACHE_TTL_MS = 2 * 60 * 1000;
const msStatsCache = new Map();
const MS_STATS_CACHE_TTL_MS = 2 * 60 * 1000;
let msArchivedColumnReady = false;
let msEntityDetailsTableReady = false;

/** Пул БД для записи строк журнала синка (ставится в createMoyskladRouter). */
let moyskladSyncLogDb = null;
let msSyncLogTableReady = false;
const MS_SYNC_LOG_RETENTION_DAYS = 90;

async function ensureMsSyncLogTable(db) {
    if (!db || msSyncLogTableReady) return;
    await db.query(`
        CREATE TABLE IF NOT EXISTS dg_ms_sync_log (
            id BIGINT AUTO_INCREMENT PRIMARY KEY,
            created_at TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP(3),
            line TEXT NOT NULL,
            INDEX idx_dg_ms_sync_log_time (created_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    msSyncLogTableReady = true;
}

function pruneMsSyncLogOldRows(db) {
    if (!db) return Promise.resolve();
    return ensureMsSyncLogTable(db)
        .then(() =>
            db.query('DELETE FROM dg_ms_sync_log WHERE created_at < DATE_SUB(NOW(), INTERVAL ? DAY) LIMIT 50000', [
                MS_SYNC_LOG_RETENTION_DAYS
            ])
        )
        .catch(() => {});
}

function persistMoyskladSyncLogLine(db, fullLine) {
    if (!db || !fullLine) return;
    const safe = String(fullLine).slice(0, 12000);
    ensureMsSyncLogTable(db)
        .then(() => db.query('INSERT INTO dg_ms_sync_log (line) VALUES (?)', [safe]))
        .catch(() => {});
}

function addLog(msg) {
    const stamp = new Date().toLocaleTimeString('ru-RU');
    const full = `[${stamp}] ${msg}`;
    jobState.logs.unshift(full);
    jobState.logs = jobState.logs.slice(0, 30);
    jobState.updatedAt = new Date().toISOString();
    persistMoyskladSyncLogLine(moyskladSyncLogDb, full);
}

function ensureNotCancelled() {
    if (jobState.cancelRequested) {
        throw new Error('Синхронизация остановлена пользователем');
    }
}

function normalizeCode(value) {
    return String(value || '').trim().toUpperCase();
}

function getToken(config) {
    return process.env.MS_TOKEN || config.msToken || '';
}

function getAttrValue(item, attrsMap, attrName) {
    if (!item.attributes || !Array.isArray(item.attributes)) return '';
    const attrId = attrsMap[attrName];
    if (!attrId) return '';
    const attr = item.attributes.find((a) => a.id === attrId);
    if (!attr) return '';
    const val = attr.value;
    if (val && typeof val === 'object' && val.name) return val.name;
    return val ?? '';
}

function formatMoneyRu(raw) {
    const n = Number(raw || 0);
    if (!Number.isFinite(n) || n === 0) return '';
    return `${new Intl.NumberFormat('ru-RU').format(Math.round(n))} ₽`;
}

function formatMoneyFixed2(raw) {
    const n = Number(raw || 0);
    if (!Number.isFinite(n) || n === 0) return '';
    return `${n.toFixed(2)} ₽`;
}

function extractSalePriceFromItem(item) {
    const list = Array.isArray(item?.salePrices) ? item.salePrices : [];
    if (!list.length) return '';

    const bySalesType = list.find((sp) => {
        const typeName = String(sp?.priceType?.name || '').trim().toLowerCase();
        return typeName === 'цена продажи';
    });
    const bySalesTypeValue = Number(bySalesType?.value || 0);
    if (Number.isFinite(bySalesTypeValue) && bySalesTypeValue > 0) {
        return formatMoneyFixed2(bySalesTypeValue / 100);
    }

    const firstPositive = list.find((sp) => Number(sp?.value || 0) > 0);
    const firstPositiveValue = Number(firstPositive?.value || 0);
    if (Number.isFinite(firstPositiveValue) && firstPositiveValue > 0) {
        return formatMoneyFixed2(firstPositiveValue / 100);
    }

    return '';
}

function tokenizeGroup(group) {
    const tokens = [];
    const re = /"([^"]+)"|(\S+)/g;
    let m;
    while ((m = re.exec(group)) !== null) {
        const v = (m[1] || m[2] || '').trim();
        if (v) tokens.push(v);
    }
    return tokens;
}

function swapKeyboardLayout(token) {
    const ru = 'йцукенгшщзхъфывапролджэячсмитьбю';
    const en = 'qwertyuiop[]asdfghjkl;\'zxcvbnm,.';
    const map = new Map();
    for (let i = 0; i < ru.length; i += 1) {
        map.set(ru[i], en[i]);
        map.set(ru[i].toUpperCase(), en[i].toUpperCase());
        map.set(en[i], ru[i]);
        map.set(en[i].toUpperCase(), ru[i].toUpperCase());
    }
    return token.split('').map((ch) => map.get(ch) || ch).join('');
}

function translitRuToLat(token) {
    const m = {
        а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i',
        й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't',
        у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y',
        ь: '', э: 'e', ю: 'yu', я: 'ya'
    };
    return token
        .split('')
        .map((ch) => {
            const low = ch.toLowerCase();
            const repl = m[low];
            if (repl === undefined) return ch;
            return ch === low ? repl : repl.toUpperCase();
        })
        .join('');
}

function translitLatToRu(token) {
    const direct = {
        a: 'а', b: 'б', c: 'к', d: 'д', e: 'е', f: 'ф', g: 'г', h: 'х', i: 'и', j: 'й',
        k: 'к', l: 'л', m: 'м', n: 'н', o: 'о', p: 'п', q: 'к', r: 'р', s: 'с', t: 'т',
        u: 'у', v: 'в', w: 'в', x: 'кс', y: 'й', z: 'з'
    };
    return token
        .split('')
        .map((ch) => {
            const low = ch.toLowerCase();
            const repl = direct[low];
            if (!repl) return ch;
            return ch === low ? repl : repl.toUpperCase();
        })
        .join('');
}

function tokenVariants(rawToken) {
    const base = String(rawToken || '').trim();
    if (!base) return [];
    const variants = new Set([base]);
    const swapped = swapKeyboardLayout(base).trim();
    if (swapped) variants.add(swapped);
    const ruToLat = translitRuToLat(base).trim();
    if (ruToLat) variants.add(ruToLat);
    const latToRu = translitLatToRu(base).trim();
    if (latToRu) variants.add(latToRu);
    return Array.from(variants).filter((v) => v.length > 0);
}

function appendFieldLikeAny(andClauses, params, fieldsSql, token) {
    const variants = tokenVariants(token);
    if (!variants.length) return;
    const parts = [];
    for (const v of variants) {
        const val = `%${v}%`;
        parts.push(fieldsSql);
        for (let i = 0; i < (fieldsSql.match(/\?/g) || []).length; i += 1) {
            params.push(val);
        }
    }
    andClauses.push(`(${parts.join(' OR ')})`);
}

function buildSmartSearchClause(rawSearch) {
    const search = String(rawSearch || '').trim();
    if (!search) return { sql: '', params: [] };

    const groups = search.split('|').map((x) => x.trim()).filter(Boolean);
    if (!groups.length) return { sql: '', params: [] };

    const orClauses = [];
    const params = [];

    for (const group of groups) {
        const tokens = tokenizeGroup(group);
        if (!tokens.length) continue;
        const andClauses = [];

        for (const token of tokens) {
            const idx = token.indexOf(':');
            let key = '';
            let value = token;
            if (idx > 0) {
                key = token.slice(0, idx).toLowerCase();
                value = token.slice(idx + 1);
            }
            const val = `%${String(value).trim()}%`;
            if (!String(value).trim()) continue;

            if (key === 'sku' || key === 'code') {
                appendFieldLikeAny(andClauses, params, '(code LIKE ?)', value);
            } else if (key === 'name') {
                appendFieldLikeAny(andClauses, params, '(name LIKE ?)', value);
            } else if (key === 'supplier') {
                appendFieldLikeAny(andClauses, params, '(supplier LIKE ? OR supplier2 LIKE ?)', value);
            } else if (key === 'manager') {
                appendFieldLikeAny(andClauses, params, '(manager LIKE ?)', value);
            } else if (key === 'content' || key === 'content_manager') {
                appendFieldLikeAny(andClauses, params, '(content_manager LIKE ?)', value);
            } else if (key === 'stock' || key === 'stockpos' || key === 'stock_position') {
                const normalized = String(value).trim().toLowerCase();
                if (['yes', 'да', 'true', '1'].includes(normalized)) {
                    andClauses.push('(stock_position = ?)');
                    params.push('Да');
                } else if (['no', 'нет', 'false', '0'].includes(normalized)) {
                    andClauses.push('(stock_position = ?)');
                    params.push('Нет');
                }
            } else {
                appendFieldLikeAny(andClauses, params, '(code LIKE ? OR name LIKE ? OR supplier LIKE ? OR supplier2 LIKE ?)', value);
            }
        }

        if (andClauses.length) {
            orClauses.push(`(${andClauses.join(' AND ')})`);
        }
    }

    if (!orClauses.length) return { sql: '', params: [] };
    return { sql: ` AND (${orClauses.join(' OR ')})`, params };
}

function parseFlexibleNumber(v) {
    if (v === undefined || v === null || v === '') return null;
    const n = Number(String(v).replace(',', '.'));
    return Number.isFinite(n) ? n : null;
}

function toBinaryFlag(value) {
    if (value === true || value === 1) return 1;
    const normalized = String(value ?? '').trim().toLowerCase();
    if (['1', 'true', 'y', 'yes', 'да'].includes(normalized)) return 1;
    return 0;
}

/** Кэш справочника атрибутов товара (имена по id) — снижает число запросов при открытии карточек. */
const MS_ATTRS_META_CACHE_TTL_MS = 60 * 60 * 1000;
let msAttrsMetaCache = { ts: 0, rows: [] };
const msRefNameCache = new Map();

async function getMsProductAttributesMeta(headers) {
    const now = Date.now();
    if (msAttrsMetaCache.rows.length && now - msAttrsMetaCache.ts < MS_ATTRS_META_CACHE_TTL_MS) return msAttrsMetaCache.rows;
    const resp = await axios.get(`${BASE_URL}/entity/product/metadata/attributes`, { headers, timeout: 30000 });
    msAttrsMetaCache = { ts: now, rows: resp.data?.rows || [] };
    return msAttrsMetaCache.rows;
}

async function resolveMsMetaNameByHref(headers, refObj) {
    const href = String(refObj?.meta?.href || '').trim();
    if (!href || !headers) return '';
    if (msRefNameCache.has(href)) return msRefNameCache.get(href);
    try {
        const resp = await axios.get(href, { headers, timeout: 30000 });
        const name = String(resp?.data?.name || '').trim();
        msRefNameCache.set(href, name);
        return name;
    } catch (_) {
        msRefNameCache.set(href, '');
        return '';
    }
}

async function ensureMsEntityDetailsTable(db) {
    if (msEntityDetailsTableReady) return;
    await db.query(`
        CREATE TABLE IF NOT EXISTS ms_entity_details (
            uuid VARCHAR(64) PRIMARY KEY,
            code VARCHAR(255),
            kind VARCHAR(32) NOT NULL,
            name VARCHAR(500),
            payload_json LONGTEXT NOT NULL,
            source VARCHAR(32) NOT NULL DEFAULT 'sync',
            denorm_article VARCHAR(512) NULL,
            denorm_in_transit DECIMAL(18,6) NULL,
            denorm_pack_qty_auto DECIMAL(18,6) NULL,
            denorm_market_price_rub DECIMAL(18,4) NULL,
            fetched_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            INDEX idx_ms_entity_details_code (code),
            INDEX idx_ms_entity_details_kind (kind),
            INDEX idx_ms_entity_details_updated (updated_at)
        )
    `);
    const alters = [
        'ALTER TABLE ms_entity_details ADD COLUMN denorm_article VARCHAR(512) NULL',
        'ALTER TABLE ms_entity_details ADD COLUMN denorm_in_transit DECIMAL(18,6) NULL',
        'ALTER TABLE ms_entity_details ADD COLUMN denorm_pack_qty_auto DECIMAL(18,6) NULL',
        'ALTER TABLE ms_entity_details ADD COLUMN denorm_market_price_rub DECIMAL(18,4) NULL',
    ];
    for (const sql of alters) {
        try {
            await db.query(sql);
        } catch (e) {
            const msg = String((e && e.message) || e);
            if (!/Duplicate column name/i.test(msg)) throw e;
        }
    }
    msEntityDetailsTableReady = true;
}

function moyskladEntityUuid(entity) {
    const href = String(entity?.meta?.href || '').trim();
    let fromHref = href ? href.split('/').pop() : '';
    /* href иногда заканчивается на ?expand=… — иначе uuid в ms_export не совпадёт с ms_entity_details */
    fromHref = String(fromHref || '').split('?')[0].trim();
    return String(entity?.id || fromHref || '')
        .trim()
        .split('?')[0]
        .trim();
}

function moyskladEntityKind(entity, fallbackKind = '') {
    const t = String(entity?.meta?.type || fallbackKind || '').toLowerCase();
    return t === 'bundle' || fallbackKind === 'bundle' ? 'bundle' : 'product';
}

async function saveMoyskladEntityDetails(db, entities, source = 'sync', onProgress = null) {
    // Потоковая запись `ms_entity_details`. Раньше функция шла в два прохода:
    // (1) `JSON.stringify(entity)` для ВСЕХ сущностей сразу → массив `values[]`
    // на ~57k записей лежал в памяти целиком (≈ 280 МБ – 1 ГБ только под
    // payload_json), параллельно в `syncMsExport` ещё жили `all` и `exportRows`,
    // суммарный пик 1.5–2 ГБ → OOM на боевом стенде, pm2/systemd рестартует Node
    // и UI видит свежий jobState = «Ожидание / 0/0», а в архиве синка обрывается
    // прямо после последнего батча `Сохранено в ms_export: N/N` без следующего
    // лога «Сохранение полных карточек МойСклад...». (2) Только потом — батчи в БД.
    //
    // Теперь — один проход с inline-батчингом: буфер растёт только до chunkSize,
    // тут же флашится, обнуляется. Пик памяти падает до единиц МБ.
    // `setImmediate`-yield между батчами освобождает event-loop, чтобы /status,
    // /stop и другие маршруты отвечали без задержки во время сохранения.
    const list = Array.isArray(entities) ? entities : [entities];
    if (!list.length) return 0;
    await ensureMsEntityDetailsTable(db);
    const chunkSize = 100;
    const safeSource = String(source || 'sync').slice(0, 32);
    const insertSql = `INSERT INTO ms_entity_details (uuid, code, kind, name, payload_json, source,
            denorm_article, denorm_in_transit, denorm_pack_qty_auto, denorm_market_price_rub)
        VALUES ?
        ON DUPLICATE KEY UPDATE
           code = VALUES(code),
           kind = VALUES(kind),
           name = VALUES(name),
           payload_json = VALUES(payload_json),
           source = VALUES(source),
           denorm_article = VALUES(denorm_article),
           denorm_in_transit = VALUES(denorm_in_transit),
           denorm_pack_qty_auto = VALUES(denorm_pack_qty_auto),
           denorm_market_price_rub = VALUES(denorm_market_price_rub),
           fetched_at = CURRENT_TIMESTAMP`;
    // `total` оцениваем по входному списку (включая возможные пустые/без uuid).
    // Прогресс-лог: каждые ~5% или ~50 батчей (что чаще). На старте — сразу
    // `processed=0`, чтобы UI/архив зафиксировали момент входа в этот этап.
    const total = list.length;
    const expectedChunks = Math.max(1, Math.ceil(total / chunkSize));
    const progressEveryChunks = Math.max(1, Math.floor(expectedChunks / 20));
    if (typeof onProgress === 'function') {
        try { onProgress({ processed: 0, total }); } catch (_) {}
    }
    let buffer = [];
    let processed = 0;
    let saved = 0;
    let chunkIndex = 0;
    const flush = async () => {
        if (!buffer.length) return;
        await db.query(insertSql, [buffer]);
        saved += buffer.length;
        buffer = [];
        chunkIndex += 1;
        if (typeof onProgress === 'function'
            && (chunkIndex % progressEveryChunks === 0 || processed >= total)) {
            try { onProgress({ processed, total }); } catch (_) {}
        }
        await new Promise((resolve) => setImmediate(resolve));
    };
    for (const entity of list) {
        processed += 1;
        if (!entity || typeof entity !== 'object') continue;
        const uuid = moyskladEntityUuid(entity);
        if (!uuid) continue;
        const kind = moyskladEntityKind(entity);
        const code = normalizeCode(entity.code);
        const name = String(entity.name || '');
        let payload = '';
        try {
            payload = JSON.stringify(entity);
        } catch (_) {
            payload = '';
        }
        if (!payload) continue;
        const dn = computeMsEntityPurchaseDenorm(entity);
        buffer.push([
            uuid,
            code,
            kind,
            name,
            payload,
            safeSource,
            dn.denorm_article,
            dn.denorm_in_transit,
            dn.denorm_pack_qty_auto,
            dn.denorm_market_price_rub,
        ]);
        if (buffer.length >= chunkSize) {
            await flush();
        }
    }
    await flush();
    if (typeof onProgress === 'function') {
        try { onProgress({ processed: total, total }); } catch (_) {}
    }
    return saved;
}

async function loadMoyskladEntityDetail(db, uuid) {
    await ensureMsEntityDetailsTable(db);
    const [rows] = await db.query(
        'SELECT uuid, kind, payload_json, updated_at FROM ms_entity_details WHERE uuid = ? LIMIT 1',
        [uuid]
    );
    const row = rows && rows[0];
    if (!row || !row.payload_json) return null;
    try {
        const entity = JSON.parse(row.payload_json);
        if (!entity || typeof entity !== 'object') return null;
        return {
            entity,
            kind: row.kind === 'bundle' ? 'bundle' : 'product',
            updated_at: row.updated_at,
        };
    } catch (_) {
        return null;
    }
}

function stripHtmlToText(html) {
    return String(html || '')
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function formatMsDetailScalar(val) {
    if (val == null) return '';
    if (typeof val === 'boolean') return val ? 'Да' : 'Нет';
    if (typeof val === 'number') return String(val);
    if (typeof val === 'string') return val.trim();
    if (typeof val === 'object') {
        if (val.name != null && String(val.name).trim()) return String(val.name).trim();
        // Справочники МС (country, uom, …): expand не всегда даёт name — остаётся только meta
        const meta = val.meta && typeof val.meta === 'object' ? val.meta : null;
        if (meta && (meta.href || meta.uuidHref)) {
            const ref = formatMsMetaRef(val);
            if (ref) return ref;
        }
        if (Array.isArray(val)) return val.map(formatMsDetailScalar).filter(Boolean).join(', ');
        if (val.sum != null && val.currency != null) return `${val.sum} ${val.currency}`;
        try {
            return JSON.stringify(val).slice(0, 1200);
        } catch (_) {
            return String(val);
        }
    }
    return String(val);
}

function formatMsMetaRef(value) {
    if (!value || typeof value !== 'object') return '';
    const meta = value.meta && typeof value.meta === 'object' ? value.meta : null;
    const hrefRaw = meta && meta.href != null ? String(meta.href).trim() : '';
    const uuidHrefRaw = meta && meta.uuidHref != null ? String(meta.uuidHref).trim() : '';
    const typeRaw = meta && meta.type != null ? String(meta.type).trim() : '';
    const href = hrefRaw || '';
    const uuidHref = uuidHrefRaw || '';
    const type = typeRaw || '';
    let id = '';
    if (href) {
        const last = href.split('/').pop() || '';
        id = String(last.split('?')[0] || '').trim();
    }
    if (!type && !id && !href && !uuidHref) return '';
    const head = [];
    if (type) head.push(type);
    if (id) head.push(`ID: ${id}`);
    const prefix = head.join(', ');
    const link = uuidHref || href;
    if (prefix && link) return `${prefix}\n${link}`;
    return prefix || link || '';
}

function pushDetailRow(rows, label, value) {
    const v =
        value == null
            ? ''
            : typeof value === 'string'
              ? value.trim()
              : formatMsDetailScalar(value);
    if (v !== '') rows.push({ label, value: v });
}

function buildMoyskladDetailPayload(attrMetaRows, entity, kind) {
    const idToName = new Map();
    for (const r of attrMetaRows || []) {
        if (r && r.id) idToName.set(r.id, r.name);
    }
    const main = [];
    pushDetailRow(main, 'Код', entity.code);
    pushDetailRow(main, 'Артикул', entity.article);
    pushDetailRow(main, 'Внешний код', entity.externalCode);
    pushDetailRow(main, 'Наименование', entity.name);
    pushDetailRow(main, 'Тип в МойСклад', kind === 'bundle' ? 'Комплект' : 'Товар');
    pushDetailRow(main, 'Архив', entity.archived ? 'Да' : '');

    const desc = stripHtmlToText(entity.description);
    if (desc) main.push({ label: 'Описание', value: desc.slice(0, 8000) });

    if (entity.effectiveVat != null && entity.effectiveVat !== '') {
        pushDetailRow(main, 'НДС (effectiveVat)', entity.effectiveVat);
    } else if (entity.vat != null && entity.vat !== '') {
        pushDetailRow(main, 'НДС', entity.vat);
    }
    if (entity.vatEnabled != null) pushDetailRow(main, 'Учёт НДС', entity.vatEnabled ? 'Да' : 'Нет');

    if (entity.weight != null && entity.weight !== '') pushDetailRow(main, 'Вес', entity.weight);
    if (entity.volume != null && entity.volume !== '') pushDetailRow(main, 'Объём', entity.volume);

    if (entity.buyPrice && entity.buyPrice.value != null) {
        const cents = Number(entity.buyPrice.value);
        if (Number.isFinite(cents)) pushDetailRow(main, 'Закупочная цена', `${(cents / 100).toFixed(2)} ₽`);
    }
    if (entity.minPrice && entity.minPrice.value != null) {
        const cents = Number(entity.minPrice.value);
        if (Number.isFinite(cents)) pushDetailRow(main, 'Мин. цена', `${(cents / 100).toFixed(2)} ₽`);
    }

    if (Array.isArray(entity.salePrices) && entity.salePrices.length) {
        for (const sp of entity.salePrices) {
            if (sp?.value == null) continue;
            const cents = Number(sp.value);
            if (!Number.isFinite(cents)) continue;
            const pt = String(sp?.priceType?.name || '').trim();
            const label = pt ? pt : 'Цена продажи';
            const value = `${(cents / 100).toFixed(2)} ₽`;
            main.push({ label, value });
        }
    }

    if (entity.countryOfOrigin) {
        const c = entity.countryOfOrigin;
        const nm = String(c?.name || '').trim();
        pushDetailRow(main, 'Страна происхождения', nm || c);
    }
    if (entity.country) {
        const c = entity.country;
        const nm = String(c?.name || '').trim();
        pushDetailRow(main, 'Страна', nm || c);
    }
    if (entity.uom) {
        const u = entity.uom;
        const uName = String(u?.name || '').trim();
        pushDetailRow(main, 'Ед. измерения', uName || formatMsMetaRef(u) || u);
    }
    if (entity.supplier) {
        const s = entity.supplier;
        const sName = String(s?.name || '').trim();
        pushDetailRow(main, 'Поставщик', sName || formatMsMetaRef(s) || s);
    }

    if (Array.isArray(entity.barcodes) && entity.barcodes.length) {
        const parts = [];
        for (const b of entity.barcodes) {
            if (!b) continue;
            if (typeof b === 'string') parts.push(b);
            else if (b.ean13) parts.push(`EAN13: ${b.ean13}`);
            else if (b.ean8) parts.push(`EAN8: ${b.ean8}`);
            else if (b.code128) parts.push(`Code128: ${b.code128}`);
            else parts.push(JSON.stringify(b));
        }
        if (parts.length) main.push({ label: 'Штрихкоды', value: parts.join(', ') });
    }

    if (Array.isArray(entity.images) && entity.images.length) {
        const urls = [];
        for (const im of entity.images) {
            const u = im?.miniature?.downloadHref || im?.meta?.downloadHref || im?.filename;
            if (u) urls.push(String(u));
        }
        if (urls.length) main.push({ label: 'Изображения (ссылки)', value: urls.slice(0, 12).join('\n') });
    }

    if (kind === 'bundle' && Array.isArray(entity.components?.rows) && entity.components.rows.length) {
        const lines = [];
        let i = 0;
        for (const c of entity.components.rows) {
            i += 1;
            const a = c.assortment || {};
            const nm = String(a.name || '').trim();
            const code = String(a.code || '').trim();
            const qty = Number(c.quantity || 1);
            const head = nm || code || 'позиция';
            lines.push(`${i}. ${head}${code && nm !== code ? ` (${code})` : ''} × ${qty}`);
        }
        if (lines.length) main.push({ label: 'Состав комплекта', value: lines.join('\n') });
    }

    const blocks = [{ title: 'Данные из МойСклад (полная карточка)', rows: main }];

    const attrRows = [];
    for (const a of entity.attributes || []) {
        const nm = String(a?.name || idToName.get(a?.id) || a?.id || '').trim();
        if (!nm) continue;
        attrRows.push({ label: nm, value: formatMsDetailScalar(a.value) || '—' });
    }
    if (attrRows.length) {
        blocks.push({
            title: 'Атрибуты (все, в т.ч. не попавшие в выгрузку ms_export)',
            rows: attrRows
        });
    }

    return {
        webHref: entity?.meta?.uuidHref ? String(entity.meta.uuidHref) : null,
        blocks
    };
}

async function ensureMsArchivedColumn(db) {
    if (msArchivedColumnReady) return;
    const [rows] = await db.query(`
        SELECT COUNT(*) AS cnt
        FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'ms_export'
          AND COLUMN_NAME = 'is_archived'
    `);
    if (!rows[0]?.cnt) {
        await db.query('ALTER TABLE ms_export ADD COLUMN is_archived TINYINT(1) NOT NULL DEFAULT 0');
        await db.query('ALTER TABLE ms_export ADD INDEX idx_ms_export_archived (is_archived)');
    }
    msArchivedColumnReady = true;
}

let msMinStockColumnReady = false;
/**
 * Миграция `ms_export.min_stock` — нативное поле «Неснижаемый остаток» из МС
 * (`product.minimumBalance`). Добавляется по аналогии с `ensureMsArchivedColumn`,
 * чтобы новые правки могли пользоваться этой колонкой без ручного `ALTER TABLE`
 * на боевом. Тип DECIMAL(15,3) — паритет со `stock` (тоже DECIMAL у нас).
 * Для `Комплектов` (`bundle`) минимальный остаток в МС не задаётся — пишем `NULL`.
 */
async function ensureMsMinStockColumn(db) {
    if (msMinStockColumnReady) return;
    const [rows] = await db.query(`
        SELECT COUNT(*) AS cnt
        FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'ms_export'
          AND COLUMN_NAME = 'min_stock'
    `);
    if (!rows[0]?.cnt) {
        await db.query('ALTER TABLE ms_export ADD COLUMN min_stock DECIMAL(15,3) NULL DEFAULT NULL');
    }
    msMinStockColumnReady = true;
}

let msMedmarketColumnReady = false;
async function ensureMsMedmarketProductCodeColumn(db) {
    if (msMedmarketColumnReady) return;
    const [rows] = await db.query(`
        SELECT COUNT(*) AS cnt
        FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'ms_export'
          AND COLUMN_NAME = 'medmarket_product_code'
    `);
    if (!rows[0]?.cnt) {
        await db.query(
            'ALTER TABLE ms_export ADD COLUMN medmarket_product_code VARCHAR(255) NULL DEFAULT NULL',
        );
        await db.query(
            'ALTER TABLE ms_export ADD INDEX idx_ms_export_medmarket_code (medmarket_product_code(64))',
        );
    }
    msMedmarketColumnReady = true;
}

function buildExportFilters(query, whereSql, whereParams) {
    const {
        search = '',
        type = 'all',
        archived = 'active',
        supplier = '',
        supplier2 = '',
        manager = '',
        content_manager = '',
        vat = '',
        vat_on_product = '',
        uuid = '',
        packing_standard = '',
        packing_own_box = '',
        packing_weight = '',
        updated_label = '',
        on_site = 'all',
        stock_position = 'yes',
        only_stock = '0',
        no_coop = '0',
        has_buy_price = '0',
        has_price_comment = '0',
        has_automation = '0',
        stock_min,
        stock_max,
        stock_days_min,
        stock_days_max,
        buy_price_min,
        buy_price_max,
        g_code = '',
        g_name = '',
        g_supplier = '',
        g_supplier2 = '',
        g_manager = '',
        g_content_manager = '',
        g_type = '',
        g_stock_min,
        g_stock_max,
        g_archived = 'all'
    } = query || {};

    let sql = whereSql || ' WHERE 1=1';
    const params = Array.isArray(whereParams) ? whereParams : [];

    if (type && type !== 'all') {
        sql += ' AND type = ?';
        params.push(type);
    }
    if (archived === 'active') {
        sql += ' AND COALESCE(is_archived, 0) = 0';
    } else if (archived === 'archived') {
        sql += ' AND COALESCE(is_archived, 0) = 1';
    }
    if (stock_position === 'yes') {
        sql += ' AND stock_position = ?';
        params.push('Да');
    } else if (stock_position === 'no') {
        sql += ' AND stock_position = ?';
        params.push('Нет');
    }
    if (on_site === '1') {
        sql += ' AND slc.source_id IS NOT NULL';
    } else if (on_site === '0') {
        sql += ' AND slc.source_id IS NULL';
    }
    if (String(search).trim()) {
        const smart = buildSmartSearchClause(search);
        if (smart.sql) {
            sql += smart.sql;
            params.push(...smart.params);
        }
    }
    if (String(supplier).trim()) {
        const val = `%${String(supplier).trim()}%`;
        sql += ' AND (supplier LIKE ? OR supplier2 LIKE ?)';
        params.push(val, val);
    }
    if (String(supplier2).trim()) {
        const val = `%${String(supplier2).trim()}%`;
        sql += ' AND supplier2 LIKE ?';
        params.push(val);
    }
    if (String(manager).trim()) {
        const val = `%${String(manager).trim()}%`;
        sql += ' AND manager LIKE ?';
        params.push(val);
    }
    if (String(content_manager).trim()) {
        const val = `%${String(content_manager).trim()}%`;
        sql += ' AND content_manager LIKE ?';
        params.push(val);
    }
    if (String(vat).trim()) {
        sql += ' AND vat = ?';
        params.push(String(vat).trim());
    }
    if (String(vat_on_product).trim()) {
        sql += ' AND vat_on_product = ?';
        params.push(String(vat_on_product).trim());
    }
    if (String(uuid).trim()) {
        const val = `%${String(uuid).trim()}%`;
        sql += ' AND uuid LIKE ?';
        params.push(val);
    }
    if (String(packing_standard).trim()) {
        const val = `%${String(packing_standard).trim()}%`;
        sql += ' AND packing_standard LIKE ?';
        params.push(val);
    }
    if (String(packing_own_box).trim()) {
        const val = `%${String(packing_own_box).trim()}%`;
        sql += ' AND packing_own_box LIKE ?';
        params.push(val);
    }
    if (String(packing_weight).trim()) {
        const val = `%${String(packing_weight).trim()}%`;
        sql += ' AND packing_weight LIKE ?';
        params.push(val);
    }
    if (String(updated_label).trim()) {
        const val = `%${String(updated_label).trim()}%`;
        sql += ' AND updated_label LIKE ?';
        params.push(val);
    }
    if (String(only_stock) === '1') {
        sql += ' AND COALESCE(stock, 0) > 0';
    }
    if (String(no_coop) === '1') {
        sql += ' AND no_longer_cooperation = ?';
        params.push('Да');
    }
    if (String(has_buy_price) === '1') {
        sql += " AND COALESCE(TRIM(buy_price), '') <> ''";
    }
    if (String(has_price_comment) === '1') {
        sql += " AND COALESCE(TRIM(price_comment), '') <> ''";
    }
    if (String(has_automation) === '1') {
        sql += " AND COALESCE(TRIM(automation_price), '') <> ''";
    }

    const stockMin = parseFlexibleNumber(stock_min);
    const stockMax = parseFlexibleNumber(stock_max);
    if (stockMin !== null) {
        sql += ' AND COALESCE(stock, 0) >= ?';
        params.push(stockMin);
    }
    if (stockMax !== null) {
        sql += ' AND COALESCE(stock, 0) <= ?';
        params.push(stockMax);
    }

    const stockDaysMin = parseFlexibleNumber(stock_days_min);
    const stockDaysMax = parseFlexibleNumber(stock_days_max);
    if (stockDaysMin !== null) {
        sql += ' AND COALESCE(CAST(stock_days AS DECIMAL(15,2)), 0) >= ?';
        params.push(stockDaysMin);
    }
    if (stockDaysMax !== null) {
        sql += ' AND COALESCE(CAST(stock_days AS DECIMAL(15,2)), 0) <= ?';
        params.push(stockDaysMax);
    }

    const buyExpr = "COALESCE(CAST(REPLACE(REPLACE(REPLACE(REPLACE(buy_price, '₽', ''), ' ', ''), ' ', ''), ',', '.') AS DECIMAL(15,2)), 0)";
    const buyPriceMinNum = parseFlexibleNumber(buy_price_min);
    const buyPriceMaxNum = parseFlexibleNumber(buy_price_max);
    if (buyPriceMinNum !== null) {
        sql += ` AND ${buyExpr} >= ?`;
        params.push(buyPriceMinNum);
    }
    if (buyPriceMaxNum !== null) {
        sql += ` AND ${buyExpr} <= ?`;
        params.push(buyPriceMaxNum);
    }

    /** Фильтры «сетки» (как в UI ms-tf-*): подстрока в поле, тип/архив/остаток — AND к остальным условиям. */
    if (String(g_code).trim()) {
        const val = `%${String(g_code).trim()}%`;
        sql += ' AND LOWER(code) LIKE LOWER(?)';
        params.push(val);
    }
    if (String(g_name).trim()) {
        const val = `%${String(g_name).trim()}%`;
        sql += ' AND LOWER(name) LIKE LOWER(?)';
        params.push(val);
    }
    if (String(g_supplier).trim()) {
        const val = `%${String(g_supplier).trim()}%`;
        sql += ' AND LOWER(supplier) LIKE LOWER(?)';
        params.push(val);
    }
    if (String(g_supplier2).trim()) {
        const val = `%${String(g_supplier2).trim()}%`;
        sql += ' AND LOWER(supplier2) LIKE LOWER(?)';
        params.push(val);
    }
    if (String(g_manager).trim()) {
        const val = `%${String(g_manager).trim()}%`;
        sql += ' AND LOWER(manager) LIKE LOWER(?)';
        params.push(val);
    }
    if (String(g_content_manager).trim()) {
        const val = `%${String(g_content_manager).trim()}%`;
        sql += ' AND LOWER(content_manager) LIKE LOWER(?)';
        params.push(val);
    }
    const gType = String(g_type || '').trim();
    if (gType && gType.toLowerCase() !== 'all') {
        sql += ' AND LOWER(TRIM(COALESCE(type, \'\'))) = LOWER(TRIM(?))';
        params.push(gType);
    }
    const gStockMin = parseFlexibleNumber(g_stock_min);
    const gStockMax = parseFlexibleNumber(g_stock_max);
    if (gStockMin !== null && String(g_stock_min).trim() !== '') {
        sql += ' AND COALESCE(stock, 0) >= ?';
        params.push(gStockMin);
    }
    if (gStockMax !== null && String(g_stock_max).trim() !== '') {
        sql += ' AND COALESCE(stock, 0) <= ?';
        params.push(gStockMax);
    }
    const gArch = String(g_archived || 'all').trim().toLowerCase();
    if (gArch === '0') {
        sql += ' AND COALESCE(is_archived, 0) = 0';
    } else if (gArch === '1') {
        sql += ' AND COALESCE(is_archived, 0) = 1';
    }

    return { sql, params };
}

async function fetchPaged(url, headers, params = {}) {
    const out = [];
    let offset = 0;
    const limit = Math.max(100, Math.min(parseInt(params.pageLimit, 10) || 1000, 5000));
    const delayMs = Math.max(0, parseInt(params.delayMs, 10) || 0);
    let knownTotal = 0;
    const { onProgress, pageLimit, delayMs: _delayMs, ...queryParams } = params || {};
    while (true) {
        ensureNotCancelled();
        const resp = await axios.get(url, {
            headers,
            params: { ...queryParams, limit, offset },
            timeout: 30000,
        });
        const rows = resp.data?.rows || [];
        const metaSize = Number(resp.data?.meta?.size || 0);
        if (metaSize > 0) knownTotal = metaSize;
        if (!rows.length) break;
        out.push(...rows);
        if (typeof onProgress === 'function') {
            onProgress({
                loaded: out.length,
                total: knownTotal,
                offset,
                limit
            });
        }
        offset += limit;
        if (delayMs > 0) {
            await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
        if (rows.length < limit) break;
    }
    return out;
}

async function fetchAllWithArchivedStatuses(url, headers, params = {}) {
    const { onPhaseProgress, ...rest } = params || {};
    const activeRows = await fetchPaged(url, headers, {
        ...rest,
        filter: 'archived=false',
        onProgress: ({ loaded, total }) => {
            if (typeof onPhaseProgress === 'function') {
                onPhaseProgress({ phase: 'active', loaded, total });
            }
        }
    });
    const archivedRows = await fetchPaged(url, headers, {
        ...rest,
        filter: 'archived=true',
        onProgress: ({ loaded, total }) => {
            if (typeof onPhaseProgress === 'function') {
                onPhaseProgress({ phase: 'archived', loaded, total });
            }
        }
    });
    const byKey = new Map();
    for (const row of [...activeRows, ...archivedRows]) {
        const key = String(row?.id || row?.meta?.href || row?.code || '').trim();
        if (!key) continue;
        byKey.set(key, row);
    }
    return Array.from(byKey.values());
}

async function resolveAssortmentCode(assortment, headers, assortmentCodeCache) {
    if (!assortment) return '';
    const directCode = normalizeCode(assortment.code || assortment.article);
    if (directCode) return directCode;

    const href = assortment.meta?.href;
    if (!href) return '';
    if (assortmentCodeCache.has(href)) return assortmentCodeCache.get(href);

    try {
        const resp = await axios.get(href, { headers, timeout: 30000 });
        const data = resp.data || {};
        const code = normalizeCode(data.code || data.article || '');
        assortmentCodeCache.set(href, code);
        return code;
    } catch (_) {
        assortmentCodeCache.set(href, '');
        return '';
    }
}

async function syncMsExport(db, config, settings = {}) {
    const token = getToken(config);
    if (!token) throw new Error('MS_TOKEN не задан (env MS_TOKEN или config.msToken)');
    const headers = { Authorization: `Bearer ${token}` };

    /** Сразу после проверки токена — до любых `await`, иначе `processAutoSyncQueue` в server.js
     *  успевает `waitUntil(() => !getJobState().active)` и закрывает `auto_sync_runs` за «0 с»,
     *  пока фоновый `syncMsExport` ещё не выставил active (гонка с fire-and-forget `triggerSync`). */
    jobState.active = true;
    jobState.done = false;
    jobState.cancelRequested = false;
    jobState.processed = 0;
    jobState.total = 0;
    jobState.message = 'Загрузка метаданных МойСклад...';
    jobState.logs = [];

    await ensureMsArchivedColumn(db);
    await ensureMsMinStockColumn(db);
    await ensureMsMedmarketProductCodeColumn(db);
    pruneMsSyncLogOldRows(db).catch(() => {});
    addLog('Старт синхронизации');
    addLog('Этап 1/6: метаданные атрибутов');

    const attrResp = await axios.get(`${BASE_URL}/entity/product/metadata/attributes`, { headers, timeout: 30000 });
    ensureNotCancelled();
    const attrRows = attrResp.data?.rows || [];
    const attrsMap = {};
    for (const row of attrRows) {
        if (MS_ATTRS.includes(row.name)) attrsMap[row.name] = row.id;
    }
    const stockAttrId = attrsMap['Складская позиция'];
    addLog(`Атрибутов найдено: ${Object.keys(attrsMap).length}`);
    jobState.message = `Метаданные загружены. Атрибутов: ${Object.keys(attrsMap).length}`;

    addLog('Этап 2/6: загрузка товаров');
    jobState.message = 'Загрузка товаров...';
    const products = await fetchAllWithArchivedStatuses(`${BASE_URL}/entity/product`, headers, {
        expand: MS_DETAIL_EXPAND_PRODUCT,
        pageLimit: settings.ms_sync_page_limit,
        delayMs: settings.ms_sync_delay_ms,
        onPhaseProgress: ({ phase, loaded, total }) => {
            const phaseLabel = phase === 'archived' ? 'архивные' : 'активные';
            jobState.message = total > 0
                ? `Загрузка товаров (${phaseLabel}): ${loaded}/${total}`
                : `Загрузка товаров (${phaseLabel}): ${loaded}`;
        }
    });
    jobState.message = `Загрузка товаров: ${products.length}`;
    addLog(`Товары загружены: ${products.length}`);

    addLog('Этап 3/6: загрузка комплектов');
    jobState.message = 'Загрузка комплектов...';
    const bundleListPageLimit = Math.min(
        Math.max(100, Math.min(parseInt(settings.ms_sync_page_limit, 10) || 1000, 5000)),
        MS_BUNDLE_LIST_PAGE_LIMIT
    );
    const bundles = await fetchAllWithArchivedStatuses(`${BASE_URL}/entity/bundle`, headers, {
        expand: MS_DETAIL_EXPAND_BUNDLE,
        pageLimit: bundleListPageLimit,
        delayMs: settings.ms_sync_delay_ms,
        onPhaseProgress: ({ phase, loaded, total }) => {
            const phaseLabel = phase === 'archived' ? 'архивные' : 'активные';
            jobState.message = total > 0
                ? `Загрузка комплектов (${phaseLabel}): ${loaded}/${total}`
                : `Загрузка комплектов (${phaseLabel}): ${loaded}`;
        }
    });
    jobState.message = `Загрузка комплектов: ${bundles.length}`;
    addLog(
        `Загружено товаров: ${products.length}, комплектов: ${bundles.length} (страница списка комплектов: limit=${bundleListPageLimit} — expand состава в МС)`
    );

    const supplierCache = new Map();
    const getSupplierName = async (supplier) => {
        if (!supplier) return '';
        if (supplier.name) return supplier.name;
        const href = supplier.meta?.href;
        if (!href) return '';
        if (supplierCache.has(href)) return supplierCache.get(href);
        try {
            const resp = await axios.get(href, { headers, timeout: 30000 });
            const name = resp.data?.name || '';
            supplierCache.set(href, name);
            return name;
        } catch (_) {
            const fallback = `[ID:${href.split('/').pop()}]`;
            supplierCache.set(href, fallback);
            return fallback;
        }
    };

    addLog('Этап 4/6: загрузка остатков report/stock/all');
    jobState.message = 'Загрузка остатков...';
    const stockRows = await fetchPaged(`${BASE_URL}/report/stock/all`, headers, {
        groupBy: 'variant',
        pageLimit: settings.ms_sync_page_limit,
        delayMs: settings.ms_sync_delay_ms,
        onProgress: ({ loaded, total }) => {
            jobState.message = total > 0
                ? `Загрузка остатков: ${loaded}/${total}`
                : `Загрузка остатков: ${loaded}`;
        }
    });
    const stockMap = new Map();
    for (const row of stockRows) {
        const code = normalizeCode(row.code);
        if (!code) continue;
        const stock = Number(row.stock || 0);
        const stockDays = row.stockDays ?? '';
        const salePrice = row.salePrice ? `${(Number(row.salePrice) / 100).toFixed(2)} ₽` : '';
        const rawIt = row.inTransit != null ? row.inTransit : row.in_transit;
        let inTransit = null;
        if (rawIt != null && rawIt !== '') {
            const n = Number(rawIt);
            if (Number.isFinite(n)) inTransit = n;
        }
        const rawRes = row.reserve;
        let reserve = null;
        if (rawRes != null && rawRes !== '') {
            const n = Number(rawRes);
            if (Number.isFinite(n)) reserve = n;
        }
        stockMap.set(code, { stock, stockDays, salePrice, inTransit, reserve });
    }
    addLog(`Остатков загружено: ${stockMap.size}`);

    addLog('Этап 4b/6: остатки по складам report/stock/bystore');
    jobState.message = 'Загрузка остатков по складам...';
    try {
        const uuidToCode = buildAssortmentUuidToCodeMap(products, bundles);
        const byStoreRows = await fetchPaged(`${BASE_URL}/report/stock/bystore`, headers, {
            groupBy: 'variant',
            pageLimit: settings.ms_sync_page_limit,
            delayMs: settings.ms_sync_delay_ms,
            onProgress: ({ loaded, total }) => {
                jobState.message = total > 0
                    ? `Остатки по складам: ${loaded}/${total}`
                    : `Остатки по складам: ${loaded}`;
            },
        });
        const { rows: byStoreRowsSaved } = await replaceMsExportStockByStoreFromReport(db, byStoreRows, uuidToCode);
        addLog(`Остатков по складам в БД: ${byStoreRowsSaved} (code×store, для «Заказы в МС»)`);
    } catch (e) {
        addLog(`Остатки по складам: ошибка — ${e && e.message ? e.message : String(e)}`);
    }

    const all = [...products, ...bundles];
    jobState.total = all.length;
    addLog(`К записи подготовлено (все товары/комплекты): ${all.length}`);
    addLog('Этап 5/6: расчет полей и подготовка строк');
    jobState.message = `Подготовка строк: 0/${jobState.total}`;

    // Карта закупочных цен по коду (только для товаров/компонентов).
    const buyPriceByCode = new Map();
    for (const prod of products) {
        const prodCode = normalizeCode(prod.code);
        if (!prodCode) continue;
        const buyNum = Number(prod?.buyPrice?.value || 0) / 100;
        if (Number.isFinite(buyNum) && buyNum > 0) {
            buyPriceByCode.set(prodCode, buyNum);
        }
    }

    const bundleComponents = new Map();
    const assortmentCodeCache = new Map();
    for (const b of bundles) {
        ensureNotCancelled();
        const code = normalizeCode(b.code);
        if (!code || !Array.isArray(b.components?.rows)) continue;
        const components = [];
        for (const c of b.components.rows) {
            ensureNotCancelled();
            const resolvedCode = await resolveAssortmentCode(c.assortment, headers, assortmentCodeCache);
            if (!resolvedCode) continue;
            components.push({
                code: resolvedCode,
                qty: Number(c.quantity || 1),
            });
        }
        bundleComponents.set(code, components);
    }

    const tsLabel = new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' });
    const exportRows = [];

    for (const item of all) {
        ensureNotCancelled();
        const code = normalizeCode(item.code);
        if (!code) continue;
        const type = item.meta?.type === 'bundle' ? 'Комплект' : 'Товар';
        const supplier = await getSupplierName(item.supplier);
        const stockPosValue = String(getAttrValue(item, attrsMap, 'Складская позиция') || '').toLowerCase();
        const hasStockPosition = stockPosValue === 'true' || stockPosValue === 'да' || stockPosValue === '1';

        let stock = stockMap.get(code)?.stock || 0;
        let stockDays = stockMap.get(code)?.stockDays ?? '';
        let salePrice = stockMap.get(code)?.salePrice || '';
        let buyPrice = item?.buyPrice?.value ? formatMoneyRu(Number(item.buyPrice.value) / 100) : '';
        if (!salePrice) salePrice = extractSalePriceFromItem(item);

        if (type === 'Комплект' && bundleComponents.has(code)) {
            const components = Array.isArray(bundleComponents.get(code)) ? bundleComponents.get(code) : [];
            // Если компоненты комплекта не удалось резолвить (пустой список),
            // не затираем остаток из stock report нулем.
            if (components.length > 0) {
            let minStock = Number.POSITIVE_INFINITY;
            let bundleBuyTotal = 0;
            let hasBundleBuyParts = false;
            for (const comp of components) {
                const cStock = stockMap.get(comp.code)?.stock || 0;
                const bundlesPossible = Math.floor(cStock / Math.max(1, comp.qty));
                minStock = Math.min(minStock, bundlesPossible);

                const compBuy = Number(buyPriceByCode.get(comp.code) || 0);
                if (Number.isFinite(compBuy) && compBuy > 0) {
                    bundleBuyTotal += compBuy * Math.max(1, Number(comp.qty || 1));
                    hasBundleBuyParts = true;
                }
            }
            stock = Number.isFinite(minStock) ? Math.max(0, minStock) : 0;
            stockDays = '';
            if (hasBundleBuyParts && bundleBuyTotal > 0) {
                buyPrice = formatMoneyFixed2(bundleBuyTotal);
            }
            }
        }

        const vat = item.vat === 0 || item.vat === '0' ? 'без НДС' : String(item.vat || '').replace('%', '');
        const vatOnProductRaw = getAttrValue(item, attrsMap, 'НДС на товаре или комплекте');
        const vatOnProduct = vatOnProductRaw === 0 || vatOnProductRaw === '0' ? 'без НДС' : String(vatOnProductRaw || '');

        /**
         * Неснижаемый остаток — нативное поле МС API `product.minimumBalance`
         * (число, в основной единице измерения). У `Комплектов` поле в МС не
         * задаётся — оставляем `NULL`, чтобы UI не путал «нет норматива» и
         * «норматив = 0». Если `minimumBalance` пришёл, но не числовой
         * (например, пустая строка) — тоже `NULL`, чтобы не «затирать»
         * корректный 0 шумом.
         */
        let minStockValue = null;
        if (type !== 'Комплект' && item && Object.prototype.hasOwnProperty.call(item, 'minimumBalance')) {
            const mb = Number(item.minimumBalance);
            if (Number.isFinite(mb)) minStockValue = mb;
        }

        exportRows.push([
            code,
            item.name || '',
            String(getAttrValue(item, attrsMap, 'Менеджер поддерживающий товар') || ''),
            String(getAttrValue(item, attrsMap, 'Ответственный контент-менджер') || ''),
            moyskladEntityUuid(item),
            type,
            hasStockPosition ? 'Да' : 'Нет',
            (getAttrValue(item, attrsMap, 'Перестали сотрудничать / Не производится (дет.в комментах)') ? 'Да' : 'Нет'),
            String(getAttrValue(item, attrsMap, 'Проработка цены / коммент') || ''),
            vat,
            vatOnProduct,
            supplier,
            String(getAttrValue(item, attrsMap, 'Поставщик 2') || ''),
            String(getAttrValue(item, attrsMap, 'Автоматизация цены') || ''),
            String(getAttrValue(item, attrsMap, '!-Упаковка товара для склада (стандартные коробки)') || ''),
            String(getAttrValue(item, attrsMap, '!-Упаковка товара, который отправляется в своей коробке (Д*Ш*В) в см') || ''),
            String(getAttrValue(item, attrsMap, '!-Вес товара с учетом коробки/пакета') || ''),
            salePrice,
            buyPrice,
            minStockValue,
            stock,
            String(stockDays),
            toBinaryFlag(item.archived),
            String(getAttrValue(item, attrsMap, 'Код товара для медмаркета') || ''),
            tsLabel,
        ]);
        jobState.processed += 1;
        if (jobState.processed % 100 === 0) {
            jobState.message = `Подготовлено ${jobState.processed}/${jobState.total}`;
            if (jobState.processed % 1000 === 0) {
                addLog(`Подготовлено строк: ${jobState.processed}/${jobState.total}`);
            }
            await new Promise((resolve) => setImmediate(resolve));
        }
    }

    exportRows.sort((a, b) => String(a[0]).localeCompare(String(b[0]), 'ru'));

    addLog('Этап 6/6: сохранение в ms_export');
    jobState.message = 'Сохранение в БД...';
    ensureNotCancelled();
    await db.query('TRUNCATE TABLE ms_export');
    if (exportRows.length > 0) {
        // Батчированная вставка. Раньше шла одной командой `INSERT ... VALUES ?`
        // на все ~60k строк × 23 колонки — в реальной выгрузке это формирует SQL
        // в десятки/сотни МБ (длинные `name`, `price_comment`, `packing_*` и т.п.)
        // и упирается либо в `max_allowed_packet` MySQL (по умолчанию 64–256 МБ),
        // либо в OOM Node при формировании буфера. На боевом стенде Node после
        // этого молча уходил, pm2/systemd рестартовал процесс, в журнале синка
        // оставался последний `Этап 6/6: сохранение в ms_export`, а UI после
        // рестарта показывал `jobState = {active:false, message:'Ожидание',
        // total:0, processed:0}` — внешне «зависание на час».
        //
        // chunk=2000 даёт ≈150–250 КБ payload на запрос — безопасно даже при
        // самом строгом `max_allowed_packet` и не дёргает OOM. Прогресс-лог
        // ставим каждые 5 чанков (≈10k строк) и обязательно — на последнем,
        // чтобы пользователь видел движение. `setImmediate` между чанками
        // освобождает event-loop, чтобы /api/moysklad/sync/status и /cancel
        // продолжали отвечать во время сохранения.
        const exportChunkSize = 2000;
        const totalRowsToInsert = exportRows.length;
        const insertSql = `
            INSERT INTO ms_export (
                code, name, manager, content_manager, uuid, type, stock_position, no_longer_cooperation,
                price_comment, vat, vat_on_product, supplier, supplier2, automation_price,
                packing_standard, packing_own_box, packing_weight, sale_price, buy_price, min_stock, stock, stock_days, is_archived, medmarket_product_code, updated_label
            ) VALUES ?
        `;
        let insertedRows = 0;
        let chunkIdx = 0;
        for (let i = 0; i < totalRowsToInsert; i += exportChunkSize) {
            ensureNotCancelled();
            const chunk = exportRows.slice(i, i + exportChunkSize);
            await db.query(insertSql, [chunk]);
            insertedRows += chunk.length;
            chunkIdx += 1;
            jobState.message = `Сохранение в ms_export: ${insertedRows}/${totalRowsToInsert}`;
            if (chunkIdx % 5 === 0 || insertedRows >= totalRowsToInsert) {
                addLog(`Сохранено в ms_export: ${insertedRows}/${totalRowsToInsert}`);
            }
            await new Promise((resolve) => setImmediate(resolve));
        }
        // Снимаем пик памяти перед `saveMoyskladEntityDetails`: `exportRows`
        // больше не нужен (уже в БД), а `all` ниже будет потоково обработан в
        // `saveMoyskladEntityDetails`. Без этого пик `all` (57k сущностей с
        // полными МС-карточками) + `exportRows` (~50–100 МБ) суммарно подбирался
        // под лимит heap Node, и сборка `payload_json` ловила OOM.
        // `length` уже зафиксирован в `totalRowsToInsert` — используем его дальше.
    }
    try {
        const { scanned } = await syncZeroStockLogAfterMoyskladExport(db);
        addLog(
            `Нулевые остатки (лог за сегодня): склад.поз.=Да, не архив, stock≤0 или база без «-» и stock < min(суффикс в кодах «код-число») — кандидатов ${scanned}, upsert выполнен (source=moysklad_sync; manual за день не перезаписываем).`,
        );
    } catch (e) {
        addLog(`Нулевые остатки: не удалось обновить лог — ${e && e.message ? e.message : String(e)}`);
    }
    try {
        const snapKeep = Math.max(30, Math.min(3650, Math.round(Number(settings.product_stock_snapshot_retention_days) || 365)));
        const { upserted } = await syncProductStockSnapshotsAfterMoyskladExport(db, snapKeep);
        addLog(
            `Снимки остатка ms_export: за сегодня upsert строк ≈${upserted}; из dg_product_stock_snapshot удалены даты старше ${snapKeep} дн. (product_stock_snapshot_retention_days).`,
        );
    } catch (e) {
        addLog(`Снимки остатка: не удалось записать — ${e && e.message ? e.message : String(e)}`);
    }
    const exportRowsSavedCount = exportRows.length;
    exportRows.length = 0;

    // `inTransit` / `reserve` в ответе `entity/product` с текущим expand часто отсутствуют;
    // в `report/stock/all` они есть — подмешиваем в объекты карточек перед записью в `ms_entity_details`,
    // чтобы закупки/карточка товара читали те же поля из payload_json.
    for (const item of all) {
        if (!item || typeof item !== 'object') continue;
        const code = normalizeCode(item.code);
        if (!code) continue;
        const sm = stockMap.get(code);
        if (!sm) continue;
        if (sm.inTransit != null && Number.isFinite(sm.inTransit)) {
            item.inTransit = sm.inTransit;
        }
        if (sm.reserve != null && Number.isFinite(sm.reserve)) {
            item.reserve = sm.reserve;
        }
    }

    addLog('Сохранение полных карточек МойСклад...');
    jobState.message = 'Сохранение полных карточек МойСклад...';
    ensureNotCancelled();
    let lastDetailLogPct = -1;
    const detailSaved = await saveMoyskladEntityDetails(db, all, 'sync', ({ processed, total }) => {
        jobState.message = `Сохранение полных карточек МойСклад: ${processed}/${total}`;
        const pct = total > 0 ? Math.floor((processed / total) * 100) : 0;
        /** В журнал — только на круглых % (5/10/.../100), чтобы не засорять 30-строчный буфер. */
        if (pct >= lastDetailLogPct + 5 || processed >= total) {
            lastDetailLogPct = pct;
            addLog(`Сохранение полных карточек МойСклад: ${processed}/${total} (${pct}%)`);
        }
    });

    jobState.active = false;
    jobState.done = true;
    jobState.cancelRequested = false;
    jobState.message = `Готово. Записей: ${exportRowsSavedCount}; карточек: ${detailSaved}`;
    addLog(jobState.message);
}

function createMoyskladRouter(db, settings, config) {
    moyskladSyncLogDb = db;
    ensureMsArchivedColumn(db).catch(() => {});
    ensureMsMinStockColumn(db).catch(() => {});
    ensureMsEntityDetailsTable(db).catch(() => {});
    async function triggerMsSyncNow() {
        if (jobState.active) return { started: false, reason: 'already_running' };
        msStatsCache.clear();
        syncMsExport(db, config, settings).catch((e) => {
            jobState.active = false;
            jobState.done = true;
            jobState.cancelRequested = false;
            jobState.message = `Ошибка: ${e.message}`;
            addLog(jobState.message);
        });
        return { started: true };
    }
    createMoyskladRouter.triggerSync = triggerMsSyncNow;

    async function ensureSourceLinksCache(force = false) {
        const now = Date.now();
        if (!force && sourceLinksCacheReady && (now - sourceLinksCacheLastBuiltAt) < SOURCE_LINKS_CACHE_TTL_MS) return;
        if (sourceLinksCacheBuildPromise) {
            await sourceLinksCacheBuildPromise;
            return;
        }
        sourceLinksCacheBuildPromise = (async () => {
            await db.query(`
                CREATE TABLE IF NOT EXISTS source_links_cache (
                    source_id VARCHAR(255) PRIMARY KEY,
                    site_names TEXT,
                    linked_sites INT DEFAULT 0,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                    INDEX idx_slc_updated (updated_at)
                )
            `);
            await db.query('DELETE FROM source_links_cache');
            await db.query(`
                INSERT INTO source_links_cache (source_id, site_names, linked_sites)
                SELECT
                    mp.source_id,
                    GROUP_CONCAT(DISTINCT ms.name ORDER BY ms.name SEPARATOR ', ') AS site_names,
                    COUNT(DISTINCT mp.site_id) AS linked_sites
                FROM my_products mp
                JOIN my_sites ms ON ms.id = mp.site_id
                WHERE mp.is_active = 1
                  AND mp.source_id IS NOT NULL
                  AND mp.source_id <> ''
                GROUP BY mp.source_id
            `);
            sourceLinksCacheReady = true;
            sourceLinksCacheLastBuiltAt = Date.now();
        })();
        try {
            await sourceLinksCacheBuildPromise;
        } finally {
            sourceLinksCacheBuildPromise = null;
        }
    }

    async function recalcBundleStocksFromCache(onProgress) {
        await ensureMsEntityDetailsTable(db);

        const token = getToken(config);
        const headers = token ? { Authorization: `Bearer ${token}` } : null;
        const assortmentCodeCache = new Map();

        const [stockRows] = await db.query(
            `SELECT UPPER(TRIM(COALESCE(code, ''))) AS code_key, COALESCE(stock, 0) AS stock
             FROM ms_export
             WHERE COALESCE(code, '') <> ''`
        );
        const stockByCode = new Map();
        for (const row of stockRows || []) {
            const codeKey = String(row.code_key || '').trim();
            if (!codeKey) continue;
            stockByCode.set(codeKey, Number(row.stock || 0));
        }

        const [bundleRows] = await db.query(
            `SELECT code, payload_json
             FROM ms_entity_details
             WHERE kind = 'bundle'
               AND COALESCE(code, '') <> ''`
        );

        let updated = 0;
        let skippedNoComponents = 0;
        let skippedUnresolved = 0;
        let exportNoRow = 0;
        let errors = 0;
        let processed = 0;

        for (const row of bundleRows || []) {
            try {
                const bundleCode = normalizeCode(row.code);
                if (!bundleCode) {
                    skippedUnresolved += 1;
                    continue;
                }

                let payload = null;
                try {
                    payload = row.payload_json ? JSON.parse(row.payload_json) : null;
                } catch (_) {
                    payload = null;
                }
                const compRows = Array.isArray(payload?.components?.rows) ? payload.components.rows : [];
                if (!compRows.length) {
                    skippedNoComponents += 1;
                    continue;
                }

                let minStock = Number.POSITIVE_INFINITY;
                let allResolved = true;
                let resolvedCount = 0;

                for (const comp of compRows) {
                    const qty = Math.max(1, Number(comp?.quantity || 1));
                    let compCode = '';
                    if (headers) {
                        compCode = await resolveAssortmentCode(comp?.assortment, headers, assortmentCodeCache);
                    } else {
                        compCode = normalizeCode(comp?.assortment?.code || comp?.assortment?.article || '');
                    }
                    if (!compCode) {
                        allResolved = false;
                        continue;
                    }
                    const compStock = Number(stockByCode.get(compCode) || 0);
                    const bundlesPossible = Math.floor(compStock / qty);
                    minStock = Math.min(minStock, bundlesPossible);
                    resolvedCount += 1;
                }

                if (!allResolved || resolvedCount === 0 || !Number.isFinite(minStock)) {
                    skippedUnresolved += 1;
                    continue;
                }

                const nextStock = Math.max(0, minStock);
                const [r] = await db.query(
                    `UPDATE ms_export
                     SET stock = ?
                     WHERE code = ? AND type = 'Комплект'`,
                    [nextStock, bundleCode]
                );
                if (Number(r?.affectedRows || 0) > 0) {
                    updated += 1;
                } else {
                    exportNoRow += 1;
                }
            } catch (_) {
                errors += 1;
            }
            processed += 1;
            if (typeof onProgress === 'function' && (processed % 100 === 0 || processed === bundleRows.length)) {
                onProgress({
                    total_bundles: Number((bundleRows || []).length || 0),
                    processed,
                    updated,
                    skipped_no_components: skippedNoComponents,
                    skipped_unresolved: skippedUnresolved,
                    export_no_row: exportNoRow,
                    errors
                });
                await new Promise((resolve) => setImmediate(resolve));
            }
        }

        msStatsCache.clear();
        return {
            total_bundles: Number((bundleRows || []).length || 0),
            updated,
            skipped_no_components: skippedNoComponents,
            skipped_unresolved: skippedUnresolved,
            export_no_row: exportNoRow,
            errors
        };
    }
    async function startBundleRecalcBackground() {
        if (bundleRecalcState.active) return { started: false, reason: 'already_running' };
        bundleRecalcState.active = true;
        bundleRecalcState.started_at = new Date().toISOString();
        bundleRecalcState.finished_at = null;
        bundleRecalcState.total_bundles = 0;
        bundleRecalcState.processed = 0;
        bundleRecalcState.updated = 0;
        bundleRecalcState.skipped_no_components = 0;
        bundleRecalcState.skipped_unresolved = 0;
        bundleRecalcState.export_no_row = 0;
        bundleRecalcState.errors = 0;
        bundleRecalcState.message = 'Пересчитываем остатки комплектов...';

        recalcBundleStocksFromCache((p) => {
            bundleRecalcState.total_bundles = Number(p.total_bundles || 0);
            bundleRecalcState.processed = Number(p.processed || 0);
            bundleRecalcState.updated = Number(p.updated || 0);
            bundleRecalcState.skipped_no_components = Number(p.skipped_no_components || 0);
            bundleRecalcState.skipped_unresolved = Number(p.skipped_unresolved || 0);
            bundleRecalcState.export_no_row = Number(p.export_no_row || 0);
            bundleRecalcState.errors = Number(p.errors || 0);
            bundleRecalcState.message = `Пересчет комплектов: ${bundleRecalcState.processed}/${bundleRecalcState.total_bundles}`;
        })
            .then((result) => {
                bundleRecalcState.active = false;
                bundleRecalcState.finished_at = new Date().toISOString();
                bundleRecalcState.total_bundles = Number(result.total_bundles || 0);
                bundleRecalcState.processed = Number(result.total_bundles || 0);
                bundleRecalcState.updated = Number(result.updated || 0);
                bundleRecalcState.skipped_no_components = Number(result.skipped_no_components || 0);
                bundleRecalcState.skipped_unresolved = Number(result.skipped_unresolved || 0);
                bundleRecalcState.export_no_row = Number(result.export_no_row || 0);
                bundleRecalcState.errors = Number(result.errors || 0);
                bundleRecalcState.message = 'Пересчет остатков комплектов завершен';
            })
            .catch((e) => {
                bundleRecalcState.active = false;
                bundleRecalcState.finished_at = new Date().toISOString();
                bundleRecalcState.message = `Ошибка пересчета: ${e.message || e}`;
                bundleRecalcState.errors = Number(bundleRecalcState.errors || 0) + 1;
            });

        return { started: true };
    }
    router.post('/sync', async (_req, res) => {
        const r = await triggerMsSyncNow();
        if (!r.started) return res.status(409).json({ error: 'Синхронизация уже запущена' });
        res.json({ success: true, started: true });
    });

    router.post('/stop', async (_req, res) => {
        if (!jobState.active) {
            return res.status(409).json({ error: 'Синхронизация не запущена' });
        }
        jobState.cancelRequested = true;
        jobState.message = 'Останавливаем синхронизацию...';
        addLog('Запрошена остановка синхронизации');
        return res.json({ success: true, stopping: true });
    });

    router.post('/rebuild-links-cache', async (_req, res) => {
        try {
            await ensureSourceLinksCache(true);
            return res.json({
                success: true,
                message: 'Кэш связей перестроен',
                built_at: new Date(sourceLinksCacheLastBuiltAt).toISOString()
            });
        } catch (e) {
            return res.status(500).json({ error: e.message });
        }
    });

    router.post('/recalc-bundle-stocks', async (_req, res) => {
        try {
            const start = await startBundleRecalcBackground();
            if (!start.started) {
                return res.status(409).json({ error: 'Пересчёт уже выполняется', code: 'ALREADY_RUNNING' });
            }
            return res.json({
                success: true,
                started: true,
                message: 'Пересчет остатков комплектов запущен'
            });
        } catch (e) {
            return res.status(500).json({ error: e.message || 'Не удалось пересчитать остатки комплектов' });
        }
    });
    router.get('/recalc-bundle-stocks-status', async (_req, res) => {
        return res.json({
            success: true,
            ...bundleRecalcState
        });
    });

    router.get('/status', async (_req, res) => {
        res.json(jobState);
    });

    router.get('/stats', async (req, res) => {
        try {
            const {
                search = '',
                type = 'all',
                archived = 'active',
                supplier = '',
                supplier2 = '',
                manager = '',
                content_manager = '',
                vat = '',
                vat_on_product = '',
                uuid = '',
                packing_standard = '',
                packing_own_box = '',
                packing_weight = '',
                updated_label = '',
                stock_position = 'yes',
                on_site = 'all',
                only_stock = '0',
                no_coop = '0',
                has_buy_price = '0',
                has_price_comment = '0',
                has_automation = '0',
                stock_min,
                stock_max,
                stock_days_min,
                stock_days_max,
                buy_price_min,
                buy_price_max,
                g_code = '',
                g_name = '',
                g_supplier = '',
                g_supplier2 = '',
                g_manager = '',
                g_content_manager = '',
                g_type = '',
                g_stock_min,
                g_stock_max,
                g_archived = 'all'
            } = req.query;

            const stockPosition = String(stock_position).toLowerCase();
            const gridFilters = {
                g_code,
                g_name,
                g_supplier,
                g_supplier2,
                g_manager,
                g_content_manager,
                g_type,
                g_stock_min,
                g_stock_max,
                g_archived
            };
            const baseWhereSql = ' WHERE 1=1';
            const baseParams = [];
            const withJoinBase = ' WHERE 1=1';
            const withJoinParams = [];
            let goodsWhereSql = ' WHERE type IN (?, ?)';
            const goodsWhereParams = ['Товар', 'Комплект'];
            // Для оценки закупа по остатку — и товары, и комплекты (строки выгрузки); без «плакатов» в имени.
            goodsWhereSql += ' AND LOWER(name) NOT LIKE ?';
            goodsWhereParams.push('%плакат%');
            const baseFilter = buildExportFilters({
                search, type, archived, supplier, supplier2, manager, content_manager, vat, vat_on_product, uuid,
                packing_standard, packing_own_box, packing_weight, updated_label, stock_position: stockPosition,
                on_site: 'all', only_stock, no_coop, has_buy_price, has_price_comment, has_automation,
                stock_min, stock_max, stock_days_min, stock_days_max, buy_price_min, buy_price_max,
                ...gridFilters
            }, baseWhereSql, baseParams);
            let whereSql = baseFilter.sql;
            const whereParams = baseFilter.params;

            const withJoinFilter = buildExportFilters({
                search, type, archived, supplier, supplier2, manager, content_manager, vat, vat_on_product, uuid,
                packing_standard, packing_own_box, packing_weight, updated_label, stock_position: stockPosition,
                on_site, only_stock, no_coop, has_buy_price, has_price_comment, has_automation,
                stock_min, stock_max, stock_days_min, stock_days_max, buy_price_min, buy_price_max,
                ...gridFilters
            }, withJoinBase, withJoinParams);

            // Закуп по остатку и сумма штук на складе: те же фильтры, что и для выборки (on_site здесь как в baseFilter).
            goodsWhereSql += whereSql.replace(' WHERE 1=1', '');
            goodsWhereParams.push(...whereParams);

            const statsCacheKey = JSON.stringify({
                search: String(search || ''),
                type: String(type || 'all'),
                archived: String(archived || 'active'),
                supplier: String(supplier || ''),
                supplier2: String(supplier2 || ''),
                manager: String(manager || ''),
                content_manager: String(content_manager || ''),
                vat: String(vat || ''),
                vat_on_product: String(vat_on_product || ''),
                uuid: String(uuid || ''),
                packing_standard: String(packing_standard || ''),
                packing_own_box: String(packing_own_box || ''),
                packing_weight: String(packing_weight || ''),
                updated_label: String(updated_label || ''),
                stock_position: String(stock_position || 'yes'),
                on_site: String(on_site || 'all'),
                only_stock: String(only_stock || '0'),
                no_coop: String(no_coop || '0'),
                has_buy_price: String(has_buy_price || '0'),
                has_price_comment: String(has_price_comment || '0'),
                has_automation: String(has_automation || '0'),
                stock_min: stock_min ?? null,
                stock_max: stock_max ?? null,
                stock_days_min: stock_days_min ?? null,
                stock_days_max: stock_days_max ?? null,
                buy_price_min: buy_price_min ?? null,
                buy_price_max: buy_price_max ?? null,
                g_code: String(g_code || ''),
                g_name: String(g_name || ''),
                g_supplier: String(g_supplier || ''),
                g_supplier2: String(g_supplier2 || ''),
                g_manager: String(g_manager || ''),
                g_content_manager: String(g_content_manager || ''),
                g_type: String(g_type || ''),
                g_stock_min: g_stock_min ?? null,
                g_stock_max: g_stock_max ?? null,
                g_archived: String(g_archived || 'all')
            });
            const cached = msStatsCache.get(statsCacheKey);
            if (cached && (Date.now() - cached.ts) < MS_STATS_CACHE_TTL_MS) {
                return res.json(cached.data);
            }

            const [[tot]] = await db.query(`
                SELECT COUNT(*) AS total
                FROM ms_export
                LEFT JOIN source_links_cache slc ON slc.source_id = ms_export.code
                ${withJoinFilter.sql}
            `, withJoinFilter.params);
            const [byType] = await db.query(`
                SELECT type, COUNT(*) AS cnt
                FROM ms_export
                LEFT JOIN source_links_cache slc ON slc.source_id = ms_export.code
                ${withJoinFilter.sql}
                GROUP BY type
            `, withJoinFilter.params);
            const [[stock]] = await db.query(`
                SELECT COALESCE(SUM(stock), 0) AS stock_sum
                FROM ms_export
                LEFT JOIN source_links_cache slc ON slc.source_id = ms_export.code
                ${withJoinFilter.sql}
            `, withJoinFilter.params);
            const [[stockUnits]] = await db.query(`SELECT COALESCE(SUM(stock), 0) AS stock_units FROM ms_export${goodsWhereSql}`, goodsWhereParams);
            const buyToDec = `CAST(
                REPLACE(
                    REPLACE(
                        REPLACE(
                            REPLACE(buy_price, '₽', ''),
                            ' ',
                            ''
                        ),
                        ' ',
                        ''
                    ),
                    ',',
                    '.'
                ) AS DECIMAL(15,2)
            )`;
            const lineVal = `CASE
                WHEN buy_price IS NULL OR buy_price = '' THEN 0
                ELSE stock * COALESCE(${buyToDec}, 0)
            END`;
            const [[invSplit]] = await db.query(
                `
                SELECT
                    COALESCE(SUM(CASE WHEN type = 'Товар' THEN ${lineVal} ELSE 0 END), 0) AS inventory_value_products,
                    COALESCE(SUM(CASE WHEN type = 'Комплект' THEN ${lineVal} ELSE 0 END), 0) AS inventory_value_bundles
                FROM ms_export${goodsWhereSql}
            `,
                goodsWhereParams
            );
            let products = 0;
            let bundles = 0;
            for (const row of byType) {
                if (row.type === 'Товар') products = Number(row.cnt || 0);
                if (row.type === 'Комплект') bundles = Number(row.cnt || 0);
            }
            const response = {
                total: Number(tot?.total || 0),
                products,
                bundles,
                stock_sum: Number(stock?.stock_sum || 0),
                stock_units: Number(stockUnits?.stock_units || 0),
                inventory_value_products: Number(invSplit?.inventory_value_products || 0),
                inventory_value_bundles: Number(invSplit?.inventory_value_bundles || 0)
            };
            msStatsCache.set(statsCacheKey, { ts: Date.now(), data: response });
            return res.json(response);
        } catch (e) {
            return res.status(500).json({ error: e.message });
        }
    });

    /**
     * Полная карточка сущности из API МойСклад (по uuid из ms_export), в т.ч. все атрибуты.
     * Отдельный GET от ночной синхронизации: учитывайте лимиты API при массовом открытии.
     * Query: kind — подсказка типа: `product` | `bundle` | строка с «комплект» (как в ms_export.type).
     */
    router.get('/detail/:uuid', async (req, res) => {
        try {
            const uuid = String(req.params.uuid || '').trim();
            const kindHint = String(req.query.kind || '').trim().toLowerCase();
            if (!uuid || uuid.length < 10) {
                return res.status(400).json({ error: 'Некорректный uuid' });
            }
            const token = getToken(config);
            const headers = token ? { Authorization: `Bearer ${token}` } : null;
            const preferBundle = kindHint.includes('комплект') || kindHint === 'bundle';

            let entity = null;
            let kind = 'product';
            let detailSource = 'db';

            async function loadProduct() {
                if (!headers) throw new Error('MS_TOKEN не задан (env MS_TOKEN или config.msToken)');
                const r = await axios.get(`${BASE_URL}/entity/product/${encodeURIComponent(uuid)}`, {
                    headers,
                    timeout: 45000,
                    params: { expand: MS_DETAIL_EXPAND_PRODUCT }
                });
                return r.data;
            }
            async function loadBundle() {
                if (!headers) throw new Error('MS_TOKEN не задан (env MS_TOKEN или config.msToken)');
                const r = await axios.get(`${BASE_URL}/entity/bundle/${encodeURIComponent(uuid)}`, {
                    headers,
                    timeout: 45000,
                    params: { expand: MS_DETAIL_EXPAND_BUNDLE }
                });
                return r.data;
            }

            const stored = await loadMoyskladEntityDetail(db, uuid);
            if (stored && stored.entity) {
                entity = stored.entity;
                kind = stored.kind;
            }

            if (!entity) {
                if (!headers) {
                    return res.status(503).json({ error: 'MS_TOKEN не задан (env MS_TOKEN или config.msToken)' });
                }
                detailSource = 'api';
                if (preferBundle) {
                    try {
                        entity = await loadBundle();
                        kind = 'bundle';
                    } catch (e1) {
                        const st1 = e1.response?.status;
                        if (st1 !== 404) throw e1;
                        entity = await loadProduct();
                        kind = 'product';
                    }
                } else {
                    try {
                        entity = await loadProduct();
                        kind = 'product';
                    } catch (e2) {
                        const st2 = e2.response?.status;
                        if (st2 !== 404) throw e2;
                        entity = await loadBundle();
                        kind = 'bundle';
                    }
                }
                await saveMoyskladEntityDetails(db, entity, 'detail');
            }

            if (!headers) {
                return res.status(503).json({ error: 'MS_TOKEN не задан (env MS_TOKEN или config.msToken)' });
            }
            let msExportSupplier = '';
            try {
                const [seRows] = await db.query(
                    `SELECT supplier
                     FROM ms_export
                     WHERE uuid = ?
                     LIMIT 1`,
                    [uuid]
                );
                msExportSupplier = String(seRows?.[0]?.supplier || '').trim();
            } catch (_) {
                msExportSupplier = '';
            }
            if (entity?.uom && (!entity.uom.name || !String(entity.uom.name).trim())) {
                const uomName = await resolveMsMetaNameByHref(headers, entity.uom);
                if (uomName) entity.uom.name = uomName;
            }
            if (entity?.supplier && (!entity.supplier.name || !String(entity.supplier.name).trim())) {
                const supplierName = msExportSupplier || (await resolveMsMetaNameByHref(headers, entity.supplier));
                if (supplierName) entity.supplier.name = supplierName;
            }
            if (entity?.country && !String(entity.country?.name || '').trim()) {
                const countryName = await resolveMsMetaNameByHref(headers, entity.country);
                if (countryName) entity.country.name = countryName;
            }
            if (entity?.countryOfOrigin && !String(entity.countryOfOrigin?.name || '').trim()) {
                const cooName = await resolveMsMetaNameByHref(headers, entity.countryOfOrigin);
                if (cooName) entity.countryOfOrigin.name = cooName;
            }
            const attrMeta = await getMsProductAttributesMeta(headers);
            const { webHref, blocks } = buildMoyskladDetailPayload(attrMeta, entity, kind);
            return res.json({
                success: true,
                uuid,
                kind,
                source: detailSource,
                webHref,
                blocks
            });
        } catch (e) {
            const st = e.response?.status;
            const err0 = e.response?.data?.errors?.[0];
            const msg = err0?.error || err0?.errorMessage || e.message || 'Ошибка МойСклад';
            if (st === 401 || st === 403) {
                return res.status(st).json({ error: String(msg), status: st });
            }
            return res.status(502).json({ error: String(msg), status: st || null });
        }
    });

    router.get('/export', async (req, res) => {
        try {
            await ensureSourceLinksCache(false);
            const {
                search = '',
                type = 'all',
                archived = 'active',
                supplier = '',
                supplier2 = '',
                manager = '',
                content_manager = '',
                vat = '',
                vat_on_product = '',
                uuid = '',
                packing_standard = '',
                packing_own_box = '',
                packing_weight = '',
                updated_label = '',
                on_site = 'all',
                stock_position = 'yes',
                only_stock = '0',
                no_coop = '0',
                has_buy_price = '0',
                has_price_comment = '0',
                has_automation = '0',
                stock_min,
                stock_max,
                stock_days_min,
                stock_days_max,
                buy_price_min,
                buy_price_max,
                g_code = '',
                g_name = '',
                g_supplier = '',
                g_supplier2 = '',
                g_manager = '',
                g_content_manager = '',
                g_type = '',
                g_stock_min,
                g_stock_max,
                g_archived = 'all',
                limit = 100,
                offset = 0,
                sort_by = 'code',
                sort_dir = 'asc'
            } = req.query;
            const l = Math.max(1, Math.min(parseInt(limit, 10) || 100, 500));
            const o = Math.max(0, parseInt(offset, 10) || 0);
            const allowedSortFields = new Set([
                'code', 'name', 'manager', 'content_manager', 'type',
                'stock_position', 'no_longer_cooperation', 'min_stock', 'stock', 'stock_days',
                'price_comment', 'vat', 'vat_on_product', 'buy_price', 'sale_price',
                'supplier', 'supplier2', 'automation_price',
                'packing_standard', 'packing_own_box', 'packing_weight', 'updated_label',
                'uuid', 'is_archived', 'medmarket_product_code'
            ]);
            const sortField = allowedSortFields.has(String(sort_by)) ? String(sort_by) : 'code';
            const sortDirection = String(sort_dir).toLowerCase() === 'desc' ? 'DESC' : 'ASC';
            let q = `
                SELECT
                    ms_export.*,
                    CASE WHEN slc.source_id IS NULL THEN 0 ELSE 1 END AS in_my_products,
                    COALESCE(slc.site_names, '') AS site_names
                FROM ms_export
                LEFT JOIN source_links_cache slc ON slc.source_id = ms_export.code
                WHERE 1=1
            `;
            let qc = `
                SELECT COUNT(*) as total
                FROM ms_export
                LEFT JOIN source_links_cache slc ON slc.source_id = ms_export.code
                WHERE 1=1
            `;
            const p = [];
            const pc = [];

            const filters = buildExportFilters({
                search, type, archived, supplier, supplier2, manager, content_manager, vat, vat_on_product, uuid,
                packing_standard, packing_own_box, packing_weight, updated_label,
                on_site, stock_position,
                only_stock, no_coop, has_buy_price, has_price_comment, has_automation,
                stock_min, stock_max, stock_days_min, stock_days_max, buy_price_min, buy_price_max,
                g_code,
                g_name,
                g_supplier,
                g_supplier2,
                g_manager,
                g_content_manager,
                g_type,
                g_stock_min,
                g_stock_max,
                g_archived
            }, ' AND 1=1', []);
            q += filters.sql;
            qc += filters.sql;
            p.push(...filters.params);
            pc.push(...filters.params);
            q += ` ORDER BY ${sortField} ${sortDirection} LIMIT ? OFFSET ?`;
            p.push(l, o);

            const [rows] = await db.query(q, p);
            const [count] = await db.query(qc, pc);
            res.json({
                data: rows,
                total: count[0].total,
                limit: l,
                offset: o,
                sort_by: sortField,
                sort_dir: sortDirection.toLowerCase()
            });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    return router;
}

createMoyskladRouter.getJobState = function getJobState() {
    return {
        active: Boolean(jobState.active),
        done: Boolean(jobState.done),
        processed: Number(jobState.processed || 0),
        total: Number(jobState.total || 0),
        message: jobState.message || '',
        logs: Array.isArray(jobState.logs) ? [...jobState.logs] : [],
        updatedAt: jobState.updatedAt || null
    };
};

/** Последние строки журнала синка из БД (переживают рестарт Node). */
createMoyskladRouter.fetchMsSyncPersistedLogs = async function fetchMsSyncPersistedLogs(db, limit) {
    if (!db) return [];
    const lim = Math.max(10, Math.min(Number(limit) || 50, 200));
    try {
        await ensureMsSyncLogTable(db);
        const [rows] = await db.query('SELECT created_at, line FROM dg_ms_sync_log ORDER BY id DESC LIMIT ?', [lim]);
        const list = rows || [];
        return list.slice().reverse();
    } catch (_) {
        return [];
    }
};

/**
 * Все строки журнала синка МС за конкретный календарный день в Москве.
 * Используется страницей /processes.html (фильтр «За день»).
 */
createMoyskladRouter.fetchMsSyncPersistedLogsForDate = async function fetchMsSyncPersistedLogsForDate(db, moscowDate) {
    if (!db) return [];
    const d = String(moscowDate || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return [];
    try {
        await ensureMsSyncLogTable(db);
        /**
         * Сравниваем по календарной дате МСК независимо от session timezone MySQL.
         * Сортировка DESC: новые шаги — сверху на UI (не заставляем пользователя
         * листать вниз каждый раз, когда открывает «Логи»).
         */
        const [rows] = await db.query(
            `SELECT created_at, line
             FROM dg_ms_sync_log
             WHERE created_at >= DATE_SUB(?, INTERVAL 1 DAY)
               AND created_at < DATE_ADD(?, INTERVAL 2 DAY)
             ORDER BY id DESC
             LIMIT 5000`,
            [d, d]
        );
        const list = Array.isArray(rows) ? rows : [];
        return list.filter((r) => {
            try {
                const moscow = new Date(r.created_at).toLocaleDateString('en-CA', { timeZone: 'Europe/Moscow' });
                return moscow === d;
            } catch (_) {
                return false;
            }
        });
    } catch (_) {
        return [];
    }
};

module.exports = createMoyskladRouter;
