'use strict';

/**
 * Обновление НДС карточки Ozon по offer_id.
 * Ozon import требует полную карточку — читаем attributes+info, сохраняем текущие
 * габариты/вес из Ozon, меняем только vat из МС.
 */

const {
    axiosWithMarketplaceRateLimit,
    createMarketplaceLogger,
    MP_MIN_DELAY_MS,
} = require('./marketplaceExports');
const {
    ozonHeaders,
    buildImportItem,
    fetchOzonCardByOfferId,
    waitOzonImportTask,
} = require('./ozonProductDimsUpdate');
const { parseMsVat, msVatToOzonApi } = require('./mpVatConvert');

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

/**
 * Текущие габариты Ozon (attr/info: mm / g) → cm / kg для buildImportItem.
 */
function dimsFromOzonCard(attr, info) {
    const depthMm = Number(
        (attr && attr.depth != null ? attr.depth : null) ??
            (info && info.depth != null ? info.depth : null)
    );
    const widthMm = Number(
        (attr && attr.width != null ? attr.width : null) ??
            (info && info.width != null ? info.width : null)
    );
    const heightMm = Number(
        (attr && attr.height != null ? attr.height : null) ??
            (info && info.height != null ? info.height : null)
    );
    const weightG = Number(
        (attr && attr.weight != null ? attr.weight : null) ??
            (info && info.weight != null ? info.weight : null)
    );
    if (
        !Number.isFinite(depthMm) ||
        depthMm <= 0 ||
        !Number.isFinite(widthMm) ||
        widthMm <= 0 ||
        !Number.isFinite(heightMm) ||
        heightMm <= 0 ||
        !Number.isFinite(weightG) ||
        weightG <= 0
    ) {
        return null;
    }
    return {
        lengthCm: depthMm / 10,
        widthCm: widthMm / 10,
        heightCm: heightMm / 10,
        weightKg: weightG / 1000,
    };
}

/**
 * @returns {Promise<{
 *   success: boolean,
 *   offer_id: string,
 *   vat?: string,
 *   vat_api?: string,
 *   task_id?: number,
 *   import_status?: string,
 *   error?: string,
 *   code?: string,
 *   dry_run?: boolean,
 *   skipped?: boolean
 * }>}
 */
async function updateOzonOfferVat(creds, opts) {
    const logger = (opts && opts.logger) || createMarketplaceLogger('ozon-vat');
    const clientId = String(creds.clientId || '').trim();
    const apiKey = String(creds.apiKey || '').trim();
    if (!clientId || !apiKey) {
        return { success: false, offer_id: '', error: 'Не заданы ключи Ozon', code: 'MISSING_CREDS' };
    }
    const offerId = String((opts && opts.offerId) || '').trim();
    const msVat = opts && opts.msVat;
    if (!offerId) {
        return { success: false, offer_id: '', error: 'offer_id обязателен', code: 'BAD_OFFER' };
    }
    const parsed = parseMsVat(msVat);
    const vatApi = msVatToOzonApi(msVat);
    if (!parsed.ok || vatApi == null) {
        return {
            success: false,
            offer_id: offerId,
            skipped: true,
            error: (parsed && parsed.error) || 'НДС МС не поддерживается Ozon',
            code: 'MS_VAT_UNSUPPORTED',
        };
    }
    const delayMs = Math.max(
        MP_MIN_DELAY_MS.ozon || 200,
        Number((opts && opts.delayMs) ?? 400) || 400
    );
    const dryRun = Boolean(opts && opts.dryRun);
    try {
        const { info, attr } = await fetchOzonCardByOfferId(creds, offerId, logger, delayMs);
        const dims = dimsFromOzonCard(attr, info);
        if (!dims) {
            return {
                success: false,
                offer_id: offerId,
                error: 'У карточки Ozon нет габаритов/веса — import без них невозможен',
                code: 'OZON_NO_DIMS',
            };
        }
        const item = buildImportItem(attr, info, dims);
        item.vat = vatApi;
        if (dryRun) {
            return {
                success: true,
                offer_id: offerId,
                dry_run: true,
                vat: parsed.pretty,
                vat_api: vatApi,
                would_update: true,
            };
        }
        if (delayMs) await sleep(delayMs);
        const headers = ozonHeaders(creds);
        const importRes = await axiosWithMarketplaceRateLimit(
            {
                method: 'POST',
                url: 'https://api-seller.ozon.ru/v3/product/import',
                data: { items: [item] },
                headers,
                timeout: 120000,
            },
            logger,
            { maxAttempts: 4 }
        );
        const taskId = Number(
            importRes.data && importRes.data.result && importRes.data.result.task_id
        );
        let importStatus = 'submitted';
        let importErrors = null;
        if (Number.isFinite(taskId) && taskId > 0 && opts && opts.waitTask !== false) {
            const taskInfo = await waitOzonImportTask(creds, taskId, logger, delayMs);
            const items = (taskInfo && taskInfo.result && taskInfo.result.items) || [];
            const mine = items.find((it) => String(it.offer_id || '') === offerId) || items[0];
            if (mine) {
                importStatus = String(mine.status || importStatus);
                if (Array.isArray(mine.errors) && mine.errors.length) {
                    importErrors = mine.errors
                        .map((e) => (e && (e.message || e.code)) || String(e))
                        .filter(Boolean)
                        .join('; ');
                }
            }
        }
        const failed =
            /fail|error|rejected/i.test(importStatus) ||
            (importErrors && String(importErrors).trim() !== '');
        if (failed) {
            return {
                success: false,
                offer_id: offerId,
                task_id: Number.isFinite(taskId) ? taskId : undefined,
                import_status: importStatus,
                error: importErrors || ('Ozon import status: ' + importStatus),
                code: 'OZON_IMPORT_FAILED',
            };
        }
        return {
            success: true,
            offer_id: offerId,
            task_id: Number.isFinite(taskId) ? taskId : undefined,
            import_status: importStatus,
            vat: parsed.pretty,
            vat_api: vatApi,
        };
    } catch (e) {
        const ozonMsg =
            e && e.response && e.response.data
                ? JSON.stringify(e.response.data).slice(0, 500)
                : '';
        return {
            success: false,
            offer_id: offerId,
            error: (e && e.message ? e.message : String(e)) + (ozonMsg ? ' | ' + ozonMsg : ''),
            code: (e && e.code) || 'OZON_UPDATE_FAILED',
        };
    }
}

async function patchLocalOzonVat(db, offerId, prettyVat) {
    if (!db || typeof db.query !== 'function') return;
    const offer = String(offerId || '').trim();
    const vat = String(prettyVat == null ? '' : prettyVat).trim();
    if (!offer || !vat) return;
    await db.query(
        `UPDATE marketplace_export_rows
         SET vat = ?, updated_label = ?, updated_at = CURRENT_TIMESTAMP
         WHERE marketplace = 'ozon' AND external_id = ?`,
        [vat, 'Ozon НДС ← МС', offer]
    );
}

module.exports = {
    dimsFromOzonCard,
    updateOzonOfferVat,
    patchLocalOzonVat,
};
