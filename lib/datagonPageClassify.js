'use strict';

/**
 * Вместо реальной карточки часто приходит HTML проверки (DDoS-Guard, hCaptcha и т.д.).
 * Иначе документ ошибочно классифицируется как `info` (нет узлов под селекторы проекта).
 * @param {string} html
 */
function assertHtmlNotWafChallenge(html) {
    const head = String(html || '').slice(0, 16000);
    const low = head.toLowerCase();
    if (low.includes('data-ddg-origin') || /\bddos-guard\b/i.test(head)) {
        throw new Error('403 WAF: антибот (DDoS-Guard / captcha), не карточка товара');
    }
    if (low.includes('hcaptcha.com') && /checking your browser|проверку браузера/i.test(head)) {
        throw new Error('403 WAF: проверка браузера (captcha), не карточка товара');
    }
}

/**
 * Рекурсивно ищет в JSON-LD узел с @type Product (в т.ч. вложенный в @graph).
 * @param {unknown} node
 * @param {number} depth
 * @returns {boolean}
 */
function jsonLdTreeHasProduct(node, depth) {
    if (depth > 18 || node == null) return false;
    if (typeof node !== 'object') return false;
    if (Array.isArray(node)) {
        for (let i = 0; i < node.length; i++) {
            if (jsonLdTreeHasProduct(node[i], depth + 1)) return true;
        }
        return false;
    }
    const t = node['@type'];
    const types = Array.isArray(t) ? t : t != null ? [t] : [];
    for (const x of types) {
        const norm = String(x)
            .replace(/^https?:\/\/schema\.org\//i, '')
            .toLowerCase();
        if (norm === 'product' || norm === 'individualproduct') return true;
    }
    const keys = Object.keys(node);
    for (let i = 0; i < keys.length; i++) {
        const k = keys[i];
        if (k === '@context') continue;
        if (jsonLdTreeHasProduct(node[k], depth + 1)) return true;
    }
    return false;
}

/**
 * Признаки типичной карточки товара без опоры на селекторы проекта (schema.org, microdata, OG, Bitrix и т.д.).
 * @param {import('cheerio').CheerioAPI} $
 * @param {string} html
 */
function hasGenericProductSignals($, html) {
    const raw = String(html || '');
    const low = raw.slice(0, 400000).toLowerCase();

    // Быстрый проход по сырому HTML (часто Product только в JSON-LD одной строкой).
    if (/"@type"\s*:\s*["']?\s*product\s*["']?/i.test(raw)) return true;
    if (/schema\.org\/["']?product["']?/i.test(raw) && /"@type"/i.test(raw)) return true;

    if ($('[itemprop="price"]').length) return true;
    if ($('meta[itemprop="price"]').length) return true;
    if ($('[itemtype*="schema.org/Product"], [itemtype*="schema.org/product"]').length) return true;
    if ($('[itemprop="sku"]').length && ($('h1').length || $('[itemprop="name"]').length)) return true;
    if ($('[itemprop="offers"]').length) return true;

    const ogTypes = [];
    $('meta[property="og:type"]').each((_, el) => {
        const v = String($(el).attr('content') || '')
            .trim()
            .toLowerCase();
        if (v) ogTypes.push(v);
    });
    if (ogTypes.includes('product')) return true;
    if ($('meta[property="product:price:amount"]').length) return true;
    if ($('meta[property="og:price:amount"]').length) return true;

    // Bitrix / типовые витрины
    if ($('[data-entity="sku"], [data-entity="item"], [data-product-id], [data-offer-id]').length) return true;
    if ($('#bx_catalog_element, .bx-catalog-element, .product-item-detail, .catalog-detail').length) return true;
    if ($('body.single-product').length || ($('body.woocommerce').length && $('div.product').length)) return true;

    // CTA «в корзину» + заголовок (узко: один h1 и короткий текст кнопки)
    if ($('h1').length === 1) {
        const h1 = $('h1').first().text().trim();
        if (h1.length >= 3 && h1.length < 400) {
            const cta = $('a, button, .btn, span').filter(function (_, el) {
                const t = $(el).text().replace(/\s+/g, ' ').trim().toLowerCase();
                return (
                    t === 'в корзину' ||
                    t === 'купить' ||
                    t === 'заказать' ||
                    t === 'оформить заказ' ||
                    (t.length <= 40 && t.includes('в корзину'))
                );
            });
            if (cta.length) return true;
        }
    }

    const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
    let m;
    while ((m = re.exec(raw)) !== null) {
        try {
            const j = JSON.parse(String(m[1] || '').trim());
            const roots = [];
            if (Array.isArray(j)) roots.push(...j);
            else if (j && typeof j === 'object') {
                if (Array.isArray(j['@graph'])) roots.push(...j['@graph']);
                else roots.push(j);
            }
            for (const root of roots) {
                if (jsonLdTreeHasProduct(root, 0)) return true;
            }
        } catch (_) {}
    }

    return false;
}

module.exports = { assertHtmlNotWafChallenge, hasGenericProductSignals };
