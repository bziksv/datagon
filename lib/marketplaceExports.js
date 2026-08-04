'use strict';

const axios = require('axios');

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

/** Нижние границы пауз между запросами (ниже — риск 429; поднять можно query-параметрами).
 *
 * Сверено с официальными лимитами WB (часть таблиц зависит от типа токена — см. api.md):
 *  - Content («cards/list», POST):              100 req / 1 min, interval 600 ms, burst 5.
 *  - Prices & Discounts («discounts-prices-api» … «list/goods/filter», GET): в описании метода —
 *                                                10 req / 6 s, interval 600 ms, burst 5 (отдельное окно от Маркетплейса).
 *  - Marketplace («marketplace-api» … warehouses/stocks): для Базового токена в общей таблице WB —
 *                                                150 req / 1 min, interval 200 ms, burst 10; для Personal/Service чаще 300/мин.
 *
 * Категории НЕ делят одно окно лимитов: 429 на prices/stocks обычно означает либо
 * параллельных клиентов на том же токене, либо временный сбой/блокировку на стороне WB.
 * Поэтому минимумы держим скромными, дефолты выбраны с запасом ~×3 от minimum interval.
 *
 * Дефолты в settings.html / роутере остаются прежними и зажимаются к этим минимумам
 * только при попытке поставить меньше.
 */
const MP_MIN_DELAY_MS = {
    ozon: 300,
    wbCards: 600,            // Content interval 600 ms
    wbPricesStocks: 700,     // safe gap для prices (Prices ≈ 600 ms) и stocks (Marketplace 200 ms)
    yandex: 200,
};

/** Короткая «гигиеническая» пауза между фазами WB. Категории разные (Content / Prices /
 * Marketplace), поэтому выжигания окна между фазами в норме нет; пауза помогает только
 * если тот же токен параллельно используется другим клиентом или scheduler. Держим её
 * маленькой, чтобы не растягивать общий экспорт. */
const WB_COOLDOWN_BETWEEN_PHASES_MS = 2000;

/**
 * Создаёт пошаговый логгер для конкретного маркетплейса.
 * Каждый вызов `log(msg, ctx?)`:
 *   - пишет в `console.log` строку вида `[mp:<kind>] +1234ms <msg> <ctx>`;
 *   - добавляет шаг в `steps[]` с относительным временем (`tMs`);
 *   - если задан `onStep`, вызывает его с тем же объектом — это используется для
 *     потоковой (NDJSON) отдачи прогресса в UI без ожидания финального ответа.
 * `summary()` возвращает `{ kind, durationMs, steps }` — пригодно для отдачи клиенту в JSON.
 */
function createMarketplaceLogger(kind, onStep) {
    const startedAt = Date.now();
    const steps = [];
    const fs = require('fs');
    const path = require('path');
    const kindSafe = String(kind || 'mp').replace(/[^a-z0-9_-]/gi, '');
    const logDir = path.join(__dirname, '..', 'logs');
    const logFile = path.join(logDir, `marketplace-${kindSafe}-sync.log`);
    let fileReady = false;
    try {
        fs.mkdirSync(logDir, { recursive: true });
        fileReady = true;
    } catch (_) {
        fileReady = false;
    }
    function appendFileLine(line) {
        if (!fileReady) return;
        try {
            fs.appendFileSync(logFile, line + '\n', 'utf8');
        } catch (_) {
            /* диск / права — не роняем sync */
        }
    }
    function log(msg, ctx) {
        const tMs = Date.now() - startedAt;
        const safeCtx = ctx && typeof ctx === 'object' ? ctx : undefined;
        const step = { tMs, msg: String(msg || ''), ctx: safeCtx };
        steps.push(step);
        const ctxStr =
            safeCtx && Object.keys(safeCtx).length
                ? ' ' +
                  Object.keys(safeCtx)
                      .map((k) => `${k}=${typeof safeCtx[k] === 'object' ? JSON.stringify(safeCtx[k]) : safeCtx[k]}`)
                      .join(' ')
                : '';
        const line = `[mp:${kind}] +${tMs}ms ${msg}${ctxStr}`;
        // eslint-disable-next-line no-console
        console.log(line);
        appendFileLine(`${new Date().toISOString()} ${line}`);
        if (typeof onStep === 'function') {
            try {
                onStep(step);
            } catch (_) {
                /* потребитель не должен ронять основной поток */
            }
        }
    }
    function summary() {
        return { kind, durationMs: Date.now() - startedAt, steps: steps.slice(), logFile: `logs/marketplace-${kindSafe}-sync.log` };
    }
    log('logger:open', { logFile: `logs/marketplace-${kindSafe}-sync.log` });
    return { log, summary };
}

