<?php


namespace App\Lib\Moysklad\Receive;

use App\Events\MyStoreProductRowsReceived;
use App\Lib\Moysklad\MojSkladJsonApi;

class MyStoreProducts extends MyStoreReceive
{
    public function __construct()
    {
        $this->api = new MojSkladJsonApi;
        $this->api->send('https://api.moysklad.ru/api/remap/1.2/entity/product');
    }

    protected function eventClass($rows)
    {
        MyStoreProductRowsReceived::dispatch($rows);
    }
}
