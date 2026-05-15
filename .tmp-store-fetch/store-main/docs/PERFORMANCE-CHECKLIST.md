# Чеклист: производительность, загрузка и кеш

Легенда: `[x]` сделано · `[~]` частично / приемлемо · `[ ]` в очереди · `[-]` не планируется / низкий приоритет

Общие механизмы: **`DataOutputCache`** (`config/lagerplus.php` → `data_output_cache`) — JSON DataTables и часть сводок; **`Cache::remember`** — справочники для UI; сброс через **`bumpRevision`** / **`Cache::forget`**.

---

## Маршруты и экраны

| Маршрут / экран | Метод / источник | Загрузка / кеш | Статус |
|-----------------|------------------|----------------|--------|
| `GET /` | `welcome` | Статика | `[~]` |
| `GET /dashboard` | `DashboardController@index` | `DataOutputCache`; счётчики + `SUM(shippers)` — один `selectOne` (`dashboardSummaryCounts`) | `[x]` |
| `GET /dashboard/price-sum` | `DashboardController@getPriceSumByName` | `DataOutputCache` | `[x]` |
| `GET /products`, `GET /products/list-v2` | `ProductsController` | Таблица через `products.json` + кеш | `[x]` |
| `GET /products/json` | `ProductsController@json` | `DataOutputCache` (ревизия `inventory`) | `[x]` |
| `GET /products/{id}` | `ProductsController@show` | `stockZerosAll`, склады по товару, не все `Store` | `[x]` |
| `GET /products/out-of-stock` | `ProductsController@outOfStock` | Агрегаты `stock_totals` / `sells` — два `JOIN` вместо 15 коррелированных подзапросов; `OUT_OF_STOCK_MAX_EXECUTION_TIME` (по умолчанию 120); память `OUT_OF_STOCK_MEMORY_LIMIT` | `[x]` |
| `GET /suppliers` | `SupplierController@index` | Склады — кеш; фильтры — только `id`,`name`,`active` + сортировка | `[x]` |
| `GET /suppliers/json` | `SupplierController@json` | `DataOutputCache` | `[x]` |
| `GET /shipper` | `ShipperController@index` | Лёгкая оболочка + DataTables | `[x]` |
| `GET /shipper/json` | `ShipperController@json` | `DataOutputCache` | `[x]` |
| `GET /shipper/{id}/edit` | `ShipperController@edit` | Сужены `User` / `Store` / `Filter` (колонки + eager) | `[x]` |
| `PATCH ... shipper/warehouses` | `ShipperController@bulkUpdateWarehouse` | N×`sync`; `chunkById(100)` + `DB::transaction` (память и целостность при сбое) | `[~]` |
| `GET /employee` | `EmployeeController@index` | Пагинация 50 | `[x]` |
| `GET /employee/json` | `EmployeeController@json` | Кеш DOCACHE; выборка только нужных колонок + стабильный JSON (без лишних полей `toArray`) | `[x]` |
| `GET /users` | `UsersController@index` | Пагинация | `[x]` |
| `GET /settings` | `SettingController@index` | `Setting::valuesByKeys` — один SELECT по списку ключей | `[x]` |
| `GET /descriptions` | `DescriptionController@index` | Пагинация | `[x]` |
| `GET /descriptions/json/...` | `DescriptionController` | `DataOutputCache` | `[x]` |
| `GET /filters` | `FiltersController@index` | `DataOutputCache` по пользователю | `[x]` |
| Auth / profile / token | разные | Обычно лёгкие | `[~]` |

---

## Сервисы и фоновая логика

| Компонент | Заметка | Статус |
|-----------|---------|--------|
| `ProductProfitService::bundleSellQuantity` | Один запрос `measure_item_param` на вызов | `[x]` |
| `ShipperService` / построение DataTables | `getAvailableWithProducts`: пакетно `shipper_user` + `users`, фильтры `whereIn` + `with(user)` | `[x]` |
| `WarehouseProductsService` (дашборд) | Суммы buy/sale/min — один `SUM` на запрос, кеш на экземпляр сервиса | `[x]` |
| Синхронизации МойСклад (импорт складов и т.д.) | После массового обновления складов — сброс кеша списка складов (см. `AppServiceProvider`) | `[x]` |

---

## База и индексы

| Объект | Действие | Статус |
|--------|----------|--------|
| `stock_totals` | Индекс `(assortmentId, created_at)` — миграция `2025_07_25_114159` | `[x]` |
| `shipper_user` | Индекс `shipper_id` — миграция `2026_05_03_120000` (пакетные запросы по поставщику) | `[x]` |
| `products` | Составной `(is_warehouse_item, supplier)` — та же миграция (подзапросы дашборда / поставщиков) | `[x]` |
| `filters` | Составной `(user_id, active)` — миграция `2026_05_03_130000` (`/filters`, `/suppliers`) | `[x]` |
| `settings` | Уникальный индекс по `key` уже в `2024_04_09_123332` — отдельная миграция не нужна | `[x]` |
| `prices` | Составной `(product_id, name)` — миграция `2026_05_03_140000` (суммы по прайсу на дашборде) | `[x]` |
| Прочие большие таблицы | Профилировать медленные запросы из лога / Telescope | `[ ]` |

---

## Следующие кандидаты (по убыванию смысла)

1. `[x]` **`products.outOfStock`** — см. `Products::getOutOfStock` / `queryOutOfStockProducts`; дальше — только профилирование и индексы под конкретные фильтры при необходимости.
2. `[x]` **`Employee::json`** — сжатый payload (`employeesJsonRows`); при тысячах записей — пагинация на клиенте при смене контракта API.
3. `[~]` **`ShipperController@bulkUpdateWarehouse`** — чанки + транзакция; при очень большом числе поставщиков — очередь вместо синхронного N×`sync`.
4. `[ ]` **Профилирование** suppliers DataTable при реальных объёмах.

Обновляйте статусы в этом файле по мере работ.
