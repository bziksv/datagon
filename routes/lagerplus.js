/**
 * Lagerplus — закупочный модуль (адаптация фич из репозитория
 * https://github.com/neeil1990/store под стек Datagon: Node.js + Express +
 * MySQL + vanilla HTML).
 *
 * Архитектурный принцип:
 *   • Lagerplus — ОТДЕЛЬНОЕ «вкрапление» поверх существующих данных, без
 *     изменения текущего поведения /moysklad.html и других страниц. Всё
 *     read/write идёт через собственные эндпоинты `/api/lagerplus/*` и
 *     собственные таблицы (`dg_min_stock_overrides`, `dg_min_stock_log`).
 *   • Источник базовых полей (код / название / тип / поставщик / остаток /
 *     неснижаемый остаток МС) — таблица `ms_export`. Колонка
 *     `ms_export.min_stock` = `product.minimumBalance` из МС API
 *     (синхронизируется в `routes/moysklad.js#syncMsExport`).
 *
 * Версия: v1 (read + write override + push в МС). Включает:
 *   1. Read-only список с фильтрами «дефицит / нулевые» и эффективным
 *      нормативом = COALESCE(min_stock_lager, ms_export.min_stock).
 *   2. Редактируемый `min_stock_lager` (override поверх МС-значения),
 *      сохраняется в `dg_min_stock_overrides` с журналом в
 *      `dg_min_stock_log` (паттерн как у `routes/dimensions.js`).
 *   3. Push в МС через `PUT /entity/product/{uuid}` с нативным полем
 *      `minimumBalance` (поштучно и балк-вариант «всё на странице» /
 *      «все правки»). Для `Комплектов` push не выполняется — у `bundle`
 *      в МС-схеме поле `minimumBalance` не задано.
 *
 * В следующих версиях:
 *   • v2 — отдельная страница `/suppliers.html` (нормализованный
 *     справочник поставщиков из МС).
 *   • v3 — отдельная страница `/shipper.html` (закупочный профиль 1:1
 *     с поставщиком, балк-операции).
 *   • v4 — cron-история `dg_stock_snapshots` + `dg_sales_daily` и
 *     колонки `stock_zero_*`/`sell_*` (требует ежедневный снимок
 *     остатков и `entity/demand` из МС).
 */

const express = require('express');
const axios = require('axios');
const config = require('../config');

const MS_BASE_URL = 'https://api.moysklad.ru/api/remap/1.2';

let lagerSchemaReady = false;

/**
 * Миграции таблиц Lagerplus. Идемпотентный CREATE TABLE IF NOT EXISTS.
 *
 * Таблицы:
 *   • `dg_min_stock_overrides` — пользовательский «неснижаемый остаток
 *     (Lager)» поверх МС-значения. По коду МС — 1 запись. После явной
 *     «↗ В МС» отправляется в МС как `product.minimumBalance`.
 *   • `dg_min_stock_log` — журнал правок (`set` / `delete` / `sync_ms`
 *     / `sync_ms (auto-persist before push)`) по аналогии с
 *     `ms_dimensions_log`.
 */
async function ensureLagerSchema(db) {
    if (lagerSchemaReady) return;
    await db.query(`
        CREATE TABLE IF NOT EXISTS dg_min_stock_overrides (
            code VARCHAR(64) NOT NULL PRIMARY KEY,
            value_lager DECIMAL(15,3) NOT NULL,
            multiplicity DECIMAL(15,3) NULL DEFAULT NULL,
            min_balance_counted_as DECIMAL(15,3) NULL DEFAULT NULL,
            comment TEXT NULL,
            set_by_user_id INT NULL,
            set_by_name VARCHAR(150) NULL,
            set_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            INDEX idx_set_at (set_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await db.query(`
        CREATE TABLE IF NOT EXISTS dg_min_stock_log (
            id BIGINT AUTO_INCREMENT PRIMARY KEY,
            code VARCHAR(64) NOT NULL,
            field VARCHAR(40) NOT NULL DEFAULT 'value_lager',
            old_value VARCHAR(64) NULL,
            new_value VARCHAR(64) NULL,
            action VARCHAR(40) NOT NULL DEFAULT 'set',
            changed_by_user_id INT NULL,
            changed_by_name VARCHAR(150) NULL,
            note TEXT NULL,
            changed_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
            INDEX idx_code (code),
            INDEX idx_changed_at (changed_at),
            INDEX idx_action (action)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    lagerSchemaReady = true;
}

function clampInt(value, min, max, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, Math.floor(n)));
}

