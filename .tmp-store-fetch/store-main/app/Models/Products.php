<?php

namespace App\Models;

use App\Models\LocalScopes\ProductsScopes;
use Carbon\Carbon;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Casts\Attribute;
use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Support\Facades\DB;

class Products extends ProductsScopes
{
    protected $guarded = [
        'id',
        'meta',
        'files',
    ];

    protected $casts = [
        'barcodes' => 'array',
        'attributes' => 'array',
        'total_sell' => 'array',
        'images' => 'array',
        'deleted_stock_total_at' => 'datetime',
    ];

    use HasFactory;

    /** Окна в днях для агрегата «нулевые» stock_totals на карточке товара (см. stockZerosAll). */
    public const STOCK_ZERO_WINDOW_DAYS = [3, 5, 7, 15, 30, 60, 90];

    /** Во время {@see getOutOfStock()} — один запрос настроек вместо десятков на строку в {@see getSalesFormula()}. */
    protected static ?array $salesFormulaSettingsBag = null;

    /** Заполняется в {@see getOutOfStock()}: готовый массив для аксессора `sales_formula` после сброса {@see $salesFormulaSettingsBag}. */
    public ?array $outOfStockSalesFormulaCache = null;

    protected static function salesFormulaSetting(string $key, mixed $default = null): mixed
    {
        if (static::$salesFormulaSettingsBag !== null && array_key_exists($key, static::$salesFormulaSettingsBag)) {
            $v = static::$salesFormulaSettingsBag[$key];
            if ($v === null || $v === '') {
                return $default;
            }

            return $v;
        }

        return Setting::query()->where('key', $key)->value('value') ?? $default;
    }

    protected function serializeDate(\DateTimeInterface $date): string
    {
        return $date->format('d.m.Y H:i');
    }

    protected function paymentItemType(): Attribute
    {
        return Attribute::make(function ($value) {
            switch ($value) {
                case 'GOOD':
                    return __('Товар');
                    break;
                case 'EXCISABLE_GOOD':
                    return __('Подакцизный товар');
                    break;
                case 'COMPOUND_PAYMENT_ITEM':
                    return __('Составной предмет расчета');
                    break;
                case 'ANOTHER_PAYMENT_ITEM':
                    return __('Иной предмет расчета');
                    break;
                default:
                    return '';
            }
        });
    }

    protected function trackingType(): Attribute
    {
        return Attribute::make(function ($value) {
            $types = [
                'BEER_ALCOHOL' => 'Пиво и слабоалкогольная продукция',
                'ELECTRONICS' => 'Фотокамеры и лампы-вспышки',
                'FOOD_SUPPLEMENT' => 'Биологически активные добавки к пище',
                'LP_CLOTHES' => 'Тип маркировки Одежда',
                'LP_LINENS' => 'Тип маркировки Постельное белье',
                'MILK' => 'Молочная продукция',
                'NCP' => 'Никотиносодержащая продукция',
                'NOT_TRACKED' => 'Без маркировки',
                'OTP' => 'Альтернативная табачная продукция',
                'PERFUMERY' => 'Духи и туалетная вода',
                'SANITIZER' => 'Антисептики',
                'SHOES' => 'Тип маркировки Обувь',
                'TIRES' => 'Шины и покрышки',
                'TOBACCO' => 'Тип маркировки Табак',
                'WATER' => 'Упакованная вода',
            ];

            if (array_key_exists($value, $types)) {
                return $types[$value];
            } else {
                return '';
            }
        });
    }

    public function employee(): BelongsTo
    {
        return $this->belongsTo(Employee::class, 'owner', 'uuid')->withDefault(['name' => 'Не выбран']);
    }

    public function folder(): BelongsTo
    {
        return $this->belongsTo(ProductFolder::class, 'productFolder', 'uuid')->withDefault(['name' => 'Не выбран']);
    }

    public function suppliers(): BelongsTo
    {
        return $this->belongsTo(Supplier::class, 'supplier', 'uuid')->withDefault(['name' => 'Не выбран']);
    }

    public function countries(): BelongsTo
    {
        return $this->belongsTo(Country::class, 'country', 'uuid')->withDefault(['name' => 'Не выбран']);
    }

    public function uoms(): BelongsTo
    {
        return $this->belongsTo(Uom::class, 'uom', 'uuid')->withDefault(['name' => 'Не выбран']);
    }

    public function groups(): BelongsTo
    {
        return $this->belongsTo(Group::class, 'group', 'uuid')->withDefault(['name' => 'Не выбран']);
    }

