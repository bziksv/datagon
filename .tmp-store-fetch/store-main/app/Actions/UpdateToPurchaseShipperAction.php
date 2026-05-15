<?php

namespace App\Actions;

use App\Domain\Shipper\ShipperFacade;

class UpdateToPurchaseShipperAction extends UpdateShipperMain
{
    public function execute(): void
    {
        foreach ($this->supplier_ids as $supplier_id) {

            $shipper = (new ShipperFacade($this->shipperRepository->getShipperById($supplier_id)))
                ->getShipperWithWarehouses();

            if ($this->update($shipper->getShipperId(), ['calc_to_purchase' => $shipper->totalToBuy()])) {
                $this->count++;
            }
        }
    }
}
