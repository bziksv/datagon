<?php

namespace App\Jobs;

use App\Models\Products;
use App\Models\Sell;
use App\Services\ProductProfitService;
use Carbon\Carbon;
use Illuminate\Bus\Queueable;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Bus\Dispatchable;
use Illuminate\Queue\InteractsWithQueue;
use Illuminate\Queue\SerializesModels;

class SaveSales implements ShouldQueue
{
    use Dispatchable, InteractsWithQueue, Queueable, SerializesModels;

    /**
     * Create a new job instance.
     */
    public function __construct(
        public Products $product,
        public $diffDay
    ) {}

    /**
     * Execute the job.
     */
    public function handle(): void
    {
        Sell::query()->create([
            'product_id' => $this->product->id,
            'sell' => (new ProductProfitService())->getTotalSell($this->product->uuid, Carbon::now()->subDay($this->diffDay)->toDateTimeString()),
            'interval' => $this->diffDay
        ]);
    }
}
