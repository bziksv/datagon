'use strict';

const crypto = require('crypto');
const express = require('express');
const {
    computeRow,
    toNum,
    pctMpFromMonthTotal,
    DEFAULT_PLAN_AMOUNT,
    scaledPlanSteps,
    parseStoredSteps,
    stepsToJson,
    normalizePlanSteps,
    cloneDefaultSteps,
    normHasContract,
    STATUS_VALUES,
    normStatus,
    INVOICE_MARKS,
    invoiceMarkLabel,
    normInvoiceMark,
    OUR_INVOICE_MARK_GREEN,
    OUR_INVOICE_MARK_LABEL,
    ourInvoiceMarkLabel,
    normOurInvoiceMark,
    applySuppliersPatch,
    resolveSuppliersList,
    flattenSuppliers,
    splitNonEmptyLines,
} = require('../lib/managerSalesCalc');

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
const MIN_YEAR = 2019;
const MAX_YEAR = 2100;

const SORT_KEYS = new Set([
    'row_no',
    'manager_name',
    'paid_at',
    'invoice_org',
    'amount_ex_delivery',
    'vat',
    'amount_incl_stock',
    'delivery_to_us',
    'supplier_name',
    'diff',
    'pct_r',
    'status',
    'pct_mp',
    'bonus',
    'id',
    'updated_at',
]);

const PATCH_FIELDS = new Set([
    'payment_terms',
    'paid_at',
    'invoice_org',
    'order_url',
    'amount_ex_delivery',
    'vat',
    'our_invoice_no',
    'has_contract',
    'supplier_invoice_url',
    'amount_incl_stock',
    'delivery_to_us',
    'supplier_name',
    'supplier_invoice_no',
    'status',
    'invoice_mark',
    'our_invoice_mark',
    'year',
    'manager_user_id',
]);

const CSV_HEADERS = [
    { key: 'row_no', aliases: ['№', 'no', 'n', 'номер'] },
    { key: 'payment_terms', aliases: ['условия оплаты'] },
    { key: 'paid_at', aliases: ['дата оплаты'] },
    { key: 'invoice_org', aliases: ['счет от ип или ооо', 'счёт от ип или ооо', 'ип или ооо'] },
    { key: 'order_url', aliases: ['ссылка на заказ на сайте almamed.su или сателитах', 'ссылка на заказ'] },
    { key: 'amount_ex_delivery', aliases: ['сумма оплаты без доставки'] },
    { key: 'vat', aliases: ['ндс'] },
    { key: 'our_invoice_no', aliases: ['№ нашего счета', '№ нашего счёта', 'номер нашего счета'] },
    { key: 'has_contract', aliases: ['наличие договора'] },
    { key: 'supplier_invoice_url', aliases: ['ссылка на счет поставщика', 'ссылка на счёт поставщика'] },
    { key: 'amount_incl_stock', aliases: ['сумма оплаты (включая складские запасы)', 'сумма оплаты включая складские запасы'] },
    { key: 'delivery_to_us', aliases: ['доставка до нас'] },
    { key: 'supplier_name', aliases: ['поставщик'] },
    { key: 'supplier_invoice_no', aliases: ['№ счета поставщика', '№ счёта поставщика'] },
    { key: 'diff', aliases: ['разница'] },
    { key: 'pct_r', aliases: ['% р.', '% р', '%р.'] },
    { key: 'status', aliases: ['статус'] },
    { key: 'pct_mp', aliases: ['% мп.', '% мп', '%мп.'] },
    { key: 'bonus', aliases: ['премия'] },
];

let schemaReady = false;

function clip(s, max) {
    const t = String(s == null ? '' : s).trim();
    if (!max || t.length <= max) return t;
    return t.slice(0, max);
}

function currentYear() {
    return new Date().getFullYear();
}

function normYear(v, fallback) {
    const n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    const y = Math.round(n);
    if (y < MIN_YEAR || y > MAX_YEAR) return fallback;
    return y;
}

function pageMode(req) {
    const actor = req.datagonActor || {};
    if (actor.username === 'admin') return 'full';
    const raw = actor.page_modes && actor.page_modes['manager-sales'];
    return raw === 'view' || raw === 'hidden' || raw === 'full' ? raw : 'full';
}

function canWrite(req) {
    return pageMode(req) === 'full';
}

const SEE_ALL_SPECIALTIES = new Set(['полный доступ', 'бухгалтерия']);
const SALES_SPECIALTY_NAME = 'Менеджер по продажам';

const FIELD_LOG_LABELS = {
    _row: 'Строка',
    year: 'Год',
    manager_user_id: 'Менеджер',
    row_no: '№',
    payment_terms: 'Условия оплаты',
    paid_at: 'Дата оплаты',
    invoice_org: 'Счет от ИП или ООО',
    order_url: 'Ссылка на заказ',
    amount_ex_delivery: 'Сумма оплаты без доставки',
    vat: 'НДС',
    our_invoice_no: '№ нашего счета',
    has_contract: 'Наличие договора',
    supplier_invoice_url: 'Ссылка на счет поставщика',
    amount_incl_stock: 'Сумма оплаты (включая складские запасы)',
    suppliers_json: 'Поставщики закупки',
    delivery_to_us: 'Доставка до нас',
    supplier_name: 'Поставщик',
    supplier_invoice_no: '№ счета поставщика',
    diff: 'Разница',
    pct_r: '% Р.',
    status: 'Статус',
    pct_mp: '% МП.',
    bonus: 'Премия',
    archived: 'Архив',
    handed_to_user_id: 'Передан',
    invoice_mark: 'Подсветка счёта поставщика',
    our_invoice_mark: 'Подсветка нашего счёта',
    comment: 'Комментарий',
    ship_group_id: 'Отправка вместе',
};

const LOG_COMPARE_KEYS = [
    'year',
    'manager_user_id',
    'row_no',
    'payment_terms',
    'paid_at',
    'invoice_org',
    'order_url',
    'amount_ex_delivery',
    'vat',
    'our_invoice_no',
    'has_contract',
    'supplier_invoice_url',
    'amount_incl_stock',
    'delivery_to_us',
    'supplier_name',
    'supplier_invoice_no',
    'diff',
    'pct_r',
    'status',
    'pct_mp',
    'bonus',
    'handed_to_user_id',
    'invoice_mark',
    'our_invoice_mark',
    'suppliers_json',
    'ship_group_id',
];

function actorSpecialtyName(req) {
    const actor = req && req.datagonActor;
    return String((actor && actor.specialty_name) || '')
        .trim()
        .toLowerCase();
}

/** Чужие таблицы — только admin, «Полный доступ» и «Бухгалтерия». Остальные видят свою. */
function canSeeAll(req) {
    const actor = req && req.datagonActor;
    if (!actor) return false;
    if (actor.username === 'admin') return true;
    return SEE_ALL_SPECIALTIES.has(actorSpecialtyName(req));
}

function actorId(req) {
    const id = req.datagonActor && req.datagonActor.id;
    const n = Number(id);
    return Number.isFinite(n) && n > 0 ? n : null;
}

function actorDisplayName(actor) {
    if (!actor) return '';
    return String(actor.full_name || actor.username || '').trim();
}

/** «Евгения К.» из «Евгения Клевцова» */
function shortPersonName(full) {
    const parts = String(full || '')
        .trim()
        .split(/\s+/)
        .filter(Boolean);
    if (!parts.length) return '';
    if (parts.length === 1) return parts[0];
    const initial = parts[1].charAt(0);
    if (!initial) return parts[0];
    return `${parts[0]} ${initial.toUpperCase()}.`;
}

function formatCommentDate(dt) {
    if (!dt) return '';
    const d = dt instanceof Date ? dt : new Date(dt);
    if (Number.isNaN(d.getTime())) return '';
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    return `${dd}.${mm}.${d.getFullYear()}`;
}

function mapComment(r, actorUserId) {
    const authorId = r.author_user_id != null ? Number(r.author_user_id) : null;
    const full = String(r.author_name || '').trim();
    return {
        id: Number(r.id),
        row_id: Number(r.row_id),
        body: String(r.body || ''),
        author_user_id: Number.isFinite(authorId) && authorId > 0 ? authorId : null,
        author_name: full,
        author_short: shortPersonName(full) || (authorId ? String(authorId) : ''),
        created_at: r.created_at ? new Date(r.created_at).toISOString() : '',
        updated_at: r.updated_at ? new Date(r.updated_at).toISOString() : '',
        created_at_label: formatCommentDate(r.created_at),
        can_edit: actorUserId != null && authorId === actorUserId,
    };
}

async function loadCommentsByRowIds(db, rowIds, actorUserId) {
    const ids = [...new Set((rowIds || []).map(Number).filter((n) => Number.isFinite(n) && n > 0))];
    const out = {};
    ids.forEach((id) => {
        out[id] = [];
    });
    if (!ids.length) return out;
    const [rows] = await db.query(
        `SELECT id, row_id, body, author_user_id, author_name, created_at, updated_at
           FROM dg_manager_sales_comments
          WHERE row_id IN (${ids.map(() => '?').join(',')})
          ORDER BY id DESC`,
        ids
    );
    (rows || []).forEach((r) => {
        const rid = Number(r.row_id);
        if (!out[rid]) out[rid] = [];
        out[rid].push(mapComment(r, actorUserId));
    });
    return out;
}

async function attachComments(db, mappedRows, actorUserId) {
    const list = mappedRows || [];
    if (!list.length) return list;
    const byId = await loadCommentsByRowIds(
        db,
        list.map((r) => r.id),
        actorUserId
    );
    return list.map((r) => Object.assign({}, r, { comments: byId[r.id] || [] }));
}

function newShipGroupId() {
    return crypto.randomBytes(8).toString('hex');
}

function normShipGroupId(v) {
    const t = String(v == null ? '' : v)
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_-]/g, '');
    if (!t) return '';
    return t.length > 32 ? t.slice(0, 32) : t;
}

function normOurInvoiceLookup(v) {
    return String(v == null ? '' : v)
        .trim()
        .replace(/\s+/g, ' ');
}

async function loadShipMatesByGroupIds(db, groupIds, excludeIds) {
    const gids = [...new Set((groupIds || []).map(normShipGroupId).filter(Boolean))];
    const out = {};
    gids.forEach((g) => {
        out[g] = [];
    });
    if (!gids.length) return out;
    const exclude = new Set((excludeIds || []).map(Number).filter((n) => Number.isFinite(n) && n > 0));
    const [rows] = await db.query(
        `SELECT r.id, r.ship_group_id, r.our_invoice_no, r.row_no, r.manager_user_id, r.year,
                u.full_name AS manager_full_name, u.username AS manager_username
           FROM dg_manager_sales_rows r
           LEFT JOIN users u ON u.id = r.manager_user_id
          WHERE r.archived_at IS NULL
            AND r.ship_group_id IN (${gids.map(() => '?').join(',')})
          ORDER BY r.row_no ASC, r.id ASC`,
        gids
    );
    (rows || []).forEach((r) => {
        const gid = normShipGroupId(r.ship_group_id);
        if (!gid || !out[gid]) return;
        const id = Number(r.id);
        if (exclude.has(id)) return;
        out[gid].push({
            id,
            our_invoice_no: r.our_invoice_no || '',
            row_no: r.row_no != null ? Number(r.row_no) : 0,
            manager_user_id: Number(r.manager_user_id) || 0,
            manager_name: String(r.manager_full_name || r.manager_username || '').trim(),
            year: Number(r.year) || 0,
        });
    });
    return out;
}

async function attachShipGroupMates(db, mappedRows) {
    const list = mappedRows || [];
    if (!list.length) return list;
    /* грузим всю группу целиком; «себя» вычитаем уже на строке —
       иначе если обе связанные строки в одной выдаче (поиск по № счёта),
       они вычёркивались из mates и чип «Отправка вместе» пропадал */
    const byGid = await loadShipMatesByGroupIds(
        db,
        list.map((r) => r.ship_group_id),
        []
    );
    return list.map((r) => {
        const gid = normShipGroupId(r.ship_group_id);
        const all = gid ? byGid[gid] || [] : [];
        const selfId = Number(r.id);
        const mates = all.filter((m) => Number(m.id) !== selfId);
        return Object.assign({}, r, {
            ship_group_id: gid || '',
            ship_group_mates: mates,
            ship_group_size: gid ? mates.length + 1 : 0,
        });
    });
}

async function decorateRows(db, mappedRows, actorUserId) {
    const withComments = await attachComments(db, mappedRows, actorUserId);
    return attachShipGroupMates(db, withComments);
}

async function findRowsByOurInvoice(db, { year, invoiceNo, excludeId }) {
    const inv = normOurInvoiceLookup(invoiceNo);
    if (!inv) return [];
    const y = Number(year);
    const params = [y, inv.toLowerCase()];
    let sql = `SELECT ${ROW_SELECT}
                 FROM ${ROW_FROM}
                WHERE r.year = ?
                  AND r.archived_at IS NULL
                  AND LOWER(TRIM(COALESCE(r.our_invoice_no,''))) = ?
                  AND TRIM(COALESCE(r.our_invoice_no,'')) <> ''`;
    const ex = Number(excludeId);
    if (Number.isFinite(ex) && ex > 0) {
        sql += ' AND r.id <> ?';
        params.push(ex);
    }
    sql += ' ORDER BY r.id ASC LIMIT 10';
    const [rows] = await db.query(sql, params);
    return rows || [];
}

async function setRowsShipGroup(db, rowIds, groupId, actor) {
    const ids = [...new Set((rowIds || []).map(Number).filter((n) => Number.isFinite(n) && n > 0))];
    if (!ids.length) return;
    const gid = groupId == null || groupId === '' ? null : normShipGroupId(groupId) || null;
    await db.query(
        `UPDATE dg_manager_sales_rows
            SET ship_group_id = ?, updated_by = ?
          WHERE id IN (${ids.map(() => '?').join(',')})`,
        [gid, actor || null].concat(ids)
    );
}

async function dissolveLonelyShipGroups(db, groupIds, actor) {
    const gids = [...new Set((groupIds || []).map(normShipGroupId).filter(Boolean))];
    for (const gid of gids) {
        const [rows] = await db.query(
            `SELECT id FROM dg_manager_sales_rows
              WHERE ship_group_id = ? AND archived_at IS NULL`,
            [gid]
        );
        if ((rows || []).length === 1) {
            const aloneId = Number(rows[0].id);
            await setRowsShipGroup(db, [aloneId], null, actor);
            try {
                await insertRowLog(db, {
                    rowId: aloneId,
                    field: 'ship_group_id',
                    oldValue: gid,
                    newValue: '',
                    action: 'ship_dissolve',
                    source: 'ui',
                    actor: null,
                    note: 'осталась одна строка в связке',
                });
            } catch (_) {}
        }
    }
}

function normCommentBody(v) {
    const t = String(v == null ? '' : v).trim();
    if (!t) return '';
    return t.length > 2000 ? t.slice(0, 2000) : t;
}

function clipLogVal(v) {
    if (v == null || v === '') return null;
    const s = String(v);
    return s.length > 512 ? s.slice(0, 509) + '…' : s;
}

