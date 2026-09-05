---
id: settings
title: Настройки
description: Глобальные параметры парсинга, синхронизации, пользователи; что менять осторожно
---

**`/settings.html`** — **глобальные** параметры приложения: лимиты **парсера** (`default_limit`, `parse_batch_size`, `page_delay_ms` и др.), батчи и паузы **синхронизации** `my_products`, блок **МойСклад** (если вынесен в форму), **пользователи** и пароли, при наличии — **расписания** автозапусков.

<blockquote class="dg-doc-tip">
<strong>Снимок интерфейса.</strong> PNG обновляют: <code>npm run docs:capture-screenshots</code> (с <code>DOCS_USER</code> и <code>DOCS_PASSWORD</code> — с живой панели; без входа — с макета <code>/doc-screenshots/settings-sample.html</code>) и <code>npm run docs:docusaurus:build</code>. Полная страница в кадре. <a href="./capture-screenshots.md">Подробнее о съёмке</a>.
</blockquote>

<figure class="dg-doc-shot">
<img src="/docs/screenshots/settings.png" alt="«Настройки»" loading="lazy" />
<figcaption>Настройки: формы глобальных параметров (полная страница в кадре).</figcaption>
</figure>

## Группы настроек (логика)

| Группа | Зачем трогать |
|--------|----------------|
| **Парсинг** | Если конкуренты режут по IP или отдают 429 — **увеличьте** `page_delay_ms`, уменьшите размер батча парсинга. |
| **Прокси для парсинга** | Если с датацентрового IP отдают антибот/WAF вместо карточки — включите глобальный список HTTP(S)-прокси (`fetch_proxy_*`); у отдельного конкурента в [Проектах](/docs/projects/) можно выбрать режим «наследовать» или «напрямую». |
| **Синхронизация** | Длинные паузы между батчами снижают нагрузку на внешние БД источников. |
| **Пользователи** | Доступ в панель; политика паролей — по договорённости в команде. |
| **МойСклад** | Если токен задаётся не только в `config.js` — дублирование источников правды лучше избегать. |

## Что менять осторожно

- **`page_delay_ms = 0`** на «живых» конкурентах — быстрый путь к бану.
- Огромные **`parse_batch_size`** / **`sync_batch_size`** на слабом MySQL — рост длительности транзакций и блокировок.
- Любые изменения, требующие перечитывания конфига **только при старте** — потребуют **рестарта Node** (уточняйте по поведению: если после сохранения в UI значение не применилось — перезапуск).

## Ключи `app_settings` (часто встречающиеся)

