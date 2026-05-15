<?php

namespace App\Http\Controllers;

use App\Models\User;
use App\Services\DataOutputCache;
use Illuminate\Http\Request;

class FiltersController extends Controller
{
    public function index(Request $request)
    {
        $user = $request->user();
        if ($user === null) {
            return null;
        }

        $active = $request->input('active');

        if (! DataOutputCache::enabled()) {
            return $user->filters()->where('active', $active)->value('payload');
        }

        return DataOutputCache::remember(
            DataOutputCache::revisionDomainUserFilters($user->id),
            DataOutputCache::SEGMENT_FILTERS_INDEX,
            DataOutputCache::normalizeForKey(['active' => $active, '_uid' => $user->id]),
            null,
            fn () => $user->filters()->where('active', $active)->value('payload')
        );
    }

    public function store(Request $request)
    {
        $user = $request->user();
        $name = $request->input('name');
        $params = $request->input('params');
        $id = $request->input('id');

        if ($id > 0) {

            $update = ['payload' => $params];

            if ($name) {
                $update['name'] = $name;
            }

            $user->filters()->where('id', $id)
                ->update($update);

        } elseif ($name) {

            $user->filters()->create([
                'name' => $name,
                'payload' => $params,
            ]);

        }

        $this->bumpFiltersCacheForUser($user);

        return redirect()->back();
    }

    public function update(Request $request, string $id)
    {
        $user = $request->user();

        $user->filters()->update(['active' => false]);

        if ($id > 0) {
            $user->filters()->where('id', $id)->update(['active' => true]);
        }

        $this->bumpFiltersCacheForUser($user);
    }

    public function destroy(Request $request, string $id)
    {
        $user = $request->user();

        $user->filters()->where('id', $id)->delete();

        $this->bumpFiltersCacheForUser($user);
    }

    private function bumpFiltersCacheForUser(?User $user): void
    {
        if ($user === null) {
            return;
        }
        DataOutputCache::bumpRevision(DataOutputCache::revisionDomainUserFilters($user->id));
    }
}
