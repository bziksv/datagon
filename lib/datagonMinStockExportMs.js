'use strict';

/**
 * Авто-выгрузка неснижаемого остатка в МойСклад (`product.minimumBalance`).
 * Источник: `ms_export.min_stock`. Охват: складская позиция «Да», не в архиве,
 * не «Комплект», есть uuid. Отдельная задача автосинка `min_stock_export`.
 */

const axios = require('axios');
const config = require('../config');

const MS_BASE_URL = 'https://api.moysklad.ru/api/remap/1.2';
const SYNC_DELAY_MS = 60;
const MS_PUT_TIMEOUT_MS = 30000;

const scheduledState = {
    active: false,
    started_at: null,
    finished_at: null,
    total: 0,
    processed: 0,
    ok: 0,
    err: 0,
    skipped_no_uuid: 0,
    skipped_no_min: 0,
    skipped_bundle: 0,
    last_code: '',
    last_name: '',
    last_status: '',
    last_message: '',
    error: null,
    summary: null,
};

function getMsToken() {
    return process.env.MS_TOKEN || (config && config.msToken) || '';
}

function normalizeMinStockValue(raw) {
    if (raw == null || raw === '') return null;
    const n = Number(String(raw).replace(',', '.'));
    if (!Number.isFinite(n) || n < 0) return null;
    return Math.round(n * 1000) / 1000;
}

async function ensureLogSchema(db) {
    await db.query(`
        CREATE TABLE IF NOT EXISTS ms_min_stock_export_log (
            id INT AUTO_INCREMENT PRIMARY KEY,
            code VARCHAR(64) NOT NULL,
            min_stock DECIMAL(15,3) NULL,
            http_status INT NULL,
            error_message VARCHAR(512) NULL,
            trigger_type VARCHAR(20) NOT NULL DEFAULT 'schedule',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            INDEX idx_mmsel_created (created_at),
            INDEX idx_mmsel_code (code, created_at)
        )
    `);
}

async function logMsError(db, code, minStock, httpStatus, errMsg, triggerType) {
    await ensureLogSchema(db);
    await db.query(
        `INSERT INTO ms_min_stock_export_log (code, min_stock, http_status, error_message, trigger_type)
         VALUES (?, ?, ?, ?, ?)`,
        [
            String(code || '').slice(0, 64),
            minStock,
            httpStatus != null ? Number(httpStatus) : null,
            errMsg ? String(errMsg).slice(0, 512) : null,
            String(triggerType || 'schedule').slice(0, 20),
        ],
    );
}

async function pushMinStockToMs(uuid, minStock) {
    const token = getMsToken();
    if (!token) {
        const e = new Error('MS_TOKEN не задан (env MS_TOKEN или config.msToken)');
        e.code = 'NO_TOKEN';
        throw e;
    }
    const cleanUuid = String(uuid || '').trim();
    if (!cleanUuid) {
        return { ok: false, error: 'Нет uuid', http_status: 0 };
    }
    const headers = {
        Authorization: 'Bearer ' + token,
        'Content-Type': 'application/json',
        Accept: 'application/json;charset=utf-8',
    };
    const url = MS_BASE_URL + '/entity/product/' + encodeURIComponent(cleanUuid);
    try {
        const resp = await axios.put(
            url,
            { minimumBalance: minStock },
            { headers, timeout: MS_PUT_TIMEOUT_MS },
        );
        return {
            ok: true,
            http_status: resp && resp.status ? Number(resp.status) : 200,
            ms_updated_at: resp && resp.data && resp.data.updated ? String(resp.data.updated) : null,
        };
    } catch (e) {
        const httpStatus = e && e.response && e.response.status ? Number(e.response.status) : 0;
        const errBody = e && e.response && e.response.data;
        let msErr = '';
        if (errBody && Array.isArray(errBody.errors) && errBody.errors[0]) {
            msErr = String(errBody.errors[0].error || errBody.errors[0].message || '');
        } else if (typeof errBody === 'string') {
            msErr = errBody;
        }
        const net =
            httpStatus === 0
                ? 'MS API NETWORK: ' + (msErr || e.message || 'unknown')
                : 'MS API ' + httpStatus + ': ' + (msErr || e.message || 'unknown');
        return { ok: false, error: net, http_status: httpStatus };
    }
}

