<?php

namespace App\Actions;

use App\Domain\Shipper\ShipperFacade;

class UpdatePurchaseTotalShipperAction extends UpdateShipperMain
{
    public function execute(): void
    {
        foreach ($this->supplier_ids as $supplier_id) {

            $shipper = (new ShipperFacade($this->shipperRepository->getShipperById($supplier_id)))
                ->getShipperWithWarehouses();

            if ($this->update($shipper->getShipperId(), ['calc_purchase_total' => $shipper->totalPurchaseByWarehouses()])) {
                $this->count++;
            }
        }
    }
}
