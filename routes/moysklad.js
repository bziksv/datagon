const express = require('express');
const axios = require('axios');

const router = express.Router();

const BASE_URL = 'https://api.moysklad.ru/api/remap/1.2';
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
let sourceLinksCacheReady = false;
let sourceLinksCacheLastBuiltAt = 0;
let sourceLinksCacheBuildPromise = null;
const SOURCE_LINKS_CACHE_TTL_MS = 2 * 60 * 1000;
const msStatsCache = new Map();
const MS_STATS_CACHE_TTL_MS = 2 * 60 * 1000;
let msArchivedColumnReady = false;

function addLog(msg) {
    const stamp = new Date().toLocaleTimeString('ru-RU');
    jobState.logs.unshift(`[${stamp}] ${msg}`);
    jobState.logs = jobState.logs.slice(0, 30);
    jobState.updatedAt = new Date().toISOString();
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
        buy_price_max
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
    const directCode = normalizeCode(assortment.code);
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
    await ensureMsArchivedColumn(db);
    const token = getToken(config);
    if (!token) throw new Error('MS_TOKEN не задан (env MS_TOKEN или config.msToken)');
    const headers = { Authorization: `Bearer ${token}` };

    jobState.active = true;
    jobState.done = false;
    jobState.cancelRequested = false;
    jobState.processed = 0;
    jobState.total = 0;
    jobState.message = 'Загрузка метаданных МойСклад...';
    jobState.logs = [];
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
        expand: 'supplier',
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
    const bundles = await fetchAllWithArchivedStatuses(`${BASE_URL}/entity/bundle`, headers, {
        expand: 'supplier,components,components.assortment',
        pageLimit: settings.ms_sync_page_limit,
        delayMs: settings.ms_sync_delay_ms,
        onPhaseProgress: ({ phase, loaded, total }) => {
            const phaseLabel = phase === 'archived' ? 'архивные' : 'активные';
            jobState.message = total > 0
                ? `Загрузка комплектов (${phaseLabel}): ${loaded}/${total}`
                : `Загрузка комплектов (${phaseLabel}): ${loaded}`;
        }
    });
    jobState.message = `Загрузка комплектов: ${bundles.length}`;
    addLog(`Загружено товаров: ${products.length}, комплектов: ${bundles.length}`);

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
        stockMap.set(code, { stock, stockDays, salePrice });
    }
    addLog(`Остатков загружено: ${stockMap.size}`);

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
            const components = bundleComponents.get(code);
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

        const vat = item.vat === 0 || item.vat === '0' ? 'без НДС' : String(item.vat || '').replace('%', '');
        const vatOnProductRaw = getAttrValue(item, attrsMap, 'НДС на товаре или комплекте');
        const vatOnProduct = vatOnProductRaw === 0 || vatOnProductRaw === '0' ? 'без НДС' : String(vatOnProductRaw || '');

        exportRows.push([
            code,
            item.name || '',
            String(getAttrValue(item, attrsMap, 'Менеджер поддерживающий товар') || ''),
            String(getAttrValue(item, attrsMap, 'Ответственный контент-менджер') || ''),
            item.meta?.href?.split('/').pop() || '',
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
            stock,
            String(stockDays),
            toBinaryFlag(item.archived),
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
        ensureNotCancelled();
        await db.query(`
            INSERT INTO ms_export (
                code, name, manager, content_manager, uuid, type, stock_position, no_longer_cooperation,
                price_comment, vat, vat_on_product, supplier, supplier2, automation_price,
                packing_standard, packing_own_box, packing_weight, sale_price, buy_price, stock, stock_days, is_archived, updated_label
            ) VALUES ?
        `, [exportRows]);
    }

    jobState.active = false;
    jobState.done = true;
    jobState.cancelRequested = false;
    jobState.message = `Готово. Записей: ${exportRows.length}`;
    addLog(jobState.message);
}

function createMoyskladRouter(db, settings, config) {
    ensureMsArchivedColumn(db).catch(() => {});
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
                buy_price_max
            } = req.query;

            const stockPosition = String(stock_position).toLowerCase();
            const baseWhereSql = ' WHERE 1=1';
            const baseParams = [];
            const withJoinBase = ' WHERE 1=1';
            const withJoinParams = [];
            let goodsWhereSql = ' WHERE type = ?';
            const goodsWhereParams = ['Товар'];
            // For stock/value metrics, exclude poster products by any word form ("плакат", "плакаты", etc.).
            goodsWhereSql += ' AND LOWER(name) NOT LIKE ?';
            goodsWhereParams.push('%плакат%');
            const baseFilter = buildExportFilters({
                search, type, archived, supplier, supplier2, manager, content_manager, vat, vat_on_product, uuid,
                packing_standard, packing_own_box, packing_weight, updated_label, stock_position: stockPosition,
                on_site: 'all', only_stock, no_coop, has_buy_price, has_price_comment, has_automation,
                stock_min, stock_max, stock_days_min, stock_days_max, buy_price_min, buy_price_max
            }, baseWhereSql, baseParams);
            let whereSql = baseFilter.sql;
            const whereParams = baseFilter.params;

            const withJoinFilter = buildExportFilters({
                search, type, archived, supplier, supplier2, manager, content_manager, vat, vat_on_product, uuid,
                packing_standard, packing_own_box, packing_weight, updated_label, stock_position: stockPosition,
                on_site, only_stock, no_coop, has_buy_price, has_price_comment, has_automation,
                stock_min, stock_max, stock_days_min, stock_days_max, buy_price_min, buy_price_max
            }, withJoinBase, withJoinParams);

            // Goods metrics are calculated only for products, but with all active filters.
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
                buy_price_max: buy_price_max ?? null
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
            const [[inventoryValue]] = await db.query(`
                SELECT COALESCE(SUM(
                    CASE
                        WHEN buy_price IS NULL OR buy_price = '' THEN 0
                        ELSE stock * COALESCE(
                            CAST(
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
                            ),
                            0
                        )
                    END
                ), 0) AS inventory_value
                FROM ms_export${goodsWhereSql}
            `, goodsWhereParams);
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
                inventory_value: Number(inventoryValue?.inventory_value || 0)
            };
            msStatsCache.set(statsCacheKey, { ts: Date.now(), data: response });
            return res.json(response);
        } catch (e) {
            return res.status(500).json({ error: e.message });
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
                limit = 100,
                offset = 0,
                sort_by = 'code',
                sort_dir = 'asc'
            } = req.query;
            const l = Math.max(1, Math.min(parseInt(limit, 10) || 100, 500));
            const o = Math.max(0, parseInt(offset, 10) || 0);
            const allowedSortFields = new Set([
                'code', 'name', 'manager', 'content_manager', 'type',
                'stock_position', 'no_longer_cooperation', 'stock', 'stock_days',
                'price_comment', 'vat', 'vat_on_product', 'buy_price', 'sale_price',
                'supplier', 'supplier2', 'automation_price',
                'packing_standard', 'packing_own_box', 'packing_weight', 'updated_label'
                , 'uuid', 'is_archived'
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
                stock_min, stock_max, stock_days_min, stock_days_max, buy_price_min, buy_price_max
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

module.exports = createMoyskladRouter;
