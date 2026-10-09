---
id: settings
title: Настройки
description: Глобальные параметры парсинга, синхронизации, пользователи, матрица доступа, автосинк
---

**`/settings.html`** — глобальные параметры Datagon. Ключ матрицы: **`settings`**. Карта: [Карта панели](/docs/panel-map/).

<blockquote class="dg-doc-tip">
<strong>Снимок интерфейса.</strong> PNG: <code>npm run docs:capture-screenshots</code> + <code>npm run docs:docusaurus:build</code>. Полная страница. <a href="/docs/capture-screenshots/">Съёмка</a>.
</blockquote>

<figure class="dg-doc-shot">
<img src="/docs/screenshots/settings.png" alt="Настройки" loading="lazy" />
<figcaption>Настройки: формы глобальных параметров.</figcaption>
</figure>

## Доступ

| Кто | Что видит |
|-----|-----------|
| Матрица `settings` = `full` / `view` | HTML и `GET/POST /api/settings` (view — только GET) |
| **`can_manage_users`** | HTML **всегда** открывается, даже если `settings` = `hidden` в матрице (`isHtmlLeafAccessHiddenForActor`); блок пользователей / специальностей |
| API | `/api/settings`, `/api/auth/users`, `/api/specialties`, sync-all/site → ключ **`settings`** |

Не путать с **«График · настройки»** (`/work-schedule-settings.html`, ключ `work-schedule-settings`).

## Структура экрана (сверху вниз)

1. **Пользователи системы** — список, создание, архив, specialty, `can_manage_users`, сессии в таблице.  
2. **Специальности и доступ к разделам** — CRUD специальностей + матрица `hidden` / `view` / `full` по `PAGE_DEFS` (`PUT /api/specialties/:id/access`).  
3. **Сессии и онлайн**, **Общие** (парсинг, discover, прокси), **синк Мои товары**, **МойСклад**, **Заказы в МС**.  
4. **Ключи / паузы маркетплейсов** (Ozon, WB, Я.М., Huckster) — источник [вместо скрытого пункта меню «Настройки МП»](/docs/marketplaces/).  
5. **Автосинхронизация по расписанию** — карточки = `AUTO_SYNC_TASKS` (`lib/datagonAutoSyncRegistry.js`, **21** задача): Сохранить / Запустить сейчас / Лог; категории UI.  
6. Карточки retention / Planfix / формула продаж / журналы (габариты, закупки, auto_sync_runs, снимки остатка).

Каждая кнопка **«Сохранить»** — inline-баннер + повторный `GET` и сверка ключей (`runSaveWithInlineFeedback`). Новое поле формы обязано попасть в whitelist `routes/settings.js`, иначе жёлтый баннер «отправили ≠ БД».

## Группы настроек (логика)

