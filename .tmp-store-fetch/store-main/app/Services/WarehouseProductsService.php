<?php

namespace App\Services;

use App\Models\Products;

class WarehouseProductsService
{
    /** @var array{buyPrice: float|int, salePrices: float|int, minPrice: float|int}|null */
    private ?array $warehouseStockSumsCache = null;

    /**
     * Get sum of a specific field for warehouse products with stocks
     *
     * @param  string  $field  The field name to sum
     */
    public function getSumByField(string $field): float|int
    {
        return Products::where('is_warehouse_item', true)
            ->has('stocks')
            ->sum($field);
    }

    /**
     * Get total purchase price for warehouse products with stocks
     */
    public function getTotalPurchasePrice(): float|int
    {
        return $this->warehouseStockSums()['buyPrice'];
    }

    /**
     * Get total sale price for warehouse products with stocks
     */
    public function getTotalSalePrice(): float|int
    {
        return $this->warehouseStockSums()['salePrices'];
    }

    /**
     * Get total minimum price for warehouse products with stocks
     */
    public function getTotalMinPrice(): float|int
    {
        return $this->warehouseStockSums()['minPrice'];
    }

    /**
     * Одна выборка для сумм buyPrice / salePrices / minPrice по складским позициям с остатком (дашборд).
     *
     * @return array{buyPrice: float|int, salePrices: float|int, minPrice: float|int}
     */
    private function warehouseStockSums(): array
    {
        if ($this->warehouseStockSumsCache !== null) {
            return $this->warehouseStockSumsCache;
        }

        $row = Products::query()
            ->where('is_warehouse_item', true)
            ->has('stocks')
            ->selectRaw('COALESCE(SUM(buyPrice), 0) as buy_price_sum, COALESCE(SUM(salePrices), 0) as sale_prices_sum, COALESCE(SUM(minPrice), 0) as min_price_sum')
            ->first();

        $this->warehouseStockSumsCache = [
            'buyPrice' => (float) ($row->buy_price_sum ?? 0),
            'salePrices' => (float) ($row->sale_prices_sum ?? 0),
            'minPrice' => (float) ($row->min_price_sum ?? 0),
        ];

        return $this->warehouseStockSumsCache;
    }

    /**
     * Get sum of prices by name for warehouse products with stocks
     *
     * @param  string  $priceName  The price name to sum
     */
    public function getSumPriceByName(string $priceName): float|int
    {
        return Products::where('is_warehouse_item', true)
            ->has('stocks')
            ->join('prices', 'products.id', '=', 'prices.product_id')
            ->where('prices.name', $priceName)
            ->sum('prices.value');
    }
}
