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
 *   - `worker` (number, default **1**) — какой процесс pm2 обслуживает
 *     очередь этой задачи. `1` = основной `parser-app` (HTTP + большинство
 *     автосинков), `2` = `parser-autosync-w2` (банки / Planfix / Bitcop),
 *     `3` = `parser-autosync-w3` (перепарсинг результатов),
 *     `4` = `parser-autosync-w4` (наклейки → Webasyst / stickers_cms).
 *     Задаётся в реестре, не в UI.
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

/** Категории для UI settings/processes: import_ms, export_ms, cms, price_monitor, marketplace, external, internal. */
const AUTO_SYNC_UI_CATEGORIES = {
    import_ms: 'Импорт из МойСклад',
    export_ms: 'Экспорт в МойСклад',
    cms: 'Импорт из CMS',
    price_monitor: 'Мониторинг цен конкурентов и парсинг данных',
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
        key: 'stickers_cms',
        category: 'cms',
        /** Отдельный pm2-воркер: CMS Features не блокируют очередь МС на w1. */
        worker: 4,
        title: 'Наклейки, остатки и цены → Webasyst',
        subtitle:
            'Features dg_sticker_*, остаток МС (склады сайта) и цена по марже от закупочной → Webasyst. Ночной прогон + webhook.',
        configKeys: {
            enabled: 'auto_sync_stickers_cms_enabled',
            time: 'auto_sync_stickers_cms_time',
            extras: [
                {
                    key: 'auto_sync_stickers_cms_site_id',
                    label: 'Сайты Webasyst (all или id через запятую)',
                    default: 'all',
                    type: 'text',
                },
            ],
        },
        defaults: {
            enabled: 0,
            time: '03:00',
            extras: { auto_sync_stickers_cms_site_id: 'all' },
        },
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
        key: 'ms_inventory_month',
        category: 'import_ms',
        title: 'Финансы: товарный остаток МС (конец месяца)',
        subtitle:
            'Снимок Σ(остаток × себестоимость) только «Товар» в dg_finance_ms_inventory_month; по расписанию срабатывает только в последний день месяца МСК (~23:55). Привязка к Альмамед на /finance.html.',
        configKeys: {
            enabled: 'auto_sync_ms_inventory_month_enabled',
            time: 'auto_sync_ms_inventory_month_time'
        },
        defaults: { enabled: 0, time: '23:55' }
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
        key: 'ms_purchase_orders',
        category: 'import_ms',
        title: 'Заказы поставщикам (МС)',
        subtitle:
            'Импорт purchaseorder → ms_purchase_order; KPI «в пути / недопринято» на /finance.html и список /ms-purchase-orders.html',
        configKeys: {
            enabled: 'auto_sync_ms_purchase_orders_enabled',
            time: 'auto_sync_ms_purchase_orders_time',
            extras: [
                {
                    key: 'ms_purchase_orders_sync_from',
                    label: 'С даты (YYYY-MM-DD)',
                    default: '2022-01-01',
                    type: 'string',
                },
            ],
        },
        defaults: { enabled: 0, time: '08:30' },
    },
    {
        key: 'marketplaces_ozon',
        category: 'marketplace',
        title: 'Ozon',
        subtitle: 'Снапшот кабинета Ozon → marketplace_export_rows; лог logs/marketplace-ozon-sync.log',
        configKeys: {
            enabled: 'auto_sync_marketplaces_ozon_enabled',
            time: 'auto_sync_marketplaces_ozon_time',
        },
        defaults: { enabled: 0, time: '06:00' },
    },
    {
        key: 'marketplaces_wb',
        category: 'marketplace',
        title: 'Wildberries',
        subtitle: 'Снапшот кабинета WB → marketplace_export_rows; лог logs/marketplace-wb-sync.log',
        configKeys: {
            enabled: 'auto_sync_marketplaces_wb_enabled',
            time: 'auto_sync_marketplaces_wb_time',
        },
        defaults: { enabled: 0, time: '06:25' },
    },
    {
        key: 'marketplaces_ym',
        category: 'marketplace',
        title: 'Яндекс Маркет',
        subtitle: 'Снапшот кабинета Я.Маркет → marketplace_export_rows; лог logs/marketplace-ym-sync.log',
        configKeys: {
            enabled: 'auto_sync_marketplaces_ym_enabled',
            time: 'auto_sync_marketplaces_ym_time',
        },
        defaults: { enabled: 0, time: '06:50' },
    },
    {
        key: 'mp_fix_ozon_dims',
        category: 'marketplace',
        title: 'Ozon: исправить габариты',
        subtitle: 'Выгрузка эталонных габаритов из МС в карточки Ozon с расхождением (/exports-marketplaces-issues.html)',
        configKeys: {
            enabled: 'auto_sync_mp_fix_ozon_dims_enabled',
            time: 'auto_sync_mp_fix_ozon_dims_time',
            extras: [
                { key: 'auto_sync_mp_fix_ozon_dims_weekdays', label: 'Дни недели (МСК)', default: '', type: 'weekdays' },
            ],
        },
        defaults: { enabled: 0, time: '07:10', extras: { auto_sync_mp_fix_ozon_dims_weekdays: '' } },
    },
    {
        key: 'mp_fix_wb_dims',
        category: 'marketplace',
        title: 'Wildberries: исправить габариты',
        subtitle: 'Выгрузка эталонных габаритов из МС в карточки WB с расхождением (/exports-marketplaces-issues.html)',
        configKeys: {
            enabled: 'auto_sync_mp_fix_wb_dims_enabled',
            time: 'auto_sync_mp_fix_wb_dims_time',
            extras: [
                { key: 'auto_sync_mp_fix_wb_dims_weekdays', label: 'Дни недели (МСК)', default: '', type: 'weekdays' },
            ],
        },
        defaults: { enabled: 0, time: '07:20', extras: { auto_sync_mp_fix_wb_dims_weekdays: '' } },
    },
    {
        key: 'mp_fix_ym_dims',
        category: 'marketplace',
        title: 'Яндекс Маркет: исправить габариты',
        subtitle: 'Выгрузка эталонных габаритов из МС в карточки Я.М с расхождением (/exports-marketplaces-issues.html)',
        configKeys: {
            enabled: 'auto_sync_mp_fix_ym_dims_enabled',
            time: 'auto_sync_mp_fix_ym_dims_time',
            extras: [
                { key: 'auto_sync_mp_fix_ym_dims_weekdays', label: 'Дни недели (МСК)', default: '', type: 'weekdays' },
            ],
        },
        defaults: { enabled: 0, time: '07:30', extras: { auto_sync_mp_fix_ym_dims_weekdays: '' } },
    },
    {
        key: 'mp_fix_ozon_vat',
        category: 'marketplace',
        title: 'Ozon: исправить НДС',
        subtitle: 'Выгрузка ставки НДС из МС в карточки Ozon с расхождением НДС (/exports-marketplaces-issues.html)',
        configKeys: {
            enabled: 'auto_sync_mp_fix_ozon_vat_enabled',
            time: 'auto_sync_mp_fix_ozon_vat_time',
            extras: [
                { key: 'auto_sync_mp_fix_ozon_vat_weekdays', label: 'Дни недели (МСК)', default: '', type: 'weekdays' },
            ],
        },
        defaults: { enabled: 0, time: '07:40', extras: { auto_sync_mp_fix_ozon_vat_weekdays: '' } },
    },
    {
        key: 'mp_fix_wb_vat',
        category: 'marketplace',
        title: 'Wildberries: исправить НДС',
        subtitle: 'Выгрузка ставки НДС из МС в карточки WB с расхождением НДС (/exports-marketplaces-issues.html)',
        configKeys: {
            enabled: 'auto_sync_mp_fix_wb_vat_enabled',
            time: 'auto_sync_mp_fix_wb_vat_time',
            extras: [
                { key: 'auto_sync_mp_fix_wb_vat_weekdays', label: 'Дни недели (МСК)', default: '', type: 'weekdays' },
            ],
        },
        defaults: { enabled: 0, time: '07:50', extras: { auto_sync_mp_fix_wb_vat_weekdays: '' } },
    },
    {
        key: 'mp_fix_ym_vat',
        category: 'marketplace',
        title: 'Яндекс Маркет: исправить НДС',
        subtitle: 'Выгрузка ставки НДС из МС в карточки Я.М с расхождением НДС (/exports-marketplaces-issues.html)',
        configKeys: {
            enabled: 'auto_sync_mp_fix_ym_vat_enabled',
            time: 'auto_sync_mp_fix_ym_vat_time',
            extras: [
                { key: 'auto_sync_mp_fix_ym_vat_weekdays', label: 'Дни недели (МСК)', default: '', type: 'weekdays' },
            ],
        },
        defaults: { enabled: 0, time: '08:00', extras: { auto_sync_mp_fix_ym_vat_weekdays: '' } },
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
        key: 'np_ms_enrich',
        category: 'internal',
        scheduleMode: 'interval',
        title: 'Новые товары: поля из МС',
        subtitle:
            'Дозаполнение кода / штрихкода / НДС / РУ / СС·ДС в очереди «Размещение на маркеты» из кэша МойСклад (без live API); в логе — прогресс',
        configKeys: {
            enabled: 'auto_sync_np_ms_enrich_enabled',
            extras: [
                {
                    key: 'auto_sync_np_ms_enrich_interval_min',
                    label: 'Интервал (мин.)',
                    default: 30,
                    type: 'interval_min',
                },
                {
                    key: 'auto_sync_np_ms_enrich_weekdays',
                    label: 'Дни недели (МСК)',
                    default: '',
                    type: 'weekdays',
                },
            ],
        },
        defaults: {
            enabled: 0,
            extras: { auto_sync_np_ms_enrich_interval_min: 30, auto_sync_np_ms_enrich_weekdays: '' },
        },
    },
    {
        key: 'np_crm_notify',
        category: 'internal',
        scheduleMode: 'interval',
        title: 'Новые товары: уведомления CRM',
        subtitle:
            'Комментарии в задачи CRM: новые товары на размещение и сводка «ожидает размещения»',
        configKeys: {
            enabled: 'auto_sync_np_crm_notify_enabled',
            extras: [
                {
                    key: 'auto_sync_np_crm_notify_interval_min',
                    label: 'Интервал (мин.)',
                    default: 15,
                    type: 'interval_min',
                },
                {
                    key: 'auto_sync_np_crm_notify_weekdays',
                    label: 'Дни недели (МСК)',
                    default: '',
                    type: 'weekdays',
                },
            ],
        },
        defaults: {
            enabled: 0,
            extras: { auto_sync_np_crm_notify_interval_min: 15, auto_sync_np_crm_notify_weekdays: '' },
        },
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
    {
        key: 'price_comp_sync',
        category: 'price_monitor',
        title: 'Мои товары: цены с конкурента (ДМ/МК)',
        subtitle:
            'Массовая запись цен в CMS: мин. Dealmed/Медкомплекс − случайный %; фильтры match_audit / остаток / сайт — в карточке',
        configKeys: {
            enabled: 'auto_sync_price_comp_enabled',
            time: 'auto_sync_price_comp_time',
            extras: [
                {
                    key: 'auto_sync_price_comp_weekdays',
                    label: 'Дни недели (МСК)',
                    default: '1,2,3,4,5,6,7',
                    type: 'weekdays',
                },
                {
                    key: 'auto_sync_price_comp_match_audit',
                    label: 'Сопоставление',
                    default: 'confirmed',
                    type: 'text',
                },
                {
                    key: 'auto_sync_price_comp_rand_min',
                    label: 'Синх. % мин',
                    default: '0.1',
                    type: 'text',
                },
                {
                    key: 'auto_sync_price_comp_rand_max',
                    label: 'Синх. % макс',
                    default: '0.99',
                    type: 'text',
                },
                {
                    key: 'auto_sync_price_comp_stock_min',
                    label: 'Остаток от',
                    default: '0',
                    type: 'text',
                },
                {
                    key: 'auto_sync_price_comp_stock_max',
                    label: 'Остаток до',
                    default: '1000',
                    type: 'text',
                },
            ],
        },
        defaults: {
            enabled: 0,
            time: '10:00',
            extras: {
                auto_sync_price_comp_weekdays: '1,2,3,4,5,6,7',
                auto_sync_price_comp_match_audit: 'confirmed',
                auto_sync_price_comp_rand_min: '0.1',
                auto_sync_price_comp_rand_max: '0.99',
                auto_sync_price_comp_stock_min: '0',
                auto_sync_price_comp_stock_max: '1000',
            },
        },
    },
    {
        key: 'network_prices',
        category: 'cms',
        title: 'Цены сети',
        subtitle:
            'Эталон Альмамед → целевые сайты: цена × (1 + %); только сайты с заданным % в /network-prices.html',
        configKeys: {
            enabled: 'auto_sync_network_prices_enabled',
            time: 'auto_sync_network_prices_time',
            extras: [
                {
                    key: 'auto_sync_network_prices_weekdays',
                    label: 'Дни недели (МСК)',
                    default: '1,2,3,4,5,6,7',
                    type: 'weekdays',
                },
            ],
        },
        defaults: {
            enabled: 0,
            time: '11:00',
            extras: { auto_sync_network_prices_weekdays: '1,2,3,4,5,6,7' },
        },
    },
    {
        key: 'results_reparse_products',
        category: 'price_monitor',
        /** Отдельный pm2-воркер: массовый reset очереди не блокирует HTTP/МС. */
        worker: 3,
        title: 'Результаты: перепарсинг товаров',
        subtitle:
            'Ставит в очередь URL из /results.html с типом «Товар» (page_type=product); парсер обновит цены/SKU в prices',
        configKeys: {
            enabled: 'auto_sync_results_reparse_products_enabled',
            time: 'auto_sync_results_reparse_products_time',
            extras: [
                {
                    key: 'auto_sync_results_reparse_products_weekdays',
                    label: 'Дни недели (МСК)',
                    default: '4',
                    type: 'weekdays',
                },
            ],
        },
        defaults: {
            enabled: 1,
            time: '23:00',
            extras: { auto_sync_results_reparse_products_weekdays: '4' },
        },
    },
    {
        key: 'finance_tochka',
        category: 'external',
        /** Отдельный pm2-воркер: банк Точка не ждёт очередь МС/маркетплейсов. */
        worker: 2,
        title: 'Финансы: банки',
        subtitle: 'Точка, Райф, Т‑Банк: счета и выписка (только чтение) → dg_finance_*',
        configKeys: {
            enabled: 'auto_sync_finance_tochka_enabled',
            time: 'auto_sync_finance_tochka_time',
            extras: [
                { key: 'auto_sync_finance_tochka_days', label: 'Период выписки (дн.)', default: 30, type: 'number' },
                {
                    key: 'auto_sync_finance_tochka_weekdays',
                    label: 'Дни недели (МСК)',
                    default: '',
                    type: 'weekdays',
                },
            ],
        },
        defaults: {
            enabled: 0,
            time: '07:00',
            extras: { auto_sync_finance_tochka_days: 30, auto_sync_finance_tochka_weekdays: '' },
        },
    },
    {
        key: 'ozon_finance',
        category: 'marketplace',
        worker: 2,
        title: 'Финансы: Ozon к выплате',
        subtitle:
            'cash-flow-statement/list → dg_mp_ozon_cashflow_period; KPI end_balance на /finance.html (не в «Всего доступно»).',
        configKeys: {
            enabled: 'auto_sync_ozon_finance_enabled',
            time: 'auto_sync_ozon_finance_time',
            extras: [
                {
                    key: 'auto_sync_ozon_finance_weekdays',
                    label: 'Дни недели (МСК)',
                    default: '',
                    type: 'weekdays',
                },
            ],
        },
        defaults: {
            enabled: 1,
            time: '07:20',
            extras: { auto_sync_ozon_finance_weekdays: '' },
        },
    },
    {
        key: 'wb_finance',
        category: 'marketplace',
        worker: 2,
        title: 'Финансы: WB должен',
        subtitle:
            'account/balance + sales-reports bankPaymentSum + inflight; KPI = current + на проводке (закрытие по РВБ в выписке).',
        configKeys: {
            enabled: 'auto_sync_wb_finance_enabled',
            time: 'auto_sync_wb_finance_time',
            extras: [
                {
                    key: 'auto_sync_wb_finance_weekdays',
                    label: 'Дни недели (МСК)',
                    default: '',
                    type: 'weekdays',
                },
            ],
        },
        defaults: {
            enabled: 1,
            time: '07:25',
            extras: { auto_sync_wb_finance_weekdays: '' },
        },
    },
    {
        key: 'ym_finance',
        category: 'marketplace',
        worker: 2,
        title: 'Финансы: Я.М к выплате',
        subtitle:
            'united-netting → предстоящие по закрытым неделям Маркета (rev.2); KPI на /finance.html. Лимит API ~1 отчёт / 2 мин.',
        configKeys: {
            enabled: 'auto_sync_ym_finance_enabled',
            time: 'auto_sync_ym_finance_time',
            extras: [
                {
                    key: 'auto_sync_ym_finance_weekdays',
                    label: 'Дни недели (МСК)',
                    default: '',
                    type: 'weekdays',
                },
            ],
        },
        defaults: {
            enabled: 1,
            time: '07:30',
            extras: { auto_sync_ym_finance_weekdays: '' },
        },
    },
    {
        key: 'ops_planfix',
        category: 'external',
        /** Отдельный pm2-воркер: generate Planfix не блокирует очередь МС. */
        worker: 2,
        title: 'Операционный лист: отчёт Planfix',
        subtitle:
            'Только отчёт 450694. Период — как в UI Planfix. Скользящие 14/90 дней обновляют статусы заявок и не затирают помесячные гистограммы.',
        configKeys: {
            enabled: 'auto_sync_ops_planfix_enabled',
            time: 'auto_sync_ops_planfix_time',
            extras: [
                {
                    key: 'auto_sync_ops_planfix_weekdays',
                    label: 'Дни недели (МСК)',
                    default: '',
                    type: 'weekdays',
                },
            ],
        },
        defaults: {
            enabled: 1,
            time: '20:00',
            extras: { auto_sync_ops_planfix_weekdays: '' },
        },
    },
    {
        key: 'bitcop_hours',
        category: 'external',
        /** Внешний API Bitcop — на воркере 2, вечером после Planfix. */
        worker: 2,
        title: 'График: часы из Bitcop',
        subtitle:
            'Продуктивные часы → табель (ws_work_log); по умолчанию последние 7 дней, только сотрудники «по часам».',
        configKeys: {
            enabled: 'auto_sync_bitcop_hours_enabled',
            time: 'auto_sync_bitcop_hours_time',
            extras: [
                { key: 'auto_sync_bitcop_hours_days', label: 'Период (дн.)', default: 7, type: 'number' },
                {
                    key: 'auto_sync_bitcop_hours_only_hourly',
                    label: 'Только «по часам»',
                    default: 1,
                    type: 'number',
                },
                {
                    key: 'auto_sync_bitcop_hours_weekdays',
                    label: 'Дни недели (МСК)',
                    default: '',
                    type: 'weekdays',
                },
            ],
        },
        defaults: {
            enabled: 1,
            time: '21:00',
            extras: {
                auto_sync_bitcop_hours_days: 7,
                auto_sync_bitcop_hours_only_hourly: 1,
                auto_sync_bitcop_hours_weekdays: '',
            },
        },
    },
];

