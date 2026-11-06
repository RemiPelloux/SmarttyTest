<?php

declare(strict_types=1);

namespace Shop\Pricing;

final class Rounding
{
    public static function cents(float $amount): int
    {
        return (int) round($amount);
    }

    public static function describe(): string
    {
        return 'half up';
    }
}
