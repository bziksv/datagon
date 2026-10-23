'use strict';

/**
 * Ревизии уведомлений «Новые товары» → комментарии задач CRM.
 */
const NP_CRM_NOTIFY_REVISIONS = Object.freeze([
    {
        revision: 1,
        version: '1.0.0',
        date: '2026-10-02',
        notes:
            'Мгновенный комментарий в задачу CRM: Альмамед — как только за сотрудником появился неразмещённый товар; маркеты — когда заполнены обязательные поля. Сводка «ожидает размещения» раз в N дней. Уже лежащая в очереди пачка при первом включении помечается известной и не уходит как «новые».',
    },
    {
        revision: 2,
        version: '1.0.1',
        date: '2026-10-07',
        notes:
            'created_at комментария и уведомления CRM — UTC_TIMESTAMP() (как пишет RISE), не NOW() в МСК: иначе в ленте задачи время +3 ч.',
    },
    {
        revision: 3,
        version: '1.0.2',
        date: '2026-10-16',
        notes:
            'В «ожидает размещения» и в мгновенном комментарии только статусы not_added и in_progress. На проверку, новый и на доработке не считаются.',
    },
    {
        revision: 4,
        version: '1.0.3',
        date: '2026-10-16',
        notes:
            'Сводка «ожидает размещения» не уходит в тот же день, что мгновенное «появились новые». Отдельная сводка раз в сутки: «товаров на доработке».',
    },
    {
        revision: 5,
        version: '1.0.4',
        date: '2026-10-19',
        notes:
            'Сводка «ожидает размещения» снова не чаще чем раз в N дней: отметка отправки читалась из kind=waiting, а писалась в kind=digest, поэтому комментарий уходил каждый час.',
    },
    {
        revision: 6,
        version: '1.0.5',
        date: '2026-10-21',
        notes:
            'Не слать ту же сводку «ожидает: N» каждую полночь, если N не изменился (напоминание с тем же N — раз в 7 суток). sent_at сводки — UTC_TIMESTAMP.',
    },
    {
        revision: 7,
        version: '1.0.6',
        date: '2026-10-24',
        notes:
            'Сводка «на доработке»: sent_at из DATETIME+UTC_TIMESTAMP читать как UTC (не как MSK через mysql2), иначе после полуночи комментарий уходил каждый час до ~03:00. Плюс минимум 12 ч между отправками.',
    },
]);

const NP_CRM_NOTIFY_CURRENT = NP_CRM_NOTIFY_REVISIONS[NP_CRM_NOTIFY_REVISIONS.length - 1];

function getNpCrmNotifyMeta() {
    return {
        id: 'np-crm-notify',
        version: NP_CRM_NOTIFY_CURRENT.version,
        revision: NP_CRM_NOTIFY_CURRENT.revision,
        label: 'Уведомления CRM',
        notes: NP_CRM_NOTIFY_CURRENT.notes,
        date: NP_CRM_NOTIFY_CURRENT.date,
    };
}

module.exports = {
    NP_CRM_NOTIFY_REVISIONS,
    NP_CRM_NOTIFY_CURRENT,
    getNpCrmNotifyMeta,
};
