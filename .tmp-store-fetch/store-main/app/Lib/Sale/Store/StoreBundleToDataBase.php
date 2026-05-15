<?php

namespace App\Lib\Sale\Store;

use Illuminate\Database\Eloquent\Model;

class StoreBundleToDataBase extends StoreToDataBase
{

    protected function prepareProduct(array $item): array
    {
        $item['uuid'] = $item['id'];

        foreach (['owner', 'group', 'productFolder'] as $key) {
            if(isset($item[$key])) {
                $item[$key] = $this->getIdFromMeta($item[$key]);
            }
        }

        $item['minPrice'] = $this->pennyToRuble($item['minPrice']['value']);
        $item['salePrices'] = (isset($item['salePrices'][0])) ? $this->pennyToRuble($item['salePrices'][0]['value']) : 0.0;

        return $item;
    }

    protected function externalCode(array $item): array
    {
        return ['externalCode' => $item['externalCode']];
    }

    protected function saveResult(Model $model, array $item): void
    {
        // TODO: Implement saveResult() method.
    }
}
