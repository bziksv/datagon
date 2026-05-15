<?php


namespace App\Services;


class PackingService
{
    public function calculatePackedQuantity(int $total, int $packSize): int
    {
        return ceil($total / $packSize) * $packSize;
    }
}
