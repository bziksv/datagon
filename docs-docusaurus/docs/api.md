---
id: api
title: REST API
description: Справочник REST-эндпоинтов p.datagon.ru (основные группы и типовые запросы)
---

<blockquote class="dg-doc-tip">
Эта страница — **справочник HTTP API**: основные группы эндпоинтов, типовые тела запросов и недостающие ранее разделы (активность, обзор процессов, discover, расширенный матчинг, часть auth). Для сценариев панели см. разделы слева. Точное поведение и все поля тел — в исходниках <code>routes/*.js</code> и <code>server.js</code>.
</blockquote>

## Как пользоваться этой страницей

- Разделы сгруппированы по **URL-префиксам** (`/api/projects`, `/api/pages`, …). Внутри — методы **GET/POST/PUT/DELETE** с примерами тел JSON.
- Для интеграции **сначала** найдите нужный блок (например, **My products**), затем конкретный метод.
- Параметры **`limit`/`offset`** повторяют смысл пагинации в UI; специфичные фильтры перечислены в **Query** или в теле запроса.
- Если в UI включён **кэш** ответа (см. описание у `GET /api/my-products` и др.), при отладке учитывайте TTL или меняйте параметры запроса.
- Аутентификация: после `POST /api/auth/login` используйте выданный механизм (cookie / заголовки — как в вашем клиенте; панель хранит токен в `localStorage`).

## Карта разделов (якоря на этой странице)

| Задача | Раздел |
|--------|--------|
| Вход, сессии, пользователи | [Auth](#auth) |
| Лимиты парсинга, синк, автозапуски | [Settings](#settings) |
| Конкуренты, селекторы | [Projects](#projects) |
| Очередь URL, парсинг одной страницы | [Pages / Parse queue](#pages--parse-queue) |
| Таблица `prices`, очистка | [Results](#results) |
| Источники Bitrix/Webasyst, синк | [My sites](#my-sites) |
| Каталог `my_products`, фильтры | [My products](#my-products) |
| Цены эталон → сайты сети | [Цены сети](#цены-сети) |
| Матчинг, confirm/reject | [Matches](#matches) |
| Ручной матчинг, очереди, вспомогательные GET | [Расширенные маршруты матчинга](#расширенные-маршруты-матчинга) |
| МойСклад, `ms_export` | [MoySklad](#moysklad) |
| Выгрузки Ozon / WB / Я.Маркет | [Exports / marketplaces](#exports--marketplaces) |
| Конкуренты МП / Габариты / Новые товары / Отснять / Huckster | [Exports / Competitors](#exports--competitors-конкуренты) … [Huckster](#exports--huckster) |
| Продажи МС (отгрузки) | [Продажи МС](#продажи-мс) |
| Заказы покупателей МС | [Заказы в МС](#заказы-в-мс) |
| Медмаркет (стыковка кодов) | [Медмаркет](#медмаркет) · [справка](/docs/medmarket/) |
| Закупки товары (планирование, overrides) | [Закупки](#закупки) |
| Поставщики / анализ поставщиков / анализ товаров | роуты в [Подключение роутов](#подключение-роутов); UI — [Поставщики](/docs/suppliers/), [Анализ поставщиков](/docs/supplier-analysis/), [Анализ товаров](/docs/product-analysis/) |
| Карточка товара (детальная страница) | [Карточка товара](#карточка-товара) |
| График работы (`ws_*`) | [График работы](/docs/work-schedule/) |
| Массовый синк источников | [Глобальная синхронизация (server.js)](#глобальная-синхронизация-serverjs) |
| Сводка фоновых задач (логи в UI) | [Обзор процессов](#обзор-процессов) |
| События активности в UI | [Активность](#активность) |
| Размеры таблиц, превью, OPTIMIZE | [Управление БД](#управление-бд) |
| Балансы и проводки Точки | [Финансы](#финансы) |
| Годовые таблицы менеджеров | [Таблицы менеджеров](#таблицы-менеджеров) |
| Операционный лист | [Операционный лист](#операционный-лист) |
| Карта экранов панели | [Карта панели](/docs/panel-map/) |
| Примеры `curl` | [Минимальные проверки через curl](#минимальные-проверки-через-curl) |
| Версии скриптов синка | [Версионирование скриптов](/docs/script-versioning/) (эталон — Huckster `sync_script`) |

Если якорь в браузере отличается (локализация заголовков), откройте оглавление справа на этой странице Docusaurus — там верные ссылки.

Справочник по REST-эндпоинтам проекта.

Базовый URL (локально): `http://localhost:3000`

## Общие принципы

- Формат обмена: JSON.
- Основной префикс API: `/api`.
- Для старого фронтенда есть алиас входа: `POST /api/login`.
- Пагинация обычно поддерживает параметры `limit` и `offset`.
- Скрипты синка и матриц **версионируются** при изменении алгоритма: реестр `lib/*SyncRevision.js`, поле `sync_script` в ответах API, бейдж в UI. Подробно: [Версионирование скриптов](/docs/script-versioning/).

## Подключение роутов

- `/api/auth` -> `routes/auth.js`
- `/api` -> `routes/auth.js` (алиас legacy)
- `/api/settings` -> `routes/settings.js`
- `/api/projects` -> `routes/projects.js`
- `/api/pages` -> `routes/pages.js`
- `/api/parse` -> `routes/pages.js` (полный алиас `pages`)
- `/api/results` -> `routes/results.js`
- `/api/my-sites` -> `routes/mysites.js`
- `/api/my-products` -> `routes/myproducts.js`
- `/api/network-prices` -> `routes/networkPrices.js` (Цены сети: эталон → целевые сайты с `%`; `GET/POST /settings`, `GET /matrix`, `GET /resolve-product`, `POST /link`, `POST /content-task`, `POST /unlink`, `POST /deactivate`, `POST /activate`, `GET /action-log`, `POST /apply`, автосинк `triggerNetworkPricesSyncFromSettings`)
- `/api/matches` -> `routes/matches.js`
- `/api/ms` -> `routes/moysklad.js`
- `/api/medmarket` -> `routes/medmarket.js` (Медмаркет: стыковка `code`+тип (`10088+Товар`); `GET /`, `GET /sync-status`, `POST /sync`, `PATCH /mapping`, `POST /import`, `POST /fill-linkage-codes`)
- `/api/exports/marketplaces` -> `routes/exportsMarketplaces.js`
- `/api/exports/competitors` -> `routes/exportsCompetitors.js` (Маркетплейсы → Конкуренты: список `ms_export` + поиск на Ozon/WB/Я.М.)
- `/api/exports/dimensions` -> `routes/dimensions.js`
- `/api/exports/new-products` -> `routes/exportsNewProducts.js`
- `/api/exports/photoshoot` -> `routes/exportsPhotoshoot.js` (Маркетплейсы → Отснять товары)
- `/api/exports/huckster` -> `routes/exportsHuckster.js`
- `/api/ms-sales` -> `routes/msSales.js` (Продажи МС: отгрузки `entity/demand` + позиции с привязкой к `ms_export`)
- `/api/ms-orders` -> `routes/msOrders.js` (Заказы в МС: `entity/customerorder`, окно **30 дней**, исключение ответственных из `app_settings`)
- `/api/suppliers` -> `routes/suppliers.js` (Поставщики: агрегат по `ms_export` + `dg_supplier_settings`; `GET /`, `GET /assignees`, `GET /ms-order-log`, `GET /ms-order-log/:logId`, `GET /export/supplier`, `GET /export/purchaser`, `POST /:supplierKey/send-ms-order`, `PATCH /:supplierKey`)
- `/api/supplier-analysis` -> `routes/supplierAnalysis.js` (Анализ поставщиков: продажи из `ms_demand` + `ms_export.supplier`; `GET /projects`, `/overview`, `/ranking`, `/highlights`, `/trend`, `/products`, `/export`, `/data-freshness`; фильтр `project_mode` / `project_uuids`)
- `/api/product-analysis` -> `routes/productAnalysis.js` (Анализ товаров: продажи/остатки по SKU; `GET /projects`, `/presets`, `/overview`, `/ranking`, `/export`; `POST /decision`, `/decision/bulk`, `/min-stock/apply`; комментарии `POST|PATCH|DELETE /:code/comments[/:id]`; таблицы `dg_product_analysis_decisions`, `dg_product_analysis_comments`)
- `/api/purchase` -> `routes/purchase.js` (Закупки: `GET` список — SQL `ORDER BY` + пагинация, enrich страницы; `POST /override`, `POST /overrides-import`, журнал overrides: `GET /log`, `GET /log/stats`, `POST /log/cleanup`; перенос «Предлагаемый нес.ост.» → `ms_export.min_stock` (только БД): `POST /min-stock-apply/run`, …; выгрузка в МС — `auto_sync_min_stock_export` / `lib/datagonMinStockExportMs.js`)
- `/api/product` -> `routes/product.js` (Карточка товара: `ms_export` + `ms_entity_details` + продажи + `dg_bundle_components`; лог отсутствий — пакетно после синка МС: `stock≤0` или для базового кода `stock` &lt; min суффикса в `код-число`, см. `syncZeroStockLogAfterMoyskladExport`; снимки остатка по дням — `dg_product_stock_snapshot`, см. `syncProductStockSnapshotsAfterMoyskladExport` — оба вызываются из `routes/moysklad.js` после сохранения `ms_export`)
- `/api/activity` -> `routes/activity.js`
- `/api/db-admin` -> `routes/dbAdmin.js` (Управление БД: размеры таблиц, связи, превью, ANALYZE/OPTIMIZE)
- `/api/finance` -> `routes/finance.js` (Финансы: Точка JWT + Райф Open API + Т‑Банк T‑API, счета, балансы, проводки; **наличные** CRUD; банковские выписки — только чтение)
- `/api/manager-sales` -> `routes/managerSales.js` (Таблицы менеджеров: годовой журнал оплат `dg_manager_sales_rows`)
- `/api/ops-sheet` -> `routes/opsSheet.js` (Операционный лист: свод + Planfix-заявки `dg_ops_planfix_tasks`)
- `/api/work-schedule` -> `routes/workSchedule.js` (График работы: `ws_*`, clock, табель, отпуска, payroll, audit, экспорт 1С; см. [work-schedule.md](/docs/work-schedule/))
- `GET /api/processes/overview`, `POST /api/sync-all-start`, `POST /api/sync-site-start`, `GET /api/sync-status` -> `server.js`

## Auth

### POST `/api/auth/login`
Вход по логину и паролю. UI: [`/login.html`](/docs/login/) (поле `then` из `?then=`).

Body:
```json
{ "username": "admin", "password": "...", "then": "/dashboard.html" }
```

`then` опционален. В ответе — `auth_token`, `page_modes`, **`redirect_after_login`** (безопасный путь; при полностью закрытой матрице — `/no-access.html`).

### POST `/api/login`
Legacy-алиас входа (тот же обработчик, что и выше).

### POST `/api/auth/change-password`
Смена пароля.

Body:
```json
{ "username": "admin", "newPassword": "минимум 15 символов" }
```

### Прочие маршруты `routes/auth.js`

Используются панелью и админкой (после входа): `GET /api/auth/me`, `GET /api/auth/sessions-overview`, `POST /api/auth/sync-session-cookie`, `POST /api/auth/logout`, CRUD пользователей (`GET/POST /api/auth/users`, `PUT/DELETE /api/auth/users/:id`, `PUT /api/auth/users/:id/permissions`, `POST /api/auth/users/:id/revoke-sessions`, **`POST /api/auth/users/:id/archive`**, **`POST /api/auth/users/:id/unarchive`**). **`GET /api/auth/users`** (список с сессиями) доступен **admin** и пользователям с флагом **`can_manage_users`** (остальные операции по пользователям по-прежнему в основном только admin — см. код `routes/auth.js`). В списке пользователей есть поле **`is_archived`** (`0`/`1`). Архивный пользователь **не может войти** (`POST /api/auth/login` → 403) и его действующие сессии отзываются; назначения (например, сотрудник на поставщике) **сохраняются**, в UI помечаются суффиксом «(архивный)». Жёсткое `DELETE` лучше не использовать без нужды — предпочтителен архив. Детали полей — в коде роутера.

Ответы `GET /api/auth/me` и `POST /api/auth/login` (успех) дополнительно содержат: `specialty_id`, `specialty_name`, `page_modes` — объект «ключ раздела» → `hidden` | `view` | `full` (см. `lib/datagonPageRegistry.js`), а также **`redirect_after_login`** — безопасный путь (`/…html`) для редиректа после входа: учитывается желаемый `then` только если страница не скрыта для пользователя; иначе — первая доступная страница или `/no-access.html`, если матрица закрыла всё (чтобы не зацикливать `/login.html` ↔ `/dashboard.html`). Для `GET /api/auth/me` можно передать query **`?then=/path.html`** (как на странице логина); для `POST /api/auth/login` — поле **`then`** в JSON-теле. При создании/редактировании пользователя можно передать `specialty_id` в теле `POST /api/auth/users` и `PUT /api/auth/users/:id`.

### Специальности и матрица доступа

Запись (`POST`, `PUT`, `DELETE`, сохранение матрицы) — только **admin**. Чтение `GET /api/specialties` и `GET /api/specialties/pages` также разрешено пользователю с **`can_manage_users`** (форма нового пользователя на `/settings.html` при скрытой странице «Настройки» в матрице).

- `GET /api/specialties` — список специальностей (с числом привязанных пользователей).
- `POST /api/specialties` — создать; body: `{ "name": "..." }`.
- `PUT /api/specialties/:id` — переименовать; body: `{ "name": "..." }`.
- `DELETE /api/specialties/:id` — удалить (нельзя удалить системную «Полный доступ» и специальность с привязанными пользователями).
- `GET /api/specialties/pages` — каталог разделов панели (ключ, заголовок, html-файл) для матрицы.
- `GET /api/specialties/:id/access` — текущие режимы по разделам.
- `PUT /api/specialties/:id/access` — сохранить режимы; body: `{ "modes": { "dashboard": "full", "results": "view", ... } }`.

Записи к не-GET API (кроме путей без привязки к разделу в реестре) для не-admin проверяются по режиму раздела: при `hidden` — 403, при `view` — разрешены только GET/HEAD/OPTIONS.
Новые страницы из `PAGE_DEFS` автоматически досинхронизируются в `specialty_page_modes` для всех существующих специальностей при старте сервера; для «Полный доступ» ставится `full`, для остальных групп — `hidden` до явного выбора администратора. Запись с `matrixOnly: true` (например **`exports-new-products-stats`** — вкладка «Статистика контент-отдела», **`exports-new-products-standing`** — «Постоянные задачи») появляется в матрице настроек доступа, но не меняет HTML-лист родительского экрана.

## Settings

### GET `/api/settings/ms-demand-projects`

Справочник проектов из **`ms_demand`** для UI фильтра формулы продаж на `/settings.html`.

- Query: **`days`** (30…730, по умолчанию **365**) — окно для `GROUP BY project_uuid`.
- Ответ: `{ success, days, projects: [{ uuid, name, count }] }`.

### GET `/api/settings`
Получить текущие настройки приложения. Ключ **`finance_tochka_jwt` не отдаётся** (JWT Точки только через `/api/finance/config`).

### POST `/api/settings`
Обновить настройки парсинга/синхронизации.

Body (пример):
```json
{
  "default_limit": 100,
  "parse_batch_size": 50,
  "page_delay_ms": 0,
  "sync_batch_size": 500,
  "sync_delay_ms": 2000,
  "sync_mode": "always",
  "fetch_proxy_enabled": 0,
  "fetch_proxy_list": ""
}
```

Дополнительные поля (см. также отдельный эндпоинт ниже):

- **`fetch_proxy_enabled`** — `0` / `1`: использовать ли HTTP(S)-прокси при загрузке страниц конкурентов (для проектов в режиме «наследовать глобальные»).
- **`fetch_proxy_list`** — многострочный список прокси в формате, который ожидает клиент (см. UI «Настройки» и `routes/settings.js`); до ~120 000 символов.
- **`planfix_account`** / **`planfix_rest_api_key`** — REST аккаунта ПланФикс (`https://{account}.planfix.ru/rest`, по умолчанию `almamed`). Токен в карточке «Planfix» на `/settings.html`. Проверка: `POST /api/settings/planfix-test` (Bearer `GET /userinfo`).
- **`auto_sync_marketplaces_ozon_enabled`** / **`auto_sync_marketplaces_ozon_time`**, **`auto_sync_marketplaces_wb_*`**, **`auto_sync_marketplaces_ym_*`** — **отдельные** ежедневные обновления снапшотов Ozon / Wildberries / Я.Маркет (МСК). `task_type` в `auto_sync_runs`: `marketplaces_ozon` | `marketplaces_wb` | `marketplaces_ym`. Файловые журналы шагов: `logs/marketplace-ozon-sync.log`, `logs/marketplace-wb-sync.log`, `logs/marketplace-ym-sync.log`. Рекомендуемые слоты разнесены (06:00 / 06:25 / 06:50), чтобы Я.Маркет не ловил 420 сразу после Ozon/WB. Legacy `auto_sync_marketplaces_*` / `task=marketplaces` (все три сразу) оставлены для ручного API, в расписании UI больше не показываются; при первом старте после обновления включённое старое расписание мигрирует в три задачи (`auto_sync_marketplaces_split_v1`).
- **`auto_sync_huckster_enabled`** / **`auto_sync_huckster_time`** — ежедневное обновление матриц Huckster (МСК); учётные данные — из `app_settings` или `HUCKSTER_EMAIL` / `HUCKSTER_PASSWORD`.
- **`auto_sync_np_ms_enrich_enabled`** / **`auto_sync_np_ms_enrich_interval_min`** / **`auto_sync_np_ms_enrich_weekdays`** — дозаполнение пустых кода / штрихкода / НДС / РУ в очереди «Новые товары → маркеты» из **кэша** МойСклад (без live API). Интервал: **15 / 30 / 60** мин (слоты МСК `:00`/`:15`/`:30`/`:45` в зависимости от шага). Дни недели — CSV `1=пн…7=вс` (пусто или `1…7` — каждый день). `task: "np_ms_enrich"`.
- **`auto_sync_np_crm_notify_enabled`** / **`auto_sync_np_crm_notify_interval_min`** / **`auto_sync_np_crm_notify_weekdays`** — проверка очереди «Новые товары» и комментарии в задачи CRM. Интервал **15 / 30 / 60** мин. Период сводки и автор комментария — `np_crm_notify_digest_days`, `np_crm_notify_instant_enabled`, `np_crm_notify_crm_user_id` (вкладка `#crm-notify`). `task: "np_crm_notify"`.
- **`auto_sync_db_size_enabled`** / **`auto_sync_db_size_time`** — ежедневный пересчёт кэша размера БД для дашборда (МСК, `HH:MM`).
- **`auto_sync_export_ms_enabled`** — мастер-переключатель блока «Экспорт в МС» на `/settings.html`; без него не планируются **`dimensions`** и **`min_stock_export`**.
- **`auto_sync_dimensions_enabled`** / **`auto_sync_dimensions_time`** / **`auto_sync_dimensions_weekdays`** — ежедневная **выгрузка пользовательских габаритов** (`ms_dimensions_measurements`) в МойСклад (МСК, `HH:MM`, по умолчанию `21:00`). Серверный аналог кнопки «↗ В МС: все правки (все страницы)» на `/exports-dimensions.html`: для каждой позиции с override и валидным `uuid` в `ms_export` отправляет `PUT /entity/{product|bundle}/{uuid}` через `routes/dimensions.js → runScheduledSyncMs`. Каждое отправленное поле фиксируется в `ms_dimensions_log` как `action='sync_ms'` с `note='sync_ms entity=… http=… (schedule)'`. Прогресс и summary видны на `/processes.html` (раздел «Габариты МС») и в `auto_sync_runs.message` (после старта текст **обновляется по ходу** каждые 5 позиций: `обработано/всего`, ✓/×, без uuid; финально — `Всего: N; ✓ ok; × err; пропущено (без uuid): K`).
- **`auto_sync_min_stock_export_enabled`** / **`auto_sync_min_stock_export_time`** / **`auto_sync_min_stock_export_weekdays`** — **выгрузка неснижаемого остатка** в МойСклад: `ms_export.min_stock` → `product.minimumBalance` через `lib/datagonMinStockExportMs.js → runScheduledMinStockExportMs` (МСК, по умолчанию **`22:00`**; дни недели — CSV **1=пн … 7=вс**, пусто = каждый день). Охват: **`stock_position = 'Да'`**, **`is_archived = 0`**, есть **`uuid`**, тип не «Комплект», **`min_stock`** задан. Ошибки — таблица **`ms_min_stock_export_log`**; прогресс — `/processes.html` (раздел «Неснижаемый остаток МС»), `GET /api/processes/min-stock-export-errors?from=&to=` для модалки «Лог».
- **`auto_sync_mssales_enabled`** / **`auto_sync_mssales_time`** / **`auto_sync_mssales_days`** / **`auto_sync_mssales_weekdays`** — **импорт продаж МС** (`entity/demand` → `ms_demand` / `ms_demand_position`) для `/ms-sales.html` (МСК, `HH:MM`, по умолчанию `07:30`). Окно периода — `auto_sync_mssales_days` (1..1825 дней, default **90**). **`auto_sync_mssales_weekdays`** — дни недели по календарю **МСК**: строка CSV, числа **1=пн … 7=вс**; пустая строка, значение **`1,2,3,4,5,6,7`** или все семь галочек в UI — запуск **каждый** календарный день (в БД «все дни» нормализуется в явную семёрку, чтобы снятие одного дня не схлопывалось обратно в «все дни»). Серверный путь — `triggerSync(db, { days, incremental: true, awaitCompletion: true })`: **инкремент** с `MAX(moment) − 1 сутки` до `NOW()` (не head-resume по `MIN(moment)`). Планировщик в `server.js` сравнивает текущий день недели в МСК с этим множеством и только тогда ставит задачу в очередь (вместе с совпадением `HH:MM`). Запись в `auto_sync_runs` (`task_type='mssales'`, в `message` — префикс `инкремент с …` при догрузке хвоста).
- **`auto_sync_mssales_full_enabled`** / **`auto_sync_mssales_full_time`** / **`auto_sync_mssales_full_days`** / **`auto_sync_mssales_full_weekdays`** — отдельное расписание **полного** синка продаж МС: `triggerSync(db, { days, fresh: true })` (аналог «Полный синк с нуля» на `/ms-sales.html`). Окно по умолчанию **730** дней; дни недели — тот же формат CSV (**по умолчанию только `7`** — воскресенье). `task_type='mssales_full'` в `auto_sync_runs`. Не планируйте на то же `HH:MM`, что обычный `mssales`, если оба включены: один активный job `ms-sales` в памяти.
- **`auto_sync_purchase_formula_cache_enabled`** / **`auto_sync_purchase_formula_cache_time`** — batch-заполнение **`dg_formula_proposed_cache`** для дефолтной выборки закупок (`routes/purchase.js → runPurchaseFormulaCacheBatch`). `task_type='purchase_formula_cache'` в `auto_sync_runs`; журнал на `/processes.html`. Кнопка «Запустить сейчас» и «Пересчитать кэш» на `/purchase.html` — `POST /api/settings/auto-sync-run` с `task: "purchase_formula_cache"`.
- **`auto_sync_medmarket_enabled`** / **`auto_sync_medmarket_time`** / **`auto_sync_medmarket_weekdays`** — **полная выгрузка** атрибута «Код товара для медмаркета» из `ms_entity_details` → `ms_export.medmarket_product_code` (импорт, не запись в МС). МСК, по умолчанию `09:00`, дни **`7` (только вс)**. `task_type='medmarket'`.
- **`auto_sync_medmarket_fill_enabled`** / **`auto_sync_medmarket_fill_time`** / **`auto_sync_medmarket_fill_weekdays`** — запись канонического **`код+Тип`** в атрибут МС и `ms_export` (как `POST /api/medmarket/fill-linkage-codes` без фильтров). Очередь «к записи» — только позиции с неверным/устаревшим форматом (~10–12 тыс., в основном регистр); ~46 тыс. уже со стыковкой пропускаются. МСК, по умолчанию **`09:30`**, дни **`1,2,3,4,5,6` (пн–сб, без вс)**. `task_type='medmarket_fill'`. Прогресс: `N/всего; ✓; ×` в `auto_sync_runs.message`.
- **`auto_sync_price_comp_*`** — массовая синхронизация цен с конкурента (Dealmed/Медкомплекс) в CMS, как кнопка «Синх. цены по фильтрам» на `/my-products.html`. Ключи: `enabled`, `time` (по умолчанию **`10:00`**), `weekdays`, `match_audit` (по умолчанию **`confirmed`**), `rand_min` / `rand_max` (`0.1` / `0.99`), `stock_min` / `stock_max` (`0` / `1000`), `site_id` (`all`). `task_type='price_comp_sync'`. Фоновый runner: чанк 150, CMS×4.
- **`auto_sync_network_prices_enabled`** / **`auto_sync_network_prices_time`** / **`auto_sync_network_prices_weekdays`** — **Цены сети** (`/network-prices.html`): эталон (по умолчанию Альмамед, `network_prices_source_site_id`) → целевые сайты с заданным `price_pct`. Формула: эталон → **RUB** (курс ЦБ при EUR/USD) × `(1 + price_pct/100)` → CMS + `my_products`. **0 эталона всегда пишется как 0**. Если на сайте цена **> 0**, пишем только при расхождении с расчётом **> 3%**. После записи на Bitrix-сайт — `cache_clear.php`. Сайты без `%` или с `enabled=0` пропускаются. МСК, по умолчанию **`11:00`**, дни `1…7`. `task_type='network_prices'`. Runner: `routes/networkPrices.js → triggerNetworkPricesSyncFromSettings`.
- **`auto_sync_finance_tochka_enabled`** / **`auto_sync_finance_tochka_time`** / **`auto_sync_finance_tochka_days`** / **`auto_sync_finance_tochka_weekdays`** — выгрузка счетов и выписки **Точка.API** в `dg_finance_accounts` / `dg_finance_tx` (только чтение). По умолчанию **выкл.**, слот **`07:00`**, окно **30** дн. (1…1095). JWT **не** в `GET /api/settings` — страница `/finance.html`. `task_type='finance_tochka'`. Runner: `routes/finance.js → triggerFinanceSyncFromSettings`. В реестре **`worker: 2`** (отдельный pm2 `parser-autosync-w2`).
- **`auto_sync_ops_planfix_enabled`** / **`auto_sync_ops_planfix_time`** / **`auto_sync_ops_planfix_weekdays`** — автосинк **только отчёта Planfix 450694** (generate + статусы на лист), как кнопка «Только отчёт» на `/ops-sheet.html`. Период — как в UI Planfix (API дат не принимает; сейчас «последние 14 дней»). Снимок пишется в `(year, month)` текущего месяца МСК. По умолчанию **вкл.**, слот **`20:00`**. `task_type='ops_planfix'`. Runner: `routes/opsSheet.js → triggerOpsPlanfixReportSyncFromSettings`. **`worker: 2`**.
- **`sales_formula_replenishment_days`** (основной UI: «Пополнение, дней»), **`sales_formula_sku_replenishment_enabled`** (`1`/`0`, галка «Рек. дни пополнения по товарам» — авто-подъём **горизонта** `k` по SKU; по умолчанию `1`; вместе с упущенными за A даёт более жёсткий запас против нуля, не дубль одной поправки), **`sales_formula_replenishment_coef`** (legacy/синхрон = дни÷W), **`sales_formula_sales_window_days`** (W — «Продажи за период», сумма и средний спрос для формулы v2), **`sales_formula_absence_analysis_days`** (A — дни отсутствия → **упущенные шт в спросе**), **`sales_formula_project_mode`** (`all` | `selected`), **`sales_formula_project_uuids`** (CSV `project_uuid` из `ms_demand`; при `selected` в сумму продаж для формулы и колонок `d_*a` входят только отгрузки выбранных проектов), **`sales_formula_base_qty`**, **`sales_formula_rare_base_qty`**, **`sales_formula_rare_avg_max`** (legacy, в v2 не используется), **`sales_formula_expensive_rare_threshold_rub`**, **`sales_formula_expensive_rare_min_qty`**, **`sales_formula_max_change_coef`**, **`sales_formula_incomplete_pack_pct`** — **формула продаж** на карточке товара (`GET /api/product/:code` → `formula`). Логика в `lib/datagonSalesFormula.js` (v2: сумма за W + упущенные, ×(дни÷W) **без** прибавки `sales_formula_base_qty` / `sales_formula_expensive_rare_min_qty`; редкий/дорогой; кратность + `incomplete_pack_pct`). **Оверрайд по поставщику:** `dg_supplier_settings.replenishment_days` (если задано) сильнее глобальных дней; правит только `admin` на `/suppliers.html`. В `formula` ответ: `replenishment_source` = `global` | `supplier`, `replenishment_days_effective`. Кэш `dg_formula_proposed_cache.formula_fp` = base + `|rd:g` или `|rd:N`. UI глобали — `/settings.html`.
- **`auto_sync_runs_retention_days`** — срок хранения строк в **`auto_sync_runs`** (журнал запусков автосинхронизации на `/processes.html`, кнопка «Лог»; по умолчанию **180**). Автоочистка в `server.js` удаляет только записи с непустым `finished_at` старше N дней (при старте и каждые 12 ч). UI: карточка **«Журнал запусков автосинхронизации»** на `/settings.html` (`GET /api/settings/auto-sync-runs/stats`, `POST /api/settings/auto-sync-runs/cleanup`). На каждой карточке расписания — кнопка **«Лог»** → модалка с днём МСК (`GET /api/settings/auto-sync-runs?task=&date=`).
- **`product_stock_snapshot_retention_days`** — срок хранения дневных снимков **`ms_export.stock`** в **`dg_product_stock_snapshot`** (очистка при каждом успешном полном синке МС; по умолчанию **365**, диапазон **30…3650**). UI: карточка **«Снимки остатка МС (карточка товара)»** на `/settings.html` (`sectionId='stock-snap-retention'`).

### GET `/api/settings/auto-sync-runs`

Журнал запусков **одной** задачи автосинка за календарный день (МСК). Для модалки «Лог» на `/settings.html`.

Query:
- `task` — ключ из `AUTO_SYNC_TASKS` (`moysklad`, `mssales`, `dimensions`, …); обязателен
- `date` — `YYYY-MM-DD` (день по МСК); по умолчанию сегодня МСК

Ответ: `{ success, task, date, moscow_today, total, data: [{ id, task_type, trigger_type, started_at, finished_at, status, message }] }`.

### GET `/api/settings/auto-sync-runs/stats`

Статистика таблицы **`auto_sync_runs`** для карточки «Журнал запусков автосинхронизации» на `/settings.html`.

Ответ (пример):

```json
{
  "success": true,
  "total": 420,
  "oldest_started_at": "2025-11-13T08:24:00.000Z",
  "newest_started_at": "2026-05-13T20:40:00.000Z",
  "open_running": 0,
  "by_task": { "dimensions": 120, "myproducts": 80 },
  "retention_days": 180,
  "older_than_retention": 12
}
```

- **`open_running`** — число строк без `finished_at` (активные или забытые `running`; в обычном режиме после завершения задачи должно быть 0).
- **`older_than_retention`** — сколько **завершённых** записей (`finished_at` не `NULL`) старше текущего retention будет удалено при следующей автоочистке или по кнопке «Очистить сейчас».

### POST `/api/settings/auto-sync-runs/cleanup`

Удалить из **`auto_sync_runs`** завершённые строки с `finished_at` старше `days` дней. Body (JSON, опционально): `{ "days": 180 }`. Если `days` не передан или невалиден — берётся `app_settings.auto_sync_runs_retention_days`. Строки без `finished_at` **не** удаляются.

Ответ: `{ "success": true, "deleted": 12, "days": 180 }`.

### POST `/api/settings/planfix-test`

Проверка REST ПланФикс: Bearer `GET /userinfo` (fallback `GET /ping`) к `https://{planfix_account}.planfix.ru/rest`. Токен из `app_settings.planfix_rest_api_key` (нужно сохранить заранее). Ответ: `{ success, message, account, base, http_status, user }`.

### POST `/api/settings/auto-sync-run`

Принудительно поставить одну задачу автосинхронизации в общую очередь расписания, не дожидаясь времени запуска. Используется кнопками «Запустить сейчас» в `settings.html`.

Body: `{ "task": "myproducts" | "moysklad" | "ms_orders" | "marketplaces_ozon" | "marketplaces_wb" | "marketplaces_ym" | "marketplaces" | "huckster" | "np_ms_enrich" | "np_crm_notify" | "db_size" | "dimensions" | "min_stock_export" | "mssales" | "mssales_full" | "purchase_formula_cache" | "medmarket" | "medmarket_fill" | "price_comp_sync" | "network_prices" | "finance_tochka" | "ops_planfix" }`. Whitelist — `lib/datagonAutoSyncRegistry.js → getAutoSyncTaskKeys()` плюс legacy **`marketplaces`** (все три площадки одним прогоном). Запись в `auto_sync_runs` с `trigger_type = "manual"`. Для `dimensions` — балк как по расписанию. Для `mssales` / `mssales_full` / `ms_orders` — см. соответствующие `auto_sync_*` выше. Для **`purchase_formula_cache`** — `runPurchaseFormulaCacheBatch(db, appSettings)` (дефолтные фильтры закупок, чанками без RAM-снимка). Для **`medmarket`** — `routes/medmarket.js → triggerSync(db)` (каталог из `ms_export`). Для **`price_comp_sync`** — `routes/myproducts.js → triggerPriceCompSyncFromSettings(appSettings)` (фильтры из `auto_sync_price_comp_*`). Для **`network_prices`** — `routes/networkPrices.js → triggerNetworkPricesSyncFromSettings` (все enabled-сайты с заданным `%`). Для **`finance_tochka`** — `routes/finance.js → triggerFinanceSyncFromSettings` (счета + выписка Точки за `auto_sync_finance_tochka_days`). Для **`np_ms_enrich`** — `lib/dgNewProductsMarkets.js → backfillMarketsMsFieldsFromCache` (кэш МС, без live API).

Ответ `{ "success": true, "queued": true|false, "skip_reason": null|"already_running"|"already_queued"|"invalid_task"|"wrong_worker", "task", "worker", "local_worker", "dispatch_id?", "queue", "runner_active", "running_tasks" }`. Поле **`worker`** — целевой воркер задачи из реестра (`1` = `parser-app`, `2` = `parser-autosync-w2`). Если целевой воркер ≠ HTTP-процессу, задача пишется в **`auto_sync_dispatch`** и подхватывается вторым процессом (см. [Деплой](/docs/deploy)). Поле **`running_tasks`** — массив строк `task_type` с незавершённой записью в `auto_sync_runs`. Поле **`queued: false`** — задача **не** добавлена (`skip_reason`). На `/settings.html` ответ показывается плашкой на карточке; у каждой задачи бейдж **«Воркер N»**.

**Локально:** при `DATAGON_AUTO_SYNC_SCHEDULER=off` (`npm run dev:local`) этот endpoint **работает** (ручной запуск), а тики расписания в `startAutoSyncScheduler` — нет. На проде scheduler включён. См. [Деплой](/docs/deploy).

### GET `/api/processes/min-stock-export-errors`

Ошибки выгрузки неснижаемого за интервал запуска (`ms_min_stock_export_log`). Query: `from`, `to` (ISO), `limit` (по умолчанию 200). Используется модалкой «Лог» на `/processes.html` для `task_type=min_stock_export`.

### POST `/api/settings/fetch-proxy`

Только **`fetch_proxy_enabled`** и **`fetch_proxy_list`** (удобно сохранять блок прокси без остальных полей настроек). Body: JSON `{ "fetch_proxy_enabled": 1, "fetch_proxy_list": "…" }`. Ответ: `{ "success": true }`.

### POST `/api/settings/sync-myproducts`

Запуск фоновой синхронизации «моих товаров» из настроек (см. `routes/settings.js`).

### POST `/api/settings/sync-moysklad`

Запуск фоновой синхронизации МойСклад из настроек.

### GET `/api/settings/logs-info`

Размер и `mtime` файлов **`server.log`** и **`worker.log`** в корне проекта (рядом с `server.js`), если они существуют. На `/settings.html` отдельного блока под это больше нет; эндпоинт оставлен для скриптов/диагностики.

### POST `/api/settings/logs-clear`

Обнуляет содержимое тех же двух файлов (создаёт пустые при отсутствии). Имеет смысл только если процесс действительно пишет stdout/stderr в эти пути.

## Projects

### GET `/api/projects`
Список проектов конкурентов.

### POST `/api/projects`
Создать проект.

Body:
```json
{
  "name": "Конкурент 1",
  "domain": "example.com",
  "selector_price": ".price",
  "selector_name": "h1",
  "selector_sku": ".sku",
  "selector_oos": ".out-of-stock",
  "fetch_proxy_mode": "inherit"
}
```

- **`fetch_proxy_mode`** — `inherit` (по умолчанию: если глобально включён прокси — запросы идут через него) или `direct` (всегда без прокси для этого проекта). Значение `custom` в API приводится к `inherit` (см. `lib/datagonFetchProxy.js`).

### PUT `/api/projects/:id`
Обновить проект. Тело — как у `POST` (все поля селекторов и при необходимости **`fetch_proxy_mode`**).

### DELETE `/api/projects/:id`
Удалить проект.

## Pages / Parse queue

Доступно в двух префиксах:

- `/api/pages/*`
- `/api/parse/*` (алиас)

### GET `/api/pages`
Список URL в очереди.

Query:
- `project_id`
- `status`
- `type`
- `search`
- `matched` (`1` / `0` / пусто) — фильтр по confirmed-сопоставлению: сначала набор URL из `product_matches`⋈`prices` (по sku/name), затем `pages.url IN (…)` / `NOT IN` — без коррелированного EXISTS и без `CREATE INDEX` на GET
- `sort_by` / `sort_dir`
- `limit`
- `offset`

В каждой строке `data[]` дополнительно:
- `is_matched` (`0`/`1`) — confirmed-сопоставление;
- `product_name` — последнее имя товара конкурента из `prices` по `page_id` (пустая строка, если ещё не парсили). UI очереди показывает имя перед ссылкой в колонке «Товар / URL».

### POST `/api/pages/bulk`
Массовое добавление URL в очередь.

Body:
```json
{
  "project_id": 1,
  "urls_text": "https://site/a\nhttps://site/b"
}
```

### DELETE `/api/pages/:id`
Удалить одну страницу из очереди.

### POST `/api/pages/clear`
Удалить страницы по фильтрам (`project_id`, `status`, `type`).

### POST `/api/pages/reset`
Сбросить статус страниц в `pending` по фильтрам.

### POST `/api/pages/page/:id`
Запустить парсинг одной страницы по ID.

### POST `/api/pages/visible`
Запустить парсинг по текущим фильтрам/выборке.

### POST `/api/pages/refresh-single`
Добавить/вернуть один URL в очередь.

Body:
```json
{ "url": "https://...", "project_id": 1 }
```

### POST `/api/parse/refresh-results`
Вернуть в очередь URL из **результатов по текущим фильтрам** (тот же смысл статуса, что в списке: `COALESCE(pages.status, prices.page_status_cached)`). Обновляет `pages.status=pending` и `prices.page_status_cached`.

Body (пример):
```json
{ "project_id": 4, "page_status": "error", "search": "" }
```

### POST `/api/pages/discover-start`

Запуск фонового обхода (discover) по sitemap/правилам проекта.

### GET `/api/pages/discover-status`

Статус задач discover (снимок для UI).

### POST `/api/pages/discover-stop`

Остановка discover.

## Results

### GET `/api/results`
Получить результаты парсинга (`prices`).

Query:
- `project_id`
- `search` — подстрока по `sku`, `product_name`, `url` (и `pages.url` при join)
- `matched` — `1` только сопоставленные / `0` только без подтверждённого матча (фильтр через `IN`/`NOT IN` от подтверждённых `product_matches`, не построчный `EXISTS`)
- для строк ответа дополнительно: `match_partners[]` (`my_sku`, `my_product_name`, `my_site_name`, …), `match_my_sku` / `match_my_name` / `match_my_site` (первая пара)
- `page_status`, `page_error` (`pages.last_error`) — в UI бейдж «Ошибка» показывает человекочитаемую подсказку по наведению
- `limit` — максимум **1500** строк на запрос (сверху зажимается на сервере; раньше до 25000 можно было положить Node по памяти).
- `offset`

Кэш ответа в памяти процесса используется только при `limit` ≤ **400** (и `limit=0` для count-only).

### POST `/api/results/clear`
Очистить результаты (все или по `project_id`).

### DELETE `/api/results/:id`
Удалить одну запись результата.

## My sites

### GET `/api/my-sites`
Список подключенных сайтов-источников.

### POST `/api/my-sites`
Добавить источник и проверить подключение к внешней БД.

### PUT `/api/my-sites/:id`
Изменить настройки источника.

### DELETE `/api/my-sites/:id`
Удалить источник.

### POST `/api/my-sites/:id/fetch`
Тестовая выборка товаров из источника.

Body:
```json
{ "limit": 100 }
```

### POST `/api/my-sites/:id/sync`
Пакетная синхронизация в `my_products`.

Query:
- `init=true` (сброс активности и подготовка)
- `batch`
- `offset`

### POST `/api/my-sites/:id/verify-stats`

Проверка/пересчёт статистики по источнику (валидация подключения и данных).

### POST `/api/my-sites/sync-all-real`
Полная синхронизация всех источников (синхронный маршрут в роутере `mysites`).

## Цены сети

Экран `/network-prices.html`, роутер `routes/networkPrices.js`. Эталон (по умолчанию **Альмамед**, `app_settings.network_prices_source_site_id = 2`) → целевые сайты с наценкой/скидкой `%`. Связь пар: ручная (`network_product_links`) или авто по одинаковому артикулу (пока нет записи в `network_product_link_ignore`). **Остаток** в v1 только в матрице, в CMS не пишется.

Правило записи: если у сайта `enabled=0` или `price_pct` NULL — сайт целиком пропускается; иначе `proposed = round(source_rub × (1 + price_pct/100))`. **Эталон 0 → всегда пишем 0** на сателлит («цена по запросу»). Если живая цена сайта **> 0**, пишем только когда `|сайт − proposed| / сайт > 3%`. Пустой эталон (не число) не пишем. Для Bitrix после пакета — `cache_clear.php`.

Таблицы (DDL при первом запросе): `network_price_site_settings`, `network_product_links`, `network_product_link_ignore`, `network_content_tasks`, `network_prices_action_log`.

### GET `/api/network-prices/settings`

`{ success, source_site_id, source, targets: [{ site_id, name, domain, enabled, price_pct, … }] }`.

### POST `/api/network-prices/settings`

Body: `{ source_site_id?, targets: [{ site_id, enabled, price_pct|null }] }`. Пустой `price_pct` → NULL (сайт не трогаем). Ответ: `{ success, verified }`.

### GET `/api/network-prices/matrix`

Query: `target_site_id` (обяз.), `link_status` (`all` | `linked` | `unlinked` | `source_only` | `target_only`), `search`, `limit`, `offset`.

Ответ: `{ success, enabled, price_pct, fx: { usd_to_rub, eur_to_rub, updated_at, source }, total, data[] }` — строки с полями эталона/цели (`source_url` / `target_url`, `source_currency` / `target_currency`), **`target_price` = живая цена витрины CMS** (Bitrix `PRICES` по артикулу / view; не кэш `my_products` после синка), `target_price_cached` (значение из Datagon, если подменили), `target_price_source`, `proposed_price` (**всегда RUB**), `proposed_currency`, `source_price_rub`, `fx_applied`, `delta_pct_vs_proposed` (живая цель vs предл. в рублях), `link_kind` / `link_status`, `target_source_enabled` (0 = деактивирован на сателлите, строка остаётся в матрице).

**Валюта:** EUR/USD эталона → RUB по курсу ЦБ (`lib/datagonFxRates.js`, cbr-xml-daily, как «Мои товары»), затем × `(1 + price_pct/100)`. `POST /apply` и автосинк пишут рубли.

Сортировка: **сначала свежие** (ручная связь `created_at` / задача контенту `updated_at` DESC), затем `target_product_id` DESC.
### GET `/api/network-prices/resolve-product`

Превью поиска товара перед связью. Query: `q` (артикул/код/ID), `side` = `source`|`target` (по умолчанию `source`), для `target` — `target_site_id`.

Ответ при одном совпадении: `{ success, site_id, side, product: { id, source_id, sku, name, price } }`. При нескольких — `409` + `candidates[]`; не найдено — `404` + `error`.

### POST `/api/network-prices/link`

Body: `{ target_site_id, source_product_id?, target_product_id?, source_query?, target_query? }` — ручная связь (снимает ignore). Можно передать ID пары или query для разрешения через `resolveSiteProduct`. Пишет строку в `network_prices_action_log` (`action=link`).

### POST `/api/network-prices/content-task`

Задачи контент-отделу по строке цели (`network_content_tasks`). Body: `{ target_site_id, target_product_id, selected?: string[] }` (массово выставить поля в `need`) **или** `{ target_site_id, target_product_id, field, value }` — одно поле (`add_photo` / `add_parent` / `add_satellite` / `delete_product`) и статус. Лог: `action=content_task`.

### POST `/api/network-prices/unlink`

Body: `{ target_site_id, source_product_id, target_product_id? }` — удаляет manual-link и ставит ignore (чтобы автопо SKU не вернулась). Лог: `action=unlink`.

### POST `/api/network-prices/deactivate`

Деактивация товара **на сателлите** (витрина). Body: `{ target_site_id, target_product_id, confirm: true }`.

- Bitrix: `b_iblock_element.ACTIVE='N'`, `TIMESTAMP_X=NOW()`, суффикс `CODE` (`…-deactivated-{ID}`), `b_catalog_product.AVAILABLE='N'`, удаление из `b_search_content*`, сброс `b_cache_tag`; затем HTTP `GET https://{domain}/local/datagon/cache_clear.php` (токен = `sha256(db_pass + '|datagon-bitrix-cache-clear-v1')`, скрипт `scripts/bitrix-cache-clear.php` на сателлите) — иначе витрина продолжает отдавать старый HTML из `bitrix/cache/…/catalog.element`;
- Webasyst: `shop_product.status=0`;
- Datagon: `my_products.source_enabled=0`, связи этой цели удаляются.

Лог: `action=deactivate` в `network_prices_action_log` (`detail` включает `cache_clear`).

### POST `/api/network-prices/activate`

Включение товара **на сателлите** обратно. Body: `{ target_site_id, target_product_id, confirm: true }`.

- Bitrix: `ACTIVE='Y'`, снятие суффикса `CODE` `…-deactivated-{ID}`, `AVAILABLE='Y'`, включение цепочки разделов (`b_iblock_section.ACTIVE='Y'` вверх по родителям — иначе SEF-URL с выключенным разделом даёт 404), сброс `b_cache_tag` + `cache_clear.php`;
- Webasyst: `shop_product.status=1`;
- Datagon: `my_products.source_enabled=1`. Связь с эталоном **не** восстанавливается автоматически.

Лог: `action=activate` (`detail.sections_activated[]`). UI: у выключенной строки бейдж «выкл. на сайте» + кнопка **«Включить»** (confirm-модалка).

### GET `/api/network-prices/action-log`

Query: `target_site_id?`, `target_product_id?`, `source_product_id?`, `action?` (например `content_task` / `link` / `unlink` / `deactivate` / `activate`), `limit` (default 50, max 200). Ответ: `{ success, data: [{ id, created_at, actor, action, …, message, detail_json }] }`.

UI `/network-prices.html`: микрокнопка **«лог»** при наведении на ячейку **Действия** (весь журнал строки) и на **Контент-отделу** (только `action=content_task`) — оверлей `#dg-npr-row-log-overlay`.
### POST `/api/network-prices/apply`

Body: `{ target_site_id, search?, dry_run: 0|1, confirm: true }` (для записи нужен `confirm` или `dry_run=1`).

Ответ-счётчики: `scanned`, `would_update` (dry_run) / `written`, `skipped_unchanged` (уже совпало или расхождение ≤ 3%), `skipped_no_source_price` (эталон пустой, не 0), `cms_failed`, `errors[]` (до 20), `duration_sec`, `message`.

Также: `GET /apply-status`, `POST /apply-stop`. Автосинк по расписанию — `task: "network_prices"` (см. Settings).

## My products

### GET `/api/my-products`
Список товаров из локальной таблицы `my_products`.

Для источников **Webasyst** каждая модификация (`shop_product_skus`) — отдельная строка: `source_id` = id SKU, `cms_product_id` = id карточки `shop_product` (колонка «ID / КОД» и ссылка в админку CMS), `sku` = артикул; уникальность `(site_id, source_id)`.

Query (основные):
- `site_id` — ID источника (`my_sites.id`) или `all`
- `status` — `all` | `0` | `1` (`is_active`)
- `source_enabled` — `all` | `0` | `1` (учёт на стороне источника)
- `ms_linked` — `all` | `1` | `0` (есть / нет совпадения с `ms_export` по коду МойСклад: `cms_product_id` (или `source_id`, если карточки нет), либо `sku`; сравнение после `UPPER(TRIM(...))`)
- `search` — поиск по полям товара (несколько слов через пробел)
- `sort_by`, `sort_dir` — сортировка (`id`, `site`, `sku`, `name`, `price`, …)
- `limit`, `offset` — пагинация
- фильтр разрыва с конкурентом: `gap_filter_enabled`, `gap_exclude_zero`, `gap_competitor`, `gap_min_pct`, `gap_max_pct`, опционально второй диапазон **ИЛИ** `gap_min_pct_2` / `gap_max_pct_2` (оба заданы → совпадение с любым из двух диапазонов), `usd_to_rub`, `eur_to_rub`
- `match_audit` — `all` | `confirmed` | `unlinked` | `none` (аудит `product_matches`). `confirmed` / `unlinked` / `none` строятся через `JOIN` к набору id из матчей (по `my_sku` ∪ по `my_product_name`), **не** через коррелированный `EXISTS` по всем ~40k `my_products` (тот путь давал десятки секунд на COUNT). При `gap_filter_enabled=1` пагинация в SQL снимается: сначала выбираются все строки по фильтрам, затем gap считается в Node — без узкого `search` / `match_audit` это тяжело.

Кэш ответа: при неизменных параметрах повторный запрос в течение **120 с** может вернуть тот же JSON с полем `cache` (`source`, `age_ms`, `ttl_ms`). Проверка кэша — **до** DDL/прогрева индексов.

### GET `/api/my-products/stats`
Агрегированная статистика **по каждому** `site_id` (одна строка на сайт в ответе).

Query:
- `site_id` — опционально, иначе по всем сайтам
- `status` — `all` | `0` | `1`
- `source_enabled` — `all` | `0` | `1`
- `ms_linked` — `all` | `1` | `0` (как у списка товаров)

Поля в каждой строке ответа:
- `total` — активные записи (`is_active = 1`)
- `active` / `disabled` — среди активных: включённые / выключенные на источнике (`source_enabled`)
- `disappeared` — `is_active = 0`
- `linked` — среди активных: есть строка в `ms_export`, где `code` совпадает с `UPPER(TRIM(COALESCE(NULLIF(cms_product_id,''), source_id)))` или с непустым `UPPER(TRIM(sku))`

Кэш ответа: **15 с** по полному набору query-параметров (снижает параллельную нагрузку на БД при открытии «Мои сайты» и «Мои товары»). Значения считаются на сервере; при необходимости мгновенно актуальных цифр подождите TTL или обновите страницу позже.

### GET `/api/my-products/fx-rates`
Курсы USD/EUR к рублю для UI. Query: `force=1` — принудительно подтянуть с ЦБ (иначе используется кэш на сервере).

### POST `/api/my-products/refresh-one`
Обновить один товар из внешнего источника.

Body:
```json
{ "site_id": 1, "sku": "ABC-123" }
```

### POST `/api/my-products/sync-price-from-competitor`
Подтянуть цену с конкурента в источник (логика в `routes/myproducts.js`). В теле: `site_id`, `sku`, опционально `source_id`, `random_min_pct` / `random_max_pct`. Берётся **минимальная** цена среди Dealmed/Медкомплекс (в RUB), минус случайный % из диапазона; запись в CMS + аудит `comp_sync_*` в `my_products`. Заголовок `x-auth-username` / сессия попадает в аудит.

### POST `/api/my-products/sync-price-from-competitor-bulk`
Массовая синхронизация цены с конкурента по **тем же API-фильтрам**, что у `GET /api/my-products` (сайт, статус, поиск, остаток, связь с МС, `match_audit`, фильтр Δ и курсы). Клиентские поля таблицы (`tf_*`) **не** участвуют.

Параметры (query и/или JSON body):
- фильтры списка: `site_id`, `status`, `source_enabled`, `search`, `stock_min`, `stock_max`, `ms_linked`, `match_audit`, `gap_filter_enabled`, `gap_exclude_zero`, `gap_competitor`, `gap_min_pct`, `gap_max_pct`, `gap_min_pct_2`, `gap_max_pct_2`, `usd_to_rub`, `eur_to_rub`;
- `random_min_pct` / `random_max_pct` (по умолчанию `0.1` / `0.99`);
- `dry_run=1` — быстрый `COUNT(*)` по SQL (`estimate_exact: false`). При включённом Δ в `note` поясняется, что точный отбор будет в фоне перед записью (чтобы не блокировать кнопку в UI).
- `confirm=1` — старт **фоновой** задачи. Ответ сразу `{ started: true, status }`. Повторный старт при активной задаче → `409 ALREADY_RUNNING`. Жёсткий потолок рабочей выборки: **50 000** (без Δ — по SQL COUNT; с Δ — по числу после отбора Δ).

Фоновый runner:
- при `gap_filter_enabled=1` сначала фаза `selecting`: отбор id по Δ (как в таблице), затем запись только по ним; `total_sql` = размер отобранного набора, `skipped_gap` = отсеянные на отборе;
- без Δ: читает порциями `PRICE_SYNC_CHUNK` (**150**) по `id DESC`;
- enrich конкурентов пачкой на чанк;
- пишет в CMS параллельно до **`cms_concurrency` = 4** соединений на `site_id` (слот воркера → своё соединение);
- счётчик `skipped_no_competitor` / alias `no_dm_mk_price` — **нет пригодной цены Dealmed/Медкомплекс > 0** (не путать с `match_audit=confirmed`: confirmed может быть с любым конкурентом).

### GET `/api/my-products/sync-price-from-competitor-bulk-status`
Статус: `active`, `phase` (`idle|selecting|writing|done|cancelled|error`), `scanned` / `total_sql`, `cms_ok`, `cms_failed`, `skipped_gap`, `skipped_no_competitor` / `no_dm_mk_price`, `chunk_size`, `cms_concurrency`, `message`, `errors[]`, `duration_sec`.

### POST `/api/my-products/sync-price-from-competitor-bulk-stop`
Запрос остановки (`cancel_requested`); на отборе Δ останавливается между чанками SQL, на записи — после текущего чанка → `phase: cancelled`.

UI: `/my-products.html` → **«Синх. цены по фильтрам»** + **«Стоп синх. цен»** + `#mp-action-log` (план → опрос статуса каждые 2 с → итог; подпись пропуска — «без цены ДМ/МК» / «отсеяно по Δ»).

## Matches

### GET `/api/matches/my-sites`
Справочник "моих сайтов" для сопоставления.

### GET `/api/matches/my-products`
Список моих активных товаров для выбора перед запуском.

Query:
- `my_site_id` (обязательно)
- `search`
- `limit`
- `offset`

### GET `/api/matches/competitors`
Список конкурентных проектов для сопоставления.

### POST `/api/matches/start-matching`
Запустить фоновую задачу сопоставления.

Body (пример):
```json
{
  "mySiteId": 1,
  "competitorIds": [2, 3],
  "threshold": 0.85,
  "mode": "sku",
  "productIds": null,
  "productSearch": "",
  "batchSize": 200,
  "batchPauseMs": 1000,
  "microPauseMs": 20,
  "microPauseEvery": 20,
  "resumeMode": false
}
```

`mode` по умолчанию (если не передан / невалидный): **`sku`** (строгий артикул). Варианты: `sku` | `sku_norm` | `sku_best` | `all` | `name`. UI рекомендует сначала SKU-режимы, затем `all` / `name`. Мисс в любом режиме пишет `match_exclusion` (`no_match` → ручная очередь шага 3) **пакетами** (bulk `INSERT … ON DUPLICATE KEY UPDATE`), без 3–4 SQL на каждый товар; `rejected` не затирается.
### POST `/api/matches/retry-last`
Повторить/продолжить последнюю задачу сопоставления.

### POST `/api/matches/stop`
Остановить активную задачу.

Body:
```json
{ "mySiteId": 1 }
```

### POST `/api/matches/find-matches`
Legacy-эндпоинт (обратная совместимость старого фронта).

### GET `/api/matches/status`
Статус последней задачи сопоставления.

Query:
- `my_site_id` (обязательно)

### GET `/api/matches/list`
Список найденных сопоставлений.

Логическая пара «наш сайт + конкурент + товар» хранится с полем `match_identity_hash` (SHA-256 от нормализованных SKU или от пары названий) и уникальным индексом по `(my_site_id, competitor_site_id, match_identity_hash)`, чтобы не появлялись дубли строк при повторном матчинге. Миграция хеша/индекса — в `warmupMatchingIndexes` при старте (не на каждый `GET /list`).

Query:
- `my_site_id`
- `competitor_site_id`
- `status` (`pending`, `confirmed`, `rejected`)
- `search` / `q` — подстрока по нашему/конкурентному SKU и названию (и `confirmed_by`)
- `my_sku` — подстрока только по нашему артикулу (поле «Мой SKU» в UI; фильтр на сервере, не только по текущей странице)
- `competitor_sku` — подстрока по артикулу конкурента
- `confidence_min` / `confidence_max` — порог схожести в процентах 0…100 (как в UI)
- `match_type` — `sku` | `name` | `manual` | `all` (пусто/`all` — без фильтра; `manual` — ручные пары из шага 3)
- `multi_comp_cards` — `1` / `true` / `yes`: только строки, у которых к тому же нашему товару (по SKU; без SKU — по названию) уже есть **более одной** `confirmed`-карточки **того же** конкурента. UI шага 2 — галка «Несколько карточек одного конкурента»; URL `multi_comp_cards=1`
- `limit`
- `offset`

Сортировка списка:
- `status=confirmed` — `confirmed_at DESC`, затем `id DESC` (свежие подтверждения сверху);
- `status=rejected` — `rejected_at DESC`, затем `id DESC`;
- иначе (`pending` / без статуса) — `confidence_score DESC`, затем `id DESC`.

В ответе к строкам подмешиваются цены/URL/`my_cms_product_id` из `my_products`. При **неуникальном SKU** сначала ищется карточка по **точному названию** (`my_product_name`), и только если нет — по артикулу (иначе чужой код «переезжает» на подтверждённую пару).

`GET /api/matches/manual-queue` для дублей артикула добавляет `sku_not_unique`, `sku_duplicate_count` и при наличии другой подтверждённой пары — `sibling_confirmed` (`product_match_id`, `cms_product_id`, `source_url` / `source_id`, названия/SKU обеих сторон, `competitor_url` из `prices`, `confirmed_by` / `confirmed_at`). UI шага 3 — модалка сравнения со ссылками «Мой товар» / «Редактировать» / «Конкурент» и кнопкой **«Пересвязь»**.

### POST `/api/matches/manual-match/relink`

Перенести уже подтверждённого конкурента с другой карточки того же артикула на товар из ручной очереди. Пара остаётся `confirmed`, строка очереди снимается.

Body: `{ my_site_id, competitor_site_id, my_product_id, product_match_id }` (`product_match_id` — `sibling_confirmed.product_match_id`).

Фильтр «уже confirmed по названию» — **anti-join** к `DISTINCT` confirmed-имён (не коррелированный `NOT EXISTS`). Query: `my_site_id` (обяз.), опц. `competitor_site_id` / `search` / `exclusion_reason` / `limit` / `offset` / `include_total` (`0` — без COUNT). Ответ: `{ data, total, total_approx, limit, offset, include_total }`. COUNT кэшируется ~15 с и дедупится in-flight; на SELECT — `MAX_EXECUTION_TIME(15000)`. Индексы: `idx_pm_site_comp_status_name`, `idx_me_site_comp_updated` (через `ensureMatchesPerfIndexes`).

### POST `/api/matches/confirm`
Подтвердить совпадение. Опционально коэффициент упаковки для gap/синка цен:

Body:
```json
{ "id": 123, "pack_qty": 12, "pack_basis": "ours" }
```

- `pack_basis`: `ours` (наша упаковка = N шт. конкурента → цена×N) | `competitor` (мы поштучно, упаковка конкурента N → цена÷N)
- оба пусто / без полей — сравнение 1:1
- `pack_qty` целое ≥ 2

**Правило 1:1 на конкурента:** после confirm остальные `confirmed` по тому же нашему товару (ключ — SKU; без SKU — название) и тому же `competitor_site_id` переводятся в `pending` (как «Разорвать»). Ответ дополнительно: `unlinked_siblings`, `unlinked_ids`. То же при `POST /api/matches/manual-match/confirm` и `POST /api/matches/manual-match/relink`. Существующие дубли массово не чистятся — смотрите фильтр `multi_comp_cards=1` в списке.

В `GET /api/matches/list` у строки: `pack_qty`, `pack_basis`, `competitor_price` (лист), `competitor_price_comparable`.

### PATCH `/api/matches/:id/pack`
Сохранить/сбросить упаковку без смены статуса. Body: `{ "pack_qty", "pack_basis" }` (пусто — сброс).

### POST `/api/matches/reject`
Отклонить совпадение.

Body:
```json
{ "id": 123 }
```

### POST `/api/matches/unlink`

Снять подтверждённое сопоставление (разорвать пару). Тело — идентификаторы записи матчинга (см. `routes/matches.js`).

`POST /api/matches/manual-match/confirm` принимает те же опциональные `pack_qty` / `pack_basis` и тоже снимает лишние confirmed с того же конкурента.
## Расширенные маршруты матчинга

Эндпоинты для экрана «Сопоставление» (ручная очередь, архив, поиск по ценам конкурента, лог): `GET/DELETE /api/matches/manual-queue`, `POST /api/matches/manual-queue/return-to-auto` (массово «Вернуть в авто» по фильтрам: `my_site_id`, опц. `competitor_site_id` / `search` / `exclusion_reason`, `confirm: true`; ответ `{ success, deleted, duration_sec, filters }`; лог — пакет до 50 примеров + сводка, без N отдельных INSERT), `POST /api/matches/manual-queue/archive-all` (массово «В архив все» по тем же фильтрам + опц. `note`; ответ `{ success, archived, duration_sec, filters }`), `GET/DELETE /api/matches/manual-archive` (`GET` — query `my_site_id`, опц. `competitor_site_id` / `search` / `limit` (1–300, UI по умолчанию 100) / `offset`; UI шага 4 — пагинация «На странице» + Назад/Вперёд, URL `manual_archive_page` / `manual_archive_limit`; поиск по SKU/названию нашего товара, SKU/названию конкурента, заметке, `archived_by`, имени/домену проекта; в строках также `mp_source_url`, `my_site_domain`, `my_site_cms_type` для ссылки «Мой товар»), `GET /api/matches/prices-resolve-sku`, `GET /api/matches/prices-search`, `GET /api/matches/product-match-log`, `POST /api/matches/manual-match/confirm`, `POST /api/matches/manual-match/archive`. Точные query и JSON — в `routes/matches.js`. **Поле `archived_by`** в ответе `GET /api/matches/manual-archive` — пользователь, который нажал «В архив» в блоке ручного сопоставления (заполняется при `POST /api/matches/manual-match/archive` через `resolveActorDisplayName`); миграция колонки `match_manual_archive.archived_by VARCHAR(100) NULL` и UNIQUE `uq_match_manual_archive (my_site_id, competitor_site_id, my_product_id)` живут внутри `ensureMatchLaneTables()` (дубли архива схлопываются при старте; запись в архив — upsert). **Семантика шага 4:** пара в `match_manual_archive` больше не попадает в авто-сопоставление и не создаёт `match_exclusion` (шаг 3), пока запись не удалят из архива; при миграции/архивировании пересечения с очередью очищаются.

## MoySklad

> **Эталон списочной страницы.** UI `/moysklad.html` — образец, по которому делаются все новые списочные страницы Datagon vanilla (две карточки: «Фильтры и действия» + «Выгрузка &lt;X&gt;», шестерёнка с auto-discovery полей, поиск-зеркало в шапке таблицы, кнопки `🧩 Столбцы` / `📏 Ширины` / `Свернуть` справа). Контракт — в правилах `.cursor/rules/datagon-list-page-baseline-moysklad.mdc` и `.cursor/rules/datagon-table-filter-apply.mdc`; пользовательская справка — [МойСклад](/docs/moysklad/#эталон-списочной-страницы).

### POST `/api/ms/sync`
Запустить фоновую синхронизацию в таблицу `ms_export`.

Этап 6/6 (`сохранение в ms_export`) выполняется **батчами по 2000 строк** (раньше шла одна команда `INSERT ... VALUES ?` на все ~60k строк × 24 колонки — на боевых снапшотах формировала SQL в десятки/сотни МБ и упиралась либо в `max_allowed_packet` MySQL, либо в OOM Node, после чего pm2/systemd рестартовал процесс и UI «зависал» на сообщении «Этап 6/6: сохранение в ms_export» с `jobState = {active:false, message:'Ожидание', total:0, processed:0}`). Прогресс-лог архивируется каждые ~10k строк (а также на последнем чанке) — в журнале синка видны записи `Сохранено в ms_export: N/M`. Сразу после завершения всех чанков выполняется пакетный upsert в `dg_product_zero_stock_log` за **сегодня** (`routes/product.js → syncZeroStockLogAfterMoyskladExport`): только строки с `stock_position='Да'`, `is_archived=0` и (`stock≤0` или для кода без «-» остаток строго меньше минимального числового суффикса среди номенклатур `<тот же код>-<целое>` в `ms_export`) (источник `moysklad_sync`; запись с `manual` за тот же день не перезаписывается). Затем буфер `exportRows` освобождается до старта `saveMoyskladEntityDetails` — это снимает пик памяти перед потоковой записью полных карточек.

**Поле `min_stock`** (DECIMAL(15,3) NULL, миграция `ensureMsMinStockColumn`) — нативное поле МС API `product.minimumBalance` («Неснижаемый остаток»). Заполняется только для строк `type='Товар'`; для `type='Комплект'` хранится `NULL`, потому что у `bundle` в МС-схеме поле `minimumBalance` не задано. UI `/moysklad.html` рендерит колонку «Неснижаемый остаток» прямо перед «Остаток»; для `NULL` показывает «—», чтобы пользователь отличал «норматив не задан» от честного 0. Сортировка по полю поддерживается (входит в `allowedSortFields` API list-эндпоинта).

Этап «Сохранение полных карточек МойСклад» (`ms_entity_details`) — потоковый: накапливается батч на 100 сущностей, тут же делается `INSERT ... ON DUPLICATE KEY UPDATE` и буфер обнуляется. Раньше функция сначала собирала `JSON.stringify` ВСЕХ сущностей в массив (`payload_json` под 280 МБ – 1 ГБ), и в паре с живым `all` в памяти Node уходил в OOM на боевом стенде ровно после успешного сохранения `ms_export`. Прогресс архивируется на круглых процентах (5 / 10 / … / 100) и при `processed === total`.

Параллельно в таблицу пишутся узкие поля **`denorm_article`**, **`denorm_in_transit`**, **`denorm_pack_qty_auto`**, **`denorm_market_price_rub`** (вычисляются из той же сущности до сериализации в `payload_json`, см. `lib/datagonMsEntityPurchaseDenorm.js`), чтобы **`GET /api/purchase`** мог собирать строки без выборки `LONGTEXT payload_json` на весь отфильтрованный список. До следующего полного синка МС старые строки без denorm обновляются скриптом `scripts/backfill-ms-entity-denorm.mjs` (по желанию).

### GET `/api/ms/status`
Проверить статус задачи синхронизации.

### GET `/api/ms/export`
Получить экспортированные строки.

Query:
- `search` — **умный поиск** по `code`, `name`, `supplier`, `supplier2`. Поддерживает группы через `|` (как ИЛИ) и явные ключи `sku:` (=`code:`), `name:`, `supplier:`, `manager:`, `content_manager:`, `stock:` (`да|нет|yes|no|1|0`). Без префикса token ищется по `code OR name OR supplier OR supplier2`. Реализация — `buildSmartSearchClause` в `routes/moysklad.js`.
- `type` (`all`, `Товар`, `Комплект`)
- `limit`
- `offset`
- прочие поля фильтрации — см. `buildExportFilters` в `routes/moysklad.js`
- **сеточные** фильтры (поля карточки «Фильтры и действия» на экране «МойСклад» — распределены по двум рядам, см. [МойСклад → Блоки интерфейса](/docs/moysklad/#блоки-интерфейса); те же условия что и для `/api/ms/stats`): `g_code`, `g_name`, `g_supplier`, `g_supplier2`, `g_manager`, `g_content_manager`, `g_type` (подстрока типа, регистр не важен), `g_stock_min`, `g_stock_max`, `g_archived` (`all` | `0` | `1`). Эти `g_*` параметры — единственный источник для соответствующих значений из формы; **дублирующиеся** API-поля (`supplier=`, `manager=`, `type=` и т.п.) на UI **не показываются** (см. `static-html/vanilla/inners/moysklad.inner.html` — оставлены только `ms-tf-*` поля), и `routes/moysklad.js` обратно совместим с обоими наборами параметров.

### GET `/api/ms/detail/:uuid`

Полная карточка товара или комплекта для экрана «МойСклад» по клику на наименование. Данные берутся из таблицы `ms_entity_details`; вечерняя синхронизация обновляет их массово, а если записи ещё нет или она устарела, сервер запрашивает API МойСклад и сохраняет ответ в базу. В ответе есть поле `source`: `db` или `api`.

Query:

- `kind` — подсказка типа сущности: `product` | `bundle` или строка с подстрокой «комплект» (как в поле `type` выгрузки).

Ответ: `success`, `kind`, `uuid`, `source` (`db` или `api`), `webHref` (если API вернул `meta.uuidHref`), `blocks` — массив секций с табличными строками `label` / `value` для отображения в UI. В блоке карточки показываются все `salePrices` из МойСклад; типы цен с нулевым значением отображаются как `0.00 ₽`.

### GET `/api/ms/stats`

Агрегированная статистика по выгрузке МойСклад (с кэшем на сервере; параметры — в `routes/moysklad.js`). Набор фильтров совпадает с `GET /api/ms/export`, включая **`g_*`** (сеточные поля экрана).

Поля **`inventory_value_products`** и **`inventory_value_bundles`**: суммы **`остаток × закупочная цена`** отдельно по строкам **`Товар`** и **`Комплект`** (те же фильтры, что у выборки; без «плакат» в наименовании); пустая закупка даёт 0 для строки. В UI — две карточки «Сумма по товарам» / «Сумма по комплектам»; общей склеенной суммы нет.

### POST `/api/ms/stop`

Остановить фоновую задачу синхронизации с API МойСклад.

### POST `/api/ms/rebuild-links-cache`

Пересборка серверного кэша связей кодов с `ms_export` (используется из UI «Мои товары»).

### POST `/api/ms/recalc-bundle-stocks`

Быстрый пересчёт остатков только для строк `type='Комплект'` в `ms_export` на основе уже сохранённых карточек из `ms_entity_details` и текущих остатков компонентов в `ms_export`. Нужен, когда у части комплектов остаток ушёл в `0`/пусто и не хочется ждать полный `POST /api/ms/sync`.

Маршрут запускает задачу **в фоне** и сразу возвращает `success`, `started`, `message`. Если пересчёт уже выполняется — `409 ALREADY_RUNNING`.

### GET `/api/ms/recalc-bundle-stocks-status`

Статус фонового пересчёта остатков комплектов.

Ответ: `success`, `active`, `started_at`, `finished_at`, `total_bundles`, `processed`, `updated`, `skipped_no_components` (в кэше нет строк состава), `skipped_unresolved` (не удалось получить коды позиций / остатки), `export_no_row` (расчёт был, но `UPDATE ms_export` не нашёл строку с этим кодом и типом «Комплект»), `errors`, `message`.

## Exports / marketplaces

Префикс: `/api/exports/marketplaces`. Доступ к API проверяется по странице **`exports-marketplaces`** (матрица `page_modes`: скрытие родителя без `view`/`full` у дочернего листа закрывает и HTML shop-экранов — `isHtmlLeafAccessHidden`). Настройки ключей/лимитов — в **`/settings.html`** (и форма на `/exports-marketplaces.html` по прямому URL; пункт меню скрыт). Отдельные экраны таблиц — **`/exports-marketplaces-ozon.html`**, **`/exports-marketplaces-wildberries.html`**, **`/exports-marketplaces-yandex.html`**: автозагрузка последнего снапшота (`GET …/snapshot?shop=…`) и кнопка принудительного обновления (`GET …/ozon|wildberries|yandex-market` / sync). UI-toolbox таблицы маркетплейсов: кнопки «Столбцы» (чекбоксы видимости) и «Ширины» (input px на колонку); состояние сохраняется в `localStorage` (`dg.mp.cols.<shop>`, `dg.mp.colwidths.<shop>`, `dg.mp.page.size.<shop>`). Заголовок таблицы — sticky-th под верхним меню (с CSS-переменной `--dg-table-sticky-top`). Сами запросы выполняются **на сервере** (долгие циклы допустимы; таймауты прокси/nginx настройте под свой каталог). Для новых страниц этой группы целевая структура — по эталону `/moysklad.html` (карточки «Фильтры и действия» + «Выгрузка &lt;X&gt;», кнопки «Столбцы»/«Ширины»/«Свернуть» в card-header справа, поиск-зеркало в шапке таблицы; см. `.cursor/rules/datagon-list-page-baseline-moysklad.mdc`).

**Учётные данные** (в порядке приоритета):

1. Переменные окружения: `OZON_CLIENT_ID`, `OZON_API_KEY`, `WB_API_KEY`, `WB_TOKEN_TYPE` (`personal`|`service`|`base`|`test`, по умолчанию `base`), `YM_API_KEY`, `YM_CAMPAIGN_ID`, `YM_BUSINESS_ID` (последний опционально — для ссылки «Покупателю» на Я.Маркете).
2. Либо ключи в таблице `app_settings`: `ozon_client_id`, `ozon_api_key`, `wb_api_key`, `wb_token_type`, `ym_api_key`, `ym_campaign_id`, `ym_business_id` — через `POST /api/exports/marketplaces/config` (только **admin** или пользователь с **полным** доступом к разделу «Настройки»).

### GET `/api/exports/marketplaces/status`

Возвращает JSON `{ configured: { ozon, wildberries, yandex_market }, rate_limits_ms_min, hints }` — какие интеграции считаются настроенными (без раскрытия значений ключей) и **минимальные паузы между запросами** к каждому маркетплейсу (мс). Параметры `delay_*` в выгрузках не опускаются ниже этих значений.

**Поведение при лимитах:** HTTP-клиент к маркетплейсам повторяет запрос при **429 / 500 / 502 / 503 / 504** с экспоненциальным backoff и с учётом заголовков `Retry-After`, а для WB ещё и **`X-Ratelimit-Retry`** / **`X-Ratelimit-Reset`** (см. документацию WB OpenAPI: «Rate Limits»). На 429 пауза не меньше 5 сек и не больше 60 сек на одну попытку.

Сверка с официальными лимитами WB (Personal/Service tokens):

- **Content** (`POST content-api/.../v2/get/cards/list`) — 100 запросов/мин, интервал 600 мс, burst 5.
- **Prices & Discounts** (`GET discounts-prices-api/.../v2/list/goods/filter`) — 10 запросов/6 сек (~100 RPM), burst ~10.
- **Marketplace** (`GET .../v3/warehouses`, `POST .../v3/stocks/{warehouseId}`) — 300 запросов/мин, интервал 200 мс, burst 20.

Категории не делят одно окно: 429 на prices/stocks обычно означает либо параллельных клиентов на том же токене, либо временный сбой WB. Для prices/stocks применяется ограниченный «бюджет ожидания» (≈ 120 сек на запрос) — при его исчерпании фаза помечается как `step:prices:failed` / `step:stocks:skipped`, а `cards` (а где удалось — и stocks) всё равно сохраняются. Пользователь получает свежий каталог даже при недоступности одного из эндпоинтов.

### POST `/api/exports/marketplaces/config`

Legacy-совместимость для старого экрана настроек маркетплейсов. Новая UI-практика — сохранять эти поля через `POST /api/settings`.

### GET `/api/exports/marketplaces/ozon`

Query:

- `format` — `json` (по умолчанию) или `csv` (файл UTF-8 с BOM, разделитель `;`).
- `max_items` — ограничение строк каталога (1…25000, по умолчанию **25000** — тянем весь каталог продавца; передайте меньшее значение, чтобы ограничить).
- `include_archived` — `1` для `visibility: ALL` в списке Ozon (как в скрипте с `OZON_INCLUDE_ARCHIVED`).
- `delay_ms` — пауза между запросами к Ozon (мс, по умолчанию 400; не ниже минимума из `rate_limits_ms_min.ozon`).

Параметр `max_items` оставлен для интеграций и ручных `curl`, но UI-экраны маркетплейсов его больше не задают.

Ответ JSON: `{ marketplace, updatedAt, count, persisted_count, headers, headerLabels, rows }` — `headers` — ключи полей в объектах `rows`, `headerLabels` — подписи столбцов для UI, `persisted_count` — сколько строк сохранено/обновлено в БД для последующей обработки. Порядок колонок: **артикул → наименование → `manager` → `content_manager` → остальные поля**. `manager` / `content_manager` — это **актуальные** значения из `ms_export.manager` / `ms_export.content_manager`, найденные по ключу `ms_export.code = offer_id` (LEFT JOIN, при отсутствии связи поля пустые). CSV UTF-8 с BOM: первая строка — `headerLabels` для Ozon: «Артикул (offer_id) Ozon», «Наименование Ozon», «Менеджер», «Контент-менеджер», «Цена Ozon», «НДС Ozon», «Статус Ozon», «Причина блокировки Ozon», «Остаток Ozon», «Длина (см) Ozon», «Ширина (см) Ozon», «Высота (см) Ozon», «Вес (кг) Ozon», «Кабинет Ozon», «Покупателю Ozon», «Обновлено Ozon».

Поведение поля **`vat` (Ozon)**: API возвращает долю (`'0'`/`'0.05'`/`'0.07'`/`'0.10'`/`'0.20'`). Сервер форматирует так: `0` → «Без НДС», `0.05` → «5», `0.07` → «7», `0.10` → «10», `0.20` → «20». Старые целочисленные значения (`5/7/10/20`) поддержаны для обратной совместимости со снапшотами.

### GET `/api/exports/marketplaces/wildberries`

Query: `format`, `max_items`, `delay_cards`, `delay_other` (мс; по умолчанию 600 и 1600, не ниже `rate_limits_ms_min.wbCards` / `wbPricesStocks`). Логика: карточки `content/v2/get/cards/list`, цены `discounts-prices-api/.../v2/list/goods/filter`, остатки `marketplace-api/.../v3/warehouses` + `v3/stocks/{warehouseId}` по складам (при ошибке остатков таблица всё равно возвращается с нулевыми остатками; аналогично — при `step:prices:failed` сохраняются карточки и остатки без цен).

#### Разные категории API WB и поле `wb_token_type`

Источник: `process.env.WB_TOKEN_TYPE` → `app_settings.wb_token_type` → `'base'` (по умолчанию). Значения: `personal` | `service` | `base` | `test`. Поле **не отключает** загрузку цен в коде — оно для справки и подстройки пауз. В `GET /api/exports/marketplaces/status`: `wb_token_type`, `wb_prices_disabled_by_token` (всегда `false`; поле оставлено для совместимости клиентов).

Таблица из общего раздела WB про лимиты категории **«Маркетплейс»** (пример для Базового токена: **150 запросов за 1 минуту**, интервал **200 мс**, всплеск **10**) относится к **`marketplace-api`** (склады, остатки: `v3/warehouses`, `v3/stocks/{warehouseId}`). **Не к ценам.**

Цены запрашиваются через **`discounts-prices-api`** — категория **«Цены и скидки»**, отдельное окно лимитов. В описании метода `GET …/api/v2/list/goods/filter` в OpenAPI указано ограничение для методов этой категории (часто: **10 запросов за 6 секунд**, интервал **600 мс**, burst **5**). У конкретных методов категории «Цены и скидки» в документе могут быть дополнительные строки таблицы по типу токена — сверяйтесь с актуальной страницей метода на [dev.wildberries.ru](https://dev.wildberries.ru/ru/openapi/work-with-products).

Категория «Контент» (`POST …/content/v2/get/cards/list`): см. лимиты категории Content в документации (часто 100 запросов/мин, интервал 600 мс для ряда методов).

Паузы в экспорте: `delay_cards`, `delay_other` (минимумы — `rate_limits_ms_min`). При **429** на ценах или остатках увеличьте `mp_wb_delay_other_ms` и проверьте, что тот же токен параллельно не используется другим клиентом.

Ответ JSON: как у Ozon — `headers`, `headerLabels`, `rows`, `persisted_count`. Порядок колонок: **артикул → наименование → `manager` → `content_manager` → остальные** (`manager`/`content_manager` подтянуты по ключу `ms_export.code = vendor_code`). Заголовки CSV/UI для WB: «Артикул продавца WB», «Наименование WB», «Менеджер», «Контент-менеджер», «Цена WB», «НДС WB», «Остаток WB», «Длина (см) WB», «Ширина (см) WB», «Высота (см) WB», «Вес (кг) WB», «Кабинет WB», «Покупателю WB», «Обновлено WB».

### GET `/api/exports/marketplaces/yandex-market`

Query: `format`, `max_items`, `delay_ms` (по умолчанию 280 мс, не ниже `rate_limits_ms_min.yandex`). Листинг SKU через `GET …/offer-prices`, цены `POST …/offer-prices`, карточные данные `POST …/stats/skus`.

Ответ JSON: как у Ozon — `headers`, `headerLabels`, `rows`, `persisted_count`. Порядок колонок: **артикул → наименование → `manager` → `content_manager` → остальные** (`manager`/`content_manager` подтянуты по ключу `ms_export.code = shop_sku`). Заголовки CSV/UI для Я.Маркета: «Артикул Я.Маркет», «Наименование Я.Маркет», «Менеджер», «Контент-менеджер», «Цена Я.Маркет», «НДС Я.Маркет», «Остаток Я.Маркет», «Длина (см) Я.Маркет», «Ширина (см) Я.Маркет», «Высота (см) Я.Маркет», «Вес (кг) Я.Маркет», «Кабинет Я.Маркет», «Покупателю Я.Маркет», «Обновлено Я.Маркет».

Поведение поля **`vat` (Я.Маркет)**: ставки НДС — простыми числами без суффикса «%»/«(УСН)»: `2`→«10», `5`→«0», `6`→«без НДС», `7`→«20», `10`→«5», `11`→«7», `14`→«22». Это согласовано с тем, что для Ozon `0` → «Без НДС», `0.05` → «5».

### GET `/api/exports/marketplaces/snapshot`

Чтение последнего сохранённого снапшота из `marketplace_export_rows` (без live-запросов к внешнему API).

Query:

- `shop` — обязательный: `ozon` | `wildberries` (`wb`) | `yandex` (`yandex-market`, `ym`).
- `max_items` — ограничение выдачи (1…25000). По умолчанию **25000** (раньше было 300, из-за чего на больших каталогах WB страница выглядела «пустой» при наличии данных в БД).

Ответ JSON: `{ marketplace, source: "snapshot", updatedAt, count, headers, headerLabels, rows, note }`.

- `rows` строятся из `row_json` (с fallback на нормализованные колонки таблицы), VAT нормализуется (см. Ozon/Я.Маркет выше).
- Поля `manager` / `content_manager` подмешиваются к каждой строке из `ms_export` по ключу `code = artикул маркетплейса` — это позволяет сопоставлять товары между МойСклад и Ozon/WB/Я.Маркет.
- Если сохранённых строк нет, возвращается `count=0`, пустой `rows` и `note` с подсказкой («Сохранённого снапшота нет…», или «… ключи маркетплейса не заданы»).
- Этот маршрут используется UI-экранами маркетплейсов для автоподгрузки данных при открытии страницы и для кнопки «Показать последнее сохранённое».

### POST `/api/exports/marketplaces/sync`

Принудительный запуск обновления с live API маркетплейсов и сохранением в `marketplace_export_rows`.

Body (JSON):

- `shop` — `all` (по умолчанию), `ozon`, `wildberries` (`wb`), `yandex-market` (`ym`).

Ответ: `{ success: true, started: true }`. Если задача уже выполняется — `409`.

### GET `/api/exports/marketplaces/sync-status`

Текущий статус фонового обновления маркетплейсов: `active`, `message`, `resultStatus` (`completed` | `failed` | `partial`), `perMarket` по Ozon / WB / Я.Маркет (`status`, `count`, `error`, `updatedAt`).

После прогона `message` — **честный** итог по запрошенным площадкам (`Завершено: Ozon: ✓ N` или `Ошибка: Я.Маркет: × …`). То же в `auto_sync_runs.message` для `marketplaces_ozon` / `marketplaces_wb` / `marketplaces_ym` (и legacy `marketplaces`). `completed` только если все запрошенные площадки этого прогона успешно сохранились. Файловые логи шагов: `logs/marketplace-{ozon|wb|ym}-sync.log`.

Технически строки сохраняются в таблицу `marketplace_export_rows` (создаётся автоматически): уникальность по паре `(marketplace, external_id)`, полные данные каждой строки — в `row_json`, плюс нормализованные колонки (`price`, `vat`, `stock`, габариты, ссылки и т.д.) для SQL-обработки.

### GET `/api/exports/marketplaces/issues`

Проблемы с товарами (бывш. «Неопубликованные»). Возвращает строки **`ms_export`** по основному фильтру `stock_position = 'Да' AND no_longer_cooperation = 'Нет'` с сопоставлением артикулов на 3 маркетплейсах через **`marketplace_export_rows.external_id`** (= `offer_id` для Ozon, `vendor_code` для WB, `shop_sku` для YM, см. `lib/marketplaceExportStore.js#externalIdFor`). По каждой строке возвращается полный паспорт МС (`ms_stock`, `ms_vat` из `ms_export`, габариты МС из **денорма** `ms_entity_details.denorm_dim_*` — см. ниже) и каждого маркетплейса: `*_code`, `*_name`, `*_vat` (нормализован `prettifyMarketplaceVat`), `*_stock`, `*_length` / `*_width` / `*_height` (см), `*_weight` (кг), `*_cabinet_url`, `*_buyer_url`, `*_updated` (метка свежести снапшота — `updated_label` или форматированный `updated_at`). Поля **`uuid`**, **`supplier`**, **`supplier2`** и флаг **`supplier_missing`** приходят в каждом объекте `rows[]`; в **`headers`** выводятся колонки **`type`** («Тип МС») и **`supplier_label`** («Поставщик / Поставщик 2» — склейка `supplier` и `supplier2` через ` / `, без дубля если значения совпадают; пустая строка, если оба пусты). UI `/exports-marketplaces-issues.html` фильтрует по `type` на клиенте и подсвечивает пустой `supplier_label` красным (`dg-mpu-missing`). Порядок колонок МС в `headers`/`headerLabels`: `code`, `name`, `type`, `supplier_label`, `manager`, `content_manager`, `ms_vat`, `ms_stock`, `ms_length`, `ms_width`, `ms_height_box`, `ms_height_bag`, `ms_weight`, `synced_at`.

**Габариты МС** (`ms_length`, `ms_width`, `ms_height_box`, `ms_height_bag`, `ms_weight`) берутся из колонок денорма `ms_entity_details.denorm_dim_*` (те же атрибуты карточки МС, что при выгрузке «↗ В МС» с `/exports-dimensions.html`: `!!Длина…`, `!!Ширина…`, `!!Высота…КОРОБКА`, `!!Высота…Пакет!`, `!!Вес (кг)`). Это **не** таблица замеров `ms_dimensions_measurements`. Высоты у МС две (коробка / пакет); на маркетплейсах высота одна. Если `denorm_dims_at` ещё пуст — одноразовый fallback читает `payload_json.attributes` только для таких uuid (не для всего каталога). Длина/ширина/высота форматируются до **1** знака (`toFixed(1)`), **вес** — до **3** (`toFixed(3)`), чтобы не получать ложные «2.6 vs 2.65» при сверке с Ozon/WB/Я.М.

Query:

- `scope` — фильтр выборки:
  - `all` (по умолчанию) — все товары МС по основному фильтру;
  - `any` — у кого хотя бы один из 3 маркетплейсов не нашёл товар;
  - `all3` — нет ни на одном из 3 маркетплейсов;
  - `ozon` / `wb` / `ym` — нет на конкретном маркетплейсе;
  - `vat_mismatch` (алиас `vat-mismatch`) — товар есть в снапшоте маркетплейса, но нормализованный НДС МС не совпадает с НДС на этой площадке (Wildberries со значением «не указан» в сравнении не участвует);
  - `dims_mismatch` (алиас `dims-mismatch`) — расхождение габаритов (длина/ширина/высота/вес) с допуском 0,02. Если у строки в атрибутах карточки МС есть **хотя бы одно** числовое значение (`ms_length`…`ms_weight`), сверка идёт **МС ↔ маркетплейсы**: длина/ширина/вес — одно МС-значение против каждой площадки; высота МС двойная — высота маркетплейса считается совпавшей, если совпала **хотя бы с одной** из непустых высот МС (коробка ИЛИ пакет). Для **Wildberries** длина/ширина/высота сравниваются как **целые см** (`Math.round`), т.к. Content API не хранит дроби (МС `2.5` ↔ WB `3` — совпадение). Вес — с обычным EPS. Если у МС нет ни одного числа, fallback — «между маркетплейсами»: товар есть минимум на двух площадках, по любой оси обе отдают число и оно расходится. Пара «число vs пусто» расхождением не считается. Отбор **в памяти** после подмешивания габаритов МС (через денорм), `prettifyMarketplaceVat` и фильтра комплектов, в пределах первых `max_items` строк по `ORDER BY m.code` — при очень большом каталоге возможны «хвосты» за пределом лимита.
  - `no_supplier` (алиасы `no-supplier`, `supplier_missing`) — в `ms_export` оба поля `supplier` и `supplier2` пустые после `TRIM`; в ответе `supplier_label` пустой, `supplier_missing: 1`. Отбор в SQL.
- В `headers` после `ozon_vat` есть служебная колонка **`ozon_fix_vat`** («Исправить НДС Ozon») — только UI-кнопка, в `rows[]` значения нет.
- После `wb_vat` — служебная **`wb_fix_vat`** («Исправить НДС WB»), аналогично.
- После `ym_vat` — служебная **`ym_fix_vat`** («Исправить НДС Я.М»), аналогично.
- В `headers` после `ozon_height` есть служебная колонка **`ozon_fix_dims`** («Исправить на Ozon») — только UI-кнопка, в `rows[]` значения нет.
- После `wb_height` — служебная **`wb_fix_dims`** («Исправить на WB»), аналогично.
- После `ym_height` — служебная **`ym_fix_dims`** («Исправить на Я.М»), аналогично.
- `max_items` — лимит выборки, 1..100000, по умолчанию 50000.
- `exclude_bundle_components` — `1` (по умолчанию) исключает товары, чей `code` встречается как компонент хотя бы одного комплекта (`ms_entity_details.kind = 'bundle'`, поле `payload_json.components.rows[].assortment.code`). Любое явно «ложное» значение (`0` / `false` / `no` / `off`) выключает фильтр. Полный набор кодов-компонентов кэшируется в памяти процесса на 5 минут (см. `getBundleComponentCodesCached` в `routes/exportsMarketplaces.js`); первый запрос после рестарта Node читает payload всех bundle-сущностей, последующие — берут готовый Set.

Ответ JSON:

```json
{
  "scope": "all",
  "scope_label": "все товары",
  "count": 123,
  "headers": ["code","name","type","supplier_label","manager","content_manager","ms_vat","ms_stock","ms_length","ms_width","ms_height_box","ms_height_bag","ms_weight","synced_at","ozon_code","ozon_name","ozon_vat","ozon_fix_vat","ozon_stock","ozon_length","ozon_width","ozon_height","ozon_weight","ozon_fix_dims","ozon_cabinet_url","ozon_buyer_url","ozon_updated","wb_code","wb_name","wb_vat","wb_fix_vat","wb_stock","wb_length","wb_width","wb_height","wb_weight","wb_fix_dims","wb_cabinet_url","wb_buyer_url","wb_updated","ym_code","ym_name","ym_vat","ym_fix_vat","ym_stock","ym_length","ym_width","ym_height","ym_weight","ym_fix_dims","ym_cabinet_url","ym_buyer_url","ym_updated"],
  "headerLabels": ["Код МС","Название МС","Тип МС","Поставщик / Поставщик 2","Менеджер","Контент-менеджер","НДС МС","Остаток по МС","Длина (см) МС","Ширина (см) МС","Высота — коробка (см) МС","Высота — пакет (см) МС","Вес (кг) МС","Синхронизация МС","Код Ozon","Название Ozon","НДС Ozon","Исправить НДС Ozon","Остаток Ozon","Длина (см) Ozon","Ширина (см) Ozon","Высота (см) Ozon","Вес (кг) Ozon","Исправить на Ozon","Кабинет Ozon","Покупателю Ozon","Обновлено Ozon","Код Wildberries","Название Wildberries","НДС WB","Исправить НДС WB","Остаток WB","Длина (см) WB","Ширина (см) WB","Высота (см) WB","Вес (кг) WB","Исправить на WB","Кабинет WB","Покупателю WB","Обновлено WB","Код Я.Маркет","Название Я.Маркет","НДС Я.Маркет","Исправить НДС Я.М","Остаток Я.Маркет","Длина (см) Я.Маркет","Ширина (см) Я.Маркет","Высота (см) Я.Маркет","Вес (кг) Я.Маркет","Исправить на Я.М","Кабинет Я.Маркет","Покупателю Я.Маркет","Обновлено Я.Маркет"],
  "rows": [
    { "code": "ABC-1", "name": "...", "uuid": "…", "type": "Товар", "supplier": "Вектор", "supplier2": "Вектор", "supplier_label": "Вектор", "supplier_missing": 0, "manager": null, "content_manager": null, "ms_vat": "20%", "ms_stock": 12, "ms_length": "30.0", "ms_width": "20.0", "ms_height_box": "10.0", "ms_height_bag": null, "ms_weight": "0.5", "synced_at": "01.01.2026 12:00", "ozon_code": "ABC-1", "ozon_name": "...", "ozon_vat": "20", "ozon_stock": "12", "ozon_length": "30", "ozon_width": "20", "ozon_height": "10", "ozon_weight": "0.5", "ozon_cabinet_url": "https://seller.ozon.ru/...", "ozon_buyer_url": "https://www.ozon.ru/...", "ozon_updated": "01.01.2026 12:30", "wb_code": null, "wb_name": null, "wb_vat": null, "wb_stock": null, "wb_length": null, "wb_width": null, "wb_height": null, "wb_weight": null, "wb_cabinet_url": null, "wb_buyer_url": null, "wb_updated": null, "ym_code": "ABC-1", "ym_name": "...", "ym_vat": "20", "ym_stock": "8", "ym_length": "30", "ym_width": "20", "ym_height": "10", "ym_weight": "0.5", "ym_cabinet_url": "https://partner.market.yandex.ru/...", "ym_buyer_url": "https://market.yandex.ru/...", "ym_updated": "01.01.2026 12:35" }
  ],
  "exclude_bundle_components": true,
  "bundle_component_codes_known": 482,
  "removed_by_bundle_filter": 17
}
```

### POST `/api/exports/marketplaces/issues/fix-ozon-dims`
Отправить габариты из МС в карточки Ozon (`/v3/product/import`: карточка читается из attributes + info, меняются `depth`/`width`/`height`/`weight`).

Body JSON:
- `code` **или** `codes[]` — артикулы МС (= `offer_id` Ozon), максимум 200 за один HTTP-запрос;
- `confirm: true` — обязателен для записи (или `dry_run: 1` для проверки без записи).

UI `/exports-marketplaces-issues.html` при массовой кнопке режет выборку на пакеты по 200 и шлёт их **по очереди** с паузой ~1,5 с (лимит API на запрос сохраняется).

Ответ: `{ success, dry_run, total, would_update, updated, skipped, failed, errors[{code,error}], results[], duration_sec }`. После успеха локальный снапшот `marketplace_export_rows` обновляет `length_cm`/`width_cm`/`height_cm`/`weight_kg`.

Высота для Ozon: `ms_height_box`, либо `ms_height_bag` если тип упаковки похож на «пакет».

### POST `/api/exports/marketplaces/issues/fix-wb-dims`
Отправить габариты из МС в карточки Wildberries (`/content/v2/get/cards/list` → `/content/v2/cards/update`: меняются `dimensions.length/width/height` в см и `weightBrutto` в кг). Карточка перезаписывается целиком — сервер сначала читает текущую карточку по `vendorCode` (= код МС).

**Целые см:** в API WB длина/ширина/высота — только целые сантиметры; сервер шлёт `Math.round` (`cmToWbInt`, минимум 1). МС `2.5` на WB станет `3` — это не ошибка записи. В фильтре/подсветке `dims_mismatch` пара МС↔WB по L/W/H тоже сравнивается через `Math.round`.

**Права токена:** для `cards/update` нужен API-токен с категорией **«Контент»** и правом **изменения** карточек. Токен только на чтение (или без Content write) даёт **403** при записи, хотя выгрузка `/cards/list` может работать. Права к существующему токену WB не добавляются — нужен **новый** токен → `wb_api_key` в настройках → перезапуск Node.

Body JSON:
- `code` **или** `codes[]` — артикулы МС (= `vendorCode` WB), максимум **100** за один HTTP-запрос (лимит WB Content update ~10 req/мин);
- `confirm: true` — обязателен для записи (или `dry_run: 1`).

UI `/exports-marketplaces-issues.html`: кнопка **«Исправить габариты на WB»**, колонка **`wb_fix_dims`** после высоты WB; пакеты по 100 с паузой ~2 с. Вкладку нужно держать открытой до итога.

Ответ: как у `fix-ozon-dims` — `{ success, dry_run, total, would_update, updated, skipped, failed, errors[], results[], duration_sec }`. После успеха локальный снапшот `marketplace_export_rows` (marketplace=`wildberries`) обновляет габариты.

Высота: та же логика, что для Ozon (коробка / пакет).

### POST `/api/exports/marketplaces/issues/fix-ym-dims`
Отправить габариты из МС в офферы Яндекс Маркета (`POST /v2/businesses/{businessId}/offer-mappings/update` с `weightDimensions`: длина/ширина/высота в см, вес в кг). Нужны `ym_api_key` и **`ym_business_id`**.

**Права токена:** для `offer-mappings/update` у Api-Key нужны доступы **`offers-and-cards-management`** («Управление товарами и карточками») или **`all-methods`**. Read-only / только цены / статистика дают **403** при записи, хотя выгрузка кампании может работать. Новый ключ → `ym_api_key` (+ проверить `ym_business_id`) → перезапуск Node.

Body JSON:
- `code` **или** `codes[]` — артикулы МС (= `shopSku` / `offerId`), максимум **100** за запрос;
- `confirm: true` — обязателен для записи (или `dry_run: 1`).

UI: кнопка **«Исправить габариты на Я.М»**, колонка **`ym_fix_dims`**. Пакеты по 100. Если YM вернул `status=ERROR` на пакете (ошибка хотя бы по одному SKU откатывает весь пакет), сервер повторяет проблемный чанк **по одному**.

Ответ — как у `fix-ozon-dims` / `fix-wb-dims`. Локальный снапшот: `marketplace = yandex_market`.

### POST `/api/exports/marketplaces/issues/fix-ozon-vat`
Отправить НДС из МС в карточки Ozon (`/v3/product/import`: карточка читается из attributes + info, **габариты/вес текущей карточки Ozon сохраняются**, меняется только `vat`). Конвертация: `lib/mpVatConvert.js` (`msVatToOzonApi`: «без НДС»/0 → `'0'`, 5→`'0.05'`, 7→`'0.07'`, 10→`'0.10'`, 20/22→`'0.20'`).

Body JSON:
- `code` **или** `codes[]` — артикулы МС (= `offer_id` Ozon), максимум **200** за запрос;
- `confirm: true` — обязателен для записи (или `dry_run: 1`).

UI `/exports-marketplaces-issues.html`: кнопка **«Исправить НДС на Ozon»**, колонка **`ozon_fix_vat`** сразу после `ozon_vat`; пакеты по 200. Журнал — отдельный канал `#dg-mpu-action-log-ozon_vat` (не перетирает лог габаритов Ozon).

Ответ: `{ success, dry_run, total, would_update, updated, skipped, failed, errors[], results[], duration_sec }`. После успеха локальный снапшот `marketplace_export_rows` (marketplace=`ozon`) обновляет `vat` (`updated_label = 'Ozon НДС ← МС'`).

**Нужен перезапуск Node**, чтобы подхватить новые роуты и `lib/*VatUpdate.js`.

### POST `/api/exports/marketplaces/issues/fix-wb-vat`
Отправить НДС из МС в карточки Wildberries (`/content/v2/get/cards/list` → `/content/v2/cards/update`: характеристика id **15001405** «Ставка НДС»; **dimensions карточки сохраняются**). Конвертация: `msVatToWbCharValue` по справочнику `GET /content/v2/directory/vat` (без НДС → **`'Без НДС'`**, не код `'6'`; ставки → `'5'|'7'|'10'|'20'|'22'|…`). Код `'6'` WB принимает в update без ошибки, но **не применяет** ставку — из‑за этого UI мог показать «Без НДС» после локального патча, а на карточке оставалось `'5'`. После успеха локально пишутся и колонка `vat`, и `row_json.vat`. Синхронизация на стороне WB может занимать до ~30 минут; ответ `error:false` сам по себе не гарантирует мгновенное изменение в `cards/list`.

Body JSON:
- `code` **или** `codes[]` — максимум **100** за запрос;
- `confirm: true` (или `dry_run: 1`).

UI: кнопка **«Исправить НДС на WB»**, колонка **`wb_fix_vat`**; пакеты по 100; лог `#dg-mpu-action-log-wb_vat`. Права токена — как у `fix-wb-dims` (Content write).

Ответ — как у `fix-ozon-vat`. Локальный снапшот: marketplace=`wildberries`, `updated_label = 'WB НДС ← МС'`.

### POST `/api/exports/marketplaces/issues/fix-ym-vat`
Отправить НДС из МС в офферы Яндекс Маркета (`POST /v2/campaigns/{campaignId}/offers/update` с `{ offers: [{ offerId, vat }] }`). Нужны **`ym_api_key`** и **`ym_campaign_id`** (не только `ym_business_id`). Конвертация: `msVatToYmVatId` (без НДС→6, 0%→5, 5→10, 7→11, 10→2, 20→7, 22→14 — обратно к `ymVatText`).

Body JSON:
- `code` **или** `codes[]` — максимум **100** за запрос;
- `confirm: true` (или `dry_run: 1`).

UI: кнопка **«Исправить НДС на Я.М»**, колонка **`ym_fix_vat`**; пакеты по 100; лог `#dg-mpu-action-log-ym_vat`. При `status=ERROR` на пакете — повтор по одному (как у dims).

Ответ — как у `fix-ozon-vat` / `fix-wb-vat`. Локальный снапшот: marketplace=`yandex_market`, `updated_label = 'YM НДС ← МС'`.

Поле `bundle_component_codes_known` — размер набора кодов-компонентов, отбираемых из `ms_entity_details`. `removed_by_bundle_filter` — сколько строк было отрезано серверным фильтром «исключить товары из комплектов» (полезно для отладки). Когда `exclude_bundle_components=0`, `bundle_component_codes_known` равно `0` и `removed_by_bundle_filter` равно `0`.

Экран: `/exports-marketplaces-issues.html` (пункт меню **Маркетплейсы → Проблемы с товарами**, после «Яндекс Маркет»). UI: радио-фильтр (Все товары / Есть проблемы / Нет ни на одном / Нет на Ozon / Нет на Wildberries / Нет на Я.Маркет / Не совпадает НДС / Разные габариты), клиентский переключатель **«Показывать товары с остатком»** (`stock_positive`, `localStorage` `dg.mpu.flt.stockPositive.v1`, **по умолчанию выкл** — при включении после «Применить» остаются строки с `ms_stock > 0`), умный поиск по артикулу/наименованию МС/маркетплейсов, НДС, остаткам и ФИО менеджеров, сортировка по любой колонке кликом по заголовку (по умолчанию по «Код МС» asc), клиентская пагинация 50/100/200/500. По умолчанию включены **все** колонки (полный паспорт МС + 3 маркетплейсов); кнопка `«Столбцы по умолчанию»` в панели `🧩 Столбцы` возвращает именно это состояние «все включены» (ключ видимости в `localStorage` — `dg.mpu.colvisible.v5`, dg.mpu.colwidths.v2 для пиксельных ширин). Таблица **широкая** (`width: max-content`): горизонтальный скролл **внутри карточки** (`#dg-mpu-table-scroll-outer`, как `/my-products.html`), плавающая шапка под `app-header` — **JS на `thead#dg-mpu-thead`** (`translate3d`), не схема shop-страниц Ozon/WB/Я.М. Ширины в DOM задаются через `<colgroup>`; не задавать суммарно раздувающий `min-width` на каждую `td` в px. Контракт: `.cursor/rules/datagon-table-behavior-lock.mdc` (раздел «Проблемы с товарами»). Лишние колонки можно выключить в `🧩 Столбцы` — выбор сохранится в браузере. В режиме **«Все товары»** красная подсветка отсутствия товара на площадке — только у ячеек `*_code`; НДС (МС ↔ маркетплейс) и расхождение габаритов между площадками подсвечиваются на фильтрах **«Не совпадает НДС»** / **«Разные габариты»**, не в «все товары». На остальных фильтрах по отсутствию товара подсвечивается пара `(*_code, *_name)`. Колонки-ссылки `*_cabinet_url` / `*_buyer_url` рендерятся как «Открыть» (новая вкладка). Полное наименование товара МС, тип, статусы и переход в МойСклад / маркетплейсы доступны по клику на «Название МС» — открывается та же карточка, что на `/moysklad.html` (`GET /api/ms/detail/:uuid`). Фильтр маркетплейса, поиск и селекты «Менеджер» / «Контент-менеджер» собраны в один тулбокс над таблицей и срабатывают **только** по кнопке «Применить» (или Enter в поле поиска); пока изменения не применены, рядом с кнопкой видно «не применено». Это общий контракт для всех таблиц Datagon, см. правило `.cursor/rules/datagon-table-filter-apply.mdc`.

Старый URL `/exports-marketplaces-unpublished.html` отвечает 301-редиректом на новый. Старый key специальностей `exports-marketplaces-unpublished` мигрируется в `exports-marketplaces-issues` при старте Node (см. `lib/datagonSpecialties.js#PAGE_KEY_RENAMES`).

### GET `/api/exports/marketplaces/issues/snapshot-log`

Журнал **автоснимков** проблемных товаров (тот же смысл, что фильтр **`scope=any`** + **`exclude_bundle_components=1`** на `GET /issues`): после **каждого успешного** завершения обновления маркетплейсов (`POST /api/exports/marketplaces/sync`, очередь автосинка `marketplaces` в `server.js`) сервер считает строки тем же пайплайном, что `/issues`, и добавляет запись в таблицу **`mp_issues_daily_snapshot`** (создаётся при первом снимке).

Query:

- `days` — глубина по `recorded_at` (UTC на сервере), 1…730, по умолчанию 90.
- `limit` — максимум строк ответа, 1…500, по умолчанию 200.

Ответ: `{ success: true, days, limit, count, rows[] }`. Элемент `rows[]`: **`stat_date`** — строка **`DD.MM.YYYY`** (день учёта по Москве, без сдвига UTC); **`recorded_at`** — строка **даты и времени по `Europe/Moscow`** с суффиксом `МСК` (не ISO UTC); `trigger_type` (`schedule` | `manual` | `manual_ui` | …); `schedule_slot_time` (для расписания — `HH:mm` из **`auto_sync_marketplaces_time`**); `scope` (всегда `any`); `exclude_bundle_components`; `total_count`; объекты **`by_manager`** и **`by_content_manager`**; `removed_by_bundle_filter`. Старые записи старше ~900 суток удаляются при каждом новом снимке (прунинг в `routes/exportsMarketplaces.js`).

### POST `/api/exports/marketplaces/issues/snapshot-run`

Добавить строку в журнал снимков **без** вызова API маркетплейсов: тот же расчёт, что `GET /issues` при `scope=any` и `exclude_bundle_components=1`, результат пишется в **`mp_issues_daily_snapshot`**.

Body (JSON, опционально): `trigger_type` (по умолчанию `manual_ui`), `schedule_slot_time` (обычно пусто).

Ответ: `{ success: true, trigger_type }`. Ошибка БД — `500` с `code: ISSUES_SNAPSHOT_RUN_FAILED`.

## Exports / Competitors (Конкуренты)

Префикс: `/api/exports/competitors`. Экран: `/exports-marketplaces-competitors.html` (подменю **Маркетплейсы → Конкуренты**; не путать с Парсинг → Конкуренты / `projects`).

Доступ: матрица `page_modes` для ключа **`exports-marketplaces-competitors`** (наследует скрытие родителя `exports-marketplaces`, если у дочерней нет явного `view`/`full`).

Источник строк: **`ms_export`** + артикул из **`ms_entity_details.denorm_article`**.

### GET `/api/exports/competitors`

Список товаров для поиска названия на маркетплейсах.

Query:

| Параметр | Описание |
|----------|----------|
| `search` | Умный поиск (как МойСклад): слова через пробел = **AND** по `code`/`name`/`article`/`manager`; группы через `\|` = OR; фраза в кавычках; ключи `sku:`/`code:`, `name:`, `article:`, `manager:` |
| `buy_price_min` / `buy_price_max` | Диапазон закупочной (парсинг строки `ms_export.buy_price` как в МойСклад) |
| `type` | `all` (по умолчанию) \| `product` (Товар) \| `bundle` (Комплект) |
| `stock_position` | `yes` (**по умолчанию**, только «Да») \| `no` \| `all` |
| `manager` | точное имя из `ms_export.manager`; `__empty__` — без менеджера; пусто — все |
| `competitors_ozon` / `competitors_wb` / `competitors_yandex` | `all` (по умолчанию) \| `0` не отмечено \| `1` включена \| `2` не требуется \| `3` конкурентов нет |
| `updated_from` / `updated_to` | дата `YYYY-MM-DD` по `dg_mp_competitor_marks.updated_at` (включительно); игнорируются при `updated_none=1` |
| `updated_none` | `1` — только строки без сохранённого статуса (`updated_at IS NULL`) |
| `sort_by` | `code` \| `article` \| `manager` \| `name` \| `buy_price` \| `stock` \| `updated_at` (по умолчанию `code`) |
| `sort_dir` | `asc` \| `desc` |
| `limit` | по умолчанию **100**, макс. 500 |
| `offset` | пагинация |

Ответ: `{ success, total, limit, offset, sort_by, sort_dir, managers: string[], filters, items: [{ code, article, manager, name, buy_price, stock, competitors_ozon, competitors_wb, competitors_yandex, updated_at }] }`.

На UI код и название ведут на `/product.html?code=…`; перед названием — **Менеджер товара** (`ms_export.manager`); далее **Закупочная** / **Остаток**; колонки Ozon / ВБ / Я.Маркет — ссылки «Искать»; сразу после каждой — статус **Конкуренты …** (`dg_mp_competitor_marks`: `0` пусто, `1` включена, `2` не требуется, `3` конкурентов нет); колонка **Обновлено** — `updated_at` последней записи статуса.

### POST `/api/exports/competitors/mark`

Сохранить статус по коду товара.

Body: `{ "code": "…", "field": "ozon"|"wb"|"yandex", "value": 0|1|2|3 }`

- `0` — не отмечено  
- `1` — включена (конкуренты проработаны / есть)  
- `2` — не требуется  
- `3` — конкурентов нету  

Ответ: `{ success, code, field, value, competitors_ozon, competitors_wb, competitors_yandex, updated_at }`.

Таблица: **`dg_mp_competitor_marks`** (`code` PK, `ozon`, `wb`, `yandex`, `updated_at`, `updated_by_user_id`).

## Exports / Dimensions (Габариты)

Префикс: `/api/exports/dimensions`. Экран: `/exports-dimensions.html` (подменю **Маркетплейсы**, в меню после **Huckster**).

Назначение: реестр замеров габаритов товаров и комплектов МойСклад с фиксацией **кто** и **когда** замерял. Базовые поля (код, наименование, тип) берутся из `ms_export`. Замеры хранятся в отдельной таблице **`ms_dimensions_measurements`** и подмешиваются к строкам `ms_export` по полю `code`. Журнал изменений по каждой позиции ведётся в **`ms_dimensions_log`** (см. ниже).

Таблица замеров (создаётся и доращивается миграцией при первом обращении к роуту):

```sql
CREATE TABLE IF NOT EXISTS ms_dimensions_measurements (
    code VARCHAR(255) NOT NULL PRIMARY KEY,
    measured_by_user_id INT NULL,
    measured_by_name VARCHAR(255) NULL,
    measured_at TIMESTAMP NULL,
    length_cm DECIMAL(10,2) NULL,
    width_cm DECIMAL(10,2) NULL,
    height_box_cm DECIMAL(10,2) NULL,
    height_bag_cm DECIMAL(10,2) NULL,
    weight_kg DECIMAL(10,3) NULL,
    packing_type VARCHAR(255) NULL,
    dimensions_json LONGTEXT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_dim_meas_by_user (measured_by_user_id),
    INDEX idx_dim_meas_at (measured_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

Журнал изменений (одна строка = одно изменение поля одного товара):

```sql
CREATE TABLE IF NOT EXISTS ms_dimensions_log (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    code VARCHAR(255) NOT NULL,
    field VARCHAR(64) NOT NULL,           -- length_cm | width_cm | height_box_cm | height_bag_cm | weight_kg | packing_type | *
    old_value VARCHAR(255) NULL,
    new_value VARCHAR(255) NULL,
    action VARCHAR(32) NOT NULL DEFAULT 'set',  -- 'set' | 'delete'
    changed_by_user_id INT NULL,
    changed_by_name VARCHAR(255) NULL,
    note VARCHAR(500) NULL,
    changed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_dim_log_code (code, changed_at),
    INDEX idx_dim_log_user (changed_by_user_id),
    INDEX idx_dim_log_field (field)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

Доступ к API проверяется по странице **`exports-dimensions`** (см. `lib/datagonPageRegistry.js`); страница, в свою очередь, наследует «скрытие» от родительской `exports-marketplaces` в матрице `page_modes` (как и Ozon / WB / Я.Маркет / «Проблемы с товарами»).

### GET `/api/exports/dimensions/list`

Список позиций МС с подмешанным замером. **Базовый фильтр всегда включён** и не настраивается через query: показываем **только складские позиции** (`mse.stock_position = 'Да'`), при этом «не перестали сотрудничать» (`COALESCE(mse.no_longer_cooperation, '') <> 'Да'`); **исключение** — если по поставщику прекращено сотрудничество, но `COALESCE(mse.stock, 0) > 0`, позиция **всё равно** включается.

Параметры query (надстраиваются поверх базы):

- `search` — мульти-токен (через пробел = AND) по `mse.code` и `mse.name`.
- `type` — `all` (по умолчанию) / `товар` / `комплект`.
- `measure_scope` — `all` (по умолчанию) / `with` (только с замером) / `without` (только без замера). Обратная совместимость: то же значение можно передать как устаревший `scope`, если это не ключ маркетплейсного пресета.
- `mp_scope` — на экране **«Габариты»** всегда используется `all` (фильтры по снапшотам маркетплейсов — на странице «Проблемы с товарами»). В HTTP-API параметр по-прежнему принимается для совместимости и интеграций: `all` (по умолчанию), `any`, `all3`, `ozon`, `wb`, `ym`, `vat_mismatch`, `dims_mismatch`. Для `vat_mismatch` и `dims_mismatch` выборка ограничивается первыми **50000** строками каталога (после базовых фильтров), затем фильтрация выполняется в Node; в ответе `post_filtered: true`, `post_filter_cap`. Чтобы не держать в памяти сразу все строки с тяжёлым `payload_json`, эти режимы читают БД **чанками** `LIMIT/OFFSET` и сразу отбрасывают неподходящие строки. Совпадения после пост-фильтра накапливаются в RAM не более **`post_filter_match_cap`** (сейчас 4000); при превышении — `post_filter_truncated: true` (остальные в каталоге не попали в `total` этого ответа).
- `problem_profile` — если `stock_missing`, показываются только позиции с **остатком > 0**, у которых для текущего типа упаковки не заполнено хотя бы одно обязательное поле замера (аналогично подсветке на «Проблемах с товарами»); поле `problem_cells` в строке — какие ключи замера подсвечивать. Взаимоисключающе с `mp_scope` ≠ `all` на UI: при активном профиле маркетплейсный пресет сбрасывается в `all`. **Быстрый путь:** при заполненном денорме габаритов МС в `ms_entity_details` (`denorm_dim_*`, пишется при синке МойСклад и backfill) фильтр считается **в SQL** через `COALESCE(mdm.*, denorm_dim_*)` — обычные `COUNT`/`LIMIT`, без скана 50k `payload_json`; в ответе `dims_denorm: true`, `post_filtered: false`. **Fallback** (денорм ещё не покрыл ≥95% карточек): прежний чанковый пост-фильтр с `post_filter_cap` / кэшем ~90 с.
- `exclude_has_bundle` — `1` (по умолчанию на UI) / `0`: при `1` из списка исключаются **товары**, чей `code` встречается как `component_code` в `dg_bundle_components` (есть комплект с этим компонентом). Строки типа «Комплект» не скрываются.
- `limit` — 1…500 (по умолчанию 100), `offset` — 0…1_000_000.
- `sort_by` — `code` | `name` | `type` | `stock` | `measured_by_name` | `measured_at` | `packing_type` | `length_cm` | `width_cm` | `height_box_cm` | `height_bag_cm` | `weight_kg` (по умолчанию `code`).
- `sort_dir` — `asc` | `desc`.

Ответ: `{ success: true, rows: [...], total, limit, offset, sort_by, sort_dir, mp_scope, problem_profile, exclude_has_bundle?, post_filtered?, post_filter_cap?, post_filter_match_cap?, post_filter_truncated?, dims_denorm?, dimension_attrs }`.

| Поле в API | Атрибут МойСклада | Описание |
|---|---|---|
| `packing_type` | `!!Тип УПАКОВКИ` | Тип упаковки (строка справочника МС) |
| `length_cm` | `!!Длина (см) КОРОБКА/Пакет станд. уп.` | Длина |
| `width_cm` | `!!Ширина (см) КОРОБКА/Пакет станд. уп.` | Ширина |
| `height_box_cm` | `!!Высота (см) КОРОБКА станд. уп.` | Высота — коробка |
| `height_bag_cm` | `!!Высота (см) Пакет!` | Высота — пакет |
| `weight_kg` | `!!Вес (кг)` | Вес |

Значения возвращаются «как есть» из МС (строки; для справочника — `value.name`). Если атрибута нет у позиции — пустая строка. Поле `dimension_attrs` в корне ответа отдаёт ту же таблицу `[{ key, label, attr }]` — для UI как источник истины подписей. Имена этих атрибутов также добавлены в `MS_ATTRS` в `routes/moysklad.js`, чтобы они гарантированно попадали в метаданные МС при синхронизации (на ширину `ms_export` это пока не влияет — расширение схемы можно сделать позже отдельной задачей).

В дополнение к `dimensions_ms` ответ содержит:

- **`measurement`** — пользовательский override из `ms_dimensions_measurements` (или `null`, если ещё не сохранялся). Поля: `length_cm`, `width_cm`, `height_box_cm`, `height_bag_cm`, `weight_kg` (числа `Number|null`), `packing_type` (`String|null`).
- **`dimensions_parsed`** — результат **парсера «Тип упаковки»**: `{ kind, length_cm, width_cm, height_box_cm, height_bag_cm }`. Поле `kind`:
  - `box` — «Гофрокороб 30*20*15» → `length=30, width=20, height_box=15`.
  - `bag` — «Курьерский пакет 15*22» → `length=15, width=22`; «Высота — коробка» **не определена** (UI должен заблокировать редактирование `height_box_cm` и просить пользователя заполнить `height_bag_cm` руками).
  - `custom_box` — «Своя упаковка» → ничего не парсим; пользователь сам вводит `length_cm`, `width_cm`, `height_box_cm`.
  - `unknown` — нет ключевых слов «короб/гофр/пакет/своя»; пытаемся как «box», если есть 3 числа.
  - `empty` — пустой текст.

Парсер понимает разделители `*`, `x`, `х` (кириллица), `×`, `/`; распознаёт запятую как десятичный разделитель (`30,5`).

UI поверх этих данных вычисляет «эффективное» значение каждой ячейки замера в порядке приоритета: **override → MS-атрибут → parsed → пусто**. При `problem_profile=stock_missing` сервер может добавить в строку объект **`problem_cells`** (`{ length_cm: true, … }`) — какие поля замера считаются незаполненными для подсветки в таблице.

### POST `/api/exports/dimensions/measure`

Сохранить один или несколько полей замера. Каждое реальное изменение фиксируется отдельной строкой в `ms_dimensions_log` (поле `changed_by_user_id` = ID активной сессии).

Body (JSON):

- `code` (обяз.) — код МС.
- `field` (опц.) + `value` (опц.) — одно поле + значение.
- `fields` (опц., объект) — словарь `{ field: value, ... }` для пакетного сохранения нескольких полей.
- `measured_by_name`, `measured_at` (опц.) — переопределить автора и время; по умолчанию берётся текущая сессия и `NOW()`.
- `note` (опц.) — комментарий (записывается в `ms_dimensions_log.note`).

Допустимые поля: `length_cm`, `width_cm`, `height_box_cm`, `height_bag_cm`, `weight_kg` (`DECIMAL`), `packing_type` (`String`). Пустое значение (`null`, `""`) очищает поле.

Ответ:

```json
{
  "success": true,
  "code": "00-00067881",
  "changed_fields": [
    { "field": "length_cm", "old": null, "new": 30 }
  ],
  "measurement": { "length_cm": 30, "width_cm": null, ... },
  "measured_by_user_id": 1,
  "measured_by_name": "Stanislav Vasilenko",
  "measured_at": "2026-05-11T10:14:25.000Z"
}
```

### GET `/api/exports/dimensions/log`

Журнал изменений по конкретной позиции с пагинацией. Используется модалкой `🕘 Лог` на `/exports-dimensions.html`, а также tooltip-ом «3 последних правки» при наведении на ячейки (там через `?field=...&limit=3`).

Параметры:

- `code` (обяз.) — код позиции.
- `field` (опц.) — фильтр по одному полю (`length_cm`, `width_cm`, `height_box_cm`, `height_bag_cm`, `weight_kg`, `packing_type`). Без него возвращаются все записи по `code`.
- `limit` (опц., 1..500) — размер страницы, дефолт 100.
- `offset` (опц., ≥ 0) — смещение для пагинации, дефолт 0.

Ответ:

```json
{
  "success": true,
  "code": "10148",
  "rows": [
    {
      "id": 245,
      "code": "10148",
      "field": "length_cm",
      "field_label": "Длина (см)",
      "old_value": "30",
      "new_value": "31",
      "action": "set",
      "changed_by_user_id": 7,
      "changed_by_name": "Иванов И.И.",
      "note": null,
      "changed_at": "2026-05-11T13:24:00.000Z"
    }
  ],
  "total": 642,
  "limit": 100,
  "offset": 0
}
```

Сортировка: `id DESC` (свежие сверху).

### GET `/api/exports/dimensions/log/global`

Глобальный журнал всех изменений габаритов — по всем позициям. Используется карточкой **«Журнал изменений габаритов»** (`ms_dimensions_log`) на `/exports-dimensions.html` (свёрнута по умолчанию, разворачивается по кнопке «Развернуть» в шапке карточки).

Параметры (все опциональные, комбинируются по AND):

- `search` — подстрока по `code` ИЛИ `ms_export.name` (через `LIKE %x%`).
- `action` — `set`, `sync_ms`, `sync_ms_skip`, `sync_ms_error`, `delete`. Значение **`sync_ms_error`** — одна строка на неуспешную попытку `PUT` габаритов в МойСклад при автоматической или ручной выгрузке (текст ошибки и HTTP в `note`, поле `field` = `ms_push`).
- `field` — конкретное поле габаритов (см. список выше).
- `who` — подстрока по `changed_by_name`.
- `from`, `to` — диапазон по `changed_at`. Принимаются как `YYYY-MM-DD` (для `from` берётся 00:00, для `to` — 23:59), так и полные ISO-строки.
- `limit` (1..500, дефолт 100), `offset` (≥ 0, дефолт 0).

Ответ — как в `/log`, но в каждой строке дополнительно `name` и `type` товара/комплекта из `ms_export` (`LEFT JOIN ms_export USING(code)`). При отсутствии позиции в `ms_export` (например, она была удалена) — `name=''`, `type=''`.

```json
{
  "success": true,
  "rows": [
    {
      "id": 245, "code": "10148",
      "name": "Шприц-укол…", "type": "Товар",
      "field": "length_cm", "field_label": "Длина (см)",
      "old_value": "30", "new_value": "31",
      "action": "set",
      "changed_by_name": "Иванов И.И.",
      "note": "revert from log_id=120",
      "changed_at": "2026-05-11T13:24:00.000Z"
    }
  ],
  "total": 24560,
  "limit": 100,
  "offset": 0
}
```

### POST `/api/exports/dimensions/log/revert`

Откатить ОДНУ запись `set` из журнала. Восстанавливает значение поля в `old_value` через тот же `persistMeasurementFields`, что и обычное `POST /measure` — то есть в журнал добавляется НОВАЯ `set`-запись (с автором отката, текущим временем и `note: 'revert from log_id=N'`). Сам факт отката тоже становится аудируемым.

Body (JSON):

- `log_id` (обяз.) — ID строки `ms_dimensions_log` с `action='set'` и `field` из списка габаритов.

Ограничения:

- `action` исходной записи должен быть `set` (иначе `400 «Откат поддержан только для записей с action="set"»`).
- `field` должен быть из `MEASUREMENT_FIELDS` (`length_cm`, …, `packing_type`).
- Если `old_value` был `NULL` (то есть исходная запись очистила поле «из значения → пусто»), откат вернёт поле в `NULL` (и `note` будет `'revert from log_id=N (clear)'`).

Ответ:

```json
{
  "success": true,
  "code": "10148",
  "field": "length_cm",
  "reverted_to": 30,
  "persisted_fields": ["length_cm"],
  "measurement": { "length_cm": 30, "width_cm": 20, "height_box_cm": 15, "height_bag_cm": null, "weight_kg": 1.2, "packing_type": "Гофкороб 30*20*15" },
  "measured_by_name": "Иванов И.И.",
  "measured_at": "2026-05-11T14:32:00.000Z",
  "changed": true
}
```

`changed: false` означает, что значение уже совпадало с `old_value` (откат не понадобился — никаких записей в журнал не добавлено).

### GET `/api/exports/dimensions/parse-packing`

Сухой запуск парсера. Принимает `?text=...`, возвращает `{ success: true, parsed: { kind, length_cm, width_cm, height_box_cm, height_bag_cm } }` — без записи в БД. Удобно для интеграционных тестов.

### GET `/api/exports/dimensions/log/edits-by-employee`

Агрегат для графика на `/exports-dimensions.html`: сколько **разных товаров** (`code`) отредактировал каждый сотрудник за период (только `action=set` — правки в панели).

Query:

- `period` — `current_month` (по умолчанию на UI), `prev_month`, `7`, `30` (скользящие N дней). Устаревший `days` — только если `period` не задан.
- `refresh=1` — сброс in-memory кэша и пересчёт (иначе ответ может быть из кэша **24 часа** на ключ периода).

Ответ:

```json
{
  "success": true,
  "cached": true,
  "cache_ttl_hours": 24,
  "cache_age_ms": 120000,
  "cache_expires_at": "2026-05-17T12:00:00.000Z",
  "period": "current_month",
  "period_kind": "current_month",
  "period_label": "Май 2026",
  "days": null,
  "generated_at": "2026-05-16T12:00:00.000Z",
  "action": "set",
  "employees": [
    { "name": "Иванов И.И.", "user_id": 12, "products_edited": 84, "field_edits": 210 }
  ],
  "totals": { "products_unique": 120, "field_edits": 340 }
}
```

### GET `/api/exports/dimensions/log/stats`

Статистика таблицы `ms_dimensions_log` для карточки **«Журнал изменений габаритов»** на `/settings.html`. Не принимает параметров.

Ответ:

```json
{
  "success": true,
  "total": 1234,
  "oldest_at": "2025-11-13T08:24:00.000Z",
  "newest_at": "2026-05-11T13:24:00.000Z",
  "by_action": { "set": 480, "sync_ms": 754, "delete": 0 },
  "retention_days": 180,
  "older_than_retention": 12
}
```

- `older_than_retention` — сколько строк будет удалено при ближайшей автоочистке (или сейчас при `POST /log/cleanup` с текущим `retention_days`).
- `retention_days` берётся из `app_settings.ms_dimensions_log_retention_days`.

### POST `/api/exports/dimensions/log/cleanup`

Ручная очистка журнала старше N дней. Используется кнопкой «Очистить сейчас» в `/settings.html`.

Body (JSON, опционально):

- `days` — retention в днях. Если не передан или невалиден — берётся `app_settings.ms_dimensions_log_retention_days` (по умолчанию 180).

Ответ: `{ success: true, deleted: 12, days: 180 }`.

Автоочистка по тому же retention выполняется автоматически: при старте сервера и каждые 12 часов (`cleanupDimensionsLogByRetentionDays()` в `server.js`). Удаляются ВСЕ типы записей (`set`, `delete`, `sync_ms`) старше N дней.

### GET `/api/exports/dimensions/pending-sync`

Вернуть все позиции с user-override в `ms_dimensions_measurements` (хотя бы одно из полей `length_cm`/`width_cm`/`height_box_cm`/`height_bag_cm`/`weight_kg`/`packing_type` не пустое). Используется UI для балк-кнопки «↗ В МС: все правки (все стр.)» — она джоинит этот список с inline-правками текущей страницы.

**Важно про UX:** балк-синк по семантике **игнорирует** активные на странице фильтры таблицы (умный поиск, scope «Только с правками», тип «Товары/Комплекты»). Чтобы пользователь не путал «вижу 1 строку с фильтром = синкаю 1 строку», `static-html/vanilla/inners/exports-dimensions.scripts.html` в confirm-диалоге дополнительно перечисляет активные фильтры с пометкой «Балк-синк всё равно отправит ВСЕ позиции с правками из БД, не только видимые в таблице» — см. историю инцидента 11.05.2026 с поиском `5123-komplect-7` на боевом сервере.

- `?exclude=code1,code2,...` (опц.) — исключить указанные коды (UI передаёт коды текущей страницы, чтобы балк ушёл только по «остальным», а текущая страница обработалась с DOM-правками).

Сортировка: `measured_at DESC, code ASC` (свежие правки первыми).

Ответ:

```json
{
  "success": true,
  "total": 142,
  "excluded": 100,
  "rows": [
    {
      "code": "10148",
      "name": "Шприц-укол …",
      "type": "Товар",
      "has_uuid": true,
      "measured_by_name": "Иванов И.И.",
      "measured_at": "2026-05-11T14:24:00.000Z",
      "fields": {
        "length_cm": true,
        "width_cm": true,
        "height_box_cm": false,
        "height_bag_cm": true,
        "weight_kg": true,
        "packing_type": true
      }
    }
  ]
}
```

`has_uuid: false` означает, что позиция есть в `ms_dimensions_measurements`, но больше не существует в `ms_export` (удалена/не синкается из МС) — UI такие позиции в балк не включает (sync-ms по ним вернёт 503/404).

### GET `/api/exports/dimensions/packing-types`

Импорт справочника «Тип упаковки» (`customentity` «!!Тип УПАКОВКИ») из МойСклад. Используется UI для рендера `<select>` в ячейке `packing_type` и для маппинга «имя → `meta.href`» при `POST /sync-ms`. Кэш — **1 час**.

- `?refresh=1` — форсированный обход кэша (повторный импорт).

Откуда берутся значения. В метаданных продукта (`/entity/product/metadata/attributes`) у атрибута «!!Тип УПАКОВКИ» (`type: "customentity"`) поле `customEntityMeta.href` указывает на МЕТАДАННЫЕ справочника — `/context/companysettings/metadata/customEntities/<uuid>` (структура `{meta, entityMeta, attributes, id, name, createShared}`, без `rows`). Список значений живёт в `entityMeta.href` — `/entity/customentity/<uuid>`. Поэтому сервер сначала идёт за метаданными, забирает оттуда `entityMeta.href`, и только потом дёргает список с `?limit=1000`. Раньше код шёл сразу на `customEntityMeta.href` и стабильно получал `rows.length = 0` — на UI кнопка «🔄 Тип упаковки» отрабатывала, но `<select>` оставались пустыми. В ответе поле `source_url` теперь содержит **`entityMeta.href`** (URL списка), что упрощает диагностику.

Ответ: `{ success: true, rows: [{ id, name, href }, ...], source_url, refreshed_at, cache_age_ms }`.

При проблемах с метаданными МС — `503` с `code: 'NO_TOKEN' | 'ATTR_NOT_FOUND' | 'NOT_CUSTOM_ENTITY' | 'FETCH_FAILED'`.

### POST `/api/exports/dimensions/sync-ms`

Отправить пользовательский override габаритов (`ms_dimensions_measurements`) обратно в **МойСклад** через `PUT /entity/{kind}/{uuid}`. Сущность определяется автоматически по `ms_export.type` (`'Товар' → product`, `'Комплект' → bundle`). Метаданные атрибутов МС кэшируются на 1 час (паритет с `routes/moysklad.js`).

Body (JSON):

- `code` (обяз.) — код МС.
- `fields` (опц., массив строк) — whitelist: синкать только эти поля; по умолчанию — все непустые поля override.
- `measurement` (опц., объект) — **inline-значения** прямо из формы (UI: текущие значения всех `<input>`/`<select>` ряда). Если передан — сервер **сначала persist'ит** эти значения в `ms_dimensions_measurements` (с записью в `ms_dimensions_log`, действием `set` и автором `req.datagonActor`), а только потом PUT'ит обновлённое состояние в МС. Это решает кейс «пользователь набрал значение в ячейке, но не нажал Enter/blur» — отправится и оно тоже. Используется кнопками «↗ В МС» (per-row) и «↗ В МС: всё на странице» (балк) в `/exports-dimensions.html`.

  **Семантика ключей в `measurement`:** поле, которое **передано и не равно `null`**, — UPSERT'ится в БД (новое значение записывается, в журнал идёт строка `set`). Поле, которое **передано как `null`**, — **очищает override** (`length_cm = NULL`). Поле, которое **отсутствует в объекте**, — НЕ трогается. Поэтому UI на стороне клиента (`gatherRowInputValues` в `static-html/vanilla/inners/exports-dimensions.scripts.html`) намеренно **пропускает пустые инпуты** при сборке `measurement`: иначе кнопка «↗ В МС: все правки» при незавершённой авто-заливке после смены `packing_type` отправляла бы `length_cm: null / width_cm: null / height_box_cm: null` и зачищала бы корректные значения.

Маппинг полей → атрибуты МС:

| Поле API | Атрибут МойСклад | Тип в МС |
|---|---|---|
| `length_cm` | `!!Длина (см) КОРОБКА/Пакет станд. уп.` | double |
| `width_cm` | `!!Ширина (см) КОРОБКА/Пакет станд. уп.` | double |
| `height_box_cm` | `!!Высота (см) КОРОБКА станд. уп.` | double |
| `height_bag_cm` | `!!Высота (см) Пакет!` | double |
| `weight_kg` | `!!Вес (кг)` | double |
| `packing_type` | `!!Тип УПАКОВКИ` | **customentity** |

**`packing_type`** теперь поддерживается: сервер находит элемент справочника по имени (см. `/packing-types`) и собирает значение атрибута в формате `{ meta: { href, type: 'customentity', mediaType }, name }`. Если имя не найдено в справочнике — попадает в `skipped[]` с `reason: 'customentity_value_not_in_dict'` (нужно сначала вызвать `GET /packing-types?refresh=1` для повторного импорта или поправить написание).

Поведение:

1. (Опц.) Если в body есть `measurement` — `persistMeasurementFields()` пишет журнал и UPSERT'ит строки в `ms_dimensions_measurements`. Возвращает список реально изменившихся полей (`persisted_fields`).
2. Читаем актуальный override-замер из БД.
3. **Авто-заливка parsed-defaults из имени упаковки** (паритет с UI). Если у позиции есть override `packing_type` (например, «Гофкороб 40*30*20»), но НЕТ override `length_cm` / `width_cm` / `height_box_cm`, — сервер сам берёт значения, разобранные из имени упаковки (`parsePackingDims`), и подмешивает их в `measurement` перед PUT в МС. Эти parsed-defaults дополнительно persist'ятся в БД с записью в `ms_dimensions_log` (`action='set'`, `note='sync_ms (auto-persist parsed)'`) и попадают в `persisted_fields` ответа. Поведение по `kind`: `box`/`unknown`→`length`+`width`+`height_box`; `bag`→`length`+`width` (`height_bag` — только ручной ввод); `custom_box`/`empty` — ничего не подтягиваем. Если у пользователя есть свои значения для этих полей (override уже не пустой), parsed-defaults их **не** перетирают. Это устраняет старое поведение балк-«↗ В МС: все правки», когда для позиций со введённым только `packing_type`+`weight_kg` в МС улетали лишь эти два поля, а размеры оставались пустыми, хотя UI показывал их как ghost-default из имени упаковки.
4. Получаем metadata атрибутов сущности. **Внимание:** у MS API нет отдельного эндпоинта `/entity/bundle/metadata/attributes` (вернёт 404 «Неопознанный путь»), комплекты делят набор пользовательских атрибутов с товарами (см. `meta.metadataHref` в ответе `/entity/bundle/{uuid}`). Поэтому для `entity_kind === 'bundle'` сервер запрашивает и кэширует **`/entity/product/metadata/attributes`**; PUT после этого идёт уже на `/entity/bundle/{uuid}`.
5. Если в `measurement` есть `packing_type` — параллельно подгружается кэш справочника (для маппинга имени → `href`).
6. Формируем `attributes[]` с `meta.href` и приводим значения к типу атрибута. Атрибуты, которых нет в метаданных МС, попадают в `skipped[]` с `reason: 'attribute_not_in_ms_metadata'`.
7. Делаем `PUT /entity/{kind}/{uuid}` с `{ attributes: [...] }`.
8. На успех — для каждого отправленного поля пишем строку в `ms_dimensions_log` с `action='sync_ms'`, `new_value` = отправленное значение, `note = 'sync_ms entity=product http=200'`.

Ответ:

```json
{
  "success": true,
  "code": "00-00067881",
  "uuid": "9d0a2c...",
  "type": "Товар",
  "entity_kind": "product",
  "sent_fields": ["length_cm", "width_cm", "height_box_cm", "weight_kg", "packing_type"],
  "skipped": [],
  "persisted_fields": ["length_cm", "width_cm"],
  "ms_updated_at": "2026-05-11 13:24:00.000",
  "http_status": null
}
```

При ошибке MS API ответ: `{ success: false, error: 'MS API 400: ...', http_status: 400, sent_fields, skipped, persisted_fields }`. При отсутствии `MS_TOKEN`/`uuid` — `503` с `code_error: 'NO_TOKEN' | 'NO_UUID'` (включая `persisted_fields`, если успели сохранить inline-`measurement` в БД до фейла).

**Балк по расписанию.** Тот же `syncCodeToMs(...)` вызывается из `runScheduledSyncMs(db, triggerType)` (`module.exports.runScheduledSyncMs` в `routes/dimensions.js`) — это серверный балк-синк всех позиций с override габаритов, без UI и без передачи `measurement` от клиента. Включается в `/settings.html` → «Автосинхронизация по расписанию» → «Габариты МС: время выгрузки (МСК)» (`auto_sync_dimensions_enabled` / `auto_sync_dimensions_time`, по умолчанию `21:00`). Логи: `auto_sync_runs` (тип задачи `dimensions`, `trigger_type = schedule|manual`) + `ms_dimensions_log` (по строке за каждое реально отправленное поле, `action='sync_ms'`, `changed_by_name='Авто-синхронизация (расписание|вручную)'`). Состояние «в процессе» доступно через `module.exports.getScheduledSyncState()` (потребляется `processAutoSyncQueue` для honest-статуса в `auto_sync_runs.message`).

### DELETE `/api/exports/dimensions/measure/:code`

Удалить замер по коду (откатывает «Кто замерял» / «Дата замера» в пустое значение и все габариты обнуляются). Действие фиксируется в `ms_dimensions_log` строкой `action='delete'`.

Ответ: `{ success: true, code }`.

## Exports / Новые товары

Префикс: `/api/exports/new-products`. Экран: `/exports-new-products.html` (подменю **Маркетплейсы**). Вкладки UI: **Альмамед** (`channel=almamed`), **Маркеты** (`channel=marketplaces`), **Статистика контент-отдела** (`GET /content-stats`), **Постоянные задачи** (`GET /standing-stats`, инфографика), **Настройка уведомлений датагон-crm** (`#crm-notify`). Deep-link вкладок (hash или `?tab=`): `#almamed`, `#marketplaces`, `#stats`, `#standing`, `#crm-notify` (алиасы `#content-stats`, `#infographic`, `#crm`, `?tab=markets`). Таблица `dg_new_products` (создаётся при первом запросе).

**UI / wide-таблица (lock):** плавающая шапка — `#dg-np-float-host` (`position: fixed` клон thead), **не** `translate3d` на живом `#dg-np-thead` (тяжёлая таблица; shop-схема Ozon сюда не копировать). Ширины — только `<colgroup>`, `table-layout: auto`. Контракт: `.cursor/rules/datagon-table-behavior-lock.mdc` (раздел «Новые товары»).

Доступ по матрице страницы **`exports-new-products`** (как дочерняя маркетплейсов наследует скрытие родителя `exports-marketplaces`, если у дочерней нет явного `view`/`full`).

Вкладки **«Статистика контент-отдела»** и **«Постоянные задачи»** — отдельные ключи матрицы (`matrixOnly`, тот же HTML `exports-new-products.html`):

| Ключ | Вкладка / API |
|------|----------------|
| **`exports-new-products-stats`** | Статистика контент-отдела · `GET /content-stats` · CRM `scope=almamed\|marketplaces` |
| **`exports-new-products-standing`** | Постоянные задачи · `GET /standing-stats` · CRM `scope=infographic` |

Режимы: `hidden` — вкладка скрыта и соответствующий API запрещён; `view` — просмотр, `PUT` привязок CRM запрещён; `full` — просмотр и правка привязок. Наследуют скрытие родителя `exports-marketplaces`, если у ключа нет явного `view`/`full`. Список/CRUD очереди новых товаров по-прежнему проверяются по **`exports-new-products`**.

### Регламент / инструкция МП

Страница **`/exports-marketplaces-reglament.html`** (ключ матрицы **`exports-marketplaces-reglament`**, пункт меню **Маркетплейсы → Инструкция**): статический HTML-регламент v1.1 «от поиска товара до склада» — входы SellerStats / KeyCollector / Датагон (Анализ поставщиков) / витрина МП; скриншоты в `/mp-assets/sellerstats|keycollector|datagon-sa|purchase/`. Отдельного API нет; доступ как у дочерних страниц маркетплейсов (наследование скрытия от `exports-marketplaces`).

Статусы Альмамед: `new` | `not_added` | `in_progress` | `added` | `revision` | `review` | `transferred` (скрыт).  
Статусы маркетов: `new` | `not_added` | `added` | `revision` | `not_cooperate` | `in_bundle` | `removed` (скрыт).

**Альмамед:** новый товар — `new`. Когда заполнены обязательные поля (**артикул**, **название**, **цена Альмамед**, **ссылка поставщика**, **приоритет**) → `not_added`. Контент: `in_progress` → `added`; замечания — `revision` + `comment`. Кнопка **«Убрать размещенные»** на вкладке Альмамед — **пресет фильтра** (`exclude_verified=1`): скрывает `verified` из списка, **не** переводит в `removed`.

**Размещение на маркеты:** строки из Альмамед со статусом `added` (и legacy `transferred`) или с флагами **`sell_on_markets=1`** / **`has_kits=1`** через `POST /sync-markets-queue` и при каждом `PATCH` Альмамед-строки с этими флагами. Аналогичные поля (менеджер, ответственный, приоритет, артикул/код, название, цена, `has_kits`) копируются/обновляются в строку `channel=marketplaces` (`source_almamed_id`). На один `source_almamed_id` — **не больше одной** активной строки маркетов (`UNIQUE` + транзакция `FOR UPDATE` при upsert; гонка галочек «Маркеты»/«Комплект» больше не плодит дубли). **ID разные:** Альмамед и маркеты — отдельные строки одной таблицы (`dg_new_products`); у каждой вкладки своя нумерация `channel_num` (1, 2, 3…), не общий auto-increment. В UI колонка ID показывает `channel_num`; связь `← Альм. #N` / `→ Марк. #N` тоже по номерам вкладки (`source_almamed_id` / `markets_product_id` — внутренние PK). Из МС (по **коду** или **артикулу**, когда товар уже есть в `ms_export`) подтягиваются **код МС**, **штрихкод** (`payload.barcodes`), **НДС** (`ms_export.vat` / `effectiveVat` / атрибут «НДС на товаре…»; `0` → «без НДС»), **ссылка на РУ** (атрибут **«РУ ссылка на файл»** и родственные). Поля габаритов (`length_cm` / `width_cm` / `height_cm` / `weight_kg`) в БД остаются, но **в UI вкладки «Размещение на маркеты» не показываются и не обязательны**. На **`GET` списка** обогащение идёт только из **кэша БД** (без live API МС — иначе каждый refresh тормозит страницу при пустых НДС/РУ). Live `GET` карточки МС — при `POST /sync-markets-queue` (лимит). Результат пишется в `ms_entity_details` и пустые поля `dg_new_products` + журнал `source=ms_enrich`. Размещение Ozon/WB/ЯМ — live-бейджи в колонке «Связь» по `marketplace_export_rows.external_id` (= код МС). Обязательные: приоритет, код, артикул, название для маркетов, штрихкод, цена на маркеты, НДС, ссылка на РУ. Пустые → `new`; все заполнены → `not_added`; на всех трёх МП → `added`. Комментарий → `revision`; очистка комментария → снова `added` (если на всех МП) или `new`/`not_added`. Ручные: `not_cooperate`, `in_bundle`. Кнопка **«Убрать размещенные»** → `POST /remove-placed` (status `added` → `removed`).

**Комплекты:** колонка Альмамед **«Комплект»** (`has_kits`). На маркетах при `has_kits=1` — кнопка **«+ Комплект»**; комплекты — вложенные строки. У комплекта редактируются: код, название, цена, статус, комментарий. **Не редактируются:** артикул, штрихкод, НДС (только просмотр). **Ссылка на РУ** у комплекта всегда с родительского товара в Датагоне (`parent.ru_url`), не из МС и не отдельным полем комплекта. Менеджер/дата/приоритет/ответственный — как у товара. API: `POST/PATCH/DELETE /api/exports/new-products/:id/kits[/:kitId]`.

### GET `/api/exports/new-products`

Query: `channel`, `search`, `status`, `priority`, `brand`, `responsible` (id | `none`), `manager` (id | `none`), `limit` (default 100), `offset`, `sort_by`, `sort_dir`. Без `status` — без `transferred` (Альмамед) / `removed` (маркеты). В ответе: `missing_required`, `incomplete_count`, `required_fields`, поля размещения/габаритов для маркетов, для Альмамед — `sell_on_markets`, `has_kits`; для маркетов — `has_kits`, `kits[]`.

Список **не** делает тяжёлое `enrichMarketsRowsFromMs` (N×SQL + запись в БД/журнал на каждую недозаполненную строку маркетов) — иначе GET «Размещение на маркеты» уходил в десятки секунд. Подтягивание кода/штрихкода/НДС/РУ/цены из МС — при upsert из Альмамед, «Обновить очередь маркетов» и точечных операциях, не на каждом открытии таблицы.
В каждой строке также **`presence`** (колонка **«Связь»** после ID): `my_products` (SKU в `my_products` после импорта CMS «Мои товары»), `ms` (код/артикул в `ms_export`), `ozon`/`wb`/`ym` + URL из `marketplace_export_rows`, **`huckster`** (код найден хотя бы в одном кабинете снапшота Huckster `sheet_export` / `sheet_export_rrc`, `bridge_row_meta.cabinets ≠ bad`; кэш ~90 с). На вкладке **Альмамед** (часто только артикул `A-…`) бейджи МП/HK резолвятся через **код МС** из `ms_export` (и `offer_id`/`vendor_code`/`shop_sku`), а не только по артикулу строки. На вкладке **Маркеты** — колонка **Huckster** (селект **Добавлено** / **Не добавлено**, поле `huckster` в `dg_new_products`) сразу после «Связь»; менять может только специальность **«Менеджер маркетплейсов»** (также `admin` / `can_manage_users` / «Полный доступ»). API: `PATCH` с `huckster`, иначе `403 HUCKSTER_FORBIDDEN`. Бейдж **HK** в «Связь» — по снапшоту матрицы + ссылка на `/exports-huckster.html?search=<код>`.

**`almamed_added_at` («Дата на Альмамед»):** при первой связи строки Альмамед с **`my_products`** (бейдж «Мои» после импорта CMS ~20:40) — проставляется автоматически при `GET` списка (один раз). Связь только с МС (`ms_export`) дату **не** ставит. Также при ручном статусе **«Добавлен»**, если поле ещё пусто. Раньше ошибочно ставилась только при статусе «На проверку».

**`placement_ozon_at` / `placement_wb_at` / `placement_ym_at` («Дата размещения» на маркетах):** дата **первого** появления кода в выгрузке соответствующего МП (`marketplace_export_rows.captured_at`, с момента фиксации first-seen больше не перезаписывается при синке). Пишутся в `dg_new_products` при upsert/«Обновить очередь маркетов»; в `GET` списка дополнительно подмешиваются live из снапшота. Колонка UI показывает три строки: Ozon / WB / ЯМ. Поле `placement_date` — самая ранняя из этих дат (для сортировки / legacy).

**Статусы и проверка (обе вкладки):** workflow контента — `new` (Новый) → `in_progress` (В работе) → `review` (На проверку) → `verified` (Проверен). Поле **`manager_checked`** (колонка «Проверено менеджером»): менеджеры ставят галочку. **`manager_comment`** — «Комментарий менеджер» (отдельно от `comment` / «Комментарий контент»). Статус **`verified`** принимается только при `manager_checked=1` и роли admin / `can_manage_users` / специальность «Полный доступ» (`403 VERIFIED_FORBIDDEN` / `400 MANAGER_CHECK_REQUIRED`). Снятие галочки при статусе `verified` возвращает статус на `review`. Авто-статусы `new`/`not_added`/`added` (заполненность / все МП) **не перетирают** workflow (`in_progress` / `review` / `verified` / `revision`). В `GET` списка: `can_set_verified`.

### POST `/api/exports/new-products`

Создать строку. Body: `channel`, `title` (≤128), опционально поля таблицы (в т.ч. markets-поля).

### POST `/api/exports/new-products/bulk`

Массовое добавление во вкладку `channel` (`almamed` | `marketplaces`). Body: `{ channel, text }` — многострочный текст, формат строки **`артикул;название`** (разделитель — **первая** `;`; пустые и `#…` пропускаются). Альтернатива: `{ channel, lines: [{ article, title },…] }`. Лимит **500** строк. Ответ: `created`, `skipped`, `total`, `errors[{ line, code?, error }]` (до 20), `duration_sec`, `created_ids` (до 50). В журнал строки — `source=bulk`.

### PATCH `/api/exports/new-products/:id`

Частичное обновление + авто-статус по каналу. Для Альмамед: `sell_on_markets`, `has_kits` (0/1). При любом из флагов =1 поля синхронизируются во вкладку маркетов. Ответ: `data`, `missing_required`, `auto_status_changed`, `markets_sync`.

### POST `/api/exports/new-products/:id/kits`

Добавить комплект к строке маркетов (`has_kits` обязателен). Body: `{ title? }`. Ответ: `{ success, data: { id, parent_product_id, title, sort_order } }`.

### PATCH `/api/exports/new-products/:id/kits/:kitId`

Обновить название комплекта. Body: `{ title }`.

### DELETE `/api/exports/new-products/:id/kits/:kitId`

Удалить комплект.

### GET `/api/exports/new-products/:id/log`

Журнал изменений строки (`dg_new_products_log`): кто / когда / поле / было→стало. Query: `limit` (default 100), `offset`, опционально **`field`** (ключ поля, напр. `responsible_user_id`) — только события по этому полю. Пишется при `POST`/`PATCH`/`DELETE` товара, комплектах и `distribute` (source `distribute`). Автоподтягивание из МС (код, штрихкод, НДС, РУ и т.п.) пишет строки с `source=ms_enrich`, `changed_by_name=система`; при первом `GET` списка для уже заполненных полей без истории — ретрозапись в журнал. В UI: кнопка **Лог** у ID — весь журнал; микрокнопка **лог** при наведении на ячейку — фильтр по полю.

### DELETE `/api/exports/new-products/:id`

Мягкое удаление: `status = removed` (не hard `DELETE`). Для Альмамед каскадом уводит в удалённые связанные строки маркетов (`source_almamed_id`). Ответ: `{ soft_deleted, cascaded_markets }`. Смотреть корзину: `GET /?status=removed`.

### POST `/api/exports/new-products/:id/restore`

Восстановить из удалённых (`removed` → `new`). Если у Альмамед снова `sell_on_markets`/`has_kits` — upsert в маркеты (в т.ч. оживляет ранее удалённую связанную строку).

### POST `/api/exports/new-products/distribute`

Раздать ответственных поровну **подряд идущими блоками** (не чередуя по одной строке): список без ответственного (или `scope=all`) сортируется как на экране (приоритет, `id`), затем делится на N почти равных непрерывных кусков по числу контент-менеджеров — чтобы пачка похожих SKU (отличие в одной характеристике) оставалась у одного человека для копирования полей. Ответ: `assigned`, `users`, `channel`, `scope`, `mode: "contiguous_blocks"`. Body: `{ channel, scope?: "unassigned"|"all", user_ids?: number[] }`.

### POST `/api/exports/new-products/sync-markets-queue`

Обновить очередь маркетов из Альмамед (`added` / legacy `transferred` / `sell_on_markets=1` / `has_kits=1`) + МС + снапшоты МП. Ответ: `from_almamed`, `updated`, `skipped_all_mp`, `duration_sec`.

### POST `/api/exports/new-products/remove-placed`

Убрать размещённые на вкладке **маркетов** (status `added` → soft `removed`). Body/query: `dry_run`.

На вкладке **Альмамед** кнопка «Убрать размещенные» **не** вызывает этот endpoint: это пресет фильтра `exclude_verified=1` / `hide_placed=1` на `GET /` (скрывает `status=verified` без изменения строк). Смотреть «Проверен» снова — повторный клик («Показать проверенные») или «По умолчанию»; либо явный фильтр статуса «Проверен».

### GET `/api/exports/new-products` — доп. для Альмамед

Query `exclude_verified=1` (алиас `hide_placed=1`): при пустом `status` добавляет `status <> 'verified'`. В ответе `applied_filters.exclude_verified`.

### GET `/api/exports/new-products/assignees` · `GET /meta`

`assignees`: `managers[]` — специальность **«Менеджер маркетплейсов»** (колонка/фильтр «Менеджер товара»); `responsibles[]` — только **«Контент-Менеджер»** (колонка/фильтр «Ответственный»); `data` = `managers` (back-compat). Meta — `statuses_almamed`, `statuses_marketplaces`, `required_fields_marketplaces`, `infographic_options`, `photo_options`.

### GET `/api/exports/new-products/content-stats`

Доступ: матрица **`exports-new-products-stats`** (`hidden` / `view` / `full`).

KPI контент-отдела (вкладка **Статистика контент-отдела**). Query: `from`, `to` (`YYYY-MM-DD`; по умолчанию последние 30 календарных дней inclusive), `channel` = `all` | `almamed` | `marketplaces` (default `all`) — режим UI **Альмамед + Маркеты / Альмамед / Маркеты**: режет KPI по `dg_new_products.channel` и выбирает CRM-привязки (`dg_np_crm_task_links.scope`). Для `all` часы CRM = сумма обоих scope; в ответе у менеджера есть `crm_links.{almamed,marketplaces}`.

Ответ: `{ success, period: { from, to, days }, channel, managers[], unassigned }`. Строки без `responsible_user_id` — в `unassigned` («Без ответственного»), не в средних по людям. Список `managers` — пересечение специальности «Контент-Менеджер» с id, у которых есть данные в периоде / WIP.

Поля на менеджере:

| Поле | Смысл |
|------|--------|
| `created_count` / `created_per_day` | строки с `created_at` в периоде ÷ `period.days` |
| `placement_*` | товары с событием размещения в периоде: `COALESCE(placement_date, almamed_added_at)`, иначе первый лог `status` → «Добавлен»/«Проверен»; среднее и медиана часов `(placement_ts − created_at)` только при положительном интервале |
| `revision_events` / `revision_products` / `revision_avg_per_product` | лог `status` → «На доработке» в периоде; assignee = текущий `np.responsible_user_id` |
| `verified_count` | лог `status` → «Проверен» в периоде |
| `wip_now` | снимок очереди сейчас: `new` / `not_added` / `in_progress` / `revision` / `review` (+ `total`), без периода |
| `crm_task_id` / `crm_task_title` | привязка КМ → задача CRM для текущего режима (`scope` = channel; при `all` — приоритет маркетов для сортировки) |
| `crm_links` | `{ almamed?: {crm_task_id,crm_task_title,crm_hours}, marketplaces?: … }` — обе привязки в режиме `all` |
| `crm_hours` | сумма таймеров `rise_project_time` за период по задаче(ам) режима |
| `crm_hours_per_placement` | `crm_hours ÷ placement_count` (в UI колонка «мин / размещ.» = ×60, минуты) |

В ответе также `crm: { configured, scope, error? }`.

### GET `/api/exports/new-products/standing-stats`

Доступ: матрица **`exports-new-products-standing`** (`hidden` / `view` / `full`).

KPI постоянной задачи **«Проработка инфографики на товарах»** (вкладка **Постоянные задачи**, deep-link `#standing`). Ориентир: **`quota_per_day = 10`** карточек/день. Query: `from`, `to` (`YYYY-MM-DD`; по умолчанию последние 30 дней inclusive). CRM-привязки — только `dg_np_crm_task_links.scope = infographic`.

Метрики — **средние по календарным дням** периода (не «норма × дни»: работа бывает не каждый день).

Ответ: `{ success, period: { from, to, days }, quota_per_day, task_title, crm: { configured, scope, error? }, managers[] }`. Список `managers` — все активные пользователи со специальностью **«Контент-Менеджер»**.

| Поле | Смысл |
|------|--------|
| `crm_task_id` / `crm_task_title` | привязка КМ → задача CRM (`scope=infographic`) |
| `crm_hours` | сумма таймеров `rise_project_time` за период (или `0` / `null` без часов / без привязки) |
| `period_days` | `period.days` (делитель для средних) |
| `hours_per_ten` | среднее: `crm_hours / days` (время на ориентир 10 карточек/день) |
| `minutes_per_card` | среднее: `(crm_hours × 60) / (days × 10)` минут на 1 карточку |

### PUT `/api/exports/new-products/crm-task-links`

Доступ зависит от `scope` (проверка в роуте):

- `almamed` | `marketplaces` → матрица **`exports-new-products-stats`**
- `infographic` → матрица **`exports-new-products-standing`**

`full` для записи; `view` — только GET того же пути с тем же scope. Body: `{ user_id, crm_task_id, scope? }` (`scope` = `almamed` | `marketplaces` | `infographic`, default `marketplaces`). Пустой/`null`/`0` — снять привязку. GET того же пути — список привязок указанного scope.

### Уведомления в задачи CRM

Вкладка **«Настройка уведомлений датагон-crm»** (`#crm-notify`). Доступ: матрица **`exports-new-products-crm-notify`** (`hidden` / `view` / `full`). `view` — только GET; запись и отправка — `full`.

Привязка сотрудник → задача берётся из `dg_np_crm_task_links` (`scope=almamed|marketplaces`), те же ID, что на статистике контент-отдела.

| Событие | Когда |
|---------|--------|
| Новые, Альмамед | у ответственного появился неразмещённый товар (`new` / `not_added` / `in_progress` / `revision` / `review`) |
| Новые, маркеты | то же, но только если заполнены обязательные поля размещения |
| Сводка | раз в `np_crm_notify_digest_days` дней (0 — выключена): «Товаров ожидает размещения: N» |

Первое включение мгновенных уведомлений **запоминает** текущую очередь (`np_crm_notify_baselined`) и не шлёт её как «новые». Дальше комментарий пишется в `rise_project_comments` и колокольчик CRM (`project_task_commented`). Автор — `np_crm_notify_crm_user_id` (по умолчанию `1`). `created_at` комментария и уведомления — **`UTC_TIMESTAMP()`** (как пишет сам RISE; `timezone` CRM = `Europe/Moscow`). Не использовать MySQL `NOW()` на хосте CRM с `@@system_time_zone=MSK` — в ленте задачи время уезжает на +3 ч.

Расписание — задача автосинка **`np_crm_notify`** (интервал 15/30/60 мин). На экране кнопка «Отправить новые» / «Отправить сводку» сначала делает `dry_run`, затем подтверждение и запись.

#### GET `/api/exports/new-products/crm-notify`

Снимок настроек и счётчиков по сотрудникам: `settings`, `people[]` (`almamed` / `marketplaces`: `crm_task_id`, `waiting`, `fresh`), `waiting_total`, `crm_configured`, `script` (`version`, `revision`).

#### POST `/api/exports/new-products/crm-notify`

Сохранить. Body: `enabled`, `instant_enabled`, `digest_days` (0–30), `interval_min` (15|30|60), `crm_user_id`. При первом включении мгновенных уведомлений возвращает `baselined_now`.

#### POST `/api/exports/new-products/crm-notify/run`

Body: `instant` и/или `digest` (сводка уходит сразу, не дожидаясь периода), `dry_run`. Ответ: `baselined`, `did_baseline`, `instant_posted`, `instant_products`, `digest_posted`, `errors[]` (до 20), `duration_sec`, `script`.

## Exports / Отснять товары

Префикс: `/api/exports/photoshoot`. Экран: `/exports-photoshoot.html` (подменю **Маркетплейсы**).

Источник строк — `dg_new_products` с `channel=marketplaces` и `status <> 'removed'` (та же очередь, что вкладка «Размещение на маркеты»). Поля съёмки на строке: `photoshoot_status`, `photoshoot_at`, `photoshoot_comment` (ensure при первом запросе).

**Статусы:** `not_shot` (Не отснят, дефолт), `out_of_stock` (Нет в наличии), `in_package` (товар в упаковке), `shot` (Отснят), `boxed` (Собран в коробку).

**Авто по остатку** (`ms_export.stock` join по `ms_product_uuid` / `product_code`): при `GET /` для статусов `not_shot` / `out_of_stock` — `stock ≤ 0` → `out_of_stock`, `stock > 0` → `not_shot`. Статусы `in_package` / `shot` / `boxed` авто-наличием не затираются.

### GET `/api/exports/photoshoot`

Query: `search`, `photoshoot_status`, **`has_stock`** (`1` по умолчанию — только с остатком; `0` — без остатка; `all` — без фильтра), `limit` (default 100), `offset`, `sort_by` (`stock`|`id`|`product_code`|`article`|`title`|`photoshoot_at`|`photoshoot_status`), `sort_dir`.

Ответ: `{ success, data[], total, limit, offset, has_stock, statuses[] }`. В строке: `product_code` (SKU), `article`, `title`, `photoshoot_*`, `stock`, `markets_codes`, `markets_title`, `almamed_article`, `almamed_title`.

### GET `/api/exports/photoshoot/meta`

Список статусов съёмки.

### PATCH `/api/exports/photoshoot/:id`

Body: `photoshoot_status`, `photoshoot_comment`. При смене статуса (кроме `out_of_stock`) сервер ставит `photoshoot_at = NOW()`. Журнал — `dg_new_products_log`.

### GET `/api/exports/photoshoot/:id/log`

Журнал полей съёмки (`photoshoot_status` / `photoshoot_comment` / `photoshoot_at`). Query: `field`, `limit`, `offset`. UI — мини-кнопка «лог» на ячейках статуса/комментария/даты (как на «Новые товары»).

## Exports / Huckster

Префикс: `/api/exports/huckster`. Экран: `/exports-huckster.html`.

Матрицы (`sheet_export` / `sheet_export_rrc` / `sheet_export_lost`):

- **`sheet_export` (набор 1, Huckster Export)** и **`sheet_export_rrc` (набор 2, Huckster Export RRC):** строки моста — **все** позиции из **`ms_export`** с непустым кодом (без серверного отсечения по складской позиции, сотрудничанию или цене). Сужение списка на экране — **блок фильтров** (менеджер, маркетплейсы, модели, умный поиск, «Не найдено», пагинация) и **галочки «архив МС»** (`app_settings` + `POST /ms-bridge-row-flags`). Смысл галочек: **скрыть архивные комплекты** (`is_archived` и при этом `type` = «Комплект» или в `ms_entity_details.kind` = `bundle`) **даже с остатком**; **скрыть архивные товары** (`type` = «Товар», `is_archived`) **только при** `stock ≤ 0`. Если для набора задан тип цены МойСклад (`price_type_set_*`), в таблицу добавляется **колонка** с этим типом (значение из `ms_entity_details.payload_json.salePrices` или пусто при отсутствии/нуле; **строки не удаляются**). Колонки: **ID / КОД** (= код МС; сшивка с Huckster: **`uid`/`Uid`** из `repricer/items/list` **без учёта регистра** и при расхождении с id на МП — доп. строковые поля той же позиции, например `offer_id`/`OfferId`, `marketplace_offer_id`, `article`/`Article`, `shop_sku`/`ShopSku`, `item_id`/`ItemId`; полный перечень — `extractRepricerAltMatchIds` в `routes/exportsHuckster.js`), **Наименование товара**, **Менеджер**, **Остаток**, **Автоматизация цены** (поле `ms_export.automation_price`), опционально **выбранный тип цены**, по маркетплейсам **Ozon / WB / ЯМ** — статус **«Репрайсер ВКЛЮЧЕН»** (зелёный), если по этому коду есть **ровно один** включённый repricer в маркетплейсе; иначе **«Репрайсер ВЫКЛЮЧЕН»** (красный: ноль или больше одного включённых — нельзя однозначно выбрать кабинет). Рядом колонки **«Модель …»** показывают назначение Unit-модели: название модели (зелёный), **«Модель не назначена»** (красный) или **«Модель назначена, но Репрайсер на модели выключен»** (жёлтый). Для набора 1 при обогащении из Huckster учитываются только Unit-модели «онлайн»+«калькулятор», для RRC — полный набор Unit-моделей. Последняя колонка **«Актуально на»** — время синка. В JSON добавлены **`bridge_row_meta`** (состояния кабинетов для подсветки), **`matrix_kind`: `ms_bridge_v1`**.

- **`sheet_export_lost` (потеряшки):** отдельная выборка для аудита. Строка попадает в набор, если в Huckster по коду есть **любая Unit-модель и/или включенный repricer**, а в МойСклад у этого кода одновременно `no_longer_cooperation = Да` и `stock = 0`. Колонки: `ID / КОД`, `Наименование товара`, `Менеджер`, `Остаток`, `Автоматизация цены` (`ms_export.automation_price`), `Repricer` (Да/Нет), `Модели Huckster`, `Актуально на`. Реализация: `routes/exportsHuckster.js`.

**Пагинация Huckster API (repricer / unit/set/get):** страница `limit=900`, но ответ может быть **короче** (например 884) при `cursor.total` > 900 — это **не** последняя страница. Цикл синка: `offset += длина_страницы`; выход только если страница пустая или (`len < limit` **и** `offset >= cursor.total`). Иначе теряются UID на следующих страницах (пример: код **3110**, модель ЯМ в наборе «30% наценка…»). Проверка: `node scripts/qa/huckster-wiki-probe-uid.js 3110 --set 1 --mp yandex`.

**Таймауты Unit ЯМ (rev.5 / v1.0.4):** у кабинета Я.Маркет `unit/set/get` может отвечать 20–40+ с на страницу; раньше axios timeout **45s** рвал запрос, throw обнулял **весь** кабинет (уже собранные модели других наборов терялись → «Модель не назначена» при живом UID в Unit). Сейчас: timeout страницы ЯМ **180s**, shop **600s**; сбой одного `set/get` после ретраев — skip набора, уже собранные UID сохраняются.

- **Фильтр «Модели» на `/exports-huckster.html` (клиент):** значение **«Расхождения ЕСТЬ»** включает строки, где при непустой **«Автоматизация цены»** с **число%** для маркетплейса с **Репрайсер ВКЛЮЧЕН** нет **Unit-модели с допустимым числом%** в названии (в т.ч. **«Модель не назначена»**), либо в названии есть **число%**, не входящее в набор из МС; либо (второй этап) между Ozon / WB / ЯМ расходятся **формулы** вида `N% наценка(и) + 50 ДОП + НДС` (15/20/30/50%…; «наценка»/«Наценки» — одно и то же). Скобки `(где нет РУ)`, id модели `(17)` и хвосты вроде `(14)1` в сверку **не** входят.

Старые снапшоты наборов 1/2 с первой колонкой **«Обновлено (repricer)»** UI отображает по прежней сетке (UID × кабинеты).

Ежедневный запуск по расписанию (МСК): флаги **`auto_sync_huckster_enabled`** / **`auto_sync_huckster_time`** в `POST /api/settings` — см. раздел [Settings](#settings); реализация в `server.js` (очередь `auto_sync_runs`, тип задачи `huckster`). В `auto_sync_runs`: **`completed`** только если снапшот сохранён **и** нет предупреждений Unit; при таймауте/`set/get` fail по кабинету статус **`failed`**, а в `message` — «Снапшот сохранён …, но ошибки (N): …» (кнопка «Лог» на `/processes.html` показывает этот текст, не только файл `logs/huckster-sync.log`).

### POST `/api/exports/huckster/sync`

Принудительно **запускает фоновое** обновление двух матриц Huckster (аналог листов Google Sheets `Huckster Export` и `Huckster Export RRC`) через API `wbs.e-teleport.ru`.

Основная кнопка экрана `/exports-huckster.html` отправляет в теле три булевых поля фильтра МС (`ms_exclude_archived_bundles`, `ms_exclude_archived_products_zero_stock`, `ms_exclude_products_with_bundles`); сервер **сохраняет** их в `app_settings` (для экрана и планировщика), **не** сужая при этом выборку из `ms_export` при `POST /sync` — в снапшот попадают все строки моста, а галочки управляют только отображением (см. `POST /ms-bridge-row-flags`). Креды — из `app_settings` / env, если в теле не переданы `email` / `password`. Кнопка **«Тест UID»** добавляет `test_uids` к тем же полям и не перезаписывает сохранённый snapshot.

Body (JSON):

- `ms_exclude_archived_bundles` — сохраняется в `app_settings.huckster_ms_exclude_archived_bundles` (экран: скрыть архивные комплекты в матрице).
- `ms_exclude_archived_products_zero_stock` — сохраняется в `app_settings.huckster_ms_exclude_archived_products_zero_stock` (экран: скрыть архивные товары без остатка).
- `ms_exclude_products_with_bundles` — сохраняется в `app_settings.huckster_ms_exclude_products_with_bundles` (экран: скрыть базовый код `N`, если есть строки `N-...`).
- `email` — логин Huckster (опционально, если задан `HUCKSTER_EMAIL` или `app_settings.huckster_email`).
- `password` — пароль Huckster (опционально, если задан `HUCKSTER_PASSWORD` или `app_settings.huckster_password`).
- `delay_ms` — пауза между страницами пагинации (мс, по умолчанию 270, не ниже 135). Размер страницы к e-teleport: repricer и unit — по 900 записей (на 10% ниже верхнего лимита API 1000).
- `max_offset_per_shop` — ограничение offset на магазин (`0` = без ограничения).
- `test_uids` / `uids` / `uid_list` — опциональный тестовый список UID/кодов (`["12461"]` или строка через запятую/пробел). В матрицу попадут только эти UID; пагинация по кабинету останавливается раньше, если все UID найдены. Тестовый запуск отдаёт результат в `sync-status`, но **не сохраняет** его как `latest` snapshot.

Ответ JSON при запуске: `{ "success": true, "started": true, "started_at": "..." }`.  
Если задача уже выполняется — `409` с кодом `ALREADY_RUNNING`.

### GET `/api/exports/huckster/sync-status`

Текущий статус фонового обновления Huckster (для polling в UI).

Ответ JSON (основные поля):

- `active` — выполняется ли обновление сейчас.
- `status_text` — текст текущего этапа (аутентификация / текущий магазин / завершение).
- `progress.total_shops`, `progress.done_shops` — шаги загрузки: **два прохода** по всем магазинам обоих наборов (`total_shops = 2 × число магазинов`). Сначала везде **Repricer** (`repricer/items/list`), затем везде **Unit-модели**; матрицы в ответе собираются только после обоих проходов.
- `progress.current_shop_name`, `progress.current_set` — текущий магазин и набор (`set1` / `set2`); `status_text` начинается с `Repricer —` или `Unit-модели —`.
- `result` — финальный результат (при успехе: `sheet_export.rows`, `sheet_export_rrc.rows`, `sheet_export_lost.rows`, `updated_at`, `sync_script`; для тестового запуска ещё `test_uids`).
- `sync_script` — текущая версия скрипта синка (см. `lib/hucksterSyncRevision.js`).
- `error` — объект ошибки (в том числе `HUCKSTER_STOPPED` после ручной остановки).

### POST `/api/exports/huckster/stop`

Запрашивает остановку активного обновления Huckster.

Ответ JSON: `{ "success": true, "stop_requested": true }`.  
Если активной задачи нет — `409` с кодом `NOT_RUNNING`.

Успешное завершение обновления дополнительно сохраняет матрицы в таблицу `huckster_matrix_snapshots` (строка `id=latest`, поле `payload_json` LONGTEXT).

### GET `/api/exports/huckster/snapshot`

Последнее успешное сохранение матриц (без запросов к e-teleport). Используется UI для автоподгрузки после обновления страницы.

Ответ JSON: `success`, `source: "snapshot"`, `empty` (boolean), `updated_at`, опционально `stored_at` (время записи в БД), `sheet_export` / `sheet_export_rrc` / `sheet_export_lost` — те же объекты, что в результате sync (`rows`, `total_uids` или `total_rows`, при новой bridge-схеме ещё `bridge_row_meta`, `matrix_kind`). Если сохранений ещё не было — `empty: true` и пустые `rows`.

### DELETE `/api/exports/huckster/snapshot`

Удаляет из БД последний сохранённый снапшот матриц (`DELETE FROM huckster_matrix_snapshots WHERE id='latest'`). Идемпотентно: если записи не было — успех. Сбрасывает в памяти процесса поле `result` у фонового статуса Huckster, чтобы `GET /sync-status` не отдавал устаревшие `sheet_export` после очистки. Требует авторизацию (как остальные методы под `/api/exports/huckster` после входа). На экране `/exports-huckster.html` вызывается из кнопки **«Очистить таблицы»** (после подтверждения).

Ответ JSON: `{ "success": true, "cleared": true }`.

### GET `/api/exports/huckster/config`

Возвращает текущие наборы магазинов `set1` / `set2` для Huckster и параметры фильтрации по цене МойСклад. На экране `/exports-huckster.html` в форме редактируются **оба** набора; тот же контракт доступен через этот API.

Ответ также содержит:

- `sync_script` — метаданные версии скрипта синка (`id`, `version`, `revision`, `matrix_kind`, `notes`); источник — `lib/hucksterSyncRevision.js`; бейдж на экране «Huckster» / «Обновление Huckster».

- `price_type_set_1`, `price_type_set_2` — выбранные типы цен МойСклад для **колонки** в матрице набора (не для отсечения строк на сервере);
- `ms_exclude_archived_bundles`, `ms_exclude_archived_products_zero_stock`, `ms_exclude_products_with_bundles` — текущие флаги фильтров МС для моста (см. описание матриц выше);
- `price_type_options` — совместимое поле, актуальный список загружается отдельным `GET /api/exports/huckster/price-types`, чтобы настройки кабинетов отрисовывались без ожидания сканирования карточек МойСклад.

### GET `/api/exports/huckster/price-types`

Возвращает список названий типов цен, найденных в сохранённых полных карточках МойСклад (`ms_entity_details.payload_json.salePrices`). Используется селектами **«Тип цены МойСклад»** в блоке **«Наборы»**.

### POST `/api/exports/huckster/ms-bridge-row-flags`

Только чтение **своей** БД (`ms_export`, при необходимости `ms_entity_details`): по списку кодов возвращает признаки для фильтра архива на экране **без** запроса к Huckster (e-teleport). UI вызывает после смены галочек «архив МС», чтобы перерисовать уже загруженный снапшот матрицы.

Body (JSON): `codes` — массив строк (коды из колонки **ID / КОД**), до **6000** уникальных значений.

Ответ: `{ "success": true, "flags": { "2187-100": { "archived_any": true, "archived_bundle": true, "archived_product_no_stock": false }, ... } }` — для кодов, найденных в `ms_export` (нет кода в ответе — строку матрицы не сужаем по архиву). Поле `archived_any` используется UI для бейджа «Архив» в колонке `ID / КОД`.

### POST `/api/exports/huckster/archive-filters`

Сохраняет в `app_settings` только флаги фильтра МС: `ms_exclude_archived_bundles`, `ms_exclude_archived_products_zero_stock`, `ms_exclude_products_with_bundles` (как при `POST /sync`, но без запуска синхронизации Huckster).

### POST `/api/exports/huckster/config`

Сохраняет наборы магазинов Huckster.

Body (JSON):

- `set1`: массив объектов `{ id, name, marketplace, shop_id }`
- `set2`: массив объектов `{ id, name, marketplace, shop_id }`
- `price_type_set_1`: опциональное название типа цены МойСклад для `Huckster Export`
- `price_type_set_2`: опциональное название типа цены МойСклад для `Huckster Export RRC`
- `ms_exclude_archived_bundles`, `ms_exclude_archived_products_zero_stock`, `ms_exclude_products_with_bundles` — опционально; при наличии в теле сохраняются в `app_settings` (как при `POST /sync`)

`marketplace` допускает только `ozon`, `wildberries`, `yandex`. Оба набора обязаны содержать хотя бы одну валидную строку. Панель при сохранении отправляет оба массива из формы. Если для набора выбран `price_type_set_*`, при следующей сборке Huckster-матрицы сервер оставит только строки, где в сохранённой полной карточке МойСклад значение выбранного типа цены больше `0`.

### POST `/api/exports/huckster/credentials`

Сохраняет в `app_settings` логин, пароль и параметры для Huckster (используются `POST /sync` без тела и планировщиком в `server.js`, если в теле sync не переданы `email` / `password`).

Body (JSON): `email`, `password` (обязательны), опционально `delay_ms` (не ниже 135), `max_offset_per_shop` (число, `0` = без ограничения).

## Продажи МС

Отдельная страница `/ms-sales.html` и роутер `routes/msSales.js`. Тянет из МС API
(`GET /entity/demand`) **отгрузки** за выбранный период (по умолчанию 30 дней),
сохраняет документы и позиции локально, **резолвит позиции до наших товаров**
(`ms_export.uuid` / `ms_export.code`) — т.е. содержимое каждой отгрузки сразу же
имеет двустороннюю связь с реестром товаров Datagon.

### Таблицы

- `ms_demand` — заголовки отгрузок. Тянется максимально полно — в БД сохраняем всё, что есть в карточке документа МС, плюс raw payload документа (для backfill будущих полей без обращения к МС API). Поля:
    - **Базовые:** `uuid PRIMARY KEY`, `doc_name`, `moment`, `applicable` (Проведено/Черновик), `sum_minor`, `positions_count`, `description` (Комментарий), `ms_created`, `ms_updated`, `fetched_at`, `updated_at`.
    - **Стороны документа:** `agent_uuid/name` (Контрагент), `store_uuid/name` (Склад), `organization_uuid/name` (Организация), `project_uuid/name` (Проект), `contract_uuid/name` (Договор), `sales_channel_uuid/name` (Канал продаж), `owner_uuid/name` (Ответственный), `group_uuid/name` (Отдел).
    - **Статус документа:** `state_uuid/name` (Стадия — «Новый» / «В работе» / …).
    - **Адрес доставки:** `shipment_address` (текстом) + `shipment_address_full` JSON (раскладка `postalCode/country/region/city/street/house/apartment/addInfo`).
    - **Деньги:** `currency_uuid`, `currency_name` (например, «руб»), `currency_iso_code` («RUB»), `currency_rate` (курс), `vat_enabled`, `vat_included`, `vat_sum_minor`, `payed_sum_minor` (Оплачено).
    - **Идентификаторы:** `code`, `external_code`, `sync_id`.
    - **Флаги:** `printed`, `published`.
    - **Кастомные атрибуты документа:** `attributes_json` JSON — массив `[{id, name, type, value}, …]`. Сюда попадают пользовательские атрибуты карточки документа («Номер отправления с озона», «Идентификатор чека» и любые другие, заведённые в шаблоне отгрузки в МС).
    - **Полный payload:** `payload_json` JSON — весь raw документ из МС API (минус `positions`, потому что они хранятся отдельно). Нужен для локального backfill новых колонок без повторной синхронизации в МС.
    - Индексы: `moment`, `agent_uuid`, `store_uuid`, `ms_updated`, `owner_uuid`. Суммы — в **минорных единицах (копейках)**, как в МС API.
- `ms_demand_position (id PK, demand_uuid, position_uuid, pack_idx, assortment_kind, assortment_uuid, product_uuid, ms_export_code, ms_export_uuid, ms_export_resolved, name_at_moment, code_at_moment, quantity, price_minor, discount, vat, sum_minor)` — позиции. UNIQUE на `(demand_uuid, position_uuid)`. Индексы: `demand_uuid`, `assortment_uuid`, `ms_export_code`, `product_uuid`, `ms_export_resolved`.
- Дополнительно при первом запуске роутера создаётся индекс `idx_ms_export_uuid` на `ms_export(uuid)` — нужен для быстрого резолва позиций.

После добавления новых полей в `ms_demand` (см. историю миграций) у уже загруженных отгрузок расширенные колонки = NULL — заполнятся при следующей синхронизации (`POST /api/ms-sales/sync`), потому что upsert идёт по `uuid` через `ON DUPLICATE KEY UPDATE` со всеми колонками.

**Резолв позиций до товаров** (две связи на позицию):

1. По `assortment_uuid` (uuid сущности из МС: product / bundle / variant / service / consignment).
2. По `product_uuid` — для variant'ов (родительский product). В `ms_export` хранятся product/bundle, варианты — отдельные сущности в МС, поэтому variant'ы резолвятся через product.

Если ни один из uuid не нашёлся в `ms_export` (товар удалён в МС, либо не относится к нашему ассортименту, либо это `service`) — пишется `ms_export_resolved=0`, `name_at_moment` / `code_at_moment` сохраняют срез на момент отгрузки.

### GET `/api/ms-sales/list`

Список отгрузок с пагинацией. Query:

- `days` — глубина периода в днях, default 30 (max 5 лет).
- `search` — **умный поиск**: подстрока по `ms_demand.doc_name` (номер отгрузки), `agent_name`, а также по товарам в позициях (`ms_export_code`, `code_at_moment`, `name_at_moment`, `ms_export.name`). Реализован через `OR` + `EXISTS`, чтобы не дублировать строки в выдаче.
- `doc_name` — фильтр по номеру документа (`ms_demand.doc_name`). По умолчанию подстрока (`LIKE '%X%'`); если в значении есть `%` или `_` — используется как готовый LIKE-паттерн.
- `store_uuid` — фильтр по складу.
- `agent_uuids` — фильтр по одному или нескольким контрагентам (CSV UUID; legacy: `agent_uuid`).
- `project_uuid` — фильтр по проекту (`ms_demand.project_uuid`).
- `applicable` — `1` (по умолчанию: только проведённые) | `0` (только черновики) | пусто (все).
- `deleted` — `0` (по умолчанию: только активные, без soft-deleted) | `1` (только помеченные удалёнными в МС) | `all` (без фильтра по `deleted_at`).
- `linked` — `all` (по умолчанию, без фильтра по привязке) | `1` (только отгрузки, у которых **все** позиции привязаны к `ms_export`) | `0` (только отгрузки, у которых **есть** хотя бы одна не привязанная позиция, бейдж «не привязано» в UI). Реализован через `EXISTS / NOT EXISTS` по `ms_demand_position.ms_export_resolved`, опирается на индекс `idx_resolved`.
- `stock_position` — `all` (по умолчанию) | `yes` (отгрузки, в которых **есть хотя бы одна** позиция с `ms_export.stock_position = «Да»` по коду `ms_export_code` / `code_at_moment`) | `no` (хотя бы одна позиция с товаром не «Да»). Через `EXISTS` по позициям + `ms_export`, без дублирования строк отгрузки.
- `limit` (1..500, default 100) / `offset` (default 0).
- `sort_by` — `moment|doc_name|agent|store|positions_count|sum`. Default `moment`.
- `sort_dir` — `asc|desc`. Default `desc`.

Ответ: `{ success, total, limit, offset, days, rows: [{ uuid, doc_name, moment, applicable, agent_uuid, agent_name, store_uuid, store_name, organization_name, project_uuid, project_name, positions_count, sum, fetched_at, deleted_at }] }`. `sum` — в рублях (с двумя знаками после запятой). `deleted_at` — ISO-строка момента, когда синк не нашёл документ в МС за тот же период (см. поведение `/sync` ниже), либо `null` для активных.

### GET `/api/ms-sales/filters?days=30`

Справочники для UI: `{ success, stores: [...], agents: [...], projects: [...] }`. Каждый элемент — `{ uuid, name, count }` (количество отгрузок за указанный период). `projects` — список проектов (`ms_demand.project_uuid` / `project_name`), отсортирован по `count DESC, name`.

### GET `/api/ms-sales/:uuid/positions`

Позиции одной отгрузки + JOIN с `ms_export` (актуальное имя/тип/остаток для отображения «текущего» состояния товара). Используется UI-разворачивающейся строкой.

Ответ: `{ success, demand: {...}, rows: [...] }`.

`demand` — расширенный объект, в котором отражены все поля карточки документа МС (см. таблицу `ms_demand` выше). В частности:

- идентификация: `uuid`, `doc_name`, `code`, `external_code`, `sync_id`, `moment`, `applicable`, `printed`, `published`, `ms_created`, `ms_updated`;
- стороны: `agent_uuid/name`, `store_uuid/name`, `organization_uuid/name`, `project_uuid/name`, `contract_uuid/name`, `sales_channel_uuid/name`, `owner_uuid/name`, `group_uuid/name`;
- статус: `state_uuid/name`;
- адрес: `shipment_address` (текст), `shipment_address_full` (object/null);
- деньги: `currency_uuid/name/iso_code/rate`, `vat_enabled`, `vat_included`, `vat_sum`, `payed_sum`, `sum`;
- комментарий: `description`;
- кастомные атрибуты документа: `attributes: [{ id, name, type, value }, …]` — «Номер отправления с озона», «Идентификатор чека» и любые другие.

`rows` — позиции (без изменений): `[{ position_uuid, pack_idx, assortment_kind, assortment_uuid, product_uuid, ms_export_code, ms_export_uuid, ms_export_resolved, ms_export_name, ms_export_type, ms_export_stock, ms_export_archived, name_at_moment, code_at_moment, quantity, price, discount, vat, sum }]`.

### GET `/api/ms-sales/by-product/:code?days=30&limit=100&offset=0`

Все отгрузки за период, в которых участвовал конкретный `code` из `ms_export`. Возвращает `{ success, code, days, positions, sum_qty, sum_amount, rows: [...] }`. Используется в карточке товара (тонкая ссылка из других страниц): «Этот товар отгружали 12 раз за 30 дней, всего 38 шт. на сумму 124 500 ₽».

### GET `/api/ms-sales/aggregates?days=30&only_resolved=1&limit=1000&offset=0`

Суммарные продажи по товарам за период (`SUM(quantity)`, `SUM(sum_minor)`, `COUNT(positions)`). По умолчанию `only_resolved=1` — учитываются только позиции с привязкой к `ms_export`. Этот эндпоинт станет источником данных для расчётных формул закупок (`suggested_min_stock`) — в будущей итерации.

### POST `/api/ms-sales/sync`

Запускает фоновую синхронизацию. Body: `{ days?: 30, fresh?: false }` (default `days=30` max 5 лет, `fresh=false`). Возвращает `409` если уже идёт другая синхронизация. Использует тот же `MS_TOKEN` (env / `config.msToken`), что и `routes/dimensions.js`; при отсутствии токена — `503`.

**Auto-resume и `fresh=true`.** По умолчанию (`fresh=false`, без `incremental`) перед запросами к МС API синк делает разведку по БД: `SELECT COUNT(*) AS cnt, MIN(moment) AS minM …`. Если `cnt > 0` и `minM` ощутимо позже, чем `momentFrom` (порог — 5 минут), синк переходит в **resume-режим** (добивание **начала** периода): `momentTo := minM + 5 минут`, `momentFrom` — начало окна. Это ускоряет повтор после обрыва полного прогона. `fresh=true` отключает resume — полный проход окна. UI: «Синхронизировать с МС» (`fresh=false`) и «Полный синк с нуля» (`fresh=true`).

**Инкремент (`incremental: true`)** — для автосинка `mssales`: `MAX(moment)` в БД за окно → запрос к МС с `momentFrom = max(начало окна, MAX − 1 сутки)` до `NOW`. Догружает **новые** отгрузки после последней даты в БД; head-resume по `MIN(moment)` при этом **не** используется. Пустая БД — как полный проход окна. `sync-status`: `incremental_mode`, `incremental_from_moment`.

**Soft-delete на resume/инкремент-проходе пропускается.** В resume- или incremental-режиме видна только часть периода — полная сверка `seenUuids` против всего окна пометила бы ложные удаления. Sync-status: `resume_mode` / `resume_from_moment` или `incremental_mode` / `incremental_from_moment`, `existing_count_at_start`.

**Резилиентность сетевых ошибок.** Запросы к МС API (`fetchDemandsPage`) идут через retry-обёртку с экспоненциальным backoff (4 попытки: `0/2/5/12` сек). На 3-й и 4-й попытках `limit` автоматически уменьшается (100 → 50 → 25), чтобы дать МС API шанс отдать страницу быстрее на больших offset'ах, где часто ловили `timeout of 60000ms exceeded`. Транзиентные ошибки (network/timeout, 408, 429, 5xx) ретраятся, фатальные (4xx кроме 408/429) пробрасываются как `last_error`. При исчерпании попыток главный цикл мягко прерывается (не `throw`), сохранённые отгрузки остаются в БД; повторный запуск синка идемпотентен — auto-resume подхватит ровно с места разрыва.

Под капотом — `GET /entity/demand` с расширенным `expand=agent,store,organization,project,contract,salesChannel,owner,group,state,rate.currency,positions.assortment,positions.assortment.product` и фильтром по `moment`, страницами по 100, дросселем 250 мс. Кастомные атрибуты документа (`attributes[]` — «Номер отправления с озона», «Идентификатор чека», и т. п.) приходят прямо в payload без expand и сохраняются в `ms_demand.attributes_json`. Полный raw payload документа (минус `positions`) сохраняется в `ms_demand.payload_json` — для последующего локального backfill, если в схему добавятся новые поля. Если `expand` не подтянул `positions.rows` — догружаются отдельным запросом `/entity/demand/{id}/positions`. Документы upsert'ятся (по `uuid`), позиции пересохраняются заново для каждого документа (DELETE + bulk INSERT по 500).

**Soft-delete (отгрузки, удалённые в МС).** МС API в `entity/demand` не возвращает удалённые документы. Чтобы наша БД не накапливала «фантомные» продажи, после каждого успешного прохода синка (`cancelRequested=false` И нет фатальных ошибок батчей И в выдаче что-то было) в окне `momentFrom..momentTo` сравниваются `ms_demand.uuid` против фактически увиденных в этом проходе UUID. Документам, которых нет в выдаче, ставится `ms_demand.deleted_at = NOW()`. Сами строки и связанные `ms_demand_position` **не удаляются** — они нужны для истории продаж и агрегатов. UPSERT в `persistDemand` сбрасывает `deleted_at = NULL`, поэтому если документ снова появился в МС — он автоматически «воскресает». В UI такие отгрузки помечены бейджем «Удалена из МС», подсвечены красным (`tr.dg-mss-deleted-row`) и по умолчанию скрыты фильтром `Удалённые в МС = Только активные`. Метрики прохода: `deleted_demands` (помечено в этот раз), `restored_demands` (вернулось из soft-delete) — попадают в `/api/ms-sales/sync-status`.

### POST `/api/ms-sales/sync-cancel`

Мягкая остановка фонового job-а (выставляет флаг — текущий батч добивается до конца).

### GET `/api/ms-sales/sync-status`

Статус job-а: `{ success, status: { …, resume_mode, resume_from_moment, incremental_mode, incremental_from_moment, existing_count_at_start } }`. UI поллит каждые 1.5 с пока `active=true`. `deleted_demands` / `restored_demands` см. раздел про soft-delete выше. В resume-/incremental-режиме `total_demands` — размер только запрошенного среза у МС, не всего окна (полное ≈ `existing_count_at_start + fetched_demands` только для resume).

### POST `/api/ms-sales/reresolve`

Перепривязка непривязанных позиций к `ms_export` — после полной синхронизации МС (когда в `ms_export` появляются новые товары, позиции под их uuid в `ms_demand_position` могут быть неразрешены). Один UPDATE с JOIN по `ms_export.uuid = COALESCE(assortment_uuid, product_uuid)`. Возвращает `{ success, affected, unresolved }`.

### Совместимость

- В матрице доступа (`lib/datagonPageRegistry.js`) — `pageKey: 'ms-sales'`, `htmlFile: 'ms-sales.html'`, `navSlug: 'ms-sales'`. API-префикс `/ms-sales` подчиняется тому же режиму (`hidden` / `view` / `full`); в режиме `view` POST-эндпоинты (`/sync`, `/sync-cancel`, `/reresolve`) автоматически блокируются.
- Меню: пункт «Продажи МС» в блоке МойСклад — после «Заказы в МС» (не подменю «Маркетплейсы»).
- Фронтенд: `static-html/vanilla/inners/ms-sales.{head,inner,scripts}.html` — две карточки (фильтры + таблица отгрузок с разворачивающимися позициями), поиск-зеркало в шапке таблицы.

## Заказы в МС

Страница `/ms-orders.html`, роутер `routes/msOrders.js`. Заказы покупателей (`GET /entity/customerorder`) за период **`ms_orders_sync_days`** (настройки, 1..365, default **30**). Заказы с ответственными из **`ms_orders_exclude_owner_names`** (настройки) не синкаются и не показываются.

### Таблицы

- `ms_customer_order` — заголовки: `moment`, `agent_*`, `store_*`, `organization_*`, `project_*`, `state_*`, `owner_*`, `sum_minor`, `payed_sum_minor`, `shipped_sum_minor`, `positions_count`, `payload_json`, `deleted_at`.
- `ms_customer_order_position` — позиции с резолвом до `ms_export` (как у продаж МС).
- `ms_export_stock_by_store` — остатки по `(code, store_uuid)` из **`report/stock/bystore`** при полном синке МойСклад (для колонки «Статус» / «Позиций на складе» на заказах).

### Настройки

- **`ms_orders_sync_days`** — окно синхронизации и списка (дней, 1..365, default **30**). Карточка на `/settings.html` → «Заказы в МС».
- **`ms_orders_exclude_owner_names`** — строка: имена владельцев-сотрудников через перевод строки или запятую (default **`Новикова И.`**). Сопоставление без учёта регистра, по подстроке. Карточка на `/settings.html` → «Заказы в МС».

### GET `/api/ms-orders/config`

`{ success, sync_days, max_days }` — текущий лимит периода из `ms_orders_sync_days` (для UI `/ms-orders.html`).

### GET `/api/ms-orders/list`

Query: `days` (max = **`ms_orders_sync_days`**), `search` (умный поиск: **номер заказа** `doc_name`, **контрагент** `agent_name` или код/наименование товара в позициях), `doc_name`, `store_uuids` (CSV UUID, несколько складов; legacy: `store_uuid`), `agent_uuids` (CSV UUID, несколько контрагентов; legacy: `agent_uuid`), `project_uuids` (CSV UUID, несколько проектов; legacy: `project_uuid`), `applicable` или `applicable_values` (`0` / `1` через запятую; одно значение — фильтр, оба или пусто — все), `pay_statuses` (`paid` | `partial` | `none`; по умолчанию на UI — только `paid`), `ship_statuses` (`shipped` | `partial` | `none`; по умолчанию на UI — все), `stock_statuses` (`all` | `partial` | `none` | `none_pending` — статус остатков по позициям; по умолчанию на UI — все), `deleted`, `limit`, `offset`, `sort_by` (`moment|doc_name|agent|store|owner|positions_count|stock_ok|stock_status|sum|payed|shipped`), `sort_dir`.

Если задан **`search`** или **`doc_name`**, фильтры **`pay_statuses`**, **`ship_statuses`** и **`stock_statuses`** **не применяются** (чтобы предустановленные «Оплачено» / «Отгружено» не скрывали найденный заказ). В ответе: `search_relaxed_filters: true`. Фильтры склада, контрагента, проекта, «Проведённые» и «Удалённые» по-прежнему действуют.

Ответ `rows[]`: базовые поля как у продаж МС + **`payed_sum`**, **`shipped_sum`**, **`owner_name`**, **`payed_pct`**, **`shipped_pct`**, **`stock_ok_count`** / **`stock_pending_count`** (позиции с достаточным остатком **на складе заказа** `store_uuid` из `ms_export_stock_by_store`; если у заказа склад не задан — суммарный `ms_export.stock`), **`stock_status`** (`нет на складе` | `частично на складе` | `все на складе` | `—` если нечего отгружать) (рубли и проценты от суммы).

### GET `/api/ms-orders/data-freshness`

Сводка актуальности для блока на `/ms-orders.html` (формат как `GET /api/suppliers/data-freshness`): `{ success, as_of_msk, sources[] }`.

Источники:
- **`ms_orders`** — импорт `customerorder` (ручной синк; `MAX(fetched_at/updated_at)` по `ms_customer_order`, статус job при активном синке).
- **`moysklad`** — каталог и остатки `ms_export` (для колонки «Позиций на складе»; те же данные, что на `/suppliers.html`).

Статус **`ok`** = обновление сегодня по МСК, **`stale`** = устарело, **`running`** = синк идёт.

### GET `/api/ms-orders/filters?days=30`

Справочники складов/контрагентов/проектов (с учётом исключённых ответственных).

### GET `/api/ms-orders/:uuid/positions`

`{ success, order, positions[] }` — в каждой позиции: `code`, `name`, `quantity`, **`shipped`** (отгружено из МС, поле `shipped` позиции заказа), `price`, `sum`, `resolved`, `stock`.

### POST `/api/ms-orders/sync`

Body: `{ days }` (max = **`ms_orders_sync_days`**; если не передано — используется значение из настроек). Фоновый импорт из МС: сначала **лёгкий list** без `positions`, затем детали (`GET /entity/customerorder/{id}` с expand позиций) **только** для заказов, не попавших под исключение ответственных (`ms_orders_exclude_owner_names`). Заказы исключённых считаются в `skipped_excluded`, но позиции для них не запрашиваются.

### GET `/api/ms-orders/sync-status` · POST `/api/ms-orders/sync-cancel`

Статус и остановка фонового job (как у продаж МС). В `status`: `fetched_orders` / `total_orders` (прогресс обхода list в МС), `saved_orders` (записано в БД), `saved_positions`, `skipped_excluded`.

### Доступ

`pageKey: 'ms-orders'`, API-префикс `/ms-orders`. Пункт меню «Заказы в МС» — после «Мой Склад (товары)», перед «Продажи МС».

## Медмаркет

Страница `/medmarket.html`, роутер `routes/medmarket.js`. Матрица: **`medmarket`**. Канон связки: `код+Тип` (напр. `10088+Товар`) в `ms_export.medmarket_product_code`. Сценарий UI: [Медмаркет](/docs/medmarket/).

| Метод | Путь | Назначение |
|-------|------|------------|
| GET | `/api/medmarket` | Список по фильтрам query (как UI) |
| GET | `/api/medmarket/sync-status` | Статус импорта атрибута |
| POST | `/api/medmarket/sync` | Подтянуть атрибут из `ms_entity_details` → `ms_export` |
| PATCH | `/api/medmarket/mapping` | Правка одной связки |
| POST | `/api/medmarket/import` | Массовый import `rows[]` |
| POST | `/api/medmarket/fill-linkage-codes` | Запись код+тип в МС; `dry_run=1` — preflight со счётчиками |

Автосинк: `medmarket` (импорт, вс) / `medmarket_fill` (запись в МС, пн–сб) — см. Settings / `auto_sync_medmarket_*`.

## Глобальная синхронизация (server.js)

### POST `/api/sync-all-start`
Фоновый запуск синхронизации всех `my_sites` (глобальный маршрут в `server.js`).

### POST `/api/sync-site-start`

Фоновый запуск синхронизации **одного** источника. Body: `{ "site_id": <число> }`.

### GET `/api/sync-status`
Статус глобальной синхронизации.

## Обзор процессов

Маршрут в `server.js`.

### GET `/api/processes/overview`

Сводка для экранов «Дашборд» / «Логи»: глобальный синк, МойСклад, авто-синки, discover, очередь `pages`, матчинг по `my_site_id`, метрики runtime и размер базы данных.

Параметры query:

- `my_site_id` — опционально, фильтр блока матчинга;
- `for_date` — опционально, **календарный день в МСК** (`YYYY-MM-DD`). По умолчанию — сегодня. Допустимые значения: последние **14 дней** включая сегодня. Значения за пределами окна молча прижимаются к сегодня.

Поле `for_date` влияет на три блока:

- **`moyskladPersistedLogs`** — все строки `dg_ms_sync_log` за выбранный день в МСК. Упорядочены по `id DESC` — самые свежие шаги синхронизации идут **первыми**, чтобы UI не заставлял пользователя листать журнал вниз. Реализация: `fetchMsSyncPersistedLogsForDate(db, forDate)` в `routes/moysklad.js`.
- **`autoSyncRuns`** — записи `auto_sync_runs`, чей `started_at` приходится на выбранный день в МСК. Фронт группирует их по `task_type` и рисует по секциям из `autoSync.sections` (см. ниже). Чтобы добавить новую секцию — добавляйте задачу в `lib/datagonAutoSyncRegistry.js → AUTO_SYNC_TASKS` (правило `datagon-auto-sync-registry.mdc`). На `/processes.html` у каждой строки есть кнопка **«Лог»**: полный текст `message` из БД; для **`dimensions`** дополнительно запрашиваются строки журнала габаритов с `action=sync_ms_error` за интервал `started_at`…`finished_at` (см. `GET /api/exports/dimensions/log/global`).
- **`autoSync.sections`** — массив `{ key, title, subtitle, enabled, time, extras: [{ key, label, value }] }`, построен `buildAutoSyncSectionsSnapshot(appSettings)` из `lib/datagonAutoSyncRegistry.js`. Используется фронтом `processes.scripts.html` (`renderAutoSyncSections`), чтобы держать набор задач в `/settings.html` ↔ `/processes.html` синхронным без ручной правки UI при добавлении новой автосинки. Поле `autoSync.config` оставлено для обратной совместимости (legacy фронт без `sections`).
- **`autoSync.tasks_live`** — объект «по ключу задачи» (`myproducts`, `moysklad`, `marketplaces`, `huckster`, `db_size`, `dimensions`, `mssales`, `mssales_full`): снимок **только** для типов, у которых в этот момент есть незавершённая строка `auto_sync_runs` в памяти сервера (`autoSyncRunIds`), чтобы не путать с ручными синками. Поля зависят от задачи: для **`dimensions`** — тот же payload, что `getScheduledSyncState()` в `routes/dimensions.js` (`processed`, `total`, `ok`, `err`, …); для **`myproducts`** / **`moysklad`** — `processed`/`total`/`message` из глобального `syncState` и `getJobState()`; для **`marketplaces`** — `message` + сводка по Ozon/WB/Я.Маркет; для **`huckster`** — `status_text`, `progress` (магазины), `stop_requested`; для **`db_size`** — текстовая стадия пересчёта; для **`mssales`** / **`mssales_full`** — метрики из `routes/msSales.js → getSyncState()` (отгрузки, позиции, `days`, `message`). Фронт `/processes.html` подмешивает строку «Сейчас: …» к записи со статусом `running`.
- **`autoSync.running_tasks`** — массив тех же ключей задач, что и ключи `tasks_live` (типы с открытым `auto_sync_runs`); дублирует «что сейчас выполняется» в компактном виде для строки «Исполнитель» на `/processes.html`.
- **`autoSync.queue`** — FIFO очередь **ожидающих** задач: элементы `{ type, triggerType }`. Текущая выполняющаяся задача **не** входит в этот массив (она уже извлечена из очереди циклом воркера). Пока воркер занят, новые срабатывания по расписанию **добавляются в хвост** (`enqueueAutoSyncTask`); после завершения текущей задачи воркер сам снова вызывает `processAutoSyncQueue` и берёт следующий элемент. Один и тот же `type` не дублируется в очереди и не стартует параллельно второй раз (`already_queued` / `already_running` в ручном API). Планировщик раз в 30 с сравнивает МСК `HH:MM` с настройками и для каждого типа не чаще **одного раза на календарный день и слот** (`autoSyncLastRunByTask`), чтобы не плодить повторы в ту же минуту.
- **`matches`** — последняя задача `matching_jobs` для `my_site_id`, чей `started_at` приходится на выбранный день в МСК. Если задач за день не было — `matches.message` = «За выбранный день задач сопоставления не было».
- **`moysklad.logs`** (in-memory `jobState.logs`, до 30 строк текущей сессии) — отдаются только за «сегодня»; для других дней массив пустой, так как память процесса не различает даты.

Дополнительные поля ответа: `forDate` (фактически применённая дата), `forDateOptions` (массив из 14 допустимых дат, новейшая первая), `moscowToday`, `isToday`.

Размер базы считается через `information_schema.TABLES` и кэшируется на 5 минут.

### GET `/api/processes/db-size`

Размер текущей MySQL-базы: общий объём, данные, индексы, число таблиц, время расчёта и признак кэша. Без параметров отдаёт суточный кэш; `?refresh=1` принудительно пересчитывает показатель для кнопки «Обновить размер БД» на дашборде.

### GET `/api/processes/disk-usage`

Используется виджетом «Дисковое пространство» на дашборде (`/dashboard.html`). Матрица API: ключ **`dashboard`** (как `GET /db-size`). Принудительный пересчёт также выполняется в составе ежедневной фоновой задачи `db_size` (галка «Размер БД и диска» в `/settings.html` → раздел «Авто-синхронизация»; одна задача `auto_sync_runs.task_type = 'db_size'` обновляет и размер БД, и разбивку диска). Возвращает:

- `projectPath` — абсолютный путь к корню проекта (`__dirname` сервера);
- `projectSizeBytes`, `projectFileCount`, `rootFilesBytes`, `rootFilesCount` — суммарный размер всех каталогов проекта, общее число файлов и размер/количество файлов в самом корне;
- `folders` — массив верхнеуровневых каталогов (включая `.git`, `node_modules`, `vendor`, `docs-docusaurus` и т.д.), отсортированный по убыванию размера. Каждый элемент: `{ name, isHidden, sizeBytes, fileCount, dirCount, errorCount }`. `errorCount` показывает, сколько файлов не удалось прочитать (нет доступа) — отражается badge «нет доступа: N» на UI;
- `fileSystem` — объём ФС, в которой лежит проект, через `fs.statfs`: `{ sizeBytes, freeBytes, usedBytes, usedPercent }` (или `{ error }`, если `fs.statfs` недоступен в текущей версии Node);
- `scanDurationMs`, `scannedAt`, `ttlSec`, `cached` — диагностика и признак кэша.

Кэш — 5 минут (`DISK_USAGE_CACHE_TTL_MS` в `server.js`); параллельные запросы дедуплицируются через общее `in-flight` обещание. `?refresh=1` принудительно пересчитывает разбивку. Обход дерева использует `fs.readdir` + `fs.lstat`, не следует по симлинкам и устойчив к `EACCES`.

## Таблицы менеджеров

Страница `/manager-sales.html`, роутер `routes/managerSales.js`, расчёт `lib/managerSalesCalc.js`. Матрица: ключ **`manager-sales`**.

- **`view`** — только **свои** строки (и переданные вам), только чтение (GET).
- **`full`** — запись в **свою** таблицу (импорт CSV тоже только себе).
- Чужие таблицы (`can_pick_manager`) — специальности **Полный доступ**, **Бухгалтерия**, **Делопроизводители** и `admin`. В переключателе только группа **Менеджер по продажам**. Query `manager_user_id` для остальных игнорируется.
- Строки не удаляются физически: `DELETE /api/manager-sales/:id` ставит `archived_at`. `POST /:id/restore` снимает архив. Query `archived=0|1|all` (по умолчанию активные).
- Журнал: `GET /api/manager-sales/:id/log` (`field`, `limit`, `offset`). Таблица `dg_manager_sales_log`.
- Передача: `POST /api/manager-sales/:id/hand-over` `{ manager_user_id }`. Строка владельца остаётся у него и **появляется** у получателя (месяц = `paid_at`). У принимающего может быть **своя** строка с тем же № счёта — это не ошибка. У владельца суммы переданной строки в UI нули и не входят в `totals`; у получателя `amount_*` этой строки прибавляются. `0` — снять. `GET /meta` `managers` — отдел продаж. В списке колонка **Менеджер** — владелец строки.
- Подсветка **№ нашего счета**: `PATCH` поле `our_invoice_mark` (`green` / пусто). Зелёный — создан заказ покупателя + счёт + входящий платёж. Клик по номеру в таблице включает или снимает отметку.
- Подсветка **ссылки на счёт поставщика**: на **каждую** закупку отдельно в `suppliers[].invoice_mark` (`black` / `blue` / `orange` / `green` / пусто). `PATCH` `{ invoice_mark, supplier_index }`. Клик по ссылке в таблице открывает выбор цвета для этой строки закупки.
- Комментарии к строке: таблица **`dg_manager_sales_comments`**. В `GET /api/manager-sales` у каждой строки массив `comments` (новые сверху). `POST /:id/comments` `{ body }` — добавить; `PATCH` / `DELETE /:id/comments/:commentId` — править или удалить **только свой**. В UI колонка сразу после «Ссылка на счет поставщика»; формат «Имя Ф. — ДД.ММ.ГГГГ — текст».
- **Отправка вместе:** поле `ship_group_id` у строки. Одинаковый id = одна отправка. В списке у строки `ship_group_mates: [{ id, our_invoice_no, row_no, manager_user_id, manager_name, year }]`, `ship_group_size`. `POST /:id/ship-group` `{ our_invoice_no }` (или `mate_row_id`) — связать с другой строкой того же года; при разных группах — merge. `DELETE /:id/ship-group` — выйти из связки (если осталась одна — у неё id тоже снимается). Query списка: `ship_together=1|0`, `ship_group_id=<id>`. Поиск находит и № счетов «соседей» по группе.

Таблица **`dg_manager_sales_rows`**. Год строки — явное поле `year` (вкладки Google 2019–2026). Формулы при каждом save:

- `diff` = `((F−K) − F×G/(G+100)) × (1 − 16/100) − L` (налог 16% как «Системный»!A1; F сумма без доставки, K сумма закупок по поставщикам, G НДС %, L сумма доставок до нас)
- `pct_r` = `diff / (F/100)`
- `pct_mp` считается **по месяцу**, не из ячейки: сумма F активных строк менеджера за `MONTH(paid_at)` vs план. Ступени периода хранятся в `dg_manager_sales_plans.steps_json` у строки года `(0, year, 0)` (дефолт как в Google: 500k→0 … 3.3M→10, иначе 12). Если план менеджера/месяца меньше последнего порога, ступени масштабируются (`план / max порога`). Приоритет суммы: `(manager, year, month)` → `(manager, year, 0)` → `(0, year, 0)` → `(0,0,0)` запасной 3 300 000. Пороги берутся с ближайшего предка, у которого задан `steps_json`.
- `bonus` = `diff / 100 * pct_mp`

### GET `/api/manager-sales/meta`

`{ success, year, years, managers: [{ id, username, full_name }], statuses: ["Заказан у поставщика","Отгружен","Частично отгружен","Возврат средств"], invoice_marks: [{ key, title, label }], can_write, can_pick_manager, actor_user_id, actor_full_name, actor_username, formulas }`. `managers` — группа **Менеджер по продажам** (и для передачи заказа). `years` — годы своих строк и строк, переданных себе.

### GET `/api/manager-sales`

Query: `year`, `month` (1–12; без параметра — все месяцы по `paid_at`; при выбранном месяце в выдачу входят и строки **без** `paid_at` — черновики), `manager_user_id` (`all` или id; для всех, кроме Полный доступ / Бухгалтерия / Делопроизводители / admin, игнорируется — всегда свой), `search`, `status` (`Заказан у поставщика` / `Отгружен` / `Частично отгружен` / `Возврат средств`), `supplier`, `has_contract` (`Обычный договор` / `Нет` / `Договор-Счет`; устаревшие `0`/`1` ещё принимаются), `invoice_org` (`Альмамед` / `Вилмед` / `ИП`; устаревшие `ip`/`ooo` ещё принимаются), `archived` (`0`/`1`/`all`), `ship_together` (`1` — только со связкой, `0` — без), `ship_group_id` (точная группа), `limit`/`offset` (default limit **100**, max **500**), `sort_by`/`sort_dir`. Страница `/manager-sales.html` после «Применить» пишет те же параметры в адрес (месяц «все» = `month=all`), чтобы ссылку можно было скопировать.

Ответ: `{ success, total, rows, totals, plan, can_write, can_pick_manager, can_edit_plans, year, month, limit, offset }`. `totals` — суммы по **всему** фильтру; `bonus` пересчитан от % МП. месяца. `plan` заполнен, если выбран один менеджер и месяц: `{ plan_amount, source, note, month_total, pct_mp, steps }`.

### GET `/api/manager-sales/plans`

Query: `year`. `{ success, can_edit, year, fallback, year_base: { plan_amount|null, inherited, note, steps: { steps:[[max,pct],…], pct_max }, steps_custom }, managers: [{ id, year_plan, inherited, months[] }], steps }` — `steps` в корне: ступени, уже масштабированные к плану года. `can_edit` = true только для admin / Полный доступ / Бухгалтерия (как PUT); делопроизводители и менеджеры — просмотр. Писать планы — те же роли.

### PUT `/api/manager-sales/plans/base`

Body: `{ year, plan_amount, steps? }`. План **этого года** для всех (`manager_user_id=0`, `month=0`). Пустой `plan_amount` снимает план года, если нет `steps` (остаётся запасной 3 300 000). `steps`: `{ steps: [[max, pct], …], pct_max }`.

### PUT `/api/manager-sales/plans/matrix`

Body: `{ year, year_base, steps?, managers: [{ manager_user_id, year_plan, months: [{ month, plan_amount, note }] }] }`. Пустая сумма = наследование. `steps` пишутся на `(0, year, 0)`. После записи пересчитывается % МП. года.

### PUT `/api/manager-sales/plans/month`

Body: `{ manager_user_id, year, month, plan_amount, note }`. Точечная правка месяца.

### POST `/api/manager-sales`

Создать строку. Body: поля журнала + `year`, опционально `month` (1–12 — следующий № в этом месяце по дате оплаты; иначе среди черновиков без даты), опционально `manager_user_id` (только Полный доступ / Бухгалтерия / Делопроизводители / admin). `row_no` выдаёт система; одинаковый **№ нашего счёта** в месяце получает тот же порядковый № (позиции НДС). `status` нормализуется к фиксированному списку.

### PATCH `/api/manager-sales/:id`

Частичное обновление; пересчёт `diff` / `pct_r` / `pct_mp` (месяц) / `bonus`. Поля `row_no` и `pct_mp` с клиента игнорируются. `our_invoice_mark`: `green` | `""` (снять). `invoice_mark`: `black` | `blue` | `orange` | `green` | `""` (снять). Несколько поставщиков на строку: `suppliers[]` или `supplier_index` + поля суммы/доставки/имени/№/ссылки; `supplier_add=1` — ещё одна закупка; `supplier_remove` — индекс. `amount_incl_stock` и `delivery_to_us` в расчёте — суммы по закупкам.

### DELETE `/api/manager-sales/:id`

Перенос в архив (`archived_at`), без удаления строки.

### POST `/api/manager-sales/:id/restore`

Вернуть из архива.

### POST `/api/manager-sales/:id/hand-over`

Body `{ manager_user_id }`. Строка появляется в таблице этого менеджера в месяце даты оплаты. `0` — вернуть только владельцу. Писать может владелец или `can_pick_manager`.

### GET `/api/manager-sales/:id/log`

Журнал поля: `{ rows: [{ field, field_label, old_value, new_value, action, note, changed_by_name, changed_at }], total, limit, offset }`. Query `field` — одно поле; для `supplier_invoice_url` отдаются также записи `invoice_mark` (смена/снятие цвета подсветки, в т.ч. по каждому поставщику); для `our_invoice_no` — ещё `our_invoice_mark`.

### POST `/api/manager-sales/:id/comments`

Body `{ body }` (до 2000 символов). Добавляет комментарий к строке. Ответ: `{ success, comment, row }` — `row.comments` уже с новым сверху. Писать может тот, кто может править строку (`canTouchRow`).

### PATCH `/api/manager-sales/:id/comments/:commentId`

Body `{ body }`. Редактировать можно только свой комментарий (`author_user_id` = текущий пользователь). Ответ: `{ success, comment, row }`.

### DELETE `/api/manager-sales/:id/comments/:commentId`

Удалить можно только свой комментарий. Ответ: `{ success, deleted, row }`.

### POST `/api/manager-sales/:id/ship-group`

Body `{ our_invoice_no }` или `{ mate_row_id }`. Связывает текущую строку с другой **активной** строкой того же `year` (доступной для записи). Ответ: `{ success, row }` с обновлёнными `ship_group_id` / `ship_group_mates`. При нескольких совпадениях по № счёта — `409` и `matches[]`.

### DELETE `/api/manager-sales/:id/ship-group`

Выйти из связки. Если в группе осталась одна строка — у неё `ship_group_id` тоже очищается. Ответ: `{ success, row }`.

### POST `/api/manager-sales/import-csv`

Body: `{ csv, year, manager_user_id?, dry_run? }`. Заголовки как в Google-таблице. `dry_run=1` — счётчики без записи (`would_update`, `skipped`, `errors[]`, `duration_sec`).

### GET `/api/manager-sales/export.csv`

CSV UTF-8 с BOM по текущему фильтру.

### GET `/api/manager-sales/supplier-hints`

Подсказки поставщика (`q`). Сценарий UI: [Таблицы менеджеров](/docs/manager-sales).

## Операционный лист

Страница `/ops-sheet.html`, роутер `routes/opsSheet.js`, формулы `lib/opsSheetCalc.js`. Матрица: ключ **`ops-sheet`**. Адрес после «Применить»: `year`, `month` (`all` или 1–12) либо `months=1,3,5` (мультивыбор периода Planfix), `search`, `q` / `page` (таблица задач), `jump` (прокрутка к месяцу в листе).

- Полный свод по **всем** менеджерам специальности «Менеджер по продажам» для любого, у кого страница не `hidden` (без ограничения «только своя таблица»).
- Режим **`view`** — только чтение; **`full`** — правка ручных ячеек (`PUT /manual`) и синк/маппинг Planfix.
- Auto-метрики из `dg_manager_sales_rows` (credit = `COALESCE(handed_to_user_id, manager_user_id)`, `archived_at IS NULL`, месяц из `paid_at`) и планов `dg_manager_sales_plans`.
- Ручные поля в `dg_ops_sheet_manual`: `bonus_past` (+ флаг `bonus_past_manual`), `salary` (поле `coefficient` в БД остаётся, в UI колонки нет).
- **С октября 2026** (`ops_auto_from: { year: 2026, month: 10 }`): `bonus_current` = `SUM(diff)×%МП` по credit-менеджеру за месяц — **все** продажи (отгруженные и нет, включая переданные от других). `bonus_past` по умолчанию = SUM(`bonus`) всех отгрузок месяца (`shipped_at` в месяце листа, статус Отгружен/Частично): и с `paid_at` в прошлых месяцах, и в текущем. В ответе: `bonus_past_from_past` / `bonus_past_from_current`. Ручной ввод — `bonus_past_manual=1`; очистка → авто. До октября 2026 — архив.
- **Кол-во заявок** (`applications_local`) — auto из локального снимка `dg_ops_planfix_tasks`: постановщик = менеджер продаж, месяц = дата создания (`Europe/Moscow`). Считаются **все** статусы, кроме: Товар получен, Заказан товар у поставщика, Поставщик, Информационное письмо, Подбор по Т.з., клиент отказался - мониторинг цен - ГБУЗ (и пустых/разделителей). Список исключений — `APP_COUNT_EXCLUDED_STATUSES` в `lib/opsSheetPlanfix.js`.
- **Кол-во заявок (с Гугла)** (`applications_count`) — импорт цифр из Google операционного листа (колонка «Кол-во заявок») в `dg_ops_sheet_manual.applications_count` (`scripts/maintenance/import-ops-sheet-google-apps.js`).
- **Отношение продаж к заявкам** (`apps_per_sale_local`) — `applications_local / paid_applications`.
- **Отношение продаж к заявкам (с Гугла)** (`apps_per_sale`) — `applications_count / paid_applications`.
- **Оплаченные заявки** — auto: число продаж credit-менеджера за месяц (`paid_at`, не архив): один **№ нашего счёта** = одна продажа (позиции НДС не удваивают счётчик); строка без номера счёта считается отдельно. Это не корзина Planfix «оплаченная».
- UI: год → 12 блоков месяцев (строки менеджеров + ИТОГО). Сценарий: [Операционный лист](/docs/ops-sheet). Синк: `lib/opsSheetPlanfixSyncRevision.js`, поле `sync_script`.

### GET `/api/ops-sheet/meta`

Годы, список менеджеров, `can_write`, легенда колонок / формулы, `planfix_configured`, `status_buckets`, `sync_script`.

### GET `/api/ops-sheet`

Query: `year` (по умолчанию текущий). Ответ: `months[{ month, label, rows, totals, ops_auto_era }]`, `managers` (включая **архивных** менеджеров продаж), `can_write`, `planfix_unmatched`, `ops_auto_from`. В строке менеджера дополнительно: `bonus_past_auto`, `bonus_past_is_manual`, `bonus_past_source` (`auto`|`manual`|`archive`), `bonus_past_orders_count`, `ops_auto_era`. На `/ops-sheet.html` строка скрыта, если все суммы / заявки / оплаты / ручные поля нули или пустые. У архивного в ФИО пометка «(архив)». Синк Planfix по-прежнему берёт только неархивных постановщиков. У строки менеджера — стрелка: разворот статусов заявок (`GET /manager-app-statuses`).

### GET `/api/ops-sheet/manager-app-statuses`

Query: `year`, `month` (1–12), `manager_user_id`. Разбивка задач Planfix постановщика за месяц по `status_value`: `statuses[{ status_value, n, excluded }]`, `included_total` (входит в «Кол-во заявок*»), `excluded_total` (серые / «не вошло»), `all_total`. Исключения — `APP_COUNT_EXCLUDED_STATUSES` (опечатка Planfix «мориторинг» → «мониторинг» при сравнении; `\b` для кириллицы не используется).

В строке: `turnover`, `profit_before_tax`, `profit_after_tax`, `profit_pct`, `bonus_current`, `applications_local` (локальные задачи), `applications_count` (с Гугла / галка), ручные поля, `apps_per_sale_local`, `apps_per_sale` (с Гугла), `avg_check`, `fact_profit`, `salary_paid`, `company_profit`, `company_pct`, `plan_amount`, `plan_status` (`выполнен` / `не выполнен`).

### PUT `/api/ops-sheet/manual`

Body: `year`, `month`, `manager_user_id` + `bonus_past` / `salary`. Только `full`. Для `bonus_past` в авто-эре: число → ручной override (`bonus_past_manual=1`); `null`/пусто → сброс к авто. Ответ: пересчитанная `row` (+ `bonus_past_auto`, `bonus_past_is_manual`, `bonus_past_orders_count`) + `totals` месяца.

### GET `/api/ops-sheet/bonus-past-orders`

Query: `year`, `month`, `manager_user_id`. Список заказов, входящих в авто-расчёт «Премия с учетом заказов с прошлых месяцев» (отгрузка в месяце, оплата раньше). Ответ: `orders[]`, `total_bonus`, `orders_count`, `ops_auto_era`, `bonus_past_manual` / `bonus_past_override`.

### GET `/api/ops-sheet/planfix`

Query: `year`, `month` (`0` = весь год, `1–12` = месяц) и/или `months` (список `1,3,5` / JSON-массив — несколько месяцев; приоритет у `months`). При нескольких месяцах «В отчёте Planfix» = **сумма помесячных снимков** (если все есть), не срез годового сейва по датам. Локальная панель статусов **за период**: `statuses[]` (`status_value`, `tasks_n` / `tasks_in_year` — заявки листа: постановщик=менеджер продаж, без фильтра шаблона КП; `managers[]` — разворот по постановщику `{ name, tasks_n, tasks_n_report }`; `bucket`, `suggested_bucket`, `count_in_apps`, `mapped`), `buckets`, `unmatched_assigners`, `local_total`, `empty_status`, `with_status`, `period`, `last_synced_at`, `sync_script`. Поля `tasks_n_report` / `report_total` / `report_meta` — гистограмма отчёта.

### GET `/api/ops-sheet/planfix-tasks`

Query: `year`, `month` и/или `months` (как у панели), `q` (номер / постановщик / статус), `page`, `limit` (по умолчанию 100, макс. 200). Строки из `dg_ops_planfix_tasks` за период: `rows[]` (`task_id`, `assigner_name`, `status_value`, `created_at`, `synced_at`), `account` (для ссылки `https://{account}.planfix.ru/task/{id}`), `total`, `pages`, `shown`, `empty_status`, `with_status`.

### GET `/api/ops-sheet/planfix-sync-status`

Живой этап текущего синка: `{ active, stage, message, pages, fetched, stored, assigners_matched, unmatched_managers[], elapsed_sec, dry_run, year, last_error, cancel_requested, sync_script }`. `fetched`/`stored` — **уникальные** `task_id`. UI опрашивает раз в секунду после `started: true` (и при 409). `stage: cancelled` — остановлен кнопкой.

### GET `/api/ops-sheet/planfix-assigners`

Preflight матча «Менеджер по продажам» ↔ Planfix `/user/list` **без** выгрузки задач. Ответ: `assigners_matched`, `assigner_names`, `unmatched_managers[{ id, full_name, username }]`, `pf_users`, `managers_total`, `sync_script`.

### POST `/api/ops-sheet/planfix-sync-cancel`

Только `full`. Мягкая остановка: `cancel_requested`, синк выходит между страницами `/task/list` и ожиданиями generate (до ~0,4 с, не рвёт текущий HTTP к Planfix). Ответ `{ success, cancelled, …planfix-sync-status }`. Если синка нет — `cancelled: false`. Кнопка **Остановить** на `/ops-sheet.html` видна, пока `active`.

### POST `/api/ops-sheet/planfix-sync`

Только `full`. Body: `{ year, month?, months?, report_only? }`. `months` — массив или строка `1,3,5` (несколько месяцев; синк заявок помесячно в одной задаче). Без `months` — как раньше один `month` (`0` = весь год). При `months.length > 1` отчёт 450694 — один generate (`reportMonth=0`). Ответ сразу `{ success: true, started: true, …planfix-sync-status }` — работа **в фоне**. UI опрашивает `GET /planfix-sync-status` до `active: false`. `sync_script` — текущая ревизия (**v2.5.0 · rev.25**: мультивыбор месяцев).

Один прогон: сотрудники → постановщики «Менеджер по продажам» → `POST /task/list` **только по сматченным** `user:id` за период (без фильтра шаблона КП) → системный статус → generate отчёта **450694**. **Нет** прохода «все постановщики» (rev.22). Несматченные ФИО — в `errors` / `unmatched_managers`, без дампа года. Опрос generate до **30 мин**. Год по числу менеджеров × страницы, не × весь аккаунт. Остановка — `POST /planfix-sync-cancel`.

`report_only: 1` — только generate/чтение отчёта и запись статусов/гистограммы **без** повторной выгрузки `/task/list` (кнопка **Только отчёт** на `/ops-sheet.html`).

Снимки отчёта хранятся **по `(year, month)`** (`dg_ops_planfix_report_task` / `report_status_counts` / `report_meta`). Синк за месяц или другой год **не** делает глобальный `DELETE` чужого периода.

Если после generate сейв **слабо пересекается** с задачами листа выбранного периода Datagon (&lt;10% строк сейва или &lt;100 задач в периоде) → код `REPORT_PERIOD_MISMATCH` (409), гистограмма **не** пишется. Раньше хватало **одного** совпавшего `task_id` — сейв за 2024 мог записаться как «весь 2025», а статусы в заявках 2025 оставались пустыми.

Если часть «Менеджер по продажам» **не найдена** в Planfix `/user/list` (часто уволенные — в API только активные с урезанным `name`), это **не** значит «их нет в отчёте 450694»: в отчёте и на старых задачах они остаются. Синк делает **доп. проход** без фильтра постановщика и пишет в лист только задачи, где постановщик матчится с менеджером продаж по ФИО с задачи. `prune` не удаляет строки несматченных менеджеров. В UI прогресса: «нет в /user/list», не «не в Planfix».

Перед синком в UI Planfix у отчёта выставьте тот же период (API generate даты не принимает). Обрыв TLS Planfix повторяется до 4 раз.

Повторный POST, пока синк жив: **409** `{ success: false, error, attached: true, …planfix-sync-status }`. Лок сбрасывается, если нет прогресса **> 45 мин**.

### PUT `/api/ops-sheet/planfix-status-map`

Только `full`. Body: `{ year, month, items: [{ status_value, bucket, count_in_apps, is_separator? }] }`. Порядок `items` = порядок строк таблицы (`sort_order` в `dg_ops_planfix_status_catalog`). Разделители (`__sep:N` / `is_separator`) сохраняются в каталоге, в карту корзин не пишутся. `month` для счётчиков панели после сохранения. Корзины: `in_work`, `paid`, `paid_shipped`, `rejected`, `info_spam`, `supplier`, `no_goods`, `aggregator`, `gbuz`. Ответ: сохранённая панель + `mismatches` (проверка из БД).

## Work schedule (график работы)

Страницы `/work-schedule.html`, `/work-schedule-settings.html`. Роутер `routes/workSchedule.js`, схема `lib/datagonWorkScheduleSchema.js` (`ws_*`), расчёты `lib/datagonWorkScheduleCalc.js`, премии из продаж `lib/managerSalesMonthBonus.js`. Матрица: **`work-schedule`** / **`work-schedule-settings`** (API-режим — max из двух). Роли: сотрудник (`ws_employee`), руководитель (`head_user_id`), бухгалтерия (specialty «Бухгалтерия» / admin). Подробнее: [График работы](/docs/work-schedule/).

**Отделы = специальности:** `POST /departments/import-specialties` копирует имена из `specialties` (без «Полный доступ») в общий `ws_department`. Не заводить отделы вроде «Продажи», если в специальностях есть **«Менеджер по продажам»**.

Несколько юрлиц: `GET/POST/PUT/DELETE /organizations`; seed при пустой таблице **АЛЬМАМЕД** + **ВИЛМЕД**. `DELETE` орг. запрещён при наличии сотрудников (409). У сотрудника обязателен `hire_date`. Премия: правило отдела/сотрудника (`stub` / `fixed` / `fixed_full`) **или** помесячный `ws_payroll_entry.premium_manual` (клик в табеле / «Премии из продаж»). Оклад и стаж в payroll — пропорционально ставкам месяца; в ответах также `salary_rate` / `seniority_full`.

| Метод | Путь | Кто |
|-------|------|-----|
| GET | `/api/work-schedule/access` | любой авторизованный; `visible_departments[]` (`id`, `name`, `can_edit`, `is_own`, `is_headed`, `via_manage`), `headed_department_ids` |
| GET/POST/PUT | `/organizations`, `/departments`, `/employees`, `/users-available` | accounting; `GET /departments` — сотрудник/рук: свой + headed + `ws_department_manage_scope`; accounting: все поля `d.*` + `manage_scopes[]` (`department_id`, `name`, `can_edit`). `POST/PUT /departments` body: `manage_scopes: [{ department_id, can_edit }]` — отделы, которые видят/правят сотрудники **этого** отдела (пример: «Руководитель склада» → «Склад») |
| GET | `/employees/:id/salary-history` | accounting (любой) / employee (свой); аудит `field_name=salary` (`create` / `salary_change`: кто, когда, было/стало) |
| DELETE | `/organizations/:id` | accounting (409, если есть сотрудники) |
| POST | `/departments/import-specialties` | accounting; отделы из `specialties` в **общий** справочник (без привязки к орг.; без «Полный доступ»), без дублей имён |
| GET/POST | `/clock/status`, `/clock/start`, `/clock/stop` | сотрудник; `segments_json` append-only (+ `ip_in`/`ip_out`); `stop` сначала пишет часы/сегменты (payroll ошибка → `payroll_error`, часы уже в БД); повторный `start` → `resumed` + накопление |
| GET | `/me/day?date=YYYY-MM-DD` | сотрудник; детали дня: сегменты старт/стоп, часы, IP, открытый сегмент |
| GET | `/stuck-shifts?department_id=` | head / accounting; без `department_id` у head — свой отдел, у accounting — все; с параметром — только выбранный отдел |
| GET | `/me/month`, `/dept/month` | employee / head / accounting; `dept/month?department_id=` — свой / headed / manage_scope; `can_edit` — head, accounting или scope с `can_edit=1`; в `payroll` — `salary_rate` + `base_salary`, `seniority_full` + `seniority_bonus` |
| GET / PATCH | `/sheet`, `/sheet/cell` | `GET /sheet` — accounting; `PATCH /sheet/cell` — accounting, `head_user_id` отдела сотрудника **или** manage_scope с `can_edit` у отдела актёра; в ячейках `open: true`, если смена не закрыта; у сотрудников `salary` / `salary_accrued`, `premium_*` / `premium_source`, `seniority_*`, `total_accrued` / `total_planned`; автопремии sales при наличии отделов «…продаж…» |
| PATCH | `/sheet/cells-bulk` | accounting или head (только свои отделы); body `{ cells: [{ employee_id, work_date }], type, rate, hours }` → `total` / `created` / `updated` / `failed` / `errors[]` / `duration_sec` (лимит 366) |
| GET / POST | `/bitcop/config` | accounting; аккаунт + API-ключ Bitcop + метрика (`productiveTime`/`activeTime`/`totalTime`); ключ в GET только маской |
| GET / POST | `/bitcop/employees`, `/bitcop/test` | accounting; список сотрудников Bitcop / проверка ключа |
| POST | `/bitcop/sync-hours` | accounting; body `{ period_ym, dry_run?, force?, organization_id?, department_id?, employee_id? }` — часы из Bitcop в `ws_work_log` (`source=bitcop`) для карточек с `bitcop_employee_id` |
| PATCH | `/sheet/premium` | accounting; ручная премия: `{ employee_id, period_ym, premium_manual }` (`null` — сброс); пишет `premium_source=manual` |
| POST | `/sheet/premium-from-sales` | accounting; принудительный пересчёт премий из журнала (`totals.bonus`) → `premium_manual` + `premium_source=sales`; body `{ period_ym, dry_run?, force?, organization_id?, department_id? }` |
| POST | `/vacations`, `/vacations/:id/approve` | employee / head+accounting |
| POST | `/sick`, `/absences`, `/vacation-compensation` | accounting |
| GET/POST | `/payroll`, `/payroll/dry-run`, `/payroll/apply` | accounting (свой payroll — employee) |
| GET | `/calendar?year=`, `/calendar/month?month=YYYY-MM` | любой; при пустой БД год подтягивается из xmlcalendar.ru / бандла; month → `non_working_days`, `short_days`, `source` |
| POST | `/calendar/sync-rf` | accounting; body `{ years?: number[] }` — залить производственный календарь РФ в `ws_work_calendar` (норма 5/2) |
| POST | `/calendar/import` | accounting; ручной массив `days[]` |
| GET | `/audit` | accounting; query `limit`, `month=YYYY-MM`, `scope=edits`, `employee_id` / `employee_q` (фильтр по **сотруднику-субъекту** правки, не по автору), `entity_type`, `user_id`; в строках — `subject_name`, `subject_work_date`, `subject_department_name` для `work_log` |
| GET | `/export/1c?format=csv\|xml&month=YYYY-MM` | accounting |
| POST | `/import/timesheet-csv` | accounting (`dry_run`, `csv`) |
| GET/PUT | `/1c-map`, `/1c-map/:employeeId` | accounting |

Фон: раз в 15 мин `processStuckShifts` авто-закрывает открытые смены:
1. **смена суток (МСК):** `work_date` &lt; сегодня → `check_out` = `work_date 23:59:59`, сегмент `day-rollover`, `status=needs_confirm`;
2. иначе открыта ≥ `clock_auto_close_hours` (дефолт 14) → `check_out` = сейчас, сегмент `auto-close`, `status=needs_confirm`.

## Финансы

Страница `/finance.html`, роутер `routes/finance.js`, клиенты `lib/datagonTochkaClient.js`, `lib/datagonRaiffeisenClient.js`, `lib/datagonTbankClient.js`, учётные записи `lib/datagonFinanceCredentials.js`, наличные `lib/datagonFinanceCash.js`. Банки **Точка** (JWT), **Райффайзен** (`client_id` / `client_secret` / `refresh_token`) и **Т‑Банк** (Bearer T‑API). Банковские выписки — только чтение; наличные — ручной ввод. Матрица: ключ **`finance`**. POST config/sync/cash — только **`full`**.

**Несколько организаций Точки:** `app_settings.finance_tochka_credentials` (JSON). Legacy `finance_tochka_jwt` мигрирует в первую запись. Синк идёт по всем `enabled` ключам. JWT **не** в `GET /api/settings`.

**Райффайзен:** `app_settings.finance_raiffeisen_credentials`. Refresh обменивается на access/id token через `sso.rbo.raiffeisen.ru`; новый refresh сохраняется. Счета и проводки в тех же таблицах с `bank='raiffeisen'`.

**Т‑Банк:** `app_settings.finance_tbank_credentials`. Bearer из кабинета Т‑Бизнес → Интеграции → T‑API. Клиент `lib/datagonTbankClient.js`: `GET /api/v1/bank-accounts` (fallback v2/v3) и `GET /api/v1/statement` (`https://business.tbank.ru/openapi`). Токен **не** в `GET /api/settings`. Счета и проводки с `bank='tbank'`, `customer_code` вида `tb:{inn}`. Банк может требовать белый список IP (и для части методов — mTLS).

«Обновить все» / автосинк `finance_tochka` тянет включённые ключи всех трёх банков (cash не синкается). Если в прогоне есть **хотя бы одна** ошибка API/ключа — `success: false`, в `auto_sync_runs` статус **failed** (красный стикер), в `message` сводка **и** хвост `ОШИБКИ N: …` (не маскируется зелёным «Завершено» при живых остальных банках).

**Ограничение:** Open Banking Точки отдаёт только банковские счета. Фонды без API — ручная пометка на карточке (`is_fund`, `custom_name`).

Таблицы: `dg_finance_accounts` (`bank`, `credential_id`, `org_label`, `is_fund`, `custom_name`, …), `dg_finance_tx`, **`dg_finance_cash_templates`**, **`dg_finance_cash_overrides`**, **`dg_finance_cash_tx`**.

### GET `/api/finance/config`

`{ success, configured, credentials: [{ id, label, enabled, jwt_mask, jwt_len, customer_codes, customer_names }], raiffeisen_credentials: [{ id, label, enabled, client_id, client_secret_mask, refresh_token_mask, configured, customer_codes, customer_names }], tbank_credentials: [{ id, label, enabled, token_mask, token_len, configured, customer_codes, customer_names }], can_write, sync }`.

### POST `/api/finance/config`

Точка (по умолчанию):

- `{ "action": "upsert", "label", "jwt", "id?" }` — добавить/обновить ключ (при upsert без id — новая запись; с id — правка)
- `{ "action": "delete", "id" }`
- `{ "action": "toggle", "id", "enabled" }`
- legacy `{ "jwt", "label?" }` — upsert первой/новой
- `{ "clear": true }` — очистить JWT Точки

Райф: `{ "bank": "raiffeisen", "action": "upsert"|"delete"|"toggle", … }` (`client_id`, `client_secret`, `refresh_token`, `label`, `id`).

Т‑Банк: `{ "bank": "tbank", "action": "upsert"|"delete"|"toggle", … }` (`token`, `label`, `id`).

### GET `/api/finance/probe`

Опционально `?credential_id=` и `?bank=tochka|raiffeisen|tbank`. Ответ: `{ count, credentials_probed, results[], consent_gaps, api_note }`.

### GET `/api/finance/accounts`

Снимок из БД (+ `org_label`, `credential_id`, `is_fund`, `custom_name`, `can_write`).

Дополнительно **`deposit_estimate`**: оценка остатка «на депозитах» из выписки (не зависит от `include_internal`):

- `method`: `statement_openings_minus_returns`
- `items[]`: `{ customer_code, org_label, bank, currency, openings, returns_body, amount }` — `amount = max(0, openings − returns_body)` по назначениям «открытия депозита» (исходящие) и «Возврат средств по депозитной сделке» (входящие); проценты не входят
- `totals[]`: `{ currency, amount }` — сумма по валютам
- `note` — пояснение для UI

На экране карточка **«На депозитах»** всегда рядом со счетами; в **«Всего доступно»** входят расчётные + эта оценка. График по-прежнему без тела депозита (проценты в доходе).

### POST `/api/finance/org-meta`

Только `full`. Body: `{ "customer_code", "full_name?", "short_name?", "custom_name?" }`.
- **`full_name`** — для фильтра «Организация», колонки в таблице, аналитики, поиска.
- **`short_name`** — для шапки карточек балансов.
- legacy **`custom_name`** = `full_name`.
Пустые оба — сброс к имени из банка. Хранение: `app_settings.finance_org_aliases` как `{ [customer_code]: { full, short } }` (старые строки-алиасы мигрируют в оба поля). Ответ: `{ success, full_name, short_name, custom_name, org_aliases }`.

### POST `/api/finance/account-meta`

Только `full`. Body: `{ "account_id", "bank?", "is_fund?", "custom_name?" }`. Ручная пометка фонда и названия; синк из банка эти поля не затирает. Ответ: `{ success, account }`.

### POST `/api/finance/tx-meta`

Только `full`. Body: `{ "tx_id", "bank?", "chart_tag": ""|"founder"|"dividend" }` (или устаревшее `exclude_chart: true|false` = займ). Ручные пометки **капитал / займ учредителей** и **выплата дивидендов**. Синк выписки **не** затирает. Помеченные проводки **не** входят в график и топ контрагентов. Ответ: `{ success, tx: { bank, tx_id, chart_tag, exclude_chart, founder_capital, dividend_payout, chart_excluded, chart_exclude_reason } }`.

### GET `/api/finance/transactions`

Query: `search`, **`inn`** / `counterparty_inn` (только цифры; подстрока в нормализованном ИНН контрагента; при заданном ИНН наличные не подмешиваются), `customer_code` (повторяемый или через запятую; также `customer_codes` / `org`) — несколько организаций, `direction`, **`source=bank|cash|all`** (по умолчанию **`all`**), `account_id`, `date_from`, `date_to` **или** `months` (как analytics; без дат окно по `months`, иначе cash-шаблоны не разворачиваются с 2000-01-01), `page`, `page_size`, `include_internal=1` (или `include_deposits=1`; по умолчанию **выкл.** — без тела депозита UNV, без «Перевод собственных средств» и без «Выплата дивидендов»), `founder_capital=1` / `founder_only=1` — только ручная пометка займ (банк), `dividend=1` / `dividend_only=1` — галка «див.» **или** назначение «Выплата дивидендов» (банк), `sort_by` / `sort` (`booked_date`|`amount`|`counterparty`|…), `sort_dir` (`asc`|`desc`). При `source=all|cash` к банку подмешиваются развёрнутые шаблоны и разовые наличные (`lib/datagonFinanceCash.js`). Сортировка **на сервере** по всей выборке (не только текущая страница); для `amount` — по `amount_abs`.

В строках банка: `customer_code`, `org_label`, **`org`** — **полное** имя организации (alias `full`, иначе `org_label`), **`org_short`** — короткое. **`chart_excluded`** / **`chart_exclude_reason`**, **`chart_tag`**: `founder` | `dividend` | `""`, **`founder_capital`** / **`dividend_payout`**. В строках cash: `source=cash`, `cash_kind=once|recurring`, `bank=cash`, `tx_id` вида `cash:o:{id}` / `cash:t:{templateId}:{ym}`, `include_chart`, `amount_fix` / `amount_premium` (для recurring), `scope`. Умный поиск матчит оба alias.

Ответ дополнительно: `include_internal`, `founder_capital`, `dividend`, `source`, `sort_by`, `sort_dir`.

### GET `/api/finance/cash/summary`

Сводка для дашборда карточки «Наличные». Query как у analytics: `date_from`/`date_to` или `months`, `customer_code` / `customer_codes` / `org`, `account_id`. Ответ: `{ success, fact_source: "once", date_from, date_to, months, currency, series: [{ month, in, out, net, once_*, tmpl_*, count_* }], totals: { in, out, net, once_*, tmpl_*, count }, forecast: { … } }`. Поля `in`/`out`/`net` в `series` и `totals` — **только разовые** (факт графика). `tmpl_*` — справка по развёрнутым шаблонам, не входят в факт. **`forecast`** — следующий календарный месяц: активные шаблоны с overrides, без `skipped`.

### GET/POST/PATCH/DELETE `/api/finance/cash/templates`

CRUD ежемесячных шаблонов (`dg_finance_cash_templates`). Body POST: `{ purpose, direction?, day_of_month?, amount_fix, amount_premium?, scope?: "all"|"org", customer_code?, include_chart?, needs_review?, active?, valid_from?, valid_to?, plan_item_id? }`. DELETE также чистит overrides шаблона. `plan_item_id` — ручная привязка к статье плана (nullable). `needs_review` — `review_pending` только для **текущего** `ym` и только если `booked_date` ≤ сегодня (МСК); прошлые/будущие месяцы периода без `review_pending`.

### PUT `/api/finance/cash/templates/:id/months/:ym`

Помесячный override (`ym=YYYY-MM`): `{ amount_fix?, amount_premium?, clear_premium?, purpose?, include_chart?, skipped?, review_confirmed? }`. Частичное обновление: отсутствующие поля сохраняют прежний override или шаблон. `review_confirmed=1` снимает подсветку «требуется проверка» за месяц.

### GET/POST/PATCH/DELETE `/api/finance/cash/tx`

Разовые наличные (`dg_finance_cash_tx`). Body POST: `{ booked_date, amount, purpose, direction?, scope?, customer_code?, include_chart?, counterparty?, plan_item_id? }`.

### GET/POST/PATCH/DELETE `/api/finance/plans/categories`

Справочник категорий трат (`dg_finance_plan_categories`). Body POST: `{ title, active?, sort_order? }`. При совпадении названия (без учёта регистра) возвращает существующий `id` (`existing: true`). DELETE обнуляет `category_id` у статей.

### GET/POST/PATCH/DELETE `/api/finance/plans/items`

CRUD статей (`dg_finance_plan_items` + `dg_finance_plan_item_inns`). Body POST/PATCH: `{ title, payment_form?: "bank"|"cash"|"both", counterparties?: [{ inn, name? }], amount_plan, category_id?, direction?, scope?, customer_code?, active?, cash_template_ids?: number[], cash_once_ids?: number[] }`. Для `bank`/`both` нужен хотя бы один ИНН; для `cash` — нет. `cash_template_ids` / `cash_once_ids` выставляют `plan_item_id` у шаблонов/разовых (иначе «Ушло (нал)» в матрице = 0). В списке: `payment_form`, `counterparties[]`, `cash_template_ids`, `cash_once_ids`, `cash_links_count`. DELETE чистит inns/overrides и снимает `plan_item_id` у cash.

### PUT `/api/finance/plans/items/:id/months/:ym`

Помесячный override плана (`ym=YYYY-MM`): `{ amount_plan?, skipped? }`.

### GET `/api/finance/plans/matrix`

Матрица план/факт. Query как у analytics: `date_from`/`date_to` или `months`, `customer_code` / `customer_codes` / `org`, `currency`. Ответ: `{ success, date_from, date_to, months, currency, items: [{ id, title, payment_form, inns, …, months: [{ ym, plan, fact_bank, fact_cash, fact, delta }], totals }], by_payment_form: { bank|cash|both: { plan, fact, fact_bank, fact_cash, items } } }`. `fact_bank` только при `payment_form` bank/both; `fact_cash` — при cash/both из наличных с `plan_item_id`. `by_payment_form` — агрегаты для графиков. Планы не мержатся в `/transactions`.

### GET `/api/finance/analytics/monthly`

Помесячная агрегация из `dg_finance_tx` **+ cash** (разовые и развёрнутые шаблоны с `include_chart`, не `skipped`). Query: `months` (1…36, по умолчанию **12**) **или** `date_from`/`date_to` (календарный год в UI: «Текущий год» / «Прошлый год»), `customer_code` / `customer_codes` / `org` (несколько), `account_id`, **`source=bank|cash|all`**, `currency` (по умолчанию `RUB`), `include_deposits=1` / `include_internal=1` (по умолчанию **выкл.** — без тела депозита UNV, без «Перевод собственных средств» и без «Выплата дивидендов»; проценты и внешние платежи входят), **`exclude_chart_inn=0|1`** (по умолчанию **вкл.** — исходящие на ИНН `362903774541` вне графика). Проводки с `exclude_chart=1` (займ или дивиденды вручную) **всегда** вне графика; cash без `include_chart` — тоже вне.

Ответ: `{ success, months, currency, date_from, date_to, include_deposits, exclude_chart_inn, exclude_chart_inn_value, source, series: [{ month, in, out, net, count_in, count_out, balance, balance_accounts, balance_deposits, diff }], totals: { in, out, net, count, balance, balance_start, balance_diff, balance_accounts, balance_deposits }, balance_note }`. Пустые месяцы в окне заполняются нулями.

**`balance` / `diff` в `series`:** остаток на конец месяца (= расчётные + оценка депозитов, как «Всего доступно») и изменение к предыдущему месяцу. Расчётные: `SUM(available)` минус последующие проводки из **полной** выписки. Депозиты: накопительно открытия − возвраты тела. При `source=cash` — `null`. KPI «Разница» = `totals.balance_diff`.

### GET `/api/finance/analytics/counterparties`

Топ контрагентов по сумме входящих / исходящих (банк + cash). Query: `limit` (3…20, по умолчанию **8**), `months` (если нет `date_from`/`date_to`), `date_from`, `date_to`, `customer_code` / `customer_codes` / `org`, `account_id`, **`source`**, `currency`, `include_internal=1` / `include_deposits=1` (по умолчанию **выкл.**, те же исключения, что у monthly), **`exclude_chart_inn`** (как у monthly). Займ и ручные дивиденды (`exclude_chart`) **всегда** вне топа. Cash без контрагента — группа **«(наличные)»** / по `purpose`.

Ответ: `{ success, limit, currency, date_from, date_to, include_internal, exclude_chart_inn, source, top_in: [{ rank, name, inn, amount, count, share }], top_out: […], totals: { in, out, counterparties_in, counterparties_out } }`. Группировка по **ИНН** (если есть) — разные написания названия одной конторы сливаются; без ИНН — по имени.

### GET `/api/finance/sync-status`

### POST `/api/finance/sync`

Body: `{ "days": 30, "date_from?", "date_to?", "customer_code?", "customer_codes?", "account_id?", "balances_only": false, "credential_id?", "bank?": "tochka"|"raiffeisen"|"tbank" }`.
Период: либо `date_from`/`date_to` (не больше 1095 дн.), либо `days` (1…1095). Без `credential_id` / `bank` — все включённые ключи трёх банков. Асинхронно (`queued: true`); итог в `sync-status → last_result`.

Автосинк: `task: "finance_tochka"`. Сценарий: [Финансы](/docs/finance).

## Управление БД

Страница `/db-admin.html`, роутер `routes/dbAdmin.js`, каталог связей `lib/datagonDbRelations.js`. Только **основная** MySQL Datagon (не CMS сайтов). Доступ API и пункт меню с замком: **admin** или `can_manage_users` (как «Активность/Логи») — жёсткая проверка в роутере, не только матрица. Ключ матрицы HTML: `db-admin`. UI: [Управление БД](/docs/db-admin/). Имена таблиц для preview/ANALYZE/OPTIMIZE сверяются с `information_schema` текущей схемы — произвольный SQL запрещён.

### GET `/api/db-admin/overview`

Сводка + список таблиц: `database`, `size_bytes`, `data_bytes`, `index_bytes`, `table_count`, `fetched_at`, `tables[]` (`name`, `engine`, `table_rows`, размеры, `pct_of_db`, `domain` / `domain_title` / `note` / `links` из каталога связей). Query `refresh=1` — без кэша на стороне API (пересчёт из `information_schema` каждый раз).

### GET `/api/db-admin/relations`

Группы доменов (CMS, МойСклад, маркетплейсы, цены сети, парсер, закупки, журналы) и таблицы с человеческими подписями «зачем таблица».

### GET `/api/db-admin/tables/:name/preview`

Query: `limit` (1…50, default 20). Ответ: `columns[]` из `information_schema.COLUMNS`, `rows[]` (`SELECT * … LIMIT`), `meta` из каталога связей.

### POST `/api/db-admin/analyze`

Body: `{ "tables": ["my_products", …] }` (макс. 40). Последовательно `ANALYZE TABLE`. Ответ: `total`, `ok_count`, `failed`, `duration_sec`, `ok[]`, `errors[{ table, error }]` (до 20).

### POST `/api/db-admin/optimize`

То же тело, что у analyze. Выполняет `OPTIMIZE TABLE`. **Может блокировать таблицу** — в UI своя confirm-модалка.

## Поставщики

Страница `/suppliers.html`, роутер `routes/suppliers.js`. В список попадают **уникальные** значения `ms_export.supplier`, у которых есть хотя бы один товар: `stock_position = Да`, `type` не комплект, `no_longer_cooperation` не «Да», `is_archived = 0`. Настройки по поставщику — `dg_supplier_settings` (PK = `supplier_key` = trim(`supplier`)). История снимков наполняемости — `dg_supplier_fill_history` (запись при сохранении `stock_fill_pct` через PATCH). Поле **`replenishment_days`** (nullable INT) — ручной горизонт «Пополнение, дней» для формулы: если задано, перекрывает глобальный `sales_formula_replenishment_days`, но **ниже** рек. дней по отдельному SKU (см. закупки). **Редактирование только у `username === admin`** (UI скрыт, `PATCH` → 403); расчёт формулы использует значение для всех ролей.

**Позиция «к закупке» (шт):** `max(0, min_stock МС − stock − in_transit)` — только поле «Неснижаемый остаток» из `ms_export`, без override и без формулы. **Сумма закупки:** сумма `need_qty × buy_price` по строкам с `need_qty > 0`. **Наполняемость % (Кол-во Несн/Несниж сумм./Ост.факт/%):** в ячейке `кол-во SKU с неснижаемым &gt; 0 / Σ неснижаемый (шт) / Σ остаток факт (шт) / %`; неснижаемый на SKU = `COALESCE(override, кэш формулы, min_stock МС)`; `%` = `100 × Σ остаток ÷ Σ неснижаемый`. Подсветка: &lt;70% — красный, 70–90% — жёлтый, ≥90% — зелёный.

## Анализ поставщиков

Страница `/supplier-analysis.html`, роутер `routes/supplierAnalysis.js`. Тот же каталог SKU, что на `/suppliers.html` (`sqlSupplierProductWhere`). Ключ поставщика — **`supplier`, иначе `supplier2`** («Поставщик 2»), см. `supplierEffectiveSql`. Продажи — суммы по `ms_demand_position` (отгрузки МС, `applicable=1`, не удалённые). Привязка к поставщику: прямой `ms_export.code` **или** комплект через `dg_bundle_components` на складской `component_code` (у комплектов часто пустой `supplier` / type «Комплект»; если кэша нет — код вида `36323-30` → товар `36323`). Цифра в МС может быть выше, пока отгрузка ещё не попала в `ms_demand` (синк продаж). Сравнение периодов: текущее окно `days` и предыдущее такое же окно.

**Профиль отсутствия** (`lib/datagonSupplierAbsenceProfile.js`): по `dg_product_zero_stock_log` строятся эпизоды нуля на каждый `code` → на SKU `recommended_replenishment_days` = **max(макс. простой, ceil(ср. эпизод))** — только факт отсутствия, **без** пола на глобаль/поставщика. **В формулу закупок** эти дни входят **на уровне товара**, если включено `sales_formula_sku_replenishment_enabled` и рек. **строго выше** базы: цепочка **SKU-рек. → supplier override → global** (`k = дни÷W`, `resolveEffectiveReplenishment`). Отдельно в формуле всегда есть **упущенные продажи** за окно A (`absenceDistinct × avgW`) — рычаг **спроса**, рек. дни — рычаг **горизонта**. Fingerprint кэша: `|rd:g` / `|rd:s:N` / `|rd:sku:N`. На `/supplier-analysis.html` и `/suppliers.html` **нет** «рек. дней на всего поставщика» / кнопки «Применить» — диагностика только эпизодов (долгие / частые короткие). Согласие с предложением — через **предлагаемый нес.остаток** на `/purchase.html`. Пороги бейджей: долгий ≥14 дн., частый короткий ≥3 эпизода со ср. длиной ≤3.

Фильтр проектов отгрузок (только для продаж): `project_mode` (`all` | `selected`, default `all`), `project_uuids` — список UUID через запятую (при `selected` без UUID продажи не учитываются). **Выручка, маржа и Δ выручки** в `/overview` считаются только по отгрузкам выбранных проектов. Маржа: доля `sum_minor` позиции − закупка складского SKU × эквивалент шт. (`qty` комплекта × `qty_per_bundle`). Остатки и каталог SKU от фильтра не зависят.

### GET `/api/supplier-analysis/projects`

Query: `days` (7–365, default 90). Список проектов из `ms_demand` с **активными** отгрузками за период (`applicable=1`, `deleted_at IS NULL` — как в агрегатах продаж): `{ success, days, projects: [{ uuid, name, count }] }`. `count` — число документов отгрузки, не SKU и не позиции.

### GET `/api/supplier-analysis/sales-breakdown`

Расшифровка KPI продаж: построчно по `ms_demand_position` (отгрузка, SKU, выручка, закупка ед., себестоимость, маржа). Query: `days`, `project_mode`, `project_uuids`, `search` (поставщик/код/название), `limit` (1–200, default 50), `offset`. Ответ: `{ totals: { sales_revenue, gross_margin_est, demands_count, lines_count }, rows[], total }` — `totals` совпадают с логикой `/overview`.

### GET `/api/supplier-analysis/overview`

Query: `days` (7–365, default 90), `project_mode`, `project_uuids`. Ответ: `{ success, days, project_filter: { mode, uuids, project_names, label }, totals: { … } }`.

### GET `/api/supplier-analysis/highlights`

Query: `days`. Ответ: `{ needs_attention, top_revenue, top_growth, weak, chronic_absence, flicker_absence }` — до 8 поставщиков в каждом блоке (сигналы `signals`, `attention_score`; блоки отсутствия — по `chronic_sku_count` / `flicker_sku_count`).

### GET `/api/supplier-analysis/ranking`

Query: `days`, `new_stock_days` (7–180, default 30), `project_mode`, `project_uuids`, `focus` (`all`|`develop`|`problem`), `search`, `limit`, `offset`, `sort_by`, `sort_dir`.

В каждой строке: `skus_warehouse` (= складские SKU в каталоге), `skus_total` (все SKU поставщика в МС), `stock_value_rub` (Σ `ms_export.stock` × себестоимость ед. из `payload.stockCost` после полного синка МС / `report/stock/all.price`; если `stockCost` ещё нет — закупочная с карточки; **не** ожидание и **не** комплекты; цифра как в отчёте остатков МС на момент последнего синка каталога), `turnover_monthly` (коэффициент; в UI ×100 = % остатка в месяц: (выручка/остаток ₽) ÷ (days÷30)), `sales_revenue`, `skus_new_on_stock`, `new_avg_days_on_stock` (среднее число дней с первого остатка > 0 у новинок), `skus_ineffective` (залежалые: остаток, 0 продаж, не новинка), `chronic_sku_count`, `flicker_sku_count`, `absence_sku_count`, `chronic_max_streak_days`, `signals[]` (без «рек. пополнение» на поставщика), `portfolio_tag` (для подсветок/фильтра `focus`, опционально). Сортировка по умолчанию: `sales_revenue` desc (№1 в таблице — поставщик с наибольшими продажами за период).

### GET `/api/supplier-analysis/trend`

Query: `supplier_key`, `months` (3–24, default 12), `project_mode`, `project_uuids`. Помесячные `sales_qty`, `sales_revenue`.

### GET `/api/supplier-analysis/products`

Query: `supplier_key`, `days`, `new_stock_days` (для `stale`/`new`), `mode` (`all`|`warehouse`|`catalog`|`all_skus`|`total`|`leaders`|`laggards`|`stale`|`new`|`weak`|`absence`), `limit` (до 500 для `warehouse`/`all_skus`), `project_mode`, `project_uuids`. **`warehouse`** / `catalog` — SKU складская (`sqlSupplierProductWhere`: не архив, не «перестали сотрудничать», складская «Да»). **`all_skus`** / `total` — все SKU поставщика (`sqlSupplierAllSkusWhere`: без архива и «перестали сотрудничать», комплекты исключены). **`stale`** / `laggards` — остаток > 0, 0 продаж, не новинка. **`new`** — остаток > 0, первый остаток в пределах `new_stock_days`. **`weak`** — есть продажи, но `sales_qty` &lt; 25% медианы. **`absence`** — SKU с эпизодами нуля: `absent_days`, `episode_count`, `max_streak_days`, `avg_episode_days`, `chronic`, `flicker`, `sales_*` (рек. дни на UI анализа не показываются; они идут в формулу на `/purchase.html`); в ответе также `rollup` по счётчикам отсутствия. Ответ каталога: `total`, `truncated`, в строке `is_warehouse`, `stock_position`, `stock`, **`in_transit`** (ожидание / в пути: `ms_entity_details.denorm_in_transit` или `payload.inTransit`, как на закупках).

### GET `/api/supplier-analysis/export`

Query: `days`, `search`, `project_mode`, `project_uuids` (как в ranking). Ответ: CSV (UTF-8 BOM) со всеми поставщиками, отсортированными по `attention_score`.

### GET `/api/supplier-analysis/data-freshness`

Как `/api/suppliers/data-freshness` (каталог МС + продажи МС).

## Анализ товаров

Страница `/product-analysis.html` (меню сразу после «Анализ поставщиков», ключ матрицы `product-analysis`, `sortOrder` 45.56). Роутер `routes/productAnalysis.js`, SQL — `lib/datagonProductAnalysisSql.js`. Каталог — складские SKU (`sqlProductAnalysisCatalogWhere`: не архив, складская «Да», не комплект; **включая** «перестали сотрудничать» — остаток ещё может лежать). Продажи — те же join'ы, что у анализа поставщиков (`salesJoinSql` с тем же catalog-where), агрегат **по `code`**.

**Шаринг фильтров через URL:** после «Применить» / пресета / сортировки / страницы адрес обновляется (`history.replaceState`). Параметры (не-дефолтные): `days`, `new_stock_days`, `exclude_new_on_stock`, `search`, `supplier`, `manager`, `preset`, `project_mode` (`all`|`selected`), `project_uuids` (через запятую), `limit`, `page`, `sort_by`, `sort_dir`. Открытие ссылки восстанавливает форму и сразу грузит выборку.

**Производительность ranking/overview:** тяжёлый join к `dg_product_stock_snapshot` (~миллионы строк) **не** выполняется на каждом запросе (как в анализе поставщиков). Snap включается только для пресетов «Новые на складе» / «исключать новые» из мёртвых·зависших·НС>0 и при сортировке по `days_on_stock`. Для обычных списков `days_on_stock` догружается точечно по кодам текущей страницы. Окно «прошлый период» продаж в ranking строится только при сортировке по `revenue_change_pct` (в overview — всегда, для KPI Δ%).

Решения хранятся в **`dg_product_analysis_decisions`** (не в `dg_purchase_overrides`): `lifecycle` (`none`|`top`|`hold`|`boost`|`boost_failed`|`infographic`|`clearance`|`exit`), `do_not_order`, `min_stock_target`, `lock_proposed_min_stock`, поля буста (`boost_started_at`, `boost_days`), `decision_note` (снимок **последнего** комментария для CSV/экспорта).

Комментарии к SKU — таблица **`dg_product_analysis_comments`** (как на manager-sales): несколько записей на код, автор, правка/удаление только своих. UI: список + «+» + модалка. При первом старте непустые старые `decision_note` мигрируют в первый комментарий.

Каждое реальное изменение поля решения пишется в **`dg_product_analysis_decisions_log`** (`field`, `old_value`/`new_value` человекочитаемо, `source`: `row`|`bulk`|`min_stock`|`purchase`|`ui`). В UI у «Решение» и «Комментарий» — кнопка **лог**.

Пресеты query `preset`: `all`, `top_revenue`, `top_qty`, `dead`, `stuck`, `new_on_stock`, `dead_min_stock`, `min_vs_proposed`, `lifecycle_*`, `do_not_order`. Фильтр проектов отгрузок — как у supplier-analysis (`project_mode` / `project_uuids`).

Отличие ключевых пресетов остатка: **`dead` (Мёртвые)** — продаж за период = 0 и `stock_qty > 0`; **`stuck` (Зависшие)** — шире: `stock_qty > 0` и (продаж = 0 **или** `days_without_sales ≥ 30`). `dead` ⊂ `stuck` при нулевых продажах; зависшие ещё ловят SKU с редкими/давними продажами внутри периода. **`new_on_stock` (Новые на складе)** — `stock_qty > 0` и первый снимок остатка > 0 в пределах `new_stock_days` (как «Новые» в анализе поставщиков). При `exclude_new_on_stock=1` (по умолчанию) новинки **исключаются** из пресетов `dead` / `stuck` / `dead_min_stock`.

### GET `/api/product-analysis/presets`

Список `{ key, label, description }` + допустимые `lifecycle`. `description` — текст подсказки на чипах пресетов в UI.

### GET `/api/product-analysis/projects`

Как `/api/supplier-analysis/projects`.

### GET `/api/product-analysis/managers`

Уникальные значения `ms_export.manager` (свойство МС «Менеджер поддерживающий товар»): `{ success, managers: string[] }`.

### GET `/api/product-analysis/overview`

Query: `days`, `new_stock_days` (7–180, default 30), `exclude_new_on_stock` (`1`/`0`, default `1`), `preset`, `search`, `supplier`, `manager` (точное совпадение `ms_export.manager`), `lifecycle`, `project_mode`, `project_uuids`. Ответ: `{ totals: { skus_total, sales_revenue, sales_qty, stock_value_rub, min_stock_sum, dead_with_min_stock, in_boost, in_exit_path, … }, new_stock_days, exclude_new_on_stock }`.

### GET `/api/product-analysis/ranking`

Query: как overview + `limit` (default 100), `offset`, `sort_by`, `sort_dir`. Ответ: `{ total, rows[], can_write, actor_user_id }` — метрики продаж/остатка + `manager` + `days_on_stock` / `first_positive_date` + поля решения + **`comments[]`** (`id`, `body`, `author_short`, `created_at_label`, `can_edit`) и `decision_note` (текст последнего комментария).

### GET `/api/product-analysis/sku-detail`

Query: `code` (обяз.), `days`, `project_mode`, `project_uuids`. Детализация одной SKU для раскрытия строки: `{ product, sales: { qty_total, revenue_total, by_project: [{ project_name, sales_qty, sales_revenue, share_pct }] }, absence: { max_streak_days, episode_count, avg_episode_days, recommended_replenishment_days, chronic, flicker } }`. Продажи — через тот же join, что ranking (включая комплекты); отсутствие — `dg_product_zero_stock_log` / `loadSkuRecommendedDaysByCodes`.

### GET `/api/product-analysis/log`

Query: **`code`** (обяз.), **`field`** (опц.: `lifecycle`|`do_not_order`|`min_stock_target`|`lock_proposed_min_stock`|`boost_days`|`decision_note`), `limit` (default 100, max 500), `offset`. Ответ: `{ success, code, total, rows: [{ id, field, field_label, old_value, new_value, source, source_label, changed_by_name, changed_at }] }`.

### GET `/api/product-analysis/export`

CSV по текущим фильтрам (до 20 000 строк).

### POST `/api/product-analysis/decision`

Body: `{ code, action? | lifecycle?, do_not_order?, min_stock_target?, lock_proposed_min_stock?, decision_note?, boost_days? }`. Actions: `boost`, `boost_failed`, `infographic`, `clearance`, `exit`, `top`, `hold`, `clear_decision`, `do_not_order_on`/`off`, `lock_proposed_zero`, `unlock_proposed` (снимает замок и очищает `dg_purchase_overrides.proposed_min_stock`). Ответ дополнительно: `changes[]`. Источник в журнале: `row`. Для новых комментариев предпочтительны эндпоинты ниже (не сырой `decision_note`).

### POST `/api/product-analysis/:code/comments`

Body: `{ body }` (до 2000 символов). Создаёт комментарий. Ответ: `{ success, comment, comments[], decision_note }`.

### PATCH `/api/product-analysis/:code/comments/:commentId`

Body: `{ body }`. Только автор комментария.

### DELETE `/api/product-analysis/:code/comments/:commentId`

Только автор. После add/edit/delete `decision_note` в decisions синхронизируется с последним комментарием (или очищается).

В UI колонка «Предлагаемый нес.ост.» показывает бейдж **🔒 фикс.** и кнопку **Снять**, если `lock_proposed_min_stock`. То же на `/purchase.html` (по `lock_proposed_min_stock` или явному override `proposed_min_stock`).

### POST `/api/product-analysis/decision/bulk`

Body: `{ codes[]? }` **или** фильтры ranking (`days`, `preset`, …) + `action`/`patch`, `dry_run=1` для preflight. Ответ: `total` / `updated` / `changed_fields` / `patch_fields[]` / `errors[]`. Источник в журнале: `bulk`.

### POST `/api/product-analysis/min-stock/apply`

Запись `ms_export.min_stock` из `min_stock_target` / `force_zero` / `value` **только в Datagon** (выгрузка в МС — автосинк `min_stock_export`). Поддерживает `dry_run` и выборку по `codes[]` или фильтрам (по умолчанию пресет `dead_min_stock`).

### GET `/api/suppliers/data-freshness`

Свежесть данных для плашки над блоком «Команда и закупки» на `/suppliers.html`. Без query.

Ответ: `{ success, as_of_msk, sources: [{ key, title, status: ok|stale|running|failed|unknown, is_today_msk, finished_at_msk, trigger_label, message_short, detail }] }` — два источника: `moysklad` (каталог/остатки МС + журнал нулевых остатков; **«Обновлено»** — `finished_at` последнего **completed** `auto_sync_runs` для `moysklad`, не `MAX(ms_export.synced_at)` — последнее касание строк каталога), `mssales` или `mssales_full` (импорт отгрузок; подпись `title`: «Продажи МойСклад: отгрузки за период» / «…полная выгрузка отгрузок»). **ok** — обновление было **сегодня** по календарю **МСК**; иначе **stale** (внимание).

### GET `/api/suppliers/analytics`

Сводка для дашборда на `/suppliers.html` (без пагинации, те же критерии отбора поставщиков, что в списке). Query: `search`, `assigned_user` (опционально, как в списке).

Ответ: `{ success, totals: { …, procurement_attention_never, procurement_attention_stale_warn, procurement_attention_stale_danger, procurement_attention_total }, by_assignee: […], by_supplier: […], ms_orders: { period_days, success_orders_total, by_creator: [{ creator_id, creator_label, orders_count, suppliers_count, positions_total }] } }` — `by_supplier` — топ **30** по `total_purchase_sum`; `ms_orders.by_creator` — успешные отправки в МС из `dg_supplier_ms_order_log` за `period_days` (90 дн.); пороги внимания: `procurement_attention_thresholds: { warn_days: 30, danger_days: 60 }`.

### GET `/api/suppliers`

Query: `search`, `assigned_user` (опционально: пусто — все; `none` — без привязки; иначе `id` пользователя из `/assignees`), `attention_only=1` — поставщики «требуют внимания»: `products_to_purchase > 0`, `total_purchase_sum > 0`, сумма ≥ `min_purchase_sum` (если мин. задан), и без успешного заказа в МС ≥30 дн. (или никогда), `limit` (default 100), `offset`, `sort_by` (`supplier_name`, `sales_rank`, `products_total`, `products_to_purchase`, `total_purchase_sum`, `min_purchase_sum`, `warehouse_fill_pct`, `stock_fill_pct`, `assigned_user_name`, `last_ms_order_at`), `sort_dir`. Для `sales_rank`: `asc` — лидеры сверху (место 1…), `desc` — слабые продажи сверху.

Ответ: `{ success, data[], total, limit, offset, applied_filters, procurement_attention_thresholds?, sales_rank_period_days, sales_rank_total, cache? }`. В каждой строке: агрегаты + `dg_supplier_settings` + `last_ms_order_at`, `last_ms_order_name`, `last_ms_order_by`, `procurement_attention: { level, code, label, days_since }`, рейтинг продаж за `sales_rank_period_days` (90): `sales_rank` (место), `sales_rank_total`, `sales_revenue_90d` — та же сортировка, что `GET /api/supplier-analysis/ranking?days=90` (выручка отгрузок МС по всем проектам, DESC). Счётчики `absence_sku_count` / `chronic_sku_count` / `flicker_sku_count` — из лога нулей за 90 дн. (диагностика). Поле **`replenishment_days`** — ручной оверрайд (только admin); авто-«рек. / Применить» на UI **нет** (рек. дни — на `/purchase.html` по SKU).

### GET `/api/suppliers/assignees`

Список пользователей `{ id, username, full_name, label, is_archived }` для select «Привязан сотрудник» в таблице.

Query: `scope` — `all` (по умолчанию, **только активные** пользователи) или `assigned` / `in_use` (уже привязанные к поставщику — для фильтра; архивные тоже попадают в список с `label` «… (архивный)»). Назначить нового архивного нельзя (`PATCH` → 400).

В списке поставщиков `assigned_user_name` для архивного сотрудника тоже с суффиксом « (архивный)».

### PATCH `/api/suppliers/:supplierKey`

Body (любое подмножество): `assigned_user_id`, `comment`, `min_purchase_sum`, `warehouse_fill_pct`, `stock_fill_pct`, `auto_mailing_enabled`, `mailing_text`, **`replenishment_days`** (`null`/пусто = как в Настройках; `0…3650` = оверрайд). Поле **`replenishment_days`** принимается **только** если актор `username === 'admin'`, иначе **403**. При изменении `stock_fill_pct` — INSERT в `dg_supplier_fill_history`.

### POST `/api/suppliers/:supplierKey/send-ms-order`

Создаёт **заказ поставщику** (`entity/purchaseorder`) в МойСклад для позиций «к закупке» (та же логика, что в Excel-выгрузке: `need_qty > 0`). Требуется `MS_TOKEN` / `config.msToken` с правами на создание заказов.

Параметры заказа:

- **Наименование:** `Имя_Фамилия_сотрудника_Поставщик_ГГГГ-ММ-ДД` — сотрудник из `dg_supplier_settings.assigned_user_id` → `users.full_name` (если не назначен — «Сотрудник»).
- **Контрагент (`agent`):** поиск контрагента по имени = `supplier_key` (trim `ms_export.supplier`).
- **Склад:** «Альмамед Ожидание».
- **Организация:** `app_settings.ms_purchase_order_organization_name` (Настройки → «Синхронизация МойСклад», по умолчанию `ООО "АЛЬМАМЕД"`), env `MS_PURCHASE_ORGANIZATION_NAME`, иначе автовыбор единственной «АЛЬМАМЕД» в списке организаций МС; при неоднозначности — `409 AMBIGUOUS_ORGANIZATION`.
- **Проведено:** `applicable: false` (черновик). Поле «Ожидание» не выставляется.
- **Позиции:** `quantity` = потребность, `price` в копейках из закупочной цены, `assortment` по `ms_export.uuid`; **`vat`** и **`vat_enabled`** — из `ms_export` / `payload_json` (как НДС в карточке товара; напр. 5, 20 или «без НДС»). Ед. изм. — из карточки в МС (`uom` в позицию не передаётся).

Успех: `{ success: true, log_id, order_name, ms_uuid, ms_href, ms_web_href, positions_count, lines_total, skipped_no_uuid[], counterparty_name, store_name, organization_name }`.

Ошибки: `503` `NO_TOKEN`; `400` `NO_LINES` / `NO_UUID`; `404` контрагент или склад; `409` `AMBIGUOUS_ORGANIZATION`; иначе текст от API МС (`502` / код ответа МС). В ответе всегда есть **`log_id`** — id строки в `dg_supplier_ms_order_log`.

**Журнал:** таблица `dg_supplier_ms_order_log` (`lib/datagonSupplierMsOrderLog.js`). На каждую попытку — одна строка + `detail_json.steps[]` (пошагово: токен, загрузка строк, сотрудник, позиции, поиск контрагента/склада/организации с кандидатами, POST в МС с `ms_errors`). В stdout: `[suppliers-ms-order] {"log_id":…,…}`.

### GET `/api/suppliers/ms-order-log`

Query: `supplier_key` (опц.), `limit` (default 20, max 100), `offset`. Список попыток без полного `detail_json`.

### GET `/api/suppliers/ms-order-log/:logId`

Детали одной попытки: `{ success, log: { …, detail: { steps: […] } } }` — для разбора, на каком шаге упало.

### GET `/api/suppliers/export/supplier` · GET `/api/suppliers/export/purchaser`

Query: `supplier_key` (обяз.), `to_purchase` (`1` по умолчанию — только позиции с потребностью &gt; 0). Ответ: файл **XLSX** (Office Open XML, расширение `.xlsx`) — открывается в Excel, LibreOffice Calc и **Numbers** на macOS. Колонка **«Наименование товаров»** — ширина ~400 px, **перенос по строкам**; числа — тип Number с форматом `# ##0` / `# ##0.00` (разделитель тысяч — пробел). В конце — строка **«Итого»** с суммами по количественным колонкам.

- **supplier** — колонки: №, Артикул, Наименование товаров, Кол-во, Ед. изм., Цена (закупочная), Итого; в **Итого** суммируются **Кол-во** и **Итого** (сумма).
- **purchaser** — №, Код, Артикул, Наименование, Поставщик, Неснижаемый остаток, Нес.остаток Датагон, Кратность, Остаток, Ожидание, Резерв, Ед. изм., Процент остатка, Кол-во, Закупочная цена, Итого; в **Итого** суммируются все количественные поля, кроме закупочной цены и процента остатка.

Логика строк — `lib/datagonSupplierExport.js` (паритет с «к закупке» на `/suppliers.html`).

Ссылки **«Поставщик»** и **«Кол-во товаров К закупке»** ведут на `/purchase.html?supplier=<ключ>&to_buy=1` — на закупках показываются только позиции этого поставщика (точное имя в `ms_export.supplier`) с потребностью &gt; 0.

Доступ: `pageKey: suppliers` (`lib/datagonPageRegistry.js`).

## Закупки

Отдельная страница `/purchase.html` и роутер `routes/purchase.js`. Источник истины базовых полей — `ms_export` (синк МойСклад). Дополнительные **редактируемые поля** (Неснижаемый остаток Датагон, Кратность товара, поле `proposed_min_stock` в закупках, Кол-во в упаковке вручную) хранятся в отдельной таблице `dg_purchase_overrides`, чтобы синк МС не затирал ручные значения и схема `ms_export` оставалась стабильной. В списке `GET /api/purchase` дополнительно отдаётся **`formula_proposed_min_stock`** — предлагаемый неснижаемый по формуле продаж (как **`formula.proposed_min_stock`** на `GET /api/product/:code`), не путать с `proposed_min_stock` из overrides; также **`recommended_replenishment_days`**, **`replenishment_days_effective`**, **`replenishment_source`** (`sku`|`supplier`|`global`) — рек. дни по коду из лога нулей автоматически поднимают `k` формулы, если выше базы. После открытия карточки товара в **`dg_formula_proposed_cache`** сохраняются **`proposed`** (уже с **`applyMinStockDgFloor`**) и **`windows_json`** — готовые **`d_15a`/`d_15b` … `d_365a`/`d_365b`** (см. `lib/datagonPurchaseWindowSnapshot.js`). При совпадении **`formula_fp` + `data_rev`** список закупок подставляет **`proposed`** без **`computeSalesFormula`** и **`windows_json`** без трёх тяжёлых агрегатов по окнам продаж/«дн. нет»; при промахе всё считается на лету, как раньше. Ревизия **`data_rev`** учитывает в т.ч. лог нулевых остатков и обновления **`dg_bundle_components`**, чтобы не отдавать устаревшие окна. **`min_stock_dg`** в опорный baseline формулы **не входит**; если в overrides задано число **> 0**, итоговое **`formula_proposed_min_stock`** (и **`formula.proposed_min_stock`** на карточке) **не ниже** этого значения — см. `applyMinStockDgFloor` в `lib/datagonSalesFormula.js`; при подстановке из кэша нижний порог по актуальному **`min_stock_dg`** в строке списка всё равно применяется в enrich. Для окон **15 / 30 / 60 / 90 / 180 / 365** дней — поля **`d_15a`, … `d_365a`**: сумма проданного количества (шт) за скользящие календарные дни (прямые отгрузки по коду + эквивалент через комплекты, для строк-комплектов только прямые). Поля **`d_15b`, `d_30b`, … `d_365b`** — число **разных календарных дат** с нулевым остатком в `dg_product_zero_stock_log` за последние N дн. (как на карточке товара). Поле **`in_transit`** — «в пути» из `payload_json.inTransit`, если есть.

Сырые поля (`article`, `packagings`, `inTransit`) подмешиваются к строкам из `ms_entity_details.payload_json` (raw карточка из МС API).

### `GET /api/purchase/managers`

Справочник для фильтра «Менеджер» на `/purchase.html`: уникальные непустые значения **`ms_export.manager`** (синк атрибута МС **«Менеджер поддерживающий товар»**), отсортированные по алфавиту.

Ответ: `{ "success": true, "managers": ["Иванов И.И.", "…"] }`.

### Таблица `dg_purchase_overrides`

```sql
CREATE TABLE dg_purchase_overrides (
  code VARCHAR(255) NOT NULL PRIMARY KEY,
  min_stock_dg DECIMAL(15,3) NULL,
  multiplicity DECIMAL(15,3) NULL,
  proposed_min_stock DECIMAL(15,3) NULL,
  pack_qty_manual DECIMAL(15,3) NULL,
  note VARCHAR(500) NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);
```

Связь с `ms_export` — по `code` (то есть по коду товара МС, как в остальных интеграциях Datagon).

### Таблица `dg_formula_proposed_cache`

Кэш с карточки товара для списка закупок: **`proposed`** — «предлагаемый неснижаемый» после `applyMinStockDgFloor`; **`windows_json`** — снимок колонок **`d_15a`/`d_15b` … `d_365a`/`d_365b`** (та же логика, что `lib/datagonPurchaseWindowSnapshot.js` / enrich закупок). Запись создаётся/обновляется при успешном **`GET /api/product/:code`**. Колонки **`formula_fp`** и **`data_rev`** должны совпадать с запросом списка закупок, иначе строка не используется и значения пересчитываются.

```sql
CREATE TABLE dg_formula_proposed_cache (
  code VARCHAR(255) NOT NULL PRIMARY KEY,
  proposed DECIMAL(18,6) NULL,
  formula_fp VARCHAR(768) NOT NULL DEFAULT '',
  data_rev VARCHAR(768) NOT NULL DEFAULT '',
  windows_json JSON NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_dg_formula_cache_fp_rev (formula_fp(191), data_rev(191))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

### Таблица `dg_purchase_overrides_log`

Журнал **только** для полей: `min_stock_dg`, `multiplicity`. Запись добавляется при реальном изменении значения из UI (ячейка таблицы на `/purchase.html`, `source=override`) или при пакетном импорте CSV (`source=import`). Поля `changed_by_user_id` / `changed_by_name` заполняются из `req.datagonActor`, если он есть.

```sql
CREATE TABLE dg_purchase_overrides_log (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  code VARCHAR(255) NOT NULL,
  field VARCHAR(64) NOT NULL,
  old_value VARCHAR(255) NULL,
  new_value VARCHAR(255) NULL,
  source VARCHAR(32) NOT NULL DEFAULT 'override',
  changed_by_user_id INT NULL,
  changed_by_name VARCHAR(255) NULL,
  changed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

### GET `/api/purchase/log`

Query: **`code`** (обязателен), **`limit`** (default 100, max 500), **`offset`**, опционально **`field`** — фильтр по одному из полей `min_stock_dg` / `multiplicity`.

Ответ: `{ success, code, rows[], total, limit, offset }`. В каждой строке `rows` есть `field_label` (человекочитаемо).

### GET `/api/purchase/log/stats`

Сводка по таблице журнала: `total`, `oldest_at`, `newest_at`, `by_source` (`override` / `import`), `retention_days` (из `app_settings.dg_purchase_overrides_log_retention_days`), `older_than_retention`.

### POST `/api/purchase/log/cleanup`

Тело JSON: опционально `{ "days": N }`; если не передано — используется текущий retention из настроек. Ответ: `{ success, deleted, days }`.

### Перенос «Предлагаемый нес.ост.» → «Неснижаемый» (МС)

Пакетное обновление **`ms_export.min_stock`** из рассчитанного **`formula_proposed_min_stock`** (после `applyMinStockDgFloor`, округление до целого ≥ 0). Снимок старых значений — в **`dg_purchase_min_stock_apply_item`**; откат — **целиком по пакету** (`batch_id`), не по отдельным SKU.

Таблицы: **`dg_purchase_min_stock_apply_batch`** (статус `running` | `completed` | `failed` | `reverted`, счётчики, `filter_json`, автор, время) и **`dg_purchase_min_stock_apply_item`** (`batch_id`, `code`, `old_min_stock`, `new_min_stock`, `formula_proposed`).

На `/purchase.html` кнопка **«Пр.→НС»** рядом с «Пересчитать кэш»; журнал переноса и «Откатить» — в блоке «Перенос в неснижаемый (МС)». Кнопка **«Пересчитать кэш»** ставит задачу `purchase_formula_cache` (`POST /api/settings/auto-sync-run`); ход пересчёта на странице — опрос **`GET /api/purchase/formula-cache-progress`** (живой прогресс в памяти процесса + последняя строка `auto_sync_runs`).

#### GET `/api/purchase/formula-cache-progress`

Ответ: `{ "success", "running", "live": { "running", "processed", "upserted", "errors", "selection_total", "pct", "message", … }, "db_run": { "id", "status", "message", "trigger_type", "started_at", "finished_at", … } }`. Пока batch `runPurchaseFormulaCacheBatch` выполняется в том же Node, `live` обновляется по чанкам; `auto_sync_runs.message` для `task_type=purchase_formula_cache` дополняется не чаще раза в ~2 с.

#### POST `/api/purchase/min-stock-apply/run`

Тело JSON: `{ "filters": { … } }` — те же query-ключи, что у **`GET /api/purchase`** (без `limit` / `offset` / `sort_*`). Если `filters` пустой — дефолтная выборка закупок (по умолчанию склад.поз. «Да», не архив, тип «Товар»).

Для каждой позиции с расхождением «предлагаемый» → «неснижаемый»: только **`UPDATE ms_export.min_stock`** (колонка «Неснижаемый остаток» в Datagon). **Без** вызова API МойСклад — выгрузка в МС отдельно: **`auto_sync_min_stock_export_*`** / «Запустить сейчас» в Настройках → Экспорт в МС.

Ответ сразу: `{ "success": true, "batch_id": N, "status": "running" }`. Обработка — в фоне; прогресс — **`GET /min-stock-apply/batch/:id`** или **`GET /min-stock-apply/log`**. Одновременно только один активный перенос (`409`, если уже `running`).

#### GET `/api/purchase/min-stock-apply/log`

Query: `limit` (default 12, max 50). Ответ: `{ "success", "batches": [ { "id", "status", "rows_updated", "rows_unchanged", "rows_skipped", "created_at", "finished_at", "can_revert", … } ] }`.

#### GET `/api/purchase/min-stock-apply/batch/:id`

Один пакет (для опроса статуса).

#### GET `/api/purchase/min-stock-apply/batch/:id/items`

Строки изменений пакета для журнала на `/purchase.html`: `{ code, name, old_min_stock, new_min_stock, formula_proposed }`. Query: `limit` (default 200, max 500), `offset`.

#### POST `/api/purchase/min-stock-apply/revert`

Тело: `{ "batch_id": N }`. Восстанавливает `ms_export.min_stock` из `old_min_stock` (только БД); помечает batch `reverted`. Только для `status=completed`.

### GET `/api/purchase/summary-totals`

Те же query-параметры, что у **`GET /api/purchase`**, **без** `limit` / `offset` / `sort_*`. Полный enrich по формуле для карточки «Сводка по фильтру» (`kpi_totals`), без пагинации списка. Вызывается с `/purchase.html` в фоне, если в ответе списка `formula_kpi_approximate: true` (выборка &gt; 2500 поз. — SQL-итог по кэшу формулы может быть занижен).

Ответ: `{ "success", "total", "kpi_totals", "kpi_totals_source": "enriched", "formula_kpi_approximate": false }` или при `total` &gt; 6000: `{ "success", "total", "too_large": true, "formula_kpi_approximate": true }` (UI оставляет ориентировочные цифры с префиксом `~`).

### GET `/api/purchase`

Список товаров для планирования закупок. **Пагинация и сортировка в MySQL:** параллельно `COUNT(*)` и `SELECT … ORDER BY <колонка> LIMIT ? OFFSET ?`. Обогащение (`enrichPurchaseListPage`) — **только для строк текущей страницы** (~`limit` кодов), **без** `payload_json` в списке и **без** bundle-warmup на list (`skipBundleWarmup: true`).

Для каждой строки при совпадении **`formula_fp` + `data_rev`** в **`dg_formula_proposed_cache`** в SQL-списке подставляются **`formula_cached_proposed`** / **`windows_json`** (LEFT JOIN); кэш заполняют **`GET /api/product/:code`**, batch **`purchase_formula_cache`** и `runPurchaseFormulaCacheBatch`.

**Сортировка по `formula_proposed_min_stock` и `d_*a` / `d_*b`:** не по SQL-кэшу на одной странице — загружается выборка по фильтрам, **`enrichPurchaseListPage` для всех строк**, затем сортировка в Node по **фактическим** значению в ячейке (`column_totals_source: "enriched"`, `cache.source: "enriched"`). Иначе при неполном `dg_formula_proposed_cache` порядок в таблице не совпадал с числами в колонке. Обычные колонки (`code`, `stock`, `min_stock`, …) по-прежнему **`ORDER BY` в MySQL** + enrich только текущей страницы.

**`cache` в ответе (опционально):** `{ "source": "sql"|"enriched"|"memory", "sort_profile": "fast"|"heavy", "age_ms", "ttl_ms", "note" }`. Повторные идентичные запросы в течение ~90 с могут отдаваться из in-memory кэша (`purchaseListResponseCache` в `routes/purchase.js`). Замер с разбивкой `_bench` (data_rev / count / list_sql / enrich): `npm run bench:purchase-list-sql`.

**Фильтр по умолчанию (как в ТЗ страницы):**

- `is_archived = 0` (только активные);
- `stock_position = 'да'` (только складская позиция);
- `type` ≠ комплект (исключаем комплекты).

Query:

- `search` — умный поиск (case-insensitive): `code`, **`ms_entity_details.denorm_article`** (артикул МС), `name`, `supplier`, `supplier2`. **Несколько слов через пробел** — каждое слово должно встретиться (AND) хотя бы в одном из полей; группы через `|` — OR; префиксы `code:`, `name:`, `supplier:`, `article:`. Для артикула с дефисами дополнительно «компактный» вариант без `-`/`_`/пробелов (`A27541` ↔ `A-27541`) по коду и артикулу.
- `manager` — **точное** совпадение с `TRIM(ms_export.manager)` (свойство МС «Менеджер поддерживающий товар»; на `/purchase.html` — выбор из списка `GET /api/purchase/managers`).

Ответ `GET /api/purchase` дополнительно содержит **`kpi_totals`** (для сводки; при `to_purchase` / `to_buy` — по **полному** фильтру, не только по строкам «к закупке») и **`column_totals`** (для строки «Σ по фильтру» внизу таблицы) с полями **`stock_value_rub`**, **`min_stock_value_rub`**, **`formula_proposed_value_rub`** (Σ количество × закупочная цена из МС) и **`positions_without_buy_price`**. При выборке &gt; 2500 поз. без режима «К закупке»: `formula_kpi_approximate: true` — ориентировочный «Предлагаемый нес.ост.» из SQL; фронт догружает **`GET /api/purchase/summary-totals`**. Карточка «Сводка по фильтру» на `/purchase.html` показывает эти три суммы.
- `supplier` — фильтр по поставщику: по умолчанию подстрока в `supplier` **или** `supplier2` (case-insensitive). При **`supplier_exact=1`** или **`to_buy=1`** — только **`TRIM(ms_export.supplier)`** (точное совпадение, как в реестре «Поставщики»).
- `supplier_key` — синоним `supplier` (для ссылок с `/suppliers.html`).
- `to_purchase` — `1`: только позиции с потребностью к закупке (`GREATEST(0, ms_export.min_stock − stock − в_пути) > 0` — **только** поле «Неснижаемый остаток» из МС, без override и без «Предлагаемый нес.ост.»; см. `SUPPLIER_NEED_QTY_SQL` в `lib/datagonSuppliersSql.js`). На `/purchase.html` после «Ожидание» колонка **«К закупке»**.
- `to_buy` — `1`: режим перехода с «Поставщики» — включает `to_purchase=1`, `supplier_exact=1` и дефолтные отборы (активные, складская позиция, не «перестали сотрудничать»). Короткая ссылка: `/purchase.html?supplier=…&to_buy=1`.
- `archived` — `active` (default) | `archived` | `all`.
- `stock_position` — `yes` (default) | `no` | `all`.
- `no_longer_cooperation` — опционально; **по умолчанию** (если параметр не передан) — `not_stopped` (в МС значение не «Да»; в UI закупок — **Нет**). Явно: `all` (без отбора; в UI — **Все**) | `not_stopped` | `stopped` (в МС «Да»; в UI — **Да**).
- `include_bundles` — `0` (default, исключить комплекты) | `1` (включить).
- `only_stock` — `1` чтобы оставить только `stock > 0`.
- `zero_stock` — `1`: остаток `stock ≤ 0` (нулевой / отрицательный в выгрузке МС).
- `zero_stock_no_transit` — `1`: `stock ≤ 0` и «В пути» ≤ 0 (`COALESCE(ms_entity_details.denorm_in_transit, … JSON из payload …)`).
- `no_multiplicity` — `1`: в `dg_purchase_overrides` кратность пустая или &lt; 1 шт.
- `incomplete_pack` — `1`: кратность ≥ 1, `stock ≥ кратность` и остаток **не кратен** кратности (хвост после полных упаковок; `1` шт при кратности `2` **не** попадает). Базовый код с «код-число» и `stock < min(суффикс)` — отсутствие комплекта, в фильтр не входит.
- `ms_formula_diff` — `1`: только позиции, где **неснижаемый остаток МС** (целое) ≠ **предлагаемый нес.ост.** по формуле после полного enrich (как в шкале «Расхождение» в сводке), а не только по устаревшему SQL-кэшу; строки без посчитанной формулы не попадают. Список строится через enrich всей выборки (`column_totals_source: "enriched"`). На `/purchase.html` — отдельный селект **«Расхождение НС»**. В ответе: `ms_formula_diff_active: true`.
- `limit` (default 100, max 1000), `offset`.
- `sort_by` — `code` (default), `article`, `name`, `supplier`, `price_comment`, `buy_price`, `min_stock`, **`formula_proposed_min_stock`**, **`formula_ms_diff_qty`**, **`formula_ms_diff_sum`**, `automation_price`, `proposed_min_stock`, `min_stock_dg`, `multiplicity`, `stock`, `is_archived`, **`in_transit`**, **`d_15a`**, **`d_15b`**, **`d_30a`**, **`d_30b`**, **`d_60a`**, **`d_60b`**, **`d_90a`**, **`d_90b`**, **`d_180a`**, **`d_180b`**, **`d_365a`**, **`d_365b`**.
- `sort_dir` — `asc` (default) | `desc`.

Сортировка по **`formula_proposed_min_stock`** и **`d_*`** в SQL использует поля из **`dg_formula_proposed_cache`**; без кэша — NULL в ключе сортировки (см. выше). Остальные `sort_by` мапятся на колонки `ms_export` / `dg_purchase_overrides` / `med.denorm_article` и т.д. (см. `buildPurchaseSqlOrderBy` в `routes/purchase.js`).

Локальный замер без HTTP: `npm run bench:purchase-list-sql` (скрипт `scripts/purchase-list-sql-bench.cjs`, читает `config.js` и вызывает тот же `purchaseListQueryPaged`).

Ответ: **`column_totals`** — суммы по **всем** строкам текущего фильтра (не только текущая страница): `positions_count` (число позиций, должно совпадать с `total`), `min_stock`, `formula_proposed_min_stock`, **`formula_ms_diff_qty`**, **`formula_ms_diff_sum`**, `stock`, `in_transit`, `to_purchase_qty`. Источник: `column_totals_source` — `enriched` (после пересчёта формулы и «К закупке», как в ячейках; обязательно при `to_purchase` / `to_buy`) или `sql` (только для очень больших выборок без режима «К закупке»). На `/purchase.html` — строка **«Σ по фильтру»** внизу таблицы.

```json
{
  "success": true,
  "total": 1234,
  "limit": 100,
  "offset": 0,
  "sort_by": "code",
  "sort_dir": "asc",
  "to_purchase_active": true,
  "column_totals": {
    "positions_count": 1234,
    "min_stock": 1200,
    "formula_proposed_min_stock": 980,
    "formula_ms_diff_qty": 45,
    "formula_ms_diff_sum": 125000.5,
    "stock": 5400,
    "in_transit": 320,
    "to_purchase_qty": 150
  },
  "data": [
    {
      "code": "00-12345", "article": "AB-001",
      "name": "Радиатор Х", "is_archived": 0, "type": "Товар", "uuid": "…",
      "supplier": "Вектор", "supplier2": "Вектор", "supplier_label": "Вектор",
      "buy_price": "12 345,67 ₽",
      "min_stock": "10.000",
      "formula_proposed_min_stock": 12,
      "formula_ms_diff_qty": 2,
      "formula_ms_diff_sum": 24691.34,
      "automation_price": "Авто",
      "proposed_min_stock": null,
      "min_stock_dg": "5.000",
      "multiplicity": "10.000",
      "pack_qty": 6, "pack_qty_auto": 6, "pack_qty_manual": null,
      "stock": 42,
      "in_transit": 0,
      "purchase_target_stock": 12,
      "to_purchase_qty": 0,
      "no_longer_cooperation": "", "stock_position": "Да",
      "override_updated_at": "2026-05-12 19:01:23",
      "d_15a": 4.5, "d_15b": 0, "d_30a": 12, "d_30b": 2,
      "d_60a": 20, "d_60b": 3, "d_90a": 25, "d_90b": 4, "d_180a": 40, "d_180b": 5, "d_365a": 80, "d_365b": 8
    }
  ]
}
```

Колонки `supplier_label`:

- если `supplier == supplier2` (case-insensitive, без учёта пробелов) — выводится один раз;
- если различаются — `supplier1/supplier2`;
- если задан только один — он один и выводится.

Колонка `pack_qty` — если есть `pack_qty_manual` (override), он имеет приоритет; иначе — авто-подсчёт по первому `packagings[].quantity > 0` из `ms_entity_details.payload_json`.

### POST `/api/purchase/override`

Сохранить одно редактируемое значение для одного товара. Body (JSON):

```json
{ "code": "00-12345", "field": "min_stock_dg", "value": "5,5" }
```

`field` ограничен whitelist'ом: `min_stock_dg` | `multiplicity` | `proposed_min_stock` | `pack_qty_manual`. Значения парсятся гибко (запятая = точка, пробелы игнорируются). Передача `value: ""` (или `null`) очищает поле в overrides (NULL).

Для полей **`min_stock_dg`**, **`multiplicity`** при фактическом изменении значения сервер дополнительно пишет строку в **`dg_purchase_overrides_log`** (`source=override`).

Ответ при успехе содержит `stored` — текущее состояние строки `dg_purchase_overrides` для этого `code`, что позволяет UI **верифицировать** реальное значение в БД (по правилу `datagon-settings-save-feedback.mdc`).

### POST `/api/purchase/overrides-import`

Пакетное обновление **`min_stock_dg`**, **`multiplicity`** из CSV (тело JSON, до ~12 МБ). На странице `/purchase.html` кнопок импорта нет — вызов из скриптов, Postman или внутренних утилит.

```json
{ "csv": "Код;Нес.остаток Датагон;Кратность товара\n00-1;10;2\n" }
```

- Первая строка — заголовки. Разделитель **`;`** или **`,`** выбирается по большинству в первой строке.
- Обязательна колонка **кода** товара (`code`, `Код`, `артикул`, …). Должна присутствовать **хотя бы одна** из колонок двух полей (русские подписи как в UI).
- Пустая ячейка, `-` или `—` — записать **NULL** в соответствующее поле override для этой строки.
- Строки с кодом, которого **нет** в `ms_export`, пропускаются (счётчик `skipped_unknown_code`, примеры в `unknown_codes_sample`).

Ответ при успехе: `{ "success": true, "rows_read", "rows_upserted", "skipped_unknown_code", "unknown_codes_sample" }`. Ошибки разбора CSV — `400` с текстом, начинающимся с `CSV:` или `Слишком`.

По каждой строке CSV и каждому из полей, которое реально изменилось, добавляется запись в **`dg_purchase_overrides_log`** с `source=import` (при отсутствии актёра в запросе поля пользователя в логе могут быть пустыми).

### Заметки

- Доступ контролируется через `lib/datagonPageRegistry.js` (`pageKey: 'purchase'`, prefix `/purchase`).
- Изменение списка/фильтров/сортировки на UI — только по кнопке «Применить» / Enter (правило `datagon-table-filter-apply.mdc`); отдельные ячейки overrides сохраняются точечно по событию `change` (одиночное действие пользователя).

## Карточка товара

Детальная страница товара `/product.html?code=XXX` (открывается из «Закупки» в новом окне). Бэкенд агрегирует данные из `ms_export`, `ms_entity_details` (полный JSON-payload), `ms_demand`/`ms_demand_position` (продажи), `dg_product_zero_stock_log` (дни отсутствия товара на складе по выгрузке МС) и при наличии — последний срез `dg_product_zero_stock_window_import` (импорт сводки по окнам из Excel).

### Схема `dg_product_zero_stock_window_import`

Создаётся при первом импорте. Одна строка на пару **`(reference_date, code)`**: сколько **календарных** дней с нулевым остатком попало в скользящие окна 30 / 60 / 90 / 180 / 365 относительно **`reference_date`** (дата среза сводки в Excel). Повторный импорт с тем же `reference_date` и кодом **перезаписывает** числа. Не заменяет построчный лог `dg_product_zero_stock_log` (для него нужны конкретные даты).

```sql
CREATE TABLE IF NOT EXISTS dg_product_zero_stock_window_import (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  reference_date DATE NOT NULL,
  code VARCHAR(255) NOT NULL,
  absent_last_30 INT NOT NULL DEFAULT 0,
  absent_last_60 INT NOT NULL DEFAULT 0,
  absent_last_90 INT NOT NULL DEFAULT 0,
  absent_last_180 INT NOT NULL DEFAULT 0,
  absent_last_365 INT NOT NULL DEFAULT 0,
  note VARCHAR(512) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_zero_win_ref_code (reference_date, code),
  INDEX idx_zero_win_code_ref (code, reference_date)
);
```

### POST `/api/product/zero-stock-windows-import`

Импорт исторической сводки (как в Excel: колонка кода + пять окон). Доступ тот же, что у `/api/product/*` (`pageKey: 'purchase'`). Повторные импорты — см. скрипт `scripts/import-zero-stock-windows-csv.mjs` или любой клиент с `POST` и JSON-телом.

Body (JSON, до ~25 МБ):

- **`reference_date`** (обязательно) — `YYYY-MM-DD`, дата среза, на которую в Excel посчитаны окна «последние N дней».
- **`note`** (опционально) — комментарий к партии импорта (до 512 символов).
- **`rows`** — массив объектов `{ "code", "absent_last_30", "absent_last_60", "absent_last_90", "absent_last_180", "absent_last_365" }` (числа целые ≥ 0, макс. 366 на поле). **Или**
- **`csv`** — одна строка UTF-8: первая строка заголовков, далее данные. Разделитель **`;`** или **`,`** (если в первой строке ≥ 6 полей через `;`, берётся `;`). В шапке должны быть колонка кода (`code` / `код` / …) и все пять окон — либо числами **`30`**, **`60`**, **`90`**, **`180`**, **`365`**, либо именами `absent_last_30` … `absent_last_365`.

Ответ: `{ success, reference_date, rows_upserted, note }`.

### Схема `dg_product_zero_stock_log`

Создаётся автоматически при первом обращении (`ensureZeroStockSchema`). Хранит факты «товар отсутствовал на складе на дату». Сейчас общая фиксация по товару (`store_uuid='__total__'`); по-складская разбивка — после `report/stock/bystore`. Поле `source`: `manual` — кнопка / `POST …/zero-stock-log`; `moysklad_sync` — пакетно **после успешного сохранения** `ms_export` при синке МойСклад (только `stock_position='Да'`, `is_archived=0`, **остаток ≤ 0** или для кода **без** «-» в номенклатуре **остаток &lt; минимального числового суффикса** среди строк `ms_export` с кодом вида `<тот же код>-<целое>` за **сегодня**; строка с `manual` за тот же день не перезаписывается).

```sql
CREATE TABLE IF NOT EXISTS dg_product_zero_stock_log (
  id INT AUTO_INCREMENT PRIMARY KEY,
  code VARCHAR(255) NOT NULL,
  store_uuid VARCHAR(255) NOT NULL DEFAULT '__total__',
  store_name VARCHAR(255) NULL,
  ts_date DATE NOT NULL,
  total_stock DECIMAL(15,3) NULL,
  source VARCHAR(40) NOT NULL DEFAULT 'manual',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_zero_code_store_date (code, store_uuid, ts_date),
  INDEX idx_zero_code_date (code, ts_date)
);
```

### Схема `dg_product_stock_snapshot`

Создаётся автоматически (`ensureProductStockSnapshotSchema`). После каждого успешного полного синка МС выполняется `INSERT … SELECT` из `ms_export`: по каждому `code` одна строка на **`CURDATE()`** с полем `stock` (агрегат по выгрузке, как в таблице МойСклад в Datagon). Повторный синк в тот же день обновляет число. Строки старше порога **`product_stock_snapshot_retention_days`** (настройки Datagon, по умолчанию **365** дней, диапазон 30…3650) удаляются при синке. Для карточки товара см. `GET /api/product/:code` → `stock_snapshots`.

```sql
CREATE TABLE IF NOT EXISTS dg_product_stock_snapshot (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  code VARCHAR(255) NOT NULL,
  ts_date DATE NOT NULL,
  stock DECIMAL(15,3) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_snap_code_date (code, ts_date),
  INDEX idx_snap_date (ts_date),
  INDEX idx_snap_code_date2 (code, ts_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

### GET `/api/product/:code`

Агрегатный read-only ответ для рендера карточки.

Query:

- `recent_page` — номер страницы для блока «Последние отгрузки» (default 1).
- `recent_page_size` — размер страницы (10…200, default 100). Полный список за период — листая страницы или увеличив `recent_page_size`.
- `recent_via` — фильтр строк отгрузок: `all` (все) | `direct` (только прямые позиции по коду) | `bundle` (только эквивалент через комплекты; для карточки комплекта ветка через комплекты отключена на бэкенде).
- `recent_bundle_code` — при `recent_via=bundle` ограничить одним **кодом из строки отгрузки** (как правило код комплекта в МС; можно передать любой код, совпадающий с `bundle_code` в объединённой выборке). Без параметра — все комплекты в окне.
- `sales_from`, `sales_to` — даты **`YYYY-MM-DD`** (включительно). Если обе валидны и `from <= to`, окно продаж **календарное** (графики, сводки, `recent`, `via_bundles`); максимум 1825 дней между датами. Фильтр по дате отгрузки в SQL — **`DATE(d.moment)`** между этими днями (время суток из UI в query **не** передаётся; сравнение с отчётом МС «по часам» может расходиться на границах суток). Иначе используется скользящее окно `recent_days`.
- `recent_days` — скользящее окно в днях от `NOW()`, если **не** задана пара `sales_from`+`sales_to` (default 365, max 1825).
- `sales_scope` — для блока «Продажи товара» и `GET …/recent-shipments`: `all` (все проекты отгрузок, default) | `formula` (только `project_uuid` из `sales_formula_project_uuids`, как в формуле). В ответе карточки: `sales` — всегда «все»; при `sales_formula_project_mode=selected` дополнительно `sales_formula_scope` (тот же объект, что `sales`, но с фильтром) и `sales_scope_meta.formula_label` (подпись с **названиями** проектов).
- `zero_days` — окно для лога нулевых остатков (default 90, max 1825).
- `stock_snapshot_days` — глубина в **календарных днях** для блока **`stock_snapshots.rows`** (снимки `dg_product_stock_snapshot` от `CURDATE()` назад; max **730** и не больше **`stock_snapshots.retention_days`** из настроек; если query **нет** — берётся **min(730, retention)**; в выборке не более **400** строк на ответ).
- **`purchase_overrides_editable`** — `true`, если у текущего пользователя для раздела «Закупки» в матрице прав стоит **полный** доступ (`page_modes.purchase === 'full'`); иначе `false` — карточка товара не должна вызывать `POST /api/purchase/override` (режим только просмотра вернёт `403` с `code: PAGE_VIEW_ONLY`).

Ответ (сжатая структура):

```json
{
  "success": true,
  "code": "10148",
  "purchase_overrides_editable": true,
  "ms": {
    "code": "10148", "uuid": "…", "article": "AB-001", "name": "Радиатор Х",
    "type": "Товар", "is_archived": 0,
    "supplier": "Вектор", "supplier2": "Вектор", "supplier_label": "Вектор",
    "stock_position": "Да", "manager": "…", "vat": "20%",
    "buy_price": "12 345,67 ₽", "min_stock": 10, "stock": 42,
    "synced_at": "2026-05-12T17:00:00.000Z",
    "web_href": "https://online.moysklad.ru/app/#good/edit?id=…",
    "attributes": [{ "name": "Бренд", "value": "Acme", "type": "string" }],
    "packagings": [{ "name": "Коробка", "quantity": 6, "barcodes": ["…"] }],
    "barcodes": ["EAN13: 4607000000000"],
    "images": ["https://…"]
  },
  "override": {
    "code": "10148", "min_stock_dg": 5, "multiplicity": 10,
    "proposed_min_stock": null,
    "pack_qty_manual": null, "note": null, "updated_at": "…"
  },
  "prices": [
    { "kind": "buy", "name": "Закупочная цена", "value": 123.45, "currency": "RUB" },
    { "kind": "sale", "name": "Розница", "value": 199.0, "currency": "RUB" }
  ],
  "stock": { "stock": 42, "reserve": null, "in_transit": null, "min_stock": 10 },
  "sales": {
    "aggregates": {
      "d3":   { "days": 3,   "sum_qty": 0, "sum_amount": 0,   "positions": 0, "avg_per_day": 0 },
      "d365": { "days": 365, "sum_qty": 152, "sum_amount": 30000, "positions": 47, "avg_per_day": 0.416 }
    },
    "recent": [
      { "demand_uuid": "…", "doc_name": "О-001", "moment": "…", "applicable": true,
        "agent_name": "Иван И.", "store_name": "Основной склад", "position_uuid": "…",
        "assortment_kind": "product", "via": "direct",
        "bundle_code": "", "bundle_name": "", "bundle_qty": null, "qty_per_bundle": null,
        "quantity": 1, "price": 199, "sum": 199 },
      { "demand_uuid": "…", "doc_name": "О-002", "moment": "…", "applicable": true,
        "agent_name": "…", "store_name": "…", "position_uuid": "…",
        "assortment_kind": "bundle", "via": "bundle",
        "bundle_code": "27877-10", "bundle_name": "Комплект …", "bundle_qty": 2, "qty_per_bundle": 10,
        "quantity": 20, "price": 12.5, "sum": 250 }
    ],
    "recent_days": 365,
    "recent_page": 1, "recent_page_size": 100, "recent_total": 240, "recent_total_pages": 3,
    "recent_via": "all", "recent_bundle_code": "",
    "recent_bundle_codes": [{ "bundle_code": "27877-10", "bundle_name": "…" }],
    "sales_window": { "mode": "range", "sales_from": "2026-04-01", "sales_to": "2026-04-30" },
    "includes_via_bundles": true,
    "via_bundles": [
      { "bundle_code": "27877-10", "bundle_name": "…", "is_archived": 0,
        "positions": 5, "sold_bundles": 12, "equivalent_qty": 120, "equivalent_amount": 15000 }
    ],
    "note": "Графики, сводка за период и «Последние отгрузки» — только проведённые отгрузки; прямые + эквивалент через комплекты (состав из МС).",
    "direct_period": { "sum_qty": 10, "sum_amount": 9999, "positions": 5 },
    "bundles_period": { "sum_qty": 20, "sum_amount": 15000, "positions": 3 },
    "monthly": [
      { "month": "2025-06", "sum_qty": 0,   "sum_amount": 0,    "positions": 0 },
      { "month": "2025-12", "sum_qty": 3,   "sum_amount": 21514.82, "positions": 3 },
      { "month": "2026-05", "sum_qty": 1,   "sum_amount": 8011.35,  "positions": 1 }
    ],
    "by_agent": [
      { "label": "ООО \"ИНТЕРНЕТ РЕШЕНИЯ\"", "sum_qty": 3, "sum_amount": 20899.19, "positions": 3 },
      { "label": "ООО \"ВАЙЛДБЕРРИЗ\"",       "sum_qty": 2, "sum_amount": 16236.98, "positions": 2 }
    ],
    "by_store": [
      { "label": "Альмамед", "sum_qty": 5, "sum_amount": 37136.17, "positions": 5 }
    ]
  },
  "zero_stock": {
    "days": 90,
    "rows": [
      { "id": 1, "store_uuid": "__total__", "store_name": null,
        "ts_date": "2026-05-12", "total_stock": 0, "source": "moysklad_sync",
        "created_at": "2026-05-12T19:00:00.000Z" }
    ],
    "note": "По аналогии с продажами (только проведённые отгрузки), здесь — только факты из выгрузки МС: после успешного синка за сегодня автоматически пишется строка при складской позиции «Да», не архив и (остаток ≤ 0 или для кода без «-» остаток < минимального суффикса в кодах «код-число»). Ручная запись за тот же день автоматикой не перезаписывается."
  },
  "zero_stock_windows_from_log": {
    "reference_date": "2026-05-14",
    "absent_last_30": 1, "absent_last_60": 2, "absent_last_90": 3,
    "absent_last_180": 3, "absent_last_365": 3,
    "source": "zero_log",
    "note_explain": "Расчёт по логу Datagon: COUNT(DISTINCT ts_date) по скользящим окнам до CURDATE()."
  },
  "zero_stock_windows_import": {
    "reference_date": "2026-01-15",
    "absent_last_30": 2, "absent_last_60": 5, "absent_last_90": 8,
    "absent_last_180": 12, "absent_last_365": 40,
    "note": "Выгрузка из Excel за 15.01.2026",
    "created_at": "2026-01-16T10:00:00.000Z",
    "note_explain": "Импортированная сводка: числа — сколько дней с нулевым остатком в каждом скользящем окне относительно даты среза. Это не список конкретных календарных дней."
  },
  "stock_snapshots": {
    "days": 365,
    "retention_days": 365,
    "rows": [
      { "ts_date": "2026-05-14", "stock": 42, "created_at": "2026-05-14T08:15:00.000Z" },
      { "ts_date": "2026-05-13", "stock": 40, "created_at": "2026-05-13T07:55:00.000Z" }
    ],
    "note": "По одному значению stock из ms_export на календарный день после полного синка МС; глубина и хранение согласованы с retention_days (настройки)."
  },
  "formula": {
    "proposed_min_stock": 12,
    "settings_effective": { "replenishmentCoef": 0.142, "salesWindowDays": 90, "absenceAnalysisDays": 210 },
    "inputs": {
      "sales_window_days": 90,
      "sum_qty_window": 1200,
      "avg_daily_window": 13.33,
      "absence_analysis_days": 210,
      "sum_qty_absence_window": 21370,
      "avg_daily_absence_window": 101.76,
      "absence_distinct_days": 14,
      "prev_baseline": 1800,
      "prev_baseline_source": "ms_export.min_stock",
      "stock_qty": 42
    },
    "warnings": [],
    "detail": {
      "equation_stages": [
        {
          "id": "avg_daily",
          "order": 1,
          "title": "Этап 1. Средние продажи",
          "template": "Продажи за A дн. ÷ A",
          "values": "36 ÷ 90 = 0.4 шт/день",
          "note": "…"
        }
      ]
    },
    "note": "Длина периода продаж и коэффициенты задаются в «Настройки» → «Формула продаж / закупки»."
  }
}
```

Возвращает `404`, если в `ms_export` нет товара с указанным `code`.

Объект **`formula`**: `proposed_min_stock` (целое, шт), `settings_effective`, `inputs`, `warnings`, `detail` (этапы и контекстные строки). В **v2** в `inputs` дополнительно могут быть `missed_sales_equiv`, `adjusted_sales_sum`, `rare_short_circuit`, `expensive_applied`, `draft_pre_pack` (черновик до кратности), `pack_round_raw`, **`mult_floor_applied`** (поднятие до кратности из закупок: в нередкой ветке — при положительном черновике ×k или при ненулевой сумме с учётом отсутствий при кратности ≥ 1 шт, в т.ч. при k=0; в **редкой** ветке (`rare_short_circuit`) — после «базового для редких» и макс. скачка, если кратность ≥ 1). Поле **`absence_distinct_days`** — итог для периода A (слияние лога и импорта окон, см. `lib/datagonZeroStockAbsence.js`). Поле **`detail`** для карточки: **`equation_stages`** — пошаговый разбор; **`formula_context_lines`** — сводка чисел. Логика в `lib/datagonSalesFormula.js`. Если в **`dg_purchase_overrides.min_stock_dg`** задано значение **> 0**, **`proposed_min_stock`** в ответе **не ниже** него (после расчёта формулы; предупреждение может появиться в **`warnings`**); это поле **не** подставляется как опорный baseline для шагов формулы.

- `zero_stock` — `{ days, rows, note }`: построчный лог за запрошенную глубину; `note` — пояснение для UI (как заполняется лог автоматически после синка МС и зачем ручная кнопка).
- `zero_stock_windows_from_log` — **расчёт для UI**: `absent_last_30` … `absent_last_365` из `dg_product_zero_stock_log` (разные `ts_date` в скользящих окнах до `CURDATE()`), поле `source: "zero_log"`, `reference_date` = сегодня по серверу.
- `zero_stock_windows_import` — последняя по дате среза (`reference_date`) запись из `dg_product_zero_stock_window_import` для этого кода (пакетный импорт Excel), либо `null`; для **формулы** и закупок используется в `mergeAbsenceDistinctForFormula` вместе с логом. Поле `note_explain` — подсказка для UI.
- **`stock_snapshots`** — `{ days, retention_days, rows, note }`: история **`ms_export.stock`** по дням из `dg_product_stock_snapshot` за запрошенную глубину (`stock_snapshot_days`, не больше `retention_days` и 730); **`retention_days`** — эффективный срок хранения из `app_settings.product_stock_snapshot_retention_days` (30…3650); `rows[]` — `{ ts_date, stock, created_at }` (даты **`YYYY-MM-DD`**, `created_at` — ISO-время записи/обновления строки в БД).

Поля раздела `sales` (для графиков на UI):

- `includes_via_bundles` — `false` для карточки **комплекта** (тип МС содержит «комплект»): эквивалент через другие комплекты не считается; `true` для обычного товара — агрегаты, `monthly`, `by_agent` / `by_store`, `recent` объединяют прямые строки и эквивалент из позиций, где в отгрузке указан **код комплекта**, а текущий товар входит в состав (кэш `dg_bundle_components`, строки из `components` payload МС).
- `sales_window` — `{ mode: "range"|"rolling", sales_from, sales_to }`; в режиме `rolling` поля дат `null`.
- `direct_period` / `bundles_period` — сводки за то же окно, что графики и `recent` (только **`d.applicable = 1`**). `bundles_period` — `null`, если `includes_via_bundles: false`.
- `note` — короткое пояснение для UI (что включено в цифры).
- `aggregates` — ключи `d3` … `d365`: продажи (шт, сумма ₽, позиции, ср./день) за скользящие N календарных дней по `ms_demand.moment` (+ эквивалент через комплекты при `includes_via_bundles`).
- `via_bundles` — сводка по комплектам за то же окно продаж, что графики и `recent`: продано комплектов, эквивалентное количество компонента, доля суммы строки (`qty_per_bundle / сумма qty по составу` того же комплекта). Массив **отсортирован по объёму** (`equivalent_qty` по убыванию), затем по сумме.
- `recent[]` — текущая страница отгрузок (см. `recent_page` / `recent_page_size` / `recent_total`). Порядок строк: **`ms_demand.moment` по убыванию** (момент проведённой отгрузки в МС); при совпадении момента — по `demand_uuid`, затем `position_uuid`. Для строк с `via: "bundle"` поля `quantity` / `price` / `sum` — **эквивалент** компонента; `bundle_qty` — количество проданных комплектов в строке; `qty_per_bundle` — из состава МС.
- `recent_total`, `recent_total_pages`, `recent_via`, `recent_bundle_code`, `recent_bundle_codes` — метаданные пагинации и фильтра по комплекту; `recent_bundle_codes` — подсказки для UI (комплекты, где текущий товар в составе), плюс на карточке можно ввести любой код вручную.
- `monthly` — ряд по календарным месяцам: при **`sales_from`+`sales_to`** — все месяцы от первого до последнего в диапазоне; при скользящем окне — последние до `ceil(recent_days/30)` мес. от текущей даты (max 60). Без продаж — нули в точке.
- `by_agent` / `by_store` — топ-N (по умолчанию 8) + строка «Прочие (M)», если хвост не пустой. Используются для doughnut-графика «Распределение продаж» с переключателем «По контрагентам / По складам». Контрагенты в МС часто и есть «маркетплейсы» (`ООО ИНТЕРНЕТ РЕШЕНИЯ` = Ozon, `ООО ВАЙЛДБЕРРИЗ` = WB и т.п.) — поэтому пирог автоматически даёт картину по проектам.

### GET `/api/product/:code/recent-shipments`

Только таблица «Последние отгрузки» за то же окно, что и `sales.*` у `GET /api/product/:code` (те же query: `sales_from` / `sales_to` / `recent_days`). Дополнительно: `recent_page`, `recent_page_size`, `recent_via`, `recent_bundle_code` — как у основного GET.

Ответ: `{ success, code, rows, recent_page, recent_page_size, recent_total, recent_total_pages, recent_via, recent_bundle_code, bundle_codes, sales_window, includes_via_bundles }` (структура элементов `rows` — как в `sales.recent[]` выше). Порядок `rows` — как у `sales.recent[]`: **`moment` из МС по убыванию** с детерминированными tie-breaker’ами (`demand_uuid`, `position_uuid`).

### GET `/api/product/:code/zero-stock-log`

Отдельная точка для перерисовки таблицы лога без полной перезагрузки карточки.

Query: `days` (default 90, max 1825).

Ответ: `{ success, code, days, rows: [...] }` (структура `rows` идентична `zero_stock.rows` выше).

### POST `/api/product/:code/zero-stock-log`

Запись в лог **вручную** за «сегодня» (кнопка «Записать вручную за сегодня» на карточке товара). Body (JSON):

```json
{ "store_uuid": "__total__", "store_name": null, "ts_date": "2026-05-12", "force": "0" }
```

Все поля опциональны. По умолчанию фиксируется на сегодня (`CURDATE()`) с `store_uuid='__total__'`. Без `force: 1` запрос отвергается, если `ms_export.stock > 0` (защита от ложных фиксаций). Идемпотентен: `INSERT … ON DUPLICATE KEY UPDATE` по уникальному ключу `(code, store_uuid, ts_date)`.

Ответ при успехе содержит `stored` — текущая строка лога для верификации (по правилу `datagon-settings-save-feedback.mdc`).

### Заметки

- Доступ: **API** `/api/product/*` → `pageKey: 'purchase'`. **HTML** `/product.html` — dual-gate: открыт, если `purchase` **или** `product` не `hidden` (`isHtmlLeafAccessHidden`); одного ключа `product` без `purchase` недостаточно для API. Подробнее — [Карточка товара](/docs/product/).
- Карточка открывается из таблицы «Закупки» (`/purchase.html`) — ссылка по **наименованию** на `/product.html?code=XXX` в новой вкладке.
- Перезапуск Node обязателен после изменений в `routes/product.js` / `lib/datagonPageRegistry.js` / `server.js` (`datagon-node-restart-lock.mdc`).

## Активность

Маршруты `routes/activity.js`. UI — верх `/processes.html` ([Активность / Логи](/docs/processes/)). `GET /events`: только **admin** или `can_manage_users`. `POST /track`: любая сессия (pageKey API `null`). Префикс `/activity/events` в матрице привязан к ключу **`processes`**, но роутер дополнительно режет по manage-users.

### GET `/api/activity/events`

Выборка событий (фильтры/пагинация — в роутере).

### POST `/api/activity/track`

Регистрация события с клиента.

## Минимальные проверки через curl

Большинство путей под `/api` требуют сессии после входа (cookie `dg_session` и/или заголовок `x-auth-token`, см. ответ `POST /api/auth/login`). Прямой `GET /api/my-sites` без авторизации вернёт **401**.

```bash
curl -i -X POST "http://localhost:3000/api/auth/login" \
  -H "Content-Type: application/json" \
  --data '{"username":"admin","password":"YOUR_PASSWORD"}'
```
