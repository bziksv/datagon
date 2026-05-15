<?php

namespace App\Services;

use App\Models\Bundle;

class BundleService
{
    public function getBundleByProduct(string $uuid): array
    {
        $bundle = Bundle::query()->whereJsonContains('components->rows', ['assortment' => ['id' => $uuid]])->get();

        return $bundle->toArray();
    }
}
