/**
 * Клиент Точка.API: только чтение (счета, балансы, выписки).
 * JWT из кабинета «Интеграции и API». Платежи не вызываются.
 *
 * Open Banking 1.0: https://developers.tochka.com/docs/tochka-api/
 */

const axios = require('axios');

const TOCHKA_API_BASE = String(process.env.TOCHKA_API_BASE || 'https://enter.tochka.com/uapi').replace(/\/+$/, '');
const STATEMENT_POLL_MS = 1500;
const STATEMENT_POLL_MAX = 40;

function authHeaders(jwt) {
    const token = String(jwt || '').trim();
    if (!token) {
        const e = new Error('JWT Точки не задан');
        e.code = 'NO_JWT';
        throw e;
    }
    return {
        Authorization: 'Bearer ' + token,
        Accept: 'application/json',
        'Content-Type': 'application/json',
    };
}

function unwrapData(payload) {
    if (!payload || typeof payload !== 'object') return payload;
    if (payload.Data && typeof payload.Data === 'object') return payload.Data;
    if (payload.data && typeof payload.data === 'object') return payload.data;
    return payload;
}

async function tochkaRequest(jwt, method, path, body) {
    const url = path.startsWith('http') ? path : TOCHKA_API_BASE + path;
    try {
        const res = await axios({
            method,
            url,
            headers: authHeaders(jwt),
            data: body == null ? undefined : body,
            timeout: 60000,
            validateStatus: () => true,
        });
        const status = Number(res.status || 0);
        const data = res.data;
        if (status >= 200 && status < 300) return data;
        const msg =
            (data && (data.message || data.error || data.Error || data.errorMessage)) ||
            (typeof data === 'string' ? data.slice(0, 400) : '') ||
            ('HTTP ' + status);
        const e = new Error('Точка API: ' + String(msg).slice(0, 480));
        e.status = status;
        e.body = data;
        throw e;
    } catch (e) {
        if (e.status || e.code === 'NO_JWT') throw e;
        const wrap = new Error('Точка API: ' + (e.message || String(e)));
        wrap.cause = e;
        throw wrap;
    }
}

function asArray(v) {
    if (Array.isArray(v)) return v;
    if (v == null) return [];
    return [v];
}

function normalizeAccount(raw) {
    const a = raw && typeof raw === 'object' ? raw : {};
    const id = String(a.accountId || a.AccountId || a.id || '').trim();
    const ident = a.account || a.Account || a;
    const number = String(
        (ident && (ident.identification || ident.Identification || ident.accountNumber)) ||
            a.identification ||
            a.accountNumber ||
            a.number ||
            ''
    ).trim();
    return {
        account_id: id,
        account_number: number,
        currency: String(a.currency || a.Currency || (ident && ident.currency) || 'RUB').trim() || 'RUB',
        name: String(a.nickname || a.Nickname || a.name || a.accountName || a.customerCode || '').trim(),
        status: String(a.status || a.Status || '').trim(),
        account_type: String(a.accountType || a.AccountType || '').trim(),
        account_sub_type: String(a.accountSubType || a.AccountSubType || '').trim(),
        raw: a,
    };
}

function pickBalanceAmount(balances, typeWanted) {
    const list = asArray(balances);
    const wanted = String(typeWanted || '').toLowerCase();
    for (const b of list) {
        const t = String(b.type || b.Type || b.balanceType || '').toLowerCase();
        if (wanted && t !== wanted && t.replace(/\s+/g, '') !== wanted.replace(/\s+/g, '')) continue;
        const amt = b.amount || b.Amount || b;
        const n = Number(amt.amount != null ? amt.amount : amt.Amount != null ? amt.Amount : amt);
        if (Number.isFinite(n)) return n;
    }
    return null;
}

function normalizeBalancesPayload(payload) {
    const data = unwrapData(payload);
    const balances = asArray(data.Balance || data.balance || data.Balances || data.balances);
    const available = pickBalanceAmount(balances, 'ClosingAvailable');
    const expected = pickBalanceAmount(balances, 'Expected');
    const interim = pickBalanceAmount(balances, 'InterimAvailable');
    const closing = pickBalanceAmount(balances, 'ClosingBooked');
    return {
        available: available != null ? available : interim != null ? interim : closing,
        blocked: expected,
        balance: closing != null ? closing : available,
        currency: (() => {
            for (const b of balances) {
                const amt = b.amount || b.Amount || {};
                const c = amt.currency || amt.Currency || b.currency;
                if (c) return String(c);
            }
            return 'RUB';
        })(),
        raw_types: balances.map((b) => String(b.type || b.Type || '')),
    };
}

async function listAccounts(jwt) {
    const payload = await tochkaRequest(jwt, 'GET', '/open-banking/v1.0/accounts');
    const data = unwrapData(payload);
    const list = asArray(data.Account || data.account || data.Accounts || data.accounts);
    return list.map(normalizeAccount).filter((a) => a.account_id);
}

async function getAccountBalances(jwt, accountId) {
    const id = encodeURIComponent(String(accountId || '').trim());
    const payload = await tochkaRequest(jwt, 'GET', `/open-banking/v1.0/accounts/${id}/balances`);
    return normalizeBalancesPayload(payload);
}

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

