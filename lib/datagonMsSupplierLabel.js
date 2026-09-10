'use strict';

/**
 * Имена поставщиков из МойСклад: при сбое expand/GET раньше писали «[ID:uuid]» в ms_export.
 * Здесь — разбор fallback, резолв имени контрагента и бэкфилл строк в БД.
 */

const ID_FALLBACK_RE =
    /^\[ID:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\]$/i;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseSupplierIdFallback(label) {
    const s = String(label || '').trim();
    const m = ID_FALLBACK_RE.exec(s);
    return m ? m[1].toLowerCase() : '';
}

function sleep(ms) {
    return new Promise((r) => setTimeout(r, Math.max(0, Number(ms) || 0)));
}

/**
 * Резолвер имени supplier из объекта товара МС (expand или meta.href).
 * Неуспех не кэшируется как «[ID:…]» — только пустая строка на этот прогон.
 */
function createSupplierNameResolver({ axiosImpl, headers, baseUrl, delayMs = 200, onWarn } = {}) {
    const axios = axiosImpl;
    const cache = new Map();
    const BASE = String(baseUrl || 'https://api.moysklad.ru/api/remap/1.2').replace(/\/$/, '');
    const warn = typeof onWarn === 'function' ? onWarn : () => {};

    async function fetchNameByHref(href) {
        const urls = [];
        const raw = String(href || '').trim();
        if (!raw) return '';
        urls.push(raw);
        const uuid = String(raw.split('/').pop() || '')
            .split('?')[0]
            .trim();
        if (UUID_RE.test(uuid)) {
            const canon = `${BASE}/entity/counterparty/${uuid}`;
            if (canon !== raw) urls.push(canon);
        }
        let lastErr = null;
        for (let attempt = 0; attempt < 3; attempt += 1) {
            if (attempt > 0) await sleep(delayMs * attempt);
            for (const url of urls) {
                try {
                    const resp = await axios.get(url, { headers, timeout: 30000 });
                    const name = String(resp?.data?.name || '').trim();
                    if (name) return name;
                } catch (e) {
                    lastErr = e;
                }
            }
        }
        if (lastErr) {
            warn(
                `supplier name resolve failed: ${uuid || raw} → ${String(lastErr.message || lastErr).slice(0, 160)}`
            );
        }
        return '';
    }

    async function resolve(supplier) {
        if (!supplier) return '';
        const direct = String(supplier.name || '').trim();
        if (direct) return direct;
        const href = String(supplier.meta?.href || '').trim();
        if (!href) return '';
        if (cache.has(href)) return cache.get(href);
        const name = await fetchNameByHref(href);
        // Пустой результат тоже кэшируем на прогон, чтобы не долбить API по каждому товару.
        cache.set(href, name);
        return name;
    }

    async function resolveByUuid(uuid) {
        const id = String(uuid || '').trim();
        if (!UUID_RE.test(id)) return '';
        const href = `${BASE}/entity/counterparty/${id}`;
        if (cache.has(href)) return cache.get(href);
        const name = await fetchNameByHref(href);
        cache.set(href, name);
        return name;
    }

    return { resolve, resolveByUuid, cache, fetchNameByHref };
}

/**
 * Заменить в ms_export все supplier вида «[ID:uuid]» на имя из API МС.
 * @returns {Promise<{ distinct: number, updated_rows: number, resolved: number, unresolved: string[] }>}
 */
async function backfillMsExportSupplierIdLabels(db, opts = {}) {
    const { axiosImpl, headers, baseUrl, delayMs = 150, onProgress } = opts;
    if (!db || !axiosImpl || !headers) {
        throw new Error('backfillMsExportSupplierIdLabels: db, axiosImpl, headers обязательны');
    }
    const [rows] = await db.query(
        `SELECT DISTINCT supplier AS label
           FROM ms_export
          WHERE supplier LIKE '[ID:%'`
    );
    const resolver = createSupplierNameResolver({
        axiosImpl,
        headers,
        baseUrl,
        delayMs,
        onWarn: opts.onWarn
    });
    let updatedRows = 0;
    let resolved = 0;
    const unresolved = [];
    for (let i = 0; i < rows.length; i += 1) {
        const label = String(rows[i].label || '').trim();
        const uuid = parseSupplierIdFallback(label);
        if (!uuid) {
            unresolved.push(label);
            continue;
        }
        const name = await resolver.resolveByUuid(uuid);
        if (!name) {
            unresolved.push(label);
            if (typeof onProgress === 'function') onProgress({ i: i + 1, total: rows.length, label, name: '' });
            continue;
        }
        resolved += 1;
        const [res] = await db.query(`UPDATE ms_export SET supplier = ? WHERE supplier = ?`, [name, label]);
        updatedRows += Number(res?.affectedRows || 0);
        // Настройки/история: если ключ был [ID:…] (редко) — переименовать, не затирая уже существующий name-ключ.
        for (const table of ['dg_supplier_settings', 'dg_supplier_fill_history', 'dg_supplier_ms_order_log']) {
            try {
                const [[exists]] = await db.query(
                    `SELECT 1 AS ok FROM ${table} WHERE supplier_key = ? LIMIT 1`,
                    [name]
                );
                if (exists) {
                    await db.query(`DELETE FROM ${table} WHERE supplier_key = ?`, [label]);
                } else {
                    await db.query(`UPDATE ${table} SET supplier_key = ? WHERE supplier_key = ?`, [name, label]);
                }
            } catch (_) {
                /* таблица/колонка может отсутствовать на старых стендах */
            }
        }
        if (typeof onProgress === 'function') onProgress({ i: i + 1, total: rows.length, label, name });
        if (delayMs > 0) await sleep(delayMs);
    }
    return {
        distinct: rows.length,
        updated_rows: updatedRows,
        resolved,
        unresolved
    };
}

module.exports = {
    parseSupplierIdFallback,
    createSupplierNameResolver,
    backfillMsExportSupplierIdLabels
};
