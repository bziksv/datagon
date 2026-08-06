'use strict';

/**
 * Логика вкладки «Размещение на маркеты» для dg_new_products (channel=marketplaces).
 */

const axios = require('axios');

const MS_BASE_URL = 'https://api.moysklad.ru/api/remap/1.2';
const MS_PRODUCT_EXPAND =
    'attributes,supplier,images,country,uom,salePrices,buyPrice,minPrice,barcodes,countryOfOrigin,productFolder';

const MANUAL_LOCK_STATUSES = new Set(['not_cooperate', 'in_bundle']);
const MARKETS_STATUSES = new Set([
    'new',
    'not_added',
    'added',
    'revision',
    'not_cooperate',
    'in_bundle',
    'removed',
]);

const MARKETS_STATUS_LABELS = {
    new: 'Новый',
    not_added: 'Не добавлен',
    added: 'Добавлен',
    revision: 'На доработке',
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
    { key: 'length_cm', label: 'Длина, см' },
    { key: 'width_cm', label: 'Ширина, см' },
    { key: 'height_cm', label: 'Высота, см' },
    { key: 'weight_kg', label: 'Вес, кг' },
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
    if (parseNum(row.length_cm) == null) missing.push({ key: 'length_cm', label: 'Длина, см' });
    if (parseNum(row.width_cm) == null) missing.push({ key: 'width_cm', label: 'Ширина, см' });
    if (parseNum(row.height_cm) == null) missing.push({ key: 'height_cm', label: 'Высота, см' });
    if (parseNum(row.weight_kg) == null) missing.push({ key: 'weight_kg', label: 'Вес, кг' });
    if (!String(row.vat || '').trim()) missing.push({ key: 'vat', label: 'НДС' });
    if (!String(row.ru_url || '').trim()) missing.push({ key: 'ru_url', label: 'Ссылка на РУ' });
    return missing;
}

function placementAll(row) {
    return Number(row.placement_ozon) === 1 && Number(row.placement_wb) === 1 && Number(row.placement_ym) === 1;
}

/**
 * Авто-статус для маркетов.
 * Ручные «Не сотрудничаем» / «В составе комплекта» не трогаем.
 * Комментарий → «На доработке»; очистка комментария → «Добавлен» если на всех МП, иначе new/not_added.
 */
