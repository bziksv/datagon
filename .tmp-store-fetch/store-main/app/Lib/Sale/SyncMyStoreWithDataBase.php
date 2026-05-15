<?php


namespace App\Lib\Sale;

use App\Lib\Moysklad\Receive\MyStoreAttributes;
use App\Lib\Moysklad\Receive\MyStoreBundle;
use App\Lib\Moysklad\Receive\MyStoreCountry;
use App\Lib\Moysklad\Receive\MyStoreEmployee;
use App\Lib\Moysklad\Receive\MyStoreGroup;
use App\Lib\Moysklad\Receive\MyStoreProductFolder;
use \App\Lib\Moysklad\Receive\MyStoreProducts;
use App\Lib\Moysklad\Receive\MyStoreReserve;
use App\Lib\Moysklad\Receive\MyStoreStock;
use App\Lib\Moysklad\Receive\MyStoreStockTotal;
use App\Lib\Moysklad\Receive\MyStoreStore;
use App\Lib\Moysklad\Receive\MyStoreSupplier;
use App\Lib\Moysklad\Receive\MyStoreTransit;
use App\Lib\Moysklad\Receive\MyStoreUom;
use App\Lib\Sale\Store\StoreAttributesToDataBase;
use App\Lib\Sale\Store\StoreCountryToDataBase;
use App\Lib\Sale\Store\StoreGroupToDataBase;
use App\Lib\Sale\Store\StoreEmployeeToDataBase;
use App\Lib\Sale\Store\StoreReserveToDataBase;
use App\Lib\Sale\Store\StoreStockToDataBase;
use App\Lib\Sale\Store\StoreStoreToDataBase;
use App\Lib\Sale\Store\StoreTransitToDataBase;
use App\Lib\Sale\Store\StoreUomToDataBase;
use App\Models\Attribute;
use App\Models\Country;
use App\Models\Employee;
use App\Models\Group;
use App\Models\Products;
use App\Models\Reserve;
use App\Models\Sell;
use App\Models\Setting;
use App\Models\Stock;
use App\Models\Store;
use App\Models\Transit;
use App\Models\Uom;
use App\Models\StockTotal;
use Carbon\Carbon;

class SyncMyStoreWithDataBase
{
    public function syncAll()
    {
        $this->bundleSync();
        $this->productSync();
        $this->employeeSync();
        $this->supplierSync();
        $this->groupSync();
        $this->productFolderSync();
        $this->uomSync();
        $this->countrySync();
        $this->attributeSync();
        $this->stockSync();
        $this->reserveSync();
        $this->transitSync();
        $this->storeSync();
        $this->saveSales();
    }

    public function employeeSync()
    {
        $employee = (new MyStoreEmployee())->getRows();

        (new StoreEmployeeToDataBase(new Employee()))
            ->updateOrCreate($employee);

        $apiExternalCodes = array_column($employee, 'externalCode');

        Employee::whereNotIn('externalCode', $apiExternalCodes)
            ->update(['archived' => true]);
    }

    public function productSync()
    {
        (new MyStoreProducts())->event();
    }

    public function supplierSync()
    {
        (new MyStoreSupplier())->event();
    }

    public function productFolderSync()
    {
        (new MyStoreProductFolder())->event();
    }

    public function groupSync()
    {
        $group = (new MyStoreGroup())->getRows();

        (new StoreGroupToDataBase(new Group()))
            ->updateOrCreate($group);
    }

    public function stockSync()
    {
        $model = new Stock();

        $stocks = (new MyStoreStock())->getRows();

        if (empty($stocks)) {
            return;
        }

        $model->truncate();

        (new StoreStockToDataBase($model))->create($stocks);

        // получаем товары с нулевым остатком из МС, пишем в БД
        if ((new StockTotal())->whereDate('created_at', Carbon::now())->doesntExist()) {
            foreach ((new MyStoreStockTotal())->getRows() as $item) {
                if ($item['stock'] === 0) {
                    (new StockTotal())->create($item);
                }
            }
        }

        // собираем остатки в один товар
        $product_stocks = [];
        foreach ($stocks as $stock) {
            if (isset($product_stocks[$stock['assortmentId']])) {
                $product_stocks[$stock['assortmentId']] += $stock['stock'];
            } else {
                $product_stocks[$stock['assortmentId']] = $stock['stock'];
            }
        }

        // получаем значение настройки
        $incompletePackPercent = intval(Setting::query()->where('key', 'incompletePackPercent')->value('value') ?? 0);
        foreach ($product_stocks as $uuid => $stock) {

            $stocks_sum_quantity = intval($stock);
            $multiplicityProduct = intval(Products::where('uuid', $uuid)->value('multiplicityProduct'));

            if ($multiplicityProduct > 0) {
                $pack_percentage = min(100, ($stocks_sum_quantity / $multiplicityProduct) * 100);

                if ($pack_percentage <= $incompletePackPercent) {
                    if ((new StockTotal())->where('assortmentId', $uuid)->whereDate('created_at', Carbon::now())->doesntExist()) {
                        (new StockTotal())->create(['assortmentId' => $uuid, 'stock' => 0]);
                    }
                }
            }
        }
    }

    public function reserveSync()
    {
        $model = new Reserve();

        $reserve = (new MyStoreReserve())->getRows();

        if (empty($reserve)) {
            return;
        }

        $model->truncate();

        (new StoreReserveToDataBase($model))->create($reserve);
    }

    public function transitSync()
    {
        $model = new Transit();

        $transit = (new MyStoreTransit())->getRows();

        if (empty($transit)) {
            return;
        }

        $model->truncate();

        (new StoreTransitToDataBase($model))->create($transit);
    }

    public function storeSync()
    {
        $store = (new MyStoreStore())->getRows();
        (new StoreStoreToDataBase(new Store()))->updateOrCreate($store);
    }

    public function uomSync()
    {
        $uom = (new MyStoreUom())->getRows();

        (new StoreUomToDataBase(new Uom()))->updateOrCreate($uom);
    }

    public function countrySync()
    {
        $country = (new MyStoreCountry())->getRows();

        (new StoreCountryToDataBase(new Country()))->updateOrCreate($country);
    }

    public function attributeSync()
    {
        $attribute = (new MyStoreAttributes())->getRows();

        (new StoreAttributesToDataBase(new Attribute()))->updateOrCreate($attribute);
    }

    public function bundleSync()
    {
        (new MyStoreBundle())->event();
    }

    public function saveSales(): void
    {
        $latest = Sell::query()->latest()->first();

        $diffDay = 15;

        if ($latest == null || $latest->created_at->diffInDays() >= $diffDay) {

            $products = Products::getOutOfStock();

            foreach ($products as $product) {
                \App\Jobs\SaveSales::dispatch($product, $diffDay);
            }
        }
    }
}
