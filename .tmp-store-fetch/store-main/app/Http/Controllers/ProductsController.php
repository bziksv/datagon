<?php

namespace App\Http\Controllers;

use App\Lib\Sale\ProductsTable;
use App\Models\Employee;
use App\Models\Products;
use App\Models\Reserve;
use App\Models\Setting;
use App\Models\Stock;
use App\Models\Store;
use App\Models\Transit;
use App\Services\DataOutputCache;
use App\Services\DataTableViewService;
use Carbon\Carbon;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\Cache;

class ProductsController extends Controller
{
    public function index()
    {
        return view('products.index', [
            'employees' => $this->employeesForProductFilters(),
        ]);
    }

    public function listV2()
    {
        return view('products.index-v2', [
            'employees' => $this->employeesForProductFilters(),
        ]);
    }

    public const EMPLOYEES_FOR_PRODUCT_FILTERS_CACHE_KEY = 'layout.employees_for_product_filters';

    /** Список сотрудников для фильтра колонки «Сотрудник» (кеш, сброс при изменении Employee). */
    private function employeesForProductFilters()
    {
        return Cache::remember(self::EMPLOYEES_FOR_PRODUCT_FILTERS_CACHE_KEY, 600, function () {
            return Employee::query()->orderBy('name')->get(['uuid', 'name']);
        });
    }

    public function show(Products $product)
    {
        $stocks = stockZerosAll($product);

        $stores = $this->stores($product);

        $total = [
            'stocks' => $stores->pluck('stocks')->flatten()->sum('quantity'),
            'reserves' => $stores->pluck('reserves')->flatten()->sum('quantity'),
            'transits' => $stores->pluck('transits')->flatten()->sum('quantity'),
        ];

        $salesFormula = $product->sales_formula;

        return view('products.show', compact('product', 'stores', 'total', 'stocks', 'salesFormula'));
    }

    public function json(Request $request)
    {
        $draw = (int) $request->input('draw', 0);

        try {
            if (! DataOutputCache::enabled()) {
                return response()->json(DataOutputCache::withDraw(
                    $this->buildProductsJsonPayload($request),
                    $draw
                ));
            }

            $identity = DataOutputCache::identityFromDataTablesRequest($request->all());
            $payload = DataOutputCache::remember(
                DataOutputCache::REVISION_INVENTORY,
                DataOutputCache::SEGMENT_PRODUCTS_DATATABLE,
                $identity,
                null,
                fn () => $this->buildProductsJsonPayload($request)
            );
            if (! is_array($payload)) {
                $payload = $this->productsJsonErrorPayload(__('Ошибка загрузки таблицы.'));
            }
        } catch (\Throwable $e) {
            report($e);

            return response()->json(DataOutputCache::withDraw(
                $this->productsJsonErrorPayload(
                    config('app.debug') ? $e->getMessage() : __('Ошибка загрузки таблицы.')
                ),
                $draw
            ));
        }

        return response()->json(DataOutputCache::withDraw($payload, $draw));
    }

    /**
     * @return array{recordsTotal: int, recordsFiltered: int, data: array<int, mixed>, error: string}
     */
    private function buildProductsJsonPayload(Request $request): array
    {
        $products = new ProductsTable($request->all());
        $rows = collect($products->data())->map(function ($row) {
            return $row instanceof \Illuminate\Database\Eloquent\Model
                ? $row->toArray()
                : (array) $row;
        })->values()->all();

        return [
            'recordsTotal' => $products->recordsTotal(),
            'recordsFiltered' => $products->recordsFiltered(),
            'data' => $rows,
            'error' => $products->error(),
        ];
    }

    /**
     * @return array{recordsTotal: int, recordsFiltered: int, data: array<int, mixed>, error: string}
     */
    private function productsJsonErrorPayload(string $message): array
    {
        return [
            'recordsTotal' => 0,
            'recordsFiltered' => 0,
            'data' => [],
            'error' => $message,
        ];
    }

