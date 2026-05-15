<?php

namespace App\Console\Commands;

use App\Services\ProductCountHistoryService;
use Illuminate\Console\Command;

class RecordProductCountCommand extends Command
{
    /**
     * The name and signature of the console command.
     *
     * @var string
     */
    protected $signature = 'record:product-count';

    /**
     * The console command description.
     *
     * @var string
     */
    protected $description = 'Record the current product count to history';

    /**
     * Execute the console command.
     */
    public function handle(ProductCountHistoryService $service): int
    {
        try {
            $record = $service->recordProductCount();
            $this->info("Product count recorded: {$record->count} items on {$record->date->format('Y-m-d')}");
            return Command::SUCCESS;
        } catch (\Exception $e) {
            $this->error("Error recording product count: {$e->getMessage()}");
            return Command::FAILURE;
        }
    }
}

