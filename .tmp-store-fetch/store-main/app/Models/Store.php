<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Builder;

class Store extends Model
{
    protected $guarded = [
        'id',
        'meta',
        'owner',
        'group',
        'zones',
        'slots',
    ];

    use HasFactory;

    public function stocks()
    {
        return $this->hasMany(Stock::class, 'storeId', 'uuid');
    }

    public function reserves()
    {
        return $this->hasMany(Reserve::class, 'storeId', 'uuid');
    }

    public function transits()
    {
        return $this->hasMany(Transit::class, 'storeId', 'uuid');
    }

    public function isSelected(array $storages): bool
    {
        foreach ($storages as $storage) {
            if ($storage->id === $this->id) {
                return true;
            }
        }

        return false;
    }
}
