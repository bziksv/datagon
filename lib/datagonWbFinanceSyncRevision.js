'use strict';

/**
 * Ревизии синка финансов WB (balance + bankPaymentSum + inflight).
 */
const WB_FINANCE_SYNC_REVISIONS = Object.freeze([
    {
        revision: 1,
        version: '1.0.0',
        date: '2026-10-26',
        notes:
            'KPI = current + open inflight. Открытие: дельта for_withdraw/current + safety-net bankPaymentSum; закрытие: матч входящих РВБ в dg_finance_tx. Статусы «Истории платежей» API не отдаёт.',
    },
    {
        revision: 2,
        version: '1.0.1',
        date: '2026-10-26',
        notes:
            'Safety-net: только хвост невыплаченных недель до первой зачисленной в Точку; direction=in; без суток-обрезков.',
    },
    {
        revision: 3,
        version: '1.1.0',
        date: '2026-10-26',
        notes:
            'dg_mp_wb_finance_month: live/EOM снимок owed для графика; прошлые месяцы без API — gap; автосинк wb_finance вкл. (воркер 2).',
    },
    {
        revision: 4,
        version: '1.2.0',
        date: '2026-10-27',
        notes:
            'График «WB · выплаты»: Σ bankPaymentSum по месяцу date_to из sales-reports (кабинет «Финансовые отчёты»). Карточка по‑прежнему баланс+inflight. paid_in_month в dg_mp_wb_finance_month; POST /api/finance/mp/wb-backfill.',
    },
]);

const WB_FINANCE_SYNC_CURRENT = WB_FINANCE_SYNC_REVISIONS[WB_FINANCE_SYNC_REVISIONS.length - 1];

function getWbFinanceSyncMeta() {
    return {
        id: 'wb-finance',
        version: WB_FINANCE_SYNC_CURRENT.version,
        revision: WB_FINANCE_SYNC_CURRENT.revision,
        label: 'WB · должен',
        notes: WB_FINANCE_SYNC_CURRENT.notes,
        date: WB_FINANCE_SYNC_CURRENT.date,
    };
}

module.exports = {
    WB_FINANCE_SYNC_REVISIONS,
    WB_FINANCE_SYNC_CURRENT,
    getWbFinanceSyncMeta,
};
