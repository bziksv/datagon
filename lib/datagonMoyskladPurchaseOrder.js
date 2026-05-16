'use strict';

/**
 * Создание заказа поставщику (purchaseorder) в МойСклад со страницы «Поставщики».
 */

const axios = require('axios');
const config = require('../config');
const { loadSupplierExportRows } = require('./datagonSupplierExport');
const {
    createMsOrderRunContext,
    appendMsOrderStep,
    consoleMsOrder,
    persistSupplierMsOrderLog,
} = require('./datagonSupplierMsOrderLog');

const MS_BASE_URL = 'https://api.moysklad.ru/api/remap/1.2';
const DEFAULT_STORE_NAME = 'Альмамед Ожидание';
const ENTITY_CACHE_TTL_MS = 60 * 60 * 1000;

const entityCache = new Map();

function getMsToken() {
    return process.env.MS_TOKEN || (config && config.msToken) || '';
}

function msHeaders(token) {
    return {
        Authorization: 'Bearer ' + token,
        Accept: 'application/json;charset=utf-8',
        'Content-Type': 'application/json;charset=utf-8',
    };
}

function detectAssortmentType(msType) {
    const t = String(msType || '').toLowerCase();
    if (t === 'комплект' || t === 'bundle') return 'bundle';
    return 'product';
}

function assortmentMeta(uuid, msType) {
    const kind = detectAssortmentType(msType);
    const id = String(uuid || '').trim().toLowerCase();
    return {
        meta: {
            href: `${MS_BASE_URL}/entity/${kind}/${id}`,
            type: kind,
            mediaType: 'application/json',
        },
    };
}

function sanitizeNamePart(s) {
    return (
        String(s || '')
            .trim()
            .replace(/[\s/\\|]+/g, '_')
            .replace(/[^\w\u0400-\u04FF.\-()+@]/gi, '')
            .replace(/_+/g, '_')
            .replace(/^_|_$/g, '')
            .slice(0, 80) || 'без_имени'
    );
}

function employeeNameForOrder(fullName) {
    const fn = String(fullName || '').trim();
    const parts = fn.split(/\s+/).filter(Boolean);
    if (parts.length >= 2) return `${parts[0]}_${parts[1]}`;
    return parts[0] || 'Сотрудник';
}

function formatOrderDate(d = new Date()) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

function buildOrderName(employeeFullName, supplierName, dateStr) {
    const emp = sanitizeNamePart(employeeNameForOrder(employeeFullName));
    const sup = sanitizeNamePart(supplierName);
    const dt = sanitizeNamePart(dateStr || formatOrderDate());
    return `${emp}_${sup}_${dt}`.slice(0, 255);
}

function priceToMinorUnits(rubles) {
    if (rubles == null || !Number.isFinite(Number(rubles))) return 0;
    return Math.round(Number(rubles) * 100);
}

function cacheGet(key) {
    const c = entityCache.get(key);
    if (c && Date.now() - c.ts < ENTITY_CACHE_TTL_MS) return c.value;
    return null;
}

function cacheSet(key, value) {
    entityCache.set(key, { ts: Date.now(), value });
}

function msApiErrorDetails(e) {
    const out = { message: e.message || String(e) };
    if (e.response) {
        out.http_status = e.response.status;
        const d = e.response.data;
        if (d) {
            if (Array.isArray(d.errors)) out.ms_errors = d.errors;
            else out.ms_body = d;
        }
    }
    return out;
}

function msApiErrorMessage(e) {
    const d = msApiErrorDetails(e);
    if (d.ms_errors && d.ms_errors.length) {
        return d.ms_errors.map((x) => x.error || x.message || JSON.stringify(x)).join('; ');
    }
    if (d.ms_body && d.ms_body.error) return String(d.ms_body.error);
    return d.message;
}

async function msGet(path, token, params) {
    const resp = await axios.get(MS_BASE_URL + path, {
        headers: msHeaders(token),
        params: params || {},
        timeout: 60000,
    });
    return resp.data;
}

async function msPost(path, token, body) {
    const resp = await axios.post(MS_BASE_URL + path, body, {
        headers: msHeaders(token),
        timeout: 120000,
    });
    return resp.data;
}

/**
 * @returns {Promise<{ entity: object|null, match: string|null, candidates: string[], from_cache: boolean }>}
 */
