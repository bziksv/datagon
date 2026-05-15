<?php

namespace App\Models;


use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsToMany;

class Shipper extends Model
{
    protected $guarded = [];

    use HasFactory;

    public function users(): BelongsToMany
    {
        return $this->BelongsToMany(User::class);
    }

    public function stores(): BelongsToMany
    {
        return $this->BelongsToMany(Store::class);
    }
}
