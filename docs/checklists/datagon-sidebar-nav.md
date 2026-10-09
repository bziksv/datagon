# Чек-лист: боковое меню → модули → API → справка

Источник меню: `static-html/vanilla/_template.html` (блок `.vertical-nav-menu`).  
Реестр страниц: `lib/datagonPageRegistry.js` (`PAGE_DEFS`, `API_PREFIX_RULES`).  
Пользовательская карта: [Карта панели](../../docs-docusaurus/docs/panel-map.md) → после сборки `/docs/panel-map/`.

Легенда колонки **Док**: ✅ есть страница Docusaurus · ➕ есть в [Карте панели](../../docs-docusaurus/docs/panel-map.md) / [manual](../../docs-docusaurus/docs/manual.md) · ❌ пробел.

**Прогон UI↔док (40 пунктов):** после каждого пункта — `Pass` / дата. Сейчас: **40/40** ✅.

| N | Пункт | Статус | Дата | Заметки |
|---|--------|--------|------|---------|
| 01 | dashboard | pass+doc-fix | 2026-10-09 | док `dashboard.md`; `disk-usage` → ключ `dashboard`; overview требует `processes` |
| 02 | db-admin | pass+doc-fix | 2026-10-09 | уточнён dual-gate admin/`can_manage_users` + матрица; фильтры Применить / pageSize |
| 03 | ArchitectUI | pass+doc-fix | 2026-10-09 | вне PAGE_DEFS; меню 🔒; URL с сессией открывается; демо `/architectui-react-pro/` |
| 04 | processes | pass+doc-fix | 2026-10-09 | доступ меню vs матрица vs activity; AUTO_SYNC 21; min-stock-errors → processes |
| 05 | settings | pass+doc-fix | 2026-10-09 | доступ can_manage_users; структура экрана; min_stock_export + purchase_formula_cache |
| 06 | finance | pass+doc-fix | 2026-10-09 | 3 банка + cash/plans; фильтр Применить; manual «Точка» → все банки; worker 2 |
| 07 | manager-sales | pass+doc-fix | 2026-10-09 | роли pick/plans; CSV action-log; DELETE comments в api; связь с work-schedule |
| 08 | ops-sheet | pass+doc-fix | 2026-10-09 | свод всем; Planfix sync_script; auto ops_planfix w2 vs полный синк кнопкой |
| 09 | work-schedule | pass+doc-fix | 2026-10-09 | dual HTML keys; API max(ws,settings); clock/access без page-lock; frontmatter |
| 10 | work-schedule-settings | pass+doc-fix | 2026-10-09 | орг/отделы/сотрудники; не путать с /settings; календарь/1С — API/табель, не эта HTML |
| 11 | my-sites | pass+doc-fix | 2026-10-09 | ключ my-sites; фильтр Применить; auto_sync_myproducts; collapse 3 карточек |
| 12 | network-prices | pass+doc-fix | 2026-10-09 | stub→глубина: правило 0/3%, confirm apply, action-log, auto network_prices |
| 13 | my-products | pass+doc-fix | 2026-10-09 | доступ; Применить; bulk/auto price_comp_sync; Webasyst SKU |
| 14 | moysklad | pass+doc-fix | 2026-10-09 | эталон списка уже глубок; доступ + auto moysklad / min_stock_export |
| 15 | ms-orders | pass+doc-fix | 2026-10-09 | stub→глубина; exclude owners; search_relaxed; auto ms_orders; меню до ms-sales |
| 16 | ms-sales | pass+doc-fix | 2026-10-09 | stub→глубина; mssales/full; soft-delete; api: меню не МП |
| 17 | medmarket | pass+doc-fix | 2026-10-09 | frontmatter+доступ; medmarket/fill; секция в api.md |
| 18 | projects | pass+doc-fix | 2026-10-09 | доступ; ≠ МП-конкуренты; прокси inherit/direct |
| 19 | queue | pass+doc-fix | 2026-10-09 | ключ queue → /pages+/parse; ≠ new-products queue |
| 20 | results | pass+doc-fix | 2026-10-09 | доступ; reparse → queue API; retention; Применить |
| 21 | matches | pass+doc-fix | 2026-10-09 | 4 шага UI; confirm-модалка; manual-queue/archive |
| 22 | exports-marketplaces | pass+doc-fix | 2026-10-09 | скрыт в меню; ключи на settings; parent→child hide + override |
| 23 | exports-marketplaces-ozon | pass+doc-fix | 2026-10-09 | shop; snapshot/ozon; API→parent key; auto marketplaces_ozon; api.md без «редирект» |
| 24 | exports-marketplaces-wildberries | pass+doc-fix | 2026-10-09 | shop; token-banner; cards/prices/stocks; auto marketplaces_wb 06:25 |
| 25 | exports-marketplaces-yandex | pass+doc-fix | 2026-10-09 | shop; shop_sku; auto marketplaces_ym 06:50 (анти-420) |
| 26 | exports-huckster | pass+doc-fix | 2026-10-09 | свой API-ключ; sync_script v1.0.4; confirm clear; auto huckster |
| 27 | exports-dimensions | pass+doc-fix | 2026-10-09 | measure→МС; pending/apply; confirm overlay; auto dimensions+export_ms |
| 28 | exports-marketplaces-issues | pass+doc-fix | 2026-10-09 | my-products table; pending/apply; fix dims/vat + action-log; denorm dims |
| 29 | exports-new-products (+29a–c) | pass+doc-fix | 2026-10-09 | 5 вкладок; float-host; np_ms_enrich/crm_notify; confirm overlay |
| 30 | exports-photoshoot | pass+doc-fix | 2026-10-09 | очередь маркетов; has_stock; авто out_of_stock; PATCH+log |
| 31 | exports-marketplaces-competitors | pass+doc-fix | 2026-10-09 | ≠ projects; mark dg_mp_competitor_marks; pending/apply |
| 32 | exports-marketplaces-reglament | pass+doc-fix | 2026-10-09 | статика v1.1; только public/; без API |
| 33 | purchase | pass+doc-fix | 2026-10-09 | док глубок; + product HTML dual; Пр.→НС ≠ min_stock_export; confirm overlay Пр.→НС/откат |
| 34 | suppliers | pass+doc-fix | 2026-10-09 | stub→глубина; confirm overlay send-ms-order; pending/apply; нет auto suppliers |
| 35 | supplier-analysis | pass+doc-fix | 2026-10-09 | stub→глубина; GET-only; pending/apply; ≠ suppliers/projects; нет auto |
| 36 | product-analysis | pass+doc-fix | 2026-10-09 | stub→глубина; bulk confirm overlay (не window.confirm); action-log+dry_run; URL share |
| 37 | product | pass+doc-fix | 2026-10-09 | вне меню; HTML dual purchase\|product; API→purchase; frontmatter; api/panel-map |
| 38 | sections | pass+doc-fix | 2026-10-09 | вне меню; нет API; список обновлён; док sections.md |
| 39 | login / no-access | pass+doc-fix | 2026-10-09 | вне PAGE_DEFS; then+redirect_after_login; док login.md |
| 40 | panel-map + docs build | pass+doc-fix | 2026-10-09 | panel-map актуален; `docs:docusaurus:build` → `public/docs/` |