    public function prices()
    {
        return $this->hasMany(Price::class, 'product_id');
    }

    public function stocks()
    {
        return $this->hasMany(Stock::class, 'assortmentId', 'uuid');
    }

    public function reserves()
    {
        return $this->hasMany(Reserve::class, 'assortmentId', 'uuid');
    }

    public function transits()
    {
        return $this->hasMany(Transit::class, 'assortmentId', 'uuid');
    }

    public function stockTotal()
    {
        return $this->hasMany(StockTotal::class, 'assortmentId', 'uuid');
    }

    public function sell()
    {
        return $this->hasMany(Sell::class, 'product_id');
    }

    public function lastSell()
    {
        return $this->hasOne(Sell::class, 'product_id')->latestOfMany();
    }

    protected function userWhoDeletedStockTotal(): Attribute
    {
        return Attribute::make(
            get: function ($value) {
                $user = User::find($value);

                if ($user) {
                    return $user->name;
                }

                return null;
            },
        );
    }

    /** @var list<string> */
    public const OUT_OF_STOCK_SETTINGS_KEYS = [
        'replenishmentCoefficient',
        'salesFormulaDays',
        'salesFormulaDaysSell',
        'baseStock',
        'baseStockPrice',
        'baseStockOverprice',
        'economyMode',
        'economyModeDays',
        'economyModeMaxPercent',
        'economyModeDaysMultiplier',
        'maxMinimumBalance',
        'incompletePackPercent',
    ];

    /**
     * Загрузить пакет настроек формулы и выполнить callback (для getOutOfStock / JSON DataTables).
     *
     * @template T
     *
     * @param  callable(): T  $callback
     * @return T
     */
    public static function withOutOfStockSettingsBag(callable $callback)
    {
        $previousBag = static::$salesFormulaSettingsBag;
        static::$salesFormulaSettingsBag = Setting::query()
            ->whereIn('key', static::OUT_OF_STOCK_SETTINGS_KEYS)
            ->pluck('value', 'key')
            ->all();

        try {
            return $callback();
        } finally {
            static::$salesFormulaSettingsBag = $previousBag;
        }
    }

    public static function getOutOfStock($filter = null)
    {
        return static::withOutOfStockSettingsBag(function () use ($filter) {
            $products = static::outOfStockListBaseQuery($filter)->get();
            foreach ($products as $product) {
                $product->outOfStockSalesFormulaCache = $product->getSalesFormula();
                $product->unsetRelation('stockTotal');
                $product->unsetRelation('sell');
                $product->unsetRelation('prices');
            }

            return $products;
        });
    }

