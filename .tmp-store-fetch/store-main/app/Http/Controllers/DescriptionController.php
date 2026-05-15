<?php

namespace App\Http\Controllers;

use App\Http\Requests\DescriptionRequest;
use App\Models\Description;
use App\Services\DataOutputCache;
use Illuminate\Http\JsonResponse;
use Illuminate\Support\Facades\Auth;

class DescriptionController extends Controller
{
    public function index()
    {
        $items = Description::orderBy('key')->paginate(20);

        return view('descriptions.index', compact('items'));
    }

    public function create()
    {
        $description = new Description();

        return view('descriptions.create', compact('description'));
    }

    public function store(DescriptionRequest $request)
    {
        $data = $request->validated();
        $description = Description::create($data);
        Description::forgetCache($description->key);
        DataOutputCache::bumpRevision(DataOutputCache::REVISION_DESCRIPTIONS);

        return redirect()->route('descriptions.index')->with('success', 'Description created.');
    }

    public function show(Description $description)
    {
        return view('descriptions.show', compact('description'));
    }

    public function edit(Description $description)
    {
        return view('descriptions.edit', compact('description'));
    }

    public function update(DescriptionRequest $request, Description $description)
    {
        $oldKey = $description->key;
        $data = $request->validated();
        $description->update($data);

        // Если ключ изменился, очистим старый и новый
        if ($oldKey !== $description->key) {
            Description::forgetCache($oldKey);
        }
        Description::forgetCache($description->key);
        DataOutputCache::bumpRevision(DataOutputCache::REVISION_DESCRIPTIONS);

        return redirect()->route('descriptions.index')->with('success', 'Description updated.');
    }

    public function destroy(Description $description)
    {
        $key = $description->key;
        $description->delete();
        Description::forgetCache($key);
        DataOutputCache::bumpRevision(DataOutputCache::REVISION_DESCRIPTIONS);

        return redirect()->route('descriptions.index')->with('success', 'Description deleted.');
    }

    // Дополнительный метод для получения по ключу (json/plain)
    public function showByKey($key)
    {
        $value = Description::getByKey($key, null);
        if (request()->wantsJson()) {
            return $this->descriptionJsonResponse((string) $key);
        }

        return view('descriptions.showByKey', compact('key', 'value'));
    }

    /**
     * Возвращает чистый JSON по ключу всегда
     */
    public function jsonByKey(string $key): JsonResponse
    {
        return $this->descriptionJsonResponse($key);
    }

    private function descriptionJsonResponse(string $key): JsonResponse
    {
        if (! DataOutputCache::enabled()) {
            return response()->json($this->buildDescriptionJsonPayload($key));
        }

        $identity = DataOutputCache::normalizeForKey([
            'key' => $key,
            '_uid' => Auth::id(),
        ]);
        $payload = DataOutputCache::remember(
            DataOutputCache::REVISION_DESCRIPTIONS,
            DataOutputCache::SEGMENT_DESCRIPTIONS_BY_KEY,
            $identity,
            null,
            fn () => $this->buildDescriptionJsonPayload($key)
        );

        return response()->json(is_array($payload) ? $payload : ['key' => $key, 'content' => null]);
    }

    /**
     * @return array{key: string, content: mixed}
     */
    private function buildDescriptionJsonPayload(string $key): array
    {
        $value = Description::getByKey($key, null);

        return ['key' => $key, 'content' => $value];
    }
}
