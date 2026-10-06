/**
 * Клиент Open API Райффайзен Банка (только чтение: счета, остатки, выписки).
 * Токены: refresh_token → POST https://sso.rbo.raiffeisen.ru/token
 * API: https://api.openapi.raiffeisen.ru/api/v1/...
 * Заголовки: Authorization Bearer access_token + Id-Token.
 */

const axios = require('axios');

const RAIFF_API_BASE = String(process.env.RAIFFEISEN_API_BASE || 'https://api.openapi.raiffeisen.ru').replace(
    /\/+$/,
    ''
);
const RAIFF_TOKEN_URL = String(process.env.RAIFFEISEN_TOKEN_URL || 'https://sso.rbo.raiffeisen.ru/token');
const PAGE_SIZE = 100;
const ACCOUNT_FIELDS =
    'Id,Number,Name,OrganizationName,Currency,Balance,Available,Blocked,Status,Type,OrganizationInn,Inn';
const ACCOUNT_FIELDS_MIN = 'Id,Number,Name,OrganizationName,Currency';
const STATEMENT_FIELDS =
    'DocumentNumber,AccountNumber,Date,Currency,IncomeBalance,IncomeBalanceRur,CreditAmount,CreditAmountRur,CreditDocumentsCount,DebitAmount,DebitAmountRur,DebitDocumentsCount,OutcomeBalance,OutcomeBalanceRur,OrganizationName';
const TX_FIELDS =
    'ContractorInn,CreditDocument,Debet,Credit,DocumentNumber,Account,OrganizationName,Purpose,ValuationDate,ContractorName,OperationDate,OperationType,StatementDate,StatementType,Avisetype,ContractorAccount,ContractorBankName,AccountCurrency,Uip';

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function ymd(d) {
    const x = d instanceof Date ? d : new Date(d);
    const y = x.getFullYear();
    const m = String(x.getMonth() + 1).padStart(2, '0');
    const day = String(x.getDate()).padStart(2, '0');
    return y + '-' + m + '-' + day;
}

function parseYmdLoose(v) {
    const s = String(v == null ? '' : v).trim();
    if (!s) return '';
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
    const m = s.match(/^(\d{2})\.(\d{2})\.(\d{4})/);
    if (m) return m[3] + '-' + m[2] + '-' + m[1];
    return '';
}

function eachYmd(startYmd, endYmd) {
    const out = [];
    const start = new Date(startYmd + 'T12:00:00');
    const end = new Date(endYmd + 'T12:00:00');
    if (!(start instanceof Date) || Number.isNaN(start.getTime())) return out;
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
        out.push(ymd(d));
    }
    return out;
}

function pickStr(obj, keys) {
    if (!obj || typeof obj !== 'object') return '';
    for (const k of keys) {
        if (obj[k] != null && String(obj[k]).trim()) return String(obj[k]).trim();
        const low = k.charAt(0).toLowerCase() + k.slice(1);
        if (obj[low] != null && String(obj[low]).trim()) return String(obj[low]).trim();
    }
    return '';
}

function pickNum(obj, keys) {
    if (obj == null) return null;
    if (typeof obj === 'number' && Number.isFinite(obj)) return obj;
    if (typeof obj === 'string' && obj.trim() && Number.isFinite(Number(obj.replace(',', '.')))) {
        return Number(obj.replace(',', '.'));
    }
    if (typeof obj === 'object') {
        if (obj.amount != null) return pickNum(obj.amount, keys);
        if (obj.value != null) return pickNum(obj.value, keys);
        for (const k of keys) {
            if (obj[k] != null) {
                const n = pickNum(obj[k], keys);
                if (n != null) return n;
            }
        }
    }
    return null;
}

function asArray(v) {
    if (Array.isArray(v)) return v;
    if (v == null) return [];
    if (typeof v === 'object') {
        if (Array.isArray(v.content)) return v.content;
        if (Array.isArray(v.items)) return v.items;
        if (Array.isArray(v.data)) return v.data;
        if (Array.isArray(v.accounts)) return v.accounts;
        if (Array.isArray(v.transactions)) return v.transactions;
        if (Array.isArray(v.statements)) return v.statements;
    }
    return [v];
}

