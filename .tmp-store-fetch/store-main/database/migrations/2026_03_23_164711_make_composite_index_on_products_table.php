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
        Schema::table('products', function (Blueprint $table) {
            $table->dropIndex(['is_warehouse_item']);
            $table->dropIndex(['is_discontinued']);

            $table->index(['is_warehouse_item', 'is_discontinued']);
        });
    }

    /**
     * Reverse the migrations.
     */
    public function down(): void
    {
        Schema::table('products', function (Blueprint $table) {
            $table->dropIndex(['is_warehouse_item', 'is_discontinued']);

            $table->index('is_warehouse_item');
            $table->index('is_discontinued');
        });
    }
};
