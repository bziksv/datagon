<?php

namespace App\DTO;

class ShipperPaginationDTO
{
    public array $shippers = [];

    /** @deprecated используйте {@see $recordsTotal} */
    public int $total = 0;

    public int $count = 0;

    public int $recordsTotal = 0;

    public int $recordsFiltered = 0;

    public function __construct(array $shippers, int $recordsTotal, int $recordsFiltered)
    {
        $this->shippers = $shippers;
        $this->recordsTotal = $recordsTotal;
        $this->recordsFiltered = $recordsFiltered;
        $this->total = $recordsTotal;
        $this->count = count($shippers);
    }
}
