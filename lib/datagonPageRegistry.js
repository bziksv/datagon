/**
 * Каталог страниц панели Datagon (ключ = data-dg-active-nav / матрица доступа).
 * Синхронизируется в БД (app_pages); новые записи добавляются при старте сервера.
 */

/** @type {Array<{ key: string, title: string, htmlFile: string, navSlug: string, sortOrder: number, matrixOnly?: boolean }>} */
const PAGE_DEFS = [
    { key: 'dashboard', title: 'Дашборд', htmlFile: 'dashboard.html', navSlug: 'dashboard', sortOrder: 10 },
    { key: 'db-admin', title: 'Управление БД', htmlFile: 'db-admin.html', navSlug: 'db-admin', sortOrder: 11 },
    { key: 'processes', title: 'Активность/Логи', htmlFile: 'processes.html', navSlug: 'processes', sortOrder: 12 },
    { key: 'settings', title: 'Настройки', htmlFile: 'settings.html', navSlug: 'settings', sortOrder: 13 },
    { key: 'finance', title: 'Финансы', htmlFile: 'finance.html', navSlug: 'finance', sortOrder: 14 },
    {
        key: 'manager-sales',
        title: 'Таблицы менеджеров',
        htmlFile: 'manager-sales.html',
        navSlug: 'manager-sales',
        sortOrder: 14.5,
    },
    {
        key: 'ops-sheet',
        title: 'Операционный лист',
        htmlFile: 'ops-sheet.html',
        navSlug: 'ops-sheet',
        sortOrder: 14.6,
    },
    {
        key: 'work-schedule',
        title: 'График работы',
        htmlFile: 'work-schedule.html',
        navSlug: 'work-schedule',
        sortOrder: 14.7,
    },
    {
        key: 'work-schedule-settings',
        title: 'График · настройки',
        htmlFile: 'work-schedule-settings.html',
        navSlug: 'work-schedule-settings',
        sortOrder: 14.75,
    },
    {
        key: 'work-seo-projects',
        title: 'WORK — Проекты SEO',
        htmlFile: 'work-seo-projects.html',
        navSlug: 'work-seo-projects',
        sortOrder: 15,
    },
    {
        key: 'work-seo-passwords',
        title: 'WORK — Пароли SEO',
        htmlFile: 'work-seo-passwords.html',
        navSlug: 'work-seo-passwords',
        sortOrder: 15.1,
    },
    {
        key: 'work-dev-passwords',
        title: 'WORK — Пароли DEV',
        htmlFile: 'work-dev-passwords.html',
        navSlug: 'work-dev-passwords',
        sortOrder: 15.2,
    },
    {
        key: 'work-context-projects',
        title: 'WORK — Проекты контекст',
        htmlFile: 'work-context-projects.html',
        navSlug: 'work-context-projects',
        sortOrder: 15.3,
    },
    {
        key: 'work-context-passwords',
        title: 'WORK — Пароли контекст',
        htmlFile: 'work-context-passwords.html',
        navSlug: 'work-context-passwords',
        sortOrder: 15.4,
    },
    {
        key: 'work-services',
        title: 'WORK — Сервисы & Пароли',
        htmlFile: 'work-services.html',
        navSlug: 'work-services',
        sortOrder: 15.5,
    },
    {
        key: 'work-seo-staff',
        title: 'WORK — Сотрудники SEO',
        htmlFile: 'work-seo-staff.html',
        navSlug: 'work-seo-staff',
        sortOrder: 15.6,
    },
    { key: 'my-sites', title: 'Мои сайты', htmlFile: 'my-sites.html', navSlug: 'my-sites', sortOrder: 20 },
    {
        key: 'network-prices',
        title: 'Цены сети',
        htmlFile: 'network-prices.html',
        navSlug: 'network-prices',
        sortOrder: 25,
    },
    { key: 'my-products', title: 'Мои товары (наши сайты)', htmlFile: 'my-products.html', navSlug: 'my-products', sortOrder: 30 },
    { key: 'moysklad', title: 'Мой Склад (товары)', htmlFile: 'moysklad.html', navSlug: 'moysklad', sortOrder: 40 },
    { key: 'ms-orders', title: 'Заказы в МС', htmlFile: 'ms-orders.html', navSlug: 'ms-orders', sortOrder: 40.5 },
    { key: 'ms-sales', title: 'Продажи МС', htmlFile: 'ms-sales.html', navSlug: 'ms-sales', sortOrder: 40.6 },
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
    {
        key: 'product-analysis',
        title: 'Анализ товаров',
        htmlFile: 'product-analysis.html',
        navSlug: 'product-analysis',
        sortOrder: 45.56,
    },
    { key: 'product', title: 'Карточка товара', htmlFile: 'product.html', navSlug: 'product', sortOrder: 46 },
    { key: 'projects', title: 'Конкуренты', htmlFile: 'projects.html', navSlug: 'projects', sortOrder: 50 },
    { key: 'queue', title: 'Очередь парсинга', htmlFile: 'queue.html', navSlug: 'queue', sortOrder: 60 },
    { key: 'results', title: 'Результаты', htmlFile: 'results.html', navSlug: 'results', sortOrder: 70 },
    { key: 'matches', title: 'Сопоставление', htmlFile: 'matches.html', navSlug: 'matches', sortOrder: 80 },
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
    {
        key: 'exports-new-products',
        title: 'Маркетплейсы — Новые товары',
        htmlFile: 'exports-new-products.html',
        navSlug: 'exports-new-products',
        sortOrder: 119.7,
    },
    {
        key: 'exports-new-products-stats',
        title: 'Маркетплейсы — Статистика контент-отдела',
        /** Матрица доступа к вкладке/API статистики; HTML — тот же экран «Новые товары». */
        htmlFile: 'exports-new-products.html',
        navSlug: 'exports-new-products-stats',
        sortOrder: 119.71,
        matrixOnly: true,
    },
    {
        key: 'exports-new-products-standing',
        title: 'Маркетплейсы — Постоянные задачи',
        /** Матрица доступа к вкладке/API «Постоянные задачи» (инфографика); HTML — тот же экран. */
        htmlFile: 'exports-new-products.html',
        navSlug: 'exports-new-products-standing',
        sortOrder: 119.715,
        matrixOnly: true,
    },
    {
        key: 'exports-new-products-crm-notify',
        title: 'Маркетплейсы — Уведомления Датагон-CRM',
        /** Матрица доступа к вкладке уведомлений в задачи CRM; HTML — тот же экран «Новые товары». */
        htmlFile: 'exports-new-products.html',
        navSlug: 'exports-new-products-crm-notify',
        sortOrder: 119.718,
        matrixOnly: true,
    },
    {
        key: 'exports-photoshoot',
        title: 'Маркетплейсы — Отснять товары',
        htmlFile: 'exports-photoshoot.html',
        navSlug: 'exports-photoshoot',
        sortOrder: 119.72,
    },
    {
        key: 'exports-marketplaces-competitors',
        title: 'Маркетплейсы — Конкуренты',
        htmlFile: 'exports-marketplaces-competitors.html',
        navSlug: 'exports-marketplaces-competitors',
        sortOrder: 119.75,
    },
    {
        key: 'exports-marketplaces-reglament',
        title: 'Маркетплейсы — Инструкция',
        htmlFile: 'exports-marketplaces-reglament.html',
        navSlug: 'exports-marketplaces-reglament',
        sortOrder: 119.8,
    },
    { key: 'exports-huckster', title: 'Huckster', htmlFile: 'exports-huckster.html', navSlug: 'exports-huckster', sortOrder: 120 },
];

