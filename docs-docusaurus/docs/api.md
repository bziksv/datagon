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
| Матчинг, confirm/reject | [Matches](#matches) |
| Ручной матчинг, очереди, вспомогательные GET | [Расширенные маршруты матчинга](#расширенные-маршруты-матчинга) |
| МойСклад, `ms_export` | [MoySklad](#moysklad) |
| Выгрузки Ozon / WB / Я.Маркет | [Exports / marketplaces](#exports--marketplaces) |
| Продажи МС (отгрузки) | [Продажи МС](#продажи-мс) |
| Закупки (планирование, overrides) | [Закупки](#закупки) |
| Карточка товара (детальная страница) | [Карточка товара](#карточка-товара) |
| Массовый синк источников | [Глобальная синхронизация (server.js)](#глобальная-синхронизация-serverjs) |
| Сводка фоновых задач (логи в UI) | [Обзор процессов](#обзор-процессов) |
| События активности в UI | [Активность](#активность) |
| Примеры `curl` | [Минимальные проверки через curl](#минимальные-проверки-через-curl) |

Если якорь в браузере отличается (локализация заголовков), откройте оглавление справа на этой странице Docusaurus — там верные ссылки.

Справочник по REST-эндпоинтам проекта.

Базовый URL (локально): `http://localhost:3000`

## Общие принципы

- Формат обмена: JSON.
- Основной префикс API: `/api`.
- Для старого фронтенда есть алиас входа: `POST /api/login`.
- Пагинация обычно поддерживает параметры `limit` и `offset`.

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
- `/api/matches` -> `routes/matches.js`
- `/api/ms` -> `routes/moysklad.js`
- `/api/exports/marketplaces` -> `routes/exportsMarketplaces.js`
- `/api/exports/dimensions` -> `routes/dimensions.js`
- `/api/ms-sales` -> `routes/msSales.js` (Продажи МС: отгрузки `entity/demand` + позиции с привязкой к `ms_export`)
- `/api/purchase` -> `routes/purchase.js` (Закупки: планирование закупок поверх `ms_export` + overrides в `dg_purchase_overrides`)
- `/api/product` -> `routes/product.js` (Карточка товара: `ms_export` + `ms_entity_details` + продажи + `dg_bundle_components`; лог нулевых остатков — пакетно после синка МС в `ms_export`, см. `syncZeroStockLogAfterMoyskladExport` в `routes/moysklad.js`)
- `/api/activity` -> `routes/activity.js`
- `GET /api/processes/overview`, `POST /api/sync-all-start`, `POST /api/sync-site-start`, `GET /api/sync-status` -> `server.js`

## Auth

### POST `/api/auth/login`
Вход по логину и паролю.

Body:
```json
{ "username": "admin", "password": "..." }
```

### POST `/api/login`
Legacy-алиас входа (тот же обработчик, что и выше).

### POST `/api/auth/change-password`
Смена пароля.

Body:
```json
{ "username": "admin", "newPassword": "минимум 15 символов" }
```

### Прочие маршруты `routes/auth.js`

Используются панелью и админкой (после входа): `GET /api/auth/me`, `GET /api/auth/sessions-overview`, `POST /api/auth/sync-session-cookie`, `POST /api/auth/logout`, CRUD пользователей (`GET/POST /api/auth/users`, `PUT/DELETE /api/auth/users/:id`, `PUT /api/auth/users/:id/permissions`, `POST /api/auth/users/:id/revoke-sessions`). Детали полей — в коде роутера.

Ответы `GET /api/auth/me` и `POST /api/auth/login` (успех) дополнительно содержат: `specialty_id`, `specialty_name`, `page_modes` — объект «ключ раздела» → `hidden` | `view` | `full` (см. `lib/datagonPageRegistry.js`). При создании/редактировании пользователя можно передать `specialty_id` в теле `POST /api/auth/users` и `PUT /api/auth/users/:id`.

### Специальности и матрица доступа (только `admin`)

Все под `/api/specialties/*` требуют роль **admin**.

- `GET /api/specialties` — список специальностей (с числом привязанных пользователей).
- `POST /api/specialties` — создать; body: `{ "name": "..." }`.
- `PUT /api/specialties/:id` — переименовать; body: `{ "name": "..." }`.
- `DELETE /api/specialties/:id` — удалить (нельзя удалить системную «Полный доступ» и специальность с привязанными пользователями).
- `GET /api/specialties/pages` — каталог разделов панели (ключ, заголовок, html-файл) для матрицы.
- `GET /api/specialties/:id/access` — текущие режимы по разделам.
- `PUT /api/specialties/:id/access` — сохранить режимы; body: `{ "modes": { "dashboard": "full", "results": "view", ... } }`.

Записи к не-GET API (кроме путей без привязки к разделу в реестре) для не-admin проверяются по режиму раздела: при `hidden` — 403, при `view` — разрешены только GET/HEAD/OPTIONS.
Новые страницы из `PAGE_DEFS` автоматически досинхронизируются в `specialty_page_modes` для всех существующих специальностей при старте сервера; для «Полный доступ» ставится `full`, для остальных групп — `hidden` до явного выбора администратора.

## Settings

### GET `/api/settings`
Получить текущие настройки приложения.

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
- **`auto_sync_marketplaces_enabled`** / **`auto_sync_marketplaces_time`** — ежедневное обновление снапшотов маркетплейсов (МСК, `HH:MM`).
- **`auto_sync_huckster_enabled`** / **`auto_sync_huckster_time`** — ежедневное обновление матриц Huckster (МСК); учётные данные — из `app_settings` или `HUCKSTER_EMAIL` / `HUCKSTER_PASSWORD`.
- **`auto_sync_db_size_enabled`** / **`auto_sync_db_size_time`** — ежедневный пересчёт кэша размера БД для дашборда (МСК, `HH:MM`).
- **`auto_sync_dimensions_enabled`** / **`auto_sync_dimensions_time`** — ежедневная **выгрузка пользовательских габаритов** (`ms_dimensions_measurements`) в МойСклад (МСК, `HH:MM`, по умолчанию `21:00`). Серверный аналог кнопки «↗ В МС: все правки (все страницы)» на `/exports-dimensions.html`: для каждой позиции с override и валидным `uuid` в `ms_export` отправляет `PUT /entity/{product|bundle}/{uuid}` через `routes/dimensions.js → runScheduledSyncMs`. Каждое отправленное поле фиксируется в `ms_dimensions_log` как `action='sync_ms'` с `note='sync_ms entity=… http=… (schedule)'`. Прогресс и summary видны на `/processes.html` (раздел «Габариты МС») и в `auto_sync_runs.message` (после старта текст **обновляется по ходу** каждые 5 позиций: `обработано/всего`, ✓/×, без uuid; финально — `Всего: N; ✓ ok; × err; пропущено (без uuid): K`).
- **`auto_sync_mssales_enabled`** / **`auto_sync_mssales_time`** / **`auto_sync_mssales_days`** / **`auto_sync_mssales_weekdays`** — **импорт продаж МС** (`entity/demand` → `ms_demand` / `ms_demand_position`) для `/ms-sales.html` (МСК, `HH:MM`, по умолчанию `07:30`). Окно периода — `auto_sync_mssales_days` (1..1825 дней, default **90**). **`auto_sync_mssales_weekdays`** — дни недели по календарю **МСК**: строка CSV, числа **1=пн … 7=вс**; пустая строка, значение **`1,2,3,4,5,6,7`** или все семь галочек в UI — запуск **каждый** календарный день (в БД «все дни» нормализуется в явную семёрку, чтобы снятие одного дня не схлопывалось обратно в «все дни»). Серверный путь — `routes/msSales.js → triggerSync(db, { days })` (без `fresh`). Планировщик в `server.js` сравнивает текущий день недели в МСК с этим множеством и только тогда ставит задачу в очередь (вместе с совпадением `HH:MM`). Запись в `auto_sync_runs` (`task_type='mssales'`, `message` — метрики как раньше).
- **`auto_sync_mssales_full_enabled`** / **`auto_sync_mssales_full_time`** / **`auto_sync_mssales_full_days`** / **`auto_sync_mssales_full_weekdays`** — отдельное расписание **полного** синка продаж МС: `triggerSync(db, { days, fresh: true })` (аналог «Полный синк с нуля» на `/ms-sales.html`). Окно по умолчанию **730** дней; дни недели — тот же формат CSV (**по умолчанию только `7`** — воскресенье). `task_type='mssales_full'` в `auto_sync_runs`. Не планируйте на то же `HH:MM`, что обычный `mssales`, если оба включены: один активный job `ms-sales` в памяти.
- **`sales_formula_replenishment_coef`**, **`sales_formula_sales_window_days`**, **`sales_formula_absence_analysis_days`**, **`sales_formula_rare_base_qty`**, **`sales_formula_rare_avg_max`**, **`sales_formula_expensive_rare_threshold_rub`**, **`sales_formula_expensive_rare_min_qty`**, **`sales_formula_max_change_coef`**, **`sales_formula_incomplete_pack_pct`**, **`sales_formula_economy_enabled`**, **`sales_formula_economy_absence_window_days`**, **`sales_formula_economy_max_absence_pct`**, **`sales_formula_economy_target_cover_days`** — **формула продаж** на карточке товара (`GET /api/product/:code` → объект `formula`). Логика в `lib/datagonSalesFormula.js`; UI — карточка «Формула продаж / закупки» в `/settings.html`.

### POST `/api/settings/auto-sync-run`

Принудительно поставить одну задачу автосинхронизации в общую очередь расписания, не дожидаясь времени запуска. Используется кнопками «Запустить сейчас» в `settings.html`.

Body: `{ "task": "myproducts" | "moysklad" | "marketplaces" | "huckster" | "db_size" | "dimensions" | "mssales" | "mssales_full" }`. Whitelist допустимых значений берётся из единого реестра `lib/datagonAutoSyncRegistry.js → getAutoSyncTaskKeys()` (см. правило `datagon-auto-sync-registry.mdc`); чтобы добавить задачу — расширьте `AUTO_SYNC_TASKS` в реестре. Запись в `auto_sync_runs` создаётся с `trigger_type = "manual"`. Для `dimensions` запускается тот же балк-синк, что и по расписанию (см. описание `auto_sync_dimensions_*` выше), но с `actor='Авто-синхронизация (вручную)'` в журнале. Для `mssales` — тот же `triggerSync(db, { days })` с `days = appSettings.auto_sync_mssales_days` (см. ниже). Для **`mssales_full`** — `triggerSync(db, { days: appSettings.auto_sync_mssales_full_days, fresh: true })`.

Ответ `{ "success": true, "queued": true|false, "skip_reason": null|"already_running"|"already_queued"|"invalid_task", "task", "queue", "runner_active" }`. Поле **`queued: false`** означает, что задача **не** добавлена в очередь (дубликат или такой тип уже выполняется); в этом случае в **`skip_reason`** — причина. Успешная постановка не гарантирует мгновенный старт: если в этот момент уже крутится **другая** задача очереди, исполнение отложится до её завершения (сервер сам вызовет обработчик снова).

### POST `/api/settings/fetch-proxy`

Только **`fetch_proxy_enabled`** и **`fetch_proxy_list`** (удобно сохранять блок прокси без остальных полей настроек). Body: JSON `{ "fetch_proxy_enabled": 1, "fetch_proxy_list": "…" }`. Ответ: `{ "success": true }`.

### POST `/api/settings/sync-myproducts`

Запуск фоновой синхронизации «моих товаров» из настроек (см. `routes/settings.js`).

### POST `/api/settings/sync-moysklad`

Запуск фоновой синхронизации МойСклад из настроек.

### GET `/api/settings/logs-info`

Метаинформация по лог-файлам на сервере.

### POST `/api/settings/logs-clear`

Очистка логов (осторожно: операция на стороне сервера).

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
- `limit`
- `offset`

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

### POST `/api/pages/refresh-results`
Взять URL из последних результатов и вернуть их в очередь.

Body (пример):
```json
{ "project_id": "all", "limit": 100 }
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
- `limit`
- `offset`

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

## My products

### GET `/api/my-products`
Список товаров из локальной таблицы `my_products`.

Query (основные):
- `site_id` — ID источника (`my_sites.id`) или `all`
- `status` — `all` | `0` | `1` (`is_active`)
- `source_enabled` — `all` | `0` | `1` (учёт на стороне источника)
- `ms_linked` — `all` | `1` | `0` (есть / нет совпадения с `ms_export` по коду МойСклад: `source_id` или `sku`, сравнение после `UPPER(TRIM(...))`)
- `search` — поиск по полям товара (несколько слов через пробел)
- `sort_by`, `sort_dir` — сортировка (`id`, `site`, `sku`, `name`, `price`, …)
- `limit`, `offset` — пагинация
- фильтр разрыва с конкурентом: `gap_filter_enabled`, `gap_exclude_zero`, `gap_competitor`, `gap_min_pct`, `gap_max_pct`, `usd_to_rub`, `eur_to_rub`
- `match_audit` — фильтр по аудиту сопоставлений

Кэш ответа: при неизменных параметрах повторный запрос в течение **120 с** может вернуть тот же JSON с полем `cache` (`source`, `age_ms`, `ttl_ms`).

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
- `linked` — среди активных: есть строка в `ms_export`, где `code` (нормализован при синке МС) совпадает с `UPPER(TRIM(source_id))` или с непустым `UPPER(TRIM(sku))`

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
Подтянуть цену с конкурента в источник (логика в `routes/myproducts.js`). В теле: `site_id`, `sku`, опционально `random_min_pct` / `random_max_pct`. Заголовок `x-auth-username` попадает в аудит.

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
  "mode": "all",
  "productIds": null,
  "productSearch": "",
  "batchSize": 200,
  "batchPauseMs": 1000,
  "microPauseMs": 20,
  "microPauseEvery": 20,
  "resumeMode": false
}
```

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

Логическая пара «наш сайт + конкурент + товар» хранится с полем `match_identity_hash` (SHA-256 от нормализованных SKU или от пары названий) и уникальным индексом по `(my_site_id, competitor_site_id, match_identity_hash)`, чтобы не появлялись дубли строк при повторном матчинге. При первом запросе к списку или задаче матчинга сервер при необходимости добавляет колонку, заполняет хеш для старых строк, сливает дубликаты и создаёт индекс (см. `ensureProductMatchIdentitySchema` в `routes/matches.js`). Подтверждение (`POST /confirm`, `POST /manual-match/confirm`) также удаляет лишние строки с тем же хешом.

Query:
- `my_site_id`
- `status` (`pending`, `confirmed`, `rejected`)
- `limit`
- `offset`

### POST `/api/matches/confirm`
Подтвердить совпадение.

Body:
```json
{ "id": 123 }
```

### POST `/api/matches/reject`
Отклонить совпадение.

Body:
```json
{ "id": 123 }
```

### POST `/api/matches/unlink`

Снять подтверждённое сопоставление (разорвать пару). Тело — идентификаторы записи матчинга (см. `routes/matches.js`).

## Расширенные маршруты матчинга

Эндпоинты для экрана «Сопоставление» (ручная очередь, архив, поиск по ценам конкурента, лог): `GET/DELETE /api/matches/manual-queue`, `GET/DELETE /api/matches/manual-archive`, `GET /api/matches/prices-resolve-sku`, `GET /api/matches/prices-search`, `GET /api/matches/product-match-log`, `POST /api/matches/manual-match/confirm`, `POST /api/matches/manual-match/archive`. Точные query и JSON — в `routes/matches.js`. **Поле `archived_by`** в ответе `GET /api/matches/manual-archive` — пользователь, который нажал «В архив» в блоке ручного сопоставления (заполняется при `POST /api/matches/manual-match/archive` через `resolveActorDisplayName`); миграция колонки `match_manual_archive.archived_by VARCHAR(100) NULL` живёт внутри `ensureMatchLaneTables()`.

## MoySklad

> **Эталон списочной страницы.** UI `/moysklad.html` — образец, по которому делаются все новые списочные страницы Datagon vanilla (две карточки: «Фильтры и действия» + «Выгрузка <X>», шестерёнка с auto-discovery полей, поиск-зеркало в шапке таблицы, кнопки `🧩 Столбцы` / `📏 Ширины` / `Свернуть` справа). Контракт — в правилах `.cursor/rules/datagon-list-page-baseline-moysklad.mdc` и `.cursor/rules/datagon-table-filter-apply.mdc`; пользовательская справка — [МойСклад](/docs/moysklad/#эталон-списочной-страницы).

### POST `/api/ms/sync`
Запустить фоновую синхронизацию в таблицу `ms_export`.

Этап 6/6 (`сохранение в ms_export`) выполняется **батчами по 2000 строк** (раньше шла одна команда `INSERT ... VALUES ?` на все ~60k строк × 24 колонки — на боевых снапшотах формировала SQL в десятки/сотни МБ и упиралась либо в `max_allowed_packet` MySQL, либо в OOM Node, после чего pm2/systemd рестартовал процесс и UI «зависал» на сообщении «Этап 6/6: сохранение в ms_export» с `jobState = {active:false, message:'Ожидание', total:0, processed:0}`). Прогресс-лог архивируется каждые ~10k строк (а также на последнем чанке) — в журнале синка видны записи `Сохранено в ms_export: N/M`. Сразу после завершения всех чанков выполняется пакетный upsert в `dg_product_zero_stock_log` за **сегодня** (`routes/product.js → syncZeroStockLogAfterMoyskladExport`): только строки с `stock_position='Да'`, `is_archived=0` и `stock≤0` (источник `moysklad_sync`; запись с `manual` за тот же день не перезаписывается). Затем буфер `exportRows` освобождается до старта `saveMoyskladEntityDetails` — это снимает пик памяти перед потоковой записью полных карточек.

**Поле `min_stock`** (DECIMAL(15,3) NULL, миграция `ensureMsMinStockColumn`) — нативное поле МС API `product.minimumBalance` («Неснижаемый остаток»). Заполняется только для строк `type='Товар'`; для `type='Комплект'` хранится `NULL`, потому что у `bundle` в МС-схеме поле `minimumBalance` не задано. UI `/moysklad.html` рендерит колонку «Неснижаемый остаток» прямо перед «Остаток»; для `NULL` показывает «—», чтобы пользователь отличал «норматив не задан» от честного 0. Сортировка по полю поддерживается (входит в `allowedSortFields` API list-эндпоинта).

Этап «Сохранение полных карточек МойСклад» (`ms_entity_details`) — потоковый: накапливается батч на 100 сущностей, тут же делается `INSERT ... ON DUPLICATE KEY UPDATE` и буфер обнуляется. Раньше функция сначала собирала `JSON.stringify` ВСЕХ сущностей в массив (`payload_json` под 280 МБ – 1 ГБ), и в паре с живым `all` в памяти Node уходил в OOM на боевом стенде ровно после успешного сохранения `ms_export`. Прогресс архивируется на круглых процентах (5 / 10 / … / 100) и при `processed === total`.

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

Префикс: `/api/exports/marketplaces`. Доступ к API проверяется по странице **`exports-marketplaces`** (матрица `page_modes`: скрытие «Настроек» отключает и вызовы API выгрузок). Настройки ключей/лимитов перенесены в **`/settings.html#marketplaces`**; страница `/exports-marketplaces.html` оставлена как редирект. Отдельные экраны таблиц — **`/exports-marketplaces-ozon.html`**, **`/exports-marketplaces-wildberries.html`**, **`/exports-marketplaces-yandex.html`**: они автозагружают последний сохранённый снапшот и имеют кнопку принудительного обновления. UI-toolbox таблицы маркетплейсов: кнопки «Столбцы» (чекбоксы видимости) и «Ширины» (input px на колонку); состояние сохраняется в `localStorage` (`dg.mp.cols.<shop>`, `dg.mp.colwidths.<shop>`, `dg.mp.page.size.<shop>`). Заголовок таблицы — sticky-th под верхним меню (с CSS-переменной `--dg-table-sticky-top`). Сами запросы выполняются **на сервере** (долгие циклы допустимы; таймауты прокси/nginx настройте под свой каталог). Для новых страниц этой группы целевая структура — по эталону `/moysklad.html` (карточки «Фильтры и действия» + «Выгрузка <X>», кнопки «Столбцы»/«Ширины»/«Свернуть» в card-header справа, поиск-зеркало в шапке таблицы; см. `.cursor/rules/datagon-list-page-baseline-moysklad.mdc`).

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

Текущий статус фонового обновления маркетплейсов: активность, сообщение, состояние по каждой площадке.

Технически строки сохраняются в таблицу `marketplace_export_rows` (создаётся автоматически): уникальность по паре `(marketplace, external_id)`, полные данные каждой строки — в `row_json`, плюс нормализованные колонки (`price`, `vat`, `stock`, габариты, ссылки и т.д.) для SQL-обработки.

### GET `/api/exports/marketplaces/issues`

Проблемы с товарами (бывш. «Неопубликованные»). Возвращает строки **`ms_export`** по основному фильтру `stock_position = 'Да' AND no_longer_cooperation = 'Нет'` с сопоставлением артикулов на 3 маркетплейсах через **`marketplace_export_rows.external_id`** (= `offer_id` для Ozon, `vendor_code` для WB, `shop_sku` для YM, см. `lib/marketplaceExportStore.js#externalIdFor`). По каждой строке возвращается полный паспорт МС (`ms_stock`, `ms_vat` из `ms_export`, габариты МС из `ms_dimensions_measurements` — см. ниже) и каждого маркетплейса: `*_code`, `*_name`, `*_vat` (нормализован `prettifyMarketplaceVat`), `*_stock`, `*_length` / `*_width` / `*_height` (см), `*_weight` (кг), `*_cabinet_url`, `*_buyer_url`, `*_updated` (метка свежести снапшота — `updated_label` или форматированный `updated_at`). Поля **`uuid`** и **`type`** из `ms_export` приходят в каждом объекте `rows[]`, но **не** входят в массив **`headers`** (нужны UI для карточки МС и `GET /api/ms/detail/:uuid`, а не как отдельные колонки). Если код маркетплейса не найден в последнем снапшоте — все его поля приходят `null`; фронт подсвечивает пары `(*_code, *_name)` красным. Порядок колонок МС в `headers`/`headerLabels`: `code`, `name`, `manager`, `content_manager`, `ms_vat`, `ms_stock`, `ms_length`, `ms_width`, `ms_height_box`, `ms_height_bag`, `ms_weight`, `synced_at`.

**Габариты МС** (`ms_length`, `ms_width`, `ms_height_box`, `ms_height_bag`, `ms_weight`) подмешиваются `LEFT JOIN ms_dimensions_measurements md ON md.code = m.code` — те же значения, что и на странице `/exports-dimensions.html` («Маркетплейсы → Габариты»). Высоты у МС две (коробка / пакет), потому что упаковка может отличаться по виду; на маркетплейсах высота одна. Если по строке нет ни одной записи в `ms_dimensions_measurements`, все 5 полей приходят `null`. Значения форматируются на сервере до **одного знака после точки** (`toFixed(1)`): из БД `31.00` / `1.000` приходит `"31.0"` / `"1.0"` (UI достаточно такой точности).

Query:

- `scope` — фильтр выборки:
  - `all` (по умолчанию) — все товары МС по основному фильтру;
  - `any` — у кого хотя бы один из 3 маркетплейсов не нашёл товар;
  - `all3` — нет ни на одном из 3 маркетплейсов;
  - `ozon` / `wb` / `ym` — нет на конкретном маркетплейсе;
  - `vat_mismatch` (алиас `vat-mismatch`) — товар есть в снапшоте маркетплейса, но нормализованный НДС МС не совпадает с НДС на этой площадке (Wildberries со значением «не указан» в сравнении не участвует);
  - `dims_mismatch` (алиас `dims-mismatch`) — расхождение габаритов (длина/ширина/высота/вес) с допуском 0,02. Если у строки в `ms_dimensions_measurements` есть **хотя бы одно** числовое значение (`length_cm`, `width_cm`, `height_box_cm`, `height_bag_cm`, `weight_kg`), сверка идёт **МС ↔ маркетплейсы**: длина/ширина/вес — одно МС-значение против каждой площадки; высота МС двойная — высота маркетплейса считается совпавшей, если совпала **хотя бы с одной** из непустых высот МС (коробка ИЛИ пакет). Если у МС нет ни одного измерения, fallback — старая логика «между маркетплейсами»: товар есть минимум на двух площадках, по любой оси обе отдают число и оно расходится. Пара «число vs пусто» расхождением не считается. Отбор **в памяти** после `prettifyMarketplaceVat` и фильтра комплектов, в пределах первых `max_items` строк по `ORDER BY m.code` — при очень большом каталоге возможны «хвосты» за пределом лимита.
- `max_items` — лимит выборки, 1..100000, по умолчанию 50000.
- `exclude_bundle_components` — `1` (по умолчанию) исключает товары, чей `code` встречается как компонент хотя бы одного комплекта (`ms_entity_details.kind = 'bundle'`, поле `payload_json.components.rows[].assortment.code`). Любое явно «ложное» значение (`0` / `false` / `no` / `off`) выключает фильтр. Полный набор кодов-компонентов кэшируется в памяти процесса на 5 минут (см. `getBundleComponentCodesCached` в `routes/exportsMarketplaces.js`); первый запрос после рестарта Node читает payload всех bundle-сущностей, последующие — берут готовый Set.

Ответ JSON:

```json
{
  "scope": "all",
  "scope_label": "все товары",
  "count": 123,
  "headers": ["code","name","manager","content_manager","ms_vat","ms_stock","ms_length","ms_width","ms_height_box","ms_height_bag","ms_weight","synced_at","ozon_code","ozon_name","ozon_vat","ozon_stock","ozon_length","ozon_width","ozon_height","ozon_weight","ozon_cabinet_url","ozon_buyer_url","ozon_updated","wb_code","wb_name","wb_vat","wb_stock","wb_length","wb_width","wb_height","wb_weight","wb_cabinet_url","wb_buyer_url","wb_updated","ym_code","ym_name","ym_vat","ym_stock","ym_length","ym_width","ym_height","ym_weight","ym_cabinet_url","ym_buyer_url","ym_updated"],
  "headerLabels": ["Код МС","Название МС","Менеджер","Контент-менеджер","НДС МС","Остаток по МС","Длина (см) МС","Ширина (см) МС","Высота — коробка (см) МС","Высота — пакет (см) МС","Вес (кг) МС","Синхронизация МС","Код Ozon","Название Ozon","НДС Ozon","Остаток Ozon","Длина (см) Ozon","Ширина (см) Ozon","Высота (см) Ozon","Вес (кг) Ozon","Кабинет Ozon","Покупателю Ozon","Обновлено Ozon","Код Wildberries","Название Wildberries","НДС WB","Остаток WB","Длина (см) WB","Ширина (см) WB","Высота (см) WB","Вес (кг) WB","Кабинет WB","Покупателю WB","Обновлено WB","Код Я.Маркет","Название Я.Маркет","НДС Я.Маркет","Остаток Я.Маркет","Длина (см) Я.Маркет","Ширина (см) Я.Маркет","Высота (см) Я.Маркет","Вес (кг) Я.Маркет","Кабинет Я.Маркет","Покупателю Я.Маркет","Обновлено Я.Маркет"],
  "rows": [
    { "code": "ABC-1", "name": "...", "uuid": "…", "type": "Товар", "manager": null, "content_manager": null, "ms_vat": "20%", "ms_stock": 12, "ms_length": "30.0", "ms_width": "20.0", "ms_height_box": "10.0", "ms_height_bag": null, "ms_weight": "0.5", "synced_at": "01.01.2026 12:00", "ozon_code": "ABC-1", "ozon_name": "...", "ozon_vat": "20", "ozon_stock": "12", "ozon_length": "30", "ozon_width": "20", "ozon_height": "10", "ozon_weight": "0.5", "ozon_cabinet_url": "https://seller.ozon.ru/...", "ozon_buyer_url": "https://www.ozon.ru/...", "ozon_updated": "01.01.2026 12:30", "wb_code": null, "wb_name": null, "wb_vat": null, "wb_stock": null, "wb_length": null, "wb_width": null, "wb_height": null, "wb_weight": null, "wb_cabinet_url": null, "wb_buyer_url": null, "wb_updated": null, "ym_code": "ABC-1", "ym_name": "...", "ym_vat": "20", "ym_stock": "8", "ym_length": "30", "ym_width": "20", "ym_height": "10", "ym_weight": "0.5", "ym_cabinet_url": "https://partner.market.yandex.ru/...", "ym_buyer_url": "https://market.yandex.ru/...", "ym_updated": "01.01.2026 12:35" }
  ],
  "exclude_bundle_components": true,
  "bundle_component_codes_known": 482,
  "removed_by_bundle_filter": 17
}
```

Поле `bundle_component_codes_known` — размер набора кодов-компонентов, отбираемых из `ms_entity_details`. `removed_by_bundle_filter` — сколько строк было отрезано серверным фильтром «исключить товары из комплектов» (полезно для отладки). Когда `exclude_bundle_components=0`, `bundle_component_codes_known` равно `0` и `removed_by_bundle_filter` равно `0`.

Экран: `/exports-marketplaces-issues.html` (пункт меню **Маркетплейсы → Проблемы с товарами**, после «Яндекс Маркет»). UI: радио-фильтр (Все товары / Есть проблемы / Нет ни на одном / Нет на Ozon / Нет на Wildberries / Нет на Я.Маркет / Не совпадает НДС / Разные габариты), умный поиск по артикулу/наименованию МС/маркетплейсов, НДС, остаткам и ФИО менеджеров, сортировка по любой колонке кликом по заголовку (по умолчанию по «Код МС» asc), клиентская пагинация 50/100/200/500. По умолчанию включены **все** колонки (полный паспорт МС + 3 маркетплейсов); кнопка `«Столбцы по умолчанию»` в панели `🧩 Столбцы` возвращает именно это состояние «все включены» (ключ видимости в `localStorage` — `dg.mpu.colvisible.v5`, dg.mpu.colwidths.v2 для пиксельных ширин). Таблица **широкая** (`width: max-content`): горизонтальный скролл **внутри карточки** (`#dg-mpu-table-scroll-outer`, как `/my-products.html`), плавающая шапка под `app-header` — **JS на `thead#dg-mpu-thead`** (`translate3d`), не схема shop-страниц Ozon/WB/Я.М. Ширины в DOM задаются через `<colgroup>`; не задавать суммарно раздувающий `min-width` на каждую `td` в px. Контракт: `.cursor/rules/datagon-table-behavior-lock.mdc` (раздел «Проблемы с товарами»). Лишние колонки можно выключить в `🧩 Столбцы` — выбор сохранится в браузере. В режиме **«Все товары»** красная подсветка отсутствия товара на площадке — только у ячеек `*_code`; НДС (МС ↔ маркетплейс) и расхождение габаритов между площадками подсвечиваются на фильтрах **«Не совпадает НДС»** / **«Разные габариты»**, не в «все товары». На остальных фильтрах по отсутствию товара подсвечивается пара `(*_code, *_name)`. Колонки-ссылки `*_cabinet_url` / `*_buyer_url` рендерятся как «Открыть» (новая вкладка). Полное наименование товара МС, тип, статусы и переход в МойСклад / маркетплейсы доступны по клику на «Название МС» — открывается та же карточка, что на `/moysklad.html` (`GET /api/ms/detail/:uuid`). Фильтр маркетплейса, поиск и селекты «Менеджер» / «Контент-менеджер» собраны в один тулбокс над таблицей и срабатывают **только** по кнопке «Применить» (или Enter в поле поиска); пока изменения не применены, рядом с кнопкой видно «не применено». Это общий контракт для всех таблиц Datagon, см. правило `.cursor/rules/datagon-table-filter-apply.mdc`.

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

## Exports / Dimensions (Габариты)

Префикс: `/api/exports/dimensions`. Экран: `/exports-dimensions.html` (входит в подменю **Маркетплейсы** сразу после «Яндекс Маркет»).

Назначение: реестр замеров габаритов товаров и комплектов МойСклад с фиксацией **кто** и **когда** замерял. Базовые поля (код, наименование, тип) берутся из `ms_export`. Замеры хранятся в отдельной таблице **`ms_dimensions_measurements`** и подмешиваются к строкам `ms_export` по полю `code`. История изменений по каждой позиции ведётся в **`ms_dimensions_log`** (см. ниже).

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
- `scope` — `all` (по умолчанию) / `with` (только с замером) / `without` (только без замера).
- `limit` — 1…500 (по умолчанию 100), `offset` — 0…1_000_000.
- `sort_by` — `code` | `name` | `type` | `stock` | `measured_by_name` | `measured_at` (по умолчанию `code`).
- `sort_dir` — `asc` | `desc`.

Ответ: `{ success: true, rows: [...], total, limit, offset, sort_by, sort_dir, dimension_attrs }`. Каждая строка содержит `code`, `name`, `type`, `uuid`, `stock` (`Number|null` — актуальный остаток из `ms_export.stock`), `is_archived` (bool), `measured_by_user_id` (`number|null`), `measured_by_name` (string), `measured_at` (ISO-строка или `''`), а также **`dimensions_ms`** — объект с **6 атрибутами МойСклада**, парсимыми на лету из `ms_entity_details.payload_json` для строк текущей страницы (без расширения `ms_export`):

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

UI поверх этих данных вычисляет «эффективное» значение каждой ячейки замера в порядке приоритета: **override → MS-атрибут → parsed → пусто**.

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

История изменений по конкретной позиции с пагинацией. Используется модалкой `🕘 Лог` на `/exports-dimensions.html`, а также tooltip-ом «3 последних правки» при наведении на ячейки (там через `?field=...&limit=3`).

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

Глобальный журнал всех изменений габаритов — по всем позициям. Используется карточкой «История изменений» на `/exports-dimensions.html` (свёрнута по умолчанию, разворачивается по кнопке «Развернуть» в шапке карточки).

Параметры (все опциональные, комбинируются по AND):

- `search` — подстрока по `code` ИЛИ `ms_export.name` (через `LIKE %x%`).
- `action` — `set`, `sync_ms`, `sync_ms_skip`, `delete`.
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

### GET `/api/exports/dimensions/log/stats`

Статистика журнала `ms_dimensions_log` для блока «Журнал замеров габаритов» в `/settings.html` («Логи сервера»). Не принимает параметров.

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

## Exports / Huckster

Префикс: `/api/exports/huckster`. Экран: `/exports-huckster.html`.

Матрицы (`sheet_export` / `sheet_export_rrc` / `sheet_export_lost`):

- **`sheet_export` (набор 1, Huckster Export)** и **`sheet_export_rrc` (набор 2, Huckster Export RRC):** строки моста — **все** позиции из **`ms_export`** с непустым кодом (без серверного отсечения по складской позиции, сотрудничанию или цене). Сужение списка на экране — **блок фильтров** (менеджер, маркетплейсы, модели, умный поиск, «Не найдено», пагинация) и **галочки «архив МС»** (`app_settings` + `POST /ms-bridge-row-flags`). Смысл галочек: **скрыть архивные комплекты** (`is_archived` и при этом `type` = «Комплект» или в `ms_entity_details.kind` = `bundle`) **даже с остатком**; **скрыть архивные товары** (`type` = «Товар», `is_archived`) **только при** `stock ≤ 0`. Если для набора задан тип цены МойСклад (`price_type_set_*`), в таблицу добавляется **колонка** с этим типом (значение из `ms_entity_details.payload_json.salePrices` или пусто при отсутствии/нуле; **строки не удаляются**). Колонки: **ID / КОД** (= код МС, сопоставляется с `uid` в repricer), **Наименование товара**, **Менеджер**, **Остаток**, опционально **выбранный тип цены**, по маркетплейсам **Ozon / WB / ЯМ** — статус **«Репрайсер ВКЛЮЧЕН»** (зелёный), если по этому коду есть **ровно один** включённый repricer в маркетплейсе; иначе **«Репрайсер ВЫКЛЮЧЕН»** (красный: ноль или больше одного включённых — нельзя однозначно выбрать кабинет). Рядом колонки **«Модель …»** показывают назначение Unit-модели: название модели (зелёный), **«Модель не назначена»** (красный) или **«Модель назначена, но Репрайсер на модели выключен»** (жёлтый). Для набора 1 при обогащении из Huckster учитываются только Unit-модели «онлайн»+«калькулятор», для RRC — полный набор Unit-моделей. Последняя колонка **«Актуально на»** — время синка. В JSON добавлены **`bridge_row_meta`** (состояния кабинетов для подсветки), **`matrix_kind`: `ms_bridge_v1`**.

- **`sheet_export_lost` (потеряшки):** отдельная выборка для аудита. Строка попадает в набор, если в Huckster по коду есть **любая Unit-модель и/или включенный repricer**, а в МойСклад у этого кода одновременно `no_longer_cooperation = Да` и `stock = 0`. Колонки: `ID / КОД`, `Наименование товара`, `Менеджер`, `Остаток`, `Repricer` (Да/Нет), `Модели Huckster`, `Актуально на`. Реализация: `routes/exportsHuckster.js`.

Старые снапшоты наборов 1/2 с первой колонкой **«Обновлено (repricer)»** UI отображает по прежней сетке (UID × кабинеты).

Ежедневный запуск по расписанию (МСК): флаги **`auto_sync_huckster_enabled`** / **`auto_sync_huckster_time`** в `POST /api/settings` — см. раздел [Settings](#settings); реализация в `server.js` (очередь `auto_sync_runs`, тип задачи `huckster`).

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
- `result` — финальный результат (при успехе: `sheet_export.rows`, `sheet_export_rrc.rows`, `sheet_export_lost.rows`, `updated_at`; для тестового запуска ещё `test_uids`).
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
- `search` — **умный поиск по товарам в позициях отгрузки**: подстрока по `ms_demand_position.ms_export_code`, `code_at_moment`, `name_at_moment` и `ms_export.name` (для резолвленных позиций). Реализован через `EXISTS`, чтобы не дублировать строки в выдаче.
- `doc_name` — фильтр по номеру документа (`ms_demand.doc_name`). По умолчанию подстрока (`LIKE '%X%'`); если в значении есть `%` или `_` — используется как готовый LIKE-паттерн.
- `store_uuid` — фильтр по складу.
- `agent_uuid` — фильтр по контрагенту.
- `project_uuid` — фильтр по проекту (`ms_demand.project_uuid`).
- `applicable` — `1` (по умолчанию: только проведённые) | `0` (только черновики) | пусто (все).
- `deleted` — `0` (по умолчанию: только активные, без soft-deleted) | `1` (только помеченные удалёнными в МС) | `all` (без фильтра по `deleted_at`).
- `linked` — `all` (по умолчанию, без фильтра по привязке) | `1` (только отгрузки, у которых **все** позиции привязаны к `ms_export`) | `0` (только отгрузки, у которых **есть** хотя бы одна не привязанная позиция, бейдж «не привязано» в UI). Реализован через `EXISTS / NOT EXISTS` по `ms_demand_position.ms_export_resolved`, опирается на индекс `idx_resolved`.
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

**Auto-resume и `fresh=true`.** По умолчанию (`fresh=false`) перед запросами к МС API синк делает разведку по БД: `SELECT COUNT(*) AS cnt, MIN(moment) AS minM FROM ms_demand WHERE moment BETWEEN momentFrom AND momentTo AND deleted_at IS NULL`. Если `cnt > 0` и `minM` ощутимо позже, чем `momentFrom` (порог — 5 минут), синк переходит в **resume-режим**: `momentTo := minM + 5 минут запаса` (UPSERT защищает пограничные документы), `momentFrom` остаётся прежним. В выдаче МС остаётся только «хвост» периода — синк добивает его и завершается. Это сильно ускоряет повторный запуск после сетевого таймаута/прерывания: не надо заново тянуть 44 тыс. уже сохранённых отгрузок. `fresh=true` принудительно отключает auto-resume — синк проходит весь период от `NOW()` до начала, перезаписывая уже сохранённые отгрузки. UI `/ms-sales.html` показывает два разных триггера: «Синхронизировать с МС» (`fresh=false`) и «Полный синк с нуля» (`fresh=true`).

**Soft-delete на resume-проходе пропускается.** В resume-режиме мы видим только хвост периода, поэтому сравнивать `seenUuids` против всей выдачи `ms_demand` за окно нельзя — это пометило бы все свежие документы как удалённые в МС. Sync-status payload содержит `resume_mode: true` и `resume_from_moment` (ISO-дата), `existing_count_at_start` (сколько отгрузок за окно периода было в БД до прогона).

**Резилиентность сетевых ошибок.** Запросы к МС API (`fetchDemandsPage`) идут через retry-обёртку с экспоненциальным backoff (4 попытки: `0/2/5/12` сек). На 3-й и 4-й попытках `limit` автоматически уменьшается (100 → 50 → 25), чтобы дать МС API шанс отдать страницу быстрее на больших offset'ах, где часто ловили `timeout of 60000ms exceeded`. Транзиентные ошибки (network/timeout, 408, 429, 5xx) ретраятся, фатальные (4xx кроме 408/429) пробрасываются как `last_error`. При исчерпании попыток главный цикл мягко прерывается (не `throw`), сохранённые отгрузки остаются в БД; повторный запуск синка идемпотентен — auto-resume подхватит ровно с места разрыва.

Под капотом — `GET /entity/demand` с расширенным `expand=agent,store,organization,project,contract,salesChannel,owner,group,state,rate.currency,positions.assortment,positions.assortment.product` и фильтром по `moment`, страницами по 100, дросселем 250 мс. Кастомные атрибуты документа (`attributes[]` — «Номер отправления с озона», «Идентификатор чека», и т. п.) приходят прямо в payload без expand и сохраняются в `ms_demand.attributes_json`. Полный raw payload документа (минус `positions`) сохраняется в `ms_demand.payload_json` — для последующего локального backfill, если в схему добавятся новые поля. Если `expand` не подтянул `positions.rows` — догружаются отдельным запросом `/entity/demand/{id}/positions`. Документы upsert'ятся (по `uuid`), позиции пересохраняются заново для каждого документа (DELETE + bulk INSERT по 500).

**Soft-delete (отгрузки, удалённые в МС).** МС API в `entity/demand` не возвращает удалённые документы. Чтобы наша БД не накапливала «фантомные» продажи, после каждого успешного прохода синка (`cancelRequested=false` И нет фатальных ошибок батчей И в выдаче что-то было) в окне `momentFrom..momentTo` сравниваются `ms_demand.uuid` против фактически увиденных в этом проходе UUID. Документам, которых нет в выдаче, ставится `ms_demand.deleted_at = NOW()`. Сами строки и связанные `ms_demand_position` **не удаляются** — они нужны для истории продаж и агрегатов. UPSERT в `persistDemand` сбрасывает `deleted_at = NULL`, поэтому если документ снова появился в МС — он автоматически «воскресает». В UI такие отгрузки помечены бейджем «Удалена из МС», подсвечены красным (`tr.dg-mss-deleted-row`) и по умолчанию скрыты фильтром `Удалённые в МС = Только активные`. Метрики прохода: `deleted_demands` (помечено в этот раз), `restored_demands` (вернулось из soft-delete) — попадают в `/api/ms-sales/sync-status`.

### POST `/api/ms-sales/sync-cancel`

Мягкая остановка фонового job-а (выставляет флаг — текущий батч добивается до конца).

### GET `/api/ms-sales/sync-status`

Статус job-а: `{ success, status: { active, cancel_requested, started_at, finished_at, days, fetched_demands, total_demands, saved_positions, resolved_positions, unresolved_positions, deleted_demands, restored_demands, message, errors[], last_error, resume_mode, resume_from_moment, existing_count_at_start } }`. UI поллит каждые 1.5 с пока `active=true`. `deleted_demands` / `restored_demands` см. раздел про soft-delete выше. `resume_mode` / `resume_from_moment` / `existing_count_at_start` — поля auto-resume (см. описание `POST /api/ms-sales/sync`): в resume-режиме `total_demands` означает размер только «хвоста» периода, а не полное число отгрузок (полное ≈ `existing_count_at_start + fetched_demands`).

### POST `/api/ms-sales/reresolve`

Перепривязка непривязанных позиций к `ms_export` — после полной синхронизации МС (когда в `ms_export` появляются новые товары, позиции под их uuid в `ms_demand_position` могут быть неразрешены). Один UPDATE с JOIN по `ms_export.uuid = COALESCE(assortment_uuid, product_uuid)`. Возвращает `{ success, affected, unresolved }`.

### Совместимость

- В матрице доступа (`lib/datagonPageRegistry.js`) — `pageKey: 'ms-sales'`, `htmlFile: 'ms-sales.html'`, `navSlug: 'ms-sales'`. API-префикс `/ms-sales` подчиняется тому же режиму (`hidden` / `view` / `full`); в режиме `view` POST-эндпоинты (`/sync`, `/sync-cancel`, `/reresolve`) автоматически блокируются.
- Меню: пункт «Продажи МС» в подменю «Маркетплейсы» — последний пункт после «Сводка и синхронизация».
- Фронтенд: `static-html/vanilla/inners/ms-sales.{head,inner,scripts}.html` — две карточки (фильтры + таблица отгрузок с разворачивающимися позициями), поиск-зеркало в шапке таблицы.

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
- **`autoSyncRuns`** — записи `auto_sync_runs`, чей `started_at` приходится на выбранный день в МСК. Фронт группирует их по `task_type` и рисует по секциям из `autoSync.sections` (см. ниже). Чтобы добавить новую секцию — добавляйте задачу в `lib/datagonAutoSyncRegistry.js → AUTO_SYNC_TASKS` (правило `datagon-auto-sync-registry.mdc`).
- **`autoSync.sections`** — массив `{ key, title, subtitle, enabled, time, extras: [{ key, label, value }] }`, построен `buildAutoSyncSectionsSnapshot(appSettings)` из `lib/datagonAutoSyncRegistry.js`. Используется фронтом `processes.scripts.html` (`renderAutoSyncSections`), чтобы держать набор задач в `/settings.html` ↔ `/processes.html` синхронным без ручной правки UI при добавлении новой автосинки. Поле `autoSync.config` оставлено для обратной совместимости (legacy фронт без `sections`).
- **`autoSync.dimensions_live`** — снимок in-memory прогресса балк-выгрузки габаритов в МС (`routes/dimensions.js` → `getScheduledSyncState`), пока `active: true`: `processed`, `total`, `ok`, `err`, `skipped_no_uuid`, `last_code`, `last_message` и т.д. Фронт подмешивает его к строке `auto_sync_runs` со статусом `running` для задачи `dimensions`, чтобы не казалось, что процесс «завис» на «Запуск задачи».
- **`matches`** — последняя задача `matching_jobs` для `my_site_id`, чей `started_at` приходится на выбранный день в МСК. Если задач за день не было — `matches.message` = «За выбранный день задач сопоставления не было».
- **`moysklad.logs`** (in-memory `jobState.logs`, до 30 строк текущей сессии) — отдаются только за «сегодня»; для других дней массив пустой, так как память процесса не различает даты.

Дополнительные поля ответа: `forDate` (фактически применённая дата), `forDateOptions` (массив из 14 допустимых дат, новейшая первая), `moscowToday`, `isToday`.

Размер базы считается через `information_schema.TABLES` и кэшируется на 5 минут.

### GET `/api/processes/db-size`

Размер текущей MySQL-базы: общий объём, данные, индексы, число таблиц, время расчёта и признак кэша. Без параметров отдаёт суточный кэш; `?refresh=1` принудительно пересчитывает показатель для кнопки «Обновить размер БД» на дашборде.

### GET `/api/processes/disk-usage`

Используется виджетом «Дисковое пространство» на дашборде (`/dashboard.html`). Принудительный пересчёт также выполняется в составе ежедневной фоновой задачи `db_size` (галка «Размер БД и диска» в `/settings.html` → раздел «Авто-синхронизация»; одна задача `auto_sync_runs.task_type = 'db_size'` обновляет и размер БД, и разбивку диска). Возвращает:

- `projectPath` — абсолютный путь к корню проекта (`__dirname` сервера);
- `projectSizeBytes`, `projectFileCount`, `rootFilesBytes`, `rootFilesCount` — суммарный размер всех каталогов проекта, общее число файлов и размер/количество файлов в самом корне;
- `folders` — массив верхнеуровневых каталогов (включая `.git`, `node_modules`, `vendor`, `docs-docusaurus` и т.д.), отсортированный по убыванию размера. Каждый элемент: `{ name, isHidden, sizeBytes, fileCount, dirCount, errorCount }`. `errorCount` показывает, сколько файлов не удалось прочитать (нет доступа) — отражается badge «нет доступа: N» на UI;
- `fileSystem` — объём ФС, в которой лежит проект, через `fs.statfs`: `{ sizeBytes, freeBytes, usedBytes, usedPercent }` (или `{ error }`, если `fs.statfs` недоступен в текущей версии Node);
- `scanDurationMs`, `scannedAt`, `ttlSec`, `cached` — диагностика и признак кэша.

Кэш — 5 минут (`DISK_USAGE_CACHE_TTL_MS` в `server.js`); параллельные запросы дедуплицируются через общее `in-flight` обещание. `?refresh=1` принудительно пересчитывает разбивку. Обход дерева использует `fs.readdir` + `fs.lstat`, не следует по симлинкам и устойчив к `EACCES`.

## Закупки

Отдельная страница `/purchase.html` и роутер `routes/purchase.js`. Источник истины базовых полей — `ms_export` (синк МойСклад). Дополнительные **редактируемые поля** (Неснижаемый остаток Датагон, Кратность товара, Мин.Остаток сч.как, поле `proposed_min_stock` в закупках, Кол-во в упаковке вручную) хранятся в отдельной таблице `dg_purchase_overrides`, чтобы синк МС не затирал ручные значения и схема `ms_export` оставалась стабильной. В списке `GET /api/purchase` дополнительно отдаётся **`formula_proposed_min_stock`** — расчёт «Формула продаж» (как на карточке товара), не путать с `proposed_min_stock` из overrides. Для окон **3 / 5 / 7 / 15 / 30 / 60 / 90 / 180 / 365** дней — поля **`d_3`, `d_5`, … `d_365a`**: сумма проданного количества (шт) за скользящие календарные дни (прямые отгрузки по коду + эквивалент через комплекты, для строк-комплектов только прямые). Поля **`d_15b`, `d_30b`, … `d_365b`** — число **разных календарных дат** с нулевым остатком в `dg_product_zero_stock_log` за последние N дн. (как на карточке товара). Поле **`in_transit`** — «в пути» из `payload_json.inTransit`, если есть.

Сырые поля (`article`, `packagings`, `inTransit`) подмешиваются к строкам из `ms_entity_details.payload_json` (raw карточка из МС API).

### Таблица `dg_purchase_overrides`

```sql
CREATE TABLE dg_purchase_overrides (
  code VARCHAR(255) NOT NULL PRIMARY KEY,
  min_stock_dg DECIMAL(15,3) NULL,
  multiplicity DECIMAL(15,3) NULL,
  min_stock_calc_as DECIMAL(15,3) NULL,
  proposed_min_stock DECIMAL(15,3) NULL,
  pack_qty_manual DECIMAL(15,3) NULL,
  note VARCHAR(500) NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);
```

Связь с `ms_export` — по `code` (то есть по коду товара МС, как в остальных интеграциях Datagon).

### GET `/api/purchase`

Список товаров для планирования закупок. Для каждой строки сервер дополнительно считает **`formula_proposed_min_stock`** — предлагаемый неснижаемый по той же логике, что `GET /api/product/:code` → `formula.proposed_min_stock` (`lib/datagonSalesFormula.js`, окна из `app_settings`). Поле **`proposed_min_stock`** в ответе по-прежнему из **`dg_purchase_overrides`** (ручное значение «Предлаг. (закупки)» в UI).

**Фильтр по умолчанию (как в ТЗ страницы):**

- `is_archived = 0` (только активные);
- `stock_position = 'да'` (только складская позиция);
- `type` ≠ комплект (исключаем комплекты).

Query:

- `search` — подстрока по `code`, `name`, `supplier`, `supplier2` (case-insensitive).
- `supplier` — отдельный фильтр по поставщику (`supplier` ИЛИ `supplier2`, case-insensitive).
- `archived` — `active` (default) | `archived` | `all`.
- `stock_position` — `yes` (default) | `no` | `all`.
- `include_bundles` — `0` (default, исключить комплекты) | `1` (включить).
- `only_stock` — `1` чтобы оставить только `stock > 0`.
- `limit` (default 100, max 1000), `offset`.
- `sort_by` — `code` (default), `article`, `name`, `supplier`, `buy_price`, `min_stock`, **`formula_proposed_min_stock`**, `automation_price`, `proposed_min_stock`, `min_stock_dg`, `multiplicity`, `min_stock_calc_as`, `stock`, `is_archived`, **`in_transit`**, **`d_3`**, **`d_5`**, **`d_7`**, **`d_15a`**, **`d_15b`**, **`d_30a`**, **`d_30b`**, **`d_60a`**, **`d_60b`**, **`d_90a`**, **`d_90b`**, **`d_180a`**, **`d_180b`**, **`d_365a`**, **`d_365b`**.
- `sort_dir` — `asc` (default) | `desc`.

Для **`sort_by`** из перечисленных **вычисляемых** полей (`formula_proposed_min_stock`, `in_transit`, все `d_*`) порядок строк на **текущей странице** (`limit`/`offset`) пересчитывается в памяти после расчёта метрик (глобальный порядок по всему каталогу без отдельного запроса не гарантируется).

Ответ:

```json
{
  "success": true,
  "total": 1234,
  "limit": 100,
  "offset": 0,
  "sort_by": "code",
  "sort_dir": "asc",
  "data": [
    {
      "code": "00-12345", "article": "AB-001",
      "name": "Радиатор Х", "is_archived": 0, "type": "Товар", "uuid": "…",
      "supplier": "Вектор", "supplier2": "Вектор", "supplier_label": "Вектор",
      "buy_price": "12 345,67 ₽",
      "min_stock": "10.000",
      "formula_proposed_min_stock": 12,
      "automation_price": "Авто",
      "proposed_min_stock": null,
      "min_stock_dg": "5.000",
      "multiplicity": "10.000",
      "min_stock_calc_as": null,
      "pack_qty": 6, "pack_qty_auto": 6, "pack_qty_manual": null,
      "stock": 42,
      "in_transit": 0,
      "no_longer_cooperation": "", "stock_position": "Да",
      "override_updated_at": "2026-05-12 19:01:23",
      "d_3": 0, "d_5": 1.2, "d_7": 2, "d_15a": 4.5, "d_15b": 0, "d_30a": 12, "d_30b": 2,
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

`field` ограничен whitelist'ом: `min_stock_dg` | `multiplicity` | `min_stock_calc_as` | `proposed_min_stock` | `pack_qty_manual`. Значения парсятся гибко (запятая = точка, пробелы игнорируются). Передача `value: ""` (или `null`) очищает поле в overrides (NULL).

Ответ при успехе содержит `stored` — текущее состояние строки `dg_purchase_overrides` для этого `code`, что позволяет UI **верифицировать** реальное значение в БД (по правилу `datagon-settings-save-feedback.mdc`).

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

Создаётся автоматически при первом обращении (`ensureZeroStockSchema`). Хранит факты «товар отсутствовал на складе на дату». Сейчас общая фиксация по товару (`store_uuid='__total__'`); по-складская разбивка — после `report/stock/bystore`. Поле `source`: `manual` — кнопка / `POST …/zero-stock-log`; `moysklad_sync` — пакетно **после успешного сохранения** `ms_export` при синке МойСклад (только `stock_position='Да'`, `is_archived=0`, `stock≤0` за **сегодня**; строка с `manual` за тот же день не перезаписывается).

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

### GET `/api/product/:code`

Агрегатный read-only ответ для рендера карточки.

Query:

- `recent_page` — номер страницы для блока «Последние отгрузки» (default 1).
- `recent_page_size` — размер страницы (10…200, default 100). Полный список за период — листая страницы или увеличив `recent_page_size`.
- `recent_via` — фильтр строк отгрузок: `all` (все) | `direct` (только прямые позиции по коду) | `bundle` (только эквивалент через комплекты; для карточки комплекта ветка через комплекты отключена на бэкенде).
- `recent_bundle_code` — при `recent_via=bundle` ограничить одним **кодом из строки отгрузки** (как правило код комплекта в МС; можно передать любой код, совпадающий с `bundle_code` в объединённой выборке). Без параметра — все комплекты в окне.
- `sales_from`, `sales_to` — даты **`YYYY-MM-DD`** (включительно). Если обе валидны и `from <= to`, окно продаж **календарное** (графики, сводки, `recent`, `via_bundles`); максимум 1825 дней между датами. Фильтр по дате отгрузки в SQL — **`DATE(d.moment)`** между этими днями (время суток из UI в query **не** передаётся; сравнение с отчётом МС «по часам» может расходиться на границах суток). Иначе используется скользящее окно `recent_days`.
- `recent_days` — скользящее окно в днях от `NOW()`, если **не** задана пара `sales_from`+`sales_to` (default 365, max 1825).
- `zero_days` — окно для лога нулевых остатков (default 90, max 1825).

Ответ (сжатая структура):

```json
{
  "success": true,
  "code": "10148",
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
    "min_stock_calc_as": null, "proposed_min_stock": null,
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
    "note": "По аналогии с продажами (только проведённые отгрузки), здесь — только факты из выгрузки МС: после успешного синка за сегодня автоматически пишется строка при складской позиции «Да», не архив и остаток ≤ 0. Ручная запись за тот же день автоматикой не перезаписывается."
  },
  "zero_stock_windows_import": {
    "reference_date": "2026-01-15",
    "absent_last_30": 2, "absent_last_60": 5, "absent_last_90": 8,
    "absent_last_180": 12, "absent_last_365": 40,
    "note": "Выгрузка из Excel за 15.01.2026",
    "created_at": "2026-01-16T10:00:00.000Z",
    "note_explain": "Импортированная сводка: числа — сколько дней с нулевым остатком в каждом скользящем окне относительно даты среза. Это не список конкретных календарных дней."
  },
  "formula": {
    "proposed_min_stock": 12,
    "settings_effective": { "replenishmentCoef": 0.333, "salesWindowDays": 90, "economyEnabled": false },
    "inputs": {
      "sales_window_days": 90,
      "sum_qty_window": 36,
      "avg_daily": 0.4,
      "prev_baseline": 10,
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
          "template": "Продажи за окно ÷ дней в окне (W)",
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

Объект **`formula`**: `proposed_min_stock` (целое, шт), `settings_effective` — нормализованный снимок настроек после clamp, `inputs` — числа и строки, ушедшие в расчёт (в т.ч. `prev_baseline_source` — откуда взят опорный неснижаемый: `override.proposed_min_stock` | `override.min_stock_dg` | `ms_export.min_stock`), `warnings` — например срабатывание ограничения скачка. Поле **`detail`** для карточки товара содержит только **`equation_stages`**: этапы в виде «шаблон формулы» и строка с подставленными числами (блок **«Формула этапами»** на UI). Логика в `lib/datagonSalesFormula.js`.

- `zero_stock` — `{ days, rows, note }`: построчный лог за запрошенную глубину; `note` — пояснение для UI (как заполняется лог автоматически после синка МС и зачем ручная кнопка).
- `zero_stock_windows_import` — последняя по дате среза (`reference_date`) и `id` запись из `dg_product_zero_stock_window_import` для этого кода, либо `null`, если импорта не было. Поле `note_explain` — подсказка для UI; не дублирует бизнес-данные.

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

- Доступ контролируется через `lib/datagonPageRegistry.js` — `/api/product/*` использует `pageKey: 'purchase'` (карточка товара доступна там же, где доступны «Закупки»). HTML `/product.html` наследует доступ от `purchase` (см. `isHtmlLeafAccessHidden`).
- Карточка открывается из таблицы «Закупки» (`/purchase.html`) — клик по «Коду» открывает `/product.html?code=XXX` в новой вкладке.
- Перезапуск Node обязателен после изменений в `routes/product.js` / `lib/datagonPageRegistry.js` / `server.js` (`datagon-node-restart-lock.mdc`).

## Активность

Маршруты `routes/activity.js` (события в интерфейсе):

### GET `/api/activity/events`

Выборка событий активности (параметры пагинации/фильтры — в роутере).

### POST `/api/activity/track`

Регистрация события активности с клиента.

## Минимальные проверки через curl

Большинство путей под `/api` требуют сессии после входа (cookie `dg_session` и/или заголовок `x-auth-token`, см. ответ `POST /api/auth/login`). Прямой `GET /api/my-sites` без авторизации вернёт **401**.

```bash
curl -i -X POST "http://localhost:3000/api/auth/login" \
  -H "Content-Type: application/json" \
  --data '{"username":"admin","password":"YOUR_PASSWORD"}'
```
