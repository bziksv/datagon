<?php

namespace App\View\Components;

use App\Models\Setting;
use App\Services\SidebarMenuRegistry;
use Illuminate\Support\Facades\Route;
use Illuminate\View\Component;
use Illuminate\View\View;

class AppLayout extends Component
{
    protected $menu;

    /**
     * @deprecated Используйте {@see SidebarMenuRegistry::menuForSidebar()}
     */
    public static function menuItems(): array
    {
        return SidebarMenuRegistry::menuForSidebar(Route::currentRouteName());
    }

    public function __construct()
    {
        $route = Route::currentRouteName();

        $this->menu = SidebarMenuRegistry::menuForSidebar($route);
    }

    /**
     * Get the view / contents that represents the component.
     */
    public function render(): View
    {
        $s = Setting::cachedForLayoutView();
        $siteTitle = $s['site_title'] ?? null;
        $siteName = $s['site_name'] ?? null;
        $footerPhone = $s['footer_phone'] ?? null;
        $footerTelegram = $s['footer_telegram'] ?? null;
        $showFooterPhone = ($s['show_footer_phone'] ?? '1') !== '0';
        $showFooterTelegram = ($s['show_footer_telegram'] ?? '1') !== '0';

        return view('layouts.app', [
            'menu' => $this->menu,
            'siteTitle' => $siteTitle,
            'siteName' => $siteName,
            'footerPhone' => $footerPhone,
            'footerTelegram' => $footerTelegram,
            'showFooterPhone' => $showFooterPhone,
            'showFooterTelegram' => $showFooterTelegram,
        ]);
    }
}
