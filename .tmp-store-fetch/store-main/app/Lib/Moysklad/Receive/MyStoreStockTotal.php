<?php

namespace App\Lib\Moysklad\Receive;

use App\Lib\Moysklad\MojSkladJsonApi;

class MyStoreStockTotal extends MyStoreReceive
{
    public function __construct()
    {
        $this->api = new MojSkladJsonApi;
        $this->api->send('https://api.moysklad.ru/api/remap/1.2/report/stock/all/current?include=zeroLines');
    }

    protected function eventClass($rows)
    {
        //
    }

}