/** Нормализация id воркера автосинка: 1|2|3|4 (иначе 1). */
function normalizeAutoSyncWorkerId(raw) {
    const w = Number(raw);
    if (w === 2 || w === 3 || w === 4) return w;
    return 1;
}

/** Номер воркера (1|2|3|4) для задачи; по умолчанию 1. */
function getAutoSyncTaskWorker(key) {
    const t = getAutoSyncTask(key);
    return normalizeAutoSyncWorkerId(t && t.worker != null ? t.worker : 1);
}

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
                  let disp = raw;
                  if (e.type === 'weekdays' || String(e.key || '').endsWith('_weekdays')) {
                      disp = formatAutoSyncWeekdaysRu(raw);
                  } else if (e.type === 'interval_min') {
                      const n = Number(raw);
                      disp = Number.isFinite(n) && n > 0 ? `каждые ${n} мин` : raw;
                  }
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
        let timeLabel = time || '—';
        if (t.scheduleMode === 'interval') {
            const ivExtra = extras.find((x) => String(x.key || '').includes('interval_min'));
            timeLabel = ivExtra && ivExtra.value ? String(ivExtra.value) : 'по интервалу';
        }
        return {
            key: t.key,
            title: t.title,
            subtitle: t.subtitle || '',
            category: t.category || 'internal',
            uiGroup: t.uiGroup || 'schedule',
            worker: getAutoSyncTaskWorker(t.key),
            enabled: effectiveEnabled,
            time: timeLabel,
            scheduleMode: t.scheduleMode || 'daily',
            extras
        };
    });
}

module.exports = {
    AUTO_SYNC_TASKS,
    AUTO_SYNC_UI_CATEGORIES,
    getAutoSyncTaskKeys,
    getAutoSyncTask,
    normalizeAutoSyncWorkerId,
    getAutoSyncTaskWorker,
    buildAutoSyncSectionsSnapshot,
    parseAutoSyncWeekdaysMon17
};
