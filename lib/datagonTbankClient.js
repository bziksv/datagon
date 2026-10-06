/**
 * Клиент T‑API Т‑Банка (только чтение: счета, остатки, выписки).
 * Токен: Bearer из кабинета Т‑Бизнес → Интеграции → T‑API → «Выпустить токен».
 * База: https://business.tbank.ru/openapi
 * Платежи не вызываются.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const tls = require('tls');
const axios = require('axios');
const crypto = require('crypto');

const TBANK_API_BASE = String(process.env.TBANK_API_BASE || 'https://business.tbank.ru/openapi').replace(
    /\/+$/,
    ''
);
const PAGE_LIMIT = 1000;

let cachedHttpsAgent = null;

function resolveRussianTrustedCaBundlePath() {
    if (process.env.TBANK_EXTRA_CA_CERTS) return String(process.env.TBANK_EXTRA_CA_CERTS);
    if (process.env.TOCHKA_EXTRA_CA_CERTS) return String(process.env.TOCHKA_EXTRA_CA_CERTS);
    if (process.env.NODE_EXTRA_CA_CERTS) return String(process.env.NODE_EXTRA_CA_CERTS);
    return path.join(__dirname, '..', 'certs', 'russian-trusted-ca-bundle.pem');
}

function getTbankHttpsAgent() {
    if (cachedHttpsAgent) return cachedHttpsAgent;
    const cas = Array.from(tls.rootCertificates || []);
    const caPath = resolveRussianTrustedCaBundlePath();
    try {
        const pem = fs.readFileSync(caPath, 'utf8').replace(/\r\n/g, '\n');
        const parts = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) || [];
        for (const part of parts) cas.push(part.trim() + '\n');
        if (!parts.length && pem.trim()) cas.push(pem.trim() + '\n');
    } catch (_) {
        /* корневые CA Node; Минцифры подмешиваем если файл есть */
    }
    cachedHttpsAgent = new https.Agent({ ca: cas, keepAlive: true });
    return cachedHttpsAgent;
}

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

function isoMoscowStart(ymdStr) {
    return String(ymdStr).slice(0, 10) + 'T00:00:00.000+03:00';
}

function isoMoscowEnd(ymdStr) {
    return String(ymdStr).slice(0, 10) + 'T23:59:59.999+03:00';
}

function authHeaders(token) {
    const t = String(token || '').trim();
    if (!t) {
        const e = new Error('Токен T‑API не задан');
        e.code = 'NO_TBANK_TOKEN';
        throw e;
    }
    return {
        Authorization: 'Bearer ' + t,
        Accept: 'application/json',
    };
}

function asArray(v) {
    if (Array.isArray(v)) return v;
    if (v == null) return [];
    if (typeof v === 'object') {
        if (Array.isArray(v.accounts)) return v.accounts;
        if (Array.isArray(v.operations)) return v.operations;
        if (Array.isArray(v.items)) return v.items;
        if (Array.isArray(v.data)) return v.data;
    }
    return [v];
}

function mapCurrency(code) {
    const s = String(code || '').trim().toUpperCase();
    if (s === '643' || s === 'RUR' || s === 'RUB') return 'RUB';
    if (s === '840' || s === 'USD') return 'USD';
    if (s === '978' || s === 'EUR') return 'EUR';
    if (s === '398' || s === 'KZT') return 'KZT';
    if (s === '156' || s === 'CNY') return 'CNY';
    if (/^[A-Z]{3}$/.test(s)) return s;
    return 'RUB';
}

function pickNum(v) {
    if (v == null) return null;
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string' && v.trim() && Number.isFinite(Number(v.replace(',', '.')))) {
        return Number(v.replace(',', '.'));
    }
    if (typeof v === 'object') {
        if (v.otb != null) return pickNum(v.otb);
        if (v.amount != null) return pickNum(v.amount);
        if (v.value != null) return pickNum(v.value);
    }
    return null;
}

