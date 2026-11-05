<?php

declare(strict_types=1);

namespace Shop;

use Shop\Concerns\HasLabel;
use Shop\Pricing\Discount;

class Cart
{
    use HasLabel;

    /** @var list<Money> */
    private array $lines = [];

    public function __construct(private Discount $discount)
    {
    }

    public function add(Money $price): self
    {
        $this->lines[] = $price;

        return $this;
    }

    public function total(): Money
    {
        $sum = Money::fromCents(0);
        foreach ($this->lines as $line) {
            $sum = $sum->add($line);
        }

        return $this->discount->apply($sum);
    }
}
