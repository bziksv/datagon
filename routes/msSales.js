/**
 * MS Sales — отдельная страница «Продажи МС»: тянет отгрузки (entity/demand)
 * из МойСклад API, хранит документы и позиции локально, резолвит позиции до
 * наших товаров (ms_export.uuid / ms_export.code).
 *
 * Архитектурный принцип:
 *   • Это «отдельный полноценный модуль внутри Datagon», а не view поверх
 *     ms_export. Своя пара таблиц (ms_demand + ms_demand_position), свой
 *     роутер, свой UI /ms-sales.html.
 *   • Содержимое отгрузок (позиции) хранит DOUBLE-ссылку на наши товары:
 *     1) `assortment_uuid` (uuid ассортимента из МС: product/bundle/variant);
 *     2) `product_uuid` (родительский product, если variant);
 *     3) денормализованный `ms_export_code` / `ms_export_uuid` — полученный
 *        резолвом по ms_export.uuid в момент сохранения. Если резолв не
 *        удался — `ms_export_resolved=0`, имя/код товара берутся из
 *        `name_at_moment` / `code_at_moment` (срез на дату отгрузки).
 *   • Re-resolve запускается отдельной командой (POST /ms-sales/reresolve)
 *     или автоматически после успешного `syncMsExport` — чтобы новые
 *     товары в ms_export подхватили старые позиции.
 *
 * Эндпоинты:
 *   GET    /api/ms-sales/list                — отгрузки с пагинацией.
 *   GET    /api/ms-sales/:uuid/positions     — позиции конкретной отгрузки.
 *   GET    /api/ms-sales/by-product/:code    — отгрузки по конкретному коду МС.
 *   GET    /api/ms-sales/aggregates          — суммарные продажи (sum_qty,
 *                                              sum_amount) по товарам за период.
 *   POST   /api/ms-sales/sync                — фоновая синхронизация.
 *   GET    /api/ms-sales/sync-status         — статус фонового job-а.
 *   POST   /api/ms-sales/reresolve           — повторный резолв позиций → товары.
 */

const express = require('express');
const axios = require('axios');
const config = require('../config');

const MS_BASE_URL = 'https://api.moysklad.ru/api/remap/1.2';

let schemaReady = false;

/**
 * Идемпотентный CREATE TABLE IF NOT EXISTS + точечный CREATE INDEX на
 * ms_export.uuid (нужен для FAST-резолва позиций при больших объёмах).
 */
async function ensureSchema(db) {
    if (schemaReady) return;

    await db.query(`
        CREATE TABLE IF NOT EXISTS ms_demand (
            uuid VARCHAR(36) NOT NULL PRIMARY KEY,
            doc_name VARCHAR(64) NOT NULL,
            moment DATETIME NOT NULL,
            applicable TINYINT(1) NOT NULL DEFAULT 1,
            agent_uuid VARCHAR(36) NULL,
            agent_name VARCHAR(255) NULL,
            store_uuid VARCHAR(36) NULL,
            store_name VARCHAR(150) NULL,
            organization_uuid VARCHAR(36) NULL,
            organization_name VARCHAR(150) NULL,
            project_uuid VARCHAR(36) NULL,
            project_name VARCHAR(150) NULL,
            contract_uuid VARCHAR(36) NULL,
            contract_name VARCHAR(150) NULL,
            sum_minor BIGINT NOT NULL DEFAULT 0,
            positions_count INT NOT NULL DEFAULT 0,
            description TEXT NULL,
            ms_created DATETIME NULL,
            ms_updated DATETIME NULL,
            fetched_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            INDEX idx_moment (moment),
            INDEX idx_agent (agent_uuid),
            INDEX idx_store (store_uuid),
            INDEX idx_ms_updated (ms_updated)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await db.query(`
        CREATE TABLE IF NOT EXISTS ms_demand_position (
            id BIGINT AUTO_INCREMENT PRIMARY KEY,
            demand_uuid VARCHAR(36) NOT NULL,
            position_uuid VARCHAR(36) NOT NULL,
            pack_idx INT NOT NULL DEFAULT 0,
            assortment_kind VARCHAR(20) NOT NULL DEFAULT 'unknown',
            assortment_uuid VARCHAR(36) NULL,
            product_uuid VARCHAR(36) NULL,
            ms_export_code VARCHAR(64) NULL,
            ms_export_uuid VARCHAR(36) NULL,
            ms_export_resolved TINYINT(1) NOT NULL DEFAULT 0,
            name_at_moment VARCHAR(500) NOT NULL DEFAULT '',
            code_at_moment VARCHAR(64) NULL,
            quantity DECIMAL(15,3) NOT NULL DEFAULT 0,
            price_minor BIGINT NOT NULL DEFAULT 0,
            discount DECIMAL(7,3) NOT NULL DEFAULT 0,
            vat INT NOT NULL DEFAULT 0,
            sum_minor BIGINT NOT NULL DEFAULT 0,
            UNIQUE KEY uk_demand_pos (demand_uuid, position_uuid),
            INDEX idx_demand (demand_uuid),
            INDEX idx_assortment (assortment_uuid),
            INDEX idx_ms_export_code (ms_export_code),
            INDEX idx_product (product_uuid),
            INDEX idx_resolved (ms_export_resolved)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    /** Индекс на ms_export.uuid — критичен для join'ов в /by-product и /reresolve. */
    try {
        await db.query('CREATE INDEX idx_ms_export_uuid ON ms_export (uuid)');
    } catch (e) {
        if (!/Duplicate key name/i.test(e && e.message ? e.message : '')) {
            console.warn('[ms-sales] ensure idx_ms_export_uuid:', e && e.message);
        }
    }

    /**
     * Расширенные поля заголовка отгрузки. Применяется ALTER'ами к существующей
     * `ms_demand` (CREATE TABLE IF NOT EXISTS не пересоздаст её, поэтому новые
     * колонки добавляем точечно).
     *
     * Что сюда попадает (и почему):
     *   • state_*           — статус документа («Новый», «В работе», …) из state.name.
     *   • owner_*           — Ответственный (employee), у пользователя в карточке
     *                         в правом верхнем углу.
     *   • group_*           — Отдел.
     *   • sales_channel_*   — Канал продаж (у пользователя «Озон»).
     *   • shipment_address  — Адрес доставки (короткий текст).
     *   • shipment_address_full JSON — раскладка адреса (postalCode, country,
     *     region, city, street, house, apartment, addInfo).
     *   • currency_*        — Валюта документа («руб (RUB)»), курс.
     *   • vat_enabled / vat_included / vat_sum_minor — настройки и сумма НДС.
     *   • payed_sum_minor   — оплачено; вместе с sum_minor даёт «Не оплачено».
     *   • external_code/sync_id/code — внешние идентификаторы документа.
     *   • printed/published  — флаги «Распечатано / Опубликовано».
     *   • attributes_json JSON — массив [{id,name,type,value}, …]: «Номер
     *     отправления с озона», «Идентификатор чека» и любые другие кастомные
     *     атрибуты документа.
     */
    const extraColumns = [
        ['state_uuid', 'VARCHAR(36) NULL'],
        ['state_name', 'VARCHAR(150) NULL'],
        ['owner_uuid', 'VARCHAR(36) NULL'],
        ['owner_name', 'VARCHAR(150) NULL'],
        ['group_uuid', 'VARCHAR(36) NULL'],
        ['group_name', 'VARCHAR(150) NULL'],
        ['sales_channel_uuid', 'VARCHAR(36) NULL'],
        ['sales_channel_name', 'VARCHAR(150) NULL'],
        ['shipment_address', 'TEXT NULL'],
        ['shipment_address_full', 'JSON NULL'],
        ['currency_uuid', 'VARCHAR(36) NULL'],
        ['currency_name', 'VARCHAR(20) NULL'],
        ['currency_iso_code', 'VARCHAR(8) NULL'],
        ['currency_rate', 'DECIMAL(15,6) NULL'],
        ['vat_enabled', 'TINYINT(1) NULL'],
        ['vat_included', 'TINYINT(1) NULL'],
        ['vat_sum_minor', 'BIGINT NULL'],
        ['payed_sum_minor', 'BIGINT NULL DEFAULT 0'],
        ['external_code', 'VARCHAR(64) NULL'],
        ['sync_id', 'VARCHAR(64) NULL'],
        ['code', 'VARCHAR(64) NULL'],
        ['printed', 'TINYINT(1) NULL DEFAULT 0'],
        ['published', 'TINYINT(1) NULL DEFAULT 0'],
        ['attributes_json', 'JSON NULL'],
        /** Raw payload документа (без `positions.rows`, чтобы не раздуть; позиции
         *  хранятся отдельно в ms_demand_position). Нужен для backfill новых
         *  полей без повторного запроса в МС API. */
        ['payload_json', 'JSON NULL'],
        /**
         * Soft-delete метка. Заполняется в `runDemandSync` после успешного
         * прохода: если документа нет в выдаче МС за тот же период, ставим
         * `deleted_at = NOW()`. При следующем синке (документ вернулся) UPSERT
         * сбрасывает её в NULL — это «воскрешение». Hard-delete не делаем,
         * чтобы сохранить позиции/историю продаж.
         */
        ['deleted_at', 'TIMESTAMP NULL DEFAULT NULL'],
    ];
    const [existingCols] = await db.query('SHOW COLUMNS FROM ms_demand');
    const existingNames = new Set((existingCols || []).map((r) => String(r.Field)));
    for (const [col, type] of extraColumns) {
        if (existingNames.has(col)) continue;
        try {
            await db.query('ALTER TABLE ms_demand ADD COLUMN `' + col + '` ' + type);
        } catch (e) {
            console.warn('[ms-sales] add column ' + col + ':', e && e.message);
        }
    }
    /** Индекс на owner — для будущих фильтров «по ответственному». */
    try {
        await db.query('CREATE INDEX idx_owner ON ms_demand (owner_uuid)');
    } catch (e) {
        if (!/Duplicate key name/i.test(e && e.message ? e.message : '')) {
            /** ignore */
        }
    }
    /** Индекс на deleted_at — для фильтра «Удалённые». */
    try {
        await db.query('CREATE INDEX idx_deleted_at ON ms_demand (deleted_at)');
    } catch (e) {
        if (!/Duplicate key name/i.test(e && e.message ? e.message : '')) {
            /** ignore */
        }
    }

    schemaReady = true;
}

function clampInt(value, min, max, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, Math.floor(n)));
}

