'use strict';

/**
 * Обновление габаритов/веса оффера Яндекс Маркета по shopSku (= код МС).
 * POST /v2/businesses/{businessId}/offer-mappings/update с partial
 * `offer.offerId` + `offer.weightDimensions` (см / кг).
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

const resolveMsDimsForYmPush = resolveMsDimsForOzonPush;

function ymHeaders(apiKey) {
    return {
        'Api-Key': String(apiKey || '').trim(),
        'Content-Type': 'application/json',
    };
}

function ymHttpErrorMessage(e) {
    const status = e && e.response && e.response.status;
    const body = e && e.response && e.response.data;
    let detail = '';
    if (body && typeof body === 'object') {
        const errs = Array.isArray(body.errors) ? body.errors : [];
        detail =
            errs
                .map((x) => (x && (x.message || x.code)) || '')
                .filter(Boolean)
                .join('; ') ||
            body.message ||
            body.error ||
            '';
    } else if (typeof body === 'string') {
        detail = body;
    }
    if (status === 403) {
        return (
            'Я.Маркет 403: нет доступа к изменению офферов. В кабинете партнёра создайте API-Key ' +
            'с правом «Управление товарами и карточками» (offers-and-cards-management) или «Полное управление» ' +
            '(all-methods), укажите верный ym_business_id, сохраните ym_api_key и перезапустите Node. ' +
            'Выгрузка цен/остатков может работать и с read-only ключом.' +
            (detail ? ' Ответ YM: ' + String(detail).slice(0, 240) : '')
        );
    }
    if (status === 401) {
        return (
            'Я.Маркет 401: Api-Key не принят (истёк / неверный). Проверьте ym_api_key.' +
            (detail ? ' Ответ YM: ' + String(detail).slice(0, 240) : '')
        );
    }
    const base = (e && e.message) || String(e);
    return detail ? base + ' — ' + String(detail).slice(0, 240) : base;
}

function toYmDim(cm) {
    const n = parseDimCm(cm);
    if (n == null) return null;
    return Number(n.toFixed(3));
}

function buildWeightDimensions(dims) {
    const length = toYmDim(dims.lengthCm);
    const width = toYmDim(dims.widthCm);
    const height = toYmDim(dims.heightCm);
    const weight = toYmDim(dims.weightKg);
    if (length == null || width == null || height == null || weight == null) return null;
    if (length <= 0 || width <= 0 || height <= 0 || weight <= 0) return null;
    return { length, width, height, weight };
}

/**
 * Пакетный update габаритов.
 * @param {{ apiKey: string, businessId: string }} creds
 * @param {Array<{ offerId: string, dims: object }>} items
 * @returns {Promise<Array<{ success: boolean, offer_id: string, dims?: object, error?: string, code?: string }>>}
 */