## Системный блок

| # | Меню | `data-nav` / PAGE_DEFS | HTML | API (префикс) | Док |
|---|-------|------------------------|------|---------------|-----|
| 1 | Дашборд | `dashboard` | `/dashboard.html` | `/api/processes/db-size`, `/disk-usage`; overview → `processes`; sync-all → `settings` | ✅ [dashboard](../../docs-docusaurus/docs/dashboard.md) |
| 2 | Управление БД 🔒 | `db-admin` | `/db-admin.html` | `/api/db-admin` (жёстко admin / `can_manage_users`) | ✅ [db-admin](../../docs-docusaurus/docs/db-admin.md) |
| 3 | ArchitectUI 🔒 | `architectui-demo` *(не в PAGE_DEFS)* | `/ref/react-demo-index.html` → SPA `/architectui-react-pro/` | — | ✅ [architectui-migration](../../docs-docusaurus/docs/architectui-migration.md) |
| 4 | Активность/Логи 🔒 | `processes` | `/processes.html` | overview → `processes`; events → manage-users; track → session | ✅ [processes](../../docs-docusaurus/docs/processes.md) |
| 5 | Настройки | `settings` | `/settings.html` | settings + users + specialties + auto-sync-run; HTML ещё при `can_manage_users` | ✅ [settings](../../docs-docusaurus/docs/settings.md) |

## Финансы и кадры

| # | Меню | key | HTML | API | Док |
|---|-------|-----|------|-----|-----|
| 6 | Финансы | `finance` | `/finance.html` | `/api/finance` (Точка/Райф/Т‑Банк + cash/plans; auto `finance_tochka` w2) | ✅ [finance](../../docs-docusaurus/docs/finance.md) |
| 7 | Таблицы менеджеров | `manager-sales` | `/manager-sales.html` | `/api/manager-sales` (своя таблица; pick — бухгалтерия/делопр.; планы — без делопр.) | ✅ [manager-sales](../../docs-docusaurus/docs/manager-sales.md) |
| 8 | Операционный лист | `ops-sheet` | `/ops-sheet.html` | `/api/ops-sheet` (+ Planfix; auto `ops_planfix` w2 = только отчёт) | ✅ [ops-sheet](../../docs-docusaurus/docs/ops-sheet.md) |
| 9 | График работы | `work-schedule` | `/work-schedule.html` | `/api/work-schedule` (API = max с settings; clock/access без page lock) | ✅ [work-schedule](../../docs-docusaurus/docs/work-schedule.md) |
| 10 | График · настройки | `work-schedule-settings` | `/work-schedule-settings.html` | тот же `/api/work-schedule` (org/dept/emp; import-specialties) | ✅ [work-schedule](../../docs-docusaurus/docs/work-schedule.md) |

