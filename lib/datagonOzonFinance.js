'use strict';

/**
 * Финансы Ozon для /finance.html:
 * POST /v1/finance/cash-flow-statement/list → dg_mp_ozon_cashflow_period.
 * KPI «Ozon должен» = end_balance самой свежей недели.
 */

const axios = require('axios');
const { getOzonFinanceSyncMeta } = require('./datagonOzonFinanceSyncRevision');

const OZON_BASE = 'https://api-seller.ozon.ru';
const DEFAULT_BACKFILL_MONTHS = 18;
const DAILY_TAIL_DAYS = 90;

let schemaReady = null;

function num(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
}

function ymd(d) {
    if (d == null) return '';
    if (typeof d === 'string') {
        const m = d.match(/^(\d{4}-\d{2}-\d{2})/);
        if (m) return m[1];
    }
    const dt = d instanceof Date ? d : new Date(d);
    if (Number.isNaN(dt.getTime())) return '';
    // DATE из MySQL часто приходит как Date в локальной/UTC зоне — берём календарный UTC-день ISO.
    const iso = dt.toISOString();
    return iso.slice(0, 10);
}

function addMonthsUtc(d, months) {
    const dt = new Date(d.getTime());
    dt.setUTCMonth(dt.getUTCMonth() + months);
    return dt;
}

function addDaysUtc(d, days) {
    const dt = new Date(d.getTime());
    dt.setUTCDate(dt.getUTCDate() + days);
    return dt;
}

function ozonCreds(appSettings) {
    const s = appSettings || {};
    return {
        clientId: String(s.ozon_client_id || '').trim(),
        apiKey: String(s.ozon_api_key || '').trim(),
    };
}

function ozonHeaders(creds) {
    return {
        'Client-Id': creds.clientId,
        'Api-Key': creds.apiKey,
        'Content-Type': 'application/json',
    };
}

