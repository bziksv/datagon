<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\HasOne;
use Illuminate\Database\Eloquent\Builder;

class Supplier extends Model
{
    protected $guarded = [
        'id',
        'meta',
        'owner',
        'group',
    ];

    use HasFactory;

    public function shipper(): HasOne
    {
        return $this->hasOne(Shipper::class);
    }

    public function scopeWithShippers(Builder $query): void
    {
        $query->leftJoin('shippers', 'suppliers.id', '=', 'shippers.supplier_id')
        ->leftJoin('shipper_user', 'shippers.id', '=', 'shipper_user.shipper_id')
        ->leftJoin('users', 'users.id', '=', 'shipper_user.user_id')
            ->select(
                'suppliers.*',
                'shippers.id as shipper_id',
                'shippers.name as shipper_name',
                'shippers.email as shipper_email',
                'shippers.plan_fix_email as shipper_plan_fix_email',
                'shippers.plan_fix_link as shipper_plan_fix_link',
                'shippers.comment as shipper_comment',
                'shippers.min_sum as shipper_min_sum',
                'shippers.fill_storage as shipper_fill_storage',
                'shippers.filter_id as shipper_filter_id',
                'shippers.calc_occupancy_percent_all as shipper_calc_occupancy_percent_all',
                'shippers.calc_occupancy_percent_selected as shipper_calc_occupancy_percent_selected',
                'shippers.warehouse_info_all as shipper_warehouse_info_all',
                'shippers.warehouse_info_selected as shipper_warehouse_info_selected',
                'shippers.calc_quantity as shipper_calc_quantity',
                'shippers.calc_to_purchase as shipper_calc_to_purchase',
                'shippers.calc_purchase_total as shipper_calc_purchase_total'
            )
            ->selectRaw('GROUP_CONCAT(users.name SEPARATOR ", ") as employee')
            ->groupBy('suppliers.id', 'shippers.id');
    }
}
