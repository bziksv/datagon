'use strict';

/**
 * Обновление НДС карточки Wildberries (характеристика id 15001405 «Ставка НДС»).
 * cards/update перезаписывает карточку целиком — читаем list, сохраняем dimensions,
 * меняем только характеристику НДС.
 */

const {
    axiosWithMarketplaceRateLimit,
    createMarketplaceLogger,
    MP_MIN_DELAY_MS,
} = require('./marketplaceExports');
const {
    wbAuthHeaders,
    wbHttpErrorMessage,
    fetchWbCardByVendorCode,
} = require('./wbProductDimsUpdate');
const { parseMsVat, msVatToWbCharValue } = require('./mpVatConvert');

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

const WB_VAT_CHAR_ID = 15001405;

/**
 * Тело cards/update: текущие dimensions карточки + замена характеристики НДС.
 * @param {object} card
 * @param {string} wbVatValue — код '6'|'5'|…
 */
function buildWbUpdateCardVat(card, wbVatValue) {
    const nmID = Number(card && card.nmID);
    const vendorCode = String((card && card.vendorCode) || '').trim();
    if (!Number.isFinite(nmID) || nmID <= 0 || !vendorCode) {
        const err = new Error('Неполная карточка WB (nmID / vendorCode)');
        err.code = 'WB_INCOMPLETE_CARD';
        throw err;
    }
    const dims = (card && card.dimensions) || {};
    const length = Number(dims.length);
    const width = Number(dims.width);
    const height = Number(dims.height);
    const weightBrutto = Number(dims.weightBrutto);
    if (
        !Number.isFinite(length) ||
        length <= 0 ||
        !Number.isFinite(width) ||
        width <= 0 ||
        !Number.isFinite(height) ||
        height <= 0 ||
        !Number.isFinite(weightBrutto) ||
        weightBrutto <= 0
    ) {
        const err = new Error('У карточки WB нет габаритов/веса — cards/update без dimensions небезопасен');
        err.code = 'WB_NO_DIMS';
        throw err;
    }

    let foundVat = false;
    const characteristics = Array.isArray(card.characteristics)
        ? card.characteristics
              .map((c) => {
                  if (!c || c.id == null) return null;
                  const id = Number(c.id);
                  if (id === WB_VAT_CHAR_ID) {
                      foundVat = true;
                      return { id: WB_VAT_CHAR_ID, value: [String(wbVatValue)] };
                  }
                  return { id: c.id, value: c.value };
              })
              .filter(Boolean)
        : [];
    if (!foundVat) {
        characteristics.push({ id: WB_VAT_CHAR_ID, value: [String(wbVatValue)] });
    }

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
        dimensions: {
            length: Math.max(1, Math.round(length)),
            width: Math.max(1, Math.round(width)),
            height: Math.max(1, Math.round(height)),
            weightBrutto: Number(Number(weightBrutto).toFixed(3)),
        },
        characteristics,
        sizes,
    };
    if (card.needKiz) {
        item.kizMarked = Boolean(card.kizMarked);
    }
    return item;
}

/**
 * Пакетный update НДС: list по каждому vendorCode, затем cards/update чанками.
 * После HTTP success перечитываем карточку (кратко): если ставка не совпала —
 * success=false с кодом WB_VAT_NOT_APPLIED (не патчим локальный снапшот в роуте).
 */
async function updateWbOffersVatBatch(apiKey, items, opts) {
    const logger = (opts && opts.logger) || createMarketplaceLogger('wb-vat');
    const key = String(apiKey || '').trim();
    const list = Array.isArray(items) ? items : [];
    const delayListMs = Math.max(
        MP_MIN_DELAY_MS.wbCards || 600,
        Number((opts && opts.delayListMs) ?? 600) || 600
    );
    const delayUpdateMs = Math.max(6000, Number((opts && opts.delayUpdateMs) ?? 6500) || 6500);
    const updateChunk = Math.max(1, Math.min(100, Number((opts && opts.updateChunk) ?? 50) || 50));
    const dryRun = Boolean(opts && opts.dryRun);

    const results = [];
    const toUpdate = [];

    for (const it of list) {
        const vendorCode = String((it && it.vendorCode) || '').trim();
        const msVat = it && it.msVat;
        if (!vendorCode) {
            results.push({
                success: false,
                vendor_code: '',
                error: 'vendorCode обязателен',
                code: 'BAD_VENDOR',
            });
            continue;
        }
        const parsed = parseMsVat(msVat);
        const wbVal = msVatToWbCharValue(msVat);
        if (!parsed.ok || wbVal == null) {
            results.push({
                success: false,
                vendor_code: vendorCode,
                skipped: true,
                error: (parsed && parsed.error) || 'НДС МС не поддерживается WB',
                code: 'MS_VAT_UNSUPPORTED',
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
            const item = buildWbUpdateCardVat(card, wbVal);
            if (dryRun) {
                results.push({
                    success: true,
                    vendor_code: vendorCode,
                    nm_id: item.nmID,
                    dry_run: true,
                    vat: parsed.pretty,
                    vat_wb: wbVal,
                });
                continue;
            }
            toUpdate.push({ vendorCode, item, pretty: parsed.pretty, vatWb: wbVal });
        } catch (e) {
            results.push({
                success: false,
                vendor_code: vendorCode,
                error: (e && e.message) || String(e),
                code: (e && e.code) || 'WB_PREPARE_FAILED',
            });
        }
    }

    for (let i = 0; i < toUpdate.length; i += updateChunk) {
        const chunk = toUpdate.slice(i, i + updateChunk);
        if (i > 0 || (opts && opts.forceUpdateDelay)) {
            await sleep(delayUpdateMs);
        } else if (i === 0) {
            await sleep(Math.min(delayUpdateMs, 1500));
        }
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
                    results.push({
                        success: false,
                        vendor_code: c.vendorCode,
                        nm_id: c.item.nmID,
                        error: errText,
                        code: 'WB_UPDATE_FAILED',
                    });
                } else {
                    results.push({
                        success: true,
                        vendor_code: c.vendorCode,
                        nm_id: c.item.nmID,
                        vat: c.pretty,
                        vat_wb: c.vatWb,
                        pending_wb_sync: true,
                    });
                }
            }
        } catch (e) {
            const msg = wbHttpErrorMessage(e);
            const code =
                e && e.response && e.response.status === 403
                    ? 'WB_FORBIDDEN'
                    : (e && e.code) || 'WB_UPDATE_FAILED';
            for (const c of chunk) {
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

    return results;
}

async function patchLocalWbVat(db, vendorCode, prettyVat) {
    if (!db || typeof db.query !== 'function') return;
    const code = String(vendorCode || '').trim();
    const vat = String(prettyVat == null ? '' : prettyVat).trim();
    if (!code || !vat) return;
    // Колонка vat + row_json.vat — иначе UI/повторная выгрузка расходятся
    // (колонка «Без НДС», а в JSON ещё «5»).
    await db.query(
        `UPDATE marketplace_export_rows
         SET vat = ?,
             row_json = JSON_SET(COALESCE(row_json, '{}'), '$.vat', ?),
             updated_label = ?,
             updated_at = CURRENT_TIMESTAMP
         WHERE marketplace = 'wildberries' AND external_id = ?`,
        [vat, vat, 'WB НДС ← МС', code]
    );
}

module.exports = {
    WB_VAT_CHAR_ID,
    buildWbUpdateCardVat,
    updateWbOffersVatBatch,
    patchLocalWbVat,
};