    private function stores(Products $product)
    {
        $assortmentId = $product->uuid;
        $storeIds = collect([
            Stock::query()->where('assortmentId', $assortmentId)->distinct()->pluck('storeId'),
            Reserve::query()->where('assortmentId', $assortmentId)->distinct()->pluck('storeId'),
            Transit::query()->where('assortmentId', $assortmentId)->distinct()->pluck('storeId'),
        ])->flatten()->unique()->filter()->values();

        if ($storeIds->isEmpty()) {
            return collect();
        }

        return Store::query()->whereIn('uuid', $storeIds)->get()->load([
            'stocks' => function ($query) use ($product) {
                return $query->product($product);
            },
            'reserves' => function ($query) use ($product) {
                return $query->product($product);
            },
            'transits' => function ($query) use ($product) {
                return $query->product($product);
            },
        ]);
    }

    public function updateProductField(Request $request)
    {
        $allowedFields = ['minimumBalanceLager', 'multiplicityProduct', 'minBalanceCountedAs'];
        $field = $request->input('field');
        if (! in_array($field, $allowedFields)) {
            return response()->json(['error' => 'Недопустимое поле'], 400);
        }
        $product = Products::find($request->input('id'));
        if (! $product) {
            return response()->json(['error' => 'Товар не найден'], 404);
        }
        $product->$field = $request->input('val');
        $result = $product->save();

        return response()->json(['success' => $result]);
    }

    public function outOfStock(Request $request)
    {
        $memoryLimit = config('lagerplus.out_of_stock_memory_limit');
        if (is_string($memoryLimit) && $memoryLimit !== '') {
            @ini_set('memory_limit', $memoryLimit);
        }

        $timeLimit = (int) config('lagerplus.out_of_stock_max_execution_time', 0);
        if ($timeLimit > 0) {
            @set_time_limit($timeLimit);
        }

        $filter = $request->input('filter');
        $products = Products::getOutOfStock($filter);

        $filterLabels = [
            'zero' => 'Показать нулевые',
            'zero_no_transits' => 'Показать нулевые без ожидания',
            'multiplicity' => 'Без кратности товара',
            'incomplete_pack' => 'Неполная упаковка',
        ];

        $title = '';

        if ($filter && isset($filterLabels[$filter])) {
            $title = ' - '.$filterLabels[$filter];
        }

        $settings = $this->outOfStockSettings();

        return view('products.out-of-stock', compact('products', 'title', 'settings'));
    }

    private function outOfStockSettings(): array
    {
        $settings = [
            ['key' => 'replenishmentCoefficient', 'title' => 'Коэффициент пополнения', 'hint' => ''],
            ['key' => 'baseStock', 'title' => 'Базовый запас для редких товаров', 'hint' => ''],
            ['key' => 'baseStockPrice', 'title' => 'Базовый запас для редких товаров стоимостью выше 50 000 (Цена для маркетов)', 'hint' => ''],
            ['key' => 'baseStockOverprice', 'title' => 'Базовый запас для редких товаров стоимостью выше 50 000 (Значение)', 'hint' => ''],
            ['key' => 'maxMinimumBalance', 'title' => 'Коэффициент максимального изменения предлагаемого остатка', 'hint' => ''],
            ['key' => 'salesFormulaDays', 'title' => 'Анализируем отсутствие товара за дней', 'hint' => ''],
            ['key' => 'salesFormulaDaysSell', 'title' => 'Анализируем продажи за дней (Диапазон продаж 15 дней. 1 = 15, 2 = 30... 3 * 15 дней)', 'hint' => ''],
            ['key' => 'incompletePackPercent', 'title' => 'Процент неполной упаковки', 'hint' => ''],

            // Разделитель — Режим экономии
            ['key' => '_separator_economy', 'title' => 'Режим экономии', 'type' => 'separator'],

            ['key' => 'economyMode', 'title' => 'Режим экономии', 'type' => 'checkbox', 'hint' => 'Позволяет не раздувать неснижаемые остатки и тем самым увеличивать оборачиваемость склада'],
            ['key' => 'economyModeDays', 'title' => 'За какое кол-во дней анализируем отсутствие', 'hint' => 'Рекомендуется менять значение согласно накопленной статистике, брать данные от первых отчётов по продажам и увеличивать в сторону 1 года'],
            ['key' => 'economyModeMaxPercent', 'title' => 'Макс. допустимый % дней отсутствия', 'hint' => 'Рекомендуется не более 5% от параметра «За какое кол-во дней анализируем отсутствие»'],
            ['key' => 'economyModeDaysMultiplier', 'title' => 'На сколько дней рассчитывать неснижаемый остаток в режиме экономии', 'hint' => 'Средний спрос умножается на это значение (по умолчанию 30)'],
        ];

        foreach ($settings as &$setting) {
            if (isset($setting['type']) && in_array($setting['type'], ['separator', 'checkbox'])) {
                continue;
            }
            $setting['hint'] = \App\Models\Description::getByKey($setting['title'], '');
        }

        return $settings;
    }

