<?php

declare(strict_types=1);

namespace Shop\Tests;

use PHPUnit\Framework\Attributes\Group;
use PHPUnit\Framework\TestCase;

/** In an excluded group: PHPUnit does not collect it, so SmartTest never runs it. */
#[Group('slow')]
final class SlowTest extends TestCase
{
    public function testSlow(): void
    {
        $this->assertTrue(true);
    }
}
