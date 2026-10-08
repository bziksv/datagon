/**
 * Финансы: JWT Точки, Open API Райффайзен и T‑API Т‑Банка (счета/балансы/проводки, только чтение).
 */
const express = require('express');
const tochka = require('../lib/datagonTochkaClient');
const raiff = require('../lib/datagonRaiffeisenClient');
const tbank = require('../lib/datagonTbankClient');
const finCred = require('../lib/datagonFinanceCredentials');
const finCash = require('../lib/datagonFinanceCash');
const finPlans = require('../lib/datagonFinancePlans');

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

/** Ошибки банка обязаны ломать «успех» и попадать в message (auto_sync_runs / стикер). */
function financeSyncOk(errors) {
    return !(errors && errors.length);
}

function formatFinanceErrorsSuffix(errors) {
    const list = Array.isArray(errors) ? errors.filter(Boolean) : [];
    if (!list.length) return '';
    const bits = list.slice(0, 5).map((er) => {
        const code = er && er.code != null ? String(er.code).trim() : '';
        const err = er && er.error != null ? String(er.error) : String(er);
        return (code ? code + ': ' : '') + err;
    });
    return (
        ' · ОШИБКИ ' +
        list.length +
        ': ' +
        bits.join('; ') +
        (list.length > 5 ? '…' : '')
    );
}

function withFinanceErrorsInMessage(base, errors) {
    const msg = String(base || '').trim() + formatFinanceErrorsSuffix(errors);
    return msg.length > 480 ? msg.slice(0, 477) + '…' : msg;
}

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
        await finCash.ensureCashTables(db);
        await finPlans.ensurePlanTables(db);
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

function analyticsDateWindow(req) {
    const dateFrom = parseYmd(req.query.date_from);
    const dateTo = parseYmd(req.query.date_to);
    if (dateFrom && dateTo && dateFrom <= dateTo) {
        const start = new Date(Number(dateFrom.slice(0, 4)), Number(dateFrom.slice(5, 7)) - 1, 1);
        const end = new Date(Number(dateTo.slice(0, 4)), Number(dateTo.slice(5, 7)) - 1, Number(dateTo.slice(8, 10)));
        return { start, end, startYmd: dateFrom, endYmd: dateTo };
    }
    const months = Math.max(1, Math.min(36, parseInt(String(req.query.months || '12'), 10) || 12));
    const end = new Date();
    const start = new Date(end.getFullYear(), end.getMonth() - (months - 1), 1);
    return { start, end, startYmd: tochka.ymd(start), endYmd: tochka.ymd(end) };
}

function monthKeysInclusive(start, end) {
    const keys = [];
    let y = start.getFullYear();
    let m = start.getMonth();
    const ey = end.getFullYear();
    const em = end.getMonth();
    while (y < ey || (y === ey && m <= em)) {
        keys.push(y + '-' + String(m + 1).padStart(2, '0'));
        m += 1;
        if (m > 11) {
            m = 0;
            y += 1;
        }
        if (keys.length >= 36) break;
    }
    return keys.length ? keys : [tochka.ymd(end).slice(0, 7)];
}

function prevMonthKey(ym) {
    const s = String(ym || '');
    const y = parseInt(s.slice(0, 4), 10);
    const m = parseInt(s.slice(5, 7), 10);
    if (!y || !m) return '';
    if (m === 1) return y - 1 + '-12';
    return y + '-' + String(m - 1).padStart(2, '0');
}

/**
 * Остаток «как Всего доступно» на конец месяца:
 * расчётные (снимок available + walkback по полной выписке) + оценка депозитов
 * (накопительно открытия − возвраты тела на конец месяца).
 * diff = изменение к предыдущему месяцу.
 */
