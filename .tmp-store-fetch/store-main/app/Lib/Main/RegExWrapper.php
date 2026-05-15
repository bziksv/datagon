<?php


namespace App\Lib\Main;


class RegExWrapper
{
    static public function beginningOfEachWordInLine(string $str)
    {
        if(strlen($str) < 1)
            return '';

        $value = $str;

        $regEx = '^(.*)';
        $arrWords = explode(' ', $value);
        foreach ($arrWords as $word)
        {
            $str = trim($word);
            $regEx .= '((^|\\s)'.$str.'.*)';
        }

        $regEx .= '$';

        return $regEx;
    }
}
