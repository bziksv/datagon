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

Эндпоинты для экрана «Сопоставление» (ручная очередь, архив, поиск по ценам конкурента, лог): `GET/DELETE /api/matches/manual-queue`, `GET/DELETE /api/matches/manual-archive`, `GET /api/matches/prices-resolve-sku`, `GET /api/matches/prices-search`, `GET /api/matches/product-match-log`, `POST /api/matches/manual-match/confirm`, `POST /api/matches/manual-match/archive`. Точные query и JSON — в `routes/matches.js`.

## MoySklad

### POST `/api/ms/sync`
Запустить фоновую синхронизацию в таблицу `ms_export`.

### GET `/api/ms/status`
Проверить статус задачи синхронизации.

### GET `/api/ms/export`
Получить экспортированные строки.

Query:
- `search`
- `type` (`all`, `Товар`, `Комплект`)
- `limit`
- `offset`
- прочие поля фильтрации — см. `buildExportFilters` в `routes/moysklad.js`
- **сеточные** фильтры (первая строка полей на экране «МойСклад», те же условия что и для `/api/ms/stats`): `g_code`, `g_name`, `g_supplier`, `g_supplier2`, `g_manager`, `g_content_manager`, `g_type` (подстрока типа, регистр не важен), `g_stock_min`, `g_stock_max`, `g_archived` (`all` | `0` | `1`)

### GET `/api/ms/detail/:uuid`

