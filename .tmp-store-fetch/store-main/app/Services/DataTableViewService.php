<?php

namespace App\Services;

class DataTableViewService
{
    public static function columnInputView(array $data, bool $string = false)
    {
        if ($string) {
            return self::columnInputHtml(
                (string) $data['id'],
                (string) $data['action'],
                (string) ($data['value'] ?? '')
            );
        }

        return view('columns.input-column', $data);
    }

    /** Без Blade: на странице товаров десятки строк × два поля — render() сильно тормозил PHP. */
    private static function columnInputHtml(string $id, string $action, string $value): string
    {
        return '<div class="input-group input-group-sm" data-id="'.e($id).'" data-action="'.e($action).'">'
            .'<input type="text" class="form-control" value="'.e($value).'">'
            .'<span class="input-group-append input-column">'
            .'<button type="button" class="btn btn-default btn-flat"><i class="fas fa-save"></i></button>'
            .'</span></div>';
    }
}