function logScalar(v) {
    if (v == null || v === '') return null;
    if (v instanceof Date && !isNaN(v.getTime())) return sqlDate(v);
    return clipLogVal(v);
}

async function listSalesManagers(db) {
    const [users] = await db.query(
        `SELECT u.id, u.username, u.full_name
           FROM users u
           INNER JOIN specialties s ON s.id = u.specialty_id
          WHERE COALESCE(u.is_archived, 0) = 0
            AND s.name = ?
          ORDER BY COALESCE(NULLIF(u.full_name,''), u.username)`,
        [SALES_SPECIALTY_NAME]
    );
    return (users || []).map((u) => ({
        id: Number(u.id),
        username: u.username || '',
        full_name: u.full_name || u.username || '',
    }));
}

async function insertRowLog(db, opts) {
    const rowId = Number(opts.rowId);
    if (!Number.isFinite(rowId) || rowId < 1) return;
    const field = String(opts.field || '').trim();
    if (!field) return;
    const actor = opts.actor || null;
    const uid = actor && actor.id != null ? Number(actor.id) : null;
    await db.query(
        `INSERT INTO dg_manager_sales_log
            (row_id, field, old_value, new_value, action, source, changed_by_user_id, changed_by_name, note)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            rowId,
            field.slice(0, 64),
            clipLogVal(opts.oldValue),
            clipLogVal(opts.newValue),
            String(opts.action || 'set').slice(0, 32),
            String(opts.source || 'ui').slice(0, 32),
            Number.isFinite(uid) ? uid : null,
            actorDisplayName(actor) || null,
            opts.note != null ? clipLogVal(opts.note) : null,
        ]
    );
}

function valuesEqualForLog(a, b) {
    if (a == null && b == null) return true;
    if (a == null || b == null) return String(a ?? '') === String(b ?? '');
    const na = Number(a);
    const nb = Number(b);
    if (Number.isFinite(na) && Number.isFinite(nb) && String(a).trim() !== '' && String(b).trim() !== '') {
        return Math.abs(na - nb) < 1e-9;
    }
    return String(a).trim() === String(b).trim();
}

function invoiceMarkLogLabel(v) {
    const key = normInvoiceMark(v);
    if (!key) return '';
    const hit = INVOICE_MARKS.find((x) => x.key === key);
    return hit ? hit.title : key;
}

function invoiceMarkChangeLogValues(oldM, newM) {
    const oldL = invoiceMarkLogLabel(oldM);
    const newL = invoiceMarkLogLabel(newM);
    if (!oldM && newM) return { oldValue: '', newValue: `${newL} установлен` };
    if (oldM && !newM) return { oldValue: oldL, newValue: 'снят' };
    return { oldValue: oldL || '', newValue: newL ? `${newL} установлен` : 'снят' };
}

function suppliersMarksSignature(row) {
    return resolveSuppliersList(row)
        .map((s, i) => `${i}:${normInvoiceMark(s && s.invoice_mark)}`)
        .join('|');
}

async function logSupplierInvoiceMarkChanges(db, { rowId, before, after, actor, source, action }) {
    const beforeList = resolveSuppliersList(before);
    const afterList = resolveSuppliersList(after);
    const n = Math.max(beforeList.length, afterList.length);
    if (!n) return;
    for (let i = 0; i < n; i += 1) {
        const oldM = normInvoiceMark(beforeList[i] && beforeList[i].invoice_mark);
        const newM = normInvoiceMark(afterList[i] && afterList[i].invoice_mark);
        if (oldM === newM) continue;
        const url = String(
            ((afterList[i] && afterList[i].supplier_invoice_url) ||
                (beforeList[i] && beforeList[i].supplier_invoice_url) ||
                '')
        ).trim();
        const noteBits = [];
        if (n > 1) noteBits.push(`поставщик #${i + 1}`);
        if (url) noteBits.push(url);
        const vals = invoiceMarkChangeLogValues(oldM, newM);
        await insertRowLog(db, {
            rowId,
            field: 'invoice_mark',
            oldValue: vals.oldValue,
            newValue: vals.newValue,
            action: action || 'set',
            source: source || 'ui',
            actor,
            note: noteBits.length ? noteBits.join(' · ') : null,
        });
    }
}

async function logRowChanges(db, { rowId, before, after, actor, source, action }) {
    if (!before || !after) return;
    const marksBefore = suppliersMarksSignature(before);
    const marksAfter = suppliersMarksSignature(after);
    if (marksBefore !== marksAfter) {
        await logSupplierInvoiceMarkChanges(db, { rowId, before, after, actor, source, action });
    }
    for (const key of LOG_COMPARE_KEYS) {
        if (key === 'invoice_mark') continue;
        if (key === 'suppliers_json' && marksBefore !== marksAfter) {
            const onlyMark =
                String(before.supplier_invoice_url || '') === String(after.supplier_invoice_url || '') &&
                String(before.supplier_name || '') === String(after.supplier_name || '') &&
                String(before.supplier_invoice_no || '') === String(after.supplier_invoice_no || '') &&
                valuesEqualForLog(before.amount_incl_stock, after.amount_incl_stock) &&
                valuesEqualForLog(before.delivery_to_us, after.delivery_to_us) &&
                resolveSuppliersList(before).length === resolveSuppliersList(after).length;
            if (onlyMark) continue;
        }
        const oldRaw = before[key];
        const newRaw = after[key];
        let oldDisp;
        let newDisp;
        if (key === 'paid_at') {
            oldDisp = sqlDate(oldRaw) || logScalar(oldRaw);
            newDisp = sqlDate(newRaw) || logScalar(newRaw);
        } else if (key === 'our_invoice_mark') {
            const vals = invoiceMarkChangeLogValues(normInvoiceMark(oldRaw), normInvoiceMark(newRaw));
            oldDisp = vals.oldValue;
            newDisp = vals.newValue;
        } else {
            oldDisp = logScalar(oldRaw);
            newDisp = logScalar(newRaw);
        }
        if (valuesEqualForLog(oldDisp, newDisp)) continue;
        await insertRowLog(db, {
            rowId,
            field: key,
            oldValue: oldDisp,
            newValue: newDisp,
            action: action || 'set',
            source: source || 'ui',
            actor,
        });
    }
}

const INVOICE_ORG_VALUES = ['Альмамед', 'Вилмед', 'ИП'];

function normInvoiceOrg(v) {
    const s = String(v == null ? '' : v).trim();
    if (!s) return '';
    const low = s.toLowerCase();
    if (low === 'ip' || low === 'ип') return 'ИП';
    if (low.includes('альмамед') || low === 'almamed') return 'Альмамед';
    if (low.includes('вилмед') || low === 'vilmed') return 'Вилмед';
    for (const o of INVOICE_ORG_VALUES) {
        if (s === o) return o;
    }
    return clip(s, 255);
}

function invoiceOrgLabel(v) {
    return normInvoiceOrg(v) || String(v || '').trim();
}

function parseDate(v) {
    if (v == null || v === '') return null;
    if (v instanceof Date && !isNaN(v.getTime())) {
        const y = v.getFullYear();
        const m = String(v.getMonth() + 1).padStart(2, '0');
        const d = String(v.getDate()).padStart(2, '0');
        return `${y}-${m}-${d}`;
    }
    const s = String(v).trim();
    const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
    const ru = s.match(/^(\d{1,2})[.](\d{1,2})[.](\d{4})/);
    if (ru) {
        const d = ru[1].padStart(2, '0');
        const m = ru[2].padStart(2, '0');
        return `${ru[3]}-${m}-${d}`;
    }
    return null;
}

function moneyOrNull(v) {
    if (v === '' || v == null) return null;
    return toNum(v);
}

