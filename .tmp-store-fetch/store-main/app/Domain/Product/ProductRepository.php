<?php


namespace App\Domain\Product;


use App\Domain\Shipper\Shipper;

interface ProductRepository
{
    public function getAvailableProductsToShipper(Shipper $shipper): array;
}