function actorDisplayName(actor) {
    if (!actor) return '';
    return String(actor.full_name || actor.username || '').trim();
}

function getMsToken() {
    return process.env.MS_TOKEN || (config && config.msToken) || '';
}

function getMsHeaders() {
    const token = getMsToken();
    if (!token) return null;
    return {
        Authorization: 'Bearer ' + token,
        'Content-Type': 'application/json',
        Accept: 'application/json;charset=utf-8',
    };
}

/**
 * Парсинг href ассортимента → { kind, uuid }.
 * Примеры href:
 *   /entity/product/{uuid}  → { kind: 'product', uuid }
 *   /entity/bundle/{uuid}   → { kind: 'bundle', uuid }
 *   /entity/variant/{uuid}  → { kind: 'variant', uuid }
 *   /entity/service/{uuid}  → { kind: 'service', uuid }
 *   /entity/consignment/{uuid} → { kind: 'consignment', uuid }
 */
function parseAssortmentHref(href) {
    if (!href) return { kind: 'unknown', uuid: null };
    const m = String(href).match(/\/entity\/([a-zA-Z]+)\/([0-9a-f-]+)(?:\?|$)/i);
    if (!m) return { kind: 'unknown', uuid: null };
    const kind = String(m[1]).toLowerCase();
    const uuid = String(m[2]).toLowerCase();
    return { kind, uuid };
}

function parseMomentToDate(s) {
    if (!s) return null;
    /** МС возвращает "YYYY-MM-DD HH:mm:ss[.SSS]" — приводим к Date в МСК. */
    const str = String(s).replace(/\.\d+$/, '');
    const d = new Date(str.replace(' ', 'T') + '+03:00');
    return Number.isNaN(d.getTime()) ? null : d;
}

function moneyToMinor(v) {
    /** МС хранит суммы в минорных единицах (копейки). Бывают числа в payload как
     *  целые копейки (sum) и как доли (price у позиции иногда в копейках, иногда нет).
     *  Здесь всегда возвращаем целое число (копейки). */
    if (v == null) return 0;
    const n = Number(v);
    if (!Number.isFinite(n)) return 0;
    return Math.round(n);
}

/* =========================== Job state (in-memory) =========================== */

const jobState = {
    active: false,
    cancelRequested: false,
    started_at: null,
    finished_at: null,
    days: 30,
    fetched_demands: 0,
    total_demands: 0,
    saved_positions: 0,
    resolved_positions: 0,
    unresolved_positions: 0,
    deleted_demands: 0,
    restored_demands: 0,
    message: 'Ожидание',
    errors: [],
    last_error: null,
    /**
     * Resume-режим: при старте `runDemandSync` (без `options.fresh`) мы смотрим,
     * есть ли в БД сохранённые отгрузки за это окно периода и докуда мы дошли
     * в прошлом проходе. Если есть «хвост» (MIN(moment) явно позже, чем
     * `momentFrom`), сужаем `momentTo` до этой точки + 5 минут запаса и идём
     * добивать прошлое. UPSERT по uuid защищает от дублей на границе.
     *
     * resume_mode               — true, если этот прогон стартовал как resume
     *                              (не «полный с нуля»);
     * resume_from_moment        — ISO дата, с которой реально стартует
     *                              запрос к МС API (это и есть «дошли до этой
     *                              даты в прошлом проходе» + запас);
     * existing_count_at_start   — сколько отгрузок уже было в БД за это окно
     *                              периода до запуска (для UI «дополнительно
     *                              скачано: X, итого: existing+X»).
     *
     * Soft-delete пасс пропускается при `resume_mode === true`, потому что мы
     * видим только хвост и не можем считать «всё свежее, чего нет в seenUuids,
     * — удалённым». Полная сверка с soft-delete выполняется только при
     * `fresh = true` (или когда resume-режим не сработал — пустая БД).
     */
    resume_mode: false,
    resume_from_moment: null,
    existing_count_at_start: 0,
};

function resetJobState(days) {
    jobState.active = true;
    jobState.cancelRequested = false;
    jobState.started_at = new Date();
    jobState.finished_at = null;
    jobState.days = days;
    jobState.fetched_demands = 0;
    jobState.total_demands = 0;
    jobState.saved_positions = 0;
    jobState.resolved_positions = 0;
    jobState.unresolved_positions = 0;
    jobState.deleted_demands = 0;
    jobState.restored_demands = 0;
    jobState.message = 'Стартует синхронизация…';
    jobState.errors = [];
    jobState.last_error = null;
    jobState.resume_mode = false;
    jobState.resume_from_moment = null;
    jobState.existing_count_at_start = 0;
}

function jobStateToPayload() {
    return {
        active: jobState.active,
        cancel_requested: jobState.cancelRequested,
        started_at: jobState.started_at ? jobState.started_at.toISOString() : null,
        finished_at: jobState.finished_at ? jobState.finished_at.toISOString() : null,
        days: jobState.days,
        fetched_demands: jobState.fetched_demands,
        total_demands: jobState.total_demands,
        saved_positions: jobState.saved_positions,
        resolved_positions: jobState.resolved_positions,
        unresolved_positions: jobState.unresolved_positions,
        deleted_demands: jobState.deleted_demands,
        restored_demands: jobState.restored_demands,
        message: jobState.message,
        errors: jobState.errors.slice(-20),
        last_error: jobState.last_error,
        resume_mode: jobState.resume_mode,
        resume_from_moment: jobState.resume_from_moment,
        existing_count_at_start: jobState.existing_count_at_start,
    };
}

function logJobError(msg) {
    jobState.errors.push({ at: new Date().toISOString(), msg: String(msg || '') });
    jobState.last_error = String(msg || '');
}

/**
 * Композит финального сообщения синка. Различает три исхода:
 *   • Остановлено пользователем — `cancelRequested` + есть `last_error`
 *     не делаем (пользовательская остановка приоритетнее);
 *   • Прервано на ошибке — `last_error` присутствует
 *     (transient timeout, сеть, 5xx — после исчерпанных ретраев);
 *   • Готово — всё прошло до конца без фатальных ошибок.
 *
 * Раньше при ошибке UI всё равно показывал «Готово.» и пользователю было
 * непонятно, почему `fetched < total`. Теперь префикс честно отражает
 * исход; повтор запуска идемпотентен (UPSERT по uuid + тот же период),
 * поэтому в случае прерывания можно просто нажать «Синхронизировать с
 * МС» ещё раз и подхватить с того же места.
 */
function buildFinalMessage() {
    const stats =
        ' отгрузок, ' + jobState.saved_positions + ' позиций (' +
        jobState.resolved_positions + ' резолв, ' + jobState.unresolved_positions + ' не привязано' +
        ', помечено удалёнными: ' + jobState.deleted_demands +
        ', воскрешено: ' + jobState.restored_demands + ')';
    let prefix;
    if (jobState.cancelRequested) {
        prefix = 'Остановлено пользователем: ' + jobState.fetched_demands + '/' + jobState.total_demands;
    } else if (jobState.last_error) {
        prefix = 'Прервано на ошибке: ' + jobState.fetched_demands + '/' + jobState.total_demands;
    } else {
        prefix = 'Готово: ' + jobState.fetched_demands + '/' + jobState.total_demands;
    }
    /**
     * В resume-режиме `total_demands` — это размер только «хвоста», а не
     * полное число отгрузок за период. Дописываем явное упоминание, что
     * это resume и сколько уже было в БД, чтобы пользователю не казалось,
     * будто синк увидел только X документов из реального полного периода.
     */
    if (jobState.resume_mode) {
        prefix = '[Resume] ' + prefix + stats +
            '. До этого прогона в БД за период уже было ' + jobState.existing_count_at_start +
            ' отгрузок (доскачано ' + jobState.fetched_demands + ', итого ≈ ' +
            (jobState.existing_count_at_start + jobState.fetched_demands) + ')';
        return prefix;
    }
    return prefix + stats;
}

/* ============================ MS API: список и позиции ===================== */

async function fetchDemandsPage(headers, momentFrom, momentTo, offset, limit) {
    /**
     * Тянем отгрузки. expand:
     *   - agent.name, store.name, organization.name, project.name, contract.name —
     *     чтобы не делать допзапросы по каждому контрагенту/складу.
     *   - positions.assortment — позиции с резолвом ассортимента (product/bundle/variant)
     *     ВКЛЮЧАЯ родительский product у variant'ов: positions.assortment.product.
     *
     * filter: moment>= и moment<= в формате "YYYY-MM-DD HH:mm:ss" (МС принимает локальное время).
     */
    const filter = [
        'moment>=' + momentFrom,
        'moment<=' + momentTo,
    ].join(';');
    const params = new URLSearchParams();
    /**
     * expand:
     *   - agent / store / organization / project / contract — основные ссылки.
     *   - salesChannel / owner / group / state — для расширенной карточки.
     *   - rate.currency — валюта документа (имя/iso, чтобы показать «руб (RUB)»).
     *   - positions.assortment + positions.assortment.product — резолв позиций
     *     до product / variant→product / bundle.
     *
     * attributes (массив кастомных атрибутов: «Номер отправления с озона»,
     * «Идентификатор чека») приходят в payload документа БЕЗ expand — они
     * уже сериализованы в ответе entity/demand.
     */
    params.set('expand',
        'agent,store,organization,project,contract,salesChannel,owner,group,state,' +
        'rate.currency,positions.assortment,positions.assortment.product');
    params.set('filter', filter);
    params.set('order', 'moment,desc');
    params.set('limit', String(limit));
    params.set('offset', String(offset));

    const url = MS_BASE_URL + '/entity/demand?' + params.toString();
    /**
     * timeout 90s — у МС API на больших offset'ах (~40k+) одиночные ответы
     * с тяжёлым expand стабильно бывают по 30-60s. 60s регулярно вызывал
     * фоновые сбои синка (см. fetchDemandsPageResilient — там также retry).
     */
    const resp = await axios.get(url, { headers, timeout: 90000 });
    return resp && resp.data ? resp.data : { rows: [], meta: { size: 0 } };
}