    /**
     * Базовый запрос списка «упущ. выгода» (без get): JOIN агрегатов, eager, фильтры.
     *
     * @param  list<int>|null  $limitToProductIds  если задан, агрегаты stock_totals / sells / stocks / transits считаются только по этим товарам (быстрая подгрузка страницы).
     */
    public static function outOfStockListBaseQuery(?string $filter = null, ?array $limitToProductIds = null): Builder
    {
        $now = Carbon::now();

        $salesFormulaDays = (int) (static::salesFormulaSetting('salesFormulaDays', 30) ?? 30);
        $economyMode = filter_var(static::salesFormulaSetting('economyMode', '0'), FILTER_VALIDATE_BOOLEAN);
        $economyModeDays = (int) (static::salesFormulaSetting('economyModeDays', 90) ?? 90);
        $stockTotalWindowDays = max($salesFormulaDays, $economyMode ? $economyModeDays : 0, 1);
        $stockTotalSince = $now->copy()->subDays($stockTotalWindowDays);
        $sellLimit = max(1, (int) (static::salesFormulaSetting('salesFormulaDaysSell', 2) ?? 2));

        $stockZeroPeriods = [3, 5, 7, 15, 30, 60, 90, 180, 365];
        $sellPeriods = [15, 30, 60, 90, 180, 365];

        if ($limitToProductIds !== null && $limitToProductIds === []) {
            return Products::query()->whereRaw('0 = 1');
        }

        $assortmentIds = null;
        if ($limitToProductIds !== null) {
            $assortmentIds = static::query()
                ->whereIn('id', $limitToProductIds)
                ->pluck('uuid')
                ->all();
        }

        $stockZeroSub = static::subqueryStockZeroCountsByPeriod($now);
        if ($assortmentIds !== null) {
            $stockZeroSub->whereIn('stock_totals.assortmentId', $assortmentIds);
        }

        $sellSumsSub = static::subquerySellSumsByPeriod($now);
        if ($limitToProductIds !== null) {
            $sellSumsSub->whereIn('sells.product_id', $limitToProductIds);
        }

        $stockZeroSelects = [];
        foreach ($stockZeroPeriods as $days) {
            $alias = "stock_zero_{$days}";
            $stockZeroSelects[] = DB::raw("IFNULL(`stock_zero_agg`.`{$alias}`, 0) as `{$alias}`");
        }

        $sellSumSelects = [];
        foreach ($sellPeriods as $days) {
            $alias = "sell_{$days}";
            $sellSumSelects[] = DB::raw("IFNULL(`sell_period_agg`.`{$alias}`, 0) as `{$alias}`");
        }

        $stocksAgg = Stock::query()
            ->selectRaw('assortmentId, SUM(quantity) as stocks_sum_quantity')
            ->groupBy('assortmentId');
        if ($assortmentIds !== null) {
            $stocksAgg->whereIn('assortmentId', $assortmentIds);
        }

        $transitsAgg = Transit::query()
            ->selectRaw('assortmentId, SUM(quantity) as transits_sum_quantity')
            ->groupBy('assortmentId');
        if ($assortmentIds !== null) {
            $transitsAgg->whereIn('assortmentId', $assortmentIds);
        }

        return Products::query()
            ->select('products.*')
            ->leftJoin('suppliers', 'products.supplier', '=', 'suppliers.uuid')
            ->leftJoinSub($stocksAgg, 'stocks_agg', function ($join) {
                $join->on('products.uuid', '=', 'stocks_agg.assortmentId');
            })
            ->leftJoinSub($transitsAgg, 'transits_agg', function ($join) {
                $join->on('products.uuid', '=', 'transits_agg.assortmentId');
            })
            ->leftJoinSub($stockZeroSub, 'stock_zero_agg', function ($join) {
                $join->on('products.uuid', '=', 'stock_zero_agg.assortmentId');
            })
            ->leftJoinSub($sellSumsSub, 'sell_period_agg', function ($join) {
                $join->on('products.id', '=', 'sell_period_agg.product_id');
            })
            ->addSelect(array_merge([
                DB::raw('IFNULL(stocks_agg.stocks_sum_quantity, 0) as stocks_sum_quantity'),
                DB::raw('IFNULL(transits_agg.transits_sum_quantity, 0) as transits_sum_quantity'),
                DB::raw('LEAST(100, ROUND(IFNULL(stocks_agg.stocks_sum_quantity, 0) / NULLIF(products.multiplicityProduct, 0) * 100)) as pack_percentage'),
            ], $stockZeroSelects, $sellSumSelects))
            ->with([
                'suppliers',
                'prices' => fn ($q) => $q->select(['uuid', 'product_id', 'name', 'value']),
                'stockTotal' => fn ($q) => $q->where('created_at', '>=', $stockTotalSince)->select(['id', 'assortmentId', 'created_at']),
                'sell' => fn ($q) => $q->select(['id', 'product_id', 'sell', 'created_at'])->orderByDesc('created_at')->limit($sellLimit),
            ])
            ->where('products.is_warehouse_item', true)
            ->where('products.is_discontinued', false)
            ->when($limitToProductIds !== null, function ($query) use ($limitToProductIds) {
                $query->whereIn('products.id', $limitToProductIds);
            })
            ->when($filter, function ($query) use ($filter) {
                if ($filter == 'zero') {
                    $query->doesntHave('stocks');
                }

                if ($filter == 'zero_no_transits') {
                    $query->doesntHave('stocks')->doesntHave('transits');
                }

                if ($filter == 'multiplicity') {
                    $query->whereNull('products.multiplicityProduct');
                }

                if ($filter == 'incomplete_pack') {
                    $packPercentLimit = (int) (static::salesFormulaSetting('incompletePackPercent', 0) ?? 0);

                    $query->whereNotNull('products.multiplicityProduct')
                        ->where('products.multiplicityProduct', '>', 0)
                        ->havingRaw('stocks_sum_quantity IS NOT NULL')
                        ->havingRaw('pack_percentage IS NOT NULL AND pack_percentage <= ?', [$packPercentLimit]);
                }
            });
    }