function getScheduledSyncState() {
    return {
        active: scheduledState.active,
        started_at: scheduledState.started_at,
        finished_at: scheduledState.finished_at,
        total: scheduledState.total,
        processed: scheduledState.processed,
        ok: scheduledState.ok,
        err: scheduledState.err,
        skipped_no_uuid: scheduledState.skipped_no_uuid,
        skipped_no_min: scheduledState.skipped_no_min,
        skipped_bundle: scheduledState.skipped_bundle,
        last_code: scheduledState.last_code,
        last_name: scheduledState.last_name,
        last_status: scheduledState.last_status,
        last_message: scheduledState.last_message,
        error: scheduledState.error,
        summary: scheduledState.summary,
        message: scheduledState.summary || scheduledState.last_message || '',
    };
}

/**
 * @param {import('mysql2/promise').Pool} db
 * @param {string} triggerType schedule|manual
 * @param {{ onRunMessage?: (msg: string) => Promise<void> }} [hooks]
 */
async function runScheduledMinStockExportMs(db, triggerType, hooks) {
    const hookMsg =
        hooks && typeof hooks.onRunMessage === 'function'
            ? async (msg) => {
                  try {
                      await hooks.onRunMessage(String(msg || '').slice(0, 2000));
                  } catch (_) {}
              }
            : null;

    if (scheduledState.active) {
        return { started: false, reason: 'already_running' };
    }

    scheduledState.active = true;
    scheduledState.started_at = new Date();
    scheduledState.finished_at = null;
    scheduledState.total = 0;
    scheduledState.processed = 0;
    scheduledState.ok = 0;
    scheduledState.err = 0;
    scheduledState.skipped_no_uuid = 0;
    scheduledState.skipped_no_min = 0;
    scheduledState.skipped_bundle = 0;
    scheduledState.last_code = '';
    scheduledState.last_name = '';
    scheduledState.last_status = '';
    scheduledState.last_message = '';
    scheduledState.error = null;
    scheduledState.summary = null;

    const trigger = String(triggerType || 'schedule').trim() || 'schedule';

    try {
        await ensureLogSchema(db);
        const [rows] = await db.query(
            `SELECT code, uuid, name, type, min_stock
             FROM ms_export
             WHERE LOWER(TRIM(stock_position)) = 'да'
               AND COALESCE(is_archived, 0) = 0
               AND uuid IS NOT NULL AND TRIM(uuid) <> ''
             ORDER BY code ASC`,
        );
        const tasks = [];
        for (const r of Array.isArray(rows) ? rows : []) {
            const code = String(r.code || '').trim();
            if (!code) continue;
            const type = String(r.type || '').trim();
            if (type === 'Комплект') {
                tasks.push({ code, skip: 'bundle' });
                continue;
            }
            const minStock = normalizeMinStockValue(r.min_stock);
            if (minStock == null) {
                tasks.push({ code, skip: 'no_min' });
                continue;
            }
            tasks.push({
                code,
                uuid: String(r.uuid || '').trim(),
                name: r.name != null ? String(r.name) : '',
                min_stock: minStock,
            });
        }

        scheduledState.total = tasks.length;
        if (hookMsg) {
            await hookMsg(
                'Неснижаемый МС: старт; позиций ' +
                    tasks.length +
                    ' (склад.поз. «Да», не архив; прогресс ~раз в 50; пауза 60 мс)',
            );
        }

        for (let i = 0; i < tasks.length; i++) {
            const t = tasks[i];
            scheduledState.last_code = t.code;
            scheduledState.last_name = t.name || '';
            scheduledState.processed++;

            if (t.skip === 'bundle') {
                scheduledState.skipped_bundle++;
                scheduledState.last_status = 'skip_bundle';
                scheduledState.last_message = 'Пропуск: комплект (minimumBalance только у товара)';
            } else if (t.skip === 'no_min') {
                scheduledState.skipped_no_min++;
                scheduledState.last_status = 'skip_no_min';
                scheduledState.last_message = 'Пропуск: min_stock не задан в ms_export';
            } else if (!t.uuid) {
                scheduledState.skipped_no_uuid++;
                scheduledState.last_status = 'skip_no_uuid';
                scheduledState.last_message = 'Пропуск: нет uuid';
            } else {
                try {
                    const push = await pushMinStockToMs(t.uuid, t.min_stock);
                    if (push.ok) {
                        scheduledState.ok++;
                        scheduledState.last_status = 'ok';
                        scheduledState.last_message = '✓ minimumBalance=' + t.min_stock;
                    } else {
                        scheduledState.err++;
                        scheduledState.last_status = 'err';
                        scheduledState.last_message = push.error || 'Ошибка МС';
                        await logMsError(
                            db,
                            t.code,
                            t.min_stock,
                            push.http_status,
                            push.error,
                            trigger,
                        );
                    }
                } catch (e) {
                    scheduledState.err++;
                    scheduledState.last_status = 'err';
                    scheduledState.last_message = (e && e.message) || String(e);
                    await logMsError(db, t.code, t.min_stock, 0, scheduledState.last_message, trigger);
                }
                await new Promise((resolve) => setTimeout(resolve, SYNC_DELAY_MS));
            }

            if (i % 10 === 9) {
                await new Promise((resolve) => setImmediate(resolve));
            }
            if (hookMsg && (i % 50 === 49 || i === tasks.length - 1)) {
                await hookMsg(
                    'Неснижаемый МС: ' +
                        scheduledState.processed +
                        '/' +
                        scheduledState.total +
                        '; ✓ ' +
                        scheduledState.ok +
                        '; × ' +
                        scheduledState.err +
                        '; без uuid: ' +
                        scheduledState.skipped_no_uuid +
                        '; без min: ' +
                        scheduledState.skipped_no_min +
                        '; комплекты: ' +
                        scheduledState.skipped_bundle +
                        (scheduledState.last_code ? ' · ' + scheduledState.last_code : ''),
                );
            }
        }

        scheduledState.summary =
            'Всего: ' +
            scheduledState.total +
            '; ✓ ' +
            scheduledState.ok +
            '; × ' +
            scheduledState.err +
            '; пропуск комплект: ' +
            scheduledState.skipped_bundle +
            '; без min_stock: ' +
            scheduledState.skipped_no_min +
            '; без uuid: ' +
            scheduledState.skipped_no_uuid;
    } catch (e) {
        scheduledState.error = (e && e.message) || String(e);
        scheduledState.summary = 'Сбой: ' + scheduledState.error;
    } finally {
        scheduledState.active = false;
        scheduledState.finished_at = new Date();
    }

    return { started: true, summary: scheduledState.summary };
}

