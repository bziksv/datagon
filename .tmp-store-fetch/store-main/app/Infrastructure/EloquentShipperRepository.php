<?php


namespace App\Infrastructure;

use App\Domain\Shipper\Shipper;
use App\Domain\Shipper\ShipperFactory;
use App\Domain\Shipper\ShipperRepository;
use App\DTO\ShipperDataTableDTO;
use App\DTO\ShipperPaginationDTO;
use App\DTO\ShipperRequestDTO;
use App\Models\Supplier;
use App\Models\Products;

class EloquentShipperRepository implements ShipperRepository
{
    public function getAvailableShippers(ShipperDataTableDTO $sdt): ShipperPaginationDTO
    {
        $length = max(1, (int) $sdt->length);
        $page = (int) floor(((int) $sdt->start) / $length) + 1;

        $order = $this->getColumnByIndex($sdt->columns, (int) $sdt->orderBy) ?? 'id';
        $dir = $sdt->dir ?? 'asc';

        $searchBuilder = $sdt->searchBuilder;
        $hasSearchBuilder = is_array($searchBuilder) && ! empty($searchBuilder['criteria'] ?? []);

        /** Сортировка только по id/name не требует GROUP_CONCAT до подсчёта строк. */
        $orderNeedsShipperJoin = $hasSearchBuilder || ! in_array((string) $order, ['id', 'name'], true);

        $availableShippers = Products::query()
            ->select('supplier')
            ->whereNotNull('supplier')
            ->where('is_warehouse_item', true)
            ->groupBy('supplier');

        if (! $orderNeedsShipperJoin) {
            $base = Supplier::query()
                ->whereIn('uuid', $availableShippers)
                ->when($sdt->search, function ($query, $search) {
                    $query->where('suppliers.name', 'LIKE', '%'.$search.'%');
                });

            $recordsTotal = Supplier::query()->whereIn('uuid', $availableShippers)->count();
            $recordsFiltered = (clone $base)->count();

            $rows = (clone $base)
                ->withShippers()
                ->orderBy($order, $dir)
                ->forPage($page, $length)
                ->get();

            $factory = new ShipperFactory;
            $shippers = $rows->map(static fn ($item) => $factory->makeShipper($item))->all();

            return new ShipperPaginationDTO($shippers, $recordsTotal, $recordsFiltered);
        }

        $items = Supplier::whereIn('uuid', $availableShippers)
            ->withShippers()
            ->when($sdt->search, function ($query, $search) {
                $query->where('suppliers.name', 'LIKE', '%'.$search.'%');
            })
            ->when($searchBuilder, function ($query, $search) {

                $criteria = $search['criteria'];

                if ($search['logic'] === 'AND') {
                    foreach ($criteria as $value) {
                        if ($value['condition'] === 'between') {
                            $query->whereBetween($value['origData'], $value['value']);
                        } elseif ($value['condition'] === 'starts') {
                            $query->havingRaw($value['origData'].' LIKE ?', [$value['value1'].'%']);
                        } else {
                            $query->where($value['origData'], $value['condition'], $value['value1']);
                        }
                    }
                } else {
                    //
                }
            })
            ->orderBy($order, $dir)
            ->paginate($length, ['*'], 'page', $page);

        $factory = new ShipperFactory;

        $shippers = $items->map(function ($item) use ($factory) {
            return $factory->makeShipper($item);
        })->all();

        $t = $items->total();

        return new ShipperPaginationDTO($shippers, $t, $t);
    }

    /**
     * @param int $supplier_id
     * @return Shipper
     */
    public function getShipperById(int $supplier_id): Shipper
    {
        $supplier = Supplier::withShippers()->find($supplier_id);

        return (new ShipperFactory)->makeShipper($supplier);
    }

    public function updateShipper(ShipperRequestDTO $shipperRequestDTO): Shipper
    {
        $supplier = Supplier::with('shipper')->find($shipperRequestDTO->id);

        if ($supplier) {

            $shipper = $supplier->shipper()->updateOrCreate(['supplier_id' => $shipperRequestDTO->id], [
                'filter_id' => $shipperRequestDTO->filter_id,
                'name' => $shipperRequestDTO->name,
                'email' => $shipperRequestDTO->email,
                'plan_fix_email' => $shipperRequestDTO->plan_fix_email,
                'plan_fix_link' => $shipperRequestDTO->plan_fix_link,
                'comment' => $shipperRequestDTO->comment,
                'min_sum' => $shipperRequestDTO->min_sum,
                'fill_storage' => $shipperRequestDTO->fill_storage
            ]);

            $shipper->users()->sync($shipperRequestDTO->users);

            $shipper->stores()->sync($shipperRequestDTO->storages);

            $supplier->refresh();
        }

        return (new ShipperFactory)->makeShipper($supplier);
    }

    private function getColumnByIndex(array $columns, int $id): ?string
    {
        return $columns[$id]['data'] ?? 'id';
    }
}
