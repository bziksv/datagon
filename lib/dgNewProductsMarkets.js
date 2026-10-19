'use strict';

/**
 * Логика вкладки «Размещение на маркеты» для dg_new_products (channel=marketplaces).
 */

const axios = require('axios');
const { loadHucksterSnapshot } = require('./hucksterSnapshotStore');

const MS_BASE_URL = 'https://api.moysklad.ru/api/remap/1.2';
const MS_PRODUCT_EXPAND =
    'attributes,supplier,images,country,uom,salePrices,buyPrice,minPrice,barcodes,countryOfOrigin,productFolder';

const MANUAL_LOCK_STATUSES = new Set(['not_cooperate', 'in_bundle']);
/** Ручной workflow контента/проверки — авто-логика МП не перетирает. */
const WORKFLOW_STATUSES = new Set(['in_progress', 'review', 'verified', 'revision']);
const MARKETS_STATUSES = new Set([
    'new',
    'not_added',
    'in_progress',
    'added',
    'revision',
    'review',
    'verified',
    'not_cooperate',
    'in_bundle',
    'removed',
]);

const MARKETS_STATUS_LABELS = {
    new: 'Новый',
    not_added: 'Не добавлен',
    in_progress: 'В работе',
    added: 'Добавлен',
    revision: 'На доработке',
    review: 'На проверку',
    verified: 'Проверен',
    not_cooperate: 'Не сотрудничаем',
    in_bundle: 'В составе комплекта',
    removed: 'Удалённые',
};

const MARKETS_REQUIRED = [
    { key: 'priority', label: 'Приоритет' },
    { key: 'product_code', label: 'Код' },
    { key: 'article', label: 'Артикул' },
    { key: 'title', label: 'Название для маркетов' },
    { key: 'barcode', label: 'Штрихкод' },
    { key: 'price_markets', label: 'Цена на маркеты' },
    { key: 'vat', label: 'НДС' },
    { key: 'ru_url', label: 'Ссылка на РУ' },
];

/** Инфографика (вкладка «Размещение на маркеты»). */
const INFOGRAPHIC_LABELS = {
    yes: 'Есть',
    old: 'Старая',
    no: 'Нет',
};
const INFOGRAPHIC_VALUES = new Set(Object.keys(INFOGRAPHIC_LABELS));

/** Huckster — ручной статус (меняет только менеджер маркетплейсов). */
const HUCKSTER_LABELS = {
    yes: 'Добавлено',
    no: 'Не добавлено',
};
const HUCKSTER_VALUES = new Set(Object.keys(HUCKSTER_LABELS));

/** Фото (вкладка «Размещение на маркеты»). */
const PHOTO_LABELS = {
    updated: 'Обновлено',
    need_shoot: 'Нужно отснять',
    need_reshoot: 'Нужно переснять',
    in_package: 'Товар в упаковке',
};
const PHOTO_VALUES = new Set(Object.keys(PHOTO_LABELS));

function normInfographic(v) {
    if (v == null || v === '') return null;
    const k = String(v).trim().toLowerCase();
    return INFOGRAPHIC_VALUES.has(k) ? k : null;
}

function normHuckster(v) {
    if (v == null || v === '') return null;
    const k = String(v).trim().toLowerCase();
    if (k === 'added' || k === '1' || k === 'true') return 'yes';
    if (k === 'not_added' || k === '0' || k === 'false') return 'no';
    return HUCKSTER_VALUES.has(k) ? k : null;
}

function normPhoto(v) {
    if (v == null || v === '') return null;
    const k = String(v).trim().toLowerCase();
    return PHOTO_VALUES.has(k) ? k : null;
}

function clip(s, max) {
    const t = String(s == null ? '' : s).trim();
    if (!max || t.length <= max) return t;
    return t.slice(0, max);
}

function parsePrice(v) {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(String(v).replace(/\s/g, '').replace(',', '.'));
    return Number.isFinite(n) ? n : null;
}

function parseNum(v) {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(String(v).replace(/\s/g, '').replace(',', '.'));
    return Number.isFinite(n) ? n : null;
}

function formatDimensions(row) {
    const ready = String(row.dimensions_text || '').trim();
    if (ready) return ready;
    const L = parseNum(row.length_cm);
    const W = parseNum(row.width_cm);
    const H = parseNum(row.height_cm);
    const Wt = parseNum(row.weight_kg);
    const parts = [];
    if (L != null && W != null && H != null) parts.push(`${L}×${W}×${H} см`);
    else {
        if (L != null) parts.push(`Д ${L}`);
        if (W != null) parts.push(`Ш ${W}`);
        if (H != null) parts.push(`В ${H}`);
    }
    if (Wt != null) parts.push(`${Wt} кг`);
    return parts.join(', ');
}

function hasDimensions(row) {
    return (
        parseNum(row.length_cm) != null &&
        parseNum(row.width_cm) != null &&
        parseNum(row.height_cm) != null &&
        parseNum(row.weight_kg) != null
    );
}

function getMissingRequiredMarkets(row) {
    if (row && (Number(row.main_not_for_sale) === 1 || row.main_not_for_sale === true)) {
        return [];
    }
    const missing = [];
    const prio = String(row.priority || '').trim().toLowerCase();
    if (!['important', 'normal', 'low'].includes(prio)) {
        missing.push({ key: 'priority', label: 'Приоритет' });
    }
    if (!String(row.product_code || '').trim()) missing.push({ key: 'product_code', label: 'Код' });
    if (!String(row.article || '').trim()) missing.push({ key: 'article', label: 'Артикул' });
    if (!String(row.title || '').trim()) missing.push({ key: 'title', label: 'Название для маркетов' });
    if (!String(row.barcode || '').trim()) missing.push({ key: 'barcode', label: 'Штрихкод' });
    if (row.price_markets == null || !Number.isFinite(Number(row.price_markets))) {
        missing.push({ key: 'price_markets', label: 'Цена на маркеты' });
    }
    if (!String(row.vat || '').trim()) missing.push({ key: 'vat', label: 'НДС' });
    if (!String(row.ru_url || '').trim()) missing.push({ key: 'ru_url', label: 'Ссылка на РУ' });
    return missing;
}

function placementAll(row) {
    return Number(row.placement_ozon) === 1 && Number(row.placement_wb) === 1 && Number(row.placement_ym) === 1;
}

/** Более ранняя из двух дат (для first-seen). */
function earlierDate(a, b) {
    if (a == null || a === '') return b != null && b !== '' ? b : null;
    if (b == null || b === '') return a;
    const da = new Date(a);
    const db = new Date(b);
    if (Number.isNaN(da.getTime())) return b;
    if (Number.isNaN(db.getTime())) return a;
    return da.getTime() <= db.getTime() ? a : b;
}

/**
 * Проставляет placement_*_at при первом появлении на МП и синхронизирует placement_date
 * (самая ранняя из дат Ozon/WB/ЯМ). Не затирает уже сохранённые даты.
 * @param {object} target — patch / seed
 * @param {object|null} existing — текущая строка БД
 * @param {object} place — { ozon, wb, ym, ozon_at?, wb_at?, ym_at? }
 */
function applyPlacementAtFields(target, existing, place) {
    if (!target || !place) return target;
    const ex = existing || {};
    const now = new Date();
    if (place.ozon) {
        if (!ex.placement_ozon_at && !target.placement_ozon_at) {
            target.placement_ozon_at = place.ozon_at || now;
        }
    }
    if (place.wb) {
        if (!ex.placement_wb_at && !target.placement_wb_at) {
            target.placement_wb_at = place.wb_at || now;
        }
    }
    if (place.ym) {
        if (!ex.placement_ym_at && !target.placement_ym_at) {
            target.placement_ym_at = place.ym_at || now;
        }
    }
    const dates = [
        target.placement_ozon_at || ex.placement_ozon_at || null,
        target.placement_wb_at || ex.placement_wb_at || null,
        target.placement_ym_at || ex.placement_ym_at || null,
    ].filter((d) => d != null && d !== '');
    if (dates.length && !ex.placement_date && !target.placement_date) {
        target.placement_date = dates.reduce((acc, d) => earlierDate(acc, d), null);
    }
    return target;
}

/**
 * Авто-статус для маркетов.
 * Ручные lock / workflow (В работе / На проверку / Проверен / На доработке) не трогаем.
 * Иначе: комментарий → «На доработке»; на всех МП → «Добавлен»; иначе new/not_added.
 */
function resolveMarketsStatus(currentStatus, merged) {
    const st = String(currentStatus || 'new');
    if (MANUAL_LOCK_STATUSES.has(st) || WORKFLOW_STATUSES.has(st)) {
        return { status: st, changed: false, missing: getMissingRequiredMarkets(merged) };
    }
    const comment = String(merged.comment || '').trim();
    if (comment) {
        return { status: 'revision', changed: st !== 'revision', missing: getMissingRequiredMarkets(merged) };
    }
    if (placementAll(merged)) {
        return { status: 'added', changed: st !== 'added', missing: getMissingRequiredMarkets(merged) };
    }
    const missing = getMissingRequiredMarkets(merged);
    const next = missing.length ? 'new' : 'not_added';
    return { status: next, changed: next !== st, missing };
}

function extractBarcodesFromPayload(payload) {
    if (!payload || !Array.isArray(payload.barcodes)) return '';
    const out = [];
    for (const b of payload.barcodes) {
        if (!b) continue;
        if (typeof b === 'string') {
            const t = b.trim();
            if (t) out.push(t);
            continue;
        }
        const v = b.ean13 || b.ean8 || b.code128 || b.code39 || b.gtin || b.barcode || '';
        const t = String(v || '').trim();
        if (t) out.push(t);
    }
    return out.join(', ');
}

function getMsToken() {
    try {
        // eslint-disable-next-line global-require
        const config = require('../config');
        return String(process.env.MS_TOKEN || (config && config.msToken) || '').trim();
    } catch (_) {
        return String(process.env.MS_TOKEN || '').trim();
    }
}

/** Нормализация ставки НДС как в ms_export (0 → «без НДС»). */
function formatMsVatValue(raw) {
    if (raw === 0 || raw === '0') return 'без НДС';
    if (raw == null || raw === '') return '';
    if (typeof raw === 'boolean') return '';
    let s = String(raw).trim();
    if (!s) return '';
    if (/^без\s*ндс$/i.test(s)) return 'без НДС';
    s = s.replace(/%/g, '').trim();
    if (s === '0') return 'без НДС';
    return s;
}

function attrValueText(val) {
    if (val == null) return '';
    if (typeof val === 'string') return val.trim();
    if (typeof val === 'number' || typeof val === 'boolean') return String(val);
    if (typeof val === 'object') {
        if (val.href) return String(val.href).trim();
        if (val.downloadHref) return String(val.downloadHref).trim();
        if (val.name != null) return String(val.name).trim();
    }
    return String(val).trim();
}

function extractVatFromPayload(payload, rowVat, rowVatOnProduct) {
    const fromRow = formatMsVatValue(rowVat) || formatMsVatValue(rowVatOnProduct);
    if (fromRow) return fromRow;
    if (!payload || typeof payload !== 'object') return '';
    const fromEff = formatMsVatValue(payload.effectiveVat);
    if (fromEff) return fromEff;
    if (payload.vat != null && payload.vat !== '') return formatMsVatValue(payload.vat);
    if (Array.isArray(payload.attributes)) {
        for (const a of payload.attributes) {
            const nm = String((a && a.name) || '')
                .trim()
                .toLowerCase();
            if (nm === 'ндс на товаре или комплекте' || nm === 'ндс') {
                const t = attrValueText(a.value);
                const f = formatMsVatValue(t);
                if (f) return f;
            }
        }
    }
    // useParentVat без effectiveVat — нужен live GET карточки МС
    return '';
}

/**
 * Ссылка на РУ из атрибутов МС.
 * Приоритет: «РУ ссылка на файл» / «Ссылка на РУ»; не матчить короткое «ру»
 * (иначе ловит «Перестали сотрудничать…»).
 */
function extractRuUrlFromPayload(payload) {
    if (!payload || !Array.isArray(payload.attributes)) return '';
    const preferredExact = new Set([
        'ру ссылка на файл',
        'ссылка на ру',
        'ссылка ру',
        'ссылка на регистрационное удостоверение',
    ]);
    const candidates = [];
    for (const a of payload.attributes) {
        if (!a) continue;
        const nm = String(a.name || '').trim().toLowerCase();
        if (!nm) continue;
        const text = attrValueText(a.value);
        if (!text) continue;
        const isUrl = /^https?:\/\//i.test(text);
        const exact = preferredExact.has(nm);
        const soft =
            (nm.includes('ссылка') && nm.includes('ру')) ||
            (nm.includes('регистрацион') && nm.includes('ру') && isUrl);
        if (!exact && !soft) continue;
        candidates.push({ text, isUrl, exact });
    }
    candidates.sort((a, b) => {
        if (a.exact !== b.exact) return a.exact ? -1 : 1;
        if (a.isUrl !== b.isUrl) return a.isUrl ? -1 : 1;
        return 0;
    });
    return candidates.length ? candidates[0].text : '';
}

/**
 * Ссылка «СС, ДС товара ссылка» из атрибутов МС (сертификат / декларация соответствия).
 */
function normalizeMsAttrName(name) {
    return String(name || '')
        .trim()
        .toLowerCase()
        .replace(/[‚，]/g, ',')
        .replace(/\s+/g, ' ');
}

function extractSsDsUrlFromPayload(payload) {
    if (!payload || !Array.isArray(payload.attributes)) return '';
    const preferredExact = new Set([
        'сс, дс товара ссылка',
        'сс дс товара ссылка',
        'ссылка сс дс',
        'ссылка на сс дс',
    ]);
    const candidates = [];
    for (const a of payload.attributes) {
        if (!a) continue;
        const nm = normalizeMsAttrName(a.name);
        if (!nm) continue;
        // Не путать с файловыми «Сертификаты соответствия (СС)» / «Декларация… (ДС)».
        if (nm.includes('серт') || nm.includes('деклар') || /\(сс\)|\(дс\)/.test(nm)) continue;
        const text = attrValueText(a.value);
        if (!text) continue;
        const isUrl = /^https?:\/\//i.test(text);
        const exact = preferredExact.has(nm);
        const soft =
            nm.includes('ссылка') &&
            (nm.includes('сс') || nm.includes('дс')) &&
            !nm.includes('ру');
        if (!exact && !soft) continue;
        candidates.push({ text, isUrl, exact });
    }
    candidates.sort((a, b) => {
        if (a.exact !== b.exact) return a.exact ? -1 : 1;
        if (a.isUrl !== b.isUrl) return a.isUrl ? -1 : 1;
        return 0;
    });
    return candidates.length ? candidates[0].text : '';
}

async function ensureUniqueSourceAlmamedIndex(db) {
    try {
        const [idx] = await db.query(
            `SHOW INDEX FROM dg_new_products WHERE Key_name = 'uq_dg_np_source_almamed'`
        );
        if (Array.isArray(idx) && idx.length) return;
        await db.query(
            `ALTER TABLE dg_new_products
               ADD UNIQUE KEY uq_dg_np_source_almamed (source_almamed_id)`
        );
    } catch (e) {
        // Дубли ещё не почищены / индекс уже есть — не валим старт.
        console.warn('[new-products] uq_dg_np_source_almamed:', e && e.message);
    }
}

/**
 * Убрать дубли marketplaces по одному source_almamed_id (гонка галочек Маркеты/Комплект).
 * Оставляем MIN(id), комплекты переносим на него, остальные → removed + source_almamed_id=NULL.
 */
async function dedupeMarketsBySourceAlmamed(db) {
    const [dups] = await db.query(
        `SELECT source_almamed_id,
                MIN(id) AS keep_id,
                GROUP_CONCAT(id ORDER BY id) AS ids
           FROM dg_new_products
          WHERE channel = 'marketplaces'
            AND status <> 'removed'
            AND source_almamed_id IS NOT NULL
          GROUP BY source_almamed_id
         HAVING COUNT(*) > 1`
    );
    let removed = 0;
    for (const d of dups || []) {
        const keepId = Number(d.keep_id);
        const allIds = String(d.ids || '')
            .split(',')
            .map((x) => Number(x))
            .filter((n) => Number.isFinite(n) && n > 0);
        const dropIds = allIds.filter((id) => id !== keepId);
        if (!dropIds.length) continue;
        await db.query(
            `UPDATE dg_new_product_kits SET parent_product_id = ? WHERE parent_product_id IN (?)`,
            [keepId, dropIds]
        );
        await db.query(
            `UPDATE dg_new_products
                SET status = 'removed', source_almamed_id = NULL, removed_at = NOW(), has_kits = 0
              WHERE id IN (?)`,
            [dropIds]
        );
        removed += dropIds.length;
    }
    if (removed) {
        console.warn('[new-products] dedupe markets by source_almamed_id: removed', removed);
    }
    return { removed };
}

