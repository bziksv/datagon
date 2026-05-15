<?php


namespace App\Lib\Moysklad;


use App\Models\Setting;

class StoreToken
{
    public function getToken()
    {
        return (new Setting())->token()->value('value');
    }
}
