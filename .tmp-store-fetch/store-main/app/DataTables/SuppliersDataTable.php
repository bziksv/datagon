<?php

namespace App\DataTables;

use App\Models\Products;
use App\Services\DataTableViewService;
use DataTables;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Collection;

class SuppliersDataTable
{
    protected $query;
    protected $dataTable;

    public function __construct(Builder $query)
    {
        $this->query = $query;

        $this->dataTable = DataTables::eloquent($this->query)->filter([$this, 'filter']);
    }

    public function filter($query): void
    {
        self::applyHttpFilters($query);
    }

    public static function applyHttpFilters(Builder $query): void
    {
        $search = request('search');
        $toBuy = request('toBuy');
        $fbo = request('fbo');

        if (! empty($search['value'])) {
            $query->whereAny(['products.name', 'products.code'], 'LIKE', '%'.$search['value'].'%');
        }

        if ($toBuy) {
            $query->having('toBuy', '>', '0');
        }

        if ($fbo) {
            $query->whereJsonContains('attributes', ['name' => 'FBO OZON', 'value' => true]);
        }
    }

    public function getCollection(): Collection
    {
        return $this->dataTable->getFilteredQuery()->get();
    }

    public function get()
    {
        return $this->dataTable;
    }

    public function getQuery()
    {
        return $this->query;
    }

    public function getJson(?int $overrideRecordsTotal = null, ?int $overrideRecordsFiltered = null)
    {
        $engine = $this->get();
        if ($overrideRecordsTotal !== null) {
            $engine->setTotalRecords($overrideRecordsTotal);
        }
        if ($overrideRecordsFiltered !== null) {
            $engine->setFilteredRecords($overrideRecordsFiltered);
        }

        return $engine
            ->editColumn('minimumBalanceLager', function (Products $products) {
                return DataTableViewService::columnInputView([
                    'id' => $products->id,
                    'value' => $products->minimumBalanceLager,
                    'action' => 'minimumBalanceLager',
                ]);
            })
            ->editColumn('multiplicityProduct', function (Products $products) {
                return DataTableViewService::columnInputView([
                    'id' => $products->id,
                    'value' => $products->multiplicityProduct,
                    'action' => 'multiplicityProduct',
                ]);
            })
            ->toJson();
    }

}
