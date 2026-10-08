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

/** Сегодня по Europe/Moscow (YYYY-MM-DD) — для «проверка только после наступления даты проводки». */
function moscowTodayYmd() {
    try {
        const parts = new Intl.DateTimeFormat('en-CA', {
            timeZone: 'Europe/Moscow',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
        }).formatToParts(new Date());
        let y = '';
        let m = '';
        let d = '';
        parts.forEach(function (p) {
            if (p.type === 'year') y = p.value;
            if (p.type === 'month') m = p.value;
            if (p.type === 'day') d = p.value;
        });
        if (y && m && d) return y + '-' + m + '-' + d;
    } catch (e) {
        /* fall through */
    }
    const n = new Date();
    return (
        n.getFullYear() +
        '-' +
        String(n.getMonth() + 1).padStart(2, '0') +
        '-' +
        String(n.getDate()).padStart(2, '0')
    );
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
    try {
        const [cashCols] = await db.query(`SHOW COLUMNS FROM dg_finance_cash_tx LIKE 'plan_item_id'`);
        if (!cashCols || !cashCols.length) {
            await db.query(
                `ALTER TABLE dg_finance_cash_tx ADD COLUMN plan_item_id BIGINT UNSIGNED NULL DEFAULT NULL`
            );
            await db.query(`ALTER TABLE dg_finance_cash_tx ADD KEY idx_fin_cash_plan (plan_item_id)`);
        }
    } catch (_) {
        /* ignore */
    }
    try {
        const [tmplCols] = await db.query(`SHOW COLUMNS FROM dg_finance_cash_templates LIKE 'plan_item_id'`);
        if (!tmplCols || !tmplCols.length) {
            await db.query(
                `ALTER TABLE dg_finance_cash_templates ADD COLUMN plan_item_id BIGINT UNSIGNED NULL DEFAULT NULL`
            );
            await db.query(`ALTER TABLE dg_finance_cash_templates ADD KEY idx_fin_cash_tmpl_plan (plan_item_id)`);
        }
    } catch (_) {
        /* ignore */
    }
    try {
        const [nrCols] = await db.query(`SHOW COLUMNS FROM dg_finance_cash_templates LIKE 'needs_review'`);
        if (!nrCols || !nrCols.length) {
            await db.query(
                `ALTER TABLE dg_finance_cash_templates ADD COLUMN needs_review TINYINT(1) NOT NULL DEFAULT 0`
            );
        }
    } catch (_) {
        /* ignore */
    }
    try {
        const [rcCols] = await db.query(`SHOW COLUMNS FROM dg_finance_cash_overrides LIKE 'review_confirmed'`);
        if (!rcCols || !rcCols.length) {
            await db.query(
                `ALTER TABLE dg_finance_cash_overrides ADD COLUMN review_confirmed TINYINT(1) NOT NULL DEFAULT 0`
            );
        }
    } catch (_) {
        /* ignore */
    }
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
    const needsReview = Number(t.needs_review) === 1;
    const reviewConfirmed = ov && Number(ov.review_confirmed) === 1;
    // Только текущий месяц и только после наступления дня проводки (не весь период вперёд/назад).
    const todayYmd = moscowTodayYmd();
    const todayYm = ymFromDate(todayYmd);
    const dueNow = ym === todayYm && booked <= todayYmd;
    const reviewPending = needsReview && !reviewConfirmed && dueNow;
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
        plan_item_id: t.plan_item_id != null && t.plan_item_id !== '' ? Number(t.plan_item_id) : null,
        needs_review: needsReview ? 1 : 0,
        review_confirmed: reviewConfirmed ? 1 : 0,
        review_pending: reviewPending,
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
        plan_item_id: r.plan_item_id != null && r.plan_item_id !== '' ? Number(r.plan_item_id) : null,
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

function nextYm(ym) {
    const s = String(ym || '');
    if (!/^\d{4}-\d{2}$/.test(s)) return '';
    let y = Number(s.slice(0, 4));
    let m = Number(s.slice(5, 7));
    m += 1;
    if (m > 12) {
        m = 1;
        y += 1;
    }
    return y + '-' + String(m).padStart(2, '0');
}

/**
 * Прогноз наличных по активным шаблонам на месяц ym (с учётом overrides / skip / org).
 */
async function forecastTemplatesForYm(db, finCred, orgAliases, ym, customerCodes) {
    const targetYm = String(ym || '');
    if (!/^\d{4}-\d{2}$/.test(targetYm)) {
        return {
            ym: targetYm,
            in: 0,
            out: 0,
            net: 0,
            templates_total: 0,
            templates_active: 0,
            templates_skipped: 0,
            review_pending: 0,
            items: [],
        };
    }
    const [templates] = await db.query(
        `SELECT * FROM dg_finance_cash_templates WHERE active = 1 ORDER BY day_of_month ASC, id ASC`
    );
    const tmplIds = (templates || []).map(function (t) {
        return t.id;
    });
    let overrides = [];
    if (tmplIds.length) {
        const ph = tmplIds
            .map(function () {
                return '?';
            })
            .join(',');
        const [ovRows] = await db.query(
            `SELECT * FROM dg_finance_cash_overrides WHERE template_id IN (${ph}) AND ym = ?`,
            tmplIds.concat([targetYm])
        );
        overrides = ovRows || [];
    }
    const ovMap = Object.create(null);
    overrides.forEach(function (ov) {
        ovMap[String(ov.template_id)] = ov;
    });

    let totIn = 0;
    let totOut = 0;
    let skipped = 0;
    let reviewPending = 0;
    const items = [];
    (templates || []).forEach(function (t) {
        if (!cashMatchesOrgFilter(t, customerCodes)) return;
        const vf = t.valid_from ? String(t.valid_from).slice(0, 10) : '';
        const vt = t.valid_to ? String(t.valid_to).slice(0, 10) : '';
        const booked = bookedDateForYm(targetYm, t.day_of_month);
        if (vf && booked < vf) return;
        if (vt && booked > vt) return;
        const ov = ovMap[String(t.id)] || null;
        if (ov && Number(ov.skipped) === 1) {
            skipped += 1;
            return;
        }
        const row = rowFromTemplate(t, targetYm, ov, orgAliases, finCred);
        if (!row) {
            skipped += 1;
            return;
        }
        const abs = Number(row.amount_abs) || 0;
        if (row.direction === 'out') totOut += abs;
        else totIn += abs;
        if (row.review_pending) reviewPending += 1;
        items.push({
            template_id: Number(t.id),
            purpose: row.purpose,
            direction: row.direction,
            day_of_month: clampDay(t.day_of_month),
            amount: abs,
            amount_fix: Number(row.amount_fix) || 0,
            amount_premium: row.amount_premium,
            scope: row.scope,
            customer_code: row.customer_code,
            needs_review: row.needs_review ? 1 : 0,
            review_pending: !!row.review_pending,
            include_chart: !!row.include_chart,
        });
    });
    totIn = Math.round(totIn * 100) / 100;
    totOut = Math.round(totOut * 100) / 100;
    return {
        ym: targetYm,
        in: totIn,
        out: totOut,
        net: Math.round((totIn - totOut) * 100) / 100,
        templates_total: (templates || []).length,
        templates_active: items.length,
        templates_skipped: skipped,
        review_pending: reviewPending,
        items: items,
    };
}

/**
 * Сводка для дашборда карточки «Наличные»: помесячная динамика + прогноз на след. месяц.
 */
async function buildCashSummary(db, finCred, orgAliases, opts) {
    const o = opts || {};
    const dateFrom = String(o.dateFrom || '').trim();
    const dateTo = String(o.dateTo || '').trim();
    const customerCodes = Array.isArray(o.customerCodes) ? o.customerCodes : [];
    const accountId = String(o.accountId || '').trim();
    const months = Array.isArray(o.months) && o.months.length ? o.months : monthsBetween(dateFrom, dateTo);
    const rows = await loadExpandedCashRows(db, finCred, orgAliases, {
        dateFrom,
        dateTo,
        customerCodes,
        accountId,
        chartOnly: false,
    });

    const byYm = Object.create(null);
    months.forEach(function (ym) {
        byYm[ym] = {
            once_in: 0,
            once_out: 0,
            tmpl_in: 0,
            tmpl_out: 0,
            count_once_in: 0,
            count_once_out: 0,
            count_tmpl: 0,
        };
    });
    (rows || []).forEach(function (r) {
        const ym = ymFromDate(r.booked_date);
        if (!ym || !byYm[ym]) return;
        const cell = byYm[ym];
        const abs = Number(r.amount_abs) || 0;
        const isOnce = String(r.cash_kind || '') === 'once';
        if (r.direction === 'out') {
            if (isOnce) {
                cell.once_out += abs;
                cell.count_once_out += 1;
            } else {
                cell.tmpl_out += abs;
                cell.count_tmpl += 1;
            }
        } else if (isOnce) {
            cell.once_in += abs;
            cell.count_once_in += 1;
        } else {
            cell.tmpl_in += abs;
            cell.count_tmpl += 1;
        }
    });

    // Факт на графике = только разовые. Шаблоны — KPI/прогноз, не в «Исход» столбца.
    const series = months.map(function (ym) {
        const c = byYm[ym];
        const onceIn = Math.round(c.once_in * 100) / 100;
        const onceOut = Math.round(c.once_out * 100) / 100;
        return {
            month: ym,
            in: onceIn,
            out: onceOut,
            net: Math.round((onceIn - onceOut) * 100) / 100,
            once_in: onceIn,
            once_out: onceOut,
            tmpl_in: Math.round(c.tmpl_in * 100) / 100,
            tmpl_out: Math.round(c.tmpl_out * 100) / 100,
            count_in: c.count_once_in,
            count_out: c.count_once_out,
            count_once: c.count_once_in + c.count_once_out,
            count_tmpl: c.count_tmpl,
        };
    });

    let totOnceIn = 0;
    let totOnceOut = 0;
    let totTmplOut = 0;
    let totTmplIn = 0;
    let totOnceCnt = 0;
    let totTmplCnt = 0;
    series.forEach(function (s) {
        totOnceIn += s.once_in;
        totOnceOut += s.once_out;
        totTmplOut += s.tmpl_out;
        totTmplIn += s.tmpl_in;
        totOnceCnt += s.count_once;
        totTmplCnt += s.count_tmpl;
    });

    // Прогноз всегда на календарный месяц после «сегодня» (не от конца фильтра периода).
    const todayYmd = String(o.todayYmd || '').trim();
    const todayYm =
        ymFromDate(todayYmd) ||
        ymFromDate(new Date().toISOString().slice(0, 10));
    const forecastYm = nextYm(todayYm);
    const forecast = await forecastTemplatesForYm(db, finCred, orgAliases, forecastYm, customerCodes);

    return {
        date_from: dateFrom,
        date_to: dateTo,
        months,
        currency: 'RUB',
        fact_source: 'once',
        series,
        totals: {
            in: Math.round(totOnceIn * 100) / 100,
            out: Math.round(totOnceOut * 100) / 100,
            net: Math.round((totOnceIn - totOnceOut) * 100) / 100,
            once_in: Math.round(totOnceIn * 100) / 100,
            once_out: Math.round(totOnceOut * 100) / 100,
            tmpl_in: Math.round(totTmplIn * 100) / 100,
            tmpl_out: Math.round(totTmplOut * 100) / 100,
            count: totOnceCnt,
            count_tmpl: totTmplCnt,
        },
        forecast,
    };
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
    nextYm,
    forecastTemplatesForYm,
    buildCashSummary,
};
