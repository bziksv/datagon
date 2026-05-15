<?php


namespace App\Helpers;



class ProductHelper
{
    public static function getPackSize($product): int
    {
        $size = 0;

        $attribute = self::getAttribute($product, 'name', 'Значение кол-ва в упаковке для товаров которые принимают поштучно');

        if ($attribute) {
            $size = $attribute['value'];
        }

        return $size;
    }

    public static function getAttribute($product, string $key, string $value)
    {
        return collect($product->attributes)->firstWhere($key, $value);
    }
}
