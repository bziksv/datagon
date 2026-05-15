<?php


namespace App\Models\LocalScopes;

use App\Models\Employee;
use App\Models\Reserve;
use App\Models\Stock;
use App\Models\Transit;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Builder;

class ProductsScopes extends Model
{
    public function scopeSearchCols(Builder $query, array $value): void
    {
        if (count($value) > 0) {
            $search = [];

            foreach ($value as $item) {
                if (array_key_exists('col', $item) && array_key_exists('val', $item) && strlen($item['val']) > 0)
                    $search[] = [$item['col'], 'like', $item['val'] . '%'];
            }

            if (count($search) > 0)
                $query->where($search);
        }
    }

    public function scopeOrderCol(Builder $query, string $col = 'name', string $dir = 'asc'): void
    {
        $query->orderBy($col, $dir);
    }

    public function scopeSelectEmployee(Builder $query)
    {
        $query->addSelect(['owner' => Employee::select('name')->whereColumn('uuid', 'products.owner')->limit(1)]);
    }

    /**
     * @param  list<int>|null  $limitToProductIds  ограничить агрегаты stock/reserve/transit только этими товарами (после пагинации по id).
     */
    public function scopeSuppliersDataTable(Builder $query, array $stores = [], ?array $limitToProductIds = null)
    {
        $uuids = null;
        if ($limitToProductIds !== null && $limitToProductIds !== []) {
            $uuids = static::query()
                ->whereIn('id', $limitToProductIds)
                ->pluck('uuid')
                ->filter()
                ->values()
                ->all();
        }

        $stocksSub = Stock::query();
        $stocksSub->sum($stores);
        if ($uuids !== null && $uuids !== []) {
            $stocksSub->whereIn('assortmentId', $uuids);
        }

        $reservesSub = Reserve::query();
        $reservesSub->sum($stores);
        if ($uuids !== null && $uuids !== []) {
            $reservesSub->whereIn('assortmentId', $uuids);
        }

        $transitsSub = Transit::query();
        $transitsSub->sum($stores);
        if ($uuids !== null && $uuids !== []) {
            $transitsSub->whereIn('assortmentId', $uuids);
        }

        $query->with(['suppliers', 'uoms'])
            ->select('products.*', 'stocks.stock', 'reserves.reserve', 'transits.transit')
            ->addSelectToBuy()
            ->addStockPercent()
            ->leftJoinSub($stocksSub, 'stocks', function ($join) {
                $join->on('products.uuid', '=', 'stocks.assortmentId');
            })
            ->leftJoinSub($reservesSub, 'reserves', function ($join) {
                $join->on('products.uuid', '=', 'reserves.assortmentId');
            })
            ->leftJoinSub($transitsSub, 'transits', function ($join) {
                $join->on('products.uuid', '=', 'transits.assortmentId');
            })
            ->when($limitToProductIds !== null && $limitToProductIds !== [], function (Builder $q) use ($limitToProductIds) {
                $q->whereIn('products.id', $limitToProductIds);
            });
    }

    public function scopeinStock(Builder $query)
    {
        $query->whereRaw('IFNULL(stock, 0) > ?', [0]);
    }

    public function scopeIsWarehousePosition(Builder $query)
    {
        $query->where('is_warehouse_item', true);
    }

    public function scopeAddSelectToBuy(Builder $query)
    {
        $query->selectRaw('IFNULL(products.minimumBalanceLager, IFNULL(products.minimumBalance, 0)) - ((IFNULL(stocks.stock, 0) - IFNULL(reserves.reserve, 0)) + IFNULL(transits.transit, 0)) as toBuy');
    }

    public function scopeAddStockPercent(Builder $query)
    {
        $minimumBalance = 'IFNULL(products.minimumBalanceLager, IFNULL(products.minimumBalance, 0))';
        $a = '(IFNULL(stocks.stock, 0) + IFNULL(transits.transit, 0) - IFNULL(reserves.reserve, 0))';
        $b = "($minimumBalance / 100)";

        $query->selectRaw("$a DIV $b as stockPercent");
    }
}
