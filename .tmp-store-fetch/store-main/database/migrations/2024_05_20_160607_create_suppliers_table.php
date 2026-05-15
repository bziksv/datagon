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
        Schema::create('suppliers', function (Blueprint $table) {
            $table->id();
            $table->uuid('uuid');
            $table->uuid('accountId');
            $table->boolean('shared');
            $table->string('name');
            $table->string('externalCode')->unique();
            $table->boolean('archived');
            $table->enum('companyType', ['legal', 'entrepreneur', 'individual']);
            $table->string('legalTitle')->nullable();
            $table->string('legalAddress')->nullable();
            $table->string('inn')->nullable();
            $table->string('kpp')->nullable();
            $table->string('ogrn')->nullable();
            $table->string('okpo')->nullable();
            $table->decimal('salesAmount', 15, 2)->unsigned()->nullable();
            $table->timestamps();
        });
    }

    /**
     * Reverse the migrations.
     */
    public function down(): void
    {
        Schema::dropIfExists('suppliers');
    }
};
