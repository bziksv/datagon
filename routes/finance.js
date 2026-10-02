/**
 * Финансы: несколько JWT Точки (по организациям), счета/балансы, проводки (только чтение).
 */
const express = require('express');
const tochka = require('../lib/datagonTochkaClient');
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
        ];
        for (const sql of alters) {
            try {
                await db.query(sql);
            } catch (e) {
                /* already exists */
            }
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
    const customerCodeFilter = String(opts.customer_code || '').trim();
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
    if (customerCodeFilter) {
        accounts = accounts.filter((a) => String(a.customer_code || '') === customerCodeFilter);
    }
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
        await db.query(
            `INSERT INTO dg_finance_accounts
                (bank, account_id, account_number, currency, name, status, account_type, account_sub_type, customer_code, credential_id, org_label, balance, available, blocked, synced_at)
             VALUES ('tochka', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
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
                acc.account_id,
                acc.account_number,
                acc.currency || bal.currency || 'RUB',
                displayName,
                acc.status,
                acc.account_type,
                acc.account_sub_type || '',
                acc.customer_code || '',
                cred.id,
                accountOrgLabel,
                bal.balance,
                bal.available,
                bal.blocked,
            ]
        );
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
                const bookedDate = parseBookedDate(tx.booked_at);
                await db.query(
                    `INSERT INTO dg_finance_tx
                        (bank, tx_id, account_id, booked_at, booked_date, amount, amount_abs, direction, currency, purpose, counterparty, counterparty_inn, document_number, synced_at)
                     VALUES ('tochka', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
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
                        String(tx.tx_id).slice(0, 160),
                        tx.account_id,
                        String(tx.booked_at || '').slice(0, 40),
                        bookedDate,
                        tx.amount,
                        tx.amount_abs,
                        tx.direction,
                        tx.currency,
                        tx.purpose,
                        String(tx.counterparty || '').slice(0, 512),
                        String(tx.counterparty_inn || '').slice(0, 32),
                        String(tx.document_number || '').slice(0, 64),
                    ]
                );
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
    if (syncJob.active && !(opts && opts._claimed)) {
        return { success: false, reason: 'already_running', message: syncJob.message || 'Уже идёт обновление' };
    }
    const allCreds = await finCred.loadCredentials(db, appSettings);
    let creds = finCred.enabledWithJwt(allCreds);
    if (opts && opts.credential_id) {
        creds = creds.filter((c) => c.id === String(opts.credential_id));
    }
    if (!creds.length) {
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
    const customerCode = String((opts && opts.customer_code) || '').trim();
    const accountId = String((opts && opts.account_id) || '').trim();
    const skipTx = Boolean(opts && opts.balances_only);
    const onProgress = typeof (opts && opts.onProgress) === 'function' ? opts.onProgress : () => {};
    const t0 = Date.now();
    const scopeBits = [];
    if (customerCode) scopeBits.push('орг ' + customerCode);
    if (accountId) scopeBits.push('счёт');
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
                    customer_code: customerCode || undefined,
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
            customer_code: customerCode || '',
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
    return runTochkaSync(db, appSettings, opts || {});
}

function factory(db, appSettings) {
    const router = express.Router();

    router.get('/config', async (req, res) => {
        if (!requireFinanceAccess(req, res, false)) return;
        try {
            const list = await finCred.loadCredentials(db, appSettings);
            const mode = pageMode(req);
            const pub = list.map(finCred.publicCredential);
            const configured = pub.some((c) => c.configured && c.enabled);
            res.json({
                success: true,
                configured,
                credentials: pub,
                // back-compat
                jwt_mask: pub[0] ? pub[0].jwt_mask : '',
                jwt_len: pub[0] ? pub[0].jwt_len : 0,
                can_write: mode === 'full',
                sync: getSyncState(),
            });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message || String(e) });
        }
    });

    router.post('/config', async (req, res) => {
        if (!requireFinanceAccess(req, res, true)) return;
        try {
            const body = req.body || {};
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

            const pub = list.map(finCred.publicCredential);
            res.json({
                success: true,
                configured: pub.some((c) => c.configured && c.enabled),
                credentials: pub,
                jwt_mask: pub[0] ? pub[0].jwt_mask : '',
                jwt_len: pub[0] ? pub[0].jwt_len : 0,
            });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message || String(e) });
        }
    });

    router.get('/probe', async (req, res) => {
        if (!requireFinanceAccess(req, res, true)) return;
        try {
            const list = await finCred.loadCredentials(db, appSettings);
            const credId = String(req.query.credential_id || '').trim();
            let creds = finCred.enabledWithJwt(list);
            if (credId) creds = list.filter((c) => c.id === credId && String(c.jwt || '').trim());
            if (!creds.length) {
                return res.status(400).json({ success: false, error: 'Нет JWT для проверки (добавьте организацию)' });
            }
            const results = [];
            let totalAccounts = 0;
            const consent_gaps_all = [];
            for (const cred of creds) {
                try {
                    const one = await probeOneCredential(cred);
                    results.push(one);
                    totalAccounts += one.count;
                    for (const g of one.consent_gaps || []) {
                        consent_gaps_all.push(Object.assign({ credential_id: cred.id, label: cred.label }, g));
                    }
                } catch (e) {
                    results.push({
                        credential_id: cred.id,
                        label: cred.label,
                        error: e.message || String(e),
                        count: 0,
                    });
                }
            }
            res.json({
                success: true,
                count: totalAccounts,
                credentials_probed: results.length,
                results,
                consent_gaps: consent_gaps_all,
                api_note:
                    'Можно хранить несколько JWT (по организациям). Один ключ тоже может покрывать несколько компаний, если при генерации отмечены права для каждой.',
                // back-compat flat fields from first ok result
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
                 WHERE bank = 'tochka'
                 ORDER BY is_fund ASC, available DESC, org_label ASC, account_number ASC, account_id ASC`
            );
            const subtypes = {};
            for (const a of rows || []) {
                const k = a.account_sub_type || 'Unknown';
                subtypes[k] = (subtypes[k] || 0) + 1;
                a.is_fund = Number(a.is_fund) === 1;
            }
            const org_aliases = await finCred.loadOrgAliases(db, appSettings);
            res.json({
                success: true,
                accounts: rows || [],
                account_sub_types: subtypes,
                org_aliases,
                can_write: pageMode(req) === 'full',
                api_note:
                    'Банк — в шапке организации (Точка). Фонд: клик по бейджу типа. Название — клик по тексту или карандашу.',
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

    router.get('/transactions', async (req, res) => {
        if (!requireFinanceAccess(req, res, false)) return;
        try {
            await ensureFinanceTables(db);
            const search = String(req.query.search || '').trim();
            const direction = String(req.query.direction || '').trim().toLowerCase();
            const accountId = String(req.query.account_id || '').trim();
            const customerCode = String(req.query.customer_code || req.query.org || '').trim();
            const dateFrom = String(req.query.date_from || '').trim();
            const dateTo = String(req.query.date_to || '').trim();
            const includeInternal = truthyQueryFlag(
                req.query.include_internal != null ? req.query.include_internal : req.query.include_deposits
            );
            const page = Math.max(1, parseInt(String(req.query.page || '1'), 10) || 1);
            const pageSize = Math.min(200, Math.max(20, parseInt(String(req.query.page_size || '100'), 10) || 100));
            const orgAliases = await finCred.loadOrgAliases(db, appSettings);
            const where = ['t.bank = ?'];
            const params = ['tochka'];
            if (accountId) {
                where.push('t.account_id = ?');
                params.push(accountId);
            }
            if (customerCode) {
                where.push('a.customer_code = ?');
                params.push(customerCode);
            }
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
            if (!includeInternal) {
                where.push(sqlExcludeInternalTransfers('t'));
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
            const whereSql = where.join(' AND ');
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
                const chartExcluded = isChartExcludedPurpose(r.purpose);
                return Object.assign({}, r, {
                    org: finCred.orgAliasFull(entry, bankLabel || code || ''),
                    org_short: finCred.orgAliasShort(entry, bankLabel || code || ''),
                    chart_excluded: chartExcluded,
                    chart_exclude_reason: chartExcluded ? chartExcludeReason(r.purpose) : null,
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
            const customerCode = String(req.query.customer_code || req.query.org || '').trim();
            const currency = String(req.query.currency || 'RUB').trim().toUpperCase() || 'RUB';
            const includeDeposits = truthyQueryFlag(
                req.query.include_deposits != null ? req.query.include_deposits : req.query.include_internal
            );

            const end = new Date();
            const endYm = end.getFullYear() * 100 + (end.getMonth() + 1);
            const start = new Date(end.getFullYear(), end.getMonth() - (months - 1), 1);
            const startYmd = tochka.ymd(start);
            const endYmd = tochka.ymd(end);

            const where = ['t.bank = ?', 't.booked_date IS NOT NULL', 't.booked_date >= ?', 't.booked_date <= ?', 't.currency = ?'];
            const params = ['tochka', startYmd, endYmd, currency];
            if (accountId) {
                where.push('t.account_id = ?');
                params.push(accountId);
            }
            if (customerCode) {
                where.push('a.customer_code = ?');
                params.push(customerCode);
            }
            if (!includeDeposits) {
                where.push(sqlExcludeInternalTransfers('t'));
            }
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
                customer_code: customerCode || null,
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
            const customerCode = String(req.query.customer_code || req.query.org || '').trim();
            const currency = String(req.query.currency || 'RUB').trim().toUpperCase() || 'RUB';
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
                't.bank = ?',
                't.booked_date IS NOT NULL',
                't.booked_date >= ?',
                't.booked_date <= ?',
                't.currency = ?',
            ];
            const params = ['tochka', dateFrom, dateTo, currency];
            if (accountId) {
                where.push('t.account_id = ?');
                params.push(accountId);
            }
            if (customerCode) {
                where.push('a.customer_code = ?');
                params.push(customerCode);
            }
            if (!includeInternal) {
                where.push(sqlExcludeInternalTransfers('t'));
            }
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

            const inMap = Object.create(null);
            const outMap = Object.create(null);
            let totIn = 0;
            let totOut = 0;
            (rows || []).forEach(function (r) {
                const name = String(r.cp_name || '(без названия)');
                const inn = String(r.cp_inn || '');
                const key = name + '\0' + inn;
                const abs = Number(r.sum_abs) || 0;
                const cnt = Number(r.cnt) || 0;
                const bucket = String(r.direction) === 'out' ? outMap : inMap;
                if (!bucket[key]) bucket[key] = { name: name, inn: inn, amount: 0, count: 0 };
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
                customer_code: customerCode || null,
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
        const customerCode = String(body.customer_code || body.org || '').trim();
        const accountId = String(body.account_id || '').trim();
        const dateFrom = String(body.date_from || '').trim();
        const dateTo = String(body.date_to || '').trim();
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
            runTochkaSync(db, appSettings, {
                days,
                balances_only: balancesOnly,
                credential_id: credentialId || undefined,
                customer_code: customerCode || undefined,
                account_id: accountId || undefined,
                date_from: dateFrom || undefined,
                date_to: dateTo || undefined,
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
            customer_code: customerCode || null,
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
    return runTochkaSync(db, appSettings, opts || {});
};
factory.getSyncState = getSyncState;

module.exports = factory;
