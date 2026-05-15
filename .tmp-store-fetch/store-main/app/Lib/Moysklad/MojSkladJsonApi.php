<?php


namespace App\Lib\Moysklad;

use Ixudra\Curl\Facades\Curl;

class MojSkladJsonApi
{
    protected $context = [];
    protected $rows = [];
    protected $meta = [];
    protected $error = [];

    public function send(string $href, $params = []): void
    {
        $token = (new StoreToken())->getToken();

        $response = Curl::to($href)
            ->withData($params)
            ->withAuthorization($token)
            ->withHeader('Accept-Encoding: gzip')
            ->withOption('ENCODING', 'gzip')
            ->get();

        $response = json_decode($response, true);

        if (!is_array($response)) {
            return;
        }

        if (array_key_exists('errors', $response)) {
            $this->error = $response['errors'];
        } else {
            if (array_key_exists('rows', $response)) {
                $this->rows = $response['rows'];
            } else {
                if (count($response) > 1) {
                    $this->rows = $response;
                } else {
                    $this->rows[] = $response;
                }
            }

            if (array_key_exists('meta', $response)) {
                $this->meta = $response['meta'];
            }

            if (array_key_exists('context', $response)) {
                $this->context = $response['context'];
            }
        }
    }

    public function getMeta(): array
    {
        return $this->meta;
    }

    public function getRows(): array
    {
        return $this->rows;
    }

    public function getContext(): array
    {
        return $this->context;
    }

    public function getErrors(): array
    {
        return $this->error;
    }
}
