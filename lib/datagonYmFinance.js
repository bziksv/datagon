'use strict';

/**
 * Финансы Яндекс Маркета для /finance.html:
 * POST /v2/reports/united-netting/generate → отчёт по платежам.
 *
 * KPI «Я.М · к выплате» ≈ сумма «Предстоящие выплаты» / рублёвая часть
 * «Баланса на сегодня» в кабинете Маркета.
 *
 * Алгоритм (rev.2+):
 * — transactionSum уже со знаком (списания отрицательные);
 * — период владения строкой = max(неделя доставки, неделя транзакции);
 * — live KPI (карточка): «Будет переведён/удержан» по закрытым неделям;
 * — график / dg_mp_ym_finance_month: Σ bankSum по дате выплаты в месяце
 *   (как столбец «Дата выплаты» в кабинете) — не «хвост долга» на EOM.
 */

const axios = require('axios');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);
const { getYmFinanceSyncMeta } = require('./datagonYmFinanceSyncRevision');

const YM_BASE = 'https://api.partner.market.yandex.ru';
const LOOKBACK_DAYS = 90;
const POLL_MS = 2500;
const POLL_MAX = 48;
const UPCOMING_STATUS = 'Будет переведён по графику выплат';
const HOLD_FUTURE_STATUS = 'Будет удержан из платежей покупателей';
const PAID_STATUSES = new Set([
    'Переведён по графику выплат',
    'Удержан из платежей покупателей',
]);
/** Макс. окно одного отчёта united-netting (дней). */
const REPORT_WINDOW_DAYS = 90;
const RATE_LIMIT_WAIT_MS = 125000;

let schemaReady = null;

function num(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
}

function ymd(d) {
    const dt = d instanceof Date ? d : new Date(d);
    if (Number.isNaN(dt.getTime())) return '';
    return dt.toISOString().slice(0, 10);
}

function mskYmd(d) {
    const dt = d instanceof Date ? d : new Date();
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Europe/Moscow',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).format(dt);
}

function currentYmMsk() {
    return mskYmd(new Date()).slice(0, 7);
}

function ymCreds(appSettings) {
    const s = appSettings || {};
    return {
        apiKey: String(s.ym_api_key || '').trim(),
        campaignId: String(s.ym_campaign_id || '').trim(),
        businessId: String(s.ym_business_id || '').trim(),
    };
}

function ymHeaders(creds) {
    return {
        'Api-Key': creds.apiKey,
        Accept: 'application/json',
        'Content-Type': 'application/json',
    };
}

/** Parse "DD.MM.YYYY …" from united-netting. */
function parseRuDate(s) {
    const m = String(s || '').match(/^(\d{2})\.(\d{2})\.(\d{4})/);
    if (!m) return null;
    return { d: +m[1], m: +m[2], y: +m[3] };
}

