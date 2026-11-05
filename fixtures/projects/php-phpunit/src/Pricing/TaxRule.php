<?php

declare(strict_types=1);

namespace Shop\Pricing;

interface TaxRule
{
    public function rate(): float;
}
