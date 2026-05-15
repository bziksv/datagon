<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Support\Facades\Cache;

class Description extends Model
{
    // ...existing code...

    protected $fillable = [
        'key',
        'content',
    ];

    /**
     * Получить содержание по ключу с кэшированием.
     *
     * @param string $key
     * @param mixed $default
     * @param int $seconds
     * @return mixed
     */
    public static function getByKey(string $key, $default = null, int $seconds = 3600)
    {
        $cacheKey = "description:{$key}";

        return Cache::remember($cacheKey, $seconds, function () use ($key, $default) {
            $value = self::where('key', $key)->value('content');
            return $value !== null ? $value : $default;
        });
    }

    /**
     * Очистить кэш для ключа.
     *
     * @param string|null $key
     * @return void
     */
    public static function forgetCache(?string $key = null): void
    {
        if ($key === null) {
            // Можно реализовать очистку всех описаний по шаблону, но Cache::flush() не рекомендуется.
            return;
        }

        Cache::forget("description:{$key}");
    }
}
