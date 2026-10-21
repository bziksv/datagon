'use strict';

/**
 * API «Заказы поставщикам» — entity/purchaseorder → ms_purchase_order.
 */

const express = require('express');
const mpo = require('../lib/datagonMsPurchaseOrders');

function createMsPurchaseOrdersRouter(db, appSettings) {
    const router = express.Router();

    router.get('/sync-status', (_req, res) => {
        res.json({ success: true, ...mpo.getSyncState() });
    });

    router.post('/sync', async (req, res) => {
        try {
            let cfg = null;
            try {
                cfg = require('../config');
            } catch (e) {
                cfg = null;
            }
            const result = await mpo.triggerSync(db, appSettings, { config: cfg });
            if (!result.started) {
                return res.status(result.reason === 'already_running' ? 409 : 400).json({
                    success: false,
                    reason: result.reason,
                    error: result.error || result.reason,
                    status: result.status,
                });
            }
            res.json({ success: true, started: true, status: result.status });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message || String(e) });
        }
    });

    router.post('/sync-cancel', (_req, res) => {
        mpo.requestCancel();
        res.json({ success: true, status: mpo.getSyncState() });
    });

    router.get('/list', async (req, res) => {
        try {
            const out = await mpo.listPurchaseOrders(db, req.query || {});
            res.json(out);
        } catch (e) {
            res.status(500).json({ success: false, error: e.message || String(e) });
        }
    });

    router.get('/filters', async (_req, res) => {
        try {
            const opts = await mpo.listFilterOptions(db);
            res.json({
                success: true,
                ...opts,
                presets: {
                    A: {
                        label: 'Едет целиком (оплачено, не принято)',
                        pay_status: 'paid',
                        ship_status: 'unshipped',
                        store_uuids: mpo.DEFAULT_STORE_A.slice(),
                    },
                    B: {
                        label: 'Недопринято (оплачено, частично)',
                        pay_status: 'paid',
                        ship_status: 'partial',
                        store_uuids: mpo.DEFAULT_STORE_B.slice(),
                        state_uuids: mpo.DEFAULT_STATE_B.slice(),
                    },
                },
                sync_from: mpo.getSyncFromYmd(appSettings),
                sync_script: mpo.getMsPurchaseOrdersSyncMeta(),
            });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message || String(e) });
        }
    });

    router.get('/stats', async (_req, res) => {
        try {
            const buckets = await mpo.computePrepaidBuckets(db);
            res.json({ success: true, ...buckets });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message || String(e) });
        }
    });

    return router;
}

module.exports = {
    createMsPurchaseOrdersRouter,
    getSyncState: mpo.getSyncState,
    triggerSync: mpo.triggerSync,
    requestCancel: mpo.requestCancel,
};
