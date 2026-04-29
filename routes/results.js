const express = require('express');
const router = express.Router();

module.exports = (db, settings) => {
    // 1. Получить результаты
    router.get('/', async (req, res) => {
        try {
            const { project_id, page_status, search, matched, availability, limit, offset, sort_by, sort_dir } = req.query;
            const l = parseInt(limit) || (settings.default_limit || 100);
            const o = parseInt(offset) || 0;
            const sortDir = String(sort_dir || 'desc').toLowerCase() === 'asc' ? 'ASC' : 'DESC';
            const sortFieldMap = {
                parsed_at: 'pr.parsed_at',
                page_parsed_at: 'pg.parsed_at',
                project_name: 'p.name',
                product_name: 'pr.product_name',
                sku: 'pr.sku',
                page_status: 'pg.status',
                is_oos: 'pr.is_oos',
                price: 'pr.price',
                url: 'pr.url'
            };
            const sortField = sortFieldMap[String(sort_by || 'parsed_at')] || 'pr.parsed_at';
            
            let q = `SELECT pr.*, p.name as project_name, pg.url as page_url,
                           pg.status as page_status, pg.last_error as page_error, pg.parsed_at as page_parsed_at,
                           EXISTS(
                               SELECT 1
                               FROM product_matches pm
                               WHERE pm.status = 'confirmed'
                                 AND pm.competitor_site_id = pr.project_id
                                 AND (
                                     (pm.competitor_sku IS NOT NULL AND pm.competitor_sku <> '' AND pm.competitor_sku = pr.sku)
                                     OR pm.competitor_name = pr.product_name
                                 )
                               LIMIT 1
                           ) AS is_matched
                     FROM prices pr 
                     JOIN projects p ON pr.project_id = p.id 
                     LEFT JOIN pages pg ON pr.page_id = pg.id 
                     WHERE 1=1`;
            let qc = `SELECT COUNT(*) as total FROM prices pr WHERE 1=1`;
            let p = [], pc = [];
            
            if (project_id && project_id !== 'all') { 
                q += ' AND pr.project_id = ?'; 
                qc += ' AND pr.project_id = ?'; 
                p.push(project_id); 
                pc.push(project_id); 
            }
            if (page_status && ['pending', 'processing', 'done', 'error'].includes(String(page_status).toLowerCase())) {
                const pageStatus = String(page_status).toLowerCase();
                q += ' AND pg.status = ?';
                qc += ' AND EXISTS (SELECT 1 FROM pages pgs WHERE pgs.id = pr.page_id AND pgs.status = ?)';
                p.push(pageStatus);
                pc.push(pageStatus);
            }

            if (search && String(search).trim()) {
                const val = `%${String(search).trim()}%`;
                q += ' AND (pr.sku LIKE ? OR pr.product_name LIKE ?)';
                qc += ' AND (pr.sku LIKE ? OR pr.product_name LIKE ?)';
                p.push(val, val);
                pc.push(val, val);
            }
            if (availability === 'in_stock') {
                q += ' AND COALESCE(pr.is_oos, 0) = 0';
                qc += ' AND COALESCE(pr.is_oos, 0) = 0';
            } else if (availability === 'oos') {
                q += ' AND COALESCE(pr.is_oos, 0) = 1';
                qc += ' AND COALESCE(pr.is_oos, 0) = 1';
            }
            if (matched === '1') {
                q += ` AND EXISTS(
                    SELECT 1
                    FROM product_matches pm
                    WHERE pm.status = 'confirmed'
                      AND pm.competitor_site_id = pr.project_id
                      AND (
                        (pm.competitor_sku IS NOT NULL AND pm.competitor_sku <> '' AND pm.competitor_sku = pr.sku)
                        OR pm.competitor_name = pr.product_name
                      )
                    LIMIT 1
                )`;
                qc += ` AND EXISTS(
                    SELECT 1
                    FROM product_matches pm
                    WHERE pm.status = 'confirmed'
                      AND pm.competitor_site_id = pr.project_id
                      AND (
                        (pm.competitor_sku IS NOT NULL AND pm.competitor_sku <> '' AND pm.competitor_sku = pr.sku)
                        OR pm.competitor_name = pr.product_name
                      )
                    LIMIT 1
                )`;
            } else if (matched === '0') {
                q += ` AND NOT EXISTS(
                    SELECT 1
                    FROM product_matches pm
                    WHERE pm.status = 'confirmed'
                      AND pm.competitor_site_id = pr.project_id
                      AND (
                        (pm.competitor_sku IS NOT NULL AND pm.competitor_sku <> '' AND pm.competitor_sku = pr.sku)
                        OR pm.competitor_name = pr.product_name
                      )
                    LIMIT 1
                )`;
                qc += ` AND NOT EXISTS(
                    SELECT 1
                    FROM product_matches pm
                    WHERE pm.status = 'confirmed'
                      AND pm.competitor_site_id = pr.project_id
                      AND (
                        (pm.competitor_sku IS NOT NULL AND pm.competitor_sku <> '' AND pm.competitor_sku = pr.sku)
                        OR pm.competitor_name = pr.product_name
                      )
                    LIMIT 1
                )`;
            }
            
            q += ` ORDER BY ${sortField} ${sortDir}, pr.id DESC LIMIT ? OFFSET ?`; 
            p.push(l, o);
            
            const [rows] = await db.query(q, p);
            const [cnt] = await db.query(qc, pc);
            
            res.json({  rows, total: cnt[0].total });
        } catch (e) {
            console.error('Error fetching results:', e);
            res.status(500).json({ error: e.message });
        }
    });

    // 2. Очистить результаты
    router.post('/clear', async (req, res) => {
        try {
            const { project_id } = req.body;
            let q = 'DELETE FROM prices WHERE 1=1'; 
            let p = [];
            
            if (project_id && project_id !== 'all') { 
                q += ' AND project_id = ?'; 
                p.push(project_id); 
            }
            
            const [r] = await db.query(q, p);
            res.json({ success: true, deleted: r.affectedRows });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // 3. Удалить одну запись
    router.delete('/:id', async (req, res) => {
        try {
            await db.query('DELETE FROM prices WHERE id = ?', [req.params.id]);
            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    return router;
};