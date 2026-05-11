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

### POST `/api/settings/auto-sync-run`

Принудительно поставить одну задачу автосинхронизации в общую очередь расписания, не дожидаясь времени запуска. Используется кнопками «Запустить сейчас» в `settings.html`.

Body: `{ "task": "myproducts" | "moysklad" | "marketplaces" | "huckster" | "db_size" }`. Запись в `auto_sync_runs` создаётся с `trigger_type = "manual"`.

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

Проблемы с товарами (бывш. «Неопубликованные»). Возвращает строки **`ms_export`** по основному фильтру `stock_position = 'Да' AND no_longer_cooperation = 'Нет'` с сопоставлением артикулов на 3 маркетплейсах через **`marketplace_export_rows.external_id`** (= `offer_id` для Ozon, `vendor_code` для WB, `shop_sku` для YM, см. `lib/marketplaceExportStore.js#externalIdFor`). По каждой строке возвращается полный паспорт МС (`ms_stock`, `ms_vat` из `ms_export`) и каждого маркетплейса: `*_code`, `*_name`, `*_vat` (нормализован `prettifyMarketplaceVat`), `*_stock`, `*_length` / `*_width` / `*_height` (см), `*_weight` (кг), `*_cabinet_url`, `*_buyer_url`, `*_updated` (метка свежести снапшота — `updated_label` или форматированный `updated_at`). Поля **`uuid`** и **`type`** из `ms_export` приходят в каждом объекте `rows[]`, но **не** входят в массив **`headers`** (нужны UI для карточки МС и `GET /api/ms/detail/:uuid`, а не как отдельные колонки). Если код маркетплейса не найден в последнем снапшоте — все его поля приходят `null`; фронт подсвечивает пары `(*_code, *_name)` красным. Порядок колонок МС в `headers`/`headerLabels`: `code`, `name`, `manager`, `content_manager`, `ms_vat`, `ms_stock`, `synced_at`.

Query:

- `scope` — фильтр выборки:
  - `all` (по умолчанию) — все товары МС по основному фильтру;
  - `any` — у кого хотя бы один из 3 маркетплейсов не нашёл товар;
  - `all3` — нет ни на одном из 3 маркетплейсов;
  - `ozon` / `wb` / `ym` — нет на конкретном маркетплейсе;
  - `vat_mismatch` (алиас `vat-mismatch`) — товар есть в снапшоте маркетплейса, но нормализованный НДС МС не совпадает с НДС на этой площадке (Wildberries со значением «не указан» в сравнении не участвует);
  - `dims_mismatch` (алиас `dims-mismatch`) — товар есть минимум на двух маркетплейсах, и по хотя бы одной из осей длина/ширина/высота (см) или вес (кг) **обе площадки отдают число**, а значения расходятся с допуском 0,02 (пара «число vs пусто» не считается расхождением). С МойСклад не сравнивается: в `ms_export` нет этих полей. Отбор **в памяти** после `prettifyMarketplaceVat` и фильтра комплектов, в пределах первых `max_items` строк по `ORDER BY m.code` — при очень большом каталоге возможны «хвосты» за пределом лимита.
- `max_items` — лимит выборки, 1..100000, по умолчанию 50000.
- `exclude_bundle_components` — `1` (по умолчанию) исключает товары, чей `code` встречается как компонент хотя бы одного комплекта (`ms_entity_details.kind = 'bundle'`, поле `payload_json.components.rows[].assortment.code`). Любое явно «ложное» значение (`0` / `false` / `no` / `off`) выключает фильтр. Полный набор кодов-компонентов кэшируется в памяти процесса на 5 минут (см. `getBundleComponentCodesCached` в `routes/exportsMarketplaces.js`); первый запрос после рестарта Node читает payload всех bundle-сущностей, последующие — берут готовый Set.

Ответ JSON:

