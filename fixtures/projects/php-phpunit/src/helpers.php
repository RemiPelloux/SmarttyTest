<?php

declare(strict_types=1);

if (! function_exists('shop_format')) {
    function shop_format(int $cents): string
    {
        return sprintf('%d.%02d', intdiv($cents, 100), $cents % 100);
    }
}

require __DIR__ . '/constants.php';
