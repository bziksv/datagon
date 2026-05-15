<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /**
     * JOIN products + prices по имени прайса (`WarehouseProductsService::getSumPriceByName`, дашборд).
     */
    public function up(): void
    {
        Schema::table('prices', function (Blueprint $table) {
            $table->index(['product_id', 'name'], 'prices_product_id_name_index');
        });
    }

    public function down(): void
    {
        Schema::table('prices', function (Blueprint $table) {
            $table->dropIndex('prices_product_id_name_index');
        });
    }
};