let marketsEnsureDone = false;

async function ensureMarketsColumns(db) {
    if (marketsEnsureDone) return;
    const cols = [
        ['product_code', 'VARCHAR(128) NULL'],
        ['barcode', 'VARCHAR(512) NULL'],
        ['price_markets', 'DECIMAL(14, 2) NULL'],
        ['dimensions_text', 'VARCHAR(512) NULL'],
        ['length_cm', 'DECIMAL(10, 2) NULL'],
        ['width_cm', 'DECIMAL(10, 2) NULL'],
        ['height_cm', 'DECIMAL(10, 2) NULL'],
        ['weight_kg', 'DECIMAL(10, 3) NULL'],
        ['vat', 'VARCHAR(64) NULL'],
        ['ru_url', 'VARCHAR(2048) NULL'],
        ['ss_ds_url', 'TEXT NULL'],
        ['placement_ozon', 'TINYINT(1) NOT NULL DEFAULT 0'],
        ['placement_wb', 'TINYINT(1) NOT NULL DEFAULT 0'],
        ['placement_ym', 'TINYINT(1) NOT NULL DEFAULT 0'],
        ['placement_ozon_url', 'VARCHAR(2048) NULL'],
        ['placement_wb_url', 'VARCHAR(2048) NULL'],
        ['placement_ym_url', 'VARCHAR(2048) NULL'],
        ['placement_ozon_at', 'DATETIME NULL'],
        ['placement_wb_at', 'DATETIME NULL'],
        ['placement_ym_at', 'DATETIME NULL'],
        ['placement_date', 'DATETIME NULL'],
        ['source_almamed_id', 'BIGINT NULL'],
        ['removed_at', 'DATETIME NULL'],
        ['has_kits', 'TINYINT(1) NOT NULL DEFAULT 0'],
        ['main_not_for_sale', 'TINYINT(1) NOT NULL DEFAULT 0'],
        ['collision_detached', 'TINYINT(1) NOT NULL DEFAULT 0'],
        ['channel_num', 'INT NULL'],
        ['infographic', 'VARCHAR(32) NULL'],
        ['photo', 'VARCHAR(32) NULL'],
        ['huckster', 'VARCHAR(32) NULL'],
        ['manager_checked', 'TINYINT(1) NOT NULL DEFAULT 0'],
        ['manager_checked_at', 'DATETIME NULL'],
        ['manager_checked_by_user_id', 'INT NULL'],
        ['manager_comment', 'TEXT NULL'],
    ];
    // Один SHOW COLUMNS вместо N round-trip LIKE на удалённой MySQL.
    const [existingCols] = await db.query('SHOW COLUMNS FROM `dg_new_products`');
    const have = new Set((existingCols || []).map((r) => String(r.Field || '')));
    for (const [name, def] of cols) {
        if (have.has(name)) continue;
        await db.query(`ALTER TABLE \`dg_new_products\` ADD COLUMN \`${name}\` ${def}`);
        have.add(name);
    }
    await backfillChannelNums(db);
    await dedupeMarketsBySourceAlmamed(db);
    await softRemoveOrphanMarkets(db);
    await ensureUniqueSourceAlmamedIndex(db);
    await db.query(`
        CREATE TABLE IF NOT EXISTS dg_new_product_kits (
            id BIGINT AUTO_INCREMENT PRIMARY KEY,
            parent_product_id BIGINT NOT NULL,
            title VARCHAR(255) NOT NULL DEFAULT '',
            sort_order INT NOT NULL DEFAULT 0,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            INDEX idx_dg_np_kits_parent (parent_product_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    const kitCols = [
        ['product_code', 'VARCHAR(128) NULL'],
        ['article', 'VARCHAR(128) NULL'],
        ['barcode', 'VARCHAR(512) NULL'],
        ['price_markets', 'DECIMAL(14, 2) NULL'],
        ['status', "VARCHAR(32) NOT NULL DEFAULT 'new'"],
        ['comment', 'TEXT NULL'],
        ['dimensions_text', 'VARCHAR(512) NULL'],
        ['length_cm', 'DECIMAL(10, 2) NULL'],
        ['width_cm', 'DECIMAL(10, 2) NULL'],
        ['height_cm', 'DECIMAL(10, 2) NULL'],
        ['weight_kg', 'DECIMAL(10, 3) NULL'],
        ['vat', 'VARCHAR(64) NULL'],
        ['ru_url', 'VARCHAR(2048) NULL'],
    ];
    const [existingKitCols] = await db.query('SHOW COLUMNS FROM `dg_new_product_kits`');
    const haveKit = new Set((existingKitCols || []).map((r) => String(r.Field || '')));
    for (const [name, def] of kitCols) {
        if (haveKit.has(name)) continue;
        await db.query(`ALTER TABLE \`dg_new_product_kits\` ADD COLUMN \`${name}\` ${def}`);
        haveKit.add(name);
    }
    marketsEnsureDone = true;
}

function mapKitRow(k) {
    return {
        id: Number(k.id),
        parent_product_id: Number(k.parent_product_id),
        title: k.title || '',
        product_code: k.product_code || '',
        article: k.article || '',
        barcode: k.barcode || '',
        price_markets: k.price_markets != null ? Number(k.price_markets) : null,
        status: k.status || 'new',
        status_label: MARKETS_STATUS_LABELS[k.status] || k.status || 'new',
        comment: k.comment || '',
        dimensions_text: k.dimensions_text || formatDimensions(k) || '',
        length_cm: k.length_cm != null ? Number(k.length_cm) : null,
        width_cm: k.width_cm != null ? Number(k.width_cm) : null,
        height_cm: k.height_cm != null ? Number(k.height_cm) : null,
        weight_kg: k.weight_kg != null ? Number(k.weight_kg) : null,
        vat: k.vat || '',
        ru_url: k.ru_url || '',
        sort_order: Number(k.sort_order) || 0,
        created_at: k.created_at || null,
        updated_at: k.updated_at || null,
    };
}

async function loadKitsByParentIds(db, parentIds) {
    const ids = (parentIds || []).map((id) => Number(id)).filter((id) => Number.isFinite(id) && id > 0);
    const byParent = {};
    ids.forEach((id) => {
        byParent[id] = [];
    });
    if (!ids.length) return byParent;
    const [rows] = await db.query(
        `SELECT * FROM dg_new_product_kits
          WHERE parent_product_id IN (?)
          ORDER BY sort_order ASC, id ASC`,
        [ids]
    );
    (rows || []).forEach((k) => {
        const pid = Number(k.parent_product_id);
        if (!byParent[pid]) byParent[pid] = [];
        byParent[pid].push(mapKitRow(k));
    });
    return byParent;
}

async function attachKitsToMapped(db, mappedRows) {
    const mp = (mappedRows || []).filter((r) => r.channel === 'marketplaces');
    if (!mp.length) {
        (mappedRows || []).forEach((r) => {
            if (!Array.isArray(r.kits)) r.kits = [];
        });
        return mappedRows;
    }
    const byParent = await loadKitsByParentIds(
        db,
        mp.map((r) => r.id)
    );
    mappedRows.forEach((r) => {
        const kits = r.channel === 'marketplaces' ? byParent[r.id] || [] : [];
        // Ссылки РУ / СС·ДС у комплекта — с товара в Датагоне (родитель).
        const parentRu = String(r.ru_url || '').trim();
        const parentSsDs = String(r.ss_ds_url || '').trim();
        r.kits = kits.map((k) => ({
            ...k,
            ru_url: parentRu,
            ss_ds_url: parentSsDs,
        }));
    });
    return mappedRows;
}

async function attachCrossChannelLinks(db, mappedRows) {
    const list = mappedRows || [];
    list.forEach((r) => {
        if (r.markets_product_id == null) r.markets_product_id = null;
        if (r.markets_channel_num == null) r.markets_channel_num = null;
        if (r.source_almamed_channel_num == null) r.source_almamed_channel_num = null;
    });
    const almamedIds = list
        .filter((r) => r.channel === 'almamed')
        .map((r) => Number(r.id))
        .filter((id) => Number.isFinite(id) && id > 0);
    const sourceIds = list
        .filter((r) => r.channel === 'marketplaces' && r.source_almamed_id)
        .map((r) => Number(r.source_almamed_id))
        .filter((id) => Number.isFinite(id) && id > 0);
    try {
        if (almamedIds.length) {
            const [links] = await db.query(
                `SELECT id, channel_num, source_almamed_id, COALESCE(collision_detached, 0) AS collision_detached FROM dg_new_products
                  WHERE channel = 'marketplaces'
                    AND status <> 'removed'
                    AND source_almamed_id IN (?)`,
                [almamedIds]
            );
            const bySrc = {};
            (links || []).forEach((l) => {
                const src = Number(l.source_almamed_id);
                if (!Number.isFinite(src)) return;
                const mid = Number(l.id);
                const prev = bySrc[src];
                if (!prev || mid < prev.id) {
                    bySrc[src] = {
                        id: mid,
                        channel_num: l.channel_num != null ? Number(l.channel_num) : null,
                        collision_detached: Number(l.collision_detached) === 1,
                    };
                }
            });
            list.forEach((r) => {
                if (r.channel !== 'almamed') return;
                const hit = bySrc[r.id];
                r.markets_product_id = hit ? hit.id : null;
                r.markets_channel_num = hit ? hit.channel_num : null;
                if (hit && hit.collision_detached) r.collision_detached = true;
            });
        }
        if (sourceIds.length) {
            const [srcs] = await db.query(
                `SELECT id, channel_num, almamed_url, main_not_for_sale, has_kits, COALESCE(collision_detached, 0) AS collision_detached FROM dg_new_products
                  WHERE channel = 'almamed' AND id IN (?)`,
                [sourceIds]
            );
            const byId = {};
            (srcs || []).forEach((s) => {
                byId[Number(s.id)] = {
                    channel_num: s.channel_num != null ? Number(s.channel_num) : null,
                    almamed_url: String(s.almamed_url || '').trim(),
                    main_not_for_sale: Number(s.main_not_for_sale) === 1,
                    has_kits: Number(s.has_kits) === 1,
                    collision_detached: Number(s.collision_detached) === 1,
                };
            });
            list.forEach((r) => {
                if (r.channel !== 'marketplaces' || !r.source_almamed_id) return;
                const hit = byId[Number(r.source_almamed_id)];
                if (!hit) return;
                r.source_almamed_channel_num = hit.channel_num;
                if (hit.collision_detached) r.collision_detached = true;
                // Ссылка на карточку Альмамед — с родительской строки / для бейджа «АЛЬ»
                if (!String(r.almamed_url || '').trim() && hit.almamed_url && !r.collision_detached) {
                    r.almamed_url = hit.almamed_url;
                }
                if (hit.main_not_for_sale) r.main_not_for_sale = true;
                if (hit.has_kits) r.has_kits = true;
            });
        }
    } catch (_) {
        /* ignore */
    }
    return mappedRows;
}

/**
 * Варианты ключа для стыковки Альмамед ↔ МС ↔ МП.
 * Частый кейс: в очереди `A-40295` (латиница), в ms_export code=`40295`,
 * denorm_article=`А-40295` (кириллица) — точное IN(?) мимо, бейджи серые.
 */
function presenceKeyVariants(raw) {
    const k = String(raw || '').trim();
    if (!k) return [];
    const out = [];
    const seen = new Set();
    const add = (x) => {
        const s = String(x || '').trim();
        if (!s || seen.has(s)) return;
        seen.add(s);
        out.push(s);
    };
    add(k);
    const m = k.match(/^([AАaа])-?(\d+)$/);
    if (m) {
        const digits = m[2];
        add(digits);
        add(`A-${digits}`);
        add(`А-${digits}`);
        add(`a-${digits}`);
        add(`а-${digits}`);
    } else if (/^[AАaа]-/.test(k)) {
        // A-xxx / А-xxx с нецифровым хвостом — хотя бы латиница↔кириллица
        const rest = k.slice(2);
        add(`A-${rest}`);
        add(`А-${rest}`);
    }
    return out;
}

function firstHitByVariants(map, ...raws) {
    for (let i = 0; i < raws.length; i++) {
        const variants = presenceKeyVariants(raws[i]);
        for (let j = 0; j < variants.length; j++) {
            const hit = map[variants[j]];
            if (hit) return hit;
        }
    }
    return null;
}

/**
 * Живые бейджи связей после ID: Альм / Мои (CMS) / МС / Ozon / WB / ЯМ.
 * Читает my_products + ms_export + marketplace_export_rows по коду/артикулу текущей страницы.
 * Не пишет в dg_new_products — только для отображения (после импортов CMS/МС/МП).
 */
const PRESENCE_GAP_KEYS = new Set([
    'no_almamed',
    'no_ms',
    'no_my',
    'no_ozon',
    'no_wb',
    'no_ym',
    'no_huckster',
]);

/** Строка не закрывает бейдж «Связь» по пресету списка. */
function rowMissesPresenceGap(row, gap) {
    const r = row || {};
    const p = r.presence || {};
    const g = String(gap || '').trim();
    if (g === 'no_almamed') {
        const url = String(r.almamed_url || p.my_url || '').trim();
        return !url;
    }
    if (g === 'no_ms') return !p.ms;
    if (g === 'no_my') return !p.my_products;
    if (g === 'no_ozon') return !p.ozon;
    if (g === 'no_wb') return !p.wb;
    if (g === 'no_ym') return !p.ym;
    if (g === 'no_huckster') return !(p.huckster || String(r.huckster || '') === 'yes');
    return false;
}

const presenceGapIdCache = new Map();
const PRESENCE_GAP_CACHE_MS = 45 * 1000;

/**
 * id строк очереди, у которых бейдж «Связь» выключен по пресету.
 * Тот же разбор, что у колонки на экране (варианты A-/А-/цифры, live МП, Huckster).
 */
async function idsMissingPresenceGap(db, whereSql, params, gap) {
    const g = String(gap || '').trim();
    if (!PRESENCE_GAP_KEYS.has(g)) return null;
    const cacheKey = g + '\n' + String(whereSql || '') + '\n' + JSON.stringify(params || []);
    const hit = presenceGapIdCache.get(cacheKey);
    if (hit && Date.now() - hit.ts < PRESENCE_GAP_CACHE_MS) return hit.ids;

    const [slim] = await db.query(
        `SELECT id, channel, product_code, article, almamed_url, ms_product_uuid, huckster,
                placement_ozon, placement_wb, placement_ym, source_almamed_id,
                COALESCE(collision_detached, 0) AS collision_detached
           FROM dg_new_products
          WHERE ${whereSql}`,
        params || []
    );
    const mapped = (slim || []).map((r) => ({
        id: Number(r.id),
        channel: r.channel,
        product_code: r.product_code || '',
        article: r.article || '',
        almamed_url: r.almamed_url || '',
        ms_product_uuid: r.ms_product_uuid || '',
        huckster: r.huckster || '',
        placement_ozon: Number(r.placement_ozon) === 1,
        placement_wb: Number(r.placement_wb) === 1,
        placement_ym: Number(r.placement_ym) === 1,
        source_almamed_id: r.source_almamed_id || null,
        collision_detached: Number(r.collision_detached) === 1,
    }));
    await attachPresenceBadges(db, mapped, {
        scanAll: true,
        awaitHuckster: g === 'no_huckster',
    });
    const ids = mapped
        .filter((r) => rowMissesPresenceGap(r, g))
        .map((r) => Number(r.id))
        .filter((id) => Number.isFinite(id) && id > 0);
    presenceGapIdCache.set(cacheKey, { ts: Date.now(), ids });
    if (presenceGapIdCache.size > 24) {
        const first = presenceGapIdCache.keys().next().value;
        presenceGapIdCache.delete(first);
    }
    return ids;
}

