<?php

namespace App\Domain\Shipper;

use App\Domain\Product\ProductRepository;
use App\Infrastructure\EloquentProductRepository;
use App\Models\Filter;
use App\Models\User;

class ShipperFacade
{
    protected Shipper $shipper;
    protected ProductRepository $productRepository;

    public function __construct(Shipper $shipper)
    {
        $this->shipper = $shipper;

        $this->productRepository = new EloquentProductRepository;
    }

    public function getUsers(): array
    {
        $id = $this->shipper->getShipperId();

        return (new User())->getUsersForShipper($id);
    }

    public function setUsersToShipper(): self
    {
        $this->shipper->setUsers($this->getUsers());

        return $this;
    }

    public function getShipper(): Shipper
    {
        return $this->shipper;
    }

    public function setProductsToShipper(): self
    {
        $products = $this->productRepository->getAvailableProductsToShipper($this->shipper);

        $this->shipper->setProducts($products);

        return $this;
    }

    public function setFilterToShipper(): self
    {
        $id = $this->shipper->getFilterId();

        $filter = (new Filter())->with('user')->find($id);

        $this->shipper->setFilter($filter);

        return $this;
    }

    public function setStoragesToShipper(): self
    {
        $supplier = $this->shipper->getSupplier();

        $this->shipper->setStorages($supplier->shipper?->stores->all() ?? []);

        return $this;
    }

    public function getWarehouseStockAll(): int
    {
        $this->setProductsToShipper();

        return $this->getShipper()->totalStockProducts();
    }

    public function getMinimumBalance(): int
    {
        $this->setProductsToShipper();

        return $this->getShipper()->totalMinBalanceProducts();
    }

    public function getShipperWithProducts(): Shipper
    {
        $this->setProductsToShipper();

        return $this->getShipper();
    }

    public function getShipperWithWarehouses(): Shipper
    {
        $this->setProductsToShipper();
        $this->setStoragesToShipper();

        return $this->getShipper();
    }

    public function getShipperWithWarehousesAndUsers(): Shipper
    {
        $this->setProductsToShipper();
        $this->setStoragesToShipper();
        $this->setUsersToShipper();

        return $this->getShipper();
    }
}
