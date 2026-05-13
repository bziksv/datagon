'use strict';

/**
 * Чистые функции фильтрации строк «Проблемы с товарами» (scope vat_mismatch / dims_mismatch),
 * вынесены для переиспользования на /exports-dimensions.html без дублирования логики в роутере.
 * Источник поведения: routes/exportsMarketplaces.js → loadIssuesRowsCore.
 */

const { prettifyMarketplaceVat } = require('./marketplaceExports');

const ISSUES_DIM_EPS = 0.02;

function parseExportDimNumber(v) {
    const s = String(v == null ? '' : v).trim().replace(',', '.');
    if (!s) return null;
    const n = parseFloat(s);
    return Number.isFinite(n) ? n : null;
}

function issuesDimTuple(row, prefix) {
    return [
        parseExportDimNumber(row[`${prefix}_length`]),
        parseExportDimNumber(row[`${prefix}_width`]),
        parseExportDimNumber(row[`${prefix}_height`]),
        parseExportDimNumber(row[`${prefix}_weight`]),
    ];
}

function issuesDimTuplesDiffer(a, b) {
    for (let i = 0; i < 4; i += 1) {
        if (a[i] == null || b[i] == null) continue;
        if (Math.abs(a[i] - b[i]) > ISSUES_DIM_EPS) return true;
    }
    return false;
}

function issuesRowHasMsDims(row) {
    return (
        parseExportDimNumber(row.ms_length) != null
        || parseExportDimNumber(row.ms_width) != null
        || parseExportDimNumber(row.ms_height_box) != null
        || parseExportDimNumber(row.ms_height_bag) != null
        || parseExportDimNumber(row.ms_weight) != null
    );
}

function issuesRowDimsMismatchVsMs(row) {
    const msL = parseExportDimNumber(row.ms_length);
    const msW = parseExportDimNumber(row.ms_width);
    const msHbox = parseExportDimNumber(row.ms_height_box);
    const msHbag = parseExportDimNumber(row.ms_height_bag);
    const msWeight = parseExportDimNumber(row.ms_weight);
    const prefixes = ['ozon', 'wb', 'ym'];
    for (const p of prefixes) {
        if (!row[`${p}_code`]) continue;
        const mpL = parseExportDimNumber(row[`${p}_length`]);
        const mpW = parseExportDimNumber(row[`${p}_width`]);
        const mpH = parseExportDimNumber(row[`${p}_height`]);
        const mpWeight = parseExportDimNumber(row[`${p}_weight`]);
        if (msL != null && mpL != null && Math.abs(msL - mpL) > ISSUES_DIM_EPS) return true;
        if (msW != null && mpW != null && Math.abs(msW - mpW) > ISSUES_DIM_EPS) return true;
        if (msWeight != null && mpWeight != null && Math.abs(msWeight - mpWeight) > ISSUES_DIM_EPS) return true;
        if (mpH != null && (msHbox != null || msHbag != null)) {
            const matchBox = msHbox != null && Math.abs(mpH - msHbox) <= ISSUES_DIM_EPS;
            const matchBag = msHbag != null && Math.abs(mpH - msHbag) <= ISSUES_DIM_EPS;
            if (!matchBox && !matchBag) return true;
        }
    }
    return false;
}

function issuesRowDimsMismatchAcrossMps(row) {
    const keys = [];
    if (row.ozon_code) keys.push('ozon');
    if (row.wb_code) keys.push('wb');
    if (row.ym_code) keys.push('ym');
    if (keys.length < 2) return false;
    for (let i = 0; i < keys.length; i += 1) {
        for (let j = i + 1; j < keys.length; j += 1) {
            if (issuesDimTuplesDiffer(issuesDimTuple(row, keys[i]), issuesDimTuple(row, keys[j]))) {
                return true;
            }
        }
    }
    return false;
}

function issuesRowDimsMismatch(row) {
    if (issuesRowHasMsDims(row)) return issuesRowDimsMismatchVsMs(row);
    return issuesRowDimsMismatchAcrossMps(row);
}

function canonicalIssueVatMs(raw) {
    const s = String(raw == null ? '' : raw).trim().toLowerCase();
    if (!s) return '';
    if (/без\s*ндс|не\s*облагается|^0\b|^0\s*%/.test(s)) return '__0';
    const m = s.match(/(\d+(?:\.\d+)?)\s*%?/);
    if (m) return String(Math.round(parseFloat(m[1])));
    return s.replace(/\s/g, '').replace('%', '');
}

function canonicalIssueVatMpAfterPrettify(kind, prettyVal) {
    const raw = String(prettyVal == null ? '' : prettyVal).trim();
    const s = raw.toLowerCase();
    if (!s) return kind === 'ozon' ? '__0' : '';
    if (kind === 'ozon' && (s === 'без ндс' || s === 'безндс')) return '__0';
    if (kind === 'wb' && (s === 'без ндс' || s === 'безндс')) return '__0';
    if (kind === 'ym' && /без\s*ндс/.test(s)) return '__0';
    const m = s.match(/^(\d+)/);
    if (m) return m[1];
    const m2 = /(\d+(?:\.\d+)?)/.exec(s);
    if (m2) return String(Math.round(parseFloat(m2[1])));
    return s.replace(/\s/g, '').replace('%', '');
}

function issuesRowVatMismatch(row) {
    const ms = canonicalIssueVatMs(row.ms_vat);
    const oneDiff = (kind, code, prettyVat) => {
        if (!code) return false;
        if (kind === 'wb' && /не\s*указан/i.test(String(prettyVat || ''))) return false;
        const mp = canonicalIssueVatMpAfterPrettify(kind, prettyVat);
        if (mp === '' && ms === '') return false;
        return mp !== ms;
    };
    return (
        oneDiff('ozon', row.ozon_code, row.ozon_vat)
        || oneDiff('wb', row.wb_code, row.wb_vat)
        || oneDiff('ym', row.ym_code, row.ym_vat)
    );
}

function formatMsDimValue(v) {
    if (v == null) return null;
    const s = String(v).trim();
    if (!s) return null;
    const n = parseFloat(s.replace(',', '.'));
    if (!Number.isFinite(n)) return v;
    return n.toFixed(1);
}

/** Как в loadIssuesRowsCore: округление DECIMAL перед сравнением НДС/габаритов. */
function formatIssueRowMsDims(row) {
    if (!row) return;
    const MS_DIM_KEYS = ['ms_length', 'ms_width', 'ms_height_box', 'ms_height_bag', 'ms_weight'];
    for (const k of MS_DIM_KEYS) {
        if (Object.prototype.hasOwnProperty.call(row, k)) {
            row[k] = formatMsDimValue(row[k]);
        }
    }
}

function preprocessIssueRowVatPretty(row) {
    if (!row) return;
    if (Object.prototype.hasOwnProperty.call(row, 'ozon_vat')) {
        row.ozon_vat = prettifyMarketplaceVat('ozon', row.ozon_vat);
    }
    if (Object.prototype.hasOwnProperty.call(row, 'wb_vat')) {
        row.wb_vat = prettifyMarketplaceVat('wb', row.wb_vat);
    }
    if (Object.prototype.hasOwnProperty.call(row, 'ym_vat')) {
        row.ym_vat = prettifyMarketplaceVat('ym', row.ym_vat);
    }
}

module.exports = {
    ISSUES_DIM_EPS,
    parseExportDimNumber,
    issuesRowVatMismatch,
    issuesRowDimsMismatch,
    formatIssueRowMsDims,
    preprocessIssueRowVatPretty,
};
