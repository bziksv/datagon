'use strict';

const express = require('express');
const {
    toNum,
    round2,
    pctMpFromMonthTotal,
    DEFAULT_PLAN_AMOUNT,
    parseStoredSteps,
    cloneDefaultSteps,
} = require('../lib/managerSalesCalc');
const {
    MONTH_LABELS,
    COLUMN_LEGEND,
    profitBeforeTaxRow,
    buildRow,
    buildTotals,
    emptyManual,
} = require('../lib/opsSheetCalc');
const { restJson, credsFromSettings } = require('../lib/planfixClient');
const pf = require('../lib/opsSheetPlanfix');
const { getOpsPlanfixSyncMeta } = require('../lib/opsSheetPlanfixSyncRevision');

const SALES_SPECIALTY_NAME = 'Менеджер по продажам';
const MIN_YEAR = 2019;
const MAX_YEAR = 2100;

let schemaReady = false;

function currentYear() {
    return new Date().getFullYear();
}

function normYear(v, fallback) {
    const n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    const y = Math.round(n);
    if (y < MIN_YEAR || y > MAX_YEAR) return fallback;
    return y;
}

function normSyncMonth(v, fallback) {
    if (v === '' || v == null) return fallback;
    const n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    const m = Math.round(n);
    if (m === 0) return 0;
    return m >= 1 && m <= 12 ? m : fallback;
}

function normMonth(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return null;
    const m = Math.round(n);
    return m >= 1 && m <= 12 ? m : null;
}

function pageMode(req) {
    const actor = req.datagonActor || {};
    if (actor.username === 'admin') return 'full';
    const raw = actor.page_modes && actor.page_modes['ops-sheet'];
    return raw === 'view' || raw === 'hidden' || raw === 'full' ? raw : 'full';
}

function canWrite(req) {
    return pageMode(req) === 'full';
}

function actorId(req) {
    const id = req.datagonActor && req.datagonActor.id;
    const n = Number(id);
    return Number.isFinite(n) && n > 0 ? n : null;
}

