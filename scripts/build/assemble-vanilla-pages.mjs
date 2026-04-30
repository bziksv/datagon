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
            PAGE_TITLE: 'МойСклад — Датагон',
            BODY_ATTRS: 'class="datagon-vanilla-body" data-dg-active-nav="moysklad"',
            EXTRA_HEAD: read(path.join(vanillaDir, 'inners/moysklad.head.html')),
            MAIN_INNER: read(path.join(vanillaDir, 'inners/moysklad.inner.html')),
            PAGE_SCRIPTS: read(path.join(vanillaDir, 'inners/moysklad.scripts.html')),
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
            PAGE_TITLE: 'Логи и процессы — Датагон',
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
