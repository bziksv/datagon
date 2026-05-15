<?php

use App\Models\Products;
use App\Models\Setting;
use Illuminate\Support\Arr;
use Illuminate\Support\Facades\DB;

if (! function_exists('money')) {
    function money(float $amount): string
    {
        return number_format($amount, 2, '.', ' ');
    }
}

if (! function_exists('amount')) {
    function amount(int $amount): string
    {
        return number_format($amount, 0, '.', ' ');
    }
}

if (! function_exists('convertBoolToStrings')) {
    function convertBoolToStrings(array $data): array
    {
        array_walk_recursive($data, function (&$value) {
            if (is_bool($value)) {
                $value = $value ? 'true' : 'false';
            }
        });

        return $data;
    }
}

if (! function_exists('stockZerosAll')) {
    /**
     * Счётчики записей stock_totals по окнам в днях — один запрос вместо нескольких COUNT.
     * Периоды: {@see Products::STOCK_ZERO_WINDOW_DAYS}; индекс таблицы: assortmentId + created_at.
     *
     * @return array<int, array{count: int, dateFrom: string}>
     */
    function stockZerosAll(Products $product): array
    {
        $periods = Products::STOCK_ZERO_WINDOW_DAYS;
        $now = \Carbon\Carbon::now();
        $parts = [];
        $bindings = [];
        foreach ($periods as $d) {
            $carbon = $now->copy()->subDays($d);
            $parts[] = 'SUM(CASE WHEN created_at > ? THEN 1 ELSE 0 END) AS cnt_'.$d;
            $bindings[] = $carbon->format('Y-m-d H:i:s');
        }
        $bindings[] = $product->uuid;
        $sql = 'SELECT '.implode(', ', $parts).' FROM stock_totals WHERE assortmentId = ?';
        $row = DB::selectOne($sql, $bindings);

        $out = [];
        foreach ($periods as $d) {
            $carbon = $now->copy()->subDays($d);
            $key = 'cnt_'.$d;
            $out[$d] = [
                'count' => (int) ($row->{$key} ?? 0),
                'dateFrom' => $carbon->format('d.m.Y H:i:s'),
            ];
        }

        return $out;
    }
}

if (! function_exists('checkMeasureAttr')) {
    function checkMeasureAttr(array $attributes, ?string $measureItemParam = null): bool
    {
        if ($measureItemParam === null) {
            $measureItemParam = Setting::query()->where('key', 'measure_item_param')->value('value');
        }

        if (Arr::first($attributes, fn ($value) => $value['name'] == $measureItemParam)) {
            return true;
        }

        return false;
    }
}
