'use strict';

/**
 * Ревизии синка финансов Яндекс Маркета (united-netting → «к выплате»).
 */
const YM_FINANCE_SYNC_REVISIONS = Object.freeze([
    {
        revision: 1,
        version: '1.0.0',
        date: '2026-10-26',
        notes:
            'KPI «Я.М · к выплате» = сумма операций отчёта united-netting со статусом «Будет переведён по графику выплат» (знак: начисление +, списание/возврат −). Это ближе к «Предстоящие выплаты» в кабинете, не к «Баланс на сегодня». Живого balance API у МП нет.',
    },
    {
        revision: 2,
        version: '1.1.0',
        date: '2026-10-26',
        notes:
            'KPI = Σ по закрытым неделям Маркета: «Будет переведён» + «Будет удержан», период = max(неделя доставки, неделя транзакции); transactionSum уже со знаком. Совпадает с суммами выплат кабинета по закрытым неделям (напр. 38 689 / 119 187). Незакрытая текущая неделя в Partner API завышена относительно кабинета — в KPI не входит. Разбивка периодов → details_json.',
    },
    {
        revision: 3,
        version: '1.2.0',
        date: '2026-10-27',
        notes:
            'Backfill месяцев графика: EOM owed = Σ bankSum выплат с датой > 1-го следующего месяца (закрытые недели доставки) + остаток UP. Сверка: сен 2026 EOM = 475 720,54 (= выплаты 5 и 12 окт). POST /api/finance/mp/ym-backfill.',
    },
    {
        revision: 4,
        version: '1.3.0',
        date: '2026-10-27',
        notes:
            'График: Σ bankSum по месяцу даты выплаты (не хвост долга EOM — из‑за него май был ~53 тыс.). Карточка по‑прежнему «к выплате» (закрытые недели).',
    },
]);

const YM_FINANCE_SYNC_CURRENT = YM_FINANCE_SYNC_REVISIONS[YM_FINANCE_SYNC_REVISIONS.length - 1];

function getYmFinanceSyncMeta() {
    return {
        id: 'ym-finance',
        version: YM_FINANCE_SYNC_CURRENT.version,
        revision: YM_FINANCE_SYNC_CURRENT.revision,
        label: 'Я.М · к выплате',
        notes: YM_FINANCE_SYNC_CURRENT.notes,
        date: YM_FINANCE_SYNC_CURRENT.date,
    };
}

module.exports = {
    YM_FINANCE_SYNC_REVISIONS,
    YM_FINANCE_SYNC_CURRENT,
    getYmFinanceSyncMeta,
};
