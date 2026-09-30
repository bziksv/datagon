'use strict';

/**
 * Решения «Анализ товаров»: жизненный цикл SKU, do_not_order, цель НС.
 * Не путать с dg_purchase_overrides (закупки).
 * Журнал изменений — `dg_product_analysis_decisions_log` (паритет с dg_purchase_overrides_log).
 */

const LIFECYCLE = new Set([
    'none',
    'top',
    'hold',
    'boost',
    'boost_failed',
    'clearance',
    'exit',
]);

const DEFAULT_BOOST_DAYS = 30;

const LOG_FIELDS = new Set([
    'lifecycle',
    'do_not_order',
    'min_stock_target',
    'lock_proposed_min_stock',
    'boost_days',
    'decision_note',
]);

const FIELD_LABELS = {
    lifecycle: 'Решение',
    do_not_order: 'Не заказывать',
    min_stock_target: 'Цель НС',
    lock_proposed_min_stock: 'Фиксация предлагаемого',
    boost_days: 'Дней буста',
    decision_note: 'Комментарий',
};

const LIFECYCLE_LABELS = {
    none: 'Без решения',
    top: 'Топ',
    hold: 'Держать',
    boost: 'Буст',
    boost_failed: 'Буст не сработал',
    clearance: 'Распродажа',
    exit: 'Вывод',
};

const SOURCE_LABELS = {
    row: 'Строка',
    bulk: 'Массово',
    min_stock: 'Обнуление НС',
    purchase: 'Закупки',
    ui: 'UI',
};

let schemaReady = false;

