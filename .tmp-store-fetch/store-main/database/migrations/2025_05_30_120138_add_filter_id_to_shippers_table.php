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
            $table->foreignId('filter_id')->nullable()->after('supplier_id')->constrained()->nullOnDelete();
        });
    }

    /**
     * Reverse the migrations.
     */
    public function down(): void
    {
        Schema::table('shippers', function (Blueprint $table) {
            $table->dropForeign(['filter_id']);
            $table->dropColumn('filter_id');
        });
    }
};
