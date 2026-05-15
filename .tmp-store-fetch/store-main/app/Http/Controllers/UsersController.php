<?php

namespace App\Http\Controllers;

use App\Models\User;
use App\Services\DataOutputCache;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\RedirectResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\Validator;
use Illuminate\Validation\Rule;
use Spatie\Permission\Models\Role;

class UsersController extends Controller
{
    public function __construct()
    {
        $this->middleware('can:edit user')->only('edit');
        $this->middleware('can:delete user')->only('destroy');
    }

    public function index(Request $request)
    {
        $archived = $request->boolean('archived');
        $users = User::query()
            ->select(['id', 'name', 'email', 'department', 'is_archived', 'created_at', 'phone'])
            ->where('is_archived', $archived)
            ->with('roles')
            ->orderBy('id')
            ->paginate(50)
            ->withQueryString();

        return view('users.index', compact('users', 'archived'));
    }

    public function listV2(Request $request)
    {
        $archived = $request->boolean('archived');

        return view('users.index-v2', compact('archived'));
    }

    public function json(Request $request): JsonResponse
    {
        $draw = (int) $request->input('draw', 0);

        try {
            if (! DataOutputCache::enabled()) {
                return response()->json(DataOutputCache::withDraw(
                    $this->buildUsersJsonPayload($request),
                    $draw
                ));
            }

            $identity = DataOutputCache::identityFromUsersDataTablesRequest($request);
            $payload = DataOutputCache::remember(
                DataOutputCache::REVISION_USERS,
                DataOutputCache::SEGMENT_USERS_DATATABLE,
                $identity,
                null,
                fn () => $this->buildUsersJsonPayload($request)
            );
            if (! is_array($payload)) {
                $payload = [
                    'recordsTotal' => 0,
                    'recordsFiltered' => 0,
                    'data' => [],
                    'error' => __('Ошибка загрузки таблицы.'),
                ];
            }
        } catch (\Throwable $e) {
            report($e);

            return response()->json(DataOutputCache::withDraw([
                'recordsTotal' => 0,
                'recordsFiltered' => 0,
                'data' => [],
                'error' => config('app.debug') ? $e->getMessage() : __('Ошибка загрузки таблицы.'),
            ], $draw));
        }

        return response()->json(DataOutputCache::withDraw($payload, $draw));
    }

    /**
     * @return array{recordsTotal: int, recordsFiltered: int, data: list<array<string, mixed>>, error: string}
     */
    private function buildUsersJsonPayload(Request $request): array
    {
        $archived = $request->boolean('archived');
        $recordsTotal = User::query()->where('is_archived', $archived)->count();

        $base = User::query()
            ->select(['id', 'name', 'email', 'department', 'is_archived', 'created_at', 'phone'])
            ->where('is_archived', $archived)
            ->with(['roles']);

        $search = trim((string) data_get($request->all(), 'search.value', ''));
        if ($search !== '') {
            $needle = '%'.$search.'%';
            $base->where(function ($q) use ($needle) {
                $q->where('name', 'like', $needle)
                    ->orWhere('email', 'like', $needle)
                    ->orWhere('department', 'like', $needle)
                    ->orWhere('phone', 'like', $needle);
            });
        }

        $recordsFiltered = (clone $base)->toBase()->count();

        $orderColIdx = (int) data_get($request->all(), 'order.0.column', 0);
        $orderDir = strtolower((string) data_get($request->all(), 'order.0.dir', 'asc')) === 'desc' ? 'desc' : 'asc';
        $orderColumn = $this->usersOrderColumn($orderColIdx);
        if ($orderColumn !== null) {
            $base->orderBy($orderColumn, $orderDir);
        } else {
            $base->orderBy('id', 'asc');
        }

        $start = max(0, (int) $request->input('start', 0));
        $length = (int) $request->input('length', 50);
        if ($length <= 0 || $length > 500) {
            $length = 50;
        }

        $rows = $base->skip($start)->take($length)->get();
        $data = [];
        foreach ($rows as $user) {
            $data[] = $this->mapUserToJsonRow($user);
        }

        return [
            'recordsTotal' => $recordsTotal,
            'recordsFiltered' => $recordsFiltered,
            'data' => $data,
            'error' => '',
        ];
    }