/**
 * Классификация ошибки axios как «транзиентной» (повторение имеет смысл):
 *   • без HTTP-статуса (timeout, ECONNRESET, ECONNREFUSED, EAI_AGAIN, …);
 *   • статус 408 / 429 (rate-limit) / 5xx — серверные/сетевые сбои.
 * 4xx-ошибки (кроме 408/429) и 401 — фатальные (битый токен, неверный
 * запрос); ретраить нет смысла, throw поднимется выше как `last_error`.
 */
function isTransientAxiosError(err) {
    if (!err) return false;
    const status = err.response && err.response.status;
    if (!status) return true;
    if (status === 408 || status === 429) return true;
    return status >= 500 && status < 600;
}

/**
 * Резилиентная обёртка над `fetchDemandsPage`: повторяет запрос при
 * транзиентных ошибках (network/timeout, 5xx, 429). При исчерпании
 * стандартных попыток уменьшает `limit` (100 → 50 → 25), чтобы дать МС
 * API шанс отдать страницу быстрее на больших `offset`'ах (где раньше
 * стабильно ловили `timeout of 60000ms exceeded`).
 *
 * Возвращает `{ data, limit }` — фактический `limit` может отличаться от
 * запрошенного, если пришлось уменьшать страницу. Внешний цикл должен
 * использовать его (а не константу `PAGE`) для check'а «последняя ли это
 * страница»: `rows.length < usedLimit` ⇒ нет смысла продолжать.
 *
 * Если получен `jobState.cancelRequested` во время ожидания между
 * попытками — выбрасывает Error с `code === 'CANCELLED'`, чтобы внешний
 * код мог отличить отмену от настоящей ошибки и не помечать как фейл.
 *
 * Важно: ретраи здесь НЕ пишутся в `jobState.errors` (только в
 * `jobState.message` и в `console.warn`). Это сознательно — иначе одна
 * сетевая моргалка с успешным ретраем заблокирует soft-delete пасс в
 * конце синка (см. условие `jobState.errors.length === 0`).
 */
async function fetchDemandsPageResilient(headers, momentFrom, momentTo, offset, limit) {
    const STEPS = [
        { delay: 0, limit: limit },
        { delay: 2000, limit: limit },
        { delay: 5000, limit: Math.max(25, Math.floor(limit / 2)) },
        { delay: 12000, limit: Math.max(25, Math.floor(limit / 4)) },
    ];
    let lastErr = null;
    for (let i = 0; i < STEPS.length; i++) {
        if (jobState.cancelRequested) {
            const e = new Error('Остановлено пользователем');
            e.code = 'CANCELLED';
            throw e;
        }
        if (STEPS[i].delay > 0) {
            jobState.message = 'Сетевая ошибка МС API: повтор ' + (i + 1) + '/' + STEPS.length +
                ' для offset=' + offset + ' limit=' + STEPS[i].limit +
                ' через ' + Math.round(STEPS[i].delay / 1000) + ' c…';
            await new Promise((r) => setTimeout(r, STEPS[i].delay));
            if (jobState.cancelRequested) {
                const e = new Error('Остановлено пользователем');
                e.code = 'CANCELLED';
                throw e;
            }
        }
        try {
            const data = await fetchDemandsPage(headers, momentFrom, momentTo, offset, STEPS[i].limit);
            return { data, limit: STEPS[i].limit };
        } catch (e) {
            lastErr = e;
            if (!isTransientAxiosError(e)) throw e;
            console.warn('[ms-sales] retry ' + (i + 1) + '/' + STEPS.length +
                ' offset=' + offset + ' limit=' + STEPS[i].limit +
                ': ' + ((e && e.message) || 'unknown'));
        }
    }
    throw lastErr || new Error('fetchDemandsPage: исчерпаны попытки');
}

async function fetchDemandPositions(headers, demandUuid) {
    /** Fallback: если в expand-результате positions.rows не оказалось — отдельный запрос. */
    const url = MS_BASE_URL + '/entity/demand/' + encodeURIComponent(demandUuid) +
        '/positions?expand=assortment,assortment.product&limit=1000';
    const resp = await axios.get(url, { headers, timeout: 90000 });
    return resp && resp.data && Array.isArray(resp.data.rows) ? resp.data.rows : [];
}

/**
 * Резилиентная обёртка для `fetchDemandPositions`: 2 ретрая (всего 3
 * попытки) на транзиентных ошибках. В отличие от `fetchDemandsPageResilient`
 * не меняет размер выборки (это уже /positions конкретного документа,
 * там обычно мало строк).
 *
 * Ретраи логируются в `console.warn`, в `jobState.errors` не попадают —
 * единичные сбои `/positions` (≤ десятки документов из тысяч) не должны
 * блокировать soft-delete пасс.
 */
async function fetchDemandPositionsResilient(headers, demandUuid) {
    const STEPS = [0, 2000, 5000];
    let lastErr = null;
    for (let i = 0; i < STEPS.length; i++) {
        if (jobState.cancelRequested) {
            const e = new Error('Остановлено пользователем');
            e.code = 'CANCELLED';
            throw e;
        }
        if (STEPS[i] > 0) {
            await new Promise((r) => setTimeout(r, STEPS[i]));
            if (jobState.cancelRequested) {
                const e = new Error('Остановлено пользователем');
                e.code = 'CANCELLED';
                throw e;
            }
        }
        try {
            return await fetchDemandPositions(headers, demandUuid);
        } catch (e) {
            lastErr = e;
            if (!isTransientAxiosError(e)) throw e;
            console.warn('[ms-sales] positions retry ' + (i + 1) + '/' + STEPS.length +
                ' uuid=' + demandUuid + ': ' + ((e && e.message) || 'unknown'));
        }
    }
    throw lastErr || new Error('fetchDemandPositions: исчерпаны попытки');
}

/* =========================== Сохранение в БД =========================== */

/**
 * Резолв `assortment_uuid` / `product_uuid` → ms_export. Возвращает Map<uuid, { code, uuid }>.
 *
 * Ищем по `ms_export.uuid` для всех пришедших uuid сразу — один SQL на батч.
 */
async function resolveAssortmentToMsExport(db, uuids) {
    const cleaned = Array.from(new Set((uuids || []).filter(Boolean).map((u) => String(u).toLowerCase())));
    if (cleaned.length === 0) return new Map();
    const placeholders = cleaned.map(() => '?').join(',');
    const [rows] = await db.query(
        'SELECT uuid, code FROM ms_export WHERE uuid IN (' + placeholders + ')',
        cleaned,
    );
    const map = new Map();
    for (const r of rows) {
        if (r && r.uuid) map.set(String(r.uuid).toLowerCase(), { code: String(r.code || ''), uuid: String(r.uuid) });
    }
    return map;
}

