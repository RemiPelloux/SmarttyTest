<?php

declare(strict_types=1);

namespace Shop\Pricing;

use Shop\Money;

class Discount
{
    public function __construct(private int $percent)
    {
    }

    public function percent(): string
    {
        return $this->percent . '%';
    }

    public function apply(Money $price): Money
    {
        return Money::fromCents(Rounding::cents($price->cents * (100 - $this->percent) / 100));
    }
}
