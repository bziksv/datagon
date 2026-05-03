const express = require('express');
const fs = require('fs/promises');
const path = require('path');
const router = express.Router();

module.exports = (db, appSettings) => {
    router.get('/', async (req, res) => res.json(appSettings));

    router.post('/sync-myproducts', async (req, res) => {
        const { sync_batch_size, sync_delay_ms, sync_mode } = req.body || {};
        try {
            const batch = Number(sync_batch_size || 500);
            const delay = Number(sync_delay_ms || 2000);
            const mode = String(sync_mode || appSettings.sync_mode || 'always');
            const modeSafe = mode === 'once' ? 'once' : 'always';
            const queries = [
                ['sync_batch_size', batch],
                ['sync_delay_ms', delay],
                ['sync_mode', modeSafe]
            ];
            for (const [key, val] of queries) {
                await db.query(
                    'INSERT INTO app_settings (setting_key, setting_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE setting_value=?',
                    [key, val, val]
                );
            }
            appSettings.sync_batch_size = batch;
            appSettings.sync_delay_ms = delay;
            appSettings.sync_mode = modeSafe;
            return res.json({ success: true });
        } catch (e) {
            return res.status(500).json({ error: e.message });
        }
    });

    router.post('/sync-moysklad', async (req, res) => {
        const { ms_sync_page_limit, ms_sync_delay_ms } = req.body || {};
        try {
            const pageLimit = Math.max(100, Math.min(Number(ms_sync_page_limit || 1000), 5000));
            const delayMs = Math.max(0, Number(ms_sync_delay_ms || 0));
            const queries = [
                ['ms_sync_page_limit', pageLimit],
                ['ms_sync_delay_ms', delayMs]
            ];
            for (const [key, val] of queries) {
                await db.query(
                    'INSERT INTO app_settings (setting_key, setting_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE setting_value=?',
                    [key, val, val]
                );
            }
            appSettings.ms_sync_page_limit = pageLimit;
            appSettings.ms_sync_delay_ms = delayMs;
            return res.json({ success: true });
        } catch (e) {
            return res.status(500).json({ error: e.message });
        }
    });
    
    router.post('/', async (req, res) => {
        const {
            default_limit, parse_batch_size, page_delay_ms, sync_batch_size, sync_delay_ms, sync_mode, log_retention_days, results_retention_days,
            ms_sync_page_limit, ms_sync_delay_ms,
            auto_sync_myproducts_enabled, auto_sync_myproducts_time,
            auto_sync_moysklad_enabled, auto_sync_moysklad_time,
            discover_max_sitemaps, discover_max_urls, discover_crawl_max_pages, discover_request_delay_ms,
            auth_session_ttl_days, auth_session_user_limit, auth_online_presence_minutes
        } = req.body;
        try {
            const queries = [];
            if (default_limit !== undefined) queries.push(['default_limit', Number(default_limit || 100)]);
            if (parse_batch_size !== undefined) queries.push(['parse_batch_size', Number(parse_batch_size || 50)]);
            if (page_delay_ms !== undefined) queries.push(['page_delay_ms', Number(page_delay_ms || 0)]);
            if (sync_batch_size !== undefined) queries.push(['sync_batch_size', Number(sync_batch_size || 500)]);
            if (sync_delay_ms !== undefined) queries.push(['sync_delay_ms', Number(sync_delay_ms || 2000)]);
            if (ms_sync_page_limit !== undefined) queries.push(['ms_sync_page_limit', Number(ms_sync_page_limit || 1000)]);
            if (ms_sync_delay_ms !== undefined) queries.push(['ms_sync_delay_ms', Number(ms_sync_delay_ms || 0)]);
            if (log_retention_days !== undefined) queries.push(['log_retention_days', Number(log_retention_days || 7)]);
            if (results_retention_days !== undefined) queries.push(['results_retention_days', Number(results_retention_days || 120)]);
            if (auto_sync_myproducts_enabled !== undefined) queries.push(['auto_sync_myproducts_enabled', auto_sync_myproducts_enabled ? 1 : 0]);
            if (auto_sync_myproducts_time !== undefined) queries.push(['auto_sync_myproducts_time', auto_sync_myproducts_time || '03:00']);
            if (auto_sync_moysklad_enabled !== undefined) queries.push(['auto_sync_moysklad_enabled', auto_sync_moysklad_enabled ? 1 : 0]);
            if (auto_sync_moysklad_time !== undefined) queries.push(['auto_sync_moysklad_time', auto_sync_moysklad_time || '04:00']);
            if (discover_max_sitemaps !== undefined) queries.push(['discover_max_sitemaps', Math.max(10, Number(discover_max_sitemaps || 200))]);
            if (discover_max_urls !== undefined) queries.push(['discover_max_urls', Math.max(100, Number(discover_max_urls || 50000))]);
            if (discover_crawl_max_pages !== undefined) queries.push(['discover_crawl_max_pages', Math.max(10, Number(discover_crawl_max_pages || 500))]);
            if (discover_request_delay_ms !== undefined) queries.push(['discover_request_delay_ms', Math.max(0, Number(discover_request_delay_ms || 100))]);
            if (auth_session_ttl_days !== undefined) queries.push(['auth_session_ttl_days', Math.max(1, Number(auth_session_ttl_days || 14))]);
            if (auth_session_user_limit !== undefined) queries.push(['auth_session_user_limit', Math.max(1, Number(auth_session_user_limit || 1))]);
            if (auth_online_presence_minutes !== undefined) {
                queries.push([
                    'auth_online_presence_minutes',
                    Math.max(1, Math.min(24 * 60, Number(auth_online_presence_minutes || 15)))
                ]);
            }
            
            for (const [key, val] of queries) {
                await db.query('INSERT INTO app_settings (setting_key, setting_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE setting_value=?', [key, val, val]);
            }
            if (sync_mode) {
                await db.query('INSERT INTO app_settings (setting_key, setting_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE setting_value=?', ['sync_mode', sync_mode, sync_mode]);
            }

            // Обновляем глобальный кэш
            if(default_limit !== undefined) appSettings.default_limit = parseInt(default_limit);
            if(parse_batch_size !== undefined) appSettings.parse_batch_size = parseInt(parse_batch_size);
            if(page_delay_ms !== undefined) appSettings.page_delay_ms = parseInt(page_delay_ms);
            if(sync_batch_size !== undefined) appSettings.sync_batch_size = parseInt(sync_batch_size);
            if(sync_delay_ms !== undefined) appSettings.sync_delay_ms = parseInt(sync_delay_ms);
            if(ms_sync_page_limit !== undefined) appSettings.ms_sync_page_limit = parseInt(ms_sync_page_limit);
            if(ms_sync_delay_ms !== undefined) appSettings.ms_sync_delay_ms = parseInt(ms_sync_delay_ms || 0);
            if(sync_mode) appSettings.sync_mode = sync_mode;
            if(log_retention_days !== undefined) appSettings.log_retention_days = parseInt(log_retention_days);
            if(results_retention_days !== undefined) appSettings.results_retention_days = parseInt(results_retention_days);
            if(auto_sync_myproducts_enabled !== undefined) appSettings.auto_sync_myproducts_enabled = auto_sync_myproducts_enabled ? 1 : 0;
            if(auto_sync_myproducts_time !== undefined) appSettings.auto_sync_myproducts_time = auto_sync_myproducts_time || '03:00';
            if(auto_sync_moysklad_enabled !== undefined) appSettings.auto_sync_moysklad_enabled = auto_sync_moysklad_enabled ? 1 : 0;
            if(auto_sync_moysklad_time !== undefined) appSettings.auto_sync_moysklad_time = auto_sync_moysklad_time || '04:00';
            if(discover_max_sitemaps !== undefined) appSettings.discover_max_sitemaps = Math.max(10, Number(discover_max_sitemaps || 200));
            if(discover_max_urls !== undefined) appSettings.discover_max_urls = Math.max(100, Number(discover_max_urls || 50000));
            if(discover_crawl_max_pages !== undefined) appSettings.discover_crawl_max_pages = Math.max(10, Number(discover_crawl_max_pages || 500));
            if(discover_request_delay_ms !== undefined) appSettings.discover_request_delay_ms = Math.max(0, Number(discover_request_delay_ms || 100));
            if(auth_session_ttl_days !== undefined) appSettings.auth_session_ttl_days = Math.max(1, Number(auth_session_ttl_days || 14));
            if(auth_session_user_limit !== undefined) appSettings.auth_session_user_limit = Math.max(1, Number(auth_session_user_limit || 1));
            if(auth_online_presence_minutes !== undefined) {
                appSettings.auth_online_presence_minutes = Math.max(1, Math.min(24 * 60, Number(auth_online_presence_minutes || 15)));
            }

            res.json({ success: true });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    router.get('/logs-info', async (_req, res) => {
        try {
            const logs = [path.join(__dirname, '..', 'server.log'), path.join(__dirname, '..', 'worker.log')];
            const out = [];
            for (const file of logs) {
                try {
                    const stat = await fs.stat(file);
                    out.push({
                        name: path.basename(file),
                        size_bytes: stat.size,
                        modified_at: stat.mtime
                    });
                } catch (_) {
                    out.push({
                        name: path.basename(file),
                        size_bytes: 0,
                        modified_at: null
                    });
                }
            }
            res.json({ data: out });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    router.post('/logs-clear', async (_req, res) => {
        try {
            const logs = [path.join(__dirname, '..', 'server.log'), path.join(__dirname, '..', 'worker.log')];
            for (const file of logs) {
                try {
                    await fs.writeFile(file, '', 'utf8');
                } catch (_) {
                    // Ignore missing files.
                }
            }
            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    return router;
};