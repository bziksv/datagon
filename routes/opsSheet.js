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
    OPS_AUTO_FROM,
    SHIPPED_STATUSES,
    isOpsAutoEra,
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
    assigners_matched: 0,
    unmatched_managers: [],
    started_ms: 0,
    updated_ms: 0,
    last_error: null,
    cancelRequested: false,
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
        assigners_matched: pfSyncJob.assigners_matched || 0,
        unmatched_managers: Array.isArray(pfSyncJob.unmatched_managers)
            ? pfSyncJob.unmatched_managers
            : [],
        elapsed_sec: started ? Math.max(0, Math.round((Date.now() - started) / 1000)) : 0,
        last_error: pfSyncJob.last_error || null,
        cancel_requested: !!pfSyncJob.cancelRequested,
        sync_script: getOpsPlanfixSyncMeta(),
    };
}

function throwIfPfSyncCancelled() {
    if (!pfSyncJob.cancelRequested) return;
    const err = new Error(
        `Синк Planfix остановлен (страниц ${pfSyncJob.pages || 0}, записано ${pfSyncJob.stored || 0})`
    );
    err.code = 'PF_SYNC_CANCELLED';
    throw err;
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
    try {
        await db.query(
            'ALTER TABLE dg_ops_sheet_manual ADD COLUMN bonus_past_manual TINYINT NOT NULL DEFAULT 0'
        );
    } catch (e) {
        if (!(e && (e.errno === 1060 || /duplicate column/i.test(String(e.message || ''))))) throw e;
    }
    try {
        await db.query('ALTER TABLE dg_manager_sales_rows ADD COLUMN shipped_at DATE NULL');
    } catch (e) {
        if (!(e && (e.errno === 1060 || /duplicate column/i.test(String(e.message || ''))))) {
            /* таблица может ещё не существовать до первого визита manager-sales */
        }
    }
    try {
        await db.query('ALTER TABLE dg_manager_sales_rows ADD KEY idx_msl_shipped (shipped_at)');
    } catch (_) {}
    // С окт. 2026: у уже «Отгружен» без даты — подставляем paid_at (тот же месяц).
    // Плавающие май→октябрь: нужна явная shipped_at в месяце отгрузки.
    try {
        await db.query(
            `UPDATE dg_manager_sales_rows
                SET shipped_at = paid_at
              WHERE shipped_at IS NULL
                AND paid_at IS NOT NULL
                AND paid_at >= '2026-10-01'
                AND status IN ('Отгружен', 'Частично отгружен')`
        );
    } catch (_) {}
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
            year INT NOT NULL DEFAULT 0,
            month INT NOT NULL DEFAULT 0,
            status_value VARCHAR(191) NOT NULL,
            n INT NOT NULL DEFAULT 0,
            report_id INT NOT NULL DEFAULT 0,
            save_id INT NOT NULL DEFAULT 0,
            synced_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (year, month, status_value)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await db.query(`
        CREATE TABLE IF NOT EXISTS dg_ops_planfix_report_task (
            year INT NOT NULL DEFAULT 0,
            month INT NOT NULL DEFAULT 0,
            task_id BIGINT NOT NULL,
            status_value VARCHAR(191) NOT NULL,
            report_id INT NOT NULL DEFAULT 0,
            save_id INT NOT NULL DEFAULT 0,
            synced_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (year, month, task_id),
            KEY idx_ops_pf_report_task_status (year, month, status_value)
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
            year INT NOT NULL,
            month INT NOT NULL,
            report_id INT NOT NULL DEFAULT 0,
            save_id INT NOT NULL DEFAULT 0,
            scope VARCHAR(16) NOT NULL DEFAULT 'all',
            is_generated TINYINT NOT NULL DEFAULT 0,
            synced_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (year, month)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await migrateReportPeriodSnapshots(db);
    await seedDealStatusCatalog(db);
    await assignMissingCatalogOrder(db);
    await migratePlanfixCreatedAtToMoscow(db);
    schemaReady = true;
}

async function tableColumnNames(db, table) {
    const [cols] = await db.query(
        `SELECT COLUMN_NAME AS c FROM INFORMATION_SCHEMA.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
        [table]
    );
    return new Set((cols || []).map((r) => String(r.c)));
}

