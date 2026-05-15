<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Support\Facades\Cache;

class Setting extends Model
{
    protected $guarded = [];

    use HasFactory;

    /**
     * Единый кэш UI-настроек из таблицы settings: один SELECT + Cache::remember.
     * Сброс: forgetLayoutViewCache() при сохранении настроек и после пересчёта вычисляемых полей (computed_at).
     */
    public const LAYOUT_VIEW_CACHE_KEY = 'settings.layout_view';

    /**
     * TTL кеша бандла (секунды), хранится в settings; env — запасной вариант, если строки нет.
     */
    public const LAYOUT_VIEW_CACHE_TTL_KEY = 'layout_view_cache_ttl';

    /**
     * Ключи в одном бандле для AppLayout (шапка, подвал, дата последнего пересчёта полей поставщиков).
     */
    public const LAYOUT_VIEW_KEYS = [
        'site_title',
        'site_name',
        'footer_phone',
        'footer_telegram',
        'show_footer_phone',
        'show_footer_telegram',
        'computed_at',
    ];

    public function scopeToken(Builder $query): void
    {
        $query->where('key', 'token');
    }

    public static function forgetLayoutViewCache(): void
    {
        Cache::forget(self::LAYOUT_VIEW_CACHE_KEY);
    }

    /**
     * Один запрос к БД при промахе кеша; TTL берётся из той же выборки или из config/env.
     *
     * @return array<string, string|null>
     */
    public static function cachedForLayoutView(): array
    {
        $hit = Cache::get(self::LAYOUT_VIEW_CACHE_KEY);
        if (is_array($hit)) {
            return $hit;
        }

        $loadKeys = array_merge(self::LAYOUT_VIEW_KEYS, [self::LAYOUT_VIEW_CACHE_TTL_KEY]);
        $rows = self::query()
            ->whereIn('key', $loadKeys)
            ->pluck('value', 'key')
            ->all();

        $rawTtl = $rows[self::LAYOUT_VIEW_CACHE_TTL_KEY] ?? null;
        $ttl = ($rawTtl !== null && $rawTtl !== '')
            ? max(10, (int) $rawTtl)
            : max(10, (int) config('lagerplus.settings_layout_cache_ttl', 120));

        $data = [];
        foreach (self::LAYOUT_VIEW_KEYS as $key) {
            $data[$key] = $rows[$key] ?? null;
        }

        Cache::put(self::LAYOUT_VIEW_CACHE_KEY, $data, $ttl);

        return $data;
    }

    /**
     * Без кэша: один SELECT по списку ключей (для форм, CLI и т.д.).
     *
     * @param  array<int, string>  $keys
     * @return array<string, string|null>
     */
    public static function valuesByKeys(array $keys): array
    {
        if ($keys === []) {
            return [];
        }

        return self::query()
            ->whereIn('key', $keys)
            ->pluck('value', 'key')
            ->all();
    }
}
