'use strict';

/**
 * Ревизии синка заказов поставщикам (`entity/purchaseorder` → `ms_purchase_order`).
 */
const MS_PURCHASE_ORDERS_SYNC_REVISIONS = Object.freeze([
    {
        revision: 1,
        version: '1.0.0',
        date: '2026-10-21',
        notes:
            'Шапка purchaseorder: sum/payedSum/shippedSum; KPI A unshipped+paid, B partial+paid+state; без entity/supply.',
    },
    {
        revision: 2,
        version: '1.0.1',
        date: '2026-10-26',
        notes:
            'Страница MS limit=50, timeout 300s + retry на timeout/5xx (фикс «timeout of 120000ms exceeded» на длинном периоде с 2023).',
    },
]);

const MS_PURCHASE_ORDERS_SYNC_CURRENT =
    MS_PURCHASE_ORDERS_SYNC_REVISIONS[MS_PURCHASE_ORDERS_SYNC_REVISIONS.length - 1];

function getMsPurchaseOrdersSyncMeta() {
    return {
        id: 'ms-purchase-orders',
        version: MS_PURCHASE_ORDERS_SYNC_CURRENT.version,
        revision: MS_PURCHASE_ORDERS_SYNC_CURRENT.revision,
        label: 'Заказы поставщикам',
        notes: MS_PURCHASE_ORDERS_SYNC_CURRENT.notes,
        date: MS_PURCHASE_ORDERS_SYNC_CURRENT.date,
    };
}

module.exports = {
    MS_PURCHASE_ORDERS_SYNC_REVISIONS,
    MS_PURCHASE_ORDERS_SYNC_CURRENT,
    getMsPurchaseOrdersSyncMeta,
};
