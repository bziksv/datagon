<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /**
     * shipper_user: пакетные выборки по shipper_id (таблица поставщиков).
     * products: подзапросы «складская позиция + supplier» (дашборд, список поставщиков).
     */
    public function up(): void
    {
        Schema::table('shipper_user', function (Blueprint $table) {
            $table->index('shipper_id', 'shipper_user_shipper_id_index');
        });

        Schema::table('products', function (Blueprint $table) {
            $table->index(['is_warehouse_item', 'supplier'], 'products_warehouse_item_supplier_index');
        });
    }

    public function down(): void
    {
        Schema::table('shipper_user', function (Blueprint $table) {
            $table->dropIndex('shipper_user_shipper_id_index');
        });

        Schema::table('products', function (Blueprint $table) {
            $table->dropIndex('products_warehouse_item_supplier_index');
        });
    }
};
