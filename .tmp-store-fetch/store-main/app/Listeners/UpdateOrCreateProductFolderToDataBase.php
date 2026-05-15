<?php

namespace App\Listeners;

use App\Lib\Sale\Store\StoreProductFolderToDataBase;
use App\Models\ProductFolder;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Queue\InteractsWithQueue;

class UpdateOrCreateProductFolderToDataBase implements ShouldQueue
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
        (new StoreProductFolderToDataBase(new ProductFolder()))->updateOrCreate($event->rows);
    }
}
