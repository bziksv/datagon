---
id: marketplaces
title: Маркетплейсы
description: Подменю Маркетплейсы — Ozon, WB, Я.Маркет, Huckster, габариты, новые товары и смежные экраны
---

Подменю **Маркетплейсы** в боковой панели. Полная карта: [Карта панели](/docs/panel-map/). HTTP — [REST API → Exports](/docs/api/#exports--marketplaces).

## Настройки МП (скрытый пункт меню)

| | |
|--|--|
| URL | `/exports-marketplaces.html` |
| Ключ матрицы | **`exports-marketplaces`** |
| Меню | **Скрыт** (комментарий в `_template.html`): ключи и паузы задают на [Настройках](/docs/settings/); страница жива по прямому URL и ссылкам из гайдов |

На странице: справка «как устроено», ссылки на Ozon/WB/Я.М., бейджи состояния ключей (`GET /api/exports/marketplaces/status`), форма ключей в БД (`POST /config`) — только **admin** или **full** к разделу «Настройки». Env (`OZON_*`, `WB_*`, `YM_*`) имеет приоритет над `app_settings`.

Дочерние shop-экраны и API снапшотов идут под префиксом `/api/exports/marketplaces`, но **режим доступа** у листа HTML — свой ключ (`exports-marketplaces-ozon` и т.д.). Если родитель `exports-marketplaces` = `hidden`, дочерние тоже скрыты, **кроме** явного `view`/`full` у дочернего ключа (`isHtmlLeafAccessHidden`).

## Экраны подменю

| Пункт меню | URL | Ключ | Назначение |
|------------|-----|------|------------|
| Ozon / WB / Я.Маркет | `…-ozon\|wildberries\|yandex.html` | `exports-marketplaces-*` | Wide-таблицы + снапшоты |
| Huckster | `/exports-huckster.html` | `exports-huckster` | Матрицы UID; см. [§ Huckster](#huckster) · [версионирование](/docs/script-versioning/) |
| Габариты | `/exports-dimensions.html` | `exports-dimensions` | Замеры → МС; [§ Габариты](#габариты) |
| Проблемы с товарами | `…-issues.html` | `exports-marketplaces-issues` | Сводка МС × МП; [§ Проблемы](#проблемы-с-товарами) |
| Новые товары | `/exports-new-products.html` | `exports-new-products` (+ matrixOnly) | [§ Новые товары](#новые-товары) |
| Отснять | `/exports-photoshoot.html` | `exports-photoshoot` | [§ Отснять](#отснять-товары) |
| Конкуренты | `…-competitors.html` | `exports-marketplaces-competitors` | [§ Конкуренты МП](#конкуренты-мп) (≠ [Парсинг → Конкуренты](/docs/projects/)) |
| Инструкция | `…-reglament.html` | `exports-marketplaces-reglament` | [§ Инструкция](#инструкция-регламент) |

## Ozon (shop)

| | |
|--|--|
| URL | `/exports-marketplaces-ozon.html` |
| Ключ матрицы (HTML / меню) | **`exports-marketplaces-ozon`** |
| API | Префикс `/api/exports/marketplaces` — в матрице API привязан к родителю **`exports-marketplaces`** (не к ключу Ozon). Скрытие родителя без `view`/`full` у дочернего закрывает и HTML-лист |
| Скрипты | Общий shop: `exports-marketplaces-shop.scripts.html` + fragment фильтров; `data-dg-mp-shop="ozon"` |

### Карточки

1. **Фильтры и действия** — умный поиск (зеркало в шапке таблицы), менеджер / контент-менеджер, «Исключить плакаты», ⚙ поля фильтров, Свернуть. Поиск клиентский (мульти-токен AND по `offer_id` / `name`…); селекты менеджеров и плакаты перефильтровывают уже загруженный снапшот без нового HTTP.
2. **Выгрузка Ozon** — чекбокс «Включить архивные» (`include_archived=1` → `visibility: ALL` только при **«Обновить из маркетплейса»**); кнопки обновления и «Показать последнее сохранённое»; `#dg-mp-msg` / `#dg-mp-log` (шаги синка).
3. **Таблица Ozon** — wide shop (`#dg-mp-table-scroll-outer` + `translate3d` на `#dg-mp-thead`); 🧩/📏/Свернуть; пагинация «На странице» по умолчанию **100** (`dg.mp.page.size.ozon`).

### Данные и API

| Действие UI | HTTP |
|-------------|------|
| Открытие / «Показать последнее» | `GET …/snapshot?shop=ozon` |
| «Обновить из маркетплейса» | `GET …/ozon` (пишет в `marketplace_export_rows`) или фоновый `POST …/sync` + `GET …/sync-status` — см. [api](/docs/api/#exports--marketplaces) |
| Ключи | env `OZON_*` > `app_settings`; UI — [Настройки](/docs/settings/) / скрытая страница настроек МП |

Стыковка с МС: `manager` / `content_manager` из `ms_export` по `code = offer_id`. НДС Ozon — доли API → «Без НДС» / `5`/`7`/`10`/`20`.

### Автосинк

Задача **`marketplaces_ozon`** (`auto_sync_marketplaces_ozon_*`, слот по умолчанию 06:00 МСК) → `marketplace_export_rows`, лог `logs/marketplace-ozon-sync.log`. Карточка на [Настройках](/docs/settings/), журнал — [Активность / Логи](/docs/processes/).

## Wildberries (shop)

| | |
|--|--|
| URL | `/exports-marketplaces-wildberries.html` |
| Ключ матрицы (HTML / меню) | **`exports-marketplaces-wildberries`** |
| API | Тот же префикс `/api/exports/marketplaces` → родитель **`exports-marketplaces`** (+ override дочернего `view`/`full`) |
| Скрипты | Общий shop (`data-dg-mp-shop="wildberries"`); отличие UI — баннер `#dg-mp-token-banner` про лимиты категорий API (нет чекбокса архивных) |

### Карточки

Как у Ozon: фильтры (клиентский поиск / менеджеры / плакаты) → **Выгрузка Wildberries** (обновить / последнее сохранённое + `#dg-mp-msg` / `#dg-mp-log`) → wide-таблица с 🧩/📏/Свернуть, pageSize **100** (`dg.mp.page.size.wildberries`).

Баннер на странице: цены (`discounts-prices-api`) и остатки (`marketplace-api`) — **разные** окна лимитов; при 429 увеличить «WB other delay» в [Настройках](/docs/settings/).

### Данные и API

| Действие UI | HTTP |
|-------------|------|
| Открытие / «Показать последнее» | `GET …/snapshot?shop=wildberries` |
| «Обновить из маркетплейса» | `GET …/wildberries` — фазы cards → prices → stocks (частичный успех допустим: `step:prices:failed` / stocks skipped) |
| Ключи | env `WB_API_KEY` / `WB_TOKEN_TYPE` > `app_settings`; `wb_token_type` **не** отключает цены (`wb_prices_disabled_by_token` всегда `false`) |

Стыковка с МС: `ms_export.code = vendor_code`. Паузы: `delay_cards` / `delay_other` (не ниже `rate_limits_ms_min`). Подробности лимитов — [api → wildberries](/docs/api/#get-apiexportsmarketplaceswildberries).

### Автосинк

Задача **`marketplaces_wb`** (`auto_sync_marketplaces_wb_*`, слот по умолчанию **06:25** МСК) → `marketplace_export_rows`, лог `logs/marketplace-wb-sync.log`.

## Яндекс Маркет (shop)

| | |
|--|--|
| URL | `/exports-marketplaces-yandex.html` |
| Ключ матрицы (HTML / меню) | **`exports-marketplaces-yandex`** |
| API | Префикс `/api/exports/marketplaces` → родитель **`exports-marketplaces`** (+ override дочернего) |
| Скрипты | Общий shop (`data-dg-mp-shop="yandex"` → live-путь `/yandex-market`); без архивных и без WB-баннера |

### Карточки

Как у Ozon/WB: фильтры → **Выгрузка Яндекс Маркет** → wide-таблица (pageSize key `dg.mp.page.size.yandex`, default **100**).

### Данные и API

| Действие UI | HTTP |
|-------------|------|
| Открытие / «Показать последнее» | `GET …/snapshot?shop=yandex` (алиасы `yandex-market`, `ym`) |
| «Обновить из маркетплейса» | `GET …/yandex-market` — листинг/цены `offer-prices`, карточки `stats/skus`; `delay_ms` (дефолт 280) |
| Ключи | env `YM_API_KEY`, `YM_CAMPAIGN_ID`, опц. `YM_BUSINESS_ID` (ссылка «Покупателю») > `app_settings` |

Стыковка с МС: `ms_export.code = shop_sku`. НДС — коды Partner API → простые ставки (`2`→«10», `6`→«без НДС», …) — [api](/docs/api/#get-apiexportsmarketplacesyandex-market).

### Автосинк

Задача **`marketplaces_ym`** (`auto_sync_marketplaces_ym_*`, слот по умолчанию **06:50** МСК — после Ozon/WB, чтобы реже ловить **420** у Я.М.) → `marketplace_export_rows`, лог `logs/marketplace-ym-sync.log`.

## Huckster

| | |
|--|--|
| URL | `/exports-huckster.html` |
| Ключ матрицы / API | **`exports-huckster`** → `/api/exports/huckster` (**свой** ключ, не родитель МП) |
| Версия скрипта | `sync_script` из `lib/hucksterSyncRevision.js` (сейчас **v1.0.4 · rev.5**); бейджи у заголовка и «Обновление Huckster» |
| Справка API | [Exports / Huckster](/docs/api/#exports--huckster) · [версионирование](/docs/script-versioning/) |

### Карточки

1. **Наборы** — set1 (Export) / set2 (RRC): кабинеты Ozon/WB/ЯМ + опц. тип цены МС; `GET/POST …/config`, типы цен — `GET …/price-types`.
2. **Обновление Huckster** — «Обновить» (`POST …/sync` + poll `…/sync-status`), «Тест UID» (без записи snapshot), «Остановить», «Очистить таблицы» (`DELETE …/snapshot` после **своей** confirm-модалки). Креды: env `HUCKSTER_*` / `POST …/credentials`.
3. **Матрицы** Export / RRC / «Потеряшки» — wide-таблицы, клиентские фильтры (менеджер, репрайсер ok/bad, «Модели», архив МС на экране), пагинация default **100**.

Галочки архива МС при sync **сохраняются** в `app_settings`, но **не сужают** выборку моста в `POST /sync` — только отображение (`POST …/ms-bridge-row-flags` / archive-filters).

### Автосинк

Задача **`huckster`**: `auto_sync_huckster_*`. В `auto_sync_runs` статус **`completed`** только если снапшот сохранён **и** нет предупреждений Unit; иначе `failed` с текстом в `message` (см. кнопку «Лог» на [processes](/docs/processes/)). Лог файла: `logs/huckster-sync.log`.

## Габариты

| | |
|--|--|
| URL | `/exports-dimensions.html` |
| Ключ матрицы / API | **`exports-dimensions`** → `/api/exports/dimensions` |
| Меню | После Huckster (не сразу после Я.М. — см. `_template.html`) |
| Parent hide | Как shop: родитель `exports-marketplaces` = `hidden` скрывает лист, кроме явного `view`/`full` у дочернего |
| Справка API | [Exports / dimensions](/docs/api/#exports--dimensions-габариты) |

### Карточки

1. **Правки по сотрудникам** — график `GET …/log/edits-by-employee` (периоды, кэш).
2. **Фильтры и действия** — pending/applied (`Применить` / `По умолчанию`): поиск, тип, замер with/without, проблемные (остаток без замера), исключить компоненты комплектов; pageSize default **100**.
3. **Реестр** — inline-замеры → `POST …/measure`; лог строки; «↗ В МС» по строке / **«↗ В МС: все правки»** (`GET …/pending-sync` + bulk) — **игнорирует фильтры таблицы**, шлёт все override из БД (модалка предупреждает); откат из журнала — `POST …/log/revert`. Confirm — своя overlay (`#dg-dim-confirm-overlay`), не `window.confirm`.
4. **Журнал изменений** — `GET …/log/global` (свёрнут по умолчанию).

База: `ms_export` (склад. поз. «Да», сотрудничество / остаток). Overrides: `ms_dimensions_measurements`. Журнал: `ms_dimensions_log`. Габариты на issues-экране — из **denorm** `ms_entity_details`, не из таблицы замеров.

### Автосинк

Задача **`dimensions`** (мастер `auto_sync_export_ms_enabled` + `auto_sync_dimensions_*`, слот ~21:00, опц. дни недели) = серверный аналог «↗ В МС: все правки». Прогресс на [processes](/docs/processes/), лог `action=sync_ms`.

## Проблемы с товарами

| | |
|--|--|
| URL | `/exports-marketplaces-issues.html` |
| Ключ HTML / меню | **`exports-marketplaces-issues`** |
| API | `GET/POST /api/exports/marketplaces/issues*` — режим API по родителю **`exports-marketplaces`** (+ override дочернего `view`/`full`) |
| Таблица | Ветка **«Мои товары»**: `#dg-mpu-table-scroll-outer` + `thead#dg-mpu-thead` + JS `translate3d` (**не** shop-схема Ozon/WB/Я.М.) |
| Справка API | [GET …/issues](/docs/api/#get-apiexportsmarketplacesissues) и `fix-*-dims` / `fix-*-vat` |

### Карточки

1. **Гайд** (свёрнут) — шаги: обновить снапшоты shop → фильтры → таблица / массовые «Исправить».
2. **Журнал автоснимков** — `GET …/issues/snapshot-log`, ручная запись `POST …/snapshot-run` (смысл как `scope=any` + exclude bundles).
3. **Фильтры и действия** — pending/`Применить`: scope (`all` / `any` / `all3` / ozon|wb|ym / `vat_mismatch` / `dims_mismatch` / `no_supplier`), тип, менеджеры, exclude комплектов, stock&gt;0, умное скрытие столбцов; массовые кнопки fix dims/VAT по **применённой** выборке + `#dg-mpu-action-log-*` (счётчики / dry_run / ошибки). Confirm — overlay (`#dg-mpu-fix-*-overlay`), не полагаться на `window.confirm`.
4. **Таблица** — wide МС×3 МП; габариты МС из **denorm** карточки (≠ замеры на [Габаритах](#габариты)); pageSize default **100**.

Стык артикулов: `external_id` = offer_id / vendor_code / shop_sku. Fix пишет в ЛК МП и патчит локальный `marketplace_export_rows`.

## Новые товары

| | |
|--|--|
| URL | `/exports-new-products.html` |
| Ключ очереди | **`exports-new-products`** → `/api/exports/new-products` |
| Таблица | Lock: `#dg-np-float-host` (fixed-клон), **не** shop-`translate3d` на `#dg-np-thead` |
| Справка API | [Exports / Новые товары](/docs/api/#exports--новые-товары) |

### Вкладки и matrixOnly

| Вкладка | Hash / `?tab=` | Ключ матрицы | API |
|---------|---------------|--------------|-----|
| Альмамед | `#almamed` | `exports-new-products` | list/CRUD `channel=almamed` |
| Размещение на маркеты | `#marketplaces` | то же | `channel=marketplaces`; sync-markets / remove-placed |
| Статистика контент-отдела | `#stats` | **`exports-new-products-stats`** (`matrixOnly`) | `GET …/content-stats`; CRM links `scope=almamed\|marketplaces` |
| Постоянные задачи | `#standing` | **`exports-new-products-standing`** | `GET …/standing-stats`; CRM `scope=infographic` |
| Уведомления датагон-crm | `#crm-notify` | **`exports-new-products-crm-notify`** | `GET/POST …/crm-notify` (`script` v1.0.1 · rev.2) |

`hidden` у вкладки скрывает её и API; `view` — без записи CRM-привязок / notify. Parent `exports-marketplaces` = `hidden` — как у shop (override `view`/`full` у дочернего).

### Очередь (Альмамед / Маркеты)

- Фильтры pending/`Применить`; wide-таблица + комплекты на маркетах.
- Действия: добавить / bulk / раздать ответственных / sync-markets / убрать размещённые — confirm через `#dg-np-confirm-overlay` (+ action-log на тяжёлых).
- Маркеты: обогащение из кэша МС; live — при `POST /sync-markets-queue`; auto **`np_ms_enrich`** (интервал).
- CRM-комментарии: auto **`np_crm_notify`**; настройки на вкладке `#crm-notify` ([script-versioning](/docs/script-versioning/)).

## Отснять товары

| | |
|--|--|
| URL | `/exports-photoshoot.html` |
| Ключ / API | **`exports-photoshoot`** → `/api/exports/photoshoot` |
| Источник | `dg_new_products` `channel=marketplaces`, `status <> removed` (та же очередь, что вкладка «Размещение на маркеты» на [Новых товарах](#новые-товары)) |
| Parent hide | Как shop: родитель `exports-marketplaces` + override дочернего |
| Справка API | [Exports / Отснять товары](/docs/api/#exports--отснять-товары) |

### UI

- **Фильтры** pending/`Применить`: поиск, статус съёмки, остаток МС (`has_stock` default `1`), pageSize **100**; зеркало поиска в шапке таблицы.
- **Таблица** — SKU / артикул / название / остаток / статус / дата / комментарий; inline `PATCH …/:id`; лог ячеек `GET …/:id/log`.
- Статусы: `not_shot` · `out_of_stock` · `in_package` · `shot` · `boxed`. Авто: для `not_shot`/`out_of_stock` по `ms_export.stock` (≤0 → нет в наличии); `in_package`/`shot`/`boxed` авто не затирает.

Отдельного auto_sync для съёмки нет (данные живут в строках очереди новых товаров).

## Конкуренты (МП)

| | |
|--|--|
| URL | `/exports-marketplaces-competitors.html` |
| Ключ / API | **`exports-marketplaces-competitors`** → `/api/exports/competitors` (**свой** префикс, не `/api/exports/marketplaces`) |
| ≠ | [Парсинг → Конкуренты](/docs/projects/) (`projects`) — другой экран и API |
| Parent hide | Как shop: родитель `exports-marketplaces` + override дочернего |
| Справка API | [Exports / Competitors](/docs/api/#exports--competitors-конкуренты) |

### UI / данные

- Источник: **`ms_export`** + артикул `ms_entity_details.denorm_article`.
- Фильтры pending/`Применить`: умный поиск (AND / `|` / кавычки / `sku:`…), закупочная от–до, тип, склад. позиция (default **Да**), менеджер, статусы отметок Ozon/WB/Я.М., дата обновления отметки / «без отметки», pageSize **100**.
- Колонки: код/название → `/product.html?code=…`; ссылки **«Искать»** на витринах МП; селекты статуса → `POST …/mark` в **`dg_mp_competitor_marks`** (`0` пусто · `1` включена · `2` не требуется · `3` конкурентов нет).

Отдельного auto_sync нет.

## Инструкция (регламент)

| | |
|--|--|
| URL | `/exports-marketplaces-reglament.html` |
| Ключ матрицы | **`exports-marketplaces-reglament`** |
| API | **Нет** (чистая статика) |
| Сборка | Файл только в `public/` — **не** фрагмент vanilla (`static-html/vanilla/inners/…` отсутствует); `npm run sync:vanilla-public` его не трогает |
| Parent hide | Как shop: родитель `exports-marketplaces` + override дочернего |
| Версия | **1.1** (01.09.2026) — в футере страницы |

Самостоятельный документ (своя вёрстка, не оболочка ArchitectUI/Datagon): оглавление + блоки «поиск → склад» — входы SellerStats / KeyCollector / Датагон (действующие) / витрина МП → поставщик → отбор → реестр → гейт → договор / ЮР / контент / оплата / приёмка. Скриншоты: `/mp-assets/sellerstats|keycollector|datagon-sa|purchase/`. Кратко также в [api → Новые товары / регламент](/docs/api/#регламент--инструкция-мп).

## Автосинк (сводка)

Задачи `marketplaces_ozon` / `_wb` / `_ym`, `huckster`, `dimensions`, `np_*` — реестр `AUTO_SYNC_TASKS`, карточки на [Настройках](/docs/settings/), журнал на [Активность / Логи](/docs/processes/). После успешного sync МП сервер может дописать строку в `mp_issues_daily_snapshot` (см. api → snapshot-log).
