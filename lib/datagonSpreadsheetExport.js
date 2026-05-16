'use strict';

/**
 * Выгрузки таблиц: XLSX (ExcelJS) — Numbers, LibreOffice, Excel;
 * SpreadsheetML (.xls xml) оставлен для совместимости со старым кодом.
 */

const ExcelJS = require('exceljs');

const NUM_FMT_QTY = '# ##0.###';
const NUM_FMT_MONEY = '# ##0.00';

function escapeXml(s) {
    return String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/** Пиксели экрана → ширина колонки Excel XML (в пунктах, 96 DPI). */
function pixelsToExcelColumnWidthPt(px) {
    const n = Number(px);
    if (!Number.isFinite(n) || n <= 0) return 80;
    return Math.round((n * 72) / 96);
}

/** Пиксели → ширина колонки ExcelJS (в символах). */
function pixelsToExcelColChars(px) {
    const n = Number(px);
    if (!Number.isFinite(n) || n <= 0) return 12;
    return Math.max(8, Math.min(80, Math.round(n / 7)));
}

function parseCellNumber(raw) {
    if (raw == null || raw === '') return null;
    if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
    const s = String(raw).trim().replace(/\s/g, '').replace(',', '.');
    if (!s) return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
}

function toIndexSet(list) {
    const set = new Set();
    (list || []).forEach((x) => {
        const n = Number(x);
        if (Number.isFinite(n)) set.add(n);
    });
    return set;
}

function estimateWrapRowHeight(text, colWidthChars) {
    const len = String(text || '').length;
    if (len <= 0) return undefined;
    const charsPerLine = Math.max(12, colWidthChars - 1);
    const lines = Math.ceil(len / charsPerLine);
    return Math.min(120, Math.max(15, lines * 15));
}

/**
 * @param {string[]} headers
 * @param {Array<Array<string|number|null|undefined>>} matrix
 * @param {{
 *   sheetName?: string,
 *   wrapColumnIndex?: number,
 *   nameColumnWidthPx?: number,
 *   numericColumnIndexes?: number[],
 *   moneyColumnIndexes?: number[],
 *   columnWidthsChars?: Record<number, number>,
 * }} [options]
 * wrapColumnIndex — 1-based
 * numericColumnIndexes / moneyColumnIndexes — 0-based индексы колонок данных
 */
async function buildExcelXlsxBuffer(headers, matrix, options = {}) {
    const wrapCol = Number(options.wrapColumnIndex || 0);
    const nameWidthChars =
        options.nameColumnWidthPx != null
            ? pixelsToExcelColChars(options.nameColumnWidthPx)
            : pixelsToExcelColChars(400);
    const numericCols = toIndexSet(options.numericColumnIndexes);
    const moneyCols = toIndexSet(options.moneyColumnIndexes);
    const extraWidths = options.columnWidthsChars || {};

    const wb = new ExcelJS.Workbook();
    wb.creator = 'Datagon';
    const ws = wb.addWorksheet(options.sheetName || 'Export', {
        views: [{ state: 'frozen', ySplit: 1 }],
    });

    const headerRow = ws.addRow(headers);
    headerRow.font = { bold: true };
    headerRow.alignment = { vertical: 'middle', wrapText: true };

    const colCount = headers.length;
    for (let c = 1; c <= colCount; c += 1) {
        let w = extraWidths[c];
        if (w == null && c === wrapCol) w = nameWidthChars;
        if (w == null) w = c === 1 ? 6 : 14;
        ws.getColumn(c).width = w;
    }

    (matrix || []).forEach((row) => {
        const excelRow = ws.addRow([]);
        (row || []).forEach((val, ci) => {
            const cell = excelRow.getCell(ci + 1);
            const colIdx = ci + 1;
            const isWrap = colIdx === wrapCol;

            if (numericCols.has(ci)) {
                const n = parseCellNumber(val);
                if (n != null) {
                    cell.value = n;
                    cell.numFmt = moneyCols.has(ci) ? NUM_FMT_MONEY : NUM_FMT_QTY;
                } else {
                    cell.value = val != null && val !== '' ? String(val) : null;
                }
            } else {
                cell.value = val != null && val !== '' ? String(val) : null;
            }

            cell.alignment = {
                vertical: 'top',
                wrapText: isWrap,
            };

            if (isWrap) {
                const h = estimateWrapRowHeight(cell.value, nameWidthChars);
                if (h != null) excelRow.height = h;
            }
        });
    });

    return wb.xlsx.writeBuffer();
}

/**
 * @deprecated предпочтительно buildExcelXlsxBuffer (.xlsx)
 */
function buildExcel2003Xml(headers, matrix, options = {}) {
    const wrapCol = Number(options.wrapColumnIndex || 0);
    const nameWidthPt =
        options.nameColumnWidthPx != null
            ? pixelsToExcelColumnWidthPt(options.nameColumnWidthPx)
            : pixelsToExcelColumnWidthPt(400);
    const extraWidths = options.columnWidthsPt || {};

    const colCount = headers.length;
    let colsXml = '';
    for (let i = 1; i <= colCount; i += 1) {
        let w = extraWidths[i];
        if (w == null && i === wrapCol) w = nameWidthPt;
        if (w != null) colsXml += `<Column ss:Index="${i}" ss:Width="${w}"/>`;
    }

    const headerCells = headers
        .map((h, i) => {
            const colIdx = i + 1;
            const styleAttr = colIdx === wrapCol ? ' ss:StyleID="WrapHeader"' : '';
            return `<Cell${styleAttr}><Data ss:Type="String">${escapeXml(h)}</Data></Cell>`;
        })
        .join('');

    const dataRows = (matrix || [])
        .map((row) => {
            const cells = (row || [])
                .map((val, i) => {
                    const colIdx = i + 1;
                    const styleAttr = colIdx === wrapCol ? ' ss:StyleID="Wrap"' : '';
                    return `<Cell${styleAttr}><Data ss:Type="String">${escapeXml(val)}</Data></Cell>`;
                })
                .join('');
            return `<Row>${cells}</Row>`;
        })
        .join('\n');

    return (
        '<?xml version="1.0" encoding="UTF-8"?>\n' +
        '<?mso-application progid="Excel.Sheet"?>\n' +
        '<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"\n' +
        ' xmlns:o="urn:schemas-microsoft-com:office:office"\n' +
        ' xmlns:x="urn:schemas-microsoft-com:office:excel"\n' +
        ' xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">\n' +
        ' <Styles>\n' +
        '  <Style ss:ID="Default" ss:Name="Normal">\n' +
        '   <Alignment ss:Vertical="Top"/>\n' +
        '  </Style>\n' +
        '  <Style ss:ID="Wrap">\n' +
        '   <Alignment ss:Vertical="Top" ss:WrapText="1"/>\n' +
        '  </Style>\n' +
        '  <Style ss:ID="WrapHeader">\n' +
        '   <Alignment ss:Vertical="Top" ss:WrapText="1"/>\n' +
        '   <Font ss:Bold="1"/>\n' +
        '  </Style>\n' +
        ' </Styles>\n' +
        ' <Worksheet ss:Name="Export">\n' +
        '  <Table>\n' +
        `   ${colsXml}\n` +
        `   <Row>${headerCells}</Row>\n` +
        `   ${dataRows}\n` +
        '  </Table>\n' +
        ' </Worksheet>\n' +
        '</Workbook>'
    );
}

module.exports = {
    escapeXml,
    pixelsToExcelColumnWidthPt,
    pixelsToExcelColChars,
    buildExcelXlsxBuffer,
    buildExcel2003Xml,
    NUM_FMT_QTY,
    NUM_FMT_MONEY,
};
