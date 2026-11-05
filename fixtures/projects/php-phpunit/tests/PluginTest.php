<?php

declare(strict_types=1);

namespace Shop\Tests;

use PHPUnit\Framework\TestCase;
use Shop\PluginLoader;

final class PluginTest extends TestCase
{
    public function testLoadsAClassByName(): void
    {
        $this->assertInstanceOf(\ArrayObject::class, (new PluginLoader())->load(\ArrayObject::class));
    }
}
