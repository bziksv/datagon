<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /**
     * Расширение value: JSON меню сайдбара и другие настройки не умещаются в VARCHAR(255).
     */
    public function up(): void
    {
        Schema::table('settings', function (Blueprint $table) {
            $table->longText('value')->change();
        });
    }

    public function down(): void
    {
        Schema::table('settings', function (Blueprint $table) {
            $table->string('value')->change();
        });
    }
};