async function ensureOzonFinanceSchema(db) {
    if (schemaReady) return schemaReady;
    schemaReady = (async () => {
        await db.query(`
            CREATE TABLE IF NOT EXISTS dg_mp_ozon_cashflow_period (
                period_begin DATE NOT NULL,
                period_end DATE NOT NULL,
                begin_balance DECIMAL(18,2) NOT NULL DEFAULT 0,
                end_balance DECIMAL(18,2) NOT NULL DEFAULT 0,
                payment DECIMAL(18,2) NOT NULL DEFAULT 0,
                invoice_transfer DECIMAL(18,2) NOT NULL DEFAULT 0,
                details_json JSON NULL,
                sync_script VARCHAR(32) NULL,
                synced_at DATETIME NOT NULL,
                PRIMARY KEY (period_begin, period_end),
                KEY idx_ozon_cf_end (period_end),
                KEY idx_ozon_cf_synced (synced_at)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);
    })();
    return schemaReady;
}

/**
 * Разбивает [from, to] на куски ≤ ~28 дней (лимит Ozon balance/cash-flow).
 */
function chunkDateRanges(fromDate, toDate, maxDays) {
    const max = Math.max(7, Number(maxDays) || 28);
    const chunks = [];
    let cur = new Date(fromDate.getTime());
    const end = new Date(toDate.getTime());
    while (cur <= end) {
        const chunkEnd = addDaysUtc(cur, max - 1);
        const to = chunkEnd > end ? end : chunkEnd;
        chunks.push({ from: new Date(cur.getTime()), to: new Date(to.getTime()) });
        cur = addDaysUtc(to, 1);
    }
    return chunks;
}

function extractPeriods(payload) {
    const root = payload && payload.result ? payload.result : payload;
    if (!root || typeof root !== 'object') return [];
    // Балансы begin/end и invoice_transfer — в result.details (не в cash_flows).
    if (Array.isArray(root.details) && root.details.length) return root.details;
    const list =
        root.cash_flows ||
        root.cashFlows ||
        root.cash_flow_statements ||
        (Array.isArray(root) ? root : null);
    if (Array.isArray(list)) return list;
    if (Array.isArray(root.periods)) return root.periods;
    return [];
}

function normalizePeriod(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const beginRaw =
        raw.period && (raw.period.begin || raw.period.from)
            ? raw.period.begin || raw.period.from
            : raw.begin || raw.date_from || raw.from || raw.period_begin;
    const endRaw =
        raw.period && (raw.period.end || raw.period.to)
            ? raw.period.end || raw.period.to
            : raw.end || raw.date_to || raw.to || raw.period_end;
    const period_begin = String(beginRaw || '').slice(0, 10);
    const period_end = String(endRaw || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(period_begin) || !/^\d{4}-\d{2}-\d{2}$/.test(period_end)) {
        return null;
    }
    let payment = 0;
    if (Array.isArray(raw.payments)) {
        payment = raw.payments.reduce((s, p) => s + num(p && p.payment), 0);
    } else if (raw.payments && typeof raw.payments === 'object') {
        payment = num(raw.payments.payment);
    } else if (raw.payment != null) {
        payment = num(raw.payment);
    }
    const invoice_transfer = num(
        raw.invoice_transfer != null
            ? raw.invoice_transfer
            : raw.invoiceTransfer != null
              ? raw.invoiceTransfer
              : 0
    );
    const begin_balance = num(
        raw.begin_balance_amount != null
            ? raw.begin_balance_amount
            : raw.begin_balance != null
              ? raw.begin_balance
              : raw.beginBalance
    );
    const end_balance = num(
        raw.end_balance_amount != null
            ? raw.end_balance_amount
            : raw.end_balance != null
              ? raw.end_balance
              : raw.endBalance
    );
    return {
        period_begin,
        period_end,
        begin_balance,
        end_balance,
        payment,
        invoice_transfer,
        details_json: raw,
    };
}

async function fetchCashFlowChunk(creds, fromDate, toDate) {
    const body = {
        date: {
            from: fromDate.toISOString(),
            to: toDate.toISOString(),
        },
        with_details: true,
        page: 1,
        page_size: 100,
    };
    const url = `${OZON_BASE}/v1/finance/cash-flow-statement/list`;
    const { data, status } = await axios.post(url, body, {
        headers: ozonHeaders(creds),
        timeout: 60000,
        validateStatus: () => true,
    });
    if (status < 200 || status >= 300) {
        const msg =
            (data && (data.message || data.error || data.detail)) ||
            `Ozon cash-flow HTTP ${status}`;
        const err = new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
        err.status = status;
        throw err;
    }
    return extractPeriods(data).map(normalizePeriod).filter(Boolean);
}

async function upsertPeriods(db, periods) {
    const meta = getOzonFinanceSyncMeta();
    let n = 0;
    for (const p of periods) {
        await db.query(
            `INSERT INTO dg_mp_ozon_cashflow_period
                (period_begin, period_end, begin_balance, end_balance, payment, invoice_transfer,
                 details_json, sync_script, synced_at)
             VALUES (?, ?, ?, ?, ?, ?, CAST(? AS JSON), ?, NOW())
             ON DUPLICATE KEY UPDATE
                begin_balance = VALUES(begin_balance),
                end_balance = VALUES(end_balance),
                payment = VALUES(payment),
                invoice_transfer = VALUES(invoice_transfer),
                details_json = VALUES(details_json),
                sync_script = VALUES(sync_script),
                synced_at = NOW()`,
            [
                p.period_begin,
                p.period_end,
                p.begin_balance,
                p.end_balance,
                p.payment,
                p.invoice_transfer,
                JSON.stringify(p.details_json || {}),
                meta.version,
            ]
        );
        n += 1;
    }
    return n;
}

/**
 * @param {object} opts
 * @param {number} [opts.backfillMonths] — полный бэкап N месяцев (первый прогон)
 * @param {boolean} [opts.tailOnly] — только хвост DAILY_TAIL_DAYS
 */
async function runOzonFinanceSync(db, appSettings, opts) {
    const o = opts || {};
    await ensureOzonFinanceSchema(db);
    const creds = ozonCreds(appSettings);
    if (!creds.clientId || !creds.apiKey) {
        return {
            success: false,
            error: 'Не заданы ozon_client_id / ozon_api_key',
            sync_script: getOzonFinanceSyncMeta(),
        };
    }

    const [cntRows] = await db.query('SELECT COUNT(*) AS c FROM dg_mp_ozon_cashflow_period');
    const haveRows = Number(cntRows && cntRows[0] && cntRows[0].c) > 0;
    const backfillMonths = Math.max(
        1,
        Math.min(24, Number(o.backfillMonths) || DEFAULT_BACKFILL_MONTHS)
    );
    const now = new Date();
    let fromDate;
    let toDate = now;
    if (o.tailOnly || (haveRows && o.backfillMonths == null)) {
        fromDate = addDaysUtc(now, -DAILY_TAIL_DAYS);
    } else {
        fromDate = addMonthsUtc(now, -backfillMonths);
    }

    const chunks = chunkDateRanges(fromDate, toDate, 28);
    const all = [];
    const errors = [];
    for (const ch of chunks) {
        try {
            const periods = await fetchCashFlowChunk(creds, ch.from, ch.to);
            all.push(...periods);
            await new Promise((r) => setTimeout(r, 350));
        } catch (e) {
            errors.push({
                from: ymd(ch.from),
                to: ymd(ch.to),
                error: e && e.message ? String(e.message) : String(e),
            });
        }
    }

    // дедуп по begin+end
    const map = new Map();
    for (const p of all) {
        map.set(`${p.period_begin}|${p.period_end}`, p);
    }
    const unique = Array.from(map.values());
    const upserted = await upsertPeriods(db, unique);
    const latest = await loadLatestPeriod(db);

    return {
        success: errors.length === 0,
        upserted,
        periods_fetched: unique.length,
        from: ymd(fromDate),
        to: ymd(toDate),
        chunks: chunks.length,
        errors: errors.slice(0, 20),
        latest,
        sync_script: getOzonFinanceSyncMeta(),
        message:
            errors.length === 0
                ? `Ozon cash-flow: ${upserted} период(ов), end_balance=${latest ? latest.end_balance : '—'}`
                : `Ozon cash-flow: ${upserted} ок, ошибок ${errors.length}`,
    };
}

async function loadLatestPeriod(db) {
    await ensureOzonFinanceSchema(db);
    const [rows] = await db.query(
        `SELECT DATE_FORMAT(period_begin, '%Y-%m-%d') AS period_begin,
                DATE_FORMAT(period_end, '%Y-%m-%d') AS period_end,
                begin_balance, end_balance, payment, invoice_transfer, synced_at
         FROM dg_mp_ozon_cashflow_period
         ORDER BY period_end DESC, period_begin DESC
         LIMIT 1`
    );
    if (!rows || !rows[0]) return null;
    const r = rows[0];
    return {
        period_begin: String(r.period_begin || '').slice(0, 10),
        period_end: String(r.period_end || '').slice(0, 10),
        begin_balance: num(r.begin_balance),
        end_balance: num(r.end_balance),
        payment: num(r.payment),
        invoice_transfer: num(r.invoice_transfer),
        synced_at: r.synced_at || null,
    };
}

async function loadOzonFinanceForFinance(db) {
    await ensureOzonFinanceSchema(db);
    const latest = await loadLatestPeriod(db);
    const [recent] = await db.query(
        `SELECT DATE_FORMAT(period_begin, '%Y-%m-%d') AS period_begin,
                DATE_FORMAT(period_end, '%Y-%m-%d') AS period_end,
                begin_balance, end_balance, payment, invoice_transfer
         FROM dg_mp_ozon_cashflow_period
         ORDER BY period_end DESC, period_begin DESC
         LIMIT 12`
    );
    return {
        owed: latest ? num(latest.end_balance) : 0,
        begin_balance: latest ? num(latest.begin_balance) : 0,
        period_begin: latest ? latest.period_begin : null,
        period_end: latest ? latest.period_end : null,
        synced_at: latest ? latest.synced_at : null,
        recent_periods: (recent || []).map((r) => ({
            period_begin: String(r.period_begin || '').slice(0, 10),
            period_end: String(r.period_end || '').slice(0, 10),
            begin_balance: num(r.begin_balance),
            end_balance: num(r.end_balance),
            payment: num(r.payment),
            invoice_transfer: num(r.invoice_transfer),
        })),
        sync_script: getOzonFinanceSyncMeta(),
        source: latest ? 'cashflow' : 'empty',
    };
}

/**
 * end_balance последней недели, попавшей в месяц (для точки графика на «конец месяца»).
 * @returns {Object.<string, {ym, period_end, end_balance}>}
 */
async function loadOzonBalanceByYm(db, monthKeys) {
    await ensureOzonFinanceSchema(db);
    const keys = Array.isArray(monthKeys) ? monthKeys.filter((k) => /^\d{4}-\d{2}$/.test(String(k))) : null;
    let rows;
    if (keys && keys.length) {
        const ph = keys.map(() => '?').join(',');
        [rows] = await db.query(
            `SELECT DATE_FORMAT(period_end, '%Y-%m') AS ym,
                    DATE_FORMAT(period_end, '%Y-%m-%d') AS period_end,
                    end_balance
             FROM dg_mp_ozon_cashflow_period
             WHERE DATE_FORMAT(period_end, '%Y-%m') IN (${ph})
             ORDER BY period_end ASC`,
            keys
        );
    } else {
        [rows] = await db.query(
            `SELECT DATE_FORMAT(period_end, '%Y-%m') AS ym,
                    DATE_FORMAT(period_end, '%Y-%m-%d') AS period_end,
                    end_balance
             FROM dg_mp_ozon_cashflow_period
             ORDER BY period_end ASC`
        );
    }
    const byYm = Object.create(null);
    for (const r of rows || []) {
        const ymKey = String(r.ym || '').slice(0, 7);
        if (!ymKey) continue;
        // Последняя по period_end в месяце перезаписывает предыдущие.
        byYm[ymKey] = {
            ym: ymKey,
            period_end: String(r.period_end || '').slice(0, 10),
            end_balance: num(r.end_balance),
        };
    }
    return byYm;
}

module.exports = {
    ensureOzonFinanceSchema,
    runOzonFinanceSync,
    loadOzonFinanceForFinance,
    loadLatestPeriod,
    loadOzonBalanceByYm,
    getOzonFinanceSyncMeta,
};
