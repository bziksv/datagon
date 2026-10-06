/**
 * Наличные в Финансах: шаблоны (фикс+премия), помесячные overrides, разовые.
 * Разворот шаблонов — на чтении.
 */

function clampDay(n) {
    const d = Math.max(1, Math.min(28, parseInt(String(n || '1'), 10) || 1));
    return d;
}

function parseMoney(v) {
    if (v == null || v === '') return null;
    const n = Number(String(v).replace(/\s/g, '').replace(',', '.'));
    return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

function ymFromDate(ymd) {
    const s = String(ymd || '').slice(0, 7);
    return /^\d{4}-\d{2}$/.test(s) ? s : '';
}

function bookedDateForYm(ym, day) {
    const y = Number(String(ym).slice(0, 4));
    const m = Number(String(ym).slice(5, 7));
    const d = clampDay(day);
    return y + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0');
}

function monthsBetween(dateFrom, dateTo) {
    const a = ymFromDate(dateFrom);
    const b = ymFromDate(dateTo);
    if (!a || !b || a > b) return [];
    const out = [];
    let y = Number(a.slice(0, 4));
    let m = Number(a.slice(5, 7));
    const ey = Number(b.slice(0, 4));
    const em = Number(b.slice(5, 7));
    while (y < ey || (y === ey && m <= em)) {
        out.push(y + '-' + String(m).padStart(2, '0'));
        m += 1;
        if (m > 12) {
            m = 1;
            y += 1;
        }
        if (out.length > 120) break;
    }
    return out;
}

async function ensureCashTables(db) {
    await db.query(`
        CREATE TABLE IF NOT EXISTS dg_finance_cash_templates (
            id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
            purpose VARCHAR(512) NOT NULL DEFAULT '',
            direction VARCHAR(8) NOT NULL DEFAULT 'out',
            day_of_month TINYINT UNSIGNED NOT NULL DEFAULT 1,
            amount_fix DECIMAL(18,2) NOT NULL DEFAULT 0,
            amount_premium DECIMAL(18,2) NULL,
            scope VARCHAR(8) NOT NULL DEFAULT 'all',
            customer_code VARCHAR(64) NOT NULL DEFAULT '',
            bank VARCHAR(32) NOT NULL DEFAULT '',
            account_id VARCHAR(64) NOT NULL DEFAULT '',
            include_chart TINYINT(1) NOT NULL DEFAULT 1,
            active TINYINT(1) NOT NULL DEFAULT 1,
            valid_from DATE NULL,
            valid_to DATE NULL,
            created_by VARCHAR(64) NOT NULL DEFAULT '',
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            PRIMARY KEY (id),
            KEY idx_fin_cash_tmpl_active (active, valid_from, valid_to)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await db.query(`
        CREATE TABLE IF NOT EXISTS dg_finance_cash_overrides (
            template_id BIGINT UNSIGNED NOT NULL,
            ym CHAR(7) NOT NULL,
            amount_fix DECIMAL(18,2) NULL,
            amount_premium DECIMAL(18,2) NULL,
            purpose VARCHAR(512) NULL,
            include_chart TINYINT(1) NULL,
            skipped TINYINT(1) NOT NULL DEFAULT 0,
            updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            PRIMARY KEY (template_id, ym),
            KEY idx_fin_cash_ov_ym (ym)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await db.query(`
        CREATE TABLE IF NOT EXISTS dg_finance_cash_tx (
            id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
            booked_date DATE NOT NULL,
            direction VARCHAR(8) NOT NULL DEFAULT 'out',
            amount DECIMAL(18,2) NOT NULL DEFAULT 0,
            purpose VARCHAR(512) NOT NULL DEFAULT '',
            counterparty VARCHAR(512) NOT NULL DEFAULT '',
            scope VARCHAR(8) NOT NULL DEFAULT 'all',
            customer_code VARCHAR(64) NOT NULL DEFAULT '',
            bank VARCHAR(32) NOT NULL DEFAULT '',
            account_id VARCHAR(64) NOT NULL DEFAULT '',
            include_chart TINYINT(1) NOT NULL DEFAULT 1,
            created_by VARCHAR(64) NOT NULL DEFAULT '',
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            PRIMARY KEY (id),
            KEY idx_fin_cash_tx_date (booked_date),
            KEY idx_fin_cash_tx_org (customer_code)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
}

function normalizeScope(raw, customerCode) {
    const s = String(raw || '').trim().toLowerCase();
    const code = String(customerCode || '').trim();
    if (s === 'org' || code) return { scope: 'org', customer_code: code };
    return { scope: 'all', customer_code: '' };
}

function cashMatchesOrgFilter(row, customerCodes) {
    const codes = Array.isArray(customerCodes) ? customerCodes.filter(Boolean) : [];
    if (!codes.length) return true;
    if (String(row.scope || '') === 'all' || !String(row.customer_code || '').trim()) return true;
    return codes.indexOf(String(row.customer_code).trim()) >= 0;
}

function cashMatchesAccountFilter(row, accountId) {
    const acc = String(accountId || '').trim();
    if (!acc) return true;
    return String(row.account_id || '').trim() === acc;
}

function cashMatchesSearch(row, search) {
    const q = String(search || '').trim().toLowerCase();
    if (!q) return true;
    const hay = [row.purpose, row.counterparty, row.tx_id, row.customer_code, row.org]
        .map(function (x) {
            return String(x || '').toLowerCase();
        })
        .join(' ');
    return hay.indexOf(q) >= 0;
}

function rowFromTemplate(t, ym, ov, orgAliases, finCred) {
    const skipped = ov && Number(ov.skipped) === 1;
    if (skipped) return null;
    const fix = ov && ov.amount_fix != null ? Number(ov.amount_fix) : Number(t.amount_fix) || 0;
    const premRaw = ov && ov.amount_premium != null ? ov.amount_premium : t.amount_premium;
    const prem = premRaw == null || premRaw === '' ? 0 : Number(premRaw) || 0;
    const hasPrem = premRaw != null && premRaw !== '';
    const total = Math.round((fix + prem) * 100) / 100;
    const purpose = ov && ov.purpose != null && String(ov.purpose).trim() !== '' ? String(ov.purpose) : String(t.purpose || '');
    const includeChart =
        ov && ov.include_chart != null ? Number(ov.include_chart) === 1 : Number(t.include_chart) !== 0;
    const day = clampDay(t.day_of_month);
    const booked = bookedDateForYm(ym, day);
    const dir = String(t.direction || 'out') === 'in' ? 'in' : 'out';
    const code = String(t.customer_code || '').trim();
    const entry = code && orgAliases ? orgAliases[code] : null;
    const orgFull = finCred
        ? finCred.orgAliasFull(entry, code || (t.scope === 'all' ? 'Все компании' : ''))
        : code || 'Все компании';
    const orgShort = finCred
        ? finCred.orgAliasShort(entry, code || (t.scope === 'all' ? 'Все' : ''))
        : code || 'Все';
    const txId = 'cash:t:' + t.id + ':' + ym;
    return {
        source: 'cash',
        cash_kind: 'recurring',
        bank: 'cash',
        tx_id: txId,
        template_id: Number(t.id),
        ym: ym,
        account_id: String(t.account_id || ''),
        account_number: '',
        account_name: 'Наличные',
        booked_at: booked,
        booked_date: booked,
        amount: dir === 'out' ? -Math.abs(total) : Math.abs(total),
        amount_abs: Math.abs(total),
        amount_fix: fix,
        amount_premium: hasPrem ? prem : null,
        direction: dir,
        currency: 'RUB',
        purpose: purpose,
        counterparty: '(наличные)',
        counterparty_inn: '',
        document_number: '',
        exclude_chart: includeChart ? 0 : 1,
        chart_tag: '',
        include_chart: includeChart,
        chart_excluded: !includeChart,
        chart_exclude_reason: includeChart ? null : 'наличные: не в графике',
        founder_capital: false,
        dividend_payout: false,
        customer_code: code,
        org_label: t.scope === 'all' ? 'Все компании' : code,
        org: orgFull,
        org_short: orgShort,
        scope: String(t.scope || 'all'),
        is_fund: 0,
        custom_name: '',
        override: Boolean(ov),
    };
}

function rowFromOneOff(r, orgAliases, finCred) {
    const includeChart = Number(r.include_chart) !== 0;
    const dir = String(r.direction || 'out') === 'in' ? 'in' : 'out';
    const abs = Math.abs(Number(r.amount) || 0);
    const code = String(r.customer_code || '').trim();
    const entry = code && orgAliases ? orgAliases[code] : null;
    const orgFull = finCred
        ? finCred.orgAliasFull(entry, code || (r.scope === 'all' ? 'Все компании' : ''))
        : code || 'Все компании';
    const orgShort = finCred
        ? finCred.orgAliasShort(entry, code || (r.scope === 'all' ? 'Все' : ''))
        : code || 'Все';
    const booked = String(r.booked_date || '').slice(0, 10);
    return {
        source: 'cash',
        cash_kind: 'once',
        bank: 'cash',
        tx_id: 'cash:o:' + r.id,
        cash_id: Number(r.id),
        account_id: String(r.account_id || ''),
        account_number: '',
        account_name: 'Наличные',
        booked_at: booked,
        booked_date: booked,
        amount: dir === 'out' ? -abs : abs,
        amount_abs: abs,
        direction: dir,
        currency: 'RUB',
        purpose: String(r.purpose || ''),
        counterparty: String(r.counterparty || '').trim() || '(наличные)',
        counterparty_inn: '',
        document_number: '',
        exclude_chart: includeChart ? 0 : 1,
        chart_tag: '',
        include_chart: includeChart,
        chart_excluded: !includeChart,
        chart_exclude_reason: includeChart ? null : 'наличные: не в графике',
        founder_capital: false,
        dividend_payout: false,
        customer_code: code,
        org_label: r.scope === 'all' ? 'Все компании' : code,
        org: orgFull,
        org_short: orgShort,
        scope: String(r.scope || 'all'),
        is_fund: 0,
        custom_name: '',
    };
}

/**
 * @param {{ dateFrom?: string, dateTo?: string, customerCodes?: string[], accountId?: string, search?: string, direction?: string, chartOnly?: boolean }} opts
 */
async function loadExpandedCashRows(db, finCred, orgAliases, opts) {
    const o = opts || {};
    let dateFrom = String(o.dateFrom || '').trim();
    let dateTo = String(o.dateTo || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateFrom)) dateFrom = '2000-01-01';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateTo)) {
        const n = new Date();
        dateTo =
            n.getFullYear() +
            '-' +
            String(n.getMonth() + 1).padStart(2, '0') +
            '-' +
            String(n.getDate()).padStart(2, '0');
    }
    const yms = monthsBetween(dateFrom, dateTo);
    const [templates] = await db.query(
        `SELECT * FROM dg_finance_cash_templates WHERE active = 1 ORDER BY id ASC`
    );
    const tmplIds = (templates || []).map(function (t) {
        return t.id;
    });
    let overrides = [];
    if (tmplIds.length && yms.length) {
        const phT = tmplIds.map(function () {
            return '?';
        }).join(',');
        const phY = yms.map(function () {
            return '?';
        }).join(',');
        const [ovRows] = await db.query(
            `SELECT * FROM dg_finance_cash_overrides
             WHERE template_id IN (${phT}) AND ym IN (${phY})`,
            tmplIds.concat(yms)
        );
        overrides = ovRows || [];
    }
    const ovMap = Object.create(null);
    overrides.forEach(function (ov) {
        ovMap[String(ov.template_id) + ':' + String(ov.ym)] = ov;
    });

    const out = [];
    (templates || []).forEach(function (t) {
        const vf = t.valid_from ? String(t.valid_from).slice(0, 10) : '';
        const vt = t.valid_to ? String(t.valid_to).slice(0, 10) : '';
        yms.forEach(function (ym) {
            const booked = bookedDateForYm(ym, t.day_of_month);
            if (booked < dateFrom || booked > dateTo) return;
            if (vf && booked < vf) return;
            if (vt && booked > vt) return;
            const ov = ovMap[String(t.id) + ':' + ym] || null;
            const row = rowFromTemplate(t, ym, ov, orgAliases, finCred);
            if (!row) return;
            out.push(row);
        });
    });

    const [onceRows] = await db.query(
        `SELECT id, DATE_FORMAT(booked_date, '%Y-%m-%d') AS booked_date,
                direction, amount, purpose, counterparty, scope, customer_code,
                bank, account_id, include_chart
         FROM dg_finance_cash_tx
         WHERE booked_date >= ? AND booked_date <= ?
         ORDER BY booked_date DESC, id DESC`,
        [dateFrom, dateTo]
    );
    (onceRows || []).forEach(function (r) {
        out.push(rowFromOneOff(r, orgAliases, finCred));
    });

    const direction = String(o.direction || '').toLowerCase();
    const filtered = out.filter(function (row) {
        if (direction === 'in' || direction === 'out') {
            if (row.direction !== direction) return false;
        }
        if (!cashMatchesOrgFilter(row, o.customerCodes)) return false;
        if (!cashMatchesAccountFilter(row, o.accountId)) return false;
        if (!cashMatchesSearch(row, o.search)) return false;
        if (o.chartOnly && row.chart_excluded) return false;
        return true;
    });
    return filtered;
}

function sortCashLikeRows(rows, sortKey, sortDir) {
    const dir = sortDir === 'asc' ? 1 : -1;
    const key = String(sortKey || 'booked_date');
    return (rows || []).slice().sort(function (a, b) {
        let va;
        let vb;
        if (key === 'amount') {
            va = Number(a.amount_abs) || 0;
            vb = Number(b.amount_abs) || 0;
        } else if (key === 'founder') {
            va = a.founder_capital ? 2 : a.dividend_payout || a.chart_tag === 'dividend' ? 1 : 0;
            vb = b.founder_capital ? 2 : b.dividend_payout || b.chart_tag === 'dividend' ? 1 : 0;
        } else if (key === 'booked_date') {
            va = String(a.booked_date || '').slice(0, 10);
            vb = String(b.booked_date || '').slice(0, 10);
        } else if (key === 'direction') {
            va = String(a.direction || '');
            vb = String(b.direction || '');
        } else if (key === 'org') {
            va = String(a.org || a.org_label || '');
            vb = String(b.org || b.org_label || '');
        } else if (key === 'bank') {
            va = String(a.bank || '');
            vb = String(b.bank || '');
        } else if (key === 'account_number') {
            va = String(a.account_number || a.account_id || '');
            vb = String(b.account_number || b.account_id || '');
        } else if (key === 'purpose') {
            va = String(a.purpose || '');
            vb = String(b.purpose || '');
        } else if (key === 'counterparty') {
            va = String(a.counterparty || '');
            vb = String(b.counterparty || '');
        } else if (key === 'counterparty_inn') {
            va = String(a.counterparty_inn || '');
            vb = String(b.counterparty_inn || '');
        } else if (key === 'document_number') {
            va = String(a.document_number || '');
            vb = String(b.document_number || '');
        } else if (key === 'tx_id') {
            va = String(a.tx_id || '');
            vb = String(b.tx_id || '');
        } else {
            va = String(a[key] != null ? a[key] : '');
            vb = String(b[key] != null ? b[key] : '');
        }
        let primary = 0;
        if (typeof va === 'number' && typeof vb === 'number') {
            primary = va === vb ? 0 : va < vb ? -1 : 1;
        } else {
            primary = String(va).localeCompare(String(vb), 'ru');
        }
        if (primary !== 0) return primary * dir;
        // Стабильный вторичный ключ — дата, затем id (чтобы страницы не «плавали»).
        const da = String(a.booked_date || '').slice(0, 10);
        const db_ = String(b.booked_date || '').slice(0, 10);
        const dc = db_.localeCompare(da);
        if (dc !== 0) return dc;
        return String(b.tx_id || '').localeCompare(String(a.tx_id || ''));
    });
}

function aggregateCashByMonth(rows) {
    const byYm = Object.create(null);
    (rows || []).forEach(function (r) {
        if (r.chart_excluded) return;
        const ym = ymFromDate(r.booked_date);
        if (!ym) return;
        if (!byYm[ym]) byYm[ym] = { in: 0, out: 0, count_in: 0, count_out: 0 };
        const abs = Number(r.amount_abs) || 0;
        if (r.direction === 'out') {
            byYm[ym].out += abs;
            byYm[ym].count_out += 1;
        } else {
            byYm[ym].in += abs;
            byYm[ym].count_in += 1;
        }
    });
    return byYm;
}

function aggregateCashCounterparties(rows) {
    const map = Object.create(null);
    (rows || []).forEach(function (r) {
        if (r.chart_excluded) return;
        const name = String(r.counterparty || '').trim() || '(наличные)';
        const key = name + '\0' + String(r.direction || '');
        if (!map[key]) {
            map[key] = { name: name, inn: '', direction: r.direction, amount: 0, count: 0 };
        }
        map[key].amount += Number(r.amount_abs) || 0;
        map[key].count += 1;
    });
    return Object.keys(map).map(function (k) {
        return map[k];
    });
}

function parseSource(raw) {
    const s = String(raw || 'all').trim().toLowerCase();
    if (s === 'bank' || s === 'cash') return s;
    return 'all';
}

module.exports = {
    ensureCashTables,
    clampDay,
    parseMoney,
    normalizeScope,
    loadExpandedCashRows,
    sortCashLikeRows,
    aggregateCashByMonth,
    aggregateCashCounterparties,
    parseSource,
    monthsBetween,
    ymFromDate,
};