/**
 * Повтор при типовых сбоях маркетплейсов: 429 / 500 / 502 / 503 / 504 и заголовок Retry-After (секунды).
 * 500 у Wildberries (`content-api`, `discounts-prices-api`, `marketplace-api`) — частая транзиентная
 * ошибка под нагрузкой; ретраим её так же, как 502/503.
 * При финальном падении к тексту ошибки прицепляем URL и метод — иначе axios отдаёт лишь
 * «Request failed with status code 500» без понятной диагностики.
 *
 * Параметры повторов:
 *  - maxAttempts (default 18) — общее число попыток.
 *  - 429 ⇒ wait ≥ 5 сек, ≤ 60 сек на попытку (WB остывает за ~30–60 сек; ждать дольше смысла нет).
 *  - jitter ±20% — чтобы параллельные клиенты не били окно «в такт».
 *  - Retry-After (если есть) — приоритетный, всегда уважаем.
 *  - cumWaitBudgetMs (опц.) — суммарный бюджет всех ожиданий; по достижении прекращаем
 *    ретраи и бросаем последнюю ошибку с пометкой `axios:budget_exhausted` (это нужно
 *    для prices/stocks WB — там нет смысла висеть 10 минут на 429, лучше soft-fail).
 *
 * Опциональный `retryOpts` третьим аргументом: `{ maxAttempts, cumWaitBudgetMs }`.
 *
 * Опциональный `logger` (см. `createMarketplaceLogger`) пишет ретраи в серверную консоль:
 *   `[mp:<kind>] +Tms axios:retry attempt=N status=429 waitMs=900 url=…`
 */
async function axiosWithMarketplaceRateLimit(config, logger, retryOpts) {
    const maxAttempts = Math.max(1, Number((retryOpts && retryOpts.maxAttempts) ?? 18) | 0);
    const cumBudget = retryOpts && Number.isFinite(Number(retryOpts.cumWaitBudgetMs))
        ? Math.max(0, Number(retryOpts.cumWaitBudgetMs))
        : 0;
    const method = (config && (config.method || 'GET')).toString().toUpperCase();
    const url = config && config.url;
    let lastErr;
    let cumWait = 0;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        try {
            // eslint-disable-next-line no-await-in-loop
            return await axios(config);
        } catch (e) {
            lastErr = e;
            const st = e.response && e.response.status;
            // 420 — «Enhance Your Calm» / кастомный rate-limit Я.Маркета (stats/skus).
            // Без ретрая весь ночной sync YM обрывался, снапшот оставался на старой дате.
            const retryable =
                st === 420 || st === 429 || st === 500 || st === 502 || st === 503 || st === 504;
            if (!retryable) {
                e.message = `${e.message} [${method} ${url}]`;
                if (logger) logger.log('axios:fail', { method, url, status: st || null, message: e.message });
                throw e;
            }
            let waitMs = 900 * 1.35 ** attempt;
            waitMs = waitMs * (0.8 + Math.random() * 0.4);
            const respHeaders = (e.response && e.response.headers) || {};
            // WB OpenAPI 429 отдаёт `X-Ratelimit-Retry` (секунды до возможной попытки)
            // и `X-Ratelimit-Reset` (секунды до восстановления burst). Стандартный
            // `Retry-After` тоже уважаем — у Ozon/Я.Маркет он бывает.
            const ra = respHeaders['retry-after'];
            const wbRetry = respHeaders['x-ratelimit-retry'];
            const wbReset = respHeaders['x-ratelimit-reset'];
            const headerSec = [ra, wbRetry, wbReset]
                .map((v) => (v == null ? NaN : parseFloat(String(v).trim())))
                .filter((n) => Number.isFinite(n) && n >= 0);
            if (headerSec.length) {
                waitMs = Math.max(waitMs, Math.min(...headerSec) * 1000);
            }
            if (st === 429 || st === 420) {
                waitMs = Math.max(waitMs, st === 420 ? 8000 : 5000);
                waitMs = Math.min(waitMs, 90000);
            } else {
                waitMs = Math.min(waitMs, 180000);
            }
            waitMs = Math.floor(waitMs);
            if (cumBudget > 0 && cumWait + waitMs > cumBudget) {
                if (logger)
                    logger.log('axios:budget_exhausted', {
                        method,
                        url,
                        status: st,
                        attempt: attempt + 1,
                        of: maxAttempts,
                        cumWaitMs: cumWait,
                        budgetMs: cumBudget,
                    });
                e.message = `${e.message} [${method} ${url}] (бюджет ожидания исчерпан)`;
                throw e;
            }
            cumWait += waitMs;
            if (logger)
                logger.log('axios:retry', {
                    method,
                    url,
                    status: st,
                    attempt: attempt + 1,
                    of: maxAttempts,
                    waitMs,
                    retryAfter: ra != null ? String(ra) : null,
                    wbRetry: wbRetry != null ? String(wbRetry) : null,
                    wbReset: wbReset != null ? String(wbReset) : null,
                    wbLimit: respHeaders['x-ratelimit-limit'] != null ? String(respHeaders['x-ratelimit-limit']) : null,
                    wbRemaining:
                        respHeaders['x-ratelimit-remaining'] != null
                            ? String(respHeaders['x-ratelimit-remaining'])
                            : null,
                });
            // eslint-disable-next-line no-await-in-loop
            await sleep(waitMs);
        }
    }
    if (lastErr) {
        lastErr.message = `${lastErr.message} [${method} ${url}]`;
        if (logger)
            logger.log('axios:exhausted', {
                method,
                url,
                attempts: maxAttempts,
                message: lastErr.message,
            });
    }
    throw lastErr;
}

