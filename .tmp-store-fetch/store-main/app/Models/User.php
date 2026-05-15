<?php

namespace App\Models;

// use Illuminate\Contracts\Auth\MustVerifyEmail;
use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Foundation\Auth\User as Authenticatable;
use Illuminate\Notifications\Notifiable;
use Laravel\Sanctum\HasApiTokens;
use Spatie\Permission\Traits\HasRoles;
use Illuminate\Database\Eloquent\Casts\Attribute;

class User extends Authenticatable
{
    use HasApiTokens, HasFactory, Notifiable, HasRoles;

    /**
     * The attributes that are mass assignable.
     *
     * @var array<int, string>
     */
    protected $fillable = [
        'name',
        'email',
        'department',
        'password',
        'is_archived',
        'phone',
    ];

    /**
     * The attributes that should be hidden for serialization.
     *
     * @var array<int, string>
     */
    protected $hidden = [
        'password',
        'remember_token',
    ];

    /**
     * The attributes that should be cast.
     *
     * @var array<string, string>
     */
    protected $casts = [
        'email_verified_at' => 'datetime',
        'password' => 'hashed',
        'is_archived' => 'boolean',
    ];

    public function filters()
    {
        return $this->hasMany(Filter::class);
    }

    protected function department(): Attribute
    {
        return Attribute::make(function ($value) {
            return $value ?? 'Должность/отдел';
        });
    }

    public function isSelected(array $users): bool
    {
        foreach ($users as $user) {
            if ($user->id === $this->id) {
                return true;
            }
        }

        return false;
    }

    public function getUsersForShipper(?int $shipperId): array
    {
        $users = User::join('shipper_user', 'users.id', '=', 'shipper_user.user_id')
            ->where('shipper_user.shipper_id', $shipperId)
            ->get();

        if ($users) {
            return $users->all();
        }

        return [];
    }
}
