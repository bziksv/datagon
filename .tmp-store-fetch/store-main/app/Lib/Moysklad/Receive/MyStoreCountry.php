<?php


namespace App\Lib\Moysklad\Receive;


use App\Lib\Moysklad\MojSkladJsonApi;

class MyStoreCountry extends MyStoreReceive
{
    public function __construct()
    {
        $this->api = new MojSkladJsonApi;
        $this->api->send('https://api.moysklad.ru/api/remap/1.2/entity/country');
    }

    protected function eventClass($rows)
    {
        // TODO: Implement eventClass() method.
    }

    public function currentPage(): int
    {
        return 0;
    }

    public function nextPage(): bool
    {
        return false;
    }
}
