<?php

namespace App\Console\Commands;

use Illuminate\Console\Command;
use App\Lib\Sale\SyncMyStoreWithDataBase;

class SyncProducts extends Command
{
    /**
     * The name and signature of the console command.
     *
     * @var string
     */
    protected $signature = 'sale:sync';

    /**
     * The console command description.
     *
     * @var string
     */
    protected $description = 'Синхронизация товаров с Мой Склад API';

    /**
     * Execute the console command.
     */
    public function handle()
    {
        (new SyncMyStoreWithDataBase())->syncAll();
    }
}
