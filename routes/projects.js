const express = require('express');
const router = express.Router();

module.exports = (db) => {
    router.get('/', async (req, res) => {
        const sortBy = String(req.query.sort_by || 'id');
        const sortDir = String(req.query.sort_dir || 'desc').toLowerCase() === 'asc' ? 'ASC' : 'DESC';
        const sortFieldMap = {
            id: 'p.id',
            name: 'p.name',
            domain: 'p.domain',
            pages_count: 'pages_count',
            pending_count: 'pending_count',
            processing_count: 'processing_count',
            done_count: 'done_count',
            error_count: 'error_count'
        };
        const sortField = sortFieldMap[sortBy] || 'p.id';
        const [rows] = await db.query(`
            SELECT 
                p.*,
                COALESCE(ps.pages_count, 0) AS pages_count,
                COALESCE(ps.pending_count, 0) AS pending_count,
                COALESCE(ps.processing_count, 0) AS processing_count,
                COALESCE(ps.done_count, 0) AS done_count,
                COALESCE(ps.error_count, 0) AS error_count
            FROM projects p
            LEFT JOIN (
                SELECT
                    project_id,
                    COUNT(*) AS pages_count,
                    SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending_count,
                    SUM(CASE WHEN status = 'processing' THEN 1 ELSE 0 END) AS processing_count,
                    SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS done_count,
                    SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS error_count
                FROM pages
                GROUP BY project_id
            ) ps ON ps.project_id = p.id
            ORDER BY ${sortField} ${sortDir}
        `);
        res.json(rows);
    });

    router.post('/', async (req, res) => {
        const { name, domain, selector_price, selector_name, selector_sku, selector_oos } = req.body;
        const [r] = await db.query('INSERT INTO projects (name, domain, selector_price, selector_name, selector_sku, selector_oos) VALUES (?,?,?,?,?,?)', 
            [name, domain, selector_price, selector_name||'', selector_sku||'', selector_oos||'']);
        res.json({ success: true, id: r.insertId });
    });

    router.put('/:id', async (req, res) => {
        const { name, domain, selector_price, selector_name, selector_sku, selector_oos } = req.body;
        await db.query('UPDATE projects SET name=?, domain=?, selector_price=?, selector_name=?, selector_sku=?, selector_oos=? WHERE id=?', 
            [name, domain, selector_price, selector_name, selector_sku, selector_oos, req.params.id]);
        res.json({ success: true });
    });

    router.delete('/:id', async (req, res) => {
        await db.query('DELETE FROM projects WHERE id = ?', [req.params.id]);
        res.json({ success: true });
    });
    return router;
};