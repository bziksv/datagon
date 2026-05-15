<?php

namespace App\Actions;

use App\Domain\Shipper\ShipperFacade;

class UpdateQuantityShipperAction extends UpdateShipperMain
{
    public function execute(): void
    {
        foreach ($this->supplier_ids as $supplier_id) {

            $shipper = (new ShipperFacade($this->shipperRepository->getShipperById($supplier_id)))->getShipperWithProducts();

            if ($this->update($shipper->getShipperId(), ['calc_quantity' => $shipper->quantity()])) {
                $this->count++;
            }
        }
    }
}
