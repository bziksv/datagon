<?php


namespace App\Lib\DataTable\Interfaces;


interface DataTableInterface
{
    public function recordsTotal(): int;
    public function recordsFiltered(): int;
    public function data(): array;
    public function error(): string;

    public function setRequest(array $request): void;
    public function setData(array $data): void;
    public function setRecordsTotal(int $recordsTotal): void;
    public function setRecordsFiltered(int $recordsFiltered): void;
}