function tokenFingerprint(token) {
    const t = String(token || '').trim();
    if (!t) return 'none';
    return crypto.createHash('sha256').update(t).digest('hex').slice(0, 12);
}

function customerCodeFromInn(inn, token) {
    const innS = String(inn || '').replace(/\D/g, '');
    if (innS.length >= 10) return 'tb:' + innS;
    return 'tb:' + tokenFingerprint(token);
}

async function tbankRequest(token, method, pathName, query) {
    const url = pathName.startsWith('http') ? pathName : TBANK_API_BASE + pathName;
    try {
        const res = await axios({
            method,
            url,
            headers: authHeaders(token),
            params: query || undefined,
            timeout: 60000,
            proxy: false,
            httpsAgent: getTbankHttpsAgent(),
            validateStatus: () => true,
        });
        const status = Number(res.status || 0);
        const data = res.data;
        if (status < 200 || status >= 300) {
            const obj = data && typeof data === 'object' ? data : {};
            const msg =
                obj.errorMessage ||
                obj.message ||
                obj.error ||
                (typeof data === 'string' ? data.slice(0, 400) : '') ||
                ('HTTP ' + status);
            const e = new Error('T‑API: ' + String(msg).slice(0, 480));
            e.status = status;
            e.body = obj;
            throw e;
        }
        return data;
    } catch (e) {
        if (e && e.status) throw e;
        const wrap = new Error('T‑API: ' + (e.message || String(e)));
        wrap.cause = e;
        throw wrap;
    }
}

function mapAccount(raw, token) {
    const a = raw && typeof raw === 'object' ? raw : {};
    const number = String(a.accountNumber || a.account_number || a.number || '').replace(/\s/g, '');
    const name = String(a.name || a.accountName || a.accountType || 'Расчётный счёт').trim();
    const inn = String(a.inn || a.companyInn || (a.company && a.company.inn) || '').replace(/\D/g, '');
    const org = String(
        a.companyName || a.organizationName || (a.company && (a.company.name || a.company.shortName)) || ''
    ).trim();
    const bal = a.balance && typeof a.balance === 'object' ? a.balance : a;
    const available = pickNum(bal.otb != null ? bal.otb : bal.available != null ? bal.available : bal);
    const authorized = pickNum(bal.authorized);
    const pending = (pickNum(bal.pendingPayments) || 0) + (pickNum(bal.pendingRequisitions) || 0);
    return {
        account_id: number.slice(0, 64),
        account_number: number.slice(0, 64),
        currency: mapCurrency(a.currency || a.currencyCode),
        name: (org || name || 'Т‑Банк').slice(0, 255),
        status: String(a.status || a.accountStatus || '').slice(0, 64),
        account_type: String(a.accountType || a.type || 'Current').slice(0, 64),
        account_sub_type: String(a.accountType || 'Current').slice(0, 64),
        account_sub_type_label: name || 'Счёт',
        customer_code: customerCodeFromInn(inn, token),
        org_name: org || name,
        inn,
        balance: available,
        available,
        blocked: authorized != null ? authorized : pending || null,
    };
}

async function listAccounts(token) {
    const paths = ['/api/v1/bank-accounts', '/api/v2/bank-accounts', '/api/v3/bank-accounts'];
    let lastErr = null;
    for (const p of paths) {
        try {
            const data = await tbankRequest(token, 'GET', p, null);
            const rows = asArray(data).map((row) => mapAccount(row, token)).filter((a) => a.account_id);
            return rows;
        } catch (e) {
            lastErr = e;
            if (e && (e.status === 404 || e.status === 405)) continue;
            if (e && e.status === 403 && /cert|mtls|tls/i.test(String(e.message || ''))) continue;
            throw e;
        }
    }
    if (lastErr) throw lastErr;
    return [];
}

