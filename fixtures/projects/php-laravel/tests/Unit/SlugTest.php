<?php

namespace Tests\Unit;

use App\Support\Slug;
use PHPUnit\Framework\TestCase;

class SlugTest extends TestCase
{
    public function test_it_makes_a_slug(): void
    {
        $this->assertSame('hello-world', Slug::make('Hello, World!'));
    }
}
