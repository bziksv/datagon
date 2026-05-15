<?php


namespace App\Lib\Moysklad\Receive;


interface MyStoreReceiveInterface
{
    public function getRows(): array;
    public function currentPage(): int;
    public function nextPage(): bool;
}