    /**
     * Облегчённый запрос только для COUNT списка «упущ. выгода» (без JOIN к агрегатам stock_totals/sells по периодам).
     * Совпадает по множеству строк с {@see outOfStockListBaseQuery()}: лишние JOIN там 1:1 по товару и не отфильтровывают строки.
     * Для фильтра incomplete_pack нужен только агрегат остатков по складам (pack %).
     */
    public static function outOfStockListCountQuery(?string $filter = null): Builder
    {
        $q = Products::query()
            ->select('products.id')
            ->leftJoin('suppliers', 'products.supplier', '=', 'suppliers.uuid')
            ->where('products.is_warehouse_item', true)
            ->where('products.is_discontinued', false);

        if ($filter === 'incomplete_pack') {
            $stocksAgg = Stock::query()
                ->selectRaw('assortmentId, SUM(quantity) as stocks_sum_quantity')
                ->groupBy('assortmentId');
            $q->leftJoinSub($stocksAgg, 'stocks_agg', function ($join) {
                $join->on('products.uuid', '=', 'stocks_agg.assortmentId');
            });
            $q->addSelect([
                DB::raw('IFNULL(stocks_agg.stocks_sum_quantity, 0) as stocks_sum_quantity'),
                DB::raw('LEAST(100, ROUND(IFNULL(stocks_agg.stocks_sum_quantity, 0) / NULLIF(products.multiplicityProduct, 0) * 100)) as pack_percentage'),
            ]);
        }

        $q->when($filter, function ($query) use ($filter) {
            if ($filter == 'zero') {
                $query->doesntHave('stocks');
            }

            if ($filter == 'zero_no_transits') {
                $query->doesntHave('stocks')->doesntHave('transits');
            }

            if ($filter == 'multiplicity') {
                $query->whereNull('products.multiplicityProduct');
            }

            if ($filter == 'incomplete_pack') {
                $packPercentLimit = (int) (static::salesFormulaSetting('incompletePackPercent', 0) ?? 0);

                $query->whereNotNull('products.multiplicityProduct')
                    ->where('products.multiplicityProduct', '>', 0)
                    ->havingRaw('stocks_sum_quantity IS NOT NULL')
                    ->havingRaw('pack_percentage IS NOT NULL AND pack_percentage <= ?', [$packPercentLimit]);
            }
        });

        return $q;
    }

    /**
     * Id товаров для одной страницы: либо без периодных агрегатов, либо с одним JOIN только под колонку сортировки (17–31).
     * Возвращает null только если колонка сортировки не распознана — тогда контроллер использует полный {@see outOfStockListBaseQuery()}.
     *
     * @return list<int>|null
     */
    public static function tryOutOfStockListPageProductIds(
        ?string $filter,
        string $orderBySql,
        string $orderDir,
        string $search,
        int $start,
        int $length,
        bool $orderUsesPeriodAggregates,
    ): ?array {
        if ($orderUsesPeriodAggregates) {
            $parsed = static::parseOutOfStockPeriodSortColumn($orderBySql);
            if ($parsed === null) {
                return null;
            }

            return static::outOfStockListPageProductIdsWithSinglePeriodSort(
                $filter,
                $orderBySql,
                $orderDir,
                $search,
                $start,
                $length,
                $parsed
            );
        }

        $joinStocksAgg = ($filter === 'incomplete_pack') || ($orderBySql === 'stocks_sum_quantity');
        $joinTransitsAgg = ($orderBySql === 'transits_sum_quantity');

        $q = Products::query()
            ->select('products.id')
            ->leftJoin('suppliers', 'products.supplier', '=', 'suppliers.uuid')
            ->where('products.is_warehouse_item', true)
            ->where('products.is_discontinued', false);

        if ($joinStocksAgg) {
            $stocksAgg = Stock::query()
                ->selectRaw('assortmentId, SUM(quantity) as stocks_sum_quantity')
                ->groupBy('assortmentId');
            $q->leftJoinSub($stocksAgg, 'stocks_agg', function ($join) {
                $join->on('products.uuid', '=', 'stocks_agg.assortmentId');
            });
            $q->addSelect(DB::raw('IFNULL(stocks_agg.stocks_sum_quantity, 0) as stocks_sum_quantity'));
            if ($filter === 'incomplete_pack') {
                $q->addSelect(DB::raw('LEAST(100, ROUND(IFNULL(stocks_agg.stocks_sum_quantity, 0) / NULLIF(products.multiplicityProduct, 0) * 100)) as pack_percentage'));
            }
        }

        if ($joinTransitsAgg) {
            $transitsAgg = Transit::query()
                ->selectRaw('assortmentId, SUM(quantity) as transits_sum_quantity')
                ->groupBy('assortmentId');
            $q->leftJoinSub($transitsAgg, 'transits_agg', function ($join) {
                $join->on('products.uuid', '=', 'transits_agg.assortmentId');
            });
            $q->addSelect(DB::raw('IFNULL(transits_agg.transits_sum_quantity, 0) as transits_sum_quantity'));
        }

        $q->when($filter, function ($query) use ($filter) {
            if ($filter == 'zero') {
                $query->doesntHave('stocks');
            }

            if ($filter == 'zero_no_transits') {
                $query->doesntHave('stocks')->doesntHave('transits');
            }

            if ($filter == 'multiplicity') {
                $query->whereNull('products.multiplicityProduct');
            }

            if ($filter == 'incomplete_pack') {
                $packPercentLimit = (int) (static::salesFormulaSetting('incompletePackPercent', 0) ?? 0);

                $query->whereNotNull('products.multiplicityProduct')
                    ->where('products.multiplicityProduct', '>', 0)
                    ->havingRaw('stocks_sum_quantity IS NOT NULL')
                    ->havingRaw('pack_percentage IS NOT NULL AND pack_percentage <= ?', [$packPercentLimit]);
            }
        });

        if ($search !== '') {
            $needle = '%'.$search.'%';
            $q->where(function ($sub) use ($needle) {
                $sub->where('products.name', 'like', $needle)
                    ->orWhere('products.code', 'like', $needle)
                    ->orWhere('products.article', 'like', $needle)
                    ->orWhere('suppliers.name', 'like', $needle);
            });
        }

        $q->orderBy($orderBySql, $orderDir === 'desc' ? 'desc' : 'asc');

        /** @var \Illuminate\Support\Collection<int, int> $ids */
        $ids = $q->skip($start)->take($length)->pluck('products.id');

        return $ids->map(fn ($id) => (int) $id)->all();
    }

