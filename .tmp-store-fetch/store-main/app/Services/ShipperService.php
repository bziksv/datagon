<?php

namespace App\Services;

use App\Domain\Product\ProductRepository;
use App\Domain\Shipper\Shipper;
use App\Domain\Shipper\ShipperFacade;
use App\Domain\Shipper\ShipperRepository;
use App\DTO\ShipperDataTableDTO;
use App\DTO\ShipperPaginationDTO;
use App\DTO\ShipperRequestDTO;
use App\Models\Filter;
use Illuminate\Support\Facades\DB;

class ShipperService
{
    private ProductRepository $productRepository;

    private ShipperRepository $shipperRepository;

    public function __construct(ShipperRepository $shipperRepository, ProductRepository $productRepository)
    {
        $this->shipperRepository = $shipperRepository;
        $this->productRepository = $productRepository;
    }

    public function getAvailableWithProducts(ShipperDataTableDTO $sdt): ShipperPaginationDTO
    {
        $dto = $this->shipperRepository->getAvailableShippers($sdt);

        $this->attachUsersAndFiltersToShippers($dto->shippers);

        return $dto;
    }

    /**
     * Вместо N запросов через {@see ShipperFacade::setUsersToShipper()} / {@see ShipperFacade::setFilterToShipper()} на страницу DataTables.
     *
     * @param  list<Shipper>  $shippers
     */
    private function attachUsersAndFiltersToShippers(array $shippers): void
    {
        if ($shippers === []) {
            return;
        }

        $shipperIds = [];
        $filterIds = [];
        foreach ($shippers as $shipper) {
            if ($sid = $shipper->getShipperId()) {
                $shipperIds[] = $sid;
            }
            if ($fid = $shipper->getFilterId()) {
                $filterIds[] = $fid;
            }
        }

        $shipperIds = array_values(array_unique($shipperIds));
        $filterIds = array_values(array_unique($filterIds));

        $usersByShipperId = [];
        if ($shipperIds !== []) {
            $rows = DB::table('shipper_user')
                ->join('users', 'users.id', '=', 'shipper_user.user_id')
                ->whereIn('shipper_user.shipper_id', $shipperIds)
                ->orderBy('users.name')
                ->select(['shipper_user.shipper_id as shipper_id', 'users.name as name'])
                ->get();
            foreach ($rows as $row) {
                $usersByShipperId[$row->shipper_id][] = (object) ['name' => $row->name];
            }
        }

        $filtersById = [];
        if ($filterIds !== []) {
            foreach (Filter::query()
                ->whereIn('id', $filterIds)
                ->select(['id', 'name', 'payload', 'user_id'])
                ->with(['user' => static function ($query) {
                    $query->select(['id', 'name']);
                }])
                ->get() as $filter) {
                $filtersById[$filter->id] = $filter;
            }
        }

        foreach ($shippers as $shipper) {
            $sid = $shipper->getShipperId();
            $shipper->setUsers(($sid && isset($usersByShipperId[$sid])) ? $usersByShipperId[$sid] : []);

            $fid = $shipper->getFilterId();
            $shipper->setFilter(($fid && isset($filtersById[$fid])) ? $filtersById[$fid] : null);
        }
    }

    public function getShipperById(int $id): Shipper
    {
        $shipper = new ShipperFacade($this->shipperRepository->getShipperById($id));

        return $shipper->getShipperWithWarehousesAndUsers();
    }

    public function update(ShipperRequestDTO $shipperRequestDTO): Shipper
    {
        return $this->shipperRepository->updateShipper($shipperRequestDTO);
    }
}
