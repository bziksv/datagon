<?php


namespace App\Lib\Moysklad\Receive;

use App\Lib\Moysklad\MojSkladJsonApi;

class MyStoreTransit extends MyStoreReceive
{
    public function __construct()
    {
        $this->api = new MojSkladJsonApi;
        $this->api->send('https://api.moysklad.ru/api/remap/1.2/report/stock/bystore/current?stockType=inTransit');
    }

    protected function eventClass($rows)
    {
        // TODO: Implement eventClass() method.
    }
}
