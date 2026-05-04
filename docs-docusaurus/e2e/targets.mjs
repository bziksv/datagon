/**
 * @typedef {object} DocScreenshotTarget
 * @property {string} file
 * @property {string} path
 * @property {string} [pathNoAuth]
 * @property {boolean} auth
 * @property {'viewport' | 'full'} [capture] viewport — только окно браузера (для длинных таблиц в справке читаемо); full — вся страница
 */

/** @type {DocScreenshotTarget[]} */
export const targets = [
    { file: 'manual.png', path: '/doc-screenshots/manual-sample.html', auth: false, capture: 'full' },
    {
        file: 'dashboard.png',
        path: '/dashboard.html',
        pathNoAuth: '/doc-screenshots/dashboard-sample.html',
        auth: true,
        capture: 'full'
    },
    {
        file: 'queue.png',
        path: '/queue.html',
        pathNoAuth: '/doc-screenshots/queue-sample.html',
        auth: true,
        capture: 'viewport'
    },
    {
        file: 'mysites.png',
        path: '/my-sites.html',
        pathNoAuth: '/doc-screenshots/mysites-sample.html',
        auth: true,
        capture: 'full'
    },
    {
        file: 'myproducts.png',
        path: '/my-products.html',
        pathNoAuth: '/doc-screenshots/myproducts-sample.html',
        auth: true,
        capture: 'viewport'
    },
    {
        file: 'moysklad.png',
        path: '/moysklad.html',
        pathNoAuth: '/doc-screenshots/moysklad-sample.html',
        auth: true,
        capture: 'viewport'
    },
    {
        file: 'projects.png',
        path: '/projects.html',
        pathNoAuth: '/doc-screenshots/projects-sample.html',
        auth: true,
        capture: 'full'
    },
    {
        file: 'results.png',
        path: '/results.html',
        pathNoAuth: '/doc-screenshots/results-sample.html',
        auth: true,
        capture: 'viewport'
    },
    {
        file: 'matches.png',
        path: '/matches.html',
        pathNoAuth: '/doc-screenshots/matches-sample.html',
        auth: true,
        capture: 'viewport'
    },
    {
        file: 'processes.png',
        path: '/processes.html',
        pathNoAuth: '/doc-screenshots/processes-sample.html',
        auth: true,
        capture: 'viewport'
    },
    {
        file: 'settings.png',
        path: '/settings.html',
        pathNoAuth: '/doc-screenshots/settings-sample.html',
        auth: true,
        capture: 'full'
    }
];
