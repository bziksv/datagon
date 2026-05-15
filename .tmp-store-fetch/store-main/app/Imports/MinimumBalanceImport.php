<?php

namespace App\Imports;

use App\Models\Products;
use App\Models\Store;
use Illuminate\Support\Collection;
use Maatwebsite\Excel\Concerns\ToCollection;
use Maatwebsite\Excel\Concerns\WithHeadingRow;
use Illuminate\Support\Str;

class MinimumBalanceImport implements ToCollection, WithHeadingRow
{
    /**
    * @param Collection $collection
    */
    public function collection(Collection $collection)
    {
        $stores = Store::pluck('name');

        foreach ($collection as $collect) {
            $balance = 0;

            foreach ($stores as $store) {
                $name = Str::slug('Неснижаемый остаток для склада ' . $store, '_');

                if (isset($collect[$name])) {
                    $balance += $collect[$name];
                }
            }

            $code = $collect['vnesnii_kod'] ?? null;

            if ($code && $balance > 0) {
                Products::where('externalCode', $code)
                    ->update(['minimumBalanceLager' => $balance]);
            }
        }
    }
}
