<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /**
     * Ускорение `user->filters()->where('active', …)` (FiltersController, кеш) и списка фильтров на /suppliers.
     * По `user_id` индекс уже есть у FK; составной с `active` — для точечной выборки.
     */
    public function up(): void
    {
        Schema::table('filters', function (Blueprint $table) {
            $table->index(['user_id', 'active'], 'filters_user_id_active_index');
        });
    }

    public function down(): void
    {
        Schema::table('filters', function (Blueprint $table) {
            $table->dropIndex('filters_user_id_active_index');
        });
    }
};
