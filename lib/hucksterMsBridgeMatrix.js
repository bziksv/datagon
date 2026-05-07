'use strict';

const { formatMatrixUpdatedCell } = require('./hucksterBuildMatrix');

const SYNC_HDR = 'Актуально на';

/** Товары из ms_export: складская позиция «Да»; «перестали сотрудничать» — скрываем, кроме случая с остатком > 0. */
async function fetchMsExportBridgeCandidates(db) {
    if (!db || typeof db.query !== 'function') return [];
    try {
        const [rows] = await db.query(
            `SELECT code, name, manager, COALESCE(stock, 0) AS stock
             FROM ms_export
             WHERE LOWER(TRIM(COALESCE(stock_position, ''))) IN ('да', 'yes', '1', 'true')
               AND (
                    LOWER(TRIM(COALESCE(no_longer_cooperation, ''))) NOT IN ('да', 'yes', '1', 'true')
                 OR COALESCE(stock, 0) > 0
               )
             ORDER BY code`
        );
        const out = [];
        for (const r of rows || []) {
            const code = String(r.code != null ? r.code : '').trim();
            if (!code) continue;
            out.push({
                code,
                name: String(r.name != null ? r.name : ''),
                manager: String(r.manager != null ? r.manager : ''),
                stock: Number(r.stock) || 0,
            });
        }
        return out;
    } catch (e) {
        console.warn('[huckster] ms_export bridge query:', e && e.message ? e.message : e);
        return [];
    }
}

function groupShopsByMarketplace(shops) {
    const by = { ozon: [], wildberries: [], yandex: [] };
    for (const s of shops || []) {
        const m = String(s.marketplace || '').toLowerCase();
        if (by[m]) by[m].push(s);
    }
    return by;
}

function findProductInShop(shopId, code, shopItemsByShopId) {
    const list = shopItemsByShopId[shopId] || [];
    const c = String(code || '').trim();
    for (const p of list) {
        if (String(p.uid || '').trim() === c) return p;
    }
    return null;
}

/**
 * Один маркетплейс (несколько кабинетов в конфиге): ровно один включённый repricer по коду — зелёный статус;
 * ноль или больше одного — красный статус «выключен/не определён».
 */
function resolveCabinetForMarketplace(shopsInMp, code, shopItemsByShopId) {
    const enabled = [];
    const found = [];
    for (const sh of shopsInMp || []) {
        const rec = findProductInShop(sh.id, code, shopItemsByShopId);
        if (rec) found.push({ shop: sh, rec });
        if (rec && rec.repricerEnabled === true) {
            enabled.push({ shop: sh, rec });
        }
    }
    if (enabled.length === 1) {
        return { state: 'ok', displayName: String(enabled[0].shop.name || '').trim(), rec: enabled[0].rec };
    }
    if (found.length === 1) {
        return { state: 'off', displayName: String(found[0].shop.name || '').trim(), rec: found[0].rec };
    }
    return { state: 'bad', displayName: '', rec: null };
}

function repricerStatusCell(resolved) {
    return resolved && resolved.state === 'ok' ? 'Репрайсер ВКЛЮЧЕН' : 'Репрайсер ВЫКЛЮЧЕН';
}

function modelCellFromRec(rec) {
    if (!rec) return '';
    const t = String(rec.unitModelNames || '').trim();
    return t || '—';
}

function modelCellFromResolved(resolved) {
    const rec = resolved && resolved.rec ? resolved.rec : null;
    if (!rec) return 'Модель не назначена';
    const names = String(rec.unitModelNames || '').trim();
    if (resolved.state !== 'ok') {
        if (names) return 'Модель назначена, но Репрайсер на модели выключен';
        return 'Модель не назначена';
    }
    return names || 'Модель не назначена';
}

/**
 * Матрица набора 1: строки из Мой склад (код = UID в Huckster), колонки Ozon/WB/ЯМ + модели Unit.
 * @param {Array<{ id: string, name: string, marketplace: string, shop_id: string }>} shopsSet1
 * @param {Record<string, Array<{ uid: string, repricerEnabled?: boolean, unitModelNames?: string }>>} shopItemsByShopId
 * @param {Array<{ code: string, name: string, stock: number }>} msRows
 */
function buildMsHucksterBridgeExport(shopsSet1, shopItemsByShopId, msRows, syncedAtIso) {
    const byMp = groupShopsByMarketplace(shopsSet1);
    const header = [
        'ID / КОД',
        'Наименование товара',
        'Менеджер',
        'Остаток',
        'Ozon',
        'Модель Ozon',
        'WB',
        'Модель WB',
        'ЯМ',
        'Модель ЯМ',
        SYNC_HDR,
    ];
    const syncIso = syncedAtIso && String(syncedAtIso).trim() ? String(syncedAtIso).trim() : '';
    const syncCell = syncIso ? formatMatrixUpdatedCell(syncIso) : '';
    const rows = [header];
    /** Параллельно rows: i=0 null, i>=1 мета для строки данных */
    const bridge_row_meta = [null];

    for (const ms of msRows || []) {
        const code = String(ms.code || '').trim();
        const ro = resolveCabinetForMarketplace(byMp.ozon, code, shopItemsByShopId);
        const rw = resolveCabinetForMarketplace(byMp.wildberries, code, shopItemsByShopId);
        const ry = resolveCabinetForMarketplace(byMp.yandex, code, shopItemsByShopId);

        const row = [
            code,
            String(ms.name || ''),
            String(ms.manager || ''),
            String(ms.stock != null ? ms.stock : ''),
            repricerStatusCell(ro),
            modelCellFromResolved(ro),
            repricerStatusCell(rw),
            modelCellFromResolved(rw),
            repricerStatusCell(ry),
            modelCellFromResolved(ry),
            syncCell,
        ];
        rows.push(row);
        bridge_row_meta.push({
            cabinets: {
                ozon: ro.state,
                wildberries: rw.state,
                yandex: ry.state,
            },
            models: {
                ozon: modelCellFromRec(ro.rec),
                wildberries: modelCellFromRec(rw.rec),
                yandex: modelCellFromRec(ry.rec),
            },
        });
    }

    const n = msRows ? msRows.length : 0;
    return {
        rows,
        total_rows: n,
        total_uids: n,
        bridge_row_meta,
        unit_gap_shop_indexes_by_uid: {},
        matrix_kind: 'ms_bridge_v1',
    };
}

module.exports = {
    fetchMsExportBridgeCandidates,
    buildMsHucksterBridgeExport,
    SYNC_HDR,
};
