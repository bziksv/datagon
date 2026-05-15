<?php

namespace App\Http\Controllers;

use App\Http\Requests\LoginPasswordRequest;
use App\Lib\Moysklad\StoreAuthorization;

class TokenController extends Controller
{
    public function create(LoginPasswordRequest $request)
    {
        $validated = $request->validated();

        $token = (new StoreAuthorization())
            ->setLogin($validated['login'])
            ->setPassword($validated['password'])
            ->token();

        if(isset($token->errors)){
            $error = array_shift($token->errors);

            return redirect()
                ->route('setting.index')
                ->with('error', $error->error);
        }

        return redirect()
            ->route('setting.index')
            ->with('token', $token->access_token);
    }
}
