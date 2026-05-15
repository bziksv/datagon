<?php

namespace App\Http\Controllers;

use App\Models\Price;
use App\Services\DataOutputCache;
use App\Services\ProductCountHistoryService;
use App\Services\WarehouseProductsService;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\DB;

class DashboardController extends Controller
{
    /**
     * Display the dashboard.
     */
    public function index(ProductCountHistoryService $productCountHistoryService, WarehouseProductsService $warehouseProductsService)
    {
        $chartDays = 30;

        if (! DataOutputCache::enabled()) {
            $stats = $this->buildDashboardIndexStats($productCountHistoryService, $warehouseProductsService, $chartDays);
        } else {
            $identity = DataOutputCache::normalizeForKey(['chart_days' => $chartDays]);
            $stats = DataOutputCache::remember(
                DataOutputCache::REVISION_DASHBOARD_SUMMARY,
                DataOutputCache::SEGMENT_DASHBOARD_INDEX_STATS,
                $identity,
                null,
                fn () => $this->buildDashboardIndexStats($productCountHistoryService, $warehouseProductsService, $chartDays)
            );
            if (! is_array($stats)) {
                $stats = $this->buildDashboardIndexStats($productCountHistoryService, $warehouseProductsService, $chartDays);
            }
        }

        return view('dashboard', $stats);
    }

    /**
     * @return array<string, mixed>
     */
    private function buildDashboardIndexStats(
        ProductCountHistoryService $productCountHistoryService,
        WarehouseProductsService $warehouseProductsService,
        int $chartDays
    ): array {
        $counts = $this->dashboardSummaryCounts();

        $usersCount = $counts['usersCount'];
        $productsCount = $counts['productsCount'];
        $suppliersCount = $counts['suppliersCount'];
        $outOfStockCount = $counts['outOfStockCount'];
        $warehouseProductsCount = $counts['warehouseProductsCount'];
        $totalPurchaseSum = $counts['totalPurchaseSum'];

        $purchasePriceSum = $warehouseProductsService->getTotalPurchasePrice();
        $salePriceSum = $warehouseProductsService->getTotalSalePrice();
        $minPriceSum = $warehouseProductsService->getTotalMinPrice();

        $productDynamicsData = $productCountHistoryService->getChartData($chartDays);

        $priceNames = $this->getPriceNames()->values()->all();

        return compact(
            'usersCount',
            'productsCount',
            'suppliersCount',
            'outOfStockCount',
            'warehouseProductsCount',
            'purchasePriceSum',
            'salePriceSum',
            'minPriceSum',
            'totalPurchaseSum',
            'productDynamicsData',
            'priceNames'
        );
    }

    /**
     * Один round-trip к БД вместо отдельных COUNT/SUM по users, products, suppliers, stocks, shippers.
     *
     * @return array{
     *     usersCount: int,
     *     productsCount: int,
     *     suppliersCount: int,
     *     outOfStockCount: int,
     *     warehouseProductsCount: int,
     *     totalPurchaseSum: float|int
     * }
     */
    private function dashboardSummaryCounts(): array
    {
        $row = DB::selectOne(
            'SELECT
                (SELECT COUNT(*) FROM users WHERE is_archived = 0) AS users_count,
                (SELECT COUNT(*) FROM products) AS products_count,
                (SELECT COUNT(*) FROM suppliers WHERE uuid IN (
                    SELECT supplier FROM products
                    WHERE supplier IS NOT NULL AND is_warehouse_item = 1
                    GROUP BY supplier
                )) AS suppliers_count,
                (SELECT COUNT(*) FROM products p WHERE NOT EXISTS (
                    SELECT 1 FROM stocks s WHERE s.assortmentId = p.uuid
                )) AS out_of_stock_count,
                (SELECT COUNT(*) FROM products p WHERE p.is_warehouse_item = 1 AND EXISTS (
                    SELECT 1 FROM stocks s WHERE s.assortmentId = p.uuid
                )) AS warehouse_products_count,
                (SELECT COALESCE(SUM(calc_purchase_total), 0) FROM shippers) AS total_purchase_sum'
        );

        return [
            'usersCount' => (int) ($row->users_count ?? 0),
            'productsCount' => (int) ($row->products_count ?? 0),
            'suppliersCount' => (int) ($row->suppliers_count ?? 0),
            'outOfStockCount' => (int) ($row->out_of_stock_count ?? 0),
            'warehouseProductsCount' => (int) ($row->warehouse_products_count ?? 0),
            'totalPurchaseSum' => (float) ($row->total_purchase_sum ?? 0),
        ];
    }

    /**
     * Get all available price names
     */
    private function getPriceNames()
    {
        return Price::select('name')
            ->distinct()
            ->orderBy('name')
            ->pluck('name');
    }

    /**
     * Get sum of prices by name for AJAX requests
     */
    public function getPriceSumByName(Request $request, WarehouseProductsService $warehouseProductsService): JsonResponse
    {
        $priceName = (string) $request->input('price_name', '');

        if ($priceName === '') {
            return response()->json(['error' => 'Price name is required'], 422);
        }

        if (! DataOutputCache::enabled()) {
            return response()->json($this->buildPriceSumPayload($warehouseProductsService, $priceName));
        }

        $identity = DataOutputCache::normalizeForKey([
            'price_name' => $priceName,
            '_uid' => Auth::id(),
        ]);
        $payload = DataOutputCache::remember(
            DataOutputCache::REVISION_INVENTORY,
            DataOutputCache::SEGMENT_DASHBOARD_PRICE_SUM,
            $identity,
            null,
            fn () => $this->buildPriceSumPayload($warehouseProductsService, $priceName)
        );

        return response()->json(is_array($payload) ? $payload : [
            'sum' => 0,
            'formatted_sum' => money(0),
            'price_name' => $priceName,
        ]);
    }

    /**
     * @return array{sum: float|int, formatted_sum: string, price_name: string}
     */
    private function buildPriceSumPayload(WarehouseProductsService $warehouseProductsService, string $priceName): array
    {
        $sum = $warehouseProductsService->getSumPriceByName($priceName);

        return [
            'sum' => $sum,
            'formatted_sum' => money($sum),
            'price_name' => $priceName,
        ];
    }
}
