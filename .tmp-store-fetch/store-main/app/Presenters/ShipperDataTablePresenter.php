<?php


namespace App\Presenters;


use App\Domain\Shipper\Shipper;
use App\DTO\ShipperPaginationDTO;

class ShipperDataTablePresenter extends ShipperPresenter
{
    protected Shipper $shipper;

    public function data(Shipper $shipper): array
    {
        $this->shipper = $shipper;

        return [
            'id' => $shipper->getSupplierId(),
            'name' => $this->nameView(),
            'employee' => $this->employeeView(),
            'filter' => $this->filterView(),
            'comment' => $shipper->getComment(),
            'min_sum' => money($shipper->getMinSum()),
            'fill_storage' => $shipper->fill_storage,
            'calc_occupancy_percent_all' => $this->warehouseOccupancyPercentAll(),
            'calc_occupancy_percent_selected' => $this->warehouseOccupancyPercentSelected(),
            'warehouse_info_all' => $shipper->warehouse_info_all,
            'warehouse_info_selected' => $shipper->warehouse_info_selected,
            'calc_quantity' => $shipper->getCalcQuantityProducts(),
            'calc_to_purchase' => amount($shipper->getCalcToPurchase()),
            'calc_purchase_total' => money($shipper->getCalcPurchaseTotal()),
            'sender' => '',
            'text_for_sender' => '',
            'export' => $this->exportView(),
            'stat' => '',
            'edit' => $this->editView(),
        ];
    }

    public function present(ShipperPaginationDTO $dto): string
    {
        $collect = collect([
            'draw' => request('draw'),
            'recordsTotal' => $dto->recordsTotal,
            'recordsFiltered' => $dto->recordsFiltered,
            'data' => array_map([$this, 'data'], $dto->shippers),
            'error' => '',
        ]);

        return $collect->toJson();
    }

    protected function nameView(): string
    {
        $shipper = $this->shipper;

        $name = $shipper->getName();
        $old_name = $shipper->getOldName();

        return view('shippers.columns.name', compact('name', 'old_name'))->render();
    }

    protected function employeeView(): string
    {
        $users = $this->shipper->getUsers();

        return view('shippers.columns.users', compact('users'))->render();
    }

    protected function filterView(): string
    {
        $filter = $this->shipper->filter();

        return view('shippers.columns.filter', compact('filter'))->render();
    }

    protected function warehouseOccupancyPercentAll(): string
    {
        $value = $this->shipper->getCalcWarehouseOccupancyPercentAll();

        return view('shippers.columns.occupancy-percent-all', compact('value'))->render();
    }

    protected function warehouseOccupancyPercentSelected(): string
    {
        $value = $this->shipper->getCalcWarehouseOccupancyPercentSelected();

        return view('shippers.columns.occupancy-percent-selected', compact('value'))->render();
    }

    protected function exportView(): string
    {
        $shipper = $this->shipper;

        $exportSuppliers = $shipper->generateSuppliersExportLink();
        $exportBuyers = $shipper->generateBuyersExportLink();

        return view('shippers.columns.export', ['suppliers' => $exportSuppliers, 'buyers' => $exportBuyers])->render();
    }

    protected function editView(): string
    {
        return view('shippers.columns.edit', ['link' => route('shipper.edit', $this->shipper->getSupplierId())])->render();
    }
}
