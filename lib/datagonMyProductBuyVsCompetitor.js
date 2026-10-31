'use strict';

/**
 * Алерт: закупочная МС выше минимума ДМ/МК больше чем на threshold_pct %.
 * Снапшот в БД — пересчёт после stickers_cms / по кнопке «Обновить»; UI читает мгновенно.
 */

const { snapshotFx } = require('./datagonFxRates');
const { enrichRowsWithStickersAndMs } = require('./datagonMyProductStickers');
const { applySiteWarehouseStockBySiteId } = require('./datagonMyProductOwnStockPriceGuard');

const DEFAULT_THRESHOLD_PCT = 1;
const MAX_STORE = 2000;
const CHUNK = 120;

let tableReady = false;
let metaReady = false;

function parseBuyRub(row) {
    if (!row) return null;
    // Как наценка сайта: сначала «Закупочная цена» карточки (ms_buy_price / ms_card_buy_price).
    const card = Number(row.ms_card_buy_price);
    if (Number.isFinite(card) && card > 0) return card;
    const raw = row.ms_buy_price;
    if (raw != null && String(raw).trim() !== '') {
        const n = Number(String(raw).replace(/\s/g, '').replace(',', '.'));
        if (Number.isFinite(n) && n > 0) return n;
    }
    const costN = Number(row.ms_stock_cost);
    if (Number.isFinite(costN) && costN > 0) return costN;
    return null;
}

function hasPositiveStock(row) {
    if (!row) return false;
    const site = Number(row.stock);
    const ms = Number(row.sticker_ms_stock);
    return (Number.isFinite(site) && site > 0) || (Number.isFinite(ms) && ms > 0);
}

function toRub(price, currency, usdRate, eurRate) {
    const value = Number(price);
    if (!Number.isFinite(value)) return null;
    const cur = String(currency || 'RUB').trim().toUpperCase();
    if (cur === 'RUB' || cur === 'RUR' || cur === '₽') return value;
    if (cur === 'USD' || cur === '$') return value * usdRate;
    if (cur === 'EUR' || cur === '€') return value * eurRate;
    return value;
}

function minCompetitorRub(row, usdRate, eurRate) {
    if (!row) return null;
    const candidates = [];
    if (Number.isFinite(Number(row.dealmed_price)) && Number(row.dealmed_price) > 0) {
        const rub = toRub(row.dealmed_price, row.dealmed_currency || 'RUB', usdRate, eurRate);
        if (Number.isFinite(rub) && rub > 0) candidates.push({ source: 'dealmed', rub });
    }
    if (Number.isFinite(Number(row.medkompleks_price)) && Number(row.medkompleks_price) > 0) {
        const rub = toRub(
            row.medkompleks_price,
            row.medkompleks_currency || 'RUB',
            usdRate,
            eurRate
        );
        if (Number.isFinite(rub) && rub > 0) candidates.push({ source: 'medkompleks', rub });
    }
    if (!candidates.length) return null;
    candidates.sort((a, b) => a.rub - b.rub);
    return candidates[0];
}

function evalBuyAboveCompetitor(row, thresholdPct, usdRate, eurRate) {
    if (!hasPositiveStock(row)) return null;
    const buy = parseBuyRub(row);
    const comp = minCompetitorRub(row, usdRate, eurRate);
    if (buy == null || !comp) return null;
    const thr = Number(thresholdPct);
    const threshold = Number.isFinite(thr) && thr >= 0 ? thr : DEFAULT_THRESHOLD_PCT;
    const overPct = ((buy - comp.rub) / comp.rub) * 100;
    if (!Number.isFinite(overPct) || overPct <= threshold) return null;
    return {
        buy_rub: buy,
        competitor_rub: comp.rub,
        competitor_source: comp.source,
        over_pct: overPct,
    };
}

