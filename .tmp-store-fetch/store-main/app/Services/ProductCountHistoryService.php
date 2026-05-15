<?php

namespace App\Services;

use App\Models\ProductCountHistory;
use App\Models\Products;
use Carbon\Carbon;

class ProductCountHistoryService
{
    /**
     * Record the current product count for today
     */
    public function recordProductCount(): ProductCountHistory
    {
        $today = Carbon::now()->startOfDay();
        $count = Products::count();

        return ProductCountHistory::updateOrCreate(
            ['date' => $today],
            ['count' => $count]
        );
    }

    /**
     * Get product count history for the last N days
     *
     * @param int $days
     * @return \Illuminate\Database\Eloquent\Collection
     */
    public function getHistoryByDays(int $days = 30)
    {
        $startDate = Carbon::now()->subDays($days);

        return ProductCountHistory::where('date', '>=', $startDate)
            ->orderBy('date', 'asc')
            ->get();
    }

    /**
     * Get all product count history
     *
     * @return \Illuminate\Database\Eloquent\Collection
     */
    public function getAllHistory()
    {
        return ProductCountHistory::orderBy('date', 'asc')->get();
    }

    /**
     * Get chart data for frontend
     *
     * @param int $days
     * @return array
     */
    public function getChartData(int $days = 30): array
    {
        $history = $this->getHistoryByDays($days);

        $labels = $history->map(fn($item) => $item->date->format('d.m.Y'))->toArray();
        $data = $history->map(fn($item) => $item->count)->toArray();

        return [
            'labels' => $labels,
            'data' => $data,
        ];
    }
}

