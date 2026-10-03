/**
 * Смысловая карта таблиц основной БД Datagon → внешние системы / экраны.
 * Не FK-граф MySQL: подписи для UI «Управление БД».
 */

/** @typedef {{ id: string, title: string, subtitle: string, color: string }} DbDomain */

/** @type {DbDomain[]} */
const DB_DOMAINS = [
    {
        id: 'cms',
        title: 'Мои товары / CMS',
        subtitle: 'Сайты из «Мои сайты» → my_products; запись цен обратно в Bitrix/Webasyst',
        color: 'primary',
    },
    {
        id: 'moysklad',
        title: 'МойСклад',
        subtitle: 'Импорт номенклатуры, остатков, отгрузок и заказов из API МС',
        color: 'success',
    },
    {
        id: 'marketplaces',
        title: 'Маркетплейсы',
        subtitle: 'Ozon / Wildberries / Я.Маркет, габариты, новые товары, Huckster',
        color: 'info',
    },
    {
        id: 'network',
        title: 'Цены сети',
        subtitle: 'Эталон → целевые сайты, связи SKU, задачи контенту',
        color: 'warning',
    },
    {
        id: 'parser',
        title: 'Парсер конкурентов',
        subtitle: 'Проекты, очередь, результаты, сопоставление',
        color: 'secondary',
    },
    {
        id: 'purchase',
        title: 'Закупки и поставщики',
        subtitle: 'Overrides закупок, поставщики, анализ, снимок остатков',
        color: 'dark',
    },
    {
        id: 'finance',
        title: 'Финансы',
        subtitle: 'Счета и проводки из банка Точка (только чтение)',
        color: 'success',
    },
    {
        id: 'logs',
        title: 'Журналы и система',
        subtitle: 'Автосинк, активность, настройки приложения',
        color: 'danger',
    },
    {
        id: 'other',
        title: 'Прочее',
        subtitle: 'Таблицы без явной привязки в каталоге',
        color: 'light',
    },
];

/**
 * Ключ — имя таблицы (lowercase). value: domain id + human note.
 * @type {Record<string, { domain: string, note: string, links?: string[] }>}
 */
