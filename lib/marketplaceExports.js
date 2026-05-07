'use strict';

const axios = require('axios');

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

/** Нижние границы пауз между запросами (ниже — риск 429; поднять можно query-параметрами). */
const MP_MIN_DELAY_MS = {
    ozon: 300,
    wbCards: 350,
    wbPricesStocks: 1000,
    yandex: 200,
};

/**
 * Повтор при лимитах маркетплейсов: 429 / 502 / 503 и заголовок Retry-After (секунды).
 */
async function axiosWithMarketplaceRateLimit(config) {
    const maxAttempts = 12;
    let lastErr;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        try {
            // eslint-disable-next-line no-await-in-loop
            return await axios(config);
        } catch (e) {
            lastErr = e;
            const st = e.response && e.response.status;
            const retryable = st === 429 || st === 502 || st === 503;
            if (!retryable) throw e;
            let waitMs = 900 * 1.35 ** attempt;
            const ra = e.response && e.response.headers && e.response.headers['retry-after'];
            if (ra != null) {
                const sec = parseFloat(String(ra).trim());
                if (Number.isFinite(sec) && sec >= 0) waitMs = Math.max(waitMs, sec * 1000);
            }
            waitMs = Math.min(Math.floor(waitMs), 180000);
            // eslint-disable-next-line no-await-in-loop
            await sleep(waitMs);
        }
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

function ozonVatLabel(v) {
    if (v === undefined || v === null) return 'Без НДС';
    const n = Number(v);
    if (n === 20) return '20';
    if (n === 10) return '10';
    if (n === 0) return '0';
    if (n === 6 || n === 7) return 'Без НДС';
    if (n === 1) return 'НДС не облагается';
    return String(v);
}

async function exportOzonRows(creds, opts) {
    const clientId = String(creds.clientId || '').trim();
    const apiKey = String(creds.apiKey || '').trim();
    if (!clientId || !apiKey) {
        const err = new Error('Ozon: не заданы OZON_CLIENT_ID и OZON_API_KEY (или app_settings ozon_client_id / ozon_api_key)');
        err.code = 'MISSING_CREDS';
        throw err;
    }

    const maxItems = Math.max(1, Math.min(Number(opts.maxItems || 5000), 25000));
    const includeArchived = Boolean(opts.includeArchived);
    const delayMs = Math.max(MP_MIN_DELAY_MS.ozon, Number(opts.delayMs ?? 400) || 400);
    const headers = { 'Client-Id': clientId, 'Api-Key': apiKey, 'Content-Type': 'application/json' };

    const basicItems = [];
    let lastId = '';
    while (basicItems.length < maxItems) {
        const remaining = Math.min(1000, maxItems - basicItems.length);
        const { data } = await axiosWithMarketplaceRateLimit({
            method: 'POST',
            url: 'https://api-seller.ozon.ru/v3/product/list',
            data: {
                filter: { visibility: includeArchived ? 'ALL' : 'VISIBLE' },
                limit: remaining,
                last_id: lastId,
            },
            headers,
            timeout: 120000,
        });
        const items = data?.result?.items || [];
        for (const item of items) {
            basicItems.push({ product_id: item.product_id, offer_id: item.offer_id || '' });
        }
        lastId = data?.result?.last_id || '';
        if (!items.length) break;
        if (delayMs) await sleep(delayMs);
    }

    const productDetails = new Map();
    const batchSize = 50;
    for (let i = 0; i < basicItems.length; i += batchSize) {
        const batch = basicItems.slice(i, i + batchSize).map((x) => Number(x.product_id));
        const { data } = await axiosWithMarketplaceRateLimit({
            method: 'POST',
            url: 'https://api-seller.ozon.ru/v3/product/info/list',
            data: { product_id: batch, language: 'DEFAULT' },
            headers,
            timeout: 120000,
        });
        const list = data?.items || [];
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

    for (let i = 0; i < basicItems.length; i += batchSize) {
        const batch = basicItems.slice(i, i + batchSize).map((x) => Number(x.product_id));
        const { data } = await axiosWithMarketplaceRateLimit({
            method: 'POST',
            url: 'https://api-seller.ozon.ru/v4/product/info/attributes',
            data: { filter: { product_id: batch }, limit: batch.length },
            headers,
            timeout: 120000,
        });
        const results = data?.result || [];
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

    return { headerKeys, rows, updatedAt: ts };
}

// --- Wildberries ---

function wbExtractVatFromCharacteristics(characteristics) {
    if (!characteristics || !Array.isArray(characteristics)) return 'не указан';
    for (const char of characteristics) {
        if (char.name === 'Ставка НДС' || char.id === 15001405) {
            const vatValue = char.value?.[0];
            if (vatValue === undefined || vatValue === null || vatValue === '') return 'не указан';
            switch (String(vatValue)) {
                case '0':
                    return '0%';
                case '5':
                    return '5% (УСН)';
                case '7':
                    return '7% (УСН)';
                case '10':
                    return '10%';
                case '20':
                    return '20%';
                case '6':
                    return 'без НДС';
                default:
                    return `${vatValue}%`;
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
    if (!apiKey) {
        const err = new Error('Wildberries: не задан WB_API_KEY (или app_settings wb_api_key)');
        err.code = 'MISSING_CREDS';
        throw err;
    }

    const maxCards = Math.max(1, Math.min(Number(opts.maxItems || 5000), 50000));
    const delayCards = Math.max(MP_MIN_DELAY_MS.wbCards, Number(opts.delayCards ?? 600) || 600);
    const delayOther = Math.max(MP_MIN_DELAY_MS.wbPricesStocks, Number(opts.delayOther ?? 1600) || 1600);

    const authH = { Authorization: apiKey };

    const allCards = [];
    let cursor = { limit: 100 };
    while (allCards.length < maxCards) {
        const { data } = await axiosWithMarketplaceRateLimit({
            method: 'POST',
            url: 'https://content-api.wildberries.ru/content/v2/get/cards/list',
            data: { settings: { sort: { ascending: true }, cursor, filter: { withPhoto: -1 } } },
            headers: { ...authH, 'Content-Type': 'application/json' },
            timeout: 120000,
        });
        const cards = data?.cards || [];
        const filtered = cards.filter((c) => c.status !== 'archive');
        for (const c of filtered) {
            if (allCards.length >= maxCards) break;
            allCards.push(c);
        }
        if (data?.cursor?.updatedAt && data?.cursor?.nmID) {
            cursor = { limit: 100, updatedAt: data.cursor.updatedAt, nmID: data.cursor.nmID };
        } else break;
        if (cards.length < 100) break;
        if (delayCards) await sleep(delayCards);
    }

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

    const priceMap = new Map();
    let offset = 0;
    const limit = 1000;
    while (true) {
        const { data } = await axiosWithMarketplaceRateLimit({
            method: 'GET',
            url: 'https://discounts-prices-api.wildberries.ru/api/v2/list/goods/filter',
            params: { limit, offset },
            headers: authH,
            timeout: 120000,
        });
        const goods = data?.data?.listGoods || [];
        for (const good of goods) {
            const nmId = String(good.nmID);
            let priceRub = good.sizes?.[0]?.price || 0;
            if (priceRub > 0) priceMap.set(nmId, formatRuMoneyFromMajor(Math.round(priceRub)));
        }
        if (goods.length < limit) break;
        offset += limit;
        if (delayOther) await sleep(delayOther);
    }

    const stockMap = new Map();
    try {
        const whRes = await axiosWithMarketplaceRateLimit({
            method: 'GET',
            url: 'https://marketplace-api.wildberries.ru/api/v3/warehouses',
            headers: authH,
            timeout: 60000,
        });
        let warehouses = whRes.data;
        if (!Array.isArray(warehouses) || !warehouses.length) {
            warehouses = [{ id: 84250, name: 'default' }];
        }
        const vendorCodes = Array.from(vendorCodeToNmId.keys());
        for (const warehouse of warehouses) {
            for (let i = 0; i < vendorCodes.length; i += 100) {
                const chunk = vendorCodes.slice(i, i + 100);
                try {
                    const stRes = await axiosWithMarketplaceRateLimit({
                        method: 'POST',
                        url: `https://marketplace-api.wildberries.ru/api/v3/stocks/${warehouse.id}`,
                        data: { skus: chunk },
                        headers: { ...authH, 'Content-Type': 'application/json' },
                        timeout: 120000,
                    });
                    const stocks = stRes.data?.stocks || [];
                    for (const row of stocks) {
                        const sku = String(row.sku);
                        const amount = row.amount || 0;
                        const nmId = vendorCodeToNmId.get(sku);
                        if (nmId && amount > 0) {
                            stockMap.set(nmId, (stockMap.get(nmId) || 0) + amount);
                        }
                    }
                } catch (_) {
                    /* ignore per-warehouse errors */
                }
                if (delayOther) await sleep(delayOther);
            }
        }
    } catch (_) {
        /* stocks optional */
    }

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

    return { headerKeys, rows, updatedAt: ts };
}

// --- Yandex Market ---

function ymVatText(v) {
    switch (v) {
        case 2:
            return '10%';
        case 5:
            return '0%';
        case 6:
            return 'без НДС';
        case 7:
            return '20%';
        case 10:
            return '5% (УСН)';
        case 11:
            return '7% (УСН)';
        case 14:
            return '22%';
        default:
            return 'не указан';
    }
}

async function exportYandexMarketRows(creds, opts) {
    const apiKey = String(creds.apiKey || '').trim();
    const campaignId = String(creds.campaignId || '').trim();
    const businessId = String(creds.businessId || '').trim();
    if (!apiKey || !campaignId) {
        const err = new Error(
            'Яндекс Маркет: не заданы YM_API_KEY и YM_CAMPAIGN_ID (или app_settings ym_api_key / ym_campaign_id)',
        );
        err.code = 'MISSING_CREDS';
        throw err;
    }

    const maxSkus = Math.max(1, Math.min(Number(opts.maxItems || 5000), 100000));
    const delayMs = Math.max(MP_MIN_DELAY_MS.yandex, Number(opts.delayMs ?? 280) || 280);
    const headers = { 'Api-Key': apiKey };

    const allSkus = [];
    let pageToken = '';
    do {
        let url = `https://api.partner.market.yandex.ru/v2/campaigns/${campaignId}/offer-prices?limit=500`;
        if (pageToken) url += `&page_token=${encodeURIComponent(pageToken)}`;
        const { data } = await axiosWithMarketplaceRateLimit({ method: 'GET', url, headers, timeout: 120000 });
        const offers = data?.result?.offers || [];
        for (const offer of offers) {
            if (offer.id && allSkus.length < maxSkus) allSkus.push(String(offer.id));
        }
        pageToken = data?.result?.paging?.nextPageToken || '';
        if (!pageToken) break;
        if (delayMs) await sleep(delayMs);
    } while (allSkus.length < maxSkus);

    const pricesMap = new Map();
    for (let i = 0; i < allSkus.length; i += 500) {
        const chunk = allSkus.slice(i, i + 500);
        const { data } = await axiosWithMarketplaceRateLimit({
            method: 'POST',
            url: `https://api.partner.market.yandex.ru/v2/campaigns/${campaignId}/offer-prices`,
            data: { offerIds: chunk },
            headers: { ...headers, 'Content-Type': 'application/json' },
            timeout: 120000,
        });
        const offers = data?.result?.offers || [];
        for (const offer of offers) {
            if (offer.offerId) {
                pricesMap.set(String(offer.offerId), {
                    price: offer.price?.value || 0,
                    vat: ymVatText(offer.price?.vat),
                });
            }
        }
        if (delayMs) await sleep(delayMs);
    }

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
    for (let i = 0; i < allSkus.length; i += 100) {
        const chunk = allSkus.slice(i, i + 100);
        const { data } = await axiosWithMarketplaceRateLimit({
            method: 'POST',
            url: `https://api.partner.market.yandex.ru/v2/campaigns/${campaignId}/stats/skus`,
            data: { shopSkus: chunk },
            headers: { ...headers, 'Content-Type': 'application/json' },
            timeout: 120000,
        });
        const goods = data?.result?.shopSkus || [];
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
        if (delayMs) await sleep(delayMs);
    }

    return { headerKeys, rows, updatedAt: ts };
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
    MP_MIN_DELAY_MS,
};