async function attachPresenceBadges(db, mappedRows, opts) {
    const list = mappedRows || [];
    list.forEach((r) => {
        if (!r.presence) {
            r.presence = {
                almamed: false,
                markets: false,
                my_products: false,
                ms: false,
                ozon: !!r.placement_ozon,
                wb: !!r.placement_wb,
                ym: !!r.placement_ym,
                huckster: false,
                ozon_url: r.placement_ozon_url || '',
                wb_url: r.placement_wb_url || '',
                ym_url: r.placement_ym_url || '',
                ms_code: '',
                ms_uuid: '',
                my_sku: '',
            };
        }
        if (r.channel === 'marketplaces' && r.source_almamed_id) r.presence.almamed = true;
        if (r.channel === 'almamed' && r.markets_product_id) r.presence.markets = true;
        if (r.ms_product_uuid && !(r.collision_detached && !String(r.product_code || '').trim())) {
            r.presence.ms = true;
            if (!r.presence.ms_uuid) r.presence.ms_uuid = String(r.ms_product_uuid);
        }
        if (r.collision_detached && !String(r.product_code || '').trim()) {
            r.presence.ozon = false;
            r.presence.wb = false;
            r.presence.ym = false;
            r.presence.ozon_url = '';
            r.presence.wb_url = '';
            r.presence.ym_url = '';
        }
    });

    const keys = [];
    const keySet = new Set();
    list.forEach((r) => {
        const code = String(r.product_code || '').trim();
        const art = r.collision_detached && !code ? '' : String(r.article || '').trim();
        [code, art].forEach((raw) => {
            presenceKeyVariants(raw).forEach((k) => {
                if (keySet.has(k)) return;
                keySet.add(k);
                keys.push(k);
            });
        });
    });
    if (!keys.length) return mappedRows;

    const msByKey = Object.create(null);
    const myByKey = Object.create(null);
    const placeByKey = Object.create(null);

    function ingestPlaceRow(row) {
        const id = String(row.external_id || '').trim();
        if (!id) return;
        if (!placeByKey[id]) {
            placeByKey[id] = {
                ozon: false,
                wb: false,
                ym: false,
                ozon_url: '',
                wb_url: '',
                ym_url: '',
                ozon_at: null,
                wb_at: null,
                ym_at: null,
            };
        }
        const url = String(row.buyer_url || row.cabinet_url || '').trim();
        const at = row.captured_at || null;
        const mp = String(row.marketplace || '');
        if (mp === 'ozon') {
            placeByKey[id].ozon = true;
            if (url) placeByKey[id].ozon_url = url;
            placeByKey[id].ozon_at = earlierDate(placeByKey[id].ozon_at, at);
        } else if (mp === 'wildberries') {
            placeByKey[id].wb = true;
            if (url) placeByKey[id].wb_url = url;
            placeByKey[id].wb_at = earlierDate(placeByKey[id].wb_at, at);
        } else if (mp === 'yandex_market') {
            placeByKey[id].ym = true;
            if (url) placeByKey[id].ym_url = url;
            placeByKey[id].ym_at = earlierDate(placeByKey[id].ym_at, at);
        }
        // Дублируем lookup по offer/vendor/shop — на случай если external_id ≠ код МС.
        ['offer_id', 'vendor_code', 'shop_sku'].forEach((fld) => {
            const alt = String(row[fld] || '').trim();
            if (!alt || alt === id) return;
            if (!placeByKey[alt]) placeByKey[alt] = placeByKey[id];
        });
    }

    // Сначала МС / «Мои»: на Альмамед часто есть только артикул, а код МС узнаём из join.
    // scanAll (пресеты «нет в…») — пачками, без LIMIT 500, иначе часть очереди теряется.
    const scanAll = !!(opts && opts.scanAll);
    const sliceStep = scanAll ? 350 : Math.max(keys.length, 1);
    for (let ki = 0; ki < keys.length; ki += sliceStep) {
        const slice = keys.slice(ki, ki + sliceStep);
        await Promise.all([
            (async () => {
                try {
                    const [msRows] = await db.query(
                        `SELECT mse.code, mse.uuid, med.denorm_article
                           FROM ms_export mse
                           LEFT JOIN ms_entity_details med ON med.uuid = mse.uuid
                          WHERE mse.code IN (?)
                             OR med.denorm_article IN (?)`,
                        [slice, slice]
                    );
                    (msRows || []).forEach((row) => {
                        const code = String(row.code || '').trim();
                        const art = String(row.denorm_article || '').trim();
                        const hit = { code, uuid: row.uuid || '' };
                        presenceKeyVariants(code).forEach((k) => {
                            msByKey[k] = hit;
                        });
                        presenceKeyVariants(art).forEach((k) => {
                            msByKey[k] = hit;
                        });
                    });
                } catch (_) {
                    /* ignore */
                }
            })(),
            (async () => {
                try {
                    const mySql = scanAll
                        ? `SELECT sku, source_url FROM my_products
                            WHERE is_active = 1 AND sku IN (?)`
                        : `SELECT sku, source_url FROM my_products
                            WHERE is_active = 1 AND sku IN (?)
                            LIMIT 500`;
                    const [myRows] = await db.query(mySql, [slice]);
                    (myRows || []).forEach((row) => {
                        const sku = String(row.sku || '').trim();
                        if (!sku) return;
                        const hit = {
                            sku,
                            url: String(row.source_url || '').trim(),
                        };
                        presenceKeyVariants(sku).forEach((k) => {
                            if (!myByKey[k]) myByKey[k] = hit;
                        });
                    });
                } catch (_) {
                    /* ignore */
                }
            })(),
        ]);
    }

    // Добираем коды МС в ключи — выгрузки Ozon/WB/ЯМ ищутся по коду, не по артикулу A-….
    Object.keys(msByKey).forEach((k) => {
        const hit = msByKey[k];
        const code = hit && hit.code ? String(hit.code).trim() : '';
        if (code && !keySet.has(code)) {
            keySet.add(code);
            keys.push(code);
        }
    });

    try {
        // external_id = offer_id / vendor_code / shop_sku (см. marketplaceExportStore) —
        // одного IN по индексу достаточно; OR по 4 полям на большой таблице убивал GET списка.
        const mpStep = scanAll ? 350 : Math.max(keys.length, 1);
        for (let mi = 0; mi < keys.length; mi += mpStep) {
            const slice = keys.slice(mi, mi + mpStep);
            const [mpRows] = await db.query(
                `SELECT external_id, marketplace, buyer_url, cabinet_url, captured_at,
                        offer_id, vendor_code, shop_sku
                   FROM marketplace_export_rows
                  WHERE external_id IN (?)
                    AND marketplace IN ('ozon', 'wildberries', 'yandex_market')`,
                [slice]
            );
            (mpRows || []).forEach(ingestPlaceRow);
        }
    } catch (_) {
        /* ignore */
    }

    list.forEach((r) => {
        const code = String(r.product_code || '').trim();
        // Если позиция создана через «Создать как новый» при коллизии кода/артикула и ещё не имеет своего кода МС —
        // не подсвечиваем чужую карточку МС / Мои товары / МП по старому артикулу.
        const art = r.collision_detached && !code ? '' : String(r.article || '').trim();
        const msHit = firstHitByVariants(msByKey, code, art);
        if (msHit) {
            r.presence.ms = true;
            r.presence.ms_code = msHit.code || code || art;
            if (msHit.uuid) r.presence.ms_uuid = String(msHit.uuid);
        }
        const myHit = firstHitByVariants(myByKey, code, art);
        if (myHit) {
            r.presence.my_products = true;
            r.presence.my_sku = (myHit && myHit.sku) || code || art;
            if (myHit && myHit.url) {
                r.presence.my_url = myHit.url;
                // Бейдж «АЛЬ» на обеих вкладках — ссылка из «Мои товары», если ещё нет
                if (!String(r.almamed_url || '').trim()) {
                    r.almamed_url = myHit.url;
                }
            }
        }
        const placeKeys = [];
        const placeKeySet = new Set();
        const pushPlace = (raw) => {
            presenceKeyVariants(raw).forEach((pk) => {
                if (placeKeySet.has(pk)) return;
                placeKeySet.add(pk);
                placeKeys.push(pk);
            });
        };
        if (msHit && msHit.code) pushPlace(msHit.code);
        pushPlace(code);
        pushPlace(art);
        let liveOzonAt = r.placement_ozon_at || null;
        let liveWbAt = r.placement_wb_at || null;
        let liveYmAt = r.placement_ym_at || null;
        placeKeys.forEach((pk) => {
            const p = placeByKey[pk];
            if (!p) return;
            if (p.ozon) {
                r.presence.ozon = true;
                if (p.ozon_url) r.presence.ozon_url = p.ozon_url;
                liveOzonAt = earlierDate(liveOzonAt, p.ozon_at);
            }
            if (p.wb) {
                r.presence.wb = true;
                if (p.wb_url) r.presence.wb_url = p.wb_url;
                liveWbAt = earlierDate(liveWbAt, p.wb_at);
            }
            if (p.ym) {
                r.presence.ym = true;
                if (p.ym_url) r.presence.ym_url = p.ym_url;
                liveYmAt = earlierDate(liveYmAt, p.ym_at);
            }
        });
        // Для столбца «Размещение» тоже подтягиваем live-флаги (без записи в БД).
        r.placement_ozon = !!r.presence.ozon;
        r.placement_wb = !!r.presence.wb;
        r.placement_ym = !!r.presence.ym;
        if (r.presence.ozon_url) r.placement_ozon_url = r.presence.ozon_url;
        if (r.presence.wb_url) r.placement_wb_url = r.presence.wb_url;
        if (r.presence.ym_url) r.placement_ym_url = r.presence.ym_url;
        // Даты появления на МП (для колонки «Дата размещения»).
        if (r.placement_ozon) r.placement_ozon_at = liveOzonAt || r.placement_ozon_at || null;
        if (r.placement_wb) r.placement_wb_at = liveWbAt || r.placement_wb_at || null;
        if (r.placement_ym) r.placement_ym_at = liveYmAt || r.placement_ym_at || null;
        if (!r.placement_date) {
            r.placement_date = [r.placement_ozon_at, r.placement_wb_at, r.placement_ym_at].reduce(
                (acc, d) => earlierDate(acc, d),
                null
            );
        }
    });

    // HK: полный JSON матрицы Huckster тяжёлый — список не ждёт cold parse.
    // Пресет «нет в Huckster» ждёт снапшот, иначе фильтр врёт на пустом кэше.
    if (opts && opts.awaitHuckster) {
        const hk = await loadHucksterPresentCodes(db);
        applyHucksterPresenceFlags(list, hk);
    } else {
        applyHucksterPresenceFlags(list, peekHucksterPresentCodes());
        void warmHucksterPresentCodes(db);
    }

    return mappedRows;
}

/** Кэш кодов, найденных хотя бы в одном кабинете Huckster (set1/set2 снапшота). */
let hucksterPresentCodesCache = { ts: 0, set: null, loading: null };
const HUCKSTER_PRESENT_TTL_MS = 10 * 60 * 1000;

function ingestHucksterSheetCodes(sheet, intoSet) {
    if (!sheet || !Array.isArray(sheet.rows) || !intoSet) return;
    const meta = Array.isArray(sheet.bridge_row_meta) ? sheet.bridge_row_meta : [];
    for (let i = 1; i < sheet.rows.length; i += 1) {
        const row = sheet.rows[i];
        const code = String((row && row[0]) || '').trim();
        if (!code) continue;
        const cabs = meta[i] && meta[i].cabinets;
        if (!cabs) continue;
        if (cabs.ozon !== 'bad' || cabs.wildberries !== 'bad' || cabs.yandex !== 'bad') {
            intoSet.add(code);
        }
    }
}

function peekHucksterPresentCodes() {
    return hucksterPresentCodesCache.set;
}

function applyHucksterPresenceFlags(list, hkSet) {
    (list || []).forEach((r) => {
        if (!r.presence) r.presence = {};
        if (!hkSet) {
            r.presence.huckster = false;
            return;
        }
        const code = String(r.product_code || '').trim();
        const art = r.collision_detached && !code ? '' : String(r.article || '').trim();
        const msCode = String((r.presence && r.presence.ms_code) || '').trim();
        r.presence.huckster =
            !!(code && hkSet.has(code)) || !!(art && hkSet.has(art)) || !!(msCode && hkSet.has(msCode));
    });
}

async function refreshHucksterPresentCodes(db) {
    const set = new Set();
    const snap = await loadHucksterSnapshot(db);
    if (snap) {
        ingestHucksterSheetCodes(snap.sheet_export, set);
        ingestHucksterSheetCodes(snap.sheet_export_rrc, set);
    }
    hucksterPresentCodesCache = { ts: Date.now(), set, loading: null };
    return set;
}

/** Stale-while-revalidate: не ждём LONGTEXT JSON на каждом GET списка. */
function warmHucksterPresentCodes(db) {
    const now = Date.now();
    const fresh =
        hucksterPresentCodesCache.set && now - hucksterPresentCodesCache.ts < HUCKSTER_PRESENT_TTL_MS;
    if (fresh) return Promise.resolve(hucksterPresentCodesCache.set);
    if (hucksterPresentCodesCache.loading) return hucksterPresentCodesCache.loading;
    hucksterPresentCodesCache.loading = refreshHucksterPresentCodes(db)
        .catch(() => hucksterPresentCodesCache.set || new Set())
        .finally(() => {
            hucksterPresentCodesCache.loading = null;
        });
    return hucksterPresentCodesCache.loading;
}

async function loadHucksterPresentCodes(db) {
    const now = Date.now();
    if (hucksterPresentCodesCache.set && now - hucksterPresentCodesCache.ts < HUCKSTER_PRESENT_TTL_MS) {
        return hucksterPresentCodesCache.set;
    }
    if (hucksterPresentCodesCache.set) {
        void warmHucksterPresentCodes(db);
        return hucksterPresentCodesCache.set;
    }
    return warmHucksterPresentCodes(db);
}

/**
 * «Дата на Альмамед» + ссылка с сайта: при появлении в my_products.
 * Пишем один раз, не затираем.
 */
async function stampAlmamedAddedAtFromPresence(db, mappedRows) {
    const list = mappedRows || [];
    const dateIds = [];
    const urlPatches = [];
    list.forEach((r) => {
        if (r.channel !== 'almamed') return;
        const p = r.presence || {};
        if (!r.almamed_added_at && p.my_products) dateIds.push(Number(r.id));
        const myUrl = String(p.my_url || '').trim();
        if (!String(r.almamed_url || '').trim() && myUrl) {
            urlPatches.push({ id: Number(r.id), url: myUrl });
            r.almamed_url = myUrl;
        }
    });

    if (urlPatches.length) {
        for (const u of urlPatches) {
            try {
                await db.query(
                    `UPDATE dg_new_products
                        SET almamed_url = ?
                      WHERE id = ? AND channel = 'almamed'
                        AND (almamed_url IS NULL OR almamed_url = '')`,
                    [u.url, u.id]
                );
            } catch (_) {
                /* ignore */
            }
        }
    }

    if (!dateIds.length) return mappedRows;

    const now = new Date();
    try {
        await db.query(
            `UPDATE dg_new_products
                SET almamed_added_at = ?
              WHERE channel = 'almamed'
                AND almamed_added_at IS NULL
                AND id IN (?)`,
            [now, dateIds]
        );
        const iso = now.toISOString();
        const idSet = new Set(dateIds);
        list.forEach((r) => {
            if (idSet.has(Number(r.id)) && !r.almamed_added_at) {
                r.almamed_added_at = iso;
            }
        });
        for (const id of dateIds) {
            try {
                await db.query(
                    `INSERT INTO dg_new_products_log
                        (product_id, channel, kit_id, field, old_value, new_value, action, source,
                         changed_by_user_id, changed_by_name, note)
                     VALUES (?, 'almamed', NULL, 'almamed_added_at', NULL, ?, 'set', 'import_match',
                             NULL, 'система', ?)`,
                    [
                        id,
                        iso.slice(0, 19).replace('T', ' '),
                        'Дата на Альмамед: первая связь с «Мои товары» (импорт CMS)',
                    ]
                );
            } catch (_) {
                /* ignore */
            }
        }
    } catch (_) {
        /* ignore */
    }
    return mappedRows;
}

/** Номер строки внутри вкладки (Альмамед 1..N и маркеты 1..N отдельно). */
async function allocChannelNum(db, channel) {
    const ch = channel === 'marketplaces' ? 'marketplaces' : 'almamed';
    const [[row]] = await db.query(
        `SELECT COALESCE(MAX(channel_num), 0) + 1 AS next_num
           FROM dg_new_products WHERE channel = ? FOR UPDATE`,
        [ch]
    );
    const n = Number(row && row.next_num);
    return Number.isFinite(n) && n > 0 ? n : 1;
}

