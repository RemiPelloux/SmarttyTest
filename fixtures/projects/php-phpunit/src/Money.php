<?php

declare(strict_types=1);

namespace Shop;

final class Money
{
    private function __construct(public readonly int $cents)
    {
    }

    public static function fromCents(int $cents): self
    {
        return new self($cents);
    }

    public function add(Money $other): self
    {
        return new self($this->cents + $other->cents);
    }

    public function format(): string
    {
        return number_format($this->cents / 100, 2) . ' EUR';
    }
}
