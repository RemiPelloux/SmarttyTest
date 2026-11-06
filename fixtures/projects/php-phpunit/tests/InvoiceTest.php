<?php

declare(strict_types=1);

namespace Shop\Tests;

use PHPUnit\Framework\TestCase;
use Shop\Pricing\FrenchVat;
use Shop\Pricing\Invoice;

final class InvoiceTest extends TestCase
{
    public function testTaxesThroughTheRule(): void
    {
        $this->assertSame(200, Invoice::tax(1000, new FrenchVat()));
    }
}