async function backfillChannelNums(db) {
    try {
        const [[miss]] = await db.query(
            `SELECT COUNT(*) AS c FROM dg_new_products WHERE channel_num IS NULL`
        );
        if (!Number(miss && miss.c)) return;
        for (const ch of ['almamed', 'marketplaces']) {
            const [rows] = await db.query(
                `SELECT id FROM dg_new_products WHERE channel = ? ORDER BY id ASC`,
                [ch]
            );
            let n = 0;
            for (const r of rows || []) {
                n += 1;
                await db.query(`UPDATE dg_new_products SET channel_num = ? WHERE id = ? AND channel_num IS NULL`, [
                    n,
                    r.id,
                ]);
            }
        }
    } catch (_) {
        /* ignore */
    }
}

async function fetchPlacementInfo(db, code) {
    const empty = {
        ozon: 0,
        wb: 0,
        ym: 0,
        ozon_url: '',
        wb_url: '',
        ym_url: '',
        ozon_at: null,
        wb_at: null,
        ym_at: null,
    };
    const c = String(code || '').trim();
    if (!c) return empty;
    try {
        const [rows] = await db.query(
            `SELECT marketplace, buyer_url, cabinet_url, captured_at FROM marketplace_export_rows
              WHERE external_id = ?
                AND marketplace IN ('ozon', 'wildberries', 'yandex_market')`,
            [c]
        );
        const out = { ...empty };
        (rows || []).forEach((r) => {
            const mp = String(r.marketplace || '');
            const url = String(r.buyer_url || r.cabinet_url || '').trim();
            const at = r.captured_at || null;
            if (mp === 'ozon') {
                out.ozon = 1;
                out.ozon_url = url;
                out.ozon_at = earlierDate(out.ozon_at, at);
            } else if (mp === 'wildberries') {
                out.wb = 1;
                out.wb_url = url;
                out.wb_at = earlierDate(out.wb_at, at);
            } else if (mp === 'yandex_market') {
                out.ym = 1;
                out.ym_url = url;
                out.ym_at = earlierDate(out.ym_at, at);
            }
        });
        return out;
    } catch (_) {
        return empty;
    }
}

/** @deprecated use fetchPlacementInfo */
async function fetchPlacementFlags(db, code) {
    const p = await fetchPlacementInfo(db, code);
    return { ozon: p.ozon, wb: p.wb, ym: p.ym };
}

/**
 * «Цена Маркеты с теста» из salePrices карточки МС (копейки → рубли) или denorm_market_price_rub.
 * Не берёт «Цена продажи» (ms_export.sale_price), так как в «Размещение на маркеты» нужна именно «Цена Маркеты с теста».
 */
function extractMarketTestPriceFromPayload(payload, denormMarketPriceRub) {
    if (payload && Array.isArray(payload.salePrices)) {
        for (const sp of payload.salePrices) {
            if (!sp || typeof sp !== 'object') continue;
            const ptName = String((sp.priceType && sp.priceType.name) || '')
                .trim()
                .toLowerCase();
            if (
                ptName === 'цена маркеты с теста' ||
                ptName.includes('маркеты с теста')
            ) {
                const kop = Number(sp.value);
                if (Number.isFinite(kop) && kop > 0) {
                    return Math.round(kop) / 100;
                }
            }
        }
    }
    if (denormMarketPriceRub != null && denormMarketPriceRub !== '') {
        const d = Number(denormMarketPriceRub);
        if (Number.isFinite(d) && d > 0) {
            return Math.round(d * 100) / 100;
        }
    }
    return null;
}

function mapMsEnrichRow(r) {
    let payload = null;
    try {
        payload = r.payload_json
            ? typeof r.payload_json === 'string'
                ? JSON.parse(r.payload_json)
                : r.payload_json
            : null;
    } catch (_) {
        payload = null;
    }
    const barcode = extractBarcodesFromPayload(payload);
    const article =
        String(r.denorm_article || '').trim() ||
        String(payload && payload.article ? payload.article : '').trim() ||
        '';
    const salePrice = extractMarketTestPriceFromPayload(payload, r.denorm_market_price_rub);
    const vat = extractVatFromPayload(payload, r.vat, r.vat_on_product);
    const attrsMissing =
        !payload || !Array.isArray(payload.attributes) || payload.attributes.length === 0;
    return {
        code: String(r.code || '').trim(),
        name: String(r.name || '').trim(),
        uuid: r.uuid || '',
        kind: String(r.kind || '').trim(),
        article,
        barcode,
        vat,
        sale_price: salePrice,
        ru_url: extractRuUrlFromPayload(payload),
        ss_ds_url: extractSsDsUrlFromPayload(payload),
        _attrs_missing: attrsMissing,
        _use_parent_vat: !!(payload && payload.useParentVat),
    };
}

const MS_ENRICH_SQL = `SELECT mse.code, mse.name, mse.vat, mse.vat_on_product, mse.sale_price, mse.uuid,
                med.denorm_article, med.denorm_market_price_rub, med.payload_json, med.kind
           FROM ms_export mse
           LEFT JOIN ms_entity_details med ON med.uuid = mse.uuid`;

/**
 * Если у товара useParentVat — пройти productFolder вверх и взять vat/effectiveVat.
 */
async function resolveVatFromProductFolderChain(token, entity) {
    if (!entity || !entity.useParentVat) return '';
    let fromSelf = extractVatFromPayload(entity, null, null);
    if (fromSelf) return fromSelf;
    let folder = entity.productFolder;
    let href =
        (folder && folder.meta && folder.meta.href) ||
        (folder && folder.href) ||
        '';
    let depth = 0;
    while (href && depth < 10) {
        depth += 1;
        try {
            const resp = await axios.get(String(href).split('?')[0], {
                headers: { Authorization: `Bearer ${token}` },
                timeout: 30000,
                params: { expand: 'productFolder' },
            });
            const f = resp && resp.data;
            if (!f) break;
            const v = extractVatFromPayload(f, null, null);
            if (v) return v;
            if (!f.useParentVat) break;
            folder = f.productFolder;
            href =
                (folder && folder.meta && folder.meta.href) ||
                (folder && folder.href) ||
                '';
        } catch (_) {
            break;
        }
    }
    return '';
}

/**
 * Live GET карточки МС (товар или комплект), если в кэше нет НДС / РУ / штрихкода.
 * Пишет payload в ms_entity_details и при возможности vat в ms_export.
 * @param {string} [kindHint] — 'bundle' | 'product' | type из ms_export
 */
async function fetchMsEntityLiveForEnrich(db, uuid, kindHint) {
    const u = String(uuid || '').trim();
    const token = getMsToken();
    if (!u || !token) return null;
    const hint = String(kindHint || '').toLowerCase();
    const preferBundle = hint.includes('bundle') || hint.includes('комплект');
    const kinds = preferBundle ? ['bundle', 'product'] : ['product', 'bundle'];
    let lastErr = null;
    for (const kind of kinds) {
        try {
            const resp = await axios.get(`${MS_BASE_URL}/entity/${kind}/${encodeURIComponent(u)}`, {
                headers: { Authorization: `Bearer ${token}` },
                timeout: 45000,
                params: { expand: MS_PRODUCT_EXPAND },
            });
            const entity = resp && resp.data;
            if (!entity || typeof entity !== 'object') continue;
            const payloadJson = JSON.stringify(entity);
            const article = String(entity.article || '').trim();
            const code = String(entity.code || '').trim();
            const marketPrice = extractMarketTestPriceFromPayload(entity, null);
            let vat = extractVatFromPayload(entity, null, null);
            if (!vat) vat = await resolveVatFromProductFolderChain(token, entity);
            try {
                await db.query(
                    `INSERT INTO ms_entity_details (uuid, code, kind, name, payload_json, source, denorm_article, denorm_market_price_rub)
                     VALUES (?, ?, ?, ?, ?, 'np_enrich', ?, ?)
                     ON DUPLICATE KEY UPDATE
                       code = VALUES(code),
                       kind = VALUES(kind),
                       name = VALUES(name),
                       payload_json = VALUES(payload_json),
                       source = VALUES(source),
                       denorm_article = VALUES(denorm_article),
                       denorm_market_price_rub = COALESCE(VALUES(denorm_market_price_rub), denorm_market_price_rub),
                       updated_at = CURRENT_TIMESTAMP`,
                    [
                        u,
                        code || null,
                        kind,
                        String(entity.name || '').slice(0, 500),
                        payloadJson,
                        article || null,
                        marketPrice != null ? marketPrice : null,
                    ]
                );
            } catch (_) {
                /* ignore cache write */
            }
            if (vat) {
                try {
                    await db.query(
                        `UPDATE ms_export SET vat = ? WHERE uuid = ? AND (vat IS NULL OR vat = '')`,
                        [vat, u]
                    );
                } catch (_) {
                    /* ignore */
                }
            }
            return {
                code,
                name: String(entity.name || '').trim(),
                uuid: u,
                kind,
                article,
                barcode: extractBarcodesFromPayload(entity),
                vat,
                sale_price: marketPrice,
                ru_url: extractRuUrlFromPayload(entity),
                ss_ds_url: extractSsDsUrlFromPayload(entity),
            };
        } catch (e) {
            lastErr = e;
        }
    }
    if (lastErr) {
        console.warn('[new-products] MS live enrich failed:', lastErr && lastErr.message);
    }
    return null;
}

/** @deprecated use fetchMsEntityLiveForEnrich */
async function fetchMsProductLiveForEnrich(db, uuid) {
    return fetchMsEntityLiveForEnrich(db, uuid, 'product');
}

/**
 * Live-поиск сущности МС по коду (когда ещё нет в ms_export) — bundle, затем product.
 * Кладёт карточку в ms_entity_details / при возможности строку в ms_export не создаём (только details).
 */
async function fetchMsEnrichmentByLiveCode(db, code) {
    const c = String(code || '').trim();
    const token = getMsToken();
    if (!c || !token) return null;
    const kinds = ['bundle', 'product'];
    for (const kind of kinds) {
        try {
            const listResp = await axios.get(`${MS_BASE_URL}/entity/${kind}`, {
                headers: { Authorization: `Bearer ${token}` },
                timeout: 30000,
                params: {
                    filter: `code=${c}`,
                    limit: 1,
                },
            });
            const rows = (listResp && listResp.data && listResp.data.rows) || [];
            const hit = rows[0];
            const uuid =
                (hit && hit.id) ||
                (hit && hit.meta && String(hit.meta.href || '').split('/').pop()) ||
                '';
            if (!uuid) continue;
            const live = await fetchMsEntityLiveForEnrich(db, uuid, kind);
            if (live) return live;
        } catch (e) {
            console.warn(
                `[new-products] MS live search ${kind} code=${c}:`,
                e && e.message ? e.message : e
            );
        }
    }
    return null;
}

/**
 * Обогащение из кэша МС; при пустых НДС/РУ/штрихкоде и наличии uuid — live GET (product|bundle).
 * Если кода нет в кэше и allowLive — поиск по API МойСклад.
 * @param {{ allowLive?: boolean }} opts
 * @returns {Promise<object|null>} enrich + `_used_live` если ходили в API МС
 */
async function enrichFromMsWithLiveFallback(db, key, opts) {
    const options = opts || {};
    const allowLive = options.allowLive !== false;
    let enrich = await fetchMsEnrichment(db, key);
    let usedLive = false;
    if (!enrich && allowLive) {
        enrich = await fetchMsEnrichmentByLiveCode(db, key);
        if (enrich) usedLive = true;
    }
    if (!enrich) return null;
    const needVat = !String(enrich.vat || '').trim();
    const needRu = !String(enrich.ru_url || '').trim();
    const needSsDs = !String(enrich.ss_ds_url || '').trim();
    const needBarcode = !String(enrich.barcode || '').trim();
    const needPrice = !(enrich.sale_price != null && Number(enrich.sale_price) > 0);
    if (!needVat && !needRu && !needSsDs && !needBarcode && !needPrice) {
        return { ...enrich, _used_live: usedLive };
    }
    if (!allowLive) return { ...enrich, _used_live: usedLive };
    const uuid = String(enrich.uuid || '').trim();
    if (!uuid) return { ...enrich, _used_live: usedLive };
    const shouldLive =
        needVat ||
        needRu ||
        needSsDs ||
        needBarcode ||
        needPrice ||
        enrich._attrs_missing ||
        (needVat && enrich._use_parent_vat);
    if (!shouldLive) return { ...enrich, _used_live: usedLive };
    const live = await fetchMsEntityLiveForEnrich(db, uuid, enrich.kind);
    if (!live) return { ...enrich, _used_live: usedLive };
    return {
        ...enrich,
        kind: enrich.kind || live.kind || '',
        vat: enrich.vat || live.vat || '',
        ru_url: enrich.ru_url || live.ru_url || '',
        ss_ds_url: enrich.ss_ds_url || live.ss_ds_url || '',
        barcode: enrich.barcode || live.barcode || '',
        sale_price:
            enrich.sale_price != null && Number(enrich.sale_price) > 0
                ? enrich.sale_price
                : live.sale_price != null && Number(live.sale_price) > 0
                  ? live.sale_price
                  : null,
        article: enrich.article || live.article || '',
        code: enrich.code || live.code || '',
        name: enrich.name || live.name || '',
        _used_live: true,
    };
}

function chunkArray(arr, size) {
    const out = [];
    const n = Math.max(1, size || 200);
    for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
    return out;
}

function msCodeNumericAlias(key) {
    const m = String(key || '')
        .trim()
        .match(/^[AАaа]-?(\d+)$/);
    return m ? m[1] : '';
}

/**
 * Пакетное обогащение из кэша МС: 1–2 SQL вместо N×(code/article/alias).
 * @returns {Promise<Map<string, object>>} ключ запроса → enrich
 */
async function fetchMsEnrichmentMap(db, keys) {
    const result = new Map();
    const uniq = [
        ...new Set(
            (keys || [])
                .map((k) => String(k || '').trim())
                .filter(Boolean)
        ),
    ];
    if (!uniq.length) return result;

    const codeKeys = new Set(uniq);
    for (const k of uniq) {
        const alias = msCodeNumericAlias(k);
        if (alias) codeKeys.add(alias);
    }

    const byCode = new Map();
    for (const chunk of chunkArray([...codeKeys], 300)) {
        const ph = chunk.map(() => '?').join(',');
        const [rows] = await db.query(`${MS_ENRICH_SQL} WHERE mse.code IN (${ph})`, chunk);
        for (const r of rows || []) {
            const enrich = mapMsEnrichRow(r);
            if (enrich.code) byCode.set(enrich.code, enrich);
        }
    }

    const missing = [];
    for (const k of uniq) {
        if (byCode.has(k)) {
            result.set(k, byCode.get(k));
            continue;
        }
        const alias = msCodeNumericAlias(k);
        if (alias && byCode.has(alias)) {
            result.set(k, byCode.get(alias));
            continue;
        }
        missing.push(k);
    }

    if (missing.length) {
        for (const chunk of chunkArray(missing, 300)) {
            const ph = chunk.map(() => '?').join(',');
            let rows = [];
            try {
                const [byArt] = await db.query(
                    `${MS_ENRICH_SQL} WHERE med.denorm_article IN (${ph})`,
                    chunk
                );
                rows = byArt || [];
            } catch (_) {
                rows = [];
            }
            const byArtMap = new Map();
            for (const r of rows) {
                const enrich = mapMsEnrichRow(r);
                const art = String(enrich.article || r.denorm_article || '').trim();
                if (art && !byArtMap.has(art)) byArtMap.set(art, enrich);
            }
            for (const k of chunk) {
                if (result.has(k)) continue;
                if (byArtMap.has(k)) result.set(k, byArtMap.get(k));
            }
        }
    }
    return result;
}

async function fetchMsEnrichmentByUuid(db, uuid) {
    const id = String(uuid || '').trim();
    if (!id) return null;
    const [rows] = await db.query(`${MS_ENRICH_SQL} WHERE mse.uuid = ? LIMIT 1`, [id]);
    if (!rows || !rows[0]) return null;
    return mapMsEnrichRow(rows[0]);
}

async function fetchMsEnrichmentByCodeOnly(db, code) {
    const c = String(code || '').trim();
    if (!c) return null;
    const [rows] = await db.query(`${MS_ENRICH_SQL} WHERE mse.code = ? LIMIT 1`, [c]);
    if (!rows || !rows[0]) return null;
    return mapMsEnrichRow(rows[0]);
}

