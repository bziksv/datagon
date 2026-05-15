<?php

namespace App\Providers;

use App\Events\MyStoreBundleRowsReceived;
use App\Events\MyStoreProductFolderRowsReceived;
use App\Events\MyStoreProductRowsReceived;
use App\Events\MyStoreSupplierRowsReceived;
use App\Listeners\AssignRoleToUser;
use App\Listeners\UpdateOrCreateBundleToDataBase;
use App\Listeners\UpdateOrCreateProductFolderToDataBase;
use App\Listeners\UpdateOrCreateProductsToDataBase;
use App\Listeners\UpdateOrCreateSupplierToDataBase;
use Illuminate\Auth\Events\Registered;
use Illuminate\Auth\Listeners\SendEmailVerificationNotification;
use Illuminate\Foundation\Support\Providers\EventServiceProvider as ServiceProvider;


class EventServiceProvider extends ServiceProvider
{
    /**
     * The event to listener mappings for the application.
     *
     * @var array<class-string, array<int, class-string>>
     */
    protected $listen = [
        Registered::class => [
            SendEmailVerificationNotification::class,
            AssignRoleToUser::class,
        ],
        MyStoreProductRowsReceived::class => [
            UpdateOrCreateProductsToDataBase::class,
        ],
        MyStoreSupplierRowsReceived::class => [
            UpdateOrCreateSupplierToDataBase::class,
        ],
        MyStoreProductFolderRowsReceived::class => [
            UpdateOrCreateProductFolderToDataBase::class,
        ],
        MyStoreBundleRowsReceived::class => [
            UpdateOrCreateBundleToDataBase::class,
        ],
    ];

    /**
     * Register any events for your application.
     */
    public function boot(): void
    {
        //
    }

    /**
     * Determine if events and listeners should be automatically discovered.
     */
    public function shouldDiscoverEvents(): bool
    {
        return false;
    }
}