**Одиночная** загрузка полной карточки товара или комплекта из JSON API МойСклад (включая все атрибуты), для экрана «МойСклад» по клику на наименование. Это **не** часть ночной синхронизации в `ms_export`: каждый открытый диалог — отдельные запросы к API (плюс кэшируемый на **~60 минут** справочник имён атрибутов `metadata/attributes`, см. `MS_ATTRS_META_CACHE_TTL_MS` в `routes/moysklad.js`). Учитывайте [лимиты МойСклад](https://dev.moysklad.ru/doc/api/remap/1.2/#/general/limits) при массовом просмотре.

Query:

- `kind` — подсказка типа сущности: `product` | `bundle` или строка с подстрокой «комплект» (как в поле `type` выгрузки).

Ответ: `success`, `kind`, `uuid`, `webHref` (если API вернул `meta.uuidHref`), `blocks` — массив секций с табличными строками `label` / `value` для отображения в UI. В блоке карточки показываются все `salePrices` из МойСклад; типы цен с нулевым значением отображаются как `0.00 ₽`.

### GET `/api/ms/stats`

Агрегированная статистика по выгрузке МойСклад (с кэшем на сервере; параметры — в `routes/moysklad.js`). Набор фильтров совпадает с `GET /api/ms/export`, включая **`g_*`** (сеточные поля экрана).

### POST `/api/ms/stop`

Остановить фоновую задачу синхронизации с API МойСклад.

### POST `/api/ms/rebuild-links-cache`

Пересборка серверного кэша связей кодов с `ms_export` (используется из UI «Мои товары»).

## Exports / marketplaces

Префикс: `/api/exports/marketplaces`. Доступ к API проверяется по странице **`exports-marketplaces`** (матрица `page_modes`: скрытие «Настроек» отключает и вызовы API выгрузок). Настройки ключей/лимитов перенесены в **`/settings.html#marketplaces`**; страница `/exports-marketplaces.html` оставлена как редирект. Отдельные экраны таблиц — **`/exports-marketplaces-ozon.html`**, **`/exports-marketplaces-wildberries.html`**, **`/exports-marketplaces-yandex.html`**: они автозагружают последний сохранённый снапшот и имеют кнопку принудительного обновления. Сами запросы выполняются **на сервере** (долгие циклы допустимы; таймауты прокси/nginx настройте под свой каталог).

**Учётные данные** (в порядке приоритета):

1. Переменные окружения: `OZON_CLIENT_ID`, `OZON_API_KEY`, `WB_API_KEY`, `YM_API_KEY`, `YM_CAMPAIGN_ID`, `YM_BUSINESS_ID` (последний опционально — для ссылки «Покупателю» на Я.Маркете).
2. Либо ключи в таблице `app_settings`: `ozon_client_id`, `ozon_api_key`, `wb_api_key`, `ym_api_key`, `ym_campaign_id`, `ym_business_id` — через `POST /api/exports/marketplaces/config` (только **admin** или пользователь с **полным** доступом к разделу «Настройки»).

### GET `/api/exports/marketplaces/status`

Возвращает JSON `{ configured: { ozon, wildberries, yandex_market }, rate_limits_ms_min, hints }` — какие интеграции считаются настроенными (без раскрытия значений ключей) и **минимальные паузы между запросами** к каждому маркетплейсу (мс). Параметры `delay_*` в выгрузках не опускаются ниже этих значений.

**Поведение при лимитах:** HTTP-клиент к маркетплейсам повторяет запрос при **429 / 502 / 503** с экспоненциальным backoff и с учётом заголовка **`Retry-After`** (секунды), до ограниченного числа попыток. Точные RPM по кабинету не зашиты в код — ориентируйтесь на официальную документацию и при необходимости увеличивайте `delay_*`.

### POST `/api/exports/marketplaces/config`

Legacy-совместимость для старого экрана настроек маркетплейсов. Новая UI-практика — сохранять эти поля через `POST /api/settings`.

### GET `/api/exports/marketplaces/ozon`

Query:

- `format` — `json` (по умолчанию) или `csv` (файл UTF-8 с BOM, разделитель `;`).
- `max_items` — ограничение строк каталога (1…25000, по умолчанию 5000 на бэкенде если не передано; экран диагностики в панели по умолчанию шлёт 300).
- `include_archived` — `1` для `visibility: ALL` в списке Ozon (как в скрипте с `OZON_INCLUDE_ARCHIVED`).
- `delay_ms` — пауза между запросами к Ozon (мс, по умолчанию 400; не ниже минимума из `rate_limits_ms_min.ozon`).

Параметр `max_items` оставлен для интеграций и ручных `curl`, но UI-экраны маркетплейсов его больше не задают.

Ответ JSON: `{ marketplace, updatedAt, count, persisted_count, headers, headerLabels, rows }` — `headers` — ключи полей в объектах `rows`, `headerLabels` — подписи столбцов для UI (для Ozon с суффиксом «Ozon», как в CSV), `persisted_count` — сколько строк сохранено/обновлено в БД для последующей обработки. CSV UTF-8 с BOM: первая строка — `headerLabels` для Ozon: «Артикул (offer_id) Ozon», «Наименование Ozon», «Цена Ozon», «НДС Ozon», «Статус Ozon», «Причина блокировки Ozon», «Остаток Ozon», «Длина (см) Ozon», «Ширина (см) Ozon», «Высота (см) Ozon», «Вес (кг) Ozon», «Кабинет Ozon», «Покупателю Ozon», «Обновлено Ozon».

### GET `/api/exports/marketplaces/wildberries`

Query: `format`, `max_items`, `delay_cards`, `delay_other` (мс; по умолчанию 600 и 1600, не ниже `rate_limits_ms_min.wbCards` / `wbPricesStocks`). Логика: карточки `content/v2/get/cards/list`, цены `discounts-prices-api`, остатки `marketplace-api` по складам (при ошибке остатков таблица всё равно возвращается с нулевыми остатками).

Ответ JSON: как у Ozon — `headers`, `headerLabels`, `rows`, `persisted_count`. Заголовки CSV/UI для WB (суффикс « WB»): «Артикул продавца WB», «Наименование WB», «Цена WB», «НДС WB», «Остаток WB», «Длина (см) WB», «Ширина (см) WB», «Высота (см) WB», «Вес (кг) WB», «Кабинет WB», «Покупателю WB», «Обновлено WB».

### GET `/api/exports/marketplaces/yandex-market`

Query: `format`, `max_items`, `delay_ms` (по умолчанию 280 мс, не ниже `rate_limits_ms_min.yandex`). Листинг SKU через `GET …/offer-prices`, цены `POST …/offer-prices`, карточные данные `POST …/stats/skus`.

Ответ JSON: как у Ozon — `headers`, `headerLabels`, `rows`, `persisted_count`. Заголовки CSV/UI для Я.Маркета (суффикс « Я.Маркет»): «Артикул Я.Маркет», «Наименование Я.Маркет», «Цена Я.Маркет», «НДС Я.Маркет», «Остаток Я.Маркет», «Длина (см) Я.Маркет», «Ширина (см) Я.Маркет», «Высота (см) Я.Маркет», «Вес (кг) Я.Маркет», «Кабинет Я.Маркет», «Покупателю Я.Маркет», «Обновлено Я.Маркет».

### GET `/api/exports/marketplaces/snapshot`

Чтение последнего сохранённого снапшота из `marketplace_export_rows` (без live-запросов к внешнему API).

Query:

- `shop` — обязательный: `ozon` | `wildberries` (`wb`) | `yandex` (`yandex-market`, `ym`).
- `max_items` — ограничение выдачи (1…25000, по умолчанию 300).

Ответ JSON: `{ marketplace, source: "snapshot", updatedAt, count, headers, headerLabels, rows }`.

- `rows` строятся из `row_json` (с fallback на нормализованные колонки таблицы).
- Если сохранённых строк нет, возвращается `count=0` и пустой `rows`.
- Этот маршрут используется UI-экранами маркетплейсов для автоподгрузки данных при открытии страницы и для кнопки «Показать последнее сохранённое».

### POST `/api/exports/marketplaces/sync`

Принудительный запуск обновления с live API маркетплейсов и сохранением в `marketplace_export_rows`.

Body (JSON):

- `shop` — `all` (по умолчанию), `ozon`, `wildberries` (`wb`), `yandex-market` (`ym`).

Ответ: `{ success: true, started: true }`. Если задача уже выполняется — `409`.

### GET `/api/exports/marketplaces/sync-status`

Текущий статус фонового обновления маркетплейсов: активность, сообщение, состояние по каждой площадке.

Технически строки сохраняются в таблицу `marketplace_export_rows` (создаётся автоматически): уникальность по паре `(marketplace, external_id)`, полные данные каждой строки — в `row_json`, плюс нормализованные колонки (`price`, `vat`, `stock`, габариты, ссылки и т.д.) для SQL-обработки.

## Exports / Huckster

Префикс: `/api/exports/huckster`. Экран: `/exports-huckster.html`.

Матрицы (`sheet_export` / `sheet_export_rrc`):

- **`sheet_export` (набор 1, Huckster Export)** и **`sheet_export_rrc` (набор 2, Huckster Export RRC):** строки из таблицы **`ms_export`** (МойСклад): **складская позиция** = «Да»; **«Перестали сотрудничать»** = «Да» отфильтровываются, **кроме** позиций с **остатком больше нуля** (их оставляем). Колонки: **ID / КОД** (= код МС, сопоставляется с `uid` в repricer), **Наименование товара**, **Менеджер**, **Остаток**, по маркетплейсам **Ozon / WB / ЯМ** — статус **«Репрайсер ВКЛЮЧЕН»** (зелёный), если по этому коду есть **ровно один** включённый repricer в маркетплейсе; иначе **«Репрайсер ВЫКЛЮЧЕН»** (красный: ноль или больше одного включённых — нельзя однозначно выбрать кабинет). Рядом колонки **«Модель …»** показывают назначение Unit-модели: название модели (зелёный), **«Модель не назначена»** (красный) или **«Модель назначена, но Репрайсер на модели выключен»** (жёлтый). Для набора 1 действует фильтр Unit-моделей «онлайн»+«калькулятор», для RRC — полный набор Unit-моделей. Последняя колонка **«Актуально на»** — время синка. В JSON добавлены **`bridge_row_meta`** (состояния кабинетов для подсветки), **`matrix_kind`: `ms_bridge_v1`**. Реализация: `lib/hucksterMsBridgeMatrix.js` + `routes/exportsHuckster.js`.

Старые снапшоты наборов 1/2 с первой колонкой **«Обновлено (repricer)»** UI отображает по прежней сетке (UID × кабинеты).

Ежедневный запуск по расписанию (МСК): флаги **`auto_sync_huckster_enabled`** / **`auto_sync_huckster_time`** в `POST /api/settings` — см. раздел [Settings](#settings); реализация в `server.js` (очередь `auto_sync_runs`, тип задачи `huckster`).

### POST `/api/exports/huckster/sync`

Принудительно **запускает фоновое** обновление двух матриц Huckster (аналог листов Google Sheets `Huckster Export` и `Huckster Export RRC`) через API `wbs.e-teleport.ru`.

Основная кнопка экрана `/exports-huckster.html` отправляет **пустое** тело `{}` и полагается на креды, уже сохранённые на сервере (см. ниже `credentials` / переменные окружения). Кнопка **«Тест UID»** отправляет `test_uids` и не перезаписывает сохранённый snapshot.

Body (JSON):

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
- `result` — финальный результат (при успехе: `sheet_export.rows`, `sheet_export_rrc.rows`, `updated_at`; для тестового запуска ещё `test_uids`).
- `error` — объект ошибки (в том числе `HUCKSTER_STOPPED` после ручной остановки).

### POST `/api/exports/huckster/stop`

Запрашивает остановку активного обновления Huckster.

Ответ JSON: `{ "success": true, "stop_requested": true }`.  
Если активной задачи нет — `409` с кодом `NOT_RUNNING`.

Успешное завершение обновления дополнительно сохраняет матрицы в таблицу `huckster_matrix_snapshots` (строка `id=latest`, поле `payload_json` LONGTEXT).

### GET `/api/exports/huckster/snapshot`

Последнее успешное сохранение матриц (без запросов к e-teleport). Используется UI для автоподгрузки после обновления страницы.

Ответ JSON: `success`, `source: "snapshot"`, `empty` (boolean), `updated_at`, опционально `stored_at` (время записи в БД), `sheet_export` / `sheet_export_rrc` — те же объекты, что в результате sync (`rows`, `total_uids` или `total_rows`, при новой bridge-схеме ещё `bridge_row_meta`, `matrix_kind`). Если сохранений ещё не было — `empty: true` и пустые `rows`.

### DELETE `/api/exports/huckster/snapshot`

Удаляет из БД последний сохранённый снапшот матриц (`DELETE FROM huckster_matrix_snapshots WHERE id='latest'`). Идемпотентно: если записи не было — успех. Сбрасывает в памяти процесса поле `result` у фонового статуса Huckster, чтобы `GET /sync-status` не отдавал устаревшие `sheet_export` после очистки. Требует авторизацию (как остальные методы под `/api/exports/huckster` после входа). На экране `/exports-huckster.html` вызывается из кнопки **«Очистить таблицы»** (после подтверждения).

Ответ JSON: `{ "success": true, "cleared": true }`.

### GET `/api/exports/huckster/config`

Возвращает текущие наборы магазинов `set1` / `set2` для Huckster. На экране `/exports-huckster.html` в форме редактируются **оба** набора; тот же контракт доступен через этот API.

### POST `/api/exports/huckster/config`

Сохраняет наборы магазинов Huckster.

Body (JSON):

- `set1`: массив объектов `{ id, name, marketplace, shop_id }`
- `set2`: массив объектов `{ id, name, marketplace, shop_id }`

`marketplace` допускает только `ozon`, `wildberries`, `yandex`. Оба набора обязаны содержать хотя бы одну валидную строку. Панель при сохранении отправляет оба массива из формы.

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

Сводка для экрана «Логи»: глобальный синк, МойСклад, авто-синки, discover, очередь `pages`, матчинг по `my_site_id`, метрики runtime. Query: `my_site_id` (опционально, для блока матчинга).

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
