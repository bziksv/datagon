<?php

namespace Database\Seeders;

use App\Models\User;
use Illuminate\Database\Console\Seeds\WithoutModelEvents;
use Illuminate\Database\Seeder;
use Spatie\Permission\Models\Role;
use Spatie\Permission\Models\Permission;

class CreateRolesAndPermissionsSeeder extends Seeder
{
    protected $userID = 1;

    /**
     * Run the database seeds.
     */
    public function run(): void
    {
        $admin = Role::firstOrCreate(['name' => 'administrator']);
        $employee = Role::firstOrCreate(['name' => 'employee']);

        $createUser = Permission::firstOrCreate(['name' => 'create user']);
        $editUser = Permission::firstOrCreate(['name' => 'edit user']);
        $deleteUser = Permission::firstOrCreate(['name' => 'delete user']);
        $updateMinSum = Permission::firstOrCreate(['name' => 'update min sum']);
        $updateFillStorage = Permission::firstOrCreate(['name' => 'update fill storage']);
        $updateWarehouses = Permission::firstOrCreate(['name' => 'update warehouses']);

        $admin->givePermissionTo([
            $createUser,
            $editUser,
            $deleteUser,
            $updateMinSum,
            $updateFillStorage,
            $updateWarehouses,
        ]);

        $user = User::find($this->userID);

        if ($user) {
            $user->assignRole($admin);
        }
    }
}