function mapTx(raw) {
    const t = raw && typeof raw === 'object' ? raw : {};
    const type = String(t.typeOfOperation || t.type || '').toLowerCase();
    const amountAbs = Math.abs(Number(t.accountAmount != null ? t.accountAmount : t.operationAmount) || 0);
    let direction = 'in';
    if (type === 'debit' || type === 'outcome' || type === 'out') direction = 'out';
    else if (type === 'credit' || type === 'income' || type === 'in') direction = 'in';
    else if (Number(t.accountAmount) < 0 || Number(t.operationAmount) < 0) direction = 'out';
    const bookedRaw = String(t.operationDate || t.trxnPostDate || t.docDate || t.drawDate || '').trim();
    const booked = bookedRaw ? ymd(new Date(bookedRaw)) : '';
    const cp = t.counterParty && typeof t.counterParty === 'object' ? t.counterParty : {};
    const payer = t.payer && typeof t.payer === 'object' ? t.payer : {};
    const receiver = t.receiver && typeof t.receiver === 'object' ? t.receiver : {};
    const counterpartyObj = direction === 'out' ? receiver : payer;
    const cpName =
        String(cp.name || counterpartyObj.name || '').trim() ||
        String(direction === 'out' ? receiver.name : payer.name || '').trim();
    const cpInn = String(cp.inn || counterpartyObj.inn || '').replace(/\D/g, '');
    const acc = String(t.accountNumber || '').replace(/\s/g, '');
    const doc = String(t.documentNumber || t.operationId || '').trim();
    const purpose = String(t.payPurpose || t.description || '').trim();
    const currency = mapCurrency(t.accountCurrencyDigitalCode || t.operationCurrencyDigitalCode);
    const txId = String(t.operationId || ['tb', acc, booked, doc, direction, String(amountAbs)].join(':')).slice(
        0,
        160
    );
    return {
        tx_id: txId,
        account_id: acc.slice(0, 64),
        booked_at: bookedRaw || booked,
        amount: direction === 'out' ? -amountAbs : amountAbs,
        amount_abs: amountAbs,
        direction,
        currency,
        purpose,
        counterparty: cpName,
        counterparty_inn: cpInn.slice(0, 32),
        document_number: doc.slice(0, 64),
        inn: String(payer.inn || receiver.inn || '').replace(/\D/g, ''),
        org_name: String(payer.name || receiver.name || '').trim(),
    };
}

async function listStatementOperations(token, accountNumber, startYmd, endYmd) {
    const ops = [];
    let cursor = '';
    let lastBalance = null;
    let pages = 0;
    while (pages < 80) {
        pages += 1;
        const query = {
            accountNumber,
            from: isoMoscowStart(startYmd),
            to: isoMoscowEnd(endYmd),
            limit: PAGE_LIMIT,
            withBalances: pages === 1 ? 'true' : 'false',
        };
        if (cursor) query.cursor = cursor;
        const data = await tbankRequest(token, 'GET', '/api/v1/statement', query);
        const payload = data && typeof data === 'object' ? data : {};
        const rows = asArray(payload.operations);
        for (const row of rows) {
            const mapped = mapTx(row);
            if (mapped.tx_id && mapped.amount_abs >= 0) ops.push(mapped);
        }
        const bal = payload.balances;
        if (bal && typeof bal === 'object' && !Array.isArray(bal) && lastBalance == null) {
            lastBalance = pickNum(bal.balanceEnd);
        }
        const next = String(payload.nextCursor || '').trim();
        if (!next || rows.length === 0) break;
        cursor = next;
        await sleep(180);
    }
    return { transactions: ops, lastBalance };
}

async function fetchAccountStatementRange(token, accountNumber, startYmd, endYmd) {
    return listStatementOperations(token, accountNumber, startYmd, endYmd);
}

module.exports = {
    TBANK_API_BASE,
    ymd,
    listAccounts,
    fetchAccountStatementRange,
    customerCodeFromInn,
};
