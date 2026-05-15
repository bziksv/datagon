<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;

class Bundle extends Model
{
    use HasFactory;

    protected $guarded = [
        'id',
        'meta',
        'files',
        'uom',
        'country',
    ];

    protected $casts = [
        'barcodes' => 'array',
        'attributes' => 'array',
        'images' => 'array',
        'components' => 'array',
    ];
}
