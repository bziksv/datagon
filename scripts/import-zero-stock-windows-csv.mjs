#!/usr/bin/env node
/**
 * Разовый импорт сводки «нулей по окнам» из CSV в POST /api/product/zero-stock-windows-import.
 *
 * Использование:
 *   DATAGON_COOKIE='connect.sid=...' node scripts/import-zero-stock-windows-csv.mjs ./export.csv 2026-01-15
 *   DATAGON_COOKIE='...' DATAGON_BASE_URL=https://p.example.ru node scripts/import-zero-stock-windows-csv.mjs ./export.csv 2026-01-15 "Excel выгрузка"
 *
 * Cookie: DevTools → Network → любой запрос к /api → Request Headers → Cookie (целиком).
 * Нужен полный доступ к разделу «Закупки» (POST не проходит в режиме view).
 */
import fs from 'fs';
import path from 'path';

const base = (process.env.DATAGON_BASE_URL || 'http://127.0.0.1:3000').replace(/\/+$/, '');
const cookie = String(process.env.DATAGON_COOKIE || '').trim();

const file = process.argv[2];
const referenceDate = process.argv[3];
const noteArg = process.argv.slice(4).join(' ').trim();

if (!file || !referenceDate) {
    console.error(
        'Usage: DATAGON_COOKIE="<cookie>" node scripts/import-zero-stock-windows-csv.mjs <file.csv> <YYYY-MM-DD> [note]\n' +
            'Optional: DATAGON_BASE_URL (default http://127.0.0.1:3000)',
    );
    process.exit(1);
}
if (!/^\d{4}-\d{2}-\d{2}$/.test(referenceDate)) {
    console.error('reference_date must be YYYY-MM-DD');
    process.exit(1);
}
if (!cookie) {
    console.error('Set DATAGON_COOKIE to your browser session cookie string.');
    process.exit(1);
}

const abs = path.resolve(process.cwd(), file);
const csv = fs.readFileSync(abs, 'utf8');
const url = `${base}/api/product/zero-stock-windows-import`;

const body = JSON.stringify({
    reference_date: referenceDate,
    note: noteArg || null,
    csv,
});

const res = await fetch(url, {
    method: 'POST',
    headers: {
        'Content-Type': 'application/json',
        Cookie: cookie,
    },
    body,
});

const text = await res.text();
let json;
try {
    json = JSON.parse(text);
} catch {
    console.error('Non-JSON response', res.status, text.slice(0, 500));
    process.exit(1);
}

if (!res.ok || json.success === false) {
    console.error('Failed', res.status, json.error || json);
    process.exit(1);
}

console.log(JSON.stringify(json, null, 2));
