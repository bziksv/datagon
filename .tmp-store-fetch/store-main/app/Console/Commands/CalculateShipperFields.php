<?php

namespace App\Console\Commands;

use App\Actions\CalculateFieldsAction;
use Illuminate\Console\Command;

class CalculateShipperFields extends Command
{
    /**
     * The name and signature of the console command.
     *
     * @var string
     */
    protected $signature = 'app:calculate-shipper-fields';

    /**
     * The console command description.
     *
     * @var string
     */
    protected $description = 'Calculate fields in table to /shipper page';

    /**
     * Execute the console command.
     */
    public function handle()
    {
        $calculate = new CalculateFieldsAction();

        $calculate->execute();
    }
}