```json
{
  "scope": "all",
  "scope_label": "все товары",
  "count": 123,
  "headers": ["code","name","manager","content_manager","ms_vat","ms_stock","synced_at","ozon_code","ozon_name","ozon_vat","ozon_stock","ozon_length","ozon_width","ozon_height","ozon_weight","ozon_cabinet_url","ozon_buyer_url","ozon_updated","wb_code","wb_name","wb_vat","wb_stock","wb_length","wb_width","wb_height","wb_weight","wb_cabinet_url","wb_buyer_url","wb_updated","ym_code","ym_name","ym_vat","ym_stock","ym_length","ym_width","ym_height","ym_weight","ym_cabinet_url","ym_buyer_url","ym_updated"],
  "headerLabels": ["Код МС","Название МС","Менеджер","Контент-менеджер","НДС МС","Остаток по МС","Синхронизация МС","Код Ozon","Название Ozon","НДС Ozon","Остаток Ozon","Длина (см) Ozon","Ширина (см) Ozon","Высота (см) Ozon","Вес (кг) Ozon","Кабинет Ozon","Покупателю Ozon","Обновлено Ozon","Код Wildberries","Название Wildberries","НДС WB","Остаток WB","Длина (см) WB","Ширина (см) WB","Высота (см) WB","Вес (кг) WB","Кабинет WB","Покупателю WB","Обновлено WB","Код Я.Маркет","Название Я.Маркет","НДС Я.Маркет","Остаток Я.Маркет","Длина (см) Я.Маркет","Ширина (см) Я.Маркет","Высота (см) Я.Маркет","Вес (кг) Я.Маркет","Кабинет Я.Маркет","Покупателю Я.Маркет","Обновлено Я.Маркет"],
  "rows": [
    { "code": "ABC-1", "name": "...", "uuid": "…", "type": "Товар", "manager": null, "content_manager": null, "ms_vat": "20%", "ms_stock": 12, "synced_at": "01.01.2026 12:00", "ozon_code": "ABC-1", "ozon_name": "...", "ozon_vat": "20", "ozon_stock": "12", "ozon_length": "30", "ozon_width": "20", "ozon_height": "10", "ozon_weight": "0.5", "ozon_cabinet_url": "https://seller.ozon.ru/...", "ozon_buyer_url": "https://www.ozon.ru/...", "ozon_updated": "01.01.2026 12:30", "wb_code": null, "wb_name": null, "wb_vat": null, "wb_stock": null, "wb_length": null, "wb_width": null, "wb_height": null, "wb_weight": null, "wb_cabinet_url": null, "wb_buyer_url": null, "wb_updated": null, "ym_code": "ABC-1", "ym_name": "...", "ym_vat": "20", "ym_stock": "8", "ym_length": "30", "ym_width": "20", "ym_height": "10", "ym_weight": "0.5", "ym_cabinet_url": "https://partner.market.yandex.ru/...", "ym_buyer_url": "https://market.yandex.ru/...", "ym_updated": "01.01.2026 12:35" }
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

Назначение: реестр замеров габаритов товаров и комплектов МойСклад с фиксацией **кто** и **когда** замерял. Базовые поля (код, наименование, тип) берутся из `ms_export`. Замеры хранятся в отдельной таблице **`ms_dimensions_measurements`** и подмешиваются к строкам `ms_export` по полю `code`.

Таблица создаётся при первом обращении к роуту:

```sql
CREATE TABLE IF NOT EXISTS ms_dimensions_measurements (
    code VARCHAR(255) NOT NULL PRIMARY KEY,
    measured_by_user_id INT NULL,
    measured_by_name VARCHAR(255) NULL,
    measured_at TIMESTAMP NULL,
    dimensions_json LONGTEXT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_dim_meas_by_user (measured_by_user_id),
    INDEX idx_dim_meas_at (measured_at)
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
- `sort_by` — `code` | `name` | `type` | `measured_by_name` | `measured_at` (по умолчанию `code`).
- `sort_dir` — `asc` | `desc`.

Ответ: `{ success: true, rows: [...], total, limit, offset, sort_by, sort_dir }`. Каждая строка содержит `code`, `name`, `type`, `uuid`, `is_archived` (bool), `measured_by_user_id` (`number|null`), `measured_by_name` (string), `measured_at` (ISO-строка или `''`).

### POST `/api/exports/dimensions/measure`

Создать/обновить замер по коду (на UI пока не задействовано; контракт сохранён, схему полей `dimensions` пользователь предоставит позже).

Body (JSON):

- `code` (обяз.) — код МС.
- `dimensions` (опц., объект) — произвольные поля габаритов, сериализуются в `dimensions_json`. При отсутствии поля старое значение сохраняется (`COALESCE(VALUES(dimensions_json), dimensions_json)`).
- `measured_by_name` (опц.) — если не указано, берётся `full_name` или `username` текущей сессии (`req.datagonActor`).
- `measured_at` (опц., ISO-строка) — если не указано, берётся время сервера.

Ответ: `{ success: true, code, measured_by_user_id, measured_by_name, measured_at }`.

### DELETE `/api/exports/dimensions/measure/:code`

Удалить замер по коду (откатывает «Кто замерял» / «Дата замера» в пустое значение).

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

- **`moyskladPersistedLogs`** — все строки `dg_ms_sync_log` за выбранный день в МСК (упорядочены по `id ASC`). Реализация: `fetchMsSyncPersistedLogsForDate(db, forDate)` в `routes/moysklad.js`.
- **`autoSyncRuns`** — записи `auto_sync_runs`, чей `started_at` приходится на выбранный день в МСК. Фронт группирует их по `task_type` (`myproducts`, `moysklad`, `marketplaces`, `huckster`, `db_size`) и показывает по разделам с понятными названиями.
- **`matches`** — последняя задача `matching_jobs` для `my_site_id`, чей `started_at` приходится на выбранный день в МСК. Если задач за день не было — `matches.message` = «За выбранный день задач сопоставления не было».
- **`moysklad.logs`** (in-memory `jobState.logs`, до 30 строк текущей сессии) — отдаются только за «сегодня»; для других дней массив пустой, так как память процесса не различает даты.

Дополнительные поля ответа: `forDate` (фактически применённая дата), `forDateOptions` (массив из 14 допустимых дат, новейшая первая), `moscowToday`, `isToday`.

Размер базы считается через `information_schema.TABLES` и кэшируется на 5 минут.

### GET `/api/processes/db-size`

Размер текущей MySQL-базы: общий объём, данные, индексы, число таблиц, время расчёта и признак кэша. Без параметров отдаёт суточный кэш; `?refresh=1` принудительно пересчитывает показатель для кнопки «Обновить размер БД» на дашборде.

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