async function persistDemand(db, doc) {
    const uuid = String(doc.id || '').toLowerCase();
    if (!uuid) throw new Error('Demand без id');

    const moment = parseMomentToDate(doc.moment);
    const created = parseMomentToDate(doc.created);
    const updated = parseMomentToDate(doc.updated);

    const agent = doc.agent || {};
    const store = doc.store || {};
    const organization = doc.organization || {};
    const project = doc.project || {};
    const contract = doc.contract || {};
    const owner = doc.owner || {};
    const group = doc.group || {};
    const state = doc.state || {};
    const salesChannel = doc.salesChannel || {};
    const rate = doc.rate || {};
    const currency = (rate && rate.currency) ? rate.currency : {};
    const shipFull = doc.shipmentAddressFull && typeof doc.shipmentAddressFull === 'object'
        ? doc.shipmentAddressFull
        : null;

    const agentUuid = agent && agent.id ? String(agent.id).toLowerCase() : null;
    const storeUuid = store && store.id ? String(store.id).toLowerCase() : null;
    const orgUuid = organization && organization.id ? String(organization.id).toLowerCase() : null;
    const projectUuid = project && project.id ? String(project.id).toLowerCase() : null;
    const contractUuid = contract && contract.id ? String(contract.id).toLowerCase() : null;
    const ownerUuid = owner && owner.id ? String(owner.id).toLowerCase() : null;
    const groupUuid = group && group.id ? String(group.id).toLowerCase() : null;
    const stateUuid = state && state.id ? String(state.id).toLowerCase() : null;
    const salesChannelUuid = salesChannel && salesChannel.id ? String(salesChannel.id).toLowerCase() : null;
    const currencyUuid = currency && currency.id ? String(currency.id).toLowerCase() : null;

    const sumMinor = moneyToMinor(doc.sum);
    const payedMinor = moneyToMinor(doc.payedSum);
    /** vatSum — отдельно: важно различать «не задано» и «0». */
    const vatMinor = (doc.vatSum == null) ? null : moneyToMinor(doc.vatSum);
    const positionsCount = (doc.positions && Array.isArray(doc.positions.rows))
        ? doc.positions.rows.length
        : (doc.positions && doc.positions.meta && Number.isFinite(Number(doc.positions.meta.size))
            ? Number(doc.positions.meta.size)
            : 0);

    /**
     * owner.name в МС API не приходит сразу — у employee экспандируется
     * `name`, иногда ещё доступны `firstName`/`middleName`/`lastName`.
     * Берём максимально читаемое представление.
     */
    let ownerName = '';
    if (owner) {
        const composed = [owner.lastName, owner.firstName, owner.middleName]
            .filter(Boolean)
            .map((s) => String(s).trim())
            .filter(Boolean)
            .join(' ')
            .trim();
        ownerName = composed || (owner.name ? String(owner.name) : '');
    }

    /** attributes — массив кастомных атрибутов документа.
     *  Сохраняем только лёгкое представление (id/name/type/value) — без `meta`,
     *  чтобы не раздувать JSON. */
    let attributesJson = null;
    if (Array.isArray(doc.attributes) && doc.attributes.length) {
        const lite = [];
        for (const a of doc.attributes) {
            if (!a) continue;
            let value = a.value;
            if (value && typeof value === 'object') {
                value = value.name || value.value || value.id || JSON.stringify(value);
            }
            lite.push({
                id: a.id ? String(a.id) : null,
                name: a.name ? String(a.name) : '',
                type: a.type ? String(a.type) : '',
                value: value === undefined || value === null ? '' : String(value),
            });
        }
        attributesJson = JSON.stringify(lite);
    }

    const shipFullJson = shipFull ? JSON.stringify(shipFull) : null;

    /** payload_json — весь raw документ, минус `positions` (они в ms_demand_position).
     *  Поможет позже добавлять новые поля без обращения в МС API. */
    let payloadJson = null;
    try {
        const payload = Object.assign({}, doc);
        delete payload.positions;
        payloadJson = JSON.stringify(payload);
    } catch (_e) {
        payloadJson = null;
    }

    await db.query(
        `INSERT INTO ms_demand (
            uuid, doc_name, moment, applicable,
            agent_uuid, agent_name, store_uuid, store_name,
            organization_uuid, organization_name, project_uuid, project_name,
            contract_uuid, contract_name,
            sum_minor, positions_count, description, ms_created, ms_updated,
            state_uuid, state_name, owner_uuid, owner_name,
            group_uuid, group_name, sales_channel_uuid, sales_channel_name,
            shipment_address, shipment_address_full,
            currency_uuid, currency_name, currency_iso_code, currency_rate,
            vat_enabled, vat_included, vat_sum_minor, payed_sum_minor,
            external_code, sync_id, code, printed, published, attributes_json, payload_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                  ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
            doc_name = VALUES(doc_name),
            moment = VALUES(moment),
            applicable = VALUES(applicable),
            agent_uuid = VALUES(agent_uuid),
            agent_name = VALUES(agent_name),
            store_uuid = VALUES(store_uuid),
            store_name = VALUES(store_name),
            organization_uuid = VALUES(organization_uuid),
            organization_name = VALUES(organization_name),
            project_uuid = VALUES(project_uuid),
            project_name = VALUES(project_name),
            contract_uuid = VALUES(contract_uuid),
            contract_name = VALUES(contract_name),
            sum_minor = VALUES(sum_minor),
            positions_count = VALUES(positions_count),
            description = VALUES(description),
            ms_created = VALUES(ms_created),
            ms_updated = VALUES(ms_updated),
            state_uuid = VALUES(state_uuid),
            state_name = VALUES(state_name),
            owner_uuid = VALUES(owner_uuid),
            owner_name = VALUES(owner_name),
            group_uuid = VALUES(group_uuid),
            group_name = VALUES(group_name),
            sales_channel_uuid = VALUES(sales_channel_uuid),
            sales_channel_name = VALUES(sales_channel_name),
            shipment_address = VALUES(shipment_address),
            shipment_address_full = VALUES(shipment_address_full),
            currency_uuid = VALUES(currency_uuid),
            currency_name = VALUES(currency_name),
            currency_iso_code = VALUES(currency_iso_code),
            currency_rate = VALUES(currency_rate),
            vat_enabled = VALUES(vat_enabled),
            vat_included = VALUES(vat_included),
            vat_sum_minor = VALUES(vat_sum_minor),
            payed_sum_minor = VALUES(payed_sum_minor),
            external_code = VALUES(external_code),
            sync_id = VALUES(sync_id),
            code = VALUES(code),
            printed = VALUES(printed),
            published = VALUES(published),
            attributes_json = VALUES(attributes_json),
            payload_json = VALUES(payload_json),
            deleted_at = NULL`,
        [
            uuid,
            String(doc.name || '').slice(0, 64),
            moment || new Date(),
            doc.applicable === false ? 0 : 1,
            agentUuid, agent && agent.name ? String(agent.name).slice(0, 255) : null,
            storeUuid, store && store.name ? String(store.name).slice(0, 150) : null,
            orgUuid, organization && organization.name ? String(organization.name).slice(0, 150) : null,
            projectUuid, project && project.name ? String(project.name).slice(0, 150) : null,
            contractUuid, contract && contract.name ? String(contract.name).slice(0, 150) : null,
            sumMinor, positionsCount,
            doc.description ? String(doc.description) : null,
            created, updated,
            stateUuid, state && state.name ? String(state.name).slice(0, 150) : null,
            ownerUuid, ownerName ? String(ownerName).slice(0, 150) : null,
            groupUuid, group && group.name ? String(group.name).slice(0, 150) : null,
            salesChannelUuid, salesChannel && salesChannel.name ? String(salesChannel.name).slice(0, 150) : null,
            doc.shipmentAddress ? String(doc.shipmentAddress) : null,
            shipFullJson,
            currencyUuid,
            currency && currency.name ? String(currency.name).slice(0, 20) : null,
            currency && currency.isoCode ? String(currency.isoCode).slice(0, 8) : null,
            (rate && Number.isFinite(Number(rate.value))) ? Number(rate.value) : null,
            doc.vatEnabled === true ? 1 : (doc.vatEnabled === false ? 0 : null),
            doc.vatIncluded === true ? 1 : (doc.vatIncluded === false ? 0 : null),
            vatMinor,
            payedMinor,
            doc.externalCode ? String(doc.externalCode).slice(0, 64) : null,
            doc.syncId ? String(doc.syncId).slice(0, 64) : null,
            doc.code ? String(doc.code).slice(0, 64) : null,
            doc.printed === true ? 1 : 0,
            doc.published === true ? 1 : 0,
            attributesJson,
            payloadJson,
        ],
    );

    return uuid;
}

async function persistPositions(db, demandUuid, positions, resolvedMap) {
    if (!Array.isArray(positions) || positions.length === 0) {
        await db.query('DELETE FROM ms_demand_position WHERE demand_uuid = ?', [demandUuid]);
        return { saved: 0, resolved: 0, unresolved: 0 };
    }

    /** Удаляем старые позиции этого документа и вставляем заново — проще, чем UPSERT
     *  на изменчивых вложенных массивах. UNIQUE-ключ на (demand_uuid, position_uuid)
     *  всё равно даст защиту от дублей при гонках. */
    await db.query('DELETE FROM ms_demand_position WHERE demand_uuid = ?', [demandUuid]);

    const insertRows = [];
    let resolvedCount = 0;
    let unresolvedCount = 0;

    for (let i = 0; i < positions.length; i++) {
        const p = positions[i] || {};
        const positionUuid = String(p.id || '').toLowerCase();
        if (!positionUuid) continue;

        const assortment = p.assortment || {};
        const href = (assortment.meta && assortment.meta.href) ? String(assortment.meta.href) : '';
        const parsed = parseAssortmentHref(href);

        let productUuid = null;
        if (parsed.kind === 'variant' && assortment.product && assortment.product.meta) {
            const pp = parseAssortmentHref(String(assortment.product.meta.href || ''));
            if (pp.kind === 'product' && pp.uuid) productUuid = pp.uuid;
        }

        /** Для product / bundle резолв напрямую по assortment.uuid;
         *  для variant — пытаемся через product_uuid (variant'ов в ms_export нет). */
        let resolvedCode = null;
        let resolvedUuid = null;
        let isResolved = 0;
        const tryUuids = [];
        if (parsed.uuid) tryUuids.push(parsed.uuid);
        if (productUuid && productUuid !== parsed.uuid) tryUuids.push(productUuid);
        for (const u of tryUuids) {
            const hit = resolvedMap.get(u);
            if (hit) {
                resolvedCode = hit.code;
                resolvedUuid = hit.uuid;
                isResolved = 1;
                break;
            }
        }
        if (isResolved) resolvedCount++;
        else unresolvedCount++;

        const nameAtMoment = String(assortment.name || p.name || '').slice(0, 500);
        const codeAtMoment = assortment.code ? String(assortment.code).slice(0, 64) : null;
        const quantity = Number(p.quantity || 0);
        const priceMinor = moneyToMinor(p.price);
        const discount = Number(p.discount || 0);
        const vat = Math.round(Number(p.vat || 0));
        const sumOnePosMinor = Math.round(priceMinor * quantity * (1 - Math.min(100, Math.max(0, discount)) / 100));

        insertRows.push([
            demandUuid, positionUuid, i,
            parsed.kind, parsed.uuid, productUuid,
            resolvedCode, resolvedUuid, isResolved,
            nameAtMoment, codeAtMoment,
            quantity, priceMinor, discount, vat, sumOnePosMinor,
        ]);
    }

    if (insertRows.length === 0) {
        return { saved: 0, resolved: 0, unresolved: 0 };
    }

    /** Bulk insert: разбиваем на батчи по 500 строк (16 столбцов × 500 = 8000 плейсхолдеров,
     *  безопасно ниже max_allowed_packet и max_prepared_stmt_count). */
    const COLS = 16;
    const BATCH = 500;
    for (let off = 0; off < insertRows.length; off += BATCH) {
        const slice = insertRows.slice(off, off + BATCH);
        const placeholders = slice
            .map(() => '(' + Array(COLS).fill('?').join(',') + ')')
            .join(',');
        const flat = [];
        slice.forEach((r) => flat.push.apply(flat, r));
        await db.query(
            `INSERT INTO ms_demand_position
                (demand_uuid, position_uuid, pack_idx,
                 assortment_kind, assortment_uuid, product_uuid,
                 ms_export_code, ms_export_uuid, ms_export_resolved,
                 name_at_moment, code_at_moment,
                 quantity, price_minor, discount, vat, sum_minor)
             VALUES ${placeholders}`,
            flat,
        );
    }

    return { saved: insertRows.length, resolved: resolvedCount, unresolved: unresolvedCount };
}

/* =========================== Главная функция синка ========================== */