const TABLE_META = {
    my_sites: {
        domain: 'cms',
        note: 'Подключения к БД магазинов (Bitrix/Webasyst): хост, маппинг полей',
        links: ['/my-sites.html'],
    },
    my_products: {
        domain: 'cms',
        note: 'Локальный каталог наших сайтов: SKU, цена, остаток; источник для «Мои товары» и цен сети',
        links: ['/my-products.html', '/network-prices.html'],
    },
    network_price_site_settings: {
        domain: 'network',
        note: 'Вкл/% наценки целевых сайтов относительно эталона',
        links: ['/network-prices.html'],
    },
    network_product_links: {
        domain: 'network',
        note: 'Ручные связи эталон ↔ целевой товар',
        links: ['/network-prices.html'],
    },
    network_product_link_ignore: {
        domain: 'network',
        note: 'Исключения авто-связки по артикулу',
        links: ['/network-prices.html'],
    },
    network_content_tasks: {
        domain: 'network',
        note: 'Флаги задач контент-отделу по целевым товарам',
        links: ['/network-prices.html'],
    },
    network_prices_action_log: {
        domain: 'network',
        note: 'Журнал действий цен сети (deactivate/activate/apply)',
        links: ['/network-prices.html'],
    },
    ms_export: {
        domain: 'moysklad',
        note: 'Выгрузка номенклатуры/остатков МойСклад → экран «Мой Склад»',
        links: ['/moysklad.html'],
    },
    ms_demand: {
        domain: 'moysklad',
        note: 'Отгрузки МС (шапки) для продаж и формулы закупок',
        links: ['/ms-sales.html'],
    },
    ms_demand_position: {
        domain: 'moysklad',
        note: 'Позиции отгрузок МС',
        links: ['/ms-sales.html', '/purchase.html'],
    },
    dg_product_stock_snapshot: {
        domain: 'moysklad',
        note: 'Дневные снимки остатка после полного синка МС',
        links: ['/moysklad.html', '/settings.html'],
    },
    dg_bundle_components: {
        domain: 'moysklad',
        note: 'Состав комплектов МС для анализа поставщиков',
        links: ['/supplier-analysis.html'],
    },
    medmarket_map: {
        domain: 'moysklad',
        note: 'Коды/типы Медмаркет ↔ МС',
        links: ['/medmarket.html'],
    },
    dg_medmarket_map: {
        domain: 'moysklad',
        note: 'Коды/типы Медмаркет ↔ МС',
        links: ['/medmarket.html'],
    },
    prices: {
        domain: 'parser',
        note: 'Результаты парсинга цен конкурентов',
        links: ['/results.html'],
    },
    projects: {
        domain: 'parser',
        note: 'Проекты/сайты конкурентов',
        links: ['/projects.html'],
    },
    pages: {
        domain: 'parser',
        note: 'URL в очереди/обходе парсера',
        links: ['/queue.html'],
    },
    sources: {
        domain: 'parser',
        note: 'Источники/проекты парсинга (legacy)',
        links: ['/projects.html'],
    },
    discovery_jobs: {
        domain: 'parser',
        note: 'Задачи discovery sitemap/обхода',
        links: ['/queue.html'],
    },
    matching_jobs: {
        domain: 'parser',
        note: 'Фоновые задания сопоставления',
        links: ['/matches.html'],
    },
    matching_job_logs: {
        domain: 'parser',
        note: 'Логи заданий сопоставления',
        links: ['/matches.html'],
    },
    match_product_log: {
        domain: 'parser',
        note: 'Журнал действий по матчам',
        links: ['/matches.html'],
    },
    match_exclusion: {
        domain: 'parser',
        note: 'Исключения сопоставления',
        links: ['/matches.html'],
    },
    match_manual_archive: {
        domain: 'parser',
        note: 'Архив ручных матчей',
        links: ['/matches.html'],
    },
    matches: {
        domain: 'parser',
        note: 'Сопоставление наших SKU с конкурентами',
        links: ['/matches.html'],
    },
    product_matches: {
        domain: 'parser',
        note: 'Связи сопоставления товаров',
        links: ['/matches.html'],
    },
    source_links_cache: {
        domain: 'parser',
        note: 'Кэш ссылок источников',
        links: ['/projects.html'],
    },
    dg_finance_accounts: {
        domain: 'finance',
        note: 'Счета Точки: номер, валюта, снимок баланса',
        links: ['/finance.html'],
    },
    dg_finance_tx: {
        domain: 'finance',
        note: 'Проводки входящие/исходящие из выписки Точки',
        links: ['/finance.html'],
    },
    dg_manager_sales_rows: {
        domain: 'finance',
        note: 'Годовые журналы оплат менеджеров',
        links: ['/manager-sales.html'],
    },
    dg_manager_sales_plans: {
        domain: 'finance',
        note: 'Планы продаж и пороги % МП. по годам (steps_json у плана года)',
        links: ['/manager-sales.html'],
    },
    dg_manager_sales_log: {
        domain: 'finance',
        note: 'Журнал изменений строк таблиц менеджеров',
        links: ['/manager-sales.html'],
    },
    app_settings: {
        domain: 'logs',
        note: 'Ключи настроек панели (автосинк, retention, API-ключи)',
        links: ['/settings.html'],
    },
    auto_sync_runs: {
        domain: 'logs',
        note: 'Журнал запусков автосинхронизации',
        links: ['/processes.html', '/settings.html'],
    },
    dg_activity_events: {
        domain: 'logs',
        note: 'Журнал действий пользователей в панели',
        links: ['/processes.html'],
    },
    app_pages: {
        domain: 'logs',
        note: 'Реестр страниц для матрицы доступа',
        links: ['/settings.html'],
    },
    specialty_page_modes: {
        domain: 'logs',
        note: 'Режимы доступа страниц по специальностям',
        links: ['/settings.html'],
    },
    specialties: {
        domain: 'logs',
        note: 'Специальности пользователей',
        links: ['/settings.html'],
    },
    users: {
        domain: 'logs',
        note: 'Учётные записи панели',
        links: ['/settings.html'],
    },
    auth_sessions: {
        domain: 'logs',
        note: 'Сессии входа',
        links: ['/settings.html'],
    },
    dg_purchase_overrides: {
        domain: 'purchase',
        note: 'Ручные поля закупок (неснижаемый, кратность) поверх ms_export',
        links: ['/purchase.html'],
    },
    dg_purchase_overrides_log: {
        domain: 'purchase',
        note: 'Журнал изменений полей закупок',
        links: ['/purchase.html', '/settings.html'],
    },
    dg_supplier_settings: {
        domain: 'purchase',
        note: 'Настройки по поставщику (наполняемость, дни пополнения)',
        links: ['/suppliers.html'],
    },
    dg_supplier_fill_history: {
        domain: 'purchase',
        note: 'История % наполняемости поставщика',
        links: ['/suppliers.html'],
    },
    dg_supplier_ms_order_log: {
        domain: 'purchase',
        note: 'Журнал заказов поставщику в МС',
        links: ['/suppliers.html'],
    },
    dg_formula_proposed_cache: {
        domain: 'purchase',
        note: 'Кэш предлагаемого неснижаемого по формуле продаж',
        links: ['/purchase.html', '/product.html'],
    },
    dg_min_stock_overrides: {
        domain: 'purchase',
        note: 'Overrides неснижаемого остатка',
        links: ['/purchase.html'],
    },
    dg_min_stock_log: {
        domain: 'purchase',
        note: 'Журнал неснижаемого остатка',
        links: ['/purchase.html'],
    },
    dg_purchase_min_stock_apply_batch: {
        domain: 'purchase',
        note: 'Пакеты применения неснижаемого',
        links: ['/purchase.html'],
    },
    dg_purchase_min_stock_apply_item: {
        domain: 'purchase',
        note: 'Строки пакетов неснижаемого',
        links: ['/purchase.html'],
    },
    dg_product_analysis_decisions: {
        domain: 'purchase',
        note: 'Решения анализа товаров',
        links: ['/product-analysis.html'],
    },
    dg_product_analysis_decisions_log: {
        domain: 'purchase',
        note: 'Журнал решений анализа товаров',
        links: ['/product-analysis.html'],
    },
    dg_product_zero_stock_log: {
        domain: 'moysklad',
        note: 'Журнал нулевых остатков',
        links: ['/moysklad.html'],
    },
    dg_product_zero_stock_window_import: {
        domain: 'moysklad',
        note: 'Импорт окон нулевых остатков',
        links: ['/moysklad.html'],
    },
    dg_ms_sync_log: {
        domain: 'moysklad',
        note: 'Журнал синка МойСклад',
        links: ['/moysklad.html', '/processes.html'],
    },
    ms_export_stock_by_store: {
        domain: 'moysklad',
        note: 'Остатки МС по складам',
        links: ['/moysklad.html'],
    },
    ms_entity_details: {
        domain: 'moysklad',
        note: 'Детали сущностей МС (кэш)',
        links: ['/moysklad.html'],
    },
    ms_min_stock_export_log: {
        domain: 'moysklad',
        note: 'Лог выгрузки неснижаемого в МС',
        links: ['/moysklad.html'],
    },
    ms_dimensions_log: {
        domain: 'marketplaces',
        note: 'Журнал синка габаритов МС → маркетплейсы',
        links: ['/exports-dimensions.html'],
    },
    ms_dimensions_measurements: {
        domain: 'marketplaces',
        note: 'Измерения габаритов',
        links: ['/exports-dimensions.html'],
    },
    marketplace_export_rows: {
        domain: 'marketplaces',
        note: 'Строки выгрузок маркетплейсов',
        links: ['/exports-marketplaces.html'],
    },
    mp_issues_daily_snapshot: {
        domain: 'marketplaces',
        note: 'Снимки «Проблемы с товарами»',
        links: ['/exports-marketplaces-issues.html'],
    },
    dg_mp_competitor_marks: {
        domain: 'marketplaces',
        note: 'Метки конкурентов на маркетплейсах',
        links: ['/exports-marketplaces-competitors.html'],
    },
    huckster_matrix_snapshots: {
        domain: 'marketplaces',
        note: 'Снапшоты матрицы Huckster',
        links: ['/exports-huckster.html'],
    },
    dg_new_products: {
        domain: 'marketplaces',
        note: 'Новые товары / контент-отдел',
        links: ['/exports-new-products.html'],
    },
    dg_new_products_log: {
        domain: 'marketplaces',
        note: 'Журнал новых товаров',
        links: ['/exports-new-products.html'],
    },
    dg_new_product_kits: {
        domain: 'marketplaces',
        note: 'Наборы/киты новых товаров',
        links: ['/exports-new-products.html'],
    },
    dg_np_crm_task_links: {
        domain: 'marketplaces',
        note: 'Ссылки CRM-задач контент-отдела',
        links: ['/exports-new-products.html'],
    },
    ms_customer_order: {
        domain: 'moysklad',
        note: 'Заказы покупателей из МС',
        links: ['/ms-orders.html'],
    },
    ms_customer_order_position: {
        domain: 'moysklad',
        note: 'Позиции заказов МС',
        links: ['/ms-orders.html'],
    },
};

