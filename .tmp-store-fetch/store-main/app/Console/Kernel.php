<?php

namespace App\Console;

use Illuminate\Console\Scheduling\Schedule;
use Illuminate\Foundation\Console\Kernel as ConsoleKernel;

class Kernel extends ConsoleKernel
{
    /**
     * Define the application's command schedule.
     */
    protected function schedule(Schedule $schedule): void
    {
        // $schedule->command('inspire')->hourly();

        $schedule->command('app:calculate-shipper-fields')->hourly();
        $schedule->command('record:product-count')->dailyAt('09:00');

        if (config('lagerplus.out_of_stock_new_cache_warm.enabled', true)) {
            $schedule->command('lagerplus:warm-out-of-stock-new-datatable')
                ->hourly()
                ->withoutOverlapping(55);
        }

    }

    /**
     * Register the commands for the application.
     */
    protected function commands(): void
    {
        $this->load(__DIR__.'/Commands');

        require base_path('routes/console.php');
    }
}
