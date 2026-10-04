'use strict';

/**
 * Ревизии синка заявок Planfix для операционного листа.
 */
const OPS_PLANFIX_SYNC_REVISIONS = Object.freeze([
    {
        revision: 1,
        version: '1.0.0',
        date: '2026-10-04',
        notes:
            'POST /task/list: постановщик, дата создания, поле «Статус Сделки/Письма». В БД только номер задачи, статус, постановщик, created_at. Месяц — по дате создания. Корзины статусов на /ops-sheet.html.',
    },
    {
        revision: 2,
        version: '1.1.0',
        date: '2026-10-04',
        notes:
            'Синк Planfix за выбранный месяц (или весь год): фильтр даты создания и очистка только этого периода.',
    },
    {
        revision: 3,
        version: '1.2.0',
        date: '2026-10-04',
        notes:
            'Отдельная выгрузка «Статус Сделки/Письма» из отчёта Planfix (generate/save/data): справочник значений для корзин и запись в задачи. Fallback — системный статус задачи, если поле на токене закрыто.',
    },
    {
        revision: 4,
        version: '1.3.0',
        date: '2026-10-04',
        notes:
            'Справочник «Статус Сделки/Письма» (Отправлено КП, Обработка запроса, …) отдельно от системного статуса задачи. Системный пишется в planfix_status / колонка «Статус Планфикс». Отчёты вроде 450666, где в колонке дублируется процесс, пропускаем.',
    },
]);

const OPS_PLANFIX_SYNC_CURRENT = OPS_PLANFIX_SYNC_REVISIONS[OPS_PLANFIX_SYNC_REVISIONS.length - 1];

function getOpsPlanfixSyncMeta() {
    return {
        id: 'ops-planfix-sync',
        version: OPS_PLANFIX_SYNC_CURRENT.version,
        revision: OPS_PLANFIX_SYNC_CURRENT.revision,
        label: 'Заявки Planfix',
        notes: OPS_PLANFIX_SYNC_CURRENT.notes,
        date: OPS_PLANFIX_SYNC_CURRENT.date,
    };
}

module.exports = {
    OPS_PLANFIX_SYNC_REVISIONS,
    OPS_PLANFIX_SYNC_CURRENT,
    getOpsPlanfixSyncMeta,
};
