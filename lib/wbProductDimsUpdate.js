'use strict';

/**
 * Обновление габаритов/веса карточки Wildberries по vendorCode (= код МС).
 * WB `/content/v2/cards/update` перезаписывает карточку целиком — сначала читаем
 * `/content/v2/get/cards/list`, меняем `dimensions` (см / кг), шлём update.
 *
 * Лимит WB на update: ~10 req/мин, интервал 6 с (см. OpenAPI Content → cards/update).
 * cards/list: 100/мин, интервал 600 мс.
 */

const {
    axiosWithMarketplaceRateLimit,
    createMarketplaceLogger,
    MP_MIN_DELAY_MS,
} = require('./marketplaceExports');
const { resolveMsDimsForOzonPush, parseDimCm } = require('./ozonProductDimsUpdate');

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

/** Те же габариты МС, что для Ozon (высота: коробка / пакет). */
const resolveMsDimsForWbPush = resolveMsDimsForOzonPush;

function wbAuthHeaders(apiKey) {
    return {
        Authorization: String(apiKey || '').trim(),
        'Content-Type': 'application/json',
    };
}

function nmIdFromUrls(cabinetUrl, buyerUrl) {
    const cab = String(cabinetUrl || '');
    const m1 = cab.match(/[?&]nmID=(\d+)/i);
    if (m1) return Number(m1[1]);
    const buy = String(buyerUrl || '');
    const m2 = buy.match(/\/catalog\/(\d+)\//i);
    if (m2) return Number(m2[1]);
    return null;
}

/** WB Content API: length/width/height — только целые см (2.5 → 3). */
function cmToWbInt(cm) {
    const n = parseDimCm(cm);
    if (n == null) return null;
    return Math.max(1, Math.round(n));
}

function kgToWbWeight(kg) {
    const n = parseDimCm(kg);
    if (n == null) return null;
    return Number(n.toFixed(3));
}

function wbHttpErrorMessage(e) {
    const status = e && e.response && e.response.status;
    const body = e && e.response && e.response.data;
    const detail =
        (body && (body.errorText || body.message || body.detail || body.title)) ||
        (typeof body === 'string' ? body : '') ||
        '';
    if (status === 403) {
        return (
            'WB 403: нет доступа к изменению карточек. Создайте новый API-токен в кабинете WB ' +
            'с категорией «Контент» (запись/изменение карточек), сохраните как wb_api_key в Настройках ' +
            'маркетплейсов и перезапустите Node. Выгрузка (чтение) может работать и без права на запись.' +
            (detail ? ' Ответ WB: ' + String(detail).slice(0, 200) : '')
        );
    }
    if (status === 401) {
        return (
            'WB 401: токен не принят (истёк / неверный / не та категория). Проверьте wb_api_key.' +
            (detail ? ' Ответ WB: ' + String(detail).slice(0, 200) : '')
        );
    }
    const base = (e && e.message) || String(e);
    return detail ? base + ' — ' + String(detail).slice(0, 200) : base;
}

/**
 * Собрать тело для cards/update из карточки list + новых габаритов.
 * @param {object} card
 * @param {{ lengthCm: number, widthCm: number, heightCm: number, weightKg: number }} dims
 */
function buildWbUpdateCard(card, dims) {
    const nmID = Number(card && card.nmID);
    const vendorCode = String((card && card.vendorCode) || '').trim();
    if (!Number.isFinite(nmID) || nmID <= 0 || !vendorCode) {
        const err = new Error('Неполная карточка WB (nmID / vendorCode)');
        err.code = 'WB_INCOMPLETE_CARD';
        throw err;
    }
    const length = cmToWbInt(dims.lengthCm);
    const width = cmToWbInt(dims.widthCm);
    const height = cmToWbInt(dims.heightCm);
    const weightBrutto = kgToWbWeight(dims.weightKg);
    if (length == null || width == null || height == null || weightBrutto == null) {
        const err = new Error('Нужны все габариты МС: длина, ширина, высота, вес');
        err.code = 'MS_DIMS_INCOMPLETE';
        throw err;
    }

    const characteristics = Array.isArray(card.characteristics)
        ? card.characteristics
              .map((c) => {
                  if (!c || c.id == null) return null;
                  return { id: c.id, value: c.value };
              })
              .filter(Boolean)
        : [];

    const sizes = Array.isArray(card.sizes)
        ? card.sizes
              .map((s) => {
                  if (!s) return null;
                  const out = {
                      techSize: s.techSize != null ? String(s.techSize) : '0',
                      skus: Array.isArray(s.skus) ? s.skus.filter(Boolean) : [],
                  };
                  if (s.chrtID != null) out.chrtID = s.chrtID;
                  if (s.wbSize != null && String(s.wbSize).trim() !== '') out.wbSize = String(s.wbSize);
                  return out;
              })
              .filter(Boolean)
        : [];

    const item = {
        nmID,
        vendorCode,
        brand: card.brand != null ? String(card.brand) : '',
        title: String(card.title || '').trim() || vendorCode,
        description: card.description != null ? String(card.description) : '',
        dimensions: { length, width, height, weightBrutto },
        characteristics,
        sizes,
    };
    if (card.needKiz) {
        item.kizMarked = Boolean(card.kizMarked);
    }
    return item;
}

/**
 * Найти карточку по vendorCode (и опционально nmID из cabinet_url).
 */
async function fetchWbCardByVendorCode(apiKey, vendorCode, opts) {
    const logger = (opts && opts.logger) || createMarketplaceLogger('wb-dims');
    const code = String(vendorCode || '').trim();
    if (!code) return null;
    const delayMs = Math.max(
        MP_MIN_DELAY_MS.wbCards || 600,
        Number((opts && opts.delayMs) ?? 600) || 600
    );
    const nmHint = opts && opts.nmIdHint != null ? Number(opts.nmIdHint) : null;
    const textSearch =
        Number.isFinite(nmHint) && nmHint > 0 ? String(nmHint) : code;

    if (delayMs) await sleep(delayMs);
    const { data } = await axiosWithMarketplaceRateLimit(
        {
            method: 'POST',
            url: 'https://content-api.wildberries.ru/content/v2/get/cards/list',
            data: {
                settings: {
                    sort: { ascending: true },
                    cursor: { limit: 100 },
                    filter: { textSearch, withPhoto: -1 },
                },
            },
            headers: wbAuthHeaders(apiKey),
            timeout: 120000,
        },
        logger,
        { maxAttempts: 4 }
    );
    const cards = (data && data.cards) || [];
    let found =
        cards.find((c) => String((c && c.vendorCode) || '').trim() === code) || null;
    if (!found && Number.isFinite(nmHint) && nmHint > 0) {
        found = cards.find((c) => Number(c && c.nmID) === nmHint) || null;
    }
    if (!found && textSearch !== code) {
        if (delayMs) await sleep(delayMs);
        const { data: data2 } = await axiosWithMarketplaceRateLimit(
            {
                method: 'POST',
                url: 'https://content-api.wildberries.ru/content/v2/get/cards/list',
                data: {
                    settings: {
                        sort: { ascending: true },
                        cursor: { limit: 100 },
                        filter: { textSearch: code, withPhoto: -1 },
                    },
                },
                headers: wbAuthHeaders(apiKey),
                timeout: 120000,
            },
            logger,
            { maxAttempts: 4 }
        );
        const cards2 = (data2 && data2.cards) || [];
        found = cards2.find((c) => String((c && c.vendorCode) || '').trim() === code) || null;
    }
    return found;
}

/**
 * @returns {Promise<{
 *   success: boolean,
 *   vendor_code: string,
 *   nm_id?: number,
 *   dims?: object,
 *   error?: string,
 *   code?: string,
 *   dry_run?: boolean,
 *   skipped?: boolean
 * }>}
 */
async function updateWbOfferDimensions(apiKey, opts) {
    const logger = (opts && opts.logger) || createMarketplaceLogger('wb-dims');
    const key = String(apiKey || '').trim();
    if (!key) {
        return { success: false, vendor_code: '', error: 'Не задан WB API key', code: 'MISSING_CREDS' };
    }
    const vendorCode = String((opts && opts.vendorCode) || '').trim();
    const dims = opts && opts.dims;
    if (!vendorCode) {
        return { success: false, vendor_code: '', error: 'vendorCode обязателен', code: 'BAD_VENDOR' };
    }
    if (
        !dims ||
        parseDimCm(dims.lengthCm) == null ||
        parseDimCm(dims.widthCm) == null ||
        parseDimCm(dims.heightCm) == null ||
        parseDimCm(dims.weightKg) == null
    ) {
        return {
            success: false,
            vendor_code: vendorCode,
            error: 'Нужны все габариты МС: длина, ширина, высота, вес',
            code: 'MS_DIMS_INCOMPLETE',
        };
    }
    const delayListMs = Math.max(
        MP_MIN_DELAY_MS.wbCards || 600,
        Number((opts && opts.delayListMs) ?? 600) || 600
    );
    const delayUpdateMs = Math.max(
        6000,
        Number((opts && opts.delayUpdateMs) ?? 6500) || 6500
    );
    const dryRun = Boolean(opts && opts.dryRun);

    try {
        const card = await fetchWbCardByVendorCode(key, vendorCode, {
            logger,
            delayMs: delayListMs,
            nmIdHint: opts && opts.nmIdHint,
        });
        if (!card) {
            return {
                success: false,
                vendor_code: vendorCode,
                skipped: true,
                error: 'Карточка WB не найдена в content API',
                code: 'WB_CARD_NOT_FOUND',
            };
        }
        const item = buildWbUpdateCard(card, {
            lengthCm: parseDimCm(dims.lengthCm),
            widthCm: parseDimCm(dims.widthCm),
            heightCm: parseDimCm(dims.heightCm),
            weightKg: parseDimCm(dims.weightKg),
        });
        const outDims = {
            length_cm: item.dimensions.length,
            width_cm: item.dimensions.width,
            height_cm: item.dimensions.height,
            weight_kg: item.dimensions.weightBrutto,
        };
        if (dryRun) {
            return {
                success: true,
                vendor_code: vendorCode,
                nm_id: item.nmID,
                dry_run: true,
                dims: outDims,
                would_update: true,
            };
        }
        if (opts && opts.skipUpdateDelay) {
            /* batch caller manages pause between update POSTs */
        } else if (delayUpdateMs) {
            await sleep(delayUpdateMs);
        }
        const { data } = await axiosWithMarketplaceRateLimit(
            {
                method: 'POST',
                url: 'https://content-api.wildberries.ru/content/v2/cards/update',
                data: [item],
                headers: wbAuthHeaders(key),
                timeout: 120000,
            },
            logger,
            { maxAttempts: 4, cumWaitBudgetMs: 120000 }
        );
        if (data && data.error) {
            return {
                success: false,
                vendor_code: vendorCode,
                nm_id: item.nmID,
                error: data.errorText || 'WB cards/update error',
                code: 'WB_UPDATE_FAILED',
            };
        }
        return {
            success: true,
            vendor_code: vendorCode,
            nm_id: item.nmID,
            dims: outDims,
        };
    } catch (e) {
        logger.log('update_fail', {
            vendor: vendorCode,
            message: e && e.message ? e.message : String(e),
            status: e && e.response && e.response.status,
        });
        return {
            success: false,
            vendor_code: vendorCode,
            error: wbHttpErrorMessage(e),
            code: (e && e.response && e.response.status === 403)
                ? 'WB_FORBIDDEN'
                : (e && e.code) || 'WB_UPDATE_FAILED',
        };
    }
}

/**
 * Пакетный update: сначала list по каждому vendorCode, затем cards/update чанками.
 * Между чанками update — пауза ≥6 с (лимит WB).
 */
async function updateWbOffersDimensionsBatch(apiKey, items, opts) {
    const logger = (opts && opts.logger) || createMarketplaceLogger('wb-dims');
    const key = String(apiKey || '').trim();
    const list = Array.isArray(items) ? items : [];
    const delayListMs = Math.max(
        MP_MIN_DELAY_MS.wbCards || 600,
        Number((opts && opts.delayListMs) ?? 600) || 600
    );
    const delayUpdateMs = Math.max(6000, Number((opts && opts.delayUpdateMs) ?? 6500) || 6500);
    const updateChunk = Math.max(1, Math.min(100, Number((opts && opts.updateChunk) ?? 50) || 50));
    const dryRun = Boolean(opts && opts.dryRun);

    logger.log('batch:start', {
        total: list.length,
        dryRun,
        delayListMs,
        delayUpdateMs,
        updateChunk,
    });

    const results = [];
    const toUpdate = [];

    for (let idx = 0; idx < list.length; idx += 1) {
        const it = list[idx];
        const vendorCode = String((it && it.vendorCode) || '').trim();
        const dims = it && it.dims;
        if (!vendorCode) {
            results.push({ success: false, vendor_code: '', error: 'vendorCode обязателен', code: 'BAD_VENDOR' });
            continue;
        }
        if (
            !dims ||
            parseDimCm(dims.lengthCm) == null ||
            parseDimCm(dims.widthCm) == null ||
            parseDimCm(dims.heightCm) == null ||
            parseDimCm(dims.weightKg) == null
        ) {
            results.push({
                success: false,
                vendor_code: vendorCode,
                skipped: true,
                error: 'Неполные габариты МС',
                code: 'MS_DIMS_INCOMPLETE',
            });
            continue;
        }
        try {
            const card = await fetchWbCardByVendorCode(key, vendorCode, {
                logger,
                delayMs: delayListMs,
                nmIdHint: it.nmIdHint,
            });
            if (!card) {
                results.push({
                    success: false,
                    vendor_code: vendorCode,
                    skipped: true,
                    error: 'Карточка WB не найдена',
                    code: 'WB_CARD_NOT_FOUND',
                });
                continue;
            }
            const item = buildWbUpdateCard(card, {
                lengthCm: parseDimCm(dims.lengthCm),
                widthCm: parseDimCm(dims.widthCm),
                heightCm: parseDimCm(dims.heightCm),
                weightKg: parseDimCm(dims.weightKg),
            });
            const outDims = {
                length_cm: item.dimensions.length,
                width_cm: item.dimensions.width,
                height_cm: item.dimensions.height,
                weight_kg: item.dimensions.weightBrutto,
            };
            if (dryRun) {
                results.push({
                    success: true,
                    vendor_code: vendorCode,
                    nm_id: item.nmID,
                    dry_run: true,
                    dims: outDims,
                });
                continue;
            }
            toUpdate.push({ vendorCode, item, outDims });
        } catch (e) {
            results.push({
                success: false,
                vendor_code: vendorCode,
                error: (e && e.message) || String(e),
                code: (e && e.code) || 'WB_PREPARE_FAILED',
            });
        }
        if ((idx + 1) % 25 === 0 || idx + 1 === list.length) {
            logger.log('batch:prepare', {
                done: idx + 1,
                of: list.length,
                toUpdate: toUpdate.length,
            });
        }
    }

    logger.log('batch:prepare_done', { toUpdate: toUpdate.length, otherResults: results.length });

    let updateOk = 0;
    let updateFail = 0;
    const updateChunksTotal = Math.ceil(toUpdate.length / updateChunk) || 0;

    for (let i = 0; i < toUpdate.length; i += updateChunk) {
        const chunk = toUpdate.slice(i, i + updateChunk);
        const chunkIdx = Math.floor(i / updateChunk) + 1;
        if (i > 0 || (opts && opts.forceUpdateDelay)) {
            await sleep(delayUpdateMs);
        } else if (i === 0) {
            await sleep(Math.min(delayUpdateMs, 1500));
        }
        logger.log('batch:update_chunk', {
            chunk: chunkIdx,
            of: updateChunksTotal,
            size: chunk.length,
        });
        try {
            const { data } = await axiosWithMarketplaceRateLimit(
                {
                    method: 'POST',
                    url: 'https://content-api.wildberries.ru/content/v2/cards/update',
                    data: chunk.map((c) => c.item),
                    headers: wbAuthHeaders(key),
                    timeout: 180000,
                },
                logger,
                { maxAttempts: 4, cumWaitBudgetMs: 180000 }
            );
            const failed = Boolean(data && data.error);
            const errText = (data && data.errorText) || 'WB cards/update error';
            for (const c of chunk) {
                if (failed) {
                    updateFail += 1;
                    results.push({
                        success: false,
                        vendor_code: c.vendorCode,
                        nm_id: c.item.nmID,
                        error: errText,
                        code: 'WB_UPDATE_FAILED',
                    });
                } else {
                    updateOk += 1;
                    results.push({
                        success: true,
                        vendor_code: c.vendorCode,
                        nm_id: c.item.nmID,
                        dims: c.outDims,
                    });
                }
            }
            logger.log(failed ? 'batch:update_chunk_fail' : 'batch:update_chunk_ok', {
                chunk: chunkIdx,
                of: updateChunksTotal,
                size: chunk.length,
                error: failed ? String(errText).slice(0, 200) : undefined,
            });
        } catch (e) {
            const msg = wbHttpErrorMessage(e);
            const code =
                e && e.response && e.response.status === 403
                    ? 'WB_FORBIDDEN'
                    : (e && e.code) || 'WB_UPDATE_FAILED';
            logger.log('batch:update_chunk_fail', {
                chunk: chunkIdx,
                of: updateChunksTotal,
                size: chunk.length,
                status: e && e.response && e.response.status,
                message: String(msg).slice(0, 240),
            });
            for (const c of chunk) {
                updateFail += 1;
                results.push({
                    success: false,
                    vendor_code: c.vendorCode,
                    nm_id: c.item.nmID,
                    error: msg,
                    code,
                });
            }
        }
    }

    logger.log('batch:done', {
        total: list.length,
        updateOk,
        updateFail,
        results: results.length,
    });

    return results;
}

async function patchLocalWbDims(db, vendorCode, dims) {
    if (!db || typeof db.query !== 'function') return;
    const code = String(vendorCode || '').trim();
    if (!code || !dims) return;
    const length = Number(dims.length_cm).toFixed(1);
    const width = Number(dims.width_cm).toFixed(1);
    const height = Number(dims.height_cm).toFixed(1);
    const weight = Number(dims.weight_kg).toFixed(3);
    await db.query(
        `UPDATE marketplace_export_rows
         SET length_cm = ?, width_cm = ?, height_cm = ?, weight_kg = ?,
             updated_label = ?, updated_at = CURRENT_TIMESTAMP
         WHERE marketplace = 'wildberries' AND external_id = ?`,
        [length, width, height, weight, 'WB dims ← МС', code]
    );
}

module.exports = {
    resolveMsDimsForWbPush,
    nmIdFromUrls,
    wbAuthHeaders,
    wbHttpErrorMessage,
    buildWbUpdateCard,
    fetchWbCardByVendorCode,
    updateWbOfferDimensions,
    updateWbOffersDimensionsBatch,
    patchLocalWbDims,
};
