<?php


namespace App\Domain\Shipper;

use App\Models\Supplier;

class ShipperFactory
{
    public function makeShipper(Supplier $supplier)
    {
        return new Shipper(
            $supplier->shipper_id,
            $supplier,
            $supplier->uuid,
            $supplier->name,
            $supplier->shipper_name,
            $supplier->shipper_email,
            $supplier->shipper_plan_fix_email,
            $supplier->shipper_plan_fix_link,
            $supplier->shipper_comment,
            $supplier->shipper_min_sum ?? 0,
            $supplier->shipper_fill_storage ?? 0,
            $supplier->shipper_filter_id,
            $supplier->shipper_calc_occupancy_percent_all ?? 0,
            $supplier->shipper_calc_occupancy_percent_selected ?? 0,
            $supplier->shipper_warehouse_info_all ?? null,
            $supplier->shipper_warehouse_info_selected ?? null,
            $supplier->shipper_calc_quantity ?? 0,
            $supplier->shipper_calc_to_purchase ?? 0,
            $supplier->shipper_calc_purchase_total ?? 0,
        );
    }
}
