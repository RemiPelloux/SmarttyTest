<?php

declare(strict_types=1);

namespace Shop\Tests;

use PHPUnit\Framework\TestCase;
use Shop\Money;

final class MoneyTest extends TestCase
{
    public function testAdds(): void
    {
        $this->assertSame(350, Money::fromCents(100)->add(Money::fromCents(250))->cents);
    }

    public function testFormats(): void
    {
        $this->assertSame('1.50 EUR', Money::fromCents(150)->format());
    }
}
