#!/usr/bin/env node
/**
 * Собирает static-html/vanilla/*.html из _template.html и фрагментов inners/.
 * Вызывать перед копированием vanilla в public (см. npm run sync:vanilla-public).
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { injectArchitectuiMainCssLink, resolveArchitectuiMainCssHref } from './architectui-main-css-inject.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '../..');
const publicDir = path.join(root, 'public');
const vanillaDir = path.join(root, 'static-html', 'vanilla');
const tmplPath = path.join(vanillaDir, '_template.html');

function read(p) {
    return fs.readFileSync(p, 'utf8');
}

function assemble() {
    const template = read(tmplPath);
    const mpExtraHead =
        read(path.join(vanillaDir, 'inners/exports-suite.head.html')) +
        read(path.join(vanillaDir, 'inners/exports-marketplaces.head.html'));
    const mpShopScripts = read(path.join(vanillaDir, 'inners/exports-marketplaces-shop.scripts.html'));
    const mpShopFiltersFragment = read(path.join(vanillaDir, 'inners/exports-marketplaces-shop-filters.fragment.html'));
    const pages = [
        {
            out: 'dashboard.html',
            PAGE_TITLE: 'Дашборд — Датагон',
            BODY_ATTRS: 'class="datagon-vanilla-body" data-dg-active-nav="dashboard"',
            EXTRA_HEAD: read(path.join(vanillaDir, 'inners/dashboard.head.html')),
            MAIN_INNER: read(path.join(vanillaDir, 'inners/dashboard.inner.html')),
            PAGE_SCRIPTS: read(path.join(vanillaDir, 'inners/dashboard.scripts.html')),
        },
        {
            out: 'my-sites.html',
            PAGE_TITLE: 'Мои сайты — Датагон',
            BODY_ATTRS: 'class="datagon-vanilla-body" data-dg-active-nav="my-sites"',
            EXTRA_HEAD: read(path.join(vanillaDir, 'inners/my-sites.head.html')),
            MAIN_INNER: read(path.join(vanillaDir, 'inners/my-sites.inner.html')),
            PAGE_SCRIPTS: read(path.join(vanillaDir, 'inners/my-sites.scripts.html')),
        },
        {
            out: 'moysklad.html',
            PAGE_TITLE: 'Мой Склад (товары) — Датагон',
            BODY_ATTRS: 'class="datagon-vanilla-body" data-dg-active-nav="moysklad"',
            EXTRA_HEAD: read(path.join(vanillaDir, 'inners/moysklad.head.html')),
            MAIN_INNER: read(path.join(vanillaDir, 'inners/moysklad.inner.html')),
            PAGE_SCRIPTS: read(path.join(vanillaDir, 'inners/moysklad.scripts.html')),
        },
        {
            out: 'suppliers.html',
            PAGE_TITLE: 'Поставщики — Датагон',
            BODY_ATTRS: 'class="datagon-vanilla-body" data-dg-active-nav="suppliers"',
            EXTRA_HEAD: read(path.join(vanillaDir, 'inners/suppliers.head.html')),
            MAIN_INNER: read(path.join(vanillaDir, 'inners/suppliers.inner.html')),
            PAGE_SCRIPTS: read(path.join(vanillaDir, 'inners/suppliers.scripts.html')),
        },
        {
            out: 'purchase.html',
            PAGE_TITLE: 'Закупки товары — Датагон',
            BODY_ATTRS: 'class="datagon-vanilla-body" data-dg-active-nav="purchase"',
            EXTRA_HEAD: read(path.join(vanillaDir, 'inners/purchase.head.html')),
            MAIN_INNER: read(path.join(vanillaDir, 'inners/purchase.inner.html')),
            PAGE_SCRIPTS: read(path.join(vanillaDir, 'inners/purchase.scripts.html')),
        },
        {
            // Карточка товара /product.html?code=XXX — открывается из «Закупки» в новом окне.
            // Не входит в основное меню (data-dg-active-nav="product" нужен только для подсветки).
            out: 'product.html',
            PAGE_TITLE: 'Карточка товара — Датагон',
            BODY_ATTRS: 'class="datagon-vanilla-body" data-dg-active-nav="product"',
            EXTRA_HEAD: read(path.join(vanillaDir, 'inners/product.head.html')),
            MAIN_INNER: read(path.join(vanillaDir, 'inners/product.inner.html')),
            PAGE_SCRIPTS: read(path.join(vanillaDir, 'inners/product.scripts.html')),
        },
        {
            out: 'my-products.html',
            PAGE_TITLE: 'Мои товары — Датагон',
            BODY_ATTRS: 'class="datagon-vanilla-body" data-dg-active-nav="my-products"',
            EXTRA_HEAD: read(path.join(vanillaDir, 'inners/my-products.head.html')),
            MAIN_INNER: read(path.join(vanillaDir, 'inners/my-products.inner.html')),
            PAGE_SCRIPTS: read(path.join(vanillaDir, 'inners/my-products.scripts.html')),
        },
        {
            out: 'projects.html',
            PAGE_TITLE: 'Проекты конкурентов — Датагон',
            BODY_ATTRS: 'class="datagon-vanilla-body" data-dg-active-nav="projects"',
            EXTRA_HEAD: read(path.join(vanillaDir, 'inners/projects.head.html')),
            MAIN_INNER: read(path.join(vanillaDir, 'inners/projects.inner.html')),
            PAGE_SCRIPTS: read(path.join(vanillaDir, 'inners/projects.scripts.html')),
        },
        {
            out: 'queue.html',
            PAGE_TITLE: 'Очередь парсинга — Датагон',
            BODY_ATTRS: 'class="datagon-vanilla-body" data-dg-active-nav="queue"',
            EXTRA_HEAD: read(path.join(vanillaDir, 'inners/queue.head.html')),
            MAIN_INNER: read(path.join(vanillaDir, 'inners/queue.inner.html')),
            PAGE_SCRIPTS: read(path.join(vanillaDir, 'inners/queue.scripts.html')),
        },
        {
            out: 'results.html',
            PAGE_TITLE: 'Результаты — Датагон',
            BODY_ATTRS: 'class="datagon-vanilla-body" data-dg-active-nav="results"',
            EXTRA_HEAD: read(path.join(vanillaDir, 'inners/results.head.html')),
            MAIN_INNER: read(path.join(vanillaDir, 'inners/results.inner.html')),
            PAGE_SCRIPTS: read(path.join(vanillaDir, 'inners/results.scripts.html')),
        },
        {
            out: 'matches.html',
            PAGE_TITLE: 'Сопоставление — Датагон',
            BODY_ATTRS: 'class="datagon-vanilla-body" data-dg-active-nav="matches"',
            EXTRA_HEAD: read(path.join(vanillaDir, 'inners/matches.head.html')),
            MAIN_INNER: read(path.join(vanillaDir, 'inners/matches.inner.html')),
            PAGE_SCRIPTS: read(path.join(vanillaDir, 'inners/matches.scripts.html')),
        },
        {
            out: 'processes.html',
            PAGE_TITLE: 'Активность/Логи — Датагон',
            BODY_ATTRS: 'class="datagon-vanilla-body" data-dg-active-nav="processes"',
            EXTRA_HEAD: read(path.join(vanillaDir, 'inners/processes.head.html')),
            MAIN_INNER: read(path.join(vanillaDir, 'inners/processes.inner.html')),
            PAGE_SCRIPTS: read(path.join(vanillaDir, 'inners/processes.scripts.html')),
        },
        {
            out: 'settings.html',
            PAGE_TITLE: 'Настройки — Датагон',
            BODY_ATTRS: 'class="datagon-vanilla-body" data-dg-active-nav="settings"',
            EXTRA_HEAD: read(path.join(vanillaDir, 'inners/settings.head.html')),
            MAIN_INNER: read(path.join(vanillaDir, 'inners/settings.inner.html')),
            PAGE_SCRIPTS: read(path.join(vanillaDir, 'inners/settings.scripts.html')),
        },
        {
            out: 'ref/index.html',
            PAGE_TITLE: 'Справка (статика) — Датагон',
            BODY_ATTRS: 'class="datagon-vanilla-body"',
            EXTRA_HEAD: read(path.join(vanillaDir, 'inners/ref.head.html')),
            MAIN_INNER: read(path.join(vanillaDir, 'inners/ref-index.inner.html')),
            PAGE_SCRIPTS: read(path.join(vanillaDir, 'inners/ref.scripts.html')),
        },
        {
            out: 'ref/main.html',
            PAGE_TITLE: 'Справка Main — Датагон',
            BODY_ATTRS: 'class="datagon-vanilla-body"',
            EXTRA_HEAD: read(path.join(vanillaDir, 'inners/ref.head.html')),
            MAIN_INNER: read(path.join(vanillaDir, 'inners/ref-main.inner.html')),
            PAGE_SCRIPTS: read(path.join(vanillaDir, 'inners/ref.scripts.html')),
        },
        {
            out: 'ref/elements.html',
            PAGE_TITLE: 'Справка Elements — Датагон',
            BODY_ATTRS: 'class="datagon-vanilla-body"',
            EXTRA_HEAD: read(path.join(vanillaDir, 'inners/ref.head.html')),
            MAIN_INNER: read(path.join(vanillaDir, 'inners/ref-elements.inner.html')),
            PAGE_SCRIPTS: read(path.join(vanillaDir, 'inners/ref.scripts.html')),
        },
        {
            out: 'ref/components.html',
            PAGE_TITLE: 'Справка Components — Датагон',
            BODY_ATTRS: 'class="datagon-vanilla-body"',
            EXTRA_HEAD: read(path.join(vanillaDir, 'inners/ref.head.html')),
            MAIN_INNER: read(path.join(vanillaDir, 'inners/ref-components.inner.html')),
            PAGE_SCRIPTS: read(path.join(vanillaDir, 'inners/ref.scripts.html')),
        },
        {
            out: 'ref/tables.html',
            PAGE_TITLE: 'Справка Tables — Датагон',
            BODY_ATTRS: 'class="datagon-vanilla-body"',
            EXTRA_HEAD: read(path.join(vanillaDir, 'inners/ref.head.html')),
            MAIN_INNER: read(path.join(vanillaDir, 'inners/ref-tables.inner.html')),
            PAGE_SCRIPTS: read(path.join(vanillaDir, 'inners/ref.scripts.html')),
        },
        {
            out: 'ref/widgets.html',
            PAGE_TITLE: 'Справка Widgets — Датагон',
            BODY_ATTRS: 'class="datagon-vanilla-body"',
            EXTRA_HEAD: read(path.join(vanillaDir, 'inners/ref.head.html')),
            MAIN_INNER: read(path.join(vanillaDir, 'inners/ref-widgets.inner.html')),
            PAGE_SCRIPTS: read(path.join(vanillaDir, 'inners/ref.scripts.html')),
        },
        {
            out: 'ref/forms.html',
            PAGE_TITLE: 'Справка Forms — Датагон',
            BODY_ATTRS: 'class="datagon-vanilla-body"',
            EXTRA_HEAD: read(path.join(vanillaDir, 'inners/ref.head.html')),
            MAIN_INNER: read(path.join(vanillaDir, 'inners/ref-forms.inner.html')),
            PAGE_SCRIPTS: read(path.join(vanillaDir, 'inners/ref.scripts.html')),
        },
        {
            out: 'ref/charts.html',
            PAGE_TITLE: 'Справка Charts — Датагон',
            BODY_ATTRS: 'class="datagon-vanilla-body"',
            EXTRA_HEAD: read(path.join(vanillaDir, 'inners/ref.head.html')),
            MAIN_INNER: read(path.join(vanillaDir, 'inners/ref-charts.inner.html')),
            PAGE_SCRIPTS: read(path.join(vanillaDir, 'inners/ref.scripts.html')),
        },
        {
            out: 'ref/react-demo-index.html',
            PAGE_TITLE: 'Полное меню ArchitectUI — Датагон',
            BODY_ATTRS: 'class="datagon-vanilla-body" data-dg-active-nav="architectui-demo"',
            EXTRA_HEAD: read(path.join(vanillaDir, 'inners/ref.head.html')),
            MAIN_INNER: read(path.join(vanillaDir, 'inners/ref-react-demo-index.inner.html')),
            PAGE_SCRIPTS: read(path.join(vanillaDir, 'inners/ref.scripts.html')),
        },
        {
            out: 'sections.html',
            PAGE_TITLE: 'Статические экраны — Датагон',
            BODY_ATTRS: 'class="datagon-vanilla-body"',
            EXTRA_HEAD: read(path.join(vanillaDir, 'inners/index.head.html')),
            MAIN_INNER: read(path.join(vanillaDir, 'inners/index.inner.html')),
            PAGE_SCRIPTS: read(path.join(vanillaDir, 'inners/index.scripts.html')),
        },
        {
            out: 'exports-marketplaces.html',
            PAGE_TITLE: 'Маркетплейсы — Настройки — Датагон',
            BODY_ATTRS: 'class="datagon-vanilla-body" data-dg-active-nav="exports-marketplaces"',
            EXTRA_HEAD: mpExtraHead,
            MAIN_INNER: read(path.join(vanillaDir, 'inners/exports-marketplaces.inner.html')),
            PAGE_SCRIPTS: read(path.join(vanillaDir, 'inners/exports-marketplaces.scripts.html')),
        },
        {
            out: 'exports-marketplaces-ozon.html',
            PAGE_TITLE: 'Маркетплейсы — Ozon — Датагон',
            BODY_ATTRS:
                'class="datagon-vanilla-body" data-dg-active-nav="exports-marketplaces-ozon" data-dg-mp-shop="ozon"',
            EXTRA_HEAD: mpExtraHead,
            // Карточка «Фильтры и действия» (общий fragment) подставляется на место
            // плейсхолдера <!-- DG_MP_SHOP_FILTERS --> сразу ПОСЛЕ заголовка страницы,
            // см. .cursor/rules/datagon-list-page-baseline-moysklad.mdc.
            MAIN_INNER: read(path.join(vanillaDir, 'inners/exports-marketplaces-ozon.inner.html'))
                .replace('<!-- DG_MP_SHOP_FILTERS -->', mpShopFiltersFragment),
            PAGE_SCRIPTS: mpShopScripts,
        },
        {
            out: 'exports-marketplaces-wildberries.html',
            PAGE_TITLE: 'Маркетплейсы — Wildberries — Датагон',
            BODY_ATTRS:
                'class="datagon-vanilla-body" data-dg-active-nav="exports-marketplaces-wildberries" data-dg-mp-shop="wildberries"',
            EXTRA_HEAD: mpExtraHead,
            MAIN_INNER: read(path.join(vanillaDir, 'inners/exports-marketplaces-wildberries.inner.html'))
                .replace('<!-- DG_MP_SHOP_FILTERS -->', mpShopFiltersFragment),
            PAGE_SCRIPTS: mpShopScripts,
        },
        {
            out: 'exports-marketplaces-yandex.html',
            PAGE_TITLE: 'Маркетплейсы — Яндекс Маркет — Датагон',
            BODY_ATTRS:
                'class="datagon-vanilla-body" data-dg-active-nav="exports-marketplaces-yandex" data-dg-mp-shop="yandex"',
            EXTRA_HEAD: mpExtraHead,
            MAIN_INNER: read(path.join(vanillaDir, 'inners/exports-marketplaces-yandex.inner.html'))
                .replace('<!-- DG_MP_SHOP_FILTERS -->', mpShopFiltersFragment),
            PAGE_SCRIPTS: mpShopScripts,
        },
        {
            out: 'exports-marketplaces-issues.html',
            PAGE_TITLE: 'Маркетплейсы — Проблемы с товарами — Датагон',
            BODY_ATTRS:
                'class="datagon-vanilla-body" data-dg-active-nav="exports-marketplaces-issues"',
            EXTRA_HEAD:
                mpExtraHead +
                read(path.join(vanillaDir, 'inners/exports-marketplaces-issues.head.html')),
            MAIN_INNER: read(path.join(vanillaDir, 'inners/exports-marketplaces-issues.inner.html')),
            PAGE_SCRIPTS: read(path.join(vanillaDir, 'inners/exports-marketplaces-issues.scripts.html')),
        },
        {
            out: 'exports-huckster.html',
            PAGE_TITLE: 'Huckster — Датагон',
            BODY_ATTRS: 'class="datagon-vanilla-body" data-dg-active-nav="exports-huckster"',
            EXTRA_HEAD:
                read(path.join(vanillaDir, 'inners/exports-suite.head.html')) +
                read(path.join(vanillaDir, 'inners/exports-huckster.head.html')),
            MAIN_INNER: read(path.join(vanillaDir, 'inners/exports-huckster.inner.html')),
            PAGE_SCRIPTS: read(path.join(vanillaDir, 'inners/exports-suite.scripts.html')),
        },
        {
            out: 'exports-dimensions.html',
            PAGE_TITLE: 'Маркетплейсы — Габариты — Датагон',
            BODY_ATTRS: 'class="datagon-vanilla-body" data-dg-active-nav="exports-dimensions"',
            EXTRA_HEAD:
                read(path.join(vanillaDir, 'inners/exports-suite.head.html')) +
                read(path.join(vanillaDir, 'inners/exports-dimensions.head.html')),
            MAIN_INNER: read(path.join(vanillaDir, 'inners/exports-dimensions.inner.html')),
            PAGE_SCRIPTS: read(path.join(vanillaDir, 'inners/exports-dimensions.scripts.html')),
        },
        {
            // MS Sales — отдельная страница «Продажи МС»: тянет entity/demand
            // из МС API, хранит документы и позиции локально с привязкой к
            // ms_export. См. routes/msSales.js, docs api.md (раздел «Продажи МС»).
            out: 'ms-sales.html',
            PAGE_TITLE: 'Продажи МС — Датагон',
            BODY_ATTRS: 'class="datagon-vanilla-body" data-dg-active-nav="ms-sales"',
            EXTRA_HEAD: read(path.join(vanillaDir, 'inners/ms-sales.head.html')),
            MAIN_INNER: read(path.join(vanillaDir, 'inners/ms-sales.inner.html')),
            PAGE_SCRIPTS: read(path.join(vanillaDir, 'inners/ms-sales.scripts.html')),
        },
    ];

    const legacyIndex = path.join(vanillaDir, 'index.html');
    if (fs.existsSync(legacyIndex)) {
        fs.unlinkSync(legacyIndex);
    }

    const mainCssHref = resolveArchitectuiMainCssHref(publicDir);
    if (!mainCssHref) {
        console.warn(
            'assemble-vanilla: в public/static/css/ нет main.*.css — в HTML останется <!-- ARCHITECTUI_MAIN_CSS -->; соберите тему или npm run sync:vanilla-public после сборки CSS.',
        );
    }

    for (const p of pages) {
        const { out, ...vars } = p;
        let html = template;
        for (const [key, val] of Object.entries(vars)) {
            const token = '{{' + key + '}}';
            if (!html.includes(token)) {
                console.warn('assemble-vanilla: нет плейсхолдера', token, 'в _template.html');
            }
            html = html.split(token).join(val);
        }
        html = injectArchitectuiMainCssLink(html, mainCssHref);
        const outPath = path.join(vanillaDir, out);
        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        fs.writeFileSync(outPath, html, 'utf8');
        console.log('OK: assemble', outPath);
    }
}

assemble();