    /**
     * Сортировка по одной колонке stock_zero_* / sell_*: один подзапрос по таблице, затем LIMIT (без мультипериодных JOIN).
     *
     * @param  array{type: 'stock_zero'|'sell', days: int}  $parsed
     * @return list<int>
     */
    private static function outOfStockListPageProductIdsWithSinglePeriodSort(
        ?string $filter,
        string $orderBySql,
        string $orderDir,
        string $search,
        int $start,
        int $length,
        array $parsed,
    ): array {
        $now = Carbon::now();
        $dir = $orderDir === 'desc' ? 'desc' : 'asc';

        $joinStocksAgg = ($filter === 'incomplete_pack');
        $q = Products::query()
            ->select('products.id')
            ->leftJoin('suppliers', 'products.supplier', '=', 'suppliers.uuid')
            ->where('products.is_warehouse_item', true)
            ->where('products.is_discontinued', false);

        if ($joinStocksAgg) {
            $stocksAgg = Stock::query()
                ->selectRaw('assortmentId, SUM(quantity) as stocks_sum_quantity')
                ->groupBy('assortmentId');
            $q->leftJoinSub($stocksAgg, 'stocks_agg', function ($join) {
                $join->on('products.uuid', '=', 'stocks_agg.assortmentId');
            });
            $q->addSelect(DB::raw('IFNULL(stocks_agg.stocks_sum_quantity, 0) as stocks_sum_quantity'));
            $q->addSelect(DB::raw('LEAST(100, ROUND(IFNULL(stocks_agg.stocks_sum_quantity, 0) / NULLIF(products.multiplicityProduct, 0) * 100)) as pack_percentage'));
        }

        if ($parsed['type'] === 'stock_zero') {
            $sub = static::subqueryStockZeroCountSinglePeriod($now, $parsed['days']);
            $q->leftJoinSub($sub, 'period_sort_agg', function ($join) {
                $join->on('products.uuid', '=', 'period_sort_agg.assortmentId');
            });
        } else {
            $sub = static::subquerySellSumSinglePeriod($now, $parsed['days']);
            $q->leftJoinSub($sub, 'period_sort_agg', function ($join) {
                $join->on('products.id', '=', 'period_sort_agg.product_id');
            });
        }

        $q->addSelect(DB::raw(
            'IFNULL(`period_sort_agg`.`'.$orderBySql.'`, 0) as `'.$orderBySql.'`'
        ));

        $q->when($filter, function ($query) use ($filter) {
            if ($filter == 'zero') {
                $query->doesntHave('stocks');
            }

            if ($filter == 'zero_no_transits') {
                $query->doesntHave('stocks')->doesntHave('transits');
            }

            if ($filter == 'multiplicity') {
                $query->whereNull('products.multiplicityProduct');
            }

            if ($filter == 'incomplete_pack') {
                $packPercentLimit = (int) (static::salesFormulaSetting('incompletePackPercent', 0) ?? 0);

                $query->whereNotNull('products.multiplicityProduct')
                    ->where('products.multiplicityProduct', '>', 0)
                    ->havingRaw('stocks_sum_quantity IS NOT NULL')
                    ->havingRaw('pack_percentage IS NOT NULL AND pack_percentage <= ?', [$packPercentLimit]);
            }
        });

        if ($search !== '') {
            $needle = '%'.$search.'%';
            $q->where(function ($w) use ($needle) {
                $w->where('products.name', 'like', $needle)
                    ->orWhere('products.code', 'like', $needle)
                    ->orWhere('products.article', 'like', $needle)
                    ->orWhere('suppliers.name', 'like', $needle);
            });
        }

        $q->orderBy($orderBySql, $dir)
            ->orderBy('products.id', 'asc');

        /** @var \Illuminate\Support\Collection<int, int> $ids */
        $ids = $q->skip($start)->take($length)->pluck('products.id');

        return $ids->map(fn ($id) => (int) $id)->all();
    }