function resolveMarketsStatus(currentStatus, merged) {
    const st = String(currentStatus || 'new');
    if (MANUAL_LOCK_STATUSES.has(st)) {
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

async function ensureMarketsColumns(db) {
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
        ['placement_ozon', 'TINYINT(1) NOT NULL DEFAULT 0'],
        ['placement_wb', 'TINYINT(1) NOT NULL DEFAULT 0'],
        ['placement_ym', 'TINYINT(1) NOT NULL DEFAULT 0'],
        ['placement_ozon_url', 'VARCHAR(2048) NULL'],
        ['placement_wb_url', 'VARCHAR(2048) NULL'],
        ['placement_ym_url', 'VARCHAR(2048) NULL'],
        ['placement_date', 'DATETIME NULL'],
        ['source_almamed_id', 'BIGINT NULL'],
        ['removed_at', 'DATETIME NULL'],
        ['has_kits', 'TINYINT(1) NOT NULL DEFAULT 0'],
        ['channel_num', 'INT NULL'],
        ['infographic', 'VARCHAR(32) NULL'],
        ['photo', 'VARCHAR(32) NULL'],
    ];
    for (const [name, def] of cols) {
        const [rows] = await db.query('SHOW COLUMNS FROM `dg_new_products` LIKE ?', [name]);
        if (Array.isArray(rows) && rows.length) continue;
        await db.query(`ALTER TABLE \`dg_new_products\` ADD COLUMN \`${name}\` ${def}`);
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
    for (const [name, def] of kitCols) {
        const [rows] = await db.query('SHOW COLUMNS FROM `dg_new_product_kits` LIKE ?', [name]);
        if (Array.isArray(rows) && rows.length) continue;
        await db.query(`ALTER TABLE \`dg_new_product_kits\` ADD COLUMN \`${name}\` ${def}`);
    }
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
        r.kits = r.channel === 'marketplaces' ? byParent[r.id] || [] : [];
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
                `SELECT id, channel_num, source_almamed_id FROM dg_new_products
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
                    };
                }
            });
            list.forEach((r) => {
                if (r.channel !== 'almamed') return;
                const hit = bySrc[r.id];
                r.markets_product_id = hit ? hit.id : null;
                r.markets_channel_num = hit ? hit.channel_num : null;
            });
        }
        if (sourceIds.length) {
            const [srcs] = await db.query(
                `SELECT id, channel_num, almamed_url FROM dg_new_products
                  WHERE channel = 'almamed' AND id IN (?)`,
                [sourceIds]
            );
            const byId = {};
            (srcs || []).forEach((s) => {
                byId[Number(s.id)] = {
                    channel_num: s.channel_num != null ? Number(s.channel_num) : null,
                    almamed_url: String(s.almamed_url || '').trim(),
                };
            });
            list.forEach((r) => {
                if (r.channel !== 'marketplaces' || !r.source_almamed_id) return;
                const hit = byId[Number(r.source_almamed_id)];
                if (!hit) return;
                r.source_almamed_channel_num = hit.channel_num;
                // Ссылка на карточку Альмамед — с родительской строки / для бейджа «АЛЬ»
                if (!String(r.almamed_url || '').trim() && hit.almamed_url) {
                    r.almamed_url = hit.almamed_url;
                }
            });
        }
    } catch (_) {
        /* ignore */
    }
    return mappedRows;
}

/**
 * Живые бейджи связей после ID: Альм / Мои (CMS) / МС / Ozon / WB / ЯМ.
 * Читает my_products + ms_export + marketplace_export_rows по коду/артикулу текущей страницы.
 * Не пишет в dg_new_products — только для отображения (после импортов CMS/МС/МП).
 */
async function attachPresenceBadges(db, mappedRows) {
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
        if (r.ms_product_uuid) {
            r.presence.ms = true;
            if (!r.presence.ms_uuid) r.presence.ms_uuid = String(r.ms_product_uuid);
        }
    });

    const keys = [];
    const keySet = new Set();
    list.forEach((r) => {
        [r.product_code, r.article].forEach((raw) => {
            const k = String(raw || '').trim();
            if (!k || keySet.has(k)) return;
            keySet.add(k);
            keys.push(k);
        });
    });
    if (!keys.length) return mappedRows;

    const msByKey = Object.create(null);
    const myByKey = Object.create(null);
    const placeByKey = Object.create(null);

    await Promise.all([
        (async () => {
            try {
                const [msRows] = await db.query(
                    `SELECT mse.code, mse.uuid, med.denorm_article
                       FROM ms_export mse
                       LEFT JOIN ms_entity_details med ON med.uuid = mse.uuid
                      WHERE mse.code IN (?)
                         OR med.denorm_article IN (?)`,
                    [keys, keys]
                );
                (msRows || []).forEach((row) => {
                    const code = String(row.code || '').trim();
                    const art = String(row.denorm_article || '').trim();
                    const hit = { code, uuid: row.uuid || '' };
                    if (code) msByKey[code] = hit;
                    if (art) msByKey[art] = hit;
                });
            } catch (_) {
                /* ignore */
            }
        })(),
        (async () => {
            try {
                const [myRows] = await db.query(
                    `SELECT sku, source_url FROM my_products
                      WHERE is_active = 1 AND sku IN (?)
                      LIMIT 500`,
                    [keys]
                );
                (myRows || []).forEach((row) => {
                    const sku = String(row.sku || '').trim();
                    if (!sku) return;
                    myByKey[sku] = {
                        sku,
                        url: String(row.source_url || '').trim(),
                    };
                });
            } catch (_) {
                /* ignore */
            }
        })(),
        (async () => {
            try {
                const [mpRows] = await db.query(
                    `SELECT external_id, marketplace, buyer_url, cabinet_url
                       FROM marketplace_export_rows
                      WHERE external_id IN (?)
                        AND marketplace IN ('ozon', 'wildberries', 'yandex_market')`,
                    [keys]
                );
                (mpRows || []).forEach((row) => {
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
                        };
                    }
                    const url = String(row.buyer_url || row.cabinet_url || '').trim();
                    const mp = String(row.marketplace || '');
                    if (mp === 'ozon') {
                        placeByKey[id].ozon = true;
                        if (url) placeByKey[id].ozon_url = url;
                    } else if (mp === 'wildberries') {
                        placeByKey[id].wb = true;
                        if (url) placeByKey[id].wb_url = url;
                    } else if (mp === 'yandex_market') {
                        placeByKey[id].ym = true;
                        if (url) placeByKey[id].ym_url = url;
                    }
                });
            } catch (_) {
                /* ignore */
            }
        })(),
    ]);

    list.forEach((r) => {
        const code = String(r.product_code || '').trim();
        const art = String(r.article || '').trim();
        const msHit = (code && msByKey[code]) || (art && msByKey[art]) || null;
        if (msHit) {
            r.presence.ms = true;
            r.presence.ms_code = msHit.code || code || art;
            if (msHit.uuid) r.presence.ms_uuid = String(msHit.uuid);
        }
        if ((code && myByKey[code]) || (art && myByKey[art])) {
            const myHit = (code && myByKey[code]) || (art && myByKey[art]);
            r.presence.my_products = true;
            r.presence.my_sku = (myHit && myHit.sku) || (code && myByKey[code] && code) || art;
            if (myHit && myHit.url) {
                r.presence.my_url = myHit.url;
                // Бейдж «АЛЬ» на обеих вкладках — ссылка из «Мои товары», если ещё нет
                if (!String(r.almamed_url || '').trim()) {
                    r.almamed_url = myHit.url;
                }
            }
        }
        const placeKeys = [];
        if (msHit && msHit.code) placeKeys.push(msHit.code);
        if (code) placeKeys.push(code);
        if (art) placeKeys.push(art);
        placeKeys.forEach((pk) => {
            const p = placeByKey[pk];
            if (!p) return;
            if (p.ozon) {
                r.presence.ozon = true;
                if (p.ozon_url) r.presence.ozon_url = p.ozon_url;
            }
            if (p.wb) {
                r.presence.wb = true;
                if (p.wb_url) r.presence.wb_url = p.wb_url;
            }
            if (p.ym) {
                r.presence.ym = true;
                if (p.ym_url) r.presence.ym_url = p.ym_url;
            }
        });
        // Для столбца «Размещение» тоже подтягиваем live-флаги (без записи в БД).
        r.placement_ozon = !!r.presence.ozon;
        r.placement_wb = !!r.presence.wb;
        r.placement_ym = !!r.presence.ym;
        if (r.presence.ozon_url) r.placement_ozon_url = r.presence.ozon_url;
        if (r.presence.wb_url) r.placement_wb_url = r.presence.wb_url;
        if (r.presence.ym_url) r.placement_ym_url = r.presence.ym_url;
    });

    return mappedRows;
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
    };
    const c = String(code || '').trim();
    if (!c) return empty;
    try {
        const [rows] = await db.query(
            `SELECT marketplace, buyer_url, cabinet_url FROM marketplace_export_rows
              WHERE external_id = ?
                AND marketplace IN ('ozon', 'wildberries', 'yandex_market')`,
            [c]
        );
        const out = { ...empty };
        (rows || []).forEach((r) => {
            const mp = String(r.marketplace || '');
            const url = String(r.buyer_url || r.cabinet_url || '').trim();
            if (mp === 'ozon') {
                out.ozon = 1;
                out.ozon_url = url;
            } else if (mp === 'wildberries') {
                out.wb = 1;
                out.wb_url = url;
            } else if (mp === 'yandex_market') {
                out.ym = 1;
                out.ym_url = url;
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
    let salePrice = null;
    const sp = String(r.sale_price || '').replace(/[^\d.,]/g, '').replace(',', '.');
    if (sp) {
        const n = Number(sp);
        if (Number.isFinite(n)) salePrice = n;
    }
    const vat = extractVatFromPayload(payload, r.vat, r.vat_on_product);
    const attrsMissing =
        !payload || !Array.isArray(payload.attributes) || payload.attributes.length === 0;
    return {
        code: String(r.code || '').trim(),
        name: String(r.name || '').trim(),
        uuid: r.uuid || '',
        article,
        barcode,
        vat,
        sale_price: salePrice,
        ru_url: extractRuUrlFromPayload(payload),
        _attrs_missing: attrsMissing,
        _use_parent_vat: !!(payload && payload.useParentVat),
    };
}

const MS_ENRICH_SQL = `SELECT mse.code, mse.name, mse.vat, mse.vat_on_product, mse.sale_price, mse.uuid,
                med.denorm_article, med.payload_json
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
 * Live GET карточки МС (expand attributes), если в кэше нет НДС / ссылки на РУ.
 * Пишет payload в ms_entity_details и при возможности vat в ms_export.
 */
async function fetchMsProductLiveForEnrich(db, uuid) {
    const u = String(uuid || '').trim();
    const token = getMsToken();
    if (!u || !token) return null;
    try {
        const resp = await axios.get(`${MS_BASE_URL}/entity/product/${encodeURIComponent(u)}`, {
            headers: { Authorization: `Bearer ${token}` },
            timeout: 45000,
            params: { expand: MS_PRODUCT_EXPAND },
        });
        const entity = resp && resp.data;
        if (!entity || typeof entity !== 'object') return null;
        const payloadJson = JSON.stringify(entity);
        const article = String(entity.article || '').trim();
        const code = String(entity.code || '').trim();
        let vat = extractVatFromPayload(entity, null, null);
        if (!vat) vat = await resolveVatFromProductFolderChain(token, entity);
        try {
            await db.query(
                `INSERT INTO ms_entity_details (uuid, code, kind, name, payload_json, source, denorm_article)
                 VALUES (?, ?, 'product', ?, ?, 'np_enrich', ?)
                 ON DUPLICATE KEY UPDATE
                   code = VALUES(code),
                   name = VALUES(name),
                   payload_json = VALUES(payload_json),
                   source = VALUES(source),
                   denorm_article = VALUES(denorm_article),
                   updated_at = CURRENT_TIMESTAMP`,
                [u, code || null, String(entity.name || '').slice(0, 500), payloadJson, article || null]
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
            article,
            barcode: extractBarcodesFromPayload(entity),
            vat,
            sale_price: null,
            ru_url: extractRuUrlFromPayload(entity),
        };
    } catch (e) {
        console.warn('[new-products] MS live enrich failed:', e && e.message);
        return null;
    }
}

/**
 * Обогащение из кэша МС; при пустых НДС/РУ и наличии uuid — один live GET.
 * @param {{ allowLive?: boolean }} opts
 */
async function enrichFromMsWithLiveFallback(db, key, opts) {
    const options = opts || {};
    const allowLive = options.allowLive !== false;
    let enrich = await fetchMsEnrichment(db, key);
    if (!enrich) return null;
    const needVat = !String(enrich.vat || '').trim();
    const needRu = !String(enrich.ru_url || '').trim();
    if (!needVat && !needRu) return enrich;
    if (!allowLive) return enrich;
    const uuid = String(enrich.uuid || '').trim();
    if (!uuid) return enrich;
    // Live только если кэш без атрибутов / НДС с родителя без effectiveVat / пустой РУ
    const shouldLive =
        needVat || needRu || enrich._attrs_missing || (needVat && enrich._use_parent_vat);
    if (!shouldLive) return enrich;
    const live = await fetchMsProductLiveForEnrich(db, uuid);
    if (!live) return enrich;
    return {
        ...enrich,
        vat: enrich.vat || live.vat || '',
        ru_url: enrich.ru_url || live.ru_url || '',
        barcode: enrich.barcode || live.barcode || '',
        article: enrich.article || live.article || '',
        code: enrich.code || live.code || '',
        name: enrich.name || live.name || '',
    };
}

/**
 * Обогащение из МС: сначала по коду, затем по артикулу (когда товар уже в МС после Альмамед).
 */
async function fetchMsEnrichment(db, key) {
    const c = String(key || '').trim();
    if (!c) return null;
    try {
        const [byCode] = await db.query(`${MS_ENRICH_SQL} WHERE mse.code = ? LIMIT 1`, [c]);
        if (byCode && byCode[0]) return mapMsEnrichRow(byCode[0]);
        const [byArt] = await db.query(
            `${MS_ENRICH_SQL}
              WHERE med.denorm_article = ?
                 OR JSON_UNQUOTE(JSON_EXTRACT(med.payload_json, '$.article')) = ?
              LIMIT 1`,
            [c, c]
        );
        if (byArt && byArt[0]) return mapMsEnrichRow(byArt[0]);
    } catch (e) {
        // fallback без JSON_EXTRACT если MySQL старый / нет JSON
        try {
            const [byCode] = await db.query(`${MS_ENRICH_SQL} WHERE mse.code = ? LIMIT 1`, [c]);
            if (byCode && byCode[0]) return mapMsEnrichRow(byCode[0]);
            const [byArt] = await db.query(
                `${MS_ENRICH_SQL} WHERE med.denorm_article = ? LIMIT 1`,
                [c]
            );
            if (byArt && byArt[0]) return mapMsEnrichRow(byArt[0]);
        } catch (_) {
            return null;
        }
    }
    return null;
}

async function upsertMarketsFromAlmamed(db, almamedRow, opts) {
    const options = opts || {};
    const syncFields = options.syncFields === true;
    const article = String(almamedRow.article || '').trim();
    const explicitCode = String(almamedRow.product_code || '').trim();
    // На Альмамед отдельного «Кода» нет — только артикул. Не копируем артикул в product_code.
    if (!article && !explicitCode) return { skipped: true, reason: 'no_code' };

    const lookupKey = explicitCode || article;
    const enrich = await enrichFromMsWithLiveFallback(db, lookupKey, { allowLive: true });
    // Код МС: явный с Альмамед, иначе из ms_export (по коду или артикулу после появления в системе).
    let resolvedCode = explicitCode;
    if (enrich && enrich.code) {
        resolvedCode = String(enrich.code).trim() || resolvedCode;
    }

    const placeKey = resolvedCode || lookupKey;
    const place = await fetchPlacementInfo(db, placeKey);
    const onAllMp = !!(place.ozon && place.wb && place.ym);
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
        price_markets:
            almamedRow.price_almamed != null
                ? Number(almamedRow.price_almamed)
                : enrich && enrich.sale_price != null
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
        placement_ozon: place.ozon,
        placement_wb: place.wb,
        placement_ym: place.ym,
        placement_ozon_url: place.ozon_url || null,
        placement_wb_url: place.wb_url || null,
        placement_ym_url: place.ym_url || null,
        ms_product_uuid: almamedRow.ms_product_uuid || (enrich && enrich.uuid) || null,
        source_almamed_id: sourceId,
        has_kits: Number(almamedRow.has_kits) === 1 ? 1 : 0,
        comment: '',
    };

    const auto = resolveMarketsStatus('new', seed);

    const conn = typeof db.getConnection === 'function' ? await db.getConnection() : null;
    const q = conn || db;

    async function findExisting() {
        let existing = null;
        if (sourceId) {
            // Сначала активная строка; если нет — «удалённая» (восстановим при галочке).
            const [bySrc] = await q.query(
                `SELECT * FROM dg_new_products
                  WHERE channel = 'marketplaces' AND source_almamed_id = ?
                  ORDER BY (status = 'removed') ASC, id ASC
                  LIMIT 1`,
                [sourceId]
            );
            existing = bySrc && bySrc[0] ? bySrc[0] : null;
        }
        if (!existing && resolvedCode) {
            const [existingRows] = await q.query(
                `SELECT * FROM dg_new_products
                  WHERE channel = 'marketplaces' AND product_code = ? AND status <> 'removed'
                  LIMIT 1`,
                [resolvedCode]
            );
            existing = existingRows && existingRows[0] ? existingRows[0] : null;
        }
        return existing;
    }

    async function applyExistingPatch(existing) {
        const patch = {
            placement_ozon: place.ozon,
            placement_wb: place.wb,
            placement_ym: place.ym,
            placement_ozon_url: place.ozon_url || null,
            placement_wb_url: place.wb_url || null,
            placement_ym_url: place.ym_url || null,
            source_almamed_id: sourceId != null ? sourceId : existing.source_almamed_id,
            has_kits: seed.has_kits,
        };
        if (seed.product_code) {
            patch.product_code = seed.product_code;
        } else if (!enrich && article && String(existing.product_code || '').trim() === article) {
            patch.product_code = null;
        }
        if (syncFields) {
            patch.priority = seed.priority;
            patch.product_manager_user_id = seed.product_manager_user_id;
            patch.product_manager_name = seed.product_manager_name;
            patch.responsible_user_id = seed.responsible_user_id;
            patch.responsible_name = seed.responsible_name;
            patch.article = seed.article;
            if (seed.title) patch.title = seed.title;
            if (seed.price_markets != null) patch.price_markets = seed.price_markets;
        } else {
            if (!existing.barcode && seed.barcode) patch.barcode = seed.barcode;
            if (existing.price_markets == null && seed.price_markets != null) {
                patch.price_markets = seed.price_markets;
            }
            if (!existing.vat && seed.vat) patch.vat = seed.vat;
            if (!existing.ru_url && seed.ru_url) patch.ru_url = seed.ru_url;
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
        if (!existing.barcode && seed.barcode) patch.barcode = seed.barcode;
        if (!existing.vat && seed.vat) patch.vat = seed.vat;
        if (!existing.ru_url && seed.ru_url) patch.ru_url = seed.ru_url;

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
            await q.query(
                `UPDATE dg_new_products SET ${cols.map((c) => `\`${c}\` = ?`).join(', ')} WHERE id = ?`,
                [...cols.map((c) => patch[c]), existing.id]
            );
        }
        return { updated: true, id: existing.id, status: patch.status || existing.status };
    }

    try {
        if (conn) await conn.beginTransaction();
        // Сериализуем параллельные PATCH «Маркеты» + «Комплект» по одной Альмамед-строке.
        if (sourceId) {
            await q.query('SELECT id FROM dg_new_products WHERE id = ? FOR UPDATE', [sourceId]);
        }

        let existing = await findExisting();
        if (existing) {
            const result = await applyExistingPatch(existing);
            if (conn) await conn.commit();
            if (onAllMp) return { ...result, skipped: true, reason: 'already_on_all_mp' };
            return result;
        }

        if (onAllMp) {
            if (conn) await conn.commit();
            return { skipped: true, reason: 'already_on_all_mp' };
        }

        try {
            const [ins] = await q.query(
                `INSERT INTO dg_new_products (
                    channel, channel_num, product_manager_user_id, product_manager_name,
                    responsible_user_id, responsible_name, article, title, priority, status, comment,
                    product_code, barcode, price_markets, dimensions_text, length_cm, width_cm, height_cm, weight_kg,
                    vat, ru_url, placement_ozon, placement_wb, placement_ym,
                    placement_ozon_url, placement_wb_url, placement_ym_url, placement_date,
                    ms_product_uuid, source_almamed_id, has_kits
                 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
                    auto.status,
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
                    seed.placement_ozon,
                    seed.placement_wb,
                    seed.placement_ym,
                    seed.placement_ozon_url,
                    seed.placement_wb_url,
                    seed.placement_ym_url,
                    auto.status === 'added' ? new Date() : null,
                    seed.ms_product_uuid,
                    seed.source_almamed_id,
                    seed.has_kits,
                ]
            );
            if (conn) await conn.commit();
            return { created: true, id: ins.insertId, status: auto.status };
        } catch (insErr) {
            if (insErr && insErr.code === 'ER_DUP_ENTRY' && sourceId) {
                existing = await findExisting();
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
            )
          ORDER BY id ASC
          LIMIT 2000`
    );
    for (const row of almamed || []) {
        const r = await upsertMarketsFromAlmamed(db, row, {
            syncFields: Number(row.sell_on_markets) === 1 || Number(row.has_kits) === 1,
        });
        if (r.created) fromAlmamed += 1;
        else if (r.updated) updated += 1;
        else if (r.reason === 'already_on_all_mp') skippedAll += 1;
    }

    const [markets] = await db.query(
        `SELECT * FROM dg_new_products
          WHERE channel = 'marketplaces' AND status <> 'removed'
          ORDER BY id ASC
          LIMIT 5000`
    );
    let liveBudget = 40;
    for (const row of markets || []) {
        const lookup = String(row.product_code || row.article || '').trim();
        if (!lookup) continue;
        const needLive =
            liveBudget > 0 &&
            (!String(row.vat || '').trim() || !String(row.ru_url || '').trim());
        const enrich = await enrichFromMsWithLiveFallback(db, lookup, {
            allowLive: needLive,
        });
        if (needLive && enrich && (enrich.vat || enrich.ru_url)) liveBudget -= 1;
        const placeCode = (enrich && enrich.code) || String(row.product_code || '').trim() || lookup;
        const place = await fetchPlacementInfo(db, placeCode);
        const patch = {
            placement_ozon: place.ozon,
            placement_wb: place.wb,
            placement_ym: place.ym,
            placement_ozon_url: place.ozon_url || null,
            placement_wb_url: place.wb_url || null,
            placement_ym_url: place.ym_url || null,
        };
        if (enrich) {
            if (!row.barcode && enrich.barcode) patch.barcode = enrich.barcode;
            if (!row.vat && enrich.vat) patch.vat = enrich.vat;
            if (!row.ru_url && enrich.ru_url) patch.ru_url = enrich.ru_url;
            if (row.price_markets == null && enrich.sale_price != null) patch.price_markets = enrich.sale_price;
            if (!row.article && enrich.article) patch.article = enrich.article;
            if (!row.title && enrich.name) patch.title = enrich.name;
            if (enrich.code) patch.product_code = enrich.code;
            if (!row.ms_product_uuid && enrich.uuid) patch.ms_product_uuid = enrich.uuid;
        }
        const before = { ...row };
        const merged = { ...row, ...patch };
        if (!MANUAL_LOCK_STATUSES.has(String(row.status))) {
            const st = resolveMarketsStatus(row.status, merged);
            patch.status = st.status;
            if (st.status === 'added' && !row.placement_date) patch.placement_date = new Date();
        }
        const cols = Object.keys(patch);
        await db.query(
            `UPDATE dg_new_products SET ${cols.map((c) => `\`${c}\` = ?`).join(', ')} WHERE id = ?`,
            [...cols.map((c) => patch[c]), row.id]
        );
        await logMsEnrichFieldChanges(db, {
            productId: row.id,
            channel: 'marketplaces',
            before,
            fields: patch,
            note: 'Подтянуто из МойСклад (очередь маркетов)',
        });
        updated += 1;
    }

    return { from_almamed: fromAlmamed, updated, skipped_all_mp: skippedAll };
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
           AND (a.id IS NULL OR a.status = 'removed')`
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
        const [r] = await db.query(
            `UPDATE dg_new_products
                SET status = 'removed', removed_at = NOW()
              WHERE channel = 'marketplaces'
                AND source_almamed_id = ?
                AND status <> 'removed'`,
            [id]
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
 * Подтянуть из МС пустые код / штрихкод (и при необходимости uuid, НДС, РУ).
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

        const needCode = !String(r.product_code || '').trim();
        const needBarcode = !String(r.barcode || '').trim();
        const needUuid = !String(r.ms_product_uuid || '').trim();
        const needVat = !String(r.vat || '').trim();
        const needRu = !String(r.ru_url || '').trim();
        const needPrice = r.price_markets == null || r.price_markets === '';
        if (!needCode && !needBarcode && !needUuid && !needVat && !needRu && !needPrice) {
            continue;
        }

        // Без live API нет смысла каждый раз ходить в кэш только ради пустых НДС/РУ —
        // если код уже есть, а ставки в МС нет, повторные GET только тормозят список.
        const onlyVatOrRu =
            !needCode && !needBarcode && !needUuid && !needPrice && (needVat || needRu);
        if (onlyVatOrRu && !liveEnabled) {
            continue;
        }

        const lookup = String(r.product_code || r.article || '').trim();
        if (!lookup) continue;
        const allowLive = liveBudget > 0 && (needVat || needRu);
        const enrich = await enrichFromMsWithLiveFallback(db, lookup, { allowLive });
        if (!enrich) continue;
        if (allowLive) liveBudget -= 1;

        const before = { ...r };
        const patch = {};
        if (needCode && enrich.code) {
            patch.product_code = enrich.code;
            r.product_code = enrich.code;
        }
        if (needBarcode && enrich.barcode) {
            patch.barcode = enrich.barcode;
            r.barcode = enrich.barcode;
        }
        if (needUuid && enrich.uuid) {
            patch.ms_product_uuid = enrich.uuid;
            r.ms_product_uuid = enrich.uuid;
        }
        if (needVat && enrich.vat) {
            patch.vat = enrich.vat;
            r.vat = enrich.vat;
        }
        if (needRu && enrich.ru_url) {
            patch.ru_url = enrich.ru_url;
            r.ru_url = enrich.ru_url;
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

async function logMsEnrichFieldChanges(db, { productId, channel, before, fields, note }) {
    if (!fields || !Object.keys(fields).length) return;
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
            note: note || 'Подтянуто из МойСклад',
            source: 'ms_enrich',
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

    const fields = ['product_code', 'article', 'barcode', 'vat', 'ru_url'];
    let existing = Object.create(null);
    try {
        const [rows] = await db.query(
            `SELECT product_id, field FROM dg_new_products_log
              WHERE product_id IN (?) AND field IN (?)
              GROUP BY product_id, field`,
            [ids, fields]
        );
        (rows || []).forEach((row) => {
            existing[`${row.product_id}:${row.field}`] = true;
        });
    } catch (_) {
        return;
    }

    for (const r of list) {
        const id = Number(r.id);
        for (const field of fields) {
            const val = String(r[field] || '').trim();
            if (!val) continue;
            if (existing[`${id}:${field}`]) continue;
            await insertSystemProductLog(db, {
                productId: id,
                channel: 'marketplaces',
                field,
                oldValue: null,
                newValue: val,
                note: 'Подтянуто из МойСклад (ретрозапись в журнал)',
                source: 'ms_enrich',
            });
            existing[`${id}:${field}`] = true;
        }
    }
}

module.exports = {
    MARKETS_STATUSES,
    MARKETS_STATUS_LABELS,
    MARKETS_REQUIRED,
    MANUAL_LOCK_STATUSES,
    INFOGRAPHIC_LABELS,
    INFOGRAPHIC_VALUES,
    PHOTO_LABELS,
    PHOTO_VALUES,
    normInfographic,
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
    attachPresenceBadges,
    stampAlmamedAddedAtFromPresence,
    enrichMarketsRowsFromMs,
    allocChannelNum,
    backfillChannelNums,
    fetchPlacementFlags,
    fetchPlacementInfo,
    fetchMsEnrichment,
    upsertMarketsFromAlmamed,
    refreshMarketsQueue,
    removePlacedMarkets,
    dedupeMarketsBySourceAlmamed,
    softRemoveOrphanMarkets,
    softRemoveProduct,
    softRestoreProduct,
};
