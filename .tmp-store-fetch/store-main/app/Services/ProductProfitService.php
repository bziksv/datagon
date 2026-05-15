<?php

namespace App\Services;

use App\Models\Setting;
use Illuminate\Support\Arr;

class ProductProfitService
{
    public function getProfitByProduct(array $uuids, string $date): array
    {
        if (empty($uuids)) {
            return [];
        }

        $api = new \App\Lib\Moysklad\MojSkladJsonApi;

        $endpoint = 'https://api.moysklad.ru/api/remap/1.2/report/profit/byproduct';

        $filter = array_map(function ($uuid) {
            return "product=https://api.moysklad.ru/api/remap/1.2/entity/product/$uuid";
        }, $uuids);

        $api->send($endpoint, [
            'filter' => implode(';', $filter),
            'momentFrom' => $date,
        ]);

        return $api->getRows();
    }

    public function getTotalSell(string $uuid, string $dateFrom): int
    {
        return $this->productSellQuantity($uuid, $dateFrom) + $this->bundleSellQuantity($uuid, $dateFrom);
    }

    private function bundleSellQuantity(string $uuid, string $dateFrom): int
    {
        $sales = [];

        $bundles = (new BundleService())->getBundleByProduct($uuid);

        $measureItemParam = Setting::query()->where('key', 'measure_item_param')->value('value');

        foreach ($bundles as $bundle) {

            $component = $this->findBundleComponent($uuid, $bundle);

            $quantity = 1;

            if (checkMeasureAttr($component['assortment']['attributes'], $measureItemParam)) {
                $quantity = $component['quantity'];
            }

            if ($profit = $this->getProfitByProduct([$bundle['uuid']], $dateFrom)) {
                $sellQuantity = $profit[0]['sellQuantity'];

                $sales[] = $sellQuantity * $quantity;
            }
        }

        return array_sum($sales);
    }

    private function productSellQuantity(string $uuid, string $dateFrom): int
    {
        return array_sum(Arr::pluck($this->getProfitByProduct([$uuid], $dateFrom), 'sellQuantity'));
    }

    private function findBundleComponent(string $uuid, array $bundle): array
    {
        $components = $bundle['components']['rows'];

        return Arr::first($components, fn ($val) => $val['assortment']['id'] === $uuid);
    }
}