/** 0 — точное совпадение артикула, 1 — A-/А- тот же хвост, 9 — не тот товар. */
function articleMatchRank(queueArticle, cardArticle) {
    const a = String(queueArticle || '').trim();
    const b = String(cardArticle || '').trim();
    if (!a || !b) return 9;
    if (a === b) return 0;
    const am = a.match(/^([AАaа])-?(.*)$/);
    const bm = b.match(/^([AАaа])-?(.*)$/);
    if (am && bm && am[2] && am[2] === bm[2]) return 1;
    return 9;
}

/**
 * Карточка МС по артикулу очереди. Голое число не склеивается с артикулом `A-число`
 * другого товара (артикул 20079 ≠ код 20079).
 */
async function fetchMsEnrichmentByDenormArticle(db, article) {
    const raw = String(article || '').trim();
    const variants = presenceKeyVariants(raw);
    if (!variants.length) return null;
    const ph = variants.map(() => '?').join(',');
    const [rows] = await db.query(
        `${MS_ENRICH_SQL} WHERE med.denorm_article IN (${ph})`,
        variants
    );
    const ranked = [];
    const seen = new Set();
    for (const row of rows || []) {
        const enrich = mapMsEnrichRow(row);
        const uuid = String(enrich.uuid || '');
        if (!enrich.code || (uuid && seen.has(uuid))) continue;
        if (uuid) seen.add(uuid);
        const rank = articleMatchRank(raw, enrich.article);
        if (rank > 1) continue;
        ranked.push({ enrich, rank });
    }
    if (!ranked.length) return null;
    ranked.sort((x, y) => x.rank - y.rank);
    const best = ranked[0].rank;
    const top = ranked.filter((x) => x.rank === best);
    if (top.length !== 1) return null;
    return top[0].enrich;
}

/** Карточка МС явно про другой артикул (A-40986 не может остаться на карточке A-40914). */
function msCardDisagreesWithArticle(article, card) {
    const art = String(article || '').trim();
    const cardArt = String(card && card.article ? card.article : '').trim();
    if (!art || !cardArt) return false;
    return articleMatchRank(art, cardArt) > 1;
}

/**
 * Код в очереди маркетов — только `ms_export.code` найденной карточки.
 * 1) точный артикул (и для старой строки: он важнее сохранённого uuid);
 * 2) uuid, если артикул карточки не противоречит артикулу строки;
 * 3) код по хвосту `A-12345` (A-40287 → 40287, даже если в МС кривой denorm);
 * 4) явный код, если он не равен артикулу и артикул карточки с ним сходится.
 * Артикул в product_code не пишется.
 */
async function resolveMarketsMsCard(db, opts) {
    const options = opts || {};
    const uuid = String(options.uuid || '').trim();
    const article = String(options.article || '').trim();
    const productCode = String(options.productCode || '').trim();
    if (article) {
        const byArt = await fetchMsEnrichmentByDenormArticle(db, article);
        if (byArt && byArt.code) return byArt;
    }
    if (uuid) {
        const byUuid = await fetchMsEnrichmentByUuid(db, uuid);
        if (byUuid && byUuid.code && !msCardDisagreesWithArticle(article, byUuid)) return byUuid;
    }
    if (article) {
        const alias = msCodeNumericAlias(article);
        if (alias && alias !== article) {
            const byAlias = await fetchMsEnrichmentByCodeOnly(db, alias);
            if (byAlias && byAlias.code && (!msCardDisagreesWithArticle(article, byAlias) || byAlias.code === alias)) {
                return byAlias;
            }
        }
    }
    if (productCode && productCode !== article) {
        const byCode = await fetchMsEnrichmentByCodeOnly(db, productCode);
        if (byCode && String(byCode.code || '').trim() === productCode) {
            const cardArt = String(byCode.article || '').trim();
            if (!article || !cardArt || articleMatchRank(article, cardArt) <= 1) return byCode;
        }
    }
    return null;
}

/**
 * Обогащение из МС: сначала по коду, затем по артикулу (когда товар уже в МС после Альмамед).
 */
async function fetchMsEnrichment(db, key) {
    const c = String(key || '').trim();
    if (!c) return null;
    const map = await fetchMsEnrichmentMap(db, [c]);
    return map.get(c) || null;
}

/**
 * Быстрое дозаполнение полей маркетов из кэша МС (без live API).
 * Пустые код / штрихкод / НДС / РУ / СС·ДС / uuid дописываются из кэша.
 * Если артикул указывает на другую карточку — эти поля переписываются с неё.
 * Для автосинка по интервалу (не зависает на API МойСклад).
 */
