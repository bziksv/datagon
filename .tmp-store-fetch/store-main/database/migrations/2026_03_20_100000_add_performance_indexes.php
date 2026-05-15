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
            $table->index('uuid');
        });

        Schema::table('stocks', function (Blueprint $table) {
            $table->index('assortmentId');
        });

        Schema::table('transits', function (Blueprint $table) {
            $table->index('assortmentId');
        });
    }

    /**
     * Reverse the migrations.
     */
    public function down(): void
    {
        Schema::table('products', function (Blueprint $table) {
            $table->dropIndex(['uuid']);
        });

        Schema::table('stocks', function (Blueprint $table) {
            $table->dropIndex(['assortmentId']);
        });

        Schema::table('transits', function (Blueprint $table) {
            $table->dropIndex(['assortmentId']);
        });
    }
};
