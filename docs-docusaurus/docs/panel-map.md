---
id: panel-map
title: Карта панели
description: Все пункты бокового меню Datagon — URL, ключ доступа, API и ссылка на справку
---

Живая карта **бокового меню** панели (`static-html/vanilla/_template.html`) в порядке сверху вниз. Ключ матрицы специальностей = `data-nav` / `PAGE_DEFS.key` в `lib/datagonPageRegistry.js`.

Полный чек-лист для разработки: `docs/checklists/datagon-sidebar-nav.md`. Контракт HTTP — [REST API](/docs/api/).

## Системный блок

| Меню | URL | Ключ доступа | Справка |
|------|-----|--------------|---------|
| Дашборд | `/dashboard.html` | `dashboard` | [Дашборд](/docs/dashboard/) |
| Управление БД 🔒 | `/db-admin.html` | `db-admin` | [Управление БД](/docs/db-admin/) |
| ArchitectUI 🔒 | `/ref/react-demo-index.html` | вне `PAGE_DEFS`; меню — admin / `can_manage_users` | [ArchitectUI](/docs/architectui-migration/) |
| Активность/Логи 🔒 | `/processes.html` | `processes` (+ меню: manage-users) | [Активность / Логи](/docs/processes/) |
| Настройки | `/settings.html` | `settings` (+ HTML при `can_manage_users`) | [Настройки](/docs/settings/) |

🔒 — в меню с иконкой замка: админ или право управления пользователями (кроме пункта, открытого матрицей).

## Финансы и кадры

| Меню | URL | Ключ | Справка |
|------|-----|------|---------|
| Финансы | `/finance.html` | `finance` | [Финансы](/docs/finance/) |
| Таблицы менеджеров | `/manager-sales.html` | `manager-sales` | [Таблицы менеджеров](/docs/manager-sales/) |
| Операционный лист | `/ops-sheet.html` | `ops-sheet` | [Операционный лист](/docs/ops-sheet/) |
| График работы | `/work-schedule.html` | `work-schedule` | [График работы](/docs/work-schedule/) |
| График · настройки | `/work-schedule-settings.html` | `work-schedule-settings` | [График работы](/docs/work-schedule/) |

## Сайты и цены

| Меню | URL | Ключ | Справка |
|------|-----|------|---------|
| Мои сайты | `/my-sites.html` | `my-sites` | [Мои сайты](/docs/mysites/) |
| Цены сети | `/network-prices.html` | `network-prices` | [Цены сети](/docs/network-prices/) |

## МойСклад

| Меню | URL | Ключ | Справка |
|------|-----|------|---------|
| Мои товары (сайты) | `/my-products.html` | `my-products` | [Мои товары](/docs/myproducts/) |
| Мой Склад (товары) | `/moysklad.html` | `moysklad` | [МойСклад](/docs/moysklad/) |
| Заказы в МС | `/ms-orders.html` | `ms-orders` | [Заказы в МС](/docs/ms-orders/) |
| Продажи МС | `/ms-sales.html` | `ms-sales` | [Продажи МС](/docs/ms-sales/) |
| Медмаркет | `/medmarket.html` | `medmarket` | [Медмаркет](/docs/medmarket/) |

## Парсинг

| Меню | URL | Ключ | Справка |
|------|-----|------|---------|
| Конкуренты | `/projects.html` | `projects` | [Конкуренты](/docs/projects/) |
| Очередь | `/queue.html` | `queue` | [Очередь](/docs/queue/) |
| Результаты | `/results.html` | `results` | [Результаты](/docs/results/) |
| Сопоставление | `/matches.html` | `matches` | [Сопоставление](/docs/matches/) |

## Маркетплейсы

Ключи API площадок — в [Настройках](/docs/settings/). Обзор подпунктов: [Маркетплейсы](/docs/marketplaces/).

| Меню | URL | Ключ |
|------|-----|------|
| *(скрыт)* Настройки МП | `/exports-marketplaces.html` | `exports-marketplaces` (API shop → этот ключ) |
| Ozon | `/exports-marketplaces-ozon.html` | `exports-marketplaces-ozon` |
| Wildberries | `/exports-marketplaces-wildberries.html` | `exports-marketplaces-wildberries` |
| Яндекс Маркет | `/exports-marketplaces-yandex.html` | `exports-marketplaces-yandex` |
| Huckster | `/exports-huckster.html` | `exports-huckster` |
| Габариты | `/exports-dimensions.html` | `exports-dimensions` |
| Проблемы с товарами | `/exports-marketplaces-issues.html` | `exports-marketplaces-issues` |
| Новые товары | `/exports-new-products.html` | `exports-new-products` (+ matrixOnly: stats / standing / crm-notify) |
| Отснять товары | `/exports-photoshoot.html` | `exports-photoshoot` |
| Конкуренты | `/exports-marketplaces-competitors.html` | `exports-marketplaces-competitors` |
| Инструкция | `/exports-marketplaces-reglament.html` | `exports-marketplaces-reglament` |

## Закупки и аналитика

| Меню | URL | Ключ | Справка |
|------|-----|------|---------|
| Закупки товары | `/purchase.html` | `purchase` | [Закупки](/docs/purchase/) |
| Поставщики | `/suppliers.html` | `suppliers` | [Поставщики](/docs/suppliers/) |
| Анализ поставщиков | `/supplier-analysis.html` | `supplier-analysis` | [Анализ поставщиков](/docs/supplier-analysis/) |
| Анализ товаров | `/product-analysis.html` | `product-analysis` | [Анализ товаров](/docs/product-analysis/) |

## Вне меню

| Экран | URL | Ключ | Справка |
|-------|-----|------|---------|
| Карточка товара | `/product.html?code=…` | `product` (HTML dual с `purchase`; API → `purchase`) | [Карточка товара](/docs/product/) |
| Каталог статических экранов | `/sections.html` | `sections` (нет API) | [Каталог экранов](/docs/sections/) |
| Вход | `/login.html` | — (вне PAGE_DEFS) | [Вход и нет доступа](/docs/login/) |
| Нет доступа | `/no-access.html` | — (вне PAGE_DEFS) | [Вход и нет доступа](/docs/login/) |

## Доступ

- Матрица: [Настройки](/docs/settings/) → специальности → режимы `hidden` / `view` / `full` по ключам выше.
- Дочерние маркетплейсы: если родитель `exports-marketplaces` = `hidden`, явный `view`/`full` у дочерней страницы всё равно открывает её (см. `isHtmlLeafAccessHidden` в `lib/datagonPageRegistry.js`).
- Карточка товара: HTML dual `purchase` \| `product`; API `/api/product` → ключ **`purchase`** — [Карточка товара](/docs/product/).
- API: `API_PREFIX_RULES` — обычно тот же ключ, что HTML; исключения: shop МП → `exports-marketplaces`, `/api/product` → `purchase`, `work-schedule` API = max с `work-schedule-settings`.
- Вход / редирект / пустая матрица: [Вход и нет доступа](/docs/login/). Каталог URL: [sections](/docs/sections/).
- Чек-лист прогона 40 пунктов (2026-10-09): `docs/checklists/datagon-sidebar-nav.md`.
