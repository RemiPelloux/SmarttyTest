<?php

namespace Tests\Unit;

use App\Services\Greeter;
use PHPUnit\Framework\TestCase;

class GreeterTest extends TestCase
{
    public function test_it_greets(): void
    {
        $this->assertSame('Hi, Bob!', (new Greeter('Hi'))->greet('Bob'));
    }
}
