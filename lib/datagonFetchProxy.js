'use strict';

let fetchProxyColsReady = false;

/**
 * Добавляет колонки прокси в `projects` (идемпотентно).
 * @param {import('mysql2/promise').Pool | import('mysql2/promise').Connection} db
 */
async function ensureProjectFetchProxyColumns(db) {
    if (fetchProxyColsReady) return;
    try {
        const [c1] = await db.query("SHOW COLUMNS FROM projects LIKE 'fetch_proxy_mode'");
        if (!c1.length) {
            await db.query(
                "ALTER TABLE projects ADD COLUMN fetch_proxy_mode VARCHAR(16) NOT NULL DEFAULT 'inherit'"
            );
        }
    } catch (_) {}
    try {
        const [c2] = await db.query("SHOW COLUMNS FROM projects LIKE 'fetch_proxy_enabled'");
        if (!c2.length) {
            await db.query(
                'ALTER TABLE projects ADD COLUMN fetch_proxy_enabled TINYINT NOT NULL DEFAULT 0'
            );
        }
    } catch (_) {}
    try {
        const [c3] = await db.query("SHOW COLUMNS FROM projects LIKE 'fetch_proxy_list'");
        if (!c3.length) {
            await db.query('ALTER TABLE projects ADD COLUMN fetch_proxy_list TEXT NULL');
        }
    } catch (_) {}
    try {
        await db.query(
            `UPDATE projects SET fetch_proxy_mode = 'inherit', fetch_proxy_enabled = 0, fetch_proxy_list = '' WHERE LOWER(TRIM(COALESCE(fetch_proxy_mode,''))) = 'custom'`
        );
    } catch (_) {}
    fetchProxyColsReady = true;
}

/**
 * Итоговые параметры прокси для загрузки страниц конкурента.
 * @param {Record<string, unknown> | null | undefined} projectRow
 * @param {{ fetch_proxy_enabled?: unknown, fetch_proxy_list?: unknown }} appSettings
 * @returns {{ enabled: boolean, list: string }}
 */
function resolveFetchProxy(projectRow, appSettings) {
    let mode = String(projectRow?.fetch_proxy_mode || 'inherit').toLowerCase();
    if (mode === 'custom') mode = 'inherit';
    const globEn = Number(appSettings?.fetch_proxy_enabled) === 1;
    const globList = String(appSettings?.fetch_proxy_list || '');
    if (mode === 'direct') {
        return { enabled: false, list: '' };
    }
    return { enabled: globEn, list: globList };
}

module.exports = { ensureProjectFetchProxyColumns, resolveFetchProxy };