async function updateYmOffersDimensionsBatch(creds, items, opts) {
    const logger = (opts && opts.logger) || createMarketplaceLogger('ym-dims');
    const apiKey = String((creds && creds.apiKey) || '').trim();
    const businessId = String((creds && creds.businessId) || '').trim();
    const list = Array.isArray(items) ? items : [];
    const delayMs = Math.max(
        MP_MIN_DELAY_MS.yandex || 200,
        Number((opts && opts.delayMs) ?? 280) || 280
    );
    const chunkSize = Math.max(1, Math.min(100, Number((opts && opts.chunkSize) ?? 100) || 100));
    const dryRun = Boolean(opts && opts.dryRun);

    if (!apiKey || !businessId) {
        return list.map((it) => ({
            success: false,
            offer_id: String((it && it.offerId) || ''),
            error: 'Не заданы ym_api_key / ym_business_id',
            code: 'MISSING_CREDS',
        }));
    }

    const prepared = [];
    const results = [];

    for (const it of list) {
        const offerId = String((it && it.offerId) || '').trim();
        if (!offerId) {
            results.push({ success: false, offer_id: '', error: 'offerId обязателен', code: 'BAD_OFFER' });
            continue;
        }
        const wd = buildWeightDimensions(it.dims || {});
        if (!wd) {
            results.push({
                success: false,
                offer_id: offerId,
                skipped: true,
                error: 'Неполные габариты МС',
                code: 'MS_DIMS_INCOMPLETE',
            });
            continue;
        }
        const outDims = {
            length_cm: wd.length,
            width_cm: wd.width,
            height_cm: wd.height,
            weight_kg: wd.weight,
        };
        if (dryRun) {
            results.push({
                success: true,
                offer_id: offerId,
                dry_run: true,
                dims: outDims,
            });
            continue;
        }
        prepared.push({ offerId, wd, outDims });
    }

    async function postChunk(chunk) {
        const body = {
            offerMappings: chunk.map((c) => ({
                offer: {
                    offerId: c.offerId,
                    weightDimensions: c.wd,
                },
            })),
        };
        const { data } = await axiosWithMarketplaceRateLimit(
            {
                method: 'POST',
                url:
                    'https://api.partner.market.yandex.ru/v2/businesses/' +
                    encodeURIComponent(businessId) +
                    '/offer-mappings/update',
                data: body,
                headers: ymHeaders(apiKey),
                timeout: 180000,
            },
            logger,
            { maxAttempts: 4, cumWaitBudgetMs: 120000 }
        );
        return data || {};
    }

    function formatYmErrors(entry) {
        const errs = (entry && entry.errors) || [];
        if (!Array.isArray(errs) || !errs.length) return '';
        return errs
            .map((e) => (e && (e.message || e.code || e.type)) || String(e))
            .filter(Boolean)
            .join('; ');
    }

    logger.log('batch:start', { total: list.length, prepared: prepared.length, chunkSize, dryRun });

    for (let i = 0; i < prepared.length; i += chunkSize) {
        const chunk = prepared.slice(i, i + chunkSize);
        const chunkIdx = Math.floor(i / chunkSize) + 1;
        const chunksTotal = Math.ceil(prepared.length / chunkSize) || 0;
        if (i > 0 && delayMs) await sleep(delayMs);
        logger.log('batch:chunk', { chunk: chunkIdx, of: chunksTotal, size: chunk.length });
        try {
            const data = await postChunk(chunk);
            const status = String((data && data.status) || 'OK').toUpperCase();
            if (status === 'ERROR') {
                /* Весь пакет отвергнут — шлём по одному, чтобы годные всё же записались. */
                logger.log('chunk_error_retry_one', { chunk: chunkIdx, size: chunk.length });
                for (let j = 0; j < chunk.length; j++) {
                    const one = chunk[j];
                    if (j > 0 && delayMs) await sleep(delayMs);
                    try {
                        const oneData = await postChunk([one]);
                        const oneStatus = String((oneData && oneData.status) || 'OK').toUpperCase();
                        const oneRes = ((oneData && oneData.results) || []).find(
                            (r) => String(r.offerId || '') === one.offerId
                        );
                        const errText = formatYmErrors(oneRes);
                        if (oneStatus === 'ERROR' || errText) {
                            results.push({
                                success: false,
                                offer_id: one.offerId,
                                error: errText || 'YM update ERROR',
                                code: 'YM_UPDATE_FAILED',
                            });
                        } else {
                            results.push({
                                success: true,
                                offer_id: one.offerId,
                                dims: one.outDims,
                            });
                        }
                    } catch (eOne) {
                        const st = eOne && eOne.response && eOne.response.status;
                        results.push({
                            success: false,
                            offer_id: one.offerId,
                            error: ymHttpErrorMessage(eOne),
                            code:
                                st === 403
                                    ? 'YM_FORBIDDEN'
                                    : (eOne && eOne.code) || 'YM_UPDATE_FAILED',
                        });
                    }
                }
            } else {
                for (const c of chunk) {
                    results.push({
                        success: true,
                        offer_id: c.offerId,
                        dims: c.outDims,
                    });
                }
                logger.log('batch:chunk_ok', { chunk: chunkIdx, of: chunksTotal, size: chunk.length });
            }
        } catch (e) {
            const st = e && e.response && e.response.status;
            const msg = ymHttpErrorMessage(e);
            logger.log('update_fail', {
                chunk: chunkIdx,
                count: chunk.length,
                message: msg,
                status: st,
            });
            for (const c of chunk) {
                results.push({
                    success: false,
                    offer_id: c.offerId,
                    error: msg,
                    code: st === 403 ? 'YM_FORBIDDEN' : (e && e.code) || 'YM_UPDATE_FAILED',
                });
            }
        }
    }

    const ok = results.filter((r) => r && r.success).length;
    const fail = results.filter((r) => r && !r.success && !r.skipped).length;
    logger.log('batch:done', { total: list.length, ok, fail, results: results.length });

    return results;
}

async function patchLocalYmDims(db, offerId, dims) {
    if (!db || typeof db.query !== 'function') return;
    const offer = String(offerId || '').trim();
    if (!offer || !dims) return;
    const length = Number(dims.length_cm).toFixed(1);
    const width = Number(dims.width_cm).toFixed(1);
    const height = Number(dims.height_cm).toFixed(1);
    const weight = Number(dims.weight_kg).toFixed(3);
    await db.query(
        `UPDATE marketplace_export_rows
         SET length_cm = ?, width_cm = ?, height_cm = ?, weight_kg = ?,
             updated_label = ?, updated_at = CURRENT_TIMESTAMP
         WHERE marketplace = 'yandex_market' AND external_id = ?`,
        [length, width, height, weight, 'YM dims ← МС', offer]
    );
}

module.exports = {
    resolveMsDimsForYmPush,
    buildWeightDimensions,
    updateYmOffersDimensionsBatch,
    patchLocalYmDims,
};