async function loadAccountBalanceSeries(db, opts) {
    const currency = finCred.normalizeCurrency((opts && opts.currency) || 'RUB');
    const customerCodes = (opts && opts.customerCodes) || [];
    const accountId = String((opts && opts.accountId) || '').trim();
    const monthKeys = Array.isArray(opts && opts.monthKeys) ? opts.monthKeys.slice() : [];
    const empty = {
        balance_now: null,
        balance_start: null,
        balance_diff: null,
        accounts_now: null,
        deposits_now: null,
        balance_note:
            'Остаток = расчётные (снимок) + оценка депозитов; помесячно — реконструкция по полной выписке.',
        by_ym: Object.create(null),
    };
    if (!monthKeys.length) return empty;

    const accWhere = [];
    const accParams = [];
    if (currency === 'RUB') {
        accWhere.push("(UPPER(IFNULL(a.currency,'')) IN ('RUB','RUR','') OR a.currency IS NULL)");
    } else {
        accWhere.push('UPPER(IFNULL(a.currency,\'\')) = ?');
        accParams.push(currency);
    }
    if (accountId) {
        accWhere.push('a.account_id = ?');
        accParams.push(accountId);
    }
    sqlCustomerCodeIn('a', customerCodes, accWhere, accParams);
    const [balRows] = await db.query(
        `SELECT SUM(COALESCE(a.available, a.balance, 0)) AS s
           FROM dg_finance_accounts a
          WHERE ${accWhere.join(' AND ')}`,
        accParams
    );
    const accountsNow = Math.round((Number(balRows && balRows[0] && balRows[0].s) || 0) * 100) / 100;

    const firstYm = monthKeys[0];
    const startYmd = firstYm + '-01';
    const todayYmd = tochka.ymd(new Date());
    const now = new Date();
    const walkKeys = monthKeysInclusive(
        new Date(Number(firstYm.slice(0, 4)), Number(firstYm.slice(5, 7)) - 1, 1),
        now
    );
    const walkSet = new Set(walkKeys);
    monthKeys.forEach((ym) => walkSet.add(ym));
    const allKeys = Array.from(walkSet).sort();

    const txWhere = ['t.booked_date IS NOT NULL', 't.booked_date >= ?', 't.booked_date <= ?', 't.currency = ?'];
    const txParams = [startYmd, todayYmd, currency];
    if (accountId) {
        txWhere.push('t.account_id = ?');
        txParams.push(accountId);
    }
    sqlCustomerCodeIn('a', customerCodes, txWhere, txParams);
    const [netRows] = await db.query(
        `SELECT DATE_FORMAT(t.booked_date, '%Y-%m') AS ym,
                SUM(CASE WHEN t.direction = 'out' THEN -t.amount_abs ELSE t.amount_abs END) AS net
           FROM dg_finance_tx t
           LEFT JOIN dg_finance_accounts a ON a.bank = t.bank AND a.account_id = t.account_id
          WHERE ${txWhere.join(' AND ')}
          GROUP BY ym`,
        txParams
    );
    const netByYm = Object.create(null);
    (netRows || []).forEach((r) => {
        const ym = String(r.ym || '');
        if (/^\d{4}-\d{2}$/.test(ym)) netByYm[ym] = Number(r.net) || 0;
    });

    // Оценка депозитов: накопительно с начала истории (не только окно графика).
    const depWhere = ['t.booked_date IS NOT NULL', 't.currency = ?'];
    const depParams = [currency];
    if (accountId) {
        depWhere.push('t.account_id = ?');
        depParams.push(accountId);
    }
    sqlCustomerCodeIn('a', customerCodes, depWhere, depParams);
    depWhere.push(
        `(LOWER(IFNULL(t.purpose,'')) LIKE '%открытия депозита%' OR t.purpose LIKE '%Возврат средств по депозитной сделке%')`
    );
    const [depRows] = await db.query(
        `SELECT DATE_FORMAT(t.booked_date, '%Y-%m') AS ym,
                SUM(CASE
                      WHEN LOWER(IFNULL(t.purpose,'')) LIKE '%открытия депозита%'
                       AND t.direction IN ('out','Debit','debit')
                      THEN ABS(t.amount) ELSE 0 END) AS openings,
                SUM(CASE
                      WHEN t.purpose LIKE '%Возврат средств по депозитной сделке%'
                       AND t.direction IN ('in','Credit','credit')
                      THEN ABS(t.amount) ELSE 0 END) AS returns_body
           FROM dg_finance_tx t
           LEFT JOIN dg_finance_accounts a ON a.bank = t.bank AND a.account_id = t.account_id
          WHERE ${depWhere.join(' AND ')}
          GROUP BY ym
          ORDER BY ym ASC`,
        depParams
    );
    let cumOpen = 0;
    let cumRet = 0;
    const depByYm = Object.create(null);
    (depRows || []).forEach((r) => {
        const ym = String(r.ym || '');
        if (!/^\d{4}-\d{2}$/.test(ym)) return;
        cumOpen += Number(r.openings) || 0;
        cumRet += Number(r.returns_body) || 0;
        depByYm[ym] = Math.max(0, Math.round((cumOpen - cumRet) * 100) / 100);
    });
    // Проброс депозита на месяцы без движений телом.
    let lastDep = 0;
    const depSorted = Object.keys(depByYm).sort();
    if (depSorted.length) {
        const fillFrom = depSorted[0];
        const fillTo = allKeys.length ? allKeys[allKeys.length - 1] : depSorted[depSorted.length - 1];
        const fillKeys = monthKeysInclusive(
            new Date(Number(fillFrom.slice(0, 4)), Number(fillFrom.slice(5, 7)) - 1, 1),
            new Date(Number(fillTo.slice(0, 4)), Number(fillTo.slice(5, 7)) - 1, 28)
        );
        fillKeys.forEach((ym) => {
            if (depByYm[ym] != null) lastDep = depByYm[ym];
            else depByYm[ym] = lastDep;
        });
    }
    const depositsNow = depByYm[allKeys[allKeys.length - 1]] != null
        ? depByYm[allKeys[allKeys.length - 1]]
        : Math.max(0, Math.round((cumOpen - cumRet) * 100) / 100);

    // accounts_end[ym] = accountsNow − Σ net(m) for m > ym
    let after = 0;
    const accountsByYm = Object.create(null);
    for (let i = allKeys.length - 1; i >= 0; i--) {
        const ym = allKeys[i];
        accountsByYm[ym] = Math.round((accountsNow - after) * 100) / 100;
        after += Number(netByYm[ym]) || 0;
    }
    const accountsStart = Math.round((accountsNow - after) * 100) / 100;
    const depStartYm = prevMonthKey(firstYm);
    const depositsStart = depStartYm && depByYm[depStartYm] != null ? depByYm[depStartYm] : 0;

    const balanceByYm = Object.create(null);
    allKeys.forEach((ym) => {
        const acc = accountsByYm[ym] != null ? accountsByYm[ym] : 0;
        const dep = depByYm[ym] != null ? depByYm[ym] : 0;
        balanceByYm[ym] = Math.round((acc + dep) * 100) / 100;
    });

    const balanceNow = Math.round((accountsNow + depositsNow) * 100) / 100;
    const balanceStart = Math.round((accountsStart + depositsStart) * 100) / 100;
    const lastYm = monthKeys[monthKeys.length - 1];
    const lastBal = balanceByYm[lastYm] != null ? balanceByYm[lastYm] : balanceNow;
    const balanceDiff = Math.round((lastBal - balanceStart) * 100) / 100;

    return {
        balance_now: balanceNow,
        balance_start: balanceStart,
        balance_diff: balanceDiff,
        accounts_now: accountsNow,
        deposits_now: depositsNow,
        balance_note:
            'Остаток = расчётные (available, walkback по полной выписке) + оценка депозитов (открытия − возвраты тела). Совпадает с «Всего доступно». Разница — к предыдущему месяцу. Ранние месяцы могут уходить в минус, если в снимке нет входного остатка до первой выписки.',
        by_ym: balanceByYm,
        accounts_by_ym: accountsByYm,
        deposits_by_ym: depByYm,
        balance_start_ym: depStartYm || null,
    };
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

/** Личные расходные платежи на ИНН (не операционный оборот в графике). */
const FINANCE_CHART_EXCLUDE_OUT_INN = '362903774541';

function normalizeInnDigits(raw) {
    return String(raw || '').replace(/\D+/g, '');
}

function sqlExcludeOutgoingToInn(alias, inn) {
    const a = alias ? alias + '.' : '';
    const target = normalizeInnDigits(inn || FINANCE_CHART_EXCLUDE_OUT_INN);
    if (!target) return '1=1';
    // Сравниваем цифры ИНН без пробелов/дефисов; только исходящие.
    return `(${a}direction <> 'out' OR REPLACE(REPLACE(IFNULL(${a}counterparty_inn,''), ' ', ''), '-', '') <> ?)`;
}

/** Фильтр «ИНН контрагента»: только цифры, подстрока в нормализованном ИНН. */
function sqlFilterCounterpartyInn(alias, innDigits) {
    const a = alias ? alias + '.' : '';
    const digits = normalizeInnDigits(innDigits).slice(0, 12);
    if (!digits) return { sql: '1=1', params: [] };
    return {
        sql: `REPLACE(REPLACE(IFNULL(${a}counterparty_inn,''), ' ', ''), '-', '') LIKE ?`,
        params: ['%' + digits + '%'],
    };
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

/**
 * Оценка остатка «на депозитах» из выписки: сумма открытий − возвраты тела.
 * Проценты не входят (они остаются в доходе/графике). Не зависит от include_internal.
 */
async function loadDepositStockEstimate(db) {
    const [rows] = await db.query(
        `SELECT a.customer_code, a.org_label, t.bank, t.currency,
                SUM(CASE
                      WHEN LOWER(IFNULL(t.purpose,'')) LIKE '%открытия депозита%'
                       AND t.direction IN ('out','Debit','debit')
                      THEN ABS(t.amount) ELSE 0 END) AS openings,
                SUM(CASE
                      WHEN t.purpose LIKE '%Возврат средств по депозитной сделке%'
                       AND t.direction IN ('in','Credit','credit')
                      THEN ABS(t.amount) ELSE 0 END) AS returns_body
           FROM dg_finance_tx t
           LEFT JOIN dg_finance_accounts a
             ON a.bank = t.bank AND a.account_id = t.account_id
          WHERE LOWER(IFNULL(t.purpose,'')) LIKE '%открытия депозита%'
             OR t.purpose LIKE '%Возврат средств по депозитной сделке%'
          GROUP BY a.customer_code, a.org_label, t.bank, t.currency`
    );
    const items = [];
    const totalsMap = Object.create(null);
    for (const r of rows || []) {
        const openings = Number(r.openings) || 0;
        const returnsBody = Number(r.returns_body) || 0;
        const amount = Math.max(0, openings - returnsBody);
        const currency = finCred.normalizeCurrency(r.currency);
        const bank = String(r.bank || 'tochka').toLowerCase() || 'tochka';
        const customerCode = r.customer_code != null ? String(r.customer_code).trim() : '';
        items.push({
            customer_code: customerCode,
            org_label: String(r.org_label || '').trim(),
            bank,
            currency,
            openings: Math.round(openings * 100) / 100,
            returns_body: Math.round(returnsBody * 100) / 100,
            amount: Math.round(amount * 100) / 100,
        });
        if (amount > 0) {
            totalsMap[currency] = (totalsMap[currency] || 0) + amount;
        }
    }
    items.sort((a, b) => {
        if (b.amount !== a.amount) return b.amount - a.amount;
        return String(a.customer_code).localeCompare(String(b.customer_code), 'ru');
    });
    const totals = Object.keys(totalsMap)
        .sort((a, b) => (a === 'RUB' ? -1 : b === 'RUB' ? 1 : a.localeCompare(b)))
        .map((currency) => ({
            currency,
            amount: Math.round(totalsMap[currency] * 100) / 100,
        }));
    return {
        method: 'statement_openings_minus_returns',
        note:
            'Оценка остатка на депозитах: открытия − возвраты тела по назначению платежа. Проценты не входят. Не зависит от галки «внутренние».',
        items,
        totals,
    };
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
        const success = financeSyncOk(errors);
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
            message: withFinanceErrorsInMessage(
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
                errors
            ),
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
                const booked = txs
                    .map(function (t) {
                        return String((t && t.booked_at) || '').slice(0, 10);
                    })
                    .filter(function (d) {
                        return /^\d{4}-\d{2}-\d{2}$/.test(d);
                    })
                    .sort();
                syncJob.message =
                    'Райф · ' +
                    accountOrgLabel +
                    ': ' +
                    (acc.account_number || acc.account_id) +
                    ' запрос ' +
                    window.startYmd +
                    '…' +
                    window.endYmd +
                    (booked.length
                        ? ' → в ответе ' + booked[0] + '…' + booked[booked.length - 1] + ' (' + txs.length + ' оп.)'
                        : ' → операций 0');
                onProgress({ message: syncJob.message, account_id: acc.account_id });
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
        const success = financeSyncOk(errors);
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
            message: withFinanceErrorsInMessage(
                'Райф: ключей ' +
                    byCred.length +
                    ', счетов ' +
                    accountsOk +
                    ', проводок ' +
                    txUpserted +
                    ' · ' +
                    duration_sec +
                    ' с',
                errors
            ),
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
        const success = financeSyncOk(errors);
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
            message: withFinanceErrorsInMessage(
                'Т‑Банк: ключей ' +
                    byCred.length +
                    ', счетов ' +
                    accountsOk +
                    ', проводок ' +
                    txUpserted +
                    ' · ' +
                    duration_sec +
                    ' с',
                errors
            ),
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
        const success = financeSyncOk(errors);
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
            message: withFinanceErrorsInMessage(
                'Точка + Райф + Т‑Банк: ключей ' +
                    byCred.length +
                    ', счетов ' +
                    accounts +
                    ', проводок ' +
                    txUpserted +
                    ' · ' +
                    duration_sec +
                    ' с',
                errors
            ),
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
            const deposit_estimate = await loadDepositStockEstimate(db);
            res.json({
                success: true,
                accounts: rows || [],
                account_sub_types: subtypes,
                org_aliases,
                deposit_estimate,
                can_write: pageMode(req) === 'full',
                api_note:
                    'Банк — в шапке организации (Точка / Райффайзен / Т‑Банк). Фонд: галка при редактировании названия (карандаш) или клик по бейджу типа. «На депозитах» — оценка из выписки (открытия − возвраты тела), всегда в карточках и в «Всего».',
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

    function actorName(req) {
        const a = req.datagonActor || {};
        return String(a.username || a.login || '').slice(0, 64);
    }

    router.get('/cash/summary', async (req, res) => {
        if (!requireFinanceAccess(req, res, false)) return;
        try {
            await ensureFinanceTables(db);
            const win = analyticsDateWindow(req);
            const monthKeys = monthKeysInclusive(win.start, win.end);
            const customerCodes = parseCustomerCodes(req.query);
            const accountId = String(req.query.account_id || '').trim();
            const orgAliases = await finCred.loadOrgAliases(db, appSettings);
            const summary = await finCash.buildCashSummary(db, finCred, orgAliases, {
                dateFrom: win.startYmd,
                dateTo: win.endYmd,
                months: monthKeys,
                customerCodes,
                accountId,
                todayYmd: tochka.ymd(new Date()),
            });
            res.json({ success: true, ...summary });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message || String(e) });
        }
    });

    router.get('/cash/templates', async (req, res) => {
        if (!requireFinanceAccess(req, res, false)) return;
        try {
            await ensureFinanceTables(db);
            const [rows] = await db.query(
                `SELECT id, purpose, direction, day_of_month, amount_fix, amount_premium,
                        scope, customer_code, bank, account_id, include_chart, needs_review, active, plan_item_id,
                        DATE_FORMAT(valid_from, '%Y-%m-%d') AS valid_from,
                        DATE_FORMAT(valid_to, '%Y-%m-%d') AS valid_to,
                        created_by, created_at, updated_at
                 FROM dg_finance_cash_templates
                 ORDER BY active DESC, id DESC`
            );
            res.json({ success: true, rows: rows || [] });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message || String(e) });
        }
    });

    router.post('/cash/templates', async (req, res) => {
        if (!requireFinanceAccess(req, res, true)) return;
        try {
            await ensureFinanceTables(db);
            const body = req.body && typeof req.body === 'object' ? req.body : {};
            const purpose = String(body.purpose || '').trim().slice(0, 512);
            if (!purpose) return res.status(400).json({ success: false, error: 'Укажите назначение' });
            const direction = String(body.direction || 'out').toLowerCase() === 'in' ? 'in' : 'out';
            const day = finCash.clampDay(body.day_of_month);
            const amountFix = finCash.parseMoney(body.amount_fix);
            if (amountFix == null || amountFix < 0) {
                return res.status(400).json({ success: false, error: 'Укажите сумму фикса' });
            }
            const amountPremium = finCash.parseMoney(body.amount_premium);
            const sc = finCash.normalizeScope(body.scope, body.customer_code);
            if (sc.scope === 'org' && !sc.customer_code) {
                return res.status(400).json({ success: false, error: 'Для scope=org укажите организацию' });
            }
            const includeChart =
                body.include_chart === false || body.include_chart === 0 || body.include_chart === '0' ? 0 : 1;
            const needsReview =
                body.needs_review === true || body.needs_review === 1 || body.needs_review === '1' ? 1 : 0;
            const active = body.active === false || body.active === 0 || body.active === '0' ? 0 : 1;
            const validFrom = parseYmd(body.valid_from) || null;
            const validTo = parseYmd(body.valid_to) || null;
            const planItemId = Object.prototype.hasOwnProperty.call(body, 'plan_item_id')
                ? finPlans.parsePlanItemId(body.plan_item_id)
                : null;
            const [r] = await db.query(
                `INSERT INTO dg_finance_cash_templates
                    (purpose, direction, day_of_month, amount_fix, amount_premium, scope, customer_code,
                     bank, account_id, include_chart, needs_review, active, valid_from, valid_to, plan_item_id, created_by)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    purpose,
                    direction,
                    day,
                    amountFix,
                    amountPremium,
                    sc.scope,
                    sc.customer_code,
                    String(body.bank || '').slice(0, 32),
                    String(body.account_id || '').slice(0, 64),
                    includeChart,
                    needsReview,
                    active,
                    validFrom,
                    validTo,
                    planItemId,
                    actorName(req),
                ]
            );
            res.json({ success: true, id: r && r.insertId });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message || String(e) });
        }
    });

    router.patch('/cash/templates/:id', async (req, res) => {
        if (!requireFinanceAccess(req, res, true)) return;
        try {
            await ensureFinanceTables(db);
            const id = parseInt(String(req.params.id || ''), 10);
            if (!Number.isFinite(id) || id < 1) {
                return res.status(400).json({ success: false, error: 'Некорректный id' });
            }
            const [exist] = await db.query('SELECT id FROM dg_finance_cash_templates WHERE id = ? LIMIT 1', [id]);
            if (!exist || !exist[0]) return res.status(404).json({ success: false, error: 'Шаблон не найден' });
            const body = req.body && typeof req.body === 'object' ? req.body : {};
            const sets = [];
            const params = [];
            if (body.purpose != null) {
                sets.push('purpose = ?');
                params.push(String(body.purpose || '').trim().slice(0, 512));
            }
            if (body.direction != null) {
                sets.push('direction = ?');
                params.push(String(body.direction).toLowerCase() === 'in' ? 'in' : 'out');
            }
            if (body.day_of_month != null) {
                sets.push('day_of_month = ?');
                params.push(finCash.clampDay(body.day_of_month));
            }
            if (body.amount_fix != null) {
                const v = finCash.parseMoney(body.amount_fix);
                if (v == null || v < 0) return res.status(400).json({ success: false, error: 'Некорректный фикс' });
                sets.push('amount_fix = ?');
                params.push(v);
            }
            if (Object.prototype.hasOwnProperty.call(body, 'amount_premium')) {
                sets.push('amount_premium = ?');
                params.push(finCash.parseMoney(body.amount_premium));
            }
            if (body.scope != null || body.customer_code != null) {
                const sc = finCash.normalizeScope(body.scope, body.customer_code);
                sets.push('scope = ?', 'customer_code = ?');
                params.push(sc.scope, sc.customer_code);
            }
            if (body.bank != null) {
                sets.push('bank = ?');
                params.push(String(body.bank || '').slice(0, 32));
            }
            if (body.account_id != null) {
                sets.push('account_id = ?');
                params.push(String(body.account_id || '').slice(0, 64));
            }
            if (body.include_chart != null) {
                sets.push('include_chart = ?');
                params.push(
                    body.include_chart === false || body.include_chart === 0 || body.include_chart === '0' ? 0 : 1
                );
            }
            if (body.needs_review != null) {
                sets.push('needs_review = ?');
                params.push(
                    body.needs_review === true || body.needs_review === 1 || body.needs_review === '1' ? 1 : 0
                );
            }
            if (body.active != null) {
                sets.push('active = ?');
                params.push(body.active === false || body.active === 0 || body.active === '0' ? 0 : 1);
            }
            if (Object.prototype.hasOwnProperty.call(body, 'valid_from')) {
                sets.push('valid_from = ?');
                params.push(parseYmd(body.valid_from) || null);
            }
            if (Object.prototype.hasOwnProperty.call(body, 'valid_to')) {
                sets.push('valid_to = ?');
                params.push(parseYmd(body.valid_to) || null);
            }
            if (Object.prototype.hasOwnProperty.call(body, 'plan_item_id')) {
                sets.push('plan_item_id = ?');
                params.push(finPlans.parsePlanItemId(body.plan_item_id));
            }
            if (!sets.length) return res.status(400).json({ success: false, error: 'Нет полей для обновления' });
            params.push(id);
            await db.query(`UPDATE dg_finance_cash_templates SET ${sets.join(', ')} WHERE id = ?`, params);
            res.json({ success: true, id });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message || String(e) });
        }
    });

    router.delete('/cash/templates/:id', async (req, res) => {
        if (!requireFinanceAccess(req, res, true)) return;
        try {
            await ensureFinanceTables(db);
            const id = parseInt(String(req.params.id || ''), 10);
            if (!Number.isFinite(id) || id < 1) {
                return res.status(400).json({ success: false, error: 'Некорректный id' });
            }
            await db.query('DELETE FROM dg_finance_cash_overrides WHERE template_id = ?', [id]);
            const [r] = await db.query('DELETE FROM dg_finance_cash_templates WHERE id = ?', [id]);
            res.json({ success: true, deleted: Number(r && r.affectedRows) || 0 });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message || String(e) });
        }
    });

    router.put('/cash/templates/:id/months/:ym', async (req, res) => {
        if (!requireFinanceAccess(req, res, true)) return;
        try {
            await ensureFinanceTables(db);
            const id = parseInt(String(req.params.id || ''), 10);
            const ym = String(req.params.ym || '').trim();
            if (!Number.isFinite(id) || id < 1 || !/^\d{4}-\d{2}$/.test(ym)) {
                return res.status(400).json({ success: false, error: 'Некорректный id или месяц' });
            }
            const [exist] = await db.query('SELECT id FROM dg_finance_cash_templates WHERE id = ? LIMIT 1', [id]);
            if (!exist || !exist[0]) return res.status(404).json({ success: false, error: 'Шаблон не найден' });
            const body = req.body && typeof req.body === 'object' ? req.body : {};
            const [prevRows] = await db.query(
                'SELECT * FROM dg_finance_cash_overrides WHERE template_id = ? AND ym = ? LIMIT 1',
                [id, ym]
            );
            const prev = (prevRows && prevRows[0]) || null;
            let amountFix = prev ? prev.amount_fix : null;
            let amountPremium = prev ? prev.amount_premium : null;
            let purpose = prev ? prev.purpose : null;
            let includeChart = prev ? prev.include_chart : null;
            let skipped = prev ? Number(prev.skipped) || 0 : 0;
            let reviewConfirmed = prev ? Number(prev.review_confirmed) || 0 : 0;
            if (Object.prototype.hasOwnProperty.call(body, 'amount_fix')) {
                amountFix = finCash.parseMoney(body.amount_fix);
            }
            if (body.clear_premium === true || body.clear_premium === 1 || body.clear_premium === '1') {
                amountPremium = null;
            } else if (Object.prototype.hasOwnProperty.call(body, 'amount_premium')) {
                amountPremium = finCash.parseMoney(body.amount_premium);
            }
            if (Object.prototype.hasOwnProperty.call(body, 'purpose')) {
                purpose = String(body.purpose || '').trim().slice(0, 512);
            }
            if (body.include_chart != null) {
                includeChart =
                    body.include_chart === false || body.include_chart === 0 || body.include_chart === '0' ? 0 : 1;
            }
            if (body.skipped != null) {
                skipped = body.skipped === true || body.skipped === 1 || body.skipped === '1' ? 1 : 0;
            }
            if (body.review_confirmed != null) {
                reviewConfirmed =
                    body.review_confirmed === true ||
                    body.review_confirmed === 1 ||
                    body.review_confirmed === '1'
                        ? 1
                        : 0;
            }
            await db.query(
                `INSERT INTO dg_finance_cash_overrides
                    (template_id, ym, amount_fix, amount_premium, purpose, include_chart, skipped, review_confirmed)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE
                    amount_fix = VALUES(amount_fix),
                    amount_premium = VALUES(amount_premium),
                    purpose = VALUES(purpose),
                    include_chart = VALUES(include_chart),
                    skipped = VALUES(skipped),
                    review_confirmed = VALUES(review_confirmed)`,
                [id, ym, amountFix, amountPremium, purpose, includeChart, skipped, reviewConfirmed]
            );
            res.json({ success: true, template_id: id, ym, review_confirmed: reviewConfirmed });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message || String(e) });
        }
    });

    router.get('/cash/tx', async (req, res) => {
        if (!requireFinanceAccess(req, res, false)) return;
        try {
            await ensureFinanceTables(db);
            const dateFrom = parseYmd(req.query.date_from) || '2000-01-01';
            const dateTo = parseYmd(req.query.date_to) || '2099-12-31';
            const [rows] = await db.query(
                `SELECT id, DATE_FORMAT(booked_date, '%Y-%m-%d') AS booked_date,
                        direction, amount, purpose, counterparty, scope, customer_code,
                        bank, account_id, include_chart, plan_item_id, created_by, created_at, updated_at
                 FROM dg_finance_cash_tx
                 WHERE booked_date >= ? AND booked_date <= ?
                 ORDER BY booked_date DESC, id DESC
                 LIMIT 500`,
                [dateFrom, dateTo]
            );
            res.json({ success: true, rows: rows || [] });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message || String(e) });
        }
    });

    router.post('/cash/tx', async (req, res) => {
        if (!requireFinanceAccess(req, res, true)) return;
        try {
            await ensureFinanceTables(db);
            const body = req.body && typeof req.body === 'object' ? req.body : {};
            const booked = parseYmd(body.booked_date);
            if (!booked) return res.status(400).json({ success: false, error: 'Укажите дату' });
            const amount = finCash.parseMoney(body.amount);
            if (amount == null || amount <= 0) {
                return res.status(400).json({ success: false, error: 'Укажите сумму > 0' });
            }
            const purpose = String(body.purpose || '').trim().slice(0, 512);
            if (!purpose) return res.status(400).json({ success: false, error: 'Укажите назначение' });
            const direction = String(body.direction || 'out').toLowerCase() === 'in' ? 'in' : 'out';
            const sc = finCash.normalizeScope(body.scope, body.customer_code);
            if (sc.scope === 'org' && !sc.customer_code) {
                return res.status(400).json({ success: false, error: 'Для scope=org укажите организацию' });
            }
            const includeChart =
                body.include_chart === false || body.include_chart === 0 || body.include_chart === '0' ? 0 : 1;
            const planItemId = Object.prototype.hasOwnProperty.call(body, 'plan_item_id')
                ? finPlans.parsePlanItemId(body.plan_item_id)
                : null;
            const [r] = await db.query(
                `INSERT INTO dg_finance_cash_tx
                    (booked_date, direction, amount, purpose, counterparty, scope, customer_code,
                     bank, account_id, include_chart, plan_item_id, created_by)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    booked,
                    direction,
                    amount,
                    purpose,
                    String(body.counterparty || '').trim().slice(0, 512),
                    sc.scope,
                    sc.customer_code,
                    String(body.bank || '').slice(0, 32),
                    String(body.account_id || '').slice(0, 64),
                    includeChart,
                    planItemId,
                    actorName(req),
                ]
            );
            res.json({ success: true, id: r && r.insertId });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message || String(e) });
        }
    });

    router.patch('/cash/tx/:id', async (req, res) => {
        if (!requireFinanceAccess(req, res, true)) return;
        try {
            await ensureFinanceTables(db);
            const id = parseInt(String(req.params.id || ''), 10);
            if (!Number.isFinite(id) || id < 1) {
                return res.status(400).json({ success: false, error: 'Некорректный id' });
            }
            const body = req.body && typeof req.body === 'object' ? req.body : {};
            const sets = [];
            const params = [];
            if (body.booked_date != null) {
                const d = parseYmd(body.booked_date);
                if (!d) return res.status(400).json({ success: false, error: 'Некорректная дата' });
                sets.push('booked_date = ?');
                params.push(d);
            }
            if (body.direction != null) {
                sets.push('direction = ?');
                params.push(String(body.direction).toLowerCase() === 'in' ? 'in' : 'out');
            }
            if (body.amount != null) {
                const a = finCash.parseMoney(body.amount);
                if (a == null || a <= 0) return res.status(400).json({ success: false, error: 'Некорректная сумма' });
                sets.push('amount = ?');
                params.push(a);
            }
            if (body.purpose != null) {
                sets.push('purpose = ?');
                params.push(String(body.purpose || '').trim().slice(0, 512));
            }
            if (body.counterparty != null) {
                sets.push('counterparty = ?');
                params.push(String(body.counterparty || '').trim().slice(0, 512));
            }
            if (body.scope != null || body.customer_code != null) {
                const sc = finCash.normalizeScope(body.scope, body.customer_code);
                sets.push('scope = ?', 'customer_code = ?');
                params.push(sc.scope, sc.customer_code);
            }
            if (body.include_chart != null) {
                sets.push('include_chart = ?');
                params.push(
                    body.include_chart === false || body.include_chart === 0 || body.include_chart === '0' ? 0 : 1
                );
            }
            if (Object.prototype.hasOwnProperty.call(body, 'plan_item_id')) {
                sets.push('plan_item_id = ?');
                params.push(finPlans.parsePlanItemId(body.plan_item_id));
            }
            if (!sets.length) return res.status(400).json({ success: false, error: 'Нет полей' });
            params.push(id);
            const [r] = await db.query(`UPDATE dg_finance_cash_tx SET ${sets.join(', ')} WHERE id = ?`, params);
            res.json({ success: true, updated: Number(r && r.affectedRows) || 0 });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message || String(e) });
        }
    });

    router.delete('/cash/tx/:id', async (req, res) => {
        if (!requireFinanceAccess(req, res, true)) return;
        try {
            await ensureFinanceTables(db);
            const id = parseInt(String(req.params.id || ''), 10);
            if (!Number.isFinite(id) || id < 1) {
                return res.status(400).json({ success: false, error: 'Некорректный id' });
            }
            const [r] = await db.query('DELETE FROM dg_finance_cash_tx WHERE id = ?', [id]);
            res.json({ success: true, deleted: Number(r && r.affectedRows) || 0 });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message || String(e) });
        }
    });

    router.get('/plans/categories', async (req, res) => {
        if (!requireFinanceAccess(req, res, false)) return;
        try {
            await ensureFinanceTables(db);
            const activeOnly =
                req.query.active === '1' ||
                req.query.active === 'true' ||
                String(req.query.active_only || '') === '1';
            const rows = await finPlans.listPlanCategories(db, { activeOnly });
            res.json({ success: true, rows });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message || String(e) });
        }
    });

    router.post('/plans/categories', async (req, res) => {
        if (!requireFinanceAccess(req, res, true)) return;
        try {
            await ensureFinanceTables(db);
            const body = req.body && typeof req.body === 'object' ? req.body : {};
            const title = String(body.title || '').trim().slice(0, 120);
            if (!title) return res.status(400).json({ success: false, error: 'Укажите название категории' });
            const [dup] = await db.query(
                'SELECT id FROM dg_finance_plan_categories WHERE LOWER(title) = LOWER(?) LIMIT 1',
                [title]
            );
            if (dup && dup[0]) {
                return res.json({ success: true, id: dup[0].id, existing: true });
            }
            const sortOrder = parseInt(String(body.sort_order != null ? body.sort_order : '0'), 10) || 0;
            const active = body.active === false || body.active === 0 || body.active === '0' ? 0 : 1;
            const [r] = await db.query(
                `INSERT INTO dg_finance_plan_categories (title, active, sort_order, created_by)
                 VALUES (?, ?, ?, ?)`,
                [title, active, sortOrder, actorName(req)]
            );
            res.json({ success: true, id: r && r.insertId });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message || String(e) });
        }
    });

    router.patch('/plans/categories/:id', async (req, res) => {
        if (!requireFinanceAccess(req, res, true)) return;
        try {
            await ensureFinanceTables(db);
            const id = parseInt(String(req.params.id || ''), 10);
            if (!Number.isFinite(id) || id < 1) {
                return res.status(400).json({ success: false, error: 'Некорректный id' });
            }
            const body = req.body && typeof req.body === 'object' ? req.body : {};
            const sets = [];
            const params = [];
            if (body.title != null) {
                const title = String(body.title || '').trim().slice(0, 120);
                if (!title) return res.status(400).json({ success: false, error: 'Пустое название' });
                sets.push('title = ?');
                params.push(title);
            }
            if (body.active != null) {
                sets.push('active = ?');
                params.push(body.active === false || body.active === 0 || body.active === '0' ? 0 : 1);
            }
            if (body.sort_order != null) {
                sets.push('sort_order = ?');
                params.push(parseInt(String(body.sort_order), 10) || 0);
            }
            if (!sets.length) return res.status(400).json({ success: false, error: 'Нет полей' });
            params.push(id);
            const [r] = await db.query(`UPDATE dg_finance_plan_categories SET ${sets.join(', ')} WHERE id = ?`, params);
            res.json({ success: true, updated: Number(r && r.affectedRows) || 0 });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message || String(e) });
        }
    });

    router.delete('/plans/categories/:id', async (req, res) => {
        if (!requireFinanceAccess(req, res, true)) return;
        try {
            await ensureFinanceTables(db);
            const id = parseInt(String(req.params.id || ''), 10);
            if (!Number.isFinite(id) || id < 1) {
                return res.status(400).json({ success: false, error: 'Некорректный id' });
            }
            await db.query('UPDATE dg_finance_plan_items SET category_id = NULL WHERE category_id = ?', [id]);
            const [r] = await db.query('DELETE FROM dg_finance_plan_categories WHERE id = ?', [id]);
            res.json({ success: true, deleted: Number(r && r.affectedRows) || 0 });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message || String(e) });
        }
    });

    router.get('/plans/items', async (req, res) => {
        if (!requireFinanceAccess(req, res, false)) return;
        try {
            await ensureFinanceTables(db);
            const activeOnly =
                req.query.active === '1' ||
                req.query.active === 'true' ||
                String(req.query.active_only || '') === '1';
            const rows = await finPlans.listPlanItems(db, { activeOnly });
            res.json({ success: true, rows });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message || String(e) });
        }
    });

    router.post('/plans/items', async (req, res) => {
        if (!requireFinanceAccess(req, res, true)) return;
        try {
            await ensureFinanceTables(db);
            const body = req.body && typeof req.body === 'object' ? req.body : {};
            const title = String(body.title || '').trim().slice(0, 255);
            if (!title) return res.status(400).json({ success: false, error: 'Укажите название статьи' });
            const paymentForm = finPlans.normalizePaymentForm(
                body.payment_form != null ? body.payment_form : body.pay_form
            );
            const cpsRaw =
                body.counterparties != null
                    ? body.counterparties
                    : body.inns != null
                      ? body.inns
                      : body.counterparty_inn != null
                        ? body.counterparty_inn
                        : body.inns_text;
            const counterparties = finPlans.parseCounterparties(cpsRaw);
            if (finPlans.paymentFormUsesBank(paymentForm) && !counterparties.length) {
                return res.status(400).json({
                    success: false,
                    error: 'Для безнала добавьте хотя бы одного контрагента с ИНН (10 или 12 цифр)',
                });
            }
            const direction = String(body.direction || 'out').toLowerCase() === 'in' ? 'in' : 'out';
            const amountPlan = finCash.parseMoney(body.amount_plan);
            if (amountPlan == null || amountPlan < 0) {
                return res.status(400).json({ success: false, error: 'Укажите плановую сумму ≥ 0' });
            }
            const sc = finCash.normalizeScope(body.scope, body.customer_code);
            if (sc.scope === 'org' && !sc.customer_code) {
                return res.status(400).json({ success: false, error: 'Для scope=org укажите организацию' });
            }
            const includeCash = finPlans.paymentFormUsesCash(paymentForm) ? 1 : 0;
            const active = body.active === false || body.active === 0 || body.active === '0' ? 0 : 1;
            const categoryId = Object.prototype.hasOwnProperty.call(body, 'category_id')
                ? finPlans.parseCategoryId(body.category_id)
                : null;
            if (categoryId) {
                const [cat] = await db.query(
                    'SELECT id FROM dg_finance_plan_categories WHERE id = ? LIMIT 1',
                    [categoryId]
                );
                if (!cat || !cat[0]) {
                    return res.status(400).json({ success: false, error: 'Категория не найдена' });
                }
            }
            const [r] = await db.query(
                `INSERT INTO dg_finance_plan_items
                    (title, counterparty_inn, category_id, direction, amount_plan, scope, customer_code,
                     include_cash, payment_form, active, created_by)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    title,
                    finPlans.innsDisplay(counterparties),
                    categoryId,
                    direction,
                    amountPlan,
                    sc.scope,
                    sc.customer_code,
                    includeCash,
                    paymentForm,
                    active,
                    actorName(req),
                ]
            );
            const id = r && r.insertId;
            if (id) await finPlans.replaceItemInns(db, id, counterparties);
            let cashLinks = { templates: [], once: [] };
            if (id) {
                const wantsCashLinks =
                    Object.prototype.hasOwnProperty.call(body, 'cash_template_ids') ||
                    Object.prototype.hasOwnProperty.call(body, 'cash_once_ids');
                if (wantsCashLinks || includeCash) {
                    cashLinks = await finPlans.syncPlanCashLinks(db, id, {
                        usesCash: !!includeCash,
                        templateIds: Object.prototype.hasOwnProperty.call(body, 'cash_template_ids')
                            ? body.cash_template_ids
                            : includeCash
                              ? []
                              : undefined,
                        onceIds: Object.prototype.hasOwnProperty.call(body, 'cash_once_ids')
                            ? body.cash_once_ids
                            : undefined,
                    });
                }
            }
            res.json({
                success: true,
                id,
                payment_form: paymentForm,
                counterparties,
                inns: counterparties.map((c) => c.inn),
                cash_template_ids: cashLinks.templates,
                cash_once_ids: cashLinks.once,
            });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message || String(e) });
        }
    });

    router.patch('/plans/items/:id', async (req, res) => {
        if (!requireFinanceAccess(req, res, true)) return;
        try {
            await ensureFinanceTables(db);
            const id = parseInt(String(req.params.id || ''), 10);
            if (!Number.isFinite(id) || id < 1) {
                return res.status(400).json({ success: false, error: 'Некорректный id' });
            }
            const [exist] = await db.query('SELECT id FROM dg_finance_plan_items WHERE id = ? LIMIT 1', [id]);
            if (!exist || !exist[0]) return res.status(404).json({ success: false, error: 'Статья не найдена' });
            const body = req.body && typeof req.body === 'object' ? req.body : {};
            const sets = [];
            const params = [];
            if (body.title != null) {
                const title = String(body.title || '').trim().slice(0, 255);
                if (!title) return res.status(400).json({ success: false, error: 'Пустое название' });
                sets.push('title = ?');
                params.push(title);
            }
            let cpsUpdated = null;
            let nextPaymentForm = null;
            if (body.payment_form != null || body.pay_form != null) {
                nextPaymentForm = finPlans.normalizePaymentForm(
                    body.payment_form != null ? body.payment_form : body.pay_form
                );
                sets.push('payment_form = ?', 'include_cash = ?');
                params.push(nextPaymentForm, finPlans.paymentFormUsesCash(nextPaymentForm) ? 1 : 0);
            }
            if (
                body.counterparties != null ||
                body.inns != null ||
                body.counterparty_inn != null ||
                body.inns_text != null
            ) {
                const cpsRaw =
                    body.counterparties != null
                        ? body.counterparties
                        : body.inns != null
                          ? body.inns
                          : body.counterparty_inn != null
                            ? body.counterparty_inn
                            : body.inns_text;
                const counterparties = finPlans.parseCounterparties(cpsRaw);
                let formForCheck = nextPaymentForm;
                if (!formForCheck) {
                    const [curRows] = await db.query(
                        'SELECT payment_form, include_cash FROM dg_finance_plan_items WHERE id = ? LIMIT 1',
                        [id]
                    );
                    formForCheck = finPlans.normalizePaymentForm(
                        curRows && curRows[0] && curRows[0].payment_form
                    );
                }
                if (finPlans.paymentFormUsesBank(formForCheck) && !counterparties.length) {
                    return res.status(400).json({
                        success: false,
                        error: 'Для безнала добавьте хотя бы одного контрагента с ИНН',
                    });
                }
                cpsUpdated = await finPlans.replaceItemInns(db, id, counterparties);
            }
            if (Object.prototype.hasOwnProperty.call(body, 'category_id')) {
                const categoryId = finPlans.parseCategoryId(body.category_id);
                if (categoryId) {
                    const [cat] = await db.query(
                        'SELECT id FROM dg_finance_plan_categories WHERE id = ? LIMIT 1',
                        [categoryId]
                    );
                    if (!cat || !cat[0]) {
                        return res.status(400).json({ success: false, error: 'Категория не найдена' });
                    }
                }
                sets.push('category_id = ?');
                params.push(categoryId);
            }
            if (body.direction != null) {
                sets.push('direction = ?');
                params.push(String(body.direction).toLowerCase() === 'in' ? 'in' : 'out');
            }
            if (body.amount_plan != null) {
                const v = finCash.parseMoney(body.amount_plan);
                if (v == null || v < 0) {
                    return res.status(400).json({ success: false, error: 'Некорректный план' });
                }
                sets.push('amount_plan = ?');
                params.push(v);
            }
            if (body.scope != null || body.customer_code != null) {
                const sc = finCash.normalizeScope(body.scope, body.customer_code);
                sets.push('scope = ?', 'customer_code = ?');
                params.push(sc.scope, sc.customer_code);
            }
            if (body.include_cash != null && body.payment_form == null && body.pay_form == null) {
                const wantCash =
                    body.include_cash === false || body.include_cash === 0 || body.include_cash === '0'
                        ? 0
                        : 1;
                sets.push('include_cash = ?');
                params.push(wantCash);
                const [curRows] = await db.query(
                    'SELECT payment_form FROM dg_finance_plan_items WHERE id = ? LIMIT 1',
                    [id]
                );
                const cur = finPlans.normalizePaymentForm(curRows && curRows[0] && curRows[0].payment_form);
                if (wantCash && cur === 'bank') {
                    sets.push('payment_form = ?');
                    params.push('both');
                } else if (!wantCash && cur === 'cash') {
                    sets.push('payment_form = ?');
                    params.push('bank');
                } else if (!wantCash && cur === 'both') {
                    sets.push('payment_form = ?');
                    params.push('bank');
                }
            }
            if (body.active != null) {
                sets.push('active = ?');
                params.push(body.active === false || body.active === 0 || body.active === '0' ? 0 : 1);
            }
            const wantsCashLinks =
                Object.prototype.hasOwnProperty.call(body, 'cash_template_ids') ||
                Object.prototype.hasOwnProperty.call(body, 'cash_once_ids') ||
                body.payment_form != null ||
                body.pay_form != null ||
                body.include_cash != null;
            if (!sets.length && !cpsUpdated && !wantsCashLinks) {
                return res.status(400).json({ success: false, error: 'Нет полей для обновления' });
            }
            if (sets.length) {
                params.push(id);
                await db.query(`UPDATE dg_finance_plan_items SET ${sets.join(', ')} WHERE id = ?`, params);
            }
            let cashLinks;
            if (wantsCashLinks) {
                const [curPay] = await db.query(
                    'SELECT payment_form, include_cash FROM dg_finance_plan_items WHERE id = ? LIMIT 1',
                    [id]
                );
                const payNow = finPlans.normalizePaymentForm(
                    curPay && curPay[0] && curPay[0].payment_form
                );
                const usesCash = finPlans.paymentFormUsesCash(payNow);
                cashLinks = await finPlans.syncPlanCashLinks(db, id, {
                    usesCash,
                    templateIds: Object.prototype.hasOwnProperty.call(body, 'cash_template_ids')
                        ? body.cash_template_ids
                        : usesCash
                          ? undefined
                          : [],
                    onceIds: Object.prototype.hasOwnProperty.call(body, 'cash_once_ids')
                        ? body.cash_once_ids
                        : usesCash
                          ? undefined
                          : [],
                });
            }
            res.json({
                success: true,
                id,
                counterparties: cpsUpdated || undefined,
                inns: cpsUpdated ? cpsUpdated.map((c) => c.inn) : undefined,
                cash_template_ids: cashLinks ? cashLinks.templates : undefined,
                cash_once_ids: cashLinks ? cashLinks.once : undefined,
            });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message || String(e) });
        }
    });

    router.delete('/plans/items/:id', async (req, res) => {
        if (!requireFinanceAccess(req, res, true)) return;
        try {
            await ensureFinanceTables(db);
            const id = parseInt(String(req.params.id || ''), 10);
            if (!Number.isFinite(id) || id < 1) {
                return res.status(400).json({ success: false, error: 'Некорректный id' });
            }
            await db.query('DELETE FROM dg_finance_plan_overrides WHERE item_id = ?', [id]);
            await db.query('DELETE FROM dg_finance_plan_item_inns WHERE item_id = ?', [id]);
            await db.query('UPDATE dg_finance_cash_tx SET plan_item_id = NULL WHERE plan_item_id = ?', [id]);
            await db.query('UPDATE dg_finance_cash_templates SET plan_item_id = NULL WHERE plan_item_id = ?', [id]);
            const [r] = await db.query('DELETE FROM dg_finance_plan_items WHERE id = ?', [id]);
            res.json({ success: true, deleted: Number(r && r.affectedRows) || 0 });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message || String(e) });
        }
    });

    router.put('/plans/items/:id/months/:ym', async (req, res) => {
        if (!requireFinanceAccess(req, res, true)) return;
        try {
            await ensureFinanceTables(db);
            const id = parseInt(String(req.params.id || ''), 10);
            const ym = String(req.params.ym || '').trim();
            if (!Number.isFinite(id) || id < 1 || !/^\d{4}-\d{2}$/.test(ym)) {
                return res.status(400).json({ success: false, error: 'Некорректный id или месяц' });
            }
            const [exist] = await db.query('SELECT id FROM dg_finance_plan_items WHERE id = ? LIMIT 1', [id]);
            if (!exist || !exist[0]) return res.status(404).json({ success: false, error: 'Статья не найдена' });
            const body = req.body && typeof req.body === 'object' ? req.body : {};
            const [prevRows] = await db.query(
                'SELECT * FROM dg_finance_plan_overrides WHERE item_id = ? AND ym = ? LIMIT 1',
                [id, ym]
            );
            const prev = (prevRows && prevRows[0]) || null;
            let amountPlan = prev ? prev.amount_plan : null;
            let skipped = prev ? Number(prev.skipped) || 0 : 0;
            if (Object.prototype.hasOwnProperty.call(body, 'amount_plan')) {
                if (body.amount_plan === null || body.amount_plan === '') {
                    amountPlan = null;
                } else {
                    amountPlan = finCash.parseMoney(body.amount_plan);
                    if (amountPlan == null || amountPlan < 0) {
                        return res.status(400).json({ success: false, error: 'Некорректный план' });
                    }
                }
            }
            if (body.skipped != null) {
                skipped = body.skipped === true || body.skipped === 1 || body.skipped === '1' ? 1 : 0;
            }
            await db.query(
                `INSERT INTO dg_finance_plan_overrides (item_id, ym, amount_plan, skipped)
                 VALUES (?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE
                    amount_plan = VALUES(amount_plan),
                    skipped = VALUES(skipped)`,
                [id, ym, amountPlan, skipped]
            );
            res.json({ success: true, item_id: id, ym });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message || String(e) });
        }
    });

    router.get('/plans/matrix', async (req, res) => {
        if (!requireFinanceAccess(req, res, false)) return;
        try {
            await ensureFinanceTables(db);
            const win = analyticsDateWindow(req);
            const customerCodes = parseCustomerCodes(req.query);
            const currency = finCred.normalizeCurrency(req.query.currency || 'RUB');
            const orgAliases = await finCred.loadOrgAliases(db, appSettings);
            const matrix = await finPlans.loadPlanMatrix(db, finCred, orgAliases, {
                dateFrom: win.startYmd,
                dateTo: win.endYmd,
                customerCodes,
                currency,
            });
            res.json({ success: true, ...matrix });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message || String(e) });
        }
    });

    router.get('/transactions', async (req, res) => {
        if (!requireFinanceAccess(req, res, false)) return;
        try {
            await ensureFinanceTables(db);
            const search = String(req.query.search || '').trim();
            const innFilter = normalizeInnDigits(
                req.query.inn != null ? req.query.inn : req.query.counterparty_inn
            ).slice(0, 12);
            const direction = String(req.query.direction || '').trim().toLowerCase();
            const accountId = String(req.query.account_id || '').trim();
            const customerCodes = parseCustomerCodes(req.query);
            const dateFrom = String(req.query.date_from || '').trim();
            const dateTo = String(req.query.date_to || '').trim();
            // months / date_* → одно окно; иначе cash templates разворачивались с 2000-01-01
            const cashWin = analyticsDateWindow(req);
            const includeInternal = truthyQueryFlag(
                req.query.include_internal != null ? req.query.include_internal : req.query.include_deposits
            );
            const page = Math.max(1, parseInt(String(req.query.page || '1'), 10) || 1);
            const pageSize = Math.min(200, Math.max(20, parseInt(String(req.query.page_size || '100'), 10) || 100));
            const orgAliases = await finCred.loadOrgAliases(db, appSettings);
            const bankFilter = String(req.query.bank || '').trim().toLowerCase();
            const source = finCash.parseSource(req.query.source);
            const founderOnly = truthyQueryFlag(
                req.query.founder_capital != null ? req.query.founder_capital : req.query.founder_only
            );
            const dividendOnly = truthyQueryFlag(
                req.query.dividend != null ? req.query.dividend : req.query.dividend_only
            );
            const sortKeyRaw = String(req.query.sort_by || req.query.sort || '')
                .trim()
                .toLowerCase();
            const sortDirRaw = String(req.query.sort_dir || '')
                .trim()
                .toLowerCase();
            const sortKey = sortKeyRaw || 'booked_date';
            const sortDir = sortDirRaw === 'asc' ? 'asc' : 'desc';

            let cashRows = [];
            // Наличные без ИНН контрагента — при фильтре по ИНН не подмешиваем.
            if (source !== 'bank' && !founderOnly && !dividendOnly && !innFilter) {
                cashRows = await finCash.loadExpandedCashRows(db, finCred, orgAliases, {
                    dateFrom: cashWin.startYmd,
                    dateTo: cashWin.endYmd,
                    customerCodes,
                    accountId,
                    search,
                    direction,
                    chartOnly: false,
                });
            }

            if (source === 'cash') {
                const sorted = finCash.sortCashLikeRows(cashRows, sortKey, sortDir);
                const total = sorted.length;
                const offset = (page - 1) * pageSize;
                const pageRows = sorted.slice(offset, offset + pageSize);
                const pages = Math.max(1, Math.ceil(total / pageSize));
                return res.json({
                    success: true,
                    total,
                    page,
                    page_size: pageSize,
                    pages,
                    shown: pageRows.length,
                    include_internal: includeInternal,
                    founder_capital: founderOnly,
                    dividend: dividendOnly,
                    inn: innFilter || null,
                    source,
                    sort_by: sortKey,
                    sort_dir: sortDir,
                    rows: pageRows,
                });
            }

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
            if (innFilter) {
                const innSql = sqlFilterCounterpartyInn('t', innFilter);
                where.push(innSql.sql);
                params.push(...innSql.params);
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
                    const ph = aliasCodes.map(function () {
                        return '?';
                    }).join(',');
                    where.push(
                        `(t.purpose LIKE ? OR t.counterparty LIKE ? OR t.counterparty_inn LIKE ? OR t.document_number LIKE ? OR t.tx_id LIKE ? OR a.account_number LIKE ? OR a.org_label LIKE ? OR a.custom_name LIKE ? OR a.customer_code IN (${ph}))`
                    );
                    params.push(like, like, like, like, like, like, like, like);
                    aliasCodes.forEach(function (c) {
                        params.push(c);
                    });
                } else {
                    where.push(
                        '(t.purpose LIKE ? OR t.counterparty LIKE ? OR t.counterparty_inn LIKE ? OR t.document_number LIKE ? OR t.tx_id LIKE ? OR a.account_number LIKE ? OR a.org_label LIKE ? OR a.custom_name LIKE ?)'
                    );
                    params.push(like, like, like, like, like, like, like, like);
                }
            }
            const whereSql = where.length ? where.join(' AND ') : '1=1';
            const TX_SORT_SQL = {
                booked_date: 't.booked_date',
                direction: 't.direction',
                amount: 't.amount_abs',
                founder: "IFNULL(NULLIF(t.chart_tag,''), IF(t.exclude_chart=1,'founder',''))",
                org: "COALESCE(NULLIF(a.custom_name,''), a.org_label, a.name)",
                bank: 't.bank',
                account_number: 'a.account_number',
                counterparty: 't.counterparty',
                counterparty_inn: 't.counterparty_inn',
                purpose: 't.purpose',
                document_number: 't.document_number',
                tx_id: 't.tx_id',
            };

            function mapBankRow(r) {
                const code = String(r.customer_code || '').trim();
                const entry = code && orgAliases ? orgAliases[code] : null;
                const bankLabel = String(r.org_label || '').trim();
                const flags = txChartFlags(r);
                return Object.assign({}, r, {
                    source: 'bank',
                    org: finCred.orgAliasFull(entry, bankLabel || code || ''),
                    org_short: finCred.orgAliasShort(entry, bankLabel || code || ''),
                    chart_tag: flags.chart_tag,
                    exclude_chart: Boolean(flags.chart_tag),
                    founder_capital: flags.founder_capital,
                    dividend_payout: flags.dividend_payout,
                    chart_excluded: flags.chart_excluded,
                    chart_exclude_reason: flags.chart_exclude_reason,
                });
            }

            if (source === 'bank' || !cashRows.length) {
                const [cntRows] = await db.query(
                    `SELECT COUNT(*) AS n
                     FROM dg_finance_tx t
                     LEFT JOIN dg_finance_accounts a ON a.bank = t.bank AND a.account_id = t.account_id
                     WHERE ${whereSql}`,
                    params
                );
                const total = Number((cntRows && cntRows[0] && cntRows[0].n) || 0) + (source === 'all' ? cashRows.length : 0);
                if (source === 'all' && cashRows.length) {
                    const sortCol = TX_SORT_SQL[sortKey] || TX_SORT_SQL.booked_date;
                    const orderSql =
                        `${sortCol} ${sortDir === 'asc' ? 'ASC' : 'DESC'}, t.booked_date DESC, t.booked_at DESC, t.tx_id DESC`;
                    const [bankAll] = await db.query(
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
                         ORDER BY ${orderSql}
                         LIMIT 50000`,
                        params
                    );
                    const merged = finCash.sortCashLikeRows(
                        (bankAll || []).map(mapBankRow).concat(cashRows),
                        sortKey,
                        sortDir
                    );
                    const offset = (page - 1) * pageSize;
                    const pageRows = merged.slice(offset, offset + pageSize);
                    const pages = Math.max(1, Math.ceil(merged.length / pageSize));
                    return res.json({
                        success: true,
                        total: merged.length,
                        page,
                        page_size: pageSize,
                        pages,
                        shown: pageRows.length,
                        include_internal: includeInternal,
                        founder_capital: founderOnly,
                        dividend: dividendOnly,
                        inn: innFilter || null,
                        source,
                        sort_by: sortKey,
                        sort_dir: sortDir,
                        rows: pageRows,
                    });
                }
                const offset = (page - 1) * pageSize;
                const sortCol = TX_SORT_SQL[sortKey] || TX_SORT_SQL.booked_date;
                const orderSql =
                    TX_SORT_SQL[sortKey]
                        ? `${sortCol} ${sortDir === 'asc' ? 'ASC' : 'DESC'}, t.booked_date DESC, t.booked_at DESC, t.tx_id DESC`
                        : 't.booked_date DESC, t.booked_at DESC, t.tx_id DESC';
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
                     ORDER BY ${orderSql}
                     LIMIT ? OFFSET ?`,
                    params.concat([pageSize, offset])
                );
                const enriched = (rows || []).map(mapBankRow);
                const pages = Math.max(1, Math.ceil(total / pageSize));
                return res.json({
                    success: true,
                    total,
                    page,
                    page_size: pageSize,
                    pages,
                    shown: enriched.length,
                    include_internal: includeInternal,
                    founder_capital: founderOnly,
                    dividend: dividendOnly,
                    inn: innFilter || null,
                    source,
                    sort_by: TX_SORT_SQL[sortKey] ? sortKey : 'booked_date',
                    sort_dir: sortDir,
                    rows: enriched,
                });
            }

            const sortColMerge = TX_SORT_SQL[sortKey] || TX_SORT_SQL.booked_date;
            const orderSqlMerge =
                `${sortColMerge} ${sortDir === 'asc' ? 'ASC' : 'DESC'}, t.booked_date DESC, t.booked_at DESC, t.tx_id DESC`;
            const [bankAll] = await db.query(
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
                 ORDER BY ${orderSqlMerge}
                 LIMIT 50000`,
                params
            );
            const merged = finCash.sortCashLikeRows(
                (bankAll || []).map(mapBankRow).concat(cashRows),
                sortKey,
                sortDir
            );
            const offset = (page - 1) * pageSize;
            const pageRows = merged.slice(offset, offset + pageSize);
            const pages = Math.max(1, Math.ceil(merged.length / pageSize));
            res.json({
                success: true,
                total: merged.length,
                page,
                page_size: pageSize,
                pages,
                shown: pageRows.length,
                include_internal: includeInternal,
                founder_capital: founderOnly,
                dividend: dividendOnly,
                inn: innFilter || null,
                source,
                sort_by: sortKey,
                sort_dir: sortDir,
                rows: pageRows,
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
            const win = analyticsDateWindow(req);
            const startYmd = win.startYmd;
            const endYmd = win.endYmd;
            const monthKeys = monthKeysInclusive(win.start, win.end);
            const months = monthKeys.length;
            const accountId = String(req.query.account_id || '').trim();
            const customerCodes = parseCustomerCodes(req.query);
            const currency = finCred.normalizeCurrency(req.query.currency || 'RUB');
            const includeDeposits = truthyQueryFlag(
                req.query.include_deposits != null ? req.query.include_deposits : req.query.include_internal
            );
            const source = finCash.parseSource(req.query.source);
            // По умолчанию исключаем личные исходящие на заданный ИНН из графика.
            const excludeChartInn =
                req.query.exclude_chart_inn == null
                    ? true
                    : truthyQueryFlag(req.query.exclude_chart_inn);

            const endYm = Number(String(endYmd).slice(0, 4)) * 100 + Number(String(endYmd).slice(5, 7));

            const byYm = Object.create(null);
            function addCell(ym, direction, abs, cnt) {
                if (!byYm[ym]) byYm[ym] = { in: 0, out: 0, count_in: 0, count_out: 0 };
                if (String(direction) === 'out') {
                    byYm[ym].out += abs;
                    byYm[ym].count_out += cnt;
                } else {
                    byYm[ym].in += abs;
                    byYm[ym].count_in += cnt;
                }
            }

            if (source !== 'cash') {
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
                if (excludeChartInn) {
                    where.push(sqlExcludeOutgoingToInn('t', FINANCE_CHART_EXCLUDE_OUT_INN));
                    params.push(FINANCE_CHART_EXCLUDE_OUT_INN);
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
                (rows || []).forEach(function (r) {
                    const ym = String(r.ym || '');
                    if (!/^\d{4}-\d{2}$/.test(ym)) return;
                    addCell(ym, r.direction, Number(r.sum_abs) || 0, Number(r.cnt) || 0);
                });
            }

            if (source !== 'bank') {
                const orgAliases = await finCred.loadOrgAliases(db, appSettings);
                const cashRows = await finCash.loadExpandedCashRows(db, finCred, orgAliases, {
                    dateFrom: startYmd,
                    dateTo: endYmd,
                    customerCodes,
                    accountId,
                    chartOnly: true,
                });
                const cashBy = finCash.aggregateCashByMonth(cashRows);
                Object.keys(cashBy).forEach(function (ym) {
                    const c = cashBy[ym];
                    addCell(ym, 'in', c.in, c.count_in);
                    addCell(ym, 'out', c.out, c.count_out);
                });
            }

            const series = [];
            let totIn = 0;
            let totOut = 0;
            let totCnt = 0;
            monthKeys.forEach(function (ym) {
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
            });

            let balanceMeta = {
                balance_now: null,
                balance_start: null,
                balance_diff: null,
                balance_note: null,
            };
            if (source !== 'cash') {
                const bal = await loadAccountBalanceSeries(db, {
                    monthKeys,
                    customerCodes,
                    accountId,
                    currency,
                });
                balanceMeta = {
                    balance_now: bal.balance_now,
                    balance_start: bal.balance_start,
                    balance_diff: bal.balance_diff,
                    accounts_now: bal.accounts_now,
                    deposits_now: bal.deposits_now,
                    balance_note: bal.balance_note,
                };
                let prevBal = bal.balance_start;
                series.forEach(function (row) {
                    const b =
                        bal.by_ym && bal.by_ym[row.month] != null
                            ? Math.round(Number(bal.by_ym[row.month]) * 100) / 100
                            : null;
                    const acc =
                        bal.accounts_by_ym && bal.accounts_by_ym[row.month] != null
                            ? Math.round(Number(bal.accounts_by_ym[row.month]) * 100) / 100
                            : null;
                    const dep =
                        bal.deposits_by_ym && bal.deposits_by_ym[row.month] != null
                            ? Math.round(Number(bal.deposits_by_ym[row.month]) * 100) / 100
                            : null;
                    row.balance = b;
                    row.balance_accounts = acc;
                    row.balance_deposits = dep;
                    row.diff =
                        b != null && prevBal != null
                            ? Math.round((b - prevBal) * 100) / 100
                            : null;
                    if (b != null) prevBal = b;
                });
            } else {
                series.forEach(function (row) {
                    row.balance = null;
                    row.balance_accounts = null;
                    row.balance_deposits = null;
                    row.diff = null;
                });
                balanceMeta.balance_note =
                    'Остаток на счетах недоступен при источнике «только наличные».';
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
                exclude_chart_inn: excludeChartInn,
                exclude_chart_inn_value: excludeChartInn ? FINANCE_CHART_EXCLUDE_OUT_INN : null,
                source,
                series,
                totals: {
                    in: Math.round(totIn * 100) / 100,
                    out: Math.round(totOut * 100) / 100,
                    net: Math.round((totIn - totOut) * 100) / 100,
                    count: totCnt,
                    balance: balanceMeta.balance_now,
                    balance_start: balanceMeta.balance_start,
                    balance_diff: balanceMeta.balance_diff,
                    balance_accounts: balanceMeta.accounts_now,
                    balance_deposits: balanceMeta.deposits_now,
                },
                balance_note: balanceMeta.balance_note,
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
            const accountId = String(req.query.account_id || '').trim();
            const customerCodes = parseCustomerCodes(req.query);
            const currency = finCred.normalizeCurrency(req.query.currency || 'RUB');
            const includeInternal = truthyQueryFlag(
                req.query.include_internal != null ? req.query.include_internal : req.query.include_deposits
            );
            const source = finCash.parseSource(req.query.source);
            const excludeChartInn =
                req.query.exclude_chart_inn == null
                    ? true
                    : truthyQueryFlag(req.query.exclude_chart_inn);
            const win = analyticsDateWindow(req);
            const dateFrom = win.startYmd;
            const dateTo = win.endYmd;

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

            function addCp(nameRaw, innRaw, direction, abs, cnt) {
                const name = String(nameRaw || '(без названия)');
                const inn = String(innRaw || '').replace(/\s+/g, '');
                if (
                    excludeChartInn &&
                    String(direction) === 'out' &&
                    normalizeInnDigits(inn) === FINANCE_CHART_EXCLUDE_OUT_INN
                ) {
                    return;
                }
                const key = inn ? 'inn:' + inn : 'name:' + name.toLowerCase();
                const bucket = String(direction) === 'out' ? outMap : inMap;
                if (!bucket[key]) {
                    bucket[key] = { name: name, inn: inn, amount: 0, count: 0, nameVotes: 0 };
                }
                bucket[key].name = preferCpName(bucket[key].name, name, bucket[key].nameVotes, cnt);
                bucket[key].nameVotes = Math.max(bucket[key].nameVotes || 0, cnt);
                if (inn) bucket[key].inn = inn;
                bucket[key].amount += abs;
                bucket[key].count += cnt;
                if (String(direction) === 'out') totOut += abs;
                else totIn += abs;
            }

            if (source !== 'cash') {
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
                if (excludeChartInn) {
                    where.push(sqlExcludeOutgoingToInn('t', FINANCE_CHART_EXCLUDE_OUT_INN));
                    params.push(FINANCE_CHART_EXCLUDE_OUT_INN);
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
                (rows || []).forEach(function (r) {
                    addCp(r.cp_name, r.cp_inn, r.direction, Number(r.sum_abs) || 0, Number(r.cnt) || 0);
                });
            }

            if (source !== 'bank') {
                const orgAliases = await finCred.loadOrgAliases(db, appSettings);
                const cashRows = await finCash.loadExpandedCashRows(db, finCred, orgAliases, {
                    dateFrom,
                    dateTo,
                    customerCodes,
                    accountId,
                    chartOnly: true,
                });
                finCash.aggregateCashCounterparties(cashRows).forEach(function (c) {
                    addCp(c.name, c.inn, c.direction, Number(c.amount) || 0, Number(c.count) || 0);
                });
            }

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
                currency: currency,
                date_from: dateFrom,
                date_to: dateTo,
                customer_codes: customerCodes,
                account_id: accountId || null,
                include_internal: includeInternal,
                exclude_chart_inn: excludeChartInn,
                exclude_chart_inn_value: excludeChartInn ? FINANCE_CHART_EXCLUDE_OUT_INN : null,
                source,
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
