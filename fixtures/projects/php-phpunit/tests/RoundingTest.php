<?php

declare(strict_types=1);

namespace Shop\Tests;

use PHPUnit\Framework\TestCase;
use Shop\Pricing\Rounding;

final class RoundingTest extends TestCase
{
    public function testDescribesTheRule(): void
    {
        $this->assertSame('half up', Rounding::describe());
    }
}