Полный перечень смотрите в коде инициализации в `server.js` и в [REST API — Settings](/docs/api/#settings). Ниже — смысл «с высоты птичьего полёта»:

| Ключ | Зачем трогать |
|------|----------------|
| `default_limit` | Размер страницы списков по умолчанию в API/UI. |
| `parse_batch_size` / `page_delay_ms` | Нагрузка на сайты конкурентов при парсинге. |
| `sync_batch_size` / `sync_delay_ms` | Нагрузка на внешние БД при синке «Мои сайты». |
| `sync_mode` | Политика запуска синка (как интерпретирует сервер — см. код). |
| `log_retention_days` / `results_retention_days` | `results_retention_days` — срок хранения **истории** в `prices` (последняя цена по странице не удаляется; на `pages` кэш названия/SKU/цены). Страницы product/`done` без `prices` возвращаются в `pending`. **`log_retention_days`** — по-прежнему в `app_settings` и используется `cleanupLogsByRetentionDays` в `server.js` для **файлов** `server.log` / `worker.log` в корне проекта (если есть и старше порога — обнуляются раз в 12 ч); отдельного поля в UI настроек нет. |
| `ms_dimensions_log_retention_days` | Срок хранения строк в таблице **`ms_dimensions_log`** (журнал **только** по габаритам/замерам и выгрузке этих полей в МС; не общий лог приложения; по умолчанию **180 дней**). Автоочистка — раз в 12 часов плюс при старте сервера (`cleanupDimensionsLogByRetentionDays()` в `server.js`). UI: карточка **«Журнал изменений габаритов»** на `/settings.html`, inline-feedback `runSaveWithInlineFeedback` с `sectionId='dim-log'`; кнопки «Обновить статистику» (`GET /api/exports/dimensions/log/stats`) и «Очистить сейчас» (`POST /api/exports/dimensions/log/cleanup`). |
| `product_stock_snapshot_retention_days` | Срок хранения строк в **`dg_product_stock_snapshot`** (один снимок `ms_export.stock` на календарный день после полного синка МС; по умолчанию **365 дней**, диапазон **30…3650**). Старые даты удаляются при каждом успешном полном синке. UI: карточка **«Снимки остатка МС (карточка товара)»** на `/settings.html`, `sectionId='stock-snap-retention'`; сохранение через `POST /api/settings` с верификацией ключа. |
| `dg_purchase_overrides_log_retention_days` | Срок хранения строк в **`dg_purchase_overrides_log`** (журнал изменений полей **Нес.остаток Датагон**, **Кратность товара**, **Мин.Остаток сч.как 0** на `/purchase.html` и при CSV-импорте; по умолчанию **180 дней**). Автоочистка — `cleanupPurchaseOverridesLogByRetentionDays()` в `server.js` (раз в 12 ч + старт). UI: карточка **«Журнал изменений закупок (overrides)»** на `/settings.html`, `sectionId='purchase-ov-log'`; `GET /api/purchase/log/stats`, `POST /api/purchase/log/cleanup`. |
| `auto_sync_runs_retention_days` | Срок хранения строк в **`auto_sync_runs`** (журнал запусков автосинхронизации: то, что на `/processes.html` с кнопкой «Лог»; по умолчанию **180 дней**). Удаляются только **завершённые** записи (`finished_at` задан). Автоочистка — раз в 12 часов и при старте сервера (`cleanupAutoSyncRunsByRetentionDays()` в `server.js`). UI: карточка **«Журнал запусков автосинхронизации»** на `/settings.html`, `sectionId='asr-log'`; `GET /api/settings/auto-sync-runs/stats`, `POST /api/settings/auto-sync-runs/cleanup`. |
| `ms_sync_page_limit` / `ms_sync_delay_ms` | Пакеты и паузы при обходе выгрузки МС. |
| `ms_orders_sync_days` / `ms_orders_exclude_owner_names` | **Заказы в МС** (`/ms-orders.html`): период синхронизации и списка (1..365 дн., default **30**) и исключение ответственных по подстроке имени. Карточка «Заказы в МС» на `/settings.html`. |
| `auto_sync_mssales_enabled` / `auto_sync_mssales_time` / `auto_sync_mssales_days` / `auto_sync_mssales_weekdays` | Авто-импорт **Продаж МС** (`/ms-sales.html`). Окно `auto_sync_mssales_days` (1..1825, default **90**), время МСК (default **07:30**). **`auto_sync_mssales_weekdays`** — CSV **1=пн … 7=вс** по МСК; пусто, строка **`1,2,3,4,5,6,7`** или все семь галочек в UI — каждый день (в БД «все дни» сохраняется как явная семёрка, чтобы снятие одного дня не превращалось обратно в «все дни»). Расписание: `triggerSync(db, { days, incremental: true })` — догрузка с последней даты в БД, не head-resume по MIN(moment). «Запустить сейчас» → `task: 'mssales'`. |
| `auto_sync_mssales_full_enabled` / `auto_sync_mssales_full_time` / `auto_sync_mssales_full_days` / `auto_sync_mssales_full_weekdays` | Отдельное расписание **полного** синка (`fresh: true`), своё окно (default **730** дн.) и дни недели (default **только вс**). `task: 'mssales_full'`. Не пересекайте время с обычным `mssales`, если оба включены — второй старт получит `already_running`. |
| `auto_sync_myproducts_*` / `auto_sync_marketplaces_ozon_*` / `auto_sync_marketplaces_wb_*` / `auto_sync_marketplaces_ym_*` / `auto_sync_huckster_*` / `auto_sync_db_size_*` / `auto_sync_dimensions_*` | Расписание фоновых задач по московскому времени. **Маркетплейсы** — три отдельные задачи (Ozon / WB / Я.Маркет) с разнесённым временем и отдельными логами `logs/marketplace-*-sync.log`; legacy `auto_sync_marketplaces_*` только для старого ручного `task=marketplaces`. Галка «Размер БД и диска» (`auto_sync_db_size_*`) единовременно пересчитывает **обе** метрики дашборда. Также — **выгрузка габаритов** в МойСклад (`dimensions`). |
| `auto_sync_medmarket_*` | **Воскресенье (вс):** полная выгрузка атрибута из карточек МС в `ms_export` (`medmarket`). Карточка в блоке **«Экспорт в МС»** (импорт, не запись в МС). |
| `auto_sync_medmarket_fill_*` | **Пн–сб:** запись `код+Тип` в атрибут МС (`medmarket_fill`, блок «Экспорт в МС»). Очередь — исправления формата/регистра, не весь каталог; см. синюю плашку на `/settings.html`. |
| `auto_sync_moysklad_*` | **Выгрузка МойСклад в `ms_export`** (номенклатура, остатки, неснижаемый из API МС, полные карточки в `ms_entity_details`). После успешной записи `ms_export` — пакетное обновление `dg_product_zero_stock_log` за сегодня (складская позиция «Да», не архив, остаток ≤ 0 **или** для кода без «-» остаток &lt; мин. суффикса в кодах «код-число» в выгрузке). **Не** импорт отгрузок — это `auto_sync_mssales_*` / `mssales_full`. См. [MoySklad в API](/docs/api/#moysklad). |
| `auto_sync_ms_orders_*` | **Заказы в МС** (`/ms-orders.html`): импорт `customerorder` в `ms_customer_order`; период — `ms_orders_sync_days`, исключения — `ms_orders_exclude_owner_names`, дни недели — `auto_sync_ms_orders_weekdays` (пусто = ежедневно). По умолчанию **08:00** МСК. См. [Заказы в МС](/docs/api/#заказы-в-мс). |
| `auth_session_ttl_days` / `auth_session_user_limit` | Длительность сессии и лимит одновременных сессий на пользователя. |
| `auth_online_presence_minutes` | Окно для виджета «онлайн» в шапке. |
| `fetch_proxy_enabled` / `fetch_proxy_list` | Глобальный выключатель и список прокси для загрузки HTML конкурентов (worker и точечный парсинг учитывают настройки проекта). |
| `sales_formula_*` | Формула продаж v2 на [карточке товара](/docs/product): W/A; **пополнение в днях** (`sales_formula_replenishment_days`, k=дни÷W); **`sales_formula_sku_replenishment_enabled`** (1/0) — колонка «Рек. пополнение» = факт по эпизодам нуля (без пола на глобаль); в `k` только если рек. **строго выше** базы; **`sales_formula_absence_analysis_days`** — окно для **упущенных шт в спросе**. Два рычага (спрос / горизонт), не дубль одной поправки. «Базовый запас» / «для дорогих» — минимумы после кратности; «для редких» — ранняя ветка. См. `lib/datagonSalesFormula.js`. |

Ручной запуск задач из той же карточки (кнопки «Запустить сейчас» → `POST /api/settings/auto-sync-run`): ответ сервера показывается **цветной плашкой** вверху блока (принято в очередь / уже выполняется или уже в очереди / ошибка), с указанием **занятости воркера** и **текущей очереди**; во время ожидания ответа кнопка блокируется. Кнопка **«Лог»** рядом открывает модалку с выбором **дня (МСК)** и списком записей `auto_sync_runs` этой задачи (`GET /api/settings/auto-sync-runs?task=&date=`). Подробный ход по всем задачам за день — на странице [«Логи фоновых процессов»](/docs/processes).

**Локальная разработка с общей БД:** поднимайте Node через **`npm run dev:local`** (`DATAGON_AUTO_SYNC_SCHEDULER=off`). Расписание из карточек выше **не сработает** на локальном процессе (это намеренно — иначе дублируются запуски с продом); кнопки «Запустить сейчас» работают. На проде scheduler включён по умолчанию. См. [Деплой — переменные окружения](/docs/deploy).

## Пользователи и безопасность

- Минимальная длина пароля и смена через UI/API — см. [Auth в API](/docs/api/#auth).
- Пользователь **`admin`** защищён от удаления и архивации; право «кто может создавать пользователей» — `can_manage_users`.
- **Архив** (кнопка «В архив» на `/settings.html`): флаг `users.is_archived`, вход закрыт, сессии сбрасываются, привязки (сотрудник у поставщиков и т.п.) **не сбрасываются** — в списках имя помечается «(архивный)». Восстановление — «Из архива». Жёсткое удаление оставляйте на крайний случай.
- После смены критичных параметров сессии имеет смысл **перелогинить** клиентов или дождаться естественного истечения TTL.

## Связь с экранами

- [Очередь](/docs/queue/) и [Результаты](/docs/results/) напрямую зависят от **лимитов парсинга**.
- [Мои сайты](/docs/mysites/) — от **параметров синка**.

## API

`GET` / `POST /api/settings` — см. [Settings](/docs/api/#settings). Тело `POST` — JSON с полями, совпадающими с формой (см. пример в API-справке).