async function backfillMarketsMsFieldsFromCache(db, opts) {
    const options = opts || {};
    const limit = Math.max(1, Math.min(5000, Number(options.limit) || 3000));
    const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
    const report = async (msg) => {
        if (!onProgress) return;
        try {
            await onProgress(String(msg || '').slice(0, 480));
        } catch (_) {}
    };
    const t0 = Date.now();
    const [rows] = await db.query(
        `SELECT id, article, product_code, barcode, vat, ru_url, ss_ds_url, price_markets, ms_product_uuid,
                COALESCE(collision_detached, 0) AS collision_detached
           FROM dg_new_products
          WHERE channel = 'marketplaces' AND status <> 'removed'
            AND (COALESCE(collision_detached, 0) = 0 OR (product_code IS NOT NULL AND TRIM(product_code) <> ''))
            AND (
              product_code IS NULL OR TRIM(product_code) = ''
              OR barcode IS NULL OR TRIM(barcode) = ''
              OR vat IS NULL OR TRIM(vat) = ''
              OR ru_url IS NULL OR TRIM(ru_url) = ''
              OR ss_ds_url IS NULL OR TRIM(ss_ds_url) = ''
              OR price_markets IS NULL OR price_markets <= 0
            )
          ORDER BY id ASC
          LIMIT ?`,
        [limit]
    );
    const total = (rows || []).length;
    await report('Кэш МС: старт, к проверке ' + total + ' строк…');

    const lookups = (rows || []).map((row) => {
        const code = String(row.product_code || '').trim();
        const art = Number(row.collision_detached) === 1 && !code ? '' : String(row.article || '').trim();
        return code || art;
    });
    const enrichMap = await fetchMsEnrichmentMap(db, lookups);
    const artEnrichByKey = new Map();
    const articleKeys = [
        ...new Set(
            (rows || [])
                .filter((row) => !(Number(row.collision_detached) === 1 && !String(row.product_code || '').trim()))
                .map((row) => String(row.article || '').trim())
                .filter(Boolean)
        ),
    ];
    for (const chunk of chunkArray(articleKeys, 300)) {
        const ph = chunk.map(() => '?').join(',');
        let artRows = [];
        try {
            const [found] = await db.query(
                `${MS_ENRICH_SQL} WHERE med.denorm_article IN (${ph})`,
                chunk
            );
            artRows = found || [];
        } catch (_) {
            artRows = [];
        }
        const bucket = new Map();
        for (const raw of artRows) {
            const card = mapMsEnrichRow(raw);
            if (!card.code) continue;
            for (const key of chunk) {
                const rank = articleMatchRank(key, card.article);
                if (rank > 1) continue;
                if (!bucket.has(key)) bucket.set(key, []);
                bucket.get(key).push({ card, rank });
            }
        }
        for (const [key, hits] of bucket) {
            hits.sort((a, b) => a.rank - b.rank);
            const best = hits[0].rank;
            const top = hits.filter((h) => h.rank === best);
            const uuids = new Set(top.map((h) => String(h.card.uuid || h.card.code)));
            if (uuids.size === 1) artEnrichByKey.set(key, top[0].card);
        }
    }
    await report(
        'Кэш МС: загружено ' + enrichMap.size + ' карточек за ' + (Date.now() - t0) + ' мс, пишем…'
    );

    let updated = 0;
    let missed = 0;
    let scanned = 0;
    let filledSsDs = 0;
    let filledRu = 0;
    let filledVat = 0;
    let filledBarcode = 0;
    let emptySsDsNeed = 0;
    let ssDsAbsentInMs = 0;
    const pendingUpdates = [];

    for (const row of rows || []) {
        scanned += 1;
        const needSsDs = !String(row.ss_ds_url || '').trim();
        if (needSsDs) emptySsDsNeed += 1;
        const art = String(row.article || '').trim();
        const code = String(row.product_code || '').trim();
        const lookup = code && code !== art ? code : art;
        if (!lookup) {
            missed += 1;
            if (needSsDs) ssDsAbsentInMs += 1;
            continue;
        }
        let enrich = null;
        const byArticle = art ? artEnrichByKey.get(art) || null : null;
        if (byArticle && byArticle.code) enrich = byArticle;
        if (!enrich && !code && art) enrich = byArticle;
        if (!enrich) enrich = enrichMap.get(lookup) || null;
        if (!enrich && art && lookup !== art) enrich = byArticle;
        if (enrich && art && msCardDisagreesWithArticle(art, enrich)) {
            enrich = byArticle && !msCardDisagreesWithArticle(art, byArticle) ? byArticle : null;
        }
        if (!enrich) {
            missed += 1;
            if (needSsDs) ssDsAbsentInMs += 1;
            continue;
        }
        const patch = {};
        const strictCode = String(enrich.code || '').trim();
        const switchingCode = !!(strictCode && code && strictCode !== code);
        if (strictCode && (!code || switchingCode || (art && code === art && strictCode !== code))) {
            patch.product_code = strictCode;
        }
        if (switchingCode && enrich.uuid) patch.ms_product_uuid = enrich.uuid;
        if ((switchingCode || !String(row.barcode || '').trim()) && enrich.barcode && String(enrich.barcode) !== String(row.barcode || '')) {
            patch.barcode = enrich.barcode;
            filledBarcode += 1;
        }
        if ((switchingCode || !String(row.vat || '').trim()) && enrich.vat && String(enrich.vat) !== String(row.vat || '')) {
            patch.vat = enrich.vat;
            filledVat += 1;
        }
        if ((switchingCode || !String(row.ru_url || '').trim()) && enrich.ru_url && String(enrich.ru_url) !== String(row.ru_url || '')) {
            patch.ru_url = enrich.ru_url;
            filledRu += 1;
        }
        if (needSsDs || switchingCode) {
            const nextSs = String(enrich.ss_ds_url || '').trim();
            if (nextSs && nextSs !== String(row.ss_ds_url || '')) {
                patch.ss_ds_url = nextSs;
                if (needSsDs) filledSsDs += 1;
            } else if (switchingCode && String(row.ss_ds_url || '').trim()) {
                patch.ss_ds_url = '';
            } else if (needSsDs) {
                ssDsAbsentInMs += 1;
            }
        }
        if (switchingCode && !String(enrich.ru_url || '').trim() && String(row.ru_url || '').trim()) {
            patch.ru_url = '';
        }
        if ((row.price_markets == null || Number(row.price_markets) <= 0) && enrich.sale_price != null && Number(enrich.sale_price) > 0) {
            patch.price_markets = Number(enrich.sale_price);
        }
        if (!row.ms_product_uuid && enrich.uuid) patch.ms_product_uuid = enrich.uuid;
        const keys = Object.keys(patch);
        if (keys.length) pendingUpdates.push({ id: row.id, patch, keys });
    }

    for (const batch of chunkArray(pendingUpdates, 50)) {
        await Promise.all(
            batch.map((u) =>
                db.query(
                    `UPDATE dg_new_products SET ${u.keys.map((c) => `\`${c}\` = ?`).join(', ')} WHERE id = ?`,
                    [...u.keys.map((c) => u.patch[c]), u.id]
                )
            )
        );
        updated += batch.length;
        await report(
            'Кэш МС: запись ' +
                updated +
                '/' +
                pendingUpdates.length +
                ', скан ' +
                scanned +
                ', miss ' +
                missed +
                ', СС·ДС +' +
                filledSsDs +
                ' (' +
                (Date.now() - t0) +
                ' мс)'
        );
    }

    await report('Кэш МС: товары готовы (' + (Date.now() - t0) + ' мс), комплекты…');
    const kits = await backfillKitsMsFieldsFromCache(db, {
        limit: Math.min(2000, limit),
        allowLive: false,
    });
    return {
        scanned,
        updated,
        missed,
        limit,
        duration_ms: Date.now() - t0,
        filled_ss_ds: filledSsDs,
        filled_ru: filledRu,
        filled_vat: filledVat,
        filled_barcode: filledBarcode,
        empty_ss_ds_need: emptySsDsNeed,
        ss_ds_absent_in_ms: ssDsAbsentInMs,
        kits_scanned: kits.scanned,
        kits_updated: kits.updated,
        kits_missed: kits.missed,
    };
}

/**
 * Поля комплекта из обогащения МС (штрихкод / НДС / артикул / цена «Цена Маркеты с теста»).
 * @param {{ force?: boolean }} opts — force: перезаписать barcode/vat/price_markets даже если уже заполнены
 */
function buildKitMsPatch(kitRow, enrich, opts) {
    const options = opts || {};
    const force = options.force === true;
    if (!enrich) return {};
    const patch = {};
    if (force || !String(kitRow.barcode || '').trim()) {
        if (enrich.barcode) patch.barcode = String(enrich.barcode).trim().slice(0, 512);
    }
    if (force || !String(kitRow.vat || '').trim()) {
        if (enrich.vat) patch.vat = String(enrich.vat).trim().slice(0, 64);
    }
    if (force || kitRow.price_markets == null || Number(kitRow.price_markets) <= 0) {
        if (enrich.sale_price != null && Number(enrich.sale_price) > 0) {
            patch.price_markets = Number(enrich.sale_price);
        }
    }
    if (!String(kitRow.article || '').trim() && enrich.article) {
        patch.article = String(enrich.article).trim().slice(0, 128);
    }
    return patch;
}

/**
 * Подтянуть штрихкод/НДС комплекта из МС по product_code (кэш + опционально live).
 * @param {{ allowLive?: boolean, force?: boolean }} opts
 * @returns {Promise<{ ok: boolean, patch: object, enrich: object|null, kit: object|null }>}
 */
async function enrichAndPersistKitFromMs(db, kitRow, opts) {
    const options = opts || {};
    const kit = kitRow || {};
    const lookup = String(kit.product_code || kit.article || '').trim();
    if (!kit.id || !lookup) {
        return { ok: false, patch: {}, enrich: null, kit: null, reason: 'no_code' };
    }
    const enrich = await enrichFromMsWithLiveFallback(db, lookup, {
        allowLive: options.allowLive !== false,
    });
    if (!enrich) {
        return { ok: false, patch: {}, enrich: null, kit: null, reason: 'ms_miss' };
    }
    const patch = buildKitMsPatch(kit, enrich, { force: options.force === true });
    const keys = Object.keys(patch);
    if (!keys.length) {
        return { ok: true, patch: {}, enrich, kit, reason: 'noop' };
    }
    await db.query(
        `UPDATE dg_new_product_kits SET ${keys.map((c) => `\`${c}\` = ?`).join(', ')} WHERE id = ?`,
        [...keys.map((c) => patch[c]), kit.id]
    );
    const [[updated]] = await db.query(`SELECT * FROM dg_new_product_kits WHERE id = ? LIMIT 1`, [
        kit.id,
    ]);
    return { ok: true, patch, enrich, kit: updated || { ...kit, ...patch } };
}

/**
 * Дозаполнение пустых barcode/vat у комплектов маркетов из МС.
 */
async function backfillKitsMsFieldsFromCache(db, opts) {
    const options = opts || {};
    const limit = Math.max(1, Math.min(5000, Number(options.limit) || 2000));
    const allowLive = options.allowLive === true;
    const [rows] = await db.query(
        `SELECT k.*
           FROM dg_new_product_kits k
           JOIN dg_new_products p ON p.id = k.parent_product_id
          WHERE p.channel = 'marketplaces' AND p.status <> 'removed'
            AND k.product_code IS NOT NULL AND TRIM(k.product_code) <> ''
            AND (
              k.barcode IS NULL OR TRIM(k.barcode) = ''
              OR k.vat IS NULL OR TRIM(k.vat) = ''
              OR k.price_markets IS NULL OR k.price_markets <= 0
            )
          ORDER BY k.id ASC
          LIMIT ?`,
        [limit]
    );
    let updated = 0;
    let missed = 0;
    let scanned = 0;
    // Комплектов обычно немного; раньше 30 — часть кодов без ms_export не успевала в live search.
    let liveBudget = allowLive ? Math.min(500, Math.max(80, (rows || []).length)) : 0;

    // Без live — один batch по кэшу (как товары), не N запросов.
    if (!allowLive) {
        const lookups = (rows || []).map((r) =>
            String(r.product_code || r.article || '').trim()
        );
        const enrichMap = await fetchMsEnrichmentMap(db, lookups);
        const pending = [];
        for (const row of rows || []) {
            scanned += 1;
            const lookup = String(row.product_code || row.article || '').trim();
            if (!lookup) {
                missed += 1;
                continue;
            }
            const enrich = enrichMap.get(lookup) || null;
            if (!enrich) {
                missed += 1;
                continue;
            }
            const patch = buildKitMsPatch(row, enrich, { force: false });
            const keys = Object.keys(patch);
            if (keys.length) pending.push({ id: row.id, patch, keys });
        }
        for (const batch of chunkArray(pending, 50)) {
            await Promise.all(
                batch.map((u) =>
                    db.query(
                        `UPDATE dg_new_product_kits SET ${u.keys.map((c) => `\`${c}\` = ?`).join(', ')} WHERE id = ?`,
                        [...u.keys.map((c) => u.patch[c]), u.id]
                    )
                )
            );
            updated += batch.length;
        }
        return { scanned, updated, missed, limit };
    }

    for (const row of rows || []) {
        scanned += 1;
        const needLive =
            liveBudget > 0 &&
            (!String(row.barcode || '').trim() || !String(row.vat || '').trim());
        const r = await enrichAndPersistKitFromMs(db, row, {
            allowLive: needLive,
            force: false,
        });
        if (needLive && (r.reason === 'ms_miss' || (r.enrich && r.enrich._used_live))) {
            liveBudget -= 1;
        }
        if (!r.ok && r.reason === 'ms_miss') {
            missed += 1;
            continue;
        }
        if (r.patch && Object.keys(r.patch).length) updated += 1;
    }
    return { scanned, updated, missed, limit };
}

async function upsertMarketsFromAlmamed(db, almamedRow, opts) {
    const options = opts || {};
    const syncFields = options.syncFields === true;
    /** Явное «создать отдельную строку» после модалки коллизии — без merge по product_code. */
    const forceCreate = options.forceCreate === true;
    const article = String(almamedRow.article || '').trim();
    const explicitCode = String(almamedRow.product_code || '').trim();
    // На Альмамед отдельного «Кода» нет — только артикул. В product_code пишем только код МС.
    if (!article && !explicitCode) return { skipped: true, reason: 'no_code' };

    const sourceIdEarly = almamedRow.id != null ? Number(almamedRow.id) : null;
    let isDetached = forceCreate || Number(almamedRow.collision_detached) === 1;
    let linkedUuid = isDetached ? '' : String(almamedRow.ms_product_uuid || '').trim();
    if (!linkedUuid && sourceIdEarly && !isDetached) {
        try {
            const [[linked]] = await db.query(
                `SELECT ms_product_uuid, COALESCE(collision_detached, 0) AS collision_detached FROM dg_new_products
                  WHERE channel = 'marketplaces' AND source_almamed_id = ?
                  ORDER BY (status = 'removed') ASC, id ASC
                  LIMIT 1`,
                [sourceIdEarly]
            );
            if (linked && Number(linked.collision_detached) === 1) {
                isDetached = true;
            } else if (linked && String(linked.ms_product_uuid || '').trim()) {
                linkedUuid = String(linked.ms_product_uuid).trim();
            }
        } catch (_) {
            /* ignore */
        }
    }
    // Артикул не ищем как код: «20079» — артикул тележки (код 40697) и одновременно код другого товара.
    // Если строка создана через «Создать как новый» (collision_detached), не подтягиваем чужую карточку МС по артикулу.
    let enrich = isDetached
        ? null
        : await resolveMarketsMsCard(db, {
              uuid: linkedUuid,
              article,
              productCode: explicitCode && explicitCode !== article ? explicitCode : '',
          });
    const allowLive = options.allowLive !== false;
    if (enrich && allowLive) {
        enrich = await enrichFromMsWithLiveFallback(db, enrich.code, { allowLive: true });
    }
    const resolvedCode = !isDetached && enrich && enrich.code ? String(enrich.code).trim() : '';

    const placeKey = resolvedCode;
    const emptyPlace = {
        ozon: 0,
        wb: 0,
        ym: 0,
        ozon_url: '',
        wb_url: '',
        ym_url: '',
        ozon_at: null,
        wb_at: null,
        ym_at: null,
    };
    const place = placeKey ? await fetchPlacementInfo(db, placeKey) : emptyPlace;
    const onAllMp = !isDetached && !!(place.ozon && place.wb && place.ym);
    // Если уже на всех МП — в очередь не добавляем, но syncFields (ответственный и т.п.) всё равно пишем.

    const sourceId = almamedRow.id != null ? Number(almamedRow.id) : null;
    const seed = {
        product_manager_user_id: almamedRow.product_manager_user_id,
        product_manager_name: almamedRow.product_manager_name,
        responsible_user_id: almamedRow.responsible_user_id,
        responsible_name: almamedRow.responsible_name,
        priority: almamedRow.priority || 'normal',
        product_code: resolvedCode || null,
        article: article || String((enrich && enrich.article) || '').trim(),
        title: String(almamedRow.title || (enrich && enrich.name) || '').trim(),
        barcode: (enrich && enrich.barcode) || '',
        // На маркетах должна подтягиваться «Цена Маркеты с теста» из МС (не «Цена продажи» / price_almamed с сайта).
        price_markets:
            !isDetached && enrich && enrich.sale_price != null && Number(enrich.sale_price) > 0
                ? Number(enrich.sale_price)
                : null,
        // Габариты — только ручной ввод менеджеров, из МС не подставляем.
        length_cm: null,
        width_cm: null,
        height_cm: null,
        weight_kg: null,
        dimensions_text: '',
        vat: (enrich && enrich.vat) || '',
        ru_url: (enrich && enrich.ru_url) || '',
        ss_ds_url: (enrich && enrich.ss_ds_url) || '',
        placement_ozon: place.ozon,
        placement_wb: place.wb,
        placement_ym: place.ym,
        placement_ozon_url: place.ozon_url || null,
        placement_wb_url: place.wb_url || null,
        placement_ym_url: place.ym_url || null,
        ms_product_uuid: isDetached ? null : almamedRow.ms_product_uuid || (enrich && enrich.uuid) || null,
        source_almamed_id: sourceId,
        has_kits: Number(almamedRow.has_kits) === 1 ? 1 : 0,
        main_not_for_sale: Number(almamedRow.main_not_for_sale) === 1 ? 1 : 0,
        collision_detached: isDetached ? 1 : 0,
        comment: '',
    };
    if (!isDetached) {
        applyPlacementAtFields(seed, null, place);
    }

    const auto = resolveMarketsStatus('new', seed);

    const conn = typeof db.getConnection === 'function' ? await db.getConnection() : null;
    const q = conn || db;

    async function describeCollision(hit) {
        const info = {
            markets_id: hit.id,
            channel_num: hit.channel_num != null ? Number(hit.channel_num) : null,
            article: String(hit.article || '').trim() || null,
            title: String(hit.title || '').trim() || null,
            product_code: String(hit.product_code || '').trim() || null,
            source_almamed_id:
                hit.source_almamed_id != null ? Number(hit.source_almamed_id) : null,
            source_almamed_channel_num: null,
            source_almamed_article: null,
            status: String(hit.status || ''),
            placement_ozon: Number(hit.placement_ozon) === 1,
            placement_wb: Number(hit.placement_wb) === 1,
            placement_ym: Number(hit.placement_ym) === 1,
        };
        if (info.source_almamed_id) {
            try {
                const [[a]] = await q.query(
                    `SELECT channel_num, article, title FROM dg_new_products
                      WHERE id = ? AND channel = 'almamed' LIMIT 1`,
                    [info.source_almamed_id]
                );
                if (a) {
                    info.source_almamed_channel_num =
                        a.channel_num != null ? Number(a.channel_num) : null;
                    info.source_almamed_article = String(a.article || '').trim() || null;
                    if (!info.title && a.title) info.title = String(a.title).trim();
                }
            } catch (_) {
                /* ignore */
            }
        }
        return info;
    }

    /**
     * Своя строка — ТОЛЬКО по source_almamed_id.
     * По product_code больше никогда не merge'им (это и давало перехват Марк #263).
     */
    async function findExisting() {
        if (!sourceId) return { existing: null, collision: null };
        const [bySrc] = await q.query(
            `SELECT * FROM dg_new_products
              WHERE channel = 'marketplaces' AND source_almamed_id = ?
              ORDER BY (status = 'removed') ASC, id ASC
              LIMIT 1`,
            [sourceId]
        );
        if (bySrc && bySrc[0]) {
            return { existing: bySrc[0], collision: null };
        }
        return { existing: null, collision: null };
    }

    /** Любой другой Марк с тем же кодом МС → модалка (без авто-merge и без авто-создания). */
    async function detectCodeCollision() {
        if (!resolvedCode) return null;
        const [existingRows] = await q.query(
            `SELECT * FROM dg_new_products
              WHERE channel = 'marketplaces' AND product_code = ? AND status <> 'removed'
              ORDER BY id ASC
              LIMIT 1`,
            [resolvedCode]
        );
        const hit = existingRows && existingRows[0] ? existingRows[0] : null;
        if (!hit) return null;
        const hitSrc =
            hit.source_almamed_id != null && hit.source_almamed_id !== ''
                ? Number(hit.source_almamed_id)
                : null;
        if (sourceId != null && hitSrc != null && Number(hitSrc) === Number(sourceId)) {
            return null;
        }
        return describeCollision(hit);
    }

    async function applyExistingPatch(existing) {
        const existingSrc =
            existing.source_almamed_id != null && existing.source_almamed_id !== ''
                ? Number(existing.source_almamed_id)
                : null;
        const sameSource =
            sourceId != null && existingSrc != null && Number(existingSrc) === Number(sourceId);
        // Только своя строка (source_almamed_id). Чужую/сироту — никогда не патчим отсюда.
        if (!sameSource) {
            return {
                skipped: true,
                reason: 'code_collision',
                needs_confirm: true,
                collision: await describeCollision(existing),
            };
        }
        const rowDetached = isDetached || Number(existing.collision_detached) === 1;
        const collisionOnExisting = !rowDetached ? await detectCodeCollision() : null;
        const blockMsOverwrite = rowDetached || !!collisionOnExisting;
        const patch = {
            source_almamed_id: existingSrc,
            has_kits: seed.has_kits,
            main_not_for_sale: seed.main_not_for_sale,
        };
        if (rowDetached) {
            patch.collision_detached = 1;
        }
        if (!blockMsOverwrite) {
            patch.placement_ozon = place.ozon;
            patch.placement_wb = place.wb;
            patch.placement_ym = place.ym;
            patch.placement_ozon_url = place.ozon_url || null;
            patch.placement_wb_url = place.wb_url || null;
            patch.placement_ym_url = place.ym_url || null;
            applyPlacementAtFields(patch, existing, place);
            if (seed.product_code) {
                patch.product_code = seed.product_code;
            }
            if (enrich && enrich.uuid && !String(existing.ms_product_uuid || '').trim()) {
                patch.ms_product_uuid = enrich.uuid;
            }
        }
        if (syncFields) {
            patch.priority = seed.priority;
            patch.product_manager_user_id = seed.product_manager_user_id;
            patch.product_manager_name = seed.product_manager_name;
            patch.responsible_user_id = seed.responsible_user_id;
            patch.responsible_name = seed.responsible_name;
            // Идентичность — строго только своей строке (sameSource уже проверен выше).
            patch.article = seed.article;
            if (seed.title) patch.title = seed.title;
            if (
                !blockMsOverwrite &&
                (existing.price_markets == null || Number(existing.price_markets) <= 0) &&
                seed.price_markets != null
            ) {
                patch.price_markets = seed.price_markets;
            }
        } else {
            if (!blockMsOverwrite && !existing.barcode && seed.barcode) patch.barcode = seed.barcode;
            if (
                !blockMsOverwrite &&
                (existing.price_markets == null || Number(existing.price_markets) <= 0) &&
                seed.price_markets != null
            ) {
                patch.price_markets = seed.price_markets;
            }
            if (!blockMsOverwrite && !existing.vat && seed.vat) patch.vat = seed.vat;
            if (!blockMsOverwrite && !existing.ru_url && seed.ru_url) patch.ru_url = seed.ru_url;
            if (!blockMsOverwrite && !existing.ss_ds_url && seed.ss_ds_url) patch.ss_ds_url = seed.ss_ds_url;
            if (!existing.title && seed.title) patch.title = seed.title;
            if (!existing.article && seed.article) patch.article = seed.article;
            if (!existing.product_manager_user_id && seed.product_manager_user_id) {
                patch.product_manager_user_id = seed.product_manager_user_id;
                patch.product_manager_name = seed.product_manager_name;
            }
            if (!existing.responsible_user_id && seed.responsible_user_id) {
                patch.responsible_user_id = seed.responsible_user_id;
                patch.responsible_name = seed.responsible_name;
            }
        }
        const switchingCode =
            !blockMsOverwrite &&
            seed.product_code &&
            String(existing.product_code || '').trim() !== String(seed.product_code);
        if (!blockMsOverwrite) {
            if ((switchingCode || !existing.barcode) && seed.barcode) patch.barcode = seed.barcode;
            if ((switchingCode || !existing.vat) && seed.vat) patch.vat = seed.vat;
            if (switchingCode || !existing.ru_url) patch.ru_url = seed.ru_url || '';
            if (switchingCode || !existing.ss_ds_url) {
                if (seed.ss_ds_url || switchingCode) patch.ss_ds_url = seed.ss_ds_url || '';
            }
            if (switchingCode && enrich && enrich.uuid) patch.ms_product_uuid = enrich.uuid;
        }

        const merged = { ...existing, ...patch };
        // Восстановление из корзины при повторной галочке на Альмамед.
        if (String(existing.status) === 'removed') {
            const st = resolveMarketsStatus('new', merged);
            patch.status = st.status;
            patch.removed_at = null;
            if (st.status === 'added' && !existing.placement_date) patch.placement_date = new Date();
        } else if (!MANUAL_LOCK_STATUSES.has(String(existing.status))) {
            const st = resolveMarketsStatus(existing.status, merged);
            patch.status = st.status;
            if (st.status === 'added' && !existing.placement_date) patch.placement_date = new Date();
        }

        const cols = Object.keys(patch);
        if (cols.length) {
            // Жёсткий SQL-замок: нельзя обновить строку с чужим source_almamed_id.
            const [upd] = await q.query(
                `UPDATE dg_new_products SET ${cols.map((c) => `\`${c}\` = ?`).join(', ')}
                  WHERE id = ?
                    AND channel = 'marketplaces'
                    AND source_almamed_id = ?`,
                [...cols.map((c) => patch[c]), existing.id, sourceId]
            );
            const affected = Number(upd && upd.affectedRows) || 0;
            if (!affected) {
                console.warn('[np-markets-upsert] blocked foreign update', {
                    marketsId: existing.id,
                    sourceId,
                    existingSrc,
                });
                return {
                    skipped: true,
                    reason: 'code_collision',
                    needs_confirm: true,
                    collision: await describeCollision(existing),
                };
            }
            const logNote = syncFields
                ? `Синхронизация с Альмамед #${almamedRow.channel_num != null ? almamedRow.channel_num : almamedRow.id}`
                : 'Обновление очереди маркетов';
            await logMsEnrichFieldChanges(db, {
                productId: existing.id,
                channel: 'marketplaces',
                before: existing,
                fields: patch,
                note: logNote,
                source: syncFields ? 'almamed_sync' : 'ms_enrich',
            });
        }
        return {
            updated: true,
            id: existing.id,
            channel_num:
                existing.channel_num != null ? Number(existing.channel_num) : null,
            status: patch.status || existing.status,
            guard: 'np-markets-upsert-v3',
        };
    }

    try {
        if (conn) await conn.beginTransaction();
        // Сериализуем параллельные PATCH «Маркеты» + «Комплект» по одной Альмамед-строке.
        if (sourceId) {
            await q.query('SELECT id FROM dg_new_products WHERE id = ? FOR UPDATE', [sourceId]);
        }

        let found = await findExisting();
        let existing = found.existing;
        if (existing) {
            const result = await applyExistingPatch(existing);
            if (conn) await conn.commit();
            if (onAllMp) return { ...result, skipped: true, reason: 'already_on_all_mp' };
            return result;
        }

        const collision = await detectCodeCollision();
        if (collision && !forceCreate) {
            if (conn) await conn.commit();
            console.warn('[np-markets-upsert] code_collision needs_confirm', {
                almamedId: sourceId,
                article,
                resolvedCode,
                marketsChannel: collision.channel_num,
            });
            return {
                skipped: true,
                reason: 'code_collision',
                needs_confirm: true,
                collision,
                already_on_all_mp: onAllMp || undefined,
                guard: 'np-markets-upsert-v3',
            };
        }

        if (onAllMp && !forceCreate) {
            if (conn) await conn.commit();
            return {
                skipped: true,
                reason: 'already_on_all_mp',
                collision: collision || null,
                already_on_all_mp: true,
            };
        }

        // После подтверждения «создать как новый» — не копируем чужие данные МС / МП на новую строку.
        if (collision || isDetached) {
            seed.product_code = null;
            seed.ms_product_uuid = null;
            seed.barcode = '';
            seed.vat = '';
            seed.ru_url = '';
            seed.ss_ds_url = '';
            seed.price_markets = null;
            seed.placement_ozon = 0;
            seed.placement_wb = 0;
            seed.placement_ym = 0;
            seed.placement_ozon_url = null;
            seed.placement_wb_url = null;
            seed.placement_ym_url = null;
            seed.placement_ozon_at = null;
            seed.placement_wb_at = null;
            seed.placement_ym_at = null;
            seed.collision_detached = 1;
            if (sourceId) {
                await q.query(
                    'UPDATE dg_new_products SET collision_detached = 1, ms_product_uuid = NULL, almamed_url = NULL, almamed_added_at = NULL WHERE id = ?',
                    [sourceId]
                );
            }
        }
        const finalAuto = resolveMarketsStatus('new', seed);

        try {
            const [ins] = await q.query(
                `INSERT INTO dg_new_products (
                    channel, channel_num, product_manager_user_id, product_manager_name,
                    responsible_user_id, responsible_name, article, title, priority, status, comment,
                    product_code, barcode, price_markets, dimensions_text, length_cm, width_cm, height_cm, weight_kg,
                    vat, ru_url, ss_ds_url, placement_ozon, placement_wb, placement_ym,
                    placement_ozon_url, placement_wb_url, placement_ym_url,
                    placement_ozon_at, placement_wb_at, placement_ym_at, placement_date,
                    ms_product_uuid, source_almamed_id, has_kits, main_not_for_sale, collision_detached
                 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    'marketplaces',
                    await allocChannelNum(q, 'marketplaces'),
                    seed.product_manager_user_id,
                    seed.product_manager_name,
                    seed.responsible_user_id,
                    seed.responsible_name,
                    seed.article,
                    seed.title,
                    seed.priority,
                    finalAuto.status,
                    null,
                    seed.product_code,
                    seed.barcode || null,
                    seed.price_markets,
                    seed.dimensions_text || null,
                    seed.length_cm,
                    seed.width_cm,
                    seed.height_cm,
                    seed.weight_kg,
                    seed.vat || null,
                    seed.ru_url || null,
                    seed.ss_ds_url || null,
                    seed.placement_ozon,
                    seed.placement_wb,
                    seed.placement_ym,
                    seed.placement_ozon_url,
                    seed.placement_wb_url,
                    seed.placement_ym_url,
                    seed.placement_ozon_at || null,
                    seed.placement_wb_at || null,
                    seed.placement_ym_at || null,
                    seed.placement_date || (finalAuto.status === 'added' ? new Date() : null),
                    seed.ms_product_uuid,
                    seed.source_almamed_id,
                    seed.has_kits,
                    seed.main_not_for_sale,
                    seed.collision_detached ? 1 : 0,
                ]
            );
            if (conn) await conn.commit();
            const newId = Number(ins.insertId);
            const almLabel =
                almamedRow.channel_num != null ? `Альмамед #${almamedRow.channel_num}` : `Альмамед id=${almamedRow.id}`;
            let titleNote = `Создано в маркетах из ${almLabel}`;
            if (String(almamedRow.title || '').trim() && seed.title === String(almamedRow.title || '').trim()) {
                titleNote = `Название с ${almLabel}`;
            } else if (enrich && enrich.name && seed.title === String(enrich.name || '').trim()) {
                titleNote = `Название из МойСклад (при создании из ${almLabel})`;
            }
            await insertSystemProductLog(db, {
                productId: newId,
                channel: 'marketplaces',
                field: '_row',
                oldValue: null,
                newValue: seed.title || seed.article || `#${newId}`,
                note: `Строка создана в «Размещение на маркеты» из ${almLabel}`,
                source: 'almamed_sync',
            });
            if (seed.title) {
                await insertSystemProductLog(db, {
                    productId: newId,
                    channel: 'marketplaces',
                    field: 'title',
                    oldValue: null,
                    newValue: seed.title,
                    note: titleNote,
                    source: 'almamed_sync',
                });
            }
            if (seed.article) {
                await insertSystemProductLog(db, {
                    productId: newId,
                    channel: 'marketplaces',
                    field: 'article',
                    oldValue: null,
                    newValue: seed.article,
                    note: `Артикул с ${almLabel}`,
                    source: 'almamed_sync',
                });
            }
            if (seed.responsible_user_id) {
                await insertSystemProductLog(db, {
                    productId: newId,
                    channel: 'marketplaces',
                    field: 'responsible_user_id',
                    oldValue: null,
                    newValue: seed.responsible_name || String(seed.responsible_user_id),
                    note: `Ответственный с ${almLabel}`,
                    source: 'almamed_sync',
                });
            }
            if (seed.product_manager_user_id) {
                await insertSystemProductLog(db, {
                    productId: newId,
                    channel: 'marketplaces',
                    field: 'product_manager_user_id',
                    oldValue: null,
                    newValue: seed.product_manager_name || String(seed.product_manager_user_id),
                    note: `Менеджер с ${almLabel}`,
                    source: 'almamed_sync',
                });
            }
            const [[createdRow]] = await q.query(
                `SELECT channel_num FROM dg_new_products WHERE id = ? LIMIT 1`,
                [newId]
            );
            return {
                created: true,
                id: newId,
                channel_num:
                    createdRow && createdRow.channel_num != null
                        ? Number(createdRow.channel_num)
                        : null,
                status: auto.status,
                ...(collision
                    ? { reason: 'code_collision', collision }
                    : {}),
            };
        } catch (insErr) {
            if (insErr && insErr.code === 'ER_DUP_ENTRY' && sourceId) {
                found = await findExisting();
                existing = found.existing;
                if (existing) {
                    const result = await applyExistingPatch(existing);
                    if (conn) await conn.commit();
                    return result;
                }
            }
            throw insErr;
        }
    } catch (e) {
        if (conn) {
            try {
                await conn.rollback();
            } catch (_) {
                /* ignore */
            }
        }
        throw e;
    } finally {
        if (conn) conn.release();
    }
}

/**
 * Пакетное размещение Ozon/WB/ЯМ по кодам (один SQL вместо N×fetchPlacementInfo).
 * @returns {Map<string, object>}
 */
async function fetchPlacementInfoBatch(db, codes) {
    const map = new Map();
    const list = [...new Set((codes || []).map((c) => String(c || '').trim()).filter(Boolean))];
    const empty = () => ({
        ozon: 0,
        wb: 0,
        ym: 0,
        ozon_url: '',
        wb_url: '',
        ym_url: '',
        ozon_at: null,
        wb_at: null,
        ym_at: null,
    });
    list.forEach((c) => map.set(c, empty()));
    if (!list.length) return map;
    const chunkSize = 400;
    for (let i = 0; i < list.length; i += chunkSize) {
        const chunk = list.slice(i, i + chunkSize);
        const [rows] = await db.query(
            `SELECT external_id, marketplace, buyer_url, cabinet_url, captured_at
               FROM marketplace_export_rows
              WHERE external_id IN (?)
                AND marketplace IN ('ozon', 'wildberries', 'yandex_market')`,
            [chunk]
        );
        (rows || []).forEach((r) => {
            const c = String(r.external_id || '').trim();
            if (!c || !map.has(c)) return;
            const out = map.get(c);
            const mp = String(r.marketplace || '');
            const url = String(r.buyer_url || r.cabinet_url || '').trim();
            const at = r.captured_at || null;
            if (mp === 'ozon') {
                out.ozon = 1;
                out.ozon_url = url;
                out.ozon_at = earlierDate(out.ozon_at, at);
            } else if (mp === 'wildberries') {
                out.wb = 1;
                out.wb_url = url;
                out.wb_at = earlierDate(out.wb_at, at);
            } else if (mp === 'yandex_market') {
                out.ym = 1;
                out.ym_url = url;
                out.ym_at = earlierDate(out.ym_at, at);
            }
        });
    }
    return map;
}

/**
 * Кнопка «Обновить очередь маркетов».
 * Как settings `np_ms_enrich`: поля МС только для пустых из кэша (без live по всем строкам).
 * Плюс upsert из Альмамед и быстрый пакетный refresh размещения на МП.
 */
async function refreshMarketsQueue(db) {
    let fromAlmamed = 0;
    let updated = 0;
    let skippedAll = 0;

    const [almamed] = await db.query(
        `SELECT * FROM dg_new_products
          WHERE channel = 'almamed'
            AND (
              status IN ('added', 'transferred')
              OR COALESCE(sell_on_markets, 0) = 1
              OR COALESCE(has_kits, 0) = 1
              OR COALESCE(main_not_for_sale, 0) = 1
            )
          ORDER BY id ASC
          LIMIT 2000`
    );
    for (const row of almamed || []) {
        const r = await upsertMarketsFromAlmamed(db, row, {
            syncFields:
                Number(row.sell_on_markets) === 1 ||
                Number(row.has_kits) === 1 ||
                Number(row.main_not_for_sale) === 1,
            allowLive: false,
        });
        if (r.created) fromAlmamed += 1;
        else if (r.updated) updated += 1;
        else if (r.reason === 'already_on_all_mp') skippedAll += 1;
    }

    // Тот же лёгкий путь, что «Запустить сейчас» на settings (кэш, без live на каждую строку).
    const bf = await backfillMarketsMsFieldsFromCache(db, { limit: 3000 });

    const [markets] = await db.query(
        `SELECT * FROM dg_new_products
          WHERE channel = 'marketplaces' AND status <> 'removed'
          ORDER BY id ASC
          LIMIT 5000`
    );
    const placeCodes = (markets || []).map((row) => {
        const code = String(row.product_code || '').trim();
        const art = Number(row.collision_detached) === 1 && !code ? '' : String(row.article || '').trim();
        return code || art;
    });
    const placeMap = await fetchPlacementInfoBatch(db, placeCodes);

    for (const row of markets || []) {
        const code = String(row.product_code || '').trim();
        const art = Number(row.collision_detached) === 1 && !code ? '' : String(row.article || '').trim();
        const placeCode = code || art;
        if (!placeCode) continue;
        const place = placeMap.get(placeCode) || {
            ozon: 0,
            wb: 0,
            ym: 0,
            ozon_url: '',
            wb_url: '',
            ym_url: '',
            ozon_at: null,
            wb_at: null,
            ym_at: null,
        };
        const patch = {
            placement_ozon: place.ozon,
            placement_wb: place.wb,
            placement_ym: place.ym,
            placement_ozon_url: place.ozon_url || null,
            placement_wb_url: place.wb_url || null,
            placement_ym_url: place.ym_url || null,
        };
        applyPlacementAtFields(patch, row, place);
        const before = { ...row };
        const merged = { ...row, ...patch };
        if (!MANUAL_LOCK_STATUSES.has(String(row.status))) {
            const st = resolveMarketsStatus(row.status, merged);
            patch.status = st.status;
            if (st.status === 'added' && !row.placement_date && !patch.placement_date) {
                patch.placement_date = new Date();
            }
        }
        const cols = Object.keys(patch).filter((c) => {
            const a = row[c];
            const b = patch[c];
            if (a == null && (b == null || b === '')) return false;
            if (b == null && (a == null || a === '')) return false;
            return String(a) !== String(b);
        });
        if (!cols.length) continue;
        await db.query(
            `UPDATE dg_new_products SET ${cols.map((c) => `\`${c}\` = ?`).join(', ')} WHERE id = ?`,
            [...cols.map((c) => patch[c]), row.id]
        );
        await logMsEnrichFieldChanges(db, {
            productId: row.id,
            channel: 'marketplaces',
            before,
            fields: Object.fromEntries(cols.map((c) => [c, patch[c]])),
            note: 'Обновление очереди маркетов (размещение)',
        });
        updated += 1;
    }

    return {
        from_almamed: fromAlmamed,
        updated: updated + (bf.updated || 0),
        skipped_all_mp: skippedAll,
        ms_backfill_scanned: bf.scanned || 0,
        ms_backfill_updated: bf.updated || 0,
        ms_backfill_missed: bf.missed || 0,
        kits_updated: bf.kits_updated || 0,
        kits_scanned: bf.kits_scanned || 0,
        kits_missed: bf.kits_missed || 0,
    };
}

/**
 * Маркеты, чья Альмамед-строка уже удалена (hard DELETE) или в removed —
 * тоже уводим в корзину, чтобы не захламлять очередь.
 */
async function softRemoveOrphanMarkets(db) {
    const [r] = await db.query(
        `UPDATE dg_new_products m
            LEFT JOIN dg_new_products a
              ON a.id = m.source_almamed_id AND a.channel = 'almamed'
           SET m.status = 'removed',
               m.removed_at = COALESCE(m.removed_at, NOW())
         WHERE m.channel = 'marketplaces'
           AND m.status <> 'removed'
           AND m.source_almamed_id IS NOT NULL
           AND (a.id IS NULL OR a.status = 'removed')
           AND (
                 a.id IS NULL
              OR a.article IS NULL OR TRIM(a.article) = ''
              OR m.article IS NULL OR TRIM(m.article) = ''
              OR m.article = a.article
           )`
    );
    const n = Number(r && r.affectedRows) || 0;
    if (n) console.warn('[new-products] soft-removed orphan markets:', n);
    return { removed: n };
}

async function softRemoveProduct(db, row, { actor, cascadeFromAlmamed } = {}) {
    const id = Number(row.id);
    const channel = row.channel === 'marketplaces' ? 'marketplaces' : 'almamed';
    await db.query(
        `UPDATE dg_new_products
            SET status = 'removed', removed_at = NOW()
          WHERE id = ?`,
        [id]
    );
    let cascaded = 0;
    if (channel === 'almamed' && cascadeFromAlmamed !== false) {
        // Каскад только если артикул маркетов совпадает с Альмамед (или пуст).
        // Защита: после ошибочной перепривязки по коду МС чужой Марк с другим артикулом не улетает в deleted.
        const almArt = String(row.article || '').trim();
        const [r] = await db.query(
            `UPDATE dg_new_products
                SET status = 'removed', removed_at = NOW()
              WHERE channel = 'marketplaces'
                AND source_almamed_id = ?
                AND status <> 'removed'
                AND (
                      ? = ''
                   OR article IS NULL
                   OR TRIM(article) = ''
                   OR article = ?
                )`,
            [id, almArt, almArt]
        );
        cascaded = Number(r && r.affectedRows) || 0;
    }
    return { id, channel, cascaded };
}

async function softRestoreProduct(db, row) {
    const id = Number(row.id);
    const channel = row.channel === 'marketplaces' ? 'marketplaces' : 'almamed';
    const nextStatus = 'new';
    await db.query(
        `UPDATE dg_new_products
            SET status = ?, removed_at = NULL
          WHERE id = ?`,
        [nextStatus, id]
    );
    return { id, channel, status: nextStatus };
}

async function removePlacedMarkets(db, { dryRun } = {}) {
    const [rows] = await db.query(
        `SELECT id, product_code, article FROM dg_new_products
          WHERE channel = 'marketplaces' AND status = 'added'`
    );
    const total = (rows || []).length;
    if (dryRun) {
        return { dry_run: true, total, would_remove: total, removed: 0 };
    }
    if (!total) return { dry_run: false, total: 0, removed: 0 };
    await db.query(
        `UPDATE dg_new_products
            SET status = 'removed', removed_at = NOW(), source_almamed_id = NULL
          WHERE channel = 'marketplaces' AND status = 'added'`
    );
    return { dry_run: false, total, removed: total };
}

/**
 * Подтянуть из МС пустые код / штрихкод (и при необходимости uuid, НДС, РУ, СС·ДС).
 * Габариты — только ручной ввод. По умолчанию только кэш БД (быстрый GET списка);
 * live API МС — opts.allowLive=true (очередь sync / ручной прогон).
 */
async function enrichMarketsRowsFromMs(db, mappedRows, opts) {
    const options = opts || {};
    const liveEnabled = options.allowLive === true;
    const list = mappedRows || [];
    let liveBudget = liveEnabled ? Math.min(25, Number(options.liveBudget) || 25) : 0;
    for (const r of list) {
        if (r.channel !== 'marketplaces') continue;
        if (String(r.status || '') === 'removed') continue;

        const codeNow = String(r.product_code || '').trim();
        if (r.collision_detached && !codeNow) continue;
        const needBarcode = !String(r.barcode || '').trim();
        const needUuid = !String(r.ms_product_uuid || '').trim();
        const needVat = !String(r.vat || '').trim();
        const needRu = !String(r.ru_url || '').trim();
        const needSsDs = !String(r.ss_ds_url || '').trim();
        const needPrice = r.price_markets == null || r.price_markets === '' || Number(r.price_markets) <= 0;
        const cardHint = await resolveMarketsMsCard(db, {
            uuid: r.ms_product_uuid,
            article: r.article,
            productCode: codeNow && codeNow !== String(r.article || '').trim() ? codeNow : '',
        });
        const msCode = cardHint && cardHint.code ? String(cardHint.code).trim() : '';
        const needCode = !codeNow || (msCode && codeNow !== msCode);
        const artNowEarly = String(r.article || '').trim();
        const maybeStale = !msCode && !!codeNow && !!r.ms_product_uuid && !!artNowEarly;
        if (!needCode && !needBarcode && !needUuid && !needVat && !needRu && !needSsDs && !needPrice && !maybeStale) {
            continue;
        }

        // Без live API нет смысла каждый раз ходить в кэш только ради пустых НДС/РУ/СС·ДС —
        // если код уже есть, а ставки в МС нет, повторные GET только тормозят список.
        const onlyVatOrLinks =
            !needCode &&
            !needBarcode &&
            !needUuid &&
            !needPrice &&
            (needVat || needRu || needSsDs);
        if (onlyVatOrLinks && !liveEnabled) {
            continue;
        }

        const artNow = String(r.article || '').trim();
        const before = { ...r };
        if (!cardHint || !cardHint.code) {
            if (r.ms_product_uuid && artNow) {
                const stale = await fetchMsEnrichmentByUuid(db, r.ms_product_uuid);
                if (stale && msCardDisagreesWithArticle(artNow, stale) && stale.code !== msCodeNumericAlias(artNow)) {
                    const clear = {
                        product_code: null,
                        ms_product_uuid: null,
                        barcode: '',
                        ru_url: '',
                        ss_ds_url: '',
                        collision_detached: 1,
                    };
                    await db.query(
                        `UPDATE dg_new_products
                            SET product_code = NULL, ms_product_uuid = NULL, barcode = '', ru_url = '', ss_ds_url = '',
                                collision_detached = 1
                          WHERE id = ?`,
                        [r.id]
                    );
                    r.product_code = '';
                    r.ms_product_uuid = '';
                    r.barcode = '';
                    r.ru_url = '';
                    r.ss_ds_url = '';
                    r.collision_detached = true;
                    await logMsEnrichFieldChanges(db, {
                        productId: r.id,
                        channel: 'marketplaces',
                        before,
                        fields: clear,
                        note: 'Артикул не совпал с карточкой МС — чужой код снят (старая строка)',
                        source: 'ms_enrich',
                    });
                }
            }
            continue;
        }
        if (msCode && msCode !== codeNow) {
            const [taken] = await db.query(
                `SELECT id FROM dg_new_products
                  WHERE channel = 'marketplaces' AND status <> 'removed' AND product_code = ? AND id <> ?
                  LIMIT 1`,
                [msCode, r.id]
            );
            if (taken && taken[0]) {
                const clear = {
                    product_code: null,
                    ms_product_uuid: null,
                    barcode: '',
                    ru_url: '',
                    ss_ds_url: '',
                    collision_detached: 1,
                };
                await db.query(
                    `UPDATE dg_new_products
                        SET product_code = NULL, ms_product_uuid = NULL, barcode = '', ru_url = '', ss_ds_url = '',
                            collision_detached = 1
                      WHERE id = ?`,
                    [r.id]
                );
                r.product_code = '';
                r.ms_product_uuid = '';
                r.barcode = '';
                r.ru_url = '';
                r.ss_ds_url = '';
                r.collision_detached = true;
                await logMsEnrichFieldChanges(db, {
                    productId: r.id,
                    channel: 'marketplaces',
                    before,
                    fields: clear,
                    note: 'Код МС уже занят другой строкой маркетов — создаём как новый, чужие поля сняты',
                    source: 'ms_enrich',
                });
                continue;
            }
        }
        const switching = !!(msCode && codeNow && msCode !== codeNow);
        const allowLive = liveBudget > 0 && (needVat || needRu || needSsDs || needPrice || switching);
        let enrich = cardHint;
        if (allowLive) {
            const live = await enrichFromMsWithLiveFallback(db, cardHint.code, { allowLive: true });
            if (live && live.code) enrich = live;
            liveBudget -= 1;
        }

        const patch = {};
        if (needCode && enrich.code && String(enrich.code).trim() !== codeNow) {
            patch.product_code = String(enrich.code).trim();
            r.product_code = patch.product_code;
        }
        if ((needBarcode || switching) && enrich.barcode && String(enrich.barcode) !== String(r.barcode || '')) {
            patch.barcode = enrich.barcode;
            r.barcode = enrich.barcode;
        }
        if ((needUuid || switching) && enrich.uuid && String(enrich.uuid) !== String(r.ms_product_uuid || '')) {
            patch.ms_product_uuid = enrich.uuid;
            r.ms_product_uuid = enrich.uuid;
        }
        if ((needVat || switching) && enrich.vat && String(enrich.vat) !== String(r.vat || '')) {
            patch.vat = enrich.vat;
            r.vat = enrich.vat;
        }
        if (needRu || switching) {
            const nextRu = String(enrich.ru_url || '').trim();
            if (nextRu !== String(r.ru_url || '').trim() && (nextRu || switching)) {
                patch.ru_url = nextRu;
                r.ru_url = nextRu;
            }
        }
        if (needSsDs || switching) {
            const nextSs = String(enrich.ss_ds_url || '').trim();
            if (nextSs !== String(r.ss_ds_url || '').trim() && (nextSs || switching)) {
                patch.ss_ds_url = nextSs;
                r.ss_ds_url = nextSs;
            }
        }
        if (needPrice && enrich.sale_price != null) {
            patch.price_markets = enrich.sale_price;
            r.price_markets = enrich.sale_price;
        }

        if (!Object.keys(patch).length) continue;

        if (!MANUAL_LOCK_STATUSES.has(String(r.status || ''))) {
            const st = resolveMarketsStatus(r.status, r);
            if (st.changed) {
                patch.status = st.status;
                r.status = st.status;
                r.status_label = MARKETS_STATUS_LABELS[st.status] || st.status;
                if (st.status === 'added' && !r.placement_date) {
                    patch.placement_date = new Date();
                    r.placement_date = patch.placement_date;
                }
            }
        }

        const cols = Object.keys(patch);
        try {
            await db.query(
                `UPDATE dg_new_products SET ${cols.map((c) => `\`${c}\` = ?`).join(', ')} WHERE id = ?`,
                [...cols.map((c) => patch[c]), r.id]
            );
        } catch (_) {
            continue;
        }

        await logMsEnrichFieldChanges(db, {
            productId: r.id,
            channel: 'marketplaces',
            before,
            fields: patch,
            note: 'Подтянуто из МойСклад',
        });

        const miss = getMissingRequiredMarkets(r);
        r.missing_required = miss;
        r.placement_ready = miss.length === 0;
    }

    await backfillMissingMsEnrichLogs(db, mappedRows);
    return mappedRows;
}

const MS_ENRICH_LOG_FIELDS = [
    'product_code',
    'article',
    'barcode',
    'vat',
    'ru_url',
    'ss_ds_url',
    'price_markets',
    'ms_product_uuid',
    'title',
    'status',
];

function clipLogValLocal(v) {
    if (v == null || v === '') return null;
    const s = String(v);
    return s.length > 512 ? s.slice(0, 509) + '…' : s;
}

async function insertSystemProductLog(db, opts) {
    const productId = Number(opts.productId);
    if (!Number.isFinite(productId) || productId < 1) return;
    const field = String(opts.field || '').trim();
    if (!field) return;
    try {
        await db.query(
            `INSERT INTO dg_new_products_log
                (product_id, channel, kit_id, field, old_value, new_value, action, source,
                 changed_by_user_id, changed_by_name, note)
             VALUES (?, ?, NULL, ?, ?, ?, 'set', ?, NULL, 'система', ?)`,
            [
                productId,
                String(opts.channel || 'marketplaces').slice(0, 32),
                field.slice(0, 64),
                clipLogValLocal(opts.oldValue),
                clipLogValLocal(opts.newValue),
                String(opts.source || 'ms_enrich').slice(0, 32),
                opts.note != null ? clipLogValLocal(opts.note) : 'Подтянуто из МойСклад',
            ]
        );
    } catch (_) {
        /* ignore */
    }
}

async function logMsEnrichFieldChanges(db, { productId, channel, before, fields, note, source }) {
    if (!fields || !Object.keys(fields).length) return;
    const src = String(source || 'ms_enrich').slice(0, 32);
    for (const key of Object.keys(fields)) {
        if (!MS_ENRICH_LOG_FIELDS.includes(key) && key !== 'status') continue;
        // placement_* не логируем как «из МС»
        if (String(key).startsWith('placement_')) continue;
        const oldRaw = before ? before[key] : null;
        const newRaw = fields[key];
        const oldS = oldRaw == null || oldRaw === '' ? '' : String(oldRaw);
        const newS = newRaw == null || newRaw === '' ? '' : String(newRaw);
        if (oldS === newS) continue;
        await insertSystemProductLog(db, {
            productId,
            channel: channel || 'marketplaces',
            field: key,
            oldValue: oldS || null,
            newValue: newS || null,
            note: note || (src === 'almamed_sync' ? 'Синхронизация с Альмамед' : 'Подтянуто из МойСклад'),
            source: src,
        });
    }
    // Ответственный / менеджер — отдельно (имена, не только id)
    for (const pair of [
        ['responsible_user_id', 'responsible_name', 'Ответственный'],
        ['product_manager_user_id', 'product_manager_name', 'Менеджер'],
    ]) {
        const idKey = pair[0];
        const nameKey = pair[1];
        if (!(idKey in (fields || {})) && !(nameKey in (fields || {}))) continue;
        const oldId = before ? before[idKey] : null;
        const newId = idKey in fields ? fields[idKey] : before ? before[idKey] : null;
        const oldName = before ? before[nameKey] : null;
        const newName = nameKey in fields ? fields[nameKey] : before ? before[nameKey] : null;
        if (String(oldId ?? '') === String(newId ?? '') && String(oldName ?? '') === String(newName ?? '')) {
            continue;
        }
        await insertSystemProductLog(db, {
            productId,
            channel: channel || 'marketplaces',
            field: idKey,
            oldValue: oldName || oldId || null,
            newValue: newName || newId || null,
            note: note || `${pair[2]}: синхронизация`,
            source: src,
        });
    }
}

/**
 * Ретрозапись в журнал: значение уже есть, а строк по полю ещё не было
 * (раннее автозаполнение из МС без лога).
 */
async function backfillMissingMsEnrichLogs(db, mappedRows) {
    const list = (mappedRows || []).filter(
        (r) => r.channel === 'marketplaces' && String(r.status || '') !== 'removed' && r.id
    );
    if (!list.length) return;
    const ids = list.map((r) => Number(r.id)).filter((id) => Number.isFinite(id) && id > 0);
    if (!ids.length) return;

    const fields = [
        'product_code',
        'article',
        'barcode',
        'vat',
        'ru_url',
        'ss_ds_url',
        'title',
        'responsible_name',
        'product_manager_name',
        'priority',
    ];
    let existing = Object.create(null);
    try {
        const [rows] = await db.query(
            `SELECT product_id, field FROM dg_new_products_log
              WHERE product_id IN (?) AND field IN (?)
              GROUP BY product_id, field`,
            [ids, [...fields, 'responsible_user_id', 'product_manager_user_id', '_row']]
        );
        (rows || []).forEach((row) => {
            existing[`${row.product_id}:${row.field}`] = true;
        });
    } catch (_) {
        return;
    }

    for (const r of list) {
        const id = Number(r.id);
        if (!existing[`${id}:_row`]) {
            await insertSystemProductLog(db, {
                productId: id,
                channel: 'marketplaces',
                field: '_row',
                oldValue: null,
                newValue: r.title || r.article || `#${id}`,
                note: r.source_almamed_id
                    ? `Строка маркетов (ретрозапись); связь с Альмамед id=${r.source_almamed_id}`
                    : 'Строка маркетов (ретрозапись в журнал)',
                source: 'almamed_sync',
            });
            existing[`${id}:_row`] = true;
        }
        for (const field of fields) {
            const val = String(r[field] || '').trim();
            if (!val) continue;
            const logField =
                field === 'responsible_name'
                    ? 'responsible_user_id'
                    : field === 'product_manager_name'
                      ? 'product_manager_user_id'
                      : field;
            if (existing[`${id}:${logField}`] || existing[`${id}:${field}`]) continue;
            let note = 'Ретрозапись: значение уже было в строке без записи в журнал';
            if (field === 'title') {
                note = r.source_almamed_id
                    ? `Название уже было в маркетах (обычно с Альмамед id=${r.source_almamed_id} или из МС)`
                    : 'Название уже было в маркетах (источник не зафиксирован ранее)';
            } else if (field === 'responsible_name') {
                note = 'Ответственный уже был в маркетах (ретрозапись)';
            } else if (field === 'product_manager_name') {
                note = 'Менеджер уже был в маркетах (ретрозапись)';
            } else {
                note = 'Подтянуто из МойСклад / Альмамед (ретрозапись в журнал)';
            }
            await insertSystemProductLog(db, {
                productId: id,
                channel: 'marketplaces',
                field: logField,
                oldValue: null,
                newValue: val,
                note,
                source: field === 'title' || field === 'responsible_name' || field === 'product_manager_name' || field === 'priority'
                    ? 'almamed_sync'
                    : 'ms_enrich',
            });
            existing[`${id}:${logField}`] = true;
        }
    }
}