const HTML_FILE_TO_KEY = Object.fromEntries(
    PAGE_DEFS.filter((p) => !p.matrixOnly).map((p) => [p.htmlFile.toLowerCase(), p.key])
);

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
    ['/network-prices', 'network-prices'],
    ['/my-sites', 'my-sites'],
    ['/matches', 'matches'],
    ['/specialties', 'settings'],
    ['/ms', 'moysklad'],
    ['/medmarket', 'medmarket'],
    ['/purchase', 'purchase'],
    ['/suppliers', 'suppliers'],
    ['/supplier-analysis', 'supplier-analysis'],
    ['/product-analysis', 'product-analysis'],
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
    ['/processes/disk-usage', 'dashboard'],
    ['/processes/min-stock-export-errors', 'processes'],
    ['/processes/overview', 'processes'],
    ['/db-admin', 'db-admin'],
    ['/finance', 'finance'],
    ['/manager-sales', 'manager-sales'],
    ['/ops-sheet', 'ops-sheet'],
    ['/activity/track', null],
    ['/activity/events', 'processes'],
    ['/exports/marketplaces', 'exports-marketplaces'],
    ['/exports/competitors', 'exports-marketplaces-competitors'],
    ['/exports/dimensions', 'exports-dimensions'],
    ['/exports/new-products/content-stats', 'exports-new-products-stats'],
    ['/exports/new-products/standing-stats', 'exports-new-products-standing'],
    ['/exports/new-products/crm-notify', 'exports-new-products-crm-notify'],
    // scope almamed|marketplaces|infographic — проверка в routes/exportsNewProducts.js
    ['/exports/new-products/crm-task-links', null],
    ['/exports/new-products', 'exports-new-products'],
    ['/exports/photoshoot', 'exports-photoshoot'],
    ['/exports/huckster', 'exports-huckster'],
    ['/ms-sales', 'ms-sales'],
    ['/ms-orders', 'ms-orders'],
    // clock/access — любой авторизованный (карточка сотрудника проверяется в роутере)
    ['/work-schedule/clock', null],
    ['/work-schedule/access', null],
    // остальной API: страница «График» или «График · настройки» (см. getApiPageModeForActor)
    ['/work-schedule', 'work-schedule'],
    // WORK (legacy work.prime-ltd.su) — длинные префиксы раньше коротких
    ['/work/seo-payout-settings', 'work-seo-projects'],
    ['/work/seo-payout-recalc', 'work-seo-projects'],
    ['/work/seo-projects', 'work-seo-projects'],
    ['/work/seo-passwords', 'work-seo-passwords'],
    ['/work/dev-passwords', 'work-dev-passwords'],
    ['/work/context-projects', 'work-context-projects'],
    ['/work/context-passwords', 'work-context-passwords'],
    ['/work/services', 'work-services'],
    ['/work/seo-staff', 'work-seo-staff'],
    ['/work/meta', 'work-seo-projects'],
];

