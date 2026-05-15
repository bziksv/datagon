<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;

class Price extends Model
{
    use HasFactory;

    protected $guarded = [];

    protected $primaryKey = 'uuid';

    public $incrementing = false;

    protected $keyType = 'string';
}
