<?php

return [

    /*
    |--------------------------------------------------------------------------
    | Кэш UI-бандла settings (AppLayout)
    |--------------------------------------------------------------------------
    |
    | Один ключ кэша: site_title, подвал, computed_at и др. (см. Setting::LAYOUT_VIEW_KEYS).
    | Сброс: SettingController при изменении этих ключей, CalculateFieldsAction после пересчёта.
    | TTL по умолчанию, если в БД нет ключа layout_view_cache_ttl (задаётся в разделе Настройки).
    |
    */

    'settings_layout_cache_ttl' => (int) env('SETTINGS_LAYOUT_CACHE_TTL', 120),

    /*
    |--------------------------------------------------------------------------
    | Кэш выдачи данных (DataTables / JSON)
    |--------------------------------------------------------------------------
    |
    | Единый слой: App\Services\DataOutputCache. Ревизия группы сбрасывается
    | при изменении связанных моделей (см. AppServiceProvider).
    |
    */

    'data_output_cache' => [
        'enabled' => filter_var(env('DATA_OUTPUT_CACHE_ENABLED', true), FILTER_VALIDATE_BOOLEAN, FILTER_NULL_ON_FAILURE) ?? true,
        'ttl_seconds' => max(1, (int) env('DATA_OUTPUT_CACHE_TTL', 300)),
        /** Отдельный TTL (сек) для JSON «упущ. выгода New»; не задан — как ttl_seconds. Рекомендация: 1800 при ночном обновлении данных. */
        'ttl_out_of_stock_new_seconds' => filter_var(
            env('DATA_OUTPUT_CACHE_TTL_OUT_OF_STOCK_NEW'),
            FILTER_VALIDATE_INT,
            ['options' => ['min_range' => 1]]
        ) ?: null,
        'store' => env('DATA_OUTPUT_CACHE_STORE'),
    ],

    /*
    |--------------------------------------------------------------------------
    | Страница «Товары по упущ. выгоде» (out-of-stock)
    |--------------------------------------------------------------------------
    |
    | Большая выборка + предрасчёт формулы на каждую строку: при необходимости
    | поднимите лимит (например 512M). Пустая строка — не менять php.ini.
    |
    */

    'out_of_stock_memory_limit' => env('OUT_OF_STOCK_MEMORY_LIMIT', '512M'),

    /*
    |--------------------------------------------------------------------------
    | Лимит времени PHP для страницы out-of-stock (секунды)
    |--------------------------------------------------------------------------
    |
    | 0 — не менять max_execution_time. Положительное значение — @set_time_limit
    | перед тяжёлой выборкой (на случай медленной БД без возможности оптимизировать).
    |
    */

    'out_of_stock_max_execution_time' => (int) env('OUT_OF_STOCK_MAX_EXECUTION_TIME', 120),

    /*
    |--------------------------------------------------------------------------
    | Фоновый прогрев кеша JSON «упущ. выгода New»
    |--------------------------------------------------------------------------
    |
    | Команда: php artisan lagerplus:warm-out-of-stock-new-datatable
    | Расписание: app/Console/Kernel.php (по умолчанию раз в час, без наложения).
    |
    */

    'out_of_stock_new_cache_warm' => [
        'enabled' => filter_var(env('OUT_OF_STOCK_NEW_CACHE_WARM_ENABLED', true), FILTER_VALIDATE_BOOLEAN, FILTER_NULL_ON_FAILURE) ?? true,
    ],

];
