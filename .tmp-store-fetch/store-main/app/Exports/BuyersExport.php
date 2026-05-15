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

class BuyersExport implements FromCollection, WithMapping, WithHeadings, ShouldAutoSize, WithStyles, ExportInterface
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
            $supplier->code,
            $supplier->article,
            $supplier->name,
            $supplier->suppliers->name,
            $supplier->minimumBalance,
            $supplier->minimumBalanceLager,
            $supplier->stock,
            $supplier->transit,
            $supplier->reserve,
            $supplier->uoms->name,
            $supplier->stockPercent,
            $supplier->toBuy,
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
                    null,
                    null,
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
            __('Код'),
            __('Артикул'),
            __('Наименование товаров'),
            __('Поставщик'),
            __('Неснижаемый остаток'),
            __('Неснижаемый остаток lager'),
            __('Остаток'),
            __('Ожидание'),
            __('Резерв'),
            __('Ед. изм.'),
            __('Процент остатка'),
            __('Кол-во'),
            __('Закупочная цена'),
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
