<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;
use Illuminate\Support\Facades\DB;

return new class extends Migration
{
    private array $oldTypes = ['BEER_ALCOHOL', 'ELECTRONICS', 'FOOD_SUPPLEMENT', 'LP_CLOTHES', 'LP_LINENS', 'MILK', 'NCP', 'NOT_TRACKED', 'OTP', 'PERFUMERY', 'SANITIZER', 'SHOES', 'TIRES', 'TOBACCO', 'WATER'];

    private array $newTypes = [
        'BICYCLE',
        'MEDICAL_DEVICES',
        'NABEER',
        'SEAFOOD',
        'SOFT_DRINKS',
        'VETPHARMA'
    ];

    /**
     * Run the migrations.
     */
    public function up(): void
    {
        $types = implode(', ', array_map(fn ($val) => "'$val'", array_merge($this->oldTypes, $this->newTypes)));

        DB::statement("ALTER TABLE products CHANGE trackingType trackingType ENUM($types) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL");
    }

    /**
     * Reverse the migrations.
     */
    public function down(): void
    {
        $types = implode(', ', array_map(fn ($val) => "'$val'", $this->oldTypes));

        DB::statement("ALTER TABLE products CHANGE trackingType trackingType ENUM($types) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL");
    }
};
