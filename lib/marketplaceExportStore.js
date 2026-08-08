'use strict';

let storeTableReady = false;

async function ensureMarketplaceStoreTable(db) {
    if (storeTableReady) return;
    await db.query(`
        CREATE TABLE IF NOT EXISTS marketplace_export_rows (
            id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
            marketplace VARCHAR(32) NOT NULL,
            external_id VARCHAR(191) NOT NULL,
            offer_id VARCHAR(191) NOT NULL DEFAULT '',
            vendor_code VARCHAR(191) NOT NULL DEFAULT '',
            shop_sku VARCHAR(191) NOT NULL DEFAULT '',
            name TEXT NULL,
            price VARCHAR(128) NOT NULL DEFAULT '',
            vat VARCHAR(128) NOT NULL DEFAULT '',
            status VARCHAR(255) NOT NULL DEFAULT '',
            block_reason TEXT NULL,
            stock VARCHAR(64) NOT NULL DEFAULT '',
            length_cm VARCHAR(64) NOT NULL DEFAULT '',
            width_cm VARCHAR(64) NOT NULL DEFAULT '',
            height_cm VARCHAR(64) NOT NULL DEFAULT '',
            weight_kg VARCHAR(64) NOT NULL DEFAULT '',
            cabinet_url TEXT NULL,
            buyer_url TEXT NULL,
            updated_label VARCHAR(64) NOT NULL DEFAULT '',
            row_json LONGTEXT NULL,
            captured_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            PRIMARY KEY (id),
            UNIQUE KEY uq_marketplace_external (marketplace, external_id),
            KEY ix_marketplace_updated (marketplace, updated_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    storeTableReady = true;
}

function toStr(v) {
    if (v === undefined || v === null) return '';
    return String(v);
}

function marketplaceName(kind) {
    if (kind === 'ozon') return 'ozon';
    if (kind === 'wb') return 'wildberries';
    if (kind === 'ym') return 'yandex_market';
    return String(kind || 'unknown');
}

function externalIdFor(kind, row) {
    if (kind === 'ozon') return toStr(row.offer_id).trim();
    if (kind === 'wb') return toStr(row.vendor_code).trim();
    if (kind === 'ym') return toStr(row.shop_sku).trim();
    return '';
}

/**
 * Сохраняет строки маркетплейса в `marketplace_export_rows` чанками через мульти-VALUES
 * INSERT … ON DUPLICATE KEY UPDATE — это даёт ускорение в десятки раз против N+1 INSERT'ов
 * на удалённой MySQL (6859 строк = 1 запрос вместо 6859, либо ~35 при чанке 200).
 *
 * @param {object}        db
 * @param {string}        kind          - 'ozon' | 'wb' | 'ym'
 * @param {Array<object>} rows
 * @param {string}        updatedLabel  - метка времени строки (RU-формат)
 * @param {object}        [options]
 * @param {number}        [options.chunkSize=200]
 * @param {Function}      [options.onProgress] - вызывается после каждого чанка: ({ saved, total })
 * @returns {Promise<number>}                  - сколько строк фактически записано
 */
async function persistMarketplaceRows(db, kind, rows, updatedLabel, options) {
    if (!db || typeof db.query !== 'function' || !Array.isArray(rows) || rows.length === 0) return 0;
    await ensureMarketplaceStoreTable(db);
    const marketplace = marketplaceName(kind);
    const chunkSize = Math.max(1, Number((options && options.chunkSize) || 200));
    const onProgress = options && typeof options.onProgress === 'function' ? options.onProgress : null;

    const buffered = [];
    for (const row of rows) {
        const externalId = externalIdFor(kind, row);
        if (!externalId) continue;
        buffered.push([
            marketplace,
            externalId,
            toStr(row.offer_id).trim(),
            toStr(row.vendor_code).trim(),
            toStr(row.shop_sku).trim(),
            toStr(row.name || row.title),
            toStr(row.price),
            toStr(row.vat),
            toStr(row.status),
            toStr(row.block_reason),
            toStr(row.stock ?? row.stock_fit),
            toStr(row.length_cm ?? row.length),
            toStr(row.width_cm ?? row.width),
            toStr(row.height_cm ?? row.height),
            toStr(row.weight_kg ?? row.weight),
            toStr(row.cabinet_url),
            toStr(row.buyer_url),
            toStr(updatedLabel),
            JSON.stringify(row || {}),
        ]);
    }
    const total = buffered.length;
    if (total === 0) return 0;

    const cols =
        '(marketplace, external_id, offer_id, vendor_code, shop_sku, name, price, vat, status, ' +
        'block_reason, stock, length_cm, width_cm, height_cm, weight_kg, cabinet_url, buyer_url, ' +
        'updated_label, row_json, captured_at)';
    const onDup = `ON DUPLICATE KEY UPDATE
        offer_id = VALUES(offer_id),
        vendor_code = VALUES(vendor_code),
        shop_sku = VALUES(shop_sku),
        name = VALUES(name),
        price = VALUES(price),
        vat = VALUES(vat),
        status = VALUES(status),
        block_reason = VALUES(block_reason),
        stock = VALUES(stock),
        length_cm = VALUES(length_cm),
        width_cm = VALUES(width_cm),
        height_cm = VALUES(height_cm),
        weight_kg = VALUES(weight_kg),
        cabinet_url = VALUES(cabinet_url),
        buyer_url = VALUES(buyer_url),
        updated_label = VALUES(updated_label),
        row_json = VALUES(row_json)`;
        // captured_at не трогаем на UPDATE — это дата первого появления в нашей выгрузке МП.
    const placeholderRow = '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())';

    let saved = 0;
    for (let i = 0; i < total; i += chunkSize) {
        const chunk = buffered.slice(i, i + chunkSize);
        const placeholders = new Array(chunk.length).fill(placeholderRow).join(', ');
        const flatParams = chunk.flat();
        // eslint-disable-next-line no-await-in-loop
        await db.query(
            `INSERT INTO marketplace_export_rows ${cols} VALUES ${placeholders} ${onDup}`,
            flatParams,
        );
        saved += chunk.length;
        if (onProgress) {
            try {
                onProgress({ saved, total });
            } catch (_) {}
        }
    }

    // Убрать «хвосты» прошлого снапшота (иначе в таблице остаются строки со старой
    // меткой — как у Я.Маркет: часть с 21.05, часть с новой датой).
    const label = toStr(updatedLabel).trim();
    if (label) {
        await db.query(
            'DELETE FROM marketplace_export_rows WHERE marketplace = ? AND updated_label <> ?',
            [marketplace, label],
        );
    }

    return saved;
}

function normalizedKind(kind) {
    const k = String(kind || '').trim().toLowerCase();
    if (k === 'wildberries' || k === 'wb') return 'wb';
    if (k === 'yandex' || k === 'yandex-market' || k === 'yandex_market' || k === 'ym') return 'ym';
    return 'ozon';
}

async function loadMarketplaceSnapshotRows(db, kind, maxItems) {
    if (!db || typeof db.query !== 'function') return [];
    await ensureMarketplaceStoreTable(db);
    const nk = normalizedKind(kind);
    const marketplace = marketplaceName(nk);
    // По умолчанию отдаём весь снапшот (до 25k). Раньше было 300 — из-за этого WB/большие кабинеты
    // выглядели «пустыми» на странице маркетплейса при наличии данных в БД.
    const limit = Math.max(1, Math.min(parseInt(maxItems, 10) || 25000, 25000));
    const [rows] = await db.query(
        `SELECT
            offer_id, vendor_code, shop_sku, name, price, vat, status, block_reason,
            stock, length_cm, width_cm, height_cm, weight_kg, cabinet_url, buyer_url,
            updated_label, row_json, updated_at
         FROM marketplace_export_rows
         WHERE marketplace = ?
         ORDER BY updated_at DESC
         LIMIT ?`,
        [marketplace, limit]
    );
    return Array.isArray(rows) ? rows : [];
}

module.exports = {
    ensureMarketplaceStoreTable,
    persistMarketplaceRows,
    loadMarketplaceSnapshotRows,
};
