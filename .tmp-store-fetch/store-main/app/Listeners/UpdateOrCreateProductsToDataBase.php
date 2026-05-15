<?php

namespace App\Listeners;

use App\Lib\Sale\Store\StoreProductToDataBase;
use App\Models\Products;
use Illuminate\Contracts\Queue\ShouldQueue;

class UpdateOrCreateProductsToDataBase implements ShouldQueue
{
    public $timeout = 0;

    /**
     * Create the event listener.
     */
    public function __construct()
    {

    }

    /**
     * Handle the event.
     * @param object $event
     */
    public function handle(object $event): void
    {
        (new StoreProductToDataBase(new Products()))->updateOrCreate($event->rows);
    }
}
