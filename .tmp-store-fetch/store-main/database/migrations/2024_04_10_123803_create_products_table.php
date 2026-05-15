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
        Schema::create('products', function (Blueprint $table) {
            $table->id();
            $table->uuid('uuid');
            $table->uuid('accountId');
            $table->boolean('shared');
            $table->string('owner')->nullable();
            $table->string('group')->nullable();
            $table->string('productFolder')->nullable();
            $table->string('supplier')->nullable();
            $table->string('name');
            $table->text('description')->nullable();
            $table->string('code')->nullable();
            $table->string('externalCode')->unique();
            $table->boolean('archived');
            $table->text('pathName')->nullable();
            $table->integer('effectiveVat')->nullable();
            $table->boolean('effectiveVatEnabled')->default(false);
            $table->integer('vat')->nullable();
            $table->boolean('vatEnabled')->default(false);
            $table->boolean('useParentVat');
            $table->json('images')->nullable();
            $table->decimal('minPrice', 15, 2)->unsigned()->nullable();
            $table->decimal('salePrices', 15, 2)->unsigned()->nullable();
            $table->decimal('buyPrice', 15, 2)->unsigned()->nullable();
            $table->json('barcodes')->nullable();
            $table->json('attributes')->nullable();
            $table->enum('paymentItemType', ['GOOD', 'EXCISABLE_GOOD', 'COMPOUND_PAYMENT_ITEM', 'ANOTHER_PAYMENT_ITEM']);
            $table->boolean('discountProhibited');
            $table->string('article')->nullable();
            $table->float('weight');
            $table->float('volume');
            $table->integer('variantsCount');
            $table->boolean('isSerialTrackable');
            $table->enum('trackingType', ['BEER_ALCOHOL', 'ELECTRONICS', 'FOOD_SUPPLEMENT', 'LP_CLOTHES', 'LP_LINENS', 'MILK', 'NCP', 'NOT_TRACKED', 'OTP', 'PERFUMERY', 'SANITIZER', 'SHOES', 'TIRES', 'TOBACCO', 'WATER']);
            $table->timestamps();
        });
    }

    /**
     * Reverse the migrations.
     */
    public function down(): void
    {
        Schema::dropIfExists('products');
    }
};
