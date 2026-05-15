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
        Schema::create('shippers', function (Blueprint $table) {
            $table->id();
            $table->foreignId('supplier_id')->unique()->constrained()->cascadeOnDelete();
            $table->string('name');
            $table->text('email')->nullable();
            $table->string('plan_fix_email')->nullable();
            $table->string('plan_fix_link')->nullable();
            $table->text('comment')->nullable();
            $table->integer('min_sum')->default(0);
            $table->integer('fill_storage')->default(0);
            $table->timestamps();
        });
    }

    /**
     * Reverse the migrations.
     */
    public function down(): void
    {
        Schema::dropIfExists('shippers');
    }
};
