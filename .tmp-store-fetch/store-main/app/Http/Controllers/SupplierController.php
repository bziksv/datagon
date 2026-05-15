<?php

namespace App\Http\Controllers;

use App\DataTables\SuppliersDataTable;
use App\Exports\BuyersExport;
use App\Exports\ExportInterface;
use App\Exports\SuppliersExport;
use App\Helpers\ProductHelper;
use App\Models\Products;
use App\Models\Store;
use App\Services\DataOutputCache;
use App\Services\PackingService;
use Carbon\Carbon;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\Cache;

class SupplierController extends Controller
{
    /** Кеш списка складов для сайдбара «К закупке» (uuid + name). */
    public const STORES_FOR_SUPPLIER_FILTERS_CACHE_KEY = 'layout.stores_for_supplier_filters';

    const SUPPLIER_INDEX = 2;

    protected $excelFileName = null;

    protected $packingService;

    public function __construct(PackingService $packingService)
    {
        $this->packingService = $packingService;
    }

    public function index()
    {
        $store = $this->storesForSupplierFilters();
        $filters = Auth::user()->filters()
            ->select(['id', 'name', 'active'])
            ->orderBy('name')
            ->get();

        return view('suppliers.index', compact('store', 'filters'));
    }

    public function listV2()
    {
        $store = $this->storesForSupplierFilters();
        $filters = Auth::user()->filters()
            ->select(['id', 'name', 'active'])
            ->orderBy('name')
            ->get();

        return view('suppliers.index-v2', compact('store', 'filters'));
    }

    private function storesForSupplierFilters()
    {
        return Cache::remember(self::STORES_FOR_SUPPLIER_FILTERS_CACHE_KEY, 600, function () {
            return Store::query()->orderBy('name')->get(['uuid', 'name']);
        });
    }

    public function json()
    {
        $export = request('exports');
        $stores = request('stores', []);

        $products = (new Products())->suppliersDataTable($stores)->isWarehousePosition();

        $dataTable = new SuppliersDataTable($products);

        if ($export == 'suppliers') {
            return $this->export(new SuppliersExport($dataTable->getCollection()));
        } elseif ($export == 'buyers') {
            return $this->export(new BuyersExport($dataTable->getCollection()));
        }

        if (! DataOutputCache::enabled()) {
            return $this->suppliersDataTableJsonResponse($stores);
        }

        $draw = (int) request('draw', 0);
        $identity = DataOutputCache::identityFromSuppliersPurchaseJsonRequest(request());
        $payload = DataOutputCache::remember(
            DataOutputCache::REVISION_INVENTORY,
            DataOutputCache::SEGMENT_SUPPLIERS_DATATABLE,
            $identity,
            null,
            fn () => $this->suppliersDataTableJsonPayload($stores)
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

    private function suppliersDataTableJsonResponse(array $stores): \Illuminate\Http\JsonResponse
    {
        $payload = $this->suppliersDataTableJsonPayload($stores);
        $draw = (int) request('draw', 0);

        return response()->json(DataOutputCache::withDraw($payload, $draw));
    }

    /**
     * @return array{recordsTotal: int, recordsFiltered: int, data: mixed, error?: string}
     */
    private function suppliersDataTableJsonPayload(array $stores): array
    {
        $products = (new Products())->suppliersDataTable($stores)->isWarehousePosition();
        $dataTable = new SuppliersDataTable($products);

        $fastTotal = Products::query()->where('is_warehouse_item', true)->count();
        $filteredOverride = $this->suppliersJsonHasActiveFilters() ? null : $fastTotal;

        /** @var \Illuminate\Http\JsonResponse $response */
        $response = $dataTable->getJson($fastTotal, $filteredOverride);
        $decoded = json_decode($response->getContent(), true);

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

    private function suppliersJsonHasActiveFilters(): bool
    {
        $search = request('search');
        if (is_array($search) && trim((string) ($search['value'] ?? '')) !== '') {
            return true;
        }
        if (request('toBuy')) {
            return true;
        }
        if (request('fbo')) {
            return true;
        }
        foreach ((array) request('columns', []) as $col) {
            if (! is_array($col)) {
                continue;
            }
            if (trim((string) ($col['search']['value'] ?? '')) !== '') {
                return true;
            }
        }

        return false;
    }

    private function export(ExportInterface $export)
    {
        if ($this->hasSearchableValue(self::SUPPLIER_INDEX)) {
            $name = $export->getCollection()->value('suppliers.name');

            $export->setFileName(implode(' - ', [$name, Carbon::now().SuppliersExport::EXE]));
        }

        foreach ($export->getCollection() as $collect) {
            $size = ProductHelper::getPackSize($collect);

            if ($size > 0 && $collect->uoms->name !== 'уп') {
                $collect->toBuy = $this->packingService->calculatePackedQuantity($collect->toBuy, $size);
            }
        }

        return $export->download();
    }

    private function hasSearchableValue(int $idx): bool
    {
        $columns = request('columns');

        if ($columns[$idx]['search']['value']) {
            return true;
        }

        return false;
    }
}
