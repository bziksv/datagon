<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /**
     * Ускорение GROUP BY assortmentId в подзапросах suppliersDataTable (остатки / резерв / транзит).
     */
    public function up(): void
    {
        Schema::table('stocks', function (Blueprint $table) {
            $table->index('assortmentId', 'stocks_assortment_id_index');
        });
        Schema::table('reserves', function (Blueprint $table) {
            $table->index('assortmentId', 'reserves_assortment_id_index');
        });
        Schema::table('transits', function (Blueprint $table) {
            $table->index('assortmentId', 'transits_assortment_id_index');
        });
    }

    public function down(): void
    {
        Schema::table('stocks', function (Blueprint $table) {
            $table->dropIndex('stocks_assortment_id_index');
        });
        Schema::table('reserves', function (Blueprint $table) {
            $table->dropIndex('reserves_assortment_id_index');
        });
        Schema::table('transits', function (Blueprint $table) {
            $table->dropIndex('transits_assortment_id_index');
        });
    }
};
