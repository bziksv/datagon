<?php

namespace App\Services;

use Illuminate\Http\Request;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\Cache;

/**
 * Единая обёртка кеширования выдачи (JSON/DataTables): ключ = сегмент + ревизия группы + хэш запроса.
 * Сброс группы — bumpRevision(), без перебора ключей (совместимо с file/redis).
 */
final class DataOutputCache
{
    /** Товары, остатки, резервы, транзиты — общая ревизия для products.json и suppliers json. */
    public const REVISION_INVENTORY = 'inventory';

    public const SEGMENT_PRODUCTS_DATATABLE = 'products.dt';

    /** Server-side DataTables: «Товары по упущ.выгоде New». */
    public const SEGMENT_OUT_OF_STOCK_NEW_DATATABLE = 'products.out_of_stock_new.dt';

    public const SEGMENT_SUPPLIERS_DATATABLE = 'suppliers.dt';

    public const REVISION_EMPLOYEES = 'employees';

    public const SEGMENT_EMPLOYEES_JSON = 'employees.json';

    public const REVISION_SHIPPERS = 'shippers';

    public const SEGMENT_SHIPPERS_DATATABLE = 'shippers.dt';

    public const REVISION_USERS = 'users';

    public const SEGMENT_USERS_DATATABLE = 'users.dt';

    /** Server-side DataTables: сотрудники New. */
    public const SEGMENT_EMPLOYEES_DATATABLE = 'employees.dt';

    /** Подсказки / описания по ключу (descriptions/json/...). */
    public const REVISION_DESCRIPTIONS = 'descriptions';

    public const SEGMENT_DESCRIPTIONS_BY_KEY = 'descriptions.by_key';

    /** Сумма цен на дашборде по имени прайса. */
    public const SEGMENT_DASHBOARD_PRICE_SUM = 'dashboard.price_sum';

    /** Сводка виджетов на странице /dashboard (счётчики, суммы, график). */
    public const REVISION_DASHBOARD_SUMMARY = 'dashboard.summary';

    public const SEGMENT_DASHBOARD_INDEX_STATS = 'dashboard.index_stats';

    /** GET /filters — payload активного фильтра пользователя. */
    public const SEGMENT_FILTERS_INDEX = 'filters.index';

    private const REV_PREFIX = 'lagerplus:docache:rev:';

    private const DATA_PREFIX = 'lagerplus:docache:data:';

    public static function enabled(): bool
    {
        return (bool) config('lagerplus.data_output_cache.enabled', true);
    }

    public static function ttlSeconds(): int
    {
        return max(1, (int) config('lagerplus.data_output_cache.ttl_seconds', 60));
    }

    /**
     * TTL записи кеша для сегмента: при настроенном override — он, иначе {@see ttlSeconds()}.
     */
    public static function ttlSecondsForSegment(string $cacheSegment): int
    {
        if ($cacheSegment === self::SEGMENT_OUT_OF_STOCK_NEW_DATATABLE) {
            $custom = config('lagerplus.data_output_cache.ttl_out_of_stock_new_seconds');
            if (is_int($custom) && $custom >= 1) {
                return $custom;
            }
        }

        return self::ttlSeconds();
    }

    public static function storeName(): string
    {
        $s = config('lagerplus.data_output_cache.store');
        if ($s !== null && $s !== '') {
            return (string) $s;
        }

        return (string) config('cache.default', 'file');
    }

    public static function bumpRevision(string $revisionDomain): void
    {
        $store = Cache::store(self::storeName());
        $key = self::REV_PREFIX.$revisionDomain;
        $v = (int) $store->get($key, 0);
        $store->forever($key, $v + 1);
    }

    public static function currentRevision(string $revisionDomain): int
    {
        return (int) Cache::store(self::storeName())->get(self::REV_PREFIX.$revisionDomain, 0);
    }

    /**
     * @template T
     *
     * @param  callable(): T  $callback
     * @return T
     */
    public static function remember(
        string $revisionDomain,
        string $cacheSegment,
        array $identityPayload,
        ?int $ttlSeconds,
        callable $callback
    ): mixed {
        if (! self::enabled()) {
            return $callback();
        }

        $ttl = $ttlSeconds ?? self::ttlSeconds();
        $rev = self::currentRevision($revisionDomain);
        $normalized = self::normalizeForKey($identityPayload);
        $hash = hash('sha256', json_encode($normalized, JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE));
        $key = self::DATA_PREFIX.$cacheSegment.':r'.$rev.':'.$hash;

        return Cache::store(self::storeName())->remember($key, $ttl, $callback);
    }

    /**
     * Убрать из запроса поля, не влияющие на выборку, и при необходимости добавить пользователя для разделения кеша.
     *
     * @param  array<string, mixed>  $request
     * @param  bool  $withAuthenticatedUserPartition  для общих read-only выборок (например «упущ. выгода New») передайте false — один кеш на всех и возможность прогрева из консоли.
     * @return array<string, mixed>
     */
    public static function identityFromDataTablesRequest(array $request, bool $withAuthenticatedUserPartition = true): array
    {
        unset($request['draw'], $request['_token'], $request['_method'], $request['_']);
        if ($withAuthenticatedUserPartition && Auth::check()) {
            $request['_uid'] = Auth::id();
        }

        return self::normalizeForKey($request);
    }

