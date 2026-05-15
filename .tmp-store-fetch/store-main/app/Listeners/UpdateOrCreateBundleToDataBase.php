<?php

namespace App\Listeners;

use App\Events\MyStoreBundleRowsReceived;
use App\Lib\Sale\Store\StoreBundleToDataBase;
use App\Models\Bundle;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Queue\InteractsWithQueue;

class UpdateOrCreateBundleToDataBase implements ShouldQueue
{
    /**
     * Create the event listener.
     */
    public function __construct()
    {
        //
    }

    /**
     * Handle the event.
     */
    public function handle(MyStoreBundleRowsReceived $event): void
    {
        (new StoreBundleToDataBase(new Bundle()))->updateOrCreate($event->rows);
    }
}
