<?php

declare(strict_types=1);

namespace Shop\Tests;

use PHPUnit\Framework\TestCase;
use Shop\Cart;
use Shop\Money;
use Shop\Pricing\Discount;

final class CartTest extends TestCase
{
    public function testAppliesTheDiscount(): void
    {
        $cart = (new Cart(new Discount(10)))->add(Money::fromCents(1000));
        $this->assertSame(900, $cart->total()->cents);
    }

    public function testHasALabel(): void
    {
        $this->assertSame('cart of Shop\Cart', (new Cart(new Discount(0)))->label());
    }
}