    public function destroyStockTotals(Request $request)
    {
        $products = Products::whereIn('id', $request->input('ids', []))->get();

        foreach ($products as $product) {
            if ($product->stockTotal->isNotEmpty() && $product->stockTotal->toQuery()->delete()) {
                $product->update([
                    'user_who_deleted_stock_total' => Auth::id(),
                    'deleted_stock_total_at' => Carbon::now(),
                ]);
            }
        }
    }

    public function storeOutOfStockSettings(Request $request)
    {
        $values = [
            'value' => $request->input('value', 0),
        ];

        if (! $values['value']) {
            $values['value'] = 0;
        }

        Setting::query()->updateOrCreate(['key' => $request->input('key')], $values);
    }

    public function getOutOfStockSettings(string $key)
    {
        return Setting::query()->where('key', $key)->value('value');
    }

    public function outOfStockNew(Request $request)
    {
        $memoryLimit = config('lagerplus.out_of_stock_memory_limit');
        if (is_string($memoryLimit) && $memoryLimit !== '') {
            @ini_set('memory_limit', $memoryLimit);
        }

        $timeLimit = (int) config('lagerplus.out_of_stock_max_execution_time', 0);
        if ($timeLimit > 0) {
            @set_time_limit($timeLimit);
        }

        $filter = $this->normalizeOutOfStockFilter($request->input('filter'));
        $filterLabels = [
            'zero' => 'Показать нулевые',
            'zero_no_transits' => 'Показать нулевые без ожидания',
            'multiplicity' => 'Без кратности товара',
            'incomplete_pack' => 'Неполная упаковка',
        ];
        $title = ($filter && isset($filterLabels[$filter])) ? ' - '.$filterLabels[$filter] : '';
        $settings = $this->outOfStockSettings();

        return view('products.out-of-stock-new', compact('title', 'settings', 'filter'));
    }

    public function outOfStockNewJson(Request $request)
    {
        $draw = (int) $request->input('draw', 0);

        try {
            if (! DataOutputCache::enabled()) {
                return response()->json(DataOutputCache::withDraw(
                    $this->buildOutOfStockNewJsonPayload($request),
                    $draw
                ));
            }

            $identity = DataOutputCache::identityFromOutOfStockNewDataTablesRequest($request);
            $payload = DataOutputCache::remember(
                DataOutputCache::REVISION_INVENTORY,
                DataOutputCache::SEGMENT_OUT_OF_STOCK_NEW_DATATABLE,
                $identity,
                DataOutputCache::ttlSecondsForSegment(DataOutputCache::SEGMENT_OUT_OF_STOCK_NEW_DATATABLE),
                fn () => $this->buildOutOfStockNewJsonPayload($request)
            );
            if (! is_array($payload)) {
                $payload = $this->productsJsonErrorPayload(__('Ошибка загрузки таблицы.'));
            }
        } catch (\Throwable $e) {
            report($e);

            return response()->json(DataOutputCache::withDraw(
                $this->productsJsonErrorPayload(
                    config('app.debug') ? $e->getMessage() : __('Ошибка загрузки таблицы.')
                ),
                $draw
            ));
        }

        return response()->json(DataOutputCache::withDraw($payload, $draw));
    }

