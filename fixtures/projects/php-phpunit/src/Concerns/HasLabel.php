<?php

declare(strict_types=1);

namespace Shop\Concerns;

trait HasLabel
{
    public function label(): string
    {
        return 'cart of ' . static::class;
    }
}
