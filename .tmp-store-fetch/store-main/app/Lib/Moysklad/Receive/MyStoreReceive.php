<?php


namespace App\Lib\Moysklad\Receive;

use App\Lib\Moysklad\MojSkladJsonApi;
use Illuminate\Support\Sleep;

abstract class MyStoreReceive implements MyStoreReceiveInterface
{
    protected $api;

    public function getRows(): array
    {
        return $this->getApi()->getRows();
    }

    public function allRows(): array
    {
        $arr = [$this->getRows()];

        while ($this->nextPage()) {

            $page = $this->currentPage();

            // Pause every 20 request
            if($page > 0 && $page % 20 === 0) {
                Sleep::for(1)->seconds();
            }

            $arr[] = $this->getRows();
        }

        return call_user_func_array('array_merge', $arr);
    }

    public function getApi(): MojSkladJsonApi
    {
        return $this->api;
    }

    public function currentPage(): int
    {
        $meta = $this->getApi()->getMeta();

        if(array_key_exists('offset', $meta) && array_key_exists('limit', $meta))
            return ($meta['offset'] / $meta['limit']);

        return 0;
    }

    public function nextPage(): bool
    {
        $meta = $this->getApi()->getMeta();
        if(array_key_exists('nextHref', $meta)){
            $this->getApi()->send($meta['nextHref']);

            return true;
        }

        return false;
    }

    abstract protected function eventClass($rows);

    public function event(): void
    {
        $rows = $this->getRows();

        while($rows)
        {
            $page = $this->currentPage();

            // Pause every 40 request
            if($page > 0 && $page % 40 === 0)
                Sleep::for(1)->seconds();

            $this->eventClass($rows);

            if($this->nextPage()){
                $rows = $this->getRows();
            }else
                $rows = null;
        }
    }
}
