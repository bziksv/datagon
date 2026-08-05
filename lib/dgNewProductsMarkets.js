'use strict';

/**
 * Логика вкладки «Размещение на маркеты» для dg_new_products (channel=marketplaces).
 */

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
    removed: 'Убран',
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

function extractRuUrlFromPayload(payload) {
    if (!payload || !Array.isArray(payload.attributes)) return '';
    const names = [
        'ссылка на ру',
        'ссылка ру',
        'ру',
        'регистрационное удостоверение',
        'ссылка на регистрационное удостоверение',
    ];
    for (const a of payload.attributes) {
        if (!a) continue;
        const nm = String(a.name || '').trim().toLowerCase();
        if (!names.some((n) => nm === n || nm.includes(n))) continue;
        const val = a.value;
        if (val == null) continue;
        if (typeof val === 'string' && val.trim()) return val.trim();
        if (typeof val === 'object' && val.href) return String(val.href).trim();
        if (typeof val === 'object' && val.name) return String(val.name).trim();
    }
    return '';
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
                `SELECT id, channel_num FROM dg_new_products
                  WHERE channel = 'almamed' AND id IN (?)`,
                [sourceIds]
            );
            const byId = {};
            (srcs || []).forEach((s) => {
                byId[Number(s.id)] = s.channel_num != null ? Number(s.channel_num) : null;
            });
            list.forEach((r) => {
                if (r.channel !== 'marketplaces' || !r.source_almamed_id) return;
                r.source_almamed_channel_num = byId[Number(r.source_almamed_id)] || null;
            });
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
    const height =
        parseNum(r.height_box_cm) != null ? parseNum(r.height_box_cm) : parseNum(r.height_bag_cm);
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
    const vat = String(r.vat || r.vat_on_product || '').trim();
    return {
        code: String(r.code || '').trim(),
        name: String(r.name || '').trim(),
        uuid: r.uuid || '',
        article,
        barcode,
        vat,
        sale_price: salePrice,
        length_cm: parseNum(r.length_cm),
        width_cm: parseNum(r.width_cm),
        height_cm: height,
        weight_kg: parseNum(r.weight_kg),
        ru_url: extractRuUrlFromPayload(payload),
    };
}

const MS_ENRICH_SQL = `SELECT mse.code, mse.name, mse.vat, mse.vat_on_product, mse.sale_price, mse.uuid,
                med.denorm_article, med.payload_json,
                mdm.length_cm, mdm.width_cm, mdm.height_box_cm, mdm.height_bag_cm, mdm.weight_kg
           FROM ms_export mse
           LEFT JOIN ms_entity_details med ON med.uuid = mse.uuid
           LEFT JOIN ms_dimensions_measurements mdm ON mdm.code = mse.code`;

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

function buildDimensionsText(enrich) {
    if (!enrich) return '';
    return formatDimensions({
        length_cm: enrich.length_cm,
        width_cm: enrich.width_cm,
        height_cm: enrich.height_cm,
        weight_kg: enrich.weight_kg,
    });
}

async function upsertMarketsFromAlmamed(db, almamedRow, opts) {
    const options = opts || {};
    const syncFields = options.syncFields === true;
    const article = String(almamedRow.article || '').trim();
    const explicitCode = String(almamedRow.product_code || '').trim();
    // На Альмамед отдельного «Кода» нет — только артикул. Не копируем артикул в product_code.
    if (!article && !explicitCode) return { skipped: true, reason: 'no_code' };

    const lookupKey = explicitCode || article;
    const enrich = await fetchMsEnrichment(db, lookupKey);
    // Код МС: явный с Альмамед, иначе из ms_export (по коду или артикулу после появления в системе).
    let resolvedCode = explicitCode;
    if (enrich && enrich.code) {
        resolvedCode = String(enrich.code).trim() || resolvedCode;
    }

    const placeKey = resolvedCode || lookupKey;
    const place = await fetchPlacementInfo(db, placeKey);
    if (place.ozon && place.wb && place.ym) {
        return { skipped: true, reason: 'already_on_all_mp' };
    }

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
        length_cm: enrich && enrich.length_cm,
        width_cm: enrich && enrich.width_cm,
        height_cm: enrich && enrich.height_cm,
        weight_kg: enrich && enrich.weight_kg,
        dimensions_text: buildDimensionsText(enrich),
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
            const [bySrc] = await q.query(
                `SELECT * FROM dg_new_products
                  WHERE channel = 'marketplaces' AND source_almamed_id = ? AND status <> 'removed'
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
            if (!hasDimensions(existing) && (seed.length_cm != null || seed.dimensions_text)) {
                patch.dimensions_text = seed.dimensions_text;
                patch.length_cm = seed.length_cm;
                patch.width_cm = seed.width_cm;
                patch.height_cm = seed.height_cm;
                patch.weight_kg = seed.weight_kg;
            }
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
        if (!hasDimensions(existing) && (seed.length_cm != null || seed.dimensions_text)) {
            patch.dimensions_text = seed.dimensions_text;
            patch.length_cm = seed.length_cm;
            patch.width_cm = seed.width_cm;
            patch.height_cm = seed.height_cm;
            patch.weight_kg = seed.weight_kg;
        }

        const merged = { ...existing, ...patch };
        if (!MANUAL_LOCK_STATUSES.has(String(existing.status))) {
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
            return result;
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
    for (const row of markets || []) {
        const lookup = String(row.product_code || row.article || '').trim();
        if (!lookup) continue;
        const enrich = await fetchMsEnrichment(db, lookup);
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
            if (!hasDimensions(row) && enrich.length_cm != null) {
                patch.length_cm = enrich.length_cm;
                patch.width_cm = enrich.width_cm;
                patch.height_cm = enrich.height_cm;
                patch.weight_kg = enrich.weight_kg;
                patch.dimensions_text = buildDimensionsText(enrich);
            }
            if (!row.ms_product_uuid && enrich.uuid) patch.ms_product_uuid = enrich.uuid;
        }
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
        updated += 1;
    }

    return { from_almamed: fromAlmamed, updated, skipped_all_mp: skippedAll };
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
    allocChannelNum,
    backfillChannelNums,
    fetchPlacementFlags,
    fetchPlacementInfo,
    fetchMsEnrichment,
    upsertMarketsFromAlmamed,
    refreshMarketsQueue,
    removePlacedMarkets,
    dedupeMarketsBySourceAlmamed,
};
