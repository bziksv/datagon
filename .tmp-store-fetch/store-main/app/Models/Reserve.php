<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Support\Facades\DB;

class Reserve extends Model
{
    protected $guarded = [
        'reserve'
    ];

    use HasFactory;

    public function store()
    {
        return $this->belongsTo(Store::class, 'storeId', 'uuid');
    }

    public function scopeProduct(Builder $query, Products $product)
    {
        $query->where('assortmentId', $product['uuid']);
    }

    public function scopeSum(Builder $query, array $stores = []): void
    {
        $query->select('assortmentId', DB::raw('SUM(quantity) reserve'))
            ->when($stores, function (Builder $query, array $stores) {
                $query->whereIn('storeId', $stores);
            })
            ->groupBy('assortmentId');
    }
}
