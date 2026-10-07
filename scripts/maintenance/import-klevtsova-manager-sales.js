#!/usr/bin/env node
'use strict';

/**
 * Импорт годовых листов Google-книги менеджера в dg_manager_sales_rows.
 *   node scripts/maintenance/import-klevtsova-manager-sales.js [username] [/path/to.xlsx] [year]
 *   node scripts/maintenance/import-klevtsova-manager-sales.js yuliya_elagina /tmp/elagina-sales.xlsx
 *   node scripts/maintenance/import-klevtsova-manager-sales.js anna_popova /tmp/popova-sales.xlsx 2024
 */

const path = require('path');
const ExcelJS = require('exceljs');
const mysql = require('mysql2/promise');
const config = require('../../config');
const { computeRow, toNum, normHasContract, normStatus } = require('../../lib/managerSalesCalc');

function parseArgs() {
    const a = process.argv.slice(2);
    let username = 'evgeniya_klevtsova';
    let xlsxPath = '/tmp/klevtsova-sales.xlsx';
    let yearOnly = null;
    const rest = [];
    a.forEach((x) => {
        if (/^\d{4}$/.test(x)) yearOnly = Number(x);
        else rest.push(x);
    });
    if (rest[0] && /\.xlsx$/i.test(rest[0])) {
        xlsxPath = rest[0];
    } else if (rest[0]) {
        username = rest[0];
        if (rest[1]) xlsxPath = rest[1];
        else if (username === 'yuliya_elagina') xlsxPath = '/tmp/elagina-sales.xlsx';
        else if (username === 'ekaterina_kilanyan') xlsxPath = '/tmp/kilanyan-sales.xlsx';
        else if (username === 'gleb_niklyushin') xlsxPath = '/tmp/niklyushin-sales.xlsx';
        else if (username === 'dmitriy_chizhevskiy') xlsxPath = '/tmp/chizhevskiy-sales.xlsx';
        else if (username === 'nataliya_veremyanina') xlsxPath = '/tmp/veremyanina-sales.xlsx';
        else if (username === 'anna_popova') xlsxPath = '/tmp/popova-sales.xlsx';
        else if (username === 'anzhela_bannova') xlsxPath = '/tmp/bannova-sales.xlsx';
        else if (username === 'ivan_savchenko') xlsxPath = '/tmp/savchenko-sales.xlsx';
        else if (username === 'inna_habarova') xlsxPath = '/tmp/khabarova-sales.xlsx';
        else if (username === 'dmitriy_vlasov') xlsxPath = '/tmp/vlasov-sales.xlsx';
        else if (username === 'elena_efremova') xlsxPath = '/tmp/efremova-sales.xlsx';
        else if (username === 'vadim_ermolenko') xlsxPath = '/tmp/ermolenko-sales.xlsx';
    }
    return { username, xlsxPath: path.resolve(xlsxPath), yearOnly };
}
const HEADER_ALIASES = [
    { key: 'row_no', aliases: ['№', 'no', 'n', 'номер'] },
    { key: 'payment_terms', aliases: ['условия оплаты'] },
    { key: 'paid_at', aliases: ['дата оплаты'] },
    { key: 'invoice_org', aliases: ['счет от ип или ооо', 'счёт от ип или ооо'] },
    { key: 'order_url', aliases: ['ссылка на заказ на сайте almamed.su или сателитах', 'ссылка на заказ'] },
    { key: 'amount_ex_delivery', aliases: ['сумма оплаты без доставки'] },
    { key: 'vat', aliases: ['ндс'] },
    { key: 'our_invoice_no', aliases: ['№ нашего счета', '№ нашего счёта', 'номер нашего счета'] },
    { key: 'has_contract', aliases: ['наличие договора'] },
    { key: 'supplier_invoice_url', aliases: ['ссылка на счет поставщика', 'ссылка на счёт поставщика'] },
    { key: 'amount_incl_stock', aliases: ['сумма оплаты (включая складские запасы)'] },
    { key: 'delivery_to_us', aliases: ['доставка до нас'] },
    { key: 'supplier_name', aliases: ['поставщик'] },
    { key: 'supplier_invoice_no', aliases: ['№ счета поставщика', '№ счёта поставщика'] },
    { key: 'status', aliases: ['статус'] },
    { key: 'pct_mp', aliases: ['% мп.', '% мп'] },
];

function clip(s, max) {
    const t = String(s == null ? '' : s).trim();
    if (!max || t.length <= max) return t;
    return t.slice(0, max);
}

function cellRaw(cell) {
    if (!cell) return null;
    const v = cell.value;
    if (v == null || v === '') return null;
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (v instanceof Date && !isNaN(v.getTime())) return v;
    if (typeof v === 'object') {
        if (v.hyperlink) return String(v.hyperlink);
        if (v.text) return String(v.text);
        if (Array.isArray(v.richText)) return v.richText.map((t) => t.text || '').join('');
        if (v.result != null && typeof v.result !== 'object') return v.result;
        if (v.result && v.result.error) return null;
        if (typeof v.result === 'number') return v.result;
    }
    const s = String(v).trim();
    if (!s || s === '#DIV/0!' || s === '#VALUE!' || s === '#REF!') return null;
    return s;
}

function toDate(v) {
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
    if (ru) return `${ru[3]}-${ru[2].padStart(2, '0')}-${ru[1].padStart(2, '0')}`;
    return null;
}

function normHeader(h) {
    return String(h || '')
        .trim()
        .toLowerCase()
        .replace(/\s+/g, ' ');
}

function headerKey(label) {
    const n = normHeader(label);
    for (const h of HEADER_ALIASES) {
        if (h.aliases.some((a) => a === n) || h.key === n) return h.key;
    }
    return null;
}