async function runDemandSync(db, days, options = {}) {
    const headers = getMsHeaders();
    if (!headers) {
        const e = new Error('MS_TOKEN не задан (env MS_TOKEN или config.msToken)');
        e.code = 'NO_TOKEN';
        throw e;
    }
    const fresh = options && options.fresh === true;
    const now = new Date();
    const from = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
    const fmt = (d) => {
        const pad = (n) => String(n).padStart(2, '0');
        return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' +
            pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
    };
    const momentFrom = fmt(from);
    let momentTo = fmt(now);
    /**
     * Полный `momentTo` от NOW() — нужен для soft-delete пасса и для снимка
     * `previouslyDeleted` (мы всё ещё работаем над тем же логическим окном
     * периода). Не подменяем его на resume‑узкое окно.
     */
    const momentToFull = momentTo;

    /**
     * Auto-resume: если в БД уже есть отгрузки за это окно периода, и
     * самая старая из них (`minMoment`) ощутимо позже, чем `momentFrom`
     * — значит прошлый прогон не успел добить хвост. Сужаем `momentTo`
     * до `minMoment + 5 минут запаса` и идём только за хвостом. UPSERT по
     * uuid защищает пограничные документы от дублей.
     *
     * Триггер «есть пробел»: `minMoment > momentFrom + 5 минут` (5 минут
     * — тот же запас, что и в `resume_from_moment`; меньшая разница
     * означает «мы фактически дошли до начала периода» — полный синк).
     *
     * Отключается флагом `fresh = true` (отдельная кнопка «Полный синк
     * с нуля» в UI).
     */
    if (!fresh) {
        try {
            const [stat] = await db.query(
                `SELECT COUNT(*) AS cnt, MIN(moment) AS minM
                   FROM ms_demand
                  WHERE moment BETWEEN ? AND ?
                    AND deleted_at IS NULL`,
                [momentFrom, momentToFull],
            );
            const stRow = (stat && stat[0]) || {};
            const cnt = Number(stRow.cnt || 0);
            const minM = stRow.minM ? new Date(stRow.minM) : null;
            jobState.existing_count_at_start = cnt;
            if (cnt > 0 && minM && !Number.isNaN(minM.getTime())) {
                const minMomentMs = minM.getTime();
                const fromMs = from.getTime();
                /** 5 минут зазора в обе стороны — порог «есть пробел». */
                const GAP_THRESHOLD_MS = 5 * 60 * 1000;
                if (minMomentMs - fromMs > GAP_THRESHOLD_MS) {
                    /** Запас 5 минут вверх по moment, чтобы пересеклось с
                     *  пограничными документами и UPSERT их освежил. */
                    const resumeBoundary = new Date(minMomentMs + GAP_THRESHOLD_MS);
                    momentTo = fmt(resumeBoundary);
                    jobState.resume_mode = true;
                    jobState.resume_from_moment = momentTo;
                    jobState.message =
                        'Resume: продолжаем добивать хвост периода. Уже синкнуто ' + cnt +
                        ' отгрузок (самая старая — ' + fmt(minM) + '). Тянем ' +
                        momentFrom + ' — ' + momentTo + '.';
                }
            }
        } catch (e) {
            console.warn('[ms-sales] resume-probe failed:', e && e.message);
        }
    }

    if (!jobState.resume_mode) {
        jobState.message = 'Запрашиваем отгрузки за ' + momentFrom + ' — ' + momentTo;
    }

    /**
     * Снимок «ранее помеченных удалёнными» — берём по ПОЛНОМУ окну
     * `[momentFrom, momentToFull]`, а не по resume-узкому, чтобы
     * «воскрешения» из свежей части тоже учитывались, если случился
     * полный прогон.
     */
    const previouslyDeleted = new Set();
    try {
        const [rows] = await db.query(
            `SELECT uuid FROM ms_demand
              WHERE deleted_at IS NOT NULL
                AND moment BETWEEN ? AND ?`,
            [momentFrom, momentToFull],
        );
        for (const r of rows) previouslyDeleted.add(String(r.uuid).toLowerCase());
    } catch (_e) { /* not fatal */ }

    /** UUID документов, которые мы реально получили из МС в этом проходе. */
    const seenUuids = new Set();

    const PAGE = 100;
    let offset = 0;
    let totalSize = null;
    /**
     * Флаг «синк прерван транзиентной ошибкой» — выставляется внешним
     * catch для пагинационного цикла, когда `fetchDemandsPageResilient`
     * исчерпала все retry-попытки. Используется ниже, чтобы пропустить
     * soft-delete пасс (мы не получили полную картину периода) и оставить
     * `last_error` пользователю.
     */
    let abortedOnNetwork = false;

    while (true) {
        if (jobState.cancelRequested) {
            jobState.message = 'Остановлено пользователем';
            break;
        }
        let page;
        let usedLimit = PAGE;
        try {
            const result = await fetchDemandsPageResilient(headers, momentFrom, momentTo, offset, PAGE);
            page = result.data;
            usedLimit = result.limit;
        } catch (e) {
            if (e && e.code === 'CANCELLED') {
                jobState.message = 'Остановлено пользователем';
                break;
            }
            const status = e && e.response && e.response.status;
            const msErr = e && e.response && e.response.data
                && Array.isArray(e.response.data.errors) && e.response.data.errors[0]
                && (e.response.data.errors[0].error || e.response.data.errors[0].message);
            const msg = 'MS API ' + (status || 'NETWORK') + ': ' + (msErr || (e && e.message) || 'unknown');
            logJobError(msg);
            /**
             * Не делаем throw: мягко выходим из цикла, чтобы вызывающий
             * `.then` корректно подвёл итог («Прервано на ошибке…»).
             * Уже сохранённые отгрузки и позиции остаются в БД — повторный
             * запуск синка идемпотентен (UPSERT по uuid + тот же период),
             * подхватит ровно с того места.
             */
            jobState.message = 'Прервано на отгрузке ' + jobState.fetched_demands + '/' +
                (jobState.total_demands || '?') + ' (offset=' + offset + '): ' + msg;
            abortedOnNetwork = true;
            break;
        }
        const rows = Array.isArray(page.rows) ? page.rows : [];
        if (totalSize === null) {
            totalSize = page.meta && Number.isFinite(Number(page.meta.size)) ? Number(page.meta.size) : rows.length;
            jobState.total_demands = totalSize;
        }
        if (rows.length === 0) break;

        /** На батче 100 документов сначала собираем все уникальные uuid ассортимента,
         *  делаем один резолв по ms_export — потом сохраняем. */
        const assortmentUuids = [];
        for (const doc of rows) {
            const positions = (doc.positions && Array.isArray(doc.positions.rows)) ? doc.positions.rows : [];
            for (const p of positions) {
                const a = p && p.assortment;
                if (a && a.meta && a.meta.href) {
                    const parsed = parseAssortmentHref(a.meta.href);
                    if (parsed.uuid) assortmentUuids.push(parsed.uuid);
                }
                if (a && a.product && a.product.meta && a.product.meta.href) {
                    const pp = parseAssortmentHref(a.product.meta.href);
                    if (pp.uuid) assortmentUuids.push(pp.uuid);
                }
            }
        }
        const resolvedMap = await resolveAssortmentToMsExport(db, assortmentUuids);

        for (const doc of rows) {
            if (jobState.cancelRequested) break;
            try {
                const demandUuid = await persistDemand(db, doc);
                let positions = (doc.positions && Array.isArray(doc.positions.rows)) ? doc.positions.rows : null;
                /** Если expand не подтянул rows — догружаем отдельным запросом. */
                if (!positions || positions.length === 0) {
                    const positionsMetaSize = doc.positions && doc.positions.meta
                        ? Number(doc.positions.meta.size || 0) : 0;
                    if (positionsMetaSize > 0) {
                        try {
                            positions = await fetchDemandPositionsResilient(headers, demandUuid);
                            /** Догружаем резолв для новых позиций, если в карте их ещё нет. */
                            const extra = [];
                            for (const p of positions) {
                                const a = p && p.assortment;
                                if (a && a.meta && a.meta.href) {
                                    const parsed = parseAssortmentHref(a.meta.href);
                                    if (parsed.uuid && !resolvedMap.has(parsed.uuid)) extra.push(parsed.uuid);
                                }
                                if (a && a.product && a.product.meta && a.product.meta.href) {
                                    const pp = parseAssortmentHref(a.product.meta.href);
                                    if (pp.uuid && !resolvedMap.has(pp.uuid)) extra.push(pp.uuid);
                                }
                            }
                            if (extra.length) {
                                const extraMap = await resolveAssortmentToMsExport(db, extra);
                                for (const [k, v] of extraMap) resolvedMap.set(k, v);
                            }
                        } catch (e) {
                            logJobError('positions ' + demandUuid + ': ' + ((e && e.message) || 'err'));
                            positions = [];
                        }
                    } else {
                        positions = [];
                    }
                }
                const r = await persistPositions(db, demandUuid, positions, resolvedMap);
                jobState.saved_positions += r.saved;
                jobState.resolved_positions += r.resolved;
                jobState.unresolved_positions += r.unresolved;
                seenUuids.add(demandUuid);
            } catch (e) {
                logJobError('demand ' + (doc && doc.id) + ': ' + ((e && e.message) || 'err'));
            }
            jobState.fetched_demands++;
            jobState.message =
                'Отгрузки: ' + jobState.fetched_demands + '/' + jobState.total_demands +
                '; позиций: ' + jobState.saved_positions +
                ' (резолв: ' + jobState.resolved_positions + ', не привязано: ' + jobState.unresolved_positions + ')';
        }

        offset += rows.length;
        if (totalSize != null && offset >= totalSize) break;
        /**
         * Лимит мог быть уменьшен retry-логикой (см. fetchDemandsPageResilient).
         * Сравниваем с `usedLimit`, а не с константой `PAGE`, иначе при
         * fallback на limit=50 мы бы ошибочно посчитали страницу последней.
         */
        if (rows.length < usedLimit) break;

        /** Дроссель 250 мс — у МС API лимит ~5 RPS на токен. */
        await new Promise((r) => setTimeout(r, 250));
    }

    /**
     * Soft-delete: если синк прошёл до конца без отмены и без фатальных
     * ошибок батчей — для документов в окне `momentFrom..momentToFull`,
     * которых нет в `seenUuids`, ставим `deleted_at = NOW()`.
     *
     * Защита от ложных удалений: пропускаем шаг, если
     *   • был cancel;
     *   • `seenUuids` пуст (вообще ничего не пришло — скорее всего сеть);
     *   • есть фатальные ошибки батчей (`errors > 0`);
     *   • это resume-режим (`resume_mode === true`) — в этом проходе мы
     *     видим только хвост, свежую часть периода не запрашивали; если
     *     пометить «не виденных» удалёнными, мы ошибочно сотрём в МС всё
     *     свежее, что лежит в БД с прошлого прогона.
     *
     * Локальные ошибки конкретных документов не учитываем — они уже
     * приведут к разнице в seenUuids естественным образом.
     */
    if (!jobState.cancelRequested &&
        !jobState.resume_mode &&
        jobState.errors.length === 0 &&
        seenUuids.size > 0) {
        let conn = null;
        try {
            jobState.message = 'Сверка удалённых отгрузок…';
            /**
             * TEMPORARY TABLE действительна только в рамках одного соединения,
             * поэтому захватываем его из пула отдельно — иначе INSERT/UPDATE
             * могут прийти на разные коннекты пула и таблица будет «не видна».
             */
            conn = await db.getConnection();
            await conn.query('CREATE TEMPORARY TABLE _ms_seen (uuid VARCHAR(36) PRIMARY KEY) ENGINE=Memory');
            const uuids = Array.from(seenUuids);
            const BATCH = 1000;
            for (let i = 0; i < uuids.length; i += BATCH) {
                const slice = uuids.slice(i, i + BATCH);
                const placeholders = slice.map(() => '(?)').join(',');
                await conn.query('INSERT IGNORE INTO _ms_seen (uuid) VALUES ' + placeholders, slice);
            }
            const [delResult] = await conn.query(
                `UPDATE ms_demand d
            LEFT JOIN _ms_seen s ON s.uuid = d.uuid
                   SET d.deleted_at = NOW()
                 WHERE d.moment BETWEEN ? AND ?
                   AND s.uuid IS NULL
                   AND d.deleted_at IS NULL`,
                [momentFrom, momentToFull],
            );
            jobState.deleted_demands = delResult && delResult.affectedRows ? delResult.affectedRows : 0;
            try { await conn.query('DROP TEMPORARY TABLE IF EXISTS _ms_seen'); } catch (_e) { /* ignore */ }

            /** «Воскрешённые» = пересечение seenUuids с снапшотом до синка. */
            let restored = 0;
            for (const u of seenUuids) if (previouslyDeleted.has(u)) restored++;
            jobState.restored_demands = restored;
        } catch (e) {
            logJobError('soft-delete pass: ' + ((e && e.message) || 'err'));
        } finally {
            if (conn) { try { conn.release(); } catch (_e) { /* ignore */ } }
        }
    }

    return jobStateToPayload();
}

