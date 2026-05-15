<?php


namespace App\Lib\Moysklad\Receive;

use App\Lib\Moysklad\MojSkladJsonApi;

class MyStoreStock extends MyStoreReceive
{
    public function __construct()
    {
        $this->api = new MojSkladJsonApi;
        $this->api->send('https://api.moysklad.ru/api/remap/1.2/report/stock/bystore/current?stockType=stock');
    }

    protected function eventClass($rows)
    {
        //
    }
}