function isHeaderRow(row) {
    const a = normHeader(cellRaw(row.getCell(1)));
    const b = normHeader(cellRaw(row.getCell(2)));
    if (a === '№' || a === 'no' || a === 'n') return true;
    return b === 'дата оплаты';
}

function findHeaderRow(ws) {
    let found = 0;
    ws.eachRow((row, n) => {
        if (found) return;
        if (isHeaderRow(row)) found = n;
    });
    return found || 3;
}

function mapHeaderKeys(ws, headerRow) {
    const row = ws.getRow(headerRow);
    const keys = [];
    row.eachCell({ includeEmpty: true }, (cell, col) => {
        keys[col] = headerKey(cellRaw(cell));
    });
    if (!keys[1] && keys[2] === 'paid_at') keys[1] = 'row_no';
    return keys;
}

function rowToObj(ws, rowNum, keys) {
    const row = ws.getRow(rowNum);
    const obj = {};
    keys.forEach((k, col) => {
        if (!k) return;
        obj[k] = cellRaw(row.getCell(col));
    });
    return obj;
}

function isDataRow(obj) {
    const no = toNum(obj.row_no);
    if (no == null || no <= 0) return false;
    const amt = toNum(obj.amount_ex_delivery);
    if (amt != null && amt !== 0) return true;
    const url = clip(obj.order_url, 40);
    if (url && !/^#/.test(url) && !/^0р/i.test(url)) return true;
    if (clip(obj.our_invoice_no, 20)) return true;
    const org = clip(obj.invoice_org, 40);
    if (org && !/^0р/i.test(org) && org !== '0') return true;
    if (clip(obj.supplier_name, 20) && clip(obj.supplier_name, 20) !== '0') return true;
    return false;
}

async function main() {
    const { username: USERNAME, xlsxPath, yearOnly } = parseArgs();
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(xlsxPath);
    const db = await mysql.createConnection(config.db);
    const [users] = await db.query(
        'SELECT id, username, full_name FROM users WHERE username = ? LIMIT 1',
        [USERNAME]
    );
    if (!users.length) throw new Error('Нет пользователя ' + USERNAME);
    const managerId = Number(users[0].id);
    console.log('manager', users[0], yearOnly ? `year=${yearOnly}` : 'all years');

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
        await db.query('ALTER TABLE dg_manager_sales_rows MODIFY COLUMN has_contract VARCHAR(128) NULL');
    } catch (e) {
        console.warn('alter', e.message);
    }

    if (yearOnly) {
        await db.query('DELETE FROM dg_manager_sales_rows WHERE manager_user_id = ? AND year = ?', [
            managerId,
            yearOnly,
        ]);
    } else {
        await db.query('DELETE FROM dg_manager_sales_rows WHERE manager_user_id = ?', [managerId]);
    }

    const insertSql = `INSERT INTO dg_manager_sales_rows (
        year, manager_user_id, row_no, payment_terms, paid_at, invoice_org, order_url,
        amount_ex_delivery, vat, our_invoice_no, has_contract, supplier_invoice_url,
        amount_incl_stock, delivery_to_us, supplier_name, supplier_invoice_no,
        diff, pct_r, status, pct_mp, bonus, created_by, updated_by
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`;

    let years = wb.worksheets
        .map((ws) => String(ws.name || '').trim())
        .filter((n) => /^\d{4}$/.test(n))
        .sort();
    if (yearOnly) {
        years = years.filter((n) => Number(n) === yearOnly);
        if (!years.length) throw new Error('В книге нет листа ' + yearOnly);
    }

    let total = 0;
    for (const yearName of years) {
        const year = Number(yearName);
        const ws = wb.getWorksheet(yearName);
        let keys = mapHeaderKeys(ws, findHeaderRow(ws));
        let n = 0;
        // В Google-книге у каждого месяца своя шапка; колонки могут сдвигаться (НДС есть/нет).
        for (let r = 1; r <= ws.rowCount; r += 1) {
            const row = ws.getRow(r);
            if (isHeaderRow(row)) {
                keys = mapHeaderKeys(ws, r);
                continue;
            }
            const obj = rowToObj(ws, r, keys);
            if (!isDataRow(obj)) continue;
            const calc = computeRow(obj);
            const params = [
                year,
                managerId,
                Math.round(toNum(obj.row_no) || 0),
                clip(obj.payment_terms, 512) || null,
                toDate(obj.paid_at),
                clip(obj.invoice_org, 255) || '',
                clip(obj.order_url, 1024) || null,
                calc.amount_ex_delivery,
                calc.vat,
                clip(obj.our_invoice_no, 128) || null,
                clip(obj.has_contract, 128) ? normHasContract(clip(obj.has_contract, 128)) || null : null,
                clip(obj.supplier_invoice_url, 1024) || null,
                calc.amount_incl_stock,
                calc.delivery_to_us,
                obj.supplier_name == null || obj.supplier_name === '' ? null : clip(obj.supplier_name, 255),
                obj.supplier_invoice_no == null || obj.supplier_invoice_no === ''
                    ? null
                    : clip(obj.supplier_invoice_no, 128),
                calc.diff,
                calc.pct_r,
                clip(obj.status, 64) ? normStatus(clip(obj.status, 64)) || null : null,
                calc.pct_mp,
                calc.bonus,
                managerId,
                managerId,
            ];
            await db.query(insertSql, params);
            n += 1;
        }
        console.log(yearName, 'imported', n);
        total += n;
    }
    const [[cnt]] = await db.query(
        'SELECT COUNT(*) AS c FROM dg_manager_sales_rows WHERE manager_user_id = ?',
        [managerId]
    );
    console.log('done total', total, 'db', cnt.c);
    await db.end();
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