    /**
     * Предрасчёт sales_formula на коллекцию (для JSON по страницам).
     */
    public static function hydrateOutOfStockSalesFormulas(iterable $products): void
    {
        foreach ($products as $product) {
            $product->outOfStockSalesFormulaCache = $product->getSalesFormula();
            $product->unsetRelation('stockTotal');
            $product->unsetRelation('sell');
            $product->unsetRelation('prices');
        }
    }

    /**
     * Агрегат по stock_totals: счётчики «обнулений» за окна дней (один проход таблицы).
     * Раньше: withCount — отдельный коррелированный подзапрос на каждую строку products.
     */
    private static function subqueryStockZeroCountsByPeriod(Carbon $now)
    {
        $periods = [3, 5, 7, 15, 30, 60, 90, 180, 365];
        $q = DB::table('stock_totals')->select('stock_totals.assortmentId');

        foreach ($periods as $days) {
            $date = $now->copy()->subDays($days)->format('Y-m-d H:i:s');
            $alias = "stock_zero_{$days}";
            $q->selectRaw(
                'SUM(CASE WHEN stock_totals.created_at > ? THEN 1 ELSE 0 END) AS `'.$alias.'`',
                [$date]
            );
        }

        $q->groupBy('stock_totals.assortmentId');

        return $q;
    }

    /**
     * Агрегат по sells: суммы продаж за окна дней (один проход таблицы).
     * Раньше: withSum — отдельный коррелированный подзапрос на каждую строку products.
     */
    private static function subquerySellSumsByPeriod(Carbon $now)
    {
        $periods = [15, 30, 60, 90, 180, 365];
        $q = DB::table('sells')->select('sells.product_id');

        foreach ($periods as $days) {
            $date = $now->copy()->subDays($days)->format('Y-m-d H:i:s');
            $alias = "sell_{$days}";
            $q->selectRaw(
                'SUM(CASE WHEN sells.created_at > ? THEN COALESCE(sells.sell, 0) ELSE 0 END) AS `'.$alias.'`',
                [$date]
            );
        }

        $q->groupBy('sells.product_id');

        return $q;
    }

    /**
     * Один период для сортировки (без расчёта всех окон в одном подзапросе).
     */
    private static function subqueryStockZeroCountSinglePeriod(Carbon $now, int $days): \Illuminate\Database\Query\Builder
    {
        $date = $now->copy()->subDays($days)->format('Y-m-d H:i:s');
        $alias = 'stock_zero_'.$days;

        return DB::table('stock_totals')
            ->select('stock_totals.assortmentId')
            ->selectRaw(
                'SUM(CASE WHEN stock_totals.created_at > ? THEN 1 ELSE 0 END) AS `'.$alias.'`',
                [$date]
            )
            ->groupBy('stock_totals.assortmentId');
    }

