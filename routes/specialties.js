const express = require('express');
const { PAGE_DEFS } = require('../lib/datagonPageRegistry');
const datagonSpecialties = require('../lib/datagonSpecialties');

module.exports = (db) => {
    const router = express.Router();

    async function requireAdmin(req, res, next) {
        try {
            const actor = req.datagonActor;
            if (!actor) return res.status(401).json({ error: 'Не авторизован' });
            if (actor.username !== 'admin') return res.status(403).json({ error: 'Только admin' });
            return next();
        } catch (e) {
            return res.status(500).json({ error: e.message });
        }
    }

    router.use(requireAdmin);

    router.get('/', async (_req, res) => {
        try {
            const data = await datagonSpecialties.listSpecialties(db);
            return res.json({ data });
        } catch (e) {
            return res.status(500).json({ error: e.message });
        }
    });

    router.get('/pages', async (_req, res) => {
        try {
            return res.json({ data: PAGE_DEFS });
        } catch (e) {
            return res.status(500).json({ error: e.message });
        }
    });

    router.post('/', async (req, res) => {
        try {
            const id = await datagonSpecialties.createSpecialty(db, req.body?.name);
            const modes = await datagonSpecialties.getPageModesForSpecialty(db, id);
            return res.json({ success: true, id, modes });
        } catch (e) {
            return res.status(400).json({ error: e.message });
        }
    });

    router.put('/:id', async (req, res) => {
        try {
            const id = parseInt(req.params.id, 10);
            if (!Number.isFinite(id)) return res.status(400).json({ error: 'Некорректный id' });
            await datagonSpecialties.renameSpecialty(db, id, req.body?.name);
            return res.json({ success: true });
        } catch (e) {
            return res.status(400).json({ error: e.message });
        }
    });

    router.delete('/:id', async (req, res) => {
        try {
            const id = parseInt(req.params.id, 10);
            if (!Number.isFinite(id)) return res.status(400).json({ error: 'Некорректный id' });
            await datagonSpecialties.deleteSpecialty(db, id);
            return res.json({ success: true });
        } catch (e) {
            return res.status(400).json({ error: e.message });
        }
    });

    router.get('/:id/access', async (req, res) => {
        try {
            const id = parseInt(req.params.id, 10);
            if (!Number.isFinite(id)) return res.status(400).json({ error: 'Некорректный id' });
            const modes = await datagonSpecialties.getPageModesForSpecialty(db, id);
            return res.json({ modes });
        } catch (e) {
            return res.status(500).json({ error: e.message });
        }
    });

    router.put('/:id/access', async (req, res) => {
        try {
            const id = parseInt(req.params.id, 10);
            if (!Number.isFinite(id)) return res.status(400).json({ error: 'Некорректный id' });
            await datagonSpecialties.setSpecialtyModes(db, id, req.body?.modes || {});
            const modes = await datagonSpecialties.getPageModesForSpecialty(db, id);
            return res.json({ success: true, modes });
        } catch (e) {
            return res.status(400).json({ error: e.message });
        }
    });

    return router;
};
