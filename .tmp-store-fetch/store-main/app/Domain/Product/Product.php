<?php


namespace App\Domain\Product;

use App\Helpers\ProductHelper;
use App\Services\PackingService;

class Product
{
    public ?int $id;
    public ?int $minimumBalance = 0;

    public float $buyPrice = 0;

    public ?string $name;
    public ?string $uoms;

    public array $attributes = [];
    public array $stocks = [];
    public array $reserves = [];
    public array $transits = [];

    public function __construct(int $id, string $name, ?int $minimumBalance, array $attributes)
    {
        $this->id = $id;
        $this->name = $name;
        $this->attributes = $attributes;
        $this->minimumBalance = $minimumBalance;
    }

    public function getUoms(): ?string
    {
        return $this->uoms;
    }

    public function setUoms(?string $uoms): void
    {
        $this->uoms = $uoms;
    }

    public function setStocks(array $stocks): void
    {
        $this->stocks = $stocks;
    }

    public function setReserves(array $reserves): void
    {
        $this->reserves = $reserves;
    }

    public function setTransits(array $transits): void
    {
        $this->transits = $transits;
    }

    public function hasBalance(): bool
    {
        return $this->minimumBalance > 0;
    }

    public function setBuyPrice(float $buyPrice): void
    {
        $this->buyPrice = $buyPrice;
    }

    public function totalBuyPrice(array $filter = []): float
    {
        $quantity = $this->calculateQuantityToBuy($filter);

        $size = ProductHelper::getPackSize($this);

        if ($size > 0 && $this->getUoms() !== "уп") {
            $quantity = (new PackingService())->calculatePackedQuantity($quantity, $size);
        }

        return $this->getBuyPrice() * $quantity;
    }

    public function calculateQuantityToBuy(array $filter = []): int
    {
        $stock = $this->totalStock($filter);

        $reserve = $this->totalReserves($filter);

        $transit = $this->totalTransits($filter);

        $toBuy = ($this->minimumBalance() - (($stock - $reserve) + $transit));

        if ($toBuy > 0) {
            return $toBuy;
        }

        return 0;
    }

    public function totalStock(array $filter = []): int
    {
        return array_sum($this->getFilteredStockStores($filter));
    }

    public function totalReserves(array $filter = []): int
    {
        return array_sum($this->getFilteredReservesStores($filter));
    }

    public function totalTransits(array $filter = []): int
    {
        return array_sum($this->getFilteredTransitsStores($filter));
    }

    public function minimumBalance(): int
    {
        return $this->minimumBalance ?? 0;
    }

    public function getBuyPrice(): float
    {
        return $this->buyPrice;
    }

    public function getFilteredStockStores(array $storeIds): array
    {
        return $this->filteredStores($this->stocks, $storeIds);
    }

    public function getFilteredReservesStores(array $storeIds): array
    {
        return $this->filteredStores($this->reserves, $storeIds);
    }

    public function getFilteredTransitsStores(array $storeIds): array
    {
        return $this->filteredStores($this->transits, $storeIds);
    }

    private function filteredStores(array $stores, array $ids): array
    {
        if (empty($ids)) {
            return $stores;
        }

        return array_filter($stores, function ($key) use ($ids) {
            return in_array($key, $ids);
        }, ARRAY_FILTER_USE_KEY);
    }


}