async function findMsEntityByName(entityType, name, token, runContext) {
    const needle = String(name || '').trim();
    const empty = { entity: null, match: null, candidates: [], from_cache: false };
    if (!needle) return empty;

    const cacheKey = `${entityType}:${needle.toLowerCase()}`;
    const cached = cacheGet(cacheKey);
    if (cached) {
        if (runContext) {
            appendMsOrderStep(runContext, `resolve_${entityType}`, {
                ok: true,
                search: needle,
                picked_name: cached.name,
                picked_id: cached.id,
                from_cache: true,
            });
        }
        return { entity: cached, match: 'cache', candidates: [cached.name], from_cache: true };
    }

    let rows = [];
    try {
        const data = await msGet(`/entity/${entityType}`, token, {
            search: needle,
            limit: 25,
        });
        rows = Array.isArray(data.rows) ? data.rows : [];
    } catch (e) {
        if (runContext) {
            appendMsOrderStep(runContext, `resolve_${entityType}`, {
                ok: false,
                search: needle,
                ...msApiErrorDetails(e),
            });
        }
        throw e;
    }

    const candidates = rows.map((r) => String(r.name || '').trim()).filter(Boolean);
    const exact = rows.find((r) => String(r.name || '').trim() === needle);
    const caseInsensitive = rows.find(
        (r) => String(r.name || '').trim().toLowerCase() === needle.toLowerCase(),
    );
    const pick = exact || caseInsensitive || rows[0];
    let match = null;
    if (exact) match = 'exact';
    else if (caseInsensitive) match = 'case_insensitive';
    else if (rows[0]) match = 'first_search_hit';

    if (!pick || !pick.meta || !pick.meta.href) {
        if (runContext) {
            appendMsOrderStep(runContext, `resolve_${entityType}`, {
                ok: false,
                search: needle,
                candidates_count: candidates.length,
                candidates: candidates.slice(0, 10),
            });
        }
        return empty;
    }

    const out = {
        id: pick.id,
        name: String(pick.name || '').trim(),
        meta: {
            href: pick.meta.href,
            type: entityType,
            mediaType: 'application/json',
        },
    };
    cacheSet(cacheKey, out);

    if (runContext) {
        appendMsOrderStep(runContext, `resolve_${entityType}`, {
            ok: true,
            search: needle,
            match,
            picked_name: out.name,
            picked_id: out.id,
            candidates_count: candidates.length,
            candidates: candidates.slice(0, 10),
            warn_fuzzy: match === 'first_search_hit' ? 'Использован первый результат поиска, точного совпадения нет' : null,
        });
    }

    return { entity: out, match, candidates, from_cache: false };
}