function mysqlNow() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(
        d.getMinutes()
    )}:${p(d.getSeconds())}`;
}

const pfSyncJob = {
    active: false,
    dry_run: false,
    year: null,
    month: 0,
    stage: 'idle',
    message: 'Нет активного синка',
    pages: 0,
    fetched: 0,
    stored: 0,
    started_ms: 0,
    updated_ms: 0,
    last_error: null,
};

function markPfSync(patch) {
    Object.assign(pfSyncJob, patch, { updated_ms: Date.now() });
    console.log(
        '[ops-sheet/planfix-sync]',
        pfSyncJob.stage,
        pfSyncJob.message,
        `pages=${pfSyncJob.pages} fetched=${pfSyncJob.fetched} stored=${pfSyncJob.stored}`
    );
}

function pfSyncPublic() {
    const started = Number(pfSyncJob.started_ms) || 0;
    return {
        active: !!pfSyncJob.active,
        dry_run: !!pfSyncJob.dry_run,
        year: pfSyncJob.year,
        month: pfSyncJob.month != null ? pfSyncJob.month : 0,
        stage: pfSyncJob.stage,
        message: pfSyncJob.message,
        pages: pfSyncJob.pages || 0,
        fetched: pfSyncJob.fetched || 0,
        stored: pfSyncJob.stored || 0,
        elapsed_sec: started ? Math.max(0, Math.round((Date.now() - started) / 1000)) : 0,
        last_error: pfSyncJob.last_error || null,
    };
}

function formatPlanfixSyncError(e) {
    let msg = (e && e.message) || 'planfix sync failed';
    if (/fetch failed/i.test(msg)) {
        msg =
            'Planfix оборвал соединение во время выборки (fetch failed). Повторите синк; весь год лучше по месяцам, если снова оборвётся.';
    }
    if (/scope denied/i.test(msg) || /method not allowed/i.test(msg)) {
        msg =
            'Токену Planfix не хватает прав на задачи (POST /task/list). ' +
            'В Planfix: Управление аккаунтом → Доступ к API → у этого REST-ключа включите доступ к задачам, сохраните ключ в Настройках Datagon и повторите. ' +
            'Исходный ответ: ' +
            msg;
    }
    return msg;
}

const PF_SYNC_STALE_MS = 45 * 60 * 1000;

function pfSyncLockIsStale() {
    if (!pfSyncJob.active) return false;
    const t = Number(pfSyncJob.updated_ms) || Number(pfSyncJob.started_ms) || 0;
    return t > 0 && Date.now() - t > PF_SYNC_STALE_MS;
}

async function ensureSchema(db) {
    if (schemaReady) return;
    await db.query(`
        CREATE TABLE IF NOT EXISTS dg_ops_sheet_manual (
            id BIGINT AUTO_INCREMENT PRIMARY KEY,
            year SMALLINT NOT NULL,
            month TINYINT NOT NULL,
            manager_user_id INT NOT NULL,
            applications_count INT NULL,
            coefficient DECIMAL(12,4) NULL,
            paid_applications INT NULL,
            bonus_past DECIMAL(14,2) NULL,
            salary DECIMAL(14,2) NULL,
            updated_by INT NULL,
            updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            UNIQUE KEY uq_ops_ym_mgr (year, month, manager_user_id),
            KEY idx_ops_year (year)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await db.query(`
        CREATE TABLE IF NOT EXISTS dg_ops_planfix_tasks (
            task_id BIGINT NOT NULL PRIMARY KEY,
            assigner_id INT NULL,
            assigner_name VARCHAR(191) NOT NULL DEFAULT '',
            status_value VARCHAR(191) NOT NULL DEFAULT '',
            planfix_status VARCHAR(191) NOT NULL DEFAULT '',
            created_at DATETIME NOT NULL,
            synced_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            KEY idx_ops_pf_created (created_at),
            KEY idx_ops_pf_assigner (assigner_name),
            KEY idx_ops_pf_status (status_value)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    try {
        await db.query(
            `ALTER TABLE dg_ops_planfix_tasks
                ADD COLUMN planfix_status VARCHAR(191) NOT NULL DEFAULT '' AFTER status_value`
        );
    } catch (e) {
        if (!(e && (e.errno === 1060 || /duplicate column/i.test(String(e.message || ''))))) throw e;
    }
    await db.query(`
        UPDATE dg_ops_planfix_tasks
           SET planfix_status = status_value
         WHERE TRIM(IFNULL(planfix_status,'')) = ''
           AND TRIM(IFNULL(status_value,'')) <> ''
           AND status_value IN ('Новая','Черновик','В работе (Все)','Завершенная (Все)','Оплачена+Завершена (Все)','В работе','Завершенная')
    `);
    await db.query(`
        UPDATE dg_ops_planfix_tasks
           SET status_value = ''
         WHERE status_value IN ('Новая','Черновик','В работе (Все)','Завершенная (Все)','Оплачена+Завершена (Все)','В работе','Завершенная')
    `);
    await db.query(`
        DELETE FROM dg_ops_planfix_status_catalog
         WHERE status_value IN ('Новая','Черновик','В работе (Все)','Завершенная (Все)','Оплачена+Завершена (Все)','В работе','Завершенная')
    `);
    await db.query(`
        CREATE TABLE IF NOT EXISTS dg_ops_planfix_status_map (
            status_value VARCHAR(191) NOT NULL PRIMARY KEY,
            bucket VARCHAR(64) NOT NULL DEFAULT '',
            count_in_apps TINYINT NOT NULL DEFAULT 0,
            updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await db.query(`
        CREATE TABLE IF NOT EXISTS dg_ops_planfix_status_catalog (
            status_value VARCHAR(191) NOT NULL PRIMARY KEY,
            source VARCHAR(16) NOT NULL DEFAULT 'task',
            sort_order INT NOT NULL DEFAULT 0,
            is_separator TINYINT NOT NULL DEFAULT 0,
            updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    try {
        await db.query(
            `ALTER TABLE dg_ops_planfix_status_catalog ADD COLUMN sort_order INT NOT NULL DEFAULT 0`
        );
    } catch (e) {
        if (!(e && (e.errno === 1060 || /duplicate column/i.test(String(e.message || ''))))) throw e;
    }
    try {
        await db.query(
            `ALTER TABLE dg_ops_planfix_status_catalog ADD COLUMN is_separator TINYINT NOT NULL DEFAULT 0`
        );
    } catch (e) {
        if (!(e && (e.errno === 1060 || /duplicate column/i.test(String(e.message || ''))))) throw e;
    }
    await db.query(`
        CREATE TABLE IF NOT EXISTS dg_ops_planfix_report_status_counts (
            status_value VARCHAR(191) NOT NULL PRIMARY KEY,
            n INT NOT NULL DEFAULT 0,
            report_id INT NOT NULL DEFAULT 0,
            save_id INT NOT NULL DEFAULT 0,
            synced_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await db.query(`
        CREATE TABLE IF NOT EXISTS dg_ops_planfix_report_task (
            task_id BIGINT NOT NULL PRIMARY KEY,
            status_value VARCHAR(191) NOT NULL,
            report_id INT NOT NULL DEFAULT 0,
            save_id INT NOT NULL DEFAULT 0,
            synced_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            KEY idx_ops_pf_report_task_status (status_value)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await db.query(`
        CREATE TABLE IF NOT EXISTS dg_ops_planfix_task_dates (
            task_id BIGINT NOT NULL PRIMARY KEY,
            created_at DATETIME NOT NULL,
            KEY idx_ops_pf_task_dates_created (created_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await db.query(`
        CREATE TABLE IF NOT EXISTS dg_ops_planfix_report_meta (
            id TINYINT NOT NULL PRIMARY KEY DEFAULT 1,
            report_id INT NOT NULL DEFAULT 0,
            save_id INT NOT NULL DEFAULT 0,
            year INT NOT NULL DEFAULT 0,
            month INT NOT NULL DEFAULT 0,
            scope VARCHAR(16) NOT NULL DEFAULT 'all',
            is_generated TINYINT NOT NULL DEFAULT 0,
            synced_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await seedDealStatusCatalog(db);
    await assignMissingCatalogOrder(db);
    await migratePlanfixCreatedAtToMoscow(db);
    schemaReady = true;
}

const OPS_PLANFIX_CREATED_TZ_KEY = 'ops_planfix_created_at_tz';

async function migratePlanfixCreatedAtToMoscow(db) {
    const [rows] = await db.query(
        'SELECT setting_value FROM app_settings WHERE setting_key = ? LIMIT 1',
        [OPS_PLANFIX_CREATED_TZ_KEY]
    );
    const cur = rows && rows[0] ? String(rows[0].setting_value || '') : '';
    if (cur === 'europe_moscow') return;
    await db.query(
        'UPDATE dg_ops_planfix_tasks SET created_at = DATE_ADD(created_at, INTERVAL 3 HOUR)'
    );
    await db.query(
        `INSERT INTO app_settings (setting_key, setting_value) VALUES (?, 'europe_moscow')
         ON DUPLICATE KEY UPDATE setting_value = 'europe_moscow'`,
        [OPS_PLANFIX_CREATED_TZ_KEY]
    );
}

async function seedDealStatusCatalog(db) {
    const rows = pf.DEAL_STATUS_LIST_ORDER || [];
    if (!rows.length) return;
    const ph = rows.map(() => '(?,?,?,?)').join(',');
    const args = [];
    rows.forEach((raw, i) => {
        const s = String(raw || '').slice(0, 191);
        args.push(s, 'enum', i + 1, pf.isDealStatusSeparator(s) ? 1 : 0);
    });
    await db.query(
        `INSERT INTO dg_ops_planfix_status_catalog (status_value, source, sort_order, is_separator)
         VALUES ${ph}
         ON DUPLICATE KEY UPDATE
            is_separator = VALUES(is_separator),
            sort_order = IF(sort_order = 0, VALUES(sort_order), sort_order)`,
        args
    );
}

async function assignMissingCatalogOrder(db) {
    const [rows] = await db.query(
        `SELECT status_value FROM dg_ops_planfix_status_catalog
          WHERE sort_order = 0
          ORDER BY is_separator ASC, status_value`
    );
    if (!rows || !rows.length) return;
    const [mx] = await db.query(`SELECT COALESCE(MAX(sort_order), 0) AS n FROM dg_ops_planfix_status_catalog`);
    let next = Number(mx && mx[0] && mx[0].n) || 0;
    for (let i = 0; i < rows.length; i += 1) {
        next += 1;
        await db.query(`UPDATE dg_ops_planfix_status_catalog SET sort_order = ? WHERE status_value = ?`, [
            next,
            rows[i].status_value,
        ]);
    }
}

async function listSalesManagers(db) {
    const [users] = await db.query(
        `SELECT u.id, u.username, u.full_name
           FROM users u
           INNER JOIN specialties s ON s.id = u.specialty_id
          WHERE COALESCE(u.is_archived, 0) = 0
            AND s.name = ?
          ORDER BY COALESCE(NULLIF(u.full_name,''), u.username)`,
        [SALES_SPECIALTY_NAME]
    );
    return (users || []).map((u) => ({
        id: Number(u.id),
        username: u.username || '',
        full_name: u.full_name || u.username || '',
    }));
}

async function loadPlans(db) {
    const [rows] = await db.query(
        `SELECT id, manager_user_id, year, month, plan_amount, note, steps_json
           FROM dg_manager_sales_plans`
    );
    return rows || [];
}

function resolvePlan(plans, managerUserId, year, month) {
    const mid = Number(managerUserId) || 0;
    const y = Number(year) || 0;
    const m = Number(month) || 0;
    const hit = (a, b, c) =>
        (plans || []).find(
            (p) => Number(p.manager_user_id) === a && Number(p.year) === b && Number(p.month) === c
        );
    const monthOwn = m && mid ? hit(mid, y, m) : null;
    const managerYear = mid ? hit(mid, y, 0) : null;
    const yearBase = y ? hit(0, y, 0) : null;
    const fallback = hit(0, 0, 0);
    const row = monthOwn || managerYear || yearBase || fallback;
    const amount = row && row.plan_amount != null ? Number(row.plan_amount) : DEFAULT_PLAN_AMOUNT;
    let steps = null;
    [monthOwn, managerYear, yearBase, fallback].forEach((p) => {
        if (steps) return;
        const parsed = parseStoredSteps(p && p.steps_json);
        if (parsed) steps = parsed;
    });
    if (!steps) steps = cloneDefaultSteps();
    return {
        plan_amount: Number.isFinite(amount) && amount > 0 ? amount : DEFAULT_PLAN_AMOUNT,
        steps,
    };
}

/**
 * Агрегаты по credit-менеджеру и месяцу: turnover, прибыль, число оплаченных продаж.
 * Credit = COALESCE(handed_to_user_id, manager_user_id) — как в manager-sales.
 */
async function fetchMonthAggregates(db, year, managerIds) {
    const out = {};
    const ids = (managerIds || []).map((n) => Number(n)).filter((n) => Number.isFinite(n) && n > 0);
    if (!ids.length) return out;
    const ph = ids.map(() => '?').join(',');
    const [rows] = await db.query(
        `SELECT COALESCE(handed_to_user_id, manager_user_id) AS mid,
                MONTH(paid_at) AS m,
                id,
                our_invoice_no,
                amount_ex_delivery,
                amount_incl_stock,
                vat,
                delivery_to_us,
                diff
           FROM dg_manager_sales_rows
          WHERE year = ?
            AND archived_at IS NULL
            AND paid_at IS NOT NULL
            AND COALESCE(handed_to_user_id, manager_user_id) IN (${ph})`,
        [year].concat(ids)
    );
    (rows || []).forEach((r) => {
        const mid = Number(r.mid);
        const m = Number(r.m);
        if (!Number.isFinite(mid) || !m || m < 1 || m > 12) return;
        const key = `${mid}:${m}`;
        if (!out[key]) {
            out[key] = {
                turnover: 0,
                profit_before_tax: 0,
                profit_after_tax: 0,
                paid_applications: 0,
                _sales: new Set(),
            };
        }
        const cell = out[key];
        const inv = String(r.our_invoice_no || '')
            .trim()
            .replace(/\s+/g, '')
            .toLowerCase();
        const saleKey = inv ? `i:${inv}` : `id:${r.id}`;
        if (!cell._sales.has(saleKey)) {
            cell._sales.add(saleKey);
            cell.paid_applications += 1;
        }
        cell.turnover += toNum(r.amount_ex_delivery) || 0;
        cell.profit_before_tax += profitBeforeTaxRow(
            r.amount_ex_delivery,
            r.amount_incl_stock,
            r.vat,
            r.delivery_to_us
        );
        cell.profit_after_tax += toNum(r.diff) || 0;
    });
    Object.keys(out).forEach((k) => {
        delete out[k]._sales;
        out[k].turnover = round2(out[k].turnover);
        out[k].profit_before_tax = round2(out[k].profit_before_tax);
        out[k].profit_after_tax = round2(out[k].profit_after_tax);
    });
    return out;
}

async function loadManualMap(db, year) {
    const [rows] = await db.query(
        `SELECT year, month, manager_user_id, coefficient, bonus_past, salary
           FROM dg_ops_sheet_manual
          WHERE year = ?`,
        [year]
    );
    const map = {};
    (rows || []).forEach((r) => {
        const mid = Number(r.manager_user_id);
        const m = Number(r.month);
        map[`${mid}:${m}`] = {
            applications_count: null,
            coefficient: r.coefficient != null ? Number(r.coefficient) : null,
            bonus_past: r.bonus_past != null ? Number(r.bonus_past) : null,
            salary: r.salary != null ? Number(r.salary) : null,
        };
    });
    return map;
}

async function fetchPlanfixAppCounts(db, year, managers) {
    const b = pf.yearBounds(year);
    const [mapRows] = await db.query(
        `SELECT status_value, bucket, count_in_apps FROM dg_ops_planfix_status_map`
    );
    const countSet = {};
    (mapRows || []).forEach((r) => {
        if (Number(r.count_in_apps) === 1 && pf.BUCKET_KEYS.has(String(r.bucket || ''))) {
            countSet[String(r.status_value)] = 1;
        }
    });
    const [agg] = await db.query(
        `SELECT assigner_name, MONTH(created_at) AS m, status_value, COUNT(*) AS n
           FROM dg_ops_planfix_tasks
          WHERE created_at >= ? AND created_at < ?
          GROUP BY assigner_name, MONTH(created_at), status_value`,
        [b.fromSql, b.toSql]
    );
    const counts = {};
    const unmatched = {};
    (agg || []).forEach((row) => {
        const status = String(row.status_value || '');
        if (!countSet[status]) return;
        const mgr = pf.matchManagerByAssigner(row.assigner_name, managers);
        const n = Number(row.n) || 0;
        if (!mgr) {
            const k = String(row.assigner_name || '').trim() || '(без постановщика)';
            unmatched[k] = (unmatched[k] || 0) + n;
            return;
        }
        const m = Number(row.m);
        if (!m || m < 1 || m > 12) return;
        const key = `${mgr.id}:${m}`;
        counts[key] = (counts[key] || 0) + n;
    });
    return { counts, unmatched };
}

function manualWithApps(manual, appsCount) {
    const m = Object.assign(emptyManual(), manual || {});
    m.applications_count = appsCount != null ? Math.round(Number(appsCount) || 0) : 0;
    return m;
}

function buildYearSnapshot(managers, year, aggregates, plans, manualMap, planfixCounts) {
    const months = [];
    for (let month = 1; month <= 12; month += 1) {
        const rows = managers.map((mgr) => {
            const key = `${mgr.id}:${month}`;
            const agg = aggregates[key] || {
                turnover: 0,
                profit_before_tax: 0,
                profit_after_tax: 0,
                paid_applications: 0,
            };
            const plan = resolvePlan(plans, mgr.id, year, month);
            const pctMp = pctMpFromMonthTotal(agg.turnover, plan.plan_amount, plan.steps);
            const bonusCurrent = round2((agg.profit_after_tax / 100) * pctMp);
            const manual = manualWithApps(manualMap[key], planfixCounts[key] || 0);
            return buildRow(
                mgr,
                {
                    turnover: agg.turnover,
                    profit_before_tax: agg.profit_before_tax,
                    profit_after_tax: agg.profit_after_tax,
                    bonus_current: bonusCurrent,
                    paid_applications: agg.paid_applications || 0,
                    plan_amount: plan.plan_amount,
                    pct_mp: pctMp,
                },
                manual
            );
        });
        months.push({
            month,
            label: MONTH_LABELS[month],
            rows,
            totals: buildTotals(rows),
        });
    }
    return months;
}

function parseManualBody(body) {
    const out = {};
    if (Object.prototype.hasOwnProperty.call(body, 'coefficient')) {
        const v = body.coefficient;
        if (v === '' || v == null) out.coefficient = null;
        else {
            const n = toNum(v);
            if (n == null) {
                const err = new Error('Коэффициент: число');
                err.status = 400;
                throw err;
            }
            out.coefficient = n;
        }
    }
    if (Object.prototype.hasOwnProperty.call(body, 'bonus_past')) {
        const v = body.bonus_past;
        if (v === '' || v == null) out.bonus_past = null;
        else {
            const n = toNum(v);
            if (n == null) {
                const err = new Error('Премия с прошлыми месяцами: число');
                err.status = 400;
                throw err;
            }
            out.bonus_past = round2(n);
        }
    }
    if (Object.prototype.hasOwnProperty.call(body, 'salary')) {
        const v = body.salary;
        if (v === '' || v == null) out.salary = null;
        else {
            const n = toNum(v);
            if (n == null) {
                const err = new Error('Оклад: число');
                err.status = 400;
                throw err;
            }
            out.salary = round2(n);
        }
    }
    return out;
}

async function findDealStatusField(appSettings, onProgress) {
    const attempts = [
        ['POST', '/customfield/task/list', { offset: 0, pageSize: 100 }],
        ['GET', '/customfield/task/list', null],
        ['GET', '/customfield/task', null],
        ['POST', '/customfield/list', { offset: 0, pageSize: 100 }],
    ];
    let lastErr = null;
    let namedHint = '';
    for (let i = 0; i < attempts.length; i += 1) {
        const [method, path, body] = attempts[i];
        if (typeof onProgress === 'function') {
            onProgress(`Справочник полей Planfix ${i + 1}/${attempts.length}: ${method} ${path}`);
        }
        try {
            const payload = await restJson(appSettings, method, path, body, 12000);
            const fields = pf.collectCustomFields(payload);
            const hit = fields.find((f) => pf.isStatusFieldName(f.name || f.title));
            if (hit) {
                let enumValues = pf.enumValuesFromField(hit);
                const dirId = pf.directoryIdFromField(hit);
                if (dirId && enumValues.length < 2) {
                    try {
                        const dir = await restJson(appSettings, 'POST', `/directory/${dirId}/entry/list`, {
                            offset: 0,
                            pageSize: 100,
                            fields: 'id,name,value',
                        });
                        const entries = dir.entries || dir.directoryEntries || dir.items || [];
                        const extra = (Array.isArray(entries) ? entries : [])
                            .map((e) => pf.stringifyPfValue((e && (e.name || e.value)) || e))
                            .filter(Boolean);
                        extra.forEach((s) => {
                            if (enumValues.indexOf(s) < 0) enumValues.push(s);
                        });
                    } catch (_) {
                        /* справочник опционален */
                    }
                }
                return {
                    id: Number(hit.id) || 0,
                    name: String(hit.name || pf.STATUS_FIELD_NAME),
                    type: hit.type != null ? hit.type : null,
                    enumValues,
                };
            }
            if (fields.length) {
                namedHint = fields
                    .map((f) => f && (f.name || f.title))
                    .filter(Boolean)
                    .slice(0, 40)
                    .join(', ');
            }
        } catch (e) {
            lastErr = e;
        }
    }
    return {
        id: 0,
        name: pf.STATUS_FIELD_NAME,
        type: null,
        enumValues: [],
        lookup_error: namedHint
            ? `Поле «${pf.STATUS_FIELD_NAME}» не найдено. Есть: ${namedHint}`
            : lastErr && lastErr.message
              ? lastErr.message
              : 'Не удалось получить список полей Planfix — статусы снимем с задач по имени поля',
    };
}

function mapTaskRow(task, fieldId, fieldName, syncedAt) {
    const taskId = pf.pickTaskId(task);
    if (!taskId) return { skip: 'no_id' };
    const created = pf.parsePlanfixDateTime(
        task.dateTime || task.createdDate || task.createDate || task.date
    );
    if (!created) return { skip: 'no_date' };
    const asg = pf.pickAssigner(task);
    const custom = pf.extractCustomStatus(task, fieldId, fieldName);
    const system = pf.stringifyPfValue(task && task.status);
    const deal = custom && !pf.isPlanfixProcessStatusName(custom) ? custom : '';
    return {
        task_id: taskId,
        assigner_id: asg.id,
        assigner_name: String(asg.name || '').slice(0, 191),
        status_value: deal.slice(0, 191),
        planfix_status: system.slice(0, 191),
        created_at: created,
        synced_at: syncedAt,
    };
}

async function upsertTaskRows(db, rows) {
    if (!rows.length) return;
    const ph = rows.map(() => '(?,?,?,?,?,?,?)').join(',');
    const args = [];
    rows.forEach((r) => {
        args.push(
            r.task_id,
            r.assigner_id,
            r.assigner_name,
            r.status_value,
            r.planfix_status || '',
            r.created_at,
            r.synced_at
        );
    });
    await db.query(
        `INSERT INTO dg_ops_planfix_tasks
            (task_id, assigner_id, assigner_name, status_value, planfix_status, created_at, synced_at)
         VALUES ${ph}
         ON DUPLICATE KEY UPDATE
            assigner_id = VALUES(assigner_id),
            assigner_name = VALUES(assigner_name),
            status_value = IF(VALUES(status_value) = '', status_value, VALUES(status_value)),
            planfix_status = VALUES(planfix_status),
            created_at = VALUES(created_at),
            synced_at = VALUES(synced_at)`,
        args
    );
}

async function upsertCatalog(db, values, source) {
    const uniq = [];
    (values || []).forEach((v) => {
        const s = String(v || '').trim();
        if (!s || pf.isPlanfixProcessStatusName(s) || pf.isDealStatusSeparator(s)) return;
        if (uniq.indexOf(s) < 0) uniq.push(s);
    });
    if (!uniq.length) return;
    const ph = uniq.map(() => '(?,?)').join(',');
    const args = [];
    uniq.forEach((s) => {
        args.push(s.slice(0, 191), source);
    });
    await db.query(
        `INSERT INTO dg_ops_planfix_status_catalog (status_value, source)
         VALUES ${ph}
         ON DUPLICATE KEY UPDATE
            source = IF(source = 'enum', 'enum', VALUES(source)),
            updated_at = CURRENT_TIMESTAMP`,
        args
    );
    await assignMissingCatalogOrder(db);
}

async function listTasksPage(appSettings, { offset, pageSize, fieldId, year, month, withFieldFilter, dateType, assignerId, templateId }) {
    const b = pf.periodBounds(year, month);
    const filters = [
        {
            type: 12,
            operator: 'equal',
            value: { dateType: dateType || 'otherRange', dateFrom: b.fromPf, dateTo: b.toPf },
        },
    ];
    const aid = Number(assignerId);
    if (Number.isFinite(aid) && aid > 0) {
        filters.push({ type: 1, operator: 'equal', value: `user:${aid}` });
    }
    const tid = Number(templateId);
    if (Number.isFinite(tid) && tid > 0) {
        // Planfix type 51 не принимает «14;176404» как ИЛИ — такой value даёт 0 строк.
        filters.push({ type: 51, operator: 'equal', value: String(tid) });
    }
    if (withFieldFilter && fieldId) {
        filters.push({ type: 152, operator: 'equal', value: fieldId });
    }
    return restJson(
        appSettings,
        'POST',
        '/task/list',
        {
            offset: offset || 0,
            pageSize: pageSize || 100,
            fields: 'id,assigner,dateTime,customFieldData,status',
            filters,
        },
        60000
    );
}

async function listPlanfixUsers(appSettings, onProgress) {
    const out = [];
    let offset = 0;
    for (let page = 0; page < 50; page += 1) {
        if (typeof onProgress === 'function') {
            onProgress(`Сотрудники Planfix: offset ${offset}`);
        }
        const payload = await restJson(
            appSettings,
            'POST',
            '/user/list',
            { offset, pageSize: 100, fields: 'id,name,lastName,firstName' },
            30000
        );
        const users = pf.collectUsers(payload);
        if (!users.length) break;
        users.forEach((u) => {
            const id = Number(u && u.id);
            if (!Number.isFinite(id) || id <= 0) return;
            out.push({ id, name: pf.pickUserDisplayName(u) });
        });
        if (users.length < 100) break;
        offset += users.length;
    }
    return out;
}

function matchAssignerIds(pfUsers, managers) {
    const ids = [];
    const names = [];
    const mgrHits = new Set();
    (pfUsers || []).forEach((u) => {
        const mgr = pf.matchManagerByAssigner(u.name, managers);
        if (!mgr) return;
        if (ids.indexOf(u.id) >= 0) return;
        ids.push(u.id);
        names.push(u.name || mgr.full_name || mgr.username);
        mgrHits.add(mgr.id);
    });
    return { ids, names, managersMatched: mgrHits.size };
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function findDealStatusReport(appSettings, onProgress) {
    const ids = pf.DEAL_STATUS_REPORT_IDS || [450666];
    for (let i = 0; i < ids.length; i += 1) {
        const id = ids[i];
        if (typeof onProgress === 'function') {
            onProgress(`Ищем отчёт со «Статус Сделки/Письма»: GET /report/${id}`);
        }
        try {
            const det = await restJson(appSettings, 'GET', `/report/${id}`, null, 15000);
            const fields = pf.collectReportFields(det);
            const hit = fields.find((f) => pf.isStatusFieldName(f && f.name));
            if (hit) {
                const name =
                    (det.repost && det.repost.name) ||
                    (det.report && det.report.name) ||
                    String(hit.name || pf.STATUS_FIELD_NAME);
                return { id, name, field_id: Number(hit.id) || 0 };
            }
        } catch (_) {
            /* следующий кандидат */
        }
    }
    return { id: 450666, name: pf.STATUS_FIELD_NAME, field_id: 0 };
}

function pickBestReportSave(saves) {
    const arr = (saves || []).filter((s) => s && s.id);
    arr.sort((a, b) => {
        const cc = (Number(b.chunksCount) || 0) - (Number(a.chunksCount) || 0);
        if (cc) return cc;
        return Number(b.id) - Number(a.id);
    });
    return arr[0] || null;
}

async function generateDealStatusReport(appSettings, reportId, onProgress) {
    if (typeof onProgress === 'function') {
        onProgress(`Генерируем отчёт Planfix ${reportId} («${pf.STATUS_FIELD_NAME}»)`);
    }
    const gen = await restJson(appSettings, 'POST', `/report/${reportId}/generate`, {}, 30000);
    const requestId = gen && gen.requestId;
    if (!requestId) return null;
    for (let i = 0; i < 40; i += 1) {
        await sleep(3000);
        const st = await restJson(appSettings, 'GET', `/report/status/${requestId}`, null, 20000);
        if (typeof onProgress === 'function') {
            onProgress(`Отчёт ${reportId}: ${st && st.status ? st.status : '…'} (${i + 1}/40)`);
        }
        const save = st && (st.save || st.reportSave);
        if (st && st.status === 'ready' && save && save.id) return save;
        if (st && st.status && st.status !== 'in_progress' && st.status !== 'processing') {
            if (save && save.id) return save;
            return null;
        }
    }
    return null;
}

async function readDealStatusReportPairs(appSettings, reportId, save, onProgress) {
    let chunks = Math.max(1, Number(save && save.chunksCount) || 1);
    const byTask = new Map();
    const unique = [];
    let hint = {};
    let c = 0;
    // chunksCount в list иногда врёт/пустой — читаем, пока чанки не кончатся (потолок 40).
    const maxChunks = Math.max(chunks, 40);
    for (; c < maxChunks; c += 1) {
        if (typeof onProgress === 'function') {
            onProgress(`Читаем «${pf.STATUS_FIELD_NAME}»: чанк ${c + 1}/${chunks > 1 ? chunks : '?'}`);
        }
        let payload;
        try {
            payload = await restJson(
                appSettings,
                'POST',
                `/report/${reportId}/save/${save.id}/data?chunk=${c}`,
                {},
                60000
            );
        } catch (e) {
            if (c === 0) throw e;
            break;
        }
        const parsed = pf.parseDealStatusReportRows(payload, hint);
        hint = { taskIdx: parsed.taskIdx, statusIdx: parsed.statusIdx };
        const pairs = parsed.pairs || [];
        if (!pairs.length && c > 0) break;
        if (!pairs.length && c === 0) break;
        pairs.forEach((p) => {
            byTask.set(p.task_id, p.status_value);
            if (unique.indexOf(p.status_value) < 0) unique.push(p.status_value);
        });
        if (Number(save && save.chunksCount) > 0 && c + 1 >= Number(save.chunksCount)) break;
        // если chunksCount не задан — продолжаем до пустого чанка
        if (!(Number(save && save.chunksCount) > 0) && pairs.length < 10 && c > 0) break;
    }
    return { byTask, unique, chunks: Math.max(1, c), save_id: save.id };
}

async function upsertReportMeta(db, meta) {
    const rid = meta && Number(meta.report_id) ? Number(meta.report_id) : 0;
    const sid = meta && Number(meta.save_id) ? Number(meta.save_id) : 0;
    const year = meta && Number(meta.year) ? Number(meta.year) : 0;
    const month = meta && Number(meta.month) ? Number(meta.month) : 0;
    const scope = meta && meta.scope === 'period' ? 'period' : 'all';
    const isGenerated = meta && meta.generated ? 1 : 0;
    const ts = mysqlNow();
    await db.query(
        `INSERT INTO dg_ops_planfix_report_meta
            (id, report_id, save_id, year, month, scope, is_generated, synced_at)
         VALUES (1, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
            report_id = VALUES(report_id),
            save_id = VALUES(save_id),
            year = VALUES(year),
            month = VALUES(month),
            scope = VALUES(scope),
            is_generated = VALUES(is_generated),
            synced_at = VALUES(synced_at)`,
        [rid, sid, year, month, scope, isGenerated, ts]
    );
}

async function loadReportMeta(db) {
    try {
        const [rows] = await db.query(
            `SELECT report_id, save_id, year, month, scope, is_generated, synced_at
               FROM dg_ops_planfix_report_meta WHERE id = 1 LIMIT 1`
        );
        return rows && rows[0] ? rows[0] : null;
    } catch (e) {
        if (e && (e.errno === 1146 || /doesn't exist/i.test(String(e.message || '')))) return null;
        throw e;
    }
}

async function applyReportStatuses(db, byTask) {
    if (!byTask || !byTask.size) return 0;
    const grouped = new Map();
    byTask.forEach((status, taskId) => {
        if (!status || pf.isPlanfixProcessStatusName(status)) return;
        if (!grouped.has(status)) grouped.set(status, []);
        grouped.get(status).push(taskId);
    });
    let applied = 0;
    const entries = [...grouped.entries()];
    for (let g = 0; g < entries.length; g += 1) {
        const status = entries[g][0];
        const ids = entries[g][1];
        for (let i = 0; i < ids.length; i += 400) {
            const slice = ids.slice(i, i + 400);
            const ph = slice.map(() => '?').join(',');
            const [ret] = await db.query(
                `UPDATE dg_ops_planfix_tasks SET status_value = ? WHERE task_id IN (${ph})`,
                [status, ...slice]
            );
            applied += Number(ret && ret.affectedRows) || 0;
        }
    }
    return applied;
}

async function upsertReportStatusCounts(db, byTask, meta) {
    await db.query('DELETE FROM dg_ops_planfix_report_status_counts');
    const countBy = new Map();
    (byTask || new Map()).forEach((status) => {
        const s = String(status || '').trim();
        if (!s || pf.isPlanfixProcessStatusName(s) || pf.isDealStatusSeparator(s)) return;
        countBy.set(s, (countBy.get(s) || 0) + 1);
    });
    if (!countBy.size) return 0;
    const rows = [...countBy.entries()];
    const ph = rows.map(() => '(?,?,?,?,?)').join(',');
    const args = [];
    const rid = meta && Number(meta.report_id) ? Number(meta.report_id) : 0;
    const sid = meta && Number(meta.save_id) ? Number(meta.save_id) : 0;
    const ts = mysqlNow();
    rows.forEach(([status, n]) => {
        args.push(status.slice(0, 191), n, rid, sid, ts);
    });
    await db.query(
        `INSERT INTO dg_ops_planfix_report_status_counts (status_value, n, report_id, save_id, synced_at)
         VALUES ${ph}`,
        args
    );
    return rows.length;
}

async function upsertReportTasks(db, byTask, meta) {
    await db.query('DELETE FROM dg_ops_planfix_report_task');
    const rows = [];
    (byTask || new Map()).forEach((status, tid) => {
        const s = String(status || '').trim();
        if (!s || pf.isPlanfixProcessStatusName(s) || pf.isDealStatusSeparator(s)) return;
        const id = Number(tid);
        if (!Number.isFinite(id) || id <= 0) return;
        rows.push({ task_id: id, status_value: s.slice(0, 191) });
    });
    if (!rows.length) return 0;
    const rid = meta && Number(meta.report_id) ? Number(meta.report_id) : 0;
    const sid = meta && Number(meta.save_id) ? Number(meta.save_id) : 0;
    const ts = mysqlNow();
    for (let i = 0; i < rows.length; i += 400) {
        const slice = rows.slice(i, i + 400);
        const ph = slice.map(() => '(?,?,?,?,?)').join(',');
        const args = [];
        slice.forEach((r) => {
            args.push(r.task_id, r.status_value, rid, sid, ts);
        });
        await db.query(
            `INSERT INTO dg_ops_planfix_report_task (task_id, status_value, report_id, save_id, synced_at)
             VALUES ${ph}`,
            args
        );
    }
    return rows.length;
}

async function upsertTaskDates(db, rows) {
    if (!rows || !rows.length) return 0;
    for (let i = 0; i < rows.length; i += 400) {
        const slice = rows.slice(i, i + 400);
        const ph = slice.map(() => '(?,?)').join(',');
        const args = [];
        slice.forEach((r) => {
            args.push(r.task_id, r.created_at);
        });
        await db.query(
            `INSERT INTO dg_ops_planfix_task_dates (task_id, created_at)
             VALUES ${ph}
             ON DUPLICATE KEY UPDATE created_at = VALUES(created_at)`,
            args
        );
    }
    return rows.length;
}

async function refreshTaskDatesFromSheet(db) {
    await db.query(`
        INSERT INTO dg_ops_planfix_task_dates (task_id, created_at)
        SELECT task_id, created_at FROM dg_ops_planfix_tasks
        ON DUPLICATE KEY UPDATE created_at = VALUES(created_at)
    `);
}

async function indexAllTaskDatesForPeriod(appSettings, db, year, month, onProgress) {
    // Второй полный /task/list без шаблона/постановщика на «весь год» — десятки тысяч
    // offset и часы поверх уже записанных заявок листа. Для месяца гистограмма отчёта
    // берётся из generate, даты листа достаточно скопировать из dg_ops_planfix_tasks.
    if (typeof onProgress === 'function') {
        onProgress('Копируем даты из заявок листа (без второго обхода всего аккаунта)');
    }
    await refreshTaskDatesFromSheet(db);
    return 0;
}

async function reportOverlapsLocalPeriod(db, byTask, year, month) {
    const ids = [...(byTask || new Map()).keys()];
    if (!ids.length) return false;
    const b = pf.periodBounds(year, month);
    for (let i = 0; i < ids.length; i += 400) {
        const slice = ids.slice(i, i + 400);
        const ph = slice.map(() => '?').join(',');
        const [rows] = await db.query(
            `SELECT 1 AS x FROM dg_ops_planfix_tasks
              WHERE task_id IN (${ph}) AND created_at >= ? AND created_at < ?
              LIMIT 1`,
            [...slice, b.fromSql, b.toSql]
        );
        if (rows && rows.length) return true;
    }
    return false;
}

async function enrichFromDealStatusReport(appSettings, db, onProgress, year, month) {
    const ids = pf.DEAL_STATUS_REPORT_IDS || [450694];
    // И месяц, и «весь год»: всегда generate. Период только в UI Planfix (API дат не принимает).
    // Толстый сейв + срез по датам занижает гистограмму (год: Поставщик 4704 вместо цифр Planfix).
    const periodMonth = Number(month) >= 1 && Number(month) <= 12 ? Number(month) : 0;
    const forcePeriodGenerate = true;
    const merged = new Map();
    const unique = [];
    const used = [];
    let generate_error = '';
    let generated = false;
    for (let i = 0; i < ids.length; i += 1) {
        const id = ids[i];
        if (typeof onProgress === 'function') {
            onProgress(
                periodMonth
                    ? `Отчёт ${id}: generate за месяц (период как в Planfix UI)`
                    : `Отчёт ${id}: generate за весь ${year} (период как в Planfix UI)`
            );
        }
        let save = null;
        let localGenerated = false;
        try {
            const det = await restJson(appSettings, 'GET', `/report/${id}`, null, 15000);
            const fields = pf.collectReportFields(det);
            if (!fields.some((f) => pf.isStatusFieldName(f && f.name))) continue;

            try {
                const fresh = await generateDealStatusReport(appSettings, id, onProgress);
                if (fresh && fresh.id) {
                    localGenerated = true;
                    generated = true;
                    save = { id: fresh.id, chunksCount: Number(fresh.chunksCount) || 1 };
                }
            } catch (e) {
                generate_error = e && e.message ? e.message : String(e);
            }
            if (!save || !save.id) {
                const list = await restJson(
                    appSettings,
                    'POST',
                    `/report/${id}/save/list`,
                    { offset: 0, pageSize: 20, fields: 'id,name,dateTime,chunksCount' },
                    20000
                );
                save = pickBestReportSave(pf.collectReportSaves(list));
            }
        } catch (e) {
            generate_error = e && e.message ? e.message : String(e);
            continue;
        }
        if (!save || !save.id) continue;
        if (!save.chunksCount) save.chunksCount = 1;
        let read = await readDealStatusReportPairs(appSettings, id, save, onProgress);
        let overlaps = year
            ? await reportOverlapsLocalPeriod(db, read.byTask, year, month)
            : true;
        if (!overlaps && !localGenerated) {
            if (typeof onProgress === 'function') {
                onProgress(
                    `Сейв отчёта ${id} не содержит задач выбранного периода — generate в Planfix`
                );
            }
            try {
                const fresh = await generateDealStatusReport(appSettings, id, onProgress);
                if (fresh && fresh.id) {
                    localGenerated = true;
                    generated = true;
                    save = { id: fresh.id, chunksCount: Number(fresh.chunksCount) || 1 };
                    if (!save.chunksCount) save.chunksCount = 1;
                    read = await readDealStatusReportPairs(appSettings, id, save, onProgress);
                    overlaps = await reportOverlapsLocalPeriod(db, read.byTask, year, month);
                }
            } catch (e) {
                generate_error = e && e.message ? e.message : String(e);
            }
        }
        const score = pf.scoreDealStatusUniques(read.unique);
        if (score < 1) continue;
        const dealUniques = (read.unique || []).filter((s) => s && !pf.isPlanfixProcessStatusName(s));

        if (localGenerated) {
            // Только свежий сейв периода — не мержим толстые исторические.
            merged.clear();
            unique.length = 0;
            used.length = 0;
            read.byTask.forEach((val, tid) => {
                if (!val || pf.isPlanfixProcessStatusName(val)) return;
                merged.set(tid, val);
            });
            dealUniques.forEach((s) => {
                if (unique.indexOf(s) < 0) unique.push(s);
            });
            used.push({
                report_id: id,
                save_id: read.save_id,
                chunks: read.chunks,
                report_rows: read.byTask.size,
                score,
                covers_period: true,
            });
            break;
        }

        read.byTask.forEach((val, tid) => {
            if (!val || pf.isPlanfixProcessStatusName(val)) return;
            merged.set(tid, val);
        });
        dealUniques.forEach((s) => {
            if (unique.indexOf(s) < 0) unique.push(s);
        });
        used.push({
            report_id: id,
            save_id: read.save_id,
            chunks: read.chunks,
            report_rows: read.byTask.size,
            score,
            covers_period: !!overlaps,
        });
    }
    if (!used.length) {
        const err = new Error(
            generate_error ||
                `Нет отчёта Planfix, где «${pf.STATUS_FIELD_NAME}» — справочник сделки (не статус процесса)`
        );
        err.status = 502;
        throw err;
    }
    if (typeof onProgress === 'function') {
        onProgress(`Пишем справочник «${pf.STATUS_FIELD_NAME}» (${merged.size} задач, ${unique.length} значений)`);
    }
    const applied = await applyReportStatuses(db, merged);
    await upsertCatalog(db, unique, 'report');
    await upsertReportStatusCounts(db, merged, used[0]);
    await upsertReportTasks(db, merged, used[0]);
    await upsertReportMeta(db, {
        report_id: used[0].report_id,
        save_id: used[0].save_id,
        year: Number(year) || 0,
        month: periodMonth,
        scope: 'period',
        generated,
    });
    await refreshTaskDatesFromSheet(db);
    return {
        report_id: used[0].report_id,
        reports: used,
        save_id: used[0].save_id,
        chunks: used.reduce((n, r) => n + (r.chunks || 0), 0),
        report_rows: merged.size,
        statuses_applied: applied,
        unique_statuses: unique,
        generated,
        covers_period: used.some((r) => r.covers_period),
        scope: 'period',
        generate_error: generate_error || undefined,
    };
}

async function loadPlanfixPanel(db, year, managers, month) {
    const m = month == null ? 0 : month;
    const b = pf.periodBounds(year, m);
    const periodLabel = b.month ? `${MONTH_LABELS[b.month]} ${year}` : `весь ${year}`;
    const [mapRows] = await db.query(
        `SELECT status_value, bucket, count_in_apps FROM dg_ops_planfix_status_map ORDER BY status_value`
    );
    const [catRows] = await db.query(
        `SELECT status_value, source, sort_order, is_separator
           FROM dg_ops_planfix_status_catalog`
    );
    (catRows || []).sort((a, b) => {
        const ao = Number(a.sort_order) || 0;
        const bo = Number(b.sort_order) || 0;
        if (!ao && bo) return 1;
        if (ao && !bo) return -1;
        if (ao !== bo) return ao - bo;
        return String(a.status_value).localeCompare(String(b.status_value), 'ru');
    });
    const [taskStatusRows] = await db.query(
        `SELECT status_value, COUNT(*) AS n
           FROM dg_ops_planfix_tasks
          WHERE created_at >= ? AND created_at < ?
          GROUP BY status_value`,
        [b.fromSql, b.toSql]
    );
    const [totRows] = await db.query(
        `SELECT COUNT(*) AS n, MAX(synced_at) AS last_synced_at
           FROM dg_ops_planfix_tasks
          WHERE created_at >= ? AND created_at < ?`,
        [b.fromSql, b.toSql]
    );
    let reportCountRows = [];
    let reportMeta = null;
    let hasReportCounts = false;
    try {
        const metaRow = await loadReportMeta(db);
        const reqMonth = Number(b.month) || 0;
        const periodScoped =
            metaRow &&
            String(metaRow.scope || '') === 'period' &&
            Number(metaRow.year) === Number(year) &&
            Number(metaRow.month) === reqMonth;
        if (periodScoped) {
            // Сейв сгенерирован при синке этого месяца (период в Planfix UI) — гистограмма 1:1 с Planfix.
            const [rr] = await db.query(
                `SELECT status_value, n, report_id, save_id, synced_at FROM dg_ops_planfix_report_status_counts`
            );
            reportCountRows = rr || [];
            hasReportCounts = reportCountRows.length > 0;
            reportMeta = {
                report_id: Number(metaRow.report_id) || 0,
                save_id: Number(metaRow.save_id) || 0,
                synced_at: metaRow.synced_at || null,
                scope: 'period',
                year: Number(metaRow.year) || 0,
                month: Number(metaRow.month) || 0,
            };
        } else {
            const [[snap]] = await db.query(
                `SELECT COUNT(*) AS n, MAX(report_id) AS report_id, MAX(save_id) AS save_id, MAX(synced_at) AS synced_at
                   FROM dg_ops_planfix_report_task`
            );
            hasReportCounts = Number(snap && snap.n) > 0;
            if (hasReportCounts) {
                reportMeta = {
                    report_id: Number(snap.report_id) || 0,
                    save_id: Number(snap.save_id) || 0,
                    synced_at: snap.synced_at || null,
                    scope: metaRow ? String(metaRow.scope || 'all') : 'all',
                };
                const [rr] = await db.query(
                    `SELECT r.status_value, COUNT(*) AS n
                       FROM dg_ops_planfix_report_task r
                       INNER JOIN dg_ops_planfix_task_dates d ON d.task_id = r.task_id
                      WHERE d.created_at >= ? AND d.created_at < ?
                      GROUP BY r.status_value`,
                    [b.fromSql, b.toSql]
                );
                reportCountRows = rr || [];
            }
        }
    } catch (e) {
        if (!(e && (e.errno === 1146 || /doesn't exist/i.test(String(e.message || ''))))) throw e;
        hasReportCounts = false;
        reportCountRows = [];
    }
    const mapBy = {};
    (mapRows || []).forEach((r) => {
        mapBy[String(r.status_value)] = {
            bucket: String(r.bucket || ''),
            count_in_apps: Number(r.count_in_apps) === 1,
        };
    });
    const countBy = {};
    (taskStatusRows || []).forEach((r) => {
        countBy[String(r.status_value || '')] = Number(r.n) || 0;
    });
    const reportBy = {};
    let reportTotal = 0;
    (reportCountRows || []).forEach((r) => {
        const k = String(r.status_value || '');
        const n = Number(r.n) || 0;
        reportBy[k] = n;
        reportTotal += n;
    });
    const names = {};
    const catMeta = {};
    const catOrder = [];
    (catRows || []).forEach((r) => {
        const k = String(r.status_value);
        names[k] = r.source || 'task';
        catMeta[k] = {
            sort_order: Number(r.sort_order) || 0,
            is_separator: Number(r.is_separator) === 1 || pf.isDealStatusSeparator(k),
        };
        catOrder.push(k);
    });
    Object.keys(countBy).forEach((k) => {
        if (!names[k]) names[k] = 'task';
    });
    Object.keys(reportBy).forEach((k) => {
        if (!names[k]) names[k] = 'report';
    });
    Object.keys(mapBy).forEach((k) => {
        if (!names[k]) names[k] = 'map';
    });
    if (!catOrder.length) {
        (pf.DEAL_STATUS_LIST_ORDER || []).forEach((raw, i) => {
            const k = String(raw);
            if (!names[k]) names[k] = 'enum';
            if (!catMeta[k]) {
                catMeta[k] = { sort_order: i + 1, is_separator: pf.isDealStatusSeparator(k) };
                catOrder.push(k);
            }
        });
    }
    const extras = Object.keys(names).filter((k) => !catMeta[k]);
    extras.sort((a, b) => a.localeCompare(b, 'ru'));
    const ordered = catOrder.concat(extras);
    const statuses = ordered
        .filter((status_value) => status_value && !pf.isPlanfixProcessStatusName(status_value))
        .map((status_value, idx) => {
            const meta = catMeta[status_value] || {};
            const isSep = !!meta.is_separator || pf.isDealStatusSeparator(status_value);
            const saved = mapBy[status_value];
            const suggested = saved && saved.bucket ? '' : pf.suggestBucket(status_value);
            const bucket = (saved && saved.bucket) || '';
            let countIn = saved ? !!saved.count_in_apps : false;
            if (!saved && suggested) countIn = pf.countDefaultForBucket(suggested);
            return {
                status_value,
                source: names[status_value],
                sort_order: meta.sort_order || idx + 1,
                is_separator: isSep,
                tasks_in_year: isSep ? 0 : countBy[status_value] || 0,
                tasks_n: isSep ? 0 : countBy[status_value] || 0,
                tasks_n_report: isSep ? 0 : hasReportCounts ? reportBy[status_value] || 0 : null,
                bucket: isSep ? '' : bucket,
                suggested_bucket: isSep ? '' : suggested,
                count_in_apps: isSep ? false : countIn,
                mapped: !isSep && !!(saved && saved.bucket),
            };
        });
    const { unmatched } = await fetchPlanfixAppCounts(db, year, managers);
    const unmatchedList = Object.keys(unmatched)
        .sort((a, b) => unmatched[b] - unmatched[a])
        .map((name) => ({ name, tasks: unmatched[name] }));
    const tot = totRows && totRows[0] ? totRows[0] : {};
    const emptyStatus = Number(countBy[''] || 0);
    return {
        statuses,
        unmatched_assigners: unmatchedList,
        local_total: Number(tot.n) || 0,
        last_synced_at: tot.last_synced_at || null,
        unmapped: statuses.filter((s) => !s.is_separator && !s.mapped && s.status_value).length,
        month: b.month || 0,
        period: periodLabel,
        empty_status: emptyStatus,
        with_status: Math.max(0, (Number(tot.n) || 0) - emptyStatus),
        report_total: hasReportCounts ? reportTotal : null,
        report_meta: reportMeta,
    };
}

function composeMonthRow(mgr, agg, plan, manual) {
    const pctMp = pctMpFromMonthTotal(agg.turnover, plan.plan_amount, plan.steps);
    const bonusCurrent = round2((agg.profit_after_tax / 100) * pctMp);
    return buildRow(
        mgr,
        {
            turnover: agg.turnover,
            profit_before_tax: agg.profit_before_tax,
            profit_after_tax: agg.profit_after_tax,
            bonus_current: bonusCurrent,
            paid_applications: agg.paid_applications || 0,
            plan_amount: plan.plan_amount,
            pct_mp: pctMp,
        },
        manual
    );
}

module.exports = function opsSheetRouterFactory(db, appSettings) {
    const router = express.Router();
    const settings = appSettings || {};

    router.get('/meta', async (req, res) => {
        try {
            await ensureSchema(db);
            const cy = currentYear();
            const [yearRows] = await db.query(
                'SELECT DISTINCT year FROM dg_manager_sales_rows ORDER BY year DESC'
            );
            const years = (yearRows || []).map((r) => Number(r.year)).filter((y) => Number.isFinite(y));
            if (!years.includes(cy)) years.unshift(cy);
            const managers = await listSalesManagers(db);
            const { token } = credsFromSettings(settings);
            res.json({
                success: true,
                year: cy,
                years,
                managers,
                can_write: canWrite(req),
                columns: COLUMN_LEGEND,
                planfix_configured: !!token,
                sync_script: getOpsPlanfixSyncMeta(),
                status_buckets: pf.STATUS_BUCKETS,
                formulas: {
                    tax_pct: 16,
                    profit_before_tax: 'SUM(net − delivery), net = F − K − vatAmount',
                    profit_after_tax: 'SUM(diff)',
                    profit_pct: 'profit_after_tax / turnover × 100',
                    bonus_current: 'SUM(diff) × pct_mp / 100',
                    applications_count:
                        'COUNT задач Planfix (постановщик = менеджер, месяц = дата создания, статус в корзине с «в кол-во заявок»)',
                    paid_applications: 'COUNT DISTINCT № счёта (или строки без счёта) credit-менеджера за месяц',
                    apps_per_sale: 'applications_count / paid_applications',
                    avg_check: 'turnover / paid_applications',
                    fact_profit: 'profit_after_tax − bonus_current − salary',
                    salary_paid: 'salary + bonus_past',
                    company_profit: 'profit_after_tax − salary_paid',
                    company_pct: 'company_profit / turnover × 100',
                },
            });
        } catch (e) {
            console.error('[ops-sheet/meta]', e);
            res.status(500).json({ success: false, error: e.message || 'meta failed' });
        }
    });

    router.get('/planfix', async (req, res) => {
        try {
            await ensureSchema(db);
            const year = normYear(req.query.year, currentYear());
            const month = normSyncMonth(req.query.month, 0);
            const managers = await listSalesManagers(db);
            const panel = await loadPlanfixPanel(db, year, managers, month);
            const { token, account, base } = credsFromSettings(settings);
            res.json({
                success: true,
                year,
                month,
                configured: !!token,
                account,
                base,
                can_write: canWrite(req),
                status_field_name: pf.STATUS_FIELD_NAME,
                buckets: pf.STATUS_BUCKETS,
                sync_script: getOpsPlanfixSyncMeta(),
                ...panel,
            });
        } catch (e) {
            console.error('[ops-sheet/planfix]', e);
            res.status(500).json({ success: false, error: e.message || 'planfix meta failed' });
        }
    });

    router.get('/planfix-tasks', async (req, res) => {
        try {
            await ensureSchema(db);
            const year = normYear(req.query.year, currentYear());
            const month = normSyncMonth(req.query.month, 0);
            const b = pf.periodBounds(year, month);
            const q = String(req.query.q || req.query.search || '').trim();
            let limit = Number(req.query.limit);
            if (!Number.isFinite(limit) || limit < 1) limit = 100;
            if (limit > 200) limit = 200;
            let page = Number(req.query.page);
            if (!Number.isFinite(page) || page < 1) page = 1;
            const offset = (page - 1) * limit;
            const args = [b.fromSql, b.toSql];
            let where = 'created_at >= ? AND created_at < ?';
            if (q) {
                where += ' AND (CAST(task_id AS CHAR) LIKE ? OR assigner_name LIKE ? OR status_value LIKE ? OR planfix_status LIKE ?)';
                const like = `%${q}%`;
                args.push(like, like, like, like);
            }
            const [totRows] = await db.query(
                `SELECT COUNT(*) AS n,
                        SUM(CASE WHEN TRIM(IFNULL(status_value,'')) = '' THEN 1 ELSE 0 END) AS empty_n
                 FROM dg_ops_planfix_tasks WHERE ${where}`,
                args
            );
            const tot = totRows && totRows[0] ? totRows[0] : {};
            const n = Number(tot.n) || 0;
            const emptyN = Number(tot.empty_n) || 0;
            const [rows] = await db.query(
                `SELECT task_id, assigner_name, status_value, planfix_status, created_at, synced_at
                 FROM dg_ops_planfix_tasks
                 WHERE ${where}
                 ORDER BY created_at DESC, task_id DESC
                 LIMIT ? OFFSET ?`,
                [...args, limit, offset]
            );
            const { account } = credsFromSettings(settings);
            const periodLabel = b.month ? `${MONTH_LABELS[b.month]} ${year}` : `весь ${year}`;
            res.json({
                success: true,
                year,
                month: b.month || 0,
                period: periodLabel,
                account: account || 'almamed',
                q,
                page,
                limit,
                total: n,
                pages: n ? Math.max(1, Math.ceil(n / limit)) : 1,
                shown: (rows || []).length,
                empty_status: emptyN,
                with_status: Math.max(0, n - emptyN),
                rows: rows || [],
            });
        } catch (e) {
            console.error('[ops-sheet/planfix-tasks]', e);
            res.status(500).json({ success: false, error: e.message || 'planfix-tasks failed' });
        }
    });

    router.get('/planfix-sync-status', (req, res) => {
        res.json({ success: true, ...pfSyncPublic() });
    });

    router.post('/planfix-sync', async (req, res) => {
        const started = Date.now();
        let ownsJob = false;
        try {
            await ensureSchema(db);
            if (!canWrite(req)) {
                return res.status(403).json({ success: false, error: 'Недостаточно прав (нужен full)' });
            }
            if (pfSyncJob.active && pfSyncLockIsStale()) {
                markPfSync({
                    active: false,
                    stage: 'idle',
                    message: 'Сбросили зависший синк (нет прогресса > 45 мин)',
                });
            }
            if (pfSyncJob.active) {
                return res.status(409).json({
                    success: false,
                    error: 'Синхронизация Planfix уже идёт',
                    attached: true,
                    ...pfSyncPublic(),
                });
            }
            const body = req.body || {};
            const year = normYear(body.year != null ? body.year : req.query.year, currentYear());
            const month = normSyncMonth(
                body.month != null ? body.month : req.query.month,
                new Date().getMonth() + 1
            );
            const periodLabel = month ? `${MONTH_LABELS[month]} ${year}` : `весь ${year}`;
            const dryRun =
                body.dry_run === 1 ||
                body.dry_run === true ||
                body.dry_run === '1' ||
                String(req.query.dry_run || '') === '1';
            const { token } = credsFromSettings(settings);
            if (!token) {
                return res.status(400).json({
                    success: false,
                    error: 'Сначала сохраните REST-токен в Настройки → Planfix',
                });
            }

            markPfSync({
                active: true,
                dry_run: dryRun,
                year,
                month,
                last_error: null,
                stage: 'fields',
                message: dryRun
                    ? `Пробный просмотр (${periodLabel}): справочник полей`
                    : month
                      ? `Справочник полей Planfix (${periodLabel})`
                      : `Весь ${year}: все 12 месяцев одним прогоном (заявки листа, без второго обхода аккаунта)`,
                pages: 0,
                fetched: 0,
                stored: 0,
                started_ms: started,
            });
            ownsJob = true;
            setImmediate(() => {
                (async () => {
            const errors = [];
            const managers = await listSalesManagers(db);
            let pfUsers = [];
            try {
                markPfSync({ stage: 'users', message: 'Сотрудники Planfix — ищем постановщиков-менеджеров продаж' });
                pfUsers = await listPlanfixUsers(settings, (msg) => {
                    markPfSync({ stage: 'users', message: msg });
                });
            } catch (e) {
                errors.push({
                    code: 'user_list',
                    error: e && e.message ? e.message : 'Не удалось получить /user/list',
                });
            }
            const matchedAssigners = matchAssignerIds(pfUsers, managers);
            const assignerQueue = matchedAssigners.ids.length ? matchedAssigners.ids : [null];
            const templateQueue =
                (pf.DEAL_STATUS_TEMPLATE_IDS || []).length > 0
                    ? pf.DEAL_STATUS_TEMPLATE_IDS.slice()
                    : [null];
            if (!matchedAssigners.ids.length) {
                errors.push({
                    code: 'assigners',
                    error:
                        'Не сопоставили сотрудников Planfix с менеджерами продаж — временно забираем все задачи за период и отбрасываем чужих постановщиков при записи.',
                });
            }

            const field = await findDealStatusField(settings, (msg) => {
                markPfSync({ stage: 'fields', message: msg });
            });
            const firstTryFieldFilter = false;
            let withFieldFilter = firstTryFieldFilter;
            let dateType = 'otherRange';
            async function loadPage(offset, assignerId, templateId) {
                return listTasksPage(settings, {
                    offset: offset || 0,
                    pageSize: 100,
                    fieldId: field.id,
                    year,
                    month,
                    withFieldFilter,
                    dateType,
                    assignerId,
                    templateId,
                });
            }
            try {
                markPfSync({
                    stage: 'first_page',
                    message: `Первая страница за ${periodLabel} (постановщики: ${
                        matchedAssigners.ids.length || 'все, потом отсев'
                    }, шаблон=${templateQueue[0] || 'любой'}, дата=${dateType})`,
                });
                await loadPage(0, assignerQueue[0], templateQueue[0]);
            } catch (e) {
                dateType = 'otherPeriod';
                await loadPage(0, assignerQueue[0], templateQueue[0]);
            }

            const syncedAt = mysqlNow();
            let pages = 0;
            let fetched = 0;
            let stored = 0;
            let skippedNoDate = 0;
            let skippedNoId = 0;
            let skippedNotManager = 0;
            let emptyStatus = 0;
            const seenStatuses = {};
            const sampleAssigners = {};

            const consume = async (payload, write) => {
                const tasks = pf.collectTasks(payload);
                pages += 1;
                fetched += tasks.length;
                const rows = [];
                tasks.forEach((t) => {
                    const mapped = mapTaskRow(t, field.id, field.name, syncedAt);
                    if (mapped.skip === 'no_id') {
                        skippedNoId += 1;
                        return;
                    }
                    if (mapped.skip === 'no_date') {
                        skippedNoDate += 1;
                        return;
                    }
                    if (!pf.matchManagerByAssigner(mapped.assigner_name, managers)) {
                        skippedNotManager += 1;
                        return;
                    }
                    if (!mapped.status_value) emptyStatus += 1;
                    if (mapped.status_value) seenStatuses[mapped.status_value] = true;
                    if (mapped.assigner_name) {
                        sampleAssigners[mapped.assigner_name] =
                            (sampleAssigners[mapped.assigner_name] || 0) + 1;
                    }
                    rows.push(mapped);
                });
                if (write && rows.length) {
                    await upsertTaskRows(db, rows);
                    stored += rows.length;
                }
                markPfSync({
                    stage: 'pages',
                    pages,
                    fetched,
                    stored,
                    message: dryRun
                        ? `Пробный просмотр: страница ${pages}, задач ${fetched}`
                        : `Страница ${pages}: забрано ${fetched}, своих ${stored}, чужих постановщиков ${skippedNotManager}`,
                });
                return tasks.length;
            };

            async function paginateAssigner(assignerId, templateId) {
                let pageLen = 0;
                let localOffset = 0;
                do {
                    markPfSync({
                        stage: 'pages',
                        message:
                            (assignerId ? `Постановщик user:${assignerId}` : 'Все постановщики') +
                            (templateId ? `, шаблон ${templateId}` : '') +
                            `, offset ${localOffset}`,
                    });
                    const next = await loadPage(localOffset, assignerId, templateId);
                    pageLen = await consume(next, !dryRun);
                    if (pageLen < 100) break;
                    localOffset += pageLen;
                    await sleep(250);
                    if (pages > 5000) {
                        errors.push({ code: 'limit', error: 'Остановлено: больше 5000 страниц' });
                        break;
                    }
                } while (pageLen === 100);
            }

            for (let ai = 0; ai < assignerQueue.length; ai += 1) {
                for (let ti = 0; ti < templateQueue.length; ti += 1) {
                    await paginateAssigner(assignerQueue[ai], templateQueue[ti]);
                }
            }

            if (!dryRun) {
                markPfSync({
                    stage: 'task_dates',
                    message: `Индекс дат всех задач ${periodLabel} (без отбора постановщик/шаблон) для сверки с отчётом`,
                });
                const datesN = await indexAllTaskDatesForPeriod(settings, db, year, month, (msg) => {
                    markPfSync({ stage: 'task_dates', message: msg });
                });
                markPfSync({
                    stage: 'task_dates',
                    message: `Индекс дат: ${datesN} задач периода`,
                });
            }

            if (!dryRun) {
                markPfSync({
                    stage: 'prune',
                    message: month
                        ? `Чистим задачи ${periodLabel}, которых не было в этом прогоне`
                        : `Чистим задачи года ${year}, которых не было в этом прогоне`,
                });
                const b = pf.periodBounds(year, month);
                await db.query(
                    `DELETE FROM dg_ops_planfix_tasks
                      WHERE created_at >= ? AND created_at < ? AND synced_at < ?`,
                    [b.fromSql, b.toSql, syncedAt]
                );
                await upsertCatalog(db, field.enumValues || [], 'enum');
                await upsertCatalog(db, Object.keys(seenStatuses), 'task');
                let reportMeta = null;
                try {
                    markPfSync({
                        stage: 'status_report',
                        message: `Отдельно забираем «${pf.STATUS_FIELD_NAME}» из отчёта Planfix`,
                    });
                    reportMeta = await enrichFromDealStatusReport(settings, db, (msg) => {
                        markPfSync({ stage: 'status_report', message: msg });
                    }, year, month);
                    (reportMeta.unique_statuses || []).forEach((s) => {
                        if (s) seenStatuses[s] = true;
                    });
                    if (reportMeta.covers_period === false) {
                        errors.push({
                            code: 'status_report_period',
                            error:
                                'Отчёт «Отчет за месяц по всем» не содержит задач этого периода (сейв без пересечения с выборкой). В Planfix откройте отчёт, выставьте даты нужного месяца и сформируйте; API не передаёт период в generate. Затем синхронизируйте снова.',
                        });
                    }
                    const b2 = pf.periodBounds(year, month);
                    const [emptyRows] = await db.query(
                        `SELECT COUNT(*) AS n FROM dg_ops_planfix_tasks
                          WHERE created_at >= ? AND created_at < ?
                            AND (status_value IS NULL OR status_value = '')`,
                        [b2.fromSql, b2.toSql]
                    );
                    emptyStatus = Number(emptyRows && emptyRows[0] && emptyRows[0].n) || 0;
                    const [seenRows] = await db.query(
                        `SELECT DISTINCT status_value FROM dg_ops_planfix_tasks
                          WHERE created_at >= ? AND created_at < ?
                            AND status_value IS NOT NULL AND status_value <> ''`,
                        [b2.fromSql, b2.toSql]
                    );
                    (seenRows || []).forEach((r) => {
                        if (r.status_value) seenStatuses[r.status_value] = true;
                    });
                } catch (e) {
                    errors.push({
                        code: 'status_report',
                        error: e && e.message ? e.message : 'Не удалось прочитать отчёт «Статус Сделки/Письма»',
                    });
                }
                field.report = reportMeta;
            } else {
                await upsertCatalog(db, field.enumValues || [], 'enum');
            }

            const durationSec = Math.round((Date.now() - started) / 10) / 100;
            markPfSync({
                active: false,
                stage: 'done',
                last_error: null,
                pages,
                fetched,
                stored: dryRun ? 0 : stored,
                message: dryRun
                    ? `Пробный просмотр готов: ${fetched} задач`
                    : `Готово: ${stored} задач за ${durationSec} с`,
            });
                })()
                    .catch((e) => {
                        const status = e.status && e.status >= 400 && e.status < 600 ? e.status : 500;
                        if (status >= 500) console.error('[ops-sheet/planfix-sync]', e);
                        const msg = formatPlanfixSyncError(e);
                        markPfSync({
                            active: false,
                            stage: 'error',
                            last_error: msg,
                            message: msg,
                        });
                    })
                    .finally(() => {
                        if (pfSyncJob.active) {
                            markPfSync({
                                active: false,
                                stage: 'error',
                                last_error: pfSyncJob.last_error || pfSyncJob.message,
                                message: pfSyncJob.message || 'Синк остановлен',
                            });
                        }
                    });
            });
            return res.json({
                success: true,
                started: true,
                attached: false,
                dry_run: !!dryRun,
                year,
                month,
                period: periodLabel,
                ...pfSyncPublic(),
            });
        } catch (e) {
            const status = e.status && e.status >= 400 && e.status < 600 ? e.status : 500;
            if (status >= 500) console.error('[ops-sheet/planfix-sync]', e);
            const msg = formatPlanfixSyncError(e);
            if (ownsJob && pfSyncJob.active) {
                markPfSync({
                    active: false,
                    stage: 'error',
                    last_error: msg,
                    message: msg,
                });
            }
            if (res.headersSent) return;
            res.status(status === 405 ? 403 : status).json({
                success: false,
                error: msg,
                duration_sec: Math.round((Date.now() - started) / 10) / 100,
            });
        }
    });

    router.put('/planfix-status-map', async (req, res) => {
        try {
            await ensureSchema(db);
            if (!canWrite(req)) {
                return res.status(403).json({ success: false, error: 'Недостаточно прав (нужен full)' });
            }
            const items = (req.body && req.body.items) || [];
            if (!Array.isArray(items) || !items.length) {
                return res.status(400).json({ success: false, error: 'Нужен items[]' });
            }
            const cleaned = [];
            items.forEach((it, idx) => {
                const status_value = String((it && it.status_value) || '').trim();
                if (!status_value) return;
                const isSep =
                    it && (it.is_separator === true || it.is_separator === 1 || it.is_separator === '1')
                        ? true
                        : pf.isDealStatusSeparator(status_value);
                let bucket = isSep ? '' : String((it && it.bucket) || '').trim();
                if (bucket && !pf.BUCKET_KEYS.has(bucket)) {
                    const err = new Error(`Неизвестная корзина: ${bucket}`);
                    err.status = 400;
                    throw err;
                }
                if (!bucket) bucket = '';
                const count_in_apps =
                    isSep || !bucket
                        ? 0
                        : it.count_in_apps === false || it.count_in_apps === 0 || it.count_in_apps === '0'
                          ? 0
                          : 1;
                cleaned.push({
                    status_value: status_value.slice(0, 191),
                    bucket,
                    count_in_apps,
                    is_separator: isSep ? 1 : 0,
                    sort_order: idx + 1,
                });
            });
            if (!cleaned.length) {
                return res.status(400).json({ success: false, error: 'Пустой список статусов' });
            }
            const mapRows = cleaned.filter((r) => !r.is_separator);
            if (mapRows.length) {
                const ph = mapRows.map(() => '(?,?,?)').join(',');
                const args = [];
                mapRows.forEach((r) => {
                    args.push(r.status_value, r.bucket, r.count_in_apps);
                });
                await db.query(
                    `INSERT INTO dg_ops_planfix_status_map (status_value, bucket, count_in_apps)
                     VALUES ${ph}
                     ON DUPLICATE KEY UPDATE
                        bucket = VALUES(bucket),
                        count_in_apps = VALUES(count_in_apps)`,
                    args
                );
            }
            const catPh = cleaned.map(() => '(?,?,?,?)').join(',');
            const catArgs = [];
            cleaned.forEach((r) => {
                catArgs.push(
                    r.status_value,
                    r.is_separator ? 'enum' : 'map',
                    r.sort_order,
                    r.is_separator
                );
            });
            await db.query(
                `INSERT INTO dg_ops_planfix_status_catalog (status_value, source, sort_order, is_separator)
                 VALUES ${catPh}
                 ON DUPLICATE KEY UPDATE
                    sort_order = VALUES(sort_order),
                    is_separator = VALUES(is_separator)`,
                catArgs
            );
            const year = normYear(req.body && req.body.year, currentYear());
            const month = normSyncMonth(req.body && req.body.month, 0);
            const managers = await listSalesManagers(db);
            const panel = await loadPlanfixPanel(db, year, managers, month);
            const verify = {};
            cleaned.forEach((r) => {
                verify[r.status_value] = { bucket: r.bucket, count_in_apps: !!r.count_in_apps };
            });
            const mismatches = [];
            (panel.statuses || []).forEach((s) => {
                const want = verify[s.status_value];
                if (!want) return;
                if (String(s.bucket || '') !== String(want.bucket || '') || !!s.count_in_apps !== !!want.count_in_apps) {
                    mismatches.push({
                        status_value: s.status_value,
                        sent: want,
                        stored: { bucket: s.bucket, count_in_apps: s.count_in_apps },
                    });
                }
            });
            res.json({
                success: true,
                saved: cleaned.length,
                mismatches,
                year,
                ...panel,
            });
        } catch (e) {
            const status = e.status || 500;
            if (status >= 500) console.error('[ops-sheet/planfix-status-map]', e);
            res.status(status).json({ success: false, error: e.message || 'save map failed' });
        }
    });

    router.get('/', async (req, res) => {
        try {
            await ensureSchema(db);
            const year = normYear(req.query.year, currentYear());
            const managers = await listSalesManagers(db);
            const mids = managers.map((m) => m.id);
            const [aggregates, plans, manualMap, pfApps] = await Promise.all([
                fetchMonthAggregates(db, year, mids),
                loadPlans(db),
                loadManualMap(db, year),
                fetchPlanfixAppCounts(db, year, managers),
            ]);
            const months = buildYearSnapshot(
                managers,
                year,
                aggregates,
                plans,
                manualMap,
                pfApps.counts || {}
            );
            res.json({
                success: true,
                year,
                managers,
                months,
                can_write: canWrite(req),
                planfix_unmatched: pfApps.unmatched || {},
            });
        } catch (e) {
            console.error('[ops-sheet/]', e);
            res.status(500).json({ success: false, error: e.message || 'load failed' });
        }
    });

    router.put('/manual', async (req, res) => {
        try {
            await ensureSchema(db);
            if (!canWrite(req)) {
                return res.status(403).json({ success: false, error: 'Недостаточно прав (нужен full)' });
            }
            const body = req.body || {};
            const year = normYear(body.year, null);
            const month = normMonth(body.month);
            const mid = Number(body.manager_user_id);
            if (!year || !month || !Number.isFinite(mid) || mid <= 0) {
                return res.status(400).json({ success: false, error: 'Нужны year, month, manager_user_id' });
            }
            const managers = await listSalesManagers(db);
            const mgr = managers.find((m) => m.id === mid);
            if (!mgr) {
                return res.status(400).json({ success: false, error: 'Менеджер не из группы «Менеджер по продажам»' });
            }
            const patch = parseManualBody(body);
            if (!Object.keys(patch).length) {
                return res.status(400).json({ success: false, error: 'Нет полей для сохранения' });
            }

            const [existingRows] = await db.query(
                `SELECT coefficient, bonus_past, salary
                   FROM dg_ops_sheet_manual
                  WHERE year = ? AND month = ? AND manager_user_id = ?
                  LIMIT 1`,
                [year, month, mid]
            );
            const prev = existingRows && existingRows[0] ? existingRows[0] : {};
            const next = {
                coefficient:
                    patch.coefficient !== undefined
                        ? patch.coefficient
                        : prev.coefficient != null
                          ? Number(prev.coefficient)
                          : null,
                bonus_past:
                    patch.bonus_past !== undefined
                        ? patch.bonus_past
                        : prev.bonus_past != null
                          ? Number(prev.bonus_past)
                          : null,
                salary:
                    patch.salary !== undefined
                        ? patch.salary
                        : prev.salary != null
                          ? Number(prev.salary)
                          : null,
            };

            const actor = actorId(req);
            await db.query(
                `INSERT INTO dg_ops_sheet_manual
                    (year, month, manager_user_id, coefficient, bonus_past, salary, updated_by)
                 VALUES (?, ?, ?, ?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE
                    coefficient = VALUES(coefficient),
                    bonus_past = VALUES(bonus_past),
                    salary = VALUES(salary),
                    updated_by = VALUES(updated_by)`,
                [year, month, mid, next.coefficient, next.bonus_past, next.salary, actor]
            );

            const allMids = managers.map((m) => m.id);
            const [allAgg, plans, manualMap, pfApps] = await Promise.all([
                fetchMonthAggregates(db, year, allMids),
                loadPlans(db),
                loadManualMap(db, year),
                fetchPlanfixAppCounts(db, year, managers),
            ]);
            const monthRows = managers.map((m) => {
                const k = `${m.id}:${month}`;
                const a = allAgg[k] || {
                    turnover: 0,
                    profit_before_tax: 0,
                    profit_after_tax: 0,
                    paid_applications: 0,
                };
                const p = resolvePlan(plans, m.id, year, month);
                const manBase = m.id === mid ? next : manualMap[k] || emptyManual();
                return composeMonthRow(m, a, p, manualWithApps(manBase, (pfApps.counts || {})[k] || 0));
            });
            const row = monthRows.find((r) => Number(r.manager_user_id) === mid);

            res.json({
                success: true,
                year,
                month,
                row,
                totals: buildTotals(monthRows),
            });
        } catch (e) {
            const status = e.status || 500;
            if (status >= 500) console.error('[ops-sheet/manual]', e);
            res.status(status).json({ success: false, error: e.message || 'save failed' });
        }
    });

    return router;
};