/* =========================== Express router =========================== */

function createMsSalesRouter(db, appSettings = {}) {
    const router = express.Router();
    ensureSchema(db).catch((e) => {
        console.error('[ms-sales] ensureSchema:', e && e.message);
    });

    /** GET /api/ms-sales/list — список отгрузок. */
    router.get('/list', async (req, res) => {
        try {
            await ensureSchema(db);
            const limit = clampInt(req.query.limit, 1, 500, 100);
            const offset = clampInt(req.query.offset, 0, 5_000_000, 0);
            const days = clampInt(req.query.days, 1, 365 * 5, 30);
            const search = String(req.query.search || '').trim();
            const docName = String(req.query.doc_name || '').trim();
            const storeUuid = String(req.query.store_uuid || '').trim();
            const agentUuid = String(req.query.agent_uuid || '').trim();
            const projectUuid = String(req.query.project_uuid || '').trim();
            const applicable = String(req.query.applicable || '').trim();
            /**
             * deleted: '0' (default) — только активные (не помечены удалёнными);
             *          '1' — только удалённые в МС; 'all' — все вместе.
             */
            const deleted = String(req.query.deleted || '0').trim();
            /**
             * linked: 'all' (default) — без фильтра по привязке позиций;
             *        '1'  — только отгрузки, в которых ВСЕ позиции привязаны
             *               к ms_export (нет ни одной p.ms_export_resolved=0);
             *        '0'  — только отгрузки, в которых ЕСТЬ хотя бы одна
             *               не привязанная позиция (бейдж «не привязано» в UI).
             *
             * Реализация через EXISTS / NOT EXISTS, чтобы не дублировать
             * строки документов и не ломать пагинацию (см. умный поиск выше).
             * Опирается на индекс idx_resolved (ms_demand_position.ms_export_resolved).
             */
            const linked = String(req.query.linked || 'all').trim();
            const sortBy = String(req.query.sort_by || 'moment');
            const sortDir = String(req.query.sort_dir || 'desc').toLowerCase() === 'asc' ? 'ASC' : 'DESC';

            const sortMap = {
                moment: 'd.moment',
                doc_name: 'd.doc_name',
                agent: 'd.agent_name',
                store: 'd.store_name',
                positions_count: 'd.positions_count',
                sum: 'd.sum_minor',
            };
            const sortField = sortMap[sortBy] || sortMap.moment;

            const wheres = ['d.moment >= (NOW() - INTERVAL ? DAY)'];
            const params = [days];
            if (search) {
                /**
                 * Умный поиск по товарам в позициях отгрузки: код (резолвленный
                 * `ms_export_code` или срез `code_at_moment` на момент продажи),
                 * наименование (срез `name_at_moment` или актуальное `ms_export.name`).
                 *
                 * EXISTS вместо JOIN — чтобы COUNT(*) и список оставались по
                 * документам без дублирования и не ломали пагинацию.
                 * Производительность: индексы `idx_demand` и `idx_ms_export_code`
                 * на `ms_demand_position` уже есть; LIKE по name_at_moment —
                 * full-scan позиций конкретного документа (≤ нескольких десятков
                 * строк), поэтому в рамках текущих объёмов приемлемо.
                 */
                wheres.push(
                    'EXISTS (SELECT 1 FROM ms_demand_position p ' +
                    'LEFT JOIN ms_export e ON e.code = p.ms_export_code ' +
                    'WHERE p.demand_uuid = d.uuid AND (' +
                    'p.ms_export_code LIKE ? OR p.code_at_moment LIKE ? ' +
                    'OR p.name_at_moment LIKE ? OR e.name LIKE ?))'
                );
                const needle = '%' + search + '%';
                params.push(needle, needle, needle, needle);
            }
            if (docName) {
                /**
                 * Фильтр по номеру документа: точное `=` если строка похожа на
                 * полный номер (без `%` / `_`), иначе LIKE-подстрока. Так и
                 * пользователь может вбить «00012» и получить точное попадание,
                 * и «0001» как префикс/подстроку — без отдельного UI-переключателя.
                 */
                if (/[%_]/.test(docName)) {
                    wheres.push('d.doc_name LIKE ?');
                    params.push(docName);
                } else {
                    wheres.push('d.doc_name LIKE ?');
                    params.push('%' + docName + '%');
                }
            }
            if (storeUuid) { wheres.push('d.store_uuid = ?'); params.push(storeUuid.toLowerCase()); }
            if (agentUuid) { wheres.push('d.agent_uuid = ?'); params.push(agentUuid.toLowerCase()); }
            if (projectUuid) { wheres.push('d.project_uuid = ?'); params.push(projectUuid.toLowerCase()); }
            if (applicable === '1') wheres.push('d.applicable = 1');
            else if (applicable === '0') wheres.push('d.applicable = 0');
            if (deleted === '1') wheres.push('d.deleted_at IS NOT NULL');
            else if (deleted !== 'all') wheres.push('d.deleted_at IS NULL');

            if (linked === '0') {
                wheres.push(
                    'EXISTS (SELECT 1 FROM ms_demand_position p ' +
                    'WHERE p.demand_uuid = d.uuid AND p.ms_export_resolved = 0)'
                );
            } else if (linked === '1') {
                wheres.push(
                    'NOT EXISTS (SELECT 1 FROM ms_demand_position p ' +
                    'WHERE p.demand_uuid = d.uuid AND p.ms_export_resolved = 0)'
                );
            }

            const whereSql = ' WHERE ' + wheres.join(' AND ');

            const [rows] = await db.query(
                `SELECT d.uuid, d.doc_name, d.moment, d.applicable,
                        d.agent_uuid, d.agent_name, d.store_uuid, d.store_name,
                        d.organization_name, d.project_uuid, d.project_name,
                        d.positions_count, d.sum_minor,
                        d.fetched_at, d.deleted_at
                   FROM ms_demand d
                   ${whereSql}
                   ORDER BY ${sortField} ${sortDir}, d.uuid ASC
                   LIMIT ? OFFSET ?`,
                params.concat([limit, offset]),
            );
            const [cnt] = await db.query(
                'SELECT COUNT(*) AS total FROM ms_demand d ' + whereSql,
                params,
            );

            res.json({
                success: true,
                total: Number((cnt && cnt[0] && cnt[0].total) || 0),
                limit, offset, days,
                rows: (rows || []).map((r) => ({
                    uuid: String(r.uuid),
                    doc_name: String(r.doc_name || ''),
                    moment: r.moment ? new Date(r.moment).toISOString() : null,
                    applicable: !!r.applicable,
                    agent_uuid: r.agent_uuid ? String(r.agent_uuid) : '',
                    agent_name: r.agent_name ? String(r.agent_name) : '',
                    store_uuid: r.store_uuid ? String(r.store_uuid) : '',
                    store_name: r.store_name ? String(r.store_name) : '',
                    organization_name: r.organization_name ? String(r.organization_name) : '',
                    project_uuid: r.project_uuid ? String(r.project_uuid) : '',
                    project_name: r.project_name ? String(r.project_name) : '',
                    positions_count: Number(r.positions_count || 0),
                    sum: Number(r.sum_minor || 0) / 100,
                    fetched_at: r.fetched_at ? new Date(r.fetched_at).toISOString() : null,
                    deleted_at: r.deleted_at ? new Date(r.deleted_at).toISOString() : null,
                })),
            });
        } catch (e) {
            console.error('[ms-sales] /list:', e);
            res.status(500).json({ success: false, error: e && e.message ? e.message : 'Ошибка списка' });
        }
    });

    /** GET /api/ms-sales/filters — справочники для UI: склады/контрагенты за период. */
    router.get('/filters', async (req, res) => {
        try {
            await ensureSchema(db);
            const days = clampInt(req.query.days, 1, 365 * 5, 30);
            const [stores] = await db.query(
                `SELECT store_uuid AS uuid, store_name AS name, COUNT(*) AS cnt
                   FROM ms_demand
                  WHERE moment >= (NOW() - INTERVAL ? DAY) AND store_uuid IS NOT NULL
                  GROUP BY store_uuid, store_name
                  ORDER BY name`,
                [days],
            );
            const [agents] = await db.query(
                `SELECT agent_uuid AS uuid, agent_name AS name, COUNT(*) AS cnt
                   FROM ms_demand
                  WHERE moment >= (NOW() - INTERVAL ? DAY) AND agent_uuid IS NOT NULL
                  GROUP BY agent_uuid, agent_name
                  ORDER BY cnt DESC, name
                  LIMIT 500`,
                [days],
            );
            const [projects] = await db.query(
                `SELECT project_uuid AS uuid, project_name AS name, COUNT(*) AS cnt
                   FROM ms_demand
                  WHERE moment >= (NOW() - INTERVAL ? DAY) AND project_uuid IS NOT NULL
                  GROUP BY project_uuid, project_name
                  ORDER BY cnt DESC, name`,
                [days],
            );
            res.json({
                success: true,
                stores: stores.map((r) => ({ uuid: String(r.uuid), name: String(r.name || ''), count: Number(r.cnt || 0) })),
                agents: agents.map((r) => ({ uuid: String(r.uuid), name: String(r.name || ''), count: Number(r.cnt || 0) })),
                projects: projects.map((r) => ({ uuid: String(r.uuid), name: String(r.name || ''), count: Number(r.cnt || 0) })),
            });
        } catch (e) {
            res.status(500).json({ success: false, error: e && e.message ? e.message : 'Ошибка' });
        }
    });

    /** GET /api/ms-sales/:uuid/positions — позиции одной отгрузки, с резолвом до товаров. */
    router.get('/:uuid/positions', async (req, res) => {
        try {
            await ensureSchema(db);
            const uuid = String(req.params.uuid || '').toLowerCase();
            if (!uuid) return res.status(400).json({ success: false, error: 'Не указан uuid' });

            const [docRows] = await db.query(
                `SELECT uuid, doc_name, moment, applicable,
                        agent_uuid, agent_name, store_uuid, store_name,
                        organization_uuid, organization_name,
                        project_uuid, project_name, contract_uuid, contract_name,
                        positions_count, sum_minor, description, ms_created, ms_updated,
                        state_uuid, state_name, owner_uuid, owner_name,
                        group_uuid, group_name, sales_channel_uuid, sales_channel_name,
                        shipment_address, shipment_address_full,
                        currency_uuid, currency_name, currency_iso_code, currency_rate,
                        vat_enabled, vat_included, vat_sum_minor, payed_sum_minor,
                        external_code, sync_id, code, printed, published, attributes_json,
                        deleted_at
                   FROM ms_demand WHERE uuid = ?`,
                [uuid],
            );
            const doc = (Array.isArray(docRows) && docRows[0]) || null;
            if (!doc) return res.status(404).json({ success: false, error: 'Отгрузка не найдена' });

            /** JSON-колонки в mysql2 могут вернуться уже распарсенными или строкой —
             *  нормализуем оба случая. */
            const parseJsonSafe = (val) => {
                if (val == null) return null;
                if (typeof val === 'object') return val;
                try { return JSON.parse(String(val)); } catch (_e) { return null; }
            };
            const shipFull = parseJsonSafe(doc.shipment_address_full);
            const attrs = parseJsonSafe(doc.attributes_json) || [];

            const [posRows] = await db.query(
                `SELECT p.position_uuid, p.pack_idx, p.assortment_kind, p.assortment_uuid,
                        p.product_uuid, p.ms_export_code, p.ms_export_uuid, p.ms_export_resolved,
                        p.name_at_moment, p.code_at_moment,
                        p.quantity, p.price_minor, p.discount, p.vat, p.sum_minor,
                        e.name AS ms_export_name, e.type AS ms_export_type,
                        e.stock AS ms_export_stock, e.is_archived AS ms_export_archived
                   FROM ms_demand_position p
                   LEFT JOIN ms_export e ON e.code = p.ms_export_code
                  WHERE p.demand_uuid = ?
                  ORDER BY p.pack_idx ASC, p.id ASC`,
                [uuid],
            );

            res.json({
                success: true,
                demand: {
                    uuid: String(doc.uuid),
                    doc_name: String(doc.doc_name || ''),
                    moment: doc.moment ? new Date(doc.moment).toISOString() : null,
                    applicable: !!doc.applicable,
                    agent_uuid: doc.agent_uuid ? String(doc.agent_uuid) : '',
                    agent_name: doc.agent_name ? String(doc.agent_name) : '',
                    store_uuid: doc.store_uuid ? String(doc.store_uuid) : '',
                    store_name: doc.store_name ? String(doc.store_name) : '',
                    organization_uuid: doc.organization_uuid ? String(doc.organization_uuid) : '',
                    organization_name: doc.organization_name ? String(doc.organization_name) : '',
                    project_uuid: doc.project_uuid ? String(doc.project_uuid) : '',
                    project_name: doc.project_name ? String(doc.project_name) : '',
                    contract_uuid: doc.contract_uuid ? String(doc.contract_uuid) : '',
                    contract_name: doc.contract_name ? String(doc.contract_name) : '',
                    positions_count: Number(doc.positions_count || 0),
                    sum: Number(doc.sum_minor || 0) / 100,
                    description: doc.description ? String(doc.description) : '',
                    ms_created: doc.ms_created ? new Date(doc.ms_created).toISOString() : null,
                    ms_updated: doc.ms_updated ? new Date(doc.ms_updated).toISOString() : null,
                    state_uuid: doc.state_uuid ? String(doc.state_uuid) : '',
                    state_name: doc.state_name ? String(doc.state_name) : '',
                    owner_uuid: doc.owner_uuid ? String(doc.owner_uuid) : '',
                    owner_name: doc.owner_name ? String(doc.owner_name) : '',
                    group_uuid: doc.group_uuid ? String(doc.group_uuid) : '',
                    group_name: doc.group_name ? String(doc.group_name) : '',
                    sales_channel_uuid: doc.sales_channel_uuid ? String(doc.sales_channel_uuid) : '',
                    sales_channel_name: doc.sales_channel_name ? String(doc.sales_channel_name) : '',
                    shipment_address: doc.shipment_address ? String(doc.shipment_address) : '',
                    shipment_address_full: shipFull,
                    currency_uuid: doc.currency_uuid ? String(doc.currency_uuid) : '',
                    currency_name: doc.currency_name ? String(doc.currency_name) : '',
                    currency_iso_code: doc.currency_iso_code ? String(doc.currency_iso_code) : '',
                    currency_rate: doc.currency_rate != null ? Number(doc.currency_rate) : null,
                    vat_enabled: doc.vat_enabled === null ? null : !!doc.vat_enabled,
                    vat_included: doc.vat_included === null ? null : !!doc.vat_included,
                    vat_sum: doc.vat_sum_minor != null ? Number(doc.vat_sum_minor) / 100 : null,
                    payed_sum: doc.payed_sum_minor != null ? Number(doc.payed_sum_minor) / 100 : 0,
                    external_code: doc.external_code ? String(doc.external_code) : '',
                    sync_id: doc.sync_id ? String(doc.sync_id) : '',
                    code: doc.code ? String(doc.code) : '',
                    printed: !!doc.printed,
                    published: !!doc.published,
                    attributes: Array.isArray(attrs) ? attrs : [],
                    deleted_at: doc.deleted_at ? new Date(doc.deleted_at).toISOString() : null,
                },
                rows: (posRows || []).map((r) => ({
                    position_uuid: String(r.position_uuid),
                    pack_idx: Number(r.pack_idx || 0),
                    assortment_kind: String(r.assortment_kind || ''),
                    assortment_uuid: r.assortment_uuid ? String(r.assortment_uuid) : '',
                    product_uuid: r.product_uuid ? String(r.product_uuid) : '',
                    ms_export_code: r.ms_export_code ? String(r.ms_export_code) : '',
                    ms_export_uuid: r.ms_export_uuid ? String(r.ms_export_uuid) : '',
                    ms_export_resolved: !!r.ms_export_resolved,
                    ms_export_name: r.ms_export_name ? String(r.ms_export_name) : '',
                    ms_export_type: r.ms_export_type ? String(r.ms_export_type) : '',
                    ms_export_stock: r.ms_export_stock != null ? Number(r.ms_export_stock) : null,
                    ms_export_archived: !!r.ms_export_archived,
                    name_at_moment: String(r.name_at_moment || ''),
                    code_at_moment: r.code_at_moment ? String(r.code_at_moment) : '',
                    quantity: Number(r.quantity || 0),
                    price: Number(r.price_minor || 0) / 100,
                    discount: Number(r.discount || 0),
                    vat: Number(r.vat || 0),
                    sum: Number(r.sum_minor || 0) / 100,
                })),
            });
        } catch (e) {
            res.status(500).json({ success: false, error: e && e.message ? e.message : 'Ошибка позиций' });
        }
    });

    /** GET /api/ms-sales/by-product/:code — все отгрузки по конкретному коду МС. */
    router.get('/by-product/:code', async (req, res) => {
        try {
            await ensureSchema(db);
            const code = String(req.params.code || '').trim();
            if (!code) return res.status(400).json({ success: false, error: 'Не указан code' });
            const limit = clampInt(req.query.limit, 1, 500, 100);
            const offset = clampInt(req.query.offset, 0, 1_000_000, 0);
            const days = clampInt(req.query.days, 1, 365 * 5, 30);

            const [rows] = await db.query(
                `SELECT d.uuid, d.doc_name, d.moment, d.applicable, d.agent_name, d.store_name,
                        p.position_uuid, p.quantity, p.price_minor, p.sum_minor,
                        p.assortment_kind, p.product_uuid
                   FROM ms_demand_position p
                   INNER JOIN ms_demand d ON d.uuid = p.demand_uuid
                  WHERE p.ms_export_code = ?
                    AND d.moment >= (NOW() - INTERVAL ? DAY)
                  ORDER BY d.moment DESC
                  LIMIT ? OFFSET ?`,
                [code, days, limit, offset],
            );
            const [agg] = await db.query(
                `SELECT COUNT(*) AS positions, COALESCE(SUM(p.quantity), 0) AS sum_qty,
                        COALESCE(SUM(p.sum_minor), 0) AS sum_amount_minor
                   FROM ms_demand_position p
                   INNER JOIN ms_demand d ON d.uuid = p.demand_uuid
                  WHERE p.ms_export_code = ?
                    AND d.moment >= (NOW() - INTERVAL ? DAY)`,
                [code, days],
            );

            res.json({
                success: true,
                code,
                days,
                positions: Number((agg && agg[0] && agg[0].positions) || 0),
                sum_qty: Number((agg && agg[0] && agg[0].sum_qty) || 0),
                sum_amount: Number((agg && agg[0] && agg[0].sum_amount_minor) || 0) / 100,
                rows: rows.map((r) => ({
                    demand_uuid: String(r.uuid),
                    doc_name: String(r.doc_name || ''),
                    moment: r.moment ? new Date(r.moment).toISOString() : null,
                    applicable: !!r.applicable,
                    agent_name: r.agent_name ? String(r.agent_name) : '',
                    store_name: r.store_name ? String(r.store_name) : '',
                    position_uuid: String(r.position_uuid),
                    assortment_kind: String(r.assortment_kind || ''),
                    quantity: Number(r.quantity || 0),
                    price: Number(r.price_minor || 0) / 100,
                    sum: Number(r.sum_minor || 0) / 100,
                })),
            });
        } catch (e) {
            res.status(500).json({ success: false, error: e && e.message ? e.message : 'Ошибка' });
        }
    });

    /** GET /api/ms-sales/aggregates?days=30 — агрегаты по товарам за период.
     *  Используется для будущих формул (закупки / суженные лимиты). */
    router.get('/aggregates', async (req, res) => {
        try {
            await ensureSchema(db);
            const days = clampInt(req.query.days, 1, 365 * 5, 30);
            const limit = clampInt(req.query.limit, 1, 5000, 1000);
            const offset = clampInt(req.query.offset, 0, 1_000_000, 0);
            const onlyResolved = String(req.query.only_resolved || '1') !== '0';

            const wheres = ['d.moment >= (NOW() - INTERVAL ? DAY)', 'd.applicable = 1'];
            const params = [days];
            if (onlyResolved) wheres.push('p.ms_export_resolved = 1');
            const whereSql = ' WHERE ' + wheres.join(' AND ');

            const [rows] = await db.query(
                `SELECT p.ms_export_code AS code,
                        COALESCE(MAX(e.name), MAX(p.name_at_moment)) AS name,
                        COALESCE(MAX(e.type), MAX(p.assortment_kind)) AS type,
                        COUNT(*) AS positions,
                        SUM(p.quantity) AS sum_qty,
                        SUM(p.sum_minor) AS sum_amount_minor
                   FROM ms_demand_position p
                   INNER JOIN ms_demand d ON d.uuid = p.demand_uuid
                   LEFT JOIN ms_export e ON e.code = p.ms_export_code
                   ${whereSql}
                   GROUP BY p.ms_export_code
                   ORDER BY sum_qty DESC
                   LIMIT ? OFFSET ?`,
                params.concat([limit, offset]),
            );

            res.json({
                success: true,
                days,
                rows: rows.map((r) => ({
                    code: r.code ? String(r.code) : '',
                    name: r.name ? String(r.name) : '',
                    type: r.type ? String(r.type) : '',
                    positions: Number(r.positions || 0),
                    sum_qty: Number(r.sum_qty || 0),
                    sum_amount: Number(r.sum_amount_minor || 0) / 100,
                })),
            });
        } catch (e) {
            res.status(500).json({ success: false, error: e && e.message ? e.message : 'Ошибка' });
        }
    });

    /**
     * POST /api/ms-sales/sync — фоновая синхронизация.
     *
     * Body:
     *   • `days?: number` (1..365*5, default 30) — окно периода `NOW()-days..NOW()`;
     *   • `fresh?: boolean` (default false) — если true, отключает auto-resume:
     *     синк всегда стартует с `momentTo = NOW()` и проходит весь период с нуля
     *     (UPSERT перезаписывает уже сохранённые отгрузки, soft-delete пасс
     *     выполняется по полному окну). По умолчанию (без `fresh`) включается
     *     auto-resume: если в БД уже есть отгрузки за это окно, синк добивает
     *     только «хвост» от `MIN(moment) + 5 минут запаса` и старее
     *     (см. `runDemandSync` для деталей). Это сильно ускоряет повторный
     *     запуск после сетевого таймаута / прерывания.
     */
    router.post('/sync', async (req, res) => {
        if (jobState.active) {
            return res.status(409).json({
                success: false,
                error: 'Синхронизация уже запущена',
                status: jobStateToPayload(),
            });
        }
        const headers = getMsHeaders();
        if (!headers) {
            return res.status(503).json({
                success: false,
                error: 'MS_TOKEN не задан (env MS_TOKEN или config.msToken)',
            });
        }
        const days = clampInt(req.body && req.body.days, 1, 365 * 5, 30);
        const fresh = !!(req.body && req.body.fresh === true);
        resetJobState(days);

        /** Запускаем в фоне, не блокируем HTTP-ответ. */
        ensureSchema(db)
            .then(() => runDemandSync(db, days, { fresh }))
            .then(() => {
                jobState.active = false;
                jobState.finished_at = new Date();
                jobState.message = buildFinalMessage();
            })
            .catch((e) => {
                jobState.active = false;
                jobState.finished_at = new Date();
                logJobError((e && e.message) || 'unknown');
                jobState.message = 'Ошибка: ' + (e && e.message ? e.message : 'unknown');
            });

        return res.json({ success: true, started: true, fresh, status: jobStateToPayload() });
    });

    /** POST /api/ms-sales/sync-cancel — мягкая остановка. */
    router.post('/sync-cancel', (req, res) => {
        jobState.cancelRequested = true;
        return res.json({ success: true, status: jobStateToPayload() });
    });

    /** GET /api/ms-sales/sync-status — статус. */
    router.get('/sync-status', (req, res) => {
        res.json({ success: true, status: jobStateToPayload() });
    });

    /** POST /api/ms-sales/reresolve — перепривязать позиции к ms_export. */
    router.post('/reresolve', async (req, res) => {
        try {
            await ensureSchema(db);
            const [r1] = await db.query(`
                UPDATE ms_demand_position p
                INNER JOIN ms_export e
                    ON e.uuid = COALESCE(p.assortment_uuid, p.product_uuid)
                   SET p.ms_export_code = e.code,
                       p.ms_export_uuid = e.uuid,
                       p.ms_export_resolved = 1
                 WHERE p.ms_export_resolved = 0
                    OR p.ms_export_code IS NULL
            `);
            const [unresolved] = await db.query(
                'SELECT COUNT(*) c FROM ms_demand_position WHERE ms_export_resolved = 0',
            );
            return res.json({
                success: true,
                affected: r1.affectedRows || 0,
                unresolved: Number((unresolved && unresolved[0] && unresolved[0].c) || 0),
            });
        } catch (e) {
            res.status(500).json({ success: false, error: e && e.message ? e.message : 'Ошибка реrezolva' });
        }
    });

    return router;
}

