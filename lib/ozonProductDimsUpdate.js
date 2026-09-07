'use strict';

/**
 * Обновление габаритов/веса карточки Ozon по offer_id.
 * Ozon не даёт partial update для depth/width/height/weight — берём текущую карточку
 * из /v4/product/info/attributes + цену/НДС из /v3/product/info/list и шлём /v3/product/import
 * с новыми объёмно-весовыми полями (из МС, см/кг → mm/g).
 */

const {
    axiosWithMarketplaceRateLimit,
    createMarketplaceLogger,
    MP_MIN_DELAY_MS,
} = require('./marketplaceExports');

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

function parseDimCm(v) {
    if (v == null || v === '') return null;
    const n = parseFloat(String(v).trim().replace(',', '.').replace(/\s/g, ''));
    return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Высота для Ozon: одна. Предпочитаем коробку, для «пакет» — высоту пакета.
 * @param {{ ms_height_box?: *, ms_height_bag?: *, ms_packing_type?: * }} row
 */
function pickMsHeightCmForOzon(row) {
    const box = parseDimCm(row && row.ms_height_box);
    const bag = parseDimCm(row && row.ms_height_bag);
    const pt = String((row && row.ms_packing_type) || '').toLowerCase();
    if (/пакет|bag|мягк/.test(pt) && bag != null) return bag;
    if (box != null) return box;
    if (bag != null) return bag;
    return null;
}

/**
 * @param {object} row — строка /issues (ms_* + ozon_code)
 * @returns {{ lengthCm: number, widthCm: number, heightCm: number, weightKg: number }|null}
 */
function resolveMsDimsForOzonPush(row) {
    const lengthCm = parseDimCm(row && row.ms_length);
    const widthCm = parseDimCm(row && row.ms_width);
    const heightCm = pickMsHeightCmForOzon(row);
    const weightKg = parseDimCm(row && row.ms_weight);
    if (lengthCm == null || widthCm == null || heightCm == null || weightKg == null) return null;
    return { lengthCm, widthCm, heightCm, weightKg };
}

function ozonHeaders(creds) {
    return {
        'Client-Id': String(creds.clientId || '').trim(),
        'Api-Key': String(creds.apiKey || '').trim(),
        'Content-Type': 'application/json',
    };
}

function cmToMm(cm) {
    return Math.max(1, Math.round(Number(cm) * 10));
}

function kgToG(kg) {
    return Math.max(1, Math.round(Number(kg) * 1000));
}

function normalizeImages(attr, info) {
    let images = Array.isArray(attr && attr.images) ? attr.images.filter(Boolean) : [];
    if (!images.length && info && Array.isArray(info.images)) {
        images = info.images.filter(Boolean);
    }
    if (!images.length && info) {
        const pi = info.primary_image;
        if (Array.isArray(pi) && pi[0]) images = [pi[0]];
        else if (typeof pi === 'string' && pi.trim()) images = [pi.trim()];
    }
    if (!images.length && attr && attr.primary_image) {
        const pi = attr.primary_image;
        if (Array.isArray(pi) && pi[0]) images = [pi[0]];
        else if (typeof pi === 'string' && pi.trim()) images = [pi.trim()];
    }
    return images;
}

function buildImportItem(attr, info, dims) {
    const images = normalizeImages(attr, info);
    if (!images.length) {
        const err = new Error('У карточки Ozon нет изображений — import без images не принимается');
        err.code = 'OZON_NO_IMAGES';
        throw err;
    }
    const offerId = String((attr && attr.offer_id) || (info && info.offer_id) || '').trim();
    const name = String((attr && attr.name) || (info && info.name) || '').trim();
    const descriptionCategoryId = Number(
        (attr && attr.description_category_id) || (info && info.description_category_id) || 0
    );
    const typeId = Number((attr && attr.type_id) || (info && info.type_id) || 0);
    if (!offerId || !name || !descriptionCategoryId || !typeId) {
        const err = new Error('Неполная карточка Ozon (offer_id / name / category / type)');
        err.code = 'OZON_INCOMPLETE_CARD';
        throw err;
    }
    const item = {
        offer_id: offerId,
        name,
        description_category_id: descriptionCategoryId,
        type_id: typeId,
        attributes: Array.isArray(attr.attributes) ? attr.attributes : [],
        complex_attributes: Array.isArray(attr.complex_attributes) ? attr.complex_attributes : [],
        images,
        depth: cmToMm(dims.lengthCm),
        width: cmToMm(dims.widthCm),
        height: cmToMm(dims.heightCm),
        dimension_unit: 'mm',
        weight: kgToG(dims.weightKg),
        weight_unit: 'g',
        price: String((info && info.price) != null ? info.price : ''),
        vat: String((info && info.vat) != null ? info.vat : '0'),
        currency_code: String((info && info.currency_code) || 'RUB'),
    };
    if (!item.price) {
        const err = new Error('В карточке Ozon нет цены — import без price не принимается');
        err.code = 'OZON_NO_PRICE';
        throw err;
    }
    const barcode = attr && attr.barcode != null ? String(attr.barcode).trim() : '';
    if (barcode) item.barcode = barcode;
    if (Array.isArray(attr.barcodes) && attr.barcodes.length) item.barcodes = attr.barcodes;
    if (info && info.old_price != null && String(info.old_price).trim() !== '') {
        item.old_price = String(info.old_price);
    }
    if (attr.primary_image) item.primary_image = attr.primary_image;
    if (attr.color_image) item.color_image = attr.color_image;
    if (Array.isArray(attr.pdf_list)) item.pdf_list = attr.pdf_list;
    return item;
}

async function fetchOzonCardByOfferId(creds, offerId, logger, delayMs) {
    const headers = ozonHeaders(creds);
    const offer = String(offerId || '').trim();
    if (!offer) {
        const err = new Error('offer_id пустой');
        err.code = 'BAD_OFFER';
        throw err;
    }
    const infoRes = await axiosWithMarketplaceRateLimit(
        {
            method: 'POST',
            url: 'https://api-seller.ozon.ru/v3/product/info/list',
            data: { offer_id: [offer], language: 'DEFAULT' },
            headers,
            timeout: 120000,
        },
        logger,
        { maxAttempts: 6 }
    );
    const info = (infoRes.data && infoRes.data.items && infoRes.data.items[0]) || null;
    if (!info) {
        const err = new Error('Товар не найден в Ozon по offer_id=' + offer);
        err.code = 'OZON_NOT_FOUND';
        throw err;
    }
    if (delayMs) await sleep(delayMs);
    const attrRes = await axiosWithMarketplaceRateLimit(
        {
            method: 'POST',
            url: 'https://api-seller.ozon.ru/v4/product/info/attributes',
            data: { filter: { offer_id: [offer] }, limit: 1 },
            headers,
            timeout: 120000,
        },
        logger,
        { maxAttempts: 6 }
    );
    const attr = (attrRes.data && attrRes.data.result && attrRes.data.result[0]) || null;
    if (!attr) {
        const err = new Error('Не удалось прочитать attributes Ozon для offer_id=' + offer);
        err.code = 'OZON_NO_ATTRS';
        throw err;
    }
    return { info, attr };
}

async function waitOzonImportTask(creds, taskId, logger, delayMs) {
    const headers = ozonHeaders(creds);
    const tid = Number(taskId);
    let last = null;
    for (let attempt = 0; attempt < 25; attempt += 1) {
        if (attempt > 0) await sleep(Math.max(delayMs || 400, 800));
        const { data } = await axiosWithMarketplaceRateLimit(
            {
                method: 'POST',
                url: 'https://api-seller.ozon.ru/v1/product/import/info',
                data: { task_id: tid },
                headers,
                timeout: 60000,
            },
            logger,
            { maxAttempts: 4 }
        );
        last = data;
        const items = (data && data.result && data.result.items) || [];
        if (!items.length) continue;
        const pending = items.some((it) => {
            const st = String(it.status || '').toLowerCase();
            return st === 'pending' || st === 'processing' || st === '';
        });
        if (!pending) return data;
    }
    return last;
}

/**
 * @returns {Promise<{
 *   success: boolean,
 *   offer_id: string,
 *   task_id?: number,
 *   dims?: object,
 *   import_status?: string,
 *   error?: string,
 *   code?: string,
 *   skipped?: boolean
 * }>}
 */
async function updateOzonOfferDimensions(creds, opts) {
    const logger = (opts && opts.logger) || createMarketplaceLogger('ozon-dims');
    const clientId = String(creds.clientId || '').trim();
    const apiKey = String(creds.apiKey || '').trim();
    if (!clientId || !apiKey) {
        return { success: false, offer_id: '', error: 'Не заданы ключи Ozon', code: 'MISSING_CREDS' };
    }
    const offerId = String((opts && opts.offerId) || '').trim();
    const dims = opts && opts.dims;
    if (!offerId) {
        return { success: false, offer_id: '', error: 'offer_id обязателен', code: 'BAD_OFFER' };
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
            offer_id: offerId,
            error: 'Нужны все габариты МС: длина, ширина, высота, вес',
            code: 'MS_DIMS_INCOMPLETE',
        };
    }
    const delayMs = Math.max(
        MP_MIN_DELAY_MS.ozon || 200,
        Number((opts && opts.delayMs) ?? 400) || 400
    );
    const dryRun = Boolean(opts && opts.dryRun);
    try {
        const { info, attr } = await fetchOzonCardByOfferId(creds, offerId, logger, delayMs);
        const item = buildImportItem(attr, info, {
            lengthCm: parseDimCm(dims.lengthCm),
            widthCm: parseDimCm(dims.widthCm),
            heightCm: parseDimCm(dims.heightCm),
            weightKg: parseDimCm(dims.weightKg),
        });
        if (dryRun) {
            return {
                success: true,
                offer_id: offerId,
                dry_run: true,
                dims: {
                    length_cm: Number(dims.lengthCm),
                    width_cm: Number(dims.widthCm),
                    height_cm: Number(dims.heightCm),
                    weight_kg: Number(dims.weightKg),
                    depth_mm: item.depth,
                    width_mm: item.width,
                    height_mm: item.height,
                    weight_g: item.weight,
                },
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
            logger.log('offer:fail', {
                offer_id: offerId,
                task_id: Number.isFinite(taskId) ? taskId : undefined,
                import_status: importStatus,
                error: importErrors || importStatus,
            });
            return {
                success: false,
                offer_id: offerId,
                task_id: Number.isFinite(taskId) ? taskId : undefined,
                import_status: importStatus,
                error: importErrors || ('Ozon import status: ' + importStatus),
                code: 'OZON_IMPORT_FAILED',
            };
        }
        logger.log('offer:ok', {
            offer_id: offerId,
            task_id: Number.isFinite(taskId) ? taskId : undefined,
            import_status: importStatus,
            weight_kg: Number(Number(dims.weightKg).toFixed(3)),
        });
        return {
            success: true,
            offer_id: offerId,
            task_id: Number.isFinite(taskId) ? taskId : undefined,
            import_status: importStatus,
            dims: {
                length_cm: Number(Number(dims.lengthCm).toFixed(1)),
                width_cm: Number(Number(dims.widthCm).toFixed(1)),
                height_cm: Number(Number(dims.heightCm).toFixed(1)),
                weight_kg: Number(Number(dims.weightKg).toFixed(3)),
            },
        };
    } catch (e) {
        const ozonMsg =
            e && e.response && e.response.data
                ? JSON.stringify(e.response.data).slice(0, 500)
                : '';
        logger.log('offer:fail', {
            offer_id: offerId,
            message: e && e.message ? e.message : String(e),
            status: e && e.response && e.response.status,
        });
        return {
            success: false,
            offer_id: offerId,
            error: (e && e.message ? e.message : String(e)) + (ozonMsg ? ' | ' + ozonMsg : ''),
            code: (e && e.code) || 'OZON_UPDATE_FAILED',
        };
    }
}

async function patchLocalOzonDims(db, offerId, dims) {
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
         WHERE marketplace = 'ozon' AND external_id = ?`,
        [length, width, height, weight, 'Ozon dims ← МС', offer]
    );
}

module.exports = {
    parseDimCm,
    pickMsHeightCmForOzon,
    resolveMsDimsForOzonPush,
    ozonHeaders,
    buildImportItem,
    fetchOzonCardByOfferId,
    waitOzonImportTask,
    updateOzonOfferDimensions,
    patchLocalOzonDims,
};