    /**
     * Прогрев {@see DataOutputCache} для типового запроса DataTables (cron / artisan).
     */
    public function warmOutOfStockNewDatatableCacheEntry(Request $request): void
    {
        if (! DataOutputCache::enabled()) {
            return;
        }

        $identity = DataOutputCache::identityFromOutOfStockNewDataTablesRequest($request);
        DataOutputCache::remember(
            DataOutputCache::REVISION_INVENTORY,
            DataOutputCache::SEGMENT_OUT_OF_STOCK_NEW_DATATABLE,
            $identity,
            DataOutputCache::ttlSecondsForSegment(DataOutputCache::SEGMENT_OUT_OF_STOCK_NEW_DATATABLE),
            fn () => $this->buildOutOfStockNewJsonPayload($request)
        );
    }

    /**
     * @return array{recordsTotal: int, recordsFiltered: int, data: array<int, array<string, mixed>>, error: string}
     */
    private function buildOutOfStockNewJsonPayload(Request $request): array
    {
        return Products::withOutOfStockSettingsBag(function () use ($request) {
            $filter = $this->normalizeOutOfStockFilter($request->input('filter'));
            $countBase = Products::outOfStockListCountQuery($filter);
            $recordsTotal = (clone $countBase)->toBase()->count();

            $base = Products::outOfStockListBaseQuery($filter);
            $filtered = clone $base;
            $search = trim((string) data_get($request->all(), 'search.value', ''));
            if ($search !== '') {
                $needle = '%'.$search.'%';
                $filtered->where(function ($q) use ($needle) {
                    $q->where('products.name', 'like', $needle)
                        ->orWhere('products.code', 'like', $needle)
                        ->orWhere('products.article', 'like', $needle)
                        ->orWhere('suppliers.name', 'like', $needle);
                });
            }

            $countFiltered = clone $countBase;
            if ($search !== '') {
                $needle = '%'.$search.'%';
                $countFiltered->where(function ($q) use ($needle) {
                    $q->where('products.name', 'like', $needle)
                        ->orWhere('products.code', 'like', $needle)
                        ->orWhere('products.article', 'like', $needle)
                        ->orWhere('suppliers.name', 'like', $needle);
                });
            }
            $recordsFiltered = (clone $countFiltered)->toBase()->count();

            $orderColIdx = (int) data_get($request->all(), 'order.0.column', 1);
            $orderDir = strtolower((string) data_get($request->all(), 'order.0.dir', 'asc')) === 'desc' ? 'desc' : 'asc';
            $orderColumn = $this->outOfStockNewOrderColumn($orderColIdx);
            if ($orderColumn !== null) {
                $filtered->orderBy($orderColumn, $orderDir);
            } else {
                $filtered->orderBy('products.name', 'asc');
            }

            $start = max(0, (int) $request->input('start', 0));
            $length = (int) $request->input('length', 50);
            if ($length <= 0 || $length > 500) {
                $length = 50;
            }

            $orderByForIds = $orderColumn ?? 'products.name';
            // Колонки 17–31: сортировка одним лёгким агрегатом (см. Products::tryOutOfStockListPageProductIds).
            $orderUsesPeriodAggregates = $orderColIdx >= 17 && $orderColIdx <= 31;
            $pageIds = Products::tryOutOfStockListPageProductIds(
                $filter,
                $orderByForIds,
                $orderDir,
                $search,
                $start,
                $length,
                $orderUsesPeriodAggregates,
            );

            if ($pageIds !== null) {
                if ($pageIds === []) {
                    $page = new \Illuminate\Database\Eloquent\Collection;
                } else {
                    $raw = Products::outOfStockListBaseQuery($filter, $pageIds)->get();
                    $byId = $raw->keyBy('id');
                    $ordered = [];
                    foreach ($pageIds as $pid) {
                        $row = $byId->get($pid);
                        if ($row !== null) {
                            $ordered[] = $row;
                        }
                    }
                    $page = new \Illuminate\Database\Eloquent\Collection($ordered);
                }
            } else {
                $page = $filtered->skip($start)->take($length)->get();
            }

            Products::hydrateOutOfStockSalesFormulas($page);

            $data = [];
            foreach ($page as $product) {
                $data[] = $this->mapProductToOutOfStockNewRow($product);
            }

            return [
                'recordsTotal' => $recordsTotal,
                'recordsFiltered' => $recordsFiltered,
                'data' => $data,
                'error' => '',
            ];
        });
    }

