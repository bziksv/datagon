<?php

namespace App\Http\Controllers;

use App\Http\Requests\SettingStoreRequest;
use App\Imports\MinimumBalanceImport;
use App\Lib\Moysklad\StoreToken;
use App\Models\Setting;
use App\Services\SidebarMenuRegistry;
use Illuminate\Http\Request;
use Illuminate\Validation\Rule;
use Illuminate\Validation\ValidationException;
use Maatwebsite\Excel\Facades\Excel;

class SettingController extends Controller
{
    public function index()
    {
        $token = (new StoreToken())->getToken();
        $vals = Setting::valuesByKeys([
            'warehouse_item_param',
            'measure_item_param',
            'site_title',
            'site_name',
            'footer_phone',
            'footer_telegram',
            'show_footer_phone',
            'show_footer_telegram',
            Setting::LAYOUT_VIEW_CACHE_TTL_KEY,
        ]);
        $warehouseItemParam = $vals['warehouse_item_param'] ?? null;
        $measureItemParam = $vals['measure_item_param'] ?? null;
        $siteTitle = $vals['site_title'] ?? null;
        $siteName = $vals['site_name'] ?? null;
        $footerPhone = $vals['footer_phone'] ?? null;
        $footerTelegram = $vals['footer_telegram'] ?? null;
        $showFooterPhone = ($vals['show_footer_phone'] ?? '1') !== '0';
        $showFooterTelegram = ($vals['show_footer_telegram'] ?? '1') !== '0';
        $layoutViewCacheTtl = (int) ($vals[Setting::LAYOUT_VIEW_CACHE_TTL_KEY] ?? config('lagerplus.settings_layout_cache_ttl', 120));
        $layoutViewCacheTtl = max(10, min(604800, $layoutViewCacheTtl));
        $sidebarMenuRows = SidebarMenuRegistry::rowsForEditor();

        return view('setting.index', compact('token', 'warehouseItemParam', 'measureItemParam', 'siteTitle', 'siteName', 'footerPhone', 'footerTelegram', 'showFooterPhone', 'showFooterTelegram', 'layoutViewCacheTtl', 'sidebarMenuRows'));
    }

    public function store(SettingStoreRequest $request)
    {
        $valid = $request->validated();

        $status = 'setting-store';

        Setting::updateOrCreate(
            ['key' => $valid['key']],
            ['value' => $valid['value']]
        );
        if (in_array($valid['key'], Setting::LAYOUT_VIEW_KEYS, true)
            || $valid['key'] === Setting::LAYOUT_VIEW_CACHE_TTL_KEY) {
            Setting::forgetLayoutViewCache();
        }

        return redirect()->route('setting.index')->with('status', $status);
    }

    public function import(Request $request)
    {
        Excel::import(new MinimumBalanceImport, $request->file('excel'));

        return redirect()->route('setting.index')->with('status', 'setting-import');
    }

    public function storeAll(Request $request)
    {
        $data = $request->only([
            'site_title',
            'site_name',
            'token',
            'warehouse_item_param',
            'measure_item_param',
            'footer_phone',
            'footer_telegram',
        ]);
        foreach ($data as $key => $value) {
            Setting::updateOrCreate(['key' => $key], ['value' => $value]);
        }
        Setting::updateOrCreate(['key' => 'show_footer_phone'], ['value' => $request->has('show_footer_phone') ? '1' : '0']);
        Setting::updateOrCreate(['key' => 'show_footer_telegram'], ['value' => $request->has('show_footer_telegram') ? '1' : '0']);
        Setting::forgetLayoutViewCache();

        return redirect()->route('setting.index')->with('status', 'setting-store-all');
    }

    public function updateLayoutCache(Request $request)
    {
        $validated = $request->validate([
            'layout_view_cache_ttl' => ['required', 'integer', 'min:10', 'max:604800'],
        ]);

        Setting::updateOrCreate(
            ['key' => Setting::LAYOUT_VIEW_CACHE_TTL_KEY],
            ['value' => (string) $validated['layout_view_cache_ttl']]
        );
        Setting::forgetLayoutViewCache();

        return redirect()->route('setting.index')->with('status', 'setting-cache-updated');
    }

    public function flushLayoutCache()
    {
        Setting::forgetLayoutViewCache();

        return redirect()->route('setting.index')->with('status', 'setting-cache-flushed');
    }

    public function updateSidebarMenu(Request $request)
    {
        $allowed = SidebarMenuRegistry::allowedRoutes();
        $validated = $request->validate([
            'menu_items' => ['required', 'array', 'size:'.count($allowed)],
            'menu_items.*.route' => ['required', 'string', Rule::in($allowed)],
            'menu_items.*.label' => ['required', 'string', 'max:120'],
            'menu_items.*.icon' => ['required', 'string', 'max:80', 'regex:/^[a-zA-Z0-9\s\-_]+$/'],
            'menu_items.*.sort' => ['required', 'integer', 'min:0', 'max:9999'],
        ]);

        $routesSubmitted = collect($validated['menu_items'])->pluck('route');
        if ($routesSubmitted->unique()->count() !== count($allowed)
            || collect($allowed)->diff($routesSubmitted)->isNotEmpty()) {
            throw ValidationException::withMessages([
                'menu_items' => [__('Дублируются или отсутствуют пункты меню. Обновите страницу и попробуйте снова.')],
            ]);
        }

        $items = [];
        foreach ($validated['menu_items'] as $idx => $row) {
            $items[] = [
                'route' => $row['route'],
                'label' => $row['label'],
                'icon' => $row['icon'],
                'sort' => $row['sort'],
                'enabled' => $request->boolean('menu_items.'.$idx.'.enabled'),
            ];
        }

        if (! collect($items)->contains(fn (array $i): bool => $i['enabled'])) {
            throw ValidationException::withMessages([
                'menu_items' => [__('Отметьте хотя бы один пункт меню.')],
            ]);
        }

        SidebarMenuRegistry::persistFromRequest($items);

        return redirect()->route('setting.index')->with('status', 'setting-sidebar-menu');
    }
}