module.exports = {
    MARKETS_STATUSES,
    MARKETS_STATUS_LABELS,
    MARKETS_REQUIRED,
    MANUAL_LOCK_STATUSES,
    WORKFLOW_STATUSES,
    INFOGRAPHIC_LABELS,
    INFOGRAPHIC_VALUES,
    HUCKSTER_LABELS,
    HUCKSTER_VALUES,
    PHOTO_LABELS,
    PHOTO_VALUES,
    normInfographic,
    normHuckster,
    normPhoto,
    clip,
    parsePrice,
    parseNum,
    formatDimensions,
    hasDimensions,
    getMissingRequiredMarkets,
    resolveMarketsStatus,
    ensureMarketsColumns,
    mapKitRow,
    loadKitsByParentIds,
    attachKitsToMapped,
    attachCrossChannelLinks,
    PRESENCE_GAP_KEYS,
    rowMissesPresenceGap,
    idsMissingPresenceGap,
    attachPresenceBadges,
    stampAlmamedAddedAtFromPresence,
    enrichMarketsRowsFromMs,
    backfillMissingMsEnrichLogs,
    allocChannelNum,
    backfillChannelNums,
    fetchPlacementFlags,
    fetchPlacementInfo,
    fetchMsEnrichment,
    fetchMsEntityLiveForEnrich,
    fetchMsEnrichmentByLiveCode,
    enrichFromMsWithLiveFallback,
    extractMarketTestPriceFromPayload,
    backfillMarketsMsFieldsFromCache,
    backfillKitsMsFieldsFromCache,
    enrichAndPersistKitFromMs,
    buildKitMsPatch,
    upsertMarketsFromAlmamed,
    refreshMarketsQueue,
    removePlacedMarkets,
    dedupeMarketsBySourceAlmamed,
    softRemoveOrphanMarkets,
    softRemoveProduct,
    softRestoreProduct,
};
