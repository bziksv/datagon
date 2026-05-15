<?php


namespace App\Infrastructure;

use App\Domain\Product\ProductFactory;
use App\Domain\Product\ProductRepository;
use App\Domain\Shipper\Shipper;
use App\Models\Products;

class EloquentProductRepository implements ProductRepository
{
    public function getAvailableProductsToShipper(Shipper $shipper): array
    {
        $collection = Products::where('supplier', $shipper->uuid)
            ->with(['stocks', 'reserves', 'transits'])
            ->where('is_warehouse_item', true)
            ->get();

        $factory = new ProductFactory;

        return $collection->map(function ($item) use ($factory) {
            return $factory->makeFromModel($item);
        })->all();
    }
}
