/**
 * Плановые денежные операции: статьи (несколько ИНН) + категории трат + overrides.
 * Факт: банк по любому ИНН статьи + нал с plan_item_id.
 */

const finCash = require('./datagonFinanceCash');

function normalizeInnDigits(raw) {
    return String(raw || '')
        .replace(/\D+/g, '')
        .slice(0, 12);
}

/**
 * Разбор контрагентов: строка ИНН / массив строк / массив { inn, name }.
 * @returns {{ inn: string, name: string }[]}
 */
function parseCounterparties(raw) {
    const seen = Object.create(null);
    const out = [];
    function push(innRaw, nameRaw) {
        const inn = normalizeInnDigits(innRaw);
        if (!inn || (inn.length !== 10 && inn.length !== 12)) return;
        if (seen[inn]) return;
        seen[inn] = 1;
        out.push({
            inn,
            name: String(nameRaw == null ? '' : nameRaw)
                .trim()
                .slice(0, 255),
        });
    }
    if (Array.isArray(raw)) {
        raw.forEach((p) => {
            if (p && typeof p === 'object') {
                push(p.inn != null ? p.inn : p.counterparty_inn, p.name != null ? p.name : p.counterparty);
            } else {
                push(p, '');
            }
        });
        return out;
    }
    String(raw == null ? '' : raw)
        .split(/[\s,;]+/)
        .forEach((p) => push(p, ''));
    return out;
}

/** @deprecated use parseCounterparties — возвращает только ИНН */
function parseInnsList(raw) {
    return parseCounterparties(raw).map((c) => c.inn);
}

function innsDisplay(inns) {
    if (!Array.isArray(inns) || !inns.length) return '';
    if (typeof inns[0] === 'object' && inns[0]) {
        return inns
            .map((c) => (c && c.inn) || '')
            .filter(Boolean)
            .join(', ');
    }
    return inns.filter(Boolean).join(', ');
}

function counterpartiesDisplay(list) {
    return (Array.isArray(list) ? list : [])
        .map((c) => {
            if (!c) return '';
            const inn = c.inn || '';
            const name = String(c.name || '').trim();
            return name ? name + ' (' + inn + ')' : inn;
        })
        .filter(Boolean)
        .join('; ');
}

async function ensureColumn(db, table, name, ddl) {
    const [cols] = await db.query(`SHOW COLUMNS FROM \`${table}\` LIKE ?`, [name]);
    if (!cols || !cols.length) {
        await db.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${name}\` ${ddl}`);
    }
}

