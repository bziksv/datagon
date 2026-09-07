'use strict';

/**
 * Обновление НДС оффера Яндекс Маркета.
 * POST /v2/campaigns/{campaignId}/offers/update — body { offers: [{ offerId, vat }] }.
 * Нужны ym_api_key + ym_campaign_id.
 */

const {
    axiosWithMarketplaceRateLimit,
    createMarketplaceLogger,
    MP_MIN_DELAY_MS,
} = require('./marketplaceExports');
const { parseMsVat, msVatToYmVatId } = require('./mpVatConvert');

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

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
            '(all-methods), укажите верный ym_campaign_id, сохраните ym_api_key и перезапустите Node. ' +
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

/**
 * @param {{ apiKey: string, campaignId: string }} creds
 * @param {Array<{ offerId: string, msVat: * }>} items
 */
async function updateYmOffersVatBatch(creds, items, opts) {
    const logger = (opts && opts.logger) || createMarketplaceLogger('ym-vat');
    const apiKey = String((creds && creds.apiKey) || '').trim();
    const campaignId = String((creds && creds.campaignId) || '').trim();
    const list = Array.isArray(items) ? items : [];
    const delayMs = Math.max(
        MP_MIN_DELAY_MS.yandex || 200,
        Number((opts && opts.delayMs) ?? 280) || 280
    );
    const chunkSize = Math.max(1, Math.min(100, Number((opts && opts.chunkSize) ?? 100) || 100));
    const dryRun = Boolean(opts && opts.dryRun);

    if (!apiKey || !campaignId) {
        return list.map((it) => ({
            success: false,
            offer_id: String((it && it.offerId) || ''),
            error: 'Не заданы ym_api_key / ym_campaign_id',
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
        const parsed = parseMsVat(it && it.msVat);
        const vatId = msVatToYmVatId(it && it.msVat);
        if (!parsed.ok || vatId == null) {
            results.push({
                success: false,
                offer_id: offerId,
                skipped: true,
                error: (parsed && parsed.error) || 'НДС МС не поддерживается Я.Маркет',
                code: 'MS_VAT_UNSUPPORTED',
            });
            continue;
        }
        if (dryRun) {
            results.push({
                success: true,
                offer_id: offerId,
                dry_run: true,
                vat: parsed.pretty,
                vat_id: vatId,
            });
            continue;
        }
        prepared.push({ offerId, vatId, pretty: parsed.pretty });
    }

    async function postChunk(chunk) {
        const body = {
            offers: chunk.map((c) => ({
                offerId: c.offerId,
                vat: c.vatId,
            })),
        };
        const { data } = await axiosWithMarketplaceRateLimit(
            {
                method: 'POST',
                url:
                    'https://api.partner.market.yandex.ru/v2/campaigns/' +
                    encodeURIComponent(campaignId) +
                    '/offers/update',
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

    for (let i = 0; i < prepared.length; i += chunkSize) {
        const chunk = prepared.slice(i, i + chunkSize);
        if (i > 0 && delayMs) await sleep(delayMs);
        try {
            const data = await postChunk(chunk);
            const status = String((data && data.status) || 'OK').toUpperCase();
            if (status === 'ERROR') {
                logger.log('chunk_error_retry_one', { size: chunk.length });
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
                                vat: one.pretty,
                                vat_id: one.vatId,
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
                        vat: c.pretty,
                        vat_id: c.vatId,
                    });
                }
            }
        } catch (e) {
            const st = e && e.response && e.response.status;
            const msg = ymHttpErrorMessage(e);
            logger.log('update_fail', {
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

    return results;
}

async function patchLocalYmVat(db, offerId, prettyVat) {
    if (!db || typeof db.query !== 'function') return;
    const offer = String(offerId || '').trim();
    const vat = String(prettyVat == null ? '' : prettyVat).trim();
    if (!offer || !vat) return;
    await db.query(
        `UPDATE marketplace_export_rows
         SET vat = ?, updated_label = ?, updated_at = CURRENT_TIMESTAMP
         WHERE marketplace = 'yandex_market' AND external_id = ?`,
        [vat, 'YM НДС ← МС', offer]
    );
}

module.exports = {
    updateYmOffersVatBatch,
    patchLocalYmVat,
};
