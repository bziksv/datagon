<?php


namespace App\Lib\Moysklad\Receive;


use App\Lib\Moysklad\MojSkladJsonApi;

class MyStoreGroup extends MyStoreReceive
{
    public function __construct()
    {
        $this->api = new MojSkladJsonApi;
        $this->api->send('https://api.moysklad.ru/api/remap/1.2/entity/group');
    }

    public function currentPage(): int
    {
        return 0;
    }

    public function nextPage(): bool
    {
        return false;
    }

    protected function eventClass($rows)
    {
        // TODO: Implement eventClass() method.
    }
}
