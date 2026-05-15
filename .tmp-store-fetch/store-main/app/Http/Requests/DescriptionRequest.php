<?php

namespace App\Http\Requests;

use Illuminate\Foundation\Http\FormRequest;

class DescriptionRequest extends FormRequest
{
    /**
     * Determine if the user is authorized to make this request.
     *
     * @return bool
     */
    public function authorize()
    {
        // TODO: добавить проверку прав, пока разрешаем всем авторизованным
        return auth()->check();
    }

    /**
     * Get the validation rules that apply to the request.
     *
     * @return array
     */
    public function rules()
    {
        $descriptionId = $this->route('description') ? $this->route('description')->id : null;

        return [
            'key' => ['required', 'string', 'max:255', 'unique:descriptions,key' . ($descriptionId ? (',' . $descriptionId) : '')],
            'content' => ['nullable', 'string'],
        ];
    }
}
