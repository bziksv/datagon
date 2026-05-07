'use strict';

/** Локальное время для ячеек «Обновлено» / «Актуально на» в матрице экспорта. */
function formatMatrixUpdatedCell(isoOrText) {
    if (!isoOrText) return '';
    const d = new Date(String(isoOrText));
    if (Number.isNaN(d.getTime())) return String(isoOrText);
    return d.toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', dateStyle: 'short', timeStyle: 'short' });
}

/** Первая колонка: максимум updatedAt по позициям repricer, не время синка Datagon. */
const HUCKSTER_MATRIX_UPDATED_COL = 'Обновлено (repricer)';
/** Последняя колонка: время успешного синка в Datagon (когда снимок собран). */
const HUCKSTER_MATRIX_SYNC_COL = 'Актуально на';

/**
 * Матрица UID × кабинеты. Строка появляется, если UID есть хотя бы в одном кабинете;
 * пустая пара UID+наименование в блоке кабинета — если в ответе repricer этого кабинета позиции нет.
 *
 * @param {Array<{ id: string, name: string }>} shops
 * @param {Record<string, Array<{ uid: string, name?: string, updatedAt?: string, repricerEnabled?: boolean|null, inUnitModel?: boolean|null, unitModelNames?: string }>>} shopItems
 * @param {string} syncedAtIso
 */
function buildMatrix(shops, shopItems, syncedAtIso) {
    const shopMaps = {};
    shops.forEach((s) => {
        shopMaps[s.id] = new Map(
            (shopItems[s.id] || []).map((r) => {
                let inUnit = null;
                if (r.inUnitModel === true) inUnit = true;
                else if (r.inUnitModel === false) inUnit = false;
                let repricerEnabled = null;
                if (r.repricerEnabled === true) repricerEnabled = true;
                else if (r.repricerEnabled === false) repricerEnabled = false;
                return [
                    r.uid,
                    {
                        name: String(r.name || ''),
                        updatedAt: String(r.updatedAt || ''),
                        repricerEnabled,
                        inUnitModel: inUnit,
                        unitModelNames: String(r.unitModelNames || ''),
                    },
                ];
            })
        );
    });
    const uidSet = new Set();
    shops.forEach((s) => {
        const m = shopMaps[s.id];
        if (!m) return;
        for (const uid of m.keys()) {
            const u = String(uid || '').trim();
            if (u) uidSet.add(u);
        }
    });
    const sortedUids = Array.from(uidSet).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    const header = [HUCKSTER_MATRIX_UPDATED_COL];
    shops.forEach((s, idx) => {
        if (idx > 0) header.push('');
        header.push(
            `UID ${s.name}`,
            `Наименование товаров ${s.name}`,
            `Репрайсер включён ${s.name}`,
            `Юнит ${s.name}`,
            `Модели Unit ${s.name}`
        );
    });
    const syncIso = syncedAtIso && String(syncedAtIso).trim() ? String(syncedAtIso).trim() : '';
    const syncCell = syncIso ? formatMatrixUpdatedCell(syncIso) : '';
    if (syncIso) header.push(HUCKSTER_MATRIX_SYNC_COL);
    const rows = [header];
    sortedUids.forEach((uid) => {
        let latestIso = '';
        shops.forEach((s) => {
            const rec = shopMaps[s.id].get(uid);
            if (rec && rec.updatedAt) {
                if (!latestIso || rec.updatedAt > latestIso) latestIso = rec.updatedAt;
            }
        });
        const row = [formatMatrixUpdatedCell(latestIso)];
        shops.forEach((s, idx) => {
            if (idx > 0) row.push('');
            const rec = shopMaps[s.id].get(uid);
            const name = rec ? String(rec.name || '') : '';
            let unitCell = '—';
            let unitModelsCell = '—';
            if (rec) {
                if (rec.inUnitModel === true) unitCell = 'да';
                else if (rec.inUnitModel === false) unitCell = 'нет';
                unitModelsCell = String(rec.unitModelNames || '').trim();
            }
            let repricerCell = '—';
            if (rec) {
                if (rec.repricerEnabled === true) repricerCell = 'да';
                else if (rec.repricerEnabled === false) repricerCell = 'нет';
            }
            row.push(rec ? uid : '', rec ? name : '', repricerCell, unitCell, unitModelsCell);
        });
        if (syncIso) row.push(syncCell);
        rows.push(row);
    });
    const unit_gap_shop_indexes_by_uid = {};
    sortedUids.forEach((uid) => {
        const idxList = [];
        shops.forEach((s, shopIdx) => {
            const rec = shopMaps[s.id].get(uid);
            if (rec && rec.inUnitModel === false) idxList.push(shopIdx);
        });
        if (idxList.length) unit_gap_shop_indexes_by_uid[uid] = idxList;
    });
    return { rows, total_uids: sortedUids.length, unit_gap_shop_indexes_by_uid };
}

module.exports = {
    buildMatrix,
    formatMatrixUpdatedCell,
    HUCKSTER_MATRIX_UPDATED_COL,
    HUCKSTER_MATRIX_SYNC_COL,
};
