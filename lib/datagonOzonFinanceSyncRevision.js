'use strict';

/**
 * Ревизии синка финансов Ozon (cash-flow → dg_mp_ozon_cashflow_period).
 */
const OZON_FINANCE_SYNC_REVISIONS = Object.freeze([
    {
        revision: 1,
        version: '1.0.0',
        date: '2026-10-26',
        notes:
            'KPI «Ozon должен» = end_balance свежей недели cash-flow-statement/list; бэкап begin/end по неделям; не клон таблицы «Начисления и документы».',
    },
    {
        revision: 2,
        version: '1.0.1',
        date: '2026-10-26',
        notes: 'Периоды с балансами из result.details (не cash_flows); DATE через DATE_FORMAT без TZ-сдвига.',
    },
    {
        revision: 3,
        version: '1.1.0',
        date: '2026-10-26',
        notes: 'Серия графика analytics: end_balance по месяцам; автосинк ozon_finance вкл. по умолчанию (воркер 2).',
    },
]);

const OZON_FINANCE_SYNC_CURRENT = OZON_FINANCE_SYNC_REVISIONS[OZON_FINANCE_SYNC_REVISIONS.length - 1];

function getOzonFinanceSyncMeta() {
    return {
        id: 'ozon-finance',
        version: OZON_FINANCE_SYNC_CURRENT.version,
        revision: OZON_FINANCE_SYNC_CURRENT.revision,
        label: 'Ozon · к выплате',
        notes: OZON_FINANCE_SYNC_CURRENT.notes,
        date: OZON_FINANCE_SYNC_CURRENT.date,
    };
}

module.exports = {
    OZON_FINANCE_SYNC_REVISIONS,
    OZON_FINANCE_SYNC_CURRENT,
    getOzonFinanceSyncMeta,
};
