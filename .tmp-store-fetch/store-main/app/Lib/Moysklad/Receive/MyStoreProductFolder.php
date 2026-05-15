<?php


namespace App\Lib\Moysklad\Receive;


use App\Events\MyStoreProductFolderRowsReceived;
use App\Lib\Moysklad\MojSkladJsonApi;

class MyStoreProductFolder extends MyStoreReceive
{
    public function __construct()
    {
        $this->api = new MojSkladJsonApi;
        $this->api->send('https://api.moysklad.ru/api/remap/1.2/entity/productfolder');
    }

    protected function eventClass($rows)
    {
        MyStoreProductFolderRowsReceived::dispatch($rows);
    }
}
