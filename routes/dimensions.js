'use strict';

/**
 * Маркетплейсы → Габариты: реестр замеров габаритов товаров и комплектов МойСклад.
 *
 * Источник истины базовых полей (код, наименование, тип) — таблица `ms_export`.
 * Замеры (кто замерял, дата замера, сами габариты) хранятся в отдельной таблице
 * `ms_dimensions_measurements` и подмешиваются к строкам ms_export по полю `code`.
 *
 * См. правила:
 * - .cursor/rules/datagon-list-page-baseline-moysklad.mdc
 * - .cursor/rules/datagon-table-filter-apply.mdc
 * - .cursor/rules/datagon-node-restart-lock.mdc
 */

const express = require('express');

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
const ALLOWED_SORT = {
    code: 'mse.code',
    name: 'mse.name',
    type: 'mse.type',
    measured_by_name: 'mdm.measured_by_name',
    measured_at: 'mdm.measured_at',
};

let tableReady = false;

async function ensureSchema(db) {
    if (tableReady) return;
    await db.query(`
        CREATE TABLE IF NOT EXISTS ms_dimensions_measurements (
            code VARCHAR(255) NOT NULL PRIMARY KEY,
            measured_by_user_id INT NULL,
            measured_by_name VARCHAR(255) NULL,
            measured_at TIMESTAMP NULL,
            dimensions_json LONGTEXT NULL,
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            INDEX idx_dim_meas_by_user (measured_by_user_id),
            INDEX idx_dim_meas_at (measured_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    tableReady = true;
}

function clampInt(value, min, max, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, Math.floor(n)));
}

function buildWhereClauseFromQuery(query) {
    /**
     * База: только складские позиции (`stock_position = 'Да'`), и при этом «не перестали
     * сотрудничать» (`no_longer_cooperation <> 'Да'`). Исключение: даже если по поставщику
     * прекращено сотрудничество, но **есть остаток** (`stock > 0`) — позицию **показываем**.
     * Запрос пользователя: «фильтруем на предмет складская позиция да и не перестали
     * сотрудничать - нет, но если есть остаток то все равно выводим».
     */
    const where = [
        "mse.stock_position = 'Да'",
        "(COALESCE(mse.no_longer_cooperation, '') <> 'Да' OR COALESCE(mse.stock, 0) > 0)",
    ];
    const params = [];

    const search = String((query && query.search) || '').trim();
    if (search) {
        const tokens = search.split(/\s+/).filter(Boolean).slice(0, 6);
        for (const tok of tokens) {
            const like = `%${tok}%`;
            where.push('(mse.code LIKE ? OR mse.name LIKE ?)');
            params.push(like, like);
        }
    }

    const typeRaw = String((query && query.type) || 'all').trim().toLowerCase();
    if (typeRaw === 'товар') {
        where.push('LOWER(mse.type) = ?');
        params.push('товар');
    } else if (typeRaw === 'комплект') {
        where.push('LOWER(mse.type) = ?');
        params.push('комплект');
    }

    const scope = String((query && query.scope) || 'all').trim().toLowerCase();
    if (scope === 'with') {
        where.push('mdm.code IS NOT NULL');
    } else if (scope === 'without') {
        where.push('mdm.code IS NULL');
    }

    const whereSql = ' WHERE ' + where.join(' AND ');
    return { whereSql, params };
}

function resolveSort(query) {
    const sortBy = String((query && query.sort_by) || 'code').trim();
    const col = ALLOWED_SORT[sortBy] || ALLOWED_SORT.code;
    const dir = String((query && query.sort_dir) || 'asc').trim().toLowerCase() === 'desc' ? 'DESC' : 'ASC';
    /** Стабильность сортировки по `code` как вторичный ключ. */
    if (col === ALLOWED_SORT.code) return `${col} ${dir}`;
    return `${col} ${dir}, mse.code ASC`;
}

function actorDisplayName(actor) {
    if (!actor) return '';
    return String(actor.full_name || actor.username || '').trim();
}

function createDimensionsRouter(db, appSettings = {}) {
    const router = express.Router();
    ensureSchema(db).catch((e) => {
        console.error('[dimensions] ensureSchema:', e && e.message);
    });

    router.get('/list', async (req, res) => {
        try {
            await ensureSchema(db);
            const limit = clampInt(req.query.limit, 1, MAX_LIMIT, DEFAULT_LIMIT);
            const offset = clampInt(req.query.offset, 0, 1_000_000, 0);
            const orderBy = resolveSort(req.query);
            const { whereSql, params } = buildWhereClauseFromQuery(req.query);

            const fromSql = `
                FROM ms_export mse
                LEFT JOIN ms_dimensions_measurements mdm ON mdm.code = mse.code
            `;

            const [countRows] = await db.query(
                `SELECT COUNT(*) AS total ${fromSql} ${whereSql}`,
                params,
            );
            const total = Number((countRows && countRows[0] && countRows[0].total) || 0);

            const [rows] = await db.query(
                `SELECT
                    mse.code AS code,
                    mse.name AS name,
                    mse.type AS type,
                    mse.uuid AS uuid,
                    COALESCE(mse.is_archived, 0) AS is_archived,
                    mdm.measured_by_user_id AS measured_by_user_id,
                    mdm.measured_by_name AS measured_by_name,
                    mdm.measured_at AS measured_at
                 ${fromSql}
                 ${whereSql}
                 ORDER BY ${orderBy}
                 LIMIT ? OFFSET ?`,
                params.concat([limit, offset]),
            );

            const out = (rows || []).map((r) => ({
                code: String(r.code || ''),
                name: String(r.name || ''),
                type: String(r.type || ''),
                uuid: String(r.uuid || ''),
                is_archived: Number(r.is_archived || 0) === 1,
                measured_by_user_id: r.measured_by_user_id != null ? Number(r.measured_by_user_id) : null,
                measured_by_name: r.measured_by_name != null ? String(r.measured_by_name) : '',
                measured_at: r.measured_at ? new Date(r.measured_at).toISOString() : '',
            }));

            return res.json({
                success: true,
                rows: out,
                total,
                limit,
                offset,
                sort_by: String(req.query.sort_by || 'code'),
                sort_dir: String(req.query.sort_dir || 'asc'),
            });
        } catch (e) {
            return res.status(500).json({ success: false, error: e.message || 'Ошибка загрузки списка' });
        }
    });

    /**
     * Записать/обновить замер по коду. Принимает любые поля габаритов в `dimensions`,
     * а также явные `measured_by_name`, `measured_at` (если их не указали — берём
     * текущего пользователя сессии и время сервера).
     *
     * Контракт сохранения замеров пока намеренно широкий: окончательную схему полей
     * пользователь предоставит позже (см. CHAT).
     */
    router.post('/measure', async (req, res) => {
        try {
            await ensureSchema(db);
            const body = req.body || {};
            const code = String(body.code || '').trim();
            if (!code) return res.status(400).json({ success: false, error: 'Не указан code' });

            const actor = req.datagonActor || null;
            const measuredByName = String(body.measured_by_name || actorDisplayName(actor) || '').trim();
            const measuredByUserId = actor && actor.id != null ? Number(actor.id) : null;
            const measuredAt =
                body.measured_at && !Number.isNaN(new Date(body.measured_at).getTime())
                    ? new Date(body.measured_at)
                    : new Date();
            let dimensionsJson = null;
            if (body.dimensions && typeof body.dimensions === 'object') {
                try {
                    dimensionsJson = JSON.stringify(body.dimensions);
                } catch (_) {
                    dimensionsJson = null;
                }
            }

            await db.query(
                `INSERT INTO ms_dimensions_measurements
                    (code, measured_by_user_id, measured_by_name, measured_at, dimensions_json)
                 VALUES (?, ?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE
                    measured_by_user_id = VALUES(measured_by_user_id),
                    measured_by_name = VALUES(measured_by_name),
                    measured_at = VALUES(measured_at),
                    dimensions_json = COALESCE(VALUES(dimensions_json), dimensions_json)`,
                [code, measuredByUserId, measuredByName || null, measuredAt, dimensionsJson],
            );

            return res.json({
                success: true,
                code,
                measured_by_user_id: measuredByUserId,
                measured_by_name: measuredByName,
                measured_at: measuredAt.toISOString(),
            });
        } catch (e) {
            return res.status(500).json({ success: false, error: e.message || 'Ошибка сохранения замера' });
        }
    });

    /** Удалить замер (откат «кто замерял / дата замера» в пусто). */
    router.delete('/measure/:code', async (req, res) => {
        try {
            await ensureSchema(db);
            const code = String(req.params.code || '').trim();
            if (!code) return res.status(400).json({ success: false, error: 'Не указан code' });
            await db.query('DELETE FROM ms_dimensions_measurements WHERE code = ?', [code]);
            return res.json({ success: true, code });
        } catch (e) {
            return res.status(500).json({ success: false, error: e.message || 'Ошибка удаления замера' });
        }
    });

    return router;
}

module.exports = createDimensionsRouter;
