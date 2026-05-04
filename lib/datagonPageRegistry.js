/**
 * Каталог страниц панели Datagon (ключ = data-dg-active-nav / матрица доступа).
 * Синхронизируется в БД (app_pages); новые записи добавляются при старте сервера.
 */

/** @type {Array<{ key: string, title: string, htmlFile: string, navSlug: string, sortOrder: number }>} */
const PAGE_DEFS = [
    { key: 'dashboard', title: 'Дашборд', htmlFile: 'dashboard.html', navSlug: 'dashboard', sortOrder: 10 },
    { key: 'my-sites', title: 'Мои сайты', htmlFile: 'my-sites.html', navSlug: 'my-sites', sortOrder: 20 },
    { key: 'my-products', title: 'Мои товары', htmlFile: 'my-products.html', navSlug: 'my-products', sortOrder: 30 },
    { key: 'moysklad', title: 'МойСклад', htmlFile: 'moysklad.html', navSlug: 'moysklad', sortOrder: 40 },
    { key: 'projects', title: 'Конкуренты', htmlFile: 'projects.html', navSlug: 'projects', sortOrder: 50 },
    { key: 'queue', title: 'Очередь парсинга', htmlFile: 'queue.html', navSlug: 'queue', sortOrder: 60 },
    { key: 'results', title: 'Результаты', htmlFile: 'results.html', navSlug: 'results', sortOrder: 70 },
    { key: 'matches', title: 'Сопоставление', htmlFile: 'matches.html', navSlug: 'matches', sortOrder: 80 },
    { key: 'processes', title: 'Активность и процессы', htmlFile: 'processes.html', navSlug: 'processes', sortOrder: 90 },
    { key: 'settings', title: 'Настройки', htmlFile: 'settings.html', navSlug: 'settings', sortOrder: 100 },
    { key: 'sections', title: 'Каталог статических экранов', htmlFile: 'sections.html', navSlug: 'sections', sortOrder: 110 }
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
    ['/processes/overview', 'processes'],
    ['/activity/track', null],
    ['/activity/events', 'processes']
];

function htmlLeafToPageKey(leafLower) {
    const k = HTML_FILE_TO_KEY[leafLower];
    return k || null;
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
    apiRelativePathToPageKey,
    isHttpReadMethod
};