async function ensurePlanTables(db) {
    await db.query(`
        CREATE TABLE IF NOT EXISTS dg_finance_plan_categories (
            id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
            title VARCHAR(120) NOT NULL DEFAULT '',
            active TINYINT(1) NOT NULL DEFAULT 1,
            sort_order INT NOT NULL DEFAULT 0,
            created_by VARCHAR(64) NOT NULL DEFAULT '',
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            PRIMARY KEY (id),
            KEY idx_fin_plan_cat_active (active, sort_order, title)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await db.query(`
        CREATE TABLE IF NOT EXISTS dg_finance_plan_items (
            id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
            title VARCHAR(255) NOT NULL DEFAULT '',
            counterparty_inn VARCHAR(255) NOT NULL DEFAULT '',
            category_id BIGINT UNSIGNED NULL DEFAULT NULL,
            direction VARCHAR(8) NOT NULL DEFAULT 'out',
            amount_plan DECIMAL(18,2) NOT NULL DEFAULT 0,
            scope VARCHAR(8) NOT NULL DEFAULT 'all',
            customer_code VARCHAR(64) NOT NULL DEFAULT '',
            include_cash TINYINT(1) NOT NULL DEFAULT 1,
            payment_form VARCHAR(8) NOT NULL DEFAULT 'bank',
            active TINYINT(1) NOT NULL DEFAULT 1,
            created_by VARCHAR(64) NOT NULL DEFAULT '',
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            PRIMARY KEY (id),
            KEY idx_fin_plan_inn (counterparty_inn(32)),
            KEY idx_fin_plan_active (active),
            KEY idx_fin_plan_cat (category_id),
            KEY idx_fin_plan_pay (payment_form)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await ensureColumn(db, 'dg_finance_plan_items', 'category_id', 'BIGINT UNSIGNED NULL DEFAULT NULL');
    await ensureColumn(db, 'dg_finance_plan_items', 'payment_form', "VARCHAR(8) NOT NULL DEFAULT 'bank'");
    try {
        await db.query(
            `ALTER TABLE dg_finance_plan_items MODIFY COLUMN counterparty_inn VARCHAR(255) NOT NULL DEFAULT ''`
        );
    } catch (_) {
        /* ignore */
    }
    try {
        await db.query(`
            UPDATE dg_finance_plan_items
               SET payment_form = CASE
                     WHEN include_cash = 1 AND TRIM(IFNULL(counterparty_inn,'')) <> '' THEN 'both'
                     WHEN include_cash = 1 THEN 'cash'
                     ELSE payment_form
                   END
             WHERE include_cash = 1
               AND (payment_form IS NULL OR payment_form = '' OR payment_form = 'bank')
        `);
    } catch (_) {
        /* ignore */
    }
    await db.query(`
        CREATE TABLE IF NOT EXISTS dg_finance_plan_item_inns (
            item_id BIGINT UNSIGNED NOT NULL,
            inn VARCHAR(12) NOT NULL,
            name VARCHAR(255) NOT NULL DEFAULT '',
            PRIMARY KEY (item_id, inn),
            KEY idx_fin_plan_inns_inn (inn)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await ensureColumn(db, 'dg_finance_plan_item_inns', 'name', "VARCHAR(255) NOT NULL DEFAULT ''");
    await db.query(`
        CREATE TABLE IF NOT EXISTS dg_finance_plan_overrides (
            item_id BIGINT UNSIGNED NOT NULL,
            ym CHAR(7) NOT NULL,
            amount_plan DECIMAL(18,2) NULL,
            skipped TINYINT(1) NOT NULL DEFAULT 0,
            updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            PRIMARY KEY (item_id, ym),
            KEY idx_fin_plan_ov_ym (ym)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await ensureColumn(db, 'dg_finance_cash_tx', 'plan_item_id', 'BIGINT UNSIGNED NULL DEFAULT NULL');
    await ensureColumn(db, 'dg_finance_cash_templates', 'plan_item_id', 'BIGINT UNSIGNED NULL DEFAULT NULL');

    // Миграция: один ИНН из counterparty_inn → таблица inns
    try {
        await db.query(`
            INSERT IGNORE INTO dg_finance_plan_item_inns (item_id, inn)
            SELECT i.id,
                   LEFT(REPLACE(REPLACE(REPLACE(IFNULL(i.counterparty_inn,''), ' ', ''), '-', ''), ',', ''), 12)
              FROM dg_finance_plan_items i
             WHERE i.counterparty_inn IS NOT NULL
               AND TRIM(i.counterparty_inn) <> ''
               AND NOT EXISTS (
                   SELECT 1 FROM dg_finance_plan_item_inns x WHERE x.item_id = i.id
               )
               AND CHAR_LENGTH(REPLACE(REPLACE(REPLACE(IFNULL(i.counterparty_inn,''), ' ', ''), '-', ''), ',', '')) IN (10, 12)
        `);
    } catch (_) {
        /* ignore */
    }
}

function parsePlanItemId(raw) {
    if (raw == null || raw === '' || raw === false) return null;
    const n = parseInt(String(raw), 10);
    if (!Number.isFinite(n) || n < 1) return null;
    return n;
}

function parseCategoryId(raw) {
    if (raw == null || raw === '' || raw === false) return null;
    const n = parseInt(String(raw), 10);
    if (!Number.isFinite(n) || n < 1) return null;
    return n;
}

/** @returns {'bank'|'cash'|'both'} */
function normalizePaymentForm(raw) {
    const s = String(raw || '')
        .trim()
        .toLowerCase();
    if (s === 'cash' || s === 'нал' || s === 'nal' || s === 'cash_only') return 'cash';
    if (s === 'both' || s === 'all' || s === 'bank_cash' || s === 'mixed') return 'both';
    return 'bank';
}

function paymentFormUsesBank(form) {
    const f = normalizePaymentForm(form);
    return f === 'bank' || f === 'both';
}

function paymentFormUsesCash(form) {
    const f = normalizePaymentForm(form);
    return f === 'cash' || f === 'both';
}

function paymentFormLabel(form) {
    const f = normalizePaymentForm(form);
    if (f === 'cash') return 'Нал';
    if (f === 'both') return 'Безнал + нал';
    return 'Безнал';
}

async function listPlanCategories(db, opts) {
    const o = opts || {};
    const where = [];
    const params = [];
    if (o.activeOnly) {
        where.push('active = 1');
    }
    const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const [rows] = await db.query(
        `SELECT id, title, active, sort_order, created_by, created_at, updated_at
           FROM dg_finance_plan_categories
           ${whereSql}
          ORDER BY active DESC, sort_order ASC, title ASC, id ASC`,
        params
    );
    return rows || [];
}

async function replaceItemInns(db, itemId, inns) {
    const list = parseCounterparties(inns);
    await db.query('DELETE FROM dg_finance_plan_item_inns WHERE item_id = ?', [itemId]);
    for (const c of list) {
        await db.query('INSERT INTO dg_finance_plan_item_inns (item_id, inn, name) VALUES (?, ?, ?)', [
            itemId,
            c.inn,
            c.name || '',
        ]);
    }
    await db.query('UPDATE dg_finance_plan_items SET counterparty_inn = ? WHERE id = ?', [
        innsDisplay(list),
        itemId,
    ]);
    return list;
}

async function loadInnsByItemIds(db, itemIds) {
    const map = Object.create(null);
    if (!itemIds || !itemIds.length) return map;
    const ph = itemIds.map(() => '?').join(',');
    const [rows] = await db.query(
        `SELECT item_id, inn, name FROM dg_finance_plan_item_inns WHERE item_id IN (${ph}) ORDER BY inn ASC`,
        itemIds
    );
    (rows || []).forEach((r) => {
        const id = Number(r.item_id);
        if (!map[id]) map[id] = [];
        const inn = normalizeInnDigits(r.inn);
        if (inn) {
            map[id].push({
                inn,
                name: String(r.name || '').trim(),
            });
        }
    });
    return map;
}

function parseIdList(raw) {
    if (raw == null) return [];
    const arr = Array.isArray(raw) ? raw : String(raw).split(/[\s,;]+/);
    const seen = Object.create(null);
    const out = [];
    arr.forEach((v) => {
        const n = parseInt(String(v).trim(), 10);
        if (!Number.isFinite(n) || n < 1 || seen[n]) return;
        seen[n] = true;
        out.push(n);
    });
    return out;
}

/**
 * Привязать шаблоны/разовые наличные к статье плана.
 * Один cash-шаблон/разовая — только к одной статье.
 * Если usesCash=false — снимает все привязки к itemId.
 */
async function syncPlanCashLinks(db, itemId, opts) {
    const id = Number(itemId);
    if (!Number.isFinite(id) || id < 1) return { templates: [], once: [] };
    const o = opts || {};
    const usesCash = o.usesCash !== false;
    if (!usesCash) {
        await db.query('UPDATE dg_finance_cash_tx SET plan_item_id = NULL WHERE plan_item_id = ?', [id]);
        await db.query('UPDATE dg_finance_cash_templates SET plan_item_id = NULL WHERE plan_item_id = ?', [id]);
        return { templates: [], once: [] };
    }
    if (Object.prototype.hasOwnProperty.call(o, 'templateIds')) {
        const ids = parseIdList(o.templateIds);
        if (!ids.length) {
            await db.query('UPDATE dg_finance_cash_templates SET plan_item_id = NULL WHERE plan_item_id = ?', [id]);
        } else {
            const ph = ids.map(() => '?').join(',');
            await db.query(
                `UPDATE dg_finance_cash_templates SET plan_item_id = NULL
                  WHERE plan_item_id = ? AND id NOT IN (${ph})`,
                [id].concat(ids)
            );
            await db.query(
                `UPDATE dg_finance_cash_templates SET plan_item_id = ? WHERE id IN (${ph})`,
                [id].concat(ids)
            );
        }
    }
    if (Object.prototype.hasOwnProperty.call(o, 'onceIds')) {
        const ids = parseIdList(o.onceIds);
        if (!ids.length) {
            await db.query('UPDATE dg_finance_cash_tx SET plan_item_id = NULL WHERE plan_item_id = ?', [id]);
        } else {
            const ph = ids.map(() => '?').join(',');
            await db.query(
                `UPDATE dg_finance_cash_tx SET plan_item_id = NULL
                  WHERE plan_item_id = ? AND id NOT IN (${ph})`,
                [id].concat(ids)
            );
            await db.query(`UPDATE dg_finance_cash_tx SET plan_item_id = ? WHERE id IN (${ph})`, [id].concat(ids));
        }
    }
    const [tmpl] = await db.query(
        'SELECT id FROM dg_finance_cash_templates WHERE plan_item_id = ? ORDER BY id ASC',
        [id]
    );
    const [once] = await db.query(
        'SELECT id FROM dg_finance_cash_tx WHERE plan_item_id = ? ORDER BY id ASC',
        [id]
    );
    return {
        templates: (tmpl || []).map((r) => Number(r.id)),
        once: (once || []).map((r) => Number(r.id)),
    };
}

async function loadCashLinksByItemIds(db, itemIds) {
    const map = Object.create(null);
    if (!itemIds || !itemIds.length) return map;
    itemIds.forEach((id) => {
        map[Number(id)] = { cash_template_ids: [], cash_once_ids: [] };
    });
    const ph = itemIds.map(() => '?').join(',');
    const [tmpl] = await db.query(
        `SELECT id, plan_item_id FROM dg_finance_cash_templates
          WHERE plan_item_id IN (${ph}) ORDER BY id ASC`,
        itemIds
    );
    const [once] = await db.query(
        `SELECT id, plan_item_id FROM dg_finance_cash_tx
          WHERE plan_item_id IN (${ph}) ORDER BY id ASC`,
        itemIds
    );
    (tmpl || []).forEach((r) => {
        const pid = Number(r.plan_item_id);
        if (!map[pid]) map[pid] = { cash_template_ids: [], cash_once_ids: [] };
        map[pid].cash_template_ids.push(Number(r.id));
    });
    (once || []).forEach((r) => {
        const pid = Number(r.plan_item_id);
        if (!map[pid]) map[pid] = { cash_template_ids: [], cash_once_ids: [] };
        map[pid].cash_once_ids.push(Number(r.id));
    });
    return map;
}

async function listPlanItems(db, opts) {
    const o = opts || {};
    const where = [];
    const params = [];
    if (o.activeOnly) {
        where.push('i.active = 1');
    }
    const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const [rows] = await db.query(
        `SELECT i.id, i.title, i.counterparty_inn, i.category_id, i.direction, i.amount_plan,
                i.scope, i.customer_code, i.include_cash, i.payment_form, i.active,
                i.created_by, i.created_at, i.updated_at,
                c.title AS category_title
           FROM dg_finance_plan_items i
           LEFT JOIN dg_finance_plan_categories c ON c.id = i.category_id
           ${whereSql}
          ORDER BY i.active DESC, c.sort_order ASC, c.title ASC, i.title ASC, i.id ASC`,
        params
    );
    const list = rows || [];
    const innsMap = await loadInnsByItemIds(
        db,
        list.map((r) => r.id)
    );
    const cashMap = await loadCashLinksByItemIds(
        db,
        list.map((r) => r.id)
    );
    return list.map((r) => {
        let counterparties = innsMap[Number(r.id)] || [];
        if (!counterparties.length && r.counterparty_inn) {
            counterparties = parseCounterparties(r.counterparty_inn);
        }
        const inns = counterparties.map((c) => c.inn);
        let paymentForm = normalizePaymentForm(r.payment_form);
        if (!r.payment_form || r.payment_form === '') {
            paymentForm = Number(r.include_cash) !== 0 ? (inns.length ? 'both' : 'cash') : 'bank';
        }
        const links = cashMap[Number(r.id)] || { cash_template_ids: [], cash_once_ids: [] };
        return {
            ...r,
            counterparties,
            inns,
            counterparty_inn: innsDisplay(counterparties) || String(r.counterparty_inn || ''),
            counterparties_label: counterpartiesDisplay(counterparties),
            category_id: r.category_id != null ? Number(r.category_id) : null,
            category_title: r.category_title != null ? String(r.category_title) : '',
            payment_form: paymentForm,
            payment_form_label: paymentFormLabel(paymentForm),
            include_cash: paymentFormUsesCash(paymentForm) ? 1 : 0,
            cash_template_ids: links.cash_template_ids,
            cash_once_ids: links.cash_once_ids,
            cash_links_count: links.cash_template_ids.length + links.cash_once_ids.length,
        };
    });
}

function planAmountForMonth(item, override) {
    if (override && Number(override.skipped) === 1) return null;
    if (override && override.amount_plan != null && override.amount_plan !== '') {
        return Math.round((Number(override.amount_plan) || 0) * 100) / 100;
    }
    return Math.round((Number(item.amount_plan) || 0) * 100) / 100;
}

/**
 * Матрица план/факт по месяцам.
 * @param {{ dateFrom: string, dateTo: string, customerCodes?: string[], currency?: string }} opts
 */
async function loadPlanMatrix(db, finCred, orgAliases, opts) {
    const o = opts || {};
    const dateFrom = String(o.dateFrom || '').trim();
    const dateTo = String(o.dateTo || '').trim();
    const currency = String(o.currency || 'RUB').toUpperCase() === 'RUB' ? 'RUB' : String(o.currency || 'RUB');
    const customerCodes = Array.isArray(o.customerCodes) ? o.customerCodes.filter(Boolean) : [];
    const yms = finCash.monthsBetween(dateFrom, dateTo);
    const items = await listPlanItems(db, { activeOnly: false });

    const itemIds = items.map((it) => it.id);
    let overrides = [];
    if (itemIds.length && yms.length) {
        const ph = itemIds.map(() => '?').join(',');
        const yph = yms.map(() => '?').join(',');
        const [ovRows] = await db.query(
            `SELECT item_id, ym, amount_plan, skipped
               FROM dg_finance_plan_overrides
              WHERE item_id IN (${ph}) AND ym IN (${yph})`,
            itemIds.concat(yms)
        );
        overrides = ovRows || [];
    }
    const ovMap = Object.create(null);
    overrides.forEach((ov) => {
        ovMap[String(ov.item_id) + '\0' + String(ov.ym)] = ov;
    });

    const bankWhere = [
        't.booked_date IS NOT NULL',
        't.booked_date >= ?',
        't.booked_date <= ?',
        't.direction = ?',
        't.currency = ?',
    ];
    const bankParams = [dateFrom, dateTo, 'out', currency];
    if (customerCodes.length) {
        const ph = customerCodes.map(() => '?').join(',');
        bankWhere.push(`a.customer_code IN (${ph})`);
        bankParams.push(...customerCodes);
    }
    const [bankRows] = await db.query(
        `SELECT DATE_FORMAT(t.booked_date, '%Y-%m') AS ym,
                REPLACE(REPLACE(IFNULL(t.counterparty_inn,''), ' ', ''), '-', '') AS inn,
                SUM(t.amount_abs) AS sum_abs
           FROM dg_finance_tx t
           LEFT JOIN dg_finance_accounts a ON a.bank = t.bank AND a.account_id = t.account_id
          WHERE ${bankWhere.join(' AND ')}
          GROUP BY ym, inn`,
        bankParams
    );
    const bankFact = Object.create(null);
    (bankRows || []).forEach((r) => {
        const inn = normalizeInnDigits(r.inn);
        const ym = String(r.ym || '');
        if (!inn || !/^\d{4}-\d{2}$/.test(ym)) return;
        bankFact[inn + '\0' + ym] = Math.round((Number(r.sum_abs) || 0) * 100) / 100;
    });

    const cashRows = await finCash.loadExpandedCashRows(db, finCred, orgAliases, {
        dateFrom,
        dateTo,
        customerCodes,
        chartOnly: false,
    });
    const cashFact = Object.create(null);
    (cashRows || []).forEach((r) => {
        const pid = parsePlanItemId(r.plan_item_id);
        if (!pid) return;
        if (String(r.direction || '') !== 'out') return;
        const ym = finCash.ymFromDate(r.booked_date);
        if (!ym) return;
        const key = pid + '\0' + ym;
        cashFact[key] = (cashFact[key] || 0) + (Number(r.amount_abs) || 0);
    });
    Object.keys(cashFact).forEach((k) => {
        cashFact[k] = Math.round(cashFact[k] * 100) / 100;
    });

    const byPay = {
        bank: { plan: 0, fact: 0, fact_bank: 0, fact_cash: 0, items: 0 },
        cash: { plan: 0, fact: 0, fact_bank: 0, fact_cash: 0, items: 0 },
        both: { plan: 0, fact: 0, fact_bank: 0, fact_cash: 0, items: 0 },
    };

    const series = items.map((item) => {
        const counterparties = Array.isArray(item.counterparties)
            ? item.counterparties
            : parseCounterparties(item.inns != null ? item.inns : item.counterparty_inn);
        const inns = counterparties.map((c) => c.inn);
        const paymentForm = normalizePaymentForm(item.payment_form);
        const useBank = paymentFormUsesBank(paymentForm);
        const useCash = paymentFormUsesCash(paymentForm);
        const months = yms.map((ym) => {
            const ov = ovMap[String(item.id) + '\0' + ym];
            const plan = planAmountForMonth(item, ov);
            const skipped = ov && Number(ov.skipped) === 1;
            let factBank = 0;
            if (useBank) {
                inns.forEach((inn) => {
                    factBank += bankFact[inn + '\0' + ym] || 0;
                });
                factBank = Math.round(factBank * 100) / 100;
            }
            const factCash = useCash ? cashFact[item.id + '\0' + ym] || 0 : 0;
            const fact = Math.round((factBank + factCash) * 100) / 100;
            const delta = plan == null ? null : Math.round((fact - plan) * 100) / 100;
            return {
                ym,
                plan,
                skipped: !!skipped,
                fact_bank: factBank,
                fact_cash: factCash,
                fact,
                delta,
            };
        });
        let totPlan = 0;
        let totFact = 0;
        let totBank = 0;
        let totCash = 0;
        let planMonths = 0;
        months.forEach((m) => {
            if (m.plan != null) {
                totPlan += m.plan;
                planMonths += 1;
            }
            totFact += m.fact;
            totBank += m.fact_bank;
            totCash += m.fact_cash;
        });
        const totals = {
            plan: Math.round(totPlan * 100) / 100,
            fact_bank: Math.round(totBank * 100) / 100,
            fact_cash: Math.round(totCash * 100) / 100,
            fact: Math.round(totFact * 100) / 100,
            delta: planMonths ? Math.round((totFact - totPlan) * 100) / 100 : null,
        };
        const bucket = byPay[paymentForm] || byPay.bank;
        bucket.items += 1;
        bucket.plan += totals.plan;
        bucket.fact += totals.fact;
        bucket.fact_bank += totals.fact_bank;
        bucket.fact_cash += totals.fact_cash;
        return {
            id: Number(item.id),
            title: String(item.title || ''),
            inns,
            counterparties,
            counterparty_inn: innsDisplay(counterparties),
            counterparties_label: counterpartiesDisplay(counterparties),
            category_id: item.category_id != null ? Number(item.category_id) : null,
            category_title: String(item.category_title || ''),
            payment_form: paymentForm,
            payment_form_label: paymentFormLabel(paymentForm),
            direction: String(item.direction || 'out'),
            amount_plan: Math.round((Number(item.amount_plan) || 0) * 100) / 100,
            scope: String(item.scope || 'all'),
            customer_code: String(item.customer_code || ''),
            include_cash: useCash ? 1 : 0,
            active: Number(item.active) === 1,
            months,
            totals,
        };
    });

    Object.keys(byPay).forEach((k) => {
        byPay[k].plan = Math.round(byPay[k].plan * 100) / 100;
        byPay[k].fact = Math.round(byPay[k].fact * 100) / 100;
        byPay[k].fact_bank = Math.round(byPay[k].fact_bank * 100) / 100;
        byPay[k].fact_cash = Math.round(byPay[k].fact_cash * 100) / 100;
    });

    return {
        date_from: dateFrom,
        date_to: dateTo,
        months: yms,
        currency,
        items: series,
        by_payment_form: byPay,
    };
}

module.exports = {
    ensurePlanTables,
    normalizeInnDigits,
    parseInnsList,
    parseCounterparties,
    innsDisplay,
    counterpartiesDisplay,
    parsePlanItemId,
    parseCategoryId,
    parseIdList,
    normalizePaymentForm,
    paymentFormUsesBank,
    paymentFormUsesCash,
    paymentFormLabel,
    listPlanCategories,
    listPlanItems,
    replaceItemInns,
    syncPlanCashLinks,
    loadCashLinksByItemIds,
    loadPlanMatrix,
    planAmountForMonth,
};