    /**
     * Одно окно продаж для сортировки.
     */
    private static function subquerySellSumSinglePeriod(Carbon $now, int $days): \Illuminate\Database\Query\Builder
    {
        $date = $now->copy()->subDays($days)->format('Y-m-d H:i:s');
        $alias = 'sell_'.$days;

        return DB::table('sells')
            ->select('sells.product_id')
            ->selectRaw(
                'SUM(CASE WHEN sells.created_at > ? THEN COALESCE(sells.sell, 0) ELSE 0 END) AS `'.$alias.'`',
                [$date]
            )
            ->groupBy('sells.product_id');
    }

    /**
     * @return array{type: 'stock_zero'|'sell', days: int}|null
     */
    private static function parseOutOfStockPeriodSortColumn(string $orderBySql): ?array
    {
        if (preg_match('/^stock_zero_(\d+)$/', $orderBySql, $m)) {
            $d = (int) $m[1];
            if (in_array($d, [3, 5, 7, 15, 30, 60, 90, 180, 365], true)) {
                return ['type' => 'stock_zero', 'days' => $d];
            }
        }
        if (preg_match('/^sell_(\d+)$/', $orderBySql, $m)) {
            $d = (int) $m[1];
            if (in_array($d, [15, 30, 60, 90, 180, 365], true)) {
                return ['type' => 'sell', 'days' => $d];
            }
        }

        return null;
    }