    private function normalizeOutOfStockFilter(mixed $filter): ?string
    {
        $allowed = ['zero', 'zero_no_transits', 'multiplicity', 'incomplete_pack'];
        if (! is_string($filter) || ! in_array($filter, $allowed, true)) {
            return null;
        }

        return $filter;
    }

    private function outOfStockNewOrderColumn(int $idx): ?string
    {
        $map = [
            1 => 'products.name',
            2 => 'suppliers.name',
            3 => 'products.article',
            4 => 'products.code',
            5 => 'products.buyPrice',
            6 => 'products.minimumBalance',
            12 => 'products.pack_quantity',
            14 => 'stocks_sum_quantity',
            15 => 'transits_sum_quantity',
            16 => 'products.deleted_stock_total_at',
            17 => 'stock_zero_3',
            18 => 'stock_zero_5',
            19 => 'stock_zero_7',
            20 => 'sell_15',
            21 => 'stock_zero_15',
            22 => 'sell_30',
            23 => 'stock_zero_30',
            24 => 'sell_60',
            25 => 'stock_zero_60',
            26 => 'sell_90',
            27 => 'stock_zero_90',
            28 => 'sell_180',
            29 => 'stock_zero_180',
            30 => 'sell_365',
            31 => 'stock_zero_365',
        ];

        return $map[$idx] ?? null;
    }

    /**
     * @return array<string, mixed>
     */
    private function mapProductToOutOfStockNewRow(Products $product): array
    {
        $sf = $product->sales_formula;
        $href = route('products.show', $product->id);

        $deletedAt = $product->deleted_stock_total_at;

        return [
            'DT_RowId' => (string) $product->id,
            'name_html' => '<a href="'.e($href).'" class="text-dark" target="_blank">'.e($product->name).'</a>',
            'supplier' => (string) (optional($product->suppliers)->name ?? ''),
            'article' => (string) ($product->article ?? ''),
            'code' => (string) ($product->code ?? ''),
            'buy_price' => $product->buyPrice,
            'minimum_balance' => $product->minimumBalance,
            'price_auto' => (string) $product->priceAuto,
            'suggested_minimum' => $sf['minimumBalance'] ?? '',
            'minimum_balance_lager' => DataTableViewService::columnInputView([
                'id' => $product->id,
                'value' => $product->minimumBalanceLager,
                'action' => 'minimumBalanceLager',
            ], true),
            'multiplicity_product' => DataTableViewService::columnInputView([
                'id' => $product->id,
                'value' => $product->multiplicityProduct,
                'action' => 'multiplicityProduct',
            ], true),
            'min_balance_counted' => DataTableViewService::columnInputView([
                'id' => $product->id,
                'value' => $product->minBalanceCountedAs,
                'action' => 'minBalanceCountedAs',
            ], true),
            'pack_quantity' => $product->pack_quantity,
            'pack_pct' => $product->pack_percentage !== null && $product->pack_percentage !== '' ? $product->pack_percentage.'%' : '',
            'stocks_sum' => $product->stocks_sum_quantity,
            'transits_sum' => $product->transits_sum_quantity,
            'deleted_stock_total_at' => $deletedAt
                ? Carbon::parse($deletedAt)->format('d.m.Y H:i')
                : '',
            'stock_zero_3' => $product->stock_zero_3,
            'stock_zero_5' => $product->stock_zero_5,
            'stock_zero_7' => $product->stock_zero_7,
            'sell_15' => $product->sell_15,
            'stock_zero_15' => $product->stock_zero_15,
            'sell_30' => $product->sell_30,
            'stock_zero_30' => $product->stock_zero_30,
            'sell_60' => $product->sell_60,
            'stock_zero_60' => $product->stock_zero_60,
            'sell_90' => $product->sell_90,
            'stock_zero_90' => $product->stock_zero_90,
            'sell_180' => $product->sell_180,
            'stock_zero_180' => $product->stock_zero_180,
            'sell_365' => $product->sell_365,
            'stock_zero_365' => $product->stock_zero_365,
        ];
    }
}
