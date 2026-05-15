<?php


namespace App\Lib\Sale\Store;


use Illuminate\Database\Eloquent\Model;

class StoreReserveToDataBase extends StoreToDataBase
{

    protected function prepareProduct(array $item): array
    {
        $item['quantity'] = $item['reserve'];

        return $item;
    }

    protected function externalCode(array $item): array
    {
        return ['assortmentId' => $item['assortmentId'], 'storeId' => $item['storeId']];
    }

    protected function saveResult(Model $model, array $item): void
    {
        // TODO: Implement saveResult() method.
    }
}