async function ensureBuyVsCompExtraColumns(db) {
    const [[dbRow]] = await db.query(`SELECT DATABASE() AS db`);
    const schema = dbRow && dbRow.db;
    if (!schema) return;
    const wanted = [
        ['source_url', 'VARCHAR(1024) NULL'],
        ['competitor_url', 'VARCHAR(1024) NULL'],
        ['match_id', 'BIGINT NULL'],
        ['competitor_sku', 'VARCHAR(191) NULL'],
        ['competitor_name', 'VARCHAR(512) NULL'],
        ['pack_qty', 'INT NULL'],
        ['pack_basis', 'VARCHAR(16) NULL'],
        ['competitor_price_list', 'DECIMAL(18,4) NULL'],
        ['confirmed_by', 'VARCHAR(100) NULL'],
        ['confirmed_at', 'DATETIME NULL'],
        ['ms_uuid', 'VARCHAR(64) NULL'],
        ['ms_type', 'VARCHAR(64) NULL'],
        ['ms_link_code', 'VARCHAR(191) NULL'],
    ];
    const [cols] = await db.query(
        `SELECT COLUMN_NAME AS c FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'dg_my_product_buy_vs_comp_alerts'
           AND COLUMN_NAME IN (${wanted.map(() => '?').join(',')})`,
        [schema, ...wanted.map((w) => w[0])]
    );
    const have = new Set((cols || []).map((r) => String(r.c)));
    for (const [name, ddl] of wanted) {
        if (have.has(name)) continue;
        // eslint-disable-next-line no-await-in-loop
        await db.query(`ALTER TABLE dg_my_product_buy_vs_comp_alerts ADD COLUMN ${name} ${ddl}`);
    }
}

function applyPackToCompetitorPrice(rawPrice, packQty, packBasis) {
    const raw = Number(rawPrice);
    if (!Number.isFinite(raw)) return null;
    const qty = Number(packQty);
    const basis = String(packBasis || '').toLowerCase();
    if (!Number.isFinite(qty) || qty < 2 || (basis !== 'ours' && basis !== 'competitor')) {
        return raw;
    }
    if (basis === 'ours') return Math.round(raw * qty * 10000) / 10000;
    return Math.round((raw / qty) * 10000) / 10000;
}

function normalizePackMeta(packQty, packBasis) {
    const qty = packQty != null ? Number(packQty) : null;
    const basis = String(packBasis || '').toLowerCase();
    if (!Number.isFinite(qty) || qty < 2 || (basis !== 'ours' && basis !== 'competitor')) {
        return { pack_qty: null, pack_basis: null };
    }
    return { pack_qty: qty, pack_basis: basis };
}

async function ensureBuyVsCompTables(db) {
    if (!tableReady) {
        await db.query(`
            CREATE TABLE IF NOT EXISTS dg_my_product_buy_vs_comp_alerts (
              id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
              site_id INT NOT NULL,
              product_id BIGINT NOT NULL,
              sku VARCHAR(191) NULL,
              name VARCHAR(512) NULL,
              source_url VARCHAR(1024) NULL,
              currency VARCHAR(16) NULL,
              price DECIMAL(18,4) NULL,
              stock DECIMAL(18,4) NULL,
              sticker_ms_stock DECIMAL(18,4) NULL,
              buy_rub DECIMAL(18,4) NOT NULL,
              competitor_rub DECIMAL(18,4) NOT NULL,
              competitor_source VARCHAR(32) NOT NULL,
              competitor_url VARCHAR(1024) NULL,
              match_id BIGINT NULL,
              competitor_sku VARCHAR(191) NULL,
              competitor_name VARCHAR(512) NULL,
              pack_qty INT NULL,
              pack_basis VARCHAR(16) NULL,
              competitor_price_list DECIMAL(18,4) NULL,
              confirmed_by VARCHAR(100) NULL,
              confirmed_at DATETIME NULL,
              ms_uuid VARCHAR(64) NULL,
              ms_type VARCHAR(64) NULL,
              ms_link_code VARCHAR(191) NULL,
              over_pct DECIMAL(12,4) NOT NULL,
              rebuilt_at DATETIME NOT NULL,
              UNIQUE KEY uq_bvc_site_product (site_id, product_id),
              KEY idx_bvc_site_over (site_id, over_pct),
              KEY idx_bvc_rebuilt (rebuilt_at),
              KEY idx_bvc_match (match_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        `);
        await ensureBuyVsCompExtraColumns(db);
        tableReady = true;
    }
    if (!metaReady) {
        await db.query(`
            CREATE TABLE IF NOT EXISTS dg_my_product_buy_vs_comp_meta (
              id TINYINT UNSIGNED NOT NULL PRIMARY KEY DEFAULT 1,
              threshold_pct DECIMAL(8,4) NOT NULL DEFAULT 1,
              total INT NOT NULL DEFAULT 0,
              candidates INT NOT NULL DEFAULT 0,
              scanned INT NOT NULL DEFAULT 0,
              truncated TINYINT(1) NOT NULL DEFAULT 0,
              duration_sec DECIMAL(10,2) NULL,
              rebuilt_at DATETIME NULL,
              source VARCHAR(64) NULL
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        `);
        await db.query(
            `INSERT IGNORE INTO dg_my_product_buy_vs_comp_meta (id) VALUES (1)`
        );
        metaReady = true;
    }
}

