<?php

namespace App\Exports;

use Carbon\Carbon;
use Maatwebsite\Excel\Excel;
use Maatwebsite\Excel\Concerns\FromCollection;
use Maatwebsite\Excel\Concerns\Exportable;
use Maatwebsite\Excel\Concerns\WithMapping;
use Illuminate\Database\Eloquent\Collection;
use Maatwebsite\Excel\Concerns\WithHeadings;
use Maatwebsite\Excel\Concerns\ShouldAutoSize;
use Maatwebsite\Excel\Concerns\WithStyles;
use PhpOffice\PhpSpreadsheet\Worksheet\Worksheet;

class SuppliersExport implements FromCollection, WithMapping, WithHeadings, ShouldAutoSize, WithStyles, ExportInterface
{
    use Exportable;

    const EXE = '.xlsx';

    protected $supplier;

    private $fileName = 'export.xlsx';

    private $writerType = Excel::XLSX;

    private $row = 0;

    private $sum = 0;

    public function __construct(Collection $supplier)
    {
        $this->fileName = __('Товары к заказу'). '-' .Carbon::now(). self::EXE;

        $this->supplier = $supplier;
    }

    public function setFileName(string $fileName): void
    {
        $this->fileName = $fileName;
    }

    public function getCollection(): Collection
    {
        return $this->supplier;
    }

    public function collection()
    {
        return $this->getCollection();
    }

    public function map($supplier): array
    {
        $this->row += 1;

        $this->sum += $supplier->buyPrice * $supplier->toBuy;

        $rows = [
            $this->row,
            $supplier->article,
            $supplier->name,
            $supplier->toBuy,
            $supplier->uoms->name,
            $supplier->buyPrice,
            $supplier->buyPrice * $supplier->toBuy,
        ];

        if ($this->row >= $this->supplier->count()) {
            return [
                $rows,
                [
                    null,
                    null,
                    null,
                    null,
                    null,
                    null,
                    $this->sum
                ]
            ];
        }

        return $rows;
    }

    public function headings(): array
    {
        return [
            '#',
            __('Артикул'),
            __('Наименование товаров'),
            __('Кол-во'),
            __('Ед. изм.'),
            __('Цена'),
            __('Итого'),
        ];
    }

    public function styles(Worksheet $sheet)
    {
        return [
            1    => ['font' => ['bold' => true]],
        ];
    }
}
