/**
 * Единый реестр задач «Автосинхронизация по расписанию» для Datagon.
 *
 * Источник истины для:
 *   - whitelist `task` в `POST /api/settings/auto-sync-run` (server.js);
 *   - построения секций `autoSync.sections` в ответе `/api/processes/overview`
 *     (server.js → фронт `static-html/vanilla/inners/processes.scripts.html`);
 *   - подсказок «человеческое имя задачи» в журнале запусков `auto_sync_runs`
 *     и UI-карточек на `/processes.html`.
 *
 * Контракт элемента реестра:
 *   - `key` (string) — машинный идентификатор задачи. Используется как
 *     `task_type` в таблице `auto_sync_runs`, как ключ в `autoSyncRunIds`,
 *     как имя в очереди `autoSyncQueue` и как `task` в payload
 *     `POST /api/settings/auto-sync-run`. Менять для существующих задач
 *     нельзя — поломает историю запусков и manual-кнопки.
 *   - `title` / `subtitle` — отображаются в карточке секции
 *     «Автосинхронизация по расписанию» на `/processes.html`. Должны
 *     совпадать по смыслу с подписями карточек на `/settings.html`.
 *   - `configKeys` — соответствие полей в `app_settings`/`appSettings`:
 *     `enabled` / `time` обязательны; `extras` — массив дополнительных
 *     ключей (например, `auto_sync_mssales_days`), которые отдаются на
 *     фронт в `extras` для отображения «Период: 90 дней».
 *   - `defaults` — дефолтные значения, которые server.js использует при
 *     первичной инициализации `appSettings` и при `INSERT IGNORE` в
 *     `app_settings`.
 *
 * При добавлении новой задачи автосинхронизации:
 *   1. Добавьте элемент в `AUTO_SYNC_TASKS` ниже.
 *   2. Добавьте дефолты этих же ключей в `config.appSettings` defaults
 *      и `INSERT IGNORE INTO app_settings ...` в server.js
 *      (это пока живёт там, реестр НЕ инжектит дефолты автоматически —
 *      см. правило `datagon-auto-sync-registry.mdc`).
 *   3. Добавьте обработчик задачи в `processAutoSyncQueue` и в
 *      `startAutoSyncScheduler` в server.js.
 *   4. Добавьте принимаемые ключи в whitelist `routes/settings.js` (POST /).
 *   5. Добавьте карточку «Сохранить»/«Запустить сейчас» на
 *      `static-html/vanilla/inners/settings.inner.html` и обработчики
 *      в `settings.scripts.html` (см. `datagon-settings-save-feedback.mdc`).
 *   6. Прогоните `npm run sync:vanilla-public` и перезапустите Node.
 *
 * После шага 1 раздел на `/processes.html` подхватит задачу автоматически —
 * фронт строит секции из `autoSync.sections` (см. `processes.scripts.html`).
 */

/** Пн=1 … Вс=7 по календарю в Europe/Moscow (как в планировщике). */
function parseAutoSyncWeekdaysMon17(raw) {
    const s = String(raw ?? '').trim();
    if (!s) return new Set([1, 2, 3, 4, 5, 6, 7]);
    const out = new Set();
    for (const part of s.split(/[,;\s]+/)) {
        const n = parseInt(String(part).trim(), 10);
        if (n >= 1 && n <= 7) out.add(n);
    }
    return out.size ? out : new Set([1, 2, 3, 4, 5, 6, 7]);
}

