'use strict';

/**
 * Финансы Wildberries для /finance.html:
 * - GET finance-api…/account/balance → current / for_withdraw
 * - POST …/sales-reports/list → bankPaymentSum по неделям
 * - dg_mp_wb_payout_inflight: открытие по дельте вывода + safety-net;
 *   закрытие по матчу входящих РВБ в dg_finance_tx.
 *
 * Итого «WB должен» = current + Σ open inflight.
 */

const axios = require('axios');
const { getWbFinanceSyncMeta } = require('./datagonWbFinanceSyncRevision');

const WB_FINANCE_BASE = 'https://finance-api.wildberries.ru';
const AMOUNT_EPS = 0.05;
const SAFETY_NET_LOOKBACK_DAYS = 75;

let schemaReady = null;

function num(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
}

function ymd(d) {
    const dt = d instanceof Date ? d : new Date(d);
    if (Number.isNaN(dt.getTime())) return '';
    const y = dt.getUTCFullYear();
    const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
    const day = String(dt.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

function mskYmd(d) {
    const dt = d instanceof Date ? d : new Date();
    const fmt = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Europe/Moscow',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    });
    return fmt.format(dt);
}

function wbCreds(appSettings) {
    return { apiKey: String((appSettings && appSettings.wb_api_key) || '').trim() };
}

function wbHeaders(creds) {
    return {
        Authorization: creds.apiKey,
        'Content-Type': 'application/json',
    };
}

function amountsClose(a, b) {
    return Math.abs(num(a) - num(b)) <= AMOUNT_EPS;
}

async function ensureWbFinanceSchema(db) {
    if (schemaReady) return schemaReady;
    schemaReady = (async () => {
        await db.query(`
            CREATE TABLE IF NOT EXISTS dg_mp_wb_finance_balance (
                as_of_date DATE NOT NULL,
                currency VARCHAR(8) NOT NULL DEFAULT 'RUB',
                current_amount DECIMAL(18,2) NOT NULL DEFAULT 0,
                for_withdraw DECIMAL(18,2) NOT NULL DEFAULT 0,
                synced_at DATETIME NOT NULL,
                PRIMARY KEY (as_of_date),
                KEY idx_wb_bal_synced (synced_at)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);
        await db.query(`
            CREATE TABLE IF NOT EXISTS dg_mp_wb_sales_report (
                report_id BIGINT NOT NULL,
                date_from DATE NOT NULL,
                date_to DATE NOT NULL,
                report_type INT NOT NULL DEFAULT 0,
                for_pay_sum DECIMAL(18,2) NOT NULL DEFAULT 0,
                bank_payment_sum DECIMAL(18,2) NOT NULL DEFAULT 0,
                retail_amount_sum DECIMAL(18,2) NOT NULL DEFAULT 0,
                create_date DATETIME NULL,
                payload_json JSON NULL,
                synced_at DATETIME NOT NULL,
                PRIMARY KEY (report_id),
                KEY idx_wb_sr_dates (date_from, date_to)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);
        await db.query(`
            CREATE TABLE IF NOT EXISTS dg_mp_wb_payout_inflight (
                id BIGINT NOT NULL AUTO_INCREMENT,
                amount DECIMAL(18,2) NOT NULL,
                status VARCHAR(16) NOT NULL DEFAULT 'open',
                source VARCHAR(32) NOT NULL DEFAULT 'withdraw_delta',
                opened_at DATETIME NOT NULL,
                period_from DATE NULL,
                period_to DATE NULL,
                note VARCHAR(255) NULL,
                settled_tx_id VARCHAR(128) NULL,
                settled_at DATETIME NULL,
                synced_at DATETIME NOT NULL,
                PRIMARY KEY (id),
                KEY idx_wb_inf_status (status),
                KEY idx_wb_inf_amount (amount),
                KEY idx_wb_inf_opened (opened_at)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);
        await db.query(`
            CREATE TABLE IF NOT EXISTS dg_mp_wb_finance_month (
                ym CHAR(7) NOT NULL,
                on_balance DECIMAL(18,2) NOT NULL DEFAULT 0,
                on_wire DECIMAL(18,2) NOT NULL DEFAULT 0,
                owed_total DECIMAL(18,2) NOT NULL DEFAULT 0,
                as_of_date DATE NOT NULL,
                source VARCHAR(16) NOT NULL DEFAULT 'live',
                synced_at DATETIME NOT NULL,
                PRIMARY KEY (ym),
                KEY idx_wb_fin_m_synced (synced_at)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);
        try {
            await db.query(
                'ALTER TABLE dg_mp_wb_finance_month ADD COLUMN paid_in_month DECIMAL(18,2) NULL'
            );
        } catch (_) {
            /* exists */
        }
    })();
    return schemaReady;
}

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

function addMonthsYm(ym, delta) {
    const m = String(ym || '').match(/^(\d{4})-(\d{2})$/);
    if (!m) return null;
    const dt = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1 + delta, 1));
    return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}`;
}

function lastDayOfYm(ym) {
    const m = String(ym || '').match(/^(\d{4})-(\d{2})$/);
    if (!m) return null;
    const last = new Date(Date.UTC(Number(m[1]), Number(m[2]), 0)).getUTCDate();
    return `${m[1]}-${m[2]}-${String(last).padStart(2, '0')}`;
}

function currentYmMsk(d) {
    const dt = d instanceof Date ? d : new Date();
    const fmt = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Europe/Moscow',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    });
    const parts = fmt.formatToParts(dt);
    const get = (t) => {
        const p = parts.find((x) => x.type === t);
        return p ? p.value : '';
    };
    return `${get('year')}-${get('month')}`;
}

function isLastCalendarDayOfMonthMsk(d) {
    const dt = d instanceof Date ? d : new Date();
    const fmt = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Europe/Moscow',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    });
    const parts = fmt.formatToParts(dt);
    const get = (t) => {
        const p = parts.find((x) => x.type === t);
        return p ? p.value : '';
    };
    const y = parseInt(get('year'), 10);
    const m = parseInt(get('month'), 10);
    const day = parseInt(get('day'), 10);
    if (!y || !m || !day) return false;
    const last = new Date(y, m, 0).getDate();
    return day === last;
}

/**
 * Снимок месяца: owed_* для карточки; paid_in_month — для графика «WB · выплаты».
 */
async function upsertWbMonthSnapshot(db, summary, paidInMonth) {
    const ym = currentYmMsk();
    if (!/^\d{4}-\d{2}$/.test(ym)) return null;
    const eom = isLastCalendarDayOfMonthMsk();
    const source = eom ? 'eom' : 'live';
    const asOf =
        summary && summary.as_of_date ? String(summary.as_of_date).slice(0, 10) : mskYmd(new Date());
    const onBal = num(summary && summary.on_balance);
    const onWire = num(summary && summary.on_wire);
    const owed = num(summary && summary.owed_total);
    const paid = paidInMonth != null ? num(paidInMonth) : null;
    const [exist] = await db.query(
        `SELECT source FROM dg_mp_wb_finance_month WHERE ym = ? LIMIT 1`,
        [ym]
    );
    if (exist && exist[0] && String(exist[0].source) === 'eom' && source !== 'eom') {
        if (paid != null) {
            await db.query(
                `UPDATE dg_mp_wb_finance_month SET paid_in_month = ?, synced_at = NOW() WHERE ym = ?`,
                [paid, ym]
            );
        }
        return { ym, skipped: true, reason: 'keep_eom', paid_in_month: paid };
    }
    await db.query(
        `INSERT INTO dg_mp_wb_finance_month
            (ym, on_balance, on_wire, owed_total, paid_in_month, as_of_date, source, synced_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NOW())
         ON DUPLICATE KEY UPDATE
            on_balance = VALUES(on_balance),
            on_wire = VALUES(on_wire),
            owed_total = VALUES(owed_total),
            paid_in_month = COALESCE(VALUES(paid_in_month), paid_in_month),
            as_of_date = VALUES(as_of_date),
            source = VALUES(source),
            synced_at = NOW()`,
        [ym, onBal, onWire, owed, paid, asOf, source]
    );
    return { ym, source, owed_total: owed, paid_in_month: paid };
}

async function loadWbOwedByYm(db, monthKeys) {
    await ensureWbFinanceSchema(db);
    const keys = Array.isArray(monthKeys) ? monthKeys.filter((k) => /^\d{4}-\d{2}$/.test(String(k))) : [];
    if (!keys.length) return {};
    const ph = keys.map(() => '?').join(',');
    const [rows] = await db.query(
        `SELECT ym, on_balance, on_wire, owed_total, paid_in_month,
                DATE_FORMAT(as_of_date, '%Y-%m-%d') AS as_of_date, source
         FROM dg_mp_wb_finance_month
         WHERE ym IN (${ph})`,
        keys
    );
    const out = Object.create(null);
    for (const r of rows || []) {
        out[String(r.ym)] = {
            ym: String(r.ym),
            on_balance: num(r.on_balance),
            on_wire: num(r.on_wire),
            owed_total: num(r.owed_total),
            paid_in_month: r.paid_in_month != null ? num(r.paid_in_month) : null,
            as_of_date: r.as_of_date || null,
            source: String(r.source || ''),
        };
    }
    return out;
}

/** Σ bankPaymentSum по месяцу date_to (график «WB · выплаты»). */
async function loadWbPaidByYmFromReports(db, monthKeys) {
    await ensureWbFinanceSchema(db);
    const keys = Array.isArray(monthKeys) ? monthKeys.filter((k) => /^\d{4}-\d{2}$/.test(String(k))) : [];
    let sql = `
        SELECT DATE_FORMAT(date_to, '%Y-%m') AS ym,
               ROUND(SUM(bank_payment_sum), 2) AS paid,
               COUNT(*) AS report_count
        FROM dg_mp_wb_sales_report`;
    const params = [];
    if (keys.length) {
        sql += ` WHERE DATE_FORMAT(date_to, '%Y-%m') IN (${keys.map(() => '?').join(',')})`;
        params.push(...keys);
    }
    sql += ` GROUP BY DATE_FORMAT(date_to, '%Y-%m') ORDER BY ym`;
    const [rows] = await db.query(sql, params);
    const out = Object.create(null);
    (rows || []).forEach((r) => {
        out[String(r.ym)] = {
            ym: String(r.ym),
            paid: num(r.paid),
            report_count: Number(r.report_count) || 0,
        };
    });
    return out;
}

async function fetchAccountBalance(creds) {
    const url = `${WB_FINANCE_BASE}/api/v1/account/balance`;
    const { data, status } = await axios.get(url, {
        headers: wbHeaders(creds),
        timeout: 30000,
        validateStatus: () => true,
    });
    if (status < 200 || status >= 300) {
        const msg = (data && (data.detail || data.title || data.message)) || `WB balance HTTP ${status}`;
        const err = new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
        err.status = status;
        throw err;
    }
    return {
        currency: String((data && data.currency) || 'RUB'),
        current: num(data && data.current),
        for_withdraw: num(data && data.for_withdraw),
    };
}

async function fetchSalesReportsPage(creds, dateFrom, dateTo, limit, offset) {
    const url = `${WB_FINANCE_BASE}/api/finance/v1/sales-reports/list`;
    const { data, status, headers } = await axios.post(
        url,
        {
            dateFrom,
            dateTo,
            period: 'weekly',
            limit: limit || 100,
            offset: offset || 0,
        },
        {
            headers: wbHeaders(creds),
            timeout: 60000,
            validateStatus: () => true,
        }
    );
    if (status === 429) {
        const err = new Error('WB sales-reports 429 rate limit');
        err.status = 429;
        err.retryAfter = headers && (headers['x-ratelimit-retry'] || headers['X-Ratelimit-Retry']);
        throw err;
    }
    if (status < 200 || status >= 300) {
        const msg =
            (data && (data.detail || data.title || data.message)) || `WB sales-reports HTTP ${status}`;
        const err = new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
        err.status = status;
        throw err;
    }
    return Array.isArray(data) ? data : [];
}

/** Одна страница (back-compat). */
async function fetchSalesReportsList(creds, dateFrom, dateTo) {
    return fetchSalesReportsPage(creds, dateFrom, dateTo, 200, 0);
}

/**
 * Все страницы sales-reports с паузой на 429.
 * @param {(info:object)=>void} [onProgress]
 */
async function fetchAllSalesReports(creds, dateFrom, dateTo, onProgress) {
    const limit = 100;
    const all = [];
    let offset = 0;
    for (let page = 0; page < 80; page++) {
        let rows = null;
        for (let attempt = 0; attempt < 6; attempt++) {
            try {
                rows = await fetchSalesReportsPage(creds, dateFrom, dateTo, limit, offset);
                break;
            } catch (e) {
                if (e && e.status === 429) {
                    const wait = 65000;
                    if (typeof onProgress === 'function') {
                        onProgress({ phase: 'rate_limit', offset, attempt: attempt + 1, wait_ms: wait });
                    }
                    await sleep(wait);
                    continue;
                }
                throw e;
            }
        }
        if (!rows) throw new Error('WB sales-reports: исчерпаны попытки после 429');
        if (typeof onProgress === 'function') {
            onProgress({ phase: 'page', offset, got: rows.length, total: all.length + rows.length });
        }
        if (!rows.length) break;
        all.push(...rows);
        if (rows.length < limit) break;
        offset += limit;
        await sleep(1200);
    }
    return all;
}

async function upsertBalanceSnapshot(db, bal) {
    const asOf = mskYmd(new Date());
    await db.query(
        `INSERT INTO dg_mp_wb_finance_balance
            (as_of_date, currency, current_amount, for_withdraw, synced_at)
         VALUES (?, ?, ?, ?, NOW())
         ON DUPLICATE KEY UPDATE
            currency = VALUES(currency),
            current_amount = VALUES(current_amount),
            for_withdraw = VALUES(for_withdraw),
            synced_at = NOW()`,
        [asOf, bal.currency || 'RUB', bal.current, bal.for_withdraw]
    );
    return asOf;
}

async function loadPreviousBalanceRow(db, excludeDate) {
    const [rows] = await db.query(
        `SELECT as_of_date, current_amount, for_withdraw, synced_at
         FROM dg_mp_wb_finance_balance
         WHERE as_of_date <> ?
         ORDER BY as_of_date DESC, synced_at DESC
         LIMIT 1`,
        [excludeDate || mskYmd(new Date())]
    );
    return rows && rows[0] ? rows[0] : null;
}

async function upsertSalesReports(db, reports) {
    let n = 0;
    for (const r of reports || []) {
        const reportId = Number(r.reportId || r.report_id);
        if (!Number.isFinite(reportId) || reportId <= 0) continue;
        const dateFrom = String(r.dateFrom || r.date_from || '').slice(0, 10);
        const dateTo = String(r.dateTo || r.date_to || '').slice(0, 10);
        if (!dateFrom || !dateTo) continue;
        await db.query(
            `INSERT INTO dg_mp_wb_sales_report
                (report_id, date_from, date_to, report_type, for_pay_sum, bank_payment_sum,
                 retail_amount_sum, create_date, payload_json, synced_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, CAST(? AS JSON), NOW())
             ON DUPLICATE KEY UPDATE
                date_from = VALUES(date_from),
                date_to = VALUES(date_to),
                report_type = VALUES(report_type),
                for_pay_sum = VALUES(for_pay_sum),
                bank_payment_sum = VALUES(bank_payment_sum),
                retail_amount_sum = VALUES(retail_amount_sum),
                create_date = VALUES(create_date),
                payload_json = VALUES(payload_json),
                synced_at = NOW()`,
            [
                reportId,
                dateFrom,
                dateTo,
                Number(r.reportType || r.report_type) || 0,
                num(r.forPaySum),
                num(r.bankPaymentSum),
                num(r.retailAmountSum),
                r.createDate || r.create_date || null,
                JSON.stringify(r),
            ]
        );
        n += 1;
    }
    return n;
}

/** Недельные суммы bankPaymentSum (сумма по reportType за период). */
async function loadWeeklyBankPaymentSums(db, lookbackDays) {
    const days = Math.max(14, Number(lookbackDays) || SAFETY_NET_LOOKBACK_DAYS);
    const [rows] = await db.query(
        `SELECT date_from, date_to,
                SUM(bank_payment_sum) AS bank_sum,
                SUM(for_pay_sum) AS for_pay_sum
         FROM dg_mp_wb_sales_report
         WHERE date_to >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
         GROUP BY date_from, date_to
         HAVING ABS(SUM(bank_payment_sum)) > 0.01
         ORDER BY date_from ASC`,
        [days]
    );
    return (rows || []).map((r) => ({
        date_from: ymd(r.date_from),
        date_to: ymd(r.date_to),
        bank_sum: num(r.bank_sum),
        for_pay_sum: num(r.for_pay_sum),
    }));
}

async function loadOpenInflight(db) {
    const [rows] = await db.query(
        `SELECT id, amount, status, source, opened_at, period_from, period_to, note
         FROM dg_mp_wb_payout_inflight
         WHERE status = 'open'
         ORDER BY opened_at ASC, id ASC`
    );
    return rows || [];
}

async function hasOpenAmount(db, amount) {
    const [rows] = await db.query(
        `SELECT id FROM dg_mp_wb_payout_inflight
         WHERE status = 'open' AND ABS(amount - ?) <= ?
         LIMIT 1`,
        [num(amount), AMOUNT_EPS]
    );
    return !!(rows && rows[0]);
}

async function insertInflight(db, row) {
    const amount = num(row.amount);
    if (amount <= AMOUNT_EPS) return null;
    if (await hasOpenAmount(db, amount)) return null;
    const [res] = await db.query(
        `INSERT INTO dg_mp_wb_payout_inflight
            (amount, status, source, opened_at, period_from, period_to, note, synced_at)
         VALUES (?, 'open', ?, COALESCE(?, NOW()), ?, ?, ?, NOW())`,
        [
            amount,
            String(row.source || 'withdraw_delta').slice(0, 32),
            row.opened_at || null,
            row.period_from || null,
            row.period_to || null,
            row.note ? String(row.note).slice(0, 255) : null,
        ]
    );
    return res && res.insertId ? res.insertId : null;
}

/**
 * Входящие РВБ (Wildberries) из выписки — для закрытия inflight.
 */
async function loadRvbIncomingAmounts(db, lookbackDays) {
    const days = Math.max(30, Number(lookbackDays) || 120);
    try {
        const [rows] = await db.query(
            `SELECT tx_id, amount, booked_date, purpose, counterparty
             FROM dg_finance_tx
             WHERE amount > 0
               AND (
                 direction IN ('in', 'credit', 'IN', 'CREDIT')
                 OR direction IS NULL
                 OR direction = ''
               )
               AND booked_date >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
               AND (
                 counterparty LIKE '%РВБ%'
                 OR counterparty LIKE '%Wildberries%'
                 OR counterparty LIKE '%WILDBERRIES%'
                 OR purpose LIKE '%РВБ%'
                 OR purpose LIKE '%Wildberries%'
               )
             ORDER BY booked_date DESC`,
            [days]
        );
        return rows || [];
    } catch (e) {
        const [rows] = await db.query(
            `SELECT tx_id, amount, booked_date, purpose, counterparty
             FROM dg_finance_tx
             WHERE amount > 0
               AND booked_date >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
               AND (
                 counterparty LIKE '%РВБ%'
                 OR counterparty LIKE '%Wildberries%'
                 OR purpose LIKE '%РВБ%'
               )
             ORDER BY booked_date DESC`,
            [days]
        );
        return rows || [];
    }
}

async function settleInflightAgainstBank(db) {
    const open = await loadOpenInflight(db);
    if (!open.length) return { settled: 0 };
    const bank = await loadRvbIncomingAmounts(db, 150);
    let settled = 0;
    const usedTx = new Set();
    for (const inf of open) {
        const hit = bank.find(
            (b) => !usedTx.has(String(b.tx_id)) && amountsClose(Math.abs(num(b.amount)), inf.amount)
        );
        if (!hit) continue;
        usedTx.add(String(hit.tx_id));
        await db.query(
            `UPDATE dg_mp_wb_payout_inflight
             SET status = 'settled', settled_tx_id = ?, settled_at = NOW(), synced_at = NOW()
             WHERE id = ? AND status = 'open'`,
            [String(hit.tx_id).slice(0, 128), inf.id]
        );
        settled += 1;
    }
    return { settled };
}

/**
 * Детектор вывода: for_withdraw был > 0, стал ≈ 0, current упал.
 */
async function detectWithdrawDelta(db, prev, bal) {
    if (!prev) return null;
    const prevFw = num(prev.for_withdraw);
    const prevCur = num(prev.current_amount);
    const curFw = num(bal.for_withdraw);
    const curCur = num(bal.current);
    if (prevFw < 500) return null;
    if (curFw > AMOUNT_EPS && curFw >= prevFw * 0.5) return null;
    const drop = prevCur - curCur;
    // сумма вывода ≈ прежний for_withdraw или падение current
    let amount = 0;
    if (Math.abs(drop - prevFw) <= Math.max(50, prevFw * 0.05)) {
        amount = prevFw;
    } else if (drop > 500 && drop <= prevFw * 1.05) {
        amount = drop;
    } else if (prevFw > 500 && curFw <= AMOUNT_EPS) {
        amount = prevFw;
    }
    if (amount < 500) return null;
    const id = await insertInflight(db, {
        amount,
        source: 'withdraw_delta',
        note: `delta fw ${prevFw}→${curFw}, current ${prevCur}→${curCur}`,
    });
    return id ? { amount, id } : null;
}

/**
 * Safety-net: недельные bankPaymentSum (и склейки коротких соседних недель),
 * которых нет во входящих РВБ и ещё нет в open inflight → открыть.
 * Покрывает пропуск синка в момент клика «Вывести».
 */
async function safetyNetOpenFromReports(db) {
    const weeks = await loadWeeklyBankPaymentSums(db, SAFETY_NET_LOOKBACK_DAYS);
    const bank = await loadRvbIncomingAmounts(db, 150);
    const bankAmounts = bank.map((b) => Math.abs(num(b.amount)));
    const open = await loadOpenInflight(db);
    const openAmounts = open.map((o) => num(o.amount));
    const settledish = (amt) =>
        bankAmounts.some((b) => amountsClose(b, amt)) || openAmounts.some((o) => amountsClose(o, amt));

    // Недели с date_to новее (сегодня − 14 дн.) ещё могут сидеть в current — не открываем
    // как «на проводке», иначе двойной учёт с балансом кабинета.
    const cutoff = new Date();
    cutoff.setUTCDate(cutoff.getUTCDate() - 14);
    const cutoffYmd = ymd(cutoff);
    const weekEligible = (w) => String(w.date_to || '') <= cutoffYmd;

    const daySpan = (w) =>
        (new Date(w.date_to + 'T00:00:00Z') - new Date(w.date_from + 'T00:00:00Z')) / 86400000 + 1;

    // Кандидаты: склейка коротких соседних недель → иначе одиночная (без суток-обрезков span=1).
    const candidates = [];
    const used = new Set();
    for (let i = 0; i < weeks.length - 1; i++) {
        const a = weeks[i];
        const b = weeks[i + 1];
        if (daySpan(a) > 5 || daySpan(b) > 5) continue;
        const next = new Date(a.date_to + 'T00:00:00Z');
        next.setUTCDate(next.getUTCDate() + 1);
        if (ymd(next) !== b.date_from) continue;
        if (!weekEligible(b)) continue;
        candidates.push({
            amount: num(a.bank_sum) + num(b.bank_sum),
            date_from: a.date_from,
            date_to: b.date_to,
            source: 'bank_payment_glue',
            note: `glue ${a.date_from}..${a.date_to}+${b.date_from}..${b.date_to}`,
            idx: [i, i + 1],
        });
        used.add(i);
        used.add(i + 1);
    }
    for (let i = 0; i < weeks.length; i++) {
        if (used.has(i)) continue;
        const w = weeks[i];
        if (!weekEligible(w)) continue;
        if (daySpan(w) <= 1) continue;
        candidates.push({
            amount: w.bank_sum,
            date_from: w.date_from,
            date_to: w.date_to,
            source: 'bank_payment_sum',
            note: `week ${w.date_from}..${w.date_to}`,
            idx: [i],
        });
    }

    // Свежие → старые: открываем только «хвост» до первой уже зачисленной в Точку недели.
    candidates.sort((a, b) => String(b.date_to).localeCompare(String(a.date_to)));
    const opened = [];
    let seenSettled = false;
    for (const c of candidates) {
        if (settledish(c.amount)) {
            seenSettled = true;
            continue;
        }
        if (seenSettled) continue;
        const id = await insertInflight(db, {
            amount: c.amount,
            source: c.source,
            period_from: c.date_from,
            period_to: c.date_to,
            note: c.note,
        });
        if (id) {
            opened.push({ id, amount: c.amount, from: c.date_from, to: c.date_to });
            openAmounts.push(c.amount);
        }
    }

    return { opened: opened.length, items: opened };
}

async function runWbFinanceSync(db, appSettings, opts) {
    const o = opts || {};
    await ensureWbFinanceSchema(db);
    const creds = wbCreds(appSettings);
    if (!creds.apiKey) {
        return {
            success: false,
            error: 'Не задан wb_api_key',
            sync_script: getWbFinanceSyncMeta(),
        };
    }

    const errors = [];
    let bal = null;
    try {
        bal = await fetchAccountBalance(creds);
    } catch (e) {
        return {
            success: false,
            error: e && e.message ? String(e.message) : String(e),
            sync_script: getWbFinanceSyncMeta(),
        };
    }

    const asOf = await upsertBalanceSnapshot(db, bal);
    const prev = await loadPreviousBalanceRow(db, asOf);
    let withdraw = null;
    try {
        withdraw = await detectWithdrawDelta(db, prev, bal);
    } catch (e) {
        errors.push({ step: 'withdraw_delta', error: e.message || String(e) });
    }

    let reportsUpserted = 0;
    try {
        const to = mskYmd(new Date());
        const fromDt = new Date();
        fromDt.setUTCDate(fromDt.getUTCDate() - (Number(o.reportDays) || 120));
        const from = ymd(fromDt);
        const reports = await fetchAllSalesReports(creds, from, to);
        reportsUpserted = await upsertSalesReports(db, reports);
    } catch (e) {
        errors.push({ step: 'sales_reports', error: e.message || String(e) });
    }

    let safety = { opened: 0, items: [] };
    try {
        safety = await safetyNetOpenFromReports(db);
    } catch (e) {
        errors.push({ step: 'safety_net', error: e.message || String(e) });
    }

    let settle = { settled: 0 };
    try {
        settle = await settleInflightAgainstBank(db);
    } catch (e) {
        errors.push({ step: 'settle', error: e.message || String(e) });
    }

    const summary = await loadWbFinanceForFinance(db);
    let monthSnap = null;
    try {
        const curYm = currentYmMsk();
        const paidMap = await loadWbPaidByYmFromReports(db, [curYm]);
        const paidMtd = paidMap[curYm] ? paidMap[curYm].paid : 0;
        monthSnap = await upsertWbMonthSnapshot(db, summary, paidMtd);
    } catch (e) {
        errors.push({ step: 'month_snapshot', error: e.message || String(e) });
    }
    return {
        success: errors.length === 0,
        balance: bal,
        as_of_date: asOf,
        withdraw_opened: withdraw,
        reports_upserted: reportsUpserted,
        safety_net: safety,
        settled: settle.settled,
        month_snapshot: monthSnap,
        owed_total: summary.owed_total,
        on_balance: summary.on_balance,
        on_wire: summary.on_wire,
        errors: errors.slice(0, 20),
        sync_script: getWbFinanceSyncMeta(),
        message:
            errors.length === 0
                ? `WB: баланс ${bal.current}, на проводке ${summary.on_wire}, итого ${summary.owed_total}`
                : `WB sync с ошибками (${errors.length}): баланс ${bal.current}`,
    };
}

async function loadWbFinanceForFinance(db) {
    await ensureWbFinanceSchema(db);
    const [balRows] = await db.query(
        `SELECT as_of_date, currency, current_amount, for_withdraw, synced_at
         FROM dg_mp_wb_finance_balance
         ORDER BY as_of_date DESC, synced_at DESC
         LIMIT 1`
    );
    const bal = balRows && balRows[0] ? balRows[0] : null;
    const open = await loadOpenInflight(db);
    const on_balance = bal ? num(bal.current_amount) : 0;
    const for_withdraw = bal ? num(bal.for_withdraw) : 0;
    const on_wire = open.reduce((s, r) => s + num(r.amount), 0);
    return {
        on_balance,
        for_withdraw,
        on_wire,
        owed_total: on_balance + on_wire,
        currency: bal ? String(bal.currency || 'RUB') : 'RUB',
        as_of_date: bal ? ymd(bal.as_of_date) : null,
        synced_at: bal ? bal.synced_at : null,
        inflight: open.map((r) => ({
            id: r.id,
            amount: num(r.amount),
            source: r.source,
            opened_at: r.opened_at,
            period_from: r.period_from ? ymd(r.period_from) : null,
            period_to: r.period_to ? ymd(r.period_to) : null,
            note: r.note || null,
        })),
        sync_script: getWbFinanceSyncMeta(),
        source: bal ? 'balance+inflight' : 'empty',
    };
}

/**
 * Бэкап точек графика: Σ bankPaymentSum по месяцу date_to из sales-reports.
 * opts: { fromYm, toYm, force, onProgress }
 */
async function backfillWbFinanceMonths(db, appSettings, opts) {
    const o = opts || {};
    await ensureWbFinanceSchema(db);
    const creds = wbCreds(appSettings);
    const meta = getWbFinanceSyncMeta();
    if (!creds.apiKey) {
        return { success: false, error: 'Не задан wb_api_key', sync_script: meta };
    }

    const curYm = currentYmMsk();
    let fromYm = String(o.fromYm || o.from_ym || '').trim();
    let toYm = String(o.toYm || o.to_ym || '').trim();
    if (!/^\d{4}-\d{2}$/.test(fromYm)) fromYm = addMonthsYm(curYm, -18);
    if (!/^\d{4}-\d{2}$/.test(toYm)) toYm = curYm;
    if (toYm > curYm) toYm = curYm;
    if (!fromYm || !toYm || fromYm > toYm) {
        return { success: false, error: 'Пустой диапазон месяцев', sync_script: meta };
    }

    const dateFrom = `${fromYm}-01`;
    const dateTo = mskYmd(new Date());
    const t0 = Date.now();
    let reports;
    try {
        reports = await fetchAllSalesReports(creds, dateFrom, dateTo, o.onProgress);
    } catch (e) {
        return {
            success: false,
            error: e && e.message ? String(e.message) : String(e),
            sync_script: meta,
            rate_limited: e && e.status === 429,
        };
    }
    const upserted = await upsertSalesReports(db, reports);
    const paidMap = await loadWbPaidByYmFromReports(db, null);
    const force = !!o.force;
    const months = [];
    let ym = fromYm;
    while (ym && ym <= toYm) {
        const block = paidMap[ym];
        const paid = block ? num(block.paid) : 0;
        if (Math.abs(paid) < 0.005) {
            if (force) {
                await db.query(
                    `UPDATE dg_mp_wb_finance_month SET paid_in_month = NULL WHERE ym = ?`,
                    [ym]
                );
            }
            months.push({ ym, paid: 0, reports: 0, skipped: true, reason: 'zero_skip' });
            ym = addMonthsYm(ym, 1);
            continue;
        }
        const [exist] = await db.query(
            `SELECT ym, on_balance, on_wire, owed_total, source FROM dg_mp_wb_finance_month WHERE ym = ? LIMIT 1`,
            [ym]
        );
        const row = exist && exist[0] ? exist[0] : null;
        const source = ym === curYm ? String((row && row.source) || 'live') : 'backfill';
        await db.query(
            `INSERT INTO dg_mp_wb_finance_month
                (ym, on_balance, on_wire, owed_total, paid_in_month, as_of_date, source, synced_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, NOW())
             ON DUPLICATE KEY UPDATE
                paid_in_month = VALUES(paid_in_month),
                synced_at = NOW(),
                source = IF(source = 'eom', source, VALUES(source))`,
            [
                ym,
                row ? num(row.on_balance) : 0,
                row ? num(row.on_wire) : 0,
                row ? num(row.owed_total) : 0,
                paid,
                ym === curYm ? mskYmd(new Date()) : lastDayOfYm(ym),
                source,
            ]
        );
        months.push({
            ym,
            paid,
            reports: block ? block.report_count : 0,
            skipped: false,
        });
        ym = addMonthsYm(ym, 1);
    }

    return {
        success: true,
        message: `WB backfill выплат ${fromYm}…${toYm}: ${months.filter((m) => !m.skipped).length} мес., отчётов ${upserted}`,
        from_ym: fromYm,
        to_ym: toYm,
        months,
        reports_upserted: upserted,
        sync_script: meta,
        duration_sec: Math.round((Date.now() - t0) / 1000),
    };
}

module.exports = {
    ensureWbFinanceSchema,
    runWbFinanceSync,
    backfillWbFinanceMonths,
    loadWbFinanceForFinance,
    loadWbOwedByYm,
    loadWbPaidByYmFromReports,
    upsertWbMonthSnapshot,
    currentYmMsk,
    getWbFinanceSyncMeta,
};
