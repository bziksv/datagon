'use strict';

/**
 * Ревизии формулы товарного остатка МС в финансах (`lib/datagonFinanceMsInventory.js`).
 * При смене алгоритма (live ms_export / moment backfill) — новая строка + bump version.
 */
const FINANCE_MS_INVENTORY_SYNC_REVISIONS = Object.freeze([
    {
        revision: 1,
        version: '1.0.0',
        date: '2026-10-21',
        notes:
            'Σ(остаток × себестоимость) только «Товар»; без плакатов; live из ms_export; EOM/backfill — report/stock/all?moment=… 23:59:59.',
    },
    {
        revision: 2,
        version: '1.1.0',
        date: '2026-10-21',
        notes:
            'Только складская позиция «Да» (ms_export.stock_position); moment-бэкфилл пересекает report/stock/all с текущими складскими кодами.',
    },
]);

const FINANCE_MS_INVENTORY_SYNC_CURRENT =
    FINANCE_MS_INVENTORY_SYNC_REVISIONS[FINANCE_MS_INVENTORY_SYNC_REVISIONS.length - 1];

function getFinanceMsInventorySyncMeta() {
    return {
        id: 'finance-ms-inventory',
        version: FINANCE_MS_INVENTORY_SYNC_CURRENT.version,
        revision: FINANCE_MS_INVENTORY_SYNC_CURRENT.revision,
        label: 'Товар (МС) / финансы',
        notes: FINANCE_MS_INVENTORY_SYNC_CURRENT.notes,
        date: FINANCE_MS_INVENTORY_SYNC_CURRENT.date,
    };
}

module.exports = {
    FINANCE_MS_INVENTORY_SYNC_REVISIONS,
    FINANCE_MS_INVENTORY_SYNC_CURRENT,
    getFinanceMsInventorySyncMeta,
};