| Группа | Зачем трогать |
|--------|----------------|
| **Парсинг** | 429 / антибот — увеличьте `page_delay_ms`, уменьшите батч. |
| **Прокси** | `fetch_proxy_*`; у проекта — наследовать или напрямую ([Конкуренты](/docs/projects/)). |
| **Синхронизация CMS** | Паузы батчей «Мои товары». |
| **Пользователи / специальности** | Доступ в панель и матрица разделов. |
| **Автосинк** | Расписание МСК; на проде scheduler вкл.; локально — только `dev:local` + «Запустить сейчас». |
| **Маркетплейсы (ключи)** | Client id / токены / delay — здесь, не в скрытом exports-marketplaces.html. |

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
| `auto_sync_myproducts_*` / `auto_sync_marketplaces_ozon_*` / `auto_sync_marketplaces_wb_*` / `auto_sync_marketplaces_ym_*` / `auto_sync_huckster_*` / `auto_sync_db_size_*` / `auto_sync_dimensions_*` | Расписание по МСК. **Маркетплейсы** — три задачи + логи `logs/marketplace-*-sync.log`; legacy `task=marketplaces`. **db_size** — размер БД и диск на дашборде. **dimensions** — выгрузка габаритов в МС. |
| `auto_sync_min_stock_export_*` | **Неснижаемый остаток МС**: `ms_export.min_stock` → `minimumBalance` в МС (`task: 'min_stock_export'`, default **22:00**). Нужен мастер-выключатель экспорта в МС (`auto_sync_export_ms_enabled`), иначе секция на processes считается выкл. Ошибки — `ms_min_stock_export_log` / «Лог» на [processes](/docs/processes/). Не путать с «Пр.→НС» на закупках (только БД). |
| `auto_sync_purchase_formula_cache_*` | **Закупки: кэш формулы** — заполнение `dg_formula_proposed_cache` для дефолтной выборки закупок без RAM-снимка (`task: 'purchase_formula_cache'`, default **08:30**). |
| `auto_sync_np_ms_enrich_enabled` / `auto_sync_np_ms_enrich_interval_min` / `auto_sync_np_ms_enrich_weekdays` | Дозаполнение пустых кода / штрихкода / НДС / РУ в «Новые товары → маркеты» из **кэша** МойСклад (без live API). Интервал **15 / 30 / 60** мин (слоты МСК), дни недели CSV `1=пн…7=вс`. `task: 'np_ms_enrich'`. |
| `auto_sync_np_crm_notify_enabled` / `auto_sync_np_crm_notify_interval_min` / `auto_sync_np_crm_notify_weekdays` | Комментарии в задачи CRM по очереди «Новые товары». Интервал **15 / 30 / 60** мин. Текст и период сводки настраиваются на `/exports-new-products.html#crm-notify`. `task: 'np_crm_notify'`. |
| `auto_sync_medmarket_*` | **Воскресенье (вс):** полная выгрузка атрибута из карточек МС в `ms_export` (`medmarket`). Карточка в блоке **«Экспорт в МС»** (импорт, не запись в МС). |
| `auto_sync_medmarket_fill_*` | **Пн–сб:** запись `код+Тип` в атрибут МС (`medmarket_fill`, блок «Экспорт в МС»). Очередь — исправления формата/регистра, не весь каталог; см. синюю плашку на `/settings.html`. |
| `auto_sync_price_comp_*` | **Цены с конкурента → CMS** (как «Синх. цены по фильтрам» на `/my-products.html`). Фильтры в расписании: `match_audit` (default **confirmed**), `rand_min`/`rand_max` (0.1…0.99 %), `stock_min`/`stock_max` (0…1000), `site_id=all`. Время МСК default **10:00**, дни `1…7`. `task: 'price_comp_sync'`. «Запустить сейчас» и расписание вызывают `triggerPriceCompSyncFromSettings`. Локально scheduler выключен (`dev:local`) — только ручной запуск. |
| `auto_sync_network_prices_*` / `network_prices_source_site_id` | **Цены сети** (`/network-prices.html`): эталон → целевые сайты с `%`. `task: 'network_prices'`. **0 эталона всегда пишется как 0**. При цене на сайте **> 0** — запись только если расхождение с расчётом **> 3%**. |
| `auto_sync_finance_tochka_*` | **Финансы / Точка** (`/finance.html`): счета и выписка в `dg_finance_*`. JWT **не** в этой таблице — только на странице Финансы. Ключи: `enabled` (default **0**), `time` (**07:00**), `days` (**30**), `weekdays`. `task: 'finance_tochka'`. Обслуживает **воркер 2** (`parser-autosync-w2`), не общую очередь воркера 1. |
| `auto_sync_ops_planfix_*` | **Операционный лист / Planfix** (`/ops-sheet.html`): только отчёт 450694 (generate + статусы). Период — как в UI Planfix. Ключи: `enabled` (default **1**), `time` (**20:00**), `weekdays`. `task: 'ops_planfix'`. **Воркер 2**. |
| `auto_sync_moysklad_*` | **Выгрузка МойСклад в `ms_export`** (номенклатура, остатки, неснижаемый из API МС, полные карточки в `ms_entity_details`). После успешной записи `ms_export` — пакетное обновление `dg_product_zero_stock_log` за сегодня (складская позиция «Да», не архив, остаток ≤ 0 **или** для кода без «-» остаток &lt; мин. суффикса в кодах «код-число» в выгрузке). **Не** импорт отгрузок — это `auto_sync_mssales_*` / `mssales_full`. См. [MoySklad в API](/docs/api/#moysklad). |
| `auto_sync_ms_orders_*` | **Заказы в МС** (`/ms-orders.html`): импорт `customerorder` в `ms_customer_order`; период — `ms_orders_sync_days`, исключения — `ms_orders_exclude_owner_names`, дни недели — `auto_sync_ms_orders_weekdays` (пусто = ежедневно). По умолчанию **08:00** МСК. См. [Заказы в МС](/docs/api/#заказы-в-мс). |
| `auth_session_ttl_days` / `auth_session_user_limit` | Длительность сессии и лимит одновременных сессий на пользователя. |
| `auth_online_presence_minutes` | Окно для виджета «онлайн» в шапке (`GET /api/auth/sessions-overview` → `globalDistinctUsersOnline` для **любого** авторизованного; раньше глобальный счётчик был только у admin). |
| `fetch_proxy_enabled` / `fetch_proxy_list` | Глобальный выключатель и список прокси для загрузки HTML конкурентов (worker и точечный парсинг учитывают настройки проекта). |
| `planfix_account` / `planfix_rest_api_key` | REST ПланФикс для операционного листа. Аккаунт (`almamed` → `https://almamed.planfix.ru/rest`), Bearer-токен. Карточка «Planfix» на `/settings.html`; «Проверить подключение» → `POST /api/settings/planfix-test`. Синк заявок и привязка статусов — на `/ops-sheet.html`. |
| `sales_formula_*` | Формула продаж v2 на [карточке товара](/docs/product): W/A; **пополнение в днях** (`sales_formula_replenishment_days`, k=дни÷W); **`sales_formula_sku_replenishment_enabled`** (1/0) — колонка «Рек. пополнение» = факт по эпизодам нуля (без пола на глобаль); в `k` только если рек. **строго выше** базы; **`sales_formula_absence_analysis_days`** — окно для **упущенных шт в спросе**. Два рычага (спрос / горизонт), не дубль одной поправки. «Базовый запас» / «для дорогих» — минимумы после кратности; «для редких» — ранняя ветка. См. `lib/datagonSalesFormula.js`. |

Ручной запуск задач из той же карточки (кнопки «Запустить сейчас» → `POST /api/settings/auto-sync-run`): ответ сервера показывается **цветной плашкой** вверху блока (принято в очередь / уже выполняется или уже в очереди / ошибка), с указанием **занятости воркера** и **текущей очереди**; во время ожидания ответа кнопка блокируется. Кнопка **«Лог»** рядом открывает модалку с выбором **дня (МСК)** и списком записей `auto_sync_runs` этой задачи (`GET /api/settings/auto-sync-runs?task=&date=`). Подробный ход по всем задачам за день — на [Активность / Логи](/docs/processes/). Полный список `task` — `getAutoSyncTaskKeys()` / реестр (**21** ключ).

**Локально с общей БД:** только **`npm run dev:local`** (`DATAGON_AUTO_SYNC_SCHEDULER=off`) — расписание не тикает, «Запустить сейчас» работает. Прод — scheduler вкл. См. [Деплой](/docs/deploy/).

## Пользователи и безопасность

- Пароли / сессии — [Auth в API](/docs/api/#auth).
- **`admin`** нельзя удалить/архивировать; **`can_manage_users`** — CRUD пользователей и доступ к странице при скрытой матрице.
- **Архив**: `users.is_archived`, вход закрыт, сессии сброс; привязки не трогаем; «Из архива» восстанавливает.
- Матрица специальностей: ключи = `PAGE_DEFS` (+ `matrixOnly` вкладки новых товаров). После сохранения пользователь должен обновить профиль / перелогиниться, чтобы меню подтянуло `page_modes`.

## Связь с экранами

- [Очередь](/docs/queue/) / [Результаты](/docs/results/) — лимиты парсинга.  
- [Мои сайты](/docs/mysites/) — sync_*.  
- [Активность / Логи](/docs/processes/) — зеркало автосинка.  
- [Маркетплейсы](/docs/marketplaces/) — ключи здесь; таблицы выгрузок — отдельные HTML.

## API

`GET` / `POST /api/settings`, `POST /api/settings/auto-sync-run`, auto-sync-runs stats/cleanup — [Settings](/docs/api/#settings). Whitelist полей POST — `routes/settings.js`.
