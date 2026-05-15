<?php


namespace App\Lib\Sale\Store;


use Illuminate\Database\Eloquent\Model;

class StoreStoreToDataBase extends StoreToDataBase
{
    protected function prepareProduct(array $item): array
    {
        $item['uuid'] = $item['id'];

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
