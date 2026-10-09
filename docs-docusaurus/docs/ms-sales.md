---
id: ms-sales
title: Продажи МС
description: Отгрузки МойСклад (entity/demand) и позиции с привязкой к ms_export; синк и аналитика
---

Страница **`/ms-sales.html`** — отгрузки (`entity/demand`) и позиции с резолвом в **`ms_export`**. Карта: [Карта панели](/docs/panel-map/). API: `/api/ms-sales` → `routes/msSales.js` — [REST API → Продажи МС](/docs/api/#продажи-мс).

## Доступ

Ключ матрицы — **`ms-sales`**.

| Режим | Что доступно |
|-------|----------------|
| **`hidden`** | HTML и `/api/ms-sales` недоступны |
| **`view`** | list / filters / positions / by-product / aggregates / sync-status — GET |
| **`full`** | sync / sync-cancel / reresolve |

В меню — блок МойСклад, после [Заказов в МС](/docs/ms-orders/) (не подменю «Маркетплейсы»).

## Синхронизация

| Режим | Как | Окно / задача |
|-------|-----|----------------|
| Инкремент | `POST /sync` с `incremental` / авто `mssales` | default **90** дн.; с `MAX(moment)−1 сутки` |
| Полный с нуля | кнопка на экране / авто `mssales_full` | default **730** дн., часто только вс |
| Остановка | `POST /sync-cancel` | один активный job в памяти |

Удалённые в МС документы → soft-delete `deleted_at` (строки и позиции **не** стираются). В UI бейдж «Удалена из МС»; фильтр по умолчанию — только активные. Вернувшийся в МС документ «воскресает» при UPSERT.

**Перерезолв** (`POST /reresolve`) — обновить привязку позиций к `ms_export` без полного синка.

Карточки автосинка — на [Настройках](/docs/settings/); журнал — [Активность / Логи](/docs/processes/). Не ставьте `mssales` и `mssales_full` на одно и то же `HH:MM`.

## UI

Эталон [moysklad baseline](/docs/moysklad/#эталон-списочной-страницы): фильтры + таблица отгрузок.

- Умный поиск (номер / контрагент / товар в позициях), период, склад, контрагент, проект, проведённые, удалённые, «все позиции привязаны» / есть непривязанные, складская позиция → только **«Применить»** / Enter.
- Строка раскрывается → позиции (`resolved` / имя на момент / qty / сумма).
- Поиск-зеркало в шапке таблицы; пагинация по 100.

## Резолв позиций

1. По `assortment_uuid` (product / bundle / variant / …).
2. Для variant — ещё по родительскому `product_uuid`.

Не найдено в `ms_export` → `ms_export_resolved=0`, сохраняются `name_at_moment` / `code_at_moment`.

## Кто потребляет данные

[Закупки](/docs/purchase/), [Анализ поставщиков](/docs/supplier-analysis/), [Анализ товаров](/docs/product-analysis/), [Операционный лист](/docs/ops-sheet/), [Карточка товара](/docs/product/). Не путать с [Заказами](/docs/ms-orders/) (`customerorder`).
