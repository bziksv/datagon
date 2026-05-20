/**
 * Каталог страниц панели Datagon (ключ = data-dg-active-nav / матрица доступа).
 * Синхронизируется в БД (app_pages); новые записи добавляются при старте сервера.
 */

/** @type {Array<{ key: string, title: string, htmlFile: string, navSlug: string, sortOrder: number }>} */
const PAGE_DEFS = [
    { key: 'dashboard', title: 'Дашборд', htmlFile: 'dashboard.html', navSlug: 'dashboard', sortOrder: 10 },
    { key: 'my-sites', title: 'Мои сайты', htmlFile: 'my-sites.html', navSlug: 'my-sites', sortOrder: 20 },
    { key: 'my-products', title: 'Мои товары (наши сайты)', htmlFile: 'my-products.html', navSlug: 'my-products', sortOrder: 30 },
    { key: 'moysklad', title: 'Мой Склад (товары)', htmlFile: 'moysklad.html', navSlug: 'moysklad', sortOrder: 40 },
    { key: 'medmarket', title: 'Медмаркет', htmlFile: 'medmarket.html', navSlug: 'medmarket', sortOrder: 41 },
    { key: 'purchase', title: 'Закупки товары', htmlFile: 'purchase.html', navSlug: 'purchase', sortOrder: 45 },
    { key: 'suppliers', title: 'Поставщики', htmlFile: 'suppliers.html', navSlug: 'suppliers', sortOrder: 45.5 },
    {
        key: 'supplier-analysis',
        title: 'Анализ поставщиков',
        htmlFile: 'supplier-analysis.html',
        navSlug: 'supplier-analysis',
        sortOrder: 45.55,
    },
    { key: 'product', title: 'Карточка товара', htmlFile: 'product.html', navSlug: 'product', sortOrder: 46 },
    { key: 'projects', title: 'Конкуренты', htmlFile: 'projects.html', navSlug: 'projects', sortOrder: 50 },
    { key: 'queue', title: 'Очередь парсинга', htmlFile: 'queue.html', navSlug: 'queue', sortOrder: 60 },
    { key: 'results', title: 'Результаты', htmlFile: 'results.html', navSlug: 'results', sortOrder: 70 },
    { key: 'matches', title: 'Сопоставление', htmlFile: 'matches.html', navSlug: 'matches', sortOrder: 80 },
    { key: 'processes', title: 'Активность/Логи', htmlFile: 'processes.html', navSlug: 'processes', sortOrder: 90 },
    { key: 'settings', title: 'Настройки', htmlFile: 'settings.html', navSlug: 'settings', sortOrder: 100 },
    { key: 'sections', title: 'Каталог статических экранов', htmlFile: 'sections.html', navSlug: 'sections', sortOrder: 110 },
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
    { key: 'ms-sales', title: 'Продажи МС', htmlFile: 'ms-sales.html', navSlug: 'ms-sales', sortOrder: 125 }
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
    ['/medmarket', 'medmarket'],
    ['/purchase', 'purchase'],
    ['/suppliers', 'suppliers'],
    ['/supplier-analysis', 'supplier-analysis'],
    ['/product', 'purchase'],
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
    ['/exports/huckster', 'exports-huckster'],
    ['/ms-sales', 'ms-sales']
];

function htmlLeafToPageKey(leafLower) {
    const k = HTML_FILE_TO_KEY[leafLower];
    return k || null;
}

/** Скрыт ли лист HTML для матрицы доступа: дочерние маркетплейсы по умолчанию наследуют скрытие от `exports-marketplaces`, но явный `view`/`full` у дочерней страницы имеет приоритет (иначе нельзя открыть только «Габариты» и т.п.). */
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
    if (mpChild && pm['exports-marketplaces'] === 'hidden') {
        const childMode = pm[pk];
        if (childMode === 'full' || childMode === 'view') return false;
        return true;
    }
    if (pk === 'product') {
        return (pm['purchase'] || 'hidden') === 'hidden' && (pm['product'] || 'hidden') === 'hidden';
    }
    return pm[pk] === 'hidden';
}

