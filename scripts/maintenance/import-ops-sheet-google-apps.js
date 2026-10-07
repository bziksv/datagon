#!/usr/bin/env node
'use strict';

/**
 * Импорт из Google операционного листа (листы 2024/2025/2026) в dg_ops_sheet_manual:
 *   G «Кол-во заявок» → applications_count (UI «Кол-во заявок (с Гугла)»)
 *   L «Премия с учетом заказов с прошлых месяцев» → bonus_past
 *   M «Оклад с учетом отработанных дней» → salary
 *
 *   node scripts/maintenance/import-ops-sheet-google-apps.js [/path/to.xlsx]
 *   default: /tmp/ops-sheet-google.xlsx
 */

const path = require('path');
const ExcelJS = require('exceljs');
const mysql = require('mysql2/promise');
const config = require('../../config');

const MONTHS = Object.freeze({
    январь: 1,
    февраль: 2,
    март: 3,
    апрель: 4,
    май: 5,
    июнь: 6,
    июль: 7,
    август: 8,
    сентябрь: 9,
    октябрь: 10,
    ноябрь: 11,
    декабрь: 12,
});

function fold(s) {
    return String(s || '')
        .toLowerCase()
        .replace(/ё/g, 'е')
        .replace(/[^a-zа-я0-9]+/gi, ' ')
        .trim();
}

function cellVal(cell) {
    if (!cell) return null;
    const v = cell.value;
    if (v == null || v === '') return null;
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (v instanceof Date && !isNaN(v.getTime())) return v;
    if (typeof v === 'object') {
        if (v.result != null && typeof v.result !== 'object') return v.result;
        if (typeof v.result === 'number') return v.result;
        if (v.text) return String(v.text);
        if (Array.isArray(v.richText)) return v.richText.map((t) => t.text || '').join('');
    }
    const s = String(v).trim();
    if (!s || s === '#DIV/0!' || s === '#VALUE!' || s === '#REF!') return null;
    return s;
}

function toNum(v) {
    if (v == null || v === '') return null;
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    const s = String(v)
        .replace(/\s/g, '')
        .replace(/р\.?$/i, '')
        .replace(',', '.');
    const n = Number(s);
    if (!Number.isFinite(n)) return null;
    return n;
}

function toInt(v) {
    const n = toNum(v);
    if (n == null) return null;
    return Math.round(n);
}

function toMoney(v) {
    const n = toNum(v);
    if (n == null) return null;
    return Math.round(n * 100) / 100;
}

function matchManager(shortName, managers) {
    const want = fold(shortName);
    if (!want) return null;
    const exact = managers.find((m) => {
        const f = fold(m.full_name);
        const u = fold(m.username);
        if (f === want || u === want) return true;
        const parts = f.split(/\s+/).filter(Boolean);
        if (parts.some((p) => p === want)) return true;
        if (f.indexOf(want) >= 0) return true;
        return false;
    });
    return exact || null;
}

function parseYearSheet(ws, year) {
    const out = [];
    let month = 0;
    ws.eachRow((row) => {
        const a = String(cellVal(row.getCell(1)) || '').trim();
        if (!a) return;
        const al = fold(a);
        if (MONTHS[al] != null) {
            month = MONTHS[al];
            return;
        }
        if (!month) return;
        if (/^итого/i.test(a) || /^\d{1,2}([.,]\d+)?$/.test(a)) return;
        if (/год/i.test(a)) return;
        const apps = toInt(cellVal(row.getCell(7)));
        const bonusPast = toMoney(cellVal(row.getCell(12)));
        const salary = toMoney(cellVal(row.getCell(13)));
        if (apps == null && bonusPast == null && salary == null) return;
        out.push({ year, month, name: a, apps, bonusPast, salary });
    });
    return out;
}

async function main() {
    const xlsxPath = path.resolve(process.argv[2] || '/tmp/ops-sheet-google.xlsx');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(xlsxPath);
    const db = await mysql.createConnection(config.db);

    const [managers] = await db.query(
        `SELECT u.id, u.username, u.full_name
           FROM users u
           INNER JOIN specialties s ON s.id = u.specialty_id
          WHERE s.name = 'Менеджер по продажам'`
    );
    console.log('managers', (managers || []).length);

    const years = [2024, 2025, 2026];
    let inserted = 0;
    let unmatched = {};
    for (const year of years) {
        const ws = wb.getWorksheet(String(year));
        if (!ws) {
            console.warn('no sheet', year);
            continue;
        }
        const rows = parseYearSheet(ws, year);
        console.log(year, 'parsed', rows.length);
        for (const r of rows) {
            const mgr = matchManager(r.name, managers || []);
            if (!mgr) {
                const k = `${year}-${r.month}:${r.name}`;
                unmatched[k] = { apps: r.apps, bonus: r.bonusPast, salary: r.salary };
                continue;
            }
            // С окт. 2026 bonus_past считается авто (отгрузки); импорт Google не ставит bonus_past_manual,
            // чтобы авто не перекрывался. До окт. 2026 — архив (значение в bonus_past).
            const autoEra = year > 2026 || (year === 2026 && r.month >= 10);
            await db.query(
                `INSERT INTO dg_ops_sheet_manual
                    (year, month, manager_user_id, applications_count, bonus_past, bonus_past_manual, salary, updated_by)
                 VALUES (?, ?, ?, ?, ?, 0, ?, ?)
                 ON DUPLICATE KEY UPDATE
                    applications_count = VALUES(applications_count),
                    bonus_past = IF(bonus_past_manual = 1, bonus_past, VALUES(bonus_past)),
                    salary = VALUES(salary),
                    updated_by = VALUES(updated_by)`,
                [
                    year,
                    r.month,
                    mgr.id,
                    r.apps,
                    autoEra ? null : r.bonusPast,
                    r.salary,
                    mgr.id,
                ]
            );
            inserted += 1;
        }
    }

    const [chk] = await db.query(
        `SELECT year,
                COUNT(*) c,
                SUM(applications_count IS NOT NULL) apps_n,
                SUM(bonus_past IS NOT NULL) bonus_n,
                SUM(salary IS NOT NULL) salary_n,
                ROUND(SUM(IFNULL(bonus_past,0)),2) bonus_sum,
                ROUND(SUM(IFNULL(salary,0)),2) salary_sum
           FROM dg_ops_sheet_manual
          WHERE year IN (2024,2025,2026)
          GROUP BY year ORDER BY year`
    );
    console.log('done inserted/updated', inserted);
    console.log('db', chk);
    const umKeys = Object.keys(unmatched);
    if (umKeys.length) {
        console.log('unmatched', umKeys.length);
        umKeys.slice(0, 20).forEach((k) => console.log(' ', k, unmatched[k]));
    }

    const [[el]] = await db.query(
        `SELECT m.applications_count, m.bonus_past, m.salary, u.full_name
           FROM dg_ops_sheet_manual m
           JOIN users u ON u.id = m.manager_user_id
          WHERE m.year=2024 AND m.month=1 AND u.full_name LIKE '%Елагин%'`
    );
    console.log('check Елагина Jan 2024', el);

    await db.end();
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
