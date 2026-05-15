<?php


namespace App\Domain\Product;

use App\Models\Products;

class ProductFactory
{
    public function makeFromModel(Products $product): Product
    {
        $minBalance = $product->minimumBalanceLager ?: $product->minimumBalance;

        $obj = new Product($product->id, $product->name, $minBalance, $product->attributes);

        $stocks = $product->stocks->pluck('quantity', 'storeId')->all();
        $reserves = $product->reserves->pluck('quantity', 'storeId')->all();
        $transits = $product->transits->pluck('quantity', 'storeId')->all();

        $obj->setStocks($stocks);

        $obj->setReserves($reserves);

        $obj->setTransits($transits);

        $obj->setBuyPrice(floatval($product['buyPrice']));

        $obj->setUoms($product->uoms->name);

        return $obj;
    }
}