function formatRuMoneyFromMajor(n) {
    const x = Number(n);
    if (!Number.isFinite(x) || x === 0) return '';
    return `${new Intl.NumberFormat('ru-RU').format(Math.round(x))} ₽`;
}

function formatRuMoneyFromMinor(minor) {
    const x = Number(minor);
    if (!Number.isFinite(x) || x === 0) return '';
    return formatRuMoneyFromMajor(x / 100);
}

/** UTF-8 BOM + semicolon CSV for Excel RU */
function rowsToCsvSemicolon(headers, rows) {
    const esc = (cell) => {
        const s = cell === null || cell === undefined ? '' : String(cell);
        if (/[";\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
        return s;
    };
    const lines = [headers.map(esc).join(';'), ...rows.map((r) => r.map(esc).join(';'))];
    return `\uFEFF${lines.join('\r\n')}`;
}

// --- Ozon ---

/**
 * Текущий Ozon API возвращает vat как строку-долю: '0' / '0.05' / '0.07' / '0.10' / '0.20'.
 * Поведение по требованию: 0 → «Без НДС», 0.05 → «5», 0.07 → «7», 0.10 → «10», 0.20 → «20».
 * Целые значения (20/10/5/7/0/6/1) поддержаны для обратной совместимости со старыми ответами/снапшотами.
 */
function ozonVatLabel(v) {
    if (v === undefined || v === null || v === '') return 'Без НДС';
    const s = String(v).trim();
    const n = Number(s);
    if (Number.isFinite(n)) {
        if (n === 0) return 'Без НДС';
        if (n > 0 && n < 1) {
            const pct = Math.round(n * 100);
            return pct === 0 ? 'Без НДС' : String(pct);
        }
        if (n === 5 || n === 7 || n === 10 || n === 20) return String(n);
        if (n === 6) return 'Без НДС';
        if (n === 1) return 'НДС не облагается';
    }
    return s;
}

/**
 * Постпроцессинг VAT для UI/CSV: убирает суффиксы вроде «(УСН)», «%», нормализует строки из снапшотов.
 *  - kind = 'ozon' : см. {@link ozonVatLabel}.
 *  - kind = 'ym'   : '5% (УСН)' → '5', '20%' → '20', 'без НДС' → 'без НДС'.
 *  - kind = 'wb'   : '5% (УСН)' → '5', '7% (УСН)' → '7', 'Без НДС%' / 'без НДС' → 'Без НДС',
 *                    'не указан' остаётся как есть. Свежие выгрузки уже отформатированы в
 *                    `wbExtractVatFromCharacteristics`, постпроцесс нужен для старых снимков.
 */
function prettifyMarketplaceVat(kind, raw) {
    const s = String(raw == null ? '' : raw).trim();
    if (!s) return kind === 'ozon' ? 'Без НДС' : '';
    if (kind === 'ozon') return ozonVatLabel(s);
    if (kind === 'ym') {
        const m = s.match(/^([\d.]+)\s*%/);
        if (m) {
            const pct = parseFloat(m[1]);
            if (Number.isFinite(pct)) return String(Math.round(pct));
        }
        return s;
    }
    if (kind === 'wb') {
        if (/без\s*нДС/i.test(s)) return 'Без НДС';
        const m = s.match(/^([\d.]+)\s*%/);
        if (m) {
            const pct = parseFloat(m[1]);
            if (Number.isFinite(pct)) return String(Math.round(pct));
        }
        return s;
    }
    return s;
}

async function exportOzonRows(creds, opts) {
    const clientId = String(creds.clientId || '').trim();
    const apiKey = String(creds.apiKey || '').trim();
    const logger = (opts && opts.logger) || createMarketplaceLogger('ozon');
    if (!clientId || !apiKey) {
        const err = new Error('Ozon: не заданы OZON_CLIENT_ID и OZON_API_KEY (или app_settings ozon_client_id / ozon_api_key)');
        err.code = 'MISSING_CREDS';
        logger.log('error:missing_creds');
        throw err;
    }

    const maxItems = Math.max(1, Math.min(Number(opts.maxItems || 25000), 25000));
    const includeArchived = Boolean(opts.includeArchived);
    const delayMs = Math.max(MP_MIN_DELAY_MS.ozon, Number(opts.delayMs ?? 400) || 400);
    const headers = { 'Client-Id': clientId, 'Api-Key': apiKey, 'Content-Type': 'application/json' };

    logger.log('start', { maxItems, includeArchived, delayMs, clientId });

    const basicItems = [];
    let lastId = '';
    let listingPage = 0;
    logger.log('step:listing:start');
    while (basicItems.length < maxItems) {
        const remaining = Math.min(1000, maxItems - basicItems.length);
        listingPage += 1;
        const { data } = await axiosWithMarketplaceRateLimit(
            {
                method: 'POST',
                url: 'https://api-seller.ozon.ru/v3/product/list',
                data: {
                    filter: { visibility: includeArchived ? 'ALL' : 'VISIBLE' },
                    limit: remaining,
                    last_id: lastId,
                },
                headers,
                timeout: 120000,
            },
            logger,
        );
        const items = data?.result?.items || [];
        for (const item of items) {
            basicItems.push({ product_id: item.product_id, offer_id: item.offer_id || '' });
        }
        lastId = data?.result?.last_id || '';
        logger.log('step:listing:page', { page: listingPage, items: items.length, totalSoFar: basicItems.length });
        if (!items.length) break;
        if (delayMs) await sleep(delayMs);
    }
    logger.log('step:listing:done', { total: basicItems.length });

    const productDetails = new Map();
    const batchSize = 50;
    const totalInfoBatches = Math.ceil(basicItems.length / batchSize);
    logger.log('step:info:start', { totalBatches: totalInfoBatches, batchSize });
    for (let i = 0; i < basicItems.length; i += batchSize) {
        const batchIdx = Math.floor(i / batchSize) + 1;
        const batch = basicItems.slice(i, i + batchSize).map((x) => Number(x.product_id));
        const { data } = await axiosWithMarketplaceRateLimit(
            {
                method: 'POST',
                url: 'https://api-seller.ozon.ru/v3/product/info/list',
                data: { product_id: batch, language: 'DEFAULT' },
                headers,
                timeout: 120000,
            },
            logger,
        );
        const list = data?.items || [];
        logger.log('step:info:batch', { batch: batchIdx, of: totalInfoBatches, requested: batch.length, returned: list.length });
        for (const item of list) {
            const pid = String(item.id);
            const status = item.statuses?.status_name || '';
            const reason = item.statuses?.status_description || '';
            let stocks = 0;
            if (item.stocks?.stocks) {
                stocks = item.stocks.stocks.reduce((s, x) => s + (x.present || 0), 0);
            }
            const priceStr = item.price ? formatRuMoneyFromMajor(parseFloat(item.price)) : '';
            productDetails.set(pid, {
                name: item.name || '',
                status,
                reason,
                stocks,
                price: priceStr,
                vat: ozonVatLabel(item.vat),
                sku: item.sku || '',
                length: '',
                width: '',
                height: '',
                weight: '',
            });
        }
        if (delayMs) await sleep(delayMs);
    }
    logger.log('step:info:done', { details: productDetails.size });

    const totalAttrBatches = Math.ceil(basicItems.length / batchSize);
    logger.log('step:attrs:start', { totalBatches: totalAttrBatches, batchSize });
    for (let i = 0; i < basicItems.length; i += batchSize) {
        const batchIdx = Math.floor(i / batchSize) + 1;
        const batch = basicItems.slice(i, i + batchSize).map((x) => Number(x.product_id));
        const { data } = await axiosWithMarketplaceRateLimit(
            {
                method: 'POST',
                url: 'https://api-seller.ozon.ru/v4/product/info/attributes',
                data: { filter: { product_id: batch }, limit: batch.length },
                headers,
                timeout: 120000,
            },
            logger,
        );
        const results = data?.result || [];
        logger.log('step:attrs:batch', { batch: batchIdx, of: totalAttrBatches, requested: batch.length, returned: results.length });
        for (const product of results) {
            const pid = String(product.id);
            const existing = productDetails.get(pid);
            if (!existing) continue;
            const lengthCm = product.depth !== undefined ? product.depth / 10 : null;
            const widthCm = product.width !== undefined ? product.width / 10 : null;
            const heightCm = product.height !== undefined ? product.height / 10 : null;
            const weightKg = product.weight !== undefined ? parseFloat(product.weight) / 1000 : null;
            existing.length = lengthCm !== null && lengthCm > 0 ? String(lengthCm.toFixed(1)) : '';
            existing.width = widthCm !== null && widthCm > 0 ? String(widthCm.toFixed(1)) : '';
            existing.height = heightCm !== null && heightCm > 0 ? String(heightCm.toFixed(1)) : '';
            existing.weight = weightKg !== null && weightKg > 0 ? String(weightKg.toFixed(2)) : '';
        }
        if (delayMs) await sleep(delayMs);
    }
    logger.log('step:attrs:done');

    const ts = new Intl.DateTimeFormat('ru-RU', {
        timeZone: 'Europe/Moscow',
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
    })
        .format(new Date())
        .replace(',', '');

    const headerKeys = [
        'offer_id',
        'name',
        'manager',
        'content_manager',
        'price',
        'vat',
        'status',
        'block_reason',
        'stock',
        'length_cm',
        'width_cm',
        'height_cm',
        'weight_kg',
        'cabinet_url',
        'buyer_url',
        'updated',
    ];
    const rows = basicItems.map((item) => {
        const d = productDetails.get(String(item.product_id)) || {};
        const productLink = d.sku ? String(d.sku) : String(item.product_id);
        return {
            offer_id: item.offer_id || '',
            manager: '',
            content_manager: '',
            name: d.name || '',
            price: d.price || '',
            vat: d.vat || 'Без НДС',
            status: d.status || '',
            block_reason: d.reason || '',
            stock: d.stocks ?? '',
            length_cm: d.length || '',
            width_cm: d.width || '',
            height_cm: d.height || '',
            weight_kg: d.weight || '',
            cabinet_url: `https://seller.ozon.ru/app/products/${item.product_id}/edit/general-info`,
            buyer_url: `https://www.ozon.ru/product/${productLink}`,
            updated: ts,
        };
    });

    logger.log('done', { rows: rows.length, updatedAt: ts });
    return { headerKeys, rows, updatedAt: ts, summary: logger.summary() };
}

// --- Wildberries ---

function wbExtractVatFromCharacteristics(characteristics) {
    if (!characteristics || !Array.isArray(characteristics)) return 'не указан';
    for (const char of characteristics) {
        if (char.name === 'Ставка НДС' || char.id === 15001405) {
            const vatValue = char.value?.[0];
            if (vatValue === undefined || vatValue === null || vatValue === '') return 'не указан';
            // Требование: проценты — простыми числами без «%»/«(УСН)»,
            // код «6» (нет НДС) → «Без НДС». См. prettifyMarketplaceVat('wb').
            switch (String(vatValue)) {
                case '0':
                    return '0';
                case '5':
                    return '5';
                case '7':
                    return '7';
                case '10':
                    return '10';
                case '20':
                    return '20';
                case '6':
                    return 'Без НДС';
                default:
                    return String(vatValue);
            }
        }
    }
    return 'не указан';
}

function wbCardStatusLabel(cardStatus) {
    const s = String(cardStatus || '');
    if (s === 'approved' || s === 'published') return 'Продаётся';
    if (s === 'moderation') return 'На модерации';
    if (s === 'rejected') return 'Отклонён';
    if (s === 'disabled') return 'Отключён';
    if (s === 'unpublished') return 'Снят с продажи';
    if (s === 'archive') return 'В архиве';
    return 'Активен';
}

async function exportWildberriesRows(creds, opts) {
    const apiKey = String(creds.apiKey || '').trim();
    const logger = (opts && opts.logger) || createMarketplaceLogger('wb');
    if (!apiKey) {
        const err = new Error('Wildberries: не задан WB_API_KEY (или app_settings wb_api_key)');
        err.code = 'MISSING_CREDS';
        logger.log('error:missing_creds');
        throw err;
    }

    const maxCards = Math.max(1, Math.min(Number(opts.maxItems || 25000), 50000));
    const delayCards = Math.max(MP_MIN_DELAY_MS.wbCards, Number(opts.delayCards ?? 600) || 600);
    const delayOther = Math.max(MP_MIN_DELAY_MS.wbPricesStocks, Number(opts.delayOther ?? 1600) || 1600);
    /** Для отладки и `/status`: какой тип токена указан в настройках (не отключает фазы). */
    const tokenType = String(opts.tokenType || 'base').trim().toLowerCase();

    const authH = { Authorization: apiKey };
    logger.log('start', { maxCards, delayCards, delayOther, tokenType });

    const allCards = [];
    let cursor = { limit: 100 };
    let cardsPage = 0;
    logger.log('step:cards:start');
    while (allCards.length < maxCards) {
        cardsPage += 1;
        const { data } = await axiosWithMarketplaceRateLimit(
            {
                method: 'POST',
                url: 'https://content-api.wildberries.ru/content/v2/get/cards/list',
                data: { settings: { sort: { ascending: true }, cursor, filter: { withPhoto: -1 } } },
                headers: { ...authH, 'Content-Type': 'application/json' },
                timeout: 120000,
            },
            logger,
        );
        const cards = data?.cards || [];
        const filtered = cards.filter((c) => c.status !== 'archive');
        for (const c of filtered) {
            if (allCards.length >= maxCards) break;
            allCards.push(c);
        }
        logger.log('step:cards:page', {
            page: cardsPage,
            received: cards.length,
            kept: filtered.length,
            totalSoFar: allCards.length,
        });
        if (data?.cursor?.updatedAt && data?.cursor?.nmID) {
            cursor = { limit: 100, updatedAt: data.cursor.updatedAt, nmID: data.cursor.nmID };
        } else break;
        if (cards.length < 100) break;
        if (delayCards) await sleep(delayCards);
    }
    logger.log('step:cards:done', { total: allCards.length });

    const cardsMap = new Map();
    const vendorCodeToNmId = new Map();
    for (const card of allCards) {
        const nmId = String(card.nmID);
        const dims = card.dimensions || {};
        let weight = dims.weightBrutto;
        if (weight && weight > 1000) weight = weight / 1000;
        let reason = '';
        if (card.errors && card.errors.length) {
            reason = card.errors.map((e) => e.message || e.human_text?.text || String(e)).join('; ');
        }
        cardsMap.set(nmId, {
            vendorCode: card.vendorCode || '',
            title: card.title || card.subjectName || '',
            vat: wbExtractVatFromCharacteristics(card.characteristics),
            length: dims.length || '',
            width: dims.width || '',
            height: dims.height || '',
            weight: weight !== undefined && weight !== '' ? weight : '',
            status: wbCardStatusLabel(card.status),
            reason,
        });
        if (card.vendorCode) vendorCodeToNmId.set(String(card.vendorCode).trim(), nmId);
    }

    // prices/stocks WB: ограничиваем бюджет ретраев каждого запроса, чтобы не висеть
    // 10+ минут на 429 (как было раньше). Бюджет ~120 сек/запрос — больше нет смысла,
    // окно WB обычно отходит за минуту, либо реально заблокировано (нет смысла ждать).
    const wbSlowRetry = { maxAttempts: 10, cumWaitBudgetMs: 120000 };

    const priceMap = new Map();
    // Цены: discounts-prices-api, категория «Цены и скидки» — не путать с таблицей «Маркетплейс»
    // (150/мин для Базового на marketplace-api). В OpenAPI для GET list/goods/filter указано
    // ограничение по всей категории Prices & Discounts: 10 запросов / 6 с, интервал 600 мс.
    if (allCards.length > 0) {
        logger.log('step:cooldown:before_prices', { ms: WB_COOLDOWN_BETWEEN_PHASES_MS });
        await sleep(WB_COOLDOWN_BETWEEN_PHASES_MS);
    }
    logger.log('step:prices:start');
    try {
        let offset = 0;
        const limit = 1000;
        let pricesPage = 0;
        while (true) {
            pricesPage += 1;
            // eslint-disable-next-line no-await-in-loop
            const { data } = await axiosWithMarketplaceRateLimit(
                {
                    method: 'GET',
                    url: 'https://discounts-prices-api.wildberries.ru/api/v2/list/goods/filter',
                    params: { limit, offset },
                    headers: authH,
                    timeout: 120000,
                },
                logger,
                wbSlowRetry,
            );
            const goods = data?.data?.listGoods || [];
            let pricedThisPage = 0;
            for (const good of goods) {
                const nmId = String(good.nmID);
                let priceRub = good.sizes?.[0]?.price || 0;
                if (priceRub > 0) {
                    priceMap.set(nmId, formatRuMoneyFromMajor(Math.round(priceRub)));
                    pricedThisPage += 1;
                }
            }
            logger.log('step:prices:page', {
                page: pricesPage,
                offset,
                received: goods.length,
                priced: pricedThisPage,
            });
            if (goods.length < limit) break;
            offset += limit;
            if (delayOther) await sleep(delayOther);
        }
        logger.log('step:prices:done', { withPrice: priceMap.size });
    } catch (ePrices) {
        const upstream = ePrices && ePrices.response && ePrices.response.status;
        logger.log('step:prices:failed', {
            upstream_status: upstream || null,
            withPrice: priceMap.size,
            message: ePrices && ePrices.message ? ePrices.message : String(ePrices),
        });
        // Не пробрасываем — продолжаем со stocks и сохраняем то, что есть в cards.
    }

    // Остатки: marketplace-api — таблица «Маркетплейс» (для Базового часто 150/мин, 200 мс).
    if (allCards.length > 0) {
        logger.log('step:cooldown:before_stocks', { ms: WB_COOLDOWN_BETWEEN_PHASES_MS });
        await sleep(WB_COOLDOWN_BETWEEN_PHASES_MS);
    }

    const stockMap = new Map();
    logger.log('step:stocks:start');
    try {
        const whRes = await axiosWithMarketplaceRateLimit(
            {
                method: 'GET',
                url: 'https://marketplace-api.wildberries.ru/api/v3/warehouses',
                headers: authH,
                timeout: 60000,
            },
            logger,
            wbSlowRetry,
        );
        let warehouses = whRes.data;
        if (!Array.isArray(warehouses) || !warehouses.length) {
            warehouses = [{ id: 84250, name: 'default' }];
        }
        logger.log('step:stocks:warehouses', { count: warehouses.length });
        const vendorCodes = Array.from(vendorCodeToNmId.keys());
        for (const warehouse of warehouses) {
            const totalChunks = Math.ceil(vendorCodes.length / 100) || 0;
            logger.log('step:stocks:warehouse:start', {
                warehouseId: warehouse.id,
                warehouseName: warehouse.name || '',
                chunks: totalChunks,
            });
            for (let i = 0; i < vendorCodes.length; i += 100) {
                const chunkIdx = Math.floor(i / 100) + 1;
                const chunk = vendorCodes.slice(i, i + 100);
                try {
                    // eslint-disable-next-line no-await-in-loop
                    const stRes = await axiosWithMarketplaceRateLimit(
                        {
                            method: 'POST',
                            url: `https://marketplace-api.wildberries.ru/api/v3/stocks/${warehouse.id}`,
                            data: { skus: chunk },
                            headers: { ...authH, 'Content-Type': 'application/json' },
                            timeout: 120000,
                        },
                        logger,
                        wbSlowRetry,
                    );
                    const stocks = stRes.data?.stocks || [];
                    let positive = 0;
                    for (const row of stocks) {
                        const sku = String(row.sku);
                        const amount = row.amount || 0;
                        const nmId = vendorCodeToNmId.get(sku);
                        if (nmId && amount > 0) {
                            stockMap.set(nmId, (stockMap.get(nmId) || 0) + amount);
                            positive += 1;
                        }
                    }
                    logger.log('step:stocks:chunk', {
                        warehouseId: warehouse.id,
                        chunk: chunkIdx,
                        of: totalChunks,
                        skus: chunk.length,
                        positive,
                    });
                } catch (errChunk) {
                    logger.log('step:stocks:chunk:error', {
                        warehouseId: warehouse.id,
                        chunk: chunkIdx,
                        message: errChunk && errChunk.message ? errChunk.message : String(errChunk),
                    });
                }
                if (delayOther) await sleep(delayOther);
            }
        }
    } catch (e) {
        logger.log('step:stocks:skipped', { message: e && e.message ? e.message : String(e) });
    }
    logger.log('step:stocks:done', { withStock: stockMap.size });

    const ts = new Intl.DateTimeFormat('ru-RU', {
        timeZone: 'Europe/Moscow',
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
    })
        .format(new Date())
        .replace(',', '');

    const headerKeys = [
        'vendor_code',
        'title',
        'manager',
        'content_manager',
        'price',
        'vat',
        'stock',
        'length_cm',
        'width_cm',
        'height_cm',
        'weight_kg',
        'cabinet_url',
        'buyer_url',
        'updated',
    ];
    const rows = [];
    for (const [nmId, card] of cardsMap) {
        rows.push({
            vendor_code: card.vendorCode || '',
            manager: '',
            content_manager: '',
            title: card.title || '',
            price: priceMap.get(nmId) || '',
            vat: card.vat,
            stock: stockMap.get(nmId) || 0,
            length_cm: card.length || '',
            width_cm: card.width || '',
            height_cm: card.height || '',
            weight_kg: card.weight === '' || card.weight === undefined ? '' : String(card.weight),
            cabinet_url: `https://seller.wildberries.ru/new-goods/card?nmID=${nmId}&type=EXIST_CARD`,
            buyer_url: `https://www.wildberries.ru/catalog/${nmId}/detail.aspx`,
            updated: ts,
        });
    }

    logger.log('done', { rows: rows.length, updatedAt: ts });
    return { headerKeys, rows, updatedAt: ts, summary: logger.summary() };
}

// --- Yandex Market ---

/**
 * Поведение по требованию: проценты — простыми числами без суффикса «%»/«(УСН)».
 *  2 → '10', 5 → '0' (Без НДС), 6 → 'без НДС', 7 → '20', 10 → '5', 11 → '7', 14 → '22'.
 */
function ymVatText(v) {
    switch (v) {
        case 2:
            return '10';
        case 5:
            return '0';
        case 6:
            return 'без НДС';
        case 7:
            return '20';
        case 10:
            return '5';
        case 11:
            return '7';
        case 14:
            return '22';
        default:
            return 'не указан';
    }
}

async function exportYandexMarketRows(creds, opts) {
    const apiKey = String(creds.apiKey || '').trim();
    const campaignId = String(creds.campaignId || '').trim();
    const businessId = String(creds.businessId || '').trim();
    const logger = (opts && opts.logger) || createMarketplaceLogger('ym');
    if (!apiKey || !campaignId) {
        const err = new Error(
            'Яндекс Маркет: не заданы YM_API_KEY и YM_CAMPAIGN_ID (или app_settings ym_api_key / ym_campaign_id)',
        );
        err.code = 'MISSING_CREDS';
        logger.log('error:missing_creds');
        throw err;
    }

    const maxSkus = Math.max(1, Math.min(Number(opts.maxItems || 25000), 100000));
    // Базовая пауза listing/prices; для stats/skus Я.Маркет жмёт 420 при ~280 мс —
    // держим отдельный floor (если в настройках пауза больше — используем её).
    const delayMs = Math.max(MP_MIN_DELAY_MS.yandex, Number(opts.delayMs ?? 280) || 280);
    const statsDelayMs = Math.max(delayMs, 550);
    const headers = { 'Api-Key': apiKey };
    logger.log('start', { maxSkus, delayMs, statsDelayMs, campaignId, businessId: businessId || null });

    const allSkus = [];
    let pageToken = '';
    let listingPage = 0;
    logger.log('step:listing:start');
    do {
        listingPage += 1;
        let url = `https://api.partner.market.yandex.ru/v2/campaigns/${campaignId}/offer-prices?limit=500`;
        if (pageToken) url += `&page_token=${encodeURIComponent(pageToken)}`;
        const { data } = await axiosWithMarketplaceRateLimit({ method: 'GET', url, headers, timeout: 120000 }, logger);
        const offers = data?.result?.offers || [];
        for (const offer of offers) {
            if (offer.id && allSkus.length < maxSkus) allSkus.push(String(offer.id));
        }
        pageToken = data?.result?.paging?.nextPageToken || '';
        logger.log('step:listing:page', {
            page: listingPage,
            received: offers.length,
            totalSoFar: allSkus.length,
            hasNext: Boolean(pageToken),
        });
        if (!pageToken) break;
        if (delayMs) await sleep(delayMs);
    } while (allSkus.length < maxSkus);
    logger.log('step:listing:done', { total: allSkus.length });

    const pricesMap = new Map();
    const totalPriceBatches = Math.ceil(allSkus.length / 500) || 0;
    logger.log('step:prices:start', { totalBatches: totalPriceBatches, batchSize: 500 });
    for (let i = 0; i < allSkus.length; i += 500) {
        const batchIdx = Math.floor(i / 500) + 1;
        const chunk = allSkus.slice(i, i + 500);
        const { data } = await axiosWithMarketplaceRateLimit(
            {
                method: 'POST',
                url: `https://api.partner.market.yandex.ru/v2/campaigns/${campaignId}/offer-prices`,
                data: { offerIds: chunk },
                headers: { ...headers, 'Content-Type': 'application/json' },
                timeout: 120000,
            },
            logger,
        );
        const offers = data?.result?.offers || [];
        for (const offer of offers) {
            if (offer.offerId) {
                pricesMap.set(String(offer.offerId), {
                    price: offer.price?.value || 0,
                    vat: ymVatText(offer.price?.vat),
                });
            }
        }
        logger.log('step:prices:batch', {
            batch: batchIdx,
            of: totalPriceBatches,
            requested: chunk.length,
            returned: offers.length,
        });
        if (delayMs) await sleep(delayMs);
    }
    logger.log('step:prices:done', { withPrice: pricesMap.size });

    const ts = new Intl.DateTimeFormat('ru-RU', {
        timeZone: 'Europe/Moscow',
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
    })
        .format(new Date())
        .replace(',', '');

    const headerKeys = [
        'shop_sku',
        'name',
        'manager',
        'content_manager',
        'price',
        'vat',
        'stock_fit',
        'length',
        'width',
        'height',
        'weight',
        'cabinet_url',
        'buyer_url',
        'updated',
    ];
    const rows = [];
    const totalStatsBatches = Math.ceil(allSkus.length / 100) || 0;
    logger.log('step:stats:start', { totalBatches: totalStatsBatches, batchSize: 100 });
    for (let i = 0; i < allSkus.length; i += 100) {
        const batchIdx = Math.floor(i / 100) + 1;
        const chunk = allSkus.slice(i, i + 100);
        const { data } = await axiosWithMarketplaceRateLimit(
            {
                method: 'POST',
                url: `https://api.partner.market.yandex.ru/v2/campaigns/${campaignId}/stats/skus`,
                data: { shopSkus: chunk },
                headers: { ...headers, 'Content-Type': 'application/json' },
                timeout: 120000,
            },
            logger,
        );
        const goods = data?.result?.shopSkus || [];
        logger.log('step:stats:batch', {
            batch: batchIdx,
            of: totalStatsBatches,
            requested: chunk.length,
            returned: goods.length,
        });
        for (const good of goods) {
            const offerId = String(good.shopSku);
            const priceInfo = pricesMap.get(offerId) || { price: 0, vat: 'не указан' };
            let totalStock = 0;
            if (good.warehouses) {
                for (const wh of good.warehouses) {
                    if (wh.stocks) {
                        for (const stock of wh.stocks) {
                            if (stock.type === 'FIT') totalStock += stock.count || 0;
                        }
                    }
                }
            }
            const dims = good.weightDimensions || {};
            const buyerLink = good.marketSku && businessId
                ? `https://market.yandex.ru/product/${good.marketSku}?businessId=${businessId}`
                : good.marketSku
                  ? `https://market.yandex.ru/product/${good.marketSku}`
                  : '';
            rows.push({
                shop_sku: offerId,
                manager: '',
                content_manager: '',
                name: good.name || '',
                price: priceInfo.price ? `${new Intl.NumberFormat('ru-RU').format(Math.round(priceInfo.price))} ₽` : '0 ₽',
                vat: priceInfo.vat,
                stock_fit: totalStock,
                length: dims.length || '',
                width: dims.width || '',
                height: dims.height || '',
                weight: dims.weight || '',
                cabinet_url: `https://partner.market.yandex.ru/supplier/${campaignId}/assortment/offer-card?article=${encodeURIComponent(
                    offerId,
                )}&source=businessAssortment`,
                buyer_url: buyerLink,
                updated: ts,
            });
        }
        if (statsDelayMs) await sleep(statsDelayMs);
    }
    logger.log('step:stats:done');

    logger.log('done', { rows: rows.length, updatedAt: ts });
    return { headerKeys, rows, updatedAt: ts, summary: logger.summary() };
}

function rowObjectsToMatrix(headerKeys, rows) {
    return rows.map((obj) => headerKeys.map((k) => obj[k] ?? ''));
}

module.exports = {
    exportOzonRows,
    exportWildberriesRows,
    exportYandexMarketRows,
    rowsToCsvSemicolon,
    rowObjectsToMatrix,
    prettifyMarketplaceVat,
    createMarketplaceLogger,
    MP_MIN_DELAY_MS,
};