async function ensureSchema(db) {
    if (schemaReady) return;
    await db.query(`
        CREATE TABLE IF NOT EXISTS dg_manager_sales_rows (
            id INT NOT NULL AUTO_INCREMENT,
            year SMALLINT NOT NULL,
            manager_user_id INT NOT NULL,
            row_no INT NOT NULL DEFAULT 0,
            payment_terms VARCHAR(512) NULL,
            paid_at DATE NULL,
            invoice_org VARCHAR(255) NOT NULL DEFAULT '',
            order_url VARCHAR(1024) NULL,
            amount_ex_delivery DECIMAL(14,2) NULL,
            vat DECIMAL(8,4) NULL,
            our_invoice_no VARCHAR(128) NULL,
            has_contract VARCHAR(128) NULL,
            supplier_invoice_url VARCHAR(1024) NULL,
            amount_incl_stock DECIMAL(14,2) NULL,
            delivery_to_us DECIMAL(14,2) NULL,
            supplier_name VARCHAR(255) NULL,
            supplier_invoice_no VARCHAR(128) NULL,
            diff DECIMAL(14,2) NULL,
            pct_r DECIMAL(10,4) NULL,
            status VARCHAR(64) NULL,
            pct_mp DECIMAL(8,4) NULL,
            bonus DECIMAL(14,2) NULL,
            created_by INT NULL,
            updated_by INT NULL,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            PRIMARY KEY (id),
            KEY idx_msl_manager_year_row (manager_user_id, year, row_no),
            KEY idx_msl_year_paid (year, paid_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    try {
        await db.query(
            "ALTER TABLE dg_manager_sales_rows MODIFY COLUMN invoice_org VARCHAR(255) NOT NULL DEFAULT ''"
        );
    } catch (_) {}
    try {
        await db.query('ALTER TABLE dg_manager_sales_rows MODIFY COLUMN has_contract VARCHAR(128) NULL');
    } catch (_) {}
    try {
        await db.query('ALTER TABLE dg_manager_sales_rows ADD COLUMN archived_at DATETIME NULL');
    } catch (_) {}
    try {
        await db.query('ALTER TABLE dg_manager_sales_rows ADD COLUMN archived_by INT NULL');
    } catch (_) {}
    try {
        await db.query('ALTER TABLE dg_manager_sales_rows ADD KEY idx_msl_archived (archived_at)');
    } catch (_) {}
    try {
        await db.query('ALTER TABLE dg_manager_sales_rows ADD COLUMN handed_to_user_id INT NULL');
    } catch (_) {}
    try {
        await db.query('ALTER TABLE dg_manager_sales_rows ADD COLUMN handed_to_at DATETIME NULL');
    } catch (_) {}
    try {
        await db.query('ALTER TABLE dg_manager_sales_rows ADD COLUMN handed_by INT NULL');
    } catch (_) {}
    try {
        await db.query('ALTER TABLE dg_manager_sales_rows ADD KEY idx_msl_handed (handed_to_user_id)');
    } catch (_) {}
    try {
        await db.query(
            "ALTER TABLE dg_manager_sales_rows ADD COLUMN invoice_mark VARCHAR(16) NOT NULL DEFAULT ''"
        );
    } catch (_) {}
    try {
        await db.query(
            "ALTER TABLE dg_manager_sales_rows ADD COLUMN our_invoice_mark VARCHAR(16) NOT NULL DEFAULT 'green'"
        );
        await db.query(
            "UPDATE dg_manager_sales_rows SET our_invoice_mark = 'green' WHERE TRIM(COALESCE(our_invoice_no,'')) <> ''"
        );
    } catch (_) {}
    try {
        await db.query('ALTER TABLE dg_manager_sales_rows ADD COLUMN suppliers_json TEXT NULL');
    } catch (_) {}
    try {
        await db.query('ALTER TABLE dg_manager_sales_rows MODIFY COLUMN supplier_invoice_url TEXT NULL');
    } catch (_) {}
    try {
        await db.query('ALTER TABLE dg_manager_sales_rows MODIFY COLUMN supplier_name VARCHAR(1024) NULL');
    } catch (_) {}
    try {
        await db.query('ALTER TABLE dg_manager_sales_rows MODIFY COLUMN supplier_invoice_no VARCHAR(512) NULL');
    } catch (_) {}
    try {
        await db.query(
            "ALTER TABLE dg_manager_sales_rows ADD COLUMN ship_group_id VARCHAR(32) NULL"
        );
    } catch (_) {}
    try {
        await db.query('ALTER TABLE dg_manager_sales_rows ADD KEY idx_msl_ship_group (ship_group_id)');
    } catch (_) {}
    await db.query(`
        CREATE TABLE IF NOT EXISTS dg_manager_sales_comments (
            id INT NOT NULL AUTO_INCREMENT,
            row_id INT NOT NULL,
            body TEXT NOT NULL,
            author_user_id INT NOT NULL,
            author_name VARCHAR(255) NULL,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            PRIMARY KEY (id),
            KEY idx_msl_cmt_row (row_id, id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await db.query(`
        CREATE TABLE IF NOT EXISTS dg_manager_sales_log (
            id BIGINT AUTO_INCREMENT PRIMARY KEY,
            row_id INT NOT NULL,
            field VARCHAR(64) NOT NULL,
            old_value VARCHAR(512) NULL,
            new_value VARCHAR(512) NULL,
            action VARCHAR(32) NOT NULL DEFAULT 'set',
            source VARCHAR(32) NOT NULL DEFAULT 'ui',
            changed_by_user_id INT NULL,
            changed_by_name VARCHAR(255) NULL,
            note VARCHAR(512) NULL,
            changed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            INDEX idx_msl_log_row (row_id, changed_at),
            INDEX idx_msl_log_user (changed_by_user_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await db.query(`
        CREATE TABLE IF NOT EXISTS dg_manager_sales_plans (
            id INT NOT NULL AUTO_INCREMENT,
            manager_user_id INT NOT NULL DEFAULT 0,
            year SMALLINT NOT NULL DEFAULT 0,
            month TINYINT NOT NULL DEFAULT 0,
            plan_amount DECIMAL(14,2) NOT NULL,
            note VARCHAR(255) NULL,
            updated_by INT NULL,
            updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            PRIMARY KEY (id),
            UNIQUE KEY uniq_msl_plan (manager_user_id, year, month)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    try {
        await db.query('ALTER TABLE dg_manager_sales_plans ADD COLUMN steps_json TEXT NULL');
    } catch (_) {}
    try {
        await db.query(
            `INSERT IGNORE INTO dg_manager_sales_plans (manager_user_id, year, month, plan_amount, note)
             VALUES (0, 0, 0, ?, 'базовый')`,
            [DEFAULT_PLAN_AMOUNT]
        );
    } catch (_) {}
    try {
        await alignInvoiceTwinRowNos(db);
    } catch (e) {
        console.warn('[manager-sales] invoice row_no align', e && e.message);
    }
    schemaReady = true;
}

function foldInvoiceNo(s) {
    return String(s || '')
        .trim()
        .replace(/\s+/g, '')
        .toLowerCase();
}

function rowMonthKey(paidAt) {
    const m = paidMonth(paidAt);
    return m >= 1 && m <= 12 ? m : 0;
}

function claimRowNo(usedMap, monthKey, wanted, invoiceKey) {
    const k = monthKey >= 1 && monthKey <= 12 ? monthKey : 0;
    if (!usedMap.has(k)) usedMap.set(k, { byNo: new Map(), byInv: new Map() });
    const st = usedMap.get(k);
    const inv = invoiceKey || '';
    if (inv && st.byInv.has(inv)) return st.byInv.get(inv);
    let n = Math.round(Number(wanted));
    if (!Number.isFinite(n) || n < 1) n = 1;
    while (st.byNo.has(n) && st.byNo.get(n) !== inv) n += 1;
    st.byNo.set(n, inv);
    if (inv) st.byInv.set(inv, n);
    return n;
}

async function applyRowNoUpdates(db, updates) {
    if (!updates.length) return;
    const chunk = 80;
    for (let j = 0; j < updates.length; j += chunk) {
        const part = updates.slice(j, j + chunk);
        const whens = part.map(() => 'WHEN ? THEN ?').join(' ');
        const args = [];
        part.forEach((u) => {
            args.push(u.id, u.n);
        });
        const ids = part.map((u) => u.id);
        await db.query(
            `UPDATE dg_manager_sales_rows SET row_no = CASE id ${whens} END WHERE id IN (${ids.map(() => '?').join(',')})`,
            args.concat(ids)
        );
    }
}

/** Один № счёта в месяце — один порядковый номер (НДС-позиции). */
async function alignInvoiceTwinRowNos(db) {
    const [hit] = await db.query(`
        SELECT 1 AS x
          FROM dg_manager_sales_rows
         WHERE TRIM(COALESCE(our_invoice_no, '')) <> ''
         GROUP BY manager_user_id, year, COALESCE(MONTH(paid_at), 0), LOWER(TRIM(our_invoice_no))
        HAVING COUNT(*) > 1 AND COUNT(DISTINCT row_no) > 1
         LIMIT 1
    `);
    if (!hit.length) return;
    const [rows] = await db.query(`
        SELECT id, manager_user_id, year, COALESCE(MONTH(paid_at), 0) AS m, row_no, our_invoice_no
          FROM dg_manager_sales_rows
         ORDER BY manager_user_id ASC, year ASC, m ASC, row_no ASC, id ASC
    `);
    const updates = [];
    let i = 0;
    while (i < (rows || []).length) {
        const g = `${rows[i].manager_user_id}:${rows[i].year}:${rows[i].m}`;
        const group = [];
        while (i < rows.length && `${rows[i].manager_user_id}:${rows[i].year}:${rows[i].m}` === g) {
            group.push({
                id: rows[i].id,
                orig: Number(rows[i].row_no) || 0,
                row_no: Number(rows[i].row_no) || 0,
                inv: foldInvoiceNo(rows[i].our_invoice_no),
            });
            i += 1;
        }
        const byInv = {};
        group.forEach((r) => {
            if (!r.inv) return;
            if (!byInv[r.inv]) byInv[r.inv] = [];
            byInv[r.inv].push(r);
        });
        let merged = false;
        Object.keys(byInv).forEach((inv) => {
            const pack = byInv[inv];
            if (pack.length < 2) return;
            const base = Math.min.apply(
                null,
                pack.map((r) => r.row_no)
            );
            pack.forEach((r) => {
                if (r.row_no !== base) {
                    r.row_no = base;
                    merged = true;
                }
            });
        });
        if (!merged) continue;
        const uniq = [];
        group.forEach((r) => {
            if (uniq.indexOf(r.row_no) < 0) uniq.push(r.row_no);
        });
        uniq.sort((a, b) => a - b);
        const remap = {};
        let expect = uniq.length && uniq[0] >= 1 ? uniq[0] : 1;
        uniq.forEach((u) => {
            remap[u] = expect;
            expect += 1;
        });
        group.forEach((r) => {
            const n = remap[r.row_no] != null ? remap[r.row_no] : r.row_no;
            if (n !== r.orig) updates.push({ id: r.id, n });
        });
    }
    await applyRowNoUpdates(db, updates);
    if (updates.length) console.log('[manager-sales] same invoice → same row_no:', updates.length);
}

function sqlDate(v) {
    if (!v) return null;
    if (v instanceof Date && !isNaN(v.getTime())) {
        const y = v.getFullYear();
        const m = String(v.getMonth() + 1).padStart(2, '0');
        const d = String(v.getDate()).padStart(2, '0');
        return `${y}-${m}-${d}`;
    }
    const s = String(v);
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
    return parseDate(s);
}

function creditManagerId(r) {
    const h = Number(r && r.handed_to_user_id);
    if (Number.isFinite(h) && h > 0) return h;
    return Number(r && r.manager_user_id) || 0;
}

function canTouchRow(req, row) {
    if (canSeeAll(req)) return true;
    const self = actorId(req);
    if (!self) return false;
    return Number(row.manager_user_id) === self || Number(row.handed_to_user_id) === self;
}

function canHandOverRow(req, row) {
    if (canSeeAll(req)) return true;
    const self = actorId(req);
    return !!self && Number(row.manager_user_id) === self;
}

const ROW_SELECT = `r.*, u.username AS manager_username, u.full_name AS manager_full_name,
            hu.username AS handed_to_username, hu.full_name AS handed_to_full_name`;
const ROW_FROM = `dg_manager_sales_rows r
           LEFT JOIN users u ON u.id = r.manager_user_id
           LEFT JOIN users hu ON hu.id = r.handed_to_user_id`;

function mapRow(r, pctMpOverride) {
    const pctMp = pctMpOverride != null ? pctMpOverride : r.pct_mp;
    const flat = flattenSuppliers(resolveSuppliersList(r));
    const calc = computeRow(
        Object.assign({}, r, {
            pct_mp: pctMp,
            amount_incl_stock: flat.amount_incl_stock,
            delivery_to_us: flat.delivery_to_us,
        })
    );
    const handed = Number(r.handed_to_user_id);
    return {
        id: Number(r.id),
        year: Number(r.year),
        manager_user_id: Number(r.manager_user_id),
        manager_username: r.manager_username || '',
        manager_full_name: r.manager_full_name || '',
        row_no: r.row_no != null ? Number(r.row_no) : 0,
        payment_terms: r.payment_terms || '',
        paid_at: sqlDate(r.paid_at),
        invoice_org: r.invoice_org || '',
        invoice_org_label: invoiceOrgLabel(r.invoice_org),
        order_url: r.order_url || '',
        amount_ex_delivery: calc.amount_ex_delivery,
        vat: moneyOrNull(r.vat),
        our_invoice_no: r.our_invoice_no || '',
        invoice_mark: flat.suppliers[0] ? normInvoiceMark(flat.suppliers[0].invoice_mark) : normInvoiceMark(r.invoice_mark),
        our_invoice_mark: normOurInvoiceMark(r.our_invoice_mark),
        ship_group_id: normShipGroupId(r.ship_group_id),
        ship_group_mates: [],
        ship_group_size: 0,
        has_contract: r.has_contract || '',
        supplier_invoice_url: flat.supplier_invoice_url,
        amount_incl_stock: calc.amount_incl_stock,
        delivery_to_us: calc.delivery_to_us,
        supplier_name: flat.supplier_name,
        supplier_invoice_no: flat.supplier_invoice_no,
        suppliers: flat.suppliers,
        suppliers_json: flat.suppliers_json,
        diff: calc.diff,
        pct_r: calc.pct_r,
        status: r.status || '',
        pct_mp: calc.pct_mp,
        bonus: calc.bonus,
        handed_to_user_id: Number.isFinite(handed) && handed > 0 ? handed : null,
        handed_to_username: r.handed_to_username || '',
        handed_to_full_name: r.handed_to_full_name || '',
        handed_to_at: r.handed_to_at || null,
        archived_at: r.archived_at || null,
        archived_by: r.archived_by != null ? Number(r.archived_by) : null,
        is_archived: r.archived_at ? 1 : 0,
        created_at: r.created_at || null,
        updated_at: r.updated_at || null,
    };
}

function applyBodyToRow(body, base) {
    const next = Object.assign({}, base || {});
    if (!body || typeof body !== 'object') return next;
    for (const key of PATCH_FIELDS) {
        if (!Object.prototype.hasOwnProperty.call(body, key)) continue;
        const v = body[key];
        if (key === 'year') {
            next.year = normYear(v, next.year);
        } else if (key === 'manager_user_id') {
            const n = Number(v);
            if (Number.isFinite(n) && n > 0) next.manager_user_id = n;
        } else if (key === 'paid_at') {
            next.paid_at = parseDate(v);
        } else if (key === 'invoice_org') {
            next.invoice_org = normInvoiceOrg(v);
        } else if (key === 'has_contract') {
            next.has_contract = normHasContract(v);
        } else if (key === 'amount_ex_delivery' || key === 'vat') {
            next[key] = moneyOrNull(v);
        } else if (key === 'order_url') {
            next[key] = clip(v, 1024);
        } else if (key === 'payment_terms') {
            next[key] = clip(v, 512);
        } else if (key === 'our_invoice_no') {
            next[key] = clip(v, 128);
        } else if (key === 'invoice_mark') {
            /* подсветка счёта поставщика — на строку закупки (supplier_index), через applySuppliersPatch */
        } else if (key === 'our_invoice_mark') {
            next.our_invoice_mark = normOurInvoiceMark(v);
        } else if (key === 'status') {
            next[key] = normStatus(v);
        }
    }
    const packed = applySuppliersPatch(next, body || {});
    next.suppliers = packed.suppliers;
    next.suppliers_json = packed.suppliers_json;
    next.supplier_name = packed.supplier_name;
    next.supplier_invoice_no = packed.supplier_invoice_no;
    next.supplier_invoice_url = packed.supplier_invoice_url;
    next.amount_incl_stock = packed.amount_incl_stock;
    next.delivery_to_us = packed.delivery_to_us;
    next.invoice_mark = packed.suppliers[0] ? normInvoiceMark(packed.suppliers[0].invoice_mark) : '';
    const calc = computeRow(next);
    next.amount_ex_delivery = calc.amount_ex_delivery;
    next.amount_incl_stock = calc.amount_incl_stock;
    next.delivery_to_us = calc.delivery_to_us;
    next.pct_mp = calc.pct_mp;
    next.diff = calc.diff;
    next.pct_r = calc.pct_r;
    next.bonus = calc.bonus;
    return next;
}

function rowToInsertParams(row, actor) {
    return [
        row.year,
        row.manager_user_id,
        row.row_no || 0,
        row.payment_terms || null,
        row.paid_at || null,
        row.invoice_org || '',
        row.order_url || null,
        row.amount_ex_delivery,
        row.vat,
        row.our_invoice_no || null,
        row.has_contract || null,
        row.supplier_invoice_url || null,
        row.amount_incl_stock,
        row.delivery_to_us,
        row.supplier_name || null,
        row.supplier_invoice_no || null,
        row.diff,
        row.pct_r,
        row.status || null,
        row.pct_mp,
        row.bonus,
        row.suppliers_json || null,
        actor,
        actor,
    ];
}

const INSERT_SQL = `INSERT INTO dg_manager_sales_rows (
    year, manager_user_id, row_no, payment_terms, paid_at, invoice_org, order_url,
    amount_ex_delivery, vat, our_invoice_no, has_contract, supplier_invoice_url,
    amount_incl_stock, delivery_to_us, supplier_name, supplier_invoice_no,
    diff, pct_r, status, pct_mp, bonus, suppliers_json, created_by, updated_by
) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`;

const UPDATE_SQL = `UPDATE dg_manager_sales_rows SET
    year=?, manager_user_id=?, row_no=?, payment_terms=?, paid_at=?, invoice_org=?, order_url=?,
    amount_ex_delivery=?, vat=?, our_invoice_no=?, has_contract=?, supplier_invoice_url=?,
    amount_incl_stock=?, delivery_to_us=?, supplier_name=?, supplier_invoice_no=?,
    diff=?, pct_r=?, status=?, pct_mp=?, bonus=?, invoice_mark=?, our_invoice_mark=?, suppliers_json=?, updated_by=?
    WHERE id=?`;

function parseDelimited(text) {
    const raw = String(text || '').replace(/^\uFEFF/, '');
    if (!raw.trim()) return { headers: [], rows: [] };
    const firstLine = raw.split(/\r?\n/, 1)[0] || '';
    const comma = (firstLine.match(/,/g) || []).length;
    const tab = (firstLine.match(/\t/g) || []).length;
    const semi = (firstLine.match(/;/g) || []).length;
    let delim = ',';
    if (tab >= comma && tab >= semi && tab > 0) delim = '\t';
    else if (semi > comma) delim = ';';

    const rows = [];
    let cur = [];
    let field = '';
    let inQuotes = false;
    const src = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    for (let i = 0; i < src.length; i += 1) {
        const ch = src[i];
        if (inQuotes) {
            if (ch === '"') {
                if (src[i + 1] === '"') {
                    field += '"';
                    i += 1;
                } else {
                    inQuotes = false;
                }
            } else {
                field += ch;
            }
            continue;
        }
        if (ch === '"') {
            inQuotes = true;
            continue;
        }
        if (ch === delim) {
            cur.push(field);
            field = '';
            continue;
        }
        if (ch === '\n') {
            cur.push(field);
            field = '';
            rows.push(cur);
            cur = [];
            continue;
        }
        field += ch;
    }
    cur.push(field);
    if (cur.some((c) => String(c).trim() !== '')) rows.push(cur);
    if (!rows.length) return { headers: [], rows: [] };
    const headers = rows[0].map((h) => String(h || '').trim());
    return { headers, rows: rows.slice(1) };
}

function headerKey(label) {
    const n = String(label || '')
        .trim()
        .toLowerCase()
        .replace(/\s+/g, ' ');
    for (const h of CSV_HEADERS) {
        if (h.aliases.some((a) => a === n)) return h.key;
        if (h.key === n) return h.key;
    }
    return null;
}

function csvEscape(v) {
    const s = v == null ? '' : String(v);
    if (/[",\n;]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
}

async function buildListWhere(db, q, req) {
    const year = normYear(q.year, currentYear());
    const where = ['r.year = ?'];
    const params = [year];

    let managerId = null;
    const sales = canSeeAll(req) ? await listSalesManagers(db) : [];
    const salesIds = new Set(sales.map((m) => m.id));
    if (!canSeeAll(req)) {
        managerId = actorId(req);
        if (!managerId) {
            where.push('1=0');
        } else {
            where.push('(r.manager_user_id = ? OR r.handed_to_user_id = ?)');
            params.push(managerId, managerId);
        }
    } else {
        const raw = String(q.manager_user_id || '').trim();
        if (raw && raw !== 'all') {
            const n = Number(raw);
            if (Number.isFinite(n) && n > 0 && salesIds.has(n)) {
                managerId = n;
                where.push('(r.manager_user_id = ? OR r.handed_to_user_id = ?)');
                params.push(n, n);
            } else {
                where.push('1=0');
            }
        } else if (salesIds.size) {
            const ids = [...salesIds];
            where.push(`r.manager_user_id IN (${ids.map(() => '?').join(',')})`);
            params.push(...ids);
        } else {
            where.push('1=0');
        }
    }

    const arch = String(q.archived || q.archive || '0').trim();
    if (arch === '1' || arch === 'archived') {
        where.push('r.archived_at IS NOT NULL');
    } else if (arch === 'all') {
        /* both */
    } else {
        where.push('r.archived_at IS NULL');
    }

    let month = null;
    const rawMonth = String(q.month || '').trim();
    if (rawMonth && rawMonth !== 'all') {
        const m = Number(rawMonth);
        if (Number.isFinite(m) && m >= 1 && m <= 12) {
            month = Math.round(m);
            where.push('(MONTH(r.paid_at) = ? OR r.paid_at IS NULL)');
            params.push(month);
        }
    }

    const search = String(q.search || '').trim();
    if (search) {
        const like = `%${search}%`;
        where.push(`(
            COALESCE(r.payment_terms,'') LIKE ?
            OR COALESCE(r.order_url,'') LIKE ?
            OR COALESCE(r.our_invoice_no,'') LIKE ?
            OR COALESCE(r.supplier_name,'') LIKE ?
            OR COALESCE(r.supplier_invoice_no,'') LIKE ?
            OR COALESCE(r.suppliers_json,'') LIKE ?
            OR COALESCE(r.status,'') LIKE ?
            OR COALESCE(u.full_name,'') LIKE ?
            OR COALESCE(u.username,'') LIKE ?
            OR COALESCE(hu.full_name,'') LIKE ?
            OR COALESCE(hu.username,'') LIKE ?
            OR COALESCE(r.ship_group_id,'') LIKE ?
            OR EXISTS (
                SELECT 1 FROM dg_manager_sales_comments c
                 WHERE c.row_id = r.id AND (c.body LIKE ? OR COALESCE(c.author_name,'') LIKE ?)
            )
            OR EXISTS (
                SELECT 1 FROM dg_manager_sales_rows m
                 WHERE m.ship_group_id IS NOT NULL
                   AND m.ship_group_id <> ''
                   AND m.ship_group_id = r.ship_group_id
                   AND m.id <> r.id
                   AND COALESCE(m.our_invoice_no,'') LIKE ?
            )
        )`);
            params.push(like, like, like, like, like, like, like, like, like, like, like, like, like, like, like);
    }

    const shipTogether = String(q.ship_together || q.ship_group || '').trim();
    if (shipTogether === '1' || shipTogether === 'yes' || shipTogether === 'linked') {
        where.push("TRIM(COALESCE(r.ship_group_id,'')) <> ''");
    } else if (shipTogether === '0' || shipTogether === 'no' || shipTogether === 'none') {
        where.push("TRIM(COALESCE(r.ship_group_id,'')) = ''");
    }

    const shipGroupId = normShipGroupId(q.ship_group_id);
    if (shipGroupId) {
        where.push('r.ship_group_id = ?');
        params.push(shipGroupId);
    }

    const status = String(q.status || '').trim();
    if (status) {
        where.push('r.status = ?');
        params.push(clip(status, 64));
    }

    const supplier = String(q.supplier || q.supplier_name || '').trim();
    if (supplier) {
        where.push('r.supplier_name LIKE ?');
        params.push(`%${supplier}%`);
    }

    const hc = String(q.has_contract || '').trim();
    if (hc === '1') {
        where.push(
            "(TRIM(COALESCE(r.has_contract,'')) <> '' AND LOWER(TRIM(r.has_contract)) NOT IN ('нет','0','no','false'))"
        );
    } else if (hc === '0') {
        where.push(
            "(TRIM(COALESCE(r.has_contract,'')) = '' OR LOWER(TRIM(r.has_contract)) IN ('нет','0','no','false'))"
        );
    } else if (hc) {
        const canon = normHasContract(hc);
        where.push('LOWER(TRIM(r.has_contract)) = ?');
        params.push(String(canon || hc).toLowerCase());
    }

    const orgRaw = String(q.invoice_org || '').trim();
    const org = normInvoiceOrg(orgRaw);
    if (org === 'ИП' || orgRaw === 'ip') {
        where.push("(r.invoice_org = 'ИП' OR r.invoice_org LIKE '%ИП%')");
    } else if (org === 'Альмамед' || org === 'Вилмед') {
        where.push('(r.invoice_org = ? OR r.invoice_org LIKE ?)');
        params.push(org, `%${org}%`);
    } else if (orgRaw === 'ooo' || orgRaw.toLowerCase() === 'ооо') {
        where.push("(r.invoice_org LIKE '%ООО%' OR r.invoice_org IN ('Альмамед','Вилмед'))");
    } else if (orgRaw) {
        where.push('r.invoice_org LIKE ?');
        params.push(`%${orgRaw}%`);
    }

    return { year, month, managerId, whereSql: where.join(' AND '), params };
}

async function nextRowNo(db, managerUserId, year, month) {
    const m = Math.round(Number(month) || 0);
    const [rows] =
        m >= 1 && m <= 12
            ? await db.query(
                  `SELECT COALESCE(MAX(row_no), 0) + 1 AS n
                     FROM dg_manager_sales_rows
                    WHERE manager_user_id = ? AND year = ? AND MONTH(paid_at) = ?`,
                  [managerUserId, year, m]
              )
            : await db.query(
                  `SELECT COALESCE(MAX(row_no), 0) + 1 AS n
                     FROM dg_manager_sales_rows
                    WHERE manager_user_id = ? AND year = ? AND paid_at IS NULL`,
                  [managerUserId, year]
              );
    return Number(rows && rows[0] && rows[0].n) || 1;
}

async function rowNoTaken(db, managerUserId, year, month, rowNo, exceptId, invoiceNo) {
    const m = Math.round(Number(month) || 0);
    const n = Math.round(Number(rowNo) || 0);
    const ex = Number(exceptId) || 0;
    const inv = foldInvoiceNo(invoiceNo);
    const invSql = inv
        ? " AND LOWER(REPLACE(TRIM(COALESCE(our_invoice_no, '')), ' ', '')) <> ?"
        : '';
    const extra = inv ? [inv] : [];
    const [rows] =
        m >= 1 && m <= 12
            ? await db.query(
                  `SELECT id FROM dg_manager_sales_rows
                    WHERE manager_user_id = ? AND year = ? AND MONTH(paid_at) = ? AND row_no = ? AND id <> ?${invSql}
                    LIMIT 1`,
                  [managerUserId, year, m, n, ex].concat(extra)
              )
            : await db.query(
                  `SELECT id FROM dg_manager_sales_rows
                    WHERE manager_user_id = ? AND year = ? AND paid_at IS NULL AND row_no = ? AND id <> ?${invSql}
                    LIMIT 1`,
                  [managerUserId, year, n, ex].concat(extra)
              );
    return !!(rows && rows[0]);
}

async function rowNoForSameInvoice(db, managerUserId, year, month, invoiceNo, exceptId) {
    const inv = foldInvoiceNo(invoiceNo);
    if (!inv) return null;
    const m = Math.round(Number(month) || 0);
    const ex = Number(exceptId) || 0;
    const [rows] =
        m >= 1 && m <= 12
            ? await db.query(
                  `SELECT row_no FROM dg_manager_sales_rows
                    WHERE manager_user_id = ? AND year = ? AND MONTH(paid_at) = ?
                      AND LOWER(REPLACE(TRIM(COALESCE(our_invoice_no, '')), ' ', '')) = ?
                      AND id <> ?
                    LIMIT 1`,
                  [managerUserId, year, m, inv, ex]
              )
            : await db.query(
                  `SELECT row_no FROM dg_manager_sales_rows
                    WHERE manager_user_id = ? AND year = ? AND paid_at IS NULL
                      AND LOWER(REPLACE(TRIM(COALESCE(our_invoice_no, '')), ' ', '')) = ?
                      AND id <> ?
                    LIMIT 1`,
                  [managerUserId, year, inv, ex]
              );
    const n = Number(rows && rows[0] && rows[0].row_no);
    return Number.isFinite(n) && n > 0 ? n : null;
}

async function fetchRowById(db, id) {
    const [rows] = await db.query(
        `SELECT ${ROW_SELECT}
           FROM ${ROW_FROM}
          WHERE r.id = ?`,
        [id]
    );
    return rows && rows[0] ? rows[0] : null;
}

function paidMonth(paidAt) {
    const d = sqlDate(paidAt);
    if (!d) return 0;
    const m = Number(d.slice(5, 7));
    return m >= 1 && m <= 12 ? m : 0;
}

async function loadPlans(db) {
    const [rows] = await db.query(
        `SELECT id, manager_user_id, year, month, plan_amount, note, steps_json
           FROM dg_manager_sales_plans`
    );
    return rows || [];
}

function resolvePlan(plans, managerUserId, year, month) {
    const mid = Number(managerUserId) || 0;
    const y = Number(year) || 0;
    const m = Number(month) || 0;
    const hit = (a, b, c) =>
        (plans || []).find(
            (p) => Number(p.manager_user_id) === a && Number(p.year) === b && Number(p.month) === c
        );
    const monthOwn = m && mid ? hit(mid, y, m) : null;
    const managerYear = mid ? hit(mid, y, 0) : null;
    const yearBase = y ? hit(0, y, 0) : null;
    const fallback = hit(0, 0, 0);
    const row = monthOwn || managerYear || yearBase || fallback;
    const amount = row && row.plan_amount != null ? Number(row.plan_amount) : DEFAULT_PLAN_AMOUNT;
    let source = 'fallback';
    if (monthOwn) source = 'month';
    else if (managerYear) source = 'manager_year';
    else if (yearBase) source = 'year_base';
    else if (fallback) source = 'fallback';
    let steps = null;
    [monthOwn, managerYear, yearBase, fallback].forEach((p) => {
        if (steps) return;
        const parsed = parseStoredSteps(p && p.steps_json);
        if (parsed) steps = parsed;
    });
    if (!steps) steps = cloneDefaultSteps();
    return {
        id: row && row.id != null ? Number(row.id) : null,
        plan_amount: Number.isFinite(amount) && amount > 0 ? amount : DEFAULT_PLAN_AMOUNT,
        source,
        note: row && row.note ? String(row.note) : '',
        steps,
    };
}

async function upsertPlanRow(db, { managerUserId, year, month, planAmount, note, actor, steps }) {
    const mid = Number(managerUserId) || 0;
    const y = Number(year) || 0;
    const m = Number(month) || 0;
    const empty =
        planAmount == null || planAmount === '' || String(planAmount).trim() === '';
    let stepsJson = undefined;
    if (steps !== undefined) {
        if (steps == null || steps === '') stepsJson = null;
        else stepsJson = stepsToJson(normalizePlanSteps(steps));
    }
    if (empty && stepsJson == null && steps === undefined) {
        await db.query(
            'DELETE FROM dg_manager_sales_plans WHERE manager_user_id = ? AND year = ? AND month = ?',
            [mid, y, m]
        );
        return { cleared: true };
    }
    let amount = empty ? null : toNum(planAmount);
    if ((amount == null || amount <= 0) && stepsJson) {
        const n = normalizePlanSteps(steps);
        amount = n.steps[n.steps.length - 1][0];
    }
    if (amount == null || amount <= 0) {
        if (empty && steps === undefined) {
            await db.query(
                'DELETE FROM dg_manager_sales_plans WHERE manager_user_id = ? AND year = ? AND month = ?',
                [mid, y, m]
            );
            return { cleared: true };
        }
        const err = new Error('План должен быть больше 0 или пустой');
        err.status = 400;
        throw err;
    }
    const noteVal = note != null ? clip(note, 255) : '';
    if (steps !== undefined) {
        await db.query(
            `INSERT INTO dg_manager_sales_plans (manager_user_id, year, month, plan_amount, note, steps_json, updated_by)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE plan_amount = VALUES(plan_amount), note = VALUES(note),
                steps_json = VALUES(steps_json), updated_by = VALUES(updated_by)`,
            [mid, y, m, amount, noteVal || null, stepsJson, actor]
        );
    } else {
        await db.query(
            `INSERT INTO dg_manager_sales_plans (manager_user_id, year, month, plan_amount, note, updated_by)
             VALUES (?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE plan_amount = VALUES(plan_amount), note = VALUES(note), updated_by = VALUES(updated_by)`,
            [mid, y, m, amount, noteVal || null, actor]
        );
    }
    return { plan_amount: amount };
}

async function persistRowsPct(db, rows, plans, totals, year) {
    const list = rows || [];
    if (!list.length) return 0;
    const y = Number(year);
    const whenPct = [];
    const whenBonus = [];
    const params = [];
    const ids = [];
    for (const r of list) {
        const id = Number(r.id);
        if (!Number.isFinite(id) || id < 1) continue;
        const month = paidMonth(r.paid_at);
        const mid = creditManagerId(r);
        const total = month ? totals[monthKey(mid, month)] || 0 : 0;
        const plan = resolvePlan(plans, mid, y, month);
        const pct = month ? pctMpFromMonthTotal(total, plan.plan_amount, plan.steps) : 0;
        const calc = computeRow(Object.assign({}, r, { pct_mp: pct }));
        const nextPct = Number(calc.pct_mp);
        const nextBonus = Number(calc.bonus);
        if (Number(r.pct_mp) === nextPct && Number(r.bonus) === nextBonus) continue;
        ids.push(id);
        whenPct.push('WHEN ? THEN ?');
        whenBonus.push('WHEN ? THEN ?');
        params.push(id, nextPct, id, nextBonus);
    }
    if (!ids.length) return 0;
    const inPh = ids.map(() => '?').join(',');
    await db.query(
        `UPDATE dg_manager_sales_rows
            SET pct_mp = CASE id ${whenPct.join(' ')} END,
                bonus = CASE id ${whenBonus.join(' ')} END
          WHERE id IN (${inPh})`,
        params.concat(ids)
    );
    return ids.length;
}

async function persistYearPct(db, managerUserId, year) {
    const mid = Number(managerUserId);
    const y = Number(year);
    if (!Number.isFinite(mid) || mid < 1) return;
    const plans = await loadPlans(db);
    const totals = await fetchMonthTotals(db, y, [mid]);
    const [raw] = await db.query(
        `SELECT id, manager_user_id, handed_to_user_id, paid_at, amount_ex_delivery, amount_incl_stock, delivery_to_us, vat, pct_mp, bonus
           FROM dg_manager_sales_rows
          WHERE year = ? AND archived_at IS NULL
            AND (manager_user_id = ? OR handed_to_user_id = ?)`,
        [y, mid, mid]
    );
    await persistRowsPct(
        db,
        (raw || []).filter((r) => creditManagerId(r) === mid),
        plans,
        totals,
        y
    );
}

async function persistMonthPct(db, managerUserId, year, month) {
    const m = Number(month);
    const mid = Number(managerUserId);
    const y = Number(year);
    if (!Number.isFinite(m) || m < 1 || m > 12) return;
    if (!Number.isFinite(mid) || mid < 1) return;
    const start = `${y}-${String(m).padStart(2, '0')}-01`;
    const next =
        m === 12
            ? `${y + 1}-01-01`
            : `${y}-${String(m + 1).padStart(2, '0')}-01`;
    const [raw] = await db.query(
        `SELECT id, manager_user_id, handed_to_user_id, paid_at, amount_ex_delivery, amount_incl_stock, delivery_to_us, vat, pct_mp, bonus
           FROM dg_manager_sales_rows
          WHERE year = ? AND archived_at IS NULL
            AND (manager_user_id = ? OR handed_to_user_id = ?)
            AND paid_at >= ? AND paid_at < ?`,
        [y, mid, mid, start, next]
    );
    const plans = await loadPlans(db);
    const totals = await fetchMonthTotals(db, y, [mid]);
    await persistRowsPct(
        db,
        (raw || []).filter((r) => creditManagerId(r) === mid),
        plans,
        totals,
        y
    );
}

async function fetchMonthTotals(db, year, managerIds) {
    const out = {};
    const ids = (managerIds || []).map((n) => Number(n)).filter((n) => Number.isFinite(n) && n > 0);
    if (!ids.length) return out;
    const ph = ids.map(() => '?').join(',');
    const [rows] = await db.query(
        `SELECT COALESCE(handed_to_user_id, manager_user_id) AS mid, MONTH(paid_at) AS m,
                COALESCE(SUM(amount_ex_delivery), 0) AS amount_ex
           FROM dg_manager_sales_rows
          WHERE year = ?
            AND archived_at IS NULL
            AND paid_at IS NOT NULL
            AND COALESCE(handed_to_user_id, manager_user_id) IN (${ph})
          GROUP BY COALESCE(handed_to_user_id, manager_user_id), MONTH(paid_at)`,
        [year].concat(ids)
    );
    (rows || []).forEach((r) => {
        out[`${Number(r.mid)}:${Number(r.m)}`] = Number(r.amount_ex) || 0;
    });
    return out;
}

function monthKey(managerId, month) {
    return `${Number(managerId)}:${Number(month)}`;
}

async function mapRowsWithPlan(db, rawRows) {
    const list = rawRows || [];
    if (!list.length) return [];
    const year = Number(list[0].year);
    const mids = [];
    const seen = new Set();
    list.forEach((r) => {
        const id = creditManagerId(r);
        if (!seen.has(id) && Number.isFinite(id) && id > 0) {
            seen.add(id);
            mids.push(id);
        }
    });
    const plans = await loadPlans(db);
    const totals = await fetchMonthTotals(db, year, mids);
    return list.map((raw) => {
        const month = paidMonth(raw.paid_at);
        const mid = creditManagerId(raw);
        const total = month ? totals[monthKey(mid, month)] || 0 : 0;
        const plan = resolvePlan(plans, mid, raw.year, month);
        const pct = month ? pctMpFromMonthTotal(total, plan.plan_amount, plan.steps) : 0;
        return mapRow(raw, pct);
    });
}

module.exports = function managerSalesRouterFactory(db) {
    const router = express.Router();

    router.get('/meta', async (req, res) => {
        try {
            await ensureSchema(db);
            const seeAll = canSeeAll(req);
            const selfId = actorId(req);
            const yearSql = seeAll
                ? 'SELECT DISTINCT year FROM dg_manager_sales_rows ORDER BY year DESC'
                : `SELECT DISTINCT year FROM dg_manager_sales_rows
                    WHERE manager_user_id = ? OR handed_to_user_id = ?
                    ORDER BY year DESC`;
            const [yearRows] = await db.query(yearSql, seeAll ? [] : [selfId, selfId]);
            const years = (yearRows || []).map((r) => Number(r.year)).filter((y) => Number.isFinite(y));
            const cy = currentYear();
            if (!years.includes(cy)) years.unshift(cy);
            const managers = await listSalesManagers(db);
            const actor = req.datagonActor || {};
            res.json({
                success: true,
                year: cy,
                years,
                managers,
                statuses: STATUS_VALUES,
                invoice_marks: INVOICE_MARKS,
                can_write: canWrite(req),
                can_pick_manager: seeAll,
                actor_user_id: selfId,
                actor_full_name: actor.full_name || actor.username || '',
                actor_username: actor.username || '',
                formulas: {
                    tax_pct: 16,
                    diff: '((F-K) - F*G/(G+100)) * (1 - 16/100) - L',
                    pct_r: 'diff / (F/100)',
                    pct_mp: 'по сумме F за месяц и плану (ступени Google, масштаб от 3 300 000)',
                    bonus: 'diff / 100 * pct_mp',
                    default_plan_amount: DEFAULT_PLAN_AMOUNT,
                },
            });
        } catch (e) {
            res.status(500).json({ error: e.message || 'Ошибка meta' });
        }
    });

    router.get('/supplier-hints', async (req, res) => {
        try {
            await ensureSchema(db);
            const q = String(req.query.q || '').trim();
            const like = `%${q}%`;
            const hintWhere = ['supplier_name IS NOT NULL', "TRIM(supplier_name) <> ''"];
            const hintParams = [];
            if (!canSeeAll(req)) {
                const selfId = actorId(req);
                if (!selfId) {
                    return res.json({ success: true, names: [] });
                }
                hintWhere.push('manager_user_id = ?');
                hintParams.push(selfId);
            } else {
                const raw = String(req.query.manager_user_id || '').trim();
                if (raw && raw !== 'all') {
                    const n = Number(raw);
                    if (Number.isFinite(n) && n > 0) {
                        hintWhere.push('manager_user_id = ?');
                        hintParams.push(n);
                    }
                }
            }
            if (q) {
                hintWhere.push('supplier_name LIKE ?');
                hintParams.push(like);
            }
            const [own] = await db.query(
                `SELECT DISTINCT supplier_name AS name
                   FROM dg_manager_sales_rows
                  WHERE ${hintWhere.join(' AND ')}
                  ORDER BY supplier_name
                  LIMIT 40`,
                hintParams
            );
            const names = [];
            const seen = new Set();
            (own || []).forEach((r) => {
                splitNonEmptyLines(r.name).forEach((n) => {
                    if (!n || seen.has(n.toLowerCase())) return;
                    seen.add(n.toLowerCase());
                    names.push(n);
                });
            });
            if (names.length < 20) {
                try {
                    const [ms] = await db.query(
                        `SELECT DISTINCT supplier AS name
                           FROM ms_export
                          WHERE supplier IS NOT NULL AND TRIM(supplier) <> ''
                            ${q ? 'AND supplier LIKE ?' : ''}
                          ORDER BY supplier
                          LIMIT 40`,
                        q ? [like] : []
                    );
                    (ms || []).forEach((r) => {
                        const n = String(r.name || '').trim();
                        if (!n || seen.has(n.toLowerCase())) return;
                        seen.add(n.toLowerCase());
                        names.push(n);
                    });
                } catch (_) {
                    /* ms_export may be absent */
                }
            }
            res.json({ success: true, names: names.slice(0, 40) });
        } catch (e) {
            res.status(500).json({ error: e.message || 'Ошибка подсказок' });
        }
    });

    router.get('/export.csv', async (req, res) => {
        try {
            await ensureSchema(db);
            const built = await buildListWhere(db, req.query || {}, req);
            const [rows] = await db.query(
                `SELECT ${ROW_SELECT}
                   FROM ${ROW_FROM}
                  WHERE ${built.whereSql}
                  ORDER BY r.row_no ASC, r.id ASC`,
                built.params
            );
            const labels = [
                '№',
                'Менеджер',
                'Условия оплаты',
                'Дата оплаты',
                'Счет от ИП или ООО',
                'Ссылка на заказ на сайте almamed.su или сателитах',
                'Сумма оплаты без доставки',
                'Ндс',
                '№ нашего счета',
                'Наличие договора',
                'Ссылка на счет поставщика',
                'Сумма оплаты (включая складские запасы)',
                'Доставка до нас',
                'Поставщик',
                '№ счета поставщика',
                'Разница',
                '% Р.',
                'Статус',
                '% МП.',
                'Премия',
                'Передан',
            ];
            const lines = [labels.map(csvEscape).join(',')];
            const mapped = await mapRowsWithPlan(db, rows || []);
            mapped.forEach((r) => {
                lines.push(
                    [
                        r.row_no,
                        r.manager_full_name || r.manager_username || '',
                        r.payment_terms,
                        r.paid_at || '',
                        r.invoice_org_label,
                        r.order_url,
                        r.amount_ex_delivery,
                        r.vat,
                        r.our_invoice_no,
                        r.has_contract || '',
                        r.supplier_invoice_url,
                        r.amount_incl_stock,
                        r.delivery_to_us,
                        r.supplier_name,
                        r.supplier_invoice_no,
                        r.diff,
                        r.pct_r,
                        r.status,
                        r.pct_mp,
                        r.bonus,
                        r.handed_to_full_name || r.handed_to_username || '',
                    ]
                        .map(csvEscape)
                        .join(',')
                );
            });
            const bom = '\uFEFF';
            res.setHeader('Content-Type', 'text/csv; charset=utf-8');
            res.setHeader(
                'Content-Disposition',
                `attachment; filename="manager-sales-${built.year}.csv"`
            );
            res.send(bom + lines.join('\n'));
        } catch (e) {
            res.status(500).json({ error: e.message || 'Ошибка экспорта' });
        }
    });

    router.get('/plans', async (req, res) => {
        try {
            await ensureSchema(db);
            const seeAll = canSeeAll(req);
            const year = normYear(req.query.year, currentYear());
            const plans = await loadPlans(db);
            const fallback = resolvePlan(plans, 0, 0, 0);
            const yearRow = (plans || []).find(
                (p) => Number(p.manager_user_id) === 0 && Number(p.year) === year && Number(p.month) === 0
            );
            const yearBaseAmount =
                yearRow && yearRow.plan_amount != null ? Number(yearRow.plan_amount) : null;
            const inheritedYear = yearBaseAmount != null ? yearBaseAmount : fallback.plan_amount;
            let managers = [];
            if (seeAll) {
                managers = await listSalesManagers(db);
            } else {
                const selfId = actorId(req);
                const actor = req.datagonActor || {};
                if (selfId) {
                    managers = [
                        {
                            id: selfId,
                            username: actor.username || '',
                            full_name: actor.full_name || actor.username || '',
                        },
                    ];
                }
            }
            const rows = managers.map((mgr) => {
                const yearOwn = (plans || []).find(
                    (p) =>
                        Number(p.manager_user_id) === Number(mgr.id) &&
                        Number(p.year) === year &&
                        Number(p.month) === 0
                );
                const managerYearAmount =
                    yearOwn && yearOwn.plan_amount != null ? Number(yearOwn.plan_amount) : null;
                const inheritedManager =
                    managerYearAmount != null ? managerYearAmount : inheritedYear;
                const months = [];
                for (let m = 1; m <= 12; m += 1) {
                    const own = (plans || []).find(
                        (p) =>
                            Number(p.manager_user_id) === Number(mgr.id) &&
                            Number(p.year) === year &&
                            Number(p.month) === m
                    );
                    months.push({
                        month: m,
                        plan_amount: own && own.plan_amount != null ? Number(own.plan_amount) : null,
                        note: own && own.note ? String(own.note) : '',
                        inherited: inheritedManager,
                    });
                }
                return {
                    id: Number(mgr.id),
                    username: mgr.username || '',
                    full_name: mgr.full_name || mgr.username || '',
                    year_plan: managerYearAmount,
                    year_note: yearOwn && yearOwn.note ? String(yearOwn.note) : '',
                    inherited: inheritedYear,
                    months,
                };
            });
            const yearSteps =
                parseStoredSteps(yearRow && yearRow.steps_json) ||
                fallback.steps ||
                cloneDefaultSteps();
            res.json({
                success: true,
                can_edit: seeAll,
                year,
                default_plan_amount: DEFAULT_PLAN_AMOUNT,
                fallback: { plan_amount: fallback.plan_amount, steps: fallback.steps },
                year_base: {
                    plan_amount: yearBaseAmount,
                    inherited: fallback.plan_amount,
                    note: yearRow && yearRow.note ? String(yearRow.note) : '',
                    steps: yearSteps,
                    steps_custom: !!parseStoredSteps(yearRow && yearRow.steps_json),
                },
                steps: scaledPlanSteps(inheritedYear, yearSteps),
                managers: rows,
            });
        } catch (e) {
            res.status(500).json({ error: e.message || 'Ошибка планов' });
        }
    });

    router.put('/plans/base', async (req, res) => {
        try {
            await ensureSchema(db);
            if (!canSeeAll(req)) {
                return res.status(403).json({ error: 'Планы меняют Полный доступ и Бухгалтерия' });
            }
            const body = req.body || {};
            const year = normYear(body.year, currentYear());
            const actor = actorId(req);
            await upsertPlanRow(db, {
                managerUserId: 0,
                year,
                month: 0,
                planAmount: body.plan_amount,
                note: body.note || 'план года',
                actor,
                steps: Object.prototype.hasOwnProperty.call(body, 'steps') ? body.steps : undefined,
            });
            const sales = await listSalesManagers(db);
            for (const m of sales) {
                await persistYearPct(db, m.id, year);
            }
            res.json({ success: true, year, plan_amount: toNum(body.plan_amount) });
        } catch (e) {
            res.status(e.status || 500).json({ error: e.message || 'Ошибка базового плана' });
        }
    });

    router.put('/plans/matrix', async (req, res) => {
        try {
            await ensureSchema(db);
            if (!canSeeAll(req)) {
                return res.status(403).json({ error: 'Планы меняют Полный доступ и Бухгалтерия' });
            }
            const body = req.body || {};
            const year = normYear(body.year, currentYear());
            const actor = actorId(req);
            const sales = await listSalesManagers(db);
            const allowed = new Set(sales.map((m) => m.id));
            const hasBase = Object.prototype.hasOwnProperty.call(body, 'year_base');
            const hasSteps = Object.prototype.hasOwnProperty.call(body, 'steps');
            if (hasBase || hasSteps) {
                const existingPlans = await loadPlans(db);
                const yearRow = (existingPlans || []).find(
                    (p) => Number(p.manager_user_id) === 0 && Number(p.year) === year && Number(p.month) === 0
                );
                await upsertPlanRow(db, {
                    managerUserId: 0,
                    year,
                    month: 0,
                    planAmount: hasBase
                        ? body.year_base
                        : yearRow && yearRow.plan_amount != null
                          ? yearRow.plan_amount
                          : DEFAULT_PLAN_AMOUNT,
                    note: 'план года',
                    actor,
                    steps: hasSteps ? body.steps : undefined,
                });
            }
            const list = Array.isArray(body.managers) ? body.managers : [];
            const touched = new Set();
            const emptyMonths = [];
            for (const row of list) {
                const mid = Number(row.manager_user_id || row.id);
                if (!allowed.has(mid)) continue;
                if (Object.prototype.hasOwnProperty.call(row, 'year_plan')) {
                    await upsertPlanRow(db, {
                        managerUserId: mid,
                        year,
                        month: 0,
                        planAmount: row.year_plan,
                        note: row.year_note || '',
                        actor,
                    });
                }
                const months = Array.isArray(row.months) ? row.months : [];
                for (const mm of months) {
                    const month = Number(mm.month);
                    if (!Number.isFinite(month) || month < 1 || month > 12) continue;
                    const rawAmt = mm.plan_amount;
                    const empty =
                        rawAmt == null || rawAmt === '' || String(rawAmt).trim() === '';
                    if (empty) {
                        emptyMonths.push([mid, month]);
                        continue;
                    }
                    await upsertPlanRow(db, {
                        managerUserId: mid,
                        year,
                        month,
                        planAmount: mm.plan_amount,
                        note: mm.note || '',
                        actor,
                    });
                }
                touched.add(mid);
            }
            if (emptyMonths.length) {
                const orSql = emptyMonths.map(() => '(manager_user_id = ? AND year = ? AND month = ?)').join(' OR ');
                const params = [];
                emptyMonths.forEach(([mid, month]) => {
                    params.push(mid, year, month);
                });
                await db.query(`DELETE FROM dg_manager_sales_plans WHERE ${orSql}`, params);
            }
            const persistIds = touched.size ? [...touched] : sales.map((m) => m.id);
            for (const id of persistIds) {
                await persistYearPct(db, id, year);
            }
            res.json({ success: true, year, managers: persistIds.length });
        } catch (e) {
            res.status(e.status || 500).json({ error: e.message || 'Ошибка сохранения планов' });
        }
    });

    router.put('/plans/month', async (req, res) => {
        try {
            await ensureSchema(db);
            if (!canSeeAll(req)) {
                return res.status(403).json({ error: 'Планы меняют Полный доступ и Бухгалтерия' });
            }
            const body = req.body || {};
            const year = normYear(body.year, currentYear());
            const month = Number(body.month);
            if (!Number.isFinite(month) || month < 1 || month > 12) {
                return res.status(400).json({ error: 'Укажите месяц 1–12' });
            }
            const sales = await listSalesManagers(db);
            const mid = Number(body.manager_user_id);
            if (!Number.isFinite(mid) || mid < 1 || !sales.some((m) => m.id === mid)) {
                return res.status(400).json({ error: 'Выберите менеджера из отдела продаж' });
            }
            const rawAmount = body.plan_amount;
            const empty =
                rawAmount == null ||
                rawAmount === '' ||
                String(rawAmount).trim() === '';
            if (empty) {
                await db.query(
                    'DELETE FROM dg_manager_sales_plans WHERE manager_user_id = ? AND year = ? AND month = ?',
                    [mid, year, month]
                );
                await persistMonthPct(db, mid, year, month);
                return res.json({ success: true, cleared: true, manager_user_id: mid, year, month });
            }
            const amount = toNum(rawAmount);
            if (amount == null || amount <= 0) {
                return res.status(400).json({ error: 'План должен быть больше 0 или пустой (базовый)' });
            }
            const note = clip(body.note, 255);
            await db.query(
                `INSERT INTO dg_manager_sales_plans (manager_user_id, year, month, plan_amount, note, updated_by)
                 VALUES (?, ?, ?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE plan_amount = VALUES(plan_amount), note = VALUES(note), updated_by = VALUES(updated_by)`,
                [mid, year, month, amount, note || null, actorId(req)]
            );
            await persistMonthPct(db, mid, year, month);
            res.json({
                success: true,
                manager_user_id: mid,
                year,
                month,
                plan_amount: amount,
                note: note || '',
            });
        } catch (e) {
            res.status(500).json({ error: e.message || 'Ошибка индивидуального плана' });
        }
    });

    router.get('/', async (req, res) => {
        try {
            await ensureSchema(db);
            const q = req.query || {};
            const built = await buildListWhere(db, q, req);
            let limit = Number(q.limit);
            if (!Number.isFinite(limit) || limit <= 0) limit = DEFAULT_LIMIT;
            limit = Math.min(MAX_LIMIT, Math.round(limit));
            let offset = Number(q.offset);
            if (!Number.isFinite(offset) || offset < 0) offset = 0;
            offset = Math.round(offset);
            const sortBy = SORT_KEYS.has(String(q.sort_by || '')) ? String(q.sort_by) : 'row_no';
            const sortDir = String(q.sort_dir || '').toLowerCase() === 'desc' ? 'DESC' : 'ASC';
            const sortCol =
                sortBy === 'manager_name'
                    ? 'u.full_name'
                    : sortBy === 'id' || sortBy === 'updated_at'
                      ? `r.${sortBy}`
                      : `r.${sortBy}`;
            const orderSql =
                sortBy === 'row_no'
                    ? `r.row_no ${sortDir}, r.our_invoice_no ASC, r.id ASC`
                    : `${sortCol} ${sortDir}, r.id ASC`;

            const [[cnt]] = await db.query(
                `SELECT COUNT(*) AS total
                   FROM ${ROW_FROM}
                  WHERE ${built.whereSql}`,
                built.params
            );
            const midView = built.managerId ? Number(built.managerId) : null;
            const totCredit = midView
                ? `COALESCE(SUM(CASE WHEN COALESCE(r.handed_to_user_id, r.manager_user_id) = ? THEN r.amount_ex_delivery END),0) AS amount_ex_delivery,
                    COALESCE(SUM(CASE WHEN COALESCE(r.handed_to_user_id, r.manager_user_id) = ? THEN r.amount_incl_stock END),0) AS amount_incl_stock,
                    COALESCE(SUM(CASE WHEN COALESCE(r.handed_to_user_id, r.manager_user_id) = ? THEN r.delivery_to_us END),0) AS delivery_to_us,
                    COALESCE(SUM(CASE WHEN COALESCE(r.handed_to_user_id, r.manager_user_id) = ? THEN r.diff END),0) AS diff`
                : `COALESCE(SUM(r.amount_ex_delivery),0) AS amount_ex_delivery,
                    COALESCE(SUM(r.amount_incl_stock),0) AS amount_incl_stock,
                    COALESCE(SUM(r.delivery_to_us),0) AS delivery_to_us,
                    COALESCE(SUM(r.diff),0) AS diff`;
            const totParams = midView ? [midView, midView, midView, midView].concat(built.params) : built.params;
            const [[tot]] = await db.query(
                `SELECT ${totCredit}
                   FROM ${ROW_FROM}
                  WHERE ${built.whereSql}`,
                totParams
            );
            const [rows] = await db.query(
                `SELECT ${ROW_SELECT}
                   FROM ${ROW_FROM}
                  WHERE ${built.whereSql}
                  ORDER BY ${orderSql}
                  LIMIT ? OFFSET ?`,
                built.params.concat([limit, offset])
            );
            const mapped = await decorateRows(
                db,
                await mapRowsWithPlan(db, rows || []),
                actorId(req)
            );
            const plans = await loadPlans(db);
            const [byMonth] = await db.query(
                `SELECT COALESCE(r.handed_to_user_id, r.manager_user_id) AS mid, MONTH(r.paid_at) AS m,
                        COALESCE(SUM(r.diff),0) AS diff
                   FROM ${ROW_FROM}
                  WHERE ${built.whereSql} AND r.paid_at IS NOT NULL
                  GROUP BY COALESCE(r.handed_to_user_id, r.manager_user_id), MONTH(r.paid_at)`,
                built.params
            );
            const mids = [];
            const seenMid = new Set();
            (byMonth || []).forEach((g) => {
                const id = Number(g.mid);
                if (!seenMid.has(id) && Number.isFinite(id) && id > 0) {
                    seenMid.add(id);
                    mids.push(id);
                }
            });
            if (built.managerId) {
                const id = Number(built.managerId);
                if (Number.isFinite(id) && id > 0 && !seenMid.has(id)) mids.push(id);
            }
            const facts = await fetchMonthTotals(db, built.year, mids);
            let bonusSum = 0;
            (byMonth || []).forEach((g) => {
                if (built.managerId && Number(g.mid) !== Number(built.managerId)) return;
                const month = Number(g.m);
                const fact = facts[monthKey(g.mid, month)] || 0;
                const plan = resolvePlan(plans, g.mid, built.year, month);
                const pct = pctMpFromMonthTotal(fact, plan.plan_amount, plan.steps);
                bonusSum += ((Number(g.diff) || 0) / 100) * pct;
            });
            let planInfo = null;
            if (built.managerId && built.month) {
                const plan = resolvePlan(plans, built.managerId, built.year, built.month);
                const monthTotal = facts[monthKey(built.managerId, built.month)] || 0;
                planInfo = {
                    plan_amount: plan.plan_amount,
                    source: plan.source,
                    note: plan.note,
                    month_total: monthTotal,
                    pct_mp: pctMpFromMonthTotal(monthTotal, plan.plan_amount, plan.steps),
                    steps: scaledPlanSteps(plan.plan_amount, plan.steps),
                };
            }
            res.json({
                success: true,
                year: built.year,
                month: built.month,
                total: Number(cnt && cnt.total) || 0,
                limit,
                offset,
                sort_by: sortBy,
                sort_dir: sortDir.toLowerCase(),
                can_write: canWrite(req),
                can_pick_manager: canSeeAll(req),
                can_edit_plans: canSeeAll(req),
                plan: planInfo,
                totals: {
                    amount_ex_delivery: Number(tot && tot.amount_ex_delivery) || 0,
                    amount_incl_stock: Number(tot && tot.amount_incl_stock) || 0,
                    delivery_to_us: Number(tot && tot.delivery_to_us) || 0,
                    diff: Number(tot && tot.diff) || 0,
                    bonus: Math.round(bonusSum * 100) / 100,
                },
                rows: mapped,
            });
        } catch (e) {
            res.status(500).json({ error: e.message || 'Ошибка списка' });
        }
    });

    router.post('/', async (req, res) => {
        try {
            await ensureSchema(db);
            if (!canWrite(req)) {
                return res.status(403).json({ error: 'Режим только просмотра', code: 'PAGE_VIEW_ONLY' });
            }
            const body = req.body || {};
            const year = normYear(body.year, currentYear());
            let managerUserId = actorId(req);
            if (canSeeAll(req) && body.manager_user_id != null) {
                const n = Number(body.manager_user_id);
                const sales = await listSalesManagers(db);
                if (Number.isFinite(n) && n > 0 && sales.some((m) => m.id === n)) managerUserId = n;
            }
            if (!managerUserId) {
                return res.status(400).json({ error: 'Не указан менеджер' });
            }
            const monthHint = Math.round(Number(body.month) || 0);
            const rowNo = await nextRowNo(db, managerUserId, year, monthHint);
            const row = applyBodyToRow(body, {
                year,
                manager_user_id: managerUserId,
                row_no: rowNo,
                has_contract: '',
                invoice_org: '',
            });
            const [ins] = await db.query(INSERT_SQL, rowToInsertParams(row, actorId(req)));
            try {
                await persistMonthPct(db, managerUserId, year, paidMonth(row.paid_at));
            } catch (_) {}
            const saved = await fetchRowById(db, ins.insertId);
            try {
                await insertRowLog(db, {
                    rowId: ins.insertId,
                    field: '_row',
                    oldValue: null,
                    newValue: 'создано',
                    action: 'create',
                    source: 'ui',
                    actor: req.datagonActor,
                });
            } catch (le) {
                console.warn('[manager-sales] create log', le && le.message);
            }
            const decorated = await decorateRows(
                db,
                await mapRowsWithPlan(db, [saved]),
                actorId(req)
            );
            res.json({ success: true, row: decorated[0] || mapRow(saved) });
        } catch (e) {
            res.status(500).json({ error: e.message || 'Ошибка создания' });
        }
    });

    router.patch('/:id', async (req, res) => {
        try {
            await ensureSchema(db);
            if (!canWrite(req)) {
                return res.status(403).json({ error: 'Режим только просмотра', code: 'PAGE_VIEW_ONLY' });
            }
            const id = Number(req.params.id);
            if (!Number.isFinite(id) || id <= 0) {
                return res.status(400).json({ error: 'Некорректный id' });
            }
            const existing = await fetchRowById(db, id);
            if (!existing) return res.status(404).json({ error: 'Строка не найдена' });
            if (existing.archived_at) {
                return res.status(400).json({ error: 'Строка в архиве — сначала верните из архива' });
            }
            if (!canTouchRow(req, existing)) {
                return res.status(403).json({ error: 'Нельзя менять чужую таблицу' });
            }
            const oldMonth = paidMonth(existing.paid_at);
            const next = applyBodyToRow(req.body || {}, mapRow(existing));
            if (!canSeeAll(req)) next.manager_user_id = Number(existing.manager_user_id);
            const newMonth = paidMonth(next.paid_at);
            const newMid = Number(next.manager_user_id);
            const twinNo = await rowNoForSameInvoice(
                db,
                newMid,
                next.year,
                newMonth,
                next.our_invoice_no,
                id
            );
            if (twinNo) next.row_no = twinNo;
            else if (
                newMonth !== oldMonth ||
                Number(next.year) !== Number(existing.year) ||
                newMid !== Number(existing.manager_user_id)
            ) {
                const taken = await rowNoTaken(
                    db,
                    newMid,
                    next.year,
                    newMonth,
                    next.row_no,
                    id,
                    next.our_invoice_no
                );
                if (taken) next.row_no = await nextRowNo(db, newMid, next.year, newMonth);
            }
            const creditMid = creditManagerId(existing);
            const plans = await loadPlans(db);
            const factsPre = await fetchMonthTotals(db, next.year, [creditMid]);
            const monthForPct = newMonth || oldMonth;
            let nextPct = 0;
            if (monthForPct) {
                let fact = factsPre[monthKey(creditMid, monthForPct)] || 0;
                const oldAmt = Number(existing.amount_ex_delivery) || 0;
                const newAmt = Number(next.amount_ex_delivery) || 0;
                if (oldMonth === monthForPct && newMonth === monthForPct) {
                    fact = fact - oldAmt + newAmt;
                } else if (newMonth === monthForPct) {
                    fact = fact + newAmt;
                }
                const plan = resolvePlan(plans, creditMid, next.year, monthForPct);
                nextPct = pctMpFromMonthTotal(Math.max(0, fact), plan.plan_amount, plan.steps);
            }
            const calc = computeRow(Object.assign({}, next, { pct_mp: nextPct }));
            next.pct_mp = calc.pct_mp;
            next.bonus = calc.bonus;
            next.diff = calc.diff;
            next.pct_r = calc.pct_r;
            await db.query(UPDATE_SQL, [
                next.year,
                next.manager_user_id,
                next.row_no,
                next.payment_terms || null,
                next.paid_at || null,
                next.invoice_org || '',
                next.order_url || null,
                next.amount_ex_delivery,
                next.vat,
                next.our_invoice_no || null,
                next.has_contract || null,
                next.supplier_invoice_url || null,
                next.amount_incl_stock,
                next.delivery_to_us,
                next.supplier_name || null,
                next.supplier_invoice_no || null,
                next.diff,
                next.pct_r,
                next.status || null,
                next.pct_mp,
                next.bonus,
                next.invoice_mark || '',
                next.our_invoice_mark || '',
                next.suppliers_json || null,
                actorId(req),
                id,
            ]);
            const saved = await fetchRowById(db, id);
            try {
                await logRowChanges(db, {
                    rowId: id,
                    before: mapRow(existing),
                    after: mapRow(saved, next.pct_mp),
                    actor: req.datagonActor,
                    source: 'ui',
                    action: 'set',
                });
            } catch (le) {
                console.warn('[manager-sales] patch log', le && le.message);
            }
            try {
                const persistMids = new Set(
                    [creditManagerId(existing), creditManagerId(saved || next), Number(existing.manager_user_id)].filter(
                        (n) => Number.isFinite(n) && n > 0
                    )
                );
                for (const pid of persistMids) {
                    if (oldMonth) await persistMonthPct(db, pid, existing.year, oldMonth);
                    if (newMonth && newMonth !== oldMonth) await persistMonthPct(db, pid, next.year, newMonth);
                    else if (newMonth) await persistMonthPct(db, pid, next.year, newMonth);
                }
            } catch (pe) {
                console.warn('[manager-sales] persist month pct', pe && pe.message);
            }
            const decorated = await decorateRows(
                db,
                await mapRowsWithPlan(db, [await fetchRowById(db, id)]),
                actorId(req)
            );
            res.json({ success: true, row: decorated[0] || mapRow(saved, next.pct_mp) });
        } catch (e) {
            res.status(500).json({ error: e.message || 'Ошибка сохранения' });
        }
    });

    router.get('/:id/log', async (req, res) => {
        try {
            await ensureSchema(db);
            const id = Number(req.params.id);
            if (!Number.isFinite(id) || id <= 0) {
                return res.status(400).json({ error: 'Некорректный id' });
            }
            const existing = await fetchRowById(db, id);
            if (!existing) return res.status(404).json({ error: 'Строка не найдена' });
            if (!canSeeAll(req) && Number(existing.manager_user_id) !== actorId(req)) {
                return res.status(403).json({ error: 'Нельзя смотреть чужой журнал' });
            }
            const rawLimit = Number(req.query.limit);
            const limit = Math.min(
                500,
                Math.max(1, Number.isFinite(rawLimit) && rawLimit > 0 ? Math.floor(rawLimit) : 100)
            );
            const rawOffset = Number(req.query.offset);
            const offset = Math.max(0, Number.isFinite(rawOffset) && rawOffset >= 0 ? Math.floor(rawOffset) : 0);
            const field = String(req.query.field || '').trim();
            const where = ['row_id = ?'];
            const params = [id];
            let fieldGroup = null;
            if (field === 'supplier_invoice_url') {
                fieldGroup = ['supplier_invoice_url', 'invoice_mark'];
            } else if (field === 'our_invoice_no') {
                fieldGroup = ['our_invoice_no', 'our_invoice_mark'];
            } else if (field === 'ship_together' || field === 'ship_group_id') {
                where.push('field = ?');
                params.push('ship_group_id');
            } else if (field) {
                where.push('field = ?');
                params.push(field);
            }
            if (fieldGroup) {
                where.push(`field IN (${fieldGroup.map(() => '?').join(',')})`);
                params.push(...fieldGroup);
            }
            const whereSql = `WHERE ${where.join(' AND ')}`;
            const [[cnt]] = await db.query(
                `SELECT COUNT(*) AS total FROM dg_manager_sales_log ${whereSql}`,
                params
            );
            const [rows] = await db.query(
                `SELECT id, row_id, field, old_value, new_value, action, source,
                        changed_by_user_id, changed_by_name, note, changed_at
                   FROM dg_manager_sales_log ${whereSql}
                  ORDER BY id DESC
                  LIMIT ? OFFSET ?`,
                [...params, limit, offset]
            );
            res.json({
                success: true,
                row_id: id,
                row: mapRow(existing),
                rows: (rows || []).map((r) => {
                    const f = String(r.field || '');
                    const note = r.note != null ? String(r.note) : '';
                    let label = FIELD_LOG_LABELS[f] || f;
                    if (f === 'invoice_mark' && note) {
                        const supp = note.match(/поставщик\s*#\d+/i);
                        if (supp) label = `${label} (${supp[0]})`;
                        else if (!/https?:\/\//i.test(note)) label = `${label} (${note})`;
                    }
                    return {
                        id: Number(r.id),
                        row_id: Number(r.row_id),
                        field: f,
                        field_label: label,
                        old_value: r.old_value != null ? String(r.old_value) : null,
                        new_value: r.new_value != null ? String(r.new_value) : null,
                        action: String(r.action || 'set'),
                        source: String(r.source || 'ui'),
                        changed_by_user_id: r.changed_by_user_id != null ? Number(r.changed_by_user_id) : null,
                        changed_by_name: r.changed_by_name != null ? String(r.changed_by_name) : '',
                        note,
                        changed_at: r.changed_at ? new Date(r.changed_at).toISOString() : '',
                    };
                }),
                total: Number(cnt && cnt.total) || 0,
                limit,
                offset,
            });
        } catch (e) {
            res.status(500).json({ error: e.message || 'Ошибка журнала' });
        }
    });

    router.post('/:id/ship-group', async (req, res) => {
        try {
            await ensureSchema(db);
            if (!canWrite(req)) {
                return res.status(403).json({ error: 'Режим только просмотра', code: 'PAGE_VIEW_ONLY' });
            }
            const id = Number(req.params.id);
            if (!Number.isFinite(id) || id <= 0) {
                return res.status(400).json({ error: 'Некорректный id' });
            }
            const existing = await fetchRowById(db, id);
            if (!existing) return res.status(404).json({ error: 'Строка не найдена' });
            if (!canTouchRow(req, existing)) {
                return res.status(403).json({ error: 'Нельзя связывать чужую таблицу' });
            }
            if (existing.archived_at) {
                return res.status(400).json({ error: 'Сначала верните строку из архива' });
            }
            const body = req.body || {};
            let mate = null;
            const mateIdRaw = body.mate_row_id != null ? Number(body.mate_row_id) : NaN;
            if (Number.isFinite(mateIdRaw) && mateIdRaw > 0) {
                mate = await fetchRowById(db, mateIdRaw);
                if (!mate || mate.archived_at) {
                    return res.status(404).json({ error: 'Строка для связки не найдена' });
                }
                if (Number(mate.year) !== Number(existing.year)) {
                    return res.status(400).json({ error: 'Связка только в пределах одного года' });
                }
            } else {
                const inv = normOurInvoiceLookup(body.our_invoice_no);
                if (!inv) {
                    return res.status(400).json({ error: 'Укажите № нашего счёта другой строки' });
                }
                const selfInv = normOurInvoiceLookup(existing.our_invoice_no);
                if (selfInv && selfInv.toLowerCase() === inv.toLowerCase()) {
                    return res.status(400).json({ error: 'Укажите № счёта другой строки, не этой' });
                }
                const found = await findRowsByOurInvoice(db, {
                    year: existing.year,
                    invoiceNo: inv,
                    excludeId: id,
                });
                const touchable = found.filter((r) => canTouchRow(req, r));
                if (!touchable.length) {
                    return res.status(404).json({
                        error: 'Строка с таким № нашего счёта не найдена (год ' + existing.year + ')',
                    });
                }
                const sameMgr = touchable.filter(
                    (r) => Number(r.manager_user_id) === Number(existing.manager_user_id)
                );
                const pool = sameMgr.length ? sameMgr : touchable;
                if (pool.length > 1) {
                    return res.status(409).json({
                        error:
                            'Несколько строк с № «' +
                            inv +
                            '». Уточните или откройте нужную таблицу менеджера.',
                        matches: pool.map((r) => ({
                            id: Number(r.id),
                            our_invoice_no: r.our_invoice_no || '',
                            row_no: r.row_no != null ? Number(r.row_no) : 0,
                            manager_user_id: Number(r.manager_user_id) || 0,
                        })),
                    });
                }
                mate = pool[0];
            }
            if (!mate || Number(mate.id) === id) {
                return res.status(400).json({ error: 'Нечего связывать' });
            }
            if (!canTouchRow(req, mate)) {
                return res.status(403).json({ error: 'Нет доступа к строке с этим № счёта' });
            }
            const actor = actorId(req);
            const ga = normShipGroupId(existing.ship_group_id);
            const gb = normShipGroupId(mate.ship_group_id);
            let gid = '';
            const oldA = ga;
            const oldB = gb;
            if (ga && gb && ga === gb) {
                gid = ga;
            } else if (ga && !gb) {
                gid = ga;
                await setRowsShipGroup(db, [mate.id], gid, actor);
            } else if (!ga && gb) {
                gid = gb;
                await setRowsShipGroup(db, [id], gid, actor);
            } else if (ga && gb && ga !== gb) {
                gid = ga;
                await db.query(
                    `UPDATE dg_manager_sales_rows
                        SET ship_group_id = ?, updated_by = ?
                      WHERE ship_group_id = ? AND archived_at IS NULL`,
                    [gid, actor, gb]
                );
                await setRowsShipGroup(db, [id, mate.id], gid, actor);
            } else {
                gid = newShipGroupId();
                await setRowsShipGroup(db, [id, mate.id], gid, actor);
            }
            const mateInv = normOurInvoiceLookup(mate.our_invoice_no) || '#' + mate.id;
            const selfInvLog = normOurInvoiceLookup(existing.our_invoice_no) || '#' + id;
            try {
                if (oldA !== gid) {
                    await insertRowLog(db, {
                        rowId: id,
                        field: 'ship_group_id',
                        oldValue: oldA ? 'в связке' : '',
                        newValue: 'связан с ' + mateInv,
                        action: 'ship_link',
                        source: 'ui',
                        actor: req.datagonActor,
                        note: gid,
                    });
                }
                if (oldB !== gid) {
                    await insertRowLog(db, {
                        rowId: mate.id,
                        field: 'ship_group_id',
                        oldValue: oldB ? 'в связке' : '',
                        newValue: 'связан с ' + selfInvLog,
                        action: 'ship_link',
                        source: 'ui',
                        actor: req.datagonActor,
                        note: gid,
                    });
                }
            } catch (le) {
                console.warn('[manager-sales] ship-group log', le && le.message);
            }
            if (ga && gb && ga !== gb) {
                await dissolveLonelyShipGroups(db, [gb], actor);
            }
            const saved = await fetchRowById(db, id);
            const decorated = await decorateRows(
                db,
                await mapRowsWithPlan(db, [saved]),
                actorId(req)
            );
            res.json({ success: true, row: decorated[0] || mapRow(saved) });
        } catch (e) {
            res.status(500).json({ error: e.message || 'Ошибка связки отправки' });
        }
    });

    router.delete('/:id/ship-group', async (req, res) => {
        try {
            await ensureSchema(db);
            if (!canWrite(req)) {
                return res.status(403).json({ error: 'Режим только просмотра', code: 'PAGE_VIEW_ONLY' });
            }
            const id = Number(req.params.id);
            if (!Number.isFinite(id) || id <= 0) {
                return res.status(400).json({ error: 'Некорректный id' });
            }
            const existing = await fetchRowById(db, id);
            if (!existing) return res.status(404).json({ error: 'Строка не найдена' });
            if (!canTouchRow(req, existing)) {
                return res.status(403).json({ error: 'Нельзя менять чужую таблицу' });
            }
            if (existing.archived_at) {
                return res.status(400).json({ error: 'Сначала верните строку из архива' });
            }
            const gid = normShipGroupId(existing.ship_group_id);
            if (!gid) {
                return res.json({ success: true, row: (await decorateRows(db, await mapRowsWithPlan(db, [existing]), actorId(req)))[0] });
            }
            const actor = actorId(req);
            await setRowsShipGroup(db, [id], null, actor);
            try {
                const selfInvLeave = normOurInvoiceLookup(existing.our_invoice_no) || '#' + id;
                await insertRowLog(db, {
                    rowId: id,
                    field: 'ship_group_id',
                    oldValue: 'в связке',
                    newValue: 'вышел (' + selfInvLeave + ')',
                    action: 'ship_leave',
                    source: 'ui',
                    actor: req.datagonActor,
                    note: gid,
                });
            } catch (le) {
                console.warn('[manager-sales] ship-leave log', le && le.message);
            }
            await dissolveLonelyShipGroups(db, [gid], actor);
            const saved = await fetchRowById(db, id);
            const decorated = await decorateRows(
                db,
                await mapRowsWithPlan(db, [saved]),
                actorId(req)
            );
            res.json({ success: true, row: decorated[0] || mapRow(saved) });
        } catch (e) {
            res.status(500).json({ error: e.message || 'Ошибка выхода из связки' });
        }
    });

    router.post('/:id/comments', async (req, res) => {
        try {
            await ensureSchema(db);
            if (!canWrite(req)) {
                return res.status(403).json({ error: 'Режим только просмотра', code: 'PAGE_VIEW_ONLY' });
            }
            const id = Number(req.params.id);
            if (!Number.isFinite(id) || id <= 0) {
                return res.status(400).json({ error: 'Некорректный id' });
            }
            const existing = await fetchRowById(db, id);
            if (!existing) return res.status(404).json({ error: 'Строка не найдена' });
            if (!canTouchRow(req, existing)) {
                return res.status(403).json({ error: 'Нельзя комментировать чужую таблицу' });
            }
            if (existing.archived_at) {
                return res.status(400).json({ error: 'Сначала верните строку из архива' });
            }
            const body = normCommentBody(req.body && req.body.body);
            if (!body) {
                return res.status(400).json({ error: 'Введите текст комментария' });
            }
            const actor = actorId(req);
            if (!actor) {
                return res.status(401).json({ error: 'Нужна авторизация' });
            }
            const authorName = actorDisplayName(req.datagonActor) || String(actor);
            const [ins] = await db.query(
                `INSERT INTO dg_manager_sales_comments (row_id, body, author_user_id, author_name)
                 VALUES (?, ?, ?, ?)`,
                [id, body, actor, authorName]
            );
            try {
                await insertRowLog(db, {
                    rowId: id,
                    field: 'comment',
                    oldValue: null,
                    newValue: body,
                    action: 'comment_add',
                    source: 'ui',
                    actor: req.datagonActor,
                });
            } catch (le) {
                console.warn('[manager-sales] comment log', le && le.message);
            }
            const [[row]] = await db.query(
                `SELECT id, row_id, body, author_user_id, author_name, created_at, updated_at
                   FROM dg_manager_sales_comments WHERE id = ?`,
                [ins.insertId]
            );
            const decorated = await decorateRows(
                db,
                await mapRowsWithPlan(db, [existing]),
                actor
            );
            res.json({
                success: true,
                comment: mapComment(row || { id: ins.insertId, row_id: id, body, author_user_id: actor, author_name: authorName }, actor),
                row: decorated[0] || mapRow(existing),
            });
        } catch (e) {
            res.status(500).json({ error: e.message || 'Ошибка комментария' });
        }
    });

    router.patch('/:id/comments/:commentId', async (req, res) => {
        try {
            await ensureSchema(db);
            if (!canWrite(req)) {
                return res.status(403).json({ error: 'Режим только просмотра', code: 'PAGE_VIEW_ONLY' });
            }
            const id = Number(req.params.id);
            const commentId = Number(req.params.commentId);
            if (!Number.isFinite(id) || id <= 0 || !Number.isFinite(commentId) || commentId <= 0) {
                return res.status(400).json({ error: 'Некорректный id' });
            }
            const existing = await fetchRowById(db, id);
            if (!existing) return res.status(404).json({ error: 'Строка не найдена' });
            if (!canTouchRow(req, existing)) {
                return res.status(403).json({ error: 'Нельзя менять чужую таблицу' });
            }
            if (existing.archived_at) {
                return res.status(400).json({ error: 'Сначала верните строку из архива' });
            }
            const [[cmt]] = await db.query(
                `SELECT id, row_id, body, author_user_id, author_name, created_at, updated_at
                   FROM dg_manager_sales_comments WHERE id = ? AND row_id = ?`,
                [commentId, id]
            );
            if (!cmt) return res.status(404).json({ error: 'Комментарий не найден' });
            const actor = actorId(req);
            if (!actor || Number(cmt.author_user_id) !== actor) {
                return res.status(403).json({ error: 'Редактировать можно только свой комментарий' });
            }
            const body = normCommentBody(req.body && req.body.body);
            if (!body) {
                return res.status(400).json({ error: 'Введите текст комментария' });
            }
            const oldBody = String(cmt.body || '');
            await db.query('UPDATE dg_manager_sales_comments SET body = ? WHERE id = ? AND row_id = ?', [
                body,
                commentId,
                id,
            ]);
            try {
                await insertRowLog(db, {
                    rowId: id,
                    field: 'comment',
                    oldValue: oldBody,
                    newValue: body,
                    action: 'comment_edit',
                    source: 'ui',
                    actor: req.datagonActor,
                });
            } catch (le) {
                console.warn('[manager-sales] comment edit log', le && le.message);
            }
            const [[updated]] = await db.query(
                `SELECT id, row_id, body, author_user_id, author_name, created_at, updated_at
                   FROM dg_manager_sales_comments WHERE id = ?`,
                [commentId]
            );
            const decorated = await decorateRows(
                db,
                await mapRowsWithPlan(db, [existing]),
                actor
            );
            res.json({
                success: true,
                comment: mapComment(updated || Object.assign({}, cmt, { body }), actor),
                row: decorated[0] || mapRow(existing),
            });
        } catch (e) {
            res.status(500).json({ error: e.message || 'Ошибка редактирования комментария' });
        }
    });

    router.delete('/:id/comments/:commentId', async (req, res) => {
        try {
            await ensureSchema(db);
            if (!canWrite(req)) {
                return res.status(403).json({ error: 'Режим только просмотра', code: 'PAGE_VIEW_ONLY' });
            }
            const id = Number(req.params.id);
            const commentId = Number(req.params.commentId);
            if (!Number.isFinite(id) || id <= 0 || !Number.isFinite(commentId) || commentId <= 0) {
                return res.status(400).json({ error: 'Некорректный id' });
            }
            const existing = await fetchRowById(db, id);
            if (!existing) return res.status(404).json({ error: 'Строка не найдена' });
            if (!canTouchRow(req, existing)) {
                return res.status(403).json({ error: 'Нельзя менять чужую таблицу' });
            }
            if (existing.archived_at) {
                return res.status(400).json({ error: 'Сначала верните строку из архива' });
            }
            const [[cmt]] = await db.query(
                `SELECT id, row_id, body, author_user_id, author_name, created_at, updated_at
                   FROM dg_manager_sales_comments WHERE id = ? AND row_id = ?`,
                [commentId, id]
            );
            if (!cmt) return res.status(404).json({ error: 'Комментарий не найден' });
            const actor = actorId(req);
            if (!actor || Number(cmt.author_user_id) !== actor) {
                return res.status(403).json({ error: 'Удалить можно только свой комментарий' });
            }
            const oldBody = String(cmt.body || '');
            await db.query('DELETE FROM dg_manager_sales_comments WHERE id = ? AND row_id = ?', [commentId, id]);
            try {
                await insertRowLog(db, {
                    rowId: id,
                    field: 'comment',
                    oldValue: oldBody,
                    newValue: null,
                    action: 'comment_del',
                    source: 'ui',
                    actor: req.datagonActor,
                });
            } catch (le) {
                console.warn('[manager-sales] comment del log', le && le.message);
            }
            const decorated = await decorateRows(
                db,
                await mapRowsWithPlan(db, [existing]),
                actor
            );
            res.json({
                success: true,
                deleted: commentId,
                row: decorated[0] || mapRow(existing),
            });
        } catch (e) {
            res.status(500).json({ error: e.message || 'Ошибка удаления комментария' });
        }
    });

    router.post('/:id/hand-over', async (req, res) => {
        try {
            await ensureSchema(db);
            if (!canWrite(req)) {
                return res.status(403).json({ error: 'Режим только просмотра', code: 'PAGE_VIEW_ONLY' });
            }
            const id = Number(req.params.id);
            if (!Number.isFinite(id) || id <= 0) {
                return res.status(400).json({ error: 'Некорректный id' });
            }
            const existing = await fetchRowById(db, id);
            if (!existing) return res.status(404).json({ error: 'Строка не найдена' });
            if (existing.archived_at) {
                return res.status(400).json({ error: 'Сначала верните строку из архива' });
            }
            if (!canHandOverRow(req, existing)) {
                return res.status(403).json({ error: 'Передавать заказ может владелец таблицы' });
            }
            const sales = await listSalesManagers(db);
            const salesIds = new Set(sales.map((m) => m.id));
            const body = req.body || {};
            const raw = body.manager_user_id;
            const empty = raw == null || raw === '' || String(raw).trim() === '0';
            let target = null;
            if (!empty) {
                const n = Number(raw);
                if (!Number.isFinite(n) || n < 1 || !salesIds.has(n)) {
                    return res.status(400).json({ error: 'Выберите менеджера из отдела продаж' });
                }
                if (n === Number(existing.manager_user_id)) target = null;
                else target = n;
            }
            const prev = Number(existing.handed_to_user_id) || null;
            const actor = actorId(req);
            if (target) {
                await db.query(
                    `UPDATE dg_manager_sales_rows
                        SET handed_to_user_id = ?, handed_to_at = NOW(), handed_by = ?, updated_by = ?
                      WHERE id = ?`,
                    [target, actor, actor, id]
                );
            } else {
                await db.query(
                    `UPDATE dg_manager_sales_rows
                        SET handed_to_user_id = NULL, handed_to_at = NULL, handed_by = NULL, updated_by = ?
                      WHERE id = ?`,
                    [actor, id]
                );
            }
            const nameOf = (uid) => {
                if (!uid) return '';
                const m = sales.find((x) => x.id === Number(uid));
                return m ? m.full_name || m.username || String(uid) : String(uid);
            };
            await insertRowLog(db, {
                rowId: id,
                field: 'handed_to_user_id',
                oldValue: prev ? nameOf(prev) : '',
                newValue: target ? nameOf(target) : '',
                action: target ? 'hand_over' : 'hand_back',
                source: 'ui',
                actor: req.datagonActor,
            });
            const month = paidMonth(existing.paid_at);
            const persistMids = new Set(
                [Number(existing.manager_user_id), prev, target].filter((n) => Number.isFinite(n) && n > 0)
            );
            for (const pid of persistMids) {
                if (month) await persistMonthPct(db, pid, existing.year, month);
                else await persistYearPct(db, pid, existing.year);
            }
            const saved = await fetchRowById(db, id);
            const decorated = await decorateRows(
                db,
                await mapRowsWithPlan(db, [saved]),
                actorId(req)
            );
            res.json({ success: true, row: decorated[0] || mapRow(saved) });
        } catch (e) {
            res.status(500).json({ error: e.message || 'Ошибка передачи заказа' });
        }
    });

    router.post('/:id/restore', async (req, res) => {
        try {
            await ensureSchema(db);
            if (!canWrite(req)) {
                return res.status(403).json({ error: 'Режим только просмотра', code: 'PAGE_VIEW_ONLY' });
            }
            const id = Number(req.params.id);
            if (!Number.isFinite(id) || id <= 0) {
                return res.status(400).json({ error: 'Некорректный id' });
            }
            const existing = await fetchRowById(db, id);
            if (!existing) return res.status(404).json({ error: 'Строка не найдена' });
            if (!canTouchRow(req, existing)) {
                return res.status(403).json({ error: 'Нельзя менять чужую таблицу' });
            }
            if (!existing.archived_at) {
                return res.status(400).json({ error: 'Строка не в архиве' });
            }
            await db.query(
                'UPDATE dg_manager_sales_rows SET archived_at = NULL, archived_by = NULL, updated_by = ? WHERE id = ?',
                [actorId(req), id]
            );
            await insertRowLog(db, {
                rowId: id,
                field: 'archived',
                oldValue: 'в архиве',
                newValue: 'восстановлено',
                action: 'restore',
                source: 'ui',
                actor: req.datagonActor,
            });
            const saved = await fetchRowById(db, id);
            try {
                const month = paidMonth(existing.paid_at);
                const persistMids = new Set(
                    [Number(existing.manager_user_id), creditManagerId(existing)].filter(
                        (n) => Number.isFinite(n) && n > 0
                    )
                );
                for (const pid of persistMids) {
                    if (month) await persistMonthPct(db, pid, existing.year, month);
                    else await persistYearPct(db, pid, existing.year);
                }
            } catch (_) {}
            const decorated = await decorateRows(
                db,
                await mapRowsWithPlan(db, [saved]),
                actorId(req)
            );
            res.json({ success: true, row: decorated[0] || mapRow(saved) });
        } catch (e) {
            res.status(500).json({ error: e.message || 'Ошибка восстановления' });
        }
    });

    router.delete('/:id', async (req, res) => {
        try {
            await ensureSchema(db);
            if (!canWrite(req)) {
                return res.status(403).json({ error: 'Режим только просмотра', code: 'PAGE_VIEW_ONLY' });
            }
            const id = Number(req.params.id);
            if (!Number.isFinite(id) || id <= 0) {
                return res.status(400).json({ error: 'Некорректный id' });
            }
            const existing = await fetchRowById(db, id);
            if (!existing) return res.status(404).json({ error: 'Строка не найдена' });
            if (!canTouchRow(req, existing)) {
                return res.status(403).json({ error: 'Нельзя архивировать чужую таблицу' });
            }
            if (existing.archived_at) {
                return res.status(400).json({ error: 'Строка уже в архиве' });
            }
            await db.query(
                'UPDATE dg_manager_sales_rows SET archived_at = NOW(), archived_by = ?, updated_by = ? WHERE id = ?',
                [actorId(req), actorId(req), id]
            );
            await insertRowLog(db, {
                rowId: id,
                field: 'archived',
                oldValue: 'активна',
                newValue: 'в архиве',
                action: 'archive',
                source: 'ui',
                actor: req.datagonActor,
            });
            const saved = await fetchRowById(db, id);
            try {
                const month = paidMonth(existing.paid_at);
                const persistMids = new Set(
                    [Number(existing.manager_user_id), creditManagerId(existing)].filter(
                        (n) => Number.isFinite(n) && n > 0
                    )
                );
                for (const pid of persistMids) {
                    if (month) await persistMonthPct(db, pid, existing.year, month);
                    else await persistYearPct(db, pid, existing.year);
                }
            } catch (_) {}
            const decorated = await decorateRows(
                db,
                await mapRowsWithPlan(db, [saved]),
                actorId(req)
            );
            res.json({ success: true, archived: id, row: decorated[0] || mapRow(saved) });
        } catch (e) {
            res.status(500).json({ error: e.message || 'Ошибка архива' });
        }
    });

    router.post('/import-csv', async (req, res) => {
        const started = Date.now();
        try {
            await ensureSchema(db);
            if (!canWrite(req)) {
                return res.status(403).json({ error: 'Режим только просмотра', code: 'PAGE_VIEW_ONLY' });
            }
            const body = req.body || {};
            const dryRun = body.dry_run === 1 || body.dry_run === true || body.dry_run === '1';
            const year = normYear(body.year, currentYear());
            let managerUserId = actorId(req);
            if (canSeeAll(req) && body.manager_user_id != null) {
                const n = Number(body.manager_user_id);
                const sales = await listSalesManagers(db);
                if (Number.isFinite(n) && n > 0 && sales.some((m) => m.id === n)) managerUserId = n;
            }
            if (!managerUserId) {
                return res.status(400).json({ error: 'Не указан менеджер' });
            }
            const parsed = parseDelimited(body.csv || '');
            if (!parsed.headers.length) {
                return res.status(400).json({ error: 'Пустой CSV' });
            }
            const keys = parsed.headers.map(headerKey);
            if (!keys.some(Boolean)) {
                return res.status(400).json({
                    error: 'Не удалось распознать заголовки. Ожидаются колонки Google-таблицы менеджера.',
                });
            }
            let nextNo = 1;
            const usedByMonth = new Map();
            const [existNos] = await db.query(
                `SELECT COALESCE(MONTH(paid_at), 0) AS m, row_no, our_invoice_no
                   FROM dg_manager_sales_rows
                  WHERE manager_user_id = ? AND year = ?`,
                [managerUserId, year]
            );
            (existNos || []).forEach((r) => {
                claimRowNo(usedByMonth, Number(r.m) || 0, r.row_no, foldInvoiceNo(r.our_invoice_no));
            });
            let wouldInsert = 0;
            let skipped = 0;
            const errors = [];
            const toInsert = [];
            parsed.rows.forEach((cells, idx) => {
                const obj = {};
                keys.forEach((k, i) => {
                    if (!k) return;
                    obj[k] = cells[i];
                });
                const empty = Object.keys(obj).every((k) => String(obj[k] == null ? '' : obj[k]).trim() === '');
                if (empty) {
                    skipped += 1;
                    return;
                }
                try {
                    const row = applyBodyToRow(obj, {
                        year,
                        manager_user_id: managerUserId,
                        row_no: 0,
                        has_contract: '',
                        invoice_org: '',
                    });
                    const mk = rowMonthKey(row.paid_at);
                    const wanted =
                        obj.row_no != null && String(obj.row_no).trim() !== ''
                            ? Math.round(Number(toNum(obj.row_no) || 0))
                            : 0;
                    row.row_no = claimRowNo(
                        usedByMonth,
                        mk,
                        wanted || nextNo,
                        foldInvoiceNo(row.our_invoice_no)
                    );
                    nextNo = Math.max(nextNo, row.row_no) + 1;
                    toInsert.push(row);
                    wouldInsert += 1;
                } catch (e) {
                    if (errors.length < 20) {
                        errors.push({ code: String(idx + 2), error: e.message || 'строка' });
                    }
                }
            });
            let inserted = 0;
            if (!dryRun) {
                for (const row of toInsert) {
                    const [ins] = await db.query(INSERT_SQL, rowToInsertParams(row, actorId(req)));
                    inserted += 1;
                    try {
                        await insertRowLog(db, {
                            rowId: ins.insertId,
                            field: '_row',
                            oldValue: null,
                            newValue: 'импорт CSV',
                            action: 'create',
                            source: 'import',
                            actor: req.datagonActor,
                        });
                    } catch (_) {}
                }
                for (let m = 1; m <= 12; m += 1) {
                    try {
                        await persistMonthPct(db, managerUserId, year, m);
                    } catch (_) {}
                }
            }
            res.json({
                success: true,
                dry_run: dryRun,
                year,
                manager_user_id: managerUserId,
                total: parsed.rows.length,
                to_update: wouldInsert,
                would_update: dryRun ? wouldInsert : undefined,
                filled: inserted,
                skipped,
                errors,
                duration_sec: Math.round((Date.now() - started) / 100) / 10,
            });
        } catch (e) {
            res.status(500).json({ error: e.message || 'Ошибка импорта' });
        }
    });

    return router;
};