    /**
     * Ключ кеша для JSON «упущ. выгода New»: только параметры, влияющие на выборку (без columns/draw и без пользователя).
     */
    public static function identityFromOutOfStockNewDataTablesRequest(Request $request): array
    {
        $allowedFilters = ['zero', 'zero_no_transits', 'multiplicity', 'incomplete_pack'];
        $rawFilter = $request->input('filter');
        $filter = (is_string($rawFilter) && in_array($rawFilter, $allowedFilters, true)) ? $rawFilter : '';

        $length = (int) $request->input('length', 50);
        if ($length <= 0 || $length > 500) {
            $length = 50;
        }

        $payload = [
            'filter' => $filter,
            'start' => max(0, (int) $request->input('start', 0)),
            'length' => $length,
            'order_col' => (int) data_get($request->all(), 'order.0.column', 1),
            'order_dir' => strtolower((string) data_get($request->all(), 'order.0.dir', 'asc')) === 'desc' ? 'desc' : 'asc',
            'search' => trim((string) data_get($request->all(), 'search.value', '')),
        ];

        return self::normalizeForKey($payload);
    }

    /**
     * Ключ кеша для GET /suppliers/json (без полного columns[] — только поиск по колонкам и фильтры складов).
     */
    public static function identityFromSuppliersPurchaseJsonRequest(Request $request): array
    {
        $stores = $request->input('stores', []);
        if (! is_array($stores)) {
            $stores = [];
        }
        $stores = array_values(array_unique(array_map('strval', $stores)));
        sort($stores, SORT_STRING);

        $length = (int) $request->input('length', 50);
        if ($length <= 0 || $length > 500) {
            $length = 50;
        }

        $columns = $request->input('columns', []);
        $colSearch = [];
        if (is_array($columns)) {
            foreach ($columns as $i => $col) {
                if (! is_array($col)) {
                    continue;
                }
                $colSearch[(string) $i] = trim((string) data_get($col, 'search.value', ''));
            }
        }

        $payload = [
            'stores' => $stores,
            'toBuy' => (string) $request->input('toBuy', ''),
            'fbo' => (string) $request->input('fbo', ''),
            'start' => max(0, (int) $request->input('start', 0)),
            'length' => $length,
            'order_col' => (int) data_get($request->all(), 'order.0.column', 0),
            'order_dir' => strtolower((string) data_get($request->all(), 'order.0.dir', 'asc')) === 'desc' ? 'desc' : 'asc',
            'search' => trim((string) data_get($request->all(), 'search.value', '')),
            'col_search' => self::normalizeForKey($colSearch),
        ];

        return self::normalizeForKey($payload);
    }

    /**
     * Ключ кеша для GET /shipper/json (без лишнего шума от DataTables).
     */
    public static function identityFromShipperDataTablesRequest(Request $request): array
    {
        $length = (int) $request->input('length', 30);
        if ($length <= 0 || $length > 500) {
            $length = 30;
        }

        $columns = $request->input('columns', []);
        $colSearch = [];
        if (is_array($columns)) {
            foreach ($columns as $i => $col) {
                if (! is_array($col)) {
                    continue;
                }
                $colSearch[(string) $i] = trim((string) data_get($col, 'search.value', ''));
            }
        }

        $payload = [
            'start' => max(0, (int) $request->input('start', 0)),
            'length' => $length,
            'order_col' => $request->input('order.0.column', 0),
            'order_dir' => strtolower((string) $request->input('order.0.dir', 'asc')) === 'desc' ? 'desc' : 'asc',
            'search' => trim((string) $request->input('search.value', '')),
            'col_search' => self::normalizeForKey($colSearch),
            'search_builder' => $request->input('searchBuilder'),
        ];

        return self::normalizeForKey($payload);
    }

    /**
     * Ключ кеша для GET /users/json (список пользователей New).
     */
    public static function identityFromUsersDataTablesRequest(Request $request): array
    {
        $length = (int) $request->input('length', 50);
        if ($length <= 0 || $length > 500) {
            $length = 50;
        }

        $payload = [
            'archived' => $request->boolean('archived') ? 1 : 0,
            'start' => max(0, (int) $request->input('start', 0)),
            'length' => $length,
            'order_col' => (int) data_get($request->all(), 'order.0.column', 0),
            'order_dir' => strtolower((string) data_get($request->all(), 'order.0.dir', 'asc')) === 'desc' ? 'desc' : 'asc',
            'search' => trim((string) data_get($request->all(), 'search.value', '')),
        ];

        return self::normalizeForKey($payload);
    }

    /**
     * Ключ кеша для GET /employee/datatable-json.
     */
    public static function identityFromEmployeeDataTablesRequest(Request $request): array
    {
        $length = (int) $request->input('length', 50);
        if ($length <= 0 || $length > 500) {
            $length = 50;
        }

        $payload = [
            'archived' => $request->boolean('archived') ? 1 : 0,
            'start' => max(0, (int) $request->input('start', 0)),
            'length' => $length,
            'order_col' => (int) data_get($request->all(), 'order.0.column', 1),
            'order_dir' => strtolower((string) data_get($request->all(), 'order.0.dir', 'asc')) === 'desc' ? 'desc' : 'asc',
            'search' => trim((string) data_get($request->all(), 'search.value', '')),
        ];

        return self::normalizeForKey($payload);
    }

    /**
     * @param  array<string|int, mixed>  $data
     * @return array<string|int, mixed>
     */
    public static function normalizeForKey(array $data): array
    {
        ksort($data, SORT_STRING);
        $out = [];
        foreach ($data as $k => $v) {
            $out[$k] = is_array($v) ? self::normalizeForKey($v) : $v;
        }

        return $out;
    }

    /**
     * @param  array<string, mixed>  $payload
     * @return array<string, mixed>
     */
    public static function withDraw(array $payload, int $draw): array
    {
        $payload['draw'] = $draw;

        return $payload;
    }

    /** Ревизия кеша фильтров конкретного пользователя (см. Filter / FiltersController). */
    public static function revisionDomainUserFilters(int $userId): string
    {
        return 'filters.u'.$userId;
    }
}