function actorDisplayName(actor) {
    if (!actor) return '';
    return String(actor.full_name || actor.username || '').trim();
}

function getMsToken() {
    return process.env.MS_TOKEN || (config && config.msToken) || '';
}

function getMsHeaders() {
    const token = getMsToken();
    if (!token) return null;
    return {
        Authorization: 'Bearer ' + token,
        'Content-Type': 'application/json',
        Accept: 'application/json;charset=utf-8',
    };
}

/**
 * Нормализация числового значения override. Принимает:
 *   • число → возвращает как есть.
 *   • строку: пустая ('', '   ') → null (это сигнал «удалить override»),
 *     числовая → Number, иначе кидаем 400-error.
 *   • null/undefined → null (явное удаление override).
 *
 * Возвращает `null` или конечное число (включая 0 — это валидный
 * норматив «не держать на складе»).
 */
function normalizeNumericOrNull(raw) {
    if (raw === null || raw === undefined) return null;
    if (typeof raw === 'number') {
        if (!Number.isFinite(raw)) throw new Error('Не число: ' + raw);
        return raw;
    }
    const s = String(raw).trim();
    if (s === '') return null;
    const n = Number(s.replace(',', '.'));
    if (!Number.isFinite(n)) throw new Error('Невалидное число: ' + s);
    return n;
}

/** Поля, которые принимаем для UPSERT в `dg_min_stock_overrides`. */
const OVERRIDE_FIELDS = ['value_lager', 'multiplicity', 'min_balance_counted_as'];

/**
 * UPSERT override + запись в журнал. Семантика как у `persistMeasurementFields`
 * в `routes/dimensions.js`:
 *   • Поле, ПЕРЕДАННОЕ в `incoming` — UPSERT'ится (даже если null →
 *     удаляет override этого поля).
 *   • Поле, ОТСУТСТВУЮЩЕЕ в `incoming` — НЕ трогается.
 *   • В журнал пишется только реальная разница со старым значением
 *     (action='set' для смены, action='delete' для null).
 *
 * Особый случай: если после UPSERT'а ВСЕ значения override обнулились
 * (value_lager IS NULL И multiplicity IS NULL И min_balance_counted_as
 * IS NULL) — удаляем строку целиком, чтобы LEFT JOIN в /list не цеплял
 * «пустой» override.
 */