function pageMeta(payload) {
    if (!payload || typeof payload !== 'object') return { number: 0, totalPages: 1 };
    const p = payload.page && typeof payload.page === 'object' ? payload.page : payload;
    const number = Number(p.number != null ? p.number : p.page != null ? p.page : 0) || 0;
    const totalPages = Number(p.totalPages != null ? p.totalPages : p.total_pages != null ? p.total_pages : 1) || 1;
    return { number, totalPages: Math.max(1, totalPages) };
}

function orgSlug(name) {
    const s = String(name || '')
        .trim()
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .slice(0, 80);
    return s || 'raiffeisen';
}

function customerCodeFromOrg(name, inn) {
    const innS = String(inn || '').replace(/\D/g, '');
    if (innS.length >= 10) return 'rf:' + innS;
    return 'rf:' + orgSlug(name);
}

async function refreshTokens(cred) {
    const clientId = String(cred.client_id || '').trim();
    const clientSecret = String(cred.client_secret || '').trim();
    const refreshToken = String(cred.refresh_token || '').trim();
    if (!clientId || !clientSecret || !refreshToken) {
        const e = new Error('Райф: нужны client_id, client_secret и refresh_token');
        e.code = 'NO_RAIFF_CREDS';
        throw e;
    }
    const basic = Buffer.from(clientId + ':' + clientSecret, 'utf8').toString('base64');
    const body = new URLSearchParams();
    body.set('grant_type', 'refresh_token');
    body.set('client_id', clientId);
    body.set('refresh_token', refreshToken);
    let res;
    try {
        res = await axios({
            method: 'POST',
            url: RAIFF_TOKEN_URL,
            headers: {
                Authorization: 'Basic ' + basic,
                'Content-Type': 'application/x-www-form-urlencoded',
                Accept: 'application/json',
            },
            data: body.toString(),
            timeout: 30000,
            proxy: false,
            validateStatus: () => true,
        });
    } catch (e) {
        const wrap = new Error('Райф SSO: ' + (e.message || String(e)));
        wrap.cause = e;
        throw wrap;
    }
    const status = Number(res.status || 0);
    const data = res.data && typeof res.data === 'object' ? res.data : {};
    if (status < 200 || status >= 300 || !data.access_token) {
        const msg =
            data.error_description ||
            data.error ||
            data.message ||
            (typeof res.data === 'string' ? res.data.slice(0, 300) : '') ||
            ('HTTP ' + status);
        const e = new Error('Райф SSO: ' + String(msg).slice(0, 480));
        e.status = status;
        e.body = data;
        throw e;
    }
    cred.access_token = String(data.access_token || '').trim();
    cred.id_token = String(data.id_token || '').trim();
    if (data.refresh_token) cred.refresh_token = String(data.refresh_token).trim();
    const expiresIn = Number(data.expires_in) || 20 * 3600;
    cred.token_expires_at = new Date(Date.now() + Math.max(60, expiresIn - 60) * 1000).toISOString();
    cred.updated_at = new Date().toISOString();
    return cred;
}

async function ensureTokens(cred) {
    const access = String(cred.access_token || '').trim();
    const idTok = String(cred.id_token || '').trim();
    const exp = Date.parse(String(cred.token_expires_at || '')) || 0;
    if (access && idTok && exp > Date.now() + 30000) return cred;
    return refreshTokens(cred);
}

function authHeaders(cred) {
    const access = String(cred.access_token || '').trim();
    const idTok = String(cred.id_token || '').trim();
    if (!access || !idTok) {
        const e = new Error('Райф: нет access_token / id_token');
        e.code = 'NO_RAIFF_TOKEN';
        throw e;
    }
    return {
        Authorization: 'Bearer ' + access,
        'Id-Token': idTok,
        'ID-Token': idTok,
        Accept: 'application/json',
    };
}

async function raiffRequest(cred, method, pathName, query, retried) {
    await ensureTokens(cred);
    const url = pathName.startsWith('http') ? pathName : RAIFF_API_BASE + pathName;
    let res;
    try {
        res = await axios({
            method,
            url,
            headers: authHeaders(cred),
            params: query || undefined,
            timeout: 60000,
            proxy: false,
            validateStatus: () => true,
        });
    } catch (e) {
        const wrap = new Error('Райф API: ' + (e.message || String(e)));
        wrap.cause = e;
        throw wrap;
    }
    const status = Number(res.status || 0);
    if (status === 401 && !retried) {
        cred.access_token = '';
        cred.id_token = '';
        await refreshTokens(cred);
        return raiffRequest(cred, method, pathName, query, true);
    }
    if (status < 200 || status >= 300) {
        const data = res.data;
        const msg =
            (data && (data.message || data.error || data.error_description || data.detail)) ||
            (typeof data === 'string' ? data.slice(0, 400) : '') ||
            ('HTTP ' + status);
        const e = new Error('Райф API: ' + String(msg).slice(0, 480));
        e.status = status;
        e.body = data;
        throw e;
    }
    return res.data;
}

