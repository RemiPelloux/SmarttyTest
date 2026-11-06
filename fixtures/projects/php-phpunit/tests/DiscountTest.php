<?php

declare(strict_types=1);

namespace Shop\Tests;

use PHPUnit\Framework\TestCase;
use Shop\Pricing\Discount;

final class DiscountTest extends TestCase
{
    public function testShowsThePercentage(): void
    {
        $this->assertSame('15%', (new Discount(15))->percent());
    }
}