function ruDateToIso(s) {
    const p = parseRuDate(s);
    if (!p) return null;
    return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
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

function firstDayOfYm(ym) {
    const m = String(ym || '').match(/^(\d{4})-(\d{2})$/);
    if (!m) return null;
    return `${m[1]}-${m[2]}-01`;
}

function rowDedupeKey(r) {
    return [
        r.transactionId || '',
        r.orderId || '',
        r.transactionDate || '',
        r.transactionSum || '',
        r.paymentStatus || '',
        r.transactionSource || '',
        r.shopSku || '',
        r.bankOrderId || '',
        r.offerOrServiceName || '',
    ].join('|');
}

/** Неделя Маркета: 01-07 / 08-14 / 15-21 / 22-end → ключ "YYYY-MM bucket". */
function ymWeekPeriod(ruDate) {
    const p = parseRuDate(ruDate);
    if (!p) return null;
    const bucket = p.d <= 7 ? '01-07' : p.d <= 14 ? '08-14' : p.d <= 21 ? '15-21' : '22-end';
    return `${p.y}-${String(p.m).padStart(2, '0')} ${bucket}`;
}

function periodRank(pk) {
    const m = String(pk || '').match(/^(\d{4})-(\d{2}) (01-07|08-14|15-21|22-end)$/);
    if (!m) return null;
    const idx = { '01-07': 0, '08-14': 1, '15-21': 2, '22-end': 3 }[m[3]];
    return Number(m[1]) * 48 + (Number(m[2]) - 1) * 4 + idx;
}

function periodEndYmd(pk) {
    const m = String(pk || '').match(/^(\d{4})-(\d{2}) (01-07|08-14|15-21|22-end)$/);
    if (!m) return null;
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const b = m[3];
    if (b === '01-07') return `${m[1]}-${m[2]}-07`;
    if (b === '08-14') return `${m[1]}-${m[2]}-14`;
    if (b === '15-21') return `${m[1]}-${m[2]}-21`;
    const last = new Date(Date.UTC(y, mo, 0)).getUTCDate();
    return `${m[1]}-${m[2]}-${String(last).padStart(2, '0')}`;
}

/** Базовая дата выплаты при отсрочке 2 недели (до сдвига с вт/чт). */
function payoutBaseYmd(pk) {
    const m = String(pk || '').match(/^(\d{4})-(\d{2}) (01-07|08-14|15-21|22-end)$/);
    if (!m) return null;
    let y = Number(m[1]);
    let mo = Number(m[2]);
    const b = m[3];
    let day;
    if (b === '01-07') day = 20;
    else if (b === '08-14') day = 28;
    else if (b === '15-21') {
        day = 4;
        mo += 1;
        if (mo > 12) {
            mo = 1;
            y += 1;
        }
    } else {
        day = 12;
        mo += 1;
        if (mo > 12) {
            mo = 1;
            y += 1;
        }
    }
    return `${y}-${String(mo).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * Период «начислений» для строки: более поздняя из недель доставки и транзакции.
 * Без даты доставки — null (заказ ещё не в графике выплат недели).
 */
function ownerPeriod(row) {
    const pd = ymWeekPeriod(row && row.orderDeliveryDate);
    const pt = ymWeekPeriod(row && row.transactionDate);
    if (!pd) return null;
    if (!pt) return pd;
    const rd = periodRank(pd);
    const rt = periodRank(pt);
    if (rd == null) return pt;
    if (rt == null) return pd;
    return rt > rd ? pt : pd;
}

function isPeriodClosed(pk, asOfYmd) {
    const end = periodEndYmd(pk);
    return !!(end && asOfYmd && end < asOfYmd);
}

async function ensureYmFinanceSchema(db) {
    if (schemaReady) return schemaReady;
    schemaReady = (async () => {
        await db.query(`
            CREATE TABLE IF NOT EXISTS dg_mp_ym_finance_balance (
                as_of_date DATE NOT NULL,
                currency VARCHAR(8) NOT NULL DEFAULT 'RUB',
                owed_upcoming DECIMAL(18,2) NOT NULL DEFAULT 0,
                row_count INT NOT NULL DEFAULT 0,
                period_from DATE NULL,
                period_to DATE NULL,
                report_id VARCHAR(64) NULL,
                sync_script VARCHAR(32) NULL,
                synced_at DATETIME NOT NULL,
                PRIMARY KEY (as_of_date),
                KEY idx_ym_fin_synced (synced_at)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);
        await db.query(`
            CREATE TABLE IF NOT EXISTS dg_mp_ym_finance_month (
                ym CHAR(7) NOT NULL,
                owed_upcoming DECIMAL(18,2) NOT NULL DEFAULT 0,
                source VARCHAR(16) NOT NULL DEFAULT 'live',
                as_of_date DATE NULL,
                sync_script VARCHAR(32) NULL,
                synced_at DATETIME NOT NULL,
                PRIMARY KEY (ym),
                KEY idx_ym_fin_month_synced (synced_at)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);
        try {
            await db.query(
                'ALTER TABLE dg_mp_ym_finance_balance ADD COLUMN details_json MEDIUMTEXT NULL'
            );
        } catch (_) {
            /* column exists */
        }
    })();
    return schemaReady;
}

async function sleep(ms) {
    await new Promise((r) => setTimeout(r, ms));
}

async function unzipToDir(zipPath, outDir) {
    await execFileAsync('unzip', ['-o', '-q', zipPath, '-d', outDir], { timeout: 60000 });
}

function extractRows(payload) {
    if (Array.isArray(payload)) return payload;
    if (!payload || typeof payload !== 'object') return [];
    if (Array.isArray(payload.rows)) return payload.rows;
    if (Array.isArray(payload.result)) return payload.result;
    if (Array.isArray(payload.transactions)) return payload.transactions;
    return [];
}

/**
 * Сумма к выплате по закрытым неделям + разбивка.
 * @param {object[]} rows
 * @param {string} asOfYmd YYYY-MM-DD (МСК)
 */
function sumUpcoming(rows, asOfYmd) {
    const asOf = String(asOfYmd || mskYmd(new Date())).slice(0, 10);
    const byPeriod = Object.create(null);
    let counted = 0;
    let openSkipped = 0;
    let openSkippedSum = 0;

    for (const r of rows || []) {
        const st = String(r.paymentStatus || '');
        if (st !== UPCOMING_STATUS && st !== HOLD_FUTURE_STATUS) continue;
        const op = ownerPeriod(r);
        if (!op) continue;
        const v = num(r.transactionSum);
        if (!isPeriodClosed(op, asOf)) {
            openSkipped += 1;
            openSkippedSum += v;
            continue;
        }
        if (!byPeriod[op]) {
            byPeriod[op] = {
                period: op,
                amount: 0,
                row_count: 0,
                payout_base: payoutBaseYmd(op),
                period_end: periodEndYmd(op),
            };
        }
        byPeriod[op].amount += v;
        byPeriod[op].row_count += 1;
        counted += 1;
    }

    const periods = Object.keys(byPeriod)
        .sort()
        .map((k) => {
            const p = byPeriod[k];
            p.amount = Math.round(p.amount * 100) / 100;
            return p;
        })
        .filter((p) => Math.abs(p.amount) >= 0.005);

    let owed = 0;
    periods.forEach((p) => {
        owed += p.amount;
    });
    owed = Math.round(owed * 100) / 100;

    return {
        owed,
        count: counted,
        periods,
        open_week_skipped_rows: openSkipped,
        open_week_skipped_sum: Math.round(openSkippedSum * 100) / 100,
        as_of: asOf,
    };
}

/**
 * Сумма фактических выплат по месяцу даты bankOrderDate (уникальный bankOrderId).
 * Для графика — как суммирование строк кабинета по «Дата выплаты».
 * @returns {Object.<string, {ym:string, paid:number, banks:number, items:object[]}>}
 */
function sumPaidByMonth(rows) {
    const seen = Object.create(null);
    for (const r of rows || []) {
        if (!r.bankOrderId) continue;
        const id = String(r.bankOrderId);
        if (seen[id]) continue;
        const iso = ruDateToIso(r.bankOrderDate);
        if (!iso) continue;
        seen[id] = {
            bank_order_id: id,
            bank_order_date: iso,
            ym: iso.slice(0, 7),
            bank_sum: num(r.bankSum),
            contract: r.placementContract || null,
        };
    }
    const byYm = Object.create(null);
    Object.keys(seen).forEach((id) => {
        const b = seen[id];
        if (!byYm[b.ym]) {
            byYm[b.ym] = { ym: b.ym, paid: 0, banks: 0, items: [] };
        }
        byYm[b.ym].paid += b.bank_sum;
        byYm[b.ym].banks += 1;
        byYm[b.ym].items.push(b);
    });
    Object.keys(byYm).forEach((ym) => {
        byYm[ym].paid = Math.round(byYm[ym].paid * 100) / 100;
        byYm[ym].items.sort((a, b) =>
            String(a.bank_order_date).localeCompare(String(b.bank_order_date))
        );
    });
    return byYm;
}

/** @deprecated alias — исторический EOM-долг; график больше не использует. */
function sumOwedAsOfHistorical(rows, asOfYmd) {
    const asOf = String(asOfYmd || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf)) {
        return { owed: 0, count: 0, banks: [], upcoming: 0, as_of: asOf };
    }
    const paid = sumPaidByMonth(rows);
    // Для отладки: выплаты строго после asOf (не метрика графика).
    let bankOwed = 0;
    const banks = [];
    Object.keys(paid).forEach((ym) => {
        (paid[ym].items || []).forEach((b) => {
            if (b.bank_order_date > asOf) {
                bankOwed += b.bank_sum;
                banks.push(b);
            }
        });
    });
    return {
        owed: Math.round(bankOwed * 100) / 100,
        count: banks.length,
        banks,
        bank_owed: Math.round(bankOwed * 100) / 100,
        upcoming: 0,
        as_of: asOf,
    };
}

async function generateUnitedNetting(creds, dateFrom, dateTo) {
    const body = {
        businessId: Number(creds.businessId),
        dateFrom,
        dateTo,
        campaignIds: [Number(creds.campaignId)],
    };
    const url = `${YM_BASE}/v2/reports/united-netting/generate?format=JSON`;
    const res = await axios.post(url, body, {
        headers: ymHeaders(creds),
        timeout: 60000,
        validateStatus: () => true,
    });
    if (res.status === 420) {
        const until = res.headers && res.headers['x-ratelimit-resource-until'];
        const err = new Error(
            'Я.М лимит отчётов (420)' + (until ? ': ждать до ' + until : '') + '. Повторите позже.'
        );
        err.code = 'YM_RATE_LIMIT';
        err.until = until || null;
        throw err;
    }
    if (res.status >= 400 || !res.data || res.data.status === 'ERROR') {
        const msg =
            (res.data &&
                res.data.errors &&
                res.data.errors[0] &&
                (res.data.errors[0].message || res.data.errors[0].code)) ||
            `HTTP ${res.status}`;
        throw new Error('Я.М united-netting: ' + msg);
    }
    const reportId = res.data && res.data.result && res.data.result.reportId;
    if (!reportId) throw new Error('Я.М united-netting: нет reportId');
    return String(reportId);
}

async function waitReportFile(creds, reportId) {
    const url = `${YM_BASE}/v2/reports/info/${encodeURIComponent(reportId)}`;
    for (let i = 0; i < POLL_MAX; i++) {
        const res = await axios.get(url, {
            headers: ymHeaders(creds),
            timeout: 30000,
            validateStatus: () => true,
        });
        const st = res.data && res.data.result && res.data.result.status;
        if (st === 'DONE') {
            const file = res.data.result.file;
            if (!file) throw new Error('Я.М отчёт DONE без file');
            return String(file);
        }
        if (st === 'FAILED' || st === 'ERROR' || res.status >= 400) {
            throw new Error('Я.М отчёт ' + (st || 'HTTP ' + res.status));
        }
        await sleep(POLL_MS);
    }
    throw new Error('Я.М отчёт: таймаут ожидания');
}

async function downloadAndParseReport(fileUrl) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ym-fin-'));
    const zipPath = path.join(tmp, 'report.zip');
    try {
        const bin = await axios.get(fileUrl, {
            responseType: 'arraybuffer',
            timeout: 180000,
        });
        fs.writeFileSync(zipPath, Buffer.from(bin.data));
        await unzipToDir(zipPath, tmp);
        const jsonName = fs.readdirSync(tmp).find((n) => n.endsWith('.json'));
        if (!jsonName) throw new Error('Я.М отчёт: нет JSON в архиве');
        const payload = JSON.parse(fs.readFileSync(path.join(tmp, jsonName), 'utf8'));
        return extractRows(payload);
    } finally {
        try {
            fs.rmSync(tmp, { recursive: true, force: true });
        } catch (_) {
            /* ignore */
        }
    }
}

async function upsertBalance(db, row) {
    await db.query(
        `INSERT INTO dg_mp_ym_finance_balance
            (as_of_date, currency, owed_upcoming, row_count, period_from, period_to, report_id, sync_script, details_json, synced_at)
         VALUES (?, 'RUB', ?, ?, ?, ?, ?, ?, ?, NOW())
         ON DUPLICATE KEY UPDATE
            owed_upcoming = VALUES(owed_upcoming),
            row_count = VALUES(row_count),
            period_from = VALUES(period_from),
            period_to = VALUES(period_to),
            report_id = VALUES(report_id),
            sync_script = VALUES(sync_script),
            details_json = VALUES(details_json),
            synced_at = NOW()`,
        [
            row.as_of_date,
            row.owed_upcoming,
            row.row_count,
            row.period_from,
            row.period_to,
            row.report_id,
            row.sync_script,
            row.details_json || null,
        ]
    );
}

async function upsertMonth(db, ym, owed, source, asOfDate, syncScript, opts) {
    const o = opts || {};
    const force = !!o.force;
    const [exist] = await db.query(
        `SELECT source FROM dg_mp_ym_finance_month WHERE ym = ? LIMIT 1`,
        [ym]
    );
    const prev = exist && exist[0] ? String(exist[0].source || '') : '';
    // Не затираем официальный EOM mid-month live / backfill без force.
    if (!force && prev === 'eom' && source !== 'eom') {
        return { ym, skipped: true, reason: 'keep_eom' };
    }
    // Live текущего месяца не трогает уже залитый backfill прошлых (сюда live и не должен).
    if (!force && prev === 'backfill' && source === 'live') {
        return { ym, skipped: true, reason: 'keep_backfill' };
    }
    await db.query(
        `INSERT INTO dg_mp_ym_finance_month
            (ym, owed_upcoming, source, as_of_date, sync_script, synced_at)
         VALUES (?, ?, ?, ?, ?, NOW())
         ON DUPLICATE KEY UPDATE
            owed_upcoming = VALUES(owed_upcoming),
            source = VALUES(source),
            as_of_date = VALUES(as_of_date),
            sync_script = VALUES(sync_script),
            synced_at = NOW()`,
        [ym, owed, source, asOfDate, syncScript]
    );
    return { ym, source, owed_upcoming: owed };
}

async function fetchUnitedNettingRows(creds, dateFrom, dateTo) {
    const reportId = await generateUnitedNetting(creds, dateFrom, dateTo);
    const fileUrl = await waitReportFile(creds, reportId);
    const rows = await downloadAndParseReport(fileUrl);
    return { reportId, rows };
}

/**
 * Несколько окон ≤90 дней с паузой под лимит ~1 отчёт / 2 мин.
 * @returns {Promise<object[]>}
 */
async function fetchMergedUnitedNetting(creds, rangeFrom, rangeTo, onProgress) {
    const fromMs = new Date(String(rangeFrom) + 'T12:00:00Z').getTime();
    const toMs = new Date(String(rangeTo) + 'T12:00:00Z').getTime();
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs < fromMs) {
        throw new Error('Я.М backfill: неверный диапазон дат');
    }
    const windows = [];
    let cursor = fromMs;
    while (cursor <= toMs) {
        const wFrom = ymd(new Date(cursor));
        const wToMs = Math.min(cursor + (REPORT_WINDOW_DAYS - 1) * 86400000, toMs);
        const wTo = ymd(new Date(wToMs));
        windows.push({ dateFrom: wFrom, dateTo: wTo });
        cursor = wToMs + 86400000;
    }

    const byKey = Object.create(null);
    const reportIds = [];
    for (let i = 0; i < windows.length; i++) {
        const w = windows[i];
        if (typeof onProgress === 'function') {
            onProgress({
                phase: 'fetch',
                window: i + 1,
                windows: windows.length,
                dateFrom: w.dateFrom,
                dateTo: w.dateTo,
            });
        }
        if (i > 0) await sleep(RATE_LIMIT_WAIT_MS);
        let attempt = 0;
        for (;;) {
            try {
                const { reportId, rows } = await fetchUnitedNettingRows(creds, w.dateFrom, w.dateTo);
                reportIds.push(reportId);
                (rows || []).forEach((r) => {
                    byKey[rowDedupeKey(r)] = r;
                });
                break;
            } catch (e) {
                if (e && e.code === 'YM_RATE_LIMIT' && attempt < 3) {
                    attempt += 1;
                    await sleep(RATE_LIMIT_WAIT_MS);
                    continue;
                }
                throw e;
            }
        }
    }
    return { rows: Object.values(byKey), reportIds, windows };
}

/**
 * Бэкап точек графика: Σ выплат (bankSum) по месяцу даты выплаты.
 * Body opts: fromYm, toYm (включительно; toYm может быть текущий), force.
 */
async function backfillYmFinanceMonths(db, appSettings, opts) {
    const o = opts || {};
    await ensureYmFinanceSchema(db);
    const creds = ymCreds(appSettings);
    const meta = getYmFinanceSyncMeta();
    if (!creds.apiKey || !creds.campaignId || !creds.businessId) {
        return {
            success: false,
            error: 'Не заданы ym_api_key / ym_campaign_id / ym_business_id',
            sync_script: meta,
        };
    }

    const curYm = currentYmMsk();
    let fromYm = String(o.fromYm || o.from_ym || '').trim();
    let toYm = String(o.toYm || o.to_ym || '').trim();
    if (!/^\d{4}-\d{2}$/.test(fromYm)) fromYm = addMonthsYm(curYm, -12);
    if (!/^\d{4}-\d{2}$/.test(toYm)) toYm = curYm;
    if (toYm > curYm) toYm = curYm;
    if (!fromYm || !toYm || fromYm > toYm) {
        return { success: false, error: 'Пустой диапазон месяцев для бэкапа', sync_script: meta };
    }

    const rangeFrom = firstDayOfYm(fromYm);
    const rangeTo = mskYmd(new Date());
    const t0 = Date.now();

    let merged;
    try {
        merged = await fetchMergedUnitedNetting(creds, rangeFrom, rangeTo, o.onProgress);
    } catch (e) {
        return {
            success: false,
            error: e && e.message ? String(e.message) : String(e),
            sync_script: meta,
            rate_limited: e && e.code === 'YM_RATE_LIMIT',
        };
    }

    const paidByYm = sumPaidByMonth(merged.rows);
    const force = !!o.force;
    const months = [];
    let ym = fromYm;
    while (ym && ym <= toYm) {
        const block = paidByYm[ym];
        const paid = block ? num(block.paid) : 0;
        if (Math.abs(paid) < 0.005) {
            if (force) {
                await db.query(
                    `DELETE FROM dg_mp_ym_finance_month WHERE ym = ? AND source IN ('backfill','live','eom')`,
                    [ym]
                );
            }
            months.push({
                ym,
                paid: 0,
                banks: 0,
                skipped: true,
                reason: 'zero_skip',
            });
            ym = addMonthsYm(ym, 1);
            continue;
        }
        const source = ym === curYm ? 'live' : 'backfill';
        const up = await upsertMonth(
            db,
            ym,
            paid,
            source,
            ym === curYm ? mskYmd(new Date()) : lastDayOfYm(ym),
            meta.version,
            { force }
        );
        months.push({
            ym,
            paid,
            banks: block ? block.banks : 0,
            items: block ? block.items : [],
            skipped: !!(up && up.skipped),
            reason: up && up.reason ? up.reason : null,
        });
        ym = addMonthsYm(ym, 1);
    }

    return {
        success: true,
        message: `Я.М backfill выплат ${fromYm}…${toYm}: ${months.filter((m) => !m.skipped).length} мес., строк отчёта ${merged.rows.length}`,
        from_ym: fromYm,
        to_ym: toYm,
        months,
        row_count: merged.rows.length,
        report_ids: merged.reportIds,
        sync_script: meta,
        duration_sec: Math.round((Date.now() - t0) / 1000),
    };
}

/**
 * @param {object} opts
 * @param {number} [opts.lookbackDays]
 */
async function runYmFinanceSync(db, appSettings, opts) {
    const o = opts || {};
    await ensureYmFinanceSchema(db);
    const creds = ymCreds(appSettings);
    const meta = getYmFinanceSyncMeta();
    if (!creds.apiKey || !creds.campaignId || !creds.businessId) {
        return {
            success: false,
            error: 'Не заданы ym_api_key / ym_campaign_id / ym_business_id',
            sync_script: meta,
        };
    }

    const lookback = Math.max(30, Math.min(120, Number(o.lookbackDays) || LOOKBACK_DAYS));
    const toDate = new Date();
    const fromDate = new Date(toDate.getTime() - lookback * 86400000);
    const dateFrom = ymd(fromDate);
    const dateTo = ymd(toDate);
    const asOf = mskYmd(new Date());

    let reportId;
    try {
        reportId = await generateUnitedNetting(creds, dateFrom, dateTo);
    } catch (e) {
        return {
            success: false,
            error: e && e.message ? String(e.message) : String(e),
            sync_script: meta,
            rate_limited: e && e.code === 'YM_RATE_LIMIT',
        };
    }

    let rows;
    try {
        const fileUrl = await waitReportFile(creds, reportId);
        rows = await downloadAndParseReport(fileUrl);
    } catch (e) {
        return {
            success: false,
            error: e && e.message ? String(e.message) : String(e),
            sync_script: meta,
            report_id: reportId,
        };
    }

    const summed = sumUpcoming(rows, asOf);
    const paidByYm = sumPaidByMonth(rows);
    const ym = asOf.slice(0, 7);
    const paidMtd = paidByYm[ym] ? num(paidByYm[ym].paid) : 0;
    const details = {
        periods: summed.periods,
        open_week_skipped_rows: summed.open_week_skipped_rows,
        open_week_skipped_sum: summed.open_week_skipped_sum,
        lookback_days: lookback,
        paid_in_month: paidMtd,
        paid_banks: paidByYm[ym] ? paidByYm[ym].banks : 0,
    };
    await upsertBalance(db, {
        as_of_date: asOf,
        owed_upcoming: summed.owed,
        row_count: summed.count,
        period_from: dateFrom,
        period_to: dateTo,
        report_id: reportId,
        sync_script: meta.version,
        details_json: JSON.stringify(details),
    });
    // График: выплаты за месяц (не «к выплате»).
    const parts = asOf.split('-');
    let monthSource = 'live';
    if (parts.length === 3) {
        const y = Number(parts[0]);
        const m = Number(parts[1]);
        const d = Number(parts[2]);
        const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
        if (d === lastDay) monthSource = 'eom';
    }
    await upsertMonth(db, ym, paidMtd, monthSource, asOf, meta.version);

    const periodHint = summed.periods
        .map((p) => `${p.payout_base || p.period}: ${p.amount}`)
        .slice(0, 4)
        .join('; ');

    return {
        success: true,
        message:
            `Я.М к выплате: ${summed.owed} ₽` +
            (periodHint ? ` (${periodHint})` : '') +
            ` · ${summed.count} опер., отчёт ${dateFrom}…${dateTo}` +
            (summed.open_week_skipped_rows
                ? `; открытая неделя не в KPI (${summed.open_week_skipped_sum} ₽)`
                : ''),
        owed_upcoming: summed.owed,
        row_count: summed.count,
        periods: summed.periods,
        open_week_skipped_rows: summed.open_week_skipped_rows,
        open_week_skipped_sum: summed.open_week_skipped_sum,
        period_from: dateFrom,
        period_to: dateTo,
        report_id: reportId,
        as_of_date: asOf,
        sync_script: meta,
        duration_sec: null,
    };
}

async function loadYmFinanceForFinance(db) {
    await ensureYmFinanceSchema(db);
    const meta = getYmFinanceSyncMeta();
    const [rows] = await db.query(
        `SELECT DATE_FORMAT(as_of_date, '%Y-%m-%d') AS as_of_date,
                owed_upcoming, row_count,
                DATE_FORMAT(period_from, '%Y-%m-%d') AS period_from,
                DATE_FORMAT(period_to, '%Y-%m-%d') AS period_to,
                report_id, sync_script, details_json, synced_at
         FROM dg_mp_ym_finance_balance
         ORDER BY as_of_date DESC
         LIMIT 1`
    );
    if (!rows || !rows.length) {
        return {
            owed: 0,
            source: 'empty',
            sync_script: meta,
        };
    }
    const r = rows[0];
    let details = null;
    if (r.details_json) {
        try {
            details =
                typeof r.details_json === 'string' ? JSON.parse(r.details_json) : r.details_json;
        } catch (_) {
            details = null;
        }
    }
    return {
        owed: num(r.owed_upcoming),
        row_count: Number(r.row_count) || 0,
        as_of_date: r.as_of_date || null,
        period_from: r.period_from || null,
        period_to: r.period_to || null,
        report_id: r.report_id || null,
        synced_at: r.synced_at || null,
        periods: (details && details.periods) || [],
        open_week_skipped_sum:
            details && details.open_week_skipped_sum != null
                ? num(details.open_week_skipped_sum)
                : null,
        source: 'db',
        sync_script: meta,
    };
}

/**
 * @param {string[]} monthKeys YYYY-MM
 */
async function loadYmOwedByYm(db, monthKeys) {
    await ensureYmFinanceSchema(db);
    const keys = (monthKeys || []).filter(Boolean);
    if (!keys.length) return Object.create(null);
    const ph = keys.map(() => '?').join(',');
    const [rows] = await db.query(
        `SELECT ym, owed_upcoming, source, DATE_FORMAT(as_of_date, '%Y-%m-%d') AS as_of_date
         FROM dg_mp_ym_finance_month
         WHERE ym IN (${ph})`,
        keys
    );
    const out = Object.create(null);
    (rows || []).forEach((r) => {
        out[String(r.ym)] = {
            ym: String(r.ym),
            owed_upcoming: num(r.owed_upcoming),
            source: r.source || 'live',
            as_of_date: r.as_of_date || null,
        };
    });
    return out;
}

module.exports = {
    ensureYmFinanceSchema,
    runYmFinanceSync,
    backfillYmFinanceMonths,
    loadYmFinanceForFinance,
    loadYmOwedByYm,
    getYmFinanceSyncMeta,
    currentYmMsk,
    sumUpcoming,
    sumPaidByMonth,
    sumOwedAsOfHistorical,
    ownerPeriod,
    ymWeekPeriod,
    UPCOMING_STATUS,
    HOLD_FUTURE_STATUS,
};