async function ensureProductAnalysisDecisionsSchema(db) {
    if (schemaReady) return;
    await db.query(`
        CREATE TABLE IF NOT EXISTS dg_product_analysis_decisions (
            code VARCHAR(255) NOT NULL PRIMARY KEY,
            lifecycle VARCHAR(32) NOT NULL DEFAULT 'none',
            do_not_order TINYINT(1) NOT NULL DEFAULT 0,
            min_stock_target DECIMAL(15,3) NULL DEFAULT NULL,
            lock_proposed_min_stock TINYINT(1) NOT NULL DEFAULT 0,
            boost_started_at DATETIME NULL DEFAULT NULL,
            boost_days INT NULL DEFAULT NULL,
            decision_note VARCHAR(500) NULL,
            updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            updated_by_user_id INT NULL,
            updated_by_name VARCHAR(255) NULL,
            INDEX idx_pad_lifecycle (lifecycle),
            INDEX idx_pad_do_not_order (do_not_order),
            INDEX idx_pad_updated (updated_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await db.query(`
        CREATE TABLE IF NOT EXISTS dg_product_analysis_decisions_log (
            id BIGINT AUTO_INCREMENT PRIMARY KEY,
            code VARCHAR(255) NOT NULL,
            field VARCHAR(64) NOT NULL,
            old_value VARCHAR(255) NULL,
            new_value VARCHAR(255) NULL,
            source VARCHAR(32) NOT NULL DEFAULT 'ui',
            changed_by_user_id INT NULL,
            changed_by_name VARCHAR(255) NULL,
            changed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            INDEX idx_pad_log_code (code, changed_at),
            INDEX idx_pad_log_field (field),
            INDEX idx_pad_log_source (source)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    schemaReady = true;
}

function normalizeLifecycle(raw) {
    const s = String(raw || '').trim().toLowerCase();
    if (!s || s === 'null') return 'none';
    return LIFECYCLE.has(s) ? s : null;
}

function actorFields(actor) {
    const id = actor && actor.id != null ? Number(actor.id) : null;
    const name =
        (actor && (actor.display_name || actor.full_name || actor.username || actor.name)) ||
        null;
    return {
        userId: Number.isFinite(id) && id > 0 ? id : null,
        name: name ? String(name).slice(0, 255) : null,
    };
}

function formatLogValue(field, raw) {
    if (raw == null || raw === '') return null;
    if (field === 'lifecycle') {
        const k = String(raw).toLowerCase();
        return LIFECYCLE_LABELS[k] || String(raw).slice(0, 255);
    }
    if (field === 'do_not_order' || field === 'lock_proposed_min_stock') {
        return Number(raw) ? 'да' : 'нет';
    }
    if (field === 'min_stock_target' || field === 'boost_days') {
        const n = Number(raw);
        if (!Number.isFinite(n)) return String(raw).slice(0, 255);
        if (Math.abs(n - Math.round(n)) < 1e-9) return String(Math.round(n));
        return String(Number.parseFloat(n.toFixed(3)));
    }
    return String(raw).slice(0, 255);
}

function sameLogValue(field, a, b) {
    return formatLogValue(field, a) === formatLogValue(field, b);
}

async function insertDecisionLogRows(db, code, changes, actor, source) {
    if (!changes || !changes.length) return;
    const { userId, name } = actorFields(actor);
    const src = String(source || 'ui').slice(0, 32) || 'ui';
    for (const ch of changes) {
        if (!ch || !LOG_FIELDS.has(ch.field)) continue;
        await db.query(
            `INSERT INTO dg_product_analysis_decisions_log
                (code, field, old_value, new_value, source, changed_by_user_id, changed_by_name)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [
                code,
                ch.field,
                formatLogValue(ch.field, ch.oldVal),
                formatLogValue(ch.field, ch.newVal),
                src,
                userId,
                name,
            ],
        );
    }
}

/**
 * Upsert одного решения. Передавайте только поля, которые нужно менять
 * (undefined = не трогать; null для note/target — очистить).
 * @param {{ source?: string }} [opts] — source: row | bulk | min_stock | ui
 * @returns {Promise<{ decision: object, changes: Array<{field, oldVal, newVal}> }>}
 */
async function upsertProductDecision(db, codeRaw, patch, actor, opts = {}) {
    await ensureProductAnalysisDecisionsSchema(db);
    const code = String(codeRaw || '').trim();
    if (!code) throw new Error('Не указан code');
    if (!patch || typeof patch !== 'object') throw new Error('Пустой patch');
    const source = String((opts && opts.source) || 'ui').slice(0, 32) || 'ui';

    const { userId, name } = actorFields(actor);
    const [existingRows] = await db.query(
        `SELECT code, lifecycle, do_not_order, min_stock_target, lock_proposed_min_stock,
                boost_started_at, boost_days, decision_note
           FROM dg_product_analysis_decisions WHERE code = ? LIMIT 1`,
        [code],
    );
    const prev = existingRows && existingRows[0] ? existingRows[0] : null;

    let lifecycle = prev ? String(prev.lifecycle || 'none') : 'none';
    if (Object.prototype.hasOwnProperty.call(patch, 'lifecycle')) {
        const nextLc = normalizeLifecycle(patch.lifecycle);
        if (nextLc == null) throw new Error('Некорректный lifecycle');
        lifecycle = nextLc;
    }

    let doNotOrder = prev ? Number(prev.do_not_order || 0) : 0;
    if (Object.prototype.hasOwnProperty.call(patch, 'do_not_order')) {
        doNotOrder = patch.do_not_order ? 1 : 0;
    }

    let minStockTarget =
        prev && prev.min_stock_target != null ? Number(prev.min_stock_target) : null;
    if (Object.prototype.hasOwnProperty.call(patch, 'min_stock_target')) {
        if (patch.min_stock_target === null || patch.min_stock_target === '') {
            minStockTarget = null;
        } else {
            const n = Number(patch.min_stock_target);
            if (!Number.isFinite(n) || n < 0) throw new Error('Некорректный min_stock_target');
            minStockTarget = n;
        }
    }

    let lockProposed = prev ? Number(prev.lock_proposed_min_stock || 0) : 0;
    if (Object.prototype.hasOwnProperty.call(patch, 'lock_proposed_min_stock')) {
        lockProposed = patch.lock_proposed_min_stock ? 1 : 0;
    }

    let boostStarted = prev ? prev.boost_started_at : null;
    let boostDays = prev && prev.boost_days != null ? Number(prev.boost_days) : null;
    if (lifecycle === 'boost') {
        if (!boostStarted || Object.prototype.hasOwnProperty.call(patch, 'boost_started_at')) {
            boostStarted = patch.boost_started_at
                ? new Date(patch.boost_started_at)
                : new Date();
        }
        if (Object.prototype.hasOwnProperty.call(patch, 'boost_days')) {
            const bd = Number(patch.boost_days);
            boostDays = Number.isFinite(bd) && bd > 0 ? Math.floor(bd) : DEFAULT_BOOST_DAYS;
        } else if (boostDays == null) {
            boostDays = DEFAULT_BOOST_DAYS;
        }
    } else if (
        lifecycle === 'boost_failed' ||
        lifecycle === 'clearance' ||
        lifecycle === 'exit'
    ) {
        if (Object.prototype.hasOwnProperty.call(patch, 'boost_started_at')) {
            boostStarted = patch.boost_started_at ? new Date(patch.boost_started_at) : null;
        }
        if (Object.prototype.hasOwnProperty.call(patch, 'boost_days')) {
            const bd = Number(patch.boost_days);
            boostDays = Number.isFinite(bd) ? Math.floor(bd) : null;
        }
    }

    if (lifecycle === 'clearance' || lifecycle === 'exit') {
        if (!Object.prototype.hasOwnProperty.call(patch, 'do_not_order')) doNotOrder = 1;
        if (
            !Object.prototype.hasOwnProperty.call(patch, 'min_stock_target') &&
            (lifecycle === 'exit' || minStockTarget == null)
        ) {
            minStockTarget = 0;
        }
    }

    let note = prev ? prev.decision_note : null;
    if (Object.prototype.hasOwnProperty.call(patch, 'decision_note')) {
        const raw = patch.decision_note;
        note = raw == null || raw === '' ? null : String(raw).slice(0, 500);
    }

    const before = {
        lifecycle: prev ? String(prev.lifecycle || 'none') : 'none',
        do_not_order: prev ? Number(prev.do_not_order || 0) : 0,
        min_stock_target:
            prev && prev.min_stock_target != null ? Number(prev.min_stock_target) : null,
        lock_proposed_min_stock: prev ? Number(prev.lock_proposed_min_stock || 0) : 0,
        boost_days: prev && prev.boost_days != null ? Number(prev.boost_days) : null,
        decision_note: prev ? prev.decision_note : null,
    };
    const after = {
        lifecycle,
        do_not_order: doNotOrder,
        min_stock_target: minStockTarget,
        lock_proposed_min_stock: lockProposed,
        boost_days: boostDays,
        decision_note: note,
    };

    const changes = [];
    for (const field of LOG_FIELDS) {
        if (!sameLogValue(field, before[field], after[field])) {
            changes.push({ field, oldVal: before[field], newVal: after[field] });
        }
    }

    await db.query(
        `INSERT INTO dg_product_analysis_decisions
            (code, lifecycle, do_not_order, min_stock_target, lock_proposed_min_stock,
             boost_started_at, boost_days, decision_note, updated_by_user_id, updated_by_name)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
            lifecycle = VALUES(lifecycle),
            do_not_order = VALUES(do_not_order),
            min_stock_target = VALUES(min_stock_target),
            lock_proposed_min_stock = VALUES(lock_proposed_min_stock),
            boost_started_at = VALUES(boost_started_at),
            boost_days = VALUES(boost_days),
            decision_note = VALUES(decision_note),
            updated_by_user_id = VALUES(updated_by_user_id),
            updated_by_name = VALUES(updated_by_name)`,
        [
            code,
            lifecycle,
            doNotOrder,
            minStockTarget,
            lockProposed,
            boostStarted,
            boostDays,
            note,
            userId,
            name,
        ],
    );

    if (lockProposed && Object.prototype.hasOwnProperty.call(patch, 'lock_proposed_min_stock')) {
        await db.query(
            `INSERT INTO dg_purchase_overrides (code, proposed_min_stock)
             VALUES (?, 0)
             ON DUPLICATE KEY UPDATE proposed_min_stock = 0`,
            [code],
        );
    }
    if (
        !lockProposed &&
        Object.prototype.hasOwnProperty.call(patch, 'lock_proposed_min_stock')
    ) {
        await db.query(
            `UPDATE dg_purchase_overrides SET proposed_min_stock = NULL WHERE code = ?`,
            [code],
        );
    }

    await insertDecisionLogRows(db, code, changes, actor, source);

    const [outRows] = await db.query(
        `SELECT * FROM dg_product_analysis_decisions WHERE code = ? LIMIT 1`,
        [code],
    );
    return {
        decision: mapDecisionRow(outRows && outRows[0]),
        changes,
    };
}

function mapDecisionRow(r) {
    if (!r) return null;
    return {
        code: String(r.code || ''),
        lifecycle: String(r.lifecycle || 'none'),
        do_not_order: Number(r.do_not_order || 0) === 1,
        min_stock_target: r.min_stock_target == null ? null : Number(r.min_stock_target),
        lock_proposed_min_stock: Number(r.lock_proposed_min_stock || 0) === 1,
        boost_started_at: r.boost_started_at ? String(r.boost_started_at) : null,
        boost_days: r.boost_days == null ? null : Number(r.boost_days),
        decision_note: r.decision_note != null ? String(r.decision_note) : null,
        updated_at: r.updated_at ? String(r.updated_at) : null,
        updated_by_name: r.updated_by_name != null ? String(r.updated_by_name) : null,
    };
}

/**
 * Журнал по коду (и опционально полю).
 */
async function listProductDecisionLogs(db, opts = {}) {
    await ensureProductAnalysisDecisionsSchema(db);
    const code = String(opts.code || '').trim();
    if (!code) throw new Error('Не указан code');
    const limit = Math.min(500, Math.max(1, Number(opts.limit) || 100));
    const offset = Math.max(0, Number(opts.offset) || 0);
    const field = String(opts.field || '').trim();
    const params = [code];
    let where = 'WHERE code = ?';
    if (field) {
        if (!LOG_FIELDS.has(field)) throw new Error('Некорректный field');
        where += ' AND field = ?';
        params.push(field);
    }
    const [countRows] = await db.query(
        `SELECT COUNT(*) AS total FROM dg_product_analysis_decisions_log ${where}`,
        params,
    );
    const total = Number(countRows && countRows[0] ? countRows[0].total : 0);
    const [rows] = await db.query(
        `SELECT id, code, field, old_value, new_value, source,
                changed_by_user_id, changed_by_name, changed_at
           FROM dg_product_analysis_decisions_log ${where}
          ORDER BY changed_at DESC, id DESC
          LIMIT ? OFFSET ?`,
        [...params, limit, offset],
    );
    return {
        code,
        total,
        limit,
        offset,
        rows: (rows || []).map((r) => ({
            id: Number(r.id),
            code: String(r.code || ''),
            field: String(r.field || ''),
            field_label: FIELD_LABELS[r.field] || String(r.field || ''),
            old_value: r.old_value != null ? String(r.old_value) : null,
            new_value: r.new_value != null ? String(r.new_value) : null,
            source: String(r.source || 'ui'),
            source_label: SOURCE_LABELS[r.source] || String(r.source || 'ui'),
            changed_by_user_id: r.changed_by_user_id != null ? Number(r.changed_by_user_id) : null,
            changed_by_name: r.changed_by_name != null ? String(r.changed_by_name) : null,
            changed_at: r.changed_at ? String(r.changed_at) : null,
        })),
    };
}

function describePatchFields(patch) {
    if (!patch || typeof patch !== 'object') return [];
    const out = [];
    for (const field of LOG_FIELDS) {
        if (!Object.prototype.hasOwnProperty.call(patch, field)) continue;
        const label = FIELD_LABELS[field] || field;
        const v = formatLogValue(field, patch[field]);
        out.push({ field, label, value: v });
    }
    return out;
}

module.exports = {
    LIFECYCLE,
    LIFECYCLE_LABELS,
    FIELD_LABELS,
    SOURCE_LABELS,
    LOG_FIELDS,
    DEFAULT_BOOST_DAYS,
    ensureProductAnalysisDecisionsSchema,
    normalizeLifecycle,
    upsertProductDecision,
    mapDecisionRow,
    listProductDecisionLogs,
    describePatchFields,
    formatLogValue,
};
