'use strict';

/**
 * Медмаркет — стыковка кода МС (code + тип) с кодом товара для Медмаркета.
 *
 * GET  /api/medmarket           — список (фильтры, пагинация, сортировка)
 * GET  /api/medmarket/sync-status — статус фонового обновления каталога из МС
 * POST /api/medmarket/sync        — подтянуть атрибут МС из ms_entity_details → ms_export
 * PATCH /api/medmarket/mapping    — записать атрибут «Код товара для медмаркета» в МойСклад + ms_export
 * POST /api/medmarket/import      — пакетный импорт стыковок JSON { rows: [...] }
 * POST /api/medmarket/fill-linkage-codes — заполнить коды `код+Тип` (фильтры как у GET /)
 */

const express = require('express');
const config = require('../config');
const {
    listMedmarketRows,
    upsertMedmarketMapping,
    syncMedmarketCatalogFromMsExport,
    importMedmarketMappings,
    fillMedmarketLinkageCodes,
    ensureMedmarketSchema,
} = require('../lib/medmarketStore');

const syncState = {
    active: false,
    message: 'Ожидание',
    processed: 0,
    total: 0,
    upserted: 0,
    started_at: null,
    finished_at: null,
    error: null,
};

async function runCatalogSync(db) {
    if (syncState.active) return { started: false, reason: 'already_running' };
    syncState.active = true;
    syncState.message = 'Подтягиваем «Код товара для медмаркета» из карточек МС…';
    syncState.processed = 0;
    syncState.total = 0;
    syncState.upserted = 0;
    syncState.started_at = new Date().toISOString();
    syncState.finished_at = null;
    syncState.error = null;
    try {
        const result = await syncMedmarketCatalogFromMsExport(db, {
            onProgress: (p) => {
                syncState.processed = Number(p.processed || 0);
                syncState.total = Number(p.total || 0);
                syncState.upserted = Number(p.upserted || 0);
                const pct =
                    syncState.total > 0
                        ? Math.min(100, Math.round((syncState.processed / syncState.total) * 100))
                        : 0;
                const all = Number(p.total_all || 0);
                const cand = Number(p.candidates || p.total || 0);
                const pending = Number(p.total || 0);
                const skip = Number(p.skipped_already || 0);
                syncState.message =
                    pending > 0
                        ? `Подтягивание атрибута: ${syncState.processed.toLocaleString('ru-RU')} / ${pending.toLocaleString('ru-RU')} осталось (${pct}%) · записано: ${syncState.upserted.toLocaleString('ru-RU')}${skip > 0 ? ` · уже в БД: ${skip.toLocaleString('ru-RU')}` : ''}`
                        : skip > 0
                          ? `Каталог актуален: в ms_export уже ${skip.toLocaleString('ru-RU')} из ${cand.toLocaleString('ru-RU')} с атрибутом в JSON`
                          : `Атрибут Медмаркет: ${syncState.processed} / ${syncState.total} (${pct}%), записано: ${syncState.upserted}`;
            },
        });
        const skipDone = Number(result.skipped_already || 0);
        syncState.message =
            result.pending === 0 && skipDone > 0
                ? `Готово: в ms_export уже актуально (${skipDone.toLocaleString('ru-RU')} позиций с атрибутом в JSON)`
                : result.candidates != null && result.candidates < result.total_ms
                  ? `Готово: записано ${result.written.toLocaleString('ru-RU')} из ${result.pending.toLocaleString('ru-RU')} оставшихся (всего с атрибутом ${result.candidates.toLocaleString('ru-RU')}, пропущено уже заполненных: ${skipDone.toLocaleString('ru-RU')})`
                  : `Готово: карточек ${result.total_ms}, с атрибутом ${result.upserted}`;
        syncState.finished_at = new Date().toISOString();
        return { started: true, result };
    } catch (e) {
        syncState.error = e && e.message ? e.message : String(e);
        syncState.message = `Ошибка: ${syncState.error}`;
        syncState.finished_at = new Date().toISOString();
        throw e;
    } finally {
        syncState.active = false;
    }
}

function medmarketRouterFactory(db) {
    const router = express.Router();

    router.get('/sync-status', async (req, res) => {
        try {
            res.json({
                success: true,
                active: syncState.active,
                message: syncState.message,
                processed: syncState.processed,
                total: syncState.total,
                upserted: syncState.upserted,
                started_at: syncState.started_at,
                finished_at: syncState.finished_at,
                error: syncState.error,
            });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message });
        }
    });

    router.post('/sync', async (req, res) => {
        try {
            if (syncState.active) {
                return res.json({ success: true, started: false, reason: 'already_running' });
            }
            runCatalogSync(db).catch((e) => {
                console.error('[medmarket][sync]', e);
            });
            res.json({ success: true, started: true });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message });
        }
    });

    router.get('/', async (req, res) => {
        try {
            await ensureMedmarketSchema(db);
            const body = await listMedmarketRows(db, req.query);
            res.json({ success: true, ...body });
        } catch (e) {
            console.error('[medmarket][list]', e);
            res.status(500).json({ success: false, error: e.message });
        }
    });

    router.patch('/mapping', async (req, res) => {
        try {
            const { code, item_type, medmarket_code } = req.body || {};
            const row = await upsertMedmarketMapping(db, config, { code, item_type, medmarket_code });
            res.json({ success: true, row });
        } catch (e) {
            const status =
                e.code === 'NOT_FOUND' ? 404 : e.code === 'NO_TOKEN' || e.code === 'ATTR_NOT_FOUND' ? 503 : 500;
            res.status(status).json({ success: false, error: e.message });
        }
    });

    router.post('/import', async (req, res) => {
        try {
            const rows = Array.isArray(req.body && req.body.rows) ? req.body.rows : [];
            const result = await importMedmarketMappings(db, config, rows);
            res.json({ success: true, ...result });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message });
        }
    });

    router.post('/fill-linkage-codes', async (req, res) => {
        try {
            await ensureMedmarketSchema(db);
            const dryRun =
                req.query.dry_run === '1'
                || req.query.dry_run === 'true'
                || (req.body && (req.body.dry_run === true || req.body.dry_run === 1));
            const result = await fillMedmarketLinkageCodes(db, config, req.query, { dry_run: dryRun });
            res.json({ success: true, ...result });
        } catch (e) {
            console.error('[medmarket][fill-linkage-codes]', e);
            res.status(500).json({ success: false, error: e.message });
        }
    });

    return router;
}

medmarketRouterFactory.triggerSync = async function triggerSync(db) {
    if (syncState.active) return { started: false, reason: 'already_running' };
    await runCatalogSync(db);
    return { started: true, finished: true };
};

medmarketRouterFactory.getSyncState = function getSyncState() {
    return { ...syncState };
};

module.exports = medmarketRouterFactory;
