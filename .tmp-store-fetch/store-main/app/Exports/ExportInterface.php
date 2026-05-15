<?php


namespace App\Exports;

use Illuminate\Database\Eloquent\Collection;

interface ExportInterface
{
    public function setFileName(string $fileName): void;
    public function download(string $fileName = null, string $writerType = null, array $headers = null);
    public function getCollection(): Collection;
}
