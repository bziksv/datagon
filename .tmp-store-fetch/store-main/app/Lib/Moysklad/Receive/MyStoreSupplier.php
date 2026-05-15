<?php


namespace App\Lib\Moysklad\Receive;


use App\Events\MyStoreSupplierRowsReceived;
use App\Lib\Moysklad\MojSkladJsonApi;

class MyStoreSupplier extends MyStoreReceive
{
    public function __construct()
    {
        $this->api = new MojSkladJsonApi;
        $this->api->send('https://api.moysklad.ru/api/remap/1.2/entity/counterparty');
    }

    protected function eventClass($rows)
    {
        MyStoreSupplierRowsReceived::dispatch($rows);
    }
}
