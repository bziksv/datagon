# Закупки (`/purchase.html`, `routes/purchase.js`) — разбор SQL и нагрузки на БД

Цель: зафиксировать, **какие таблицы** задействованы, **когда растёт стоимость** запроса и **какие индексы** обычно нужны в проде.

## 1. Снимок списка (`purchaseListBuildBaseSnapshot`)

Один запрос к полному набору строк (без `LIMIT` в list SQL) — весь отфильтрованный каталог грузится в память Node для кэша снимка.

### Базовый `FROM`

- **`ms_export mse`** — основная выгрузка МС.
- **`LEFT JOIN dg_purchase_overrides po ON po.code = mse.code`** — ручные поля закупок.

### Условные JOIN

| Условие | JOIN | Зачем |
|--------|------|--------|
| `zero_stock_no_transit=1` | `LEFT JOIN ms_entity_details med ON med.uuid = mse.uuid` | `JSON_EXTRACT(med.payload_json, '$.inTransit')` для «в пути» |
| `incomplete_pack=1` | `LEFT JOIN (подзапрос по суффиксам комплектов) bb ON bb.base_code = mse.code` | исключить «неполную упаковку» для базового кода комплекта `код-N` |

### Параллельно выполняются

1. **`SELECT … listSelectBody ORDER BY mse.id ASC`** — все колонки списка + при `zero_stock_no_transit` поле `payload_json`.
2. **`SELECT COUNT(*) … countSql`** — тот же `WHERE`, но `FROM` для count **упрощается**, если нет `zero_stock_no_transit` и нет `incomplete_pack` (только `mse` + `po`), чтобы не тянуть лишние JOIN в COUNT.

### Фильтры `WHERE` (кратко)

- Архив / складская позиция / «перестали сотрудничать» — по полям `mse`.
- `only_stock` — `COALESCE(mse.stock,0) > 0`.
- `zero_stock` — `stock <= 0` (без `med`).
- `zero_stock_no_transit` — `stock <= 0` + условие по `inTransit` из JSON.
- `no_multiplicity` — выражения по `po.multiplicity`.
- `incomplete_pack` — `sqlIncompletePackPredicate()` (кратность, остаток, подзапрос `bb`).
- Поиск / поставщик — `LIKE` по нескольким полям (не использует полнотекст).

**Риски:** большой `ms_export`, отсутствие индексов по `uuid`, `is_archived`, `stock_position` → полный scan + сортировка по `mse.id`.

## 2. Обогащение после списка (`enrichPurchaseRowsWithFormula`)

Вызывается для **всех** строк снимка, если их число ≤ `PURCHASE_ENRICH_ALL_MAX_ROWS` (см. константу в `routes/purchase.js`); иначе — урезанный режим (`enrichMode: 'page'`) с пересчётом на странице в другом пути.

Типовые запросы (чанки `IN (коды…)` по `PURCHASE_CODES_SQL_CHUNK`, обычно 400 кодов):

| Функция | Таблицы | Назначение |
|---------|---------|------------|
| `loadPurchaseDirectSalesWindowsMap` | `ms_demand_position` + `ms_demand` | окна продаж по дням |
| `loadPurchaseBundleSalesWindowsMap` | те же + `dg_bundle_components` | продажи компонента через комплекты |
| `loadPurchaseAbsenceDistinctDaysAggregateMap` | `dg_product_zero_stock_log` | дни без остатка для `d_*b` |
| `loadPurchaseSumQtyLastDaysMap` | `ms_demand_position` / `ms_demand` / `dg_bundle_components` | суммы за окно |
| `loadLatestZeroStockWindowImportMapBatched` | импорт сводки нулей (см. код) | слияние с логом отсутствий |

Перед этим при небольшом числе кодов — **до 3 параллельных** `ensureBundleComponentsForProduct` (LIKE по `ms_entity_details`) с TTL в памяти и в `dg_bundle_components`.

**Риски:** при десятках тысяч кодов — много чанковых запросов подряд; узкие места — `ms_demand_position.ms_export_code`, связка с `ms_demand.moment`, `dg_bundle_components.bundle_code` / `component_code`.

## 3. Индексы (рекомендации к проверке в проде)

Проверить `EXPLAIN` на боевом объёме для:

- `ms_export`: фильтры по `is_archived`, `stock_position`, иногда `type`; JOIN по `uuid` к `ms_entity_details`.
- `ms_entity_details`: `uuid` (PK/UNIQUE).
- `dg_purchase_overrides`: `code` (PK).
- `ms_demand`: `applicable`, `moment` (диапазон дат).
- `ms_demand_position`: `ms_export_code`, `demand_uuid`.
- `dg_bundle_components`: `bundle_code`, `component_code`.
- `dg_product_zero_stock_log`: `code`, `ts_date` (диапазон за год).

## 4. UI ↔ API (доп. фильтр)

На экране один селект **«Доп. фильтр»** взаимно исключает комбинации: в URL по-прежнему уходят те же query-параметры (`only_stock`, `include_bundles`, `zero_stock`, …). Старые закладки с несколькими `=1` разбираются с **приоритетом**: `zero_stock_no_transit` > `zero_stock` > `incomplete_pack` > `no_multiplicity` > `only_stock` > `include_bundles`.

## 5. Правки по ревизии фронта (зафиксировано в коде)

- **`sort_by` в URL:** для колонки «Поставщик» в адресной строке пишется ключ колонки (`supplier_label`), в API уходит `supplier` — при разборе URL добавлен алиас `supplier_label` → `supplier`.
- **Снимок кэша:** ключ `buildPurchaseListCacheKey` уже включает все шесть флагов; селект не меняет контракт API.
