<?php

namespace App\Http\Controllers;

use App\Actions\CalculateFieldsAction;
use App\DTO\ShipperDataTableDTO;
use App\DTO\ShipperRequestDTO;
use App\Models\Filter;
use App\Models\Shipper;
use App\Models\Store;
use App\Models\User;
use App\Presenters\ShipperDataTablePresenter;
use App\Services\DataOutputCache;
use App\Services\ShipperService;
use Illuminate\Http\RedirectResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\View\View;

class ShipperController extends Controller
{
    public function index(): View
    {
        $calculate = new CalculateFieldsAction();

        return view('shippers.index', ['computedAt' => $calculate->computedAt()]);
    }

    public function listV2(): View
    {
        $calculate = new CalculateFieldsAction();

        return view('shippers.index-v2', ['computedAt' => $calculate->computedAt()]);
    }

    public function json(Request $request, ShipperService $service): \Illuminate\Http\JsonResponse
    {
        $draw = (int) $request->input('draw', 0);

        if (! DataOutputCache::enabled()) {
            $sdt = ShipperDataTableDTO::fromRequest($request);
            $shippers = $service->getAvailableWithProducts($sdt);
            $json = (new ShipperDataTablePresenter)->present($shippers);

            return response()->json(DataOutputCache::withDraw(
                json_decode($json, true) ?: [],
                $draw
            ));
        }

        $identity = DataOutputCache::identityFromShipperDataTablesRequest($request);
        $payload = DataOutputCache::remember(
            DataOutputCache::REVISION_SHIPPERS,
            DataOutputCache::SEGMENT_SHIPPERS_DATATABLE,
            $identity,
            null,
            function () use ($request, $service) {
                $sdt = ShipperDataTableDTO::fromRequest($request);
                $shippers = $service->getAvailableWithProducts($sdt);
                $json = (new ShipperDataTablePresenter)->present($shippers);
                $decoded = json_decode($json, true);
                if (! is_array($decoded)) {
                    return [
                        'recordsTotal' => 0,
                        'recordsFiltered' => 0,
                        'data' => [],
                        'error' => __('Ошибка загрузки таблицы.'),
                    ];
                }
                unset($decoded['draw']);

                return $decoded;
            }
        );

        if (! is_array($payload)) {
            $payload = [
                'recordsTotal' => 0,
                'recordsFiltered' => 0,
                'data' => [],
                'error' => __('Ошибка загрузки таблицы.'),
            ];
        }

        return response()->json(DataOutputCache::withDraw($payload, $draw));
    }

    public function edit($id, ShipperService $service): View
    {
        $shipper = $service->getShipperById($id);

        $users = User::query()
            ->where('is_archived', false)
            ->orderBy('name')
            ->get(['id', 'name']);

        $storages = Store::query()->orderBy('name')->get(['id', 'name']);

        $filters = Filter::query()
            ->select(['id', 'name', 'user_id'])
            ->with(['user' => static function ($query) {
                $query->select(['id', 'name']);
            }])
            ->orderBy('name')
            ->get();

        return view('shippers.edit', compact('shipper', 'users', 'storages', 'id', 'filters'));
    }

    public function update(Request $request, int $id, ShipperService $service): RedirectResponse
    {
        $shipperRequestDTO = ShipperRequestDTO::makeFromRequest($request, $id);

        $shipper = $service->update($shipperRequestDTO);

        return redirect()->route('shipper.index');
    }

    public function bulkUpdate(Request $request, string $field): RedirectResponse
    {
        Shipper::query()->update([$field => $request->input($field, 0)]);
        DataOutputCache::bumpRevision(DataOutputCache::REVISION_SHIPPERS);
        DataOutputCache::bumpRevision(DataOutputCache::REVISION_DASHBOARD_SUMMARY);

        return redirect()->route('shipper.index');
    }

    public function bulkUpdateWarehouse(Request $request): RedirectResponse
    {
        $warehouses = $request->input('warehouses', []);

        DB::transaction(function () use ($warehouses): void {
            Shipper::query()->chunkById(100, function ($shippers) use ($warehouses): void {
                foreach ($shippers as $shipper) {
                    $shipper->stores()->sync($warehouses);
                }
            });
        });
        DataOutputCache::bumpRevision(DataOutputCache::REVISION_SHIPPERS);
        DataOutputCache::bumpRevision(DataOutputCache::REVISION_DASHBOARD_SUMMARY);

        return redirect()->route('shipper.index');
    }
}