function normalizeOrgNameKey(s) {
    return String(s || '')
        .toLowerCase()
        .replace(/[«»""]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function rowToOrganization(row) {
    return {
        id: row.id,
        name: String(row.name || '').trim(),
        meta: row.meta,
    };
}

/**
 * Выбор организации из списка МС: настройка → единственная → авто «АЛЬМАМЕД».
 * @returns {{ org: object, match: string }|null}
 */
function pickOrganizationFromRows(rows, preferName) {
    if (!rows.length) return null;
    const prefer = String(preferName || '').trim();
    if (prefer) {
        const needle = normalizeOrgNameKey(prefer);
        const exact = rows.find((r) => normalizeOrgNameKey(r.name) === needle);
        if (exact) return { org: rowToOrganization(exact), match: 'settings_exact' };
        const partial = rows.filter((r) => {
            const n = normalizeOrgNameKey(r.name);
            return n.includes(needle) || needle.includes(n);
        });
        if (partial.length === 1) return { org: rowToOrganization(partial[0]), match: 'settings_partial' };
    }
    if (rows.length === 1) return { org: rowToOrganization(rows[0]), match: 'single' };
    const almamedHits = rows.filter((r) => {
        const n = normalizeOrgNameKey(r.name);
        return n.includes('альмамед') || n.includes('almamed');
    });
    if (almamedHits.length === 1) {
        return { org: rowToOrganization(almamedHits[0]), match: 'auto_almamed' };
    }
    return null;
}

async function resolveOrganization(token, appSettings, runContext) {
    const prefer = String(
        (appSettings && appSettings.ms_purchase_order_organization_name) ||
            process.env.MS_PURCHASE_ORGANIZATION_NAME ||
            '',
    ).trim();
    if (prefer) {
        const found = await findMsEntityByName('organization', prefer, token, null);
        if (found.entity) {
            appendMsOrderStep(runContext, 'resolve_organization', {
                ok: true,
                match: found.match,
                picked_name: found.entity.name,
                source: 'ms_search',
                prefer,
            });
            return found.entity;
        }
        appendMsOrderStep(runContext, 'resolve_organization', {
            ok: false,
            note: `Организация «${prefer}» не найдена поиском МС, сверяем со списком`,
            prefer,
        });
    }
    const data = await msGet('/entity/organization', token, { limit: 25 });
    const rows = Array.isArray(data.rows) ? data.rows : [];
    const names = rows.map((r) => String(r.name || '').trim()).filter(Boolean);
    const picked = pickOrganizationFromRows(rows, prefer);
    appendMsOrderStep(runContext, 'resolve_organization_list', {
        ok: rows.length > 0,
        count: rows.length,
        names,
        picked: picked ? picked.org.name : null,
        pick_match: picked ? picked.match : null,
    });
    if (!rows.length) {
        const e = new Error('В МойСклад не найдено ни одной организации');
        e.code = 'NO_ORGANIZATION';
        throw e;
    }
    if (picked) {
        if (picked.match === 'auto_almamed' && runContext) {
            appendMsOrderStep(runContext, 'resolve_organization', {
                ok: true,
                match: picked.match,
                picked_name: picked.org.name,
                note: 'Автовыбор единственной организации с «АЛЬМАМЕД» в названии',
            });
        }
        return picked.org;
    }
    const e = new Error(
        'В МойСклад несколько организаций — укажите организацию в Настройки → Синхронизация МойСклад → «Организация для заказов поставщику»',
    );
    e.code = 'AMBIGUOUS_ORGANIZATION';
    e.organization_names = names;
    throw e;
}

async function finalizeMsOrderLog(db, runContext, actor, outcome) {
    const logId = await persistSupplierMsOrderLog(db, {
        supplier_key: runContext.supplier_key,
        status: outcome.status,
        code_error: outcome.code_error || null,
        order_name: outcome.order_name || null,
        ms_uuid: outcome.ms_uuid || null,
        ms_href: outcome.ms_href || null,
        positions_count: outcome.positions_count,
        lines_total: outcome.lines_total,
        http_status: outcome.http_status,
        message: outcome.message,
        runContext,
        extra_detail: outcome.extra_detail || null,
        actor,
    });
    consoleMsOrder(outcome.status === 'success' ? 'log' : 'error', {
        log_id: logId,
        supplier_key: runContext.supplier_key,
        status: outcome.status,
        code_error: outcome.code_error || null,
        last_step:
            runContext.steps && runContext.steps.length
                ? runContext.steps[runContext.steps.length - 1].step
                : null,
        message: outcome.message,
    });
    return logId;
}

/**
 * @param {import('mysql2/promise').Pool} db
 * @param {object} appSettings
 * @param {{ supplierKey: string, actor?: object|null }} opts
 */
async function createPurchaseOrderForSupplier(db, appSettings, opts) {
    const supplierKey = String(opts.supplierKey || '').trim();
    const actor = opts.actor || null;
    const runContext = createMsOrderRunContext(supplierKey);
    appendMsOrderStep(runContext, 'start', {
        actor_id: actor && actor.id != null ? actor.id : null,
        actor_name:
            actor && (actor.full_name || actor.username)
                ? String(actor.full_name || actor.username).trim()
                : null,
    });

    let linesTotal = null;
    let positionsCount = null;
    let orderName = null;

    try {
        if (!supplierKey) {
            const e = new Error('Пустой ключ поставщика');
            e.code = 'BAD_REQUEST';
            throw e;
        }

        const token = getMsToken();
        if (!token) {
            appendMsOrderStep(runContext, 'check_token', { ok: false });
            const e = new Error('MS_TOKEN не задан (env MS_TOKEN или config.msToken)');
            e.code = 'NO_TOKEN';
            throw e;
        }
        appendMsOrderStep(runContext, 'check_token', { ok: true });

        const exportRows = await loadSupplierExportRows(db, appSettings, {
            supplierKey,
            toPurchaseOnly: true,
        });
        const withQty = exportRows.filter((r) => r.need_qty > 0);
        linesTotal = withQty.length;
        appendMsOrderStep(runContext, 'load_rows', {
            ok: true,
            export_rows: exportRows.length,
            with_qty: withQty.length,
        });
        if (!withQty.length) {
            const e = new Error('Нет позиций к закупке для этого поставщика');
            e.code = 'NO_LINES';
            throw e;
        }

        const [[settingsRow]] = await db.query(
            `SELECT ss.assigned_user_id,
                    COALESCE(NULLIF(TRIM(u.full_name), ''), u.username, '') AS assigned_user_name
               FROM dg_supplier_settings ss
               LEFT JOIN users u ON u.id = ss.assigned_user_id
              WHERE ss.supplier_key = ?
              LIMIT 1`,
            [supplierKey],
        );
        const employeeName =
            settingsRow && settingsRow.assigned_user_name
                ? String(settingsRow.assigned_user_name)
                : 'Сотрудник';
        appendMsOrderStep(runContext, 'assignee', {
            ok: true,
            assigned_user_id: settingsRow ? settingsRow.assigned_user_id : null,
            employee_name: employeeName,
        });

        const skippedNoUuid = [];
        const positions = [];
        for (const r of withQty) {
            const uuid = String(r.uuid || '').trim();
            if (!uuid) {
                skippedNoUuid.push({ code: r.code, name: r.name });
                continue;
            }
            positions.push({
                quantity: Number(r.need_qty),
                price: priceToMinorUnits(r.buy_price),
                assortment: assortmentMeta(uuid, r.ms_entity_type),
                _code: r.code,
            });
        }
        positionsCount = positions.length;
        appendMsOrderStep(runContext, 'build_positions', {
            ok: positions.length > 0,
            positions_count: positions.length,
            skipped_no_uuid_count: skippedNoUuid.length,
            skipped_no_uuid: skippedNoUuid.slice(0, 50),
        });

        if (!positions.length) {
            const e = new Error(
                'Нет позиций с uuid в ms_export — выполните синхронизацию МойСклад',
            );
            e.code = 'NO_UUID';
            e.skipped_no_uuid = skippedNoUuid;
            throw e;
        }

        const organization = await resolveOrganization(token, appSettings, runContext);
        const agentFound = await findMsEntityByName('counterparty', supplierKey, token, runContext);
        const storeFound = await findMsEntityByName('store', DEFAULT_STORE_NAME, token, runContext);
        const agent = agentFound.entity;
        const store = storeFound.entity;

        if (!agent) {
            const e = new Error(`Контрагент «${supplierKey}» не найден в МойСклад`);
            e.code = 'COUNTERPARTY_NOT_FOUND';
            e.search_candidates = agentFound.candidates;
            throw e;
        }
        if (!store) {
            const e = new Error(`Склад «${DEFAULT_STORE_NAME}» не найден в МойСклад`);
            e.code = 'STORE_NOT_FOUND';
            e.search_candidates = storeFound.candidates;
            throw e;
        }

        orderName = buildOrderName(employeeName, supplierKey, formatOrderDate());
        const body = {
            name: orderName,
            organization: { meta: organization.meta },
            agent: { meta: agent.meta },
            store: { meta: store.meta },
            applicable: false,
            positions: positions.map((p) => ({
                quantity: p.quantity,
                price: p.price,
                assortment: p.assortment,
            })),
        };
        appendMsOrderStep(runContext, 'post_purchaseorder', {
            ok: null,
            order_name: orderName,
            positions_count: positions.length,
            organization_name: organization.name,
            counterparty_name: agent.name,
            store_name: store.name,
            applicable: false,
        });

        let created;
        try {
            created = await msPost('/entity/purchaseorder', token, body);
        } catch (e) {
            const details = msApiErrorDetails(e);
            appendMsOrderStep(runContext, 'post_purchaseorder', {
                ok: false,
                ...details,
            });
            const err = new Error('МойСклад: ' + msApiErrorMessage(e));
            err.code = 'MS_API';
            err.http_status = details.http_status;
            err.ms_errors = details.ms_errors;
            throw err;
        }

        appendMsOrderStep(runContext, 'post_purchaseorder', {
            ok: true,
            ms_uuid: created && created.id ? String(created.id) : null,
        });

        const msUuid = created && created.id ? String(created.id) : '';
        const msWebHref = msUuid
            ? `https://online.moysklad.ru/app/#purchaseorder/edit?id=${msUuid}`
            : 'https://online.moysklad.ru/app/#purchaseorder';

        const result = {
            success: true,
            order_name: orderName,
            ms_uuid: msUuid,
            ms_href: created && created.meta && created.meta.href ? String(created.meta.href) : '',
            ms_web_href: msWebHref,
            positions_count: positions.length,
            lines_total: withQty.length,
            skipped_no_uuid: skippedNoUuid,
            counterparty_name: agent.name,
            store_name: store.name,
            organization_name: organization.name,
        };

        const logId = await finalizeMsOrderLog(db, runContext, actor, {
            status: 'success',
            order_name: orderName,
            ms_uuid: msUuid,
            ms_href: result.ms_href,
            positions_count: positions.length,
            lines_total: withQty.length,
            message: `Заказ создан: ${positions.length} поз.`,
        });
        result.log_id = logId;
        return result;
    } catch (e) {
        const logId = await finalizeMsOrderLog(db, runContext, actor, {
            status: 'failed',
            code_error: e.code || 'UNKNOWN',
            order_name: orderName,
            positions_count: positionsCount,
            lines_total: linesTotal,
            http_status: e.http_status,
            message: e.message || String(e),
            extra_detail: {
                ms_errors: e.ms_errors || null,
                search_candidates: e.search_candidates || e.organization_names || null,
                skipped_no_uuid: e.skipped_no_uuid || null,
            },
        });
        e.log_id = logId;
        throw e;
    }
}

module.exports = {
    createPurchaseOrderForSupplier,
    buildOrderName,
    DEFAULT_STORE_NAME,
};
