<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /**
     * Run the migrations.
     */
    public function up(): void
    {
        Schema::table('shippers', function (Blueprint $table) {
            $table->text('warehouse_info_selected')->nullable()->after('calc_occupancy_percent_all');
            $table->text('warehouse_info_all')->nullable()->after('calc_occupancy_percent_all');
        });
    }

    /**
     * Reverse the migrations.
     */
    public function down(): void
    {
        Schema::table('shippers', function (Blueprint $table) {
            $table->dropColumn('warehouse_info_selected');
            $table->dropColumn('warehouse_info_all');
        });
    }
};