## Сайты и цены сети

| # | Меню | key | HTML | API | Док |
|---|-------|-----|------|-----|-----|
| 11 | Мои сайты | `my-sites` | `/my-sites.html` | `/api/my-sites` (fetch/sync/verify; sync-all-real) | ✅ [mysites](../../docs-docusaurus/docs/mysites.md) |
| 12 | Цены сети | `network-prices` | `/network-prices.html` | `/api/network-prices` (matrix/apply/link; auto `network_prices`) | ✅ [network-prices](../../docs-docusaurus/docs/network-prices.md) |

## МойСклад и продажи

| # | Меню | key | HTML | API | Док |
|---|-------|-----|------|-----|-----|
| 13 | Мои товары (сайты) | `my-products` | `/my-products.html` | `/api/my-products` (+ price-comp bulk; auto `price_comp_sync`) | ✅ [myproducts](../../docs-docusaurus/docs/myproducts.md) |
| 14 | Мой Склад (товары) | `moysklad` | `/moysklad.html` | `/api/ms` (sync/export/stats; auto `moysklad`) | ✅ [moysklad](../../docs-docusaurus/docs/moysklad.md) |
| 15 | Заказы в МС | `ms-orders` | `/ms-orders.html` | `/api/ms-orders` (customerorder; auto `ms_orders`) | ✅ [ms-orders](../../docs-docusaurus/docs/ms-orders.md) |
| 16 | Продажи МС | `ms-sales` | `/ms-sales.html` | `/api/ms-sales` (demand; auto `mssales` / `mssales_full`) | ✅ [ms-sales](../../docs-docusaurus/docs/ms-sales.md) |
| 17 | Медмаркет | `medmarket` | `/medmarket.html` | `/api/medmarket` (fill dry_run; auto medmarket / medmarket_fill) | ✅ [medmarket](../../docs-docusaurus/docs/medmarket.md) |

## Парсинг (подменю)

| # | Меню | key | HTML | API | Док |
|---|-------|-----|------|-----|-----|
| 18 | Конкуренты | `projects` | `/projects.html` | `/api/projects` (парсинг; ≠ exports-competitors) | ✅ [projects](../../docs-docusaurus/docs/projects.md) |
| 19 | Очередь | `queue` | `/queue.html` | `/api/pages` + `/api/parse` (алиас; оба → `queue`) | ✅ [queue](../../docs-docusaurus/docs/queue.md) |
| 20 | Результаты | `results` | `/results.html` | `/api/results` (clear/delete; reparse → `queue`) | ✅ [results](../../docs-docusaurus/docs/results.md) |
| 21 | Сопоставление | `matches` | `/matches.html` | `/api/matches` (auto + manual-queue/archive) | ✅ [matches](../../docs-docusaurus/docs/matches.md) |

## Маркетплейсы (подменю)

