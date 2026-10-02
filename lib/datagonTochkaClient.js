/**
 * Клиент Точка.API: только чтение (счета, балансы, выписки).
 * JWT из кабинета «Интеграции и API». Платежи не вызываются.
 *
 * Open Banking 1.0: https://developers.tochka.com/docs/tochka-api/
 *
 * TLS: сертификаты Точки подписаны НУЦ Минцифры (Russian Trusted CA),
 * которых нет в дефолтном бандле Node — подмешиваем PEM из certs/.
 * Официально: https://developers.tochka.com/docs/tochka-api/certificate
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const tls = require('tls');
const axios = require('axios');

const TOCHKA_API_BASE = String(process.env.TOCHKA_API_BASE || 'https://enter.tochka.com/uapi').replace(/\/+$/, '');
const STATEMENT_POLL_MS = 1500;
const STATEMENT_POLL_MAX = 40;

let cachedHttpsAgent = null;

function resolveRussianTrustedCaBundlePath() {
    if (process.env.TOCHKA_EXTRA_CA_CERTS) return String(process.env.TOCHKA_EXTRA_CA_CERTS);
    if (process.env.NODE_EXTRA_CA_CERTS) return String(process.env.NODE_EXTRA_CA_CERTS);
    return path.join(__dirname, '..', 'certs', 'russian-trusted-ca-bundle.pem');
}

function getTochkaHttpsAgent() {
    if (cachedHttpsAgent) return cachedHttpsAgent;
    const cas = Array.from(tls.rootCertificates || []);
    const caPath = resolveRussianTrustedCaBundlePath();
    try {
        const pem = fs.readFileSync(caPath, 'utf8').replace(/\r\n/g, '\n');
        const parts = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) || [];
        for (const part of parts) cas.push(part.trim() + '\n');
        if (!parts.length && pem.trim()) cas.push(pem.trim() + '\n');
        console.log('[tochka] TLS: добавлено CA Минцифры из ' + caPath + ' (' + (parts.length || 1) + ')');
    } catch (e) {
        console.warn(
            '[tochka] не удалось прочитать CA Минцифры (' +
                caPath +
                '): ' +
                (e && e.message ? e.message : e) +
                ' — TLS к enter.tochka.com может падать с self-signed certificate in certificate chain'
        );
    }
    cachedHttpsAgent = new https.Agent({ ca: cas, keepAlive: true });
    return cachedHttpsAgent;
}

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

async function tochkaRequest(jwt, method, pathName, body) {
    const url = pathName.startsWith('http') ? pathName : TOCHKA_API_BASE + pathName;
    try {
        const res = await axios({
            method,
            url,
            headers: authHeaders(jwt),
            data: body == null ? undefined : body,
            timeout: 60000,
            httpsAgent: getTochkaHttpsAgent(),
            proxy: false,
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

function firstAccountDetail(a) {
    const details = asArray(a.accountDetails || a.AccountDetails || a.account || a.Account);
    for (const d of details) {
        if (d && typeof d === 'object') return d;
    }
    return null;
}

/** Подписи Open Banking AccountSubType → UI. */
function accountSubTypeLabel(subType) {
    const s = String(subType || '').trim();
    const map = {
        CurrentAccount: 'Расчётный',
        Savings: 'Сберегательный / депозит',
        CreditCard: 'Кредитная карта',
        PrePaidCard: 'Предоплаченная карта',
        Loan: 'Кредит',
        Mortgage: 'Ипотека',
        Special: 'Специальный',
    };
    return map[s] || (s || 'Счёт');
}

