<?php

namespace App\Listeners;

use App\Lib\Sale\Store\StoreSupplierToDataBase;
use App\Models\Supplier;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Queue\InteractsWithQueue;

class UpdateOrCreateSupplierToDataBase implements ShouldQueue
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
    public function handle(object $event): void
    {
        (new StoreSupplierToDataBase(new Supplier()))->updateOrCreate($event->rows);
    }
}