    private function usersOrderColumn(int $idx): ?string
    {
        return match ($idx) {
            0 => 'id',
            1 => 'name',
            2 => 'email',
            3 => 'department',
            4 => 'is_archived',
            5 => 'created_at',
            6 => 'phone',
            default => null,
        };
    }

    /**
     * @return array<string, mixed>
     */
    private function mapUserToJsonRow(User $user): array
    {
        $roles = $user->getRoleNames();
        $rolesText = $roles->isEmpty()
            ? '—'
            : $roles->map(fn (string $name) => __($name))->implode(', ');

        $statusHtml = $user->is_archived
            ? '<span class="badge badge-secondary">'.e(__('В архиве')).'</span>'
            : '<span class="badge badge-success">'.e(__('Активен')).'</span>';

        $actions = '';
        if (Auth::user()?->can('edit user')) {
            $actions .= '<a href="'.e(route('users.edit', $user->id)).'" class="btn bg-gradient-success btn-sm"><i class="fas fa-pencil-alt"></i></a> ';
        }
        if (Auth::user()?->can('delete user') && Auth::id() !== $user->id) {
            $actions .= '<form method="POST" action="'.e(route('users.destroy', $user->id)).'" class="d-inline" onsubmit="return confirm(\''.e(__('Удалить пользователя?')).'\')">'
                .'<input type="hidden" name="_token" value="'.e(csrf_token()).'">'
                .'<input type="hidden" name="_method" value="DELETE">'
                .'<button type="submit" class="btn bg-gradient-danger btn-sm"><i class="fas fa-trash"></i></button></form>';
        }

        return [
            'DT_RowId' => (string) $user->id,
            'id' => $user->id,
            'name_html' => e($user->name).'<br><small class="text-muted">'.e($rolesText).'</small>',
            'email' => e((string) $user->email),
            'department' => e((string) $user->department),
            'status_html' => $statusHtml,
            'created_human' => e($user->created_at?->diffForHumans() ?? ''),
            'phone' => e((string) ($user->phone ?? '')),
            'actions_html' => $actions,
        ];
    }

    public function edit(int $id)
    {
        $user = User::findOrFail($id);

        $roles = Role::query()
            ->where('guard_name', $user->getGuardName())
            ->orderBy('name')
            ->pluck('name');

        return view('users.edit', compact('user', 'roles'));
    }

    public function update(Request $request, User $user)
    {
        $data = $request->only(['name', 'department', 'email', 'phone', 'role']);

        $validator = Validator::make($data, [
            'name' => ['required', 'string', 'max:255'],
            'department' => ['required', 'string', 'max:255'],
            'email' => ['required', 'string', 'lowercase', 'email', 'max:255', Rule::unique('users', 'email')->ignore($user->id)],
            'phone' => ['nullable', 'string', 'max:30'],
            'role' => [
                'required',
                'string',
                Rule::exists('roles', 'name')->where('guard_name', $user->getGuardName()),
            ],
        ]);

        $validated = $validator->validated();
        $validated['is_archived'] = $request->boolean('is_archived');

        $role = $validated['role'];
        unset($validated['role']);

        $user->update($validated);
        $user->syncRoles($role);

        DataOutputCache::bumpRevision(DataOutputCache::REVISION_USERS);

        return redirect()->route('users.index');
    }

    public function destroy(int $id): RedirectResponse
    {
        if (Auth::id() !== $id) {
            User::destroy($id);
            DataOutputCache::bumpRevision(DataOutputCache::REVISION_USERS);
        }

        return redirect()->route('users.index');
    }
}
