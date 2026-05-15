<?php

namespace App\Actions;

use App\Domain\Shipper\Shipper as ShipperEntity;
use App\Domain\Shipper\ShipperFacade;

class UpdateOccupancyShipperAction extends UpdateShipperMain
{
    public function execute(): void
    {
        foreach ($this->supplier_ids as $supplier_id) {
            $shipper = $this->shipperRepository->getShipperById($supplier_id);

            $data = $this->calculateWarehouseOccupancyPercent($shipper);

            if ($this->update($shipper->getShipperId(), $data)) {
                $this->count++;
            }
        }
    }

    protected function calculateWarehouseOccupancyPercent(ShipperEntity $shipper): array
    {
        $shipperFacade = new ShipperFacade($shipper);

        $shipperFacade->setProductsToShipper();

        $occupancyPercentAll = $shipper->getWarehouseOccupancyPercentAll();

        $shipperFacade->setStoragesToShipper();

        $occupancyPercentSelected = $shipper->getWarehouseOccupancyPercentSelected();

        $balance = $shipperFacade->getMinimumBalance();

        $stock = $shipperFacade->getWarehouseStockAll();

        $warehouses = $shipper->getStockByStorages();

        return [
            'calc_occupancy_percent_all' => $occupancyPercentAll,
            'calc_occupancy_percent_selected' => $occupancyPercentSelected,
            'warehouse_info_all' => view('shippers.partials.warehouse-occupancy-all-tooltip', compact('balance', 'stock'))->render(),
            'warehouse_info_selected' => view('shippers.partials.warehouse-occupancy-selected-tooltip', compact('balance', 'stock', 'warehouses'))->render()
        ];
    }

}
