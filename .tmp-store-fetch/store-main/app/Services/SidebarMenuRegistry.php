<?php

namespace App\Services;

use App\Models\Setting;
use Illuminate\Support\Facades\Route;

final class SidebarMenuRegistry
{
    public const SETTING_KEY = 'sidebar_menu';

    /** @var list<array<string, mixed>>|null Одно построение строк меню за HTTP-запрос (AppLayout + View::composer). */
    private static ?array $rowsForEditorCache = null;

    /** Порядок по умолчанию и допустимые маршруты (имена Laravel route). */
    private const ROUTES_IN_ORDER = [
        'products.index',
        'products.listV2',
        'products.outOfStock',
        'products.outOfStockNew',
        'suppliers.index',
        'suppliers.listV2',
        'shipper.index',
        'shipper.listV2',
        'users.index',
        'users.listV2',
        'employee.index',
        'employee.listV2',
        'setting.index',
    ];

    /**
     * @return list<string>
     */
    public static function allowedRoutes(): array
    {
        return self::ROUTES_IN_ORDER;
    }

    /**
     * Подписи и иконки по умолчанию (если в БД ещё нет своих значений).
     *
     * @return array<string, array{label: string, icon: string, force_visible?: bool}>
     */
    public static function defaults(): array
    {
        return [
            'products.index' => ['label' => __('Товары'), 'icon' => 'fas fa-store'],
            'products.listV2' => ['label' => __('Товары New'), 'icon' => 'fas fa-border-all', 'force_visible' => true],
            'products.outOfStock' => ['label' => __('Товары по упущ.выгоде'), 'icon' => 'fas fa-wave-square'],
            'products.outOfStockNew' => ['label' => __('Товары по упущ.выгоде New'), 'icon' => 'fas fa-table', 'force_visible' => true],
            'suppliers.index' => ['label' => __('Товары к закупке'), 'icon' => 'fas fa-parachute-box'],
            'suppliers.listV2' => ['label' => __('Товары к закупке New'), 'icon' => 'fas fa-table', 'force_visible' => true],
            'shipper.index' => ['label' => __('Поставщики'), 'icon' => 'fas fa-store-alt'],
            'shipper.listV2' => ['label' => __('Поставщики New'), 'icon' => 'fas fa-table', 'force_visible' => true],
            'users.index' => ['label' => __('Пользователи'), 'icon' => 'fas fa-users'],
            'users.listV2' => ['label' => __('Пользователи New'), 'icon' => 'fas fa-table', 'force_visible' => true],
            'employee.index' => ['label' => __('Сотрудники (Мой Склад)'), 'icon' => 'fas fa-users'],
            'employee.listV2' => ['label' => __('Сотрудники New'), 'icon' => 'fas fa-table', 'force_visible' => true],
            'setting.index' => ['label' => __('Настройки'), 'icon' => 'fas fa-tools'],
        ];
    }

    /**
     * @return array<int, array{route: string, label: string, icon: string, enabled: bool, sort: int, force_visible?: bool}>
     */
    public static function rowsForEditor(): array
    {
        if (self::$rowsForEditorCache !== null) {
            return self::$rowsForEditorCache;
        }

        $defaults = self::defaults();
        $storedByRoute = self::storedByRoute();

        $rows = [];
        foreach (self::ROUTES_IN_ORDER as $index => $route) {
            $def = $defaults[$route] ?? ['label' => $route, 'icon' => 'fas fa-link'];
            $s = $storedByRoute[$route] ?? [];
            $forceVisible = (bool) ($def['force_visible'] ?? false);
            $rows[] = [
                'route' => $route,
                'label' => self::resolveMenuLabel($route, $s['label'] ?? null, $def['label']),
                'icon' => isset($s['icon']) && is_string($s['icon']) && $s['icon'] !== ''
                    ? $s['icon']
                    : $def['icon'],
                'enabled' => $forceVisible
                    ? true
                    : (! array_key_exists('enabled', $s) || (bool) $s['enabled']),
                'force_visible' => $forceVisible,
                'sort' => isset($s['sort']) && is_numeric($s['sort'])
                    ? (int) $s['sort']
                    : $index * 10,
            ];
        }

        usort($rows, fn (array $a, array $b): int => $a['sort'] <=> $b['sort']);

        self::$rowsForEditorCache = $rows;

        return self::$rowsForEditorCache;
    }

    /**
     * Меню для сайдбара: ключ — имя маршрута (как раньше в AppLayout::menuItems).
     *
     * @return array<string, array{text: string, icon: string, selected: string}>
     */
    public static function menuForSidebar(?string $currentRouteName): array
    {
        $rows = self::rowsForEditor();
        $menu = [];
        foreach ($rows as $row) {
            if (! $row['enabled']) {
                continue;
            }
            if (! Route::has($row['route'])) {
                continue;
            }
            $route = $row['route'];
            $menu[$route] = [
                'text' => $row['label'],
                'icon' => $row['icon'],
                'selected' => ($route === $currentRouteName) ? 'active' : '',
            ];
        }

        return $menu;
    }

    public static function pageTitleForRoute(?string $currentRouteName): string
    {
        if ($currentRouteName === null || $currentRouteName === '') {
            return '';
        }
        $menu = self::menuForSidebar($currentRouteName);

        return $menu[$currentRouteName]['text'] ?? '';
    }

    /**
     * @param  array<int, array{route: string, label: string, icon: string, enabled?: bool, sort: int}>  $items
     */
    public static function persistFromRequest(array $items): void
    {
        $allowed = array_flip(self::ROUTES_IN_ORDER);
        $defaults = self::defaults();
        $payload = [];
        foreach ($items as $item) {
            if (! is_array($item)) {
                continue;
            }
            $route = $item['route'] ?? '';
            if (! isset($allowed[$route])) {
                continue;
            }
            $def = $defaults[$route] ?? [];
            $enabled = ! empty($item['enabled']);
            if ($def['force_visible'] ?? false) {
                $enabled = true;
            }
            $payload[] = [
                'route' => $route,
                'label' => (string) ($item['label'] ?? ''),
                'icon' => (string) ($item['icon'] ?? ''),
                'enabled' => $enabled,
                'sort' => (int) ($item['sort'] ?? 0),
            ];
        }

        Setting::updateOrCreate(
            ['key' => self::SETTING_KEY],
            ['value' => json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR)]
        );

        self::$rowsForEditorCache = null;
    }

    /**
     * @return array<string, array{label?: mixed, icon?: mixed, enabled?: mixed, sort?: mixed}>
     */
    private static function storedByRoute(): array
    {
        $raw = Setting::query()->where('key', self::SETTING_KEY)->value('value');
        if ($raw === null || $raw === '') {
            return [];
        }
        try {
            $decoded = json_decode((string) $raw, true, 512, JSON_THROW_ON_ERROR);
        } catch (\JsonException) {
            return [];
        }
        if (! is_array($decoded)) {
            return [];
        }
        $by = [];
        foreach ($decoded as $row) {
            if (! is_array($row) || empty($row['route']) || ! is_string($row['route'])) {
                continue;
            }
            $by[$row['route']] = $row;
        }

        return $by;
    }

    private static function resolveMenuLabel(string $route, mixed $stored, string $default): string
    {
        $s = is_string($stored) && $stored !== '' ? $stored : null;
        if ($s === null) {
            return $default;
        }
        // После смены подписи по умолчанию в настройках мог остаться сохранённый старый текст
        if ($route === 'products.listV2' && $s === 'Номенклатура') {
            return $default;
        }

        return $s;
    }
}