/**
 * Ошибки выгрузки за интервал запуска (для модалки «Лог» на /processes.html).
 */
async function listErrorsForRunInterval(db, fromIso, toIso, limit = 200) {
    await ensureLogSchema(db);
    const lim = Math.min(500, Math.max(1, Number(limit) || 200));
    const params = [];
    let where = '1=1';
    if (fromIso) {
        where += ' AND created_at >= ?';
        params.push(new Date(fromIso));
    }
    if (toIso) {
        where += ' AND created_at <= ?';
        params.push(new Date(toIso));
    }
    params.push(lim);
    const [rows] = await db.query(
        `SELECT code, min_stock, http_status, error_message, trigger_type, created_at
         FROM ms_min_stock_export_log
         WHERE ${where}
         ORDER BY id DESC
         LIMIT ?`,
        params,
    );
    return (rows || []).map((r) => ({
        code: String(r.code || ''),
        min_stock: r.min_stock != null ? Number(r.min_stock) : null,
        http_status: r.http_status != null ? Number(r.http_status) : null,
        error_message: r.error_message != null ? String(r.error_message) : '',
        trigger_type: String(r.trigger_type || ''),
        created_at: r.created_at ? new Date(r.created_at).toISOString() : '',
    }));
}

module.exports = {
    runScheduledMinStockExportMs,
    getScheduledSyncState,
    listErrorsForRunInterval,
    ensureLogSchema,
    pushMinStockToMs,
    normalizeMinStockValue,
};
