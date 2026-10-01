/**
 * Управление основной БД Datagon: размеры таблиц, превью, ANALYZE/OPTIMIZE.
 * Имена таблиц только из information_schema текущей схемы — без произвольного SQL.
 */
const express = require('express');
const { buildRelationsCatalog, getTableMeta } = require('../lib/datagonDbRelations');

const IDENT_RE = /^[A-Za-z0-9_]+$/;
const PREVIEW_MAX = 50;
const PREVIEW_DEFAULT = 20;
const MAINT_MAX_TABLES = 40;

function actorCanUseDbAdmin(actor) {
    return Boolean(actor && (actor.username === 'admin' || actor.can_manage_users === true));
}

function quoteIdent(name) {
    return '`' + String(name).replace(/`/g, '') + '`';
}

async function listSchemaTables(db) {
    const [rows] = await db.query(
        `
            SELECT
                TABLE_NAME AS name,
                ENGINE AS engine,
                TABLE_ROWS AS table_rows,
                DATA_LENGTH AS data_bytes,
                INDEX_LENGTH AS index_bytes,
                (DATA_LENGTH + INDEX_LENGTH) AS size_bytes,
                CREATE_TIME AS create_time,
                UPDATE_TIME AS update_time,
                TABLE_COLLATION AS collation,
                TABLE_COMMENT AS table_comment
            FROM information_schema.TABLES
            WHERE table_schema = DATABASE()
              AND TABLE_TYPE = 'BASE TABLE'
            ORDER BY (DATA_LENGTH + INDEX_LENGTH) DESC, TABLE_NAME ASC
        `
    );
    return rows || [];
}

async function assertTablesExist(db, names) {
    const wanted = [...new Set((names || []).map((n) => String(n || '').trim()).filter(Boolean))];
    if (!wanted.length) {
        const err = new Error('Укажите хотя бы одну таблицу');
        err.code = 'NO_TABLES';
        throw err;
    }
    if (wanted.length > MAINT_MAX_TABLES) {
        const err = new Error(`Не больше ${MAINT_MAX_TABLES} таблиц за раз`);
        err.code = 'TOO_MANY';
        throw err;
    }
    for (const n of wanted) {
        if (!IDENT_RE.test(n)) {
            const err = new Error(`Недопустимое имя таблицы: ${n}`);
            err.code = 'BAD_NAME';
            throw err;
        }
    }
    const placeholders = wanted.map(() => '?').join(',');
    const [rows] = await db.query(
        `
            SELECT TABLE_NAME AS name
            FROM information_schema.TABLES
            WHERE table_schema = DATABASE()
              AND TABLE_TYPE = 'BASE TABLE'
              AND TABLE_NAME IN (${placeholders})
        `,
        wanted
    );
    const found = new Set((rows || []).map((r) => String(r.name)));
    const missing = wanted.filter((n) => !found.has(n));
    if (missing.length) {
        const err = new Error(`Таблицы не найдены в схеме: ${missing.join(', ')}`);
        err.code = 'NOT_FOUND';
        throw err;
    }
    return wanted;
}

async function runMaintain(db, kind, tables) {
    const started = Date.now();
    const ok = [];
    const errors = [];
    const verb = kind === 'optimize' ? 'OPTIMIZE' : 'ANALYZE';
    for (const name of tables) {
        try {
            const sql = `${verb} TABLE ${quoteIdent(name)}`;
            const [result] = await db.query(sql);
            ok.push({
                table: name,
                result: Array.isArray(result)
                    ? result.map((r) => ({
                          Table: r.Table,
                          Op: r.Op,
                          Msg_type: r.Msg_type,
                          Msg_text: r.Msg_text,
                      }))
                    : result,
            });
        } catch (e) {
            errors.push({ table: name, error: e.message || String(e) });
            if (errors.length >= 20) break;
        }
    }
    return {
        success: errors.length === 0,
        kind,
        total: tables.length,
        ok_count: ok.length,
        failed: errors.length,
        duration_sec: Math.round(((Date.now() - started) / 1000) * 10) / 10,
        ok: ok.slice(0, 40),
        errors: errors.slice(0, 20),
    };
}

module.exports = (db) => {
    const router = express.Router();

    router.use((req, res, next) => {
        if (!actorCanUseDbAdmin(req.datagonActor)) {
            return res.status(403).json({
                success: false,
                error: 'Недостаточно прав: нужны администратор или право управления пользователями',
            });
        }
        return next();
    });

    router.get('/relations', (_req, res) => {
        try {
            return res.json({ success: true, ...buildRelationsCatalog() });
        } catch (e) {
            return res.status(500).json({ success: false, error: e.message || String(e) });
        }
    });

    router.get('/overview', async (req, res) => {
        try {
            const refresh = String(req.query.refresh || '') === '1';
            const [dbRow] = await db.query(`SELECT DATABASE() AS db_name`);
            const database = dbRow && dbRow[0] ? String(dbRow[0].db_name || '') : '';
            const rows = await listSchemaTables(db);
            let sizeBytes = 0;
            let dataBytes = 0;
            let indexBytes = 0;
            const tables = rows.map((r) => {
                const sz = Number(r.size_bytes || 0);
                const db_ = Number(r.data_bytes || 0);
                const ib = Number(r.index_bytes || 0);
                sizeBytes += sz;
                dataBytes += db_;
                indexBytes += ib;
                const meta = getTableMeta(r.name);
                return {
                    name: r.name,
                    engine: r.engine || null,
                    table_rows: r.table_rows == null ? null : Number(r.table_rows),
                    data_bytes: db_,
                    index_bytes: ib,
                    size_bytes: sz,
                    create_time: r.create_time || null,
                    update_time: r.update_time || null,
                    collation: r.collation || null,
                    table_comment: r.table_comment || '',
                    domain: meta.domain,
                    domain_title: meta.domain_title,
                    domain_color: meta.domain_color,
                    note: meta.note,
                    links: meta.links,
                };
            });
            tables.forEach((t) => {
                t.pct_of_db = sizeBytes > 0 ? Math.round((t.size_bytes / sizeBytes) * 10000) / 100 : 0;
            });
            return res.json({
                success: true,
                refreshed: refresh,
                database,
                size_bytes: sizeBytes,
                data_bytes: dataBytes,
                index_bytes: indexBytes,
                table_count: tables.length,
                fetched_at: new Date().toISOString(),
                tables,
            });
        } catch (e) {
            return res.status(500).json({ success: false, error: e.message || String(e) });
        }
    });

    router.get('/tables/:name/preview', async (req, res) => {
        try {
            const name = String(req.params.name || '').trim();
            if (!IDENT_RE.test(name)) {
                return res.status(400).json({ success: false, error: 'Недопустимое имя таблицы' });
            }
            const [exists] = await db.query(
                `
                    SELECT TABLE_NAME AS name
                    FROM information_schema.TABLES
                    WHERE table_schema = DATABASE()
                      AND TABLE_TYPE = 'BASE TABLE'
                      AND TABLE_NAME = ?
                    LIMIT 1
                `,
                [name]
            );
            if (!exists || !exists.length) {
                return res.status(404).json({ success: false, error: 'Таблица не найдена' });
            }
            let limit = parseInt(String(req.query.limit || PREVIEW_DEFAULT), 10);
            if (!Number.isFinite(limit) || limit < 1) limit = PREVIEW_DEFAULT;
            if (limit > PREVIEW_MAX) limit = PREVIEW_MAX;

            const [cols] = await db.query(
                `
                    SELECT
                        COLUMN_NAME AS name,
                        COLUMN_TYPE AS column_type,
                        IS_NULLABLE AS is_nullable,
                        COLUMN_KEY AS column_key,
                        COLUMN_DEFAULT AS column_default,
                        EXTRA AS extra
                    FROM information_schema.COLUMNS
                    WHERE table_schema = DATABASE()
                      AND TABLE_NAME = ?
                    ORDER BY ORDINAL_POSITION
                `,
                [name]
            );

            const [rows] = await db.query(
                `SELECT * FROM ${quoteIdent(name)} LIMIT ${Number(limit)}`
            );

            const meta = getTableMeta(name);
            return res.json({
                success: true,
                table: name,
                limit,
                columns: cols || [],
                rows: rows || [],
                row_count: (rows || []).length,
                meta,
            });
        } catch (e) {
            return res.status(500).json({ success: false, error: e.message || String(e) });
        }
    });

    router.post('/analyze', async (req, res) => {
        try {
            const tables = await assertTablesExist(db, (req.body && req.body.tables) || []);
            const result = await runMaintain(db, 'analyze', tables);
            return res.json(result);
        } catch (e) {
            const status = e.code === 'NOT_FOUND' || e.code === 'BAD_NAME' || e.code === 'NO_TABLES' || e.code === 'TOO_MANY' ? 400 : 500;
            return res.status(status).json({ success: false, error: e.message || String(e) });
        }
    });

    router.post('/optimize', async (req, res) => {
        try {
            const tables = await assertTablesExist(db, (req.body && req.body.tables) || []);
            const result = await runMaintain(db, 'optimize', tables);
            return res.json(result);
        } catch (e) {
            const status = e.code === 'NOT_FOUND' || e.code === 'BAD_NAME' || e.code === 'NO_TABLES' || e.code === 'TOO_MANY' ? 400 : 500;
            return res.status(status).json({ success: false, error: e.message || String(e) });
        }
    });

    return router;
};