function ymd(d) {
    const x = d instanceof Date ? d : new Date(d);
    const y = x.getFullYear();
    const m = String(x.getMonth() + 1).padStart(2, '0');
    const day = String(x.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

/**
 * Инициализация выписки + ожидание Ready.
 * Тело Init Statement: Data.Statement { accountId, startDateTime, endDateTime } (ISO date).
 */
async function fetchStatement(jwt, accountId, startDate, endDate) {
    const acc = String(accountId || '').trim();
    const start = ymd(startDate);
    const end = ymd(endDate);
    const initBody = {
        Data: {
            Statement: {
                accountId: acc,
                startDateTime: start,
                endDateTime: end,
            },
        },
    };
    const init = await tochkaRequest(jwt, 'POST', '/open-banking/v1.0/statements', initBody);
    const initData = unwrapData(init);
    const st0 = initData.Statement || initData.statement || initData;
    const statementId = String(st0.statementId || st0.StatementId || st0.id || '').trim();
    if (!statementId) {
        const e = new Error('Точка: Init Statement не вернул statementId');
        e.body = init;
        throw e;
    }
    const accEnc = encodeURIComponent(acc);
    const stEnc = encodeURIComponent(statementId);
    let last = init;
    for (let i = 0; i < STATEMENT_POLL_MAX; i++) {
        last = await tochkaRequest(
            jwt,
            'GET',
            `/open-banking/v1.0/accounts/${accEnc}/statements/${stEnc}`
        );
        const data = unwrapData(last);
        const st = data.Statement || data.statement || data;
        const status = String(st.status || st.Status || '').toLowerCase();
        if (status === 'ready' || status === 'completed' || asArray(st.Transaction || st.transaction).length) {
            return { statementId, status: status || 'ready', payload: last, statement: st };
        }
        if (status === 'error' || status === 'failed' || status === 'rejected') {
            throw new Error('Точка: выписка ' + statementId + ' статус ' + status);
        }
        await sleep(STATEMENT_POLL_MS);
    }
    throw new Error('Точка: выписка ' + statementId + ' не стала Ready за отведённое время');
}

function amountFromTx(t) {
    const amt = t.amount || t.Amount || t.transactionAmount || {};
    const n = Number(amt.amount != null ? amt.amount : amt.Amount != null ? amt.Amount : t.amount);
    return Number.isFinite(n) ? n : 0;
}

function creditDebit(t) {
    const cd = String(t.creditDebitIndicator || t.CreditDebitIndicator || t.direction || '').toLowerCase();
    if (cd === 'credit' || cd === 'in' || cd === 'incoming') return 'in';
    if (cd === 'debit' || cd === 'out' || cd === 'outgoing') return 'out';
    const n = amountFromTx(t);
    return n < 0 ? 'out' : 'in';
}

function partyName(t, dir) {
    const creditor = t.creditorAccount || t.CreditorAccount || t.Creditor || {};
    const debtor = t.debtorAccount || t.DebtorAccount || t.Debtor || {};
    const cName = t.creditorAgent || t.CreditorAgent || {};
    const dName = t.debtorAgent || t.DebtorAgent || {};
    if (dir === 'in') {
        return String(
            t.debtorName ||
                t.DebtorName ||
                debtor.name ||
                dName.name ||
                t.counterpartyName ||
                t.CounterpartyName ||
                ''
        ).trim();
    }
    return String(
        t.creditorName ||
            t.CreditorName ||
            creditor.name ||
            cName.name ||
            t.counterpartyName ||
            t.CounterpartyName ||
            ''
    ).trim();
}

function partyInn(t, dir) {
    const creditor = t.creditorAccount || t.CreditorAccount || {};
    const debtor = t.debtorAccount || t.DebtorAccount || {};
    if (dir === 'in') return String(t.debtorInn || t.DebtorInn || debtor.inn || debtor.taxId || '').trim();
    return String(t.creditorInn || t.CreditorInn || creditor.inn || creditor.taxId || '').trim();
}

function flattenTransactions(statement, accountId) {
    const st = statement && typeof statement === 'object' ? statement : {};
    const list = asArray(st.Transaction || st.transaction || st.Transactions || st.transactions);
    const out = [];
    for (const t of list) {
        const dir = creditDebit(t);
        const absAmt = Math.abs(amountFromTx(t));
        const txId = String(
            t.transactionId || t.TransactionId || t.id || t.documentNumber || t.DocumentNumber || ''
        ).trim();
        const booked = String(t.bookingDateTime || t.BookingDateTime || t.valueDateTime || t.ValueDateTime || '').slice(
            0,
            32
        );
        out.push({
            tx_id: txId || [accountId, booked, dir, absAmt].join(':'),
            account_id: String(accountId || st.accountId || '').trim(),
            booked_at: booked,
            amount: dir === 'out' ? -absAmt : absAmt,
            amount_abs: absAmt,
            direction: dir,
            currency: String((t.amount && t.amount.currency) || t.currency || 'RUB'),
            purpose: String(t.transactionInformation || t.TransactionInformation || t.description || t.purpose || '').trim(),
            counterparty: partyName(t, dir),
            counterparty_inn: partyInn(t, dir),
            document_number: String(t.documentNumber || t.DocumentNumber || t.paymentId || '').trim(),
        });
    }
    return out;
}

module.exports = {
    TOCHKA_API_BASE,
    listAccounts,
    getAccountBalances,
    fetchStatement,
    flattenTransactions,
    ymd,
};
