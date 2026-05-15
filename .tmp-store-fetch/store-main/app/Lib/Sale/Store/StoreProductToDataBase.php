<?php


namespace App\Lib\Sale\Store;

use App\Models\Price;
use App\Models\Setting;
use Illuminate\Database\Eloquent\Model;

class StoreProductToDataBase extends StoreToDataBase
{
    protected function prepareProduct(array $product): array
    {
        $product['uuid'] = $product['id'];

        foreach (['owner', 'uom', 'group', 'productFolder', 'supplier', 'country'] as $key)
            if(isset($product[$key]))
                $product[$key] = $this->getIdFromMeta($product[$key]);

        $product['minPrice'] = $this->pennyToRuble($product['minPrice']['value']);
        $product['salePrices'] = (isset($product['salePrices'][0])) ? $this->pennyToRuble($product['salePrices'][0]['value']) : 0.0;
        $product['buyPrice'] = $this->pennyToRuble($product['buyPrice']['value']);

        // Извлекаем атрибуты в отдельные колонки для быстрой фильтрации
        $attributes = collect($product['attributes'] ?? []);

        $warehouse_item_param = Setting::where('key', 'warehouse_item_param')->value('value') ?? 'Складская позиция';

        $warehouseItem = $attributes->firstWhere('name', $warehouse_item_param);
        $product['is_warehouse_item'] = $warehouseItem['value'] ?? false;

        $discontinued = $attributes->firstWhere('name', 'Перестали сотрудничать / Не производится (дет.в комментах)');
        $product['is_discontinued'] = $discontinued['value'] ?? false;

        $packQuantityAttr = $attributes->firstWhere('name', 'Значение кол-ва в упаковке для товаров которые принимают поштучно');
        $product['pack_quantity'] = isset($packQuantityAttr['value']) ? (int)$packQuantityAttr['value'] : null;

        return $product;
    }

    protected function externalCode(array $item): array
    {
        return ['externalCode' => $item['externalCode']];
    }

    protected function saveResult(Model $model, array $item): void
    {
        $price = new Price();

        $price->where('product_id', $model['id'])->delete();

        foreach ($item['salePrices'] as $p)
        {
            $price->create([
                'uuid' => $p['priceType']['id'],
                'product_id' => $model['id'],
                'name' => $p['priceType']['name'],
                'value' => $this->pennyToRuble($p['value']),
            ]);
        }
    }
}