async function fetchAllPages(cred, pathName, query) {
    const all = [];
    let page = 0;
    let guard = 0;
    while (guard < 200) {
        guard += 1;
        const payload = await raiffRequest(cred, 'GET', pathName, Object.assign({}, query || {}, { page, size: PAGE_SIZE }));
        const rows = asArray(payload);
        all.push.apply(all, rows);
        const meta = pageMeta(payload);
        if (page + 1 >= meta.totalPages || rows.length < PAGE_SIZE) break;
        page += 1;
        await sleep(120);
    }
    return all;
}

function mapAccount(raw) {
    const a = raw && typeof raw === 'object' ? raw : {};
    const number = pickStr(a, ['Number', 'number', 'AccountNumber', 'accountNumber']) || pickStr(a, ['Id', 'id']);
    const name = pickStr(a, ['Name', 'name', 'OrganizationName', 'organizationName']);
    const org = pickStr(a, ['OrganizationName', 'organizationName', 'Organization', 'organization']);
    const inn = pickStr(a, ['OrganizationInn', 'organizationInn', 'Inn', 'inn', 'INN']);
    let currency = (pickStr(a, ['Currency', 'currency', 'AccountCurrency']) || 'RUB').toUpperCase();
    if (currency === 'RUR' || currency === '810' || currency === '643') currency = 'RUB';
    const status = pickStr(a, ['Status', 'status']);
    const type = pickStr(a, ['Type', 'type', 'AccountType', 'accountType']);
    const balance = pickNum(a.Balance != null ? a.Balance : a.balance != null ? a.balance : a, [
        'Balance',
        'CurrentBalance',
        'OutcomeBalance',
        'amount',
    ]);
    const available = pickNum(a.Available != null ? a.Available : a.available != null ? a.available : a, [
        'Available',
        'AvailableBalance',
        'amount',
    ]);
    const blocked = pickNum(a.Blocked != null ? a.Blocked : a.blocked, ['Blocked', 'amount']);
    return {
        account_id: String(number || '').slice(0, 64),
        account_number: String(number || '').slice(0, 64),
        currency,
        name: (org || name || 'Райффайзен').slice(0, 255),
        status: status.slice(0, 64),
        account_type: type.slice(0, 64),
        account_sub_type: type.slice(0, 64),
        account_sub_type_label: type || 'Счёт',
        customer_code: customerCodeFromOrg(org || name, inn),
        org_name: org || name,
        inn,
        balance: available != null ? available : balance,
        available: available != null ? available : balance,
        blocked,
    };
}

async function listAccounts(cred) {
    let raw;
    try {
        raw = await fetchAllPages(cred, '/api/v1/accounts', { fields: ACCOUNT_FIELDS });
    } catch (e) {
        if (e && e.status === 400) {
            raw = await fetchAllPages(cred, '/api/v1/accounts', { fields: ACCOUNT_FIELDS_MIN });
        } else {
            throw e;
        }
    }
    return raw.map(mapAccount).filter((a) => a.account_id);
}

function mapStatement(raw) {
    const s = raw && typeof raw === 'object' ? raw : {};
    const date = parseYmdLoose(pickStr(s, ['Date', 'date', 'StatementDate', 'statementDate']));
    const credits = Number(pickStr(s, ['CreditDocumentsCount', 'creditDocumentsCount']) || 0) || 0;
    const debits = Number(pickStr(s, ['DebitDocumentsCount', 'debitDocumentsCount']) || 0) || 0;
    const outcome = pickNum(s, ['OutcomeBalance', 'OutcomeBalanceRur', 'outcomeBalance']);
    return { date, credits, debits, outcome, has_ops: credits + debits > 0 };
}

