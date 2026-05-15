<?php

namespace App\Http\Controllers;

use App\Models\Employee;
use App\Services\DataOutputCache;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Auth;

class EmployeeController extends Controller
{
    public function index(Request $request)
    {
        $archived = $request->boolean('archived');
        $employees = Employee::query()
            ->where('archived', $archived)
            ->orderBy('name')
            ->paginate(50)
            ->withQueryString();

        return view('employee.index', compact('employees', 'archived'));
    }

    public function listV2(Request $request)
    {
        $archived = $request->boolean('archived');

        return view('employee.index-v2', compact('archived'));
    }

    public function datatableJson(Request $request): JsonResponse
    {
        $draw = (int) $request->input('draw', 0);

        try {
            if (! DataOutputCache::enabled()) {
                return response()->json(DataOutputCache::withDraw(
                    $this->buildEmployeeDatatablePayload($request),
                    $draw
                ));
            }

            $identity = DataOutputCache::identityFromEmployeeDataTablesRequest($request);
            $payload = DataOutputCache::remember(
                DataOutputCache::REVISION_EMPLOYEES,
                DataOutputCache::SEGMENT_EMPLOYEES_DATATABLE,
                $identity,
                null,
                fn () => $this->buildEmployeeDatatablePayload($request)
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
    private function buildEmployeeDatatablePayload(Request $request): array
    {
        $archived = $request->boolean('archived');
        $recordsTotal = Employee::query()->where('archived', $archived)->count();

        $base = Employee::query()
            ->where('archived', $archived);

        $search = trim((string) data_get($request->all(), 'search.value', ''));
        if ($search !== '') {
            $needle = '%'.$search.'%';
            $base->where(function ($q) use ($needle) {
                $q->where('name', 'like', $needle)
                    ->orWhere('email', 'like', $needle)
                    ->orWhere('fullName', 'like', $needle)
                    ->orWhere('externalCode', 'like', $needle);
            });
        }

        $recordsFiltered = (clone $base)->toBase()->count();

        $orderColIdx = (int) data_get($request->all(), 'order.0.column', 1);
        $orderDir = strtolower((string) data_get($request->all(), 'order.0.dir', 'asc')) === 'desc' ? 'desc' : 'asc';
        $orderColumn = $this->employeeOrderColumn($orderColIdx);
        if ($orderColumn !== null) {
            $base->orderBy($orderColumn, $orderDir);
        } else {
            $base->orderBy('name', 'asc');
        }

        $start = max(0, (int) $request->input('start', 0));
        $length = (int) $request->input('length', 50);
        if ($length <= 0 || $length > 500) {
            $length = 50;
        }

        $rows = $base->skip($start)->take($length)->get([
            'id', 'uuid', 'name', 'externalCode', 'email', 'fullName', 'archived',
        ]);

        $data = [];
        foreach ($rows as $e) {
            $statusHtml = $e->archived
                ? '<span class="badge badge-secondary">'.e(__('В архиве')).'</span>'
                : '<span class="badge badge-success">'.e(__('Активен')).'</span>';
            $data[] = [
                'DT_RowId' => (string) $e->id,
                'externalCode' => e((string) $e->externalCode),
                'name' => e((string) $e->name),
                'email' => e((string) ($e->email ?? '')),
                'fullName' => e((string) ($e->fullName ?? '')),
                'status_html' => $statusHtml,
            ];
        }

        return [
            'recordsTotal' => $recordsTotal,
            'recordsFiltered' => $recordsFiltered,
            'data' => $data,
            'error' => '',
        ];
    }

    private function employeeOrderColumn(int $idx): ?string
    {
        return match ($idx) {
            0 => 'externalCode',
            1 => 'name',
            2 => 'email',
            3 => 'fullName',
            4 => 'archived',
            default => null,
        };
    }

    public function json(): JsonResponse
    {
        if (! DataOutputCache::enabled()) {
            return response()->json($this->employeesJsonRows());
        }

        $identity = DataOutputCache::normalizeForKey([
            '_uid' => Auth::id(),
        ]);
        $rows = DataOutputCache::remember(
            DataOutputCache::REVISION_EMPLOYEES,
            DataOutputCache::SEGMENT_EMPLOYEES_JSON,
            $identity,
            null,
            fn () => $this->employeesJsonRows()
        );

        return response()->json(is_array($rows) ? $rows : []);
    }

    /**
     * @return list<array{id: int, uuid: string, name: string, externalCode: string, email: ?string, fullName: ?string, archived: bool}>
     */
    private function employeesJsonRows(): array
    {
        return Employee::query()
            ->orderBy('name')
            ->get(['id', 'uuid', 'name', 'externalCode', 'email', 'fullName', 'archived'])
            ->map(static fn (Employee $e) => [
                'id' => $e->id,
                'uuid' => $e->uuid,
                'name' => $e->name,
                'externalCode' => $e->externalCode,
                'email' => $e->email,
                'fullName' => $e->fullName,
                'archived' => (bool) $e->archived,
            ])
            ->values()
            ->all();
    }
}
