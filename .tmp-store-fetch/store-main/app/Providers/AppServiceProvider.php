<?php

namespace App\Providers;

use App\Domain\Product\ProductRepository;
use App\Domain\Shipper\ShipperRepository;
use App\Http\Controllers\ProductsController;
use App\Http\Controllers\SupplierController;
use App\Infrastructure\EloquentProductRepository;
use App\Infrastructure\EloquentShipperRepository;
use App\Models\Employee;
use App\Models\Price;
use App\Models\ProductCountHistory;
use App\Models\Products;
use App\Models\Reserve;
use App\Models\Sell;
use App\Models\Shipper;
use App\Models\Stock;
use App\Models\StockTotal;
use App\Models\Store;
use App\Models\Transit;
use App\Models\User;
use App\Services\DataOutputCache;
use App\Services\SidebarMenuRegistry;
use Illuminate\Pagination\Paginator;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Route;
use Illuminate\Support\Facades\View;
use Illuminate\Support\ServiceProvider;

class AppServiceProvider extends ServiceProvider
{
    /**
     * Register any application services.
     */
    public function register(): void
    {
        //
    }

    /**
     * Bootstrap any application services.
     */
    public function boot(): void
    {
        Paginator::useBootstrap();

        $this->app->bind(ProductRepository::class, EloquentProductRepository::class);
        $this->app->bind(ShipperRepository::class, EloquentShipperRepository::class);

        View::composer('*', static function ($view): void {
            static $cachedRoute;
            static $cachedTitle = '';

            $route = Route::currentRouteName();
            if ($route !== $cachedRoute) {
                $cachedRoute = $route;
                $cachedTitle = SidebarMenuRegistry::pageTitleForRoute($route);
            }
            $view->with('pageTitle', $cachedTitle);
        });

        $bumpDashboardSummary = static function (): void {
            DataOutputCache::bumpRevision(DataOutputCache::REVISION_DASHBOARD_SUMMARY);
        };

        $bumpInventory = static function () use ($bumpDashboardSummary): void {
            DataOutputCache::bumpRevision(DataOutputCache::REVISION_INVENTORY);
            DataOutputCache::bumpRevision(DataOutputCache::REVISION_SHIPPERS);
            $bumpDashboardSummary();
        };

        foreach ([Products::class, Stock::class, Reserve::class, Transit::class, Price::class, StockTotal::class, Sell::class] as $model) {
            $model::saved($bumpInventory);
            $model::deleted($bumpInventory);
        }

        Shipper::saved(static function () use ($bumpDashboardSummary): void {
            DataOutputCache::bumpRevision(DataOutputCache::REVISION_SHIPPERS);
            $bumpDashboardSummary();
        });
        Shipper::deleted(static function () use ($bumpDashboardSummary): void {
            DataOutputCache::bumpRevision(DataOutputCache::REVISION_SHIPPERS);
            $bumpDashboardSummary();
        });

        User::saved($bumpDashboardSummary);
        User::deleted($bumpDashboardSummary);

        ProductCountHistory::saved($bumpDashboardSummary);
        ProductCountHistory::deleted($bumpDashboardSummary);

        Employee::saved(static function (): void {
            DataOutputCache::bumpRevision(DataOutputCache::REVISION_EMPLOYEES);
            Cache::forget(ProductsController::EMPLOYEES_FOR_PRODUCT_FILTERS_CACHE_KEY);
        });
        Employee::deleted(static function (): void {
            DataOutputCache::bumpRevision(DataOutputCache::REVISION_EMPLOYEES);
            Cache::forget(ProductsController::EMPLOYEES_FOR_PRODUCT_FILTERS_CACHE_KEY);
        });

        $forgetSupplierStores = static function (): void {
            Cache::forget(SupplierController::STORES_FOR_SUPPLIER_FILTERS_CACHE_KEY);
        };
        Store::saved($forgetSupplierStores);
        Store::deleted($forgetSupplierStores);
    }
}