function normalizeAccount(raw) {
    const a = raw && typeof raw === 'object' ? raw : {};
    const id = String(a.accountId || a.AccountId || a.id || '').trim();
    const detail = firstAccountDetail(a);
    const ident = a.account || a.Account || detail || a;
    const number = String(
        (detail && (detail.identification || detail.Identification || detail.accountNumber)) ||
            (ident && (ident.identification || ident.Identification || ident.accountNumber)) ||
            a.identification ||
            a.accountNumber ||
            a.number ||
            ''
    ).trim();
    const name = String(
        a.nickname ||
            a.Nickname ||
            a.name ||
            a.accountName ||
            (detail && (detail.name || detail.Name)) ||
            a.customerCode ||
            ''
    ).trim();
    const account_sub_type = String(a.accountSubType || a.AccountSubType || '').trim();
    return {
        account_id: id,
        account_number: number || id,
        currency: String(a.currency || a.Currency || (ident && ident.currency) || 'RUB').trim() || 'RUB',
        name,
        status: String(a.status || a.Status || '').trim(),
        account_type: String(a.accountType || a.AccountType || '').trim(),
        account_sub_type,
        account_sub_type_label: accountSubTypeLabel(account_sub_type),
        customer_code: String(a.customerCode || a.CustomerCode || '').trim(),
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

async function listCustomers(jwt) {
    const payload = await tochkaRequest(jwt, 'GET', '/open-banking/v1.0/customers');
    const data = unwrapData(payload);
    return asArray(data.Customer || data.customer || data.Customers || data.customers).map((c) => ({
        customer_code: String(c.customerCode || c.CustomerCode || '').trim(),
        customer_type: String(c.customerType || c.CustomerType || '').trim(),
        short_name: String(c.shortName || c.ShortName || c.fullName || c.FullName || '').trim(),
        full_name: String(c.fullName || c.FullName || '').trim(),
        tax_code: String(c.taxCode || c.TaxCode || '').trim(),
    }));
}

async function listConsents(jwt) {
    const payload = await tochkaRequest(jwt, 'GET', '/consent/v1.0/consents');
    const data = unwrapData(payload);
    const roots = asArray(data.Consent || data.consent || data.Consents || data.consents);
    const out = [];
    for (const c of roots) {
        const consentId = String(c.consentId || c.ConsentId || '').trim();
        const base = {
            consent_id: consentId,
            customer_code: String(c.customerCode || c.CustomerCode || '').trim(),
            permissions: asArray(c.permissions || c.Permissions).map(String),
            status: String(c.status || c.Status || '').trim(),
            application_name: String(c.applicationName || c.ApplicationName || '').trim(),
            is_valid: c.isValid !== false,
        };
        out.push(base);
        if (!consentId) continue;
        try {
            const childPayload = await tochkaRequest(jwt, 'GET', `/consent/v1.0/consents/${encodeURIComponent(consentId)}/child`);
            const childData = unwrapData(childPayload);
            for (const ch of asArray(childData.Consent || childData.consent || childData.Consents)) {
                out.push({
                    consent_id: String(ch.consentId || ch.ConsentId || '').trim(),
                    customer_code: String(ch.customerCode || ch.CustomerCode || '').trim(),
                    permissions: asArray(ch.permissions || ch.Permissions).map(String),
                    status: String(ch.status || ch.Status || '').trim(),
                    application_name: String(ch.applicationName || ch.ApplicationName || '').trim(),
                    is_valid: ch.isValid !== false,
                    parent_consent_id: consentId,
                });
            }
        } catch (e) {
            /* optional */
        }
    }
    // de-dupe by consent_id
    const seen = Object.create(null);
    return out.filter((c) => {
        if (!c.consent_id || seen[c.consent_id]) return false;
        seen[c.consent_id] = true;
        return true;
    });
}

/** Анализ: у каких клиентов нет ReadAccounts* — фонды/депозиты (если это счета) не попадут в список. */
function analyzeConsentGaps(customers, consents) {
    const need = ['ReadAccountsBasic', 'ReadAccountsDetail', 'ReadBalances'];
    const byCode = Object.create(null);
    for (const c of consents || []) {
        const code = c.customer_code;
        if (!code) continue;
        if (!byCode[code]) byCode[code] = { permissions: [], consent_ids: [] };
        byCode[code].permissions = byCode[code].permissions.concat(c.permissions || []);
        byCode[code].consent_ids.push(c.consent_id);
    }
    const gaps = [];
    for (const cust of customers || []) {
        const code = cust.customer_code;
        const pack = byCode[code] || { permissions: [] };
        const perms = new Set(pack.permissions);
        const missing = need.filter((p) => !perms.has(p));
        const hasAccounts = perms.has('ReadAccountsBasic') || perms.has('ReadAccountsDetail');
        gaps.push({
            customer_code: code,
            short_name: cust.short_name || cust.full_name || code,
            customer_type: cust.customer_type,
            has_account_read: hasAccounts,
            missing_permissions: missing,
            permissions: Array.from(perms),
        });
    }
    return gaps;
}

/**
 * Балансы по всем счетам одним запросом.
 * @returns {Map<string, {available, blocked, balance, currency, raw_types}>}
 */
async function listAllBalances(jwt) {
    const payload = await tochkaRequest(jwt, 'GET', '/open-banking/v1.0/balances');
    const data = unwrapData(payload);
    const balances = asArray(data.Balance || data.balance || data.Balances || data.balances);
    const byId = new Map();
    for (const b of balances) {
        const id = String(b.accountId || b.AccountId || '').trim();
        if (!id) continue;
        if (!byId.has(id)) byId.set(id, []);
        byId.get(id).push(b);
    }
    const out = new Map();
    for (const [id, list] of byId.entries()) {
        out.set(id, normalizeBalancesPayload({ Data: { Balance: list } }));
    }
    return out;
}

function unwrapStatement(payload) {
    const data = unwrapData(payload);
    let st = data && (data.Statement || data.statement);
    if (Array.isArray(st)) st = st[0] || null;
    if (!st && data && typeof data === 'object' && (data.statementId || data.StatementId || data.status || data.Status)) {
        st = data;
    }
    return st && typeof st === 'object' ? st : {};
}

/**
 * accountId вида «номер/БИК» в path Точки идёт как два сегмента, не как %2F.
 * Пример: /accounts/40702…/044525104/balances
 */
function accountIdPath(accountId) {
    const raw = String(accountId || '').trim();
    const parts = raw.split('/');
    if (parts.length === 2 && parts[0] && parts[1]) {
        return encodeURIComponent(parts[0]) + '/' + encodeURIComponent(parts[1]);
    }
    return encodeURIComponent(raw);
}

async function getAccountBalances(jwt, accountId) {
    const id = accountIdPath(accountId);
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
 * Тело Init Statement: Data.Statement { accountId, startDateTime, endDateTime } (YYYY-MM-DD, без времени).
 * Ответ Get Statement часто отдаёт Data.Statement как массив из одного элемента — разворачиваем.
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
    const st0 = unwrapStatement(init);
    const statementId = String(st0.statementId || st0.StatementId || st0.id || '').trim();
    if (!statementId) {
        const e = new Error('Точка: Init Statement не вернул statementId');
        e.body = init;
        throw e;
    }
    const accPath = accountIdPath(acc);
    const stEnc = encodeURIComponent(statementId);
    let last = init;
    for (let i = 0; i < STATEMENT_POLL_MAX; i++) {
        last = await tochkaRequest(jwt, 'GET', `/open-banking/v1.0/accounts/${accPath}/statements/${stEnc}`);
        const st = unwrapStatement(last);
        const status = String(st.status || st.Status || '').toLowerCase();
        const hasTx = asArray(st.Transaction || st.transaction || st.Transactions).length > 0;
        if (status === 'ready' || status === 'completed' || hasTx) {
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
    const cParty = t.creditorParty || t.CreditorParty || {};
    const dParty = t.debtorParty || t.DebtorParty || {};
    const cName = t.creditorAgent || t.CreditorAgent || {};
    const dName = t.debtorAgent || t.DebtorAgent || {};
    if (dir === 'in') {
        return String(
            t.debtorName ||
                t.DebtorName ||
                dParty.name ||
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
            cParty.name ||
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
    const cParty = t.creditorParty || t.CreditorParty || {};
    const dParty = t.debtorParty || t.DebtorParty || {};
    if (dir === 'in') {
        return String(t.debtorInn || t.DebtorInn || dParty.inn || debtor.inn || debtor.taxId || '').trim();
    }
    return String(t.creditorInn || t.CreditorInn || cParty.inn || creditor.inn || creditor.taxId || '').trim();
}

function flattenTransactions(statement, accountId) {
    const st = statement && typeof statement === 'object' ? statement : {};
    const list = asArray(st.Transaction || st.transaction || st.Transactions || st.transactions);
    const out = [];
    for (const t of list) {
        const dir = creditDebit(t);
        const absAmt = Math.abs(amountFromTx(t));
        const txId = String(
            t.transactionId || t.TransactionId || t.paymentId || t.id || t.documentNumber || t.DocumentNumber || ''
        ).trim();
        const booked = String(
            t.bookingDateTime ||
                t.BookingDateTime ||
                t.documentProcessDate ||
                t.DocumentProcessDate ||
                t.valueDateTime ||
                t.ValueDateTime ||
                ''
        ).slice(0, 32);
        const amtObj = t.amount || t.Amount || {};
        out.push({
            tx_id: txId || [accountId, booked, dir, absAmt].join(':'),
            account_id: String(accountId || st.accountId || '').trim(),
            booked_at: booked,
            amount: dir === 'out' ? -absAmt : absAmt,
            amount_abs: absAmt,
            direction: dir,
            currency: String(amtObj.currency || amtObj.Currency || t.currency || 'RUB'),
            purpose: String(
                t.transactionInformation || t.TransactionInformation || t.description || t.Description || t.purpose || ''
            ).trim(),
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
    listCustomers,
    listConsents,
    analyzeConsentGaps,
    listAllBalances,
    getAccountBalances,
    accountSubTypeLabel,
    fetchStatement,
    flattenTransactions,
    ymd,
};