async function persistOverride(db, options) {
    const code = String(options.code || '').trim();
    if (!code) throw new Error('Не указан code');

    const incoming = options.incoming && typeof options.incoming === 'object' ? options.incoming : {};
    const incomingKeys = OVERRIDE_FIELDS.filter((k) => Object.prototype.hasOwnProperty.call(incoming, k));
    if (incomingKeys.length === 0 && incoming.comment === undefined) {
        return { changedFields: [], override: null, skipped_persist: true };
    }

    /** Нормализуем входящие значения (numeric → number/null, comment → string/null). */
    const normalized = {};
    for (const k of incomingKeys) normalized[k] = normalizeNumericOrNull(incoming[k]);
    let normalizedComment = undefined;
    if (Object.prototype.hasOwnProperty.call(incoming, 'comment')) {
        const c = incoming.comment;
        normalizedComment = c == null ? null : String(c).slice(0, 500);
    }

    const setByName = options.actorName || null;
    const setByUserId = options.actorId != null ? Number(options.actorId) : null;
    const setAt = options.changedAt instanceof Date ? options.changedAt : new Date();
    const note = options.note != null ? String(options.note).slice(0, 500) : null;

    const [oldRows] = await db.query(
        `SELECT value_lager, multiplicity, min_balance_counted_as, comment
           FROM dg_min_stock_overrides
          WHERE code = ?`,
        [code],
    );
    const oldRow = (Array.isArray(oldRows) && oldRows[0]) || {};

    const changedFields = [];
    for (const k of incomingKeys) {
        const oldVal = oldRow[k] != null ? Number(oldRow[k]) : null;
        const newVal = normalized[k];
        if (oldVal == null && newVal == null) continue;
        if (oldVal != null && newVal != null && Math.abs(oldVal - newVal) < 1e-9) continue;
        const action = newVal == null ? 'delete' : 'set';
        await db.query(
            `INSERT INTO dg_min_stock_log
                (code, field, old_value, new_value, action, changed_by_user_id, changed_by_name, note, changed_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                code,
                k,
                oldVal != null ? String(oldVal) : null,
                newVal != null ? String(newVal) : null,
                action,
                setByUserId,
                setByName,
                note,
                setAt,
            ],
        );
        changedFields.push({ field: k, old: oldVal, new: newVal, action });
    }

    /**
     * Решаем: делаем UPSERT или DELETE строки целиком.
     *
     * После применения изменений считаем «итоговое» состояние: то, что
     * лежит в БД сейчас (oldRow) + то, что мы только что нормализовали.
     * Если в итоге все override-числа равны null (включая старые поля,
     * которые мы НЕ трогали) — удаляем строку, чтобы /list не показывал
     * «осиротевший» Lager-override со всеми «—».
     */
    const effectiveValue = Object.prototype.hasOwnProperty.call(normalized, 'value_lager')
        ? normalized.value_lager
        : (oldRow.value_lager != null ? Number(oldRow.value_lager) : null);
    const effectiveMultiplicity = Object.prototype.hasOwnProperty.call(normalized, 'multiplicity')
        ? normalized.multiplicity
        : (oldRow.multiplicity != null ? Number(oldRow.multiplicity) : null);
    const effectiveCountedAs = Object.prototype.hasOwnProperty.call(normalized, 'min_balance_counted_as')
        ? normalized.min_balance_counted_as
        : (oldRow.min_balance_counted_as != null ? Number(oldRow.min_balance_counted_as) : null);
    const effectiveComment = normalizedComment !== undefined
        ? normalizedComment
        : (oldRow.comment != null ? String(oldRow.comment) : null);

    const allNumericNull = effectiveValue == null && effectiveMultiplicity == null && effectiveCountedAs == null;
    const noComment = !effectiveComment;

    if (allNumericNull && noComment) {
        if (oldRow && Object.keys(oldRow).length > 0) {
            await db.query('DELETE FROM dg_min_stock_overrides WHERE code = ?', [code]);
        }
        return { changedFields, override: null };
    }

    /**
     * UPSERT. value_lager — NOT NULL по схеме, поэтому если в итоге
     * value_lager == null, но multiplicity/counted_as заданы — фактически
     * это уже edge-кейс: пользователь убрал свой норматив, но оставил
     * кратность. По текущей схеме этого недопустимо. Переключим тогда
     * value_lager в 0 (явный 0 — «не держим запас») с пометкой в логе.
     * Альтернатива (изменить колонку в NULL) — менять схему; пока проще
     * жить с ограничением «без value_lager — нет override».
     */
    let valueToWrite = effectiveValue;
    if (valueToWrite == null) {
        if (oldRow && Object.keys(oldRow).length > 0) {
            await db.query('DELETE FROM dg_min_stock_overrides WHERE code = ?', [code]);
        }
        return { changedFields, override: null };
    }

    await db.query(
        `INSERT INTO dg_min_stock_overrides
            (code, value_lager, multiplicity, min_balance_counted_as, comment,
             set_by_user_id, set_by_name, set_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
            value_lager = VALUES(value_lager),
            multiplicity = VALUES(multiplicity),
            min_balance_counted_as = VALUES(min_balance_counted_as),
            comment = VALUES(comment),
            set_by_user_id = VALUES(set_by_user_id),
            set_by_name = VALUES(set_by_name),
            set_at = VALUES(set_at)`,
        [
            code,
            valueToWrite,
            effectiveMultiplicity,
            effectiveCountedAs,
            effectiveComment,
            setByUserId,
            setByName,
            setAt,
        ],
    );

    const [freshRows] = await db.query(
        `SELECT value_lager, multiplicity, min_balance_counted_as, comment,
                set_by_user_id, set_by_name, set_at
           FROM dg_min_stock_overrides
          WHERE code = ?`,
        [code],
    );
    const fresh = (Array.isArray(freshRows) && freshRows[0]) || null;
    return {
        changedFields,
        override: fresh ? {
            value_lager: fresh.value_lager != null ? Number(fresh.value_lager) : null,
            multiplicity: fresh.multiplicity != null ? Number(fresh.multiplicity) : null,
            min_balance_counted_as: fresh.min_balance_counted_as != null ? Number(fresh.min_balance_counted_as) : null,
            comment: fresh.comment ? String(fresh.comment) : '',
            set_by_user_id: fresh.set_by_user_id != null ? Number(fresh.set_by_user_id) : null,
            set_by_name: fresh.set_by_name ? String(fresh.set_by_name) : '',
            set_at: fresh.set_at ? new Date(fresh.set_at).toISOString() : null,
        } : null,
    };
}

/**
 * Push «неснижаемого остатка (Lager)» в МС. Используется нативное поле
 * МС API `product.minimumBalance` (не attribute). Для `Комплектов`
 * push не выполняется (поле в МС-схеме `bundle` не задано).
 *
 * Возвращает один из:
 *   { ok: true, ms_status, ms_updated_at, sent_value }
 *   { ok: false, error, http_status?, skipped: 'bundle' | 'no-uuid' | 'no-override' }
 */
async function pushMinStockToMs(uuid, type, value, headers) {
    if (!uuid) return { ok: false, error: 'Нет uuid в ms_export', skipped: 'no-uuid' };
    const t = String(type || '').toLowerCase();
    if (t === 'комплект' || t === 'bundle') {
        return { ok: false, error: 'Комплекты не поддерживают minimumBalance', skipped: 'bundle' };
    }
    if (value == null || !Number.isFinite(Number(value))) {
        return { ok: false, error: 'Нет числового значения для push', skipped: 'no-override' };
    }
    const url = MS_BASE_URL + '/entity/product/' + encodeURIComponent(uuid);
    try {
        const resp = await axios.put(url, { minimumBalance: Number(value) }, { headers, timeout: 30000 });
        return {
            ok: true,
            ms_status: resp && resp.status ? Number(resp.status) : 200,
            ms_updated_at: (resp && resp.data && resp.data.updated) ? String(resp.data.updated) : null,
            sent_value: Number(value),
        };
    } catch (e) {
        const httpStatus = e && e.response && e.response.status ? Number(e.response.status) : 0;
        const errBody = e && e.response && e.response.data;
        let msErr = '';
        if (errBody && Array.isArray(errBody.errors) && errBody.errors[0]) {
            msErr = String(errBody.errors[0].error || errBody.errors[0].message || '');
        } else if (typeof errBody === 'string') {
            msErr = errBody;
        }
        return {
            ok: false,
            error: 'MS API ' + (httpStatus || 'NETWORK') + ': ' + (msErr || (e && e.message) || 'unknown'),
            http_status: httpStatus,
            sent_value: Number(value),
        };
    }
}

function createLagerplusRouter(db, appSettings = {}) {
    const router = express.Router();
    ensureLagerSchema(db).catch((e) => {
        console.error('[lagerplus] ensureLagerSchema:', e && e.message);
    });

    /**
     * GET /api/lagerplus/list — список товаров для закупочного решения.
     *
     * Query:
     *   • search — подстрока по `code` / `name` / `supplier`.
     *   • type — `all` (по умолчанию) | `Товар` | `Комплект`.
     *   • scope — `all` | `deficit` (остаток < эффективного норматива; норматив
     *     должен быть задан) | `zero` (остаток ≤ 0). По умолчанию `deficit`.
     *   • limit (1..500, default 100) / offset (default 0).
     *   • sort_by — одно из `code|name|manager|content_manager|supplier|type|stock|
     *     stock_days|min_stock_ms|min_stock_lager|delta_lager`.
     *   • sort_dir — asc/desc.
     *
     * Эффективный норматив = COALESCE(min_stock_lager, ms_export.min_stock, 0).
     * `delta_lager` = stock - effective_min (отрицательное → дефицит).
     */
    router.get('/list', async (req, res) => {
        try {
            await ensureLagerSchema(db);

            const limit = clampInt(req.query.limit, 1, 500, 100);
            const offset = clampInt(req.query.offset, 0, 5_000_000, 0);
            const search = String(req.query.search || '').trim();
            const type = String(req.query.type || 'all');
            const scope = String(req.query.scope || 'all');
            const sortBy = String(req.query.sort_by || 'code');
            const sortDir = String(req.query.sort_dir || 'asc').toLowerCase() === 'desc' ? 'DESC' : 'ASC';

            const sortMap = {
                code: 'ms_export.code',
                name: 'ms_export.name',
                manager: 'ms_export.manager',
                content_manager: 'ms_export.content_manager',
                supplier: 'ms_export.supplier',
                type: 'ms_export.type',
                stock: 'COALESCE(ms_export.stock, 0)',
                stock_days: 'COALESCE(CAST(ms_export.stock_days AS DECIMAL(15,2)), 0)',
                min_stock_ms: 'COALESCE(ms_export.min_stock, 0)',
                min_stock_lager: 'COALESCE(ovr.value_lager, 0)',
                delta_lager: '(COALESCE(ms_export.stock, 0) - COALESCE(ovr.value_lager, ms_export.min_stock, 0))',
            };
            const sortField = sortMap[sortBy] || sortMap.code;

            const wheres = [
                'COALESCE(ms_export.is_archived, 0) = 0',
                "ms_export.stock_position = 'Да'",
                "COALESCE(ms_export.no_longer_cooperation, 'Нет') = 'Нет'",
            ];
            const params = [];

            if (search) {
                wheres.push('(ms_export.code LIKE ? OR ms_export.name LIKE ? OR ms_export.supplier LIKE ?)');
                const needle = '%' + search + '%';
                params.push(needle, needle, needle);
            }
            if (type === 'Товар' || type === 'Комплект') {
                wheres.push('ms_export.type = ?');
                params.push(type);
            }
            if (scope === 'zero') {
                wheres.push('COALESCE(ms_export.stock, 0) <= 0');
            } else if (scope === 'deficit') {
                wheres.push('COALESCE(ovr.value_lager, ms_export.min_stock) IS NOT NULL');
                wheres.push('COALESCE(ms_export.stock, 0) < COALESCE(ovr.value_lager, ms_export.min_stock, 0)');
            }

            const whereSql = ' WHERE ' + wheres.join(' AND ');

            const sql = `
                SELECT
                    ms_export.code, ms_export.name, ms_export.manager, ms_export.content_manager,
                    ms_export.supplier, ms_export.supplier2, ms_export.type, ms_export.uuid,
                    COALESCE(ms_export.stock, 0) AS stock,
                    ms_export.stock_days,
                    ms_export.min_stock AS min_stock_ms,
                    ovr.value_lager AS min_stock_lager,
                    ovr.multiplicity AS multiplicity,
                    ovr.min_balance_counted_as AS min_balance_counted_as,
                    ovr.comment AS lager_comment,
                    ovr.set_by_name AS lager_set_by_name,
                    ovr.set_at AS lager_set_at,
                    (COALESCE(ms_export.stock, 0) - COALESCE(ovr.value_lager, ms_export.min_stock, 0)) AS delta_lager
                FROM ms_export
                LEFT JOIN dg_min_stock_overrides ovr ON ovr.code = ms_export.code
                ${whereSql}
                ORDER BY ${sortField} ${sortDir}, ms_export.code ASC
                LIMIT ? OFFSET ?
            `;
            const dataParams = params.concat([limit, offset]);

            const sqlCount = `
                SELECT COUNT(*) AS total
                FROM ms_export
                LEFT JOIN dg_min_stock_overrides ovr ON ovr.code = ms_export.code
                ${whereSql}
            `;

            const [rows] = await db.query(sql, dataParams);
            const [cntRows] = await db.query(sqlCount, params);

            res.json({
                success: true,
                total: Number((cntRows && cntRows[0] && cntRows[0].total) || 0),
                limit,
                offset,
                rows: (rows || []).map((r) => ({
                    code: String(r.code || ''),
                    uuid: String(r.uuid || ''),
                    name: String(r.name || ''),
                    manager: String(r.manager || ''),
                    content_manager: String(r.content_manager || ''),
                    supplier: String(r.supplier || ''),
                    supplier2: String(r.supplier2 || ''),
                    type: String(r.type || ''),
                    stock: Number(r.stock || 0),
                    stock_days: r.stock_days != null ? String(r.stock_days) : '',
                    min_stock_ms: r.min_stock_ms != null ? Number(r.min_stock_ms) : null,
                    min_stock_lager: r.min_stock_lager != null ? Number(r.min_stock_lager) : null,
                    multiplicity: r.multiplicity != null ? Number(r.multiplicity) : null,
                    min_balance_counted_as: r.min_balance_counted_as != null ? Number(r.min_balance_counted_as) : null,
                    lager_comment: r.lager_comment ? String(r.lager_comment) : '',
                    lager_set_by_name: r.lager_set_by_name ? String(r.lager_set_by_name) : '',
                    lager_set_at: r.lager_set_at ? new Date(r.lager_set_at).toISOString() : '',
                    delta_lager: r.delta_lager != null ? Number(r.delta_lager) : null,
                    suggested_min_stock: null,
                })),
            });
        } catch (e) {
            console.error('[lagerplus] /list:', e);
            res.status(500).json({ success: false, error: e && e.message ? e.message : 'Ошибка списка Lagerplus' });
        }
    });

    /**
     * POST /api/lagerplus/measure — UPSERT override.
     *
     * Body:
     *   { code, fields: { value_lager?, multiplicity?, min_balance_counted_as?, comment? }, note? }
     *   ИЛИ legacy: { code, field: 'value_lager', value: 1.5 } — для одного поля.
     *
     * Семантика: ровно как у POST /api/exports/dimensions/measure —
     * пропущенное поле не трогается, явный null/'' удаляет override.
     */
    router.post('/measure', async (req, res) => {
        try {
            await ensureLagerSchema(db);
            const body = req.body || {};
            const code = String(body.code || '').trim();
            if (!code) return res.status(400).json({ success: false, error: 'Не указан code' });

            const incoming = {};
            if (body.fields && typeof body.fields === 'object') {
                for (const k of [...OVERRIDE_FIELDS, 'comment']) {
                    if (Object.prototype.hasOwnProperty.call(body.fields, k)) {
                        incoming[k] = body.fields[k];
                    }
                }
            }
            if (body.field) {
                const f = String(body.field);
                if (OVERRIDE_FIELDS.includes(f) || f === 'comment') {
                    incoming[f] = body.value;
                }
            }
            if (Object.keys(incoming).length === 0) {
                return res.status(400).json({ success: false, error: 'Нечего сохранять (нет полей)' });
            }

            const actor = req.datagonActor || null;
            const result = await persistOverride(db, {
                code,
                incoming,
                actorId: actor && actor.id != null ? Number(actor.id) : null,
                actorName: actorDisplayName(actor) || null,
                changedAt: new Date(),
                note: body.note,
            });

            return res.json({
                success: true,
                code,
                changed_fields: result.changedFields,
                override: result.override,
            });
        } catch (e) {
            return res.status(500).json({ success: false, error: e && e.message ? e.message : 'Ошибка сохранения override' });
        }
    });

    /**
     * DELETE /api/lagerplus/measure/:code — удалить override полностью
     * (вернуть товар к МС-нормативу).
     */
    router.delete('/measure/:code', async (req, res) => {
        try {
            await ensureLagerSchema(db);
            const code = String(req.params.code || '').trim();
            if (!code) return res.status(400).json({ success: false, error: 'Не указан code' });

            const [oldRows] = await db.query(
                'SELECT value_lager, multiplicity, min_balance_counted_as, comment FROM dg_min_stock_overrides WHERE code = ?',
                [code],
            );
            const oldRow = (Array.isArray(oldRows) && oldRows[0]) || null;
            if (!oldRow) {
                return res.json({ success: true, code, deleted: false, message: 'Override не было' });
            }

            const actor = req.datagonActor || null;
            await db.query(
                `INSERT INTO dg_min_stock_log
                    (code, field, old_value, new_value, action, changed_by_user_id, changed_by_name, note)
                 VALUES (?, 'value_lager', ?, NULL, 'delete', ?, ?, ?)`,
                [
                    code,
                    oldRow.value_lager != null ? String(Number(oldRow.value_lager)) : null,
                    actor && actor.id != null ? Number(actor.id) : null,
                    actorDisplayName(actor) || null,
                    'manual delete',
                ],
            );
            await db.query('DELETE FROM dg_min_stock_overrides WHERE code = ?', [code]);
            return res.json({ success: true, code, deleted: true });
        } catch (e) {
            return res.status(500).json({ success: false, error: e && e.message ? e.message : 'Ошибка удаления override' });
        }
    });

    /**
     * POST /api/lagerplus/sync-ms — отправить override → МС
     * (`PUT /entity/product/{uuid}` с нативным `minimumBalance`).
     *
     * Body (1 из вариантов):
     *   • { code, fields?: {...}, note? } — синк одной позиции; если
     *     передан `fields`, сначала persist'ит override (auto-persist
     *     before push), потом отправляет в МС значение `value_lager`
     *     из БД.
     *   • { codes: ['10148', '26774'], ... } — балк-вариант. Каждая
     *     позиция обрабатывается последовательно (учитывая лимит МС).
     *   • { all: true } — все товары, у которых есть override
     *     (`dg_min_stock_overrides`). Используется кнопкой «↗ В МС:
     *     все правки» в UI.
     */
    router.post('/sync-ms', async (req, res) => {
        try {
            await ensureLagerSchema(db);
            const body = req.body || {};
            const headers = getMsHeaders();
            if (!headers) {
                return res.status(503).json({
                    success: false,
                    error: 'MS_TOKEN не задан (env MS_TOKEN или config.msToken)',
                });
            }
            const actor = req.datagonActor || null;
            const actorId = actor && actor.id != null ? Number(actor.id) : null;
            const actorName = actorDisplayName(actor) || null;

            /** Собираем список codes по приоритету: codes[] > all > {code,fields}. */
            let codes = [];
            if (body.all === true) {
                const [rows] = await db.query(
                    `SELECT ovr.code
                     FROM dg_min_stock_overrides ovr
                     INNER JOIN ms_export e ON e.code = ovr.code
                     WHERE e.type = 'Товар' AND ovr.value_lager IS NOT NULL
                     ORDER BY ovr.code`,
                );
                codes = rows.map((r) => String(r.code));
            } else if (Array.isArray(body.codes) && body.codes.length > 0) {
                codes = body.codes.map((c) => String(c || '').trim()).filter(Boolean);
            } else if (body.code) {
                codes = [String(body.code).trim()];
            }

            if (codes.length === 0) {
                return res.status(400).json({ success: false, error: 'Не указаны codes / code / all' });
            }

            /**
             * Авто-persist inline для одиночного режима. Используется кнопкой
             * «↗ В МС» в строке: пользователь мог ввести значение в input,
             * но не нажать blur/Enter — сохраняем перед push.
             */
            if (!body.all && codes.length === 1 && body.fields && typeof body.fields === 'object') {
                const incoming = {};
                for (const k of [...OVERRIDE_FIELDS, 'comment']) {
                    if (Object.prototype.hasOwnProperty.call(body.fields, k)) {
                        incoming[k] = body.fields[k];
                    }
                }
                if (Object.keys(incoming).length > 0) {
                    await persistOverride(db, {
                        code: codes[0],
                        incoming,
                        actorId,
                        actorName,
                        changedAt: new Date(),
                        note: 'sync_ms (auto-persist before push)',
                    });
                }
            }

            const placeholders = codes.map(() => '?').join(',');
            const [rows] = await db.query(
                `SELECT e.code, e.uuid, e.type, e.name,
                        ovr.value_lager
                   FROM ms_export e
                   LEFT JOIN dg_min_stock_overrides ovr ON ovr.code = e.code
                  WHERE e.code IN (${placeholders})`,
                codes,
            );

            const results = [];
            const byCode = new Map(rows.map((r) => [String(r.code), r]));
            for (const code of codes) {
                const r = byCode.get(code);
                if (!r) {
                    results.push({ code, ok: false, error: 'Не найдено в ms_export' });
                    continue;
                }
                if (r.value_lager == null) {
                    results.push({
                        code,
                        ok: false,
                        skipped: 'no-override',
                        error: 'Нет override для этой позиции',
                    });
                    continue;
                }
                const r1 = await pushMinStockToMs(r.uuid, r.type, r.value_lager, headers);
                if (r1.ok) {
                    await db.query(
                        `INSERT INTO dg_min_stock_log
                            (code, field, old_value, new_value, action, changed_by_user_id,
                             changed_by_name, note)
                         VALUES (?, 'value_lager', NULL, ?, 'sync_ms', ?, ?, ?)`,
                        [code, String(Number(r.value_lager)), actorId, actorName, body.note || null],
                    );
                }
                results.push(Object.assign({ code, name: r.name }, r1));

                /** Дроссель к МС (300 мс по умолчанию, как mp_*_delay_ms): только в балке. */
                if (codes.length > 1) {
                    await new Promise((resolve) => setTimeout(resolve, 300));
                }
            }

            const okCount = results.filter((x) => x.ok).length;
            const failCount = results.length - okCount;

            return res.json({
                success: failCount === 0,
                ok_count: okCount,
                fail_count: failCount,
                total: results.length,
                results,
            });
        } catch (e) {
            return res.status(500).json({ success: false, error: e && e.message ? e.message : 'Ошибка push в МС' });
        }
    });

    /**
     * GET /api/lagerplus/log?code=...&limit=&offset=
     * Журнал правок по конкретному товару (для tooltip / истории).
     */
    router.get('/log', async (req, res) => {
        try {
            await ensureLagerSchema(db);
            const code = String(req.query.code || '').trim();
            if (!code) return res.status(400).json({ success: false, error: 'Не указан code' });
            const limit = clampInt(req.query.limit, 1, 500, 100);
            const offset = clampInt(req.query.offset, 0, 100_000, 0);

            const [rows] = await db.query(
                `SELECT id, code, field, old_value, new_value, action,
                        changed_by_user_id, changed_by_name, note, changed_at
                   FROM dg_min_stock_log
                  WHERE code = ?
                  ORDER BY changed_at DESC, id DESC
                  LIMIT ? OFFSET ?`,
                [code, limit, offset],
            );
            const [cnt] = await db.query(
                'SELECT COUNT(*) AS total FROM dg_min_stock_log WHERE code = ?',
                [code],
            );
            res.json({
                success: true,
                code,
                total: Number((cnt && cnt[0] && cnt[0].total) || 0),
                limit,
                offset,
                rows: (rows || []).map((r) => ({
                    id: Number(r.id),
                    code: String(r.code),
                    field: String(r.field),
                    old_value: r.old_value,
                    new_value: r.new_value,
                    action: String(r.action),
                    changed_by_user_id: r.changed_by_user_id != null ? Number(r.changed_by_user_id) : null,
                    changed_by_name: r.changed_by_name ? String(r.changed_by_name) : '',
                    note: r.note ? String(r.note) : '',
                    changed_at: r.changed_at ? new Date(r.changed_at).toISOString() : null,
                })),
            });
        } catch (e) {
            res.status(500).json({ success: false, error: e && e.message ? e.message : 'Ошибка журнала' });
        }
    });

    return router;
}

module.exports = { createLagerplusRouter, ensureLagerSchema };