function classifyCompetitorProjectName(name) {
    const n = String(name || '').toLowerCase();
    if (n.includes('dealmed') || n.includes('деалмед')) return 'dealmed';
    if (n.includes('medkompleks') || n.includes('медкомплекс')) return 'medkompleks';
    return null;
}

/** Лёгкий attach цен ДМ/МК для пакета строк (без полного enrich роутера). */
async function attachCompetitorPricesLight(db, rows) {
    if (!Array.isArray(rows) || !rows.length) return;
    const siteIds = [...new Set(rows.map((r) => Number(r.site_id)).filter((n) => n > 0))];
    const skus = [...new Set(rows.map((r) => String(r.sku || '').trim()).filter(Boolean))];
    if (!siteIds.length || !skus.length) return;

    const [matches] = await db.query(
        `
        SELECT pm.id AS match_id, pm.my_site_id, pm.my_sku, pm.competitor_site_id,
               pm.competitor_sku, pm.competitor_name, pm.pack_qty, pm.pack_basis,
               pm.confirmed_by, pm.confirmed_at,
               p.name AS pname
        FROM product_matches pm
        JOIN projects p ON p.id = pm.competitor_site_id
        WHERE pm.status = 'confirmed'
          AND pm.my_site_id IN (${siteIds.map(() => '?').join(',')})
          AND pm.my_sku IN (${skus.map(() => '?').join(',')})
          AND (
            LOWER(p.name) LIKE '%dealmed%' OR LOWER(p.name) LIKE '%деалмед%'
            OR LOWER(p.name) LIKE '%medkompleks%' OR LOWER(p.name) LIKE '%медкомплекс%'
          )
        `,
        [...siteIds, ...skus]
    );
    if (!(matches || []).length) return;

    const byKey = new Map();
    for (const m of matches) {
        const kind = classifyCompetitorProjectName(m.pname);
        if (!kind) continue;
        const k = `${Number(m.my_site_id)}::${String(m.my_sku || '').trim()}`;
        if (!byKey.has(k)) byKey.set(k, []);
        byKey.get(k).push({ ...m, kind });
    }
    const compSites = [...new Set(matches.map((m) => Number(m.competitor_site_id)).filter((n) => n > 0))];
    const compSkus = [
        ...new Set(matches.map((m) => String(m.competitor_sku || '').trim()).filter(Boolean)),
    ];
    const priceMap = new Map();
    if (compSites.length && compSkus.length) {
        const [prs] = await db.query(
            `
            SELECT project_id, sku, price, currency, url
            FROM prices
            WHERE project_id IN (${compSites.map(() => '?').join(',')})
              AND sku IN (${compSkus.map(() => '?').join(',')})
            ORDER BY parsed_at DESC
            `,
            [...compSites, ...compSkus]
        );
        for (const pr of prs || []) {
            const key = `${pr.project_id}::${String(pr.sku || '').trim()}`;
            if (!priceMap.has(key)) priceMap.set(key, pr);
        }
    }

    for (const r of rows) {
        r.dealmed_price = null;
        r.dealmed_currency = null;
        r.dealmed_url = null;
        r.dealmed_match_id = null;
        r.dealmed_competitor_sku = null;
        r.dealmed_competitor_name = null;
        r.dealmed_pack_qty = null;
        r.dealmed_pack_basis = null;
        r.dealmed_price_list = null;
        r.dealmed_confirmed_by = null;
        r.dealmed_confirmed_at = null;
        r.medkompleks_price = null;
        r.medkompleks_currency = null;
        r.medkompleks_url = null;
        r.medkompleks_match_id = null;
        r.medkompleks_competitor_sku = null;
        r.medkompleks_competitor_name = null;
        r.medkompleks_pack_qty = null;
        r.medkompleks_pack_basis = null;
        r.medkompleks_price_list = null;
        r.medkompleks_confirmed_by = null;
        r.medkompleks_confirmed_at = null;
        const list = byKey.get(`${Number(r.site_id)}::${String(r.sku || '').trim()}`) || [];
        for (const m of list) {
            const pr = priceMap.get(
                `${m.competitor_site_id}::${String(m.competitor_sku || '').trim()}`
            );
            if (!pr || !(Number(pr.price) > 0)) continue;
            const pack = normalizePackMeta(m.pack_qty, m.pack_basis);
            const comparable = applyPackToCompetitorPrice(pr.price, pack.pack_qty, pack.pack_basis);
            if (!(Number(comparable) > 0)) continue;
            const url = pr.url ? String(pr.url).trim() : '';
            const payload = {
                price: comparable,
                currency: pr.currency || 'RUB',
                url: url || null,
                match_id: Number(m.match_id) || null,
                competitor_sku: m.competitor_sku || '',
                competitor_name: m.competitor_name || '',
                pack_qty: pack.pack_qty,
                pack_basis: pack.pack_basis,
                price_list: Number(pr.price),
                confirmed_by: m.confirmed_by ? String(m.confirmed_by) : '',
                confirmed_at: m.confirmed_at || null,
            };
            if (m.kind === 'dealmed') {
                r.dealmed_price = payload.price;
                r.dealmed_currency = payload.currency;
                r.dealmed_url = payload.url;
                r.dealmed_match_id = payload.match_id;
                r.dealmed_competitor_sku = payload.competitor_sku;
                r.dealmed_competitor_name = payload.competitor_name;
                r.dealmed_pack_qty = payload.pack_qty;
                r.dealmed_pack_basis = payload.pack_basis;
                r.dealmed_price_list = payload.price_list;
                r.dealmed_confirmed_by = payload.confirmed_by;
                r.dealmed_confirmed_at = payload.confirmed_at;
            } else if (m.kind === 'medkompleks') {
                r.medkompleks_price = payload.price;
                r.medkompleks_currency = payload.currency;
                r.medkompleks_url = payload.url;
                r.medkompleks_match_id = payload.match_id;
                r.medkompleks_competitor_sku = payload.competitor_sku;
                r.medkompleks_competitor_name = payload.competitor_name;
                r.medkompleks_pack_qty = payload.pack_qty;
                r.medkompleks_pack_basis = payload.pack_basis;
                r.medkompleks_price_list = payload.price_list;
                r.medkompleks_confirmed_by = payload.confirmed_by;
                r.medkompleks_confirmed_at = payload.confirmed_at;
            }
        }
    }
}

