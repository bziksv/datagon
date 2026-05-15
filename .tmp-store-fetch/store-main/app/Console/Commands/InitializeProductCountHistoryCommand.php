<?php

namespace App\Console\Commands;

use App\Services\ProductCountHistoryService;
use Illuminate\Console\Command;

class InitializeProductCountHistoryCommand extends Command
{
    /**
     * The name and signature of the console command.
     *
     * @var string
     */
    protected $signature = 'product-count:initialize';

    /**
     * The console command description.
     *
     * @var string
     */
    protected $description = 'Initialize product count history with current product count';

    /**
     * Execute the console command.
     */
    public function handle(ProductCountHistoryService $service): int
    {
        try {
            $record = $service->recordProductCount();
            $this->info("Product count history initialized: {$record->count} items on {$record->date->format('Y-m-d')}");
            return Command::SUCCESS;
        } catch (\Exception $e) {
            $this->error("Error initializing product count history: {$e->getMessage()}");
            return Command::FAILURE;
        }
    }
}