    public function getSalesFormula(): array
    {
        // Коэффициент пополнения
        $replenishmentCoefficient = floatval(static::salesFormulaSetting('replenishmentCoefficient', 1.5) ?? 1.5);

        // Количество дней для расчёта отсутствия
        $salesFormulaDays = intval(static::salesFormulaSetting('salesFormulaDays', 30) ?? 30);

        // Дней отсутствия за $salesFormulaDays дней
        $this->unavailable_days_count = $this->stockTotal->where('created_at', '>=', Carbon::now()->subDays($salesFormulaDays))->count();

        // Количество дней для расчёта продаж
        $salesFormulaDaysSell = intval(static::salesFormulaSetting('salesFormulaDaysSell', 2) ?? 2);

        // Продажи за $salesFormulaDaysSell дней где $salesFormulaDaysSell * 15
        $this->last_sell_sum = $this->sell->sortByDesc('created_at')->take($salesFormulaDaysSell)->sum('sell');

        // Средний спрос
        $days = $salesFormulaDays - $this->unavailable_days_count;

        if ($days > 0) {
            $middleSupply = round($this->last_sell_sum / ($salesFormulaDaysSell * 15), 2);
        } else {
            $middleSupply = 0;
        }

        // Базовый запас для редких товаров
        $baseStock = ($this->last_sell_sum <= 1) ? floatval(static::salesFormulaSetting('baseStock', 2) ?? 2) : 0;

        // Базовый запас для редких товаров стоимостью выше 50 000 (Цена)
        $baseStockPrice = intval(static::salesFormulaSetting('baseStockPrice', 50000) ?? 50000);

        // Базовый запас для редких товаров стоимостью выше 50 000 (Значение)
        $baseStockOverprice = (int) round((float) (static::salesFormulaSetting('baseStockOverprice', 1) ?? 1));

        if ($this->prices->where('name', 'Цена Маркеты с теста')->value('value') > $baseStockPrice) {
            $baseStock = $baseStockOverprice;
        }

        // Неснижаемый остаток
        $minimumBalance = round(($this->last_sell_sum * $replenishmentCoefficient) + ($this->unavailable_days_count * $middleSupply) + $baseStock);

        // Режим экономии
        $economyMode = filter_var(static::salesFormulaSetting('economyMode', '0'), FILTER_VALIDATE_BOOLEAN);
        $economyModeApplied = false;
        $economyModeDays = 0;
        $economyModeMaxPercent = 0;
        $economyModeAbsentDays = 0;
        $economyModeMaxAbsentDays = 0;
        $economyModeMinimumBalance = 0;
        $economyModeDaysMultiplier = 30;

        if ($economyMode) {
            $economyModeDays = intval(static::salesFormulaSetting('economyModeDays', 90) ?? 90);
            $economyModeMaxPercent = floatval(static::salesFormulaSetting('economyModeMaxPercent', 5) ?? 5);
            $economyModeDaysMultiplier = intval(static::salesFormulaSetting('economyModeDaysMultiplier', 30) ?? 30);

            $economyModeMaxAbsentDays = floor($economyModeDays * $economyModeMaxPercent / 100);
            $economyModeAbsentDays = $this->stockTotal
                ->where('created_at', '>=', Carbon::now()->subDays($economyModeDays))
                ->count();

            if ($economyModeAbsentDays <= $economyModeMaxAbsentDays) {
                $economyModeApplied = true;
                $economyModeMinimumBalance = round($middleSupply * $economyModeDaysMultiplier);
                $minimumBalance = $economyModeMinimumBalance;
            }
        }

        // Коэффициент максимального изменения предлагаемого остатка
        $maxMinimumBalance = static::salesFormulaSetting('maxMinimumBalance');

        if ($maxMinimumBalance) {
            $minimumBalance = min($this->minimumBalance * $maxMinimumBalance, $minimumBalance);
        }

        $minimumBalanceBeforeMultiplicity = $minimumBalance;

        // Кратность товара
        $sizePackPercent = 0;

        if ($this->multiplicityProduct) {
            $mult = (float) $this->multiplicityProduct;
            if ($minimumBalance < $this->multiplicityProduct) {
                $minimumBalance = $this->multiplicityProduct;
            } else {
                $sizePackPercent = fmod((float) $minimumBalance, $mult) / $mult * 100;

                if ($sizePackPercent > 80) {
                    $minimumBalance = $this->multiplicityProduct * ceil($minimumBalance / $mult);
                } else {
                    $minimumBalance = $this->multiplicityProduct * floor($minimumBalance / $mult);
                }
            }
        }

        $minimumBalanceBeforeBalanceLager = $minimumBalance;

        // Неснижаемый остаток lager
        if ($this->minimumBalanceLager) {
            $minimumBalance = max($minimumBalance, $this->minimumBalanceLager);
        }

        // Значение кол-ва в упаковке для товаров которые принимают поштучно
        $minimumBalanceInPack = $this->pack_quantity
            ? $minimumBalance * $this->pack_quantity
            : 0;

        return [
            'salesFormulaDaysSell' => $salesFormulaDaysSell, // Количество дней для расчёта продаж
            'salesFormulaDays' => $salesFormulaDays, // Количество дней для расчёта отсутствия
            'baseStockPrice' => $baseStockPrice, // Базовый запас для редких товаров стоимостью выше 50 000 (Цена)
            'baseStockOverprice' => $baseStockOverprice, // Базовый запас для редких товаров стоимостью выше 50 000 (Значение)
            'replenishmentCoefficient' => $replenishmentCoefficient, // Коэффициент пополнения
            'unavailable_days_count' => $this->unavailable_days_count, // Дней отсутствия за 30 дней
            'last_sell_sum' => $this->last_sell_sum, // Продажи за 30 дней
            'middleSupply' => $middleSupply, // Средний спрос
            'baseStock' => $baseStock, // Базовый запас для редких товаров
            'minimumBalance' => $minimumBalance, // Неснижаемый остаток
            'minimumBalanceInPack' => $minimumBalanceInPack, // Значение кол-ва в упаковке
            'maxMinimumBalance' => $maxMinimumBalance, // Коэффициент максимального изменения предлагаемого остатка
            'minimumBalanceBeforeMultiplicity' => $minimumBalanceBeforeMultiplicity, // Кратность товара
            'multiplicity' => $this->multiplicityProduct, // Кратность товара
            'sizePackPercent' => $sizePackPercent, // Кратность товара процент
            'minimumBalanceLager' => $this->minimumBalanceLager, // Неснижаемый остаток lager
            'minimumBalanceBeforeBalanceLager' => $minimumBalanceBeforeBalanceLager, // Неснижаемый остаток до lager

            // Режим экономии
            'economyMode' => $economyMode,
            'economyModeApplied' => $economyModeApplied,
            'economyModeDays' => $economyModeDays,
            'economyModeMaxPercent' => $economyModeMaxPercent,
            'economyModeAbsentDays' => $economyModeAbsentDays,
            'economyModeMaxAbsentDays' => $economyModeMaxAbsentDays,
            'economyModeMinimumBalance' => $economyModeMinimumBalance,
            'economyModeDaysMultiplier' => $economyModeDaysMultiplier,
        ];
    }

    public function salesFormula(): Attribute
    {
        return Attribute::get(function () {
            if ($this->outOfStockSalesFormulaCache !== null) {
                return $this->outOfStockSalesFormulaCache;
            }

            return $this->getSalesFormula();
        });
    }

    public function priceAuto(): Attribute
    {
        $priceAutoIndex = collect($this['attributes'])->search(fn ($item) => $item['name'] == 'Автоматизация цены');

        return Attribute::get(fn () => ($priceAutoIndex) ? $this['attributes'][$priceAutoIndex]['value'] : ' - ');
    }
}