function formatAutoSyncWeekdaysRu(raw) {
    const set = parseAutoSyncWeekdaysMon17(raw);
    if (set.size === 7) return 'ежедневно';
    const labels = ['', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'];
    return Array.from(set)
        .sort((a, b) => a - b)
        .map((d) => labels[d] || d)
        .join(', ');
}

/** Категории для UI settings/processes: import_ms, export_ms, cms, marketplace, external, internal. */
const AUTO_SYNC_UI_CATEGORIES = {
    import_ms: 'Импорт из МойСклад',
    export_ms: 'Экспорт в МойСклад',
    cms: 'Импорт из CMS',
    marketplace: 'Маркетплейсы',
    external: 'Внешние сервисы',
    internal: 'Система'
};

const AUTO_SYNC_TASKS = [
    {
        key: 'myproducts',
        category: 'cms',
        title: 'Мои товары',
        subtitle: 'Импорт из CMS магазинов',
        configKeys: {
            enabled: 'auto_sync_myproducts_enabled',
            time: 'auto_sync_myproducts_time'
        },
        defaults: { enabled: 0, time: '03:00' }
    },
    {
        key: 'moysklad',
        category: 'import_ms',
        title: 'МойСклад: каталог и остатки (МСК)',
        subtitle:
            'Номенклатура, остатки, неснижаемый из МС; после выгрузки — журнал нулевых остатков за сегодня (склад.поз. «Да», не архив). Не импорт отгрузок.',
        configKeys: {
            enabled: 'auto_sync_moysklad_enabled',
            time: 'auto_sync_moysklad_time'
        },
        defaults: { enabled: 0, time: '04:00' }
    },
    {
        key: 'ms_orders',
        category: 'import_ms',
        title: 'Заказы в МС',
        subtitle: 'Импорт customerorder; период и исключения — в карточке «Заказы в МС»',
        configKeys: {
            enabled: 'auto_sync_ms_orders_enabled',
            time: 'auto_sync_ms_orders_time',
            extras: [
                { key: 'ms_orders_sync_days', label: 'Период (дн.)', default: 30, type: 'number' },
                { key: 'auto_sync_ms_orders_weekdays', label: 'Дни недели (МСК)', default: '', type: 'weekdays' },
            ],
        },
        defaults: { enabled: 0, time: '08:00', extras: { auto_sync_ms_orders_weekdays: '' } },
    },
    {
        key: 'marketplaces',
        category: 'marketplace',
        title: 'Маркетплейсы',
        subtitle: 'Ozon · WB · Я.Маркет',
        configKeys: {
            enabled: 'auto_sync_marketplaces_enabled',
            time: 'auto_sync_marketplaces_time'
        },
        defaults: { enabled: 0, time: '05:00' }
    },
    {
        key: 'huckster',
        category: 'external',
        title: 'Калькуляция Huckster',
        subtitle: 'Расчёт цен по правилам',
        configKeys: {
            enabled: 'auto_sync_huckster_enabled',
            time: 'auto_sync_huckster_time'
        },
        defaults: { enabled: 0, time: '06:00' }
    },
    {
        key: 'db_size',
        category: 'internal',
        title: 'Размер БД и диска',
        subtitle: 'Снимок размеров таблиц БД и разбивка диска по папкам проекта',
        configKeys: {
            enabled: 'auto_sync_db_size_enabled',
            time: 'auto_sync_db_size_time'
        },
        defaults: { enabled: 1, time: '02:00' }
    },
    {
        key: 'dimensions',
        category: 'export_ms',
        uiGroup: 'export_ms',
        title: 'Габариты МС',
        subtitle: 'Выгрузка пользовательских замеров в МойСклад',
        configKeys: {
            enabled: 'auto_sync_dimensions_enabled',
            time: 'auto_sync_dimensions_time',
            exportMaster: 'auto_sync_export_ms_enabled',
            extras: [
                { key: 'auto_sync_dimensions_weekdays', label: 'Дни недели (МСК)', default: '', type: 'weekdays' }
            ]
        },
        defaults: { enabled: 0, time: '21:00', extras: { auto_sync_dimensions_weekdays: '' } }
    },
    {
        key: 'min_stock_export',
        category: 'export_ms',
        uiGroup: 'export_ms',
        title: 'Неснижаемый остаток МС',
        subtitle:
            'ms_export.min_stock («Неснижаемый остаток») → minimumBalance в МС; склад.поз. «Да», не архив. Не путать с «Пр.→НС» на закупках (только БД).',
        configKeys: {
            enabled: 'auto_sync_min_stock_export_enabled',
            time: 'auto_sync_min_stock_export_time',
            exportMaster: 'auto_sync_export_ms_enabled',
            extras: [
                {
                    key: 'auto_sync_min_stock_export_weekdays',
                    label: 'Дни недели (МСК)',
                    default: '',
                    type: 'weekdays'
                }
            ]
        },
        defaults: {
            enabled: 0,
            time: '22:00',
            extras: { auto_sync_min_stock_export_weekdays: '' }
        }
    },
    {
        key: 'mssales',
        category: 'import_ms',
        title: 'Продажи МС',
        subtitle: 'Импорт отгрузок из МойСклад за выбранное окно (позиции с привязкой к каталогу)',
        configKeys: {
            enabled: 'auto_sync_mssales_enabled',
            time: 'auto_sync_mssales_time',
            extras: [
                { key: 'auto_sync_mssales_days', label: 'Период (дн.)', default: 90, type: 'number' },
                { key: 'auto_sync_mssales_weekdays', label: 'Дни недели (МСК)', default: '', type: 'weekdays' }
            ]
        },
        defaults: { enabled: 0, time: '07:30', extras: { auto_sync_mssales_days: 90, auto_sync_mssales_weekdays: '' } }
    },
    {
        key: 'mssales_full',
        category: 'import_ms',
        title: 'Продажи МойСклад: полная выгрузка',
        subtitle: 'Полное окно отгрузок и актуализация удалённых в МойСклад',
        configKeys: {
            enabled: 'auto_sync_mssales_full_enabled',
            time: 'auto_sync_mssales_full_time',
            extras: [
                { key: 'auto_sync_mssales_full_days', label: 'Период (дн.)', default: 730, type: 'number' },
                { key: 'auto_sync_mssales_full_weekdays', label: 'Дни недели (МСК)', default: '7', type: 'weekdays' }
            ]
        },
        defaults: {
            enabled: 0,
            time: '03:15',
            extras: { auto_sync_mssales_full_days: 730, auto_sync_mssales_full_weekdays: '7' }
        }
    },
    {
        key: 'purchase_formula_cache',
        category: 'internal',
        title: 'Закупки: кэш формулы и окон',
        subtitle: 'Заполнение dg_formula_proposed_cache для дефолтной выборки (без RAM-снимка)',
        configKeys: {
            enabled: 'auto_sync_purchase_formula_cache_enabled',
            time: 'auto_sync_purchase_formula_cache_time'
        },
        defaults: { enabled: 0, time: '08:30' }
    },
    {
        key: 'medmarket',
        category: 'import_ms',
        title: 'Медмаркет: полная выгрузка атрибута',
        subtitle:
            'Импорт «Код товара для медмаркета» из ms_entity_details → ms_export по каталогу; рекомендуется только вс (МСК)',
        configKeys: {
            enabled: 'auto_sync_medmarket_enabled',
            time: 'auto_sync_medmarket_time',
            extras: [{ key: 'auto_sync_medmarket_weekdays', label: 'Дни недели (МСК)', default: '7', type: 'weekdays' }]
        },
        defaults: { enabled: 0, time: '09:00', extras: { auto_sync_medmarket_weekdays: '7' } }
    },
    {
        key: 'medmarket_fill',
        category: 'export_ms',
        title: 'Медмаркет: коды в МойСклад (код+тип)',
        subtitle:
            'Запись канонического «код+Тип» в атрибут МС (~10–12 тыс. исправлений регистра/формата, ~46 тыс. пропуск); пн–сб МСК, после воскресного medmarket',
        configKeys: {
            enabled: 'auto_sync_medmarket_fill_enabled',
            time: 'auto_sync_medmarket_fill_time',
            extras: [
                {
                    key: 'auto_sync_medmarket_fill_weekdays',
                    label: 'Дни недели (МСК)',
                    default: '1,2,3,4,5,6',
                    type: 'weekdays',
                },
            ],
        },
        defaults: {
            enabled: 0,
            time: '09:30',
            extras: { auto_sync_medmarket_fill_weekdays: '1,2,3,4,5,6' },
        },
    },
];

/** Допустимые ключи задач для whitelist в `/api/settings/auto-sync-run`. */
function getAutoSyncTaskKeys() {
    return AUTO_SYNC_TASKS.map((t) => t.key);
}

/** Найти описание задачи по `key`. */
function getAutoSyncTask(key) {
    const k = String(key || '').trim();
    if (!k) return null;
    return AUTO_SYNC_TASKS.find((t) => t.key === k) || null;
}

/**
 * Построить snapshot секций для `/api/processes/overview` → `autoSync.sections`.
 * Принимает `appSettings` (объект ключ → значение из `app_settings`),
 * возвращает массив `{ key, title, subtitle, enabled, time, extras: {label, value}[] }`.
 *
 * Используется фронтом `processes.scripts.html` → `renderAutoSyncSections`.
 */
function buildAutoSyncSectionsSnapshot(appSettings) {
    const settings = appSettings || {};
    return AUTO_SYNC_TASKS.map((t) => {
        const enabledKey = t.configKeys?.enabled;
        const timeKey = t.configKeys?.time;
        const enabledRaw = enabledKey ? settings[enabledKey] : undefined;
        const enabled =
            enabledRaw === undefined && t.defaults && t.defaults.enabled !== undefined
                ? Number(t.defaults.enabled) === 1
                : Number(enabledRaw || 0) === 1;
        const time = String(
            (timeKey && settings[timeKey]) || (t.defaults && t.defaults.time) || ''
        ).slice(0, 5);
        const extras = Array.isArray(t.configKeys?.extras)
            ? t.configKeys.extras.map((e) => {
                  const raw = settings[e.key] !== undefined ? settings[e.key] : e.default;
                  const disp =
                      e.type === 'weekdays' || String(e.key || '').endsWith('_weekdays')
                          ? formatAutoSyncWeekdaysRu(raw)
                          : raw;
                  return {
                      key: e.key,
                      label: e.label,
                      value: disp
                  };
              })
            : [];
        let effectiveEnabled = enabled;
        if (t.key === 'dimensions' || t.key === 'min_stock_export') {
            const exportMaster = Number(settings.auto_sync_export_ms_enabled || 0) === 1;
            effectiveEnabled = exportMaster && enabled;
        }
        return {
            key: t.key,
            title: t.title,
            subtitle: t.subtitle || '',
            category: t.category || 'internal',
            uiGroup: t.uiGroup || 'schedule',
            enabled: effectiveEnabled,
            time: time || '—',
            extras
        };
    });
}

module.exports = {
    AUTO_SYNC_TASKS,
    AUTO_SYNC_UI_CATEGORIES,
    getAutoSyncTaskKeys,
    getAutoSyncTask,
    buildAutoSyncSectionsSnapshot,
    parseAutoSyncWeekdaysMon17
};