/** Снимки отчёта 450694 — по (year, month); короткий синк не затирает полный год. */
async function migrateReportPeriodSnapshots(db) {
    const taskCols = await tableColumnNames(db, 'dg_ops_planfix_report_task');
    if (!taskCols.size) return;

    let metaYear = 0;
    let metaMonth = 0;
    try {
        const metaCols = await tableColumnNames(db, 'dg_ops_planfix_report_meta');
        if (metaCols.has('id')) {
            const [mr] = await db.query(
                `SELECT year, month, report_id, save_id, scope, is_generated, synced_at
                   FROM dg_ops_planfix_report_meta WHERE id = 1 LIMIT 1`
            );
            if (mr && mr[0]) {
                metaYear = Number(mr[0].year) || 0;
                metaMonth = Number(mr[0].month) || 0;
                const row = mr[0];
                await db.query('DROP TABLE dg_ops_planfix_report_meta');
                await db.query(`
                    CREATE TABLE dg_ops_planfix_report_meta (
                        year INT NOT NULL,
                        month INT NOT NULL,
                        report_id INT NOT NULL DEFAULT 0,
                        save_id INT NOT NULL DEFAULT 0,
                        scope VARCHAR(16) NOT NULL DEFAULT 'all',
                        is_generated TINYINT NOT NULL DEFAULT 0,
                        synced_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                        PRIMARY KEY (year, month)
                    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
                `);
                if (metaYear || metaMonth) {
                    await db.query(
                        `INSERT INTO dg_ops_planfix_report_meta
                            (year, month, report_id, save_id, scope, is_generated, synced_at)
                         VALUES (?, ?, ?, ?, ?, ?, ?)
                         ON DUPLICATE KEY UPDATE report_id = VALUES(report_id)`,
                        [
                            metaYear,
                            metaMonth,
                            Number(row.report_id) || 0,
                            Number(row.save_id) || 0,
                            String(row.scope || 'period'),
                            Number(row.is_generated) ? 1 : 0,
                            row.synced_at || mysqlNow(),
                        ]
                    );
                }
            } else {
                await db.query('DROP TABLE dg_ops_planfix_report_meta');
                await db.query(`
                    CREATE TABLE dg_ops_planfix_report_meta (
                        year INT NOT NULL,
                        month INT NOT NULL,
                        report_id INT NOT NULL DEFAULT 0,
                        save_id INT NOT NULL DEFAULT 0,
                        scope VARCHAR(16) NOT NULL DEFAULT 'all',
                        is_generated TINYINT NOT NULL DEFAULT 0,
                        synced_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                        PRIMARY KEY (year, month)
                    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
                `);
            }
        }
    } catch (e) {
        if (!(e && (e.errno === 1146 || /doesn't exist/i.test(String(e.message || ''))))) throw e;
    }

    if (!taskCols.has('year')) {
        await db.query(
            `ALTER TABLE dg_ops_planfix_report_task
               ADD COLUMN year INT NOT NULL DEFAULT 0,
               ADD COLUMN month INT NOT NULL DEFAULT 0`
        );
        if (metaYear || metaMonth) {
            await db.query(`UPDATE dg_ops_planfix_report_task SET year = ?, month = ?`, [
                metaYear,
                metaMonth,
            ]);
        }
        await db.query(
            `ALTER TABLE dg_ops_planfix_report_task
               DROP PRIMARY KEY,
               ADD PRIMARY KEY (year, month, task_id)`
        );
    }

    const countCols = await tableColumnNames(db, 'dg_ops_planfix_report_status_counts');
    if (countCols.size && !countCols.has('year')) {
        await db.query(
            `ALTER TABLE dg_ops_planfix_report_status_counts
               ADD COLUMN year INT NOT NULL DEFAULT 0,
               ADD COLUMN month INT NOT NULL DEFAULT 0`
        );
        if (metaYear || metaMonth) {
            await db.query(`UPDATE dg_ops_planfix_report_status_counts SET year = ?, month = ?`, [
                metaYear,
                metaMonth,
            ]);
        }
        await db.query(
            `ALTER TABLE dg_ops_planfix_report_status_counts
               DROP PRIMARY KEY,
               ADD PRIMARY KEY (year, month, status_value)`
        );
    }
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

async function listSalesManagers(db, opts) {
    const includeArchived = !!(opts && opts.includeArchived);
    const [users] = await db.query(
        `SELECT u.id, u.username, u.full_name, COALESCE(u.is_archived, 0) AS is_archived
           FROM users u
           INNER JOIN specialties s ON s.id = u.specialty_id
          WHERE s.name = ?
            AND (${includeArchived ? '1=1' : 'COALESCE(u.is_archived, 0) = 0'})
          ORDER BY COALESCE(u.is_archived, 0), COALESCE(NULLIF(u.full_name,''), u.username)`,
        [SALES_SPECIALTY_NAME]
    );
    return (users || []).map((u) => ({
        id: Number(u.id),
        username: u.username || '',
        full_name: u.full_name || u.username || '',
        is_archived: Number(u.is_archived) === 1,
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
        `SELECT year, month, manager_user_id, applications_count, coefficient,
                bonus_past, bonus_past_manual, salary
           FROM dg_ops_sheet_manual
          WHERE year = ?`,
        [year]
    );
    const map = {};
    (rows || []).forEach((r) => {
        const mid = Number(r.manager_user_id);
        const m = Number(r.month);
        map[`${mid}:${m}`] = {
            // «Кол-во заявок (с Гугла)» — импорт из Google ops-листа, не Planfix-галка
            applications_count:
                r.applications_count != null ? Math.round(Number(r.applications_count) || 0) : null,
            applications_local: null,
            coefficient: r.coefficient != null ? Number(r.coefficient) : null,
            bonus_past: r.bonus_past != null ? Number(r.bonus_past) : null,
            bonus_past_manual: Number(r.bonus_past_manual) === 1 ? 1 : 0,
            salary: r.salary != null ? Number(r.salary) : null,
        };
    });
    return map;
}

function emptyShippedBonusCell() {
    return {
        sum: 0,
        count: 0,
        sum_past: 0,
        count_past: 0,
        sum_current: 0,
        count_current: 0,
    };
}

/**
 * Премии по отгрузкам месяца листа.
 * Дата отгрузки: COALESCE(shipped_at, paid_at) если статус Отгружен/Частично
 * (у старых строк shipped_at часто пустой — без fallback колонка была нулями).
 * — past: оплата раньше месяца отгрузки (май→октябрь: нужна явная shipped_at);
 * — current: оплата в том же месяце.
 * bonus_current = полная премия месяца (все продажи), без вычета sum_current.
 */
async function fetchBonusPastByShipped(db, year, managerIds) {
    const out = {};
    const ids = (managerIds || []).map((n) => Number(n)).filter((n) => Number.isFinite(n) && n > 0);
    if (!ids.length) return out;
    const ph = ids.map(() => '?').join(',');
    const statusPh = SHIPPED_STATUSES.map(() => '?').join(',');
    const [rows] = await db.query(
        `SELECT COALESCE(handed_to_user_id, manager_user_id) AS mid,
                YEAR(COALESCE(shipped_at, paid_at)) AS sy,
                MONTH(COALESCE(shipped_at, paid_at)) AS sm,
                YEAR(paid_at) AS py,
                MONTH(paid_at) AS pm,
                bonus
           FROM dg_manager_sales_rows
          WHERE archived_at IS NULL
            AND paid_at IS NOT NULL
            AND status IN (${statusPh})
            AND YEAR(COALESCE(shipped_at, paid_at)) = ?
            AND COALESCE(handed_to_user_id, manager_user_id) IN (${ph})`,
        SHIPPED_STATUSES.concat([year]).concat(ids)
    );
    (rows || []).forEach((r) => {
        const mid = Number(r.mid);
        const sy = Number(r.sy);
        const sm = Number(r.sm);
        const py = Number(r.py);
        const pm = Number(r.pm);
        if (!Number.isFinite(mid) || sy !== year || !sm || sm < 1 || sm > 12) return;
        if (!Number.isFinite(py) || !Number.isFinite(pm) || pm < 1 || pm > 12) return;
        // Оплата позже месяца отгрузки — не считаем (битые даты)
        if (py > year || (py === year && pm > sm)) return;
        const key = `${mid}:${sm}`;
        if (!out[key]) out[key] = emptyShippedBonusCell();
        const bonus = toNum(r.bonus) || 0;
        const sameMonth = py === year && pm === sm;
        out[key].sum += bonus;
        out[key].count += 1;
        if (sameMonth) {
            out[key].sum_current += bonus;
            out[key].count_current += 1;
        } else {
            out[key].sum_past += bonus;
            out[key].count_past += 1;
        }
    });
    Object.keys(out).forEach((k) => {
        out[k].sum = round2(out[k].sum);
        out[k].sum_past = round2(out[k].sum_past);
        out[k].sum_current = round2(out[k].sum_current);
    });
    return out;
}

function sqlDateOnly(v) {
    if (v == null) return null;
    if (v instanceof Date && !isNaN(v.getTime())) {
        // MySQL DATE часто приходит как локальная полночь (МСК → UTC −3ч).
        // toISOString() тогда сдвигает календарный день назад — берём локальные Y-M-D.
        const y = v.getFullYear();
        const m = String(v.getMonth() + 1).padStart(2, '0');
        const d = String(v.getDate()).padStart(2, '0');
        return `${y}-${m}-${d}`;
    }
    const s = String(v);
    return s.length >= 10 ? s.slice(0, 10) : s;
}

function paidYearMonthFromValue(paid) {
    if (paid == null) return { py: null, pm: null };
    if (typeof paid === 'string') {
        const parts = paid.slice(0, 10).split('-');
        if (parts.length === 3) {
            return { py: Number(parts[0]), pm: Number(parts[1]) };
        }
    }
    const iso = sqlDateOnly(paid);
    if (!iso) return { py: null, pm: null };
    const parts = iso.split('-');
    return { py: Number(parts[0]), pm: Number(parts[1]) };
}

async function listBonusPastOrders(db, year, month, managerId) {
    const mid = Number(managerId);
    const y = Number(year);
    const m = Number(month);
    if (!Number.isFinite(mid) || mid <= 0 || !Number.isFinite(y) || !m || m < 1 || m > 12) {
        return [];
    }
    const statusPh = SHIPPED_STATUSES.map(() => '?').join(',');
    const [rows] = await db.query(
        `SELECT id, row_no, our_invoice_no, order_url, paid_at, shipped_at, status,
                amount_ex_delivery, bonus, pct_mp,
                COALESCE(handed_to_user_id, manager_user_id) AS credit_mid
           FROM dg_manager_sales_rows
          WHERE archived_at IS NULL
            AND paid_at IS NOT NULL
            AND status IN (${statusPh})
            AND YEAR(COALESCE(shipped_at, paid_at)) = ?
            AND MONTH(COALESCE(shipped_at, paid_at)) = ?
            AND COALESCE(handed_to_user_id, manager_user_id) = ?
          ORDER BY COALESCE(shipped_at, paid_at) ASC, paid_at ASC, id ASC`,
        // placeholders: status IN (…) → YEAR → MONTH → manager
        SHIPPED_STATUSES.concat([y, m, mid])
    );
    const out = [];
    (rows || []).forEach((r) => {
        const { py, pm } = paidYearMonthFromValue(r.paid_at);
        if (!Number.isFinite(py) || !Number.isFinite(pm)) return;
        if (py > y || (py === y && pm > m)) return;
        const sameMonth = py === y && pm === m;
        const shipExplicit = sqlDateOnly(r.shipped_at);
        const shipEff = shipExplicit || sqlDateOnly(r.paid_at);
        out.push({
            id: Number(r.id),
            row_no: r.row_no != null ? Number(r.row_no) : null,
            our_invoice_no: r.our_invoice_no || '',
            order_url: r.order_url || '',
            paid_at: sqlDateOnly(r.paid_at),
            shipped_at: shipEff,
            shipped_at_inferred: !shipExplicit,
            status: r.status || '',
            amount_ex_delivery: toNum(r.amount_ex_delivery),
            bonus: toNum(r.bonus),
            pct_mp: toNum(r.pct_mp),
            bucket: sameMonth ? 'current' : 'past',
            floating: !sameMonth,
        });
    });
    return out;
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
    const countsLocal = {};
    const unmatched = {};
    (agg || []).forEach((row) => {
        const status = String(row.status_value || '');
        const n = Number(row.n) || 0;
        const mgr = pf.matchManagerByAssigner(row.assigner_name, managers);
        const m = Number(row.m);
        if (!m || m < 1 || m > 12) return;

        if (!pf.isExcludedFromAppsCount(status)) {
            if (!mgr) {
                const k = String(row.assigner_name || '').trim() || '(без постановщика)';
                unmatched[k] = (unmatched[k] || 0) + n;
            } else {
                const key = `${mgr.id}:${m}`;
                countsLocal[key] = (countsLocal[key] || 0) + n;
            }
        }

        if (!countSet[status]) return;
        if (!mgr) return;
        const key = `${mgr.id}:${m}`;
        counts[key] = (counts[key] || 0) + n;
    });
    return { counts, countsLocal, unmatched };
}

/** applications_count — из manual (Google); applications_local — живой Planfix. */
function manualWithApps(manual, appsLocal) {
    const m = Object.assign(emptyManual(), manual || {});
    if (m.applications_count != null) {
        m.applications_count = Math.round(Number(m.applications_count) || 0);
    }
    m.applications_local = appsLocal != null ? Math.round(Number(appsLocal) || 0) : 0;
    return m;
}

function buildYearSnapshot(managers, year, aggregates, plans, manualMap, planfixLocal, bonusPastMap) {
    const months = [];
    const localMap = planfixLocal || {};
    const bpMap = bonusPastMap || {};
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
            const bp = bpMap[key] || emptyShippedBonusCell();
            // Полная премия месяца: все продажи credit-менеджера (отгруженные и нет + переданные ему)
            const bonusCurrent = round2((agg.profit_after_tax / 100) * pctMp);
            const manBase = manualMap[key] || emptyManual();
            const manual = manualWithApps(manBase, localMap[key] || 0);
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
                manual,
                {
                    year,
                    month,
                    bonus_past_auto: bp.sum,
                    bonus_past_manual: manBase.bonus_past_manual,
                    bonus_past_orders_count: bp.count,
                    bonus_past_from_past: bp.sum_past,
                    bonus_past_from_current: bp.sum_current,
                }
            );
        });
        months.push({
            month,
            label: MONTH_LABELS[month],
            rows,
            totals: buildTotals(rows),
            ops_auto_era: isOpsAutoEra(year, month),
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
            {
                offset,
                pageSize: 100,
                fields: 'id,name,lastName,firstName,midName,patronymic,email,login',
            },
            30000
        );
        const users = pf.collectUsers(payload);
        if (!users.length) break;
        users.forEach((u) => {
            const id = Number(u && u.id);
            if (!Number.isFinite(id) || id <= 0) return;
            // Не схлопывать в {id,name}: иначе pfUserNameCandidates теряет last/first
            // и порядок «Имя Фамилия» / «Фамилия Имя» — менеджеры уходят в несматченные,
            // prune потом вычищает их заявки из листа.
            out.push({
                id,
                name: pf.pickUserDisplayName(u),
                lastName: u.lastName,
                firstName: u.firstName,
                midName: u.midName || u.patronymic,
                patronymic: u.patronymic || u.midName,
                email: u.email,
                login: u.login || u.username,
                fullName: u.fullName || u.name,
            });
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
        let mgr = null;
        const cands = pf.pfUserNameCandidates ? pf.pfUserNameCandidates(u) : [u && u.name];
        for (let i = 0; i < cands.length; i += 1) {
            mgr = pf.matchManagerByAssigner(cands[i], managers);
            if (mgr) break;
        }
        if (!mgr) return;
        if (ids.indexOf(u.id) >= 0) {
            mgrHits.add(mgr.id);
            return;
        }
        ids.push(u.id);
        names.push((cands && cands[0]) || mgr.full_name || mgr.username);
        mgrHits.add(mgr.id);
    });
    const unmatchedManagers = (managers || []).filter((m) => !mgrHits.has(m.id));
    return {
        ids,
        names,
        managersMatched: mgrHits.size,
        unmatchedManagers,
    };
}

function sleep(ms) {
    const step = 400;
    let left = Math.max(0, Number(ms) || 0);
    return (async () => {
        while (left > 0) {
            throwIfPfSyncCancelled();
            const chunk = Math.min(step, left);
            await new Promise((resolve) => setTimeout(resolve, chunk));
            left -= chunk;
        }
        throwIfPfSyncCancelled();
    })();
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
    // Свежий сейв, не самый толстый: иначе год 2024 берёт старый dump на 25 чанков (Поставщик 23722)
    // вместо generate на 18 чанков (22912 как в Planfix).
    arr.sort((a, b) => Number(b.id) - Number(a.id));
    return arr[0] || null;
}

function normalizeReportSave(save) {
    if (!save || !save.id) return null;
    const chunks = Number(save.chunksCount);
    return {
        id: Number(save.id),
        chunksCount: Number.isFinite(chunks) && chunks > 0 ? chunks : 0,
        name: save.name || '',
    };
}

async function listReportSaves(appSettings, reportId) {
    const list = await restJson(
        appSettings,
        'POST',
        `/report/${reportId}/save/list`,
        { offset: 0, pageSize: 20, fields: 'id,name,dateTime,chunksCount' },
        20000
    );
    return pf.collectReportSaves(list).map(normalizeReportSave).filter(Boolean);
}

async function resolveSaveChunks(appSettings, reportId, save) {
    const s = normalizeReportSave(save);
    if (!s) return null;
    if (s.chunksCount > 0) return s;
    try {
        const found = (await listReportSaves(appSettings, reportId)).find((x) => x.id === s.id);
        if (found && found.chunksCount > 0) s.chunksCount = found.chunksCount;
    } catch (_) {
        /* чанки дочитаем до пустого */
    }
    return s;
}

function isPlanfixReportRateLimit(e) {
    const code = e && e.body && Number(e.body.code);
    const msg = `${(e && e.message) || ''} ${(e && e.body && (e.body.error || e.body.message)) || ''}`;
    return code === 9002 || /already in progress|не чаще|10 minut|10 minutes|раз в 10/i.test(msg);
}

async function generateDealStatusReport(appSettings, reportId, onProgress) {
    if (typeof onProgress === 'function') {
        onProgress(`Генерируем отчёт Planfix ${reportId} («${pf.STATUS_FIELD_NAME}»)`);
    }
    const gen = await restJson(appSettings, 'POST', `/report/${reportId}/generate`, {}, 30000);
    const requestId = gen && gen.requestId;
    if (!requestId) return null;
    const pollMs = 5000;
    const maxMs = 30 * 60 * 1000;
    const t0 = Date.now();
    let i = 0;
    let lastStatus = '';
    while (Date.now() - t0 < maxMs) {
        throwIfPfSyncCancelled();
        await sleep(pollMs);
        i += 1;
        const elapsed = Math.round((Date.now() - t0) / 1000);
        const st = await restJson(appSettings, 'GET', `/report/status/${requestId}`, null, 20000);
        lastStatus = st && st.status ? String(st.status) : '';
        if (typeof onProgress === 'function') {
            onProgress(`Отчёт ${reportId}: ${lastStatus || '…'} (опрос ${i}, ${elapsed} с / 30 мин)`);
        }
        const save = st && (st.save || st.reportSave);
        if (st && st.status === 'ready' && save && save.id) return normalizeReportSave(save);
        if (st && st.status && st.status !== 'in_progress' && st.status !== 'processing') {
            if (save && save.id) return normalizeReportSave(save);
            break;
        }
    }
    if (typeof onProgress === 'function') {
        onProgress(
            `Отчёт ${reportId}: generate не ready за 30 мин (${lastStatus || 'timeout'}) — без подстановки старого сейва`
        );
    }
    return null;
}

async function generateDealStatusReportRetry(appSettings, reportId, onProgress) {
    let lastErr = null;
    for (let attempt = 1; attempt <= 4; attempt += 1) {
        throwIfPfSyncCancelled();
        try {
            const save = await generateDealStatusReport(appSettings, reportId, onProgress);
            if (save && save.id) return save;
            lastErr = new Error('Generate отчёта не вернул сейв за 30 мин');
        } catch (e) {
            lastErr = e;
            if (e && e.code === 'PF_SYNC_CANCELLED') throw e;
            if (!isPlanfixReportRateLimit(e) || attempt === 4) throw e;
            if (typeof onProgress === 'function') {
                onProgress(
                    `Planfix не даёт generate (лимит 10 мин или уже идёт). Ждём 70 с, попытка ${attempt}/4`
                );
            }
            await sleep(70000);
            continue;
        }
        if (attempt === 4) break;
        if (typeof onProgress === 'function') {
            onProgress(`Generate без сейва — повтор ${attempt}/4 через 70 с`);
        }
        await sleep(70000);
    }
    if (lastErr) throw lastErr;
    return null;
}

async function readDealStatusReportPairs(appSettings, reportId, save, onProgress) {
    const known = Number(save && save.chunksCount) || 0;
    const byTask = new Map();
    const unique = [];
    let hint = {};
    let c = 0;
    const maxChunks = known > 0 ? known : 80;
    for (; c < maxChunks; c += 1) {
        throwIfPfSyncCancelled();
        if (typeof onProgress === 'function') {
            onProgress(
                `Читаем «${pf.STATUS_FIELD_NAME}»: чанк ${c + 1}/${known > 0 ? known : '?'}`
            );
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
        if (!pairs.length) break;
        pairs.forEach((p) => {
            byTask.set(p.task_id, p.status_value);
            if (unique.indexOf(p.status_value) < 0) unique.push(p.status_value);
        });
        if (known > 0 && c + 1 >= known) break;
    }
    return { byTask, unique, chunks: Math.max(1, c), save_id: save.id };
}

function periodMonthNorm(month) {
    return Number(month) >= 1 && Number(month) <= 12 ? Number(month) : 0;
}

async function upsertReportMeta(db, meta) {
    const rid = meta && Number(meta.report_id) ? Number(meta.report_id) : 0;
    const sid = meta && Number(meta.save_id) ? Number(meta.save_id) : 0;
    const year = meta && Number(meta.year) ? Number(meta.year) : 0;
    const month = periodMonthNorm(meta && meta.month);
    const scope = meta && meta.scope === 'period' ? 'period' : 'all';
    const isGenerated = meta && meta.generated ? 1 : 0;
    const ts = mysqlNow();
    await db.query(
        `INSERT INTO dg_ops_planfix_report_meta
            (year, month, report_id, save_id, scope, is_generated, synced_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
            report_id = VALUES(report_id),
            save_id = VALUES(save_id),
            scope = VALUES(scope),
            is_generated = VALUES(is_generated),
            synced_at = VALUES(synced_at)`,
        [year, month, rid, sid, scope, isGenerated, ts]
    );
}

async function loadReportMeta(db, year, month) {
    try {
        const y = Number(year) || 0;
        const m = periodMonthNorm(month);
        if (y) {
            const [rows] = await db.query(
                `SELECT report_id, save_id, year, month, scope, is_generated, synced_at
                   FROM dg_ops_planfix_report_meta
                  WHERE year = ? AND month = ?
                  LIMIT 1`,
                [y, m]
            );
            return rows && rows[0] ? rows[0] : null;
        }
        const [fallback] = await db.query(
            `SELECT report_id, save_id, year, month, scope, is_generated, synced_at
               FROM dg_ops_planfix_report_meta
              ORDER BY synced_at DESC
              LIMIT 1`
        );
        return fallback && fallback[0] ? fallback[0] : null;
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

async function upsertReportStatusCounts(db, byTask, meta, year, month) {
    const y = Number(year) || 0;
    const m = periodMonthNorm(month);
    await db.query('DELETE FROM dg_ops_planfix_report_status_counts WHERE year = ? AND month = ?', [
        y,
        m,
    ]);
    const countBy = new Map();
    (byTask || new Map()).forEach((status) => {
        const s = String(status || '').trim();
        if (!s || pf.isPlanfixProcessStatusName(s) || pf.isDealStatusSeparator(s)) return;
        countBy.set(s, (countBy.get(s) || 0) + 1);
    });
    if (!countBy.size) return 0;
    const rows = [...countBy.entries()];
    const ph = rows.map(() => '(?,?,?,?,?,?,?)').join(',');
    const args = [];
    const rid = meta && Number(meta.report_id) ? Number(meta.report_id) : 0;
    const sid = meta && Number(meta.save_id) ? Number(meta.save_id) : 0;
    const ts = mysqlNow();
    rows.forEach(([status, n]) => {
        args.push(y, m, status.slice(0, 191), n, rid, sid, ts);
    });
    await db.query(
        `INSERT INTO dg_ops_planfix_report_status_counts
            (year, month, status_value, n, report_id, save_id, synced_at)
         VALUES ${ph}`,
        args
    );
    return rows.length;
}

async function upsertReportTasks(db, byTask, meta, year, month) {
    const y = Number(year) || 0;
    const m = periodMonthNorm(month);
    await db.query('DELETE FROM dg_ops_planfix_report_task WHERE year = ? AND month = ?', [y, m]);
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
        const ph = slice.map(() => '(?,?,?,?,?,?,?)').join(',');
        const args = [];
        slice.forEach((r) => {
            args.push(y, m, r.task_id, r.status_value, rid, sid, ts);
        });
        await db.query(
            `INSERT INTO dg_ops_planfix_report_task
                (year, month, task_id, status_value, report_id, save_id, synced_at)
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

/**
 * Пересечение сейва отчёта с локальным периодом.
 * Раньше хватало 1 совпавшего task_id (LIMIT 1) — сейв за 2024 проходил как «весь 2025»,
 * гистограмма писалась, а статусы в заявки 2025 почти не попадали → нули в таблице.
 */
async function reportPeriodCoverage(db, byTask, year, month) {
    const ids = [...(byTask || new Map()).keys()];
    const reportN = ids.length;
    const empty = { report_n: reportN, in_period: 0, ok: false };
    if (!reportN || !year) return empty;
    const b = pf.periodBounds(year, month);
    let inPeriod = 0;
    for (let i = 0; i < ids.length; i += 400) {
        const slice = ids.slice(i, i + 400);
        const ph = slice.map(() => '?').join(',');
        const [rows] = await db.query(
            `SELECT COUNT(*) AS n FROM dg_ops_planfix_tasks
              WHERE task_id IN (${ph}) AND created_at >= ? AND created_at < ?`,
            [...slice, b.fromSql, b.toSql]
        );
        inPeriod += Number(rows && rows[0] && rows[0].n) || 0;
    }
    // ≥10% строк сейва и ≥100 задач в периоде (иначе чужой год с парой совпадений)
    const ratio = inPeriod / reportN;
    const ok = inPeriod >= 100 && ratio >= 0.1;
    return { report_n: reportN, in_period: inPeriod, ratio, ok };
}

async function reportOverlapsLocalPeriod(db, byTask, year, month) {
    const cov = await reportPeriodCoverage(db, byTask, year, month);
    return !!cov.ok;
}

async function enrichFromDealStatusReport(appSettings, db, onProgress, year, month, opts) {
    const ids = pf.DEAL_STATUS_REPORT_IDS || [450694];
    // Период generate API не принимает (swagger: тело пустое) — даты как в UI Planfix.
    // Только первый подходящий отчёт. Второй (450690) одночанковый: раньше затирал 25 чанков 450694.
    const splitMonths = (
        opts && Array.isArray(opts.splitMonths) ? opts.splitMonths : []
    )
        .map((x) => Math.round(Number(x)))
        .filter((x) => x >= 1 && x <= 12);
    const periodMonth =
        splitMonths.length > 1
            ? 0
            : Number(month) >= 1 && Number(month) <= 12
              ? Number(month)
              : 0;
    const merged = new Map();
    const unique = [];
    const used = [];
    let generate_error = '';
    let generated = false;
    for (let i = 0; i < ids.length; i += 1) {
        throwIfPfSyncCancelled();
        const id = ids[i];
        if (typeof onProgress === 'function') {
            onProgress(
                splitMonths.length > 1
                    ? `Отчёт ${id}: generate за ${splitMonths.map((m) => MONTH_LABELS[m]).join('+')} (период как в Planfix UI)`
                    : periodMonth
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
                const fresh = await generateDealStatusReportRetry(appSettings, id, onProgress);
                if (fresh && fresh.id) {
                    localGenerated = true;
                    generated = true;
                    save = await resolveSaveChunks(appSettings, id, fresh);
                }
            } catch (e) {
                if (e && e.code === 'PF_SYNC_CANCELLED') throw e;
                generate_error = e && e.message ? e.message : String(e);
            }
            // Не подставляем «самый толстый» исторический сейв: dump на 25 чанков даёт Поставщик 23722
            // при 22912 в Planfix за 2024. Только свежий generate (или ниже — повторный generate).
            if (!save || !save.id) {
                generate_error = generate_error || 'Generate отчёта не вернул сейв';
                continue;
            }
        } catch (e) {
            if (e && e.code === 'PF_SYNC_CANCELLED') throw e;
            generate_error = e && e.message ? e.message : String(e);
            continue;
        }
        if (!save || !save.id) continue;
        save = await resolveSaveChunks(appSettings, id, save);
        let read = await readDealStatusReportPairs(appSettings, id, save, onProgress);
        const overlapMonths =
            splitMonths.length > 1 ? splitMonths : periodMonth ? [periodMonth] : [0];
        let coverage = { report_n: 0, in_period: 0, ok: !year };
        if (year) {
            for (let oi = 0; oi < overlapMonths.length; oi += 1) {
                const cov = await reportPeriodCoverage(db, read.byTask, year, overlapMonths[oi]);
                if (cov.in_period > (coverage.in_period || 0)) coverage = cov;
                if (cov.ok) {
                    coverage = cov;
                    break;
                }
            }
        }
        let overlaps = !!coverage.ok;
        if (!overlaps && !localGenerated) {
            if (typeof onProgress === 'function') {
                onProgress(
                    `Сейв отчёта ${id}: в периоде Datagon только ${coverage.in_period || 0} из ${coverage.report_n || 0} задач — generate в Planfix`
                );
            }
            try {
                const fresh = await generateDealStatusReportRetry(appSettings, id, onProgress);
                if (fresh && fresh.id) {
                    localGenerated = true;
                    generated = true;
                    save = await resolveSaveChunks(appSettings, id, fresh);
                    read = await readDealStatusReportPairs(appSettings, id, save, onProgress);
                    coverage = { report_n: 0, in_period: 0, ok: false };
                    overlaps = false;
                    for (let oi = 0; oi < overlapMonths.length; oi += 1) {
                        const cov = await reportPeriodCoverage(
                            db,
                            read.byTask,
                            year,
                            overlapMonths[oi]
                        );
                        if (cov.in_period > (coverage.in_period || 0)) coverage = cov;
                        if (cov.ok) {
                            coverage = cov;
                            overlaps = true;
                            break;
                        }
                    }
                }
            } catch (e) {
                if (e && e.code === 'PF_SYNC_CANCELLED') throw e;
                generate_error = e && e.message ? e.message : String(e);
            }
        }
        const score = pf.scoreDealStatusUniques(read.unique);
        if (score < 1) continue;
        const dealUniques = (read.unique || []).filter((s) => s && !pf.isPlanfixProcessStatusName(s));

        if (year && !overlaps) {
            const label =
                splitMonths.length > 1
                    ? `${splitMonths.map((m) => MONTH_LABELS[m]).join(', ')} ${year}`
                    : periodMonth
                      ? `${MONTH_LABELS[periodMonth]} ${year}`
                      : `весь ${year}`;
            const err = new Error(
                `Сейв отчёта Planfix (${id}) не пересекается с периодом Datagon «${label}» ` +
                    `(в периоде ${coverage.in_period || 0} из ${coverage.report_n || 0} задач сейва; нужно ≥10% и ≥100). ` +
                    `В UI отчёта https://almamed.planfix.ru/?action=report&id=${id} выставьте тот же год/месяц, generate, и повторите синк. ` +
                    `Гистограмма «В отчёте» за этот период не изменена.`
            );
            err.status = 409;
            err.code = 'REPORT_PERIOD_MISMATCH';
            throw err;
        }
        if (typeof onProgress === 'function' && year) {
            onProgress(
                `Период ок: ${coverage.in_period} из ${coverage.report_n} задач сейва в «${periodMonth ? MONTH_LABELS[periodMonth] + ' ' : 'весь '}${year}»`
            );
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
            covers_period: true,
        });
        // Первый годный отчёт — стоп. Не идём в 450690 (1 чанк), он затирал гистограмму.
        break;
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
    await refreshTaskDatesFromSheet(db);
    if (splitMonths.length > 1) {
        // Один generate за несколько месяцев → разложить снимки по month (не в month=0).
        const idsAll = [...merged.keys()];
        const dateBy = new Map();
        for (let i = 0; i < idsAll.length; i += 400) {
            const slice = idsAll.slice(i, i + 400);
            const ph = slice.map(() => '?').join(',');
            const [drows] = await db.query(
                `SELECT task_id, created_at FROM dg_ops_planfix_task_dates WHERE task_id IN (${ph})`,
                slice
            );
            (drows || []).forEach((r) => {
                dateBy.set(Number(r.task_id), r.created_at);
            });
        }
        for (let mi = 0; mi < splitMonths.length; mi += 1) {
            const m = splitMonths[mi];
            const b = pf.periodBounds(year, m);
            const part = new Map();
            merged.forEach((val, tid) => {
                const raw = dateBy.get(Number(tid));
                if (raw == null) return;
                // created_at в БД — наивное МСК (как NOW() сервера MSK)
                const wall = String(raw).replace('T', ' ').slice(0, 19);
                if (wall >= b.fromSql && wall < b.toSql) part.set(tid, val);
            });
            if (typeof onProgress === 'function') {
                onProgress(
                    `Снимок отчёта ${MONTH_LABELS[m]} ${year}: ${part.size} задач из generate`
                );
            }
            await upsertReportStatusCounts(db, part, used[0], year, m);
            await upsertReportTasks(db, part, used[0], year, m);
            await upsertReportMeta(db, {
                report_id: used[0].report_id,
                save_id: used[0].save_id,
                year: Number(year) || 0,
                month: m,
                scope: 'period',
                generated,
            });
        }
    } else {
        await upsertReportStatusCounts(db, merged, used[0], year, periodMonth);
        await upsertReportTasks(db, merged, used[0], year, periodMonth);
        await upsertReportMeta(db, {
            report_id: used[0].report_id,
            save_id: used[0].save_id,
            year: Number(year) || 0,
            month: periodMonth,
            scope: 'period',
            generated,
        });
    }
    return {
        report_id: used[0].report_id,
        reports: used,
        save_id: used[0].save_id,
        chunks: used.reduce((n, r) => n + (r.chunks || 0), 0),
        report_rows: merged.size,
        statuses_applied: applied,
        unique_statuses: unique,
        generated,
        covers_period: true,
        scope: splitMonths.length > 1 ? 'months_sum' : 'period',
        months: splitMonths.length > 1 ? splitMonths.slice() : undefined,
        generate_error: generate_error || undefined,
    };
}

function assignerLabel(name, joined) {
    if (!joined) return '(не в заявках листа)';
    const t = String(name || '').trim();
    return t || '(без постановщика)';
}

function mergeStatusManagers(sheetBy, reportBy, hasReportCounts) {
    const out = {};
    const statuses = new Set([...Object.keys(sheetBy || {}), ...Object.keys(reportBy || {})]);
    statuses.forEach((st) => {
        const names = new Set([
            ...Object.keys((sheetBy && sheetBy[st]) || {}),
            ...Object.keys((reportBy && reportBy[st]) || {}),
        ]);
        const rows = [...names]
            .map((name) => ({
                name,
                tasks_n: Number((sheetBy && sheetBy[st] && sheetBy[st][name]) || 0) || 0,
                tasks_n_report: hasReportCounts
                    ? Number((reportBy && reportBy[st] && reportBy[st][name]) || 0) || 0
                    : null,
            }))
            .sort((a, b) => String(a.name).localeCompare(String(b.name), 'ru'));
        out[st] = rows;
    });
    return out;
}

async function loadStatusManagerBreakdown(
    db,
    ranges,
    { periodScoped, hasReportCounts, snapYear, snapMonth, snapMonths }
) {
    const sheetBy = {};
    const sheetClause = pf.createdAtRangesSql('created_at', ranges);
    const [sheetRows] = await db.query(
        `SELECT status_value, assigner_name, COUNT(*) AS n
           FROM dg_ops_planfix_tasks
          WHERE ${sheetClause.sql}
          GROUP BY status_value, assigner_name`,
        sheetClause.args
    );
    (sheetRows || []).forEach((r) => {
        const st = String(r.status_value || '');
        const name = assignerLabel(r.assigner_name, true);
        if (!sheetBy[st]) sheetBy[st] = {};
        sheetBy[st][name] = (sheetBy[st][name] || 0) + (Number(r.n) || 0);
    });
    const reportBy = {};
    if (hasReportCounts) {
        try {
            const nameExpr = `CASE
                    WHEN t.task_id IS NULL THEN '(не в заявках листа)'
                    WHEN TRIM(IFNULL(t.assigner_name,'')) = '' THEN '(без постановщика)'
                    ELSE t.assigner_name
                 END`;
            const sy = Number(snapYear) || 0;
            const monthsIn =
                Array.isArray(snapMonths) && snapMonths.length
                    ? snapMonths.map((x) => periodMonthNorm(x)).filter((x) => x >= 1 && x <= 12)
                    : [];
            const datesClause = pf.createdAtRangesSql('d.created_at', ranges);
            let sql;
            let args;
            if (periodScoped && monthsIn.length > 1) {
                const ph = monthsIn.map(() => '?').join(',');
                sql = `SELECT r.status_value, ${nameExpr} AS assigner_name, COUNT(*) AS n
                         FROM dg_ops_planfix_report_task r
                         LEFT JOIN dg_ops_planfix_tasks t ON t.task_id = r.task_id
                        WHERE r.year = ? AND r.month IN (${ph})
                        GROUP BY r.status_value, ${nameExpr}`;
                args = [sy, ...monthsIn];
            } else if (periodScoped) {
                const sm = periodMonthNorm(snapMonth);
                sql = `SELECT r.status_value, ${nameExpr} AS assigner_name, COUNT(*) AS n
                         FROM dg_ops_planfix_report_task r
                         LEFT JOIN dg_ops_planfix_tasks t ON t.task_id = r.task_id
                        WHERE r.year = ? AND r.month = ?
                        GROUP BY r.status_value, ${nameExpr}`;
                args = [sy, sm];
            } else {
                const sm = periodMonthNorm(snapMonth);
                sql = `SELECT r.status_value, ${nameExpr} AS assigner_name, COUNT(*) AS n
                         FROM dg_ops_planfix_report_task r
                         INNER JOIN dg_ops_planfix_task_dates d ON d.task_id = r.task_id
                         LEFT JOIN dg_ops_planfix_tasks t ON t.task_id = r.task_id
                        WHERE r.year = ? AND r.month = ?
                          AND (${datesClause.sql})
                        GROUP BY r.status_value, ${nameExpr}`;
                args = [sy, sm, ...datesClause.args];
            }
            const [rr] = await db.query(sql, args);
            (rr || []).forEach((r) => {
                const st = String(r.status_value || '');
                const name = String(r.assigner_name || '(не в заявках листа)');
                if (!reportBy[st]) reportBy[st] = {};
                reportBy[st][name] = (reportBy[st][name] || 0) + (Number(r.n) || 0);
            });
        } catch (e) {
            if (!(e && (e.errno === 1146 || /doesn't exist/i.test(String(e.message || ''))))) throw e;
        }
    }
    return mergeStatusManagers(sheetBy, reportBy, hasReportCounts);
}

async function loadPlanfixPanel(db, year, managers, monthOrMonths) {
    const monthsList = pf.normalizeMonthsList(
        monthOrMonths == null ? 0 : monthOrMonths,
        0
    );
    const pr = pf.periodRanges(year, monthsList);
    const b = pr.ranges[0] || pf.periodBounds(year, 0);
    const periodLabel =
        monthsList[0] === 0
            ? `весь ${year}`
            : monthsList.length === 1
              ? `${MONTH_LABELS[monthsList[0]]} ${year}`
              : `${monthsList.map((m) => MONTH_LABELS[m]).join(', ')} ${year}`;
    const createdClause = pf.createdAtRangesSql('created_at', pr.ranges);
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
          WHERE ${createdClause.sql}
          GROUP BY status_value`,
        createdClause.args
    );
    const [totRows] = await db.query(
        `SELECT COUNT(*) AS n, MAX(synced_at) AS last_synced_at
           FROM dg_ops_planfix_tasks
          WHERE ${createdClause.sql}`,
        createdClause.args
    );
    let reportCountRows = [];
    let reportMeta = null;
    let hasReportCounts = false;
    let periodScoped = false;
    let snapYear = Number(year) || 0;
    let snapMonth = Number(pr.labelMonth) || 0;
    let snapMonths = null;
    const datesOnReport = pf.createdAtRangesSql('d.created_at', pr.ranges);
    try {
        const reqMonth = monthsList.length === 1 ? monthsList[0] : 0;
        const multiMonths =
            monthsList[0] !== 0 && monthsList.length > 1
                ? monthsList.filter((m) => m >= 1 && m <= 12)
                : null;
        let multiSumOk = false;
        if (multiMonths && multiMonths.length > 1) {
            // Сумма помесячных снимков = гистограмма Planfix за эти месяцы (1+2 → 1605+1581=3186).
            // Раньше резали годовой month=0 по датам → Поставщик 3134 вместо 3186.
            const metas = [];
            multiSumOk = true;
            for (let i = 0; i < multiMonths.length; i += 1) {
                const mr = await loadReportMeta(db, year, multiMonths[i]);
                if (
                    !(
                        mr &&
                        String(mr.scope || '') === 'period' &&
                        Number(mr.year) === Number(year) &&
                        Number(mr.month) === multiMonths[i]
                    )
                ) {
                    multiSumOk = false;
                    break;
                }
                metas.push(mr);
            }
            if (multiSumOk) {
                const ph = multiMonths.map(() => '?').join(',');
                const [rr] = await db.query(
                    `SELECT status_value, SUM(n) AS n
                       FROM dg_ops_planfix_report_status_counts
                      WHERE year = ? AND month IN (${ph})
                      GROUP BY status_value`,
                    [Number(year) || 0, ...multiMonths]
                );
                reportCountRows = rr || [];
                hasReportCounts = reportCountRows.length > 0;
                periodScoped = true;
                snapYear = Number(year) || 0;
                snapMonth = 0;
                snapMonths = multiMonths.slice();
                const latest = metas.reduce((a, b) => {
                    const ta = a && a.synced_at ? new Date(a.synced_at).getTime() : 0;
                    const tb = b && b.synced_at ? new Date(b.synced_at).getTime() : 0;
                    return tb >= ta ? b : a;
                }, metas[0]);
                reportMeta = {
                    report_id: Number(latest && latest.report_id) || 0,
                    save_id: Number(latest && latest.save_id) || 0,
                    synced_at: latest && latest.synced_at ? latest.synced_at : null,
                    scope: 'months_sum',
                    year: snapYear,
                    month: 0,
                    months: multiMonths.slice(),
                };
            }
        }
        const metaRow = !multiSumOk ? await loadReportMeta(db, year, reqMonth) : null;
        periodScoped =
            periodScoped ||
            !!(
                monthsList.length === 1 &&
                metaRow &&
                String(metaRow.scope || '') === 'period' &&
                Number(metaRow.year) === Number(year) &&
                Number(metaRow.month) === reqMonth
            );
        if (!multiSumOk && periodScoped) {
            snapYear = Number(metaRow.year) || 0;
            snapMonth = Number(metaRow.month) || 0;
            // Сейв этого (year, month) — гистограмма 1:1 с Planfix.
            const [rr] = await db.query(
                `SELECT status_value, n, report_id, save_id, synced_at
                   FROM dg_ops_planfix_report_status_counts
                  WHERE year = ? AND month = ?`,
                [snapYear, snapMonth]
            );
            reportCountRows = rr || [];
            hasReportCounts = reportCountRows.length > 0;
            if (!hasReportCounts) {
                // Счётчики могли уйти в year=0; пробуем пересобрать из report_task этого снимка.
                const [fromTasks] = await db.query(
                    `SELECT status_value, COUNT(*) AS n
                       FROM dg_ops_planfix_report_task
                      WHERE year = ? AND month = ?
                      GROUP BY status_value`,
                    [snapYear, snapMonth]
                );
                const byTask = new Map();
                const [idRows] = await db.query(
                    `SELECT task_id, status_value FROM dg_ops_planfix_report_task
                      WHERE year = ? AND month = ?`,
                    [snapYear, snapMonth]
                );
                (idRows || []).forEach((r) => {
                    byTask.set(Number(r.task_id), r.status_value);
                });
                const cov = await reportPeriodCoverage(db, byTask, snapYear, snapMonth);
                if (cov.ok && fromTasks && fromTasks.length) {
                    reportCountRows = fromTasks;
                    hasReportCounts = true;
                } else {
                    // Снимок чужого периода (как «2025» с данными 2024) — не показываем как отчёт года
                    periodScoped = false;
                    reportMeta = null;
                    reportCountRows = [];
                    hasReportCounts = false;
                }
            }
            if (hasReportCounts) {
                reportMeta = {
                    report_id: Number(metaRow.report_id) || 0,
                    save_id: Number(metaRow.save_id) || 0,
                    synced_at: metaRow.synced_at || null,
                    scope: 'period',
                    year: snapYear,
                    month: snapMonth,
                };
            }
        } else if (!multiSumOk) {
            // Нет точного снимка: пробуем полный год того же year (month=0), иначе даты.
            const yearMeta = await loadReportMeta(db, year, 0);
            if (yearMeta && Number(yearMeta.year) === Number(year) && Number(yearMeta.month) === 0) {
                snapYear = Number(year) || 0;
                snapMonth = 0;
                const [rr] = await db.query(
                    `SELECT r.status_value, COUNT(*) AS n
                       FROM dg_ops_planfix_report_task r
                       INNER JOIN dg_ops_planfix_task_dates d ON d.task_id = r.task_id
                      WHERE r.year = ? AND r.month = 0
                        AND (${datesOnReport.sql})
                      GROUP BY r.status_value`,
                    [snapYear, ...datesOnReport.args]
                );
                reportCountRows = rr || [];
                hasReportCounts = reportCountRows.length > 0;
                if (hasReportCounts) {
                    reportMeta = {
                        report_id: Number(yearMeta.report_id) || 0,
                        save_id: Number(yearMeta.save_id) || 0,
                        synced_at: yearMeta.synced_at || null,
                        scope: 'all',
                        year: snapYear,
                        month: 0,
                    };
                }
            } else {
                const [[snap]] = await db.query(
                    `SELECT COUNT(*) AS n, MAX(report_id) AS report_id, MAX(save_id) AS save_id,
                            MAX(synced_at) AS synced_at, MAX(year) AS y, MAX(month) AS m
                       FROM dg_ops_planfix_report_task
                      WHERE year = ?`,
                    [Number(year) || 0]
                );
                hasReportCounts = Number(snap && snap.n) > 0;
                if (hasReportCounts) {
                    snapYear = Number(snap.y) || Number(year) || 0;
                    snapMonth = Number(snap.m) || 0;
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
                          WHERE r.year = ? AND r.month = ?
                            AND (${datesOnReport.sql})
                          GROUP BY r.status_value`,
                        [snapYear, snapMonth, ...datesOnReport.args]
                    );
                    reportCountRows = rr || [];
                }
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
    const mgrByStatus = await loadStatusManagerBreakdown(db, pr.ranges, {
        periodScoped,
        hasReportCounts,
        snapYear,
        snapMonth,
        snapMonths,
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
                managers: isSep ? [] : mgrByStatus[status_value] || [],
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
        month: monthsList.length === 1 ? monthsList[0] : 0,
        months: monthsList,
        period: periodLabel,
        empty_status: emptyStatus,
        with_status: Math.max(0, (Number(tot.n) || 0) - emptyStatus),
        report_total: hasReportCounts ? reportTotal : null,
        report_meta: reportMeta,
    };
}

function monthsFromRequest(req, body) {
    const src = body && typeof body === 'object' ? body : {};
    if (src.months != null) return pf.normalizeMonthsList(src.months, 0);
    if (req && req.query && req.query.months != null) {
        return pf.normalizeMonthsList(req.query.months, 0);
    }
    const single =
        src.month != null
            ? src.month
            : req && req.query
              ? req.query.month
              : null;
    return pf.normalizeMonthsList(single, 0);
}

function composeMonthRow(mgr, agg, plan, manual, opts) {
    const o = opts || {};
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
        manual,
        o
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
            const managers = await listSalesManagers(db, { includeArchived: true });
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
                    bonus_current:
                        'SUM(diff) × pct_mp / 100 по credit-менеджеру (COALESCE(handed_to, manager)): все продажи месяца — отгруженные и нет, включая переданные от других',
                    applications_local:
                        'COUNT задач из dg_ops_planfix_tasks (постановщик=менеджер); все статусы кроме: Товар получен, Заказан товар у поставщика, Поставщик, Информационное письмо, Подбор по Т.з., клиент отказался - мониторинг цен - ГБУЗ',
                    applications_count:
                        'Импорт из Google операционного листа (колонка «Кол-во заявок») → «Кол-во заявок (с Гугла)»',
                    paid_applications: 'COUNT DISTINCT № счёта (или строки без счёта) credit-менеджера за месяц',
                    apps_per_sale_local: 'applications_local / paid_applications (целое, Math.round)',
                    apps_per_sale: 'applications_count / paid_applications (целое, Math.round)',
                    avg_check: 'turnover / paid_applications',
                    fact_profit: 'profit_after_tax − bonus_current − salary',
                    salary_paid: 'salary + bonus_past',
                    company_profit: 'profit_after_tax − salary_paid',
                    company_pct: 'company_profit / turnover × 100',
                    bonus_past:
                        'С окт. 2026: SUM(bonus) всех отгрузок месяца (прошлые + текущие оплаты). Карандаш — override. До окт. 2026 — архив',
                },
                ops_auto_from: OPS_AUTO_FROM,
            });
        } catch (e) {
            console.error('[ops-sheet/meta]', e);
            res.status(500).json({ success: false, error: e.message || 'meta failed' });
        }
    });

    router.get('/bonus-past-orders', async (req, res) => {
        try {
            await ensureSchema(db);
            const year = normYear(req.query.year, null);
            const month = normMonth(req.query.month);
            const mid = Number(req.query.manager_user_id);
            if (!year || !month || !Number.isFinite(mid) || mid <= 0) {
                return res.status(400).json({
                    success: false,
                    error: 'Нужны year, month, manager_user_id',
                });
            }
            const managers = await listSalesManagers(db, { includeArchived: true });
            const mgr = managers.find((m) => m.id === mid);
            if (!mgr) {
                return res.status(400).json({
                    success: false,
                    error: 'Менеджер не из группы «Менеджер по продажам»',
                });
            }
            const orders = await listBonusPastOrders(db, year, month, mid);
            let totalBonus = 0;
            let totalPast = 0;
            let totalCurrent = 0;
            let countPast = 0;
            let countCurrent = 0;
            orders.forEach((o) => {
                const b = toNum(o.bonus) || 0;
                totalBonus += b;
                if (o.bucket === 'current') {
                    totalCurrent += b;
                    countCurrent += 1;
                } else {
                    totalPast += b;
                    countPast += 1;
                }
            });
            const manualMap = await loadManualMap(db, year);
            const man = manualMap[`${mid}:${month}`] || {};
            res.json({
                success: true,
                year,
                month,
                manager_user_id: mid,
                manager_name: mgr.full_name || mgr.username || '',
                ops_auto_era: isOpsAutoEra(year, month),
                ops_auto_from: OPS_AUTO_FROM,
                total_bonus: round2(totalBonus),
                total_from_past: round2(totalPast),
                total_from_current: round2(totalCurrent),
                orders_count: orders.length,
                orders_from_past: countPast,
                orders_from_current: countCurrent,
                note:
                    'Сюда входят все отгрузки месяца (оплата раньше или в этом месяце). «Премия за текущий месяц» — отдельно: полная премия по всем продажам месяца (отгруженные и нет + переданные).',
                bonus_past_manual: Number(man.bonus_past_manual) === 1 ? 1 : 0,
                bonus_past_override: man.bonus_past != null ? Number(man.bonus_past) : null,
                orders,
            });
        } catch (e) {
            console.error('[ops-sheet/bonus-past-orders]', e);
            res.status(500).json({ success: false, error: e.message || 'load failed' });
        }
    });

    /**
     * Разворот «Кол-во заявок*» по менеджеру/месяцу: статусы задач Planfix.
     * Query: year, month (1–12), manager_user_id.
     */
    router.get('/manager-app-statuses', async (req, res) => {
        try {
            await ensureSchema(db);
            const year = normYear(req.query.year, currentYear());
            const month = normMonth(req.query.month);
            const mid = Number(req.query.manager_user_id);
            if (!year || !month || !Number.isFinite(mid) || mid <= 0) {
                return res.status(400).json({
                    success: false,
                    error: 'Нужны year, month (1–12), manager_user_id',
                });
            }
            const managers = await listSalesManagers(db, { includeArchived: true });
            const mgr = managers.find((m) => Number(m.id) === mid);
            if (!mgr) {
                return res.status(404).json({ success: false, error: 'Менеджер не найден' });
            }
            const b = pf.periodBounds(year, month);
            const [agg] = await db.query(
                `SELECT assigner_name, status_value, COUNT(*) AS n
                   FROM dg_ops_planfix_tasks
                  WHERE created_at >= ? AND created_at < ?
                  GROUP BY assigner_name, status_value`,
                [b.fromSql, b.toSql]
            );
            const byStatus = {};
            (agg || []).forEach((row) => {
                const matched = pf.matchManagerByAssigner(row.assigner_name, [mgr]);
                if (!matched || Number(matched.id) !== mid) return;
                const st = String(row.status_value || '');
                const n = Number(row.n) || 0;
                byStatus[st] = (byStatus[st] || 0) + n;
            });
            const statuses = Object.keys(byStatus)
                .map((status_value) => {
                    const n = byStatus[status_value];
                    const excluded = pf.isExcludedFromAppsCount(status_value);
                    return {
                        status_value: status_value || '(без статуса)',
                        n,
                        excluded,
                        sort: pf.defaultDealStatusSortIndex(status_value),
                    };
                })
                .sort((a, b) => {
                    if (a.excluded !== b.excluded) return a.excluded ? 1 : -1;
                    if (a.sort !== b.sort) {
                        if (a.sort < 0 && b.sort < 0) return b.n - a.n;
                        if (a.sort < 0) return 1;
                        if (b.sort < 0) return -1;
                        return a.sort - b.sort;
                    }
                    return b.n - a.n;
                });
            let included_total = 0;
            let excluded_total = 0;
            statuses.forEach((s) => {
                if (s.excluded) excluded_total += s.n;
                else included_total += s.n;
            });
            res.json({
                success: true,
                year,
                month,
                manager_user_id: mid,
                manager_name: mgr.full_name || mgr.username || '',
                included_total,
                excluded_total,
                all_total: included_total + excluded_total,
                statuses,
            });
        } catch (e) {
            console.error('[ops-sheet/manager-app-statuses]', e);
            res.status(500).json({ success: false, error: e.message || 'statuses failed' });
        }
    });

    router.get('/planfix', async (req, res) => {
        try {
            await ensureSchema(db);
            const year = normYear(req.query.year, currentYear());
            const months = monthsFromRequest(req, null);
            const month = months.length === 1 ? months[0] : 0;
            const managers = await listSalesManagers(db);
            const panel = await loadPlanfixPanel(db, year, managers, months);
            const { token, account, base } = credsFromSettings(settings);
            res.json({
                success: true,
                year,
                month,
                months,
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
            const months = monthsFromRequest(req, null);
            const pr = pf.periodRanges(year, months);
            const createdClause = pf.createdAtRangesSql('created_at', pr.ranges);
            const q = String(req.query.q || req.query.search || '').trim();
            let limit = Number(req.query.limit);
            if (!Number.isFinite(limit) || limit < 1) limit = 100;
            if (limit > 200) limit = 200;
            let page = Number(req.query.page);
            if (!Number.isFinite(page) || page < 1) page = 1;
            const offset = (page - 1) * limit;
            const args = createdClause.args.slice();
            let where = `(${createdClause.sql})`;
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
            const periodLabel =
                months[0] === 0
                    ? `весь ${year}`
                    : months.length === 1
                      ? `${MONTH_LABELS[months[0]]} ${year}`
                      : `${months.map((m) => MONTH_LABELS[m]).join(', ')} ${year}`;
            res.json({
                success: true,
                months,
                year,
                month: pr.labelMonth != null ? pr.labelMonth : months.length === 1 ? months[0] : 0,
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

    /** Preflight: матчинг менеджеров продаж ↔ Planfix /user/list (без /task/list). */
    router.get('/planfix-assigners', async (req, res) => {
        try {
            await ensureSchema(db);
            const { token } = credsFromSettings(settings);
            if (!token) {
                return res.status(400).json({
                    success: false,
                    error: 'Сначала сохраните REST-токен в Настройки → Planfix',
                });
            }
            const managers = await listSalesManagers(db);
            const pfUsers = await listPlanfixUsers(settings, null);
            const matched = matchAssignerIds(pfUsers, managers);
            res.json({
                success: true,
                sync_script: getOpsPlanfixSyncMeta(),
                managers_total: managers.length,
                pf_users: pfUsers.length,
                assigners_matched: matched.ids.length,
                assigner_ids: matched.ids,
                assigner_names: matched.names,
                unmatched_managers: (matched.unmatchedManagers || []).map((m) => ({
                    id: m.id,
                    full_name: m.full_name || m.username || '',
                    username: m.username || '',
                })),
                note:
                    'Синк Planfix идёт только по сматченным user id. Полный проход «все постановщики» отключён (rev.22).',
            });
        } catch (e) {
            res.status(500).json({
                success: false,
                error: e && e.message ? e.message : 'planfix-assigners failed',
            });
        }
    });

    router.post('/planfix-sync-cancel', (req, res) => {
        if (!canWrite(req)) {
            return res.status(403).json({ success: false, error: 'Недостаточно прав (нужен full)' });
        }
        if (!pfSyncJob.active) {
            return res.json({
                success: true,
                cancelled: false,
                message: 'Синк Planfix сейчас не идёт',
                ...pfSyncPublic(),
            });
        }
        pfSyncJob.cancelRequested = true;
        markPfSync({
            message: 'Остановка по запросу — дождёмся конца текущего запроса к Planfix…',
        });
        return res.json({
            success: true,
            cancelled: true,
            ...pfSyncPublic(),
        });
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
            const monthsQueue = monthsFromRequest(req, body);
            let month = monthsQueue[0];
            const periodLabelFor = (m) =>
                m ? `${MONTH_LABELS[m]} ${year}` : `весь ${year}`;
            const periodLabel =
                monthsQueue[0] === 0
                    ? `весь ${year}`
                    : monthsQueue.length === 1
                      ? periodLabelFor(monthsQueue[0])
                      : `${monthsQueue.map((m) => MONTH_LABELS[m]).join(', ')} ${year}`;
            const dryRun =
                body.dry_run === 1 ||
                body.dry_run === true ||
                body.dry_run === '1' ||
                String(req.query.dry_run || '') === '1';
            const reportOnly =
                body.report_only === 1 ||
                body.report_only === true ||
                body.report_only === '1' ||
                String(req.query.report_only || '') === '1';
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
                cancelRequested: false,
                stage: reportOnly ? 'status_report' : 'fields',
                message: dryRun
                    ? `Пробный просмотр (${periodLabel}): справочник полей`
                    : reportOnly
                      ? `Только отчёт Planfix «${pf.STATUS_FIELD_NAME}» за ${periodLabel} (без повторной выгрузки задач)`
                      : monthsQueue[0] === 0
                        ? `Весь ${year}: заявки листа одним прогоном`
                        : `Синк Planfix за ${periodLabel}`,
                pages: 0,
                fetched: 0,
                stored: 0,
                started_ms: started,
            });
            ownsJob = true;
            setImmediate(() => {
                (async () => {
            if (reportOnly && !dryRun) {
                const errors = [];
                const reportMonth = monthsQueue.length === 1 ? monthsQueue[0] : 0;
                markPfSync({
                    stage: 'status_report',
                    message: `Generate отчёта за ${periodLabelFor(reportMonth)} (задачи листа не трогаем)`,
                });
                let reportMeta = null;
                try {
                    reportMeta = await enrichFromDealStatusReport(settings, db, (msg) => {
                        markPfSync({ stage: 'status_report', message: msg });
                    }, year, reportMonth);
                } catch (e) {
                    errors.push({
                        code: 'status_report',
                        error: e && e.message ? e.message : 'Не удалось прочитать отчёт',
                    });
                    throw e;
                }
                const b2 = pf.periodBounds(year, month);
                const [totRows] = await db.query(
                    `SELECT COUNT(*) AS n FROM dg_ops_planfix_tasks
                      WHERE created_at >= ? AND created_at < ?`,
                    [b2.fromSql, b2.toSql]
                );
                const [emptyRows] = await db.query(
                    `SELECT COUNT(*) AS n FROM dg_ops_planfix_tasks
                      WHERE created_at >= ? AND created_at < ?
                        AND (status_value IS NULL OR status_value = '')`,
                    [b2.fromSql, b2.toSql]
                );
                const durationSec = Math.round((Date.now() - started) / 10) / 100;
                const localN = Number(totRows && totRows[0] && totRows[0].n) || 0;
                const emptyN = Number(emptyRows && emptyRows[0] && emptyRows[0].n) || 0;
                markPfSync({
                    active: false,
                    stage: 'done',
                    last_error: null,
                    message: `Отчёт готов: ${reportMeta.report_rows || 0} задач в сейве, статусы на лист записаны, ${durationSec} с`,
                    pages: 0,
                    fetched: reportMeta.report_rows || 0,
                    stored: reportMeta.statuses_applied || 0,
                });
                // result for waiters is via status; panel reload on client
                void localN;
                void emptyN;
                void errors;
                return;
            }
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
            const unmatchedNames = (matchedAssigners.unmatchedManagers || []).map(
                (m) => m.full_name || m.username || String(m.id)
            );
            const assignerQueue = matchedAssigners.ids.slice();
            markPfSync({
                stage: 'assigners',
                assigners_matched: matchedAssigners.ids.length,
                unmatched_managers: unmatchedNames,
                message:
                    'Постановщики: сматчено ' +
                    matchedAssigners.ids.length +
                    ' из ' +
                    managers.length +
                    (unmatchedNames.length
                        ? '; нет в /user/list (не «нет в отчёте»): ' +
                          unmatchedNames.join(', ') +
                          ' — догрузим с задач'
                        : ''),
            });
            if (!assignerQueue.length) {
                const errMsg =
                    'Не сопоставили ни одного сотрудника Planfix с менеджерами продаж — синк без полного дампа аккаунта невозможен. Проверьте ФИО в Datagon = ФИО в Planfix.';
                errors.push({ code: 'assigners', error: errMsg });
                markPfSync({
                    active: false,
                    stage: 'error',
                    last_error: errMsg,
                    message: errMsg,
                    pages: 0,
                    fetched: 0,
                    stored: 0,
                });
                return;
            }
            // Planfix /user/list часто без уволенных и с урезанным name («Глеб» без фамилии).
            // Они МОГУТ быть в отчёте 450694 и на старых задачах — «не в /user/list» ≠ «нет в Planfix».
            // Без доп. прохода prune вычищал их из листа → «(не в заявках листа)» с нулём справа.
            let recoverUnmatchedPass = false;
            if (unmatchedNames.length) {
                recoverUnmatchedPass = true;
                errors.push({
                    code: 'assigners_partial',
                    error:
                        'Нет в активном /user/list Planfix (часто уволенные; в отчёте 450694 они всё равно могут быть): ' +
                        unmatchedNames.join(', ') +
                        ' — доп. проход без фильтра постановщика; в лист только задачи менеджеров продаж по ФИО с заявки.',
                });
                if (assignerQueue.indexOf(null) < 0) assignerQueue.push(null);
            }
            const templateQueue =
                (pf.DEAL_STATUS_TEMPLATE_IDS || []).length > 0
                    ? pf.DEAL_STATUS_TEMPLATE_IDS.slice()
                    : [null];

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
            const firstAssigner = assignerQueue[0];
            try {
                markPfSync({
                    stage: 'first_page',
                    message: `Первая страница за ${periodLabel} (постановщики: ${
                        recoverUnmatchedPass
                            ? matchedAssigners.ids.length + '+догрузка несматченных'
                            : matchedAssigners.ids.length || '—'
                    }, шаблон=${templateQueue[0] || 'любой'}, дата=${dateType})`,
                });
                await loadPage(0, firstAssigner, templateQueue[0]);
            } catch (e) {
                dateType = 'otherPeriod';
                await loadPage(0, firstAssigner, templateQueue[0]);
            }

            const syncedAt = mysqlNow();
            let pages = 0;
            const seenFetched = new Set();
            const seenStored = new Set();
            let skippedNoDate = 0;
            let skippedNoId = 0;
            let skippedNotManager = 0;
            let emptyStatus = 0;
            const seenStatuses = {};
            const sampleAssigners = {};

            const consume = async (payload, write) => {
                const tasks = pf.collectTasks(payload);
                pages += 1;
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
                    seenFetched.add(String(mapped.task_id));
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
                    rows.forEach((r) => seenStored.add(String(r.task_id)));
                }
                const fetched = seenFetched.size;
                const stored = seenStored.size;
                markPfSync({
                    stage: 'pages',
                    pages,
                    fetched,
                    stored,
                    assigners_matched: matchedAssigners.ids.length,
                    unmatched_managers: unmatchedNames,
                    message: dryRun
                        ? `Пробный просмотр: страница ${pages}, уникальных задач ${fetched}`
                        : `Страница ${pages}: уникальных ${fetched}, записано уникальных ${stored}, чужих постановщиков ${skippedNotManager}`,
                });
                return tasks.length;
            };

            async function paginateAssigner(assignerId, templateId) {
                let pageLen = 0;
                let localOffset = 0;
                do {
                    throwIfPfSyncCancelled();
                    markPfSync({
                        stage: 'pages',
                        message:
                            (assignerId
                                ? `Постановщик user:${assignerId}`
                                : 'Догрузка несматченных (все постановщики периода → только менеджеры продаж)') +
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

            for (let mi = 0; mi < monthsQueue.length; mi += 1) {
                month = monthsQueue[mi];
                const sliceLabel = periodLabelFor(month);
                markPfSync({
                    stage: 'pages',
                    message:
                        monthsQueue.length > 1
                            ? `Период ${mi + 1}/${monthsQueue.length}: ${sliceLabel}`
                            : `Выгрузка заявок: ${sliceLabel}`,
                    year,
                    month,
                });
                for (let ai = 0; ai < assignerQueue.length; ai += 1) {
                    throwIfPfSyncCancelled();
                    for (let ti = 0; ti < templateQueue.length; ti += 1) {
                        await paginateAssigner(assignerQueue[ai], templateQueue[ti]);
                    }
                }

                if (!dryRun) {
                    throwIfPfSyncCancelled();
                    markPfSync({
                        stage: 'task_dates',
                        message: `Копируем даты из заявок листа (${sliceLabel})`,
                    });
                    await indexAllTaskDatesForPeriod(settings, db, year, month, (msg) => {
                        markPfSync({ stage: 'task_dates', message: msg });
                    });
                }

                if (!dryRun) {
                    throwIfPfSyncCancelled();
                    const b = pf.periodBounds(year, month);
                    const keepNames = unmatchedNames
                        .map((n) => String(n || '').trim())
                        .filter(Boolean);
                    markPfSync({
                        stage: 'prune',
                        message: keepNames.length
                            ? `Чистим ${sliceLabel}, кроме несматченных (${keepNames.length})`
                            : month
                              ? `Чистим задачи ${sliceLabel}, которых не было в этом прогоне`
                              : `Чистим задачи года ${year}, которых не было в этом прогоне`,
                    });
                    if (keepNames.length) {
                        const ph = keepNames.map(() => '?').join(',');
                        await db.query(
                            `DELETE FROM dg_ops_planfix_tasks
                              WHERE created_at >= ? AND created_at < ? AND synced_at < ?
                                AND TRIM(IFNULL(assigner_name,'')) NOT IN (${ph})`,
                            [b.fromSql, b.toSql, syncedAt, ...keepNames]
                        );
                    } else {
                        await db.query(
                            `DELETE FROM dg_ops_planfix_tasks
                              WHERE created_at >= ? AND created_at < ? AND synced_at < ?`,
                            [b.fromSql, b.toSql, syncedAt]
                        );
                    }
                }
            }

            if (!dryRun) {
                await upsertCatalog(db, field.enumValues || [], 'enum');
                await upsertCatalog(db, Object.keys(seenStatuses), 'task');
                let reportMeta = null;
                const reportMonth = monthsQueue.length === 1 ? monthsQueue[0] : 0;
                const splitMonths =
                    monthsQueue.length > 1 && monthsQueue[0] !== 0
                        ? monthsQueue.filter((m) => m >= 1 && m <= 12)
                        : null;
                try {
                    markPfSync({
                        stage: 'status_report',
                        message:
                            splitMonths && splitMonths.length
                                ? `Отдельно забираем «${pf.STATUS_FIELD_NAME}» из отчёта Planfix (${splitMonths
                                      .map((m) => MONTH_LABELS[m])
                                      .join('+')} ${year} — в UI Planfix тот же диапазон)`
                                : `Отдельно забираем «${pf.STATUS_FIELD_NAME}» из отчёта Planfix (${periodLabelFor(reportMonth)})`,
                    });
                    reportMeta = await enrichFromDealStatusReport(
                        settings,
                        db,
                        (msg) => {
                            markPfSync({ stage: 'status_report', message: msg });
                        },
                        year,
                        reportMonth,
                        splitMonths && splitMonths.length ? { splitMonths } : undefined
                    );
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
                    const prDone = pf.periodRanges(year, monthsQueue);
                    const emptyClause = pf.createdAtRangesSql('created_at', prDone.ranges);
                    const [emptyRows] = await db.query(
                        `SELECT COUNT(*) AS n FROM dg_ops_planfix_tasks
                          WHERE (${emptyClause.sql})
                            AND (status_value IS NULL OR status_value = '')`,
                        emptyClause.args
                    );
                    emptyStatus = Number(emptyRows && emptyRows[0] && emptyRows[0].n) || 0;
                    const [seenRows] = await db.query(
                        `SELECT DISTINCT status_value FROM dg_ops_planfix_tasks
                          WHERE (${emptyClause.sql})
                            AND status_value IS NOT NULL AND status_value <> ''`,
                        emptyClause.args
                    );
                    (seenRows || []).forEach((r) => {
                        if (r.status_value) seenStatuses[r.status_value] = true;
                    });
                } catch (e) {
                    if (e && e.code === 'PF_SYNC_CANCELLED') throw e;
                    errors.push({
                        code:
                            e && e.code === 'REPORT_PERIOD_MISMATCH'
                                ? 'status_report_period'
                                : 'status_report',
                        error: e && e.message ? e.message : 'Не удалось прочитать отчёт «Статус Сделки/Письма»',
                    });
                }
                field.report = reportMeta;
            } else {
                await upsertCatalog(db, field.enumValues || [], 'enum');
            }

            const durationSec = Math.round((Date.now() - started) / 10) / 100;
            const fetched = seenFetched.size;
            const stored = seenStored.size;
            markPfSync({
                active: false,
                stage: 'done',
                last_error: null,
                pages,
                fetched,
                stored: dryRun ? 0 : stored,
                assigners_matched: matchedAssigners.ids.length,
                unmatched_managers: unmatchedNames,
                message: dryRun
                    ? `Пробный просмотр готов: ${fetched} уникальных задач`
                    : `Готово: ${stored} уникальных задач за ${durationSec} с` +
                      (unmatchedNames.length
                          ? ` · несматченные: ${unmatchedNames.join(', ')}`
                          : ''),
            });
                })()
                    .catch((e) => {
                        if (e && e.code === 'PF_SYNC_CANCELLED') {
                            markPfSync({
                                active: false,
                                stage: 'cancelled',
                                last_error: null,
                                cancelRequested: false,
                                message: e.message || 'Синк Planfix остановлен',
                            });
                            return;
                        }
                        const status = e.status && e.status >= 400 && e.status < 600 ? e.status : 500;
                        if (status >= 500) console.error('[ops-sheet/planfix-sync]', e);
                        const msg = formatPlanfixSyncError(e);
                        markPfSync({
                            active: false,
                            stage: 'error',
                            last_error: msg,
                            message: msg,
                            cancelRequested: false,
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
                report_only: !!reportOnly,
                year,
                month,
                months: monthsQueue,
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
            const managers = await listSalesManagers(db, { includeArchived: true });
            const mids = managers.map((m) => m.id);
            const [aggregates, plans, manualMap, pfApps, bonusPastMap] = await Promise.all([
                fetchMonthAggregates(db, year, mids),
                loadPlans(db),
                loadManualMap(db, year),
                fetchPlanfixAppCounts(db, year, managers),
                fetchBonusPastByShipped(db, year, mids),
            ]);
            const months = buildYearSnapshot(
                managers,
                year,
                aggregates,
                plans,
                manualMap,
                pfApps.countsLocal || {},
                bonusPastMap
            );
            res.json({
                success: true,
                year,
                managers,
                months,
                can_write: canWrite(req),
                planfix_unmatched: pfApps.unmatched || {},
                ops_auto_from: OPS_AUTO_FROM,
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
            const managers = await listSalesManagers(db, { includeArchived: true });
            const mgr = managers.find((m) => m.id === mid);
            if (!mgr) {
                return res.status(400).json({ success: false, error: 'Менеджер не из группы «Менеджер по продажам»' });
            }
            const patch = parseManualBody(body);
            if (!Object.keys(patch).length) {
                return res.status(400).json({ success: false, error: 'Нет полей для сохранения' });
            }

            const [existingRows] = await db.query(
                `SELECT applications_count, coefficient, bonus_past, bonus_past_manual, salary
                   FROM dg_ops_sheet_manual
                  WHERE year = ? AND month = ? AND manager_user_id = ?
                  LIMIT 1`,
                [year, month, mid]
            );
            const prev = existingRows && existingRows[0] ? existingRows[0] : {};
            let bonusPastManual =
                prev.bonus_past_manual != null ? (Number(prev.bonus_past_manual) === 1 ? 1 : 0) : 0;
            let nextBonusPast =
                prev.bonus_past != null ? Number(prev.bonus_past) : null;
            if (patch.bonus_past !== undefined) {
                nextBonusPast = patch.bonus_past;
                // null / пусто в авто-эре → сброс к авторасчёту; иначе ручной override
                if (patch.bonus_past == null) {
                    bonusPastManual = 0;
                } else {
                    bonusPastManual = 1;
                }
            }
            const next = {
                applications_count:
                    prev.applications_count != null
                        ? Math.round(Number(prev.applications_count) || 0)
                        : null,
                coefficient:
                    patch.coefficient !== undefined
                        ? patch.coefficient
                        : prev.coefficient != null
                          ? Number(prev.coefficient)
                          : null,
                bonus_past: nextBonusPast,
                bonus_past_manual: bonusPastManual,
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
                    (year, month, manager_user_id, coefficient, bonus_past, bonus_past_manual, salary, updated_by)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE
                    coefficient = VALUES(coefficient),
                    bonus_past = VALUES(bonus_past),
                    bonus_past_manual = VALUES(bonus_past_manual),
                    salary = VALUES(salary),
                    updated_by = VALUES(updated_by)`,
                [
                    year,
                    month,
                    mid,
                    next.coefficient,
                    next.bonus_past,
                    next.bonus_past_manual,
                    next.salary,
                    actor,
                ]
            );

            const allMids = managers.map((m) => m.id);
            const [allAgg, plans, manualMap, pfApps, bonusPastMap] = await Promise.all([
                fetchMonthAggregates(db, year, allMids),
                loadPlans(db),
                loadManualMap(db, year),
                fetchPlanfixAppCounts(db, year, managers),
                fetchBonusPastByShipped(db, year, allMids),
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
                const manBase =
                    m.id === mid
                        ? Object.assign({}, manualMap[k] || emptyManual(), next)
                        : manualMap[k] || emptyManual();
                const bp = bonusPastMap[k] || emptyShippedBonusCell();
                return composeMonthRow(
                    m,
                    a,
                    p,
                    manualWithApps(manBase, (pfApps.countsLocal || {})[k] || 0),
                    {
                        year,
                        month,
                        bonus_past_auto: bp.sum,
                        bonus_past_manual: manBase.bonus_past_manual,
                        bonus_past_orders_count: bp.count,
                        bonus_past_from_past: bp.sum_past,
                        bonus_past_from_current: bp.sum_current,
                    }
                );
            });
            const row = monthRows.find((r) => Number(r.manager_user_id) === mid);

            res.json({
                success: true,
                year,
                month,
                row,
                totals: buildTotals(monthRows),
                ops_auto_era: isOpsAutoEra(year, month),
            });
        } catch (e) {
            const status = e.status || 500;
            if (status >= 500) console.error('[ops-sheet/manual]', e);
            res.status(status).json({ success: false, error: e.message || 'save failed' });
        }
    });

    return router;
};