/**
 * Режим доступа к API: для work-schedule берём более «открытый» из
 * work-schedule и work-schedule-settings (бухгалтерия может иметь только settings).
 * @returns {'full'|'view'|'hidden'}
 */
function getApiPageModeForActor(actor, pageKey) {
    if (!actor || actor.username === 'admin') return 'full';
    const pm = actor.page_modes || {};
    let mode = pm[pageKey] || 'full';
    if (pageKey === 'work-schedule') {
        const alt = pm['work-schedule-settings'];
        const rank = { full: 2, view: 1, hidden: 0 };
        const r1 = rank[mode] != null ? rank[mode] : 2;
        const r2 = alt != null && rank[alt] != null ? rank[alt] : 0;
        if (r2 > r1) mode = alt;
    }
    return mode;
}

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
        pk === 'exports-dimensions' ||
        pk === 'exports-new-products' ||
        pk === 'exports-new-products-stats' ||
        pk === 'exports-new-products-standing' ||
        pk === 'exports-new-products-crm-notify' ||
        pk === 'exports-photoshoot' ||
        pk === 'exports-marketplaces-competitors' ||
        pk === 'exports-marketplaces-reglament';
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
 * Режим матрицы для актора (как middleware `/api`: admin → full; нет ключа → full).
 * @returns {'full'|'view'|'hidden'}
 */
function getActorPageMode(actor, pageKey) {
    if (!actor || actor.username === 'admin') return 'full';
    const pm = actor.page_modes || {};
    const m = pm[pageKey];
    if (m === 'full' || m === 'view' || m === 'hidden') return m;
    return 'full';
}

/**
 * Проверка доступа к pageKey. Возвращает null если ок, иначе { status, code, error }.
 * @param {{ write?: boolean }} opts — write=true требует full (не view).
 */
function assertActorPageAccess(actor, pageKey, opts = {}) {
    const write = !!opts.write;
    const mode = getActorPageMode(actor, pageKey);
    if (mode === 'hidden') {
        return { status: 403, code: 'PAGE_HIDDEN', error: 'Нет доступа к разделу' };
    }
    if (write && mode === 'view') {
        return { status: 403, code: 'PAGE_VIEW_ONLY', error: 'Режим только просмотра' };
    }
    return null;
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
        if (p.matrixOnly) continue;
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
    getActorPageMode,
    getApiPageModeForActor,
    assertActorPageAccess,
    pickFirstAllowedHtmlForActor,
    resolveRedirectAfterLogin
};
