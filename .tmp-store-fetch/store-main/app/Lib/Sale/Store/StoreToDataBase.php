<?php


namespace App\Lib\Sale\Store;


use Illuminate\Database\Eloquent\Model;

abstract class StoreToDataBase
{
    protected $model;

    public function __construct(Model $model)
    {
        $this->model = $model;
    }

    public function updateOrCreate(array $items)
    {
        foreach ($items as $item)
        {
            $obj = $this->model->updateOrCreate($this->externalCode($item), $this->prepareProduct($item));
            $this->saveResult($obj, $item);
        }
    }

    public function create(array $items)
    {
        foreach ($items as $item)
        {
            $obj = $this->model->create($this->prepareProduct($item));
            $this->saveResult($obj, $item);
        }
    }

    public function truncate()
    {
        $this->model->truncate();

        return $this;
    }

    abstract protected function prepareProduct(array $item): array;

    abstract protected function externalCode(array $item): array;

    abstract protected function saveResult(Model $model, array $item): void;

    protected function pennyToRuble(float $price)
    {
        return round($price / 100, 2);
    }

    protected function getIdFromMeta(array $field)
    {
        if(!isset($field['meta']))
            return null;

        $href = parse_url($field['meta']['href']);

        return substr($href['path'], strrpos($href['path'], '/') + 1);
    }

    protected function getIdFromMetaHref(string $metaHref)
    {
        if(!$metaHref)
            return null;

        $href = parse_url($metaHref);

        return substr($href['path'], strrpos($href['path'], '/') + 1);
    }
}
