<?php

namespace App\Lib\Sale;

use App\Lib\DataTable\DataTableRequest;
use App\Models\Products;
use App\Services\DataTableViewService;
use Illuminate\Database\Eloquent\Builder;

class ProductsTable extends DataTableRequest
{
    public function __construct(array $request)
    {
        $this->setRequest($request);
        $this->fillTable();
    }

    public function fillTable(): void
    {
        $order = $this->prepareOrder();
        $search = $this->prepareSearch();

        $searchPlain = (string) ($this->search['value'] ?? '');
        $fullTextSearch = $this->fullTextLogic($searchPlain);
        $fbo = request('fbo');

        /*
         * Фильтры не используют поля из join остатков — считаем recordsFiltered без трёх
         * LEFT JOIN подзапросов (иначе paginate делает второй такой же тяжёлый COUNT).
         * Сами строки страницы по-прежнему с suppliersDataTable().
         */
        $filteredBase = Products::query()
            ->searchCols($search)
            ->when($fullTextSearch, function (Builder $query) use ($fullTextSearch, $searchPlain) {
                try {
                    $query->whereFullText(['name', 'code', 'article'], $fullTextSearch, ['mode' => 'boolean']);
                } catch (\Throwable) {
                    if (strlen($searchPlain) >= 2) {
                        $term = '%'.addcslashes($searchPlain, '%_\\').'%';
                        $query->where(function (Builder $q) use ($term) {
                            $q->where('products.name', 'like', $term)
                                ->orWhere('products.code', 'like', $term)
                                ->orWhere('products.article', 'like', $term);
                        });
                    }
                }
            })
            ->when($fbo, function (Builder $query) {
                $query->whereJsonContains('attributes', ['name' => 'FBO OZON', 'value' => true]);
            });

        $recordsFiltered = (clone $filteredBase)->count();

        $page = (int) (($this->start / $this->length) + 1);

        $pagination = (clone $filteredBase)
            ->suppliersDataTable()
            ->selectEmployee()
            ->orderCol($order['column'], $order['dir'])
            ->paginate($this->length, ['*'], 'page', $page, $recordsFiltered);

        $data = $pagination->items();

        foreach ($data as $i) {
            $i->minimumBalanceLager = DataTableViewService::columnInputView([
                'id' => $i->id,
                'value' => $i->minimumBalanceLager,
                'action' => 'minimumBalanceLager',
            ], true);

            $i->multiplicityProduct = DataTableViewService::columnInputView([
                'id' => $i->id,
                'value' => $i->multiplicityProduct,
                'action' => 'multiplicityProduct',
            ], true);
        }

        $this->setData($data);
        $this->setRecordsTotal(Products::query()->count());
        $this->setRecordsFiltered($recordsFiltered);
    }

    private function prepareSearch(): array
    {
        $search = [];

        foreach ($this->columns as $col) {
            if (! is_array($col) || empty($col['data'])) {
                continue;
            }
            $colSearch = $col['search'] ?? [];
            if (! empty($colSearch['value'])) {
                $search[] = ['col' => $col['data'], 'val' => $colSearch['value']];
            }
        }

        return $search;
    }

    private function prepareOrder(): array
    {
        $order = ['column' => 'name', 'dir' => 'asc'];

        if (! isset($this->order[0]) || ! is_array($this->order[0])) {
            return $order;
        }

        $idx = (int) ($this->order[0]['column'] ?? 0);
        if (! isset($this->columns[$idx]) || ! is_array($this->columns[$idx])) {
            return $order;
        }

        $col = (string) ($this->columns[$idx]['data'] ?? '');
        if ($col === '') {
            return $order;
        }

        $dir = strtolower((string) ($this->order[0]['dir'] ?? 'asc'));

        return [
            'column' => $col,
            'dir' => in_array($dir, ['asc', 'desc'], true) ? $dir : 'asc',
        ];
    }

    protected function fullTextLogic(string $search): string
    {
        if (strlen($search) < 2) {
            return '';
        }

        if (preg_match('/[\.\-\+\*]/', $search)) {
            return '"'.$search.'"';
        }

        $words = explode(' ', $search);

        foreach ($words as &$word) {
            $word = '+'.$word.'*';
        }

        return implode(' ', $words);
    }
}
