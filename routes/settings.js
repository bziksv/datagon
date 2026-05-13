const express = require('express');
const fs = require('fs/promises');
const path = require('path');
const router = express.Router();

/** Пн=1…Вс=7; пустая строка — «каждый день» (legacy). Ровно семь дней храним как `1,2,3,4,5,6,7`, не как пусто — иначе после сохранения UI снова рисует «все дни» и «вс» «возвращается». */
function normalizeAutoSyncWeekdaysCsv(raw) {
    const s = String(raw ?? '').trim();
    if (!s) return '';
    const set = new Set();
    for (const part of s.split(/[,;\s]+/)) {
        const n = parseInt(String(part).trim(), 10);
        if (n >= 1 && n <= 7) set.add(n);
    }
    if (set.size === 0) return '';
    if (set.size === 7) return '1,2,3,4,5,6,7';
    return Array.from(set)
        .sort((a, b) => a - b)
        .join(',');
}

module.exports = (db, appSettings) => {
    async function ensureAutoSyncRunsTableLocal() {
        await db.query(`
            CREATE TABLE IF NOT EXISTS auto_sync_runs (
                id INT AUTO_INCREMENT PRIMARY KEY,
                task_type VARCHAR(30) NOT NULL,
                trigger_type VARCHAR(20) NOT NULL DEFAULT 'schedule',
                started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                finished_at TIMESTAMP NULL,
                status VARCHAR(20) NOT NULL DEFAULT 'running',
                message TEXT,
                INDEX idx_asr_started (started_at),
                INDEX idx_asr_task (task_type, started_at)
            )
        `);
    }

    router.get('/', async (req, res) => res.json(appSettings));

    router.post('/fetch-proxy', async (req, res) => {
        const { fetch_proxy_enabled, fetch_proxy_list } = req.body || {};
        try {
            const en = fetch_proxy_enabled ? 1 : 0;
            const list = String(fetch_proxy_list != null ? fetch_proxy_list : appSettings.fetch_proxy_list || '').slice(
                0,
                120000
            );
            await db.query(
                'INSERT INTO app_settings (setting_key, setting_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE setting_value=?',
                ['fetch_proxy_enabled', String(en), String(en)]
            );
            await db.query(
                'INSERT INTO app_settings (setting_key, setting_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE setting_value=?',
                ['fetch_proxy_list', list, list]
            );
            appSettings.fetch_proxy_enabled = en;
            appSettings.fetch_proxy_list = list;
            return res.json({ success: true });
        } catch (e) {
            return res.status(500).json({ error: e.message });
        }
    });

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
            default_limit, parse_batch_size, page_delay_ms, sync_batch_size, sync_delay_ms, sync_mode, log_retention_days, results_retention_days, ms_dimensions_log_retention_days, auto_sync_runs_retention_days,
            ms_sync_page_limit, ms_sync_delay_ms,
            auto_sync_myproducts_enabled, auto_sync_myproducts_time,
            auto_sync_moysklad_enabled, auto_sync_moysklad_time,
            auto_sync_marketplaces_enabled, auto_sync_marketplaces_time,
            auto_sync_huckster_enabled, auto_sync_huckster_time,
            auto_sync_db_size_enabled, auto_sync_db_size_time,
            auto_sync_dimensions_enabled, auto_sync_dimensions_time,
            auto_sync_mssales_enabled, auto_sync_mssales_time, auto_sync_mssales_days, auto_sync_mssales_weekdays,
            auto_sync_mssales_full_enabled, auto_sync_mssales_full_time, auto_sync_mssales_full_days, auto_sync_mssales_full_weekdays,
            discover_max_sitemaps, discover_max_urls, discover_crawl_max_pages, discover_request_delay_ms,
            auth_session_ttl_days, auth_session_user_limit, auth_online_presence_minutes,
            fetch_proxy_enabled, fetch_proxy_list,
            ozon_client_id, ozon_api_key, wb_api_key, wb_token_type, ym_api_key, ym_campaign_id, ym_business_id,
            mp_ozon_delay_ms, mp_wb_delay_cards_ms, mp_wb_delay_other_ms, mp_yandex_delay_ms, mp_ozon_include_archived,
            sales_formula_replenishment_coef, sales_formula_sales_window_days, sales_formula_absence_analysis_days,
            sales_formula_rare_base_qty, sales_formula_rare_avg_max, sales_formula_expensive_rare_threshold_rub,
            sales_formula_expensive_rare_min_qty, sales_formula_max_change_coef, sales_formula_incomplete_pack_pct,
            sales_formula_economy_enabled, sales_formula_economy_absence_window_days, sales_formula_economy_max_absence_pct,
            sales_formula_economy_target_cover_days
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
            if (ms_dimensions_log_retention_days !== undefined) queries.push(['ms_dimensions_log_retention_days', Number(ms_dimensions_log_retention_days || 180)]);
            if (auto_sync_runs_retention_days !== undefined) queries.push(['auto_sync_runs_retention_days', Number(auto_sync_runs_retention_days || 180)]);
            if (auto_sync_myproducts_enabled !== undefined) queries.push(['auto_sync_myproducts_enabled', auto_sync_myproducts_enabled ? 1 : 0]);
            if (auto_sync_myproducts_time !== undefined) queries.push(['auto_sync_myproducts_time', auto_sync_myproducts_time || '03:00']);
            if (auto_sync_moysklad_enabled !== undefined) queries.push(['auto_sync_moysklad_enabled', auto_sync_moysklad_enabled ? 1 : 0]);
            if (auto_sync_moysklad_time !== undefined) queries.push(['auto_sync_moysklad_time', auto_sync_moysklad_time || '04:00']);
            if (auto_sync_marketplaces_enabled !== undefined) queries.push(['auto_sync_marketplaces_enabled', auto_sync_marketplaces_enabled ? 1 : 0]);
            if (auto_sync_marketplaces_time !== undefined) queries.push(['auto_sync_marketplaces_time', auto_sync_marketplaces_time || '05:00']);
            if (auto_sync_huckster_enabled !== undefined) queries.push(['auto_sync_huckster_enabled', auto_sync_huckster_enabled ? 1 : 0]);
            if (auto_sync_huckster_time !== undefined) queries.push(['auto_sync_huckster_time', auto_sync_huckster_time || '06:00']);
            if (auto_sync_db_size_enabled !== undefined) queries.push(['auto_sync_db_size_enabled', auto_sync_db_size_enabled ? 1 : 0]);
            if (auto_sync_db_size_time !== undefined) queries.push(['auto_sync_db_size_time', auto_sync_db_size_time || '02:00']);
            if (auto_sync_dimensions_enabled !== undefined) queries.push(['auto_sync_dimensions_enabled', auto_sync_dimensions_enabled ? 1 : 0]);
            if (auto_sync_dimensions_time !== undefined) queries.push(['auto_sync_dimensions_time', auto_sync_dimensions_time || '21:00']);
            if (auto_sync_mssales_enabled !== undefined) queries.push(['auto_sync_mssales_enabled', auto_sync_mssales_enabled ? 1 : 0]);
            if (auto_sync_mssales_time !== undefined) queries.push(['auto_sync_mssales_time', auto_sync_mssales_time || '07:30']);
            if (auto_sync_mssales_days !== undefined) {
                /** Окно периода 1..1825 (5 лет) дней — как `clampInt` в /sync. */
                const v = Math.max(1, Math.min(365 * 5, Number(auto_sync_mssales_days || 90)));
                queries.push(['auto_sync_mssales_days', String(v)]);
            }
            if (auto_sync_mssales_weekdays !== undefined) {
                queries.push(['auto_sync_mssales_weekdays', normalizeAutoSyncWeekdaysCsv(auto_sync_mssales_weekdays)]);
            }
            if (auto_sync_mssales_full_enabled !== undefined) {
                queries.push(['auto_sync_mssales_full_enabled', auto_sync_mssales_full_enabled ? 1 : 0]);
            }
            if (auto_sync_mssales_full_time !== undefined) {
                queries.push(['auto_sync_mssales_full_time', auto_sync_mssales_full_time || '03:15']);
            }
            if (auto_sync_mssales_full_days !== undefined) {
                const vf = Math.max(1, Math.min(365 * 5, Number(auto_sync_mssales_full_days || 730)));
                queries.push(['auto_sync_mssales_full_days', String(vf)]);
            }
            if (auto_sync_mssales_full_weekdays !== undefined) {
                queries.push(['auto_sync_mssales_full_weekdays', normalizeAutoSyncWeekdaysCsv(auto_sync_mssales_full_weekdays)]);
            }
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
            if (fetch_proxy_enabled !== undefined) {
                queries.push(['fetch_proxy_enabled', fetch_proxy_enabled ? 1 : 0]);
            }
            if (fetch_proxy_list !== undefined) {
                queries.push(['fetch_proxy_list', String(fetch_proxy_list || '').slice(0, 120000)]);
            }
            if (ozon_client_id !== undefined) queries.push(['ozon_client_id', String(ozon_client_id || '').slice(0, 8000)]);
            if (ozon_api_key !== undefined) queries.push(['ozon_api_key', String(ozon_api_key || '').slice(0, 8000)]);
            if (wb_api_key !== undefined) queries.push(['wb_api_key', String(wb_api_key || '').slice(0, 8000)]);
            if (wb_token_type !== undefined) {
                const allowedTokenTypes = ['personal', 'service', 'base', 'test'];
                const norm = String(wb_token_type || 'base').trim().toLowerCase();
                queries.push(['wb_token_type', allowedTokenTypes.includes(norm) ? norm : 'base']);
            }
            if (ym_api_key !== undefined) queries.push(['ym_api_key', String(ym_api_key || '').slice(0, 8000)]);
            if (ym_campaign_id !== undefined) queries.push(['ym_campaign_id', String(ym_campaign_id || '').slice(0, 8000)]);
            if (ym_business_id !== undefined) queries.push(['ym_business_id', String(ym_business_id || '').slice(0, 8000)]);
            if (mp_ozon_delay_ms !== undefined) queries.push(['mp_ozon_delay_ms', Math.max(300, Number(mp_ozon_delay_ms || 400))]);
            if (mp_wb_delay_cards_ms !== undefined) queries.push(['mp_wb_delay_cards_ms', Math.max(350, Number(mp_wb_delay_cards_ms || 600))]);
            if (mp_wb_delay_other_ms !== undefined) queries.push(['mp_wb_delay_other_ms', Math.max(1000, Number(mp_wb_delay_other_ms || 1600))]);
            if (mp_yandex_delay_ms !== undefined) queries.push(['mp_yandex_delay_ms', Math.max(200, Number(mp_yandex_delay_ms || 280))]);
            if (mp_ozon_include_archived !== undefined) queries.push(['mp_ozon_include_archived', mp_ozon_include_archived ? 1 : 0]);

            if (sales_formula_replenishment_coef !== undefined) {
                const c = Number(sales_formula_replenishment_coef);
                const v = Number.isFinite(c) ? Math.max(0, Math.min(1000, c)) : 1 / 3;
                queries.push(['sales_formula_replenishment_coef', String(v)]);
            }
            if (sales_formula_sales_window_days !== undefined) {
                const w = Math.max(7, Math.min(730, Math.round(Number(sales_formula_sales_window_days || 90))));
                queries.push(['sales_formula_sales_window_days', String(w)]);
            }
            if (sales_formula_absence_analysis_days !== undefined) {
                const a = Math.max(7, Math.min(365 * 3, Math.round(Number(sales_formula_absence_analysis_days || 210))));
                queries.push(['sales_formula_absence_analysis_days', String(a)]);
            }
            if (sales_formula_rare_base_qty !== undefined) {
                queries.push(['sales_formula_rare_base_qty', String(Math.max(0, Math.round(Number(sales_formula_rare_base_qty || 0))))]);
            }
            if (sales_formula_rare_avg_max !== undefined) {
                const r = Number(sales_formula_rare_avg_max);
                queries.push(['sales_formula_rare_avg_max', String(Number.isFinite(r) && r >= 0 ? r : 1)]);
            }
            if (sales_formula_expensive_rare_threshold_rub !== undefined) {
                queries.push([
                    'sales_formula_expensive_rare_threshold_rub',
                    String(Math.max(0, Math.round(Number(sales_formula_expensive_rare_threshold_rub || 0)))),
                ]);
            }
            if (sales_formula_expensive_rare_min_qty !== undefined) {
                queries.push([
                    'sales_formula_expensive_rare_min_qty',
                    String(Math.max(0, Math.round(Number(sales_formula_expensive_rare_min_qty || 0)))),
                ]);
            }
            if (sales_formula_max_change_coef !== undefined) {
                const m = Number(sales_formula_max_change_coef);
                const mv = Number.isFinite(m) ? Math.max(1, Math.min(100, m)) : 1.6;
                queries.push(['sales_formula_max_change_coef', String(mv)]);
            }
            if (sales_formula_incomplete_pack_pct !== undefined) {
                const p = Number(sales_formula_incomplete_pack_pct);
                const pv = Number.isFinite(p) ? Math.max(0, Math.min(100, p)) : 10;
                queries.push(['sales_formula_incomplete_pack_pct', String(pv)]);
            }
            if (sales_formula_economy_enabled !== undefined) {
                queries.push(['sales_formula_economy_enabled', sales_formula_economy_enabled ? 1 : 0]);
            }
            if (sales_formula_economy_absence_window_days !== undefined) {
                const e = Math.max(7, Math.min(730, Math.round(Number(sales_formula_economy_absence_window_days || 90))));
                queries.push(['sales_formula_economy_absence_window_days', String(e)]);
            }
            if (sales_formula_economy_max_absence_pct !== undefined) {
                const ep = Number(sales_formula_economy_max_absence_pct);
                const epv = Number.isFinite(ep) ? Math.max(0, Math.min(100, ep)) : 6;
                queries.push(['sales_formula_economy_max_absence_pct', String(epv)]);
            }
            if (sales_formula_economy_target_cover_days !== undefined) {
                const t = Math.max(1, Math.min(365, Math.round(Number(sales_formula_economy_target_cover_days || 18))));
                queries.push(['sales_formula_economy_target_cover_days', String(t)]);
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
            if(ms_dimensions_log_retention_days !== undefined) appSettings.ms_dimensions_log_retention_days = parseInt(ms_dimensions_log_retention_days);
            if(auto_sync_runs_retention_days !== undefined) appSettings.auto_sync_runs_retention_days = parseInt(auto_sync_runs_retention_days);
            if(auto_sync_myproducts_enabled !== undefined) appSettings.auto_sync_myproducts_enabled = auto_sync_myproducts_enabled ? 1 : 0;
            if(auto_sync_myproducts_time !== undefined) appSettings.auto_sync_myproducts_time = auto_sync_myproducts_time || '03:00';
            if(auto_sync_moysklad_enabled !== undefined) appSettings.auto_sync_moysklad_enabled = auto_sync_moysklad_enabled ? 1 : 0;
            if(auto_sync_moysklad_time !== undefined) appSettings.auto_sync_moysklad_time = auto_sync_moysklad_time || '04:00';
            if(auto_sync_marketplaces_enabled !== undefined) appSettings.auto_sync_marketplaces_enabled = auto_sync_marketplaces_enabled ? 1 : 0;
            if(auto_sync_marketplaces_time !== undefined) appSettings.auto_sync_marketplaces_time = auto_sync_marketplaces_time || '05:00';
            if(auto_sync_huckster_enabled !== undefined) appSettings.auto_sync_huckster_enabled = auto_sync_huckster_enabled ? 1 : 0;
            if(auto_sync_huckster_time !== undefined) appSettings.auto_sync_huckster_time = auto_sync_huckster_time || '06:00';
            if(auto_sync_db_size_enabled !== undefined) appSettings.auto_sync_db_size_enabled = auto_sync_db_size_enabled ? 1 : 0;
            if(auto_sync_db_size_time !== undefined) appSettings.auto_sync_db_size_time = auto_sync_db_size_time || '02:00';
            if(auto_sync_dimensions_enabled !== undefined) appSettings.auto_sync_dimensions_enabled = auto_sync_dimensions_enabled ? 1 : 0;
            if(auto_sync_dimensions_time !== undefined) appSettings.auto_sync_dimensions_time = auto_sync_dimensions_time || '21:00';
            if(auto_sync_mssales_enabled !== undefined) appSettings.auto_sync_mssales_enabled = auto_sync_mssales_enabled ? 1 : 0;
            if(auto_sync_mssales_time !== undefined) appSettings.auto_sync_mssales_time = auto_sync_mssales_time || '07:30';
            if(auto_sync_mssales_days !== undefined) appSettings.auto_sync_mssales_days = Math.max(1, Math.min(365 * 5, Number(auto_sync_mssales_days || 90)));
            if(auto_sync_mssales_weekdays !== undefined) appSettings.auto_sync_mssales_weekdays = normalizeAutoSyncWeekdaysCsv(auto_sync_mssales_weekdays);
            if(auto_sync_mssales_full_enabled !== undefined) appSettings.auto_sync_mssales_full_enabled = auto_sync_mssales_full_enabled ? 1 : 0;
            if(auto_sync_mssales_full_time !== undefined) appSettings.auto_sync_mssales_full_time = auto_sync_mssales_full_time || '03:15';
            if(auto_sync_mssales_full_days !== undefined) appSettings.auto_sync_mssales_full_days = Math.max(1, Math.min(365 * 5, Number(auto_sync_mssales_full_days || 730)));
            if(auto_sync_mssales_full_weekdays !== undefined) appSettings.auto_sync_mssales_full_weekdays = normalizeAutoSyncWeekdaysCsv(auto_sync_mssales_full_weekdays);
            if(discover_max_sitemaps !== undefined) appSettings.discover_max_sitemaps = Math.max(10, Number(discover_max_sitemaps || 200));
            if(discover_max_urls !== undefined) appSettings.discover_max_urls = Math.max(100, Number(discover_max_urls || 50000));
            if(discover_crawl_max_pages !== undefined) appSettings.discover_crawl_max_pages = Math.max(10, Number(discover_crawl_max_pages || 500));
            if(discover_request_delay_ms !== undefined) appSettings.discover_request_delay_ms = Math.max(0, Number(discover_request_delay_ms || 100));
            if(auth_session_ttl_days !== undefined) appSettings.auth_session_ttl_days = Math.max(1, Number(auth_session_ttl_days || 14));
            if(auth_session_user_limit !== undefined) appSettings.auth_session_user_limit = Math.max(1, Number(auth_session_user_limit || 1));
            if(auth_online_presence_minutes !== undefined) {
                appSettings.auth_online_presence_minutes = Math.max(1, Math.min(24 * 60, Number(auth_online_presence_minutes || 15)));
            }
            if (fetch_proxy_enabled !== undefined) appSettings.fetch_proxy_enabled = fetch_proxy_enabled ? 1 : 0;
            if (fetch_proxy_list !== undefined) appSettings.fetch_proxy_list = String(fetch_proxy_list || '').slice(0, 120000);
            if (ozon_client_id !== undefined) appSettings.ozon_client_id = String(ozon_client_id || '').slice(0, 8000);
            if (ozon_api_key !== undefined) appSettings.ozon_api_key = String(ozon_api_key || '').slice(0, 8000);
            if (wb_api_key !== undefined) appSettings.wb_api_key = String(wb_api_key || '').slice(0, 8000);
            if (wb_token_type !== undefined) {
                const allowedTokenTypes = ['personal', 'service', 'base', 'test'];
                const norm = String(wb_token_type || 'base').trim().toLowerCase();
                appSettings.wb_token_type = allowedTokenTypes.includes(norm) ? norm : 'base';
            }
            if (ym_api_key !== undefined) appSettings.ym_api_key = String(ym_api_key || '').slice(0, 8000);
            if (ym_campaign_id !== undefined) appSettings.ym_campaign_id = String(ym_campaign_id || '').slice(0, 8000);
            if (ym_business_id !== undefined) appSettings.ym_business_id = String(ym_business_id || '').slice(0, 8000);
            if (mp_ozon_delay_ms !== undefined) appSettings.mp_ozon_delay_ms = Math.max(300, Number(mp_ozon_delay_ms || 400));
            if (mp_wb_delay_cards_ms !== undefined) appSettings.mp_wb_delay_cards_ms = Math.max(350, Number(mp_wb_delay_cards_ms || 600));
            if (mp_wb_delay_other_ms !== undefined) appSettings.mp_wb_delay_other_ms = Math.max(1000, Number(mp_wb_delay_other_ms || 1600));
            if (mp_yandex_delay_ms !== undefined) appSettings.mp_yandex_delay_ms = Math.max(200, Number(mp_yandex_delay_ms || 280));
            if (mp_ozon_include_archived !== undefined) appSettings.mp_ozon_include_archived = mp_ozon_include_archived ? 1 : 0;

            if (sales_formula_replenishment_coef !== undefined) {
                const c = Number(sales_formula_replenishment_coef);
                appSettings.sales_formula_replenishment_coef = Number.isFinite(c) ? Math.max(0, Math.min(1000, c)) : 1 / 3;
            }
            if (sales_formula_sales_window_days !== undefined) {
                appSettings.sales_formula_sales_window_days = Math.max(7, Math.min(730, Math.round(Number(sales_formula_sales_window_days || 90))));
            }
            if (sales_formula_absence_analysis_days !== undefined) {
                appSettings.sales_formula_absence_analysis_days = Math.max(7, Math.min(365 * 3, Math.round(Number(sales_formula_absence_analysis_days || 210))));
            }
            if (sales_formula_rare_base_qty !== undefined) {
                appSettings.sales_formula_rare_base_qty = Math.max(0, Math.round(Number(sales_formula_rare_base_qty || 0)));
            }
            if (sales_formula_rare_avg_max !== undefined) {
                const r = Number(sales_formula_rare_avg_max);
                appSettings.sales_formula_rare_avg_max = Number.isFinite(r) && r >= 0 ? r : 1;
            }
            if (sales_formula_expensive_rare_threshold_rub !== undefined) {
                appSettings.sales_formula_expensive_rare_threshold_rub = Math.max(0, Math.round(Number(sales_formula_expensive_rare_threshold_rub || 0)));
            }
            if (sales_formula_expensive_rare_min_qty !== undefined) {
                appSettings.sales_formula_expensive_rare_min_qty = Math.max(0, Math.round(Number(sales_formula_expensive_rare_min_qty || 0)));
            }
            if (sales_formula_max_change_coef !== undefined) {
                const m = Number(sales_formula_max_change_coef);
                appSettings.sales_formula_max_change_coef = Number.isFinite(m) ? Math.max(1, Math.min(100, m)) : 1.6;
            }
            if (sales_formula_incomplete_pack_pct !== undefined) {
                const p = Number(sales_formula_incomplete_pack_pct);
                appSettings.sales_formula_incomplete_pack_pct = Number.isFinite(p) ? Math.max(0, Math.min(100, p)) : 10;
            }
            if (sales_formula_economy_enabled !== undefined) appSettings.sales_formula_economy_enabled = sales_formula_economy_enabled ? 1 : 0;
            if (sales_formula_economy_absence_window_days !== undefined) {
                appSettings.sales_formula_economy_absence_window_days = Math.max(7, Math.min(730, Math.round(Number(sales_formula_economy_absence_window_days || 90))));
            }
            if (sales_formula_economy_max_absence_pct !== undefined) {
                const ep = Number(sales_formula_economy_max_absence_pct);
                appSettings.sales_formula_economy_max_absence_pct = Number.isFinite(ep) ? Math.max(0, Math.min(100, ep)) : 6;
            }
            if (sales_formula_economy_target_cover_days !== undefined) {
                appSettings.sales_formula_economy_target_cover_days = Math.max(1, Math.min(365, Math.round(Number(sales_formula_economy_target_cover_days || 18))));
            }

            res.json({ success: true });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    router.get('/auto-sync-runs/stats', async (_req, res) => {
        try {
            await ensureAutoSyncRunsTableLocal();
            const retention = Number(appSettings.auto_sync_runs_retention_days || 180);
            const [totRows] = await db.query(
                `SELECT COUNT(*) AS total,
                        MIN(started_at) AS oldest_started,
                        MAX(started_at) AS newest_started,
                        COALESCE(SUM(CASE WHEN finished_at IS NULL THEN 1 ELSE 0 END), 0) AS open_runs
                 FROM auto_sync_runs`
            );
            const tot = (totRows && totRows[0]) || {};
            const [taskRows] = await db.query(
                `SELECT task_type, COUNT(*) AS n FROM auto_sync_runs GROUP BY task_type ORDER BY task_type`
            );
            const byTask = {};
            (taskRows || []).forEach((r) => {
                byTask[String(r.task_type || '')] = Number(r.n || 0);
            });
            let olderThanRetention = 0;
            if (retention > 0) {
                const [oldRows] = await db.query(
                    `SELECT COUNT(*) AS n FROM auto_sync_runs
                     WHERE finished_at IS NOT NULL
                       AND finished_at < (NOW() - INTERVAL ? DAY)`,
                    [retention]
                );
                olderThanRetention = Number((oldRows && oldRows[0] && oldRows[0].n) || 0);
            }
            return res.json({
                success: true,
                total: Number(tot.total || 0),
                oldest_started_at: tot.oldest_started ? new Date(tot.oldest_started).toISOString() : null,
                newest_started_at: tot.newest_started ? new Date(tot.newest_started).toISOString() : null,
                open_running: Number(tot.open_runs || 0),
                by_task: byTask,
                retention_days: retention,
                older_than_retention: olderThanRetention,
            });
        } catch (e) {
            return res.status(500).json({
                success: false,
                error: e && e.message ? e.message : 'Не удалось получить статистику auto_sync_runs',
            });
        }
    });

    router.post('/auto-sync-runs/cleanup', async (req, res) => {
        try {
            await ensureAutoSyncRunsTableLocal();
            const body = req.body || {};
            const reqDays = body.days != null ? Number(body.days) : null;
            const defaultDays = Number(appSettings.auto_sync_runs_retention_days || 180);
            const days = Number.isFinite(reqDays) && reqDays > 0 ? Math.floor(reqDays) : defaultDays;
            if (days <= 0) {
                return res.status(400).json({ success: false, error: 'Некорректный retention (days <= 0)' });
            }
            const [r] = await db.query(
                `DELETE FROM auto_sync_runs
                 WHERE finished_at IS NOT NULL
                   AND finished_at < (NOW() - INTERVAL ? DAY)`,
                [days]
            );
            return res.json({
                success: true,
                deleted: Number((r && r.affectedRows) || 0),
                days,
            });
        } catch (e) {
            return res.status(500).json({
                success: false,
                error: e && e.message ? e.message : 'Не удалось очистить auto_sync_runs',
            });
        }
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