/**
 * Программный триггер синка из планировщика автосинхронизации (server.js).
 * Совпадает по семантике с `POST /api/ms-sales/sync`, но:
 *   • не зависит от Express-роутера (не нужен ни req, ни res);
 *   • возвращает Promise, который резолвится сразу после успешного старта
 *     (чтобы вызывающий мог использовать `getSyncState()` как индикатор
 *     завершения, как сделано для `marketplaces` и `huckster`).
 *
 * Поведение:
 *   • если синк уже идёт — вернёт `{ started: false, reason: 'already_running' }`;
 *   • если нет MS_TOKEN — `{ started: false, reason: 'missing_creds', error: '…' }`;
 *   • при успешном старте — `{ started: true }`, сам синк гоняется в фоне
 *     (как и в HTTP-варианте, чтобы не держать вызывающий контекст).
 */
function triggerSync(db, options = {}) {
    const days = clampInt(options.days, 1, 365 * 5, 90);
    const fresh = !!(options && options.fresh === true);
    if (jobState.active) {
        return Promise.resolve({ started: false, reason: 'already_running', status: jobStateToPayload() });
    }
    const headers = getMsHeaders();
    if (!headers) {
        return Promise.resolve({
            started: false,
            reason: 'missing_creds',
            error: 'MS_TOKEN не задан (env MS_TOKEN или config.msToken)',
        });
    }
    resetJobState(days);
    /** Фоновый запуск: автосинхронизация ждёт через polling getSyncState(). */
    ensureSchema(db)
        .then(() => runDemandSync(db, days, { fresh }))
        .then(() => {
            jobState.active = false;
            jobState.finished_at = new Date();
            jobState.message = buildFinalMessage();
        })
        .catch((e) => {
            jobState.active = false;
            jobState.finished_at = new Date();
            logJobError((e && e.message) || 'unknown');
            jobState.message = 'Ошибка: ' + (e && e.message ? e.message : 'unknown');
        });
    return Promise.resolve({ started: true, days, fresh, status: jobStateToPayload() });
}

/** Снапшот состояния фонового job-а (тот же payload, что и в /sync-status). */
function getSyncState() {
    return jobStateToPayload();
}

module.exports = { createMsSalesRouter, ensureSchema, triggerSync, getSyncState };
