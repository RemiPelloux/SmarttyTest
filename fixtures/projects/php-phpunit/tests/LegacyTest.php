<?php

declare(strict_types=1);

namespace Shop\Tests;

use PHPUnit\Framework\TestCase;

final class LegacyTest extends TestCase
{
    public function testPsr0AndClassmap(): void
    {
        $this->assertSame('WELCOME', \Legacy_Formatter::upper(\Coupon::code()));
    }
}