/**
 * Полный пересчёт снапшота. Вызывать после stickers_cms или по кнопке «Обновить».
 * @param {import('mysql2/promise').Pool} db
 * @param {{ siteId?: number|string|null, thresholdPct?: number, source?: string, onProgress?: function }} [opts]
 */
async function rebuildBuyVsCompetitorAlerts(db, opts) {
    const t0 = Date.now();
    await ensureBuyVsCompTables(db);
    const o = opts || {};
    const onProgress = typeof o.onProgress === 'function' ? o.onProgress : () => {};
    const thrRaw = Number(o.thresholdPct);
    const thresholdPct =
        Number.isFinite(thrRaw) && thrRaw >= 0 ? thrRaw : DEFAULT_THRESHOLD_PCT;
    const siteRaw = o.siteId;
    let siteIds = null;
    if (Array.isArray(siteRaw)) {
        siteIds = siteRaw.map(Number).filter((n) => n > 0);
    } else if (siteRaw != null && String(siteRaw).trim() !== '' && String(siteRaw) !== 'all') {
        const n = Number(siteRaw);
        if (Number.isFinite(n) && n > 0) siteIds = [n];
    }

    const fx = snapshotFx();
    const usdRate = Math.max(0.0001, Number(fx.usd_to_rub || 90));
    const eurRate = Math.max(0.0001, Number(fx.eur_to_rub || 100));

    const params = [];
    let siteSql = '';
    if (siteIds && siteIds.length === 1) {
        siteSql = ' AND mp.site_id = ?';
        params.push(siteIds[0]);
    } else if (siteIds && siteIds.length > 1) {
        siteSql = ` AND mp.site_id IN (${siteIds.map(() => '?').join(',')})`;
        params.push(...siteIds);
    }

    onProgress('buy-vs-comp: отбор кандидатов…');
    const [idRows] = await db.query(
        `
        SELECT DISTINCT mp.id
        FROM my_products mp
        INNER JOIN product_matches pm
          ON pm.my_site_id = mp.site_id
         AND pm.status = 'confirmed'
         AND pm.my_sku IS NOT NULL AND TRIM(pm.my_sku) <> '' AND pm.my_sku = mp.sku
        INNER JOIN projects p ON p.id = pm.competitor_site_id
        WHERE mp.is_active = 1
          AND COALESCE(mp.source_enabled, 1) = 1
          AND COALESCE(mp.stock, 0) > 0
          ${siteSql}
          AND (
            LOWER(p.name) LIKE '%dealmed%' OR LOWER(p.name) LIKE '%деалмед%'
            OR LOWER(p.name) LIKE '%medkompleks%' OR LOWER(p.name) LIKE '%медкомплекс%'
          )
        ORDER BY mp.id DESC
        LIMIT ${MAX_STORE}
        `,
        params
    );
    const allIds = (idRows || [])
        .map((r) => Number(r.id))
        .filter((n) => Number.isFinite(n) && n > 0);
    const truncated = allIds.length >= MAX_STORE;

    const items = [];
    let scanned = 0;
    for (let i = 0; i < allIds.length; i += CHUNK) {
        const slice = allIds.slice(i, i + CHUNK);
        // eslint-disable-next-line no-await-in-loop
        const [batch] = await db.query(
            `SELECT mp.* FROM my_products mp WHERE mp.id IN (${slice.map(() => '?').join(',')})`,
            slice
        );
        const rows = Array.isArray(batch) ? batch : [];
        scanned += rows.length;
        onProgress(`buy-vs-comp: пакет ${Math.floor(i / CHUNK) + 1} (${scanned}/${allIds.length})…`);
        // eslint-disable-next-line no-await-in-loop
        await Promise.all([
            attachCompetitorPricesLight(db, rows),
            enrichRowsWithStickersAndMs(db, rows),
        ]);
        // eslint-disable-next-line no-await-in-loop
        await applySiteWarehouseStockBySiteId(db, rows);

        for (const row of rows) {
            const hit = evalBuyAboveCompetitor(row, thresholdPct, usdRate, eurRate);
            if (!hit) continue;
            const isDm = hit.competitor_source === 'dealmed';
            const isMk = hit.competitor_source === 'medkompleks';
            const compUrl = isDm ? row.dealmed_url : isMk ? row.medkompleks_url : null;
            items.push({
                site_id: Number(row.site_id),
                product_id: Number(row.id),
                sku: row.sku || '',
                name: row.name || '',
                source_url: row.source_url ? String(row.source_url).trim() : '',
                currency: row.currency || 'RUB',
                price: row.price != null ? Number(row.price) : null,
                stock: Number(row.stock) || 0,
                sticker_ms_stock:
                    row.sticker_ms_stock != null ? Number(row.sticker_ms_stock) : null,
                buy_rub: Number(hit.buy_rub.toFixed(2)),
                competitor_rub: Number(hit.competitor_rub.toFixed(2)),
                competitor_source: hit.competitor_source,
                competitor_url: compUrl ? String(compUrl).trim() : '',
                match_id: isDm
                    ? row.dealmed_match_id
                    : isMk
                      ? row.medkompleks_match_id
                      : null,
                competitor_sku: isDm
                    ? row.dealmed_competitor_sku || ''
                    : isMk
                      ? row.medkompleks_competitor_sku || ''
                      : '',
                competitor_name: isDm
                    ? row.dealmed_competitor_name || ''
                    : isMk
                      ? row.medkompleks_competitor_name || ''
                      : '',
                pack_qty: isDm
                    ? row.dealmed_pack_qty
                    : isMk
                      ? row.medkompleks_pack_qty
                      : null,
                pack_basis: isDm
                    ? row.dealmed_pack_basis
                    : isMk
                      ? row.medkompleks_pack_basis
                      : null,
                competitor_price_list: isDm
                    ? row.dealmed_price_list
                    : isMk
                      ? row.medkompleks_price_list
                      : null,
                confirmed_by: isDm
                    ? row.dealmed_confirmed_by || ''
                    : isMk
                      ? row.medkompleks_confirmed_by || ''
                      : '',
                confirmed_at: isDm
                    ? row.dealmed_confirmed_at || null
                    : isMk
                      ? row.medkompleks_confirmed_at || null
                      : null,
                ms_uuid: row.ms_uuid ? String(row.ms_uuid).trim() : '',
                ms_type: row.ms_type ? String(row.ms_type).trim() : '',
                ms_link_code: row.ms_link_code ? String(row.ms_link_code).trim() : '',
                over_pct: Number(hit.over_pct.toFixed(2)),
            });
        }
    }

    items.sort((a, b) => Number(b.over_pct) - Number(a.over_pct));
    const rebuiltAt = new Date();
    const mysqlNow = rebuiltAt.toISOString().slice(0, 19).replace('T', ' ');

    // Полная замена снапшота (глобальный список; фильтр сайта — при чтении).
    if (!siteIds || !siteIds.length) {
        await db.query(`DELETE FROM dg_my_product_buy_vs_comp_alerts`);
    } else {
        await db.query(
            `DELETE FROM dg_my_product_buy_vs_comp_alerts WHERE site_id IN (${siteIds
                .map(() => '?')
                .join(',')})`,
            siteIds
        );
    }

    for (let i = 0; i < items.length; i += 200) {
        const slice = items.slice(i, i + 200);
        const ph = slice.map(() => '(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').join(',');
        const args = [];
        for (const it of slice) {
            let confirmedAt = null;
            if (it.confirmed_at) {
                const d = new Date(it.confirmed_at);
                if (!Number.isNaN(d.getTime())) {
                    confirmedAt = d.toISOString().slice(0, 19).replace('T', ' ');
                }
            }
            args.push(
                it.site_id,
                it.product_id,
                it.sku,
                it.name,
                it.source_url || null,
                it.currency,
                it.price,
                it.stock,
                it.sticker_ms_stock,
                it.buy_rub,
                it.competitor_rub,
                it.competitor_source,
                it.competitor_url || null,
                it.match_id || null,
                it.competitor_sku || null,
                it.competitor_name || null,
                it.pack_qty || null,
                it.pack_basis || null,
                it.competitor_price_list != null ? it.competitor_price_list : null,
                it.confirmed_by || null,
                confirmedAt,
                it.ms_uuid || null,
                it.ms_type || null,
                it.ms_link_code || null,
                it.over_pct,
                mysqlNow
            );
        }
        // eslint-disable-next-line no-await-in-loop
        await db.query(
            `INSERT INTO dg_my_product_buy_vs_comp_alerts
              (site_id, product_id, sku, name, source_url, currency, price, stock, sticker_ms_stock,
               buy_rub, competitor_rub, competitor_source, competitor_url,
               match_id, competitor_sku, competitor_name, pack_qty, pack_basis, competitor_price_list,
               confirmed_by, confirmed_at, ms_uuid, ms_type, ms_link_code, over_pct, rebuilt_at)
             VALUES ${ph}
             ON DUPLICATE KEY UPDATE
               sku=VALUES(sku), name=VALUES(name), source_url=VALUES(source_url),
               currency=VALUES(currency), price=VALUES(price),
               stock=VALUES(stock), sticker_ms_stock=VALUES(sticker_ms_stock),
               buy_rub=VALUES(buy_rub), competitor_rub=VALUES(competitor_rub),
               competitor_source=VALUES(competitor_source), competitor_url=VALUES(competitor_url),
               match_id=VALUES(match_id), competitor_sku=VALUES(competitor_sku),
               competitor_name=VALUES(competitor_name), pack_qty=VALUES(pack_qty),
               pack_basis=VALUES(pack_basis), competitor_price_list=VALUES(competitor_price_list),
               confirmed_by=VALUES(confirmed_by), confirmed_at=VALUES(confirmed_at),
               ms_uuid=VALUES(ms_uuid), ms_type=VALUES(ms_type), ms_link_code=VALUES(ms_link_code),
               over_pct=VALUES(over_pct), rebuilt_at=VALUES(rebuilt_at)`,
            args
        );
    }

    const [[cntRow]] = await db.query(
        `SELECT COUNT(*) AS n FROM dg_my_product_buy_vs_comp_alerts`
    );
    const totalStored = Number(cntRow && cntRow.n) || items.length;
    const durationSec = Number(((Date.now() - t0) / 1000).toFixed(2));
    const source = String(o.source || 'manual').slice(0, 64);

    await db.query(
        `UPDATE dg_my_product_buy_vs_comp_meta
         SET threshold_pct=?, total=?, candidates=?, scanned=?, truncated=?,
             duration_sec=?, rebuilt_at=?, source=?
         WHERE id=1`,
        [
            thresholdPct,
            totalStored,
            allIds.length,
            scanned,
            truncated ? 1 : 0,
            durationSec,
            mysqlNow,
            source,
        ]
    );

    return {
        success: true,
        threshold_pct: thresholdPct,
        total: totalStored,
        candidates: allIds.length,
        scanned,
        truncated,
        duration_sec: durationSec,
        rebuilt_at: mysqlNow,
        source,
    };
}

