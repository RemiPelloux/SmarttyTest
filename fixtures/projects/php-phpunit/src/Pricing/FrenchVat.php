<?php

declare(strict_types=1);

namespace Shop\Pricing;

final class FrenchVat implements TaxRule
{
    public function rate(): float
    {
        return 0.2;
    }
}
