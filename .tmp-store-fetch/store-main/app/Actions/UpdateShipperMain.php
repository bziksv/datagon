<?php

namespace App\Actions;

use App\Domain\Shipper\ShipperRepository;
use App\Infrastructure\EloquentShipperRepository;
use App\Models\Shipper;

abstract class UpdateShipperMain
{
    protected int $count = 0;

    protected array $supplier_ids = [];
    protected ShipperRepository $shipperRepository;

    public function __construct()
    {
        $this->shipperRepository = new EloquentShipperRepository;
        $this->supplier_ids = Shipper::pluck('supplier_id')->toArray();
    }

    abstract public function execute(): void;

    protected function update(int $id, array $update): bool
    {
        return Shipper::query()
            ->where('id', $id)
            ->update($update);
    }

    public function getCount(): int
    {
        return $this->count;
    }
}