function mapTx(raw, accountId) {
    const t = raw && typeof raw === 'object' ? raw : {};
    const credit = pickNum(t, ['Credit', 'credit']) || 0;
    const debit = pickNum(t, ['Debet', 'Debit', 'debet', 'debit']) || 0;
    const isCreditDoc = t.CreditDocument === true || t.creditDocument === true || String(t.CreditDocument) === 'true';
    let direction = 'in';
    let amountAbs = Math.abs(credit);
    if (debit > 0 && !(credit > 0)) {
        direction = 'out';
        amountAbs = Math.abs(debit);
    } else if (credit > 0 && !(debit > 0)) {
        direction = 'in';
        amountAbs = Math.abs(credit);
    } else if (isCreditDoc) {
        direction = 'in';
        amountAbs = Math.abs(credit || debit);
    } else if (debit > 0) {
        direction = 'out';
        amountAbs = Math.abs(debit);
    }
    const booked = parseYmdLoose(pickStr(t, ['OperationDate', 'operationDate', 'ValuationDate', 'valuationDate', 'StatementDate']));
    const doc = pickStr(t, ['DocumentNumber', 'documentNumber']);
    const purpose = pickStr(t, ['Purpose', 'purpose']);
    const cp = pickStr(t, ['ContractorName', 'contractorName']);
    const inn = pickStr(t, ['ContractorInn', 'contractorInn']);
    let currency = (pickStr(t, ['AccountCurrency', 'accountCurrency', 'Currency']) || 'RUB').toUpperCase();
    if (currency === 'RUR' || currency === '810' || currency === '643') currency = 'RUB';
    const acc = pickStr(t, ['Account', 'account']) || accountId;
    const txId = ['rf', acc, booked, doc, direction, String(amountAbs)].join(':').slice(0, 160);
    return {
        tx_id: txId,
        account_id: String(acc || accountId).slice(0, 64),
        booked_at: booked,
        amount: direction === 'out' ? -amountAbs : amountAbs,
        amount_abs: amountAbs,
        direction,
        currency,
        purpose,
        counterparty: cp,
        counterparty_inn: inn.replace(/\D/g, '').slice(0, 32),
        document_number: doc.slice(0, 64),
    };
}

async function listStatements(cred, accountNumber, startYmd, endYmd, intraday) {
    const path = '/api/v1/accounts/' + encodeURIComponent(accountNumber) + '/statements' + (intraday ? '/intraday' : '');
    const raw = await fetchAllPages(cred, path, { from: startYmd, to: endYmd, fields: STATEMENT_FIELDS });
    return raw.map(mapStatement).filter((s) => s.date);
}

async function listTransactionsForDay(cred, accountNumber, statementDate, intraday) {
    const path = '/api/v1/statement/transactions' + (intraday ? '/intraday' : '');
    const raw = await fetchAllPages(cred, path, {
        account: accountNumber,
        statementDate,
        fields: TX_FIELDS,
    });
    return raw.map((row) => mapTx(row, accountNumber)).filter((t) => t.tx_id && t.amount_abs >= 0);
}

async function fetchAccountStatementRange(cred, accountNumber, startYmd, endYmd) {
    const today = ymd(new Date());
    const txs = [];
    let lastBalance = null;
    const summaries = await listStatements(cred, accountNumber, startYmd, endYmd, false);
    const dates = new Set(summaries.filter((s) => s.has_ops).map((s) => s.date));
    for (const s of summaries) {
        if (s.outcome != null) lastBalance = s.outcome;
    }
    for (const d of dates) {
        await sleep(120);
        try {
            const part = await listTransactionsForDay(cred, accountNumber, d, false);
            txs.push.apply(txs, part);
        } catch (e) {
            if (e && e.status === 404) continue;
            throw e;
        }
    }
    if (endYmd >= today) {
        try {
            await sleep(120);
            const intraSt = await listStatements(cred, accountNumber, today, today, true);
            for (const s of intraSt) {
                if (s.outcome != null) lastBalance = s.outcome;
            }
            if (intraSt.some((s) => s.has_ops) || !intraSt.length) {
                const part = await listTransactionsForDay(cred, accountNumber, today, true);
                txs.push.apply(txs, part);
            }
        } catch (e) {
            /* внутридневная может отсутствовать */
        }
    }
    if (!dates.size && startYmd === endYmd) {
        try {
            const part = await listTransactionsForDay(cred, accountNumber, startYmd, false);
            txs.push.apply(txs, part);
        } catch (e) {
            /* нет итоговой за день */
        }
    }
    return { transactions: txs, lastBalance };
}

module.exports = {
    ymd,
    eachYmd,
    sleep,
    ensureTokens,
    refreshTokens,
    listAccounts,
    fetchAccountStatementRange,
    customerCodeFromOrg,
};