| # | Меню | key | HTML | API | Док |
|---|-------|-----|------|-----|-----|
| 22 | *(скрыт в меню)* Настройки МП | `exports-marketplaces` | `/exports-marketplaces.html` | `/api/exports/marketplaces` (status/config; parent access) | ✅ [marketplaces](../../docs-docusaurus/docs/marketplaces.md) |
| 23 | Ozon | `exports-marketplaces-ozon` | `/exports-marketplaces-ozon.html` | `/api/exports/marketplaces` (API→parent; snapshot/ozon) | ✅ [marketplaces](../../docs-docusaurus/docs/marketplaces.md) § Ozon |
| 24 | Wildberries | `exports-marketplaces-wildberries` | `…-wildberries.html` | то же (snapshot/wb; phases) | ✅ [marketplaces](../../docs-docusaurus/docs/marketplaces.md) § WB |
| 25 | Яндекс Маркет | `exports-marketplaces-yandex` | `…-yandex.html` | то же (snapshot/ym; yandex-market) | ✅ [marketplaces](../../docs-docusaurus/docs/marketplaces.md) § Я.М. |
| 26 | Huckster | `exports-huckster` | `/exports-huckster.html` | `/api/exports/huckster` (свой ключ; sync_script) | ✅ [marketplaces](../../docs-docusaurus/docs/marketplaces.md) § Huckster + [script-versioning](../../docs-docusaurus/docs/script-versioning.md) |
| 27 | Габариты | `exports-dimensions` | `/exports-dimensions.html` | `/api/exports/dimensions` | ✅ [marketplaces](../../docs-docusaurus/docs/marketplaces.md) § Габариты |
| 28 | Проблемы с товарами | `exports-marketplaces-issues` | `…-issues.html` | `/api/exports/marketplaces/issues*` | ✅ [marketplaces](../../docs-docusaurus/docs/marketplaces.md) § Проблемы |
| 29 | Новые товары | `exports-new-products` | `/exports-new-products.html` | `/api/exports/new-products` | ✅ [marketplaces](../../docs-docusaurus/docs/marketplaces.md) § Новые товары |
| 29a | *(matrixOnly)* Статистика контент | `exports-new-products-stats` | тот же HTML | `/api/exports/new-products/content-stats` | ✅ § Новые товары (вкладка) |
| 29b | *(matrixOnly)* Постоянные задачи | `exports-new-products-standing` | тот же | `…/standing-stats` | ✅ § Новые товары |
| 29c | *(matrixOnly)* Уведомления CRM | `exports-new-products-crm-notify` | тот же | `…/crm-notify` | ✅ § Новые товары + script-versioning |
| 30 | Отснять товары | `exports-photoshoot` | `/exports-photoshoot.html` | `/api/exports/photoshoot` | ✅ [marketplaces](../../docs-docusaurus/docs/marketplaces.md) § Отснять |
| 31 | Конкуренты (МП) | `exports-marketplaces-competitors` | `…-competitors.html` | `/api/exports/competitors` | ✅ [marketplaces](../../docs-docusaurus/docs/marketplaces.md) § Конкуренты МП |
| 32 | Инструкция (регламент) | `exports-marketplaces-reglament` | `…-reglament.html` | — (статика v1.1, только `public/`) | ✅ [marketplaces](../../docs-docusaurus/docs/marketplaces.md) § Инструкция |

## Закупки и аналитика

| # | Меню | key | HTML | API | Док |
|---|-------|-----|------|-----|-----|
| 33 | Закупки товары | `purchase` | `/purchase.html` | `/api/purchase` (+ product API; Пр.→НС БД) | ✅ [purchase](../../docs-docusaurus/docs/purchase.md) |
| 34 | Поставщики | `suppliers` | `/suppliers.html` | `/api/suppliers` | ✅ [suppliers](../../docs-docusaurus/docs/suppliers.md) |
| 35 | Анализ поставщиков | `supplier-analysis` | `/supplier-analysis.html` | `/api/supplier-analysis` | ✅ [supplier-analysis](../../docs-docusaurus/docs/supplier-analysis.md) |
| 36 | Анализ товаров | `product-analysis` | `/product-analysis.html` | `/api/product-analysis` | ✅ [product-analysis](../../docs-docusaurus/docs/product-analysis.md) |

## Вне сайдбара (реестр / служебное)

| key / URL | Назначение | Док |
|-----------|------------|-----|
| `product` / `/product.html` | Карточка товара (из закупок) | ✅ [product](../../docs-docusaurus/docs/product.md) |
| `sections` / `/sections.html` | Каталог статических экранов | ✅ [sections](../../docs-docusaurus/docs/sections.md) |
| `/login.html`, `/no-access.html` | Вход / нет доступа | ✅ [login](../../docs-docusaurus/docs/login.md) |
| `/docs/` | Эта справка | ✅ [manual](../../docs-docusaurus/docs/manual.md) |

## Сверка документации (прогон)

Отмечать при ревизии:

- [x] Сайдбар `_template.html` ↔ строки выше (2026-10-09)
- [x] `PAGE_DEFS` ↔ все `data-nav` (+ matrixOnly)
- [x] `API_PREFIX_RULES` ↔ префиксы в таблице
- [x] `docs-docusaurus/sidebars.js` ↔ страницы справки по модулям
- [x] `manual.md` — таблица URL панели актуальна
- [x] `api.md` — карта якорей включает work-schedule, medmarket, ms-orders, suppliers*
- [x] Сборка `npm run docs:docusaurus:build` после правок (2026-10-09, финал прогона 40/40)

## Автосинк (не пункты меню, но «важные модули»)

Реестр: `lib/datagonAutoSyncRegistry.js` → карточки на `/settings.html` и секции на `/processes.html`. Документация ключей — [api.md → Settings](../../docs-docusaurus/docs/api.md) / [settings.md](../../docs-docusaurus/docs/settings.md).
