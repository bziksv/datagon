'use strict';

/**
 * Выгрузки Excel 2003 XML (.xls) для страницы «Поставщики».
 * Колонка «Наименование» — ширина 400 px, перенос строк (см. datagonSpreadsheetExport.js).
 */

const { buildExcelXlsxBuffer } = require('./datagonSpreadsheetExport');
const { buildUomHrefNameMapForRows, uomLabelFromPayload } = require('./msMetaResolve');

/** Ширина колонки «Наименование» в выгрузках поставщиков (px). */
const SUPPLIER_EXPORT_NAME_COL_WIDTH_PX = 400;
const {
    SUPPLIER_BUY_PRICE_NUM,
    SUPPLIER_IN_TRANSIT_SQL,
    SUPPLIER_NEED_QTY_SQL,
    SUPPLIER_TARGET_STOCK_SQL,
    sqlSupplierProductWhere,
} = require('./datagonSuppliersSql');
const { loadPurchaseDataRevision, buildFormulaFingerprint } = require('./datagonFormulaProposedCache');

function parseFlexibleNumber(raw) {
    if (raw == null) return null;
    const s = String(raw).trim();
    if (!s) return null;
    const cleaned = s.replace(/\s/g, '').replace(',', '.');
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : null;
}

function parsePayloadSafe(raw) {
    if (raw == null || raw === '') return null;
    try {
        return typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch {
        return null;
    }
}

function buildSupplierLabel(s1, s2) {
    const a = String(s1 || '').trim();
    const b = String(s2 || '').trim();
    if (a && b && a !== b) return `${a} / ${b}`;
    return a || b || '';
}

function extractInTransit(r, payload) {
    if (r.denorm_in_transit != null && r.denorm_in_transit !== '') {
        const t = Number(r.denorm_in_transit);
        if (Number.isFinite(t)) return t;
    }
    if (payload && payload.inTransit != null && payload.inTransit !== '') {
        const t = Number(payload.inTransit);
        if (Number.isFinite(t)) return t;
    }
    return 0;
}

function extractUom(payload, hrefToName) {
    return uomLabelFromPayload(payload, hrefToName, { fallback: 'шт' });
}

function extractReserve(payload) {
    if (!payload || payload.reserve == null || payload.reserve === '') return null;
    const n = Number(payload.reserve);
    return Number.isFinite(n) ? n : null;
}

/**
 * НДС для позиции заказа поставщику в МС (vat + vat_enabled).
 * @returns {{ vat_rate: number|null, vat_enabled: boolean|null }}
 */
function parseMsVatForPurchaseOrder(r, payload) {
    if (payload && payload.vatEnabled === false) {
        return { vat_rate: 0, vat_enabled: false };
    }
    const raw =
        payload && payload.effectiveVat != null && payload.effectiveVat !== ''
            ? payload.effectiveVat
            : payload && payload.vat != null && payload.vat !== ''
              ? payload.vat
              : r && r.vat_on_product != null && String(r.vat_on_product).trim()
                ? r.vat_on_product
                : r && r.vat != null
                  ? r.vat
                  : '';
    const s = String(raw == null ? '' : raw).trim().toLowerCase();
    if (!s) return { vat_rate: null, vat_enabled: null };
    if (/без\s*ндс|не\s*облагается|^0\b|^0\s*%/.test(s)) {
        return { vat_rate: 0, vat_enabled: false };
    }
    const m = s.match(/(\d+(?:\.\d+)?)\s*%?/);
    if (m) {
        const rate = Math.round(parseFloat(m[1]));
        if (Number.isFinite(rate)) return { vat_rate: rate, vat_enabled: true };
    }
    return { vat_rate: null, vat_enabled: null };
}

/** Для «к закупке» в выгрузках: только `ms_export.min_stock`. */
function effectiveTargetStock(r) {
    const ms = parseFlexibleNumber(r.min_stock);
    return ms != null ? ms : 0;
}

function fmtExportNum(n, decimals) {
    if (n == null || !Number.isFinite(Number(n))) return '';
    const x = Number(n);
    const d = decimals != null ? decimals : 2;
    if (Math.abs(x - Math.round(x)) < 1e-9 && d <= 0) return String(Math.round(x));
    return x.toLocaleString('ru-RU', {
        minimumFractionDigits: 0,
        maximumFractionDigits: d,
        useGrouping: false,
    });
}

function sumExportField(rows, key) {
    let sum = 0;
    let has = false;
    for (const r of rows) {
        const v = r[key];
        if (v != null && Number.isFinite(Number(v))) {
            sum += Number(v);
            has = true;
        }
    }
    return has ? sum : null;
}

function mapRowForExport(r, hrefToName) {
    const payload = parsePayloadSafe(r.payload_json);
    const stock = Number(r.stock || 0);
    const inTransit = extractInTransit(r, payload);
    const target = effectiveTargetStock(r);
    const needQty = Math.max(0, target - stock - inTransit);
    const buyNum = parseFlexibleNumber(r.buy_price_num != null ? r.buy_price_num : r.buy_price);
    const total = buyNum != null && needQty > 0 ? needQty * buyNum : null;
    const minStock = parseFlexibleNumber(r.min_stock);
    const pct =
        minStock != null && minStock > 0
            ? Math.round((100 * stock) / minStock * 100) / 100
            : null;
    const vatParsed = parseMsVatForPurchaseOrder(r, payload);
    return {
        code: String(r.code || '').trim(),
        article: String(r.denorm_article || r.article || '').trim(),
        name: String(r.name || '').trim(),
        supplier_label: buildSupplierLabel(r.supplier, r.supplier2),
        min_stock: minStock,
        min_stock_dg: parseFlexibleNumber(r.min_stock_dg),
        multiplicity: parseFlexibleNumber(r.multiplicity),
        stock,
        in_transit: inTransit,
        reserve: extractReserve(payload),
        uom: extractUom(payload, hrefToName),
        stock_pct: pct,
        need_qty: needQty,
        buy_price: buyNum,
        total,
        uuid: String(r.uuid || '').trim(),
        ms_entity_type: String(r.type || '').trim(),
        vat_rate: vatParsed.vat_rate,
        vat_enabled: vatParsed.vat_enabled,
    };
}

function buildSupplierProductsSql(formulaFp, dataRev, opts) {
    const supplierKey = String(opts.supplierKey || '').trim();
    const toPurchaseOnly = opts.toPurchaseOnly !== false;
    const fp = String(formulaFp || '');
    const rev = String(dataRev || '');
    const fcJoin =
        fp && rev
            ? `LEFT JOIN dg_supplier_settings ss_rd ON ss_rd.supplier_key = TRIM(mse.supplier)
            LEFT JOIN dg_formula_proposed_cache fc
              ON fc.code = mse.code AND fc.data_rev = ?
              AND fc.formula_fp = CONCAT(?, '|', IF(ss_rd.replenishment_days IS NULL, 'rd:g', CONCAT('rd:', CAST(ROUND(ss_rd.replenishment_days) AS CHAR))))`
            : 'LEFT JOIN dg_formula_proposed_cache fc ON fc.code = mse.code';
    const where = [sqlSupplierProductWhere('mse'), 'TRIM(mse.supplier) = ?'];
    const params = [];
    if (fp && rev) params.push(rev, fp);
    params.push(supplierKey);
    if (toPurchaseOnly) {
        where.push(`(${SUPPLIER_NEED_QTY_SQL}) > 0`);
    }
    return {
        sql: `
            SELECT
                mse.code,
                mse.name,
                mse.uuid,
                mse.type,
                mse.supplier,
                mse.supplier2,
                mse.buy_price,
                (${SUPPLIER_BUY_PRICE_NUM}) AS buy_price_num,
                mse.min_stock,
                mse.stock,
                mse.vat,
                mse.vat_on_product,
                po.min_stock_dg,
                po.multiplicity,
                po.proposed_min_stock,
                med.denorm_article,
                med.denorm_in_transit,
                med.payload_json,
                fc.proposed AS formula_cached_proposed
            FROM ms_export mse
            LEFT JOIN dg_purchase_overrides po ON po.code = mse.code
            LEFT JOIN ms_entity_details med ON med.uuid = mse.uuid
            ${fcJoin}
            WHERE ${where.join(' AND ')}
            ORDER BY mse.name ASC, mse.code ASC
        `,
        params,
    };
}

async function loadSupplierExportRows(db, appSettings, opts) {
    const supplierKey = String(opts.supplierKey || '').trim();
    if (!supplierKey) return [];
    const dataRev = await loadPurchaseDataRevision(db);
    const formulaFp = buildFormulaFingerprint(appSettings || {});
    const { sql, params } = buildSupplierProductsSql(formulaFp, dataRev, {
        supplierKey,
        toPurchaseOnly: opts.toPurchaseOnly !== false,
    });
    const [rows] = await db.query(sql, params);
    const hrefToName = await buildUomHrefNameMapForRows(rows || []);
    return (rows || []).map((r) => mapRowForExport(r, hrefToName)).filter((r) => r.code);
}

async function buildSupplierForSupplierSpreadsheet(rows) {
    const headers = ['№', 'Артикул', 'Наименование товаров', 'Кол-во', 'Ед. изм.', 'Цена', 'Итого'];
    const matrix = rows.map((r, i) => [
        i + 1,
        r.article,
        r.name,
        r.need_qty,
        r.uom,
        r.buy_price,
        r.total,
    ]);
    if (matrix.length) {
        matrix.push([
            '',
            '',
            'Итого',
            sumExportField(rows, 'need_qty'),
            '',
            '',
            sumExportField(rows, 'total'),
        ]);
    }
    return buildExcelXlsxBuffer(headers, matrix, {
        wrapColumnIndex: 3,
        nameColumnWidthPx: SUPPLIER_EXPORT_NAME_COL_WIDTH_PX,
        numericColumnIndexes: [0, 3, 5, 6],
        moneyColumnIndexes: [5, 6],
        columnWidthsChars: { 1: 6, 2: 14, 4: 8, 5: 12, 6: 12, 7: 14 },
    });
}

/** @deprecated используйте buildSupplierForSupplierSpreadsheet */
const buildSupplierForSupplierCsv = buildSupplierForSupplierSpreadsheet;

async function buildPurchaserExportSpreadsheet(rows) {
    const headers = [
        '№',
        'Код',
        'Артикул',
        'Наименование товаров',
        'Поставщик',
        'Неснижаемый остаток',
        'Неснижаемый остаток Датагон',
        'Кратность товара',
        'Остаток',
        'Ожидание',
        'Резерв',
        'Ед. изм.',
        'Процент остатка',
        'Кол-во',
        'Закупочная цена',
        'Итого',
    ];
    const matrix = rows.map((r, i) => [
        i + 1,
        r.code,
        r.article,
        r.name,
        r.supplier_label,
        r.min_stock,
        r.min_stock_dg,
        r.multiplicity,
        r.stock,
        r.in_transit,
        r.reserve,
        r.uom,
        r.stock_pct,
        r.need_qty,
        r.buy_price,
        r.total,
    ]);
    if (matrix.length) {
        matrix.push([
            '',
            '',
            '',
            'Итого',
            '',
            sumExportField(rows, 'min_stock'),
            sumExportField(rows, 'min_stock_dg'),
            sumExportField(rows, 'multiplicity'),
            sumExportField(rows, 'stock'),
            sumExportField(rows, 'in_transit'),
            sumExportField(rows, 'reserve'),
            '',
            '',
            sumExportField(rows, 'need_qty'),
            '',
            sumExportField(rows, 'total'),
        ]);
    }
    return buildExcelXlsxBuffer(headers, matrix, {
        wrapColumnIndex: 4,
        nameColumnWidthPx: SUPPLIER_EXPORT_NAME_COL_WIDTH_PX,
        numericColumnIndexes: [0, 5, 6, 7, 8, 9, 10, 12, 13, 14, 15],
        moneyColumnIndexes: [14, 15],
        columnWidthsChars: { 1: 6, 2: 12, 3: 14, 5: 22, 11: 8, 12: 10 },
    });
}

/** @deprecated используйте buildPurchaserExportSpreadsheet */
const buildPurchaserExportCsv = buildPurchaserExportSpreadsheet;

function safeFilenamePart(s) {
    return String(s || 'export')
        .trim()
        .replace(/[\\/:*?"<>|]/g, '_')
        .slice(0, 80);
}

function exportFilename(supplierKey, kind) {
    const date = new Date().toISOString().slice(0, 10);
    const base = safeFilenamePart(supplierKey);
    if (kind === 'purchaser') return `zakupki-${base}-${date}.xlsx`;
    return `postavshik-${base}-${date}.xlsx`;
}

/** RFC 5987: кириллица и прочий non-ASCII только в filename*, в filename — ASCII fallback. */
function buildContentDispositionAttachment(filename) {
    const raw = String(filename || 'export.xls').trim() || 'export.xls';
    const ascii =
        raw
            .replace(/[\\/:*?"<>|]/g, '_')
            .replace(/[^\x20-\x7E]/g, '_')
            .replace(/_+/g, '_')
            .replace(/^_|_$/g, '')
            .slice(0, 180) || 'export.xls';
    const encoded = encodeURIComponent(raw).replace(
        /[!'()*]/g,
        (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
    );
    return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

function sendExcelSpreadsheet(res, body, filename) {
    const isXlsx = Buffer.isBuffer(body) || /\.xlsx$/i.test(String(filename || ''));
    res.setHeader(
        'Content-Type',
        isXlsx
            ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
            : 'application/vnd.ms-excel; charset=utf-8',
    );
    res.setHeader('Content-Disposition', buildContentDispositionAttachment(filename));
    res.send(body);
}

/** @deprecated alias */
function sendExcelCsv(res, body, filename) {
    sendExcelSpreadsheet(res, body, filename);
}

module.exports = {
    loadSupplierExportRows,
    buildSupplierForSupplierSpreadsheet,
    buildPurchaserExportSpreadsheet,
    buildSupplierForSupplierCsv,
    buildPurchaserExportCsv,
    exportFilename,
    buildContentDispositionAttachment,
    sendExcelSpreadsheet,
    sendExcelCsv,
    SUPPLIER_EXPORT_NAME_COL_WIDTH_PX,
    parseMsVatForPurchaseOrder,
};
