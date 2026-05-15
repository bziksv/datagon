<?php


namespace App\Presenters;

use App\DTO\ShipperPaginationDTO;

abstract class ShipperPresenter
{
    abstract public function present(ShipperPaginationDTO $dto);
}
