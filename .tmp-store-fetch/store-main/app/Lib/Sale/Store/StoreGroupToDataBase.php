<?php


namespace App\Lib\Sale\Store;


use Illuminate\Database\Eloquent\Model;

class StoreGroupToDataBase extends StoreToDataBase
{
    protected function prepareProduct(array $item): array
    {
        $item['uuid'] = $item['id'];

        return $item;
    }

    protected function externalCode(array $item): array
    {
        return ['uuid' => $item['id']];
    }

    protected function saveResult(Model $model, array $item): void
    {
        // TODO: Implement saveResult() method.
    }
}
