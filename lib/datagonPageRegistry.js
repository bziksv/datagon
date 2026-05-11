/**
 * Каталог страниц панели Datagon (ключ = data-dg-active-nav / матрица доступа).
 * Синхронизируется в БД (app_pages); новые записи добавляются при старте сервера.
 */

/** @type {Array<{ key: string, title: string, htmlFile: string, navSlug: string, sortOrder: number }>} */
const PAGE_DEFS = [
    { key: 'dashboard', title: 'Дашборд', htmlFile: 'dashboard.html', navSlug: 'dashboard', sortOrder: 10 },
    { key: 'my-sites', title: 'Мои сайты', htmlFile: 'my-sites.html', navSlug: 'my-sites', sortOrder: 20 },
    { key: 'my-products', title: 'Мои товары (наши сайты)', htmlFile: 'my-products.html', navSlug: 'my-products', sortOrder: 30 },
    { key: 'moysklad', title: 'МойСклад', htmlFile: 'moysklad.html', navSlug: 'moysklad', sortOrder: 40 },
    { key: 'projects', title: 'Конкуренты', htmlFile: 'projects.html', navSlug: 'projects', sortOrder: 50 },
    { key: 'queue', title: 'Очередь парсинга', htmlFile: 'queue.html', navSlug: 'queue', sortOrder: 60 },
    { key: 'results', title: 'Результаты', htmlFile: 'results.html', navSlug: 'results', sortOrder: 70 },
    { key: 'matches', title: 'Сопоставление', htmlFile: 'matches.html', navSlug: 'matches', sortOrder: 80 },
    { key: 'processes', title: 'Активность и процессы', htmlFile: 'processes.html', navSlug: 'processes', sortOrder: 90 },
    { key: 'settings', title: 'Настройки', htmlFile: 'settings.html', navSlug: 'settings', sortOrder: 100 },
    { key: 'sections', title: 'Каталог статических экранов', htmlFile: 'sections.html', navSlug: 'sections', sortOrder: 110 },
    { key: 'exports-ms', title: 'Выгрузки МС', htmlFile: 'exports-ms.html', navSlug: 'exports-ms', sortOrder: 115 },
    { key: 'exports-marketplaces', title: 'Маркетплейсы — Настройки', htmlFile: 'exports-marketplaces.html', navSlug: 'exports-marketplaces', sortOrder: 116 },
    { key: 'exports-marketplaces-ozon', title: 'Маркетплейсы — Ozon', htmlFile: 'exports-marketplaces-ozon.html', navSlug: 'exports-marketplaces-ozon', sortOrder: 117 },
    {
        key: 'exports-marketplaces-wildberries',
        title: 'Маркетплейсы — Wildberries',
        htmlFile: 'exports-marketplaces-wildberries.html',
        navSlug: 'exports-marketplaces-wildberries',
        sortOrder: 118,
    },
    {
        key: 'exports-marketplaces-yandex',
        title: 'Маркетплейсы — Яндекс Маркет',
        htmlFile: 'exports-marketplaces-yandex.html',
        navSlug: 'exports-marketplaces-yandex',
        sortOrder: 119,
    },
    {
        key: 'exports-dimensions',
        title: 'Маркетплейсы — Габариты',
        htmlFile: 'exports-dimensions.html',
        navSlug: 'exports-dimensions',
        sortOrder: 119.3,
    },
    {
        key: 'exports-marketplaces-issues',
        title: 'Маркетплейсы — Проблемы с товарами',
        htmlFile: 'exports-marketplaces-issues.html',
        navSlug: 'exports-marketplaces-issues',
        sortOrder: 119.5,
    },
    { key: 'exports-huckster', title: 'Huckster', htmlFile: 'exports-huckster.html', navSlug: 'exports-huckster', sortOrder: 120 },
    { key: 'exports-summary', title: 'Сводка и синхронизация', htmlFile: 'exports-summary.html', navSlug: 'exports-summary', sortOrder: 121 }
];

const HTML_FILE_TO_KEY = Object.fromEntries(PAGE_DEFS.map((p) => [p.htmlFile.toLowerCase(), p.key]));

/**
 * Префиксы путей относительно монтирования `/api` (req.path в middleware на app.use('/api')).
 * Порядок: более длинные совпадения раньше.
 * pageKey: null — не проверять режим (всегда разрешено при наличии сессии).
 */
const API_PREFIX_RULES = [
    ['/auth/users', 'settings'],
    ['/auth/sessions-overview', null],
    ['/auth/me', null],
    ['/auth/login', null],
    ['/auth/logout', null],
    ['/auth/change-password', null],
    ['/auth/sync-session-cookie', null],
    ['/my-products', 'my-products'],
    ['/my-sites', 'my-sites'],
    ['/matches', 'matches'],
    ['/specialties', 'settings'],
    ['/ms', 'moysklad'],
    ['/parse', 'queue'],
    ['/pages', 'queue'],
    ['/results', 'results'],
    ['/projects', 'projects'],
    ['/settings', 'settings'],
    ['/sync-site-start', 'settings'],
    ['/sync-all-start', 'settings'],
    ['/sync-status', 'settings'],
    ['/processes/db-size', 'dashboard'],
    ['/processes/overview', 'processes'],
    ['/activity/track', null],
    ['/activity/events', 'processes'],
    ['/exports/marketplaces', 'exports-marketplaces'],
    ['/exports/dimensions', 'exports-dimensions'],
    ['/exports/huckster', 'exports-huckster']
];

function htmlLeafToPageKey(leafLower) {
    const k = HTML_FILE_TO_KEY[leafLower];
    return k || null;
}

/** Скрыт ли лист HTML для матрицы доступа (дочерние маркетплейсы наследуют скрытие от `exports-marketplaces`). */
function isHtmlLeafAccessHidden(pageModes, leafLower) {
    const pk = htmlLeafToPageKey(leafLower);
    if (!pk) return false;
    const pm = pageModes || {};
    const mpChild =
        pk === 'exports-marketplaces-ozon' ||
        pk === 'exports-marketplaces-wildberries' ||
        pk === 'exports-marketplaces-yandex' ||
        pk === 'exports-marketplaces-issues' ||
        pk === 'exports-dimensions';
    if (mpChild && pm['exports-marketplaces'] === 'hidden') return true;
    return pm[pk] === 'hidden';
}

/**
 * @param {string} apiPathRelative - например `/my-products/stats` (как в Express для app.use('/api'))
 */
function apiRelativePathToPageKey(apiPathRelative) {
    const p = String(apiPathRelative || '').split('?')[0];
    if (!p || p.charAt(0) !== '/') return null;
    for (const [prefix, pageKey] of API_PREFIX_RULES) {
        if (p === prefix || p.startsWith(prefix + '/')) return pageKey;
    }
    return null;
}

/** GET/HEAD — «просмотр»; остальное требует full (если не public auth). */
function isHttpReadMethod(method) {
    const m = String(method || '').toUpperCase();
    return m === 'GET' || m === 'HEAD' || m === 'OPTIONS';
}

module.exports = {
    PAGE_DEFS,
    HTML_FILE_TO_KEY,
    API_PREFIX_RULES,
    htmlLeafToPageKey,
    isHtmlLeafAccessHidden,
    apiRelativePathToPageKey,
    isHttpReadMethod
};
