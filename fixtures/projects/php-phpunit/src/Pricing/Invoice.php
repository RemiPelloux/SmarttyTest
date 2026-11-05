<?php

declare(strict_types=1);

namespace Shop\Pricing;

final class Invoice
{
    public static function tax(int $cents, TaxRule $rule): int
    {
        return (int) round($cents * $rule->rate());
    }
}
