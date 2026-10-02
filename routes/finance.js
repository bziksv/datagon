/**
 * Финансы: JWT Точки, счета/балансы, проводки (только чтение).
 */
const express = require('express');
const tochka = require('../lib/datagonTochkaClient');

const JWT_KEY = 'finance_tochka_jwt';
const DEFAULT_TX_DAYS = 30;
const MAX_TX_DAYS = 90;

let tablesReady = null;
let syncJob = {
    active: false,
    message: '',
    started_at: null,
    last_error: null,
    last_result: null,
};

function maskSecret(raw) {
    const s = String(raw || '');
    if (!s) return '';
    if (s.length <= 8) return '•'.repeat(Math.min(s.length, 6)) + ' (' + s.length + ' симв.)';
    return s.slice(0, 4) + '…' + s.slice(-4) + ' (' + s.length + ' симв.)';
}

async function getSetting(db, key) {
    const [rows] = await db.query('SELECT setting_value FROM app_settings WHERE setting_key = ? LIMIT 1', [key]);
    if (!rows || !rows[0]) return '';
    return String(rows[0].setting_value || '');
}

async function setSetting(db, appSettings, key, value) {
    const v = String(value == null ? '' : value);
    await db.query(
        'INSERT INTO app_settings (setting_key, setting_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)',
        [key, v]
    );
    if (appSettings && typeof appSettings === 'object') appSettings[key] = v;
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
                balance DECIMAL(18,2) NULL,
                available DECIMAL(18,2) NULL,
                blocked DECIMAL(18,2) NULL,
                synced_at DATETIME NULL,
                updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                PRIMARY KEY (bank, account_id),
                KEY idx_fin_acc_synced (synced_at)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);
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

