'use strict';

/**
 * Фильтр отгрузок МС по проекту для «Формулы продаж» (только расчёт неснижаемого и d_*a в закупках).
 * Графики на карточке товара и раздел «Продажи МС» не затрагиваются.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseUuidList(raw) {
    if (raw == null || raw === '') return [];
    let arr = [];
    if (Array.isArray(raw)) {
        arr = raw;
    } else {
        const s = String(raw).trim();
        if (!s) return [];
        if (s.startsWith('[')) {
            try {
                const j = JSON.parse(s);
                if (Array.isArray(j)) arr = j;
            } catch (_) {
                arr = s.split(/[,;\s]+/);
            }
        } else {
            arr = s.split(/[,;\s]+/);
        }
    }
    const out = [];
    const seen = new Set();
    for (const item of arr) {
        const u = String(item || '').trim().toLowerCase();
        if (!UUID_RE.test(u) || seen.has(u)) continue;
        seen.add(u);
        out.push(u);
    }
    return out.sort();
}

function salesFormulaProjectMode(appSettings) {
    const m = String((appSettings && appSettings.sales_formula_project_mode) || 'all')
        .trim()
        .toLowerCase();
    return m === 'selected' ? 'selected' : 'all';
}

/** UUID проектов для IN (...); пустой массив — фильтр не активен. */
function salesFormulaProjectUuids(appSettings) {
    if (salesFormulaProjectMode(appSettings) !== 'selected') return [];
    return parseUuidList(appSettings && appSettings.sales_formula_project_uuids);
}

function isSalesFormulaProjectFilterActive(appSettings) {
    return salesFormulaProjectUuids(appSettings).length > 0;
}

/**
 * SQL-фрагмент для JOIN ms_demand d.
 * @param {object} appSettings
 * @param {string} [alias='d']
 * @returns {{ sql: string, params: string[], active: boolean, emptySelected: boolean }}
 */
function msDemandProjectFilterClause(appSettings, alias = 'd') {
    const uuids = salesFormulaProjectUuids(appSettings);
    if (!uuids.length) {
        const mode = salesFormulaProjectMode(appSettings);
        if (mode === 'selected') {
            return { sql: ' AND 1=0', params: [], active: true, emptySelected: true };
        }
        return { sql: '', params: [], active: false, emptySelected: false };
    }
    const ph = uuids.map(() => '?').join(',');
    return {
        sql: ` AND ${alias}.project_uuid IN (${ph})`,
        params: uuids,
        active: true,
        emptySelected: false,
    };
}

function salesFormulaProjectFilterFingerprint(appSettings) {
    const mode = salesFormulaProjectMode(appSettings);
    if (mode !== 'selected') return 'all';
    const uuids = salesFormulaProjectUuids(appSettings);
    if (!uuids.length) return 'selected:';
    return `selected:${uuids.join(',')}`;
}

/**
 * Имена проектов по UUID из ms_demand (без ограничения по дате — для подписи в формуле).
 * @param {import('mysql2/promise').Pool|object} db
 * @param {string[]|string} uuids
 * @returns {Promise<Map<string, string>>}
 */
async function loadMsDemandProjectNameMap(db, uuids) {
    const list = Array.isArray(uuids) ? uuids : parseUuidList(uuids);
    if (!list.length || !db || typeof db.query !== 'function') return new Map();
    const ph = list.map(() => '?').join(',');
    const [rows] = await db.query(
        `SELECT LOWER(TRIM(project_uuid)) AS uuid,
                MAX(NULLIF(TRIM(project_name), '')) AS name
           FROM ms_demand
          WHERE LOWER(TRIM(project_uuid)) IN (${ph})
          GROUP BY LOWER(TRIM(project_uuid))`,
        list,
    );
    const out = new Map();
    for (const r of rows || []) {
        const u = String(r.uuid || '').trim().toLowerCase();
        if (!u || !UUID_RE.test(u)) continue;
        const n = String(r.name || '').trim();
        out.set(u, n || u);
    }
    return out;
}

/**
 * @param {object} appSettings
 * @param {Map<string,string>|null} [nameByUuid]
 */
function describeSalesFormulaProjectFilter(appSettings, nameByUuid = null) {
    const mode = salesFormulaProjectMode(appSettings);
    const uuids = salesFormulaProjectUuids(appSettings);
    if (mode !== 'selected') {
        return {
            mode: 'all',
            active: false,
            uuids: [],
            project_names: [],
            label: 'Учёт продаж для формулы: все проекты отгрузок МС',
        };
    }
    if (!uuids.length) {
        return {
            mode: 'selected',
            active: true,
            uuids: [],
            project_names: [],
            label: 'Учёт продаж для формулы: только выбранные проекты (список пуст — продажи не учитываются)',
        };
    }
    const names = uuids.map((u) => {
        const key = String(u || '').trim().toLowerCase();
        const n = nameByUuid && nameByUuid.get(key);
        return n && n !== key ? String(n) : u;
    });
    const preview =
        names.length <= 4
            ? names.join('; ')
            : `${names.slice(0, 3).join('; ')} … (+${names.length - 3})`;
    return {
        mode: 'selected',
        active: true,
        uuids,
        project_names: names,
        label: `Учёт продаж для формулы: только выбранные проекты (${uuids.length}): ${preview}`,
    };
}

module.exports = {
    parseUuidList,
    salesFormulaProjectMode,
    salesFormulaProjectUuids,
    isSalesFormulaProjectFilterActive,
    msDemandProjectFilterClause,
    salesFormulaProjectFilterFingerprint,
    loadMsDemandProjectNameMap,
    describeSalesFormulaProjectFilter,
};
