---
id: product-analysis
title: Анализ товаров
description: Продажи по SKU — топы, мёртвые позиции, решения и неснижаемый остаток
---

Страница **`/product-analysis.html`** — анализ складских SKU: продажи, остатки, пресеты (мёртвые / зависшие / топы), lifecycle-решения и запись неснижаемого в Datagon. Карта: [Карта панели](/docs/panel-map/). API: `/api/product-analysis` → `routes/productAnalysis.js` — [REST API → Анализ товаров](/docs/api/#анализ-товаров).

## Доступ

Ключ матрицы — **`product-analysis`**.

| Режим | Что доступно |
|-------|----------------|
| **`hidden`** | HTML и API недоступны |
| **`view`** | overview / ranking / export / log / comments GET; `POST/PATCH/DELETE` решений и комментариев — нет |
| **`full`** | Решения (строка/bulk), комментарии, обнуление НС в Datagon, фиксация предлагаемого |

Не путать с [Анализом поставщиков](/docs/supplier-analysis/) (агрегат по поставщику) и с [Закупками](/docs/purchase/) (формула / Пр.→НС).

## Источники и таблицы

- **Каталог** — складские SKU (`sqlProductAnalysisCatalogWhere`): не архив, складская «Да», не комплект; **включая** «перестали сотрудничать» (остаток ещё может лежать).
- **Продажи** — те же join'ы, что у анализа поставщиков (`ms_demand`), агрегат **по `code`**.
- **Решения** — `dg_product_analysis_decisions` (не `dg_purchase_overrides`): `lifecycle`, `do_not_order`, `min_stock_target`, `lock_proposed_min_stock`, поля буста, `decision_note`.
- **Комментарии** — `dg_product_analysis_comments` (несколько на код; правка/удаление только своих).
- **Журнал полей** — `dg_product_analysis_decisions_log` (`source`: `row`|`bulk`|`min_stock`|…).

## Как пользоваться

1. **Фильтры** (черновик → **Применить** / Enter; dirty → «Применить •»). После apply / пресета / сортировки / страницы адрес обновляется (`history.replaceState`) — ссылку можно шарить.
   Параметры URL: `days`, `new_stock_days`, `exclude_new_on_stock`, `search`, `supplier`, `manager`, `preset`, `project_mode`, `project_uuids`, `limit`, `page`, `sort_by`, `sort_dir`.
2. Пресеты (чипы): `all`, `top_revenue`, `top_qty`, `dead`, `stuck`, `new_on_stock`, `dead_min_stock`, `min_vs_proposed`, `lifecycle_*`, `do_not_order`.
   - **Мёртвые** (`dead`) — 0 продаж и `stock > 0`.
   - **Зависшие** (`stuck`) — шире: остаток и (0 продаж **или** ≥30 дн. без продаж).
   - **Новые на складе** — первый положительный снимок в пределах `new_stock_days`.
   - По умолчанию `exclude_new_on_stock=1` — новинки исключаются из мёртвых/зависших/`dead_min_stock`.
3. Проекты отгрузок и менеджер (`ms_export.manager`) — как у supplier-analysis / закупок.
4. Карточка таблицы: зеркало поиска, **🧩 Столбцы** / **📏 Ширины** / **Свернуть**, пагинация (default **100**), раскрытие строки (`/sku-detail`).
5. **Массовые действия** (отмеченные строки **или** вся выборка по фильтру, лимит ~500): lifecycle (буст / распродажа / выход / топ / hold…), «не заказывать», фиксация предлагаемого = 0, **обнулить неснижаемый**.
   - Preflight `dry_run=1` → цифры в `#dg-pa-action-log`.
   - Confirm — **`#dg-pa-bulk-confirm-overlay`** (не `window.confirm`); без галочек — обязательный чекбокс «понимаю».
   - Итог в action-log: updated / errors / duration; история — кнопка «лог» у решения.
6. **Обнулить неснижаемый** пишет `ms_export.min_stock` **только в Datagon**; в МС — автосинк `min_stock_export` (Настройки).
7. Комментарии — модалки `#dg-pa-cmt-overlay` / `#dg-pa-cmt-del-overlay`.

## Автосинк

Отдельной задачи `product-analysis` **нет**. Нужны `moysklad`, `mssales`/`mssales_full`; выгрузка НС — `min_stock_export`. Журнал — на [Активность / Логи](/docs/processes/).

## Связь с другими разделами

- [Закупки](/docs/purchase/) — формула, предлагаемый НС, Пр.→НС; замок предлагаемого виден и там.
- [Анализ поставщиков](/docs/supplier-analysis/) — тот же контур продаж на уровне поставщика.
- [Поставщики](/docs/suppliers/) — настройки / заказ в МС.
- [Продажи МС](/docs/ms-sales/) — источник отгрузок.