async function runTochkaSync(db, appSettings, opts) {
    await ensureFinanceTables(db);
    if (syncJob.active) {
        return { success: false, reason: 'already_running', message: syncJob.message || 'Уже идёт обновление' };
    }
    const jwt = String((appSettings && appSettings[JWT_KEY]) || (await getSetting(db, JWT_KEY)) || '').trim();
    if (!jwt) {
        return { success: false, reason: 'missing_jwt', message: 'Задайте JWT Точки в настройках на странице «Финансы»' };
    }
    const days = Math.max(1, Math.min(MAX_TX_DAYS, Number(opts && opts.days != null ? opts.days : DEFAULT_TX_DAYS)));
    const onProgress = typeof (opts && opts.onProgress) === 'function' ? opts.onProgress : () => {};
    const t0 = Date.now();
    syncJob = {
        active: true,
        message: 'Финансы: запрашиваем счета Точки…',
        started_at: new Date().toISOString(),
        last_error: null,
        last_result: null,
    };
    const errors = [];
    let accountsOk = 0;
    let txUpserted = 0;
    try {
        const accounts = await tochka.listAccounts(jwt);
        onProgress({ message: 'Счетов: ' + accounts.length, accounts: accounts.length });
        const end = new Date();
        const start = new Date();
        start.setDate(start.getDate() - (days - 1));
        const startYmd = tochka.ymd(start);
        const endYmd = tochka.ymd(end);

        for (const acc of accounts) {
            syncJob.message = 'Баланс ' + (acc.account_number || acc.account_id);
            onProgress({ message: syncJob.message, account_id: acc.account_id });
            let bal = { available: null, blocked: null, balance: null };
            try {
                bal = await tochka.getAccountBalances(jwt, acc.account_id);
            } catch (e) {
                errors.push({ code: acc.account_id, error: e.message || String(e) });
            }
            await db.query(
                `INSERT INTO dg_finance_accounts
                    (bank, account_id, account_number, currency, name, status, account_type, balance, available, blocked, synced_at)
                 VALUES ('tochka', ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
                 ON DUPLICATE KEY UPDATE
                    account_number = VALUES(account_number),
                    currency = VALUES(currency),
                    name = VALUES(name),
                    status = VALUES(status),
                    account_type = VALUES(account_type),
                    balance = VALUES(balance),
                    available = VALUES(available),
                    blocked = VALUES(blocked),
                    synced_at = VALUES(synced_at)`,
                [
                    acc.account_id,
                    acc.account_number,
                    acc.currency || bal.currency || 'RUB',
                    acc.name,
                    acc.status,
                    acc.account_type,
                    bal.balance,
                    bal.available,
                    bal.blocked,
                ]
            );
            accountsOk += 1;
            try {
                syncJob.message = 'Выписка ' + (acc.account_number || acc.account_id) + ' за ' + days + ' дн.';
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

        const duration_sec = Math.round((Date.now() - t0) / 1000);
        const success = accountsOk > 0 || errors.length === 0;
        const result = {
            success,
            dry_run: false,
            accounts: accountsOk,
            tx_upserted: txUpserted,
            errors: errors.slice(0, 20),
            duration_sec,
            days,
            message:
                'Счетов ' +
                accountsOk +
                ', проводок записано ' +
                txUpserted +
                (errors.length ? ', ошибок × ' + errors.length : ''),
        };
        syncJob.last_result = result;
        syncJob.last_error = success ? null : result.message;
        syncJob.message = result.message;
        return result;
    } catch (e) {
        const duration_sec = Math.round((Date.now() - t0) / 1000);
        const result = {
            success: false,
            accounts: accountsOk,
            tx_upserted: txUpserted,
            errors: [{ code: '-', error: e.message || String(e) }].concat(errors).slice(0, 20),
            duration_sec,
            message: e.message || String(e),
        };
        syncJob.last_result = result;
        syncJob.last_error = result.message;
        return result;
    } finally {
        syncJob.active = false;
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
            const jwt = await getSetting(db, JWT_KEY);
            const mode = pageMode(req);
            res.json({
                success: true,
                configured: Boolean(String(jwt).trim()),
                jwt_mask: maskSecret(jwt),
                jwt_len: String(jwt || '').length,
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
            const incoming = req.body && req.body.jwt != null ? String(req.body.jwt) : '';
            const trimmed = incoming.trim();
            if (trimmed) {
                await setSetting(db, appSettings, JWT_KEY, trimmed.slice(0, 8000));
            } else if (req.body && req.body.clear === true) {
                await setSetting(db, appSettings, JWT_KEY, '');
            } else {
                return res.status(400).json({ success: false, error: 'Передайте jwt или clear:true' });
            }
            const stored = await getSetting(db, JWT_KEY);
            res.json({
                success: true,
                configured: Boolean(String(stored).trim()),
                jwt_mask: maskSecret(stored),
                jwt_len: String(stored || '').length,
            });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message || String(e) });
        }
    });

    router.get('/probe', async (req, res) => {
        if (!requireFinanceAccess(req, res, true)) return;
        try {
            const jwt = await getSetting(db, JWT_KEY);
            if (!String(jwt).trim()) {
                return res.status(400).json({ success: false, error: 'JWT не задан' });
            }
            const accounts = await tochka.listAccounts(jwt);
            res.json({
                success: true,
                count: accounts.length,
                accounts: accounts.map((a) => ({
                    account_id: a.account_id,
                    account_number: a.account_number,
                    currency: a.currency,
                    name: a.name,
                })),
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
                        balance, available, blocked, synced_at
                 FROM dg_finance_accounts
                 WHERE bank = 'tochka'
                 ORDER BY account_number ASC, account_id ASC`
            );
            res.json({ success: true, accounts: rows || [] });
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
            const dateFrom = String(req.query.date_from || '').trim();
            const dateTo = String(req.query.date_to || '').trim();
            const page = Math.max(1, parseInt(String(req.query.page || '1'), 10) || 1);
            const pageSize = Math.min(200, Math.max(20, parseInt(String(req.query.page_size || '100'), 10) || 100));
            const where = ['t.bank = ?'];
            const params = ['tochka'];
            if (accountId) {
                where.push('t.account_id = ?');
                params.push(accountId);
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
            if (search) {
                const like = '%' + search.replace(/[%_]/g, '\\$&') + '%';
                where.push(
                    '(t.purpose LIKE ? OR t.counterparty LIKE ? OR t.counterparty_inn LIKE ? OR t.document_number LIKE ? OR t.tx_id LIKE ? OR a.account_number LIKE ?)'
                );
                params.push(like, like, like, like, like, like);
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
                `SELECT t.bank, t.tx_id, t.account_id, t.booked_at, t.booked_date, t.amount, t.amount_abs,
                        t.direction, t.currency, t.purpose, t.counterparty, t.counterparty_inn, t.document_number,
                        a.account_number, a.name AS account_name
                 FROM dg_finance_tx t
                 LEFT JOIN dg_finance_accounts a ON a.bank = t.bank AND a.account_id = t.account_id
                 WHERE ${whereSql}
                 ORDER BY t.booked_date DESC, t.booked_at DESC, t.tx_id DESC
                 LIMIT ? OFFSET ?`,
                params.concat([pageSize, offset])
            );
            const pages = Math.max(1, Math.ceil(total / pageSize));
            res.json({
                success: true,
                total,
                page,
                page_size: pageSize,
                pages,
                shown: (rows || []).length,
                rows: rows || [],
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
        const days = Math.max(1, Math.min(MAX_TX_DAYS, Number(req.body && req.body.days != null ? req.body.days : DEFAULT_TX_DAYS)));
        if (syncJob.active) {
            return res.json({
                success: true,
                queued: false,
                skip_reason: 'already_running',
                sync: getSyncState(),
            });
        }
        const result = await runTochkaSync(db, appSettings, { days });
        res.json(Object.assign({ queued: false }, result));
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
