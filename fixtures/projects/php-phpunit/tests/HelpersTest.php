<?php

declare(strict_types=1);

namespace Shop\Tests;

use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

final class HelpersTest extends TestCase
{
    /** @return iterable<string, array{int, string}> */
    public static function amounts(): iterable
    {
        yield 'whole' => [500, '5.00'];
        yield 'cents' => [1234, '12.34'];
    }

    #[DataProvider('amounts')]
    public function testFormats(int $cents, string $expected): void
    {
        $this->assertSame($expected, shop_format($cents));
    }

    public function testCurrency(): void
    {
        $this->assertSame('EUR', \SHOP_CURRENCY);
    }
}
