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
    {
        revision: 6,
        version: '1.5.0',
        date: '2026-10-04',
        notes:
            'В синк только шаблоны заявок/КП (14, 176404), не заказы витрин. Если сейв отчёта «Статус Сделки/Письма» не пересекается с периодом — генерируем отчёт заново, иначе колонка остаётся пустой.',
    },
    {
        revision: 7,
        version: '1.6.0',
        date: '2026-10-04',
        notes:
            'Дата создания задачи — календарь Europe/Moscow (как фильтр месяца в Planfix). UTC из dateTime больше не кладётся как наивное локальное время: заявки 1 января 00:00–02:59 МСК не уезжают в декабрь.',
    },
    {
        revision: 8,
        version: '1.7.0',
        date: '2026-10-05',
        notes:
            'Шаблоны заявок/КП (14 и 176404) запрашиваются двумя фильтрами, не «14;176404»: такой value в Planfix даёт 0 задач и пустой синк.',
    },
    {
        revision: 10,
        version: '1.8.0',
        date: '2026-10-05',
        notes:
            'Счётчики статусов из сейва отчёта Planfix (без постановщик=менеджер и без шаблонов КП) пишутся отдельно от заявок листа, чтобы сверять «Поставщик» 1:1 с отчётом.',
    },
    {
        revision: 11,
        version: '1.8.1',
        date: '2026-10-05',
        notes:
            '«В отчёте Planfix» режется по дате создания в выбранном периоде: сейв целиком больше не кладётся в январь. Даты задач периода индексируются без отбора шаблона/постановщика.',
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