/**
 * Учёт актора: менеджер пользователей (`can_manage_users`) должен открывать `/settings.html`
 * и API для блока «Пользователи», даже если страница «Настройки» в матрице скрыта.
 * @param {{ username?: string, can_manage_users?: boolean, page_modes?: Record<string, string> } | null | undefined} actor
 */
function isHtmlLeafAccessHiddenForActor(actor, leafLower) {
    if (!actor || actor.username === 'admin') return false;
    const pm = actor.page_modes;
    if (!pm) return false;
    const low = String(leafLower || '').toLowerCase();
    const pk = htmlLeafToPageKey(low);
    if (pk === 'settings' && actor.can_manage_users === true) return false;
    return isHtmlLeafAccessHidden(pm, low);
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

/**
 * Первый лист панели, доступный актору по матрице (порядок как в PAGE_DEFS).
 * Для admin не используется в middleware (там обход проверки); для логики редиректа — да.
 * @returns {string | null} путь вида `/dashboard.html` или null, если ни одна страница не доступна.
 */
function pickFirstAllowedHtmlForActor(actor) {
    if (!actor) return null;
    if (actor.username === 'admin') return '/dashboard.html';
    for (const p of PAGE_DEFS) {
        const leaf = p.htmlFile.toLowerCase();
        // Карточка товара без ?code= — не подходит как «домашняя» после редиректа со скрытого листа.
        if (leaf === 'product.html') continue;
        if (!isHtmlLeafAccessHiddenForActor(actor, leaf)) return `/${p.htmlFile}`;
    }
    return null;
}

/** Безопасный внутренний путь после логина (только один сегмент `*.html`, без `..`). */
function normalizeInternalHtmlPath(thenRaw) {
    if (thenRaw == null) return null;
    const s = String(thenRaw).trim().split('#')[0];
    if (!s || s.includes('..')) return null;
    if (!s.startsWith('/')) return null;
    const leaf = s.slice(s.lastIndexOf('/') + 1).toLowerCase();
    if (!leaf.endsWith('.html')) return null;
    return { path: s, leaf };
}

/** `/product.html` без `code=` — не целевой экран после входа. */
function isValidPostLoginThenPath(thenRaw, norm) {
    if (!norm || !norm.path) return false;
    if (norm.leaf === 'login.html' || norm.leaf === 'no-access.html') return false;
    if (norm.leaf === 'product.html' && !/[?&]code=/i.test(String(thenRaw || ''))) return false;
    return true;
}

/**
 * Куда вести пользователя после успешного входа или при авто-редиректе с /login.html.
 * Учитывает `then` только если страница не скрыта для акторской матрицы.
 */
function resolveRedirectAfterLogin(actor, thenRaw) {
    if (!actor) return '/login.html';
    const norm = normalizeInternalHtmlPath(thenRaw);
    if (actor.username === 'admin') {
        if (norm && norm.path && isValidPostLoginThenPath(thenRaw, norm)) {
            return norm.path;
        }
        return '/dashboard.html';
    }
    if (
        norm &&
        isValidPostLoginThenPath(thenRaw, norm) &&
        !isHtmlLeafAccessHiddenForActor(actor, norm.leaf)
    ) {
        return norm.path;
    }
    const first = pickFirstAllowedHtmlForActor(actor);
    return first || '/no-access.html';
}

module.exports = {
    PAGE_DEFS,
    HTML_FILE_TO_KEY,
    API_PREFIX_RULES,
    htmlLeafToPageKey,
    isHtmlLeafAccessHidden,
    isHtmlLeafAccessHiddenForActor,
    apiRelativePathToPageKey,
    isHttpReadMethod,
    pickFirstAllowedHtmlForActor,
    resolveRedirectAfterLogin
};
