<?php

namespace App\Console\Commands;

use App\Http\Controllers\ProductsController;
use Illuminate\Console\Command;
use Illuminate\Http\Request;

class WarmOutOfStockNewDatatableCacheCommand extends Command
{
    protected $signature = 'lagerplus:warm-out-of-stock-new-datatable';

    protected $description = 'Прогрев кеша DataTables «упущ. выгода New» (первая страница, типовые фильтры)';

    public function handle(ProductsController $productsController): int
    {
        if (! config('lagerplus.out_of_stock_new_cache_warm.enabled', true)) {
            $this->warn('Прогрев отключён (lagerplus.out_of_stock_new_cache_warm.enabled).');

            return self::SUCCESS;
        }

        $filters = ['', 'zero', 'zero_no_transits', 'multiplicity', 'incomplete_pack'];
        $n = 0;
        foreach ($filters as $filter) {
            $request = Request::create('/products/out-of-stock-new/json', 'GET', [
                'draw' => 1,
                'start' => 0,
                'length' => 50,
                'filter' => $filter,
                'order' => [['column' => 1, 'dir' => 'asc']],
                'search' => ['value' => '', 'regex' => false],
            ]);
            $productsController->warmOutOfStockNewDatatableCacheEntry($request);
            $n++;
        }

        $this->info("Прогрето записей кеша: {$n} (фильтры по умолчанию, стр. 1, сортировка по названию).");

        return self::SUCCESS;
    }
}
