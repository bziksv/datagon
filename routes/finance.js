/**
 * Финансы: JWT Точки, Open API Райффайзен и T‑API Т‑Банка (счета/балансы/проводки, только чтение).
 */
const express = require('express');
const tochka = require('../lib/datagonTochkaClient');
const raiff = require('../lib/datagonRaiffeisenClient');
const tbank = require('../lib/datagonTbankClient');
const finCred = require('../lib/datagonFinanceCredentials');

const DEFAULT_TX_DAYS = 30;
const MAX_TX_DAYS = 1095; // до ~3 лет (1 + 2)

let tablesReady = null;
let syncJob = {
    active: false,
    message: '',
    started_at: null,
    last_error: null,
    last_result: null,
};

async function ensureFinanceTables(db) {
    if (tablesReady) return tablesReady;
    tablesReady = (async () => {
        await db.query(`
            CREATE TABLE IF NOT EXISTS dg_finance_accounts (
                bank VARCHAR(32) NOT NULL DEFAULT 'tochka',
                account_id VARCHAR(64) NOT NULL,
                account_number VARCHAR(64) NOT NULL DEFAULT '',
                currency VARCHAR(8) NOT NULL DEFAULT 'RUB',
                name VARCHAR(255) NOT NULL DEFAULT '',
                status VARCHAR(64) NOT NULL DEFAULT '',
                account_type VARCHAR(64) NOT NULL DEFAULT '',
                account_sub_type VARCHAR(64) NOT NULL DEFAULT '',
                customer_code VARCHAR(64) NOT NULL DEFAULT '',
                credential_id VARCHAR(64) NOT NULL DEFAULT '',
                org_label VARCHAR(120) NOT NULL DEFAULT '',
                balance DECIMAL(18,2) NULL,
                available DECIMAL(18,2) NULL,
                blocked DECIMAL(18,2) NULL,
                synced_at DATETIME NULL,
                updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                PRIMARY KEY (bank, account_id),
                KEY idx_fin_acc_synced (synced_at),
                KEY idx_fin_acc_cred (credential_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);
        const alters = [
            `ALTER TABLE dg_finance_accounts ADD COLUMN account_sub_type VARCHAR(64) NOT NULL DEFAULT '' AFTER account_type`,
            `ALTER TABLE dg_finance_accounts ADD COLUMN customer_code VARCHAR(64) NOT NULL DEFAULT '' AFTER account_sub_type`,
            `ALTER TABLE dg_finance_accounts ADD COLUMN credential_id VARCHAR(64) NOT NULL DEFAULT '' AFTER customer_code`,
            `ALTER TABLE dg_finance_accounts ADD COLUMN org_label VARCHAR(120) NOT NULL DEFAULT '' AFTER credential_id`,
            `ALTER TABLE dg_finance_accounts ADD COLUMN is_fund TINYINT(1) NOT NULL DEFAULT 0 AFTER org_label`,
            `ALTER TABLE dg_finance_accounts ADD COLUMN custom_name VARCHAR(120) NOT NULL DEFAULT '' AFTER is_fund`,
            `ALTER TABLE dg_finance_tx ADD COLUMN exclude_chart TINYINT(1) NOT NULL DEFAULT 0 AFTER document_number`,
            `ALTER TABLE dg_finance_tx ADD COLUMN chart_tag VARCHAR(16) NOT NULL DEFAULT '' AFTER exclude_chart`,
        ];
        for (const sql of alters) {
            try {
                await db.query(sql);
            } catch (e) {
                /* already exists */
            }
        }
        try {
            await db.query(
                "UPDATE dg_finance_tx SET chart_tag = 'founder' WHERE exclude_chart = 1 AND (chart_tag IS NULL OR chart_tag = '')"
            );
        } catch (_) {
            /* ignore */
        }
        try {
            await db.query(
                "UPDATE dg_finance_accounts SET currency = 'RUB' WHERE UPPER(TRIM(currency)) IN ('RUR','810','643')"
            );
            await db.query(
                "UPDATE dg_finance_tx SET currency = 'RUB' WHERE UPPER(TRIM(currency)) IN ('RUR','810','643')"
            );
        } catch (_) {
            /* ignore */
        }
        await db.query(`
            CREATE TABLE IF NOT EXISTS dg_finance_tx (
                bank VARCHAR(32) NOT NULL DEFAULT 'tochka',
                tx_id VARCHAR(160) NOT NULL,
                account_id VARCHAR(64) NOT NULL,
                booked_at VARCHAR(40) NOT NULL DEFAULT '',
                booked_date DATE NULL,
                amount DECIMAL(18,2) NOT NULL DEFAULT 0,
                amount_abs DECIMAL(18,2) NOT NULL DEFAULT 0,
                direction VARCHAR(8) NOT NULL DEFAULT 'in',
                currency VARCHAR(8) NOT NULL DEFAULT 'RUB',
                purpose TEXT,
                counterparty VARCHAR(512) NOT NULL DEFAULT '',
                counterparty_inn VARCHAR(32) NOT NULL DEFAULT '',
                document_number VARCHAR(64) NOT NULL DEFAULT '',
                exclude_chart TINYINT(1) NOT NULL DEFAULT 0,
                chart_tag VARCHAR(16) NOT NULL DEFAULT '',
                synced_at DATETIME NULL,
                updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                PRIMARY KEY (bank, tx_id),
                KEY idx_fin_tx_acc_date (account_id, booked_date),
                KEY idx_fin_tx_dir (direction),
                KEY idx_fin_tx_date (booked_date)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);
    })();
    return tablesReady;
}

function pageMode(req) {
    const actor = req.datagonActor || {};
    if (actor.username === 'admin') return 'full';
    const pm = (actor.page_modes || {}).finance;
    return pm === 'full' || pm === 'view' ? pm : 'hidden';
}

function requireFinanceAccess(req, res, write) {
    const mode = pageMode(req);
    if (mode === 'hidden') {
        res.status(403).json({ success: false, error: 'Нет доступа к разделу «Финансы»' });
        return null;
    }
    if (write && mode !== 'full') {
        res.status(403).json({ success: false, error: 'Режим только просмотра', code: 'PAGE_VIEW_ONLY' });
        return null;
    }
    return mode;
}

function parseBookedDate(bookedAt) {
    const s = String(bookedAt || '').slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    return null;
}

function getSyncState() {
    return { ...syncJob };
}

/** Одно короткое название для колонки «Организация» (не склеивать всех клиентов JWT). */
function shortOrgLabelFromName(name) {
    const pick = String(name || '').trim();
    if (!pick) return '';
    const mOoo = pick.match(/ООО\s*[«"']?\s*([^»"']+?)\s*[»"']?\s*$/i);
    if (mOoo && mOoo[1]) {
        const core = mOoo[1].trim();
        if (core) return (core.charAt(0).toUpperCase() + core.slice(1).toLowerCase()).slice(0, 120);
    }
    const mIp = pick.match(/^ИП\s+(.+)$/i);
    if (mIp && mIp[1]) return ('ИП ' + mIp[1].trim()).slice(0, 120);
    return pick.slice(0, 120);
}

function parseCustomerCodes(src) {
    const out = [];
    function push(v) {
        if (v == null || v === '') return;
        if (Array.isArray(v)) {
            v.forEach(push);
            return;
        }
        String(v)
            .split(/[,;]/)
            .forEach((s) => {
                const t = String(s).trim();
                if (t && out.indexOf(t) < 0) out.push(t);
            });
    }
    if (src && typeof src === 'object') {
        push(src.customer_codes);
        push(src.customer_code);
        push(src.org);
    } else {
        push(src);
    }
    return out;
}

function sqlCustomerCodeIn(alias, codes, where, params) {
    if (!codes || !codes.length) return;
    if (codes.length === 1) {
        where.push(alias + '.customer_code = ?');
        params.push(codes[0]);
        return;
    }
    where.push(alias + '.customer_code IN (' + codes.map(() => '?').join(',') + ')');
    codes.forEach((c) => params.push(c));
}

function filterAccountsByCustomerCodes(accounts, codes) {
    if (!codes || !codes.length) return accounts;
    const set = new Set(codes);
    return (accounts || []).filter((a) => set.has(String(a.customer_code || '')));
}

function pickOrgLabelFromCustomers(names) {
    const list = (Array.isArray(names) ? names : [])
        .map((n) => String(n || '').trim())
        .filter(Boolean);
    if (!list.length) return '';
    const company = list.find((n) => /^(ООО|АО|ПАО|ЗАО|ОАО|ИП)\b/i.test(n));
    return shortOrgLabelFromName(company || list[0]);
}

async function enrichCredentialMeta(cred) {
    const jwt = String(cred.jwt || '').trim();
    if (!jwt) return cred;
    try {
        const customers = await tochka.listCustomers(jwt);
        cred.customer_codes = customers.map((c) => c.customer_code).filter(Boolean);
        cred.customer_names = customers.map((c) => c.short_name || c.full_name || c.customer_code).filter(Boolean);
        const autoLabels = new Set(['', 'Точка', 'Точка (основной)']);
        if (autoLabels.has(String(cred.label || '').trim())) {
            const picked = pickOrgLabelFromCustomers(cred.customer_names);
            if (picked) cred.label = picked.slice(0, 120);
        }
    } catch (e) {
        /* optional */
    }
    cred.updated_at = new Date().toISOString();
    return cred;
}

async function probeOneCredential(cred) {
    const jwt = String(cred.jwt || '').trim();
    const accounts = await tochka.listAccounts(jwt);
    let customers = [];
    let consents = [];
    let consent_gaps = [];
    try {
        customers = await tochka.listCustomers(jwt);
    } catch (e) {
        /* optional */
    }
    try {
        consents = await tochka.listConsents(jwt);
        consent_gaps = tochka.analyzeConsentGaps(customers, consents);
    } catch (e) {
        /* optional */
    }
    const subtypes = {};
    for (const a of accounts) {
        const k = a.account_sub_type || 'Unknown';
        subtypes[k] = (subtypes[k] || 0) + 1;
    }
    return {
        credential_id: cred.id,
        label: cred.label,
        count: accounts.length,
        customers,
        consents,
        consent_gaps,
        account_sub_types: subtypes,
        accounts: accounts.map((a) => ({
            account_id: a.account_id,
            account_number: a.account_number,
            currency: a.currency,
            name: a.name,
            account_type: a.account_type,
            account_sub_type: a.account_sub_type,
            account_sub_type_label: a.account_sub_type_label,
            customer_code: a.customer_code,
        })),
    };
}

async function upsertFinanceAccount(db, bank, acc) {
    await db.query(
        `INSERT INTO dg_finance_accounts
            (bank, account_id, account_number, currency, name, status, account_type, account_sub_type, customer_code, credential_id, org_label, balance, available, blocked, synced_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
         ON DUPLICATE KEY UPDATE
            account_number = VALUES(account_number),
            currency = VALUES(currency),
            name = VALUES(name),
            status = VALUES(status),
            account_type = VALUES(account_type),
            account_sub_type = VALUES(account_sub_type),
            customer_code = VALUES(customer_code),
            credential_id = VALUES(credential_id),
            org_label = VALUES(org_label),
            balance = VALUES(balance),
            available = VALUES(available),
            blocked = VALUES(blocked),
            synced_at = VALUES(synced_at)`,
        [
            bank,
            acc.account_id,
            acc.account_number,
            finCred.normalizeCurrency(acc.currency),
            acc.name,
            acc.status,
            acc.account_type,
            acc.account_sub_type || '',
            acc.customer_code || '',
            acc.credential_id,
            acc.org_label,
            acc.balance,
            acc.available,
            acc.blocked,
        ]
    );
}

async function upsertFinanceTx(db, bank, tx) {
    const bookedDate = parseBookedDate(tx.booked_at);
    await db.query(
        `INSERT INTO dg_finance_tx
            (bank, tx_id, account_id, booked_at, booked_date, amount, amount_abs, direction, currency, purpose, counterparty, counterparty_inn, document_number, synced_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
         ON DUPLICATE KEY UPDATE
            account_id = VALUES(account_id),
            booked_at = VALUES(booked_at),
            booked_date = VALUES(booked_date),
            amount = VALUES(amount),
            amount_abs = VALUES(amount_abs),
            direction = VALUES(direction),
            currency = VALUES(currency),
            purpose = VALUES(purpose),
            counterparty = VALUES(counterparty),
            counterparty_inn = VALUES(counterparty_inn),
            document_number = VALUES(document_number),
            synced_at = VALUES(synced_at)`,
        [
            bank,
            String(tx.tx_id).slice(0, 160),
            tx.account_id,
            String(tx.booked_at || '').slice(0, 40),
            bookedDate,
            tx.amount,
            tx.amount_abs,
            tx.direction,
            finCred.normalizeCurrency(tx.currency),
            tx.purpose,
            String(tx.counterparty || '').slice(0, 512),
            String(tx.counterparty_inn || '').slice(0, 32),
            String(tx.document_number || '').slice(0, 64),
        ]
    );
}

function parseYmd(s) {
    const v = String(s || '').trim();
    return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : '';
}

function truthyQueryFlag(v) {
    return ['1', 'true', 'yes', 'on'].includes(String(v == null ? '' : v).trim().toLowerCase());
}

/**
 * Не операционный оборот: тело депозита (UNV), переводы расчётный ↔ фонд,
 * выплаты дивидендов владельцу. Проценты по депозиту и платежи из фонда (налоги и т.п.) остаются.
 */
function sqlExcludeInternalTransfers(alias) {
    const p = (alias ? alias + '.' : '') + 'purpose';
    return `(${p} IS NULL OR (
        ${p} NOT LIKE '%открытия депозита%'
        AND ${p} NOT LIKE '%Возврат средств по депозитной сделке%'
        AND ${p} NOT LIKE '%Перевод собственных средств%'
        AND ${p} NOT LIKE '%Выплата дивидендов%'
    ))`;
}

/** Те же правила, что sqlExcludeInternalTransfers — для флага в API выписки. */
function isChartExcludedPurpose(purpose) {
    const p = String(purpose || '');
    if (!p) return false;
    const low = p.toLowerCase();
    return (
        low.includes('открытия депозита') ||
        p.includes('Возврат средств по депозитной сделке') ||
        p.includes('Перевод собственных средств') ||
        p.includes('Выплата дивидендов')
    );
}

function isDividendPurpose(purpose) {
    return String(purpose || '').includes('Выплата дивидендов');
}

/** Ручные пометки (займ / дивиденды) — не операционный оборот, синк не затирает. */
function sqlExcludeManualChartTags(alias) {
    const col = (alias ? alias + '.' : '') + 'exclude_chart';
    return `(${col} IS NULL OR ${col} = 0)`;
}

function normalizeChartTag(raw) {
    const s = String(raw || '')
        .trim()
        .toLowerCase();
    if (s === 'founder' || s === 'loan' || s === 'займ') return 'founder';
    if (s === 'dividend' || s === 'dividends' || s === 'дивиденды') return 'dividend';
    return '';
}

function txChartFlags(row) {
    const tag = normalizeChartTag(row && row.chart_tag);
    const legacyFounder = Number(row && row.exclude_chart) === 1 && !tag;
    const founder = tag === 'founder' || legacyFounder;
    const dividend = tag === 'dividend';
    const auto = isChartExcludedPurpose(row && row.purpose);
    const chartExcluded = auto || founder || dividend;
    let reason = null;
    if (founder) reason = 'капитал/займ';
    else if (dividend) reason = 'дивиденды';
    else if (auto) reason = chartExcludeReason(row && row.purpose);
    return {
        chart_tag: founder ? 'founder' : dividend ? 'dividend' : '',
        founder_capital: founder,
        dividend_payout: dividend || isDividendPurpose(row && row.purpose),
        auto_internal: auto,
        chart_excluded: chartExcluded,
        chart_exclude_reason: reason,
    };
}

function chartExcludeReason(purpose) {
    const p = String(purpose || '');
    if (!p) return '';
    const low = p.toLowerCase();
    if (low.includes('открытия депозита') || p.includes('Возврат средств по депозитной сделке')) {
        return 'депозит';
    }
    if (p.includes('Перевод собственных средств')) return 'перевод своих';
    if (p.includes('Выплата дивидендов')) return 'дивиденды';
    return 'внутр.';
}

/** Период выписки: date_from/date_to или окно days. */
function resolveStatementWindow(opts) {
    const dateFrom = parseYmd(opts && opts.date_from);
    const dateTo = parseYmd(opts && opts.date_to);
    if (dateFrom || dateTo) {
        const end = dateTo || tochka.ymd(new Date());
        const start = dateFrom || end;
        if (start > end) {
            const err = new Error('Дата «с» больше даты «по»');
            err.status = 400;
            throw err;
        }
        const ms = Date.parse(end + 'T00:00:00Z') - Date.parse(start + 'T00:00:00Z');
        const spanDays = Math.floor(ms / 86400000) + 1;
        if (spanDays > MAX_TX_DAYS) {
            const err = new Error('Период выписки не больше ' + MAX_TX_DAYS + ' дней (сейчас ' + spanDays + ')');
            err.status = 400;
            throw err;
        }
        return { startYmd: start, endYmd: end, days: spanDays, from_dates: true };
    }
    const days = Math.max(1, Math.min(MAX_TX_DAYS, Number(opts && opts.days != null ? opts.days : DEFAULT_TX_DAYS)));
    const end = new Date();
    const start = new Date();
    start.setDate(start.getDate() - (days - 1));
    return { startYmd: tochka.ymd(start), endYmd: tochka.ymd(end), days, from_dates: false };
}

async function syncOneCredential(db, cred, opts) {
    const jwt = String(cred.jwt || '').trim();
    const skipTx = opts.skipTx;
    const onProgress = opts.onProgress;
    const customerCodes = parseCustomerCodes(opts);
    const accountIdFilter = String(opts.account_id || '').trim();
    const window = opts.window || resolveStatementWindow(opts);
    const errors = [];
    let accountsOk = 0;
    let txUpserted = 0;
    let customersMeta = [];

    let accounts = await tochka.listAccounts(jwt);
    try {
        customersMeta = await tochka.listCustomers(jwt);
    } catch (e) {
        /* optional */
    }
    const customerNameByCode = Object.create(null);
    for (const c of customersMeta) {
        if (c.customer_code) customerNameByCode[c.customer_code] = c.short_name || c.full_name || c.customer_code;
    }
    accounts = filterAccountsByCustomerCodes(accounts, customerCodes);
    if (accountIdFilter) {
        accounts = accounts.filter(
            (a) =>
                String(a.account_id || '') === accountIdFilter ||
                String(a.account_number || '') === accountIdFilter
        );
    }
    if (!accounts.length) {
        return {
            credential_id: cred.id,
            label: String(cred.label || 'Точка').slice(0, 120),
            accounts: 0,
            tx_upserted: 0,
            customers: customersMeta.length,
            account_sub_types: {},
            errors: [],
            skipped: true,
            period: { from: window.startYmd, to: window.endYmd, days: window.days },
        };
    }
    onProgress({ message: (cred.label || 'Точка') + ': счетов ' + accounts.length, accounts: accounts.length });
    syncJob.message = (cred.label || 'Точка') + ': балансы…';
    let balById = new Map();
    try {
        balById = await tochka.listAllBalances(jwt);
    } catch (e) {
        errors.push({ code: cred.id + ':balances', error: e.message || String(e) });
    }
    const startYmd = window.startYmd;
    const endYmd = window.endYmd;
    const days = window.days;
    const credFallbackLabel = String(cred.label || 'Точка').slice(0, 120);

    for (const acc of accounts) {
        const customerRaw =
            (acc.customer_code && customerNameByCode[acc.customer_code]) || '';
        const accountOrgLabel =
            shortOrgLabelFromName(customerRaw) || credFallbackLabel;
        syncJob.message = accountOrgLabel + ': ' + (acc.account_number || acc.account_id);
        onProgress({ message: syncJob.message, account_id: acc.account_id, credential_id: cred.id });
        let bal = balById.get(acc.account_id) || { available: null, blocked: null, balance: null };
        if (bal.available == null && bal.balance == null) {
            try {
                bal = await tochka.getAccountBalances(jwt, acc.account_id);
            } catch (e) {
                errors.push({ code: acc.account_id, error: e.message || String(e) });
            }
        }
        const displayName =
            (customerRaw ? customerRaw + ' · ' : accountOrgLabel ? accountOrgLabel + ' · ' : '') +
            (acc.account_sub_type_label || tochka.accountSubTypeLabel(acc.account_sub_type) || 'Счёт');
        await upsertFinanceAccount(db, 'tochka', {
            account_id: acc.account_id,
            account_number: acc.account_number,
            currency: acc.currency || bal.currency || 'RUB',
            name: displayName,
            status: acc.status,
            account_type: acc.account_type,
            account_sub_type: acc.account_sub_type || '',
            customer_code: acc.customer_code || '',
            credential_id: cred.id,
            org_label: accountOrgLabel,
            balance: bal.balance,
            available: bal.available,
            blocked: bal.blocked,
        });
        accountsOk += 1;
        if (skipTx) continue;
        try {
            syncJob.message =
                accountOrgLabel +
                ': выписка ' +
                (acc.account_number || acc.account_id) +
                ' ' +
                startYmd +
                '…' +
                endYmd;
            onProgress({ message: syncJob.message, account_id: acc.account_id });
            const st = await tochka.fetchStatement(jwt, acc.account_id, startYmd, endYmd);
            const txs = tochka.flattenTransactions(st.statement, acc.account_id);
            for (const tx of txs) {
                await upsertFinanceTx(db, 'tochka', tx);
                txUpserted += 1;
            }
        } catch (e) {
            errors.push({ code: acc.account_id, error: e.message || String(e) });
        }
    }

    const subtypes = {};
    for (const a of accounts) {
        const k = a.account_sub_type || 'Unknown';
        subtypes[k] = (subtypes[k] || 0) + 1;
    }
    return {
        credential_id: cred.id,
        label: credFallbackLabel,
        accounts: accountsOk,
        tx_upserted: txUpserted,
        customers: customersMeta.length,
        account_sub_types: subtypes,
        errors,
        period: { from: startYmd, to: endYmd, days },
    };
}

async function runTochkaSync(db, appSettings, opts) {
    await ensureFinanceTables(db);
    const nested = Boolean(opts && opts.nested);
    if (!nested && syncJob.active && !(opts && opts._claimed)) {
        return { success: false, reason: 'already_running', message: syncJob.message || 'Уже идёт обновление' };
    }
    const allCreds = await finCred.loadCredentials(db, appSettings);
    let creds = finCred.enabledWithJwt(allCreds);
    if (opts && opts.credential_id) {
        creds = creds.filter((c) => c.id === String(opts.credential_id));
    }
    if (!creds.length) {
        if (opts && opts.allowEmpty) {
            return {
                success: true,
                skipped: true,
                reason: 'missing_jwt',
                accounts: 0,
                tx_upserted: 0,
                credentials: 0,
                by_credential: [],
                errors: [],
                message: 'Нет JWT Точки',
            };
        }
        return {
            success: false,
            reason: 'missing_jwt',
            message: 'Добавьте хотя бы один JWT Точки (организация) на странице «Финансы»',
        };
    }
    let window;
    try {
        window = resolveStatementWindow(opts || {});
    } catch (e) {
        return { success: false, reason: 'bad_period', message: e.message || String(e) };
    }
    const customerCodes = parseCustomerCodes(opts);
    const accountId = String((opts && opts.account_id) || '').trim();
    const skipTx = Boolean(opts && opts.balances_only);
    const onProgress = typeof (opts && opts.onProgress) === 'function' ? opts.onProgress : () => {};
    const t0 = Date.now();
    const scopeBits = [];
    if (customerCodes.length) scopeBits.push('орг ' + customerCodes.join(','));
    if (accountId) scopeBits.push('счёт');
    if (!nested) {
        syncJob = {
            active: true,
            message:
                'Финансы: ' +
                window.startYmd +
                '…' +
                window.endYmd +
                (scopeBits.length ? ' (' + scopeBits.join(', ') + ')' : '') +
                ' · ключей ' +
                creds.length,
            started_at: new Date().toISOString(),
            last_error: null,
            last_result: null,
        };
    } else {
        syncJob.message = 'Точка: ключей ' + creds.length;
    }
    const errors = [];
    let accountsOk = 0;
    let txUpserted = 0;
    const byCred = [];
    const subtypes = {};
    try {
        for (const cred of creds) {
            try {
                const one = await syncOneCredential(db, cred, {
                    window,
                    days: window.days,
                    date_from: window.startYmd,
                    date_to: window.endYmd,
                    customer_codes: customerCodes.length ? customerCodes : undefined,
                    account_id: accountId || undefined,
                    skipTx,
                    onProgress,
                });
                if (one.skipped && !one.accounts) continue;
                accountsOk += one.accounts;
                txUpserted += one.tx_upserted;
                byCred.push({
                    credential_id: one.credential_id,
                    label: one.label,
                    accounts: one.accounts,
                    tx_upserted: one.tx_upserted,
                    customers: one.customers,
                });
                for (const [k, v] of Object.entries(one.account_sub_types || {})) {
                    subtypes[k] = (subtypes[k] || 0) + v;
                }
                for (const er of one.errors || []) errors.push(er);
            } catch (e) {
                errors.push({ code: cred.id || cred.label, error: e.message || String(e) });
            }
        }
        const duration_sec = Math.round((Date.now() - t0) / 1000);
        const success = accountsOk > 0 || errors.length === 0;
        const result = {
            success,
            dry_run: false,
            accounts: accountsOk,
            tx_upserted: txUpserted,
            balances_only: skipTx,
            credentials: byCred.length,
            by_credential: byCred,
            account_sub_types: subtypes,
            api_note:
                'Выписка с учётом периода/орг/счёта из фильтров. Один JWT может покрывать несколько юрлиц.',
            errors: errors.slice(0, 20),
            duration_sec,
            days: window.days,
            date_from: window.startYmd,
            date_to: window.endYmd,
            customer_codes: customerCodes,
            account_id: accountId || '',
            message:
                'Ключей ' +
                byCred.length +
                ', счетов ' +
                accountsOk +
                ', проводок ' +
                txUpserted +
                ' · ' +
                window.startYmd +
                '…' +
                window.endYmd +
                ' · ' +
                duration_sec +
                ' с',
        };
        if (!nested) {
            syncJob.active = false;
            syncJob.last_result = result;
            syncJob.message = result.message;
            syncJob.last_error = success ? null : (errors[0] && errors[0].error) || result.message;
        }
        return result;
    } catch (e) {
        if (!nested) {
            syncJob.active = false;
            syncJob.last_error = e.message || String(e);
            syncJob.message = syncJob.last_error;
        }
        throw e;
    }
}

async function persistRaiffCred(db, appSettings, cred) {
    const list = await finCred.loadRaiffeisenCredentials(db, appSettings);
    const i = list.findIndex((c) => c.id === cred.id);
    if (i >= 0) list[i] = finCred.normalizeRaiffCredential(cred);
    else list.push(finCred.normalizeRaiffCredential(cred));
    await finCred.saveRaiffeisenCredentials(db, appSettings, list);
}

async function enrichRaiffCredentialMeta(db, appSettings, cred) {
    try {
        await raiff.ensureTokens(cred);
        await persistRaiffCred(db, appSettings, cred);
        const accounts = await raiff.listAccounts(cred);
        const names = [];
        const codes = [];
        for (const a of accounts) {
            if (a.customer_code && codes.indexOf(a.customer_code) < 0) codes.push(a.customer_code);
            if (a.org_name && names.indexOf(a.org_name) < 0) names.push(a.org_name);
        }
        cred.customer_codes = codes;
        cred.customer_names = names;
        const autoLabels = new Set(['', 'Райффайзен', 'Райф']);
        if (autoLabels.has(String(cred.label || '').trim()) && names[0]) {
            const picked = pickOrgLabelFromCustomers(names);
            if (picked) cred.label = picked.slice(0, 120);
        }
        cred.updated_at = new Date().toISOString();
        await persistRaiffCred(db, appSettings, cred);
    } catch (e) {
        /* optional */
    }
    return cred;
}

async function syncOneRaiffeisenCredential(db, appSettings, cred, opts) {
    const skipTx = opts.skipTx;
    const onProgress = opts.onProgress;
    const customerCodes = parseCustomerCodes(opts);
    const accountIdFilter = String(opts.account_id || '').trim();
    const window = opts.window || resolveStatementWindow(opts);
    const errors = [];
    let accountsOk = 0;
    let txUpserted = 0;

    await raiff.ensureTokens(cred);
    await persistRaiffCred(db, appSettings, cred);
    let accounts = await raiff.listAccounts(cred);
    await persistRaiffCred(db, appSettings, cred);
    accounts = filterAccountsByCustomerCodes(accounts, customerCodes);
    if (accountIdFilter) {
        accounts = accounts.filter(
            (a) =>
                String(a.account_id || '') === accountIdFilter ||
                String(a.account_number || '') === accountIdFilter
        );
    }
    const names = [];
    for (const a of accounts) {
        if (a.org_name && names.indexOf(a.org_name) < 0) names.push(a.org_name);
    }
    cred.customer_names = names;
    cred.customer_codes = Array.from(new Set(accounts.map((a) => a.customer_code).filter(Boolean)));
    await persistRaiffCred(db, appSettings, cred);

    if (!accounts.length) {
        return {
            credential_id: cred.id,
            label: String(cred.label || 'Райффайзен').slice(0, 120),
            bank: 'raiffeisen',
            accounts: 0,
            tx_upserted: 0,
            errors: [],
            skipped: true,
            period: { from: window.startYmd, to: window.endYmd, days: window.days },
        };
    }
    onProgress({ message: (cred.label || 'Райф') + ': счетов ' + accounts.length, accounts: accounts.length });

    for (const acc of accounts) {
        const accountOrgLabel = shortOrgLabelFromName(acc.org_name) || String(cred.label || 'Райффайзен').slice(0, 120);
        syncJob.message = 'Райф · ' + accountOrgLabel + ': ' + (acc.account_number || acc.account_id);
        onProgress({ message: syncJob.message, account_id: acc.account_id, credential_id: cred.id });
        let balance = acc.available != null ? acc.available : acc.balance;
        let txs = [];
        if (!skipTx) {
            try {
                syncJob.message =
                    'Райф · ' +
                    accountOrgLabel +
                    ': выписка ' +
                    (acc.account_number || acc.account_id) +
                    ' ' +
                    window.startYmd +
                    '…' +
                    window.endYmd;
                onProgress({ message: syncJob.message, account_id: acc.account_id });
                const st = await raiff.fetchAccountStatementRange(
                    cred,
                    acc.account_number || acc.account_id,
                    window.startYmd,
                    window.endYmd
                );
                await persistRaiffCred(db, appSettings, cred);
                txs = st.transactions || [];
                if (st.lastBalance != null) balance = st.lastBalance;
            } catch (e) {
                errors.push({ code: acc.account_id, error: e.message || String(e) });
            }
        }
        const displayName =
            (accountOrgLabel ? accountOrgLabel + ' · ' : '') + (acc.account_sub_type_label || 'Счёт');
        await upsertFinanceAccount(db, 'raiffeisen', {
            account_id: acc.account_id,
            account_number: acc.account_number,
            currency: acc.currency || 'RUB',
            name: displayName,
            status: acc.status || '',
            account_type: acc.account_type || '',
            account_sub_type: acc.account_sub_type || '',
            customer_code: acc.customer_code || '',
            credential_id: cred.id,
            org_label: accountOrgLabel,
            balance: balance,
            available: balance,
            blocked: acc.blocked,
        });
        accountsOk += 1;
        for (const tx of txs) {
            await upsertFinanceTx(db, 'raiffeisen', tx);
            txUpserted += 1;
        }
        await raiff.sleep(120);
    }
    return {
        credential_id: cred.id,
        label: String(cred.label || 'Райффайзен').slice(0, 120),
        bank: 'raiffeisen',
        accounts: accountsOk,
        tx_upserted: txUpserted,
        errors,
        period: { from: window.startYmd, to: window.endYmd, days: window.days },
    };
}

async function runRaiffeisenSync(db, appSettings, opts) {
    await ensureFinanceTables(db);
    const nested = Boolean(opts && opts.nested);
    if (!nested && syncJob.active && !(opts && opts._claimed)) {
        return { success: false, reason: 'already_running', message: syncJob.message || 'Уже идёт обновление' };
    }
    const allCreds = await finCred.loadRaiffeisenCredentials(db, appSettings);
    let creds = finCred.enabledRaiffeisen(allCreds);
    if (opts && opts.credential_id) {
        creds = creds.filter((c) => c.id === String(opts.credential_id));
    }
    if (!creds.length) {
        if (opts && opts.allowEmpty) {
            return {
                success: true,
                skipped: true,
                reason: 'missing_raiff',
                accounts: 0,
                tx_upserted: 0,
                credentials: 0,
                by_credential: [],
                errors: [],
                message: 'Нет ключей Райфа',
            };
        }
        return {
            success: false,
            reason: 'missing_raiff',
            message: 'Добавьте client_id, secret и refresh_token Райфа на странице «Финансы»',
        };
    }
    let window;
    try {
        window = resolveStatementWindow(opts || {});
    } catch (e) {
        return { success: false, reason: 'bad_period', message: e.message || String(e) };
    }
    const customerCodes = parseCustomerCodes(opts);
    const accountId = String((opts && opts.account_id) || '').trim();
    const skipTx = Boolean(opts && opts.balances_only);
    const onProgress = typeof (opts && opts.onProgress) === 'function' ? opts.onProgress : () => {};
    const t0 = Date.now();
    if (!nested) {
        syncJob = {
            active: true,
            message: 'Райф: ' + window.startYmd + '…' + window.endYmd + ' · ключей ' + creds.length,
            started_at: new Date().toISOString(),
            last_error: null,
            last_result: null,
        };
    } else {
        syncJob.message = 'Райф: ключей ' + creds.length;
    }
    const errors = [];
    let accountsOk = 0;
    let txUpserted = 0;
    const byCred = [];
    try {
        for (const cred of creds) {
            try {
                const one = await syncOneRaiffeisenCredential(db, appSettings, cred, {
                    window,
                    customer_codes: customerCodes.length ? customerCodes : undefined,
                    account_id: accountId || undefined,
                    skipTx,
                    onProgress,
                });
                if (one.skipped && !one.accounts) continue;
                accountsOk += one.accounts;
                txUpserted += one.tx_upserted;
                byCred.push({
                    credential_id: one.credential_id,
                    label: one.label,
                    bank: 'raiffeisen',
                    accounts: one.accounts,
                    tx_upserted: one.tx_upserted,
                });
                for (const er of one.errors || []) errors.push(er);
            } catch (e) {
                errors.push({ code: cred.id || cred.label, error: e.message || String(e) });
            }
        }
        const duration_sec = Math.round((Date.now() - t0) / 1000);
        const success = accountsOk > 0 || errors.length === 0;
        const result = {
            success,
            dry_run: false,
            bank: 'raiffeisen',
            accounts: accountsOk,
            tx_upserted: txUpserted,
            balances_only: skipTx,
            credentials: byCred.length,
            by_credential: byCred,
            errors: errors.slice(0, 20),
            duration_sec,
            days: window.days,
            date_from: window.startYmd,
            date_to: window.endYmd,
            message:
                'Райф: ключей ' +
                byCred.length +
                ', счетов ' +
                accountsOk +
                ', проводок ' +
                txUpserted +
                ' · ' +
                duration_sec +
                ' с',
        };
        if (!nested) {
            syncJob.active = false;
            syncJob.last_result = result;
            syncJob.message = result.message;
            syncJob.last_error = success ? null : (errors[0] && errors[0].error) || result.message;
        }
        return result;
    } catch (e) {
        if (!nested) {
            syncJob.active = false;
            syncJob.last_error = e.message || String(e);
            syncJob.message = syncJob.last_error;
        }
        throw e;
    }
}

async function persistTbankCred(db, appSettings, cred) {
    const list = await finCred.loadTbankCredentials(db, appSettings);
    const i = list.findIndex((c) => c.id === cred.id);
    if (i >= 0) list[i] = finCred.normalizeTbankCredential(cred);
    else list.push(finCred.normalizeTbankCredential(cred));
    await finCred.saveTbankCredentials(db, appSettings, list);
}

async function enrichTbankCredentialMeta(db, appSettings, cred) {
    try {
        const accounts = await tbank.listAccounts(cred.token);
        const names = [];
        const codes = [];
        for (const a of accounts) {
            if (a.customer_code && codes.indexOf(a.customer_code) < 0) codes.push(a.customer_code);
            if (a.org_name && names.indexOf(a.org_name) < 0) names.push(a.org_name);
        }
        cred.customer_codes = codes;
        cred.customer_names = names;
        const autoLabels = new Set(['', 'Т‑Банк', 'Т-Банк', 'Тинькофф']);
        if (autoLabels.has(String(cred.label || '').trim()) && names[0]) {
            const picked = pickOrgLabelFromCustomers(names);
            if (picked) cred.label = picked.slice(0, 120);
        }
        cred.updated_at = new Date().toISOString();
        await persistTbankCred(db, appSettings, cred);
    } catch (_) {
        /* optional */
    }
    return cred;
}

async function syncOneTbankCredential(db, appSettings, cred, opts) {
    const skipTx = opts.skipTx;
    const onProgress = opts.onProgress;
    const customerCodes = parseCustomerCodes(opts);
    const accountIdFilter = String(opts.account_id || '').trim();
    const window = opts.window || resolveStatementWindow(opts);
    const errors = [];
    let accountsOk = 0;
    let txUpserted = 0;

    let accounts = await tbank.listAccounts(cred.token);
    accounts = filterAccountsByCustomerCodes(accounts, customerCodes);
    if (accountIdFilter) {
        accounts = accounts.filter(
            (a) =>
                String(a.account_id || '') === accountIdFilter ||
                String(a.account_number || '') === accountIdFilter
        );
    }
    const names = [];
    for (const a of accounts) {
        if (a.org_name && names.indexOf(a.org_name) < 0) names.push(a.org_name);
    }
    cred.customer_names = names;
    cred.customer_codes = Array.from(new Set(accounts.map((a) => a.customer_code).filter(Boolean)));
    await persistTbankCred(db, appSettings, cred);

    if (!accounts.length) {
        return {
            credential_id: cred.id,
            label: String(cred.label || 'Т‑Банк').slice(0, 120),
            bank: 'tbank',
            accounts: 0,
            tx_upserted: 0,
            errors: [],
            skipped: true,
            period: { from: window.startYmd, to: window.endYmd, days: window.days },
        };
    }
    onProgress({ message: (cred.label || 'Т‑Банк') + ': счетов ' + accounts.length, accounts: accounts.length });

    for (const acc of accounts) {
        const accountOrgLabel = shortOrgLabelFromName(acc.org_name) || String(cred.label || 'Т‑Банк').slice(0, 120);
        syncJob.message = 'Т‑Банк · ' + accountOrgLabel + ': ' + (acc.account_number || acc.account_id);
        onProgress({ message: syncJob.message, account_id: acc.account_id, credential_id: cred.id });
        let balance = acc.available != null ? acc.available : acc.balance;
        let txs = [];
        if (!skipTx) {
            try {
                syncJob.message =
                    'Т‑Банк · ' +
                    accountOrgLabel +
                    ': выписка ' +
                    (acc.account_number || acc.account_id) +
                    ' ' +
                    window.startYmd +
                    '…' +
                    window.endYmd;
                onProgress({ message: syncJob.message, account_id: acc.account_id });
                const st = await tbank.fetchAccountStatementRange(
                    cred.token,
                    acc.account_number || acc.account_id,
                    window.startYmd,
                    window.endYmd
                );
                txs = st.transactions || [];
                if (st.lastBalance != null) balance = st.lastBalance;
                const innHit = txs.map((t) => t.inn).find((x) => x && String(x).length >= 10);
                const orgHit = txs.map((t) => t.org_name).find((x) => x);
                if (innHit && String(acc.customer_code || '').indexOf('tb:') === 0 && acc.customer_code.length < 15) {
                    acc.customer_code = tbank.customerCodeFromInn(innHit, cred.token);
                }
                if (orgHit && (!acc.org_name || acc.org_name === 'Расчётный счёт' || acc.org_name === 'Т‑Банк')) {
                    acc.org_name = orgHit;
                }
            } catch (e) {
                errors.push({ code: acc.account_id, error: e.message || String(e) });
            }
        }
        const displayName =
            (accountOrgLabel ? accountOrgLabel + ' · ' : '') + (acc.account_sub_type_label || 'Счёт');
        await upsertFinanceAccount(db, 'tbank', {
            account_id: acc.account_id,
            account_number: acc.account_number,
            currency: acc.currency || 'RUB',
            name: displayName,
            status: acc.status || '',
            account_type: acc.account_type || '',
            account_sub_type: acc.account_sub_type || '',
            customer_code: acc.customer_code || '',
            credential_id: cred.id,
            org_label: accountOrgLabel,
            balance,
            available: acc.available != null ? acc.available : balance,
            blocked: acc.blocked,
        });
        accountsOk += 1;
        for (const tx of txs) {
            await upsertFinanceTx(db, 'tbank', tx);
            txUpserted += 1;
        }
    }
    return {
        credential_id: cred.id,
        label: String(cred.label || 'Т‑Банк').slice(0, 120),
        bank: 'tbank',
        accounts: accountsOk,
        tx_upserted: txUpserted,
        errors,
        period: { from: window.startYmd, to: window.endYmd, days: window.days },
    };
}

async function runTbankSync(db, appSettings, opts) {
    const nested = Boolean(opts && opts.nested);
    const allowEmpty = Boolean(opts && opts.allowEmpty);
    await ensureFinanceTables(db);
    const all = await finCred.loadTbankCredentials(db, appSettings);
    let creds = finCred.enabledTbank(all);
    const onlyId = String((opts && opts.credential_id) || '').trim();
    if (onlyId) creds = all.filter((c) => c.id === onlyId && String(c.token || '').trim());
    if (!creds.length) {
        if (allowEmpty) {
            return {
                success: true,
                skipped: true,
                reason: 'missing_tbank',
                accounts: 0,
                tx_upserted: 0,
                credentials: 0,
                by_credential: [],
                errors: [],
                message: 'Нет токенов Т‑Банка',
            };
        }
        return {
            success: false,
            reason: 'missing_tbank',
            message: 'Добавьте токен T‑API на странице «Финансы»',
        };
    }
    let window;
    try {
        window = resolveStatementWindow(opts || {});
    } catch (e) {
        return { success: false, reason: 'bad_period', message: e.message || String(e) };
    }
    const customerCodes = parseCustomerCodes(opts);
    const accountId = String((opts && opts.account_id) || '').trim();
    const skipTx = Boolean(opts && opts.balances_only);
    const onProgress = typeof (opts && opts.onProgress) === 'function' ? opts.onProgress : () => {};
    const t0 = Date.now();
    if (!nested) {
        syncJob = {
            active: true,
            message: 'Т‑Банк: ' + window.startYmd + '…' + window.endYmd + ' · ключей ' + creds.length,
            started_at: new Date().toISOString(),
            last_error: null,
            last_result: null,
        };
    } else {
        syncJob.message = 'Т‑Банк: ключей ' + creds.length;
    }
    const errors = [];
    let accountsOk = 0;
    let txUpserted = 0;
    const byCred = [];
    try {
        for (const cred of creds) {
            try {
                const one = await syncOneTbankCredential(db, appSettings, cred, {
                    window,
                    customer_codes: customerCodes.length ? customerCodes : undefined,
                    account_id: accountId || undefined,
                    skipTx,
                    onProgress,
                });
                if (one.skipped && !one.accounts) continue;
                accountsOk += one.accounts;
                txUpserted += one.tx_upserted;
                byCred.push({
                    credential_id: one.credential_id,
                    label: one.label,
                    bank: 'tbank',
                    accounts: one.accounts,
                    tx_upserted: one.tx_upserted,
                });
                for (const er of one.errors || []) errors.push(er);
            } catch (e) {
                errors.push({ code: cred.id || cred.label, error: e.message || String(e) });
            }
        }
        const duration_sec = Math.round((Date.now() - t0) / 1000);
        const success = accountsOk > 0 || errors.length === 0;
        const result = {
            success,
            dry_run: false,
            bank: 'tbank',
            accounts: accountsOk,
            tx_upserted: txUpserted,
            balances_only: skipTx,
            credentials: byCred.length,
            by_credential: byCred,
            errors: errors.slice(0, 20),
            duration_sec,
            days: window.days,
            date_from: window.startYmd,
            date_to: window.endYmd,
            customer_codes: customerCodes,
            account_id: accountId || '',
            message:
                'Т‑Банк: ключей ' +
                byCred.length +
                ', счетов ' +
                accountsOk +
                ', проводок ' +
                txUpserted +
                ' · ' +
                duration_sec +
                ' с',
        };
        if (!nested) {
            syncJob.active = false;
            syncJob.last_result = result;
            syncJob.message = result.message;
            syncJob.last_error = success ? null : (errors[0] && errors[0].error) || result.message;
        }
        return result;
    } catch (e) {
        if (!nested) {
            syncJob.active = false;
            syncJob.last_error = e.message || String(e);
            syncJob.message = syncJob.last_error;
        }
        throw e;
    }
}

function bankFromOpts(opts) {
    const bank = String((opts && opts.bank) || '').trim().toLowerCase();
    const credId = String((opts && opts.credential_id) || '').trim();
    if (bank === 'raiffeisen' || credId.indexOf('rf_') === 0) return 'raiffeisen';
    if (bank === 'tbank' || bank === 'tinkoff' || credId.indexOf('tb_') === 0) return 'tbank';
    if (bank === 'tochka' || credId.indexOf('tc_') === 0) return 'tochka';
    if (credId) return 'tochka';
    return '';
}

async function runFinanceAll(db, appSettings, opts) {
    const o = opts || {};
    const only = bankFromOpts(o);
    if (only === 'tochka') return runTochkaSync(db, appSettings, o);
    if (only === 'raiffeisen') return runRaiffeisenSync(db, appSettings, o);
    if (only === 'tbank') return runTbankSync(db, appSettings, o);
    if (syncJob.active && !o._claimed) {
        return { success: false, reason: 'already_running', message: syncJob.message || 'Уже идёт обновление' };
    }
    let window;
    try {
        window = resolveStatementWindow(o);
    } catch (e) {
        return { success: false, reason: 'bad_period', message: e.message || String(e) };
    }
    const t0 = Date.now();
    syncJob = {
        active: true,
        message: 'Финансы: Точка + Райф + Т‑Банк ' + window.startYmd + '…' + window.endYmd,
        started_at: new Date().toISOString(),
        last_error: null,
        last_result: null,
    };
    try {
        const nestedOpts = Object.assign({}, o, { nested: true, _claimed: true, allowEmpty: true, window });
        const tochkaRes = await runTochkaSync(db, appSettings, nestedOpts);
        const raiffRes = await runRaiffeisenSync(db, appSettings, nestedOpts);
        const tbankRes = await runTbankSync(db, appSettings, nestedOpts);
        if (
            tochkaRes.reason === 'missing_jwt' &&
            raiffRes.reason === 'missing_raiff' &&
            tbankRes.reason === 'missing_tbank'
        ) {
            const empty = {
                success: false,
                reason: 'missing_jwt',
                message: 'Добавьте JWT Точки, ключи Райфа или токен Т‑Банка на странице «Финансы»',
            };
            syncJob.active = false;
            syncJob.last_result = empty;
            syncJob.message = empty.message;
            syncJob.last_error = empty.message;
            return empty;
        }
        const byCred = []
            .concat(tochkaRes.by_credential || [])
            .concat(raiffRes.by_credential || [])
            .concat(tbankRes.by_credential || []);
        const errors = []
            .concat(tochkaRes.errors || [], raiffRes.errors || [], tbankRes.errors || [])
            .slice(0, 20);
        const accounts =
            Number(tochkaRes.accounts || 0) + Number(raiffRes.accounts || 0) + Number(tbankRes.accounts || 0);
        const txUpserted =
            Number(tochkaRes.tx_upserted || 0) +
            Number(raiffRes.tx_upserted || 0) +
            Number(tbankRes.tx_upserted || 0);
        const duration_sec = Math.round((Date.now() - t0) / 1000);
        const success = accounts > 0 || errors.length === 0;
        const result = {
            success,
            dry_run: false,
            accounts,
            tx_upserted: txUpserted,
            balances_only: Boolean(o.balances_only),
            credentials: byCred.length,
            by_credential: byCred,
            errors,
            duration_sec,
            days: window.days,
            date_from: window.startYmd,
            date_to: window.endYmd,
            api_note: 'Точка, Райффайзен и Т‑Банк пишутся в один снимок счетов и проводок.',
            message:
                'Точка + Райф + Т‑Банк: ключей ' +
                byCred.length +
                ', счетов ' +
                accounts +
                ', проводок ' +
                txUpserted +
                ' · ' +
                duration_sec +
                ' с',
        };
        syncJob.active = false;
        syncJob.last_result = result;
        syncJob.message = result.message;
        syncJob.last_error = success ? null : (errors[0] && errors[0].error) || result.message;
        return result;
    } catch (e) {
        syncJob.active = false;
        syncJob.last_error = e.message || String(e);
        syncJob.message = syncJob.last_error;
        throw e;
    }
}

async function triggerFinanceSync(db, appSettings, opts) {
    return runFinanceAll(db, appSettings, opts || {});
}

async function financeConfigPayload(db, appSettings, canWrite) {
    const pub = (await finCred.loadCredentials(db, appSettings)).map(finCred.publicCredential);
    const raiffPub = (await finCred.loadRaiffeisenCredentials(db, appSettings)).map(finCred.publicRaiffCredential);
    const tbankPub = (await finCred.loadTbankCredentials(db, appSettings)).map(finCred.publicTbankCredential);
    const configured =
        pub.some((c) => c.configured && c.enabled) ||
        raiffPub.some((c) => c.configured && c.enabled) ||
        tbankPub.some((c) => c.configured && c.enabled);
    return {
        success: true,
        configured,
        credentials: pub,
        raiffeisen_credentials: raiffPub,
        tbank_credentials: tbankPub,
        jwt_mask: pub[0] ? pub[0].jwt_mask : '',
        jwt_len: pub[0] ? pub[0].jwt_len : 0,
        can_write: canWrite,
        sync: getSyncState(),
    };
}

function factory(db, appSettings) {
    const router = express.Router();

    router.get('/config', async (req, res) => {
        if (!requireFinanceAccess(req, res, false)) return;
        try {
            const mode = pageMode(req);
            res.json(await financeConfigPayload(db, appSettings, mode === 'full'));
        } catch (e) {
            res.status(500).json({ success: false, error: e.message || String(e) });
        }
    });

    router.post('/config', async (req, res) => {
        if (!requireFinanceAccess(req, res, true)) return;
        try {
            const body = req.body || {};
            const bank = String(body.bank || '').trim().toLowerCase();
            if (bank === 'raiffeisen') {
                let list = await finCred.loadRaiffeisenCredentials(db, appSettings);
                const action = String(body.action || '').trim();
                if (action === 'upsert') {
                    const id = String(body.id || '').trim();
                    const label = String(body.label || '').trim();
                    let cred = id ? list.find((c) => c.id === id) : null;
                    if (cred) {
                        if (label) cred.label = label.slice(0, 120);
                        if (body.client_id != null) cred.client_id = String(body.client_id).trim().slice(0, 200);
                        if (body.client_secret) cred.client_secret = String(body.client_secret).trim().slice(0, 800);
                        if (body.refresh_token) cred.refresh_token = String(body.refresh_token).trim().slice(0, 8000);
                        if (body.enabled != null) cred.enabled = Boolean(body.enabled);
                    } else {
                        if (!String(body.client_id || '').trim() || !String(body.client_secret || '').trim() || !String(body.refresh_token || '').trim()) {
                            return res.status(400).json({
                                success: false,
                                error: 'Для Райфа нужны client_id, client_secret и refresh_token',
                            });
                        }
                        cred = finCred.normalizeRaiffCredential({
                            id: finCred.newRaiffCredId(),
                            label: label || 'Райффайзен',
                            client_id: body.client_id,
                            client_secret: body.client_secret,
                            refresh_token: body.refresh_token,
                            enabled: body.enabled !== false,
                        });
                        list.push(cred);
                    }
                    cred.updated_at = new Date().toISOString();
                    list = await finCred.saveRaiffeisenCredentials(db, appSettings, list);
                    await enrichRaiffCredentialMeta(db, appSettings, cred);
                    list = await finCred.loadRaiffeisenCredentials(db, appSettings);
                } else if (action === 'delete') {
                    const id = String(body.id || '').trim();
                    if (!id) return res.status(400).json({ success: false, error: 'Нужен id' });
                    list = await finCred.saveRaiffeisenCredentials(
                        db,
                        appSettings,
                        list.filter((c) => c.id !== id)
                    );
                } else if (action === 'toggle') {
                    const id = String(body.id || '').trim();
                    const cred = list.find((c) => c.id === id);
                    if (!cred) return res.status(404).json({ success: false, error: 'Ключ Райфа не найден' });
                    cred.enabled = body.enabled !== false && body.enabled !== 0 && body.enabled !== '0';
                    cred.updated_at = new Date().toISOString();
                    list = await finCred.saveRaiffeisenCredentials(db, appSettings, list);
                } else {
                    return res.status(400).json({
                        success: false,
                        error: 'Райф: action upsert|delete|toggle',
                    });
                }
                return res.json(await financeConfigPayload(db, appSettings, true));
            }

            if (bank === 'tbank' || bank === 'tinkoff') {
                let list = await finCred.loadTbankCredentials(db, appSettings);
                const action = String(body.action || '').trim();
                if (action === 'upsert') {
                    const id = String(body.id || '').trim();
                    const label = String(body.label || '').trim();
                    const token = String(body.token || '').trim();
                    let cred = id ? list.find((c) => c.id === id) : null;
                    if (cred) {
                        if (label) cred.label = label.slice(0, 120);
                        if (token) cred.token = token.slice(0, 8000);
                        if (body.enabled != null) cred.enabled = Boolean(body.enabled);
                    } else {
                        if (!token) {
                            return res.status(400).json({ success: false, error: 'Для Т‑Банка нужен токен T‑API' });
                        }
                        cred = finCred.normalizeTbankCredential({
                            id: finCred.newTbankCredId(),
                            label: label || 'Т‑Банк',
                            token,
                            enabled: body.enabled !== false,
                        });
                        list.push(cred);
                    }
                    cred.updated_at = new Date().toISOString();
                    list = await finCred.saveTbankCredentials(db, appSettings, list);
                    await enrichTbankCredentialMeta(db, appSettings, cred);
                } else if (action === 'delete') {
                    const id = String(body.id || '').trim();
                    if (!id) return res.status(400).json({ success: false, error: 'Нужен id' });
                    list = await finCred.saveTbankCredentials(
                        db,
                        appSettings,
                        list.filter((c) => c.id !== id)
                    );
                } else if (action === 'toggle') {
                    const id = String(body.id || '').trim();
                    const cred = list.find((c) => c.id === id);
                    if (!cred) return res.status(404).json({ success: false, error: 'Ключ Т‑Банка не найден' });
                    cred.enabled = body.enabled !== false && body.enabled !== 0 && body.enabled !== '0';
                    cred.updated_at = new Date().toISOString();
                    list = await finCred.saveTbankCredentials(db, appSettings, list);
                } else {
                    return res.status(400).json({
                        success: false,
                        error: 'Т‑Банк: action upsert|delete|toggle',
                    });
                }
                return res.json(await financeConfigPayload(db, appSettings, true));
            }

            let list = await finCred.loadCredentials(db, appSettings);
            const action = String(body.action || '').trim();

            // Legacy: { jwt } без action — upsert первой / новой записи
            if (!action && body.jwt != null) {
                const jwt = String(body.jwt).trim();
                if (!jwt) return res.status(400).json({ success: false, error: 'Пустой JWT' });
                const label = String(body.label || '').trim() || 'Точка';
                let cred = list.find((c) => c.id === body.id) || list[0];
                if (!cred) {
                    cred = finCred.normalizeCredential({ id: finCred.newCredId(), label, jwt, enabled: true });
                    list.push(cred);
                } else {
                    cred.jwt = jwt.slice(0, 8000);
                    if (body.label) cred.label = String(body.label).trim().slice(0, 120);
                    cred.enabled = true;
                }
                await enrichCredentialMeta(cred);
                list = await finCred.saveCredentials(db, appSettings, list);
            } else if (action === 'upsert') {
                const jwt = String(body.jwt || '').trim();
                const label = String(body.label || '').trim();
                const id = String(body.id || '').trim();
                let cred = id ? list.find((c) => c.id === id) : null;
                if (cred) {
                    if (jwt) cred.jwt = jwt.slice(0, 8000);
                    if (label) cred.label = label.slice(0, 120);
                    if (body.enabled != null) cred.enabled = Boolean(body.enabled);
                } else {
                    if (!jwt) return res.status(400).json({ success: false, error: 'Для нового ключа нужен JWT' });
                    cred = finCred.normalizeCredential({
                        id: finCred.newCredId(),
                        label: label || 'Точка',
                        jwt,
                        enabled: body.enabled !== false,
                    });
                    list.push(cred);
                }
                if (jwt || !cred.customer_codes.length) await enrichCredentialMeta(cred);
                else cred.updated_at = new Date().toISOString();
                list = await finCred.saveCredentials(db, appSettings, list);
            } else if (action === 'delete') {
                const id = String(body.id || '').trim();
                if (!id) return res.status(400).json({ success: false, error: 'Нужен id' });
                list = list.filter((c) => c.id !== id);
                list = await finCred.saveCredentials(db, appSettings, list);
            } else if (action === 'toggle') {
                const id = String(body.id || '').trim();
                const cred = list.find((c) => c.id === id);
                if (!cred) return res.status(404).json({ success: false, error: 'Ключ не найден' });
                cred.enabled = body.enabled !== false && body.enabled !== 0 && body.enabled !== '0';
                cred.updated_at = new Date().toISOString();
                list = await finCred.saveCredentials(db, appSettings, list);
            } else if (body.clear === true) {
                list = await finCred.saveCredentials(db, appSettings, []);
            } else {
                return res.status(400).json({
                    success: false,
                    error: 'Передайте action: upsert|delete|toggle или jwt / clear:true',
                });
            }

            res.json(await financeConfigPayload(db, appSettings, true));
        } catch (e) {
            res.status(500).json({ success: false, error: e.message || String(e) });
        }
    });

    router.get('/probe', async (req, res) => {
        if (!requireFinanceAccess(req, res, true)) return;
        try {
            const bank = String(req.query.bank || '').trim().toLowerCase();
            const credId = String(req.query.credential_id || '').trim();
            const results = [];
            let totalAccounts = 0;
            const consent_gaps_all = [];
            const wantTochka =
                (!bank && !credId) ||
                bank === 'tochka' ||
                (credId && credId.indexOf('tc_') === 0);
            const wantRaiff =
                (!bank && !credId) ||
                bank === 'raiffeisen' ||
                (credId && credId.indexOf('rf_') === 0);
            const wantTbank =
                (!bank && !credId) ||
                bank === 'tbank' ||
                bank === 'tinkoff' ||
                (credId && credId.indexOf('tb_') === 0);

            if (wantTochka) {
                const list = await finCred.loadCredentials(db, appSettings);
                let creds = finCred.enabledWithJwt(list);
                if (credId) creds = list.filter((c) => c.id === credId && String(c.jwt || '').trim());
                for (const cred of creds) {
                    try {
                        const one = await probeOneCredential(cred);
                        one.bank = 'tochka';
                        results.push(one);
                        totalAccounts += one.count;
                        for (const g of one.consent_gaps || []) {
                            consent_gaps_all.push(Object.assign({ credential_id: cred.id, label: cred.label, bank: 'tochka' }, g));
                        }
                    } catch (e) {
                        results.push({
                            bank: 'tochka',
                            credential_id: cred.id,
                            label: cred.label,
                            error: e.message || String(e),
                            count: 0,
                        });
                    }
                }
            }
            if (wantRaiff) {
                const list = await finCred.loadRaiffeisenCredentials(db, appSettings);
                let creds = finCred.enabledRaiffeisen(list);
                if (credId) creds = list.filter((c) => c.id === credId);
                for (const cred of creds) {
                    try {
                        await raiff.ensureTokens(cred);
                        await persistRaiffCred(db, appSettings, cred);
                        const accounts = await raiff.listAccounts(cred);
                        results.push({
                            bank: 'raiffeisen',
                            credential_id: cred.id,
                            label: cred.label,
                            count: accounts.length,
                            accounts: accounts.map((a) => ({
                                account_id: a.account_id,
                                account_number: a.account_number,
                                currency: a.currency,
                                name: a.name,
                                customer_code: a.customer_code,
                            })),
                        });
                        totalAccounts += accounts.length;
                    } catch (e) {
                        results.push({
                            bank: 'raiffeisen',
                            credential_id: cred.id,
                            label: cred.label,
                            error: e.message || String(e),
                            count: 0,
                        });
                    }
                }
            }
            if (wantTbank) {
                const list = await finCred.loadTbankCredentials(db, appSettings);
                let creds = finCred.enabledTbank(list);
                if (credId) creds = list.filter((c) => c.id === credId && String(c.token || '').trim());
                for (const cred of creds) {
                    try {
                        const accounts = await tbank.listAccounts(cred.token);
                        results.push({
                            bank: 'tbank',
                            credential_id: cred.id,
                            label: cred.label,
                            count: accounts.length,
                            accounts: accounts.map((a) => ({
                                account_id: a.account_id,
                                account_number: a.account_number,
                                currency: a.currency,
                                name: a.name,
                                customer_code: a.customer_code,
                            })),
                        });
                        totalAccounts += accounts.length;
                    } catch (e) {
                        results.push({
                            bank: 'tbank',
                            credential_id: cred.id,
                            label: cred.label,
                            error: e.message || String(e),
                            count: 0,
                        });
                    }
                }
            }
            if (!results.length) {
                return res.status(400).json({ success: false, error: 'Нет ключей для проверки (Точка, Райф или Т‑Банк)' });
            }
            res.json({
                success: true,
                count: totalAccounts,
                credentials_probed: results.length,
                results,
                consent_gaps: consent_gaps_all,
                api_note:
                    'Точка — JWT. Райф — client_id / secret / refresh. Т‑Банк — токен T‑API (Bearer). IP сервера должен быть в токене.',
                customers: (results[0] && results[0].customers) || [],
                account_sub_types: (results[0] && results[0].account_sub_types) || {},
                accounts: (results[0] && results[0].accounts) || [],
            });
        } catch (e) {
            res.status(e.status && e.status >= 400 ? e.status : 502).json({
                success: false,
                error: e.message || String(e),
            });
        }
    });

    router.get('/accounts', async (req, res) => {
        if (!requireFinanceAccess(req, res, false)) return;
        try {
            await ensureFinanceTables(db);
            const [rows] = await db.query(
                `SELECT bank, account_id, account_number, currency, name, status, account_type,
                        account_sub_type, customer_code, credential_id, org_label,
                        is_fund, custom_name,
                        balance, available, blocked, synced_at
                 FROM dg_finance_accounts
                 ORDER BY bank ASC, is_fund ASC, available DESC, org_label ASC, account_number ASC, account_id ASC`
            );
            const subtypes = {};
            for (const a of rows || []) {
                const k = a.account_sub_type || 'Unknown';
                subtypes[k] = (subtypes[k] || 0) + 1;
                a.is_fund = Number(a.is_fund) === 1;
                a.currency = finCred.normalizeCurrency(a.currency);
            }
            const org_aliases = await finCred.loadOrgAliases(db, appSettings);
            res.json({
                success: true,
                accounts: rows || [],
                account_sub_types: subtypes,
                org_aliases,
                can_write: pageMode(req) === 'full',
                api_note:
                    'Банк — в шапке организации (Точка / Райффайзен / Т‑Банк). Фонд: галка при редактировании названия (карандаш) или клик по бейджу типа.',
            });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message || String(e) });
        }
    });

    /** Своё название юрлица (customer_code): полное + короткое — не затирается синком. */
    router.post('/org-meta', async (req, res) => {
        if (!requireFinanceAccess(req, res, true)) return;
        try {
            const body = req.body || {};
            const customerCode = String(body.customer_code || '').trim();
            if (!customerCode) {
                return res.status(400).json({ success: false, error: 'Нужен customer_code' });
            }
            const aliases = await finCred.loadOrgAliases(db, appSettings);
            const prev = aliases[customerCode] || { full: '', short: '' };
            let full =
                body.full_name != null
                    ? String(body.full_name).trim().slice(0, 160)
                    : body.custom_name != null
                      ? String(body.custom_name).trim().slice(0, 160)
                      : String(prev.full || '').trim();
            let short =
                body.short_name != null
                    ? String(body.short_name).trim().slice(0, 80)
                    : String(prev.short || '').trim();
            // Явный сброс обоих пустых — удалить alias.
            const clearBoth =
                (body.full_name != null || body.custom_name != null) &&
                body.short_name != null &&
                !full &&
                !short;
            if (clearBoth || (!full && !short && body.full_name === '' && body.short_name === '')) {
                delete aliases[customerCode];
            } else if (!full && !short) {
                delete aliases[customerCode];
            } else {
                if (!full) full = short;
                if (!short) short = full.slice(0, 80);
                aliases[customerCode] = { full, short };
            }
            const saved = await finCred.saveOrgAliases(db, appSettings, aliases);
            const entry = saved[customerCode] || { full: '', short: '' };
            res.json({
                success: true,
                customer_code: customerCode,
                full_name: entry.full || '',
                short_name: entry.short || '',
                custom_name: entry.full || entry.short || '',
                org_aliases: saved,
            });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message || String(e) });
        }
    });

    /** Ручная пометка: фонд + своё название (не затирается синком из банка). */
    router.post('/account-meta', async (req, res) => {
        if (!requireFinanceAccess(req, res, true)) return;
        try {
            await ensureFinanceTables(db);
            const body = req.body || {};
            const accountId = String(body.account_id || '').trim();
            const bank = String(body.bank || 'tochka').trim() || 'tochka';
            if (!accountId) {
                return res.status(400).json({ success: false, error: 'Нужен account_id' });
            }
            const [existRows] = await db.query(
                'SELECT account_id, is_fund, custom_name FROM dg_finance_accounts WHERE bank = ? AND account_id = ? LIMIT 1',
                [bank, accountId]
            );
            if (!existRows || !existRows[0]) {
                return res.status(404).json({ success: false, error: 'Счёт не найден в снимке' });
            }
            const cur = existRows[0];
            let isFund = Number(cur.is_fund) === 1 ? 1 : 0;
            let customName = String(cur.custom_name || '');
            if (body.is_fund != null) {
                isFund = body.is_fund === true || body.is_fund === 1 || body.is_fund === '1' ? 1 : 0;
            }
            if (body.custom_name != null) {
                customName = String(body.custom_name).trim().slice(0, 120);
            }
            await db.query(
                'UPDATE dg_finance_accounts SET is_fund = ?, custom_name = ? WHERE bank = ? AND account_id = ?',
                [isFund, customName, bank, accountId]
            );
            const [rows] = await db.query(
                `SELECT bank, account_id, account_number, currency, name, status, account_type,
                        account_sub_type, customer_code, credential_id, org_label,
                        is_fund, custom_name,
                        balance, available, blocked, synced_at
                 FROM dg_finance_accounts
                 WHERE bank = ? AND account_id = ?
                 LIMIT 1`,
                [bank, accountId]
            );
            const account = rows && rows[0] ? rows[0] : null;
            if (account) account.is_fund = Number(account.is_fund) === 1;
            res.json({ success: true, account });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message || String(e) });
        }
    });

    /** Ручная пометка проводки: капитал / займ учредителей (не в графике). Синк не затирает. */
    router.post('/tx-meta', async (req, res) => {
        if (!requireFinanceAccess(req, res, true)) return;
        try {
            await ensureFinanceTables(db);
            const body = req.body || {};
            const bank = String(body.bank || 'tochka').trim().toLowerCase() || 'tochka';
            const txId = String(body.tx_id || '').trim();
            if (!txId) {
                return res.status(400).json({ success: false, error: 'Нужен tx_id' });
            }
            const [existRows] = await db.query(
                'SELECT bank, tx_id, purpose, exclude_chart, chart_tag FROM dg_finance_tx WHERE bank = ? AND tx_id = ? LIMIT 1',
                [bank, txId]
            );
            if (!existRows || !existRows[0]) {
                return res.status(404).json({ success: false, error: 'Проводка не найдена в снимке' });
            }
            const cur = existRows[0];
            let tag = normalizeChartTag(cur.chart_tag);
            if (!tag && Number(cur.exclude_chart) === 1) tag = 'founder';
            if (body.chart_tag != null) {
                tag = normalizeChartTag(body.chart_tag);
            } else if (body.exclude_chart != null) {
                const on =
                    body.exclude_chart === true ||
                    body.exclude_chart === 1 ||
                    body.exclude_chart === '1';
                tag = on ? tag || 'founder' : '';
            }
            const excludeChart = tag ? 1 : 0;
            await db.query('UPDATE dg_finance_tx SET exclude_chart = ?, chart_tag = ? WHERE bank = ? AND tx_id = ?', [
                excludeChart,
                tag,
                bank,
                txId,
            ]);
            const flags = txChartFlags({ purpose: cur.purpose, exclude_chart: excludeChart, chart_tag: tag });
            res.json({
                success: true,
                tx: {
                    bank,
                    tx_id: txId,
                    chart_tag: flags.chart_tag,
                    exclude_chart: excludeChart === 1,
                    founder_capital: flags.founder_capital,
                    dividend_payout: flags.dividend_payout,
                    chart_excluded: flags.chart_excluded,
                    chart_exclude_reason: flags.chart_exclude_reason,
                },
            });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message || String(e) });
        }
    });

    router.get('/transactions', async (req, res) => {
        if (!requireFinanceAccess(req, res, false)) return;
        try {
            await ensureFinanceTables(db);
            const search = String(req.query.search || '').trim();
            const direction = String(req.query.direction || '').trim().toLowerCase();
            const accountId = String(req.query.account_id || '').trim();
            const customerCodes = parseCustomerCodes(req.query);
            const dateFrom = String(req.query.date_from || '').trim();
            const dateTo = String(req.query.date_to || '').trim();
            const includeInternal = truthyQueryFlag(
                req.query.include_internal != null ? req.query.include_internal : req.query.include_deposits
            );
            const page = Math.max(1, parseInt(String(req.query.page || '1'), 10) || 1);
            const pageSize = Math.min(200, Math.max(20, parseInt(String(req.query.page_size || '100'), 10) || 100));
            const orgAliases = await finCred.loadOrgAliases(db, appSettings);
            const bankFilter = String(req.query.bank || '').trim().toLowerCase();
            const where = [];
            const params = [];
            if (bankFilter === 'tochka' || bankFilter === 'raiffeisen' || bankFilter === 'tbank') {
                where.push('t.bank = ?');
                params.push(bankFilter);
            }
            if (accountId) {
                where.push('t.account_id = ?');
                params.push(accountId);
            }
            sqlCustomerCodeIn('a', customerCodes, where, params);
            if (direction === 'in' || direction === 'out') {
                where.push('t.direction = ?');
                params.push(direction);
            }
            if (/^\d{4}-\d{2}-\d{2}$/.test(dateFrom)) {
                where.push('t.booked_date >= ?');
                params.push(dateFrom);
            }
            if (/^\d{4}-\d{2}-\d{2}$/.test(dateTo)) {
                where.push('t.booked_date <= ?');
                params.push(dateTo);
            }
            const founderOnly = truthyQueryFlag(
                req.query.founder_capital != null ? req.query.founder_capital : req.query.founder_only
            );
            const dividendOnly = truthyQueryFlag(
                req.query.dividend != null ? req.query.dividend : req.query.dividend_only
            );
            if (!includeInternal && !dividendOnly) {
                where.push(sqlExcludeInternalTransfers('t'));
            }
            if (founderOnly && dividendOnly) {
                where.push(
                    "((t.exclude_chart = 1 AND IFNULL(t.chart_tag,'') IN ('','founder')) OR t.chart_tag = 'dividend' OR t.purpose LIKE '%Выплата дивидендов%')"
                );
            } else if (founderOnly) {
                where.push("(t.exclude_chart = 1 AND IFNULL(t.chart_tag,'') IN ('','founder'))");
            } else if (dividendOnly) {
                where.push("(t.chart_tag = 'dividend' OR t.purpose LIKE '%Выплата дивидендов%')");
            }
            if (search) {
                const like = '%' + search.replace(/[%_]/g, '\\$&') + '%';
                const aliasCodes = Object.keys(orgAliases || {}).filter(function (code) {
                    const entry = orgAliases[code];
                    const full = finCred.orgAliasFull(entry, '');
                    const short = finCred.orgAliasShort(entry, '');
                    const q = String(search).toLowerCase();
                    return (
                        (full && full.toLowerCase().includes(q)) ||
                        (short && short.toLowerCase().includes(q))
                    );
                });
                if (aliasCodes.length) {
                    const ph = aliasCodes.map(function () { return '?'; }).join(',');
                    where.push(
                        `(t.purpose LIKE ? OR t.counterparty LIKE ? OR t.counterparty_inn LIKE ? OR t.document_number LIKE ? OR t.tx_id LIKE ? OR a.account_number LIKE ? OR a.org_label LIKE ? OR a.custom_name LIKE ? OR a.customer_code IN (${ph}))`
                    );
                    params.push(like, like, like, like, like, like, like, like);
                    aliasCodes.forEach(function (c) { params.push(c); });
                } else {
                    where.push(
                        '(t.purpose LIKE ? OR t.counterparty LIKE ? OR t.counterparty_inn LIKE ? OR t.document_number LIKE ? OR t.tx_id LIKE ? OR a.account_number LIKE ? OR a.org_label LIKE ? OR a.custom_name LIKE ?)'
                    );
                    params.push(like, like, like, like, like, like, like, like);
                }
            }
            const whereSql = where.length ? where.join(' AND ') : '1=1';
            const [cntRows] = await db.query(
                `SELECT COUNT(*) AS n
                 FROM dg_finance_tx t
                 LEFT JOIN dg_finance_accounts a ON a.bank = t.bank AND a.account_id = t.account_id
                 WHERE ${whereSql}`,
                params
            );
            const total = Number((cntRows && cntRows[0] && cntRows[0].n) || 0);
            const offset = (page - 1) * pageSize;
            const [rows] = await db.query(
                `SELECT t.bank, t.tx_id, t.account_id, t.booked_at,
                        DATE_FORMAT(t.booked_date, '%Y-%m-%d') AS booked_date,
                        t.amount, t.amount_abs,
                        t.direction, t.currency, t.purpose, t.counterparty, t.counterparty_inn, t.document_number,
                        t.exclude_chart, t.chart_tag,
                        a.account_number,
                        COALESCE(NULLIF(a.custom_name, ''), a.name) AS account_name,
                        a.customer_code, a.org_label, a.is_fund, a.custom_name
                 FROM dg_finance_tx t
                 LEFT JOIN dg_finance_accounts a ON a.bank = t.bank AND a.account_id = t.account_id
                 WHERE ${whereSql}
                 ORDER BY t.booked_date DESC, t.booked_at DESC, t.tx_id DESC
                 LIMIT ? OFFSET ?`,
                params.concat([pageSize, offset])
            );
            const enriched = (rows || []).map(function (r) {
                const code = String(r.customer_code || '').trim();
                const entry = code && orgAliases ? orgAliases[code] : null;
                const bankLabel = String(r.org_label || '').trim();
                const flags = txChartFlags(r);
                return Object.assign({}, r, {
                    org: finCred.orgAliasFull(entry, bankLabel || code || ''),
                    org_short: finCred.orgAliasShort(entry, bankLabel || code || ''),
                    chart_tag: flags.chart_tag,
                    exclude_chart: Boolean(flags.chart_tag),
                    founder_capital: flags.founder_capital,
                    dividend_payout: flags.dividend_payout,
                    chart_excluded: flags.chart_excluded,
                    chart_exclude_reason: flags.chart_exclude_reason,
                });
            });
            const pages = Math.max(1, Math.ceil(total / pageSize));
            res.json({
                success: true,
                total,
                page,
                page_size: pageSize,
                pages,
                shown: enriched.length,
                include_internal: includeInternal,
                founder_capital: founderOnly,
                dividend: dividendOnly,
                rows: enriched,
            });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message || String(e) });
        }
    });

    /** Помесячная аналитика входящих/исходящих из снимка dg_finance_tx. */
    router.get('/analytics/monthly', async (req, res) => {
        if (!requireFinanceAccess(req, res, false)) return;
        try {
            await ensureFinanceTables(db);
            const months = Math.max(1, Math.min(36, parseInt(String(req.query.months || '12'), 10) || 12));
            const accountId = String(req.query.account_id || '').trim();
            const customerCodes = parseCustomerCodes(req.query);
            const currency = finCred.normalizeCurrency(req.query.currency || 'RUB');
            const includeDeposits = truthyQueryFlag(
                req.query.include_deposits != null ? req.query.include_deposits : req.query.include_internal
            );

            const end = new Date();
            const endYm = end.getFullYear() * 100 + (end.getMonth() + 1);
            const start = new Date(end.getFullYear(), end.getMonth() - (months - 1), 1);
            const startYmd = tochka.ymd(start);
            const endYmd = tochka.ymd(end);

            const where = ['t.booked_date IS NOT NULL', 't.booked_date >= ?', 't.booked_date <= ?', 't.currency = ?'];
            const params = [startYmd, endYmd, currency];
            if (accountId) {
                where.push('t.account_id = ?');
                params.push(accountId);
            }
            sqlCustomerCodeIn('a', customerCodes, where, params);
            if (!includeDeposits) {
                where.push(sqlExcludeInternalTransfers('t'));
            }
            where.push(sqlExcludeManualChartTags('t'));
            const whereSql = where.join(' AND ');
            const [rows] = await db.query(
                `SELECT DATE_FORMAT(t.booked_date, '%Y-%m') AS ym,
                        t.direction,
                        SUM(t.amount_abs) AS sum_abs,
                        COUNT(*) AS cnt
                 FROM dg_finance_tx t
                 LEFT JOIN dg_finance_accounts a ON a.bank = t.bank AND a.account_id = t.account_id
                 WHERE ${whereSql}
                 GROUP BY ym, t.direction
                 ORDER BY ym ASC`,
                params
            );

            const byYm = Object.create(null);
            (rows || []).forEach(function (r) {
                const ym = String(r.ym || '');
                if (!/^\d{4}-\d{2}$/.test(ym)) return;
                if (!byYm[ym]) byYm[ym] = { in: 0, out: 0, count_in: 0, count_out: 0 };
                const abs = Number(r.sum_abs) || 0;
                const cnt = Number(r.cnt) || 0;
                if (String(r.direction) === 'out') {
                    byYm[ym].out += abs;
                    byYm[ym].count_out += cnt;
                } else {
                    byYm[ym].in += abs;
                    byYm[ym].count_in += cnt;
                }
            });

            const series = [];
            let totIn = 0;
            let totOut = 0;
            let totCnt = 0;
            for (let i = 0; i < months; i++) {
                const d = new Date(start.getFullYear(), start.getMonth() + i, 1);
                const ym =
                    d.getFullYear() +
                    '-' +
                    String(d.getMonth() + 1).padStart(2, '0');
                const cell = byYm[ym] || { in: 0, out: 0, count_in: 0, count_out: 0 };
                const net = Math.round((cell.in - cell.out) * 100) / 100;
                totIn += cell.in;
                totOut += cell.out;
                totCnt += cell.count_in + cell.count_out;
                series.push({
                    month: ym,
                    in: Math.round(cell.in * 100) / 100,
                    out: Math.round(cell.out * 100) / 100,
                    net,
                    count_in: cell.count_in,
                    count_out: cell.count_out,
                });
            }

            res.json({
                success: true,
                months,
                currency,
                date_from: startYmd,
                date_to: endYmd,
                customer_codes: customerCodes,
                account_id: accountId || null,
                include_deposits: includeDeposits,
                series,
                totals: {
                    in: Math.round(totIn * 100) / 100,
                    out: Math.round(totOut * 100) / 100,
                    net: Math.round((totIn - totOut) * 100) / 100,
                    count: totCnt,
                },
                end_ym: endYm,
            });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message || String(e) });
        }
    });

    /** Топ контрагентов по входящим / исходящим (снимок dg_finance_tx). */
    router.get('/analytics/counterparties', async (req, res) => {
        if (!requireFinanceAccess(req, res, false)) return;
        try {
            await ensureFinanceTables(db);
            const limit = Math.max(3, Math.min(20, parseInt(String(req.query.limit || '8'), 10) || 8));
            const months = Math.max(1, Math.min(36, parseInt(String(req.query.months || '12'), 10) || 12));
            const accountId = String(req.query.account_id || '').trim();
            const customerCodes = parseCustomerCodes(req.query);
            const currency = finCred.normalizeCurrency(req.query.currency || 'RUB');
            const includeInternal = truthyQueryFlag(
                req.query.include_internal != null ? req.query.include_internal : req.query.include_deposits
            );
            let dateFrom = String(req.query.date_from || '').trim();
            let dateTo = String(req.query.date_to || '').trim();
            if (!/^\d{4}-\d{2}-\d{2}$/.test(dateFrom) || !/^\d{4}-\d{2}-\d{2}$/.test(dateTo)) {
                const end = new Date();
                const start = new Date(end.getFullYear(), end.getMonth() - (months - 1), 1);
                dateFrom = tochka.ymd(start);
                dateTo = tochka.ymd(end);
            }

            const where = [
                't.booked_date IS NOT NULL',
                't.booked_date >= ?',
                't.booked_date <= ?',
                't.currency = ?',
            ];
            const params = [dateFrom, dateTo, currency];
            if (accountId) {
                where.push('t.account_id = ?');
                params.push(accountId);
            }
            sqlCustomerCodeIn('a', customerCodes, where, params);
            if (!includeInternal) {
                where.push(sqlExcludeInternalTransfers('t'));
            }
            where.push(sqlExcludeManualChartTags('t'));
            const whereSql = where.join(' AND ');
            const [rows] = await db.query(
                `SELECT
                    CASE
                      WHEN TRIM(IFNULL(t.counterparty, '')) = '' THEN '(без названия)'
                      ELSE TRIM(t.counterparty)
                    END AS cp_name,
                    TRIM(IFNULL(t.counterparty_inn, '')) AS cp_inn,
                    t.direction,
                    SUM(t.amount_abs) AS sum_abs,
                    COUNT(*) AS cnt
                 FROM dg_finance_tx t
                 LEFT JOIN dg_finance_accounts a ON a.bank = t.bank AND a.account_id = t.account_id
                 WHERE ${whereSql}
                 GROUP BY
                   CASE
                     WHEN TRIM(IFNULL(t.counterparty, '')) = '' THEN '(без названия)'
                     ELSE TRIM(t.counterparty)
                   END,
                   TRIM(IFNULL(t.counterparty_inn, '')),
                   t.direction`,
                params
            );

            /** Предпочитаем «человеческое» полное имя, а не «ИНН …» / короткие варианты. */
            function preferCpName(current, candidate, currentCnt, candidateCnt) {
                const cur = String(current || '').trim();
                const cand = String(candidate || '').trim();
                if (!cand || cand === '(без названия)') return cur || cand;
                if (!cur || cur === '(без названия)') return cand;
                const curUgly = /^инн\s/i.test(cur);
                const candUgly = /^инн\s/i.test(cand);
                if (curUgly && !candUgly) return cand;
                if (!curUgly && candUgly) return cur;
                if (cand.length > cur.length + 5) return cand;
                if (cur.length > cand.length + 5) return cur;
                if ((candidateCnt || 0) > (currentCnt || 0)) return cand;
                return cur;
            }

            const inMap = Object.create(null);
            const outMap = Object.create(null);
            let totIn = 0;
            let totOut = 0;
            (rows || []).forEach(function (r) {
                const name = String(r.cp_name || '(без названия)');
                const inn = String(r.cp_inn || '').replace(/\s+/g, '');
                // Одно юрлицо = один ИНН; без ИНН — по имени (как раньше).
                const key = inn ? 'inn:' + inn : 'name:' + name.toLowerCase();
                const abs = Number(r.sum_abs) || 0;
                const cnt = Number(r.cnt) || 0;
                const bucket = String(r.direction) === 'out' ? outMap : inMap;
                if (!bucket[key]) {
                    bucket[key] = { name: name, inn: inn, amount: 0, count: 0, nameVotes: 0 };
                }
                bucket[key].name = preferCpName(bucket[key].name, name, bucket[key].nameVotes, cnt);
                bucket[key].nameVotes = Math.max(bucket[key].nameVotes || 0, cnt);
                if (inn) bucket[key].inn = inn;
                bucket[key].amount += abs;
                bucket[key].count += cnt;
                if (String(r.direction) === 'out') totOut += abs;
                else totIn += abs;
            });

            function topList(map, total) {
                return Object.keys(map)
                    .map(function (k) {
                        return map[k];
                    })
                    .sort(function (a, b) {
                        return b.amount - a.amount;
                    })
                    .slice(0, limit)
                    .map(function (row, idx) {
                        const amount = Math.round(row.amount * 100) / 100;
                        const share = total > 0 ? Math.round((row.amount / total) * 1000) / 10 : 0;
                        return {
                            rank: idx + 1,
                            name: row.name,
                            inn: row.inn || null,
                            amount: amount,
                            count: row.count,
                            share: share,
                        };
                    });
            }

            res.json({
                success: true,
                limit: limit,
                months: months,
                currency: currency,
                date_from: dateFrom,
                date_to: dateTo,
                customer_codes: customerCodes,
                account_id: accountId || null,
                include_internal: includeInternal,
                top_in: topList(inMap, totIn),
                top_out: topList(outMap, totOut),
                totals: {
                    in: Math.round(totIn * 100) / 100,
                    out: Math.round(totOut * 100) / 100,
                    counterparties_in: Object.keys(inMap).length,
                    counterparties_out: Object.keys(outMap).length,
                },
            });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message || String(e) });
        }
    });

    router.get('/sync-status', (req, res) => {
        if (!requireFinanceAccess(req, res, false)) return;
        res.json({ success: true, sync: getSyncState() });
    });

    router.post('/sync', async (req, res) => {
        if (!requireFinanceAccess(req, res, true)) return;
        const body = req.body || {};
        const days = Math.max(
            1,
            Math.min(MAX_TX_DAYS, Number(body.days != null ? body.days : DEFAULT_TX_DAYS))
        );
        const balancesOnly = Boolean(
            body.balances_only === true || body.balances_only === 1 || body.balances_only === '1'
        );
        const credentialId = String(body.credential_id || '').trim();
        const customerCodes = parseCustomerCodes(body);
        const accountId = String(body.account_id || '').trim();
        const dateFrom = String(body.date_from || '').trim();
        const dateTo = String(body.date_to || '').trim();
        const bank = String(body.bank || '').trim().toLowerCase();
        try {
            resolveStatementWindow({
                days,
                date_from: dateFrom,
                date_to: dateTo,
            });
        } catch (e) {
            return res.status(400).json({ success: false, error: e.message || String(e) });
        }
        if (syncJob.active) {
            return res.json({
                success: true,
                queued: false,
                started: false,
                skip_reason: 'already_running',
                sync: getSyncState(),
            });
        }
        syncJob = {
            active: true,
            message: 'Финансы: ставим обновление в очередь…',
            started_at: new Date().toISOString(),
            last_error: null,
            last_result: null,
        };
        setImmediate(() => {
            runFinanceAll(db, appSettings, {
                days,
                balances_only: balancesOnly,
                credential_id: credentialId || undefined,
                customer_codes: customerCodes.length ? customerCodes : undefined,
                account_id: accountId || undefined,
                date_from: dateFrom || undefined,
                date_to: dateTo || undefined,
                bank: bank || undefined,
                _claimed: true,
            }).catch((e) => {
                console.error('[finance][sync]', e && e.message ? e.message : e);
                syncJob.active = false;
                syncJob.last_error = e && e.message ? e.message : String(e);
                syncJob.message = syncJob.last_error;
            });
        });
        res.json({
            success: true,
            queued: true,
            started: true,
            days,
            date_from: dateFrom || null,
            date_to: dateTo || null,
            customer_codes: customerCodes,
            account_id: accountId || null,
            balances_only: balancesOnly,
            sync: getSyncState(),
            message: 'Обновление запущено в фоне',
        });
    });

    factory.triggerFinanceSync = (opts) => triggerFinanceSync(db, appSettings, opts);
    factory.getSyncState = getSyncState;
    factory.ensureFinanceTables = () => ensureFinanceTables(db);

    return router;
}

factory.triggerFinanceSyncFromSettings = async function triggerFinanceSyncFromSettings(db, appSettings, opts) {
    return runFinanceAll(db, appSettings, opts || {});
};
factory.getSyncState = getSyncState;

module.exports = factory;