function getDomainById(id) {
    return DB_DOMAINS.find((d) => d.id === id) || DB_DOMAINS.find((d) => d.id === 'other');
}

function getTableMeta(tableName) {
    const key = String(tableName || '')
        .trim()
        .toLowerCase();
    const hit = TABLE_META[key];
    if (hit) {
        const domain = getDomainById(hit.domain);
        return {
            table: key,
            domain: domain.id,
            domain_title: domain.title,
            domain_color: domain.color,
            note: hit.note,
            links: hit.links || [],
        };
    }
    const other = getDomainById('other');
    return {
        table: key,
        domain: other.id,
        domain_title: other.title,
        domain_color: other.color,
        note: 'Нет описания в каталоге связей — смотрите превью и имя таблицы',
        links: [],
    };
}

function buildRelationsCatalog() {
    const byDomain = DB_DOMAINS.map((d) => ({
        id: d.id,
        title: d.title,
        subtitle: d.subtitle,
        color: d.color,
        tables: [],
    }));
    const index = Object.fromEntries(byDomain.map((g) => [g.id, g]));
    Object.keys(TABLE_META)
        .sort()
        .forEach((name) => {
            const meta = getTableMeta(name);
            const g = index[meta.domain] || index.other;
            g.tables.push({
                name,
                note: meta.note,
                links: meta.links,
            });
        });
    return {
        domains: byDomain,
        table_count_catalog: Object.keys(TABLE_META).length,
    };
}

module.exports = {
    DB_DOMAINS,
    TABLE_META,
    getTableMeta,
    getDomainById,
    buildRelationsCatalog,
};
