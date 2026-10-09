---
id: sections
title: Каталог статических экранов
description: Служебная страница /sections.html — список vanilla HTML панели без пункта в сайдбаре
---

Страница **`/sections.html`** — каталог ссылок на vanilla-экраны панели (без React). Не отображается в боковом меню. Карта ключей и справки: [Карта панели](/docs/panel-map/).

## Доступ

Ключ матрицы — **`sections`** (`PAGE_DEFS`, `sortOrder` 110).

| Режим | Что доступно |
|-------|----------------|
| **`hidden`** | HTML `/sections.html` недоступен |
| **`view`** / **`full`** | Страница открывается; отдельных API нет |

Отдельного префикса в `API_PREFIX_RULES` **нет** — это чистая статика.

## Сборка

- Фрагмент контента: `static-html/vanilla/inners/index.inner.html` (+ `index.head.html` / `index.scripts.html`).
- Сборка: `assemble-vanilla-pages.mjs` → `sections.html` → `npm run sync:vanilla-public` → `public/sections.html`.
- Оболочка — тот же `_template.html` (сайдбар, header), что у остальных экранов.

## Назначение

Быстрый перечень URL панели для разработчиков/админов. **Источник истины** по меню и ключам доступа — сайдбар `_template.html` + `lib/datagonPageRegistry.js` + [Карта панели](/docs/panel-map/), а не этот список (он может отставать, пока не обновлён вручную).

Смежные: [Руководство](/docs/) (таблица URL), [ArchitectUI](/docs/architectui-migration/) (`/ref/`, демо).