/**
 * Быстрое чтение снапшота для UI.
 */
async function listBuyVsCompetitorAlerts(db, opts) {
    await ensureBuyVsCompTables(db);
    const o = opts || {};
    const limitRaw = Number(o.limit);
    const limit = Number.isFinite(limitRaw)
        ? Math.max(1, Math.min(500, Math.floor(limitRaw)))
        : 200;
    const siteRaw = o.siteId;
    const siteId =
        siteRaw != null && String(siteRaw).trim() !== '' && String(siteRaw) !== 'all'
            ? Number(siteRaw)
            : null;

    const [[meta]] = await db.query(`SELECT * FROM dg_my_product_buy_vs_comp_meta WHERE id=1`);
    const params = [];
    let where = 'WHERE 1=1';
    if (Number.isFinite(siteId) && siteId > 0) {
        where += ' AND site_id = ?';
        params.push(siteId);
    }
    const [[cnt]] = await db.query(
        `SELECT COUNT(*) AS n FROM dg_my_product_buy_vs_comp_alerts ${where}`,
        params
    );
    const [rows] = await db.query(
        `SELECT site_id, product_id AS id, sku, name, source_url, currency, price, stock, sticker_ms_stock,
                buy_rub, competitor_rub, competitor_source, competitor_url,
                match_id, competitor_sku, competitor_name, pack_qty, pack_basis, competitor_price_list,
                confirmed_by, confirmed_at, ms_uuid, ms_type, ms_link_code, over_pct, rebuilt_at
         FROM dg_my_product_buy_vs_comp_alerts
         ${where}
         ORDER BY over_pct DESC
         LIMIT ?`,
        [...params, limit]
    );

    return {
        success: true,
        from_snapshot: true,
        threshold_pct: Number((meta && meta.threshold_pct) || DEFAULT_THRESHOLD_PCT),
        total: Number((cnt && cnt.n) || 0),
        candidates: Number((meta && meta.candidates) || 0),
        scanned: Number((meta && meta.scanned) || 0),
        truncated: !!(meta && meta.truncated),
        duration_sec: meta && meta.duration_sec != null ? Number(meta.duration_sec) : null,
        rebuilt_at: meta && meta.rebuilt_at ? meta.rebuilt_at : null,
        source: (meta && meta.source) || null,
        limit,
        site_id: Number.isFinite(siteId) && siteId > 0 ? siteId : 'all',
        items: (rows || []).map((r) => ({
            id: Number(r.id),
            site_id: Number(r.site_id),
            sku: r.sku || '',
            name: r.name || '',
            source_url: r.source_url || '',
            currency: r.currency || 'RUB',
            price: r.price != null ? Number(r.price) : null,
            stock: Number(r.stock) || 0,
            sticker_ms_stock: r.sticker_ms_stock != null ? Number(r.sticker_ms_stock) : null,
            buy_rub: Number(r.buy_rub),
            competitor_rub: Number(r.competitor_rub),
            competitor_source: r.competitor_source,
            competitor_url: r.competitor_url || '',
            match_id: r.match_id != null ? Number(r.match_id) : null,
            competitor_sku: r.competitor_sku || '',
            competitor_name: r.competitor_name || '',
            pack_qty: r.pack_qty != null ? Number(r.pack_qty) : null,
            pack_basis: r.pack_basis || null,
            competitor_price_list:
                r.competitor_price_list != null ? Number(r.competitor_price_list) : null,
            confirmed_by: r.confirmed_by || '',
            confirmed_at: r.confirmed_at || null,
            ms_uuid: r.ms_uuid || '',
            ms_type: r.ms_type || '',
            ms_link_code: r.ms_link_code || '',
            over_pct: Number(r.over_pct),
        })),
    };
}

module.exports = {
    DEFAULT_THRESHOLD_PCT,
    parseBuyRub,
    hasPositiveStock,
    minCompetitorRub,
    evalBuyAboveCompetitor,
    toRub,
    ensureBuyVsCompTables,
    rebuildBuyVsCompetitorAlerts,
    listBuyVsCompetitorAlerts,
};
