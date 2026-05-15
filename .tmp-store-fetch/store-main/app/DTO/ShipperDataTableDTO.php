<?php


namespace App\DTO;

use Illuminate\Http\Request;

class ShipperDataTableDTO
{
    public int $draw = 1;
    public int $start = 0;
    public int $length = 0;

    public ?string $orderBy;
    public ?string $dir;

    public ?string $search;

    public array $columns = [];
    public array $searchBuilder = [];

    public function __construct(int $start, int $length, string $orderBy, string $dir, array $columns, ?string $search, ?array $searchBuilder = [])
    {
        $this->start = $start;
        $this->length = $length;

        $this->orderBy = $orderBy;
        $this->dir = $dir;

        $this->search = $search;

        $this->columns = $columns;
        $this->searchBuilder = $searchBuilder;
    }

    public static function fromRequest(Request $request)
    {
        return new self(
            $request->input('start'),
            $request->input('length', 30),
            $request->input('order.0.column', 0),
            $request->input('order.0.dir', 'asc'),
            $request->input('columns'),
            $request->input('search.value'),
            $request->input('searchBuilder', []),
        );
    }

}
