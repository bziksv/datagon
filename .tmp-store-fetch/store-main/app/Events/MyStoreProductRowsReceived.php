<?php

namespace App\Events;

use App\Models\Products;
use Illuminate\Broadcasting\InteractsWithSockets;
use Illuminate\Broadcasting\PrivateChannel;
use Illuminate\Foundation\Events\Dispatchable;
use Illuminate\Queue\SerializesModels;

class MyStoreProductRowsReceived
{
    use Dispatchable, InteractsWithSockets, SerializesModels;

    public $rows;

    /**
     * Create a new event instance.
     * @param array $rows
     * @param Products $product
     */
    public function __construct(array $rows)
    {
        $this->rows = $rows;
    }

    /**
     * Get the channels the event should broadcast on.
     *
     * @return array<int, \Illuminate\Broadcasting\Channel>
     */
    public function broadcastOn(): array
    {
        return [
            new PrivateChannel('channel-name'),
        ];
    }
}
